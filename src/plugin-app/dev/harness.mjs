#!/usr/bin/env node
// Development-only mock MCP Apps host for the Shiplet plugin app. It is not
// imported by the app bundle. It loads src/generated-plugin-app.ts into a
// sandboxed iframe, answers the MCP Apps JSON-RPC handshake and tool calls
// with fixture data, and takes Playwright screenshots.
//
//   node scripts/build-plugin-app.mjs
//   node src/plugin-app/dev/harness.mjs <output-dir> [chromium-executable]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export async function readPluginAppHtml() {
	const source = await readFile(path.join(root, "src/generated-plugin-app.ts"), "utf8");
	const match = source.match(/export const PLUGIN_APP_HTML = (".*");\n/s);
	if (!match) throw new Error("Could not find PLUGIN_APP_HTML; run scripts/build-plugin-app.mjs.");
	return JSON.parse(match[1]);
}

const NOW = Date.now();
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const shiplets = [
	["shiplet_pricing", "Pricing page refresh", "organization", 4, 12],
	["shiplet_onboarding", "Onboarding checklist", "private", 2, 95],
	["shiplet_docs", "Docs landing", "unlisted", 0, 60 * 26],
	["shiplet_changelog", "Changelog September", "public", null, 60 * 24 * 4],
	["shiplet_emails", "Welcome email series", "organization", 7, 60 * 24 * 9],
	["shiplet_status", "Status page concept", "organization", 1, 60 * 24 * 12],
	["shiplet_invoice", "Invoice template", "private", 0, 60 * 24 * 40],
].map(([id, name, visibility, openFeedbackCount, minutes]) => ({
	id,
	name,
	reviewUrl: `https://review.example.test/s/${id}`,
	visibility,
	archived: false,
	openFeedbackCount,
	updatedAt: ago(minutes),
}));

const feedback = [
	["review_1", "Hero headline wraps under the nav", "New", "Ada Park", "/pricing", 2],
	["review_2", "Annual toggle does not update prices", "In Progress", "Sam Ortiz", "/pricing", 3],
	["review_3", "Compare table overflows on mobile", "Blocked", "Lee Chen", "/pricing/compare", 1],
	["review_4", "FAQ answer links to old docs", "Staging", "Ada Park", "/pricing#faq", 0],
	["review_5", "Footer logo is blurry on retina", "Done", "Priya N.", "/", 1],
	["review_6", "Remove the beta badge", "Dropped", null, "/pricing", 0],
].map(([id, title, status, authorName, pagePath, replyCount], index) => ({
	id,
	shipletId: "shiplet_pricing",
	title,
	status,
	authorName,
	pageUrl: `https://review.example.test/s/shiplet_pricing${pagePath}`,
	replyCount,
	createdAt: ago(30 + index * 70),
	url: `https://review.example.test/s/shiplet_pricing#feedback=${id}`,
}));

const detailExtras = {
	review_2: {
		comment:
			"Switching the plan toggle to Annual keeps the monthly prices on the Team and Business cards. The Starter card updates correctly.\n\nSeen in Safari 18 and Chrome 131.",
		replies: [
			{ id: "r1", authorName: "Sam Ortiz", comment: "Repro steps are in the video attached on the thread.", createdAt: ago(110) },
			{ id: "r2", authorName: "Codex", comment: "Found it: the Team and Business cards read the price before the toggle state updates. Patch is on the preview branch.", createdAt: ago(55) },
			{ id: "r3", authorName: "Ada Park", comment: "Looks right on the preview. Leaving open until it ships.", createdAt: ago(20) },
		],
	},
};

