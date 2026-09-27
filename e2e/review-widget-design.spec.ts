import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { EMBED_WIDGET_CSS, embedWidgetScript } from "../src/embed-widget";
import {
  createTrustedReviewHostResponse,
  trustedReviewHostScript,
  trustedReviewHostStyles,
} from "../src/trusted-review-host";

test.use({ screenshot: "off", video: "off", trace: "off" });

const origin = "http://localhost:8944";

async function mountReview(page: Page, embedded = false) {
  const response = createTrustedReviewHostResponse({
    shipletId: "design_fixture",
    revisionId: "revision_design",
    title: "Product review",
    artifactUrl: `${origin}/artifact`,
    widgetUrl: null,
    hostScriptUrl: `${origin}/api/review/host.js`,
    reviewApiUrl: `${origin}/__shiplet/review/feedback`,
    confirmationUrl: `${origin}/review/confirm`,
    reviewPageUrl: `${origin}/${embedded ? "site" : "preview"}`,
    submissionMode: "sandbox",
    ...(embedded ? { embeddedSiteOrigin: origin, frameAncestorOrigins: [origin] } : {}),
  });
  const html = await response.text();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ headers, body: html });
    if (path === "/site") return route.fulfill({ contentType: "text/html", body: `<!doctype html><button id="review-target" style="margin:100px 20px">Review target</button><shiplet-feedback installation-id="design_installation" api-url="${origin}"></shiplet-feedback><script src="${origin}/api/embed/widget.js"></script>` });
    if (path === "/api/embed/widget.js") return route.fulfill({ contentType: "text/javascript", body: embedWidgetScript() });
    if (path === "/api/embed/widget.css") return route.fulfill({ contentType: "text/css", body: EMBED_WIDGET_CSS });
    if (path === "/embed/review/start") return route.fulfill({ headers, body: html });
    if (path.endsWith("host.js")) return route.fulfill({ contentType: "text/javascript", body: trustedReviewHostScript() });
    if (path.endsWith("host.css")) return route.fulfill({ contentType: "text/css", body: trustedReviewHostStyles() });
    if (path === "/artifact") return route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>Product preview</h1>" });
    if (path.endsWith("/feedback")) return route.fulfill({ json: {
      feedback: [1, 2, 3].map((number) => ({
        id: `feedback_design_${number}`,
        ticket_label: `PF-${number}`,
        ticket_number: number,
        comment: number === 1 ? "Keep the supporting detail close to the primary action so the next step is clear." : "Check the spacing and hierarchy at smaller screen sizes.",
        submitted_by_email: "alex@example.test",
        status: "New",
        page_url: `${origin}/${embedded ? "site" : "preview"}`,
        revision_id: "revision_design",
        created_on: "2026-09-27T12:00:00Z",
        replies: [],
      })), nextCursor: null,
    } });
    return route.fulfill({ json: { users: [], watch: { watching: false } } });
  });
  await page.goto(embedded ? `${origin}/site` : origin);
}

async function expectFitsViewport(page: Page, selector: string) {
  const rect = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize()!;
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.locator(selector).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function expectLauncherFits(surface: Page | FrameLocator, touch = false) {
  const comments = surface.getByRole("button", { name: /Open.*comments for revision_design/ });
  const annotate = surface.getByRole("button", { name: /^Annotate revision_design/ });
  const minimumHeight = touch ? 44 : 36;
  for (const button of [annotate, comments]) {
    const bounds = await button.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(minimumHeight);
    expect(await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && Array.from(element.children).every((child) => {
        const childBox = child.getBoundingClientRect();
        return childBox.left >= box.left && childBox.right <= box.right &&
          childBox.top >= box.top && childBox.bottom <= box.bottom;
      });
    })).toBe(true);
  }
  const commentBox = (await comments.boundingBox())!;
  const annotateBox = (await annotate.boundingBox())!;
  expect(commentBox.height).toBe(annotateBox.height);
  expect(commentBox.y).toBe(annotateBox.y);
  const labelBox = (await comments.locator("span").first().boundingBox())!;
  const countBox = (await comments.locator("span").last().boundingBox())!;
  expect(countBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
}

