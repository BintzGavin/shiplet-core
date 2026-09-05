/// <reference lib="dom" />

import * as React from "react";
import {
	QueryClient,
	QueryClientProvider,
	useMutation,
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
	createShipletsStore,
	shipletsSelectionSnapshot,
	type ShipletsState,
	type ShipletsStore,
	type ShipletsStoreInitialState,
} from "./shiplets-state";
import { PlatformNav } from "./navigation";
import { usePlatformCounts } from "./platform-counts";
import type { OrganizationRecord } from "../store";
import type { Project } from "../types";

export type DashboardQueryResult = {
	projects: Project[];
	archivedProjects: Project[];
	organizations: OrganizationRecord[];
};

export type ShipletsAppProps = {
	customDomain: string;
	dashboardEndpoint: string;
	initialDashboard: DashboardQueryResult;
	initialUi?: ShipletsStoreInitialState;
};

type StatusState = {
	kind: "success" | "warning" | "error";
	message: string;
};

type ArchiveResponse = {
	archived: Project[];
};

type ProjectResponse = {
	project: Project;
};

export const DASHBOARD_QUERY_KEY = ["dashboard", { route: "shiplets" }] as const;

const ShipletsStoreContext = React.createContext<ShipletsStore | null>(null);

export function ShipletsApp(props: ShipletsAppProps) {
	const [queryClient] = React.useState(() => {
		const client = createShipletsQueryClient();
		client.setQueryData<DashboardQueryResult>(
			DASHBOARD_QUERY_KEY,
			props.initialDashboard,
		);
		return client;
	});
	const storeRef = React.useRef<ShipletsStore | null>(null);

	if (!storeRef.current) {
		storeRef.current = createShipletsStore(props.initialUi || {});
	}

	return (
		<QueryClientProvider client={queryClient}>
			<ShipletsStoreContext.Provider value={storeRef.current}>
				<ShipletsPage
					customDomain={props.customDomain}
					dashboardEndpoint={props.dashboardEndpoint}
					initialDashboard={props.initialDashboard}
				/>
			</ShipletsStoreContext.Provider>
		</QueryClientProvider>
	);
}

