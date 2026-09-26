import { expect, test } from "@playwright/test";

import {
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test.describe("[T2] rich creation", () => {
  test("hosted offers target-free Page comment and Draw on page after loading the real review worker", async ({ page, request }) => {
    const user = testUser("t2-rich-hosted");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: "T2 rich hosted",
      html: "<!doctype html><title>T2 rich</title><main><h1>Review this page</h1><p>Visible capture content</p></main>",
    });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-shiplet-trusted-review-host='v1']")).toBeVisible();
    await page.locator(".shiplet-review-comments-launcher").click();
    await page.getByRole("button", { name: "New comment" }).click();
    await expect(page.getByRole("button", { name: "Page comment", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Draw on page", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Select an element", exact: true })).toBeVisible();
  });

  test("persists the selected copy request in the direct JSON submission", async ({ page, request }) => {
    const user = testUser("t2-rich-direct");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: "T2 rich direct",
      html: "<!doctype html><title>T2 rich direct</title><main><h1>Review this page</h1></main>",
    });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("[data-shiplet-trusted-review-host='v1']")).toBeVisible();
    await page.locator(".shiplet-review-comments-launcher").click();
    await page.locator("summary[aria-label='Review options']").click();
    await page.getByText("Settings", { exact: true }).click();
    await page.getByLabel("Enable copy requests").check();
    await page.getByRole("button", { name: "New comment", exact: true }).click();
    await page.getByRole("button", { name: "Page comment", exact: true }).click({ force: true });
    const composer = page.locator("#shiplet-annotation-composer");
    await expect(composer).toBeVisible();
    await composer.locator("#shiplet-review-comment").fill("Keep the selected rich request");
    const copyRequest = composer.locator("textarea[aria-label='Copy request change']");
    await expect(copyRequest).toBeVisible();
    await copyRequest.fill("Change the headline to Shiplet review");
    const directRequest = page.waitForRequest((observed) => {
      const url = new URL(observed.url());
      return observed.method() === "POST" && url.pathname.endsWith("/__shiplet/review/feedback");
    });
    await composer.getByRole("button", { name: "Send annotation", exact: true }).click();
    const observed = await directRequest;
    const body = observed.postDataJSON() as { richPayload?: { copyRequest?: { changes?: Array<{ proposedText?: string }> } } };
    expect(body.richPayload?.copyRequest?.changes?.[0]?.proposedText).toBe("Change the headline to Shiplet review");
    await expect(composer).toBeHidden();
  });
});
