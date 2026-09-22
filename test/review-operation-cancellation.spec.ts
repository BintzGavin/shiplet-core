import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createEmbedReviewSession,
  createEmbedReviewSessionCookieHeader,
} from "../src/embed";
import app from "../src/index";
import { digestReviewOperationPayload, prepareReviewOperation } from "../src/review-operations";
import { getProjectById, getUser } from "../src/store";

const OWNER = {
  "x-shiplet-user-id": "user_review_cancellation_owner",
  "x-shiplet-user-email": "review-cancellation-owner@example.com",
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
    body: JSON.stringify({ name: `Review cancellation ${crypto.randomUUID()}` }),
  });
  expect(org.status).toBe(201);
  const { organization } = (await org.json()) as { organization: { id: string } };
  const published = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Review cancellation",
      organization_id: organization.id,
      subdomain: `review-cancel-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [{ path: "index.html", content: btoa("<!doctype html><h1>Cancel</h1>") }],
    }),
  });
  expect(published.status).toBe(201);
  const { project } = (await published.json()) as { project: { id: string; subdomain: string } };
  await request(`/api/shiplets/${project.id}/package`, { headers: OWNER });
  const revision = await (env as Env).DB
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(project.id)
    .first<{ active_revision_id: string }>();
  const feedbackResponse = await request(`/api/projects/${project.id}/review-feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      comment: "Cancellation target",
      pageUrl: `http://localhost/${project.subdomain}`,
      clientFeedbackId: `cancel-target-${crypto.randomUUID()}`,
    }),
  });
  expect(feedbackResponse.status).toBe(201);
  const { feedback } = (await feedbackResponse.json()) as { feedback: { id: string } };
  return { project, feedback, revisionId: revision!.active_revision_id, pageUrl: `http://localhost/${project.subdomain}` };
}

function cancellationBody(input: {
  revisionId: string;
  pageUrl: string;
  effect: string;
  feedbackId?: string;
  installationId?: string;
}) {
  return JSON.stringify({
    ...(input.installationId ? { installationId: input.installationId } : {}),
    revisionId: input.revisionId,
    pageUrl: input.pageUrl,
    effect: input.effect,
    ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}),
  });
}

function expectPrivateError(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
}

