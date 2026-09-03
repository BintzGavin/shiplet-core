import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	QueryClient,
	QueryClientProvider,
	HydrationBoundary,
	dehydrate,
	useQuery,
} from "@tanstack/react-query";
import { createStore } from "zustand/vanilla";

import { PlatformLiveUpdatesScript } from "./live-updates";
import { PlatformNav, type PlatformRoute } from "./navigation";
import {
	PlatformStartShellStateScript,
	platformStartShellAttributes,
} from "./start-shell-contract";
import { DashboardRuntimeScript } from "../render";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";
import {
	AVATAR_SPRITE_COLUMNS,
	AVATAR_SPRITE_ROWS,
	AVATAR_SPRITE_URL,
} from "../avatars";
import type { ShipletUser } from "../store";

export type SettingsRoute = "workspace" | "account" | "access" | "agents";

type SettingsPageOptions = {
	nonce: KernelDocumentNonce;
	user: ShipletUser;
	route?: SettingsRoute;
};

type SettingsQueryResult = {
	user: ShipletUser;
};

type SettingsUiState = {
	route: SettingsRoute;
};

const REMOTE_MCP_ENDPOINT = "https://shiplet.cc/api/mcp";

export function BuildPlatformSettingsPage(options: SettingsPageOptions) {
	const route = options.route || "workspace";
	const queryKey = ["settings", { route }] as const;
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
			},
		},
	});
	queryClient.setQueryData<SettingsQueryResult>(queryKey, {
		user: options.user,
	});

	const uiStore = createStore<SettingsUiState>(() => ({
		route,
	}));

	const body = renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<HydrationBoundary state={dehydrate(queryClient)}>
				<SettingsPage
					initialUser={options.user}
					queryKey={queryKey}
					route={uiStore.getState().route}
				/>
			</HydrationBoundary>
		</QueryClientProvider>,
	);

	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="shiplet-platform-settings-state">${safeJson({
	route,
	queryKey,
	user: options.user,
})}</script>
${PlatformStartShellStateScript(route, options.nonce)}
${PlatformLiveUpdatesScript(options.nonce)}
${DashboardRuntimeScript(options.nonce)}`;
}

function SettingsPage(props: {
	initialUser: ShipletUser;
	queryKey: readonly unknown[];
	route: SettingsRoute;
}) {
	const query = useQuery({
		queryKey: props.queryKey,
		queryFn: async () => {
			const response = await fetch("/api/me");
			if (!response.ok) {
				throw new Error(`Failed to load account: ${response.status}`);
			}
			return (await response.json()) as SettingsQueryResult;
		},
		initialData: { user: props.initialUser },
	});
	const page = settingsPageCopy(props.route);

	return (
		<div
			className="dashboard-shell shiplet-dashboard-stage"
			data-platform-app="react-tanstack"
			data-platform-route={props.route}
			data-platform-state="zustand"
			data-live-updates="polling"
			{...platformStartShellAttributes(props.route)}
		>
			<header className="app-page-topbar">
				<div className="app-page-title">
					<span className="success-card-label">{page.eyebrow}</span>
					<h1>{page.title}</h1>
					<p>{page.copy}</p>
				</div>
			</header>

			<PlatformNav current={props.route as PlatformRoute} />

			<div className="settings-layout">
				<SettingsNav current={props.route} />
				<div className="settings-stack">
					{props.route === "account" ? (
						<>
							<ProfileSection user={query.data.user} />
							<AccountSection user={query.data.user} />
						</>
					) : null}
					{props.route === "workspace" ? (
						<>
							<WorkspaceSection />
							<TeamsSection />
						</>
					) : null}
					{props.route === "access" ? <SharingSection /> : null}
					{props.route === "agents" ? <AgentsSection /> : null}
				</div>
			</div>
		</div>
	);
}

function settingsPageCopy(route: SettingsRoute) {
	if (route === "account") {
		return {
			eyebrow: "Account",
			title: "Profile and sign-in",
			copy: "Manage the identity reviewers see and the accounts available in this browser.",
		};
	}
	if (route === "access") {
		return {
			eyebrow: "Access",
			title: "Shiplet access",
			copy: "Choose who can open review artifacts, review feedback, and collaborate on each shiplet.",
		};
	}
	if (route === "agents") {
		return {
			eyebrow: "Agents",
			title: "Agent access",
			copy: "Create scoped API keys and copy the Code Mode MCP endpoint for local agents.",
		};
	}
	return {
		eyebrow: "Workspace",
		title: "Workspace",
		copy: "Create organizations, choose the active workspace, and group collaborators into teams.",
	};
}

function SettingsNav(props: { current: SettingsRoute }) {
	const items: Array<{ route: SettingsRoute; href: string; label: string; id?: string }> = [
		{ route: "workspace", href: "/workspace", label: "Overview" },
		{ route: "account", href: "/account", label: "Account", id: "accountNav" },
		{ route: "access", href: "/access", label: "Access" },
		{ route: "agents", href: "/agents", label: "Agents" },
	];
	return (
		<nav className="settings-nav" aria-label="Workflow settings">
			{items.map((item) => (
				<a
					href={item.href}
					id={item.id}
					key={item.route}
					data-current={props.current === item.route ? "true" : undefined}
				>
					{item.label}
				</a>
			))}
		</nav>
	);
}

function ProfileSection(props: { user: ShipletUser }) {
	return (
		<section
			className="success-card shiplet-panel shiplet-focus-strip"
			id="profileSection"
		>
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Signal flag</span>
					<h2>Profile</h2>
					<p>Choose the object avatar reviewers will see on your feedback bubbles.</p>
				</div>
			</div>
			<form id="avatarForm" style={{ marginTop: 12 }}>
				<div className="avatar-profile-summary">
					<div id="profileAvatarPreview">
						<span className="shiplet-avatar shiplet-avatar-xl" role="img" aria-label={props.user.email}>
							<span
								className="shiplet-avatar-sprite"
								style={{
									backgroundImage: `url('${AVATAR_SPRITE_URL}')`,
									backgroundPosition: "0% 0%",
									backgroundSize: `${AVATAR_SPRITE_COLUMNS * 100}% ${AVATAR_SPRITE_ROWS * 100}%`,
								}}
							/>
						</span>
					</div>
					<div className="avatar-profile-copy">
						<strong id="profileEmail">{props.user.email}</strong>
						<span className="form-help">
							Preset objects are fastest. Uploads are private to your Shiplet
							account.
						</span>
					</div>
				</div>
				<div
					className="avatar-picker-grid"
					id="avatarPresetGrid"
					aria-label="Avatar presets"
				/>
				<div className="avatar-upload-grid">
					<div className="form-group avatar-upload-field">
						<label htmlFor="avatarUpload">Upload avatar</label>
						<input
							id="avatarUpload"
							type="file"
							accept="image/png,image/jpeg,image/webp"
						/>
						<span className="form-help">
							PNG, JPEG, or WebP up to 10MB. Crop before saving; Shiplet
							stores an optimized square.
						</span>
					</div>
					<div id="avatarCropPanel" className="avatar-crop-panel" hidden>
						<div className="avatar-crop-stage">
							<canvas
								id="avatarCropCanvas"
								width={512}
								height={512}
								aria-label="Avatar crop preview"
							/>
						</div>
						<div className="form-group avatar-crop-control">
							<label htmlFor="avatarCropZoom">Crop zoom</label>
							<input
								id="avatarCropZoom"
								type="range"
								min="1"
								max="3"
								step="0.01"
								defaultValue="1"
							/>
							<span className="form-help">
								Drag the image to position it. Avatar image can be up to
								10MB.
							</span>
						</div>
					</div>
					<button className="btn btn-primary btn-sm" type="submit">
						Save Avatar
					</button>
				</div>
			</form>
		</section>
	);
}

function AccountSection(props: { user: ShipletUser }) {
	return (
		<section
			className="success-card shiplet-panel shiplet-focus-strip"
			id="account"
		>
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Identity</span>
					<h2>Accounts</h2>
					<p>
						Keep multiple Shiplet emails available in this browser and choose the
						active account explicitly.
					</p>
				</div>
				<div className="dashboard-actions">
					<a
						className="btn btn-secondary btn-sm"
						id="addAccountLink"
						href="/auth/login?account_action=add&return_to=%2Faccount"
					>
						Add account
					</a>
					<a className="btn btn-secondary btn-sm" href="/auth/logout">
						Sign out
					</a>
				</div>
			</div>
			<div id="accountList" className="dataContainer" style={{ marginTop: 14 }}>
				<div className="account-list">
					<div className="account-row">
						<div className="account-row-meta">
							<span className="success-card-label">Current account</span>
							<strong>{props.user.email}</strong>
						</div>
						<div className="account-row-actions">
							<span className="success-card-label">Current</span>
						</div>
					</div>
				</div>
			</div>
			<div className="mcp-endpoint-copy" style={{ marginTop: 14 }}>
				<span className="mcp-endpoint-copy-label" id="shipletUserIdLabel">
					Shiplet user ID
				</span>
				<code
					className="mcp-endpoint-copy-url"
					id="shipletUserId"
					aria-labelledby="shipletUserIdLabel"
					aria-describedby="shipletUserIdHelp"
				>
					{props.user.id}
				</code>
				<button
					className="mcp-copy-button"
					id="copyShipletUserId"
					type="button"
					data-copy-value={props.user.id}
					aria-label="Copy Shiplet user ID"
					aria-describedby="shipletUserIdHelp"
					title="Copy Shiplet user ID"
					style={{ width: "auto", padding: "0 12px" }}
				>
					Copy user ID
				</button>
			</div>
			<p className="form-help" id="shipletUserIdHelp" style={{ marginTop: 8 }}>
				Use this public actor identifier for exact-operator OAuth and temporary-claim
				smoke checks. It is not a credential and grants no access.
			</p>
		</section>
	);
}

function WorkspaceSection() {
	return (
		<section
			className="success-card shiplet-panel shiplet-focus-strip"
			id="workspace"
		>
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Workspace</span>
					<h2>Organizations</h2>
					<p>Create organizations, select the active workspace, and invite collaborators.</p>
				</div>
				<span className="live-status live-status-info">Workspace loads automatically</span>
			</div>
			<div id="dashboardStatus" className="banner banner-info" style={{ marginTop: 14 }}>
				Loading workspace...
			</div>
			<form id="organizationForm" className="form-group" style={{ marginTop: 16 }}>
				<label htmlFor="organizationName">New organization</label>
				<div className="inline-field-row">
					<input
						id="organizationName"
						name="organizationName"
						type="text"
						placeholder="Acme Studio"
					/>
					<button className="btn btn-primary btn-sm" type="submit">
						Create
					</button>
				</div>
			</form>
			<OrganizationSelect />
			<form id="organizationInviteForm" className="settings-form-grid" style={{ marginTop: 16 }}>
				<div className="form-group">
					<label htmlFor="organizationInviteEmail">Invite to organization</label>
					<input
						id="organizationInviteEmail"
						type="email"
						placeholder="teammate@example.com"
					/>
				</div>
				<div className="form-group">
					<label htmlFor="organizationInviteRole">Role</label>
					<select id="organizationInviteRole">
						<option value="member">Member</option>
						<option value="admin" disabled hidden>
							Admin
						</option>
					</select>
				</div>
				<button className="btn btn-secondary btn-sm" type="submit">
					Send Org Invite
				</button>
			</form>
		</section>
	);
}

function OrganizationSelect() {
	return (
		<div className="form-group" id="organizationSelectGroup" style={{ marginTop: 14 }}>
			<label htmlFor="organizationSelect">Active organization</label>
			<select id="organizationSelect" />
		</div>
	);
}

function TeamsSection() {
	return (
		<section className="success-card shiplet-panel" id="teams">
			<span className="success-card-label">Crews</span>
			<h2>Teams</h2>
			<form id="teamForm" className="settings-form-grid" style={{ marginTop: 12 }}>
				<div className="form-group">
					<label htmlFor="teamName">Team name</label>
					<input id="teamName" name="teamName" type="text" placeholder="Design Review" />
				</div>
				<div className="form-group">
					<label htmlFor="teamDescription">Description</label>
					<input
						id="teamDescription"
						name="teamDescription"
						type="text"
						placeholder="Optional description"
					/>
				</div>
				<button className="btn btn-secondary btn-sm" type="submit">
					Create Team
				</button>
			</form>
			<form id="teamInviteForm" className="settings-form-grid" style={{ marginTop: 16 }}>
				<div className="form-group">
					<label htmlFor="teamInviteSelect">Invite to team</label>
					<select id="teamInviteSelect" />
				</div>
				<div className="form-group">
					<label htmlFor="teamInviteEmail">Email</label>
					<input id="teamInviteEmail" type="email" placeholder="teammate@example.com" />
				</div>
				<button className="btn btn-secondary btn-sm" type="submit">
					Send Invite
				</button>
			</form>
			<div id="teamList" className="dataContainer" style={{ marginTop: 16 }} />
		</section>
	);
}

function SharingSection() {
	return (
		<section className="success-card shiplet-panel" id="shiplets">
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Harbor ledger</span>
					<h2>Shiplets and sharing</h2>
					<p>
						Open artifacts, review feedback, and grant access to organizations,
						teams, or individual reviewers.
					</p>
				</div>
				<a className="btn btn-secondary btn-sm" href="/shiplets">
					All shiplets
				</a>
			</div>
			<div id="dashboardStatus" className="banner banner-info" style={{ marginTop: 14 }}>
				Loading workspace...
			</div>
			<OrganizationSelect />
			<div id="projectList" className="dataContainer" style={{ margin: "14px 0 16px" }} />
			<form id="shipletShareForm" className="settings-form-grid">
				<div className="form-group">
					<label htmlFor="shareProjectSelect">Shiplet</label>
					<select id="shareProjectSelect" />
				</div>
				<div className="form-group">
					<label htmlFor="shareTargetType">Share with</label>
					<select id="shareTargetType">
						<option value="user">User</option>
						<option value="team">Team</option>
						<option value="organization">Organization</option>
					</select>
				</div>
				<div className="form-group" id="shareEmailGroup">
					<label htmlFor="shareEmail">Email</label>
					<input id="shareEmail" type="email" placeholder="reviewer@example.com" />
				</div>
				<div className="form-group" id="shareTeamGroup" style={{ display: "none" }}>
					<label htmlFor="shareTeamSelect">Team</label>
					<select id="shareTeamSelect" />
				</div>
				<div className="form-group">
					<label htmlFor="shareRole">Role</label>
					<select id="shareRole">
						<option value="viewer">Viewer</option>
						<option value="reviewer">Reviewer</option>
						<option value="owner">Owner</option>
					</select>
				</div>
				<button className="btn btn-secondary btn-sm" type="submit">
					Share
				</button>
			</form>
			<div id="shareResult" className="result-slot" />
		</section>
	);
}

function AgentsSection() {
	return (
		<section className="success-card shiplet-panel" id="agents">
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Dock crew</span>
					<h2>API Keys and MCP</h2>
					<p>
						One organization key can publish shiplets and read review feedback
						through the Code Mode MCP endpoint.
					</p>
				</div>
			</div>
			<div id="dashboardStatus" className="banner banner-info" style={{ marginTop: 14 }}>
				Loading workspace...
			</div>
			<OrganizationSelect />
			<McpEndpointCopy />
			<div
				id="tokenManagementStatus"
				className="banner banner-info"
				style={{ marginTop: 16 }}
			>
				Checking API-key permissions...
			</div>
			<div id="tokenManagement" hidden>
				<form id="tokenForm" className="settings-form-grid">
					<div className="form-group">
						<label htmlFor="tokenName">Token name</label>
						<input id="tokenName" type="text" placeholder="Local Codex" />
					</div>
					<div className="form-group">
						<label htmlFor="tokenProjectAccessMode">Project access</label>
						<select id="tokenProjectAccessMode" defaultValue="selected">
							<option value="all">All projects</option>
							<option value="all_except">All except selected</option>
							<option value="selected">Only selected</option>
						</select>
					</div>
					<div className="form-group">
						<label htmlFor="tokenRuleProjectSelect">Project rules</label>
						<select id="tokenRuleProjectSelect" multiple size={3} />
					</div>
					<button className="btn btn-secondary btn-sm" type="submit">
						Create Key
					</button>
				</form>
				<div className="scope-grid">
					{["shiplets:read", "shiplets:write", "shiplets:archive", "feedback:read", "feedback:write", "mcp"].map((scope) => (
						<label className="scope-pill" key={scope}>
							<input type="checkbox" name="tokenScope" value={scope} /> {scope}
						</label>
					))}
				</div>
				<div id="tokenResult" className="result-slot" />
				<div id="tokenList" className="dataContainer" style={{ marginTop: 16 }} />
			</div>
		</section>
	);
}

function McpEndpointCopy() {
	return (
		<div className="mcp-endpoint-copy">
			<span className="mcp-endpoint-copy-label">MCP endpoint</span>
			<code className="mcp-endpoint-copy-url">{REMOTE_MCP_ENDPOINT}</code>
			<button
				className="mcp-copy-button"
				type="button"
				data-copy-value={REMOTE_MCP_ENDPOINT}
				aria-label="Copy MCP endpoint"
				title="Copy MCP endpoint"
			>
				Copy MCP endpoint
			</button>
		</div>
	);
}

function safeJson(value: unknown) {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
		switch (character) {
			case "<":
				return "\\u003c";
			case ">":
				return "\\u003e";
			case "&":
				return "\\u0026";
			case "\u2028":
				return "\\u2028";
			case "\u2029":
				return "\\u2029";
			default:
				return character;
		}
	});
}
