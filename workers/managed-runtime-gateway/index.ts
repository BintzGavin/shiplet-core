import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ManagedRuntimeEnv } from "./env";

import type { CustomMcpRuntimeIsolationBinding } from "../../src/custom-mcp";
import {
  createCustomMcpDynamicWorkerInvocation,
  type CustomMcpCapabilityBinding,
} from "../../src/cloudflare-support/custom-mcp-runtime";
import {
  assertSupportReleaseExpectation,
  createSupportEntrypointContract,
  type ManagedRuntimeReleaseExpectation,
  type SupportReleaseExpectation,
} from "../../src/cloudflare-support/service-contract";
import {
  ManagedRuntimeCoordinator,
  type AcknowledgeActivationInput,
  type ActivateRevisionInput,
  type InternalContractBinding,
  type ManagedDeploymentBroker,
  type ManagedRuntimeCoordinatorEnv,
  type StageRevisionInput,
} from "./coordinator";
import { handleManagedRuntimeStateRequest } from "../../src/managed-runtime/state";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACCOUNT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CUSTOM_MCP_CAPABILITY_REQUEST_BYTES = 8 * 1024;
const MAX_CUSTOM_MCP_CAPABILITY_RESPONSE_BYTES = 64 * 1024;

function coordinatorEnvironment(
  env: ManagedRuntimeEnv,
): ManagedRuntimeCoordinatorEnv {
  return {
    RUNTIME_DB: env.RUNTIME_DB,
    STAGING_DISPATCH: env.STAGING_DISPATCH,
    PRODUCTION_DISPATCH: env.PRODUCTION_DISPATCH,
    MANAGED_DEPLOYMENT_BROKER:
      env.MANAGED_DEPLOYMENT_BROKER as unknown as ManagedDeploymentBroker,
    DENY_EGRESS_CONTRACT:
      env.DENY_EGRESS_CONTRACT as unknown as InternalContractBinding,
    CF_VERSION_METADATA: env.CF_VERSION_METADATA,
  };
}

async function readBounded(response: Response, maximumBytes: number) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_RESPONSE_BYTES ||
    !response.body
  ) {
    throw new Error("managed_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error("managed_response_too_large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Kernel-only RPC entrypoint for advanced managed revisions. The entrypoint
 * itself holds no provider credential: deployment is delegated to the exact
 * release-attested MANAGED_DEPLOYMENT_BROKER service binding, while every user
 * Worker invocation is routed through the exact DENY_EGRESS_CONTRACT release.
 */
export class ManagedRuntimeGateway extends WorkerEntrypoint<ManagedRuntimeEnv> {
  contract() {
    return createSupportEntrypointContract({
      service: "shiplet-managed-runtime-gateway",
      entrypoint: "ManagedRuntimeGateway",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  readiness(expectation: ManagedRuntimeReleaseExpectation) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).attestDependencies(
      expectation,
    );
  }

  stageRevision(
    input: StageRevisionInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).stageRevision(
      input,
      expectation,
    );
  }

  promote(
    input: ActivateRevisionInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).promote(input, expectation);
  }

  rollback(
    input: ActivateRevisionInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).rollback(
      input,
      expectation,
    );
  }

  acknowledgeActivation(
    input: AcknowledgeActivationInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).acknowledgeActivation(input, expectation);
  }

  invoke(
    input: Parameters<ManagedRuntimeCoordinator["invoke"]>[0],
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).invoke(input, expectation);
  }

  invokeValidatedRevision(
    input: Parameters<ManagedRuntimeCoordinator["invokeValidatedRevision"]>[0],
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).invokeValidatedRevision(
      input,
      expectation,
    );
  }
}

export class CloudflareVersionHealthRpc extends WorkerEntrypoint<ManagedRuntimeEnv> {
  contract() {
    return createSupportEntrypointContract({
      service: "shiplet-managed-runtime-gateway",
      entrypoint: "CloudflareVersionHealthRpc",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  async executeBytes(
    input: {
      candidateUrl: string;
      accountId: string;
      scriptName: string;
      targetId: string;
      revisionId: string;
      packageDigest: string;
      versionId: string;
      path: "/__shiplet/health";
      maximumResponseBytes: number;
    },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    let url: URL;
    try {
      url = new URL(input.candidateUrl);
    } catch {
      throw new TypeError("candidate_health_binding_invalid");
    }
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".workers.dev") ||
      url.pathname !== input.path ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !ACCOUNT_IDENTIFIER.test(input.accountId) ||
      !IDENTIFIER.test(input.scriptName) ||
      !IDENTIFIER.test(input.targetId) ||
      !IDENTIFIER.test(input.revisionId) ||
      !PACKAGE_DIGEST.test(input.packageDigest) ||
      !IDENTIFIER.test(input.versionId) ||
      input.path !== "/__shiplet/health" ||
      !Number.isSafeInteger(input.maximumResponseBytes) ||
      input.maximumResponseBytes <= 0 ||
      input.maximumResponseBytes > MAX_RESPONSE_BYTES
    ) {
      throw new TypeError("candidate_health_binding_invalid");
    }
    const response = await fetch(
      new Request(url, {
        headers: { accept: "application/json" },
        redirect: "manual",
      }),
    );
    return {
      status: response.status,
      bytes: await readBounded(response, input.maximumResponseBytes),
    };
  }
}

class CustomMcpCapabilityRpcTarget
  extends RpcTarget
  implements CustomMcpCapabilityBinding
{
  #requestCapability:
    | ((requestBytes: Uint8Array) => Promise<Uint8Array>)
    | undefined;

  constructor(
    requestCapability: (requestBytes: Uint8Array) => Promise<Uint8Array>,
  ) {
    super();
    this.#requestCapability = requestCapability;
  }

  async request(requestBytes: Uint8Array) {
    if (
      !this.#requestCapability ||
      !(requestBytes instanceof Uint8Array) ||
      requestBytes.byteLength === 0 ||
      requestBytes.byteLength > MAX_CUSTOM_MCP_CAPABILITY_REQUEST_BYTES
    ) {
      throw new TypeError("custom_mcp_capability_request_invalid");
    }
    const response = await this.#requestCapability(requestBytes.slice());
    if (
      !(response instanceof Uint8Array) ||
      response.byteLength === 0 ||
      response.byteLength > MAX_CUSTOM_MCP_CAPABILITY_RESPONSE_BYTES
    ) {
      throw new TypeError("custom_mcp_capability_response_invalid");
    }
    return response.slice();
  }

  [Symbol.dispose]() {
    const callback = this.#requestCapability as
      | (((requestBytes: Uint8Array) => Promise<Uint8Array>) & Disposable)
      | undefined;
    this.#requestCapability = undefined;
    callback?.[Symbol.dispose]?.();
  }
}

class CustomMcpInvocationRpcTarget extends RpcTarget {
  #invocation:
    | ReturnType<typeof createCustomMcpDynamicWorkerInvocation>
    | undefined;
  #capability: CustomMcpCapabilityRpcTarget | undefined;
  readonly #invocationId: string;

