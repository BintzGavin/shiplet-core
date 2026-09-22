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
import {
	admitReviewRichPayload,
	compactReviewRichPayload,
	validateReviewRichPayload,
	type ReviewRichAttachmentAdmission,
	type ReviewRichPayloadDescriptor,
	type ReviewRichPayloadV1,
} from "./review-rich-payload";
import {
	buildDurableReviewSideEffects,
	dispatchDurableOperationEmails,
	type ReviewOperationRow,
} from "./review-operations";

export const REVIEW_STATUSES = [
	"New",
	"In Progress",
	"Blocked",
	"Staging",
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
	revision_id: string | null;
	ticket_number: number;
	ticket_label: string;
	client_feedback_id: string;
	name: string | null;
	comment: string;
	review_kind?: "comment" | "copy_request";
	copy_changes?: Array<Record<string, unknown>> | null;
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
	attachments?: ReviewAttachmentRecord[];
};

export type ReviewAttachmentRecord = {
	id: string;
	name: string;
	content_type: string;
	byte_length: number;
	digest: string;
	ordinal: number;
	content_url: string;
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
	| "copy_changes"
	| "attachments"
> & {
	viewport_json: string | null;
	coordinates_json: string | null;
	selected_element_json: string | null;
	capture_context_json: string | null;
	copy_changes_json: string | null;
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
			screenshotDescriptor?: ReviewScreenshotDescriptor | null;
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
	if (status === "New" || status === "Staging") return "open" as const;
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
const MAX_REVIEW_OPERATION_PAYLOAD_BYTES = 262_144;
const INLINE_REVIEW_SCREENSHOT_BYTES = 256 * 1024;
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

export type ReviewScreenshotDescriptor = {
	version: 1;
	contentType: "image/png" | "image/jpeg" | "image/webp";
	byteLength: number;
	digest: `sha256:${string}`;
};

type VerifiedReviewScreenshot = {
	key: string;
	contentType: ReviewScreenshotDescriptor["contentType"];
	byteLength: number;
};

type DurableReviewPayload = Record<string, unknown> & {
	screenshot?: ReviewScreenshotDescriptor;
};

type ReviewAttachmentMetadata = {
	id: string;
	name: string;
	contentType: string;
	byteLength: number;
	digest: string;
	ordinal: number;
	objectKey: string;
};

const MAX_RICH_ADMISSION_HANDOFFS = 8;
const MAX_RICH_ADMISSION_HANDOFF_BYTES = 16 * 1024 * 1024;
const richAttachmentAdmissionCache = new Map<string, ReviewRichAttachmentAdmission[]>();
let richAttachmentAdmissionCacheBytes = 0;

function richAdmissionByteLength(admitted: ReviewRichAttachmentAdmission[]) {
	return admitted.reduce((total, item) => total + item.bytes.byteLength, 0);
}

function forgetRichAdmission(payloadJson: string) {
	const existing = richAttachmentAdmissionCache.get(payloadJson);
	if (!existing) return;
	richAttachmentAdmissionCache.delete(payloadJson);
	richAttachmentAdmissionCacheBytes = Math.max(
		0,
		richAttachmentAdmissionCacheBytes - richAdmissionByteLength(existing),
	);
}

function rememberRichAdmission(payloadJson: string, admitted: ReviewRichAttachmentAdmission[]) {
	forgetRichAdmission(payloadJson);
	richAttachmentAdmissionCache.set(payloadJson, admitted);
	richAttachmentAdmissionCacheBytes += richAdmissionByteLength(admitted);
	while (
		richAttachmentAdmissionCache.size > MAX_RICH_ADMISSION_HANDOFFS ||
		richAttachmentAdmissionCacheBytes > MAX_RICH_ADMISSION_HANDOFF_BYTES
	) {
		const oldest = richAttachmentAdmissionCache.keys().next().value;
		if (typeof oldest !== "string") break;
		forgetRichAdmission(oldest);
	}
}

function consumeRichAdmission(payloadJson: string) {
	const admitted = richAttachmentAdmissionCache.get(payloadJson);
	if (admitted) forgetRichAdmission(payloadJson);
	return admitted;
}

export function reviewAttachmentUrl(
	projectId: string,
	feedbackId: string,
	attachmentId: string,
) {
	return `/api/projects/${encodeURIComponent(projectId)}/review-feedback/${encodeURIComponent(feedbackId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

function reviewAttachmentObjectKey(
	projectId: string,
	feedbackId: string,
	attachmentId: string,
	digest: string,
) {
	const safeDigest = digest.replace(/^sha256:/, "");
	return `projects/${projectId}/feedback/${feedbackId}/attachments/${attachmentId}/${safeDigest}`;
}

function captureContextWithRichPayload(
	payload: ValidReviewFeedbackPayload,
) {
	if (!payload.richPayload) return payload.captureContext;
	return {
		...(payload.captureContext || {}),
		screenshotAnnotations: payload.richPayload.screenshotAnnotations,
		captureFidelity: payload.richPayload.captureFidelity,
	};
}

async function stageReviewRichAttachments(
	env: Env,
	projectId: string,
	feedbackId: string,
	payload: ValidReviewFeedbackPayload,
	payloadJson?: string,
) {
	if (!payload.richPayload || payload.richPayload.attachments.length === 0) {
		return [] as ReviewAttachmentMetadata[];
	}
	if (!env.REVIEW_ASSETS) {
		throw new Response("Review attachment storage is not configured.", {
			status: 503,
		});
	}
	const admitted = payloadJson ? consumeRichAdmission(payloadJson) : undefined;
	try {
		if (!admitted && payloadJson) {
			const descriptor = parseRichPayloadDescriptor(payloadJson);
			if (descriptor) {
				const verified = await verifyRichAttachmentObjects(
					env,
					projectId,
					feedbackId,
					descriptor,
				);
				if (verified) return verified;
			}
		}
		const admittedItems = admitted || await admitReviewRichPayload(payload.richPayload);
		const metadata: ReviewAttachmentMetadata[] = [];
		for (const [ordinal, item] of admittedItems.entries()) {
			const key = reviewAttachmentObjectKey(
				projectId,
				feedbackId,
				item.input.id,
				item.input.digest,
			);
			try {
				await env.REVIEW_ASSETS.put(key, item.bytes, {
					httpMetadata: {
						contentType: item.input.contentType,
						contentDisposition:
							item.input.contentType === "image/svg+xml"
								? `attachment; filename="${safeAttachmentFileName(item.input.name)}"`
								: undefined,
					},
				});
				const stored = await env.REVIEW_ASSETS.get(key);
				if (!stored?.body) throw new Error("missing staged object");
				const bytes = new Uint8Array(await stored.arrayBuffer());
				const digest = await digestReviewAttachmentBytes(bytes);
				if (
					bytes.byteLength !== item.input.byteLength ||
					digest !== item.input.digest ||
					(stored.size !== undefined && stored.size !== item.input.byteLength) ||
					stored.httpMetadata?.contentType !== item.input.contentType
				) {
					throw new Error("staged object verification failed");
				}
			} catch {
				throw new Response("Review attachment upload is unavailable.", {
					status: 503,
				});
			}
			metadata.push({
				id: item.input.id,
				name: item.input.name,
				contentType: item.input.contentType,
				byteLength: item.input.byteLength,
				digest: item.input.digest,
				ordinal,
				objectKey: key,
			});
		}
		return metadata;
	} finally {
		if (payloadJson) forgetRichAdmission(payloadJson);
	}
}

async function digestReviewAttachmentBytes(bytes: Uint8Array) {
	const source = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
	return `sha256:${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function verifyRichAttachmentObjects(
	env: Env,
	projectId: string,
	feedbackId: string,
	descriptor: ReviewRichPayloadDescriptor,
) {
	if (!env.REVIEW_ASSETS) return null;
	const metadata: ReviewAttachmentMetadata[] = [];
	for (const [ordinal, attachment] of descriptor.attachments.entries()) {
		const key = reviewAttachmentObjectKey(projectId, feedbackId, attachment.id, attachment.digest);
		try {
			const object = await env.REVIEW_ASSETS.get(key);
			if (!object?.body) return null;
			const bytes = new Uint8Array(await object.arrayBuffer());
			if (
				bytes.byteLength !== attachment.byteLength ||
				attachment.size !== attachment.byteLength ||
				(await digestReviewAttachmentBytes(bytes)) !== attachment.digest ||
				(object.size !== undefined && object.size !== attachment.byteLength) ||
				object.httpMetadata?.contentType !== attachment.contentType
			) return null;
		} catch {
			return null;
		}
		metadata.push({
			id: attachment.id,
			name: attachment.name,
			contentType: attachment.contentType,
			byteLength: attachment.byteLength,
			digest: attachment.digest,
			ordinal,
			objectKey: key,
		});
	}
	return metadata;
}

function safeAttachmentFileName(name: string) {
	const basename = name.replace(/[\\/\r\n\u0000-\u001f\u007f]/g, "_").slice(0, 180);
	return basename || "attachment";
}

function parseRichPayloadDescriptor(value: unknown): ReviewRichPayloadDescriptor | null {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return null;
		}
	}
	if (!isRecord(parsed) || !isRecord(parsed.richPayload)) return null;
	const rich = parsed.richPayload;
	if (
		rich.version !== 1 ||
		!Array.isArray(rich.attachments) ||
		rich.attachments.length > 4 ||
		Object.keys(rich).length !== 5 ||
		!["version", "screenshotAnnotations", "captureFidelity", "attachments", "copyRequest"].every((key) => Object.prototype.hasOwnProperty.call(rich, key))
	) return null;
	for (const attachment of rich.attachments) {
		if (!isRecord(attachment) ||
			Object.keys(attachment).length !== 7 ||
			!["id", "name", "mimeType", "size", "byteLength", "digest", "contentType"].every((key) => Object.prototype.hasOwnProperty.call(attachment, key)) ||
			typeof attachment.id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(attachment.id) ||
			typeof attachment.name !== "string" ||
			attachment.name.length < 1 || attachment.name.length > 255 ||
			typeof attachment.mimeType !== "string" ||
			typeof attachment.size !== "number" ||
			!Number.isInteger(attachment.size) || attachment.size < 1 || attachment.size > 5 * 1024 * 1024 ||
				typeof attachment.byteLength !== "number" ||
				!Number.isInteger(attachment.byteLength) || attachment.byteLength < 1 || attachment.byteLength > 5 * 1024 * 1024 ||
				attachment.size !== attachment.byteLength ||
			typeof attachment.digest !== "string" ||
			typeof attachment.contentType !== "string" ||
			!new Set([
				"image/gif", "image/heic", "image/jpeg", "image/png", "image/svg+xml",
				"image/tiff", "image/webp", "image/vnd.microsoft.icon", "video/x-amv",
				"video/x-ms-asf", "video/x-msvideo", "video/x-f4v", "video/x-flv",
				"video/mp4", "application/mp4", "video/webm", "video/quicktime", "video/mpeg",
			]).has(attachment.mimeType) ||
			!new Set([
				"image/gif", "image/heic", "image/jpeg", "image/png", "image/svg+xml",
				"image/tiff", "image/webp", "image/vnd.microsoft.icon", "video/x-amv",
				"video/x-ms-asf", "video/x-msvideo", "video/x-f4v", "video/x-flv",
				"video/mp4", "video/webm", "video/quicktime", "video/mpeg",
			]).has(attachment.contentType) ||
			!/^sha256:[0-9a-f]{64}$/.test(attachment.digest)) return null;
	}
	return rich as ReviewRichPayloadDescriptor;
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string) {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return `data:${contentType};base64,${btoa(binary)}`;
}

export async function materializeReviewRichPayload(
	env: Env,
	operation: ReviewOperationRow,
) {
	const descriptor = parseRichPayloadDescriptor(operation.payload_json);
	if (!descriptor || descriptor.attachments.length === 0) {
		return descriptor
	}
	if (!env.REVIEW_ASSETS || !operation.result_feedback_id) {
		throw new Response("Review attachment upload is unavailable.", { status: 503 });
	}
	const attachments = [];
	for (const attachment of descriptor.attachments) {
		const key = reviewAttachmentObjectKey(
			operation.project_id,
			operation.result_feedback_id,
			attachment.id,
			attachment.digest,
		);
		const object = await env.REVIEW_ASSETS.get(key);
		if (!object?.body) throw new Response("Review attachment upload is unavailable.", { status: 503 });
		const bytes = new Uint8Array(await object.arrayBuffer());
		const digest = await digestReviewAttachmentBytes(bytes);
		if (
			bytes.byteLength !== attachment.byteLength ||
			digest !== attachment.digest ||
			(object.size !== undefined && object.size !== attachment.byteLength) ||
			object.httpMetadata?.contentType !== attachment.contentType
		) {
			throw new Response("Review attachment verification failed.", { status: 503 });
		}
		attachments.push({
			id: attachment.id,
			name: attachment.name,
			mimeType: attachment.mimeType,
			size: attachment.byteLength,
			dataUrl: bytesToDataUrl(bytes, attachment.contentType),
		});
	}
	return {
		version: 1 as const,
		screenshotAnnotations: descriptor.screenshotAnnotations,
		captureFidelity: descriptor.captureFidelity,
		attachments,
		copyRequest: descriptor.copyRequest,
	} satisfies ReviewRichPayloadV1;
}

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
		richPayload: ReviewRichPayloadV1 | null;
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
	const richValidation =
		input.richPayload === undefined || input.richPayload === null
			? { ok: true as const, value: null }
			: validateReviewRichPayload(input.richPayload, comment);
	if (!richValidation.ok) errors.push(...richValidation.errors);

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
			richPayload: richValidation.ok ? richValidation.value : null,
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
	const durableIntent = intentFence
		? await env.DB
				.prepare(
					`SELECT * FROM embed_review_operation_intents WHERE id = ? LIMIT 1`,
				)
				.bind(intentFence.intentId)
					.first<ReviewOperationRow>()
			: null;
	const now = timestamps.now();
	const id = durableIntent?.result_feedback_id || newId("review");
	const ticketNumber = await nextTicketNumber(env.DB, project.id);
	const durableScreenshotDescriptor = durableIntent
		? durableReviewScreenshotDescriptor(durableIntent.payload_json)
		: null;
	const screenshot = durableScreenshotDescriptor
		? await promoteStagedScreenshot(env, durableIntent!, durableScreenshotDescriptor)
		: await persistScreenshot(env, project.id, id, payload.screenshotDataUrl);
	const screenshotFailureNote =
		payload.screenshotFailureNote ||
		((payload.screenshotDataUrl || durableScreenshotDescriptor) && !screenshot
			? "Review screenshot storage is not configured."
			: null);
	const attachmentMetadata = await stageReviewRichAttachments(
		env,
		project.id,
		id,
		payload,
		durableIntent?.payload_json,
	);
	const captureContext = captureContextWithRichPayload(payload);
	const reviewKind = payload.richPayload?.copyRequest ? "copy_request" : "comment";
	const copyChangesJson = payload.richPayload?.copyRequest
		? JSON.stringify(payload.richPayload.copyRequest.changes)
		: null;

	const revisionId = effectFence?.revisionId ?? (await canonicalRevisionId(env.DB, project.id));
	const canonicalEventId =
		durableIntent?.result_event_id || `event_${crypto.randomUUID().replace(/-/g, "")}`;
	const auditEventId = `audit_${crypto.randomUUID()}`;
	let feedbackStatement = intentFence
		? env.DB.prepare(
			`INSERT INTO review_feedback
		 (id, project_id, organization_id, revision_id, ticket_number, client_feedback_id, name,
			 comment, review_kind, copy_changes_json, status, page_url, pathname, page_url_key, screenshot_key,
		  screenshot_content_type, screenshot_size, screenshot_failure_note,
		  screenshot_mode, viewport_json, coordinates_json, selected_element_json,
		  capture_context_json, user_agent, submitted_by_user_id, submitted_by_email,
		  source, created_on, updated_on)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 FROM projects project
		 JOIN embed_review_operation_intents intent ON intent.id = ?
		 WHERE project.id = ? AND project.active_revision_id = ?
		   AND intent.project_id = project.id AND intent.revision_id = ?
		   AND intent.actor_user_id = ? AND intent.effect = 'feedback.create'
		   AND intent.confirmed_on = ? AND intent.completed_on IS NULL
		   AND (
		    intent.installation_id LIKE 'managed:%'
		    OR EXISTS (
		     SELECT 1 FROM embed_installations installation
		     WHERE installation.id = intent.installation_id
		       AND installation.project_id = project.id AND installation.revoked_on IS NULL
		    )
		   )
		   AND (
		    project.visibility IN ('public', 'unlisted')
		    OR project.owner_user_id = intent.actor_user_id
		    OR EXISTS (
		     SELECT 1 FROM organization_memberships membership
		     WHERE membership.organization_id = project.organization_id
		       AND membership.user_id = intent.actor_user_id
		       AND (project.visibility = 'organization' OR lower(membership.role) IN ('admin', 'owner'))
		    )
		    OR EXISTS (
		     SELECT 1 FROM shiplet_access_grants grant_row
		     WHERE grant_row.project_id = project.id
		       AND grant_row.target_type = 'user' AND grant_row.target_id = intent.actor_user_id
		    )
		    OR EXISTS (
		     SELECT 1 FROM shiplet_access_grants grant_row
		     JOIN organization_memberships membership
		       ON membership.organization_id = grant_row.target_id
		     WHERE grant_row.project_id = project.id AND grant_row.target_type = 'organization'
		       AND membership.user_id = intent.actor_user_id
		    )
		    OR EXISTS (
		     SELECT 1 FROM shiplet_access_grants grant_row
		     JOIN team_memberships membership ON membership.team_id = grant_row.target_id
		     WHERE grant_row.project_id = project.id AND grant_row.target_type = 'team'
		       AND membership.user_id = intent.actor_user_id
		    )
		   )`,
		)
		: receiptFence
			? env.DB.prepare(
				`INSERT INTO review_feedback
		 (id, project_id, organization_id, revision_id, ticket_number, client_feedback_id, name,
			 comment, review_kind, copy_changes_json, status, page_url, pathname, page_url_key, screenshot_key,
		  screenshot_content_type, screenshot_size, screenshot_failure_note,
		  screenshot_mode, viewport_json, coordinates_json, selected_element_json,
		  capture_context_json, user_agent, submitted_by_user_id, submitted_by_email,
		  source, created_on, updated_on)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
		 (id, project_id, organization_id, revision_id, ticket_number, client_feedback_id, name,
			 comment, review_kind, copy_changes_json, status, page_url, pathname, page_url_key, screenshot_key,
		  screenshot_content_type, screenshot_size, screenshot_failure_note,
		  screenshot_mode, viewport_json, coordinates_json, selected_element_json,
		  capture_context_json, user_agent, submitted_by_user_id, submitted_by_email,
		 source, created_on, updated_on)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
	feedbackStatement = feedbackStatement.bind(
			id,
			project.id,
			project.organization_id || "",
			revisionId,
			ticketNumber,
			payload.clientFeedbackId,
			payload.name,
			payload.comment,
			reviewKind,
			copyChangesJson,
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
			stringifyJson(captureContext),
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
	const attachmentStatements = attachmentMetadata.map((attachment) =>
		env.DB.prepare(
			`INSERT INTO review_feedback_attachments
			 (project_id, feedback_id, attachment_id, ordinal, file_name,
			  content_type, byte_length, digest, object_key, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			project.id,
			id,
			attachment.id,
			attachment.ordinal,
			attachment.name,
			attachment.contentType,
			attachment.byteLength,
			attachment.digest,
			attachment.objectKey,
			now,
		),
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
				...attachmentStatements,
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
					...attachmentStatements,
					canonicalStatement,
			]
		: [feedbackStatement, ...attachmentStatements, canonicalStatement];
	const canonicalStatementIndex =
		(effectFence ? 2 : 1) + attachmentStatements.length;
	const durableSideEffectStatements: D1PreparedStatement[] =
		intentFence && durableIntent && user
			? await buildDurableReviewSideEffects(env, {
					operation: durableIntent,
					project,
					actor: user,
					feedbackId: id,
					replyId: null,
					ticketNumber,
					mentions: payload.mentions,
					reason: "new_feedback",
					now,
				})
			: [];
	if (intentFence && durableIntent && user) {
		statements.push(...durableSideEffectStatements);
	}
	const auditStatementIndex = statements.length;
	const completionStatementIndex = intentFence
		? auditStatementIndex + 1
		: -1;
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
					`UPDATE embed_review_operation_intents SET completed_on = ?,
					 result_feedback_id = ?, result_event_id = ?
					 WHERE id = ? AND project_id = ? AND revision_id = ?
					   AND actor_user_id = ? AND confirmed_on = ?
					   AND completed_on IS NULL
					   AND EXISTS (
					    SELECT 1 FROM review_feedback WHERE id = ? AND project_id = ?
					   )`,
				)
				.bind(
					now,
					id,
					canonicalEventId,
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
			if (!intentFence && screenshot?.key && env.REVIEW_ASSETS) {
				await env.REVIEW_ASSETS.delete(screenshot.key);
		}
		return null;
	}
	const requiredBatchChangeIndexes = effectFence
		? [
				0,
				1,
				...attachmentStatements.map((_, index) => 2 + index),
				canonicalStatementIndex,
				auditStatementIndex,
				...(intentFence ? [completionStatementIndex] : []),
			]
		: [];
	if (requiredBatchChangeIndexes.some((index) => results[index]?.meta.changes !== 1)) {
		if (!intentFence && screenshot?.key && env.REVIEW_ASSETS) {
			await env.REVIEW_ASSETS.delete(screenshot.key);
		}
		return null;
	}

	if (intentFence) {
		await dispatchDurableOperationEmails(env, project, intentFence.intentId, id);
	} else if (payload.mentions.length > 0) {
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

export type ReviewFeedbackQueryState = "open" | "closed" | "all";

export type ReviewFeedbackPageOptions = {
	pageUrl?: string | null;
	pagePrefix?: string | null;
	siteOrigin?: string | null;
	status?: string | null;
	state?: ReviewFeedbackQueryState;
	revisionId?: string | null;
	submittedByUserId?: string | null;
	mentionedUserId?: string | null;
	cursor?: string | null;
	cursorActor?: string | null;
	limit?: number;
	maxLimit?: number;
};

export type ReviewFeedbackPage = {
	feedback: ReviewFeedbackRecord[];
	nextCursor: string | null;
};

type ReviewFeedbackCursor = {
	v: 1;
	createdOn: string;
	id: string;
	scope: string;
};

export async function listReviewFeedbackPage(
	db: D1Database,
	projectId: string,
	options: ReviewFeedbackPageOptions = {},
): Promise<ReviewFeedbackPage> {
	const where = ["feedback.project_id = ?"];
	const bindings: Array<string | number> = [projectId];
	const pageUrlKey = options.pageUrl
		? normalizedReviewPageUrlKey(options.pageUrl, "page URL")
		: null;
	const pagePrefixKey = options.pagePrefix
		? normalizedReviewPagePrefixKey(options.pagePrefix)
		: null;
	const siteOrigin = options.siteOrigin
		? normalizedReviewSiteOrigin(options.siteOrigin)
		: null;
	const scopeCount = [pageUrlKey, pagePrefixKey, siteOrigin].filter(Boolean).length;
	if (scopeCount > 1) {
		throw new Response("Choose only one review page scope", { status: 400 });
	}

	if (pageUrlKey) {
		where.push("feedback.page_url_key = ?");
		bindings.push(pageUrlKey);
	} else if (pagePrefixKey) {
		const prefix = reviewPagePrefixPredicate(pagePrefixKey);
		where.push(prefix.sql);
		bindings.push(...prefix.bindings);
	} else if (siteOrigin) {
		const prefix = reviewPagePrefixPredicate(`${siteOrigin}/`);
		where.push(prefix.sql);
		bindings.push(...prefix.bindings);
	}

	if (options.status && isReviewStatus(options.status)) {
		where.push("feedback.status = ?");
		bindings.push(options.status);
	} else if ((options.state || "open") === "open") {
		where.push("feedback.status NOT IN ('Done', 'Dropped')");
	} else if (options.state === "closed") {
		where.push("feedback.status IN ('Done', 'Dropped')");
	}

	if (options.revisionId) {
		where.push("feedback.revision_id = ?");
		bindings.push(options.revisionId);
	}
	if (options.submittedByUserId) {
		where.push("feedback.submitted_by_user_id = ?");
		bindings.push(options.submittedByUserId);
	}
	if (options.mentionedUserId) {
		where.push(
			`EXISTS (
			 SELECT 1 FROM review_feedback_mentions mention
			 WHERE mention.feedback_id = feedback.id
			   AND mention.mentioned_user_id = ?
			)`,
		);
		bindings.push(options.mentionedUserId);
	}

	const scope = await reviewFeedbackCursorScope(projectId, {
		pageUrlKey,
		pagePrefixKey,
		siteOrigin,
		status: options.status && isReviewStatus(options.status) ? options.status : null,
		state: options.status && isReviewStatus(options.status)
			? null
			: options.state || "open",
		revisionId: options.revisionId || null,
		submittedByUserId: options.submittedByUserId || null,
		mentionedUserId: options.mentionedUserId || null,
		actor: options.cursorActor || null,
	});
	if (options.cursor) {
		const cursor = decodeReviewFeedbackCursor(options.cursor);
		if (!cursor || cursor.scope !== scope) {
			throw new Response("Review feedback cursor does not match this query", {
				status: 400,
			});
		}
		where.push(
			"(feedback.created_on < ? OR (feedback.created_on = ? AND feedback.id < ?))",
		);
		bindings.push(cursor.createdOn, cursor.createdOn, cursor.id);
	}

	const maxLimit = Math.min(Math.max(options.maxLimit || 100, 1), 250);
	const limit = Math.min(Math.max(options.limit || 100, 1), maxLimit);
	const rows = await db
		.prepare(
			`SELECT feedback.* FROM review_feedback feedback
			 WHERE ${where.join(" AND ")}
			 ORDER BY feedback.created_on DESC, feedback.id DESC
			 LIMIT ?`,
		)
		.bind(...bindings, limit + 1)
		.all<ReviewFeedbackRow>();
	const pageRows = (rows.results || []).slice(0, limit);
	const last = pageRows.at(-1);
	const nextCursor =
		(rows.results?.length || 0) > limit && last
			? encodeReviewFeedbackCursor({
					v: 1,
					createdOn: last.created_on,
					id: last.id,
					scope,
				})
			: null;
	return {
		feedback: await hydrateFeedbackRows(db, pageRows),
		nextCursor,
	};
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
	const page = await listReviewFeedbackPage(db, projectId, {
		pageUrl: options.pageUrl,
		status: options.status,
		state: options.includeClosed ? "all" : "open",
		limit: options.limit,
		maxLimit: 250,
	});
	return page.feedback;
}

function normalizedReviewPageUrlKey(value: string, label: string) {
	const url = normalizedReviewQueryUrl(value, label);
	return buildPageUrlKey(url.toString());
}

function normalizedReviewPagePrefixKey(value: string) {
	const url = normalizedReviewQueryUrl(value, "page prefix");
	const hashRoute = url.hash.startsWith("#/");
	const hashPath = hashRoute ? url.hash.slice(1).split("?")[0] : "";
	if (/%(?:2f|5c)/i.test(url.pathname) || /%(?:2f|5c)/i.test(hashPath)) {
		throw new Response("Review page prefix cannot contain encoded separators", {
			status: 400,
		});
	}
	url.search = "";
	if (hashRoute) {
		const normalizedHashPath =
			hashPath.length > 1 ? hashPath.replace(/\/+$/, "") : hashPath;
		return `${url.origin}${url.pathname}#${normalizedHashPath}`;
	}
	url.hash = "";
	if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${url.pathname}`;
}

function normalizedReviewSiteOrigin(value: string) {
	const url = normalizedReviewQueryUrl(value, "site origin");
	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Response("Review site origin must not include a route", {
			status: 400,
		});
	}
	return url.origin;
}

function normalizedReviewQueryUrl(value: string, label: string) {
	if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
		throw new Response(`Invalid review ${label}`, { status: 400 });
	}
	try {
		const url = new URL(value);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password
		) {
			throw new TypeError("invalid URL");
		}
		return url;
	} catch {
		throw new Response(`Invalid review ${label}`, { status: 400 });
	}
}

function reviewPagePrefixPredicate(prefixKey: string) {
	if (prefixKey.endsWith("/")) {
		return {
			sql: "substr(feedback.page_url_key, 1, length(?)) COLLATE BINARY = ? COLLATE BINARY",
			bindings: [prefixKey, prefixKey] as Array<string | number>,
		};
	}
	const routePrefix = prefixKey.includes("#/");
	return {
		sql: routePrefix
			? "(feedback.page_url_key COLLATE BINARY = ? OR (substr(feedback.page_url_key, 1, length(?)) COLLATE BINARY = ? COLLATE BINARY AND substr(feedback.page_url_key, length(?) + 1, 1) = '/'))"
			: "(feedback.page_url_key COLLATE BINARY = ? OR (substr(feedback.page_url_key, 1, length(?)) COLLATE BINARY = ? COLLATE BINARY AND substr(feedback.page_url_key, length(?) + 1, 1) IN ('/', '#')))",
		bindings: [prefixKey, prefixKey, prefixKey, prefixKey] as Array<string | number>,
	};
}

async function reviewFeedbackCursorScope(
	projectId: string,
	filters: Record<string, string | null>,
) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify({ projectId, ...filters })),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function encodeReviewFeedbackCursor(cursor: ReviewFeedbackCursor) {
	const bytes = new TextEncoder().encode(JSON.stringify(cursor));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeReviewFeedbackCursor(value: string): ReviewFeedbackCursor | null {
	if (value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
		return null;
	}
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
			Math.ceil(value.length / 4) * 4,
			"=",
		);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ReviewFeedbackCursor>;
		if (
			parsed.v !== 1 ||
			typeof parsed.createdOn !== "string" ||
			parsed.createdOn.length === 0 ||
			parsed.createdOn.length > 64 ||
			typeof parsed.id !== "string" ||
			parsed.id.length === 0 ||
			parsed.id.length > 256 ||
			typeof parsed.scope !== "string" ||
			!/^[a-f0-9]{64}$/.test(parsed.scope)
		) {
			return null;
		}
		return parsed as ReviewFeedbackCursor;
	} catch {
		return null;
	}
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
		const page = await listReviewFeedbackPage(db, project.id, {
			status: options.status,
			state: "all",
			submittedByUserId: options.submittedByMe ? user.id : null,
			mentionedUserId: options.mentionedMe ? user.id : null,
			limit: 250,
			maxLimit: 250,
		});
		for (const item of page.feedback) {
			rows.push({
				...item,
				project_name: project.name,
				project_subdomain: project.subdomain,
			});
		}
	}

	const limit = Math.min(Math.max(options.limit || 100, 1), 250);
	return rows
		.sort(
			(a, b) =>
				String(b.created_on).localeCompare(String(a.created_on)) ||
				String(b.id).localeCompare(String(a.id)),
		)
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

export async function getReviewAttachment(
	env: Env,
	projectId: string,
	feedbackId: string,
	attachmentId: string,
) {
	if (!env.REVIEW_ASSETS) return null;
	const row = await env.DB
		.prepare(
			`SELECT project_id, feedback_id, attachment_id, ordinal, file_name,
				content_type, byte_length, digest, object_key
			 FROM review_feedback_attachments
			 WHERE project_id = ? AND feedback_id = ? AND attachment_id = ?
			 LIMIT 1`,
		)
		.bind(projectId, feedbackId, attachmentId)
		.first<{
			project_id: string;
			feedback_id: string;
			attachment_id: string;
			ordinal: number;
			file_name: string;
			content_type: string;
			byte_length: number;
			digest: string;
			object_key: string;
		}>();
	if (!row) return null;
	const expectedKey = reviewAttachmentObjectKey(
		projectId,
		feedbackId,
		attachmentId,
		row.digest,
	);
	if (row.object_key !== expectedKey) return null;
	const object = await env.REVIEW_ASSETS.get(expectedKey);
	if (!object?.body) return null;
	const bytes = new Uint8Array(await object.arrayBuffer());
	const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const digest = `sha256:${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	if (
		bytes.byteLength !== row.byte_length ||
		digest !== row.digest ||
		object.httpMetadata?.contentType !== row.content_type
	) return null;
	return {
		metadata: {
			id: row.attachment_id,
			name: row.file_name,
			content_type: row.content_type,
			byte_length: row.byte_length,
			digest: row.digest,
			ordinal: row.ordinal,
			content_url: reviewAttachmentUrl(projectId, feedbackId, row.attachment_id),
		},
		body: bytes,
	};
}

export async function createReviewReply(
	db: D1Database,
	projectId: string,
	feedbackId: string,
	comment: string,
	user: ShipletUser | null,
) {
	const normalized = normalizeReviewReplyComment(comment);
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
	const normalized = normalizeReviewReplyComment(comment);
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
	const repliesByFeedback = new Map<string, ReviewReplyRow[]>();
	const mentionsByFeedback = new Map<string, ReviewMentionRecord[]>();
	const attachmentsByFeedback = new Map<string, ReviewAttachmentRecord[]>();
	for (const feedbackIds of chunkReviewFeedbackIds(ids)) {
		const placeholders = feedbackIds.map(() => "?").join(", ");
		const replyRows = await db
			.prepare(
				`SELECT * FROM review_feedback_replies
				 WHERE feedback_id IN (${placeholders})
				 ORDER BY created_on ASC`,
			)
			.bind(...feedbackIds)
			.all<ReviewReplyRow>();
		for (const reply of replyRows.results || []) {
			const replies = repliesByFeedback.get(reply.feedback_id) || [];
			replies.push(reply);
			repliesByFeedback.set(reply.feedback_id, replies);
		}

		const mentions = await listReviewMentions(db, feedbackIds);
			for (const [feedbackId, feedbackMentions] of mentions) {
				mentionsByFeedback.set(feedbackId, feedbackMentions);
			}
			const attachmentRows = await db
				.prepare(
					`SELECT feedback_id, attachment_id AS id, file_name AS name,
						content_type, byte_length, digest, ordinal
					 FROM review_feedback_attachments
					 WHERE feedback_id IN (${placeholders})
					 ORDER BY feedback_id ASC, ordinal ASC`,
				)
				.bind(...feedbackIds)
				.all<Omit<ReviewAttachmentRecord, "content_url"> & { feedback_id: string }>();
			for (const attachment of attachmentRows.results || []) {
				const list = attachmentsByFeedback.get(attachment.feedback_id) || [];
				list.push({
					id: attachment.id,
					name: attachment.name,
					content_type: attachment.content_type,
					byte_length: attachment.byte_length,
					digest: attachment.digest,
					ordinal: attachment.ordinal,
					content_url: reviewAttachmentUrl(
						(rows.find((row) => row.id === attachment.feedback_id)?.project_id) || "",
						attachment.feedback_id,
						attachment.id,
					),
				});
				attachmentsByFeedback.set(attachment.feedback_id, list);
			}
	}

	const userIds = Array.from(
		new Set(rows.map((row) => row.submitted_by_user_id).filter(Boolean)),
	) as string[];
	const avatarsByUserId = new Map<
		string,
		{ avatar_preset: string | null; avatar_data_url: string | null }
	>();
	for (const authorIds of chunkReviewFeedbackIds(userIds)) {
		const userPlaceholders = authorIds.map(() => "?").join(", ");
		const userRows = await db
			.prepare(
				`SELECT id, avatar_preset, avatar_data_url
				 FROM users
				 WHERE id IN (${userPlaceholders})`,
			)
			.bind(...authorIds)
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
				attachmentsByFeedback.get(row.id) || [],
			row.submitted_by_user_id
				? avatarsByUserId.get(row.submitted_by_user_id) || null
				: null,
		),
	);
}

function chunkReviewFeedbackIds<T>(values: T[], chunkSize = 80) {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += chunkSize) {
		chunks.push(values.slice(index, index + chunkSize));
	}
	return chunks;
}

function hydrateFeedbackRow(
	row: ReviewFeedbackRow,
	replies: ReviewReplyRow[],
	mentions: ReviewMentionRecord[],
	attachments: ReviewAttachmentRecord[],
	avatar: { avatar_preset: string | null; avatar_data_url: string | null } | null,
): ReviewFeedbackRecord {
	const { copy_changes_json: _copyChangesJson, ...publicRow } = row;
	let copyChanges: Array<Record<string, unknown>> | null = null;
	if (row.copy_changes_json) {
		try {
			const parsed = JSON.parse(row.copy_changes_json);
			if (Array.isArray(parsed)) copyChanges = parsed as Array<Record<string, unknown>>;
		} catch {
			copyChanges = null;
		}
	}
	const feedbackMentions = mentions.filter((mention) => !mention.reply_id);
	const mentionsByReply = new Map<string, ReviewMentionRecord[]>();
	for (const mention of mentions) {
		if (!mention.reply_id) continue;
		const replyMentions = mentionsByReply.get(mention.reply_id) || [];
		replyMentions.push(mention);
		mentionsByReply.set(mention.reply_id, replyMentions);
	}
	return {
		...publicRow,
		ticket_label: `PF-${row.ticket_number}`,
		review_kind: row.review_kind === "copy_request" ? "copy_request" : "comment",
		copy_changes: copyChanges,
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
		attachments,
	};
}

export function reviewScreenshotUrl(projectId: string, feedbackId: string) {
	return `/api/projects/${encodeURIComponent(projectId)}/review-feedback/${encodeURIComponent(feedbackId)}/screenshot`;
}

export async function prepareDurableReviewPayload(
	_env: Env,
	_projectId: string,
	_requestId: string,
	payload: Record<string, unknown> & { screenshotDataUrl?: string | null },
) {
	let operationPayload: Record<string, unknown> & { screenshotDataUrl?: string | null } = payload;
	let richAdmitted: ReviewRichAttachmentAdmission[] | null = null;
	if (isRecord(payload.richPayload)) {
		const validation = validateReviewRichPayload(payload.richPayload, payload.comment);
		if (!validation.ok) {
			throw new Response("Invalid rich review payload.", { status: 422 });
		}
		richAdmitted = await admitReviewRichPayload(validation.value);
		const descriptor = compactReviewRichPayload(validation.value, richAdmitted);
		operationPayload = { ...payload, richPayload: descriptor };
	}
	const screenshotDataUrl = operationPayload.screenshotDataUrl;
		if (!screenshotDataUrl) {
			const payloadJson = JSON.stringify(operationPayload);
			assertDurableReviewPayloadSize(payloadJson);
			if (richAdmitted) rememberRichAdmission(payloadJson, richAdmitted);
			return payloadJson;
	}
	const parsed = parseDataUrl(screenshotDataUrl);
	if (!parsed) {
		throw new Response("Screenshot must be a PNG, JPEG, or WebP data URL.", {
			status: 400,
		});
	}
	if (parsed.bytes.byteLength <= INLINE_REVIEW_SCREENSHOT_BYTES) {
		const payloadJson = JSON.stringify(operationPayload);
		if (new TextEncoder().encode(payloadJson).byteLength <= MAX_REVIEW_OPERATION_PAYLOAD_BYTES) {
			if (richAdmitted) rememberRichAdmission(payloadJson, richAdmitted);
			return payloadJson;
		}
	}
	const descriptor = await reviewScreenshotDescriptor(parsed);
	const compactPayload: DurableReviewPayload = { ...operationPayload, screenshot: descriptor };
	delete compactPayload.screenshotDataUrl;
	const payloadJson = JSON.stringify(compactPayload);
	assertDurableReviewPayloadSize(payloadJson);
	if (richAdmitted) rememberRichAdmission(payloadJson, richAdmitted);
	return payloadJson;
}

export async function stageDurableReviewPayload(
	env: Env,
	projectId: string,
	feedbackId: string,
	payload: Record<string, unknown> & { screenshotDataUrl?: string | null },
	payloadJson: string,
) {
	if (payload.richPayload && isRecord(payload.richPayload)) {
		const richValidation = validateReviewRichPayload(payload.richPayload, payload.comment);
		if (!richValidation.ok) throw new Response("Invalid rich review payload.", { status: 422 });
		await stageReviewRichAttachments(
			env,
			projectId,
			feedbackId,
			{ ...payload, richPayload: richValidation.value } as ValidReviewFeedbackPayload,
			payloadJson,
		);
	}
	if (!payload.screenshotDataUrl) return;
	let descriptor: ReviewScreenshotDescriptor | null;
	try {
		descriptor = durableReviewScreenshotDescriptor(payloadJson);
	} catch {
		descriptor = null;
	}
	if (!descriptor) return;
	if (!env.REVIEW_ASSETS) {
		throw new Response("Review screenshot storage is not configured.", {
			status: 503,
		});
	}
	const parsed = parseDataUrl(payload.screenshotDataUrl);
	if (!parsed) {
		throw new Response("Screenshot must be a PNG, JPEG, or WebP data URL.", {
			status: 400,
		});
	}
	if (
		parsed.contentType !== descriptor.contentType ||
		parsed.bytes.byteLength !== descriptor.byteLength
	) {
		throw new Response("Review screenshot evidence is invalid.", { status: 503 });
	}
	try {
		await env.REVIEW_ASSETS.put(
			reviewScreenshotKey(projectId, feedbackId, descriptor.contentType),
			parsed.bytes,
			{ httpMetadata: { contentType: descriptor.contentType } },
		);
	} catch {
		throw new Response("Review screenshot upload is unavailable.", {
			status: 503,
		});
	}
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
	const parsed = parseDataUrl(dataUrl);
	if (!parsed) {
		throw new Response("Screenshot must be a PNG, JPEG, or WebP data URL.", {
			status: 400,
		});
	}
	if (!env.REVIEW_ASSETS) {
		if (parsed.bytes.byteLength > INLINE_REVIEW_SCREENSHOT_BYTES) {
			throw new Response("Review screenshot storage is not configured.", {
				status: 503,
			});
		}
		return null;
	}
	const key = `projects/${projectId}/feedback/${feedbackId}.${parsed.extension}`;
	await env.REVIEW_ASSETS.put(key, parsed.bytes, {
		httpMetadata: { contentType: parsed.contentType },
	});
	return {
		key,
		contentType: parsed.contentType as ReviewScreenshotDescriptor["contentType"],
		byteLength: parsed.bytes.byteLength,
	};
}

function assertDurableReviewPayloadSize(payloadJson: string) {
	if (new TextEncoder().encode(payloadJson).byteLength > MAX_REVIEW_OPERATION_PAYLOAD_BYTES) {
		throw new Response("Review operation payload is too large.", { status: 413 });
	}
}

async function reviewScreenshotDescriptor(
	parsed: ReturnType<typeof parseDataUrl>,
): Promise<ReviewScreenshotDescriptor> {
	if (!parsed) {
		throw new Response("Screenshot must be a PNG, JPEG, or WebP data URL.", {
			status: 400,
		});
	}
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", parsed.bytes),
	);
	return {
		version: 1,
		contentType: parsed.contentType as ReviewScreenshotDescriptor["contentType"],
		byteLength: parsed.bytes.byteLength,
		digest: `sha256:${Array.from(digest, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("")}`,
	};
}

