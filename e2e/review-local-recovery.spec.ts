import { expect, test, type FrameLocator, type Page, type Route } from "@playwright/test";

import {
  createTrustedReviewHostResponse,
  trustedReviewHostScript,
  trustedReviewHostStyles,
} from "../src/trusted-review-host";

test.use({
  viewport: { width: 1080, height: 760 },
  screenshot: "off",
  trace: "off",
  video: "off",
});

const hostOrigin = "http://r1.localhost:8806";
const siteOrigin = "http://r1-site.localhost:8806";
const syntheticInstallationId = "installation_recovery";
const evidenceRoot = "/private/tmp/shiplet-parity-recovery-r1-20260920";

type ReviewFeedback = {
  id: string;
  ticket_label: string;
  ticket_number: number;
  comment: string;
  status: string;
  page_url: string;
  revision_id: string;
  replies: Array<{ comment: string; submitted_by_email: string }>;
  submitted_by_email: string;
  coordinates: {
    pageX: number;
    pageY: number;
    viewportX: number;
    viewportY: number;
  };
  selected_element: { selector: string; tagName: string; text: string };
  capture_context: {
    documentWidth: number;
    documentHeight: number;
    scrollX: number;
    scrollY: number;
  };
};

type HeldMutation = {
  route: Route;
  body: Record<string, unknown>;
};

function fixtureFeedback(pageUrl: string): ReviewFeedback {
  return {
    id: "feedback_recovery_7",
    ticket_label: "PF-7",
    ticket_number: 7,
    comment: "Keep the review state attached to this target.",
    status: "New",
    page_url: pageUrl,
    revision_id: "revision_recovery",
    replies: [],
    submitted_by_email: "reviewer@example.test",
    coordinates: {
      pageX: 180,
      pageY: 180,
      viewportX: 180,
      viewportY: 180,
    },
    selected_element: {
      selector: "#review-target",
      tagName: "BUTTON",
      text: "Review target",
    },
    capture_context: {
      documentWidth: 1080,
      documentHeight: 760,
      scrollX: 0,
      scrollY: 0,
    },
  };
}

function bridgeScript() {
  return String.raw`<script>
  (() => {
    const shipletId = "project_recovery";
    const revisionId = "revision_recovery";
    function screenshotDataUrl() {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const context = canvas.getContext("2d");
      context.fillStyle = "#f4f6f8";
      context.fillRect(0, 0, 320, 200);
      context.fillStyle = "#d8dee8";
      context.fillRect(10, 10, 300, 28);
      return canvas.toDataURL("image/png");
    }
    function connect(port, nonce) {
      port.addEventListener("message", (event) => {
        const command = event.data;
        if (!command || command.protocol !== "shiplet.artifact.capture.command.v1" || command.type !== "start") return;
        port.postMessage({
          protocol: "shiplet.artifact.capture.result.v1",
          type: "result",
          channelNonce: nonce,
          shipletId,
          revisionId,
          requestId: command.requestId,
          status: "captured",
          payload: {
            screenshotDataUrl: screenshotDataUrl(),
            screenshotFailureNote: null,
            screenshotMode: "element",
            viewport: { width: 1080, height: 760, devicePixelRatio: 1 },
            coordinates: { pageX: 240, pageY: 210, viewportX: 240, viewportY: 210 },
            selectedElement: { selector: "#review-target", tagName: "BUTTON", text: "Review target" },
            captureContext: { documentWidth: 1080, documentHeight: 760, scrollX: 0, scrollY: 0 }
          }
        });
      });
      port.start();
    }
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data.shipletId !== shipletId || data.revisionId !== revisionId) return;
      if (data.protocol === "shiplet.artifact.channel.v1" && data.type === "offer") {
        event.source.postMessage({
          protocol: "shiplet.artifact.channel.v1",
          type: "ready",
          channelNonce: data.channelNonce,
          shipletId,
          revisionId
        }, "*");
        return;
      }
      if (data.protocol === "shiplet.artifact.channel.v1" && data.type === "connect" && event.ports[0]) {
        connect(event.ports[0], data.channelNonce);
      }
    });
  })();
  </script>`;
}

