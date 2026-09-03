import {
  createCloudflareCustomerDeploymentProvider,
  createCloudflareOpaqueTemporaryAuthorizationHandle,
  createCloudflareTemporaryClaimHandle,
  parseCloudflareJsonBytesBounded,
  type CloudflareGrantVaultResolver,
  type CloudflareRedactingFetch,
  type CloudflareTemporaryAccountBroker,
  type CloudflareVersionHealthVerifier,
} from "./cloudflare-production-adapters";
import type {
  CloudflareDeploymentProvider,
  TemporaryClaimVault,
} from "./deployment-orchestrator";
import type {
  CustomMcpRuntimeIsolationAttestationAuthority,
  CustomMcpRuntimeIsolationBinding,
  VerifiedCustomMcpRuntimeIsolation,
} from "./custom-mcp";
import type {
  SupportEntrypointContract,
  SupportReleaseExpectation,
} from "./cloudflare-support/service-contract";

/**
 * Value-free production bindings. Credential substitution stays inside the
 * grant vault and its redacting transport; Shiplet routes receive only a
 * deployment provider with capability-specific readiness.
 */
export type CloudflareDeploymentRuntimeBindings = {
  CLOUDFLARE_DEPLOYMENT_PROVIDER?: CloudflareDeploymentProvider;
  CLOUDFLARE_GRANT_VAULT_RPC?: CloudflareGrantVaultRpcBinding;
  CLOUDFLARE_VERSION_HEALTH_RPC?: CloudflareVersionHealthRpcBinding;
  CLOUDFLARE_GRANT_VAULT?: CloudflareGrantVaultResolver;
  CLOUDFLARE_VERSION_HEALTH_VERIFIER?: CloudflareVersionHealthVerifier;
  CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER?: CloudflareTemporaryAccountBroker;
  CLOUDFLARE_TEMPORARY_ACCOUNT_RPC?: CloudflareTemporaryAccountRpcBinding;
  CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN?: string;
  CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS?:
    | "disabled"
    | "operator_smoke"
    | "enabled";
  CLOUDFLARE_CONTROL_PLANE_VERSION_ID?: string;
  CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID?: string;
  CLOUDFLARE_SUPPORT_RELEASE_TAG?: string;
};

export type CloudflareRpcByteResponse = Readonly<{
  status: number;
  bytes: Uint8Array;
}>;

type CloudflareGrantBinding = Parameters<
  CloudflareGrantVaultResolver["withGrant"]
>[0];
type CloudflareRedactingRequest = Parameters<
  CloudflareRedactingFetch["request"]
>[0];
type CloudflareStaticAssetUploadRequest = Parameters<
  CloudflareRedactingFetch["uploadStaticAssets"]
>[0];
type CloudflareVersionHealthRequest = Parameters<
  CloudflareVersionHealthVerifier["execute"]
>[0];

export type CloudflareGrantTransportRpc = {
  requestBytes(
    input: CloudflareRedactingRequest,
  ): Promise<CloudflareRpcByteResponse>;
  uploadStaticAssets(
    input: CloudflareStaticAssetUploadRequest,
  ): ReturnType<CloudflareRedactingFetch["uploadStaticAssets"]>;
};

export type CloudflareGrantVaultRpcBinding = {
  contract?(): Promise<SupportEntrypointContract> | SupportEntrypointContract;
  withGrant<Result>(
    binding: CloudflareGrantBinding,
    operation: (transport: CloudflareGrantTransportRpc) => Promise<Result>,
    expectation: SupportReleaseExpectation,
  ): Promise<Result>;
};

export type CloudflareVersionHealthRpcBinding = {
  contract?(): Promise<SupportEntrypointContract> | SupportEntrypointContract;
  executeBytes(
    input: CloudflareVersionHealthRequest,
    expectation: SupportReleaseExpectation,
  ): Promise<CloudflareRpcByteResponse>;
};

type TemporaryBrokerCreateInput = Parameters<
  CloudflareTemporaryAccountBroker["createAndDeploy"]
>[0];
type TemporaryBrokerCleanupInput = Parameters<
  CloudflareTemporaryAccountBroker["cleanup"]
>[0];
type TemporaryBrokerBinding = Awaited<
  ReturnType<CloudflareTemporaryAccountBroker["createAndDeploy"]>
>["binding"];

