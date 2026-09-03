import type {
  CloudflareConnectionRecord,
  CloudflareCredentialVault,
} from "../cloudflare-oauth";
import {
  createCloudflareCredentialCipher,
  type CloudflareSealedMaterial,
} from "./control-plane";

const VAULT_REF = /^vault_[0-9a-f-]{36}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type EncryptedRecordRow = {
  id: string;
  purpose: string;
  nonce: string;
  ciphertext: string;
  status: "active" | "retired" | "cleanup";
  expires_at: number | null;
};

type CredentialContinuityRow = {
  sentinel_id: string;
  purpose: "credential_continuity";
  nonce: string;
  ciphertext: string;
};

const CREDENTIAL_CONTINUITY_ID = "credential-root-v1";
const CREDENTIAL_CONTINUITY_PURPOSE = "credential_continuity";
const CREDENTIAL_CONTINUITY_MATERIAL = Object.freeze({
  schemaVersion: "shiplet.credential-continuity/v1",
  rootId: CREDENTIAL_CONTINUITY_ID,
});

async function credentialContinuityRow(db: D1Database) {
  return db
    .prepare(
      `SELECT sentinel_id, purpose, nonce, ciphertext
       FROM credential_continuity
       WHERE sentinel_id = ? LIMIT 1`,
    )
    .bind(CREDENTIAL_CONTINUITY_ID)
    .first<CredentialContinuityRow>();
}

export async function attestD1CredentialContinuity(input: {
  db: D1Database;
  encodedKey: string;
}) {
  try {
    const row = await credentialContinuityRow(input.db);
    if (
      !row ||
      row.sentinel_id !== CREDENTIAL_CONTINUITY_ID ||
      row.purpose !== CREDENTIAL_CONTINUITY_PURPOSE
    ) {
      return {
        ok: false as const,
        reason: "credential_continuity_unavailable" as const,
      };
    }
    const material = await createCloudflareCredentialCipher(
      input.encodedKey,
    ).open({
      recordId: row.sentinel_id,
      purpose: row.purpose,
      sealed: {
        version: "shiplet.aes-gcm/v1",
        nonce: row.nonce,
        ciphertext: row.ciphertext,
      },
    });
    if (
      !material ||
      typeof material !== "object" ||
      Array.isArray(material) ||
      (material as Record<string, unknown>).schemaVersion !==
        CREDENTIAL_CONTINUITY_MATERIAL.schemaVersion ||
      (material as Record<string, unknown>).rootId !==
        CREDENTIAL_CONTINUITY_ID ||
      Object.keys(material).length !== 2
    ) {
      return {
        ok: false as const,
        reason: "credential_continuity_unavailable" as const,
      };
    }
    return { ok: true as const };
  } catch {
    return {
      ok: false as const,
      reason: "credential_continuity_unavailable" as const,
    };
  }
}

export async function initializeD1CredentialContinuity(input: {
  db: D1Database;
  encodedKey: string;
  now: number;
}) {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("credential_continuity_clock_invalid");
  }
  const existing = await credentialContinuityRow(input.db);
  if (existing) {
    const attestation = await attestD1CredentialContinuity(input);
    return attestation.ok
      ? { ok: true as const, initialized: false }
      : attestation;
  }
  const sealed = await createCloudflareCredentialCipher(input.encodedKey).seal({
    recordId: CREDENTIAL_CONTINUITY_ID,
    purpose: CREDENTIAL_CONTINUITY_PURPOSE,
    material: CREDENTIAL_CONTINUITY_MATERIAL,
  });
  const inserted = await input.db
    .prepare(
      `INSERT INTO credential_continuity (
        sentinel_id, purpose, nonce, ciphertext, created_on
      )
      SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM credential_continuity)
        AND 0 = (
          (SELECT COUNT(*) FROM encrypted_records)
          + (SELECT COUNT(*) FROM oauth_flows)
          + (SELECT COUNT(*) FROM oauth_start_reservations)
          + (SELECT COUNT(*) FROM cloudflare_oauth_state_refs)
          + (SELECT COUNT(*) FROM cloudflare_connections)
          + (SELECT COUNT(*) FROM cloudflare_refresh_reservations)
          + (SELECT COUNT(*) FROM grant_consumptions)
          + (SELECT COUNT(*) FROM temporary_grant_consumptions)
          + (SELECT COUNT(*) FROM temporary_deployments)
          + (SELECT COUNT(*) FROM backend_redirects)
          + (SELECT COUNT(*) FROM temporary_provider_operations)
          + (SELECT COUNT(*) FROM oauth_provider_exchange_recoveries)
          + (SELECT COUNT(*) FROM cloudflare_control_audit_outbox)
          + (SELECT COUNT(*) FROM control_audit_outbox)
          + (SELECT COUNT(*) FROM credential_continuity)
          + (SELECT COUNT(*) FROM support_reconciliation_runs)
          + (SELECT COUNT(*) FROM managed_deployment_operations)
          + (SELECT COUNT(*) FROM managed_platform_connection_reservations)
          + (SELECT COUNT(*) FROM managed_platform_connection_retirements)
          + (SELECT COUNT(*) FROM managed_platform_operation_leases)
        )`,
    )
    .bind(
      CREDENTIAL_CONTINUITY_ID,
      CREDENTIAL_CONTINUITY_PURPOSE,
      sealed.nonce,
      sealed.ciphertext,
      new Date(input.now).toISOString(),
    )
    .run();
  if (inserted.meta.changes === 1) {
    const attestation = await attestD1CredentialContinuity(input);
    if (!attestation.ok) return attestation;
    return { ok: true as const, initialized: true };
  }
  const raced = await credentialContinuityRow(input.db);
  if (raced) {
    const attestation = await attestD1CredentialContinuity(input);
    return attestation.ok
      ? { ok: true as const, initialized: false }
      : attestation;
  }
  return {
    ok: false as const,
    reason: "credential_continuity_missing_with_state" as const,
  };
}