async function mountGeneratedHost(
  page: Page,
  options: { embedded?: boolean; submissionMode?: "sandbox" | "confirmation"; failInitialGet?: boolean; holdOperation?: boolean; unknownOperation?: boolean } = {},
) {
  const embedded = Boolean(options.embedded);
  const reviewPageUrl = `${embedded ? siteOrigin : hostOrigin}/reviewed-page`;
  let feedback = fixtureFeedback(reviewPageUrl);
  let failGet = Boolean(options.failInitialGet);
  const heldReplies: HeldMutation[] = [];
  const heldStatuses: HeldMutation[] = [];
  const heldComments: HeldMutation[] = [];
  let holdReplies = false;
  let holdStatuses = false;
  let holdComments = false;
  let replyMutationCount = 0;
  let statusMutationCount = 0;
  let commentMutationCount = 0;
  let listRequestCount = 0;
  const draftContextRequests: string[] = [];
  const operationOutcomeRequests: string[] = [];
  const heldOperations: HeldMutation[] = [];
  let holdOperation = Boolean(options.holdOperation);
  let confirmationRequestId = "";
  let confirmationEffect = "";
  const embeddedContextExpiresOn = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const response = createTrustedReviewHostResponse({
    shipletId: "project_recovery",
    revisionId: "revision_recovery",
    title: "Recovery review",
    artifactUrl: `${hostOrigin}/artifact`,
    widgetUrl: null,
    hostScriptUrl: `${hostOrigin}/api/review/host.js`,
    reviewApiUrl: embedded
      ? `${hostOrigin}/embed/review/feedback?installation_id=${syntheticInstallationId}`
      : `${hostOrigin}/__shiplet/review/feedback`,
    confirmationUrl: `${hostOrigin}/review/confirm`,
    reviewPageUrl,
    submissionMode: options.submissionMode || "sandbox",
    ...(embedded
      ? {
          embeddedSiteOrigin: siteOrigin,
          frameAncestorOrigins: [siteOrigin],
        }
      : {}),
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

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === siteOrigin && url.pathname === "/site") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body><button id="review-target">Review target</button><iframe id="trusted-host" style="display:block;width:900px;height:700px;border:0" src="${hostOrigin}/embedded-host"></iframe>${bridgeScript()}</body></html>`,
      });
    }
    if (url.pathname === "/review/confirm" || url.pathname === "/embed/review/confirm") {
      if (request.method() === "POST") {
        const form = new URLSearchParams(request.postData() || "");
        const requestId = form.get("request_id") || "";
        const effect = form.get("operation") || "";
        if (requestId && effect) {
          confirmationRequestId = requestId;
          confirmationEffect = effect;
        }
      }
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><p>Secure confirmation opened</p>",
      });
    }
    const operationPrefix = embedded ? "/embed/review/operations/" : "/__shiplet/review/operations/";
    if (url.pathname.startsWith(operationPrefix)) {
      operationOutcomeRequests.push(url.toString());
      const encodedRequestId = url.pathname.slice(operationPrefix.length);
      let requestId = "";
      try {
        requestId = decodeURIComponent(encodedRequestId);
      } catch {
        requestId = "";
      }
      const expectedKeys = embedded
        ? ["effect", "installation_id", "page_url", "revision_id"]
        : ["effect", "page_url", "revision_id"];
      const actualKeys = Array.from(url.searchParams.keys()).sort();
      const exactQuery =
        request.method() === "GET" &&
        actualKeys.length === expectedKeys.length &&
        actualKeys.every((key, index) => key === expectedKeys.slice().sort()[index]);
      const matchesQueryBinding =
        exactQuery &&
        url.searchParams.get("effect") === "feedback.create" &&
        url.searchParams.get("revision_id") === "revision_recovery" &&
        url.searchParams.get("page_url") === reviewPageUrl &&
        (embedded
          ? url.searchParams.get("installation_id") === syntheticInstallationId
          : !url.searchParams.has("installation_id"));
      if (!confirmationRequestId && matchesQueryBinding && requestId) {
        confirmationRequestId = requestId;
        confirmationEffect = "feedback.create";
      }
      const matchesBinding =
        matchesQueryBinding &&
        requestId === confirmationRequestId &&
        confirmationEffect === "feedback.create";
      if (!matchesBinding) {
        return route.fulfill({
          status: 404,
          headers: { "cache-control": "private, no-store" },
          json: { error: "Review operation unavailable" },
        });
      }
      if (holdOperation) {
        heldOperations.push({ route, body: { requestId, effect: "feedback.create" } });
        return;
      }
      if (options.unknownOperation) {
        return route.fulfill({
          status: 404,
          headers: { "cache-control": "private, no-store" },
          json: { error: "Review operation unavailable" },
        });
      }
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "private, no-store" },
        json: {
          operation: {
            requestId,
            effect: "feedback.create",
            state: "pending",
            result: null,
          },
        },
      });
    }
    if (url.origin !== hostOrigin) return route.abort();
    if (url.pathname === "/host" || url.pathname === "/embedded-host") {
      return route.fulfill({ status: 200, headers: hostHeaders, body: hostHtml });
    }
    if (url.pathname === "/api/review/host.js") {
      return route.fulfill({ contentType: "text/javascript", body: trustedReviewHostScript() });
    }
    if (url.pathname === "/api/review/host.css") {
      return route.fulfill({ contentType: "text/css", body: trustedReviewHostStyles() });
    }
    const contextPath = embedded
      ? "/embed/review/draft-context"
      : "/__shiplet/review/draft-context";
    if (url.pathname === contextPath) {
      draftContextRequests.push(url.toString());
      const expectedKeys = embedded
        ? ["installation_id", "page_url", "revision_id"]
        : ["page_url", "revision_id"];
      const actualKeys = Array.from(url.searchParams.keys()).sort();
      const exactQuery =
        actualKeys.length === expectedKeys.length &&
        actualKeys.every((key, index) => key === expectedKeys.slice().sort()[index]);
      const matchesBinding =
        exactQuery &&
        url.searchParams.get("revision_id") === "revision_recovery" &&
        url.searchParams.get("page_url") === reviewPageUrl &&
        (embedded
          ? url.searchParams.get("installation_id") === syntheticInstallationId
          : !url.searchParams.has("installation_id"));
      if (!matchesBinding) {
        return route.fulfill({
          status: 404,
          headers: { "cache-control": "private, no-store" },
          json: { error: "Review context unavailable" },
        });
      }
      const confirmationContext = options.submissionMode === "confirmation";
      return route.fulfill({
        status: 200,
        headers: { "cache-control": "private, no-store" },
        json: {
          context: {
            actor: {
              kind: confirmationContext ? "human" : "sandbox",
              id: confirmationContext ? "actor_recovery" : "sandbox_recovery",
            },
            projectId: "project_recovery",
            revisionId: "revision_recovery",
            pageUrl: reviewPageUrl,
            installationId: embedded ? syntheticInstallationId : null,
            expiresOn: embedded && confirmationContext ? embeddedContextExpiresOn : null,
            durableOperations: confirmationContext,
          },
        },
      });
    }
    if (url.pathname === "/artifact") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body><button id="review-target">Review target</button>${bridgeScript()}</body></html>`,
      });
    }
    if (
      url.pathname.endsWith("/review-mention-users") ||
      url.pathname.endsWith("/__shiplet/review/mention-users")
    ) {
      return route.fulfill({
        json: {
          users: [{ id: "user_reviewer", name: "Riley", email: "riley@example.test" }],
        },
      });
    }
    if (url.pathname.endsWith("/review-watch")) {
      return route.fulfill({ json: { watch: { watching: false } } });
    }
    if (url.pathname === "/embed/review/thread") {
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><p>Thread confirmation opened</p>",
      });
    }
    if (
      url.pathname.endsWith(`/review-feedback/${feedback.id}/replies`) ||
      url.pathname.endsWith(`/__shiplet/review/feedback/${feedback.id}/replies`)
    ) {
      replyMutationCount += 1;
      const body = (request.postDataJSON() || {}) as Record<string, unknown>;
      if (holdReplies) {
        heldReplies.push({ route, body });
        return;
      }
      feedback = {
        ...feedback,
        replies: [
          ...feedback.replies,
          { comment: String(body.comment || ""), submitted_by_email: "author@example.test" },
        ],
      };
      return route.fulfill({ json: { feedback } });
    }
    if (
      url.pathname.endsWith(`/review-feedback/${feedback.id}/status`) ||
      url.pathname.endsWith(`/__shiplet/review/feedback/${feedback.id}/status`)
    ) {
      statusMutationCount += 1;
      const body = (request.postDataJSON() || {}) as Record<string, unknown>;
      if (holdStatuses) {
        heldStatuses.push({ route, body });
        return;
      }
      feedback = { ...feedback, status: String(body.status || feedback.status) };
      return route.fulfill({ json: { feedback } });
    }
    if (
      url.pathname === "/__shiplet/review/feedback" ||
      url.pathname === "/embed/review/feedback"
    ) {
      if (request.method() === "GET") {
        listRequestCount += 1;
        if (failGet) return route.fulfill({ status: 503, json: { error: "unavailable" } });
        return route.fulfill({ json: { feedback: [feedback], nextCursor: null } });
      }
      commentMutationCount += 1;
      const body = (request.postDataJSON() || {}) as Record<string, unknown>;
      if (holdComments) {
        heldComments.push({ route, body });
        return;
      }
      return route.fulfill({ json: { feedback: { ...feedback, id: "feedback_new", comment: String(body.comment || "") } } });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });

  await page.goto(embedded ? `${siteOrigin}/site` : `${hostOrigin}/host`);
  const surface: Page | FrameLocator = embedded
    ? page.frameLocator("#trusted-host")
    : page;
  await expect(surface.locator("html[data-shiplet-trusted-review-host='v1']")).toBeAttached();
  if (!options.failInitialGet) {
    await expect(surface.locator(".shiplet-review-count")).toHaveText("1");
  }

  return {
    surface,
    setFailGet(value: boolean) {
      failGet = value;
    },
    setHoldReplies(value: boolean) {
      holdReplies = value;
    },
    setHoldStatuses(value: boolean) {
      holdStatuses = value;
    },
    setHoldComments(value: boolean) {
      holdComments = value;
    },
    setHoldOperation(value: boolean) {
      holdOperation = value;
    },
    counts() {
      return {
        replyMutationCount,
        statusMutationCount,
        commentMutationCount,
        listRequestCount,
      };
    },
    heldReplies,
    heldStatuses,
    heldComments,
    heldOperations,
    draftContextRequests,
    operationOutcomeRequests,
    confirmationRequestId() {
      return confirmationRequestId;
    },
    confirmationEffect() {
      return confirmationEffect;
    },
    async probeForeignOperation() {
      const frame = page.frames().find((candidate) => candidate.url().startsWith(hostOrigin));
      if (!frame) throw new Error("Trusted recovery frame unavailable");
      const requestId = confirmationRequestId || "request_foreign";
      return frame.evaluate(({ requestId, reviewPageUrl, syntheticInstallationId }) => {
        const url = new URL(`/embed/review/operations/${encodeURIComponent("foreign_" + requestId)}`, location.origin);
        url.searchParams.set("installation_id", syntheticInstallationId);
        url.searchParams.set("revision_id", "revision_recovery");
        url.searchParams.set("page_url", reviewPageUrl);
        url.searchParams.set("effect", "feedback.create");
        return fetch(url, { credentials: "include", cache: "no-store" }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
      }, { requestId, reviewPageUrl, syntheticInstallationId });
    },
    async releaseReply(result: "success" | "failure") {
      const pending = heldReplies.shift();
      if (!pending) throw new Error("No held reply request");
      if (result === "failure") return pending.route.fulfill({ status: 503, json: { error: "unavailable" } });
      feedback = {
        ...feedback,
        replies: [
          ...feedback.replies,
          { comment: String(pending.body.comment || ""), submitted_by_email: "author@example.test" },
        ],
      };
      return pending.route.fulfill({ json: { feedback } });
    },
    async releaseStatus(result: "success" | "failure") {
      const pending = heldStatuses.shift();
      if (!pending) throw new Error("No held status request");
      if (result === "failure") return pending.route.fulfill({ status: 503, json: { error: "unavailable" } });
      feedback = { ...feedback, status: String(pending.body.status || feedback.status) };
      return pending.route.fulfill({ json: { feedback } });
    },
    async releaseComment(result: "success" | "failure") {
      const pending = heldComments.shift();
      if (!pending) throw new Error("No held comment request");
      if (result === "failure") return pending.route.fulfill({ status: 503, json: { error: "unavailable" } });
      return pending.route.fulfill({
        json: {
          feedback: { ...feedback, id: "feedback_new", comment: String(pending.body.comment || "") },
        },
      });
    },
    async releaseOperation(result: "completed" | "unknown") {
      const pending = heldOperations.shift();
      if (!pending) throw new Error("No held operation request");
      return pending.route.fulfill({
        status: 200,
        headers: { "cache-control": "private, no-store" },
        json: { operation: { requestId: String(pending.body.requestId), effect: "feedback.create", state: result, result: result === "completed" ? { feedbackId: "feedback_mutant" } : null } },
      });
    },
  };
}

