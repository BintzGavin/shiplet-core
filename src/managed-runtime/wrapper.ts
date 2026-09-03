import { parse } from "acorn";

import {
  digestShipletPackage,
  packageFileContentBytes,
  parseShipletPackage,
  type ValidatedShipletPackage,
} from "../self-owned/package";
import {
  managedRuntimeStatePermissions,
  type ManagedRuntimeStatePermission,
} from "./state";

const WRAPPER_MODULE = "__shiplet_runtime.mjs";
const RESERVED_MODULE_PREFIX = "__shiplet_";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MODULE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/;
const MAX_MODULES = 1_000;
const MAX_MODULE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const JAVASCRIPT_MEDIA_TYPE = "application/javascript+module";

export type ManagedRuntimeModule = Readonly<{
  name: string;
  mediaType: string;
  content: string;
  encoding?: "utf8" | "base64";
}>;

export type ManagedRuntimeInvocationMetadata = Readonly<{
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
}>;

export type ManagedRuntimeIdentity = Readonly<
  Omit<ManagedRuntimeInvocationMetadata, "activationGeneration">
>;

export type ManagedRuntimeBundleInput = ManagedRuntimeIdentity &
  Readonly<{
    mainModule: string;
    modules: readonly ManagedRuntimeModule[];
    statePermissions?: readonly ManagedRuntimeStatePermission[];
  }>;

export type ManagedRuntimeUploadPlan = ManagedRuntimeIdentity &
  Readonly<{
    schemaVersion: "shiplet.managed-runtime-upload/v1";
    mainModule: typeof WRAPPER_MODULE;
    modules: readonly ManagedRuntimeModule[];
    bindings: readonly [];
    statePermissions: readonly ManagedRuntimeStatePermission[];
    bundleDigest: `sha256:${string}`;
  }>;

export type ManagedRuntimePackageInput = ManagedRuntimeIdentity &
  Readonly<{ package: ValidatedShipletPackage }>;

type ManagedRuntimeEntrypoint = Readonly<{
  fetch(
    request: Request,
    environment: Readonly<Record<string, unknown>>,
    context: ExecutionContext,
  ): Response | Promise<Response>;
}>;

