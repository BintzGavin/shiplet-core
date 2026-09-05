import * as React from "react";
import { renderToString } from "react-dom/server";

import {
	DASHBOARD_QUERY_KEY,
	ShipletsApp,
	type DashboardQueryResult,
} from "./shiplets-app";
import { PlatformLiveUpdatesScript } from "./live-updates";
import type { OrganizationRecord } from "../store";
import type { Project } from "../types";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";

type ShipletsPageOptions = {
	nonce: KernelDocumentNonce;
	projects: Project[];
	archivedProjects?: Project[];
	organizations: OrganizationRecord[];
	customDomain?: string | null;
};

const SHIPLETS_DASHBOARD_ENDPOINT = "/api/dashboard";
const SHIPLETS_CLIENT_ASSET = "/assets/platform/shiplets.js";

export function BuildPlatformShipletsListPage(options: ShipletsPageOptions) {
	const initialDashboard: DashboardQueryResult = {
		projects: options.projects,
		archivedProjects: options.archivedProjects || [],
		organizations: options.organizations,
	};
	const initialUi = {
		search: "",
		selectedOrganizationId: "",
	};
	const body = renderToString(
		<div id="shiplets-platform-root">
			<ShipletsApp
				customDomain={options.customDomain || ""}
				dashboardEndpoint={SHIPLETS_DASHBOARD_ENDPOINT}
				initialDashboard={initialDashboard}
				initialUi={initialUi}
			/>
		</div>,
	);

	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="shiplet-platform-shiplets-state">${safeJson({
	route: "shiplets",
	customDomain: options.customDomain || "",
	dashboardEndpoint: SHIPLETS_DASHBOARD_ENDPOINT,
	initialDashboard,
	initialUi,
	queryKey: DASHBOARD_QUERY_KEY,
})}</script>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${SHIPLETS_CLIENT_ASSET}"></script>
${PlatformLiveUpdatesScript(options.nonce)}`;
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
