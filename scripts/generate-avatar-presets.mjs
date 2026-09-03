// Generates Shiplet International Code of Signals avatar preset sprites.
//
// Usage: node scripts/generate-avatar-presets.mjs
//
// Outputs:
//   public/brand/avatars/shiplet-avatar-presets.png
//   public/brand/avatars/shiplet-avatar-presets-source.svg
//   src/generated-avatar-assets.ts

import { Resvg } from "@resvg/resvg-js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const avatarDir = path.join(root, "public", "brand", "avatars");

const CELL_SIZE = 180;
const OUTPUT_COLUMNS = 4;
const OUTPUT_ROWS = 3;

const INK = "#20293a";
const BLUE = "#003a78";
const RED = "#c8102e";
const YELLOW = "#f6c343";
const BLACK = "#231f20";
const WHITE = "#ffffff";

const RECT = { x: 38, y: 52, width: 104, height: 76 };
const SQUARE = { x: 52, y: 52, size: 76 };

const avatars = [
	{ id: "aurora-grid", code: "A", label: "Alfa", art: alfa },
	{ id: "coral-orbit", code: "B", label: "Bravo", art: bravo },
	{ id: "tidal-prism", code: "C", label: "Charlie", art: charlie },
	{ id: "ember-radar", code: "D", label: "Delta", art: delta },
	{ id: "jade-circuit", code: "E", label: "Echo", art: echo },
	{ id: "violet-signal", code: "F", label: "Foxtrot", art: foxtrot },
	{ id: "golden-spiral", code: "G", label: "Golf", art: golf },
	{ id: "blueprint-wave", code: "H", label: "Hotel", art: hotel },
	{ id: "rose-axis", code: "I", label: "India", art: india },
	{ id: "kelp-mosaic", code: "J", label: "Juliet", art: juliet },
	{ id: "cobalt-eclipse", code: "K", label: "Kilo", art: kilo },
	{ id: "sunset-stack", code: "L", label: "Lima", art: lima },
];

function alfa(uid) {
	const { x, y, width, height } = RECT;
	const midY = y + height / 2;
	const notchX = x + width * 0.78;
	const clip = `${uid}-flag-shape`;
	return `
		<defs>
			<clipPath id="${clip}">
				<path d="M${x} ${y}H${x + width}L${notchX} ${midY}L${x + width} ${y + height}H${x}Z"/>
			</clipPath>
		</defs>
		<g clip-path="url(#${clip})">
			<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${BLUE}"/>
			<rect x="${x}" y="${y}" width="${width * 0.46}" height="${height}" fill="${WHITE}"/>
		</g>
		<path d="M${x} ${y}H${x + width}L${notchX} ${midY}L${x + width} ${y + height}H${x}Z" fill="none" stroke="${INK}" stroke-width="2"/>
	`;
}

function bravo(uid) {
	return swallowtail(uid, RED);
}

function charlie() {
	return horizontalStripes([BLUE, WHITE, RED, WHITE, BLUE]);
}

function delta() {
	return horizontalStripes([YELLOW, BLUE, YELLOW]);
}

function echo() {
	return horizontalStripes([BLUE, RED]);
}

function foxtrot() {
	const { x, y, size } = SQUARE;
	const center = x + size / 2;
	return `
		${squareBase(WHITE)}
		<path d="M${center} ${y}L${x + size} ${center}L${center} ${y + size}L${x} ${center}Z" fill="${RED}"/>
		${squareOutline()}
	`;
}

function golf() {
	const { x, y, width, height } = RECT;
	const stripeWidth = width / 6;
	return `
		${[YELLOW, BLUE, YELLOW, BLUE, YELLOW, BLUE]
			.map((color, index) =>
				`<rect x="${x + stripeWidth * index}" y="${y}" width="${stripeWidth}" height="${height}" fill="${color}"/>`,
			)
			.join("")}
		${rectOutline()}
	`;
}

function hotel() {
	return verticalStripes([WHITE, RED]);
}

function india() {
	const { x, y, size } = SQUARE;
	const center = x + size / 2;
	return `
		${squareBase(YELLOW)}
		<circle cx="${center}" cy="${center}" r="${size * 0.28}" fill="${BLACK}"/>
		${squareOutline()}
	`;
}

