import type { AssetFile } from "./resource";
import {
	ALLOWED_STATIC_ASSET_EXTENSIONS,
	ALLOWED_STATIC_ASSET_DOTFILES,
	ALLOWED_STATIC_ASSET_FILENAMES,
	BLOCKED_STATIC_ASSET_EXTENSIONS,
	staticAssetExtension,
	staticAssetFileName,
} from "./static-asset-types";

export const MAX_UPLOAD_JSON_BYTES = 80 * 1024 * 1024;
export const MAX_STATIC_ASSET_FILES = 200;
export const MAX_STATIC_ASSET_FILE_BYTES = 10_000_000;
export const MAX_STATIC_ASSET_TOTAL_BYTES = 50_000_000;

const MAX_STATIC_ASSET_PATH_LENGTH = 512;

export function validateAndNormalizeStaticAssets(value: unknown): AssetFile[] {
	if (!Array.isArray(value)) return [];
	if (value.length > MAX_STATIC_ASSET_FILES) {
		throw new Response(
			`Static uploads are limited to ${MAX_STATIC_ASSET_FILES} files.`,
			{ status: 413 },
		);
	}

	let totalBytes = 0;
	const assets: AssetFile[] = [];

	for (const asset of value) {
		if (!isRecord(asset)) {
			throw new Response("Invalid asset entry.", { status: 400 });
		}

		const path = normalizeStaticAssetPath(asset.path);
		assertSupportedAssetType(path);

		const content = normalizeBase64Content(asset.content, path);
		const size = decodedBase64Size(content, path);
		if (size === 0) continue;

		if (size > MAX_STATIC_ASSET_FILE_BYTES) {
			throw new Response(
				`Asset is too large. Each file is limited to ${formatBytes(MAX_STATIC_ASSET_FILE_BYTES)}.`,
				{ status: 413 },
			);
		}

		totalBytes += size;
		if (totalBytes > MAX_STATIC_ASSET_TOTAL_BYTES) {
			throw new Response(
				`Static upload is too large. Total files are limited to ${formatBytes(MAX_STATIC_ASSET_TOTAL_BYTES)}.`,
				{ status: 413 },
			);
		}

		assets.push({ path, content, size });
	}

	return assets;
}

function normalizeStaticAssetPath(value: unknown) {
	if (typeof value !== "string") {
		throw new Response("Unsafe asset path.", { status: 400 });
	}

	const rawPath = value.trim().replace(/\\/g, "/");
	if (
		!rawPath ||
		rawPath.length > MAX_STATIC_ASSET_PATH_LENGTH ||
		rawPath.includes("\0") ||
		rawPath.startsWith("/") ||
		/^[a-zA-Z]:/.test(rawPath)
	) {
		throw new Response("Unsafe asset path.", { status: 400 });
	}

	const path = rawPath.replace(/^\.\/+/, "").replace(/\/+/g, "/");
	const segments = path.split("/");
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === "." ||
				segment === ".." ||
				(segment.startsWith(".") &&
					!ALLOWED_STATIC_ASSET_DOTFILES.has(segment.toLowerCase())),
		)
	) {
		throw new Response("Unsafe asset path.", { status: 400 });
	}

	return path;
}

function assertSupportedAssetType(path: string) {
	const extension = staticAssetExtension(path);
	const fileName = staticAssetFileName(path);
	if (
		(!extension && !ALLOWED_STATIC_ASSET_FILENAMES.has(fileName)) ||
		BLOCKED_STATIC_ASSET_EXTENSIONS.has(extension) ||
		(!ALLOWED_STATIC_ASSET_EXTENSIONS.has(extension) &&
			!ALLOWED_STATIC_ASSET_FILENAMES.has(fileName))
	) {
		throw new Response(`Unsupported asset type: .${extension || "none"}`, {
			status: 400,
		});
	}
}

function normalizeBase64Content(value: unknown, path: string) {
	if (typeof value !== "string") {
		throw new Response(`Invalid base64 content for ${path}.`, { status: 400 });
	}
	return value.trim();
}

function decodedBase64Size(value: string, path: string) {
	if (!value) return 0;
	if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
		throw new Response(`Invalid base64 content for ${path}.`, { status: 400 });
	}

	try {
		return atob(value).length;
	} catch {
		throw new Response(`Invalid base64 content for ${path}.`, { status: 400 });
	}
}

function formatBytes(value: number) {
	if (value >= 1_000_000) return `${value / 1_000_000} MB`;
	if (value >= 1_000) return `${value / 1_000} KB`;
	return `${value} bytes`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
