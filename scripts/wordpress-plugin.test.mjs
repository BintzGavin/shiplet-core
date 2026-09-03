import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const pluginRoot = new URL("../wordpress/shiplet/", import.meta.url);
const loaderSource = await readFile(
	new URL("assets/shiplet-loader.js", pluginRoot),
	"utf8",
);
const pluginSource = await readFile(new URL("shiplet.php", pluginRoot), "utf8");

function executeLoader({
	href = "https://client.example/pricing/",
	storedReviewMode = null,
	config = {
		installationId: "embed_installation_test",
		appUrl: "https://shiplet.cc",
	},
} = {}) {
	const storage = new Map();
	if (storedReviewMode !== null) {
		storage.set("shiplet-review-mode:embed_installation_test", storedReviewMode);
	}
	const appendedScripts = [];
	const context = {
		URL,
		window: {
			location: { href },
			ShipletWordPress: config,
			sessionStorage: {
				getItem(key) {
					return storage.get(key) ?? null;
				},
				setItem(key, value) {
					storage.set(key, String(value));
				},
			},
		},
		document: {
			head: {
				appendChild(node) {
					appendedScripts.push(node);
				},
			},
			createElement(tagName) {
				return {
					tagName,
					dataset: {},
					src: "",
					defer: false,
				};
			},
			querySelector() {
				return null;
			},
		},
	};
	vm.runInNewContext(loaderSource, context);
	return { appendedScripts, storage, window: context.window };
}

test("ordinary visitors do not load Shiplet or activate review mode", () => {
	const result = executeLoader();
	assert.equal(result.appendedScripts.length, 0);
	assert.equal(result.storage.size, 0);
	assert.equal(result.window.__SHIPLET_EMBED__, undefined);
});

test("the explicit review query activates the tab and loads the embed bootstrap", () => {
	const result = executeLoader({
		href: "https://client.example/pricing/?shiplet-review=1",
	});
	assert.equal(
		result.storage.get("shiplet-review-mode:embed_installation_test"),
		"1",
	);
	assert.deepEqual(
		{ ...result.window.__SHIPLET_EMBED__ },
		{
			installationId: "embed_installation_test",
			apiBaseUrl: "https://shiplet.cc",
		},
	);
	assert.equal(result.appendedScripts.length, 1);
	assert.equal(
		result.appendedScripts[0].src,
		"https://shiplet.cc/api/embed/client.js",
	);
});

test("review mode remains active only in the current tab session", () => {
	const result = executeLoader({ storedReviewMode: "1" });
	assert.equal(result.appendedScripts.length, 1);
});

test("frontend configuration contains no installation or organization secret", () => {
	assert.match(pluginSource, /wp_localize_script\s*\(/);
	assert.match(pluginSource, /installationId/);
	assert.doesNotMatch(pluginSource, /["']secret["']\s*=>/);
	assert.match(pluginSource, /check_admin_referer\s*\(/);
	assert.match(pluginSource, /current_user_can\s*\(\s*["']manage_options["']\s*\)/);
	assert.match(pluginSource, /hash_equals\s*\(/);
	assert.match(pluginSource, /wp_safe_remote_post\s*\(/);
});
