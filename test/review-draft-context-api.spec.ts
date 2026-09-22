import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const OWNER = {
  "x-shiplet-user-id": "user_draft_context_owner",
  "x-shiplet-user-email": "draft-context-owner@example.com",
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

async function fixture() {
  const org = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Draft context ${crypto.randomUUID()}` }),
  });
  expect(org.status).toBe(201);
  const { organization } = (await org.json()) as { organization: { id: string } };
  const published = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Draft context",
      organization_id: organization.id,
      subdomain: `draft-context-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [{ path: "index.html", content: btoa("<!doctype html><h1>Context</h1>") }],
    }),
  });
  expect(published.status).toBe(201);
  const { project } = (await published.json()) as { project: { id: string; subdomain: string } };
  await request(`/api/shiplets/${project.id}/package`, { headers: OWNER });
  const row = await (env as Env).DB
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(project.id)
    .first<{ active_revision_id: string }>();
  return { project, revisionId: row!.active_revision_id, pageUrl: `http://localhost/${project.subdomain}/page` };
}

describe("review draft context API", () => {
  it("returns the exact private managed context from tenant and general routes", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const query = new URLSearchParams({ revision_id: revisionId, page_url: pageUrl });
    const tenant = await request(`/${project.subdomain}/__shiplet/review/draft-context?${query}`, { headers: OWNER });
    expect(tenant.status).toBe(200);
    expect(tenant.headers.get("cache-control")).toBe("private, no-store");
    const expected = {
      context: {
        actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
        projectId: project.id,
        revisionId,
        pageUrl,
        installationId: null,
        expiresOn: null,
        durableOperations: true,
      },
    };
    expect(await tenant.json()).toEqual(expected);

    const general = await request(`/api/projects/${project.id}/review-draft-context?${query}`, { headers: OWNER });
    expect(general.status).toBe(200);
    expect(general.headers.get("cache-control")).toBe("private, no-store");
    expect(await general.json()).toEqual(expected);
  });

  it("binds the embed context to the authenticated installation session and fails closed", async () => {
    const { project, revisionId } = await fixture();
    const installationId = `installation_${crypto.randomUUID()}`;
    const pageUrl = "https://site.example/review/page";
    const now = new Date().toISOString();
    await (env as Env).DB.prepare(
      `INSERT INTO embed_installations
       (id, project_id, organization_id, site_origin, site_url, site_name, secret_hash, created_by_user_id, created_on)
       SELECT ?, id, organization_id, ?, ?, 'Draft context site', ?, ?, ? FROM projects WHERE id = ?`,
    ).bind(installationId, "https://site.example", pageUrl, "browser-only:test", OWNER["x-shiplet-user-id"], now, project.id).run();
    const started = await request(`/embed/review/start?installation_id=${installationId}&return_url=${encodeURIComponent(pageUrl)}`, { headers: OWNER });
    expect(started.status).toBe(302);
    const cookie = started.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();
    const query = new URLSearchParams({ installation_id: installationId, page_url: pageUrl });
    const embedded = await request(`/embed/review/draft-context?${query}`, { headers: { Cookie: cookie! } });
    expect(embedded.status).toBe(200);
    expect(await embedded.json()).toMatchObject({
      context: {
        actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
        projectId: project.id,
        revisionId,
        pageUrl,
        installationId,
        durableOperations: true,
      },
    });

    const foreign = await request(`/embed/review/draft-context?${new URLSearchParams({ installation_id: installationId, revision_id: revisionId, page_url: "https://attacker.example/" })}`, { headers: { Cookie: cookie! } });
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("cache-control")).toBe("private, no-store");
    expect(foreign.headers.get("content-type")).toContain("application/json");
    expect(await foreign.json()).toEqual({ error: "review_context_unavailable" });
  });

  it("reports sandbox context without exposing durable operation authority", async () => {
    const projectId = "sandbox-sbx_sharedsandboxdemo0000000-context";
    const response = await request(`/api/projects/${projectId}/review-draft-context?${new URLSearchParams({ revision_id: `sandbox_${projectId}`, page_url: "http://localhost/play" })}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      context: {
        actor: { kind: "sandbox", id: expect.stringMatching(/^sba_/) },
        projectId,
        revisionId: `sandbox_${projectId}`,
        pageUrl: expect.any(String),
        installationId: null,
        expiresOn: null,
        durableOperations: false,
      },
    });
  });
});
