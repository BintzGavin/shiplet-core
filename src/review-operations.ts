import type { Env } from "./env";
import type { Project } from "./types";
import {
  getOrganizationMentionUser,
  getShipletParticipation,
  newId,
  timestamps,
  type OrganizationMentionUserRecord,
  type ShipletUser,
} from "./store";
import type { ReviewMentionInput } from "./notifications";

export const REVIEW_OPERATION_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type ReviewOperationEffect =
  | "feedback.create"
  | "feedback.reply"
  | "feedback.status";

export type ReviewOperationRow = {
  id: string;
  installation_id: string;
  project_id: string;
  revision_id: string;
  actor_user_id: string;
  effect: string;
  payload_json: string;
  payload_digest: string;
  request_id: string;
  page_url: string;
  expires_on: string;
  confirmed_on: string | null;
  completed_on: string | null;
  created_on: string;
  result_feedback_id: string | null;
  result_reply_id: string | null;
  result_event_id: string | null;
  failed_on: string | null;
  failure_code: string | null;
};

export type ReviewOperationResult = {
  feedbackId: string;
  replyId?: string;
  eventId: string;
};

export class ReviewOperationConflict extends Error {}

export async function digestReviewOperationPayload(payloadJson: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payloadJson),
  );
  return `sha256:${Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function prepareReviewOperation(
  db: D1Database,
  input: {
    installationId: string;
    projectId: string;
    revisionId: string;
    actorUserId: string;
    effect: ReviewOperationEffect;
    payloadJson: string;
    payloadDigest: string;
    requestId: string;
    pageUrl: string;
    feedbackId?: string | null;
    expiresOn?: string;
    intentPrefix?: "review_intent" | "embed_intent";
  },
) {
  if (!REVIEW_OPERATION_REQUEST_ID.test(input.requestId)) {
    throw new Response("Invalid review operation request ID", { status: 400 });
  }
  const now = timestamps.now();
  const expiresOn =
    input.expiresOn || new Date(Date.parse(now) + 2 * 60_000).toISOString();
  const intentId = `${input.intentPrefix || "review_intent"}_${crypto.randomUUID().replace(/-/g, "")}`;
  const feedbackId = input.feedbackId || newId("review");
  const replyId = input.effect === "feedback.reply" ? newId("reply") : null;
  const eventId = `event_${crypto.randomUUID().replace(/-/g, "")}`;
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO embed_review_operation_intents (
       id, installation_id, project_id, revision_id, actor_user_id,
       effect, payload_json, payload_digest, request_id, page_url,
       expires_on, confirmed_on, completed_on, created_on,
       result_feedback_id, result_reply_id, result_event_id, failed_on, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      intentId,
      input.installationId,
      input.projectId,
      input.revisionId,
      input.actorUserId,
      input.effect,
      input.payloadJson,
      input.payloadDigest,
      input.requestId,
      input.pageUrl,
      expiresOn,
      now,
      feedbackId,
      replyId,
      eventId,
    )
    .run();
  if (inserted.meta.changes === 1) {
    return (await db
      .prepare("SELECT * FROM embed_review_operation_intents WHERE id = ?")
      .bind(intentId)
      .first<ReviewOperationRow>())!;
  }

  const existing = await db
    .prepare(
      `SELECT * FROM embed_review_operation_intents
       WHERE installation_id = ? AND actor_user_id = ? AND request_id = ?`,
    )
    .bind(input.installationId, input.actorUserId, input.requestId)
    .first<ReviewOperationRow>();
  if (
    !existing ||
    existing.project_id !== input.projectId ||
    existing.revision_id !== input.revisionId ||
    existing.effect !== input.effect ||
    existing.page_url !== input.pageUrl ||
    existing.payload_digest !== input.payloadDigest ||
    existing.payload_json !== input.payloadJson ||
    (input.feedbackId && existing.result_feedback_id !== input.feedbackId)
  ) {
    throw new ReviewOperationConflict("Review operation identity conflict");
  }
  if (existing.failure_code === "cancelled_by_user") {
    throw new ReviewOperationConflict("Cancelled review operation identity cannot be reused");
  }
  const renewable =
    Date.parse(existing.expires_on) <= Date.parse(now) &&
    !existing.confirmed_on &&
    !existing.completed_on &&
    !existing.failed_on;
  if (renewable) {
    await db
      .prepare(
        `UPDATE embed_review_operation_intents SET expires_on = ?
         WHERE id = ? AND confirmed_on IS NULL AND completed_on IS NULL
           AND failed_on IS NULL AND expires_on <= ?`,
      )
      .bind(expiresOn, existing.id, now)
      .run();
    existing.expires_on = expiresOn;
  }
  return existing;
}

export function reviewOperationState(row: ReviewOperationRow) {
  if (
    row.completed_on &&
    row.result_feedback_id &&
    row.result_event_id &&
    (row.effect !== "feedback.reply" || row.result_reply_id)
  ) {
    return "completed" as const;
  }
  if (row.failed_on && row.failure_code === "cancelled_by_user") {
    return "cancelled" as const;
  }
  if (row.failed_on && row.failure_code) return "failed" as const;
  if (row.confirmed_on || row.completed_on) return "unknown" as const;
  if (Date.parse(row.expires_on) <= Date.now()) return "expired" as const;
  return "pending" as const;
}

export function publicReviewOperation(row: ReviewOperationRow) {
  const state = reviewOperationState(row);
  return {
    operation: {
      requestId: row.request_id,
      effect: row.effect,
      state,
      result:
        state === "completed"
          ? {
              feedbackId: row.result_feedback_id!,
              ...(row.result_reply_id ? { replyId: row.result_reply_id } : {}),
              eventId: row.result_event_id!,
            }
          : null,
    },
  };
}

export async function findBoundReviewOperation(
  db: D1Database,
  input: {
    installationId: string;
    projectId: string;
    revisionId: string;
    actorUserId: string;
    requestId: string;
    pageUrl: string;
    effect: string;
    feedbackId?: string | null;
  },
) {
  if (!REVIEW_OPERATION_REQUEST_ID.test(input.requestId)) return null;
  const feedbackId = input.feedbackId?.trim() || null;
  if (
    (input.effect === "feedback.reply" || input.effect === "feedback.status") &&
    !feedbackId
  ) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT * FROM embed_review_operation_intents
       WHERE installation_id = ? AND project_id = ? AND revision_id = ?
         AND actor_user_id = ? AND request_id = ? AND page_url = ? AND effect = ?
       LIMIT 1`,
    )
    .bind(
      input.installationId,
      input.projectId,
      input.revisionId,
      input.actorUserId,
      input.requestId,
      input.pageUrl,
      input.effect,
    )
    .first<ReviewOperationRow>();
  if (!row) return null;
  if (feedbackId && row.result_feedback_id !== feedbackId) {
    let legacyTarget = "";
    try {
      const payload = JSON.parse(row.payload_json) as { feedbackId?: unknown };
      legacyTarget = typeof payload.feedbackId === "string" ? payload.feedbackId : "";
    } catch {
      legacyTarget = "";
    }
    if (legacyTarget !== feedbackId) return null;
  }
  return row;
}

