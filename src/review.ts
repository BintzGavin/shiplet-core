import type { Env } from "./env";
import type { Project } from "./types";
import type { ShipletUser } from "./store";
import { canViewProject, newId, timestamps } from "./store";
import {
	createReviewMentionsAndNotifications,
	listReviewMentions,
	normalizeMentionInputs,
	notifyWatchersForReviewEvent,
	getWatchStatus,
	type ReviewMentionInput,
	type ReviewMentionRecord,
} from "./notifications";
import { listProjectsForUser } from "./store";

export const REVIEW_STATUSES = [
	"New",
	"In Progress",
	"Blocked",
	"Done",
	"Dropped",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type ReviewScope =
	| "feedback:read"
	| "feedback:write"
	| "feedback:manage"
	| "mcp"
	| "presence:join"
	| "watch:write";

export type ReviewCapabilityScope =
	| "feedback:read"
	| "feedback:write"
	| "presence:join"
	| "watch:write";

export type ReviewCapabilityViewer = {
	id: string;
	email: string;
	name: string;
	avatarPreset?: string | null;
	avatarDataUrl?: string | null;
};

export type ReviewCapability = {
	version: 1;
	projectId: string;
	viewer: ReviewCapabilityViewer;
	scopes: ReviewCapabilityScope[];
	expiresAt: string;
	nonce: string;
};

type JsonObject = Record<string, unknown>;

export type ReviewFeedbackRecord = {
	id: string;
	project_id: string;
	organization_id: string;
	ticket_number: number;
	ticket_label: string;
	client_feedback_id: string;
	name: string | null;
	comment: string;
	status: ReviewStatus;
	page_url: string;
	pathname: string;
	page_url_key: string;
	screenshot_key: string | null;
	screenshot_url: string | null;
	screenshot_content_type: string | null;
	screenshot_size: number | null;
	screenshot_failure_note: string | null;
	screenshot_mode: "page" | "element";
	viewport: JsonObject | null;
	coordinates: JsonObject | null;
	selected_element: JsonObject | null;
	capture_context: JsonObject | null;
	user_agent: string | null;
	submitted_by_user_id: string | null;
	submitted_by_email: string | null;
	submitted_by_avatar_preset: string | null;
	submitted_by_avatar_data_url: string | null;
	source: string;
	created_on: string;
	updated_on: string;
	project_name?: string | null;
	project_subdomain?: string | null;
	replies: ReviewReplyRecord[];
	mentions: ReviewMentionRecord[];
};

export type ReviewReplyRecord = {
	id: string;
	feedback_id: string;
	project_id: string;
	comment: string;
	author_user_id: string | null;
	author_email: string | null;
	created_on: string;
	mentions: ReviewMentionRecord[];
};

type ReviewReplyRow = Omit<ReviewReplyRecord, "mentions">;

type ReviewFeedbackRow = Omit<
	ReviewFeedbackRecord,
	| "ticket_label"
	| "screenshot_url"
	| "viewport"
	| "coordinates"
	| "selected_element"
	| "capture_context"
	| "replies"
> & {
	viewport_json: string | null;
	coordinates_json: string | null;
	selected_element_json: string | null;
	capture_context_json: string | null;
};

type TokenRow = {
	id: string;
	project_id: string;
	name: string;
	token_hash: string;
	scopes: string;
	created_by_user_id: string;
	created_on: string;
	last_used_on: string | null;
	revoked_on: string | null;
};

export type ReviewTokenRecord = Omit<TokenRow, "token_hash" | "scopes"> & {
	scopes: ReviewScope[];
};

type ValidReviewFeedbackPayload = Extract<
	ReturnType<typeof validateReviewFeedbackPayload>,
	{ ok: true }
>["value"];

type ReviewFeedbackEffectFence =
	| {
			kind?: "intent";
			revisionId: string;
			intentId: string;
			confirmedOn: string;
			requestId: string;
	  }
	| {
			kind: "receipt";
			revisionId: string;
			receiptHash: string;
			installationId: string;
			payloadDigest: string;
			requestId: string;
			claimedOn: string;
	  };

export type CanonicalReviewActor = {
	kind: "human" | "agent" | "shiplet" | "system";
	id: string;
};

function canonicalStatusCategory(status: ReviewStatus) {
	if (status === "New") return "open" as const;
	if (status === "In Progress" || status === "Blocked") {
		return "in_progress" as const;
	}
	if (status === "Done") return "resolved" as const;
	return "closed" as const;
}


function canonicalActor(
	user: ShipletUser | null,
	override?: CanonicalReviewActor,
): CanonicalReviewActor {
	if (override) return Object.freeze({ ...override });
	return user
		? Object.freeze({ kind: "human" as const, id: user.id })
		: Object.freeze({ kind: "system" as const, id: "review_kernel" });
}

async function canonicalRevisionId(db: D1Database, projectId: string) {
	const project = await db
		.prepare("SELECT active_revision_id FROM projects WHERE id = ? LIMIT 1")
		.bind(projectId)
		.first<{ active_revision_id: string | null }>();
	return project?.active_revision_id || `legacy_${projectId}`;
}

function canonicalReviewEventStatement(
	db: D1Database,
	input: {
		projectId: string;
		revisionId: string;
		actor: CanonicalReviewActor;
		eventKind:
			| "review.feedback-created"
			| "review.reply-created"
			| "review.status-changed";
		summary: string;
		status: ReviewStatus;
		payload: Record<string, unknown>;
		now: string;
	},
) {
	return db
		.prepare(
			`INSERT INTO shiplet_events (
			 id, project_id, revision_id, actor_kind, actor_id, event_kind,
			 summary, canonical_status_category, custom_payload_json,
			 occurred_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			`event_${crypto.randomUUID().replace(/-/g, "")}`,
			input.projectId,
			input.revisionId,
			input.actor.kind,
			input.actor.id,
			input.eventKind,
			input.summary,
			canonicalStatusCategory(input.status),
			JSON.stringify(input.payload),
			input.now,
			input.now,
		);
}

const MAX_COMMENT_LENGTH = 5000;
const MAX_NAME_LENGTH = 160;
const MAX_USER_AGENT_LENGTH = 500;
const MAX_FAILURE_NOTE_LENGTH = 500;
const MAX_SCREENSHOT_BYTES = 10_000_000;
const CLIENT_FEEDBACK_ID_PATTERN = /^(?=.{8,120}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
const TOKEN_PREFIX = "shiplet_review_";
const CAPABILITY_TOKEN_PREFIX = "shiplet_review_cap_v1.";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-06-18";
const VALID_SCOPES = new Set<ReviewScope>([
	"feedback:read",
	"feedback:write",
	"feedback:manage",
	"mcp",
	"presence:join",
	"watch:write",
]);
const VALID_CAPABILITY_SCOPES = new Set<ReviewCapabilityScope>([
	"feedback:read",
	"feedback:write",
	"presence:join",
	"watch:write",
]);

export function validateReviewFeedbackPayload(payload: unknown): {
	ok: true;
	value: {
		name: string | null;
		comment: string;
		pageUrl: string;
		pathname: string;
		pageUrlKey: string;
		clientFeedbackId: string;
		screenshotDataUrl: string | null;
		screenshotMode: "page" | "element";
		viewport: JsonObject | null;
		coordinates: JsonObject | null;
		selectedElement: JsonObject | null;
		captureContext: JsonObject | null;
		userAgent: string | null;
		screenshotFailureNote: string | null;
		mentions: ReviewMentionInput[];
	};
} | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const input = isRecord(payload) ? payload : {};
	const comment = normalizeString(input.comment, MAX_COMMENT_LENGTH);
	const pageUrl = normalizeString(input.pageUrl, 2048);
	const name = normalizeOptionalString(input.name, MAX_NAME_LENGTH);
	const clientFeedbackId = normalizeString(input.clientFeedbackId, 120);
	const screenshotMode =
		input.screenshotMode === "element" || input.screenshotMode === "page"
			? input.screenshotMode
			: "page";
	const screenshotDataUrl = normalizeScreenshotDataUrl(
		input.screenshotDataUrl,
		errors,
	);
	const viewport = normalizeJsonObject(input.viewport, "Viewport", errors);
	const coordinates = normalizeJsonObject(input.coordinates, "Coordinates", errors);
	const selectedElement = normalizeJsonObject(
		input.selectedElement,
		"Selected element",
		errors,
	);
	const captureContext = normalizeJsonObject(
		input.captureContext,
		"Capture context",
		errors,
	);
	const userAgent = normalizeOptionalString(input.userAgent, MAX_USER_AGENT_LENGTH);
	const screenshotFailureNote = normalizeOptionalString(
		input.screenshotFailureNote,
		MAX_FAILURE_NOTE_LENGTH,
	);
	const mentions = normalizeMentionInputs(input.mentions);

	if (!comment) errors.push("Comment is required.");
	if (!isHttpUrl(pageUrl)) errors.push("Page URL must be a valid http or https URL.");
	if (!CLIENT_FEEDBACK_ID_PATTERN.test(clientFeedbackId)) {
		errors.push("Client feedback ID is required.");
	}

	if (errors.length > 0) {
		return { ok: false, errors: unique(errors) };
	}

	const parsed = new URL(pageUrl);
	return {
		ok: true,
		value: {
			name,
			comment,
			pageUrl,
			pathname: parsed.pathname || "/",
			pageUrlKey: buildPageUrlKey(pageUrl),
			clientFeedbackId,
			screenshotDataUrl,
			screenshotMode,
			viewport,
			coordinates,
			selectedElement,
			captureContext,
			userAgent,
			screenshotFailureNote,
			mentions,
		},
	};
}

export async function createReviewFeedback(
	env: Env,
	project: Project,
	user: ShipletUser | null,
	payload: ValidReviewFeedbackPayload,
	effectFence?: ReviewFeedbackEffectFence,
	eventActor?: CanonicalReviewActor,
) {
	const receiptFence =
		effectFence?.kind === "receipt" ? effectFence : undefined;
	const intentFence =
		effectFence && effectFence.kind !== "receipt" ? effectFence : undefined;
	const now = timestamps.now();
	const id = newId("review");
	const ticketNumber = await nextTicketNumber(env.DB, project.id);
	const screenshot = await persistScreenshot(env, project.id, id, payload.screenshotDataUrl);
	const screenshotFailureNote =
		payload.screenshotFailureNote ||
		(payload.screenshotDataUrl && !screenshot
			? "Review screenshot storage is not configured."
			: null);

	const revisionId = effectFence?.revisionId ?? (await canonicalRevisionId(env.DB, project.id));
	const canonicalEventId = `event_${crypto.randomUUID().replace(/-/g, "")}`;
	const auditEventId = `audit_${crypto.randomUUID()}`;
	let feedbackStatement = intentFence
		? env.DB.prepare(
			`INSERT INTO review_feedback
		 (id, project_id, organization_id, ticket_number, client_feedback_id, name,
		  comment, status, page_url, pathname, page_url_key, screenshot_key,
		  screenshot_content_type, screenshot_size, screenshot_failure_note,
		  screenshot_mode, viewport_json, coordinates_json, selected_element_json,
		  capture_context_json, user_agent, submitted_by_user_id, submitted_by_email,
		  source, created_on, updated_on)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 FROM projects project
		 JOIN embed_review_operation_intents intent ON intent.id = ?
		 WHERE project.id = ? AND project.active_revision_id = ?
		   AND intent.project_id = project.id AND intent.revision_id = ?
		   AND intent.actor_user_id = ? AND intent.effect = 'feedback.create'
		   AND intent.confirmed_on = ? AND intent.completed_on IS NULL`,
		)
		: receiptFence
			? env.DB.prepare(
				`INSERT INTO review_feedback
		 (id, project_id, organization_id, ticket_number, client_feedback_id, name,
		  comment, status, page_url, pathname, page_url_key, screenshot_key,
		  screenshot_content_type, screenshot_size, screenshot_failure_note,
		  screenshot_mode, viewport_json, coordinates_json, selected_element_json,
		  capture_context_json, user_agent, submitted_by_user_id, submitted_by_email,
		  source, created_on, updated_on)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 FROM projects project
		 JOIN embed_review_operation_receipts receipt ON receipt.receipt_hash = ?
		 WHERE project.id = ? AND project.active_revision_id = ?
		   AND receipt.installation_id = ? AND receipt.project_id = project.id
		   AND receipt.revision_id = ? AND receipt.actor_user_id = ?
		   AND receipt.effect = 'feedback.create'
		   AND receipt.payload_digest = ? AND receipt.request_id = ?
		   AND receipt.claimed_on = ?`,
			)
		: env.DB.prepare(
			`INSERT INTO review_feedback
		 (id, project_id, organization_id, ticket_number, client_feedback_id, name,
		  comment, status, page_url, pathname, page_url_key, screenshot_key,
		  screenshot_content_type, screenshot_size, screenshot_failure_note,
		  screenshot_mode, viewport_json, coordinates_json, selected_element_json,
		  capture_context_json, user_agent, submitted_by_user_id, submitted_by_email,
		  source, created_on, updated_on)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	feedbackStatement = feedbackStatement.bind(
			id,
			project.id,
			project.organization_id || "",
			ticketNumber,
			payload.clientFeedbackId,
			payload.name,
			payload.comment,
			"New",
			payload.pageUrl,
			payload.pathname,
			payload.pageUrlKey,
			screenshot?.key || null,
			screenshot?.contentType || null,
			screenshot?.byteLength || null,
			screenshotFailureNote,
			payload.screenshotMode,
			stringifyJson(payload.viewport),
			stringifyJson(payload.coordinates),
			stringifyJson(payload.selectedElement),
			stringifyJson(payload.captureContext),
			payload.userAgent,
			user?.id || null,
			user?.email || null,
			user ? "web" : "api",
			now,
			now,
			...(intentFence
				? [
						intentFence.intentId,
						project.id,
						intentFence.revisionId,
						intentFence.revisionId,
						user?.id || "",
						intentFence.confirmedOn,
					]
				: receiptFence
					? [
							receiptFence.receiptHash,
							project.id,
							receiptFence.revisionId,
							receiptFence.installationId,
							receiptFence.revisionId,
							user?.id || "",
							receiptFence.payloadDigest,
							receiptFence.requestId,
							receiptFence.claimedOn,
						]
				: []),
		);
	const canonicalStatement = effectFence
		? env.DB
				.prepare(
					`INSERT INTO shiplet_events (
					 id, project_id, revision_id, actor_kind, actor_id, event_kind,
					 summary, canonical_status_category, custom_payload_json,
					 occurred_at, created_at
					) SELECT ?, ?, ?, ?, ?, 'review.feedback-created',
					 'Review feedback created', 'open', ?, ?, ?
					 WHERE EXISTS (
					  SELECT 1 FROM review_feedback WHERE id = ? AND project_id = ?
					 )`,
				)
				.bind(
					canonicalEventId,
					project.id,
					revisionId,
					canonicalActor(user, eventActor).kind,
					canonicalActor(user, eventActor).id,
					JSON.stringify({
						feedbackId: id,
						ticketNumber,
						pageUrl: payload.pageUrl,
					}),
					now,
					now,
					id,
					project.id,
				)
		: canonicalReviewEventStatement(env.DB, {
			projectId: project.id,
			revisionId,
			actor: canonicalActor(user, eventActor),
			eventKind: "review.feedback-created",
			summary: "Review feedback created",
			status: "New",
			payload: {
				feedbackId: id,
				ticketNumber,
				pageUrl: payload.pageUrl,
			},
			now,
		});
	const statements = intentFence
		? [
				env.DB
					.prepare(
						`UPDATE embed_review_operation_intents SET confirmed_on = ?
						 WHERE id = ? AND project_id = ? AND revision_id = ?
						   AND actor_user_id = ? AND effect = 'feedback.create'
						   AND confirmed_on IS NULL AND completed_on IS NULL
						   AND expires_on > ?`,
					)
					.bind(
						intentFence.confirmedOn,
						intentFence.intentId,
						project.id,
						intentFence.revisionId,
						user?.id || "",
						intentFence.confirmedOn,
					),
				feedbackStatement,
				canonicalStatement,
			]
		: receiptFence
			? [
					env.DB
						.prepare(
							`UPDATE embed_review_operation_receipts SET claimed_on = ?
							 WHERE receipt_hash = ? AND installation_id = ?
							   AND project_id = ? AND revision_id = ?
							   AND actor_user_id = ? AND effect = 'feedback.create'
							   AND payload_digest = ? AND request_id = ?
							   AND claimed_on IS NULL AND expires_on > ?`,
						)
						.bind(
							receiptFence.claimedOn,
							receiptFence.receiptHash,
							receiptFence.installationId,
							project.id,
							receiptFence.revisionId,
							user?.id || "",
							receiptFence.payloadDigest,
							receiptFence.requestId,
							receiptFence.claimedOn,
						),
					feedbackStatement,
					canonicalStatement,
				]
		: [feedbackStatement, canonicalStatement];
	if (effectFence) {
		statements.push(
			env.DB
				.prepare(
					`INSERT INTO shiplet_audit_events (
					 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
					 event_kind, summary, status_category, payload_json,
					 occurred_on, recorded_on
					) SELECT ?, ?, ?, NULL, 'human', ?, 'review.feedback_created',
					 'Feedback created through trusted confirmation', 'action_required',
					 ?, ?, ?
					 WHERE EXISTS (
					  SELECT 1 FROM review_feedback WHERE id = ? AND project_id = ?
					 )`,
				)
				.bind(
					auditEventId,
					project.id,
					effectFence.revisionId,
					user?.id || "",
					JSON.stringify({
						feedbackId: id,
						requestId: effectFence.requestId,
						logicalRevisionId: effectFence.revisionId,
					}),
					now,
					now,
					id,
					project.id,
				),
			...(intentFence ? [env.DB
				.prepare(
					`UPDATE embed_review_operation_intents SET completed_on = ?
					 WHERE id = ? AND project_id = ? AND revision_id = ?
					   AND actor_user_id = ? AND confirmed_on = ?
					   AND completed_on IS NULL
					   AND EXISTS (
					    SELECT 1 FROM review_feedback WHERE id = ? AND project_id = ?
					   )`,
				)
				.bind(
					now,
					intentFence.intentId,
					project.id,
					intentFence.revisionId,
					user?.id || "",
					intentFence.confirmedOn,
					id,
					project.id,
				)] : []),
		);
		statements.push(
			env.DB
				.prepare(
					`SELECT CASE WHEN
					 EXISTS (SELECT 1 FROM review_feedback WHERE id = ? AND project_id = ?)
					 AND EXISTS (SELECT 1 FROM shiplet_events WHERE id = ? AND project_id = ?)
					 AND EXISTS (SELECT 1 FROM shiplet_audit_events WHERE id = ? AND project_id = ?)
					 AND ${intentFence
						? `EXISTS (
					  SELECT 1 FROM embed_review_operation_intents
					  WHERE id = ? AND completed_on IS NOT NULL
					 )`
						: `EXISTS (
					  SELECT 1 FROM embed_review_operation_receipts
					  WHERE receipt_hash = ? AND claimed_on = ?
					 )`}
					 THEN 1 ELSE json_extract('shiplet_effect_commit_failed', '$.invalid') END
					 AS committed`,
				)
				.bind(
					id,
					project.id,
					canonicalEventId,
					project.id,
					auditEventId,
					project.id,
					...(intentFence
						? [intentFence.intentId]
						: [receiptFence!.receiptHash, receiptFence!.claimedOn]),
				),
		);
	}
	let results: D1Result<unknown>[];
	try {
		results = await env.DB.batch(statements);
	} catch {
		if (screenshot?.key && env.SHIPLET_ASSETS) {
			await env.SHIPLET_ASSETS.delete(screenshot.key);
		}
		return null;
	}
	if (
		intentFence &&
		(results[0]?.meta.changes !== 1 ||
			results[1]?.meta.changes !== 1 ||
			results[2]?.meta.changes !== 1 ||
			results[3]?.meta.changes !== 1 ||
			results[4]?.meta.changes !== 1)
	) {
		if (screenshot?.key && env.SHIPLET_ASSETS) {
			await env.SHIPLET_ASSETS.delete(screenshot.key);
		}
		return null;
	}
	if (
		receiptFence &&
		(results[0]?.meta.changes !== 1 ||
			results[1]?.meta.changes !== 1 ||
			results[2]?.meta.changes !== 1 ||
			results[3]?.meta.changes !== 1)
	) {
		if (screenshot?.key && env.SHIPLET_ASSETS) {
			await env.SHIPLET_ASSETS.delete(screenshot.key);
		}
		return null;
	}

	if (payload.mentions.length > 0) {
		await createReviewMentionsAndNotifications(
			env,
			project,
			{
				id,
				ticket_number: ticketNumber,
				ticket_label: `PF-${ticketNumber}`,
				comment: payload.comment,
				status: "New",
			},
			null,
			user,
			payload.mentions,
		);
	} else {
		await notifyWatchersForReviewEvent(env, {
			project,
			feedback: {
				id,
				ticket_number: ticketNumber,
				ticket_label: `PF-${ticketNumber}`,
				comment: payload.comment,
				status: "New",
			},
			replyId: null,
			actor: user,
			reason: "new_feedback",
		});
	}

	return getReviewFeedback(env.DB, project.id, id);
}

export async function listReviewFeedback(
	db: D1Database,
	projectId: string,
	options: {
		pageUrl?: string | null;
		status?: string | null;
		includeClosed?: boolean;
		limit?: number;
	} = {},
) {
	const where = ["project_id = ?"];
	const bindings: Array<string | number> = [projectId];

	if (options.pageUrl) {
		where.push("page_url_key = ?");
		bindings.push(buildPageUrlKey(options.pageUrl));
	}

	if (options.status && isReviewStatus(options.status)) {
		where.push("status = ?");
		bindings.push(options.status);
	} else if (!options.includeClosed) {
		where.push("status NOT IN ('Done', 'Dropped')");
	}

	const limit = Math.min(Math.max(options.limit || 100, 1), 250);
	const rows = await db
		.prepare(
			`SELECT * FROM review_feedback
			 WHERE ${where.join(" AND ")}
			 ORDER BY created_on DESC
			 LIMIT ?`,
		)
		.bind(...bindings, limit)
		.all<ReviewFeedbackRow>();

	return hydrateFeedbackRows(db, rows.results || []);
}

export async function listAccessibleReviewFeedback(
	db: D1Database,
	user: ShipletUser,
	options: {
		projectId?: string | null;
		status?: string | null;
		mentionedMe?: boolean;
		watched?: boolean;
		submittedByMe?: boolean;
		limit?: number;
	} = {},
) {
	const projects = await listProjectsForUser(db, user.id);
	const scopedProjects = options.projectId
		? projects.filter((project) => project.id === options.projectId)
		: projects;
	const rows: ReviewFeedbackRecord[] = [];
	for (const project of scopedProjects) {
		if (options.watched) {
			const watch = await getWatchStatus(db, project, user);
			if (!watch.watching) continue;
		}
		const feedback = await listReviewFeedback(db, project.id, {
			status: options.status,
			includeClosed: true,
			limit: 250,
		});
		for (const item of feedback) {
			rows.push({
				...item,
				project_name: project.name,
				project_subdomain: project.subdomain,
			});
		}
	}

	const filtered = rows.filter((item) => {
		if (options.submittedByMe && item.submitted_by_user_id !== user.id) {
			return false;
		}
		if (options.mentionedMe && !feedbackMentionsUser(item, user.id)) {
			return false;
		}
		return true;
	});

	const limit = Math.min(Math.max(options.limit || 100, 1), 250);
	return filtered
		.sort((a, b) => String(b.created_on).localeCompare(String(a.created_on)))
		.slice(0, limit);
}

export async function getReviewFeedback(
	db: D1Database,
	projectId: string,
	feedbackId: string,
) {
	const row = await db
		.prepare(`SELECT * FROM review_feedback WHERE project_id = ? AND id = ?`)
		.bind(projectId, feedbackId)
		.first<ReviewFeedbackRow>();
	if (!row) return null;
	const hydrated = await hydrateFeedbackRows(db, [row]);
	return hydrated[0] || null;
}

export async function getReviewScreenshot(
	env: Env,
	projectId: string,
	feedbackId: string,
) {
	const feedback = await getReviewFeedback(env.DB, projectId, feedbackId);
	if (!feedback?.screenshot_key || !env.REVIEW_ASSETS) return null;

	const object = await env.REVIEW_ASSETS.get(feedback.screenshot_key);
	if (!object?.body) return null;

	return { feedback, object };
}

export async function createReviewReply(
	db: D1Database,
	projectId: string,
	feedbackId: string,
	comment: string,
	user: ShipletUser | null,
) {
	const normalized = normalizeString(comment, MAX_COMMENT_LENGTH);
	if (!normalized) {
		throw new Response("Comment is required.", { status: 400 });
	}

	const feedback = await getReviewFeedback(db, projectId, feedbackId);
	if (!feedback) {
		throw new Response("Review feedback not found.", { status: 404 });
	}

	await db
		.prepare(
			`INSERT INTO review_feedback_replies
			 (id, feedback_id, project_id, comment, author_user_id, author_email, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId("reply"),
			feedbackId,
			projectId,
			normalized,
			user?.id || null,
			user?.email || null,
			timestamps.now(),
		)
		.run();

	return getReviewFeedback(db, projectId, feedbackId);
}

export async function createReviewReplyWithNotifications(
	env: Env,
	project: Project,
	feedbackId: string,
	comment: string,
	user: ShipletUser | null,
	mentions: ReviewMentionInput[] = [],
	eventActor?: CanonicalReviewActor,
) {
	const normalized = normalizeString(comment, MAX_COMMENT_LENGTH);
	if (!normalized) {
		throw new Response("Comment is required.", { status: 400 });
	}

	const feedback = await getReviewFeedback(env.DB, project.id, feedbackId);
	if (!feedback) {
		throw new Response("Review feedback not found.", { status: 404 });
	}

	const replyId = newId("reply");
	const now = timestamps.now();
	const revisionId = await canonicalRevisionId(env.DB, project.id);
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO review_feedback_replies
			 (id, feedback_id, project_id, comment, author_user_id, author_email, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
			replyId,
			feedbackId,
			project.id,
			normalized,
			user?.id || null,
			user?.email || null,
			now,
		),
		canonicalReviewEventStatement(env.DB, {
			projectId: project.id,
			revisionId,
			actor: canonicalActor(user, eventActor),
			eventKind: "review.reply-created",
			summary: "Review reply created",
			status: feedback.status,
			payload: { feedbackId, replyId },
			now,
		}),
	]);

	const target = {
		id: feedback.id,
		ticket_number: feedback.ticket_number,
		ticket_label: feedback.ticket_label,
		comment: feedback.comment,
		status: feedback.status,
	};
	if (mentions.length > 0) {
		await createReviewMentionsAndNotifications(
			env,
			project,
			target,
			replyId,
			user,
			mentions,
		);
	} else {
		await notifyWatchersForReviewEvent(env, {
			project,
			feedback: target,
			replyId,
			actor: user,
			reason: "reply",
		});
	}

	return getReviewFeedback(env.DB, project.id, feedbackId);
}

export async function updateReviewStatus(
	db: D1Database,
	projectId: string,
	feedbackId: string,
	status: string,
	event?: {
		revisionId: string;
		actor: CanonicalReviewActor;
	},
) {
	if (!isReviewStatus(status)) {
		throw new Response("Status is not supported.", { status: 400 });
	}

	const now = timestamps.now();
	const update = db
		.prepare(
			`UPDATE review_feedback
			 SET status = ?, updated_on = ?
			 WHERE project_id = ? AND id = ?`,
		)
		.bind(status, now, projectId, feedbackId);
	if (event) {
		await db.batch([
			update,
			canonicalReviewEventStatement(db, {
				projectId,
				revisionId: event.revisionId,
				actor: event.actor,
				eventKind: "review.status-changed",
				summary: "Review status changed",
				status,
				payload: { feedbackId, status },
				now,
			}),
		]);
	} else {
		await update.run();
	}

	const feedback = await getReviewFeedback(db, projectId, feedbackId);
	if (!feedback) {
		throw new Response("Review feedback not found.", { status: 404 });
	}
	return feedback;
}

export async function updateReviewStatusWithNotifications(
	env: Env,
	project: Project,
	feedbackId: string,
	status: string,
	user: ShipletUser | null,
	eventActor?: CanonicalReviewActor,
) {
	const feedback = await updateReviewStatus(
		env.DB,
		project.id,
		feedbackId,
		status,
		{
			revisionId: await canonicalRevisionId(env.DB, project.id),
			actor: canonicalActor(user, eventActor),
		},
	);
	await notifyWatchersForReviewEvent(env, {
		project,
		feedback,
		replyId: null,
		actor: user,
		reason: "status_changed",
	});
	return feedback;
}

export async function createReviewApiToken(
	db: D1Database,
	projectId: string,
	name: string,
	scopes: unknown,
	user: ShipletUser,
) {
	const normalizedName = normalizeString(name, 120) || "Review API token";
	const normalizedScopes = normalizeScopes(scopes);
	const token = `${TOKEN_PREFIX}${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
	const tokenHash = await hashToken(token);
	const now = timestamps.now();
	const row: TokenRow = {
		id: newId("review_token"),
		project_id: projectId,
		name: normalizedName,
		token_hash: tokenHash,
		scopes: normalizedScopes.join(","),
		created_by_user_id: user.id,
		created_on: now,
		last_used_on: null,
		revoked_on: null,
	};

	await db
		.prepare(
			`INSERT INTO review_api_tokens
			 (id, project_id, name, token_hash, scopes, created_by_user_id, created_on, last_used_on, revoked_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.project_id,
			row.name,
			row.token_hash,
			row.scopes,
			row.created_by_user_id,
			row.created_on,
			row.last_used_on,
			row.revoked_on,
		)
		.run();

	return { token, record: publicToken(row) };
}

export async function createReviewCapabilityToken(input: {
	secret: string;
	projectId: string;
	viewer: ReviewCapabilityViewer;
	scopes: ReviewCapabilityScope[];
	expiresInSeconds: number;
	nonce?: string;
	now?: Date;
}) {
	const now = input.now || new Date();
	const expiresAt = new Date(
		now.getTime() + Math.max(1, input.expiresInSeconds) * 1000,
	);
	const payload = {
		v: 1,
		projectId: normalizeString(input.projectId, 160),
		viewer: {
			id: normalizeString(input.viewer.id, 160),
			email: normalizeString(input.viewer.email, 320),
			name: normalizeString(input.viewer.name, 240) || input.viewer.email,
			avatarPreset: normalizeOptionalString(input.viewer.avatarPreset, 240),
			avatarDataUrl: normalizeOptionalString(input.viewer.avatarDataUrl, 750_000),
		},
		scopes: normalizeCapabilityScopes(input.scopes),
		exp: Math.floor(expiresAt.getTime() / 1000),
		nonce: normalizeString(input.nonce, 160) || crypto.randomUUID(),
	};
	const encodedPayload = base64UrlEncodeJson(payload);
	const signature = await signCapabilityPayload(input.secret, encodedPayload);
	return `${CAPABILITY_TOKEN_PREFIX}${encodedPayload}.${signature}`;
}

export async function verifyReviewCapabilityToken(
	token: string,
	options: {
		secret: string;
		projectId: string;
		requiredScopes: ReviewCapabilityScope[];
		now?: Date;
	},
): Promise<
	| { ok: true; capability: ReviewCapability }
	| {
			ok: false;
			reason:
				| "malformed"
				| "invalid_signature"
				| "expired"
				| "wrong_project"
				| "missing_scope";
	  }
> {
	if (!token.startsWith(CAPABILITY_TOKEN_PREFIX)) {
		return { ok: false, reason: "malformed" };
	}
	const compact = token.slice(CAPABILITY_TOKEN_PREFIX.length);
	const [encodedPayload, signature, extra] = compact.split(".");
	if (!encodedPayload || !signature || extra !== undefined) {
		return { ok: false, reason: "malformed" };
	}
	const signatureValid = await verifyCapabilityPayload(
		options.secret,
		encodedPayload,
		signature,
	);
	if (!signatureValid) return { ok: false, reason: "invalid_signature" };

	const payload = base64UrlDecodeJson(encodedPayload);
	if (!isRecord(payload) || payload.v !== 1) {
		return { ok: false, reason: "malformed" };
	}
	const projectId = typeof payload.projectId === "string" ? payload.projectId : "";
	if (projectId !== options.projectId) {
		return { ok: false, reason: "wrong_project" };
	}
	const exp = typeof payload.exp === "number" ? payload.exp : 0;
	const nowSeconds = Math.floor((options.now || new Date()).getTime() / 1000);
	if (!exp || nowSeconds > exp) {
		return { ok: false, reason: "expired" };
	}
	const scopes = normalizeCapabilityScopes(payload.scopes);
	const missingScope = options.requiredScopes.some(
		(scope) => !scopes.includes(scope),
	);
	if (missingScope) return { ok: false, reason: "missing_scope" };

	const viewer = isRecord(payload.viewer) ? payload.viewer : {};
	const viewerId = normalizeString(viewer.id, 160);
	const viewerEmail = normalizeString(viewer.email, 320);
	if (!viewerId || !viewerEmail) return { ok: false, reason: "malformed" };

	return {
		ok: true,
		capability: {
			version: 1,
			projectId,
			viewer: {
				id: viewerId,
				email: viewerEmail,
				name: normalizeString(viewer.name, 240) || viewerEmail,
				avatarPreset: normalizeOptionalString(viewer.avatarPreset, 240) || null,
				avatarDataUrl:
					normalizeOptionalString(viewer.avatarDataUrl, 750_000) || null,
			},
			scopes,
			expiresAt: new Date(exp * 1000).toISOString(),
			nonce: normalizeString(payload.nonce, 160),
		},
	};
}

export async function listReviewApiTokens(
	db: D1Database,
	projectId: string,
) {
	const result = await db
		.prepare(
			`SELECT *
			 FROM review_api_tokens
			 WHERE project_id = ?
			 ORDER BY created_on DESC`,
		)
		.bind(projectId)
		.all<TokenRow>();
	return (result.results || []).map(publicToken);
}

export async function revokeReviewApiToken(
	db: D1Database,
	projectId: string,
	tokenId: string,
) {
	await db
		.prepare(
			`UPDATE review_api_tokens
			 SET revoked_on = ?
			 WHERE project_id = ? AND id = ? AND revoked_on IS NULL`,
		)
		.bind(timestamps.now(), projectId, tokenId)
		.run();

	const row = await db
		.prepare(
			`SELECT *
			 FROM review_api_tokens
			 WHERE project_id = ? AND id = ?`,
		)
		.bind(projectId, tokenId)
		.first<TokenRow>();
	return row ? publicToken(row) : null;
}

export async function authenticateReviewToken(
	db: D1Database,
	projectId: string,
	authorization: string | null | undefined,
	requiredScopes: ReviewScope[],
) {
	const token = parseBearerToken(authorization);
	if (!token) return null;
	const tokenHash = await hashToken(token);
	const row = await db
		.prepare(
			`SELECT * FROM review_api_tokens
			 WHERE project_id = ? AND token_hash = ? AND revoked_on IS NULL`,
		)
		.bind(projectId, tokenHash)
		.first<TokenRow>();
	if (!row) return null;

	const record = publicToken(row);
	const hasScopes = requiredScopes.every((scope) => record.scopes.includes(scope));
	if (!hasScopes) return null;

	await db
		.prepare(`UPDATE review_api_tokens SET last_used_on = ? WHERE id = ?`)
		.bind(timestamps.now(), row.id)
		.run();

	return record;
}

export async function requireProjectReviewer(
	env: Env,
	project: Project,
	user: ShipletUser | null,
): Promise<ShipletUser> {
	if (!user || !(await canViewProject(env.DB, project, user.id))) {
		throw new Response("Review feedback requires shiplet access.", {
			status: user ? 403 : 401,
		});
	}
	return user;
}

export async function handleReviewMcpRequest(
	env: Env,
	project: Project,
	token: ReviewTokenRecord,
	body: unknown,
) {
	const request = isRecord(body) ? body : {};
	const id = request.id ?? null;
	const method = typeof request.method === "string" ? request.method : "";
	const params = isRecord(request.params) ? request.params : {};

	try {
		if (method === "initialize") {
			return mcpResult(id, {
				protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: {
					name: `shiplet-review-${project.id}`,
					version: "0.1.0",
				},
			});
		}

		if (method === "tools/list") {
			return mcpResult(id, {
				tools: [
					{
						name: "list_feedback",
						description: "List review feedback tickets for this shiplet.",
						inputSchema: {
							type: "object",
							properties: {
								status: { type: "string" },
								includeClosed: { type: "boolean" },
								limit: { type: "number" },
							},
						},
					},
					{
						name: "get_feedback",
						description: "Get one review feedback ticket by id.",
						inputSchema: {
							type: "object",
							properties: { id: { type: "string" } },
							required: ["id"],
						},
					},
					{
						name: "update_feedback_status",
						description: "Update a review feedback ticket status.",
						inputSchema: {
							type: "object",
							properties: {
								id: { type: "string" },
								status: { type: "string" },
							},
							required: ["id", "status"],
						},
					},
					{
						name: "reply_to_feedback",
						description: "Add a reply to a review feedback ticket.",
						inputSchema: {
							type: "object",
							properties: {
								id: { type: "string" },
								comment: { type: "string" },
							},
							required: ["id", "comment"],
						},
					},
				],
			});
		}

		if (method === "tools/call") {
			const name = typeof params.name === "string" ? params.name : "";
			const args = isRecord(params.arguments) ? params.arguments : {};
			const result = await callReviewTool(env, project, token, name, args);
			return mcpResult(id, {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			});
		}

		return mcpError(id, -32601, "Method not found.");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return mcpError(id, -32000, message);
	}
}

async function callReviewTool(
	env: Env,
	project: Project,
	token: ReviewTokenRecord,
	name: string,
	args: JsonObject,
) {
	if (name === "list_feedback") {
		requireScope(token, "feedback:read");
		return {
			feedback: await listReviewFeedback(env.DB, project.id, {
				status: typeof args.status === "string" ? args.status : null,
				includeClosed: args.includeClosed === true,
				limit: typeof args.limit === "number" ? args.limit : undefined,
			}),
		};
	}

	if (name === "get_feedback") {
		requireScope(token, "feedback:read");
		const id = normalizeString(args.id, 120);
		return { feedback: id ? await getReviewFeedback(env.DB, project.id, id) : null };
	}

	if (name === "update_feedback_status") {
		requireScope(token, "feedback:write");
		const id = normalizeString(args.id, 120);
		const status = normalizeString(args.status, 80);
		return {
			feedback: await updateReviewStatusWithNotifications(
				env,
				project,
				id,
				status,
				null,
				{ kind: "agent", id: token.id },
			),
		};
	}

	if (name === "reply_to_feedback") {
		requireScope(token, "feedback:write");
		const id = normalizeString(args.id, 120);
		const comment = normalizeString(args.comment, MAX_COMMENT_LENGTH);
		return {
			feedback: await createReviewReplyWithNotifications(
				env,
				project,
				id,
				comment,
				null,
				normalizeMentionInputs(args.mentions),
				{ kind: "agent", id: token.id },
			),
		};
	}

	throw new Error(`Unknown review tool: ${name}`);
}

function requireScope(token: ReviewTokenRecord, scope: ReviewScope) {
	if (!token.scopes.includes(scope)) {
		throw new Error(`Review token is missing required scope: ${scope}`);
	}
}

async function hydrateFeedbackRows(db: D1Database, rows: ReviewFeedbackRow[]) {
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const placeholders = ids.map(() => "?").join(", ");
	const replyRows = await db
		.prepare(
			`SELECT * FROM review_feedback_replies
			 WHERE feedback_id IN (${placeholders})
			 ORDER BY created_on ASC`,
		)
		.bind(...ids)
		.all<ReviewReplyRow>();
	const repliesByFeedback = new Map<string, ReviewReplyRow[]>();
	for (const reply of replyRows.results || []) {
		const replies = repliesByFeedback.get(reply.feedback_id) || [];
		replies.push(reply);
		repliesByFeedback.set(reply.feedback_id, replies);
	}

	const mentionsByFeedback = await listReviewMentions(db, ids);

	const userIds = Array.from(
		new Set(rows.map((row) => row.submitted_by_user_id).filter(Boolean)),
	) as string[];
	const avatarsByUserId = new Map<
		string,
		{ avatar_preset: string | null; avatar_data_url: string | null }
	>();
	if (userIds.length > 0) {
		const userPlaceholders = userIds.map(() => "?").join(", ");
		const userRows = await db
			.prepare(
				`SELECT id, avatar_preset, avatar_data_url
				 FROM users
				 WHERE id IN (${userPlaceholders})`,
			)
			.bind(...userIds)
			.all<{
				id: string;
				avatar_preset: string | null;
				avatar_data_url: string | null;
			}>();
		for (const user of userRows.results || []) {
			avatarsByUserId.set(user.id, {
				avatar_preset: user.avatar_preset,
				avatar_data_url: user.avatar_data_url,
			});
		}
	}

	return rows.map((row) =>
		hydrateFeedbackRow(
			row,
			repliesByFeedback.get(row.id) || [],
			mentionsByFeedback.get(row.id) || [],
			row.submitted_by_user_id
				? avatarsByUserId.get(row.submitted_by_user_id) || null
				: null,
		),
	);
}

function hydrateFeedbackRow(
	row: ReviewFeedbackRow,
	replies: ReviewReplyRow[],
	mentions: ReviewMentionRecord[],
	avatar: { avatar_preset: string | null; avatar_data_url: string | null } | null,
): ReviewFeedbackRecord {
	const feedbackMentions = mentions.filter((mention) => !mention.reply_id);
	const mentionsByReply = new Map<string, ReviewMentionRecord[]>();
	for (const mention of mentions) {
		if (!mention.reply_id) continue;
		const replyMentions = mentionsByReply.get(mention.reply_id) || [];
		replyMentions.push(mention);
		mentionsByReply.set(mention.reply_id, replyMentions);
	}
	return {
		...row,
		ticket_label: `PF-${row.ticket_number}`,
		status: isReviewStatus(row.status) ? row.status : "New",
		screenshot_url: row.screenshot_key
			? reviewScreenshotUrl(row.project_id, row.id)
			: null,
		screenshot_mode: row.screenshot_mode === "element" ? "element" : "page",
		viewport: parseJson(row.viewport_json),
		coordinates: parseJson(row.coordinates_json),
		selected_element: parseJson(row.selected_element_json),
		capture_context: parseJson(row.capture_context_json),
		submitted_by_avatar_preset: avatar?.avatar_preset || null,
		submitted_by_avatar_data_url: avatar?.avatar_data_url || null,
		replies: replies.map((reply) => ({
			...reply,
			mentions: mentionsByReply.get(reply.id) || [],
		})),
		mentions: feedbackMentions,
	};
}

function feedbackMentionsUser(feedback: ReviewFeedbackRecord, userId: string) {
	if (feedback.mentions.some((mention) => mention.mentioned_user_id === userId)) {
		return true;
	}
	return feedback.replies.some((reply) =>
		reply.mentions.some((mention) => mention.mentioned_user_id === userId),
	);
}

export function reviewScreenshotUrl(projectId: string, feedbackId: string) {
	return `/api/projects/${encodeURIComponent(projectId)}/review-feedback/${encodeURIComponent(feedbackId)}/screenshot`;
}

async function nextTicketNumber(db: D1Database, projectId: string) {
	const row = await db
		.prepare(
			`SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_ticket_number
			 FROM review_feedback
			 WHERE project_id = ?`,
		)
		.bind(projectId)
		.first<{ next_ticket_number: number }>();
	return row?.next_ticket_number || 1;
}

async function persistScreenshot(
	env: Env,
	projectId: string,
	feedbackId: string,
	dataUrl: string | null,
) {
	if (!dataUrl) return null;
	if (!env.REVIEW_ASSETS) return null;
	const parsed = parseDataUrl(dataUrl);
	if (!parsed) {
		throw new Response("Screenshot must be a PNG, JPEG, or WebP data URL.", {
			status: 400,
		});
	}
	const key = `projects/${projectId}/feedback/${feedbackId}.${parsed.extension}`;
	await env.REVIEW_ASSETS.put(key, parsed.bytes, {
		httpMetadata: { contentType: parsed.contentType },
	});
	return {
		key,
		contentType: parsed.contentType,
		byteLength: parsed.bytes.byteLength,
	};
}

function parseDataUrl(dataUrl: string) {
	const match = dataUrl.match(
		/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/,
	);
	if (!match) return null;
	const contentType = match[1];
	const binary = atob(match[2]);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
		throw new Response("Screenshot must be 10MB or smaller.", { status: 400 });
	}
	const extension =
		contentType === "image/jpeg" ? "jpg" : contentType.replace("image/", "");
	return { contentType, bytes, extension };
}

function normalizeScreenshotDataUrl(value: unknown, errors: string[]) {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string") {
		errors.push("Screenshot must be a data URL.");
		return null;
	}
	try {
		parseDataUrl(value);
		return value;
	} catch (error) {
		if (error instanceof Response) {
			errors.push("Screenshot must be 10MB or smaller.");
			return null;
		}
		errors.push("Screenshot must be a PNG, JPEG, or WebP data URL.");
		return null;
	}
}

function normalizeScopes(scopes: unknown): ReviewScope[] {
	if (!Array.isArray(scopes)) return ["feedback:read", "mcp"];
	const normalized = scopes.filter((scope): scope is ReviewScope =>
		VALID_SCOPES.has(scope as ReviewScope),
	);
	return normalized.length > 0 ? Array.from(new Set(normalized)) : ["feedback:read", "mcp"];
}

function normalizeCapabilityScopes(scopes: unknown): ReviewCapabilityScope[] {
	const input = Array.isArray(scopes) ? scopes : [];
	const normalized = input.filter((scope): scope is ReviewCapabilityScope =>
		VALID_CAPABILITY_SCOPES.has(scope as ReviewCapabilityScope),
	);
	return Array.from(new Set(normalized));
}

function publicToken(row: TokenRow): ReviewTokenRecord {
	return {
		id: row.id,
		project_id: row.project_id,
		name: row.name,
		scopes: row.scopes
			.split(",")
			.filter((scope): scope is ReviewScope => VALID_SCOPES.has(scope as ReviewScope)),
		created_by_user_id: row.created_by_user_id,
		created_on: row.created_on,
		last_used_on: row.last_used_on,
		revoked_on: row.revoked_on,
	};
}

async function hashToken(token: string) {
	const encoded = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function capabilityKey(secret: string) {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

async function signCapabilityPayload(secret: string, encodedPayload: string) {
	const key = await capabilityKey(secret);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(encodedPayload),
	);
	return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function verifyCapabilityPayload(
	secret: string,
	encodedPayload: string,
	signature: string,
) {
	const signatureBytes = base64UrlDecodeBytes(signature);
	if (!signatureBytes) return false;
	const key = await capabilityKey(secret);
	return crypto.subtle.verify(
		"HMAC",
		key,
		signatureBytes,
		new TextEncoder().encode(encodedPayload),
	);
}

function base64UrlEncodeJson(value: unknown) {
	return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlDecodeJson(value: string) {
	const bytes = base64UrlDecodeBytes(value);
	if (!bytes) return null;
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeBytes(value: string) {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
	try {
		const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return null;
	}
}

function parseBearerToken(authorization: string | null | undefined) {
	if (!authorization) return null;
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

function mcpResult(id: unknown, result: unknown) {
	return {
		jsonrpc: "2.0",
		id,
		result,
	};
}

function mcpError(id: unknown, code: number, message: string) {
	return {
		jsonrpc: "2.0",
		id,
		error: { code, message },
	};
}

function buildPageUrlKey(pageUrl: string) {
	try {
		const url = new URL(pageUrl);
		return `${url.origin}${url.pathname}`;
	} catch {
		return pageUrl;
	}
}

function isReviewStatus(value: string): value is ReviewStatus {
	return (REVIEW_STATUSES as readonly string[]).includes(value);
}

function isHttpUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function normalizeJsonObject(value: unknown, label: string, errors: string[]) {
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) {
		errors.push(`${label} must be an object.`);
		return null;
	}
	return value;
}

function stringifyJson(value: JsonObject | null) {
	return value ? JSON.stringify(value) : null;
}

function parseJson(value: string | null): JsonObject | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function normalizeString(value: unknown, maxLength: number) {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function normalizeOptionalString(value: unknown, maxLength: number) {
	const normalized = normalizeString(value, maxLength);
	return normalized || null;
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]) {
	return Array.from(new Set(values));
}
