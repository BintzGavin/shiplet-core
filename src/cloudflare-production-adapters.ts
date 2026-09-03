/**
 * Production boundary adapters for Cloudflare public OAuth and customer-owned
 * Workers. Credential-bearing HTTP remains behind the injected redacting fetch
 * and opaque vault resolver; this module never receives an access token.
 *
 * Current endpoint contracts:
 * https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
 * https://developers.cloudflare.com/workers/static-assets/direct-upload/
 * https://developers.cloudflare.com/workers/platform/claim-deployments/
 */

import type { CloudflareOAuthProvider } from "./cloudflare-oauth";
import type { ProviderAuthorization } from "./deployment-orchestrator";

export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4";

export const CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS = Object.freeze({
  authorization: "https://dash.cloudflare.com/oauth2/auth",
  token: "https://dash.cloudflare.com/oauth2/token",
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
});

export const CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES = Object.freeze([
  "offline_access",
  "workers.scripts.read",
  "workers.scripts.write",
] as const);

/** Kernel-internal capability scopes. These are not Cloudflare OAuth scopes. */
export const CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES = Object.freeze({
  create: ["temporary.accounts.create", "temporary.workers.deploy"],
  cleanup: ["temporary.workers.cleanup"],
} as const);

/**
 * Customer-owned Workers retain the customer's normal fetch authority. Shiplet
 * does not claim that package metadata can enforce an outbound-network deny.
 */
export const CLOUDFLARE_CUSTOMER_WORKER_EGRESS_ENFORCEMENT =
  "customer_controlled_unrestricted" as const;

export const CLOUDFLARE_TEMPORARY_TRUSTED_CLAIM_ROUTE =
  "/api/cloudflare/temporary/claim" as const;

export const CLOUDFLARE_PRODUCTION_PREREQUISITES = Object.freeze({
  workerVersionApi: {
    primary: "workers.scripts.versions",
    stability: "stable",
    betaUsage: "version_preview_and_delete_only",
  },
  oauthClientRegistration: {
    status: "exact_registration_required",
    source: "operator_verified_cloudflare_client",
    scopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
  },
  candidateExecution: {
    status: "version_preview_health_verifier_required",
    documentation:
      "https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/",
  },
} as const);

type CloudflareAllowedOAuthScope =
  (typeof CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES)[number];

export type CloudflarePackageModule = {
  name: string;
  mediaType: string;
  content: string;
  encoding?: "utf8" | "base64";
};

export type CloudflareStaticAsset = {
  path: string;
  mediaType: string;
  content: string;
  encoding?: "utf8" | "base64";
};

export type CloudflareScopedBinding =
  | { name: string; kind: "plain_text"; value: string }
  | {
      name: string;
      kind: "d1" | "r2" | "durable_object";
      providerResourceId: string;
    };

export type CloudflareRequestScope = {
  actorId: string;
  shipletId: string;
  targetId: string;
  accountId: string;
  scriptName: string;
};

export type CloudflareImmutableRevisionScope = CloudflareRequestScope & {
  revisionId: string;
  packageDigest: string;
};

export type CloudflareWorkerLimits = {
  cpuMs: number;
  subRequests: number;
};

export type CloudflareCustomerEgressStatus = {
  status: typeof CLOUDFLARE_CUSTOMER_WORKER_EGRESS_ENFORCEMENT;
};

export type CloudflareInspectRequest = CloudflareRequestScope;

export type CloudflareInitializeRequest = CloudflareRequestScope & {
  bootstrap: { kind: "inert_known_good" };
  bindings: CloudflareScopedBinding[];
};

export type CloudflareUploadVersionRequest =
  CloudflareImmutableRevisionScope & {
    mainModule: string;
    modules: CloudflarePackageModule[];
    staticAssets: CloudflareStaticAsset[];
    bindings: CloudflareScopedBinding[];
    limits: CloudflareWorkerLimits;
    egress: CloudflareCustomerEgressStatus;
  };

export type CloudflareCandidateProofRequest =
  CloudflareImmutableRevisionScope & {
    versionId: string;
    healthCheck: {
      path: "/__shiplet/health";
      expectedStatus: 200;
    };
  };

export type CloudflareCreateDeploymentRequest =
  CloudflareImmutableRevisionScope & {
    versionId: string;
    percentage: 100;
  };

export type CloudflareCleanupVersionRequest =
  CloudflareImmutableRevisionScope & {
    versionId: string;
  };

export type CloudflareTemporaryCreateRequest =
  CloudflareImmutableRevisionScope & {
    operationId: string;
    termsOfService: "https://www.cloudflare.com/terms/";
    privacyPolicy: "https://www.cloudflare.com/privacypolicy/";
    acceptTermsOfService: "yes";
    modules: [];
    staticAssets: CloudflareStaticAsset[];
    bindings: [];
  };

export type CloudflareTemporaryCleanupRequest =
  CloudflareImmutableRevisionScope & {
    operationId: string;
    providerDeploymentId: string;
    providerVersionId: string;
  };

export type CloudflareProviderEnvelope<Request extends object> = {
  authorization: ProviderAuthorization;
  request: Request;
} & Request;

export type CloudflareOAuthClientRegistrationAssertion = {
  source: "cloudflare_oauth_client_registration";
  verifiedAt: number;
  scopes: string[];
};

export class CloudflareProductionAdapterError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CloudflareProductionAdapterError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new CloudflareProductionAdapterError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CONTROL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACCOUNT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const BINDING_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const OAUTH_VALUE = /^[\x21-\x7e]{1,4096}$/;
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MEDIA_TYPE =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[ \t]*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;
const PACKAGE_PATH_CONTROL = /[\u0000-\u001f\u007f]/u;
const VERSION_CLAIM_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const MAIN_MODULE_MEDIA_TYPES = new Set([
  "application/javascript+module",
  "text/javascript+module",
]);
const MAX_MODULES = 1_000;
const MAX_ASSETS = 10_000;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_TEMPORARY_RESPONSE_BYTES = 256 * 1024;
const MAX_TEMPORARY_ASSETS = 1_000;
const MAX_TEMPORARY_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TEMPORARY_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_TEMPORARY_BODY_BYTES = 64 * 1024 * 1024;
const MAX_TEMPORARY_CLAIM_LIFETIME_MS = 60 * 60 * 1_000;
const MAX_TEMPORARY_WORK = 64_000_000;
const MAX_TEMPORARY_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const RESERVED_BINDINGS = new Set([
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_OAUTH_TOKEN",
  "PLATFORM_DB",
  "SHARED_D1",
  "SHARED_R2",
  "SHARED_DO",
  "ASSETS",
  "CF_VERSION_METADATA",
]);

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validSerializedBodyBytes(value: unknown, maximum: number) {
  return safeInteger(value) && value >= 0 && value <= maximum;
}

function trustedNow(now: () => number) {
  const value = now();
  if (!safeInteger(value) || value < 0) fail("kernel_clock_invalid");
  return value;
}

function exactUniqueScopes(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (
    value.some((scope) => typeof scope !== "string" || scope.trim() !== scope)
  ) {
    return false;
  }
  return new Set(value).size === value.length;
}

function normalizeScopes(value: string[]) {
  return [...value].sort();
}

function validAllowedScopes(
  value: unknown,
  allowed: ReadonlySet<string>,
): value is CloudflareAllowedOAuthScope[] {
  return exactUniqueScopes(value) && value.every((scope) => allowed.has(scope));
}

function validHttpsUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      parsed.toString() === value
    );
  } catch {
    return false;
  }
}

export type CloudflareOAuthRedactingFetch = {
  exchange(input: {
    endpoint: typeof CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token;
    method: "POST";
    contentType: "application/x-www-form-urlencoded";
    grantType: "authorization_code";
    clientId: string;
    form: string;
    redactedFields: ["code", "code_verifier"];
  }): Promise<{
    material: object;
    accounts: Array<{ id: string; label: string }>;
    scopes: string[];
    expiresAt: number;
    serializedBodyBytes: number;
  }>;
  refresh(input: {
    endpoint: typeof CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token;
    method: "POST";
    contentType: "application/x-www-form-urlencoded";
    grantType: "refresh_token";
    clientId: string;
    form: string;
    opaqueSubstitution: { field: "refresh_token"; material: object };
  }): Promise<{
    material: object;
    expiresAt: number;
    serializedBodyBytes: number;
  }>;
  revoke(input: {
    endpoint: typeof CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.revoke;
    method: "POST";
    contentType: "application/x-www-form-urlencoded";
    clientId: string;
    form: string;
    opaqueSubstitution: { field: "token"; material: object };
  }): Promise<{ serializedBodyBytes: number }>;
};

