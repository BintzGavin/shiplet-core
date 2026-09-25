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
  epoch: 2,
  digest: "fe68895f27cb6263350dc5f418b944f7f555475d001c54eed597190cc367ff8c",
};

// Releases up to v0.1.43 recorded epoch 1 before the invite link tables existed.
const EPOCH_BEFORE_INVITE_LINKS = 1;
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

  it("pins the kernel schema to its epoch so schema changes cannot ship without a bump", async () => {
    // Force a full setup pass, then fingerprint what it created.
    await recordEpoch(0);
    expect((await request(`/join/${"B".repeat(32)}`)).status).toBe(404);

    expect({
      epoch: schemaInitializationTest.currentEpoch,
      digest: await kernelSchemaDigest(),
    }).toEqual(PINNED_KERNEL_SCHEMA);
  });
});