  constructor(input: {
    invocationId: string;
    invocation: ReturnType<typeof createCustomMcpDynamicWorkerInvocation>;
    capability: CustomMcpCapabilityRpcTarget;
  }) {
    super();
    this.#invocationId = input.invocationId;
    this.#invocation = input.invocation;
    this.#capability = input.capability;
  }

  run() {
    if (!this.#invocation) throw new Error("custom_mcp_invocation_disposed");
    return this.#invocation.run();
  }

  cancel(input: { invocationId: string; reason: "deadline_exceeded" }) {
    if (
      input?.invocationId !== this.#invocationId ||
      input.reason !== "deadline_exceeded"
    ) {
      throw new TypeError("custom_mcp_cancellation_invalid");
    }
    this.#invocation?.cancel();
  }

  [Symbol.dispose]() {
    this.#invocation?.cancel();
    this.#invocation = undefined;
    this.#capability?.[Symbol.dispose]();
    this.#capability = undefined;
  }
}

/**
 * RPC-only entrypoint for arbitrary custom MCP handlers. The Worker Loader
 * creates a per-handler-set compartment with null global outbound authority;
 * the only injected authority is this invocation's narrow capability target.
 */
export class CustomMcpRuntimeRpc extends WorkerEntrypoint<ManagedRuntimeEnv> {
  contract() {
    return createSupportEntrypointContract({
      service: "shiplet-managed-runtime-gateway",
      entrypoint: "CustomMcpRuntimeRpc",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  start(
    input: {
      binding: CustomMcpRuntimeIsolationBinding;
      invocationId: string;
      requestBytes: Uint8Array;
    },
    requestCapability: (requestBytes: Uint8Array) => Promise<Uint8Array>,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    if (typeof requestCapability !== "function") {
      throw new TypeError("custom_mcp_capability_unavailable");
    }
    const capability = new CustomMcpCapabilityRpcTarget(requestCapability);
    try {
      const invocation = createCustomMcpDynamicWorkerInvocation({
        loader: this.env.CUSTOM_MCP_LOADER,
        capability,
        binding: input.binding,
        invocationId: input.invocationId,
        requestBytes: input.requestBytes,
      });
      return new CustomMcpInvocationRpcTarget({
        invocationId: input.invocationId,
        invocation,
        capability,
      });
    } catch (error) {
      capability[Symbol.dispose]();
      throw error;
    }
  }
}

/**
 * The WFP outbound hook is the only component with RUNTIME_DB. User Workers
 * retain zero uploaded bindings: their frozen helper performs a normal fetch
 * to a reserved `.invalid` origin, and Cloudflare's documented outbound-Worker
 * path converts only that exact request into a Shiplet-scoped state operation.
 */
export default class ManagedRuntimeOutbound extends WorkerEntrypoint<ManagedRuntimeEnv> {
  fetch(request: Request) {
    if (this.env.policy !== "deny_by_default") {
      return Response.json(
        { ok: false, code: "managed_runtime_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return this.env.DENY_EGRESS.fetch(request);
    }
    if (url.origin !== "https://shiplet-state.invalid") {
      return this.env.DENY_EGRESS.fetch(request);
    }
    return handleManagedRuntimeStateRequest({
      db: this.env.RUNTIME_DB,
      request,
      context: {
        schemaVersion: "shiplet.managed-state-context/v1",
        shipletId: this.env.shiplet ?? "",
        revisionId: this.env.revision ?? "",
        packageDigest: this.env.packageDigest ?? "",
        activationGeneration: Number(this.env.generation),
        stateNamespace: this.env.stateNamespace ?? "",
        stateMode:
          this.env.stateMode === "read" ||
          this.env.stateMode === "write" ||
          this.env.stateMode === "read_write"
            ? this.env.stateMode
            : "none",
        invocationKind:
          this.env.invocationKind === "preview" ? "preview" : "active",
        invocationId: this.env.invocationId ?? "",
        actor: { kind: "shiplet", id: this.env.shiplet ?? "" },
      },
    });
  }
}
