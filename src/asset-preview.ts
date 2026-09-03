import type { AssetFile } from "./resource";
import {
	ALLOWED_STATIC_ASSET_FILENAMES,
	STATIC_AUDIO_EXTENSIONS,
	STATIC_IMAGE_EXTENSIONS,
	STATIC_TEXT_EXTENSIONS,
	STATIC_VIDEO_EXTENSIONS,
	staticAssetContentTypeForPath,
	staticAssetExtension,
	staticAssetFileName,
} from "./static-asset-types";

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;
const JSON_EXTENSIONS = new Set([
	"geojson",
	"ipynb",
	"json",
	"map",
	"topojson",
	"webmanifest",
]);
const SHAPEFILE_EXTENSIONS = new Set([
	"cpg",
	"dbf",
	"prj",
	"qix",
	"sbn",
	"sbx",
	"shp",
	"shx",
]);

export const STANDALONE_ASSET_PREVIEW_MARKER =
	"/* Shiplet generated standalone asset preview */";

export function createStandaloneAssetPreviewIndex(
	shipletName: string,
	assets: AssetFile[],
): AssetFile {
	const html = standaloneAssetPreviewHtml(shipletName, assets);
	return {
		path: "index.html",
		content: utf8ToBase64(html),
		size: new TextEncoder().encode(html).byteLength,
	};
}

function standaloneAssetPreviewHtml(shipletName: string, assets: AssetFile[]) {
	const title = escapeHtml(shipletName || "Shiplet preview");
	const assetPreviews = assets
		.map((asset) => renderAssetPreview(asset, assets))
		.join("\n");
	const assetCount = assets.length;
	const mediaOnly = assets.every(isEmbeddableMedia);
	return `<!doctype html>
<html lang="en" data-shiplet-generated-asset-preview="v2">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${title}</title>
	<style>
		* { box-sizing: border-box; }
		:root {
			color-scheme: light;
			font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			background: #fff;
			color: #172243;
		}
		html, body {
			margin: 0;
			width: 100%;
			min-height: 100vh;
			min-height: 100dvh;
			overflow-x: hidden;
			background: #fff;
		}
		main { width: 100%; min-height: 100dvh; }
		header {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 18px;
			padding: 18px 22px;
			border-bottom: 1px solid #dfe3ec;
			background: #fff;
		}
		h1 {
			margin: 0;
			font-size: clamp(1.15rem, 2.4vw, 1.65rem);
			line-height: 1.15;
		}
		p { margin: 0; color: #5a6680; }
		.asset-grid { display: grid; width: 100%; }
		.asset-grid-media { min-height: 100vh; min-height: 100dvh; }
		.media-preview { height: 100vh; height: 100dvh; overflow: auto; }
		.asset-viewer {
			position: relative;
			display: grid;
			place-items: center;
			width: 100%;
			height: 100vh;
			height: 100dvh;
			max-width: 100vw;
			margin: 0;
			overflow: hidden;
			background: #fff;
		}
		.asset-media {
			display: block;
			width: 100%;
			height: 100%;
			max-width: 100%;
			max-height: 100%;
			object-fit: contain;
		}
		.asset-audio { width: min(720px, calc(100% - 32px)); height: auto; }
		.asset-download {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			min-height: 38px;
			padding: 0 14px;
			border: 1px solid #172243;
			border-radius: 8px;
			background: #172243;
			color: #fff;
			font-size: .875rem;
			font-weight: 750;
			text-decoration: none;
		}
		.asset-download:hover { background: #2c3a62; }
		.asset-download:focus-visible { outline: 3px solid #4d79ff; outline-offset: 2px; }
		.asset-download-floating {
			position: absolute;
			top: 14px;
			right: 14px;
			z-index: 2;
			box-shadow: 0 3px 14px rgba(23, 34, 67, .22);
		}
		.asset-document {
			display: grid;
			grid-template-rows: auto minmax(0, 1fr);
			min-width: 0;
			min-height: calc(100vh - 68px);
			min-height: calc(100dvh - 68px);
			border-bottom: 1px solid #dfe3ec;
			background: #fff;
		}
		.asset-toolbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 16px;
			min-width: 0;
			padding: 12px 18px;
			border-bottom: 1px solid #e8ebf1;
			background: #f7f8fb;
		}
		.asset-identity { min-width: 0; }
		.asset-name { overflow-wrap: anywhere; font-weight: 760; }
		.asset-meta { margin-top: 3px; color: #68748d; font-size: .8rem; }
		.asset-content { min-width: 0; min-height: 0; }
		.asset-text-preview {
			width: 100%;
			height: 100%;
			min-height: calc(100vh - 125px);
			min-height: calc(100dvh - 125px);
			margin: 0;
			padding: 22px;
			overflow: auto;
			background: #fbfcfe;
			color: #172243;
			font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
			tab-size: 2;
			white-space: pre;
		}
		.asset-preview-note {
			padding: 9px 18px;
			border-bottom: 1px solid #e8ebf1;
			background: #fff8dc;
			color: #5e4a00;
			font-size: .82rem;
		}
		.asset-binary-preview {
			display: grid;
			place-content: center;
			justify-items: center;
			gap: 10px;
			min-height: calc(100vh - 125px);
			min-height: calc(100dvh - 125px);
			padding: 32px;
			text-align: center;
			background: #fbfcfe;
		}
		.asset-type {
			display: grid;
			place-items: center;
			width: 72px;
			height: 88px;
			border: 2px solid #172243;
			border-radius: 8px;
			background: #fff;
			font: 800 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
		}
		.asset-binary-preview strong { max-width: min(680px, 90vw); overflow-wrap: anywhere; }
		.asset-binary-preview p { max-width: 620px; }
		.sr-only {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border: 0;
		}
		@media (max-width: 640px) {
			header { align-items: flex-start; flex-direction: column; padding: 14px; }
			.asset-toolbar { align-items: flex-start; padding: 11px 12px; }
			.asset-text-preview { padding: 14px; }
			.asset-download-floating { top: 10px; right: 10px; }
		}
	</style>
</head>
<body>
	<main${mediaOnly ? ' class="media-preview"' : ""}>
		${
			mediaOnly
				? ""
				: `<header>
			<h1>${title}</h1>
			<p>${assetCount === 1 ? "One file" : `${assetCount} files`}</p>
		</header>`
		}
		<section class="asset-grid${mediaOnly ? " asset-grid-media" : ""}" aria-label="Uploaded assets">
			${assetPreviews}
		</section>
	</main>
</body>
</html>`;
}

