import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createD1CustomMcpQuarantineVault,
  ensureD1CustomMcpQuarantineSchema,
} from "../src/d1-custom-mcp-quarantine";
import { ensureSchema } from "../src/schema";
import { ensureRevisionSchema } from "../src/self-owned/revisions";

describe("D1 custom MCP quarantine vault", () => {
  beforeAll(async () => {
    await ensureSchema((env as Env).DB);
    await ensureRevisionSchema((env as Env).DB);
    await ensureD1CustomMcpQuarantineSchema((env as Env).DB);
  });

  it("Given untrusted package prose, When staged, Then lists only scoped metadata and never raw text", async () => {
    const now = 1_900_000_000_000;
    const vault = createD1CustomMcpQuarantineVault({
      db: (env as Env).DB,
      now: () => now,
    });
    const entry = {
      referenceId: `qm_${crypto.randomUUID()}`,
      shipletId: `project_${crypto.randomUUID()}`,
      revisionId: `revision_${crypto.randomUUID()}`,
      contentKind: "custom_mcp_description" as const,
      expiresAt: now + 10 * 60_000,
      textItems: ["<script>hostile package prose</script>"],
    };

    expect(await vault.store(entry)).toEqual({
      referenceId: entry.referenceId,
    });
    const listed = await vault.listActive({
      shipletId: entry.shipletId,
      now,
      limit: 20,
    });
    expect(listed).toEqual([
      {
        referenceId: entry.referenceId,
        shipletId: entry.shipletId,
        revisionId: entry.revisionId,
        contentKind: entry.contentKind,
        expiresAt: entry.expiresAt,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("hostile package prose");
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
  });

  it("Given an exact reference, When consumed, Then scope, expiry, and one-use semantics are atomic", async () => {
    let now = 1_900_000_100_000;
    const vault = createD1CustomMcpQuarantineVault({
      db: (env as Env).DB,
      now: () => now,
    });
    const entry = {
      referenceId: `qm_${crypto.randomUUID()}`,
      shipletId: `project_${crypto.randomUUID()}`,
      revisionId: `revision_${crypto.randomUUID()}`,
      contentKind: "custom_mcp_result" as const,
      expiresAt: now + 60_000,
      textItems: ["result one", "<b>result two</b>"],
    };
    expect(await vault.store(entry)).not.toBeNull();

    expect(
      await vault.consume({
        ...entry,
        shipletId: `project_${crypto.randomUUID()}`,
        now,
      }),
    ).toBeNull();
    const [first, replay] = await Promise.all([
      vault.consume({
        referenceId: entry.referenceId,
        shipletId: entry.shipletId,
        revisionId: entry.revisionId,
        contentKind: entry.contentKind,
        expiresAt: entry.expiresAt,
        now,
      }),
      vault.consume({
        referenceId: entry.referenceId,
        shipletId: entry.shipletId,
        revisionId: entry.revisionId,
        contentKind: entry.contentKind,
        expiresAt: entry.expiresAt,
        now,
      }),
    ]);
    expect([first, replay].filter(Boolean)).toHaveLength(1);
    expect(first ?? replay).toEqual(entry);
    expect(
      await vault.consume({
        referenceId: entry.referenceId,
        shipletId: entry.shipletId,
        revisionId: entry.revisionId,
        contentKind: entry.contentKind,
        expiresAt: entry.expiresAt,
        now,
      }),
    ).toBeNull();

    const expired = { ...entry, referenceId: `qm_${crypto.randomUUID()}` };
    now = expired.expiresAt - 1;
    expect(
      await vault.store({ ...expired, expiresAt: now + 1 }),
    ).not.toBeNull();
    now += 1;
    expect(
      await vault.consume({
        referenceId: expired.referenceId,
        shipletId: expired.shipletId,
        revisionId: expired.revisionId,
        contentKind: expired.contentKind,
        expiresAt: now,
        now,
      }),
    ).toBeNull();
  });

  it("Given persisted quarantine content, When ordinary SQL mutates or deletes it, Then immutable guards reject", async () => {
    const now = 1_900_000_200_000;
    const vault = createD1CustomMcpQuarantineVault({
      db: (env as Env).DB,
      now: () => now,
    });
    const entry = {
      referenceId: `qm_${crypto.randomUUID()}`,
      shipletId: `project_${crypto.randomUUID()}`,
      revisionId: `revision_${crypto.randomUUID()}`,
      contentKind: "custom_mcp_result" as const,
      expiresAt: now + 60_000,
      textItems: ["held"],
    };
    expect(await vault.store(entry)).not.toBeNull();

    await expect(
      (env as Env).DB.prepare(
        `UPDATE shiplet_custom_mcp_quarantine
         SET project_id = 'project_sibling' WHERE reference_id = ?`,
      )
        .bind(entry.referenceId)
        .run(),
    ).rejects.toThrow();
    await expect(
      (env as Env).DB.prepare(
        "DELETE FROM shiplet_custom_mcp_quarantine WHERE reference_id = ?",
      )
        .bind(entry.referenceId)
        .run(),
    ).rejects.toThrow();
  });

  it("atomically fences result persistence to the exact active unarchived revision", async () => {
    const now = 1_900_000_300_000;
    const projectId = `project_${crypto.randomUUID()}`;
    const revisionId = `revision_${crypto.randomUUID()}`;
    const contentDigest = "c".repeat(64);
    const timestamp = new Date(now).toISOString();
    await (env as Env).DB.batch([
      (env as Env).DB.prepare(
        `INSERT INTO projects (
          id, name, subdomain, script_content, visibility, created_on,
          modified_on, active_revision_id, active_revision_generation
         ) VALUES (?, ?, ?, '', 'private', ?, ?, NULL, 0)`,
      ).bind(projectId, projectId, `${projectId}-host`, timestamp, timestamp),
      (env as Env).DB.prepare(
        `INSERT INTO shiplet_revisions (
          id, project_id, parent_revision_id, package_json, package_digest,
          content_digest, runtime_compatibility, validation_report_json,
          created_by_actor_kind, created_by_actor_id, created_on
         ) VALUES (?, ?, NULL, '{}', ?, ?, 'shiplet.runtime/v1', '{}',
          'human', 'user_quarantine_fence', ?)`,
      ).bind(
        revisionId,
        projectId,
        `sha256:${contentDigest}`,
        contentDigest,
        timestamp,
      ),
    ]);
    await (env as Env).DB.prepare(
      `UPDATE projects SET active_revision_id = ?,
       active_revision_generation = 3 WHERE id = ?`,
    )
      .bind(revisionId, projectId)
      .run();
    const vault = createD1CustomMcpQuarantineVault({
      db: (env as Env).DB,
      now: () => now,
      activeRevisionFence: {
        shipletId: projectId,
        revisionId,
        packageDigest: `sha256:${contentDigest}`,
        activationGeneration: 3,
      },
    });
    const entry = (referenceId: string) => ({
      referenceId,
      shipletId: projectId,
      revisionId,
      contentKind: "custom_mcp_result" as const,
      expiresAt: now + 60_000,
      textItems: ["held result"],
    });

    expect(
      await vault.store(entry(`qm_${crypto.randomUUID()}`)),
    ).not.toBeNull();
    await (env as Env).DB.prepare(
      `UPDATE projects SET archived_on = ? WHERE id = ?`,
    )
      .bind(timestamp, projectId)
      .run();
    const archivedReference = `qm_${crypto.randomUUID()}`;
    expect(await vault.store(entry(archivedReference))).toBeNull();
    await expect(
      (env as Env).DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_custom_mcp_quarantine
         WHERE reference_id = ?`,
      )
        .bind(archivedReference)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });

    await (env as Env).DB.prepare(
      `UPDATE projects SET archived_on = NULL,
       active_revision_generation = 4 WHERE id = ?`,
    )
      .bind(projectId)
      .run();
    const staleGenerationReference = `qm_${crypto.randomUUID()}`;
    expect(await vault.store(entry(staleGenerationReference))).toBeNull();
    await expect(
      (env as Env).DB.prepare(
        `SELECT COUNT(*) AS count FROM shiplet_custom_mcp_quarantine
         WHERE reference_id = ?`,
      )
        .bind(staleGenerationReference)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
  });
});
