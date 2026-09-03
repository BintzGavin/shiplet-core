import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
	AVATAR_PRESETS,
	AVATAR_SPRITE_COLUMNS,
	AVATAR_SPRITE_ROWS,
} from "../src/avatars";
import { AVATAR_ASSETS } from "../src/generated-avatar-assets";

const SIGNAL_AVATAR_IDS = [
	"aurora-grid",
	"coral-orbit",
	"tidal-prism",
	"ember-radar",
	"jade-circuit",
	"violet-signal",
	"golden-spiral",
	"blueprint-wave",
	"rose-axis",
	"kelp-mosaic",
	"cobalt-eclipse",
	"sunset-stack",
] as const;

const SIGNAL_FLAG_LABELS = [
	"A Alfa",
	"B Bravo",
	"C Charlie",
	"D Delta",
	"E Echo",
	"F Foxtrot",
	"G Golf",
	"H Hotel",
	"I India",
	"J Juliet",
	"K Kilo",
	"L Lima",
] as const;

const MIN_FILL_RATIO = 0.68;
const MAX_FILL_RATIO = 0.98;
const CENTER_TOLERANCE_RATIO = 0.12;
const SIGNAL_COLOR_TOLERANCE = 4;

const SIGNAL_BLUE = "#003a78";
const SIGNAL_RED = "#c8102e";
const SIGNAL_YELLOW = "#f6c343";
const SIGNAL_BLACK = "#231f20";
const SIGNAL_WHITE = "#ffffff";

const SIGNAL_FLAG_SAMPLES = [
	{ index: 0, x: 0.35, y: 0.5, color: SIGNAL_WHITE, label: "A hoist is white" },
	{ index: 0, x: 0.63, y: 0.5, color: SIGNAL_BLUE, label: "A fly is blue" },
	{ index: 1, x: 0.5, y: 0.5, color: SIGNAL_RED, label: "B is red" },
	{ index: 2, x: 0.5, y: 0.34, color: SIGNAL_BLUE, label: "C top stripe is blue" },
	{ index: 2, x: 0.5, y: 0.5, color: SIGNAL_RED, label: "C center stripe is red" },
	{ index: 3, x: 0.5, y: 0.34, color: SIGNAL_YELLOW, label: "D top stripe is yellow" },
	{ index: 3, x: 0.5, y: 0.5, color: SIGNAL_BLUE, label: "D center stripe is blue" },
	{ index: 4, x: 0.5, y: 0.32, color: SIGNAL_BLUE, label: "E top half is blue" },
	{ index: 4, x: 0.5, y: 0.68, color: SIGNAL_RED, label: "E bottom half is red" },
	{ index: 5, x: 0.5, y: 0.5, color: SIGNAL_RED, label: "F diamond center is red" },
	{ index: 5, x: 0.34, y: 0.34, color: SIGNAL_WHITE, label: "F field is white" },
	{ index: 6, x: 0.25, y: 0.5, color: SIGNAL_YELLOW, label: "G starts yellow" },
	{ index: 6, x: 0.35, y: 0.5, color: SIGNAL_BLUE, label: "G alternates blue" },
	{ index: 7, x: 0.35, y: 0.5, color: SIGNAL_WHITE, label: "H hoist is white" },
	{ index: 7, x: 0.65, y: 0.5, color: SIGNAL_RED, label: "H fly is red" },
	{ index: 8, x: 0.5, y: 0.5, color: SIGNAL_BLACK, label: "I disc is black" },
	{ index: 8, x: 0.36, y: 0.36, color: SIGNAL_YELLOW, label: "I field is yellow" },
	{ index: 9, x: 0.5, y: 0.34, color: SIGNAL_BLUE, label: "J top stripe is blue" },
	{ index: 9, x: 0.5, y: 0.5, color: SIGNAL_WHITE, label: "J center stripe is white" },
	{ index: 10, x: 0.35, y: 0.5, color: SIGNAL_YELLOW, label: "K hoist is yellow" },
	{ index: 10, x: 0.65, y: 0.5, color: SIGNAL_BLUE, label: "K fly is blue" },
	{ index: 11, x: 0.32, y: 0.32, color: SIGNAL_YELLOW, label: "L upper hoist is yellow" },
	{ index: 11, x: 0.68, y: 0.32, color: SIGNAL_BLACK, label: "L upper fly is black" },
] as const;