function renderAssetPreview(asset: AssetFile, assets: AssetFile[]) {
	if (isEmbeddableMedia(asset)) return renderEmbeddedMedia(asset);
	const text = readableTextPreview(asset);
	return text === null
		? renderBinaryPreview(asset, assets)
		: renderTextPreview(asset, assets, text);
}

function isEmbeddableMedia(asset: AssetFile) {
	const extension = staticAssetExtension(asset.path);
	return (
		STATIC_IMAGE_EXTENSIONS.has(extension) ||
		STATIC_VIDEO_EXTENSIONS.has(extension) ||
		STATIC_AUDIO_EXTENSIONS.has(extension)
	);
}

function renderEmbeddedMedia(asset: AssetFile) {
	const extension = staticAssetExtension(asset.path);
	const label = escapeHtml(assetDisplayPath(asset.path));
	const source = downloadHref(asset);
	let media: string;
	if (STATIC_IMAGE_EXTENSIONS.has(extension)) {
		media = `<img class="asset-media" src="${source}" alt="${label}">`;
	} else if (STATIC_VIDEO_EXTENSIONS.has(extension)) {
		media = `<video class="asset-media" src="${source}" controls playsinline aria-label="${label}"></video>`;
	} else {
		media = `<audio class="asset-media asset-audio" src="${source}" controls aria-label="${label}"></audio>`;
	}
	return `<figure class="asset-viewer">
	${media}
	<a class="asset-download asset-download-floating" href="${source}" download="${downloadName(asset.path)}">Download</a>
	<figcaption class="sr-only">${label}</figcaption>
</figure>`;
}

function renderTextPreview(
	asset: AssetFile,
	assets: AssetFile[],
	preview: { text: string; truncated: boolean },
) {
	const companionContext = renderCompanionContext(asset, assets);
	const note = preview.truncated
		? `<div class="asset-preview-note">Showing the first ${formatBytes(MAX_TEXT_PREVIEW_BYTES)}. Download the file to inspect the rest.</div>`
		: "";
	return `<article class="asset-document">
	${renderAssetToolbar(asset, companionContext)}
	<div class="asset-content">
		${note}
		<pre class="asset-text-preview"><code>${escapeHtml(preview.text)}</code></pre>
	</div>
</article>`;
}

function renderBinaryPreview(asset: AssetFile, assets: AssetFile[]) {
	const extension = staticAssetExtension(asset.path);
	const label = escapeHtml(assetDisplayPath(asset.path));
	const companionContext = renderCompanionContext(asset, assets);
	return `<article class="asset-document">
	${renderAssetToolbar(asset, companionContext)}
	<div class="asset-content">
		<div class="asset-binary-preview">
			<span class="asset-type" aria-hidden="true">${escapeHtml(extension.toUpperCase() || "FILE")}</span>
			<strong>${label}</strong>
			<p>${escapeHtml(binaryPreviewMessage(extension))}</p>
		</div>
	</div>
</article>`;
}

