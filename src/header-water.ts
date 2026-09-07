export interface HeaderWaterLayer {
	name: string;
	level: number;
	amplitude: number;
	wavelength: number;
	speed: number;
	phase: number;
}

export const HEADER_WATER_LAYERS: readonly HeaderWaterLayer[] = [
	{ name: "far", level: 12, amplitude: 3.6, wavelength: 286, speed: 1.15, phase: 0.7 },
	{ name: "mid", level: 21, amplitude: 5.1, wavelength: 204, speed: 1.55, phase: 2.4 },
	{ name: "near", level: 29, amplitude: 7.1, wavelength: 164, speed: 2.05, phase: 4.1 },
];

/** Self-contained so the same sampler draws the static SVG and browser frames.
 * Long swells, a steeper crest harmonic, and crossing ripples prevent a frozen
 * sine-wave strip. The budget stays bounded even on an ultrawide display. */
export function headerWaterFrame(width: number, time: number, layer: HeaderWaterLayer, anchorX: number) {
	// Method syntax stays self-contained in keepNames builds: no injected
	// function-name helper needs to leak into the browser script.
	const water = { heightAt(x: number) {
		const phase = x * Math.PI * 2 / layer.wavelength + time * layer.speed + layer.phase;
		return layer.level - layer.amplitude * (
			Math.cos(phase) + 0.22 * Math.cos(2 * phase + 0.45)
			+ 0.23 * Math.sin(phase * 0.61 + time * 0.47)
			+ 0.09 * Math.sin(phase * 2.7 - time * 0.8)
		);
	} };
	const steps = Math.min(240, Math.ceil((width + 32) / 7));
	let surface = "";
	let foam = "";
	let crestOpen = false;
	for (let index = 0; index <= steps; index++) {
		const x = -16 + (width + 32) * index / steps;
		const y = water.heightAt(x);
		const point = `${Number(x.toFixed(2))} ${y.toFixed(2)}`;
		surface += `${index ? "L" : "M"}${point}`;
		// Highlights belong to high water, breaking up along its windward face.
		const crest = y < layer.level - layer.amplitude * 0.5 && Math.sin(x * 0.075 - time * 1.3 + layer.phase) > -0.45;
		if (crest) foam += `${crestOpen ? "L" : "M"}${Number(x.toFixed(2))} ${(y - 0.35).toFixed(2)}`;
		crestOpen = crest;
	}
	return {
		surface,
		body: `${surface}L${width + 16} 44L-16 44Z`,
		foam: foam || "M-16 44",
		heave: water.heightAt(anchorX) - layer.level,
		pitch: Math.max(-6, Math.min(6, Math.atan2(water.heightAt(anchorX + 12) - water.heightAt(anchorX - 12), 24) * 180 / Math.PI)),
	};
}
