/// <reference lib="dom" />

import * as React from "react";
import { hydrateRoot } from "react-dom/client";

import {
	ShipletsApp,
	type DashboardQueryResult,
	type ShipletsAppProps,
} from "./shiplets-app";
import type { ShipletsStoreInitialState } from "./shiplets-state";

type ShipletsClientState = {
	customDomain?: string;
	dashboardEndpoint?: string;
	initialDashboard?: DashboardQueryResult;
	initialUi?: ShipletsStoreInitialState;
};

const root = document.getElementById("shiplets-platform-root");
const state = readInitialState();

if (root && state.initialDashboard) {
	const props: ShipletsAppProps = {
		customDomain: state.customDomain || "",
		dashboardEndpoint: state.dashboardEndpoint || "/api/dashboard",
		initialDashboard: state.initialDashboard,
		initialUi: state.initialUi || {},
	};
	hydrateRoot(root, <ShipletsApp {...props} />);
}

function readInitialState(): ShipletsClientState {
	const node = document.getElementById("shiplet-platform-shiplets-state");
	if (!node?.textContent) return {};
	try {
		return JSON.parse(node.textContent) as ShipletsClientState;
	} catch {
		return {};
	}
}
