import { expect, test } from "@playwright/test";

import {
	collectPageErrors,
	expectNoPageErrors,
	largePngBuffer,
	loginAs,
	testUser,
	tinyPngBuffer,
} from "./helpers";

test.describe("account avatar", () => {
	test("lets users upload, crop, and save a custom avatar", async ({ page }) => {
		const user = testUser("avatar");
		const errors = collectPageErrors(page);
		await loginAs(page, user);

		await page.goto("/account", { waitUntil: "networkidle" });
		await expect(page.locator("#avatarPresetGrid .avatar-choice")).toHaveCount(12);
		await expect(page.locator("#avatarCropPanel")).toBeHidden();

		await page.locator("#avatarUpload").setInputFiles({
			name: "avatar.png",
			mimeType: "image/png",
			buffer: tinyPngBuffer(),
		});
		await expect(page.locator("#avatarCropPanel")).toBeVisible();
		await expect(page.locator("#avatarCropCanvas")).toBeVisible();
		await page.locator("#avatarCropZoom").evaluate((input) => {
			const range = input as HTMLInputElement;
			range.value = "1.5";
			range.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/me/avatar") &&
					response.request().method() === "POST" &&
					response.status() === 200,
			),
			page.getByRole("button", { name: "Save Avatar" }).click(),
		]);

		await expect(page.locator("#avatarCropPanel")).toBeHidden();
		await expect(
			page.locator("#profileAvatarPreview img.shiplet-avatar-img"),
		).toBeVisible();
		await expect(
			page.locator(".shiplet-header-avatar img.shiplet-avatar-img"),
		).toBeVisible();
		await expectNoPageErrors(errors);
	});

	test.describe("large avatar stress", () => {
		test.skip(
			true,
			"The multi-megabyte upload path runs in its separately budgeted stress gate.",
		);

		test("accepts a multi-megabyte avatar and saves the optimized crop", async ({
			page,
		}) => {
			const user = testUser("large-avatar");
			const errors = collectPageErrors(page);
			const avatar = largePngBuffer();
			expect(avatar.byteLength).toBeGreaterThan(4 * 1024 * 1024);
			expect(avatar.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
			await loginAs(page, user);

			await page.goto("/account", { waitUntil: "networkidle" });
			await page.locator("#avatarUpload").setInputFiles({
				name: "large-avatar.png",
				mimeType: "image/png",
				buffer: avatar,
			});
			await expect(page.locator("#avatarCropPanel")).toBeVisible();
			await expect(page.locator("#avatarCropCanvas")).toBeVisible();
			await page.locator("#avatarCropZoom").evaluate((input) => {
				const range = input as HTMLInputElement;
				range.value = "1.6";
				range.dispatchEvent(new Event("input", { bubbles: true }));
			});

			await Promise.all([
				page.waitForResponse(
					(response) =>
						response.url().includes("/api/me/avatar") &&
						response.request().method() === "POST" &&
						response.status() === 200,
				),
				page.getByRole("button", { name: "Save Avatar" }).click(),
			]);

			await expect(page.locator("#avatarCropPanel")).toBeHidden();
			await expect(
				page.locator("#profileAvatarPreview img.shiplet-avatar-img"),
			).toBeVisible();
			await expect(
				page.locator(".shiplet-header-avatar img.shiplet-avatar-img"),
			).toBeVisible();
			await expectNoPageErrors(errors);
		});
	});
});
