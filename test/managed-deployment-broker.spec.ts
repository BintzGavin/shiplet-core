import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  authorizeManagedPlatformConnection,
  assertManagedPlatformCustomerOperationAllowed,
  createCloudflareManagedDeploymentTransport,
  createManagedDeploymentBroker,
  requireActiveManagedPlatformReservation,
  reserveManagedPlatformConnection,
  retireManagedPlatformConnection,
  type ManagedDeploymentProvider,
} from "../src/cloudflare-support/managed-deployment-broker";
import {
  CloudflareManagedDeploymentBrokerRpc,
  CloudflareGrantVaultRpc,
  CloudflareOAuthControlPlane,
} from "../workers/cloudflare-control-plane/index";
import type { ControlPlaneEnv } from "../workers/cloudflare-control-plane/env";
// @ts-expect-error Vite supplies the additive migration source text.
import brokerMigration from "../workers/cloudflare-control-plane/migrations/0008_managed_deployment_broker.sql?raw";
// @ts-expect-error Vite supplies the additive migration source text.
import reservationMigration from "../workers/cloudflare-control-plane/migrations/0009_managed_platform_connection_reservation.sql?raw";
// @ts-expect-error Vite supplies the additive migration source text.
import retirementMigration from "../workers/cloudflare-control-plane/migrations/0010_managed_platform_connection_retirement.sql?raw";
// @ts-expect-error Vite supplies the additive migration source text.
import attemptFenceMigration from "../workers/cloudflare-control-plane/migrations/0011_managed_provider_attempt_fence.sql?raw";

/**
 * Managed deployment broker behavioral specification
 *
 * Given a dedicated, exact-account OAuth provider connection and two untrusted
 * dispatch namespaces, when the managed-runtime gateway inspects, uploads, or
 * deletes one immutable revision, then the broker fences the exact operation,
 * sends no bindings, verifies an operation tag and zero provider bindings, and
 * records immutable non-secret audit intent and completion evidence.
 *
 * Given missing configuration, a trusted namespace, malformed/cross-Shiplet
 * identity, operation replay, provider drift, or a non-empty binding set, when
 * the request reaches the broker, then it fails closed before granting proof.
 *
 * Given the provider commits an upload or deletion but its response is lost,
 * when the broker reconciles the exact operation, then provider inspection
 * proves the committed outcome without duplicating or widening authority.
 *
 * Given an OAuth connection captured for Shiplet's managed WFP control plane,
 * when its exact account, human owner, and reservation operation are persisted,
 * then only that immutable active purpose may reach the provider. Customer
 * grants and the ordinary customer revoke flow fail closed for the reservation.
 *
 * Given one provider mutation is still in flight after its local apply window,
 * when the exact operation is retried, then the broker reconciles without a
 * second dispatch and keeps retirement fenced until that dispatched attempt is
 * proven terminal.
 *
 * Given the managed-runtime gateway asks for value-free authority confirmation,
 * when the expected support release and fixed managed-platform reservation are
 * both exact and active, then the broker RPC returns only frozen `{ok: true}`
 * without opening credential material or contacting the provider.
 */

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;

const PACKAGE_A = `sha256:${"a".repeat(64)}`;
const PACKAGE_B = `sha256:${"b".repeat(64)}`;
const STAGING = "shiplet-managed-staging" as const;
const PRODUCTION = "shiplet-managed-production" as const;

function operation(character: string) {
  return `managed_${character.repeat(43)}`;
}

function reservationOperation(character: string) {
  return `managed_platform_${character.repeat(43)}`;
}

function retirementOperation(character: string) {
  return `managed_platform_retire_${character.repeat(43)}`;
}

const PLATFORM_CONNECTION_ID = "cloudflare_connection_platform";
const PLATFORM_ACCOUNT_ID = "account_fixture";
const PLATFORM_USER_ID = "user_platform_owner";

function reservationInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "shiplet.managed-platform-reservation/v1" as const,
    operationId: reservationOperation("r"),
    purpose: "managed_wfp_provider" as const,
    actor: { kind: "human" as const, id: PLATFORM_USER_ID },
    connectionId: PLATFORM_CONNECTION_ID,
    accountId: PLATFORM_ACCOUNT_ID,
    ...overrides,
  };
}

function retirementInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "shiplet.managed-platform-retirement/v1" as const,
    operationId: retirementOperation("t"),
    purpose: "managed_wfp_provider" as const,
    actor: { kind: "human" as const, id: PLATFORM_USER_ID },
    reservationOperationId: reservationOperation("r"),
    connectionId: PLATFORM_CONNECTION_ID,
    accountId: PLATFORM_ACCOUNT_ID,
    ...overrides,
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    operationId: operation("a"),
    namespace: STAGING,
    scriptName: "shiplet-managed-fixture",
    shipletId: "shiplet_fixture",
    revisionId: "revision_fixture",
    packageDigest: PACKAGE_A,
    ...overrides,
  };
}

function inspectInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "shiplet.managed-deployment-inspect/v1" as const,
    ...identity(overrides),
  };
}

function uploadInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "shiplet.managed-deployment/v1" as const,
    ...identity(overrides),
    mainModule: "worker.mjs",
    compatibilityDate: "2026-08-07" as const,
    modules: [
      {
        name: "worker.mjs",
        mediaType: "application/javascript+module",
        bytes: new TextEncoder().encode(
          "export default { fetch() { return new Response('ok') } }",
        ),
      },
    ],
    bindings: [] as const,
  };
}

function deleteInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "shiplet.managed-deployment-delete/v1" as const,
    ...identity({ operationId: operation("d"), ...overrides }),
  };
}

function migrationStatements(source: string) {
  const statements: string[] = [];
  let current: string[] = [];
  let trigger = false;
  for (const line of source.split(/\r?\n/)) {
    if (!current.length && !line.trim()) continue;
    current.push(line);
    if (/^CREATE TRIGGER\b/i.test(line.trim())) trigger = true;
    if (
      (!trigger && line.trim().endsWith(";")) ||
      (trigger && line.trim().toUpperCase() === "END;")
    ) {
      statements.push(current.join("\n"));
      current = [];
      trigger = false;
    }
  }
  if (current.some((line) => line.trim()))
    throw new Error("migration_incomplete");
  return statements;
}

async function resetSchema() {
  await testEnv.DB.prepare(
    "DROP TABLE IF EXISTS managed_platform_operation_leases",
  ).run();
  await testEnv.DB.prepare(
    "DROP TABLE IF EXISTS managed_platform_connection_retirements",
  ).run();
  await testEnv.DB.prepare(
    "DROP TABLE IF EXISTS managed_platform_connection_reservations",
  ).run();
  await testEnv.DB.prepare(
    "DROP TABLE IF EXISTS managed_deployment_operations",
  ).run();
  await testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_connections").run();
  await testEnv.DB.prepare(
    `CREATE TABLE cloudflare_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_label TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      revoked_at INTEGER,
      generation INTEGER NOT NULL,
      created_on TEXT NOT NULL,
      refreshed_at INTEGER
    )`,
  ).run();
  await testEnv.DB.prepare(
    `CREATE TABLE IF NOT EXISTS control_audit_outbox (
      id TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      delivery_status TEXT NOT NULL CHECK (delivery_status IN ('pending', 'delivered')),
      created_on TEXT NOT NULL,
      delivered_on TEXT
    )`,
  ).run();
  for (const statement of migrationStatements(brokerMigration)) {
    await testEnv.DB.prepare(statement).run();
  }
  for (const statement of migrationStatements(reservationMigration)) {
    await testEnv.DB.prepare(statement).run();
  }
  for (const statement of migrationStatements(retirementMigration)) {
    await testEnv.DB.prepare(statement).run();
  }
  for (const statement of migrationStatements(attemptFenceMigration)) {
    await testEnv.DB.prepare(statement).run();
  }
}

async function reservePlatform(overrides: Record<string, unknown> = {}) {
  return reserveManagedPlatformConnection({
    db: testEnv.DB,
    now: 1_900_000_000_000,
    input: reservationInput(overrides),
  });
}

type StoredScript = {
  operationTag: string;
  bindings: readonly unknown[];
};

function createProvider(
  options: {
    trustedStaging?: boolean;
    trustedProduction?: boolean;
    loseUploadResponse?: boolean;
    failUploadBeforeCommitOnce?: boolean;
    loseDeleteResponse?: boolean;
    beforeAbsentInspectionReturns?: () => Promise<void>;
    beforeUploadEffect?: () => Promise<void>;
  } = {},
) {
  const scripts = new Map<string, StoredScript>();
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let uploadLost = false;
  let deleteLost = false;
  const key = (input: { namespace: string; scriptName: string }) =>
    `${input.namespace}/${input.scriptName}`;
  const provider: ManagedDeploymentProvider = {
    async readNamespace(namespace) {
      calls.push({ method: "readNamespace", input: { namespace } });
      return {
        name: namespace,
        trustedWorkers:
          namespace === STAGING
            ? (options.trustedStaging ?? false)
            : (options.trustedProduction ?? false),
      };
    },
    async inspectScript(input) {
      calls.push({ method: "inspectScript", input: { ...input } });
      const stored = scripts.get(key(input));
      if (!stored && options.beforeAbsentInspectionReturns) {
        await options.beforeAbsentInspectionReturns();
      }
      return stored
        ? { status: "present" as const, ...stored }
        : { status: "absent" as const };
    },
    async uploadScript(input) {
      calls.push({ method: "uploadScript", input: { ...input } });
      if (options.beforeUploadEffect) await options.beforeUploadEffect();
      if (options.failUploadBeforeCommitOnce && !uploadLost) {
        uploadLost = true;
        throw new Error("fixture_request_failed_before_commit");
      }
      scripts.set(key(input), {
        operationTag: input.operationTag,
        bindings: [],
      });
      if (options.loseUploadResponse && !uploadLost) {
        uploadLost = true;
        throw new Error("fixture_response_lost");
      }
    },
    async deleteScript(input) {
      calls.push({ method: "deleteScript", input: { ...input } });
      scripts.delete(key(input));
      if (options.loseDeleteResponse && !deleteLost) {
        deleteLost = true;
        throw new Error("fixture_response_lost");
      }
    },
  };
  return { provider, calls, scripts };
}

