// Owns app state outside React so host events that arrive before the first
// render (tool input, tool result, deep links) are never lost, and so every
// async call has exactly one place that handles its failure.

import {
	PLUGIN_TOOL,
	type FeedbackStatus,
	type PluginFeedbackDetail,
	type PluginShiplet,
	type PluginVisibility,
	type PluginWorkspace,
} from "../plugin-contract";
import type { ShipletHost } from "./host";
import {
	checkPublishSize,
	feedbackListArguments,
	parseDeepLink,
	parseViewResult,
	parseWorkspaceList,
	toolErrorMessage,
	type FeedbackFilter,
	type Route,
	type ViewResult,
} from "./model";
import {
	createInitialState,
	detailKey,
	feedbackListKey,
	reduce,
	type Action,
	type AppState,
	type DetailData,
} from "./state";

export type HostView = {
	displayMode: "inline" | "fullscreen" | "pip";
	canFullscreen: boolean;
	platform: "web" | "desktop" | "mobile" | null;
	connection: "connecting" | "connected" | "failed";
};

type Listener = () => void;

export type ActionOutcome = { ok: true } | { ok: false; message: string };

export type FileRead =
	| { status: "ready"; content: string }
	| { status: "unavailable" }
	| { status: "missing" }
	| { status: "error"; message: string };

export class ShipletController {
	private state: AppState = createInitialState();
	private hostView: HostView = {
		displayMode: "inline",
		canFullscreen: false,
		platform: null,
		connection: "connecting",
	};
	private listeners = new Set<Listener>();
	private token = 0;
	private deepLinked = false;
	private sawToolInput = false;
	private attachedSent: string | null = null;
	private attachChain: Promise<void> = Promise.resolve();
	private host: ShipletHost | null = null;

	// -- external store plumbing ----------------------------------------------

	subscribe = (listener: Listener) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getState = () => this.state;
	getHostView = () => this.hostView;

	private emit() {
		for (const listener of [...this.listeners]) listener();
	}

	private dispatch(action: Action) {
		const next = reduce(this.state, action);
		if (next === this.state) return;
		this.state = next;
		this.emit();
		this.syncModelContext();
	}

	setHost(host: ShipletHost) {
		this.host = host;
	}

	setHostView(patch: Partial<HostView>) {
		const next = { ...this.hostView, ...patch };
		if (
			next.displayMode === this.hostView.displayMode &&
			next.canFullscreen === this.hostView.canFullscreen &&
			next.platform === this.hostView.platform &&
			next.connection === this.hostView.connection
		) {
			return;
		}
		this.hostView = next;
		this.emit();
	}

	private nextToken() {
		this.token += 1;
		return this.token;
	}

	private requireHost(): ShipletHost {
		if (!this.host) throw new Error("Shiplet is still connecting to ChatGPT.");
		return this.host;
	}

	private async call(name: Parameters<ShipletHost["callTool"]>[0], args: Record<string, unknown>) {
		return this.requireHost().callTool(name, args);
	}

	// -- host events ----------------------------------------------------------

	handleToolResult(structuredContent: unknown, isError: boolean | undefined) {
		if (isError) {
			// The entrypoint tool itself failed: fall back to loading the inbox.
			if (this.state.awaitingInitial) void this.loadShiplets();
			return;
		}
		const result = parseViewResult(structuredContent);
		if (!result) {
			if (this.state.awaitingInitial) void this.loadShiplets();
			return;
		}
		this.applyResult(result, this.deepLinked);
	}

	private applyResult(result: ViewResult, keepRoute: boolean) {
		if (keepRoute && result.view === "inbox") {
			this.dispatch({ type: "shiplets-request", token: this.nextToken() });
			this.dispatch({ type: "shiplets-resolve", token: this.token, data: result.shiplets });
			return;
		}
		this.dispatch({ type: "initial-result", result });
	}

	handleToolInput(file: { name: string; resourceUri: string } | null) {
		this.sawToolInput = true;
		if (file) {
			this.dispatch({
				type: "navigate",
				route: { kind: "html-file", fileName: file.name, resourceUri: file.resourceUri },
			});
		}
	}

