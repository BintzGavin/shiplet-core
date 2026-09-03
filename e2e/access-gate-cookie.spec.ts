import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	expect,
	test,
	type APIResponse,
	type BrowserContext,
	type Page,
} from "@playwright/test";

const workerPort = 8792;
const platformOrigin = "https://app.shiplet.test";
const artifactCookieName = "__Host-shiplet_artifact_access";
const capabilityQueryName = "shiplet_preview_token";
const wranglerCli = require.resolve("wrangler");

let worker: ChildProcessWithoutNullStreams;
let persistencePath: string;

test.use({
	ignoreHTTPSErrors: true,
	screenshot: "off",
	trace: "off",
	video: "off",
});

test.beforeAll(async () => {
	persistencePath = mkdtempSync(join(tmpdir(), "shiplet-cookie-e2e-"));
	worker = spawn(
		process.execPath,
		[
			wranglerCli,
			"dev",
			"--config",
			"wrangler.test.jsonc",
			"--local",
			"--local-protocol",
			"https",
			"--port",
			String(workerPort),
			"--inspector-port",
			"9232",
			"--persist-to",
			persistencePath,
			"--var",
			"CUSTOM_DOMAIN:shiplet.test",
			"--var",
			`SHIPLET_APP_URL:${platformOrigin}`,
			"--var",
			"SHIPLET_AUTH_MODE:test",
		],
		{
			cwd: process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	await waitForWrangler(worker);
});

test.afterAll(async () => {
	if (worker && worker.exitCode === null) {
		worker.kill("SIGTERM");
		await Promise.race([
			new Promise<void>((resolve) => worker.once("exit", () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
	if (persistencePath) rmSync(persistencePath, { recursive: true, force: true });
});

test.describe("access-gate browser cookie lifecycle", () => {
	test("Given an access-gate reviewer, When Chromium exchanges the cookie and a hostile site submits a form, Then only the exact tenant can create review effects", async ({
		context,
		page,
	}) => {
		const routedCapabilityRequests: string[] = [];
		let siblingInitialStatus: number | null = null;
		let siblingInitialLocation: string | null = null;
		let siblingSentArtifactCookie = false;
		const observedProxyPaths: string[] = [];

		const proxy = await installHttpsShipletProxy(context, async ({ requestUrl, response }) => {
			observedProxyPaths.push(`${requestUrl.hostname}${requestUrl.pathname}`);
			if (requestUrl.searchParams.has(capabilityQueryName)) {
				routedCapabilityRequests.push(requestUrl.origin);
			}
			if (
				requestUrl.hostname.startsWith("sibling-") &&
				requestUrl.pathname === "/"
			) {
				siblingInitialStatus = response.status();
				siblingInitialLocation = response.headers()["location"] || null;
			}
		});

		const owner = syntheticUser("cookie-owner");
		const reviewer = syntheticUser("cookie-reviewer");
		await page.goto(platformOrigin, { waitUntil: "domcontentloaded" });

		const organization = await browserJson<{ organization: { id: string } }>(
			page,
			`${platformOrigin}/api/organizations`,
			{
				method: "POST",
				headers: owner,
				body: { name: `Cookie lifecycle ${randomUUID()}` },
			},
		);
		const tenant = await publishBrowserShiplet(
			page,
			owner,
			organization.organization.id,
			"tenant",
		);
		const sibling = await publishBrowserShiplet(
			page,
			owner,
			organization.organization.id,
			"sibling",
		);

		const tenantUrl = `https://${tenant.subdomain}.shiplet.test/`;
		const accessGate = new URL(
			`/shiplets/${encodeURIComponent(tenant.id)}/access`,
			platformOrigin,
		);
		accessGate.searchParams.set("return_to", tenantUrl);
		const callback = new URL("/auth/callback", platformOrigin);
		callback.searchParams.set(
			"code",
			`test-code:${organization.organization.id}:${reviewer["x-shiplet-user-email"]}`,
		);
		callback.searchParams.set(
			"state",
			Buffer.from(JSON.stringify({ returnTo: accessGate.toString() })).toString(
				"base64",
			),
		);

		await page.goto(callback.toString(), { waitUntil: "domcontentloaded" });
		const gatedUrl = proxy.takeRedirect("app.shiplet.test", "/auth/callback");
		await page.goto(gatedUrl, { waitUntil: "domcontentloaded" });
		let signedTenantUrl = proxy.takeRedirect(
			"app.shiplet.test",
			accessGate.pathname,
		);
		expect(new URL(signedTenantUrl).searchParams.has(capabilityQueryName)).toBe(
			true,
		);
		try {
			await page.goto(signedTenantUrl, { waitUntil: "domcontentloaded" });
		} catch {
			throw new Error(
				`Capability exchange navigation failed after ${observedProxyPaths.length} proxied requests`,
			);
		}
		signedTenantUrl = "";
		const cleanTenantUrl = proxy.takeRedirect(
			`${tenant.subdomain}.shiplet.test`,
			"/",
		);
		await page.goto(cleanTenantUrl, { waitUntil: "domcontentloaded" });

		expect(page.url()).toBe(tenantUrl);
		expect(page.url()).not.toContain(capabilityQueryName);
		expect(routedCapabilityRequests).toEqual([
			`https://${tenant.subdomain}.shiplet.test`,
		]);
		await expect(
			page.locator("[data-shiplet-trusted-review-host='v1']"),
		).toBeVisible();

		const artifactFrameUrl = await page
			.locator("[data-shiplet-artifact-frame]")
			.getAttribute("src");
		expect(artifactFrameUrl).toBeTruthy();
		expect(artifactFrameUrl).not.toContain(capabilityQueryName);
		for (const frame of page.frames()) {
			expect(frame.url()).not.toContain(capabilityQueryName);
		}

		const cookieMetadata = (await context.cookies(tenantUrl))
			.filter((cookie) => cookie.name === artifactCookieName)
			.map(({ name, domain, path, httpOnly, secure, sameSite }) => ({
				name,
				domain,
				path,
				httpOnly,
				secure,
				sameSite,
			}));
		expect(cookieMetadata).toEqual([
			{
				name: artifactCookieName,
				domain: `${tenant.subdomain}.shiplet.test`,
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "None",
			},
		]);

		const reviewResult = await page.evaluate(async () => {
			const list = await fetch("/__shiplet/review/feedback", {
				credentials: "include",
			});
			const create = await fetch("/__shiplet/review/feedback", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					comment: "Browser cookie lifecycle review",
					pageUrl: location.href,
					clientFeedbackId: `browser-cookie-${crypto.randomUUID()}`,
				}),
			});
			return {
				listStatus: list.status,
				createStatus: create.status,
				created: create.ok ? ((await create.json()) as { ok?: boolean }).ok : false,
			};
		});
		expect(reviewResult).toEqual({
			listStatus: 200,
			createStatus: 201,
			created: true,
		});
		const feedbackBeforeHostileForm = await page.evaluate(async () => {
			const response = await fetch("/__shiplet/review/feedback", {
				credentials: "include",
			});
			return (await response.json()) as {
				feedback: Array<{ comment: string; submitted_by_email: string | null }>;
			};
		});

		const hostileOrigin = "https://hostile-review.invalid";
		const forgedComment = `=Hostile form forgery ${randomUUID()}`;
		const forgedPayload = JSON.stringify({
			comment: forgedComment,
			pageUrl: tenantUrl,
			clientFeedbackId: `hostile-form-${randomUUID()}`,
		});
		const separator = forgedPayload.indexOf("=");
		const hostileFieldName = forgedPayload.slice(0, separator);
		const hostileFieldValue = forgedPayload.slice(separator + 1);
		await context.route(`${hostileOrigin}/**`, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "text/html",
				body: `<!doctype html><title>Hostile origin</title><form method="post" enctype="text/plain" action="${tenantUrl}__shiplet/review/feedback"><input type="hidden" name="${escapeHtmlAttribute(hostileFieldName)}" value="${escapeHtmlAttribute(hostileFieldValue)}"><button type="submit">Forge human feedback</button></form>`,
			});
		});
		const hostilePage = await context.newPage();
		await hostilePage.goto(hostileOrigin, { waitUntil: "domcontentloaded" });
		const hostileRequestPromise = hostilePage.waitForRequest(
			(request) =>
				request.method() === "POST" &&
				new URL(request.url()).pathname === "/__shiplet/review/feedback",
		);
		const hostileResponsePromise = hostilePage.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname === "/__shiplet/review/feedback",
		);
		await hostilePage.getByRole("button", { name: "Forge human feedback" }).click();
		const [hostileRequest, hostileResponse] = await Promise.all([
			hostileRequestPromise,
			hostileResponsePromise,
		]);
		const hostileHeaders = await hostileRequest.allHeaders();
		const hostileRequestMetadata = {
			origin: hostileHeaders.origin || null,
			contentType: hostileHeaders["content-type"]?.split(";")[0] || null,
			hasArtifactCookie:
				hostileHeaders.cookie
					?.split(";")
					.some((value) => value.trim().startsWith(`${artifactCookieName}=`)) ??
				false,
		};
		expect(hostileRequestMetadata).toEqual({
			origin: hostileOrigin,
			contentType: "text/plain",
			hasArtifactCookie: true,
		});
		expect.soft(hostileResponse.status()).toBe(403);

		const feedbackAfterHostileForm = await page.evaluate(async () => {
			const response = await fetch("/__shiplet/review/feedback", {
				credentials: "include",
			});
			return (await response.json()) as {
				feedback: Array<{ comment: string; submitted_by_email: string | null }>;
			};
		});
		expect(feedbackAfterHostileForm.feedback.length).toBe(
			feedbackBeforeHostileForm.feedback.length,
		);
		expect(
			feedbackAfterHostileForm.feedback.some(
				(feedback) => feedback.comment === forgedComment,
			),
		).toBe(false);

		const siblingPage = await context.newPage();
		siblingPage.on("request", (request) => {
			const url = new URL(request.url());
			if (url.hostname === `${sibling.subdomain}.shiplet.test`) {
				siblingSentArtifactCookie ||= request
					.headers()["cookie"]
					?.includes(`${artifactCookieName}=`) ?? false;
			}
		});
		const siblingUrl = `https://${sibling.subdomain}.shiplet.test/`;
		await siblingPage.goto(siblingUrl, {
			waitUntil: "domcontentloaded",
		});

		expect(siblingInitialStatus).toBe(302);
		expect(siblingInitialLocation).toContain(`${platformOrigin}/auth/login`);
		expect(siblingSentArtifactCookie).toBe(false);
		expect(siblingPage.url()).toBe(siblingUrl);
	});
});