describe("avatar sprite assets", () => {
	it("exposes twelve signal flag avatar presets in a complete 4x3 sprite", () => {
		expect(AVATAR_SPRITE_COLUMNS).toBe(4);
		expect(AVATAR_SPRITE_ROWS).toBe(3);
		expect(AVATAR_PRESETS.map((preset) => preset.id)).toEqual(
			SIGNAL_AVATAR_IDS,
		);
		expect(AVATAR_PRESETS.map((preset) => preset.label)).toEqual(
			SIGNAL_FLAG_LABELS,
		);
		expect(AVATAR_PRESETS).toHaveLength(
			AVATAR_SPRITE_COLUMNS * AVATAR_SPRITE_ROWS,
		);
	});

	it("renders recognizable International Code of Signals flags A through L", () => {
		const sprite = decodePng(Buffer.from(AVATAR_ASSETS.avatarPresetsPng, "base64"));
		const cellWidth = sprite.width / AVATAR_SPRITE_COLUMNS;
		const cellHeight = sprite.height / AVATAR_SPRITE_ROWS;

		for (const sample of SIGNAL_FLAG_SAMPLES) {
			const preset = AVATAR_PRESETS[sample.index];
			const red = sampledColor(sprite, {
				x: preset.column * cellWidth + Math.floor(cellWidth * sample.x),
				y: preset.row * cellHeight + Math.floor(cellHeight * sample.y),
			});
			expectColorClose(red, sample.color, sample.label);
		}
	});

	it("frames signal flag badges tightly and centrally in sprite cells", () => {
		const sprite = decodePng(Buffer.from(AVATAR_ASSETS.avatarPresetsPng, "base64"));
		const cellWidth = sprite.width / AVATAR_SPRITE_COLUMNS;
		const cellHeight = sprite.height / AVATAR_SPRITE_ROWS;

		expect(Number.isInteger(cellWidth)).toBe(true);
		expect(Number.isInteger(cellHeight)).toBe(true);
		expect(AVATAR_PRESETS).toHaveLength(
			AVATAR_SPRITE_COLUMNS * AVATAR_SPRITE_ROWS,
		);

		for (const preset of AVATAR_PRESETS) {
			const bounds = foregroundBounds(sprite, {
				x: preset.column * cellWidth,
				y: preset.row * cellHeight,
				width: cellWidth,
				height: cellHeight,
			});
			const maxDimension = Math.max(bounds.width, bounds.height);
			const centerX = bounds.x + bounds.width / 2 - preset.column * cellWidth;
			const centerY = bounds.y + bounds.height / 2 - preset.row * cellHeight;

			expect(maxDimension, `${preset.id} should fill its avatar cell`).toBeGreaterThanOrEqual(
				Math.round(cellWidth * MIN_FILL_RATIO),
			);
			expect(maxDimension, `${preset.id} should keep breathing room`).toBeLessThanOrEqual(
				Math.round(cellWidth * MAX_FILL_RATIO),
			);
			expect(
				Math.abs(centerX - cellWidth / 2),
				`${preset.id} should be horizontally centered`,
			).toBeLessThanOrEqual(Math.round(cellWidth * CENTER_TOLERANCE_RATIO));
			expect(
				Math.abs(centerY - cellHeight / 2),
				`${preset.id} should be vertically centered`,
			).toBeLessThanOrEqual(Math.round(cellHeight * CENTER_TOLERANCE_RATIO));
		}
	});
});

