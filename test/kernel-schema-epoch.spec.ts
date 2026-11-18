import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app, { schemaInitializationTest } from "../src/index";

// Deployed databases skip kernel schema setup once they have recorded the
// current epoch, so a schema change without an epoch bump never reaches them.
// Pin the two together: when this digest changes, bump
// CURRENT_KERNEL_SCHEMA_EPOCH in src/index.ts and update both values here.
const PINNED_KERNEL_SCHEMA = {
  epoch: 7,
  digest: "c09d47ac700c2e5f537ef4ea1df61d6ca6c85cc475c7be2d08365276340458a1",
};

// Releases up to v0.1.43 recorded epoch 1 before the invite link tables existed.
const EPOCH_BEFORE_INVITE_LINKS = 1;
// Releases before reusable CLI sessions recorded epoch 2.
const EPOCH_BEFORE_REUSABLE_CLI_SESSIONS = 2;
// Releases before WorkOS membership reconciliation recorded epoch 3.
const EPOCH_BEFORE_MEMBERSHIP_SYNC = 3;
// Releases before traces recorded epoch 4.
const EPOCH_BEFORE_TRACES = 4;
// Builds with only private traces recorded epoch 5.
const EPOCH_BEFORE_TRACE_SHARING = 5;
// Builds before trace upload links recorded epoch 6.
const EPOCH_BEFORE_TRACE_UPLOAD_LINKS = 6;
const EPOCH_TABLE = "shiplet_kernel_schema_epoch";

function db() {
  return (env as unknown as Env).DB;
}

async function request(path: string) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`),
    env as unknown as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function tableExists(name: string) {
  const row = await db().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  )
    .bind(name)
    .first<{ name: string }>();
  return Boolean(row);
}

async function recordEpoch(epoch: number) {
  await db().prepare(
    `CREATE TABLE IF NOT EXISTS ${EPOCH_TABLE} (
      schema_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL
    )`,
  ).run();
  await db().prepare(
    `INSERT INTO ${EPOCH_TABLE} (schema_id, epoch) VALUES ('kernel', ?)
     ON CONFLICT(schema_id) DO UPDATE SET epoch = excluded.epoch`,
  )
    .bind(epoch)
    .run();
}

async function kernelSchemaDigest() {
  const rows = await db().prepare(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE sql IS NOT NULL
       AND name NOT GLOB 'sqlite_*'
       AND name NOT GLOB '_cf_*'
       AND name <> '${EPOCH_TABLE}'
     ORDER BY type, name`,
  ).all<{ type: string; name: string; tbl_name: string; sql: string }>();
  const text = (rows.results || [])
    .map((row) => [row.type, row.name, row.tbl_name, row.sql].join("\t"))
    .join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

