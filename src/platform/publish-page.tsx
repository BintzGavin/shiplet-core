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
import { PlatformNav } from "./navigation";
import { ExternalUrlMetadataAutofillScript } from "./external-url-metadata-autofill";
import {
	PlatformStartShellStateScript,
	platformStartShellAttributes,
} from "./start-shell-contract";
import { DashboardRuntimeScript } from "../render";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";
import type { OrganizationRecord, ShipletUser } from "../store";
import type { Project } from "../types";

type PublishPageOptions = {
	nonce: KernelDocumentNonce;
	user: ShipletUser;
	customDomain?: string | null;
	organizations?: OrganizationRecord[];
	projects?: Project[];
};

type DashboardQueryResult = {
	organizations: OrganizationRecord[];
	projects: Project[];
};

type PublishSourceMode = "upload" | "external_url" | "hosting";

type PublishUiState = {
	route: "publish";
	sourceMode: PublishSourceMode;
	selectedOrganizationId: string;
};

const DASHBOARD_QUERY_KEY = ["dashboard", { route: "publish" }] as const;

export function BuildPlatformPublishPage(options: PublishPageOptions) {
	const organizations = options.organizations || [];
	const projects = options.projects || [];
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
			},
		},
	});
	queryClient.setQueryData<DashboardQueryResult>(DASHBOARD_QUERY_KEY, {
		organizations,
		projects,
	});

	const uiStore = createStore<PublishUiState>(() => ({
		route: "publish",
		sourceMode: "upload",
		selectedOrganizationId: organizations.length === 1 ? organizations[0].id : "",
	}));

	const body = renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<HydrationBoundary state={dehydrate(queryClient)}>
				<PublishPage
					customDomain={options.customDomain || "shiplet.cc"}
					initialOrganizations={organizations}
					initialProjects={projects}
					sourceMode={uiStore.getState().sourceMode}
					selectedOrganizationId={uiStore.getState().selectedOrganizationId}
				/>
			</HydrationBoundary>
		</QueryClientProvider>,
	);

	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="shiplet-platform-publish-state">${safeJson({
	route: "publish",
	dashboardEndpoint: "/api/dashboard",
	sourceMode: uiStore.getState().sourceMode,
	selectedOrganizationId: uiStore.getState().selectedOrganizationId,
	queryKey: DASHBOARD_QUERY_KEY,
	user: options.user,
})}</script>
${PlatformStartShellStateScript("publish", options.nonce)}
${PlatformLiveUpdatesScript(options.nonce)}
${DashboardRuntimeScript(options.nonce)}
${ExternalUrlMetadataAutofillScript(options.nonce)}`;
}

function PublishPage(props: {
	customDomain: string;
	initialOrganizations: OrganizationRecord[];
	initialProjects: Project[];
	sourceMode: PublishSourceMode;
	selectedOrganizationId: string;
}) {
	const query = useQuery({
		queryKey: DASHBOARD_QUERY_KEY,
		queryFn: async () => {
			const response = await fetch("/api/dashboard");
			if (!response.ok) {
				throw new Error(`Failed to load dashboard: ${response.status}`);
			}
			return (await response.json()) as DashboardQueryResult;
		},
		initialData: {
			organizations: props.initialOrganizations,
			projects: props.initialProjects,
		},
	});
	const organizationCount = query.data.organizations.length;
	const suffix = `.${props.customDomain || "shiplet.cc"}`;

	return (
		<div
			className="dashboard-shell shiplet-dashboard-stage shiplet-publish-page"
			data-platform-app="react-tanstack"
			data-platform-route="publish"
			data-platform-state="zustand"
			data-dashboard-endpoint="/api/dashboard"
			data-live-updates="polling"
			{...platformStartShellAttributes("publish")}
		>
			<header className="app-page-topbar">
				<div className="app-page-title">
					<span className="success-card-label">Shiplet</span>
					<h1>Create a shiplet</h1>
					<p>
						Upload a build or file, or paste a public URL. Add access controls,
						contextual feedback, and agent handoff to the shiplet.
					</p>
				</div>
				<div className="url-tag" aria-hidden="true">
					<span className="url-tag-hole" />
					<code id="urlTagText">your-shiplet</code>
				</div>
			</header>

			<PlatformNav current="publish" />

			<section className="success-card shiplet-panel shiplet-focus-strip publish-primary-panel">
				<form id="projectForm" className="publish-layout voyage">
					<SourceChoiceGrid sourceMode={props.sourceMode} />
					<UploadStep sourceMode={props.sourceMode} />
					<BerthStep
						organizationCount={organizationCount}
						organizations={query.data.organizations}
						selectedOrganizationId={props.selectedOrganizationId}
						subdomainSuffix={suffix}
					/>
					<LaunchStep />
				</form>
				<div id="publishResult" className="result-slot" />
			</section>

			<section className="success-card shiplet-panel">
				<div className="dashboard-section-header">
					<div>
						<span className="success-card-label">Review loop</span>
						<h2>What reviewers get</h2>
						<p>
							Reviewers open the shared work, comment in context, and send
							agent-ready tickets back to your queue.
						</p>
					</div>
				</div>
				<div
					id="dashboardStatus"
					className="banner banner-info"
					style={{ marginTop: 14 }}
				>
					Loading workspace...
				</div>
			</section>
		</div>
	);
}

function SourceChoiceGrid(props: { sourceMode: PublishSourceMode }) {
	return (
		<div className="source-choice-grid" aria-label="Choose shiplet source">
			<SourceChoice
				id="sourceModeUpload"
				title="Upload files"
				copy="Select supported files, including static exports, images, video, audio, PDFs, code, data, and GIS files."
				value="upload"
				activeValue={props.sourceMode}
			/>
			<SourceChoice
				id="sourceModeUrl"
				title="URL"
				copy="Attach a staging page, PR deployment, hosted report, or public URL."
				value="external_url"
				activeValue={props.sourceMode}
			/>
			<SourceChoice
				id="sourceModeHosting"
				title="Agent or CI"
				copy="Use API/MCP from agents, CLIs, CI jobs, and local scripts after build."
				value="hosting"
				activeValue={props.sourceMode}
			/>
		</div>
	);
}

function SourceChoice(props: {
	id: string;
	title: string;
	copy: string;
	value: PublishSourceMode;
	activeValue: PublishSourceMode;
}) {
	const active = props.value === props.activeValue;
	return (
		<label
			className={`source-choice${active ? " is-active" : ""}`}
			htmlFor={props.id}
		>
			<input
				type="radio"
				id={props.id}
				name="sourceMode"
				value={props.value}
				defaultChecked={active}
			/>
			<span className="source-choice-title">{props.title}</span>
			<span className="source-choice-copy">{props.copy}</span>
		</label>
	);
}

function UploadStep(props: { sourceMode: PublishSourceMode }) {
	return (
		<div className="voyage-step" data-step="1">
			<VoyageRail step="01" />
			<div className="voyage-body">
				<h2 className="voyage-title">
					<span className="voyage-num">STEP 01</span> Choose the source
				</h2>
				<p className="voyage-hint">
					Upload a build output, static export, or standalone file, or attach
					a URL.
				</p>
				<div id="sourcePanelUpload" hidden={props.sourceMode !== "upload"}>
					<label
						className="shiplet-upload-dropzone"
						htmlFor="fileInput"
						data-upload-dropzone=""
					>
						<span className="dropzone-glyph" aria-hidden="true">
							<DropzoneGlyph />
						</span>
						<strong>Upload a build or file</strong>
						<span>Drop static folders or standalone files here.</span>
						<input type="file" id="fileInput" multiple required />
					</label>
				</div>
				<div id="sourcePanelUrl" hidden={props.sourceMode !== "external_url"}>
					<div className="form-group">
						<label htmlFor="externalUrl">URL</label>
						<input
							type="url"
							id="externalUrl"
							placeholder="https://my-app-git-feature.vercel.app"
							aria-describedby="externalUrlMetadataStatus"
						/>
						<small
							className="form-help"
							id="externalUrlMetadataStatus"
							aria-live="polite"
						/>
					</div>
				</div>
				<div id="sourcePanelHosting" hidden={props.sourceMode !== "hosting"}>
					<div className="banner banner-info">
						Agent and CI automation use the Shiplet API or MCP today. Use this
						form when you want to create a shiplet by hand.
						<div className="dashboard-actions" style={{ marginTop: 10 }}>
							<a className="btn btn-secondary btn-sm" href="/docs/code-mode-mcp">
								Open MCP quickstart
							</a>
							<a className="btn btn-secondary btn-sm" href="/openapi.json">
								View REST/OpenAPI
							</a>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function BerthStep(props: {
	organizationCount: number;
	organizations: OrganizationRecord[];
	selectedOrganizationId: string;
	subdomainSuffix: string;
}) {
	return (
		<div className="voyage-step" data-step="2">
			<VoyageRail step="02" />
			<div className="voyage-body">
				<h2 className="voyage-title">
					<span className="voyage-num">STEP 02</span> Set review access
				</h2>
				<p className="voyage-hint">
					Name the shiplet, choose its address, and decide who can open it.
				</p>
				<div className="publish-fields-grid">
					<div className="form-group">
						<label htmlFor="projectName">Shiplet name</label>
						<input
							type="text"
							id="projectName"
							required
							placeholder="Sprint planning report"
						/>
					</div>
					<div className="form-group">
						<label htmlFor="subdomain">Shiplet address</label>
						<div className="domain-input-group">
							<input
								type="text"
								id="subdomain"
								required
								placeholder="sprint-planning-report"
								pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
								aria-describedby="subdomainSuffix"
							/>
							<span className="domain-input-suffix" id="subdomainSuffix">
								{props.subdomainSuffix}
							</span>
						</div>
					</div>
					<div
						className="form-group"
						id="organizationSelectGroup"
						hidden={props.organizationCount <= 1}
					>
						<label htmlFor="organizationSelect">Workspace</label>
						<select
							id="organizationSelect"
							defaultValue={props.selectedOrganizationId}
						>
							{props.organizations.map((organization) => (
								<option key={organization.id} value={organization.id}>
									{organization.name}
								</option>
							))}
						</select>
					</div>
					<div className="form-group">
						<label htmlFor="visibility">Visibility</label>
						<select id="visibility" defaultValue="organization">
							<option value="organization">Organization</option>
							<option value="private">Private</option>
							<option value="unlisted">Unlisted</option>
							<option value="public">Public</option>
						</select>
					</div>
				</div>
			</div>
		</div>
	);
}

function LaunchStep() {
	return (
		<div className="voyage-step" data-step="3">
			<div className="voyage-rail">
				<span className="voyage-bollard" aria-hidden="true">
					03
				</span>
				<span className="voyage-flag" aria-hidden="true">
					<PennantIcon />
				</span>
			</div>
			<div className="voyage-body">
				<h2 className="voyage-title">
					<span className="voyage-num">STEP 03</span> Open review
				</h2>
				<p className="voyage-hint">
					Your shiplet includes comments, invites, and agent handoff.
				</p>
				<div id="workerCodePublishSlot" />
				<button type="submit" className="btn btn-primary btn-lg btn-launch">
					<span className="btn-pennant" aria-hidden="true">
						<PennantIcon />
					</span>
					Create shiplet
				</button>
			</div>
		</div>
	);
}

function VoyageRail(props: { step: string }) {
	return (
		<div className="voyage-rail">
			<span className="voyage-bollard" aria-hidden="true">
				{props.step}
			</span>
			<span className="voyage-flag" aria-hidden="true">
				<PennantIcon />
			</span>
		</div>
	);
}

function PennantIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			focusable="false"
			shapeRendering="geometricPrecision"
		>
			<path
				d="M7 22V3"
				stroke="currentColor"
				strokeWidth="2.2"
				strokeLinecap="round"
			/>
			<path d="M7 3.5l12 4.5-12 4.5z" fill="currentColor" />
		</svg>
	);
}

function DropzoneGlyph() {
	return (
		<svg
			viewBox="0 0 64 44"
			aria-hidden="true"
			focusable="false"
			shapeRendering="geometricPrecision"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path
				className="draw-path"
				style={{ "--di": 1 } as React.CSSProperties}
				d="M8 30h48l-9 12H17z"
				pathLength={1}
			/>
			<path
				className="draw-path"
				style={{ "--di": 2 } as React.CSSProperties}
				d="M22 22h9v8m4-8h9v8"
				pathLength={1}
			/>
			<path
				className="draw-path"
				style={{ "--di": 3 } as React.CSSProperties}
				d="M32 22V6m2 1l12 4.5L34 16"
				pathLength={1}
			/>
		</svg>
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