	handleDeepLink(url: string | undefined) {
		if (url === undefined) return;
		const route = parseDeepLink(url);
		if (!route) return;
		if (this.state.route.kind === "html-file") return;
		if (route.kind === "inbox") {
			// The entrypoint's own result is the inbox; only navigate once it is here.
			if (!this.state.awaitingInitial) this.goInbox();
			return;
		}
		this.deepLinked = true;
		if (route.kind === "feedback") this.openShiplet(route.shipletId);
		else this.openDetail(route.shipletId, route.feedbackId);
	}

	/** `hostContext["openai/modelContext"]` became null: the user removed the attachment. */
	handleModelContextCleared() {
		// Respect the removal: do not re-attach the thread that is still open.
		// Opening a different thread attaches that one as usual.
		this.attachedSent = this.openDetailData()?.feedback.id ?? null;
		this.dispatch({ type: "attached", feedbackId: null });
	}

	handleModelContextRestored(structured: Record<string, unknown> | undefined) {
		const feedbackId = structured?.feedbackId;
		// Highlight only: the attachment stays as the user left it until they
		// open or close a thread here.
		if (typeof feedbackId === "string") this.dispatch({ type: "attached", feedbackId });
	}

	/** Called once `ui/initialize` finished. */
	handleConnected() {
		this.setHostView({ connection: "connected" });
		// Hosts send the entrypoint's tool result right after initialization.
		// If nothing arrives, load the inbox so the frame is never left empty.
		setTimeout(() => {
			if (this.state.awaitingInitial && !this.sawToolInput) void this.loadShiplets();
		}, 1500);
	}

	handleConnectFailed() {
		this.setHostView({ connection: "failed" });
	}

	// -- navigation -------------------------------------------------------------

	goInbox() {
		this.dispatch({ type: "navigate", route: { kind: "inbox" } });
		if (this.state.shiplets.status !== "ready" && this.state.shiplets.status !== "loading") {
			void this.loadShiplets();
		}
	}

	openShiplet(shipletId: string) {
		this.dispatch({ type: "navigate", route: { kind: "feedback", shipletId } });
		this.ensureFeedbackList(shipletId);
	}

	openDetail(shipletId: string, feedbackId: string) {
		this.dispatch({ type: "navigate", route: { kind: "detail", shipletId, feedbackId } });
		// Keep the list warm so Back (or the split view's left pane) is instant.
		this.ensureFeedbackList(shipletId);
		const key = detailKey(shipletId, feedbackId);
		const slot = this.state.detail;
		if (slot.key !== key || slot.status === "error" || slot.status === "idle") {
			void this.loadDetail(shipletId, feedbackId);
		}
	}

	closeDetail() {
		const route = this.state.route;
		if (route.kind !== "detail") return;
		this.openShiplet(route.shipletId);
	}

	setFilter(filter: FeedbackFilter) {
		const route = this.state.route;
		this.dispatch({ type: "set-filter", filter });
		const shipletId =
			route.kind === "feedback" || route.kind === "detail" ? route.shipletId : null;
		if (shipletId) this.ensureFeedbackList(shipletId);
	}

	private ensureFeedbackList(shipletId: string) {
		const key = feedbackListKey(shipletId, this.state.filter);
		const slot = this.state.feedbackList;
		if (slot.key === key && (slot.status === "ready" || slot.status === "loading")) return;
		void this.loadFeedback(shipletId, this.state.filter);
	}

	// -- loads ----------------------------------------------------------------

	async loadShiplets() {
		const token = this.nextToken();
		this.dispatch({ type: "shiplets-request", token });
		try {
			const result = parseViewResult(await this.call(PLUGIN_TOOL.listShiplets, {}));
			if (result?.view !== "inbox") throw new Error("Shiplet sent an unexpected response.");
			this.dispatch({ type: "shiplets-resolve", token, data: result.shiplets });
		} catch (error) {
			this.dispatch({ type: "shiplets-fail", token, message: toolErrorMessage(error) });
		}
	}

