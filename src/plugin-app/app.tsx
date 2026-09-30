/// <reference lib="dom" />

import * as React from "react";

import {
	FEEDBACK_STATUSES,
	PLUGIN_VISIBILITIES,
	type FeedbackStatus,
	type PluginFeedbackDetail,
	type PluginFeedbackSummary,
	type PluginShiplet,
	type PluginVisibility,
	type PluginWorkspace,
} from "../plugin-contract";
import type { ActionOutcome, FileRead, HostView, ShipletController } from "./controller";
import {
	FEEDBACK_FILTER_LABELS,
	FEEDBACK_FILTERS,
	VISIBILITY_LABELS,
	checkPublishSize,
	filterFeedback,
	formatBytes,
	pagePath,
	prettifyFileName,
	relativeTime,
	searchShiplets,
	toolErrorMessage,
	type FeedbackFilter,
	type Route,
} from "./model";
import { feedbackListKey, type AppState, type DetailData } from "./state";

const INLINE_LIMIT = 5;
const SKELETON_ROWS = [0, 1, 2, 3];

type Props = { controller: ShipletController };

const ControllerContext = React.createContext<ShipletController | null>(null);

function useController(): ShipletController {
	const controller = React.useContext(ControllerContext);
	if (!controller) throw new Error("ShipletApp is missing its controller.");
	return controller;
}

function useWide(): boolean {
	const query = "(min-width: 720px)";
	const [wide, setWide] = React.useState(
		() => typeof matchMedia === "function" && matchMedia(query).matches,
	);
	React.useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const list = matchMedia(query);
		const update = () => setWide(list.matches);
		list.addEventListener("change", update);
		return () => list.removeEventListener("change", update);
	}, []);
	return wide;
}

/** Runs an async action and tracks pending/result for inline feedback. */
function useAction() {
	const [pending, setPending] = React.useState(false);
	const [outcome, setOutcome] = React.useState<ActionOutcome | null>(null);
	const mounted = React.useRef(true);
	React.useEffect(
		() => () => {
			mounted.current = false;
		},
		[],
	);
	const run = React.useCallback(async (task: () => Promise<ActionOutcome>) => {
		setPending(true);
		setOutcome(null);
		let result: ActionOutcome;
		try {
			result = await task();
		} catch (error) {
			result = { ok: false, message: toolErrorMessage(error) };
		}
		if (mounted.current) {
			setPending(false);
			setOutcome(result);
		}
		return result;
	}, []);
	const reset = React.useCallback(() => setOutcome(null), []);
	return { pending, outcome, run, reset };
}

// ---------------------------------------------------------------------------
// Root

export function ShipletApp({ controller }: Props) {
	return (
		<ControllerContext.Provider value={controller}>
			<ErrorBoundary>
				<Shell />
			</ErrorBoundary>
		</ControllerContext.Provider>
	);
}

class ErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<main className="sl-app">
				<div className="sl-notice card" role="alert">
					<p>Shiplet hit a problem showing this view.</p>
					<button
						type="button"
						className="btn cursor-interaction"
						onClick={() => this.setState({ failed: false })}
					>
						Try again
					</button>
				</div>
			</main>
		);
	}
}

function Shell() {
	const controller = useController();
	const state = React.useSyncExternalStore(controller.subscribe, controller.getState);
	const hostView = React.useSyncExternalStore(controller.subscribe, controller.getHostView);
	const wide = useWide();
	const inline = hostView.displayMode === "inline";
	const split = wide && !inline;

	React.useEffect(() => {
		const mark = () => {
			userInteracted = true;
		};
		document.addEventListener("pointerdown", mark, { capture: true, once: true });
		document.addEventListener("keydown", mark, { capture: true, once: true });
		return () => {
			document.removeEventListener("pointerdown", mark, { capture: true });
			document.removeEventListener("keydown", mark, { capture: true });
		};
	}, []);

	// Escape steps back one level. Listen on the document: focus often sits on
	// <body> after the focused control unmounts.
	React.useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("input, textarea, select")) return;
			const current = controller.getState().route;
			if (current.kind === "detail") {
				event.preventDefault();
				controller.closeDetail();
			} else if (current.kind === "feedback") {
				event.preventDefault();
				controller.goInbox();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [controller]);

	return (
		<main
			className="sl-app"
			data-display={hostView.displayMode}
			data-split={split ? "true" : undefined}
		>
			{hostView.connection === "failed" && state.awaitingInitial ? (
				<div className="sl-notice card" role="alert">
					<p>Shiplet could not connect to ChatGPT. Close and reopen Shiplet to try again.</p>
				</div>
			) : (
				<RouteView state={state} hostView={hostView} split={split} />
			)}
		</main>
	);
}

