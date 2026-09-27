import { expect, test, type Page } from "@playwright/test";

async function openHeader(page: Page, variant: "public" | "authenticated" = "public") {
	await page.goto(variant === "authenticated" ? "/auth/callback?code=test-code::theme-switch%40example.test" : "/docs/quickstart");
	const header = page.getByRole("banner");
	await expect(header).toHaveAttribute("data-header-variant", variant);
	return { header, themeSwitch: header.getByRole("switch", { name: "Dark mode" }) };
}

/** Perceived lightness (0-1) of the page background, whatever color space the browser reports. */
async function pageLightness(page: Page) {
	return page.evaluate(() => {
		const color = getComputedStyle(document.body).backgroundColor;
		const oklch = color.match(/oklch\(\s*([\d.]+)(%?)/);
		if (oklch) return Number(oklch[1]) / (oklch[2] ? 100 : 1);
		const [red, green, blue] = (color.match(/[\d.]+/g) || []).map(Number);
		return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
	});
}

async function expectHarbor(page: Page, theme: "light" | "dark") {
	const header = page.getByRole("banner");
	const [sky, hiddenSky, sea] = theme === "light" ? ["daylight", "storm", "calm"] : ["storm", "daylight", "storm"];
	await expect(header.locator(`[data-sky="${sky}"]`)).toBeVisible();
	await expect(header.locator(`[data-sky="${hiddenSky}"]`)).toBeHidden();
	await expect(header.locator(".shiplet-waterline-sea:visible")).toHaveAttribute("data-sea", sea);
	await expect(header.getByRole("switch", { name: "Dark mode" })).toHaveAttribute("aria-checked", String(theme === "dark"));
	await expect.poll(() => pageLightness(page)).toBeGreaterThan(theme === "light" ? 0.8 : 0);
	await expect.poll(() => pageLightness(page)).toBeLessThan(theme === "light" ? 1.01 : 0.35);
}

test("Given a first visit, When the system theme changes, Then the harbor and the switch follow it live", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
	await openHeader(page);
	await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
	await expectHarbor(page, "light");
	await page.emulateMedia({ colorScheme: "dark" });
	await expectHarbor(page, "dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expectHarbor(page, "light");
});

for (const variant of ["public", "authenticated"] as const) {
	test(`Given the ${variant} header, When a reader switches themes, Then the choice applies everywhere and survives reloads without a flash`, async ({ page }) => {
		await page.addInitScript(() => {
			// Record the theme at the moment the body first exists, before any styled paint.
			new MutationObserver((_, observer) => {
				if (!document.body) return;
				(window as unknown as { themeAtFirstBody: string | null }).themeAtFirstBody = document.documentElement.getAttribute("data-theme");
				observer.disconnect();
			}).observe(document, { childList: true, subtree: true });
		});
		await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
		const { themeSwitch } = await openHeader(page, variant);
		await expectHarbor(page, "light");
		await themeSwitch.click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
		await expectHarbor(page, "dark");
		await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");

		await page.reload();
		expect(await page.evaluate(() => (window as unknown as { themeAtFirstBody: string | null }).themeAtFirstBody)).toBe("dark");
		await expectHarbor(page, "dark");

		await page.getByRole("banner").getByRole("switch", { name: "Dark mode" }).click();
		await expectHarbor(page, "light");
		await page.reload();
		expect(await page.evaluate(() => (window as unknown as { themeAtFirstBody: string | null }).themeAtFirstBody)).toBe("light");
		await expectHarbor(page, "light");
	});
}

/** Height of the visible near swell from trough to crest, sampled along the whole surface. */
async function nearSwellHeight(page: Page) {
	return page.getByRole("banner").locator(".shiplet-waterline-sea:visible .shiplet-waterline-near .shiplet-waterline-drawn").evaluate(element => {
		const path = element as SVGPathElement;
		const length = path.getTotalLength();
		const heights = Array.from({ length: 200 }, (_, index) => path.getPointAtLength(length * index / 199).y);
		return Math.max(...heights) - Math.min(...heights);
	});
}

test("Given either harbor, When the reader switches themes, Then the sea eases into the other state and the skies cross over instead of snapping", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
	const { header, themeSwitch } = await openHeader(page);
	await expect(header).toHaveAttribute("data-header-motion", "running");
	for (const [leaving, arriving] of [["storm", "daylight"], ["daylight", "storm"]] as const) {
		const before = await nearSwellHeight(page);
		await themeSwitch.click();
		// Both skies show while one leaves and the other arrives.
		await expect(header.locator(`[data-sky="${arriving}"]`)).toBeVisible();
		expect(await header.locator(`[data-sky="${leaving}"]`).isVisible()).toBe(true);
		const samples: number[] = [];
		for (let index = 0; index < 34; index++) {
			samples.push(await nearSwellHeight(page));
			await page.waitForTimeout(100);
		}
		const after = samples.at(-1)!;
		const low = Math.min(before, after);
		const range = Math.abs(before - after);
		expect(range).toBeGreaterThan(Math.max(before, after) * 0.35);
		const turning = samples.filter(height => low + range * 0.15 < height && height < low + range * 0.85);
		expect(turning.length).toBeGreaterThanOrEqual(5);
		for (let index = 1; index < samples.length; index++) expect(Math.abs(samples[index] - samples[index - 1])).toBeLessThan(range * 0.4);
		await expect(header.locator(`[data-sky="${leaving}"]`)).toBeHidden();
	}
});

test("Given keyboard use, When the switch is focused and toggled with Space or Enter, Then the theme flips each time", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
	const { themeSwitch } = await openHeader(page);
	await themeSwitch.focus();
	await page.keyboard.press("Space");
	// Reduced motion changes the weather at once: no cross-over, no easing.
	await expect(page.getByRole("banner").locator('[data-sky="daylight"]')).toBeHidden({ timeout: 200 });
	await expectHarbor(page, "dark");
	await page.keyboard.press("Enter");
	await expectHarbor(page, "light");
	await expect(themeSwitch).toBeFocused();
});

test("Given an explicit daylight choice, When the system turns dark, Then the reader's choice wins", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("shiplet-theme", "light"));
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "no-preference" });
	await openHeader(page);
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await expectHarbor(page, "light");
	await page.emulateMedia({ colorScheme: "light" });
	await page.emulateMedia({ colorScheme: "dark" });
	await expectHarbor(page, "light");
});

test("Given another tab changes the theme, When its storage event arrives, Then this tab follows", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
	await openHeader(page);
	await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "shiplet-theme", newValue: "dark" })));
	await expectHarbor(page, "dark");
	await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "shiplet-theme", newValue: null })));
	await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
	await expectHarbor(page, "light");
});

test("Given blocked storage, When a reader switches themes, Then the page still changes without script errors", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.addInitScript(() => {
		Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
		Storage.prototype.setItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
	});
	await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
	const { themeSwitch } = await openHeader(page);
	await themeSwitch.click();
	await expectHarbor(page, "dark");
	expect(errors).toEqual([]);
});
