import { Buffer } from "node:buffer";

import { expect, test, type Request } from "@playwright/test";

import {
  authHeaders,
  collectPageErrors,
  createOrganization,
  createReviewFeedback,
  establishMembership,
  expectNoPageErrors,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test.describe("feedback and inbox through the trusted review host", () => {
  test("updates the trusted live count after inline managed feedback", async ({
    page,
    request,
  }) => {
    const user = testUser("live-comment");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, user);
    const name = `Live Comment Shiplet ${Date.now()}`;
    const published = await publishStaticShiplet(request, user, organization.id, {
      name,
      html: `<!doctype html><title>${name}</title><h1 style="margin-top:120px">${name}</h1>`,
    });
    const comment = `Live shiplet comment ${Date.now()}`;
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".shiplet-review-count")).toHaveText("0");
    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await page
      .frameLocator("[data-shiplet-artifact-frame]")
      .getByRole("heading")
      .first()
      .click();
    await page.locator("#shiplet-review-comment").fill(comment);
    let popupCount = 0;
    page.on("popup", () => { popupCount += 1; });
    const apiUrl = await page.locator("html").getAttribute("data-review-api-url");
    expect(apiUrl).toBeTruthy();
    const saved = page.waitForResponse((response) =>
      response.url() === apiUrl &&
      response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator(".shiplet-review-status")).toHaveText("Feedback sent.");
    expect(popupCount).toBe(0);
    await page.locator(".shiplet-review-comments-launcher").click();
    await page.getByLabel("Review options").click();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".shiplet-review-count")).toHaveText("1");
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);
    await expectNoPageErrors(errors);
  });

  test("retries a committed inline comment after a lost response without duplicating it", async ({ page, request }) => {
    const user = testUser("inline-retry");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: `Inline Retry Shiplet ${Date.now()}`,
      html: "<!doctype html><title>Retry target</title><h1 id='retry-target' style='margin-top:120px'>Retry target</h1>",
    });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await page.frameLocator("[data-shiplet-artifact-frame]").locator("#retry-target").click();
    const comment = `Keep this captured draft ${Date.now()}`;
    const composer = page.locator("#shiplet-annotation-composer");
    const commentField = composer.getByRole("textbox", { name: "Annotation", exact: true });
    const composerMessage = composer.locator(".shiplet-review-composer-message");
    await commentField.fill(comment);
    const submitted: Array<{
      requestId: unknown;
      clientFeedbackId: unknown;
      reviewRevisionId: unknown;
      body: Buffer | null;
    }> = [];
    const directPostDiagnostics: Array<{
      ordinal: number;
      status: number | null;
      networkCode: string | null;
    }> = [];
    const directPostOrdinals = new Map<Request, number>();
    const allowedNetworkCodes = new Set([
      "ERR_ABORTED",
      "ERR_FAILED",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_RESET",
      "ERR_TIMED_OUT",
    ]);
    let popupCount = 0;
    page.on("popup", () => { popupCount += 1; });
    const apiUrl = await page.locator("html").getAttribute("data-review-api-url");
    expect(apiUrl).toBeTruthy();
    let directPostOrdinal = 0;
    page.on("request", (observedRequest) => {
      if (
        observedRequest.method() !== "POST" ||
        observedRequest.url() !== String(apiUrl)
      ) return;
      directPostOrdinal += 1;
      directPostOrdinals.set(observedRequest, directPostOrdinal);
      directPostDiagnostics.push({
        ordinal: directPostOrdinal,
        status: null,
        networkCode: null,
      });
    });
    page.on("response", (response) => {
      const ordinal = directPostOrdinals.get(response.request());
      if (ordinal === undefined) return;
      directPostDiagnostics[ordinal - 1].status = response.status();
    });
    page.on("requestfailed", (failedRequest) => {
      const ordinal = directPostOrdinals.get(failedRequest);
      if (ordinal === undefined) return;
      const errorCode = failedRequest
        .failure()
        ?.errorText.match(/ERR_[A-Z_]+/)?.[0];
      directPostDiagnostics[ordinal - 1].networkCode =
        errorCode && allowedNetworkCodes.has(errorCode) ? errorCode : "OTHER";
    });
    await page.route(String(apiUrl), async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      submitted.push({
        requestId: payload.requestId,
        clientFeedbackId: payload.clientFeedbackId,
        reviewRevisionId: payload.reviewRevisionId,
        body: route.request().postDataBuffer(),
      });
      if (submitted.length === 1) {
        const committed = await route.fetch();
        directPostDiagnostics[0].status = committed.status();
        expect(committed.ok()).toBe(true);
        return route.abort("failed");
      }
      return route.continue();
    });
    const send = composer.getByRole("button", { name: "Send annotation", exact: true });
    await send.click();
    await expect(composerMessage).toContainText(/retry the same submission/i);
    await expect(commentField).toHaveValue(comment);
    await expect(composer.locator(".shiplet-review-target")).toContainText("retry-target");
    const retry = composer.getByRole("button", {
      name: "Retry submission",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => submitted.length).toBe(2);
    await expect.poll(() => directPostDiagnostics[1]).toMatchObject({
      ordinal: 2,
      status: expect.any(Number),
    });
    await expect(composerMessage).toHaveText("Feedback sent");
    await expect(composer).toBeHidden();
    expect(submitted).toHaveLength(2);
    const firstSubmission = submitted[0];
    const secondSubmission = submitted[1];
    for (const key of [
      "requestId",
      "clientFeedbackId",
      "reviewRevisionId",
    ] as const) {
      const firstValue = firstSubmission[key];
      const secondValue = secondSubmission[key];
      expect(typeof firstValue === "string" && firstValue.length > 0).toBe(true);
      expect(typeof secondValue === "string" && secondValue.length > 0).toBe(true);
      expect(firstValue === secondValue).toBe(true);
    }
    expect(
      firstSubmission.body !== null &&
        secondSubmission.body !== null &&
        firstSubmission.body.length > 0 &&
        secondSubmission.body.length > 0 &&
        Buffer.compare(firstSubmission.body, secondSubmission.body) === 0,
    ).toBe(true);
    expect(popupCount).toBe(0);
    await page.locator(".shiplet-review-comments-launcher").click();
    await expect(page.locator(".shiplet-review-count")).toHaveText("1");
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);

    const feedbackResponse = await request.get(
      `/api/projects/${encodeURIComponent(published.project.id)}/review-feedback?includeClosed=true`,
      {
        headers: {
          ...authHeaders(user),
          Origin: "http://localhost:8787",
        },
      },
    );
    expect(feedbackResponse.ok()).toBe(true);
    const durableResult = (await feedbackResponse.json()) as {
      feedback: Array<{
        id: string;
        client_feedback_id: string;
        revision_id: string | null;
        submitted_by_user_id: string | null;
        selected_element: { selector?: string } | null;
      }>;
    };
    expect(durableResult.feedback).toHaveLength(1);
    const durableFeedback = durableResult.feedback[0];
    expect(typeof durableFeedback.id === "string" && durableFeedback.id.length > 0).toBe(true);
    expect(durableFeedback.client_feedback_id === firstSubmission.clientFeedbackId).toBe(true);
    expect(durableFeedback.revision_id === firstSubmission.reviewRevisionId).toBe(true);
    expect(durableFeedback.submitted_by_user_id === user.id).toBe(true);
    expect(durableFeedback.selected_element?.selector?.includes("retry-target") ?? false).toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".shiplet-review-comments-launcher").click();
    await expect(page.locator(".shiplet-review-count")).toHaveText("1");
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);
  });

  test("polls new comments without a manual refresh", async ({ page, request }) => {
    const user = testUser("poll-comment");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: `Polling Review Shiplet ${Date.now()}`,
    });
    const comment = `Polled shiplet comment ${Date.now()}`;
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator(".shiplet-review-count")).toHaveText("0");
    await createReviewFeedback(request, user, published.project, { comment });
    await expect(page.locator(".shiplet-review-count")).toHaveText("1", {
      timeout: 15_000,
    });
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);
    await expectNoPageErrors(errors);
  });

  test("keeps element capture and annotations in the trusted document", async ({
    page,
    request,
  }) => {
    const user = testUser("element-feedback");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: `Element Feedback Shiplet ${Date.now()}`,
      html: "<!doctype html><title>Element target</title><h1 id='hero-title' style='margin-top:120px'>Element target</h1><p>Capture this target.</p>",
    });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
    const artifactFrame = page.locator("[data-shiplet-artifact-frame]");
    const artifactSrc = await artifactFrame.getAttribute("src");
    expect(artifactSrc).toBeTruthy();
    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await artifact.locator("#hero-title").click();
    await expect(page.locator(".shiplet-review-target")).toContainText("hero-title");

    await artifactFrame.evaluate((frame) => {
      (frame as HTMLIFrameElement).src = "about:blank";
    });
    await expect(
      page.locator("[data-shiplet-review-select-target]"),
    ).toBeDisabled();
    await expect(page.locator(".shiplet-review-target")).toContainText(
      "Page · /",
    );
    await artifactFrame.evaluate((frame, src) => {
      (frame as HTMLIFrameElement).src = String(src);
    }, artifactSrc);
    await expect(
      page.locator("[data-shiplet-review-select-target]"),
    ).toBeEnabled();
    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await artifact.locator("#hero-title").click();
    await expect(page.locator(".shiplet-review-target")).toContainText("hero-title");
    await page
      .getByRole("button", {
        name: "Show annotation details and target properties",
      })
      .click();
    await page.getByRole("button", { name: "Draw on screenshot" }).click();
    const canvas = page.locator("[data-shiplet-annotation-canvas]");
    await expect(canvas).toBeVisible();
    const bounds = await canvas.boundingBox();
    expect(bounds).toBeTruthy();
    if (bounds) {
      await page.mouse.move(bounds.x + 70, bounds.y + 90);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 160, bounds.y + 140, { steps: 4 });
      await page.mouse.up();
    }
    await page.getByRole("button", { name: "Done drawing" }).click();
    await expect(canvas).toBeVisible();
    await expect(
      page.locator(".shiplet-review-annotation-editor"),
    ).toHaveAttribute("data-drawing", "false");
    await expectNoPageErrors(errors);
  });

  test("saves inline feedback inside the dashboard preview", async ({
    page,
    request,
  }) => {
    const user = testUser("embedded-review");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: `Embedded Review Shiplet ${Date.now()}`,
    });
    await loginAs(page, user);
    await page.goto(`/shiplets/${published.project.id}?created=1`, {
      waitUntil: "networkidle",
    });
    const preview = page.frameLocator("#artifactPreviewFrame");
    await expect(preview.locator("[data-shiplet-trusted-review-host='v1']")).toBeAttached();
    await expect(preview.locator("[data-shiplet-artifact-frame]")).toBeVisible();
    await expect(preview.locator("#shiplet-kernel-review-panel")).toBeHidden();
    const launcher = preview.locator(".shiplet-review-comments-launcher");
    await launcher.focus();
    await launcher.press("Enter");
    await expect(preview.locator("#shiplet-kernel-review-panel")).toBeVisible();
    await preview.getByRole("button", { name: /Annotate revision_/ }).click();
    await preview.frameLocator("[data-shiplet-artifact-frame]").getByRole("heading").first().click();
    const comment = `Dashboard preview feedback ${Date.now()}`;
    await preview.locator("#shiplet-review-comment").fill(comment);
    await preview.getByRole("button", { name: "Send annotation", exact: true }).click();
    await expect(preview.locator(".shiplet-review-status")).toHaveText("Feedback sent.");
    await expect(preview.locator(".shiplet-review-count")).toHaveText("1");
    await expect(preview.locator(".shiplet-review-list")).toContainText(comment);
    await expectNoPageErrors(errors);
  });

  test("isolates stale legacy review markup inside the artifact frame", async ({
    page,
    request,
  }) => {
    const user = testUser("stale-embedded-review");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, user);
    const name = `Stale Review Markup ${Date.now()}`;
    const published = await publishStaticShiplet(request, user, organization.id, {
      name,
      html: `<!doctype html><title>${name}</title><h1>${name}</h1><div id="shiplet-review-root"><button type="button">Legacy Review</button></div>`,
    });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
    await expect(artifact.getByRole("button", { name: "Legacy Review" })).toBeVisible();
    await expect(page.locator(".shiplet-review-comments-launcher")).toHaveCount(1);
    await expect(artifact.locator("[data-shiplet-trusted-review-host]")).toHaveCount(0);
    await expectNoPageErrors(errors);
  });

  test("rejects synthetic parent-frame gestures but accepts operated controls", async ({
    page,
    request,
  }) => {
    const user = testUser("parent-frame-review");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: `Parent Frame Review ${Date.now()}`,
    });
    await loginAs(page, user);
    await page.goto(`/shiplets/${published.project.id}?created=1`, {
      waitUntil: "networkidle",
    });
    const frame = page.locator("#artifactPreviewFrame");
    await frame.evaluate((element) => {
      const iframe = element as HTMLIFrameElement;
      const button = iframe.contentDocument?.querySelector(
        ".shiplet-review-launcher",
      ) as HTMLButtonElement | null;
      button?.click();
    });
    const preview = page.frameLocator("#artifactPreviewFrame");
    const annotate = preview.getByRole("button", { name: /Annotate revision_/ });
    await expect(annotate).toBeVisible();
    await annotate.focus();
    await annotate.press("Enter");
    await expect(
      preview.locator("[data-shiplet-artifact-frame]"),
    ).toHaveAttribute("data-shiplet-selecting", "true");
  });

  test("collapses the panel after saving inline feedback on mobile", async ({
    page,
    request,
  }) => {
    const user = testUser("mobile-collapse");
    const organization = await createOrganization(request, user);
    const name = `Mobile Collapse Shiplet ${Date.now()}`;
    const published = await publishStaticShiplet(request, user, organization.id, {
      name,
      html: `<!doctype html><title>${name}</title><h1 style="margin-top:120px">${name}</h1>`,
    });
    await page.setViewportSize({ width: 390, height: 740 });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await page
      .frameLocator("[data-shiplet-artifact-frame]")
      .getByRole("heading")
      .first()
      .click();
    await page.locator("#shiplet-review-comment").fill(`Mobile comment ${Date.now()}`);
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    await expect(page.locator(".shiplet-review-count")).toHaveText("1");
    await expect(page.locator("#shiplet-kernel-review-panel")).toBeHidden();
    await expect(page.locator(".shiplet-review-comments-launcher")).toBeVisible();
  });

  test("shows feedback globally and creates an inbox notification for mentions", async ({
    page,
    request,
  }) => {
    const owner = testUser("feedback-owner");
    const reviewer = testUser("feedback-reviewer");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, owner);
    await establishMembership(request, organization.id, reviewer);
    const published = await publishStaticShiplet(request, owner, organization.id, {
      name: `Feedback Shiplet ${Date.now()}`,
    });
    const comment = `Please review the spacing ${Date.now()}`;
    const created = await createReviewFeedback(request, reviewer, published.project, {
      comment,
      mentions: [{ userId: owner.id, email: owner.email, name: "Owner" }],
    });
    await loginAs(page, owner);
    await page.goto("/feedback", { waitUntil: "networkidle" });
    await expect(page.locator("#feedbackRows")).toContainText(comment);
    await expect(page.locator("#feedbackRows")).toContainText(published.project.name);
    await expect(page.locator("#platformFeedbackBadge")).toHaveText("1");
    await expect(page.getByRole("link", { name: created.feedback.ticket_label })).toHaveAttribute(
      "href",
      new RegExp(`/shiplets/${published.project.id}\\?feedback=${created.feedback.id}`),
    );
    await page.goto("/inbox", { waitUntil: "networkidle" });
    await expect(page.locator("#notificationRows")).toContainText("mentioned you");
    await expect(page.locator("#notificationRows")).toContainText(published.project.name);
    await expect(page.locator("#platformInboxBadge")).toHaveText("1");
    await expectNoPageErrors(errors);
  });
});
