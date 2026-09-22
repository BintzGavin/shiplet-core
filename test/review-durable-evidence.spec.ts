import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const OWNER = {
  "x-shiplet-user-id": "user_durable_evidence_owner",
  "x-shiplet-user-email": "durable-evidence-owner@example.com",
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
    body: JSON.stringify({ name: `Durable evidence ${crypto.randomUUID()}` }),
  });
  expect(organizationResponse.status).toBe(201);
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Durable evidence",
      organization_id: organization.id,
      subdomain: `durable-evidence-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "public",
      assets: [{ path: "index.html", content: btoa("<!doctype html><h1>Evidence</h1>") }],
    }),
  });
  expect(publishResponse.status).toBe(201);
  const { project } = (await publishResponse.json()) as {
    project: { id: string; subdomain: string };
  };
  await request(`/api/shiplets/${project.id}/package`, { headers: OWNER });
  const revision = await (env as Env).DB
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(project.id)
    .first<{ active_revision_id: string }>();
  return {
    project,
    revisionId: revision!.active_revision_id,
    pageUrl: `http://localhost/${project.subdomain}`,
  };
}

function largePngDataUrl(byteLength = 1_200_000) {
  const bytes = new Uint8Array(byteLength);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function expectPrivateEvidenceNotFound(intentId: string) {
  const response = await request(`/review/confirm/evidence/${intentId}`, {
    headers: OWNER,
  });
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "review_evidence_not_found" });
}

async function prepareEvidenceIntent(input: {
  projectId: string;
  revisionId: string;
  pageUrl: string;
  screenshotBytes?: number;
}) {
  const requestId = `request_${crypto.randomUUID()}`;
  const clientFeedbackId = `evidence-terminal-${crypto.randomUUID()}`;
  const prepared = await request("/review/confirm", {
    method: "POST",
    headers: {
      Origin: "http://localhost",
      "Content-Type": "application/x-www-form-urlencoded",
      ...OWNER,
    },
    body: new URLSearchParams({
      request_id: requestId,
      operation: "feedback.create",
      comment: "Terminal evidence preview",
      page_url: input.pageUrl,
      client_feedback_id: clientFeedbackId,
      shiplet_id: input.projectId,
      revision_id: input.revisionId,
      screenshot_data_url: largePngDataUrl(input.screenshotBytes || 1_100_000),
      screenshot_mode: "element",
      viewport_json: JSON.stringify({ width: 1440, height: 900, devicePixelRatio: 1 }),
      coordinates_json: JSON.stringify({ pageX: 10, pageY: 20, viewportX: 10, viewportY: 20 }),
      selected_element_json: JSON.stringify({ selector: "#hero", tagName: "H1", text: "Evidence" }),
      capture_context_json: JSON.stringify({ documentWidth: 1440, documentHeight: 1800, scrollX: 0, scrollY: 0 }),
    }),
  });
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  const intentId = (await prepared.text()).match(/name="intent_id" value="([^"]+)"/)?.[1];
  expect(intentId).toMatch(/^review_intent_/);
  return intentId!;
}