function RouteView({
	state,
	hostView,
	split,
}: {
	state: AppState;
	hostView: HostView;
	split: boolean;
}) {
	const route: Route = state.route;
	switch (route.kind) {
		case "inbox":
			return <InboxView state={state} hostView={hostView} />;
		case "feedback":
			return (
				<FeedbackView
					state={state}
					hostView={hostView}
					shipletId={route.shipletId}
					selectedId={null}
					split={split}
				/>
			);
		case "detail":
			return (
				<FeedbackView
					state={state}
					hostView={hostView}
					shipletId={route.shipletId}
					selectedId={route.feedbackId}
					split={split}
				/>
			);
		case "html-file":
			return (
				<HtmlFileView
					key={route.resourceUri ?? route.fileName}
					fileName={route.fileName}
					resourceUri={route.resourceUri}
					hostView={hostView}
				/>
			);
		case "published":
			return state.published ? (
				<section className="sl-view" aria-labelledby="sl-title">
					<Header
						eyebrow="Published"
						title={state.published.name}
						hostView={hostView}
						focusKey="published"
					/>
					<PublishedCard shiplet={state.published} />
				</section>
			) : null;
	}
}

// ---------------------------------------------------------------------------
// Shared pieces

/** Focus only moves after the user did something here; host-driven loads never steal it. */
let userInteracted = false;

/**
 * Moves focus to the returned element when `value` changes to a new non-null
 * key (view changes), so keyboard and screen reader users land on the new
 * view's heading. A null key leaves focus alone.
 */
function useFocusOnChange<T extends HTMLElement>(value: string | null) {
	const ref = React.useRef<T>(null);
	const previous = React.useRef<string | null | undefined>(undefined);
	React.useEffect(() => {
		const before = previous.current;
		previous.current = value;
		if (value === null || value === before) return;
		if (!userInteracted) return;
		ref.current?.focus({ preventScroll: true });
	}, [value]);
	return ref;
}

function Header({
	eyebrow,
	title,
	hostView,
	onBack,
	backLabel,
	actions,
	focusKey,
}: {
	eyebrow: string;
	title: React.ReactNode;
	hostView: HostView;
	onBack?: () => void;
	backLabel?: string;
	actions?: React.ReactNode;
	focusKey: string | null;
}) {
	const controller = useController();
	const titleRef = useFocusOnChange<HTMLHeadingElement>(focusKey);
	const expand = useAction();
	return (
		<header className="sl-header">
			{onBack ? (
				<button
					type="button"
					className="btn btn-ghost sl-icon-btn cursor-interaction"
					onClick={onBack}
					aria-label={backLabel ?? "Back"}
					title={backLabel ?? "Back"}
				>
					<ChevronLeft />
				</button>
			) : (
				<span className="sl-mark" aria-hidden="true">
					<Mark />
				</span>
			)}
			<div className="sl-heading">
				<p className="sl-eyebrow">{eyebrow}</p>
				<h1 id="sl-title" ref={titleRef} tabIndex={-1}>
					{title}
				</h1>
			</div>
			<div className="sl-header-actions">
				{actions}
				{hostView.canFullscreen ? (
					<button
						type="button"
						className="btn btn-ghost sl-icon-btn cursor-interaction"
						onClick={() => void expand.run(() => controller.requestFullscreen())}
						aria-label="Expand to fullscreen"
						title="Expand"
						disabled={expand.pending}
					>
						<ExpandIcon />
					</button>
				) : null}
			</div>
			{expand.outcome && !expand.outcome.ok ? (
				<p className="sl-inline-error text-small" role="status">
					{expand.outcome.message}
				</p>
			) : null}
		</header>
	);
}

function SkeletonList({ label }: { label: string }) {
	return (
		<ul className="sl-list" aria-busy="true" aria-label={label}>
			{SKELETON_ROWS.map((row) => (
				<li key={row} className="sl-row sl-row-skeleton" aria-hidden="true">
					<span className="sl-skeleton sl-skeleton-title" />
					<span className="sl-skeleton sl-skeleton-meta" />
				</li>
			))}
		</ul>
	);
}