export type CloudflarePublicOAuthProviderDependencies = {
  clientId: string;
  redirectUris: string[];
  allowedScopes: string[];
  clientRegistration?: CloudflareOAuthClientRegistrationAssertion;
  now(): number;
  fetch: CloudflareOAuthRedactingFetch;
};

function assertOAuthConfiguration(
  input: CloudflarePublicOAuthProviderDependencies,
) {
  const known = new Set<string>(CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES);
  const observedAt = trustedNow(input.now);
  const registration = input.clientRegistration;
  if (
    !registration ||
    registration.source !== "cloudflare_oauth_client_registration" ||
    !safeInteger(registration.verifiedAt) ||
    registration.verifiedAt <= 0 ||
    registration.verifiedAt > observedAt ||
    !exactUniqueScopes(registration.scopes) ||
    canonicalJson(normalizeScopes(registration.scopes)) !==
      canonicalJson(normalizeScopes([...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES]))
  ) {
    throw new TypeError("cloudflare_oauth_client_registration_prerequisite");
  }
  if (
    !CONTROL_IDENTIFIER.test(input.clientId) ||
    input.redirectUris.length === 0 ||
    new Set(input.redirectUris).size !== input.redirectUris.length ||
    input.redirectUris.some((uri) => !validHttpsUrl(uri)) ||
    !validAllowedScopes(input.allowedScopes, known) ||
    canonicalJson(normalizeScopes(input.allowedScopes)) !==
      canonicalJson(normalizeScopes([...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES]))
  ) {
    throw new TypeError("invalid_cloudflare_oauth_configuration");
  }
}

function validateOAuthResponse(
  input: {
    material: object;
    accounts: Array<{ id: string; label: string }>;
    scopes: string[];
    expiresAt: number;
    serializedBodyBytes: number;
  },
  allowed: ReadonlySet<string>,
  now: number,
) {
  if (
    !isRecord(input.material) ||
    !Array.isArray(input.accounts) ||
    input.accounts.length !== 1 ||
    !ACCOUNT_IDENTIFIER.test(input.accounts[0]?.id ?? "") ||
    typeof input.accounts[0]?.label !== "string" ||
    input.accounts[0].label.trim().length === 0 ||
    input.accounts[0].label.length > 256 ||
    !validAllowedScopes(input.scopes, allowed) ||
    !safeInteger(input.expiresAt) ||
    input.expiresAt <= now ||
    !validSerializedBodyBytes(
      input.serializedBodyBytes,
      MAX_OAUTH_RESPONSE_BYTES,
    )
  ) {
    fail("oauth_response_invalid");
  }
}

function formEncode(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

export function createCloudflarePublicOAuthProvider(
  dependencies: CloudflarePublicOAuthProviderDependencies,
): CloudflareOAuthProvider<object> {
  assertOAuthConfiguration(dependencies);
  const redirects = new Set(dependencies.redirectUris);
  const allowed = new Set(dependencies.allowedScopes);
  const assertRedirect = (value: string) => {
    if (!redirects.has(value)) fail("oauth_request_invalid");
  };

  return {
    async createAuthorizationUrl(input) {
      if (
        input.clientId !== dependencies.clientId ||
        !redirects.has(input.redirectUri) ||
        !OAUTH_VALUE.test(input.state) ||
        !BASE64URL.test(input.codeChallenge) ||
        input.codeChallenge.length !== 43 ||
        input.codeChallengeMethod !== "S256" ||
        !validAllowedScopes(input.scopes, allowed)
      ) {
        fail("oauth_request_invalid");
      }
      const url = new URL(CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.authorization);
      url.searchParams.set("client_id", dependencies.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", normalizeScopes(input.scopes).join(" "));
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    async exchangeAuthorization(input) {
      assertRedirect(input.redirectUri);
      if (
        !OAUTH_VALUE.test(input.authorizationCode) ||
        !PKCE_VALUE.test(input.codeVerifier)
      ) {
        fail("oauth_request_invalid");
      }
      let response: Awaited<
        ReturnType<CloudflareOAuthRedactingFetch["exchange"]>
      >;
      try {
        response = await dependencies.fetch.exchange({
          endpoint: CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          grantType: "authorization_code",
          clientId: dependencies.clientId,
          form: formEncode({
            client_id: dependencies.clientId,
            code: input.authorizationCode,
            code_verifier: input.codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: input.redirectUri,
          }),
          redactedFields: ["code", "code_verifier"],
        });
      } catch {
        fail("oauth_exchange_failed");
      }
      validateOAuthResponse(response, allowed, trustedNow(dependencies.now));
      const account = response.accounts[0]!;
      return {
        material: response.material,
        accountId: account.id,
        accountLabel: account.label.trim(),
        scopes: normalizeScopes(response.scopes),
        expiresAt: response.expiresAt,
      };
    },

    async refresh(material) {
      if (!isRecord(material)) fail("oauth_request_invalid");
      let response: Awaited<
        ReturnType<CloudflareOAuthRedactingFetch["refresh"]>
      >;
      try {
        response = await dependencies.fetch.refresh({
          endpoint: CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          grantType: "refresh_token",
          clientId: dependencies.clientId,
          form: formEncode({
            client_id: dependencies.clientId,
            grant_type: "refresh_token",
          }),
          opaqueSubstitution: { field: "refresh_token", material },
        });
      } catch {
        fail("oauth_refresh_failed");
      }
      if (
        !isRecord(response.material) ||
        !safeInteger(response.expiresAt) ||
        response.expiresAt <= trustedNow(dependencies.now) ||
        !validSerializedBodyBytes(
          response.serializedBodyBytes,
          MAX_OAUTH_RESPONSE_BYTES,
        )
      ) {
        fail("oauth_response_invalid");
      }
      return { material: response.material, expiresAt: response.expiresAt };
    },

    async revoke(material) {
      if (!isRecord(material)) fail("oauth_request_invalid");
      let response: Awaited<
        ReturnType<CloudflareOAuthRedactingFetch["revoke"]>
      >;
      try {
        response = await dependencies.fetch.revoke({
          endpoint: CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.revoke,
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
          clientId: dependencies.clientId,
          form: formEncode({ client_id: dependencies.clientId }),
          opaqueSubstitution: { field: "token", material },
        });
      } catch {
        fail("oauth_revoke_failed");
      }
      if (
        !validSerializedBodyBytes(
          response.serializedBodyBytes,
          MAX_OAUTH_RESPONSE_BYTES,
        )
      ) {
        fail("oauth_response_invalid");
      }
    },
  };
}

export type CloudflareRedactingRequest = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  body?:
    | { kind: "json"; value: Record<string, unknown> }
    | {
        kind: "worker_version";
        serialization: {
          kind: "cloudflare_worker_version_multipart";
          completionAssertion: "opaque_transport_substitution";
        };
        metadata: Record<string, unknown>;
        modules: Array<{
          name: string;
          mediaType: string;
          content: string;
          encoding?: "utf8" | "base64";
        }>;
        assetCompletion?: object;
      };
};

export type CloudflareRedactingResponse = {
  status: number;
  body: unknown;
  /** Byte count established by the bounded reader before JSON parsing. */
  serializedBodyBytes: number;
  /** Opaque proof that this module's bounded reader enforced the byte cap. */
  boundedBodyProof: object;
};

const BOUNDED_RESPONSE_PROOFS = new WeakSet<object>();
const BOUNDED_RESPONSES = new WeakSet<CloudflareRedactingResponse>();

function boundedResponseProof() {
  const proof = Object.freeze(Object.create(null)) as object;
  BOUNDED_RESPONSE_PROOFS.add(proof);
  return proof;
}

function assertResponseLimit(maximumBytes: number) {
  if (
    !safeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new TypeError("invalid_provider_response_limit");
  }
}

export function parseCloudflareJsonBytesBounded(
  input: {
    status: number;
    bytes: Uint8Array;
  },
  maximumBytes: number,
): CloudflareRedactingResponse {
  assertResponseLimit(maximumBytes);
  if (input.bytes.byteLength > maximumBytes) {
    fail("provider_response_too_large");
  }
  let body: unknown;
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(
      input.bytes,
    );
    body = JSON.parse(serialized) as unknown;
  } catch {
    fail("provider_response_invalid");
  }
  const response = Object.freeze({
    status: input.status,
    body,
    serializedBodyBytes: input.bytes.byteLength,
    boundedBodyProof: boundedResponseProof(),
  });
  BOUNDED_RESPONSES.add(response);
  return response;
}

export async function readCloudflareJsonResponseBounded(
  response: Response,
  maximumBytes: number,
): Promise<CloudflareRedactingResponse> {
  assertResponseLimit(maximumBytes);
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!safeInteger(parsedLength) || parsedLength < 0) {
      fail("provider_response_invalid");
    }
    if (parsedLength > maximumBytes) fail("provider_response_too_large");
  }
  if (!response.body) fail("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        fail("provider_response_too_large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof CloudflareProductionAdapterError) throw error;
    fail("provider_response_invalid");
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseCloudflareJsonBytesBounded(
    { status: response.status, bytes },
    maximumBytes,
  );
}

