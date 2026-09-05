import { expect, test } from "@playwright/test";

import {
	collectPageErrors,
	createOrganization,
	expectNoPageErrors,
	loginAs,
	testUser,
} from "./helpers";

test.describe("authentication and dashboard navigation", () => {
	test("keeps navigation visible and decorative motion stopped on narrow screens with reduced motion", async ({ page, request }) => {
		const user = testUser("reduced-motion-nav");
		await createOrganization(request, user);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await loginAs(page, user);
		for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await page.goto("/", { waitUntil: "networkidle" });
			const header = page.getByRole("banner");
			await expect(header.getByRole("link", { name: "Shiplet home" })).toBeVisible();
			await expect(header.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
			await expect(page.getByRole("navigation", { name: "Platform" })).toBeVisible();
			expect(await header.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
		}
	});

	test("keeps protected app routes behind login while docs stays public", async ({
		request,
	}) => {
		for (const route of ["/shiplets", "/feedback", "/inbox", "/workspace"]) {
			const response = await request.get(route, { maxRedirects: 0 });
			expect(response.status()).toBe(302);
			expect(response.headers().location).toContain(
				`/auth/login?return_to=${encodeURIComponent(route)}`,
			);
		}

		const docs = await request.get("/docs");
		expect(docs.status()).toBe(200);
		expect(await docs.text()).toContain("Shiplet");
	});

	test("lets an authenticated user move through the primary dashboard routes", async ({
		page,
		request,
	}) => {
		const user = testUser("nav");
		const errors = collectPageErrors(page);
		await createOrganization(request, user);
		await loginAs(page, user);

		const routes = [
			{ path: "/", heading: "Create a shiplet", nav: "Prepare" },
			{ path: "/shiplets", heading: "All shiplets", nav: "Shiplets" },
			{ path: "/feedback", heading: "All feedback", nav: "Feedback" },
			{ path: "/inbox", heading: "Notifications", nav: "Inbox" },
			{ path: "/workspace", heading: "Workspace", nav: "Workspace" },
		];

		for (const route of routes) {
			await page.goto(route.path, { waitUntil: "networkidle" });
			await expect(page.locator(".app-page-topbar h1")).toContainText(
				route.heading,
			);
			await expect(
				page
					.getByRole("navigation", { name: "Platform" })
					.getByRole("link", { name: new RegExp(route.nav) }),
			).toHaveAttribute("data-current", "true");
		}

		await expectNoPageErrors(errors);
	});

	test("hides the publish workspace selector when there is only one workspace", async ({
		page,
		request,
	}) => {
		const user = testUser("single-workspace");
		const errors = collectPageErrors(page);
		await createOrganization(request, user);
		await loginAs(page, user);

		await page.goto("/", { waitUntil: "networkidle" });
		await expect(page.locator("#organizationSelectGroup")).toBeHidden();
		await expect(page.locator("#visibility")).toBeVisible();

		await expectNoPageErrors(errors);
	});
});