async function openHostedThread(page: Page) {
  const pin = page.getByRole("button", { name: "Open PF-7", exact: true });
  await expect(pin).toBeVisible();
  await pin.click();
  const card = page.getByRole("region", { name: "Thread PF-7", exact: true });
  await expect(card).toBeVisible();
  return card;
}

async function openListThread(surface: Page | FrameLocator) {
  await surface.locator(".shiplet-review-comments-launcher").click();
  const row = surface.locator('[data-shiplet-review-thread="feedback_recovery_7"]');
  const summary = row.locator(".shiplet-review-thread-summary");
  await summary.focus();
  await summary.press("Enter");
  await expect(row.locator(".shiplet-review-thread-details")).toBeVisible();
  return row;
}

test("holds one multiline reply through refresh, IME and retry without duplicate writes", async ({ page }) => {
  const fixture = await mountGeneratedHost(page);
  const card = await openHostedThread(page);
  const reply = card.getByRole("textbox", { name: "Reply text for PF-7" });
  await expect(reply).toHaveJSProperty("tagName", "TEXTAREA");

  await reply.fill("First line");
  await reply.press("Enter");
  await reply.type("Second line");
  await expect(reply).toHaveValue("First line\nSecond line");

  await reply.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "文" }));
    for (const init of [
      { key: "Enter" },
      { key: "Escape" },
      { key: "Enter", ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      Object.defineProperty(event, "keyCode", { value: 229 });
      element.dispatchEvent(event);
    }
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "文" }));
  });
  expect(fixture.counts().replyMutationCount).toBe(0);
  await expect(card).toBeVisible();
  await expect(reply).toHaveValue("First line\nSecond line");

  fixture.setHoldReplies(true);
  const firstReply = reply.press("Control+Enter");
  await expect.poll(() => fixture.counts().replyMutationCount).toBe(1);
  await expect(reply).toBeDisabled();
  await expect(card.getByRole("button", { name: "Reply to PF-7" })).toBeDisabled();

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(reply).toHaveValue("First line\nSecond line");
  await card.getByRole("button", { name: "Reply to PF-7" }).click({ force: true });
  expect(fixture.counts().replyMutationCount).toBe(1);

  await fixture.releaseReply("failure");
  await firstReply;
  await expect(reply).toBeEnabled();
  await expect(reply).toHaveValue("First line\nSecond line");
  await expect(card.getByRole("alert")).toContainText(/could not reply|try again/i);

  const retryReply = card.getByRole("button", { name: "Reply to PF-7" }).click();
  await expect.poll(() => fixture.counts().replyMutationCount).toBe(2);
  await fixture.releaseReply("success");
  await retryReply;
  await expect(card).toContainText("First line");
  await expect(card.getByRole("textbox", { name: "Reply text for PF-7" })).toHaveValue("");
});