export async function cancelReviewOperation(
  db: D1Database,
  input: {
    installationId: string;
    projectId: string;
    revisionId: string;
    actorUserId: string;
    requestId: string;
    pageUrl: string;
    effect: string;
    feedbackId?: string | null;
  },
) {
  const operation = await findBoundReviewOperation(db, input);
  if (!operation) return null;
  const now = timestamps.now();
  const target = input.feedbackId?.trim() || null;
  const cancelled = await db
    .prepare(
      `UPDATE embed_review_operation_intents
       SET failed_on = ?, failure_code = 'cancelled_by_user'
       WHERE id = ? AND installation_id = ? AND project_id = ? AND revision_id = ?
         AND actor_user_id = ? AND request_id = ? AND page_url = ? AND effect = ?
         AND (? IS NULL OR result_feedback_id = ? OR json_extract(payload_json, '$.feedbackId') = ?)
         AND confirmed_on IS NULL AND completed_on IS NULL AND failed_on IS NULL
         AND EXISTS (
           SELECT 1 FROM projects project
           WHERE project.id = ? AND project.active_revision_id = ?
             AND project.archived_on IS NULL
             AND (
               project.visibility IN ('public', 'unlisted')
               OR project.owner_user_id = ?
               OR EXISTS (
                 SELECT 1 FROM organization_memberships membership
                 WHERE membership.organization_id = project.organization_id
                   AND membership.user_id = ?
                   AND (project.visibility = 'organization' OR lower(membership.role) IN ('admin', 'owner'))
               )
               OR EXISTS (
                 SELECT 1 FROM shiplet_access_grants direct_grant
                 WHERE direct_grant.project_id = project.id
                   AND direct_grant.target_type = 'user' AND direct_grant.target_id = ?
               )
               OR EXISTS (
                 SELECT 1 FROM shiplet_access_grants org_grant
                 JOIN organization_memberships membership
                   ON membership.organization_id = org_grant.target_id
                 WHERE org_grant.project_id = project.id
                   AND org_grant.target_type = 'organization'
                   AND membership.user_id = ?
               )
               OR EXISTS (
                 SELECT 1 FROM shiplet_access_grants team_grant
                 JOIN team_memberships membership ON membership.team_id = team_grant.target_id
                 WHERE team_grant.project_id = project.id
                   AND team_grant.target_type = 'team' AND membership.user_id = ?
               )
             )
         )
         AND (? LIKE 'managed:%' OR EXISTS (
           SELECT 1 FROM embed_installations installation
           WHERE installation.id = ? AND installation.project_id = ?
             AND installation.revoked_on IS NULL
         ))`,
    )
    .bind(
      now,
      operation.id,
      input.installationId,
      input.projectId,
      input.revisionId,
      input.actorUserId,
      input.requestId,
      input.pageUrl,
      input.effect,
      target,
      target,
      target,
      input.projectId,
      input.revisionId,
      input.actorUserId,
      input.actorUserId,
      input.actorUserId,
      input.actorUserId,
      input.actorUserId,
      input.installationId,
      input.installationId,
      input.projectId,
    )
    .run();
  const current = await db
    .prepare("SELECT * FROM embed_review_operation_intents WHERE id = ?")
    .bind(operation.id)
    .first<ReviewOperationRow>();
  return {
    row: current || operation,
    cancelled: cancelled.meta.changes === 1 || reviewOperationState(current || operation) === "cancelled",
  };
}

