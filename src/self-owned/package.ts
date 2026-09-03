import { types as nodeUtilTypes } from "node:util";

import { MAX_STATIC_ASSET_FILE_BYTES } from "../upload-policy";
import {
  UnsupportedWidgetDependencyError,
  validateRuntimeV1Widget,
} from "./widget-runtime";

export const SHIPLET_PACKAGE_MEDIA_TYPE =
  "application/vnd.shiplet.package+json;version=1";

const PACKAGE_SCHEMA_VERSION = "shiplet.package/v1";
const RUNTIME_COMPATIBILITY_VERSION = "shiplet.runtime/v1";
const MAX_FILE_COUNT = 1_024;
const MAX_FILE_BYTES = MAX_STATIC_ASSET_FILE_BYTES;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_DEPTH = 32;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_FILE_CONTENT_STRING_BYTES =
  Math.ceil(MAX_FILE_BYTES / 3) * 4;
const MAX_TREE_WIDTH = 256;
const MAX_TREE_NODES = 4_096;
const MAX_PORTABLE_PATH_BYTES = 1_024;
const MAX_PORTABLE_PATH_SEGMENT_BYTES = 255;

const REQUIRED_ENTRYPOINTS = [
  "artifact",
  "widget",
  "workflow",
  "mcp",
  "agentInstructions",
  "validation",
  "provenance",
] as const;

const STRUCTURED_PACKAGE_FILES = new Set([
  "workflow/schema.json",
  "mcp/manifest.json",
  "validation/manifest.json",
  "provenance.json",
]);

const PACKAGE_KEYS = new Set(["mediaType", "manifest", "files"]);
const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "runtimeCompatibility",
  "entrypoints",
  "requestedCapabilities",
  "limits",
  "staticFirst",
]);
const FILE_KEYS = new Set([
  "path",
  "mediaType",
  "encoding",
  "content",
  "sha256",
  "size",
]);

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "accessgrant",
  "accessgrants",
  "audithistory",
  "auditevents",
  "authorizationcode",
  "authorization",
  "authorizationheader",
  "authheader",
  "apikey",
  "apicredential",
  "apicredentials",
  "accesstoken",
  "bearer",
  "bearertoken",
  "claimcode",
  "claimcredential",
  "claimcredentials",
  "claimurl",
  "clientsecret",
  "cloudflareconnection",
  "cloudflareconnections",
  "cloudflareapitoken",
  "credential",
  "credentials",
  "customerstate",
  "deployment",
  "deployments",
  "grant",
  "grants",
  "oauth",
  "oauthdata",
  "oauthgrant",
  "oauthgrants",
  "password",
  "passwords",
  "privatekey",
  "session",
  "sessions",
  "state",
  "token",
  "tokens",
]);

const FORBIDDEN_FILE_ROOTS = new Set([
  "audit",
  "audits",
  "claim",
  "claims",
  "credential",
  "credentials",
  "deployment",
  "deployments",
  "grant",
  "grants",
  "oauth",
  "session",
  "sessions",
  "state",
]);

export type ShipletPackageEncoding = "utf8" | "base64";

export type ShipletPackageFile = {
  path: string;
  mediaType: string;
  encoding: ShipletPackageEncoding;
  content: string;
  sha256: string;
  size: number;
};

export type ShipletPackageManifest = {
  schemaVersion: "shiplet.package/v1";
  runtimeCompatibility: "shiplet.runtime/v1";
  entrypoints: Record<(typeof REQUIRED_ENTRYPOINTS)[number], string>;
  requestedCapabilities: string[];
  limits: {
    fileCount: number;
    fileBytes: number;
    packageBytes: number;
    [key: string]: number;
  };
  staticFirst: boolean;
  [key: string]: unknown;
};

export type ValidatedShipletPackage = {
  mediaType: typeof SHIPLET_PACKAGE_MEDIA_TYPE;
  manifest: ShipletPackageManifest;
  files: ShipletPackageFile[];
};

export class ShipletPackageError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, path?: string) {
    super(path ? `${code} at ${path}` : code);
    this.name = "ShipletPackageError";
    this.code = code;
    this.path = path;
  }
}

