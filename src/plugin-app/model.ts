// Pure view-model helpers for the Shiplet MCP App. No DOM, no host bridge:
// everything here is covered by test/plugin-app.spec.ts.

import {
	FEEDBACK_STATUSES,
	PLUGIN_VISIBILITIES,
	PUBLISH_HTML_LIMITS,
	type FeedbackDetailResult,
	type FeedbackListResult,
	type FeedbackStatus,
	type HtmlFileResult,
	type PluginFeedbackDetail,
	type PluginFeedbackReply,
	type PluginFeedbackSummary,
	type PluginShiplet,
	type PluginVisibility,
	type PluginWorkspace,
	type PublishResult,
	type ShipletListResult,
} from "../plugin-contract";

export type ShipletRef = Pick<PluginShiplet, "id" | "name" | "reviewUrl">;

/** Navigable app locations. Deep links resolve to the first three. */
export type Route =
	| { kind: "inbox" }
	| { kind: "feedback"; shipletId: string }
	| { kind: "detail"; shipletId: string; feedbackId: string }
	| { kind: "html-file"; fileName: string; resourceUri: string | null }
	| { kind: "published" };

export type DeepLinkRoute = Extract<
	Route,
	{ kind: "inbox" | "feedback" | "detail" }
>;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value);
}

