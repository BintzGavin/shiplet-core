import { createServer, type Server } from "node:http";

import { expect, test } from "@playwright/test";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { PLATFORM_CLIENT_ASSETS } from "../src/generated-platform-client";
import type { KernelDocumentNonce } from "../src/kernel-document-nonce";
import type { FeedbackFilters } from "../src/platform/feedback-state";
import type { ReviewFeedbackRecord } from "../src/review";

const origin = "http://127.0.0.1:8817";
const nonce = "staging-platform-e2e-nonce" as KernelDocumentNonce;
const requestedFeedbackUrls: string[] = [];
let server: Server;
let vite: ViteDevServer;
let buildPlatformFeedbackPage: (options: {
  nonce: KernelDocumentNonce;
  feedback: ReviewFeedbackRecord[];
  filters: FeedbackFilters;
}) => string;

function feedback(status: ReviewFeedbackRecord["status"]): ReviewFeedbackRecord {
  return {
    id: `feedback_${status.toLowerCase().replaceAll(" ", "_")}`,
    project_id: "project_staging_platform",
    organization_id: "org_staging_platform",
    revision_id: "revision_staging_platform",
    ticket_number: status === "Staging" ? 15 : 16,
    ticket_label: status === "Staging" ? "PF-15" : "PF-16",
    client_feedback_id: `client_${status.toLowerCase().replaceAll(" ", "_")}`,
    name: "Reviewer",
    comment: status === "Staging" ? "Ready on staging" : "Still being reviewed",
    status,
    page_url: `${origin}/artifact`,
    pathname: "/artifact",
    page_url_key: "/artifact",
    screenshot_key: null,
    screenshot_url: null,
    screenshot_content_type: null,
    screenshot_size: null,
    screenshot_failure_note: null,
    screenshot_mode: "page",
    viewport: null,
    coordinates: null,
    selected_element: null,
    capture_context: null,
    user_agent: null,
    submitted_by_user_id: "user_staging_platform",
    submitted_by_email: "reviewer@example.test",
    submitted_by_avatar_preset: null,
    submitted_by_avatar_data_url: null,
    source: "test",
    created_on: "2026-09-20T00:00:00.000Z",
    updated_on: "2026-09-20T00:00:00.000Z",
    project_name: "Staging platform fixture",
    project_subdomain: "staging-platform-fixture",
    replies: [],
    mentions: [],
  };
}

const staging = feedback("Staging");
const inProgress = feedback("In Progress");

function documentFor(url: URL) {
  const status = url.searchParams.get("status");
  const rows = status === "Staging" ? [staging] : [staging, inProgress];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Feedback</title></head><body>${buildPlatformFeedbackPage({
    nonce,
    feedback: rows,
    filters: {
      projectId: null,
      status: status === "Staging" ? "Staging" : null,
      mentionedMe: false,
      watched: false,
      submittedByMe: false,
    },
  })}</body></html>`;
}

test.beforeAll(async () => {
  vite = await createViteServer({
    root: "/private/tmp/shiplet-parity-20260920",
    appType: "custom",
    server: { middlewareMode: true },
  });
  const pageModule = await vite.ssrLoadModule("/src/platform/feedback-page.tsx");
  buildPlatformFeedbackPage = pageModule.BuildPlatformFeedbackPage;
  server = createServer((request, response) => {
    const url = new URL(request.url || "/", origin);
    if (url.pathname === "/assets/platform/feedback.js") {
      response.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(PLATFORM_CLIENT_ASSETS["/assets/platform/feedback.js"]);
      return;
    }
    if (url.pathname === "/api/feedback") {
      requestedFeedbackUrls.push(url.toString());
      const rows = url.searchParams.get("status") === "Staging" ? [staging] : [staging, inProgress];
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ feedback: rows }));
      return;
    }
    if (url.pathname === "/api/notifications") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ notifications: [] }));
      return;
    }
    if (url.pathname === "/feedback") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(documentFor(url));
      return;
    }
    response.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8817, "127.0.0.1", resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await vite.close();
});

test.beforeEach(() => {
  requestedFeedbackUrls.length = 0;
});

test("serves and hydrates the canonical Staging filter through selection, refresh, and reload", async ({ page }) => {
  await page.goto(`${origin}/feedback`);
  const app = page.locator('[data-platform-route="feedback"]');
  await expect(app).toHaveAttribute("data-feedback-hydration", "hydrated");
  const status = page.getByRole("combobox", { name: "Status filter" });
  await expect(status.locator("option")).toHaveText([
    "Any status",
    "New",
    "In Progress",
    "Blocked",
    "Staging",
    "Done",
    "Dropped",
  ]);

  await status.selectOption("Staging");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect.poll(() => requestedFeedbackUrls.some((value) => new URL(value).searchParams.get("status") === "Staging")).toBe(true);
  await expect(page).toHaveURL(`${origin}/feedback?status=Staging`);
  await expect(status).toHaveValue("Staging");
  await expect(page.locator('[data-feedback-row="feedback_staging"]')).toContainText("Staging");
  await expect(page.locator('[data-feedback-row="feedback_in_progress"]')).toHaveCount(0);

  await page.evaluate((row) => {
    window.dispatchEvent(
      new CustomEvent("shiplet:platform-feedback-updated", {
        detail: {
          feedback: [row],
          filters: {
            projectId: null,
            status: "Staging",
            mentionedMe: false,
            watched: false,
            submittedByMe: false,
          },
        },
      }),
    );
  }, staging);
  await expect(status).toHaveValue("Staging");
  await expect(page.locator('[data-feedback-row="feedback_staging"]')).toContainText("Ready on staging");

  await page.reload();
  await expect(app).toHaveAttribute("data-feedback-hydration", "hydrated");
  await expect(status).toHaveValue("Staging");
  await expect(page.locator('[data-feedback-row="feedback_staging"]')).toContainText("Staging");
});
