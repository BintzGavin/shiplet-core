import { createStore, type StoreApi } from "zustand/vanilla";

import {
	INVITE_LINK_MAX_ALLOWED_EMAILS,
	INVITE_LINK_MAX_USES_LIMIT,
	type CreateInviteLinkRequest,
	type InviteLinkView,
} from "./invite-links-types";

export type InviteLinkUsesPreset =
	| "unlimited"
	| "1"
	| "5"
	| "10"
	| "25"
	| "custom";

export type InviteLinkExpiresPreset = "never" | "7" | "30" | "90";

export type InviteLinkDraft = {
	/** `"organization"` for an organization-wide link, otherwise a team id. */
	destination: string;
	usesPreset: InviteLinkUsesPreset;
	customUses: string;
	expiresPreset: InviteLinkExpiresPreset;
	allowedEmailsText: string;
};

export type InviteLinksState = {
	selectedOrganizationId: string;
	draft: InviteLinkDraft;
	copiedLinkId: string | null;
	confirmingRevokeLinkId: string | null;
	formError: string | null;
	setSelectedOrganizationId: (organizationId: string) => void;
	setDraft: (draft: Partial<InviteLinkDraft>) => void;
	resetDraft: () => void;
	setCopiedLinkId: (linkId: string | null) => void;
	setConfirmingRevokeLinkId: (linkId: string | null) => void;
	setFormError: (formError: string | null) => void;
};

export type InviteLinksStore = StoreApi<InviteLinksState>;

export type InviteLinksStoreInitialState = Partial<
	Pick<
		InviteLinksState,
		| "selectedOrganizationId"
		| "copiedLinkId"
		| "confirmingRevokeLinkId"
		| "formError"
	>
> & {
	draft?: Partial<InviteLinkDraft>;
};

export type InviteLinkStamp = {
	label: "Active" | "Revoked" | "Expired" | "Used up";
	tone: "active" | "muted" | "pending";
};

export type InviteLinkCreateResult =
	| { request: CreateInviteLinkRequest }
	| { error: string };

// Mirrors EMAIL_PATTERN in src/organization-invite-links.ts so the client
// never accepts an address the server's pattern rejects. Tested against
// lowercased input, like the server.
const EMAIL_PATTERN =
	/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ZONELESS_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export function createInviteLinksStore(
	initialState: InviteLinksStoreInitialState = {},
) {
	return createStore<InviteLinksState>((set) => ({
		selectedOrganizationId: initialState.selectedOrganizationId || "",
		draft: { ...defaultInviteLinkDraft(), ...initialState.draft },
		copiedLinkId: initialState.copiedLinkId ?? null,
		confirmingRevokeLinkId: initialState.confirmingRevokeLinkId ?? null,
		formError: initialState.formError ?? null,
		setSelectedOrganizationId: (selectedOrganizationId) =>
			set({ selectedOrganizationId }),
		setDraft: (draft) =>
			set((state) => ({ draft: { ...state.draft, ...draft } })),
		resetDraft: () => set({ draft: defaultInviteLinkDraft() }),
		setCopiedLinkId: (copiedLinkId) => set({ copiedLinkId }),
		setConfirmingRevokeLinkId: (confirmingRevokeLinkId) =>
			set({ confirmingRevokeLinkId }),
		setFormError: (formError) => set({ formError }),
	}));
}

export function describeUses(
	link: Pick<InviteLinkView, "max_uses" | "use_count">,
) {
	const useCount = link.use_count || 0;
	if (link.max_uses == null) {
		if (useCount <= 0) return "Unlimited uses";
		if (useCount === 1) return "Used once";
		return `Used ${formatCount(useCount)} times`;
	}
	return `${formatCount(useCount)} of ${formatCount(link.max_uses)} used`;
}

export function describeAudience(link: Pick<InviteLinkView, "allowed_emails">) {
	const emails = link.allowed_emails || [];
	if (emails.length === 0) return "Anyone with the link";
	if (emails.length === 1) return `Reserved for ${emails[0]}`;
	return `Reserved for ${formatCount(emails.length)} emails`;
}

/**
 * Expiry wording comes from the server-provided status, never from the local
 * clock, so the server render and the hydrated client always agree.
 */
export function describeExpiry(
	link: Pick<InviteLinkView, "expires_on" | "status">,
) {
	if (!link.expires_on) return "Never expires";
	const label = formatDateLabel(link.expires_on);
	return link.status === "expired" ? `Expired ${label}` : `Expires ${label}`;
}