type PlannedMention = {
  userId: string;
  email: string;
  name: string | null;
  grantId: string | null;
  accessStatus: "active" | "invited";
};

async function resolveDurableReviewMentionMembers(
  db: D1Database,
  project: Project,
  mentions: ReviewMentionInput[],
) {
  if (mentions.length === 0) return [];
  if (!project.organization_id) {
    throw new Response("Invalid review mentions", { status: 400 });
  }
  const members: OrganizationMentionUserRecord[] = [];
  for (const mention of mentions) {
    const member = await getOrganizationMentionUser(
      db,
      project.organization_id,
      mention,
    );
    if (!member) {
      throw new Response("Invalid review mentions", { status: 400 });
    }
    if (!members.some((item) => item.id === member.id)) members.push(member);
  }
  return members;
}

export async function requireDurableReviewMentionRecipients(
  db: D1Database,
  project: Project,
  mentions: ReviewMentionInput[],
) {
  await resolveDurableReviewMentionMembers(db, project, mentions);
}

async function planMentions(
  env: Env,
  project: Project,
  actor: ShipletUser,
  mentions: ReviewMentionInput[],
) {
  const planned: PlannedMention[] = [];
  const members = await resolveDurableReviewMentionMembers(
    env.DB,
    project,
    mentions,
  );
  for (const member of members) {
    const participation = await getShipletParticipation(env.DB, project, member);
    planned.push({
      userId: member.id,
      email: member.email,
      name: [member.first_name, member.last_name].filter(Boolean).join(" ") || null,
      grantId: participation.grant_id || (participation.status === "none" ? newId("grant") : null),
      accessStatus: participation.status === "active" ? "active" : "invited",
    });
  }
  return planned;
}

