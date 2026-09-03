/**
 * Security primitives shared by the Cloudflare control-plane Worker.
 *
 * This module is deliberately free of Worker bindings. Credential material is
 * accepted only by the owning support Worker and never by the Shiplet kernel.
 */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACCOUNT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const REQUEST_DIGEST = /^sha256:[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TEMPORARY_WORK = 64_000_000;
const MAX_TEMPORARY_LIFETIME_MS = 60 * 60 * 1_000;

export type CloudflareSealedMaterial = Readonly<{
  version: "shiplet.aes-gcm/v1";
  nonce: string;
  ciphertext: string;
}>;

/**
 * Opens sensitive claim material before a first-response compare-and-swap.
 * A transient vault failure therefore leaves delivery retryable, while this
 * primitive returns material only to the compare-and-swap winner. The D1
 * redemption contract separately reopens the exact actor-bound redirect for
 * response-loss retries until expiry.
 */
export async function openTemporaryClaimBeforeConsume<T>(input: {
  open: () => Promise<T>;
  consume: () => Promise<boolean>;
}): Promise<T | null> {
  const material = await input.open();
  return (await input.consume()) ? material : null;
}

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
  const padded = `${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`;
  try {
    const decoded = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    return encodeBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validCipherBinding(recordId: string, purpose: string) {
  return (
    IDENTIFIER.test(recordId) &&
    /^[a-z][a-z0-9_]{0,63}$/.test(purpose)
  );
}

function cipherAad(recordId: string, purpose: string) {
  return new TextEncoder().encode(
    `shiplet.aes-gcm/v1\u0000${purpose}\u0000${recordId}`,
  );
}

/**
 * Imports a value supplied by the owning Worker's secret binding. The caller
 * must not log or persist the input outside Cloudflare's secret store.
 */
export function createCloudflareCredentialCipher(encodedKey: string) {
  const keyBytes = decodeBase64Url(encodedKey);
  if (keyBytes?.byteLength !== 32) {
    throw new TypeError("credential_cipher_key_invalid");
  }
  const key = crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  keyBytes.fill(0);

  return Object.freeze({
    async seal(input: {
      recordId: string;
      purpose: string;
      material: object;
    }): Promise<CloudflareSealedMaterial> {
      if (
        !validCipherBinding(input.recordId, input.purpose) ||
        !isRecord(input.material)
      ) {
        throw new TypeError("credential_material_invalid");
      }
      let plaintext: Uint8Array;
      try {
        plaintext = new TextEncoder().encode(JSON.stringify(input.material));
      } catch {
        throw new TypeError("credential_material_invalid");
      }
      if (plaintext.byteLength === 0 || plaintext.byteLength > 64 * 1024) {
        throw new TypeError("credential_material_invalid");
      }
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      try {
        const encrypted = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: cipherAad(input.recordId, input.purpose),
            tagLength: 128,
          },
          await key,
          plaintext as Uint8Array<ArrayBuffer>,
        );
        return Object.freeze({
          version: "shiplet.aes-gcm/v1" as const,
          nonce: encodeBase64Url(nonce),
          ciphertext: encodeBase64Url(new Uint8Array(encrypted)),
        });
      } finally {
        plaintext.fill(0);
      }
    },

    async open(input: {
      recordId: string;
      purpose: string;
      sealed: CloudflareSealedMaterial;
    }): Promise<Record<string, unknown>> {
      try {
        if (
          !validCipherBinding(input.recordId, input.purpose) ||
          !isRecord(input.sealed) ||
          input.sealed.version !== "shiplet.aes-gcm/v1" ||
          Reflect.ownKeys(input.sealed).length !== 3
        ) {
          throw new Error("invalid");
        }
        const nonce = decodeBase64Url(input.sealed.nonce);
        const ciphertext = decodeBase64Url(input.sealed.ciphertext);
        if (
          nonce?.byteLength !== 12 ||
          !ciphertext ||
          ciphertext.byteLength < 17 ||
          ciphertext.byteLength > 64 * 1024 + 16
        ) {
          throw new Error("invalid");
        }
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              additionalData: cipherAad(input.recordId, input.purpose),
              tagLength: 128,
            },
            await key,
            ciphertext,
          ),
        );
        try {
          const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
          if (!isRecord(parsed)) throw new Error("invalid");
          return structuredClone(parsed);
        } finally {
          plaintext.fill(0);
        }
      } catch {
        throw new Error("credential_ciphertext_invalid");
      }
    },
  });
}

type CloudflareGrant = Readonly<{
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
  requiredScopes: readonly string[];
  expiresAt: number;
}>;