type ManagedRuntimeKernelHandler = Readonly<{
  fetch(
    request: Request,
    invocationEnvironment: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<Response>;
}>;

type AcornNode = {
  type: string;
  [key: string]: unknown;
};

type ManagedRuntimeStateResponse =
  | Readonly<{ found: false }>
  | Readonly<{ found: true; value: unknown; version: number }>;

type ManagedRuntimeStateApi = Readonly<{
  get?: (key: string) => Promise<ManagedRuntimeStateResponse>;
  put?: (key: string, value: unknown) => Promise<Readonly<{ version: number }>>;
  delete?: (key: string) => Promise<Readonly<{ deleted: boolean }>>;
}>;

export class ManagedRuntimeCompileError extends Error {
  readonly code: string;
  readonly moduleName?: string;

  constructor(code: string, moduleName?: string) {
    super(moduleName ? `${code} at ${moduleName}` : code);
    this.name = "ManagedRuntimeCompileError";
    this.code = code;
    this.moduleName = moduleName;
  }
}

function fail(code: string, moduleName?: string): never {
  throw new ManagedRuntimeCompileError(code, moduleName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string) {
  return Object.keys(value).sort().join(",") === expected;
}

function validIdentity(value: ManagedRuntimeIdentity) {
  return (
    IDENTIFIER.test(value.shipletId) &&
    IDENTIFIER.test(value.revisionId) &&
    PACKAGE_DIGEST.test(value.packageDigest)
  );
}

function validInvocationMetadata(
  value: unknown,
  identity: ManagedRuntimeIdentity,
): value is ManagedRuntimeInvocationMetadata {
  return (
    isRecord(value) &&
    exactKeys(
      value,
      "activationGeneration,packageDigest,revisionId,shipletId",
    ) &&
    value.shipletId === identity.shipletId &&
    value.revisionId === identity.revisionId &&
    value.packageDigest === identity.packageDigest &&
    Number.isSafeInteger(value.activationGeneration) &&
    (value.activationGeneration as number) > 0
  );
}

function normalizeStatePermissions(value: unknown) {
  if (!Array.isArray(value) || value.length > 2) {
    return fail("managed_state_permissions_invalid");
  }
  if (value.some((item) => item !== "read" && item !== "write")) {
    return fail("managed_state_permissions_invalid");
  }
  const normalized = [...new Set(value)].sort();
  if (normalized.length !== value.length || normalized.join(",") !== value.join(",")) {
    return fail("managed_state_permissions_invalid");
  }
  return Object.freeze(normalized as ManagedRuntimeStatePermission[]);
}

function validStateKey(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
}

function createManagedStateEnvironment(
  permissions: readonly ManagedRuntimeStatePermission[],
) {
  if (permissions.length === 0) {
    return Object.freeze(Object.create(null)) as Readonly<Record<string, unknown>>;
  }
  let sequence = 0;
  const invoke = async (operation: "get" | "put" | "delete", key: string, value?: unknown) => {
    if (!validStateKey(key) || sequence >= 64) {
      throw new TypeError("managed_state_request_invalid");
    }
    sequence += 1;
    const outbound = await fetch("https://shiplet-state.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "shiplet.managed-state-request/v1",
        operation,
        sequence,
        key,
        ...(operation === "put" ? { value } : {}),
      }),
      redirect: "manual",
    });
    if (!outbound.ok) throw new Error("managed_state_request_failed");
    const result = (await outbound.json()) as unknown;
    if (
      !isRecord(result) ||
      result.schemaVersion !== "shiplet.managed-state-response/v1" ||
      result.ok !== true ||
      result.operation !== operation
    ) {
      throw new Error("managed_state_response_invalid");
    }
    return result;
  };
  const state: {
    get?: ManagedRuntimeStateApi["get"];
    put?: ManagedRuntimeStateApi["put"];
    delete?: ManagedRuntimeStateApi["delete"];
  } = Object.create(null) as ManagedRuntimeStateApi;
  if (permissions.includes("read")) {
    state.get = async (key) => {
      const result = await invoke("get", key);
      if (
        typeof result.found !== "boolean" ||
        (result.found &&
          (!Number.isSafeInteger(result.version) || (result.version as number) <= 0))
      ) {
        throw new Error("managed_state_response_invalid");
      }
      return Object.freeze(
        result.found
          ? { found: true as const, value: result.value, version: result.version as number }
          : { found: false as const },
      );
    };
  }
  if (permissions.includes("write")) {
    state.put = async (key, value) => {
      const result = await invoke("put", key, value);
      if (!Number.isSafeInteger(result.version) || (result.version as number) <= 0) {
        throw new Error("managed_state_response_invalid");
      }
      return Object.freeze({ version: result.version as number });
    };
    state.delete = async (key) => {
      const result = await invoke("delete", key);
      if (typeof result.deleted !== "boolean") {
        throw new Error("managed_state_response_invalid");
      }
      return Object.freeze({ deleted: result.deleted });
    };
  }
  const capability = Object.freeze(state) as ManagedRuntimeStateApi;
  return Object.freeze({ SHIPLET_STATE: capability });
}

function jsonResponse(body: Record<string, unknown>, status: number) {
  const serialized = JSON.stringify(body);
  const length = new TextEncoder().encode(serialized).byteLength;
  return new Response(serialized, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-length": String(length),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

/**
 * The executable form of the generated kernel wrapper. Package code never
 * receives the dynamic-dispatch argument object, even when that object grows
 * new platform-owned fields in a future gateway release.
 */
export function createManagedRuntimeKernelHandler(
  identity: ManagedRuntimeIdentity,
  runtimeEntrypoint: ManagedRuntimeEntrypoint,
  statePermissions: readonly ManagedRuntimeStatePermission[] = [],
): ManagedRuntimeKernelHandler {
  if (!validIdentity(identity)) fail("managed_identity_invalid");
  const trustedIdentity = Object.freeze({ ...identity });
  const trustedStatePermissions = normalizeStatePermissions(statePermissions);
  const hasFetch =
    isRecord(runtimeEntrypoint) && typeof runtimeEntrypoint.fetch === "function";

  return Object.freeze({
    async fetch(request, invocationEnvironment, context) {
      if (new URL(request.url).pathname === "/__shiplet/health") {
        const metadata = invocationEnvironment?.SHIPLET_RUNTIME;
        if (!hasFetch || !validInvocationMetadata(metadata, trustedIdentity)) {
          return jsonResponse({ ok: false }, 503);
        }
        return jsonResponse(
          {
            ok: true,
            shipletId: trustedIdentity.shipletId,
            revisionId: trustedIdentity.revisionId,
            packageDigest: trustedIdentity.packageDigest,
            activationGeneration: metadata.activationGeneration,
          },
          200,
        );
      }
      if (!hasFetch) return jsonResponse({ ok: false }, 503);
      // The sequence is an invocation-local replay boundary. Never retain it in
      // isolate-global state across separate package fetches.
      const packageEnvironment = createManagedStateEnvironment(
        trustedStatePermissions,
      );
      return await runtimeEntrypoint.fetch.call(
        runtimeEntrypoint,
        request,
        packageEnvironment,
        context,
      );
    },
  });
}

function isJavaScriptMediaType(mediaType: string) {
  const value = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    value === "application/javascript" ||
    value === "application/ecmascript" ||
    value === "text/javascript" ||
    value === "text/ecmascript" ||
    value === JAVASCRIPT_MEDIA_TYPE
  );
}

function isWasmMediaType(mediaType: string) {
  return mediaType.split(";", 1)[0]!.trim().toLowerCase() === "application/wasm";
}

function moduleBytes(module: ManagedRuntimeModule) {
  let bytes: Uint8Array;
  if (module.encoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(module.content)) {
      return fail("managed_module_invalid", module.name);
    }
    try {
      bytes = Uint8Array.from(atob(module.content), (character) =>
        character.charCodeAt(0),
      );
    } catch {
      return fail("managed_module_invalid", module.name);
    }
    if (module.content.length % 4 !== 0 || base64(bytes) !== module.content) {
      return fail("managed_module_invalid", module.name);
    }
  } else {
    bytes = new TextEncoder().encode(module.content);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MODULE_BYTES) {
    return fail("managed_module_invalid", module.name);
  }
  return bytes;
}

