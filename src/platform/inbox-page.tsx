import * as React from "react";
import { renderToString } from "react-dom/server";

import {
	InboxApp,
	INBOX_QUERY_KEY,
	type InboxAppProps,
} from "./inbox-app";
import { PlatformLiveUpdatesScript } from "./live-updates";
import type { ReviewNotificationRecord } from "../notifications";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";

type InboxPageOptions = {
	nonce: KernelDocumentNonce;
	notifications: ReviewNotificationRecord[];
};

const INBOX_CLIENT_ASSET = "/assets/platform/inbox.js";
const INBOX_NOTIFICATIONS_ENDPOINT = "/api/notifications?limit=100";

export function BuildPlatformInboxPage(options: InboxPageOptions) {
	const clientProps: InboxAppProps = {
		notificationsEndpoint: INBOX_NOTIFICATIONS_ENDPOINT,
		initialNotifications: options.notifications,
		initialUi: {
			selectedNotificationId: null,
		},
	};
	const body = renderToString(
		<div id="inbox-platform-root">
			<InboxApp {...clientProps} />
		</div>,
	);

	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="shiplet-platform-inbox-state">${safeJson({
	route: "inbox",
	notificationsEndpoint: INBOX_NOTIFICATIONS_ENDPOINT,
	initialNotifications: options.notifications,
	initialUi: clientProps.initialUi,
	queryKey: INBOX_QUERY_KEY,
})}</script>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${INBOX_CLIENT_ASSET}"></script>
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
