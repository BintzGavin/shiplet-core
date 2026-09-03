import type { Env } from "./env";
import type { Project } from "./types";
import {
	createShipletGrant,
	getOrganizationMentionUser,
	getShipletParticipation,
	newId,
	timestamps,
	type OrganizationMentionUserRecord,
	type ShipletUser,
} from "./store";

export type ReviewMentionInput = {
	userId?: string | null;
	email?: string | null;
	name?: string | null;
};

export type ReviewMentionAccessStatus = "active" | "invited" | "invite_failed";

export type ReviewMentionRecord = {
	id: string;
	project_id: string;
	organization_id: string;
	feedback_id: string;
	reply_id: string | null;
	mentioned_user_id: string;
	mentioned_email: string;
	mentioned_name: string | null;
	access_status: ReviewMentionAccessStatus;
	grant_id: string | null;
	invite_error: string | null;
	created_on: string;
};

export type ReviewNotificationType = "mention" | "watch";
export type ReviewNotificationReason =
	| "mentioned"
	| "new_feedback"
	| "reply"
	| "status_changed";

export type ReviewNotificationRecord = {
	id: string;
	dedupe_key: string;
	recipient_user_id: string;
	recipient_email: string;
	organization_id: string;
	project_id: string;
	project_name?: string | null;
	feedback_id: string | null;
	reply_id: string | null;
	type: ReviewNotificationType;
	reason: ReviewNotificationReason;
	actor_user_id: string | null;
	actor_email: string | null;
	message: string;
	read_on: string | null;
	email_status: string;
	email_error: string | null;
	created_on: string;
};

export type WatchStatusRecord = {
	watching: boolean;
	source: "owner_default" | "explicit" | "muted" | "none";
};

type FeedbackNotificationTarget = {
	id: string;
	ticket_label?: string | null;
	ticket_number?: number | null;
	comment?: string | null;
	status?: string | null;
};

type WatcherRow = ShipletUser & { watch_status?: string | null };

const MAX_MENTIONS = 25;

export function normalizeMentionInputs(value: unknown): ReviewMentionInput[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const mentions: ReviewMentionInput[] = [];
	for (const item of value) {
		const record = isRecord(item) ? item : {};
		const userId = normalizeString(record.userId ?? record.id, 160);
		const email = normalizeString(record.email, 320).toLowerCase();
		const name = normalizeString(record.name ?? record.label, 160);
		const key = userId || email;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		mentions.push({ userId: userId || null, email: email || null, name: name || null });
		if (mentions.length >= MAX_MENTIONS) break;
	}
	return mentions;
}

export async function createReviewMentionsAndNotifications(
	env: Env,
	project: Project,
	feedback: FeedbackNotificationTarget,
	replyId: string | null,
	actor: ShipletUser | null,
	mentions: ReviewMentionInput[],
) {
	if (!project.organization_id || mentions.length === 0) return [];
	const created: ReviewMentionRecord[] = [];
	const mentionedUserIds = new Set<string>();

	for (const mention of mentions) {
		const member = await getOrganizationMentionUser(env.DB, project.organization_id, {
			userId: mention.userId || null,
			email: mention.email || null,
		});
		if (!member) {
			continue;
		}

		const mentionRecord = await createMentionForMember(
			env,
			project,
			feedback,
			replyId,
			actor,
			member,
		);
		created.push(mentionRecord);
		mentionedUserIds.add(member.id);

		if (!actor || member.id !== actor.id) {
			await createReviewNotification(env, {
				recipient: member,
				project,
				feedback,
				replyId,
				type: "mention",
				reason: "mentioned",
				actor,
				message: notificationMessage(project, feedback, actor, "mentioned"),
			});
		}
	}

	await notifyWatchersForReviewEvent(env, {
		project,
		feedback,
		replyId,
		actor,
		reason: replyId ? "reply" : "new_feedback",
		excludeUserIds: mentionedUserIds,
	});

	return created;
}