function screenshotExtension(contentType: ReviewScreenshotDescriptor["contentType"]) {
	return contentType === "image/jpeg" ? "jpg" : contentType.replace("image/", "");
}

function reviewScreenshotKey(
	projectId: string,
	feedbackId: string,
	contentType: ReviewScreenshotDescriptor["contentType"],
) {
	return `projects/${projectId}/feedback/${feedbackId}.${screenshotExtension(contentType)}`;
}

function durableReviewScreenshotDescriptor(payloadJson: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		throw new Response("Review screenshot evidence is invalid.", { status: 503 });
	}
	if (!isRecord(parsed) || parsed.screenshot === undefined) return null;
	const descriptor = parsed.screenshot;
	if (
		!isRecord(descriptor) ||
		Object.keys(descriptor).length !== 4 ||
		descriptor.version !== 1 ||
		!(["image/png", "image/jpeg", "image/webp"] as const).includes(
			descriptor.contentType as "image/png" | "image/jpeg" | "image/webp",
		) ||
		typeof descriptor.byteLength !== "number" ||
		!Number.isInteger(descriptor.byteLength) ||
		descriptor.byteLength < 1 ||
		descriptor.byteLength > MAX_SCREENSHOT_BYTES ||
		typeof descriptor.digest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest)
	) {
		throw new Response("Review screenshot evidence is invalid.", { status: 503 });
	}
	return descriptor as ReviewScreenshotDescriptor;
}

