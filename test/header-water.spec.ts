import { describe, expect, it } from "vitest";
import { HEADER_SEAS, headerWaterFrame, type HeaderWaterLayer } from "../src/header-water";

const ALL_LAYERS = [...HEADER_SEAS.storm, ...HEADER_SEAS.calm];

function surfacePoints(surface: string) {
	return surface.split(/[ML]/).filter(Boolean).map(point => point.split(" ").map(Number));
}

/** Swell count and height across one frame: crossings of the mean level while the water rises. */
function swellProfile(layer: HeaderWaterLayer, width: number, time: number) {
	const heights = surfacePoints(headerWaterFrame(width, time, layer, width / 3).surface).map(([, y]) => y);
	let swells = 0;
	for (let index = 1; index < heights.length; index++) {
		if (heights[index - 1] >= layer.level && heights[index] < layer.level) swells++;
	}
	return { swells, height: Math.max(...heights) - Math.min(...heights) };
}

describe("compact harbor surface", () => {
	it("Given a visible waterline, When time advances, Then swells change shape rather than translating a frozen curve", () => {
		for (const layer of ALL_LAYERS) {
			const first = headerWaterFrame(1280, 0, layer, 150);
			const second = headerWaterFrame(1280, 0.8, layer, 150);
			expect(first.surface).not.toBe(second.surface);
			expect(first.heave).not.toBe(second.heave);
			expect(first.foam).not.toBe(second.foam);
		}
	});
	it("Given the night-watch near swell, When a full cycle passes, Then the water rises visibly while the vessel pitch remains believable", () => {
		const frames = Array.from({ length: 100 }, (_, index) => headerWaterFrame(1280, index / 10, HEADER_SEAS.storm[2], 150));
		const heights = frames.map(frame => frame.heave);
		expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(10);
		for (const frame of frames) expect(Math.abs(frame.pitch)).toBeLessThanOrEqual(6);
	});
	it("Given daylight, When the calm sea is sampled, Then every layer runs longer, lower swells than the storm", () => {
		for (const [index, calm] of HEADER_SEAS.calm.entries()) {
			const storm = HEADER_SEAS.storm[index];
			expect(calm.name).toBe(storm.name);
			for (const time of [0, 3, 11, 40]) {
				const calmProfile = swellProfile(calm, 1280, time);
				const stormProfile = swellProfile(storm, 1280, time);
				expect(calmProfile.swells).toBeGreaterThanOrEqual(1);
				expect(calmProfile.swells * 2).toBeLessThanOrEqual(stormProfile.swells);
				expect(calmProfile.height).toBeLessThan(stormProfile.height * 0.6);
			}
		}
	});
	it("Given the daylight near swell, When a full cycle passes, Then the vessel still rides a gentle, visible rise", () => {
		const frames = Array.from({ length: 300 }, (_, index) => headerWaterFrame(1280, index / 10, HEADER_SEAS.calm[2], 150));
		const heights = frames.map(frame => frame.heave);
		const rise = Math.max(...heights) - Math.min(...heights);
		expect(rise).toBeGreaterThan(3);
		expect(rise).toBeLessThan(10);
		// Half the night watch's pitch clamp: the ship rocks, it does not lurch.
		for (const frame of frames) expect(Math.abs(frame.pitch)).toBeLessThanOrEqual(3);
	});
	it("Given the weather turning, When the blend between seas moves in small steps, Then no point of the surface jumps", () => {
		for (const [index, calm] of HEADER_SEAS.calm.entries()) {
			const storm = HEADER_SEAS.storm[index];
			for (const time of [0, 3.7, 41]) {
				let previous = surfacePoints(headerWaterFrame(1280, time, calm, 150, storm, 0).surface);
				for (let step = 1; step <= 20; step++) {
					const current = surfacePoints(headerWaterFrame(1280, time, calm, 150, storm, step / 20).surface);
					expect(current.map(([x]) => x)).toEqual(previous.map(([x]) => x));
					expect(Math.max(...current.map(([, y], point) => Math.abs(y - previous[point][1])))).toBeLessThan(1.2);
					previous = current;
				}
			}
		}
	});
	it("Given a finished turn, When the blend rests at either end, Then it draws exactly that pure sea", () => {
		for (const [index, calm] of HEADER_SEAS.calm.entries()) {
			const storm = HEADER_SEAS.storm[index];
			for (const time of [0, 2.5, 40]) {
				expect(headerWaterFrame(1280, time, calm, 150, storm, 1)).toEqual(headerWaterFrame(1280, time, storm, 150));
				// Live frames sample at the finer step so resolution never changes mid-turn.
				expect(headerWaterFrame(1280, time, calm, 150, storm, 0)).toEqual(headerWaterFrame(1280, time, { ...calm, step: storm.step }, 150));
			}
		}
	});
	it("Given mobile through ultrawide screens, When a frame is drawn, Then every layer covers both edges with a bounded point count", () => {
		const turning = HEADER_SEAS.calm.map((calm, index) => [calm, HEADER_SEAS.storm[index], 0.5] as const);
		for (const width of [320, 390, 768, 1280, 1920, 3840, 7680]) {
			for (const [layer, toward, amount] of [...ALL_LAYERS.map(layer => [layer, layer, 0] as const), ...turning]) {
				for (const time of [0, 0.5, 2, 4, 40, 10000]) {
					const frame = headerWaterFrame(width, time, layer, width / 3, toward, amount);
					expect(frame.surface).toMatch(/^M-16 /);
					expect(frame.body).toContain(`L${width + 16} 44L-16 44Z`);
					expect(frame.surface.split("L").length).toBeLessThanOrEqual(242);
					expect(frame.surface).not.toMatch(/NaN|Infinity/);
					const heights = surfacePoints(frame.surface).map(([, y]) => y);
					expect(Math.min(...heights)).toBeGreaterThan(0);
					expect(Math.max(...heights)).toBeLessThan(40);
				}
			}
		}
	});
	it("Given a vessel on the surface, When its displacement is sampled, Then it matches the water at its exact position", () => {
		for (const layer of [HEADER_SEAS.storm[2], HEADER_SEAS.calm[2]]) {
			for (const time of [0, 0.5, 1, 10]) {
				const frame = headerWaterFrame(390, time, layer, -16);
				const waterAtVessel = Number(frame.surface.split("L")[0].split(" ")[1]);
				expect(frame.heave).toBeCloseTo(waterAtVessel - layer.level, 1);
			}
		}
	});
});
