import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { createStandaloneAssetPreviewIndex } from "../src/asset-preview";

describe("standalone asset preview", () => {
	it("Given a standalone image, when Shiplet generates its preview index, then the image is self-contained and fills the viewport without decorative framing", () => {
		const imageBytes = "png-preview-bytes";
		const preview = createStandaloneAssetPreviewIndex("Image preview", [
			{
				path: "CleanShot 2026-08-14.png",
				content: Buffer.from(imageBytes).toString("base64"),
				size: Buffer.byteLength(imageBytes),
			},
		]);
		const html = Buffer.from(preview.content, "base64").toString("utf8");

		expect(html).toContain(
			`src="data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}"`,
		);
		expect(html).toContain("height: 100dvh");
		expect(html).toContain("width: 100%");
		expect(html).toContain("object-fit: contain");
		expect(html).not.toContain('class="asset-card"');
		expect(html).not.toContain(">Open file</a>");
	});

	it.each([
		["JPEG image", "review.jpg", "image/jpeg", "img"],
		["GIF image", "review.gif", "image/gif", "img"],
		["WebP image", "review.webp", "image/webp", "img"],
		["AVIF image", "review.avif", "image/avif", "img"],
		["SVG image", "review.svg", "image/svg+xml", "img"],
		["MP4 video", "review.mp4", "video/mp4", "video"],
		["WebM video", "review.webm", "video/webm", "video"],
		["Ogg video", "review.ogv", "video/ogg", "video"],
		["QuickTime video", "review.mov", "video/quicktime", "video"],
	])(
		"Given a standalone %s, when Shiplet generates its preview, then it uses a self-contained viewport media surface",
		(_label, path, mediaType, element) => {
			const content = Buffer.from(`${path}-bytes`).toString("base64");
			const preview = createStandaloneAssetPreviewIndex("Media preview", [
				{ path, content, size: Buffer.byteLength(`${path}-bytes`) },
			]);
			const html = Buffer.from(preview.content, "base64").toString("utf8");

			expect(html).toContain(`<${element}`);
			expect(html).toContain(`src="data:${mediaType};base64,${content}"`);
			expect(html).toContain("height: 100dvh");
			expect(html).toContain("object-fit: contain");
			expect(html).not.toContain('class="asset-card"');
			expect(html).not.toContain(">Open file</a>");
		},
	);

	it("Given JSON with markup-shaped content, when Shiplet generates its preview, then it renders escaped readable text and a self-contained download", () => {
		const json = JSON.stringify({ title: "Map", note: "<script>alert(1)</script>" });
		const preview = createStandaloneAssetPreviewIndex("No-index preview", [
			{
				path: "data/review.json",
				content: Buffer.from(json).toString("base64"),
				size: Buffer.byteLength(json),
			},
		]);
		const html = Buffer.from(preview.content, "base64").toString("utf8");

		expect(html).toContain('class="asset-text-preview"');
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain(
			`href="data:application/json;charset=utf-8;base64,${Buffer.from(json).toString("base64")}"`,
		);
		expect(html).toContain('download="review.json"');
		expect(html).toContain(">Download<");
		expect(html).not.toContain('href="./data/review.json"');
		expect(html).not.toContain('class="asset-card"');
	});

	it.each([
		["TypeScript", "src/map.ts", "const layer = '<unsafe>';"],
		["Python", "analysis.py", "print('<unsafe>')"],
		["YAML", "map.yaml", "name: <unsafe>"],
		["SQL", "query.sql", "select '<unsafe>';"],
		["GeoJSON", "districts.geojson", '{"type":"FeatureCollection","features":[]}'],
		["KML", "route.kml", "<kml><Placemark /></kml>"],
		["GPX", "track.gpx", '<gpx creator="Shiplet"></gpx>'],
	])(
		"Given a standalone %s file, when Shiplet generates its preview, then it shows escaped UTF-8 source",
		(_label, path, source) => {
			const preview = createStandaloneAssetPreviewIndex("Text preview", [
				{
					path,
					content: Buffer.from(source).toString("base64"),
					size: Buffer.byteLength(source),
				},
			]);
			const html = Buffer.from(preview.content, "base64").toString("utf8");

			expect(html).toContain('class="asset-text-preview"');
			const expectedSource = path.endsWith(".geojson")
				? "&quot;type&quot;: &quot;FeatureCollection&quot;"
				: source
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;")
						.replace(/"/g, "&quot;")
						.replace(/'/g, "&#39;");
			expect(html).toContain(expectedSource);
			expect(html).toContain("base64,");
			expect(html).toContain(">Download<");
			expect(html).not.toContain('class="asset-card"');
		},
	);

	it.each([
		["PDF", "report.pdf", "application/pdf"],
		["HEIC image", "photo.heic", "image/heic"],
		["HEIF image", "photo.heif", "image/heif"],
		["GeoPackage", "city.gpkg", "application/geopackage+sqlite3"],
		["GeoTIFF", "elevation.tif", "image/tiff"],
		["LAZ point cloud", "survey.laz", "application/vnd.laszip"],
		["GeoParquet", "parcels.parquet", "application/vnd.apache.parquet"],
	])(
		"Given a standalone %s file, when Shiplet cannot safely render it, then it shows metadata and a self-contained download",
		(_label, path, mediaType) => {
			const bytes = `${path}-binary`;
			const content = Buffer.from(bytes).toString("base64");
			const preview = createStandaloneAssetPreviewIndex("Binary preview", [
				{ path, content, size: Buffer.byteLength(bytes) },
			]);
			const html = Buffer.from(preview.content, "base64").toString("utf8");

			expect(html).toContain('class="asset-binary-preview"');
			expect(html).toContain(`${Buffer.byteLength(bytes)} bytes`);
			expect(html).toContain(
				`href="data:${mediaType};base64,${content}"`,
			);
			expect(html).toContain(">Download<");
			expect(html).not.toContain("<iframe");
			expect(html).not.toContain('class="asset-card"');
		},
	);

	it("Given the companion files of a shapefile, when Shiplet generates its preview, then it identifies the related set", () => {
		const assets = ["roads.shp", "roads.shx", "roads.dbf", "roads.prj"].map(
			(path) => ({
				path,
				content: Buffer.from(path).toString("base64"),
				size: Buffer.byteLength(path),
			}),
		);
		const preview = createStandaloneAssetPreviewIndex("Shapefile", assets);
		const html = Buffer.from(preview.content, "base64").toString("utf8");

		expect(html).toContain("Shapefile set");
		expect(html).toContain("4 related files");
		for (const path of ["roads.shp", "roads.shx", "roads.dbf", "roads.prj"]) {
			expect(html).toContain(path);
		}
	});
});