function ShipletsPage(props: {
	customDomain: string;
	dashboardEndpoint: string;
	initialDashboard: DashboardQueryResult;
}) {
	const queryClient = useQueryClient();
	const search = useShipletsStore((state) => state.search);
	const selectedOrganizationId = useShipletsStore(
		(state) => state.selectedOrganizationId,
	);
	const setSearch = useShipletsStore((state) => state.setSearch);
	const setSelectedOrganizationId = useShipletsStore(
		(state) => state.setSelectedOrganizationId,
	);
	const selectedProjectIds = useShipletsStore(
		(state) => state.selectedProjectIds,
	);
	const visibleProjectIds = useShipletsStore((state) => state.visibleProjectIds);
	const setVisibleProjectIds = useShipletsStore(
		(state) => state.setVisibleProjectIds,
	);
	const toggleAllVisibleProjectSelections = useShipletsStore(
		(state) => state.toggleAllVisibleProjectSelections,
	);
	const clearSelection = useShipletsStore((state) => state.clearSelection);
	const platformCounts = usePlatformCounts();
	const [status, setStatus] = React.useState<StatusState>({
		kind: "success",
		message: `Loaded ${props.initialDashboard.projects.length} review artifacts from ${props.dashboardEndpoint}.`,
	});

	const query = useQuery({
		queryKey: DASHBOARD_QUERY_KEY,
		queryFn: async () => {
			const response = await fetch(props.dashboardEndpoint);
			if (!response.ok) {
				throw new Error(`Failed to load dashboard: ${response.status}`);
			}
			return (await response.json()) as DashboardQueryResult;
		},
		initialData: props.initialDashboard,
		staleTime: 30_000,
	});
	const selectedProjects = React.useMemo(
		() =>
			filterProjects(query.data.projects, selectedOrganizationId, search),
		[query.data.projects, search, selectedOrganizationId],
	);
	const selectedArchivedProjects = React.useMemo(
		() =>
			filterProjects(
				query.data.archivedProjects || [],
				selectedOrganizationId,
				search,
			),
		[query.data.archivedProjects, search, selectedOrganizationId],
	);
	const visibleProjectIdKey = selectedProjects
		.map((project) => project.id)
		.join("\u001f");
	const selection = shipletsSelectionSnapshot({
		selectedProjectIds,
		visibleProjectIds,
	});

	React.useEffect(() => {
		setVisibleProjectIds(selectedProjects.map((project) => project.id));
	}, [selectedProjects, setVisibleProjectIds, visibleProjectIdKey]);

	React.useEffect(() => {
		if (query.error) {
			setStatus({
				kind: "error",
				message:
					query.error instanceof Error
						? query.error.message
						: "Failed to load dashboard.",
			});
		}
	}, [query.error]);

	const bulkArchiveMutation = useMutation({
		mutationFn: async (projectIds: string[]) => {
			const response = await fetch("/api/projects/archive", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectIds }),
			});
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return (await response.json()) as ArchiveResponse;
		},
		onMutate: () => {
			setStatus({ kind: "warning", message: "Archiving selected shiplets." });
		},
		onSuccess: (body, requestedProjectIds) => {
			applyArchivedProjects(queryClient, body.archived, requestedProjectIds);
			clearSelection();
			setStatus({
				kind: "success",
				message: `${body.archived.length} shiplets archived.`,
			});
			void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
			dispatchDashboardUpdate(body);
		},
		onError: (error) => {
			setStatus({
				kind: "error",
				message:
					error instanceof Error
						? error.message
						: "Failed to archive selected shiplets.",
			});
		},
	});
	const archiveMutation = useMutation({
		mutationFn: async (projectId: string) => {
			const response = await fetch(
				`/api/projects/${encodeURIComponent(projectId)}/archive`,
				{
					method: "POST",
				},
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return (await response.json()) as ProjectResponse;
		},
		onMutate: () => {
			setStatus({ kind: "warning", message: "Archiving shiplet." });
		},
		onSuccess: (body) => {
			applyArchivedProjects(queryClient, [body.project], [body.project.id]);
			clearSelection();
			setStatus({ kind: "success", message: "Shiplet archived." });
			void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
			dispatchDashboardUpdate(body);
		},
		onError: (error) => {
			setStatus({
				kind: "error",
				message:
					error instanceof Error ? error.message : "Failed to archive shiplet.",
			});
		},
	});
	const restoreMutation = useMutation({
		mutationFn: async (projectId: string) => {
			const response = await fetch(
				`/api/projects/${encodeURIComponent(projectId)}/restore`,
				{
					method: "POST",
				},
			);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			return (await response.json()) as ProjectResponse;
		},
		onMutate: () => {
			setStatus({ kind: "warning", message: "Restoring shiplet." });
		},
		onSuccess: (body) => {
			applyRestoredProject(queryClient, body.project);
			setStatus({ kind: "success", message: "Shiplet restored." });
			void queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
			dispatchDashboardUpdate(body);
		},
		onError: (error) => {
			setStatus({
				kind: "error",
				message:
					error instanceof Error ? error.message : "Failed to restore shiplet.",
			});
		},
	});
	const busy =
		bulkArchiveMutation.isPending ||
		archiveMutation.isPending ||
		restoreMutation.isPending;

	return (
		<div
			className="dashboard-shell shiplet-dashboard-stage shiplet-list-page"
			data-platform-app="react-tanstack"
			data-platform-route="shiplets"
			data-platform-state="zustand"
			data-dashboard-endpoint={props.dashboardEndpoint}
			data-live-updates="polling"
		>
			<header className="app-page-topbar">
				<div className="app-page-title">
					<span className="success-card-label">Harbor ledger</span>
					<h1>All shiplets</h1>
					<p>Open live artifacts and review bridges for the active workspace.</p>
				</div>
				<div className="dashboard-actions">
					<a className="btn btn-primary btn-sm" href="/">
						Prepare artifact
					</a>
				</div>
			</header>

			<PlatformNav counts={platformCounts} current="shiplets" />

			<section
				className="success-card shiplet-panel shiplet-list-shell"
				id="shiplets"
			>
				<div className="shiplet-list-head">
					<div>
						<span className="success-card-label">Workspace</span>
						<h2>Shiplets</h2>
						<p>
							Find the live artifact, copy its URL, or jump into the review
							bridge without leaving the workspace.
						</p>
					</div>
				</div>
				<div className="shiplet-list-toolbar">
					<div className="shiplet-list-metric" aria-live="polite">
						<strong id="shipletMetricCount">{selectedProjects.length}</strong>
						<span id="shipletMetricLabel">
							{selectedProjects.length === 1
								? "Review artifact"
								: "Review artifacts"}
						</span>
					</div>
					<div className="shiplet-list-controls">
						<div className="shiplet-list-control" id="organizationSelectGroup">
							<label htmlFor="organizationSelect">Workspace</label>
							<select
								id="organizationSelect"
								name="organization"
								value={selectedOrganizationId}
								onChange={(event) =>
									setSelectedOrganizationId(event.currentTarget.value)
								}
							>
								<option value="">All workspaces</option>
								{query.data.organizations.map((organization) => (
									<option key={organization.id} value={organization.id}>
										{organization.name}
									</option>
								))}
							</select>
						</div>
						<label
							className="shiplet-list-control shiplet-list-search"
							htmlFor="shipletSearch"
						>
							<span>Search</span>
							<input
								id="shipletSearch"
								name="q"
								type="search"
								autoComplete="off"
								placeholder="Name, URL, visibility"
								value={search}
								onChange={(event) => setSearch(event.currentTarget.value)}
							/>
						</label>
					</div>
				</div>
				<div
					id="dashboardStatus"
					className={`banner banner-${status.kind}`}
					role={status.kind === "error" ? "alert" : "status"}
				>
					{status.message}
				</div>
				<div id="shipletListSummary" className="shiplet-list-summary">
					{selectedProjects.length
						? `${selectedProjects.length} artifacts ready for review.`
						: "No review artifacts yet."}
				</div>
				<ShipletsBulkActions
					disabled={selection.bulkArchiveDisabled || busy}
					label={selection.selectedLabel}
					allSelected={selection.allSelected}
					someSelected={selection.someSelected}
					onToggleAll={toggleAllVisibleProjectSelections}
					onArchive={() => {
						if (selection.bulkArchiveDisabled || busy) return;
						bulkArchiveMutation.mutate(selectedProjectIds);
					}}
				/>
				<div id="projectList" className="shiplet-list-grid" aria-live="polite">
					<ShipletsList
						customDomain={props.customDomain}
						organizations={query.data.organizations}
						projects={selectedProjects}
						onArchive={(projectId) => archiveMutation.mutate(projectId)}
					/>
				</div>
				<details
					className="shiplet-archive-section"
					id="archivedShipletsSection"
					hidden={selectedArchivedProjects.length === 0}
				>
					<summary id="archivedShipletsSummary">
						Archived shiplets ({selectedArchivedProjects.length})
					</summary>
					<div id="archivedProjectList">
						<ShipletsList
							archived
							customDomain={props.customDomain}
							organizations={query.data.organizations}
							projects={selectedArchivedProjects}
							onRestore={(projectId) => restoreMutation.mutate(projectId)}
						/>
					</div>
				</details>
			</section>
		</div>
	);
}

