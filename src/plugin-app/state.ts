// Pure state machine for the Shiplet MCP App. The React layer dispatches
// actions; request tokens make late responses from superseded requests
// harmless, and status changes are applied optimistically with a revert.

import type {
	FeedbackStatus,
	PluginFeedbackDetail,
	PluginFeedbackReply,
	PluginFeedbackSummary,
	PluginShiplet,
} from "../plugin-contract";
import type { FeedbackFilter, Route, ShipletRef, ViewResult } from "./model";

export type SlotStatus = "idle" | "loading" | "ready" | "error";

export type Slot<T> = {
	key: string | null;
	token: number;
	status: SlotStatus;
	data: T | null;
	error: string | null;
};

export type FeedbackListData = {
	shiplet: ShipletRef;
	feedback: PluginFeedbackSummary[];
};

export type DetailData = {
	feedback: PluginFeedbackDetail;
	shiplet: ShipletRef | null;
};

export type StatusMutation = {
	feedbackId: string;
	previous: FeedbackStatus;
	next: FeedbackStatus;
	pending: boolean;
	error: string | null;
};

export type AppState = {
	route: Route;
	/** True until the first tool result, tool input or deep link arrives. */
	awaitingInitial: boolean;
	shiplets: Slot<PluginShiplet[]>;
	feedbackList: Slot<FeedbackListData>;
	detail: Slot<DetailData>;
	filter: FeedbackFilter;
	published: PluginShiplet | null;
	/** Shiplet names learned from any result, so headers never show a bare ID. */
	knownShiplets: Record<string, ShipletRef>;
	attachedFeedbackId: string | null;
	statusMutation: StatusMutation | null;
};

export type Action =
	| { type: "initial-result"; result: ViewResult }
	| { type: "navigate"; route: Route }
	| { type: "set-filter"; filter: FeedbackFilter }
	| { type: "shiplets-request"; token: number }
	| { type: "shiplets-resolve"; token: number; data: PluginShiplet[] }
	| { type: "shiplets-fail"; token: number; message: string }
	| { type: "feedback-request"; key: string; token: number }
	| { type: "feedback-resolve"; key: string; token: number; data: FeedbackListData }
	| { type: "feedback-fail"; key: string; token: number; message: string }
	| { type: "detail-request"; key: string; token: number }
	| { type: "detail-resolve"; key: string; token: number; data: DetailData }
	| { type: "detail-fail"; key: string; token: number; message: string }
	| { type: "status-start"; feedbackId: string; next: FeedbackStatus }
	| { type: "status-settle"; feedbackId: string; feedback: PluginFeedbackDetail | null }
	| { type: "status-fail"; feedbackId: string; message: string }
	| { type: "status-dismiss" }
	| { type: "reply-added"; feedbackId: string; reply: PluginFeedbackReply }
	| { type: "detail-replaced"; feedback: PluginFeedbackDetail }
	| { type: "attached"; feedbackId: string | null };

function emptySlot<T>(): Slot<T> {
	return { key: null, token: 0, status: "idle", data: null, error: null };
}

function readySlot<T>(key: string, data: T): Slot<T> {
	return { key, token: 0, status: "ready", data, error: null };
}

export function feedbackListKey(shipletId: string, filter: FeedbackFilter) {
	return `${shipletId}|${filter}`;
}

export function detailKey(shipletId: string, feedbackId: string) {
	return `${shipletId}/${feedbackId}`;
}

export function createInitialState(): AppState {
	return {
		route: { kind: "inbox" },
		awaitingInitial: true,
		shiplets: emptySlot(),
		feedbackList: emptySlot(),
		detail: emptySlot(),
		filter: "open",
		published: null,
		knownShiplets: {},
		attachedFeedbackId: null,
		statusMutation: null,
	};
}

function remember(state: AppState, refs: ShipletRef[]): Record<string, ShipletRef> {
	if (refs.length === 0) return state.knownShiplets;
	const next = { ...state.knownShiplets };
	for (const ref of refs) {
		next[ref.id] = { id: ref.id, name: ref.name, reviewUrl: ref.reviewUrl };
	}
	return next;
}

function request<T>(slot: Slot<T>, key: string | null, token: number): Slot<T> {
	// Keep the previous data only when it answers the same question, so a
	// refresh does not flash a skeleton but a new Shiplet never shows stale rows.
	return {
		key,
		token,
		status: "loading",
		data: slot.key === key ? slot.data : null,
		error: null,
	};
}

function accepts<T>(slot: Slot<T>, key: string | null, token: number) {
	return slot.key === key && slot.token === token;
}

function patchFeedback(
	state: AppState,
	feedbackId: string,
	patch: (item: PluginFeedbackSummary) => Partial<PluginFeedbackDetail>,
): AppState {
	const list = state.feedbackList.data;
	const detail = state.detail.data;
	return {
		...state,
		feedbackList:
			list && list.feedback.some((item) => item.id === feedbackId)
				? {
						...state.feedbackList,
						data: {
							...list,
							feedback: list.feedback.map((item) =>
								item.id === feedbackId ? { ...item, ...pickSummary(patch(item)) } : item,
							),
						},
					}
				: state.feedbackList,
		detail:
			detail && detail.feedback.id === feedbackId
				? {
						...state.detail,
						data: { ...detail, feedback: { ...detail.feedback, ...patch(detail.feedback) } },
					}
				: state.detail,
	};
}

function pickSummary(patch: Partial<PluginFeedbackDetail>): Partial<PluginFeedbackSummary> {
	const { comment: _comment, replies: _replies, ...summary } = patch;
	return summary;
}

