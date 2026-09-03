import { env as testEnv } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error Vite supplies the migration source text.
import managedRuntimeMigration from "../workers/managed-runtime-gateway/migrations/0001_managed_runtime.sql?raw";
// @ts-expect-error Vite supplies the migration source text.
import activationFenceMigration from "../workers/managed-runtime-gateway/migrations/0002_activation_operation_fence.sql?raw";
// @ts-expect-error Vite supplies the migration source text.
import managedStateMigration from "../workers/managed-runtime-gateway/migrations/0003_namespaced_state.sql?raw";
// @ts-expect-error Vite supplies the migration source text.
import atomicStateMigration from "../workers/managed-runtime-gateway/migrations/0004_atomic_state_and_stage_lease.sql?raw";
import {
  ensureManagedRuntimeStateNamespace,
  handleManagedRuntimeStateRequest,
  type ManagedRuntimeStateRequestContext,
} from "../src/managed-runtime/state";

/*
Behavioral specification

Given an active immutable managed revision whose package explicitly requested
state capabilities, when its generated helper makes a request through the WFP
outbound mediator, then the trusted gateway derives the Shiplet namespace and
actor itself, enforces the declared read/write mode, persists only bounded JSON,
and records an immutable operation attribution without exposing RUNTIME_DB.

Given a preview, stale revision/generation, guessed sibling namespace, malformed
request, or replayed invocation sequence, when state is requested, then the
gateway fails closed without changing any namespace.

Given a namespace at its key, value, or byte quota, when a write would exceed a
limit, then the entire write and operation record are rejected atomically while
the previously committed state remains readable.

Given activation changes immediately after the gateway observes the prior
active tuple, when an active invocation attempts a read or mutation, then the
effect and its audit must still be atomically fenced by the exact revision,
package digest, and generation.

Given remote activation is pending main acknowledgement, when the trusted main
kernel presents the exact prior or candidate tuple, then both retain their
declared active state authority. A third tuple is denied, and once the exact
acknowledgement closes the pending operation only the candidate remains valid.
*/

const PACKAGE_A = `sha256:${"a".repeat(64)}`;
const PACKAGE_B = `sha256:${"b".repeat(64)}`;
const NAMESPACE_A = "state-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NAMESPACE_B = "state-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const runtimeTestEnv = testEnv as { DB: D1Database };

