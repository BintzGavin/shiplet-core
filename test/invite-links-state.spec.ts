import { describe, expect, it } from "vitest";

import {
	buildCreateRequest,
	createInviteLinksStore,
	describeAudience,
	describeExpiry,
	describeUses,
	destinationLabel,
	formatDateLabel,
	parseAllowedEmailsInput,
	sortInviteLinks,
	statusStamp,
	type InviteLinkDraft,
} from "../src/platform/invite-links-state";
import type { InviteLinkView } from "../src/platform/invite-links-types";
import { normalizeAllowedEmails } from "../src/organization-invite-links";

function makeLink(overrides: Partial<InviteLinkView> = {}): InviteLinkView {
	return {
		id: "invl_one",
		organization_id: "org_one",
		team_id: null,
		team_name: null,
		url: "https://shiplet.cc/join/token-one",
		max_uses: null,
		use_count: 0,
		allowed_emails: [],
		expires_on: null,
		created_by: { id: "user_one", email: "owner@acme.co" },
		created_on: "2026-09-01T10:00:00.000Z",
		revoked_on: null,
		status: "active",
		redemptions: [],
		...overrides,
	};
}

function makeDraft(overrides: Partial<InviteLinkDraft> = {}): InviteLinkDraft {
	return {
		destination: "organization",
		usesPreset: "unlimited",
		customUses: "",
		expiresPreset: "30",
		allowedEmailsText: "",
		...overrides,
	};
}

describe("invite link descriptions", () => {
	it("describes use counts for unlimited and capped links", () => {
		expect(describeUses(makeLink({ max_uses: null, use_count: 0 }))).toBe(
			"Unlimited uses",
		);
		expect(describeUses(makeLink({ max_uses: null, use_count: 1 }))).toBe(
			"Used once",
		);
		expect(describeUses(makeLink({ max_uses: null, use_count: 3 }))).toBe(
			"Used 3 times",
		);
		expect(describeUses(makeLink({ max_uses: 10, use_count: 3 }))).toBe(
			"3 of 10 used",
		);
		expect(describeUses(makeLink({ max_uses: 1, use_count: 0 }))).toBe(
			"0 of 1 used",
		);
	});

	it("describes an open link and a link reserved for several emails by how many", () => {
		expect(describeAudience(makeLink({ allowed_emails: [] }))).toBe(
			"Anyone with the link",
		);
		expect(
			describeAudience(
				makeLink({ allowed_emails: ["a@b.co", "c@d.co", "e@f.co"] }),
			),
		).toBe("Reserved for 3 emails");
	});

	it("describes a link reserved for one email by that address", () => {
		expect(describeAudience(makeLink({ allowed_emails: ["a@b.co"] }))).toBe(
			"Reserved for a@b.co",
		);
	});

	it("uses the past tense for expiry only when the server marks the link expired", () => {
		expect(describeExpiry(makeLink({ expires_on: null }))).toBe(
			"Never expires",
		);
		expect(
			describeExpiry(
				makeLink({ expires_on: "2026-09-30T12:00:00.000Z", status: "active" }),
			),
		).toBe("Expires Sep 30, 2026");
		expect(
			describeExpiry(
				makeLink({ expires_on: "2026-09-30T12:00:00.000Z", status: "expired" }),
			),
		).toBe("Expired Sep 30, 2026");
		// A long-past date on a link the server still calls active keeps the
		// future tense: rendering never compares against the local clock.
		expect(
			describeExpiry(
				makeLink({ expires_on: "2001-01-02T00:00:00.000Z", status: "active" }),
			),
		).toBe("Expires Jan 2, 2001");
	});

	it("formats dates as the UTC calendar day so server and browser agree", () => {
		expect(formatDateLabel("2026-09-30T12:00:00.000Z")).toBe("Sep 30, 2026");
		expect(formatDateLabel("2026-09-30T23:30:00-05:00")).toBe("Oct 1, 2026");
		// Timestamps without a zone are read as UTC instead of local time.
		expect(formatDateLabel("2026-09-30 23:30:00")).toBe("Sep 30, 2026");
		expect(formatDateLabel("2026-09-30T23:30:00")).toBe("Sep 30, 2026");
		expect(formatDateLabel("not a date")).toBe("Unknown date");
	});

	it("labels the destination by team name and falls back to the organization", () => {
		expect(
			destinationLabel(makeLink({ team_id: "team_one", team_name: "Design" })),
		).toBe("Design");
		expect(destinationLabel(makeLink({ team_id: null, team_name: null }))).toBe(
			"Organization",
		);
	});

	it("stamps every status with readable text and a tone", () => {
		expect(statusStamp(makeLink({ status: "active" }))).toEqual({
			label: "Active",
			tone: "active",
		});
		expect(statusStamp(makeLink({ status: "exhausted" }))).toEqual({
			label: "Used up",
			tone: "pending",
		});
		expect(statusStamp(makeLink({ status: "revoked" }))).toEqual({
			label: "Revoked",
			tone: "muted",
		});
		expect(statusStamp(makeLink({ status: "expired" }))).toEqual({
			label: "Expired",
			tone: "muted",
		});
	});

	it("lists active links first and the newest first within each group", () => {
		const oldActive = makeLink({
			id: "old_active",
			created_on: "2026-08-01T00:00:00.000Z",
		});
		const newActive = makeLink({
			id: "new_active",
			created_on: "2026-09-10T00:00:00.000Z",
		});
		const newestRevoked = makeLink({
			id: "newest_revoked",
			status: "revoked",
			created_on: "2026-09-20T00:00:00.000Z",
		});
		const oldExpired = makeLink({
			id: "old_expired",
			status: "expired",
			created_on: "2026-07-01T00:00:00.000Z",
		});
		const input = [oldExpired, oldActive, newestRevoked, newActive];

		expect(sortInviteLinks(input).map((link) => link.id)).toEqual([
			"new_active",
			"old_active",
			"newest_revoked",
			"old_expired",
		]);
		expect(input.map((link) => link.id)).toEqual([
			"old_expired",
			"old_active",
			"newest_revoked",
			"new_active",
		]);
	});
});

