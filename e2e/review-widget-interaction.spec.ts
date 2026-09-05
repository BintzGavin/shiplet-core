import { expect, test } from "@playwright/test";
import { reviewClientScript } from "../src/review-client";

test("opens and closes the generated review toolbar by click and keyboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://review-widget.test/**", (route) =>
    route.fulfill(route.request().url().includes("/api/")
      ? { contentType: "application/json", body: JSON.stringify({ items: [], feedback: [], users: [] }) }
      : { contentType: "text/html", body: "<!doctype html><title>Review fixture</title><h1>Review this page</h1>" }),
  );
  await page.goto("https://review-widget.test/");
  await page.evaluate(() => {
    (window as Window & { __SHIPLET_REVIEW__?: unknown }).__SHIPLET_REVIEW__ = {
      projectId: "interaction-fixture",
      apiBaseUrl: "https://review-widget.test",
      projectName: "Review fixture",
    };
  });
  await page.addScriptTag({ content: reviewClientScript() });

  const launcher = page.getByRole("button", { name: "Open review tools", exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Review tools" });
  await expect(launcher).toBeVisible();
  await expect(toolbar).toHaveCount(0);
  await launcher.click();
  await expect(toolbar).toBeVisible();
  await page.getByRole("button", { name: "Close review tools", exact: true }).click();
  await expect(launcher).toBeVisible();
  await launcher.click();
  await page.keyboard.press("Escape");
  await expect(toolbar).toHaveCount(0);
  await expect(launcher).toBeVisible();
  expect(errors).toEqual([]);
});