export type CloudflareTemporaryAccountRpcBinding = {
  contract?(): Promise<SupportEntrypointContract> | SupportEntrypointContract;
  createAndDeploy(
    input: TemporaryBrokerCreateInput,
    expectation: SupportReleaseExpectation,
  ): Promise<{
    providerDeploymentId: string;
    providerVersionId: string;
    selectedVersionId: string;
    temporaryAuthorizationRef: string;
    claimRef: string;
    binding: TemporaryBrokerBinding;
    expiresAt: number;
    serializedBodyBytes: number;
  }>;
  cleanup(
    input: TemporaryBrokerCleanupInput,
    expectation: SupportReleaseExpectation,
  ): ReturnType<CloudflareTemporaryAccountBroker["cleanup"]>;
  storeClaim(
    input: {
      targetId: string;
      temporaryAuthorizationRef: string;
      claimRef: string;
      expiresAt: number;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<{ ref: string }>;
  consumeForBackendRedirect(
    input: { ref: string; now: number },
    markDelivered: Parameters<
      TemporaryClaimVault["consumeForBackendRedirect"]
    >[0]["markDelivered"],
    expectation: SupportReleaseExpectation,
  ): ReturnType<TemporaryClaimVault["consumeForBackendRedirect"]>;
  redeemBackendRedirect(
    input: { opaqueHandle: string },
    expectation: SupportReleaseExpectation,
  ): Promise<Response | null>;
};

type CloudflareCustomMcpInvocationRpc = {
  run(): Promise<Uint8Array>;
  cancel(input: {
    invocationId: string;
    reason: "deadline_exceeded";
  }): void | Promise<void>;
  [Symbol.dispose]?: () => void;
};

export type CloudflareCustomMcpRuntimeRpcBinding = {
  contract?(): Promise<SupportEntrypointContract> | SupportEntrypointContract;
  start(
    input: {
      binding: CustomMcpRuntimeIsolationBinding;
      invocationId: string;
      requestBytes: Uint8Array;
    },
    requestCapability?: (requestBytes: Uint8Array) => Promise<Uint8Array>,
    expectation?: SupportReleaseExpectation,
  ): Promise<CloudflareCustomMcpInvocationRpc>;
};

export type ResolvedCloudflareDeploymentRuntime = Readonly<{
  customerProvider: CloudflareDeploymentProvider | undefined;
  customerReady: boolean;
  temporaryProvider: CloudflareDeploymentProvider | undefined;
  temporaryReady: boolean;
}>;

function validTrustedControlPlaneOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

const MAX_RPC_RESPONSE_BYTES = 1024 * 1024;

function locallyAttestRpcResponse(
  response: CloudflareRpcByteResponse,
  maximumBytes: number,
) {
  if (
    !response ||
    typeof response !== "object" ||
    Reflect.ownKeys(response).length !== 2 ||
    !Number.isSafeInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    !(response.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_RPC_RESPONSE_BYTES
  ) {
    throw new TypeError("invalid_cloudflare_rpc_response");
  }
  return parseCloudflareJsonBytesBounded(
    { status: response.status, bytes: response.bytes },
    maximumBytes,
  );
}

function grantVaultFromRpc(
  rpc: CloudflareGrantVaultRpcBinding,
  expectation: SupportReleaseExpectation,
): CloudflareGrantVaultResolver {
  return Object.freeze({
    async withGrant<Result>(
      binding: CloudflareGrantBinding,
      operation: (fetch: CloudflareRedactingFetch) => Promise<Result>,
    ): Promise<Result> {
      return rpc.withGrant(
        binding,
        async (transport) =>
          operation(
            Object.freeze({
              async request(request: CloudflareRedactingRequest) {
                return locallyAttestRpcResponse(
                  await transport.requestBytes(request),
                  MAX_RPC_RESPONSE_BYTES,
                );
              },
              uploadStaticAssets: (
                request: CloudflareStaticAssetUploadRequest,
              ) => transport.uploadStaticAssets(request),
            }),
          ),
        expectation,
      );
    },
  });
}

function versionHealthFromRpc(
  rpc: CloudflareVersionHealthRpcBinding,
  expectation: SupportReleaseExpectation,
): CloudflareVersionHealthVerifier {
  return Object.freeze({
    async execute(input: CloudflareVersionHealthRequest) {
      return locallyAttestRpcResponse(
        await rpc.executeBytes(input, expectation),
        input.maximumResponseBytes,
      );
    },
  });
}

const RPC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RPC_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactRpcObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && keys.includes(key),
    )
  );
}

function validTemporaryRpcBinding(
  value: unknown,
): value is TemporaryBrokerBinding {
  return (
    exactRpcObject(value, [
      "userId",
      "shipletId",
      "accountHandle",
      "targetId",
      "scriptName",
      "revisionId",
      "packageDigest",
      "requestDigest",
      "operationId",
    ]) && Object.values(value).every((item) => typeof item === "string")
  );
}