function fail(code: string, path?: string): never {
  throw new ShipletPackageError(code, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotPlainData(input: unknown): unknown {
  let nodeCount = 0;
  let utf8Bytes = 0;
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();

  function accountUtf8(value: string) {
    utf8Bytes += encoder.encode(value).byteLength;
    if (utf8Bytes > MAX_PACKAGE_BYTES) fail("input_too_large", "$");
  }

  function snapshot(value: unknown, path: string, depth: number): unknown {
    nodeCount += 1;
    if (nodeCount > MAX_TREE_NODES) fail("tree_node_limit", "$");
    if (depth > MAX_MANIFEST_DEPTH) fail("manifest_too_deep", path || "$");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      if (typeof value === "string") accountUtf8(value);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("invalid_json_value", path || "$");
      return value;
    }
    if (typeof value !== "object") fail("non_plain_data", path || "$");
    if (nodeUtilTypes.isProxy(value)) fail("non_plain_data", path || "$");
    if (seen.has(value)) fail("non_plain_data", path || "$");
    seen.add(value);

    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (ownKeys.length !== value.length) {
        const unexpected = ownKeys.find(
          (key) => typeof key !== "string" || !/^\d+$/.test(key),
        );
        fail(
          "non_plain_data",
          typeof unexpected === "string"
            ? path
              ? `${path}.${unexpected}`
              : unexpected
            : path || "$",
        );
      }
      if (value.length > 1_024) fail("tree_width_exceeded", path || "$");
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          descriptor.get ||
          descriptor.set
        ) {
          fail("non_plain_data", `${path}[${index}]`);
        }
        result.push(snapshot(descriptor.value, `${path}[${index}]`, depth + 1));
      }
      seen.delete(value);
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("non_plain_data", path || "$");
    }
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of ownKeys) {
      const keyPath =
        typeof key === "string" ? (path ? `${path}.${key}` : key) : path || "$";
      if (typeof key !== "string") fail("non_plain_data", keyPath);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        descriptor.get ||
        descriptor.set
      ) {
        fail("non_plain_data", keyPath);
      }
      accountUtf8(key);
      descriptors.set(key, descriptor);
    }
    const keys = ownKeys as string[];
    if (keys.length > MAX_TREE_WIDTH) {
      fail("tree_width_exceeded", path || "$");
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of [...keys].sort()) {
      result[key] = snapshot(
        descriptors.get(key)!.value,
        path ? `${path}.${key}` : key,
        depth + 1,
      );
    }
    seen.delete(value);
    return result;
  }

  return snapshot(input, "", 0);
}

function normalizedAuthorityName(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[-_\s]/g, "");
}

function assertJsonTree(
  value: unknown,
  path: string,
  depth = 0,
  seen = new WeakSet<object>(),
) {
  if (depth > MAX_MANIFEST_DEPTH) fail("manifest_too_deep", path);
  if (typeof value === "string") {
    const limit = /^files\[\d+\]\.content$/.test(path)
      ? MAX_FILE_CONTENT_STRING_BYTES
      : MAX_STRING_BYTES;
    if (new TextEncoder().encode(value).byteLength > limit) {
      fail("string_too_large", path);
    }
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail("invalid_json_value", path);
    }
    return;
  }
  if (typeof value !== "object") fail("invalid_json_value", path);
  if (seen.has(value)) fail("invalid_json_value", path);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonTree(value[index], `${path}[${index}]`, depth + 1, seen);
    }
    seen.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertJsonTree(child, path ? `${path}.${key}` : key, depth + 1, seen);
  }
  seen.delete(value);
}

function assertNoForbiddenAuthority(value: unknown, path = "") {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertNoForbiddenAuthority(child, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_AUTHORITY_KEYS.has(normalizedAuthorityName(key))) {
      fail("forbidden_authority", childPath);
    }
    assertNoForbiddenAuthority(child, childPath);
  }
}

