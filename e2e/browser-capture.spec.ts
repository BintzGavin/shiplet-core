import { createServer } from "node:http";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { authHeaders, createOrganization, establishMembership, loginAs, testUser } from "./helpers";

test.use({ screenshot: "off", video: "off", trace: "off" });
async function companion(context: BrowserContext, host: Page, extensionId: string) {
  const control = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await control.send("Target.getTargets", { filter: [{ type: "tab", exclude: false }] });
  const targetInfo = targetInfos.find(target => target.url === host.url());
  if (!targetInfo) throw new Error("No browser tab target for the capture fixture: " + JSON.stringify(targetInfos));
  await control.send("Extensions.triggerAction" as any, { id: extensionId, targetId: targetInfo.targetId });
  // Native toolbar popovers are not Page targets. Run the same bundled popup
  // in a controllable tab, keeping the user-authorized source tab active.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await host.bringToFront();
  await host.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const previewPromise = context.waitForEvent("page");
  await popup.locator("#capture").evaluate((button: HTMLButtonElement) => button.click());
  const preview = await previewPromise;
  await preview.waitForURL(/preview.html/);
  await expect(preview.getByRole("button", { name: "Continue to Shiplet" })).toBeEnabled();
  return preview;
}

test("real companion captures CSP-protected canvas pixels, redacts locally, publishes, and shares canonical review feedback", async ({ request, browser }) => {
  test.setTimeout(120_000);
  const owner = testUser("capture-owner");
  const organization = await createOrganization(request, owner);
  const folder = await mkdtemp("/tmp/shiplet-capture-extension-");
  await cp("browser-companion", folder, { recursive: true });
  await writeFile(`${folder}/config.js`, 'const SHIPLET_ORIGIN = "http://localhost:8787";\n');
  const manifest = JSON.parse(await readFile(`${folder}/manifest.json`, "utf8"));
  manifest.content_scripts[0].matches = ["http://localhost:8787/capture"];
  await writeFile(`${folder}/manifest.json`, JSON.stringify(manifest));
  const profile = await mkdtemp("/tmp/shiplet-capture-profile-");
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`, "--enable-unsafe-extension-debugging"],
  });
  context.setDefaultTimeout(15000);
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-fixture'; style-src 'unsafe-inline'");
    response.end(`<!doctype html><title>Signed-in canvas fixture</title><style>body{margin:0;background:#f4f1e9}</style><canvas id="work" width="1000" height="800"></canvas><script nonce="fixture">const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#f4f1e9';c.fillRect(0,0,1000,800);c.fillStyle='#1f5b72';c.fillRect(300,220,500,300);c.fillStyle='white';c.font='bold 38px system-ui';c.fillText('Work beyond the widget',330,300);c.fillStyle='#b44729';c.fillRect(30,30,140,70);c.fillStyle='white';c.font='18px system-ui';c.fillText('Private detail',40,70);</script>`);
  });
  await new Promise<void>(resolve => server.listen(8799, "127.0.0.1", resolve));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const authPage = await context.newPage();
    await loginAs(authPage, owner);
    const host = await context.newPage();
    await host.goto("http://127.0.0.1:8799/private?token=fixture");
    await expect(host.locator("canvas")).toBeVisible();
    await host.bringToFront();
    const preview = await companion(context, host, id);
    await preview.screenshot({ path: "/tmp/shiplet-browser-capture-preview.png" });
    // Verify actual browser pixels, including a canvas that DOM cloning omits.
    expect(await preview.locator("canvas").evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext("2d")!.getImageData(400, 400, 1, 1).data))).toEqual([31, 91, 114, 255]);
    await preview.getByText("Redact using coordinates", { exact: true }).click();
    for (const [label, value] of [["X", "25"], ["Y", "25"], ["Width", "160"], ["Height", "90"]]) await preview.getByLabel(label, { exact: true }).fill(value);
    await preview.getByRole("button", { name: "Apply redaction" }).click();
    expect(await preview.locator("canvas").evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext("2d")!.getImageData(35, 35, 1, 1).data))).toEqual([0, 0, 0, 255]);
    await preview.screenshot({ path: "/tmp/shiplet-browser-capture-preview.png" });
    const destinationPromise = context.waitForEvent("page");
    await preview.getByRole("button", { name: "Continue to Shiplet" }).click();
    const capture = await destinationPromise;
    await capture.waitForURL(/localhost:8787\/capture/);
    await expect(capture.locator("#capture-preview")).toBeVisible();
    await expect(capture.getByLabel("Original page URL (optional)")).toHaveValue("http://127.0.0.1:8799/private");
    expect(await capture.locator("canvas").evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext("2d")!.getImageData(35, 35, 1, 1).data))).toEqual([0, 0, 0, 255]);
    await capture.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(organization.id);
    await capture.getByLabel("Name", { exact: true }).fill("Canvas review");
    await capture.getByRole("checkbox").check();
    await capture.getByRole("button", { name: "Create shared review" }).click();
    await capture.waitForURL(/\/shiplets\/([^/]+)\/review-host/);
    const projectId = capture.url().match(/\/shiplets\/([^/]+)/)![1];
    const reviewUrl = capture.url();
    const artifact = capture.locator("iframe[data-shiplet-artifact-frame]").contentFrame();
    await expect(artifact.locator("#browser-capture")).toBeVisible();
    await expect(capture.getByRole("button", { name: /^Annotate / })).toBeVisible();
    await capture.getByRole("button", { name: /^Annotate / }).click();
    await artifact.locator("#browser-capture").click({ position: { x: 400, y: 400 } });
    await capture.locator(".shiplet-review-form textarea").fill("Make this canvas panel easier to read.");
    const confirmPromise = capture.waitForEvent("popup");
    await capture.getByRole("button", { name: "Send annotation", exact: true }).click();
    const confirm = await confirmPromise;
    await confirm.getByRole("button", { name: "Confirm and send feedback" }).click();
    await expect(confirm.getByRole("heading", { name: "Feedback sent" })).toBeVisible();
    await confirm.close();
    const api = await request.get(`/api/projects/${projectId}/review-feedback`, { headers: authHeaders(owner) });
    const { feedback } = await api.json();
    expect(feedback).toHaveLength(1);
    expect(feedback[0].comment).toBe("Make this canvas panel easier to read.");
    const screenshot = await request.get(`/api/projects/${projectId}/review-feedback/${feedback[0].id}/screenshot`, { headers: authHeaders(owner) });
    expect(screenshot.ok()).toBe(true);
    const screenshotData = "data:image/png;base64," + (await screenshot.body()).toString("base64");
    expect(await capture.evaluate(async data => {
      const img = new Image(); img.src = data; await img.decode();
      const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(400, 400, 1, 1).data);
    }, screenshotData)).toEqual([31, 91, 114, 255]);
    const teammate = testUser("capture-teammate");
    await establishMembership(request, organization.id, teammate);
    const teammateContext = await browser.newContext();
    try {
      const teammatePage = await teammateContext.newPage(); await loginAs(teammatePage, teammate);
      await teammatePage.goto(reviewUrl);
      await teammatePage.getByRole("button", { name: /^Open 1 comment/ }).click();
      await expect(teammatePage.locator(".shiplet-review-thread-summary-comment")).toContainText(feedback[0].comment);
      await teammatePage.locator(".shiplet-review-thread-summary").click();
      await teammatePage.getByRole("textbox", { name: "Reply text for PF-1" }).fill("I’ll update this panel.");
      await teammatePage.getByRole("button", { name: "Reply to PF-1", exact: true }).click();
      await expect(teammatePage.locator(".shiplet-review-replies")).toContainText("I’ll update this panel.");
      await teammatePage.getByRole("button", { name: "Resolve PF-1", exact: true }).click();
      await expect(teammatePage.getByRole("button", { name: "Reopen PF-1", exact: true })).toBeVisible();
      const updated = await context.request.get(`/api/projects/${projectId}/review-feedback?includeClosed=true`, { headers: { Origin: "http://localhost:8787" } });
      expect(JSON.stringify(await updated.json())).toContain("I’ll update this panel.");
      await teammatePage.getByRole("button", { name: /^Annotate / }).click();
      await teammatePage.locator("iframe[data-shiplet-artifact-frame]").contentFrame().locator("#browser-capture").click({ position: { x: 650, y: 450 } });
      await teammatePage.locator(".shiplet-review-form textarea").fill("Move this right edge in a little.");
      const secondPromise = teammatePage.waitForEvent("popup");
      await teammatePage.getByRole("button", { name: "Send annotation", exact: true }).click();
      const second = await secondPromise;
      await second.getByRole("button", { name: "Confirm and send feedback" }).click();
      await expect(second.getByRole("heading", { name: "Feedback sent" })).toBeVisible(); await second.close();
      const both = await context.request.get(`/api/projects/${projectId}/review-feedback?includeClosed=true`, { headers: { Origin: "http://localhost:8787" } });
      const records = (await both.json()).feedback;
      expect(records).toHaveLength(2);
      expect(Math.abs(records[0].coordinates.pageX - records[1].coordinates.pageX)).toBeGreaterThan(200);
      await teammatePage.getByRole("button", { name: /^Open 2 comments/ }).click();
      await teammatePage.screenshot({ path: "/tmp/shiplet-browser-capture-shared.png" });
    } finally { await teammateContext.close(); }
    const outsider = await browser.newContext();
    try { const p = await outsider.newPage(); await loginAs(p, testUser("capture-outsider")); await p.goto(reviewUrl); await expect(p.locator("iframe[data-shiplet-artifact-frame]")).toHaveCount(0); } finally { await outsider.close(); }
  } finally {
    await context.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("image upload works without a companion, preserves redaction, and requires review before publishing", async ({ page, request }) => {
  const owner = testUser("capture-upload"), organization = await createOrganization(request, owner);
  await loginAs(page, owner); await page.goto("/capture");
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 640; c.height = 400; const ctx = c.getContext("2d")!; ctx.fillStyle = "#1f5b72"; ctx.fillRect(0, 0, 640, 400); return c.toDataURL("image/png").split(",")[1]; });
  await page.getByLabel("Upload an image").setInputFiles({ name: "document.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator("#capture-preview")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/shiplet-capture-mobile.png", fullPage: true, animations: "disabled" });
  await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption(organization.id);
  await page.getByRole("button", { name: "Create shared review" }).click();
  await expect(page).toHaveURL(/\/capture$/);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create shared review" }).click();
  await page.waitForURL(/review-host/);
  await expect(page.locator("iframe[data-shiplet-artifact-frame]").contentFrame().locator("#browser-capture")).toBeVisible();
});

test("browser-authorized tab capture produces a local preview and immediately stops recording", async () => {
  test.setTimeout(45000);
  const browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--auto-select-tab-capture-source-by-title=Shiplet screen capture fixture", "--enable-usermedia-screen-capturing"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const work = await context.newPage();
    await work.setContent('<title>Shiplet screen capture fixture</title><style>body{margin:0;background:rgb(31,91,114);color:white;font:48px system-ui}</style><h1>Browser-authorized capture</h1>');
    const page = await context.newPage();
    await page.goto("http://localhost:8787/capture");
    await page.evaluate(() => {
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getDisplayMedia = async options => {
        const stream = await original(options);
        (window as any).captureTestTracks = stream.getTracks();
        return stream;
      };
    });
    await page.getByRole("button", { name: "Capture a tab or window" }).click();
    await expect(page.locator("#capture-preview")).toBeVisible({ timeout: 15000 });
    const pixel = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => Array.from(canvas.getContext("2d")!.getImageData(400, 400, 1, 1).data));
    // Screen sharing is a video stream; YUV conversion can round RGB channels.
    [31, 91, 114, 255].forEach((expected, index) => expect(Math.abs(pixel[index] - expected)).toBeLessThanOrEqual(2));
    expect(await page.evaluate(() => (window as any).captureTestTracks.every((track: MediaStreamTrack) => track.readyState === "ended"))).toBe(true);
    await expect(page.locator("#capture-status")).toContainText("Nothing has been uploaded");
    await page.screenshot({ path: "/tmp/shiplet-web-capture-preview.png", fullPage: true, animations: "disabled" });
  } finally { await browser.close(); }
});
