import { CLOUDFLARE_API_ORIGIN } from "../cloudflare-production-adapters";

export type ManagedDeploymentNamespace =
  | "shiplet-managed-staging"
  | "shiplet-managed-production";

export type ManagedDeploymentIdentity = Readonly<{
  operationId: string;
  namespace: ManagedDeploymentNamespace;
  scriptName: string;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
}>;

export type ManagedDeploymentInspectInput = ManagedDeploymentIdentity &
  Readonly<{ schemaVersion: "shiplet.managed-deployment-inspect/v1" }>;

export type ManagedDeploymentDeleteInput = ManagedDeploymentIdentity &
  Readonly<{ schemaVersion: "shiplet.managed-deployment-delete/v1" }>;

export type ManagedDeploymentUploadInput = ManagedDeploymentIdentity &
  Readonly<{
    schemaVersion: "shiplet.managed-deployment/v1";
    mainModule: string;
    compatibilityDate: "2026-08-07";
    modules: readonly Readonly<{
      name: string;
      mediaType: string;
      bytes: Uint8Array;
    }>[];
    bindings: readonly [];
  }>;

export type ManagedDeploymentProof = ManagedDeploymentIdentity &
  Readonly<{
    schemaVersion: "shiplet.managed-deployment-proof/v1";
    status: "present" | "absent";
  }>;

type ProviderScriptIdentity = Readonly<{
  namespace: ManagedDeploymentNamespace;
  scriptName: string;
}>;

export interface ManagedDeploymentProvider {
  readNamespace(namespace: ManagedDeploymentNamespace): Promise<{
    name: ManagedDeploymentNamespace;
    trustedWorkers: boolean;
  }>;
  inspectScript(input: ProviderScriptIdentity): Promise<
    | { status: "absent" }
    | {
        status: "present";
        operationTag: string;
        bindings: readonly unknown[];
      }
  >;
  uploadScript(
    input: ProviderScriptIdentity & {
      operationTag: string;
      mainModule: string;
      compatibilityDate: "2026-08-07";
      modules: ManagedDeploymentUploadInput["modules"];
      bindings: readonly [];
    },
  ): Promise<void>;
  deleteScript(input: ProviderScriptIdentity): Promise<void>;
}

type BrokerDatabase = Pick<D1Database, "prepare" | "batch">;

export type ManagedPlatformReservationInput = Readonly<{
  schemaVersion: "shiplet.managed-platform-reservation/v1";
  operationId: string;
  purpose: "managed_wfp_provider";
  actor: Readonly<{ kind: "human"; id: string }>;
  connectionId: string;
  accountId: string;
}>;

export type ManagedPlatformReservationProof = Readonly<{
  schemaVersion: "shiplet.managed-platform-reservation-proof/v1";
  operationId: string;
  purpose: "managed_wfp_provider";
  connectionId: string;
  accountId: string;
  ownerUserId: string;
  status: "active";
  reservedAt: number;
}>;

export type ManagedPlatformInspectionInput = Readonly<{
  schemaVersion: "shiplet.managed-platform-inspection/v1";
  purpose: "managed_wfp_provider";
  actor: Readonly<{ kind: "human"; id: string }>;
  connectionId: string;
  accountId: string;
}>;

export type ManagedPlatformRetirementInput = Readonly<{
  schemaVersion: "shiplet.managed-platform-retirement/v1";
  operationId: string;
  purpose: "managed_wfp_provider";
  actor: Readonly<{ kind: "human"; id: string }>;
  reservationOperationId: string;
  connectionId: string;
  accountId: string;
}>;

export type ManagedPlatformRetirementProof = Readonly<{
  schemaVersion: "shiplet.managed-platform-retirement-proof/v1";
  operationId: string;
  purpose: "managed_wfp_provider";
  reservationOperationId: string;
  connectionId: string;
  accountId: string;
  ownerUserId: string;
  status: "retired";
  retiredAt: number;
}>;

type ManagedPlatformReservationRow = {
  operation_id: string;
  purpose: "managed_wfp_provider";
  connection_id: string;
  account_id: string;
  user_id: string;
  status: "active";
  reserved_at: number;
  created_on: string;
};

type ManagedPlatformOperationLeaseRow = {
  operation_id: string;
  reservation_operation_id: string;
  connection_id: string;
  account_id: string;
  user_id: string;
  status: "active" | "released";
  acquired_at: number;
  released_at: number | null;
  created_on: string;
};

type ManagedPlatformRetirementRow = {
  operation_id: string;
  purpose: "managed_wfp_provider";
  reservation_operation_id: string;
  connection_id: string;
  account_id: string;
  user_id: string;
  retired_at: number;
  created_on: string;
};

type OperationRow = {
  operation_id: string;
  operation_kind: "upload" | "delete";
  account_id: string;
  namespace_name: ManagedDeploymentNamespace;
  script_name: string;
  shiplet_id: string;
  revision_id: string;
  package_digest: string;
  request_digest: string;
  operation_tag: string | null;
  status: "reserved" | "applying" | "succeeded";
  created_on: string;
  applying_on: string | null;
  succeeded_on: string | null;
};

const STAGING = "shiplet-managed-staging" as const;
const PRODUCTION = "shiplet-managed-production" as const;
const NAMESPACES = Object.freeze([STAGING, PRODUCTION] as const);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SCRIPT_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const OPERATION_ID = /^managed_[A-Za-z0-9_-]{43}$/;
const PLATFORM_RESERVATION_OPERATION_ID =
  /^managed_platform_[A-Za-z0-9_-]{43}$/;
const PLATFORM_RETIREMENT_OPERATION_ID =
  /^managed_platform_retire_[A-Za-z0-9_-]{43}$/;
const PACKAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const MODULE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,255}$/;
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const OPERATION_TAG = /^shiplet-op-[A-Za-z0-9_-]{43}$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MAX_MODULES = 1_000;
const MAX_MODULE_BYTES = 5 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const REQUIRED_PLATFORM_SCOPES = Object.freeze([
  "offline_access",
  "workers.scripts.read",
  "workers.scripts.write",
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string) {
  return Object.keys(value).sort().join(",") === expected;
}

export function parseManagedPlatformReservationInput(
  candidate: unknown,
): ManagedPlatformReservationInput {
  if (
    !isRecord(candidate) ||
    !exactKeys(
      candidate,
      "accountId,actor,connectionId,operationId,purpose,schemaVersion",
    ) ||
    candidate.schemaVersion !== "shiplet.managed-platform-reservation/v1" ||
    candidate.purpose !== "managed_wfp_provider" ||
    !PLATFORM_RESERVATION_OPERATION_ID.test(
      String(candidate.operationId ?? ""),
    ) ||
    !IDENTIFIER.test(String(candidate.connectionId ?? "")) ||
    !ACCOUNT_ID.test(String(candidate.accountId ?? "")) ||
    !isRecord(candidate.actor) ||
    !exactKeys(candidate.actor, "id,kind") ||
    candidate.actor.kind !== "human" ||
    !IDENTIFIER.test(String(candidate.actor.id ?? ""))
  ) {
    throw new TypeError("managed_platform_reservation_invalid");
  }
  return candidate as unknown as ManagedPlatformReservationInput;
}

export function parseManagedPlatformInspectionInput(
  candidate: unknown,
): ManagedPlatformInspectionInput {
  if (
    !isRecord(candidate) ||
    !exactKeys(
      candidate,
      "accountId,actor,connectionId,purpose,schemaVersion",
    ) ||
    candidate.schemaVersion !== "shiplet.managed-platform-inspection/v1" ||
    candidate.purpose !== "managed_wfp_provider" ||
    !IDENTIFIER.test(String(candidate.connectionId ?? "")) ||
    !ACCOUNT_ID.test(String(candidate.accountId ?? "")) ||
    !isRecord(candidate.actor) ||
    !exactKeys(candidate.actor, "id,kind") ||
    candidate.actor.kind !== "human" ||
    !IDENTIFIER.test(String(candidate.actor.id ?? ""))
  ) {
    throw new TypeError("managed_platform_inspection_invalid");
  }
  return candidate as unknown as ManagedPlatformInspectionInput;
}

export function parseManagedPlatformRetirementInput(
  candidate: unknown,
): ManagedPlatformRetirementInput {
  if (
    !isRecord(candidate) ||
    !exactKeys(
      candidate,
      "accountId,actor,connectionId,operationId,purpose,reservationOperationId,schemaVersion",
    ) ||
    candidate.schemaVersion !== "shiplet.managed-platform-retirement/v1" ||
    candidate.purpose !== "managed_wfp_provider" ||
    !PLATFORM_RETIREMENT_OPERATION_ID.test(
      String(candidate.operationId ?? ""),
    ) ||
    !PLATFORM_RESERVATION_OPERATION_ID.test(
      String(candidate.reservationOperationId ?? ""),
    ) ||
    !IDENTIFIER.test(String(candidate.connectionId ?? "")) ||
    !ACCOUNT_ID.test(String(candidate.accountId ?? "")) ||
    !isRecord(candidate.actor) ||
    !exactKeys(candidate.actor, "id,kind") ||
    candidate.actor.kind !== "human" ||
    !IDENTIFIER.test(String(candidate.actor.id ?? ""))
  ) {
    throw new TypeError("managed_platform_retirement_invalid");
  }
  return candidate as unknown as ManagedPlatformRetirementInput;
}

function managedPlatformReservationProof(
  row: ManagedPlatformReservationRow,
): ManagedPlatformReservationProof {
  return Object.freeze({
    schemaVersion: "shiplet.managed-platform-reservation-proof/v1" as const,
    operationId: row.operation_id,
    purpose: row.purpose,
    connectionId: row.connection_id,
    accountId: row.account_id,
    ownerUserId: row.user_id,
    status: row.status,
    reservedAt: row.reserved_at,
  });
}

function exactReservation(
  row: ManagedPlatformReservationRow,
  input: ManagedPlatformReservationInput,
) {
  return (
    row.operation_id === input.operationId &&
    row.purpose === input.purpose &&
    row.connection_id === input.connectionId &&
    row.account_id === input.accountId &&
    row.user_id === input.actor.id &&
    row.status === "active"
  );
}

async function loadManagedPlatformReservation(
  db: BrokerDatabase,
  selection: { operationId?: string; connectionId?: string },
) {
  const column = selection.operationId ? "operation_id" : "connection_id";
  const value = selection.operationId ?? selection.connectionId ?? "";
  return db
    .prepare(
      `SELECT operation_id, purpose, connection_id, account_id, user_id,
              status, reserved_at, created_on
       FROM managed_platform_connection_reservations reservation
       WHERE reservation.${column} = ? AND reservation.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM managed_platform_connection_retirements retirement
           WHERE retirement.reservation_operation_id = reservation.operation_id
         )`,
    )
    .bind(value)
    .first<ManagedPlatformReservationRow>();
}

async function loadManagedPlatformRetirement(
  db: BrokerDatabase,
  operationId: string,
) {
  return db
    .prepare(
      `SELECT operation_id, purpose, reservation_operation_id, connection_id,
              account_id, user_id, retired_at, created_on
       FROM managed_platform_connection_retirements
       WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<ManagedPlatformRetirementRow>();
}

export async function reserveManagedPlatformConnection(input: {
  db: BrokerDatabase;
  now: number;
  input: unknown;
}) {
  const reservation = parseManagedPlatformReservationInput(input.input);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("managed_platform_reservation_invalid");
  }
  const createdOn = new Date(input.now).toISOString();
  const auditEvent = JSON.stringify({
    eventKind: "cloudflare.managed_platform_connection.reserved",
    actorKind: "human",
    actorId: reservation.actor.id,
    connectionId: reservation.connectionId,
    accountId: reservation.accountId,
    targetId: reservation.operationId,
    outcome: "success",
    reason: reservation.purpose,
    occurredAt: input.now,
  });
  const auditKey = (
    await sha256(
      canonicalJson({
        operationId: reservation.operationId,
        purpose: reservation.purpose,
        connectionId: reservation.connectionId,
        accountId: reservation.accountId,
        userId: reservation.actor.id,
      }),
    )
  ).slice(0, 40);
  await input.db.batch([
    input.db
      .prepare(
        `INSERT OR IGNORE INTO managed_platform_connection_reservations (
          operation_id, purpose, connection_id, account_id, user_id, status,
          reserved_at, created_on
        ) SELECT ?, ?, ?, ?, ?, 'active', ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM managed_platform_connection_reservations reservation
            WHERE reservation.purpose = 'managed_wfp_provider'
              AND reservation.status = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM managed_platform_connection_retirements retirement
                WHERE retirement.reservation_operation_id = reservation.operation_id
              )
          )`,
      )
      .bind(
        reservation.operationId,
        reservation.purpose,
        reservation.connectionId,
        reservation.accountId,
        reservation.actor.id,
        input.now,
        createdOn,
      ),
    input.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        )
        SELECT ?, ?, 'pending', ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM managed_platform_connection_reservations
          WHERE operation_id = ? AND purpose = ? AND connection_id = ?
            AND account_id = ? AND user_id = ? AND status = 'active'
        )`,
      )
      .bind(
        `control_audit_platform_reservation_${auditKey}`,
        auditEvent,
        createdOn,
        reservation.operationId,
        reservation.purpose,
        reservation.connectionId,
        reservation.accountId,
        reservation.actor.id,
      ),
  ]);
  const row = await loadManagedPlatformReservation(input.db, {
    operationId: reservation.operationId,
  });
  if (!row || !exactReservation(row, reservation)) {
    throw new Error("managed_platform_reservation_conflict");
  }
  return managedPlatformReservationProof(row);
}

function managedPlatformRetirementProof(
  row: ManagedPlatformRetirementRow,
): ManagedPlatformRetirementProof {
  return Object.freeze({
    schemaVersion: "shiplet.managed-platform-retirement-proof/v1" as const,
    operationId: row.operation_id,
    purpose: row.purpose,
    reservationOperationId: row.reservation_operation_id,
    connectionId: row.connection_id,
    accountId: row.account_id,
    ownerUserId: row.user_id,
    status: "retired" as const,
    retiredAt: row.retired_at,
  });
}

function exactRetirement(
  row: ManagedPlatformRetirementRow,
  input: ManagedPlatformRetirementInput,
) {
  return (
    row.operation_id === input.operationId &&
    row.purpose === input.purpose &&
    row.reservation_operation_id === input.reservationOperationId &&
    row.connection_id === input.connectionId &&
    row.account_id === input.accountId &&
    row.user_id === input.actor.id
  );
}

