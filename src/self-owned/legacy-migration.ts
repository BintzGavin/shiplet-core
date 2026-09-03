import type { Project } from "../types";
import { MAX_STATIC_ASSET_FILE_BYTES } from "../upload-policy";
import {
	SHIPLET_PACKAGE_MEDIA_TYPE,
	parseShipletPackage,
	type ShipletPackageFile,
	type ValidatedShipletPackage,
} from "./package";
import {
	createRevisionService,
	ensureRevisionSchema,
	type RevisionKernelAuthorizationBinding,
	type RevisionPackageStore,
	type ShipletRevision,
} from "./revisions";

type LegacyAsset = {
	path: string;
	content_type: string;
	content_base64: string;
	object_key: string | null;
	size: number;
};

type LegacyProject = Project & { active_revision_id?: string | null };

const LIMITS = Object.freeze({
	fileCount: 1_024,
	fileBytes: MAX_STATIC_ASSET_FILE_BYTES,
	packageBytes: 32 * 1024 * 1024,
});

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

async function sha256(bytes: Uint8Array) {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
	);
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function textFile(
	path: string,
	content: string,
	mediaType: string,
): Promise<ShipletPackageFile> {
	const bytes = utf8(content);
	return {
		path,
		mediaType,
		encoding: "utf8",
		content,
		sha256: await sha256(bytes),
		size: bytes.byteLength,
	};
}

