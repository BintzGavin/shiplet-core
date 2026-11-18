import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";

type TestEnv = Omit<Env, "SHIPLET_ENABLED_FEATURE_FLAGS"> & { SHIPLET_ENABLED_FEATURE_FLAGS?: string };
const testEnv = env as unknown as TestEnv;
const runtimeEnv = env as unknown as Env;

const OWNER = { "x-shiplet-user-id": "user_pages_owner", "x-shiplet-user-email": "owner@pages.test" };

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  let response: Response;
  try {
    response = await app.fetch(new Request(`http://localhost${path}`, init), runtimeEnv, context);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  await waitOnExecutionContext(context);
  return response;
}

async function withFlags<T>(flags: string | undefined, callback: () => Promise<T>) {
  const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
  testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = flags;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
  }
}

async function createShiplet(visibility = "organization") {
  const org = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Pages ${crypto.randomUUID()}` }),
  });
  const organizationId = ((await org.json()) as { organization: { id: string } }).organization.id;
  const created = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Pages Shiplet",
      organization_id: organizationId,
      subdomain: `pages-${crypto.randomUUID().slice(0, 8)}`,
      visibility,
      assets: [{ path: "index.html", content: btoa("<h1>Review</h1>") }],
    }),
  });
  return ((await created.json()) as { project: { id: string } }).project.id;
}

describe("trace pages (slice 4)", () => {
  it("serves the viewer shell and mounts the traces panel when traces are on", async () => {
    await withFlags("traces", async () => {
      const projectId = await createShiplet();
      const viewer = await request(`/shiplets/${projectId}/traces/trc_0123456789abcdef0123456789abcdef`, { headers: OWNER });
      expect(viewer.status).toBe(200);
      const html = await viewer.text();
      expect(html).toContain('id="trace-viewer-root"');
      expect(html).toContain("/assets/platform/traces.js");
      expect(html).toContain("A trace is the full log of an agent session");

      const detail = await request(`/shiplets/${projectId}`, { headers: OWNER });
      expect(detail.status).toBe(200);
      const page = await detail.text();
      expect(page).toContain('id="traces-panel-root"');
      expect(page).toContain(projectId);

      const script = await request("/assets/platform/traces.js");
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type") || "").toContain("javascript");
    });
  });

  it("sends signed-out visitors of a private Shiplet to sign in", async () => {
    await withFlags("traces", async () => {
      const projectId = await createShiplet();
      const viewer = await request(`/shiplets/${projectId}/traces/trc_0123456789abcdef0123456789abcdef`, { redirect: "manual" });
      expect(viewer.status).toBe(302);
      expect(viewer.headers.get("location") || "").toContain("/auth/login");
    });
  });

  it("hides the viewer and the panel when traces are off", async () => {
    await withFlags(undefined, async () => {
      const projectId = await createShiplet();
      const viewer = await request(`/shiplets/${projectId}/traces/trc_0123456789abcdef0123456789abcdef`, { headers: OWNER });
      expect(viewer.status).toBe(404);
      const page = await (await request(`/shiplets/${projectId}`, { headers: OWNER })).text();
      expect(page).not.toContain('id="traces-panel-root"');
    });
  });
});

describe("traces docs", () => {
  it("defines a trace and pins the docs digest", async () => {
    const response = await request("/docs/traces");
    expect(response.status).toBe(200);
    const html = await response.text();
    const article = html.match(/<div class="docs-content">([\s\S]*?)<\/div>\s*<\/article>/)?.[1] || "";
    expect(article).toContain("full chat log of an agent session");
    expect(article).toContain("trace share --current");
    const declared = html.match(/data-shiplet-docs-content-sha256="([a-f0-9]{64})"/)?.[1];
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(article.replace(/\r\n?/g, "\n").trim()));
    expect(declared).toBe([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  });
});

describe("trace-only Shiplets (D19)", () => {
  it("creates a Shiplet whose page is the trace viewer", async () => {
    await withFlags("traces", async () => {
      const org = await request("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ name: `Trace only ${crypto.randomUUID()}` }),
      });
      const organizationId = ((await org.json()) as { organization: { id: string } }).organization.id;
      const missing = await request("/api/trace-shiplets", { method: "POST", headers: { "Content-Type": "application/json", ...OWNER }, body: JSON.stringify({ organizationId }) });
      expect(missing.status).toBe(400);
      const crossSite = await request("/api/trace-shiplets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "sec-fetch-site": "cross-site", ...OWNER },
        body: JSON.stringify({ name: "Nope", organizationId }),
      });
      expect(crossSite.status).toBe(403);
      const created = await request("/api/trace-shiplets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ name: "Fix the <flaky> checkout test", organizationId }),
      });
      expect(created.status).toBe(201);
      const { shiplet } = (await created.json()) as { shiplet: { id: string; traceOnly: boolean; visibility: string; organizationId: string; url: string } };
      expect(shiplet).toMatchObject({ traceOnly: true, visibility: "organization", organizationId });
      expect(shiplet.url).toMatch(new RegExp(`/shiplets/${shiplet.id}$`));

      const page = await (await request(`/shiplets/${shiplet.id}`, { headers: OWNER })).text();
      expect(page).toContain('id="trace-viewer-root"');
      expect(page).toContain('data-embedded="true"');
      expect(page).not.toContain('id="artifactPreviewFrame"');
      expect(page).toContain('id="traces-panel-root"');
      expect(page).toContain("shares an agent session");

      // an ordinary Shiplet still shows its artifact
      const ordinary = await createShiplet();
      const ordinaryPage = await (await request(`/shiplets/${ordinary}`, { headers: OWNER })).text();
      expect(ordinaryPage).toContain('id="artifactPreviewFrame"');
      expect(ordinaryPage).not.toContain('data-embedded="true"');

      // signed out, or with traces off, nobody can create one
      expect((await request("/api/trace-shiplets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status).toBe(401);
    });
    await withFlags(undefined, async () => {
      const off = await request("/api/trace-shiplets", { method: "POST", headers: { "Content-Type": "application/json", ...OWNER }, body: JSON.stringify({ name: "x" }) });
      expect(off.status).toBe(404);
    });
  });
});
