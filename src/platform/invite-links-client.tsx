/// <reference lib="dom" />

import * as React from "react";
import { hydrateRoot } from "react-dom/client";

import { InviteLinksApp } from "./invite-links-app";
import type { WorkspaceInviteLinksSeed } from "./invite-links-types";

type InviteLinksClientState = {
	route?: string;
	seed?: WorkspaceInviteLinksSeed;
};

const root = document.getElementById("invite-links-platform-root");
const state = readInitialState();

if (root && state.seed && Array.isArray(state.seed.organizations)) {
	hydrateRoot(root, <InviteLinksApp seed={state.seed} />);
}

function readInitialState(): InviteLinksClientState {
	const node = document.getElementById("shiplet-platform-invite-links-state");
	if (!node?.textContent) return {};
	try {
		return JSON.parse(node.textContent) as InviteLinksClientState;
	} catch {
		return {};
	}
}