function juliet() {
	return horizontalStripes([BLUE, WHITE, BLUE]);
}

function kilo() {
	return verticalStripes([YELLOW, BLUE]);
}

function lima() {
	const { x, y, size } = SQUARE;
	const half = size / 2;
	return `
		<rect x="${x}" y="${y}" width="${half}" height="${half}" fill="${YELLOW}"/>
		<rect x="${x + half}" y="${y}" width="${half}" height="${half}" fill="${BLACK}"/>
		<rect x="${x}" y="${y + half}" width="${half}" height="${half}" fill="${BLACK}"/>
		<rect x="${x + half}" y="${y + half}" width="${half}" height="${half}" fill="${YELLOW}"/>
		${squareOutline()}
	`;
}

function swallowtail(uid, fill) {
	const { x, y, width, height } = RECT;
	const midY = y + height / 2;
	const notchX = x + width * 0.78;
	return `
		<path d="M${x} ${y}H${x + width}L${notchX} ${midY}L${x + width} ${y + height}H${x}Z" fill="${fill}" stroke="${INK}" stroke-width="2"/>
	`;
}

function horizontalStripes(colors) {
	const { x, y, width, height } = RECT;
	const stripeHeight = height / colors.length;
	return `
		${colors
			.map((color, index) =>
				`<rect x="${x}" y="${y + stripeHeight * index}" width="${width}" height="${stripeHeight}" fill="${color}"/>`,
			)
			.join("")}
		${rectOutline()}
	`;
}

function verticalStripes(colors) {
	const { x, y, width, height } = RECT;
	const stripeWidth = width / colors.length;
	return `
		${colors
			.map((color, index) =>
				`<rect x="${x + stripeWidth * index}" y="${y}" width="${stripeWidth}" height="${height}" fill="${color}"/>`,
			)
			.join("")}
		${rectOutline()}
	`;
}

function squareBase(fill) {
	const { x, y, size } = SQUARE;
	return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${fill}"/>`;
}

function rectOutline() {
	const { x, y, width, height } = RECT;
	return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${INK}" stroke-width="2"/>`;
}

function squareOutline() {
	const { x, y, size } = SQUARE;
	return `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="none" stroke="${INK}" stroke-width="2"/>`;
}

function avatarCell(avatar, index) {
	const outputColumn = index % OUTPUT_COLUMNS;
	const outputRow = Math.floor(index / OUTPUT_COLUMNS);
	const x = outputColumn * CELL_SIZE;
	const y = outputRow * CELL_SIZE;
	const uid = `signal-${avatar.code.toLowerCase()}`;

	return `<g transform="translate(${x} ${y})" data-signal-code="${avatar.code}" data-signal-label="${avatar.label}">
	<circle cx="90" cy="90" r="76" fill="${WHITE}" stroke="${INK}" stroke-width="5"/>
	<circle cx="90" cy="90" r="68" fill="none" stroke="${BLUE}" stroke-width="1.5" opacity=".18"/>
	${avatar.art(uid)}
</g>`;
}

function buildSvg() {
	const width = OUTPUT_COLUMNS * CELL_SIZE;
	const height = OUTPUT_ROWS * CELL_SIZE;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${avatars.map(avatarCell).join("\n")}
</svg>
`;
}

function trimTrailingWhitespace(value) {
	return value
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n");
}

await mkdir(avatarDir, { recursive: true });

const sourceSvg = trimTrailingWhitespace(buildSvg());
await writeFile(path.join(avatarDir, "shiplet-avatar-presets-source.svg"), sourceSvg);

const png = new Resvg(sourceSvg, {
	fitTo: { mode: "width", value: OUTPUT_COLUMNS * CELL_SIZE },
	font: { loadSystemFonts: false },
}).render().asPng();
await writeFile(path.join(avatarDir, "shiplet-avatar-presets.png"), png);

const generated = `// Generated by scripts/generate-avatar-presets.mjs. Do not edit by hand.

export const AVATAR_ASSETS = {
\t"avatarPresetsPng": "${png.toString("base64")}"
} as const;
`;

await writeFile(path.join(root, "src", "generated-avatar-assets.ts"), generated);

console.log(`shiplet-avatar-presets.png ${png.length}B`);
