import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import {
  authHeaders,
  createOrganization,
  establishMembership,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test.use({ screenshot: "off", video: "off", trace: "off" });

test("two-tag install selects real page content, shares feedback, follows SPA navigation, and cleans up", async ({
  page,
  request,
  browser,
}) => {
  const owner = testUser("embed-browser");
  const org = await createOrganization(request, owner);
  const project = await publishStaticShiplet(request, owner, org.id);
  await loginAs(page, owner);
  await page.goto(`/embed/install?project_id=${project.project.id}`);
  await page.getByLabel("Site URL").fill("http://127.0.0.1:8799");
  await page.getByRole("button", { name: "Create install snippet" }).click();
  const snippet = await page.getByLabel("Install snippet").inputValue();
  expect(snippet).toContain("shiplet-feedback");
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader(
      "Content-Security-Policy",
      "style-src 'nonce-fixture' http://localhost:8787",
    );
    response.end(
      `<!doctype html><html><head><style nonce="fixture">body{margin:0;background:#f4f1e9;font:18px system-ui;color:#253330}main{max-width:850px;margin:100px auto}h1{font-size:56px}button{font:inherit;padding:12px}*{box-sizing:border-box}</style></head><body><main><p>HARBOR STUDIO</p><h1>A website worth reviewing.<span data-shiplet-private hidden>Private fixture content</span></h1><p>Shiplet feedback stays on this page.</p><button id="navigate" onclick="history.pushState({}, '', '/pricing?plan=team')">View pricing</button><p id="result"></p></main>${snippet}</body></html>`,
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(8799, "127.0.0.1", resolve),
  );
  try {
    await page.goto("http://127.0.0.1:8799/home");
    const widget = page.locator("shiplet-feedback");
    await expect(widget.locator("iframe")).toHaveCount(1);
    const frame = widget.locator("iframe").contentFrame();
    await expect(
      frame
        .getByRole("button", { name: /^Annotate/ })
        .or(frame.getByRole("button", { name: "Open secure Shiplet sign-in" })),
    ).toBeVisible();
    if (
      await frame
        .getByRole("button", { name: "Open secure Shiplet sign-in" })
        .isVisible()
    ) {
      const signInPopup = page.waitForEvent("popup");
      await frame
        .getByRole("button", { name: "Open secure Shiplet sign-in" })
        .click();
      const signIn = await signInPopup;
      await expect(
        frame.getByRole("button", { name: /^Annotate/ }),
      ).toBeVisible();
      if (!signIn.isClosed()) await signIn.close();
    }
    await expect(
      frame.getByRole("button", { name: /^Annotate/ }),
    ).toBeVisible();
    await frame.getByRole("button", { name: /^Annotate/ }).click();
    await expect(
      frame.locator("[data-shiplet-review-select-target]"),
    ).toBeEnabled();
    await page
      .getByRole("heading", { name: "A website worth reviewing." })
      .click();
    await expect(frame.locator(".shiplet-review-target")).toContainText(
      "A website worth reviewing.",
    );
    const comment = "Make this heading more specific for new customers.";
    await frame.locator(".shiplet-review-form textarea").fill(comment);
    await page.screenshot({
      path: "/private/tmp/shiplet-parity-navigation-r2-20260920/embeddable-desktop-before-close.png",
    });
    const confirmationPromise = page.waitForEvent("popup");
    await frame
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    const confirmation = await confirmationPromise;
    await confirmation
      .getByRole("button", { name: "Confirm and send feedback" })
      .click();
    await expect(
      confirmation.getByRole("heading", { name: "Feedback sent" }),
    ).toBeVisible();
    await confirmation.close();
    const cancelAnnotation = frame.getByRole("button", {
      name: "Cancel annotation",
    });
    if (await cancelAnnotation.isVisible()) await cancelAnnotation.click();
    const listResponse = await request.get(
      `/api/projects/${project.project.id}/review-feedback`,
      {
        headers: {
          ...authHeaders(owner),
          Origin: "http://localhost:8787",
        },
      },
    );
    expect(listResponse.ok(), await listResponse.text()).toBe(true);
    const listBody = (await listResponse.json()) as {
      feedback: Array<{
        id: string;
        comment: string;
        status: string;
      }>;
      nextCursor: string | null;
    };
    expect(listBody).toHaveProperty("feedback");
    expect(listBody).toHaveProperty("nextCursor");
    const createdFeedback = listBody.feedback.find((item) => item.comment === comment);
    expect(createdFeedback).toBeDefined();
    expect(createdFeedback?.comment).toBe(comment);
    const createdFeedbackId = createdFeedback?.id;
    expect(createdFeedbackId).toEqual(expect.any(String));
    await expect(
      widget.getByRole("button", { name: "Open PF-1", exact: true }),
    ).toBeVisible();
    await widget
      .getByRole("button", { name: "Open PF-1", exact: true })
      .click();
    await expect(frame.locator(".shiplet-review-thread-details")).toBeVisible();
    const teammate = testUser("embed-teammate");
    await establishMembership(request, org.id, teammate);
    const teammateContext = await browser.newContext();
    try {
      const teammatePage = await teammateContext.newPage();
      await loginAs(teammatePage, teammate);
      await teammatePage.goto("http://127.0.0.1:8799/home");
      const teammateWidget = teammatePage.locator("shiplet-feedback");
      await expect(teammateWidget.locator("iframe")).toHaveCount(1);
      const teammateFrame = teammateWidget.locator("iframe").contentFrame();
      await expect(
        teammateFrame
          .getByRole("button", { name: /^Annotate/ })
          .or(
            teammateFrame.getByRole("button", {
              name: "Open secure Shiplet sign-in",
            }),
          ),
      ).toBeVisible();
      if (
        await teammateFrame
          .getByRole("button", { name: "Open secure Shiplet sign-in" })
          .isVisible()
      ) {
        const signInPopup = teammatePage.waitForEvent("popup");
        await teammateFrame
          .getByRole("button", { name: "Open secure Shiplet sign-in" })
          .click();
        const signIn = await signInPopup;
        await expect(
          teammateFrame.getByRole("heading", { name: "Comments", exact: true }),
        ).toBeVisible();
        if (!signIn.isClosed()) await signIn.close();
      }
      await teammateFrame.locator(".shiplet-review-comments-launcher").click();
      await expect(
        teammateFrame.getByRole("heading", { name: "Comments", exact: true }),
      ).toBeVisible();
      await expect(
        teammatePage
          .locator("shiplet-feedback iframe")
          .contentFrame()
          .locator(".shiplet-review-thread-summary-comment")
          .filter({ hasText: comment }),
      ).toBeVisible();
      await teammateFrame.locator(".shiplet-review-thread-summary").click();
      await teammateFrame
        .getByRole("textbox", { name: "Reply text for PF-1" })
        .fill("I can take this change.");
      await teammatePage.waitForTimeout(5500);
      await expect(
        teammateFrame.getByRole("textbox", { name: "Reply text for PF-1" }),
      ).toHaveValue("I can take this change.");
      await expect(
        teammateFrame.getByRole("textbox", { name: "Reply text for PF-1" }),
      ).toBeFocused();
      const replyPopup = teammatePage.waitForEvent("popup");
      await teammateFrame
        .getByRole("button", { name: "Reply to PF-1", exact: true })
        .click();
      const replyConfirmation = await replyPopup;
      await replyConfirmation
        .getByRole("button", { name: "Confirm reply" })
        .click();
      await expect(
        replyConfirmation.getByRole("heading", { name: "Reply added" }),
      ).toBeVisible();
      await replyConfirmation.close();
      await expect(
        frame.locator(".shiplet-review-thread-summary-comment"),
      ).toContainText(comment);
      await frame.locator("body").press("Escape");
      await frame.locator("body").press("Escape");
      await expect(frame.locator("#shiplet-annotation-composer")).toBeHidden();
      await widget.getByRole("button", { name: "Open PF-1", exact: true }).click();
      const ownerThread = frame.getByRole("region", {
        name: "Thread PF-1",
        exact: true,
      });
      await expect(ownerThread.locator(".shiplet-review-replies")).toContainText(
        "I can take this change.",
      );
      const resolvePopup = teammatePage.waitForEvent("popup");
      await teammateFrame
        .getByRole("button", { name: "Resolve PF-1", exact: true })
        .click();
      const resolveConfirmation = await resolvePopup;
      await resolveConfirmation
        .getByRole("button", { name: "Confirm status change" })
        .click();
      await expect(
        resolveConfirmation.getByRole("heading", { name: "Status updated" }),
      ).toBeVisible();
      await resolveConfirmation.close();
      const resolvedResponse = await request.get(
        `/api/projects/${project.project.id}/review-feedback/${encodeURIComponent(createdFeedbackId!)}`,
        {
          headers: {
            ...authHeaders(owner),
            Origin: "http://localhost:8787",
          },
        },
      );
      expect(resolvedResponse.ok(), await resolvedResponse.text()).toBe(true);
      const resolvedBody = (await resolvedResponse.json()) as {
        feedback: { id: string; comment: string; status: string };
      };
      expect(resolvedBody.feedback.id).toBe(createdFeedbackId);
      expect(resolvedBody.feedback.comment).toBe(comment);
      expect(resolvedBody.feedback.status).toBe("Done");
    } finally {
      await teammateContext.close();
    }
    const contextualThread = frame.getByRole("region", {
      name: "Thread PF-1",
      exact: true,
    });
    await expect(contextualThread).toBeVisible();
    await contextualThread
      .getByRole("button", { name: "Close thread PF-1", exact: true })
      .click();
    await expect(contextualThread).toBeHidden();
    await expect(widget.locator(".surface")).toHaveAttribute(
      "data-view",
      "toolbar",
    );
    await expect(frame.locator("#shiplet-kernel-review-panel")).toBeHidden();
    const annotateButton = frame.getByRole("button", { name: /^Annotate/ });
    const commentsLauncher = frame.locator(
      ".shiplet-review-comments-launcher",
    );
    await expect(annotateButton).toBeVisible();
    await expect(annotateButton).toBeEnabled();
    await expect(commentsLauncher).toBeVisible();
    await expect(commentsLauncher).toBeEnabled();
    await expect(widget.locator("iframe")).toHaveCount(1);
    await expect(
      widget.getByRole("button", { name: "Open PF-1", exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: "/private/tmp/shiplet-parity-navigation-r2-20260920/embeddable-after-contextual-close.png",
    });
    await page.getByRole("button", { name: "View pricing" }).click();
    await expect(widget.locator("iframe")).toHaveCount(1);
    await page.evaluate(() => {
      const el = document.querySelector("shiplet-feedback")!;
      el.remove();
      document.body.appendChild(el);
    });
    await expect(widget.locator("iframe")).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(widget.locator("iframe")).toBeVisible();
    await widget.locator("iframe").contentFrame().locator(".shiplet-review-comments-launcher").click();
    await expect(
      widget
        .locator("iframe")
        .contentFrame()
        .getByRole("heading", { name: "Comments", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "/private/tmp/shiplet-parity-navigation-r2-20260920/embeddable-mobile-comments.png",
    });
    await widget.evaluate((el) => el.setAttribute("disabled", ""));
    await expect(widget.locator("iframe")).toHaveCount(0);
    await expect(widget.getByRole("button")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