const fileHtml = `<!doctype html><html><head><style>
body{margin:0;font:16px system-ui;background:#fbf8f2;color:#1d2433}
header{padding:28px 32px;background:#1d2433;color:#fff}
h1{margin:0 0 6px;font-size:28px}
main{padding:24px 32px;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.card{background:#fff;border:1px solid #d9d2c3;border-bottom-width:3px;border-radius:10px;padding:16px}
.price{font-size:26px;font-weight:700;color:#c2410c}
</style></head><body><header><h1>Launch pricing</h1><p>Simple plans for small crews.</p></header>
<main><div class="card"><h3>Starter</h3><p class="price">$0</p></div><div class="card"><h3>Team</h3><p class="price">$24</p></div><div class="card"><h3>Business</h3><p class="price">$79</p></div></main></body></html>`;

export const fixtures = { shiplets, feedback, detailExtras, fileHtml };

/** Host page source. `scenario` picks the entrypoint and initial result. */
export function renderHarness(appHtml, { theme, displayMode, scenario }) {
	const config = { theme, displayMode, scenario, fixtures };
	return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">
<style>
html,body{margin:0;background:${theme === "dark" ? "#212121" : "#ffffff"};font:14px system-ui}
#frame-wrap{${displayMode === "inline" ? "max-width:720px;margin:24px auto;border:1px solid " + (theme === "dark" ? "#3a3a3a" : "#e5e5e5") + ";border-radius:24px;overflow:hidden" : "position:fixed;inset:0"}}
iframe{display:block;width:100%;border:0;${displayMode === "inline" ? "height:200px" : "height:100%"}}
</style></head><body><div id="frame-wrap"><iframe id="app" sandbox="allow-scripts"></iframe></div>
<script>
const config = ${JSON.stringify(config)};
const appHtml = ${JSON.stringify(appHtml).replace(/<\/script/gi, "<\\/script")};
const frame = document.getElementById("app");
window.hostLog = [];
const { shiplets, feedback, detailExtras, fileHtml } = config.fixtures;
function send(message) { frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, "*"); }
function notify(method, params) { send({ method, params }); }
function detailOf(id) {
	const summary = feedback.find((item) => item.id === id);
	if (!summary) return null;
	const extra = detailExtras[id] || { comment: "Reviewer comment for " + summary.title + ".", replies: [] };
	return { ...summary, ...extra, replyCount: extra.replies.length || summary.replyCount };
}
const shipletRef = (id) => { const s = shiplets.find((item) => item.id === id); return s && { id: s.id, name: s.name, reviewUrl: s.reviewUrl }; };
function toolResult(structuredContent) { return { content: [{ type: "text", text: "ok" }], structuredContent }; }
function callTool(name, args) {
	if (name === "list_shiplets") return toolResult({ view: "inbox", shiplets });
	if (name === "list_workspaces") {
		if (config.scenario.workspacesError) return { isError: true, content: [{ type: "text", text: "Workspaces are unavailable." }] };
		return toolResult({ view: "workspaces", workspaces: config.scenario.workspaces || [{ id: "org_acme", name: "Acme Studio" }, { id: "org_side", name: "Side projects" }] });
	}
	if (name === "list_feedback") {
		const ref = shipletRef(args.shiplet_id);
		if (!ref) return { isError: true, content: [{ type: "text", text: "Shiplet not found." }] };
		const all = args.shiplet_id === "shiplet_pricing" ? feedback : [];
		const items = args.status ? all.filter((f) => f.status === args.status)
			: args.include_closed ? all : all.filter((f) => f.status !== "Done" && f.status !== "Dropped");
		return toolResult({ view: "feedback", shiplet: ref, feedback: items });
	}
	if (name === "get_feedback") {
		const detail = detailOf(args.feedback_id);
		return detail ? toolResult({ view: "feedback-detail", feedback: detail, shiplet: shipletRef(args.shiplet_id) })
			: { isError: true, content: [{ type: "text", text: "Feedback not found." }] };
	}
	if (name === "update_feedback_status") {
		if (args.status === "Dropped") return { isError: true, content: [{ type: "text", text: "You can't drop feedback you didn't create." }] };
		const item = feedback.find((f) => f.id === args.feedback_id);
		if (item) item.status = args.status;
		return toolResult({ view: "feedback-detail", feedback: detailOf(args.feedback_id) });
	}
	if (name === "reply_to_feedback") {
		const extra = detailExtras[args.feedback_id] || (detailExtras[args.feedback_id] = { comment: "Reviewer comment.", replies: [] });
		extra.replies.push({ id: "r" + Date.now(), authorName: "You", comment: args.comment, createdAt: new Date().toISOString() });
		return toolResult({ view: "feedback-detail", feedback: detailOf(args.feedback_id) });
	}
	if (name === "publish_html_for_review") {
		return toolResult({ view: "published", shiplet: { id: "shiplet_new", name: args.name, reviewUrl: "https://review.example.test/s/shiplet_new", visibility: args.visibility || "organization", archived: false, openFeedbackCount: 0, updatedAt: new Date().toISOString() } });
	}
	return { isError: true, content: [{ type: "text", text: "Unknown tool " + name }] };
}
const hostContext = {
	theme: config.theme,
	displayMode: config.displayMode,
	availableDisplayModes: ["inline", "fullscreen"],
	platform: "desktop",
	styles: { variables: { "--font-sans": "-apple-system, system-ui, 'Segoe UI', sans-serif" } },
	"openai/interactionCursor": "pointer",
};
if (config.scenario.deepLink) hostContext["openai/deepLink"] = { url: config.scenario.deepLink };
window.addEventListener("message", (event) => {
	if (event.source !== frame.contentWindow) return;
	const message = event.data;
	if (!message || message.jsonrpc !== "2.0") return;
	window.hostLog.push(message);
	const reply = (result) => send({ id: message.id, result });
	switch (message.method) {
		case "ui/initialize":
			return reply({
				protocolVersion: message.params.protocolVersion,
				hostInfo: { name: "shiplet-mock-host", version: "0.0.0" },
				hostCapabilities: {
					openLinks: {}, serverTools: {}, logging: {},
					updateModelContext: { text: {} }, message: { text: {} },
					experimental: config.scenario.noFiles
						? { "openai/message": {}, "openai/modelContext": {} }
						: { "openai/message": {}, "openai/modelContext": {}, "openai/resource": {} },
				},
				hostContext,
			});
		case "ui/notifications/initialized":
			if (config.scenario.toolInput) notify("ui/notifications/tool-input", { arguments: config.scenario.toolInput });
			if (config.scenario.initialResult) setTimeout(() => notify("ui/notifications/tool-result", toolResult(config.scenario.initialResult)), config.scenario.resultDelay || 0);
			return;
		case "ui/notifications/size-changed":
			if (config.displayMode === "inline" && message.params.height) frame.style.height = message.params.height + "px";
			return;
		case "tools/call":
			return setTimeout(() => reply(callTool(message.params.name, message.params.arguments || {})), config.scenario.latency || 60);
		case "resources/read":
			return reply({ contents: [{ uri: message.params.uri, mimeType: "text/html", text: fileHtml }] });
		case "ui/request-display-mode":
			return reply({ mode: message.params.mode });
		case "ui/update-model-context":
			return reply({ _meta: { "openai/modelContext": { updateId: "update-" + window.hostLog.length } } });
		case "ui/open-link": case "ui/message":
			return reply({});
		default:
			if (message.id !== undefined) reply({});
	}
});
window.hostNotify = notify;
frame.srcdoc = appHtml;
</script></body></html>`;
}

export const scenarios = {
	inbox: { toolInput: {}, initialResult: { view: "inbox", shiplets } },
	empty: { toolInput: {}, initialResult: { view: "inbox", shiplets: [] } },
	slow: { toolInput: {}, initialResult: { view: "inbox", shiplets }, resultDelay: 60_000 },
	detail: {
		toolInput: {},
		initialResult: { view: "inbox", shiplets },
		deepLink: "/shiplets/shiplet_pricing/feedback/review_2",
	},
	file: {
		toolInput: { file: { name: "launch-pricing_v2.html", resourceUri: "file:///workspace/launch-pricing_v2.html" } },
		initialResult: { view: "html-file", fileName: "launch-pricing_v2.html" },
	},
};

async function screenshots(outDir, executablePath) {
	const { chromium } = await import("@playwright/test");
	await mkdir(outDir, { recursive: true });
	const appHtml = await readPluginAppHtml();
	const browser = await chromium.launch(executablePath ? { executablePath } : {});
	const shots = [];
	const errors = [];
	try {
		const plan = [
			["inbox", "fullscreen", "light", 1100, 760],
			["inbox", "fullscreen", "dark", 1100, 760],
			["inbox", "inline", "light", 900, 640],
			["inbox", "inline", "dark", 900, 640],
			["detail", "fullscreen", "light", 1100, 820],
			["detail", "fullscreen", "dark", 1100, 820],
			["detail", "fullscreen", "light", 360, 900],
			["detail", "fullscreen", "dark", 360, 900],
			["empty", "inline", "light", 900, 420],
			["slow", "inline", "dark", 900, 420],
			["file", "fullscreen", "light", 1100, 760],
			["file", "fullscreen", "dark", 1100, 760],
		];
		for (const [scenario, displayMode, theme, width, height] of plan) {
			const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
			page.on("pageerror", (error) => errors.push(`${scenario}: ${error.message}`));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(`${scenario}: ${message.text()}`);
			});
			const harness = renderHarness(appHtml, { theme, displayMode, scenario: scenarios[scenario] });
			const harnessFile = path.join(outDir, `harness-${scenario}-${displayMode}-${theme}.html`);
			await writeFile(harnessFile, harness);
			await page.goto(`file://${harnessFile}`);
			const app = page.frameLocator("#app");
			if (scenario === "detail") {
				await app.getByRole("heading", { name: "Annual toggle does not update prices" }).waitFor();
			} else if (scenario === "file") {
				await app.getByRole("button", { name: "Publish for review" }).waitFor();
				await page.waitForTimeout(300);
			} else if (scenario === "empty") {
				await app.getByText("No Shiplets yet").waitFor();
			} else if (scenario === "slow") {
				await page.waitForTimeout(400);
			} else {
				await app.getByRole("button", { name: /Pricing page refresh/ }).waitFor();
			}
			await page.waitForTimeout(250);
			const name = `${scenario}-${displayMode}-${theme}-${width}.png`;
			await page.screenshot({ path: path.join(outDir, name), fullPage: true });
			shots.push(name);
			await page.close();
		}
	} finally {
		await browser.close();
	}
	const browserForChecks = await chromium.launch(executablePath ? { executablePath } : {});
	try {
		await interactionChecks(browserForChecks, appHtml, outDir, errors);
		shots.push("status-error-fullscreen-light-1100.png");
	} finally {
		await browserForChecks.close();
	}
	process.stdout.write(`${shots.map((shot) => path.join(outDir, shot)).join("\n")}\n`);
	if (errors.length > 0) {
		process.stderr.write(`Page errors:\n${errors.join("\n")}\n`);
		process.exitCode = 1;
	}
}