function ShipletsBulkActions(props: {
	disabled: boolean;
	label: string;
	allSelected: boolean;
	someSelected: boolean;
	onToggleAll: () => void;
	onArchive: () => void;
}) {
	const selectAllRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		if (selectAllRef.current) {
			selectAllRef.current.indeterminate = props.someSelected;
		}
	}, [props.someSelected]);

	return (
		<div className="shiplet-bulk-actions" aria-live="polite">
			<label className="shiplet-select-all" htmlFor="shipletSelectAll">
				<input
					id="shipletSelectAll"
					ref={selectAllRef}
					type="checkbox"
					checked={props.allSelected}
					onChange={props.onToggleAll}
				/>
				<span>Select all</span>
			</label>
			<button
				className="btn btn-secondary btn-sm"
				type="button"
				data-bulk-archive="true"
				disabled={props.disabled}
				onClick={props.onArchive}
			>
				Archive selected
			</button>
			<span id="shipletBulkSelectionCount">{props.label}</span>
		</div>
	);
}

function ShipletsList(props: {
	archived?: boolean;
	customDomain: string;
	organizations: OrganizationRecord[];
	projects: Project[];
	onArchive?: (projectId: string) => void;
	onRestore?: (projectId: string) => void;
}) {
	const selectedProjectIds = useShipletsStore(
		(state) => state.selectedProjectIds,
	);
	const toggleProjectSelection = useShipletsStore(
		(state) => state.toggleProjectSelection,
	);
	const selectedIds = React.useMemo(
		() => new Set(selectedProjectIds),
		[selectedProjectIds],
	);
	const [copiedProjectId, setCopiedProjectId] = React.useState("");
	const organizationNames = React.useMemo(
		() =>
			new Map(
				props.organizations.map((organization) => [
					organization.id,
					organization.name,
				]),
			),
		[props.organizations],
	);
	const copyUrl = React.useCallback(async (project: Project, publicUrl: string) => {
		try {
			if (navigator.clipboard && window.isSecureContext) {
				await navigator.clipboard.writeText(publicUrl);
			} else {
				fallbackCopy(publicUrl);
			}
			setCopiedProjectId(project.id);
			window.setTimeout(() => setCopiedProjectId(""), 1200);
		} catch {
			fallbackCopy(publicUrl);
			setCopiedProjectId(project.id);
			window.setTimeout(() => setCopiedProjectId(""), 1200);
		}
	}, []);
	const columns = React.useMemo<ColumnDef<Project>[]>(
		() => [
			{
				id: "select",
				cell: ({ row }) => {
					const project = row.original;
					return props.archived ? (
						<span
							className="shiplet-visibility-badge"
							data-visibility="unlisted"
						>
							Archived
						</span>
					) : (
						<input
							type="checkbox"
							className="shiplet-row-checkbox"
							data-shiplet-select={project.id}
							value={project.id}
							aria-label={`Select ${project.name}`}
							checked={selectedIds.has(project.id)}
							onChange={() => toggleProjectSelection(project.id)}
						/>
					);
				},
			},
			{
				id: "main",
				cell: ({ row }) => {
					const project = row.original;
					const publicUrl = publicShipletUrl(project, props.customDomain);
					return (
						<div className="shiplet-list-main">
							<a
								className="shiplet-list-name"
								href={`/shiplets/${encodeURIComponent(project.id)}`}
							>
								{project.name}
							</a>
							<a className="shiplet-list-url" href={publicUrl}>
								{publicUrl}
							</a>
							<div className="shiplet-list-meta">
								<span>
									{project.source_type === "external_url"
										? "External URL"
										: project.source_type === "worker"
											? "Worker Code"
											: "Static artifact"}
								</span>
								<span>
									{props.archived
										? `Archived ${formatDateLabel(project.archived_on)}`
										: formatDateLabel(project.created_on)}
								</span>
							</div>
						</div>
					);
				},
			},
			{
				id: "visibility",
				cell: ({ row }) => {
					const project = row.original;
					const visibility = project.visibility || "organization";
					const organizationName = project.organization_id
						? organizationNames.get(project.organization_id) || "Workspace"
						: "Personal";
					return (
						<div className="shiplet-list-meta">
							<span
								className="shiplet-visibility-badge"
								data-visibility={visibility}
							>
								{visibilityLabel(visibility)}
							</span>
							<span>{organizationName}</span>
						</div>
					);
				},
			},
			{
				id: "actions",
				cell: ({ row }) => {
					const project = row.original;
					const publicUrl = publicShipletUrl(project, props.customDomain);
					const previewUrl = `/shiplets/${encodeURIComponent(project.id)}/preview`;
					const copied = copiedProjectId === project.id;
					return (
						<div className="shiplet-list-actions">
							<a className="btn btn-secondary btn-sm" href={publicUrl}>
								View live
							</a>
							<a className="btn btn-secondary btn-sm" href={previewUrl}>
								Review
							</a>
							<button
								className={`btn btn-secondary btn-sm${copied ? " is-copied" : ""}`}
								type="button"
								data-copy-value={publicUrl}
								onClick={() => void copyUrl(project, publicUrl)}
							>
								{copied ? "Copied" : "Copy URL"}
							</button>
							{props.archived ? (
								<button
									className="btn btn-primary btn-sm"
									type="button"
									data-restore-shiplet={project.id}
									onClick={() => props.onRestore?.(project.id)}
								>
									Restore
								</button>
							) : (
								<button
									className="btn btn-secondary btn-sm"
									type="button"
									data-archive-shiplet={project.id}
									onClick={() => props.onArchive?.(project.id)}
								>
									Archive
								</button>
							)}
						</div>
					);
				},
			},
		],
		[
			copiedProjectId,
			copyUrl,
			organizationNames,
			props.archived,
			props.customDomain,
			props.onArchive,
			props.onRestore,
			selectedIds,
			toggleProjectSelection,
		],
	);
	const table = useReactTable({
		data: props.projects,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getRowId: (row) => row.id,
	});

	if (!props.projects.length) {
		return (
			<div className="shiplet-list-empty">
				<span className="success-card-label">
					{props.archived ? "Archive" : "Clean slate"}
				</span>
				<strong>
					{props.archived ? "No archived shiplets" : "No review artifacts yet"}
				</strong>
				<p>
					{props.archived
						? "Archived shiplets will appear here during their restore window."
						: "Prepare an artifact and it will appear here."}
				</p>
				{props.archived ? null : (
					<a className="btn btn-primary btn-sm" href="/">
						Prepare artifact
					</a>
				)}
			</div>
		);
	}

	return (
		<div className="shiplet-list-rows">
			{table.getRowModel().rows.map((row) => (
				<div className="shiplet-list-row" key={row.id}>
					{row.getVisibleCells().map((cell) => (
						<React.Fragment key={cell.id}>
							{flexRender(cell.column.columnDef.cell, cell.getContext())}
						</React.Fragment>
					))}
				</div>
			))}
		</div>
	);
}

