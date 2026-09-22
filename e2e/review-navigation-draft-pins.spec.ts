import {
	expect,
	test,
	type FrameLocator,
	type Locator,
	type Page,
	type Route,
} from "@playwright/test";

import {
	createTrustedReviewHostResponse,
	trustedReviewHostScript,
	trustedReviewHostStyles,
} from "../src/trusted-review-host";
import { trustedArtifactBridgeScript } from "../src/trusted-artifact-bridge";

const hostOrigin = "http://navigation.localhost:8816";
const navigationR7EvidenceDir = "/private/tmp/shiplet-parity-navigation-r8-20260920";

type DeferredSignal = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferredSignal(): DeferredSignal {
	let resolve!: () => void;
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function mountNavigationHost(page: Page) {
	const response = createTrustedReviewHostResponse({
		shipletId: "navigation_project",
		revisionId: "navigation_revision",
		title: "Navigation review",
		artifactUrl: `${hostOrigin}/artifact-frame/index.html`,
		widgetUrl: null,
		hostScriptUrl: `${hostOrigin}/api/review/host.js`,
		reviewApiUrl: `${hostOrigin}/__shiplet/review/feedback`,
		confirmationUrl: `${hostOrigin}/review/confirm`,
		reviewPageUrl: `${hostOrigin}/reviewed-page`,
		submissionMode: "sandbox",
	});
	const hostHtml = await response.text();
	await page.route(`${hostOrigin}/**`, async (route: Route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/review/host.js") {
			return route.fulfill({ status: 200, contentType: "application/javascript", body: trustedReviewHostScript() });
		}
		if (url.pathname === "/api/review/host.css") {
			return route.fulfill({ status: 200, contentType: "text/css", body: trustedReviewHostStyles() });
		}
		if (url.pathname === "/__shiplet/review/feedback") {
			const feedback = [
				...(["nav_1", "nav_2", "nav_3"].map((id, index) => ({ id, ticket_label: "PF-" + (index + 1), ticket_number: index + 1, comment: "Pinned navigation comment " + (index + 1), status: "New", page_url: `${hostOrigin}/reviewed-page`, revision_id: "navigation_revision", submitted_by_email: "reviewer@example.test", replies: [], selected_element: { selector: "#target", tagName: "BUTTON", text: "Target" }, coordinates: { pageX: 20, pageY: 20, viewportX: 20, viewportY: 20 } }))),
				{ id: "nav_page", ticket_label: "PF-4", ticket_number: 4, comment: "Coordinate-less page comment", status: "New", page_url: `${hostOrigin}/reviewed-page`, revision_id: "navigation_revision", submitted_by_email: "reviewer@example.test", replies: [] },
			];
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ feedback, nextCursor: null }) });
		}
		if (url.pathname === "/__shiplet/review/draft-context") {
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ context: {
				actor: { kind: "human", id: "actor_navigation" },
				projectId: "navigation_project",
				revisionId: "navigation_revision",
				pageUrl: `${hostOrigin}/reviewed-page`,
				installationId: null,
				expiresOn: null,
				durableOperations: false,
			} }) });
		}
		if (url.pathname.startsWith("/artifact-frame/")) {
			return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><body><button id="target">Target</button><script>${trustedArtifactBridgeScript()}</script></body></html>` });
		}
		return route.fulfill({ status: 200, contentType: "text/html", body: hostHtml });
	});
	await page.goto(`${hostOrigin}/reviewed-page`, { waitUntil: "domcontentloaded" });
	await expect(page.locator(".shiplet-review-comments-launcher")).toBeVisible();
}

async function mountRouteClearNavigationHost(
	page: Page,
	pageUrls: string[],
	feedbackUrls: string[],
  options: { instrumentGeometry?: boolean } = {},
): Promise<{ yFeedbackRequested: Promise<void>; releaseYFeedback: () => void }> {
	const routeHostOrigin = "http://navigation-route.localhost:8816";
	const initialPageUrl = `${routeHostOrigin}/reviewed-page`;
	const nextPageUrl = `${routeHostOrigin}/next-page`;
	const response = createTrustedReviewHostResponse({
		shipletId: "navigation_route_project",
		revisionId: "navigation_route_revision",
		title: "Navigation route review",
		artifactUrl: `${routeHostOrigin}/artifact-frame/reviewed-page`,
		widgetUrl: null,
		hostScriptUrl: `${routeHostOrigin}/api/review/host.js`,
		reviewApiUrl: `${routeHostOrigin}/__shiplet/review/feedback`,
		confirmationUrl: `${routeHostOrigin}/review/confirm`,
		reviewPageUrl: initialPageUrl,
		submissionMode: "sandbox",
	});
	const hostHtml = await response.text();
	const yFeedbackRequest = deferredSignal();
	const yFeedbackRelease = deferredSignal();
	const geometryProbeScript = options.instrumentGeometry
		? `<script>(() => {
			const messages = [];
			const nativePostMessage = MessagePort.prototype.postMessage;
			MessagePort.prototype.postMessage = function (...args) {
				const [message] = args;
				if (message && typeof message === "object" && message.protocol === "shiplet.artifact.saved-targets.geometry.v1") messages.push(message);
				return Reflect.apply(nativePostMessage, this, args);
			};
			window.__shipletGeometryMessages = messages;
		})();</script>`
		: "";
	await page.route(`${routeHostOrigin}/**`, async (route: Route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/api/review/host.js") {
			return route.fulfill({
				status: 200,
				contentType: "application/javascript",
				body: trustedReviewHostScript(),
			});
		}
		if (url.pathname === "/api/review/host.css") {
			return route.fulfill({
				status: 200,
				contentType: "text/css",
				body: trustedReviewHostStyles(),
			});
		}
		if (url.pathname === "/__shiplet/review/draft-context") {
			const pageUrl = url.searchParams.get("page_url") || "";
			pageUrls.push(pageUrl);
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					context: {
						actor: { kind: "human", id: "actor_navigation_route" },
						projectId: "navigation_route_project",
						revisionId: "navigation_route_revision",
						pageUrl,
						installationId: null,
						expiresOn: null,
						durableOperations: false,
					},
				}),
			});
		}
		if (url.pathname === "/__shiplet/review/feedback") {
			const pageUrl = url.searchParams.get("pageUrl") || "";
			feedbackUrls.push(pageUrl);
			const next = pageUrl === nextPageUrl;
			if (next) {
				yFeedbackRequest.resolve();
				await yFeedbackRelease.promise;
			}
			const item = next
				? {
						id: "nav_y",
						ticket_label: "PF-Y",
						ticket_number: 2,
						comment: "Pinned navigation comment Y",
						status: "New",
						page_url: nextPageUrl,
						revision_id: "navigation_route_revision",
						submitted_by_email: "reviewer@example.test",
						replies: [],
						selected_element: {
							selector: "#target-y",
							tagName: "BUTTON",
							text: "Target Y",
						},
						coordinates: {
							pageX: 40,
							pageY: 40,
							viewportX: 40,
							viewportY: 40,
						},
					}
				: {
						id: "nav_x",
						ticket_label: "PF-X",
						ticket_number: 1,
						comment: "Pinned navigation comment X",
						status: "New",
						page_url: initialPageUrl,
						revision_id: "navigation_route_revision",
						submitted_by_email: "reviewer@example.test",
						replies: [],
						selected_element: {
							selector: "#target-x",
							tagName: "BUTTON",
							text: "Target X",
						},
						coordinates: {
							pageX: 24,
							pageY: 24,
							viewportX: 24,
							viewportY: 24,
						},
					};
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ feedback: [item], nextCursor: null }),
			});
		}
		if (url.pathname.startsWith("/artifact-frame/")) {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: `<!doctype html><html><body>${geometryProbeScript}<button id="target-x" style="margin:120px;width:120px;height:40px">Target X</button><script>${trustedArtifactBridgeScript()}</script></body></html>`,
			});
		}
		return route.fulfill({
			status: 200,
			contentType: "text/html",
			body: hostHtml,
		});
	});
	await page.goto(initialPageUrl, { waitUntil: "domcontentloaded" });
	await expect(page.locator(".shiplet-review-comments-launcher")).toBeVisible();
	return {
		yFeedbackRequested: yFeedbackRequest.promise,
		releaseYFeedback: yFeedbackRelease.resolve,
	};
}

type GeometryMessage = {
	protocol: string;
	type: string;
	targets: Array<{ feedbackId?: string; eligible?: boolean }>;
};

async function readGeometryMessages(artifact: Locator | FrameLocator): Promise<GeometryMessage[]> {
	return artifact.locator("html").evaluate(() => {
		const messages = (window as typeof window & { __shipletGeometryMessages?: GeometryMessage[] }).__shipletGeometryMessages;
		return Array.isArray(messages) ? messages : [];
	});
}

async function waitForArtifactFrames(artifact: Locator | FrameLocator) {
	await artifact.locator("html").evaluate(() => new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	}));
}

test("fresh trusted context restores a draft after reload and isolates the actor key", async ({ page }) => {
	await mountNavigationHost(page);
	await page.locator(".shiplet-review-comments-launcher").click();
	await page.getByRole("button", { name: "New comment" }).click();
	await page.locator("iframe[data-shiplet-artifact-frame]").contentFrame().locator("#target").click();
	await page.locator("#shiplet-review-comment").fill("draft owned by actor_navigation");
	await expect.poll(async () => page.evaluate(() => new Promise((resolve) => {
		const request = indexedDB.open("shiplet-review-drafts-v1");
		request.onerror = () => resolve(false);
		request.onsuccess = () => {
			const database = request.result;
			const read = database.transaction("drafts", "readonly").objectStore("drafts").getAll();
			read.onsuccess = () => { const records = Array.isArray(read.result) ? read.result : []; resolve(records.some((record) => record?.topDraft?.text === "draft owned by actor_navigation")); };
			read.onerror = () => resolve(false);
		};
	})), { timeout: 5000 }).toBe(true);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.locator(".shiplet-review-comments-launcher").click();
	await page.getByRole("button", { name: "New comment" }).click();
	await expect(page.locator("#shiplet-review-comment")).toHaveValue("draft owned by actor_navigation");
	await page.evaluate(() => indexedDB.deleteDatabase("shiplet-review-drafts-v1"));
});

test("hide and show comments gates pins and exposes page comments", async ({ page }) => {
	await mountNavigationHost(page);
	await page.locator(".shiplet-review-comments-launcher").click();
	await page.locator('[aria-label="Review options"]').click();
	await expect(page.getByRole("button", { name: "Hide comments" })).toBeVisible();
	await page.getByRole("button", { name: "Hide comments" }).click();
	await expect(page.getByRole("button", { name: "Show comments" })).toBeVisible();
	await page.getByRole("button", { name: "Show comments" }).click();
	await expect(page.getByRole("button", { name: "3 comments at this location" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Page comments \(1\)/ })).toBeVisible();
	await page.getByRole("button", { name: /Page comments \(1\)/ }).click();
	await expect(page.getByRole("menuitem", { name: /PF-4/ })).toBeVisible();

	await page.getByRole("button", { name: "New comment" }).click();
	await expect(page.locator("iframe[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "true");
	await expect(page.locator("[data-shiplet-annotation-modebar]")).toBeVisible();
	await expect(page.getByRole("button", { name: "3 comments at this location" })).toBeHidden();
	await expect(page.locator(".shiplet-review-pin")).toHaveCount(3);
	for (const pin of await page.locator(".shiplet-review-pin").all()) await expect(pin).toBeHidden();
	await expect(page.getByRole("button", { name: /Page comments \(1\)/ })).toBeHidden();

	const artifact = page.locator("iframe[data-shiplet-artifact-frame]").contentFrame();
	await artifact.locator("#target").click();
	await expect(page.locator("iframe[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "false");
	await expect(page.locator("#shiplet-annotation-composer")).toBeVisible();
	await expect(page.getByRole("button", { name: "3 comments at this location" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Page comments \(1\)/ })).toBeVisible();
	await page.getByRole("button", { name: "Cancel annotation mode", exact: true }).click();
	await expect(page.locator("#shiplet-annotation-composer")).toBeHidden();
	await expect(page.getByRole("button", { name: "3 comments at this location" })).toBeVisible();
	await expect(page.getByRole("button", { name: /Page comments \(1\)/ })).toBeVisible();
});

test("clears saved target pins across a trusted route and restores only fresh geometry", async ({ page }) => {
	const contextPageUrls: string[] = [];
	const feedbackPageUrls: string[] = [];
	const routeGate = await mountRouteClearNavigationHost(page, contextPageUrls, feedbackPageUrls);
	await page.locator(".shiplet-review-comments-launcher").click();
	await expect(page.locator('[data-shiplet-review-thread="nav_x"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Open PF-X" })).toBeVisible();
	await expect.poll(() => contextPageUrls).toContain(`${"http://navigation-route.localhost:8816"}/reviewed-page`);
	await expect.poll(() => feedbackPageUrls).toContain(`${"http://navigation-route.localhost:8816"}/reviewed-page`);

	const artifact = page.locator("iframe[data-shiplet-artifact-frame]").contentFrame();
	await expect(artifact.locator("#target-x")).toBeVisible();
	await artifact.locator("html").evaluate(() => {
		history.pushState({}, "", "/next-page");
		document.body.innerHTML = '<button id="target-y" style="margin:260px;width:120px;height:40px">Target Y</button>';
	});

	await expect.poll(async () => artifact.locator("html").evaluate(() => location.pathname)).toBe("/next-page");
	await expect.poll(() => contextPageUrls.at(-1)).toBe(`${"http://navigation-route.localhost:8816"}/next-page`);
	await expect.poll(() => feedbackPageUrls.at(-1)).toBe(`${"http://navigation-route.localhost:8816"}/next-page`);
	await routeGate.yFeedbackRequested;
	await expect(page.locator("html")).toHaveAttribute("data-review-page-url", `${"http://navigation-route.localhost:8816"}/next-page`);
	await expect(page.locator('[data-shiplet-review-thread="nav_x"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Open PF-X" })).toHaveCount(0);
	await expect(page.locator('.shiplet-review-pin[aria-label="Open PF-X"]')).toHaveCount(0);
	await expect(page.locator('[data-feedback-id="nav_x"]')).toHaveCount(0);
	await expect(page.locator('[data-shiplet-review-thread="nav_y"]')).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Open PF-Y" })).toHaveCount(0);
	await expect(page.locator('.shiplet-review-pin[aria-label="Open PF-Y"]')).toHaveCount(0);
	await page.screenshot({
		path: `${navigationR7EvidenceDir}/route-held-y-x-cleared.png`,
		fullPage: true,
	});

	routeGate.releaseYFeedback();
	await expect(artifact.locator("#target-y")).toBeVisible();
	await expect(page.locator('[data-shiplet-review-thread="nav_y"]')).toBeVisible();
	await expect(page.getByRole("button", { name: "Open PF-Y" })).toBeVisible();
	const freshPin = page.locator('.shiplet-review-pin[aria-label="Open PF-Y"]');
	await expect(freshPin).toHaveCount(1);
	await expect(page.locator('.shiplet-review-pin[aria-label="Open PF-X"]')).toHaveCount(0);
	await expect(page.locator('[data-shiplet-review-thread="nav_x"]')).toHaveCount(0);
	const targetYGeometry = await artifact.locator("#target-y").evaluate((node) => {
		const rect = node.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	});
	const pinBeforeReflow = await freshPin.evaluate((node) => ({
		x: Number.parseFloat((node as HTMLElement).style.left),
		y: Number.parseFloat((node as HTMLElement).style.top),
	}));
	expect(Math.abs(pinBeforeReflow.x - targetYGeometry.x)).toBeLessThan(4);
	expect(Math.abs(pinBeforeReflow.y - targetYGeometry.y)).toBeLessThan(4);
	await artifact.locator("#target-y").evaluate((node) => {
		(node as HTMLElement).style.marginTop = "360px";
	});
	await expect.poll(async () => {
		const target = await artifact.locator("#target-y").evaluate((node) => {
			const rect = node.getBoundingClientRect();
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		});
		const pin = await freshPin.evaluate((node) => ({
			x: Number.parseFloat((node as HTMLElement).style.left),
			y: Number.parseFloat((node as HTMLElement).style.top),
		}));
		return Math.abs(pin.x - target.x) < 4 && Math.abs(pin.y - target.y) < 4;
	}).toBe(true);
	await page.screenshot({
		path: `${navigationR7EvidenceDir}/route-released-y-only.png`,
		fullPage: true,
	});
});

test("clears stale saved-target geometry before admitting fresh route data", async ({ page }) => {
	const contextPageUrls: string[] = [];
	const feedbackPageUrls: string[] = [];
	const routeGate = await mountRouteClearNavigationHost(
		page,
		contextPageUrls,
		feedbackPageUrls,
		{ instrumentGeometry: true },
	);
	const artifact = page.locator("iframe[data-shiplet-artifact-frame]").contentFrame();
	await page.locator(".shiplet-review-comments-launcher").click();
	await expect(page.locator('[data-shiplet-review-thread="nav_x"]')).toBeVisible();
	await expect.poll(async () => {
		const messages = await readGeometryMessages(artifact);
		return messages.some((message) => message.targets.some((target) => target.feedbackId === "nav_x" && target.eligible === true));
	}).toBe(true);

	await artifact.locator("html").evaluate(() => {
		history.pushState({}, "", "/next-page");
		const next = document.createElement("button");
		next.id = "target-y";
		next.textContent = "Target Y";
		next.style.cssText = "margin:260px;width:120px;height:40px";
		document.body.appendChild(next);
	});
	await routeGate.yFeedbackRequested;
	await artifact.locator("html").evaluate(() => {
		const messages = (window as typeof window & { __shipletGeometryMessages?: GeometryMessage[] }).__shipletGeometryMessages;
		if (!Array.isArray(messages)) throw new Error("Geometry probe was not installed");
		messages.length = 0;
	});
	await artifact.locator("#target-x").evaluate((node) => {
		const target = node as HTMLElement;
		const view = window as typeof window & { __shipletObservedTransitionEnd?: boolean };
		view.__shipletObservedTransitionEnd = false;
		target.addEventListener("transitionend", () => {
			view.__shipletObservedTransitionEnd = true;
		}, { once: true });
		target.style.transition = "transform 32ms linear";
		void target.getBoundingClientRect();
		target.style.transform = "translateY(40px)";
	});
	await expect.poll(async () => artifact.locator("html").evaluate(() => {
		const view = window as typeof window & { __shipletObservedTransitionEnd?: boolean };
		return view.__shipletObservedTransitionEnd === true;
	})).toBe(true);
	await waitForArtifactFrames(artifact);
	const heldGeometry = await readGeometryMessages(artifact);
	const heldTargets = heldGeometry.flatMap((message) => message.targets.map((target) => target.feedbackId));
	expect(heldTargets).not.toContain("nav_x");
	await page.screenshot({
		path: `${navigationR7EvidenceDir}/stale-geometry-held-y.png`,
		fullPage: true,
	});

	routeGate.releaseYFeedback();
	await expect(page.locator('[data-shiplet-review-thread="nav_y"]')).toBeVisible();
	await expect.poll(async () => {
		const messages = await readGeometryMessages(artifact);
		return messages.some((message) => message.targets.some((target) => target.feedbackId === "nav_y" && target.eligible === true));
	}).toBe(true);
	const releasedGeometry = await readGeometryMessages(artifact);
	const releasedTargets = releasedGeometry.flatMap((message) => message.targets.map((target) => target.feedbackId));
	expect(releasedTargets).toContain("nav_y");
	expect(releasedTargets).not.toContain("nav_x");
	console.log("stale-geometry-summary", JSON.stringify({
		initialX: true,
		transitionEndObserved: true,
		heldMessages: heldGeometry.length,
		heldTargets,
		releasedMessages: releasedGeometry.length,
		releasedTargets,
	}));
	await page.screenshot({
		path: `${navigationR7EvidenceDir}/stale-geometry-released-y.png`,
		fullPage: true,
	});
});