export type CloudflareRedactingFetch = {
  /** Sends an already-authorized request without making authority headers observable. */
  request(
    input: CloudflareRedactingRequest,
  ): Promise<CloudflareRedactingResponse>;
  /**
   * Owns the manifest/upload-session exchange and converts its short-lived JWT
   * into an opaque completion object. `request()` must replace that object with
   * the JWT only inside the transport when serializing a Worker version.
   */
  uploadStaticAssets(input: {
    accountId: string;
    scriptName: string;
    revisionId: string;
    packageDigest: string;
    manifestEndpoint: string;
    uploadEndpoint: string;
    serialization: {
      kind: "cloudflare_static_assets_multipart";
      completionAssertion: "opaque_transport_substitution";
    };
    assets: Array<{
      path: string;
      mediaType: string;
      content: string;
      encoding?: "utf8" | "base64";
    }>;
  }): Promise<{
    completion: object;
    manifestDigest: string;
    serializedBodyBytes: number;
  }>;
};

export interface CloudflareGrantVaultResolver {
  withGrant<Result>(
    binding: {
      handle: string;
      userId: string;
      shipletId: string;
      accountId: string;
      targetId: string;
      scriptName: string;
      revisionId: string;
      packageDigest: string;
      operation: string;
      requestDigest: string;
      requiredScopes: string[];
      expiresAt: number;
    },
    operation: (fetch: CloudflareRedactingFetch) => Promise<Result>,
  ): Promise<Result>;
}

export interface CloudflareTemporaryAccountBroker {
  createAndDeploy(input: {
    authorization: CloudflareTemporaryBrokerAuthorization;
    canonicalRequest: Record<string, unknown>;
    request: Record<string, unknown>;
  }): Promise<{
    providerDeploymentId: string;
    providerVersionId: string;
    selectedVersionId: string;
    temporaryAuthorizationHandle: object;
    claimHandle: string;
    binding: CloudflareTemporaryBrokerResultBinding;
    expiresAt: number;
    serializedBodyBytes: number;
  }>;
  cleanup(input: {
    authorization: CloudflareTemporaryBrokerAuthorization;
    request: Record<string, unknown>;
  }): Promise<{
    success: boolean;
    selectedVersionId: string;
    binding: CloudflareTemporaryBrokerResultBinding;
    serializedBodyBytes: number;
  }>;
}

export interface CloudflareVersionHealthVerifier {
  execute(input: {
    candidateUrl: string;
    accountId: string;
    scriptName: string;
    targetId: string;
    revisionId: string;
    packageDigest: string;
    versionId: string;
    path: "/__shiplet/health";
    maximumResponseBytes: number;
  }): Promise<CloudflareRedactingResponse>;
}

export interface CloudflareProductionDeploymentProvider {
  hasScript(
    input: CloudflareProviderEnvelope<CloudflareInspectRequest>,
  ): Promise<boolean>;
  initializeScript(
    input: CloudflareProviderEnvelope<CloudflareInitializeRequest>,
  ): Promise<{ versionId: string }>;
  uploadVersion(
    input: CloudflareProviderEnvelope<CloudflareUploadVersionRequest>,
  ): Promise<{ versionId: string }>;
  proveCandidate(
    input: CloudflareProviderEnvelope<CloudflareCandidateProofRequest>,
  ): Promise<{
    healthy: boolean;
    observedVersionId: string;
    observedPackageDigest?: string;
  }>;
  createDeployment(
    input: CloudflareProviderEnvelope<CloudflareCreateDeploymentRequest>,
  ): Promise<{ deploymentId: string }>;
  cleanupVersion(
    input: CloudflareProviderEnvelope<CloudflareCleanupVersionRequest>,
  ): Promise<void>;
  createTemporaryDeployment(
    input: CloudflareProviderEnvelope<CloudflareTemporaryCreateRequest>,
  ): Promise<{
    providerDeploymentId: string;
    providerVersionId: string;
    temporaryAuthorization: object;
    claimUrl: URL;
    expiresAt: number;
  }>;
  cleanupTemporaryDeployment(
    input: CloudflareProviderEnvelope<CloudflareTemporaryCleanupRequest>,
  ): Promise<void>;
}

export type CloudflareTemporaryBrokerAuthorization = {
  handle: string;
  userId: string;
  shipletId: string;
  accountHandle: string;
  targetId: string;
  scriptName: string;
  revisionId: string;
  packageDigest: string;
  operation: "temporary.deployment.create" | "temporary.deployment.cleanup";
  requestDigest: string;
  operationId: string;
  requiredScopes: string[];
  expiresAt: number;
};

export type CloudflareTemporaryBrokerResultBinding = Pick<
  CloudflareTemporaryBrokerAuthorization,
  | "userId"
  | "shipletId"
  | "accountHandle"
  | "targetId"
  | "scriptName"
  | "revisionId"
  | "packageDigest"
  | "requestDigest"
  | "operationId"
>;

