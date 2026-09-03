import { describe, expect, it } from "vitest";
import {
	reviewClientScript,
	reviewSessionRecoveryUrl,
	shouldRecoverReviewSession,
} from "../src/review-client";

describe("idle review session recovery", () => {
	it("builds the same canonical artifact URL without the bootstrap capability", () => {
		expect(
			reviewSessionRecoveryUrl(
				"https://restricted.shiplet.cc/docs/?mode=review&shiplet_preview_token=expired#summary",
			),
		).toBe("https://restricted.shiplet.cc/docs/?mode=review#summary");
	});

	it("recovers only an authenticated 401 and rate-limits navigation loops", () => {
		expect(shouldRecoverReviewSession(401, true, 0, 120_000)).toBe(true);
		expect(shouldRecoverReviewSession(403, true, 0, 120_000)).toBe(false);
		expect(shouldRecoverReviewSession(401, false, 0, 120_000)).toBe(false);
		expect(shouldRecoverReviewSession(401, true, 90_001, 120_000)).toBe(false);
	});

	it("ships the recovery decision in the browser review client", () => {
		const script = reviewClientScript();
		expect(script).toContain("shouldRecoverReviewSession(");
		expect(script).toContain("reviewSessionRecoveryUrl(location.href)");
		expect(script).toContain("location.replace(recoveryUrl)");
	});
});