export async function retireManagedPlatformConnection(input: {
  db: BrokerDatabase;
  now: number;
  input: unknown;
}) {
  const retirement = parseManagedPlatformRetirementInput(input.input);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new TypeError("managed_platform_retirement_invalid");
  }
  const existing = await loadManagedPlatformRetirement(
    input.db,
    retirement.operationId,
  );
  if (existing) {
    if (!exactRetirement(existing, retirement)) {
      throw new Error("managed_platform_retirement_conflict");
    }
    return managedPlatformRetirementProof(existing);
  }
  const createdOn = new Date(input.now).toISOString();
  const auditEvent = JSON.stringify({
    eventKind: "cloudflare.managed_platform_connection.retired",
    actorKind: "human",
    actorId: retirement.actor.id,
    connectionId: retirement.connectionId,
    accountId: retirement.accountId,
    targetId: retirement.reservationOperationId,
    operationId: retirement.operationId,
    outcome: "success",
    reason: retirement.purpose,
    occurredAt: input.now,
  });
  const auditKey = (
    await sha256(
      canonicalJson({
        operationId: retirement.operationId,
        reservationOperationId: retirement.reservationOperationId,
        connectionId: retirement.connectionId,
        accountId: retirement.accountId,
        userId: retirement.actor.id,
      }),
    )
  ).slice(0, 40);
  await input.db.batch([
    input.db
      .prepare(
        `INSERT OR IGNORE INTO managed_platform_connection_retirements (
           operation_id, purpose, reservation_operation_id, connection_id,
           account_id, user_id, retired_at, created_on
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM managed_platform_connection_reservations reservation
           WHERE reservation.operation_id = ? AND reservation.purpose = ?
             AND reservation.connection_id = ? AND reservation.account_id = ?
             AND reservation.user_id = ? AND reservation.status = 'active'
             AND NOT EXISTS (
               SELECT 1 FROM managed_platform_connection_retirements prior
               WHERE prior.reservation_operation_id = reservation.operation_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM managed_platform_operation_leases lease
               WHERE lease.reservation_operation_id = reservation.operation_id
                 AND lease.connection_id = reservation.connection_id
                 AND lease.account_id = reservation.account_id
                 AND lease.user_id = reservation.user_id
                 AND lease.status = 'active'
             )
         )`,
      )
      .bind(
        retirement.operationId,
        retirement.purpose,
        retirement.reservationOperationId,
        retirement.connectionId,
        retirement.accountId,
        retirement.actor.id,
        input.now,
        createdOn,
        retirement.reservationOperationId,
        retirement.purpose,
        retirement.connectionId,
        retirement.accountId,
        retirement.actor.id,
      ),
    input.db
      .prepare(
        `UPDATE managed_platform_connection_reservations
         SET status = 'retired'
         WHERE operation_id = ? AND purpose = ? AND connection_id = ?
           AND account_id = ? AND user_id = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM managed_platform_connection_retirements retirement
             WHERE retirement.operation_id = ?
               AND retirement.reservation_operation_id = ?
               AND retirement.connection_id = ?
               AND retirement.account_id = ? AND retirement.user_id = ?
           )`,
      )
      .bind(
        retirement.reservationOperationId,
        retirement.purpose,
        retirement.connectionId,
        retirement.accountId,
        retirement.actor.id,
        retirement.operationId,
        retirement.reservationOperationId,
        retirement.connectionId,
        retirement.accountId,
        retirement.actor.id,
      ),
    input.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_outbox (
           id, event_json, delivery_status, created_on, delivered_on
         ) SELECT ?, ?, 'pending', ?, NULL
         WHERE EXISTS (
           SELECT 1 FROM managed_platform_connection_retirements
           WHERE operation_id = ? AND reservation_operation_id = ?
             AND connection_id = ? AND account_id = ? AND user_id = ?
         ) AND EXISTS (
           SELECT 1 FROM managed_platform_connection_reservations
           WHERE operation_id = ? AND status = 'retired'
         )`,
      )
      .bind(
        `control_audit_platform_retirement_${auditKey}`,
        auditEvent,
        createdOn,
        retirement.operationId,
        retirement.reservationOperationId,
        retirement.connectionId,
        retirement.accountId,
        retirement.actor.id,
        retirement.reservationOperationId,
      ),
  ]);
  const row = await loadManagedPlatformRetirement(
    input.db,
    retirement.operationId,
  );
  if (!row || !exactRetirement(row, retirement)) {
    const lease = await input.db
      .prepare(
        `SELECT operation_id, reservation_operation_id, connection_id,
                account_id, user_id, status, acquired_at, released_at, created_on
         FROM managed_platform_operation_leases
         WHERE reservation_operation_id = ? AND connection_id = ?
           AND account_id = ? AND user_id = ? AND status = 'active'
         LIMIT 1`,
      )
      .bind(
        retirement.reservationOperationId,
        retirement.connectionId,
        retirement.accountId,
        retirement.actor.id,
      )
      .first<ManagedPlatformOperationLeaseRow>();
    if (lease) throw new Error("managed_platform_retirement_in_flight");
    throw new Error("managed_platform_retirement_denied");
  }
  return managedPlatformRetirementProof(row);
}

export async function requireActiveManagedPlatformReservation(input: {
  db: BrokerDatabase;
  connectionId: string;
  accountId: string;
  ownerUserId?: string;
}) {
  if (
    !IDENTIFIER.test(input.connectionId) ||
    !ACCOUNT_ID.test(input.accountId) ||
    (input.ownerUserId !== undefined && !IDENTIFIER.test(input.ownerUserId))
  ) {
    throw new Error("managed_platform_reservation_required");
  }
  const row = await loadManagedPlatformReservation(input.db, {
    connectionId: input.connectionId,
  });
  if (
    !row ||
    row.purpose !== "managed_wfp_provider" ||
    row.connection_id !== input.connectionId ||
    row.account_id !== input.accountId ||
    (input.ownerUserId !== undefined && row.user_id !== input.ownerUserId) ||
    row.status !== "active"
  ) {
    throw new Error("managed_platform_reservation_required");
  }
  return managedPlatformReservationProof(row);
}

export async function inspectManagedPlatformConnection(input: {
  db: BrokerDatabase;
  input: unknown;
}) {
  const inspection = parseManagedPlatformInspectionInput(input.input);
  return requireActiveManagedPlatformReservation({
    db: input.db,
    connectionId: inspection.connectionId,
    accountId: inspection.accountId,
    ownerUserId: inspection.actor.id,
  });
}

export async function assertManagedPlatformCustomerOperationAllowed(input: {
  db: BrokerDatabase;
  connectionId: string;
  ownerUserId: string;
  operation: "customer_grant" | "customer_revoke";
}) {
  if (
    !IDENTIFIER.test(input.connectionId) ||
    !IDENTIFIER.test(input.ownerUserId)
  ) {
    throw new Error(
      input.operation === "customer_grant"
        ? "cloudflare_grant_denied"
        : "oauth_revoke_binding_invalid",
    );
  }
  const reserved = await loadManagedPlatformReservation(input.db, {
    connectionId: input.connectionId,
  });
  if (reserved) {
    if (reserved.user_id !== input.ownerUserId) {
      throw new Error(
        input.operation === "customer_grant"
          ? "cloudflare_grant_denied"
          : "oauth_revoke_binding_invalid",
      );
    }
    throw new Error(
      input.operation === "customer_grant"
        ? "cloudflare_grant_reserved_for_managed_platform"
        : "oauth_connection_reserved_for_managed_platform",
    );
  }
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

export function authorizeManagedPlatformConnection(input: {
  configuredConnectionId: string;
  configuredAccountId: string;
  connection: unknown;
  now: number;
}) {
  const connection = input.connection;
  const scopes =
    isRecord(connection) && Array.isArray(connection.scopes)
      ? [...connection.scopes].sort()
      : [];
  if (
    !IDENTIFIER.test(input.configuredConnectionId) ||
    !ACCOUNT_ID.test(input.configuredAccountId) ||
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    !isRecord(connection) ||
    connection.id !== input.configuredConnectionId ||
    connection.accountId !== input.configuredAccountId ||
    !IDENTIFIER.test(String(connection.userId ?? "")) ||
    !IDENTIFIER.test(String(connection.credentialRef ?? "")) ||
    connection.status !== "active" ||
    !Number.isSafeInteger(connection.generation) ||
    (connection.generation as number) < 1 ||
    !Number.isSafeInteger(connection.expiresAt) ||
    (connection.expiresAt as number) <= input.now ||
    scopes.length !== REQUIRED_PLATFORM_SCOPES.length ||
    scopes.some(
      (scope, index) => scope !== [...REQUIRED_PLATFORM_SCOPES].sort()[index],
    )
  ) {
    throw new Error("managed_platform_connection_denied");
  }
  return Object.freeze({
    connectionId: connection.id as string,
    ownerUserId: connection.userId as string,
    accountId: connection.accountId as string,
    credentialRef: connection.credentialRef as string,
    generation: connection.generation as number,
  });
}

async function sha256(value: string | Uint8Array) {
  const input =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : (value.slice() as Uint8Array<ArrayBuffer>);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trustedNow(now: () => number) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("managed_deployment_clock_invalid");
  }
  return value;
}

function validIdentity(value: Record<string, unknown>) {
  return (
    OPERATION_ID.test(String(value.operationId ?? "")) &&
    NAMESPACES.includes(value.namespace as ManagedDeploymentNamespace) &&
    SCRIPT_IDENTIFIER.test(String(value.scriptName ?? "")) &&
    IDENTIFIER.test(String(value.shipletId ?? "")) &&
    IDENTIFIER.test(String(value.revisionId ?? "")) &&
    PACKAGE_DIGEST.test(String(value.packageDigest ?? ""))
  );
}

function validateInspect(value: unknown): ManagedDeploymentInspectInput {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      "namespace,operationId,packageDigest,revisionId,schemaVersion,scriptName,shipletId",
    ) ||
    value.schemaVersion !== "shiplet.managed-deployment-inspect/v1" ||
    !validIdentity(value)
  ) {
    throw new TypeError("managed_deployment_request_invalid");
  }
  return value as ManagedDeploymentInspectInput;
}

function validateDelete(value: unknown): ManagedDeploymentDeleteInput {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      "namespace,operationId,packageDigest,revisionId,schemaVersion,scriptName,shipletId",
    ) ||
    value.schemaVersion !== "shiplet.managed-deployment-delete/v1" ||
    !validIdentity(value)
  ) {
    throw new TypeError("managed_deployment_request_invalid");
  }
  return value as ManagedDeploymentDeleteInput;
}

function validateUpload(value: unknown): ManagedDeploymentUploadInput {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      "bindings,compatibilityDate,mainModule,modules,namespace,operationId,packageDigest,revisionId,schemaVersion,scriptName,shipletId",
    ) ||
    value.schemaVersion !== "shiplet.managed-deployment/v1" ||
    !validIdentity(value) ||
    value.compatibilityDate !== "2026-08-07" ||
    !MODULE_NAME.test(String(value.mainModule ?? "")) ||
    !Array.isArray(value.bindings) ||
    value.bindings.length !== 0 ||
    !Array.isArray(value.modules) ||
    value.modules.length === 0 ||
    value.modules.length > MAX_MODULES
  ) {
    throw new TypeError("managed_deployment_request_invalid");
  }
  let total = 0;
  const names = new Set<string>();
  for (const candidate of value.modules) {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, "bytes,mediaType,name") ||
      !MODULE_NAME.test(String(candidate.name ?? "")) ||
      names.has(candidate.name as string) ||
      !MEDIA_TYPE.test(String(candidate.mediaType ?? "")) ||
      !(candidate.bytes instanceof Uint8Array) ||
      candidate.bytes.byteLength === 0 ||
      candidate.bytes.byteLength > MAX_MODULE_BYTES
    ) {
      throw new TypeError("managed_deployment_request_invalid");
    }
    names.add(candidate.name as string);
    total += candidate.bytes.byteLength;
    if (total > MAX_BUNDLE_BYTES) {
      throw new TypeError("managed_deployment_request_invalid");
    }
  }
  if (!names.has(value.mainModule as string)) {
    throw new TypeError("managed_deployment_request_invalid");
  }
  return value as unknown as ManagedDeploymentUploadInput;
}

function proof(
  input: ManagedDeploymentIdentity,
  status: "present" | "absent",
): ManagedDeploymentProof {
  return Object.freeze({
    schemaVersion: "shiplet.managed-deployment-proof/v1" as const,
    operationId: input.operationId,
    namespace: input.namespace,
    scriptName: input.scriptName,
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    packageDigest: input.packageDigest,
    status,
  });
}

function operationTag(operationId: string) {
  return `shiplet-op-${operationId.slice("managed_".length)}`;
}

async function requestDigest(
  kind: "upload" | "delete",
  input: ManagedDeploymentIdentity,
  accountId: string,
  upload?: ManagedDeploymentUploadInput,
) {
  const modules = upload
    ? await Promise.all(
        upload.modules.map(async (module) => ({
          name: module.name,
          mediaType: module.mediaType,
          digest: `sha256:${await sha256(module.bytes)}`,
          byteLength: module.bytes.byteLength,
        })),
      )
    : undefined;
  return `sha256:${await sha256(
    canonicalJson({
      kind,
      accountId,
      operationId: input.operationId,
      namespace: input.namespace,
      scriptName: input.scriptName,
      shipletId: input.shipletId,
      revisionId: input.revisionId,
      packageDigest: input.packageDigest,
      ...(upload
        ? {
            mainModule: upload.mainModule,
            compatibilityDate: upload.compatibilityDate,
            modules,
            bindings: [],
          }
        : {}),
    }),
  )}`;
}

function exactOperation(
  row: OperationRow,
  expected: {
    kind: "upload" | "delete";
    accountId: string;
    input: ManagedDeploymentIdentity;
    digest: string;
    tag: string | null;
  },
) {
  return (
    row.operation_id === expected.input.operationId &&
    row.operation_kind === expected.kind &&
    row.account_id === expected.accountId &&
    row.namespace_name === expected.input.namespace &&
    row.script_name === expected.input.scriptName &&
    row.shiplet_id === expected.input.shipletId &&
    row.revision_id === expected.input.revisionId &&
    row.package_digest === expected.input.packageDigest &&
    row.request_digest === expected.digest &&
    row.operation_tag === expected.tag
  );
}

async function auditId(kind: "requested" | "succeeded", operationId: string) {
  return `control_audit_managed_${kind}_${(await sha256(operationId)).slice(0, 40)}`;
}

function auditEvent(
  kind: "upload" | "delete",
  outcome: "requested" | "success",
  input: ManagedDeploymentIdentity,
  occurredAt: number,
) {
  return JSON.stringify({
    eventKind: `cloudflare.managed_deployment.${kind}_${
      outcome === "requested" ? "requested" : "completed"
    }`,
    actorKind: "shiplet",
    actorId: input.shipletId,
    targetId: input.namespace,
    revisionId: input.revisionId,
    providerDeploymentId: input.scriptName,
    outcome,
    occurredAt,
  });
}

async function loadOperation(db: BrokerDatabase, operationId: string) {
  return db
    .prepare(
      `SELECT operation_id, operation_kind, namespace_name, script_name,
              account_id, shiplet_id, revision_id, package_digest, request_digest,
              operation_tag, status, created_on, applying_on, succeeded_on
       FROM managed_deployment_operations WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<OperationRow>();
}

async function loadOperationLease(db: BrokerDatabase, operationId: string) {
  return db
    .prepare(
      `SELECT operation_id, reservation_operation_id, connection_id,
              account_id, user_id, status, acquired_at, released_at, created_on
       FROM managed_platform_operation_leases WHERE operation_id = ?`,
    )
    .bind(operationId)
    .first<ManagedPlatformOperationLeaseRow>();
}

async function authorityAuditId(
  kind: "acquired" | "released",
  operationId: string,
) {
  return `control_audit_managed_authority_${kind}_${(
    await sha256(operationId)
  ).slice(0, 40)}`;
}

function authorityAuditEvent(
  kind: "acquired" | "released",
  row: OperationRow,
  reservation: ManagedPlatformReservationProof,
  occurredAt: number,
) {
  return JSON.stringify({
    eventKind: `cloudflare.managed_deployment.authority_${kind}`,
    actorKind: "shiplet",
    actorId: row.shiplet_id,
    targetId: reservation.operationId,
    revisionId: row.revision_id,
    providerDeploymentId: row.script_name,
    outcome: kind,
    occurredAt,
  });
}

function exactOperationLease(
  lease: ManagedPlatformOperationLeaseRow,
  row: OperationRow,
  reservation: ManagedPlatformReservationProof,
  status: "active" | "released",
) {
  return (
    lease.operation_id === row.operation_id &&
    lease.reservation_operation_id === reservation.operationId &&
    lease.connection_id === reservation.connectionId &&
    lease.account_id === reservation.accountId &&
    lease.user_id === reservation.ownerUserId &&
    lease.status === status
  );
}

async function reserveOperation(input: {
  db: BrokerDatabase;
  now: number;
  kind: "upload" | "delete";
  accountId: string;
  identity: ManagedDeploymentIdentity;
  digest: string;
  tag: string | null;
}) {
  const createdOn = new Date(input.now).toISOString();
  await input.db
    .prepare(
      `INSERT OR IGNORE INTO managed_deployment_operations (
        operation_id, operation_kind, account_id, namespace_name, script_name,
        shiplet_id, revision_id, package_digest, request_digest,
        operation_tag, status, created_on, applying_on, succeeded_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL)`,
    )
    .bind(
      input.identity.operationId,
      input.kind,
      input.accountId,
      input.identity.namespace,
      input.identity.scriptName,
      input.identity.shipletId,
      input.identity.revisionId,
      input.identity.packageDigest,
      input.digest,
      input.tag,
      createdOn,
    )
    .run();
  const row = await loadOperation(input.db, input.identity.operationId);
  if (
    !row ||
    !exactOperation(row, {
      kind: input.kind,
      accountId: input.accountId,
      input: input.identity,
      digest: input.digest,
      tag: input.tag,
    })
  ) {
    throw new Error("managed_deployment_operation_conflict");
  }
  await input.db
    .prepare(
      `INSERT OR IGNORE INTO control_audit_outbox (
        id, event_json, delivery_status, created_on, delivered_on
      ) VALUES (?, ?, 'pending', ?, NULL)`,
    )
    .bind(
      await auditId("requested", input.identity.operationId),
      auditEvent(input.kind, "requested", input.identity, input.now),
      createdOn,
    )
    .run();
  return row;
}

async function claimApply(input: {
  db: BrokerDatabase;
  row: OperationRow;
  now: number;
  reservation: ManagedPlatformReservationProof;
}) {
  if (input.row.status === "succeeded") return false;
  // An applying row represents one provider dispatch whose remote outcome may
  // still be in flight even after the local call settles. Exact retries only
  // reconcile provider state; they never create a second dispatch attempt.
  if (input.row.status === "applying") return false;
  const applyingOn = new Date(input.now).toISOString();
  const acquiredAuditId = await authorityAuditId(
    "acquired",
    input.row.operation_id,
  );
  const acquiredAudit = authorityAuditEvent(
    "acquired",
    input.row,
    input.reservation,
    input.now,
  );
  const claimed = await input.db.batch([
    input.db
      .prepare(
        `UPDATE managed_deployment_operations
         SET status = 'applying', applying_on = ?
         WHERE operation_id = ? AND status = 'reserved'
           AND applying_on IS NULL AND succeeded_on IS NULL
           AND EXISTS (
             SELECT 1 FROM managed_platform_connection_reservations reservation
             WHERE reservation.operation_id = ? AND reservation.purpose = ?
               AND reservation.connection_id = ? AND reservation.account_id = ?
               AND reservation.user_id = ? AND reservation.status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM managed_platform_connection_retirements retirement
                 WHERE retirement.reservation_operation_id = reservation.operation_id
               )
           )`,
      )
      .bind(
        applyingOn,
        input.row.operation_id,
        input.reservation.operationId,
        input.reservation.purpose,
        input.reservation.connectionId,
        input.reservation.accountId,
        input.reservation.ownerUserId,
      ),
    input.db
      .prepare(
        `INSERT OR IGNORE INTO managed_platform_operation_leases (
             operation_id, reservation_operation_id, connection_id, account_id,
             user_id, status, acquired_at, released_at, created_on
           ) SELECT ?, reservation.operation_id, reservation.connection_id,
                    reservation.account_id, reservation.user_id, 'active', ?, NULL, ?
             FROM managed_platform_connection_reservations reservation
             WHERE reservation.operation_id = ? AND reservation.purpose = ?
               AND reservation.connection_id = ? AND reservation.account_id = ?
               AND reservation.user_id = ? AND reservation.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM managed_deployment_operations operation
                 WHERE operation.operation_id = ? AND operation.status = 'applying'
                   AND operation.applying_on = ? AND operation.succeeded_on IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM managed_platform_connection_retirements retirement
                 WHERE retirement.reservation_operation_id = reservation.operation_id
               )`,
      )
      .bind(
        input.row.operation_id,
        input.now,
        applyingOn,
        input.reservation.operationId,
        input.reservation.purpose,
        input.reservation.connectionId,
        input.reservation.accountId,
        input.reservation.ownerUserId,
        input.row.operation_id,
        applyingOn,
      ),
    input.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_outbox (
             id, event_json, delivery_status, created_on, delivered_on
           ) SELECT ?, ?, 'pending', ?, NULL
             WHERE EXISTS (
               SELECT 1 FROM managed_platform_operation_leases
               WHERE operation_id = ? AND reservation_operation_id = ?
                 AND connection_id = ? AND account_id = ? AND user_id = ?
                 AND status = 'active'
             )`,
      )
      .bind(
        acquiredAuditId,
        acquiredAudit,
        applyingOn,
        input.row.operation_id,
        input.reservation.operationId,
        input.reservation.connectionId,
        input.reservation.accountId,
        input.reservation.ownerUserId,
      ),
  ]);
  if (claimed[0]?.meta.changes !== 1) return false;
  const lease = await loadOperationLease(input.db, input.row.operation_id);
  if (
    !lease ||
    !exactOperationLease(lease, input.row, input.reservation, "active")
  ) {
    throw new Error("managed_deployment_authority_lease_failed");
  }
  return applyingOn;
}

function exactApplyFence(row: OperationRow) {
  if (
    row.status !== "applying" ||
    typeof row.applying_on !== "string" ||
    !Number.isFinite(Date.parse(row.applying_on)) ||
    row.succeeded_on !== null
  ) {
    throw new Error("managed_deployment_attempt_invalid");
  }
  return row.applying_on;
}

async function assertOperationLease(input: {
  db: BrokerDatabase;
  row: OperationRow;
  applyingOn: string;
  reservation: ManagedPlatformReservationProof;
}) {
  const lease = await input.db
    .prepare(
      `SELECT lease.operation_id, lease.reservation_operation_id,
              lease.connection_id, lease.account_id, lease.user_id,
              lease.status, lease.acquired_at, lease.released_at, lease.created_on
       FROM managed_platform_operation_leases lease
       JOIN managed_deployment_operations operation
         ON operation.operation_id = lease.operation_id
       JOIN managed_platform_connection_reservations reservation
         ON reservation.operation_id = lease.reservation_operation_id
       WHERE lease.operation_id = ? AND lease.reservation_operation_id = ?
         AND lease.connection_id = ? AND lease.account_id = ? AND lease.user_id = ?
         AND lease.status = 'active' AND reservation.status = 'active'
         AND operation.status = 'applying' AND operation.applying_on = ?
         AND operation.succeeded_on IS NULL`,
    )
    .bind(
      input.row.operation_id,
      input.reservation.operationId,
      input.reservation.connectionId,
      input.reservation.accountId,
      input.reservation.ownerUserId,
      input.applyingOn,
    )
    .first<ManagedPlatformOperationLeaseRow>();
  if (
    !lease ||
    !exactOperationLease(lease, input.row, input.reservation, "active")
  ) {
    throw new Error("managed_deployment_authority_lease_required");
  }
}

async function completeOperation(input: {
  db: BrokerDatabase;
  row: OperationRow;
  identity: ManagedDeploymentIdentity;
  reservation: ManagedPlatformReservationProof;
  applyingOn: string;
  now: number;
}) {
  if (input.row.status === "succeeded") return;
  const succeededOn = new Date(input.now).toISOString();
  const releasedAuditId = await authorityAuditId(
    "released",
    input.row.operation_id,
  );
  const releasedAudit = authorityAuditEvent(
    "released",
    input.row,
    input.reservation,
    input.now,
  );
  await input.db.batch([
    input.db
      .prepare(
        `UPDATE managed_deployment_operations
         SET status = 'succeeded', succeeded_on = ?
         WHERE operation_id = ? AND status = 'applying'
           AND applying_on = ? AND succeeded_on IS NULL
           AND EXISTS (
             SELECT 1 FROM managed_platform_operation_leases lease
             WHERE lease.operation_id = managed_deployment_operations.operation_id
               AND lease.reservation_operation_id = ?
               AND lease.connection_id = ? AND lease.account_id = ?
               AND lease.user_id = ? AND lease.status = 'active'
           )`,
      )
      .bind(
        succeededOn,
        input.row.operation_id,
        input.applyingOn,
        input.reservation.operationId,
        input.reservation.connectionId,
        input.reservation.accountId,
        input.reservation.ownerUserId,
      ),
    input.db
      .prepare(
        `UPDATE managed_platform_operation_leases
         SET status = 'released', released_at = ?
         WHERE operation_id = ? AND reservation_operation_id = ?
           AND connection_id = ? AND account_id = ? AND user_id = ?
           AND status = 'active' AND released_at IS NULL
           AND EXISTS (
             SELECT 1 FROM managed_deployment_operations operation
             WHERE operation.operation_id = managed_platform_operation_leases.operation_id
               AND operation.status = 'succeeded'
               AND operation.applying_on = ?
               AND operation.succeeded_on IS NOT NULL
           )`,
      )
      .bind(
        input.now,
        input.row.operation_id,
        input.reservation.operationId,
        input.reservation.connectionId,
        input.reservation.accountId,
        input.reservation.ownerUserId,
        input.applyingOn,
      ),
    input.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_outbox (
          id, event_json, delivery_status, created_on, delivered_on
        ) SELECT ?, ?, 'pending', ?, NULL
          WHERE EXISTS (
            SELECT 1 FROM managed_deployment_operations
            WHERE operation_id = ? AND status = 'succeeded'
          )`,
      )
      .bind(
        await auditId("succeeded", input.identity.operationId),
        auditEvent(
          input.row.operation_kind,
          "success",
          input.identity,
          input.now,
        ),
        succeededOn,
        input.row.operation_id,
      ),
    input.db
      .prepare(
        `INSERT OR IGNORE INTO control_audit_outbox (
           id, event_json, delivery_status, created_on, delivered_on
         ) SELECT ?, ?, 'pending', ?, NULL
           WHERE EXISTS (
             SELECT 1 FROM managed_platform_operation_leases
             WHERE operation_id = ? AND reservation_operation_id = ?
               AND status = 'released'
           )`,
      )
      .bind(
        releasedAuditId,
        releasedAudit,
        succeededOn,
        input.row.operation_id,
        input.reservation.operationId,
      ),
  ]);
  const current = await loadOperation(input.db, input.row.operation_id);
  if (
    !current ||
    current.status !== "succeeded" ||
    current.applying_on !== input.applyingOn
  ) {
    throw new Error("managed_deployment_checkpoint_failed");
  }
}