function decodePng(buffer: Buffer) {
	if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
		throw new Error("Expected a PNG image.");
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idatChunks: Buffer[] = [];

	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
		} else if (type === "IDAT") {
			idatChunks.push(Buffer.from(data));
		} else if (type === "IEND") {
			break;
		}
		offset += length + 12;
	}

	if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
		throw new Error(`Unsupported PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
	}

	const bytesPerPixel = colorType === 6 ? 4 : 3;
	const stride = width * bytesPerPixel;
	const raw = inflateSync(Buffer.concat(idatChunks));
	const pixels = Buffer.alloc(width * height * bytesPerPixel);
	let rawOffset = 0;
	let pixelOffset = 0;
	let previousRow = Buffer.alloc(stride);

	for (let y = 0; y < height; y += 1) {
		const filter = raw[rawOffset];
		rawOffset += 1;
		const row = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
		rawOffset += stride;

		for (let x = 0; x < stride; x += 1) {
			const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
			const up = previousRow[x] || 0;
			const upLeft = x >= bytesPerPixel ? previousRow[x - bytesPerPixel] || 0 : 0;
			if (filter === 1) {
				row[x] = (row[x] + left) & 255;
			} else if (filter === 2) {
				row[x] = (row[x] + up) & 255;
			} else if (filter === 3) {
				row[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
			} else if (filter === 4) {
				row[x] = (row[x] + paethPredictor(left, up, upLeft)) & 255;
			} else if (filter !== 0) {
				throw new Error(`Unsupported PNG filter: ${filter}`);
			}
		}

		row.copy(pixels, pixelOffset);
		pixelOffset += stride;
		previousRow = row;
	}

	return { width, height, bytesPerPixel, pixels };
}

function foregroundBounds(
	sprite: ReturnType<typeof decodePng>,
	cell: { x: number; y: number; width: number; height: number },
) {
	let minX = cell.x + cell.width;
	let minY = cell.y + cell.height;
	let maxX = cell.x - 1;
	let maxY = cell.y - 1;

	for (let y = cell.y; y < cell.y + cell.height; y += 1) {
		for (let x = cell.x; x < cell.x + cell.width; x += 1) {
			if (isForegroundPixel(sprite, x, y)) {
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}

	if (maxX < minX || maxY < minY) {
		throw new Error("Avatar cell has no visible artwork.");
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX + 1,
		height: maxY - minY + 1,
	};
}

function isForegroundPixel(
	sprite: ReturnType<typeof decodePng>,
	x: number,
	y: number,
) {
	const index = (y * sprite.width + x) * sprite.bytesPerPixel;
	const red = sprite.pixels[index];
	const green = sprite.pixels[index + 1];
	const blue = sprite.pixels[index + 2];
	const alpha = sprite.bytesPerPixel === 4 ? sprite.pixels[index + 3] : 255;
	return alpha > 8 && (red < 245 || green < 245 || blue < 245);
}

function sampledColor(
	sprite: ReturnType<typeof decodePng>,
	point: { x: number; y: number },
) {
	const index = (point.y * sprite.width + point.x) * sprite.bytesPerPixel;
	return {
		red: sprite.pixels[index],
		green: sprite.pixels[index + 1],
		blue: sprite.pixels[index + 2],
	};
}

function expectColorClose(
	actual: { red: number; green: number; blue: number },
	expectedHex: string,
	message: string,
) {
	const normalized = expectedHex.replace("#", "");
	const expected = {
		red: Number.parseInt(normalized.slice(0, 2), 16),
		green: Number.parseInt(normalized.slice(2, 4), 16),
		blue: Number.parseInt(normalized.slice(4, 6), 16),
	};
	expect(Math.abs(actual.red - expected.red), message).toBeLessThanOrEqual(
		SIGNAL_COLOR_TOLERANCE,
	);
	expect(Math.abs(actual.green - expected.green), message).toBeLessThanOrEqual(
		SIGNAL_COLOR_TOLERANCE,
	);
	expect(Math.abs(actual.blue - expected.blue), message).toBeLessThanOrEqual(
		SIGNAL_COLOR_TOLERANCE,
	);
}

function paethPredictor(left: number, up: number, upLeft: number) {
	const estimate = left + up - upLeft;
	const leftDistance = Math.abs(estimate - left);
	const upDistance = Math.abs(estimate - up);
	const upLeftDistance = Math.abs(estimate - upLeft);
	if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
	return upDistance <= upLeftDistance ? up : upLeft;
}
