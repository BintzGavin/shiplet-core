import { expect, test, type Locator, type Page } from "@playwright/test";

async function openHeader(page: Page, variant: "public" | "authenticated") {
	await page.goto(variant === "authenticated" ? "/auth/callback?code=test-code::header-motion%40example.test" : "/docs/quickstart");
	const header = page.getByRole("banner");
	await expect(header).toHaveAttribute("data-header-variant", variant);
	return header;
}
async function runningAnimations(header: Locator) {
	return header.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length);
}
async function waterShapes(header: Locator) {
	return header.locator(".shiplet-waterline-primary .shiplet-waterline-drawn").evaluateAll(elements => elements.map(element => element.getAttribute("d")));
}
async function expectStillWater(page: Page, header: Locator) {
	await expect(header).toHaveAttribute("data-header-motion", "paused");
	await expect.poll(() => runningAnimations(header), { timeout: 700 }).toBe(0);
	const shapes = await waterShapes(header);
	await page.waitForTimeout(180);
	expect(await waterShapes(header)).toEqual(shapes);
}

for (const variant of ["public", "authenticated"] as const) {
	test(`Given the ${variant} header, When it loads, Then there is no playback control and the only ship and navigation remain usable`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference" });
		const header = await openHeader(page, variant);
		await expect(header.getByRole("button", { name: /header animation/ })).toHaveCount(0);
		await expect(header.locator('[data-header-vessel="primary"]')).toHaveCount(1);
		await expect(header).toHaveAttribute("data-header-motion", "running");
		for (const actor of [".shiplet-mark-pennant", ".shiplet-wake-ring"]) {
			const node = header.locator(actor).first();
			const initial = await node.evaluate(element => getComputedStyle(element).transform);
			await expect.poll(() => node.evaluate(element => getComputedStyle(element).transform)).not.toBe(initial);
		}
		const navBefore = await header.getByRole("navigation").boundingBox();
		const homeBefore = await header.getByRole("link", { name: "Shiplet home" }).boundingBox();
		await page.waitForTimeout(800);
		expect(await header.getByRole("navigation").boundingBox()).toEqual(navBefore);
		expect(await header.getByRole("link", { name: "Shiplet home" }).boundingBox()).toEqual(homeBefore);
		expect((await header.boundingBox())!.height).toBeLessThanOrEqual(76);
		await header.getByRole("link", { name: "Docs", exact: true }).click();
		await expect(page).toHaveURL(/\/docs/);
	});

	test(`Given the ${variant} ship, When wakelets age, Then they trail left from the stern instead of spreading ahead of the bow`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference" });
		const header = await openHeader(page, variant);
		for (const width of [390, 1280]) {
			await page.setViewportSize({ width, height: 800 });
			await expect(header).toHaveAttribute("data-header-motion", "running");
			const vessel = await header.locator(".shiplet-mark-vessel").boundingBox();
			const wake = header.locator(".shiplet-wake-ring").first();
			const [early, late] = await wake.evaluate(element => {
				const animation = element.getAnimations()[0];
				animation.pause();
				const timing = animation.effect!.getTiming();
				return [0.25, 0.7].map(progress => {
					animation.currentTime = (timing.delay ?? 0) + Number(timing.duration) * progress;
					const bounds = element.getBoundingClientRect();
					return { center: bounds.x + bounds.width / 2, right: bounds.right };
				});
			});
			expect(early.right).toBeLessThanOrEqual(vessel!.x + 3);
			expect(late.center).toBeLessThan(early.center - 5);
		}
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expectStillWater(page, header);
		const vessel = await header.locator(".shiplet-mark-vessel").boundingBox();
		const wake = await header.locator(".shiplet-wake-ring").first().boundingBox();
		expect(wake!.x + wake!.width).toBeLessThanOrEqual(vessel!.x + 4);
	});

	test(`Given the ${variant} waterline, When swells pass, Then the surface changes shape with clearly visible rise and fall`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference" });
		const header = await openHeader(page, variant);
		const initial = await waterShapes(header);
		expect(initial).toHaveLength(3);
		await expect.poll(() => waterShapes(header)).not.toEqual(initial);
		const samples = await header.locator(".shiplet-waterline-near .shiplet-waterline-drawn").evaluate(async element => {
			const path = element as SVGPathElement;
			const values: number[] = [];
			for (let index = 0; index < 24; index++) {
				values.push(path.getPointAtLength(path.getTotalLength() * 0.47).y);
				await new Promise(resolve => setTimeout(resolve, 80));
			}
			return values;
		});
		expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(8);
		const vessel = header.locator(".shiplet-mark-vessel");
		const initialTransform = await vessel.evaluate(element => getComputedStyle(element).transform);
		await expect.poll(() => vessel.evaluate(element => getComputedStyle(element).transform)).not.toBe(initialTransform);
	});

	test(`Given the ${variant} header, When reduced motion changes or it leaves view, Then all motion stops with complete static artwork`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 360 });
		await page.emulateMedia({ reducedMotion: "reduce" });
		const header = await openHeader(page, variant);
		await expectStillWater(page, header);
		await expect(header.locator(".shiplet-mark-vessel")).toBeVisible();
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await expect(header).toHaveAttribute("data-header-motion", "running");
		await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		await expectStillWater(page, header);
		await page.evaluate(() => window.scrollTo(0, 0));
		await expect(header).toHaveAttribute("data-header-motion", "running");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expectStillWater(page, header);
	});
}

