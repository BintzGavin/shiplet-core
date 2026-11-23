// "Toolbar for the public": a connected site chooses Feedback only. Signed-out
// visitors then see just the Feedback button (or, while visitor feedback is
// off, nothing at all), and the site's team gets the full toolbar back by
// adding ?shiplet=review to the page address, for the rest of the tab.
//
// Set SHIPLET_E2E_SCREENSHOTS=<dir> to also save the screens this checks.
import { createServer } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { embedAuthBootstrapHtml } from "../src/embed-auth-client";
import { visitorFrameResponse } from "../src/embed-visitor-frame";
import {
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
const SITE_PORT = 8798;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

// Two pages of a dark site, linked to each other, with a control in the
// widget's corner so a click there shows whether the widget is in the way.
const SITE_PAGE = (snippet: string, path: string) => {
  const other = path === "/" ? { href: "/lots/42/", label: "Lot 42" } : { href: "/", label: "All lots" };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Gavel Drop</title><style nonce="fixture">body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0,#1b2752,#0a1024 60%);color:#eef1ff;font:16px/1.5 system-ui}main{max-width:720px;margin:72px auto;padding:32px;border:1px solid rgba(170,186,255,.13);border-radius:18px;background:rgba(17,26,51,.72)}h1{margin:0 0 8px;font-size:40px}p{color:#8f98be}a{color:#f4b740}.corner{position:fixed;left:10px;bottom:10px;padding:10px 14px;border:0;border-radius:10px;background:#f4b740;color:#1a1206;font:700 14px system-ui}</style></head><body><main><p>${path === "/" ? "ALL LOTS" : "LOT 42 · CLOSES 9 PM"}</p><h1>${path === "/" ? "Tonight's auction" : "Brass desk lamp, 1930s"}</h1><p>Current bid $480.</p><a href="${other.href}">${other.label}</a></main><button class="corner" type="button" onclick="this.textContent='Corner clicked'">Corner</button>${snippet}</body></html>`;
};

async function shot(page: Page, name: string) {
  if (SCREENSHOTS) await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` });
}

test("Feedback only shows the public just Feedback, and ?shiplet=review brings the full toolbar back for the tab", async ({ page, browser, request }) => {
  test.setTimeout(120_000);
  const owner = testUser("public-toolbar");
  const org = await createOrganization(request, owner);
  const project = await publishStaticShiplet(request, owner, org.id);
  await loginAs(page, owner);

  // Connect the site, give it a dark Appearance at bottom-left, choose Feedback only.
  await page.goto(`/embed/install?project_id=${project.project.id}`);
  await page.getByLabel("Site URL").fill(SITE);
  await page.getByRole("button", { name: "Create install snippet" }).click();
  const snippet = await page.getByLabel("Install snippet").inputValue();
  const installationId = snippet.match(/installation-id="([^"]+)"/)![1];
  await page.getByLabel("Theme").selectOption("dark");
  await page.getByLabel("Accent color").fill("#f4b740");
  await page.getByLabel("Position").selectOption("bottom-left");
  await page.getByRole("button", { name: "Save appearance" }).click();
  await expect(page.getByRole("status")).toContainText("Appearance saved");
  await expect(page.getByRole("radio", { name: "Annotate, Comments and Feedback" })).toBeChecked();
  await page.getByRole("radio", { name: /^Feedback only/ }).check();
  await page.getByRole("button", { name: "Save toolbar choice" }).click();
  await expect(page.getByRole("status")).toContainText("Toolbar for the public: Feedback only.");
  await expect(page.getByRole("radio", { name: /^Feedback only/ })).toBeChecked();
  // This e2e server has no Turnstile keys, so visitor feedback is off: the page says what that means.
  const toolbarPanel = page.locator(".embed-public-toolbar");
  await expect(toolbarPanel).toContainText("the public sees no Shiplet toolbar at all");
  if (SCREENSHOTS) {
    await page.waitForLoadState("networkidle");
    await toolbarPanel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOTS}/public-toolbar-setting.png` });
  }

  const server = createServer((incoming, response) => {
    const path = new URL(incoming.url || "/", SITE).pathname;
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Content-Security-Policy", `style-src 'nonce-fixture' ${SHIPLET}`);
    response.end(SITE_PAGE(snippet, path === "/lots/42/" ? path : "/"));
  });
  await new Promise<void>((resolve) => server.listen(SITE_PORT, "127.0.0.1", resolve));
  const publicContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const teamContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const feedbackContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    // 1. Feedback only with visitor feedback off: the public sees nothing, and
    //    the widget's corner is the page's again.
    const visitor = await publicContext.newPage();
    const visitorErrors = collectPageErrors(visitor);
    const started = visitor.waitForResponse((response) => response.url().startsWith(`${SHIPLET}/embed/review/start?`));
    await visitor.goto(`${SITE}/`);
    const startUrl = new URL((await started).url());
    expect(startUrl.searchParams.has("team")).toBe(false);
    const widget = visitor.locator("shiplet-feedback");
    const surface = widget.locator(".surface");
    await expect(surface).toHaveAttribute("data-view", "hidden");
    await expect(surface).toBeHidden();
    await expect(widget.locator(".overlay-toggle")).toBeHidden();
    await expect(widget.locator(".pins")).toBeHidden();
    const corner = visitor.getByRole("button", { name: "Corner" });
    const box = (await corner.boundingBox())!;
    expect(await visitor.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, { x: box.x + 4, y: box.y + 4 })).toBe("corner");
    await corner.click({ timeout: 3_000 });
    await expect(visitor.getByRole("button", { name: "Corner clicked" })).toBeVisible();
    // A route change reloads the frame; the surface stays hidden throughout.
    await visitor.evaluate(() => history.pushState(null, "", "/?sort=closing"));
    await visitor.waitForTimeout(2_200);
    await expect(surface).toBeHidden();
    await shot(visitor, "public-toolbar-hidden");
    await expectNoPageErrors(visitorErrors);

    // 2. The team adds ?shiplet=review: the full toolbar, kept across pages in this tab.
    const team = await teamContext.newPage();
    const teamErrors = collectPageErrors(team);
    const teamStarted = team.waitForResponse((response) => response.url().startsWith(`${SHIPLET}/embed/review/start?`));
    await team.goto(`${SITE}/?shiplet=review`);
    const teamStart = new URL((await teamStarted).url());
    expect(teamStart.searchParams.get("team")).toBe("1");
    // The reveal is not part of the page the team comments on, and the address is left alone.
    expect(teamStart.searchParams.get("return_url")).toBe(`${SITE}/`);
    expect(team.url()).toBe(`${SITE}/?shiplet=review`);
    const teamWidget = team.locator("shiplet-feedback");
    const teamFrame = teamWidget.locator("iframe").contentFrame();
    await expect(teamFrame.getByRole("button", { name: "Annotate" })).toBeVisible();
    await expect(teamFrame.locator(".shiplet-review-comments-launcher")).toBeVisible();
    await expect(teamWidget.locator(".surface")).toHaveAttribute("data-view", "toolbar");
    await expect(teamWidget.locator(".surface")).not.toHaveAttribute("data-single", "true");
    await expect.poll(async () => (await teamWidget.locator(".surface").boundingBox())?.width).toBe(272);
    await expect(teamWidget.locator(".overlay-toggle")).toBeVisible();
    // The corner control is for the click check above; keep it out of the screenshots.
    await team.locator(".corner").evaluate((element) => { (element as HTMLElement).hidden = true; });
    await shot(team, "public-toolbar-team-revealed");

    await team.getByRole("link", { name: "Lot 42" }).click();
    await team.waitForURL(`${SITE}/lots/42/`);
    await expect(teamFrame.getByRole("button", { name: "Annotate" })).toBeVisible();
    await expect(teamFrame.locator(".shiplet-review-comments-launcher")).toBeVisible();
    expect(await team.evaluate((id) => sessionStorage.getItem(`shiplet.embed.team:${id}`), installationId)).toBe("1");
    await team.locator(".corner").evaluate((element) => { (element as HTMLElement).hidden = true; });
    await shot(team, "public-toolbar-team-next-page");
    await expectNoPageErrors(teamErrors);

    // 3. Feedback only with visitor feedback on. This server has no Turnstile
    //    keys, so the signed-out page is Shiplet's own markup served here, as
    //    the start page renders it for that case.
    const feedbackPage = await feedbackContext.newPage();
    const feedbackErrors = collectPageErrors(feedbackPage);
    const visitorFrameUrl = `${SHIPLET}/embed/visitor/frame?installation_id=${installationId}&return_url=${encodeURIComponent(`${SITE}/`)}`;
    const startBack = `${SHIPLET}/embed/review/start?installation_id=${installationId}&return_url=${encodeURIComponent(`${SITE}/`)}`;
    await feedbackPage.route((url) => url.origin === SHIPLET && url.pathname === "/embed/review/start" && !url.searchParams.has("team"), (route) =>
      route.fulfill({
        contentType: "text/html",
        body: embedAuthBootstrapHtml({
          origin: SHIPLET,
          siteOrigin: SITE,
          themeStylesheetUrl: `${SHIPLET}/api/embed/theme.css?installation_id=${installationId}`,
          nonce: "e2enonce",
          loginUrl: `${SHIPLET}/embed/review/authorize?installation_id=${installationId}`,
          visitorUrl: visitorFrameUrl,
          toolbar: "feedback",
        }),
      }),
    );
    await feedbackPage.route("https://challenges.cloudflare.com/turnstile/v0/api.js*", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'window.turnstile={render:function(selector,options){setTimeout(function(){options.callback("XXXX.DUMMY.TOKEN.XXXX")},50);return "check"},reset:function(){}};',
      }),
    );
    await feedbackPage.route(`${SHIPLET}/api/embed/visitors/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/session")) return route.fulfill({ json: { token: "visitor-token-for-e2e" } });
      if (path.endsWith("/chat")) return route.fulfill({ json: { onDuty: false } });
      return route.fulfill({ status: 404, json: {} });
    });
    await feedbackPage.route((url) => url.origin === SHIPLET && url.pathname === "/embed/visitor/frame", async (route) => {
      const html = await visitorFrameResponse({
        origin: SHIPLET,
        installation: { id: installationId, site_origin: SITE, site_name: "Gavel Drop" },
        themeStylesheetUrl: `${SHIPLET}/api/embed/theme.css?installation_id=${installationId}`,
        pageUrl: `${SITE}/`,
        siteKey: "1x00000000000000000000AA",
        nonce: "e2enonce",
        backUrl: startBack,
      }).text();
      await route.fulfill({ contentType: "text/html", body: html });
    });
    await feedbackPage.goto(`${SITE}/`);
    const feedbackWidget = feedbackPage.locator("shiplet-feedback");
    const feedbackFrame = feedbackWidget.locator("iframe").contentFrame();
    const feedback = feedbackFrame.getByRole("button", { name: "Leave feedback without an account" });
    await expect(feedback).toBeVisible();
    await expect(feedback).toHaveText("Feedback");
    await expect(feedback).toHaveCSS("background-color", "rgb(244, 183, 64)");
    await expect(feedbackFrame.getByRole("button", { name: "Annotate" })).toHaveCount(0);
    await expect(feedbackFrame.locator(".shiplet-review-comments-launcher")).toHaveCount(0);
    const feedbackSurface = feedbackWidget.locator(".surface");
    await expect(feedbackSurface).toHaveAttribute("data-single", "true");
    await expect(feedbackWidget.locator(".overlay-toggle")).toBeHidden();
    // Narrow, in the site's corner, with the button fully inside it.
    await expect.poll(async () => (await feedbackSurface.boundingBox())?.width).toBe(156);
    const surfaceBox = (await feedbackSurface.boundingBox())!;
    expect(surfaceBox.x).toBeLessThan(8);
    expect(surfaceBox.y + surfaceBox.height).toBeGreaterThan(800 - 8);
    const dockBox = (await feedbackFrame.locator(".shiplet-review-launcher-dock").boundingBox())!;
    expect(dockBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
    expect(dockBox.x + dockBox.width).toBeLessThanOrEqual(surfaceBox.x + surfaceBox.width);
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(surfaceBox.y + surfaceBox.height);
    await feedbackPage.locator(".corner").evaluate((element) => { (element as HTMLElement).hidden = true; });
    await shot(feedbackPage, "public-toolbar-feedback-only-dark");

    // Feedback opens the visitor panel; closing it brings back Feedback alone.
    await feedback.click();
    await expect(feedbackSurface).toHaveAttribute("data-view", "expanded");
    await expect(feedbackSurface).not.toHaveAttribute("data-single", "true");
    await expect(feedbackFrame.getByLabel("Your note about this page")).toBeVisible();
    await feedbackFrame.getByRole("link", { name: "Close" }).click();
    await expect(feedbackSurface).toHaveAttribute("data-view", "toolbar");
    await expect(feedbackSurface).toHaveAttribute("data-single", "true");
    await expect(feedbackFrame.getByRole("button", { name: "Annotate" })).toHaveCount(0);
    await expectNoPageErrors(feedbackErrors);
  } finally {
    await publicContext.close();
    await teamContext.close();
    await feedbackContext.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
