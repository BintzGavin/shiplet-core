// Regenerates raster brand assets from the "Harbor Office" mark (see DESIGN.md).
//
// Usage: node scripts/generate-brand-assets.mjs
//
// Outputs:
//   public/brand/logo.png        512x512  (favicon.ico + manifest icon)
//   public/apple-touch-icon.png  180x180  (full-bleed, iOS applies its own mask)
//   public/og-image.png          1200x630 (social card)
//   src/generated-brand-assets.ts          (base64 copies served by the Worker)
//
// Brand fonts are fetched from Google Fonts at run time so the repo stays lean.

import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontDir = path.join(root, "node_modules", ".cache", "shiplet-brand-fonts");

const INK = "#20293a";
const INK_SOFT = "#3a4459";
const PAPER = "#fbf9f4";
const PAPER_BG = "#f7f5ef";
const BUOY = "#c2502f";
const HARBOR = "#2f6e88";

// Pennant + hull + cargo art, identical geometry to SHIPLET_FAVICON_SVG in src/seo.ts.
const MARK_ART = `
	<g transform="translate(0 -8)">
		<rect x="62" y="20" width="4" height="42" rx="2" fill="${INK}"/>
		<path d="M66 18l26 11-26 11z" fill="${BUOY}"/>
		<rect x="40" y="62" width="21" height="20" rx="2" fill="${HARBOR}"/>
		<rect x="67" y="62" width="21" height="20" rx="2" fill="${BUOY}"/>
		<path d="M28 86h72l-13 24H41z" fill="${INK}"/>
		<path d="M29 118q7-7 14 0t14 0t14 0t14 0t14 0" fill="none" stroke="${HARBOR}" stroke-width="5" stroke-linecap="round"/>
	</g>`;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" shape-rendering="geometricPrecision">
  <rect x="6" y="6" width="116" height="116" rx="26" fill="${PAPER}" stroke="${INK}" stroke-width="7"/>
  ${MARK_ART}
</svg>`;

// Full-bleed for iOS: no transparent corners, art centered with safe margins.
const APPLE_TOUCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" shape-rendering="geometricPrecision">
  <rect width="128" height="128" fill="${PAPER}"/>
  <g transform="translate(64 66) scale(0.92) translate(-64 -66)">${MARK_ART}</g>
</svg>`;

function waveLine(y, xOffset = 0) {
	const bump = "t30 0";
	return `<path d="M${-30 + xOffset} ${y} q15 -13 30 0 ${bump.repeat(43).replaceAll("t", " t")}" fill="none" stroke="${HARBOR}" stroke-width="3" opacity="0.45"/>`;
}

const OG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" shape-rendering="geometricPrecision">
  <rect width="1200" height="630" fill="${PAPER_BG}"/>
  <rect width="1200" height="8" fill="${INK}"/>
  <rect y="14" width="1200" height="2" fill="${INK}" opacity="0.3"/>
  <text x="1090" y="64" font-family="IBM Plex Mono" font-size="22" font-weight="600" letter-spacing="2" fill="${INK_SOFT}" text-anchor="end">shiplet.cc</text>
  <g transform="rotate(-4 1015 120)">
    <rect x="905" y="92" width="220" height="56" rx="6" fill="none" stroke="${HARBOR}" stroke-width="3"/>
    <text x="1015" y="128" font-family="IBM Plex Mono" font-size="21" font-weight="600" letter-spacing="3" fill="${HARBOR}" text-anchor="middle">PF-1 · REVIEWED</text>
  </g>
  <g transform="translate(96 142) scale(2.55) translate(-26 -20)">${MARK_ART}</g>
  <text x="392" y="318" font-family="Bricolage Grotesque" font-size="124" font-weight="700" letter-spacing="-3" fill="${INK}">Shiplet</text>
  <text x="398" y="382" font-family="IBM Plex Mono" font-size="26" font-weight="600" fill="${INK_SOFT}">Share previews. Collect feedback. Keep shipping.</text>
  ${waveLine(560)}
  ${waveLine(584, 15)}
  ${waveLine(608)}