	async loadFeedback(shipletId: string, filter: FeedbackFilter) {
		const key = feedbackListKey(shipletId, filter);
		const token = this.nextToken();
		this.dispatch({ type: "feedback-request", key, token });
		try {
			const result = parseViewResult(
				await this.call(PLUGIN_TOOL.listFeedback, feedbackListArguments(shipletId, filter)),
			);
			if (result?.view !== "feedback") throw new Error("Shiplet sent an unexpected response.");
			this.dispatch({
				type: "feedback-resolve",
				key,
				token,
				data: { shiplet: result.shiplet, feedback: result.feedback },
			});
		} catch (error) {
			this.dispatch({ type: "feedback-fail", key, token, message: toolErrorMessage(error) });
		}
	}

	async loadDetail(shipletId: string, feedbackId: string) {
		const key = detailKey(shipletId, feedbackId);
		const token = this.nextToken();
		this.dispatch({ type: "detail-request", key, token });
		try {
			const result = parseViewResult(
				await this.call(PLUGIN_TOOL.getFeedback, {
					shiplet_id: shipletId,
					feedback_id: feedbackId,
				}),
			);
			if (result?.view !== "feedback-detail") {
				throw new Error("Shiplet sent an unexpected response.");
			}
			this.dispatch({
				type: "detail-resolve",
				key,
				token,
				data: { feedback: result.feedback, shiplet: result.shiplet ?? null },
			});
		} catch (error) {
			this.dispatch({ type: "detail-fail", key, token, message: toolErrorMessage(error) });
		}
	}

	retryCurrent() {
		const route = this.state.route;
		if (route.kind === "inbox") void this.loadShiplets();
		else if (route.kind === "feedback") void this.loadFeedback(route.shipletId, this.state.filter);
		else if (route.kind === "detail") void this.loadDetail(route.shipletId, route.feedbackId);
	}

	// -- mutations ------------------------------------------------------------

	async setStatus(feedback: PluginFeedbackDetail, next: FeedbackStatus) {
		if (feedback.status === next) return;
		this.dispatch({ type: "status-dismiss" });
		const before = this.state;
		this.dispatch({ type: "status-start", feedbackId: feedback.id, next });
		// Unchanged state means another status change is still in flight.
		if (this.state === before) return;
		try {
			const result = parseViewResult(
				await this.call(PLUGIN_TOOL.updateFeedbackStatus, {
					shiplet_id: feedback.shipletId,
					feedback_id: feedback.id,
					status: next,
				}),
			);
			this.dispatch({
				type: "status-settle",
				feedbackId: feedback.id,
				feedback: result?.view === "feedback-detail" ? result.feedback : null,
			});
		} catch (error) {
			this.dispatch({ type: "status-fail", feedbackId: feedback.id, message: toolErrorMessage(error) });
		}
	}

	dismissStatusError() {
		this.dispatch({ type: "status-dismiss" });
	}

	async postReply(feedback: PluginFeedbackDetail, comment: string): Promise<ActionOutcome> {
		const text = comment.trim();
		if (text === "") return { ok: false, message: "Write a reply first." };
		try {
			const result = parseViewResult(
				await this.call(PLUGIN_TOOL.replyToFeedback, {
					shiplet_id: feedback.shipletId,
					feedback_id: feedback.id,
					comment: text,
				}),
			);
			if (result?.view === "feedback-detail" && result.feedback.id === feedback.id) {
				this.dispatch({ type: "detail-replaced", feedback: result.feedback });
			} else {
				this.dispatch({
					type: "reply-added",
					feedbackId: feedback.id,
					reply: {
						id: `local-${this.nextToken()}`,
						authorName: null,
						comment: text,
						createdAt: new Date().toISOString(),
					},
				});
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, message: toolErrorMessage(error) };
		}
	}

