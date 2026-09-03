import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);

function sqlite(databasePath, input) {
  const result = spawnSync("sqlite3", [databasePath], {
    encoding: "utf8",
    input,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("control-plane support migrations are additive and preserve pending OAuth and temporary deployment rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shiplet-control-migration-"));
  const databasePath = join(directory, "control.sqlite");
  try {
    const [
      initial,
      releaseFence,
      temporaryRecovery,
      oauthDelivery,
      exchangeRecovery,
      oauthCrashConsistency,
      supportHealth,
      managedDeploymentBroker,
      managedPlatformReservation,
      managedPlatformRetirement,
      managedProviderAttemptFence,
    ] = await Promise.all([
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0001_control_plane.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0002_oauth_support_release.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0003_temporary_recovery.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0004_oauth_finalization_delivery.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0005_oauth_exchange_recovery.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0006_oauth_crash_consistency.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0007_support_health.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0008_managed_deployment_broker.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0009_managed_platform_connection_reservation.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0010_managed_platform_connection_retirement.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0011_managed_provider_attempt_fence.sql",
          root,
        ),
        "utf8",
      ),
    ]);
    sqlite(databasePath, initial);
    sqlite(
      databasePath,
      `INSERT INTO oauth_flows (
        state_digest, shiplet_id, user_id, session_binding_digest,
        expected_account_id, expires_at, status, connection_id, created_on,
        completed_on, consumed_on
      ) VALUES (
        'state_fixture', 'shiplet_fixture', 'user_fixture', 'session_fixture',
        NULL, 1000, 'pending', NULL, '2026-08-07T00:00:00.000Z', NULL, NULL
      );`,
    );
    sqlite(
      databasePath,
      `INSERT INTO temporary_deployments (
        id, user_id, target_id, revision_id, package_digest, account_id,
        script_name, request_digest, provider_deployment_id,
        provider_version_id, workers_dev_url, authorization_ref, claim_ref,
        account_expires_at, claim_expires_at, status, created_on,
        claim_delivered_on, cleaned_on
      ) VALUES (
        'temporary_fixture', 'user_fixture', 'target_fixture',
        'revision_fixture', 'sha256:fixture', 'account_fixture',
        'shiplet-fixture', 'sha256:request', 'deployment_fixture',
        'version_fixture', 'https://fixture.invalid', NULL, NULL,
        2000, 1500, 'active', '2026-08-07T00:00:00.000Z', NULL, NULL
      );`,
    );
    sqlite(databasePath, releaseFence);
    sqlite(databasePath, temporaryRecovery);
    sqlite(databasePath, oauthDelivery);
    sqlite(databasePath, exchangeRecovery);
    sqlite(databasePath, oauthCrashConsistency);
    sqlite(databasePath, supportHealth);
    sqlite(databasePath, managedDeploymentBroker);
    sqlite(databasePath, managedPlatformReservation);
    sqlite(databasePath, managedPlatformRetirement);
    sqlite(databasePath, managedProviderAttemptFence);

    const columns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('oauth_flows') ORDER BY cid;",
    ).split("\n");
    assert.deepEqual(columns.slice(-8), [
      "delivery_handle_digest",
      "delivery_expires_at",
      "delivery_result_json",
      "exchange_started_on",
      "exchange_committed_on",
      "exchange_ambiguity_on",
      "return_key",
      "start_reservation_id",
    ]);
    assert.equal(
      sqlite(
        databasePath,
        "SELECT state_digest || '|' || COALESCE(support_version_id, 'null') || '|' || COALESCE(support_version_tag, 'null') FROM oauth_flows;",
      ),
      "state_fixture|null|null",
    );
    assert.equal(
      sqlite(
        databasePath,
        "SELECT id || '|' || COALESCE(shiplet_id, 'null') FROM temporary_deployments;",
      ),
      "temporary_fixture|null",
    );
    const temporaryColumns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('temporary_deployments') ORDER BY cid;",
    ).split("\n");
    for (const column of [
      "shiplet_id",
      "operation_id",
      "delivery_event_id",
      "delivery_started_on",
    ]) {
      assert.equal(temporaryColumns.includes(column), true, column);
    }
    const providerOperationColumns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('temporary_provider_operations') ORDER BY cid;",
    ).split("\n");
    for (const column of [
      "operation_id",
      "shiplet_id",
      "request_digest",
      "state",
      "authorization_ref",
      "claim_ref",
      "ambiguity_expires_at",
    ]) {
      assert.equal(providerOperationColumns.includes(column), true, column);
    }
    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_temporary_deployments_shiplet_scope';",
      ),
      "idx_temporary_deployments_shiplet_scope",
    );
    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_oauth_flows_delivery_handle';",
      ),
      "idx_oauth_flows_delivery_handle",
    );
    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_oauth_flows_exchange_recovery';",
      ),
      "idx_oauth_flows_exchange_recovery",
    );
    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_oauth_flows_return_key';",
      ),
      "idx_oauth_flows_return_key",
    );
    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_provider_exchange_recoveries';",
      ),
      "oauth_provider_exchange_recoveries",
    );
    const exchangeRecoveryColumns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('oauth_provider_exchange_recoveries') ORDER BY cid;",
    ).split("\n");
    for (const column of [
      "connection_id",
      "user_id",
      "account_id",
      "credential_ref",
      "credential_expires_at",
      "status",
      "provider_revoked_on",
      "credential_retired_on",
      "attempt_count",
    ]) {
      assert.equal(exchangeRecoveryColumns.includes(column), true, column);
    }
    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_start_reservations';",
      ),
      "oauth_start_reservations",
    );
    const startReservationColumns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('oauth_start_reservations') ORDER BY cid;",
    ).split("\n");
    for (const column of [
      "id",
      "shiplet_id",
      "user_id",
      "session_binding_digest",
      "delivery_handle_digest",
      "return_key",
      "status",
      "state_digest",
      "expires_at",
    ]) {
      assert.equal(startReservationColumns.includes(column), true, column);
    }
    for (const index of [
      "idx_oauth_flows_start_reservation",
      "idx_oauth_start_reservations_scope_quota",
      "idx_oauth_exchange_recovery_cleanup",
      "idx_oauth_flows_scope_quota",
      "idx_oauth_state_retention",
      "idx_encrypted_record_retention",
    ]) {
      assert.equal(
        sqlite(
          databasePath,
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${index}';`,
        ),
        index,
      );
    }
    for (const table of [
      "credential_continuity",
      "support_reconciliation_runs",
      "managed_deployment_operations",
      "managed_platform_connection_reservations",
      "managed_platform_connection_retirements",
      "managed_platform_operation_leases",
    ]) {
      assert.equal(
        sqlite(
          databasePath,
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}';`,
        ),
        table,
      );
    }
    for (const trigger of [
      "managed_deployment_apply_fence_immutable",
      "managed_platform_operation_lease_terminal_release",
      "managed_platform_retirement_no_dispatched_attempt",
    ]) {
      assert.equal(
        sqlite(
          databasePath,
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = '${trigger}';`,
        ),
        trigger,
      );
    }
    const continuityColumns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('credential_continuity') ORDER BY cid;",
    ).split("\n");
    assert.deepEqual(continuityColumns, [
      "sentinel_id",
      "purpose",
      "nonce",
      "ciphertext",
      "created_on",
    ]);
    const healthColumns = sqlite(
      databasePath,
      "SELECT name FROM pragma_table_info('support_reconciliation_runs') ORDER BY cid;",
    ).split("\n");
    for (const column of [
      "run_id",
      "status",
      "started_at",
      "completed_at",
      "error_code",
      "cleanup_pending",
      "revocation_pending",
      "temporary_ambiguous",
      "temporary_ambiguity_expired",
    ]) {
      assert.equal(healthColumns.includes(column), true, column);
    }
    for (const index of [
      "idx_temporary_deployments_operation",
      "idx_backend_redirects_delivery_event",
      "idx_backend_redirects_deployment_delivery",
      "idx_temporary_provider_operations_recovery",
    ]) {
      assert.equal(
        sqlite(
          databasePath,
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = '${index}';`,
        ),
        index,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-0010 reservation lifecycle remains fail-closed for the previous Worker release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shiplet-managed-rollback-"));
  const databasePath = join(directory, "control.sqlite");
  try {
    const [broker, reservation, retirement] = await Promise.all([
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0008_managed_deployment_broker.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0009_managed_platform_connection_reservation.sql",
          root,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "workers/cloudflare-control-plane/migrations/0010_managed_platform_connection_retirement.sql",
          root,
        ),
        "utf8",
      ),
    ]);
    sqlite(
      databasePath,
      `CREATE TABLE control_audit_outbox (
         id TEXT PRIMARY KEY,
         event_json TEXT NOT NULL,
         delivery_status TEXT NOT NULL,
         created_on TEXT NOT NULL,
         delivered_on TEXT
       );`,
    );
    sqlite(databasePath, broker);
    sqlite(databasePath, reservation);
    sqlite(
      databasePath,
      `INSERT INTO managed_platform_connection_reservations (
         operation_id, purpose, connection_id, account_id, user_id, status,
         reserved_at, created_on
       ) VALUES (
         'managed_platform_${"r".repeat(43)}', 'managed_wfp_provider',
         'cloudflare_connection_legacy', 'account_fixture', 'user_fixture',
         'active', 1900000000000, '2030-03-17T17:46:40.000Z'
       );`,
    );
    sqlite(databasePath, retirement);

    assert.equal(
      sqlite(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_managed_platform_active_purpose';",
      ),
      "idx_managed_platform_active_purpose",
    );
    sqlite(
      databasePath,
      `BEGIN;
       INSERT INTO managed_platform_connection_retirements (
         operation_id, purpose, reservation_operation_id, connection_id,
         account_id, user_id, retired_at, created_on
       ) VALUES (
         'managed_platform_retire_${"t".repeat(43)}', 'managed_wfp_provider',
         'managed_platform_${"r".repeat(43)}', 'cloudflare_connection_legacy',
         'account_fixture', 'user_fixture', 1900000001000,
         '2030-03-17T17:46:41.000Z'
       );
       UPDATE managed_platform_connection_reservations
       SET status = 'retired'
       WHERE operation_id = 'managed_platform_${"r".repeat(43)}'
         AND status = 'active';
       COMMIT;`,
    );

    // This is the previous release's exact authority lookup. It does not know
    // about the retirement table, so the lifecycle row itself must fence it.
    assert.equal(
      sqlite(
        databasePath,
        `SELECT COALESCE((
           SELECT operation_id
           FROM managed_platform_connection_reservations
           WHERE connection_id = 'cloudflare_connection_legacy'
             AND status = 'active'
         ), 'absent');`,
      ),
      "absent",
    );

    sqlite(
      databasePath,
      `INSERT INTO managed_platform_connection_reservations (
         operation_id, purpose, connection_id, account_id, user_id, status,
         reserved_at, created_on
       ) VALUES (
         'managed_platform_${"s".repeat(43)}', 'managed_wfp_provider',
         'cloudflare_connection_successor', 'account_fixture', 'user_fixture',
         'active', 1900000002000, '2030-03-17T17:46:42.000Z'
       );`,
    );
    assert.equal(
      sqlite(
        databasePath,
        `SELECT operation_id || '|' || connection_id
         FROM managed_platform_connection_reservations
         WHERE status = 'active';`,
      ),
      `managed_platform_${"s".repeat(43)}|cloudflare_connection_successor`,
    );
    assert.equal(
      sqlite(
        databasePath,
        `SELECT COALESCE((
           SELECT operation_id
           FROM managed_platform_connection_reservations
           WHERE connection_id = 'cloudflare_connection_legacy'
             AND status = 'active'
         ), 'absent');`,
      ),
      "absent",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("managed-runtime state migrations remain compatible with remote D1 migration ingestion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shiplet-runtime-migration-"));
  const databasePath = join(directory, "runtime.sqlite");
  try {
    const migrations = await Promise.all(
      [
        "0001_managed_runtime.sql",
        "0002_activation_operation_fence.sql",
        "0003_namespaced_state.sql",
        "0004_atomic_state_and_stage_lease.sql",
      ].map((name) =>
        readFile(
          new URL(
            `workers/managed-runtime-gateway/migrations/${name}`,
            root,
          ),
          "utf8",
        ),
      ),
    );

    const stateMigration = migrations[2];
    const triggerBodies = [
      ...stateMigration.matchAll(
        /CREATE\s+TRIGGER[\s\S]*?\bBEGIN\b([\s\S]*?)\nEND;/gi,
      ),
    ].map((match) => match[1]);
    assert.ok(triggerBodies.length > 0, "state migration must install triggers");
    for (const body of triggerBodies) {
      assert.doesNotMatch(
        body,
        /\bCASE\b[\s\S]*?\bEND\s*;/i,
        "remote D1 migration ingestion rejects nested CASE ... END compounds inside a trigger batch",
      );
    }

    for (const migration of migrations) sqlite(databasePath, migration);
    for (const trigger of [
      "managed_runtime_state_entry_insert_quota",
      "managed_runtime_state_entry_update_quota",
      "managed_runtime_state_operations_immutable_update",
      "managed_runtime_state_operations_immutable_delete",
    ]) {
      assert.equal(
        sqlite(
          databasePath,
          `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = '${trigger}';`,
        ),
        trigger,
      );
    }
    assert.deepEqual(
      sqlite(
        databasePath,
        "SELECT name FROM pragma_table_info('managed_revisions') WHERE name IN ('state_scope_namespace', 'state_permissions_json', 'stage_operation_id', 'stage_lease_id', 'stage_lease_expires_on') ORDER BY cid;",
      ).split("\n"),
      [
        "state_scope_namespace",
        "state_permissions_json",
        "stage_operation_id",
        "stage_lease_id",
        "stage_lease_expires_on",
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