async function embedSession(projectId: string, revisionId: string, pageUrl: string) {
  const project = await getProjectById((env as Env).DB, projectId);
  const user = await getUser((env as Env).DB, OWNER["x-shiplet-user-id"]);
  if (!project || !user || !project.organization_id) throw new Error("Embed cancellation fixture unavailable");
  const installationId = `embed_installation_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await (env as Env).DB.prepare(
    `INSERT INTO embed_installations (
       id, project_id, organization_id, site_origin, site_url, site_name,
       secret_hash, created_by_user_id, created_on, last_used_on, revoked_on
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(
    installationId,
    project.id,
    project.organization_id,
    "https://site.example",
    pageUrl,
    "Cancellation site",
    `browser-only:${crypto.randomUUID()}`,
    user.id,
    now,
  ).run();
  const installation = await (env as Env).DB
    .prepare("SELECT * FROM embed_installations WHERE id = ?")
    .bind(installationId)
    .first<any>();
  const session = await createEmbedReviewSession((env as Env).DB, {
    installation,
    project,
    revisionId,
    user,
    pageUrl,
  });
  const cookie = createEmbedReviewSessionCookieHeader({
    installationId,
    sessionHandle: session.sessionHandle,
    now: new Date(),
    expiresOn: session.expiresOn,
  }).split(";", 1)[0];
  return { installationId, cookie };
}

describe("review operation cancellation", () => {
  it("cancels atomically, is idempotent, prevents completion, and never renews the request identity", async () => {
    const { project, feedback, revisionId, pageUrl } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const payloadJson = JSON.stringify({ feedbackId: feedback.id, value: "Done", mentions: [] });
    const operation = await prepareReviewOperation((env as Env).DB, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId,
      pageUrl,
      feedbackId: feedback.id,
    });
    const cancelPath = `/api/projects/${project.id}/review-operations/${requestId}/cancel`;
    const body = cancellationBody({
      revisionId,
      pageUrl,
      effect: "feedback.status",
      feedbackId: feedback.id,
    });
    const first = await request(cancelPath, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
      body,
    });
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({
      cancelled: true,
      operation: { requestId, effect: "feedback.status", state: "cancelled", result: null },
    });
    const second = await request(cancelPath, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
      body,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      cancelled: true,
      operation: { requestId, effect: "feedback.status", state: "cancelled", result: null },
    });

    const queryOnlyRequestId = `request_${crypto.randomUUID()}`;
    await prepareReviewOperation((env as Env).DB, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId: queryOnlyRequestId,
      pageUrl,
      feedbackId: feedback.id,
    });
    const queryOnly = await request(
      `/api/projects/${project.id}/review-operations/${queryOnlyRequestId}/cancel?${new URLSearchParams({ revision_id: revisionId, page_url: pageUrl, effect: "feedback.status", feedback_id: feedback.id })}`,
      {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
        body: "{}",
      },
    );
    expectPrivateError(queryOnly, 400);
    expect(await queryOnly.json()).toEqual({ error: "review_operation_request_invalid" });
    const queryOnlyRow = await (env as Env).DB
      .prepare("SELECT failed_on FROM embed_review_operation_intents WHERE request_id = ?")
      .bind(queryOnlyRequestId)
      .first<{ failed_on: string | null }>();
    expect(queryOnlyRow?.failed_on).toBeNull();

    const outcome = await request(`/api/projects/${project.id}/review-operations/${requestId}?${new URLSearchParams({ revision_id: revisionId, page_url: pageUrl, effect: "feedback.status", feedback_id: feedback.id })}`, { headers: OWNER });
    expect(outcome.status).toBe(200);
    expect(await outcome.json()).toEqual({
      operation: { requestId, effect: "feedback.status", state: "cancelled", result: null },
    });
    await expect(
      prepareReviewOperation((env as Env).DB, {
        installationId: `managed:${project.id}`,
        projectId: project.id,
        revisionId,
        actorUserId: OWNER["x-shiplet-user-id"],
        effect: "feedback.status",
        payloadJson,
        payloadDigest: await digestReviewOperationPayload(payloadJson),
        requestId,
        pageUrl,
        feedbackId: feedback.id,
      }),
    ).rejects.toBeInstanceOf(Error);
    const row = await (env as Env).DB.prepare("SELECT status FROM review_feedback WHERE id = ?").bind(feedback.id).first<{ status: string }>();
    expect(row?.status).toBe("New");
  });

  it("uses exact JSON bindings from the body on tenant and embed routes", async () => {
    const { project, feedback, revisionId, pageUrl } = await fixture();
    const payloadJson = JSON.stringify({ feedbackId: feedback.id, value: "Done", mentions: [] });
    const tenantRequestId = `request_${crypto.randomUUID()}`;
    await prepareReviewOperation((env as Env).DB, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId: tenantRequestId,
      pageUrl,
      feedbackId: feedback.id,
    });
    const tenant = await request(`/${project.subdomain}/__shiplet/review/operations/${tenantRequestId}/cancel`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
      body: cancellationBody({ revisionId, pageUrl, effect: "feedback.status", feedbackId: feedback.id }),
    });
    expect(tenant.status, await tenant.clone().text()).toBe(200);
    expect(await tenant.json()).toMatchObject({
      cancelled: true,
      operation: { requestId: tenantRequestId, state: "cancelled", result: null },
    });

    const invalidRequestId = `request_${crypto.randomUUID()}`;
    await prepareReviewOperation((env as Env).DB, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId: invalidRequestId,
      pageUrl,
      feedbackId: feedback.id,
    });
    const invalidBodies = ["{}", "{", JSON.stringify({ revisionId, pageUrl, effect: "feedback.status", feedbackId: feedback.id, unexpected: true })];
    for (const body of invalidBodies) {
      const invalid = await request(`/${project.subdomain}/__shiplet/review/operations/${invalidRequestId}/cancel`, {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
        body,
      });
      expectPrivateError(invalid, 400);
      expect(await invalid.json()).toEqual({ error: "review_operation_request_invalid" });
    }
    const invalidRow = await (env as Env).DB
      .prepare("SELECT failed_on FROM embed_review_operation_intents WHERE request_id = ?")
      .bind(invalidRequestId)
      .first<{ failed_on: string | null }>();
    expect(invalidRow?.failed_on).toBeNull();

    const embeddedPageUrl = "https://site.example/review/page";
    const { installationId, cookie } = await embedSession(project.id, revisionId, embeddedPageUrl);
    const embedRequestId = `request_${crypto.randomUUID()}`;
    await prepareReviewOperation((env as Env).DB, {
      installationId,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId: embedRequestId,
      pageUrl: embeddedPageUrl,
      feedbackId: feedback.id,
      intentPrefix: "embed_intent",
    });
    const embedded = await request(`/embed/review/operations/${embedRequestId}/cancel`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: cancellationBody({
        installationId,
        revisionId,
        pageUrl: embeddedPageUrl,
        effect: "feedback.status",
        feedbackId: feedback.id,
      }),
    });
    expect(embedded.status, await embedded.clone().text()).toBe(200);
    expect(await embedded.json()).toMatchObject({
      cancelled: true,
      operation: { requestId: embedRequestId, state: "cancelled", result: null },
    });
  });

  it("rejects a valid wrong embed body revision without mutation, then accepts the session revision", async () => {
    const { project, feedback, revisionId } = await fixture();
    const pageUrl = "https://site.example/review/revision-fence";
    const { installationId, cookie } = await embedSession(project.id, revisionId, pageUrl);
    const requestId = `request_${crypto.randomUUID()}`;
    const payloadJson = JSON.stringify({ feedbackId: feedback.id, value: "Done", mentions: [] });
    await prepareReviewOperation((env as Env).DB, {
      installationId,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId,
      pageUrl,
      feedbackId: feedback.id,
      intentPrefix: "embed_intent",
    });
    const wrongRevision = `${revisionId}_wrong`;
    const wrong = await request(`/embed/review/operations/${requestId}/cancel`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: cancellationBody({
        installationId,
        revisionId: wrongRevision,
        pageUrl,
        effect: "feedback.status",
        feedbackId: feedback.id,
      }),
    });
    expectPrivateError(wrong, 404);
    expect(await wrong.json()).toEqual({ error: "review_operation_not_found" });

    const pending = await request(`/embed/review/operations/${requestId}?${new URLSearchParams({
      installation_id: installationId,
      effect: "feedback.status",
      feedback_id: feedback.id,
    })}`, { headers: { Cookie: cookie } });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      operation: { requestId, effect: "feedback.status", state: "pending", result: null },
    });

    const correct = await request(`/embed/review/operations/${requestId}/cancel`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: cancellationBody({
        installationId,
        revisionId,
        pageUrl,
        effect: "feedback.status",
        feedbackId: feedback.id,
      }),
    });
    expect(correct.status, await correct.clone().text()).toBe(200);
    expect(await correct.json()).toEqual({
      cancelled: true,
      operation: { requestId, effect: "feedback.status", state: "cancelled", result: null },
    });
  });

  it("returns fail-closed responses for sandbox and wrong bindings", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const confirmedRequestId = `request_${crypto.randomUUID()}`;
    const confirmedPayload = JSON.stringify({ feedbackId: "missing", value: "Done" });
    const confirmed = await prepareReviewOperation((env as Env).DB, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.status",
      payloadJson: confirmedPayload,
      payloadDigest: await digestReviewOperationPayload(confirmedPayload),
      requestId: confirmedRequestId,
      pageUrl,
    });
    await (env as Env).DB.prepare(
      "UPDATE embed_review_operation_intents SET confirmed_on = ? WHERE id = ?",
    ).bind(new Date().toISOString(), confirmed.id).run();
    const confirmedCancel = await request(`/api/projects/${project.id}/review-operations/${confirmedRequestId}/cancel`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
      body: cancellationBody({ revisionId, pageUrl, effect: "feedback.status", feedbackId: confirmed.result_feedback_id! }),
    });
    expect(confirmedCancel.status).toBe(409);
    expect(await confirmedCancel.json()).toMatchObject({ cancelled: false, operation: { state: "unknown", result: null } });
    const sandbox = await request(`/api/projects/sandbox-sbx_sharedsandboxdemo0000000-cancel/review-operations/request_x/cancel`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(sandbox.status).toBe(409);
    const wrong = await request(`/api/projects/${project.id}/review-operations/request_missing/cancel`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json", ...OWNER },
      body: cancellationBody({ revisionId, pageUrl, effect: "feedback.status", feedbackId: "missing" }),
    });
    expectPrivateError(wrong, 404);
    expect(await wrong.json()).toEqual({ error: "review_operation_not_found" });
  });
});