function trustedClaimRoute(value: URL, origin: string) {
  return (
    value.origin === origin &&
    value.pathname === "/api/cloudflare/temporary/claim" &&
    value.username === "" &&
    value.password === "" &&
    value.hash === "" &&
    [...value.searchParams.keys()].length === 1 &&
    value.searchParams.has("handle")
  );
}

function validClaimRedirect(response: Response) {
  const location = response.headers.get("location");
  if (
    response.status !== 303 ||
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("referrer-policy") !== "no-referrer" ||
    !location
  ) {
    return false;
  }
  try {
    const url = new URL(location);
    return (
      url.protocol === "https:" &&
      url.hostname === "dash.cloudflare.com" &&
      url.pathname === "/claim-preview" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      [...url.searchParams.keys()].length === 1 &&
      typeof url.searchParams.get("claimToken") === "string" &&
      (url.searchParams.get("claimToken")?.length ?? 0) >= 16
    );
  } catch {
    return false;
  }
}

const MAX_CUSTOM_MCP_RPC_REQUEST_BYTES = 128 * 1024;
const MAX_CUSTOM_MCP_RPC_RESPONSE_BYTES = 64 * 1024;

/**
 * Keeps each remote invocation stub request-local so cancellation addresses
 * the exact Dynamic Worker execution rather than a shared deployment name.
 */
export function createCloudflareCustomMcpRpcIsolation(input: {
  rpc: CloudflareCustomMcpRuntimeRpcBinding;
  attestationAuthority: CustomMcpRuntimeIsolationAttestationAuthority;
  expectation: SupportReleaseExpectation;
}): VerifiedCustomMcpRuntimeIsolation {
  if (
    typeof input.rpc?.start !== "function" ||
    typeof input.attestationAuthority?.issue !== "function"
  ) {
    throw new TypeError("custom_mcp_rpc_unavailable");
  }
  return Object.freeze({
    bind(binding: CustomMcpRuntimeIsolationBinding) {
      const inFlight = new Map<
        string,
        Promise<CloudflareCustomMcpInvocationRpc>
      >();
      const canceled = new Set<string>();
      return Object.freeze({
        attestation: input.attestationAuthority.issue(binding),
        transport: Object.freeze({
          async invoke(request: {
            invocationId: string;
            requestBytes: Uint8Array;
            requestCapability?: (
              requestBytes: Uint8Array,
            ) => Promise<Uint8Array>;
          }) {
            if (
              !RPC_IDENTIFIER.test(request.invocationId) ||
              !(request.requestBytes instanceof Uint8Array) ||
              request.requestBytes.byteLength === 0 ||
              request.requestBytes.byteLength >
                MAX_CUSTOM_MCP_RPC_REQUEST_BYTES ||
              inFlight.has(request.invocationId)
            ) {
              throw new TypeError("custom_mcp_rpc_invocation_invalid");
            }
            const pending = input.rpc.start(
              {
                binding: structuredClone(binding),
                invocationId: request.invocationId,
                requestBytes: request.requestBytes.slice(),
              },
              request.requestCapability,
              input.expectation,
            );
            inFlight.set(request.invocationId, pending);
            let invocation: CloudflareCustomMcpInvocationRpc | undefined;
            try {
              invocation = await pending;
              if (
                typeof invocation?.run !== "function" ||
                typeof invocation.cancel !== "function"
              ) {
                throw new TypeError("custom_mcp_rpc_handle_invalid");
              }
              if (canceled.has(request.invocationId)) {
                await invocation.cancel({
                  invocationId: request.invocationId,
                  reason: "deadline_exceeded",
                });
              }
              const response = await invocation.run();
              if (
                !(response instanceof Uint8Array) ||
                response.byteLength === 0 ||
                response.byteLength > MAX_CUSTOM_MCP_RPC_RESPONSE_BYTES
              ) {
                throw new TypeError("custom_mcp_rpc_response_invalid");
              }
              return response.slice();
            } finally {
              inFlight.delete(request.invocationId);
              canceled.delete(request.invocationId);
              invocation?.[Symbol.dispose]?.();
            }
          },
          async cancel(request: {
            invocationId: string;
            reason: "deadline_exceeded";
          }) {
            if (
              !RPC_IDENTIFIER.test(request.invocationId) ||
              request.reason !== "deadline_exceeded"
            ) {
              return;
            }
            canceled.add(request.invocationId);
            const pending = inFlight.get(request.invocationId);
            if (!pending) return;
            const invocation = await pending;
            await invocation.cancel({ ...request });
          },
        }),
      });
    },
  });
}

