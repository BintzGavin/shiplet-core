// A person talks with an agent from the dashboard, through the hosted relay.
// The agent (an organization API key, as over Shiplet MCP) sees a person,
// labelled as one, and its reply appears on the page without a reload.
import { expect, test, type APIRequestContext } from "@playwright/test";

import { authHeaders, collectPageErrors, createOrganization, expectNoPageErrors, loginAs, testUser } from "./helpers";

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

test("a person joins the relay from the dashboard and talks with an agent", async ({ page, request }) => {
	test.setTimeout(90_000);
	const user = testUser("handshake-person");
	const errors = collectPageErrors(page);
	const organization = await createOrganization(request, user);
	const org = `/api/organizations/${organization.id}`;
	const keyResponse = await request.post(`${org}/api-tokens`, {
		headers: { ...authHeaders(user), "Content-Type": "application/json", Origin: "http://localhost:8787" },
		data: { name: "Builder on the studio Mac", scopes: ["mcp"], projectAccessMode: "all" },
	});
	expect(keyResponse.status(), await keyResponse.text()).toBe(201);
	const agentKey = { authorization: `Bearer ${((await keyResponse.json()) as { token: string }).token}` };
	const builder = (await relay(request, agentKey, "POST", `${org}/handshake-sessions`, { name: "builder", kind: "claude", app: "claude-cli", machine: "studio" })) as {
		session: string;
	};
	const agentInbox = `${org}/handshake-sessions/${builder.session}/inbox?wait=15`;

	await loginAs(page, user);
	await page.goto("/handshakes", { waitUntil: "networkidle" });
	const panel = page.locator(".handshake-talk");
	await expect(panel.getByRole("heading", { name: "Talk to an agent" })).toBeVisible();

	// Looking makes the person visible; the agent is listed by name and app.
	await panel.getByRole("button", { name: "See who is connected" }).click();
	await expect(panel.getByLabel("Message to builder")).toBeVisible();

	const heard = relay(request, agentKey, "GET", agentInbox);
	await panel.getByLabel("Message to builder").fill("The pay button still looks gray to me. Can you darken it?");
	await panel.getByRole("button", { name: "Send" }).click();
	const { messages } = (await heard) as { messages: Array<{ text: string; room: string; from: { kind: string; app: string; account: string } }> };
	expect(messages[0]).toMatchObject({ text: "The pay button still looks gray to me. Can you darken it?", from: { kind: "person", app: "shiplet-dashboard" } });
	const handshake = messages[0].room;
	const person = (messages[0] as unknown as { from: { id: string } }).from.id;

	// The agent answers; the reply shows up live.
	await relay(request, agentKey, "POST", `${org}/handshake-sessions/${builder.session}/messages`, { to: person, handshake, text: "Darkening it to 4.8:1 now." });
	await expect(panel.locator(".handshake-message").filter({ hasText: "Darkening it to 4.8:1 now." })).toBeVisible({ timeout: 25_000 });
	await expect(panel.locator(".handshake-message").first()).toContainText("You");

	// The handshake's own page: the person is in it, and the conversation carries on there.
	await panel.getByRole("link", { name: "Open this handshake" }).click();
	await expect(page).toHaveURL(new RegExp(`/handshakes/${handshake}$`));
	await expect(page.locator(".handshake-peers li").filter({ hasText: "Person" })).toContainText(/connected/);
	const talk = page.locator(".handshake-talk");
	await expect(talk.locator(".handshake-message")).toHaveCount(2);
	const heardAgain = relay(request, agentKey, "GET", agentInbox);
	await talk.getByLabel("Message to builder").fill("Thanks. Publish when it passes.");
	await talk.getByRole("button", { name: "Send" }).click();
	expect(((await heardAgain) as { messages: Array<{ text: string; room: string }> }).messages[0]).toMatchObject({ text: "Thanks. Publish when it passes.", room: handshake });
	await expect(talk.locator(".handshake-message")).toHaveCount(3);
	if (process.env.SHIPLET_E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.SHIPLET_E2E_SCREENSHOTS}/handshake-person.png`, fullPage: true });

	// Leaving takes the person off the relay.
	await talk.getByRole("button", { name: "Leave the relay" }).click();
	const peers = (await relay(request, agentKey, "GET", `${org}/handshake-sessions/${builder.session}/peers`)) as { peers: Array<{ kind: string }> };
	expect(peers.peers.map((peer) => peer.kind)).toEqual(["claude"]);

	await expectNoPageErrors(errors);
});
