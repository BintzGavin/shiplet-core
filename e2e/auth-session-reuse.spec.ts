import { expect, test } from "@playwright/test";

import { loginAs, testUser } from "./helpers";

test("resumes an existing browser session without another sign-in", async ({ page }) => {
  await loginAs(page, testUser("session-reuse"));
  let authenticationRequests = 0;
  page.on("request", request => {
    if (new URL(request.url()).hostname.includes("authkit")) {
      authenticationRequests++;
    }
  });

  await page.goto("/auth/login?return_to=%2Fshiplets");
  await expect(page).toHaveURL(/\/shiplets$/);
  await expect(page.getByRole("heading", { name: "Shiplets", exact: true })).toBeVisible();
  expect(authenticationRequests).toBe(0);
});