type CloudflareGrantConnection = Readonly<{
  id: string;
  userId: string;
  accountId: string;
  status: "active" | "revoked";
  scopes: readonly string[];
  expiresAt: number;
  generation: number;
}>;

const OPERATION_SCOPES = Object.freeze({
  "worker.inspect": ["workers.scripts.read"],
  "worker.script.initialize": ["workers.scripts.write"],
  "worker.version.upload": ["workers.scripts.write"],
  "worker.candidate.prove": ["workers.scripts.read"],
  "worker.deployment.promote": ["workers.scripts.write"],
  "worker.deployment.rollback": ["workers.scripts.write"],
  "worker.deployment.compensate": ["workers.scripts.write"],
  "worker.version.cleanup": ["workers.scripts.write"],
} as const);

export function validateCloudflareGrantRequest(input: {
  grant: CloudflareGrant;
  connection: CloudflareGrantConnection;
  expected?: Readonly<
    Pick<
      CloudflareGrant,
      | "userId"
      | "shipletId"
      | "accountId"
      | "targetId"
      | "scriptName"
      | "revisionId"
      | "packageDigest"
      | "operation"
      | "requestDigest"
      | "requiredScopes"
    >
  >;
  now: number;
}):
  | { ok: true; connectionId: string; generation: number }
  | { ok: false; reason: string } {
  const { grant, connection, now } = input;
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "grant_clock_invalid" };
  }
  const expectedScopes = OPERATION_SCOPES[
    grant.operation as keyof typeof OPERATION_SCOPES
  ];
  const connectionScopes = new Set(connection.scopes);
  const requiredScopes = [...new Set(grant.requiredScopes)];
  const expected = input.expected ?? grant;
  if (
    !IDENTIFIER.test(connection.id) ||
    grant.handle !== `control-plane:${connection.id}` ||
    connection.status !== "active" ||
    !IDENTIFIER.test(grant.userId) ||
    !IDENTIFIER.test(grant.shipletId) ||
    !IDENTIFIER.test(grant.targetId) ||
    !IDENTIFIER.test(grant.revisionId) ||
    !ACCOUNT_IDENTIFIER.test(grant.accountId) ||
    !SCRIPT_IDENTIFIER.test(grant.scriptName) ||
    !PACKAGE_DIGEST.test(grant.packageDigest) ||
    !REQUEST_DIGEST.test(grant.requestDigest) ||
    grant.userId !== connection.userId ||
    grant.accountId !== connection.accountId ||
    grant.userId !== expected.userId ||
    grant.shipletId !== expected.shipletId ||
    grant.accountId !== expected.accountId ||
    grant.targetId !== expected.targetId ||
    grant.scriptName !== expected.scriptName ||
    grant.revisionId !== expected.revisionId ||
    grant.packageDigest !== expected.packageDigest ||
    grant.operation !== expected.operation ||
    grant.requestDigest !== expected.requestDigest ||
    grant.requiredScopes.length !== expected.requiredScopes.length ||
    !grant.requiredScopes.every(
      (scope, index) => scope === expected.requiredScopes[index],
    ) ||
    !expectedScopes ||
    requiredScopes.length !== grant.requiredScopes.length ||
    requiredScopes.length !== expectedScopes.length ||
    !requiredScopes.every((scope) => expectedScopes.includes(scope as never)) ||
    !requiredScopes.every((scope) => connectionScopes.has(scope)) ||
    !Number.isSafeInteger(grant.expiresAt) ||
    grant.expiresAt <= now ||
    !Number.isSafeInteger(connection.expiresAt) ||
    connection.expiresAt <= now ||
    grant.expiresAt > connection.expiresAt ||
    !Number.isSafeInteger(connection.generation) ||
    connection.generation <= 0
  ) {
    return { ok: false, reason: "grant_binding_mismatch" };
  }
  return {
    ok: true,
    connectionId: connection.id,
    generation: connection.generation,
  };
}

export async function authorizeCloudflareGrantConnection<
  Connection extends CloudflareGrantConnection,
>(input: {
  grant: CloudflareGrant;
  expected: CloudflareGrant;
  now: number;
  load(): Promise<Connection | null>;
  refresh(): Promise<boolean>;
}): Promise<Connection | null> {
  let connection = await input.load();
  if (
    !connection ||
    !validateCloudflareGrantRequest({
      grant: input.grant,
      connection,
      expected: input.expected,
      now: input.now,
    }).ok
  ) {
    return null;
  }
  if (connection.expiresAt > input.now + 60_000) return connection;
  if (!(await input.refresh())) return null;
  connection = await input.load();
  if (
    !connection ||
    !validateCloudflareGrantRequest({
      grant: input.grant,
      connection,
      expected: input.expected,
      now: input.now,
    }).ok
  ) {
    return null;
  }
  return connection;
}