async function planWatchers(
  db: D1Database,
  project: Project,
  actorUserId: string,
) {
  const rows = await db
    .prepare(
      `SELECT users.id, users.email
       FROM shiplet_watch_subscriptions
       JOIN users ON users.id = shiplet_watch_subscriptions.user_id
       WHERE shiplet_watch_subscriptions.project_id = ?
         AND shiplet_watch_subscriptions.status = 'active'`,
    )
    .bind(project.id)
    .all<{ id: string; email: string }>();
  const watchers = new Map((rows.results || []).map((row) => [row.id, row]));
  if (project.owner_user_id && project.owner_user_id !== actorUserId) {
    const owner = await db
      .prepare(
        `SELECT users.id, users.email FROM users
         WHERE users.id = ? AND NOT EXISTS (
           SELECT 1 FROM shiplet_watch_subscriptions
           WHERE project_id = ? AND user_id = users.id AND status = 'muted'
         )`,
      )
      .bind(project.owner_user_id, project.id)
      .first<{ id: string; email: string }>();
    if (owner) watchers.set(owner.id, owner);
  }
  watchers.delete(actorUserId);
  return Array.from(watchers.values());
}

function durableMentionMembershipFenceStatement(
  db: D1Database,
  project: Project,
  mentions: PlannedMention[],
) {
  if (!project.organization_id || mentions.length === 0) return null;
  const userIds = mentions.map((mention) => mention.userId);
  return db
    .prepare(
      `SELECT CASE WHEN (
         SELECT COUNT(DISTINCT user_id) FROM organization_memberships
         WHERE organization_id = ? AND user_id IN (${userIds.map(() => "?").join(",")})
       ) = ? THEN 1
       ELSE json_extract('review_mention_authority_changed', '$.invalid') END AS authorized`,
    )
    .bind(project.organization_id, ...userIds, userIds.length);
}