test("comments have a visible launcher label and readable previews with accessible actions", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountReview(page);
  const launcher = page.getByRole("button", { name: /Open.*comments for revision_design/ });
  await expect(launcher).toContainText("Comments");
  await expectLauncherFits(page);
  await launcher.click();
  const preview = page.locator(".shiplet-review-thread-summary-comment").first();
  expect(await preview.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(13);
  await expectFitsViewport(page, "#shiplet-kernel-review-panel");
  await page.getByRole("button", { name: /alex.*PF-1/i }).click();
  await expect(page.getByRole("textbox", { name: "Reply text for PF-1" })).toBeVisible();
  await page.getByRole("button", { name: "Close review panel" }).click();
  await expect(launcher).toBeFocused();
});

for (const width of [320, 1280]) {
  test(`embedded launcher and composer stay usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mountReview(page, true);
    const host = page.frameLocator("shiplet-feedback iframe");
    const launcher = host.getByRole("button", { name: /Open.*comments for revision_design/ });
    await expect(launcher).toContainText("Comments");
    await expectLauncherFits(host, true);
    await launcher.click();
    await host.getByRole("button", { name: "New comment", exact: true }).click();
    await page.getByRole("button", { name: "Review target", exact: true }).click();
    await host.getByRole("textbox", { name: "Annotation", exact: true }).fill("An embedded draft.");
    const send = host.getByRole("button", { name: "Send annotation", exact: true });
    await expect(send).toBeInViewport();
    await host.getByText("Attachments", { exact: true }).click();
    await expect(host.getByRole("button", { name: "Attach photos or video" })).toBeVisible();
    await send.scrollIntoViewIfNeeded();
    await expect(send).toBeInViewport();
    expect(await host.locator("#shiplet-annotation-composer").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}

test("compact composer gives writing the full width and keeps its actions below the input", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountReview(page);
  await page.getByRole("button", { name: /Open.*comments for revision_design/ }).click();
  await page.getByRole("button", { name: "New comment", exact: true }).click();
  await page.getByRole("button", { name: "Page comment", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Annotation", exact: true });
  await expect(input).toBeVisible();
  const inputRect = (await input.boundingBox())!;
  const sendRect = (await page.getByRole("button", { name: "Send annotation", exact: true }).boundingBox())!;
  expect(inputRect.width).toBeGreaterThanOrEqual(300);
  expect(sendRect.y).toBeGreaterThanOrEqual(inputRect.y + inputRect.height);
  expect(sendRect.height).toBeGreaterThanOrEqual(44);
  await expectFitsViewport(page, "#shiplet-annotation-composer");
  await expect(page.getByRole("button", { name: "Attach photos or video" })).toBeHidden();
  await page.getByText("Attachments", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Attach photos or video" })).toBeVisible();
  await page.locator(".shiplet-attachment-input").setInputFiles({
    name: "note.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByText("note.png", { exact: true })).toBeVisible();
  await page.getByText("Attachments", { exact: true }).click();
  await input.fill("A draft survives opening its details.");
  await page.getByRole("button", { name: "Show annotation details and target properties" }).click();
  await expect(input).toHaveValue("A draft survives opening its details.");
  await expectFitsViewport(page, "#shiplet-annotation-composer");
  await page.getByText("Attachments", { exact: true }).click();
  await expect(page.getByText("note.png", { exact: true })).toBeVisible();
});

test("narrow screens retain reachable panel controls and readable threads", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mountReview(page);
  await page.getByRole("button", { name: /Open.*comments for revision_design/ }).click();
  await expectFitsViewport(page, "#shiplet-kernel-review-panel");
  const close = page.getByRole("button", { name: "Close review panel" });
  expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: /alex.*PF-1/i }).click();
  await page.getByRole("textbox", { name: "Reply text for PF-1" }).fill("Readable on mobile.");
  await expectFitsViewport(page, "#shiplet-kernel-review-panel");
});