function broker(
  provider: ManagedDeploymentProvider,
  now = () => 1_900_000_000_000,
) {
  return createManagedDeploymentBroker({
    db: testEnv.DB,
    now,
    platformAccountId: PLATFORM_ACCOUNT_ID,
    requirePlatformReservation: () =>
      requireActiveManagedPlatformReservation({
        db: testEnv.DB,
        connectionId: PLATFORM_CONNECTION_ID,
        accountId: PLATFORM_ACCOUNT_ID,
      }),
    resolveProvider: async () => provider,
  });
}

describe("managed WFP deployment broker", () => {
  beforeEach(async () => {
    await resetSchema();
    await reservePlatform();
  });

  it("Given exact namespaces, When readiness is requested, Then both are proven untrusted with only the narrow operations", async () => {
    const fixture = createProvider();

    await expect(broker(fixture.provider).readiness()).resolves.toEqual({
      schemaVersion: "shiplet.managed-deployment-readiness/v1",
      operations: ["inspect", "upload", "delete"],
      namespaces: [
        { name: STAGING, trustedWorkers: false },
        { name: PRODUCTION, trustedWorkers: false },
      ],
    });
    expect(fixture.calls.map((call) => call.method)).toEqual([
      "readNamespace",
      "readNamespace",
    ]);
  });

  it("fails closed when the dedicated provider connection is unavailable or either namespace is trusted", async () => {
    const unavailable = createManagedDeploymentBroker({
      db: testEnv.DB,
      now: () => 1_900_000_000_000,
      platformAccountId: PLATFORM_ACCOUNT_ID,
      requirePlatformReservation: () =>
        requireActiveManagedPlatformReservation({
          db: testEnv.DB,
          connectionId: PLATFORM_CONNECTION_ID,
          accountId: PLATFORM_ACCOUNT_ID,
        }),
      resolveProvider: async () => {
        throw new Error("platform_connection_absent");
      },
    });
    await expect(unavailable.readiness()).rejects.toThrow(
      "managed_deployment_provider_unavailable",
    );

    await resetSchema();
    const missingReservation = createProvider();
    await expect(
      broker(missingReservation.provider).readiness(),
    ).rejects.toThrow("managed_platform_reservation_required");
    await expect(
      broker(missingReservation.provider).upload(uploadInput()),
    ).rejects.toThrow("managed_platform_reservation_required");
    expect(missingReservation.calls).toEqual([]);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM managed_deployment_operations",
      ).first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });

    await reservePlatform();

    const trusted = createProvider({ trustedProduction: true });
    await expect(broker(trusted.provider).readiness()).rejects.toThrow(
      "managed_deployment_namespace_untrusted_required",
    );
  });

  it("uploads an exact revision with no bindings, verifies provider identity, and audits intent and completion", async () => {
    const fixture = createProvider();
    const service = broker(fixture.provider);

    await expect(service.upload(uploadInput())).resolves.toMatchObject({
      schemaVersion: "shiplet.managed-deployment-proof/v1",
      ...identity(),
      status: "present",
    });
    const upload = fixture.calls.find((call) => call.method === "uploadScript");
    expect(upload?.input).toMatchObject({
      namespace: STAGING,
      scriptName: "shiplet-managed-fixture",
      mainModule: "worker.mjs",
      compatibilityDate: "2026-08-07",
      bindings: [],
    });
    expect(upload?.input.operationTag).toMatch(
      /^shiplet-op-[A-Za-z0-9_-]{43}$/,
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT account_id FROM managed_deployment_operations
         WHERE operation_id = ?`,
      )
        .bind(operation("a"))
        .first<{ account_id: string }>(),
    ).resolves.toEqual({ account_id: PLATFORM_ACCOUNT_ID });

    await expect(
      service.inspect(inspectInput({ operationId: operation("i") })),
    ).resolves.toMatchObject({ status: "present" });
    const audit = await testEnv.DB.prepare(
      `SELECT event_json FROM control_audit_outbox
       WHERE id LIKE 'control_audit_managed_%' ORDER BY created_on, id`,
    ).all<{ event_json: string }>();
    expect(audit.results).toHaveLength(4);
    expect(
      audit.results.map((row) => JSON.parse(row.event_json).outcome).sort(),
    ).toEqual(["acquired", "released", "requested", "success"]);
    expect(JSON.stringify(audit.results)).not.toContain("worker.mjs");
    expect(JSON.stringify(audit.results)).not.toContain("accessToken");
  });

  it("rejects malformed, cross-Shiplet, replayed, or ambient-binding uploads before a provider mutation", async () => {
    const fixture = createProvider();
    const service = broker(fixture.provider);
    await service.upload(uploadInput());
    const before = fixture.calls.filter(
      (call) => call.method === "uploadScript",
    ).length;

    await expect(
      service.upload(uploadInput({ shipletId: "shiplet_other" })),
    ).rejects.toThrow("managed_deployment_operation_conflict");
    await expect(
      service.upload({ ...uploadInput(), bindings: [{ name: "DB" }] } as never),
    ).rejects.toThrow("managed_deployment_request_invalid");
    await expect(
      service.upload(uploadInput({ namespace: "shiplet-managed-other" })),
    ).rejects.toThrow("managed_deployment_request_invalid");
    expect(
      fixture.calls.filter((call) => call.method === "uploadScript"),
    ).toHaveLength(before);
  });

  it("reconciles an upload response lost after commit using the exact operation tag and records success once", async () => {
    const fixture = createProvider({ loseUploadResponse: true });
    const service = broker(fixture.provider);

    await expect(service.upload(uploadInput())).resolves.toMatchObject({
      status: "present",
    });
    expect(
      fixture.calls.filter((call) => call.method === "uploadScript"),
    ).toHaveLength(1);
    await expect(service.upload(uploadInput())).resolves.toMatchObject({
      status: "present",
    });
    expect(
      fixture.calls.filter((call) => call.method === "uploadScript"),
    ).toHaveLength(1);
  });

  it("keeps an ambiguous provider failure fenced, signals reconciliation is required, and recovers without redispatch", async () => {
    let now = 1_900_000_000_000;
    const fixture = createProvider({ failUploadBeforeCommitOnce: true });
    const service = broker(fixture.provider, () => now);

    await expect(service.upload(uploadInput())).rejects.toThrow(
      "managed_deployment_upload_failed",
    );
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: now + 1,
        input: retirementInput(),
      }),
    ).rejects.toThrow("managed_platform_retirement_in_flight");
    await expect(service.upload(uploadInput())).rejects.toThrow(
      "managed_deployment_outcome_ambiguous",
    );
    now += 60_001;
    await expect(service.upload(uploadInput())).rejects.toThrow(
      "managed_deployment_outcome_ambiguous",
    );
    expect(
      fixture.calls.filter((call) => call.method === "uploadScript"),
    ).toHaveLength(1);
    const attempt = await testEnv.DB.prepare(
      `SELECT applying_on FROM managed_deployment_operations
       WHERE operation_id = ? AND status = 'applying'`,
    )
      .bind(operation("a"))
      .first<{ applying_on: string }>();
    expect(attempt?.applying_on).toBeTruthy();
    await expect(
      testEnv.DB.prepare(
        `UPDATE managed_deployment_operations SET applying_on = ?
         WHERE operation_id = ?`,
      )
        .bind(new Date(now + 1).toISOString(), operation("a"))
        .run(),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare(
        `UPDATE managed_platform_operation_leases
         SET status = 'released', released_at = ? WHERE operation_id = ?`,
      )
        .bind(now + 1, operation("a"))
        .run(),
    ).rejects.toThrow();
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: now + 1,
        input: retirementInput(),
      }),
    ).rejects.toThrow("managed_platform_retirement_in_flight");

    fixture.scripts.set(`${STAGING}/shiplet-managed-fixture`, {
      operationTag: `shiplet-op-${"a".repeat(43)}`,
      bindings: [],
    });
    await expect(service.upload(uploadInput())).resolves.toMatchObject({
      status: "present",
    });
    expect(
      fixture.calls.filter((call) => call.method === "uploadScript"),
    ).toHaveLength(1);
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: now + 2,
        input: retirementInput(),
      }),
    ).resolves.toMatchObject({ status: "retired" });
  });

  it("Given an earlier provider attempt is delayed past the apply window, When the operation is retried, Then it is not redispatched and retirement stays fenced", async () => {
    let now = 1_900_000_000_000;
    let uploadCalls = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fixture = createProvider({
      beforeUploadEffect: async () => {
        uploadCalls += 1;
        if (uploadCalls !== 1) return;
        markFirstStarted();
        await firstReleased;
      },
    });
    const service = broker(fixture.provider, () => now);

    const first = service.upload(uploadInput());
    await firstStarted;
    now += 60_001;

    await expect(service.upload(uploadInput())).rejects.toThrow(
      "managed_deployment_outcome_ambiguous",
    );
    expect(uploadCalls).toBe(1);
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: now + 1,
        input: retirementInput(),
      }),
    ).rejects.toThrow("managed_platform_retirement_in_flight");

    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "present" });
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: now + 2,
        input: retirementInput(),
      }),
    ).resolves.toMatchObject({ status: "retired" });
  });

  it("Given retirement wins before a provider mutation claim, When upload resumes, Then no provider effect can occur", async () => {
    let inspected = false;
    const fixture = createProvider({
      beforeAbsentInspectionReturns: async () => {
        if (inspected) return;
        inspected = true;
        await retireManagedPlatformConnection({
          db: testEnv.DB,
          now: 1_900_000_000_001,
          input: retirementInput(),
        });
      },
    });

    await expect(
      broker(fixture.provider).upload(uploadInput()),
    ).rejects.toThrow("managed_platform_reservation_required");
    expect(
      fixture.calls.filter((call) => call.method === "uploadScript"),
    ).toHaveLength(0);
    await expect(
      requireActiveManagedPlatformReservation({
        db: testEnv.DB,
        connectionId: PLATFORM_CONNECTION_ID,
        accountId: PLATFORM_ACCOUNT_ID,
      }),
    ).rejects.toThrow("managed_platform_reservation_required");
  });

  it("Given a provider mutation owns a durable lease, When retirement races at the effect boundary, Then retirement fails until exact completion releases the lease", async () => {
    let retirementError = "";
    const fixture = createProvider({
      beforeUploadEffect: async () => {
        try {
          await retireManagedPlatformConnection({
            db: testEnv.DB,
            now: 1_900_000_000_001,
            input: retirementInput(),
          });
        } catch (error) {
          retirementError = error instanceof Error ? error.message : "unknown";
        }
      },
    });

    await expect(
      broker(fixture.provider).upload(uploadInput()),
    ).resolves.toMatchObject({
      status: "present",
    });
    expect(retirementError).toBe("managed_platform_retirement_in_flight");
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: 1_900_000_000_002,
        input: retirementInput(),
      }),
    ).resolves.toMatchObject({ status: "retired" });

    const leases = await testEnv.DB.prepare(
      `SELECT operation_id, reservation_operation_id, status
       FROM managed_platform_operation_leases`,
    ).all();
    expect(leases.results).toEqual([
      {
        operation_id: operation("a"),
        reservation_operation_id: reservationOperation("r"),
        status: "released",
      },
    ]);
    const authorityAudit = await testEnv.DB.prepare(
      `SELECT event_json FROM control_audit_outbox
       WHERE event_json LIKE '%managed_deployment.authority_%'
       ORDER BY id`,
    ).all<{ event_json: string }>();
    expect(
      authorityAudit.results
        .map((row) => JSON.parse(row.event_json).outcome)
        .sort(),
    ).toEqual(["acquired", "released"]);
  });

  it("refuses to prove a script with a copied name but wrong operation tag or any ambient binding", async () => {
    const fixture = createProvider();
    const service = broker(fixture.provider);
    await service.upload(uploadInput());
    const key = `${STAGING}/shiplet-managed-fixture`;
    fixture.scripts.set(key, {
      operationTag: `shiplet-op-${"z".repeat(43)}`,
      bindings: [],
    });
    await expect(
      service.inspect(inspectInput({ operationId: operation("i") })),
    ).rejects.toThrow("managed_deployment_identity_mismatch");

    fixture.scripts.set(key, {
      operationTag: `shiplet-op-${"a".repeat(43)}`,
      bindings: [{ name: "SHARED_DB", type: "d1" }],
    });
    await expect(
      service.inspect(inspectInput({ operationId: operation("j") })),
    ).rejects.toThrow("managed_deployment_ambient_binding_detected");
  });

  it("deletes only an exactly owned script and reconciles a lost provider response", async () => {
    const fixture = createProvider({ loseDeleteResponse: true });
    const service = broker(fixture.provider);
    await service.upload(uploadInput());

    await expect(service.delete(deleteInput())).resolves.toMatchObject({
      ...identity({ operationId: operation("d") }),
      status: "absent",
    });
    expect(
      fixture.calls.filter((call) => call.method === "deleteScript"),
    ).toHaveLength(1);
    await expect(service.delete(deleteInput())).resolves.toMatchObject({
      status: "absent",
    });
    expect(
      fixture.calls.filter((call) => call.method === "deleteScript"),
    ).toHaveLength(1);
  });

  it("will not delete an untracked script even when every caller-supplied identifier is guessed", async () => {
    const fixture = createProvider();
    fixture.scripts.set(`${STAGING}/shiplet-managed-fixture`, {
      operationTag: `shiplet-op-${"a".repeat(43)}`,
      bindings: [],
    });
    await expect(
      broker(fixture.provider).delete(deleteInput()),
    ).rejects.toThrow("managed_deployment_unowned");
    expect(
      fixture.calls.filter((call) => call.method === "deleteScript"),
    ).toHaveLength(0);
  });
});

describe("managed platform connection purpose reservation", () => {
  beforeEach(resetSchema);

  it("persists and audits one exact reservation idempotently without credential material", async () => {
    await expect(reservePlatform()).resolves.toEqual({
      schemaVersion: "shiplet.managed-platform-reservation-proof/v1",
      operationId: reservationOperation("r"),
      purpose: "managed_wfp_provider",
      connectionId: PLATFORM_CONNECTION_ID,
      accountId: PLATFORM_ACCOUNT_ID,
      ownerUserId: PLATFORM_USER_ID,
      status: "active",
      reservedAt: 1_900_000_000_000,
    });
    await expect(reservePlatform()).resolves.toMatchObject({
      status: "active",
    });

    const rows = await testEnv.DB.prepare(
      `SELECT operation_id, purpose, connection_id, account_id, user_id, status
       FROM managed_platform_connection_reservations`,
    ).all();
    expect(rows.results).toEqual([
      {
        operation_id: reservationOperation("r"),
        purpose: "managed_wfp_provider",
        connection_id: PLATFORM_CONNECTION_ID,
        account_id: PLATFORM_ACCOUNT_ID,
        user_id: PLATFORM_USER_ID,
        status: "active",
      },
    ]);
    const audit = await testEnv.DB.prepare(
      `SELECT event_json FROM control_audit_outbox
       WHERE id LIKE 'control_audit_platform_reservation_%'`,
    ).all<{ event_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0]!.event_json)).toEqual({
      eventKind: "cloudflare.managed_platform_connection.reserved",
      actorKind: "human",
      actorId: PLATFORM_USER_ID,
      connectionId: PLATFORM_CONNECTION_ID,
      accountId: PLATFORM_ACCOUNT_ID,
      targetId: reservationOperation("r"),
      outcome: "success",
      reason: "managed_wfp_provider",
      occurredAt: 1_900_000_000_000,
    });
    expect(
      JSON.stringify({ rows: rows.results, audit: audit.results }),
    ).not.toMatch(/credential|access.?token|refresh.?token/i);
  });

  it("lets the kernel-bound OAuth RPC reserve only the configured captured public connection without vault access", async () => {
    const release = {
      versionId: "00000000-0000-4000-8000-000000000009",
      versionTag: "managed-platform-reservation-fixture",
    };
    const expiresAt = Date.now() + 60_000;
    await testEnv.DB.prepare(
      `INSERT INTO cloudflare_connections (
        id, user_id, account_id, account_label, scopes_json, credential_ref,
        expires_at, status, revoked_at, generation, created_on, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, NULL)`,
    )
      .bind(
        PLATFORM_CONNECTION_ID,
        PLATFORM_USER_ID,
        PLATFORM_ACCOUNT_ID,
        "Shiplet managed platform",
        JSON.stringify([
          "offline_access",
          "workers.scripts.read",
          "workers.scripts.write",
        ]),
        "opaque_vault_reference",
        expiresAt,
        new Date().toISOString(),
      )
      .run();
    const rpc = new CloudflareOAuthControlPlane(createExecutionContext(), {
      CONTROL_DB: testEnv.DB,
      WFP_PLATFORM_CONNECTION_ID: PLATFORM_CONNECTION_ID,
      WFP_PLATFORM_ACCOUNT_ID: PLATFORM_ACCOUNT_ID,
      CF_VERSION_METADATA: {
        id: release.versionId,
        tag: release.versionTag,
      },
    } as ControlPlaneEnv);

    await expect(
      rpc.reservePlatformConnection(reservationInput(), release),
    ).resolves.toMatchObject({
      operationId: reservationOperation("r"),
      connectionId: PLATFORM_CONNECTION_ID,
      accountId: PLATFORM_ACCOUNT_ID,
      ownerUserId: PLATFORM_USER_ID,
      purpose: "managed_wfp_provider",
      status: "active",
    });
    await expect(
      rpc.reservePlatformConnection(
        reservationInput({
          actor: { kind: "human", id: "user_other" },
          operationId: reservationOperation("s"),
        }),
        release,
      ),
    ).rejects.toThrow("managed_platform_reservation_denied");
  });

  it("returns only a frozen value-free proof for the exact support release and active fixed reservation", async () => {
    await reservePlatform();
    const release = {
      versionId: "00000000-0000-4000-8000-000000000009",
      versionTag: "managed-platform-reservation-fixture",
    };
    const rpc = new CloudflareManagedDeploymentBrokerRpc(
      createExecutionContext(),
      {
        CONTROL_DB: testEnv.DB,
        WFP_PLATFORM_CONNECTION_ID: PLATFORM_CONNECTION_ID,
        WFP_PLATFORM_ACCOUNT_ID: PLATFORM_ACCOUNT_ID,
        CF_VERSION_METADATA: {
          id: release.versionId,
          tag: release.versionTag,
        },
      } as ControlPlaneEnv,
    ) as CloudflareManagedDeploymentBrokerRpc & {
      assertPlatformReservation(
        expectation: typeof release,
      ): Promise<Readonly<{ ok: true }>>;
    };

    const proof = await rpc.assertPlatformReservation(release);
    expect(proof).toEqual({ ok: true });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.keys(proof)).toEqual(["ok"]);
    await expect(
      rpc.assertPlatformReservation({
        ...release,
        versionTag: "wrong-release",
      }),
    ).rejects.toThrow("support_release_mismatch");

    await retireManagedPlatformConnection({
      db: testEnv.DB,
      now: 1_900_000_000_001,
      input: retirementInput(),
    });
    await expect(rpc.assertPlatformReservation(release)).rejects.toThrow(
      "managed_platform_reservation_required",
    );
  });

  it.each([
    [
      "replayed operation for another connection",
      { connectionId: "cloudflare_connection_other" },
    ],
    ["replayed operation for another account", { accountId: "account_other" }],
    [
      "replayed operation for another user",
      { actor: { kind: "human", id: "user_other" } },
    ],
    [
      "second operation for the reserved connection",
      { operationId: reservationOperation("s") },
    ],
  ])("fails closed for %s", async (_label, override) => {
    await reservePlatform();
    await expect(reservePlatform(override)).rejects.toThrow(
      "managed_platform_reservation_conflict",
    );
  });

  it("requires the exact active reservation and makes its binding immutable", async () => {
    await reservePlatform();
    await expect(
      requireActiveManagedPlatformReservation({
        db: testEnv.DB,
        connectionId: PLATFORM_CONNECTION_ID,
        accountId: PLATFORM_ACCOUNT_ID,
        ownerUserId: PLATFORM_USER_ID,
      }),
    ).resolves.toMatchObject({
      operationId: reservationOperation("r"),
      connectionId: PLATFORM_CONNECTION_ID,
      accountId: PLATFORM_ACCOUNT_ID,
      ownerUserId: PLATFORM_USER_ID,
      purpose: "managed_wfp_provider",
      status: "active",
    });
    await expect(
      requireActiveManagedPlatformReservation({
        db: testEnv.DB,
        connectionId: PLATFORM_CONNECTION_ID,
        accountId: "account_other",
      }),
    ).rejects.toThrow("managed_platform_reservation_required");
    await expect(
      testEnv.DB.prepare(
        `UPDATE managed_platform_connection_reservations
         SET account_id = ? WHERE connection_id = ?`,
      )
        .bind("account_other", PLATFORM_CONNECTION_ID)
        .run(),
    ).rejects.toThrow();
    await expect(
      testEnv.DB.prepare(
        `DELETE FROM managed_platform_connection_reservations
         WHERE connection_id = ?`,
      )
        .bind(PLATFORM_CONNECTION_ID)
        .run(),
    ).rejects.toThrow();
  });

  it("denies both real customer entrypoints before OAuth runtime or provider access", async () => {
    await reservePlatform();
    const release = {
      versionId: "00000000-0000-4000-8000-000000000009",
      versionTag: "managed-platform-reservation-fixture",
    };
    const runtimeEnv = {
      CONTROL_DB: testEnv.DB,
      CF_VERSION_METADATA: {
        id: release.versionId,
        tag: release.versionTag,
      },
    } as ControlPlaneEnv;
    const oauth = new CloudflareOAuthControlPlane(
      createExecutionContext(),
      runtimeEnv,
    );
    await expect(
      oauth.revoke(
        {
          actor: { kind: "human", id: PLATFORM_USER_ID },
          connectionId: PLATFORM_CONNECTION_ID,
          sessionBinding: "a".repeat(64),
        },
        release,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "oauth_connection_reserved_for_managed_platform",
    });
    await expect(
      oauth.revoke(
        {
          actor: { kind: "human", id: "user_other" },
          connectionId: PLATFORM_CONNECTION_ID,
          sessionBinding: "b".repeat(64),
        },
        release,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "oauth_revoke_binding_invalid",
    });

    const customerOperation = vi.fn();
    const grant = new CloudflareGrantVaultRpc(
      createExecutionContext(),
      runtimeEnv,
    );
    await expect(
      grant.withGrant(
        {
          handle: `control-plane:${PLATFORM_CONNECTION_ID}`,
          userId: PLATFORM_USER_ID,
        } as never,
        customerOperation,
        release,
      ),
    ).rejects.toThrow("cloudflare_grant_reserved_for_managed_platform");
    expect(customerOperation).not.toHaveBeenCalled();
    await expect(
      grant.withGrant(
        {
          handle: `control-plane:${PLATFORM_CONNECTION_ID}`,
          userId: "user_other",
        } as never,
        customerOperation,
        release,
      ),
    ).rejects.toThrow("cloudflare_grant_denied");

    await expect(
      assertManagedPlatformCustomerOperationAllowed({
        db: testEnv.DB,
        connectionId: PLATFORM_CONNECTION_ID,
        ownerUserId: PLATFORM_USER_ID,
        operation: "customer_revoke",
      }),
    ).rejects.toThrow("oauth_connection_reserved_for_managed_platform");
  });
});

describe("managed platform OAuth connection authorization", () => {
  const connection = {
    id: "cloudflare_connection_platform",
    userId: "user_platform_owner",
    accountId: "account_fixture",
    accountLabel: "Shiplet platform",
    scopes: ["offline_access", "workers.scripts.read", "workers.scripts.write"],
    credentialRef: "credential_ref_opaque",
    expiresAt: 1_900_000_060_000,
    status: "active" as const,
    generation: 4,
  };

  it("authorizes only the exact configured dedicated connection and account with least privilege", () => {
    expect(
      authorizeManagedPlatformConnection({
        configuredConnectionId: connection.id,
        configuredAccountId: connection.accountId,
        connection,
        now: 1_900_000_000_000,
      }),
    ).toEqual({
      connectionId: connection.id,
      ownerUserId: connection.userId,
      accountId: connection.accountId,
      credentialRef: connection.credentialRef,
      generation: 4,
    });
  });

  it.each([
    ["missing configuration", { configuredConnectionId: "" }],
    ["wrong account", { configuredAccountId: "account_other" }],
    ["revoked", { connection: { ...connection, status: "revoked" } }],
    ["expired", { now: connection.expiresAt }],
    [
      "missing scope",
      {
        connection: {
          ...connection,
          scopes: ["workers.scripts.read", "workers.scripts.write"],
        },
      },
    ],
    [
      "expanded scope",
      {
        connection: {
          ...connection,
          scopes: [...connection.scopes, "account.settings.write"],
        },
      },
    ],
  ])("fails closed for %s", (_label, override) => {
    expect(() =>
      authorizeManagedPlatformConnection({
        configuredConnectionId: connection.id,
        configuredAccountId: connection.accountId,
        connection,
        now: 1_900_000_000_000,
        ...override,
      }),
    ).toThrow("managed_platform_connection_denied");
  });
});

describe("Cloudflare WFP provider transport", () => {
  it("uses only exact account/namespace/script routes, strict multipart metadata, and zero bindings", async () => {
    const requests: Request[] = [];
    const authorizedFetch = vi.fn(async (request: Request) => {
      requests.push(request.clone() as unknown as Request);
      const url = new URL(request.url);
      if (request.method === "PUT") {
        return Response.json({
          success: true,
          result: { id: "shiplet-managed-fixture" },
        });
      }
      if (url.pathname.endsWith("/tags")) {
        return Response.json({
          success: true,
          result: [`shiplet-op-${"a".repeat(43)}`],
        });
      }
      if (url.pathname.endsWith("/settings")) {
        return Response.json({ success: true, result: { bindings: [] } });
      }
      return Response.json({
        success: true,
        result: {
          dispatch_namespace: STAGING,
          script: { id: "shiplet-managed-fixture" },
        },
      });
    });
    const transport = createCloudflareManagedDeploymentTransport({
      accountId: "account_fixture",
      authorizedFetch,
    });

    await transport.uploadScript({
      namespace: STAGING,
      scriptName: "shiplet-managed-fixture",
      operationTag: `shiplet-op-${"a".repeat(43)}`,
      mainModule: "worker.mjs",
      compatibilityDate: "2026-08-07",
      modules: uploadInput().modules,
      bindings: [],
    });
    await expect(
      transport.inspectScript({
        namespace: STAGING,
        scriptName: "shiplet-managed-fixture",
      }),
    ).resolves.toEqual({
      status: "present",
      operationTag: `shiplet-op-${"a".repeat(43)}`,
      bindings: [],
    });

    const uploaded = requests.find((request) => request.method === "PUT");
    expect(uploaded).toBeDefined();
    expect(new URL(uploaded!.url).pathname).toBe(
      "/client/v4/accounts/account_fixture/workers/dispatch/namespaces/shiplet-managed-staging/scripts/shiplet-managed-fixture",
    );
    expect(new URL(uploaded!.url).searchParams.get("bindings_inherit")).toBe(
      "strict",
    );
    const form = await uploaded!.formData();
    const metadata = JSON.parse(await (form.get("metadata") as File).text());
    expect(metadata).toEqual({
      main_module: "worker.mjs",
      compatibility_date: "2026-08-07",
      bindings: [],
      tags: [`shiplet-op-${"a".repeat(43)}`],
    });
    expect(form.get("worker.mjs")).toBeInstanceOf(File);
    expect(form.get("unexpected")).toBeNull();
    expect(requests.every((request) => request.redirect === "manual")).toBe(
      true,
    );
  });
});
