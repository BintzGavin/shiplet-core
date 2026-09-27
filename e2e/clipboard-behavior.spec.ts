import { expect, test } from "@playwright/test";

import { createOrganization, loginAs, publishStaticShiplet, testUser } from "./helpers";

test.use({ screenshot: "off", video: "off", trace: "off" });

test("copy controls write once, use absolute URLs, and report failed fallback honestly", async ({ page, request }) => {
	const user = testUser("clipboard");
	const organization = await createOrganization(request, user);
	await publishStaticShiplet(request, user, organization.id, { name: "Clipboard check" });
	await loginAs(page, user);
	await page.goto("/shiplets", { waitUntil: "networkidle" });
	const button = page.locator(".shiplet-list-actions button[data-copy-value]").first();
	await page.evaluate(() => {
		(window as any).clipboardWrites = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: (value: string) => { (window as any).clipboardWrites.push(value); return Promise.resolve(); } },
		});
	});
	await button.click();
	await expect(button).toHaveText("Copied");
	expect(await page.evaluate(() => (window as any).clipboardWrites)).toEqual([
		new URL(await button.getAttribute("data-copy-value") || "", page.url()).href,
	]);
	await expect(button).toHaveText("Copy URL");

	await page.evaluate(() => {
		(window as any).fallbackCalls = 0;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error("blocked")) },
		});
		document.execCommand = () => { (window as any).fallbackCalls++; return true; };
	});
	await button.click();
	await expect(button).toHaveText("Copied");
	expect(await page.evaluate(() => (window as any).fallbackCalls)).toBe(1);
	await expect(button).toHaveText("Copy URL");

	await page.evaluate(() => { document.execCommand = () => false; });
	await button.click();
	await expect(button).toHaveText("Copy failed. Try again");
	await expect(button).toHaveText("Copy URL");
	await page.evaluate(() => { document.execCommand = () => { throw new Error("blocked"); }; });
	await button.click();
	await expect(button).toHaveText("Copy failed. Try again");
});

test("shared copy handler restores the original accessible name after failure", async ({ page }) => {
	const user = testUser("clipboard-global");
	await loginAs(page, user);
	await page.goto("/account", { waitUntil: "networkidle" });
	const button = page.locator("#copyShipletUserId");
	await expect(button).toHaveAttribute("aria-label", "Copy Shiplet user ID");
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error("blocked")) },
		});
		document.execCommand = () => false;
	});
	await button.click();
	await expect(button).toHaveAttribute("aria-label", "Copy failed. Try again");
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.resolve() },
		});
	});
	await button.click();
	await expect(button).toHaveAttribute("aria-label", "Copied");
	await expect(button).toHaveAttribute("aria-label", "Copy Shiplet user ID");
});