function assertPortablePath(path: string) {
  if (
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > MAX_PORTABLE_PATH_BYTES ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail("invalid_path", path);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    fail("invalid_path", path);
  }
  for (const segment of segments) {
    if (
      new TextEncoder().encode(segment).byteLength >
        MAX_PORTABLE_PATH_SEGMENT_BYTES ||
      /[<>:"|?*]/u.test(segment) ||
      /[. ]$/u.test(segment)
    ) {
      fail("invalid_path", path);
    }
    const basename = segment.split(".", 1)[0].toLocaleUpperCase("en-US");
    if (
      basename === "CON" ||
      basename === "PRN" ||
      basename === "AUX" ||
      basename === "NUL" ||
      /^COM[1-9]$/u.test(basename) ||
      /^LPT[1-9]$/u.test(basename)
    ) {
      fail("invalid_path", path);
    }
  }
}

function portableCollisionKey(path: string) {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function assertAllowedPackagePath(path: string) {
  const root = normalizedAuthorityName(path.split("/", 1)[0]);
  if (FORBIDDEN_FILE_ROOTS.has(root)) fail("forbidden_authority", path);
  if (
    path === "AGENTS.md" ||
    path === "workflow/schema.json" ||
    path === "mcp/manifest.json" ||
    path === "validation/manifest.json" ||
    path === "provenance.json" ||
    path.startsWith("artifact/") ||
    path.startsWith("widget/") ||
    path.startsWith("mcp/handlers/")
  ) {
    return;
  }
  fail("invalid_path", path);
}

function decodeBase64(content: string, path: string) {
  if (content.length % 4 !== 0) {
    fail("invalid_base64", path);
  }
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  const dataLength = content.length - padding;
  if (
    (padding === 1 && dataLength % 4 !== 3) ||
    (padding === 2 && dataLength % 4 !== 2)
  ) {
    fail("invalid_base64", path);
  }
  for (let index = 0; index < dataLength; index += 1) {
    const code = content.charCodeAt(index);
    const allowed =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 43 ||
      code === 47;
    if (!allowed) fail("invalid_base64", path);
  }
  for (let index = dataLength; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 61) fail("invalid_base64", path);
  }
  try {
    const decoded = atob(content);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    fail("invalid_base64", path);
  }
}

function decodeFile(file: ShipletPackageFile) {
  return file.encoding === "utf8"
    ? new TextEncoder().encode(file.content)
    : decodeBase64(file.content, file.path);
}

async function sha256Hex(bytes: Uint8Array) {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function parseInput(input: unknown): unknown {
  let parsed = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_PACKAGE_BYTES) {
      fail("input_too_large", "$");
    }
    try {
      parsed = JSON.parse(input);
    } catch {
      fail("invalid_json");
    }
  }
  return snapshotPlainData(parsed);
}

function expectedEntrypoint(
  entrypoint: (typeof REQUIRED_ENTRYPOINTS)[number],
  path: string,
) {
  switch (entrypoint) {
    case "artifact":
      return path.startsWith("artifact/");
    case "widget":
      return path.startsWith("widget/");
    case "workflow":
      return path === "workflow/schema.json";
    case "mcp":
      return path === "mcp/manifest.json";
    case "agentInstructions":
      return path === "AGENTS.md";
    case "validation":
      return path === "validation/manifest.json";
    case "provenance":
      return path === "provenance.json";
  }
}