/**
 * Converts serializable service-binding references into kernel-local opaque
 * identities. Provider credentials and the Cloudflare claim URL remain owned
 * by the remote control-plane Worker.
 */
export function createCloudflareTemporaryRpcComposition(input: {
  rpc: CloudflareTemporaryAccountRpcBinding;
  trustedControlPlaneOrigin: string;
  expectation: SupportReleaseExpectation;
}): {
  broker: CloudflareTemporaryAccountBroker;
  claimVault: TemporaryClaimVault;
} {
  if (!validTrustedControlPlaneOrigin(input.trustedControlPlaneOrigin)) {
    throw new TypeError("temporary_rpc_origin_invalid");
  }
  const authorizations = new WeakMap<object, string>();
  const claimHandles = new Map<string, string>();
  const broker: CloudflareTemporaryAccountBroker = Object.freeze({
    async createAndDeploy(request: TemporaryBrokerCreateInput) {
      const result = await input.rpc.createAndDeploy(
        structuredClone(request),
        input.expectation,
      );
      if (
        !exactRpcObject(result, [
          "providerDeploymentId",
          "providerVersionId",
          "selectedVersionId",
          "temporaryAuthorizationRef",
          "claimRef",
          "binding",
          "expiresAt",
          "serializedBodyBytes",
        ]) ||
        typeof result.providerDeploymentId !== "string" ||
        !RPC_UUID.test(result.providerDeploymentId) ||
        typeof result.providerVersionId !== "string" ||
        !RPC_UUID.test(result.providerVersionId) ||
        result.selectedVersionId !== result.providerVersionId ||
        typeof result.temporaryAuthorizationRef !== "string" ||
        !RPC_IDENTIFIER.test(result.temporaryAuthorizationRef) ||
        typeof result.claimRef !== "string" ||
        !RPC_IDENTIFIER.test(result.claimRef) ||
        !validTemporaryRpcBinding(result.binding) ||
        !Number.isSafeInteger(result.expiresAt) ||
        !Number.isSafeInteger(result.serializedBodyBytes) ||
        result.serializedBodyBytes <= 0 ||
        result.serializedBodyBytes > MAX_RPC_RESPONSE_BYTES
      ) {
        throw new TypeError("temporary_rpc_response_invalid");
      }
      const temporaryAuthorizationHandle =
        createCloudflareOpaqueTemporaryAuthorizationHandle();
      const claimHandle = createCloudflareTemporaryClaimHandle();
      authorizations.set(
        temporaryAuthorizationHandle,
        result.temporaryAuthorizationRef,
      );
      claimHandles.set(claimHandle, result.claimRef);
      return {
        providerDeploymentId: result.providerDeploymentId,
        providerVersionId: result.providerVersionId,
        selectedVersionId: result.selectedVersionId,
        temporaryAuthorizationHandle,
        claimHandle,
        binding: structuredClone(result.binding),
        expiresAt: result.expiresAt,
        serializedBodyBytes: result.serializedBodyBytes,
      };
    },
    cleanup(request: TemporaryBrokerCleanupInput) {
      return input.rpc.cleanup(structuredClone(request), input.expectation);
    },
  });
  const claimVault: TemporaryClaimVault = Object.freeze({
    async store(request: Parameters<TemporaryClaimVault["store"]>[0]) {
      const temporaryAuthorizationRef = authorizations.get(
        request.temporaryAuthorization,
      );
      const localClaimHandle = request.claimUrl.searchParams.get("handle");
      const claimRef = localClaimHandle
        ? claimHandles.get(localClaimHandle)
        : undefined;
      if (
        !RPC_IDENTIFIER.test(request.targetId) ||
        !temporaryAuthorizationRef ||
        !claimRef ||
        !trustedClaimRoute(request.claimUrl, input.trustedControlPlaneOrigin) ||
        !Number.isSafeInteger(request.expiresAt)
      ) {
        throw new TypeError("temporary_claim_binding_invalid");
      }
      const stored = await input.rpc.storeClaim(
        {
          targetId: request.targetId,
          temporaryAuthorizationRef,
          claimRef,
          expiresAt: request.expiresAt,
        },
        input.expectation,
      );
      if (
        !exactRpcObject(stored, ["ref"]) ||
        typeof stored.ref !== "string" ||
        !RPC_IDENTIFIER.test(stored.ref)
      ) {
        throw new TypeError("temporary_claim_store_invalid");
      }
      authorizations.delete(request.temporaryAuthorization);
      claimHandles.delete(localClaimHandle!);
      return stored.ref;
    },
    async consumeForBackendRedirect(
      request: Parameters<TemporaryClaimVault["consumeForBackendRedirect"]>[0],
    ) {
      if (
        !RPC_IDENTIFIER.test(request.ref) ||
        !Number.isSafeInteger(request.now)
      ) {
        return {
          ok: false as const,
          reason: "temporary_claim_binding_invalid",
        };
      }
      const result = await input.rpc.consumeForBackendRedirect(
        { ref: request.ref, now: request.now },
        request.markDelivered,
        input.expectation,
      );
      if (
        result.ok !== true ||
        !exactRpcObject(result, ["ok", "redirect"]) ||
        !exactRpcObject(result.redirect, ["kind", "opaqueHandle"]) ||
        result.redirect.kind !== "trusted_backend_redirect" ||
        typeof result.redirect.opaqueHandle !== "string" ||
        !RPC_IDENTIFIER.test(result.redirect.opaqueHandle)
      ) {
        return {
          ok: false as const,
          reason:
            result &&
            typeof result === "object" &&
            "reason" in result &&
            typeof result.reason === "string" &&
            RPC_IDENTIFIER.test(result.reason)
              ? result.reason
              : "temporary_claim_rpc_invalid",
        };
      }
      return structuredClone(result);
    },
    async redeemBackendRedirect(
      request: Parameters<TemporaryClaimVault["redeemBackendRedirect"]>[0],
    ) {
      if (!RPC_IDENTIFIER.test(request.opaqueHandle)) return null;
      const response = await input.rpc.redeemBackendRedirect(
        { opaqueHandle: request.opaqueHandle },
        input.expectation,
      );
      return response && validClaimRedirect(response) ? response : null;
    },
  });
  return Object.freeze({ broker, claimVault });
}