function renderAssetToolbar(asset: AssetFile, companionContext: string) {
	const label = escapeHtml(assetDisplayPath(asset.path));
	return `<div class="asset-toolbar">
	<div class="asset-identity">
		<div class="asset-name">${label}</div>
		<div class="asset-meta">${escapeHtml(formatLabel(asset.path))} · ${formatBytes(asset.size)}${companionContext}</div>
	</div>
	<a class="asset-download" href="${downloadHref(asset)}" download="${downloadName(asset.path)}">Download</a>
</div>`;
}

function readableTextPreview(asset: AssetFile) {
	const extension = staticAssetExtension(asset.path);
	if (
		!STATIC_TEXT_EXTENSIONS.has(extension) &&
		!ALLOWED_STATIC_ASSET_FILENAMES.has(staticAssetFileName(asset.path))
	) {
		return null;
	}
	try {
		const bytes = base64ToBytes(asset.content);
		const truncated = bytes.byteLength > MAX_TEXT_PREVIEW_BYTES;
		const previewBytes = truncated
			? bytes.slice(0, MAX_TEXT_PREVIEW_BYTES)
			: bytes;
		let text = new TextDecoder("utf-8", { fatal: !truncated }).decode(
			previewBytes,
		);
		if (!truncated && JSON_EXTENSIONS.has(extension)) {
			try {
				text = JSON.stringify(JSON.parse(text), null, 2);
			} catch {
				// Invalid JSON is still useful as escaped source text.
			}
		}
		return { text, truncated };
	} catch {
		return null;
	}
}

function renderCompanionContext(asset: AssetFile, assets: AssetFile[]) {
	const extension = staticAssetExtension(asset.path);
	if (!SHAPEFILE_EXTENSIONS.has(extension)) return "";
	const stem = pathStem(asset.path);
	const companions = assets.filter(
		(candidate) =>
			pathStem(candidate.path) === stem &&
			SHAPEFILE_EXTENSIONS.has(staticAssetExtension(candidate.path)),
	);
	if (companions.length < 2) return "";
	return ` · Shapefile set · ${companions.length} related files`;
}

function pathStem(path: string) {
	return path.replace(/\.[^.\/]+$/, "").toLowerCase();
}

function binaryPreviewMessage(extension: string) {
	if (extension === "pdf") {
		return "PDF rendering is disabled in the isolated review sandbox. Download to open it in a PDF reader.";
	}
	if (["zip", "7z", "tar", "tgz", "gz", "bz2"].includes(extension)) {
		return "Archive contents are not executed or inspected here. Download only if you trust the upload.";
	}
	return "This format is preserved as uploaded but is not rendered in the browser. Download it for use in a compatible application.";
}

function formatLabel(path: string) {
	const extension = staticAssetExtension(path);
	const labels: Record<string, string> = {
		dbf: "Shapefile table",
		geojson: "GeoJSON",
		gpkg: "GeoPackage",
		gpx: "GPX",
		kml: "KML",
		kmz: "KMZ",
		las: "LAS point cloud",
		laz: "LAZ point cloud",
		parquet: "Parquet",
		pdf: "PDF document",
		pmtiles: "PMTiles",
		shp: "Shapefile geometry",
		shx: "Shapefile index",
		tif: "TIFF / GeoTIFF",
		tiff: "TIFF / GeoTIFF",
		topojson: "TopoJSON",
	};
	return labels[extension] || extension.toUpperCase() || "Text file";
}

function downloadHref(asset: AssetFile) {
	const type = staticAssetContentTypeForPath(asset.path).replace(/;\s*/g, ";");
	return `data:${type};base64,${asset.content}`;
}

function downloadName(path: string) {
	return Array.from(path.split("/").pop() || "download")
		.map((character) =>
			/[A-Za-z0-9._-]/.test(character)
				? character
				: `&#${character.codePointAt(0)};`,
		)
		.join("");
}

function assetDisplayPath(path: string) {
	return path.split("/").map(encodeURIComponent).join("/");
}

function formatBytes(value: number) {
	if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)} MB`;
	if (value >= 1_000) return `${trimDecimal(value / 1_000)} KB`;
	return `${value} ${value === 1 ? "byte" : "bytes"}`;
}

function trimDecimal(value: number) {
	return value.toFixed(value >= 10 ? 1 : 2).replace(/\.0+$|0+$/g, "").replace(/\.$/, "");
}

function base64ToBytes(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function utf8ToBase64(value: string) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
