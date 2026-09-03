import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

test.describe("sandbox playground", () => {
	test("captures artifact context from the trusted sandbox review host", async ({
		page,
	}) => {
		const sessionId = `sbx_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const sessionResponse = await page.goto(`/api/play/session?session=${sessionId}`);
		expect(sessionResponse?.ok()).toBe(true);
		const session = (await sessionResponse!.json()) as {
			shiplets: Array<{ id: string; previewUrl: string }>;
		};
		const project = session.shiplets[0];
		const comment = `Widget screenshot ${Date.now()}`;

		await page.goto(project.previewUrl, { waitUntil: "domcontentloaded" });
		await expect(page.locator("[data-shiplet-trusted-review-host='v1']")).toBeVisible();
		const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
		await page.getByRole("button", { name: /^Annotate / }).click();
		await artifact.getByRole("heading").first().click({
			position: { x: 10, y: 10 },
		});
		await expect(page.locator(".shiplet-review-target")).not.toContainText(
			"No element selected",
		);
		await page.locator("#shiplet-review-comment").fill(comment);
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes(
						`/api/projects/${encodeURIComponent(project.id)}/review-feedback`,
					) &&
					response.request().method() === "POST" &&
					response.ok(),
			),
			page.getByRole("button", { name: "Send annotation", exact: true }).click(),
		]);

		const refreshedResponse = await page.goto(`/api/play/session?session=${sessionId}`);
		expect(refreshedResponse?.ok()).toBe(true);
		const refreshed = (await refreshedResponse!.json()) as {
			feedback: Array<{ comment: string; screenshot_url: string | null }>;
		};
		const ticket = refreshed.feedback.find((item) => item.comment === comment);
		expect(ticket?.screenshot_url).toMatch(/^data:image\/png;base64,/);

		const screenshotStats = await page.evaluate(async (dataUrl) => {
			const image = await new Promise<HTMLImageElement>((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error("Screenshot image did not load."));
				img.src = dataUrl;
			});
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas context unavailable.");
			context.drawImage(image, 0, 0);
			const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
			let darkPixels = 0;
			for (let index = 0; index < pixels.length; index += 4) {
				if (pixels[index] < 140 && pixels[index + 1] < 140 && pixels[index + 2] < 140) {
					darkPixels += 1;
				}
			}
			return { width: canvas.width, height: canvas.height, darkPixels };
		}, ticket!.screenshot_url!);
		expect(screenshotStats.width).toBeGreaterThan(300);
		expect(screenshotStats.height).toBeGreaterThan(200);
		expect(screenshotStats.darkPixels).toBeGreaterThan(100);
	});

	test("keeps feedback screenshot and response metadata collapsed until expanded", async ({
		page,
	}) => {
		const sessionId = `sbx_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const sessionResponse = await page.goto(`/api/play/session?session=${sessionId}`);
		expect(sessionResponse?.ok()).toBe(true);
		const session = (await sessionResponse!.json()) as {
			shiplets: Array<{ id: string; previewUrl: string }>;
		};
		const project = session.shiplets[0];
		const screenshotDataUrl =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
		const comment = `Collapsed metadata screenshot ${Date.now()}`;

		const createResult = await page.evaluate(
			async ({ comment, projectId, previewUrl, screenshotDataUrl }) => {
				const response = await fetch(`/api/projects/${projectId}/review-feedback`, {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						comment,
						pageUrl: `https://shiplet.cc${previewUrl}`,
						clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
						screenshotDataUrl,
						screenshotMode: "element",
						viewport: { width: 390, height: 740, devicePixelRatio: 2 },
						coordinates: { pageX: 120, pageY: 240, viewportX: 120, viewportY: 240 },
						selectedElement: { selector: ".hero", tagName: "SECTION" },
						captureContext: { documentWidth: 1280, documentHeight: 900 },
					}),
				});
				return { ok: response.ok, body: await response.json() };
			},
			{
				comment,
				projectId: project.id,
				previewUrl: project.previewUrl,
				screenshotDataUrl,
			},
		);
		expect(createResult.ok).toBe(true);

		await page.goto(`/play?session=${sessionId}`, { waitUntil: "networkidle" });
		const ticket = page
			.locator("#sandboxFeedbackList .feedback-ticket")
			.filter({ hasText: comment });
		await expect(ticket).toBeVisible();
		const developerContext = ticket.locator(".feedback-manifest-developer-context");
		await expect(developerContext).not.toHaveAttribute("open", /.+/);
		await expect(ticket.locator(".feedback-manifest-response")).not.toBeVisible();

		await developerContext.locator("summary").click();
		await expect(ticket.locator(".feedback-ticket-screenshot img")).toHaveAttribute(
			"src",
			screenshotDataUrl,
		);
		await expect(ticket.locator(".feedback-manifest-response")).toContainText(
			'"screenshot_url"',
		);
		await expect(ticket.locator(".feedback-manifest-response")).toContainText(
			'"selected_element"',
		);
	});
});