test("restores confirmed status everywhere after failure and permits one later retry", async ({ page }) => {
  const fixture = await mountGeneratedHost(page);
  const row = await openListThread(page);
  fixture.setHoldStatuses(true);
  await row.locator(".shiplet-review-status-more summary").click({ force: true });
  let select = row.locator('select[aria-label="Status PF-7"]');
  const firstStatusChange = select.press("b");
  await expect.poll(() => fixture.counts().statusMutationCount).toBe(1);
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue("New");

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  select = row.locator('select[aria-label="Status PF-7"]');
  await expect(select).toBeDisabled();
  await select.selectOption("Done", { force: true });
  expect(fixture.counts().statusMutationCount).toBe(1);

  await fixture.releaseStatus("failure");
  await firstStatusChange;
  select = row.locator('select[aria-label="Status PF-7"]');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("New");
  await expect(row).toHaveAttribute("data-confirmed-status", "New");
  await expect(row.getByRole("alert")).toContainText(/could not update|try again/i);

  await row.locator(".shiplet-review-status-more summary").click({ force: true });
  const retryStatusChange = select.press("b");
  await expect.poll(() => fixture.counts().statusMutationCount).toBe(2);
  await fixture.releaseStatus("success");
  await retryStatusChange;
  await expect(row.locator('select[aria-label="Status PF-7"]')).toHaveValue("Blocked");
  await expect(row).toHaveAttribute("data-confirmed-status", "Blocked");
});