</svg>`;

/* --------------------------------------------------------------------------
   Decoration art — transparent PNGs for page chrome (2007-harbor-office era).
   Hemp rope reads on both paper and night-watch navy; watermarks bake their
   low alpha into the pixels so CSS can layer them anywhere.
   -------------------------------------------------------------------------- */

const HEMP = "#b08a5e";
const HEMP_DARK = "#6e5435";

function ropeStrands(centers, angle, cy) {
	return centers
		.map(
			(c) =>
				`<g transform="rotate(${angle} ${c} ${cy})"><rect x="${c - 3.5}" y="${cy - 9}" width="7" height="18" rx="3.5" fill="${HEMP}" stroke="${HEMP_DARK}" stroke-width="1.2"/></g>`,
		)
		.join("");
}

// Seamless twisted-rope tiles, 12px strand period.
const ROPE_H_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="14" viewBox="0 0 48 14">
  <g opacity="0.92">${ropeStrands([-6, 6, 18, 30, 42, 54], -38, 7)}</g>
</svg>`;

const ROPE_V_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="48" viewBox="0 0 14 48">
  <g opacity="0.92" transform="rotate(90 7 7) translate(0 -0)">${ropeStrands([-6, 6, 18, 30, 42, 54], -38, 7)}</g>
</svg>`;

// Coiled rope loop with two working ends — corner flourish.
const ROPE_KNOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <g opacity="0.9" fill="none" stroke-linecap="round">
    <circle cx="58" cy="52" r="30" stroke="${HEMP}" stroke-width="11"/>
    <circle cx="58" cy="52" r="30" stroke="${HEMP_DARK}" stroke-width="11" stroke-dasharray="3.2 8.8" opacity="0.5"/>
    <circle cx="58" cy="52" r="36" stroke="${HEMP_DARK}" stroke-width="1.4" opacity="0.7"/>
    <circle cx="58" cy="52" r="24.5" stroke="${HEMP_DARK}" stroke-width="1.4" opacity="0.7"/>
    <path d="M80 74q15 9 21 27" stroke="${HEMP}" stroke-width="9"/>
    <path d="M80 74q15 9 21 27" stroke="${HEMP_DARK}" stroke-width="9" stroke-dasharray="2.8 7.5" opacity="0.5"/>
    <path d="M86 66q18 2 27 13" stroke="${HEMP}" stroke-width="9"/>
    <path d="M86 66q18 2 27 13" stroke="${HEMP_DARK}" stroke-width="9" stroke-dasharray="2.8 7.5" opacity="0.5"/>
    <path d="M101 101l4 9m-1-11l8 6m-13-3l1 10" stroke="${HEMP_DARK}" stroke-width="2"/>
    <path d="M113 79l9 4m-8-8l10 1m-11-6l9-3" stroke="${HEMP_DARK}" stroke-width="2"/>
  </g>
</svg>`;

// Admiralty anchor watermark, alpha baked in.
const ANCHOR_WM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360" viewBox="0 0 360 360">
  <g opacity="0.13" stroke="${HARBOR}" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="180" cy="62" r="28"/>
    <path d="M180 90v180"/>
    <path d="M122 132h116"/>
    <path d="M76 216q14 80 104 90 90-10 104-90"/>
    <path d="M76 216l-30 20m30-20l38 4"/>
    <path d="M284 216l30 20m-30-20l-38 4"/>
  </g>
