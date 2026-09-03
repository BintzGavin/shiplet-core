(function (window, document) {
	"use strict";

	var config = window.ShipletWordPress || null;
	if (!config || !config.installationId || !config.appUrl) {
		return;
	}

	var installationId = String(config.installationId);
	var storageKey = "shiplet-review-mode:" + installationId;
	var currentUrl;
	try {
		currentUrl = new URL(window.location.href);
	} catch (_error) {
		return;
	}

	if (currentUrl.searchParams.get("shiplet-review") === "1") {
		try {
			window.sessionStorage.setItem(storageKey, "1");
		} catch (_error) {
			// The explicit query still activates this page when storage is blocked.
		}
	}

	var active = currentUrl.searchParams.get("shiplet-review") === "1";
	try {
		active = active || window.sessionStorage.getItem(storageKey) === "1";
	} catch (_error) {
		// Keep the query-derived activation state.
	}
	if (!active) {
		return;
	}
	if (document.querySelector("script[data-shiplet-embed-client]")) {
		return;
	}

	var appUrl;
	try {
		appUrl = new URL(String(config.appUrl)).origin;
	} catch (_error) {
		return;
	}
	window.__SHIPLET_EMBED__ = {
		installationId: installationId,
		apiBaseUrl: appUrl,
	};

	var script = document.createElement("script");
	script.src = appUrl + "/api/embed/client.js";
	script.defer = true;
	script.dataset.shipletEmbedClient = "";
	document.head.appendChild(script);
})(window, document);
