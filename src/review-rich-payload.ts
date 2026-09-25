import {
  REVIEW_ATTACHMENT_EXTENSION_TYPES,
  REVIEW_ATTACHMENT_MAX_BYTES,
  REVIEW_ATTACHMENT_MAX_COUNT,
  REVIEW_ATTACHMENT_MAX_TOTAL_BYTES,
  REVIEW_ATTACHMENT_MIME_TYPES,
  resolveReviewAttachmentMimeType,
  type ReviewAttachmentMimeType,
} from "./review-attachment-drafts";
import {
  validateReviewScreenshotAnnotations,
  type ReviewScreenshotAnnotations,
} from "./review-annotation-schema";

export type CaptureFidelityV1 = {
  version: 1;
  kind: "raster-source" | "sanitized-dom" | "fallback" | "none";
  limitations: Array<
    "images" | "canvas" | "media" | "form-values" | "external-styles"
  >;
};

export type ReviewRichAttachmentInput = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type ReviewRichAttachment = {
  id: string;
  name: string;
  mimeType: ReviewAttachmentMimeType;
  size: number;
  dataUrl: string;
  byteLength: number;
  digest: `sha256:${string}`;
  contentType: ReviewAttachmentMimeType;
  objectKey?: string;
};

export type ReviewCopyChange =
  | {
      id: string;
      kind: "text" | "template";
      selector: string | null;
      previousText: string | null;
      proposedText: string;
    }
  | {
      id: string;
      kind: "image";
      selector: string | null;
      attachmentId: string;
      altText: string | null;
    };

export type ReviewRichPayloadV1 = {
  version: 1;
  screenshotAnnotations: ReviewScreenshotAnnotations | null;
  captureFidelity: CaptureFidelityV1 | null;
  attachments: ReviewRichAttachmentInput[];
  copyRequest: { version: 1; changes: ReviewCopyChange[] } | null;
};

export type ReviewRichPayloadDescriptor = Omit<
  ReviewRichPayloadV1,
  "attachments"
> & {
  attachments: Array<{
    id: string;
    name: string;
    mimeType: ReviewAttachmentMimeType;
    size: number;
    byteLength: number;
    digest: `sha256:${string}`;
    contentType: ReviewAttachmentMimeType;
  }>;
};

export type ReviewRichPayloadValidation =
  | { ok: true; value: ReviewRichPayloadV1 }
  | { ok: false; errors: string[] };

export type ReviewRichAttachmentAdmission = {
  input: ReviewRichAttachment;
  bytes: Uint8Array;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_NAME_LENGTH = 255;
const MAX_SELECTOR_LENGTH = 2048;
const MAX_PREVIOUS_TEXT_LENGTH = 4000;
const MAX_PROPOSED_TEXT_LENGTH = 10_000;
const MAX_ALT_TEXT_LENGTH = 1000;
const MAX_COPY_CHANGES = 32;
const MAX_COPY_JSON_BYTES = 131_072;
const MAX_DATA_URL_LENGTH = 7_000_000;
const MAX_BASE64_LENGTH = 4 * Math.ceil(REVIEW_ATTACHMENT_MAX_BYTES / 3);
const MIME_SET = new Set<string>(REVIEW_ATTACHMENT_MIME_TYPES);
const LIMITATIONS = new Set([
  "images",
  "canvas",
  "media",
  "form-values",
  "external-styles",
]);
const FIDELITY_KINDS = new Set([
  "raster-source",
  "sanitized-dom",
  "fallback",
  "none",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function boundedString(value: unknown, maximum: number, allowEmpty = true) {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0)
    ? value
    : null;
}

function plainText(value: unknown, maximum: number, allowEmpty = true) {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0)) {
    return null;
  }
  // Copy requests are inspected data. Markup, controls, and URL-like values are
  // rejected before they can be rendered by another surface.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return null;
  if (/[<>]/.test(value) || /(?:javascript|data|vbscript):/i.test(value)) return null;
  return value;
}

function normalizeError(error: string) {
  return error.slice(0, 240);
}

