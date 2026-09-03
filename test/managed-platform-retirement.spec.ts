import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assertManagedPlatformCustomerOperationAllowed,
  requireActiveManagedPlatformReservation,
  reserveManagedPlatformConnection,
  retireManagedPlatformConnection,
} from "../src/cloudflare-support/managed-deployment-broker";
import { CloudflareOAuthControlPlane } from "../workers/cloudflare-control-plane/index";
import type { ControlPlaneEnv } from "../workers/cloudflare-control-plane/env";
// @ts-expect-error Vite supplies migration source text.
import brokerMigration from "../workers/cloudflare-control-plane/migrations/0008_managed_deployment_broker.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import reservationMigration from "../workers/cloudflare-control-plane/migrations/0009_managed_platform_connection_reservation.sql?raw";
// @ts-expect-error Vite supplies migration source text.
import retirementMigration from "../workers/cloudflare-control-plane/migrations/0010_managed_platform_connection_retirement.sql?raw";

/**
 * Managed platform retirement behavioral specification
 *
 * Given an immutable managed-only OAuth reservation, when its exact human
 * operator explicitly retires that public binding, then broker authority fails
 * closed immediately and the ordinary owner-bound OAuth revoke path becomes
 * available. Retirement is immutable, audited, idempotent, and cannot be
 * forged for another connection, account, operator, or reservation.
 */

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const CONNECTION = "cloudflare_connection_platform";
const ACCOUNT = "account_platform";
const USER = "user_platform_owner";
const RESERVATION_OPERATION = `managed_platform_${"r".repeat(43)}`;
const RETIREMENT_OPERATION = `managed_platform_retire_${"t".repeat(43)}`;

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
  return statements;
}

async function resetSchema() {
  await testEnv.DB.exec(
    `DROP TABLE IF EXISTS managed_platform_operation_leases;
     DROP TABLE IF EXISTS managed_platform_connection_retirements;
     DROP TABLE IF EXISTS managed_platform_connection_reservations;
     DROP TABLE IF EXISTS managed_deployment_operations;
     DROP TABLE IF EXISTS control_audit_outbox;`,
  );
  await testEnv.DB.prepare(
    `CREATE TABLE control_audit_outbox (
       id TEXT PRIMARY KEY,
       event_json TEXT NOT NULL,
       delivery_status TEXT NOT NULL,
       created_on TEXT NOT NULL,
       delivered_on TEXT
     )`,
  ).run();
  for (const migration of [
    brokerMigration,
    reservationMigration,
    retirementMigration,
  ]) {
    for (const statement of migrationStatements(migration)) {
      await testEnv.DB.prepare(statement).run();
    }
  }
}

async function reserve(connectionId = CONNECTION) {
  return reserveManagedPlatformConnection({
    db: testEnv.DB,
    now: 1_900_000_000_000,
    input: {
      schemaVersion: "shiplet.managed-platform-reservation/v1",
      operationId: RESERVATION_OPERATION,
      purpose: "managed_wfp_provider",
      actor: { kind: "human", id: USER },
      connectionId,
      accountId: ACCOUNT,
    },
  });
}

function retirement(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "shiplet.managed-platform-retirement/v1" as const,
    operationId: RETIREMENT_OPERATION,
    purpose: "managed_wfp_provider" as const,
    actor: { kind: "human" as const, id: USER },
    reservationOperationId: RESERVATION_OPERATION,
    connectionId: CONNECTION,
    accountId: ACCOUNT,
    ...overrides,
  };
}

