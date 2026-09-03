import { WorkerEntrypoint } from "cloudflare:workers";
import type { ControlPlaneEnv } from "./env";

import {
  CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES,
  createCloudflarePublicOAuthProvider,
  type CloudflareGrantVaultResolver,
  type CloudflareRedactingFetch,
} from "../../src/cloudflare-production-adapters";
import {
  createCloudflareOAuthService,
  type CloudflareConnectionRecord,
} from "../../src/cloudflare-oauth";
import {
  listD1PendingCloudflareRevocations,
  reconcileD1CloudflareRevocationForRpc,
} from "../../src/cloudflare-support/d1-revocation-index";
import {
  createD1CloudflareConnectionStore,
  createD1CloudflareOAuthStateStore,
} from "../../src/d1-cloudflare-control-plane";
import { authorizeCloudflareGrantConnection } from "../../src/cloudflare-support/control-plane";
import {
  createD1EncryptedCredentialVault,
  initializeD1CredentialContinuity,
} from "../../src/cloudflare-support/d1-vault";
import { createCloudflareOAuthRedactingFetch } from "../../src/cloudflare-support/oauth-transport";
import {
  acknowledgeD1OAuthFinalizationDelivery,
  beginD1OAuthStateWithinQuota,
  createD1RecoverableOAuthConnectionCommitter,
  createOAuthDeliveryReturnResponse,
  markD1OAuthProviderExchangeCommitted,
  prepareD1OAuthFinalizationDelivery,
  readD1OAuthFinalizationDelivery,
  reconcileD1ExpiredOAuthFinalizationDeliveries,
  reconcileD1ExpiredPendingOAuthConnections,
  reconcileD1OAuthProviderExchangeRecoveries,
  reconcileD1OAuthRetention,
  releaseD1OAuthStartReservation,
  reserveD1OAuthProviderExchange,
  reserveD1OAuthFinalizationFlow,
} from "../../src/cloudflare-support/oauth-finalization-delivery";
import { createCloudflareGrantTransport } from "../../src/cloudflare-support/provider-transport";
import { reconcileOAuthRevocationCleanup } from "../../src/cloudflare-support/revocation-reconciler";
import {
  assertSupportReleaseExpectation,
  createInternalSupportEntrypointContract,
  createSupportEntrypointContract,
  type SupportReleaseExpectation,
} from "../../src/cloudflare-support/service-contract";
import {
  authorizeManagedPlatformConnection,
  assertManagedPlatformCustomerOperationAllowed,
  createCloudflareManagedDeploymentTransport,
  createManagedDeploymentBroker,
  inspectManagedPlatformConnection,
  parseManagedPlatformInspectionInput,
  parseManagedPlatformReservationInput,
  parseManagedPlatformRetirementInput,
  requireActiveManagedPlatformReservation,
  reserveManagedPlatformConnection,
  retireManagedPlatformConnection,
  type ManagedDeploymentDeleteInput,
  type ManagedDeploymentInspectInput,
  type ManagedDeploymentProvider,
  type ManagedDeploymentUploadInput,
  type ManagedPlatformInspectionInput,
  type ManagedPlatformReservationInput,
  type ManagedPlatformReservationProof,
  type ManagedPlatformRetirementInput,
  type ManagedPlatformRetirementProof,
} from "../../src/cloudflare-support/managed-deployment-broker";
import {
  readD1SupportHealth,
  runD1SupportReconciliation,
} from "../../src/cloudflare-support/support-health";
import { createCloudflareTemporaryTransport } from "../../src/cloudflare-support/temporary-transport";
import {
  beginD1TemporaryProvisioning,
  beginD1TemporaryWorkerDeployment,
  deliverD1PreparedTemporaryClaim,
  expireD1TemporaryClaimRecords,
  finalizeD1TemporaryCleanup,
  markD1TemporaryAmbiguityExpired,
  prepareD1TemporaryClaimDelivery,
  reconcileD1TemporaryProviderOperations,
  redeemD1TemporaryClaimRedirect,
  recordD1TemporaryAccountReady,
  recordD1TemporaryDeploymentActive,
  recoverD1TemporaryStaticDeployment,
  reserveD1TemporaryCleanupWithIntent,
  reserveD1TemporaryProviderOperationWithIntent,
  type D1TemporaryProviderOperationBinding,
} from "../../src/cloudflare-support/d1-temporary-operations";
import type { CloudflareTemporaryAccountRpcBinding } from "../../src/cloudflare-runtime-composition";