async function ownedUpload(
  db: BrokerDatabase,
  accountId: string,
  identity: Omit<ManagedDeploymentIdentity, "operationId">,
) {
  return db
    .prepare(
      `SELECT operation_id, operation_kind, namespace_name, script_name,
              account_id, shiplet_id, revision_id, package_digest, request_digest,
              operation_tag, status, created_on, applying_on, succeeded_on
       FROM managed_deployment_operations
       WHERE operation_kind = 'upload' AND account_id = ?
         AND namespace_name = ? AND script_name = ?
         AND shiplet_id = ? AND revision_id = ? AND package_digest = ?
         AND status IN ('applying', 'succeeded')
       LIMIT 1`,
    )
    .bind(
      accountId,
      identity.namespace,
      identity.scriptName,
      identity.shipletId,
      identity.revisionId,
      identity.packageDigest,
    )
    .first<OperationRow>();
}

function assertProviderIdentity(
  value:
    | { status: "absent" }
    | { status: "present"; operationTag: string; bindings: readonly unknown[] },
  expectedTag: string,
) {
  if (value.status === "absent") return false;
  if (
    value.operationTag !== expectedTag ||
    !OPERATION_TAG.test(value.operationTag)
  ) {
    throw new Error("managed_deployment_identity_mismatch");
  }
  if (!Array.isArray(value.bindings) || value.bindings.length !== 0) {
    throw new Error("managed_deployment_ambient_binding_detected");
  }
  return true;
}

