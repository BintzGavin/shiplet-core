import {
	createReadyMessage,
	createRequestMessage,
} from "./messages.js";

(() => {
	"use strict";

	const protocolVersion = "shiplet.review-frame/v1";
	const forbiddenKeyPattern =
		/(authorization|bearer|capability|claim.?url|cookie|credential|oauth|password|session|token)/i;
	const status = document.querySelector("#status");
	const result = document.querySelector("#result");
	let channel = null;
	let scope = null;
	let sequence = 0;

	function containsForbiddenKey(value, seen = new Set()) {
		if (!value || typeof value !== "object" || seen.has(value)) return false;
		seen.add(value);
		return Object.entries(value).some(
			([key, nested]) =>
				forbiddenKeyPattern.test(key) || containsForbiddenKey(nested, seen),
		);
	}

	function storageIsReadable(name) {
		try {
			return window[name].length >= 0;
		} catch {
			return false;
		}
	}

	function hasCookieText() {
		try {
			return document.cookie.length > 0;
		} catch {
			return false;
		}
	}

	function locationHasCredentialParameter() {
		return Array.from(new URL(location.href).searchParams.keys()).some((key) =>
			forbiddenKeyPattern.test(key),
		);
	}

	function renderProbe() {
		const observation = {
			ambientReviewGlobal: Object.prototype.hasOwnProperty.call(
				window,
				"__SHIPLET_REVIEW__",
			),
			cookieTextPresent: hasCookieText(),
			credentialParameterPresent: locationHasCredentialParameter(),
			localStorageReadable: storageIsReadable("localStorage"),
			sessionStorageReadable: storageIsReadable("sessionStorage"),
			bootstrapContainsForbiddenKey: containsForbiddenKey(scope),
		};
		result.textContent = JSON.stringify(observation, null, 2);
		document.body.dataset.probeComplete = "true";
		for (const [key, value] of Object.entries(observation)) {
			document.body.dataset[key] = String(value);
		}
	}

	function request(action, resource, payload) {
		if (!channel || !scope) {
			status.textContent = "No trusted channel is available.";
			return;
		}
		sequence += 1;
		channel.postMessage(
			createRequestMessage(
				scope,
				`hostile_request_${sequence}`,
				sequence,
				action,
				resource,
				payload,
			),
		);
	}

	window.addEventListener("message", (event) => {
		if (
			event.data?.schemaVersion !== protocolVersion ||
			event.data?.type !== "host.bootstrap" ||
			event.ports.length !== 1
		) {
			return;
		}

		scope = event.data;
		channel = event.ports[0];
		channel.start();
		channel.addEventListener("message", (message) => {
			status.textContent = `Broker response: ${String(message.data?.code ?? message.data?.type ?? "unknown")}`;
		});
		const readyMessage = createReadyMessage(scope);
		event.source?.postMessage(readyMessage, "*");
		status.textContent = "Trusted channel received.";
	});

	document.querySelector("#probe")?.addEventListener("click", renderProbe);
	document.querySelector("#forge-human")?.addEventListener("click", () => {
		request("review.feedback.create", `feedback:${scope?.shipletId ?? "unknown"}`, {
			body: "Hostile fixture attempted an unapproved action",
			actor: { kind: "human", id: "organization_owner" },
			approvalId: "invented_by_widget",
		});
	});
	document.querySelector("#guess-sibling")?.addEventListener("click", () => {
		request("state.read", "state:guessed_sibling/private", {
			shipletId: "guessed_sibling",
			revisionId: "guessed_sibling_revision",
			key: "private",
		});
	});
})();