export async function solveCloudflarePreviewChallenge(input: {
  challengeToken: string;
  seed: string;
  k: number;
  g: number;
  maximumWork?: number;
}) {
  const maximumWork = input.maximumWork ?? MAX_TEMPORARY_WORK;
  const seed = decodeBase64Url(input.seed);
  if (
    !IDENTIFIER.test(input.challengeToken) ||
    seed?.byteLength !== 32 ||
    !Number.isSafeInteger(input.k) ||
    input.k <= 0 ||
    !Number.isSafeInteger(input.g) ||
    input.g <= 0 ||
    !Number.isSafeInteger(maximumWork) ||
    maximumWork <= 0 ||
    maximumWork > MAX_TEMPORARY_WORK ||
    input.k > Math.floor(maximumWork / input.g)
  ) {
    throw new TypeError(
      input.k > 0 && input.g > 0 && input.k * input.g > maximumWork
        ? "temporary_challenge_limit_exceeded"
        : "temporary_challenge_invalid",
    );
  }
  const checkpoints = new Uint8Array((input.k + 1) * 32);
  let checkpoint = new Uint8Array(
    await crypto.subtle.digest("SHA-256", seed),
  );
  checkpoints.set(checkpoint, 0);
  for (let segment = 0; segment < input.k; segment += 1) {
    for (let iteration = 0; iteration < input.g; iteration += 1) {
      checkpoint = new Uint8Array(
        await crypto.subtle.digest("SHA-256", checkpoint),
      );
    }
    checkpoints.set(checkpoint, (segment + 1) * 32);
  }
  return Object.freeze({
    challengeToken: input.challengeToken,
    solution: Object.freeze({ checkpoints: encodeBase64(checkpoints) }),
  });
}

function timestamp(value: unknown, now: number) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > now ? parsed : null;
}

export function validateTemporaryProvisioningResponse(
  value: unknown,
  now: number,
) {
  if (!Number.isSafeInteger(now) || !isRecord(value) || value.success !== true) {
    throw new TypeError("temporary_provisioning_response_invalid");
  }
  const result = value.result;
  if (!isRecord(result) || !isRecord(result.account) || !isRecord(result.claim)) {
    throw new TypeError("temporary_provisioning_response_invalid");
  }
  const account = result.account;
  const claim = result.claim;
  const accountExpiresAt = timestamp(account.expiresAt, now);
  const claimExpiresAt = timestamp(claim.expiresAt, now);
  let claimUrl: URL;
  try {
    claimUrl = new URL(String(claim.url ?? ""));
  } catch {
    throw new TypeError("temporary_provisioning_response_invalid");
  }
  if (
    !ACCOUNT_IDENTIFIER.test(String(account.id ?? "")) ||
    typeof account.name !== "string" ||
    account.name.trim().length === 0 ||
    account.name.length > 256 ||
    typeof account.apiToken !== "string" ||
    account.apiToken.length < 16 ||
    account.apiToken.length > 4_096 ||
    typeof claim.token !== "string" ||
    claim.token.length < 16 ||
    claim.token.length > 4_096 ||
    accountExpiresAt === null ||
    claimExpiresAt === null ||
    accountExpiresAt > now + MAX_TEMPORARY_LIFETIME_MS ||
    claimExpiresAt > now + MAX_TEMPORARY_LIFETIME_MS ||
    claimExpiresAt > accountExpiresAt ||
    claimUrl.protocol !== "https:" ||
    claimUrl.hostname !== "dash.cloudflare.com" ||
    claimUrl.pathname !== "/claim-preview" ||
    claimUrl.username !== "" ||
    claimUrl.password !== "" ||
    claimUrl.hash !== "" ||
    claimUrl.searchParams.get("claimToken") !== claim.token ||
    [...claimUrl.searchParams.keys()].some((key) => key !== "claimToken")
  ) {
    throw new TypeError("temporary_provisioning_response_invalid");
  }
  return Object.freeze({
    public: Object.freeze({
      accountId: account.id as string,
      accountLabel: account.name.trim(),
      accountExpiresAt,
      claimExpiresAt,
    }),
    sensitive: Object.freeze({
      apiToken: account.apiToken,
      claimUrl: claimUrl.toString(),
    }),
  });
}
