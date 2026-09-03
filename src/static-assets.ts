import type { AssetFile } from "./resource";
import { staticAssetContentTypeForPath } from "./static-asset-types";
import type { Project } from "./types";

type StaticAssetRow = {
	path: string;
	content_type: string;
	content_base64: string;
	object_key: string | null;
	size: number;
};

export async function storeStaticAssets(
	db: D1Database,
	bucket: R2Bucket | undefined,
	projectId: string,
	assets: AssetFile[],
) {
	await db
		.prepare("DELETE FROM project_assets WHERE project_id = ?")
		.bind(projectId)
		.run();

	const now = new Date().toISOString();
	const statements: D1PreparedStatement[] = [];

	for (const asset of assets) {
		const normalizedPath = normalizeAssetPath(asset.path);
		const objectKey = bucket
			? `static-assets/${projectId}/${normalizedPath.slice(1)}`
			: null;
		const contentBase64 = objectKey ? "" : asset.content;

		if (bucket && objectKey) {
			await bucket.put(objectKey, base64ToBytes(asset.content), {
				httpMetadata: { contentType: contentTypeForPath(asset.path) },
			});
		}

		statements.push(
			db.prepare(
				`INSERT INTO project_assets
				 (project_id, path, content_type, content_base64, object_key, size, created_on)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					projectId,
					normalizedPath,
					contentTypeForPath(asset.path),
					contentBase64,
					objectKey,
					asset.size,
					now,
				),
		);
	}

	if (statements.length > 0) {
		await db.batch(statements);
	}
}

export async function serveStaticAsset(
	db: D1Database,
	bucket: R2Bucket | undefined,
	project: Project,
	request: Request,
) {
	const url = new URL(request.url);
	const candidates = assetCandidates(url.pathname);

	for (const candidate of candidates) {
		const row = await db
			.prepare(
				`SELECT path, content_type, content_base64, object_key, size
				 FROM project_assets
				 WHERE project_id = ? AND path = ?
				 LIMIT 1`,
			)
			.bind(project.id, candidate)
			.first<StaticAssetRow>();

		if (!row) continue;

		const headers = new Headers({
			"content-type": row.content_type,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "strict-origin-when-cross-origin",
			"permissions-policy":
				"camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		});
		if (row.content_type.startsWith("image/svg+xml")) {
			headers.set(
				"content-security-policy",
				"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
			);
		}
		headers.set("content-length", String(row.size));

		if (row.object_key && bucket) {
			const object = await bucket.get(row.object_key);
			if (object) {
				headers.set("x-shiplet-static-fallback", "r2");
				return new Response(object.body, { headers });
			}
		}

		if (row.content_base64) {
			const bytes = base64ToBytes(row.content_base64);
			headers.set("content-length", String(bytes.byteLength));
			headers.set("x-shiplet-static-fallback", "d1");
			return new Response(bytes, { headers });
		}
	}

	return null;
}

export async function deleteStaticAssets(
	db: D1Database,
	bucket: R2Bucket | undefined,
	projectId: string,
) {
	const rows = await db
		.prepare(
			`SELECT object_key
			 FROM project_assets
			 WHERE project_id = ? AND object_key IS NOT NULL`,
		)
		.bind(projectId)
		.all<{ object_key: string }>();

	if (bucket) {
		for (const row of rows.results || []) {
			if (row.object_key) {
				await bucket.delete(row.object_key);
			}
		}
	}

	await db
		.prepare("DELETE FROM project_assets WHERE project_id = ?")
		.bind(projectId)
		.run();
}

function assetCandidates(pathname: string) {
	const normalized = normalizeRequestAssetPath(pathname);
	const candidates = [normalized];
	if (normalized === "/") {
		candidates.push("/index.html");
	} else if (normalized.endsWith("/")) {
		candidates.push(`${normalized}index.html`);
	} else if (!normalized.split("/").pop()?.includes(".")) {
		candidates.push(`${normalized}/index.html`, `${normalized}.html`);
	}
	return Array.from(new Set(candidates));
}

function normalizeRequestAssetPath(pathname: string) {
	try {
		return normalizeAssetPath(decodeURIComponent(pathname));
	} catch {
		return normalizeAssetPath(pathname);
	}
}

function normalizeAssetPath(path: string) {
	const cleaned = path.replace(/^\.?\//, "");
	return `/${cleaned}`.replace(/\/+/g, "/");
}

function contentTypeForPath(path: string) {
	return staticAssetContentTypeForPath(path);
}

function base64ToBytes(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
