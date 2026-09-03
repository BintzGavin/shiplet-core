import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  abortManagedRuntimeActivation,
  beginManagedRuntimeActivation,
  commitManagedRuntimeActivation,
  ensureManagedRuntimeKernelSchema,
  loadManagedRuntimeActivationTerminal,
  loadManagedRuntimeInvocationBinding,
  markManagedRuntimeActivationDispatching,
  markManagedRuntimeRemoteCommitted,
} from "../src/managed-runtime-kernel";

/**
 * Managed activation saga behavioral specification
 *
 * Given revision B has been staged remotely while revision A is still the
 * canonical active revision, when the remote promotion response commits before
 * the local CAS, then requests keep resolving to A. When the local CAS commits,
 * B is recoverable immediately from the durable operation and the exact final
 * state can be committed idempotently. A sibling Shiplet, revision, digest, or
 * conflicting operation identity must never reuse either binding.
 *
 * Given a provider definitively rejects an activation before committing it,
 * when the same actor terminalizes that prepared operation, then the immutable
 * terminal record releases the Shiplet for a new operation without moving the
 * active pointer. Given instead that the provider response is ambiguous, the
 * operation remains fenced and only the exact operation may reconcile it.
 */

const OWNER = {
  "x-shiplet-user-id": "user_managed_kernel_owner",
  "x-shiplet-user-email": "managed-kernel@example.com",
};

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    env as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function createValidatedCandidate() {
  const organizationResponse = await request("/api/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", ...OWNER },
    body: JSON.stringify({ name: `Managed kernel ${crypto.randomUUID()}` }),
  });
  const organization = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const shipletResponse = await request("/api/shiplets", {
    method: "POST",
    headers: { "content-type": "application/json", ...OWNER },
    body: JSON.stringify({
      name: "Managed kernel fixture",
      organization_id: organization.organization.id,
      subdomain: `managed-kernel-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [{ path: "index.html", content: btoa("managed kernel") }],
    }),
  });
  const shiplet = (await shipletResponse.json()) as {
    project: { id: string };
  };
  const activeResponse = await request(
    `/api/shiplets/${shiplet.project.id}/package`,
    {
      headers: OWNER,
    },
  );
  const active = (await activeResponse.json()) as {
    revision: { id: string };
    package: Record<string, unknown>;
  };
  const forkResponse = await request(
    `/api/shiplets/${shiplet.project.id}/drafts`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({ fromRevisionId: active.revision.id }),
    },
  );
  const fork = (await forkResponse.json()) as {
    draft: { id: string; version: number };
  };
  const validationResponse = await request(
    `/api/drafts/${fork.draft.id}/validate`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...OWNER },
      body: JSON.stringify({ expectedVersion: fork.draft.version }),
    },
  );
  const validation = (await validationResponse.json()) as {
    validation: { revisionId: string };
  };
  const rows = await (env as Env).DB.prepare(
    `SELECT id, package_digest FROM shiplet_revisions
     WHERE project_id = ? AND id IN (?, ?) ORDER BY id`,
  )
    .bind(
      shiplet.project.id,
      active.revision.id,
      validation.validation.revisionId,
    )
    .all<{ id: string; package_digest: string }>();
  const digestByRevision = new Map(
    rows.results.map((row) => [row.id, `sha256:${row.package_digest}`]),
  );
  return {
    projectId: shiplet.project.id,
    priorRevisionId: active.revision.id,
    priorDigest: digestByRevision.get(active.revision.id)!,
    candidateRevisionId: validation.validation.revisionId,
    candidateDigest: digestByRevision.get(validation.validation.revisionId)!,
  };
}

function interleaveBeforeManagedOperationInsert(
  db: D1Database,
  effect: () => Promise<void>,
) {
  let injected = false;
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values));
        }
        if (property === "run") {
          return async () => {
            if (!injected) {
              injected = true;
              await effect();
            }
            return target.run();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return query.includes(
            "INSERT INTO shiplet_managed_runtime_operations",
          )
            ? wrapStatement(statement)
            : statement;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("managed runtime kernel activation journal", () => {
  it("atomically refuses a prepared operation when the active pointer changes immediately before insertion", async () => {
    const fixture = await createValidatedCandidate();
    const db = (env as Env).DB;
    const operationId = `managed_main_${"g".repeat(43)}`;
    const interleavedDb = interleaveBeforeManagedOperationInsert(
      db,
      async () => {
        await db
          .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
          .bind(fixture.candidateRevisionId, fixture.projectId)
          .run();
      },
    );

    await expect(
      beginManagedRuntimeActivation({
        db: interleavedDb,
        operationId,
        projectId: fixture.projectId,
        kind: "promote",
        candidateRevisionId: fixture.candidateRevisionId,
        candidatePackageDigest: fixture.candidateDigest,
        priorRevisionId: fixture.priorRevisionId,
        actor: { kind: "human", id: "user_managed_kernel_owner" },
      }),
    ).rejects.toThrow("managed_runtime_operation_conflict");

    const active = await db
      .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
      .bind(fixture.projectId)
      .first<{ active_revision_id: string }>();
    expect(active?.active_revision_id).toBe(fixture.candidateRevisionId);
    await expect(
      db
        .prepare(
          "SELECT id FROM shiplet_managed_runtime_operations WHERE id = ?",
        )
        .bind(operationId)
        .first(),
    ).resolves.toBeNull();
    await expect(
      markManagedRuntimeRemoteCommitted({
        db,
        operationId,
        expectedRemoteGeneration: 0,
        remoteGeneration: 1,
      }),
    ).rejects.toThrow("managed_runtime_remote_commit_conflict");
  });

  it("does not rewrite security triggers after the terminal-aware schema is installed", async () => {
    await createValidatedCandidate();
    const db = (env as Env).DB;
    await ensureManagedRuntimeKernelSchema(db);
    const before = await db
      .prepare(
        `SELECT version, installed_on
         FROM shiplet_managed_runtime_schema_versions
         WHERE version IN (2, 3, 4) ORDER BY version`,
      )
      .all<{ version: number; installed_on: string }>();
    await ensureManagedRuntimeKernelSchema(db);
    const after = await db
      .prepare(
        `SELECT version, installed_on
         FROM shiplet_managed_runtime_schema_versions
         WHERE version IN (2, 3, 4) ORDER BY version`,
      )
      .all<{ version: number; installed_on: string }>();
    expect(after.results).toEqual(before.results);
    expect(after.results.map((row) => row.version)).toEqual([2, 3, 4]);
  });

  it("terminalizes a definite prepared failure without moving the active revision or leaving the Shiplet wedged", async () => {
    const fixture = await createValidatedCandidate();
    const db = (env as Env).DB;
    const operationId = `managed_main_${"c".repeat(43)}`;

    await beginManagedRuntimeActivation({
      db,
      operationId,
      projectId: fixture.projectId,
      kind: "promote",
      candidateRevisionId: fixture.candidateRevisionId,
      candidatePackageDigest: fixture.candidateDigest,
      priorRevisionId: fixture.priorRevisionId,
      actor: { kind: "human", id: "user_managed_kernel_owner" },
    });

    await expect(
      abortManagedRuntimeActivation({
        db,
        operationId,
        outcome: "remote_rejected",
        actor: { kind: "human", id: "different_actor" },
      }),
    ).rejects.toThrow("managed_runtime_abort_conflict");

    await expect(
      abortManagedRuntimeActivation({
        db,
        operationId,
        outcome: "not_dispatched",
        actor: { kind: "human", id: "user_managed_kernel_owner" },
        failure: { code: "managed_dynamic_unavailable", status: 503 },
      }),
    ).resolves.toEqual({
      operationId,
      status: "aborted",
      outcome: "not_dispatched",
      failure: { code: "managed_dynamic_unavailable", status: 503 },
    });
    await expect(
      abortManagedRuntimeActivation({
        db,
        operationId,
        outcome: "not_dispatched",
        actor: { kind: "human", id: "user_managed_kernel_owner" },
        failure: { code: "managed_dynamic_unavailable", status: 503 },
      }),
    ).resolves.toEqual({
      operationId,
      status: "aborted",
      outcome: "not_dispatched",
      failure: { code: "managed_dynamic_unavailable", status: 503 },
    });

    await expect(
      loadManagedRuntimeActivationTerminal({
        db,
        operationId,
        actor: { kind: "human", id: "user_managed_kernel_owner" },
      }),
    ).resolves.toEqual({
      operationId,
      outcome: "not_dispatched",
      priorRevisionId: fixture.priorRevisionId,
      failure: { code: "managed_dynamic_unavailable", status: 503 },
    });

    const project = await db
      .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
      .bind(fixture.projectId)
      .first<{ active_revision_id: string }>();
    expect(project?.active_revision_id).toBe(fixture.priorRevisionId);
    await expect(
      markManagedRuntimeRemoteCommitted({
        db,
        operationId,
        expectedRemoteGeneration: 0,
        remoteGeneration: 1,
      }),
    ).rejects.toThrow("managed_runtime_remote_commit_conflict");

    const terminal = await db
      .prepare(
        `SELECT outcome, actor_kind, actor_id, failure_code, failure_status
         FROM shiplet_managed_runtime_operation_terminals
         WHERE operation_id = ?`,
      )
      .bind(operationId)
      .first<{
        outcome: string;
        actor_kind: string;
        actor_id: string;
        failure_code: string;
        failure_status: number;
      }>();
    expect(terminal).toEqual({
      outcome: "not_dispatched",
      actor_kind: "human",
      actor_id: "user_managed_kernel_owner",
      failure_code: "managed_dynamic_unavailable",
      failure_status: 503,
    });
    await expect(
      db
        .prepare(
          `UPDATE shiplet_managed_runtime_operation_terminals
           SET outcome = 'not_dispatched' WHERE operation_id = ?`,
        )
        .bind(operationId)
        .run(),
    ).rejects.toThrow("managed runtime operation terminals are immutable");
    await expect(
      beginManagedRuntimeActivation({
        db,
        operationId,
        projectId: fixture.projectId,
        kind: "promote",
        candidateRevisionId: fixture.candidateRevisionId,
        candidatePackageDigest: fixture.candidateDigest,
        priorRevisionId: fixture.priorRevisionId,
        actor: { kind: "human", id: "user_managed_kernel_owner" },
      }),
    ).rejects.toThrow("managed_runtime_operation_terminal");

    await expect(
      beginManagedRuntimeActivation({
        db,
        operationId: `managed_main_${"d".repeat(43)}`,
        projectId: fixture.projectId,
        kind: "rollback",
        candidateRevisionId: fixture.priorRevisionId,
        candidatePackageDigest: fixture.priorDigest,
        priorRevisionId: fixture.priorRevisionId,
        actor: { kind: "human", id: "user_managed_kernel_owner" },
      }),
    ).resolves.toMatchObject({ status: "prepared" });
  });

  it("keeps an ambiguous prepared operation fenced until its exact retry reconciles the remote commit", async () => {
    const fixture = await createValidatedCandidate();
    const db = (env as Env).DB;
    const operationId = `managed_main_${"e".repeat(43)}`;
    const exact = {
      db,
      operationId,
      projectId: fixture.projectId,
      kind: "promote" as const,
      candidateRevisionId: fixture.candidateRevisionId,
      candidatePackageDigest: fixture.candidateDigest,
      priorRevisionId: fixture.priorRevisionId,
      actor: { kind: "human" as const, id: "user_managed_kernel_owner" },
    };

    await beginManagedRuntimeActivation(exact);
    await expect(
      beginManagedRuntimeActivation({
        ...exact,
        operationId: `managed_main_${"f".repeat(43)}`,
      }),
    ).rejects.toThrow("managed_runtime_operation_conflict");
    await expect(beginManagedRuntimeActivation(exact)).resolves.toEqual({
      operationId,
      status: "prepared",
      expectedRemoteGeneration: 0,
    });
    await expect(
      db
        .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
        .bind(fixture.candidateRevisionId, fixture.projectId)
        .run(),
    ).rejects.toThrow("managed runtime activation fence");

    await markManagedRuntimeActivationDispatching({
      db,
      operationId,
      actor: exact.actor,
    });
    await expect(
      abortManagedRuntimeActivation({
        db,
        operationId,
        outcome: "not_dispatched",
        actor: exact.actor,
      }),
    ).rejects.toThrow("managed_runtime_abort_conflict");

    await markManagedRuntimeRemoteCommitted({
      db,
      operationId,
      expectedRemoteGeneration: 0,
      remoteGeneration: 1,
    });
    const beforeLocalCommit = await db
      .prepare("SELECT active_revision_id FROM projects WHERE id = ?")
      .bind(fixture.projectId)
      .first<{ active_revision_id: string }>();
    expect(beforeLocalCommit?.active_revision_id).toBe(fixture.priorRevisionId);
    await expect(
      abortManagedRuntimeActivation({
        db,
        operationId,
        outcome: "remote_rejected",
        actor: { kind: "human", id: "user_managed_kernel_owner" },
      }),
    ).rejects.toThrow("managed_runtime_abort_conflict");
    await expect(beginManagedRuntimeActivation(exact)).resolves.toEqual({
      operationId,
      status: "remote_committed",
      expectedRemoteGeneration: 0,
      remoteGeneration: 1,
    });

    await expect(
      db
        .prepare("UPDATE projects SET active_revision_id = ? WHERE id = ?")
        .bind(fixture.priorRevisionId, fixture.projectId)
        .run(),
    ).rejects.toThrow("managed runtime activation fence");
    await db
      .prepare(
        "UPDATE projects SET active_revision_id = ? WHERE id = ? AND active_revision_id = ?",
      )
      .bind(
        fixture.candidateRevisionId,
        fixture.projectId,
        fixture.priorRevisionId,
      )
      .run();
    await expect(
      commitManagedRuntimeActivation({ db, operationId }),
    ).resolves.toMatchObject({
      shipletId: fixture.projectId,
      revisionId: fixture.candidateRevisionId,
      activationGeneration: 1,
    });
  });

  it("keeps the prior runnable binding through a remote-first split, then recovers the exact local commit once", async () => {
    const fixture = await createValidatedCandidate();
    const db = (env as Env).DB;
    await ensureManagedRuntimeKernelSchema(db);

    const baselineId = `managed_main_${"a".repeat(43)}`;
    const baseline = await beginManagedRuntimeActivation({
      db,
      operationId: baselineId,
      projectId: fixture.projectId,
      kind: "promote",
      candidateRevisionId: fixture.priorRevisionId,
      candidatePackageDigest: fixture.priorDigest,
      priorRevisionId: fixture.priorRevisionId,
      actor: { kind: "human", id: "user_managed_kernel_owner" },
    });
    expect(baseline.expectedRemoteGeneration).toBe(0);
    await markManagedRuntimeActivationDispatching({
      db,
      operationId: baselineId,
      actor: { kind: "human", id: "user_managed_kernel_owner" },
    });
    await markManagedRuntimeRemoteCommitted({
      db,
      operationId: baselineId,
      expectedRemoteGeneration: 0,
      remoteGeneration: 1,
    });
    await commitManagedRuntimeActivation({ db, operationId: baselineId });

    const operationId = `managed_main_${"b".repeat(43)}`;
    const pending = await beginManagedRuntimeActivation({
      db,
      operationId,
      projectId: fixture.projectId,
      kind: "promote",
      candidateRevisionId: fixture.candidateRevisionId,
      candidatePackageDigest: fixture.candidateDigest,
      priorRevisionId: fixture.priorRevisionId,
      actor: { kind: "human", id: "user_managed_kernel_owner" },
    });
    expect(pending.expectedRemoteGeneration).toBe(1);
    await markManagedRuntimeActivationDispatching({
      db,
      operationId,
      actor: { kind: "human", id: "user_managed_kernel_owner" },
    });
    await markManagedRuntimeRemoteCommitted({
      db,
      operationId,
      expectedRemoteGeneration: 1,
      remoteGeneration: 2,
    });

    await expect(
      db
        .prepare(
          "UPDATE projects SET active_revision_id = active_revision_id WHERE id = ?",
        )
        .bind(fixture.projectId)
        .run(),
    ).rejects.toThrow("managed runtime activation fence");

    await expect(
      loadManagedRuntimeInvocationBinding({
        db,
        projectId: fixture.projectId,
        revisionId: fixture.priorRevisionId,
        packageDigest: fixture.priorDigest,
      }),
    ).resolves.toEqual({
      shipletId: fixture.projectId,
      revisionId: fixture.priorRevisionId,
      packageDigest: fixture.priorDigest,
      activationGeneration: 1,
    });
    await expect(
      loadManagedRuntimeInvocationBinding({
        db,
        projectId: "sibling_shiplet",
        revisionId: fixture.priorRevisionId,
        packageDigest: fixture.priorDigest,
      }),
    ).resolves.toBeNull();

    await db
      .prepare(
        "UPDATE projects SET active_revision_id = ? WHERE id = ? AND active_revision_id = ?",
      )
      .bind(
        fixture.candidateRevisionId,
        fixture.projectId,
        fixture.priorRevisionId,
      )
      .run();
    await expect(
      loadManagedRuntimeInvocationBinding({
        db,
        projectId: fixture.projectId,
        revisionId: fixture.candidateRevisionId,
        packageDigest: fixture.candidateDigest,
      }),
    ).resolves.toEqual({
      shipletId: fixture.projectId,
      revisionId: fixture.candidateRevisionId,
      packageDigest: fixture.candidateDigest,
      activationGeneration: 2,
    });

    await commitManagedRuntimeActivation({ db, operationId });
    await expect(
      commitManagedRuntimeActivation({ db, operationId }),
    ).resolves.toEqual({
      shipletId: fixture.projectId,
      revisionId: fixture.candidateRevisionId,
      packageDigest: fixture.candidateDigest,
      activationGeneration: 2,
    });
  });
});
