import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createD1TemporaryDeploymentAuthorizer,
  ensureD1TemporaryDeploymentAuthoritySchema,
} from "../src/d1-temporary-deployment-authorizer";
import { ensureD1DeploymentRepositorySchema } from "../src/d1-deployment-repository";
import { ensureRevisionSchema } from "../src/self-owned/revisions";
import { ensureSchema } from "../src/schema";

const NOW = 1_800_000_000_000;
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`;

async function seed() {
  const db = (env as Env).DB;
  const createdOn = new Date(NOW).toISOString();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `user_temp_${suffix}`;
  const projectId = `project_temp_${suffix}`;
  const revisionId = `revision_temp_${suffix}`;
  const targetId = `target_temp_${suffix}`;
  const accountHandle = `temporary_account_${suffix}`;
  const scriptName = `shiplet-temp-${suffix}`;
  await db
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, created_on, updated_on)
       VALUES (?, ?, 'Temp', 'Owner', ?, ?)`,
    )
    .bind(userId, `temp-owner-${suffix}@example.com`, createdOn, createdOn)
    .run();
  await db
    .prepare(
      `INSERT INTO projects (
        id, owner_user_id, name, subdomain, source_type, script_content,
        visibility, created_on, modified_on, active_revision_generation
       ) VALUES (
        ?, ?, 'Temporary authority', ?, 'static', '', 'private', ?, ?, 1
       )`,
    )
    .bind(projectId, userId, `temporary-${suffix}`, createdOn, createdOn)
    .run();
  await db
    .prepare(
      `INSERT INTO shiplet_revisions (
        id, project_id, package_json, package_digest, content_digest,
        runtime_compatibility, validation_report_json,
        created_by_actor_kind, created_by_actor_id, created_on
       ) VALUES (
        ?, ?, '{}', ?, ?, 'shiplet.runtime/v1', '{}', 'human', ?, ?
       )`,
    )
    .bind(
      revisionId,
      projectId,
      "a".repeat(64),
      "b".repeat(64),
      userId,
      createdOn,
    )
    .run();
  await db
    .prepare(`UPDATE projects SET active_revision_id = ? WHERE id = ?`)
    .bind(revisionId, projectId)
    .run();
  await db
    .prepare(
      `INSERT INTO deployment_targets (
        id, project_id, kind, owner_kind, owner_id, connection_id,
        provider_account_id, configuration_json, created_on, detached_on
       ) VALUES (
        ?, ?, 'temporary_claim', 'human', ?, NULL, ?, ?, ?, NULL
       )`,
    )
    .bind(
      targetId,
      projectId,
      userId,
      accountHandle,
      JSON.stringify({
        scriptName,
        status: "connected",
        resourceBindingRefs: [],
      }),
      createdOn,
    )
    .run();
  return {
    db,
    userId,
    projectId,
    revisionId,
    targetId,
    accountHandle,
    scriptName,
  };
}

function request(
  seeded: Awaited<ReturnType<typeof seed>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    operationId: `deployment_journal_${seeded.targetId}`,
    userId: seeded.userId,
    shipletId: seeded.projectId,
    accountHandle: seeded.accountHandle,
    targetId: seeded.targetId,
    scriptName: seeded.scriptName,
    revisionId: seeded.revisionId,
    packageDigest: PACKAGE_DIGEST,
    operation: "temporary.deployment.create" as const,
    requiredScopes: ["temporary.accounts.create", "temporary.workers.deploy"],
    requestDigest: `sha256:${"c".repeat(64)}`,
    ...overrides,
  };
}

describe("D1 temporary deployment authority", () => {
  beforeEach(async () => {
    await ensureSchema((env as Env).DB);
    await ensureRevisionSchema((env as Env).DB);
    await ensureD1DeploymentRepositorySchema((env as Env).DB);
    await ensureD1TemporaryDeploymentAuthoritySchema((env as Env).DB);
  });

  it("issues only a hashed, immutable, exact-scope capability for the owner, target, revision, package, and request", async () => {
    const seeded = await seed();
    const { db } = seeded;
    const authorizer = createD1TemporaryDeploymentAuthorizer({
      db,
      now: () => NOW,
    });

    const result = await authorizer.authorize(request(seeded));

    expect(result).toMatchObject({
      ok: true,
      authorization: {
        handle: expect.stringMatching(/^temporary_grant_/),
        userId: seeded.userId,
        shipletId: seeded.projectId,
        accountId: seeded.accountHandle,
        targetId: seeded.targetId,
        scriptName: seeded.scriptName,
        revisionId: seeded.revisionId,
        packageDigest: PACKAGE_DIGEST,
        operation: "temporary.deployment.create",
        scopes: ["temporary.accounts.create", "temporary.workers.deploy"],
        requestDigest: `sha256:${"c".repeat(64)}`,
      },
    });
    const handle = (result as { authorization: { handle: string } })
      .authorization.handle;
    const row = await db
      .prepare(
        `SELECT handle_digest, user_id, target_id, revision_id, package_digest,
                operation, scopes_json, request_digest, expires_at, revoked_at
         FROM cloudflare_temporary_deployment_capabilities`,
      )
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      handle_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      user_id: seeded.userId,
      target_id: seeded.targetId,
      revision_id: seeded.revisionId,
      package_digest: PACKAGE_DIGEST,
      operation: "temporary.deployment.create",
      scopes_json: JSON.stringify([
        "temporary.accounts.create",
        "temporary.workers.deploy",
      ]),
      request_digest: `sha256:${"c".repeat(64)}`,
      expires_at: NOW + 30_000,
      revoked_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(handle);
    await expect(
      db
        .prepare(
          `UPDATE cloudflare_temporary_deployment_capabilities
           SET target_id = 'target_sibling'`,
        )
        .run(),
    ).rejects.toThrow(/immutable/i);
    await expect(
      db
        .prepare(
          `UPDATE cloudflare_temporary_deployment_capabilities
           SET revoked_at = ? WHERE handle_digest = ? AND revoked_at IS NULL`,
        )
        .bind(NOW + 1, row?.handle_digest)
        .run(),
    ).resolves.toMatchObject({ meta: { changes: 1 } });
    await expect(
      db
        .prepare(
          `UPDATE cloudflare_temporary_deployment_capabilities
           SET revoked_at = NULL WHERE handle_digest = ?`,
        )
        .bind(row?.handle_digest)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  it.each([
    ["wrong user", { userId: "user_sibling" }],
    ["wrong Shiplet", { shipletId: "project_sibling" }],
    ["wrong target", { targetId: "target_sibling" }],
    ["wrong account", { accountHandle: "other_account" }],
    ["wrong revision", { revisionId: "revision_sibling" }],
    ["wrong package", { packageDigest: `sha256:${"d".repeat(64)}` }],
    [
      "extra scope",
      {
        requiredScopes: [
          "temporary.accounts.create",
          "temporary.workers.deploy",
          "extra",
        ],
      },
    ],
  ])("fails closed for %s", async (_label, change) => {
    const seeded = await seed();
    const { db } = seeded;
    const authorizer = createD1TemporaryDeploymentAuthorizer({
      db,
      now: () => NOW,
    });

    await expect(
      authorizer.authorize(request(seeded, change)),
    ).resolves.toEqual({
      ok: false,
      reason: "temporary_capability_denied",
    });
    const count = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM cloudflare_temporary_deployment_capabilities
         WHERE target_id = ?`,
      )
      .bind(seeded.targetId)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
});
