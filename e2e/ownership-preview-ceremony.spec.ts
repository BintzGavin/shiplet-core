import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  authHeaders,
  createOrganization,
  loginAs,
  publishStaticShiplet,
  testUser,
} from "./helpers";

type PortableFile = {
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  sha256: string;
  size: number;
};

test.describe("ownership preview ceremony", () => {
  test("keeps promotion unavailable until the exact sealed revision is previewed in the trusted browser session", async ({
    page,
    request,
    context,
  }) => {
    const user = testUser("ownership-preview-ceremony");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Ownership preview ceremony ${Date.now()}`,
      },
    );
    const headers = { ...authHeaders(user), Origin: "http://localhost:8787" };
    const activeResponse = await request.get(
      `/api/shiplets/${published.project.id}/package`,
      { headers },
    );
    const active = (await activeResponse.json()) as {
      revision: { id: string };
    };
    const forkResponse = await request.post(
      `/api/shiplets/${published.project.id}/drafts`,
      { headers, data: { fromRevisionId: active.revision.id } },
    );
    const { draft } = (await forkResponse.json()) as {
      draft: { id: string; version: number };
    };
    const packageResponse = await request.get(
      `/api/drafts/${draft.id}/package`,
      {
        headers,
      },
    );
    const packageEnvelope = (await packageResponse.json()) as {
      package: { files: PortableFile[] };
    };
    const artifact = packageEnvelope.package.files.find(
      (file) => file.path === "artifact/index.html",
    );
    expect(artifact).toBeTruthy();
    if (!artifact) return;
    artifact.content = "<!doctype html><h1>Exact sealed ownership preview</h1>";
    artifact.encoding = "utf8";
    artifact.size = Buffer.byteLength(artifact.content);
    artifact.sha256 = createHash("sha256")
      .update(artifact.content)
      .digest("hex");
    const updateResponse = await request.put(
      `/api/drafts/${draft.id}/package`,
      {
        headers: { ...headers, "If-Match": String(draft.version) },
        data: {
          package: packageEnvelope.package,
          expectedVersion: draft.version,
        },
      },
    );
    const updated = (await updateResponse.json()) as {
      draft: { version: number };
    };
    const validationResponse = await request.post(
      `/api/drafts/${draft.id}/validate`,
      { headers, data: { expectedVersion: updated.draft.version } },
    );
    expect(validationResponse.ok(), await validationResponse.text()).toBe(true);
    const { validation } = (await validationResponse.json()) as {
      validation: { revisionId: string };
    };

    await loginAs(page, user);
    await page.goto(`/shiplets/${published.project.id}/ownership`, {
      waitUntil: "domcontentloaded",
    });
    const promote = page.locator('[data-shiplet-action="promote"]').first();
    await expect(promote).toBeDisabled();
    await page
      .getByRole("button", { name: "Compare with active revision" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Changed files" }),
    ).toBeVisible();
    await expect(
      page.getByText("artifact/index.html", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Manifest changes", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Capability changes", { exact: true }),
    ).toBeVisible();
    const rawComparison = page.getByText("Advanced: view raw package JSON", {
      exact: true,
    });
    await expect(rawComparison).toBeVisible();
    await expect(
      rawComparison.locator("xpath=following-sibling::pre"),
    ).toBeHidden();
    await page
      .getByRole("button", { name: "Close revision comparison" })
      .click();

    const previewLink = page.getByRole("link", { name: /Preview Draft/ });
    const previewPagePromise = context.waitForEvent("page");
    await previewLink.click();
    const previewPage = await previewPagePromise;
    await previewPage.waitForLoadState("domcontentloaded");
    await expect(
      previewPage
        .frameLocator("[data-shiplet-artifact-frame]")
        .getByRole("heading", { name: "Exact sealed ownership preview" }),
    ).toBeVisible();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(promote).toBeEnabled();
    await expect(promote).toHaveAttribute(
      "data-preview-revision-id",
      validation.revisionId,
    );

    await previewPage.close();
    await context.clearCookies();
    await loginAs(page, user);
    await page.goto(`/shiplets/${published.project.id}/ownership`, {
      waitUntil: "domcontentloaded",
    });
    await expect(promote).toBeDisabled();
    const currentSessionPreviewPromise = context.waitForEvent("page");
    await page.getByRole("link", { name: /Preview Draft/ }).click();
    const currentSessionPreview = await currentSessionPreviewPromise;
    await currentSessionPreview.waitForLoadState("domcontentloaded");
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(promote).toBeEnabled();

    const idempotencyKeys: string[] = [];
    await page.route(`**/api/drafts/${draft.id}/promote`, async (route) => {
      idempotencyKeys.push(
        route.request().headers()["idempotency-key"] || "missing",
      );
      if (idempotencyKeys.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            code: "managed_activation_reconciliation_required",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    const firstConfirmation = page.waitForEvent("dialog");
    const firstPromotionClick = promote.click();
    const firstDialog = await firstConfirmation;
    expect(firstDialog.message()).toContain(validation.revisionId);
    expect(firstDialog.message()).toContain(active.revision.id);
    expect(firstDialog.message()).toContain("Shiplet-managed target");
    await firstDialog.accept();
    await firstPromotionClick;
    await expect(page.getByText(/^Outcome unknown\./)).toBeVisible();
    await expect(promote).toHaveText("Retry exact operation");
    await expect(promote).toHaveAttribute("data-operation-retry", "exact");
    const blockedCompetingActions = page.locator(
      '[data-disabled-by-uncertain-operation="true"]',
    );
    await expect(blockedCompetingActions.first()).toBeDisabled();
    expect(await blockedCompetingActions.count()).toBeGreaterThan(0);

    const retryConfirmation = page.waitForEvent("dialog");
    const retryPromotionClick = promote.click();
    await (await retryConfirmation).accept();
    await retryPromotionClick;
    await expect.poll(() => idempotencyKeys.length).toBe(2);
    expect(idempotencyKeys[0]).toMatch(/^ownership_promote_/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
    await currentSessionPreview.close();
  });
});
