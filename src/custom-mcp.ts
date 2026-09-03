import type {
  AuthorizedCapabilityInvocation,
  CapabilityActor,
  CapabilityBroker,
  CapabilityInvocation,
  CapabilityInvocationResult,
} from "./capability-broker";
import {
  digestShipletPackageContent,
  parseShipletPackage,
  type ShipletPackageFile,
  type ValidatedShipletPackage,
} from "./self-owned/package";

export const KERNEL_MCP_TOOL_NAMES = Object.freeze([
  "search",
  "execute",
] as const);

export interface CustomMcpLimits {
  maxManifestBytes: number;
  maxTools: number;
  maxNameBytes: number;
  maxDescriptionBytes: number;
  maxSchemaBytes: number;
  maxHandlerBytes: number;
  maxInputBytes: number;
  maxResultBytes: number;
  maxTreeDepth: number;
  maxTreeNodes: number;
  maxCapabilityCalls: number;
  maxCapabilityRequestBytes: number;
  maxExecutionMs: number;
}

export interface CustomMcpCompileInput {
  manifestBytes: Uint8Array | null;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  packageRuntimeCompatibility: string;
  packageRequestedCapabilities: readonly string[];
  handlerFiles: Readonly<Record<string, Uint8Array>>;
  supportedRuntimeVersions: readonly string[];
  supportedCapabilities: readonly string[];
  reservedKernelTools: readonly string[];
  limits: CustomMcpLimits;
}

export interface CustomMcpContractError {
  code: string;
  path?: string;
}

export interface CompiledCustomMcpTool {
  name: string;
  localName: string;
  description: string;
  descriptionTrust: "trusted_kernel";
  inputSchema: Readonly<Record<string, unknown>>;
  handlerPath: string;
  requestedCapabilities: readonly string[];
  effect: "read" | "mutation";
  approval: "none" | "trusted-human";
}

export interface CompiledCustomMcpRegistry {
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  tools: readonly CompiledCustomMcpTool[];
  resolve(name: string): CompiledCustomMcpTool | null;
}

interface VerifiedCustomMcpHandler {
  path: string;
  digest: string;
  bytes: Uint8Array;
}

interface VerifiedCustomMcpRegistryScope {
  activationGeneration: number;
  handlerSetDigest: string;
}

export interface CustomMcpActiveRevisionResolver {
  resolve(shipletId: string): {
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  } | null;
}

export type CustomMcpCompileResult =
  | { ok: true; registry: CompiledCustomMcpRegistry }
  | { ok: false; error: CustomMcpContractError };

export interface KernelMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  trust: "trusted_kernel";
}

export interface CustomMcpToolCatalog {
  tools: readonly (KernelMcpTool | CompiledCustomMcpTool)[];
  kernelTools: readonly KernelMcpTool[];
  customTools: readonly CompiledCustomMcpTool[];
}

export interface CustomMcpRuntimeCapabilityRequest {
  capability: string;
  resource: string;
  input: unknown;
  effect?: "read" | "mutation";
}

export type CustomMcpRuntimeCapabilityResult =
  | CapabilityInvocationResult<unknown>
  | {
      ok: false;
      code:
        | "capability_limit_exceeded"
        | "capability_deadline_exceeded"
        | "capability_payload_too_large"
        | "capability_effect_mismatch"
        | "capability_reconciliation_required"
        | "egress_denied";
    };

export interface IsolatedCustomMcpRuntimeInvocation {
  actor: CapabilityActor;
  shipletId: string;
  revisionId: string;
  toolName: string;
  requestId: string;
  handlerPath: string;
  input: unknown;
  declaredCapabilities: readonly string[];
  requestCapability(
    request: CustomMcpRuntimeCapabilityRequest,
  ): Promise<CustomMcpRuntimeCapabilityResult>;
}

export interface CustomMcpRuntimeAdapter {
  invoke(invocation: IsolatedCustomMcpRuntimeInvocation): Promise<Uint8Array>;
  cancel(input: {
    invocationId: string;
    reason: "deadline_exceeded";
  }): void | Promise<void>;
}

export interface CustomMcpBoundRequirements {
  effect: "read" | "mutation";
  approval: "none" | "trusted-human";
}

export interface CustomMcpBoundCapabilityBroker extends CapabilityBroker {
  invokeBound<T>(
    invocation: CapabilityInvocation,
    requirements: CustomMcpBoundRequirements,
    execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
  ): Promise<CapabilityInvocationResult<T>>;
}

export interface CustomMcpCapabilityDispatcher {
  dispatch(input: {
    authorized: AuthorizedCapabilityInvocation;
    stateNamespace: string;
    egressPolicy: { allowedResources: readonly string[] };
    invocationId: string;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<CustomMcpCapabilityDispatchOutcome>;
}

export type CustomMcpNestedCapabilityDenialOutcome =
  | "approval_required"
  | "audit_unavailable"
  | "capability_deadline_exceeded"
  | "capability_denied"
  | "capability_effect_mismatch"
  | "capability_limit_exceeded"
  | "capability_payload_too_large"
  | "egress_denied";

export interface CustomMcpNestedCapabilityDenialAuditEvent {
  schemaVersion: "shiplet.audit.custom-mcp-nested-denial/v1";
  eventKind: "custom_mcp.nested_capability_denied";
  outcome: CustomMcpNestedCapabilityDenialOutcome;
  actorKind: CapabilityActor["kind"];
  actorId: string;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  toolName: string;
  parentRequestId: string;
  subcallOrdinal: number;
  declaredCapability: string | null;
}

export type CustomMcpNestedCapabilityDenialAudit = (
  event: CustomMcpNestedCapabilityDenialAuditEvent,
) => void | Promise<void>;

export type CustomMcpCapabilityDispatchOutcome =
  | {
      status: "committed";
      journalId: string;
      value: unknown;
    }
  | {
      status: "aborted";
      journalId: string;
    }
  | {
      status: "reconciliation_required";
      journalId: string;
    };

export interface CustomMcpResumableApproval {
  /** Correlation only. This value grants no authority. */
  approvalRequestId: string;
  /** Trusted same-origin kernel route. This path grants no authority itself. */
  confirmationPath: string;
  expiresAt: number;
}

export type CustomMcpTrustedChildApprovalResult =
  | { status: "approved" }
  | {
      status: "approval_required";
      approval: CustomMcpResumableApproval;
    }
  | { status: "denied" };

export interface CustomMcpTrustedChildMutationBinding {
  actor: CapabilityActor;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  toolName: string;
  parentRequestId: string;
  childRequestId: string;
  toolInput: unknown;
  declaredCapabilities: readonly string[];
  capability: string;
  resource: string;
  effect: "mutation";
  input: unknown;
  /** Kernel-held handle. It is never serialized into the isolated runtime. */
  opaqueCapabilityHandle: string;
}

export interface CustomMcpTrustedChildApprovalDelegate {
  resolve(
    input: CustomMcpTrustedChildMutationBinding,
  ): Promise<CustomMcpTrustedChildApprovalResult>;
}

export interface CustomMcpApprovedMutationDispatcher {
  dispatch(
    input: CustomMcpTrustedChildMutationBinding & {
      authorized: AuthorizedCapabilityInvocation;
      stateNamespace: string;
      egressPolicy: { allowedResources: readonly string[] };
      invocationId: string;
      deadlineAt: number;
      signal: AbortSignal;
    },
  ): Promise<CustomMcpCapabilityDispatchOutcome>;
}

export interface CustomMcpExecutorInvocation {
  trustedActor: CapabilityActor;
  shipletId: string;
  revisionId: string;
  toolName: string;
  requestId: string;
  inputBytes: Uint8Array;
  invocationCapabilityHandle: string;
  capabilityHandles?: Readonly<Record<string, string>>;
}

export type CustomMcpExecutorResult =
  | {
      ok: true;
      value: {
        trust: "trusted_kernel";
        content: readonly { type: "text"; text: string }[];
        quarantine: {
          status: "held_for_trusted_human_release";
          contentKind: "custom_mcp_result";
          itemCount: number;
        };
      };
    }
  | {
      ok: false;
      code: string;
      approval?: CustomMcpResumableApproval;
    };

export interface CustomMcpExecutor {
  invoke(
    invocation: CustomMcpExecutorInvocation,
  ): Promise<CustomMcpExecutorResult>;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type JsonRecord = { readonly [key: string]: JsonValue };

type ManifestTool = {
  name: string;
  description: string;
  handler: string;
  inputSchema: JsonRecord;
  requestedCapabilities: string[];
  effect: "read" | "mutation";
  approval: "none" | "trusted-human";
};

class CompileFailure extends Error {
  constructor(
    readonly code: string,
    readonly path?: string,
  ) {
    super(code);
  }
}

const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "runtimeCompatibility",
  "tools",
]);
const TOOL_KEYS = new Set([
  "name",
  "description",
  "handler",
  "inputSchema",
  "requestedCapabilities",
  "effect",
  "approval",
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "accesstoken",
  "authorization",
  "authorizationcode",
  "apikey",
  "claimcode",
  "claimcredential",
  "claimurl",
  "clientsecret",
  "connectionstring",
  "credential",
  "credentials",
  "oauth",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrets",
  "session",
  "token",
]);
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUDIT_SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_ATTESTED_RUNTIME_CPU_MS = 30_000;
const MAX_ATTESTED_RUNTIME_MEMORY_BYTES = 128 * 1024 * 1024;
const MAX_ATTESTED_RUNTIME_SUBREQUESTS = 100;
const SCHEMA_PROPERTY_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CUSTOM_MCP_DESCRIPTION =
  "Run this revision-scoped custom Shiplet tool. Package-authored guidance and output stay quarantined; only declared capabilities can affect Shiplet state.";
const SAFE_CUSTOM_MCP_RESULT_NOTICE =
  "Custom Shiplet tool completed. Package-authored output is quarantined pending trusted human review.";

type QuarantinedToolDescription = Readonly<{
  shipletId: string;
  revisionId: string;
  text: string;
}>;

type QuarantinedCustomMcpResult = Readonly<{
  shipletId: string;
  revisionId: string;
  content: readonly Readonly<{ type: "text"; text: string }>[];
}>;

const QUARANTINED_TOOL_DESCRIPTIONS = new WeakMap<
  object,
  QuarantinedToolDescription
>();
const QUARANTINED_CUSTOM_MCP_RESULTS = new WeakMap<
  object,
  QuarantinedCustomMcpResult
>();
const TRUSTED_CUSTOM_MCP_CATALOGS = new WeakSet<object>();
const HANDLER_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUPPORTED_MCP_SCHEMA_VERSION = "shiplet.mcp/v1";
const COMPILED_REGISTRY_BRAND = Symbol("shiplet.compiled-mcp-registry");
const VERIFIED_HANDLER_BINDING = Symbol("shiplet.verified-mcp-handlers");
const VERIFIED_REGISTRY_SCOPE = Symbol("shiplet.verified-mcp-registry-scope");
const SERIALIZED_RUNTIME_BINDING = Symbol("shiplet.serialized-runtime-binding");
const PACKAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HANDLER_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_ISOLATION_ATTESTATIONS = new WeakMap<
  object,
  {
    authority: object;
    claims: RuntimeIsolationAttestationClaims;
  }
>();
const RUNTIME_ISOLATION_AUTHORITY_VERIFIERS = new WeakMap<
  object,
  (attestation: unknown, expected: CustomMcpRuntimeIsolationBinding) => boolean
>();
const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const COMMON_SCHEMA_KEYS = new Set(["type"]);
const OBJECT_SCHEMA_KEYS = new Set([
  "type",
  "additionalProperties",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
]);
const ARRAY_SCHEMA_KEYS = new Set(["type", "items", "minItems", "maxItems"]);
const STRING_SCHEMA_KEYS = new Set(["type", "minLength", "maxLength"]);
const NUMBER_SCHEMA_KEYS = new Set(["type", "minimum", "maximum"]);

type RuntimeIsolationAttestationClaims = Readonly<{
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
  handlerSetDigest: string;
  handlers: readonly Readonly<{ path: string; digest: string }>[];
  policy: CustomMcpRuntimeIsolationPolicy;
}>;

function fail(code: string, path?: string): never {
  throw new CompileFailure(code, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeAuthorityKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[-_\s]/gu, "");
}

function normalizeToolCollisionKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[-_]/gu, "");
}

function sanitizeUntrustedText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu,
    "�",
  );
}

function expectedCapabilityEffect(
  capability: string,
): "read" | "mutation" | null {
  if (
    /(?:^|[.:])(?:write|create|update|delete|mutate|deploy|promote|rollback)(?:$|[.:])/u.test(
      capability,
    )
  ) {
    return "mutation";
  }
  if (/(?:^|[.:])(?:read|list|get|fetch|search)(?:$|[.:])/u.test(capability)) {
    return "read";
  }
  return null;
}

function assertLimits(limits: CustomMcpLimits) {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError("Invalid custom MCP limits");
    }
  }
}

function assertScopeId(value: string, path: string) {
  if (!SCOPE_ID_PATTERN.test(value)) fail("invalid_scope", path);
}

function scanJsonTree(
  value: unknown,
  limits: CustomMcpLimits,
  state: { nodes: number },
  path = "$",
  depth = 0,
): asserts value is JsonValue {
  state.nodes += 1;
  if (state.nodes > limits.maxTreeNodes) fail("manifest_node_limit", path);
  if (depth > limits.maxTreeDepth) fail("manifest_too_deep", path);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail("invalid_manifest", path);
    }
    return;
  }
  if (typeof value !== "object") fail("invalid_manifest", path);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scanJsonTree(value[index], limits, state, `${path}[${index}]`, depth + 1);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (PROTOTYPE_KEYS.has(key)) fail("forbidden_key", childPath);
    if (FORBIDDEN_AUTHORITY_KEYS.has(normalizeAuthorityKey(key))) {
      fail("forbidden_authority", childPath);
    }
    scanJsonTree(child, limits, state, childPath, depth + 1);
  }
}

function cloneAndFreezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeJson(entry)));
  }
  if (value !== null && typeof value === "object") {
    const record = value as JsonRecord;
    const result: Record<string, JsonValue> = Object.create(null) as Record<
      string,
      JsonValue
    >;
    for (const key of Object.keys(record).sort()) {
      result[key] = cloneAndFreezeJson(record[key]);
    }
    return Object.freeze(result);
  }
  return value;
}