test("keeps readable data, active identity, draft focus and selection across stale refresh recovery", async ({ page }) => {
  const fixture = await mountGeneratedHost(page);
  const card = await openHostedThread(page);
  const reply = card.getByRole("textbox", { name: "Reply text for PF-7" });
  await reply.fill("Draft survives a stale refresh");
  await reply.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 14));
  fixture.setFailGet(true);

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const stale = page.locator("[data-shiplet-review-stale]");
  await expect(stale).toBeVisible();
  await expect(stale).toContainText(/showing saved comments|refresh failed/i);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-feedback-id", "feedback_recovery_7");
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue("Draft survives a stale refresh");
  expect(await reply.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([6, 14]);

  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("[data-shiplet-review-stale]")).toHaveCount(1);
  fixture.setFailGet(false);
  await stale.getByRole("button", { name: /Refresh comments/i }).click();
  await expect(stale).toBeHidden();
  await expect(card).toBeVisible();
  await expect(reply).toHaveValue("Draft survives a stale refresh");

  await page.screenshot({ path: `${evidenceRoot}/hosted-recovered-draft.png`, fullPage: true });
});

test("keeps new-comment context on failure and confirmation, while explicit Cancel fully discards it", async ({ page }) => {
  const fixture = await mountGeneratedHost(page, { submissionMode: "sandbox" });
  fixture.setHoldComments(true);
  await page.getByRole("button", { name: /^Annotate/ }).click();
  const composer = page.locator("#shiplet-annotation-composer");
  await expect(composer).toBeVisible();
  const comment = composer.locator("#shiplet-review-comment");
  await comment.fill("Contextual draft with capture and mention");
  await composer.getByRole("button", { name: "Show annotation details and target properties" }).click();
  await composer.getByText("Mention reviewers", { exact: true }).click();
  const mentions = composer.locator(".shiplet-review-mentions select");
  await expect(mentions).toBeVisible();
  await mentions.selectOption("user_reviewer");
  await composer.getByRole("button", { name: "Draw on screenshot", exact: true }).first().click();
  const canvas = page.getByRole("img", { name: "Screenshot drawing canvas" }).or(page.locator("[data-shiplet-annotation-canvas]"));
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Drawing canvas unavailable");
  await page.mouse.move(box.x + 80, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 140, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done drawing" }).click();

  const commentSubmission = composer.getByRole("button", { name: "Send annotation" }).click();
  await expect.poll(() => fixture.counts().commentMutationCount).toBe(1);
  await expect(comment).toBeDisabled();
  await expect(comment).toHaveValue("Contextual draft with capture and mention");
  await expect(composer).toBeVisible();
  await fixture.releaseComment("failure");
  await commentSubmission;
  await expect(comment).toBeEnabled();
  await expect(comment).toHaveValue("Contextual draft with capture and mention");
  await expect(composer.getByRole("alert")).toContainText(/could not be added|try again/i);

  await composer.getByRole("button", { name: "Cancel annotation" }).click();
  await expect(composer).toBeHidden();
  await expect(comment).toHaveValue("");
  expect(await mentions.inputValue()).toBe("");
  await expect(page.locator(".shiplet-review-annotation-editor")).toHaveCount(0);
});

test("embedded pending confirmation retains reply and captured composer state through close and reopen", async ({ page }) => {
  const fixture = await mountGeneratedHost(page, { embedded: true, submissionMode: "confirmation" });
  await expect.poll(() => fixture.draftContextRequests.length).toBeGreaterThan(0);
  const contextRequest = new URL(fixture.draftContextRequests[0]);
  expect(contextRequest.pathname).toBe("/embed/review/draft-context");
  expect(contextRequest.searchParams.get("installation_id")).toBe(syntheticInstallationId);
  expect(contextRequest.searchParams.get("revision_id")).toBe("revision_recovery");
  expect(contextRequest.searchParams.get("page_url")).toBe(`${siteOrigin}/reviewed-page`);
  const surface = fixture.surface;
  const row = await openListThread(surface);
  const reply = row.getByRole("textbox", { name: "Reply text for PF-7" });
  await reply.fill("Embedded pending reply");
  const replyPopup = page.waitForEvent("popup");
  await row.getByRole("button", { name: "Reply to PF-7" }).click({ force: true });
  const openedReply = await replyPopup;
  await expect(reply).toHaveValue("Embedded pending reply");
  await expect(row).toContainText(/awaiting confirmation|reopen confirmation/i);
  if (!openedReply.isClosed()) await openedReply.close();

  await surface.getByRole("button", { name: "New comment" }).click();
  const composer = surface.locator("#shiplet-annotation-composer");
  await expect(composer).toBeVisible();
  const comment = composer.locator("#shiplet-review-comment");
  await comment.fill("Embedded captured draft");
  await comment.press("Meta+Enter");
  await expect(comment).toHaveValue("Embedded captured draft");
  await expect(composer).toBeVisible();
  await expect(composer).toContainText(/awaiting confirmation|secure confirmation/i);
  await expect.poll(() => fixture.operationOutcomeRequests.length).toBeGreaterThan(0);
  await expect.poll(() => fixture.confirmationRequestId()).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
  expect(fixture.confirmationEffect()).toBe("feedback.create");
  const outcomeRequest = new URL(fixture.operationOutcomeRequests[0]);
  expect(outcomeRequest.pathname).toBe(`/embed/review/operations/${encodeURIComponent(fixture.confirmationRequestId())}`);
  expect(Array.from(outcomeRequest.searchParams.keys()).sort()).toEqual(["effect", "installation_id", "page_url", "revision_id"]);
  expect(outcomeRequest.searchParams.get("installation_id")).toBe(syntheticInstallationId);
  expect(outcomeRequest.searchParams.get("revision_id")).toBe("revision_recovery");
  expect(outcomeRequest.searchParams.get("page_url")).toBe(`${siteOrigin}/reviewed-page`);
  expect(outcomeRequest.searchParams.get("effect")).toBe("feedback.create");
  const foreignOutcome = await fixture.probeForeignOperation();
  expect(foreignOutcome.status).toBe(404);
  await expect(composer).toContainText("Awaiting confirmation");

  await page.evaluate((origin) => {
    const frame = document.querySelector<HTMLIFrameElement>("#trusted-host");
    frame?.contentWindow?.postMessage({ protocol: "shiplet.embed.dismiss.v1" }, origin);
  }, hostOrigin);
  await expect(composer).toBeHidden();
  await expect(comment).toHaveValue("Embedded captured draft");
  await surface.locator(".shiplet-review-launcher").press("Enter");
  await expect(composer).toBeVisible();
  await expect(comment).toHaveValue("Embedded captured draft");

  await comment.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "文" }));
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  });
  await expect(composer).toBeVisible();
  await expect(comment).toHaveValue("Embedded captured draft");
  await comment.evaluate((element) => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "文" })));

  await page.screenshot({ path: `${evidenceRoot}/embedded-pending-confirmation.png`, fullPage: true });
});

