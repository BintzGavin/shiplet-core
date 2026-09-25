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
  return {
    organization,
    project,
    user,
    installationId,
    pageUrl,
    cookie,
    revisionId: activeRevision.active_revision_id,
  };
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
    expect(intentHtml).toContain('data-shiplet-access-page="v1"');
    const styleNonce = intentHtml.match(/<style nonce="([^"]+)">/)?.[1];
    expect(styleNonce).toBeTruthy();
    expect(intentResponse.headers.get("content-security-policy")).toContain(`style-src 'nonce-${styleNonce}'`);
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
    expect(completedHtml).toContain('data-shiplet-access-page="v1"');
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
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('data-shiplet-confirmation="complete"');
    const saved = await (env as Env).DB.prepare(
      "SELECT id FROM review_feedback WHERE project_id = ? AND client_feedback_id = ?",
    )
      .bind(project.id, clientFeedbackId)
      .first<{ id: string }>();
    const revision = await (env as Env).DB.prepare(
      "SELECT active_revision_id FROM projects WHERE id = ?",
    )
      .bind(project.id)
      .first<{ active_revision_id: string }>();
    const threadForm = {
      installation_id: installationId,
      shiplet_id: project.id,
      revision_id: revision!.active_revision_id,
      page_url: pageUrl,
      feedback_id: saved!.id,
      action: "replies",
      value: "A shared reply",
    };
    const prepare = (fields = {}, origin = "http://localhost") =>
      request("/embed/review/thread", {
        method: "POST",
        headers: { ...OWNER, Origin: origin },
        body: new URLSearchParams({ ...threadForm, ...fields }),
      });
    expect((await prepare({}, "https://attacker.example")).status).toBe(403);
    expect((await prepare({ page_url: pageUrl + "wrong" })).status).toBe(403);
    expect((await prepare({ action: "status", value: "invalid" })).status).toBe(
      400,
    );
    const stagingIntent = await prepare({ action: "status", value: "Staging" });
    expect(stagingIntent.status).toBe(200);
    const stagingIntentId = (await stagingIntent.text()).match(
      /name="intent_id" value="([^"]+)"/,
    )![1];
    const stagingOutsider = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        "x-shiplet-user-id": "user_embed_confirmation_outsider",
        "x-shiplet-user-email": "embed-confirmation-outsider@example.com",
      },
      body: new URLSearchParams({
        intent_id: stagingIntentId,
        approval: "confirm",
      }),
    });
    expect(stagingOutsider.status).toBe(403);
    const stagingComplete = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: { ...OWNER, Origin: "http://localhost" },
      body: new URLSearchParams({
        intent_id: stagingIntentId,
        approval: "confirm",
      }),
    });
    expect(stagingComplete.status).toBe(200);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT status FROM review_feedback WHERE id = ? AND project_id = ?",
        )
          .bind(saved!.id, project.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe("Staging");
    const replyRequestId = `request_${crypto.randomUUID()}`;
    const replyIntent = await prepare({
      request_id: replyRequestId,
      mentions_json: JSON.stringify([{ userId: user.id }]),
    });
    expect(replyIntent.status).toBe(200);
    const replyIntentId = (await replyIntent.text()).match(
      /name="intent_id" value="([^"]+)"/,
    )![1];
    const confirmReply = () =>
      request("/embed/review/confirm/complete", {
        method: "POST",
        headers: { ...OWNER, Origin: "http://localhost" },
        body: new URLSearchParams({
          intent_id: replyIntentId,
          approval: "confirm",
        }),
      });
    expect((await confirmReply()).status).toBe(200);
    expect((await confirmReply()).status).toBe(200);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM review_feedback_replies WHERE feedback_id = ?",
        )
          .bind(saved!.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await (env as Env).DB.prepare(
          `SELECT COUNT(*) AS count FROM review_feedback_mentions
           WHERE feedback_id = ? AND mentioned_user_id = ?`,
        )
          .bind(saved!.id, user.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    const replyOutcome = await request(
      `/embed/review/operations/${replyRequestId}?${new URLSearchParams({
        installation_id: installationId,
        page_url: pageUrl,
        effect: "feedback.reply",
        feedback_id: saved!.id,
      })}`,
      { headers: { Cookie: cookie } },
    );
    expect(replyOutcome.status).toBe(200);
    expect(await replyOutcome.json()).toMatchObject({
      operation: {
        requestId: replyRequestId,
        effect: "feedback.reply",
        state: "completed",
        result: { feedbackId: saved!.id, replyId: expect.any(String) },
      },
    });
    const revokedIntent = await prepare({ action: "status", value: "Done" });
    const revokedId = (await revokedIntent.text()).match(
      /name="intent_id" value="([^"]+)"/,
    )![1];
    await (env as Env).DB.prepare(
      "UPDATE embed_installations SET revoked_on = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), installationId)
      .run();
    expect(
      (
        await request("/embed/review/confirm/complete", {
          method: "POST",
          headers: { ...OWNER, Origin: "http://localhost" },
          body: new URLSearchParams({
            intent_id: revokedId,
            approval: "confirm",
          }),
        })
      ).status,
    ).toBe(403);
  });

  it("confirms a browser install using top-level identity without an iframe cookie", async () => {
    const { installationId, pageUrl, revisionId, project } = await fixture();
    const submit = (overrides = {}, headers = OWNER) =>
      request("/embed/review/confirm", {
        method: "POST",
        headers: { ...headers, Origin: "http://localhost" },
        body: new URLSearchParams({
          installation_id: installationId,
          shiplet_id: project.id,
          revision_id: revisionId,
          page_url: pageUrl,
          request_id: `request_${crypto.randomUUID()}`,
          operation: "feedback.create",
          comment: "Native page feedback",
          client_feedback_id: `client-${crypto.randomUUID()}`,
          ...overrides,
        }),
      });
    expect(
      (await submit({ page_url: "https://attacker.example/" })).status,
    ).toBe(403);
    expect((await submit({ revision_id: "stale" })).status).toBe(409);
    expect((await submit({ shiplet_id: "project_other" })).status).toBe(403);
    expect(
      (
        await submit(
          {},
          {
            "x-shiplet-user-id": "user_outsider",
            "x-shiplet-user-email": "outsider@example.com",
          },
        )
      ).status,
    ).toBe(403);
    const prepared = await submit();
    expect(prepared.status).toBe(200);
    expect(await prepared.text()).toContain("Native page feedback");
    await (env as Env).DB.prepare(
      "UPDATE embed_installations SET revoked_on = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), installationId)
      .run();
    expect((await submit()).status).toBe(403);
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

  it("preflights embedded mentions, rechecks membership, and requires outcome targets", async () => {
    const {
      organization,
      project,
      user,
      installationId,
      pageUrl,
      cookie,
      revisionId,
    } = await fixture();
    const feedbackResponse = await request(
      `/api/projects/${project.id}/review-feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER },
        body: JSON.stringify({
          comment: "Embedded mention target",
          pageUrl,
          clientFeedbackId: `client-${crypto.randomUUID()}`,
        }),
      },
    );
    const { feedback } = (await feedbackResponse.json()) as {
      feedback: { id: string };
    };
    const outsider = {
      "x-shiplet-user-id": `user_embed_outsider_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `embed-outsider-${crypto.randomUUID()}@example.com`,
    };
    const member = {
      "x-shiplet-user-id": `user_embed_member_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `embed-member-${crypto.randomUUID()}@example.com`,
    };
    for (const identity of [outsider, member]) {
      expect(
        (
          await request("/api/organizations", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...identity },
            body: JSON.stringify({ name: `Embed identity ${crypto.randomUUID()}` }),
          })
        ).status,
      ).toBe(201);
    }
    const membershipId = `membership_${crypto.randomUUID()}`;
    const insertMember = () =>
      (env as Env).DB.prepare(
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
    await insertMember();

    const topLevelRequestId = `request_${crypto.randomUUID()}`;
    const topLevel = (mentions: Array<{ userId: string }>) =>
      request("/embed/review/confirm", {
        method: "POST",
        headers: { ...OWNER, Origin: "http://localhost" },
        body: new URLSearchParams({
          installation_id: installationId,
          shiplet_id: project.id,
          revision_id: revisionId,
          page_url: pageUrl,
          request_id: topLevelRequestId,
          operation: "feedback.create",
          comment: "Embedded top-level mention",
          client_feedback_id: `client-${crypto.randomUUID()}`,
          mentions_json: JSON.stringify(mentions),
        }),
      });
    expect(
      (
        await topLevel([
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
          .bind(topLevelRequestId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    const validTopLevel = await topLevel([]);
    expect(validTopLevel.status).toBe(200);
    const validTopLevelId = (await validTopLevel.text()).match(
      /name="intent_id" value="([^"]+)"/,
    )?.[1];
    expect(
      (
        await request("/embed/review/confirm/complete", {
          method: "POST",
          headers: { ...OWNER, Origin: "http://localhost" },
          body: new URLSearchParams({
            intent_id: validTopLevelId || "",
            approval: "confirm",
          }),
        })
      ).status,
    ).toBe(200);

    const threadRequestId = `request_${crypto.randomUUID()}`;
    const thread = (mentions: Array<{ userId: string }>, value = "Embedded reply") =>
      request("/embed/review/thread", {
        method: "POST",
        headers: { ...OWNER, Origin: "http://localhost" },
        body: new URLSearchParams({
          installation_id: installationId,
          shiplet_id: project.id,
          revision_id: revisionId,
          page_url: pageUrl,
          feedback_id: feedback.id,
          action: "replies",
          value,
          request_id: threadRequestId,
          mentions_json: JSON.stringify(mentions),
        }),
      });
    expect(
      (
        await thread([
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
          .bind(threadRequestId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect((await thread([], "x".repeat(5_001))).status).toBe(400);
    expect(
      (
        await (env as Env).DB.prepare(
          "SELECT COUNT(*) AS count FROM embed_review_operation_intents WHERE request_id = ?",
        )
          .bind(threadRequestId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);

    const pending = await thread([{ userId: member["x-shiplet-user-id"] }]);
    expect(pending.status).toBe(200);
    const pendingId = (await pending.text()).match(
      /name="intent_id" value="([^"]+)"/,
    )?.[1];
    expect(pendingId).toMatch(/^embed_intent_/);
    const pendingWithoutTarget = await request(
      `/embed/review/operations/${threadRequestId}?${new URLSearchParams({
        installation_id: installationId,
        page_url: pageUrl,
        effect: "feedback.reply",
      })}`,
      { headers: { Cookie: cookie } },
    );
    expect(pendingWithoutTarget.status).toBe(404);
    expect(pendingWithoutTarget.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    await (env as Env).DB.prepare(
      "DELETE FROM organization_memberships WHERE id = ?",
    )
      .bind(membershipId)
      .run();
    const staleMemberComplete = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: { ...OWNER, Origin: "http://localhost" },
      body: new URLSearchParams({
        intent_id: pendingId || "",
        approval: "confirm",
      }),
    });
    expect(staleMemberComplete.status).toBe(400);
    expect(await staleMemberComplete.text()).toBe("Invalid review mentions");
    expect(
      await (env as Env).DB.prepare(
        `SELECT
         (SELECT COUNT(*) FROM review_feedback_replies WHERE feedback_id = ?) AS replies,
         (SELECT COUNT(*) FROM review_feedback_mentions WHERE feedback_id = ?) AS mentions,
         (SELECT COUNT(*) FROM shiplet_access_grants
          WHERE project_id = ? AND target_id = ?) AS grants,
         (SELECT COUNT(*) FROM review_notifications
          WHERE project_id = ? AND feedback_id = ?) AS notifications`,
      )
        .bind(
          feedback.id,
          feedback.id,
          project.id,
          member["x-shiplet-user-id"],
          project.id,
          feedback.id,
        )
        .first(),
    ).toEqual({ replies: 0, mentions: 0, grants: 0, notifications: 0 });
    expect(
      await (env as Env).DB.prepare(
        "SELECT confirmed_on, completed_on FROM embed_review_operation_intents WHERE id = ?",
      )
        .bind(pendingId)
        .first(),
    ).toEqual({ confirmed_on: null, completed_on: null });

    await insertMember();
    const completed = await request("/embed/review/confirm/complete", {
      method: "POST",
      headers: { ...OWNER, Origin: "http://localhost" },
      body: new URLSearchParams({
        intent_id: pendingId || "",
        approval: "confirm",
      }),
    });
    expect(completed.status).toBe(200);

    const baseQuery = new URLSearchParams({
      installation_id: installationId,
      page_url: pageUrl,
      effect: "feedback.reply",
    });
    for (const feedbackId of [null, "", `review_${crypto.randomUUID()}`]) {
      const query = new URLSearchParams(baseQuery);
      if (feedbackId !== null) query.set("feedback_id", feedbackId);
      const response = await request(
        `/embed/review/operations/${threadRequestId}?${query}`,
        { headers: { Cookie: cookie } },
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({
        error: "review_operation_not_found",
      });
    }
    const exactQuery = new URLSearchParams(baseQuery);
    exactQuery.set("feedback_id", feedback.id);
    expect(
      (
        await request(
          `/embed/review/operations/${threadRequestId}?${exactQuery}`,
          { headers: { Cookie: cookie } },
        )
      ).status,
    ).toBe(200);

    const createOutcome = await request(
      `/embed/review/operations/${topLevelRequestId}?${new URLSearchParams({
        installation_id: installationId,
        page_url: pageUrl,
        effect: "feedback.create",
      })}`,
      { headers: { Cookie: cookie } },
    );
    expect(createOutcome.status).toBe(200);

    const staleRequestId = `request_${crypto.randomUUID()}`;
    const stalePreparation = await request("/embed/review/thread", {
      method: "POST",
      headers: { ...OWNER, Origin: "http://localhost" },
      body: new URLSearchParams({
        installation_id: installationId,
        shiplet_id: project.id,
        revision_id: revisionId,
        page_url: pageUrl,
        feedback_id: feedback.id,
        action: "status",
        value: "Done",
        request_id: staleRequestId,
      }),
    });
    expect(stalePreparation.status).toBe(200);
    const staleIntentId = (await stalePreparation.text()).match(
      /name="intent_id" value="([^"]+)"/,
    )?.[1];
    const nextRevisionId = `revision_${crypto.randomUUID()}`;
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
        nextRevisionId,
        `digest-${crypto.randomUUID()}`,
        OWNER["x-shiplet-user-id"],
        new Date().toISOString(),
        revisionId,
      ),
      (env as Env).DB.prepare(
        "UPDATE projects SET active_revision_id = ? WHERE id = ?",
      ).bind(nextRevisionId, project.id),
    ]);
    expect(
      (
        await request("/embed/review/confirm/complete", {
          method: "POST",
          headers: { ...OWNER, Origin: "http://localhost" },
          body: new URLSearchParams({
            intent_id: staleIntentId || "",
            approval: "confirm",
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      await (env as Env).DB.prepare(
        "SELECT confirmed_on, completed_on FROM embed_review_operation_intents WHERE id = ?",
      )
        .bind(staleIntentId)
        .first(),
    ).toEqual({ confirmed_on: null, completed_on: null });
    expect(user.id).toBe(OWNER["x-shiplet-user-id"]);
  });
});