type SyntheticHeaders = {
	"x-shiplet-user-id": string;
	"x-shiplet-user-email": string;
};

function syntheticUser(label: string): SyntheticHeaders {
	const suffix = randomUUID();
	return {
		"x-shiplet-user-id": `user_${label}_${suffix}`,
		"x-shiplet-user-email": `${label}-${suffix}@example.com`,
	};
}

function escapeHtmlAttribute(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

async function publishBrowserShiplet(
	page: Page,
	headers: SyntheticHeaders,
	organizationId: string,
	prefix: "tenant" | "sibling",
) {
	const subdomain = `${prefix}-${randomUUID().slice(0, 8)}`;
	const result = await browserJson<{ project: { id: string; subdomain: string } }>(
		page,
		`${platformOrigin}/projects`,
		{
			method: "POST",
			headers,
			body: {
				name: `Cookie ${prefix} ${randomUUID()}`,
				organization_id: organizationId,
				subdomain,
				visibility: "organization",
				assets: [
					{
						path: "index.html",
						content: Buffer.from(
							`<!doctype html><h1>${prefix} cookie fixture</h1>`,
						).toString("base64"),
						size: Buffer.byteLength(
							`<!doctype html><h1>${prefix} cookie fixture</h1>`,
						),
					},
				],
			},
		},
	);
	return result.project;
}

async function browserJson<T>(
	page: Page,
	url: string,
	input: {
		method: "POST";
		headers: SyntheticHeaders;
		body: unknown;
	},
): Promise<T> {
	return page.evaluate(
		async ({ requestUrl, request }) => {
			const response = await fetch(requestUrl, {
				method: request.method,
				headers: {
					...request.headers,
					"content-type": "application/json",
				},
				body: JSON.stringify(request.body),
			});
			if (!response.ok) {
				throw new Error(`Browser request failed with status ${response.status}`);
			}
			return response.json() as Promise<T>;
		},
		{ requestUrl: url, request: input },
	);
}

async function installHttpsShipletProxy(
	context: BrowserContext,
	observe: (input: {
		requestUrl: URL;
		response: APIResponse;
	}) => void | Promise<void>,
) {
	const pausedRedirects = new Map<string, string>();
	await context.route(/^https:\/\/[^/]+\.shiplet\.test(?:\/|$)/, async (route) => {
		const requestUrl = new URL(route.request().url());
		const localUrl = new URL(route.request().url());
		localUrl.hostname = "127.0.0.1";
		localUrl.port = String(workerPort);
		const response = await route.fetch({
			url: localUrl.toString(),
			headers: {
				...route.request().headers(),
				host: requestUrl.host,
			},
			maxRedirects: 0,
		});
		await observe({ requestUrl, response });

		const responseHeaders = response.headers();
		const redirectLocation = responseHeaders.location;
		const pauseRedirect =
			Boolean(redirectLocation) &&
			(requestUrl.pathname === "/auth/callback" ||
				requestUrl.pathname.endsWith("/access") ||
				requestUrl.searchParams.has(capabilityQueryName) ||
				(requestUrl.hostname.startsWith("sibling-") &&
					requestUrl.pathname === "/"));
		if (redirectLocation && pauseRedirect) {
			pausedRedirects.set(
				`${requestUrl.hostname}${requestUrl.pathname}`,
				new URL(redirectLocation, requestUrl).toString(),
			);
			delete responseHeaders.location;
			delete responseHeaders["content-length"];
			await route.fulfill({
				status: 200,
				headers: responseHeaders,
				contentType: "text/html",
				body: "<!doctype html><title>Continuing trusted redirect</title>",
			});
			return;
		}
		await route.fulfill({
			status: response.status(),
			headers: responseHeaders,
			body: await response.body(),
		});
	});

	return {
		takeRedirect(hostname: string, pathname: string) {
			const key = `${hostname}${pathname}`;
			const location = pausedRedirects.get(key);
			if (!location) {
				throw new Error(`Expected trusted redirect for ${key}`);
			}
			pausedRedirects.delete(key);
			return location;
		},
	};
}

function waitForWrangler(process: ChildProcessWithoutNullStreams) {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => finish(new Error("Wrangler start timed out")), 30_000);
		const onData = (chunk: Buffer) => {
			if (chunk.toString().includes(`Ready on https://localhost:${workerPort}`)) {
				finish();
			}
		};
		const onExit = () => finish(new Error("Wrangler exited before becoming ready"));
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			process.stdout.off("data", onData);
			process.stderr.off("data", onData);
			process.off("exit", onExit);
			error ? reject(error) : resolve();
		};
		process.stdout.on("data", onData);
		process.stderr.on("data", onData);
		process.once("exit", onExit);
	});
}