test("Given responsive light and dark viewports, When waves deform, Then the water covers both edges and controls fit", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "authenticated");
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const width of [320, 390, 768, 1280, 1920]) {
			await page.setViewportSize({ width, height: 800 });
			await expect(header.getByRole("link", { name: "Shiplet home" })).toBeVisible();
			await expect(header.getByRole("link", { name: "Docs", exact: true })).toBeVisible();
			const bounds = await header.boundingBox();
			const navigation = await header.getByRole("navigation").boundingBox();
			expect(bounds!.width).toBeLessThanOrEqual(width);
			expect(navigation!.x + navigation!.width).toBeLessThanOrEqual(width - 16);
			if (width >= 768) {
				const home = await header.getByRole("link", { name: "Shiplet home" }).boundingBox();
				await expect.poll(async () => {
					const buoy = await header.locator(".shiplet-waterline-marker-buoy").boundingBox();
					return buoy!.x - (home!.x + home!.width);
				}).toBeGreaterThan(80);
			}
			for (let frame = 0; frame < 3; frame++) {
				const spans = await header.locator(".shiplet-waterline-primary .shiplet-waterline-drawn").evaluateAll(elements => elements.map(element => {
					const bounds = element.getBoundingClientRect();
					return { left: bounds.left, right: bounds.right };
				}));
				for (const span of spans) {
					expect(span.left).toBeLessThanOrEqual(0);
					expect(span.right).toBeGreaterThanOrEqual(width);
				}
				await page.waitForTimeout(80);
			}
		}
	}
});

test("Given no JavaScript, When the header renders, Then static water and navigation remain usable without playback controls", async ({ browser, baseURL }) => {
	const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
	const page = await context.newPage();
	const header = await openHeader(page, "public");
	await expect(header.locator(".shiplet-mark-vessel")).toBeVisible();
	await expect(header.getByRole("button", { name: /header animation/ })).toHaveCount(0);
	await expectStillWater(page, header);
	expect((await waterShapes(header)).every(shape => shape && shape.length > 100)).toBe(true);
	const vessel = await header.locator(".shiplet-mark-vessel").boundingBox();
	const wake = await header.locator(".shiplet-wake-ring").first().boundingBox();
	expect(wake!.x + wake!.width).toBeLessThanOrEqual(vessel!.x + 4);
	await header.getByRole("link", { name: "Shiplet home" }).click();
	await expect(page).toHaveURL(`${baseURL}/`);
	await context.close();
});

test("Given a hidden or suspended page, When it returns, Then motion resumes only while visible and reduced motion is off", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "public");
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expectStillWater(page, header);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(header).toHaveAttribute("data-header-motion", "running");
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
	await expectStillWater(page, header);
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
	await expect(header).toHaveAttribute("data-header-motion", "running");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.evaluate(() => {
		window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
	});
	await expectStillWater(page, header);
});

test("Given legacy pause settings, When the header loads, Then removed controls cannot leave the waves stuck still", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("shiplet-header-motion", "paused"));
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "public");
	await expect(header).toHaveAttribute("data-header-motion", "running");
	await expect(header.getByRole("button", { name: /header animation/ })).toHaveCount(0);
});
test("Given blocked storage, When the header loads, Then its animation runs without script errors", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.name));
	await page.addInitScript(() => {
		Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
		Storage.prototype.setItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
	});
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const header = await openHeader(page, "public");
	await expect(header).toHaveAttribute("data-header-motion", "running");
	await expect(header.getByRole("button", { name: /header animation/ })).toHaveCount(0);
	expect(errors).toEqual([]);
});
