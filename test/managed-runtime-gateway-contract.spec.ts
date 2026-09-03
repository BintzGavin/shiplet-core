import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  INTERNAL_SUPPORT_ENTRYPOINTS,
  createInternalSupportEntrypointContract,
  verifyInternalSupportEntrypointContract,
  type ManagedRuntimeReleaseExpectation,
} from "../src/cloudflare-support/service-contract";
import {
  ManagedRuntimeCoordinator,
  type ManagedDeploymentBroker,
  type ManagedDeploymentProof,
  type ManagedRuntimeCoordinatorEnv,
} from "../workers/managed-runtime-gateway/coordinator";
// @ts-expect-error Vite supplies the additive migration source text.
import managedRuntimeMigration from "../workers/managed-runtime-gateway/migrations/0001_managed_runtime.sql?raw";
// @ts-expect-error Vite supplies the additive migration source text.
import activationFenceMigration from "../workers/managed-runtime-gateway/migrations/0002_activation_operation_fence.sql?raw";
// @ts-expect-error Vite supplies the additive migration source text.
import managedStateMigration from "../workers/managed-runtime-gateway/migrations/0003_namespaced_state.sql?raw";
// @ts-expect-error Vite supplies the additive migration source text.
import atomicStateMigration from "../workers/managed-runtime-gateway/migrations/0004_atomic_state_and_stage_lease.sql?raw";

/**
 * Managed WFP boundary behavioral specification
 *
 * Given an exact managed-gateway release and exact deployment-broker and
 * deny-egress releases, when a kernel-authorized immutable revision is staged,
 * then only a credential-free broker RPC may upload it, with no ambient
 * bindings; both staging and production are health-probed under the requested
 * CPU/subrequest limits and deny-by-default egress before validation persists.
 *
 * Given dependency drift, a sibling/revision/digest/generation mismatch, a
 * failed health probe, or a concurrent activation, when the request reaches
 * the gateway, then it fails before the corresponding D1/upload/dispatch effect
 * and the previous active revision remains intact.
 *
 * Given an upload or activation response is lost after the effect commits,
 * when the exact operation is retried, then deterministic operation identity
 * and exact inspection recover success without duplicating authority or
 * advancing activation twice.
 *
 * Given two stage operations interleave for one immutable revision, when one
 * operation still owns its lease, then the other cannot upload, prove, fail,
 * change status, or clean up the owner's deployment.
 *
 * Given the selected account's live platform reservation is retired, when an
 * active or preview invocation is attempted, then the broker's credential-free
 * reservation assertion fails before the production dispatch namespace runs.
 *
 * Given remote activation commits before the main kernel acknowledges its
 * canonical pointer, when the kernel presents either the exact prior tuple or
 * exact candidate tuple, then that tuple remains servable with active state
 * authority; a third tuple fails closed and acknowledgement closes the prior
 * tuple without rewriting immutable activation history.
 */

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;

const GATEWAY_VERSION = "11111111-1111-4111-8111-111111111111";
const BROKER_VERSION = "22222222-2222-4222-8222-222222222222";
const DENY_EGRESS_VERSION = "33333333-3333-4333-8333-333333333333";
const RELEASE_TAG = "shiplet-managed-runtime-fixture";
const PACKAGE_A = `sha256:${"a".repeat(64)}`;
const PACKAGE_B = `sha256:${"b".repeat(64)}`;

const expectation: ManagedRuntimeReleaseExpectation = Object.freeze({
  gateway: { versionId: GATEWAY_VERSION, versionTag: RELEASE_TAG },
  deploymentBroker: { versionId: BROKER_VERSION, versionTag: RELEASE_TAG },
  denyEgress: { versionId: DENY_EGRESS_VERSION, versionTag: RELEASE_TAG },
});

