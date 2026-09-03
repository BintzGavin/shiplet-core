import type { CustomMcpRuntimeIsolationBinding } from "../custom-mcp";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const HANDLER_DIGEST = /^[a-f0-9]{64}$/;
const HANDLER_PATH =
  /^mcp\/handlers\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.js$/;
const MAX_HANDLERS = 32;
const MAX_HANDLER_BYTES = 256 * 1024;
const MAX_HANDLER_SET_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PLATFORM_MEMORY_BYTES = 128 * 1024 * 1024;

export type CustomMcpCapabilityBinding = Readonly<{
  request(bytes: Uint8Array): Promise<Uint8Array>;
}>;

type DynamicWorkerCode = Readonly<{
  compatibilityDate: "2026-08-07";
  compatibilityFlags: string[];
  limits: Readonly<{ cpuMs: number; subRequests: number }>;
  mainModule: "__shiplet_custom_mcp.mjs";
  modules: Readonly<Record<string, Readonly<{ js: string }>>>;
  env: Readonly<{
    SHIPLET_SCOPE: Readonly<{
      shipletId: string;
      revisionId: string;
      packageDigest: string;
      activationGeneration: number;
      handlerSetDigest: string;
    }>;
    SHIPLET_CAPABILITY: CustomMcpCapabilityBinding;
  }>;
  globalOutbound: null;
}>;

export type CustomMcpWorkerLoader = Readonly<{
  load(code: DynamicWorkerCode): Readonly<{
    getEntrypoint(
      name?: string,
      options?: Readonly<{
        limits: Readonly<{ cpuMs: number; subRequests: number }>;
      }>,
    ): Readonly<{ fetch(request: Request): Promise<Response> }>;
  }>;
}>;

type HandlerSnapshot = Readonly<{
  path: string;
  digest: string;
  bytes: Uint8Array;
}>;

function exactObject(value: unknown, keys: readonly string[]) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function validatePolicy(value: unknown) {
  if (
    !exactObject(value, [
      "schemaVersion",
      "hardTermination",
      "maxCpuMs",
      "maxMemoryBytes",
      "maxSubrequests",
      "outboundNetwork",
      "ambientBindings",
      "ambientSecrets",
    ])
  ) {
    throw new TypeError("custom_mcp_policy_invalid");
  }
  const policy = value as CustomMcpRuntimeIsolationBinding["policy"];
  if (
    policy.schemaVersion !== "shiplet.runtime-isolation-policy/v1" ||
    policy.hardTermination !== "enforced" ||
    !Number.isSafeInteger(policy.maxCpuMs) ||
    policy.maxCpuMs <= 0 ||
    policy.maxCpuMs > 30_000 ||
    policy.maxMemoryBytes !== PLATFORM_MEMORY_BYTES ||
    !Number.isSafeInteger(policy.maxSubrequests) ||
    policy.maxSubrequests <= 0 ||
    policy.maxSubrequests > 100 ||
    policy.outboundNetwork !== "deny_by_default" ||
    policy.ambientBindings !== "none" ||
    policy.ambientSecrets !== "none"
  ) {
    throw new TypeError("custom_mcp_policy_invalid");
  }
  return Object.freeze({
    cpuMs: policy.maxCpuMs,
    subRequests: policy.maxSubrequests,
  });
}