function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div className="sl-error" role="alert">
			<p>{message}</p>
			{onRetry ? (
				<button type="button" className="btn cursor-interaction" onClick={onRetry}>
					Retry
				</button>
			) : null}
		</div>
	);
}

function StatusPill({ status }: { status: FeedbackStatus }) {
	return (
		<span className="sl-status" data-status={status}>
			{status}
		</span>
	);
}

function VisibilityBadge({ visibility }: { visibility: PluginVisibility }) {
	return <span className="sl-badge">{VISIBILITY_LABELS[visibility]}</span>;
}

function ShowAll({ total, hostView }: { total: number; hostView: HostView }) {
	const controller = useController();
	const expand = useAction();
	if (!hostView.canFullscreen) return null;
	return (
		<div className="sl-show-all">
			<button
				type="button"
				className="btn btn-ghost cursor-interaction"
				disabled={expand.pending}
				onClick={() => void expand.run(() => controller.requestFullscreen())}
			>
				Show all {total} in fullscreen
			</button>
			{expand.outcome && !expand.outcome.ok ? (
				<p className="sl-inline-error text-small">{expand.outcome.message}</p>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Inbox

function InboxView({ state, hostView }: { state: AppState; hostView: HostView }) {
	const controller = useController();
	const [query, setQuery] = React.useState("");
	const slot = state.shiplets;
	const shiplets = slot.data ?? [];
	const visible = searchShiplets(shiplets, query);
	const inline = hostView.displayMode === "inline";
	const capped = inline && hostView.canFullscreen ? visible.slice(0, INLINE_LIMIT) : visible;
	const showSkeleton = slot.data === null && slot.status !== "error";

	return (
		<section className="sl-view" aria-labelledby="sl-title">
			<Header
				eyebrow="Shiplet"
				title="Review inbox"
				hostView={hostView}
				focusKey="inbox"
				actions={
					slot.status === "ready" ? (
						<button
							type="button"
							className="btn btn-ghost sl-icon-btn cursor-interaction"
							onClick={() => void controller.loadShiplets()}
							aria-label="Refresh Shiplets"
							title="Refresh"
						>
							<RefreshIcon />
						</button>
					) : null
				}
			/>
			{shiplets.length > 0 ? (
				<div className="sl-search">
					<label className="sr-only" htmlFor="sl-search">
						Search Shiplets
					</label>
					<input
						id="sl-search"
						className="form-control"
						type="search"
						placeholder="Search Shiplets"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						autoComplete="off"
					/>
				</div>
			) : null}
			{slot.status === "error" ? (
				<InlineError message={slot.error ?? ""} onRetry={() => void controller.loadShiplets()} />
			) : null}
			{showSkeleton ? (
				<SkeletonList label="Shiplets" />
			) : slot.data && shiplets.length === 0 ? (
				<div className="sl-empty card">
					<p className="sl-empty-title">No Shiplets yet</p>
					<p className="text-muted">
						Ask ChatGPT to publish an HTML page for review. It will show up here with its
						feedback.
					</p>
				</div>
			) : slot.data && visible.length === 0 ? (
				<p className="sl-empty-line text-muted">No Shiplets match “{query.trim()}”.</p>
			) : slot.data ? (
				<>
					<ul className="sl-list" aria-label="Shiplets" aria-busy={slot.status === "loading"}>
						{capped.map((shiplet) => (
							<ShipletRow
								key={shiplet.id}
								shiplet={shiplet}
								onOpen={() => controller.openShiplet(shiplet.id)}
							/>
						))}
					</ul>
					{capped.length < visible.length ? (
						<ShowAll total={visible.length} hostView={hostView} />
					) : null}
				</>
			) : null}
		</section>
	);
}

function ShipletRow({ shiplet, onOpen }: { shiplet: PluginShiplet; onOpen: () => void }) {
	const updated = relativeTime(shiplet.updatedAt);
	return (
		<li>
			<button type="button" className="sl-row cursor-interaction" onClick={onOpen}>
				<span className="sl-row-main">
					<span className="sl-row-title">{shiplet.name}</span>
					{shiplet.openFeedbackCount !== null && shiplet.openFeedbackCount > 0 ? (
						<span className="sl-count" aria-label={`${shiplet.openFeedbackCount} open feedback`}>
							{shiplet.openFeedbackCount} open
						</span>
					) : null}
				</span>
				<span className="sl-row-meta text-small text-muted">
					<VisibilityBadge visibility={shiplet.visibility} />
					{shiplet.openFeedbackCount === 0 ? <span>No open feedback</span> : null}
					{shiplet.archived ? <span>Archived</span> : null}
					{updated ? <span>Updated {updated}</span> : null}
				</span>
			</button>
		</li>
	);
}

// ---------------------------------------------------------------------------
// Feedback list + detail

function FeedbackView({
	state,
	hostView,
	shipletId,
	selectedId,
	split,
}: {
	state: AppState;
	hostView: HostView;
	shipletId: string;
	selectedId: string | null;
	split: boolean;
}) {
	const controller = useController();
	const showList = selectedId === null || split;
	const showDetail = selectedId !== null;
	const listSlot = state.feedbackList;
	const listData =
		listSlot.data && listSlot.data.shiplet.id === shipletId ? listSlot.data : null;
	const shiplet =
		listData?.shiplet ??
		state.knownShiplets[shipletId] ??
		(state.detail.data?.feedback.shipletId === shipletId ? state.detail.data.shiplet : null);
	const openInShiplet = useAction();

	return (
		<section className="sl-view" aria-labelledby="sl-title">
			<Header
				eyebrow="Shiplet feedback"
				title={shiplet?.name ?? <span className="sl-skeleton sl-skeleton-heading" aria-hidden="true" />}
				hostView={hostView}
				focusKey={selectedId === null ? `feedback:${shipletId}` : null}
				onBack={
					selectedId !== null && !split
						? () => controller.closeDetail()
						: () => controller.goInbox()
				}
				backLabel={selectedId !== null && !split ? "Back to feedback" : "Back to inbox"}
				actions={
					shiplet ? (
						<button
							type="button"
							className="btn cursor-interaction"
							disabled={openInShiplet.pending}
							onClick={() => void openInShiplet.run(() => controller.openLink(shiplet.reviewUrl))}
						>
							Open in Shiplet
						</button>
					) : null
				}
			/>
			{openInShiplet.outcome && !openInShiplet.outcome.ok ? (
				<p className="sl-inline-error text-small" role="status">
					{openInShiplet.outcome.message}
				</p>
			) : null}
			<div className="sl-panes">
				{showList ? (
					<FeedbackListPane
						state={state}
						hostView={hostView}
						shipletId={shipletId}
						selectedId={selectedId}
					/>
				) : null}
				{showDetail && selectedId ? (
					<DetailPane state={state} shipletId={shipletId} feedbackId={selectedId} split={split} />
				) : null}
			</div>
		</section>
	);
}

const EMPTY_FEEDBACK: Record<FeedbackFilter, string> = {
	open: "No open feedback. New threads from reviewers land here.",
	done: "Nothing is marked Done yet.",
	all: "No feedback on this Shiplet yet. Share the review link to collect some.",
};

function FeedbackListPane({
	state,
	hostView,
	shipletId,
	selectedId,
}: {
	state: AppState;
	hostView: HostView;
	shipletId: string;
	selectedId: string | null;
}) {
	const controller = useController();
	const slot = state.feedbackList;
	const matches = slot.key === feedbackListKey(shipletId, state.filter);
	const items = matches && slot.data ? filterFeedback(slot.data.feedback, state.filter) : null;
	const inline = hostView.displayMode === "inline";
	const capped = items && inline && hostView.canFullscreen ? items.slice(0, INLINE_LIMIT) : items;

	return (
		<div className="sl-pane sl-pane-list">
			<div className="sl-filters" role="group" aria-label="Filter feedback">
				{FEEDBACK_FILTERS.map((filter) => (
					<button
						key={filter}
						type="button"
						className="btn sl-chip cursor-interaction"
						aria-pressed={state.filter === filter}
						onClick={() => controller.setFilter(filter)}
					>
						{FEEDBACK_FILTER_LABELS[filter]}
					</button>
				))}
				{matches && slot.status === "ready" ? (
					<button
						type="button"
						className="btn btn-ghost sl-icon-btn cursor-interaction sl-filters-end"
						onClick={() => void controller.loadFeedback(shipletId, state.filter)}
						aria-label="Refresh feedback"
						title="Refresh"
					>
						<RefreshIcon />
					</button>
				) : null}
			</div>
			{matches && slot.status === "error" ? (
				<InlineError
					message={slot.error ?? ""}
					onRetry={() => void controller.loadFeedback(shipletId, state.filter)}
				/>
			) : null}
			{capped === null ? (
				matches && slot.status === "error" ? null : <SkeletonList label="Feedback" />
			) : capped.length === 0 ? (
				<p className="sl-empty-line text-muted">{EMPTY_FEEDBACK[state.filter]}</p>
			) : (
				<>
					<ul className="sl-list" aria-label="Feedback" aria-busy={slot.status === "loading"}>
						{capped.map((item) => (
							<FeedbackRow
								key={item.id}
								item={item}
								selected={item.id === selectedId}
								attached={item.id === state.attachedFeedbackId}
								onOpen={() => controller.openDetail(item.shipletId, item.id)}
							/>
						))}
					</ul>
					{items && capped.length < items.length ? (
						<ShowAll total={items.length} hostView={hostView} />
					) : null}
				</>
			)}
		</div>
	);
}

function FeedbackRow({
	item,
	selected,
	attached,
	onOpen,
}: {
	item: PluginFeedbackSummary;
	selected: boolean;
	attached: boolean;
	onOpen: () => void;
}) {
	const path = pagePath(item.pageUrl);
	return (
		<li>
			<button
				type="button"
				className="sl-row cursor-interaction"
				data-selected={selected ? "true" : undefined}
				data-attached={attached ? "true" : undefined}
				aria-current={selected ? "true" : undefined}
				onClick={onOpen}
			>
				<span className="sl-row-main">
					<span className="sl-row-title">{item.title || "Untitled feedback"}</span>
					<StatusPill status={item.status} />
				</span>
				<span className="sl-row-meta text-small text-muted">
					{item.authorName ? <span>{item.authorName}</span> : null}
					{path ? <span className="sl-mono sl-truncate">{path}</span> : null}
					<span>
						{item.replyCount === 1 ? "1 reply" : `${item.replyCount} replies`}
					</span>
				</span>
			</button>
		</li>
	);
}

function DetailPane({
	state,
	shipletId,
	feedbackId,
	split,
}: {
	state: AppState;
	shipletId: string;
	feedbackId: string;
	split: boolean;
}) {
	const controller = useController();
	const slot = state.detail;
	const detail =
		slot.data && slot.data.feedback.id === feedbackId && slot.data.feedback.shipletId === shipletId
			? slot.data
			: null;

	return (
		<div className="sl-pane sl-pane-detail" aria-busy={detail === null && slot.status === "loading"}>
			{split ? (
				<div className="sl-detail-close">
					<button
						type="button"
						className="btn btn-ghost cursor-interaction"
						onClick={() => controller.closeDetail()}
					>
						Close thread
					</button>
				</div>
			) : null}
			{slot.status === "error" && detail === null ? (
				<InlineError
					message={slot.error ?? ""}
					onRetry={() => void controller.loadDetail(shipletId, feedbackId)}
				/>
			) : detail === null ? (
				<DetailSkeleton />
			) : (
				<FeedbackDetail
					key={detail.feedback.id}
					detail={detail}
					attached={state.attachedFeedbackId === detail.feedback.id}
					mutation={
						state.statusMutation?.feedbackId === detail.feedback.id ? state.statusMutation : null
					}
				/>
			)}
		</div>
	);
}

function DetailSkeleton() {
	return (
		<div className="sl-detail" aria-hidden="true">
			<span className="sl-skeleton sl-skeleton-heading" />
			<span className="sl-skeleton sl-skeleton-meta" />
			<span className="sl-skeleton sl-skeleton-block" />
		</div>
	);
}

function FeedbackDetail({
	detail,
	attached,
	mutation,
}: {
	detail: DetailData;
	attached: boolean;
	mutation: AppState["statusMutation"];
}) {
	const controller = useController();
	const { feedback } = detail;
	const ask = useAction();
	const openThread = useAction();
	const path = pagePath(feedback.pageUrl);
	const created = relativeTime(feedback.createdAt);
	const titleRef = useFocusOnChange<HTMLHeadingElement>(`detail:${feedback.id}`);

	return (
		<article className="sl-detail" aria-labelledby="sl-detail-title">
			<div className="sl-detail-head">
				<h2 id="sl-detail-title" ref={titleRef} tabIndex={-1}>
					{feedback.title || "Untitled feedback"}
				</h2>
				<p className="sl-row-meta text-small text-muted">
					<StatusPill status={feedback.status} />
					{feedback.authorName ? <span>{feedback.authorName}</span> : null}
					{created ? <span>{created}</span> : null}
					{path ? <span className="sl-mono sl-truncate">{path}</span> : null}
				</p>
			</div>

			<div className="sl-comment card">{feedback.comment || "No comment text."}</div>

			<div className="sl-actions">
				<button
					type="button"
					className="btn btn-primary cursor-interaction"
					disabled={ask.pending}
					aria-busy={ask.pending}
					onClick={() => void ask.run(() => controller.ask(detail))}
				>
					Ask ChatGPT to address this
				</button>
				<button
					type="button"
					className="btn cursor-interaction"
					disabled={openThread.pending}
					onClick={() => void openThread.run(() => controller.openLink(feedback.url))}
				>
					Open thread
				</button>
			</div>
			{ask.outcome ? (
				<p
					className={`text-small ${ask.outcome.ok ? "text-muted" : "sl-inline-error"}`}
					role="status"
				>
					{ask.outcome.ok ? "Sent to ChatGPT." : ask.outcome.message}
				</p>
			) : null}
			{openThread.outcome && !openThread.outcome.ok ? (
				<p className="sl-inline-error text-small" role="status">
					{openThread.outcome.message}
				</p>
			) : null}
			{attached ? (
				<p className="text-small text-muted sl-attached">Shared with ChatGPT as context</p>
			) : null}

			<StatusControl feedback={feedback} mutation={mutation} />

			<section className="sl-replies" aria-label="Replies">
				<h3 className="sl-eyebrow">
					{feedback.replies.length === 1 ? "1 reply" : `${feedback.replies.length} replies`}
				</h3>
				{feedback.replies.length > 0 ? (
					<ol className="sl-reply-list">
						{feedback.replies.map((reply) => (
							<li key={reply.id} className="sl-reply">
								<p className="text-small text-muted">
									<strong className="sl-reply-author">{reply.authorName ?? "You"}</strong>
									{reply.createdAt ? ` · ${relativeTime(reply.createdAt)}` : ""}
								</p>
								<p className="sl-reply-body">{reply.comment}</p>
							</li>
						))}
					</ol>
				) : null}
				<ReplyBox feedback={feedback} />
			</section>
		</article>
	);
}

function StatusControl({
	feedback,
	mutation,
}: {
	feedback: PluginFeedbackDetail;
	mutation: AppState["statusMutation"];
}) {
	const controller = useController();
	const id = `sl-status-${feedback.id}`;
	return (
		<div className="sl-field sl-status-field">
			<label className="form-label text-small" htmlFor={id}>
				Status
			</label>
			<select
				id={id}
				className="form-select cursor-interaction"
				value={feedback.status}
				disabled={mutation?.pending === true}
				aria-busy={mutation?.pending === true}
				onChange={(event) =>
					void controller.setStatus(feedback, event.target.value as FeedbackStatus)
				}
			>
				{FEEDBACK_STATUSES.map((status) => (
					<option key={status} value={status}>
						{status}
					</option>
				))}
			</select>
			{mutation?.error ? (
				<div className="sl-error" role="alert">
					<p>
						Status stayed {feedback.status}. {mutation.error}
					</p>
					<button
						type="button"
						className="btn cursor-interaction"
						onClick={() => void controller.setStatus(feedback, mutation.next)}
					>
						Retry
					</button>
				</div>
			) : null}
		</div>
	);
}

function ReplyBox({ feedback }: { feedback: PluginFeedbackDetail }) {
	const controller = useController();
	const [draft, setDraft] = React.useState("");
	const post = useAction();
	const id = `sl-reply-${feedback.id}`;
	const submit = async () => {
		if (post.pending || draft.trim() === "") return;
		const result = await post.run(() => controller.postReply(feedback, draft));
		if (result.ok) setDraft("");
	};
	// Not a <form>: host sandboxes may omit allow-forms, which silently blocks submit.
	return (
		<div className="sl-reply-form">
			<label className="form-label text-small" htmlFor={id}>
				Reply
			</label>
			<textarea
				id={id}
				className="form-control"
				rows={3}
				value={draft}
				placeholder="Write a reply for the thread"
				onChange={(event) => {
					setDraft(event.target.value);
					if (post.outcome) post.reset();
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						void submit();
					}
				}}
			/>
			<div className="sl-actions">
				<button
					type="button"
					className="btn cursor-interaction"
					disabled={post.pending || draft.trim() === ""}
					aria-busy={post.pending}
					onClick={() => void submit()}
				>
					Post reply
				</button>
				{post.outcome ? (
					<p
						className={`text-small ${post.outcome.ok ? "text-muted" : "sl-inline-error"}`}
						role="status"
					>
						{post.outcome.ok ? "Reply posted." : post.outcome.message}
					</p>
				) : null}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Published result

function PublishedCard({ shiplet }: { shiplet: PluginShiplet }) {
	const controller = useController();
	const open = useAction();
	const [copyState, setCopyState] = React.useState<"idle" | "copied" | "manual">("idle");
	const inputRef = React.useRef<HTMLInputElement>(null);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(shiplet.reviewUrl);
			setCopyState("copied");
		} catch {
			const input = inputRef.current;
			input?.focus();
			input?.select();
			let copied = false;
			try {
				copied = document.execCommand("copy");
			} catch {
				copied = false;
			}
			setCopyState(copied ? "copied" : "manual");
		}
	};

	return (
		<div className="sl-published card">
			<p className="sl-eyebrow">Ready for review</p>
			<p className="sl-published-name">
				{shiplet.name} <VisibilityBadge visibility={shiplet.visibility} />
			</p>
			<label className="sr-only" htmlFor="sl-review-url">
				Review link
			</label>
			<input
				id="sl-review-url"
				ref={inputRef}
				className="form-control sl-mono"
				readOnly
				value={shiplet.reviewUrl}
				onFocus={(event) => event.currentTarget.select()}
			/>
			<div className="sl-actions">
				<button
					type="button"
					className="btn btn-primary cursor-interaction"
					disabled={open.pending}
					onClick={() => void open.run(() => controller.openLink(shiplet.reviewUrl))}
				>
					Open review
				</button>
				<button type="button" className="btn cursor-interaction" onClick={() => void copy()}>
					Copy link
				</button>
				<span className="text-small text-muted" role="status">
					{copyState === "copied"
						? "Link copied."
						: copyState === "manual"
							? "Link selected. Press Ctrl+C or Cmd+C to copy."
							: ""}
				</span>
			</div>
			{open.outcome && !open.outcome.ok ? (
				<p className="sl-inline-error text-small" role="status">
					{open.outcome.message}
				</p>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// HTML file viewer

function HtmlFileView({
	fileName,
	resourceUri,
	hostView,
}: {
	fileName: string;
	resourceUri: string | null;
	hostView: HostView;
}) {
	const controller = useController();
	const [file, setFile] = React.useState<FileRead | { status: "reading" }>({ status: "reading" });
	const [attempt, setAttempt] = React.useState(0);

	React.useEffect(() => {
		let cancelled = false;
		setFile({ status: "reading" });
		void controller.readHtmlFile(resourceUri).then((result) => {
			if (!cancelled) setFile(result);
		});
		return () => {
			cancelled = true;
		};
	}, [controller, resourceUri, attempt]);

	return (
		<section className="sl-view sl-file" aria-labelledby="sl-title">
			<Header eyebrow="HTML file" title={fileName} hostView={hostView} focusKey={fileName} />
			{file.status === "unavailable" ? (
				<div className="sl-notice card">
					<p>
						Previewing local files needs the ChatGPT desktop app. You can still ask ChatGPT to
						publish this page for review.
					</p>
				</div>
			) : file.status === "missing" ? (
				<div className="sl-notice card">
					<p>Open an .html file from ChatGPT to preview and publish it here.</p>
				</div>
			) : file.status === "error" ? (
				<InlineError message={file.message} onRetry={() => setAttempt((value) => value + 1)} />
			) : (
				<div className="sl-file-layout">
					<PublishForm fileName={fileName} content={file.status === "ready" ? file.content : null} />
					<div className="sl-preview card" aria-busy={file.status === "reading"}>
						{file.status === "ready" ? (
							<iframe
								title={`Preview of ${fileName}`}
								sandbox="allow-scripts"
								srcDoc={file.content}
								referrerPolicy="no-referrer"
							/>
						) : (
							<span className="sl-skeleton sl-skeleton-preview" aria-hidden="true" />
						)}
					</div>
				</div>
			)}
		</section>
	);
}

function PublishForm({ fileName, content }: { fileName: string; content: string | null }) {
	const controller = useController();
	const [name, setName] = React.useState(() => prettifyFileName(fileName));
	const [visibility, setVisibility] = React.useState<PluginVisibility>("organization");
	const [published, setPublished] = React.useState<PluginShiplet | null>(null);
	const [workspaces, setWorkspaces] = React.useState<PluginWorkspace[] | "loading" | "unavailable">(
		"loading",
	);
	const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
	const publish = useAction();
	const size = content === null ? null : checkPublishSize(content);

	// Runs alongside the file read. Accounts in several workspaces must say
	// where to publish; if the list fails, publishing still works for accounts
	// with one workspace and the server explains otherwise.
	React.useEffect(() => {
		let cancelled = false;
		void controller.loadWorkspaces().then((result) => {
			if (cancelled) return;
			if (!result.ok) {
				setWorkspaces("unavailable");
				return;
			}
			setWorkspaces(result.workspaces);
			setWorkspaceId(result.workspaces[0]?.id ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [controller]);

	if (published) return <PublishedCard shiplet={published} />;

	const workspacesLoading = workspaces === "loading";
	const workspaceChoices = Array.isArray(workspaces) && workspaces.length > 1 ? workspaces : null;
	const canPublish = !publish.pending && size !== null && size.ok && !workspacesLoading;

	const submit = () =>
		publish.run(async () => {
			if (content === null) return { ok: false, message: "The file is not ready yet." };
			const result = await controller.publishHtml(
				name.trim() || prettifyFileName(fileName),
				content,
				visibility,
				Array.isArray(workspaces) ? workspaceId : null,
			);
			if (result.ok) setPublished(result.shiplet);
			return result.ok ? { ok: true } : result;
		});

	// Not a <form>: host sandboxes may omit allow-forms, which silently blocks submit.
	return (
		<div className="sl-publish card" role="group" aria-label="Publish for review">
			<div className="sl-publish-fields">
				<div className="sl-field">
					<label className="form-label text-small" htmlFor="sl-publish-name">
						Name
					</label>
					<input
						id="sl-publish-name"
						className="form-control"
						value={name}
						maxLength={120}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && canPublish) {
								event.preventDefault();
								void submit();
							}
						}}
						autoComplete="off"
					/>
				</div>
				<div className="sl-field">
					<label className="form-label text-small" htmlFor="sl-publish-visibility">
						Visibility
					</label>
					<select
						id="sl-publish-visibility"
						className="form-select cursor-interaction"
						value={visibility}
						onChange={(event) => setVisibility(event.target.value as PluginVisibility)}
					>
						{PLUGIN_VISIBILITIES.map((option) => (
							<option key={option} value={option}>
								{VISIBILITY_LABELS[option]}
							</option>
						))}
					</select>
				</div>
				{workspacesLoading || workspaceChoices ? (
					<div className="sl-field sl-field-wide">
						<label className="form-label text-small" htmlFor="sl-publish-workspace">
							Workspace
						</label>
						<select
							id="sl-publish-workspace"
							className="form-select cursor-interaction"
							value={workspaceId ?? ""}
							disabled={workspacesLoading}
							aria-busy={workspacesLoading}
							onChange={(event) => setWorkspaceId(event.target.value)}
						>
							{(workspaceChoices ?? []).map((workspace) => (
								<option key={workspace.id} value={workspace.id}>
									{workspace.name}
								</option>
							))}
						</select>
					</div>
				) : null}
			</div>
			<div className="sl-actions">
				<button
					type="button"
					className="btn btn-primary cursor-interaction"
					disabled={!canPublish}
					aria-busy={publish.pending || workspacesLoading}
					onClick={() => void submit()}
				>
					Publish for review
				</button>
				{size?.ok ? (
					<span className="text-small text-muted">{formatBytes(size.bytes)}</span>
				) : null}
			</div>
			{size && !size.ok ? (
				<p className="sl-inline-error text-small" role="alert">
					{size.message}
				</p>
			) : null}
			{publish.outcome && !publish.outcome.ok ? (
				<InlineError message={publish.outcome.message} onRetry={() => void submit()} />
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Icons (inline, decorative)

function ChevronLeft() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
			<path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ExpandIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
			<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function RefreshIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
			<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function Mark() {
	return (
		<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
			<path d="M7 2.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
			<path d="M7.6 3h6.2l-2 2.2 2 2.2H7.6z" className="sl-mark-flag" />
			<path d="M2.5 12h15l-2.2 4.2H4.7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
			<rect x="7.8" y="9.1" width="2.4" height="2.4" rx=".4" className="sl-mark-cargo-a" />
			<rect x="10.8" y="9.1" width="2.4" height="2.4" rx=".4" className="sl-mark-cargo-b" />
		</svg>
	);
}
