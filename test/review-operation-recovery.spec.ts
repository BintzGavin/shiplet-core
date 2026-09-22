import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  completeDurableThreadOperation,
  digestReviewOperationPayload,
  prepareReviewOperation,
} from "../src/review-operations";
import type { Project } from "../src/types";
import type { ShipletUser } from "../src/store";

const OWNER = {
  "x-shiplet-user-id": "user_review_operation_owner",
  "x-shiplet-user-email": "review-operation-owner@example.com",
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
    body: JSON.stringify({ name: `Durable review ${crypto.randomUUID()}` }),
  });
  const { organization } = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Durable review operations",
      organization_id: organization.id,
      subdomain: `durable-review-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Durable review</h1>"),
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
  const pageUrl = `http://localhost/${project.subdomain}`;
  const feedbackResponse = await request(
    `/api/projects/${project.id}/review-feedback`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({
        comment: "Durable operation target",
        pageUrl,
        clientFeedbackId: `client-${crypto.randomUUID()}`,
      }),
    },
  );
  const { feedback } = (await feedbackResponse.json()) as {
    feedback: { id: string };
  };
  return {
    organization,
    project,
    feedback,
    pageUrl,
    revisionId: active!.active_revision_id,
  };
}

function operationQuery(input: {
  requestId: string;
  revisionId: string;
  pageUrl: string;
  effect: string;
  feedbackId: string;
}) {
  return `${input.requestId}?${new URLSearchParams({
    revision_id: input.revisionId,
    page_url: input.pageUrl,
    effect: input.effect,
    feedback_id: input.feedbackId,
  })}`;
}