function parseManifest(value: unknown): ShipletPackageManifest {
  if (!isRecord(value)) fail("invalid_manifest", "manifest");
  assertJsonTree(value, "manifest");
  assertNoForbiddenAuthority(value, "manifest");
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) fail("invalid_manifest", `manifest.${key}`);
  }
  if (value.schemaVersion !== PACKAGE_SCHEMA_VERSION) {
    fail("unsupported_version", "manifest.schemaVersion");
  }
  if (value.runtimeCompatibility !== RUNTIME_COMPATIBILITY_VERSION) {
    fail("unsupported_version", "manifest.runtimeCompatibility");
  }
  if (!isRecord(value.entrypoints)) {
    fail("invalid_manifest", "manifest.entrypoints");
  }
  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    const path = value.entrypoints[entrypoint];
    if (typeof path !== "string") {
      fail("invalid_manifest", `manifest.entrypoints.${entrypoint}`);
    }
    assertPortablePath(path);
    if (!expectedEntrypoint(entrypoint, path)) {
      fail("entrypoint_mismatch", `manifest.entrypoints.${entrypoint}`);
    }
  }
  if (
    !Array.isArray(value.requestedCapabilities) ||
    value.requestedCapabilities.some(
      (capability) => typeof capability !== "string" || capability.length === 0,
    )
  ) {
    fail("invalid_manifest", "manifest.requestedCapabilities");
  }
  if (!isRecord(value.limits)) fail("invalid_manifest", "manifest.limits");
  for (const [name, limit] of Object.entries(value.limits)) {
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) {
      fail("invalid_limits", `manifest.limits.${name}`);
    }
  }
  for (const requiredLimit of ["fileCount", "fileBytes", "packageBytes"]) {
    if (!Number.isSafeInteger(value.limits[requiredLimit])) {
      fail("invalid_limits", `manifest.limits.${requiredLimit}`);
    }
  }
  if (typeof value.staticFirst !== "boolean") {
    fail("invalid_manifest", "manifest.staticFirst");
  }
  return value as ShipletPackageManifest;
}

function parseFile(value: unknown, index: number): ShipletPackageFile {
  const recordPath = `files[${index}]`;
  if (!isRecord(value)) fail("invalid_file", recordPath);
  for (const key of Object.keys(value)) {
    if (!FILE_KEYS.has(key)) fail("invalid_file", `${recordPath}.${key}`);
  }
  const { path, mediaType, encoding, content, sha256, size } = value;
  if (typeof path !== "string") fail("invalid_path", recordPath);
  assertPortablePath(path);
  assertAllowedPackagePath(path);
  if (typeof mediaType !== "string" || mediaType.length === 0) {
    fail("invalid_file", `${recordPath}.mediaType`);
  }
  if (encoding !== "utf8" && encoding !== "base64") {
    fail("invalid_file", `${recordPath}.encoding`);
  }
  if (typeof content !== "string")
    fail("invalid_file", `${recordPath}.content`);
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
    fail("invalid_file", `${recordPath}.sha256`);
  }
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    fail("invalid_file", `${recordPath}.size`);
  }
  return {
    path,
    mediaType,
    encoding,
    content,
    sha256,
    size: size as number,
  };
}

export type DeclaredValidationCheck = {
  id?: string;
  kind: "file-exists";
  path: string;
};

function decodedFileText(
  file: ShipletPackageFile,
  bytes: Uint8Array = decodeFile(file),
) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_json", file.path);
  }
}

function structuredJson(
  file: ShipletPackageFile,
  bytes?: Uint8Array,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedFileText(file, bytes));
  } catch (error) {
    if (error instanceof ShipletPackageError) throw error;
    fail("invalid_json", file.path);
  }
  if (!isRecord(parsed)) fail("invalid_schema", file.path);
  assertJsonTree(parsed, file.path);
  assertNoForbiddenAuthority(parsed, file.path);
  return parsed;
}

