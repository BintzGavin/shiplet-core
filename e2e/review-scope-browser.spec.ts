import { expect, test, type FrameLocator, type Page, type Route } from "@playwright/test";

import {
  createTrustedReviewHostResponse,
  trustedReviewHostScript,
  trustedReviewHostStyles,
} from "../src/trusted-review-host";
import {
  authHeaders,
  createOrganization,
  createReviewFeedback,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test.use({
  viewport: { width: 1180, height: 820 },
  screenshot: "off",
  trace: "off",
  video: "off",
});

const hostOrigin = "http://q2.localhost:8822";
const siteOrigin = "http://q2-site.localhost:8822";
const currentPageUrl = `${siteOrigin}/docs/start?view=review#/section?tab=notes`;
const evidenceRoot = "/private/tmp/shiplet-parity-query-q2-20260920";

type Mode = "hosted" | "embedded";
type Feedback = ReturnType<typeof feedbackRecord>;

function feedbackRecord(index: number, overrides: Partial<{
  pageUrl: string;
  revisionId: string | null;
  status: string;
  submittedByUserId: string;
}> & { pageComment?: boolean } = {}) {
  const { pageComment = false } = overrides;
  return {
    id: `feedback_scope_${String(index).padStart(3, "0")}`,
    ticket_label: `PF-${index}`,
    ticket_number: index,
    comment: `Scoped comment ${index}`,
    status: overrides.status || "New",
    page_url: overrides.pageUrl || currentPageUrl,
    revision_id: overrides.revisionId === undefined ? "revision_scope_current" : overrides.revisionId,
    submitted_by_user_id: overrides.submittedByUserId || "user_other",
    submitted_by_email: `${overrides.submittedByUserId === "user_me" ? "me" : "reviewer"}@example.test`,
    replies: [],
    ...(pageComment ? {} : {
      coordinates: {
        pageX: 80 + (index % 12) * 26,
        pageY: 120 + (index % 16) * 25,
        viewportX: 80 + (index % 12) * 26,
        viewportY: 120 + (index % 16) * 25,
      },
      selected_element: {
        selector: "#review-target",
        tagName: "BUTTON",
        text: "Review target",
      },
      capture_context: {
        documentWidth: 1180,
        documentHeight: 900,
        scrollX: 0,
        scrollY: 0,
      },
    }),
    created_on: `2026-09-20T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  };
}

function pageKey(value: string) {
  const url = new URL(value);
  url.search = "";
  if (url.hash.startsWith("#/") && !url.hash.startsWith("#//")) url.hash = url.hash.split("?")[0];
  else url.hash = "";
  return url.origin + url.pathname + url.hash;
}

function fixtureRows(options: { pageComment?: boolean } = {}) {
  const rows = Array.from({ length: 255 }, (_, offset) => feedbackRecord(offset + 1));
  if (options.pageComment) rows[0] = feedbackRecord(1, { pageComment: true });
  rows[1] = feedbackRecord(2, { revisionId: null });
  rows[2] = feedbackRecord(3, { revisionId: "revision_scope_earlier" });
  rows[252] = feedbackRecord(253, { status: "Staging", submittedByUserId: "user_me" });
  rows[254] = feedbackRecord(255, {
    pageUrl: `${siteOrigin}/docs/start?another=view#/section?private=removed`,
  });
  rows.push(feedbackRecord(256, { pageUrl: `${siteOrigin}/docs/other`, status: "Done" }));
  rows.push(feedbackRecord(257, { pageUrl: `${siteOrigin}/docstring`, status: "Dropped" }));
  rows.push(feedbackRecord(258, { status: "Done" }));
  return rows;
}

function responseRows(allRows: Feedback[], url: URL) {
  let rows = allRows.slice();
  const state = url.searchParams.get("state") || "open";
  if (state === "open") rows = rows.filter((row) => row.status !== "Done" && row.status !== "Dropped");
  if (state === "closed") rows = rows.filter((row) => row.status === "Done" || row.status === "Dropped");
  const pageUrl = url.searchParams.get("pageUrl") || url.searchParams.get("page_url");
  const scope = url.searchParams.get("scope");
  const pagePrefix = url.searchParams.get("pagePrefix");
  if ((scope === "page" || (!scope && pageUrl)) && pageUrl) {
    rows = rows.filter((row) => pageKey(row.page_url) === pageKey(pageUrl));
  } else if (scope === "prefix" || pagePrefix) {
    const prefix = new URL(pagePrefix || currentPageUrl);
    rows = rows.filter((row) => {
      const candidate = new URL(row.page_url);
      return candidate.origin === prefix.origin &&
        (candidate.pathname === prefix.pathname || candidate.pathname.startsWith(`${prefix.pathname.replace(/\/$/, "")}/`));
    });
  } else if (scope === "site") {
    rows = rows.filter((row) => new URL(row.page_url).origin === siteOrigin);
  }
  const revisionId = url.searchParams.get("revisionId");
  if (revisionId) rows = rows.filter((row) => row.revision_id === revisionId);
  if (url.searchParams.get("submittedByMe") === "true") {
    rows = rows.filter((row) => row.submitted_by_user_id === "user_me");
  }
  if (url.searchParams.get("mentionedMe") === "true") rows = [];
  return rows;
}