describe("durable review operation recovery", () => {
  it("commits one human reply for concurrent retries and returns its stable outcome", async () => {
    const { project, feedback, pageUrl, revisionId } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const reply = () =>
      request(
        `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...OWNER },
          body: JSON.stringify({
            comment: "One durable reply",
            requestId,
          }),
        },
      );

    const responses = await Promise.all([reply(), reply()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const rows = await (env as Env).DB.prepare(
      `SELECT id FROM review_feedback_replies
       WHERE project_id = ? AND feedback_id = ? AND comment = ?`,
    )
      .bind(project.id, feedback.id, "One durable reply")
      .all<{ id: string }>();
    expect(rows.results).toHaveLength(1);

    const outcome = await request(
      `/${project.subdomain}/__shiplet/review/operations/${operationQuery({
        requestId,
        revisionId,
        pageUrl,
        effect: "feedback.reply",
        feedbackId: feedback.id,
      })}`,
      { headers: OWNER },
    );
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get("cache-control")).toBe("private, no-store");
    expect(await outcome.json()).toEqual({
      operation: {
        requestId,
        effect: "feedback.reply",
        state: "completed",
        result: {
          feedbackId: feedback.id,
          replyId: rows.results[0]!.id,
          eventId: expect.stringMatching(/^event_/),
        },
      },
    });

    const mismatch = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          ...OWNER,
        },
        body: JSON.stringify({ comment: "Changed payload", requestId }),
      },
    );
    expect(mismatch.status).toBe(409);
  });

  it("requires an authenticated human for requestId and reports ambiguous legacy completion as unknown", async () => {
    const { organization, project, feedback, pageUrl, revisionId } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const tokenResponse = await request(
      `/api/organizations/${organization.id}/api-tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          ...OWNER,
        },
        body: JSON.stringify({
          name: "Durable rejection agent",
          scopes: ["feedback:write"],
          projectAccessMode: "all",
          projectRules: [],
        }),
      },
    );
    expect(tokenResponse.status).toBe(201);
    const token = ((await tokenResponse.json()) as { token: string }).token;
    const agentAttempt = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "Done", requestId: `request_${crypto.randomUUID()}` }),
      },
    );
    expect(agentAttempt.status).toBe(400);
    expect(await agentAttempt.json()).toEqual({
      ok: false,
      code: "durable_recovery_requires_user",
    });

    const now = new Date().toISOString();
    await (env as Env).DB.prepare(
      `INSERT INTO embed_review_operation_intents (
       id, installation_id, project_id, revision_id, actor_user_id,
       effect, payload_json, payload_digest, request_id, page_url,
       expires_on, confirmed_on, completed_on, created_on
      ) VALUES (?, ?, ?, ?, ?, 'feedback.status', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `review_intent_${crypto.randomUUID().replace(/-/g, "")}`,
        `managed:${project.id}`,
        project.id,
        revisionId,
        OWNER["x-shiplet-user-id"],
        JSON.stringify({ feedbackId: feedback.id, value: "Done" }),
        "legacy-digest",
        requestId,
        pageUrl,
        new Date(Date.now() - 1_000).toISOString(),
        now,
        now,
        now,
      )
      .run();

    const outcome = await request(
      `/${project.subdomain}/__shiplet/review/operations/${operationQuery({
        requestId,
        revisionId,
        pageUrl,
        effect: "feedback.status",
        feedbackId: feedback.id,
      })}`,
      { headers: OWNER },
    );
    expect(outcome.status).toBe(200);
    expect(await outcome.json()).toEqual({
      operation: {
        requestId,
        effect: "feedback.status",
        state: "unknown",
        result: null,
      },
    });
  });

  it("rolls back an injected effect-batch failure and retries the same stable IDs once", async () => {
    const { project, feedback, pageUrl, revisionId } = await fixture();
    const realDb = (env as Env).DB;
    const [projectRow, actor] = await Promise.all([
      realDb.prepare("SELECT * FROM projects WHERE id = ?")
        .bind(project.id)
        .first<Project>(),
      realDb.prepare("SELECT * FROM users WHERE id = ?")
        .bind(OWNER["x-shiplet-user-id"])
        .first<ShipletUser>(),
    ]);
    expect(projectRow).toBeTruthy();
    expect(actor).toBeTruthy();
    if (!projectRow || !actor) return;
    const payloadJson = JSON.stringify({
      feedbackId: feedback.id,
      value: "Retry after atomic failure",
      mentions: [],
    });
    const operation = await prepareReviewOperation(realDb, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: actor.id,
      effect: "feedback.reply",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId: `request_${crypto.randomUUID()}`,
      pageUrl,
      feedbackId: feedback.id,
    });
    const failingDb = {
      prepare: realDb.prepare.bind(realDb),
      async batch(statements: D1PreparedStatement[]) {
        return realDb.batch([
          ...statements,
          realDb.prepare(
            "SELECT json_extract('forced_effect_batch_failure', '$.invalid')",
          ),
        ]);
      },
    } as unknown as D1Database;
    expect(
      await completeDurableThreadOperation(
        { ...(env as Env), DB: failingDb },
        {
          operation,
          project: projectRow,
          actor,
          feedbackId: feedback.id,
          value: "Retry after atomic failure",
        },
      ),
    ).toBeNull();
    expect(
      await realDb.prepare(
        "SELECT completed_on FROM embed_review_operation_intents WHERE id = ?",
      )
        .bind(operation.id)
        .first(),
    ).toEqual({ completed_on: null });
    expect(
      (
        await realDb.prepare(
          "SELECT COUNT(*) AS count FROM review_feedback_replies WHERE id = ?",
        )
          .bind(operation.result_reply_id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);

    const completed = await completeDurableThreadOperation(env as Env, {
      operation,
      project: projectRow,
      actor,
      feedbackId: feedback.id,
      value: "Retry after atomic failure",
    });
    expect(completed).toMatchObject({
      feedbackId: feedback.id,
      replyId: operation.result_reply_id,
      eventId: operation.result_event_id,
    });
    expect(
      (
        await realDb.prepare(
          "SELECT COUNT(*) AS count FROM review_feedback_replies WHERE id = ?",
        )
          .bind(operation.result_reply_id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it("atomically rejects mention membership removed after planning but before commit", async () => {
    const { organization, project, feedback, pageUrl, revisionId } = await fixture();
    const member = {
      "x-shiplet-user-id": `user_membership_race_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `membership-race-${crypto.randomUUID()}@example.com`,
    };
    expect(
      (
        await request("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...member },
          body: JSON.stringify({ name: `Membership race ${crypto.randomUUID()}` }),
        })
      ).status,
    ).toBe(201);
    const membershipId = `membership_${crypto.randomUUID()}`;
    await (env as Env).DB.prepare(
      `INSERT INTO organization_memberships
       (id, organization_id, user_id, role, created_on)
       VALUES (?, ?, ?, 'member', ?)`,
    )
      .bind(
        membershipId,
        organization.id,
        member["x-shiplet-user-id"],
        new Date().toISOString(),
      )
      .run();
    const realDb = (env as Env).DB;
    const [projectRow, actor] = await Promise.all([
      realDb.prepare("SELECT * FROM projects WHERE id = ?")
        .bind(project.id)
        .first<Project>(),
      realDb.prepare("SELECT * FROM users WHERE id = ?")
        .bind(OWNER["x-shiplet-user-id"])
        .first<ShipletUser>(),
    ]);
    expect(projectRow).toBeTruthy();
    expect(actor).toBeTruthy();
    if (!projectRow || !actor) return;
    const requestId = `request_${crypto.randomUUID()}`;
    const mentions = [{ userId: member["x-shiplet-user-id"] }];
    const payloadJson = JSON.stringify({
      feedbackId: feedback.id,
      value: "Membership race reply",
      mentions,
    });
    const operation = await prepareReviewOperation(realDb, {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: actor.id,
      effect: "feedback.reply",
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId,
      pageUrl,
      feedbackId: feedback.id,
    });
    let intercepted = false;
    const racingDb = {
      prepare: realDb.prepare.bind(realDb),
      async batch(statements: D1PreparedStatement[]) {
        intercepted = true;
        await realDb.prepare(
          "DELETE FROM organization_memberships WHERE id = ?",
        )
          .bind(membershipId)
          .run();
        return realDb.batch(statements);
      },
    } as unknown as D1Database;
    expect(
      await completeDurableThreadOperation(
        { ...(env as Env), DB: racingDb },
        {
          operation,
          project: projectRow,
          actor,
          feedbackId: feedback.id,
          value: "Membership race reply",
          mentions,
        },
      ),
    ).toBeNull();
    expect(intercepted).toBe(true);
    expect(
      await realDb.prepare(
        `SELECT
         (SELECT COUNT(*) FROM review_feedback_replies WHERE id = ?) AS replies,
         (SELECT COUNT(*) FROM shiplet_events WHERE id = ?) AS events,
         (SELECT COUNT(*) FROM shiplet_audit_events
          WHERE json_extract(payload_json, '$.requestId') = ?) AS audits,
         (SELECT COUNT(*) FROM review_feedback_mentions WHERE reply_id = ?) AS mentions,
         (SELECT COUNT(*) FROM shiplet_access_grants
          WHERE project_id = ? AND target_id = ?) AS grants,
         (SELECT COUNT(*) FROM review_notifications WHERE dedupe_key = ?) AS notifications`,
      )
        .bind(
          operation.result_reply_id,
          operation.result_event_id,
          requestId,
          operation.result_reply_id,
          project.id,
          member["x-shiplet-user-id"],
          `operation:${operation.id}:mention:${member["x-shiplet-user-id"]}`,
        )
        .first(),
    ).toEqual({
      replies: 0,
      events: 0,
      audits: 0,
      mentions: 0,
      grants: 0,
      notifications: 0,
    });
    expect(
      await realDb.prepare(
        "SELECT confirmed_on, completed_on FROM embed_review_operation_intents WHERE id = ?",
      )
        .bind(operation.id)
        .first(),
    ).toEqual({ confirmed_on: null, completed_on: null });
  });

  it("deduplicates a status replay while preserving a later distinct notification intent", async () => {
    const { organization, project, feedback } = await fixture();
    const watcher = {
      "x-shiplet-user-id": `user_operation_watcher_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `operation-watcher-${crypto.randomUUID()}@example.com`,
    };
    expect(
      (
        await request("/api/organizations", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...watcher },
          body: JSON.stringify({ name: `Watcher ${crypto.randomUUID()}` }),
        })
      ).status,
    ).toBe(201);
    const now = new Date().toISOString();
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO organization_memberships
         (id, organization_id, user_id, role, created_on)
         VALUES (?, ?, ?, 'member', ?)`,
      ).bind(
        `membership_${crypto.randomUUID()}`,
        organization.id,
        watcher["x-shiplet-user-id"],
        now,
      ),
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_watch_subscriptions
         (project_id, user_id, status, created_by_user_id, created_on, updated_on)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      ).bind(
        project.id,
        watcher["x-shiplet-user-id"],
        watcher["x-shiplet-user-id"],
        now,
        now,
      ),
    ]);
    const mutate = (status: string, requestId: string) =>
      request(
        `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...OWNER },
          body: JSON.stringify({ status, requestId }),
        },
      );
    const firstRequestId = `request_${crypto.randomUUID()}`;
    expect((await mutate("In Progress", firstRequestId)).status).toBe(200);
    expect((await mutate("In Progress", firstRequestId)).status).toBe(200);
    expect(
      (await mutate("Done", `request_${crypto.randomUUID()}`)).status,
    ).toBe(200);
    const notifications = await (env as Env).DB.prepare(
      `SELECT dedupe_key FROM review_notifications
       WHERE project_id = ? AND feedback_id = ? AND recipient_user_id = ?
         AND reason = 'status_changed' ORDER BY created_on`,
    )
      .bind(project.id, feedback.id, watcher["x-shiplet-user-id"])
      .all<{ dedupe_key: string }>();
    expect(notifications.results).toHaveLength(2);
    expect(new Set(notifications.results.map((row) => row.dedupe_key)).size).toBe(2);
    expect(
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM shiplet_events
           WHERE project_id = ? AND event_kind = 'review.status-changed'
             AND json_extract(custom_payload_json, '$.feedbackId') = ?`,
        )
          .bind(project.id, feedback.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(2);
  });

  it("renews only an exact unconfirmed expiry and hides mismatched outcome bindings", async () => {
    const { project, feedback, pageUrl, revisionId } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const payloadJson = JSON.stringify({
      feedbackId: feedback.id,
      value: "Renew exact operation",
      mentions: [],
    });
    const base = {
      installationId: `managed:${project.id}`,
      projectId: project.id,
      revisionId,
      actorUserId: OWNER["x-shiplet-user-id"],
      effect: "feedback.reply" as const,
      payloadJson,
      payloadDigest: await digestReviewOperationPayload(payloadJson),
      requestId,
      pageUrl,
      feedbackId: feedback.id,
    };
    const expired = await prepareReviewOperation((env as Env).DB, {
      ...base,
      expiresOn: new Date(Date.now() - 1_000).toISOString(),
    });
    const renewed = await prepareReviewOperation((env as Env).DB, base);
    expect(renewed.id).toBe(expired.id);
    expect(Date.parse(renewed.expires_on)).toBeGreaterThan(Date.now());

    const pendingWithoutTarget = await request(
      `/${project.subdomain}/__shiplet/review/operations/${requestId}?${new URLSearchParams({
        revision_id: revisionId,
        page_url: pageUrl,
        effect: "feedback.reply",
      })}`,
      { headers: OWNER },
    );
    expect(pendingWithoutTarget.status).toBe(404);
    expect(pendingWithoutTarget.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    const pendingExact = await request(
      `/${project.subdomain}/__shiplet/review/operations/${operationQuery({
        requestId,
        revisionId,
        pageUrl,
        effect: "feedback.reply",
        feedbackId: feedback.id,
      })}`,
      { headers: OWNER },
    );
    expect(pendingExact.status).toBe(200);
    expect(await pendingExact.json()).toMatchObject({
      operation: { requestId, state: "pending", result: null },
    });

    const wrongPage = await request(
      `/${project.subdomain}/__shiplet/review/operations/${operationQuery({
        requestId,
        revisionId,
        pageUrl: `${pageUrl}/wrong`,
        effect: "feedback.reply",
        feedbackId: feedback.id,
      })}`,
      { headers: OWNER },
    );
    expect(wrongPage.status).toBe(404);
    const wrongEffect = await request(
      `/${project.subdomain}/__shiplet/review/operations/${operationQuery({
        requestId,
        revisionId,
        pageUrl,
        effect: "feedback.status",
        feedbackId: feedback.id,
      })}`,
      { headers: OWNER },
    );
    expect(wrongEffect.status).toBe(404);
  });

  it("rejects invalid durable thread values before consuming their request IDs", async () => {
    const { project, feedback, pageUrl, revisionId } = await fixture();
    const countOperations = async (requestId: string) =>
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM embed_review_operation_intents WHERE request_id = ?",
        )
          .bind(requestId)
          .first<{ count: number }>()
      )?.count;

    const statusRequestId = `request_${crypto.randomUUID()}`;
    const invalidStatus = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          status: "Not a real status",
          requestId: statusRequestId,
        }),
      },
    );
    expect(invalidStatus.status).toBe(400);
    expect(await invalidStatus.text()).toBe("Status is not supported.");
    expect(await countOperations(statusRequestId)).toBe(0);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT status FROM review_feedback WHERE id = ? AND project_id = ?",
        )
          .bind(feedback.id, project.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("New");
    const validStatus = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ status: "Staging", requestId: statusRequestId }),
      },
    );
    expect(validStatus.status).toBe(200);
    expect(await countOperations(statusRequestId)).toBe(1);
    const statusQuery = new URLSearchParams({
      revision_id: revisionId,
      page_url: pageUrl,
      effect: "feedback.status",
    });
    const statusWithoutTarget = await request(
      `/${project.subdomain}/__shiplet/review/operations/${statusRequestId}?${statusQuery}`,
      { headers: OWNER },
    );
    expect(statusWithoutTarget.status).toBe(404);
    expect(statusWithoutTarget.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    statusQuery.set("feedback_id", feedback.id);
    expect(
      (
        await request(
          `/${project.subdomain}/__shiplet/review/operations/${statusRequestId}?${statusQuery}`,
          { headers: OWNER },
        )
      ).status,
    ).toBe(200);

    const replyRequestId = `request_${crypto.randomUUID()}`;
    const blankReply = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ comment: "   ", requestId: replyRequestId }),
      },
    );
    expect(blankReply.status).toBe(400);
    expect(await blankReply.text()).toBe("Comment is required.");
    expect(await countOperations(replyRequestId)).toBe(0);
    const validReply = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          comment: "Valid after rejection",
          requestId: replyRequestId,
        }),
      },
    );
    expect(validReply.status).toBe(201);
    expect(await countOperations(replyRequestId)).toBe(1);
    expect(
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM review_feedback_replies
           WHERE feedback_id = ? AND comment = 'Valid after rejection'`,
        )
          .bind(feedback.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const tenantStatusId = `request_${crypto.randomUUID()}`;
    const tenantStatus = await request(
      `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          ...OWNER,
        },
        body: JSON.stringify({
          status: "Unsupported",
          requestId: tenantStatusId,
        }),
      },
    );
    expect(tenantStatus.status).toBe(400);
    expect(await tenantStatus.text()).toBe("Status is not supported.");
    expect(await countOperations(tenantStatusId)).toBe(0);

    const tenantReplyId = `request_${crypto.randomUUID()}`;
    const tenantBlank = await request(
      `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          ...OWNER,
        },
        body: JSON.stringify({ comment: "  ", requestId: tenantReplyId }),
      },
    );
    expect(tenantBlank.status).toBe(400);
    expect(await tenantBlank.text()).toBe("Comment is required.");
    expect(await countOperations(tenantReplyId)).toBe(0);
    expect(
      (
        await request(
          `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/replies`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              ...OWNER,
            },
            body: JSON.stringify({
              comment: "Tenant retry succeeds",
              requestId: tenantReplyId,
            }),
          },
        )
      ).status,
    ).toBe(201);
    expect(await countOperations(tenantReplyId)).toBe(1);
  });

  it("distinguishes absent legacy request IDs from explicitly malformed IDs", async () => {
    const { project, feedback, pageUrl } = await fixture();
    const generalReply = `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`;
    const tenantReply = `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/replies`;
    for (const [route, label] of [
      [generalReply, "general"],
      [tenantReply, "tenant"],
    ] as const) {
      for (const requestId of ["", "   ", 123, "x".repeat(257)]) {
        const response = await request(route, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
            ...OWNER,
          },
          body: JSON.stringify({
            comment: `${label} malformed ID`,
            requestId,
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Invalid review operation request ID");
      }
      expect(
        (
          await request(route, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              ...OWNER,
            },
            body: JSON.stringify({ comment: `${label} legacy absent ID` }),
          })
        ).status,
      ).toBe(201);
    }

    for (const route of [
      `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
      `/${project.subdomain}/__shiplet/review/feedback/${feedback.id}/status`,
    ]) {
      expect(
        (
          await request(route, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              ...OWNER,
            },
            body: JSON.stringify({ status: "Done", requestId: " " }),
          })
        ).status,
      ).toBe(400);
    }

    for (const route of [
      `/api/projects/${project.id}/review-feedback`,
      `/${project.subdomain}/__shiplet/review/feedback`,
    ]) {
      const clientFeedbackId = `client-${crypto.randomUUID()}`;
      expect(
        (
          await request(route, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://localhost",
              ...OWNER,
            },
            body: JSON.stringify({
              comment: "Malformed create ID",
              pageUrl,
              clientFeedbackId,
              requestId: null,
            }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await (env as Env).DB.prepare(
            "SELECT COUNT(*) AS count FROM review_feedback WHERE client_feedback_id = ?",
          )
            .bind(clientFeedbackId)
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
    }
  });

  it("normalizes durable replies and requires exact targets for outcome reads", async () => {
    const { project, feedback, pageUrl, revisionId } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const normalized = "x".repeat(5_000);
    const first = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          comment: `   ${normalized}discarded   `,
          requestId,
        }),
      },
    );
    expect(first.status).toBe(201);
    expect(
      await (env as Env).DB.prepare(
        `SELECT comment FROM review_feedback_replies
         WHERE project_id = ? AND feedback_id = ?`,
      )
        .bind(project.id, feedback.id)
        .first<{ comment: string }>(),
    ).toEqual({ comment: normalized });
    const equivalentReplay = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ comment: `${normalized}different-tail`, requestId }),
      },
    );
    expect(equivalentReplay.status).toBe(201);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM review_feedback_replies WHERE feedback_id = ?",
        )
          .bind(feedback.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const changedNormalizedText = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({ comment: `y${normalized.slice(1)}`, requestId }),
      },
    );
    expect(changedNormalizedText.status).toBe(409);

    const query = new URLSearchParams({
      revision_id: revisionId,
      page_url: pageUrl,
      effect: "feedback.reply",
    });
    for (const feedbackId of [null, "", `review_${crypto.randomUUID()}`]) {
      const candidate = new URLSearchParams(query);
      if (feedbackId !== null) candidate.set("feedback_id", feedbackId);
      const response = await request(
        `/${project.subdomain}/__shiplet/review/operations/${requestId}?${candidate}`,
        { headers: OWNER },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        error: "review_operation_not_found",
      });
    }
    const exact = new URLSearchParams(query);
    exact.set("feedback_id", feedback.id);
    expect(
      (
        await request(
          `/${project.subdomain}/__shiplet/review/operations/${requestId}?${exact}`,
          { headers: OWNER },
        )
      ).status,
    ).toBe(200);
  });

  it("uses current operation revision for historical and null-provenance targets", async () => {
    const { project, feedback, revisionId: createdRevision } = await fixture();
    const currentRevision = `revision_${crypto.randomUUID()}`;
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_revisions (
         id, project_id, parent_revision_id, package_json, package_digest,
         content_digest, runtime_compatibility, validation_report_json,
         custom_mcp_projection_json, created_by_actor_kind, created_by_actor_id,
         created_on
        ) SELECT ?, project_id, id, package_json, ?, content_digest,
                 runtime_compatibility, validation_report_json,
                 custom_mcp_projection_json, 'human', ?, ?
          FROM shiplet_revisions WHERE id = ?`,
      ).bind(
        currentRevision,
        `digest-${crypto.randomUUID()}`,
        OWNER["x-shiplet-user-id"],
        new Date().toISOString(),
        createdRevision,
      ),
      (env as Env).DB.prepare(
        "UPDATE projects SET active_revision_id = ? WHERE id = ?",
      ).bind(currentRevision, project.id),
    ]);
    const active = await (env as Env).DB.prepare(
      "SELECT active_revision_id FROM projects WHERE id = ?",
    )
      .bind(project.id)
      .first<{ active_revision_id: string }>();
    expect(active?.active_revision_id).toBe(currentRevision);

    const historicalReply = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          comment: "Reply on historical feedback",
          requestId: `request_${crypto.randomUUID()}`,
        }),
      },
    );
    expect(historicalReply.status).toBe(201);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT revision_id FROM review_feedback WHERE id = ?",
        )
          .bind(feedback.id)
          .first<{ revision_id: string | null }>()
      )?.revision_id,
    ).toBe(createdRevision);

    await (env as Env).DB.prepare(
      "UPDATE review_feedback SET revision_id = NULL WHERE id = ?",
    )
      .bind(feedback.id)
      .run();
    const nullProvenanceStatus = await request(
      `/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          status: "Done",
          requestId: `request_${crypto.randomUUID()}`,
        }),
      },
    );
    expect(nullProvenanceStatus.status).toBe(200);
    expect(
      await (env as Env).DB.prepare(
        "SELECT revision_id, status FROM review_feedback WHERE id = ?",
      )
        .bind(feedback.id)
        .first(),
    ).toEqual({ revision_id: null, status: "Done" });

    const other = await fixture();
    expect(
      (
        await request(
          `/api/projects/${project.id}/review-feedback/${other.feedback.id}/status`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...OWNER },
            body: JSON.stringify({
              status: "Done",
              requestId: `request_${crypto.randomUUID()}`,
            }),
          },
        )
      ).status,
    ).toBe(404);
  });

  it("rejects every unauthorized durable mention before prepare and accepts an organization member", async () => {
    const { organization, project, feedback, pageUrl } = await fixture();
    const outsider = {
      "x-shiplet-user-id": `user_durable_outsider_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `durable-outsider-${crypto.randomUUID()}@example.com`,
    };
    const member = {
      "x-shiplet-user-id": `user_durable_member_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `durable-member-${crypto.randomUUID()}@example.com`,
    };
    for (const user of [outsider, member]) {
      expect(
        (
          await request("/api/organizations", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...user },
            body: JSON.stringify({ name: `Mention identity ${crypto.randomUUID()}` }),
          })
        ).status,
      ).toBe(201);
    }
    await (env as Env).DB.prepare(
      `INSERT INTO organization_memberships
       (id, organization_id, user_id, role, created_on)
       VALUES (?, ?, ?, 'member', ?)`,
    )
      .bind(
        `membership_${crypto.randomUUID()}`,
        organization.id,
        member["x-shiplet-user-id"],
        new Date().toISOString(),
      )
      .run();

    const createRequestId = `request_${crypto.randomUUID()}`;
    const clientFeedbackId = `client-${crypto.randomUUID()}`;
    const create = (mentions: Array<{ userId: string }>) =>
      request(`/api/projects/${project.id}/review-feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          comment: "Durable mention create",
          pageUrl,
          clientFeedbackId,
          mentions,
          requestId: createRequestId,
        }),
      });
    const foreignCreate = await create([
      { userId: member["x-shiplet-user-id"] },
      { userId: outsider["x-shiplet-user-id"] },
    ]);
    expect(foreignCreate.status).toBe(400);
    expect(await foreignCreate.text()).toBe("Invalid review mentions");
    expect(
      await (env as Env).DB.prepare(
        `SELECT
         (SELECT COUNT(*) FROM embed_review_operation_intents WHERE request_id = ?) AS operations,
         (SELECT COUNT(*) FROM review_feedback WHERE client_feedback_id = ?) AS feedback`,
      )
        .bind(createRequestId, clientFeedbackId)
        .first(),
    ).toEqual({ operations: 0, feedback: 0 });
    expect((await create([{ userId: member["x-shiplet-user-id"] }])).status).toBe(201);
    expect(
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM review_feedback_mentions
           WHERE mentioned_user_id = ? AND feedback_id IN (
             SELECT id FROM review_feedback WHERE client_feedback_id = ?
           )`,
        )
          .bind(member["x-shiplet-user-id"], clientFeedbackId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const replyRequestId = `request_${crypto.randomUUID()}`;
    const reply = (mentions: Array<{ userId: string }>) =>
      request(
        `/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...OWNER },
          body: JSON.stringify({
            comment: "Durable mention reply",
            mentions,
            requestId: replyRequestId,
          }),
        },
      );
    expect(
      (
        await reply([
          { userId: member["x-shiplet-user-id"] },
          { userId: outsider["x-shiplet-user-id"] },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM embed_review_operation_intents WHERE request_id = ?",
        )
          .bind(replyRequestId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect((await reply([{ userId: member["x-shiplet-user-id"] }])).status).toBe(201);
    expect(
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM review_feedback_mentions
           WHERE feedback_id = ? AND mentioned_user_id = ? AND reply_id IS NOT NULL`,
        )
          .bind(feedback.id, member["x-shiplet-user-id"])
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      await (env as Env).DB.prepare(
        `SELECT
         (SELECT COUNT(*) FROM shiplet_access_grants
          WHERE project_id = ? AND target_type = 'user' AND target_id = ?) AS grants,
         (SELECT COUNT(*) FROM review_notifications
          WHERE project_id = ? AND recipient_user_id = ? AND type = 'mention') AS notifications`,
      )
        .bind(
          project.id,
          member["x-shiplet-user-id"],
          project.id,
          member["x-shiplet-user-id"],
        )
        .first(),
    ).toEqual({ grants: 1, notifications: 2 });
  });
});
