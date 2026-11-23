// A person reviewing a Shiplet talks with an agent from the review page and
// from the signed-in website widget. The agent (an organization API key, as
// over Shiplet MCP) sees a person, labelled as one, with the review context in
// the message; its reply appears in the Agents panel without a reload.
import { createServer } from "node:http";
import { expect, test, type APIRequestContext } from "@playwright/test";

import {
	authHeaders,
	collectPageErrors,
	createOrganization,
	crossSiteFrameInputLaunchOptions,
	expectNoPageErrors,
	loginAs,
	publishStaticShiplet,
	testUser,
	type E2EUser,
} from "./helpers";

// The website widget's test types into a cross-site frame.
test.use({ launchOptions: crossSiteFrameInputLaunchOptions });

type RelayMessage = { text: string; room: string; from: { id: string; kind: string; app: string } };

async function relay(request: APIRequestContext, headers: Record<string, string>, method: "GET" | "POST", url: string, data?: unknown) {
	const response = await request.fetch(url, {
		method,
		headers: { ...headers, "Content-Type": "application/json" },
		...(data === undefined ? {} : { data }),
		timeout: 30_000,
	});
	expect(response.ok(), `${method} ${url}: ${await response.text()}`).toBe(true);
	return response.json();
}

// An agent in the organization, joined with an organization API key.
async function joinAgent(request: APIRequestContext, user: E2EUser, organizationId: string) {
	const org = `/api/organizations/${organizationId}`;
	const keyResponse = await request.post(`${org}/api-tokens`, {
		headers: { ...authHeaders(user), "Content-Type": "application/json", Origin: "http://localhost:8787" },
		data: { name: "Builder on the studio Mac", scopes: ["mcp"], projectAccessMode: "all" },
	});
	expect(keyResponse.status(), await keyResponse.text()).toBe(201);
	const key = { authorization: `Bearer ${((await keyResponse.json()) as { token: string }).token}` };
	const opened = (await relay(request, key, "POST", `${org}/handshake-sessions`, { name: "builder", kind: "claude", app: "claude-cli", machine: "studio" })) as { session: string };
	return {
		key,
		inbox: `${org}/handshake-sessions/${opened.session}/inbox?wait=15`,
		messages: `${org}/handshake-sessions/${opened.session}/messages`,
	};
}