function useShipletsStore<T>(selector: (state: ShipletsState) => T) {
	const store = React.useContext(ShipletsStoreContext);
	if (!store) {
		throw new Error("Shiplets store is not available.");
	}
	return useStore(store, selector);
}

function createShipletsQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
			},
		},
	});
}

function applyArchivedProjects(
	queryClient: QueryClient,
	archivedProjects: Project[],
	requestedProjectIds: string[],
) {
	queryClient.setQueryData<DashboardQueryResult>(
		DASHBOARD_QUERY_KEY,
		(current) => {
			if (!current) return current;
			const archivedIds = new Set([
				...requestedProjectIds,
				...archivedProjects.map((project) => project.id),
			]);
			const archivedById = new Map(
				(current.archivedProjects || []).map((project) => [
					project.id,
					project,
				]),
			);
			for (const project of archivedProjects) {
				archivedById.set(project.id, project);
			}
			return {
				...current,
				projects: current.projects.filter(
					(project) => !archivedIds.has(project.id),
				),
				archivedProjects: Array.from(archivedById.values()),
			};
		},
	);
}

function applyRestoredProject(queryClient: QueryClient, project: Project) {
	queryClient.setQueryData<DashboardQueryResult>(
		DASHBOARD_QUERY_KEY,
		(current) => {
			if (!current) return current;
			return {
				...current,
				projects: [
					project,
					...current.projects.filter((candidate) => candidate.id !== project.id),
				],
				archivedProjects: (current.archivedProjects || []).filter(
					(candidate) => candidate.id !== project.id,
				),
			};
		},
	);
}

