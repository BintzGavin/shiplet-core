import { expect, test, type Locator, type Page } from "@playwright/test";

async function openHeader(page: Page, variant: "public" | "authenticated") {
	if (variant === "authenticated") {
		await page.goto("/auth/callback?code=test-code::header-motion%40example.test");
	} else {
		await page.goto("/docs/quickstart");
	}
	const header = page.getByRole("banner");
	await expect(header).toHaveAttribute("data-header-variant", variant);
	return header;
}

async function runningAnimations(header: Locator) {
	return header.evaluate((element) =>
		element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length,
	);
}

for (const variant of ["public", "authenticated"] as const) {
	test(`Given the ${variant} header, When motion is allowed, Then the only ship, pennant, water and trailing wake move without moving navigation`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference" });
		const header = await openHeader(page, variant);
		await expect(header.locator('[data-header-vessel="primary"]')).toHaveCount(1);
		await expect(header).toHaveAttribute("data-header-motion", "running");
		for (const actor of [".shiplet-mark-vessel", ".shiplet-mark-pennant", ".shiplet-waterline-near", ".shiplet-wake-ring"]) {
			const node = header.locator(actor).first();
			await expect.poll(() => node.evaluate((element) => element.getAnimations().some((animation) => animation.playState === "running"))).toBe(true);
			const initial = await node.evaluate((element) => getComputedStyle(element).transform);
			await expect.poll(() => node.evaluate((element) => getComputedStyle(element).transform)).not.toBe(initial);
		}
		const navBefore = await header.getByRole("navigation").boundingBox();
		const homeBefore = await header.getByRole("link", { name: "Shiplet home" }).boundingBox();
		// Sample a whole swell cycle without requiring a slow, timing-sensitive test.
		for (const time of [0, 800, 1600, 2400, 3200, 4800, 6400]) {
			await header.evaluate((element, currentTime) => {
				element.getAnimations({ subtree: true }).forEach((animation) => {
					animation.pause();
					animation.currentTime = currentTime;
				});
			}, time);
			expect(await header.getByRole("navigation").boundingBox()).toEqual(navBefore);
			expect(await header.getByRole("link", { name: "Shiplet home" }).boundingBox()).toEqual(homeBefore);
			expect((await header.boundingBox())!.height).toBeLessThanOrEqual(76);
		}
		await header.getByRole("link", { name: "Docs", exact: true }).click();
		await expect(page).toHaveURL(/\/docs/);
	});

	test(`Given the ${variant} header, When the reviewer pauses motion, Then every ambient layer stops and the choice survives navigation`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference" });
		let header = await openHeader(page, variant);
		await header.getByRole("button", { name: "Pause header animation" }).focus();
		await page.keyboard.press("Space");
		await expect(header).toHaveAttribute("data-header-motion", "paused");
		await expect(header.getByRole("button", { name: "Resume header animation" })).toHaveAttribute("aria-pressed", "true");
		await expect.poll(() => runningAnimations(header)).toBe(0);
		await page.reload();
		header = page.getByRole("banner");
		await expect(header).toHaveAttribute("data-header-motion", "paused");
		expect(await runningAnimations(header)).toBe(0);
		await header.getByRole("button", { name: "Resume header animation" }).click();
		await expect(header).toHaveAttribute("data-header-motion", "running");
		await expect.poll(() => runningAnimations(header)).toBeGreaterThan(5);
	});

	test(`Given the ${variant} header, When reduced motion changes or the header leaves view, Then ambience stops without hiding the artwork`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 360 });
		await page.emulateMedia({ reducedMotion: "reduce" });
		const header = await openHeader(page, variant);
		expect(await runningAnimations(header)).toBe(0);
		await expect(header.getByRole("button", { name: /header animation/ })).toBeHidden();
		await expect(header.locator(".shiplet-mark-vessel")).toBeVisible();
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await expect(header).toHaveAttribute("data-header-motion", "running");
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await expect(header).toHaveAttribute("data-header-motion", "paused");
		expect(await runningAnimations(header)).toBe(0);
		await page.evaluate(() => window.scrollTo(0, 0));
		await expect(header).toHaveAttribute("data-header-motion", "running");
	});
}

test("Given light and dark narrow viewports, When the header is animated, Then controls fit and the traveling waves cover the entire waterline throughout their cycle", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "authenticated");
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 390, 768, 1280]) {
			await page.setViewportSize({ width, height: 800 });
			await expect(header.getByRole("link", { name: "Shiplet home" })).toBeVisible();
			await expect(header.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
			// The header owns its own layout; unrelated publish-form overflow must
			// not be mistaken for a wave or navigation regression.
			const bounds = await header.boundingBox();
			const navigation = await header.getByRole("navigation").boundingBox();
			expect(bounds!.width).toBeLessThanOrEqual(width);
			expect(navigation!.x + navigation!.width).toBeLessThanOrEqual(width - 16);
			for (const progress of [0, 0.25, 0.5, 0.75, 0.999]) {
				const spans = await header.locator(".shiplet-waterline-primary.shiplet-waterline-wave").evaluateAll((elements, phase) => elements.map((element) => {
					const animation = element.getAnimations()[0];
					if (!animation) return { left: Infinity, right: -Infinity };
					animation.pause();
					const timing = animation.effect!.getTiming();
					animation.currentTime = Number(timing.duration) * phase + (timing.delay ?? 0);
					const bounds = element.getBoundingClientRect();
					return { left: bounds.left, right: bounds.right };
				}), progress);
				for (const span of spans) {
					expect(span.left).toBeLessThanOrEqual(0);
					expect(span.right).toBeGreaterThanOrEqual(width);
				}
			}
		}
	}
});

test("Given JavaScript is unavailable, When the public header renders, Then the complete static mark and navigation remain usable", async ({ browser, baseURL }) => {
	const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
	const page = await context.newPage();
	const header = await openHeader(page, "public");
	await expect(header.locator(".shiplet-mark-vessel")).toBeVisible();
	await expect(header.getByRole("button", { name: /header animation/ })).toBeHidden();
	expect(await runningAnimations(header)).toBe(0);
	await header.getByRole("link", { name: "Shiplet home" }).click();
	await expect(page).toHaveURL(`${baseURL}/`);
	await context.close();
});

test("Given a hidden tab or a suspended page, When the page returns, Then motion resumes only if the reviewer has not paused it", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "public");
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(header).toHaveAttribute("data-header-motion", "paused");
	expect(await runningAnimations(header)).toBe(0);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(header).toHaveAttribute("data-header-motion", "running");
	await header.getByRole("button", { name: "Pause header animation" }).click();
	await page.evaluate(() => {
		window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
	});
	await expect(header).toHaveAttribute("data-header-motion", "paused");
	await expect.poll(() => runningAnimations(header)).toBe(0);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await expect(header).toHaveAttribute("data-header-motion", "paused");
});

test("Given browser storage is blocked, When the reviewer pauses and resumes, Then the controls still work without script errors", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.name));
	await page.addInitScript(() => {
		Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
		Storage.prototype.setItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
	});
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "public");
	await header.getByRole("button", { name: "Pause header animation" }).click();
	await expect(header).toHaveAttribute("data-header-motion", "paused");
	await header.getByRole("button", { name: "Resume header animation" }).click();
	await expect(header).toHaveAttribute("data-header-motion", "running");
	expect(errors).toEqual([]);
});