export function resolveCloudflareDeploymentRuntime(
  bindings: CloudflareDeploymentRuntimeBindings,
  now: () => number,
): ResolvedCloudflareDeploymentRuntime {
  const controlPlaneExpectation: SupportReleaseExpectation = Object.freeze({
    versionId: bindings.CLOUDFLARE_CONTROL_PLANE_VERSION_ID ?? "",
    versionTag: bindings.CLOUDFLARE_SUPPORT_RELEASE_TAG ?? "",
  });
  const runtimeGatewayExpectation: SupportReleaseExpectation = Object.freeze({
    versionId: bindings.CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID ?? "",
    versionTag: bindings.CLOUDFLARE_SUPPORT_RELEASE_TAG ?? "",
  });
  const explicit = bindings.CLOUDFLARE_DEPLOYMENT_PROVIDER;
  const temporaryAccountsEnabled =
    bindings.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "enabled";
  if (explicit) {
    return Object.freeze({
      customerProvider: explicit,
      customerReady: true,
      temporaryProvider: temporaryAccountsEnabled ? explicit : undefined,
      temporaryReady: temporaryAccountsEnabled,
    });
  }

  const grants = bindings.CLOUDFLARE_GRANT_VAULT_RPC
    ? grantVaultFromRpc(
        bindings.CLOUDFLARE_GRANT_VAULT_RPC,
        controlPlaneExpectation,
      )
    : bindings.CLOUDFLARE_GRANT_VAULT;
  if (!grants) {
    return Object.freeze({
      customerProvider: undefined,
      customerReady: false,
      temporaryProvider: undefined,
      temporaryReady: false,
    });
  }

  const temporaryReady = Boolean(
    temporaryAccountsEnabled &&
    bindings.CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER &&
    validTrustedControlPlaneOrigin(
      bindings.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN,
    ),
  );
  const versionHealth = bindings.CLOUDFLARE_VERSION_HEALTH_RPC
    ? versionHealthFromRpc(
        bindings.CLOUDFLARE_VERSION_HEALTH_RPC,
        runtimeGatewayExpectation,
      )
    : bindings.CLOUDFLARE_VERSION_HEALTH_VERIFIER;
  const provider = createCloudflareCustomerDeploymentProvider({
    now,
    grants,
    ...(versionHealth
      ? {
          versionHealthVerifier: versionHealth,
        }
      : {}),
    ...(temporaryReady
      ? {
          temporaryAccounts: bindings.CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER!,
          trustedControlPlaneOrigin:
            bindings.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN!,
        }
      : {}),
  });

  const customerReady = Boolean(versionHealth);
  return Object.freeze({
    customerProvider: customerReady ? provider : undefined,
    customerReady,
    temporaryProvider: temporaryReady ? provider : undefined,
    temporaryReady,
  });
}