function dataUrlBytes(value: unknown): { header: string; encoded: string } | null {
  if (typeof value !== "string" || value.length > MAX_DATA_URL_LENGTH) return null;
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || match[2].length === 0 || match[2].length > MAX_BASE64_LENGTH || match[2].length % 4 === 1) return null;
  return { header: match[1].toLowerCase(), encoded: match[2] };
}

function estimatedDecodedLength(encoded: string) {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function decodeBase64(encoded: string) {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function readAscii(bytes: Uint8Array, start: number, length: number) {
  if (start < 0 || start + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasPrefix(bytes: Uint8Array, prefix: number[], offset = 0) {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function isoBmffBrand(bytes: Uint8Array) {
  if (bytes.length < 12 || readAscii(bytes, 4, 4) !== "ftyp") return [];
  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
    brands.push(readAscii(bytes, offset, 4));
  }
  return brands;
}

function admittedContentType(bytes: Uint8Array) {
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png" as const;
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg" as const;
  if (readAscii(bytes, 0, 6) === "GIF87a" || readAscii(bytes, 0, 6) === "GIF89a") return "image/gif" as const;
  if (readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBP") return "image/webp" as const;
  if (hasPrefix(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/vnd.microsoft.icon" as const;
  if (hasPrefix(bytes, [0x49, 0x49, 0x2a, 0x00]) || hasPrefix(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff" as const;
  const brands = isoBmffBrand(bytes);
  if (brands.length) {
    if (brands.some((brand) => /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/i.test(brand))) {
      return "image/heic" as const;
    }
    if (brands.some((brand) => /^qt  $/i.test(brand))) return "video/quicktime" as const;
    if (brands.some((brand) => /^f4v $/i.test(brand))) return "video/x-f4v" as const;
    if (brands.some((brand) => /^(isom|iso2|mp41|mp42|avc1|mp71|m4v |m4a )$/i.test(brand))) return "video/mp4" as const;
  }
  if (hasPrefix(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm" as const;
  if (hasPrefix(bytes, [0x00, 0x00, 0x01, 0xba]) || hasPrefix(bytes, [0x00, 0x00, 0x01, 0xb3])) return "video/mpeg" as const;
  if (readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "AVI ") return "video/x-msvideo" as const;
  if (readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "AMV ") return "video/x-amv" as const;
  if (hasPrefix(bytes, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])) return "video/x-ms-asf" as const;
  if (readAscii(bytes, 0, 4) === "FLV\x01") return "video/x-flv" as const;
  return null;
}

function decodeSvg(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return null;
    if (/(?:<!doctype|<!entity|<script\b|<foreignobject\b|<iframe\b|<object\b|<embed\b)/i.test(text)) return null;
    if (/(?:\bon[a-z]+\s*=|(?:href|src|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|data:|javascript:)|url\s*\(\s*(?:https?:|\/\/|data:|javascript:))/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function extensionMime(name: string) {
  const extension = name.toLowerCase().split(".").pop() || "";
  return (REVIEW_ATTACHMENT_EXTENSION_TYPES as Record<string, ReviewAttachmentMimeType>)[extension] || null;
}

function family(type: string) {
  if (type === "application/mp4" || type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  return "other";
}

function declaredMatchesContainer(declared: ReviewAttachmentMimeType, actual: ReviewAttachmentMimeType) {
  return declared === actual || (declared === "application/mp4" && actual === "video/mp4");
}

function validateAttachmentShape(value: unknown, index: number, errors: string[]) {
  const before = errors.length;
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "mimeType", "size", "dataUrl"])) {
    errors.push(`Attachment ${index + 1} has unexpected fields.`);
    return null;
  }
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) errors.push(`Attachment ${index + 1} id is invalid.`);
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(value.name)) errors.push(`Attachment ${index + 1} name is invalid.`);
  const name = typeof value.name === "string" ? value.name : "";
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.toLowerCase() : null;
  if (mimeType === null || (mimeType.length > 0 && !MIME_SET.has(mimeType) && !extensionMime(name))) errors.push(`Attachment ${index + 1} MIME type is unsupported.`);
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > REVIEW_ATTACHMENT_MAX_BYTES) errors.push(`Attachment ${index + 1} size is out of bounds.`);
  const parsedDataUrl = dataUrlBytes(value.dataUrl);
  if (!parsedDataUrl) errors.push(`Attachment ${index + 1} data URL is invalid.`);
  else if (estimatedDecodedLength(parsedDataUrl.encoded) > REVIEW_ATTACHMENT_MAX_BYTES) errors.push(`Attachment ${index + 1} encoded bytes are out of bounds.`);
  if (errors.length !== before) return null;
  return {
    id: value.id as string,
    name,
    mimeType: mimeType || "",
    size: value.size as number,
    dataUrl: value.dataUrl as string,
  };
}

function validateFidelity(value: unknown, errors: string[]) {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ["version", "kind", "limitations"])) {
    errors.push("Capture fidelity has unexpected fields.");
    return null;
  }
  if (value.version !== 1 || typeof value.kind !== "string" || !FIDELITY_KINDS.has(value.kind) || !Array.isArray(value.limitations)) {
    errors.push("Capture fidelity is invalid.");
    return null;
  }
  const limitations: string[] = [];
  for (const limitation of value.limitations) {
    if (typeof limitation !== "string" || !LIMITATIONS.has(limitation) || limitations.includes(limitation)) {
      errors.push("Capture fidelity limitations are invalid.");
      return null;
    }
    limitations.push(limitation);
  }
  if (value.kind === "none" && limitations.length > 0) {
    errors.push("Capture fidelity none cannot declare limitations.");
    return null;
  }
  return { version: 1 as const, kind: value.kind as CaptureFidelityV1["kind"], limitations: limitations as CaptureFidelityV1["limitations"] };
}

function validateCopyChange(value: unknown, index: number, attachmentIds: Set<string>, imageAttachmentIds: Set<string>, errors: string[]) {
  const before = errors.length;
  if (!isRecord(value) || typeof value.kind !== "string") {
    errors.push(`Copy change ${index + 1} is invalid.`);
    return null;
  }
  if (value.kind === "image") {
    if (!exactKeys(value, ["id", "kind", "selector", "attachmentId", "altText"])) {
      errors.push(`Copy image change ${index + 1} has unexpected fields.`);
      return null;
    }
    if (typeof value.id !== "string" || !IDENTIFIER.test(value.id) || typeof value.attachmentId !== "string" || !attachmentIds.has(value.attachmentId) || !imageAttachmentIds.has(value.attachmentId)) {
      errors.push(`Copy image change ${index + 1} references an invalid image attachment.`);
      return null;
    }
    const selector = value.selector === null ? null : boundedString(value.selector, MAX_SELECTOR_LENGTH);
    const altText = value.altText === null ? null : plainText(value.altText, MAX_ALT_TEXT_LENGTH);
    if (value.selector !== null && selector === null) errors.push(`Copy image change ${index + 1} selector is invalid.`);
    if (value.altText !== null && altText === null) errors.push(`Copy image change ${index + 1} alt text is invalid.`);
    if (errors.length !== before) return null;
    return { id: value.id, kind: "image" as const, selector, attachmentId: value.attachmentId as string, altText };
  }
  if (value.kind !== "text" && value.kind !== "template") {
    errors.push(`Copy change ${index + 1} kind is invalid.`);
    return null;
  }
  if (!exactKeys(value, ["id", "kind", "selector", "previousText", "proposedText"])) {
    errors.push(`Copy ${value.kind} change ${index + 1} has unexpected fields.`);
    return null;
  }
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id)) errors.push(`Copy change ${index + 1} id is invalid.`);
  const selector = value.selector === null ? null : boundedString(value.selector, MAX_SELECTOR_LENGTH);
  const previousText = value.previousText === null ? null : plainText(value.previousText, MAX_PREVIOUS_TEXT_LENGTH);
  const proposedText = plainText(value.proposedText, MAX_PROPOSED_TEXT_LENGTH, false);
  if (value.selector !== null && selector === null) errors.push(`Copy change ${index + 1} selector is invalid.`);
  if (value.previousText !== null && previousText === null) errors.push(`Copy change ${index + 1} previous text is invalid.`);
  if (proposedText === null) errors.push(`Copy change ${index + 1} proposed text is invalid.`);
  if (errors.length !== before) return null;
  return { id: value.id as string, kind: value.kind as "text" | "template", selector, previousText, proposedText: proposedText as string };
}

/** Validate the exact shape without trusting caller size or MIME claims. */
export function validateReviewRichPayload(value: unknown, summary?: unknown): ReviewRichPayloadValidation {
  const errors: string[] = [];
  if (!isRecord(value) || !exactKeys(value, ["version", "screenshotAnnotations", "captureFidelity", "attachments", "copyRequest"])) {
    return { ok: false, errors: ["Rich review payload has unexpected fields."] };
  }
  if (value.version !== 1) errors.push("Rich review payload version must be 1.");
  let screenshotAnnotations: ReviewScreenshotAnnotations | null = null;
  if (value.screenshotAnnotations !== null) {
    const annotation = validateReviewScreenshotAnnotations(value.screenshotAnnotations);
    if (!annotation.ok) errors.push(annotation.error);
    else screenshotAnnotations = annotation.value;
  }
  const captureFidelity = validateFidelity(value.captureFidelity, errors);
  if (!Array.isArray(value.attachments) || value.attachments.length > REVIEW_ATTACHMENT_MAX_COUNT) {
    errors.push("Rich review payload supports at most four attachments.");
  }
  const attachments: ReviewRichAttachmentInput[] = [];
  const ids = new Set<string>();
  for (const [index, attachment] of (Array.isArray(value.attachments) ? value.attachments : []).entries()) {
    const normalized = validateAttachmentShape(attachment, index, errors);
    if (!normalized) continue;
    if (ids.has(normalized.id)) errors.push("Attachment IDs must be unique.");
    ids.add(normalized.id);
    attachments.push(normalized);
  }
  const estimatedTotalBytes = attachments.reduce((total, item) => {
    const parsed = dataUrlBytes(item.dataUrl);
    return total + (parsed ? estimatedDecodedLength(parsed.encoded) : 0);
  }, 0);
  if (estimatedTotalBytes > REVIEW_ATTACHMENT_MAX_TOTAL_BYTES) {
    errors.push("Attachments must total 10 MiB or less.");
  }
  if (value.copyRequest === null) {
    // no-op
  } else if (!isRecord(value.copyRequest) || !exactKeys(value.copyRequest, ["version", "changes"]) || value.copyRequest.version !== 1 || !Array.isArray(value.copyRequest.changes) || value.copyRequest.changes.length < 1 || value.copyRequest.changes.length > MAX_COPY_CHANGES || (typeof summary !== "string" || summary.trim().length === 0)) {
    errors.push("Copy request must contain 1 through 32 changes and a summary.");
  }
  const imageAttachmentIds = new Set<string>();
  for (const attachment of attachments) {
    const expected = resolveReviewAttachmentMimeType({ name: attachment.name, type: attachment.mimeType });
    if (expected && family(expected) === "image") imageAttachmentIds.add(attachment.id);
  }
  const changes: ReviewCopyChange[] = [];
  const changeIds = new Set<string>();
  if (isRecord(value.copyRequest) && Array.isArray(value.copyRequest.changes)) {
    for (const [index, change] of value.copyRequest.changes.entries()) {
      const normalized = validateCopyChange(change, index, ids, imageAttachmentIds, errors);
      if (!normalized) continue;
      if (changeIds.has(normalized.id)) errors.push("Copy change IDs must be unique.");
      changeIds.add(normalized.id);
      changes.push(normalized);
    }
  }
  const copyRequest = value.copyRequest === null ? null : { version: 1 as const, changes };
  const normalized = { version: 1 as const, screenshotAnnotations, captureFidelity, attachments, copyRequest };
  const normalizedMetadata = {
    ...normalized,
    attachments: attachments.map(({ dataUrl: _dataUrl, ...metadata }) => metadata),
  };
  if (new TextEncoder().encode(JSON.stringify(normalizedMetadata)).byteLength > MAX_COPY_JSON_BYTES) errors.push("Rich review payload is too large.");
  return errors.length ? { ok: false, errors: Array.from(new Set(errors.map(normalizeError))) } : { ok: true, value: normalized as ReviewRichPayloadV1 };
}

function sameFamily(expected: string, actual: string) {
  return family(expected) === family(actual);
}

export async function admitReviewAttachment(input: ReviewRichAttachmentInput): Promise<ReviewRichAttachmentAdmission> {
  const encoded = dataUrlBytes(input.dataUrl);
  if (!encoded) throw new Response("Attachment data URL is invalid.", { status: 422 });
  const bytes = decodeBase64(encoded.encoded);
  if (!bytes || bytes.byteLength < 1 || bytes.byteLength > REVIEW_ATTACHMENT_MAX_BYTES) throw new Response("Attachment bytes are out of bounds.", { status: 422 });
  const declared = resolveReviewAttachmentMimeType({ name: input.name, type: input.mimeType });
  if (!declared) throw new Response("Attachment type is unsupported.", { status: 422 });
  let contentType: ReviewAttachmentMimeType | null = null;
  if (declared === "image/svg+xml") {
    if (!decodeSvg(bytes)) throw new Response("SVG attachment is not safe.", { status: 422 });
    contentType = declared;
  } else {
    const admitted = admittedContentType(bytes);
    if (!admitted || !declaredMatchesContainer(declared, admitted)) throw new Response("Attachment content does not match its type.", { status: 422 });
    contentType = admitted as ReviewAttachmentMimeType;
  }
  const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = `sha256:${Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as const;
  return {
    bytes,
    input: {
      id: input.id,
      name: input.name,
      mimeType: contentType,
      size: bytes.byteLength,
      dataUrl: input.dataUrl,
      byteLength: bytes.byteLength,
      digest,
      contentType,
    },
  };
}

export async function admitReviewRichPayload(value: ReviewRichPayloadV1) {
  const admitted: ReviewRichAttachmentAdmission[] = [];
  let total = 0;
  for (const attachment of value.attachments) {
    const item = await admitReviewAttachment(attachment);
    admitted.push(item);
    total += item.input.byteLength;
    if (total > REVIEW_ATTACHMENT_MAX_TOTAL_BYTES) throw new Response("Attachments must total 10 MiB or less.", { status: 422 });
  }
  const images = new Set(admitted.filter((item) => family(item.input.contentType) === "image").map((item) => item.input.id));
  if (value.copyRequest) {
    for (const change of value.copyRequest.changes) {
      if (change.kind === "image" && !images.has(change.attachmentId)) throw new Response("Copy image change requires an admitted image attachment.", { status: 422 });
    }
  }
  return admitted;
}

export function compactReviewRichPayload(value: ReviewRichPayloadV1, admitted: ReviewRichAttachmentAdmission[]): ReviewRichPayloadDescriptor {
  const byId = new Map(admitted.map((item) => [item.input.id, item.input]));
  return {
    version: 1,
    screenshotAnnotations: value.screenshotAnnotations,
    captureFidelity: value.captureFidelity,
    attachments: value.attachments.map((attachment) => {
      const actual = byId.get(attachment.id);
      if (!actual) throw new Error("Missing admitted attachment.");
      return {
        id: actual.id,
        name: actual.name,
        mimeType: actual.mimeType,
        size: actual.size,
        byteLength: actual.byteLength,
        digest: actual.digest,
        contentType: actual.contentType,
      };
    }),
    copyRequest: value.copyRequest,
  };
}

export const REVIEW_RICH_PAYLOAD_LIMITS = Object.freeze({
  maxCopyJsonBytes: MAX_COPY_JSON_BYTES,
  maxSelectorLength: MAX_SELECTOR_LENGTH,
  maxCopyChanges: MAX_COPY_CHANGES,
});