export async function buildDurableReviewSideEffects(
  env: Env,
  input: {
    operation: ReviewOperationRow;
    project: Project;
    actor: ShipletUser;
    feedbackId: string;
    replyId: string | null;
    ticketNumber: number;
    mentions: ReviewMentionInput[];
    reason: "new_feedback" | "reply" | "status_changed";
    now: string;
  },
) {
  const mentions = await planMentions(env, input.project, input.actor, input.mentions);
  const watchers = await planWatchers(env.DB, input.project, input.actor.id);
  const statements: D1PreparedStatement[] = [];
  const mentionIds: string[] = [];
  const notificationKeys: string[] = [];
  for (const mention of mentions) {
    if (mention.grantId) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO shiplet_access_grants
           (id, project_id, organization_id, target_type, target_id, email, role,
            invited_by_user_id, workos_invitation_id, created_on, accepted_on)
           SELECT ?, ?, ?, 'user', ?, ?, 'reviewer', ?, NULL, ?, NULL
           FROM organization_memberships WHERE organization_id = ? AND user_id = ?`,
        ).bind(
          mention.grantId,
          input.project.id,
          input.project.organization_id || "",
          mention.userId,
          mention.email,
          input.actor.id,
          input.now,
          input.project.organization_id || "",
          mention.userId,
        ),
      );
    }
    const mentionId = newId("mention");
    mentionIds.push(mentionId);
    statements.push(
      env.DB.prepare(
        `INSERT INTO review_feedback_mentions
         (id, project_id, organization_id, feedback_id, reply_id, mentioned_user_id,
          mentioned_email, mentioned_name, access_status, grant_id, invite_error, created_on)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
         FROM organization_memberships WHERE organization_id = ? AND user_id = ?`,
      ).bind(
        mentionId,
        input.project.id,
        input.project.organization_id || "",
        input.feedbackId,
        input.replyId,
        mention.userId,
        mention.email,
        mention.name,
        mention.accessStatus,
        mention.grantId,
        input.now,
        input.project.organization_id || "",
        mention.userId,
      ),
    );
    if (mention.userId !== input.actor.id) {
      const key = `operation:${input.operation.id}:mention:${mention.userId}`;
      notificationKeys.push(key);
      statements.push(
        notificationStatement(env.DB, {
          row: input.operation,
          project: input.project,
          feedbackId: input.feedbackId,
          replyId: input.replyId,
          recipientId: mention.userId,
          recipientEmail: mention.email,
          actor: input.actor,
          type: "mention",
          reason: "mentioned",
          message: `${input.actor.email} mentioned you in PF-${input.ticketNumber}.`,
          emailStatus: durableEmailConfigured(env) ? "pending" : "email_not_configured",
          now: input.now,
        }),
      );
    }
  }
  const mentionedUserIds = new Set(mentions.map((mention) => mention.userId));
  for (const watcher of watchers) {
    if (mentionedUserIds.has(watcher.id)) continue;
    const key = `operation:${input.operation.id}:watch:${watcher.id}`;
    notificationKeys.push(key);
    statements.push(
      notificationStatement(env.DB, {
        row: input.operation,
        project: input.project,
        feedbackId: input.feedbackId,
        replyId: input.replyId,
        recipientId: watcher.id,
        recipientEmail: watcher.email,
        actor: input.actor,
        type: "watch",
        reason: input.reason,
        message: `${input.actor.email} updated PF-${input.ticketNumber}.`,
        emailStatus: durableEmailConfigured(env) ? "pending" : "email_not_configured",
        now: input.now,
      }),
    );
  }
  if (mentionIds.length || notificationKeys.length) {
    const mentionCheck = mentionIds.length
      ? `(SELECT COUNT(*) FROM review_feedback_mentions WHERE id IN (${mentionIds.map(() => "?").join(",")})) = ${mentionIds.length}`
      : "1";
    const notificationCheck = notificationKeys.length
      ? `(SELECT COUNT(*) FROM review_notifications WHERE dedupe_key IN (${notificationKeys.map(() => "?").join(",")})) = ${notificationKeys.length}`
      : "1";
    statements.push(
      env.DB.prepare(
        `SELECT CASE WHEN ${mentionCheck} AND ${notificationCheck}
         THEN 1 ELSE json_extract('review_side_effect_commit_failed', '$.invalid') END AS committed`,
      ).bind(...mentionIds, ...notificationKeys),
    );
  }
  return statements;
}

export async function completeDurableThreadOperation(
  env: Env,
  input: {
    operation: ReviewOperationRow;
    project: Project;
    actor: ShipletUser;
    feedbackId: string;
    value: string;
    mentions?: ReviewMentionInput[];
  },
): Promise<ReviewOperationResult | null> {
  const row = input.operation;
  const completedState = reviewOperationState(row);
  if (completedState === "completed") {
    return {
      feedbackId: row.result_feedback_id!,
      ...(row.result_reply_id ? { replyId: row.result_reply_id } : {}),
      eventId: row.result_event_id!,
    };
  }
  if (
    completedState === "unknown" ||
    completedState === "failed" ||
    completedState === "cancelled"
  )
    return null;
  const now = timestamps.now();
  const feedback = await env.DB
    .prepare(
      `SELECT id, status, ticket_number, comment FROM review_feedback
       WHERE project_id = ? AND id = ?`,
    )
    .bind(input.project.id, input.feedbackId)
    .first<{ id: string; status: string; ticket_number: number; comment: string }>();
  if (!feedback) return null;
  const mentions =
    row.effect === "feedback.reply"
      ? await planMentions(env, input.project, input.actor, input.mentions || [])
      : [];
  const watchers = await planWatchers(
    env.DB,
    input.project,
    input.actor.id,
  );
  const auditId = `audit_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE embed_review_operation_intents SET confirmed_on = COALESCE(confirmed_on, ?)
       WHERE id = ? AND installation_id = ? AND project_id = ? AND revision_id = ?
         AND actor_user_id = ? AND effect = ? AND page_url = ?
         AND completed_on IS NULL AND failed_on IS NULL AND expires_on > ?
         AND EXISTS (
           SELECT 1 FROM projects project
           WHERE project.id = ? AND project.active_revision_id = ? AND project.archived_on IS NULL
             AND (
               project.visibility IN ('public', 'unlisted')
               OR project.owner_user_id = ?
               OR EXISTS (
                 SELECT 1 FROM organization_memberships membership
                 WHERE membership.organization_id = project.organization_id
                   AND membership.user_id = ?
                   AND (project.visibility = 'organization' OR lower(membership.role) IN ('admin', 'owner'))
               )
               OR EXISTS (
                 SELECT 1 FROM shiplet_access_grants direct_grant
                 WHERE direct_grant.project_id = project.id
                   AND direct_grant.target_type = 'user' AND direct_grant.target_id = ?
               )
               OR EXISTS (
                 SELECT 1 FROM shiplet_access_grants org_grant
                 JOIN organization_memberships membership
                   ON membership.organization_id = org_grant.target_id
                 WHERE org_grant.project_id = project.id
                   AND org_grant.target_type = 'organization'
                   AND membership.user_id = ?
               )
               OR EXISTS (
                 SELECT 1 FROM shiplet_access_grants team_grant
                 JOIN team_memberships membership ON membership.team_id = team_grant.target_id
                 WHERE team_grant.project_id = project.id
                   AND team_grant.target_type = 'team' AND membership.user_id = ?
               )
             )
         )
         AND (? LIKE 'managed:%' OR EXISTS (
           SELECT 1 FROM embed_installations WHERE id = ? AND project_id = ? AND revoked_on IS NULL
         ))`,
    ).bind(
      now,
      row.id,
      row.installation_id,
      row.project_id,
      row.revision_id,
      row.actor_user_id,
      row.effect,
      row.page_url,
      now,
      row.project_id,
      row.revision_id,
      row.actor_user_id,
      row.actor_user_id,
      row.actor_user_id,
      row.actor_user_id,
      row.actor_user_id,
      row.installation_id,
      row.installation_id,
      row.project_id,
    ),
  ];
  const mentionMembershipFence = durableMentionMembershipFenceStatement(
    env.DB,
    input.project,
    mentions,
  );
  if (mentionMembershipFence) statements.push(mentionMembershipFence);
  if (row.effect === "feedback.reply") {
    statements.push(
      env.DB.prepare(
        `INSERT INTO review_feedback_replies
         (id, feedback_id, project_id, comment, author_user_id, author_email, created_on)
         SELECT ?, ?, ?, ?, ?, ?, ? FROM embed_review_operation_intents
         WHERE id = ? AND confirmed_on IS NOT NULL AND completed_on IS NULL`,
      ).bind(
        row.result_reply_id,
        input.feedbackId,
        input.project.id,
        input.value,
        input.actor.id,
        input.actor.email,
        now,
        row.id,
      ),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE review_feedback SET status = ?, updated_on = ?
         WHERE id = ? AND project_id = ?
           AND EXISTS (SELECT 1 FROM embed_review_operation_intents
             WHERE id = ? AND confirmed_on IS NOT NULL AND completed_on IS NULL)`,
      ).bind(input.value, now, input.feedbackId, input.project.id, row.id),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO shiplet_events (
       id, project_id, revision_id, actor_kind, actor_id, event_kind,
       summary, canonical_status_category, custom_payload_json, occurred_at, created_at
      ) SELECT ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ?
        FROM embed_review_operation_intents WHERE id = ? AND confirmed_on IS NOT NULL AND completed_on IS NULL`,
    ).bind(
      row.result_event_id,
      input.project.id,
      row.revision_id,
      input.actor.id,
      row.effect === "feedback.reply" ? "review.reply-created" : "review.status-changed",
      row.effect === "feedback.reply" ? "Review reply created" : "Review status changed",
      input.value === "Done" ? "resolved" : input.value === "Dropped" ? "closed" : input.value === "In Progress" || input.value === "Blocked" ? "in_progress" : "open",
      JSON.stringify(
        row.effect === "feedback.reply"
          ? { feedbackId: input.feedbackId, replyId: row.result_reply_id }
          : { feedbackId: input.feedbackId, status: input.value },
      ),
      now,
      now,
      row.id,
    ),
    env.DB.prepare(
      `INSERT INTO shiplet_audit_events (
       id, project_id, revision_id, deployment_id, actor_kind, actor_id,
       event_kind, summary, status_category, payload_json, occurred_on, recorded_on
      ) SELECT ?, ?, ?, NULL, 'human', ?, ?, ?, 'action_required', ?, ?, ?
        FROM embed_review_operation_intents WHERE id = ? AND confirmed_on IS NOT NULL AND completed_on IS NULL`,
    ).bind(
      auditId,
      input.project.id,
      row.revision_id,
      input.actor.id,
      row.effect === "feedback.reply" ? "review.reply_created" : "review.status_changed",
      row.effect === "feedback.reply" ? "Reply created through durable review operation" : "Status changed through durable review operation",
      JSON.stringify({ feedbackId: input.feedbackId, requestId: row.request_id }),
      now,
      now,
      row.id,
    ),
  );
  for (const mention of mentions) {
    if (mention.grantId) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO shiplet_access_grants
           (id, project_id, organization_id, target_type, target_id, email, role,
            invited_by_user_id, workos_invitation_id, created_on, accepted_on)
           SELECT ?, ?, ?, 'user', ?, ?, 'reviewer', ?, NULL, ?, NULL
           FROM organization_memberships WHERE organization_id = ? AND user_id = ?`,
        ).bind(
          mention.grantId,
          input.project.id,
          input.project.organization_id || "",
          mention.userId,
          mention.email,
          input.actor.id,
          now,
          input.project.organization_id || "",
          mention.userId,
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO review_feedback_mentions
         (id, project_id, organization_id, feedback_id, reply_id, mentioned_user_id,
          mentioned_email, mentioned_name, access_status, grant_id, invite_error, created_on)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
         FROM organization_memberships WHERE organization_id = ? AND user_id = ?`,
      ).bind(
        newId("mention"),
        input.project.id,
        input.project.organization_id || "",
        input.feedbackId,
        row.result_reply_id,
        mention.userId,
        mention.email,
        mention.name,
        mention.accessStatus,
        mention.grantId,
        now,
        input.project.organization_id || "",
        mention.userId,
      ),
    );
    if (mention.userId !== input.actor.id) {
      statements.push(notificationStatement(env.DB, {
        row,
        project: input.project,
        feedbackId: input.feedbackId,
        replyId: row.result_reply_id,
        recipientId: mention.userId,
        recipientEmail: mention.email,
        actor: input.actor,
        type: "mention",
        reason: "mentioned",
        message: `${input.actor.email} mentioned you in PF-${feedback.ticket_number}.`,
        emailStatus: durableEmailConfigured(env) ? "pending" : "email_not_configured",
        now,
      }));
    }
  }
  const mentionedUserIds = new Set(mentions.map((mention) => mention.userId));
  for (const watcher of watchers) {
    if (mentionedUserIds.has(watcher.id)) continue;
    statements.push(
      notificationStatement(env.DB, {
        row,
        project: input.project,
        feedbackId: input.feedbackId,
        replyId: row.result_reply_id,
        recipientId: watcher.id,
        recipientEmail: watcher.email,
        actor: input.actor,
        type: "watch",
        reason: row.effect === "feedback.reply" ? "reply" : "status_changed",
        message:
          row.effect === "feedback.reply"
            ? `${input.actor.email} replied to PF-${feedback.ticket_number}.`
            : `${input.actor.email} changed PF-${feedback.ticket_number} to ${input.value}.`,
        emailStatus: durableEmailConfigured(env) ? "pending" : "email_not_configured",
        now,
      }),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE embed_review_operation_intents
       SET completed_on = ?, result_feedback_id = ?, result_reply_id = ?, result_event_id = ?
       WHERE id = ? AND confirmed_on IS NOT NULL AND completed_on IS NULL
         AND EXISTS (SELECT 1 FROM shiplet_events WHERE id = ?)
         AND EXISTS (SELECT 1 FROM shiplet_audit_events WHERE id = ?)
         AND (? = 'feedback.status' OR EXISTS (SELECT 1 FROM review_feedback_replies WHERE id = ?))`,
    ).bind(
      now,
      input.feedbackId,
      row.result_reply_id,
      row.result_event_id,
      row.id,
      row.result_event_id,
      auditId,
      row.effect,
      row.result_reply_id,
    ),
    env.DB.prepare(
      `SELECT CASE WHEN EXISTS (
        SELECT 1 FROM embed_review_operation_intents
        WHERE id = ? AND completed_on IS NOT NULL AND result_event_id = ?
       ) THEN 1 ELSE json_extract('review_operation_commit_failed', '$.invalid') END AS committed`,
    ).bind(row.id, row.result_event_id),
  );
  try {
    await env.DB.batch(statements);
  } catch {
    const committed = await env.DB
      .prepare("SELECT * FROM embed_review_operation_intents WHERE id = ?")
      .bind(row.id)
      .first<ReviewOperationRow>();
    if (committed && reviewOperationState(committed) === "completed") {
      return {
        feedbackId: committed.result_feedback_id!,
        ...(committed.result_reply_id ? { replyId: committed.result_reply_id } : {}),
        eventId: committed.result_event_id!,
      };
    }
    return null;
  }
  const committed = await env.DB
    .prepare("SELECT * FROM embed_review_operation_intents WHERE id = ?")
    .bind(row.id)
    .first<ReviewOperationRow>();
  if (!committed || reviewOperationState(committed) !== "completed") {
    return null;
  }
  await dispatchDurableOperationEmails(
    env,
    input.project,
    committed.id,
    committed.result_feedback_id || input.feedbackId,
  );
  return {
    feedbackId: committed.result_feedback_id || input.feedbackId,
    ...(committed.result_reply_id ? { replyId: committed.result_reply_id } : {}),
    eventId: committed.result_event_id!,
  };
}

