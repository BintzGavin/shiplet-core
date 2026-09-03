import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { appendKernelAdminAuditEvent } from "../src/kernel-admin-audit";

const OWNER = {
  "x-shiplet-user-id": "user_kernel_admin_audit_owner",
  "x-shiplet-user-email": "kernel-admin-audit-owner@example.com",
};
const OUTSIDER = {
  "x-shiplet-user-id": "user_kernel_admin_audit_outsider",
  "x-shiplet-user-email": "kernel-admin-audit-outsider@example.com",
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

async function organization() {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Kernel audit ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { organization: { id: string } }).organization;
}

function expectCredentialFreeInvitationPayload(value: unknown) {
  const visit = (current: unknown) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, item] of Object.entries(current)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      expect(normalized).not.toMatch(
        /(?:accesstoken|refreshtoken|invitationtoken|oauthtoken|authorizationcode|authorizationheader|credential|password|secret|claimurl)/,
      );
      expect(normalized).not.toBe("token");
      visit(item);
    }
  };
  visit(value);
}

describe("immutable privileged kernel administration audit", () => {
  it("wires team, organization/team invitation, and Shiplet-share outcomes to the immutable ledger", async () => {
    const org = await organization();
    const teamResponse = await request(`/api/organizations/${org.id}/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ name: `Audit team ${crypto.randomUUID()}` }),
    });
    expect(teamResponse.status).toBe(201);
    const team = ((await teamResponse.json()) as { team: { id: string } }).team;
    const orgInvite = await request(`/api/organizations/${org.id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ email: "audit-org-invite@example.com", role: "member" }),
    });
    expect(orgInvite.status).toBe(201);
    expectCredentialFreeInvitationPayload(await orgInvite.clone().json());
    const teamInvite = await request(`/api/organizations/${org.id}/teams/${team.id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ email: "audit-team-invite@example.com", role: "member" }),
    });
    expect(teamInvite.status).toBe(201);
    expectCredentialFreeInvitationPayload(await teamInvite.clone().json());
    const published = await request("/api/shiplets", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({
        name: "Kernel audit share",
        organization_id: org.id,
        subdomain: `kernel-audit-${crypto.randomUUID().slice(0, 8)}`,
        visibility: "private",
        assets: [{ path: "index.html", content: btoa("<h1>Audit</h1>") }],
      }),
    });
    expect(published.status).toBe(201);
    const project = ((await published.json()) as { project: { id: string } }).project;
    const shared = await request(`/api/projects/${project.id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ targetType: "team", teamId: team.id, role: "reviewer" }),
    });
    expect(shared.status).toBe(201);
    const userShared = await request(`/api/projects/${project.id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({
        targetType: "user",
        email: "kernel-audit-share@example.com",
        role: "viewer",
      }),
    });
    expect(userShared.status).toBe(201);
    expectCredentialFreeInvitationPayload(await userShared.json());
    const denied = await request(`/api/projects/${project.id}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OUTSIDER },
      body: JSON.stringify({ targetType: "organization", role: "editor" }),
    });
    expect(denied.status).toBe(403);

    const audit = await (env as Env).DB.prepare(
      `SELECT actor_id, action, outcome FROM kernel_admin_audit_events
       WHERE organization_id = ? AND action IN (
        'team.create', 'organization_invitation.create',
        'team_invitation.create', 'shiplet_share.create'
       ) ORDER BY rowid ASC`,
    )
      .bind(org.id)
      .all<{ actor_id: string; action: string; outcome: string }>();
    const outcomes = audit.results || [];
    for (const action of [
      "team.create",
      "organization_invitation.create",
      "team_invitation.create",
      "shiplet_share.create",
    ]) {
      expect(outcomes.filter((row) => row.action === action && row.actor_id === OWNER["x-shiplet-user-id"]).map((row) => row.outcome)).toEqual(
        expect.arrayContaining(["intent", "succeeded"]),
      );
    }
    expect(outcomes).toContainEqual({
      actor_id: OUTSIDER["x-shiplet-user-id"],
      action: "shiplet_share.create",
      outcome: "denied",
    });
  });

  it("records successful and denied organization-token administration without credential content", async () => {
    const org = await organization();
    const denied = await request(`/api/organizations/${org.id}/api-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OUTSIDER },
      body: JSON.stringify({ name: "Denied key", scopes: ["shiplets:read"] }),
    });
    expect(denied.status).toBe(403);
    const created = await request(`/api/organizations/${org.id}/api-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({
        name: "Automation key",
        scopes: ["shiplets:read"],
        projectAccessMode: "all",
      }),
    });
    expect(created.status).toBe(201);

    const rows = await (env as Env).DB.prepare(
      `SELECT actor_id, action, outcome, metadata_json
       FROM kernel_admin_audit_events
       WHERE organization_id = ? AND action = 'organization_token.create'
       ORDER BY occurred_on ASC`,
    )
      .bind(org.id)
      .all<{ actor_id: string; action: string; outcome: string; metadata_json: string }>();
    expect(rows.results?.some((row) => row.actor_id === OUTSIDER["x-shiplet-user-id"] && row.outcome === "denied")).toBe(true);
    expect(rows.results?.some((row) => row.actor_id === OWNER["x-shiplet-user-id"] && row.outcome === "succeeded")).toBe(true);
    const serialized = JSON.stringify(rows.results);
    expect(serialized).not.toMatch(/bearer|credential|password|secret|token_hash|authorization/i);
  });

  it("rejects credential-shaped metadata and makes accepted audit rows immutable", async () => {
    const org = await organization();
    await expect(
      appendKernelAdminAuditEvent((env as Env).DB, {
        organizationId: org.id,
        actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
        action: "organization.test",
        outcome: "succeeded",
        metadata: { accessToken: "must-never-be-stored" },
      }),
    ).rejects.toThrow("credential-shaped");
    const event = await appendKernelAdminAuditEvent((env as Env).DB, {
      organizationId: org.id,
      actor: { kind: "human", id: OWNER["x-shiplet-user-id"] },
      action: "organization.test",
      outcome: "succeeded",
      metadata: { targetKind: "organization" },
    });
    await expect(
      (env as Env).DB.prepare("UPDATE kernel_admin_audit_events SET outcome = 'failed' WHERE id = ?")
        .bind(event.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      (env as Env).DB.prepare("DELETE FROM kernel_admin_audit_events WHERE id = ?")
        .bind(event.id)
        .run(),
    ).rejects.toThrow();
  });
});
