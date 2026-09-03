import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { digestEmbedReviewOperationReceiptHandle } from "../src/embed";
import {
  createReviewFeedback,
  validateReviewFeedbackPayload,
} from "../src/review";
import type { Project } from "../src/types";
import type { ShipletUser } from "../src/store";

const OWNER = {
  "x-shiplet-user-id": "user_managed_review_confirmation_owner",
  "x-shiplet-user-email": "managed-review-confirmation@example.com",
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
    body: JSON.stringify({ name: `Managed review ${crypto.randomUUID()}` }),
  });
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const subdomain = `managed-review-${crypto.randomUUID().slice(0, 8)}`;
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Managed trusted review",
      organization_id: organization.id,
      subdomain,
      visibility: "private",
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Managed review</h1>"),
        },
      ],
    }),
  });
  const { project } = (await publishResponse.json()) as {
    project: { id: string; subdomain: string };
  };
  await request(`/api/shiplets/${project.id}/package`, { headers: OWNER });
  const active = await (env as Env).DB.prepare(
    "SELECT active_revision_id FROM projects WHERE id = ?",
  )
    .bind(project.id)
    .first<{ active_revision_id: string }>();
  return {
    project,
    revisionId: active!.active_revision_id,
    pageUrl: `http://localhost/${subdomain}`,
  };
}

