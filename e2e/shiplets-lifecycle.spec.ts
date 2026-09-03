import { expect, test } from "@playwright/test";

import {
	collectPageErrors,
	createOrganization,
	expectNoPageErrors,
	loginAs,
	publishStaticShiplet,
	testUser,
} from "./helpers";

test.describe("publish and shiplets lifecycle", () => {
	test("publishes an uploaded shiplet and lists it on the shiplets page", async ({
		page,
		request,
	}) => {
		const user = testUser("publish");
		const errors = collectPageErrors(page);
		await createOrganization(request, user);
		await loginAs(page, user);

		const name = `E2E Uploaded ${Date.now()}`;
		const subdomain = `e2e-uploaded-${Math.random().toString(16).slice(2, 8)}`;
		await page.goto("/", { waitUntil: "networkidle" });
		await page.setInputFiles("#fileInput", {
			name: "index.html",
			mimeType: "text/html",
			buffer: Buffer.from(`<!doctype html><h1>${name}</h1>`),
		});
		await page.locator("#projectName").fill(name);
		await page.locator("#subdomain").fill(subdomain);
		await page.locator("#visibility").selectOption("organization");

		await Promise.all([
			page.waitForURL(/\/shiplets\/project_[^/]+(?:\?created=1)?$/),
			page.getByRole("button", { name: "Create shiplet" }).click(),
		]);
		await expect(
			page.getByRole("heading", { name: "Shiplet ready" }),
		).toBeVisible();
		await expect(page.locator(".shiplet-detail-hero")).toContainText(name);
		await expect(page.locator("#artifactPreviewFrame")).toBeVisible();

		await page.goto("/shiplets", { waitUntil: "networkidle" });
		await expect(page.getByRole("link", { name })).toBeVisible();
		await expect(page.getByText(`/${subdomain}`)).toBeVisible();
		await expectNoPageErrors(errors);
	});

	test("archives selected shiplets in place and restores archived shiplets", async ({
		page,
		request,
	}) => {
		const user = testUser("shiplets-lifecycle");
		const errors = collectPageErrors(page);
		const organization = await createOrganization(request, user);
		const first = await publishStaticShiplet(request, user, organization.id, {
			name: `Bulk One ${Date.now()}`,
		});
		const second = await publishStaticShiplet(request, user, organization.id, {
			name: `Bulk Two ${Date.now()}`,
		});
		await loginAs(page, user);

		await page.goto("/shiplets", { waitUntil: "networkidle" });
		await expect(page.locator("#shipletBulkSelectionCount")).toHaveText(
			"0 selected",
		);
		await page.locator(`[data-shiplet-select="${first.project.id}"]`).check();
		await expect(page.locator("#shipletBulkSelectionCount")).toHaveText(
			"1 selected",
		);
		await expect(page.locator("[data-bulk-archive]")).toBeEnabled();
		await page.locator(`[data-shiplet-select="${second.project.id}"]`).check();
		await expect(page.locator("#shipletBulkSelectionCount")).toHaveText(
			"2 selected",
		);

		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/projects/archive") &&
					response.status() === 200,
			),
			page.locator("[data-bulk-archive]").click(),
		]);
		await expect(page.locator("#shipletBulkSelectionCount")).toHaveText(
			"0 selected",
		);
		await expect(page.locator("[data-bulk-archive]")).toBeDisabled();
		await expect(
			page.locator(`[data-shiplet-select="${first.project.id}"]`),
		).toHaveCount(0);
		await expect(page.locator("#archivedShipletsSummary")).toContainText(
			"Archived shiplets (2)",
		);

		await page.locator("#archivedShipletsSummary").click();
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes(`/api/projects/${first.project.id}/restore`) &&
					response.status() === 200,
			),
			page
				.locator(`[data-restore-shiplet="${first.project.id}"]`)
				.click(),
		]);
		await expect(page.getByRole("link", { name: first.project.name })).toBeVisible();
		await expect(page.locator("#archivedShipletsSummary")).toContainText(
			"Archived shiplets (1)",
		);
		await expectNoPageErrors(errors);
	});
});
