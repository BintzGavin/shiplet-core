import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app, { reviewCapabilitySecret } from "../src/index";
import type { Env } from "../src/env";
import { createReviewCapabilityToken } from "../src/review";
import { createOrganizationMembershipRecord, upsertUser } from "../src/store";
import type { Project } from "../src/types";

const bindings = env as Env;
const owner = {
  "x-shiplet-user-id": "user_inline_review_owner",
  "x-shiplet-user-email": "inline-review-owner@example.invalid",
};

async function request(url: string, init: RequestInit = {}, runtime = bindings) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(new URL(url, "http://localhost"), init), runtime, context);
  await waitOnExecutionContext(context);
  return response;
}

async function fixture() {
  const organizationResponse = await request("/api/organizations", {
    method: "POST", headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ name: `Inline review ${crypto.randomUUID()}` }),
  });
  expect(organizationResponse.status).toBe(201);
  const { organization } = await organizationResponse.json() as { organization: { id: string } };
  const published = await request("/api/shiplets", {
    method: "POST", headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Inline review", organization_id: organization.id,
      subdomain: `inline-${crypto.randomUUID().slice(0, 8)}`, visibility: "organization",
      assets: [{ path: "index.html", content: btoa("<!doctype html><h1>Review this</h1>") }],
    }),
  });
  expect(published.status).toBe(201);
  const { project } = await published.json() as { project: Project };
  expect((await request(`/api/shiplets/${project.id}/package`, { headers: owner })).status).toBe(200);
  const active = await bindings.DB.prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(project.id).first<{ active_revision_id: string }>();
  return {
    project, organizationId: organization.id,
    body: {
      reviewRevisionId: active!.active_revision_id,
      requestId: `request_${crypto.randomUUID().replace(/-/g, "")}`,
      clientFeedbackId: `client-${crypto.randomUUID().replace(/-/g, "")}`,
      comment: "Send directly from the built-in composer",
      pageUrl: `http://localhost/${project.subdomain}`,
    },
  };
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { ...owner, origin: "http://localhost", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function effects(projectId: string) {
  return bindings.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM review_feedback WHERE project_id = ?) AS feedback,
    (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ? AND event_kind = 'review.feedback-created') AS canonical,
    (SELECT COUNT(*) FROM shiplet_audit_events WHERE project_id = ? AND event_kind = 'review.feedback_created') AS audit`)
    .bind(projectId, projectId, projectId).first();
}

async function reviewer(organizationId: string) {
  const id = `user_inline_reviewer_${crypto.randomUUID()}`;
  const email = `${id}@example.invalid`;
  await upsertUser(bindings.DB, { id, email });
  await createOrganizationMembershipRecord(bindings.DB, {
    id: `membership_${crypto.randomUUID()}`, organization_id: organizationId,
    user_id: id, role: "member", created_on: new Date().toISOString(),
  });
  return { id, email };
}

async function expiredUncommittedIntent() {
  const value = await fixture();
  const trigger = `fail_inline_${crypto.randomUUID().replace(/-/g, "")}`;
  await bindings.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON review_feedback
    WHEN NEW.project_id = '${value.project.id}' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`).run();
  try {
    const response = await request(`/api/projects/${value.project.id}/review-feedback`, post(value.body));
    expect(response.status).toBe(500);
    expect(await effects(value.project.id)).toEqual({ feedback: 0, canonical: 0, audit: 0 });
  } finally {
    await bindings.DB.prepare(`DROP TRIGGER ${trigger}`).run();
  }
  const expiredOn = new Date(Date.now() - 60_000).toISOString();
  await bindings.DB.prepare("UPDATE embed_review_operation_intents SET expires_on = ? WHERE project_id = ? AND request_id = ?")
    .bind(expiredOn, value.project.id, value.body.requestId).run();
  return { ...value, expiredOn };
}