function validNamedString(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertWorkflowSchema(value: Record<string, unknown>, path: string) {
  const workflowKeys = new Set(["schemaVersion", "statuses", "fields"]);
  const statusKeys = new Set(["name", "category"]);
  const fieldKeys = new Set(["name", "type"]);
  if (
    !hasOnlyKeys(value, workflowKeys) ||
    value.schemaVersion !== "shiplet.workflow/v1" ||
    !Array.isArray(value.statuses) ||
    !Array.isArray(value.fields) ||
    value.statuses.some(
      (status) =>
        !isRecord(status) ||
        !hasOnlyKeys(status, statusKeys) ||
        !validNamedString(status.name) ||
        ![
          "open",
          "in_progress",
          "blocked",
          "resolved",
          "closed",
          "informational",
        ].includes(String(status.category)),
    ) ||
    value.fields.some(
      (field) =>
        !isRecord(field) ||
        !hasOnlyKeys(field, fieldKeys) ||
        !validNamedString(field.name) ||
        ![
          "string",
          "number",
          "integer",
          "boolean",
          "object",
          "array",
          "null",
          "any",
        ].includes(String(field.type)),
    )
  ) {
    fail("invalid_schema", path);
  }
}

function assertMcpSchema(
  value: Record<string, unknown>,
  path: string,
  packagePaths: Set<string>,
) {
  const manifestKeys = new Set([
    "schemaVersion",
    "runtimeCompatibility",
    "tools",
  ]);
  const toolKeys = new Set([
    "name",
    "description",
    "handler",
    "inputSchema",
    "requestedCapabilities",
    "effect",
    "approval",
  ]);
  if (
    !hasOnlyKeys(value, manifestKeys) ||
    value.schemaVersion !== "shiplet.mcp/v1" ||
    (value.runtimeCompatibility !== undefined &&
      !validNamedString(value.runtimeCompatibility)) ||
    !Array.isArray(value.tools) ||
    value.tools.some(
      (tool) =>
        !isRecord(tool) ||
        !hasOnlyKeys(tool, toolKeys) ||
        !validNamedString(tool.name) ||
        !validNamedString(tool.description) ||
        typeof tool.handler !== "string" ||
        !tool.handler.startsWith("mcp/handlers/") ||
        !packagePaths.has(tool.handler) ||
        !isRecord(tool.inputSchema) ||
        !Array.isArray(tool.requestedCapabilities) ||
        tool.requestedCapabilities.some(
          (capability) => !validNamedString(capability),
        ) ||
        (tool.effect !== undefined &&
          tool.effect !== "read" &&
          tool.effect !== "mutation") ||
        (tool.effect === "mutation" && tool.approval !== "trusted-human") ||
        !validNamedString(tool.approval),
    )
  ) {
    fail("invalid_schema", path);
  }
}

function validationChecks(
  value: Record<string, unknown>,
  path: string,
): DeclaredValidationCheck[] {
  const manifestKeys = new Set(["schemaVersion", "checks"]);
  const checkKeys = new Set(["id", "kind", "path"]);
  if (
    !hasOnlyKeys(value, manifestKeys) ||
    value.schemaVersion !== "shiplet.validation/v1" ||
    !Array.isArray(value.checks) ||
    value.checks.some(
      (check) =>
        !isRecord(check) ||
        !hasOnlyKeys(check, checkKeys) ||
        check.kind !== "file-exists" ||
        typeof check.path !== "string" ||
        check.path.length === 0 ||
        (check.id !== undefined && !validNamedString(check.id)),
    )
  ) {
    fail("invalid_schema", path);
  }
  return value.checks.map((check) => {
    const record = check as Record<string, unknown>;
    return {
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      kind: "file-exists",
      path: record.path as string,
    };
  });
}

function assertProvenanceSchema(value: Record<string, unknown>, path: string) {
  const provenanceKeys = new Set(["schemaVersion", "source", "lineage"]);
  const sourceKeys = new Set(["kind"]);
  const lineageKeys = new Set(["parentRevisionId"]);
  if (
    !hasOnlyKeys(value, provenanceKeys) ||
    value.schemaVersion !== "shiplet.provenance/v1" ||
    !isRecord(value.source) ||
    !hasOnlyKeys(value.source, sourceKeys) ||
    !validNamedString(value.source.kind) ||
    !isRecord(value.lineage) ||
    !hasOnlyKeys(value.lineage, lineageKeys) ||
    (value.lineage.parentRevisionId !== null &&
      !validNamedString(value.lineage.parentRevisionId))
  ) {
    fail("invalid_schema", path);
  }
}

function assertStructuredFile(
  file: ShipletPackageFile,
  bytes: Uint8Array,
  packagePaths: Set<string>,
) {
  if (!STRUCTURED_PACKAGE_FILES.has(file.path)) return;
  const parsed = structuredJson(file, bytes);
  switch (file.path) {
    case "workflow/schema.json":
      assertWorkflowSchema(parsed, file.path);
      break;
    case "mcp/manifest.json":
      assertMcpSchema(parsed, file.path, packagePaths);
      break;
    case "validation/manifest.json":
      validationChecks(parsed, file.path);
      break;
    case "provenance.json":
      assertProvenanceSchema(parsed, file.path);
      break;
  }
}

export function assertShipletPackageAuthoritySafe(input: unknown) {
  const parsed = parseInput(input);
  if (!isRecord(parsed)) fail("invalid_package");
  assertJsonTree(parsed, "");
  assertNoForbiddenAuthority(parsed);
  for (const key of Object.keys(parsed)) {
    if (!PACKAGE_KEYS.has(key)) fail("invalid_package", key);
  }
  if (Array.isArray(parsed.files)) {
    for (let index = 0; index < parsed.files.length; index += 1) {
      const file = parsed.files[index];
      if (!isRecord(file) || typeof file.path !== "string") continue;
      assertPortablePath(file.path);
      assertAllowedPackagePath(file.path);
    }
  }
  return parsed;
}

export async function parseShipletPackage(
  input: unknown,
): Promise<ValidatedShipletPackage> {
  const parsed = parseInput(input);
  if (!isRecord(parsed)) fail("invalid_package");
  assertJsonTree(parsed, "");
  assertNoForbiddenAuthority(parsed);
  for (const key of Object.keys(parsed)) {
    if (!PACKAGE_KEYS.has(key)) fail("invalid_package", key);
  }
  if (parsed.mediaType !== SHIPLET_PACKAGE_MEDIA_TYPE) {
    fail("unsupported_version", "mediaType");
  }
  const manifest = parseManifest(parsed.manifest);
  if (!Array.isArray(parsed.files)) fail("invalid_package", "files");
  if (parsed.files.length > MAX_FILE_COUNT) fail("too_many_files", "files");
  const files = parsed.files.map(parseFile);
  if (files.length > manifest.limits.fileCount) {
    fail("limit_exceeded", "manifest.limits.fileCount");
  }
  const serializedEnvelopeBytes = new TextEncoder().encode(
    JSON.stringify(
      canonicalize({
        mediaType: SHIPLET_PACKAGE_MEDIA_TYPE,
        manifest,
        files,
      }),
    ),
  ).byteLength;
  if (serializedEnvelopeBytes > MAX_PACKAGE_BYTES) {
    fail("package_too_large", "files");
  }
  const seenPaths = new Map<string, string>();
  const decodedFiles = new Map<string, Uint8Array>();
  let packageBytes = new TextEncoder().encode(
    JSON.stringify(canonicalize(manifest)),
  ).byteLength;
  for (const file of files) {
    const collisionKey = portableCollisionKey(file.path);
    if (seenPaths.has(collisionKey)) fail("path_collision", file.path);
    seenPaths.set(collisionKey, file.path);
    const decoded = decodeFile(file);
    if (decoded.byteLength > MAX_FILE_BYTES) fail("file_too_large", file.path);
    if (decoded.byteLength > manifest.limits.fileBytes) {
      fail("limit_exceeded", "manifest.limits.fileBytes");
    }
    if (decoded.byteLength !== file.size) fail("size_mismatch", file.path);
    if ((await sha256Hex(decoded)) !== file.sha256) {
      fail("digest_mismatch", file.path);
    }
    packageBytes += decoded.byteLength;
    if (packageBytes > MAX_PACKAGE_BYTES) fail("package_too_large", "files");
    if (packageBytes > manifest.limits.packageBytes) {
      fail("limit_exceeded", "manifest.limits.packageBytes");
    }
    decodedFiles.set(file.path, decoded);
  }
  if (manifest.limits.packageBytes < manifest.limits.fileBytes) {
    fail("invalid_limits", "manifest.limits.packageBytes");
  }
  if (serializedEnvelopeBytes > manifest.limits.packageBytes) {
    fail("limit_exceeded", "manifest.limits.packageBytes");
  }
  const packagePaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    assertStructuredFile(file, decodedFiles.get(file.path)!, packagePaths);
  }
  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    const path = manifest.entrypoints[entrypoint];
    if (!packagePaths.has(path)) {
      fail("missing_entrypoint", `manifest.entrypoints.${entrypoint}`);
    }
  }
  try {
    validateRuntimeV1Widget({
      entryPath: manifest.entrypoints.widget,
      files: files
        .filter((file) => file.path.startsWith("widget/"))
        .map((file) => ({
          path: file.path,
          mediaType: file.mediaType,
          bytes: decodedFiles.get(file.path)!,
        })),
    });
  } catch (error) {
    if (error instanceof UnsupportedWidgetDependencyError) {
      fail(error.code, error.path);
    }
    throw error;
  }
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    mediaType: SHIPLET_PACKAGE_MEDIA_TYPE,
    manifest,
    files,
  };
}

