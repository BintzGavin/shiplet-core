import { expect, test } from "@playwright/test";

import {
	collectPageErrors,
	createOrganization,
	expectNoPageErrors,
	loginAs,
	testUser,
} from "./helpers";

test.use({ screenshot: "off", video: "off", trace: "off" });

test.describe("workspace invite links", () => {
	test("creates a limited link, lets someone join through it, and revokes it for everyone else", async ({
		browser,
		page,
		request,
	}) => {
		const admin = testUser("invite-admin");
		const joiner = testUser("invite-joiner");
		const late = testUser("invite-late");
		const adminErrors = collectPageErrors(page);
		const organization = await createOrganization(request, admin);
		const linksPath = `/api/organizations/${encodeURIComponent(organization.id)}/invite-links`;
		await loginAs(page, admin, { organizationId: organization.id });

		await page.goto("/workspace", { waitUntil: "networkidle" });
		const section = page.locator("#inviteLinks");
		await expect(section).toBeVisible();
		await expect(section).not.toContainText(/Loading/);
		await expect(section.locator("p.invite-links-empty")).toBeVisible();
		await expect(page.locator("#inviteLinkExpires")).toHaveValue("30");

		await page.locator("#inviteLinkUses").selectOption("5");
		const created = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname === linksPath,
		);
		await page.locator("#inviteLinkCreate").click();
		expect((await created).status()).toBe(201);

		const activeRow = section.locator('li.invite-link-row[data-status="active"]');
		await expect(activeRow).toHaveCount(1);
		const linkId = await activeRow.getAttribute("data-invite-link-id");
		expect(linkId).toBeTruthy();
		const row = section.locator(
			`li.invite-link-row[data-invite-link-id="${linkId}"]`,
		);
		const joinUrl = (
			(await row.locator("code.invite-link-url").textContent()) || ""
		).trim();
		expect(joinUrl).toMatch(/\/join\/[A-Za-z0-9_-]{32}$/);
		const joinPath = new URL(joinUrl).pathname;
		await expect(row.locator(".invite-link-meta")).toContainText("0 of 5 used");
		await expect(row.locator(".invite-link-meta")).toContainText("Expires");

		// Headless Chromium may refuse the clipboard; the label still confirms the copy.
		await row.locator("[data-invite-link-copy]").click();
		await expect(row.locator("[data-invite-link-copy]")).toHaveText("Copied");

		const joinerContext = await browser.newContext();
		const lateContext = await browser.newContext();
		try {
			const joinerPage = await joinerContext.newPage();
			const joinerErrors = collectPageErrors(joinerPage);
			await joinerPage.goto(joinPath, { waitUntil: "networkidle" });
			await expect(
				joinerPage.getByRole("heading", { name: `Join ${organization.name}` }),
			).toBeVisible();
			await expect(
				joinerPage.getByRole("link", { name: "Sign in to continue" }),
			).toBeVisible();

			await loginAs(joinerPage, joiner, { returnTo: joinPath });
			await expect(
				joinerPage.getByRole("heading", { name: `Join ${organization.name}` }),
			).toBeVisible();
			await joinerPage
				.getByRole("button", { name: "Accept invitation" })
				.click();
			await expect(
				joinerPage.getByRole("heading", { name: "You're in" }),
			).toBeVisible();

			await joinerPage.goto("/shiplets", { waitUntil: "networkidle" });
			await expect(joinerPage.locator(".app-page-topbar h1")).toContainText(
				"All shiplets",
			);

			await page.reload({ waitUntil: "networkidle" });
			await expect(row.locator(".invite-link-meta")).toContainText("1 of 5 used");
			const redemptions = row.locator("details.invite-link-redemptions");
			await expect(redemptions.locator("summary")).toContainText(
				"Who used it (1)",
			);
			await redemptions.locator("summary").click();
			await expect(redemptions.getByText(joiner.email)).toBeVisible();

			await row.locator("[data-invite-link-revoke]").click();
			const revoked = page.waitForResponse(
				(response) =>
					response.request().method() === "DELETE" &&
					new URL(response.url()).pathname ===
						`${linksPath}/${encodeURIComponent(linkId as string)}`,
			);
			await row.locator("[data-invite-link-revoke-confirm]").click();
			await expect(row).toHaveAttribute("data-status", "revoked");
			await expect(row.locator(".status-badge")).toHaveText("Revoked");
			expect((await revoked).status()).toBe(200);
			await expect(row).toHaveAttribute("data-status", "revoked");
			await expect(row.locator(".status-badge")).toHaveText("Revoked");

			await joinerPage.goto(joinPath, { waitUntil: "networkidle" });
			await expect(
				joinerPage.getByRole("heading", { name: "You're in" }),
			).toBeVisible();
			await expect(joinerPage.getByText("no longer active")).toHaveCount(0);

			const latePage = await lateContext.newPage();
			await latePage.goto(joinPath, { waitUntil: "networkidle" });
			await loginAs(latePage, late, { returnTo: joinPath });
			await expect(
				latePage.getByRole("heading", {
					name: "This invite link is no longer active",
				}),
			).toBeVisible();
			await expect(
				latePage.getByRole("button", { name: "Accept invitation" }),
			).toHaveCount(0);

			await expectNoPageErrors(adminErrors);
			await expectNoPageErrors(joinerErrors);
		} finally {
			await joinerContext.close();
			await lateContext.close();
		}
	});
});
