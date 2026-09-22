import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  admitReviewAttachment,
  admitReviewRichPayload,
  compactReviewRichPayload,
  validateReviewRichPayload,
  type ReviewRichAttachmentInput,
  type ReviewRichPayloadV1,
} from "../src/review-rich-payload";
import {
  prepareDurableReviewPayload,
  stageDurableReviewPayload,
} from "../src/review";
import { digestReviewOperationPayload } from "../src/review-operations";

const OWNER = {
  "x-shiplet-user-id": "user_rich_payload_owner",
  "x-shiplet-user-email": "rich-payload-owner@example.com",
};

async function request(path: string, init: RequestInit = {}, runtime = env as Env) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    runtime,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function dataUrl(bytes: Uint8Array, contentType = "application/octet-stream") {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function bytesFor(kind: string, length = 16) {
  const bytes = new Uint8Array(length);
  if (kind === "png") bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (kind === "jpeg") bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  if (kind === "gif") bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  if (kind === "webp") bytes.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  if (kind === "ico") bytes.set([0x00, 0x00, 0x01, 0x00]);
  if (kind === "tiff-le") bytes.set([0x49, 0x49, 0x2a, 0x00]);
  if (kind === "tiff-be") bytes.set([0x4d, 0x4d, 0x00, 0x2a]);
  if (kind === "heic") bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  if (kind === "mp4") bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  if (kind === "quicktime") bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
  if (kind === "webm") bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  if (kind === "mpeg") bytes.set([0x00, 0x00, 0x01, 0xba]);
  if (kind === "avi") bytes.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
  if (kind === "amv") bytes.set([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x4d, 0x56, 0x20]);
  if (kind === "asf") bytes.set([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
  if (kind === "flv") bytes.set([0x46, 0x4c, 0x56, 0x01]);
  return bytes;
}

function attachment(
  id: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  size = bytes.byteLength,
): ReviewRichAttachmentInput {
  return { id, name, mimeType, size, dataUrl: dataUrl(bytes, mimeType || "application/octet-stream") };
}

const safeSvg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>',
);

function richPayload(overrides: Partial<ReviewRichPayloadV1> = {}): ReviewRichPayloadV1 {
  return {
    version: 1,
    screenshotAnnotations: {
      version: 1,
      coordinateSpace: "normalized",
      imageWidth: 100,
      imageHeight: 100,
      shapes: [
        {
          id: "shape-1",
          type: "text",
          color: "#AABBCC",
          x: 0.1,
          y: 0.1,
          width: 0.4,
          height: 0.2,
          fontSize: 16,
          text: "Review this area",
        },
      ],
    },
    captureFidelity: {
      version: 1,
      kind: "sanitized-dom",
      limitations: ["images", "external-styles"],
    },
    attachments: [
      attachment("image-1", "hero.png", "image/png", bytesFor("png"), 1),
      attachment("image-2", "icon.png", "image/png", bytesFor("png", 20)),
    ],
    copyRequest: {
      version: 1,
      changes: [
        {
          id: "copy-1",
          kind: "text",
          selector: "h1",
          previousText: "Before",
          proposedText: "After",
        },
        {
          id: "copy-2",
          kind: "image",
          selector: "img.hero",
          attachmentId: "image-1",
          altText: "Updated hero",
        },
      ],
    },
    ...overrides,
  };
}

async function fixture() {
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Rich payload ${crypto.randomUUID()}` }),
  });
  expect(organizationResponse.status).toBe(201);
  const { organization } = (await organizationResponse.json()) as { organization: { id: string } };
  const publishResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Rich payload fixture",
      organization_id: organization.id,
      subdomain: `rich-payload-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "public",
      assets: [{ path: "index.html", content: btoa("<!doctype html><h1>Rich payload</h1>") }],
    }),
  });
  expect(publishResponse.status).toBe(201);
  const { project } = (await publishResponse.json()) as { project: { id: string; subdomain: string } };
  await request(`/api/shiplets/${project.id}/package`, { headers: OWNER });
  const revision = await (env as Env).DB
    .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
    .bind(project.id)
    .first<{ active_revision_id: string }>();
  return { project, revisionId: revision!.active_revision_id, pageUrl: `http://localhost/${project.subdomain}` };
}

