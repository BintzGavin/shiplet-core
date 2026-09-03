import { expect, test } from "@playwright/test";

import {
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

declare global {
  interface Window {
    __shipletObservedWidgetReady?: Array<{
      channelNonce: string;
      revisionId: string;
      shipletId: string;
    }>;
    __shipletWidgetRetryAssigned?: string;
  }
}

test.describe("trusted parent widget route recovery", () => {
  // Given a widget document route that loads without completing the trusted
  // handshake, when the parent times out and a reviewer retries, then only a
  // trusted click reloads the originally validated absolute URL, a fresh nonce
  // reconnects the valid widget, and the stale nonce cannot dismiss recovery.
  test("recovers a non-handshaking widget route through an immutable trusted Retry", async ({
    page,
    request,
  }) => {
    const user = testUser("widget-route-recovery");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      { name: `Widget route recovery ${Date.now()}` },
    );

    await page.addInitScript(() => {
      window.__shipletObservedWidgetReady = [];
      window.addEventListener("message", (event) => {
        const data = event.data as Record<string, unknown> | null;
        if (
          !data ||
          data.protocol !== "shiplet.widget.channel.v1" ||
          data.type !== "ready" ||
          typeof data.channelNonce !== "string" ||
          typeof data.shipletId !== "string" ||
          typeof data.revisionId !== "string"
        ) {
          return;
        }
        window.__shipletObservedWidgetReady?.push({
          channelNonce: data.channelNonce,
          shipletId: data.shipletId,
          revisionId: data.revisionId,
        });
      });
    });

    let servedFailure = false;
    await page.route("**/__shiplet/review/widget/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (servedFailure || !pathname.endsWith("/")) {
        await route.continue();
        return;
      }
      servedFailure = true;
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Failed widget route</title><p>Widget route did not initialize.</p><script>
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.protocol !== "shiplet.widget.channel.v1" || data.type !== "offer") return;
  const stale = { ...data, type: "ready", channelNonce: "stale:" + data.channelNonce };
  parent.postMessage(stale, "*");
  parent.postMessage({ ...data, protocol: "shiplet.widget.restart.v1", type: "request", channelNonce: stale.channelNonce }, "*");
});
</script></html>`,
      });
    });

    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    const widgetFrame = page.locator("[data-shiplet-widget-frame]");
    const originalWidgetUrl = await widgetFrame.getAttribute("src");
    expect(originalWidgetUrl).toMatch(
      /\/__shiplet\/review\/widget\/[^/]+\/$/,
    );

    const recovery = page.locator("[data-shiplet-widget-recovery='v1']");
    await expect(recovery).toBeVisible({ timeout: 12_000 });
    await expect(recovery).toHaveAttribute("role", "alert");
    await expect(recovery).toContainText("Custom review widget could not load.");
    const retry = recovery.getByRole("button", { name: "Retry widget" });
    await expect(retry).toBeVisible();

    const staleMessages = await page.evaluate(
      () => window.__shipletObservedWidgetReady ?? [],
    );
    expect(staleMessages.length).toBeGreaterThan(0);
    expect(
      staleMessages.every((message) =>
        message.channelNonce.startsWith("stale:"),
      ),
    ).toBe(true);

    await widgetFrame.evaluate((frame) => {
      const element = frame as HTMLIFrameElement;
      const unvalidatedUrl = new URL(
        "/__shiplet/review/widget/not-the-validated-revision/",
        window.location.origin,
      ).toString();
      Object.defineProperty(element, "src", {
        configurable: true,
        get: () => unvalidatedUrl,
        set: (value) => {
          window.__shipletWidgetRetryAssigned = String(value);
          element.setAttribute("src", String(value));
        },
      });
    });

    await retry.evaluate((button) =>
      button.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      await page.evaluate(() => window.__shipletWidgetRetryAssigned),
    ).toBeUndefined();

    await retry.click();
    expect(
      await page.evaluate(() => window.__shipletWidgetRetryAssigned),
    ).toBe(originalWidgetUrl);

    const widget = page.frameLocator("[data-shiplet-widget-frame]");
    await expect(
      widget.getByText(
        "Review actions are provided by the trusted Shiplet host.",
      ),
    ).toBeVisible();
    await expect(recovery).toBeHidden();

    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window.__shipletObservedWidgetReady ?? []).filter(
              (message) => !message.channelNonce.startsWith("stale:"),
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    const readyMessages = await page.evaluate(
      () => window.__shipletObservedWidgetReady ?? [],
    );
    const fresh = readyMessages.find(
      (message) => !message.channelNonce.startsWith("stale:"),
    );
    expect(fresh).toMatchObject({ shipletId: published.project.id });
    expect(
      staleMessages.some(
        (message) => message.channelNonce === fresh?.channelNonce,
      ),
    ).toBe(false);
  });
});
