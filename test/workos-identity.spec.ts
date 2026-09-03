import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureSchema } from "../src/schema";
import { getUserByEmail, upsertUser } from "../src/store";
import { resolveVerifiedWorkOSUser } from "../src/workos-identity";

describe("WorkOS identity continuity", () => {
  const db = (env as { DB: D1Database }).DB;

  beforeEach(async () => {
    await ensureSchema(db);
  });

  it("Given an existing local account, When an unverified WorkOS subject claims its email, Then Shiplet rejects the rebind and preserves the account", async () => {
    const email = `unverified-rebind-${crypto.randomUUID()}@example.com`;
    const existingUserId = `user_existing_${crypto.randomUUID().replaceAll("-", "")}`;
    await upsertUser(db, { id: existingUserId, email });

    await expect(
      resolveVerifiedWorkOSUser(db, {
        id: `user_unverified_${crypto.randomUUID().replaceAll("-", "")}`,
        email,
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const preserved = await getUserByEmail(db, email);
    expect(preserved?.id).toBe(existingUserId);
    const identities = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM workos_user_identities WHERE user_id = ?`,
      )
      .bind(existingUserId)
      .first<{ count: number }>();
    expect(identities?.count).toBe(0);
  });
});
