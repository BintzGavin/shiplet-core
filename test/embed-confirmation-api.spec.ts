import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createEmbedReviewSession,
  createEmbedReviewSessionCookieHeader,
} from "../src/embed";
import app from "../src/index";
import { getProjectById, getUser } from "../src/store";

const OWNER = {
  "x-shiplet-user-id": "user_embed_confirmation_owner",
  "x-shiplet-user-email": "embed-confirmation-owner@example.com",
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
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Embed confirmation ${crypto.randomUUID()}` }),
  });
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Embed confirmation Shiplet",
      organization_id: organization.id,
      subdomain: `embed-confirm-${crypto.randomUUID().slice(0, 8)}`,
      external_url: "https://reviewer-site.example.com/",
      visibility: "private",
    }),
  });
  const { project: publicProject } = (await publishResponse.json()) as {
    project: { id: string };
  };
  await request(`/api/shiplets/${publicProject.id}/package`, {
    headers: OWNER,
  });
  const project = await getProjectById((env as Env).DB, publicProject.id);
  const user = await getUser((env as Env).DB, OWNER["x-shiplet-user-id"]);
  const activeRevision = await (env as Env).DB.prepare(
    "SELECT active_revision_id FROM projects WHERE id = ?",
  )
    .bind(publicProject.id)
    .first<{ active_revision_id: string | null }>();
  if (!project || !user || !activeRevision?.active_revision_id) {
    throw new Error("confirmation fixture unavailable");
  }
  const installationId = `embed_installation_${crypto.randomUUID()}`;
  const siteOrigin = `https://reviewer-${crypto.randomUUID().slice(0, 8)}.example`;
  await (env as Env).DB.prepare(
    `INSERT INTO embed_installations (
		 id, project_id, organization_id, site_origin, site_url, site_name,
		 secret_hash, created_by_user_id, created_on, last_used_on, revoked_on
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      installationId,
      project.id,
      organization.id,
      siteOrigin,
      `${siteOrigin}/`,
      "Reviewer site",
      crypto.randomUUID(),
      user.id,
      new Date().toISOString(),
    )
    .run();
  const installation = await (env as Env).DB.prepare(
    "SELECT * FROM embed_installations WHERE id = ?",
  )
    .bind(installationId)
    .first<any>();
  const pageUrl = `${siteOrigin}/pricing/`;
  const session = await createEmbedReviewSession((env as Env).DB, {
    installation,
    project,
    revisionId: activeRevision.active_revision_id,
    user,
    pageUrl,
  });
  const cookie = createEmbedReviewSessionCookieHeader({
    installationId,
    sessionHandle: session.sessionHandle,
    now: new Date(),
    expiresOn: session.expiresOn,
  }).split(";", 1)[0];
  return { project, user, installationId, pageUrl, cookie };
}

describe("trusted embedded review confirmation", () => {
  it("binds a top-level intent to the exact human and completes it once without exposing a receipt", async () => {
    const { project, user, installationId, pageUrl, cookie } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const clientFeedbackId = `client-${crypto.randomUUID()}`;
    const intentResponse = await request(
      `/embed/review/confirm?${new URLSearchParams({ installation_id: installationId, page_url: pageUrl })}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "http://localhost",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          request_id: requestId,
          operation: "feedback.create",
          comment: "Confirm this bounded review event",
          page_url: pageUrl,
          client_feedback_id: clientFeedbackId,
        }),
      },
    );
    expect(intentResponse.status).toBe(200);
    expect(intentResponse.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const intentHtml = await intentResponse.text();
    expect(intentHtml).toContain('data-shiplet-confirmation="v1"');
    expect(intentHtml).toContain("Confirm this bounded review event");
    expect(intentHtml).not.toContain("operation-receipt");
    const intentId = intentHtml.match(/name="intent_id" value="([^"]+)"/)?.[1];
    expect(intentId).toMatch(/^embed_intent_/);

    const outsider = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        "x-shiplet-user-id": "user_embed_confirmation_outsider",
        "x-shiplet-user-email": "embed-confirmation-outsider@example.com",
      },
      body: new URLSearchParams({
        intent_id: intentId || "",
        approval: "confirm",
      }),
    });
    expect(outsider.status).toBe(403);

    const completed = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({
        intent_id: intentId || "",
        approval: "confirm",
      }),
    });
    expect(completed.status).toBe(200);
    const completedHtml = await completed.text();
    expect(completedHtml).toContain('data-shiplet-confirmation="complete"');
    expect(completedHtml).not.toContain("operation-receipt");

    const feedback = await (env as Env).DB.prepare(
      `SELECT submitted_by_user_id, comment FROM review_feedback
			 WHERE project_id = ? AND client_feedback_id = ?`,
    )
      .bind(project.id, clientFeedbackId)
      .first<{ submitted_by_user_id: string; comment: string }>();
    expect(feedback).toEqual({
      submitted_by_user_id: user.id,
      comment: "Confirm this bounded review event",
    });
    const receipt = await (env as Env).DB.prepare(
      `SELECT claimed_on FROM embed_review_operation_receipts
			 WHERE request_id = ? AND project_id = ?`,
    )
      .bind(requestId, project.id)
      .first<{ claimed_on: string | null }>();
    expect(receipt).toBeNull();
    const audit = await (env as Env).DB.prepare(
      `SELECT actor_kind, actor_id, event_kind FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'review.feedback_created'
			 ORDER BY recorded_on DESC LIMIT 1`,
    )
      .bind(project.id)
      .first();
    expect(audit).toMatchObject({
      actor_kind: "human",
      actor_id: user.id,
      event_kind: "review.feedback_created",
    });

    const replay = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({
        intent_id: intentId || "",
        approval: "confirm",
      }),
    });
    expect(replay.status).toBe(409);
  });

  it("rejects a cross-origin intent before storing any human-attributed action", async () => {
    const { installationId, pageUrl, cookie } = await fixture();
    const response = await request(
      `/embed/review/confirm?${new URLSearchParams({ installation_id: installationId, page_url: pageUrl })}`,
      {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://attacker.example",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          request_id: `request_${crypto.randomUUID()}`,
          operation: "feedback.create",
          comment: "Forged intent",
          page_url: pageUrl,
          client_feedback_id: `client-${crypto.randomUUID()}`,
        }),
      },
    );
    expect(response.status).toBe(403);
  });
});
