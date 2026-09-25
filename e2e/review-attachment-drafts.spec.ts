import { expect, test, type Page } from "@playwright/test";

import {
  reviewAttachmentDraftScript,
  reviewAttachmentDraftStyles,
} from "../src/review-attachment-drafts";

test.use({
  viewport: { width: 880, height: 720 },
  screenshot: "off",
  trace: "off",
  video: "off",
});

const evidenceRoot = "/private/tmp/shiplet-parity-attachment-drafts-20260920";
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

async function mountDrafts(
  page: Page,
  options: { controlledReaders?: boolean; fakeObjectUrls?: boolean } = {},
) {
  await page.setContent(`<!doctype html>
    <html>
      <head><meta charset="utf-8"><style>${reviewAttachmentDraftStyles()}</style></head>
      <body><main style="max-width:720px;margin:32px auto"><div id="drafts"></div></main></body>
    </html>`);
  await page.addScriptTag({ content: reviewAttachmentDraftScript() });
  await page.evaluate((settings) => {
    const state = {
      createdUrls: [] as string[],
      revokedUrls: [] as string[],
      readers: [] as Array<any>,
    };
    (window as any).__attachmentState = state;

    class ControlledReader {
      result: string | ArrayBuffer | null = null;
      error: Error | null = null;
      aborted = 0;
      file: Blob | null = null;
      listeners = new Map<string, Array<() => void>>();

      addEventListener(type: string, listener: () => void) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      readAsDataURL(file: Blob) {
        this.file = file;
        state.readers.push(this);
      }

      abort() {
        this.aborted += 1;
        this.emit("abort");
      }

      emit(type: string) {
        (this.listeners.get(type) || []).slice().forEach((listener) => listener());
      }

      succeed(encoded = "QQ==") {
        this.result = `data:application/octet-stream;base64,${encoded}`;
        this.emit("load");
      }

      fail() {
        this.error = new Error("held reader failed");
        this.emit("error");
      }
    }

    let nextUrl = 0;
    const componentOptions: Record<string, unknown> = {
      container: document.querySelector("#drafts"),
    };
    if (settings.fakeObjectUrls) {
      componentOptions.createObjectURL = () => {
        nextUrl += 1;
        const url = `blob:d3a-${nextUrl}`;
        state.createdUrls.push(url);
        return url;
      };
      componentOptions.revokeObjectURL = (url: string) => {
        state.revokedUrls.push(url);
      };
    }
    if (settings.controlledReaders) {
      componentOptions.readerFactory = () => new ControlledReader();
    }
    (window as any).__attachmentDrafts = (window as any).createReviewAttachmentDrafts(
      componentOptions,
    );
  }, options);
  return page.locator(".shiplet-attachment-drafts");
}

