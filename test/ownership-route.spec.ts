import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const OWNER = {
  "x-shiplet-user-id": "user_ownership_route_owner",
  "x-shiplet-user-email": "ownership-route-owner@example.com",
};

const STRANGER = {
  "x-shiplet-user-id": "user_ownership_route_stranger",
  "x-shiplet-user-email": "ownership-route-stranger@example.com",
};

function browserSessionHeaders(
  headers: Record<string, string>,
  sessionId: string,
) {
  return {
    ...headers,
    cookie: `__Host-shiplet_session=${encodeURIComponent(sessionId)}`,
  };
}

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

async function seedShiplet() {
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Ownership ${crypto.randomUUID()}` }),
  });
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Ownership route acceptance",
      organization_id: organization.id,
      subdomain: `ownership-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Ownership acceptance</h1>"),
        },
      ],
    }),
  });
  expect(publishResponse.status, await publishResponse.clone().text()).toBe(
    201,
  );
  const { project } = (await publishResponse.json()) as {
    project: { id: string };
  };
  return project;
}

describe("Shiplet ownership route", () => {
  it("Given an authenticated actor without Shiplet access, when ownership opens, then the kernel renders generic recovery without private deployment state", async () => {
    const project = await seedShiplet();
    const response = await request(`/shiplets/${project.id}/ownership`, {
      headers: STRANGER,
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Ownership access is required");
    expect(html).toContain(`href="/shiplets/${project.id}"`);
    expect(html).not.toContain("Ownership route acceptance");
    expect(html).not.toContain("Runs in your Cloudflare account");
    expect(html).not.toContain("Granted scope details");
    expect(html).not.toContain("Customer-owned destination");
    expect(html).not.toContain("data-target-id=");
    expect(html).not.toContain('data-action-endpoint="/api/cloudflare');
  });

  it("Given an authenticated owner, when ownership opens, then managed hosting, active revision, portability, and honest Cloudflare prerequisites are assembled from kernel state", async () => {
    const project = await seedShiplet();
    const response = await request(`/shiplets/${project.id}/ownership`, {
      headers: OWNER,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Where this Shiplet runs");
    expect(html).toContain("Shiplet-managed");
    expect(html).toContain("Ownership route acceptance");
    expect(html).toContain("Active revision");
    expect(html).toContain("Export package");
    expect(html).toContain("Cloudflare connection is not configured");
    expect(html).toContain("Temporary preview and claim");
    expect(html).toContain('data-ownership-controller="trusted-kernel"');
    expect(html).not.toMatch(/credential_ref|vault_ref|bearer|claimUrl/i);

    const active = await (env as Env).DB.prepare(
      `SELECT active_revision_id FROM projects WHERE id = ?`,
    )
      .bind(project.id)
      .first<{ active_revision_id: string | null }>();
    expect(active?.active_revision_id).toMatch(/^revision_/);
  });

  it("Given an isolated draft, when ownership refreshes, then it exposes the exact draft version and preserves the active revision before promotion", async () => {
    const project = await seedShiplet();
    await request(`/shiplets/${project.id}/ownership`, { headers: OWNER });
    const active = await (env as Env).DB.prepare(
      `SELECT active_revision_id FROM projects WHERE id = ?`,
    )
      .bind(project.id)
      .first<{ active_revision_id: string }>();
    const fork = await request(`/api/shiplets/${project.id}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ fromRevisionId: active?.active_revision_id }),
    });
    expect(fork.status, await fork.clone().text()).toBe(201);
    const { draft } = (await fork.json()) as {
      draft: { id: string; version: number };
    };

    const response = await request(`/shiplets/${project.id}/ownership`, {
      headers: OWNER,
    });
    const html = await response.text();
    expect(html).toContain(
      `data-action-endpoint="/api/drafts/${draft.id}/validate"`,
    );
    expect(html).toContain(`data-expected-version="${draft.version}"`);
    expect(html).toContain("data-ownership-package-editor");
    expect(html).toContain('aria-label="Draft package JSON"');
    expect(html).toContain("data-ownership-package-save");
    expect(html).toContain('method: "PUT"');
    expect(html).toContain("Changes are isolated from the active revision");
    const after = await (env as Env).DB.prepare(
      `SELECT active_revision_id FROM projects WHERE id = ?`,
    )
      .bind(project.id)
      .first<{ active_revision_id: string }>();
    expect(after?.active_revision_id).toBe(active?.active_revision_id);
  });

  it("Given a sealed revision that was never activated, when ownership opens, then it is separated from known-good rollback history and has no rollback control", async () => {
    const project = await seedShiplet();
    await request(`/shiplets/${project.id}/ownership`, { headers: OWNER });
    const active = await (env as Env).DB.prepare(
      `SELECT active_revision_id FROM projects WHERE id = ?`,
    )
      .bind(project.id)
      .first<{ active_revision_id: string }>();
    const fork = await request(`/api/shiplets/${project.id}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ fromRevisionId: active?.active_revision_id }),
    });
    const { draft } = (await fork.json()) as {
      draft: { id: string; version: number };
    };
    const validationResponse = await request(
      `/api/drafts/${draft.id}/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ expectedVersion: draft.version }),
      },
    );
    expect(
      validationResponse.status,
      await validationResponse.clone().text(),
    ).toBe(200);
    const { validation } = (await validationResponse.json()) as {
      validation: { revisionId: string };
    };

    const response = await request(`/shiplets/${project.id}/ownership`, {
      headers: OWNER,
    });
    const html = await response.text();
    expect(html).toContain("Validated revisions not yet activated");
    expect(html).toContain(
      `data-sealed-revision-id="${validation.revisionId}"`,
    );
    expect(html).toContain("Validated, never activated");
    expect(html).not.toContain(`data-revision-id="${validation.revisionId}"`);
  });

  it("Given an exact sealed preview, when the same actor returns to ownership, then the kernel exposes only that actor-bound preview receipt", async () => {
    const project = await seedShiplet();
    await request(`/shiplets/${project.id}/ownership`, { headers: OWNER });
    const active = await (env as Env).DB.prepare(
      `SELECT active_revision_id FROM projects WHERE id = ?`,
    )
      .bind(project.id)
      .first<{ active_revision_id: string }>();
    const fork = await request(`/api/shiplets/${project.id}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ fromRevisionId: active?.active_revision_id }),
    });
    const { draft } = (await fork.json()) as {
      draft: { id: string; version: number };
    };
    const validated = await request(`/api/drafts/${draft.id}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ expectedVersion: draft.version }),
    });
    const { validation } = (await validated.json()) as {
      validation: { revisionId: string; previewUrl: string };
    };
    const receiptPath = `/api/shiplets/${project.id}/drafts/${draft.id}/revisions/${validation.revisionId}/versions/${draft.version}/preview-receipt`;

    const beforePreview = await request(receiptPath, {
      headers: browserSessionHeaders(OWNER, "ownership-session-a"),
    });
    expect(beforePreview.status).toBe(404);
    const previewUrl = new URL(validation.previewUrl);
    const preview = await request(
      `${previewUrl.pathname}${previewUrl.search}`,
      {
        headers: browserSessionHeaders(OWNER, "ownership-session-a"),
      },
    );
    expect(preview.status, await preview.clone().text()).toBe(200);
    const otherSessionReceipt = await request(receiptPath, {
      headers: browserSessionHeaders(OWNER, "ownership-session-b"),
    });
    expect(otherSessionReceipt.status).toBe(404);
    const receipt = await request(receiptPath, {
      headers: browserSessionHeaders(OWNER, "ownership-session-a"),
    });
    expect(receipt.status, await receipt.clone().text()).toBe(200);
    expect(await receipt.json()).toEqual({
      previewed: true,
      shipletId: project.id,
      draftId: draft.id,
      revisionId: validation.revisionId,
      draftVersion: draft.version,
    });
    const siblingActor = await request(receiptPath, {
      headers: {
        "x-shiplet-user-id": "user_ownership_receipt_sibling",
        "x-shiplet-user-email": "ownership-receipt-sibling@example.com",
      },
    });
    expect(siblingActor.status).toBe(404);
  });

  it("Given no authenticated user, when ownership opens, then the exact route is preserved through login", async () => {
    const project = await seedShiplet();
    const response = await request(`/shiplets/${project.id}/ownership`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `/auth/login?return_to=${encodeURIComponent(`/shiplets/${project.id}/ownership`)}`,
    );
  });

  it("Given a trusted ownership action, when the controller prepares it, then the kernel binds the current Shiplet and rejects missing destructive approval", async () => {
    const project = await seedShiplet();
    const fork = await request(
      `/api/shiplets/${project.id}/ownership/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          action: "fork",
          shipletId: "project_guessed_sibling",
        }),
      },
    );
    expect(await fork.json()).toEqual({
      method: "POST",
      path: `/api/shiplets/${project.id}/drafts`,
      body: {},
      requiresApproval: false,
    });
    const denied = await request(
      `/api/shiplets/${project.id}/ownership/actions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          action: "rollback",
          revisionId: "revision_previous",
          expectedActiveRevisionId: "revision_active",
          idempotencyKey: "ownership_rollback_without_approval",
        }),
      },
    );
    expect(denied.status).toBe(428);
    expect(await denied.json()).toEqual({
      ok: false,
      code: "trusted_approval_required",
    });
  });
});