function parseEncodedJson(
  bytes: Uint8Array,
  encodingError: string,
  jsonError: string,
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(encodingError);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(jsonError);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${path}.${key}`);
  }
}

function assertOptionalNonNegativeInteger(
  value: unknown,
  path: string,
): value is number | undefined {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    fail("invalid_schema", path);
  }
  return true;
}

function assertSupportedJsonSchema(
  value: unknown,
  path: string,
): asserts value is JsonRecord {
  if (!isRecord(value) || typeof value.type !== "string") {
    fail("invalid_schema", path);
  }
  if (!SCHEMA_TYPES.has(value.type)) fail("invalid_schema", `${path}.type`);
  let allowedKeys = COMMON_SCHEMA_KEYS;
  switch (value.type) {
    case "object":
      allowedKeys = OBJECT_SCHEMA_KEYS;
      break;
    case "array":
      allowedKeys = ARRAY_SCHEMA_KEYS;
      break;
    case "string":
      allowedKeys = STRING_SCHEMA_KEYS;
      break;
    case "number":
    case "integer":
      allowedKeys = NUMBER_SCHEMA_KEYS;
      break;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail("unsupported_schema_keyword", `${path}.${key}`);
    }
  }
  if (value.type === "object") {
    if (value.additionalProperties !== false) {
      fail("invalid_schema", `${path}.additionalProperties`);
    }
    if (value.properties !== undefined && !isRecord(value.properties)) {
      fail("invalid_schema", `${path}.properties`);
    }
    const properties = isRecord(value.properties) ? value.properties : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (
        !SCHEMA_PROPERTY_NAME_PATTERN.test(name) ||
        PROTOTYPE_KEYS.has(name)
      ) {
        fail("invalid_schema_property_name", `${path}.properties.${name}`);
      }
      assertSupportedJsonSchema(propertySchema, `${path}.properties.${name}`);
    }
    if (
      value.required !== undefined &&
      (!Array.isArray(value.required) ||
        value.required.some((name) => typeof name !== "string"))
    ) {
      fail("invalid_schema", `${path}.required`);
    }
    const required = (value.required ?? []) as string[];
    if (
      new Set(required).size !== required.length ||
      required.some(
        (name) => !Object.prototype.hasOwnProperty.call(properties, name),
      )
    ) {
      fail("invalid_schema", `${path}.required`);
    }
    assertOptionalNonNegativeInteger(
      value.minProperties,
      `${path}.minProperties`,
    );
    assertOptionalNonNegativeInteger(
      value.maxProperties,
      `${path}.maxProperties`,
    );
    if (
      typeof value.minProperties === "number" &&
      typeof value.maxProperties === "number" &&
      value.minProperties > value.maxProperties
    ) {
      fail("invalid_schema", path);
    }
    return;
  }
  if (value.type === "array") {
    if (value.items === undefined) fail("invalid_schema", `${path}.items`);
    assertSupportedJsonSchema(value.items, `${path}.items`);
    assertOptionalNonNegativeInteger(value.minItems, `${path}.minItems`);
    assertOptionalNonNegativeInteger(value.maxItems, `${path}.maxItems`);
    if (
      typeof value.minItems === "number" &&
      typeof value.maxItems === "number" &&
      value.minItems > value.maxItems
    ) {
      fail("invalid_schema", path);
    }
    return;
  }
  if (value.type === "string") {
    assertOptionalNonNegativeInteger(value.minLength, `${path}.minLength`);
    assertOptionalNonNegativeInteger(value.maxLength, `${path}.maxLength`);
    if (
      typeof value.minLength === "number" &&
      typeof value.maxLength === "number" &&
      value.minLength > value.maxLength
    ) {
      fail("invalid_schema", path);
    }
    return;
  }
  if (value.type === "number" || value.type === "integer") {
    if (
      (value.minimum !== undefined &&
        (typeof value.minimum !== "number" ||
          !Number.isFinite(value.minimum))) ||
      (value.maximum !== undefined &&
        (typeof value.maximum !== "number" ||
          !Number.isFinite(value.maximum))) ||
      (typeof value.minimum === "number" &&
        typeof value.maximum === "number" &&
        value.minimum > value.maximum)
    ) {
      fail("invalid_schema", path);
    }
  }
}

function valueMatchesSchema(value: JsonValue, schema: JsonRecord): boolean {
  const type = schema.type;
  if (type === "null") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") {
    return (
      typeof value === "string" &&
      (typeof schema.minLength !== "number" ||
        value.length >= schema.minLength) &&
      (typeof schema.maxLength !== "number" || value.length <= schema.maxLength)
    );
  }
  if (type === "number" || type === "integer") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (type !== "integer" || Number.isSafeInteger(value)) &&
      (typeof schema.minimum !== "number" || value >= schema.minimum) &&
      (typeof schema.maximum !== "number" || value <= schema.maximum)
    );
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    ) {
      return false;
    }
    const items = schema.items as JsonRecord;
    return value.every((entry) => valueMatchesSchema(entry, items));
  }
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const keys = Object.keys(value);
    if (
      (typeof schema.minProperties === "number" &&
        keys.length < schema.minProperties) ||
      (typeof schema.maxProperties === "number" &&
        keys.length > schema.maxProperties)
    ) {
      return false;
    }
    const properties = (schema.properties ?? {}) as JsonRecord;
    const required = (schema.required ?? []) as readonly JsonValue[];
    if (
      required.some(
        (name) =>
          typeof name !== "string" ||
          !Object.prototype.hasOwnProperty.call(value, name),
      )
    ) {
      return false;
    }
    for (const key of keys) {
      const childSchema = properties[key];
      if (childSchema === undefined || !isRecord(childSchema)) return false;
      if (
        !valueMatchesSchema(
          (value as JsonRecord)[key],
          childSchema as JsonRecord,
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function assertToolName(
  name: unknown,
  reserved: ReadonlySet<string>,
  path: string,
): asserts name is string {
  if (typeof name !== "string") fail("invalid_tool_name", path);
  if (utf8Length(name) > 64 * 1024) fail("tool_name_too_large", path);
  if (!TOOL_NAME_PATTERN.test(name) || PROTOTYPE_KEYS.has(name)) {
    fail("invalid_tool_name", path);
  }
  if (reserved.has(name)) fail("reserved_tool_name", path);
}

function assertHandlerPath(
  path: unknown,
  fieldPath: string,
): asserts path is string {
  if (typeof path !== "string" || !path.startsWith("mcp/handlers/")) {
    fail("invalid_handler_path", fieldPath);
  }
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    !path.endsWith(".js")
  ) {
    fail("invalid_handler_path", fieldPath);
  }
  const segments = path.split("/");
  if (
    segments.length < 3 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !HANDLER_SEGMENT_PATTERN.test(segment),
    )
  ) {
    fail("invalid_handler_path", fieldPath);
  }
}

function parseManifestTool(
  value: unknown,
  index: number,
  input: CustomMcpCompileInput,
  reserved: ReadonlySet<string>,
  seenNames: Set<string>,
): ManifestTool {
  const path = `tools[${index}]`;
  if (!isRecord(value)) fail("invalid_tool", path);
  assertExactKeys(value, TOOL_KEYS, "invalid_tool", path);
  assertToolName(value.name, reserved, `${path}.name`);
  if (utf8Length(value.name) > input.limits.maxNameBytes) {
    fail("tool_name_too_large", `${path}.name`);
  }
  const collisionKey = normalizeToolCollisionKey(value.name);
  if (seenNames.has(collisionKey)) fail("tool_name_collision", `${path}.name`);
  seenNames.add(collisionKey);

  if (typeof value.description !== "string") {
    fail("invalid_tool", `${path}.description`);
  }
  if (utf8Length(value.description) > input.limits.maxDescriptionBytes) {
    fail("description_too_large", `${path}.description`);
  }
  const description = sanitizeUntrustedText(value.description);
  if (utf8Length(description) > input.limits.maxDescriptionBytes) {
    fail("description_too_large", `${path}.description`);
  }
  assertHandlerPath(value.handler, `${path}.handler`);
  if (
    !Object.prototype.hasOwnProperty.call(input.handlerFiles, value.handler)
  ) {
    fail("missing_handler", `${path}.handler`);
  }
  const handlerDescriptor = Object.getOwnPropertyDescriptor(
    input.handlerFiles,
    value.handler,
  );
  if (
    !handlerDescriptor ||
    !("value" in handlerDescriptor) ||
    !(handlerDescriptor.value instanceof Uint8Array)
  ) {
    fail("missing_handler", `${path}.handler`);
  }
  const handlerBytes = handlerDescriptor.value;
  if (handlerBytes.byteLength > input.limits.maxHandlerBytes) {
    fail("handler_too_large", `${path}.handler`);
  }

  if (!isRecord(value.inputSchema))
    fail("invalid_schema", `${path}.inputSchema`);
  if (
    utf8Length(JSON.stringify(value.inputSchema)) > input.limits.maxSchemaBytes
  ) {
    fail("schema_too_large", `${path}.inputSchema`);
  }
  assertSupportedJsonSchema(value.inputSchema, `${path}.inputSchema`);
  if (!Array.isArray(value.requestedCapabilities)) {
    fail("invalid_tool", `${path}.requestedCapabilities`);
  }
  const supported = new Set(input.supportedCapabilities);
  const packageRequested = new Set(input.packageRequestedCapabilities);
  const requestedCapabilities: string[] = [];
  const seenCapabilities = new Set<string>();
  for (const [
    capabilityIndex,
    capability,
  ] of value.requestedCapabilities.entries()) {
    const capabilityPath = `${path}.requestedCapabilities[${capabilityIndex}]`;
    if (typeof capability !== "string" || capability.length === 0) {
      fail("invalid_tool", capabilityPath);
    }
    if (capability.startsWith("egress.")) {
      fail("unsupported_capability", capabilityPath);
    }
    if (!supported.has(capability))
      fail("unsupported_capability", capabilityPath);
    if (!packageRequested.has(capability)) {
      fail("capability_not_requested_by_package", capabilityPath);
    }
    if (seenCapabilities.has(capability)) {
      fail("capability_collision", capabilityPath);
    }
    seenCapabilities.add(capability);
    if (expectedCapabilityEffect(capability) === null) {
      fail("unsupported_capability_effect", capabilityPath);
    }
    requestedCapabilities.push(capability);
  }
  if (value.effect !== "read" && value.effect !== "mutation") {
    fail("invalid_tool", `${path}.effect`);
  }
  if (value.approval !== "none" && value.approval !== "trusted-human") {
    fail("invalid_tool", `${path}.approval`);
  }
  if (value.effect === "mutation" && value.approval !== "trusted-human") {
    fail("trusted_approval_required", `${path}.approval`);
  }
  if (
    requestedCapabilities.some(
      (capability) => expectedCapabilityEffect(capability) === "mutation",
    ) &&
    value.effect !== "mutation"
  ) {
    fail("capability_effect_mismatch", `${path}.effect`);
  }
  return {
    name: value.name,
    description,
    handler: value.handler,
    inputSchema: value.inputSchema as JsonRecord,
    requestedCapabilities,
    effect: value.effect,
    approval: value.approval,
  };
}

function makeRegistry(
  shipletId: string,
  revisionId: string,
  packageDigest: string,
  tools: readonly CompiledCustomMcpTool[],
  verifiedHandlers?: readonly VerifiedCustomMcpHandler[],
  verifiedScope?: VerifiedCustomMcpRegistryScope,
): CompiledCustomMcpRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const registry = {
    shipletId,
    revisionId,
    packageDigest,
    tools,
    resolve(name: string) {
      return byName.get(name) ?? null;
    },
  };
  Object.defineProperty(registry, COMPILED_REGISTRY_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  if (verifiedHandlers !== undefined) {
    Object.defineProperty(registry, VERIFIED_HANDLER_BINDING, {
      value: Object.freeze(
        verifiedHandlers.map((handler) =>
          Object.freeze({
            path: handler.path,
            digest: handler.digest,
            bytes: handler.bytes.slice(),
          }),
        ),
      ),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  if (verifiedScope !== undefined) {
    Object.defineProperty(registry, VERIFIED_REGISTRY_SCOPE, {
      value: Object.freeze({ ...verifiedScope }),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(registry);
}

function verifiedHandlersForRegistry(
  registry: CompiledCustomMcpRegistry,
): readonly VerifiedCustomMcpHandler[] | null {
  const handlers = (
    registry as CompiledCustomMcpRegistry & {
      [VERIFIED_HANDLER_BINDING]?: readonly VerifiedCustomMcpHandler[];
    }
  )[VERIFIED_HANDLER_BINDING];
  return handlers ?? null;
}

function verifiedScopeForRegistry(
  registry: CompiledCustomMcpRegistry,
): VerifiedCustomMcpRegistryScope | null {
  const scope = (
    registry as CompiledCustomMcpRegistry & {
      [VERIFIED_REGISTRY_SCOPE]?: VerifiedCustomMcpRegistryScope;
    }
  )[VERIFIED_REGISTRY_SCOPE];
  return scope ?? null;
}

function isTrustedCompiledRegistry(
  registry: CompiledCustomMcpRegistry,
): boolean {
  return (
    typeof registry === "object" &&
    registry !== null &&
    (
      registry as CompiledCustomMcpRegistry & {
        [COMPILED_REGISTRY_BRAND]?: boolean;
      }
    )[COMPILED_REGISTRY_BRAND] === true
  );
}

function requireActiveRevisionResolver(
  resolver: CustomMcpActiveRevisionResolver | undefined,
): CustomMcpActiveRevisionResolver {
  if (
    typeof resolver !== "object" ||
    resolver === null ||
    typeof resolver.resolve !== "function"
  ) {
    throw new Error("active_revision_required");
  }
  return resolver;
}

function resolveActiveRevision(
  resolver: CustomMcpActiveRevisionResolver,
  shipletId: string,
): {
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
} | null {
  let active: ReturnType<CustomMcpActiveRevisionResolver["resolve"]>;
  try {
    active = resolver.resolve(shipletId);
  } catch {
    return null;
  }
  if (
    !isRecord(active) ||
    typeof active.revisionId !== "string" ||
    typeof active.packageDigest !== "string" ||
    !SCOPE_ID_PATTERN.test(active.revisionId) ||
    !PACKAGE_DIGEST_PATTERN.test(active.packageDigest) ||
    !Number.isSafeInteger(active.activationGeneration) ||
    active.activationGeneration <= 0
  ) {
    return null;
  }
  return {
    revisionId: active.revisionId,
    packageDigest: active.packageDigest,
    activationGeneration: active.activationGeneration,
  };
}

function sameActiveRevision(
  left: NonNullable<ReturnType<typeof resolveActiveRevision>>,
  right: NonNullable<ReturnType<typeof resolveActiveRevision>>,
): boolean {
  return (
    left.revisionId === right.revisionId &&
    left.packageDigest === right.packageDigest &&
    left.activationGeneration === right.activationGeneration
  );
}

function compileManifest(
  input: CustomMcpCompileInput,
): CompiledCustomMcpRegistry {
  assertLimits(input.limits);
  assertScopeId(input.shipletId, "shipletId");
  assertScopeId(input.revisionId, "revisionId");
  if (!PACKAGE_DIGEST_PATTERN.test(input.packageDigest)) {
    fail("invalid_package_digest", "packageDigest");
  }
  if (input.manifestBytes === null) {
    return makeRegistry(
      input.shipletId,
      input.revisionId,
      input.packageDigest,
      Object.freeze([]),
    );
  }
  if (!(input.manifestBytes instanceof Uint8Array)) fail("invalid_manifest");
  if (input.manifestBytes.byteLength > input.limits.maxManifestBytes) {
    fail("manifest_too_large");
  }
  const parsed = parseEncodedJson(
    input.manifestBytes,
    "invalid_manifest_encoding",
    "invalid_manifest_json",
  );
  scanJsonTree(parsed, input.limits, { nodes: 0 });
  if (!isRecord(parsed)) fail("invalid_manifest");
  assertExactKeys(parsed, MANIFEST_KEYS, "invalid_manifest", "manifest");
  if (parsed.schemaVersion !== SUPPORTED_MCP_SCHEMA_VERSION) {
    fail("unsupported_schema", "manifest.schemaVersion");
  }
  if (
    typeof parsed.runtimeCompatibility !== "string" ||
    !input.supportedRuntimeVersions.includes(parsed.runtimeCompatibility)
  ) {
    fail("unsupported_runtime", "manifest.runtimeCompatibility");
  }
  if (parsed.runtimeCompatibility !== input.packageRuntimeCompatibility) {
    fail("runtime_mismatch", "manifest.runtimeCompatibility");
  }
  if (!Array.isArray(parsed.tools)) fail("invalid_manifest", "manifest.tools");
  if (parsed.tools.length > input.limits.maxTools)
    fail("too_many_tools", "manifest.tools");
  const reserved = new Set<string>(KERNEL_MCP_TOOL_NAMES);
  const seenNames = new Set<string>();
  const tools = parsed.tools.map((tool, index) =>
    parseManifestTool(tool, index, input, reserved, seenNames),
  );
  const compiled = tools
    .map((tool): CompiledCustomMcpTool => {
      const inputSchema = cloneAndFreezeJson(tool.inputSchema) as Readonly<
        Record<string, unknown>
      >;
      const compiledTool = Object.freeze({
        name: `shiplet.${input.shipletId}.${input.revisionId}.${tool.name}`,
        localName: tool.name,
        description: SAFE_CUSTOM_MCP_DESCRIPTION,
        descriptionTrust: "trusted_kernel" as const,
        inputSchema,
        handlerPath: tool.handler,
        requestedCapabilities: Object.freeze([...tool.requestedCapabilities]),
        effect: tool.effect,
        approval: tool.approval,
      });
      QUARANTINED_TOOL_DESCRIPTIONS.set(
        compiledTool,
        Object.freeze({
          shipletId: input.shipletId,
          revisionId: input.revisionId,
          text: tool.description,
        }),
      );
      return compiledTool;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return makeRegistry(
    input.shipletId,
    input.revisionId,
    input.packageDigest,
    Object.freeze(compiled),
  );
}

export function compileCustomMcpRegistry(
  input: CustomMcpCompileInput,
): CustomMcpCompileResult {
  try {
    return Object.freeze({ ok: true, registry: compileManifest(input) });
  } catch (error) {
    if (!(error instanceof CompileFailure)) throw error;
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: error.code,
        ...(error.path === undefined ? {} : { path: error.path }),
      }),
    });
  }
}

export function normalizePortablePackageMcpManifest(input: {
  manifestBytes: Uint8Array;
  packageRuntimeCompatibility: string;
  limits: { maxManifestBytes: number; maxTools: number };
}):
  | { ok: true; manifestBytes: Uint8Array }
  | { ok: false; error: CustomMcpContractError } {
  const invalid = (code: string, path?: string) =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({ code, ...(path === undefined ? {} : { path }) }),
    });
  if (
    !(input.manifestBytes instanceof Uint8Array) ||
    !Number.isSafeInteger(input.limits?.maxManifestBytes) ||
    input.limits.maxManifestBytes <= 0 ||
    !Number.isSafeInteger(input.limits.maxTools) ||
    input.limits.maxTools <= 0 ||
    typeof input.packageRuntimeCompatibility !== "string" ||
    input.packageRuntimeCompatibility.length === 0
  ) {
    return invalid("invalid_manifest");
  }
  if (input.manifestBytes.byteLength > input.limits.maxManifestBytes) {
    return invalid("manifest_too_large");
  }
  let parsed: unknown;
  try {
    parsed = parseEncodedJson(
      input.manifestBytes,
      "invalid_manifest_encoding",
      "invalid_manifest_json",
    );
  } catch (error) {
    return invalid(
      error instanceof CompileFailure ? error.code : "invalid_manifest",
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    return invalid("invalid_manifest");
  }
  if (parsed.tools.length > input.limits.maxTools) {
    return invalid("too_many_tools", "manifest.tools");
  }
  const normalized: Record<string, unknown> = { ...parsed };
  if (normalized.runtimeCompatibility === undefined) {
    normalized.runtimeCompatibility = input.packageRuntimeCompatibility;
  }
  const tools: unknown[] = [];
  for (const [index, candidate] of parsed.tools.entries()) {
    if (!isRecord(candidate)) {
      return invalid("invalid_tool", `tools[${index}]`);
    }
    const tool: Record<string, unknown> = { ...candidate };
    if (tool.effect === undefined) {
      if (
        !Array.isArray(tool.requestedCapabilities) ||
        tool.requestedCapabilities.some(
          (capability) => typeof capability !== "string",
        )
      ) {
        return invalid("invalid_tool", `tools[${index}].requestedCapabilities`);
      }
      const effects = tool.requestedCapabilities.map((capability) =>
        expectedCapabilityEffect(capability as string),
      );
      if (effects.some((effect) => effect === null)) {
        return invalid(
          "unsupported_capability_effect",
          `tools[${index}].requestedCapabilities`,
        );
      }
      tool.effect = effects.includes("mutation") ? "mutation" : "read";
    }
    tools.push(tool);
  }
  normalized.tools = tools;
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = new TextEncoder().encode(JSON.stringify(normalized));
  } catch {
    return invalid("invalid_manifest");
  }
  if (manifestBytes.byteLength > input.limits.maxManifestBytes) {
    return invalid("manifest_too_large");
  }
  return Object.freeze({ ok: true as const, manifestBytes });
}

function portablePackageFileBytes(file: ShipletPackageFile): Uint8Array {
  if (file.encoding === "utf8") {
    return new TextEncoder().encode(file.content);
  }
  try {
    const binary = atob(file.content);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TypeError("Invalid verified package file encoding");
  }
}

async function digestVerifiedHandlerSet(
  handlers: readonly VerifiedCustomMcpHandler[],
): Promise<string> {
  const canonical = JSON.stringify(
    [...handlers]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((handler) => [handler.path, handler.digest]),
  );
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

async function digestHandlerBytes(bytes: Uint8Array): Promise<string> {
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function compileVerifiedCustomMcpRegistryFiles(input: {
  activeRevision: {
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  };
  manifestBytes: Uint8Array;
  packageRuntimeCompatibility: string;
  packageRequestedCapabilities: readonly string[];
  handlerFiles: Readonly<Record<string, Uint8Array>>;
  handlerDigests: Readonly<Record<string, string>>;
  supportedRuntimeVersions: readonly string[];
  supportedCapabilities: readonly string[];
  limits: CustomMcpLimits;
}): Promise<CustomMcpCompileResult> {
  const invalid = (code: string, path?: string): CustomMcpCompileResult =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({ code, ...(path === undefined ? {} : { path }) }),
    });
  if (
    !isRecord(input.activeRevision) ||
    !SCOPE_ID_PATTERN.test(input.activeRevision.shipletId) ||
    !SCOPE_ID_PATTERN.test(input.activeRevision.revisionId) ||
    !PACKAGE_DIGEST_PATTERN.test(input.activeRevision.packageDigest) ||
    !Number.isSafeInteger(input.activeRevision.activationGeneration) ||
    input.activeRevision.activationGeneration <= 0 ||
    !(input.manifestBytes instanceof Uint8Array)
  ) {
    return invalid("invalid_active_revision");
  }
  const normalized = normalizePortablePackageMcpManifest({
    manifestBytes: input.manifestBytes,
    packageRuntimeCompatibility: input.packageRuntimeCompatibility,
    limits: {
      maxManifestBytes: input.limits.maxManifestBytes,
      maxTools: input.limits.maxTools,
    },
  });
  if (!normalized.ok) return normalized;
  const compiled = compileCustomMcpRegistry({
    manifestBytes: normalized.manifestBytes,
    shipletId: input.activeRevision.shipletId,
    revisionId: input.activeRevision.revisionId,
    packageDigest: input.activeRevision.packageDigest,
    packageRuntimeCompatibility: input.packageRuntimeCompatibility,
    packageRequestedCapabilities: input.packageRequestedCapabilities,
    handlerFiles: input.handlerFiles,
    supportedRuntimeVersions: input.supportedRuntimeVersions,
    supportedCapabilities: input.supportedCapabilities,
    reservedKernelTools: KERNEL_MCP_TOOL_NAMES,
    limits: input.limits,
  });
  if (!compiled.ok) return compiled;
  const verifiedHandlers: VerifiedCustomMcpHandler[] = [];
  for (const handlerPath of new Set(
    compiled.registry.tools.map((tool) => tool.handlerPath),
  )) {
    const bytes = input.handlerFiles[handlerPath];
    const expectedDigest = input.handlerDigests[handlerPath];
    if (!(bytes instanceof Uint8Array)) {
      return invalid("missing_handler", handlerPath);
    }
    if (
      typeof expectedDigest !== "string" ||
      !HANDLER_DIGEST_PATTERN.test(expectedDigest) ||
      (await digestHandlerBytes(bytes)) !== expectedDigest
    ) {
      return invalid("handler_digest_mismatch", handlerPath);
    }
    verifiedHandlers.push({
      path: handlerPath,
      digest: expectedDigest,
      bytes,
    });
  }
  const handlerSetDigest = await digestVerifiedHandlerSet(verifiedHandlers);
  return Object.freeze({
    ok: true as const,
    registry: makeRegistry(
      compiled.registry.shipletId,
      compiled.registry.revisionId,
      compiled.registry.packageDigest,
      compiled.registry.tools,
      Object.freeze(verifiedHandlers),
      Object.freeze({
        activationGeneration: input.activeRevision.activationGeneration,
        handlerSetDigest,
      }),
    ),
  });
}

export async function compileVerifiedCustomMcpRegistry(input: {
  packageEnvelope: unknown;
  activeRevision: {
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  };
  supportedRuntimeVersions: readonly string[];
  supportedCapabilities: readonly string[];
  limits: CustomMcpLimits;
}): Promise<CustomMcpCompileResult> {
  const invalid = (code: string, path?: string): CustomMcpCompileResult =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({ code, ...(path === undefined ? {} : { path }) }),
    });
  if (
    !isRecord(input.activeRevision) ||
    !SCOPE_ID_PATTERN.test(input.activeRevision.shipletId) ||
    !SCOPE_ID_PATTERN.test(input.activeRevision.revisionId) ||
    !PACKAGE_DIGEST_PATTERN.test(input.activeRevision.packageDigest) ||
    !Number.isSafeInteger(input.activeRevision.activationGeneration) ||
    input.activeRevision.activationGeneration <= 0
  ) {
    return invalid("invalid_active_revision");
  }
  let verifiedPackage: ValidatedShipletPackage;
  let computedDigest: string;
  try {
    verifiedPackage = await parseShipletPackage(input.packageEnvelope);
    computedDigest = `sha256:${await digestShipletPackageContent(
      verifiedPackage,
    )}`;
  } catch {
    return invalid("invalid_package");
  }
  if (computedDigest !== input.activeRevision.packageDigest) {
    return invalid("package_digest_mismatch");
  }
  const manifestPath = verifiedPackage.manifest.entrypoints.mcp;
  const manifestFile = verifiedPackage.files.find(
    (file) => file.path === manifestPath,
  );
  if (manifestFile === undefined) {
    return invalid("missing_manifest", manifestPath);
  }
  const handlerFiles: Record<string, Uint8Array> = Object.create(
    null,
  ) as Record<string, Uint8Array>;
  const handlerDigests: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const file of verifiedPackage.files) {
    if (file.path.startsWith("mcp/handlers/") && file.path.endsWith(".js")) {
      handlerFiles[file.path] = portablePackageFileBytes(file);
      handlerDigests[file.path] = file.sha256;
    }
  }
  return compileVerifiedCustomMcpRegistryFiles({
    activeRevision: input.activeRevision,
    manifestBytes: portablePackageFileBytes(manifestFile),
    packageRuntimeCompatibility: verifiedPackage.manifest.runtimeCompatibility,
    packageRequestedCapabilities:
      verifiedPackage.manifest.requestedCapabilities,
    handlerFiles: Object.freeze(handlerFiles),
    handlerDigests: Object.freeze(handlerDigests),
    supportedRuntimeVersions: input.supportedRuntimeVersions,
    supportedCapabilities: input.supportedCapabilities,
    limits: input.limits,
  });
}

export function createCustomMcpToolCatalog(input: {
  kernelTools: readonly KernelMcpTool[];
  customRegistries: readonly CompiledCustomMcpRegistry[];
  activeRevisionResolver: CustomMcpActiveRevisionResolver;
  trustedActor: CapabilityActor;
  authorizeDiscovery(input: {
    actor: CapabilityActor;
    shipletId: string;
    revisionId: string;
  }): boolean;
}): CustomMcpToolCatalog {
  const activeRevisionResolver = requireActiveRevisionResolver(
    input.activeRevisionResolver,
  );
  const registryKeys = new Set<string>();
  const revisionsByShiplet = new Map<string, string>();
  const customNames = new Set<string>();
  const activeSnapshots = new Map<
    CompiledCustomMcpRegistry,
    NonNullable<ReturnType<typeof resolveActiveRevision>>
  >();
  const discoveryActor = stableActor(input.trustedActor);
  if (
    discoveryActor === null ||
    typeof input.authorizeDiscovery !== "function"
  ) {
    throw new Error("discovery_authorization_required");
  }
  const authorizedRegistries: CompiledCustomMcpRegistry[] = [];
  for (const registry of input.customRegistries) {
    if (!isTrustedCompiledRegistry(registry)) {
      throw new Error("untrusted_registry");
    }
    let authorized = false;
    try {
      authorized = input.authorizeDiscovery(
        Object.freeze({
          actor: discoveryActor,
          shipletId: registry.shipletId,
          revisionId: registry.revisionId,
        }),
      );
    } catch {
      authorized = false;
    }
    if (!authorized) continue;
    const active = resolveActiveRevision(
      activeRevisionResolver,
      registry.shipletId,
    );
    if (
      active === null ||
      active.revisionId !== registry.revisionId ||
      active.packageDigest !== registry.packageDigest
    ) {
      throw new Error("stale_registry");
    }
    const verifiedScope = verifiedScopeForRegistry(registry);
    if (
      verifiedScope !== null &&
      verifiedScope.activationGeneration !== active.activationGeneration
    ) {
      throw new Error("stale_registry");
    }
    activeSnapshots.set(registry, active);
    const key = `${registry.shipletId}:${registry.revisionId}`;
    if (registryKeys.has(key)) throw new Error("duplicate_registry");
    registryKeys.add(key);
    const existingRevision = revisionsByShiplet.get(registry.shipletId);
    if (
      existingRevision !== undefined &&
      existingRevision !== registry.revisionId
    ) {
      throw new Error("stale_registry");
    }
    revisionsByShiplet.set(registry.shipletId, registry.revisionId);
    for (const tool of registry.tools) {
      if (customNames.has(tool.name)) throw new Error("duplicate_registry");
      customNames.add(tool.name);
    }
    authorizedRegistries.push(registry);
  }
  const kernelTools = Object.freeze([...input.kernelTools]);
  const customTools = Object.freeze(
    authorizedRegistries
      .flatMap((registry) => [...registry.tools])
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
  const tools = Object.freeze([...kernelTools, ...customTools]);
  const assertFresh = () => {
    for (const registry of authorizedRegistries) {
      const snapshot = activeSnapshots.get(registry);
      const active = resolveActiveRevision(
        activeRevisionResolver,
        registry.shipletId,
      );
      if (
        snapshot === undefined ||
        active === null ||
        !sameActiveRevision(snapshot, active)
      ) {
        throw new Error("stale_registry");
      }
    }
  };
  const catalog = Object.freeze({
    get kernelTools() {
      assertFresh();
      return kernelTools;
    },
    get customTools() {
      assertFresh();
      return customTools;
    },
    get tools() {
      assertFresh();
      return tools;
    },
  });
  TRUSTED_CUSTOM_MCP_CATALOGS.add(catalog);
  return catalog;
}

export function createCustomMcpModelBoundary(input: { maxTextBytes: number }) {
  if (!Number.isSafeInteger(input?.maxTextBytes) || input.maxTextBytes <= 0) {
    throw new TypeError("Invalid custom MCP model boundary limits");
  }
  const boundedText = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const sanitized = sanitizeUntrustedText(value);
    return utf8Length(sanitized) <= input.maxTextBytes ? sanitized : null;
  };
  const invalid = () =>
    Object.freeze({
      ok: false as const,
      code: "invalid_model_projection" as const,
    });
  return Object.freeze({
    projectCatalog(catalog: CustomMcpToolCatalog) {
      if (
        typeof catalog !== "object" ||
        catalog === null ||
        !TRUSTED_CUSTOM_MCP_CATALOGS.has(catalog)
      ) {
        return invalid();
      }
      let catalogTools: readonly (KernelMcpTool | CompiledCustomMcpTool)[];
      try {
        catalogTools = catalog.tools;
      } catch {
        return invalid();
      }
      const tools: Readonly<Record<string, unknown>>[] = [];
      for (const tool of catalogTools) {
        const name = boundedText(tool.name);
        const description = boundedText(tool.description);
        if (name === null || description === null) {
          return Object.freeze({
            ok: false as const,
            code: "model_text_too_large" as const,
          });
        }
        if ("trust" in tool) {
          if (tool.trust !== "trusted_kernel") return invalid();
          tools.push(
            Object.freeze({
              name,
              description,
              inputSchema: tool.inputSchema,
              trust: "trusted_kernel" as const,
            }),
          );
          continue;
        }
        if (
          tool.descriptionTrust !== "trusted_kernel" ||
          !QUARANTINED_TOOL_DESCRIPTIONS.has(tool)
        ) {
          return invalid();
        }
        tools.push(
          Object.freeze({
            name,
            description,
            inputSchema: tool.inputSchema,
            descriptionTrust: "trusted_kernel" as const,
          }),
        );
      }
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({ tools: Object.freeze(tools) }),
      });
    },
    projectResult(
      result: Extract<CustomMcpExecutorResult, { ok: true }>["value"],
    ) {
      if (
        typeof result !== "object" ||
        result === null ||
        !QUARANTINED_CUSTOM_MCP_RESULTS.has(result) ||
        result.trust !== "trusted_kernel"
      ) {
        return invalid();
      }
      const content: Readonly<{ type: "text"; text: string }>[] = [];
      for (const entry of result.content) {
        if (entry.type !== "text") return invalid();
        const text = boundedText(entry.text);
        if (text === null) {
          return Object.freeze({
            ok: false as const,
            code: "model_text_too_large" as const,
          });
        }
        content.push(Object.freeze({ type: "text" as const, text }));
      }
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          content: Object.freeze(content),
          _meta: Object.freeze({
            trust: "trusted_kernel" as const,
            quarantine: result.quarantine,
          }),
        }),
      });
    },
  });
}

export function createCustomMcpWireSerializer(input: {
  maxPayloadBytes: number;
  maxTextBytes: number;
}) {
  if (
    !Number.isSafeInteger(input.maxPayloadBytes) ||
    input.maxPayloadBytes <= 0
  ) {
    throw new TypeError("Invalid custom MCP wire limits");
  }
  const boundary = createCustomMcpModelBoundary({
    maxTextBytes: input.maxTextBytes,
  });
  const encode = (
    value: unknown,
  ):
    | { ok: true; bytes: Uint8Array }
    | {
        ok: false;
        code: "wire_payload_too_large" | "invalid_wire_payload";
      } => {
    let bytes: Uint8Array;
    try {
      bytes = new TextEncoder().encode(JSON.stringify(value));
    } catch {
      return { ok: false, code: "invalid_wire_payload" };
    }
    return bytes.byteLength <= input.maxPayloadBytes
      ? { ok: true, bytes }
      : { ok: false, code: "wire_payload_too_large" };
  };
  const mapProjectionFailure = (code: string) => ({
    ok: false as const,
    code:
      code === "model_text_too_large"
        ? ("wire_text_too_large" as const)
        : ("invalid_wire_payload" as const),
  });
  return Object.freeze({
    serializeTools(catalog: CustomMcpToolCatalog) {
      const projected = boundary.projectCatalog(catalog);
      return projected.ok
        ? encode(projected.value)
        : mapProjectionFailure(projected.code);
    },
    serializeResult(
      result: Extract<CustomMcpExecutorResult, { ok: true }>["value"],
    ) {
      const projected = boundary.projectResult(result);
      return projected.ok
        ? encode(projected.value)
        : mapProjectionFailure(projected.code);
    },
  });
}

export class CustomMcpRuntimeUnavailableError extends Error {
  readonly code = "runtime_unavailable";

  constructor() {
    super("runtime_unavailable");
    this.name = "CustomMcpRuntimeUnavailableError";
  }
}

class CustomMcpRuntimeExecutionError extends Error {
  constructor() {
    super("runtime_failed");
    this.name = "CustomMcpRuntimeExecutionError";
  }
}

export function requireBoundCustomMcpCapabilityBroker(input: {
  broker: CapabilityBroker;
}): CustomMcpBoundCapabilityBroker {
  if (
    typeof input?.broker !== "object" ||
    input.broker === null ||
    typeof input.broker.invoke !== "function" ||
    typeof input.broker.invokeBound !== "function"
  ) {
    throw new TypeError("Bound capability broker required");
  }
  return input.broker;
}

export interface SerializedCustomMcpRuntimeTransport {
  terminationGuarantee: "hard";
  invoke(
    requestBytes: Uint8Array,
    requestCapability?: (requestBytes: Uint8Array) => Promise<Uint8Array>,
    invocationId?: string,
  ): Promise<Uint8Array>;
  cancel(input: {
    invocationId: string;
    reason: "deadline_exceeded";
  }): void | Promise<void>;
}

export interface VerifiedCustomMcpRuntimeIsolationTransport {
  invoke(input: {
    invocationId: string;
    requestBytes: Uint8Array;
    requestCapability?: (requestBytes: Uint8Array) => Promise<Uint8Array>;
  }): Promise<Uint8Array>;
  cancel(input: {
    invocationId: string;
    reason: "deadline_exceeded";
  }): void | Promise<void>;
}

export interface CustomMcpRuntimeIsolationPolicy {
  schemaVersion: "shiplet.runtime-isolation-policy/v1";
  hardTermination: "enforced";
  maxCpuMs: number;
  maxMemoryBytes: number;
  maxSubrequests: number;
  outboundNetwork: "deny_by_default";
  ambientBindings: "none";
  ambientSecrets: "none";
}

export interface CustomMcpRuntimeIsolationBinding {
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
  handlerSetDigest: string;
  handlers: readonly {
    path: string;
    digest: string;
    bytes: Uint8Array;
  }[];
  policy: CustomMcpRuntimeIsolationPolicy;
}

export interface CustomMcpRuntimeIsolationAttestation {
  schemaVersion: "shiplet.runtime-isolation-attestation/v1";
  attestationId: string;
}

/**
 * Kernel-held issuer. Arbitrary package code and runtime providers must never
 * receive this authority; issuance happens only after the platform isolation
 * implementation has verified that the exact binding and policy are enforced.
 */
export interface CustomMcpRuntimeIsolationAttestationAuthority {
  issue(
    binding: CustomMcpRuntimeIsolationBinding,
  ): CustomMcpRuntimeIsolationAttestation;
}

export interface VerifiedCustomMcpRuntimeIsolationBinding {
  transport: VerifiedCustomMcpRuntimeIsolationTransport;
  attestation: CustomMcpRuntimeIsolationAttestation;
}

export interface VerifiedCustomMcpRuntimeIsolation {
  bind(
    input: CustomMcpRuntimeIsolationBinding,
  ): VerifiedCustomMcpRuntimeIsolationBinding;
}

function stableRuntimeIsolationPolicy(
  value: unknown,
): CustomMcpRuntimeIsolationPolicy | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 8 ||
    value.schemaVersion !== "shiplet.runtime-isolation-policy/v1" ||
    value.hardTermination !== "enforced" ||
    !Number.isSafeInteger(value.maxCpuMs) ||
    (value.maxCpuMs as number) <= 0 ||
    (value.maxCpuMs as number) > MAX_ATTESTED_RUNTIME_CPU_MS ||
    !Number.isSafeInteger(value.maxMemoryBytes) ||
    (value.maxMemoryBytes as number) <= 0 ||
    (value.maxMemoryBytes as number) > MAX_ATTESTED_RUNTIME_MEMORY_BYTES ||
    !Number.isSafeInteger(value.maxSubrequests) ||
    (value.maxSubrequests as number) <= 0 ||
    (value.maxSubrequests as number) > MAX_ATTESTED_RUNTIME_SUBREQUESTS ||
    value.outboundNetwork !== "deny_by_default" ||
    value.ambientBindings !== "none" ||
    value.ambientSecrets !== "none"
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: "shiplet.runtime-isolation-policy/v1" as const,
    hardTermination: "enforced" as const,
    maxCpuMs: value.maxCpuMs as number,
    maxMemoryBytes: value.maxMemoryBytes as number,
    maxSubrequests: value.maxSubrequests as number,
    outboundNetwork: "deny_by_default" as const,
    ambientBindings: "none" as const,
    ambientSecrets: "none" as const,
  });
}

function runtimeIsolationAttestationClaims(
  value: unknown,
): RuntimeIsolationAttestationClaims | null {
  if (
    !isRecord(value) ||
    !SCOPE_ID_PATTERN.test(String(value.shipletId ?? "")) ||
    !SCOPE_ID_PATTERN.test(String(value.revisionId ?? "")) ||
    !PACKAGE_DIGEST_PATTERN.test(String(value.packageDigest ?? "")) ||
    !Number.isSafeInteger(value.activationGeneration) ||
    (value.activationGeneration as number) <= 0 ||
    !PACKAGE_DIGEST_PATTERN.test(String(value.handlerSetDigest ?? "")) ||
    !Array.isArray(value.handlers)
  ) {
    return null;
  }
  const policy = stableRuntimeIsolationPolicy(value.policy);
  if (policy === null) return null;
  const handlers: { path: string; digest: string }[] = [];
  for (const handler of value.handlers) {
    if (
      !isRecord(handler) ||
      typeof handler.path !== "string" ||
      !handler.path
        .split("/")
        .every((part) => HANDLER_SEGMENT_PATTERN.test(part)) ||
      typeof handler.digest !== "string" ||
      !HANDLER_DIGEST_PATTERN.test(handler.digest) ||
      !(handler.bytes instanceof Uint8Array)
    ) {
      return null;
    }
    handlers.push(
      Object.freeze({ path: handler.path, digest: handler.digest }),
    );
  }
  if (handlers.length === 0) return null;
  return Object.freeze({
    shipletId: value.shipletId as string,
    revisionId: value.revisionId as string,
    packageDigest: value.packageDigest as string,
    activationGeneration: value.activationGeneration as number,
    handlerSetDigest: value.handlerSetDigest as string,
    handlers: Object.freeze(handlers),
    policy,
  });
}

function sameRuntimeIsolationClaims(
  left: RuntimeIsolationAttestationClaims,
  right: RuntimeIsolationAttestationClaims,
): boolean {
  return (
    left.shipletId === right.shipletId &&
    left.revisionId === right.revisionId &&
    left.packageDigest === right.packageDigest &&
    left.activationGeneration === right.activationGeneration &&
    left.handlerSetDigest === right.handlerSetDigest &&
    left.handlers.length === right.handlers.length &&
    left.handlers.every(
      (handler, index) =>
        handler.path === right.handlers[index]?.path &&
        handler.digest === right.handlers[index]?.digest,
    ) &&
    left.policy.schemaVersion === right.policy.schemaVersion &&
    left.policy.hardTermination === right.policy.hardTermination &&
    left.policy.maxCpuMs === right.policy.maxCpuMs &&
    left.policy.maxMemoryBytes === right.policy.maxMemoryBytes &&
    left.policy.maxSubrequests === right.policy.maxSubrequests &&
    left.policy.outboundNetwork === right.policy.outboundNetwork &&
    left.policy.ambientBindings === right.policy.ambientBindings &&
    left.policy.ambientSecrets === right.policy.ambientSecrets
  );
}

export function createCustomMcpRuntimeIsolationAttestationAuthority(): CustomMcpRuntimeIsolationAttestationAuthority {
  const authority: CustomMcpRuntimeIsolationAttestationAuthority = {
    issue(binding) {
      const claims = runtimeIsolationAttestationClaims(binding);
      if (claims === null) {
        throw new TypeError("invalid_runtime_isolation_attestation_claims");
      }
      const attestation = Object.freeze({
        schemaVersion: "shiplet.runtime-isolation-attestation/v1" as const,
        attestationId: `runtime_attestation_${crypto.randomUUID()}`,
      });
      RUNTIME_ISOLATION_ATTESTATIONS.set(attestation, {
        authority,
        claims,
      });
      return attestation;
    },
  };
  Object.freeze(authority);
  RUNTIME_ISOLATION_AUTHORITY_VERIFIERS.set(
    authority,
    (attestation, expected) => {
      if (!isRecord(attestation)) return false;
      const recorded = RUNTIME_ISOLATION_ATTESTATIONS.get(attestation);
      const expectedClaims = runtimeIsolationAttestationClaims(expected);
      return (
        recorded !== undefined &&
        recorded.authority === authority &&
        expectedClaims !== null &&
        sameRuntimeIsolationClaims(recorded.claims, expectedClaims)
      );
    },
  );
  return authority;
}

type SerializedRuntimeBinding = {
  shipletId: string | null;
  packageDigest: string;
  revisionId: string;
  activationGeneration: number | null;
  handlerSetDigest: string | null;
  verifiedIsolation: boolean;
};

function createSerializedCustomMcpRuntimeAdapterInternal(
  input: {
    packageDigest: string;
    revisionId: string;
    limits: { maxRequestBytes: number; maxResponseBytes: number };
    transport: SerializedCustomMcpRuntimeTransport;
  },
  verifiedIsolation: boolean,
  verifiedScope?: {
    shipletId: string;
    activationGeneration: number;
    handlerSetDigest: string;
  },
): CustomMcpRuntimeAdapter {
  if (
    input.transport?.terminationGuarantee !== "hard" ||
    typeof input.transport.cancel !== "function"
  ) {
    throw new TypeError("hard_termination_required");
  }
  if (
    !PACKAGE_DIGEST_PATTERN.test(input.packageDigest) ||
    !Number.isSafeInteger(input.limits.maxRequestBytes) ||
    input.limits.maxRequestBytes <= 0 ||
    !Number.isSafeInteger(input.limits.maxResponseBytes) ||
    input.limits.maxResponseBytes <= 0 ||
    typeof input.transport?.invoke !== "function"
  ) {
    throw new TypeError("Invalid serialized custom MCP runtime adapter");
  }
  const packageDigest = input.packageDigest;
  const revisionId = input.revisionId;
  const adapter: CustomMcpRuntimeAdapter & {
    [SERIALIZED_RUNTIME_BINDING]?: SerializedRuntimeBinding;
  } = {
    async invoke(invocation: IsolatedCustomMcpRuntimeInvocation) {
      if (
        invocation.revisionId !== revisionId ||
        (verifiedScope !== undefined &&
          invocation.shipletId !== verifiedScope.shipletId)
      ) {
        throw new CustomMcpRuntimeUnavailableError();
      }
      let requestBytes: Uint8Array;
      try {
        requestBytes = new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: "shiplet.runtime.invocation/v1",
            packageDigest,
            revisionId,
            shipletId: invocation.shipletId,
            toolName: invocation.toolName,
            requestId: invocation.requestId,
            handlerPath: invocation.handlerPath,
            actor: invocation.actor,
            input: invocation.input,
            declaredCapabilities: invocation.declaredCapabilities,
          }),
        );
      } catch {
        throw new CustomMcpRuntimeUnavailableError();
      }
      if (requestBytes.byteLength > input.limits.maxRequestBytes) {
        throw new CustomMcpRuntimeUnavailableError();
      }
      const requestCapability = async (
        capabilityRequestBytes: Uint8Array,
      ): Promise<Uint8Array> => {
        if (
          !(capabilityRequestBytes instanceof Uint8Array) ||
          capabilityRequestBytes.byteLength > input.limits.maxRequestBytes
        ) {
          return new TextEncoder().encode(
            JSON.stringify({ ok: false, code: "capability_denied" }),
          );
        }
        try {
          const parsed = parseEncodedJson(
            capabilityRequestBytes,
            "invalid_runtime_request",
            "invalid_runtime_request",
          );
          if (
            !isRecord(parsed) ||
            Object.keys(parsed).some(
              (key) =>
                ![
                  "schemaVersion",
                  "capability",
                  "resource",
                  "input",
                  "effect",
                ].includes(key),
            ) ||
            parsed.schemaVersion !== "shiplet.runtime.capability-request/v1" ||
            typeof parsed.capability !== "string" ||
            typeof parsed.resource !== "string" ||
            (parsed.effect !== undefined &&
              parsed.effect !== "read" &&
              parsed.effect !== "mutation")
          ) {
            throw new Error("invalid_runtime_request");
          }
          const result = await invocation.requestCapability({
            capability: parsed.capability,
            resource: parsed.resource,
            input: parsed.input,
            ...(parsed.effect === undefined ? {} : { effect: parsed.effect }),
          });
          const encoded = new TextEncoder().encode(JSON.stringify(result));
          return encoded.byteLength <= input.limits.maxResponseBytes
            ? encoded
            : new TextEncoder().encode(
                JSON.stringify({ ok: false, code: "capability_denied" }),
              );
        } catch {
          return new TextEncoder().encode(
            JSON.stringify({ ok: false, code: "capability_denied" }),
          );
        }
      };
      let response: Uint8Array;
      try {
        response = await input.transport.invoke(
          requestBytes.slice(),
          requestCapability,
          invocation.requestId,
        );
      } catch {
        throw new CustomMcpRuntimeUnavailableError();
      }
      if (
        !(response instanceof Uint8Array) ||
        response.byteLength > input.limits.maxResponseBytes
      ) {
        throw new CustomMcpRuntimeUnavailableError();
      }
      try {
        const runtimeError = parseEncodedJson(
          response,
          "invalid_runtime_response",
          "invalid_runtime_response",
        );
        if (
          isRecord(runtimeError) &&
          Object.keys(runtimeError).length === 2 &&
          runtimeError.schemaVersion === "shiplet.runtime.error/v1" &&
          runtimeError.code === "handler_failed"
        ) {
          throw new CustomMcpRuntimeExecutionError();
        }
      } catch (error) {
        if (error instanceof CustomMcpRuntimeExecutionError) throw error;
      }
      return response.slice();
    },
    cancel(cancellation) {
      return input.transport.cancel(cancellation);
    },
  };
  Object.defineProperty(adapter, SERIALIZED_RUNTIME_BINDING, {
    value: Object.freeze({
      shipletId: verifiedScope?.shipletId ?? null,
      packageDigest,
      revisionId,
      activationGeneration: verifiedScope?.activationGeneration ?? null,
      handlerSetDigest: verifiedScope?.handlerSetDigest ?? null,
      verifiedIsolation,
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(adapter);
}

export function createSerializedCustomMcpRuntimeAdapter(input: {
  packageDigest: string;
  revisionId: string;
  limits: { maxRequestBytes: number; maxResponseBytes: number };
  transport: SerializedCustomMcpRuntimeTransport;
}): CustomMcpRuntimeAdapter {
  return createSerializedCustomMcpRuntimeAdapterInternal(input, false);
}

function unavailableCustomMcpRuntimeAdapter(input: {
  packageDigest: string;
  revisionId: string;
  limits: { maxRequestBytes: number; maxResponseBytes: number };
}): CustomMcpRuntimeAdapter {
  return createSerializedCustomMcpRuntimeAdapterInternal(
    {
      ...input,
      transport: {
        terminationGuarantee: "hard",
        async invoke() {
          throw new CustomMcpRuntimeUnavailableError();
        },
        cancel() {},
      },
    },
    false,
  );
}

export function createVerifiedCustomMcpRuntimeAdapter(input: {
  registry: CompiledCustomMcpRegistry;
  limits: { maxRequestBytes: number; maxResponseBytes: number };
  policy?: CustomMcpRuntimeIsolationPolicy;
  attestationAuthority?: CustomMcpRuntimeIsolationAttestationAuthority;
  isolation?: VerifiedCustomMcpRuntimeIsolation;
}): CustomMcpRuntimeAdapter {
  const unavailable = () =>
    unavailableCustomMcpRuntimeAdapter({
      packageDigest: input.registry?.packageDigest ?? "",
      revisionId: input.registry?.revisionId ?? "",
      limits: input.limits,
    });
  if (!isTrustedCompiledRegistry(input.registry)) {
    throw new TypeError("verified_registry_required");
  }
  const handlers = verifiedHandlersForRegistry(input.registry);
  const verifiedScope = verifiedScopeForRegistry(input.registry);
  const policy = stableRuntimeIsolationPolicy(input.policy);
  const verifyAttestation =
    typeof input.attestationAuthority === "object" &&
    input.attestationAuthority !== null
      ? RUNTIME_ISOLATION_AUTHORITY_VERIFIERS.get(input.attestationAuthority)
      : undefined;
  if (
    handlers === null ||
    verifiedScope === null ||
    policy === null ||
    verifyAttestation === undefined ||
    typeof input.isolation?.bind !== "function"
  ) {
    return unavailable();
  }
  const binding: CustomMcpRuntimeIsolationBinding = Object.freeze({
    shipletId: input.registry.shipletId,
    revisionId: input.registry.revisionId,
    packageDigest: input.registry.packageDigest,
    activationGeneration: verifiedScope.activationGeneration,
    handlerSetDigest: verifiedScope.handlerSetDigest,
    handlers: Object.freeze(
      handlers.map((handler) =>
        Object.freeze({
          path: handler.path,
          digest: handler.digest,
          bytes: handler.bytes.slice(),
        }),
      ),
    ),
    policy,
  });
  let isolatedBinding: VerifiedCustomMcpRuntimeIsolationBinding;
  try {
    isolatedBinding = input.isolation.bind(binding);
  } catch {
    return unavailable();
  }
  let transport: VerifiedCustomMcpRuntimeIsolationTransport;
  try {
    if (
      !isRecord(isolatedBinding) ||
      Object.keys(isolatedBinding).length !== 2
    ) {
      return unavailable();
    }
    const transportDescriptor = Object.getOwnPropertyDescriptor(
      isolatedBinding,
      "transport",
    );
    const attestationDescriptor = Object.getOwnPropertyDescriptor(
      isolatedBinding,
      "attestation",
    );
    if (
      transportDescriptor === undefined ||
      !("value" in transportDescriptor) ||
      attestationDescriptor === undefined ||
      !("value" in attestationDescriptor) ||
      !verifyAttestation(attestationDescriptor.value, binding)
    ) {
      return unavailable();
    }
    transport =
      transportDescriptor.value as VerifiedCustomMcpRuntimeIsolationTransport;
  } catch {
    return unavailable();
  }
  if (
    !isRecord(transport) ||
    typeof transport?.invoke !== "function" ||
    typeof transport.cancel !== "function"
  ) {
    return unavailable();
  }
  return createSerializedCustomMcpRuntimeAdapterInternal(
    {
      packageDigest: input.registry.packageDigest,
      revisionId: input.registry.revisionId,
      limits: input.limits,
      transport: {
        terminationGuarantee: "hard",
        invoke(requestBytes, requestCapability, invocationId) {
          if (typeof invocationId !== "string" || invocationId.length === 0) {
            throw new CustomMcpRuntimeUnavailableError();
          }
          return transport.invoke(
            Object.freeze({
              invocationId,
              requestBytes: requestBytes.slice(),
              ...(requestCapability === undefined ? {} : { requestCapability }),
            }),
          );
        },
        cancel(cancellation) {
          return transport.cancel(Object.freeze({ ...cancellation }));
        },
      },
    },
    true,
    {
      shipletId: input.registry.shipletId,
      activationGeneration: verifiedScope.activationGeneration,
      handlerSetDigest: verifiedScope.handlerSetDigest,
    },
  );
}

function stableActor(actor: CapabilityActor): CapabilityActor | null {
  if (
    typeof actor !== "object" ||
    actor === null ||
    (actor.kind !== "human" &&
      actor.kind !== "agent" &&
      actor.kind !== "shiplet" &&
      actor.kind !== "system") ||
    typeof actor.id !== "string" ||
    actor.id.length === 0
  ) {
    return null;
  }
  return Object.freeze({ kind: actor.kind, id: actor.id });
}

function stableInputJson(
  bytes: Uint8Array,
  limits: CustomMcpLimits,
): JsonValue {
  const parsed = parseEncodedJson(
    bytes,
    "invalid_input_encoding",
    "invalid_input_json",
  );
  try {
    scanJsonTree(parsed, limits, { nodes: 0 });
  } catch (error) {
    if (error instanceof CompileFailure) fail("invalid_input");
    throw error;
  }
  return cloneAndFreezeJson(parsed as JsonValue);
}

function stableRuntimeCapabilityRequest(
  request: CustomMcpRuntimeCapabilityRequest,
  limits: CustomMcpLimits,
): {
  capability: string;
  resource: string;
  input: JsonValue;
  effect?: "read" | "mutation";
} | null {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.capability !== "string" ||
    request.capability.length === 0 ||
    typeof request.resource !== "string" ||
    request.resource.length === 0 ||
    (request.effect !== undefined &&
      request.effect !== "read" &&
      request.effect !== "mutation")
  ) {
    return null;
  }
  let input: JsonValue;
  try {
    scanJsonTree(request.input, limits, { nodes: 0 });
    input = cloneAndFreezeJson(request.input as JsonValue);
  } catch {
    return null;
  }
  return Object.freeze({
    capability: request.capability,
    resource: request.resource,
    input,
    ...(request.effect === undefined ? {} : { effect: request.effect }),
  });
}

function stableCapabilityDispatchOutcome(
  value: unknown,
): CustomMcpCapabilityDispatchOutcome | null {
  if (
    !isRecord(value) ||
    typeof value.journalId !== "string" ||
    value.journalId.length === 0
  ) {
    return null;
  }
  if (
    value.status === "committed" &&
    Object.keys(value).every((key) =>
      ["status", "journalId", "value"].includes(key),
    ) &&
    Object.hasOwn(value, "value")
  ) {
    return Object.freeze({
      status: "committed" as const,
      journalId: value.journalId,
      value: value.value,
    });
  }
  if (
    (value.status === "aborted" ||
      value.status === "reconciliation_required") &&
    Object.keys(value).length === 2
  ) {
    return Object.freeze({
      status: value.status,
      journalId: value.journalId,
    });
  }
  return null;
}

type StableTrustedChildApprovalResolution =
  | { status: "approved" }
  | { status: "denied" }
  | { status: "approval_required"; approval: CustomMcpResumableApproval };

function ownDataProperties(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, PropertyDescriptor> | null {
  if (typeof value !== "object" || value === null) return null;
  let keys: PropertyKey[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
  }
  return descriptors;
}

function stableTrustedChildApprovalResolution(
  value: unknown,
  now: number,
): StableTrustedChildApprovalResolution | null {
  const root = ownDataProperties(value, ["status"]);
  const rootWithApproval =
    root === null ? ownDataProperties(value, ["status", "approval"]) : null;
  if (root !== null) {
    if (root.status.value === "approved") {
      return Object.freeze({ status: "approved" as const });
    }
    if (root.status.value === "denied") {
      return Object.freeze({ status: "denied" as const });
    }
    return null;
  }
  if (
    rootWithApproval === null ||
    rootWithApproval.status.value !== "approval_required"
  ) {
    return null;
  }
  const approval = ownDataProperties(rootWithApproval.approval.value, [
    "approvalRequestId",
    "confirmationPath",
    "expiresAt",
  ]);
  if (approval === null) return null;
  const approvalRequestId = approval.approvalRequestId.value;
  const confirmationPath = approval.confirmationPath.value;
  const expiresAt = approval.expiresAt.value;
  if (
    typeof approvalRequestId !== "string" ||
    !/^mcp_approval_[A-Za-z0-9-]{1,128}$/.test(approvalRequestId) ||
    typeof confirmationPath !== "string" ||
    confirmationPath !==
      `/api/mcp/approvals/${encodeURIComponent(approvalRequestId)}/confirm` ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isFinite(now) ||
    expiresAt <= now
  ) {
    return null;
  }
  return Object.freeze({
    status: "approval_required" as const,
    approval: Object.freeze({
      approvalRequestId,
      confirmationPath,
      expiresAt,
    }),
  });
}

function parseRuntimeResult(
  bytes: unknown,
  limits: CustomMcpLimits,
  scope: { shipletId: string; revisionId: string },
): CustomMcpExecutorResult {
  if (!(bytes instanceof Uint8Array))
    return { ok: false, code: "invalid_result" };
  if (bytes.byteLength > limits.maxResultBytes) {
    return { ok: false, code: "result_too_large" };
  }
  let parsed: unknown;
  try {
    parsed = parseEncodedJson(
      bytes,
      "invalid_result_encoding",
      "invalid_result",
    );
  } catch (error) {
    if (error instanceof CompileFailure) return { ok: false, code: error.code };
    throw error;
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed.content)
  ) {
    return { ok: false, code: "invalid_result" };
  }
  const content: Array<{ type: "text"; text: string }> = [];
  for (const entry of parsed.content) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      entry.type !== "text" ||
      typeof entry.text !== "string"
    ) {
      return { ok: false, code: "invalid_result" };
    }
    const text = sanitizeUntrustedText(entry.text);
    if (utf8Length(text) > limits.maxResultBytes) {
      return { ok: false, code: "result_too_large" };
    }
    content.push(Object.freeze({ type: "text", text }));
  }
  const value = Object.freeze({
    trust: "trusted_kernel" as const,
    content: Object.freeze([
      Object.freeze({
        type: "text" as const,
        text: SAFE_CUSTOM_MCP_RESULT_NOTICE,
      }),
    ]),
    quarantine: Object.freeze({
      status: "held_for_trusted_human_release" as const,
      contentKind: "custom_mcp_result" as const,
      itemCount: content.length,
    }),
  });
  QUARANTINED_CUSTOM_MCP_RESULTS.set(
    value,
    Object.freeze({
      shipletId: scope.shipletId,
      revisionId: scope.revisionId,
      content: Object.freeze(content),
    }),
  );
  return Object.freeze({
    ok: true,
    value,
  });
}

export interface CustomMcpQuarantineReference {
  referenceId: string;
  shipletId: string;
  revisionId: string;
  contentKind: "custom_mcp_description" | "custom_mcp_result";
  expiresAt: number;
}

export interface CustomMcpQuarantineVaultEntry extends CustomMcpQuarantineReference {
  textItems: readonly string[];
}

export interface CustomMcpQuarantineVault {
  /** Persist the entry without logging its text. The returned ID must match. */
  store(
    entry: CustomMcpQuarantineVaultEntry,
  ): Promise<{ referenceId: string } | null>;
  /** Atomically consume once while checking every supplied scope coordinate. */
  consume(
    input: CustomMcpQuarantineReference & { now: number },
  ): Promise<CustomMcpQuarantineVaultEntry | null>;
}

export interface CustomMcpTrustedHumanRender {
  readonly trust: "untrusted_package_content";
  readonly audience: "trusted_human_only";
  readonly contentKind: "custom_mcp_description" | "custom_mcp_result";
  /** Returns HTML-escaped text once. It is never an MCP content projection. */
  consumeEscapedText(): readonly string[] | null;
  /** JSON serialization deliberately contains metadata only. */
  toJSON(): Readonly<Record<string, unknown>>;
}

const QUARANTINE_REFERENCE_PATTERN = /^qm_[A-Za-z0-9_-]{16,128}$/;
const MAX_QUARANTINE_RENDER_ITEMS = 256;
const MAX_QUARANTINE_RENDER_BYTES = 256 * 1024;

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function stableQuarantineReference(
  value: unknown,
): Readonly<CustomMcpQuarantineReference> | null {
  const descriptors = ownDataProperties(value, [
    "referenceId",
    "shipletId",
    "revisionId",
    "contentKind",
    "expiresAt",
  ]);
  if (descriptors === null) return null;
  const referenceId = descriptors.referenceId.value;
  const shipletId = descriptors.shipletId.value;
  const revisionId = descriptors.revisionId.value;
  const contentKind = descriptors.contentKind.value;
  const expiresAt = descriptors.expiresAt.value;
  if (
    typeof referenceId !== "string" ||
    !QUARANTINE_REFERENCE_PATTERN.test(referenceId) ||
    typeof shipletId !== "string" ||
    !SCOPE_ID_PATTERN.test(shipletId) ||
    typeof revisionId !== "string" ||
    !SCOPE_ID_PATTERN.test(revisionId) ||
    (contentKind !== "custom_mcp_description" &&
      contentKind !== "custom_mcp_result") ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt)
  ) {
    return null;
  }
  return Object.freeze({
    referenceId,
    shipletId,
    revisionId,
    contentKind,
    expiresAt,
  });
}

function stableVaultTextItems(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_QUARANTINE_RENDER_ITEMS) {
    return null;
  }
  let totalBytes = 0;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const sanitized = sanitizeUntrustedText(item);
    totalBytes += utf8Length(sanitized);
    if (totalBytes > MAX_QUARANTINE_RENDER_BYTES) return null;
    items.push(sanitized);
  }
  return Object.freeze(items);
}

/**
 * Stages hidden package prose in a trusted one-time vault and renders it only
 * after current human authorization. This module intentionally provides no
 * default vault: production must supply cross-request, scoped, expiring,
 * atomic-consume storage or staging fails closed.
 */
export function createCustomMcpQuarantineBroker(input: {
  vault: CustomMcpQuarantineVault;
  now(): number;
  ttlMs: number;
  authorizeTrustedHumanRender(input: {
    releaseRequest: unknown;
    reference: Readonly<CustomMcpQuarantineReference>;
  }): Promise<CapabilityActor | null>;
}) {
  if (
    typeof input?.vault?.store !== "function" ||
    typeof input.vault.consume !== "function" ||
    typeof input.now !== "function" ||
    !Number.isSafeInteger(input.ttlMs) ||
    input.ttlMs <= 0 ||
    typeof input.authorizeTrustedHumanRender !== "function"
  ) {
    throw new TypeError("Invalid custom MCP quarantine broker");
  }
  const unavailable = () =>
    Object.freeze({
      ok: false as const,
      code: "quarantine_unavailable" as const,
    });
  const stage = async (
    quarantined: {
      shipletId: string;
      revisionId: string;
      contentKind: "custom_mcp_description" | "custom_mcp_result";
      textItems: readonly string[];
    },
    stableReferenceId?: string,
  ) => {
    let currentTime: number;
    try {
      currentTime = input.now();
    } catch {
      currentTime = Number.NaN;
    }
    if (!Number.isSafeInteger(currentTime)) return unavailable();
    const expiresAt = currentTime + input.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) return unavailable();
    const reference = Object.freeze({
      referenceId:
        stableReferenceId &&
        QUARANTINE_REFERENCE_PATTERN.test(stableReferenceId)
          ? stableReferenceId
          : `qm_${crypto.randomUUID()}`,
      shipletId: quarantined.shipletId,
      revisionId: quarantined.revisionId,
      contentKind: quarantined.contentKind,
      expiresAt,
    });
    const entry = Object.freeze({
      ...reference,
      textItems: Object.freeze([...quarantined.textItems]),
    });
    let stored: { referenceId: string } | null;
    try {
      stored = await input.vault.store(entry);
    } catch {
      stored = null;
    }
    if (
      stored === null ||
      typeof stored !== "object" ||
      stored.referenceId !== reference.referenceId
    ) {
      return unavailable();
    }
    return Object.freeze({ ok: true as const, reference });
  };
  return Object.freeze({
    async stageToolDescription(stageInput: {
      tool: CompiledCustomMcpTool;
      referenceId?: string;
    }) {
      const quarantined =
        typeof stageInput === "object" && stageInput !== null
          ? QUARANTINED_TOOL_DESCRIPTIONS.get(stageInput.tool)
          : undefined;
      return quarantined === undefined
        ? unavailable()
        : stage(
            {
              shipletId: quarantined.shipletId,
              revisionId: quarantined.revisionId,
              contentKind: "custom_mcp_description",
              textItems: Object.freeze([quarantined.text]),
            },
            stageInput.referenceId,
          );
    },
    async stageResult(stageInput: {
      result: Extract<CustomMcpExecutorResult, { ok: true }>["value"];
    }) {
      const quarantined =
        typeof stageInput === "object" && stageInput !== null
          ? QUARANTINED_CUSTOM_MCP_RESULTS.get(stageInput.result)
          : undefined;
      return quarantined === undefined
        ? unavailable()
        : stage({
            shipletId: quarantined.shipletId,
            revisionId: quarantined.revisionId,
            contentKind: "custom_mcp_result",
            textItems: Object.freeze(
              quarantined.content.map((entry) => entry.text),
            ),
          });
    },
    async renderForTrustedHuman(renderInput: {
      reference: CustomMcpQuarantineReference;
      releaseRequest: unknown;
    }): Promise<
      | { ok: true; render: CustomMcpTrustedHumanRender }
      | {
          ok: false;
          code: "release_denied" | "quarantine_unavailable";
        }
    > {
      if (typeof renderInput !== "object" || renderInput === null) {
        return unavailable();
      }
      const reference = stableQuarantineReference(renderInput.reference);
      if (reference === null) return unavailable();
      let currentTime: number;
      try {
        currentTime = input.now();
      } catch {
        currentTime = Number.NaN;
      }
      if (
        !Number.isSafeInteger(currentTime) ||
        currentTime >= reference.expiresAt
      ) {
        return unavailable();
      }
      let authorizedActor: CapabilityActor | null;
      try {
        authorizedActor = await input.authorizeTrustedHumanRender(
          Object.freeze({
            releaseRequest: renderInput.releaseRequest,
            reference,
          }),
        );
      } catch {
        authorizedActor = null;
      }
      const actor =
        authorizedActor === null ? null : stableActor(authorizedActor);
      if (actor?.kind !== "human") {
        return Object.freeze({
          ok: false as const,
          code: "release_denied" as const,
        });
      }
      let consumed: CustomMcpQuarantineVaultEntry | null;
      try {
        consumed = await input.vault.consume({
          ...reference,
          now: currentTime,
        });
      } catch {
        consumed = null;
      }
      if (consumed === null || typeof consumed !== "object") {
        return unavailable();
      }
      const consumedReference = stableQuarantineReference({
        referenceId: consumed.referenceId,
        shipletId: consumed.shipletId,
        revisionId: consumed.revisionId,
        contentKind: consumed.contentKind,
        expiresAt: consumed.expiresAt,
      });
      const textItems = stableVaultTextItems(consumed.textItems);
      if (
        consumedReference === null ||
        textItems === null ||
        consumedReference.referenceId !== reference.referenceId ||
        consumedReference.shipletId !== reference.shipletId ||
        consumedReference.revisionId !== reference.revisionId ||
        consumedReference.contentKind !== reference.contentKind ||
        consumedReference.expiresAt !== reference.expiresAt
      ) {
        return unavailable();
      }
      let renderItems: readonly string[] | null = Object.freeze(
        textItems.map(escapeHtmlText),
      );
      const render = Object.freeze({
        trust: "untrusted_package_content" as const,
        audience: "trusted_human_only" as const,
        contentKind: reference.contentKind,
        consumeEscapedText() {
          const value = renderItems;
          renderItems = null;
          return value;
        },
        toJSON() {
          return Object.freeze({
            trust: "untrusted_package_content" as const,
            audience: "trusted_human_only" as const,
            contentKind: reference.contentKind,
            status: "awaiting_local_render_consumption" as const,
          });
        },
      });
      return Object.freeze({ ok: true as const, render });
    },
  });
}

function mappedBrokerFailure(
  result: Exclude<CapabilityInvocationResult<unknown>, { ok: true }>,
): CustomMcpExecutorResult {
  return {
    ok: false,
    code: result.code === "execution_failed" ? "runtime_failed" : result.code,
  };
}

export function createCustomMcpExecutor(input: {
  registry: CompiledCustomMcpRegistry;
  broker: CustomMcpBoundCapabilityBroker;
  runtime: CustomMcpRuntimeAdapter;
  limits: CustomMcpLimits;
  capabilityDispatcher?: CustomMcpCapabilityDispatcher;
  stateNamespace?: string;
  egressPolicy?: { allowedResources: readonly string[] };
  now?: () => number;
  activeRevisionResolver: CustomMcpActiveRevisionResolver;
  trustedChildApprovalDelegate?: CustomMcpTrustedChildApprovalDelegate;
  approvedMutationDispatcher?: CustomMcpApprovedMutationDispatcher;
  auditNestedCapabilityDenial?: CustomMcpNestedCapabilityDenialAudit;
  protocolTestOnly?: true;
}): CustomMcpExecutor {
  assertLimits(input.limits);
  if (!isTrustedCompiledRegistry(input.registry)) {
    throw new Error("untrusted_registry");
  }
  const activeRevisionResolver = requireActiveRevisionResolver(
    input.activeRevisionResolver,
  );
  const broker = requireBoundCustomMcpCapabilityBroker({
    broker: input.broker,
  });
  if (
    input.protocolTestOnly !== true &&
    typeof input.auditNestedCapabilityDenial !== "function"
  ) {
    throw new TypeError("custom_mcp_audit_required");
  }
  const verifiedRegistryScope = verifiedScopeForRegistry(input.registry);
  const now = input.now ?? Date.now;
  const stateNamespace = `shiplet:${input.registry.shipletId}:revision:${input.registry.revisionId}`;
  if (
    input.stateNamespace !== undefined &&
    input.stateNamespace !== stateNamespace
  ) {
    throw new TypeError("Invalid custom MCP state namespace");
  }
  const egressPolicy = Object.freeze({
    allowedResources: Object.freeze(
      (input.egressPolicy?.allowedResources ?? []).filter(
        (resource): resource is string =>
          typeof resource === "string" && resource.length > 0,
      ),
    ),
  });
  return Object.freeze({
    async invoke(
      untrustedInvocation: CustomMcpExecutorInvocation,
    ): Promise<CustomMcpExecutorResult> {
      if (
        typeof untrustedInvocation !== "object" ||
        untrustedInvocation === null
      ) {
        return { ok: false, code: "custom_tool_not_found" };
      }
      const actor = stableActor(untrustedInvocation.trustedActor);
      const shipletId = untrustedInvocation.shipletId;
      const revisionId = untrustedInvocation.revisionId;
      const toolName = untrustedInvocation.toolName;
      const requestId = untrustedInvocation.requestId;
      const invocationCapabilityHandle =
        untrustedInvocation.invocationCapabilityHandle;
      if (
        actor === null ||
        typeof shipletId !== "string" ||
        typeof revisionId !== "string" ||
        typeof toolName !== "string" ||
        typeof requestId !== "string" ||
        typeof invocationCapabilityHandle !== "string" ||
        requestId.length === 0 ||
        !AUDIT_SCOPE_ID_PATTERN.test(requestId) ||
        !AUDIT_SCOPE_ID_PATTERN.test(actor?.id ?? "") ||
        invocationCapabilityHandle.length === 0 ||
        shipletId !== input.registry.shipletId ||
        revisionId !== input.registry.revisionId
      ) {
        return { ok: false, code: "custom_tool_not_found" };
      }
      const activeAtInvocation = resolveActiveRevision(
        activeRevisionResolver,
        shipletId,
      );
      if (
        activeAtInvocation === null ||
        activeAtInvocation.revisionId !== input.registry.revisionId ||
        activeAtInvocation.packageDigest !== input.registry.packageDigest ||
        (verifiedRegistryScope !== null &&
          activeAtInvocation.activationGeneration !==
            verifiedRegistryScope.activationGeneration)
      ) {
        return { ok: false, code: "stale_revision" };
      }
      const tool = input.registry.resolve(toolName);
      if (tool === null) return { ok: false, code: "custom_tool_not_found" };
      if (!(untrustedInvocation.inputBytes instanceof Uint8Array)) {
        return { ok: false, code: "invalid_input" };
      }
      if (
        untrustedInvocation.inputBytes.byteLength > input.limits.maxInputBytes
      ) {
        return { ok: false, code: "input_too_large" };
      }
      let stableInput: JsonValue;
      try {
        stableInput = stableInputJson(
          untrustedInvocation.inputBytes,
          input.limits,
        );
      } catch (error) {
        if (error instanceof CompileFailure) {
          return { ok: false, code: error.code };
        }
        return { ok: false, code: "invalid_input" };
      }
      if (
        !valueMatchesSchema(
          stableInput,
          tool.inputSchema as unknown as JsonRecord,
        )
      ) {
        return { ok: false, code: "input_schema_violation" };
      }
      const runtimeBinding = (
        input.runtime as CustomMcpRuntimeAdapter & {
          [SERIALIZED_RUNTIME_BINDING]?: SerializedRuntimeBinding;
        }
      )[SERIALIZED_RUNTIME_BINDING];
      if (
        runtimeBinding === undefined ||
        runtimeBinding.packageDigest !== input.registry.packageDigest ||
        runtimeBinding.revisionId !== input.registry.revisionId ||
        (verifiedRegistryScope === null
          ? input.protocolTestOnly !== true ||
            runtimeBinding.verifiedIsolation !== false
          : runtimeBinding.verifiedIsolation !== true ||
            runtimeBinding.shipletId !== input.registry.shipletId ||
            runtimeBinding.activationGeneration !==
              verifiedRegistryScope.activationGeneration ||
            runtimeBinding.handlerSetDigest !==
              verifiedRegistryScope.handlerSetDigest)
      ) {
        return { ok: false, code: "runtime_unavailable" };
      }
      const invokeBound = <T>(
        invocation: CapabilityInvocation,
        requirements: CustomMcpBoundRequirements,
        execute: (authorized: AuthorizedCapabilityInvocation) => Promise<T>,
      ) => broker.invokeBound(invocation, requirements, execute);
      const capabilityHandles: Record<string, string> = Object.create(
        null,
      ) as Record<string, string>;
      for (const capability of tool.requestedCapabilities) {
        const descriptor =
          typeof untrustedInvocation.capabilityHandles === "object" &&
          untrustedInvocation.capabilityHandles !== null
            ? Object.getOwnPropertyDescriptor(
                untrustedInvocation.capabilityHandles,
                capability,
              )
            : undefined;
        if (
          descriptor &&
          "value" in descriptor &&
          typeof descriptor.value === "string" &&
          descriptor.value.length > 0
        ) {
          capabilityHandles[capability] = descriptor.value;
        }
      }
      Object.freeze(capabilityHandles);

      const outerInvocation: CapabilityInvocation = Object.freeze({
        opaqueHandle: invocationCapabilityHandle,
        trustedActor: actor,
        request: Object.freeze({
          requestId,
          shipletId,
          revisionId,
          action: `mcp.custom.invoke:${tool.localName}`,
          resource: `mcp-tool:${tool.name}`,
          input: stableInput,
        }),
      });
      let startedAt: number;
      try {
        startedAt = now();
      } catch {
        startedAt = Number.NaN;
      }
      const deadlineAt = startedAt + input.limits.maxExecutionMs;
      const dispatchAbortController = new AbortController();
      const outstandingSubcalls = new Set<
        Promise<CustomMcpRuntimeCapabilityResult>
      >();
      let subcallCount = 0;
      let runtimeUnavailable = false;
      let runtimeAcceptsCapabilities = true;
      let deadlineExceeded = false;
      let dispatchCommitted = false;
      let reconciliationRequired = false;
      let staleRevision = false;
      let nestedAuditUnavailable = false;
      let pendingApproval: CustomMcpResumableApproval | null = null;
      let mutationResolutionInFlight = false;
      let brokerResult: CapabilityInvocationResult<Uint8Array>;
      try {
        const brokerPromise = invokeBound(
          outerInvocation,
          Object.freeze({ effect: "read", approval: "none" }),
          async (authorized: AuthorizedCapabilityInvocation) => {
            const activeAfterClaim = resolveActiveRevision(
              activeRevisionResolver,
              authorized.shipletId,
            );
            if (
              activeAfterClaim === null ||
              !sameActiveRevision(activeAtInvocation, activeAfterClaim)
            ) {
              staleRevision = true;
              throw new Error("stale_revision");
            }
            const denyEarlyNestedCapability = async (
              outcome: CustomMcpNestedCapabilityDenialOutcome,
              requestedCapability?: string,
            ): Promise<CustomMcpRuntimeCapabilityResult> => {
              const declaredCapability =
                outcome !== "capability_limit_exceeded" &&
                typeof requestedCapability === "string" &&
                tool.requestedCapabilities.includes(requestedCapability)
                  ? requestedCapability
                  : null;
              if (typeof input.auditNestedCapabilityDenial !== "function") {
                if (input.protocolTestOnly === true) {
                  return { ok: false, code: outcome };
                }
                nestedAuditUnavailable = true;
                return { ok: false, code: "audit_unavailable" };
              }
              const auditEvent: CustomMcpNestedCapabilityDenialAuditEvent =
                Object.freeze({
                  schemaVersion:
                    "shiplet.audit.custom-mcp-nested-denial/v1" as const,
                  eventKind: "custom_mcp.nested_capability_denied" as const,
                  outcome,
                  actorKind: authorized.actor.kind,
                  actorId: authorized.actor.id,
                  shipletId: authorized.shipletId,
                  revisionId: authorized.revisionId,
                  activationGeneration: activeAtInvocation.activationGeneration,
                  toolName: tool.name,
                  parentRequestId: authorized.requestId,
                  subcallOrdinal: subcallCount,
                  declaredCapability,
                });
              try {
                await input.auditNestedCapabilityDenial(auditEvent);
                return { ok: false, code: outcome };
              } catch {
                nestedAuditUnavailable = true;
                return { ok: false, code: "audit_unavailable" };
              }
            };
            const performCapabilityRequest = async (
              untrustedRequest: CustomMcpRuntimeCapabilityRequest,
            ): Promise<CustomMcpRuntimeCapabilityResult> => {
              subcallCount += 1;
              if (pendingApproval !== null) {
                return denyEarlyNestedCapability("approval_required");
              }
              if (deadlineExceeded) {
                return denyEarlyNestedCapability(
                  "capability_deadline_exceeded",
                );
              }
              if (subcallCount > input.limits.maxCapabilityCalls) {
                return denyEarlyNestedCapability("capability_limit_exceeded");
              }
              let currentTime: number;
              try {
                currentTime = now();
              } catch {
                currentTime = Number.NaN;
              }
              if (
                !Number.isFinite(startedAt) ||
                !Number.isFinite(currentTime) ||
                currentTime - startedAt > input.limits.maxExecutionMs
              ) {
                return denyEarlyNestedCapability(
                  "capability_deadline_exceeded",
                );
              }
              const capabilityDescriptor =
                typeof untrustedRequest === "object" &&
                untrustedRequest !== null
                  ? Object.getOwnPropertyDescriptor(
                      untrustedRequest,
                      "capability",
                    )
                  : undefined;
              if (
                capabilityDescriptor !== undefined &&
                "value" in capabilityDescriptor &&
                typeof capabilityDescriptor.value === "string" &&
                capabilityDescriptor.value.startsWith("egress.")
              ) {
                return denyEarlyNestedCapability("egress_denied");
              }
              const request = stableRuntimeCapabilityRequest(
                untrustedRequest,
                input.limits,
              );
              if (request === null) {
                return denyEarlyNestedCapability("capability_denied");
              }
              if (request.capability.startsWith("egress.")) {
                return denyEarlyNestedCapability("egress_denied");
              }
              if (!tool.requestedCapabilities.includes(request.capability)) {
                return denyEarlyNestedCapability("capability_denied");
              }
              const effect = expectedCapabilityEffect(request.capability);
              if (effect === null) {
                return denyEarlyNestedCapability(
                  "capability_denied",
                  request.capability,
                );
              }
              if (request.effect !== undefined && request.effect !== effect) {
                return denyEarlyNestedCapability(
                  "capability_effect_mismatch",
                  request.capability,
                );
              }
              let capabilityBytes: number;
              try {
                capabilityBytes = utf8Length(JSON.stringify(request.input));
              } catch {
                return denyEarlyNestedCapability(
                  "capability_denied",
                  request.capability,
                );
              }
              if (capabilityBytes > input.limits.maxCapabilityRequestBytes) {
                return denyEarlyNestedCapability(
                  "capability_payload_too_large",
                  request.capability,
                );
              }
              if (
                request.capability.startsWith("egress.") &&
                !egressPolicy.allowedResources.includes(request.resource)
              ) {
                return denyEarlyNestedCapability(
                  "egress_denied",
                  request.capability,
                );
              }
              const handle = capabilityHandles[request.capability];
              if (typeof handle !== "string") {
                return denyEarlyNestedCapability(
                  "capability_denied",
                  request.capability,
                );
              }
              if (
                effect === "read" &&
                typeof input.capabilityDispatcher?.dispatch !== "function"
              ) {
                return denyEarlyNestedCapability(
                  "capability_denied",
                  request.capability,
                );
              }
              const childRequestId = `${authorized.requestId}:capability:${subcallCount}`;
              let rawOutcome: unknown;
              if (effect === "mutation") {
                if (mutationResolutionInFlight) {
                  return denyEarlyNestedCapability(
                    "capability_denied",
                    request.capability,
                  );
                }
                if (
                  typeof input.trustedChildApprovalDelegate?.resolve !==
                  "function"
                ) {
                  return denyEarlyNestedCapability(
                    "approval_required",
                    request.capability,
                  );
                }
                mutationResolutionInFlight = true;
                const childBinding: CustomMcpTrustedChildMutationBinding =
                  Object.freeze({
                    actor: authorized.actor,
                    shipletId: authorized.shipletId,
                    revisionId: authorized.revisionId,
                    activationGeneration:
                      activeAtInvocation.activationGeneration,
                    toolName: tool.name,
                    parentRequestId: authorized.requestId,
                    childRequestId,
                    toolInput: authorized.input,
                    declaredCapabilities: tool.requestedCapabilities,
                    capability: request.capability,
                    resource: request.resource,
                    effect: "mutation" as const,
                    input: request.input,
                    opaqueCapabilityHandle: handle,
                  });
                let delegated: unknown;
                try {
                  delegated =
                    await input.trustedChildApprovalDelegate.resolve(
                      childBinding,
                    );
                } catch {
                  delegated = Object.freeze({ status: "denied" as const });
                }
                const approvalResolution = stableTrustedChildApprovalResolution(
                  delegated,
                  currentTime,
                );
                if (
                  approvalResolution === null ||
                  approvalResolution.status === "denied"
                ) {
                  mutationResolutionInFlight = false;
                  return denyEarlyNestedCapability(
                    "capability_denied",
                    request.capability,
                  );
                }
                if (approvalResolution.status === "approval_required") {
                  pendingApproval = approvalResolution.approval;
                  mutationResolutionInFlight = false;
                  return denyEarlyNestedCapability(
                    "approval_required",
                    request.capability,
                  );
                }
                const activeAfterDelegation = resolveActiveRevision(
                  activeRevisionResolver,
                  authorized.shipletId,
                );
                if (
                  deadlineExceeded ||
                  activeAfterDelegation === null ||
                  !sameActiveRevision(activeAtInvocation, activeAfterDelegation)
                ) {
                  mutationResolutionInFlight = false;
                  return denyEarlyNestedCapability(
                    deadlineExceeded
                      ? "capability_deadline_exceeded"
                      : "capability_denied",
                    request.capability,
                  );
                }
                if (
                  typeof input.approvedMutationDispatcher?.dispatch !==
                  "function"
                ) {
                  mutationResolutionInFlight = false;
                  return denyEarlyNestedCapability(
                    "capability_denied",
                    request.capability,
                  );
                }
                const childAuthorized: AuthorizedCapabilityInvocation =
                  Object.freeze({
                    actor: authorized.actor,
                    shipletId: authorized.shipletId,
                    revisionId: authorized.revisionId,
                    action: request.capability,
                    resource: request.resource,
                    requestId: childRequestId,
                    input: request.input,
                  });
                try {
                  rawOutcome = await input.approvedMutationDispatcher.dispatch(
                    Object.freeze({
                      ...childBinding,
                      authorized: childAuthorized,
                      stateNamespace,
                      egressPolicy,
                      invocationId: authorized.requestId,
                      deadlineAt,
                      signal: dispatchAbortController.signal,
                    }),
                  );
                } catch {
                  mutationResolutionInFlight = false;
                  reconciliationRequired = true;
                  return {
                    ok: false,
                    code: "capability_reconciliation_required",
                  };
                }
                mutationResolutionInFlight = false;
              } else {
                const activeBeforeNestedClaim = resolveActiveRevision(
                  activeRevisionResolver,
                  authorized.shipletId,
                );
                if (
                  activeBeforeNestedClaim === null ||
                  !sameActiveRevision(
                    activeAtInvocation,
                    activeBeforeNestedClaim,
                  )
                ) {
                  return denyEarlyNestedCapability(
                    "capability_denied",
                    request.capability,
                  );
                }
                const nestedResult = await invokeBound(
                  Object.freeze({
                    opaqueHandle: handle,
                    trustedActor: authorized.actor,
                    request: Object.freeze({
                      requestId: childRequestId,
                      shipletId: authorized.shipletId,
                      revisionId: authorized.revisionId,
                      action: request.capability,
                      resource: request.resource,
                      input: request.input,
                    }),
                  }),
                  Object.freeze({ effect: "read", approval: "none" }),
                  async (nestedAuthorized) => {
                    let nestedTime: number;
                    try {
                      nestedTime = now();
                    } catch {
                      nestedTime = Number.NaN;
                    }
                    if (
                      deadlineExceeded ||
                      !Number.isFinite(startedAt) ||
                      !Number.isFinite(nestedTime) ||
                      nestedTime - startedAt > input.limits.maxExecutionMs
                    ) {
                      throw new Error("runtime_deadline_exceeded");
                    }
                    const activeAfterNestedClaim = resolveActiveRevision(
                      activeRevisionResolver,
                      nestedAuthorized.shipletId,
                    );
                    if (
                      activeAfterNestedClaim === null ||
                      !sameActiveRevision(
                        activeAtInvocation,
                        activeAfterNestedClaim,
                      )
                    ) {
                      throw new Error("stale_revision");
                    }
                    return input.capabilityDispatcher!.dispatch(
                      Object.freeze({
                        authorized: nestedAuthorized,
                        stateNamespace,
                        egressPolicy,
                        invocationId: authorized.requestId,
                        deadlineAt,
                        signal: dispatchAbortController.signal,
                      }),
                    );
                  },
                );
                if (!nestedResult.ok) return nestedResult;
                rawOutcome = nestedResult.value;
              }
              const outcome = stableCapabilityDispatchOutcome(rawOutcome);
              if (outcome === null) {
                reconciliationRequired = true;
                return {
                  ok: false,
                  code: "capability_reconciliation_required",
                };
              }
              if (outcome.status === "committed") {
                dispatchCommitted = true;
                const activeAfterDispatch = resolveActiveRevision(
                  activeRevisionResolver,
                  authorized.shipletId,
                );
                if (
                  deadlineExceeded ||
                  dispatchAbortController.signal.aborted ||
                  activeAfterDispatch === null ||
                  !sameActiveRevision(activeAtInvocation, activeAfterDispatch)
                ) {
                  reconciliationRequired = true;
                  return {
                    ok: false,
                    code: "capability_reconciliation_required",
                  };
                }
                return { ok: true, value: outcome.value };
              }
              if (outcome.status === "reconciliation_required") {
                reconciliationRequired = true;
                return {
                  ok: false,
                  code: "capability_reconciliation_required",
                };
              }
              return {
                ok: false,
                code: "capability_deadline_exceeded",
              };
            };
            const requestCapability = (
              untrustedRequest: CustomMcpRuntimeCapabilityRequest,
            ): Promise<CustomMcpRuntimeCapabilityResult> => {
              if (!runtimeAcceptsCapabilities || deadlineExceeded) {
                subcallCount += 1;
                return denyEarlyNestedCapability(
                  "capability_deadline_exceeded",
                );
              }
              const tracked = performCapabilityRequest(untrustedRequest).catch(
                () => denyEarlyNestedCapability("capability_denied"),
              );
              outstandingSubcalls.add(tracked);
              void tracked.then(
                () => outstandingSubcalls.delete(tracked),
                () => outstandingSubcalls.delete(tracked),
              );
              return tracked;
            };
            const runtimeInvocation: IsolatedCustomMcpRuntimeInvocation =
              Object.freeze({
                actor: authorized.actor,
                shipletId: authorized.shipletId,
                revisionId: authorized.revisionId,
                toolName: tool.name,
                requestId: authorized.requestId,
                handlerPath: tool.handlerPath,
                input: authorized.input,
                declaredCapabilities: tool.requestedCapabilities,
                requestCapability,
              });
            if (deadlineExceeded) {
              throw new CustomMcpRuntimeUnavailableError();
            }
            let runtimeResult: Uint8Array;
            try {
              runtimeResult = await input.runtime.invoke(runtimeInvocation);
            } catch (error) {
              if (error instanceof CustomMcpRuntimeUnavailableError) {
                runtimeUnavailable = true;
              }
              throw error;
            } finally {
              runtimeAcceptsCapabilities = false;
            }
            await Promise.all([...outstandingSubcalls]);
            if (nestedAuditUnavailable) {
              throw new Error("nested_audit_unavailable");
            }
            if (reconciliationRequired) {
              throw new Error("runtime_reconciliation_required");
            }
            return runtimeResult;
          },
        );
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<null>((resolve) => {
          deadlineTimer = setTimeout(() => {
            deadlineExceeded = true;
            runtimeAcceptsCapabilities = false;
            dispatchAbortController.abort();
            resolve(null);
          }, input.limits.maxExecutionMs);
        });
        const settled = await Promise.race([
          brokerPromise.then((result) => ({ result })),
          deadline,
        ]);
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        if (settled === null) {
          let cancellationConfirmed = false;
          let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
          const cancellationBoundary = Promise.allSettled([
            Promise.resolve()
              .then(() =>
                input.runtime.cancel(
                  Object.freeze({
                    invocationId: requestId,
                    reason: "deadline_exceeded" as const,
                  }),
                ),
              )
              .then(() => {
                cancellationConfirmed = true;
              }),
            ...outstandingSubcalls,
          ]);
          let cancellationBoundarySettled = false;
          await Promise.race([
            cancellationBoundary.then(() => {
              cancellationBoundarySettled = true;
            }),
            new Promise<void>((resolve) => {
              cancellationTimer = setTimeout(
                resolve,
                Math.max(1, Math.min(input.limits.maxExecutionMs, 1_000)),
              );
            }),
          ]);
          if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
          if (
            !cancellationBoundarySettled ||
            !cancellationConfirmed ||
            dispatchCommitted ||
            reconciliationRequired
          ) {
            return {
              ok: false,
              code: "runtime_reconciliation_required",
            };
          }
          return { ok: false, code: "runtime_timeout" };
        }
        brokerResult = settled.result;
      } catch {
        return {
          ok: false,
          code: staleRevision
            ? "stale_revision"
            : nestedAuditUnavailable
              ? "audit_unavailable"
              : reconciliationRequired
                ? "runtime_reconciliation_required"
                : runtimeUnavailable
                  ? "runtime_unavailable"
                  : "runtime_failed",
        };
      }
      if (!brokerResult.ok) {
        if (staleRevision && brokerResult.code === "execution_failed") {
          return { ok: false, code: "stale_revision" };
        }
        if (runtimeUnavailable && brokerResult.code === "execution_failed") {
          return { ok: false, code: "runtime_unavailable" };
        }
        return mappedBrokerFailure(brokerResult);
      }
      if (pendingApproval !== null) {
        return Object.freeze({
          ok: false as const,
          code: "approval_required",
          approval: pendingApproval,
        });
      }
      return parseRuntimeResult(brokerResult.value, input.limits, {
        shipletId,
        revisionId,
      });
    },
  });
}

export interface TrustedCustomMcpAuthorization {
  canDiscover(input: {
    actor: CapabilityActor;
    shipletId: string;
    revisionId: string;
  }): boolean | Promise<boolean>;
  canInvoke(input: {
    actor: CapabilityActor;
    shipletId: string;
    revisionId: string;
  }): boolean | Promise<boolean>;
}

export type TrustedCustomMcpSurfaceResult =
  | {
      ok: true;
      registry: CompiledCustomMcpRegistry;
      catalog: CustomMcpToolCatalog;
      executor: CustomMcpExecutor;
    }
  | { ok: false; code: string };

export async function composeTrustedCustomMcpSurface(input: {
  activePackage: {
    packageEnvelope?: unknown;
    verifiedRegistry?: CompiledCustomMcpRegistry;
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  };
  trustedActor: CapabilityActor;
  authorization: TrustedCustomMcpAuthorization;
  broker: CustomMcpBoundCapabilityBroker;
  runtime: CustomMcpRuntimeAdapter;
  kernelTools: readonly KernelMcpTool[];
  supportedRuntimeVersions: readonly string[];
  supportedCapabilities: readonly string[];
  limits: CustomMcpLimits;
  activeRevisionResolver: CustomMcpActiveRevisionResolver;
  capabilityDispatcher?: CustomMcpCapabilityDispatcher;
  trustedChildApprovalDelegate?: CustomMcpTrustedChildApprovalDelegate;
  approvedMutationDispatcher?: CustomMcpApprovedMutationDispatcher;
  auditNestedCapabilityDenial?: CustomMcpNestedCapabilityDenialAudit;
  stateNamespace?: string;
  egressPolicy?: { allowedResources: readonly string[] };
  now?: () => number;
}): Promise<TrustedCustomMcpSurfaceResult> {
  const actor = stableActor(input.trustedActor);
  const activePackage = Object.freeze({
    ...(input.activePackage.packageEnvelope === undefined
      ? {}
      : { packageEnvelope: input.activePackage.packageEnvelope }),
    ...(input.activePackage.verifiedRegistry === undefined
      ? {}
      : { verifiedRegistry: input.activePackage.verifiedRegistry }),
    shipletId: input.activePackage.shipletId,
    revisionId: input.activePackage.revisionId,
    packageDigest: input.activePackage.packageDigest,
    activationGeneration: input.activePackage.activationGeneration,
  });
  if (
    actor === null ||
    typeof input.authorization?.canDiscover !== "function" ||
    typeof input.authorization.canInvoke !== "function"
  ) {
    return { ok: false, code: "permission_denied" };
  }
  const activeRevisionResolver = requireActiveRevisionResolver(
    input.activeRevisionResolver,
  );
  const active = resolveActiveRevision(
    activeRevisionResolver,
    activePackage.shipletId,
  );
  if (
    active === null ||
    active.revisionId !== activePackage.revisionId ||
    active.packageDigest !== activePackage.packageDigest ||
    active.activationGeneration !== activePackage.activationGeneration
  ) {
    return { ok: false, code: "stale_revision" };
  }
  let discoverable = false;
  try {
    discoverable = await input.authorization.canDiscover(
      Object.freeze({
        actor,
        shipletId: activePackage.shipletId,
        revisionId: activePackage.revisionId,
      }),
    );
  } catch {
    discoverable = false;
  }
  if (!discoverable) return { ok: false, code: "permission_denied" };
  if (typeof input.auditNestedCapabilityDenial !== "function") {
    return { ok: false, code: "audit_unavailable" };
  }
  const suppliedRegistry = activePackage.verifiedRegistry;
  const suppliedScope =
    suppliedRegistry === undefined
      ? null
      : verifiedScopeForRegistry(suppliedRegistry);
  const suppliedRegistryValid =
    suppliedRegistry !== undefined &&
    isTrustedCompiledRegistry(suppliedRegistry) &&
    suppliedRegistry.shipletId === activePackage.shipletId &&
    suppliedRegistry.revisionId === activePackage.revisionId &&
    suppliedRegistry.packageDigest === activePackage.packageDigest &&
    verifiedHandlersForRegistry(suppliedRegistry) !== null &&
    suppliedScope?.activationGeneration === activePackage.activationGeneration;
  const compiled = suppliedRegistryValid
    ? Object.freeze({ ok: true as const, registry: suppliedRegistry })
    : activePackage.packageEnvelope === undefined
      ? Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "invalid_package" }),
        })
      : await compileVerifiedCustomMcpRegistry({
          packageEnvelope: activePackage.packageEnvelope,
          activeRevision: {
            shipletId: activePackage.shipletId,
            revisionId: activePackage.revisionId,
            packageDigest: activePackage.packageDigest,
            activationGeneration: activePackage.activationGeneration,
          },
          supportedRuntimeVersions: input.supportedRuntimeVersions,
          supportedCapabilities: input.supportedCapabilities,
          limits: input.limits,
        });
  if (!compiled.ok) return { ok: false, code: compiled.error.code };
  let broker: CustomMcpBoundCapabilityBroker;
  try {
    broker = requireBoundCustomMcpCapabilityBroker({ broker: input.broker });
  } catch {
    return { ok: false, code: "capability_denied" };
  }
  const runtimeBinding = (
    input.runtime as CustomMcpRuntimeAdapter & {
      [SERIALIZED_RUNTIME_BINDING]?: SerializedRuntimeBinding;
    }
  )[SERIALIZED_RUNTIME_BINDING];
  const verifiedRegistryScope = verifiedScopeForRegistry(compiled.registry);
  if (
    runtimeBinding === undefined ||
    verifiedRegistryScope === null ||
    runtimeBinding.verifiedIsolation !== true ||
    runtimeBinding.shipletId !== activePackage.shipletId ||
    runtimeBinding.packageDigest !== activePackage.packageDigest ||
    runtimeBinding.revisionId !== activePackage.revisionId ||
    runtimeBinding.activationGeneration !==
      activePackage.activationGeneration ||
    runtimeBinding.handlerSetDigest !== verifiedRegistryScope.handlerSetDigest
  ) {
    return { ok: false, code: "runtime_unavailable" };
  }
  const catalog = createCustomMcpToolCatalog({
    kernelTools: input.kernelTools,
    customRegistries: [compiled.registry],
    activeRevisionResolver,
    trustedActor: actor,
    authorizeDiscovery: () => true,
  });
  const baseExecutor = createCustomMcpExecutor({
    registry: compiled.registry,
    broker,
    runtime: input.runtime,
    limits: input.limits,
    activeRevisionResolver,
    ...(input.capabilityDispatcher === undefined
      ? {}
      : { capabilityDispatcher: input.capabilityDispatcher }),
    ...(input.trustedChildApprovalDelegate === undefined
      ? {}
      : { trustedChildApprovalDelegate: input.trustedChildApprovalDelegate }),
    ...(input.approvedMutationDispatcher === undefined
      ? {}
      : { approvedMutationDispatcher: input.approvedMutationDispatcher }),
    auditNestedCapabilityDenial: input.auditNestedCapabilityDenial,
    ...(input.stateNamespace === undefined
      ? {}
      : { stateNamespace: input.stateNamespace }),
    ...(input.egressPolicy === undefined
      ? {}
      : { egressPolicy: input.egressPolicy }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const executor: CustomMcpExecutor = Object.freeze({
    async invoke(invocation: CustomMcpExecutorInvocation) {
      const invocationActor = stableActor(invocation.trustedActor);
      if (
        invocationActor === null ||
        invocationActor.kind !== actor.kind ||
        invocationActor.id !== actor.id ||
        invocation.shipletId !== activePackage.shipletId ||
        invocation.revisionId !== activePackage.revisionId
      ) {
        return { ok: false as const, code: "permission_denied" };
      }
      let allowed = false;
      try {
        allowed = await input.authorization.canInvoke(
          Object.freeze({
            actor,
            shipletId: invocation.shipletId,
            revisionId: invocation.revisionId,
          }),
        );
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return { ok: false as const, code: "permission_denied" };
      }
      return baseExecutor.invoke(
        Object.freeze({ ...invocation, trustedActor: actor }),
      );
    },
  });
  return Object.freeze({
    ok: true,
    registry: compiled.registry,
    catalog,
    executor,
  });
}