test("chooser and file-only drop add real files with previews, metadata and keyboard removal", async ({
  page,
}) => {
  const root = await mountDrafts(page);
  await expect(page.getByRole("button", { name: "Attach photos or video" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Drop photos or video here" })).toBeVisible();
  await expect(root).toContainText("Up to 4 files · 5 MiB each · 10 MiB total");

  await root.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(root.getByRole("listitem")).toHaveCount(1);
  await expect(root.locator("img")).toHaveAttribute("alt", "Preview of pixel.png");
  await expect(root).toContainText("image/png");

  const dropResult = await page.evaluate(() => {
    const drop = document.querySelector(".shiplet-attachment-drop")!;
    const textTransfer = new DataTransfer();
    textTransfer.setData("text/plain", "not a file");
    const textDrop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: textTransfer,
    });
    drop.dispatchEvent(textDrop);
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([0, 0, 0, 20])], "walkthrough.mp4", {
        type: "video/mp4",
        lastModified: 72,
      }),
    );
    drop.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: transfer }));
    drop.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const video = document.querySelector("video");
    return {
      count: (window as any).__attachmentDrafts.current().length,
      textDropPrevented: textDrop.defaultPrevented,
      video: video
        ? { controls: video.controls, autoplay: video.autoplay, preload: video.preload }
        : null,
    };
  });
  expect(dropResult).toEqual({
    count: 2,
    textDropPrevented: false,
    video: { controls: true, autoplay: false, preload: "metadata" },
  });
  await expect(
    root.getByRole("listitem").filter({ hasText: "walkthrough.mp4" }),
  ).toContainText("Preview unavailable");
  const current = await page.evaluate(() => (window as any).__attachmentDrafts.current());
  expect(current.map((entry: { id: string }) => entry.id)).toEqual([
    expect.stringMatching(/^attachment_[A-Za-z0-9-]+$/),
    expect.stringMatching(/^attachment_[A-Za-z0-9-]+$/),
  ]);
  expect(new Set(current.map((entry: { id: string }) => entry.id)).size).toBe(2);

  const removeImage = page.getByRole("button", { name: "Remove pixel.png" });
  await removeImage.focus();
  await removeImage.press("Enter");
  await expect(root.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Attach photos or video" })).toBeFocused();

  await root.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(root.getByRole("listitem")).toHaveCount(2);
  await page.evaluate(() => {
    const api = (window as any).__attachmentDrafts;
    api.hide();
    api.show();
  });
  await expect(root).toBeVisible();
  await expect(root.getByRole("listitem")).toHaveCount(2);
  await page.screenshot({ path: `${evidenceRoot}/component-attachments-green.png` });
});

test("exact bounds keep accepted state, add valid subsets in order, and ignore duplicates before capacity errors", async ({
  page,
}) => {
  const root = await mountDrafts(page, { fakeObjectUrls: true });
  const initial = await page.evaluate(() => {
    const api = (window as any).__attachmentDrafts;
    return api.addFiles([
      new File([], "empty.png", { type: "image/png", lastModified: 1 }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "oversize.png", {
        type: "image/png",
        lastModified: 2,
      }),
      new File([new Uint8Array(5 * 1024 * 1024)], "boundary-a.png", {
        type: "image/png",
        lastModified: 3,
      }),
      new File([new Uint8Array(5 * 1024 * 1024)], "boundary-b.WMV", {
        type: "application/octet-stream",
        lastModified: 4,
      }),
      new File([new Uint8Array([1])], "unsupported.zip", {
        type: "application/zip",
        lastModified: 5,
      }),
    ]);
  });
  expect(initial.value.map((entry: { name: string }) => entry.name)).toEqual([
    "boundary-a.png",
    "boundary-b.WMV",
  ]);
  expect(initial.errors).toEqual([
    "empty.png must be between 1 byte and 5 MiB.",
    "oversize.png must be between 1 byte and 5 MiB.",
    "unsupported.zip is not a supported photo or video.",
  ]);
  await expect(root).toContainText("2 files · 10 MiB");
  expect(
    await page.evaluate(() =>
      (window as any).__attachmentDrafts.addFiles([
        new File([new Uint8Array([1])], "over-total.png", {
          type: "image/png",
          lastModified: 6,
        }),
      ]),
    ),
  ).toMatchObject({ errors: ["Attachments must total 10 MiB or less."] });

  const capacity = await page.evaluate(() => {
    const api = (window as any).__attachmentDrafts;
    api.clear();
    const files = [0, 1, 2, 3].map(
      (index) =>
        new File([new Uint8Array([index + 1])], `small-${index}.png`, {
          type: "image/png",
          lastModified: 20 + index,
        }),
    );
    api.addFiles(files);
    const duplicateOnly = api.addFiles([files[0]]);
    const mixture = api.addFiles([
      files[0],
      new File([new Uint8Array([9])], "fifth.png", {
        type: "image/png",
        lastModified: 30,
      }),
      new File([new Uint8Array([10])], "sixth.png", {
        type: "image/png",
        lastModified: 31,
      }),
    ]);
    return { duplicateOnly, mixture, current: api.current() };
  });
  expect(capacity.duplicateOnly.errors).toEqual([]);
  expect(capacity.mixture.errors).toEqual(["You can attach up to 4 files."]);
  expect(capacity.current.map((entry: { name: string }) => entry.name)).toEqual([
    "small-0.png",
    "small-1.png",
    "small-2.png",
    "small-3.png",
  ]);

  const subset = await page.evaluate(() => {
    const api = (window as any).__attachmentDrafts;
    api.clear();
    return api.addFiles([
      new File([new Uint8Array([1])], "first.png", { type: "image/png", lastModified: 40 }),
      new File([new Uint8Array([2])], "bad.bin", { type: "application/octet-stream", lastModified: 41 }),
      new File([new Uint8Array([3])], "second.jpg", { type: "image/jpeg", lastModified: 42 }),
      new File([new Uint8Array([4])], "bad.bin", { type: "application/octet-stream", lastModified: 43 }),
    ]);
  });
  expect(subset.value.map((entry: { name: string }) => entry.name)).toEqual([
    "first.png",
    "second.jpg",
  ]);
  expect(subset.errors).toEqual(["bad.bin is not a supported photo or video."]);
});