export function createManagedDeploymentBroker(input: {
  db: BrokerDatabase;
  now: () => number;
  platformAccountId: string;
  requirePlatformReservation: () => Promise<ManagedPlatformReservationProof>;
  resolveProvider: (
    reservation: ManagedPlatformReservationProof,
  ) => Promise<ManagedDeploymentProvider>;
}) {
  const platformAccountId = () => {
    if (!ACCOUNT_ID.test(input.platformAccountId)) {
      throw new Error("managed_deployment_provider_unavailable");
    }
    return input.platformAccountId;
  };
  const provider = async () => {
    const reservation = await input.requirePlatformReservation();
    if (
      reservation?.schemaVersion !==
        "shiplet.managed-platform-reservation-proof/v1" ||
      !PLATFORM_RESERVATION_OPERATION_ID.test(reservation.operationId) ||
      reservation.purpose !== "managed_wfp_provider" ||
      !IDENTIFIER.test(reservation.connectionId) ||
      reservation.accountId !== platformAccountId() ||
      !IDENTIFIER.test(reservation.ownerUserId) ||
      reservation.status !== "active" ||
      !Number.isSafeInteger(reservation.reservedAt) ||
      reservation.reservedAt < 0
    ) {
      throw new Error("managed_platform_reservation_required");
    }
    try {
      const resolved = await input.resolveProvider(reservation);
      if (
        !resolved ||
        typeof resolved.readNamespace !== "function" ||
        typeof resolved.inspectScript !== "function" ||
        typeof resolved.uploadScript !== "function" ||
        typeof resolved.deleteScript !== "function"
      ) {
        throw new Error("provider_invalid");
      }
      return Object.freeze({ reservation, resolved });
    } catch {
      throw new Error("managed_deployment_provider_unavailable");
    }
  };

  const assertSameReservation = async (
    expected: ManagedPlatformReservationProof,
  ) => {
    const current = await input.requirePlatformReservation();
    if (
      current.schemaVersion !==
        "shiplet.managed-platform-reservation-proof/v1" ||
      current.operationId !== expected.operationId ||
      current.connectionId !== expected.connectionId ||
      current.accountId !== expected.accountId ||
      current.ownerUserId !== expected.ownerUserId ||
      current.purpose !== expected.purpose ||
      current.status !== "active"
    ) {
      throw new Error("managed_platform_reservation_required");
    }
    return current;
  };

  const inspectOwned = async (
    identity: ManagedDeploymentIdentity,
    resolved: ManagedDeploymentProvider,
  ) => {
    const inspected = await resolved.inspectScript(identity);
    if (inspected.status === "absent") return false;
    const owner = await ownedUpload(input.db, platformAccountId(), identity);
    if (!owner?.operation_tag) {
      throw new Error("managed_deployment_unowned");
    }
    return assertProviderIdentity(inspected, owner.operation_tag);
  };

  return Object.freeze({
    async readiness() {
      platformAccountId();
      const { resolved } = await provider();
      const namespaces = [] as Array<{
        name: ManagedDeploymentNamespace;
        trustedWorkers: false;
      }>;
      for (const name of NAMESPACES) {
        const current = await resolved.readNamespace(name);
        if (current.name !== name || current.trustedWorkers !== false) {
          throw new Error("managed_deployment_namespace_untrusted_required");
        }
        namespaces.push({ name, trustedWorkers: false });
      }
      return Object.freeze({
        schemaVersion: "shiplet.managed-deployment-readiness/v1" as const,
        operations: Object.freeze(["inspect", "upload", "delete"] as const),
        namespaces: Object.freeze(namespaces) as readonly [
          { name: typeof STAGING; trustedWorkers: false },
          { name: typeof PRODUCTION; trustedWorkers: false },
        ],
      });
    },

    async inspect(candidate: unknown) {
      const request = validateInspect(candidate);
      const { resolved } = await provider();
      const present = await inspectOwned(request, resolved);
      return proof(request, present ? "present" : "absent");
    },

    async upload(candidate: unknown) {
      const request = validateUpload(candidate);
      const { reservation, resolved } = await provider();
      const now = trustedNow(input.now);
      const tag = operationTag(request.operationId);
      const accountId = platformAccountId();
      const digest = await requestDigest("upload", request, accountId, request);
      let row = await reserveOperation({
        db: input.db,
        now,
        kind: "upload",
        accountId,
        identity: request,
        digest,
        tag,
      });
      const inspected = await resolved.inspectScript(request);
      if (inspected.status === "present") {
        assertProviderIdentity(inspected, tag);
        if (row.status !== "succeeded") {
          if (row.status === "reserved") {
            throw new Error("managed_deployment_identity_mismatch");
          }
          await completeOperation({
            db: input.db,
            row,
            identity: request,
            reservation,
            applyingOn: exactApplyFence(row),
            now,
          });
        }
        return proof(request, "present");
      }
      if (row.status === "succeeded") {
        throw new Error("managed_deployment_drift");
      }
      const mayApply = await claimApply({
        db: input.db,
        row,
        now,
        reservation,
      });
      row = (await loadOperation(input.db, request.operationId)) ?? row;
      if (!mayApply) {
        await assertSameReservation(reservation);
        throw new Error("managed_deployment_outcome_ambiguous");
      }
      await assertOperationLease({
        db: input.db,
        row,
        applyingOn: mayApply,
        reservation,
      });
      try {
        await resolved.uploadScript({
          namespace: request.namespace,
          scriptName: request.scriptName,
          operationTag: tag,
          mainModule: request.mainModule,
          compatibilityDate: request.compatibilityDate,
          modules: request.modules,
          bindings: [],
        });
      } catch {
        // A timeout can occur after Cloudflare committed the upload. The exact
        // operation tag and empty settings are the only accepted recovery proof.
      }
      const after = await resolved.inspectScript(request);
      if (!assertProviderIdentity(after, tag)) {
        throw new Error("managed_deployment_upload_failed");
      }
      await completeOperation({
        db: input.db,
        row,
        identity: request,
        reservation,
        applyingOn: mayApply,
        now,
      });
      return proof(request, "present");
    },

    async delete(candidate: unknown) {
      const request = validateDelete(candidate);
      const { reservation, resolved } = await provider();
      const now = trustedNow(input.now);
      const accountId = platformAccountId();
      const digest = await requestDigest("delete", request, accountId);
      let row = await reserveOperation({
        db: input.db,
        now,
        kind: "delete",
        accountId,
        identity: request,
        digest,
        tag: null,
      });
      const before = await resolved.inspectScript(request);
      const owner = await ownedUpload(input.db, accountId, request);
      if (before.status === "present") {
        if (!owner?.operation_tag)
          throw new Error("managed_deployment_unowned");
        assertProviderIdentity(before, owner.operation_tag);
      }
      if (before.status === "absent") {
        if (row.status === "succeeded") {
          return proof(request, "absent");
        }
        if (row.status === "reserved") {
          const claimed = await claimApply({
            db: input.db,
            row,
            now,
            reservation,
          });
          row = (await loadOperation(input.db, request.operationId)) ?? row;
          if (!claimed) {
            await assertSameReservation(reservation);
            throw new Error("managed_deployment_outcome_ambiguous");
          }
        }
        await completeOperation({
          db: input.db,
          row,
          identity: request,
          reservation,
          applyingOn: exactApplyFence(row),
          now,
        });
        return proof(request, "absent");
      }
      if (row.status === "succeeded") {
        throw new Error("managed_deployment_drift");
      }
      const mayApply = await claimApply({
        db: input.db,
        row,
        now,
        reservation,
      });
      row = (await loadOperation(input.db, request.operationId)) ?? row;
      if (!mayApply) {
        const recovered = await resolved.inspectScript(request);
        if (recovered.status !== "absent") {
          await assertSameReservation(reservation);
          throw new Error("managed_deployment_outcome_ambiguous");
        }
        await completeOperation({
          db: input.db,
          row,
          identity: request,
          reservation,
          applyingOn: exactApplyFence(row),
          now,
        });
        return proof(request, "absent");
      }
      await assertOperationLease({
        db: input.db,
        row,
        applyingOn: mayApply,
        reservation,
      });
      try {
        await resolved.deleteScript(request);
      } catch {
        // Reconcile exact absence below; provider error text is never surfaced.
      }
      const after = await resolved.inspectScript(request);
      if (after.status !== "absent") {
        if (owner?.operation_tag)
          assertProviderIdentity(after, owner.operation_tag);
        throw new Error("managed_deployment_delete_failed");
      }
      await completeOperation({
        db: input.db,
        row,
        identity: request,
        reservation,
        applyingOn: mayApply,
        now,
      });
      return proof(request, "absent");
    },
  });
}