function base64(bytes: Uint8Array) {
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 16_384) {
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(encoded);
}

function utf8(bytes: Uint8Array, moduleName: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("managed_module_invalid", moduleName);
  }
}

function reservedModuleName(name: string) {
  return name
    .split("/")
    .some((segment) => segment.toLowerCase().startsWith(RESERVED_MODULE_PREFIX));
}

function validModuleName(name: string) {
  return (
    MODULE_NAME.test(name) &&
    name
      .split("/")
      .every(
        (segment) => segment !== "" && segment !== "." && segment !== "..",
      ) &&
    !reservedModuleName(name)
  );
}

function walk(node: unknown, visit: (node: AcornNode) => void) {
  if (!isRecord(node) || typeof node.type !== "string") return;
  const current = node as AcornNode;
  visit(current);
  for (const [key, value] of Object.entries(current)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else {
      walk(value, visit);
    }
  }
}

function literalSpecifier(node: unknown) {
  if (
    !isRecord(node) ||
    node.type !== "Literal" ||
    typeof node.value !== "string"
  ) {
    return null;
  }
  return node.value;
}

function resolveModuleSpecifier(owner: string, specifier: string) {
  if (
    (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
    specifier.includes("\\") ||
    specifier.includes("?") ||
    specifier.includes("#") ||
    specifier.includes("%")
  ) {
    return fail("managed_module_specifier_forbidden", owner);
  }
  const segments = owner.split("/");
  segments.pop();
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        return fail("managed_module_specifier_forbidden", owner);
      }
      segments.pop();
      continue;
    }
    if (!MODULE_NAME.test(segment)) {
      return fail("managed_module_specifier_forbidden", owner);
    }
    segments.push(segment);
  }
  const resolved = segments.join("/");
  if (!resolved || reservedModuleName(resolved)) {
    return fail("managed_module_specifier_forbidden", owner);
  }
  return resolved;
}

function validateJavaScriptModule(
  source: string,
  moduleName: string,
  moduleNames: ReadonlySet<string>,
) {
  let program: unknown;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
  } catch {
    return fail("managed_module_invalid", moduleName);
  }
  walk(program, (node) => {
    let sourceNode: unknown;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      sourceNode = node.source;
      if (sourceNode === null || sourceNode === undefined) return;
    } else if (node.type === "ImportExpression") {
      sourceNode = node.source;
    } else {
      return;
    }
    const specifier = literalSpecifier(sourceNode);
    if (specifier === null) {
      return fail("managed_module_specifier_forbidden", moduleName);
    }
    const resolved = resolveModuleSpecifier(moduleName, specifier);
    if (!moduleNames.has(resolved)) {
      return fail("managed_module_specifier_forbidden", moduleName);
    }
  });
}