export function reduce(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "initial-result": {
			const result = action.result;
			const base = { ...state, awaitingInitial: false };
			switch (result.view) {
				case "inbox":
					return {
						...base,
						route: { kind: "inbox" },
						shiplets: readySlot("inbox", result.shiplets),
						knownShiplets: remember(state, result.shiplets),
					};
				case "feedback":
					return {
						...base,
						route: { kind: "feedback", shipletId: result.shiplet.id },
						filter: "open",
						feedbackList: readySlot(feedbackListKey(result.shiplet.id, "open"), {
							shiplet: result.shiplet,
							feedback: result.feedback,
						}),
						knownShiplets: remember(state, [result.shiplet]),
					};
				case "feedback-detail": {
					const { feedback } = result;
					const shiplet = result.shiplet ?? state.knownShiplets[feedback.shipletId] ?? null;
					return {
						...base,
						route: { kind: "detail", shipletId: feedback.shipletId, feedbackId: feedback.id },
						detail: readySlot(detailKey(feedback.shipletId, feedback.id), { feedback, shiplet }),
						knownShiplets: result.shiplet ? remember(state, [result.shiplet]) : state.knownShiplets,
					};
				}
				case "published":
					return {
						...base,
						route: { kind: "published" },
						published: result.shiplet,
						knownShiplets: remember(state, [result.shiplet]),
					};
				case "html-file":
					// The file URI arrives with the tool input; keep it if it already did.
					return state.route.kind === "html-file"
						? base
						: { ...base, route: { kind: "html-file", fileName: result.fileName, resourceUri: null } };
			}
			return base;
		}
		case "navigate":
			return {
				...state,
				awaitingInitial: false,
				route: action.route,
				statusMutation:
					action.route.kind === "detail" &&
					state.statusMutation?.feedbackId === action.route.feedbackId
						? state.statusMutation
						: state.statusMutation?.pending
							? state.statusMutation
							: null,
			};
		case "set-filter":
			return { ...state, filter: action.filter };
		case "shiplets-request":
			return { ...state, shiplets: request(state.shiplets, "inbox", action.token) };
		case "shiplets-resolve":
			if (!accepts(state.shiplets, "inbox", action.token)) return state;
			return {
				...state,
				shiplets: readySlot("inbox", action.data),
				knownShiplets: remember(state, action.data),
			};
		case "shiplets-fail":
			if (!accepts(state.shiplets, "inbox", action.token)) return state;
			return { ...state, shiplets: { ...state.shiplets, status: "error", error: action.message } };
		case "feedback-request":
			return { ...state, feedbackList: request(state.feedbackList, action.key, action.token) };
		case "feedback-resolve":
			if (!accepts(state.feedbackList, action.key, action.token)) return state;
			return {
				...state,
				feedbackList: readySlot(action.key, action.data),
				knownShiplets: remember(state, [action.data.shiplet]),
			};
		case "feedback-fail":
			if (!accepts(state.feedbackList, action.key, action.token)) return state;
			return {
				...state,
				feedbackList: { ...state.feedbackList, status: "error", error: action.message },
			};
		case "detail-request":
			return { ...state, detail: request(state.detail, action.key, action.token) };
		case "detail-resolve":
			if (!accepts(state.detail, action.key, action.token)) return state;
			return {
				...state,
				detail: readySlot(action.key, {
					feedback: action.data.feedback,
					shiplet: action.data.shiplet ?? state.knownShiplets[action.data.feedback.shipletId] ?? null,
				}),
				knownShiplets: action.data.shiplet ? remember(state, [action.data.shiplet]) : state.knownShiplets,
			};
		case "detail-fail":
			if (!accepts(state.detail, action.key, action.token)) return state;
			return { ...state, detail: { ...state.detail, status: "error", error: action.message } };
		case "status-start": {
			const current =
				state.detail.data?.feedback.id === action.feedbackId
					? state.detail.data.feedback.status
					: state.feedbackList.data?.feedback.find((item) => item.id === action.feedbackId)?.status;
			if (!current || state.statusMutation?.pending) return state;
			return {
				...patchFeedback(state, action.feedbackId, () => ({ status: action.next })),
				statusMutation: {
					feedbackId: action.feedbackId,
					previous: current,
					next: action.next,
					pending: true,
					error: null,
				},
			};
		}
		case "status-settle": {
			if (state.statusMutation?.feedbackId !== action.feedbackId) return state;
			const settled = action.feedback;
			const next = settled
				? patchFeedback(state, action.feedbackId, () => settled)
				: state;
			return { ...next, statusMutation: null };
		}
		case "status-fail": {
			const mutation = state.statusMutation;
			if (mutation?.feedbackId !== action.feedbackId) return state;
			return {
				...patchFeedback(state, action.feedbackId, () => ({ status: mutation.previous })),
				statusMutation: { ...mutation, pending: false, error: action.message },
			};
		}
		case "status-dismiss":
			return state.statusMutation?.pending ? state : { ...state, statusMutation: null };
		case "reply-added":
			return patchFeedback(state, action.feedbackId, (item) => {
				const replies =
					state.detail.data?.feedback.id === action.feedbackId
						? [...state.detail.data.feedback.replies, action.reply]
						: undefined;
				return replies
					? { replies, replyCount: item.replyCount + 1 }
					: { replyCount: item.replyCount + 1 };
			});
		case "detail-replaced":
			return patchFeedback(state, action.feedback.id, () => action.feedback);
		case "attached":
			return { ...state, attachedFeedbackId: action.feedbackId };
	}
	return state;
}