test("distinguishes an initial load failure from an empty comment list", async ({ page }) => {
  const fixture = await mountGeneratedHost(page, { failInitialGet: true });
  const surface = fixture.surface;
  await surface.locator(".shiplet-review-comments-launcher").click();
  await expect(surface.getByRole("alert")).toContainText(/could not load|refresh/i);
  await expect(surface.getByText(/No comments yet/i)).toHaveCount(0);
});

test("mutant probe retains a later editable version after an older completion", async ({ page }) => {
  const fixture = await mountGeneratedHost(page, { embedded: true, submissionMode: "confirmation", holdOperation: true });
  const surface = fixture.surface;
  const launcher = surface.getByRole("button", {
    name: "Annotate revision_recovery at /reviewed-page",
    exact: true,
  });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const composer = surface.locator("#shiplet-annotation-composer");
  const comment = composer.locator("#shiplet-review-comment");
  await comment.fill("immutable version");
  await comment.press("Meta+Enter");
  await expect.poll(() => fixture.operationOutcomeRequests.length).toBeGreaterThan(0);
  await expect.poll(() => fixture.heldOperations.length).toBeGreaterThan(0);
  await comment.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.value = "later editable version";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await fixture.releaseOperation("completed");
  await expect.poll(() => comment.inputValue()).toBe("later editable version");
});

