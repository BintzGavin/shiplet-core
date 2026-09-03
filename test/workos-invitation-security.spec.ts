import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import {
	acceptWorkOSInvitationForUser,
	sendWorkOSInvitation,
} from "../src/workos";

describe("WorkOS customized invitation acceptance", () => {
	it("refuses another address on the same corporate domain", async () => {
		const invitation = await sendWorkOSInvitation(env as unknown as Env, {
			email: "invited-person@corp.example",
			organizationId: "org_exact_email",
		});

		await expect(
			acceptWorkOSInvitationForUser(env as unknown as Env, {
				invitationId: invitation.id,
				userId: "user_other_person",
				email: "other-person@corp.example",
				organizationId: "org_exact_email",
			}),
		).rejects.toMatchObject({ status: 403 });
	});
});
