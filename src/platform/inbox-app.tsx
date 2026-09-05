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
	createInboxStore,
	type InboxState,
	type InboxStore,
	type InboxStoreInitialState,
} from "./inbox-state";
import { PlatformNav } from "./navigation";
import {
	PLATFORM_NOTIFICATIONS_QUERY_KEY,
	usePlatformCounts,
} from "./platform-counts";
import type { ReviewNotificationRecord } from "../notifications";

export type NotificationsQueryResult = {
	notifications: ReviewNotificationRecord[];
};

export type InboxAppProps = {
	notificationsEndpoint: string;
	initialNotifications: ReviewNotificationRecord[];
	initialUi?: InboxStoreInitialState;
};

type StatusState = {
	kind: "success" | "warning" | "error" | "info";
	message: string;
};

export const INBOX_QUERY_KEY = [
	"notifications",
	{ route: "inbox", limit: 100 },
] as const;

const InboxStoreContext = React.createContext<InboxStore | null>(null);

export function InboxApp(props: InboxAppProps) {
	const [queryClient] = React.useState(() => {
		const client = createInboxQueryClient();
		const notificationsData = {
			notifications: props.initialNotifications,
		};
		client.setQueryData<NotificationsQueryResult>(
			INBOX_QUERY_KEY,
			notificationsData,
		);
		client.setQueryData<NotificationsQueryResult>(
			PLATFORM_NOTIFICATIONS_QUERY_KEY,
			notificationsData,
		);
		return client;
	});
	const storeRef = React.useRef<InboxStore | null>(null);

	if (!storeRef.current) {
		storeRef.current = createInboxStore(props.initialUi || {});
	}

	return (
		<QueryClientProvider client={queryClient}>
			<InboxStoreContext.Provider value={storeRef.current}>
				<InboxPage
					initialNotifications={props.initialNotifications}
					notificationsEndpoint={props.notificationsEndpoint}
				/>
			</InboxStoreContext.Provider>
		</QueryClientProvider>
	);
}

function InboxPage(props: {
	initialNotifications: ReviewNotificationRecord[];
	notificationsEndpoint: string;
}) {
	const queryClient = useQueryClient();
	const selectedNotificationId = useInboxStore(
		(state) => state.selectedNotificationId,
	);
	const setSelectedNotificationId = useInboxStore(
		(state) => state.setSelectedNotificationId,
	);
	const [status, setStatus] = React.useState<StatusState>({
		kind: "info",
		message: "Live updates on",
	});
	const platformCounts = usePlatformCounts({
		initialNotifications: props.initialNotifications,
	});
	const query = useQuery({
		queryKey: INBOX_QUERY_KEY,
		queryFn: () => fetchNotifications(props.notificationsEndpoint),
		initialData: { notifications: props.initialNotifications },
		refetchInterval: 15_000,
		refetchOnWindowFocus: true,
		staleTime: 10_000,
	});
	React.useEffect(() => {
		queryClient.setQueryData<NotificationsQueryResult>(
			PLATFORM_NOTIFICATIONS_QUERY_KEY,
			query.data,
		);
	}, [query.data, queryClient]);

	React.useEffect(() => {
		if (query.error) {
			setStatus({
				kind: "error",
				message:
					query.error instanceof Error
						? query.error.message
						: "Failed to load notifications.",
			});
		} else if (query.dataUpdatedAt > 0) {
			setStatus({
				kind: "success",
				message: `Live. Updated ${formatTimeLabel(query.dataUpdatedAt)}.`,
			});
		}
	}, [query.dataUpdatedAt, query.error]);

	React.useEffect(() => {
		function onPlatformNotificationsUpdated(event: Event) {
			const detail = (event as CustomEvent).detail as
				| { notifications?: ReviewNotificationRecord[] }
				| undefined;
			if (!Array.isArray(detail?.notifications)) return;
			const nextData = { notifications: detail.notifications };
			queryClient.setQueryData<NotificationsQueryResult>(
				INBOX_QUERY_KEY,
				nextData,
			);
			queryClient.setQueryData<NotificationsQueryResult>(
				PLATFORM_NOTIFICATIONS_QUERY_KEY,
				nextData,
			);
			setStatus({
				kind: "success",
				message: `Live. Updated ${formatTimeLabel(Date.now())}.`,
			});
		}
		window.addEventListener(
			"shiplet:platform-notifications-updated",
			onPlatformNotificationsUpdated,
		);
		return () => {
			window.removeEventListener(
				"shiplet:platform-notifications-updated",
				onPlatformNotificationsUpdated,
			);
		};
	}, [queryClient]);

	return (
		<div
			className="dashboard-shell shiplet-dashboard-stage"
			data-platform-app="react-tanstack"
			data-platform-route="inbox"
			data-platform-state="zustand"
			data-selected-notification-id={selectedNotificationId || ""}
			data-notifications-endpoint={props.notificationsEndpoint}
			data-live-updates="polling"
		>
			<header className="app-page-topbar">
				<div className="app-page-title">
					<span className="success-card-label">Inbox</span>
					<h1>Notifications</h1>
					<p>
						Mentions, watched shiplet updates, replies, and status changes for
						shiplets you can access.
					</p>
				</div>
			</header>
			<PlatformNav counts={platformCounts} current="inbox" />
			<section className="success-card shiplet-panel">
				<div className="dashboard-section-header">
					<div>
						<span className="success-card-label">Latest</span>
						<h2>Notification inbox</h2>
					</div>
					<span
						className={`live-status live-status-${status.kind}`}
						id="inboxLiveStatus"
					>
						{status.message}
					</span>
				</div>
				<div className="dataContainer" style={{ marginTop: 14 }}>
					<InboxTable
						notifications={query.data.notifications}
						onSelectNotification={setSelectedNotificationId}
						selectedNotificationId={selectedNotificationId}
					/>
				</div>
			</section>
		</div>
	);
}

