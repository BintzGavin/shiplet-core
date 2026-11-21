/// <reference lib="dom" />

import * as React from "react";
import { hydrateRoot } from "react-dom/client";

import {
	FeedbackApp,
	type FeedbackAppProps,
	type FeedbackQueryResult,
	type FeedbackWork,
} from "./feedback-app";
import {
	normalizeFeedbackFilters,
	type FeedbackFilters,
	type FeedbackStoreInitialState,
} from "./feedback-state";

type FeedbackClientState = {
	feedbackEndpoint?: string;
	filters?: FeedbackFilters;
	initialFeedback?: FeedbackQueryResult["feedback"];
	initialUi?: FeedbackStoreInitialState;
	work?: FeedbackWork;
};

const root = document.getElementById("feedback-platform-root");
const state = readInitialState();

if (root && state.initialFeedback && state.filters) {
	const props: FeedbackAppProps = {
		feedbackEndpoint: state.feedbackEndpoint || "/api/feedback",
		initialFeedback: state.initialFeedback,
		initialFilters: normalizeFeedbackFilters(state.filters),
		initialUi: state.initialUi || {},
		work: state.work,
	};
	hydrateRoot(root, <FeedbackApp {...props} />);
}

function readInitialState(): FeedbackClientState {
	const node = document.getElementById("shiplet-platform-feedback-state");
	if (!node?.textContent) return {};
	try {
		return JSON.parse(node.textContent) as FeedbackClientState;
	} catch {
		return {};
	}
}
