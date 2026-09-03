import { describe, expect, it } from "vitest";

import {
	placeContextualReviewFrame,
	reviewClientScript,
	reviewKeyboardIntent,
} from "../src/review-client";

describe("review widget interaction fluency", () => {
	it("Given edge and corner targets, When the contextual composer opens, Then it stays in the viewport without covering its anchor", () => {
		const viewport = { width: 390, height: 844 };
		const margin = 12;
		const gap = 14;
		const anchors = [
			{ x: 4, y: 4 },
			{ x: 386, y: 4 },
			{ x: 4, y: 840 },
			{ x: 386, y: 840 },
		];

		for (const anchor of anchors) {
			const frame = placeContextualReviewFrame(anchor, viewport, {
				preferredWidth: 344,
				preferredHeight: 190,
				margin,
				gap,
			});
			expect(frame.left).toBeGreaterThanOrEqual(margin);
			expect(frame.top).toBeGreaterThanOrEqual(margin);
			expect(frame.left + frame.width).toBeLessThanOrEqual(
				viewport.width - margin,
			);
			expect(frame.top + frame.height).toBeLessThanOrEqual(
				viewport.height - margin,
			);
			if (frame.placement === "right") {
				expect(frame.left).toBeGreaterThanOrEqual(anchor.x + gap);
			}
			if (frame.placement === "left") {
				expect(frame.left + frame.width).toBeLessThanOrEqual(anchor.x - gap);
			}
			if (frame.placement === "below") {
				expect(frame.top).toBeGreaterThanOrEqual(anchor.y + gap);
			}
			if (frame.placement === "above") {
				expect(frame.top + frame.height).toBeLessThanOrEqual(anchor.y - gap);
			}
		}
	});

	it("Given review state and keyboard focus, When a shortcut is pressed, Then only the contextually safe action runs", () => {
		expect(
			reviewKeyboardIntent(
				{ key: "Escape" },
				{ targetSelected: true },
			),
		).toBe("cancel-composer");
		expect(
			reviewKeyboardIntent({ key: "Escape" }, { capturing: true }),
		).toBe("stop-capture");
		expect(
			reviewKeyboardIntent({ key: "Escape" }, { commentListOpen: true }),
		).toBe("close-comment-list");
		expect(
			reviewKeyboardIntent({ key: "Escape" }, { panelOpen: true }),
		).toBe("close-panel");
		expect(
			reviewKeyboardIntent({ key: "Escape" }, { toolbarExpanded: true }),
		).toBe("collapse-toolbar");
		expect(
			reviewKeyboardIntent({ key: "c" }, { editableTarget: false }),
		).toBe("start-capture");
		expect(
			reviewKeyboardIntent({ key: "c" }, { editableTarget: true }),
		).toBeNull();
		expect(
			reviewKeyboardIntent(
				{ key: "Enter", metaKey: true },
				{ commentInput: true },
			),
		).toBe("submit-comment");
		expect(
			reviewKeyboardIntent({ key: "Enter" }, { replyInput: true }),
		).toBe("submit-reply");
		expect(
			reviewKeyboardIntent(
				{ key: "ArrowDown" },
				{ commentListOpen: true, editableTarget: false },
			),
		).toBe("next-thread");
		expect(
			reviewKeyboardIntent(
				{ key: "Escape", isComposing: true },
				{ targetSelected: true },
			),
		).toBeNull();
	});

	it("Given the generated browser client, When operated, Then progressive review controls expose compact observable states", () => {
		const script = reviewClientScript();

		expect(script).toContain("data-expand-launcher");
		expect(script).toContain("aria-label='Open review tools'");
		expect(script).toContain("data-collapse-launcher");
		expect(script).toContain("data-open-reply");
		expect(script).toContain("data-quick-status");
		expect(script).toContain("data-previous-comment");
		expect(script).toContain("data-next-comment");
		expect(script).toContain("data-review-context");
		expect(script).toContain("data-placement='");
		expect(script).toContain('window.addEventListener("keydown", handleReviewKeydown, true)');
		expect(script).toContain('reducedMotion ? "auto" : "smooth"');
		expect(script).toContain("@media (prefers-reduced-motion:reduce)");
		expect(script).toContain(
			".shiplet-review-inline-tool,.shiplet-review-inline-cancel,.shiplet-review-inline-submit{min-height:44px",
		);
		expect(script).toContain(
			".shiplet-review-thread-action{min-height:44px",
		);
		expect(script).toContain(
			".shiplet-review-thread-more summary{width:44px;height:44px}",
		);
		expect(() => new Function(script)).not.toThrow();
	});
});
