// A connected site chooses an Appearance for the widget: dark, a brass accent,
// bottom-left. The signed-out toolbar, the visitor panel and the signed-in
// panels all pick it up from theme.css, the toolbar starts in the site's
// corner, and "Hide comments" never sits over an open panel.
//
// Set SHIPLET_E2E_SCREENSHOTS=<dir> to also save the screens this checks.
import { createServer } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { visitorFrameResponse } from "../src/embed-visitor-frame";
import {
  authHeaders,
  collectPageErrors,
  createOrganization,
  crossSiteFrameInputLaunchOptions,
  expectNoPageErrors,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test.use({
  launchOptions: crossSiteFrameInputLaunchOptions,
  screenshot: "off",
  video: "off",
  trace: "off",
});

const SCREENSHOTS = process.env.SHIPLET_E2E_SCREENSHOTS || "";
const SHIPLET = "http://localhost:8787";
const SITE_PORT = 8797;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

// A page in the style of the first real user: navy glass panels, a brass accent.
const GAVEL_PAGE = (snippet: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Gavel Drop</title><style nonce="fixture">body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0,#1b2752,#0a1024 60%);color:#eef1ff;font:16px/1.5 system-ui}main{max-width:720px;margin:72px auto;padding:32px;border:1px solid rgba(170,186,255,.13);border-radius:18px;background:rgba(17,26,51,.72)}h1{margin:0 0 8px;font-size:40px}p{color:#8f98be}.bid{padding:12px 18px;border:0;border-radius:10px;background:#f4b740;color:#1a1206;font:700 16px system-ui}</style></head><body><main><p>LOT 42 · CLOSES 9 PM</p><h1>Brass desk lamp, 1930s</h1><p>Current bid $480. Shiplet feedback stays on this page.</p><button class="bid">Place bid</button></main>${snippet}</body></html>`;

async function shot(page: Page, name: string) {
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` });
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("a dark appearance with a brass accent at bottom-left reaches every widget frame", async ({ page, browser, request }) => {
  test.setTimeout(120_000);
  const owner = testUser("appearance");
  const org = await createOrganization(request, owner);
  const project = await publishStaticShiplet(request, owner, org.id);
  await loginAs(page, owner);

  // Connect the local site, then save its Appearance.
  await page.goto(`/embed/install?project_id=${project.project.id}`);
  await page.getByLabel("Site URL").fill(SITE);
  await page.getByRole("button", { name: "Create install snippet" }).click();
  const snippet = await page.getByLabel("Install snippet").inputValue();
  const installationId = snippet.match(/installation-id="([^"]+)"/)![1];
  await page.getByLabel("Theme").selectOption("dark");
  await page.getByLabel("Accent color").fill("#f4b740");
  await expect(page.locator("[data-embed-accent-hex]")).toHaveText("#f4b740");
  await page.getByLabel("Position").selectOption("bottom-left");
  await page.getByRole("button", { name: "Save appearance" }).click();
  await expect(page.getByRole("status")).toContainText("Appearance saved");
  await expect(page.getByLabel("Theme")).toHaveValue("dark");
  await expect(page.getByLabel("Accent color")).toHaveValue("#f4b740");
  await expect(page.getByLabel("Position")).toHaveValue("bottom-left");
  if (SCREENSHOTS) {
    await page.waitForLoadState("networkidle");
    await page.locator(".embed-appearance").scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOTS}/appearance-form.png` });
  }

  // A comment on the page, so the signed-in panel has a thread to show.
  await request.post(`/api/projects/${encodeURIComponent(project.project.id)}/review-feedback`, {
    headers: { ...authHeaders(owner), "Content-Type": "application/json", Origin: SHIPLET },
    data: {
      clientFeedbackId: `appearance-${Date.now()}`,
      comment: "The bid button should say how much the next bid is.",
      name: owner.email,
      pageUrl: `${SITE}/`,
      screenshotMode: "page",
      mentions: [],
      viewport: { width: 1280, height: 720 },
    },
  });

  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Content-Security-Policy", `style-src 'nonce-fixture' ${SHIPLET}`);
    response.end(GAVEL_PAGE(snippet));
  });
  await new Promise<void>((resolve) => server.listen(SITE_PORT, "127.0.0.1", resolve));
  const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    // Signed out: no Shiplet session in this browser.
    const visitor = await visitorContext.newPage();
    const visitorErrors = collectPageErrors(visitor);
    await visitor.goto(`${SITE}/`);
    const widget = visitor.locator("shiplet-feedback");
    const frame = widget.locator("iframe").contentFrame();
    const annotate = frame.getByRole("button", { name: "Annotate" });
    await expect(annotate).toBeVisible();
    await expect(annotate).toHaveCSS("background-color", "rgb(244, 183, 64)");
    await expect(annotate).toHaveCSS("color", "rgb(17, 24, 39)");
    const dock = frame.locator(".shiplet-review-launcher-dock");
    await expect(dock).toHaveCSS("background-color", "rgb(17, 26, 51)");
    await expect(frame.locator(".shiplet-review-comments-launcher")).toHaveCSS("color", "rgb(238, 241, 255)");

    // Bottom-left: the frame surface and the toolbar inside it agree.
    const surface = widget.locator(".surface");
    await expect(surface).toHaveAttribute("data-view", "toolbar");
    await expect.poll(async () => (await surface.boundingBox())?.x).toBeLessThan(8);
    const surfaceBox = (await surface.boundingBox())!;
    expect(surfaceBox.y + surfaceBox.height).toBeGreaterThan(800 - 8);
    const dockBox = (await dock.boundingBox())!;
    expect(dockBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
    expect(dockBox.x).toBeLessThan(surfaceBox.x + 24);
    expect(dockBox.y + dockBox.height).toBeGreaterThan(800 - 24);
    const toggle = widget.locator(".overlay-toggle");
    await expect(toggle).toBeVisible();
    const toggleBox = (await toggle.boundingBox())!;
    expect(toggleBox.x).toBeLessThan(24);
    expect(overlaps(toggleBox, dockBox)).toBe(false);
    await expect(toggle).toHaveCSS("background-color", "rgb(17, 26, 51)");
    await shot(visitor, "appearance-signed-out-toolbar");

    // The visitor panel. This server has no Turnstile keys, so the frame is
    // Shiplet's own page served here, with a stand-in check and agent.
    await visitor.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'window.turnstile={render:function(selector,options){setTimeout(function(){options.callback("XXXX.DUMMY.TOKEN.XXXX")},50);return "check"},reset:function(){}};',
      }),
    );
    await visitor.route(`${SHIPLET}/api/embed/visitors/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/session")) return route.fulfill({ json: { token: "visitor-token-for-e2e" } });
      if (path.endsWith("/chat/inbox")) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return route.fulfill({ json: { messages: [] } });
      }
      if (path.endsWith("/chat")) return route.fulfill({ json: { onDuty: true, agent: { name: "Lot desk" } } });
      return route.fulfill({ status: 404, json: {} });
    });
    const visitorFrameUrl = `${SHIPLET}/embed/visitor/frame?installation_id=${installationId}`;
    await visitor.route((url) => url.origin === SHIPLET && url.pathname === "/embed/visitor/frame", async (route) => {
      const html = await visitorFrameResponse({
        origin: SHIPLET,
        installation: { id: installationId, site_origin: SITE, site_name: "Gavel Drop" },
        themeStylesheetUrl: `${SHIPLET}/api/embed/theme.css?installation_id=${installationId}`,
        pageUrl: `${SITE}/`,
        siteKey: "1x00000000000000000000AA",
        nonce: "e2enonce",
        backUrl: `${SHIPLET}/embed/review/start?installation_id=${installationId}&return_url=${encodeURIComponent(`${SITE}/`)}`,
      }).text();
      await route.fulfill({ contentType: "text/html", body: html });
    });
    const toolbarFrame = visitor.frames().find((candidate) => candidate.url().includes("/embed/review/start"))!;
    await toolbarFrame.goto(visitorFrameUrl);
    await expect(surface).toHaveAttribute("data-view", "expanded");
    const panel = widget.locator("iframe").contentFrame();
    await expect(panel.getByLabel("Your note about this page")).toBeVisible();
    await expect(panel.locator("body")).toHaveCSS("background-color", "rgb(17, 26, 51)");
    await expect(panel.getByRole("button", { name: "Send note" })).toHaveCSS("background-color", "rgb(244, 183, 64)");
    await expect(panel.getByRole("button", { name: "Send note" })).toHaveCSS("color", "rgb(17, 24, 39)");
    await expect(panel.getByRole("heading", { name: /Ask Lot desk/ })).toBeVisible();
    // The panel is open, so "Hide comments" is out of its way.
    await expect(toggle).toBeHidden();
    await expect.poll(async () => (await surface.boundingBox())?.x).toBeLessThan(8);
    await shot(visitor, "appearance-visitor-panel");
    await expectNoPageErrors(visitorErrors);

    // Signed in: Comments signs the reviewer in through Shiplet's popup, then
    // the review host opens its panel.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${SITE}/`);
    const reviewWidget = page.locator("shiplet-feedback");
    const host = reviewWidget.locator("iframe").contentFrame();
    const signIn = page.waitForEvent("popup");
    await host.locator(".shiplet-review-comments-launcher").click();
    const popup = await signIn;
    await expect(host.getByRole("heading", { name: "Comments", exact: true })).toBeVisible({ timeout: 20_000 });
    if (!popup.isClosed()) await popup.close();
    // No dock of this reviewer's own yet: the site's corner.
    await expect(reviewWidget).toHaveAttribute("data-dock", "bottom-left");
    await expect(reviewWidget.locator(".surface")).toHaveAttribute("data-view", "comments");
    const reviewPanel = host.locator("#shiplet-kernel-review-panel");
    await expect(reviewPanel).toHaveCSS("background-color", "rgb(24, 34, 63)");
    await expect(reviewPanel).toHaveCSS("color", "rgb(238, 241, 255)");
    const reviewToggle = reviewWidget.locator(".overlay-toggle");
    await expect(reviewToggle).toBeHidden();
    await expect.poll(async () => (await reviewWidget.locator(".surface").boundingBox())?.x).toBeLessThan(8);
    await shot(page, "appearance-signed-in-comments");

    await host.getByRole("button", { name: "Close review panel" }).click();
    await expect(reviewWidget.locator(".surface")).toHaveAttribute("data-view", "toolbar");
    const hostAnnotate = host.getByRole("button", { name: /^Annotate/ });
    await expect(hostAnnotate).toHaveCSS("background-color", "rgb(244, 183, 64)");
    await expect(hostAnnotate).toHaveCSS("color", "rgb(17, 24, 39)");
    const hostDock = host.locator(".shiplet-review-launcher-dock");
    await expect.poll(async () => (await hostDock.boundingBox())?.x).toBeLessThan(24);
    await expect(reviewToggle).toBeVisible();
    await expect(hostDock).toHaveCSS("opacity", "1");
    expect(overlaps((await reviewToggle.boundingBox())!, (await hostDock.boundingBox())!)).toBe(false);
    await shot(page, "appearance-signed-in-toolbar");

    // The Agents panel, when this member's toolbar offers it.
    const agents = host.locator(".shiplet-review-agents-launcher");
    if (await agents.isVisible()) {
      await agents.click();
      await expect(reviewWidget.locator(".surface")).toHaveAttribute("data-view", "agents");
      const agentsPanel = host.locator(".shiplet-review-agents");
      await expect(agentsPanel).toBeVisible();
      await expect(agentsPanel).toHaveCSS("background-color", "rgb(24, 34, 63)");
      await expect(reviewToggle).toBeHidden();
      await shot(page, "appearance-signed-in-agents");
    }
  } finally {
    await visitorContext.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
