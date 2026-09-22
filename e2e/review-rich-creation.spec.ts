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
});