export type CloudflareCustomerDeploymentProviderDependencies = {
  now(): number;
  grants: CloudflareGrantVaultResolver;
  compatibilityDate?: string;
  versionHealthVerifier?: CloudflareVersionHealthVerifier;
  temporaryAccounts?: CloudflareTemporaryAccountBroker;
  trustedControlPlaneOrigin?: string;
  /** Legacy URL configuration is rejected; claim routing is kernel-owned. */
  temporaryClaimRedirectBase?: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJson(child)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function digestCloudflareProviderRequest(value: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

type ProviderEnvelope = {
  authorization: ProviderAuthorization & { packageDigest?: string };
  request: Record<string, unknown>;
};

function parseEnvelope(
  value: unknown,
  requestErrorCode = "deployment_request_invalid",
): ProviderEnvelope {
  if (
    !isRecord(value) ||
    !isRecord(value.authorization) ||
    !isRecord(value.request)
  ) {
    fail(requestErrorCode);
  }
  const { authorization, request, ...projection } = value;
  if (canonicalJson(projection) !== canonicalJson(request)) {
    fail(requestErrorCode);
  }
  return {
    authorization: authorization as ProviderAuthorization & {
      packageDigest?: string;
    },
    request,
  };
}

function validAccountAndScript(request: Record<string, unknown>) {
  return (
    typeof request.accountId === "string" &&
    ACCOUNT_IDENTIFIER.test(request.accountId) &&
    typeof request.scriptName === "string" &&
    SCRIPT_IDENTIFIER.test(request.scriptName)
  );
}

async function bindEnvelope(
  value: unknown,
  input: {
    now: number;
    operations: ReadonlySet<string>;
    requiredScopes: string[];
    allowedScopes?: ReadonlySet<string>;
    requireRevisionInRequest?: boolean;
    requirePackageDigestInRequest?: boolean;
    requireActorAndTargetInRequest?: boolean;
    requireOperationIdInRequest?: boolean;
    requestErrorCode?: string;
    authorizationErrorCode?: string;
  },
) {
  const requestErrorCode =
    input.requestErrorCode ?? "deployment_request_invalid";
  const authorizationErrorCode =
    input.authorizationErrorCode ?? "deployment_authorization_invalid";
  const envelope = parseEnvelope(value, requestErrorCode);
  const authorization = envelope.authorization;
  const request = envelope.request;
  if (!validAccountAndScript(request)) fail(requestErrorCode);
  const digest = await digestCloudflareProviderRequest(request);
  const scopes = Array.isArray(authorization.scopes)
    ? authorization.scopes
    : [];
  const granted = new Set(scopes);
  const requestRevision = request.revisionId;
  const requestPackageDigest = request.packageDigest;
  const allowedScopes =
    input.allowedScopes ?? new Set(CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES);
  if (
    (input.requireRevisionInRequest &&
      (typeof requestRevision !== "string" ||
        !CONTROL_IDENTIFIER.test(requestRevision))) ||
    (input.requirePackageDigestInRequest &&
      (typeof requestPackageDigest !== "string" ||
        !PACKAGE_DIGEST.test(requestPackageDigest))) ||
    (input.requireActorAndTargetInRequest &&
      (typeof request.actorId !== "string" ||
        !CONTROL_IDENTIFIER.test(request.actorId) ||
        typeof request.shipletId !== "string" ||
        !CONTROL_IDENTIFIER.test(request.shipletId) ||
        typeof request.targetId !== "string" ||
        !CONTROL_IDENTIFIER.test(request.targetId)))
      ||
    (input.requireOperationIdInRequest &&
      (typeof request.operationId !== "string" ||
        !CONTROL_IDENTIFIER.test(request.operationId)))
  ) {
    fail(requestErrorCode);
  }
  if (
    typeof authorization.handle !== "string" ||
    !CONTROL_IDENTIFIER.test(authorization.handle) ||
    typeof authorization.userId !== "string" ||
    !CONTROL_IDENTIFIER.test(authorization.userId) ||
    typeof authorization.shipletId !== "string" ||
    !CONTROL_IDENTIFIER.test(authorization.shipletId) ||
    authorization.accountId !== request.accountId ||
    typeof authorization.targetId !== "string" ||
    !CONTROL_IDENTIFIER.test(authorization.targetId) ||
    authorization.scriptName !== request.scriptName ||
    typeof authorization.revisionId !== "string" ||
    !CONTROL_IDENTIFIER.test(authorization.revisionId) ||
    (input.requireRevisionInRequest &&
      authorization.revisionId !== requestRevision) ||
    (input.requirePackageDigestInRequest &&
      authorization.packageDigest !== requestPackageDigest) ||
    (input.requireActorAndTargetInRequest &&
      (authorization.userId !== request.actorId ||
        authorization.shipletId !== request.shipletId ||
        authorization.targetId !== request.targetId)) ||
    (input.requireOperationIdInRequest &&
      authorization.operationId !== request.operationId) ||
    !input.operations.has(authorization.operation) ||
    authorization.requestDigest !== digest ||
    !safeInteger(authorization.expiresAt) ||
    authorization.expiresAt <= input.now ||
    !exactUniqueScopes(scopes) ||
    scopes.some((scope) => !allowedScopes.has(scope)) ||
    input.requiredScopes.some((scope) => !granted.has(scope))
  ) {
    fail(authorizationErrorCode);
  }
  return { authorization, request, digest };
}

function scopedUrl(accountId: string, path: string) {
  return `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}${path}`;
}

function providerResult(
  response: CloudflareRedactingResponse,
  errorCode: string,
) {
  if (
    !BOUNDED_RESPONSES.has(response) ||
    !BOUNDED_RESPONSE_PROOFS.has(response.boundedBodyProof) ||
    !validSerializedBodyBytes(
      response.serializedBodyBytes,
      MAX_PROVIDER_RESPONSE_BYTES,
    ) ||
    response.status < 200 ||
    response.status >= 300 ||
    !isRecord(response.body) ||
    response.body.success !== true ||
    !isRecord(response.body.result)
  ) {
    fail(errorCode);
  }
  return response.body.result;
}

function providerSuccess(
  response: CloudflareRedactingResponse,
  errorCode: string,
) {
  if (
    !BOUNDED_RESPONSES.has(response) ||
    !BOUNDED_RESPONSE_PROOFS.has(response.boundedBodyProof) ||
    !validSerializedBodyBytes(
      response.serializedBodyBytes,
      MAX_PROVIDER_RESPONSE_BYTES,
    ) ||
    response.status < 200 ||
    response.status >= 300 ||
    !isRecord(response.body) ||
    response.body.success !== true
  ) {
    fail(errorCode);
  }
}

function validCanonicalPackagePath(path: string, kind: "module" | "asset") {
  if (
    path.length === 0 ||
    new TextEncoder().encode(path).byteLength > 512 ||
    path !== path.normalize("NFC") ||
    path.trim() !== path ||
    PACKAGE_PATH_CONTROL.test(path) ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    (kind === "module" && (path.startsWith("/") || path.startsWith("./"))) ||
    (kind === "asset" && (!path.startsWith("/") || path === "/"))
  ) {
    return false;
  }
  const relative = kind === "asset" ? path.slice(1) : path;
  const segments = relative.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function validPackageFile(value: unknown, kind: "module" | "asset") {
  if (!isRecord(value)) return false;
  const path = kind === "module" ? value.name : value.path;
  if (
    typeof path !== "string" ||
    !validCanonicalPackagePath(path, kind) ||
    typeof value.mediaType !== "string" ||
    value.mediaType.length > 255 ||
    !MEDIA_TYPE.test(value.mediaType) ||
    value.mediaType !== value.mediaType.toLowerCase() ||
    typeof value.content !== "string" ||
    (value.encoding !== undefined &&
      value.encoding !== "utf8" &&
      value.encoding !== "base64")
  ) {
    return false;
  }
  return true;
}

function validatePackage(request: Record<string, unknown>) {
  if (
    typeof request.actorId !== "string" ||
    !CONTROL_IDENTIFIER.test(request.actorId) ||
    typeof request.targetId !== "string" ||
    !CONTROL_IDENTIFIER.test(request.targetId) ||
    typeof request.revisionId !== "string" ||
    !CONTROL_IDENTIFIER.test(request.revisionId) ||
    typeof request.packageDigest !== "string" ||
    !PACKAGE_DIGEST.test(request.packageDigest) ||
    !Array.isArray(request.modules) ||
    request.modules.length > MAX_MODULES ||
    request.modules.some((file) => !validPackageFile(file, "module")) ||
    !Array.isArray(request.staticAssets) ||
    request.staticAssets.length > MAX_ASSETS ||
    request.staticAssets.some((file) => !validPackageFile(file, "asset")) ||
    typeof request.mainModule !== "string" ||
    !validCanonicalPackagePath(request.mainModule, "module") ||
    !isRecord(request.egress) ||
    Reflect.ownKeys(request.egress).length !== 1 ||
    request.egress.status !== CLOUDFLARE_CUSTOMER_WORKER_EGRESS_ENFORCEMENT
  ) {
    fail("deployment_request_invalid");
  }
  const modules = request.modules as Array<Record<string, unknown>>;
  if (modules.length === 0) {
    if (
      request.mainModule !== "__shiplet_static.mjs" ||
      (request.staticAssets as unknown[]).length === 0
    ) {
      fail("deployment_request_invalid");
    }
  } else {
    const selected = modules.filter(
      (module) => module.name === request.mainModule,
    );
    if (
      selected.length !== 1 ||
      !MAIN_MODULE_MEDIA_TYPES.has(String(selected[0]!.mediaType))
    ) {
      fail("deployment_request_invalid");
    }
  }
  const names = new Set<string>();
  for (const file of [...request.modules, ...request.staticAssets] as Array<
    Record<string, unknown>
  >) {
    const name = String(file.name ?? file.path);
    if (names.has(name)) fail("deployment_request_invalid");
    names.add(name);
  }
  const bytes = [...request.modules, ...request.staticAssets].reduce(
    (total, file) =>
      total +
      new TextEncoder().encode(
        String((file as Record<string, unknown>).content),
      ).byteLength,
    0,
  );
  if (bytes > MAX_BUNDLE_BYTES) fail("deployment_request_invalid");
}

function projectBindings(
  value: unknown,
  errorCode = "deployment_request_invalid",
) {
  if (!Array.isArray(value) || value.length > 64) {
    fail(errorCode);
  }
  const names = new Set<string>();
  return value.map((binding) => {
    if (!isRecord(binding) || !BINDING_IDENTIFIER.test(String(binding.name))) {
      fail(errorCode);
    }
    const name = String(binding.name);
    if (names.has(name) || RESERVED_BINDINGS.has(name.toUpperCase())) {
      fail(errorCode);
    }
    names.add(name);
    if (binding.kind === "plain_text") {
      if (typeof binding.value !== "string" || binding.value.length > 8_192) {
        fail(errorCode);
      }
      return { name, type: "plain_text", text: binding.value };
    }
    if (
      typeof binding.providerResourceId !== "string" ||
      !CONTROL_IDENTIFIER.test(binding.providerResourceId)
    ) {
      fail(errorCode);
    }
    switch (binding.kind) {
      case "d1":
        return {
          name,
          type: "d1",
          database_id: binding.providerResourceId,
        };
      case "r2":
        return {
          name,
          type: "r2_bucket",
          bucket_name: binding.providerResourceId,
        };
      case "durable_object":
        return {
          name,
          type: "durable_object_namespace",
          namespace_id: binding.providerResourceId,
        };
      default:
        fail(errorCode);
    }
  });
}

function decodedBase64ByteLength(value: string) {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    ) {
      return null;
    }
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return null;
  }
  try {
    const decoded = atob(value);
    if (btoa(decoded) !== value) return null;
    return decoded.length;
  } catch {
    return null;
  }
}

function validateTemporaryStaticRequest(request: Record<string, unknown>) {
  const errorCode = "temporary_deployment_request_invalid";
  if (
    request.termsOfService !== "https://www.cloudflare.com/terms/" ||
    request.privacyPolicy !== "https://www.cloudflare.com/privacypolicy/" ||
    request.acceptTermsOfService !== "yes" ||
    !validAccountAndScript(request) ||
    typeof request.actorId !== "string" ||
    !CONTROL_IDENTIFIER.test(request.actorId) ||
    typeof request.targetId !== "string" ||
    !CONTROL_IDENTIFIER.test(request.targetId) ||
    typeof request.revisionId !== "string" ||
    !CONTROL_IDENTIFIER.test(request.revisionId) ||
    typeof request.packageDigest !== "string" ||
    !PACKAGE_DIGEST.test(request.packageDigest) ||
    !Array.isArray(request.modules) ||
    request.modules.length !== 0 ||
    !Array.isArray(request.staticAssets) ||
    request.staticAssets.length > MAX_TEMPORARY_ASSETS
  ) {
    fail(errorCode);
  }

  const projectedBindings = projectBindings(request.bindings, errorCode);
  if (projectedBindings.length !== 0) fail(errorCode);

  const paths = new Set<string>();
  let decodedBundleBytes = 0;
  let serializedBodyBytes = 0;
  for (const value of request.staticAssets) {
    if (!validPackageFile(value, "asset")) fail(errorCode);
    const asset = value as Record<string, unknown>;
    const path = String(asset.path);
    const mediaType = String(asset.mediaType);
    const content = String(asset.content);
    if (
      paths.has(path) ||
      !MEDIA_TYPE.test(mediaType) ||
      mediaType !== mediaType.toLowerCase()
    ) {
      fail(errorCode);
    }
    paths.add(path);
    const decodedBytes =
      asset.encoding === "base64"
        ? decodedBase64ByteLength(content)
        : new TextEncoder().encode(content).byteLength;
    if (decodedBytes === null || decodedBytes > MAX_TEMPORARY_ASSET_BYTES) {
      fail(errorCode);
    }
    decodedBundleBytes += decodedBytes;
    serializedBodyBytes +=
      new TextEncoder().encode(path).byteLength +
      new TextEncoder().encode(mediaType).byteLength +
      new TextEncoder().encode(content).byteLength +
      128;
    if (
      decodedBundleBytes > MAX_TEMPORARY_BUNDLE_BYTES ||
      serializedBodyBytes > MAX_TEMPORARY_BODY_BYTES
    ) {
      fail(errorCode);
    }
  }
  return {
    assets: structuredClone(request.staticAssets) as Array<{
      path: string;
      mediaType: string;
      content: string;
      encoding?: "utf8" | "base64";
    }>,
    decodedBundleBytes,
    serializedBodyBytes,
  };
}

const OPAQUE_TEMPORARY_AUTHORIZATION_HANDLES = new WeakSet<object>();
const ISSUED_TEMPORARY_CLAIM_HANDLES = new Set<string>();

export function createCloudflareOpaqueTemporaryAuthorizationHandle(): object {
  const handle = Object.freeze(Object.create(null)) as object;
  OPAQUE_TEMPORARY_AUTHORIZATION_HANDLES.add(handle);
  return handle;
}

export function createCloudflareTemporaryClaimHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const handle = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  ISSUED_TEMPORARY_CLAIM_HANDLES.add(handle);
  return handle;
}

function consumeValidTemporaryClaimHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    VERSION_CLAIM_HANDLE.test(value) &&
    ISSUED_TEMPORARY_CLAIM_HANDLES.delete(value)
  );
}

function validOpaqueHandle(value: unknown): value is object {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).length === 0 &&
    Object.isFrozen(value) &&
    OPAQUE_TEMPORARY_AUTHORIZATION_HANDLES.has(value)
  );
}

function exactTemporaryResultBinding(
  value: unknown,
  expected: CloudflareTemporaryBrokerAuthorization,
) {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).length === 9 &&
    value.userId === expected.userId &&
    value.shipletId === expected.shipletId &&
    value.accountHandle === expected.accountHandle &&
    value.targetId === expected.targetId &&
    value.scriptName === expected.scriptName &&
    value.revisionId === expected.revisionId &&
    value.packageDigest === expected.packageDigest &&
    value.requestDigest === expected.requestDigest &&
    value.operationId === expected.operationId
  );
}

function validCompatibilityDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function decodeBase64Url(value: string) {
  if (!BASE64URL.test(value)) return null;
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    let canonical = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    return canonical === value ? bytes : null;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function solveCloudflarePreviewChallenge(input: {
  challengeToken: string;
  seed: string;
  k: number;
  g: number;
}) {
  const seed = decodeBase64Url(input.seed);
  if (
    !OAUTH_VALUE.test(input.challengeToken) ||
    !seed ||
    seed.byteLength !== 32 ||
    !safeInteger(input.k) ||
    input.k <= 0 ||
    !safeInteger(input.g) ||
    input.g <= 0 ||
    input.k * input.g > MAX_TEMPORARY_WORK ||
    (input.k + 1) * 32 > MAX_TEMPORARY_CHECKPOINT_BYTES
  ) {
    fail("temporary_challenge_invalid");
  }
  const checkpoints = new Uint8Array((input.k + 1) * 32);
  let hash = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  checkpoints.set(hash, 0);
  for (let segment = 0; segment < input.k; segment += 1) {
    for (let iteration = 0; iteration < input.g; iteration += 1) {
      hash = new Uint8Array(await crypto.subtle.digest("SHA-256", hash));
    }
    checkpoints.set(hash, (segment + 1) * 32);
  }
  return {
    challengeToken: input.challengeToken,
    solution: { checkpoints: encodeBase64(checkpoints) },
  };
}

export function createCloudflareCustomerDeploymentProvider(
  dependencies: CloudflareCustomerDeploymentProviderDependencies,
): CloudflareProductionDeploymentProvider {
  const compatibilityDate = dependencies.compatibilityDate ?? "2026-08-05";
  if (!validCompatibilityDate(compatibilityDate)) {
    throw new TypeError("invalid_cloudflare_compatibility_date");
  }
  let temporaryClaimRedirectBase: URL | null = null;
  if (dependencies.temporaryAccounts) {
    const configured = dependencies.trustedControlPlaneOrigin;
    if (
      dependencies.temporaryClaimRedirectBase !== undefined ||
      typeof configured !== "string" ||
      !validHttpsUrl(`${configured}/`)
    ) {
      throw new TypeError("invalid_cloudflare_temporary_claim_redirect");
    }
    const parsed = new URL(configured);
    if (
      parsed.origin !== configured ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new TypeError("invalid_cloudflare_temporary_claim_redirect");
    }
    temporaryClaimRedirectBase = new URL(
      CLOUDFLARE_TEMPORARY_TRUSTED_CLAIM_ROUTE,
      parsed,
    );
  } else if (
    dependencies.temporaryClaimRedirectBase !== undefined ||
    dependencies.trustedControlPlaneOrigin !== undefined
  ) {
    throw new TypeError("invalid_cloudflare_temporary_claim_redirect");
  }

  const authorized = async <Result>(
    value: unknown,
    input: {
      operations: string[];
      requiredScopes: string[];
      requireRevisionInRequest?: boolean;
      requirePackageDigestInRequest?: boolean;
    },
    operation: (
      fetch: CloudflareRedactingFetch,
      request: Record<string, unknown>,
    ) => Promise<Result>,
  ) => {
    const bound = await bindEnvelope(value, {
      now: trustedNow(dependencies.now),
      operations: new Set(input.operations),
      requiredScopes: input.requiredScopes,
      requireRevisionInRequest: input.requireRevisionInRequest,
      requirePackageDigestInRequest: input.requirePackageDigestInRequest,
      requireActorAndTargetInRequest: true,
    });
    try {
      return await dependencies.grants.withGrant(
        {
          handle: bound.authorization.handle,
          userId: bound.authorization.userId,
          shipletId: bound.authorization.shipletId,
          accountId: bound.authorization.accountId,
          targetId: bound.authorization.targetId!,
          scriptName: bound.authorization.scriptName!,
          revisionId: bound.authorization.revisionId!,
          packageDigest: bound.authorization.packageDigest!,
          operation: bound.authorization.operation,
          requestDigest: bound.digest,
          requiredScopes: [...input.requiredScopes],
          expiresAt: bound.authorization.expiresAt,
        },
        (fetch) => operation(fetch, bound.request),
      );
    } catch (error) {
      if (error instanceof CloudflareProductionAdapterError) throw error;
      fail("deployment_authority_unavailable");
    }
  };

  const uploadImmutableVersion = async (
    fetch: CloudflareRedactingFetch,
    request: Record<string, unknown>,
    errorCode: string,
  ) => {
    validatePackage(request);
    const bindings: Array<Record<string, unknown>> = projectBindings(
      request.bindings,
    );
    if (
      !isRecord(request.limits) ||
      !safeInteger(request.limits.cpuMs) ||
      request.limits.cpuMs <= 0 ||
      request.limits.cpuMs > 30_000 ||
      !safeInteger(request.limits.subRequests) ||
      request.limits.subRequests < 0 ||
      request.limits.subRequests > 1_000
    ) {
      fail("deployment_request_invalid");
    }
    const modules = structuredClone(request.modules) as Array<{
      name: string;
      mediaType: string;
      content: string;
      encoding?: "utf8" | "base64";
    }>;
    const staticAssets = structuredClone(request.staticAssets) as Array<{
      path: string;
      mediaType: string;
      content: string;
      encoding?: "utf8" | "base64";
    }>;
    if (modules.length === 0) {
      const revisionId = JSON.stringify(String(request.revisionId));
      const packageDigest = JSON.stringify(String(request.packageDigest));
      modules.push({
        name: "__shiplet_static.mjs",
        mediaType: "application/javascript+module",
        content: `export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === "/__shiplet/health") { const metadata = env && env.CF_VERSION_METADATA; if (!metadata || typeof metadata.id !== "string" || metadata.id.length === 0 || metadata.tag !== ${packageDigest}) { return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); } return new Response(JSON.stringify({ ok: true, versionId: metadata.id, revisionId: ${revisionId}, packageDigest: ${packageDigest} }), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); } if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") { return new Response(null, { status: 503 }); } return env.ASSETS.fetch(request); } };`,
      });
      bindings.push(
        { name: "ASSETS", type: "assets" },
        { name: "CF_VERSION_METADATA", type: "version_metadata" },
      );
    }
    let assetCompletion: object | undefined;
    if (staticAssets.length > 0) {
      let assets: Awaited<
        ReturnType<CloudflareRedactingFetch["uploadStaticAssets"]>
      >;
      try {
        assets = await fetch.uploadStaticAssets({
          accountId: String(request.accountId),
          scriptName: String(request.scriptName),
          revisionId: String(request.revisionId),
          packageDigest: String(request.packageDigest),
          manifestEndpoint: scopedUrl(
            String(request.accountId),
            `/workers/scripts/${request.scriptName}/assets-upload-session`,
          ),
          uploadEndpoint: `${scopedUrl(String(request.accountId), "/workers/assets/upload")}?base64=true`,
          serialization: {
            kind: "cloudflare_static_assets_multipart",
            completionAssertion: "opaque_transport_substitution",
          },
          assets: staticAssets,
        });
      } catch {
        fail(errorCode);
      }
      if (
        !isRecord(assets.completion) ||
        assets.manifestDigest !== request.packageDigest ||
        !validSerializedBodyBytes(
          assets.serializedBodyBytes,
          MAX_PROVIDER_RESPONSE_BYTES,
        )
      ) {
        fail(errorCode);
      }
      assetCompletion = assets.completion;
    }
    const metadata: Record<string, unknown> = {
      main_module: request.mainModule,
      annotations: { "workers/tag": request.packageDigest },
      compatibility_date: compatibilityDate,
      bindings,
      limits: {
        cpu_ms: request.limits.cpuMs,
        subrequests: request.limits.subRequests,
      },
    };
    if (assetCompletion) {
      metadata.assets = {
        jwt: "__SHIPLET_OPAQUE_ASSET_COMPLETION__",
        ...(String(request.mainModule) === "__shiplet_static.mjs"
          ? { config: { run_worker_first: ["/__shiplet/health"] } }
          : {}),
      };
    }
    let response: CloudflareRedactingResponse;
    try {
      response = await fetch.request({
        method: "POST",
        url: scopedUrl(
          String(request.accountId),
          `/workers/scripts/${request.scriptName}/versions`,
        ),
        body: {
          kind: "worker_version",
          serialization: {
            kind: "cloudflare_worker_version_multipart",
            completionAssertion: "opaque_transport_substitution",
          },
          metadata,
          modules,
          ...(assetCompletion ? { assetCompletion } : {}),
        },
      });
    } catch {
      fail(errorCode);
    }
    const result = providerResult(response, errorCode);
    if (typeof result.id !== "string" || !UUID.test(result.id)) fail(errorCode);
    return { versionId: result.id };
  };

  return {
    async hasScript(value) {
      return authorized(
        value,
        {
          operations: ["worker.inspect"],
          requiredScopes: ["workers.scripts.read"],
        },
        async (fetch, request) => {
          let response: CloudflareRedactingResponse;
          try {
            response = await fetch.request({
              method: "GET",
              url: scopedUrl(
                String(request.accountId),
                `/workers/scripts/${request.scriptName}/script-settings`,
              ),
            });
          } catch {
            fail("provider_inspection_failed");
          }
          if (
            !BOUNDED_RESPONSES.has(response) ||
            !BOUNDED_RESPONSE_PROOFS.has(response.boundedBodyProof) ||
            !validSerializedBodyBytes(
              response.serializedBodyBytes,
              MAX_PROVIDER_RESPONSE_BYTES,
            )
          ) {
            fail("provider_inspection_failed");
          }
          if (response.status === 404) return false;
          providerResult(response, "provider_inspection_failed");
          return true;
        },
      );
    },

    async initializeScript(value) {
      return authorized(
        value,
        {
          operations: ["worker.script.initialize"],
          requiredScopes: ["workers.scripts.write"],
        },
        async (fetch, request) => {
          if (
            !isRecord(request.bootstrap) ||
            request.bootstrap.kind !== "inert_known_good"
          ) {
            fail("deployment_request_invalid");
          }
          projectBindings(request.bindings);
          let created: CloudflareRedactingResponse;
          try {
            created = await fetch.request({
              method: "POST",
              url: scopedUrl(String(request.accountId), "/workers/workers"),
              body: {
                kind: "json",
                value: {
                  name: request.scriptName,
                  subdomain: { enabled: true, previews_enabled: true },
                },
              },
            });
          } catch {
            fail("provider_initialization_failed");
          }
          const worker = providerResult(
            created,
            "provider_initialization_failed",
          );
          if (
            worker.name !== request.scriptName ||
            typeof worker.id !== "string" ||
            !ACCOUNT_IDENTIFIER.test(worker.id)
          ) {
            fail("provider_initialization_failed");
          }
          const inertRequest = {
            ...request,
            revisionId: "kernel_inert_known_good",
            packageDigest: `sha256:${"0".repeat(64)}`,
            modules: [
              {
                name: "__shiplet_inert.mjs",
                mediaType: "application/javascript+module",
                content:
                  "export default { fetch() { return new Response(null, { status: 503 }); } };",
              },
            ],
            staticAssets: [],
            mainModule: "__shiplet_inert.mjs",
            limits: { cpuMs: 10, subRequests: 0 },
            egress: {
              status: CLOUDFLARE_CUSTOMER_WORKER_EGRESS_ENFORCEMENT,
            },
          };
          return uploadImmutableVersion(
            fetch,
            inertRequest,
            "provider_initialization_failed",
          );
        },
      );
    },

    async uploadVersion(value) {
      return authorized(
        value,
        {
          operations: ["worker.version.upload"],
          requiredScopes: ["workers.scripts.write"],
          requireRevisionInRequest: true,
        },
        (fetch, request) =>
          uploadImmutableVersion(fetch, request, "provider_upload_failed"),
      );
    },

    async proveCandidate(value) {
      return authorized(
        value,
        {
          operations: ["worker.candidate.prove"],
          requiredScopes: ["workers.scripts.read"],
          requireRevisionInRequest: true,
          requirePackageDigestInRequest: true,
        },
        async (fetch, request) => {
          if (
            typeof request.revisionId !== "string" ||
            !CONTROL_IDENTIFIER.test(request.revisionId) ||
            typeof request.versionId !== "string" ||
            !UUID.test(request.versionId) ||
            typeof request.packageDigest !== "string" ||
            !PACKAGE_DIGEST.test(request.packageDigest) ||
            !isRecord(request.healthCheck) ||
            Reflect.ownKeys(request.healthCheck).length !== 2 ||
            request.healthCheck.path !== "/__shiplet/health" ||
            request.healthCheck.expectedStatus !== 200
          ) {
            fail("deployment_request_invalid");
          }
          if (!dependencies.versionHealthVerifier) {
            fail("version_execution_health_prerequisite");
          }
          let response: CloudflareRedactingResponse;
          try {
            response = await fetch.request({
              method: "GET",
              url: scopedUrl(
                String(request.accountId),
                `/workers/workers/${request.scriptName}/versions/${request.versionId}`,
              ),
            });
          } catch {
            fail("candidate_proof_failed");
          }
          const result = providerResult(response, "candidate_proof_failed");
          if (typeof result.id !== "string" || !UUID.test(result.id)) {
            fail("candidate_proof_failed");
          }
          const observedDigest = isRecord(result.annotations)
            ? result.annotations["workers/tag"]
            : undefined;
          if (
            result.id !== request.versionId ||
            observedDigest !== request.packageDigest
          ) {
            fail("candidate_proof_failed");
          }
          if (
            !Array.isArray(result.urls) ||
            result.urls.length !== 1 ||
            typeof result.urls[0] !== "string"
          ) {
            fail("version_execution_health_prerequisite");
          }
          let preview: URL;
          try {
            preview = new URL(result.urls[0]);
          } catch {
            fail("candidate_proof_failed");
          }
          if (
            preview.protocol !== "https:" ||
            !preview.hostname.endsWith(".workers.dev") ||
            preview.pathname !== "/" ||
            preview.search.length > 0 ||
            preview.hash.length > 0 ||
            preview.username.length > 0 ||
            preview.password.length > 0
          ) {
            fail("candidate_proof_failed");
          }
          preview.pathname = "/__shiplet/health";
          let health: CloudflareRedactingResponse;
          try {
            health = await dependencies.versionHealthVerifier.execute({
              candidateUrl: preview.toString(),
              accountId: String(request.accountId),
              scriptName: String(request.scriptName),
              targetId: String(request.targetId),
              revisionId: request.revisionId,
              packageDigest: request.packageDigest,
              versionId: request.versionId,
              path: "/__shiplet/health",
              maximumResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
            });
          } catch (error) {
            if (error instanceof CloudflareProductionAdapterError) throw error;
            fail("candidate_execution_failed");
          }
          if (
            !BOUNDED_RESPONSES.has(health) ||
            !BOUNDED_RESPONSE_PROOFS.has(health.boundedBodyProof) ||
            !validSerializedBodyBytes(
              health.serializedBodyBytes,
              MAX_PROVIDER_RESPONSE_BYTES,
            ) ||
            health.status !== 200 ||
            !isRecord(health.body) ||
            Reflect.ownKeys(health.body).length !== 4 ||
            health.body.ok !== true ||
            health.body.versionId !== request.versionId ||
            health.body.revisionId !== request.revisionId ||
            health.body.packageDigest !== request.packageDigest
          ) {
            fail("candidate_execution_failed");
          }
          return {
            healthy: true,
            observedVersionId: result.id,
            ...(typeof observedDigest === "string"
              ? { observedPackageDigest: observedDigest }
              : {}),
          };
        },
      );
    },

    async createDeployment(value) {
      return authorized(
        value,
        {
          operations: [
            "worker.deployment.promote",
            "worker.deployment.rollback",
            "worker.deployment.compensate",
          ],
          requiredScopes: ["workers.scripts.write"],
          requireRevisionInRequest: true,
          requirePackageDigestInRequest: true,
        },
        async (fetch, request) => {
          if (
            typeof request.revisionId !== "string" ||
            !CONTROL_IDENTIFIER.test(request.revisionId) ||
            typeof request.packageDigest !== "string" ||
            !PACKAGE_DIGEST.test(request.packageDigest) ||
            typeof request.versionId !== "string" ||
            !UUID.test(request.versionId) ||
            request.percentage !== 100
          ) {
            fail("deployment_request_invalid");
          }
          let response: CloudflareRedactingResponse;
          try {
            response = await fetch.request({
              method: "POST",
              url: scopedUrl(
                String(request.accountId),
                `/workers/scripts/${request.scriptName}/deployments`,
              ),
              body: {
                kind: "json",
                value: {
                  strategy: "percentage",
                  versions: [
                    { version_id: request.versionId, percentage: 100 },
                  ],
                },
              },
            });
          } catch {
            fail("provider_deployment_failed");
          }
          const result = providerResult(response, "provider_deployment_failed");
          if (typeof result.id !== "string" || !UUID.test(result.id)) {
            fail("provider_deployment_failed");
          }
          if (
            result.strategy !== "percentage" ||
            !Array.isArray(result.versions) ||
            result.versions.length !== 1 ||
            !isRecord(result.versions[0]) ||
            result.versions[0].version_id !== request.versionId ||
            result.versions[0].percentage !== 100
          ) {
            fail("provider_deployment_failed");
          }
          return { deploymentId: result.id };
        },
      );
    },

    async cleanupVersion(value) {
      await authorized(
        value,
        {
          operations: ["worker.version.cleanup"],
          requiredScopes: ["workers.scripts.write"],
          requireRevisionInRequest: true,
          requirePackageDigestInRequest: true,
        },
        async (fetch, request) => {
          if (
            typeof request.revisionId !== "string" ||
            !CONTROL_IDENTIFIER.test(request.revisionId) ||
            typeof request.packageDigest !== "string" ||
            !PACKAGE_DIGEST.test(request.packageDigest) ||
            typeof request.versionId !== "string" ||
            !UUID.test(request.versionId)
          ) {
            fail("deployment_request_invalid");
          }
          let response: CloudflareRedactingResponse;
          try {
            response = await fetch.request({
              method: "DELETE",
              url: scopedUrl(
                String(request.accountId),
                `/workers/workers/${request.scriptName}/versions/${request.versionId}`,
              ),
            });
          } catch {
            fail("provider_cleanup_failed");
          }
          providerSuccess(response, "provider_cleanup_failed");
        },
      );
    },

    async createTemporaryDeployment(input) {
      if (!dependencies.temporaryAccounts) {
        fail("temporary_accounts_backend_prerequisite");
      }
      const operationNow = trustedNow(dependencies.now);
      const requiredScopes = [...CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES.create];
      const bound = await bindEnvelope(input, {
        now: operationNow,
        operations: new Set(["temporary.deployment.create"]),
        requiredScopes,
        allowedScopes: new Set([
          ...CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES.create,
          ...CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES.cleanup,
        ]),
        requireRevisionInRequest: true,
        requirePackageDigestInRequest: true,
        requireActorAndTargetInRequest: true,
        requireOperationIdInRequest: true,
        requestErrorCode: "temporary_deployment_request_invalid",
        authorizationErrorCode: "temporary_deployment_authorization_invalid",
      });
      if (
        canonicalJson(normalizeScopes(bound.authorization.scopes)) !==
        canonicalJson(normalizeScopes(requiredScopes))
      ) {
        fail("temporary_deployment_authorization_invalid");
      }
      const validated = validateTemporaryStaticRequest(bound.request);
      const authorization: CloudflareTemporaryBrokerAuthorization = {
        handle: bound.authorization.handle,
        userId: bound.authorization.userId,
        shipletId: bound.authorization.shipletId,
        accountHandle: bound.authorization.accountId,
        targetId: bound.authorization.targetId!,
        scriptName: bound.authorization.scriptName!,
        revisionId: bound.authorization.revisionId!,
        packageDigest: bound.authorization.packageDigest!,
        operation: "temporary.deployment.create",
        requestDigest: bound.digest,
        operationId: bound.request.operationId as string,
        requiredScopes,
        expiresAt: bound.authorization.expiresAt,
      };
      const brokerRequest = {
        operationId: bound.request.operationId,
        termsOfService: bound.request.termsOfService,
        privacyPolicy: bound.request.privacyPolicy,
        acceptTermsOfService: bound.request.acceptTermsOfService,
        actorId: bound.request.actorId,
        shipletId: bound.request.shipletId,
        targetId: bound.request.targetId,
        accountHandle: bound.request.accountId,
        scriptName: bound.request.scriptName,
        revisionId: bound.request.revisionId,
        packageDigest: bound.request.packageDigest,
        staticAssets: validated.assets,
        serialization: {
          kind: "cloudflare_temporary_static_multipart",
          maxAssets: MAX_TEMPORARY_ASSETS,
          maxDecodedAssetBytes: MAX_TEMPORARY_ASSET_BYTES,
          maxDecodedBundleBytes: MAX_TEMPORARY_BUNDLE_BYTES,
          maxSerializedBodyBytes: MAX_TEMPORARY_BODY_BYTES,
          decodedBundleBytes: validated.decodedBundleBytes,
          serializedBodyBytes: validated.serializedBodyBytes,
        },
      };
      let result: Awaited<
        ReturnType<CloudflareTemporaryAccountBroker["createAndDeploy"]>
      >;
      try {
        result = await dependencies.temporaryAccounts.createAndDeploy({
          authorization,
          canonicalRequest: structuredClone(bound.request),
          request: brokerRequest,
        });
      } catch {
        fail("temporary_provider_failed");
      }
      if (
        !isRecord(result) ||
        !UUID.test(result.providerDeploymentId) ||
        !UUID.test(result.providerVersionId) ||
        result.selectedVersionId !== result.providerVersionId ||
        !validOpaqueHandle(result.temporaryAuthorizationHandle) ||
        !consumeValidTemporaryClaimHandle(result.claimHandle) ||
        !exactTemporaryResultBinding(result.binding, authorization) ||
        !safeInteger(result.expiresAt) ||
        result.expiresAt <= operationNow ||
        result.expiresAt > operationNow + MAX_TEMPORARY_CLAIM_LIFETIME_MS ||
        !validSerializedBodyBytes(
          result.serializedBodyBytes,
          MAX_TEMPORARY_RESPONSE_BYTES,
        ) ||
        Reflect.ownKeys(result).length !== 8 ||
        Reflect.ownKeys(result).some(
          (key) =>
            typeof key !== "string" ||
            ![
              "providerDeploymentId",
              "providerVersionId",
              "selectedVersionId",
              "temporaryAuthorizationHandle",
              "claimHandle",
              "binding",
              "expiresAt",
              "serializedBodyBytes",
            ].includes(key),
        )
      ) {
        fail("temporary_provider_response_invalid");
      }
      const claimUrl = new URL(temporaryClaimRedirectBase!);
      claimUrl.searchParams.set("handle", result.claimHandle);
      return {
        providerDeploymentId: result.providerDeploymentId,
        providerVersionId: result.providerVersionId,
        temporaryAuthorization: result.temporaryAuthorizationHandle,
        claimUrl,
        expiresAt: result.expiresAt,
      };
    },

    async cleanupTemporaryDeployment(input) {
      if (!dependencies.temporaryAccounts) {
        fail("temporary_accounts_backend_prerequisite");
      }
      const requiredScopes = [
        ...CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES.cleanup,
      ];
      const bound = await bindEnvelope(input, {
        now: trustedNow(dependencies.now),
        operations: new Set(["temporary.deployment.cleanup"]),
        requiredScopes,
        allowedScopes: new Set([
          ...CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES.create,
          ...CLOUDFLARE_TEMPORARY_CAPABILITY_SCOPES.cleanup,
        ]),
        requireRevisionInRequest: true,
        requirePackageDigestInRequest: true,
        requireActorAndTargetInRequest: true,
        requireOperationIdInRequest: true,
        requestErrorCode: "temporary_cleanup_request_invalid",
        authorizationErrorCode: "temporary_cleanup_authorization_invalid",
      });
      if (
        canonicalJson(normalizeScopes(bound.authorization.scopes)) !==
          canonicalJson(normalizeScopes(requiredScopes)) ||
        typeof bound.request.providerDeploymentId !== "string" ||
        !UUID.test(bound.request.providerDeploymentId) ||
        typeof bound.request.providerVersionId !== "string" ||
        !UUID.test(bound.request.providerVersionId)
      ) {
        fail("temporary_cleanup_request_invalid");
      }
      const authorization: CloudflareTemporaryBrokerAuthorization = {
        handle: bound.authorization.handle,
        userId: bound.authorization.userId,
        shipletId: bound.authorization.shipletId,
        accountHandle: bound.authorization.accountId,
        targetId: bound.authorization.targetId!,
        scriptName: bound.authorization.scriptName!,
        revisionId: bound.authorization.revisionId!,
        packageDigest: bound.authorization.packageDigest!,
        operation: "temporary.deployment.cleanup",
        requestDigest: bound.digest,
        operationId: bound.request.operationId as string,
        requiredScopes,
        expiresAt: bound.authorization.expiresAt,
      };
      let result: Awaited<
        ReturnType<CloudflareTemporaryAccountBroker["cleanup"]>
      >;
      try {
        result = await dependencies.temporaryAccounts.cleanup({
          authorization,
          request: structuredClone(bound.request),
        });
      } catch {
        fail("temporary_cleanup_failed");
      }
      if (
        !isRecord(result) ||
        result.success !== true ||
        result.selectedVersionId !== bound.request.providerVersionId ||
        !exactTemporaryResultBinding(result.binding, authorization) ||
        !validSerializedBodyBytes(
          result.serializedBodyBytes,
          MAX_TEMPORARY_RESPONSE_BYTES,
        ) ||
        Reflect.ownKeys(result).length !== 4 ||
        Reflect.ownKeys(result).some(
          (key) =>
            typeof key !== "string" ||
            ![
              "success",
              "selectedVersionId",
              "binding",
              "serializedBodyBytes",
            ].includes(key),
        )
      ) {
        fail("temporary_cleanup_failed");
      }
    },
  };
}
