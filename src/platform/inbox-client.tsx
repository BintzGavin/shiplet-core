/// <reference lib="dom" />

import * as React from "react";
import { hydrateRoot } from "react-dom/client";

import {
	InboxApp,
	type InboxAppProps,
	type NotificationsQueryResult,
} from "./inbox-app";
import type { InboxStoreInitialState } from "./inbox-state";

type InboxClientState = {
	notificationsEndpoint?: string;
	initialNotifications?: NotificationsQueryResult["notifications"];
	initialUi?: InboxStoreInitialState;
};

const root = document.getElementById("inbox-platform-root");
const state = readInitialState();

if (root && state.initialNotifications) {
	const props: InboxAppProps = {
		notificationsEndpoint:
			state.notificationsEndpoint || "/api/notifications?limit=100",
		initialNotifications: state.initialNotifications,
		initialUi: state.initialUi || {},
	};
	hydrateRoot(root, <InboxApp {...props} />);
}

function readInitialState(): InboxClientState {
	const node = document.getElementById("shiplet-platform-inbox-state");
	if (!node?.textContent) return {};
	try {
		return JSON.parse(node.textContent) as InboxClientState;
	} catch {
		return {};
	}
}