let dateLabelFormatter: Intl.DateTimeFormat | null = null;

export function formatDateLabel(iso: string | null | undefined) {
	const time = parseTimestamp(iso);
	if (time === null) return "Unknown date";
	dateLabelFormatter ??= new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
	return dateLabelFormatter.format(time);
}

export function parseAllowedEmailsInput(text: string) {
	const emails: string[] = [];
	const invalid: string[] = [];
	const seen = new Set<string>();
	for (const entry of (text || "").split(/[\s,]+/)) {
		const value = entry.trim().toLowerCase();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		if (EMAIL_PATTERN.test(value)) {
			emails.push(value);
		} else {
			invalid.push(value);
		}
	}
	return { emails, invalid };
}

export function buildCreateRequest(
	draft: InviteLinkDraft,
): InviteLinkCreateResult {
	let maxUses: number | null = null;
	if (draft.usesPreset === "custom") {
		const customUses = draft.customUses.trim();
		const parsed = /^\d+$/.test(customUses) ? Number(customUses) : Number.NaN;
		if (
			!Number.isSafeInteger(parsed) ||
			parsed < 1 ||
			parsed > INVITE_LINK_MAX_USES_LIMIT
		) {
			return {
				error: `Enter a whole number of uses between 1 and ${formatCount(INVITE_LINK_MAX_USES_LIMIT)}.`,
			};
		}
		maxUses = parsed;
	} else if (draft.usesPreset !== "unlimited") {
		maxUses = Number(draft.usesPreset);
	}

	const { emails, invalid } = parseAllowedEmailsInput(draft.allowedEmailsText);
	if (invalid.length) {
		return { error: `Check these addresses: ${invalid.join(", ")}` };
	}
	if (emails.length > INVITE_LINK_MAX_ALLOWED_EMAILS) {
		return {
			error: `Reserve a link for up to ${INVITE_LINK_MAX_ALLOWED_EMAILS} email addresses.`,
		};
	}

	return {
		request: {
			teamId:
				!draft.destination || draft.destination === "organization"
					? null
					: draft.destination,
			maxUses,
			allowedEmails: emails,
			expiresInDays:
				draft.expiresPreset === "never" ? null : Number(draft.expiresPreset),
		},
	};
}

export function destinationLabel(link: Pick<InviteLinkView, "team_name">) {
	return link.team_name || "Organization";
}

export function statusStamp(link: Pick<InviteLinkView, "status">): InviteLinkStamp {
	switch (link.status) {
		case "active":
			return { label: "Active", tone: "active" };
		case "exhausted":
			return { label: "Used up", tone: "pending" };
		case "expired":
			return { label: "Expired", tone: "muted" };
		case "revoked":
		default:
			return { label: "Revoked", tone: "muted" };
	}
}

/** Active links first, then the rest; newest `created_on` first in each group. */
export function sortInviteLinks<
	T extends Pick<InviteLinkView, "status" | "created_on">,
>(links: readonly T[]): T[] {
	return links
		.map((link, index) => ({
			link,
			index,
			group: link.status === "active" ? 0 : 1,
			createdAt: parseTimestamp(link.created_on) ?? 0,
		}))
		.sort(
			(left, right) =>
				left.group - right.group ||
				right.createdAt - left.createdAt ||
				left.index - right.index,
		)
		.map((entry) => entry.link);
}

function defaultInviteLinkDraft(): InviteLinkDraft {
	return {
		destination: "organization",
		usesPreset: "unlimited",
		customUses: "",
		expiresPreset: "30",
		allowedEmailsText: "",
	};
}

/**
 * Reads a timestamp as an instant. Zone-less values (for example SQLite's
 * `YYYY-MM-DD HH:MM:SS`) are treated as UTC so the Worker and the browser
 * never disagree because of the viewer's local time zone.
 */
function parseTimestamp(value: string | null | undefined) {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed) return null;
	const normalized = ZONELESS_TIMESTAMP_PATTERN.test(trimmed)
		? `${trimmed.replace(" ", "T")}Z`
		: trimmed;
	const time = Date.parse(normalized);
	return Number.isNaN(time) ? null : time;
}

let countFormatter: Intl.NumberFormat | null = null;

function formatCount(value: number) {
	countFormatter ??= new Intl.NumberFormat("en-US");
	return countFormatter.format(value);
}
