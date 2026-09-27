import { expect, test } from "@playwright/test";

test("the docked boat keeps its mooring clear of cargo and attached throughout the tide", async ({ page }) => {
	await page.goto("/");
	await expect(page.locator("body")).toHaveClass(/scene-go/);
	const measurements = await page.locator(".harbor-scene-svg").evaluate((scene) => {
		const rope = scene.querySelector<SVGPathElement>(".scene-mooring-taut")!;
		const cargo = scene.querySelector<SVGGraphicsElement>(".scene-cargo-harbor")!;
		const boat = scene.querySelector<SVGGraphicsElement>(".scene-boat-float")!;
		const point = (element: SVGGraphicsElement, x: number, y: number) =>
			new DOMPoint(x, y).matrixTransform(element.getScreenCTM()!);
		const animations = scene.getAnimations({ subtree: true });
		return [3400, 5300, 7200, 9100, 11000].map((time) => {
			animations.forEach((animation) => { animation.pause(); animation.currentTime = time; });
			const end = rope.getPointAtLength(rope.getTotalLength());
			const start = rope.getPointAtLength(0);
			const boatEnd = point(rope, end.x, end.y);
			const dockEnd = point(rope, start.x, start.y);
			const cleat = point(boat, 252, 121);
			const dock = point(scene as unknown as SVGGraphicsElement, 208, 140);
			return {
				cleatGap: Math.hypot(boatEnd.x - cleat.x, boatEnd.y - cleat.y),
				dockGap: Math.hypot(dockEnd.x - dock.x, dockEnd.y - dock.y),
				clearOfCargo: rope.getBoundingClientRect().right < cargo.getBoundingClientRect().left,
			};
		});
	});
	for (const frame of measurements) {
		expect(frame.clearOfCargo).toBe(true);
		expect(frame.cleatGap).toBeLessThan(1);
		expect(frame.dockGap).toBeLessThan(1);
	}
	await expect(page.getByRole("link", { name: "Prepare a review" })).toHaveAttribute("href", "/auth/login");
});

test("reduced motion immediately leaves a complete still harbor on desktop and mobile", async ({ page }) => {
	await page.goto("/");
	await page.emulateMedia({ reducedMotion: "reduce" });
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 850 });
		const scene = page.locator(".harbor-scene-svg");
		await expect(scene).toBeVisible();
		// Media emulation reaches the rendering pipeline asynchronously.
		await expect.poll(() => scene.evaluate((el) => el.getAnimations({ subtree: true }).length), { timeout: 1000 }).toBe(0);
		await expect(scene.locator(".scene-mooring-taut")).toHaveCSS("opacity", "1");
		await expect(scene.locator(".scene-boat-arrival")).toHaveCSS("transform", "none");
		await expect(page.getByRole("link", { name: "Prepare a review" })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
	}
});

test("without JavaScript the harbor retains continuous outlines and a visible vessel", async ({ browser, baseURL }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto(baseURL!);
	const scene = page.locator(".harbor-scene-svg");
	await expect(scene.locator(".scene-boat-hull")).toBeVisible();
	await expect(scene.locator(".scene-cloud-near")).toHaveCSS("stroke-dasharray", "none");
	await expect(scene.locator(".scene-mooring-taut")).toHaveCSS("opacity", "1");
	await expect(page.getByRole("link", { name: "Prepare a review" })).toBeVisible();
	await context.close();
});
