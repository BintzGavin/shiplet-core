import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  parseShipletPackage,
  serializeShipletPackage,
} from "../src/self-owned/package";
import {
  createRevisionService as createRawRevisionService,
  ensureRevisionSchema,
} from "../src/self-owned/revisions";
import { ensureSchema } from "../src/schema";
import completePackageFixture from "./fixtures/packages/complete-v1.json";

type RevisionTestEnv = {
  DB: D1Database;
};

type PackageFile = {
  path: string;
  mediaType: string;
  encoding: "utf8" | "base64";
  content: string;
  sha256: string;
  size: number;
};

type PackageEnvelope = {
  mediaType: string;
  manifest: Record<string, unknown>;
  files: PackageFile[];
};

type DeploymentRequest = {
  shipletId: string;
  revisionId: string;
  targetId: string;
  reason: "promotion" | "rollback";
};

type ProviderFinalizationRequest = DeploymentRequest & {
  deploymentId: string;
  providerVersionId: string;
};

type ProviderRollbackRequest = ProviderFinalizationRequest & {
  previousDeployment: {
    deploymentId: string;
    providerVersionId: string;
    providerResourceName: string;
  };
};

type MultiTargetRollbackInput = {
  shipletId: string;
  revisionId: string;
  expectedActiveRevisionId: string;
  targetIds: string[];
  actor: typeof ACTOR;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const testEnv = env as RevisionTestEnv;
const ACTOR = { kind: "human" as const, id: "user_revision_owner" };

type KernelRevisionAction =
  | "revision.create_initial"
  | "revision.read"
  | "draft.read"
  | "package.export"
  | "revision.fork"
  | "revision.update_draft"
  | "revision.validate_draft"
  | "revision.promote"
  | "revision.rollback"
  | "revision.recover_operation";

type KernelAuthorizationBinding = {
  shipletId: string;
  actor: typeof ACTOR;
  action: KernelRevisionAction;
};

type KernelAuthorizer = {
  authorize(input: KernelAuthorizationBinding): Promise<{
    authorizationId: string;
    binding: KernelAuthorizationBinding;
  }>;
};

const ALLOW_KERNEL_AUTHORIZER: KernelAuthorizer = {
  authorize: async (input) => ({
    authorizationId: `authorization_${crypto.randomUUID()}`,
    binding: structuredClone(input),
  }),
};

type RawRevisionServiceOptions = Parameters<typeof createRawRevisionService>[0];

type TestMcpManifestValidator = {
  validate(input: {
    shipletId: string;
    revisionId: string;
    package: ReturnType<typeof parseShipletPackage> extends Promise<infer T>
      ? T
      : never;
    signal: AbortSignal;
  }): Promise<{
    ok: boolean;
    errors: Array<{ code: string; path?: string; checkId?: string }>;
  }>;
};

const ALLOW_MCP_MANIFEST_VALIDATOR: TestMcpManifestValidator = {
  validate: async () => ({ ok: true, errors: [] }),
};

function createRevisionService(
  options: Omit<
    RawRevisionServiceOptions,
    "kernelAuthorizer" | "mcpManifestValidator"
  > & {
    mcpManifestValidator?: TestMcpManifestValidator | null;
  },
) {
  const {
    mcpManifestValidator = ALLOW_MCP_MANIFEST_VALIDATOR,
    ...serviceOptions
  } = options;
  const service = createRawRevisionService({
    ...serviceOptions,
    ...(mcpManifestValidator ? { mcpManifestValidator } : {}),
    kernelAuthorizer: ALLOW_KERNEL_AUTHORIZER,
  } as RawRevisionServiceOptions);
  return {
    ...service,
    getActiveRevision(input: { shipletId: string; actor?: typeof ACTOR }) {
      return service.getActiveRevision({
        ...input,
        actor: input.actor ?? ACTOR,
      });
    },
    getRevision(input: {
      shipletId: string;
      revisionId: string;
      actor?: typeof ACTOR;
    }) {
      return service.getRevision({ ...input, actor: input.actor ?? ACTOR });
    },
    exportDraftPackage(input: {
      shipletId: string;
      draftId: string;
      actor?: typeof ACTOR;
    }) {
      return service.exportDraftPackage({
        ...input,
        actor: input.actor ?? ACTOR,
      });
    },
    exportRevisionPackage(input: {
      shipletId: string;
      revisionId: string;
      actor?: typeof ACTOR;
    }) {
      return service.exportRevisionPackage({
        ...input,
        actor: input.actor ?? ACTOR,
      });
    },
  };
}

function clonePackage(): PackageEnvelope {
  return structuredClone(completePackageFixture) as PackageEnvelope;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function packageWithProvenanceParent(
  candidate: PackageEnvelope,
  parentRevisionId: string | null,
) {
  await replaceUtf8FileContent(
    candidate,
    "provenance.json",
    `${JSON.stringify({
      schemaVersion: "shiplet.provenance/v1",
      source: { kind: "local" },
      lineage: { parentRevisionId },
    })}\n`,
  );
  return candidate;
}

async function packageWithArtifact(label: string, parentRevisionId: string) {
  const candidate = clonePackage();
  const artifact = candidate.files.find(
    (file) => file.path === "artifact/index.html",
  );
  if (!artifact) throw new Error("fixture is missing artifact/index.html");
  artifact.content = `<!doctype html><main>${label}</main>\n`;
  artifact.size = new TextEncoder().encode(artifact.content).byteLength;
  artifact.sha256 = await sha256Hex(artifact.content);
  return packageWithProvenanceParent(candidate, parentRevisionId);
}

async function replaceUtf8FileContent(
  candidate: PackageEnvelope,
  path: string,
  content: string,
) {
  const file = candidate.files.find((entry) => entry.path === path);
  if (!file) throw new Error(`fixture is missing ${path}`);
  file.content = content;
  file.encoding = "utf8";
  file.size = new TextEncoder().encode(content).byteLength;
  file.sha256 = await sha256Hex(content);
  return candidate;
}

async function packageWithoutCustomMcp(candidate = clonePackage()) {
  await replaceUtf8FileContent(
    candidate,
    "mcp/manifest.json",
    `${JSON.stringify({ schemaVersion: "shiplet.mcp/v1", tools: [] })}\n`,
  );
  return candidate;
}

async function insertProject() {
  const id = `project_revision_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO projects (
			id, organization_id, owner_user_id, name, subdomain,
			script_content, visibility, created_on, modified_on
		) VALUES (?, NULL, NULL, ?, ?, '', 'private', ?, ?)`,
  )
    .bind(
      id,
      `Revision fixture ${id}`,
      `revision-${crypto.randomUUID()}`,
      now,
      now,
    )
    .run();
  return id;
}

async function expectLifecycleFailure(
  operation: () => unknown | Promise<unknown>,
  expected: Record<string, unknown>,
) {
  let observed: unknown;
  try {
    await operation();
  } catch (error) {
    observed = error;
  }

  expect(observed, "the lifecycle operation should fail closed").toBeTruthy();
  expect(observed).toMatchObject(expected);
}

async function insertKnownGoodDeployment(input: {
  shipletId: string;
  revisionId: string;
  targetId: string;
  deploymentId: string;
  sentinel?: string;
}) {
  const now = new Date().toISOString();
  await insertDeploymentTarget({
    shipletId: input.shipletId,
    targetId: input.targetId,
    sentinel: input.sentinel,
  });
  await testEnv.DB.prepare(
    `INSERT INTO shiplet_deployments (
			id, target_id, revision_id, provider_resource_name,
			provider_version_id, status, health_json, deployed_on,
			failed_on, supersedes_deployment_id
		) VALUES (?, ?, ?, ?, ?, 'healthy', ?, ?, NULL, NULL)`,
  )
    .bind(
      input.deploymentId,
      input.targetId,
      input.revisionId,
      `worker-${input.sentinel ?? "known-good"}`,
      `provider-${input.revisionId}`,
      JSON.stringify({ privateHealth: input.sentinel ?? "healthy" }),
      now,
    )
    .run();
}

async function insertDeploymentTarget(input: {
  shipletId: string;
  targetId: string;
  sentinel?: string;
}) {
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO deployment_targets (
			id, project_id, kind, owner_kind, owner_id, connection_id,
			provider_account_id, configuration_json, created_on, detached_on
		) VALUES (?, ?, 'customer_cloudflare', 'human', ?, NULL, ?, ?, ?, NULL)`,
  )
    .bind(
      input.targetId,
      input.shipletId,
      ACTOR.id,
      "account_fixture",
      JSON.stringify({ internalMarker: input.sentinel ?? "target-private" }),
      now,
    )
    .run();
}

async function insertKernelOwnedRecords(input: {
  shipletId: string;
  revisionId: string;
  sentinel: string;
}) {
  const targetId = `target_${crypto.randomUUID()}`;
  const deploymentId = `deployment_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await insertKnownGoodDeployment({
    ...input,
    targetId,
    deploymentId,
  });
  await testEnv.DB.prepare(
    `INSERT INTO shiplet_state (
			project_id, deployment_id, namespace, key, value_json,
			byte_size, version, updated_on
		) VALUES (?, ?, 'review', 'private', ?, ?, 7, ?)`,
  )
    .bind(
      input.shipletId,
      deploymentId,
      JSON.stringify({ privateValue: input.sentinel }),
      input.sentinel.length,
      now,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO shiplet_capability_grants (
			id, project_id, revision_id, actor_kind, actor_id, capability,
			resource_json, constraints_json, issued_on, expires_on, revoked_on
		) VALUES (?, ?, ?, 'human', ?, 'state.read', ?, '{}', ?, NULL, NULL)`,
  )
    .bind(
      `grant_${crypto.randomUUID()}`,
      input.shipletId,
      input.revisionId,
      ACTOR.id,
      JSON.stringify({ secretReference: input.sentinel }),
      now,
    )
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO shiplet_audit_events (
			id, project_id, revision_id, deployment_id, actor_kind, actor_id,
			event_kind, summary, status_category, payload_json, occurred_on,
			recorded_on
		) VALUES (?, ?, ?, ?, 'system', 'system', 'fixture.private',
			'Private audit fixture', 'informational', ?, ?, ?)`,
  )
    .bind(
      `audit_${crypto.randomUUID()}`,
      input.shipletId,
      input.revisionId,
      deploymentId,
      JSON.stringify({ privateAudit: input.sentinel }),
      now,
      now,
    )
    .run();
  return { deploymentId, targetId };
}

describe("immutable Shiplet revision lifecycle", () => {
  beforeEach(async () => {
    await ensureSchema(testEnv.DB);
    await ensureRevisionSchema(testEnv.DB);
  });

  it("requires a trusted kernel authorizer before accepting lifecycle actors", async () => {
    const shipletId = await insertProject();
    const [attempt] = await Promise.allSettled([
      Promise.resolve().then(() =>
        createRawRevisionService({
          db: testEnv.DB,
        } as RawRevisionServiceOptions).createInitialRevision({
          shipletId,
          package: clonePackage(),
          actor: ACTOR,
        }),
      ),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "kernel_authorizer_required" },
    });
    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM shiplet_revisions WHERE project_id = ?",
    )
      .bind(shipletId)
      .first<{ count: number }>();
    expect.soft(count?.count).toBe(0);
  });

  it("requires an exact actor-bound kernel authorization for revision and package reads", async () => {
    const shipletId = await insertProject();
    const setup = createRevisionService({ db: testEnv.DB });
    const initial = await setup.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setup.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const requests: KernelAuthorizationBinding[] = [];
    const denied = createRawRevisionService({
      db: testEnv.DB,
      kernelAuthorizer: {
        async authorize(input) {
          requests.push(structuredClone(input) as KernelAuthorizationBinding);
          throw new Error("denied");
        },
      },
    });

    for (const operation of [
      () => denied.getActiveRevision({ shipletId, actor: ACTOR }),
      () =>
        denied.getRevision({ shipletId, revisionId: initial.id, actor: ACTOR }),
      () =>
        denied.exportDraftPackage({
          shipletId,
          draftId: draft.id,
          actor: ACTOR,
        }),
      () =>
        denied.exportRevisionPackage({
          shipletId,
          revisionId: initial.id,
          actor: ACTOR,
        }),
    ]) {
      await expectLifecycleFailure(operation, { code: "authorization_denied" });
    }
    expect(requests.map((request) => request.action)).toEqual([
      "revision.read",
      "revision.read",
      "draft.read",
      "package.export",
    ]);
  });

  it("rejects audit records whose revision belongs to a sibling Shiplet", async () => {
    const firstShipletId = await insertProject();
    const secondShipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const firstRevision = await service.createInitialRevision({
      shipletId: firstShipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const secondRevision = await service.createInitialRevision({
      shipletId: secondShipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const timestamp = new Date().toISOString();

    await expect(
      testEnv.DB.prepare(
        `INSERT INTO shiplet_audit_events (
          id, project_id, revision_id, deployment_id, actor_kind, actor_id,
          event_kind, summary, status_category, payload_json, occurred_on,
          recorded_on
        ) VALUES (?, ?, ?, NULL, 'system', 'test', 'fixture.cross_scope',
          'Cross scope fixture', 'informational', '{}', ?, ?)`,
      )
        .bind(
          `audit_${crypto.randomUUID()}`,
          firstShipletId,
          secondRevision.id,
          timestamp,
          timestamp,
        )
        .run(),
    ).rejects.toThrow(/audit.*project|crosses project/i);

    expect(firstRevision.shipletId).toBe(firstShipletId);
  });

  it("rejects cross-Shiplet prepared recovery data before calling a deployment provider", async () => {
    const shipletId = await insertProject();
    const siblingShipletId = await insertProject();
    const setup = createRevisionService({ db: testEnv.DB });
    const initial = await setup.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setup.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const candidate = await setup.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      actor: ACTOR,
    });
    const siblingRevision = await setup.createInitialRevision({
      shipletId: siblingShipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const siblingTargetId = `target_${crypto.randomUUID()}`;
    const siblingDeploymentId = `deployment_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId: siblingShipletId,
      revisionId: siblingRevision.id,
      targetId: siblingTargetId,
      deploymentId: siblingDeploymentId,
    });
    const operationId = `revision_operation_${crypto.randomUUID()}`;
    const preparedDeploymentId = `deployment_${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO shiplet_revision_operations (
        id, project_id, kind, candidate_revision_id, prior_revision_id,
        status, target_generation, target_ids_json, deployment_ids_json,
        prepared_json, reconciliation_json, lease_expires_on, idempotency_key,
        last_error_code, created_on, updated_on
      ) VALUES (?, ?, 'promotion', ?, ?, 'reconciliation_required', 0,
        ?, ?, ?, ?, NULL, ?, 'provider_activation_failed', ?, ?)`,
    )
      .bind(
        operationId,
        shipletId,
        candidate.revisionId,
        initial.id,
        JSON.stringify([siblingTargetId]),
        JSON.stringify([preparedDeploymentId]),
        JSON.stringify([
          {
            request: {
              shipletId: siblingShipletId,
              revisionId: siblingRevision.id,
              targetId: siblingTargetId,
              reason: "promotion",
            },
            prepared: {
              deploymentId: preparedDeploymentId,
              providerVersionId: "provider-sibling-candidate",
              providerResourceName: "sibling-worker",
              status: "healthy",
            },
            previousDeployment: {
              id: siblingDeploymentId,
              revision_id: siblingRevision.id,
              provider_version_id: `provider-${siblingRevision.id}`,
              provider_resource_name: "worker-known-good",
            },
          },
        ]),
        JSON.stringify({
          reconciliationRequiredTargetIds: [siblingTargetId],
        }),
        operationId,
        timestamp,
        timestamp,
      )
      .run();
    const providerCalls: string[] = [];
    const recovery = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: {
        async prepareRevision() {
          throw new Error("not used");
        },
        async restorePriorRevision(request) {
          providerCalls.push(request.targetId);
        },
      },
    });

    await expectLifecycleFailure(
      () =>
        recovery.recoverRevisionOperation({
          shipletId,
          operationId,
          actor: ACTOR,
        }),
      { code: "revision_operation_corrupt" },
    );
    expect(providerCalls).toEqual([]);
  });

  it("bounds custom validation time and fails the draft closed on timeout", async () => {
    const shipletId = await insertProject();
    const setup = createRevisionService({ db: testEnv.DB });
    const initial = await setup.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setup.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const service = createRawRevisionService({
      db: testEnv.DB,
      kernelAuthorizer: ALLOW_KERNEL_AUTHORIZER,
      mcpManifestValidator: ALLOW_MCP_MANIFEST_VALIDATOR,
      validationTimeoutMs: 5,
      validationRunner: {
        async validate() {
          return await new Promise<never>(() => undefined);
        },
      },
    } as RawRevisionServiceOptions & { validationTimeoutMs: number });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      service.validateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: draft.version,
        actor: ACTOR,
      }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("validation timeout watchdog expired")),
          500,
        );
      }),
    ]).finally(() => {
      if (watchdog) clearTimeout(watchdog);
    });

    expect(result).toMatchObject({
      ok: false,
      revisionId: "",
      errors: [{ code: "validation_timeout" }],
    });
    expect((await setup.getActiveRevision({ shipletId })).id).toBe(initial.id);
  });

  it.each(["shipletId", "actor", "action"] as const)(
    "rejects an opaque kernel authorization with a mismatched %s binding",
    async (mismatch) => {
      const shipletId = await insertProject();
      const authorizationRequests: KernelAuthorizationBinding[] = [];
      const mismatchedAuthorizer: KernelAuthorizer = {
        authorize: async (input) => {
          authorizationRequests.push(structuredClone(input));
          const binding = structuredClone(input);
          if (mismatch === "shipletId") {
            binding.shipletId = `sibling_${crypto.randomUUID()}`;
          } else if (mismatch === "actor") {
            binding.actor.id = `different_actor_${crypto.randomUUID()}`;
          } else {
            binding.action = "revision.rollback";
          }
          return {
            authorizationId: `authorization_${crypto.randomUUID()}`,
            binding,
          };
        },
      };
      const service = createRawRevisionService({
        db: testEnv.DB,
        kernelAuthorizer: mismatchedAuthorizer,
      } as RawRevisionServiceOptions);

      const [attempt] = await Promise.allSettled([
        service.createInitialRevision({
          shipletId,
          package: clonePackage(),
          actor: ACTOR,
        }),
      ]);
      expect.soft(authorizationRequests).toEqual([
        {
          shipletId,
          actor: ACTOR,
          action: "revision.create_initial",
        },
      ]);
      expect.soft(attempt).toMatchObject({
        status: "rejected",
        reason: { code: "authorization_binding_mismatch" },
      });
      const count = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM shiplet_revisions WHERE project_id = ?",
      )
        .bind(shipletId)
        .first<{ count: number }>();
      expect.soft(count?.count).toBe(0);
    },
  );

  it("runs declared validation before initial activation and leaves no known-good revision on failure", async () => {
    const shipletId = await insertProject();
    const candidate = clonePackage();
    await replaceUtf8FileContent(
      candidate,
      "validation/manifest.json",
      `${JSON.stringify({
        schemaVersion: "shiplet.validation/v1",
        checks: [
          {
            id: "initial-required-file",
            kind: "file-exists",
            path: "artifact/not-present.html",
          },
        ],
      })}\n`,
    );
    const service = createRevisionService({ db: testEnv.DB });

    const [attempt] = await Promise.allSettled([
      service.createInitialRevision({
        shipletId,
        package: candidate,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: {
        code: "initial_validation_failed",
        errors: [
          {
            code: "declared_check_failed",
            checkId: "initial-required-file",
          },
        ],
      },
    });

    const project = await testEnv.DB.prepare(
      "SELECT active_revision_id FROM projects WHERE id = ?",
    )
      .bind(shipletId)
      .first<{ active_revision_id: string | null }>();
    const counts = await testEnv.DB.prepare(
      `SELECT
				(SELECT COUNT(*) FROM shiplet_revisions WHERE project_id = ?) AS revisions,
				(SELECT COUNT(*) FROM shiplet_revision_activations WHERE project_id = ?) AS activations`,
    )
      .bind(shipletId, shipletId)
      .first<{ revisions: number; activations: number }>();
    expect.soft(project?.active_revision_id).toBeNull();
    expect.soft(counts).toEqual({ revisions: 0, activations: 0 });
  });

  it("waits for custom initial validation and persists nothing when the runner fails", async () => {
    const shipletId = await insertProject();
    const runnerStarted = deferred<void>();
    const releaseRunner = deferred<void>();
    const validationRunner = {
      validate: async () => {
        runnerStarted.resolve(undefined);
        await releaseRunner.promise;
        return {
          ok: false as const,
          errors: [{ code: "custom_initial_check_failed", checkId: "custom" }],
        };
      },
    };
    const service = createRevisionService({ db: testEnv.DB, validationRunner });
    const initialPromise = service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const settledPromise = initialPromise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const firstOutcome = await Promise.race([
      runnerStarted.promise.then(() => "runner_started" as const),
      settledPromise.then(() => "initial_completed" as const),
    ]);
    expect.soft(firstOutcome).toBe("runner_started");

    const beforeRelease = await testEnv.DB.prepare(
      `SELECT active_revision_id,
			 (SELECT COUNT(*) FROM shiplet_revisions WHERE project_id = ?) AS revisions
			 FROM projects WHERE id = ?`,
    )
      .bind(shipletId, shipletId)
      .first<{ active_revision_id: string | null; revisions: number }>();
    expect.soft(beforeRelease).toEqual({
      active_revision_id: null,
      revisions: 0,
    });

    releaseRunner.resolve(undefined);
    const attempt = await settledPromise;
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: {
        code: "initial_validation_failed",
        errors: [{ code: "custom_initial_check_failed", checkId: "custom" }],
      },
    });
    const afterRelease = await testEnv.DB.prepare(
      `SELECT active_revision_id,
			 (SELECT COUNT(*) FROM shiplet_revisions WHERE project_id = ?) AS revisions,
			 (SELECT COUNT(*) FROM shiplet_revision_activations WHERE project_id = ?) AS activations
			 FROM projects WHERE id = ?`,
    )
      .bind(shipletId, shipletId, shipletId)
      .first<{
        active_revision_id: string | null;
        revisions: number;
        activations: number;
      }>();
    expect.soft(afterRelease).toEqual({
      active_revision_id: null,
      revisions: 0,
      activations: 0,
    });
  });

  it("leaves no orphan revision or files when initial creation races", async () => {
    const shipletId = await insertProject();
    const bothRunnersStarted = deferred<void>();
    const releaseRunners = deferred<void>();
    let runnerStarts = 0;
    const validationRunner = {
      validate: async () => {
        runnerStarts += 1;
        if (runnerStarts === 2) bothRunnersStarted.resolve(undefined);
        await releaseRunners.promise;
        return { ok: true as const, errors: [] };
      },
    };
    const serviceA = createRevisionService({
      db: testEnv.DB,
      validationRunner,
    });
    const serviceB = createRevisionService({
      db: testEnv.DB,
      validationRunner,
    });
    const creations = [serviceA, serviceB].map((service) =>
      service.createInitialRevision({
        shipletId,
        package: clonePackage(),
        actor: ACTOR,
      }),
    );
    const settledPromise = Promise.allSettled(creations);
    const firstOutcome = await Promise.race([
      bothRunnersStarted.promise.then(() => "both_started" as const),
      settledPromise.then(() => "creations_completed" as const),
    ]);
    expect.soft(firstOutcome).toBe("both_started");
    releaseRunners.resolve(undefined);
    const outcomes = await settledPromise;
    expect
      .soft(outcomes.map((outcome) => outcome.status).sort())
      .toEqual(["fulfilled", "rejected"]);

    const counts = await testEnv.DB.prepare(
      `SELECT
			 (SELECT COUNT(*) FROM shiplet_revisions WHERE project_id = ?) AS revisions,
			 (SELECT COUNT(*) FROM shiplet_revision_files
			  WHERE revision_id IN (SELECT id FROM shiplet_revisions WHERE project_id = ?)) AS files,
			 (SELECT COUNT(*) FROM shiplet_revision_seals
			  WHERE revision_id IN (SELECT id FROM shiplet_revisions WHERE project_id = ?)) AS seals,
			 (SELECT COUNT(*) FROM shiplet_revision_activations WHERE project_id = ?) AS activations`,
    )
      .bind(shipletId, shipletId, shipletId, shipletId)
      .first<{
        revisions: number;
        files: number;
        seals: number;
        activations: number;
      }>();
    expect.soft(counts).toEqual({
      revisions: 1,
      files: clonePackage().files.length,
      seals: 1,
      activations: 1,
    });
  });

  it("rejects initial provenance whose declared parent is not null", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const candidate = await packageWithProvenanceParent(
      clonePackage(),
      "revision_from_another_lineage",
    );

    await expectLifecycleFailure(
      () =>
        service.createInitialRevision({
          shipletId,
          package: candidate,
          actor: ACTOR,
        }),
      {
        code: "provenance_lineage_mismatch",
        path: "provenance.json.lineage.parentRevisionId",
        expectedParentRevisionId: null,
      },
    );
    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM shiplet_revisions WHERE project_id = ?",
    )
      .bind(shipletId)
      .first<{ count: number }>();
    expect.soft(count?.count).toBe(0);
  });

  it("rejects child provenance that does not match the draft base revision", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const candidate = await packageWithArtifact(
      "wrong provenance",
      "revision_from_another_lineage",
    );
    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: candidate,
      actor: ACTOR,
    });

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      actor: ACTOR,
    });
    expect.soft(validation).toMatchObject({
      ok: false,
      errors: [
        {
          code: "provenance_lineage_mismatch",
          path: "provenance.json.lineage.parentRevisionId",
        },
      ],
    });
    const count = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM shiplet_revisions WHERE project_id = ?",
    )
      .bind(shipletId)
      .first<{ count: number }>();
    expect.soft(count?.count).toBe(1);
  });

  it("generates the canonical child provenance when the package declares a null parent", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const candidate = clonePackage();
    const artifact = candidate.files.find(
      (file) => file.path === "artifact/index.html",
    );
    expect(artifact).toBeTruthy();
    if (!artifact) return;
    await replaceUtf8FileContent(
      candidate,
      artifact.path,
      "<!doctype html><main>canonical provenance</main>\n",
    );
    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: candidate,
      actor: ACTOR,
    });
    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      actor: ACTOR,
    });
    const revision = await service.getRevision({
      shipletId,
      revisionId: validation.revisionId,
    });
    const provenanceFile = revision.package.files.find(
      (file: PackageFile) => file.path === "provenance.json",
    );
    expect(provenanceFile).toBeTruthy();
    if (!provenanceFile) return;
    const provenance = JSON.parse(provenanceFile.content) as {
      lineage: { parentRevisionId: string | null };
    };
    expect.soft(provenance.lineage.parentRevisionId).toBe(initial.id);
  });

  it("forks package code and lineage without copying runtime authority or private state", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const sentinel = `fork-private-${crypto.randomUUID()}`;
    await insertKernelOwnedRecords({
      shipletId,
      revisionId: initial.id,
      sentinel,
    });

    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const exported = await service.exportDraftPackage({
      shipletId,
      draftId: draft.id,
    });
    const parsed = await parseShipletPackage(JSON.parse(exported));

    expect(draft).toMatchObject({
      shipletId,
      baseRevisionId: initial.id,
      version: 1,
      validationState: "pending",
    });
    expect(parsed.files.map((file: PackageFile) => file.path)).toEqual(
      clonePackage().files.map((file) => file.path),
    );
    expect(exported).not.toContain(sentinel);

    const stateCount = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM shiplet_state WHERE project_id = ?",
    )
      .bind(shipletId)
      .first<{ count: number }>();
    const grantCount = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM shiplet_capability_grants WHERE project_id = ?",
    )
      .bind(shipletId)
      .first<{ count: number }>();
    expect(stateCount?.count).toBe(1);
    expect(grantCount?.count).toBe(1);
  });

  it("uses optimistic draft versions so concurrent edits do not overwrite one another", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const firstEdit = await packageWithArtifact("first writer", initial.id);
    const staleEdit = await packageWithArtifact("stale writer", initial.id);

    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: 1,
      package: firstEdit,
      actor: ACTOR,
    });
    expect(updated.version).toBe(2);
    await expectLifecycleFailure(
      () =>
        service.updateDraft({
          shipletId,
          draftId: draft.id,
          expectedVersion: 1,
          package: staleEdit,
          actor: ACTOR,
        }),
      { code: "draft_conflict", currentVersion: 2 },
    );

    const persisted = await service.exportDraftPackage({
      shipletId,
      draftId: draft.id,
    });
    expect(persisted).toContain("first writer");
    expect(persisted).not.toContain("stale writer");
  });

  it("validates an exact draft version immutably without changing active bytes", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const changedPackage = await packageWithArtifact(
      "validated draft",
      initial.id,
    );
    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: changedPackage,
      actor: ACTOR,
    });
    const activeBytesBefore = await serializeShipletPackage(
      (await service.getActiveRevision({ shipletId })).package,
    );

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      actor: ACTOR,
    });
    expect(validation).toMatchObject({
      ok: true,
      draftVersion: updated.version,
    });
    expect(validation.revisionId).not.toBe(initial.id);
    expect(
      await service.validateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: updated.version,
        actor: ACTOR,
      }),
    ).toMatchObject({ ok: true, revisionId: validation.revisionId });

    const activeAfterSuccess = await service.getActiveRevision({ shipletId });
    expect(activeAfterSuccess.id).toBe(initial.id);
    expect(await serializeShipletPackage(activeAfterSuccess.package)).toBe(
      activeBytesBefore,
    );

    const invalidPackage = structuredClone(changedPackage);
    const artifact = invalidPackage.files.find(
      (file) => file.path === "artifact/index.html",
    );
    expect(artifact).toBeTruthy();
    if (!artifact) return;
    artifact.content += "tampered";
    artifact.size = new TextEncoder().encode(artifact.content).byteLength;
    const invalidUpdate = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      package: invalidPackage,
      actor: ACTOR,
    });
    const failedValidation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: invalidUpdate.version,
      actor: ACTOR,
    });

    expect(failedValidation).toMatchObject({
      ok: false,
      draftVersion: invalidUpdate.version,
      errors: [{ code: "digest_mismatch", path: "artifact/index.html" }],
    });
    expect((await service.getActiveRevision({ shipletId })).id).toBe(
      initial.id,
    );
    const immutableValidated = await service.getRevision({
      shipletId,
      revisionId: validation.revisionId,
    });
    expect(await serializeShipletPackage(immutableValidated.package)).toBe(
      await serializeShipletPackage(changedPackage),
    );
  });

  it("promotes with compare-and-swap and rejects a stale concurrent draft", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draftA = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const draftB = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });

    for (const [draft, label] of [
      [draftA, "draft A"],
      [draftB, "draft B"],
    ] as const) {
      const update = await service.updateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: draft.version,
        package: await packageWithArtifact(label, initial.id),
        actor: ACTOR,
      });
      await service.validateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: update.version,
        actor: ACTOR,
      });
    }

    const promoted = await service.promoteDraft({
      shipletId,
      draftId: draftA.id,
      expectedBaseRevisionId: initial.id,
      actor: ACTOR,
    });
    expect((await service.getActiveRevision({ shipletId })).id).toBe(
      promoted.revisionId,
    );

    await expectLifecycleFailure(
      () =>
        service.promoteDraft({
          shipletId,
          draftId: draftB.id,
          expectedBaseRevisionId: initial.id,
          actor: ACTOR,
        }),
      {
        code: "revision_conflict",
        expectedRevisionId: initial.id,
        currentRevisionId: promoted.revisionId,
      },
    );
    expect((await service.getActiveRevision({ shipletId })).id).toBe(
      promoted.revisionId,
    );

    const promotionAudit = await testEnv.DB.prepare(
      `SELECT event_kind, revision_id
			 FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'revision.promoted'`,
    )
      .bind(shipletId)
      .all<{ event_kind: string; revision_id: string }>();
    expect(promotionAudit.results).toEqual([
      {
        event_kind: "revision.promoted",
        revision_id: promoted.revisionId,
      },
    ]);
  });

  it("keeps the active revision and known-good deployment when preparation fails", async () => {
    const deploymentCalls: DeploymentRequest[] = [];
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: {
        prepareRevision: async (request: DeploymentRequest) => {
          deploymentCalls.push(request);
          throw Object.assign(new Error("provider unavailable"), {
            code: "provider_unavailable",
          });
        },
      },
    });
    const shipletId = await insertProject();
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetId = `target_${crypto.randomUUID()}`;
    const knownGoodDeploymentId = `deployment_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId,
      revisionId: initial.id,
      targetId,
      deploymentId: knownGoodDeploymentId,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("deployment candidate", initial.id),
      actor: ACTOR,
    });
    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    expect(validation.ok).toBe(true);

    await expectLifecycleFailure(
      () =>
        service.promoteDraft({
          shipletId,
          draftId: draft.id,
          expectedBaseRevisionId: initial.id,
          targetId,
          actor: ACTOR,
        }),
      { code: "deployment_failed" },
    );
    expect(deploymentCalls).toEqual([
      expect.objectContaining({
        shipletId,
        revisionId: validation.revisionId,
        targetId,
        reason: "promotion",
      }),
    ]);
    expect((await service.getActiveRevision({ shipletId })).id).toBe(
      initial.id,
    );

    const deployments = await testEnv.DB.prepare(
      `SELECT id, revision_id, status FROM shiplet_deployments
			 WHERE target_id = ? ORDER BY deployed_on ASC`,
    )
      .bind(targetId)
      .all<{ id: string; revision_id: string; status: string }>();
    expect(deployments.results).toEqual([
      {
        id: knownGoodDeploymentId,
        revision_id: initial.id,
        status: "healthy",
      },
    ]);
    const failureAudit = await testEnv.DB.prepare(
      `SELECT event_kind, status_category FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'revision.promotion_failed'`,
    )
      .bind(shipletId)
      .first<{ event_kind: string; status_category: string }>();
    expect(failureAudit).toEqual({
      event_kind: "revision.promotion_failed",
      status_category: "blocked",
    });
  });

  it("compensates partial multi-target provider activation without confirming the failed promotion", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetIds = [
      `target_a_${crypto.randomUUID()}`,
      `target_b_${crypto.randomUUID()}`,
    ];
    const priorDeployments = new Map<
      string,
      {
        deploymentId: string;
        providerVersionId: string;
        providerResourceName: string;
      }
    >();
    for (const [index, targetId] of targetIds.entries()) {
      const deploymentId = `deployment_prior_${index}_${crypto.randomUUID()}`;
      const sentinel = `target-${index}`;
      await insertKnownGoodDeployment({
        shipletId,
        revisionId: initial.id,
        targetId,
        deploymentId,
        sentinel,
      });
      priorDeployments.set(targetId, {
        deploymentId,
        providerVersionId: `provider-${initial.id}`,
        providerResourceName: `worker-${sentinel}`,
      });
    }
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact(
        "provider activation candidate",
        initial.id,
      ),
      actor: ACTOR,
    });
    const validation = await setupService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });

    const providerActiveVersion = new Map(
      targetIds.map((targetId) => [
        targetId,
        priorDeployments.get(targetId)!.providerVersionId,
      ]),
    );
    const activationCalls: ProviderFinalizationRequest[] = [];
    const restoreCalls: ProviderRollbackRequest[] = [];
    const abandonCalls: ProviderFinalizationRequest[] = [];
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => ({
        deploymentId: `deployment_candidate_${request.targetId}`,
        providerVersionId: `provider_candidate_${request.targetId}`,
        providerResourceName: `worker-candidate-${request.targetId}`,
        status: "healthy" as const,
      }),
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        activationCalls.push(request);
        if (request.targetId === targetIds[1]) {
          throw new Error("second target finalization failed");
        }
        providerActiveVersion.set(request.targetId, request.providerVersionId);
      },
      restorePriorRevision: async (request: ProviderRollbackRequest) => {
        restoreCalls.push(request);
        providerActiveVersion.set(
          request.targetId,
          request.previousDeployment.providerVersionId,
        );
      },
      abandonPreparedRevision: async (request: ProviderFinalizationRequest) => {
        abandonCalls.push(request);
      },
    };
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    });

    const [attempt] = await Promise.allSettled([
      service.promoteDraft({
        shipletId,
        draftId: draft.id,
        expectedBaseRevisionId: initial.id,
        targetIds,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "deployment_failed" },
    });
    expect
      .soft(activationCalls.map((call) => call.targetId))
      .toEqual(targetIds);
    expect.soft(restoreCalls).toEqual(
      [...targetIds].reverse().map((targetId) =>
        expect.objectContaining({
          targetId,
          previousDeployment: priorDeployments.get(targetId),
        }),
      ),
    );
    expect
      .soft(abandonCalls.map((call) => call.targetId).sort())
      .toEqual([...targetIds].sort());
    expect
      .soft(Object.fromEntries(providerActiveVersion))
      .toEqual(
        Object.fromEntries(
          targetIds.map((targetId) => [
            targetId,
            priorDeployments.get(targetId)!.providerVersionId,
          ]),
        ),
      );
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);

    const persisted = await testEnv.DB.prepare(
      `SELECT
			 (SELECT COUNT(*) FROM shiplet_deployments
			  WHERE revision_id = ? AND status = 'healthy') AS healthy_deployments,
			 (SELECT COUNT(*) FROM shiplet_revision_activations
			  WHERE project_id = ? AND revision_id = ? AND kind = 'promotion') AS activations,
			 (SELECT COUNT(*) FROM shiplet_audit_events
			  WHERE project_id = ? AND revision_id = ?
			  AND event_kind = 'revision.promoted') AS confirmed_audits`,
    )
      .bind(
        validation.revisionId,
        shipletId,
        validation.revisionId,
        shipletId,
        validation.revisionId,
      )
      .first<{
        healthy_deployments: number;
        activations: number;
        confirmed_audits: number;
      }>();
    expect.soft(persisted).toEqual({
      healthy_deployments: 0,
      activations: 0,
      confirmed_audits: 0,
    });

    const [rollbackAttempt] = await Promise.allSettled([
      service.rollbackRevision({
        shipletId,
        revisionId: validation.revisionId,
        expectedActiveRevisionId: initial.id,
        actor: ACTOR,
      }),
    ]);
    expect.soft(rollbackAttempt).toMatchObject({
      status: "rejected",
      reason: {
        code: "revision_not_known_good",
        revisionId: validation.revisionId,
      },
    });
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);
  });

  it.each(["precommit_assertion", "fence_completion"] as const)(
    "Given provider traffic moved, when %s fails, then the prior revision remains active and promotion is not confirmed",
    async (failurePoint) => {
      const shipletId = await insertProject();
      const setupService = createRevisionService({ db: testEnv.DB });
      const initial = await setupService.createInitialRevision({
        shipletId,
        package: clonePackage(),
        actor: ACTOR,
      });
      const targetId = `target_fenced_${crypto.randomUUID()}`;
      const priorDeploymentId = `deployment_prior_${crypto.randomUUID()}`;
      await insertKnownGoodDeployment({
        shipletId,
        revisionId: initial.id,
        targetId,
        deploymentId: priorDeploymentId,
        sentinel: "fenced-promotion",
      });
      const draft = await setupService.forkRevision({
        shipletId,
        revisionId: initial.id,
        actor: ACTOR,
      });
      const update = await setupService.updateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: draft.version,
        package: await packageWithArtifact("fenced candidate", initial.id),
        actor: ACTOR,
      });
      const validation = await setupService.validateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: update.version,
        actor: ACTOR,
      });
      const calls: string[] = [];
      let providerRevisionId = initial.id;
      const candidateDeploymentId = `deployment_candidate_${crypto.randomUUID()}`;
      const service = createRevisionService({
        db: testEnv.DB,
        deploymentCoordinator: {
          async prepareRevision() {
            calls.push("prepare");
            return {
              deploymentId: candidateDeploymentId,
              providerVersionId: `provider_${validation.revisionId}`,
              providerResourceName: "worker-fenced-promotion",
              status: "healthy" as const,
            };
          },
          async activatePreparedRevision(request) {
            calls.push("activate");
            providerRevisionId = request.revisionId;
          },
          async assertPreparedRevisionCommitAllowed() {
            calls.push("assert");
            if (failurePoint === "precommit_assertion") {
              throw new Error("target fence changed");
            }
          },
          async commitPreparedRevision() {
            calls.push("commit");
            if (failurePoint === "fence_completion") {
              throw new Error("fence completion unavailable");
            }
          },
          async restorePriorRevision(request) {
            calls.push("restore");
            providerRevisionId =
              request.previousDeployment.providerVersionId.replace(
                /^provider-/,
                "",
              );
            providerRevisionId = initial.id;
          },
          async abandonPreparedRevision() {
            calls.push("abandon");
          },
        },
      });

      await expectLifecycleFailure(
        () =>
          service.promoteDraft({
            shipletId,
            draftId: draft.id,
            expectedBaseRevisionId: initial.id,
            targetId,
            actor: ACTOR,
          }),
        { code: "deployment_failed" },
      );

      expect.soft(calls.slice(0, 3)).toEqual(["prepare", "activate", "assert"]);
      if (failurePoint === "fence_completion") {
        expect.soft(calls).toContain("commit");
      } else {
        expect.soft(calls).not.toContain("commit");
      }
      expect.soft(calls).toContain("restore");
      expect.soft(providerRevisionId).toBe(initial.id);
      expect
        .soft((await service.getActiveRevision({ shipletId })).id)
        .toBe(initial.id);
      const candidateDeployment = await testEnv.DB.prepare(
        "SELECT status FROM shiplet_deployments WHERE id = ?",
      )
        .bind(candidateDeploymentId)
        .first<{ status: string }>();
      expect.soft(candidateDeployment?.status ?? null).not.toBe("healthy");
      const confirmedAudit = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_audit_events
         WHERE project_id = ? AND revision_id = ?
         AND event_kind = 'revision.promoted'`,
      )
        .bind(shipletId, validation.revisionId)
        .first<{ count: number }>();
      expect.soft(confirmedAudit?.count).toBe(0);
      const operation = await testEnv.DB.prepare(
        `SELECT status FROM shiplet_revision_operations
         WHERE project_id = ? ORDER BY created_on DESC LIMIT 1`,
      )
        .bind(shipletId)
        .first<{ status: string }>();
      expect.soft(operation?.status).toBe("compensated");
    },
  );

  it("journals ambiguous provider success and idempotently recovers an expired operation lease", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetIds = [
      `target_journal_a_${crypto.randomUUID()}`,
      `target_journal_b_${crypto.randomUUID()}`,
    ];
    const priorDeployments = new Map<
      string,
      {
        deploymentId: string;
        providerVersionId: string;
        providerResourceName: string;
      }
    >();
    for (const [index, targetId] of targetIds.entries()) {
      const deploymentId = `deployment_journal_prior_${index}_${crypto.randomUUID()}`;
      const sentinel = `journal-target-${index}`;
      await insertKnownGoodDeployment({
        shipletId,
        revisionId: initial.id,
        targetId,
        deploymentId,
        sentinel,
      });
      priorDeployments.set(targetId, {
        deploymentId,
        providerVersionId: `provider-${initial.id}`,
        providerResourceName: `worker-${sentinel}`,
      });
    }
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact(
        "durable operation journal",
        initial.id,
      ),
      actor: ACTOR,
    });
    const validation = await setupService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const candidateDeploymentIds = targetIds.map(
      (targetId) => `deployment_journal_candidate_${targetId}`,
    );
    const providerActiveVersion = new Map(
      targetIds.map((targetId) => [
        targetId,
        priorDeployments.get(targetId)!.providerVersionId,
      ]),
    );
    const failedRestoreCalls: string[] = [];
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => ({
        deploymentId: `deployment_journal_candidate_${request.targetId}`,
        providerVersionId: `provider_journal_candidate_${request.targetId}`,
        providerResourceName: `worker-journal-candidate-${request.targetId}`,
        status: "healthy" as const,
      }),
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        providerActiveVersion.set(request.targetId, request.providerVersionId);
        if (request.targetId === targetIds[1]) {
          throw new Error("provider accepted activation before response loss");
        }
      },
      restorePriorRevision: async (request: ProviderRollbackRequest) => {
        failedRestoreCalls.push(request.targetId);
        throw new Error("provider restoration unavailable");
      },
      abandonPreparedRevision: async () => {},
    };
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    });

    await expectLifecycleFailure(
      () =>
        service.promoteDraft({
          shipletId,
          draftId: draft.id,
          expectedBaseRevisionId: initial.id,
          targetIds,
          actor: ACTOR,
        }),
      { code: "deployment_failed" },
    );
    expect.soft(failedRestoreCalls.sort()).toEqual([...targetIds].sort());
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);

    type OperationRow = {
      id: string;
      kind: string;
      candidate_revision_id: string;
      prior_revision_id: string;
      status: string;
      target_ids_json: string;
      deployment_ids_json: string;
      reconciliation_json: string;
      lease_expires_on: string | null;
      idempotency_key: string;
      last_error_code: string;
    };
    const operation = await testEnv.DB.prepare(
      `SELECT id, kind, candidate_revision_id, prior_revision_id, status,
			 target_ids_json, deployment_ids_json, reconciliation_json,
			 lease_expires_on, idempotency_key, last_error_code
			 FROM shiplet_revision_operations
			 WHERE project_id = ? AND candidate_revision_id = ?
			 ORDER BY created_on DESC LIMIT 1`,
    )
      .bind(shipletId, validation.revisionId)
      .first<OperationRow>();
    expect.soft(operation).toMatchObject({
      id: expect.stringMatching(/^revision_operation_/),
      kind: "promotion",
      candidate_revision_id: validation.revisionId,
      prior_revision_id: initial.id,
      status: "reconciliation_required",
      idempotency_key: expect.stringMatching(/^revision_operation_/),
      last_error_code: "provider_restore_failed",
    });
    expect
      .soft(JSON.parse(operation?.target_ids_json ?? "null"))
      .toEqual(targetIds);
    expect
      .soft(JSON.parse(operation?.deployment_ids_json ?? "null"))
      .toEqual(candidateDeploymentIds);
    expect
      .soft(JSON.parse(operation?.reconciliation_json ?? "null"))
      .toMatchObject({
        ambiguousTargetIds: [targetIds[1]],
        reconciliationRequiredTargetIds: targetIds,
      });

    const failureAudit = await testEnv.DB.prepare(
      `SELECT payload_json FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'revision.promotion_failed'
			 ORDER BY recorded_on DESC LIMIT 1`,
    )
      .bind(shipletId)
      .first<{ payload_json: string }>();
    expect
      .soft(JSON.parse(failureAudit?.payload_json ?? "null"))
      .toMatchObject({
        operationId: operation?.id,
        targetIds,
        deploymentIds: candidateDeploymentIds,
        ambiguousTargetIds: [targetIds[1]],
        reconciliationRequiredTargetIds: targetIds,
      });

    if (!operation) return;
    await testEnv.DB.prepare(
      `UPDATE shiplet_revision_operations
			 SET status = 'restoring', lease_expires_on = ?
			 WHERE id = ?`,
    )
      .bind("2000-01-01T00:00:00.000Z", operation.id)
      .run();
    const recoveryCalls: string[] = [];
    const recoveryService = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: {
        prepareRevision: coordinator.prepareRevision,
        restorePriorRevision: async (request: ProviderRollbackRequest) => {
          recoveryCalls.push(request.targetId);
          providerActiveVersion.set(
            request.targetId,
            request.previousDeployment.providerVersionId,
          );
        },
      },
    });
    type RecoveryService = typeof recoveryService & {
      recoverRevisionOperation(input: {
        shipletId: string;
        operationId: string;
        actor: typeof ACTOR;
      }): Promise<{ operationId: string; status: string }>;
    };
    const recoverRevisionOperation = (
      recoveryService as RecoveryService
    ).recoverRevisionOperation.bind(recoveryService);
    const recovered = await recoverRevisionOperation({
      shipletId,
      operationId: operation.id,
      actor: ACTOR,
    });
    const repeatedRecovery = await recoverRevisionOperation({
      shipletId,
      operationId: operation.id,
      actor: ACTOR,
    });
    expect.soft(recovered).toMatchObject({
      operationId: operation.id,
      status: "compensated",
    });
    expect.soft(repeatedRecovery).toMatchObject({
      operationId: operation.id,
      status: "compensated",
    });
    expect.soft(recoveryCalls.sort()).toEqual([...targetIds].sort());
    expect
      .soft(Object.fromEntries(providerActiveVersion))
      .toEqual(
        Object.fromEntries(
          targetIds.map((targetId) => [
            targetId,
            priorDeployments.get(targetId)!.providerVersionId,
          ]),
        ),
      );
    const recoveredOperation = await testEnv.DB.prepare(
      `SELECT status, lease_expires_on FROM shiplet_revision_operations
			 WHERE id = ? AND project_id = ?`,
    )
      .bind(operation.id, shipletId)
      .first<{ status: string; lease_expires_on: string | null }>();
    expect.soft(recoveredOperation).toEqual({
      status: "compensated",
      lease_expires_on: null,
    });
  });

  it("rolls back atomically through a new deployment without rewinding state", async () => {
    const deploymentCalls: DeploymentRequest[] = [];
    const rollbackDeploymentId = `deployment_rollback_${crypto.randomUUID()}`;
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: {
        prepareRevision: async (request: DeploymentRequest) => {
          deploymentCalls.push(request);
          return {
            deploymentId: rollbackDeploymentId,
            providerVersionId: "provider_revision_rollback",
            status: "healthy" as const,
          };
        },
      },
    });
    const shipletId = await insertProject();
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("revision two", initial.id),
      actor: ACTOR,
    });
    await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const promoted = await service.promoteDraft({
      shipletId,
      draftId: draft.id,
      expectedBaseRevisionId: initial.id,
      actor: ACTOR,
    });
    const targetId = `target_${crypto.randomUUID()}`;
    const activeDeploymentId = `deployment_active_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId,
      revisionId: promoted.revisionId,
      targetId,
      deploymentId: activeDeploymentId,
    });
    const stateSentinel = `state-survives-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await testEnv.DB.prepare(
      `INSERT INTO shiplet_state (
				project_id, deployment_id, namespace, key, value_json,
				byte_size, version, updated_on
			) VALUES (?, ?, 'workflow', 'counter', ?, ?, 7, ?)`,
    )
      .bind(
        shipletId,
        activeDeploymentId,
        JSON.stringify({ value: stateSentinel }),
        stateSentinel.length,
        now,
      )
      .run();

    const rolledBack = await service.rollbackRevision({
      shipletId,
      revisionId: initial.id,
      expectedActiveRevisionId: promoted.revisionId,
      targetId,
      actor: ACTOR,
    });

    expect(rolledBack).toMatchObject({
      activeRevisionId: initial.id,
      previousRevisionId: promoted.revisionId,
      deploymentId: rollbackDeploymentId,
    });
    expect((await service.getActiveRevision({ shipletId })).id).toBe(
      initial.id,
    );
    expect(deploymentCalls).toEqual([
      expect.objectContaining({
        shipletId,
        revisionId: initial.id,
        targetId,
        reason: "rollback",
      }),
    ]);

    const state = await testEnv.DB.prepare(
      `SELECT value_json, version FROM shiplet_state
			 WHERE project_id = ? AND deployment_id = ?
			 AND namespace = 'workflow' AND key = 'counter'`,
    )
      .bind(shipletId, activeDeploymentId)
      .first<{ value_json: string; version: number }>();
    expect(state).toEqual({
      value_json: JSON.stringify({ value: stateSentinel }),
      version: 7,
    });

    const deployment = await testEnv.DB.prepare(
      `SELECT revision_id, status, supersedes_deployment_id
			 FROM shiplet_deployments WHERE id = ?`,
    )
      .bind(rollbackDeploymentId)
      .first<{
        revision_id: string;
        status: string;
        supersedes_deployment_id: string;
      }>();
    expect(deployment).toEqual({
      revision_id: initial.id,
      status: "healthy",
      supersedes_deployment_id: activeDeploymentId,
    });

    const rollbackAudit = await testEnv.DB.prepare(
      `SELECT event_kind, revision_id FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'revision.rolled_back'`,
    )
      .bind(shipletId)
      .first<{ event_kind: string; revision_id: string }>();
    expect(rollbackAudit).toEqual({
      event_kind: "revision.rolled_back",
      revision_id: initial.id,
    });
  });

  it("coordinates rollback across every attached deployment target", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("multi-target active", initial.id),
      actor: ACTOR,
    });
    await setupService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const promoted = await setupService.promoteDraft({
      shipletId,
      draftId: draft.id,
      expectedBaseRevisionId: initial.id,
      actor: ACTOR,
    });
    const targetIds = [
      `target_a_${crypto.randomUUID()}`,
      `target_b_${crypto.randomUUID()}`,
    ];
    for (const targetId of targetIds) {
      await insertKnownGoodDeployment({
        shipletId,
        revisionId: promoted.revisionId,
        targetId,
        deploymentId: `deployment_active_${targetId}`,
      });
    }
    const preparedCalls: DeploymentRequest[] = [];
    const activationCalls: ProviderFinalizationRequest[] = [];
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => {
        preparedCalls.push(request);
        return {
          deploymentId: `deployment_rollback_${request.targetId}`,
          providerVersionId: `provider_rollback_${request.targetId}`,
          status: "healthy" as const,
        };
      },
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        activationCalls.push(request);
      },
    };
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    });
    const rollbackRevision = service.rollbackRevision as unknown as (
      input: MultiTargetRollbackInput,
    ) => Promise<{
      activeRevisionId: string;
      deploymentIds: string[];
    }>;

    const result = await rollbackRevision({
      shipletId,
      revisionId: initial.id,
      expectedActiveRevisionId: promoted.revisionId,
      targetIds,
      actor: ACTOR,
    });
    expect.soft(result).toMatchObject({
      activeRevisionId: initial.id,
      deploymentIds: targetIds.map(
        (targetId) => `deployment_rollback_${targetId}`,
      ),
    });
    expect
      .soft(preparedCalls.map((call) => call.targetId).sort())
      .toEqual([...targetIds].sort());
    expect
      .soft(activationCalls.map((call) => call.targetId).sort())
      .toEqual([...targetIds].sort());
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);
    const deployments = await testEnv.DB.prepare(
      `SELECT target_id, revision_id, status FROM shiplet_deployments
			 WHERE id IN (?, ?) ORDER BY target_id`,
    )
      .bind(...targetIds.map((targetId) => `deployment_rollback_${targetId}`))
      .all<{ target_id: string; revision_id: string; status: string }>();
    expect.soft(deployments.results).toEqual(
      [...targetIds].sort().map((targetId) => ({
        target_id: targetId,
        revision_id: initial.id,
        status: "healthy",
      })),
    );
    const rollbackAudit = await testEnv.DB.prepare(
      `SELECT deployment_id, payload_json
			 FROM shiplet_audit_events
			 WHERE project_id = ? AND event_kind = 'revision.rolled_back'
			 ORDER BY recorded_on DESC LIMIT 1`,
    )
      .bind(shipletId)
      .first<{ deployment_id: string; payload_json: string }>();
    expect
      .soft(rollbackAudit?.deployment_id)
      .toBe(`deployment_rollback_${targetIds[0]}`);
    const rollbackPayload = JSON.parse(
      rollbackAudit?.payload_json ?? "null",
    ) as {
      operationId?: string;
      targetIds?: string[];
      deploymentIds?: string[];
      providerVersionIds?: string[];
    };
    expect.soft(rollbackPayload).toMatchObject({
      operationId: expect.stringMatching(/^revision_operation_/),
      targetIds,
      deploymentIds: targetIds.map(
        (targetId) => `deployment_rollback_${targetId}`,
      ),
      providerVersionIds: targetIds.map(
        (targetId) => `provider_rollback_${targetId}`,
      ),
    });
  });

  it("compensates provider and D1 when multi-target rollback finalization partially fails", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("rollback failure active", initial.id),
      actor: ACTOR,
    });
    await setupService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const promoted = await setupService.promoteDraft({
      shipletId,
      draftId: draft.id,
      expectedBaseRevisionId: initial.id,
      actor: ACTOR,
    });
    const targetIds = [
      `target_a_${crypto.randomUUID()}`,
      `target_b_${crypto.randomUUID()}`,
    ];
    const priorDeployments = new Map<
      string,
      {
        deploymentId: string;
        providerVersionId: string;
        providerResourceName: string;
      }
    >();
    for (const [index, targetId] of targetIds.entries()) {
      const sentinel = `rollback-target-${index}`;
      const deploymentId = `deployment_active_${index}_${crypto.randomUUID()}`;
      await insertKnownGoodDeployment({
        shipletId,
        revisionId: promoted.revisionId,
        targetId,
        deploymentId,
        sentinel,
      });
      priorDeployments.set(targetId, {
        deploymentId,
        providerVersionId: `provider-${promoted.revisionId}`,
        providerResourceName: `worker-${sentinel}`,
      });
    }
    const providerActiveVersion = new Map(
      targetIds.map((targetId) => [
        targetId,
        priorDeployments.get(targetId)!.providerVersionId,
      ]),
    );
    const restoreCalls: ProviderRollbackRequest[] = [];
    const abandonCalls: ProviderFinalizationRequest[] = [];
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => ({
        deploymentId: `deployment_failed_rollback_${request.targetId}`,
        providerVersionId: `provider_failed_rollback_${request.targetId}`,
        status: "healthy" as const,
      }),
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        if (request.targetId === targetIds[1]) {
          throw new Error("second rollback finalization failed");
        }
        providerActiveVersion.set(request.targetId, request.providerVersionId);
      },
      restorePriorRevision: async (request: ProviderRollbackRequest) => {
        restoreCalls.push(request);
        providerActiveVersion.set(
          request.targetId,
          request.previousDeployment.providerVersionId,
        );
      },
      abandonPreparedRevision: async (request: ProviderFinalizationRequest) => {
        abandonCalls.push(request);
      },
    };
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    });
    const rollbackRevision = service.rollbackRevision as unknown as (
      input: MultiTargetRollbackInput,
    ) => Promise<unknown>;

    const [attempt] = await Promise.allSettled([
      rollbackRevision({
        shipletId,
        revisionId: initial.id,
        expectedActiveRevisionId: promoted.revisionId,
        targetIds,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "deployment_failed" },
    });
    expect.soft(restoreCalls).toEqual(
      [...targetIds].reverse().map((targetId) =>
        expect.objectContaining({
          targetId,
          previousDeployment: priorDeployments.get(targetId),
        }),
      ),
    );
    expect
      .soft(abandonCalls.map((call) => call.targetId).sort())
      .toEqual([...targetIds].sort());
    expect
      .soft(Object.fromEntries(providerActiveVersion))
      .toEqual(
        Object.fromEntries(
          targetIds.map((targetId) => [
            targetId,
            priorDeployments.get(targetId)!.providerVersionId,
          ]),
        ),
      );
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(promoted.revisionId);
    const persisted = await testEnv.DB.prepare(
      `SELECT
			 (SELECT COUNT(*) FROM shiplet_deployments
			  WHERE revision_id = ? AND id LIKE 'deployment_failed_rollback_%'
			  AND status = 'healthy') AS healthy_deployments,
			 (SELECT COUNT(*) FROM shiplet_revision_activations
			  WHERE project_id = ? AND revision_id = ? AND kind = 'rollback') AS activations,
			 (SELECT COUNT(*) FROM shiplet_audit_events
			  WHERE project_id = ? AND revision_id = ?
			  AND event_kind = 'revision.rolled_back') AS confirmed_audits`,
    )
      .bind(initial.id, shipletId, initial.id, shipletId, initial.id)
      .first<{
        healthy_deployments: number;
        activations: number;
        confirmed_audits: number;
      }>();
    expect.soft(persisted).toEqual({
      healthy_deployments: 0,
      activations: 0,
      confirmed_audits: 0,
    });
  });

  it("exports only the portable package and excludes kernel-owned records", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const sentinel = `export-private-${crypto.randomUUID()}`;
    await insertKernelOwnedRecords({
      shipletId,
      revisionId: initial.id,
      sentinel,
    });

    const exported = await service.exportRevisionPackage({
      shipletId,
      revisionId: initial.id,
    });
    const raw = JSON.parse(exported) as Record<string, unknown>;
    await expect(parseShipletPackage(raw)).resolves.toMatchObject({
      manifest: {
        schemaVersion: "shiplet.package/v1",
        requestedCapabilities: ["state.read:review", "workflow.event:create"],
      },
    });
    expect(Object.keys(raw).sort()).toEqual(["files", "manifest", "mediaType"]);
    expect(exported).not.toContain(sentinel);
    expect(exported).not.toMatch(
      /"(?:accessGrants|auditHistory|claimUrl|cloudflareConnections|credentials|deployments|sessions|state)"\s*:/i,
    );
  });

  it("runs declared validation checks and leaves active unchanged when one fails", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const candidate = clonePackage();
    await packageWithProvenanceParent(candidate, initial.id);
    await replaceUtf8FileContent(
      candidate,
      "validation/manifest.json",
      `${JSON.stringify({
        schemaVersion: "shiplet.validation/v1",
        checks: [
          {
            id: "required-review-summary",
            kind: "file-exists",
            path: "artifact/review-summary.html",
          },
        ],
      })}\n`,
    );
    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: candidate,
      actor: ACTOR,
    });

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      actor: ACTOR,
    });

    expect(validation).toMatchObject({
      ok: false,
      draftVersion: updated.version,
      errors: [
        {
          code: "declared_check_failed",
          path: "validation/manifest.json",
          checkId: "required-review-summary",
        },
      ],
    });
    expect((await service.getActiveRevision({ shipletId })).id).toBe(
      initial.id,
    );
  });

  it("rejects toJSON smuggling before draft persistence and preserves the prior snapshot", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const sentinel = `to-json-smuggle-${crypto.randomUUID()}`;
    const candidate = await packageWithArtifact(
      "apparently safe draft",
      initial.id,
    );
    Object.defineProperty(candidate, "toJSON", {
      enumerable: false,
      value: () => ({ ...candidate, state: { private: sentinel } }),
    });

    const [attempt] = await Promise.allSettled([
      service.updateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: draft.version,
        package: candidate,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "non_plain_data", path: "toJSON" },
    });

    const persisted = await testEnv.DB.prepare(
      `SELECT package_json, version FROM shiplet_drafts
			 WHERE id = ? AND project_id = ?`,
    )
      .bind(draft.id, shipletId)
      .first<{ package_json: string; version: number }>();
    expect.soft(persisted?.version).toBe(1);
    expect.soft(persisted?.package_json).not.toContain(sentinel);
    expect.soft(persisted?.package_json).not.toMatch(/"state"\s*:/);
  });

  it("rejects cumulative UTF-8 draft input before persistence", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const oversizedDraft = clonePackage();
    const source = oversizedDraft.files.find(
      (file) => file.path === "artifact/icon.bin",
    );
    expect(source).toBeTruthy();
    if (!source) return;
    const oneMiB = "x".repeat(1024 * 1024);
    for (let index = 0; index < 33; index += 1) {
      oversizedDraft.files.push({
        ...source,
        path: `artifact/oversized-${index}.txt`,
        mediaType: "text/plain; charset=utf-8",
        encoding: "utf8",
        content: oneMiB,
        size: oneMiB.length,
      });
    }

    const [attempt] = await Promise.allSettled([
      service.updateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: draft.version,
        package: oversizedDraft,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "input_too_large", path: "$" },
    });
    const persisted = await testEnv.DB.prepare(
      `SELECT package_json, version FROM shiplet_drafts
			 WHERE id = ? AND project_id = ?`,
    )
      .bind(draft.id, shipletId)
      .first<{ package_json: string; version: number }>();
    expect.soft(persisted?.version).toBe(1);
    expect.soft(persisted?.package_json).not.toContain("artifact/oversized-");
  });

  it("rejects rollback to a revision that has never been active or known-good", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact(
        "validated but never active",
        initial.id,
      ),
      actor: ACTOR,
    });
    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      actor: ACTOR,
    });
    expect(validation.ok).toBe(true);

    const [attempt] = await Promise.allSettled([
      service.rollbackRevision({
        shipletId,
        revisionId: validation.revisionId,
        expectedActiveRevisionId: initial.id,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: {
        code: "revision_not_known_good",
        revisionId: validation.revisionId,
      },
    });
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);
  });

  it("requires promotion to include every attached deployment target", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetId = `target_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId,
      revisionId: initial.id,
      targetId,
      deploymentId: `deployment_${crypto.randomUUID()}`,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const updated = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact(
        "must deploy attached target",
        initial.id,
      ),
      actor: ACTOR,
    });
    await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: updated.version,
      actor: ACTOR,
    });

    const [attempt] = await Promise.allSettled([
      service.promoteDraft({
        shipletId,
        draftId: draft.id,
        expectedBaseRevisionId: initial.id,
        actor: ACTOR,
      }),
    ]);
    expect.soft(attempt).toMatchObject({
      status: "rejected",
      reason: { code: "deployment_target_required", targetId },
    });
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);
  });

  it("conflicts when a deployment target attaches while promotion is preparing", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const existingTargetId = `target_existing_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId,
      revisionId: initial.id,
      targetId: existingTargetId,
      deploymentId: `deployment_initial_${crypto.randomUUID()}`,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("attach race", initial.id),
      actor: ACTOR,
    });
    const validation = await setupService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const prepareStarted = deferred<void>();
    const releasePrepare = deferred<void>();
    const abandoned: string[] = [];
    const activated: string[] = [];
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => {
        prepareStarted.resolve(undefined);
        await releasePrepare.promise;
        return {
          deploymentId: `deployment_attach_race_${request.targetId}`,
          providerVersionId: `provider_attach_race_${request.targetId}`,
          status: "healthy" as const,
        };
      },
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        activated.push(request.targetId);
      },
      abandonPreparedRevision: async (request: ProviderFinalizationRequest) => {
        abandoned.push(request.targetId);
      },
    };
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    });
    const promotion = service.promoteDraft({
      shipletId,
      draftId: draft.id,
      expectedBaseRevisionId: initial.id,
      targetIds: [existingTargetId],
      actor: ACTOR,
    });
    await prepareStarted.promise;
    const newlyAttachedTargetId = `target_new_${crypto.randomUUID()}`;
    await insertDeploymentTarget({
      shipletId,
      targetId: newlyAttachedTargetId,
    });
    releasePrepare.resolve(undefined);

    await expect(promotion).rejects.toMatchObject({
      code: "deployment_target_conflict",
    });
    expect.soft(abandoned).toEqual([existingTargetId]);
    expect.soft(activated).toEqual([]);
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);
    const candidateDeployments = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM shiplet_deployments
			 WHERE revision_id = ? AND status = 'healthy'`,
    )
      .bind(validation.revisionId)
      .first<{ count: number }>();
    expect.soft(candidateDeployments?.count).toBe(0);
  });

  it("conflicts when a deployment target detaches while promotion is preparing", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetId = `target_detach_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId,
      revisionId: initial.id,
      targetId,
      deploymentId: `deployment_initial_${crypto.randomUUID()}`,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("detach race", initial.id),
      actor: ACTOR,
    });
    const validation = await setupService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const prepareStarted = deferred<void>();
    const releasePrepare = deferred<void>();
    const abandoned: string[] = [];
    const activated: string[] = [];
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => {
        prepareStarted.resolve(undefined);
        await releasePrepare.promise;
        return {
          deploymentId: `deployment_detach_race_${request.targetId}`,
          providerVersionId: `provider_detach_race_${request.targetId}`,
          status: "healthy" as const,
        };
      },
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        activated.push(request.targetId);
      },
      abandonPreparedRevision: async (request: ProviderFinalizationRequest) => {
        abandoned.push(request.targetId);
      },
    };
    const service = createRevisionService({
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    });
    const promotion = service.promoteDraft({
      shipletId,
      draftId: draft.id,
      expectedBaseRevisionId: initial.id,
      targetIds: [targetId],
      actor: ACTOR,
    });
    await prepareStarted.promise;
    await testEnv.DB.prepare(
      "UPDATE deployment_targets SET detached_on = ? WHERE id = ? AND project_id = ?",
    )
      .bind(new Date().toISOString(), targetId, shipletId)
      .run();
    releasePrepare.resolve(undefined);

    await expect(promotion).rejects.toMatchObject({
      code: "deployment_target_conflict",
    });
    expect.soft(abandoned).toEqual([targetId]);
    expect.soft(activated).toEqual([]);
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(initial.id);
    const candidateDeployments = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM shiplet_deployments
			 WHERE revision_id = ? AND status = 'healthy'`,
    )
      .bind(validation.revisionId)
      .first<{ count: number }>();
    expect.soft(candidateDeployments?.count).toBe(0);
  });

  it("abandons the losing prepared deployment and activates only the CAS winner", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetId = `target_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId,
      revisionId: initial.id,
      targetId,
      deploymentId: `deployment_initial_${crypto.randomUUID()}`,
    });

    const validated: Array<{ draftId: string; revisionId: string }> = [];
    for (const label of ["concurrent A", "concurrent B"]) {
      const draft = await setupService.forkRevision({
        shipletId,
        revisionId: initial.id,
        actor: ACTOR,
      });
      const update = await setupService.updateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: draft.version,
        package: await packageWithArtifact(label, initial.id),
        actor: ACTOR,
      });
      const result = await setupService.validateDraft({
        shipletId,
        draftId: draft.id,
        expectedVersion: update.version,
        actor: ACTOR,
      });
      validated.push({ draftId: draft.id, revisionId: result.revisionId });
    }

    const ready = new Map(
      validated.map(({ revisionId }) => [revisionId, deferred<void>()]),
    );
    const release = new Map(
      validated.map(({ revisionId }) => [revisionId, deferred<void>()]),
    );
    const providerState = {
      activeRevisionId: initial.id,
      preparedRevisionIds: new Set<string>(),
      abandonedRevisionIds: new Set<string>(),
    };
    const coordinator = {
      prepareRevision: async (request: DeploymentRequest) => {
        providerState.preparedRevisionIds.add(request.revisionId);
        ready.get(request.revisionId)?.resolve(undefined);
        await release.get(request.revisionId)?.promise;
        return {
          deploymentId: `deployment_${request.revisionId}`,
          providerVersionId: `provider_${request.revisionId}`,
          status: "healthy" as const,
        };
      },
      activatePreparedRevision: async (
        request: ProviderFinalizationRequest,
      ) => {
        providerState.preparedRevisionIds.delete(request.revisionId);
        providerState.activeRevisionId = request.revisionId;
      },
      abandonPreparedRevision: async (request: ProviderFinalizationRequest) => {
        providerState.preparedRevisionIds.delete(request.revisionId);
        providerState.abandonedRevisionIds.add(request.revisionId);
      },
    };
    const serviceOptions = {
      db: testEnv.DB,
      deploymentCoordinator: coordinator,
    };
    const service = createRevisionService(serviceOptions);
    const [candidateA, candidateB] = validated;

    const promotionA = service.promoteDraft({
      shipletId,
      draftId: candidateA.draftId,
      expectedBaseRevisionId: initial.id,
      targetId,
      actor: ACTOR,
    });
    await ready.get(candidateA.revisionId)?.promise;
    const promotionB = service.promoteDraft({
      shipletId,
      draftId: candidateB.draftId,
      expectedBaseRevisionId: initial.id,
      targetId,
      actor: ACTOR,
    });
    await ready.get(candidateB.revisionId)?.promise;
    release.get(candidateB.revisionId)?.resolve(undefined);
    await expect(promotionB).resolves.toMatchObject({
      revisionId: candidateB.revisionId,
    });
    release.get(candidateA.revisionId)?.resolve(undefined);
    await expect(promotionA).rejects.toMatchObject({
      code: "revision_conflict",
      currentRevisionId: candidateB.revisionId,
    });

    expect.soft(providerState.activeRevisionId).toBe(candidateB.revisionId);
    expect.soft([...providerState.preparedRevisionIds]).toEqual([]);
    expect
      .soft([...providerState.abandonedRevisionIds])
      .toEqual([candidateA.revisionId]);
    expect
      .soft((await service.getActiveRevision({ shipletId })).id)
      .toBe(candidateB.revisionId);
    const deployments = await testEnv.DB.prepare(
      `SELECT revision_id FROM shiplet_deployments
			 WHERE target_id = ? AND revision_id != ?`,
    )
      .bind(targetId, initial.id)
      .all<{ revision_id: string }>();
    expect
      .soft(deployments.results)
      .toEqual([{ revision_id: candidateB.revisionId }]);
  });

  it("rejects every project-crossing revision, deployment, activation, grant, and state relationship", async () => {
    const shipletA = await insertProject();
    const shipletB = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const revisionA = await service.createInitialRevision({
      shipletId: shipletA,
      package: clonePackage(),
      actor: ACTOR,
    });
    const revisionB = await service.createInitialRevision({
      shipletId: shipletB,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetA = `target_a_${crypto.randomUUID()}`;
    const targetB = `target_b_${crypto.randomUUID()}`;
    const deploymentA = `deployment_a_${crypto.randomUUID()}`;
    const deploymentB = `deployment_b_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId: shipletA,
      revisionId: revisionA.id,
      targetId: targetA,
      deploymentId: deploymentA,
    });
    await insertKnownGoodDeployment({
      shipletId: shipletB,
      revisionId: revisionB.id,
      targetId: targetB,
      deploymentId: deploymentB,
    });
    const timestamp = new Date().toISOString();
    const crossRevisionId = `revision_cross_${crypto.randomUUID()}`;
    const crossDeploymentId = `deployment_cross_${crypto.randomUUID()}`;
    const operations: Array<[string, () => Promise<unknown>]> = [
      [
        "revision parent",
        () =>
          testEnv.DB.prepare(
            `INSERT INTO shiplet_revisions (
						 id, project_id, parent_revision_id, package_json, package_digest,
						 runtime_compatibility, validation_report_json,
						 created_by_actor_kind, created_by_actor_id, created_on
						) VALUES (?, ?, ?, '{}', ?, 'shiplet.runtime/v1',
						 '{"ok":true,"errors":[]}', 'system', 'isolation-test', ?)`,
          )
            .bind(
              crossRevisionId,
              shipletA,
              revisionB.id,
              `digest_${crypto.randomUUID()}`,
              timestamp,
            )
            .run(),
      ],
      [
        "deployment revision",
        () =>
          testEnv.DB.prepare(
            `INSERT INTO shiplet_deployments (
						 id, target_id, revision_id, provider_resource_name,
						 provider_version_id, status, health_json, deployed_on,
						 failed_on, supersedes_deployment_id
						) VALUES (?, ?, ?, 'cross-project-worker', 'cross-project-version',
						 'healthy', '{"status":"healthy"}', ?, NULL, NULL)`,
          )
            .bind(crossDeploymentId, targetA, revisionB.id, timestamp)
            .run(),
      ],
      [
        "activation revision",
        () =>
          testEnv.DB.prepare(
            `INSERT INTO shiplet_revision_activations (
						 id, project_id, revision_id, previous_revision_id, kind, activated_on
						) VALUES (?, ?, ?, ?, 'promotion', ?)`,
          )
            .bind(
              `activation_cross_${crypto.randomUUID()}`,
              shipletA,
              revisionB.id,
              revisionA.id,
              timestamp,
            )
            .run(),
      ],
      [
        "capability grant revision",
        () =>
          testEnv.DB.prepare(
            `INSERT INTO shiplet_capability_grants (
						 id, project_id, revision_id, actor_kind, actor_id, capability,
						 resource_json, constraints_json, issued_on, expires_on, revoked_on
						) VALUES (?, ?, ?, 'human', ?, 'state.read', '{}', '{}', ?, NULL, NULL)`,
          )
            .bind(
              `grant_cross_${crypto.randomUUID()}`,
              shipletA,
              revisionB.id,
              ACTOR.id,
              timestamp,
            )
            .run(),
      ],
      [
        "state deployment",
        () =>
          testEnv.DB.prepare(
            `INSERT INTO shiplet_state (
						 project_id, deployment_id, namespace, key, value_json,
						 byte_size, version, updated_on
						) VALUES (?, ?, 'review', 'cross-project', '{}', 2, 1, ?)`,
          )
            .bind(shipletA, deploymentB, timestamp)
            .run(),
      ],
    ];

    const outcomes: Array<{ relationship: string; status: string }> = [];
    for (const [relationship, operation] of operations) {
      const [attempt] = await Promise.allSettled([operation()]);
      outcomes.push({ relationship, status: attempt.status });
    }
    expect.soft(outcomes).toEqual(
      operations.map(([relationship]) => ({
        relationship,
        status: "rejected",
      })),
    );

    const contamination = await testEnv.DB.prepare(
      `SELECT
			 (SELECT COUNT(*) FROM shiplet_revisions WHERE id = ?) AS revisions,
			 (SELECT COUNT(*) FROM shiplet_deployments WHERE id = ?) AS deployments,
			 (SELECT COUNT(*) FROM shiplet_revision_activations
			  WHERE project_id = ? AND revision_id = ?) AS activations,
			 (SELECT COUNT(*) FROM shiplet_capability_grants
			  WHERE project_id = ? AND revision_id = ?) AS grants,
			 (SELECT COUNT(*) FROM shiplet_state
			  WHERE project_id = ? AND deployment_id = ?) AS state_rows`,
    )
      .bind(
        crossRevisionId,
        crossDeploymentId,
        shipletA,
        revisionB.id,
        shipletA,
        revisionB.id,
        shipletA,
        deploymentB,
      )
      .first<{
        revisions: number;
        deployments: number;
        activations: number;
        grants: number;
        state_rows: number;
      }>();
    expect.soft(contamination).toEqual({
      revisions: 0,
      deployments: 0,
      activations: 0,
      grants: 0,
      state_rows: 0,
    });
  });

  it("rejects update-time project crossing and keeps activation history immutable", async () => {
    const shipletA = await insertProject();
    const shipletB = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const revisionA = await service.createInitialRevision({
      shipletId: shipletA,
      package: clonePackage(),
      actor: ACTOR,
    });
    const revisionB = await service.createInitialRevision({
      shipletId: shipletB,
      package: clonePackage(),
      actor: ACTOR,
    });
    const targetA = `target_update_a_${crypto.randomUUID()}`;
    const targetB = `target_update_b_${crypto.randomUUID()}`;
    const deploymentA = `deployment_update_a_${crypto.randomUUID()}`;
    const deploymentB = `deployment_update_b_${crypto.randomUUID()}`;
    await insertKnownGoodDeployment({
      shipletId: shipletA,
      revisionId: revisionA.id,
      targetId: targetA,
      deploymentId: deploymentA,
    });
    await insertKnownGoodDeployment({
      shipletId: shipletB,
      revisionId: revisionB.id,
      targetId: targetB,
      deploymentId: deploymentB,
    });
    const now = new Date().toISOString();
    const grantId = `grant_update_${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO shiplet_capability_grants (
				id, project_id, revision_id, actor_kind, actor_id, capability,
				resource_json, constraints_json, issued_on, expires_on, revoked_on
			) VALUES (?, ?, ?, 'human', ?, 'state.read', '{}', '{}', ?, NULL, NULL)`,
    )
      .bind(grantId, shipletA, revisionA.id, ACTOR.id, now)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO shiplet_state (
				project_id, deployment_id, namespace, key, value_json,
				byte_size, version, updated_on
			) VALUES (?, ?, 'review', 'update-isolation', '{}', 2, 1, ?)`,
    )
      .bind(shipletA, deploymentA, now)
      .run();
    const activationA = await testEnv.DB.prepare(
      `SELECT id, project_id, revision_id, previous_revision_id, kind, activated_on
			 FROM shiplet_revision_activations
			 WHERE project_id = ? AND revision_id = ?`,
    )
      .bind(shipletA, revisionA.id)
      .first<{
        id: string;
        project_id: string;
        revision_id: string;
        previous_revision_id: string | null;
        kind: string;
        activated_on: string;
      }>();
    expect(activationA).toBeTruthy();
    if (!activationA) return;

    const operations: Array<
      [string, () => Promise<unknown>, () => Promise<unknown>]
    > = [
      [
        "grant revision update",
        () =>
          testEnv.DB.prepare(
            "UPDATE shiplet_capability_grants SET revision_id = ? WHERE id = ?",
          )
            .bind(revisionB.id, grantId)
            .run(),
        () =>
          testEnv.DB.prepare(
            "UPDATE shiplet_capability_grants SET revision_id = ? WHERE id = ?",
          )
            .bind(revisionA.id, grantId)
            .run(),
      ],
      [
        "deployment revision update",
        () =>
          testEnv.DB.prepare(
            "UPDATE shiplet_deployments SET revision_id = ? WHERE id = ?",
          )
            .bind(revisionB.id, deploymentA)
            .run(),
        () =>
          testEnv.DB.prepare(
            "UPDATE shiplet_deployments SET revision_id = ? WHERE id = ?",
          )
            .bind(revisionA.id, deploymentA)
            .run(),
      ],
      [
        "state deployment update",
        () =>
          testEnv.DB.prepare(
            `UPDATE shiplet_state SET deployment_id = ?
						 WHERE project_id = ? AND namespace = 'review' AND key = 'update-isolation'`,
          )
            .bind(deploymentB, shipletA)
            .run(),
        () =>
          testEnv.DB.prepare(
            `UPDATE shiplet_state SET deployment_id = ?
						 WHERE project_id = ? AND namespace = 'review' AND key = 'update-isolation'`,
          )
            .bind(deploymentA, shipletA)
            .run(),
      ],
      [
        "target project update",
        () =>
          testEnv.DB.prepare(
            "UPDATE deployment_targets SET project_id = ? WHERE id = ?",
          )
            .bind(shipletB, targetA)
            .run(),
        () =>
          testEnv.DB.prepare(
            "UPDATE deployment_targets SET project_id = ? WHERE id = ?",
          )
            .bind(shipletA, targetA)
            .run(),
      ],
      [
        "active revision update",
        () =>
          testEnv.DB.prepare(
            "UPDATE projects SET active_revision_id = ? WHERE id = ?",
          )
            .bind(revisionB.id, shipletA)
            .run(),
        () =>
          testEnv.DB.prepare(
            "UPDATE projects SET active_revision_id = ? WHERE id = ?",
          )
            .bind(revisionA.id, shipletA)
            .run(),
      ],
      [
        "activation history update",
        () =>
          testEnv.DB.prepare(
            "UPDATE shiplet_revision_activations SET kind = 'rollback' WHERE id = ?",
          )
            .bind(activationA.id)
            .run(),
        () =>
          testEnv.DB.prepare(
            "UPDATE shiplet_revision_activations SET kind = ? WHERE id = ?",
          )
            .bind(activationA.kind, activationA.id)
            .run(),
      ],
      [
        "activation history delete",
        () =>
          testEnv.DB.prepare(
            "DELETE FROM shiplet_revision_activations WHERE id = ?",
          )
            .bind(activationA.id)
            .run(),
        () =>
          testEnv.DB.prepare(
            `INSERT INTO shiplet_revision_activations (
							id, project_id, revision_id, previous_revision_id, kind, activated_on
						) VALUES (?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              activationA.id,
              activationA.project_id,
              activationA.revision_id,
              activationA.previous_revision_id,
              activationA.kind,
              activationA.activated_on,
            )
            .run(),
      ],
    ];

    const outcomes: Array<{ relationship: string; status: string }> = [];
    for (const [relationship, operation, repair] of operations) {
      const [attempt] = await Promise.allSettled([operation()]);
      outcomes.push({ relationship, status: attempt.status });
      if (attempt.status === "fulfilled") await repair();
    }
    expect.soft(outcomes).toEqual(
      operations.map(([relationship]) => ({
        relationship,
        status: "rejected",
      })),
    );

    const project = await testEnv.DB.prepare(
      "SELECT active_revision_id FROM projects WHERE id = ?",
    )
      .bind(shipletA)
      .first<{ active_revision_id: string }>();
    const activation = await testEnv.DB.prepare(
      "SELECT kind FROM shiplet_revision_activations WHERE id = ?",
    )
      .bind(activationA.id)
      .first<{ kind: string }>();
    expect.soft(project?.active_revision_id).toBe(revisionA.id);
    expect.soft(activation).toEqual({ kind: activationA.kind });
  });

  it("seals active and validated revision file sets against later insertion", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await service.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact(
        "sealed validated revision",
        initial.id,
      ),
      actor: ACTOR,
    });
    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });

    const attempts = await Promise.allSettled(
      [initial.id, validation.revisionId].map((revisionId, index) =>
        testEnv.DB.prepare(
          `INSERT INTO shiplet_revision_files (
						revision_id, path, media_type, size, object_key, content_base64
					) VALUES (?, ?, 'application/octet-stream', 1, NULL, 'AA==')`,
        )
          .bind(revisionId, `artifact/injected-${index}.bin`)
          .run(),
      ),
    );
    expect
      .soft(attempts.map((attempt) => attempt.status))
      .toEqual(["rejected", "rejected"]);
    const injected = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM shiplet_revision_files
			 WHERE revision_id IN (?, ?) AND path LIKE 'artifact/injected-%'`,
    )
      .bind(initial.id, validation.revisionId)
      .first<{ count: number }>();
    expect.soft(injected?.count).toBe(0);
  });

  it("does not commit an orphan revision when a draft changes during validation", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("validation candidate", initial.id),
      actor: ACTOR,
    });
    const runnerStarted = deferred<void>();
    const releaseRunner = deferred<void>();
    const validationRunner = {
      validate: async () => {
        runnerStarted.resolve(undefined);
        await releaseRunner.promise;
        return { ok: true as const, errors: [] };
      },
    };
    const validationOptions = { db: testEnv.DB, validationRunner };
    const validationService = createRevisionService(validationOptions);
    const validationPromise = validationService.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    const firstOutcome = await Promise.race([
      runnerStarted.promise.then(() => "runner_started" as const),
      validationPromise.then(
        () => "validation_completed" as const,
        () => "validation_completed" as const,
      ),
    ]);
    expect.soft(firstOutcome).toBe("runner_started");
    if (firstOutcome !== "runner_started") return;

    await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      package: await packageWithArtifact("newer draft edit", initial.id),
      actor: ACTOR,
    });
    releaseRunner.resolve(undefined);
    await expect(validationPromise).rejects.toMatchObject({
      code: "draft_conflict",
      currentVersion: update.version + 1,
    });

    const revisions = await testEnv.DB.prepare(
      "SELECT id FROM shiplet_revisions WHERE project_id = ? ORDER BY created_on",
    )
      .bind(shipletId)
      .all<{ id: string }>();
    expect(revisions.results).toEqual([{ id: initial.id }]);
  });

  it("deep-freezes an isolated validator snapshot and verifies its digest after validation", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const candidate = await packageWithArtifact(
      "validator immutable input",
      initial.id,
    );
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: candidate,
      actor: ACTOR,
    });
    let observedDeepFreeze = false;
    let mutationSucceeded = false;
    const validationRunner = {
      validate: async (input: { package: PackageEnvelope }) => {
        const artifact = input.package.files.find(
          (file) => file.path === "artifact/index.html",
        );
        observedDeepFreeze =
          Object.isFrozen(input.package) &&
          Object.isFrozen(input.package.manifest) &&
          Object.isFrozen(input.package.files) &&
          Boolean(artifact && Object.isFrozen(artifact));
        if (artifact) {
          mutationSucceeded = Reflect.set(
            artifact,
            "content",
            "validator mutation must not persist",
          );
        }
        try {
          (input.package.manifest.requestedCapabilities as string[]).push(
            "platform.admin",
          );
          mutationSucceeded = true;
        } catch {
          // A deeply frozen validator snapshot rejects the mutation.
        }
        return { ok: true as const, errors: [] };
      },
    };
    const service = createRevisionService({
      db: testEnv.DB,
      validationRunner:
        validationRunner as RawRevisionServiceOptions["validationRunner"],
    });

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    expect.soft(validation.ok).toBe(true);
    expect.soft(observedDeepFreeze).toBe(true);
    expect.soft(mutationSucceeded).toBe(false);
    const revision = await service.getRevision({
      shipletId,
      revisionId: validation.revisionId,
    });
    const exported = await serializeShipletPackage(revision.package);
    expect.soft(exported).toBe(await serializeShipletPackage(candidate));
    expect.soft(exported).not.toContain("validator mutation must not persist");
    expect.soft(exported).not.toContain("platform.admin");
  });

  it("bounds and sanitizes untrusted validation reports before persistence", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const update = await setupService.updateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      package: await packageWithArtifact("oversized report", initial.id),
      actor: ACTOR,
    });
    const sentinel = `validator-private-${crypto.randomUUID()}`;
    const validationRunner = {
      validate: async () => ({
        ok: false as const,
        errors: Array.from({ length: 300 }, (_, index) => ({
          code: `untrusted_${index}_${"x".repeat(1024)}`,
          path: `untrusted.${"y".repeat(1024)}`,
          checkId: `check_${index}_${"z".repeat(256)}`,
          credential: sentinel,
          stack: "untrusted stack must not persist",
        })),
      }),
    };
    const service = createRevisionService({
      db: testEnv.DB,
      validationRunner,
    });

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: update.version,
      actor: ACTOR,
    });
    expect.soft(validation.ok).toBe(false);
    expect.soft(validation.errors).toHaveLength(1);
    expect.soft(validation.errors[0]?.code).toBe("validation_report_invalid");
    const report = await testEnv.DB.prepare(
      `SELECT validation_report_json, length(validation_report_json) AS report_size
			 FROM shiplet_drafts WHERE id = ? AND project_id = ?`,
    )
      .bind(draft.id, shipletId)
      .first<{
        validation_report_json: string;
        report_size: number;
      }>();
    expect
      .soft((report?.report_size ?? Number.POSITIVE_INFINITY) <= 16_384)
      .toBe(true);
    expect.soft(report?.validation_report_json.includes(sentinel)).toBe(false);
    expect
      .soft(report?.validation_report_json.includes("untrusted stack"))
      .toBe(false);
  });

  it("Given a custom MCP manifest and no strict validator, when validation runs, then it fails closed and records the unavailable validator", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const serviceWithoutStrictValidator = createRevisionService({
      db: testEnv.DB,
      mcpManifestValidator: null,
    });

    const validation = await serviceWithoutStrictValidator.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      actor: ACTOR,
    });

    expect(validation).toMatchObject({
      ok: false,
      revisionId: "",
      errors: [
        {
          code: "mcp_validator_unavailable",
          path: "mcp/manifest.json",
        },
      ],
    });
    const persisted = await testEnv.DB.prepare(
      `SELECT active_revision_id,
       (SELECT validation_state FROM shiplet_drafts WHERE id = ?) AS validation_state,
       (SELECT validation_report_json FROM shiplet_drafts WHERE id = ?) AS validation_report_json,
       (SELECT COUNT(*) FROM shiplet_revisions WHERE project_id = ?) AS revision_count
       FROM projects WHERE id = ?`,
    )
      .bind(draft.id, draft.id, shipletId, shipletId)
      .first<{
        active_revision_id: string | null;
        validation_state: string;
        validation_report_json: string;
        revision_count: number;
      }>();
    expect(persisted).toMatchObject({
      active_revision_id: initial.id,
      validation_state: "failed",
      revision_count: 1,
    });
    expect(JSON.parse(persisted?.validation_report_json ?? "null")).toEqual({
      ok: false,
      errors: [
        {
          code: "mcp_validator_unavailable",
          path: "mcp/manifest.json",
        },
      ],
    });
  });

  it("Given the strict compiler rejects a custom MCP manifest, when validation runs, then its exact error is recorded and no revision is marked validated", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const strictValidator: TestMcpManifestValidator = {
      validate: async () => ({
        ok: false,
        errors: [
          {
            code: "reserved_tool",
            path: "tools[0].name",
          },
        ],
      }),
    };
    const service = createRevisionService({
      db: testEnv.DB,
      mcpManifestValidator: strictValidator,
    });

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      actor: ACTOR,
    });

    expect(validation.errors).toEqual([
      { code: "reserved_tool", path: "tools[0].name" },
    ]);
    const persisted = await testEnv.DB.prepare(
      `SELECT validation_state, validation_report_json, validated_revision_id,
       (SELECT active_revision_id FROM projects WHERE id = ?) AS active_revision_id,
       (SELECT COUNT(*) FROM shiplet_revisions WHERE project_id = ?) AS revision_count
       FROM shiplet_drafts WHERE id = ? AND project_id = ?`,
    )
      .bind(shipletId, shipletId, draft.id, shipletId)
      .first<{
        validation_state: string;
        validation_report_json: string;
        validated_revision_id: string | null;
        active_revision_id: string | null;
        revision_count: number;
      }>();
    expect(persisted).toMatchObject({
      validation_state: "failed",
      validated_revision_id: null,
      active_revision_id: initial.id,
      revision_count: 1,
    });
    expect(JSON.parse(persisted?.validation_report_json ?? "null")).toEqual({
      ok: false,
      errors: [{ code: "reserved_tool", path: "tools[0].name" }],
    });
  });

  it("Given a strict MCP validator throws, when validation runs, then a bounded hook failure is recorded without leaking the exception", async () => {
    const shipletId = await insertProject();
    const setupService = createRevisionService({ db: testEnv.DB });
    const initial = await setupService.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await setupService.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const sentinel = `strict-compiler-private-${crypto.randomUUID()}`;
    const service = createRevisionService({
      db: testEnv.DB,
      mcpManifestValidator: {
        validate: async () => {
          throw new Error(sentinel);
        },
      },
    });

    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      actor: ACTOR,
    });

    expect(validation.errors).toEqual([{ code: "mcp_validator_failed" }]);
    const report = await testEnv.DB.prepare(
      "SELECT validation_report_json FROM shiplet_drafts WHERE id = ?",
    )
      .bind(draft.id)
      .first<{ validation_report_json: string }>();
    expect(report?.validation_report_json).not.toContain(sentinel);
    expect(JSON.parse(report?.validation_report_json ?? "null")).toEqual({
      ok: false,
      errors: [{ code: "mcp_validator_failed" }],
    });
  });

  it("Given a static package has no custom MCP tools, when the strict validator is unavailable, then legacy validation remains supported", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({
      db: testEnv.DB,
      mcpManifestValidator: null,
    });

    const initial = await service.createInitialRevision({
      shipletId,
      package: await packageWithoutCustomMcp(),
      actor: ACTOR,
    });

    expect(initial.id).toMatch(/^revision_/);
    expect(
      (await service.getActiveRevision({ shipletId, actor: ACTOR })).id,
    ).toBe(initial.id);
  });

  it("Given a validated custom MCP revision later fails strict validation, when promotion runs, then promotion fails closed and records the report", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const draft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const validation = await service.validateDraft({
      shipletId,
      draftId: draft.id,
      expectedVersion: draft.version,
      actor: ACTOR,
    });
    expect(validation.ok).toBe(true);
    const rejectingService = createRevisionService({
      db: testEnv.DB,
      mcpManifestValidator: {
        validate: async () => ({
          ok: false,
          errors: [
            {
              code: "runtime_mismatch",
              path: "manifest.runtimeCompatibility",
            },
          ],
        }),
      },
    });

    await expectLifecycleFailure(
      () =>
        rejectingService.promoteDraft({
          shipletId,
          draftId: draft.id,
          expectedBaseRevisionId: initial.id,
          actor: ACTOR,
        }),
      {
        code: "draft_validation_failed",
        errors: [
          {
            code: "runtime_mismatch",
            path: "manifest.runtimeCompatibility",
          },
        ],
      },
    );
    expect(
      (await rejectingService.getActiveRevision({ shipletId, actor: ACTOR }))
        .id,
    ).toBe(initial.id);
    const persisted = await testEnv.DB.prepare(
      `SELECT validation_state, validation_report_json, validated_revision_id
       FROM shiplet_drafts WHERE id = ?`,
    )
      .bind(draft.id)
      .first<{
        validation_state: string;
        validation_report_json: string;
        validated_revision_id: string | null;
      }>();
    expect(persisted).toMatchObject({
      validation_state: "failed",
      validated_revision_id: null,
    });
    expect(JSON.parse(persisted?.validation_report_json ?? "null")).toEqual({
      ok: false,
      errors: [
        {
          code: "runtime_mismatch",
          path: "manifest.runtimeCompatibility",
        },
      ],
    });
  });

  it("creates a new child revision when package bytes repeat under a new parent", async () => {
    const shipletId = await insertProject();
    const service = createRevisionService({ db: testEnv.DB });
    const initial = await service.createInitialRevision({
      shipletId,
      package: clonePackage(),
      actor: ACTOR,
    });
    const changedDraft = await service.forkRevision({
      shipletId,
      revisionId: initial.id,
      actor: ACTOR,
    });
    const changedUpdate = await service.updateDraft({
      shipletId,
      draftId: changedDraft.id,
      expectedVersion: changedDraft.version,
      package: await packageWithArtifact("second active parent", initial.id),
      actor: ACTOR,
    });
    await service.validateDraft({
      shipletId,
      draftId: changedDraft.id,
      expectedVersion: changedUpdate.version,
      actor: ACTOR,
    });
    const promoted = await service.promoteDraft({
      shipletId,
      draftId: changedDraft.id,
      expectedBaseRevisionId: initial.id,
      actor: ACTOR,
    });
    const repeatedDraft = await service.forkRevision({
      shipletId,
      revisionId: promoted.revisionId,
      actor: ACTOR,
    });
    const repeatedUpdate = await service.updateDraft({
      shipletId,
      draftId: repeatedDraft.id,
      expectedVersion: repeatedDraft.version,
      package: clonePackage(),
      actor: ACTOR,
    });
    const repeatedValidation = await service.validateDraft({
      shipletId,
      draftId: repeatedDraft.id,
      expectedVersion: repeatedUpdate.version,
      actor: ACTOR,
    });

    expect.soft(repeatedValidation.revisionId).not.toBe(initial.id);
    expect.soft(repeatedValidation.revisionId).not.toBe(promoted.revisionId);
    const repeatedRevision = await service.getRevision({
      shipletId,
      revisionId: repeatedValidation.revisionId,
    });
    expect.soft(repeatedRevision.parentRevisionId).toBe(promoted.revisionId);
    const initialWithContentDigest = initial as typeof initial & {
      contentDigest: string;
    };
    const repeatedWithContentDigest =
      repeatedRevision as typeof repeatedRevision & {
        contentDigest: string;
      };
    expect.soft(repeatedWithContentDigest.digest).not.toBe(initial.digest);
    expect
      .soft(repeatedWithContentDigest.contentDigest)
      .toBe(initialWithContentDigest.contentDigest);
  });
});
