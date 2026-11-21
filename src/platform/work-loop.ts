// The work loop the dashboard is organized around: a person annotates a live
// version (a request with full context), agents pick it up and may coordinate
// in a handshake, and a trace comes back tied to the new version, where the
// person checks it and annotates again.
//
// This module is pure: it turns request (review feedback) records, trace
// summaries and handshakes into the lanes and links the screens show. It runs
// on the server for the first paint and in the browser after.
import type { ReviewFeedbackRecord } from "../review";
import { isHandshakeTrace, type HandshakeSummary } from "./handshake-model";

export type TraceLevel = "full" | "conversation" | "summary" | "hidden";

export type LoopTrace = {
	id: string;
	projectId: string;
	revisionId: string | null;
	title: string;
	harness: string;
	startedOn: string | null;
	endedOn: string | null;
	createdOn: string;
	eventCount: number;
	sharing: "private" | "shared";
	shiplet?: { id: string; name: string };
	access?: { level: TraceLevel; via: string };
};

export type LoopRequest = {
	id: string;
	projectId: string;
	shipletName: string;
	ticketLabel: string;
	comment: string;
	status: string;
	createdOn: string;
	submittedBy: string;
	pagePath: string;
	element: string | null;
	hasScreenshot: boolean;
	revisionId: string | null;
	// The annotation, opened on the Shiplet where it was left.
	href: string;
};

// Statuses of review feedback, grouped by where the request is in the loop.
export const WAITING_STATUSES = ["New", "Blocked"] as const;
export const WORKING_STATUSES = ["In Progress"] as const;
export const CHECK_STATUSES = ["Staging"] as const;
export const CLOSED_STATUSES = ["Done", "Dropped"] as const;

export type LoopStage = "waiting" | "working" | "check" | "closed";

export function requestStage(status: string): LoopStage {
	if ((WORKING_STATUSES as readonly string[]).includes(status)) return "working";
	if ((CHECK_STATUSES as readonly string[]).includes(status)) return "check";
	if ((CLOSED_STATUSES as readonly string[]).includes(status)) return "closed";
	return "waiting";
}

export function requestHref(projectId: string, feedbackId: string) {
	return `/shiplets/${encodeURIComponent(projectId)}?feedback=${encodeURIComponent(feedbackId)}`;
}

export function traceHref(projectId: string, traceId: string) {
	return `/shiplets/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(traceId)}`;
}

export function shipletRequestsHref(projectId: string) {
	return `/feedback?projectId=${encodeURIComponent(projectId)}`;
}

export function toLoopRequest(record: ReviewFeedbackRecord): LoopRequest {
	return {
		id: record.id,
		projectId: record.project_id,
		shipletName: record.project_name || "Shiplet",
		ticketLabel: record.ticket_label || `PF-${record.ticket_number}`,
		comment: record.comment,
		status: record.status,
		createdOn: record.created_on,
		submittedBy: record.submitted_by_email || record.name || "Reviewer",
		pagePath: record.pathname || pathFromUrl(record.page_url),
		element: elementLabel(record.selected_element),
		hasScreenshot: Boolean(record.screenshot_url || record.screenshot_key),
		revisionId: record.revision_id,
		href: requestHref(record.project_id, record.id),
	};
}

// A short, human label for the element an annotation points at.
export function elementLabel(element: unknown): string | null {
	if (!element || typeof element !== "object") return null;
	const value = element as Record<string, unknown>;
	const aria = typeof value.ariaLabel === "string" ? value.ariaLabel.trim() : "";
	const text = typeof value.text === "string" ? value.text.replace(/\s+/g, " ").trim() : "";
	const tag = typeof value.tagName === "string" ? value.tagName.toLowerCase() : "";
	const selector = typeof value.selector === "string" ? value.selector : "";
	const name = aria || text;
	if (name) return `${tag ? `${tag} ` : ""}“${clip(name, 40)}”`;
	if (selector) return clip(selector.split(" > ").slice(-2).join(" > "), 48);
	return tag || null;
}

// When a trace's work finished, for ordering it against requests.
export function traceTime(trace: Pick<LoopTrace, "endedOn" | "createdOn">) {
	return trace.endedOn || trace.createdOn;
}

