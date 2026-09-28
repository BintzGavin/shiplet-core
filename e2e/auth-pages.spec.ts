import { expect, test } from "@playwright/test";
import { collectPageErrors, expectNoPageErrors, loginAs, testUser } from "./helpers";

function cliAuthorizationPath() {
  return `/cli/authorize?${new URLSearchParams({
    redirect_uri: "http://127.0.0.1:43191/callback",
    state: "s".repeat(32),
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
  })}`;
}

test("CLI approval is branded, readable across themes and sizes, and cancellation grants no access", async ({ page }) => {
  const user = testUser("auth-style");
  const errors = collectPageErrors(page);
  await loginAs(page, user);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(cliAuthorizationPath());
      await expect(page.getByRole("heading", { name: "Authorize Shiplet CLI" })).toBeVisible();
      await expect(page.getByText(user.email, { exact: true })).toBeVisible();
      const approve = page.getByRole("button", { name: "Authorize CLI", exact: true });
      await expect(approve).toBeVisible();
      await expect(approve).toHaveCSS("min-height", "46px");
      const permissionColor = await page.locator(".auth-permissions li").first().evaluate(el => getComputedStyle(el).color);
      const bodyColor = await page.locator(".auth-decision p").first().evaluate(el => getComputedStyle(el).color);
      expect(permissionColor).toBe(bodyColor);
      expect(await approve.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      await approve.focus();
      await expect(approve).toBeFocused();
      expect(await approve.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe("none");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }
  let callbackRequests = 0;
  await expectNoPageErrors(errors);
  page.on("request", request => {
    if (request.url().startsWith("http://127.0.0.1:43191")) callbackRequests++;
  });
  const [denied] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/cli/authorize/complete")),
    page.getByRole("button", { name: "Cancel", exact: true }).click(),
  ]);
  expect(denied.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "CLI authorization stopped" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Shiplet" })).toBeVisible();
  expect(callbackRequests).toBe(0);
});

test("sign-in and invitation failures offer styled recovery on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/auth/callback", "/auth/login?consent=invalid", "/join/invalid"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to Shiplet" })).toBeVisible();
    expect(await page.locator(".auth-card").evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test("agent access leads with CLI setup and retains MCP and API key controls", async ({ page }) => {
  await loginAs(page, testUser("agent-cli-first"));
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Connect with the CLI" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "API Keys and MCP" })).toBeVisible();
  await page.getByRole("link", { name: "Set up CLI authentication" }).click();
  await expect(page).toHaveURL(/\/docs\/cli$/);
  await expect(page.getByText("Recommended for agent work.", { exact: true })).toBeVisible();
});