test("a reviewer asks an agent from the review page, with the review context, and reads the reply", async ({ page, request }) => {
	test.setTimeout(90_000);
	const user = testUser("handshake-review");
	const errors = collectPageErrors(page);
	const organization = await createOrganization(request, user);
	const published = await publishStaticShiplet(request, user, organization.id, {
		html: "<!doctype html><title>Checkout</title><h1>Checkout</h1><button>Pay</button>",
	});
	const agent = await joinAgent(request, user, organization.id);

	// The dashboard's "Open review page" for the Shiplet.
	await loginAs(page, user);
	await page.goto(`/shiplets/${published.project.id}`, { waitUntil: "domcontentloaded" });
	const reviewPage = page.getByRole("link", { name: "Open review page" });
	await expect(reviewPage).toHaveAttribute("href", `/shiplets/${published.project.id}/review-host`);
	await page.goto(`/shiplets/${published.project.id}/review-host`, { waitUntil: "domcontentloaded" });
	const host = page;
	await host.getByRole("button", { name: "Agents", exact: true }).click();
	const panel = host.locator("[data-shiplet-agents]");
	await expect(panel).toBeVisible();
	await expect(panel).toContainText("You join as yourself, labelled as a person.");

	await panel.getByRole("button", { name: "See who is connected" }).click();
	await expect(panel.getByLabel("To", { exact: true })).toContainText("builder · Claude Code on studio");

	const heard = relay(request, agent.key, "GET", agent.inbox);
	await panel.getByLabel("Message", { exact: true }).fill("The Pay button looks gray to me. Can you darken it?");
	await panel.getByRole("button", { name: "Send", exact: true }).click();
	const { messages } = (await heard) as { messages: RelayMessage[] };
	expect(messages[0].from).toMatchObject({ kind: "person", app: "shiplet-review" });
	const [words, context] = messages[0].text.split("\n\n");
	expect(words).toBe("The Pay button looks gray to me. Can you darken it?");
	expect(context).toMatch(new RegExp(`^\\[Shiplet review context\\]\\nshiplet: ${published.project.id}\\nversion: \\S+\\npage: \\S+$`));
	await expect(panel.locator(".shiplet-review-agents-line")).toHaveCount(1);
	await expect(panel.locator(".shiplet-review-agents-line").first()).toContainText("The Pay button looks gray to me. Can you darken it?");
	await expect(panel.locator(".shiplet-review-agents-line").first()).not.toContainText("[Shiplet review context]");

	// The agent answers; the reply shows up live.
	await relay(request, agent.key, "POST", agent.messages, { to: messages[0].from.id, handshake: messages[0].room, text: "Darkening it to 4.8:1 now." });
	await expect(panel.locator(".shiplet-review-agents-line").filter({ hasText: "Darkening it to 4.8:1 now." })).toBeVisible({ timeout: 25_000 });

	// Escape closes the panel and returns focus to the launcher.
	await panel.getByLabel("Message", { exact: true }).press("Escape");
	await expect(panel).toBeHidden();
	await expect(host.getByRole("button", { name: "Agents", exact: true })).toBeFocused();
	if (process.env.SHIPLET_E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.SHIPLET_E2E_SCREENSHOTS}/handshake-review.png`, fullPage: true });
	await expectNoPageErrors(errors);
});

test.describe("from the website widget", () => {
	test("a signed-in member asks an agent from the widget on their own site", async ({ page, request }) => {
		test.setTimeout(120_000);
		const user = testUser("handshake-widget");
		const organization = await createOrganization(request, user);
		const published = await publishStaticShiplet(request, user, organization.id);
		const agent = await joinAgent(request, user, organization.id);
		await loginAs(page, user);
		await page.goto(`/embed/install?project_id=${published.project.id}`);
		await page.getByLabel("Site URL").fill("http://127.0.0.1:8798");
		await page.getByRole("button", { name: "Create install snippet" }).click();
		const snippet = await page.getByLabel("Install snippet").inputValue();
		const server = createServer((_request, response) => {
			response.setHeader("Content-Type", "text/html");
			response.end(`<!doctype html><html><body><main><h1>Pricing</h1><p>Plans for every team.</p></main>${snippet}</body></html>`);
		});
		await new Promise<void>((resolve) => server.listen(8798, "127.0.0.1", resolve));
		try {
			await page.goto("http://127.0.0.1:8798/pricing");
			const widget = page.locator("shiplet-feedback");
			const frame = widget.locator("iframe").contentFrame();
			// Annotate signs the widget in (reusing the Shiplet login), then starts selecting.
			const signIn = frame.getByRole("button", { name: "Open secure Shiplet sign-in" });
			const cancelSelecting = frame.getByRole("button", { name: "Cancel annotation mode" });
			const reused = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null);
			await frame.getByRole("button", { name: /^Annotate/ }).click();
			await expect(cancelSelecting.or(signIn)).toBeVisible({ timeout: 20_000 });
			if (await signIn.isVisible()) {
				const popup = page.waitForEvent("popup");
				await signIn.click();
				const opened = await popup;
				await expect(cancelSelecting).toBeVisible({ timeout: 20_000 });
				if (!opened.isClosed()) await opened.close();
			}
			const reusedPopup = await reused;
			if (reusedPopup && !reusedPopup.isClosed()) await reusedPopup.close();
			await cancelSelecting.click();

			await frame.getByRole("button", { name: "Agents", exact: true }).click();
			const panel = frame.locator("[data-shiplet-agents]");
			await expect(panel).toBeVisible();
			await expect(widget.locator(".surface")).toHaveAttribute("data-view", "agents");
			await panel.getByRole("button", { name: "See who is connected" }).click();
			await expect(panel.getByLabel("To", { exact: true })).toContainText("builder");

			const heard = relay(request, agent.key, "GET", agent.inbox);
			await panel.getByLabel("Message", { exact: true }).fill("Is the pricing copy final?");
			await panel.getByRole("button", { name: "Send", exact: true }).click();
			const { messages } = (await heard) as { messages: RelayMessage[] };
			expect(messages[0].from).toMatchObject({ kind: "person", app: "shiplet-embed" });
			expect(messages[0].text).toContain("Is the pricing copy final?\n\n[Shiplet review context]\n");
			expect(messages[0].text).toContain("page: http://127.0.0.1:8798/pricing");

			await relay(request, agent.key, "POST", agent.messages, { to: messages[0].from.id, handshake: messages[0].room, text: "Not yet: legal is reviewing it." });
			await expect(panel.locator(".shiplet-review-agents-line").filter({ hasText: "Not yet: legal is reviewing it." })).toBeVisible({ timeout: 25_000 });
			await panel.getByRole("button", { name: "Close agents" }).click();
			await expect(widget.locator(".surface")).toHaveAttribute("data-view", "toolbar");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
