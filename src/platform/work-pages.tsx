// Server shells for the loop screens (Home, Traces, Handshakes). The data is
// rendered into the page and handed to work-client.tsx, which hydrates the
// same component with the same props.
import * as React from "react";
import { renderToString } from "react-dom/server";

import { PlatformLiveUpdatesScript } from "./live-updates";
import { WorkApp, type WorkScreen } from "./work-apps";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";

export const WORK_CLIENT_ASSET = "/assets/platform/work.js";
export const WORK_STATE_ID = "shiplet-platform-work-state";

export function BuildWorkPage(options: { nonce: KernelDocumentNonce; screen: WorkScreen }) {
	const body = renderToString(
		<div id="work-platform-root">
			<WorkApp {...options.screen} />
		</div>,
	);
	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="${WORK_STATE_ID}">${safeJson(options.screen)}</script>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${WORK_CLIENT_ASSET}"></script>
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