test("mutant probe keeps an unknown operation public and tied to its original receipt", async ({ page }) => {
  const fixture = await mountGeneratedHost(page, {
    embedded: true,
    submissionMode: "confirmation",
    unknownOperation: true,
  });
  const surface = fixture.surface;
  const launcher = surface.getByRole("button", {
    name: "Annotate revision_recovery at /reviewed-page",
    exact: true,
  });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const composer = surface.locator("#shiplet-annotation-composer");
  const comment = composer.locator("#shiplet-review-comment");
  await comment.fill("Unknown outcome draft");
  await comment.press("Meta+Enter");
  await expect.poll(() => fixture.operationOutcomeRequests.length).toBeGreaterThan(0);
  const requestId = fixture.confirmationRequestId();
  expect(requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
  await expect(composer).toContainText("Submission status is unknown");
  await expect(composer).not.toContainText("Feedback saved.");
  await expect(comment).toHaveValue("Unknown outcome draft");
  await expect(composer.getByRole("button", { name: "Send annotation" })).toBeDisabled();
  const outcomeRequest = new URL(fixture.operationOutcomeRequests.at(-1)!);
  expect(outcomeRequest.pathname).toBe(`/embed/review/operations/${encodeURIComponent(requestId)}`);
  expect(Array.from(outcomeRequest.searchParams.keys()).sort()).toEqual([
    "effect",
    "installation_id",
    "page_url",
    "revision_id",
  ]);
  expect(outcomeRequest.searchParams.get("effect")).toBe("feedback.create");
  expect(outcomeRequest.searchParams.get("installation_id")).toBe(syntheticInstallationId);
  expect(outcomeRequest.searchParams.get("page_url")).toBe(`${siteOrigin}/reviewed-page`);
  expect(outcomeRequest.searchParams.get("revision_id")).toBe("revision_recovery");
  const hostFrame = page.frames().find((candidate) => candidate.url().startsWith(hostOrigin));
  if (!hostFrame) throw new Error("Trusted recovery frame unavailable");
  const receipt = await hostFrame.evaluate((expectedRequestId) => new Promise<unknown>((resolve) => {
    const request = indexedDB.open("shiplet-review-drafts-v1");
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("drafts", "readonly").objectStore("drafts").getAll();
      read.onerror = () => resolve(null);
      read.onsuccess = () => resolve((read.result as Array<Record<string, unknown>>).find((record) => Array.isArray(record.operations) && (record.operations as Array<Record<string, unknown>>).some((operation) => operation.requestId === expectedRequestId)) || null);
    };
  }), requestId);
  expect(receipt).toEqual(expect.objectContaining({
    context: expect.objectContaining({
      actorKind: "human",
      actorId: "actor_recovery",
      projectId: "project_recovery",
      revisionId: "revision_recovery",
      pageUrl: `${siteOrigin}/reviewed-page`,
      installationId: syntheticInstallationId,
    }),
  }));
  const receiptRecord = receipt as { operations?: Array<Record<string, unknown>> } | null;
  expect(receiptRecord?.operations?.at(-1)).toEqual(expect.objectContaining({
    requestId,
    effect: "feedback.create",
    feedbackId: null,
    state: "unknown",
    immutablePayload: expect.objectContaining({ comment: "Unknown outcome draft" }),
  }));
});