export async function notifyWatchersForReviewEvent(
	env: Env,
	options: {
		project: Project;
		feedback: FeedbackNotificationTarget;
		replyId: string | null;
		actor: ShipletUser | null;
		reason: Exclude<ReviewNotificationReason, "mentioned">;
		excludeUserIds?: Set<string>;
	},
) {
	if (!options.project.organization_id) return [];
	const watchers = await listWatchRecipients(env.DB, options.project);
	const created: ReviewNotificationRecord[] = [];
	for (const watcher of watchers) {
		if (options.actor && watcher.id === options.actor.id) continue;
		if (options.excludeUserIds?.has(watcher.id)) continue;
		const notification = await createReviewNotification(env, {
			recipient: watcher,
			project: options.project,
			feedback: options.feedback,
			replyId: options.replyId,
			type: "watch",
			reason: options.reason,
			actor: options.actor,
			message: notificationMessage(
				options.project,
				options.feedback,
				options.actor,
				options.reason,
			),
		});
		if (notification) created.push(notification);
	}
	return created;
}

export async function listReviewMentions(
	db: D1Database,
	feedbackIds: string[],
) {
	if (feedbackIds.length === 0) return new Map<string, ReviewMentionRecord[]>();
	const placeholders = feedbackIds.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT * FROM review_feedback_mentions
			 WHERE feedback_id IN (${placeholders})
			 ORDER BY created_on ASC`,
		)
		.bind(...feedbackIds)
		.all<ReviewMentionRecord>();
	const byFeedback = new Map<string, ReviewMentionRecord[]>();
	for (const mention of result.results || []) {
		const mentions = byFeedback.get(mention.feedback_id) || [];
		mentions.push(mention);
		byFeedback.set(mention.feedback_id, mentions);
	}
	return byFeedback;
}

export async function getWatchStatus(
	db: D1Database,
	project: Project,
	user: ShipletUser,
): Promise<WatchStatusRecord> {
	const row = await db
		.prepare(
			`SELECT status FROM shiplet_watch_subscriptions
			 WHERE project_id = ? AND user_id = ?`,
		)
		.bind(project.id, user.id)
		.first<{ status: string }>();
	if (row?.status === "active") return { watching: true, source: "explicit" };
	if (row?.status === "muted") return { watching: false, source: "muted" };
	if (project.owner_user_id === user.id) {
		return { watching: true, source: "owner_default" };
	}
	return { watching: false, source: "none" };
}

export async function setWatchStatus(
	db: D1Database,
	project: Project,
	user: ShipletUser,
	watching: boolean,
) {
	const now = timestamps.now();
	const status = watching ? "active" : "muted";
	await db
		.prepare(
			`INSERT INTO shiplet_watch_subscriptions
			 (project_id, user_id, status, created_by_user_id, created_on, updated_on)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(project_id, user_id) DO UPDATE SET
			 status = excluded.status,
			 updated_on = excluded.updated_on`,
		)
		.bind(project.id, user.id, status, user.id, now, now)
		.run();
	return getWatchStatus(db, project, user);
}

export async function listNotificationsForUser(
	db: D1Database,
	user: ShipletUser,
	options: { unreadOnly?: boolean; limit?: number } = {},
) {
	const where = ["review_notifications.recipient_user_id = ?"];
	const bindings: Array<string | number> = [user.id];
	if (options.unreadOnly) where.push("review_notifications.read_on IS NULL");
	const limit = Math.min(Math.max(options.limit || 100, 1), 250);
	const result = await db
		.prepare(
			`SELECT review_notifications.*, projects.name AS project_name
			 FROM review_notifications
			 LEFT JOIN projects ON projects.id = review_notifications.project_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY review_notifications.created_on DESC
			 LIMIT ?`,
		)
		.bind(...bindings, limit)
		.all<ReviewNotificationRecord>();
	return result.results || [];
}

export async function markNotificationRead(
	db: D1Database,
	user: ShipletUser,
	notificationId: string,
) {
	await db
		.prepare(
			`UPDATE review_notifications
			 SET read_on = COALESCE(read_on, ?)
			 WHERE id = ? AND recipient_user_id = ?`,
		)
		.bind(timestamps.now(), notificationId, user.id)
		.run();
	return db
		.prepare(`SELECT * FROM review_notifications WHERE id = ? AND recipient_user_id = ?`)
		.bind(notificationId, user.id)
		.first<ReviewNotificationRecord>();
}

async function createMentionForMember(
	env: Env,
	project: Project,
	feedback: FeedbackNotificationTarget,
	replyId: string | null,
	actor: ShipletUser | null,
	member: OrganizationMentionUserRecord,
) {
	const now = timestamps.now();
	const participation = await getShipletParticipation(env.DB, project, member);
	let accessStatus: ReviewMentionAccessStatus =
		participation.status === "active" ? "active" : "invited";
	let grantId = participation.grant_id || null;
	let inviteError: string | null = null;

	if (participation.status === "none") {
		try {
			const grant = await createShipletGrant(env.DB, {
				id: newId("grant"),
				project_id: project.id,
				organization_id: project.organization_id || "",
				target_type: "user",
				target_id: member.id,
				email: member.email,
				role: "reviewer",
				invited_by_user_id: actor?.id || project.owner_user_id || member.id,
				created_on: now,
			});
			grantId = grant.id;
			accessStatus = "invited";
		} catch (error) {
			accessStatus = "invite_failed";
			inviteError = error instanceof Error ? error.message : String(error);
		}
	}

	const mention: ReviewMentionRecord = {
		id: newId("mention"),
		project_id: project.id,
		organization_id: project.organization_id || "",
		feedback_id: feedback.id,
		reply_id: replyId,
		mentioned_user_id: member.id,
		mentioned_email: member.email,
		mentioned_name: displayUserName(member),
		access_status: accessStatus,
		grant_id: grantId,
		invite_error: inviteError,
		created_on: now,
	};

	await env.DB
		.prepare(
			`INSERT INTO review_feedback_mentions
			 (id, project_id, organization_id, feedback_id, reply_id, mentioned_user_id,
			  mentioned_email, mentioned_name, access_status, grant_id, invite_error, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			mention.id,
			mention.project_id,
			mention.organization_id,
			mention.feedback_id,
			mention.reply_id,
			mention.mentioned_user_id,
			mention.mentioned_email,
			mention.mentioned_name,
			mention.access_status,
			mention.grant_id,
			mention.invite_error,
			mention.created_on,
		)
		.run();

	return mention;
}

