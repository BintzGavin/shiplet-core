import { describe, expect, it } from "vitest";
import { HEADER_WATER_LAYERS, headerWaterFrame } from "../src/header-water";

describe("compact harbor surface", () => {
	it("Given a visible waterline, When time advances, Then swells change shape rather than translating a frozen curve", () => {
		for (const layer of HEADER_WATER_LAYERS) {
			const first = headerWaterFrame(1280, 0, layer, 150);
			const second = headerWaterFrame(1280, 0.8, layer, 150);
			expect(first.surface).not.toBe(second.surface);
			expect(first.heave).not.toBe(second.heave);
			expect(first.foam).not.toBe(second.foam);
		}
	});
	it("Given the near swell, When a full cycle passes, Then the water rises visibly while the vessel pitch remains believable", () => {
		const frames = Array.from({ length: 100 }, (_, index) => headerWaterFrame(1280, index / 10, HEADER_WATER_LAYERS[2], 150));
		const heights = frames.map(frame => frame.heave);
		expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(10);
		for (const frame of frames) expect(Math.abs(frame.pitch)).toBeLessThanOrEqual(6);
	});
	it("Given mobile through ultrawide screens, When a frame is drawn, Then every layer covers both edges with a bounded point count", () => {
		for (const width of [320, 390, 768, 1280, 1920, 3840, 7680]) {
			for (const layer of HEADER_WATER_LAYERS) {
				for (const time of [0, 0.5, 2, 4, 40, 10000]) {
					const frame = headerWaterFrame(width, time, layer, width / 3);
					expect(frame.surface).toMatch(/^M-16 /);
					expect(frame.body).toContain(`L${width + 16} 44L-16 44Z`);
					expect(frame.surface.split("L").length).toBeLessThanOrEqual(242);
					expect(frame.surface).not.toMatch(/NaN|Infinity/);
					const heights = frame.surface.split(/[ML]/).filter(Boolean).map(point => Number(point.split(" ")[1]));
					expect(Math.min(...heights)).toBeGreaterThan(0);
					expect(Math.max(...heights)).toBeLessThan(40);
				}
			}
		}
	});
	it("Given a vessel on the surface, When its displacement is sampled, Then it matches the water at its exact position", () => {
		const layer = HEADER_WATER_LAYERS[2];
		for (const time of [0, 0.5, 1, 10]) {
			const frame = headerWaterFrame(390, time, layer, -16);
			const waterAtVessel = Number(frame.surface.split("L")[0].split(" ")[1]);
			expect(frame.heave).toBeCloseTo(waterAtVessel - layer.level, 1);
		}
	});
});