export async function serializeShipletPackage(input: unknown): Promise<string> {
  const parsed = await parseShipletPackage(input);
  return JSON.stringify(canonicalize(parsed));
}

export async function digestShipletPackage(input: unknown): Promise<string> {
  const serialized = await serializeShipletPackage(input);
  return sha256Hex(new TextEncoder().encode(serialized));
}

export function shipletPackageProvenanceParentRevisionId(
  input: ValidatedShipletPackage,
) {
  const file = input.files.find(
    (candidate) => candidate.path === input.manifest.entrypoints.provenance,
  );
  if (!file) fail("missing_entrypoint", "manifest.entrypoints.provenance");
  const provenance = structuredJson(file);
  assertProvenanceSchema(provenance, file.path);
  return (provenance.lineage as Record<string, unknown>).parentRevisionId as
    | string
    | null;
}

async function rewriteShipletPackageProvenanceParent(
  input: ValidatedShipletPackage,
  parentRevisionId: string | null,
  force: boolean,
) {
  const current = shipletPackageProvenanceParentRevisionId(input);
  if (!force && current === parentRevisionId) return input;
  const files = input.files.map((file) => ({ ...file }));
  const provenanceFile = files.find(
    (candidate) => candidate.path === input.manifest.entrypoints.provenance,
  );
  if (!provenanceFile) {
    fail("missing_entrypoint", "manifest.entrypoints.provenance");
  }
  const provenance = structuredJson(provenanceFile);
  provenance.lineage = {
    ...(provenance.lineage as Record<string, unknown>),
    parentRevisionId,
  };
  const content = `${JSON.stringify(canonicalize(provenance))}\n`;
  const bytes = new TextEncoder().encode(content);
  provenanceFile.content = content;
  provenanceFile.encoding = "utf8";
  provenanceFile.size = bytes.byteLength;
  provenanceFile.sha256 = await sha256Hex(bytes);
  return parseShipletPackage({
    mediaType: input.mediaType,
    manifest: input.manifest,
    files,
  });
}

