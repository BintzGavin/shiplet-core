import { expect, test, type Page, type Route } from "@playwright/test";

import {
  createTrustedReviewHostResponse,
  trustedReviewHostScript,
  trustedReviewHostStyles,
} from "../src/trusted-review-host";
import { trustedArtifactBridgeScript } from "../src/trusted-artifact-bridge";

test.use({
	viewport: { width: 1080, height: 760 },
	screenshot: "off",
	trace: "off",
	video: "off",
});

const hostOrigin = "http://r17-host.localhost:8837";
const siteOrigin = "http://r17-site.localhost:8837";
const installationId = "installation_r17";
const projectId = "project_r17";
const revisionId = "revision_r17";
const reviewPageUrl = `${siteOrigin}/reviewed-page`;

async function mountEmbeddedHandshake(page: Page) {
  const response = createTrustedReviewHostResponse({
    shipletId: projectId,
    revisionId,
    title: "R17 embedded review",
    artifactUrl: `${hostOrigin}/artifact`,
    widgetUrl: null,
    hostScriptUrl: `${hostOrigin}/api/review/host.js`,
    reviewApiUrl: `${hostOrigin}/embed/review/feedback?installation_id=${installationId}`,
    confirmationUrl: `${hostOrigin}/embed/review/confirm`,
    reviewPageUrl,
    submissionMode: "sandbox",
    embeddedSiteOrigin: siteOrigin,
    frameAncestorOrigins: [siteOrigin],
  });
  const hostHtml = await response.text();
  const hostHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    hostHeaders[name] = value;
  });

  await page.addInitScript(() => {
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      value: undefined,
    });
  });
  await page.route("**/*", async (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === siteOrigin && requestUrl.pathname === "/reviewed-page") {
      const embeddedBridge = trustedArtifactBridgeScript(true);
      const body = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}#review-target{position:absolute;left:240px;top:180px;width:220px;height:64px;font:700 20px system-ui}</style></head><body><button id="review-target" type="button">Review target</button><iframe id="trusted-host" title="Trusted review host" style="display:block;position:absolute;left:0;top:0;width:100%;height:100%;border:0"></iframe><script>${embeddedBridge}</script><script>(()=>{const frame=document.querySelector("#trusted-host");if(!frame)throw new Error("Missing trusted host frame");window.__r17Ui=[];window.__r17Messages=[];window.addEventListener("message",event=>{if(event.source===frame.contentWindow&&event.origin==="${hostOrigin}"){if(event.data?.protocol==="shiplet.embed.ui.v1"){window.__r17Ui.push(event.data);frame.style.pointerEvents=event.data.view==="selecting"?"none":"auto";}if(event.data?.protocol==="shiplet.artifact.channel.v1")window.__r17Messages.push(event.data);}});const held=[];const nativePostMessage=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(...args){const message=args[0];if(message&&message.protocol==="shiplet.artifact.capture.state.v1"){window.__r17Messages.push(message);if(message.type==="ready"){held.push({port:this,args});return;}}return Reflect.apply(nativePostMessage,this,args);};window.__r17ReleaseReady=()=>{while(held.length){const item=held.shift();Reflect.apply(nativePostMessage,item.port,item.args);}};window.__r17HeldReadyCount=()=>held.length;window.__r17Cleanup=attachShipletPageBridge(frame,"${hostOrigin}");frame.src="${hostOrigin}/embedded-host";})();</script></body></html>`;
      return route.fulfill({ contentType: "text/html", body });
    }
    if (requestUrl.origin !== hostOrigin) return route.abort();
    if (requestUrl.pathname === "/embedded-host") {
      return route.fulfill({ status: 200, headers: hostHeaders, body: hostHtml });
    }
    if (requestUrl.pathname === "/api/review/host.js") {
      return route.fulfill({ contentType: "application/javascript", body: trustedReviewHostScript() });
    }
    if (requestUrl.pathname === "/api/review/host.css") {
      return route.fulfill({ contentType: "text/css", body: trustedReviewHostStyles() });
    }
    if (requestUrl.pathname === "/embed/review/draft-context") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          context: {
            actor: { kind: "sandbox", id: "sandbox_r17" },
            projectId,
            revisionId,
            pageUrl: reviewPageUrl,
            installationId,
            expiresOn: null,
            durableOperations: false,
          },
        }),
      });
    }
    if (requestUrl.pathname === "/embed/review/feedback") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          feedback: [{
            id: "feedback_r17_page",
            ticket_label: "PF-R17",
            ticket_number: 17,
            comment: "Page comment stays visible during preparation.",
            status: "New",
            page_url: reviewPageUrl,
            revision_id: revisionId,
            submitted_by_email: "reviewer@example.test",
            replies: [],
          }],
          nextCursor: null,
        }),
      });
    }
    if (requestUrl.pathname.endsWith("/review-mention-users")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ users: [] }) });
    }
    if (requestUrl.pathname === "/embed/review/confirm") {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><p>Confirmation</p>" });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });
  await page.goto(reviewPageUrl, { waitUntil: "domcontentloaded" });
  const host = page.frameLocator("#trusted-host");
  await expect(host.getByRole("button", { name: /^Annotate/ })).toBeVisible();
  await expect(host.getByRole("button", { name: /Open .*comment/ })).toBeVisible();
  return host;
}

