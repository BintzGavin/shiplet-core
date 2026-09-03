import { expect, test } from "@playwright/test";

import { createOrganization, loginAs, testUser } from "./helpers";

test("pasting a URL autofills untouched Shiplet identity fields without overwriting later human edits", async ({
  page,
  request,
}) => {
  const user = testUser("url-metadata-autofill");
  const organization = await createOrganization(request, user);
  await loginAs(page, user, { organizationId: organization.id });

  let suggestion = {
    finalUrl: "https://newro-eats.vercel.app/",
    name: "NewRo Eats",
    source: "og:title",
    subdomain: "newro-eats",
  };
  await page.route("**/api/external-url/metadata", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(suggestion),
    });
  });

  await page.goto("/");
  await page.locator('label[for="sourceModeUrl"]').click();
  await page.locator("#externalUrl").fill("https://newro-eats.vercel.app/");

  await expect(page.locator("#projectName")).toHaveValue("NewRo Eats");
  await expect(page.locator("#subdomain")).toHaveValue("newro-eats");
  await expect(page.locator("#externalUrlMetadataStatus")).toHaveText(
    "Suggested from page metadata.",
  );

  await page.locator("#projectName").fill("My restaurant review");
  await page.locator("#subdomain").fill("my-custom-address");
  suggestion = {
    finalUrl: "https://different.example.com/",
    name: "Different remote title",
    source: "title",
    subdomain: "different-remote-title",
  };
  await page.locator("#externalUrl").fill("https://different.example.com/");

  await expect(page.locator("#externalUrlMetadataStatus")).toHaveText(
    "Page metadata found. Your edits were kept.",
  );
  await expect(page.locator("#projectName")).toHaveValue(
    "My restaurant review",
  );
  await expect(page.locator("#subdomain")).toHaveValue("my-custom-address");
});
