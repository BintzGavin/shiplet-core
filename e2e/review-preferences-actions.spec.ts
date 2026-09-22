import { expect, test } from "@playwright/test";

import {
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

test.describe("[T2] preferences and actions", () => {
  test("hosted progressively exposes preferences and canonical clean-link actions", async ({ page, request }) => {
    const user = testUser("t2-preferences-hosted");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(request, user, organization.id, {
      name: "T2 preferences hosted",
      html: "<!doctype html><title>T2 preferences</title><main><h1>Preferences fixture</h1></main>",
    });
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}?view=review#/section`, { waitUntil: "domcontentloaded" });
    await page.locator(".shiplet-review-comments-launcher").click();
    await page.locator("summary[aria-label='Review options']").click();
    await page.getByText("Settings", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Copy review link with review UI hidden" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy review link with comments hidden" })).toBeVisible();
  });
});
