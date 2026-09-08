import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

const owner = { "x-shiplet-user-id": "user_browser_capture", "x-shiplet-user-email": "browser-capture@example.com" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function request(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function organization() {
  const response = await request("/api/organizations", { method: "POST", headers: { ...owner, "Content-Type": "application/json" }, body: JSON.stringify({ name: `Capture ${crypto.randomUUID()}` }) });
  return ((await response.json()) as any).organization.id;
}
function publish(organizationId: string, extra = {}, headers = {}) {
  return request("/capture", { method: "POST", headers: { ...owner, Origin: "http://localhost", "Content-Type": "application/json", ...headers }, body: JSON.stringify({ organizationId, name: "Browser <capture>", sourceUrl: "https://example.com/work?token=fixture#private", image: `data:image/png;base64,${png}`, confirmed: true, ...extra }) });
}
describe("browser capture", () => {
  it("offers public capture and companion setup with a private publish preview", async () => {
    const page = await request("/capture");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Capture browser work");
    expect(html).toContain("Upload an image");
    expect(html).toContain("Sign in");
    const guide = await request("/docs/browser-capture");
    expect(guide.status).toBe(200);
    expect(await guide.text()).toContain("Load unpacked");
    const archive = await request("/downloads/shiplet-browser-companion.zip");
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(Array.from(new Uint8Array(await archive.arrayBuffer()).slice(0, 4))).toEqual([80, 75, 3, 4]);
  });
  it("publishes private static pixels and sanitized provenance into the existing review room", async () => {
    const id = await organization();
    const response = await publish(id);
    expect(response.status).toBe(201);
    const result = (await response.json()) as any;
    expect(result.project.visibility).toBe("organization");
    expect(result.reviewUrl).toBeTruthy();
    const metadata = await request(`/${result.project.subdomain}/capture.json`, { headers: owner });
    expect(metadata.status).toBe(200);
    const text = await metadata.text();
    expect(text).toContain("https://example.com/work");
    expect(text).not.toContain("fixture");
    expect(text).not.toContain("#private");
    const image = await request(`/${result.project.subdomain}/capture.png`, { headers: owner });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toContain("image/png");
    expect(Array.from(new Uint8Array(await image.arrayBuffer()).slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const outsider = await request(`/${result.project.subdomain}/capture.png`);
    expect(outsider.status).not.toBe(200);
    const artifact = await (await request(`/${result.project.subdomain}/__shiplet/artifact-frame/`, { headers: owner })).text();
    expect(artifact).toContain("Browser &lt;capture&gt;");
    expect(artifact).toContain("capture.png");
  });
  it("rejects absent confirmation, forged origins, outsiders, oversized images and non-PNG content", async () => {
    const id = await organization();
    expect((await publish(id, { confirmed: false })).status).toBe(400);
    expect((await publish(id, {}, { Origin: "https://untrusted.example" })).status).toBe(403);
    expect((await publish(id, {}, { "x-shiplet-user-id": "user_capture_outsider", "x-shiplet-user-email": "capture-outsider@example.com" })).status).toBe(403);
    const oversizedDimensions = Uint8Array.from(atob(png), char => char.charCodeAt(0));
    new DataView(oversizedDimensions.buffer).setUint32(16, 20000);
    for (const image of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,PHNjcmlwdD4=", `data:image/png;base64,${btoa(String.fromCharCode(...oversizedDimensions))}`, `data:image/png;base64,${"A".repeat(12_000_000)}`]) {
      expect([400, 413]).toContain((await publish(id, { image })).status);
    }
    expect((await request("/capture", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
  });
  it("omits credentials and local paths from source metadata without fetching the original page", async () => {
    const id = await organization();
    for (const sourceUrl of ["file:///private/local-document.pdf", "chrome://settings", "https://fixture:fixture@example.com/work", "javascript:alert(1)"]) {
      const response = await publish(id, { sourceUrl });
      expect(response.status).toBe(201);
      const { project } = await response.json() as any;
      const metadata = await (await request(`/${project.subdomain}/capture.json`, { headers: owner })).json() as any;
      expect(metadata.sourceUrl).toBeNull();
    }
  });
  it("lets an authorized agent read captured feedback and its pixels, reply and act on status through the canonical API", async () => {
    const organizationId = await organization();
    const capture = await publish(organizationId);
    const { project } = await capture.json() as any;
    const created = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST", headers: { ...owner, "Content-Type": "application/json" },
      body: JSON.stringify({ comment: "Change the captured design", pageUrl: `http://localhost/${project.subdomain}`, clientFeedbackId: crypto.randomUUID(), screenshotDataUrl: `data:image/png;base64,${png}`, coordinates: { pageX: 100, pageY: 100 } }),
    });
    expect(created.status).toBe(201);
    const { feedback } = await created.json() as any;
    const key = await request(`/api/organizations/${organizationId}/api-tokens`, {
      method: "POST", headers: { ...owner, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Capture acceptance agent", scopes: ["feedback:read", "feedback:write"], projectAccessMode: "all", projectRules: [] }),
    });
    expect(key.status).toBe(201);
    const identity = await key.json() as any;
    const headers = { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" };
    const read = await request(`/api/projects/${project.id}/review-feedback`, { headers });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("Change the captured design");
    const pixels = await request(`/api/projects/${project.id}/review-feedback/${feedback.id}/screenshot`, { headers });
    expect(pixels.status).toBe(200);
    expect(pixels.headers.get("content-type")).toContain("image/png");
    expect((await request(`/api/projects/${project.id}/review-feedback/${feedback.id}/replies`, { method: "POST", headers, body: JSON.stringify({ comment: "I’m implementing this change." }) })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/review-feedback/${feedback.id}/status`, { method: "POST", headers, body: JSON.stringify({ status: "In Progress" }) })).status).toBe(200);
    const canonical = await (await request(`/api/projects/${project.id}/review-feedback`, { headers: owner })).text();
    expect(canonical).toContain("I’m implementing this change.");
    expect(canonical).toContain("In Progress");
  });
});