test("metadata fallback keeps allowed codecs while SVG scripts, references and malicious names stay inert", async ({
  page,
}) => {
  let externalRequests = 0;
  await page.route("https://attacker.invalid/**", async (route) => {
    externalRequests += 1;
    await route.abort();
  });
  const root = await mountDrafts(page);
  const result = await page.evaluate(() => {
    (window as any).__svgExecuted = false;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>window.__svgExecuted = true</script>
      <image href="https://attacker.invalid/tracker.png" />
    </svg>`;
    const maliciousName = '<img src="https://attacker.invalid/name" onerror="window.__nameExecuted=true">.png';
    (window as any).__nameExecuted = false;
    return (window as any).__attachmentDrafts.addFiles([
      new File([svg], "payload.svg", { type: "image/svg+xml", lastModified: 51 }),
      new File([new Uint8Array([1])], "photo.heic", { type: "image/heic", lastModified: 52 }),
      new File([new Uint8Array([2])], maliciousName, { type: "image/png", lastModified: 53 }),
    ]);
  });
  expect(result.value).toHaveLength(3);
  await expect(root.getByText("Preview unavailable")).toHaveCount(3);
  await expect(root.getByText("payload.svg")).toBeVisible();
  await expect(root.getByText("photo.heic")).toBeVisible();
  await expect(root.getByText(/<img src=.*onerror=/)).toBeVisible();
  await page.waitForTimeout(150);
  expect(externalRequests).toBe(0);
  expect(
    await page.evaluate(() => ({
      svg: (window as any).__svgExecuted,
      name: (window as any).__nameExecuted,
      injected: document.querySelectorAll("[onerror]").length,
      dangerousRenderers: document.querySelectorAll("iframe,object,embed").length,
    })),
  ).toEqual({ svg: false, name: false, injected: 0, dangerousRenderers: 0 });
});

test("object URLs survive render and hide cycles, then revoke exactly once on remove, clear, replace and destroy", async ({
  page,
}) => {
  const root = await mountDrafts(page, { fakeObjectUrls: true });
  const evidence = await page.evaluate(() => {
    const api = (window as any).__attachmentDrafts;
    const state = (window as any).__attachmentState;
    api.addFiles([
      new File([new Uint8Array([1])], "a.png", { type: "image/png", lastModified: 61 }),
      new File([new Uint8Array([2])], "b.png", { type: "image/png", lastModified: 62 }),
      new File([new Uint8Array([3])], "c.png", { type: "image/png", lastModified: 63 }),
    ]);
    const firstSnapshot = api.current();
    firstSnapshot[0].name = "mutated outside";
    api.hide();
    api.show();
    api.addFiles([
      new File([new Uint8Array([1])], "a.png", { type: "image/png", lastModified: 61 }),
    ]);
    const afterCycles = state.createdUrls.slice();
    api.remove(api.current()[1].id);
    const afterRemove = state.revokedUrls.slice();
    api.clear();
    const afterClear = state.revokedUrls.slice();
    api.addFiles([
      new File([new Uint8Array([4])], "d.png", { type: "image/png", lastModified: 64 }),
    ]);
    const firstDestroy = api.destroy();
    const secondDestroy = api.destroy();
    return {
      defensiveName: api.current()[0]?.name || null,
      afterCycles,
      afterRemove,
      afterClear,
      finalRevoked: state.revokedUrls.slice(),
      firstDestroy,
      secondDestroy,
    };
  });
  expect(evidence.afterCycles).toEqual(["blob:d3a-1", "blob:d3a-2", "blob:d3a-3"]);
  expect(evidence.afterRemove).toEqual(["blob:d3a-2"]);
  expect(evidence.afterClear).toEqual(["blob:d3a-2", "blob:d3a-1", "blob:d3a-3"]);
  expect(evidence.finalRevoked).toEqual([
    "blob:d3a-2",
    "blob:d3a-1",
    "blob:d3a-3",
    "blob:d3a-4",
  ]);
  expect(evidence.firstDestroy).toBe(true);
  expect(evidence.secondDestroy).toBe(false);
  await expect(root).toHaveCount(0);
});

test("serialization snapshots stay immutable, failures retry, and clear or restore settle held readers without stale UI", async ({
  page,
}) => {
  const root = await mountDrafts(page, {
    controlledReaders: true,
    fakeObjectUrls: true,
  });

  const immutable = await page.evaluate(async () => {
    const api = (window as any).__attachmentDrafts;
    const state = (window as any).__attachmentState;
    api.addFiles([
      new File([new Uint8Array([1])], "old.png", { type: "image/png", lastModified: 71 }),
    ]);
    const old = api.current()[0];
    const pending = api.serialize();
    api.remove(old.id);
    api.addFiles([
      new File([new Uint8Array([2])], "new.webp", { type: "image/webp", lastModified: 72 }),
    ]);
    state.readers[0].succeed("T0xE");
    return { serialized: await pending, current: api.current() };
  });
  expect(immutable.serialized).toEqual([
    {
      id: immutable.serialized[0].id,
      name: "old.png",
      mimeType: "image/png",
      size: 1,
      dataUrl: "data:image/png;base64,T0xE",
    },
  ]);
  expect(immutable.current.map((entry: { name: string }) => entry.name)).toEqual([
    "new.webp",
  ]);

  const retry = await page.evaluate(async () => {
    const api = (window as any).__attachmentDrafts;
    const state = (window as any).__attachmentState;
    api.addFiles([
      new File([new Uint8Array([3])], "companion.mov", {
        type: "video/quicktime",
        lastModified: 721,
      }),
    ]);
    const firstStart = state.readers.length;
    const first = api.serialize().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const firstReaders = state.readers.slice(firstStart);
    firstReaders[1].fail();
    const failed = await first;
    const secondStart = state.readers.length;
    const second = api.serialize();
    const secondReaders = state.readers.slice(secondStart);
    secondReaders[0].succeed("TkVX");
    secondReaders[1].succeed("TU9W");
    return {
      failed,
      failedReaderAborts: firstReaders.map((reader: any) => reader.aborted),
      retried: await second,
      current: api.current(),
    };
  });
  expect(retry.failed).toBe("held reader failed");
  expect(retry.failedReaderAborts).toEqual([1, 1]);
  expect(retry.retried[0].dataUrl).toBe("data:image/webp;base64,TkVX");
  expect(retry.retried[1].dataUrl).toBe("data:video/quicktime;base64,TU9W");
  expect(retry.current).toHaveLength(2);

  const cancelledByClear = await page.evaluate(async () => {
    const api = (window as any).__attachmentDrafts;
    const state = (window as any).__attachmentState;
    const readerIndex = state.readers.length;
    const pending = api.serialize().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    api.clear();
    const reader = state.readers[readerIndex];
    const outcome = await pending;
    reader.succeed("TEFURQ==");
    await Promise.resolve();
    return { outcome, aborted: reader.aborted, current: api.current() };
  });
  expect(cancelledByClear).toEqual({
    outcome: "Attachment serialization was cancelled because the draft was cleared.",
    aborted: 1,
    current: [],
  });

  const restore = await page.evaluate(async () => {
    const api = (window as any).__attachmentDrafts;
    const state = (window as any).__attachmentState;
    api.addFiles([
      new File([new Uint8Array([3])], "prior.png", { type: "image/png", lastModified: 73 }),
    ]);
    const prior = api.current();
    const urlsBeforeInvalid = state.createdUrls.slice();
    const invalid = api.restore([
      {
        id: "x".repeat(257),
        file: new File([new Uint8Array([4])], "corrupt.png", {
          type: "image/png",
          lastModified: 74,
        }),
      },
    ]);
    const afterInvalid = api.current();
    const oversized = api.restore([
      {
        id: "attachment_oversized_restore",
        file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], "oversized.png", {
          type: "image/png",
          lastModified: 741,
        }),
      },
    ]);
    const afterOversized = api.current();
    const heldIndex = state.readers.length;
    const held = api.serialize().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    const createdBeforeValid = state.createdUrls.slice();
    const valid = api.restore([
      {
        id: "attachment_restored_stable",
        file: new Blob([new Uint8Array([5])], { type: "video/quicktime" }),
        name: "restored.mov",
        lastModified: 75,
        mimeType: "video/quicktime",
      },
    ]);
    const heldReader = state.readers[heldIndex];
    const outcome = await held;
    heldReader.succeed("U1RBTEU=");
    await Promise.resolve();
    return {
      prior,
      invalid,
      afterInvalid,
      oversized,
      afterOversized,
      urlsBeforeInvalid,
      urlsAfterInvalid: state.createdUrls.slice(0, urlsBeforeInvalid.length),
      valid,
      current: api.current(),
      heldOutcome: outcome,
      heldAborted: heldReader.aborted,
      createdBeforeValid,
      created: state.createdUrls.slice(),
      revoked: state.revokedUrls.slice(),
    };
  });
  expect(restore.invalid.ok).toBe(false);
  expect(restore.afterInvalid).toEqual(restore.prior);
  expect(restore.oversized.ok).toBe(false);
  expect(restore.afterOversized).toEqual(restore.prior);
  expect(restore.urlsAfterInvalid).toEqual(restore.urlsBeforeInvalid);
  expect(restore.valid.ok).toBe(true);
  expect(restore.current).toEqual([
    expect.objectContaining({
      id: "attachment_restored_stable",
      name: "restored.mov",
      mimeType: "video/quicktime",
      size: 1,
    }),
  ]);
  expect(restore.heldOutcome).toBe(
    "Attachment serialization was cancelled because the draft was replaced.",
  );
  expect(restore.heldAborted).toBe(1);
  expect(restore.created).toHaveLength(restore.createdBeforeValid.length + 1);
  expect(restore.created.at(-1)).not.toBe(restore.createdBeforeValid.at(-1));
  expect(restore.revoked.at(-1)).toBe(restore.createdBeforeValid.at(-1));
  await expect(root.getByText("restored.mov")).toBeVisible();
  await expect(root).not.toContainText("corrupt.png");

  const destroyed = await page.evaluate(async () => {
    const api = (window as any).__attachmentDrafts;
    const state = (window as any).__attachmentState;
    const readerIndex = state.readers.length;
    const pending = api.serialize().then(
      () => "resolved",
      (error: Error) => error.message,
    );
    api.destroy();
    const reader = state.readers[readerIndex];
    const outcome = await pending;
    reader.succeed("TEFURQ==");
    await Promise.resolve();
    return { outcome, aborted: reader.aborted, rootConnected: api.root.isConnected };
  });
  expect(destroyed).toEqual({
    outcome: "Attachment serialization was cancelled because the component was destroyed.",
    aborted: 1,
    rootConnected: false,
  });
  await expect(root).toHaveCount(0);
});
