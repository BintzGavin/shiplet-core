import { expect, test } from "@playwright/test";

import {
	collectPageErrors,
	expectNoPageErrors,
	loginAs,
	testUser,
} from "./helpers";

test.describe("account operator identity", () => {
	test("shows and copies the exact signed-in Shiplet user ID without presenting it as a credential", async ({
		context,
		page,
	}) => {
		const user = testUser("operator-identity");
		const errors = collectPageErrors(page);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await loginAs(page, user);

		await page.goto("/account", { waitUntil: "networkidle" });
		await expect(page.getByText("Shiplet user ID", { exact: true })).toBeVisible();
		await expect(page.locator("#shipletUserId")).toHaveText(user.id);
		await expect(page.locator("#shipletUserIdHelp")).toContainText(
			"public actor identifier",
		);
		await expect(page.locator("#shipletUserIdHelp")).toContainText(
			"OAuth and temporary-claim smoke checks",
		);
		await expect(page.locator("#shipletUserIdHelp")).toContainText(
			"not a credential",
		);

		const copyButton = page.locator("#copyShipletUserId");
		await expect(copyButton).toHaveAccessibleName("Copy Shiplet user ID");
		await expect(copyButton).toHaveAttribute(
			"aria-describedby",
			"shipletUserIdHelp",
		);
		await copyButton.focus();
		await expect(copyButton).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(copyButton).toHaveAttribute("aria-label", "Copied");
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(user.id);
		await expectNoPageErrors(errors);
	});
});
