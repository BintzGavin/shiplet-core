import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	createInvitationConsentToken,
	verifyInvitationConsentToken,
} from "../src/auth-consent";
import type { Env } from "../src/env";

describe("invitation consent tokens", () => {
	it("binds the displayed project and exact return URL into a signed, expiring token", async () => {
		const token = await createInvitationConsentToken(env as unknown as Env, {
			projectId: "project_requested",
			invitationId: "appinv_requested",
			returnTo: "https://restricted.shiplet.cc/docs/?mode=review",
			expiresInSeconds: 60,
			nowSeconds: 1_000,
		});

		await expect(
			verifyInvitationConsentToken(env as unknown as Env, token, {
				nowSeconds: 1_030,
			}),
		).resolves.toMatchObject({
			ok: true,
			consent: {
				projectId: "project_requested",
				invitationId: "appinv_requested",
				returnTo: "https://restricted.shiplet.cc/docs/?mode=review",
			},
		});
		await expect(
			verifyInvitationConsentToken(env as unknown as Env, token, {
				nowSeconds: 1_061,
			}),
		).resolves.toEqual({ ok: false, reason: "expired" });
	});

	it("rejects a token whose payload or signature was changed", async () => {
		const token = await createInvitationConsentToken(env as unknown as Env, {
			projectId: "project_requested",
			returnTo: "https://restricted.shiplet.cc/",
		});
		const tokenParts = token.split(".");
		const signature = tokenParts[2];
		tokenParts[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
		const tampered = tokenParts.join(".");

		await expect(
			verifyInvitationConsentToken(env as unknown as Env, tampered),
		).resolves.toEqual({ ok: false, reason: "invalid_signature" });
	});
});