function sealedFromRow(row: EncryptedRecordRow): CloudflareSealedMaterial {
  return Object.freeze({
    version: "shiplet.aes-gcm/v1",
    nonce: row.nonce,
    ciphertext: row.ciphertext,
  });
}

function encodeHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function credentialRefForConnection(connectionId: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`shiplet:oauth-credential:${connectionId}`),
    ),
  );
  const hex = encodeHex(digest.slice(0, 16));
  return `vault_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type AtomicConnectionInput<CredentialMaterial extends object> = {
  material: CredentialMaterial;
  connection: {
    id: string;
    userId: string;
    accountId: string;
    accountLabel: string;
    scopes: string[];
    expiresAt: number;
    generation?: number;
  };
};

/**
 * Encrypts provider material and creates its sole owning connection in one D1
 * transaction. The deterministic, non-secret vault reference also lets a
 * response-loss retry attest an exact prior commit instead of creating an
 * orphaned credential or revoking a connection that was already committed.
 */
export function createD1CloudflareOAuthConnectionCommitter<
  CredentialMaterial extends object,
>(input: { db: D1Database; encodedKey: string; now(): number }) {
  const cipher = createCloudflareCredentialCipher(input.encodedKey);
  const purpose = "oauth_credential";

  return async (
    request: AtomicConnectionInput<CredentialMaterial>,
  ): Promise<CloudflareConnectionRecord> => {
    const now = input.now();
    const connection = request.connection;
    const scopes = [...new Set(connection.scopes.map((scope) => scope.trim()))]
      .filter(Boolean)
      .sort();
    const generation = connection.generation ?? 1;
    if (
      !IDENTIFIER.test(connection.id) ||
      !IDENTIFIER.test(connection.userId) ||
      !IDENTIFIER.test(connection.accountId) ||
      connection.accountLabel.trim().length === 0 ||
      connection.accountLabel.length > 512 ||
      scopes.length !== connection.scopes.length ||
      scopes.some((scope) => !IDENTIFIER.test(scope)) ||
      !Number.isSafeInteger(connection.expiresAt) ||
      connection.expiresAt <= now ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      throw new TypeError("cloudflare_connection_commit_invalid");
    }
    const credentialRef = await credentialRefForConnection(connection.id);
    const sealed = await cipher.seal({
      recordId: credentialRef,
      purpose,
      material: request.material,
    });
    const createdOn = new Date(now).toISOString();
    const record: CloudflareConnectionRecord = Object.freeze({
      id: connection.id,
      userId: connection.userId,
      accountId: connection.accountId,
      accountLabel: connection.accountLabel,
      scopes,
      credentialRef,
      expiresAt: connection.expiresAt,
      status: "active" as const,
      generation,
    });
    try {
      const credentialInsert = input.db
        .prepare(
          `INSERT INTO encrypted_records (
              id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
        )
        .bind(
          credentialRef,
          purpose,
          sealed.nonce,
          sealed.ciphertext,
          connection.expiresAt,
          createdOn,
        );
      const connectionInsert = input.db
        .prepare(
          `INSERT INTO cloudflare_connections (
              id, user_id, account_id, account_label, scopes_json,
              credential_ref, expires_at, status, revoked_at, generation,
              created_on, refreshed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`,
        )
        .bind(
          connection.id,
          connection.userId,
          connection.accountId,
          connection.accountLabel,
          JSON.stringify(scopes),
          credentialRef,
          connection.expiresAt,
          generation,
          createdOn,
        );
      await input.db.batch([credentialInsert, connectionInsert]);
      return record;
    } catch (error) {
      const recovered = await input.db
        .prepare(
          `SELECT connection.user_id, connection.account_id,
                  connection.account_label, connection.scopes_json,
                  connection.credential_ref, connection.expires_at,
                  connection.status, connection.generation,
                  credential.purpose, credential.status AS credential_status
           FROM cloudflare_connections AS connection
           JOIN encrypted_records AS credential
             ON credential.id = connection.credential_ref
           WHERE connection.id = ?`,
        )
        .bind(connection.id)
        .first<Record<string, unknown>>();
      if (
        recovered?.user_id === connection.userId &&
        recovered.account_id === connection.accountId &&
        recovered.account_label === connection.accountLabel &&
        recovered.scopes_json === JSON.stringify(scopes) &&
        recovered.credential_ref === credentialRef &&
        recovered.expires_at === connection.expiresAt &&
        recovered.status === "active" &&
        recovered.generation === generation &&
        recovered.purpose === purpose &&
        recovered.credential_status === "active"
      ) {
        return record;
      }
      throw error;
    }
  };
}