describe("invite link draft parsing", () => {
	it("splits allowed emails on commas, spaces and new lines, lowercased and deduplicated", () => {
		expect(
			parseAllowedEmailsInput(
				" Ada@Example.com, grace@example.com\nADA@example.com\t\n\nlin@example.org ,",
			),
		).toEqual({
			emails: ["ada@example.com", "grace@example.com", "lin@example.org"],
			invalid: [],
		});
		expect(parseAllowedEmailsInput("   \n ")).toEqual({
			emails: [],
			invalid: [],
		});
	});

	it("reports entries that do not look like email addresses", () => {
		expect(
			parseAllowedEmailsInput("ok@example.com, bob@, @example.com, jo@example"),
		).toEqual({
			emails: ["ok@example.com"],
			invalid: ["bob@", "@example.com", "jo@example"],
		});
	});

	it("builds an unlimited never-expiring organization-wide request and a limited team request", () => {
		expect(buildCreateRequest(makeDraft({ expiresPreset: "never" }))).toEqual({
			request: {
				teamId: null,
				maxUses: null,
				allowedEmails: [],
				expiresInDays: null,
			},
		});
		expect(
			buildCreateRequest(
				makeDraft({
					destination: "team_design",
					usesPreset: "5",
					expiresPreset: "30",
					allowedEmailsText: "Ada@Example.com\ngrace@example.com",
				}),
			),
		).toEqual({
			request: {
				teamId: "team_design",
				maxUses: 5,
				allowedEmails: ["ada@example.com", "grace@example.com"],
				expiresInDays: 30,
			},
		});
	});

	it("accepts a custom whole number of uses up to the limit and rejects anything else", () => {
		expect(
			buildCreateRequest(makeDraft({ usesPreset: "custom", customUses: " 10000 " })),
		).toMatchObject({ request: { maxUses: 10_000 } });
		expect(
			buildCreateRequest(makeDraft({ usesPreset: "custom", customUses: "1" })),
		).toMatchObject({ request: { maxUses: 1 } });

		for (const customUses of ["", "0", "10001", "2.5", "-3", "1e3", "ten"]) {
			expect(
				buildCreateRequest(makeDraft({ usesPreset: "custom", customUses })),
			).toEqual({
				error: "Enter a whole number of uses between 1 and 10,000.",
			});
		}
	});

	it("creates a link that expires in 30 days unless the administrator picks another expiry", () => {
		const defaultDraft = createInviteLinksStore().getState().draft;

		expect(buildCreateRequest(defaultDraft)).toEqual({
			request: {
				teamId: null,
				maxUses: null,
				allowedEmails: [],
				expiresInDays: 30,
			},
		});
		expect(
			buildCreateRequest({ ...defaultDraft, expiresPreset: "never" }),
		).toMatchObject({ request: { expiresInDays: null } });
	});

	it("reports an address the server would refuse, such as one with a non-ASCII local part", () => {
		const address = "jos\u00e9@example.com";
		expect(() => normalizeAllowedEmails([address])).toThrow();

		expect(parseAllowedEmailsInput(`${address}, ok@example.com`)).toEqual({
			emails: ["ok@example.com"],
			invalid: [address],
		});
		expect(
			buildCreateRequest(makeDraft({ allowedEmailsText: address })),
		).toEqual({ error: `Check these addresses: ${address}` });
	});

	it("names the addresses to check when reserved emails are invalid", () => {
		expect(
			buildCreateRequest(
				makeDraft({ allowedEmailsText: "ok@example.com, bob@, jo@example" }),
			),
		).toEqual({ error: "Check these addresses: bob@, jo@example" });
	});

	it("refuses to reserve a link for more than 50 email addresses", () => {
		const emails = (count: number) =>
			Array.from({ length: count }, (_, index) => `person${index}@example.com`).join(
				"\n",
			);

		expect(
			buildCreateRequest(makeDraft({ allowedEmailsText: emails(51) })),
		).toEqual({ error: "Reserve a link for up to 50 email addresses." });
		expect(
			buildCreateRequest(makeDraft({ allowedEmailsText: emails(50) })),
		).toMatchObject({ request: { allowedEmails: expect.any(Array) } });
	});
});