function decodeSegment(segment: string): string | null {
	try {
		const decoded = decodeURIComponent(segment);
		return isValidId(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

/**
 * Resolve an app-relative deep link (`hostContext["openai/deepLink"].url`).
 * Returns null for anything that is not a known route with well-formed IDs.
 */
export function parseDeepLink(url: string): DeepLinkRoute | null {
	if (typeof url !== "string") return null;
	const trimmed = url.trim();
	if (trimmed === "") return { kind: "inbox" };
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
	const path = trimmed.split(/[?#]/, 1)[0];
	const segments = path.split("/").filter((segment) => segment !== "");
	if (segments.length === 0) return { kind: "inbox" };
	if (segments[0] !== "shiplets") return null;
	if (segments.length === 2) {
		const shipletId = decodeSegment(segments[1]);
		return shipletId ? { kind: "feedback", shipletId } : null;
	}
	if (segments.length === 4 && segments[2] === "feedback") {
		const shipletId = decodeSegment(segments[1]);
		const feedbackId = decodeSegment(segments[3]);
		return shipletId && feedbackId
			? { kind: "detail", shipletId, feedbackId }
			: null;
	}
	return null;
}

/** Matches the server's "open" state: everything that is not Done or Dropped. */
export const OPEN_STATUSES: readonly FeedbackStatus[] = FEEDBACK_STATUSES.filter(
	(status) => status !== "Done" && status !== "Dropped",
);

export const FEEDBACK_FILTERS = ["open", "done", "all"] as const;
export type FeedbackFilter = (typeof FEEDBACK_FILTERS)[number];

export const FEEDBACK_FILTER_LABELS: Record<FeedbackFilter, string> = {
	open: "Open",
	done: "Done",
	all: "All",
};

export function filterFeedback<T extends Pick<PluginFeedbackSummary, "status">>(
	items: readonly T[],
	filter: FeedbackFilter,
): T[] {
	if (filter === "all") return [...items];
	if (filter === "done") return items.filter((item) => item.status === "Done");
	return items.filter((item) => OPEN_STATUSES.includes(item.status));
}

/** Arguments for `list_feedback` that return the slice a filter chip shows. */
export function feedbackListArguments(
	shipletId: string,
	filter: FeedbackFilter,
): Record<string, unknown> {
	if (filter === "done") {
		return { shiplet_id: shipletId, status: "Done", include_closed: true };
	}
	if (filter === "all") return { shiplet_id: shipletId, include_closed: true };
	return { shiplet_id: shipletId };
}

export function searchShiplets(
	shiplets: readonly PluginShiplet[],
	query: string,
): PluginShiplet[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...shiplets];
	return shiplets.filter(
		(shiplet) =>
			shiplet.name.toLowerCase().includes(needle) ||
			shiplet.id.toLowerCase().includes(needle),
	);
}

export const VISIBILITY_LABELS: Record<PluginVisibility, string> = {
	private: "Private",
	organization: "Organization",
	unlisted: "Unlisted",
	public: "Public",
};

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Short relative time ("5m ago"); dates older than a week print as "Jun 1". */
export function relativeTime(
	iso: string | null | undefined,
	now: number = Date.now(),
): string {
	if (!iso) return "";
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	const date = new Date(at);
	const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
	return date.getUTCFullYear() === new Date(now).getUTCFullYear()
		? label
		: `${label}, ${date.getUTCFullYear()}`;
}

/** Path of a feedback page URL, for compact display. */
export function pagePath(pageUrl: string | null | undefined): string {
	if (!pageUrl) return "";
	try {
		return new URL(pageUrl, "https://shiplet.invalid").pathname || "/";
	} catch {
		return "";
	}
}

const MAX_NAME_LENGTH = 80;

/** "landing-page_v2.html" -> "Landing page v2". Never returns an empty name. */
export function prettifyFileName(fileName: string): string {
	const base = fileName.split(/[\\/]/).pop() ?? "";
	const stem = base.replace(/\.html?$/i, "");
	const words = stem.replace(/[-_.\s]+/g, " ").trim();
	if (words === "") return "Untitled page";
	const name = words.charAt(0).toUpperCase() + words.slice(1);
	return name.slice(0, MAX_NAME_LENGTH).trim();
}

export function utf8ByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	const mb = bytes / (1024 * 1024);
	return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export type PublishSizeCheck =
	| { ok: true; bytes: number }
	| { ok: false; bytes: number; message: string };

export function checkPublishSize(content: string): PublishSizeCheck {
	const bytes = utf8ByteLength(content);
	if (bytes <= PUBLISH_HTML_LIMITS.maxTotalBytes) return { ok: true, bytes };
	return {
		ok: false,
		bytes,
		message: `This file is ${formatBytes(bytes)}. Shiplet publishes HTML files up to ${formatBytes(PUBLISH_HTML_LIMITS.maxTotalBytes)} from here; use the Shiplet CLI for larger builds.`,
	};
}

const MAX_CONTEXT_COMMENT = 4_000;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function feedbackTitle(feedback: Pick<PluginFeedbackSummary, "title">): string {
	return clip(feedback.title.trim() || "Untitled feedback", 120);
}

export type TitledTextBlock = {
	type: "text";
	text: string;
	_meta?: { "openai/title": string };
};

function feedbackContextText(
	feedback: PluginFeedbackDetail,
	shiplet: ShipletRef | null,
): string {
	const lines = [
		`Shiplet: ${shiplet?.name ? `${shiplet.name} (${feedback.shipletId})` : feedback.shipletId}`,
		`Feedback ID: ${feedback.id}`,
		`Title: ${feedbackTitle(feedback)}`,
		`Status: ${feedback.status}`,
	];
	if (feedback.pageUrl) lines.push(`Page: ${feedback.pageUrl}`);
	if (feedback.authorName) lines.push(`Reported by: ${feedback.authorName}`);
	lines.push(`Thread: ${feedback.url}`);
	lines.push("", "Comment:", clip(feedback.comment.trim(), MAX_CONTEXT_COMMENT));
	return lines.join("\n");
}

/** `ui/message` params for "Ask ChatGPT to address this". */
export function buildAskMessage(
	feedback: PluginFeedbackDetail,
	shiplet: ShipletRef | null,
): { role: "user"; content: [TitledTextBlock, TitledTextBlock] } {
	const title = feedbackTitle(feedback);
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `Please address the Shiplet feedback "${clip(title, 80)}". Propose a fix, and reply on the thread when it is done.`,
			},
			{
				type: "text",
				text: feedbackContextText(feedback, shiplet),
				_meta: { "openai/title": `Feedback: ${title}` },
			},
		],
	};
}

/** `ui/update-model-context` params describing the open feedback thread. */
export function buildFeedbackModelContext(
	feedback: PluginFeedbackDetail,
	shiplet: ShipletRef | null,
): {
	content: [TitledTextBlock];
	structuredContent: { shipletId: string; feedbackId: string };
} {
	return {
		content: [
			{
				type: "text",
				text: `The user is viewing this Shiplet feedback thread.\n${feedbackContextText(feedback, shiplet)}`,
				_meta: { "openai/title": `Feedback: ${feedbackTitle(feedback)}` },
			},
		],
		structuredContent: { shipletId: feedback.shipletId, feedbackId: feedback.id },
	};
}

// ---------------------------------------------------------------------------
// structuredContent validation. The server is the source of truth, but a
// malformed row must never take the whole view down.

export type ViewResult =
	| ShipletListResult
	| FeedbackListResult
	| FeedbackDetailResult
	| PublishResult
	| HtmlFileResult;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): value is string {
	return typeof value === "string";
}

function nullableStr(value: unknown): value is string | null {
	return value === null || value === undefined || typeof value === "string";
}

function parseShipletRef(value: unknown): ShipletRef | null {
	if (!isObject(value) || !str(value.id) || !str(value.reviewUrl)) return null;
	return {
		id: value.id,
		name: str(value.name) && value.name.trim() ? value.name : value.id,
		reviewUrl: value.reviewUrl,
	};
}