type OAuthRuntime = Awaited<ReturnType<typeof createOAuthRuntime>>;
type GrantBinding = Parameters<CloudflareGrantVaultResolver["withGrant"]>[0];

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACCOUNT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SESSION_BINDING = /^sha256:[a-f0-9]{64}$|^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DELIVERY_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const RETURN_KEY = /^[A-Za-z0-9_-]{22}$/;
const SAFE_AUDIT_KEYS = new Set([
  "eventKind",
  "actorKind",
  "actorId",
  "connectionId",
  "accountId",
  "outcome",
  "reason",
  "occurredAt",
  "auditEventId",
  "targetId",
  "revisionId",
  "providerDeploymentId",
]);

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  if (!value || !BASE64URL.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const bytes = Uint8Array.from(
      atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`),
      (character) => character.charCodeAt(0),
    );
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

async function sha256(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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

function exactOrigin(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new TypeError("control_plane_origin_invalid");
  }
  return url.origin;
}

function callbackUri(env: ControlPlaneEnv) {
  const origin = exactOrigin(env.CONTROL_PLANE_ORIGIN);
  if (env.OAUTH_CALLBACK_PATH !== "/oauth/callback") {
    throw new TypeError("oauth_callback_path_invalid");
  }
  return `${origin}${env.OAUTH_CALLBACK_PATH}`;
}

function stateIdWithoutTrust(state: string) {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const payload = decodeBase64Url(parts[0]!);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return record.version === 1 &&
      typeof record.id === "string" &&
      IDENTIFIER.test(record.id)
      ? record.id
      : null;
  } catch {
    return null;
  }
}

async function signingKey(encoded: string) {
  const bytes = decodeBase64Url(encoded);
  if (bytes?.byteLength !== 32) {
    throw new TypeError("oauth_state_signing_key_invalid");
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  } finally {
    bytes.fill(0);
  }
}

function stateTtl(env: ControlPlaneEnv) {
  const seconds = Number(env.OAUTH_STATE_TTL_SECONDS);
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 900) {
    throw new TypeError("oauth_state_ttl_invalid");
  }
  return seconds * 1_000;
}

async function recordControlAudit(
  env: ControlPlaneEnv,
  event: Record<string, unknown>,
) {
  if (
    Object.keys(event).some((key) => !SAFE_AUDIT_KEYS.has(key)) ||
    typeof event.eventKind !== "string" ||
    JSON.stringify(event).length > 16_384
  ) {
    throw new Error("control_audit_invalid");
  }
  await env.CONTROL_DB.prepare(
    `INSERT INTO control_audit_outbox (
      id, event_json, delivery_status, created_on, delivered_on
    ) VALUES (?, ?, 'pending', ?, NULL)`,
  )
    .bind(
      `control_audit_${crypto.randomUUID()}`,
      JSON.stringify(event),
      new Date().toISOString(),
    )
    .run();
}

async function requireCredentialContinuity(
  env: ControlPlaneEnv,
  now = Date.now(),
) {
  const continuity = await initializeD1CredentialContinuity({
    db: env.CONTROL_DB,
    encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
    now,
  });
  if (!continuity.ok) {
    throw new Error("credential_continuity_unavailable");
  }
}

async function createOAuthRuntime(env: ControlPlaneEnv) {
  const now = () => Date.now();
  await requireCredentialContinuity(env, now());
  const stateVault = createD1EncryptedCredentialVault({
    db: env.CONTROL_DB,
    encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
    now,
    purpose: "oauth_state",
  });
  const credentialVault = createD1EncryptedCredentialVault({
    db: env.CONTROL_DB,
    encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
    now,
    purpose: "oauth_credential",
  });
  const stateStore = createD1CloudflareOAuthStateStore({
    db: env.CONTROL_DB,
    vault: stateVault,
  });
  const connections = createD1CloudflareConnectionStore({
    db: env.CONTROL_DB,
    now,
  });
  const recoverableCommitConnection =
    createD1RecoverableOAuthConnectionCommitter({
      db: env.CONTROL_DB,
      encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now,
    });
  const verifiedAt = Number(env.OAUTH_CLIENT_SCOPES_VERIFIED_AT);
  if (!Number.isSafeInteger(verifiedAt) || verifiedAt <= 0) {
    throw new TypeError("oauth_client_registration_invalid");
  }
  const provider = createCloudflarePublicOAuthProvider({
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    redirectUris: [callbackUri(env)],
    allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
    clientRegistration: {
      source: "cloudflare_oauth_client_registration",
      verifiedAt,
      scopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
    },
    now,
    fetch: createCloudflareOAuthRedactingFetch({ fetch, now }),
  });
  const service = createCloudflareOAuthService({
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID,
    redirectUri: callbackUri(env),
    stateTtlMs: stateTtl(env),
    allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
    grantTypes: ["authorization_code", "refresh_token"],
    stateSigningKey: await signingKey(env.OAUTH_STATE_SIGNING_KEY),
    stateStore,
    vault: credentialVault,
    connections,
    recoverableCommitConnection,
    provider,
    now,
    audit: (event) => recordControlAudit(env, event),
  });
  return {
    now,
    stateStore,
    stateVault,
    credentialVault,
    connections,
    provider,
    service,
  };
}

function safeAppRedirect(env: ControlPlaneEnv, status: "denied") {
  const destination = new URL(
    "/api/cloudflare/oauth/return",
    exactOrigin(env.SHIPLET_APP_ORIGIN),
  );
  destination.searchParams.set("status", status);
  return new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function publicConnection(connection: CloudflareConnectionRecord) {
  return {
    id: connection.id,
    userId: connection.userId,
    accountId: connection.accountId,
    accountLabel: connection.accountLabel,
    scopes: [...connection.scopes],
    expiresAt: connection.expiresAt,
    status: connection.status,
    generation: connection.generation ?? 1,
  };
}

function parseOAuthDeliveryConnection(
  source: string,
  expected: { connectionId: string; userId: string; now: number },
) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const connection = value as Record<string, unknown>;
  const scopes = Array.isArray(connection.scopes)
    ? [...new Set(connection.scopes)]
    : [];
  const expectedScopes = [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES].sort();
  if (
    connection.id !== expected.connectionId ||
    connection.userId !== expected.userId ||
    typeof connection.accountId !== "string" ||
    !ACCOUNT_IDENTIFIER.test(connection.accountId) ||
    typeof connection.accountLabel !== "string" ||
    connection.accountLabel.length < 1 ||
    connection.accountLabel.length > 256 ||
    scopes.some((scope) => typeof scope !== "string") ||
    scopes.length !== expectedScopes.length ||
    scopes.sort().some((scope, index) => scope !== expectedScopes[index]) ||
    !Number.isSafeInteger(connection.expiresAt) ||
    (connection.expiresAt as number) <= expected.now ||
    connection.status !== "active" ||
    !Number.isSafeInteger(connection.generation) ||
    (connection.generation as number) < 1
  ) {
    return null;
  }
  return {
    id: connection.id as string,
    userId: connection.userId as string,
    accountId: connection.accountId,
    accountLabel: connection.accountLabel,
    scopes: expectedScopes,
    expiresAt: connection.expiresAt as number,
    status: "active" as const,
    generation: connection.generation as number,
  };
}

async function reserveConfiguredManagedPlatformConnection(
  env: ControlPlaneEnv,
  input: ManagedPlatformReservationInput,
) {
  const reservation = parseManagedPlatformReservationInput(input);
  const configuredConnectionId = env.WFP_PLATFORM_CONNECTION_ID ?? "";
  const configuredAccountId = env.WFP_PLATFORM_ACCOUNT_ID ?? "";
  if (
    reservation.connectionId !== configuredConnectionId ||
    reservation.accountId !== configuredAccountId
  ) {
    throw new Error("managed_platform_reservation_denied");
  }
  const now = Date.now();
  const connections = createD1CloudflareConnectionStore({
    db: env.CONTROL_DB,
    now: () => now,
  });
  const connection = await connections.get(configuredConnectionId);
  const authorized = authorizeManagedPlatformConnection({
    configuredConnectionId,
    configuredAccountId,
    connection,
    now,
  });
  if (authorized.ownerUserId !== reservation.actor.id) {
    throw new Error("managed_platform_reservation_denied");
  }
  return reserveManagedPlatformConnection({
    db: env.CONTROL_DB,
    now,
    input: reservation,
  });
}

async function inspectConfiguredManagedPlatformConnection(
  env: ControlPlaneEnv,
  input: ManagedPlatformInspectionInput,
) {
  const inspection = parseManagedPlatformInspectionInput(input);
  if (
    inspection.connectionId !== (env.WFP_PLATFORM_CONNECTION_ID ?? "") ||
    inspection.accountId !== (env.WFP_PLATFORM_ACCOUNT_ID ?? "")
  ) {
    throw new Error("managed_platform_inspection_denied");
  }
  return inspectManagedPlatformConnection({
    db: env.CONTROL_DB,
    input: inspection,
  });
}

async function retireConfiguredManagedPlatformConnection(
  env: ControlPlaneEnv,
  input: ManagedPlatformRetirementInput,
) {
  const retirement = parseManagedPlatformRetirementInput(input);
  if (
    retirement.connectionId !== (env.WFP_PLATFORM_CONNECTION_ID ?? "") ||
    retirement.accountId !== (env.WFP_PLATFORM_ACCOUNT_ID ?? "")
  ) {
    throw new Error("managed_platform_retirement_denied");
  }
  return retireManagedPlatformConnection({
    db: env.CONTROL_DB,
    now: Date.now(),
    input: retirement,
  });
}

export class CloudflareOAuthControlPlane extends WorkerEntrypoint<ControlPlaneEnv> {
  contract() {
    return createSupportEntrypointContract({
      service: "shiplet-cloudflare-control-plane",
      entrypoint: "CloudflareOAuthControlPlane",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  async health(expectation: SupportReleaseExpectation) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    try {
      await initializeD1CredentialContinuity({
        db: this.env.CONTROL_DB,
        encodedKey: this.env.CREDENTIAL_ENCRYPTION_KEY,
        now: Date.now(),
      });
    } catch {
      // The non-secret health response below reports unavailable continuity or
      // schema rather than disclosing initialization details.
    }
    return readD1SupportHealth({
      db: this.env.CONTROL_DB,
      encodedKey: this.env.CREDENTIAL_ENCRYPTION_KEY,
      now: Date.now(),
      maxFreshnessMs: 15 * 60_000,
      release: {
        versionId: this.env.CF_VERSION_METADATA.id.toLowerCase(),
        versionTag: this.env.CF_VERSION_METADATA.tag ?? "",
      },
    });
  }

  /**
   * Kernel-only operator ceremony used after an exact public OAuth connection
   * has been captured. The proof is non-secret; no vault material is read.
   */
  async reservePlatformConnection(
    input: ManagedPlatformReservationInput,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return reserveConfiguredManagedPlatformConnection(this.env, input);
  }

  async inspectPlatformConnection(
    input: ManagedPlatformInspectionInput,
    expectation: SupportReleaseExpectation,
  ): Promise<ManagedPlatformReservationProof> {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return inspectConfiguredManagedPlatformConnection(this.env, input);
  }

  async retirePlatformConnection(
    input: ManagedPlatformRetirementInput,
    expectation: SupportReleaseExpectation,
  ): Promise<ManagedPlatformRetirementProof> {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return retireConfiguredManagedPlatformConnection(this.env, input);
  }

  async scheduled() {
    const now = Date.now();
    return runD1SupportReconciliation({
      db: this.env.CONTROL_DB,
      encodedKey: this.env.CREDENTIAL_ENCRYPTION_KEY,
      now,
      reconcile: async () => {
        const runtime = await createOAuthRuntime(this.env);
        await reconcileD1ExpiredPendingOAuthConnections({
          db: this.env.CONTROL_DB,
          now,
          limit: 25,
          loadConnection: (connectionId) =>
            runtime.connections.get(connectionId),
          revoke: async (binding) => {
            const result = await runtime.service.revoke(binding);
            return {
              ok:
                result.ok ||
                ("connection" in result &&
                  result.connection.status === "revoked"),
            };
          },
        });
        await reconcileD1ExpiredOAuthFinalizationDeliveries({
          db: this.env.CONTROL_DB,
          now,
          limit: 25,
          revoke: async (binding) => {
            const result = await runtime.service.revoke(binding);
            return {
              ok:
                result.ok ||
                ("connection" in result &&
                  result.connection.status === "revoked"),
            };
          },
        });
        await reconcileD1OAuthProviderExchangeRecoveries({
          db: this.env.CONTROL_DB,
          now,
          limit: 25,
          revokeCredentialRef: (ref) =>
            runtime.credentialVault.withMaterial(ref, (material) =>
              runtime.provider.revoke(material),
            ),
          retireCredentialRef: (ref) => runtime.credentialVault.revoke(ref),
          audit: (event) => recordControlAudit(this.env, event),
        });
        await reconcileOAuthRevocationCleanup({
          listPending: (limit) =>
            listD1PendingCloudflareRevocations(this.env.CONTROL_DB, limit),
          retryRevocationCleanup: (input) =>
            runtime.service.retryRevocationCleanup(input),
          audit: (event) => recordControlAudit(this.env, event),
          now: runtime.now,
        });
        const temporaryTransport = createCloudflareTemporaryTransport({
          fetch,
          now: () => Date.now(),
        });
        const vaults = temporaryVaults(this.env);
        await reconcileD1TemporaryProviderOperations({
          db: this.env.CONTROL_DB,
          now,
          limit: 25,
          cleanup: async (operation) => {
            if (
              !operation.accountId ||
              !operation.authorizationRef ||
              !operation.scriptName
            ) {
              throw new Error("temporary_cleanup_binding_conflict");
            }
            return vaults.authority.withMaterial(
              operation.authorizationRef,
              async (material) => {
                const apiToken = (material as Record<string, unknown>).apiToken;
                if (typeof apiToken !== "string") {
                  throw new Error("temporary_cleanup_denied");
                }
                return temporaryTransport.deleteScript({
                  accountId: operation.accountId!,
                  apiToken,
                  scriptName: operation.scriptName,
                });
              },
            );
          },
          audit: async (operation, occurredAt) => ({
            id: `control_audit_recovery_${(
              await sha256(operation.operationId)
            ).slice(0, 48)}`,
            eventJson: JSON.stringify({
              eventKind: "cloudflare.temporary_deployment.cleaned",
              actorKind: "shiplet",
              actorId: operation.shipletId,
              targetId: operation.targetId,
              revisionId: operation.revisionId,
              providerDeploymentId: operation.providerDeploymentId,
              outcome: "success",
              reason: "scheduled_recovery",
              occurredAt,
            }),
            createdOn: new Date(occurredAt).toISOString(),
          }),
        });
        await expireD1TemporaryClaimRecords({
          db: this.env.CONTROL_DB,
          now,
        });
        await this.env.CONTROL_DB.batch([
          this.env.CONTROL_DB.prepare(
            `UPDATE temporary_deployments SET authorization_ref = NULL
             WHERE account_expires_at <= ?`,
          ).bind(now),
          this.env.CONTROL_DB.prepare(
            `DELETE FROM temporary_grant_consumptions WHERE expires_at <= ?`,
          ).bind(now),
          this.env.CONTROL_DB.prepare(
            `DELETE FROM grant_consumptions WHERE expires_at <= ?`,
          ).bind(now),
        ]);
        await reconcileD1OAuthRetention({
          db: this.env.CONTROL_DB,
          now,
          limit: 25,
          retentionMs: 7 * 86_400_000,
          retireStateRef: (ref) => runtime.stateVault.revoke(ref),
        });
      },
    });
  }

  async begin(
    input: {
      actor: { kind: "human"; id: string };
      shipletId: string;
      sessionBinding: string;
      deliveryHandle: string;
      returnKey: string;
      requestedScopes: string[];
      expectedAccountId?: string;
    },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    try {
      if (
        input.actor?.kind !== "human" ||
        !IDENTIFIER.test(input.actor.id) ||
        !IDENTIFIER.test(input.shipletId) ||
        !SESSION_BINDING.test(input.sessionBinding) ||
        !DELIVERY_HANDLE.test(input.deliveryHandle) ||
        !RETURN_KEY.test(input.returnKey) ||
        (input.expectedAccountId !== undefined &&
          !ACCOUNT_IDENTIFIER.test(input.expectedAccountId)) ||
        canonicalJson([...input.requestedScopes].sort()) !==
          canonicalJson(
            ["workers.scripts.read", "workers.scripts.write"].sort(),
          )
      ) {
        return { ok: false as const, reason: "oauth_begin_binding_invalid" };
      }
      const runtime = await createOAuthRuntime(this.env);
      const now = runtime.now();
      const sessionBindingDigest = await sha256(input.sessionBinding);
      const boundedStart = await beginD1OAuthStateWithinQuota({
        db: this.env.CONTROL_DB,
        shipletId: input.shipletId,
        userId: input.actor.id,
        sessionBindingDigest,
        ...(input.expectedAccountId
          ? { expectedAccountId: input.expectedAccountId }
          : {}),
        expiresAt: now + stateTtl(this.env),
        deliveryHandle: input.deliveryHandle,
        returnKey: input.returnKey,
        supportVersionId: expectation.versionId.toLowerCase(),
        supportVersionTag: expectation.versionTag,
        createdOn: new Date(now).toISOString(),
        begin: () =>
          runtime.service.begin({
            actor: input.actor,
            sessionId: input.sessionBinding,
            requestedScopes: input.requestedScopes,
            ...(input.expectedAccountId
              ? { expectedAccountId: input.expectedAccountId }
              : {}),
          }),
      });
      if (!boundedStart.ok) return boundedStart;
      const started = boundedStart.started;
      if (!("authorizationUrl" in started)) {
        await releaseD1OAuthStartReservation({
          db: this.env.CONTROL_DB,
          reservationId: boundedStart.reservationId,
          releasedOn: new Date(runtime.now()).toISOString(),
        }).catch(() => undefined);
        return started;
      }
      const authorization = new URL(started.authorizationUrl);
      const state = authorization.searchParams.get("state");
      if (!state) {
        return { ok: false as const, reason: "oauth_state_unavailable" };
      }
      const stateDigest = await sha256(state);
      const reserved = await reserveD1OAuthFinalizationFlow({
        db: this.env.CONTROL_DB,
        startReservationId: boundedStart.reservationId,
        stateDigest,
        now: runtime.now(),
      });
      if (!reserved.ok) {
        const untrustedStateId = stateIdWithoutTrust(state);
        if (untrustedStateId) {
          await runtime.stateStore
            .consume(untrustedStateId)
            .catch(() => undefined);
        }
        await releaseD1OAuthStartReservation({
          db: this.env.CONTROL_DB,
          reservationId: boundedStart.reservationId,
          releasedOn: new Date(runtime.now()).toISOString(),
        }).catch(() => undefined);
        return { ok: false as const, reason: reserved.reason };
      }
      return { ok: true as const, authorizationUrl: started.authorizationUrl };
    } catch {
      return { ok: false as const, reason: "oauth_control_plane_unavailable" };
    }
  }

  async finalize(
    input: {
      actor: { kind: "human"; id: string };
      shipletId: string;
      sessionBinding: string;
      deliveryHandle: string;
    },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    try {
      if (
        input.actor?.kind !== "human" ||
        !IDENTIFIER.test(input.actor.id) ||
        !IDENTIFIER.test(input.shipletId) ||
        !SESSION_BINDING.test(input.sessionBinding) ||
        !DELIVERY_HANDLE.test(input.deliveryHandle)
      ) {
        return { ok: false as const, reason: "oauth_finalize_binding_invalid" };
      }
      const now = Date.now();
      const sessionDigest = await sha256(input.sessionBinding);
      const delivery = await readD1OAuthFinalizationDelivery({
        db: this.env.CONTROL_DB,
        shipletId: input.shipletId,
        userId: input.actor.id,
        sessionBindingDigest: sessionDigest,
        deliveryHandle: input.deliveryHandle,
        now,
      });
      if (!delivery) {
        return { ok: false as const, reason: "oauth_finalization_unavailable" };
      }
      const connection = parseOAuthDeliveryConnection(
        delivery.deliveryResultJson,
        {
          connectionId: delivery.connectionId,
          userId: input.actor.id,
          now,
        },
      );
      if (!connection) {
        return { ok: false as const, reason: "oauth_connection_unavailable" };
      }
      return {
        ok: true as const,
        shipletId: delivery.shipletId,
        deliveryExpiresAt: delivery.deliveryExpiresAt,
        connection,
      };
    } catch {
      return { ok: false as const, reason: "oauth_control_plane_unavailable" };
    }
  }

  async acknowledge(
    input: {
      actor: { kind: "human"; id: string };
      shipletId: string;
      sessionBinding: string;
      deliveryHandle: string;
      connectionId: string;
    },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    try {
      if (
        input.actor?.kind !== "human" ||
        !IDENTIFIER.test(input.actor.id) ||
        !IDENTIFIER.test(input.shipletId) ||
        !SESSION_BINDING.test(input.sessionBinding) ||
        !DELIVERY_HANDLE.test(input.deliveryHandle) ||
        !IDENTIFIER.test(input.connectionId)
      ) {
        return {
          ok: false as const,
          reason: "oauth_delivery_ack_binding_invalid",
        };
      }
      return acknowledgeD1OAuthFinalizationDelivery({
        db: this.env.CONTROL_DB,
        shipletId: input.shipletId,
        userId: input.actor.id,
        sessionBindingDigest: await sha256(input.sessionBinding),
        deliveryHandle: input.deliveryHandle,
        connectionId: input.connectionId,
        now: Date.now(),
        acknowledgedOn: new Date().toISOString(),
      });
    } catch {
      return { ok: false as const, reason: "oauth_control_plane_unavailable" };
    }
  }

  async revoke(
    input: {
      actor: { kind: "human"; id: string };
      connectionId: string;
      sessionBinding: string;
    },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    try {
      if (
        input.actor?.kind !== "human" ||
        !IDENTIFIER.test(input.actor.id) ||
        !IDENTIFIER.test(input.connectionId) ||
        !SESSION_BINDING.test(input.sessionBinding)
      ) {
        return { ok: false as const, reason: "oauth_revoke_binding_invalid" };
      }
      try {
        await assertManagedPlatformCustomerOperationAllowed({
          db: this.env.CONTROL_DB,
          connectionId: input.connectionId,
          ownerUserId: input.actor.id,
          operation: "customer_revoke",
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "oauth_connection_reserved_for_managed_platform" ||
            error.message === "oauth_revoke_binding_invalid")
        ) {
          return {
            ok: false as const,
            reason: error.message as
              | "oauth_connection_reserved_for_managed_platform"
              | "oauth_revoke_binding_invalid",
          };
        }
        throw error;
      }
      const runtime = await createOAuthRuntime(this.env);
      const existing = await runtime.connections.get(input.connectionId);
      if (
        existing?.status === "revoked" &&
        existing.userId === input.actor.id
      ) {
        const reconciliation = await reconcileD1CloudflareRevocationForRpc({
          db: this.env.CONTROL_DB,
          connectionId: existing.id,
          userId: existing.userId,
          retryRevocationCleanup: (request) =>
            runtime.service.retryRevocationCleanup(request),
          audit: (event) => recordControlAudit(this.env, event),
          now: runtime.now,
        });
        if (!reconciliation.ok) {
          return {
            ok: false as const,
            reason: reconciliation.reason,
            connection: publicConnection(existing),
          };
        }
        return {
          ok: true as const,
          connection: {
            id: existing.id,
            userId: existing.userId,
            accountId: existing.accountId,
            status: "revoked" as const,
            generation: (existing.generation ?? 1) + 1,
          },
        };
      }
      const revoked = await runtime.service.revoke({
        actor: input.actor,
        connectionId: input.connectionId,
      });
      if (!revoked.ok) return revoked;
      return {
        ok: true as const,
        connection: {
          id: revoked.connection.id,
          userId: revoked.connection.userId,
          accountId: revoked.connection.accountId,
          status: "revoked" as const,
          generation: (revoked.connection.generation ?? 1) + 1,
        },
      };
    } catch {
      return { ok: false as const, reason: "oauth_control_plane_unavailable" };
    }
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (
      request.method !== "GET" ||
      url.pathname !== this.env.OAUTH_CALLBACK_PATH
    ) {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    const keys = [...url.searchParams.keys()];
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (
      !state ||
      !code ||
      state.length > 8_192 ||
      code.length > 8_192 ||
      keys.length !== 2 ||
      !keys.every((key) => key === "state" || key === "code")
    ) {
      return safeAppRedirect(this.env, "denied");
    }
    try {
      const runtime = await createOAuthRuntime(this.env);
      const stateDigest = await sha256(state);
      const flow = await this.env.CONTROL_DB.prepare(
        `SELECT shiplet_id, user_id, session_binding_digest,
                expected_account_id, expires_at, connection_id,
                support_version_id,
                support_version_tag, exchange_started_on, return_key
         FROM oauth_flows
         WHERE state_digest = ? AND status = 'pending'`,
      )
        .bind(stateDigest)
        .first<{
          shiplet_id: string;
          user_id: string;
          session_binding_digest: string;
          expected_account_id: string | null;
          expires_at: number;
          connection_id: string | null;
          support_version_id: string | null;
          support_version_tag: string | null;
          exchange_started_on: string | null;
          return_key: string | null;
        }>();
      const stateId = stateIdWithoutTrust(state);
      if (
        !flow ||
        flow.expires_at <= runtime.now() ||
        !flow.connection_id ||
        !IDENTIFIER.test(flow.connection_id) ||
        !flow.return_key ||
        !RETURN_KEY.test(flow.return_key)
      ) {
        return safeAppRedirect(this.env, "denied");
      }
      assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, {
        versionId: flow.support_version_id ?? "",
        versionTag: flow.support_version_tag ?? "",
      });
      let completed: Awaited<ReturnType<OAuthRuntime["service"]["complete"]>>;
      if (flow.exchange_started_on) {
        const recovered = await runtime.connections.get(flow.connection_id);
        if (
          !recovered ||
          recovered.status !== "active" ||
          recovered.userId !== flow.user_id
        ) {
          return safeAppRedirect(this.env, "denied");
        }
        completed = { ok: true, connection: publicConnection(recovered) };
      } else {
        const storedState = stateId
          ? await runtime.stateStore.get(stateId)
          : null;
        if (
          !storedState ||
          storedState.userId !== flow.user_id ||
          (await sha256(storedState.sessionId)) !== flow.session_binding_digest
        ) {
          return safeAppRedirect(this.env, "denied");
        }
        const reservation = await reserveD1OAuthProviderExchange({
          db: this.env.CONTROL_DB,
          stateDigest,
          connectionId: flow.connection_id,
          now: runtime.now(),
          startedOn: new Date(runtime.now()).toISOString(),
        });
        if (!reservation.ok || !reservation.claimed) {
          return safeAppRedirect(this.env, "denied");
        }
        completed = await runtime.service.complete({
          actor: { kind: "human", id: flow.user_id },
          sessionId: storedState.sessionId,
          redirectUri: callbackUri(this.env),
          authorizationCode: code,
          state,
          connectionId: flow.connection_id,
          ...(flow.expected_account_id
            ? { selectedAccountId: flow.expected_account_id }
            : {}),
        });
      }
      if (!completed.ok) {
        await this.env.CONTROL_DB.prepare(
          `UPDATE oauth_flows SET status = 'denied', completed_on = ?
           WHERE state_digest = ? AND status = 'pending'`,
        )
          .bind(new Date().toISOString(), stateDigest)
          .run();
        return safeAppRedirect(this.env, "denied");
      }
      const committed = await markD1OAuthProviderExchangeCommitted({
        db: this.env.CONTROL_DB,
        stateDigest,
        connectionId: completed.connection.id,
        committedOn: new Date(runtime.now()).toISOString(),
      });
      if (!committed.ok) {
        await runtime.service.revoke({
          actor: { kind: "human", id: flow.user_id },
          connectionId: completed.connection.id,
        });
        return safeAppRedirect(this.env, "denied");
      }
      const delivery = await prepareD1OAuthFinalizationDelivery({
        db: this.env.CONTROL_DB,
        stateDigest,
        shipletId: flow.shiplet_id,
        userId: flow.user_id,
        sessionBindingDigest: flow.session_binding_digest,
        connectionId: completed.connection.id,
        deliveryResultJson: canonicalJson(completed.connection),
        completedOn: new Date(runtime.now()).toISOString(),
        deliveryExpiresAt: runtime.now() + stateTtl(this.env),
      });
      if (!delivery.ok) {
        await runtime.service.revoke({
          actor: { kind: "human", id: flow.user_id },
          connectionId: completed.connection.id,
        });
        return safeAppRedirect(this.env, "denied");
      }
      return createOAuthDeliveryReturnResponse({
        appOrigin: exactOrigin(this.env.SHIPLET_APP_ORIGIN),
        shipletId: flow.shiplet_id,
        status: "connected",
        returnKey: flow.return_key ?? "",
      });
    } catch {
      return safeAppRedirect(this.env, "denied");
    }
  }
}

export class CloudflareGrantVaultRpc extends WorkerEntrypoint<ControlPlaneEnv> {
  contract() {
    return createSupportEntrypointContract({
      service: "shiplet-cloudflare-control-plane",
      entrypoint: "CloudflareGrantVaultRpc",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  async withGrant<Result>(
    binding: GrantBinding,
    operation: (transport: {
      requestBytes: ReturnType<
        typeof createCloudflareGrantTransport
      >["requestBytes"];
      uploadStaticAssets: ReturnType<
        typeof createCloudflareGrantTransport
      >["uploadStaticAssets"];
    }) => Promise<Result>,
    expectation: SupportReleaseExpectation,
  ): Promise<Result> {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    if (typeof operation !== "function") {
      throw new TypeError("cloudflare_grant_operation_invalid");
    }
    const connectionId = binding.handle.startsWith("control-plane:")
      ? binding.handle.slice("control-plane:".length)
      : "";
    if (!IDENTIFIER.test(connectionId)) {
      throw new Error("cloudflare_grant_denied");
    }
    await assertManagedPlatformCustomerOperationAllowed({
      db: this.env.CONTROL_DB,
      connectionId,
      ownerUserId: binding.userId,
      operation: "customer_grant",
    });
    const runtime = await createOAuthRuntime(this.env);
    const now = runtime.now();
    const grant = {
      ...binding,
      packageDigest: binding.packageDigest ?? "",
    };
    const connection = await authorizeCloudflareGrantConnection({
      grant,
      expected: grant,
      now,
      load: async () => {
        const current = await runtime.connections.get(connectionId);
        return current
          ? { ...current, generation: current.generation ?? 0 }
          : null;
      },
      refresh: async () => {
        const refreshed = await runtime.service.refresh({
          actor: { kind: "human", id: binding.userId },
          connectionId,
        });
        return refreshed.ok;
      },
    });
    if (!connection) throw new Error("cloudflare_grant_denied");
    const grantDigest = await sha256(canonicalJson(binding));
    const consumed = await this.env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO grant_consumptions (
        grant_digest, connection_id, operation, expires_at, consumed_on
      ) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        grantDigest,
        connection.id,
        binding.operation,
        binding.expiresAt,
        new Date(runtime.now()).toISOString(),
      )
      .run();
    if (consumed.meta.changes !== 1) {
      throw new Error("cloudflare_grant_replayed");
    }
    await assertManagedPlatformCustomerOperationAllowed({
      db: this.env.CONTROL_DB,
      connectionId,
      ownerUserId: binding.userId,
      operation: "customer_grant",
    });
    return runtime.credentialVault.withMaterial(
      connection.credentialRef,
      async (material) => {
        await assertManagedPlatformCustomerOperationAllowed({
          db: this.env.CONTROL_DB,
          connectionId,
          ownerUserId: binding.userId,
          operation: "customer_grant",
        });
        if (
          !material ||
          typeof material !== "object" ||
          Array.isArray(material) ||
          typeof (material as Record<string, unknown>).accessToken !== "string"
        ) {
          throw new Error("cloudflare_grant_denied");
        }
        const transport = createCloudflareGrantTransport({
          credential: {
            accessToken: (material as Record<string, unknown>)
              .accessToken as string,
          },
          binding: {
            accountId: binding.accountId,
            scriptName: binding.scriptName,
            operation: binding.operation,
            revisionId: binding.revisionId,
            packageDigest: binding.packageDigest ?? "",
          },
          fetch,
        });
        return operation(transport);
      },
    );
  }
}

const MANAGED_PLATFORM_SCOPES = Object.freeze([
  "offline_access",
  "workers.scripts.read",
  "workers.scripts.write",
] as const);

function exactManagedPlatformScopes(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.some((scope) => typeof scope !== "string")
  ) {
    return false;
  }
  const sorted = [...value].sort();
  const expected = [...MANAGED_PLATFORM_SCOPES].sort();
  return (
    sorted.length === expected.length &&
    sorted.every((scope, index) => scope === expected[index])
  );
}

async function withManagedPlatformTransport<Result>(
  env: ControlPlaneEnv,
  reservation: ManagedPlatformReservationProof,
  operation: (
    transport: ReturnType<typeof createCloudflareManagedDeploymentTransport>,
  ) => Promise<Result>,
) {
  const connectionId = env.WFP_PLATFORM_CONNECTION_ID ?? "";
  const accountId = env.WFP_PLATFORM_ACCOUNT_ID ?? "";
  if (!IDENTIFIER.test(connectionId) || !ACCOUNT_IDENTIFIER.test(accountId)) {
    throw new Error("managed_platform_connection_denied");
  }
  const activeReservation = await requireActiveManagedPlatformReservation({
    db: env.CONTROL_DB,
    connectionId,
    accountId,
    ownerUserId: reservation.ownerUserId,
  });
  if (
    activeReservation.operationId !== reservation.operationId ||
    activeReservation.purpose !== reservation.purpose ||
    activeReservation.status !== "active"
  ) {
    throw new Error("managed_platform_reservation_required");
  }
  const runtime = await createOAuthRuntime(env);
  let connection = await runtime.connections.get(connectionId);
  const now = runtime.now();
  if (
    connection &&
    connection.id === connectionId &&
    connection.accountId === accountId &&
    connection.status === "active" &&
    IDENTIFIER.test(connection.userId) &&
    exactManagedPlatformScopes(connection.scopes) &&
    Number.isSafeInteger(connection.expiresAt) &&
    connection.expiresAt <= now + 60_000
  ) {
    const refreshed = await runtime.service.refresh({
      actor: { kind: "human", id: connection.userId },
      connectionId,
      idempotencyKey: `managed-platform-${connection.generation ?? 1}`,
    });
    if (!refreshed.ok) {
      throw new Error("managed_platform_connection_denied");
    }
    connection = await runtime.connections.get(connectionId);
  }
  const authorized = authorizeManagedPlatformConnection({
    configuredConnectionId: connectionId,
    configuredAccountId: accountId,
    connection,
    now: runtime.now(),
  });
  if (authorized.ownerUserId !== activeReservation.ownerUserId) {
    throw new Error("managed_platform_reservation_required");
  }
  return runtime.credentialVault.withMaterial(
    authorized.credentialRef,
    async (material) => {
      const stillActive = await requireActiveManagedPlatformReservation({
        db: env.CONTROL_DB,
        connectionId: authorized.connectionId,
        accountId: authorized.accountId,
        ownerUserId: authorized.ownerUserId,
      });
      if (stillActive.operationId !== activeReservation.operationId) {
        throw new Error("managed_platform_reservation_required");
      }
      const accessToken =
        material && typeof material === "object" && !Array.isArray(material)
          ? (material as Record<string, unknown>).accessToken
          : undefined;
      if (
        typeof accessToken !== "string" ||
        accessToken.length < 16 ||
        accessToken.length > 4_096 ||
        !/^[\x21-\x7e]+$/.test(accessToken)
      ) {
        throw new Error("managed_platform_connection_denied");
      }
      const transport = createCloudflareManagedDeploymentTransport({
        accountId: authorized.accountId,
        authorizedFetch: async (request) => {
          const headers = new Headers(request.headers);
          headers.delete("authorization");
          headers.set("authorization", ["Bearer", accessToken].join(" "));
          return fetch(
            new Request(request, {
              headers,
              redirect: "manual",
            }),
          );
        },
      });
      return operation(transport);
    },
  );
}

function managedPlatformProvider(
  env: ControlPlaneEnv,
  reservation: ManagedPlatformReservationProof,
): ManagedDeploymentProvider {
  const provider: ManagedDeploymentProvider = {
    readNamespace: (
      namespace: Parameters<ManagedDeploymentProvider["readNamespace"]>[0],
    ) =>
      withManagedPlatformTransport(env, reservation, (transport) =>
        transport.readNamespace(namespace),
      ),
    inspectScript: (
      input: Parameters<ManagedDeploymentProvider["inspectScript"]>[0],
    ) =>
      withManagedPlatformTransport(env, reservation, (transport) =>
        transport.inspectScript(input),
      ),
    uploadScript: (
      input: Parameters<ManagedDeploymentProvider["uploadScript"]>[0],
    ) =>
      withManagedPlatformTransport(env, reservation, (transport) =>
        transport.uploadScript(input),
      ),
    deleteScript: (
      input: Parameters<ManagedDeploymentProvider["deleteScript"]>[0],
    ) =>
      withManagedPlatformTransport(env, reservation, (transport) =>
        transport.deleteScript(input),
      ),
  };
  return Object.freeze(provider);
}

function managedDeploymentBroker(env: ControlPlaneEnv) {
  const connectionId = env.WFP_PLATFORM_CONNECTION_ID ?? "";
  const accountId = env.WFP_PLATFORM_ACCOUNT_ID ?? "";
  return createManagedDeploymentBroker({
    db: env.CONTROL_DB,
    now: () => Date.now(),
    platformAccountId: accountId,
    requirePlatformReservation: () =>
      requireActiveManagedPlatformReservation({
        db: env.CONTROL_DB,
        connectionId,
        accountId,
      }),
    resolveProvider: async (reservation) =>
      managedPlatformProvider(env, reservation),
  });
}

/**
 * Credential-owning deployment boundary used only by ManagedRuntimeGateway.
 * OAuth material never crosses this entrypoint; callers receive exact,
 * non-secret readiness and deployment proofs only.
 */
export class CloudflareManagedDeploymentBrokerRpc extends WorkerEntrypoint<ControlPlaneEnv> {
  contract() {
    return createInternalSupportEntrypointContract({
      service: "shiplet-cloudflare-control-plane",
      entrypoint: "CloudflareManagedDeploymentBrokerRpc",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  async readiness(expectation: SupportReleaseExpectation) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return managedDeploymentBroker(this.env).readiness();
  }

  async assertPlatformReservation(expectation: SupportReleaseExpectation) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    const connectionId = this.env.WFP_PLATFORM_CONNECTION_ID ?? "";
    const accountId = this.env.WFP_PLATFORM_ACCOUNT_ID ?? "";
    await requireActiveManagedPlatformReservation({
      db: this.env.CONTROL_DB,
      connectionId,
      accountId,
    });
    return Object.freeze({ ok: true as const });
  }

  async inspect(
    input: ManagedDeploymentInspectInput,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return managedDeploymentBroker(this.env).inspect(input);
  }

  async upload(
    input: ManagedDeploymentUploadInput,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return managedDeploymentBroker(this.env).upload(input);
  }

  async delete(
    input: ManagedDeploymentDeleteInput,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    return managedDeploymentBroker(this.env).delete(input);
  }
}

type TemporaryCreateInput = Parameters<
  CloudflareTemporaryAccountRpcBinding["createAndDeploy"]
>[0];
type TemporaryCleanupInput = Parameters<
  CloudflareTemporaryAccountRpcBinding["cleanup"]
>[0];

type TemporaryDeploymentRow = {
  id: string;
  user_id: string;
  shiplet_id: string;
  target_id: string;
  revision_id: string;
  package_digest: string;
  account_id: string;
  script_name: string;
  request_digest: string;
  provider_deployment_id: string;
  provider_version_id: string;
  authorization_ref: string | null;
  claim_ref: string | null;
  account_expires_at: number;
  claim_expires_at: number;
  status: "active" | "claim_delivered" | "expired" | "cleaned";
  operation_id: string | null;
  delivery_event_id: string | null;
  delivery_started_on: string | null;
};

type TemporaryClaimPreparationRow = TemporaryDeploymentRow & {
  handle_digest: string | null;
  redirect_delivery_event_id: string | null;
  handle_ref: string | null;
  redirect_expires_at: number | null;
};

const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const REQUEST_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

function temporaryBinding(
  authorization: TemporaryCreateInput["authorization"],
) {
  return {
    userId: authorization.userId,
    shipletId: authorization.shipletId,
    accountHandle: authorization.accountHandle,
    targetId: authorization.targetId,
    scriptName: authorization.scriptName,
    revisionId: authorization.revisionId,
    packageDigest: authorization.packageDigest,
    requestDigest: authorization.requestDigest,
    operationId: authorization.operationId,
  };
}

async function validateTemporaryGrant<
  Operation extends
    | "temporary.deployment.create"
    | "temporary.deployment.cleanup",
>(input: {
  env: ControlPlaneEnv;
  authorization: TemporaryCreateInput["authorization"];
  canonicalRequest: Record<string, unknown>;
  operation: Operation;
}) {
  const now = Date.now();
  const requiredScopes =
    input.operation === "temporary.deployment.create"
      ? ["temporary.accounts.create", "temporary.workers.deploy"]
      : ["temporary.workers.cleanup"];
  const authorization = input.authorization;
  if (
    !IDENTIFIER.test(authorization.handle) ||
    !IDENTIFIER.test(authorization.operationId) ||
    !IDENTIFIER.test(authorization.userId) ||
    !IDENTIFIER.test(authorization.shipletId) ||
    !IDENTIFIER.test(authorization.accountHandle) ||
    !IDENTIFIER.test(authorization.targetId) ||
    !SCRIPT_IDENTIFIER.test(authorization.scriptName) ||
    !IDENTIFIER.test(authorization.revisionId) ||
    !PACKAGE_DIGEST.test(authorization.packageDigest) ||
    !REQUEST_DIGEST.test(authorization.requestDigest) ||
    authorization.operation !== input.operation ||
    canonicalJson(authorization.requiredScopes) !==
      canonicalJson(requiredScopes) ||
    !Number.isSafeInteger(authorization.expiresAt) ||
    authorization.expiresAt <= now ||
    authorization.expiresAt > now + 30_000 ||
    authorization.requestDigest !==
      `sha256:${await sha256(canonicalJson(input.canonicalRequest))}`
  ) {
    throw new Error("temporary_grant_denied");
  }
  return {
    now,
    grantDigest: await sha256(canonicalJson(authorization)),
    handleDigest: await sha256(authorization.handle),
    operation: input.operation,
    expiresAt: authorization.expiresAt,
    consumedOn: new Date(now).toISOString(),
  };
}

function temporaryVaults(env: ControlPlaneEnv) {
  const now = () => Date.now();
  return {
    authority: createD1EncryptedCredentialVault({
      db: env.CONTROL_DB,
      encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now,
      purpose: "temporary_authority",
      expiresAt: (material) =>
        Number((material as Record<string, unknown>).expiresAt),
    }),
    claim: createD1EncryptedCredentialVault({
      db: env.CONTROL_DB,
      encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now,
      purpose: "temporary_claim",
      expiresAt: (material) =>
        Number((material as Record<string, unknown>).expiresAt),
    }),
    redirect: createD1EncryptedCredentialVault({
      db: env.CONTROL_DB,
      encodedKey: env.CREDENTIAL_ENCRYPTION_KEY,
      now,
      purpose: "temporary_redirect_handle",
      expiresAt: (material) =>
        Number((material as Record<string, unknown>).expiresAt),
    }),
  };
}

function temporaryOperationBinding(
  authorization: TemporaryCreateInput["authorization"],
): D1TemporaryProviderOperationBinding {
  return {
    operationId: authorization.operationId,
    operationKind: "temporary.deployment.create",
    userId: authorization.userId,
    shipletId: authorization.shipletId,
    targetId: authorization.targetId,
    revisionId: authorization.revisionId,
    packageDigest: authorization.packageDigest,
    scriptName: authorization.scriptName,
    requestDigest: authorization.requestDigest,
  };
}

async function stableTemporaryUuid(kind: string, operationId: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${kind}:${operationId}`),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactTemporaryRequest(
  request: Record<string, unknown>,
  authorization: TemporaryCreateInput["authorization"],
) {
  return (
    request.operationId === authorization.operationId &&
    request.termsOfService === "https://www.cloudflare.com/terms/" &&
    request.privacyPolicy === "https://www.cloudflare.com/privacypolicy/" &&
    request.acceptTermsOfService === "yes" &&
    request.actorId === authorization.userId &&
    request.shipletId === authorization.shipletId &&
    request.targetId === authorization.targetId &&
    request.accountHandle === authorization.accountHandle &&
    request.scriptName === authorization.scriptName &&
    request.revisionId === authorization.revisionId &&
    request.packageDigest === authorization.packageDigest &&
    Array.isArray(request.staticAssets) &&
    request.staticAssets.length > 0 &&
    request.staticAssets.length <= 1_000 &&
    request.serialization !== null &&
    typeof request.serialization === "object" &&
    !Array.isArray(request.serialization) &&
    (request.serialization as Record<string, unknown>).kind ===
      "cloudflare_temporary_static_multipart"
  );
}

export class CloudflareTemporaryAccountRpc extends WorkerEntrypoint<ControlPlaneEnv> {
  contract() {
    return createSupportEntrypointContract({
      service: "shiplet-cloudflare-control-plane",
      entrypoint: "CloudflareTemporaryAccountRpc",
      metadata: this.env.CF_VERSION_METADATA,
    });
  }

  async createAndDeploy(
    input: TemporaryCreateInput,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    await requireCredentialContinuity(this.env);
    if (!exactTemporaryRequest(input.request, input.authorization)) {
      throw new TypeError("temporary_deployment_request_invalid");
    }
    const transport = createCloudflareTemporaryTransport({
      fetch,
      now: () => Date.now(),
    });
    const grant = await validateTemporaryGrant({
      env: this.env,
      authorization: input.authorization,
      canonicalRequest: input.canonicalRequest,
      operation: "temporary.deployment.create",
    });
    const binding = temporaryOperationBinding(input.authorization);
    const requestedEvent = {
      eventKind: "cloudflare.temporary_deployment.create_requested",
      actorKind: "human",
      actorId: input.authorization.userId,
      targetId: input.authorization.targetId,
      revisionId: input.authorization.revisionId,
      outcome: "requested",
      occurredAt: grant.now,
    };
    const reserved = await reserveD1TemporaryProviderOperationWithIntent({
      db: this.env.CONTROL_DB,
      binding,
      now: grant.now,
      ambiguityExpiresAt: grant.now + 60 * 60 * 1_000,
      grant,
      audit: {
        id: `control_audit_${crypto.randomUUID()}`,
        eventJson: JSON.stringify(requestedEvent),
        createdOn: new Date(grant.now).toISOString(),
      },
    });
    if (!reserved.ok) throw new Error(reserved.reason);
    let operation = reserved.operation;
    const vaults = temporaryVaults(this.env);
    if (operation.state === "provisioning") {
      if (grant.now >= operation.ambiguityExpiresAt) {
        await markD1TemporaryAmbiguityExpired({
          db: this.env.CONTROL_DB,
          binding,
          now: grant.now,
        });
        throw new Error("temporary_provisioning_ambiguity_expired");
      }
      throw new Error("temporary_provisioning_outcome_ambiguous");
    }
    if (operation.state === "ambiguity_expired") {
      throw new Error("temporary_provisioning_ambiguity_expired");
    }
    if (operation.state === "reserved") {
      const begun = await beginD1TemporaryProvisioning({
        db: this.env.CONTROL_DB,
        binding,
        now: grant.now,
      });
      if (!begun.ok) throw new Error(begun.reason);
      const provisioned = await transport.provisionAccount({
        termsOfService: input.request.termsOfService as string,
        privacyPolicy: input.request.privacyPolicy as string,
        acceptTermsOfService: "yes",
      });
      const authorityRef = (
        await vaults.authority.stage({
          apiToken: provisioned.sensitive.apiToken,
          expiresAt: provisioned.public.accountExpiresAt,
        })
      ).ref;
      const claimRef = (
        await vaults.claim.stage({
          claimUrl: provisioned.sensitive.claimUrl,
          expiresAt: provisioned.public.claimExpiresAt,
        })
      ).ref;
      const checkpointed = await recordD1TemporaryAccountReady({
        db: this.env.CONTROL_DB,
        binding,
        now: Date.now(),
        account: {
          accountId: provisioned.public.accountId,
          authorizationRef: authorityRef,
          claimRef,
          accountExpiresAt: provisioned.public.accountExpiresAt,
          claimExpiresAt: provisioned.public.claimExpiresAt,
        },
      });
      if (!checkpointed.ok) throw new Error(checkpointed.reason);
      operation = {
        ...operation,
        state: "account_ready",
        accountId: provisioned.public.accountId,
        authorizationRef: authorityRef,
        claimRef,
        accountExpiresAt: provisioned.public.accountExpiresAt,
        claimExpiresAt: provisioned.public.claimExpiresAt,
      };
    }
    if (
      operation.state !== "account_ready" &&
      operation.state !== "deploying" &&
      operation.state !== "active"
    ) {
      throw new Error("temporary_operation_not_recoverable");
    }
    if (operation.state !== "active") {
      if (
        !operation.accountId ||
        !operation.authorizationRef ||
        !operation.claimRef ||
        !operation.accountExpiresAt ||
        !operation.claimExpiresAt
      ) {
        throw new Error("temporary_account_checkpoint_invalid");
      }
      const accountId = operation.accountId;
      const authorizationRef = operation.authorizationRef;
      const withAuthority = <T>(
        use: (apiToken: string) => T | PromiseLike<T>,
      ) =>
        vaults.authority.withMaterial(authorizationRef, async (material) => {
          const apiToken = (material as Record<string, unknown>).apiToken;
          if (typeof apiToken !== "string") {
            throw new Error("temporary_authority_invalid");
          }
          return use(apiToken);
        });
      const deployed = await recoverD1TemporaryStaticDeployment({
        state: operation.state,
        begin: async () => {
          const begun = await beginD1TemporaryWorkerDeployment({
            db: this.env.CONTROL_DB,
            binding,
            now: Date.now(),
          });
          if (!begun.ok) throw new Error(begun.reason);
        },
        upload: () =>
          withAuthority((apiToken) =>
            transport.deployStaticToProvisionedAccount({
              accountId,
              apiToken,
              scriptName: binding.scriptName,
              compatibilityDate: "2026-08-07",
              packageDigest: binding.packageDigest,
              staticAssets: input.request.staticAssets as Array<{
                path: string;
                mediaType: string;
                content: string;
                encoding?: "utf8" | "base64";
              }>,
            }),
          ),
        inspect: () =>
          withAuthority((apiToken) =>
            transport.inspectStaticDeployment({
              accountId,
              apiToken,
              scriptName: binding.scriptName,
              packageDigest: binding.packageDigest,
            }),
          ),
        checkpoint: async (deployment) => {
          const active = await recordD1TemporaryDeploymentActive({
            db: this.env.CONTROL_DB,
            binding,
            now: Date.now(),
            deployment,
          });
          if (!active.ok) throw new Error(active.reason);
          return deployment;
        },
      });
      operation = {
        ...operation,
        state: "active",
        providerDeploymentId: deployed.providerDeploymentId,
        providerVersionId: deployed.providerVersionId,
        workersDevUrl: deployed.workersDevUrl,
        serializedBodyBytes: deployed.serializedBodyBytes,
      };
    }
    if (
      !operation.accountId ||
      !operation.authorizationRef ||
      !operation.claimRef ||
      !operation.accountExpiresAt ||
      !operation.claimExpiresAt ||
      !operation.providerDeploymentId ||
      !operation.providerVersionId ||
      !operation.workersDevUrl ||
      !operation.serializedBodyBytes
    ) {
      throw new Error("temporary_active_checkpoint_invalid");
    }
    const deploymentId = `temporary_${binding.operationId}`;
    const createdOn = new Date(grant.now).toISOString();
    const createdEvent = {
      eventKind: "cloudflare.temporary_deployment.created",
      actorKind: "human",
      actorId: binding.userId,
      targetId: binding.targetId,
      revisionId: binding.revisionId,
      providerDeploymentId: operation.providerDeploymentId,
      outcome: "success",
      occurredAt: grant.now,
    };
    await this.env.CONTROL_DB.batch([
      this.env.CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO temporary_deployments (
          id, user_id, shiplet_id, target_id, revision_id, package_digest,
          account_id, script_name, request_digest, provider_deployment_id,
          provider_version_id, workers_dev_url, authorization_ref, claim_ref,
          account_expires_at, claim_expires_at, status, created_on,
          claim_delivered_on, cleaned_on, operation_id, delivery_event_id,
          delivery_started_on
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
          ?, NULL, NULL, ?, NULL, NULL)`,
      ).bind(
        deploymentId,
        binding.userId,
        binding.shipletId,
        binding.targetId,
        binding.revisionId,
        binding.packageDigest,
        operation.accountId,
        binding.scriptName,
        binding.requestDigest,
        operation.providerDeploymentId,
        operation.providerVersionId,
        operation.workersDevUrl,
        operation.authorizationRef,
        operation.claimRef,
        operation.accountExpiresAt,
        operation.claimExpiresAt,
        createdOn,
        binding.operationId,
      ),
      this.env.CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        ) VALUES (?, ?, 'pending', ?, NULL)`,
      ).bind(
        `control_audit_created_${(await sha256(binding.operationId)).slice(0, 48)}`,
        JSON.stringify(createdEvent),
        createdOn,
      ),
    ]);
    const persisted = await this.env.CONTROL_DB.prepare(
      `SELECT * FROM temporary_deployments WHERE operation_id = ? AND user_id = ?
       AND shiplet_id = ? AND target_id = ? AND revision_id = ?
       AND package_digest = ? AND request_digest = ? AND status = 'active'
       LIMIT 1`,
    )
      .bind(
        binding.operationId,
        binding.userId,
        binding.shipletId,
        binding.targetId,
        binding.revisionId,
        binding.packageDigest,
        binding.requestDigest,
      )
      .first<TemporaryDeploymentRow>();
    if (!persisted) throw new Error("temporary_deployment_persistence_failed");
    return {
      providerDeploymentId: operation.providerDeploymentId,
      providerVersionId: operation.providerVersionId,
      selectedVersionId: operation.providerVersionId,
      temporaryAuthorizationRef: operation.authorizationRef,
      claimRef: operation.claimRef,
      binding: temporaryBinding(input.authorization),
      expiresAt: operation.claimExpiresAt,
      serializedBodyBytes: operation.serializedBodyBytes,
    };
  }

  async cleanup(
    input: TemporaryCleanupInput,
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    await requireCredentialContinuity(this.env);
    const request = input.request;
    const transport = createCloudflareTemporaryTransport({
      fetch,
      now: () => Date.now(),
    });
    if (
      request.operationId !== input.authorization.operationId ||
      request.actorId !== input.authorization.userId ||
      request.shipletId !== input.authorization.shipletId ||
      request.targetId !== input.authorization.targetId ||
      request.accountId !== input.authorization.accountHandle ||
      request.scriptName !== input.authorization.scriptName ||
      request.revisionId !== input.authorization.revisionId ||
      request.packageDigest !== input.authorization.packageDigest ||
      typeof request.providerDeploymentId !== "string" ||
      typeof request.providerVersionId !== "string"
    ) {
      throw new TypeError("temporary_cleanup_request_invalid");
    }
    const row = await this.env.CONTROL_DB.prepare(
      `SELECT * FROM temporary_deployments
       WHERE operation_id = ? AND user_id = ? AND shiplet_id = ?
         AND target_id = ? AND revision_id = ? AND package_digest = ?
         AND script_name = ? AND account_id = ?
         AND provider_deployment_id = ? AND provider_version_id = ?
         AND status IN ('active', 'claim_delivered', 'expired', 'cleaned')
       LIMIT 1`,
    )
      .bind(
        input.authorization.operationId,
        input.authorization.userId,
        input.authorization.shipletId,
        input.authorization.targetId,
        input.authorization.revisionId,
        input.authorization.packageDigest,
        input.authorization.scriptName,
        input.authorization.accountHandle,
        request.providerDeploymentId,
        request.providerVersionId,
      )
      .first<TemporaryDeploymentRow>();
    if (!row?.operation_id) throw new Error("temporary_cleanup_denied");
    const binding: D1TemporaryProviderOperationBinding = {
      operationId: row.operation_id,
      operationKind: "temporary.deployment.create",
      userId: row.user_id,
      shipletId: row.shiplet_id,
      targetId: row.target_id,
      revisionId: row.revision_id,
      packageDigest: row.package_digest,
      scriptName: row.script_name,
      requestDigest: row.request_digest,
    };
    const grant = await validateTemporaryGrant({
      env: this.env,
      authorization: input.authorization,
      canonicalRequest: input.request,
      operation: "temporary.deployment.cleanup",
    });
    const requestedOn = grant.now;
    const requested = await reserveD1TemporaryCleanupWithIntent({
      db: this.env.CONTROL_DB,
      binding,
      deploymentId: row.id,
      now: requestedOn,
      grant,
      audit: {
        id: `control_audit_cleanup_requested_${crypto.randomUUID()}`,
        eventJson: JSON.stringify({
          eventKind: "cloudflare.temporary_deployment.cleanup_requested",
          actorKind: "human",
          actorId: input.authorization.userId,
          targetId: input.authorization.targetId,
          revisionId: input.authorization.revisionId,
          providerDeploymentId: request.providerDeploymentId,
          outcome: "requested",
          occurredAt: requestedOn,
        }),
        createdOn: new Date(requestedOn).toISOString(),
      },
    });
    if (!requested.ok) throw new Error(requested.reason);
    if (requested.operation.state === "cleaned") {
      return {
        success: true as const,
        selectedVersionId: request.providerVersionId,
        binding: temporaryBinding(input.authorization),
        serializedBodyBytes: 0,
      };
    }
    if (!row.authorization_ref) throw new Error("temporary_cleanup_denied");
    const vaults = temporaryVaults(this.env);
    const cleanup = await vaults.authority.withMaterial(
      row.authorization_ref,
      async (material) => {
        const apiToken = (material as Record<string, unknown>).apiToken;
        if (typeof apiToken !== "string") {
          throw new Error("temporary_cleanup_denied");
        }
        return transport.deleteScript({
          accountId: row.account_id,
          apiToken,
          scriptName: row.script_name,
        });
      },
    );
    const finalizedOn = Date.now();
    const finalized = await finalizeD1TemporaryCleanup({
      db: this.env.CONTROL_DB,
      binding,
      deploymentId: row.id,
      now: finalizedOn,
      audit: {
        id: `control_audit_cleanup_success_${(
          await sha256(binding.operationId)
        ).slice(0, 48)}`,
        eventJson: JSON.stringify({
          eventKind: "cloudflare.temporary_deployment.cleaned",
          actorKind: "human",
          actorId: input.authorization.userId,
          targetId: input.authorization.targetId,
          revisionId: input.authorization.revisionId,
          providerDeploymentId: request.providerDeploymentId,
          outcome: "success",
          occurredAt: finalizedOn,
        }),
        createdOn: new Date(finalizedOn).toISOString(),
      },
    });
    if (!finalized.ok) throw new Error(finalized.reason);
    return {
      success: true as const,
      selectedVersionId: request.providerVersionId,
      binding: temporaryBinding(input.authorization),
      serializedBodyBytes: cleanup.serializedBodyBytes,
    };
  }

  async storeClaim(
    input: {
      targetId: string;
      temporaryAuthorizationRef: string;
      claimRef: string;
      expiresAt: number;
    },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    await requireCredentialContinuity(this.env);
    if (!IDENTIFIER.test(input.targetId)) {
      throw new TypeError("temporary_claim_binding_invalid");
    }
    const row = await this.env.CONTROL_DB.prepare(
      `SELECT * FROM temporary_deployments
       WHERE target_id = ? AND authorization_ref = ? AND claim_ref = ?
         AND claim_expires_at = ? AND status = 'active'`,
    )
      .bind(
        input.targetId,
        input.temporaryAuthorizationRef,
        input.claimRef,
        input.expiresAt,
      )
      .first<TemporaryDeploymentRow>();
    if (!row || row.claim_expires_at <= Date.now()) {
      throw new Error("temporary_claim_binding_invalid");
    }
    return { ref: row.id };
  }

  async consumeForBackendRedirect(
    input: { ref: string; now: number },
    markDelivered: Parameters<
      CloudflareTemporaryAccountRpcBinding["consumeForBackendRedirect"]
    >[1],
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    await requireCredentialContinuity(this.env, input.now);
    if (
      !IDENTIFIER.test(input.ref) ||
      !Number.isSafeInteger(input.now) ||
      typeof markDelivered !== "function"
    ) {
      return { ok: false as const, reason: "temporary_claim_binding_invalid" };
    }
    const row = await this.env.CONTROL_DB.prepare(
      `SELECT deployment.*,
        redirect.handle_digest,
        redirect.delivery_event_id AS redirect_delivery_event_id,
        redirect.handle_ref,
        redirect.expires_at AS redirect_expires_at
       FROM temporary_deployments AS deployment
       LEFT JOIN backend_redirects AS redirect
         ON redirect.temporary_deployment_id = deployment.id
          AND redirect.delivery_event_id = deployment.delivery_event_id
       WHERE deployment.id = ?
         AND deployment.status IN ('active', 'claim_delivered')
         AND deployment.claim_ref IS NOT NULL
       LIMIT 1`,
    )
      .bind(input.ref)
      .first<TemporaryClaimPreparationRow>();
    if (!row) return { ok: false as const, reason: "claim_not_found" };
    if (row.claim_expires_at <= input.now) {
      return { ok: false as const, reason: "claim_expired" };
    }
    if (!row.operation_id || !row.shiplet_id) {
      return { ok: false as const, reason: "temporary_claim_binding_invalid" };
    }
    const vaults = temporaryVaults(this.env);
    let deliveryEventId = row.delivery_event_id;
    let handleDigest = row.handle_digest;
    let handleRef = row.handle_ref;
    let stagedHandleRef: string | null = null;
    if (
      deliveryEventId === null &&
      handleDigest === null &&
      handleRef === null &&
      row.redirect_delivery_event_id === null &&
      row.redirect_expires_at === null &&
      row.status === "active"
    ) {
      const opaqueHandle = `claim_delivery_${crypto.randomUUID()}`;
      handleDigest = await sha256(opaqueHandle);
      handleRef = (
        await vaults.redirect.stage({
          opaqueHandle,
          expiresAt: row.claim_expires_at,
        })
      ).ref;
      stagedHandleRef = handleRef;
      deliveryEventId = `claim_delivery_${await stableTemporaryUuid(
        "claim-delivery",
        row.operation_id,
      )}`;
    }
    if (
      !deliveryEventId ||
      !handleDigest ||
      !handleRef ||
      (row.delivery_event_id !== null &&
        (row.redirect_delivery_event_id !== row.delivery_event_id ||
          row.redirect_expires_at !== row.claim_expires_at))
    ) {
      return { ok: false as const, reason: "temporary_claim_binding_invalid" };
    }
    const prepared = await prepareD1TemporaryClaimDelivery({
      db: this.env.CONTROL_DB,
      delivery: {
        deploymentId: row.id,
        operationId: row.operation_id,
        deliveryEventId,
        userId: row.user_id,
        shipletId: row.shiplet_id,
        targetId: row.target_id,
        revisionId: row.revision_id,
        handleDigest,
        handleRef,
        expiresAt: row.claim_expires_at,
        now: input.now,
      },
    });
    if (!prepared.ok && stagedHandleRef) {
      await this.env.CONTROL_DB.prepare(
        `DELETE FROM encrypted_records
         WHERE id = ? AND purpose = 'temporary_redirect_handle'`,
      )
        .bind(stagedHandleRef)
        .run();
    }
    return deliverD1PreparedTemporaryClaim({
      prepared,
      markDelivered,
      openRedirectHandle: (ref) =>
        vaults.redirect.withMaterial(ref, async (material) => {
          const value = (material as Record<string, unknown>).opaqueHandle;
          if (typeof value !== "string") {
            throw new Error("temporary_claim_unavailable");
          }
          return value;
        }),
      digest: sha256,
    });
  }

  async redeemBackendRedirect(
    input: { opaqueHandle: string },
    expectation: SupportReleaseExpectation,
  ) {
    assertSupportReleaseExpectation(this.env.CF_VERSION_METADATA, expectation);
    await requireCredentialContinuity(this.env);
    if (!IDENTIFIER.test(input.opaqueHandle)) return null;
    const now = Date.now();
    const vaults = temporaryVaults(this.env);
    const location = await redeemD1TemporaryClaimRedirect({
      db: this.env.CONTROL_DB,
      opaqueHandle: input.opaqueHandle,
      now,
      digest: sha256,
      openClaim: (claimRef) =>
        vaults.claim.withMaterial(claimRef, async (material) => {
          const value = (material as Record<string, unknown>).claimUrl;
          if (typeof value !== "string") {
            throw new Error("temporary_claim_unavailable");
          }
          const parsed = new URL(value);
          if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== "dash.cloudflare.com" ||
            parsed.pathname !== "/claim-preview" ||
            parsed.username ||
            parsed.password ||
            parsed.hash ||
            !parsed.searchParams.get("claimToken") ||
            [...parsed.searchParams.keys()].some((key) => key !== "claimToken")
          ) {
            throw new Error("temporary_claim_unavailable");
          }
          return value;
        }),
    });
    if (!location) return null;
    return new Response(null, {
      status: 303,
      headers: {
        location,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
}

export default CloudflareOAuthControlPlane;
