import { expect, test } from "@playwright/test";

import {
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
  test("updates the trusted live count after secure human confirmation", async ({
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
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    const confirmation = await popupPromise;
    await confirmation.waitForLoadState("domcontentloaded");
    await confirmation
      .getByRole("button", { name: "Confirm and send feedback" })
      .click();
    await expect(
      confirmation.getByRole("heading", { name: "Feedback sent" }),
    ).toBeVisible();
    await page.locator(".shiplet-review-comments-launcher").click();
    await page.getByLabel("Review options").click();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".shiplet-review-count")).toHaveText("1");
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);
    await expectNoPageErrors(errors);
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
    await page.getByRole("button", { name: "Markup screenshot" }).click();
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

  test("mounts the trusted host inside the dashboard preview", async ({
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

  test("collapses the panel after starting secure confirmation on mobile", async ({
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
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    const confirmation = await popupPromise;
    await expect(page.locator("#shiplet-kernel-review-panel")).toBeHidden();
    await expect(page.locator(".shiplet-review-comments-launcher")).toBeVisible();
    await confirmation.close();
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