	async ask(detail: DetailData): Promise<ActionOutcome> {
		try {
			await this.requireHost().askChatGPT(detail);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: toolErrorMessage(error) };
		}
	}

	async openLink(url: string): Promise<ActionOutcome> {
		try {
			await this.requireHost().openLink(url);
			return { ok: true };
		} catch (error) {
			return { ok: false, message: toolErrorMessage(error) };
		}
	}

	async requestFullscreen(): Promise<ActionOutcome> {
		try {
			await this.requireHost().requestFullscreen();
			return { ok: true };
		} catch (error) {
			return { ok: false, message: toolErrorMessage(error) };
		}
	}

	currentRoute(): Route {
		return this.state.route;
	}

	// -- HTML file entrypoint -------------------------------------------------

	async readHtmlFile(resourceUri: string | null): Promise<FileRead> {
		const host = this.host;
		if (!host) return { status: "error", message: "Shiplet is still connecting to ChatGPT." };
		try {
			await host.ready;
		} catch {
			return { status: "error", message: "Shiplet could not connect to ChatGPT." };
		}
		if (!resourceUri) return { status: "missing" };
		if (!host.canReadFiles()) return { status: "unavailable" };
		try {
			return { status: "ready", content: await host.readTextFile(resourceUri) };
		} catch (error) {
			return { status: "error", message: toolErrorMessage(error) };
		}
	}

	async loadWorkspaces(): Promise<
		{ ok: true; workspaces: PluginWorkspace[] } | { ok: false; message: string }
	> {
		try {
			const workspaces = parseWorkspaceList(await this.call(PLUGIN_TOOL.listWorkspaces, {}));
			if (!workspaces) throw new Error("Shiplet sent an unexpected response.");
			return { ok: true, workspaces };
		} catch (error) {
			return { ok: false, message: toolErrorMessage(error) };
		}
	}

	async publishHtml(
		name: string,
		content: string,
		visibility: PluginVisibility,
		workspaceId: string | null,
	): Promise<{ ok: true; shiplet: PluginShiplet } | { ok: false; message: string }> {
		const size = checkPublishSize(content);
		if (!size.ok) return { ok: false, message: size.message };
		try {
			const result = parseViewResult(
				await this.call(PLUGIN_TOOL.publishHtml, {
					name,
					files: [{ path: "index.html", content }],
					visibility,
					...(workspaceId ? { workspace_id: workspaceId } : {}),
				}),
			);
			if (result?.view !== "published") {
				return { ok: false, message: "Shiplet sent an unexpected response. Check your Shiplets before publishing again." };
			}
			return { ok: true, shiplet: result.shiplet };
		} catch (error) {
			return { ok: false, message: toolErrorMessage(error) };
		}
	}

	// -- model context --------------------------------------------------------

	private openDetailData(): DetailData | null {
		const { route, detail } = this.state;
		return route.kind === "detail" &&
			detail.status === "ready" &&
			detail.data?.feedback.id === route.feedbackId
			? detail.data
			: null;
	}

	private syncModelContext() {
		const host = this.host;
		if (!host || this.hostView.connection !== "connected") return;
		const open = this.openDetailData();
		const wanted = open?.feedback.id ?? null;
		if (wanted === this.attachedSent) return;
		const previous = this.attachedSent;
		this.attachedSent = wanted;
		this.attachChain = this.attachChain
			.then(async () => {
				if (open) {
					const acknowledged = await host.attachFeedback(open);
					if (this.attachedSent === open.feedback.id) {
						this.dispatch({ type: "attached", feedbackId: acknowledged ? open.feedback.id : null });
					}
				} else if (previous) {
					await host.clearAttachedFeedback();
					if (this.attachedSent === null) this.dispatch({ type: "attached", feedbackId: null });
				}
			})
			.catch(() => {
				// Context sharing is best-effort; the thread still works without it.
				if (this.attachedSent === wanted) this.attachedSent = previous;
			});
	}

	/** Re-run after connect, in case a detail was already open. */
	flushModelContext() {
		this.syncModelContext();
	}
}
