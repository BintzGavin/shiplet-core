import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const OWNER = {
  "x-shiplet-user-id": "user_artifact_bridge_owner",
  "x-shiplet-user-email": "artifact-bridge@example.com",
};

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    env as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("trusted artifact bridge delivery", () => {
  it("Given a managed static Shiplet, When its opaque artifact frame loads, Then a credentialless kernel capture bridge is injected and served", async () => {
    const organizationResponse = await request("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ name: `Bridge ${crypto.randomUUID()}` }),
    });
    const { organization } = (await organizationResponse.json()) as {
      organization: { id: string };
    };
    const publishResponse = await request("/api/shiplets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({
        name: "Capture bridge",
        organization_id: organization.id,
        subdomain: `capture-bridge-${crypto.randomUUID().slice(0, 8)}`,
        visibility: "private",
        assets: [
          {
            path: "index.html",
            content: btoa(
              '<!doctype html><html><head><script data-shiplet-artifact-bridge src="https://attacker.example/stale.js"></script></head><body><h1 id="hero">Capture me</h1></body></html>',
            ),
          },
        ],
      }),
    });
    const { project } = (await publishResponse.json()) as {
      project: { id: string };
    };
    const frame = await request(
      `/shiplets/${encodeURIComponent(project.id)}/artifact-frame/`,
      { headers: OWNER },
    );
    expect(frame.status, await frame.clone().text()).toBe(200);
    const html = await frame.text();
    expect(html).toContain('data-shiplet-kernel-artifact-bridge="v1"');
    expect(html).toContain('src="/api/review/artifact-bridge.js"');
    expect(html).toContain("https://attacker.example/stale.js");
    const csp = frame.headers.get("content-security-policy") || "";
    expect(csp).toContain("sandbox allow-scripts allow-forms");
    expect(csp).not.toContain("allow-same-origin");
    expect(frame.headers.get("set-cookie")).toBeNull();

    const bridge = await request("/api/review/artifact-bridge.js");
    expect(bridge.status).toBe(200);
    expect(bridge.headers.get("content-type")).toContain(
      "application/javascript",
    );
    const script = await bridge.text();
    expect(script).toContain("shiplet.artifact.capture.result.v1");
    expect(script).not.toContain("document.cookie");
    expect(script).not.toContain("fetch(");
  });
});
