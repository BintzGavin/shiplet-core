/// <reference lib="dom" />

import * as React from "react";
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { useStore } from "zustand";

import {
	createFeedbackStore,
	normalizeFeedbackFilters,
	type FeedbackFilters,
	type FeedbackState,
	type FeedbackStore,
	type FeedbackStoreInitialState,
} from "./feedback-state";
import { PlatformNav } from "./navigation";
import {
	PLATFORM_FEEDBACK_QUERY_KEY,
	usePlatformCounts,
} from "./platform-counts";
import type { ReviewFeedbackRecord } from "../review";

export type FeedbackQueryResult = {
	feedback: ReviewFeedbackRecord[];
};

export type FeedbackAppProps = {
	feedbackEndpoint: string;
	initialFeedback: ReviewFeedbackRecord[];
	initialFilters: FeedbackFilters;
	initialUi?: FeedbackStoreInitialState;
};

type StatusState = {
	kind: "success" | "warning" | "error" | "info";
	message: string;
};

const FEEDBACK_REFETCH_MS = 15_000;
const FEEDBACK_STALE_MS = 10_000;
const FEEDBACK_STATUSES = ["New", "In Progress", "Blocked", "Done", "Dropped"];

const FeedbackStoreContext = React.createContext<FeedbackStore | null>(null);

export function FeedbackApp(props: FeedbackAppProps) {
	const initialFilters = normalizeFeedbackFilters(props.initialFilters);
	const [queryClient] = React.useState(() => {
		const client = createFeedbackQueryClient();
		const feedbackData = { feedback: props.initialFeedback };
		client.setQueryData<FeedbackQueryResult>(
			feedbackQueryKey(initialFilters),
			feedbackData,
		);
		if (!hasActiveFeedbackFilters(initialFilters)) {
			client.setQueryData<FeedbackQueryResult>(
				PLATFORM_FEEDBACK_QUERY_KEY,
				feedbackData,
			);
		}
		return client;
	});
	const storeRef = React.useRef<FeedbackStore | null>(null);

	if (!storeRef.current) {
		storeRef.current = createFeedbackStore({
			filters: initialFilters,
			selectedTicketId: props.initialUi?.selectedTicketId || null,
		});
	}

	return (
		<QueryClientProvider client={queryClient}>
			<FeedbackStoreContext.Provider value={storeRef.current}>
				<FeedbackPage
					feedbackEndpoint={props.feedbackEndpoint}
					initialFeedback={props.initialFeedback}
					initialFilters={initialFilters}
				/>
			</FeedbackStoreContext.Provider>
		</QueryClientProvider>
	);
}