function snapshotBinding(binding: CustomMcpRuntimeIsolationBinding) {
  if (
    !exactObject(binding, [
      "shipletId",
      "revisionId",
      "packageDigest",
      "activationGeneration",
      "handlerSetDigest",
      "handlers",
      "policy",
    ]) ||
    !IDENTIFIER.test(binding.shipletId) ||
    !IDENTIFIER.test(binding.revisionId) ||
    !PACKAGE_DIGEST.test(binding.packageDigest) ||
    !Number.isSafeInteger(binding.activationGeneration) ||
    binding.activationGeneration <= 0 ||
    !PACKAGE_DIGEST.test(binding.handlerSetDigest) ||
    !Array.isArray(binding.handlers) ||
    binding.handlers.length === 0 ||
    binding.handlers.length > MAX_HANDLERS
  ) {
    throw new TypeError("custom_mcp_binding_invalid");
  }
  const limits = validatePolicy(binding.policy);
  const names = new Set<string>();
  let totalBytes = 0;
  const handlers: HandlerSnapshot[] = binding.handlers.map((handler) => {
    if (
      !exactObject(handler, ["path", "digest", "bytes"]) ||
      !HANDLER_PATH.test(handler.path) ||
      names.has(handler.path) ||
      !HANDLER_DIGEST.test(handler.digest) ||
      !(handler.bytes instanceof Uint8Array) ||
      handler.bytes.byteLength === 0 ||
      handler.bytes.byteLength > MAX_HANDLER_BYTES
    ) {
      throw new TypeError("custom_mcp_handler_invalid");
    }
    names.add(handler.path);
    totalBytes += handler.bytes.byteLength;
    if (totalBytes > MAX_HANDLER_SET_BYTES) {
      throw new TypeError("custom_mcp_handler_invalid");
    }
    return Object.freeze({
      path: handler.path,
      digest: handler.digest,
      bytes: handler.bytes.slice(),
    });
  });
  return Object.freeze({
    shipletId: binding.shipletId,
    revisionId: binding.revisionId,
    packageDigest: binding.packageDigest,
    activationGeneration: binding.activationGeneration,
    handlerSetDigest: binding.handlerSetDigest,
    handlers: Object.freeze(handlers),
    limits,
  });
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function runtimeModuleSource(handlers: readonly HandlerSnapshot[]) {
  const imports = handlers
    .map(
      (handler, index) =>
        `import handler${index} from ${JSON.stringify(`./${handler.path}`)};`,
    )
    .join("\n");
  const entries = handlers
    .map(
      (handler, index) =>
        `[${JSON.stringify(handler.path)}, handler${index}]`,
    )
    .join(",\n");
  return `${imports}

const handlers = new Map([${entries}]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const failure = () => new Response(JSON.stringify({
  schemaVersion: "shiplet.runtime.error/v1",
  code: "handler_failed",
}), { status: 200, headers: { "content-type": "application/json" } });

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== "POST" || request.signal.aborted) return failure();
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > ${MAX_REQUEST_BYTES}) return failure();
      const invocation = JSON.parse(decoder.decode(bytes));
      if (!record(invocation) || Object.keys(invocation).length !== 10 ||
          invocation.schemaVersion !== "shiplet.runtime.invocation/v1" ||
          invocation.shipletId !== env.SHIPLET_SCOPE.shipletId ||
          invocation.revisionId !== env.SHIPLET_SCOPE.revisionId ||
          invocation.packageDigest !== env.SHIPLET_SCOPE.packageDigest ||
          !identifier.test(invocation.toolName) || !identifier.test(invocation.requestId) ||
          !handlers.has(invocation.handlerPath) || !record(invocation.actor) ||
          !["human", "agent", "shiplet", "system"].includes(invocation.actor.kind) ||
          !identifier.test(invocation.actor.id) ||
          !Array.isArray(invocation.declaredCapabilities) ||
          invocation.declaredCapabilities.length > ${MAX_HANDLERS} ||
          invocation.declaredCapabilities.some((item) => !identifier.test(item)) ||
          new Set(invocation.declaredCapabilities).size !== invocation.declaredCapabilities.length) {
        return failure();
      }
      const declared = new Set(invocation.declaredCapabilities);
      const requestCapability = async (capabilityRequest) => {
        if (!record(capabilityRequest) ||
            !declared.has(capabilityRequest.capability) ||
            typeof capabilityRequest.resource !== "string" ||
            capabilityRequest.resource.length === 0 ||
            capabilityRequest.resource.length > 512 ||
            (capabilityRequest.effect !== undefined &&
             capabilityRequest.effect !== "read" && capabilityRequest.effect !== "mutation")) {
          return { ok: false, code: "capability_denied" };
        }
        const capabilityBytes = encoder.encode(JSON.stringify({
          schemaVersion: "shiplet.runtime.capability-request/v1",
          capability: capabilityRequest.capability,
          resource: capabilityRequest.resource,
          input: capabilityRequest.input,
          ...(capabilityRequest.effect === undefined ? {} : { effect: capabilityRequest.effect }),
        }));
        if (capabilityBytes.byteLength > 8192 || request.signal.aborted) {
          return { ok: false, code: "capability_denied" };
        }
        const responseBytes = await env.SHIPLET_CAPABILITY.request(capabilityBytes);
        if (!(responseBytes instanceof Uint8Array) || responseBytes.byteLength > ${MAX_RESPONSE_BYTES}) {
          return { ok: false, code: "capability_denied" };
        }
        return JSON.parse(decoder.decode(responseBytes));
      };
      const handler = handlers.get(invocation.handlerPath);
      if (typeof handler !== "function") return failure();
      const result = await handler(Object.freeze({
        actor: Object.freeze({ kind: invocation.actor.kind, id: invocation.actor.id }),
        shipletId: invocation.shipletId,
        revisionId: invocation.revisionId,
        toolName: invocation.toolName,
        requestId: invocation.requestId,
        input: invocation.input,
        declaredCapabilities: Object.freeze([...invocation.declaredCapabilities]),
        requestCapability,
      }));
      const resultBytes = encoder.encode(JSON.stringify(result));
      if (resultBytes.byteLength === 0 || resultBytes.byteLength > ${MAX_RESPONSE_BYTES}) return failure();
      return new Response(resultBytes, { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return failure();
    }
  },
};`;
}

async function verifiedCode(input: {
  binding: ReturnType<typeof snapshotBinding>;
  capability: CustomMcpCapabilityBinding;
}) {
  for (const handler of input.binding.handlers) {
    if ((await sha256Hex(handler.bytes)) !== handler.digest) {
      throw new TypeError("custom_mcp_handler_invalid");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(handler.bytes);
    } catch {
      throw new TypeError("custom_mcp_handler_invalid");
    }
  }
  const canonicalSet = new TextEncoder().encode(
    JSON.stringify(
      [...input.binding.handlers]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((handler) => [handler.path, handler.digest]),
    ),
  );
  if (`sha256:${await sha256Hex(canonicalSet)}` !== input.binding.handlerSetDigest) {
    throw new TypeError("custom_mcp_handler_invalid");
  }
  const modules: Record<string, Readonly<{ js: string }>> = {
    "__shiplet_custom_mcp.mjs": Object.freeze({
      js: runtimeModuleSource(input.binding.handlers),
    }),
  };
  for (const handler of input.binding.handlers) {
    modules[handler.path] = Object.freeze({
      js: new TextDecoder("utf-8", { fatal: true }).decode(handler.bytes),
    });
  }
  const code: DynamicWorkerCode = Object.freeze({
    compatibilityDate: "2026-08-07",
    compatibilityFlags: ["enable_request_signal"],
    limits: input.binding.limits,
    mainModule: "__shiplet_custom_mcp.mjs",
    modules: Object.freeze(modules),
    env: Object.freeze({
      SHIPLET_SCOPE: Object.freeze({
        shipletId: input.binding.shipletId,
        revisionId: input.binding.revisionId,
        packageDigest: input.binding.packageDigest,
        activationGeneration: input.binding.activationGeneration,
        handlerSetDigest: input.binding.handlerSetDigest,
      }),
      SHIPLET_CAPABILITY: input.capability,
    }),
    globalOutbound: null,
  });
  return code;
}

async function readBounded(response: Response) {
  if (response.status !== 200 || !response.body) {
    throw new Error("custom_mcp_runtime_failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("custom_mcp_runtime_failed");
    }
    chunks.push(next.value);
  }
  if (length === 0) throw new Error("custom_mcp_runtime_failed");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Builds one abortable Dynamic Worker invocation. The generated worker has no
 * global outbound service and receives only public scope coordinates plus its
 * invocation-local capability callback.
 */
export function createCustomMcpDynamicWorkerInvocation(input: {
  loader: CustomMcpWorkerLoader;
  capability: CustomMcpCapabilityBinding;
  binding: CustomMcpRuntimeIsolationBinding;
  invocationId: string;
  requestBytes: Uint8Array;
}) {
  if (
    typeof input.loader?.load !== "function" ||
    typeof input.capability?.request !== "function" ||
    !IDENTIFIER.test(input.invocationId) ||
    !(input.requestBytes instanceof Uint8Array) ||
    input.requestBytes.byteLength === 0 ||
    input.requestBytes.byteLength > MAX_REQUEST_BYTES
  ) {
    throw new TypeError("custom_mcp_invocation_invalid");
  }
  const binding = snapshotBinding(input.binding);
  const requestBytes = input.requestBytes.slice();
  const controller = new AbortController();
  let started = false;
  return Object.freeze({
    async run() {
      if (started) throw new Error("custom_mcp_invocation_started");
      started = true;
      const code = await verifiedCode({
        binding,
        capability: input.capability,
      });
      const worker = input.loader
        .load(code)
        .getEntrypoint(undefined, { limits: binding.limits });
      const response = await worker.fetch(
        new Request("https://custom-mcp.shiplet.invalid/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBytes,
          redirect: "manual",
          signal: controller.signal,
        }),
      );
      return readBounded(response);
    },
    cancel() {
      controller.abort("deadline_exceeded");
    },
  });
}