export async function withShipletPackageProvenanceParent(
  input: ValidatedShipletPackage,
  parentRevisionId: string | null,
) {
  return rewriteShipletPackageProvenanceParent(input, parentRevisionId, false);
}

export async function digestShipletPackageContent(input: unknown) {
  const parsed = await parseShipletPackage(input);
  return digestShipletPackage(
    await rewriteShipletPackageProvenanceParent(parsed, null, true),
  );
}

export function declaredValidationChecks(
  input: ValidatedShipletPackage,
): DeclaredValidationCheck[] {
  const file = input.files.find(
    (candidate) => candidate.path === input.manifest.entrypoints.validation,
  );
  if (!file) fail("missing_entrypoint", "manifest.entrypoints.validation");
  return validationChecks(structuredJson(file), file.path);
}

export function declaredWorkflowSchema(
  input: ValidatedShipletPackage,
): Record<string, unknown> {
  const file = input.files.find(
    (candidate) => candidate.path === input.manifest.entrypoints.workflow,
  );
  if (!file) fail("missing_entrypoint", "manifest.entrypoints.workflow");
  const value = structuredJson(file);
  assertWorkflowSchema(value, file.path);
  return value;
}

export function packageFileContentBase64(file: ShipletPackageFile) {
  if (file.encoding === "base64") return file.content;
  const bytes = packageFileContentBytes(file);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function packageFileContentBytes(file: ShipletPackageFile) {
  return file.encoding === "base64"
    ? decodeBase64(file.content, file.path)
    : new TextEncoder().encode(file.content);
}