describe("invite links store", () => {
	it("starts with an organization-wide unlimited draft that expires in 30 days and restores it after edits", () => {
		const store = createInviteLinksStore({ selectedOrganizationId: "org_one" });

		expect(store.getState()).toMatchObject({
			selectedOrganizationId: "org_one",
			draft: makeDraft(),
			copiedLinkId: null,
			confirmingRevokeLinkId: null,
			formError: null,
		});

		store.getState().setDraft({ usesPreset: "custom", customUses: "12" });
		store.getState().setDraft({ allowedEmailsText: "a@b.co" });

		expect(store.getState().draft).toEqual(
			makeDraft({
				usesPreset: "custom",
				customUses: "12",
				allowedEmailsText: "a@b.co",
			}),
		);

		store.getState().resetDraft();

		expect(store.getState().draft).toEqual(makeDraft());
	});

	it("tracks the selected organization, copied link, revoke confirmation and form error", () => {
		const store = createInviteLinksStore({});

		expect(store.getState().selectedOrganizationId).toBe("");

		store.getState().setSelectedOrganizationId("org_two");
		store.getState().setCopiedLinkId("invl_one");
		store.getState().setConfirmingRevokeLinkId("invl_two");
		store.getState().setFormError("Check these addresses: bob@");

		expect(store.getState()).toMatchObject({
			selectedOrganizationId: "org_two",
			copiedLinkId: "invl_one",
			confirmingRevokeLinkId: "invl_two",
			formError: "Check these addresses: bob@",
		});

		store.getState().setCopiedLinkId(null);
		store.getState().setConfirmingRevokeLinkId(null);
		store.getState().setFormError(null);

		expect(store.getState()).toMatchObject({
			copiedLinkId: null,
			confirmingRevokeLinkId: null,
			formError: null,
		});
	});
});
