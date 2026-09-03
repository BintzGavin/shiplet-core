import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createD1CloudflareOAuthConnectionCommitter } from "../src/cloudflare-support/d1-vault";

type TestEnv = { DB: D1Database };
const testEnv = env as TestEnv;
const NOW = Date.parse("2026-08-07T12:00:00.000Z");

function testCipherKey() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

async function counts() {
	return {
		credentials: await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM encrypted_records",
		).first<{ count: number }>(),
		connections: await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM cloudflare_connections",
		).first<{ count: number }>(),
	};
}

describe("atomic D1 Cloudflare OAuth credential commit", () => {
	beforeEach(async () => {
		await testEnv.DB.batch([
			testEnv.DB.prepare("DROP TABLE IF EXISTS cloudflare_connections"),
			testEnv.DB.prepare("DROP TABLE IF EXISTS encrypted_records"),
			testEnv.DB.prepare(
				`CREATE TABLE encrypted_records (
					id TEXT PRIMARY KEY,
					purpose TEXT NOT NULL,
					nonce TEXT NOT NULL,
					ciphertext TEXT NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'cleanup')),
					expires_at INTEGER,
					created_on TEXT NOT NULL,
					retired_on TEXT
				)`,
			),
			testEnv.DB.prepare(
				`CREATE TABLE cloudflare_connections (
					id TEXT PRIMARY KEY,
					user_id TEXT NOT NULL,
					account_id TEXT NOT NULL,
					account_label TEXT NOT NULL,
					scopes_json TEXT NOT NULL,
					credential_ref TEXT NOT NULL,
					expires_at INTEGER NOT NULL,
					status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
					revoked_at INTEGER,
					generation INTEGER NOT NULL,
					created_on TEXT NOT NULL,
					refreshed_at INTEGER,
					UNIQUE (user_id, account_id),
					FOREIGN KEY (credential_ref) REFERENCES encrypted_records(id)
				)`,
			),
		]);
	});

	it("commits encrypted provider material and its owning connection together", async () => {
		// Given one validated provider exchange, when the kernel commits it, then
		// both rows become visible and share the same opaque credential reference.
		const commit = createD1CloudflareOAuthConnectionCommitter({
			db: testEnv.DB,
			encodedKey: testCipherKey(),
			now: () => NOW,
		});

		const connection = await commit({
			material: { access: "fixture-only" },
			connection: {
				id: "connection_atomic_success",
				userId: "user_atomic_success",
				accountId: "account_atomic_success",
				accountLabel: "Atomic fixture",
				scopes: ["workers.scripts.read", "workers.scripts.write"],
				expiresAt: NOW + 60_000,
				generation: 1,
			},
		});

		expect(connection).toMatchObject({
			id: "connection_atomic_success",
			status: "active",
			credentialRef: expect.stringMatching(/^vault_[0-9a-f-]{36}$/i),
		});
		expect(await counts()).toEqual({
			credentials: { count: 1 },
			connections: { count: 1 },
		});
		expect(
			await testEnv.DB.prepare(
				"SELECT credential_ref FROM cloudflare_connections WHERE id = ?",
			)
				.bind(connection.id)
				.first(),
		).toEqual({ credential_ref: connection.credentialRef });
	});

	it("persists neither row when the connection statement conflicts", async () => {
		// Given an account already has an active connection, when a second provider
		// exchange conflicts, then the encrypted credential cannot be orphaned.
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				`INSERT INTO encrypted_records (
					id, purpose, nonce, ciphertext, status, expires_at, created_on, retired_on
				) VALUES ('vault_existing', 'oauth_credential', 'nonce', 'ciphertext',
					'active', NULL, ?, NULL)`,
			).bind(new Date(NOW).toISOString()),
			testEnv.DB.prepare(
				`INSERT INTO cloudflare_connections (
					id, user_id, account_id, account_label, scopes_json, credential_ref,
					expires_at, status, revoked_at, generation, created_on, refreshed_at
				) VALUES ('connection_existing', 'user_conflict', 'account_conflict',
					'Existing', '[]', 'vault_existing', ?, 'active', NULL, 1, ?, NULL)`,
			).bind(NOW + 60_000, new Date(NOW).toISOString()),
		]);
		const before = await counts();
		const commit = createD1CloudflareOAuthConnectionCommitter({
			db: testEnv.DB,
			encodedKey: testCipherKey(),
			now: () => NOW,
		});

		await expect(
			commit({
				material: { access: "must-not-survive" },
				connection: {
					id: "connection_conflicting_exchange",
					userId: "user_conflict",
					accountId: "account_conflict",
					accountLabel: "Conflicting fixture",
					scopes: ["workers.scripts.read", "workers.scripts.write"],
					expiresAt: NOW + 60_000,
					generation: 1,
				},
			}),
		).rejects.toThrow();

		expect(await counts()).toEqual(before);
		expect(
			await testEnv.DB.prepare(
				"SELECT id FROM cloudflare_connections WHERE id = ?",
			)
				.bind("connection_conflicting_exchange")
				.first(),
		).toBeNull();
	});
});
