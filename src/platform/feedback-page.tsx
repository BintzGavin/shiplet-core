import * as React from "react";
import { renderToString } from "react-dom/server";

import {
	FeedbackApp,
	feedbackQueryKey,
} from "./feedback-app";
import { PlatformLiveUpdatesScript } from "./live-updates";
import { PlatformStartShellStateScript } from "./start-shell-contract";
import {
	normalizeFeedbackFilters,
	type FeedbackFilters,
} from "./feedback-state";
import type { ReviewFeedbackRecord } from "../review";
import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";

type FeedbackPageOptions = {
	nonce: KernelDocumentNonce;
	feedback: ReviewFeedbackRecord[];
	filters: FeedbackFilters;
};

const FEEDBACK_ENDPOINT = "/api/feedback";
const FEEDBACK_CLIENT_ASSET = "/assets/platform/feedback.js";

export function BuildPlatformFeedbackPage(options: FeedbackPageOptions) {
	const filters = normalizeFeedbackFilters(options.filters);
	const initialUi = {
		selectedTicketId: null,
	};
	const body = renderToString(
		<div id="feedback-platform-root">
			<FeedbackApp
				feedbackEndpoint={FEEDBACK_ENDPOINT}
				initialFeedback={options.feedback}
				initialFilters={filters}
				initialUi={initialUi}
			/>
		</div>,
	);

	return `${body}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="application/json" id="shiplet-platform-feedback-state">${safeJson({
	route: "feedback",
	feedbackEndpoint: FEEDBACK_ENDPOINT,
	filters,
	feedback: options.feedback,
	initialFeedback: options.feedback,
	initialUi,
	queryKey: feedbackQueryKey(filters),
})}</script>
${PlatformStartShellStateScript("feedback", options.nonce)}
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${FEEDBACK_CLIENT_ASSET}"></script>
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
