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
    await expect(
      widget.getByRole("button", { name: "Open Shiplet feedback" }),
    ).toBeVisible();
    await expect(widget.locator("iframe")).toHaveCount(0);
    await widget.getByRole("button", { name: "Open Shiplet feedback" }).click();
    const frame = widget.locator("iframe").contentFrame();
    await expect(
      frame
        .getByRole("button", { name: /^Annotate / })
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
        frame.getByRole("button", { name: /^Annotate / }),
      ).toBeVisible();
      if (!signIn.isClosed()) await signIn.close();
    }
    await expect(
      frame.getByRole("button", { name: /^Annotate / }),
    ).toBeVisible();
    await frame.getByRole("button", { name: /^Annotate / }).click();
    await page
      .getByRole("heading", { name: "A website worth reviewing." })
      .click();
    await expect(frame.locator(".shiplet-review-target")).toContainText(
      "A website worth reviewing.",
    );
    const comment = "Make this heading more specific for new customers.";
    await frame.locator(".shiplet-review-form textarea").fill(comment);
    await page.screenshot({ path: "/tmp/shiplet-embed-desktop.png" });
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
    const response = await request.get(
      `/api/projects/${project.project.id}/review-feedback`,
      { headers: authHeaders(owner) },
    );
    const feedback = await response.json();
    expect(JSON.stringify(feedback)).toContain(comment);
    expect(JSON.stringify(feedback)).toContain("A website worth reviewing.");
    expect(JSON.stringify(feedback)).not.toContain("Private fixture content");
    await expect(
      widget.getByRole("button", { name: "Open comment 1", exact: true }),
    ).toBeVisible();
    await widget
      .getByRole("button", { name: "Open comment 1", exact: true })
      .click();
    await expect(frame.locator(".shiplet-review-thread-details")).toBeVisible();
    const teammate = testUser("embed-teammate");
    await establishMembership(request, org.id, teammate);
    const teammateContext = await browser.newContext();
    try {
      const teammatePage = await teammateContext.newPage();
      await loginAs(teammatePage, teammate);
      await teammatePage.goto("http://127.0.0.1:8799/home");
      await teammatePage
        .locator("shiplet-feedback")
        .getByRole("button", { name: "Open Shiplet feedback" })
        .click();
      const teammateFrame = teammatePage
        .locator("shiplet-feedback iframe")
        .contentFrame();
      await expect(
        teammateFrame
          .getByRole("heading", { name: "Comments", exact: true })
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
      if (
        (await frame
          .locator(".shiplet-review-thread-summary")
          .getAttribute("aria-expanded")) !== "true"
      )
        await frame.locator(".shiplet-review-thread-summary").click();
      await expect(frame.locator(".shiplet-review-replies")).toContainText(
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
      await expect(
        frame.getByRole("button", { name: "Reopen PF-1", exact: true }),
      ).toBeVisible();
    } finally {
      await teammateContext.close();
    }
    await widget
      .getByRole("button", { name: "Close Shiplet feedback" })
      .click();
    await page.getByRole("button", { name: "View pricing" }).click();
    await widget.getByRole("button", { name: "Open Shiplet feedback" }).click();
    await expect(widget.locator("iframe")).toHaveAttribute("src", /pricing/);
    await page.evaluate(() => {
      const el = document.querySelector("shiplet-feedback")!;
      el.remove();
      document.body.appendChild(el);
    });
    await expect(widget.locator("iframe")).toHaveCount(0);
    await expect(
      widget.getByRole("button", { name: "Open Shiplet feedback" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await widget.getByRole("button", { name: "Open Shiplet feedback" }).click();
    await expect(widget.locator("iframe")).toBeVisible();
    await expect(
      widget
        .locator("iframe")
        .contentFrame()
        .getByRole("heading", { name: "Comments", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "/tmp/shiplet-embed-mobile.png" });
    await widget.evaluate((el) => el.setAttribute("disabled", ""));
    await expect(widget.locator("iframe")).toHaveCount(0);
    await expect(widget.getByRole("button")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