function migrationStatements(sql: string) {
  const statements: string[] = [];
  let current = "";
  let trigger = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!current && (!trimmed || trimmed.startsWith("--"))) continue;
    current += `${line}\n`;
    if (/^CREATE\s+TRIGGER\b/i.test(trimmed)) trigger = true;
    if (
      (trigger && /^END;$/i.test(trimmed)) ||
      (!trigger && trimmed.endsWith(";"))
    ) {
      statements.push(current.trim());
      current = "";
      trigger = false;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function resetSchema() {
  for (const table of [
    "managed_runtime_state_operations",
    "managed_runtime_state_entries",
    "managed_runtime_state_namespaces",
    "managed_activation_history",
    "managed_activations",
    "managed_revisions",
  ]) {
    await runtimeTestEnv.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const statement of migrationStatements(managedRuntimeMigration)) {
    await runtimeTestEnv.DB.prepare(statement).run();
  }
  for (const statement of migrationStatements(activationFenceMigration)) {
    await runtimeTestEnv.DB.prepare(statement).run();
  }
  for (const statement of migrationStatements(managedStateMigration)) {
    await runtimeTestEnv.DB.prepare(statement).run();
  }
  for (const statement of migrationStatements(atomicStateMigration)) {
    await runtimeTestEnv.DB.prepare(statement).run();
  }
}

async function seedRevision(input: {
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  namespace: string;
  permissions: readonly ("read" | "write")[];
  activeGeneration?: number;
  revisionNamespace?: string;
}) {
  await runtimeTestEnv.DB.prepare(
    `INSERT INTO managed_revisions (
       shiplet_id, revision_id, package_digest, script_name, state_namespace,
       state_scope_namespace, state_permissions_json, policy_json, stage_status,
       staged_on, validated_on
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validated', ?, ?)`,
  )
    .bind(
      input.shipletId,
      input.revisionId,
      input.packageDigest,
      `script-${input.revisionId}`,
      input.revisionNamespace ?? input.namespace,
      input.namespace,
      JSON.stringify(input.permissions),
      JSON.stringify({ cpuMs: 25, subRequests: 8 }),
      "2026-08-10T00:00:00.000Z",
      "2026-08-10T00:00:01.000Z",
    )
    .run();
  await ensureManagedRuntimeStateNamespace({
    db: runtimeTestEnv.DB,
    stateNamespace: input.namespace,
    shipletId: input.shipletId,
  });
  if (input.activeGeneration !== undefined) {
    await runtimeTestEnv.DB.prepare(
      `INSERT INTO managed_activations (
         shiplet_id, revision_id, package_digest, script_name, generation,
         activated_on, operation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.shipletId,
        input.revisionId,
        input.packageDigest,
        `script-${input.revisionId}`,
        input.activeGeneration,
        "2026-08-10T00:00:02.000Z",
        `managed_fixture_${input.shipletId}`,
      )
      .run();
  }
}

function context(
  input: Partial<ManagedRuntimeStateRequestContext> = {},
): ManagedRuntimeStateRequestContext {
  return {
    schemaVersion: "shiplet.managed-state-context/v1",
    shipletId: "shiplet_a",
    revisionId: "revision_a",
    packageDigest: PACKAGE_A,
    activationGeneration: 3,
    stateNamespace: NAMESPACE_A,
    stateMode: "read_write",
    invocationKind: "active",
    invocationId: `invocation_${crypto.randomUUID()}`,
    actor: { kind: "shiplet", id: "shiplet_a" },
    ...input,
  };
}

function request(
  body: Record<string, unknown>,
  init: Omit<RequestInit, "body"> = {},
) {
  return new Request("https://shiplet-state.invalid/v1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "shiplet.managed-state-request/v1",
      ...body,
    }),
    ...init,
  });
}

async function state(
  requestValue: Request,
  contextValue: ManagedRuntimeStateRequestContext,
  db: Pick<D1Database, "prepare" | "batch"> = runtimeTestEnv.DB,
) {
  return handleManagedRuntimeStateRequest({
    db,
    request: requestValue,
    context: contextValue,
  });
}

function activationInterleavingDatabase(changeActivation: () => Promise<void>) {
  let changed = false;
  const interleaveAfterFirst = (statement: D1PreparedStatement) =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "first") {
          return async <T>(columnName?: string) => {
            const result =
              columnName === undefined
                ? await target.first<T>()
                : await target.first<T>(columnName);
            if (!changed) {
              changed = true;
              await changeActivation();
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return {
    prepare(query: string) {
      const statement = runtimeTestEnv.DB.prepare(query);
      if (!query.includes("FROM managed_activations")) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) =>
              interleaveAfterFirst(target.bind(...values));
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      return runtimeTestEnv.DB.batch<T>(statements);
    },
  } satisfies Pick<D1Database, "prepare" | "batch">;
}

beforeEach(async () => {
  await resetSchema();
  await seedRevision({
    shipletId: "shiplet_a",
    revisionId: "revision_a",
    packageDigest: PACKAGE_A,
    namespace: NAMESPACE_A,
    permissions: ["read", "write"],
    activeGeneration: 3,
  });
  await seedRevision({
    shipletId: "shiplet_b",
    revisionId: "revision_b",
    packageDigest: PACKAGE_B,
    namespace: NAMESPACE_B,
    permissions: ["read", "write"],
    activeGeneration: 5,
  });
});

describe("managed runtime namespaced state authority", () => {
  it("Given exact active write authority, When put/get/delete run, Then values are Shiplet-scoped and every effect is attributed without storing value content in audit", async () => {
    const invocation = context({ invocationId: "invocation_state_lifecycle" });
    const put = await state(
      request({
        operation: "put",
        sequence: 1,
        key: "counter",
        value: { n: 1 },
      }),
      invocation,
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({
      schemaVersion: "shiplet.managed-state-response/v1",
      ok: true,
      operation: "put",
      version: 1,
    });

    const get = await state(
      request({ operation: "get", sequence: 2, key: "counter" }),
      invocation,
    );
    await expect(get.json()).resolves.toEqual({
      schemaVersion: "shiplet.managed-state-response/v1",
      ok: true,
      operation: "get",
      found: true,
      value: { n: 1 },
      version: 1,
    });

    const deleted = await state(
      request({ operation: "delete", sequence: 3, key: "counter" }),
      invocation,
    );
    await expect(deleted.json()).resolves.toEqual({
      schemaVersion: "shiplet.managed-state-response/v1",
      ok: true,
      operation: "delete",
      deleted: true,
    });

    const operations = await runtimeTestEnv.DB.prepare(
      `SELECT actor_kind, actor_id, shiplet_id, revision_id,
              activation_generation, effect, outcome, key_digest
       FROM managed_runtime_state_operations ORDER BY sequence`,
    ).all<Record<string, unknown>>();
    expect(operations.results).toEqual([
      expect.objectContaining({
        actor_kind: "shiplet",
        actor_id: "shiplet_a",
        shiplet_id: "shiplet_a",
        revision_id: "revision_a",
        activation_generation: 3,
        effect: "write",
        outcome: "applied",
      }),
      expect.objectContaining({ effect: "read", outcome: "hit" }),
      expect.objectContaining({ effect: "write", outcome: "applied" }),
    ]);
    expect(JSON.stringify(operations.results)).not.toContain("counter");
    expect(JSON.stringify(operations.results)).not.toContain('"n":1');
    await expect(
      runtimeTestEnv.DB.prepare(
        "UPDATE managed_runtime_state_operations SET outcome = 'missing'",
      ).run(),
    ).rejects.toThrow();
    await expect(
      runtimeTestEnv.DB.prepare(
        "DELETE FROM managed_runtime_state_operations",
      ).run(),
    ).rejects.toThrow();
  });

  it("Given a sibling guess in path, body, or trusted context, When state is requested, Then no sibling row is read or mutated", async () => {
    await state(
      request({ operation: "put", sequence: 1, key: "private", value: "b" }),
      context({
        shipletId: "shiplet_b",
        revisionId: "revision_b",
        packageDigest: PACKAGE_B,
        activationGeneration: 5,
        stateNamespace: NAMESPACE_B,
        invocationId: "invocation_seed_b",
        actor: { kind: "shiplet", id: "shiplet_b" },
      }),
    );

    for (const hostile of [
      request({
        operation: "get",
        sequence: 1,
        key: "private",
        stateNamespace: NAMESPACE_B,
      }),
      new Request("https://shiplet-state.invalid/v1/sibling", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: "shiplet.managed-state-request/v1",
          operation: "get",
          sequence: 1,
          key: "private",
        }),
      }),
    ]) {
      const response = await state(hostile, context());
      expect(response.status).toBe(403);
    }
    const forged = await state(
      request({ operation: "get", sequence: 1, key: "private" }),
      context({ stateNamespace: NAMESPACE_B }),
    );
    expect(forged.status).toBe(403);
    const guessedSiblingKey = await state(
      request({ operation: "get", sequence: 1, key: "private" }),
      context({ invocationId: "invocation_sibling_key_guess" }),
    );
    expect(guessedSiblingKey.status).toBe(200);
    await expect(guessedSiblingKey.json()).resolves.toMatchObject({
      ok: true,
      found: false,
    });

    const sibling = await runtimeTestEnv.DB.prepare(
      `SELECT value_json FROM managed_runtime_state_entries
       WHERE state_namespace = ? AND state_key = ?`,
    )
      .bind(NAMESPACE_B, "private")
      .first<{ value_json: string }>();
    expect(sibling?.value_json).toBe('"b"');
  });

  it("Given stale revision, digest, generation, actor, preview write, or undeclared mode, When state is requested, Then authority fails closed", async () => {
    const candidates: ManagedRuntimeStateRequestContext[] = [
      context({ revisionId: "revision_stale" }),
      context({ packageDigest: PACKAGE_B }),
      context({ activationGeneration: 4 }),
      context({ actor: { kind: "shiplet", id: "shiplet_b" } }),
      context({ invocationKind: "preview" }),
      context({ stateMode: "none" }),
    ];
    for (const [index, candidate] of candidates.entries()) {
      const response = await state(
        request({ operation: "put", sequence: 1, key: "denied", value: index }),
        candidate,
      );
      expect(response.status).toBe(403);
    }
    await expect(
      runtimeTestEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM managed_runtime_state_entries WHERE state_namespace = ?",
      )
        .bind(NAMESPACE_A)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("Given a pending remote activation, When prior, candidate, stale, and acknowledged tuples reach state, Then authority follows only the exact main-selected transition tuple", async () => {
    await seedRevision({
      shipletId: "shiplet_a",
      revisionId: "revision_next",
      packageDigest: PACKAGE_B,
      namespace: NAMESPACE_A,
      revisionNamespace: "state-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      permissions: ["read", "write"],
    });
    const pendingOperationId = "managed_pending_state_activation";
    await runtimeTestEnv.DB.batch([
      runtimeTestEnv.DB.prepare(
        `INSERT INTO managed_activation_history (
           id, shiplet_id, from_revision_id, to_revision_id,
           from_generation, to_generation, actor_id, reason, occurred_on
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'promote', ?)`,
      ).bind(
        pendingOperationId,
        "shiplet_a",
        "revision_a",
        "revision_next",
        3,
        4,
        "actor_state_transition",
        "2026-08-10T00:00:03.000Z",
      ),
      runtimeTestEnv.DB.prepare(
        `UPDATE managed_activations
         SET revision_id = ?, package_digest = ?, script_name = ?,
             generation = ?, operation_id = ?
         WHERE shiplet_id = ? AND generation = ?`,
      ).bind(
        "revision_next",
        PACKAGE_B,
        "script-revision_next",
        4,
        pendingOperationId,
        "shiplet_a",
        3,
      ),
    ]);

    const prior = context({
      invocationId: "invocation_pending_prior",
    });
    const candidate = context({
      revisionId: "revision_next",
      packageDigest: PACKAGE_B,
      activationGeneration: 4,
      invocationId: "invocation_pending_candidate",
    });
    for (const [selected, prefix] of [
      [prior, "prior"],
      [candidate, "candidate"],
    ] as const) {
      expect(
        (
          await state(
            request({
              operation: "put",
              sequence: 1,
              key: `${prefix}-write`,
              value: prefix,
            }),
            selected,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await state(
            request({ operation: "get", sequence: 2, key: `${prefix}-write` }),
            selected,
          )
        ).status,
      ).toBe(200);
    }

    const stale = await state(
      request({ operation: "put", sequence: 1, key: "stale", value: true }),
      context({
        activationGeneration: 4,
        invocationId: "invocation_pending_stale",
      }),
    );
    expect(stale.status).toBe(403);

    await runtimeTestEnv.DB.prepare(
      `UPDATE managed_activations SET operation_id = NULL
       WHERE shiplet_id = ? AND operation_id = ?`,
    )
      .bind("shiplet_a", pendingOperationId)
      .run();
    expect(
      (
        await state(
          request({ operation: "get", sequence: 3, key: "prior-write" }),
          prior,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await state(
          request({ operation: "get", sequence: 3, key: "candidate-write" }),
          candidate,
        )
      ).status,
    ).toBe(200);
  });

  it("Given a read-only preview, When it reads exact Shiplet state, Then the read succeeds but write and deletion remain denied", async () => {
    await state(
      request({ operation: "put", sequence: 1, key: "published", value: 7 }),
      context({ invocationId: "invocation_seed_a" }),
    );
    const preview = context({
      invocationKind: "preview",
      stateMode: "read",
      activationGeneration: 1,
      invocationId: "invocation_preview_a",
    });
    const get = await state(
      request({ operation: "get", sequence: 1, key: "published" }),
      preview,
    );
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ found: true, value: 7 });
    for (const operation of ["put", "delete"] as const) {
      const response = await state(
        request({
          operation,
          sequence: operation === "put" ? 2 : 3,
          key: "published",
          ...(operation === "put" ? { value: 8 } : {}),
        }),
        preview,
      );
      expect(response.status).toBe(403);
    }
  });

  it("Given a committed invocation sequence, When replayed with identical or changed payload, Then both replays fail without a second effect", async () => {
    const invocation = context({ invocationId: "invocation_replay_a" });
    expect(
      (
        await state(
          request({ operation: "put", sequence: 1, key: "once", value: 1 }),
          invocation,
        )
      ).status,
    ).toBe(200);
    for (const value of [1, 2]) {
      const replay = await state(
        request({ operation: "put", sequence: 1, key: "once", value }),
        invocation,
      );
      expect(replay.status).toBe(409);
    }
    const entry = await runtimeTestEnv.DB.prepare(
      `SELECT value_json, version FROM managed_runtime_state_entries
       WHERE state_namespace = ? AND state_key = ?`,
    )
      .bind(NAMESPACE_A, "once")
      .first<{ value_json: string; version: number }>();
    expect(entry).toEqual({ value_json: "1", version: 1 });
    await expect(
      runtimeTestEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM managed_runtime_state_operations
         WHERE invocation_id = ? AND sequence = 1`,
      )
        .bind("invocation_replay_a")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it.each(["get", "put"] as const)(
    "Given activation changes after prior authorization, When %s reaches state storage, Then the stale invocation cannot read, mutate, or append audit",
    async (operation) => {
      await seedRevision({
        shipletId: "shiplet_a",
        revisionId: "revision_next",
        packageDigest: PACKAGE_B,
        namespace: NAMESPACE_A,
        revisionNamespace: "state-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        permissions: ["read", "write"],
      });
      await state(
        request({
          operation: "put",
          sequence: 1,
          key: "fenced",
          value: "original",
        }),
        context({ invocationId: "invocation_fence_seed" }),
      );
      const interleavingDb = activationInterleavingDatabase(async () => {
        await runtimeTestEnv.DB.prepare(
          `UPDATE managed_activations
           SET revision_id = ?, package_digest = ?, script_name = ?, generation = 4
           WHERE shiplet_id = ? AND generation = 3`,
        )
          .bind("revision_next", PACKAGE_B, "script-revision_next", "shiplet_a")
          .run();
      });

      const stale = await state(
        request({
          operation,
          sequence: 1,
          key: "fenced",
          ...(operation === "put" ? { value: "stale-write" } : {}),
        }),
        context({ invocationId: `invocation_fence_${operation}` }),
        interleavingDb,
      );

      expect(stale.status).toBe(403);
      const entry = await runtimeTestEnv.DB.prepare(
        `SELECT value_json, version FROM managed_runtime_state_entries
         WHERE state_namespace = ? AND state_key = ?`,
      )
        .bind(NAMESPACE_A, "fenced")
        .first<{ value_json: string; version: number }>();
      expect(entry).toEqual({ value_json: '"original"', version: 1 });
      await expect(
        runtimeTestEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM managed_runtime_state_operations
           WHERE invocation_id = ?`,
        )
          .bind(`invocation_fence_${operation}`)
          .first<{ count: number }>(),
      ).resolves.toEqual({ count: 0 });
    },
  );

  it("Given bounded state quotas, When a value or namespace would exceed them, Then the write and its audit record roll back atomically", async () => {
    const oversized = "x".repeat(32 * 1024);
    const tooLarge = await state(
      request({
        operation: "put",
        sequence: 1,
        key: "oversized",
        value: oversized,
      }),
      context({ invocationId: "invocation_value_limit" }),
    );
    expect(tooLarge.status).toBe(413);

    const chunk = "x".repeat(32 * 1024 - 2);
    for (let index = 0; index < 8; index += 1) {
      const response = await state(
        request({
          operation: "put",
          sequence: index + 1,
          key: `chunk-${index}`,
          value: chunk,
        }),
        context({ invocationId: `invocation_quota_${index}` }),
      );
      expect(response.status).toBe(200);
    }
    const overQuota = await state(
      request({ operation: "put", sequence: 1, key: "chunk-9", value: "x" }),
      context({ invocationId: "invocation_quota_overflow" }),
    );
    expect(overQuota.status).toBe(429);

    const counts = await runtimeTestEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM managed_runtime_state_entries WHERE state_namespace = ?) AS entries,
         (SELECT COUNT(*) FROM managed_runtime_state_operations WHERE invocation_id = ?) AS rejected_audits`,
    )
      .bind(NAMESPACE_A, "invocation_quota_overflow")
      .first<{ entries: number; rejected_audits: number }>();
    expect(counts).toEqual({ entries: 8, rejected_audits: 0 });
  });

  it("Given 128 committed keys, When a 129th key is written, Then the entry ceiling rejects it with zero partial effect", async () => {
    for (let index = 0; index < 128; index += 1) {
      const response = await state(
        request({
          operation: "put",
          sequence: 1,
          key: `entry-${index}`,
          value: index,
        }),
        context({ invocationId: `invocation_entry_limit_${index}` }),
      );
      expect(response.status).toBe(200);
    }
    const rejected = await state(
      request({ operation: "put", sequence: 1, key: "entry-128", value: 128 }),
      context({ invocationId: "invocation_entry_limit_rejected" }),
    );
    expect(rejected.status).toBe(429);
    const counts = await runtimeTestEnv.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM managed_runtime_state_entries
          WHERE state_namespace = ?) AS entries,
         (SELECT COUNT(*) FROM managed_runtime_state_operations
          WHERE invocation_id = ?) AS rejected_audits`,
    )
      .bind(NAMESPACE_A, "invocation_entry_limit_rejected")
      .first<{ entries: number; rejected_audits: number }>();
    expect(counts).toEqual({ entries: 128, rejected_audits: 0 });
  });
});