async function mountScopeFixture(page: Page, mode: Mode, options: {
  embeddedPageBindingProbe?: boolean;
  mentionsUnsupported?: boolean;
  pageComment?: boolean;
} = {}) {
  let rows = fixtureRows({ pageComment: options.pageComment });
  if (options.embeddedPageBindingProbe && mode === "embedded") {
    rows = [
      feedbackRecord(1),
      ...Array.from({ length: 99 }, (_, offset) => feedbackRecord(300 + offset, {
        pageUrl: `${siteOrigin}/hosted/${offset}`,
      })),
    ];
  }
  let heldPage: Route | null = null;
  let holdCursor = false;
  let failCursorOnce = false;
  const listUrls: string[] = [];
  const postedStatuses: string[] = [];
  const response = createTrustedReviewHostResponse({
    shipletId: "project_scope",
    revisionId: "revision_scope_current",
    title: "Scoped review",
    artifactUrl: `${hostOrigin}/artifact`,
    widgetUrl: null,
    hostScriptUrl: `${hostOrigin}/api/review/host.js`,
    reviewApiUrl: mode === "embedded"
      ? `${hostOrigin}/embed/review/feedback?installation_id=installation_scope&page_url=${encodeURIComponent(currentPageUrl)}`
      : `${hostOrigin}/__shiplet/review/feedback`,
    confirmationUrl: `${hostOrigin}/review/confirm`,
    reviewPageUrl: currentPageUrl,
    submissionMode: "sandbox",
    ...(mode === "embedded" ? {
      embeddedSiteOrigin: siteOrigin,
      frameAncestorOrigins: [siteOrigin],
    } : {}),
  });
  const hostHtml = await response.text();
  const hostHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => { hostHeaders[name] = value; });

  await page.addInitScript(() => {
    Object.defineProperty(window, "WebSocket", { configurable: true, value: undefined });
    try {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("Storage blocked", "SecurityError"); },
      });
    } catch {}
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === siteOrigin && url.pathname === "/docs/start") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body><button id="review-target">Review target</button><script>window.scopePinMessages=[];addEventListener("message",event=>{if(event.data?.protocol==="shiplet.embed.ui.v1"&&Array.isArray(event.data.pins))window.scopePinMessages.push(event.data.pins);});</script><iframe id="trusted-host" style="width:100%;height:760px;border:0" src="${hostOrigin}/embedded-host"></iframe></body></html>`,
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
    if (url.pathname === "/artifact") {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><button id='review-target'>Review target</button>" });
    }
    if (url.pathname.endsWith("review-mention-users") || url.pathname.endsWith("review-watch")) {
      return route.fulfill({ json: url.pathname.endsWith("review-watch") ? { watch: { watching: false } } : { users: [] } });
    }
    if (/\/feedback\/feedback_scope_\d+\/status$/.test(url.pathname)) {
      const status = String((request.postDataJSON() as { status?: string } | null)?.status || "");
      postedStatuses.push(status);
      const id = url.pathname.match(/(feedback_scope_\d+)\/status$/)?.[1];
      const found = rows.find((row) => row.id === id);
      if (found) found.status = status;
      return route.fulfill({ json: { feedback: found } });
    }
    if (url.pathname === "/__shiplet/review/feedback" || url.pathname === "/embed/review/feedback") {
      if (request.method() !== "GET") return route.fulfill({ status: 405, body: "Method not allowed" });
      listUrls.push(url.toString());
      if (options.mentionsUnsupported && url.searchParams.get("mentionedMe") === "true") {
        return route.fulfill({
          status: 409,
          headers: { "cache-control": "no-store" },
          json: { error: "sandbox_filter_unsupported", filter: "mentionedMe" },
        });
      }
      const cursor = url.searchParams.get("cursor");
      if (cursor && holdCursor && !heldPage) { heldPage = route; return; }
      if (cursor && failCursorOnce) {
        failCursorOnce = false;
        return route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
      }
      const filtered = responseRows(rows, url);
      const offset = cursor ? Number(cursor.replace("cursor-", "")) : 0;
      const limit = Number(url.searchParams.get("limit") || 100);
      const feedback = filtered.slice(offset, offset + limit);
      const nextCursor = offset + feedback.length < filtered.length ? `cursor-${offset + feedback.length}` : null;
      return route.fulfill({ json: { feedback, nextCursor } });
    }
    if (url.pathname === "/review/confirm") return route.fulfill({ contentType: "text/html", body: "Confirmed" });
    return route.fulfill({ status: 404, body: "Not found" });
  });

  await page.goto(mode === "embedded" ? currentPageUrl : `${hostOrigin}/host`);
  const surface: Page | FrameLocator = mode === "embedded" ? page.frameLocator("#trusted-host") : page;
  await expect(surface.locator("html[data-shiplet-trusted-review-host='v1']")).toBeAttached();
  return {
    surface,
    listUrls,
    postedStatuses,
    setHoldCursor(value: boolean) { holdCursor = value; },
    setFailCursorOnce() { failCursorOnce = true; },
    async releaseHeldPage() {
      if (!heldPage) throw new Error("No held page request");
      const route = heldPage;
      heldPage = null;
      const url = new URL(route.request().url());
      const filtered = responseRows(rows, url);
      const offset = Number((url.searchParams.get("cursor") || "cursor-0").replace("cursor-", ""));
      const feedback = filtered.slice(offset, offset + 100);
      await route.fulfill({ json: { feedback, nextCursor: offset + feedback.length < filtered.length ? `cursor-${offset + feedback.length}` : null } });
    },
  };
}

test("embedded Current page sends its trusted page binding and excludes hosted rows", async ({ page }) => {
  const fixture = await mountScopeFixture(page, "embedded", { embeddedPageBindingProbe: true });
  const surface = fixture.surface;
  await surface.locator(".shiplet-review-comments-launcher").click();
  await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_001']")).toBeVisible();
  await expect(surface.locator("[data-shiplet-review-thread^='feedback_scope_3']")).toHaveCount(0);
  const requestUrl = new URL(fixture.listUrls[0]);
  expect(requestUrl.searchParams.get("scope")).toBe("page");
  expect(requestUrl.searchParams.get("pageUrl")).toBe(currentPageUrl);
});

test("embedded Page comments leaves New comment actionable", async ({ page }) => {
  const fixture = await mountScopeFixture(page, "embedded", { pageComment: true });
  const surface = fixture.surface;
  await surface.locator(".shiplet-review-comments-launcher").click();
  await expect(surface.getByRole("button", { name: /^Page comments/ })).toBeVisible();
  const compose = surface.getByRole("button", { name: "New comment" });
  await expect(compose).toBeVisible();
  await compose.click();
  await expect(surface.locator("[data-shiplet-annotation-modebar]"))
    .toBeVisible();
});

for (const mode of ["hosted", "embedded"] as const) {
  test(`${mode} retains the previous scope and drafts through unsupported Mentions`, async ({ page }) => {
    const fixture = await mountScopeFixture(page, mode, { mentionsUnsupported: true });
    const surface = fixture.surface;
    await surface.locator(".shiplet-review-comments-launcher").click();
    const row = surface.locator("[data-shiplet-review-thread='feedback_scope_001']");
    await row.locator(".shiplet-review-thread-summary").click();
    const reply = row.getByRole("textbox", { name: "Reply text for PF-1" });
    await reply.fill("Draft survives unsupported Mentions");

    await surface.locator(".shiplet-review-filters > summary").click();
    const peopleFilter = surface.getByRole("combobox", { name: "People" });
    await peopleFilter.press("m");
    await peopleFilter.press("m");
    const stale = surface.locator("[data-shiplet-review-stale]");
    await expect(row).toBeVisible();
    await expect(reply).toHaveValue("Draft survives unsupported Mentions");
    await expect(stale).toContainText(/Mentions is unavailable in this sandbox/i);
    await expect(stale).toContainText(/previously loaded scope/i);
    await expect(stale).toContainText(/not Mentions results/i);
    await expect(stale.getByRole("button", { name: "Retry Mentions" })).toBeVisible();
    await expect(surface.getByRole("button", { name: "Reset comment filters" })).toBeVisible();

    await stale.getByRole("button", { name: "Retry Mentions" }).click();
    await expect(row).toBeVisible();
    await expect(reply).toHaveValue("Draft survives unsupported Mentions");

    await peopleFilter.press("e");
    await expect(stale).toBeHidden();
    await expect(row).toBeVisible();
    await expect(reply).toHaveValue("Draft survives unsupported Mentions");
  });
}

for (const mode of ["hosted", "embedded"] as const) {
  test(`${mode} browses every modern page with truthful filters, provenance, links and pins`, async ({ page }) => {
    const fixture = await mountScopeFixture(page, mode);
    const surface = fixture.surface;
    await surface.locator(".shiplet-review-comments-launcher").click();

    await expect(surface.locator(".shiplet-review-filters > summary")).toHaveText("Filters");
    await expect(surface.locator("[data-shiplet-review-scope-summary]")).toContainText("Current page · Open · All revisions · Everyone");
    await expect(surface.locator("[data-shiplet-review-loaded-count]")).toContainText("100 comments loaded");
    await expect(surface.getByRole("button", { name: "Load more comments" })).toBeVisible();
    await surface.getByRole("button", { name: "Load more comments" }).click();
    await surface.getByRole("button", { name: "Load more comments" }).click();
    await expect(surface.locator("[data-shiplet-review-loaded-count]")).toContainText("255 comments loaded · End of results");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_255']")).toBeVisible();
    await expect(surface.locator("[data-shiplet-review-pin-limit]")).toContainText("250 of 255 page pins shown");
    if (mode === "embedded") {
      await expect.poll(() => page.evaluate(() => (window as unknown as { scopePinMessages: unknown[][] }).scopePinMessages.at(-1)?.length || 0)).toBe(250);
    }

    let stagingRow = surface.locator("[data-shiplet-review-thread='feedback_scope_253']");
    await expect(stagingRow.locator("[data-shiplet-review-collapsed-status]")).toHaveText("Staging");
    await stagingRow.locator(".shiplet-review-thread-summary").click();
    stagingRow = surface.locator("[data-shiplet-review-thread='feedback_scope_253']");
    await expect(stagingRow.locator('select[aria-label="Status PF-253"] option')).toHaveText([
      "New", "In Progress", "Blocked", "Staging", "Done", "Dropped",
    ]);
    await expect(stagingRow.locator("[data-shiplet-review-provenance]")).toContainText("Current revision");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_002'] [data-shiplet-review-provenance]")).toContainText("Earlier feedback");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_003'] [data-shiplet-review-provenance]")).toContainText("Earlier revision");
    const link = stagingRow.getByRole("link", { name: "Open feedback PF-253" });
    await expect(link).toHaveAttribute("href", `${hostOrigin}/shiplets/project_scope?feedback=feedback_scope_253`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    const linkDraft = stagingRow.getByRole("textbox", { name: "Reply text for PF-253" });
    await linkDraft.fill("Draft survives a canonical link click");
    await page.context().route(`${hostOrigin}/shiplets/**`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Trusted feedback</title>" }));
    const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await expect.poll(() => popup.url()).toBe(`${hostOrigin}/shiplets/project_scope?feedback=feedback_scope_253`);
    await popup.close();
    await expect(linkDraft).toHaveValue("Draft survives a canonical link click");

    await surface.locator(".shiplet-review-filters > summary").click();
    await surface.getByRole("combobox", { name: "Revision" }).press("c");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_002']")).toHaveCount(0);
    await expect(surface.locator("[data-shiplet-review-scope-summary]")).toContainText("Current revision");

    const peopleFilter = surface.getByRole("combobox", { name: "People" });
    await peopleFilter.press("m");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_253']")).toBeVisible();
    expect(new URL(fixture.listUrls.at(-1)!).searchParams.get("submittedByMe")).toBe("true");
    await page.waitForTimeout(1_100);
    await peopleFilter.press("e");
    await expect.poll(() => new URL(fixture.listUrls.at(-1) || hostOrigin).searchParams.has("submittedByMe")).toBe(false);

    await surface.getByRole("combobox", { name: "Page scope" }).selectOption("prefix");
    await expect(surface.getByRole("textbox", { name: "Path prefix URL" })).toBeVisible();
    const requestsBeforeInvalidPrefix = fixture.listUrls.length;
    await surface.getByRole("textbox", { name: "Path prefix URL" }).fill("https://attacker.example/docs");
    await surface.getByRole("button", { name: "Apply prefix" }).click();
    await expect(surface.getByRole("alert")).toContainText("authorized review origin");
    expect(fixture.listUrls).toHaveLength(requestsBeforeInvalidPrefix);
    await surface.getByRole("textbox", { name: "Path prefix URL" }).fill(`${siteOrigin}/docs`);
    await surface.getByRole("button", { name: "Apply prefix" }).click();
    await expect.poll(() => new URL(fixture.listUrls.at(-1) || hostOrigin).searchParams.get("pagePrefix")).toBe(`${siteOrigin}/docs`);
    await surface.getByRole("combobox", { name: "State" }).press("c");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_256']")).toBeVisible();
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_257']")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(surface.locator(".shiplet-review-filters > summary")).toBeVisible();
    const filterBounds = await surface.locator(".shiplet-review-filter-bar").boundingBox();
    expect(filterBounds).not.toBeNull();
    expect(filterBounds!.x).toBeGreaterThanOrEqual(0);
    expect(filterBounds!.x + filterBounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${evidenceRoot}/${mode}-scope-narrow.png`, fullPage: true });
  });

  test(`${mode} rejects stale cursor results and recovers the same failed cursor without losing a draft`, async ({ page }) => {
    const fixture = await mountScopeFixture(page, mode);
    const surface = fixture.surface;
    await surface.locator(".shiplet-review-comments-launcher").click();
    await surface.locator("[data-shiplet-review-thread='feedback_scope_001'] .shiplet-review-thread-summary").click();
    const draft = surface.getByRole("textbox", { name: "Reply text for PF-1" });
    await draft.fill("Keep this draft through cursor recovery");

    fixture.setHoldCursor(true);
    await surface.getByRole("button", { name: "Load more comments" }).click();
    await expect(surface.getByRole("button", { name: "Load more comments" })).toBeDisabled();
    await expect.poll(() => fixture.listUrls.filter((value) => new URL(value).searchParams.get("cursor") === "cursor-100").length).toBe(1);
    await surface.getByRole("button", { name: "Load more comments" }).evaluate((button) => (button as HTMLButtonElement).click());
    expect(fixture.listUrls.filter((value) => new URL(value).searchParams.get("cursor") === "cursor-100")).toHaveLength(1);
    await surface.locator(".shiplet-review-filters > summary").click();
    await surface.getByRole("combobox", { name: "State" }).press("c");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_258']")).toBeVisible();
    await fixture.releaseHeldPage();
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_101']")).toHaveCount(0);

    await surface.getByRole("button", { name: "Reset comment filters" }).click();
    await surface.locator(".shiplet-review-filters > summary").click();
    const restoredThreadSummary = surface.locator("[data-shiplet-review-thread='feedback_scope_001'] .shiplet-review-thread-summary");
    if (await restoredThreadSummary.getAttribute("aria-expanded") !== "true") {
      await restoredThreadSummary.click();
    }
    await expect(surface.getByRole("textbox", { name: "Reply text for PF-1" })).toHaveValue("Keep this draft through cursor recovery");
    fixture.setHoldCursor(false);
    fixture.setFailCursorOnce();
    await surface.getByRole("button", { name: "Load more comments" }).click();
    await expect(surface.getByRole("alert")).toContainText("Could not load more comments");
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_001']")).toBeVisible();
    await surface.getByRole("button", { name: "Retry loading comments" }).click();
    await expect(surface.locator("[data-shiplet-review-thread='feedback_scope_101']")).toBeVisible();
    await expect(surface.getByRole("textbox", { name: "Reply text for PF-1" })).toHaveValue("Keep this draft through cursor recovery");

    expect(fixture.listUrls.every((value) => new URL(value).searchParams.get("limit") === "100")).toBe(true);
    await page.screenshot({ path: `${evidenceRoot}/${mode}-scope-browser.png`, fullPage: true });
  });
}

test("hosted resolved feedback leaves the Open list while its reply draft survives", async ({ page }) => {
  const fixture = await mountScopeFixture(page, "hosted");
  const surface = fixture.surface;
  await surface.locator(".shiplet-review-comments-launcher").click();
  const row = surface.locator("[data-shiplet-review-thread='feedback_scope_001']");
  await row.locator(".shiplet-review-thread-summary").click();
  await surface.getByRole("textbox", { name: "Reply text for PF-1" }).fill("Unsent status-change draft");
  await row.locator(".shiplet-review-status-more > summary").click();
  await surface.getByRole("combobox", { name: "Status PF-1" }).press("d");
  await expect.poll(() => fixture.postedStatuses).toEqual(["Done"]);
  await expect(row).toHaveCount(0);

  await surface.locator(".shiplet-review-filters > summary").click();
  const stateFilter = surface.getByRole("combobox", { name: "State" });
  await stateFilter.press("c");
  await expect.poll(() => new URL(fixture.listUrls.at(-1) || hostOrigin).searchParams.get("state")).toBe("closed");
  await page.waitForTimeout(1_100);
  await stateFilter.press("o");
  await expect.poll(() => new URL(fixture.listUrls.at(-1) || hostOrigin).searchParams.get("state")).toBe("all");
  const restored = surface.locator("[data-shiplet-review-thread='feedback_scope_001']");
  await expect(restored).toBeVisible();
  await surface.locator(".shiplet-review-filters > summary").click();
  await restored.locator(".shiplet-review-thread-summary").click();
  await expect(surface.getByRole("textbox", { name: "Reply text for PF-1" })).toHaveValue("Unsent status-change draft");
});

test("real local D1 retrieval applies Q1 page, state and revision filters through the generated host", async ({
  baseURL,
  page,
  request,
}) => {
  test.skip(!baseURL, "Requires the local Worker fixture");
  const actor = testUser("q2-real-d1");
  const organization = await createOrganization(request, actor);
  const published = await publishStaticShiplet(request, actor, organization.id, {
    name: `Q2 real D1 ${Date.now()}`,
    html: "<!doctype html><button id='review-target'>Review target</button>",
  });
  const first = await createReviewFeedback(request, actor, published.project, {
    comment: "Current page open feedback",
  });
  const closed = await createReviewFeedback(request, actor, published.project, {
    comment: "Current page closed feedback",
  });
  const offPage = await request.post(
    `/api/projects/${encodeURIComponent(published.project.id)}/review-feedback`,
    {
      headers: {
        ...authHeaders(actor),
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
      },
      data: {
        clientFeedbackId: `q2-off-page-${Date.now()}`,
        comment: "Different page feedback",
        name: actor.email,
        pageUrl: new URL(`/${published.project.subdomain}/docs`, "http://localhost:8787").toString(),
        screenshotMode: "page",
        mentions: [],
        viewport: { width: 1180, height: 820 },
      },
    },
  );
  const offPageText = await offPage.text();
  expect(offPage.ok(), offPageText).toBe(true);
  const offPageBody = JSON.parse(offPageText) as { feedback: { id: string } };
  const closedResponse = await request.post(
    `/api/projects/${encodeURIComponent(published.project.id)}/review-feedback/${encodeURIComponent(closed.feedback.id)}/status`,
    {
      headers: {
        ...authHeaders(actor),
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
      },
      data: { status: "Done" },
    },
  );
  expect(closedResponse.ok(), await closedResponse.text()).toBe(true);

  const listUrls: string[] = [];
  page.on("request", (value) => {
    if (value.method() === "GET" && value.url().includes("/__shiplet/review/feedback?")) listUrls.push(value.url());
  });
  await loginAs(page, actor);
  await page.goto(`/${published.project.subdomain}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".shiplet-review-count")).toHaveText("1");
  await page.locator(".shiplet-review-comments-launcher").click();
  await expect(page.locator(`[data-shiplet-review-thread="${first.feedback.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-shiplet-review-thread="${closed.feedback.id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-shiplet-review-thread="${offPageBody.feedback.id}"]`)).toHaveCount(0);

  await page.locator(".shiplet-review-filters > summary").click();
  await page.getByRole("combobox", { name: "State" }).press("c");
  await expect(page.locator(`[data-shiplet-review-thread="${closed.feedback.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-shiplet-review-thread="${first.feedback.id}"]`)).toHaveCount(0);
  await page.getByRole("combobox", { name: "Revision" }).press("c");
  await expect(page.locator(`[data-shiplet-review-thread="${closed.feedback.id}"]`)).toBeVisible();
  expect(listUrls.some((value) => {
    const url = new URL(value);
    return url.searchParams.get("state") === "closed" &&
      url.searchParams.get("revisionId") &&
      url.searchParams.get("pageUrl") === new URL(`/${published.project.subdomain}`, "http://localhost:8787").toString();
  })).toBe(true);

  await page.getByRole("button", { name: "Reset comment filters" }).click();
  await page.getByRole("combobox", { name: "Page scope" }).press("a");
  await expect(page.locator(`[data-shiplet-review-thread="${offPageBody.feedback.id}"]`)).toBeVisible();
});