// Traces on the same Shiplet that finished after the request was made: the
// work that may answer it. A trace does not record which request an agent
// worked on, so this is "since", not "for". A handshake can name its request
// (packages/agent-handshake), which is the one exact link so far.
export function tracesSinceRequest<T extends LoopTrace>(request: Pick<LoopRequest, "projectId" | "createdOn">, traces: T[]) {
	return traces
		.filter((trace) => trace.projectId === request.projectId && traceTime(trace) >= request.createdOn)
		.sort((a, b) => compareDesc(traceTime(a), traceTime(b)));
}

// Requests on the same Shiplet made before the trace finished: what the
// session was likely asked to do.
export function requestsBeforeTrace<T extends Pick<LoopRequest, "projectId" | "createdOn">>(
	trace: Pick<LoopTrace, "projectId" | "endedOn" | "createdOn">,
	requests: T[],
) {
	const finished = traceTime(trace);
	return requests
		.filter((request) => request.projectId === trace.projectId && request.createdOn <= finished)
		.sort((a, b) => compareDesc(a.createdOn, b.createdOn));
}

export type LoopRequestCard = LoopRequest & {
	stage: LoopStage;
	traces: LoopTrace[];
	handshakes: HandshakeSummary[];
};

export type LoopTraceCard = LoopTrace & {
	requests: LoopRequest[];
	// An exported handshake, shared as a trace.
	fromHandshake: boolean;
};

export type WorkLoop = {
	// Requests nobody has picked up yet, or that are blocked.
	asked: LoopRequestCard[];
	// Requests an agent is on, and handshakes running now.
	working: LoopRequestCard[];
	liveHandshakes: HandshakeSummary[];
	// Requests an agent marked ready, and traces that came back.
	toCheck: LoopRequestCard[];
	traces: LoopTraceCard[];
	// inMotion and cameBack count what the Home lanes show: a request with a
	// live handshake is one item there (its handshake), not two.
	counts: { asked: number; working: number; live: number; toCheck: number; traces: number; inMotion: number; cameBack: number };
};

export function buildWorkLoop(input: {
	requests: LoopRequest[];
	traces: LoopTrace[];
	handshakes: HandshakeSummary[];
	limit?: number;
}): WorkLoop {
	const limit = input.limit ?? 6;
	const cards: LoopRequestCard[] = [...input.requests]
		.sort((a, b) => compareDesc(a.createdOn, b.createdOn))
		.map((request) => ({
			...request,
			stage: requestStage(request.status),
			traces: tracesSinceRequest(request, input.traces),
			handshakes: input.handshakes.filter((handshake) => handshake.request?.feedbackId === request.id),
		}));
	// Every handshake the source returns is live: an ended one is gone.
	const live = input.handshakes;
	// A request with a live handshake is being worked on, whatever its status says.
	const isWorking = (card: LoopRequestCard) =>
		card.stage === "working" || (card.stage === "waiting" && card.handshakes.length > 0);
	const asked = cards.filter((card) => card.stage === "waiting" && !isWorking(card));
	const working = cards.filter(isWorking);
	const toCheck = cards.filter((card) => card.stage === "check");
	const traces: LoopTraceCard[] = [...input.traces]
		.sort((a, b) => compareDesc(traceTime(a), traceTime(b)))
		.map((trace) => ({
			...trace,
			requests: requestsBeforeTrace(trace, input.requests),
			fromHandshake: isHandshakeTrace(trace),
		}));
	return {
		asked: asked.slice(0, limit),
		working: working.slice(0, limit),
		liveHandshakes: live,
		toCheck: toCheck.slice(0, limit),
		traces: traces.slice(0, limit),
		counts: {
			asked: asked.length,
			working: working.length,
			live: live.length,
			toCheck: toCheck.length,
			traces: input.traces.length,
			inMotion: live.length + working.filter((card) => !card.handshakes.length).length,
			cameBack: toCheck.length + input.traces.length,
		},
	};
}

export function relativeTime(value: string | null | undefined, now: number) {
	if (!value) return "";
	const time = Date.parse(value);
	if (Number.isNaN(time)) return "";
	const minutes = Math.round((now - time) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} d ago`;
	return new Date(time).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function shortRevision(revisionId: string | null | undefined) {
	if (!revisionId || revisionId.startsWith("legacy_")) return null;
	const bare = revisionId.replace(/^rev(ision)?_/, "");
	return bare.slice(0, 7);
}

function pathFromUrl(url: string) {
	try {
		return new URL(url).pathname || "/";
	} catch {
		return url || "/";
	}
}

function clip(text: string, length: number) {
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function compareDesc(a: string, b: string) {
	return a < b ? 1 : a > b ? -1 : 0;
}