describe("kernel schema epoch", () => {
  it("creates the invite link tables on a database that recorded the epoch from before invite links", async () => {
    await recordEpoch(EPOCH_BEFORE_INVITE_LINKS);
    await db().prepare(
      "DROP TABLE IF EXISTS organization_invite_link_redemptions",
    ).run();
    await db().prepare("DROP TABLE IF EXISTS organization_invite_links").run();

    const response = await request(`/join/${"A".repeat(32)}`);

    expect(response.status).toBe(404);
    expect(await tableExists("organization_invite_links")).toBe(true);
    expect(await tableExists("organization_invite_link_redemptions")).toBe(true);
    const marker = await db().prepare(
      `SELECT epoch FROM ${EPOCH_TABLE} WHERE schema_id = 'kernel'`,
    ).first<{ epoch: number }>();
    expect(marker?.epoch).toBe(schemaInitializationTest.currentEpoch);
  });

  it("creates the membership sweep state table on a database that recorded the epoch from before it", async () => {
    await request("/health");
    await recordEpoch(EPOCH_BEFORE_MEMBERSHIP_SYNC);
    await db().prepare("DROP TABLE IF EXISTS workos_membership_sync_state").run();
    await db().prepare("DROP INDEX IF EXISTS idx_organization_memberships_user").run();

    expect((await request(`/join/${"D".repeat(32)}`)).status).toBe(404);

    expect(await tableExists("workos_membership_sync_state")).toBe(true);
    const index = await db().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
    )
      .bind("idx_organization_memberships_user")
      .first<{ name: string }>();
    expect(index).not.toBeNull();
  });

  it("creates the traces table on a database that recorded the epoch from before it", async () => {
    await request("/health");
    await recordEpoch(EPOCH_BEFORE_TRACES);
    await db().prepare("DROP TABLE IF EXISTS project_traces").run();

    expect((await request(`/join/${"D".repeat(32)}`)).status).toBe(404);

    expect(await tableExists("project_traces")).toBe(true);
  });

  it("adds trace sharing tables and columns to a database that recorded epoch 5", async () => {
    await request("/health");
    await recordEpoch(EPOCH_BEFORE_TRACE_SHARING);
    await db().prepare("DROP TABLE IF EXISTS trace_audiences").run();
    await db().prepare("DROP TABLE IF EXISTS project_traces").run();
    await db().prepare(
      `CREATE TABLE project_traces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, organization_id TEXT, revision_id TEXT,
        uploader_user_id TEXT, uploader_token_id TEXT, upload_sha256 TEXT NOT NULL, sharing TEXT NOT NULL DEFAULT 'private',
        title TEXT NOT NULL, harness TEXT NOT NULL, started_on TEXT, ended_on TEXT, event_count INTEGER NOT NULL,
        segment_count INTEGER NOT NULL, canonical_bytes INTEGER NOT NULL, attachment_count INTEGER NOT NULL,
        attachment_bytes INTEGER NOT NULL, client_masked_count INTEGER NOT NULL, server_masked_count INTEGER NOT NULL,
        manifest_sha256 TEXT NOT NULL, created_on TEXT NOT NULL)`,
    ).run();

    expect((await request(`/join/${"D".repeat(32)}`)).status).toBe(404);

    expect(await tableExists("trace_audiences")).toBe(true);
    const columns = await db().prepare("PRAGMA table_info(project_traces)").all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain("pending_attachments");

    // Restore the canonical table so the schema pin below sees the real schema.
    await db().prepare("DROP TABLE project_traces").run();
    await recordEpoch(EPOCH_BEFORE_TRACES);
    expect((await request(`/join/${"D".repeat(32)}`)).status).toBe(404);
  });

  it("adds the trace upload link table to a database that recorded epoch 6", async () => {
    await request("/health");
    await recordEpoch(EPOCH_BEFORE_TRACE_UPLOAD_LINKS);
    await db().prepare("DROP TABLE IF EXISTS trace_upload_links").run();

    expect((await request(`/join/${"D".repeat(32)}`)).status).toBe(404);

    expect(await tableExists("trace_upload_links")).toBe(true);
  });

  it("pins the kernel schema to its epoch so schema changes cannot ship without a bump", async () => {
    // Force a full setup pass, then fingerprint what it created.
    await recordEpoch(0);
    expect((await request(`/join/${"B".repeat(32)}`)).status).toBe(404);

    expect({
      epoch: schemaInitializationTest.currentEpoch,
      digest: await kernelSchemaDigest(),
    }).toEqual(PINNED_KERNEL_SCHEMA);
  });

  // Runs last: re-adding the column changes the stored table SQL, and with it
  // the digest the pin above fingerprints.
  it("adds the reusable CLI session lifetime column on a database that recorded the epoch from before it", async () => {
    await request("/health");
    await recordEpoch(EPOCH_BEFORE_REUSABLE_CLI_SESSIONS);
    await db().prepare(
      "ALTER TABLE cli_authorization_requests DROP COLUMN session_ttl_seconds",
    ).run();

    expect((await request(`/join/${"C".repeat(32)}`)).status).toBe(404);

    const columns = await db().prepare(
      "PRAGMA table_info(cli_authorization_requests)",
    ).all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).toContain(
      "session_ttl_seconds",
    );
  });
});
