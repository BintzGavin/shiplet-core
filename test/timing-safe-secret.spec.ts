import { describe, expect, it, vi } from "vitest";
import { timingSafeSecretMatches } from "../src/timing-safe-secret";

describe("timing-safe privileged secret comparison", () => {
	it("matches equal values and rejects same-length or different-length mismatches", async () => {
		await expect(
			timingSafeSecretMatches("configured-bootstrap", "configured-bootstrap"),
		).resolves.toBe(true);
		await expect(
			timingSafeSecretMatches("configured-bootstrap", "configured-bootstraq"),
		).resolves.toBe(false);
		await expect(
			timingSafeSecretMatches("configured-bootstrap", "short"),
		).resolves.toBe(false);
	});

	it("digests both operands before comparing fixed-size values", async () => {
		const digest = vi.spyOn(crypto.subtle, "digest");
		try {
			await expect(
				timingSafeSecretMatches("configured-bootstrap", "presented-bootstrap"),
			).resolves.toBe(false);
			expect(digest).toHaveBeenCalledTimes(2);
			expect(digest.mock.calls.every(([algorithm]) => algorithm === "SHA-256")).toBe(
				true,
			);
		} finally {
			digest.mockRestore();
		}
	});
});