function generatedWrapperSource(
  identity: ManagedRuntimeIdentity,
  packageMainModule: string,
  statePermissions: readonly ManagedRuntimeStatePermission[],
) {
  const serializedIdentity = JSON.stringify(identity);
  const serializedImport = JSON.stringify(`./${packageMainModule}`);
  return `import runtimeEntrypoint from ${serializedImport};
const IDENTITY = Object.freeze(${serializedIdentity});
const STATE_PERMISSIONS = Object.freeze(${JSON.stringify(statePermissions)});
const EMPTY_ENV = Object.freeze(Object.create(null));
const EXACT_METADATA_KEYS = "activationGeneration,packageDigest,revisionId,shipletId";
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactMetadata(value) { return isRecord(value) && Object.keys(value).sort().join(",") === EXACT_METADATA_KEYS && value.shipletId === IDENTITY.shipletId && value.revisionId === IDENTITY.revisionId && value.packageDigest === IDENTITY.packageDigest && Number.isSafeInteger(value.activationGeneration) && value.activationGeneration > 0; }
function json(body, status) { const serialized = JSON.stringify(body); return new Response(serialized, { status, headers: { "cache-control": "no-store", "content-length": String(new TextEncoder().encode(serialized).byteLength), "content-type": "application/json; charset=utf-8" } }); }
function validStateKey(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value); }
function stateEnvironment() { if (STATE_PERMISSIONS.length === 0) return EMPTY_ENV; let sequence = 0; const invoke = async (operation, key, value) => { if (!validStateKey(key) || sequence >= 64) throw new TypeError("managed_state_request_invalid"); sequence += 1; const outbound = await fetch("https://shiplet-state.invalid/v1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schemaVersion: "shiplet.managed-state-request/v1", operation, sequence, key, ...(operation === "put" ? { value } : {}) }), redirect: "manual" }); if (!outbound.ok) throw new Error("managed_state_request_failed"); const result = await outbound.json(); if (!isRecord(result) || result.schemaVersion !== "shiplet.managed-state-response/v1" || result.ok !== true || result.operation !== operation) throw new Error("managed_state_response_invalid"); return result; }; const state = Object.create(null); if (STATE_PERMISSIONS.includes("read")) state.get = async (key) => { const result = await invoke("get", key); if (typeof result.found !== "boolean" || (result.found && (!Number.isSafeInteger(result.version) || result.version <= 0))) throw new Error("managed_state_response_invalid"); return Object.freeze(result.found ? { found: true, value: result.value, version: result.version } : { found: false }); }; if (STATE_PERMISSIONS.includes("write")) { state.put = async (key, value) => { const result = await invoke("put", key, value); if (!Number.isSafeInteger(result.version) || result.version <= 0) throw new Error("managed_state_response_invalid"); return Object.freeze({ version: result.version }); }; state.delete = async (key) => { const result = await invoke("delete", key); if (typeof result.deleted !== "boolean") throw new Error("managed_state_response_invalid"); return Object.freeze({ deleted: result.deleted }); }; } return Object.freeze({ SHIPLET_STATE: Object.freeze(state) }); }
const hasFetch = isRecord(runtimeEntrypoint) && typeof runtimeEntrypoint.fetch === "function";
export default Object.freeze({ async fetch(request, invocationEnvironment, context) { if (new URL(request.url).pathname === "/__shiplet/health") { const metadata = invocationEnvironment && invocationEnvironment.SHIPLET_RUNTIME; if (!hasFetch || !exactMetadata(metadata)) return json({ ok: false }, 503); return json({ ok: true, shipletId: IDENTITY.shipletId, revisionId: IDENTITY.revisionId, packageDigest: IDENTITY.packageDigest, activationGeneration: metadata.activationGeneration }, 200); } if (!hasFetch) return json({ ok: false }, 503); return await runtimeEntrypoint.fetch.call(runtimeEntrypoint, request, stateEnvironment(), context); } });
`;
}