async function createReviewNotification(
	env: Env,
	options: {
		recipient: Pick<ShipletUser, "id" | "email">;
		project: Project;
		feedback: FeedbackNotificationTarget;
		replyId: string | null;
		type: ReviewNotificationType;
		reason: ReviewNotificationReason;
		actor: ShipletUser | null;
		message: string;
	},
) {
	const now = timestamps.now();
	const dedupeKey = [
		options.type,
		options.reason,
		options.recipient.id,
		options.project.id,
		options.feedback.id,
		options.replyId || "feedback",
	].join(":");
	const emailStatus = emailIsConfigured(env) ? "pending" : "email_not_configured";
	await env.DB
		.prepare(
			`INSERT OR IGNORE INTO review_notifications
			 (id, dedupe_key, recipient_user_id, recipient_email, organization_id,
			  project_id, feedback_id, reply_id, type, reason, actor_user_id,
			  actor_email, message, email_status, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId("notif"),
			dedupeKey,
			options.recipient.id,
			options.recipient.email,
			options.project.organization_id || "",
			options.project.id,
			options.feedback.id,
			options.replyId,
			options.type,
			options.reason,
			options.actor?.id || null,
			options.actor?.email || null,
			options.message,
			emailStatus,
			now,
		)
		.run();

	const notification = await env.DB
		.prepare(`SELECT * FROM review_notifications WHERE dedupe_key = ?`)
		.bind(dedupeKey)
		.first<ReviewNotificationRecord>();
	if (notification && notification.email_status === "pending") {
		await deliverNotificationEmail(env, notification, options.project, options.feedback);
	}
	return notification || null;
}

async function listWatchRecipients(db: D1Database, project: Project) {
	const watchers = new Map<string, WatcherRow>();
	const activeResult = await db
		.prepare(
			`SELECT users.*, shiplet_watch_subscriptions.status AS watch_status
			 FROM shiplet_watch_subscriptions
			 JOIN users ON users.id = shiplet_watch_subscriptions.user_id
			 WHERE shiplet_watch_subscriptions.project_id = ?
			   AND shiplet_watch_subscriptions.status = 'active'`,
		)
		.bind(project.id)
		.all<WatcherRow>();
	for (const watcher of activeResult.results || []) watchers.set(watcher.id, watcher);

	if (project.owner_user_id) {
		const ownerPreference = await db
			.prepare(
				`SELECT status FROM shiplet_watch_subscriptions
				 WHERE project_id = ? AND user_id = ?`,
			)
			.bind(project.id, project.owner_user_id)
			.first<{ status: string }>();
		if (ownerPreference?.status !== "muted") {
			const owner = await db
				.prepare(`SELECT * FROM users WHERE id = ?`)
				.bind(project.owner_user_id)
				.first<WatcherRow>();
			if (owner) watchers.set(owner.id, owner);
		}
	}

	return Array.from(watchers.values());
}

async function deliverNotificationEmail(
	env: Env,
	notification: ReviewNotificationRecord,
	project: Project,
	feedback: FeedbackNotificationTarget,
) {
	const sender = env.SHIPLET_EMAIL_FROM;
	if (!emailIsConfigured(env) || !sender) {
		await updateNotificationEmailStatus(
			env.DB,
			notification.id,
			"email_not_configured",
			null,
		);
		return;
	}

	const subject = `Shiplet ${feedback.ticket_label || "feedback"}: ${project.name}`;
	const ticketUrl = shipletFeedbackUrl(env, project, feedback.id);
	const text = `${notification.message}\n\n${ticketUrl}`;
	const html = `<p>${escapeHtml(notification.message)}</p><p><a href="${escapeHtml(ticketUrl)}">Open feedback</a></p>`;
	try {
		await env.EMAIL!.send({
			to: notification.recipient_email,
			from: {
				email: sender,
				name: env.SHIPLET_EMAIL_FROM_NAME || "Shiplet",
			},
			subject,
			text,
			html,
		});
		await updateNotificationEmailStatus(env.DB, notification.id, "sent", null);
	} catch (error) {
		await updateNotificationEmailStatus(
			env.DB,
			notification.id,
			"email_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

async function updateNotificationEmailStatus(
	db: D1Database,
	notificationId: string,
	status: string,
	error: string | null,
) {
	await db
		.prepare(
			`UPDATE review_notifications
			 SET email_status = ?, email_error = ?
			 WHERE id = ?`,
		)
		.bind(status, error, notificationId)
		.run();
}

function notificationMessage(
	project: Project,
	feedback: FeedbackNotificationTarget,
	actor: ShipletUser | null,
	reason: ReviewNotificationReason,
) {
	const actorName = actor ? displayUserName(actor) : "A reviewer";
	const label = feedback.ticket_label || `PF-${feedback.ticket_number || ""}`.trim();
	if (reason === "mentioned") {
		return `${actorName} mentioned you on ${label} in ${project.name}.`;
	}
	if (reason === "reply") {
		return `${actorName} replied to ${label} in ${project.name}.`;
	}
	if (reason === "status_changed") {
		return `${actorName} changed ${label} to ${feedback.status || "a new status"} in ${project.name}.`;
	}
	return `${actorName} added ${label} in ${project.name}.`;
}

function displayUserName(user: {
	email: string;
	first_name?: string | null;
	last_name?: string | null;
}) {
	const name = [user.first_name, user.last_name]
		.map((part) => String(part || "").trim())
		.filter(Boolean)
		.join(" ");
	return name || user.email;
}

function emailIsConfigured(env: Env) {
	if (env.SHIPLET_EMAIL_NOTIFICATIONS === "false") return false;
	if (env.SHIPLET_EMAIL_NOTIFICATIONS === "off") return false;
	return Boolean(env.EMAIL && env.SHIPLET_EMAIL_FROM);
}

function shipletFeedbackUrl(env: Env, project: Project, feedbackId: string) {
	const appUrl = (env.SHIPLET_APP_URL || (env.CUSTOM_DOMAIN ? `https://${env.CUSTOM_DOMAIN}` : "")).replace(/\/$/, "");
	const path = `/shiplets/${encodeURIComponent(project.id)}?feedback=${encodeURIComponent(feedbackId)}`;
	return appUrl ? `${appUrl}${path}` : path;
}

function normalizeString(value: unknown, maxLength: number) {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: unknown) {
	return String(value == null ? "" : value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