describe("managed inline review submission", () => {
  it("commits the human feedback, canonical event, and audit together without a confirmation document", async () => {
    const { project, body } = await fixture();
    const response = await request(`/api/projects/${project.id}/review-feedback`, post(body));
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    const result = await response.json() as { feedback: { id: string; submitted_by_user_id: string } };
    expect(result.feedback.submitted_by_user_id).toBe(owner["x-shiplet-user-id"]);
    expect(await effects(project.id)).toEqual({ feedback: 1, canonical: 1, audit: 1 });
    const intent = await bindings.DB.prepare("SELECT confirmed_on, completed_on FROM embed_review_operation_intents WHERE project_id = ? AND request_id = ?")
      .bind(project.id, body.requestId).first<{ confirmed_on: string; completed_on: string }>();
    expect(intent?.confirmed_on).toBeTruthy();
    expect(intent?.completed_on).toBeTruthy();
  });

  it("returns one committed ticket for simultaneous and later retries, but rejects changed payload or actor", async () => {
    const { project, organizationId, body } = await fixture();
    const url = `/api/projects/${project.id}/review-feedback`;
    const responses = await Promise.all([request(url, post(body)), request(url, post(body))]);
    responses.push(await request(url, post(body)));
    const ids: string[] = [];
    for (const response of responses) {
      expect(response.status, await response.clone().text()).toBe(201);
      ids.push((await response.json() as { feedback: { id: string } }).feedback.id);
    }
    expect(new Set(ids).size).toBe(1);
    expect((await request(url, post({ ...body, comment: "Changed after approval" }))).status).toBe(409);
    expect((await request(url, post({ ...body, reviewRevisionId: "revision_changed_after_commit" }))).status).toBe(409);
    const other = await reviewer(organizationId);
    expect((await request(url, post(body, {
      "x-shiplet-user-id": other.id, "x-shiplet-user-email": other.email,
    }))).status).toBe(409);
    expect(await effects(project.id)).toEqual({ feedback: 1, canonical: 1, audit: 1 });
  });

  it("renews an expired uncommitted intent for an identical retry and commits exactly one review", async () => {
    const { project, body } = await expiredUncommittedIntent();
    const responses = await Promise.all([
      request(`/api/projects/${project.id}/review-feedback`, post(body)),
      request(`/api/projects/${project.id}/review-feedback`, post(body)),
    ]);
    const ids = [];
    for (const response of responses) {
      expect(response.status, await response.clone().text()).toBe(201);
      ids.push((await response.json() as { feedback: { id: string } }).feedback.id);
    }
    expect(new Set(ids).size).toBe(1);
    expect(await effects(project.id)).toEqual({ feedback: 1, canonical: 1, audit: 1 });
  });

  it.each(["changed payload", "stale revision", "confirmed", "completed"])("does not renew an expired intent with %s", async (kind) => {
    const { project, body, expiredOn } = await expiredUncommittedIntent();
    if (kind === "confirmed" || kind === "completed") {
      const column = kind === "confirmed" ? "confirmed_on" : "completed_on";
      await bindings.DB.prepare(`UPDATE embed_review_operation_intents SET ${column} = ? WHERE project_id = ? AND request_id = ?`)
        .bind(new Date().toISOString(), project.id, body.requestId).run();
    }
    const changed = kind === "changed payload" ? { ...body, comment: "Changed before retry" }
      : kind === "stale revision" ? { ...body, reviewRevisionId: "revision_stale" } : body;
    const response = await request(`/api/projects/${project.id}/review-feedback`, post(changed));
    expect(response.status).toBe(409);
    const intent = await bindings.DB.prepare("SELECT expires_on FROM embed_review_operation_intents WHERE project_id = ? AND request_id = ?")
      .bind(project.id, body.requestId).first<{ expires_on: string }>();
    expect(intent?.expires_on).toBe(expiredOn);
    expect(await effects(project.id)).toEqual({ feedback: 0, canonical: 0, audit: 0 });
  });

  it.each(["stale revision", "foreign page", "invalid revision"])("rejects %s before creating an attributed effect", async (kind) => {
    const { project, body } = await fixture();
    const changed = kind === "foreign page" ? { ...body, pageUrl: "https://attacker.example/" }
      : { ...body, reviewRevisionId: kind === "invalid revision" ? {} : "revision_stale" };
    const response = await request(`/api/projects/${project.id}/review-feedback`, post(changed));
    expect(response.status).toBe(kind === "foreign page" ? 403 : kind === "invalid revision" ? 400 : 409);
    expect(await effects(project.id)).toEqual({ feedback: 0, canonical: 0, audit: 0 });
  });

  it.each(["null", "https://attacker.example", "https://sibling.shiplet.cc"])("rejects the untrusted origin %s", async (origin) => {
    const { project, body } = await fixture();
    expect((await request(`/api/projects/${project.id}/review-feedback`, post(body, { origin }))).status).toBe(403);
    expect(await effects(project.id)).toEqual({ feedback: 0, canonical: 0, audit: 0 });
  });

  it("rejects form media types and explicit authorization even with a valid reviewer identity", async () => {
    const { project, body } = await fixture();
    const url = `/api/projects/${project.id}/review-feedback`;
    expect((await request(url, post(body, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await request(url, post(body, { authorization: "Basic invalid" }))).status).toBe(401);
    expect(await effects(project.id)).toEqual({ feedback: 0, canonical: 0, audit: 0 });
  });

  it("rolls back the intent and every attributed effect when activation races the commit", async () => {
    const { project, body } = await fixture();
    const competingRevision = `revision_competing_${crypto.randomUUID().replace(/-/g, "")}`;
    await bindings.DB.prepare(`INSERT INTO shiplet_revisions (
      id, project_id, parent_revision_id, package_json, package_digest, content_digest,
      runtime_compatibility, validation_report_json, custom_mcp_projection_json,
      created_by_actor_kind, created_by_actor_id, created_on
    ) SELECT ?, project_id, id, package_json, package_digest, content_digest,
      runtime_compatibility, validation_report_json, custom_mcp_projection_json,
      created_by_actor_kind, created_by_actor_id, created_on
      FROM shiplet_revisions WHERE id = ?`)
      .bind(competingRevision, body.reviewRevisionId).run();
    let raced = false;
    const runtime = { ...bindings, DB: {
      prepare: bindings.DB.prepare.bind(bindings.DB),
      async batch(statements: D1PreparedStatement[]) {
        const preparedIntent = await bindings.DB.prepare(
          "SELECT id FROM embed_review_operation_intents WHERE project_id = ? AND request_id = ?",
        ).bind(project.id, body.requestId).first();
        if (!raced && preparedIntent) {
          raced = true;
          await bindings.DB.prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
            .bind(competingRevision, project.id).run();
        }
        return bindings.DB.batch(statements);
      },
    } as D1Database };
    const response = await request(`/api/projects/${project.id}/review-feedback`, post(body), runtime);
    expect(response.status).toBe(409);
    expect(raced).toBe(true);
    const active = await bindings.DB.prepare("SELECT active_revision_id FROM projects WHERE id = ?")
      .bind(project.id).first<{ active_revision_id: string }>();
    expect(active?.active_revision_id).toBe(competingRevision);
    expect(await effects(project.id)).toEqual({ feedback: 0, canonical: 0, audit: 0 });
    const intent = await bindings.DB.prepare("SELECT confirmed_on, completed_on FROM embed_review_operation_intents WHERE project_id = ?")
      .bind(project.id).first();
    expect(intent).toEqual({ confirmed_on: null, completed_on: null });
  });

  it("keeps captured context and selected mentions in the committed inline feedback", async () => {
    const { project, organizationId, body } = await fixture();
    const person = await reviewer(organizationId);
    const response = await request(`/api/projects/${project.id}/review-feedback`, post({
      ...body,
      mentions: [{ userId: person.id }], screenshotMode: "element",
      screenshotDataUrl: null, screenshotFailureNote: "No image captured",
      viewport: { width: 1200, height: 800, devicePixelRatio: 1 },
      coordinates: { pageX: 10, pageY: 20, viewportX: 10, viewportY: 20 },
      selectedElement: { selector: "h1", tagName: "H1", text: "Review this" },
      captureContext: { documentWidth: 1200, documentHeight: 800, scrollX: 0, scrollY: 0 },
    }));
    expect(response.status, await response.clone().text()).toBe(201);
    const { feedback } = await response.json() as {
      feedback: { screenshot_mode: string; selected_element: { selector: string }; mentions: Array<{ mentioned_user_id: string }> };
    };
    expect(feedback.screenshot_mode).toBe("element");
    expect(feedback.selected_element.selector).toBe("h1");
    expect(feedback.mentions.map((mention) => mention.mentioned_user_id)).toContain(person.id);
    expect(await effects(project.id)).toEqual({ feedback: 1, canonical: 1, audit: 1 });
  });

  it("accepts an existing tenant access cookie but rechecks scopes, membership, and explicit authorization", async () => {
    const { project, organizationId, body } = await fixture();
    const person = await reviewer(organizationId);
    const runtime = { ...bindings, CUSTOM_DOMAIN: "shiplet.cc", SHIPLET_APP_URL: "https://shiplet.cc" } as unknown as Env;
    const origin = `https://${project.subdomain}.shiplet.cc`;
    const url = `${origin}/__shiplet/review/feedback`;
    const tenantBody = { ...body, pageUrl: `${origin}/` };
    async function cookie(write: boolean) {
      const token = await createReviewCapabilityToken({
        secret: reviewCapabilitySecret(runtime), projectId: project.id,
        viewer: { id: person.id, email: person.email, name: "Reviewer", avatarPreset: null, avatarDataUrl: null },
        scopes: write ? ["presence:join", "feedback:write"] : ["presence:join", "feedback:read"],
        expiresInSeconds: 300,
      });
      return `__Host-shiplet_artifact_access=${encodeURIComponent(token)}`;
    }
    const accessCookie = await cookie(true);
    const send = (headers: Record<string, string> = {}, value = tenantBody) => request(url, {
      method: "POST", headers: { origin, "content-type": "application/json", cookie: accessCookie, ...headers },
      body: JSON.stringify(value),
    }, runtime);
    expect((await send({ cookie: await cookie(false) })).status).toBe(403);
    expect((await send({ authorization: "Basic invalid" })).status).toBe(401);
    expect((await send({ origin: "null" })).status).toBe(403);
    expect((await send()).status).toBe(201);
    expect(await effects(project.id)).toEqual({ feedback: 1, canonical: 1, audit: 1 });
    await bindings.DB.prepare("DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?")
      .bind(organizationId, person.id).run();
    expect((await send()).status).toBe(403);
    expect(await effects(project.id)).toEqual({ feedback: 1, canonical: 1, audit: 1 });
  });
});