describe("durable screenshot evidence", () => {
  it("serves only an exact pending compact create intent and hides every terminal state", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const intentId = await prepareEvidenceIntent({
      projectId: project.id,
      revisionId,
      pageUrl,
    });

    const pending = await request(`/review/confirm/evidence/${intentId}`, {
      headers: OWNER,
    });
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("private, no-store");

    const terminalStates = [
      { confirmedOn: null, completedOn: null, failedOn: new Date().toISOString(), failureCode: "cancelled_by_user", expiresOn: new Date(Date.now() + 60_000).toISOString() },
      { confirmedOn: null, completedOn: null, failedOn: new Date().toISOString(), failureCode: "provider_failure", expiresOn: new Date(Date.now() + 60_000).toISOString() },
      { confirmedOn: new Date().toISOString(), completedOn: null, failedOn: null, failureCode: null, expiresOn: new Date(Date.now() + 60_000).toISOString() },
      { confirmedOn: new Date().toISOString(), completedOn: new Date().toISOString(), failedOn: null, failureCode: null, expiresOn: new Date(Date.now() + 60_000).toISOString() },
      { confirmedOn: null, completedOn: null, failedOn: null, failureCode: null, expiresOn: new Date(Date.now() - 60_000).toISOString() },
    ];
    for (const state of terminalStates) {
      await (env as Env).DB
        .prepare(
          `UPDATE embed_review_operation_intents
           SET confirmed_on = ?, completed_on = ?, failed_on = ?, failure_code = ?, expires_on = ?
           WHERE id = ?`,
        )
        .bind(
          state.confirmedOn,
          state.completedOn,
          state.failedOn,
          state.failureCode,
          state.expiresOn,
          intentId,
        )
        .run();
      await expectPrivateEvidenceNotFound(intentId);
    }
  });

  it("stages a large managed capture as a compact descriptor and verifies it before D1", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const clientFeedbackId = `evidence-${crypto.randomUUID()}`;
    const requestId = `request_${crypto.randomUUID()}`;
    const screenshotDataUrl = largePngDataUrl();
    const prepared = await request("/review/confirm", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({
        request_id: requestId,
        operation: "feedback.create",
        comment: "Persist this durable capture",
        page_url: pageUrl,
        client_feedback_id: clientFeedbackId,
        shiplet_id: project.id,
        revision_id: revisionId,
        screenshot_data_url: screenshotDataUrl,
        screenshot_mode: "element",
        viewport_json: JSON.stringify({ width: 1440, height: 900, devicePixelRatio: 1 }),
        coordinates_json: JSON.stringify({ pageX: 10, pageY: 20, viewportX: 10, viewportY: 20 }),
        selected_element_json: JSON.stringify({ selector: "#hero", tagName: "H1", text: "Evidence" }),
        capture_context_json: JSON.stringify({ documentWidth: 1440, documentHeight: 1800, scrollX: 0, scrollY: 0 }),
      }),
    });
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    const html = await prepared.text();
    const intentId = html.match(/name="intent_id" value="([^"]+)"/)?.[1];
    expect(intentId).toMatch(/^review_intent_/);

    const intent = await (env as Env).DB
      .prepare("SELECT payload_json, result_feedback_id FROM embed_review_operation_intents WHERE id = ?")
      .bind(intentId)
      .first<{ payload_json: string; result_feedback_id: string }>();
    const payload = JSON.parse(intent!.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("screenshotDataUrl");
    expect(payload.screenshot).toMatchObject({
      version: 1,
      contentType: "image/png",
      byteLength: 1_200_000,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    const preview = await request(`/review/confirm/evidence/${intentId}`, {
      headers: OWNER,
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("content-length")).toBe("1200000");
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(preview.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(preview.headers.get("access-control-allow-origin")).toBeNull();
    const foreignPreview = await request(`/review/confirm/evidence/${intentId}`, {
      headers: {
        "x-shiplet-user-id": "user_durable_evidence_foreign",
        "x-shiplet-user-email": "durable-evidence-foreign@example.com",
      },
    });
    expect(foreignPreview.status).toBe(404);

    const completed = await request("/review/confirm/complete", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({ intent_id: intentId || "", approval: "confirm" }),
    });
    expect(completed.status, await completed.clone().text()).toBe(200);
    const row = await (env as Env).DB
      .prepare(
        "SELECT id, screenshot_key, screenshot_content_type, screenshot_size FROM review_feedback WHERE project_id = ? AND client_feedback_id = ?",
      )
      .bind(project.id, clientFeedbackId)
      .first<{ id: string; screenshot_key: string; screenshot_content_type: string; screenshot_size: number }>();
    expect(row).toMatchObject({
      screenshot_content_type: "image/png",
      screenshot_size: 1_200_000,
    });
    const object = await (env as Env).REVIEW_ASSETS?.get(row!.screenshot_key);
    expect(object?.size).toBe(1_200_000);
  });

  it("fails closed when the staged object is corrupt and leaves the intent retryable", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const clientFeedbackId = `corrupt-${crypto.randomUUID()}`;
    const prepared = await request("/review/confirm", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({
        request_id: requestId,
        operation: "feedback.create",
        comment: "Corrupt staged evidence",
        page_url: pageUrl,
        client_feedback_id: clientFeedbackId,
        shiplet_id: project.id,
        revision_id: revisionId,
        screenshot_data_url: largePngDataUrl(400_000),
        screenshot_mode: "element",
        viewport_json: JSON.stringify({ width: 800, height: 600, devicePixelRatio: 1 }),
        coordinates_json: JSON.stringify({ pageX: 1, pageY: 2, viewportX: 1, viewportY: 2 }),
        selected_element_json: JSON.stringify({ selector: "#hero", tagName: "H1", text: "Evidence" }),
        capture_context_json: JSON.stringify({ documentWidth: 800, documentHeight: 900, scrollX: 0, scrollY: 0 }),
      }),
    });
    expect(prepared.status).toBe(200);
    const intentId = (await prepared.text()).match(/name="intent_id" value="([^"]+)"/)?.[1];
    const intent = await (env as Env).DB
      .prepare("SELECT result_feedback_id FROM embed_review_operation_intents WHERE id = ?")
      .bind(intentId)
      .first<{ result_feedback_id: string }>();
    await (env as Env).REVIEW_ASSETS!.put(
      `projects/${project.id}/feedback/${intent!.result_feedback_id}.png`,
      new Uint8Array(400_000),
      { httpMetadata: { contentType: "image/png" } },
    );
    expect((await request(`/review/confirm/evidence/${intentId}`, { headers: OWNER })).status).toBe(404);
    const completed = await request("/review/confirm/complete", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({ intent_id: intentId || "", approval: "confirm" }),
    });
    expect(completed.status).toBe(503);
    expect(
      (await (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ? AND client_feedback_id = ?").bind(project.id, clientFeedbackId).first<{ count: number }>())?.count,
    ).toBe(0);
  });

  it("keeps direct tenant creation and metadata dedupe compatible with large captures", async () => {
    const { project, pageUrl } = await fixture();
    const body = {
      comment: "Direct durable evidence",
      pageUrl,
      clientFeedbackId: `direct-${crypto.randomUUID()}`,
      requestId: `request_${crypto.randomUUID()}`,
      screenshotDataUrl: largePngDataUrl(1_100_000),
      viewport: { width: 1440, height: 900, devicePixelRatio: 1 },
    };
    const first = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify(body),
    });
    expect(first.status, await first.clone().text()).toBe(201);
    const second = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ ...body, comment: "Changed metadata" }),
    });
    expect(second.status).toBe(409);
    const count = await (env as Env).DB
      .prepare("SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ? AND client_feedback_id = ?")
      .bind(project.id, body.clientFeedbackId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