async function promoteStagedScreenshot(
	env: Env,
	operation: ReviewOperationRow,
	descriptor: ReviewScreenshotDescriptor,
): Promise<VerifiedReviewScreenshot> {
	if (!env.REVIEW_ASSETS || !operation.result_feedback_id) {
		throw new Response("Review screenshot upload is unavailable.", { status: 503 });
	}
	const key = reviewScreenshotKey(
		operation.project_id,
		operation.result_feedback_id!,
		descriptor.contentType,
	);
	const object = await env.REVIEW_ASSETS.get(key);
	if (!object?.body) {
		throw new Response("Review screenshot upload is unavailable.", { status: 503 });
	}
	let bytes: ArrayBuffer;
	try {
		bytes = await object.arrayBuffer();
	} catch {
		throw new Response("Review screenshot upload is unavailable.", { status: 503 });
	}
	const contentType = object.httpMetadata?.contentType;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const actualDigest = `sha256:${Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
	if (
		contentType !== descriptor.contentType ||
		object.size !== descriptor.byteLength ||
		bytes.byteLength !== descriptor.byteLength ||
		actualDigest !== descriptor.digest
	) {
		throw new Response("Review screenshot verification failed.", { status: 503 });
	}
	return {
		key,
		contentType: descriptor.contentType,
		byteLength: descriptor.byteLength,
	};
}

export async function readStagedReviewScreenshot(
	env: Env,
	operation: ReviewOperationRow,
) {
	if (!env.REVIEW_ASSETS) return null;
	let descriptor: ReviewScreenshotDescriptor | null;
	try {
		descriptor = durableReviewScreenshotDescriptor(operation.payload_json);
	} catch {
		return null;
	}
	if (!descriptor) return null;
	const object = await env.REVIEW_ASSETS.get(
		reviewScreenshotKey(
			operation.project_id,
			operation.result_feedback_id || "",
			descriptor.contentType,
		),
	);
	if (!object?.body) return null;
	const bytes = await object.arrayBuffer();
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const actualDigest = `sha256:${Array.from(digest, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
	if (
		object.httpMetadata?.contentType !== descriptor.contentType ||
		object.size !== descriptor.byteLength ||
		bytes.byteLength !== descriptor.byteLength ||
		actualDigest !== descriptor.digest
	) {
		return null;
	}
	return {
		body: bytes,
		contentType: descriptor.contentType,
		byteLength: descriptor.byteLength,
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
		return `${url.origin}${url.pathname}${url.hash.startsWith("#/") ? url.hash.split("?")[0] : ""}`;
	} catch {
		return pageUrl;
	}
}

export function isReviewStatus(value: string): value is ReviewStatus {
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

export function normalizeReviewReplyComment(value: unknown) {
	return normalizeString(value, MAX_COMMENT_LENGTH);
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