describe("rich review payload admission and persistence", () => {
  it("canonicalizes decoded size and uses exact extension fallback before container admission", async () => {
    const bytes = bytesFor("png", 32);
    const input = attachment("fallback-png", "capture.PNG", "", bytes, 1);
    const validation = validateReviewRichPayload(richPayload({ attachments: [input], copyRequest: null }));
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const [admitted] = await admitReviewRichPayload(validation.value);
    expect(admitted.input.mimeType).toBe("image/png");
    expect(admitted.input.contentType).toBe("image/png");
    expect(admitted.input.size).toBe(bytes.byteLength);
    expect(admitted.input.byteLength).toBe(bytes.byteLength);
    const descriptor = compactReviewRichPayload(validation.value, [admitted]);
    expect(descriptor.attachments[0]).toMatchObject({ size: bytes.byteLength, byteLength: bytes.byteLength });

    await expect(
      admitReviewAttachment({ ...input, dataUrl: dataUrl(bytesFor("jpeg"), "application/octet-stream") }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("admits every supported container family and rejects spoofed or unsafe bytes", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["png", "image/png", "png", "image/png"],
      ["jpeg", "image/jpeg", "jpg", "image/jpeg"],
      ["gif", "image/gif", "gif", "image/gif"],
      ["webp", "image/webp", "webp", "image/webp"],
      ["ico", "image/vnd.microsoft.icon", "ico", "image/vnd.microsoft.icon"],
      ["tiff-le", "image/tiff", "tiff", "image/tiff"],
      ["heic", "image/heic", "heic", "image/heic"],
      ["mp4", "video/mp4", "mp4", "video/mp4"],
      ["quicktime", "video/quicktime", "mov", "video/quicktime"],
      ["webm", "video/webm", "webm", "video/webm"],
      ["mpeg", "video/mpeg", "mpeg", "video/mpeg"],
      ["avi", "video/x-msvideo", "avi", "video/x-msvideo"],
      ["amv", "video/x-amv", "amv", "video/x-amv"],
      ["asf", "video/x-ms-asf", "asf", "video/x-ms-asf"],
      ["flv", "video/x-flv", "flv", "video/x-flv"],
      ["svg", "image/svg+xml", "svg", "image/svg+xml"],
    ];
    for (const [kind, mimeType, extension, expected] of cases) {
      const bytes = kind === "svg" ? safeSvg : bytesFor(kind);
      const admitted = await admitReviewAttachment(
        attachment(`file-${kind}`, `asset.${extension}`, mimeType, bytes),
      );
      expect(admitted.input.contentType).toBe(expected);
    }
    await expect(
      admitReviewAttachment(attachment("active-svg", "asset.svg", "", new TextEncoder().encode('<svg><script>alert(1)</script></svg>'))),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      admitReviewAttachment(attachment("external-svg", "asset.svg", "", new TextEncoder().encode('<svg><image href="https://example.com/a.png"/></svg>'))),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      admitReviewAttachment(attachment("spoofed", "asset.png", "image/png", bytesFor("jpeg"))),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("enforces exact attachment and encoded-body bounds", async () => {
    const fiveMiB = bytesFor("png", 5 * 1024 * 1024);
    const exact = attachment("five", "five.png", "image/png", fiveMiB, 1);
    const admitted = await admitReviewAttachment(exact);
    expect(admitted.input.byteLength).toBe(5 * 1024 * 1024);
    await expect(
      admitReviewAttachment(attachment("too-large", "large.png", "image/png", bytesFor("png", 5 * 1024 * 1024 + 1))),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      admitReviewRichPayload(richPayload({ attachments: [exact, attachment("over-total", "over.png", "image/png", bytesFor("png", 5 * 1024 * 1024 + 1))], copyRequest: null })),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      admitReviewAttachment({ ...exact, dataUrl: `${exact.dataUrl}${"A".repeat(2 * 1024 * 1024)}` }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("changes durable identity for order, digest, annotations, fidelity, and copy data", async () => {
    const base = {
      comment: "Review summary",
      pageUrl: "https://example.test/review",
      clientFeedbackId: "rich-identity-1234",
      richPayload: richPayload(),
    };
    const baseJson = await prepareDurableReviewPayload(env as Env, "project-test", "request-test", base);
    const baseDigest = await digestReviewOperationPayload(baseJson);
    expect(baseJson).not.toContain("data:image/");
    expect(JSON.parse(baseJson).richPayload.attachments[0]).toMatchObject({ size: 16, byteLength: 16 });
    const variants = [
      { ...base, richPayload: { ...base.richPayload, attachments: [...base.richPayload.attachments].reverse() } },
      { ...base, richPayload: { ...base.richPayload, attachments: [{ ...base.richPayload.attachments[0], dataUrl: dataUrl(bytesFor("png", 21), "image/png") }, base.richPayload.attachments[1]] } },
      { ...base, richPayload: { ...base.richPayload, screenshotAnnotations: null } },
      { ...base, richPayload: { ...base.richPayload, captureFidelity: { version: 1 as const, kind: "fallback" as const, limitations: ["media"] as const } } },
      { ...base, richPayload: { ...base.richPayload, copyRequest: { version: 1 as const, changes: [{ ...base.richPayload.copyRequest!.changes[0], proposedText: "Changed" }] } } },
    ];
    for (const variant of variants) {
      const variantJson = await prepareDurableReviewPayload(env as Env, "project-test", "request-test", variant);
      expect(await digestReviewOperationPayload(variantJson)).not.toBe(baseDigest);
    }
  });

  it("persists canonical attachment metadata, ordered rows, and legacy nullable rich fields", async () => {
    const { project, pageUrl } = await fixture();
    const body = {
      comment: "Rich persistence",
      pageUrl,
      clientFeedbackId: `rich-${crypto.randomUUID()}`,
      richPayload: richPayload({
        attachments: [
          attachment("image-1", "canonical.png", "", bytesFor("png", 24), 1),
          attachment("image-2", "second.png", "", bytesFor("png", 20), 999),
        ],
      }),
    };
    const response = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const result = (await response.json()) as { feedback: { id: string; attachments: Array<Record<string, unknown>> } };
    expect(result.feedback.attachments).toHaveLength(2);
    expect(result.feedback.attachments[0]).toMatchObject({
      id: "image-1",
      name: "canonical.png",
      content_type: "image/png",
      byte_length: 24,
      ordinal: 0,
    });
    expect(result.feedback.attachments[1]).toMatchObject({ id: "image-2", ordinal: 1, byte_length: 20 });
    expect(result.feedback).toMatchObject({
      review_kind: "copy_request",
      copy_changes: expect.arrayContaining([
        expect.objectContaining({ id: "copy-1", proposedText: "After" }),
      ]),
    });
    expect(result.feedback.attachments[0]).not.toHaveProperty("object_key");
    const stored = await (env as Env).DB.prepare(
      "SELECT review_kind, copy_changes_json FROM review_feedback WHERE id = ?",
    ).bind(result.feedback.id).first<{ review_kind: string; copy_changes_json: string | null }>();
    expect(stored).toMatchObject({ review_kind: "copy_request" });
    expect(stored?.copy_changes_json).toContain("proposedText");
    const attachmentRows = await (env as Env).DB.prepare(
      "SELECT ordinal, attachment_id, byte_length, digest, object_key FROM review_feedback_attachments WHERE feedback_id = ? ORDER BY ordinal",
    ).bind(result.feedback.id).all<{ ordinal: number; attachment_id: string; byte_length: number; digest: string; object_key: string }>();
    const attachmentRow = attachmentRows.results[0];
    expect(attachmentRow).toMatchObject({ ordinal: 0, byte_length: 24 });
    expect(attachmentRows.results[1]).toMatchObject({ ordinal: 1, attachment_id: "image-2", byte_length: 20 });
    expect(attachmentRow?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const object = await (env as Env).REVIEW_ASSETS!.get(attachmentRow!.object_key);
    expect(object?.body).toBeTruthy();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytesFor("png", 24));
    const read = await request(`/api/projects/${project.id}/review-feedback/${result.feedback.id}/attachments/image-1`, { headers: OWNER });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("content-length")).toBe("24");

    const legacyResponse = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ comment: "Legacy feedback", pageUrl, clientFeedbackId: `legacy-${crypto.randomUUID()}` }),
    });
    expect(legacyResponse.status).toBe(201);
    const legacy = (await legacyResponse.json()) as { feedback: { id: string; review_kind: string; copy_changes: unknown; attachments: unknown[] } };
    expect(legacy.feedback).toMatchObject({ review_kind: "comment", copy_changes: null, attachments: [] });
  });

  it("leaves a failed staged upload with zero D1 effects and retries the same immutable operation", async () => {
    const { project, pageUrl } = await fixture();
    const requestId = `request_${crypto.randomUUID()}`;
    const payload = {
      comment: "Retry rich upload",
      pageUrl,
      clientFeedbackId: `retry-${crypto.randomUUID()}`,
      requestId,
      richPayload: richPayload({ copyRequest: null, attachments: [attachment("retry-image", "retry.png", "image/png", bytesFor("png", 32))] }),
    };
    const before = await Promise.all([
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM review_feedback_attachments WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM shiplet_audit_events WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
    ]);
    const failingAssets = {
      async put() { throw new Error("injected upload failure"); },
      async get() { return null; },
      async delete() { return undefined; },
    } as unknown as R2Bucket;
    const failed = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify(payload),
    }, { ...(env as Env), REVIEW_ASSETS: failingAssets });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    const after = await Promise.all([
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM review_feedback WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM review_feedback_attachments WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
      (env as Env).DB.prepare("SELECT COUNT(*) AS count FROM shiplet_audit_events WHERE project_id = ?").bind(project.id).first<{ count: number }>(),
    ]);
    expect(after.map((row) => row?.count)).toEqual(before.map((row) => row?.count));
    const pending = await (env as Env).DB.prepare(
      "SELECT request_id, completed_on, failed_on FROM embed_review_operation_intents WHERE project_id = ? AND request_id = ?",
    ).bind(project.id, requestId).first<{ request_id: string; completed_on: string | null; failed_on: string | null }>();
    expect(pending).toMatchObject({ request_id: requestId, completed_on: null, failed_on: null });

    const retried = await request(`/api/projects/${project.id}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify(payload),
    });
    expect(retried.status, await retried.clone().text()).toBe(201);
    const completed = await (env as Env).DB.prepare(
      "SELECT completed_on, result_feedback_id FROM embed_review_operation_intents WHERE project_id = ? AND request_id = ?",
    ).bind(project.id, requestId).first<{ completed_on: string | null; result_feedback_id: string }>();
    expect(completed?.completed_on).toBeTruthy();
    expect(completed?.result_feedback_id).toBeTruthy();
  });

  it("consumes the decoded-byte handoff after staging", async () => {
    const payload = {
      comment: "Handoff cleanup",
      pageUrl: "https://example.test/handoff",
      clientFeedbackId: `handoff-${crypto.randomUUID()}`,
      richPayload: richPayload({ copyRequest: null, attachments: [attachment("handoff", "handoff.png", "image/png", bytesFor("png", 40))] }),
    };
    const payloadJson = await prepareDurableReviewPayload(env as Env, "project-handoff", "request-handoff", payload);
    await stageDurableReviewPayload(env as Env, "project-handoff", "feedback-handoff", payload, payloadJson);
    const changed = {
      ...payload,
      richPayload: {
        ...payload.richPayload,
        attachments: [attachment("handoff", "handoff.png", "image/png", bytesFor("jpeg", 40))],
      },
    };
    await expect(
      stageDurableReviewPayload(env as Env, "project-handoff", "feedback-handoff-2", changed, payloadJson),
    ).rejects.toMatchObject({ status: 422 });
  });
});