function notificationStatement(
  db: D1Database,
  input: {
    row: ReviewOperationRow;
    project: Project;
    feedbackId: string;
    replyId: string | null;
    recipientId: string;
    recipientEmail: string;
    actor: ShipletUser;
    type: string;
    reason: string;
    message: string;
    emailStatus: "pending" | "email_not_configured";
    now: string;
  },
) {
  return db.prepare(
    `INSERT OR IGNORE INTO review_notifications
     (id, dedupe_key, recipient_user_id, recipient_email, organization_id,
      project_id, feedback_id, reply_id, type, reason, actor_user_id,
      actor_email, message, email_status, created_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    newId("notif"),
    `operation:${input.row.id}:${input.type}:${input.recipientId}`,
    input.recipientId,
    input.recipientEmail,
    input.project.organization_id || "",
    input.project.id,
    input.feedbackId,
    input.replyId,
    input.type,
    input.reason,
    input.actor.id,
    input.actor.email,
    input.message,
    input.emailStatus,
    input.now,
  );
}

function durableEmailConfigured(env: Env) {
  return Boolean(
    env.EMAIL &&
      env.SHIPLET_EMAIL_FROM &&
      env.SHIPLET_EMAIL_NOTIFICATIONS !== "false" &&
      env.SHIPLET_EMAIL_NOTIFICATIONS !== "off",
  );
}

export async function dispatchDurableOperationEmails(
  env: Env,
  project: Project,
  operationId: string,
  feedbackId: string,
) {
  if (!durableEmailConfigured(env)) return;
  const pending = await env.DB
    .prepare(
      `SELECT id, recipient_email, message FROM review_notifications
       WHERE dedupe_key LIKE ? AND email_status = 'pending'`,
    )
    .bind(`operation:${operationId}:%`)
    .all<{ id: string; recipient_email: string; message: string }>();
  for (const notification of pending.results || []) {
    try {
      await env.EMAIL!.send({
        to: notification.recipient_email,
        from: {
          email: env.SHIPLET_EMAIL_FROM!,
          name: env.SHIPLET_EMAIL_FROM_NAME || "Shiplet",
        },
        subject: `Shiplet review: ${project.name}`,
        text: `${notification.message}\n\n/shiplets/${encodeURIComponent(project.id)}?feedback=${encodeURIComponent(feedbackId)}`,
      });
      await env.DB
        .prepare("UPDATE review_notifications SET email_status = 'sent', email_error = NULL WHERE id = ? AND email_status = 'pending'")
        .bind(notification.id)
        .run();
    } catch (error) {
      await env.DB
        .prepare("UPDATE review_notifications SET email_status = 'email_failed', email_error = ? WHERE id = ? AND email_status = 'pending'")
        .bind(error instanceof Error ? error.message : String(error), notification.id)
        .run();
    }
  }
}