function parseShiplet(value: unknown): PluginShiplet | null {
	const ref = parseShipletRef(value);
	if (!ref || !isObject(value)) return null;
	return {
		...ref,
		visibility: PLUGIN_VISIBILITIES.includes(value.visibility as PluginVisibility)
			? (value.visibility as PluginVisibility)
			: "private",
		archived: value.archived === true,
		openFeedbackCount:
			typeof value.openFeedbackCount === "number" &&
			Number.isFinite(value.openFeedbackCount)
				? value.openFeedbackCount
				: null,
		updatedAt: str(value.updatedAt) ? value.updatedAt : null,
	};
}

function parseStatus(value: unknown): FeedbackStatus | null {
	return FEEDBACK_STATUSES.includes(value as FeedbackStatus)
		? (value as FeedbackStatus)
		: null;
}

export function parseFeedbackSummary(value: unknown): PluginFeedbackSummary | null {
	if (!isObject(value)) return null;
	const status = parseStatus(value.status);
	if (
		!str(value.id) ||
		!str(value.shipletId) ||
		!str(value.url) ||
		!status ||
		!nullableStr(value.authorName) ||
		!nullableStr(value.pageUrl)
	) {
		return null;
	}
	return {
		id: value.id,
		shipletId: value.shipletId,
		title: str(value.title) ? value.title : "",
		status,
		authorName: value.authorName ?? null,
		pageUrl: value.pageUrl ?? null,
		replyCount:
			typeof value.replyCount === "number" && value.replyCount >= 0
				? value.replyCount
				: 0,
		createdAt: str(value.createdAt) ? value.createdAt : null,
		url: value.url,
	};
}

function parseReply(value: unknown): PluginFeedbackReply | null {
	if (!isObject(value) || !str(value.id) || !str(value.comment)) return null;
	return {
		id: value.id,
		comment: value.comment,
		authorName: str(value.authorName) ? value.authorName : null,
		createdAt: str(value.createdAt) ? value.createdAt : null,
	};
}

export function parseFeedbackDetail(value: unknown): PluginFeedbackDetail | null {
	const base = parseFeedbackSummary(value);
	if (!base || !isObject(value)) return null;
	const replies = Array.isArray(value.replies)
		? value.replies
				.map(parseReply)
				.filter((reply): reply is PluginFeedbackReply => reply !== null)
		: [];
	return {
		...base,
		comment: str(value.comment) ? value.comment : "",
		replies,
	};
}

function compact<T>(values: unknown[], parse: (value: unknown) => T | null): T[] {
	return values.map(parse).filter((value): value is T => value !== null);
}

export function parseViewResult(value: unknown): ViewResult | null {
	if (!isObject(value)) return null;
	switch (value.view) {
		case "inbox":
			return Array.isArray(value.shiplets)
				? { view: "inbox", shiplets: compact(value.shiplets, parseShiplet) }
				: null;
		case "feedback": {
			const shiplet = parseShipletRef(value.shiplet);
			return shiplet && Array.isArray(value.feedback)
				? {
						view: "feedback",
						shiplet,
						feedback: compact(value.feedback, parseFeedbackSummary),
					}
				: null;
		}
		case "feedback-detail": {
			const feedback = parseFeedbackDetail(value.feedback);
			if (!feedback) return null;
			const shiplet = parseShipletRef(value.shiplet);
			return shiplet
				? { view: "feedback-detail", feedback, shiplet }
				: { view: "feedback-detail", feedback };
		}
		case "published": {
			const shiplet = parseShiplet(value.shiplet);
			return shiplet ? { view: "published", shiplet } : null;
		}
		case "html-file":
			return str(value.fileName)
				? { view: "html-file", fileName: value.fileName }
				: null;
		default:
			return null;
	}
}

/** Workspaces from a `list_workspaces` result, or null when the shape is wrong. */
export function parseWorkspaceList(value: unknown): PluginWorkspace[] | null {
	if (!isObject(value) || value.view !== "workspaces" || !Array.isArray(value.workspaces)) {
		return null;
	}
	return compact(value.workspaces, (item) =>
		isObject(item) && str(item.id) && item.id !== ""
			? { id: item.id, name: str(item.name) && item.name.trim() ? item.name : item.id }
			: null,
	);
}

const FALLBACK_ERROR = "Shiplet could not complete that request.";
const MAX_ERROR_LENGTH = 240;

/** One short sentence for an `isError` tool result or a thrown bridge error. */
export function toolErrorMessage(error: unknown): string {
	let text = "";
	if (error instanceof Error) {
		text = error.message;
	} else if (isObject(error) && Array.isArray(error.content)) {
		text = error.content
			.filter((block): block is { type: "text"; text: string } =>
				isObject(block) && block.type === "text" && str(block.text),
			)
			.map((block) => block.text)
			.join(" ");
	} else if (str(error)) {
		text = error;
	}
	text = text.replace(/\s+/g, " ").trim();
	if (text === "") return FALLBACK_ERROR;
	return clip(text, MAX_ERROR_LENGTH);
}