function decodeBase64(content: string) {
	const binary = atob(content);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 32 * 1024;
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

async function assetFile(
	asset: LegacyAsset,
	bucket?: R2Bucket,
): Promise<ShipletPackageFile> {
	let content = asset.content_base64;
	if (!content && asset.object_key) {
		if (!bucket) throw new Error(`legacy_asset_store_unavailable:${asset.path}`);
		const object = await bucket.get(asset.object_key);
		if (!object) throw new Error(`legacy_asset_missing:${asset.path}`);
		const bytes = new Uint8Array(await object.arrayBuffer());
		content = encodeBase64(bytes);
	}
	const bytes = decodeBase64(content);
	if (bytes.byteLength !== asset.size) {
		throw new Error(`legacy_asset_size_mismatch:${asset.path}`);
	}
	const normalizedPath = asset.path.replace(/^\/+/, "");
	return {
		path: `artifact/${normalizedPath}`,
		mediaType: asset.content_type,
		encoding: "base64",
		content,
		sha256: await sha256(bytes),
		size: bytes.byteLength,
	};
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function generatedLegacyIndex(project: LegacyProject) {
	if (project.source_type === "external_url") {
		return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)}</title><main><h1>${escapeHtml(project.name)}</h1><p>This compatibility revision preserves the external review origin <code>${escapeHtml(project.external_origin_url || "unavailable")}</code>.</p></main></html>`;
	}
	if (project.source_type === "worker") {
		return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)}</title><main><h1>${escapeHtml(project.name)}</h1><p>This advanced legacy Worker requires an isolated runtime before it can run from the portable revision.</p></main></html>`;
	}
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)}</title><main><h1>${escapeHtml(project.name)}</h1><p>This legacy static Shiplet has no index.html. Its original asset fallback remains active during migration.</p></main></html>`;
}

async function generatedContractFiles(
	project: LegacyProject,
): Promise<ShipletPackageFile[]> {
	return Promise.all([
		textFile(
			"widget/index.html",
			"<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><p>Review actions are provided by the trusted Shiplet host.</p></html>\n",
			"text/html; charset=utf-8",
		),
		textFile(
			"workflow/schema.json",
			`${JSON.stringify({
				schemaVersion: "shiplet.workflow/v1",
				statuses: [
					{ name: "New", category: "open" },
					{ name: "In Progress", category: "in_progress" },
					{ name: "Blocked", category: "blocked" },
					{ name: "Done", category: "resolved" },
					{ name: "Dropped", category: "closed" },
				],
				fields: [],
			})}\n`,
			"application/json",
		),
		textFile(
			"mcp/manifest.json",
			`${JSON.stringify({ schemaVersion: "shiplet.mcp/v1", tools: [] })}\n`,
			"application/json",
		),
		textFile(
			"AGENTS.md",
			"# Shiplet agent instructions\n\nPreserve reviewer attribution and use only capabilities explicitly granted by the Shiplet kernel.\n",
			"text/markdown; charset=utf-8",
		),
		textFile(
			"validation/manifest.json",
			`${JSON.stringify({
				schemaVersion: "shiplet.validation/v1",
				checks: [
					{
						id: "legacy-artifact-entrypoint",
						kind: "file-exists",
						path: "artifact/index.html",
					},
				],
			})}\n`,
			"application/json",
		),
		textFile(
			"provenance.json",
			`${JSON.stringify({
				schemaVersion: "shiplet.provenance/v1",
				source: {
					kind:
						project.source_type === "external_url"
							? "legacy-external-url"
							: project.source_type === "worker"
								? "legacy-worker"
								: "legacy-static",
				},
				lineage: { parentRevisionId: null },
			})}\n`,
			"application/json",
		),
	]);
}

export async function buildLegacyCompatibilityPackage(
	db: D1Database,
	shipletId: string,
	bucket?: R2Bucket,
): Promise<ValidatedShipletPackage> {
	const project = await db
		.prepare("SELECT * FROM projects WHERE id = ?")
		.bind(shipletId)
		.first<LegacyProject>();
	if (!project) throw new Error("legacy_shiplet_not_found");

	const assetRows = await db
		.prepare(
			`SELECT path, content_type, content_base64, object_key, size
			 FROM project_assets WHERE project_id = ? ORDER BY path`,
		)
		.bind(shipletId)
		.all<LegacyAsset>();
	const files = await Promise.all(
		(assetRows.results || []).map((asset) => assetFile(asset, bucket)),
	);
	if (!files.some((file) => file.path === "artifact/index.html")) {
		files.push(
			await textFile(
				"artifact/index.html",
				generatedLegacyIndex(project),
				"text/html; charset=utf-8",
			),
		);
	}
	if (project.source_type === "worker") {
		files.push(
			await textFile(
				"artifact/worker.js",
				project.script_content,
				"text/javascript; charset=utf-8",
			),
		);
	}
	if (project.source_type === "external_url" && project.external_origin_url) {
		files.push(
			await textFile(
				"artifact/external.json",
				`${JSON.stringify({
					schemaVersion: "shiplet.external-origin/v1",
					origin: project.external_origin_url,
				})}\n`,
				"application/json",
			),
		);
	}
	files.push(...(await generatedContractFiles(project)));

	return parseShipletPackage({
		mediaType: SHIPLET_PACKAGE_MEDIA_TYPE,
		manifest: {
			schemaVersion: "shiplet.package/v1",
			runtimeCompatibility: "shiplet.runtime/v1",
			entrypoints: {
				artifact: "artifact/index.html",
				widget: "widget/index.html",
				workflow: "workflow/schema.json",
				mcp: "mcp/manifest.json",
				agentInstructions: "AGENTS.md",
				validation: "validation/manifest.json",
				provenance: "provenance.json",
			},
			requestedCapabilities:
				project.source_type === "worker" ? ["runtime.worker"] : [],
			limits: LIMITS,
			staticFirst: project.source_type !== "worker",
		},
		files,
	});
}

async function activeRevision(
	db: D1Database,
	shipletId: string,
	bucket?: R2Bucket,
): Promise<ShipletRevision | null> {
	const row = await db
		.prepare(
			`SELECT revision.* FROM projects project
			 JOIN shiplet_revisions revision ON revision.id = project.active_revision_id
			 WHERE project.id = ? AND revision.project_id = project.id`,
		)
		.bind(shipletId)
		.first<{
			id: string;
			project_id: string;
			parent_revision_id: string | null;
			package_json: string;
			package_digest: string;
			content_digest: string | null;
		created_on: string;
		}>();
	if (!row) return null;
	let packageJson = row.package_json;
	const stored = JSON.parse(packageJson) as unknown;
	if (
		stored &&
		typeof stored === "object" &&
		!Array.isArray(stored) &&
		(stored as Record<string, unknown>).storage ===
			"shiplet.package.storage/r2-v1"
	) {
		const key = (stored as Record<string, unknown>).key;
		if (typeof key !== "string" || !bucket) {
			throw new Error("legacy_revision_package_storage_unavailable");
		}
		const object = await bucket.get(key);
		if (!object) throw new Error("legacy_revision_package_storage_unavailable");
		packageJson = await object.text();
	}
	return {
		id: row.id,
		shipletId: row.project_id,
		parentRevisionId: row.parent_revision_id,
		digest: row.package_digest,
		contentDigest: row.content_digest ?? row.package_digest,
		package: await parseShipletPackage(JSON.parse(packageJson)),
		createdOn: row.created_on,
	};
}

export async function migrateLegacyShipletRevision(
	db: D1Database,
	shipletId: string,
	bucket?: R2Bucket,
): Promise<ShipletRevision> {
	await ensureRevisionSchema(db);
	const existing = await activeRevision(db, shipletId, bucket);
	if (existing) return existing;
	const actor = Object.freeze({ kind: "system" as const, id: "legacy-migration" });
	const service = createRevisionService({
		db,
		...(bucket ? { packageStore: r2PackageStore(bucket) } : {}),
		kernelAuthorizer: {
			async authorize(binding: RevisionKernelAuthorizationBinding) {
				if (
					binding.shipletId !== shipletId ||
					binding.action !== "revision.create_initial" ||
					binding.actor.kind !== actor.kind ||
					binding.actor.id !== actor.id
				) {
					throw new Error("legacy_migration_authorization_denied");
				}
				return {
					authorizationId: `legacy-migration:${shipletId}`,
					binding: Object.freeze({
						shipletId: binding.shipletId,
						actor,
						action: binding.action,
					}),
				};
			},
		},
	});
	try {
		return await service.createInitialRevision({
			shipletId,
			package: await buildLegacyCompatibilityPackage(db, shipletId, bucket),
			actor,
		});
	} catch (error) {
		const concurrent = await activeRevision(db, shipletId, bucket);
		if (concurrent) return concurrent;
		throw error;
	}
}

function r2PackageStore(bucket: R2Bucket): RevisionPackageStore {
	return {
		async putText(key, value) {
			await bucket.put(key, value, {
				httpMetadata: { contentType: "application/json" },
			});
		},
		async getText(key) {
			const object = await bucket.get(key);
			return object ? object.text() : null;
		},
		async putBytes(key, value) {
			await bucket.put(key, value);
		},
	};
}
