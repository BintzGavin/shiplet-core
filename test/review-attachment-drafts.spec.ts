import { describe, expect, it } from "vitest";

import {
  REVIEW_ATTACHMENT_ACCEPT,
  REVIEW_ATTACHMENT_EXTENSION_TYPES,
  REVIEW_ATTACHMENT_MAX_BYTES,
  REVIEW_ATTACHMENT_MAX_COUNT,
  REVIEW_ATTACHMENT_MAX_TOTAL_BYTES,
  REVIEW_ATTACHMENT_MIME_TYPES,
  resolveReviewAttachmentMimeType,
  reviewAttachmentDraftScript,
  reviewAttachmentDraftStyles,
} from "../src/review-attachment-drafts";

describe("review attachment drafts", () => {
  it("preserves the production MIME and extension selection hints exactly", () => {
    expect(REVIEW_ATTACHMENT_MIME_TYPES).toEqual([
      "image/gif",
      "image/heic",
      "image/jpeg",
      "image/png",
      "image/svg+xml",
      "image/tiff",
      "image/webp",
      "image/vnd.microsoft.icon",
      "video/x-amv",
      "video/x-ms-asf",
      "video/x-msvideo",
      "video/x-f4v",
      "video/x-flv",
      "video/mp4",
      "application/mp4",
      "video/webm",
      "video/quicktime",
      "video/mpeg",
    ]);
    expect(REVIEW_ATTACHMENT_EXTENSION_TYPES).toEqual({
      amv: "video/x-amv",
      asf: "video/x-ms-asf",
      avi: "video/x-msvideo",
      f4v: "video/x-f4v",
      flv: "video/x-flv",
      gif: "image/gif",
      gifv: "video/mp4",
      heic: "image/heic",
      ico: "image/vnd.microsoft.icon",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      m4v: "video/mp4",
      mov: "video/quicktime",
      mp4: "video/mp4",
      mpeg: "video/mpeg",
      mpg: "video/mpeg",
      png: "image/png",
      qt: "video/quicktime",
      svg: "image/svg+xml",
      tif: "image/tiff",
      tiff: "image/tiff",
      webm: "video/webm",
      webp: "image/webp",
      wmv: "video/x-ms-asf",
    });
    expect(REVIEW_ATTACHMENT_ACCEPT).toBe(
      "image/*,video/*,.amv,.asf,.avi,.f4v,.flv,.gifv,.m4v,.mov,.mpeg,.mp4,.qt,.webm,.wmv",
    );
    expect(REVIEW_ATTACHMENT_MAX_COUNT).toBe(4);
    expect(REVIEW_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(REVIEW_ATTACHMENT_MAX_TOTAL_BYTES).toBe(10 * 1024 * 1024);
  });

  it("lets a supported declared MIME win and otherwise uses only the exact fallback map", () => {
    expect(
      resolveReviewAttachmentMimeType({
        name: "misleading.txt",
        type: "IMAGE/PNG",
      }),
    ).toBe("image/png");
    expect(
      resolveReviewAttachmentMimeType({
        name: "clip.M4V",
        type: "application/octet-stream",
      }),
    ).toBe("video/mp4");
    expect(
      resolveReviewAttachmentMimeType({
        name: "photo.svg",
        type: "text/plain",
      }),
    ).toBe("image/svg+xml");
    expect(
      resolveReviewAttachmentMimeType({
        name: "archive.zip",
        type: "application/octet-stream",
      }),
    ).toBeNull();
  });

  it("emits a standalone classic factory and scoped accessible styles without transport or storage APIs", () => {
    const script = reviewAttachmentDraftScript();
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("function createReviewAttachmentDrafts(options)");
    expect(script).toContain('chooseButton.textContent = "Attach photos or video"');
    expect(script).toContain('dropTarget.textContent = "Drop photos or video here"');
    expect(script).toContain("serialize: serialize");
    expect(script).toContain("restore: restore");
    expect(script).not.toMatch(
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|postMessage|MessageChannel|MessagePort|localStorage|indexedDB|window\.open|location\s*=|innerHTML|<iframe|<object|<embed/,
    );

    const styles = reviewAttachmentDraftStyles();
    expect(styles).toContain(".shiplet-attachment-drafts{");
    expect(styles).toContain(".shiplet-attachment-drop[data-dragging=\"true\"]");
    expect(styles).toContain("@media(prefers-reduced-motion:reduce)");
  });
});
