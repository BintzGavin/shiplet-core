import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/schema";
import {
	buildLegacyCompatibilityPackage,
	migrateLegacyShipletRevision,
} from "../src/self-owned/legacy-migration";
import { ensureRevisionSchema } from "../src/self-owned/revisions";
import { parseShipletPackage } from "../src/self-owned/package";

const db = (env as Env).DB;

beforeAll(async () => {
	await ensureSchema(db);
	await ensureRevisionSchema(db);
});

async function insertLegacyProject(input: {
	id: string;
	sourceType: "static" | "external_url" | "worker";
	visibility: "private" | "organization" | "unlisted" | "public";
	customHostname?: string | null;
	externalOriginUrl?: string | null;
	scriptContent?: string;
	archivedOn?: string | null;
}) {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO projects (
			 id, organization_id, owner_user_id, name, subdomain, custom_hostname,
			 source_type, external_origin_url, script_content, visibility,
			 archived_on, delete_after, created_on, modified_on
			) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
		)
		.bind(
			input.id,
			"user_legacy_owner",
			`Legacy ${input.id}`,
			`legacy-${crypto.randomUUID().slice(0, 8)}`,
			input.customHostname ?? null,
			input.sourceType,
			input.externalOriginUrl ?? null,
			input.scriptContent ?? "/* legacy static */",
			input.visibility,
			input.archivedOn ?? null,
			now,
			now,
		)
		.run();
}

describe("representative legacy revision migration", () => {
	it("builds deterministic compatibility packages for static, external URL, and advanced Worker projects", async () => {
		const staticId = `project_legacy_static_${crypto.randomUUID()}`;
		await insertLegacyProject({
			id: staticId,
			sourceType: "static",
			visibility: "unlisted",
			customHostname: "legacy.example.com",
		});
		for (const asset of [
			{
				path: "index.html",
				contentType: "text/html",
				content: "<h1>Legacy static</h1>",
			},
			{
				path: "assets/app.js",
				contentType: "text/javascript",
				content: "document.body.dataset.legacy='1'",
			},
		]) {
			await db
				.prepare(
					`INSERT INTO project_assets
					 (project_id, path, content_type, content_base64, object_key, size, created_on)
					 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
				)
				.bind(
					staticId,
					asset.path,
					asset.contentType,
					btoa(asset.content),
					new TextEncoder().encode(asset.content).byteLength,
					new Date().toISOString(),
				)
				.run();
		}

		const externalId = `project_legacy_external_${crypto.randomUUID()}`;
		await insertLegacyProject({
			id: externalId,
			sourceType: "external_url",
			visibility: "organization",
			externalOriginUrl: "https://legacy-origin.example/path",
		});

		const workerId = `project_legacy_worker_${crypto.randomUUID()}`;
		await insertLegacyProject({
			id: workerId,
			sourceType: "worker",
			visibility: "private",
			scriptContent: "export default { fetch() { return new Response('legacy'); } }",
			archivedOn: new Date().toISOString(),
		});

		for (const projectId of [staticId, externalId, workerId]) {
			const revision = await migrateLegacyShipletRevision(db, projectId);
			expect(revision.shipletId).toBe(projectId);
			expect(revision.parentRevisionId).toBeNull();
			const project = await db
				.prepare(
					`SELECT active_revision_id, visibility, custom_hostname, archived_on
					 FROM projects WHERE id = ?`,
				)
				.bind(projectId)
				.first<{
					active_revision_id: string;
					visibility: string;
					custom_hostname: string | null;
					archived_on: string | null;
				}>();
			expect(project?.active_revision_id).toBe(revision.id);
		}

		const staticPackage = await buildLegacyCompatibilityPackage(db, staticId);
		const parsedStatic = await parseShipletPackage(staticPackage);
		expect(parsedStatic.files.map((file) => file.path)).toEqual(
			expect.arrayContaining([
				"artifact/index.html",
				"artifact/assets/app.js",
				"widget/index.html",
				"workflow/schema.json",
				"mcp/manifest.json",
				"AGENTS.md",
				"validation/manifest.json",
				"provenance.json",
			]),
		);
		expect(parsedStatic.manifest.staticFirst).toBe(true);

		const externalPackage = await parseShipletPackage(
			await buildLegacyCompatibilityPackage(db, externalId),
		);
		expect(externalPackage.manifest.staticFirst).toBe(true);
		expect(
			externalPackage.files.find(
				(file) => file.path === "artifact/external.json",
			)?.content,
		).toBe(
			`${JSON.stringify({
				schemaVersion: "shiplet.external-origin/v1",
				origin: "https://legacy-origin.example/path",
			})}\n`,
		);
		expect(
			externalPackage.files.find((file) => file.path === "provenance.json")
				?.content,
		).toContain("legacy-external-url");

		const workerPackage = await parseShipletPackage(
			await buildLegacyCompatibilityPackage(db, workerId),
		);
		expect(workerPackage.manifest.staticFirst).toBe(false);
		expect(workerPackage.manifest.requestedCapabilities).toContain(
			"runtime.worker",
		);
		expect(workerPackage.files.map((file) => file.path)).toContain(
			"artifact/worker.js",
		);
	});

	it("is idempotent and never copies access, state, audit, or credential-shaped legacy data", async () => {
		const projectId = `project_legacy_isolated_${crypto.randomUUID()}`;
		await insertLegacyProject({
			id: projectId,
			sourceType: "static",
			visibility: "public",
		});
		await db
			.prepare(
				`INSERT INTO project_assets
				 (project_id, path, content_type, content_base64, object_key, size, created_on)
				 VALUES (?, 'readme.txt', 'text/plain', ?, NULL, 6, ?)`,
			)
			.bind(projectId, btoa("legacy"), new Date().toISOString())
			.run();

		const first = await migrateLegacyShipletRevision(db, projectId);
		const second = await migrateLegacyShipletRevision(db, projectId);
		expect(second.id).toBe(first.id);
		const revisions = await db
			.prepare("SELECT COUNT(*) AS count FROM shiplet_revisions WHERE project_id = ?")
			.bind(projectId)
			.first<{ count: number }>();
		expect(revisions?.count).toBe(1);

		const row = await db
			.prepare("SELECT package_json FROM shiplet_revisions WHERE id = ?")
			.bind(first.id)
			.first<{ package_json: string }>();
		expect(row?.package_json).toBeTruthy();
		for (const forbidden of [
			"accessGrants",
			"auditHistory",
			"deployments",
			"oauth",
			"sessions",
			"state",
		]) {
			expect(row?.package_json).not.toContain(`\"${forbidden}\"`);
		}
	});
});
