import {
  compileRuntimeV1Widget,
  UnsupportedWidgetDependencyError,
} from "./self-owned/widget-runtime";

const MAX_REVIEW_LAYER_CHANGES = 64;
const MAX_REVIEW_LAYER_FILES = 128;
const MAX_REVIEW_LAYER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REVIEW_LAYER_BYTES = 8 * 1024 * 1024;

export type ReviewLayerFile = Readonly<{
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
}>;

export type ReviewLayer = Readonly<{
  version: string;
  entryPath: string;
  files: readonly ReviewLayerFile[];
}>;

export type ReviewLayerDiagnostic = Readonly<{
  code: string;
  path?: string;
}>;

export type ReviewLayerActor = Readonly<{
  kind: "human" | "agent";
  id: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function portableReviewLayerPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return null;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        new TextEncoder().encode(segment).byteLength > 255,
    )
  ) {
    return null;
  }
  return value;
}

function decodeBase64(content: string): Uint8Array | null {
  if (content.length % 4 !== 0) return null;
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const dataLength = content.length - padding;
  if (
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content)
  ) {
    return null;
  }
  try {
    const decoded = atob(content);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function reviewLayerFileBytes(file: ReviewLayerFile): Uint8Array | null {
  return file.encoding === "utf8"
    ? new TextEncoder().encode(file.content)
    : decodeBase64(file.content);
}

function dataUrl(file: ReviewLayerFile, bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return `data:${file.mediaType};base64,${btoa(binary)}`;
}

export async function compileReviewLayer(layer: ReviewLayer) {
  const files: Array<{ path: string; mediaType: string; bytes: Uint8Array }> = [];
  const dataUrls = new Map<string, string>();
  for (const file of layer.files) {
    const bytes = reviewLayerFileBytes(file);
    if (!bytes) throw new Error(`invalid_base64:${file.path}`);
    const path = `widget/${file.path}`;
    files.push({ path, mediaType: file.mediaType, bytes });
    dataUrls.set(path, dataUrl(file, bytes));
  }
  return compileRuntimeV1Widget({
    entryPath: `widget/${layer.entryPath}`,
    files,
    dataUrls,
  });
}

export async function applyReviewLayerChanges(
  current: ReviewLayer,
  input: unknown,
): Promise<
  | { ok: true; layer: ReviewLayer }
  | { ok: false; diagnostics: ReviewLayerDiagnostic[] }
> {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_REVIEW_LAYER_CHANGES
  ) {
    return { ok: false, diagnostics: [{ code: "invalid_changes" }] };
  }
  const files = new Map(current.files.map((file) => [file.path, file]));
  const touched = new Set<string>();
  for (const candidate of input) {
    if (
      !isRecord(candidate) ||
      (candidate.op !== "put" && candidate.op !== "delete")
    ) {
      return { ok: false, diagnostics: [{ code: "invalid_change" }] };
    }
    const path = portableReviewLayerPath(candidate.path);
    if (!path) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "invalid_path",
            ...(typeof candidate.path === "string"
              ? { path: candidate.path }
              : {}),
          },
        ],
      };
    }
    const collisionKey = path.toLowerCase();
    if (touched.has(collisionKey)) {
      return { ok: false, diagnostics: [{ code: "duplicate_path", path }] };
    }
    touched.add(collisionKey);
    if (candidate.op === "delete") {
      if (!exactKeys(candidate, ["op", "path"])) {
        return { ok: false, diagnostics: [{ code: "invalid_change", path }] };
      }
      files.delete(path);
      continue;
    }
    if (
      !exactKeys(candidate, ["op", "path", "mediaType", "encoding", "content"]) ||
      typeof candidate.mediaType !== "string" ||
      candidate.mediaType.length === 0 ||
      candidate.mediaType.length > 256 ||
      (candidate.encoding !== "utf8" && candidate.encoding !== "base64") ||
      typeof candidate.content !== "string"
    ) {
      return { ok: false, diagnostics: [{ code: "invalid_change", path }] };
    }
    const file: ReviewLayerFile = {
      path,
      mediaType: candidate.mediaType,
      encoding: candidate.encoding,
      content: candidate.content,
    };
    const bytes = reviewLayerFileBytes(file);
    if (!bytes) {
      return { ok: false, diagnostics: [{ code: "invalid_base64", path }] };
    }
    if (bytes.byteLength > MAX_REVIEW_LAYER_FILE_BYTES) {
      return { ok: false, diagnostics: [{ code: "file_too_large", path }] };
    }
    files.set(path, file);
  }
  const nextFiles = [...files.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (nextFiles.length === 0 || nextFiles.length > MAX_REVIEW_LAYER_FILES) {
    return { ok: false, diagnostics: [{ code: "invalid_file_count" }] };
  }
  let totalBytes = 0;
  for (const file of nextFiles) {
    const bytes = reviewLayerFileBytes(file);
    if (!bytes) {
      return {
        ok: false,
        diagnostics: [{ code: "invalid_base64", path: file.path }],
      };
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_REVIEW_LAYER_BYTES) {
      return { ok: false, diagnostics: [{ code: "review_layer_too_large" }] };
    }
  }
  const layer: ReviewLayer = { ...current, files: nextFiles };
  try {
    await compileReviewLayer(layer);
  } catch (error) {
    if (error instanceof UnsupportedWidgetDependencyError) {
      return {
        ok: false,
        diagnostics: [
          {
            code: error.code,
            ...(error.path
              ? { path: error.path.replace(/^widget\//, "") }
              : {}),
          },
        ],
      };
    }
    const message = error instanceof Error ? error.message : "";
    const [code, path] = message.split(":", 2);
    return {
      ok: false,
      diagnostics: [
        { code: code || "invalid_widget", ...(path ? { path } : {}) },
      ],
    };
  }
  return { ok: true, layer };
}