export function createD1EncryptedCredentialVault(input: {
  db: D1Database;
  encodedKey: string;
  now(): number;
  purpose?: string;
  expiresAt?: (material: object) => number | null;
}): CloudflareCredentialVault<object> {
  const cipher = createCloudflareCredentialCipher(input.encodedKey);
  const purpose = input.purpose ?? "opaque_material";

  const seal = async (material: object) => {
    const id = `vault_${crypto.randomUUID()}`;
    const sealed = await cipher.seal({ recordId: id, purpose, material });
    const expiresAt = input.expiresAt?.(material) ?? null;
    if (
      expiresAt !== null &&
      (!Number.isSafeInteger(expiresAt) || expiresAt <= input.now())
    ) {
      throw new TypeError("credential_expiry_invalid");
    }
    await input.db
      .prepare(
        `INSERT INTO encrypted_records (
          id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)`,
      )
      .bind(
        id,
        purpose,
        sealed.nonce,
        sealed.ciphertext,
        expiresAt,
        new Date(input.now()).toISOString(),
      )
      .run();
    return id;
  };

  const get = async (ref: string) => {
    if (!VAULT_REF.test(ref)) throw new Error("credential_ref_unavailable");
    const row = await input.db
      .prepare(
        `SELECT id, purpose, nonce, ciphertext, status, expires_at
         FROM encrypted_records
         WHERE id = ? AND purpose = ? AND status IN ('active', 'cleanup')`,
      )
      .bind(ref, purpose)
      .first<EncryptedRecordRow>();
    if (!row || (row.expires_at !== null && row.expires_at <= input.now())) {
      throw new Error("credential_ref_unavailable");
    }
    return row;
  };

  const retire = async (ref: string) => {
    if (!VAULT_REF.test(ref)) throw new Error("credential_ref_unavailable");
    const result = await input.db
      .prepare(
        `UPDATE encrypted_records
         SET status = 'retired', retired_on = ?
         WHERE id = ? AND purpose = ? AND status IN ('active', 'cleanup')`,
      )
      .bind(new Date(input.now()).toISOString(), ref, purpose)
      .run();
    if (result.meta.changes !== 1) {
      throw new Error("credential_ref_unavailable");
    }
  };

  return Object.freeze({
    seal,
    async stage(material: object) {
      return { ref: await seal(material) };
    },
    retire,
    async withMaterial<Result>(
      ref: string,
      operation: (material: object) => Promise<Result>,
    ) {
      const row = await get(ref);
      const material = await cipher.open({
        recordId: row.id,
        purpose: row.purpose,
        sealed: sealedFromRow(row),
      });
      return operation(material);
    },
    revoke: retire,
    async retainForCleanup(ref: string) {
      if (!VAULT_REF.test(ref)) throw new Error("credential_ref_unavailable");
      const result = await input.db
        .prepare(
          `UPDATE encrypted_records SET status = 'cleanup'
           WHERE id = ? AND purpose = ? AND status = 'active'`,
        )
        .bind(ref, purpose)
        .run();
      if (result.meta.changes !== 1) {
        throw new Error("credential_ref_unavailable");
      }
    },
  });
}
