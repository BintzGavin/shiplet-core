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
/** Only the sea that matches the current theme is drawn; the other stays out of layout. */
function visibleSea(header: Locator) {
	return header.locator(".shiplet-waterline-sea:visible");
}
async function waterShapes(header: Locator) {
	return visibleSea(header).locator(".shiplet-waterline-drawn").evaluateAll(elements => elements.map(element => element.getAttribute("d")));
}
/** Swell count and height of one drawn surface, sampled along its whole length. */
async function swellProfile(surface: Locator) {
	return surface.evaluate(element => {
		const path = element as SVGPathElement;
		const length = path.getTotalLength();
		const heights = Array.from({ length: 400 }, (_, index) => path.getPointAtLength(length * index / 399).y);
		const level = heights.reduce((sum, height) => sum + height, 0) / heights.length;
		let swells = 0;
		for (let index = 1; index < heights.length; index++) {
			if (heights[index - 1] >= level && heights[index] < level) swells++;
		}
		return { swells, height: Math.max(...heights) - Math.min(...heights) };
	});
}
function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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

	test(`Given the ${variant} night-watch waterline, When swells pass, Then the surface changes shape with clearly visible rise and fall`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
		const header = await openHeader(page, variant);
		await expect(visibleSea(header)).toHaveAttribute("data-sea", "storm");
		const initial = await waterShapes(header);
		expect(initial).toHaveLength(3);
		await expect.poll(() => waterShapes(header)).not.toEqual(initial);
		const samples = await header.locator('[data-sea="storm"] .shiplet-waterline-near .shiplet-waterline-drawn').evaluate(async element => {
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

	test(`Given the ${variant} header in daylight, When the sea is compared with the night watch, Then its swells run longer and lower but keep moving`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
		const header = await openHeader(page, variant);
		const storm = await swellProfile(header.locator('[data-sea="storm"] .shiplet-waterline-near .shiplet-waterline-drawn'));
		await page.emulateMedia({ colorScheme: "light" });
		await expect(visibleSea(header)).toHaveAttribute("data-sea", "calm");
		const nearCalm = header.locator('[data-sea="calm"] .shiplet-waterline-near .shiplet-waterline-drawn');
		// The sea eases out of the storm over a couple of seconds before it settles.
		await expect.poll(async () => {
			const calm = await swellProfile(nearCalm);
			return calm.swells >= 1 && calm.swells * 2 <= storm.swells && calm.height < storm.height * 0.6;
		}, { timeout: 6000 }).toBe(true);
		const initial = await waterShapes(header);
		expect(initial).toHaveLength(3);
		await expect.poll(() => waterShapes(header)).not.toEqual(initial);
		const vessel = header.locator(".shiplet-mark-vessel");
		const initialTransform = await vessel.evaluate(element => getComputedStyle(element).transform);
		await expect.poll(() => vessel.evaluate(element => getComputedStyle(element).transform)).not.toBe(initialTransform);
	});

	test(`Given the ${variant} header, When daylight or the night watch is showing, Then only the matching sky is drawn and it stays clear of the controls`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
		const header = await openHeader(page, variant);
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			const [shown, hidden] = colorScheme === "light" ? ["daylight", "storm"] : ["storm", "daylight"];
			await expect(header.locator(`[data-sky="${shown}"]`)).toBeVisible();
			await expect(header.locator(`[data-sky="${hidden}"]`)).toBeHidden();
			await expect(header.locator(".shiplet-sky-sun")).toBeVisible({ visible: colorScheme === "light" });
			for (const width of [320, 390, 768, 1280, 1920]) {
				await page.setViewportSize({ width, height: 800 });
				const controls = [
					await header.getByRole("link", { name: "Shiplet home" }).boundingBox(),
					await header.getByRole("navigation").boundingBox(),
				];
				const bright = await header.locator(".shiplet-sky-sun:visible, .shiplet-sky-lightning:visible").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
				expect(bright.length).toBeGreaterThan(0);
				for (const box of bright) {
					for (const control of controls) expect(overlaps(box, control!)).toBe(false);
					expect(box.x).toBeGreaterThanOrEqual(0);
					expect(box.x + box.width).toBeLessThanOrEqual(width);
				}
			}
			await page.setViewportSize({ width: 1280, height: 800 });
		}
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
				await expect(visibleSea(header)).toHaveAttribute("data-sea", colorScheme === "light" ? "calm" : "storm");
				const spans = await visibleSea(header).locator(".shiplet-waterline-drawn").evaluateAll(elements => elements.map(element => {
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
	await expect(header.locator(".shiplet-theme-switch")).toBeHidden();
	await expect(header.locator('[data-sky="daylight"]')).toBeVisible();
	await expect(visibleSea(header)).toHaveAttribute("data-sea", "calm");
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(header.locator('[data-sky="storm"]')).toBeVisible();
	await expect(visibleSea(header)).toHaveAttribute("data-sea", "storm");
	await expect(header.locator(".shiplet-sky-lightning").first()).toHaveCSS("opacity", "0");
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

test("Given the night watch, When the storm runs, Then clouds drift and lightning never flickers three times in a second", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
	const header = await openHeader(page, "public");
	const storm = header.locator('[data-sky="storm"]');
	await expect(storm).toBeVisible();
	await expect(header).toHaveAttribute("data-header-motion", "running");
	const cloud = storm.locator(".shiplet-sky-storm-cloud").first();
	const cloudStart = await cloud.evaluate(element => getComputedStyle(element).transform);
	await expect.poll(() => cloud.evaluate(element => getComputedStyle(element).transform)).not.toBe(cloudStart);
	const strikes = await storm.evaluate(sky => Array.from(sky.querySelectorAll(".shiplet-sky-lightning, .shiplet-sky-flash")).flatMap(element => element.getAnimations().map(animation => {
		const effect = animation.effect as KeyframeEffect;
		const timing = effect.getComputedTiming();
		return {
			cycle: `${timing.duration}/${timing.delay}`,
			duration: Number(timing.duration),
			keyframes: effect.getKeyframes().map(frame => ({ offset: Number(frame.computedOffset), opacity: Number(frame.opacity) })),
		};
	})));
	expect(strikes.length).toBeGreaterThanOrEqual(2);
	// One shared cycle means separate bolts can never stack into a faster flicker.
	expect(new Set(strikes.map(strike => strike.cycle)).size).toBe(1);
	const duration = strikes[0].duration;
	const onsets: number[] = [];
	for (const strike of strikes) {
		strike.keyframes.forEach((frame, index) => {
			const previous = strike.keyframes[index - 1];
			if (!previous || frame.opacity - previous.opacity < 0.25) return;
			const time = frame.offset * duration;
			if (!onsets.some(onset => Math.abs(onset - time) < 40)) onsets.push(time);
		});
	}
	expect(onsets.length).toBeGreaterThanOrEqual(2);
	const looped = [...onsets, ...onsets.map(onset => onset + duration)].sort((a, b) => a - b);
	for (const onset of looped) expect(looped.filter(other => other >= onset && other < onset + 1000).length).toBeLessThan(3);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expectStillWater(page, header);
	for (const bolt of await storm.locator(".shiplet-sky-lightning").all()) await expect(bolt).toHaveCSS("opacity", "0");
});