async function readBounded(response: Response) {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (
    response.headers.has("content-length") &&
    (!Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new Error("managed_provider_response_invalid");
  }
  if (!response.body) throw new Error("managed_provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("managed_provider_response_invalid");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("managed_provider_response_invalid");
  }
}

async function envelope(response: Response) {
  if (!response.ok) throw new Error("managed_provider_request_failed");
  const body = await readBounded(response);
  if (!isRecord(body) || body.success !== true || !("result" in body)) {
    throw new Error("managed_provider_response_invalid");
  }
  return body.result;
}

function providerUrl(
  accountId: string,
  namespace: ManagedDeploymentNamespace,
  suffix = "",
) {
  return `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/dispatch/namespaces/${namespace}${suffix}`;
}

export function createCloudflareManagedDeploymentTransport(input: {
  accountId: string;
  authorizedFetch: (request: Request) => Promise<Response>;
}): ManagedDeploymentProvider {
  if (
    !ACCOUNT_ID.test(input.accountId) ||
    typeof input.authorizedFetch !== "function"
  ) {
    throw new TypeError("managed_provider_configuration_invalid");
  }
  const request = (url: string, init?: RequestInit) =>
    input.authorizedFetch(new Request(url, { ...init, redirect: "manual" }));
  const scriptUrl = (identity: ProviderScriptIdentity, suffix = "") =>
    providerUrl(
      input.accountId,
      identity.namespace,
      `/scripts/${identity.scriptName}${suffix}`,
    );

  const transport: ManagedDeploymentProvider = {
    async readNamespace(namespace: ManagedDeploymentNamespace) {
      if (!NAMESPACES.includes(namespace)) {
        throw new TypeError("managed_provider_route_denied");
      }
      const result = await envelope(
        await request(providerUrl(input.accountId, namespace), {
          method: "GET",
          headers: { accept: "application/json" },
        }),
      );
      if (
        !isRecord(result) ||
        result.namespace_name !== namespace ||
        typeof result.trusted_workers !== "boolean"
      ) {
        throw new Error("managed_provider_response_invalid");
      }
      return {
        name: namespace,
        trustedWorkers: result.trusted_workers,
      };
    },

    async inspectScript(identity: ProviderScriptIdentity) {
      if (
        !NAMESPACES.includes(identity.namespace) ||
        !SCRIPT_IDENTIFIER.test(identity.scriptName)
      ) {
        throw new TypeError("managed_provider_route_denied");
      }
      const detailsResponse = await request(scriptUrl(identity), {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (detailsResponse.status === 404) {
        await detailsResponse.body?.cancel().catch(() => undefined);
        return { status: "absent" as const };
      }
      const details = await envelope(detailsResponse);
      if (
        !isRecord(details) ||
        details.dispatch_namespace !== identity.namespace ||
        !isRecord(details.script) ||
        details.script.id !== identity.scriptName
      ) {
        throw new Error("managed_provider_response_invalid");
      }
      const [tags, settings] = await Promise.all([
        envelope(
          await request(scriptUrl(identity, "/tags"), {
            method: "GET",
            headers: { accept: "application/json" },
          }),
        ),
        envelope(
          await request(scriptUrl(identity, "/settings"), {
            method: "GET",
            headers: { accept: "application/json" },
          }),
        ),
      ]);
      if (
        !Array.isArray(tags) ||
        tags.length !== 1 ||
        typeof tags[0] !== "string" ||
        !OPERATION_TAG.test(tags[0]) ||
        !isRecord(settings) ||
        !Array.isArray(settings.bindings)
      ) {
        throw new Error("managed_provider_response_invalid");
      }
      return {
        status: "present" as const,
        operationTag: tags[0],
        bindings: structuredClone(settings.bindings),
      };
    },

    async uploadScript(
      upload: Parameters<ManagedDeploymentProvider["uploadScript"]>[0],
    ) {
      if (
        !NAMESPACES.includes(upload.namespace) ||
        !SCRIPT_IDENTIFIER.test(upload.scriptName) ||
        !OPERATION_TAG.test(upload.operationTag) ||
        !MODULE_NAME.test(upload.mainModule) ||
        upload.compatibilityDate !== "2026-08-07" ||
        !Array.isArray(upload.bindings) ||
        upload.bindings.length !== 0 ||
        !Array.isArray(upload.modules) ||
        upload.modules.length === 0
      ) {
        throw new TypeError("managed_provider_request_invalid");
      }
      const form = new FormData();
      form.append(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              main_module: upload.mainModule,
              compatibility_date: upload.compatibilityDate,
              bindings: [],
              tags: [upload.operationTag],
            }),
          ],
          { type: "application/json" },
        ),
      );
      const names = new Set<string>();
      for (const module of upload.modules) {
        if (
          !MODULE_NAME.test(module.name) ||
          names.has(module.name) ||
          !MEDIA_TYPE.test(module.mediaType) ||
          !(module.bytes instanceof Uint8Array) ||
          module.bytes.byteLength === 0 ||
          module.bytes.byteLength > MAX_MODULE_BYTES
        ) {
          throw new TypeError("managed_provider_request_invalid");
        }
        names.add(module.name);
        const bytes = module.bytes.slice() as Uint8Array<ArrayBuffer>;
        form.append(module.name, new Blob([bytes], { type: module.mediaType }));
      }
      const url = new URL(scriptUrl(upload));
      url.searchParams.set("bindings_inherit", "strict");
      await envelope(
        await request(url.toString(), {
          method: "PUT",
          headers: { accept: "application/json" },
          body: form,
        }),
      );
    },

    async deleteScript(identity: ProviderScriptIdentity) {
      if (
        !NAMESPACES.includes(identity.namespace) ||
        !SCRIPT_IDENTIFIER.test(identity.scriptName)
      ) {
        throw new TypeError("managed_provider_route_denied");
      }
      await envelope(
        await request(scriptUrl(identity), {
          method: "DELETE",
          headers: { accept: "application/json" },
        }),
      );
    },
  };
  return Object.freeze(transport);
}