describe("managed trusted review confirmation", () => {

  it("rolls back a legacy receipt and every attributed effect when activation changes at commit time", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const installationId = `legacy_installation_${crypto.randomUUID()}`;
    const receiptHandle = `legacy_receipt_${crypto.randomUUID().replace(/-/g, "")}`;
    const clientFeedbackId = `legacy-${crypto.randomUUID()}`;
    const comment = "Legacy receipt must remain revision-bound";
    const hash = await digestEmbedReviewOperationReceiptHandle(receiptHandle);
    const payloadDigestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ comment, pageUrl, clientFeedbackId })),
    );
    const payloadDigest = `sha256:${Array.from(new Uint8Array(payloadDigestBytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
    const claimedOn = new Date().toISOString();
    await (env as Env).DB.prepare(
      `INSERT INTO embed_review_operation_receipts (
       receipt_hash, installation_id, project_id, revision_id, actor_user_id,
       effect, payload_digest, request_id, expires_on, claimed_on
      ) VALUES (?, ?, ?, ?, ?, 'feedback.create', ?, ?, ?, NULL)`,
    )
      .bind(
        hash,
        installationId,
        project.id,
        revisionId,
        OWNER["x-shiplet-user-id"],
        payloadDigest,
        clientFeedbackId,
        new Date(Date.now() + 60_000).toISOString(),
      )
      .run();
    const [projectRow, user] = await Promise.all([
      (env as Env).DB.prepare("SELECT * FROM projects WHERE id = ?")
        .bind(project.id)
        .first<Project>(),
      (env as Env).DB.prepare("SELECT * FROM users WHERE id = ?")
        .bind(OWNER["x-shiplet-user-id"])
        .first<ShipletUser>(),
    ]);
    const validation = validateReviewFeedbackPayload({
      comment,
      pageUrl,
      clientFeedbackId,
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(validation.ok).toBe(true);
    if (!projectRow || !user || !hash || !validation.ok) return;
    const realDb = (env as Env).DB;
    const racingDb = {
      prepare: realDb.prepare.bind(realDb),
      async batch(statements: D1PreparedStatement[]) {
        await realDb
          .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
          .bind("revision_competing_legacy_activation", project.id)
          .run();
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
    const created = await createReviewFeedback(
      { DB: racingDb } as Env,
      projectRow,
      user,
      validation.value,
      {
        kind: "receipt",
        revisionId,
        receiptHash: hash,
        installationId,
        payloadDigest,
        requestId: clientFeedbackId,
        claimedOn,
      },
    );
    expect(created).toBeNull();
    expect(
      await realDb
        .prepare("SELECT claimed_on FROM embed_review_operation_receipts WHERE receipt_hash = ?")
        .bind(hash)
        .first(),
    ).toEqual({ claimed_on: null });
    expect(
      await realDb
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM review_feedback WHERE project_id = ?) AS feedback_count,
           (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ?
             AND event_kind = 'review.feedback-created') AS event_count,
           (SELECT COUNT(*) FROM shiplet_audit_events WHERE project_id = ?
             AND event_kind = 'review.feedback_created') AS audit_count`,
        )
        .bind(project.id, project.id, project.id)
        .first(),
    ).toMatchObject({ feedback_count: 0, event_count: 0, audit_count: 0 });
  });

  it("rolls back the intent, feedback, canonical event, and audit when activation changes at effect time", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const intentId = `review_intent_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    await (env as Env).DB.prepare(
      `INSERT INTO embed_review_operation_intents (
       id, installation_id, project_id, revision_id, actor_user_id,
       effect, payload_json, payload_digest, request_id, page_url,
       expires_on, confirmed_on, completed_on, created_on
      ) VALUES (?, ?, ?, ?, ?, 'feedback.create', '{}', ?, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(
        intentId,
        `managed:${project.id}`,
        project.id,
        revisionId,
        OWNER["x-shiplet-user-id"],
        `sha256:${"a".repeat(64)}`,
        `request_${crypto.randomUUID()}`,
        pageUrl,
        new Date(Date.now() + 60_000).toISOString(),
        now,
      )
      .run();
    const [projectRow, user] = await Promise.all([
      (env as Env).DB.prepare("SELECT * FROM projects WHERE id = ?")
        .bind(project.id)
        .first<Project>(),
      (env as Env).DB.prepare("SELECT * FROM users WHERE id = ?")
        .bind(OWNER["x-shiplet-user-id"])
        .first<ShipletUser>(),
    ]);
    const validation = validateReviewFeedbackPayload({
      comment: "Must remain bound to the approved revision",
      pageUrl,
      clientFeedbackId: `managed-${crypto.randomUUID()}`,
    });
    expect(validation.ok).toBe(true);
    if (!projectRow || !user || !validation.ok) return;
    const realDb = (env as Env).DB;
    const racingDb = {
      prepare: realDb.prepare.bind(realDb),
      async batch(statements: D1PreparedStatement[]) {
        await realDb
          .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
          .bind("revision_competing_activation", project.id)
          .run();
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
    const created = await createReviewFeedback(
      { DB: racingDb } as Env,
      projectRow,
      user,
      validation.value,
      {
        revisionId,
        intentId,
        confirmedOn: now,
        requestId: `request_${crypto.randomUUID()}`,
      },
    );
    expect(created).toBeNull();
    expect(
      await realDb
        .prepare(
          `SELECT confirmed_on, completed_on FROM embed_review_operation_intents
           WHERE id = ?`,
        )
        .bind(intentId)
        .first(),
    ).toEqual({ confirmed_on: null, completed_on: null });
    expect(
      await realDb
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM review_feedback WHERE project_id = ?) AS feedback_count,
            (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ?
              AND event_kind = 'review.feedback-created') AS event_count,
            (SELECT COUNT(*) FROM shiplet_audit_events WHERE project_id = ?
              AND event_kind = 'review.feedback_created') AS audit_count`,
        )
        .bind(project.id, project.id, project.id)
        .first(),
    ).toMatchObject({ feedback_count: 0, event_count: 0, audit_count: 0 });
  });

  it("Given a trusted host submission, When the same human confirms it, Then feedback is created once and audited", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const clientFeedbackId = `managed-${crypto.randomUUID()}`;
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
        comment: "Confirm this managed review event",
        page_url: pageUrl,
        client_feedback_id: clientFeedbackId,
        shiplet_id: project.id,
        revision_id: revisionId,
        screenshot_data_url:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        screenshot_mode: "element",
        viewport_json: JSON.stringify({
          width: 1280,
          height: 720,
          devicePixelRatio: 2,
        }),
        coordinates_json: JSON.stringify({
          pageX: 240,
          pageY: 180,
          viewportX: 240,
          viewportY: 180,
        }),
        selected_element_json: JSON.stringify({
          selector: "#hero",
          tagName: "H1",
          text: "Managed review",
        }),
        capture_context_json: JSON.stringify({
          documentWidth: 1280,
          documentHeight: 1600,
          scrollX: 0,
          scrollY: 80,
        }),
      }),
    });
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    const preparedHtml = await prepared.text();
    expect(preparedHtml).toContain('action="/review/confirm/complete"');
    const intentId = preparedHtml.match(
      /name="intent_id" value="([^"]+)"/,
    )?.[1];
    expect(intentId).toMatch(/^review_intent_/);

    const completed = await request("/review/confirm/complete", {
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
    expect(completed.status, await completed.clone().text()).toBe(200);
    expect(await completed.text()).toContain(
      'data-shiplet-confirmation="complete"',
    );

    const feedback = await (env as Env).DB.prepare(
      `SELECT submitted_by_user_id, comment, screenshot_mode,
              selected_element_json, coordinates_json
       FROM review_feedback
       WHERE project_id = ? AND client_feedback_id = ?`,
    )
      .bind(project.id, clientFeedbackId)
      .first<{
        submitted_by_user_id: string;
        comment: string;
        screenshot_mode: string;
        selected_element_json: string;
        coordinates_json: string;
      }>();
    expect(feedback).toMatchObject({
      submitted_by_user_id: OWNER["x-shiplet-user-id"],
      comment: "Confirm this managed review event",
      screenshot_mode: "element",
    });
    expect(JSON.parse(feedback!.selected_element_json)).toEqual({
      selector: "#hero",
      tagName: "H1",
      text: "Managed review",
    });
    expect(JSON.parse(feedback!.coordinates_json)).toMatchObject({
      pageX: 240,
      pageY: 180,
    });
    const audit = await (env as Env).DB.prepare(
      `SELECT event_kind, actor_id FROM shiplet_audit_events
       WHERE project_id = ? AND event_kind = 'review.feedback_created'
       ORDER BY recorded_on DESC LIMIT 1`,
    )
      .bind(project.id)
      .first();
    expect(audit).toMatchObject({
      event_kind: "review.feedback_created",
      actor_id: OWNER["x-shiplet-user-id"],
    });

    const replay = await request("/review/confirm/complete", {
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

  it("rejects a cross-origin or stale-revision intent before persistence", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const body = new URLSearchParams({
      request_id: `request_${crypto.randomUUID()}`,
      operation: "feedback.create",
      comment: "Do not attribute this",
      page_url: pageUrl,
      client_feedback_id: `managed-${crypto.randomUUID()}`,
      shiplet_id: project.id,
      revision_id: `${revisionId}_stale`,
    });
    const crossOrigin = await request("/review/confirm", {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body,
    });
    expect(crossOrigin.status).toBe(403);

    const stale = await request("/review/confirm", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body,
    });
    expect(stale.status).toBe(409);
  });

  it("accepts only the exact production tenant origin and rejects sibling or opaque same-site provenance", async () => {
    const testEnv = env as unknown as {
      CUSTOM_DOMAIN?: string;
      SHIPLET_APP_URL?: string;
    };
    const previousCustomDomain = testEnv.CUSTOM_DOMAIN;
    const previousAppUrl = testEnv.SHIPLET_APP_URL;
    testEnv.CUSTOM_DOMAIN = "shiplet.cc";
    testEnv.SHIPLET_APP_URL = "https://shiplet.cc";
    try {
      const { project, revisionId } = await fixture();
      const pageUrl = `https://${project.subdomain}.shiplet.cc/`;
      const body = new URLSearchParams({
        request_id: `request_${crypto.randomUUID()}`,
        operation: "feedback.create",
        comment: "Exact tenant provenance",
        page_url: pageUrl,
        client_feedback_id: `managed-${crypto.randomUUID()}`,
        shiplet_id: project.id,
        revision_id: revisionId,
      });

      const exactTenant = await request("/review/confirm", {
        method: "POST",
        headers: {
          Origin: new URL(pageUrl).origin,
          "Content-Type": "application/x-www-form-urlencoded",
          ...OWNER,
        },
        body,
      });
      expect(exactTenant.status, await exactTenant.clone().text()).toBe(200);

      const siblingTenant = await request("/review/confirm", {
        method: "POST",
        headers: {
          Origin: "https://sibling.shiplet.cc",
          "Content-Type": "application/x-www-form-urlencoded",
          ...OWNER,
        },
        body,
      });
      expect(siblingTenant.status).toBe(403);

      const opaqueSameSite = await request("/review/confirm", {
        method: "POST",
        headers: {
          Origin: "null",
          "Sec-Fetch-Site": "same-site",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Content-Type": "application/x-www-form-urlencoded",
          ...OWNER,
        },
        body,
      });
      expect(opaqueSameSite.status).toBe(403);
    } finally {
      testEnv.CUSTOM_DOMAIN = previousCustomDomain;
      testEnv.SHIPLET_APP_URL = previousAppUrl;
    }
  });

  it("rejects malformed or credential-shaped artifact context before creating an intent", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const prepared = await request("/review/confirm", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({
        request_id: `request_${crypto.randomUUID()}`,
        operation: "feedback.create",
        comment: "Reject hostile capture context",
        page_url: pageUrl,
        client_feedback_id: `managed-${crypto.randomUUID()}`,
        shiplet_id: project.id,
        revision_id: revisionId,
        screenshot_mode: "element",
        selected_element_json: JSON.stringify({
          selector: "#hero",
          tagName: "H1",
          text: "Managed review",
          access_token: "must-not-cross",
        }),
      }),
    });
    expect(prepared.status).toBe(400);
    const intents = await (env as Env).DB.prepare(
      `SELECT COUNT(*) AS count FROM embed_review_operation_intents
       WHERE project_id = ? AND request_id LIKE 'request_%'`,
    )
      .bind(project.id)
      .first<{ count: number }>();
    expect(intents?.count).toBe(0);
  });

  it("accepts a null Origin only for a same-origin top-level browser form navigation", async () => {
    const { project, revisionId, pageUrl } = await fixture();
    const form = (requestId: string) =>
      new URLSearchParams({
        request_id: requestId,
        operation: "feedback.create",
        comment: "Browser provenance confirmation",
        page_url: pageUrl,
        client_feedback_id: `managed-${crypto.randomUUID()}`,
        shiplet_id: project.id,
        revision_id: revisionId,
      });
    const prepared = await request("/review/confirm", {
      method: "POST",
      headers: {
        Origin: "null",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: form(`request_${crypto.randomUUID()}`),
    });
    expect(prepared.status, await prepared.clone().text()).toBe(200);

    for (const headers of [
      {
        Origin: "null",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      {
        Origin: "null",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      },
    ]) {
      const denied = await request("/review/confirm", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded",
          ...OWNER,
        },
        body: form(`request_${crypto.randomUUID()}`),
      });
      expect(denied.status).toBe(403);
    }
  });
});
