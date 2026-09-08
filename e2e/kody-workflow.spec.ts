import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createShipletClient } from "../integrations/kody/shiplet/src/client";
import { fieldNotes } from "../integrations/kody/demo/artifact";

const origin = "http://localhost:8794";
const evidenceDir = "/private/tmp/shiplet-kody-evidence";
test("a real local review, feedback, revision, approval and evidence loop", async ({
  page,
  request,
}) => {
  await mkdir(evidenceDir, { recursive: true });
  const email = `kody-demo-${Date.now()}@example.test`;
  const userId = `user_${email.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const owner = { "x-shiplet-user-id": userId, "x-shiplet-user-email": email };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const orgResponse = await request.post("/api/organizations", {
    headers: owner,
    data: { name: `Field Notes ${Date.now()}` },
  });
  expect(orgResponse.status()).toBe(201);
  const { organization } = await orgResponse.json();
  const keyResponse = await request.post(`/api/organizations/${organization.id}/api-tokens`, {
    headers: owner,
    data: {
      name: "Local demo fixture",
      scopes: ["mcp", "shiplets:read", "shiplets:write", "feedback:read"],
      projectAccessMode: "all",
    },
  });
  expect(keyResponse.status()).toBe(201);
  const issued = await keyResponse.json();
  // Synthetic, isolated key stays in memory; recordings and output omit it.
  const api = createShipletClient({
    origin,
    execute: async ({ code }) => {
      const response = await request.post("/api/mcp", {
        headers: { authorization: `Bearer ${issued.token}` },
        data: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute", arguments: { code } },
        },
      });
      expect(response.status()).toBe(200);
      const result = await response.json();
      if (result.error) throw new Error(`MCP failed with code ${result.error.code}`);
      // Same content envelope consumed by the provider package; Kody runtime is a fixture boundary.
      return result.result;
    },
  });
  const ref = await api.publish({
    name: "Field Notes · Alder Ridge",
    organizationId: organization.id,
    subdomain: `field-notes-${Date.now()}`,
    visibility: "private",
    files: [{ path: "index.html", content: fieldNotes() }],
  });
  await page.goto(
    `/auth/callback?${new URLSearchParams({ code: `test-code:${organization.id}:${encodeURIComponent(email)}` })}`,
  );
  await page.goto(ref.reviewUrl);
  const frame = page.frameLocator("[data-shiplet-artifact-frame]");
  await expect(
    frame.getByRole("heading", { name: "A quiet climb. A wide-open view." }),
  ).toBeVisible();
  await expect(frame.getByRole("link", { name: "Get started" })).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/01-review.png`, fullPage: true });

  await page.getByRole("button", { name: /Annotate revision_/ }).click();
  await frame.getByRole("link", { name: "Get started" }).click();
  await page
    .locator("#shiplet-review-comment")
    .fill(
      "Make the main action specific: “View the trail guide”. Add distance, walking time, and elevation before I commit to the route.",
    );
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Send annotation", exact: true }).click();
  const confirmation = await popupPromise;
  await confirmation.waitForLoadState("domcontentloaded");
  await confirmation.getByRole("button", { name: "Confirm and send feedback" }).click();
  await expect(confirmation.getByRole("heading", { name: "Feedback sent" })).toBeVisible();
  await confirmation.close();
  await expect(page.locator(".shiplet-review-count")).toHaveText("1");
  await page.locator(".shiplet-review-count").click();
  await expect(
    page.getByText("Make the main action specific:", { exact: false }).first(),
  ).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/02-feedback.png`, fullPage: true });
  const feedback = await api.feedback({ ref });
  expect(feedback.feedback).toHaveLength(1);
  const ticket = feedback.feedback[0];
  expect(ticket.source_revision_id).toBe(ref.revisionId);
  const candidate = await api.prepareRevision({
    ref,
    feedbackIds: [ticket.id],
    changes: [{ path: "index.html", content: fieldNotes(true) }],
  });
  const evidence = await api.verifyRevision({
    candidate,
    checks: [
      {
        feedbackId: ticket.id,
        path: "index.html",
        includes: "View the trail guide",
        excludes: "Get started",
      },
      { feedbackId: ticket.id, path: "index.html", includes: "2–3 hours" },
      { feedbackId: ticket.id, path: "index.html", includes: "640 feet" },
    ],
  });
  expect(evidence.results.every((r) => r.outcome === "changed_checks_passed")).toBe(true);
  await page.goto(candidate.previewUrl);
  await expect(
    page
      .frameLocator("[data-shiplet-artifact-frame]")
      .getByRole("link", { name: "View the trail guide" }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/03-revision-preview.png`, fullPage: true });
  const pending = await api.activateRevision({
    candidate,
    idempotencyKey: `demo-${candidate.draftId}`,
  });
  expect(pending.state).toBe("approval_required");
  if (pending.state !== "approval_required") throw new Error("Expected owner approval");
  await page.goto(pending.approvalUrl);
  const approvalResponse = page.waitForResponse(
    (r) => r.url().endsWith("/confirm") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Approve this exact action" }).click();
  const confirmed = await approvalResponse;
  expect(await confirmed.request().headerValue("origin")).toBe(origin);
  expect(confirmed.status()).toBe(200);
  const active = await api.activateRevision({
    candidate,
    idempotencyKey: `demo-${candidate.draftId}`,
    approvalRequestId: pending.approvalRequestId,
  });
  expect(active.state).toBe("active");
  await page.goto(ref.reviewUrl);
  await expect(frame.getByRole("link", { name: "View the trail guide" })).toBeVisible();
  await expect(frame.getByText("2–3 hours")).toBeVisible();
  await page.screenshot({ path: `${evidenceDir}/04-active-review.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${evidenceDir}/05-mobile-review.png`, fullPage: true });
  expect(await frame.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth)).toBe(
    true,
  );
  expect(
    (await api.feedback({ ref: { ...ref, revisionId: candidate.revisionId } })).feedback[0],
  ).toMatchObject({
    status: "New",
    source_revision_id: ref.revisionId,
    revisionRelation: "other_revision",
  });
  expect(errors).toEqual([]);
  await writeFile(
    `${evidenceDir}/receipt.json`,
    JSON.stringify(
      {
        boundary:
          "Local Wrangler/D1/R2 and synthetic account; actual browser annotation and owner confirmation. Kody bridge fixture; no hosted consent or package publication.",
        ref,
        ticketId: ticket.id,
        candidate,
        evidence,
      },
      null,
      2,
    ),
  );
});