function filterProjects(
	projects: Project[],
	selectedOrganizationId: string,
	search: string,
) {
	const normalizedSearch = search.trim().toLowerCase();
	return projects.filter((project) => {
		if (
			selectedOrganizationId &&
			project.organization_id !== selectedOrganizationId
		) {
			return false;
		}
		if (!normalizedSearch) return true;
		const haystack = [
			project.name,
			project.subdomain,
			project.custom_hostname || "",
			project.source_type || "",
			project.visibility || "",
		]
			.join(" ")
			.toLowerCase();
		return haystack.includes(normalizedSearch);
	});
}

function publicShipletUrl(project: Project, customDomain: string) {
	if (project.custom_hostname) return `https://${project.custom_hostname}`;
	if (customDomain) return `https://${project.subdomain}.${customDomain}`;
	return `/${project.subdomain}`;
}

function visibilityLabel(visibility: string) {
	switch (visibility) {
		case "public":
			return "Public";
		case "private":
			return "Private";
		case "unlisted":
			return "Unlisted";
		case "organization":
		default:
			return "Workspace";
	}
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

function fallbackCopy(value: string) {
	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	document.body.appendChild(textarea);
	textarea.select();
	try {
		document.execCommand("copy");
	} catch {
		// Best effort only; the action button still keeps the URL visible.
	}
	textarea.remove();
}

function dispatchDashboardUpdate(detail: unknown) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent("shiplet:dashboard-updated", {
			detail,
		}),
	);
}