function expect(condition, message, errors) {
	if (!condition) errors.push(`check failed: ${message}`);
	else process.stdout.write(`ok - ${message}\n`);
}

async function openScenario(browser, appHtml, outDir, scenario, errors) {
	const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, colorScheme: "light" });
	page.on("pageerror", (error) => errors.push(`${scenario}: ${error.message}`));
	const harnessFile = path.join(outDir, `harness-check-${scenario}.html`);
	await writeFile(harnessFile, renderHarness(appHtml, { theme: "light", displayMode: "fullscreen", scenario: scenarios[scenario] }));
	await page.goto(`file://${harnessFile}`);
	return { page, app: page.frameLocator("#app") };
}

const hostLog = (page) => page.evaluate(() => window.hostLog);

async function interactionChecks(browser, appHtml, outDir, errors) {
	{
		const { page, app } = await openScenario(browser, appHtml, outDir, "detail", errors);
		await app.getByRole("heading", { name: "Annual toggle does not update prices" }).waitFor();
		await app.getByText("Shared with ChatGPT as context").waitFor();
		let log = await hostLog(page);
		const firstInit = log.findIndex((m) => m.method === "ui/initialize");
		const calls = log.filter((m) => m.method === "tools/call").map((m) => m.params.name);
		expect(firstInit === 0, "initialize is the first host request", errors);
		expect(!calls.includes("list_shiplets"), "initial inbox result is not fetched again", errors);
		expect(calls.includes("get_feedback") && calls.includes("list_feedback"), "deep link loads the thread and its list", errors);
		const context = log.find((m) => m.method === "ui/update-model-context");
		expect(
			context?.params.structuredContent?.feedbackId === "review_2" &&
				context.params.content[0]._meta["openai/title"] === "Feedback: Annual toggle does not update prices",
			"open thread is shared as titled model context",
			errors,
		);

		const status = app.getByLabel("Status");
		await status.selectOption("Done");
		await app.locator(".sl-pane-list").getByText("Done", { exact: true }).waitFor({ state: "detached" }).catch(() => {});
		await page.waitForTimeout(200);
		log = await hostLog(page);
		expect(
			log.some((m) => m.method === "tools/call" && m.params.name === "update_feedback_status" && m.params.arguments.status === "Done"),
			"status change calls update_feedback_status",
			errors,
		);
		expect((await status.inputValue()) === "Done", "status select shows the new status", errors);

		await status.selectOption("Dropped");
		await app.getByText(/Status stayed Done/).waitFor();
		expect((await status.inputValue()) === "Done", "failed status change reverts", errors);
		await page.screenshot({ path: path.join(outDir, "status-error-fullscreen-light-1100.png"), fullPage: true });

		await app.getByLabel("Reply").fill("Shipping the fix today.");
		await app.getByRole("button", { name: "Post reply" }).click();
		await app.getByText("Shipping the fix today.").waitFor();
		await app.getByText("Reply posted.").waitFor();
		expect((await app.getByLabel("Reply").inputValue()) === "", "posted reply clears the draft", errors);

		await app.getByRole("button", { name: "Ask ChatGPT to address this" }).click();
		await app.getByText("Sent to ChatGPT.").waitFor();
		log = await hostLog(page);
		const message = log.find((m) => m.method === "ui/message");
		expect(
			message?.params.role === "user" &&
				message.params.content.length === 2 &&
				message.params.content[1]._meta["openai/title"] === "Feedback: Annual toggle does not update prices" &&
				message.params.content[1].text.includes("review_2"),
			"Ask ChatGPT sends instruction plus titled feedback context",
			errors,
		);

		await page.evaluate(() => window.hostNotify("ui/notifications/host-context-changed", { "openai/modelContext": null }));
		await app.getByText("Shared with ChatGPT as context").waitFor({ state: "detached" });
		expect(true, "host clearing model context removes the attached highlight", errors);

		await page.evaluate(() => window.hostNotify("ui/notifications/host-context-changed", { theme: "dark" }));
		await page.waitForTimeout(100);
		const theme = await app.locator("html").getAttribute("data-theme");
		expect(theme === "dark", "host theme change applies to the document", errors);

		await page.evaluate(() => window.hostNotify("ui/notifications/host-context-changed", { "openai/deepLink": { url: "/nope/../x" } }));
		await page.waitForTimeout(100);
		expect(await app.getByRole("heading", { name: "Annual toggle does not update prices" }).isVisible(), "unknown deep link is ignored", errors);

		await app.getByRole("button", { name: "Close thread" }).click();
		await page.waitForTimeout(150);
		log = await hostLog(page);
		const updates = log.filter((m) => m.method === "ui/update-model-context");
		expect(updates.at(-1)?.params.content?.length === 0, "closing the thread clears model context", errors);

		await page.keyboard.press("Escape");
		await app.getByRole("heading", { name: "Review inbox" }).waitFor();
		expect(true, "Escape returns from the feedback list to the inbox", errors);

		await page.evaluate(() => window.hostNotify("ui/notifications/host-context-changed", { "openai/deepLink": { url: "/shiplets/shiplet_pricing/feedback/review_1" } }));
		await app.getByRole("heading", { name: "Hero headline wraps under the nav" }).waitFor();
		expect(true, "deep link notification opens the thread", errors);
		await page.close();
	}
	{
		const { page, app } = await openScenario(browser, appHtml, outDir, "file", errors);
		await app.getByRole("button", { name: "Publish for review" }).waitFor();
		expect((await app.getByLabel("Name").inputValue()) === "Launch pricing v2", "publish name defaults to the prettified file name", errors);
		expect((await app.getByLabel("Visibility").inputValue()) === "organization", "visibility defaults to Organization", errors);
		const sandbox = await app.locator("iframe").getAttribute("sandbox");
		expect(sandbox === "allow-scripts", "preview iframe is sandboxed without same-origin", errors);
		const workspace = app.getByLabel("Workspace");
		await app.locator("#sl-publish-workspace:not([disabled])").waitFor();
		expect((await workspace.inputValue()) === "org_acme", "multi-workspace accounts default to the first workspace", errors);
		await workspace.selectOption("org_side");
		await app.getByRole("button", { name: "Publish for review" }).click();
		await app.getByRole("button", { name: "Open review" }).waitFor({ timeout: 5000 });
		const log = await hostLog(page);
		const publish = log.find((m) => m.method === "tools/call" && m.params.name === "publish_html_for_review");
		expect(
			publish?.params.arguments.files.length === 1 &&
				publish.params.arguments.files[0].path === "index.html" &&
				publish.params.arguments.files[0].content.includes("Launch pricing"),
			"publish sends the file as index.html",
			errors,
		);
		expect(publish?.params.arguments.workspace_id === "org_side", "publish sends the chosen workspace", errors);
		expect(await app.getByRole("button", { name: "Open review" }).isVisible(), "published card offers Open review", errors);
		await page.close();
	}
	for (const [label, extra, expected] of [
		["single", { workspaces: [{ id: "org_only", name: "Only" }] }, "org_only"],
		["failed", { workspacesError: true }, undefined],
	]) {
		scenarios[`file-${label}`] = { ...scenarios.file, ...extra };
		const { page, app } = await openScenario(browser, appHtml, outDir, `file-${label}`, errors);
		const button = app.getByRole("button", { name: "Publish for review" });
		await app.locator(".sl-publish .btn-primary:not([disabled])").waitFor();
		expect((await app.locator("#sl-publish-workspace").count()) === 0, `${label} workspace list hides the Workspace select`, errors);
		await button.click();
		await app.getByRole("button", { name: "Open review" }).waitFor({ timeout: 5000 });
		const log = await hostLog(page);
		const publish = log.find((m) => m.method === "tools/call" && m.params.name === "publish_html_for_review");
		expect(publish?.params.arguments.workspace_id === expected, `${label} workspace list publishes with workspace_id=${expected}`, errors);
		await page.close();
	}
	{
		const noFiles = { ...scenarios.file, noFiles: true };
		scenarios.fileNoAccess = noFiles;
		const { page, app } = await openScenario(browser, appHtml, outDir, "fileNoAccess", errors);
		await app.getByText(/needs the ChatGPT desktop app/).waitFor();
		expect(true, "missing resources extension shows an explanation", errors);
		await page.close();
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = process.argv[2];
	if (!outDir) {
		process.stderr.write("Usage: node src/plugin-app/dev/harness.mjs <output-dir> [chromium-executable]\n");
		process.exit(2);
	}
	await screenshots(path.resolve(outDir), process.argv[3]);
}
