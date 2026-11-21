// One annotation, followed around the whole loop: it is left on a Shiplet,
// shows up on Home waiting for agents, agents open a handshake for it, a trace
// comes back (one from a coding session, one exported from a handshake), and
// the person goes back to the Shiplet to check the work and annotate again.
// Every step links to the next and back.
//
// Set SHIPLET_E2E_SCREENSHOTS=<dir> to also save each screen at desktop and
// phone width.
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { Hub } from "../packages/agent-handshake/src/core/hub.js";
import { toShipletTrace } from "../packages/agent-handshake/src/core/trace.js";
import { parseJsonl, prepareTraceUpload } from "../src/cli/trace-core.mjs";
import {
	authHeaders,
	collectPageErrors,
	createOrganization,
	createReviewFeedback,
	expectNoPageErrors,
	loginAs,
	publishStaticShiplet,
	testUser,
	type E2EUser,
} from "./helpers";

const SCREENSHOTS = process.env.SHIPLET_E2E_SCREENSHOTS || "";
const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 860 },
	{ name: "phone", width: 390, height: 844 },
] as const;

async function capture(page: Page, name: string) {
	for (const viewport of VIEWPORTS) {
		await page.setViewportSize({ width: viewport.width, height: viewport.height });
		// Let layout settle at the new width before measuring or capturing.
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		// Let entrance animations finish (decorative loops never do, so skip those).
		await page.evaluate(() =>
			Promise.all(
				document
					.getAnimations()
					.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
					.map((animation) => animation.finished.catch(() => undefined)),
			),
		);
		// Annotating is the way in: the nav keeps it visible at every width.
		if (await page.locator(".platform-nav").count()) await expect(page.locator(".platform-nav-annotate")).toBeInViewport();
		// Nothing on these screens may push the page wider than the phone.
		expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} at ${viewport.name}`).toBeLessThanOrEqual(viewport.width);
		if (SCREENSHOTS) {
			fs.mkdirSync(SCREENSHOTS, { recursive: true });
			await page.screenshot({ path: path.join(SCREENSHOTS, `${name}-${viewport.name}.png`), fullPage: true });
		}
	}
	await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
}

async function shareTrace(request: Parameters<typeof createOrganization>[0], user: E2EUser, projectId: string, jsonl: string) {
	const prepared = await prepareTraceUpload({ main: parseJsonl(jsonl), importer: "e2e-work-loop" });
	const response = await request.post(`/api/shiplets/${encodeURIComponent(projectId)}/traces`, {
		headers: { ...authHeaders(user), "Content-Type": "application/json", Origin: "http://localhost:8787" },
		data: prepared.upload,
	});
	expect(response.status(), await response.text()).toBe(201);
	return ((await response.json()) as { trace: { id: string } }).trace.id;
}

function codingSessionTrace(title: string) {
	const at = (offset: number) => new Date(Date.now() + offset * 1000).toISOString();
	return [
		{ format: "shiplet.trace/v1", harness: "acme-agent", harnessVersion: "1.0.0", title, cwd: "/work/checkout", startedAt: at(1), models: [] },
		{ seq: 0, t: at(1), kind: "user_message", text: "Make the pay button readable. The annotation points at the Pay button on /." },
		{ seq: 1, t: at(2), kind: "assistant_message", text: "Darkened the label to 4.8:1 and published a new version." },
	]
		.map((line) => JSON.stringify(line))
		.join("\n");
}

// A handshake run through the real hub and exported exactly as the MCP tool
// export_handshake writes it.
async function exportedHandshake(request: { shiplet: string; feedback: string; label: string }) {
	const hub = new Hub();
	const a = hub.open();
	const b = hub.open();
	await a.handle("register", { name: "builder", kind: "claude", app: "claude-cli", machine: "studio" });
	await b.handle("register", { name: "checker", kind: "codex", app: "codex-cli", machine: "ci" });
	const sent = await a.handle("send", { to: "checker", text: "Can you run the contrast check?", record: true, topic: `${request.label}: pay button contrast`, request });
	await b.handle("send", { to: "builder", room: sent.room, text: "Passes on the new version." });
	return toShipletTrace(await a.handle("export", { room: sent.room }), { version: "0.1.0" });
}

test.describe("the annotation loop", () => {
	test("one annotation travels from Home to a handshake, to traces, and back to the Shiplet", async ({ page, request }) => {
		test.setTimeout(120_000);
		const user = testUser("work-loop");
		const errors = collectPageErrors(page);
		const organization = await createOrganization(request, user);
		const shipletName = `Checkout ${Date.now()}`;
		const { project } = await publishStaticShiplet(request, user, organization.id, {
			name: shipletName,
			html: `<!doctype html><title>${shipletName}</title><main><h1>Checkout</h1><button>Pay</button></main>`,
		});
		const comment = "Make the pay button readable: the label is too light on the green.";
		const { feedback } = await createReviewFeedback(request, user, project, { comment });
		const label = feedback.ticket_label;
		const annotationHref = `/shiplets/${project.id}?feedback=${feedback.id}`;
		await loginAs(page, user);

		// 1. Home: the way in is annotating, and the annotation is being worked on.
		await page.goto("/", { waitUntil: "networkidle" });
		await expect(page.locator(".app-page-topbar h1")).toHaveText("Home");
		await expect(page.getByRole("link", { name: "Annotate something" })).toHaveAttribute("href", "/annotate");
		const working = page.locator("#laneWorking");
		const handshakeCard = working.locator(".work-card-handshake").filter({ hasText: label });
		await expect(handshakeCard).toBeVisible();
		await expect(handshakeCard.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", annotationHref);
		await expect(page.getByText("Sample handshakes. The hosted relay is not built yet.")).toBeVisible();

		// 2. The annotations list: the request and the agent work on it.
		await page.goto("/feedback", { waitUntil: "networkidle" });
		await expect(page.locator(".app-page-topbar h1")).toHaveText("Annotations");
		const row = page.locator("tr").filter({ hasText: comment });
		await expect(row.locator(".work-link-live")).toHaveText(/Claude Code \+ Codex/);
		await capture(page, "2-annotations");

		// 3. The handshake opened for it: who is in it, what they said, and the way back.
		await row.locator(".work-link-live").click();
		await expect(page).toHaveURL(/\/handshakes\/hs_sample/);
		await expect(page.locator(".app-page-topbar h1")).toContainText(label);
		const origin = page.locator(".work-origin");
		await expect(origin).toContainText(comment);
		await expect(origin.getByRole("link", { name: "Open the annotation" })).toHaveAttribute("href", annotationHref);
		await expect(page.locator(".handshake-message")).toHaveCount(6);
		await expect(page.locator(".handshake-peers li")).toHaveCount(3);
		await expect(page.locator(".handshake-peers li[data-peer-state='left']")).toContainText("a11y-review");
		await expect(page.getByRole("heading", { name: "Share it as a trace" })).toBeVisible();
		await expect(page.locator(".work-prompt")).toContainText(`--shiplet ${project.id}`);
		await capture(page, "3-handshake");

		// Agents share their work: a coding session, and the handshake itself.
		const sessionTraceId = await shareTrace(request, user, project.id, codingSessionTrace("Fix pay button contrast"));
		await shareTrace(request, user, project.id, await exportedHandshake({ shiplet: project.id, feedback: feedback.id, label }));

		// 4. Home again: the traces came back for the person to check.
		await page.goto("/", { waitUntil: "networkidle" });
		const check = page.locator("#laneCheck");
		await expect(check.locator(".work-card-trace")).toHaveCount(2);
		const sessionCard = check.locator(`[data-trace-id="${sessionTraceId}"]`);
		await expect(sessionCard.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", annotationHref);
		await expect(check.getByText("From a handshake")).toBeVisible();
		await capture(page, "1-home");

		// 5. Handshakes: live ones, and the one an agent shared as a trace.
		await page.goto("/handshakes", { waitUntil: "networkidle" });
		await expect(page.locator(".work-row[data-handshake-id]")).toHaveCount(2);
		const recorded = page.locator(".work-row[data-handshake-id]").filter({ hasText: label });
		await expect(recorded.getByText("Recording")).toBeVisible();
		await expect(page.locator(".work-row[data-handshake-id]").filter({ hasText: "retry policy" }).getByText("Not recorded")).toBeVisible();
		await expect(page.locator("#keptHandshakesTitle")).toHaveText("Handshakes shared as traces");
		await expect(page.locator(".work-row[data-trace-id]")).toContainText(`Handshake: ${label}: pay button contrast`);
		await capture(page, "4-handshakes");

		// An unrecorded handshake shows who and how many, never what was said.
		await page.locator(".work-row[data-handshake-id]").filter({ hasText: "retry policy" }).getByRole("link").first().click();
		await expect(page.getByText("This handshake is not recorded.")).toBeVisible();
		await expect(page.locator(".handshake-message")).toHaveCount(0);

		// An ended handshake is gone, and the page says so.
		await page.goto("/handshakes/hs_ended", { waitUntil: "networkidle" });
		await expect(page.locator(".app-page-topbar h1")).toHaveText("This handshake has ended");

		// 6. Traces: every trace links back to the annotations before it.
		await page.goto("/traces", { waitUntil: "networkidle" });
		const traceRow = page.locator(`.work-row[data-trace-id="${sessionTraceId}"]`);
		await expect(traceRow.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", annotationHref);
		await capture(page, "5-traces");

		// 7. One trace: where it came from, agents still talking, and the way back to check.
		await traceRow.getByRole("link", { name: "Fix pay button contrast" }).click();
		await expect(page).toHaveURL(new RegExp(`/traces/${sessionTraceId}$`));
		const strip = page.getByRole("navigation", { name: "Where this trace came from" });
		await expect(strip.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", annotationHref);
		await expect(strip.locator(".trace-loop-handshake")).toContainText(label);
		await expect(page.locator(".trace-transcript, [data-trace-transcript], #trace-viewer-root")).toContainText("Darkened the label");
		await capture(page, "6-trace");

		// 8. Back on the Shiplet to check the new version and annotate again.
		await strip.getByRole("link", { name: "Check and annotate" }).click();
		await expect(page).toHaveURL(new RegExp(`/shiplets/${project.id}$`));
		await capture(page, "7-shiplet");

		// 9. Annotate: start from something already on Shiplet, or put up something new.
		await page.goto("/annotate", { waitUntil: "networkidle" });
		await expect(page.locator(".app-page-topbar h1")).toHaveText("Start with an annotation");
		await expect(page.locator(".annotate-existing")).toContainText(shipletName);
		await capture(page, "8-annotate");

		await expectNoPageErrors(errors);
	});
});