async function sha256Hex(bytes: Uint8Array) {
  const digestBytes = new Uint8Array(bytes.byteLength);
  digestBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Adds Shiplet's trusted, immutable main module to an already verified
 * revision bundle. This is the integration boundary used by the kernel before
 * `ManagedRuntimeGateway.stageRevision()`.
 */
export async function compileManagedRuntimeBundle(
  input: ManagedRuntimeBundleInput,
): Promise<ManagedRuntimeUploadPlan> {
  if (
    !validIdentity(input) ||
    !validModuleName(input.mainModule) ||
    !Array.isArray(input.modules) ||
    input.modules.length === 0 ||
    input.modules.length >= MAX_MODULES
  ) {
    return fail("managed_bundle_invalid");
  }
  const statePermissions = normalizeStatePermissions(input.statePermissions ?? []);

  const names = new Set<string>();
  const normalized: ManagedRuntimeModule[] = [];
  let totalBytes = 0;
  for (const candidate of input.modules as readonly unknown[]) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      typeof candidate.content !== "string" ||
      typeof candidate.mediaType !== "string" ||
      (candidate.encoding !== undefined &&
        candidate.encoding !== "utf8" &&
        candidate.encoding !== "base64")
    ) {
      return fail("managed_module_invalid");
    }
    const module: ManagedRuntimeModule = {
      name: candidate.name,
      content: candidate.content,
      mediaType: candidate.mediaType,
      encoding: candidate.encoding,
    };
    if (
      !validModuleName(module.name) ||
      names.has(module.name) ||
      (!isJavaScriptMediaType(module.mediaType) &&
        !isWasmMediaType(module.mediaType))
    ) {
      return fail(
        reservedModuleName(module.name)
          ? "managed_module_name_reserved"
          : "managed_module_invalid",
        module.name,
      );
    }
    names.add(module.name);
    const bytes = moduleBytes(module);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      return fail("managed_bundle_too_large");
    }
    normalized.push(
      Object.freeze(
        isJavaScriptMediaType(module.mediaType)
          ? {
              name: module.name,
              mediaType: JAVASCRIPT_MEDIA_TYPE,
              content: utf8(bytes, module.name),
              encoding: "utf8" as const,
            }
          : {
              name: module.name,
              mediaType: "application/wasm",
              content: base64(bytes),
              encoding: "base64" as const,
            },
      ),
    );
  }
  if (!names.has(input.mainModule)) {
    return fail("managed_main_module_invalid", input.mainModule);
  }

  for (const module of normalized) {
    if (module.mediaType === JAVASCRIPT_MEDIA_TYPE) {
      validateJavaScriptModule(module.content, module.name, names);
    }
  }

  const wrapper = Object.freeze({
    name: WRAPPER_MODULE,
    mediaType: JAVASCRIPT_MEDIA_TYPE,
    content: generatedWrapperSource(input, input.mainModule, statePermissions),
    encoding: "utf8" as const,
  });
  validateJavaScriptModule(
    wrapper.content,
    wrapper.name,
    new Set([...names, wrapper.name]),
  );
  totalBytes += new TextEncoder().encode(wrapper.content).byteLength;
  if (totalBytes > MAX_BUNDLE_BYTES) return fail("managed_bundle_too_large");
  const modules = Object.freeze(
    [wrapper, ...normalized].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  );
  const digestEnvelope = JSON.stringify({
    schemaVersion: "shiplet.managed-runtime-upload/v1",
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    packageDigest: input.packageDigest,
    mainModule: WRAPPER_MODULE,
    bindings: [],
    statePermissions,
    modules,
  });
  const bundleDigest =
    `sha256:${await sha256Hex(new TextEncoder().encode(digestEnvelope))}` as const;
  return Object.freeze({
    schemaVersion: "shiplet.managed-runtime-upload/v1",
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    packageDigest: input.packageDigest,
    mainModule: WRAPPER_MODULE,
    modules,
    bindings: Object.freeze([] as []),
    statePermissions,
    bundleDigest,
  });
}

/**
 * Package-level adapter used where the portable envelope is still available.
 * It revalidates the envelope and binds its canonical digest before emitting a
 * dynamic upload. Static packages intentionally bypass the managed runtime.
 */
export async function compileManagedRuntimeRevision(
  input: ManagedRuntimePackageInput,
): Promise<ManagedRuntimeUploadPlan | null> {
  if (input.package.manifest.staticFirst) return null;
  if (!input.package.manifest.requestedCapabilities.includes("runtime.worker")) {
    return fail("managed_runtime_capability_missing");
  }
  const packageEnvelope = await parseShipletPackage(input.package);
  const packageDigest = `sha256:${await digestShipletPackage(packageEnvelope)}`;
  if (packageDigest !== input.packageDigest) {
    return fail("managed_package_digest_mismatch");
  }
  const artifactPrefix = "artifact/";
  const packageMainModule = packageEnvelope.manifest.entrypoints.artifact.slice(
    artifactPrefix.length,
  );
  const modules = packageEnvelope.files
    .filter(
      (file) =>
        file.path.startsWith(artifactPrefix) &&
        (isJavaScriptMediaType(file.mediaType) ||
          isWasmMediaType(file.mediaType)),
    )
    .map((file) => {
      const bytes = packageFileContentBytes(file);
      return {
        name: file.path.slice(artifactPrefix.length),
        mediaType: file.mediaType,
        content: file.encoding === "base64" ? base64(bytes) : file.content,
        encoding: file.encoding,
      } satisfies ManagedRuntimeModule;
    });
  return await compileManagedRuntimeBundle({
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    packageDigest: input.packageDigest,
    mainModule: packageMainModule,
    modules,
    statePermissions: managedRuntimeStatePermissions(
      packageEnvelope.manifest.requestedCapabilities,
    ),
  });
}
