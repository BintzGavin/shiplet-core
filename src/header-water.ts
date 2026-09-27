export interface HeaderWaterLayer {
	name: string;
	level: number;
	amplitude: number;
	wavelength: number;
	speed: number;
	phase: number;
	/** Crest steepness and crossing ripples: 1 is open-water chop, 0 a glassy swell. */
	chop: number;
	/** Sample spacing in SVG units; long, low swells stay smooth with fewer points. */
	step: number;
}

export type HeaderSeaState = "storm" | "calm";

/** The night watch keeps the choppy harbor; daylight stretches the same three
 * layers into long, low, slow swells. The theme decides which sea is drawn. */
export const HEADER_SEAS: Readonly<Record<HeaderSeaState, readonly HeaderWaterLayer[]>> = {
	storm: [
		{ name: "far", level: 12, amplitude: 3.6, wavelength: 286, speed: 1.15, phase: 0.7, chop: 1, step: 7 },
		{ name: "mid", level: 21, amplitude: 5.1, wavelength: 204, speed: 1.55, phase: 2.4, chop: 1, step: 7 },
		{ name: "near", level: 29, amplitude: 7.1, wavelength: 164, speed: 2.05, phase: 4.1, chop: 1, step: 7 },
	],
	calm: [
		{ name: "far", level: 13, amplitude: 1.5, wavelength: 700, speed: 0.36, phase: 0.7, chop: 0.3, step: 14 },
		{ name: "mid", level: 21.5, amplitude: 2.2, wavelength: 560, speed: 0.46, phase: 2.4, chop: 0.3, step: 14 },
		{ name: "near", level: 29.5, amplitude: 3.1, wavelength: 460, speed: 0.58, phase: 4.1, chop: 0.3, step: 14 },
	],
};

/** Self-contained so the same sampler draws the static SVG and browser frames.
 * Long swells, a steeper crest harmonic, and crossing ripples prevent a frozen
 * sine-wave strip. The budget stays bounded even on an ultrawide display.
 *
 * While the weather turns, `amount` (0-1) blends this layer toward the same
 * layer of another sea. Both surfaces keep moving; only their share of the
 * height shifts, so chop fades out or builds instead of snapping. */
export function headerWaterFrame(width: number, time: number, layer: HeaderWaterLayer, anchorX: number, toward: HeaderWaterLayer = layer, amount = 0) {
	// Method syntax stays self-contained in keepNames builds: no injected
	// function-name helper needs to leak into the browser script.
	const water = {
		swell(sea: HeaderWaterLayer, x: number) {
			const phase = x * Math.PI * 2 / sea.wavelength + time * sea.speed + sea.phase;
			return sea.amplitude * (
				Math.cos(phase) + sea.chop * (0.22 * Math.cos(2 * phase + 0.45) + 0.09 * Math.sin(phase * 2.7 - time * 0.8))
				+ 0.23 * Math.sin(phase * 0.61 + time * 0.47)
			);
		},
		heightAt(x: number) {
			return level - ((1 - amount) * water.swell(layer, x) + amount * water.swell(toward, x));
		},
	};
	// Weighted this way, either end of a turn reproduces its pure sea exactly.
	const level = layer.level * (1 - amount) + toward.level * amount;
	const amplitude = layer.amplitude * (1 - amount) + toward.amplitude * amount;
	const steps = Math.min(240, Math.ceil((width + 32) / Math.min(layer.step, toward.step)));
	let surface = "";
	let foam = "";
	let crestOpen = false;
	for (let index = 0; index <= steps; index++) {
		const x = -16 + (width + 32) * index / steps;
		const y = water.heightAt(x);
		const point = `${Number(x.toFixed(2))} ${y.toFixed(2)}`;
		surface += `${index ? "L" : "M"}${point}`;
		// Highlights belong to high water, breaking up along its windward face.
		const crest = y < level - amplitude * 0.5 && Math.sin(x * 0.075 - time * 1.3 + layer.phase) > -0.45;
		if (crest) foam += `${crestOpen ? "L" : "M"}${Number(x.toFixed(2))} ${(y - 0.35).toFixed(2)}`;
		crestOpen = crest;
	}
	return {
		surface,
		body: `${surface}L${width + 16} 44L-16 44Z`,
		foam: foam || "M-16 44",
		level,
		heave: water.heightAt(anchorX) - level,
		pitch: Math.max(-6, Math.min(6, Math.atan2(water.heightAt(anchorX + 12) - water.heightAt(anchorX - 12), 24) * 180 / Math.PI)),
	};
}