</svg>`;

// Compass rose watermark.
const COMPASS_WM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <g opacity="0.12">
    <g fill="${HARBOR}">
      <path d="M150 26l12 112-12 12-12-12z"/>
      <path d="M274 150l-112 12-12-12 12-12z"/>
      <path d="M150 274l-12-112 12-12 12 12z"/>
      <path d="M26 150l112-12 12 12-12 12z"/>
      <g transform="rotate(45 150 150)" opacity="0.6">
        <path d="M150 70l8 72-8 8-8-8z"/>
        <path d="M230 150l-72 8-8-8 8-8z"/>
        <path d="M150 230l-8-72 8-8 8 8z"/>
        <path d="M70 150l72-8 8 8-8 8z"/>
      </g>
    </g>
    <circle cx="150" cy="150" r="126" fill="none" stroke="${HARBOR}" stroke-width="6"/>
    <circle cx="150" cy="150" r="112" fill="none" stroke="${HARBOR}" stroke-width="2.5"/>
    <circle cx="150" cy="150" r="14" fill="none" stroke="${HARBOR}" stroke-width="6"/>
  </g>
</svg>`;

const FONT_SOURCES = [
	{
		file: "bricolage-grotesque-700.ttf",
		cssUrl: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700",
	},
	{
		file: "ibm-plex-mono-600.ttf",
		cssUrl: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@600",
	},
];

async function ensureFonts() {
	await mkdir(fontDir, { recursive: true });
	const files = [];
	for (const source of FONT_SOURCES) {
		const target = path.join(fontDir, source.file);
		if (!existsSync(target)) {
			// No modern user agent -> Google Fonts serves static TTF instances.
			const css = await (await fetch(source.cssUrl, { headers: { "user-agent": "curl/8" } })).text();
			const match = css.match(/url\((https:[^)]+\.ttf)\)/);
			if (!match) throw new Error(`No TTF URL found for ${source.cssUrl}`);
			const fontBytes = await (await fetch(match[1])).arrayBuffer();
			await writeFile(target, Buffer.from(fontBytes));
		}
		files.push(target);
	}
	return files;
}

function renderPng(svg, width, fontFiles) {
	const resvg = new Resvg(svg, {
		fitTo: { mode: "width", value: width },
		font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Bricolage Grotesque" },
	});
	return resvg.render().asPng();
}

const fontFiles = await ensureFonts();

const logo = renderPng(LOGO_SVG, 512, fontFiles);
const appleTouch = renderPng(APPLE_TOUCH_SVG, 180, fontFiles);
const ogImage = renderPng(OG_SVG, 1200, fontFiles);
const logoSource = renderPng(LOGO_SVG, 1024, fontFiles);

// Decor renders at 2x for retina; CSS background-size halves them back down.
const outputs = {
	logoPng: { png: logo, file: "public/brand/logo.png" },
	appleTouchIconPng: { png: appleTouch, file: "public/apple-touch-icon.png" },
	ogImagePng: { png: ogImage, file: "public/og-image.png" },
	ropeHPng: { png: renderPng(ROPE_H_SVG, 96, fontFiles), file: "public/brand/decor/rope-h.png" },
	ropeVPng: { png: renderPng(ROPE_V_SVG, 28, fontFiles), file: "public/brand/decor/rope-v.png" },
	ropeKnotPng: { png: renderPng(ROPE_KNOT_SVG, 240, fontFiles), file: "public/brand/decor/rope-knot.png" },
	anchorPng: { png: renderPng(ANCHOR_WM_SVG, 540, fontFiles), file: "public/brand/decor/anchor.png" },
	compassPng: { png: renderPng(COMPASS_WM_SVG, 450, fontFiles), file: "public/brand/decor/compass.png" },
};

await mkdir(path.join(root, "public", "brand", "decor"), { recursive: true });
await writeFile(path.join(root, "public", "brand", "shiplet-logo-source.png"), logoSource);
for (const { png, file } of Object.values(outputs)) {
	await writeFile(path.join(root, file), png);
}

const generated = `// Generated by scripts/generate-brand-assets.mjs. Do not edit by hand.

export const BRAND_ASSETS = {
${Object.entries(outputs)
	.map(([key, { png }]) => `\t"${key}": "${png.toString("base64")}"`)
	.join(",\n")}
} as const;
`;

await writeFile(path.join(root, "src", "generated-brand-assets.ts"), generated);

console.log(
	Object.entries(outputs)
		.map(([key, { png }]) => `${key} ${png.length}B`)
		.join(" · "),
);
