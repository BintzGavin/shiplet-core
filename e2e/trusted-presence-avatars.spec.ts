import { expect, test } from "@playwright/test";
import { createTrustedReviewHostResponse } from "../src/trusted-review-host";
import { AVATAR_SPRITE_URL } from "../src/avatars";

const platformOrigin = "https://platform.example";
const reviewOrigin = "https://artifact.example";

for (const imageAvailable of [true, false]) {
  test(`artifact-subdomain avatars ${imageAvailable ? "load the platform sprite" : "retain initials when the image fails"}`, async ({ page, request }) => {
    const avatarRequests: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === AVATAR_SPRITE_URL) avatarRequests.push(request.url());
    });
    await page.route(`${reviewOrigin}/review`, async route => {
      const response = createTrustedReviewHostResponse({
        shipletId: "shiplet_avatar_fixture",
        revisionId: "revision_avatar_fixture",
        title: "Avatar regression check",
        artifactUrl: `${reviewOrigin}/artifact`,
        widgetUrl: null,
        hostScriptUrl: `${platformOrigin}/api/review/host.js`,
        reviewApiUrl: `${platformOrigin}/api/projects/shiplet_avatar_fixture/review-feedback`,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      await route.fulfill({ status: response.status, headers, body: await response.text() });
    });
    await page.route(`${reviewOrigin}/artifact`, route => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><h1 style='margin:100px 40px;font:36px system-ui'>Artifact review</h1><p style='margin:0 40px;font:18px system-ui'>Reviewers remain identifiable while their avatars load.</p>",
    }));
    await page.route(`${platformOrigin}/api/projects/shiplet_avatar_fixture/**`, route => route.fulfill({
      contentType: "application/json", headers: { "Access-Control-Allow-Origin": reviewOrigin }, body: JSON.stringify({ feedback: [] }),
    }));
    // Serve the actual platform responses at a separate test origin, without
    // Chrome's localhost network permission affecting the cross-origin check.
    await page.route(`${platformOrigin}/api/review/**`, async route => {
      const response = await request.get("http://localhost:8787" + new URL(route.request().url()).pathname);
      await route.fulfill({ response });
    });
    await page.route(`${platformOrigin}${AVATAR_SPRITE_URL}`, async route => {
      const response = await request.get("http://localhost:8787" + AVATAR_SPRITE_URL);
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-type"]).toContain("image/png");
      await route.fulfill({ response });
    });
    if (!imageAvailable) await page.route(`${platformOrigin}${AVATAR_SPRITE_URL}`, route => route.abort());
    await page.routeWebSocket("**/review-presence/ws?*", socket => {
      socket.onMessage(() => socket.send(JSON.stringify({
        type: "presence:update",
        viewers: [
          { id: "user_alfa", kind: "user", name: "Alfa Reviewer", email: "alfa@example.com", avatarPreset: "aurora-grid" },
          { id: "user_foxtrot", kind: "user", name: " ", email: "foxtrot@example.com", avatarPreset: "violet-signal" },
        ],
      })));
    });
    await page.goto(`${reviewOrigin}/review`);
    const avatars = page.locator(".shiplet-review-presence-avatar");
    await expect(avatars).toHaveCount(2);
    await expect.poll(() => avatarRequests.length).toBeGreaterThan(0);
    expect(avatarRequests.every(url => new URL(url).origin === platformOrigin)).toBe(true);
    if (imageAvailable) {
      await expect(avatars.first()).toHaveCSS("background-image", `url("${platformOrigin}${AVATAR_SPRITE_URL}")`);
      await expect(avatars.first()).toHaveText("");
      await expect(avatars.nth(1)).toHaveCSS("background-position", "33.3333% 50%");
      await expect(avatars.nth(1)).toHaveCSS("background-size", "400% 300%");
    } else {
      await expect(avatars.first()).toHaveText("AR");
      await expect(avatars.nth(1)).toHaveText("F");
      await expect(avatars.first()).toHaveCSS("background-image", "none");
    }
    await avatars.first().hover();
    await expect(avatars.first()).toHaveAttribute("title", "Alfa Reviewer");
    await avatars.nth(1).hover();
    await expect(avatars.nth(1)).toHaveAttribute("title", "foxtrot@example.com");
    await expect(avatars.first()).toHaveAccessibleName("Alfa Reviewer");
    await expect(avatars.nth(1)).toHaveAccessibleName("foxtrot@example.com");
    await expect(page.locator("[data-shiplet-artifact-frame]")).toHaveAttribute("sandbox", "allow-scripts allow-forms");
  });
}