async function heldReadyCount(page: Page) {
  return page.evaluate(() => (window as typeof window & { __r17HeldReadyCount?: () => number }).__r17HeldReadyCount?.() || 0);
}

async function releaseReady(page: Page) {
  await page.evaluate(() => (window as typeof window & { __r17ReleaseReady?: () => void }).__r17ReleaseReady?.());
}

test("embedded selection waits for bridge readiness before capturing the first normal click", async ({ page }) => {
  const host = await mountEmbeddedHandshake(page);
  await host.getByRole("button", { name: /Open .*comment/ }).click();
  await expect(host.getByRole("button", { name: "New comment" })).toBeVisible();
  const pageComments = host.getByRole("button", { name: /Page comments/ });
  await expect(pageComments).toBeVisible();

  await host.getByRole("button", { name: "New comment" }).click();
  await expect.poll(() => heldReadyCount(page)).toBe(1);
  await expect(page.locator("#review-target")).toBeVisible();
  await expect(host.locator("[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "false");
  await expect(pageComments).toBeVisible();
  await expect(host.locator("#shiplet-kernel-review-panel")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __r17Ui?: Array<{ view: string }> }).__r17Ui?.at(-1)?.view || "")).not.toBe("selecting");

  await releaseReady(page);
  await expect(host.locator("[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "true");
  await expect(pageComments).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __r17Ui?: Array<{ view: string }> }).__r17Ui?.at(-1)?.view || "")).toBe("selecting");

  await page.locator("#review-target").click();
  await expect(host.locator("[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "false");
  await expect(host.locator("#shiplet-annotation-composer")).toBeVisible();
  await expect(host.locator(".shiplet-review-target")).toContainText("BUTTON");
  await expect(host.locator(".shiplet-review-target")).toContainText("Review target");
  await expect(pageComments).toBeVisible();
});

test("embedded cancel clears preparation and fences a stale ready acknowledgement", async ({ page }) => {
  const host = await mountEmbeddedHandshake(page);
  await host.getByRole("button", { name: /Open .*comment/ }).click();
  const newComment = host.getByRole("button", { name: "New comment" });
  await expect(newComment).toBeVisible();
  await expect(newComment).toBeEnabled();
  await newComment.click();
  await expect.poll(() => heldReadyCount(page)).toBe(1);
  await expect(newComment).toBeVisible();
  await expect(newComment).toBeEnabled();
  await expect(newComment).toBeFocused();

  await newComment.press("Escape");
  await expect(host.locator("[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "false");
  await expect(host.locator("#shiplet-annotation-composer")).toBeHidden();
  await expect(newComment).toBeVisible();
  await expect(newComment).toBeEnabled();
  await expect(newComment).toBeFocused();
  await page.screenshot({ path: "/private/tmp/shiplet-parity-verification-r18-20260921/media/cancel-focus-new-comment.png" });
  await releaseReady(page);
  await expect(host.locator("[data-shiplet-artifact-frame]")).toHaveAttribute("data-shiplet-selecting", "false");
  await expect(host.locator("#shiplet-annotation-composer")).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __r17Ui?: Array<{ view: string }> }).__r17Ui?.at(-1)?.view || "")).not.toBe("selecting");
});