function FeedbackPage(props: {
	feedbackEndpoint: string;
	initialFeedback: ReviewFeedbackRecord[];
	initialFilters: FeedbackFilters;
}) {
	const queryClient = useQueryClient();
	const filters = useFeedbackStore((state) => state.filters);
	const setFilters = useFeedbackStore((state) => state.setFilters);
	const selectedTicketId = useFeedbackStore((state) => state.selectedTicketId);
	const setSelectedTicketId = useFeedbackStore(
		(state) => state.setSelectedTicketId,
	);
	const [draftFilters, setDraftFilters] = React.useState(() =>
		normalizeFeedbackFilters(filters),
	);
	const [hydrationState, setHydrationState] = React.useState<
		"pending" | "hydrated"
	>("pending");
	const [status, setStatus] = React.useState<StatusState>({
		kind: "info",
		message: "Live updates on",
	});
	const hasActiveFilters = hasActiveFeedbackFilters(filters);
	const isInitialFilterQuery = feedbackFiltersEqual(
		filters,
		props.initialFilters,
	);
	const platformCounts = usePlatformCounts(
		hasActiveFilters ? {} : { initialFeedback: props.initialFeedback },
	);
	const queryKey = React.useMemo(() => feedbackQueryKey(filters), [filters]);
	const query = useQuery({
		queryKey,
		queryFn: () => fetchFeedback(props.feedbackEndpoint, filters),
		initialData: isInitialFilterQuery
			? { feedback: props.initialFeedback }
			: undefined,
		refetchInterval: FEEDBACK_REFETCH_MS,
		refetchOnWindowFocus: true,
		staleTime: FEEDBACK_STALE_MS,
	});
	const feedback =
		query.data?.feedback || (isInitialFilterQuery ? props.initialFeedback : []);

	React.useEffect(() => {
		setHydrationState("hydrated");
	}, []);

	React.useEffect(() => {
		setDraftFilters(normalizeFeedbackFilters(filters));
	}, [filters]);

	React.useEffect(() => {
		if (query.data && !hasActiveFilters) {
			queryClient.setQueryData<FeedbackQueryResult>(
				PLATFORM_FEEDBACK_QUERY_KEY,
				query.data,
			);
		}
	}, [hasActiveFilters, query.data, queryClient]);

	React.useEffect(() => {
		if (query.error) {
			setStatus({
				kind: "error",
				message:
					query.error instanceof Error
						? query.error.message
						: "Failed to load feedback.",
			});
		} else if (query.dataUpdatedAt > 0) {
			setStatus({
				kind: "success",
				message: `Live. Updated ${formatTimeLabel(query.dataUpdatedAt)}.`,
			});
		}
	}, [query.dataUpdatedAt, query.error]);

	React.useEffect(() => {
		syncSerializedFeedbackState({
			feedback,
			feedbackEndpoint: props.feedbackEndpoint,
			filters,
			queryKey,
		});
	}, [feedback, filters, props.feedbackEndpoint, queryKey]);

	React.useEffect(() => {
		function onPopState() {
			const nextFilters = feedbackFiltersFromSearch(window.location.search);
			setDraftFilters(nextFilters);
			setFilters(nextFilters);
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [setFilters]);

	React.useEffect(() => {
		function onPlatformFeedbackUpdated(event: Event) {
			const detail = (event as CustomEvent).detail as
				| { feedback?: ReviewFeedbackRecord[]; filters?: FeedbackFilters }
				| undefined;
			if (!Array.isArray(detail?.feedback)) return;
			if (
				detail.filters &&
				!feedbackFiltersEqual(detail.filters, filters)
			) {
				return;
			}
			const nextData = { feedback: detail.feedback };
			queryClient.setQueryData<FeedbackQueryResult>(queryKey, nextData);
			if (!hasActiveFilters) {
				queryClient.setQueryData<FeedbackQueryResult>(
					PLATFORM_FEEDBACK_QUERY_KEY,
					nextData,
				);
			}
			setStatus({
				kind: "success",
				message: `Live. Updated ${formatTimeLabel(Date.now())}.`,
			});
		}
		window.addEventListener(
			"shiplet:platform-feedback-updated",
			onPlatformFeedbackUpdated,
		);
		return () => {
			window.removeEventListener(
				"shiplet:platform-feedback-updated",
				onPlatformFeedbackUpdated,
			);
		};
	}, [filters, hasActiveFilters, queryClient, queryKey]);

	const handleFilterSubmit = React.useCallback(
		(event: React.FormEvent<HTMLFormElement>) => {
			event.preventDefault();
			const nextFilters = normalizeFeedbackFilters(draftFilters);
			setFilters(nextFilters);
			replaceFeedbackUrl(nextFilters);
		},
		[draftFilters, setFilters],
	);

	return (
		<div
			className="dashboard-shell shiplet-dashboard-stage"
			data-feedback-endpoint={props.feedbackEndpoint}
			data-feedback-hydration={hydrationState}
			data-live-updates="polling"
			data-platform-app="react-tanstack"
			data-platform-route="feedback"
			data-platform-state="zustand"
			data-selected-ticket-id={selectedTicketId || ""}
		>
			<header className="app-page-topbar">
				<div className="app-page-title">
					<span className="success-card-label">Feedback</span>
					<h1>All feedback</h1>
					<p>A flat newest-first view across every shiplet you can access.</p>
				</div>
			</header>

			<PlatformNav counts={platformCounts} current="feedback" />

			<section className="success-card shiplet-panel">
				<div className="dashboard-section-header">
					<div>
						<span className="success-card-label">Global ledger</span>
						<h2>Review comments</h2>
						<span
							className={`live-status live-status-${status.kind}`}
							id="feedbackLiveStatus"
						>
							{status.message}
						</span>
					</div>
					<FeedbackFilterForm
						filters={draftFilters}
						onChange={setDraftFilters}
						onSubmit={handleFilterSubmit}
					/>
				</div>
				<div className="dataContainer" style={{ marginTop: 14 }}>
					<FeedbackTable
						feedback={feedback}
						onSelectTicket={setSelectedTicketId}
						selectedTicketId={selectedTicketId}
					/>
				</div>
			</section>
		</div>
	);
}

function FeedbackFilterForm(props: {
	filters: FeedbackFilters;
	onChange: (filters: FeedbackFilters) => void;
	onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
	const updateFilters = React.useCallback(
		(nextFilters: Partial<FeedbackFilters>) => {
			props.onChange(
				normalizeFeedbackFilters({
					...props.filters,
					...nextFilters,
				}),
			);
		},
		[props.filters, props.onChange],
	);

	return (
		<form
			action="/feedback"
			className="dashboard-actions"
			data-feedback-client-filters="local"
			data-feedback-filter-form="true"
			method="GET"
			onSubmit={props.onSubmit}
		>
			<select
				aria-label="Status filter"
				name="status"
				onChange={(event) =>
					updateFilters({ status: event.currentTarget.value || null })
				}
				value={props.filters.status || ""}
			>
				<option value="">Any status</option>
				{FEEDBACK_STATUSES.map((status) => (
					<option key={status} value={status}>
						{status}
					</option>
				))}
			</select>
			<label className="scope-pill">
				<input
					checked={props.filters.mentionedMe}
					name="mentionedMe"
					onChange={(event) =>
						updateFilters({ mentionedMe: event.currentTarget.checked })
					}
					type="checkbox"
					value="true"
				/>{" "}
				Mentioned me
			</label>
			<label className="scope-pill">
				<input
					checked={props.filters.watched}
					name="watched"
					onChange={(event) =>
						updateFilters({ watched: event.currentTarget.checked })
					}
					type="checkbox"
					value="true"
				/>{" "}
				Watched
			</label>
			<label className="scope-pill">
				<input
					checked={props.filters.submittedByMe}
					name="submittedByMe"
					onChange={(event) =>
						updateFilters({ submittedByMe: event.currentTarget.checked })
					}
					type="checkbox"
					value="true"
				/>{" "}
				Mine
			</label>
			<button className="btn btn-secondary btn-sm" type="submit">
				Filter
			</button>
		</form>
	);
}

function FeedbackTable(props: {
	feedback: ReviewFeedbackRecord[];
	onSelectTicket: (ticketId: string | null) => void;
	selectedTicketId: string | null;
}) {
	const columns = React.useMemo<ColumnDef<ReviewFeedbackRecord>[]>(
		() => [
			{
				header: "ID",
				cell: ({ row }) => {
					const item = row.original;
					const ticketLabel = item.ticket_label || `PF-${item.ticket_number}`;
					return (
						<a
							className="table-link"
							href={`/shiplets/${encodeURIComponent(item.project_id)}?feedback=${encodeURIComponent(item.id)}`}
							onFocus={() => props.onSelectTicket(item.id)}
							onMouseEnter={() => props.onSelectTicket(item.id)}
						>
							{ticketLabel}
						</a>
					);
				},
			},
			{
				header: "Shiplet",
				cell: ({ row }) =>
					row.original.project_name || row.original.project_id || "Shiplet",
			},
			{
				header: "Status",
				accessorKey: "status",
			},
			{
				header: "Comment",
				accessorKey: "comment",
			},
			{
				header: "Mentions",
				cell: ({ row }) => {
					const mentions = row.original.mentions || [];
					if (!mentions.length) return "-";
					return (
						<>
							{mentions.map((mention) => {
								const label =
									mention.mentioned_name || mention.mentioned_email || "Reviewer";
								const title =
									mention.access_status === "invited"
										? "Invited but has not joined this shiplet yet"
										: mention.access_status === "invite_failed"
											? "Invite failed"
											: "Active on this shiplet";
								return (
									<span
										className="success-card-label"
										key={`${mention.mentioned_email}-${mention.access_status}`}
										title={title}
									>
										{label}
									</span>
								);
							})}
						</>
					);
				},
			},
			{
				header: "Submitted by",
				cell: ({ row }) => row.original.submitted_by_email || "Reviewer",
			},
			{
				header: "Created",
				cell: ({ row }) => formatDateLabel(row.original.created_on),
			},
		],
		[props.onSelectTicket],
	);

	const table = useReactTable({
		columns,
		data: props.feedback,
		getCoreRowModel: getCoreRowModel(),
		getRowId: (row) => row.id,
	});

	return (
		<table className="dataTable">
			<thead>
				{table.getHeaderGroups().map((headerGroup) => (
					<tr key={headerGroup.id}>
						{headerGroup.headers.map((header) => (
							<th key={header.id}>
								{header.isPlaceholder
									? null
									: flexRender(
											header.column.columnDef.header,
											header.getContext(),
										)}
							</th>
						))}
					</tr>
				))}
			</thead>
			<tbody id="feedbackRows" data-live-feedback-table="true">
				{table.getRowModel().rows.length ? (
					table.getRowModel().rows.map((row) => (
						<tr
							data-feedback-row={row.original.id}
							data-selected-ticket={
								props.selectedTicketId === row.original.id ? "true" : undefined
							}
							key={row.id}
						>
							{row.getVisibleCells().map((cell) => (
								<td key={cell.id}>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</td>
							))}
						</tr>
					))
				) : (
					<tr>
						<td colSpan={columns.length}>No feedback matched these filters.</td>
					</tr>
				)}
			</tbody>
		</table>
	);
}

export function feedbackQueryKey(filters: FeedbackFilters) {
	const normalizedFilters = normalizeFeedbackFilters(filters);
	return [
		"feedback",
		{
			projectId: normalizedFilters.projectId || "",
			status: normalizedFilters.status || "",
			mentionedMe: normalizedFilters.mentionedMe,
			watched: normalizedFilters.watched,
			submittedByMe: normalizedFilters.submittedByMe,
		},
	] as const;
}

export function feedbackFiltersFromSearch(search: string) {
	const params = new URLSearchParams(search);
	return normalizeFeedbackFilters({
		projectId: params.get("projectId"),
		status: params.get("status"),
		mentionedMe: params.get("mentionedMe") === "true",
		watched: params.get("watched") === "true",
		submittedByMe: params.get("submittedByMe") === "true",
	});
}

function fetchFeedback(endpoint: string, filters: FeedbackFilters) {
	return fetch(`${endpoint}${feedbackApiSearch(filters)}`, {
		credentials: "same-origin",
	}).then(async (response) => {
		if (!response.ok) {
			throw new Error(`Failed to load feedback: ${response.status}`);
		}
		return (await response.json()) as FeedbackQueryResult;
	});
}

function feedbackApiSearch(filters: FeedbackFilters) {
	const params = feedbackSearchParams(filters);
	params.set("limit", "100");
	const search = params.toString();
	return search ? `?${search}` : "";
}

function feedbackPageSearch(filters: FeedbackFilters) {
	const search = feedbackSearchParams(filters).toString();
	return search ? `?${search}` : "";
}

function feedbackSearchParams(filters: FeedbackFilters) {
	const normalizedFilters = normalizeFeedbackFilters(filters);
	const params = new URLSearchParams();
	if (normalizedFilters.projectId) {
		params.set("projectId", normalizedFilters.projectId);
	}
	if (normalizedFilters.status) params.set("status", normalizedFilters.status);
	if (normalizedFilters.mentionedMe) params.set("mentionedMe", "true");
	if (normalizedFilters.watched) params.set("watched", "true");
	if (normalizedFilters.submittedByMe) params.set("submittedByMe", "true");
	return params;
}

function hasActiveFeedbackFilters(filters: FeedbackFilters) {
	const normalizedFilters = normalizeFeedbackFilters(filters);
	return Boolean(
		normalizedFilters.projectId ||
			normalizedFilters.status ||
			normalizedFilters.mentionedMe ||
			normalizedFilters.watched ||
			normalizedFilters.submittedByMe,
	);
}

function feedbackFiltersEqual(left: FeedbackFilters, right: FeedbackFilters) {
	const normalizedLeft = normalizeFeedbackFilters(left);
	const normalizedRight = normalizeFeedbackFilters(right);
	return (
		normalizedLeft.projectId === normalizedRight.projectId &&
		normalizedLeft.status === normalizedRight.status &&
		normalizedLeft.mentionedMe === normalizedRight.mentionedMe &&
		normalizedLeft.watched === normalizedRight.watched &&
		normalizedLeft.submittedByMe === normalizedRight.submittedByMe
	);
}

function replaceFeedbackUrl(filters: FeedbackFilters) {
	if (typeof window === "undefined") return;
	const nextSearch = feedbackPageSearch(filters);
	const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
	if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
		window.history.pushState(null, "", nextUrl);
	}
}

function syncSerializedFeedbackState(nextState: {
	feedback: ReviewFeedbackRecord[];
	feedbackEndpoint: string;
	filters: FeedbackFilters;
	queryKey: ReturnType<typeof feedbackQueryKey>;
}) {
	if (typeof document === "undefined") return;
	const node = document.getElementById("shiplet-platform-feedback-state");
	if (!node) return;
	let currentState: Record<string, unknown> = {};
	try {
		currentState = JSON.parse(node.textContent || "{}") as Record<string, unknown>;
	} catch {
		currentState = {};
	}
	node.textContent = JSON.stringify({
		...currentState,
		feedback: nextState.feedback,
		feedbackEndpoint: nextState.feedbackEndpoint,
		filters: nextState.filters,
		queryKey: nextState.queryKey,
	});
}

function useFeedbackStore<T>(selector: (state: FeedbackState) => T) {
	const store = React.useContext(FeedbackStoreContext);
	if (!store) {
		throw new Error("Feedback store is not available.");
	}
	return useStore(store, selector);
}

function createFeedbackQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				refetchInterval: FEEDBACK_REFETCH_MS,
				refetchOnWindowFocus: true,
				staleTime: FEEDBACK_STALE_MS,
			},
		},
	});
}

function formatTimeLabel(timestamp: number) {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});
}

function formatDateLabel(value: string | null | undefined) {
	if (!value) return "Recently";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Recently";
	return date.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	});
}