function internalContract(index: number) {
  const entrypoint = INTERNAL_SUPPORT_ENTRYPOINTS[index];
  if (!entrypoint) throw new Error("internal_entrypoint_fixture_missing");
  return createInternalSupportEntrypointContract({
    ...entrypoint,
    metadata: {
      id: index === 0 ? BROKER_VERSION : DENY_EGRESS_VERSION,
      tag: RELEASE_TAG,
    },
  });
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

async function resetRuntimeSchema() {
  await testEnv.DB.exec(
    [
      "DROP TABLE IF EXISTS managed_activation_history",
      "DROP TABLE IF EXISTS managed_activations",
      "DROP TABLE IF EXISTS managed_runtime_state_operations",
      "DROP TABLE IF EXISTS managed_runtime_state_entries",
      "DROP TABLE IF EXISTS managed_runtime_state_namespaces",
      "DROP TABLE IF EXISTS managed_revisions",
    ]
      .map((statement) => `${statement};`)
      .join("\n"),
  );
  for (const migration of [
    managedRuntimeMigration,
    activationFenceMigration,
    managedStateMigration,
    atomicStateMigration,
  ]) {
    for (const statement of migrationStatements(migration)) {
      await testEnv.DB.prepare(statement).run();
    }
  }
}

type BrokerCall = Readonly<{
  method:
    | "contract"
    | "assertPlatformReservation"
    | "readiness"
    | "inspect"
    | "upload"
    | "delete";
  input?: Record<string, unknown>;
}>;

function createBroker(
  options: {
    loseFirstUploadResponse?: boolean;
    trustedProductionNamespace?: boolean;
  } = {},
) {
  const calls: BrokerCall[] = [];
  const deployed = new Map<string, ManagedDeploymentProof>();
  let uploadResponseLost = false;
  let platformReservationAvailable = true;
  const key = (input: { namespace: string; scriptName: string }) =>
    `${input.namespace}/${input.scriptName}`;
  const proof = (
    input: {
      operationId: string;
      namespace: "shiplet-managed-staging" | "shiplet-managed-production";
      scriptName: string;
      shipletId: string;
      revisionId: string;
      packageDigest: string;
    },
    status: "present" | "absent",
  ): ManagedDeploymentProof => ({
    schemaVersion: "shiplet.managed-deployment-proof/v1",
    operationId: input.operationId,
    namespace: input.namespace,
    scriptName: input.scriptName,
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    packageDigest: input.packageDigest,
    status,
  });
  const broker = {
    async contract() {
      calls.push({ method: "contract" });
      return internalContract(0);
    },
    async assertPlatformReservation(release: unknown) {
      calls.push({
        method: "assertPlatformReservation",
        input: { release },
      });
      if (!platformReservationAvailable) {
        throw new Error("managed_platform_reservation_unavailable");
      }
      return { ok: true as const };
    },
    async readiness() {
      calls.push({ method: "readiness" });
      return {
        schemaVersion: "shiplet.managed-deployment-readiness/v1" as const,
        operations: ["inspect", "upload", "delete"] as const,
        namespaces: [
          {
            name: "shiplet-managed-staging" as const,
            trustedWorkers: false as const,
          },
          {
            name: "shiplet-managed-production" as const,
            trustedWorkers: options.trustedProductionNamespace ?? false,
          },
        ] as const,
      };
    },
    async inspect(input) {
      calls.push({ method: "inspect", input: { ...input } });
      const existing = deployed.get(key(input));
      return existing
        ? { ...existing, operationId: input.operationId }
        : proof(input, "absent");
    },
    async upload(input) {
      calls.push({ method: "upload", input: { ...input } });
      const result = proof(input, "present");
      deployed.set(key(input), result);
      if (options.loseFirstUploadResponse && !uploadResponseLost) {
        uploadResponseLost = true;
        throw new Error("fixture_response_lost");
      }
      return result;
    },
    async delete(input) {
      calls.push({ method: "delete", input: { ...input } });
      deployed.delete(key(input));
      return proof(input, "absent");
    },
  } satisfies ManagedDeploymentBroker;
  return {
    broker,
    calls,
    deployed,
    retirePlatformReservation() {
      platformReservationAvailable = false;
    },
  };
}

type DispatchCall = Readonly<{
  namespace: "staging" | "production";
  scriptName: string;
  args: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
  request: Request;
}>;

function createDispatches(
  options: {
    failProductionHealth?: boolean;
    pauseFirstStagingHealth?: () => Promise<void>;
    failSecondStagingHealth?: boolean;
  } = {},
) {
  const calls: DispatchCall[] = [];
  let stagingHealthCalls = 0;
  const dispatch = (
    namespace: "staging" | "production",
  ): DispatchNamespace => ({
    get(scriptName, args, dynamicOptions) {
      const dispatchArgs = (args ?? {}) as Record<string, unknown>;
      return {
        async fetch(request: Request) {
          calls.push({
            namespace,
            scriptName,
            args: dispatchArgs,
            options: dynamicOptions as Record<string, unknown> | undefined,
            request,
          });
          const runtime = dispatchArgs.SHIPLET_RUNTIME as
            | {
                shipletId?: string;
                revisionId?: string;
                packageDigest?: string;
                activationGeneration?: number;
              }
            | undefined;
          if (new URL(request.url).pathname === "/__shiplet/health") {
            if (namespace === "staging") {
              stagingHealthCalls += 1;
              if (stagingHealthCalls === 1 && options.pauseFirstStagingHealth) {
                await options.pauseFirstStagingHealth();
              }
              if (stagingHealthCalls === 2 && options.failSecondStagingHealth) {
                return Response.json({ ok: false }, { status: 503 });
              }
            }
            if (namespace === "production" && options.failProductionHealth) {
              return Response.json({ ok: false }, { status: 503 });
            }
            return Response.json({
              ok: true,
              shipletId: runtime?.shipletId,
              revisionId: runtime?.revisionId,
              packageDigest: runtime?.packageDigest,
              activationGeneration: runtime?.activationGeneration,
            });
          }
          return new Response("invoked", { status: 200 });
        },
        connect() {
          throw new Error("fixture_socket_unavailable");
        },
      };
    },
  });
  return {
    staging: dispatch("staging"),
    production: dispatch("production"),
    calls,
  };
}

function stageInput(
  input: {
    actorId?: string;
    shipletId?: string;
    revisionId?: string;
    packageDigest?: string;
    operationId?: string;
  } = {},
) {
  return {
    actorId: input.actorId ?? "actor_fixture",
    ...(input.operationId ? { operationId: input.operationId } : {}),
    shipletId: input.shipletId ?? "shiplet_fixture",
    revisionId: input.revisionId ?? "revision_fixture",
    packageDigest: input.packageDigest ?? PACKAGE_A,
    mainModule: "worker.js",
    modules: [
      {
        name: "worker.js",
        mediaType: "application/javascript",
        content: "export default { fetch() { return new Response('ok') } }",
      },
    ],
    policy: { cpuMs: 25, subRequests: 7 },
  } as const;
}

function stateStageInput(
  input: {
    shipletId?: string;
    revisionId?: string;
    packageDigest?: string;
    permissions?: readonly ("read" | "write")[];
  } = {},
) {
  const permissions = input.permissions ?? (["read", "write"] as const);
  return {
    ...stageInput(input),
    mainModule: "__shiplet_runtime.mjs",
    modules: [
      {
        name: "__shiplet_runtime.mjs",
        mediaType: "application/javascript+module",
        content: `const STATE_PERMISSIONS = Object.freeze(${JSON.stringify(permissions)});\nexport default { fetch() { return new Response('ok') } };`,
        encoding: "utf8" as const,
      },
    ],
  } as const;
}

function createCoordinator(
  options: {
    broker?: ReturnType<typeof createBroker>;
    dispatches?: ReturnType<typeof createDispatches>;
    denyContract?: () => Promise<unknown>;
    db?: ManagedRuntimeCoordinatorEnv["RUNTIME_DB"];
  } = {},
) {
  const brokerFixture = options.broker ?? createBroker();
  const dispatches = options.dispatches ?? createDispatches();
  const env: ManagedRuntimeCoordinatorEnv = {
    RUNTIME_DB: options.db ?? testEnv.DB,
    STAGING_DISPATCH: dispatches.staging,
    PRODUCTION_DISPATCH: dispatches.production,
    MANAGED_DEPLOYMENT_BROKER: brokerFixture.broker,
    DENY_EGRESS_CONTRACT: {
      contract: options.denyContract ?? (async () => internalContract(1)),
    },
    CF_VERSION_METADATA: { id: GATEWAY_VERSION, tag: RELEASE_TAG },
  };
  return {
    coordinator: new ManagedRuntimeCoordinator(env),
    brokerFixture,
    dispatches,
  };
}

beforeEach(resetRuntimeSchema);

describe("managed runtime gateway release and authority boundary", () => {
  it("Given exact internal releases, When their contracts are verified, Then extra fields, swapped identities, and version drift fail closed", () => {
    expect(
      verifyInternalSupportEntrypointContract(
        internalContract(0),
        INTERNAL_SUPPORT_ENTRYPOINTS[0],
        expectation.deploymentBroker,
      ),
    ).toEqual({ ok: true });

    for (const candidate of [
      { ...internalContract(0), credential: "forbidden" },
      { ...internalContract(0), entrypoint: "DenyEgressContractRpc" },
      { ...internalContract(0), versionId: DENY_EGRESS_VERSION },
      { ...internalContract(0), versionTag: "stale-release" },
    ]) {
      expect(
        verifyInternalSupportEntrypointContract(
          candidate,
          INTERNAL_SUPPORT_ENTRYPOINTS[0],
          expectation.deploymentBroker,
        ),
      ).toEqual({ ok: false, reason: "internal_support_contract_mismatch" });
    }
  });

  it("Given a validated package, When staged, Then broker authority stays credential-free and both namespaces pass bounded deny-egress health before validation", async () => {
    const fixture = createCoordinator();

    await expect(
      fixture.coordinator.stageRevision(stageInput(), expectation),
    ).resolves.toEqual({
      ok: true,
      status: "validated",
      scriptName: expect.stringMatching(/^shiplet-[A-Za-z0-9_-]{43,48}$/),
    });

    const uploads = fixture.brokerFixture.calls.filter(
      (call) => call.method === "upload",
    );
    expect(uploads).toHaveLength(2);
    expect(uploads.map((call) => call.input?.namespace)).toEqual([
      "shiplet-managed-staging",
      "shiplet-managed-production",
    ]);
    for (const upload of uploads) {
      expect(upload.input).toMatchObject({
        schemaVersion: "shiplet.managed-deployment/v1",
        shipletId: "shiplet_fixture",
        revisionId: "revision_fixture",
        packageDigest: PACKAGE_A,
        mainModule: "worker.js",
        compatibilityDate: "2026-08-07",
        bindings: [],
      });
      expect(JSON.stringify(upload.input)).not.toMatch(
        /authorization|bearer|credential|api.?token|d1|r2|durable.?object|mtls/i,
      );
    }
    expect(fixture.dispatches.calls.map((call) => call.namespace)).toEqual([
      "staging",
      "production",
    ]);
    for (const call of fixture.dispatches.calls) {
      expect(call.args).toEqual({
        SHIPLET_RUNTIME: {
          shipletId: "shiplet_fixture",
          revisionId: "revision_fixture",
          packageDigest: PACKAGE_A,
          activationGeneration: 1,
        },
      });
      expect(call.options).toEqual({
        limits: { cpuMs: 25, subRequests: 7 },
        outbound: {
          policy: "deny_by_default",
          shiplet: "shiplet_fixture",
          revision: "revision_fixture",
          generation: "1",
        },
      });
      expect(call.request.headers.has("authorization")).toBe(false);
      expect(call.request.headers.has("cookie")).toBe(false);
    }
    await expect(
      testEnv.DB.prepare(
        "SELECT stage_status FROM managed_revisions WHERE shiplet_id = ? AND revision_id = ?",
      )
        .bind("shiplet_fixture", "revision_fixture")
        .first<{ stage_status: string }>(),
    ).resolves.toEqual({ stage_status: "validated" });
  });

  it("Given state-declaring revisions, When staged and invoked, Then one Shiplet namespace is shared across revisions while only invocation-bound outbound parameters carry state authority", async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.stageRevision(
      stateStageInput({
        revisionId: "revision_state_a",
        packageDigest: PACKAGE_A,
      }),
      expectation,
    );
    await fixture.coordinator.stageRevision(
      stateStageInput({
        revisionId: "revision_state_b",
        packageDigest: PACKAGE_B,
      }),
      expectation,
    );
    const rows = await testEnv.DB.prepare(
      `SELECT revision_id, state_scope_namespace, state_permissions_json
       FROM managed_revisions WHERE shiplet_id = ? ORDER BY revision_id`,
    )
      .bind("shiplet_fixture")
      .all<{
        revision_id: string;
        state_scope_namespace: string;
        state_permissions_json: string;
      }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]?.state_scope_namespace).toMatch(
      /^state-[A-Za-z0-9_-]{43}$/,
    );
    expect(rows.results[1]?.state_scope_namespace).toBe(
      rows.results[0]?.state_scope_namespace,
    );
    expect(rows.results.map((row) => row.state_permissions_json)).toEqual([
      '["read","write"]',
      '["read","write"]',
    ]);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM managed_runtime_state_namespaces WHERE shiplet_id = ?",
      )
        .bind("shiplet_fixture")
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });

    const active = await fixture.coordinator.promote(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_state_a",
        packageDigest: PACKAGE_A,
        expectedActivationGeneration: 0,
      },
      expectation,
    );
    await fixture.coordinator.invoke(
      {
        expected: {
          shipletId: "shiplet_fixture",
          revisionId: "revision_state_a",
          packageDigest: PACKAGE_A,
          activationGeneration: active.activationGeneration,
        },
        request: new Request("https://shiplet.invalid/state"),
      },
      expectation,
    );
    const activeCall = fixture.dispatches.calls.at(-1);
    expect(activeCall?.args).toEqual({
      SHIPLET_RUNTIME: {
        shipletId: "shiplet_fixture",
        revisionId: "revision_state_a",
        packageDigest: PACKAGE_A,
        activationGeneration: 1,
      },
    });
    expect(activeCall?.options?.outbound).toMatchObject({
      policy: "deny_by_default",
      shiplet: "shiplet_fixture",
      revision: "revision_state_a",
      generation: "1",
      packageDigest: PACKAGE_A,
      invocationKind: "active",
      stateMode: "read_write",
      stateNamespace: rows.results[0]?.state_scope_namespace,
      invocationId: expect.stringMatching(/^invocation_[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(activeCall?.args)).not.toMatch(
      /stateNamespace|RUNTIME_DB|D1Database|credential/i,
    );

    await fixture.coordinator.invokeValidatedRevision(
      {
        expected: {
          shipletId: "shiplet_fixture",
          revisionId: "revision_state_b",
          packageDigest: PACKAGE_B,
          activationGeneration: 1,
        },
        request: new Request("https://shiplet.invalid/preview"),
      },
      expectation,
    );
    expect(fixture.dispatches.calls.at(-1)?.options?.outbound).toMatchObject({
      revision: "revision_state_b",
      invocationKind: "preview",
      stateMode: "read",
      stateNamespace: rows.results[0]?.state_scope_namespace,
    });
    expect(
      fixture.brokerFixture.calls
        .filter((call) => call.method === "upload")
        .every((call) => JSON.stringify(call.input?.bindings) === "[]"),
    ).toBe(true);
  });

  it("Given dependency release drift, When staging is requested, Then no D1, broker mutation, or dispatch effect occurs", async () => {
    const fixture = createCoordinator({
      denyContract: async () => ({
        ...internalContract(1),
        versionId: BROKER_VERSION,
      }),
    });

    await expect(
      fixture.coordinator.stageRevision(stageInput(), expectation),
    ).rejects.toThrow("managed_runtime_dependency_mismatch");
    expect(
      fixture.brokerFixture.calls.filter((call) =>
        ["inspect", "upload", "delete"].includes(call.method),
      ),
    ).toEqual([]);
    expect(fixture.dispatches.calls).toEqual([]);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM managed_revisions",
      ).first<{
        count: number;
      }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("Given either dispatch namespace is trusted, When staging is requested, Then mutable provider isolation drift fails before D1 or dispatch", async () => {
    const broker = createBroker({ trustedProductionNamespace: true });
    const fixture = createCoordinator({ broker });

    await expect(
      fixture.coordinator.stageRevision(stageInput(), expectation),
    ).rejects.toThrow("managed_runtime_dependency_mismatch");
    expect(
      broker.calls.filter((call) =>
        ["inspect", "upload", "delete"].includes(call.method),
      ),
    ).toEqual([]);
    expect(fixture.dispatches.calls).toEqual([]);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM managed_revisions",
      ).first<{
        count: number;
      }>(),
    ).resolves.toEqual({ count: 0 });
  });

  it("Given the first upload response is lost after commit, When staging continues and is retried, Then exact inspection recovers one immutable deployment", async () => {
    const broker = createBroker({ loseFirstUploadResponse: true });
    const fixture = createCoordinator({ broker });

    const first = await fixture.coordinator.stageRevision(
      stageInput(),
      expectation,
    );
    const second = await fixture.coordinator.stageRevision(
      stageInput(),
      expectation,
    );
    expect(second).toEqual(first);
    expect(
      broker.calls.filter(
        (call) =>
          call.method === "upload" &&
          call.input?.namespace === "shiplet-managed-staging",
      ),
    ).toHaveLength(1);
    expect(broker.deployed.size).toBe(2);
  });

  it("Given one stage lease is proving a revision, When a second operation interleaves and would fail health, Then it cannot fail or clean up the owner's deployment", async () => {
    let announceFirstHealth!: () => void;
    const firstHealthStarted = new Promise<void>((resolve) => {
      announceFirstHealth = resolve;
    });
    let releaseFirstHealth!: () => void;
    const firstHealthRelease = new Promise<void>((resolve) => {
      releaseFirstHealth = resolve;
    });
    const broker = createBroker();
    const dispatches = createDispatches({
      pauseFirstStagingHealth: async () => {
        announceFirstHealth();
        await firstHealthRelease;
      },
      failSecondStagingHealth: true,
    });
    const fixture = createCoordinator({ broker, dispatches });
    const firstInput = stageInput({
      actorId: "actor_stage_a",
      operationId: `managed_${"A".repeat(43)}`,
    });
    const secondInput = stageInput({
      actorId: "actor_stage_b",
      operationId: `managed_${"B".repeat(43)}`,
    });

    const first = fixture.coordinator.stageRevision(firstInput, expectation);
    await firstHealthStarted;
    const second = await fixture.coordinator
      .stageRevision(secondInput, expectation)
      .then(
        () => ({ status: "fulfilled" as const, reason: null }),
        (error: unknown) => ({
          status: "rejected" as const,
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );
    releaseFirstHealth();
    const firstResult = await first;

    expect(second).toEqual({
      status: "rejected",
      reason: "managed_revision_stage_in_progress",
    });
    expect(firstResult.status).toBe("validated");
    expect(broker.calls.filter((call) => call.method === "delete")).toEqual([]);
    expect(broker.deployed.size).toBe(2);
    await expect(
      testEnv.DB.prepare(
        `SELECT stage_status, stage_operation_id, stage_lease_id
         FROM managed_revisions WHERE shiplet_id = ? AND revision_id = ?`,
      )
        .bind("shiplet_fixture", "revision_fixture")
        .first<{
          stage_status: string;
          stage_operation_id: string;
          stage_lease_id: string | null;
        }>(),
    ).resolves.toEqual({
      stage_status: "validated",
      stage_operation_id: firstInput.operationId,
      stage_lease_id: null,
    });
  });

  it("Given production health fails, When staging is attempted, Then validation fails and exact cleanup leaves no deployed script", async () => {
    const broker = createBroker();
    const dispatches = createDispatches({ failProductionHealth: true });
    const fixture = createCoordinator({ broker, dispatches });

    await expect(
      fixture.coordinator.stageRevision(stageInput(), expectation),
    ).rejects.toThrow("managed_revision_stage_failed");
    expect(broker.deployed.size).toBe(0);
    expect(
      broker.calls.filter((call) => call.method === "delete"),
    ).toHaveLength(2);
    await expect(
      testEnv.DB.prepare(
        `SELECT stage_status, stage_operation_id, stage_lease_id,
                stage_lease_expires_on
         FROM managed_revisions WHERE shiplet_id = ? AND revision_id = ?`,
      )
        .bind("shiplet_fixture", "revision_fixture")
        .first<{
          stage_status: string;
          stage_operation_id: string;
          stage_lease_id: string | null;
          stage_lease_expires_on: string | null;
        }>(),
    ).resolves.toEqual({
      stage_status: "failed",
      stage_operation_id: expect.stringMatching(/^managed_[A-Za-z0-9_-]{43}$/),
      stage_lease_id: null,
      stage_lease_expires_on: null,
    });
  });

  it("Given two validated drafts and one activation generation, When promoted concurrently, Then CAS advances exactly once and rollback restores the known-good revision", async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.stageRevision(
      stageInput({ revisionId: "revision_a", packageDigest: PACKAGE_A }),
      expectation,
    );
    await fixture.coordinator.stageRevision(
      stageInput({ revisionId: "revision_b", packageDigest: PACKAGE_B }),
      expectation,
    );

    const first = await fixture.coordinator.promote(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_a",
        packageDigest: PACKAGE_A,
        expectedActivationGeneration: 0,
      },
      expectation,
    );
    expect(first.activationGeneration).toBe(1);

    const concurrent = await Promise.allSettled([
      fixture.coordinator.promote(
        {
          actorId: "actor_a",
          shipletId: "shiplet_fixture",
          revisionId: "revision_b",
          packageDigest: PACKAGE_B,
          expectedActivationGeneration: 1,
        },
        expectation,
      ),
      fixture.coordinator.rollback(
        {
          actorId: "actor_b",
          shipletId: "shiplet_fixture",
          revisionId: "revision_a",
          packageDigest: PACKAGE_A,
          expectedActivationGeneration: 1,
        },
        expectation,
      ),
    ]);
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const active = await testEnv.DB.prepare(
      "SELECT revision_id, package_digest, generation FROM managed_activations WHERE shiplet_id = ?",
    )
      .bind("shiplet_fixture")
      .first<{
        revision_id: string;
        package_digest: string;
        generation: number;
      }>();
    expect(active?.generation).toBe(2);

    const rolledBack = await fixture.coordinator.rollback(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_a",
        packageDigest: PACKAGE_A,
        expectedActivationGeneration: 2,
      },
      expectation,
    );
    expect(rolledBack).toMatchObject({
      revisionId: "revision_a",
      packageDigest: PACKAGE_A,
      activationGeneration: 3,
    });
  });

  it("Given an exact active revision, When invoked, Then authority headers are stripped and sibling, digest, or generation drift never dispatches", async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.stageRevision(stageInput(), expectation);
    const active = await fixture.coordinator.promote(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_fixture",
        packageDigest: PACKAGE_A,
        expectedActivationGeneration: 0,
      },
      expectation,
    );
    const healthCalls = fixture.dispatches.calls.length;
    const request = new Request("https://shiplet.invalid/app", {
      headers: {
        accept: "text/html",
        authorization: "",
        cookie: "",
        "x-shiplet-capability": "",
      },
    });

    const response = await fixture.coordinator.invoke(
      {
        expected: {
          shipletId: "shiplet_fixture",
          revisionId: "revision_fixture",
          packageDigest: PACKAGE_A,
          activationGeneration: active.activationGeneration,
        },
        request,
      },
      expectation,
    );
    expect(await response.text()).toBe("invoked");
    const invocation = fixture.dispatches.calls.at(-1);
    expect(invocation?.request.headers.get("accept")).toBe("text/html");
    for (const header of ["authorization", "cookie", "x-shiplet-capability"]) {
      expect(invocation?.request.headers.has(header)).toBe(false);
    }

    for (const expected of [
      {
        shipletId: "shiplet_sibling",
        revisionId: "revision_fixture",
        packageDigest: PACKAGE_A,
        activationGeneration: active.activationGeneration,
      },
      {
        shipletId: "shiplet_fixture",
        revisionId: "revision_fixture",
        packageDigest: PACKAGE_B,
        activationGeneration: active.activationGeneration,
      },
      {
        shipletId: "shiplet_fixture",
        revisionId: "revision_fixture",
        packageDigest: PACKAGE_A,
        activationGeneration: active.activationGeneration + 1,
      },
    ]) {
      await expect(
        fixture.coordinator.invoke({ expected, request }, expectation),
      ).rejects.toThrow(/managed_revision_(?:unavailable|binding_mismatch)/);
    }
    expect(fixture.dispatches.calls).toHaveLength(healthCalls + 1);
  });

  it("Given a retired live platform reservation, When active or preview invocation is attempted, Then every invocation fails before production dispatch", async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.stageRevision(stageInput(), expectation);
    const active = await fixture.coordinator.promote(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_fixture",
        packageDigest: PACKAGE_A,
        expectedActivationGeneration: 0,
      },
      expectation,
    );
    fixture.brokerFixture.retirePlatformReservation();
    const before = fixture.dispatches.calls.length;
    const expected = {
      shipletId: "shiplet_fixture",
      revisionId: "revision_fixture",
      packageDigest: PACKAGE_A,
      activationGeneration: active.activationGeneration,
    } as const;
    const request = new Request("https://shiplet.invalid/app");

    await expect(
      fixture.coordinator.invoke({ expected, request }, expectation),
    ).rejects.toThrow("managed_platform_reservation_unavailable");
    await expect(
      fixture.coordinator.invokeValidatedRevision(
        { expected, request },
        expectation,
      ),
    ).rejects.toThrow("managed_platform_reservation_unavailable");
    expect(fixture.dispatches.calls).toHaveLength(before);
    const assertions = fixture.brokerFixture.calls.filter(
      (call) => call.method === "assertPlatformReservation",
    );
    expect(assertions.slice(-2).map((call) => call.input)).toEqual([
      { release: expectation.deploymentBroker },
      { release: expectation.deploymentBroker },
    ]);
  });

  it("Given a remote-first activation split, When the main kernel names the prior or candidate exact tuple before acknowledgement, Then both are runnable but a stale third tuple is denied", async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.stageRevision(
      stageInput({ revisionId: "revision_a", packageDigest: PACKAGE_A }),
      expectation,
    );
    await fixture.coordinator.promote(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_a",
        packageDigest: PACKAGE_A,
        expectedActivationGeneration: 0,
      },
      expectation,
    );
    await fixture.coordinator.stageRevision(
      stageInput({ revisionId: "revision_b", packageDigest: PACKAGE_B }),
      expectation,
    );
    const remoteCandidate = await fixture.coordinator.promote(
      {
        actorId: "actor_fixture",
        shipletId: "shiplet_fixture",
        revisionId: "revision_b",
        packageDigest: PACKAGE_B,
        expectedActivationGeneration: 1,
      },
      expectation,
    );
    const before = fixture.dispatches.calls.length;
    const response = await fixture.coordinator.invoke(
      {
        expected: {
          shipletId: "shiplet_fixture",
          revisionId: "revision_a",
          packageDigest: PACKAGE_A,
          activationGeneration: remoteCandidate.activationGeneration - 1,
        },
        request: new Request("https://shiplet.invalid/prior"),
      },
      expectation,
    );
    expect(await response.text()).toBe("invoked");
    expect(fixture.dispatches.calls).toHaveLength(before + 1);

    await expect(
      fixture.coordinator.invoke(
        {
          expected: {
            shipletId: "shiplet_fixture",
            revisionId: "revision_b",
            packageDigest: PACKAGE_B,
            activationGeneration: remoteCandidate.activationGeneration,
          },
          request: new Request("https://shiplet.invalid/candidate"),
        },
        expectation,
      ),
    ).resolves.toBeInstanceOf(Response);
    await expect(
      fixture.coordinator.invoke(
        {
          expected: {
            shipletId: "shiplet_fixture",
            revisionId: "revision_a",
            packageDigest: PACKAGE_A,
            activationGeneration: remoteCandidate.activationGeneration,
          },
          request: new Request("https://shiplet.invalid/stale"),
        },
        expectation,
      ),
    ).rejects.toThrow("managed_revision_binding_mismatch");

    const acknowledgementRpc = fixture.coordinator.acknowledgeActivation.bind(
      fixture.coordinator,
    );
    const acknowledgementInput = {
      actorId: "actor_fixture",
      shipletId: "shiplet_fixture",
      revisionId: "revision_b",
      packageDigest: PACKAGE_B,
      expectedActivationGeneration: 1,
      reason: "promote" as const,
    };
    // The first successful return is deliberately discarded to model a caller
    // losing the response after the acknowledgement update commits.
    await acknowledgementRpc(acknowledgementInput, expectation);
    await expect(
      acknowledgementRpc(acknowledgementInput, expectation),
    ).resolves.toEqual({ ok: true });
    await expect(
      fixture.coordinator.invoke(
        {
          expected: {
            shipletId: "shiplet_fixture",
            revisionId: "revision_a",
            packageDigest: PACKAGE_A,
            activationGeneration: 1,
          },
          request: new Request("https://shiplet.invalid/prior-after-ack"),
        },
        expectation,
      ),
    ).rejects.toThrow("managed_revision_binding_mismatch");
    await expect(
      fixture.coordinator.invoke(
        {
          expected: {
            shipletId: "shiplet_fixture",
            revisionId: "revision_b",
            packageDigest: PACKAGE_B,
            activationGeneration: 2,
          },
          request: new Request("https://shiplet.invalid/candidate-after-ack"),
        },
        expectation,
      ),
    ).resolves.toBeInstanceOf(Response);
  });

  it("Given activation committed but its response was lost, When the exact request is retried, Then generation does not advance twice", async () => {
    const fixture = createCoordinator();
    await fixture.coordinator.stageRevision(stageInput(), expectation);
    let loseResponse = true;
    const responseLossDb: ManagedRuntimeCoordinatorEnv["RUNTIME_DB"] = {
      prepare: testEnv.DB.prepare.bind(testEnv.DB),
      async batch<T = unknown>(statements: D1PreparedStatement[]) {
        const result = await testEnv.DB.batch<T>(statements);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("fixture_response_lost");
        }
        return result;
      },
    };
    const responseLoss = createCoordinator({
      broker: fixture.brokerFixture,
      dispatches: fixture.dispatches,
      db: responseLossDb,
    }).coordinator;
    const activation = {
      actorId: "actor_fixture",
      shipletId: "shiplet_fixture",
      revisionId: "revision_fixture",
      packageDigest: PACKAGE_A,
      expectedActivationGeneration: 0,
    } as const;

    await expect(
      responseLoss.promote(activation, expectation),
    ).resolves.toMatchObject({
      activationGeneration: 1,
      revisionId: "revision_fixture",
    });
    await expect(
      responseLoss.promote(activation, expectation),
    ).resolves.toMatchObject({
      activationGeneration: 1,
      revisionId: "revision_fixture",
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT generation FROM managed_activations WHERE shiplet_id = ?",
      )
        .bind("shiplet_fixture")
        .first<{ generation: number }>(),
    ).resolves.toEqual({ generation: 1 });
  });
});