function InboxTable(props: {
	notifications: ReviewNotificationRecord[];
	onSelectNotification: (notificationId: string | null) => void;
	selectedNotificationId: string | null;
}) {
	const columns = React.useMemo<ColumnDef<ReviewNotificationRecord>[]>(
		() => [
			{
				header: "Status",
				cell: ({ row }) => {
					const notification = row.original;
					const readLabel = notification.read_on ? "Read" : "Unread";
					return (
						<span
							className="shiplet-visibility-badge"
							data-visibility={
								notification.read_on ? "organization" : "private"
							}
						>
							{readLabel}
						</span>
					);
				},
			},
			{
				header: "Event",
				cell: ({ row }) => {
					const notification = row.original;
					return (
						<a
							className="table-link"
							href={notificationHref(notification)}
							onFocus={() => props.onSelectNotification(notification.id)}
							onMouseEnter={() => props.onSelectNotification(notification.id)}
						>
							{notification.message}
						</a>
					);
				},
			},
			{
				header: "Shiplet",
				cell: ({ row }) => row.original.project_name || "Shiplet",
			},
			{
				header: "Reason",
				cell: ({ row }) => row.original.reason.replace(/_/g, " "),
			},
			{
				header: "Received",
				cell: ({ row }) => formatDateLabel(row.original.created_on),
			},
		],
		[props.onSelectNotification],
	);

	const table = useReactTable({
		data: props.notifications,
		columns,
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
			<tbody id="notificationRows" data-live-notification-table="true">
				{table.getRowModel().rows.length ? (
					table.getRowModel().rows.map((row) => (
						<tr
							key={row.id}
							data-notification-row={row.original.id}
							data-selected={
								props.selectedNotificationId === row.original.id
									? "true"
									: undefined
							}
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
						<td colSpan={columns.length}>No notifications yet.</td>
					</tr>
				)}
			</tbody>
		</table>
	);
}

function useInboxStore<T>(selector: (state: InboxState) => T) {
	const store = React.useContext(InboxStoreContext);
	if (!store) {
		throw new Error("Inbox store is not available.");
	}
	return useStore(store, selector);
}

function createInboxQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 10_000,
			},
		},
	});
}

async function fetchNotifications(notificationsEndpoint: string) {
	const response = await fetch(notificationsEndpoint);
	if (!response.ok) {
		throw new Error(`Failed to load notifications: ${response.status}`);
	}
	return (await response.json()) as NotificationsQueryResult;
}

function notificationHref(notification: ReviewNotificationRecord) {
	const feedbackQuery = notification.feedback_id
		? `?feedback=${encodeURIComponent(notification.feedback_id)}`
		: "";
	return `/shiplets/${encodeURIComponent(notification.project_id)}${feedbackQuery}`;
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

function formatTimeLabel(value: number) {
	return new Date(value).toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	});
}
