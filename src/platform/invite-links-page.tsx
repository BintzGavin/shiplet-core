import * as React from "react";
import { renderToString } from "react-dom/server";

import { InviteLinksApp } from "./invite-links-app";
import type { WorkspaceInviteLinksSeed } from "./invite-links-types";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";

export type WorkspaceInviteLinksIslandOptions = {
	nonce: KernelDocumentNonce;
	seed: WorkspaceInviteLinksSeed;
};

export const INVITE_LINKS_CLIENT_ASSET = "/assets/platform/invite-links.js";

/**
 * Server-renders the workspace "Invite links" island from real data, followed
 * by its JSON seed and hydration script. Embed the returned markup where the
 * section should appear on the `/workspace` settings page.
 */
export function BuildWorkspaceInviteLinksIsland(
	options: WorkspaceInviteLinksIslandOptions,
): string {
	const body = renderToString(
		<div id="invite-links-platform-root">
			<InviteLinksApp seed={options.seed} />
		</div>,
	);

	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="shiplet-platform-invite-links-state">${safeJson({
	route: "workspace",
	seed: options.seed,
})}</script>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${INVITE_LINKS_CLIENT_ASSET}"></script>`;
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
