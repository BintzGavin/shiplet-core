import { expect, test } from "@playwright/test";

import {
	collectPageErrors,
	createOrganization,
	expectNoPageErrors,
	loginAs,
	testUser,
} from "./helpers";

test.use({ screenshot: "off", video: "off", trace: "off" });

test.describe("agent access", () => {
	test("creates an organization API token from the Agents page", async ({
		page,
		request,
	}) => {
		const user = testUser("agent-token");
		const errors = collectPageErrors(page);
		const organization = await createOrganization(request, user);
		await loginAs(page, user, { organizationId: organization.id });

		await page.goto("/agents", { waitUntil: "networkidle" });
		await page.locator("#organizationSelect").selectOption(organization.id);
		await expect(page.locator("#tokenProjectAccessMode")).toHaveValue(
			"selected",
		);
		await expect(page.locator('input[name="tokenScope"]:checked')).toHaveCount(
			0,
		);
		await page.locator("#tokenProjectAccessMode").selectOption("all");
		await page
			.locator('input[name="tokenScope"][value="shiplets:read"]')
			.check();
		const tokenName = `E2E Token ${Date.now()}`;
		await page.locator("#tokenName").fill(tokenName);

		const creationStatuses: number[] = [];
		page.on("response", (response) => {
			if (
				new URL(response.url()).pathname ===
					`/api/organizations/${encodeURIComponent(organization.id)}/api-tokens` &&
				response.request().method() === "POST"
			) {
				creationStatuses.push(response.status());
			}
		});
		await page.getByRole("button", { name: "Create Key" }).click();
		await expect
			.poll(() => creationStatuses, { timeout: 3_000 })
			.toEqual([201]);

		await expect(page.locator("#tokenResult strong")).toHaveText(
			"Copy this token now.",
		);
		await expect(page.locator("#tokenList")).toContainText(tokenName);
		await expect(page.locator("#tokenList")).toContainText("Active");
		await expectNoPageErrors(errors);
	});
});