describe("managed platform connection retirement", () => {
  beforeEach(resetSchema);

  it("retires exact broker authority idempotently and permits the owner revoke boundary", async () => {
    await reserve();
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: 1_900_000_010_000,
        input: retirement(),
      }),
    ).resolves.toEqual({
      schemaVersion: "shiplet.managed-platform-retirement-proof/v1",
      operationId: RETIREMENT_OPERATION,
      purpose: "managed_wfp_provider",
      reservationOperationId: RESERVATION_OPERATION,
      connectionId: CONNECTION,
      accountId: ACCOUNT,
      ownerUserId: USER,
      status: "retired",
      retiredAt: 1_900_000_010_000,
    });
    await expect(
      retireManagedPlatformConnection({
        db: testEnv.DB,
        now: 1_900_000_020_000,
        input: retirement(),
      }),
    ).resolves.toMatchObject({ retiredAt: 1_900_000_010_000 });
    await expect(
      requireActiveManagedPlatformReservation({
        db: testEnv.DB,
        connectionId: CONNECTION,
        accountId: ACCOUNT,
      }),
    ).rejects.toThrow("managed_platform_reservation_required");
    await expect(
      assertManagedPlatformCustomerOperationAllowed({
        db: testEnv.DB,
        connectionId: CONNECTION,
        ownerUserId: USER,
        operation: "customer_revoke",
      }),
    ).resolves.toBeUndefined();

    const audit = await testEnv.DB.prepare(
      `SELECT event_json FROM control_audit_outbox
       WHERE event_json LIKE '%cloudflare.managed_platform_connection.retired%'`,
    ).all<{ event_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.event_json).not.toMatch(
      /authorization|bearer|secret|token|credential/i,
    );
  });

  it.each([
    ["wrong operator", { actor: { kind: "human", id: "user_other" } }],
    ["wrong connection", { connectionId: "cloudflare_connection_other" }],
    ["wrong account", { accountId: "account_other" }],
    [
      "wrong reservation",
      { reservationOperationId: `managed_platform_${"x".repeat(43)}` },
    ],
  ])(
    "rejects %s without retirement or audit effect",
    async (_label, override) => {
      await reserve();
      await expect(
        retireManagedPlatformConnection({
          db: testEnv.DB,
          now: 1_900_000_010_000,
          input: retirement(override),
        }),
      ).rejects.toThrow();
      await expect(
        requireActiveManagedPlatformReservation({
          db: testEnv.DB,
          connectionId: CONNECTION,
          accountId: ACCOUNT,
        }),
      ).resolves.toMatchObject({ status: "active" });
      const retirements = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM managed_platform_connection_retirements",
      ).first<{ count: number }>();
      expect(retirements?.count).toBe(0);
    },
  );

  it("exposes retirement only through the exact release-fenced control-plane RPC", async () => {
    await reserve();
    const release = {
      versionId: "00000000-0000-4000-8000-000000000010",
      versionTag: "managed-platform-retirement-fixture",
    };
    const rpc = new CloudflareOAuthControlPlane(createExecutionContext(), {
      CONTROL_DB: testEnv.DB,
      WFP_PLATFORM_CONNECTION_ID: CONNECTION,
      WFP_PLATFORM_ACCOUNT_ID: ACCOUNT,
      CF_VERSION_METADATA: { id: release.versionId, tag: release.versionTag },
    } as ControlPlaneEnv);

    await expect(
      rpc.inspectPlatformConnection(
        {
          schemaVersion: "shiplet.managed-platform-inspection/v1",
          purpose: "managed_wfp_provider",
          actor: { kind: "human", id: USER },
          connectionId: CONNECTION,
          accountId: ACCOUNT,
        },
        release,
      ),
    ).resolves.toMatchObject({
      operationId: RESERVATION_OPERATION,
      status: "active",
    });
    await expect(
      rpc.retirePlatformConnection(retirement(), release),
    ).resolves.toMatchObject({ status: "retired" });
    await expect(
      rpc.inspectPlatformConnection(
        {
          schemaVersion: "shiplet.managed-platform-inspection/v1",
          purpose: "managed_wfp_provider",
          actor: { kind: "human", id: USER },
          connectionId: CONNECTION,
          accountId: ACCOUNT,
        },
        release,
      ),
    ).rejects.toThrow("managed_platform_reservation_required");
    await expect(
      rpc.retirePlatformConnection(
        retirement({
          operationId: `managed_platform_retire_${"u".repeat(43)}`,
        }),
        { ...release, versionId: "00000000-0000-4000-8000-000000000099" },
      ),
    ).rejects.toThrow("support_release_mismatch");
  });
});
