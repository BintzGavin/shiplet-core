/**
 * Shared contract for organization and team invite links.
 *
 * The backend (`src/organization-invite-links.ts`, routes in `src/index.ts`)
 * produces these shapes; the workspace React island
 * (`src/platform/invite-links-app.tsx`) consumes them. Keep this file free of
 * runtime dependencies so both the Worker and the browser bundle can import it.
 */

export type InviteLinkStatus = "active" | "revoked" | "expired" | "exhausted";

/** A single redemption of an invite link, as shown to administrators. */
export type InviteLinkRedemptionView = {
	user_id: string;
	email: string;
	redeemed_on: string;
};

/**
 * Public, administrator-facing view of one invite link.
 *
 * `url` is the full shareable join URL. The raw token never appears under a
 * key named `token`; credential-free payload tests reject that key name.
 */
export type InviteLinkView = {
	id: string;
	organization_id: string;
	team_id: string | null;
	team_name: string | null;
	url: string;
	max_uses: number | null;
	use_count: number;
	allowed_emails: string[];
	expires_on: string | null;
	created_by: { id: string; email: string };
	created_on: string;
	revoked_on: string | null;
	status: InviteLinkStatus;
	redemptions: InviteLinkRedemptionView[];
};

/** Request body for `POST /api/organizations/:organizationId/invite-links`. */
export type CreateInviteLinkRequest = {
	/** Omit or null for an organization-wide link. */
	teamId?: string | null;
	/** Positive integer, or null / omitted for unlimited. */
	maxUses?: number | null;
	/** Exact email addresses allowed to redeem; empty or omitted means anyone with the link. */
	allowedEmails?: string[];
	/** Positive integer number of days until expiry, or null / omitted for no expiry. */
	expiresInDays?: number | null;
};

export type InviteLinkResponse = { link: InviteLinkView };
export type InviteLinkListResponse = { links: InviteLinkView[] };

/** Endpoint helpers shared by server tests and the browser island. */
export function inviteLinksEndpoint(organizationId: string) {
	return `/api/organizations/${encodeURIComponent(organizationId)}/invite-links`;
}

export function inviteLinkEndpoint(organizationId: string, linkId: string) {
	return `${inviteLinksEndpoint(organizationId)}/${encodeURIComponent(linkId)}`;
}

/** Path of the public join page for a link token. */
export function joinPath(token: string) {
	return `/join/${encodeURIComponent(token)}`;
}

/**
 * Server-rendered seed for the workspace island. The island hydrates with
 * this exact data so the first paint already shows the real links.
 */
export type WorkspaceInviteLinksSeed = {
	/** Organizations the signed-in user belongs to, most recent first. */
	organizations: Array<{ id: string; name: string }>;
	/** Teams per organization id. */
	teamsByOrganization: Record<string, Array<{ id: string; name: string }>>;
	/** Membership role per organization id (`admin`, `owner`, or `member`). */
	rolesByOrganization: Record<string, string>;
	/** Links per organization id; only administered organizations are populated. */
	linksByOrganization: Record<string, InviteLinkView[]>;
	/** Organization selected on first paint; matches the vanilla `#organizationSelect` default. */
	selectedOrganizationId: string;
};

export const INVITE_LINK_MAX_USES_LIMIT = 10_000;
export const INVITE_LINK_MAX_ALLOWED_EMAILS = 50;
export const INVITE_LINK_MAX_EXPIRES_IN_DAYS = 365;
