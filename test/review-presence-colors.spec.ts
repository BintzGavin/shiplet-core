import { describe, expect, it } from "vitest";

import { PRESENCE_COLORS, assignPresenceColor } from "../src/review-presence";

describe("review presence colors", () => {
	it("Given reviewers joining one after another, When colors are assigned, Then each live reviewer gets a distinct palette color", () => {
		const roster: Array<{ id: string; color: string }> = [];
		for (let index = 0; index < PRESENCE_COLORS.length; index += 1) {
			const id = `viewer_${index}`;
			const color = assignPresenceColor(id, roster);
			expect(roster.map((viewer) => viewer.color)).not.toContain(color);
			roster.push({ id, color });
		}
		expect(new Set(roster.map((viewer) => viewer.color)).size).toBe(PRESENCE_COLORS.length);
	});

	it("Given a reviewer with a second tab or reconnect, When a color is assigned, Then it keeps the color it already has", () => {
		const roster = [
			{ id: "viewer_a", color: PRESENCE_COLORS[2] },
			{ id: "viewer_b", color: PRESENCE_COLORS[0] },
		];
		expect(assignPresenceColor("viewer_a", roster)).toBe(PRESENCE_COLORS[2]);
	});

	it("Given more reviewers than palette colors, When a color is assigned, Then the least used color is reused instead of failing", () => {
		const roster = PRESENCE_COLORS.map((color, index) => ({ id: `viewer_${index}`, color }));
		roster.push({ id: "viewer_extra", color: PRESENCE_COLORS[0] });
		expect(assignPresenceColor("viewer_new", roster)).toBe(PRESENCE_COLORS[1]);
	});

	it("Given a hostile roster color outside the palette, When a color is assigned, Then a palette color is still chosen", () => {
		expect(assignPresenceColor("viewer_a", [{ id: "viewer_a", color: "#000000" }])).toBe(PRESENCE_COLORS[0]);
	});
});
