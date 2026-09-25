/**
 * Organization and team invite links.
 *
 * An organization administrator creates a reusable join link for the whole
 * organization or one team in it. The link can be limited to a number of uses,
 * set to expire, or reserved for exact email addresses. People who open it
 * sign in and accept deliberately; joining always grants the member role.
 *
 * Tables live in `src/schema.ts`, routes and the join page live in
 * `src/index.ts`, and the browser contract lives in
 * `src/platform/invite-links-types.ts`.
 */
import { appendKernelAdminAuditEvent } from "./kernel-admin-audit";
import {
	INVITE_LINK_MAX_ALLOWED_EMAILS,
	INVITE_LINK_MAX_EXPIRES_IN_DAYS,
	INVITE_LINK_MAX_USES_LIMIT,
	joinPath,
	type InviteLinkRedemptionView,
	type InviteLinkStatus,
	type InviteLinkView,
	type WorkspaceInviteLinksSeed,
} from "./platform/invite-links-types";
import {
	getOrganizationById,
	getOrganizationMembership,
	getTeam,
	getUser,
	isOrganizationAdministrator,
	listOrganizationsForUser,
	listTeamsForOrganization,
	newId,
	timestamps,
	type OrganizationRecord,
	type ShipletUser,
	type TeamRecord,
} from "./store";

export type InviteLinkRecord = {
	id: string;
	organization_id: string;
	team_id: string | null;
	token: string;
	max_uses: number | null;
	use_count: number;
	allowed_emails_json: string | null;
	expires_on: string | null;
	created_by_user_id: string;
	created_on: string;
	revoked_on: string | null;
};

export type InviteLinkRedemptionRecord = {
	id: string;
	link_id: string;
	organization_id: string;
	user_id: string;
	email: string;
	redeemed_on: string;
};

export type CreateInviteLinkInput = {
	teamId: string | null;
	maxUses: number | null;
	allowedEmails: string[];
	expiresInDays: number | null;
};

export type InviteLinkJoinTarget = {
	link: InviteLinkRecord;
	organization: OrganizationRecord;
	team: TeamRecord | null;
};

const INVITE_LINK_TOKEN_BYTES = 24;
const INVITE_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN =
	/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// D1 allows at most 100 bound parameters in one statement.
const D1_MAX_BOUND_PARAMETERS = 100;

function badRequest(message: string) {
	return new Response(message, { status: 400 });
}

/**
 * Returns a new invite link token: 24 random bytes (192 bits) from
 * `crypto.getRandomValues`, encoded as 32 base64url characters.
 *
 * The token is stored in plaintext on purpose. Administrators must be able to
 * copy the same static link again later, which a hash-only design cannot do.
 * Compensating controls: 192 bits of entropy, lookup through a unique index,
 * revocation, optional use limits, optional expiry, optional exact-email
 * reservation, and the token is only ever returned to organization
 * administrators (inside the join `url`, never under a `token` key).
 */
export function generateInviteLinkToken() {
	const bytes = new Uint8Array(INVITE_LINK_TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Normalizes an allowed-email list: an array of strings or one string, split
 * on commas and whitespace (including newlines), trimmed, lowercased, and
 * deduplicated. Throws a 400 Response for an invalid address or more than
 * INVITE_LINK_MAX_ALLOWED_EMAILS addresses.
 */
export function normalizeAllowedEmails(values: unknown): string[] {
	if (values === undefined || values === null) return [];
	const candidates =
		typeof values === "string"
			? [values]
			: Array.isArray(values) &&
				  values.every((value) => typeof value === "string")
				? (values as string[])
				: null;
	if (!candidates) {
		throw badRequest("Allowed emails must be a list of email addresses.");
	}

	const emails: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		for (const part of candidate.split(/[\s,]+/)) {
			const email = part.trim().toLowerCase();
			if (!email || seen.has(email)) continue;
			if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
				const shown = part.length > 80 ? `${part.slice(0, 77)}...` : part;
				throw badRequest(
					`"${shown}" isn't a valid email address. Fix it and try again.`,
				);
			}
			seen.add(email);
			emails.push(email);
			if (emails.length > INVITE_LINK_MAX_ALLOWED_EMAILS) {
				throw badRequest(
					`An invite link can be reserved for at most ${INVITE_LINK_MAX_ALLOWED_EMAILS} email addresses. Remove some and try again.`,
				);
			}
		}
	}
	return emails;
}

function parseOptionalLimit(value: unknown, max: number, message: string) {
	if (value === undefined || value === null) return null;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > max
	) {
		throw badRequest(message);
	}
	return value;
}

/** Validates a `CreateInviteLinkRequest` body; throws a 400 Response when invalid. */
export function parseCreateInviteLinkRequest(
	body: unknown,
): CreateInviteLinkInput {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw badRequest("Invite link settings must be a JSON object.");
	}
	const input = body as Record<string, unknown>;

	let teamId: string | null = null;
	if (input.teamId !== undefined && input.teamId !== null) {
		if (typeof input.teamId !== "string") {
			throw badRequest(
				"Team must be a team ID, or null for the whole organization.",
			);
		}
		teamId = input.teamId.trim() || null;
	}

	return {
		teamId,
		maxUses: parseOptionalLimit(
			input.maxUses,
			INVITE_LINK_MAX_USES_LIMIT,
			`Maximum uses must be a whole number from 1 to ${INVITE_LINK_MAX_USES_LIMIT.toLocaleString("en-US")}. Leave it empty for unlimited uses.`,
		),
		allowedEmails: normalizeAllowedEmails(input.allowedEmails),
		expiresInDays: parseOptionalLimit(
			input.expiresInDays,
			INVITE_LINK_MAX_EXPIRES_IN_DAYS,
			`Expiry must be a whole number of days from 1 to ${INVITE_LINK_MAX_EXPIRES_IN_DAYS}. Leave it empty for a link that doesn't expire.`,
		),
	};
}

/** Expiry timestamp for a link created at `createdOnIso`, or null for never. */
export function inviteLinkExpiresOn(
	createdOnIso: string,
	expiresInDays: number | null,
) {
	if (expiresInDays === null) return null;
	return new Date(Date.parse(createdOnIso) + expiresInDays * DAY_MS).toISOString();
}

export function inviteLinkStatus(
	record: Pick<
		InviteLinkRecord,
		"revoked_on" | "expires_on" | "max_uses" | "use_count"
	>,
	nowIso: string,
): InviteLinkStatus {
	if (record.revoked_on) return "revoked";
	if (record.expires_on !== null && record.expires_on !== undefined) {
		const expiresAt = Date.parse(record.expires_on);
		// An unreadable expiry fails closed.
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(nowIso)) {
			return "expired";
		}
	}
	if (
		record.max_uses !== null &&
		record.max_uses !== undefined &&
		record.use_count >= record.max_uses
	) {
		return "exhausted";
	}
	return "active";
}

/**
 * The exact addresses a link is reserved for, or null when anyone with the
 * link may join. An unreadable stored list fails closed (admits nobody).
 */
export function inviteLinkAllowedEmails(
	record: Pick<InviteLinkRecord, "allowed_emails_json">,
): string[] | null {
	if (record.allowed_emails_json === null || record.allowed_emails_json === undefined) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(record.allowed_emails_json);
		if (
			Array.isArray(parsed) &&
			parsed.every((value) => typeof value === "string")
		) {
			return (parsed as string[]).map((value) => value.trim().toLowerCase());
		}
	} catch {
		// Fall through: fail closed.
	}
	return [];
}

export function isInviteLinkEmailAllowed(
	record: Pick<InviteLinkRecord, "allowed_emails_json">,
	email: string,
) {
	const allowed = inviteLinkAllowedEmails(record);
	return allowed === null || allowed.includes(email.trim().toLowerCase());
}

export async function createInviteLink(db: D1Database, record: InviteLinkRecord) {
	await db
		.prepare(
			`INSERT INTO organization_invite_links
			 (id, organization_id, team_id, token, max_uses, use_count,
			  allowed_emails_json, expires_on, created_by_user_id, created_on, revoked_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.organization_id,
			record.team_id,
			record.token,
			record.max_uses,
			record.use_count,
			record.allowed_emails_json,
			record.expires_on,
			record.created_by_user_id,
			record.created_on,
			record.revoked_on,
		)
		.run();
	return record;
}

/** Malformed tokens never reach the database. */
export async function getInviteLinkByToken(db: D1Database, token: string) {
	if (!INVITE_LINK_TOKEN_PATTERN.test(token)) return null;
	return db
		.prepare("SELECT * FROM organization_invite_links WHERE token = ?")
		.bind(token)
		.first<InviteLinkRecord>();
}

export async function getInviteLinkById(db: D1Database, id: string) {
	return db
		.prepare("SELECT * FROM organization_invite_links WHERE id = ?")
		.bind(id)
		.first<InviteLinkRecord>();
}

export async function listInviteLinksForOrganization(
	db: D1Database,
	organizationId: string,
) {
	const result = await db
		.prepare(
			`SELECT * FROM organization_invite_links
			 WHERE organization_id = ?
			 ORDER BY created_on DESC, rowid DESC`,
		)
		.bind(organizationId)
		.all<InviteLinkRecord>();
	return result.results || [];
}

/** Redemptions for the given links, newest first within each link. */
export async function listRedemptionsForLinks(
	db: D1Database,
	linkIds: readonly string[],
) {
	const uniqueIds = [...new Set(linkIds)];
	const redemptions: InviteLinkRedemptionRecord[] = [];
	for (let start = 0; start < uniqueIds.length; start += D1_MAX_BOUND_PARAMETERS) {
		const chunk = uniqueIds.slice(start, start + D1_MAX_BOUND_PARAMETERS);
		const result = await db
			.prepare(
				`SELECT * FROM organization_invite_link_redemptions
				 WHERE link_id IN (${chunk.map(() => "?").join(", ")})
				 ORDER BY redeemed_on DESC, rowid DESC`,
			)
			.bind(...chunk)
			.all<InviteLinkRedemptionRecord>();
		redemptions.push(...(result.results || []));
	}
	return redemptions;
}

/** Idempotent: an already revoked link keeps its original revocation time. */
export async function revokeInviteLink(
	db: D1Database,
	id: string,
	nowIso: string,
) {
	const result = await db
		.prepare(
			`UPDATE organization_invite_links
			 SET revoked_on = ?
			 WHERE id = ? AND revoked_on IS NULL`,
		)
		.bind(nowIso, id)
		.run();
	return result.meta.changes > 0;
}

/**
 * Records that a person redeemed a link. A redemption takes its use first
 * (`consumeInviteLinkUse`) and records this row second, so every row stands
 * for a use that was already taken. The UNIQUE (link_id, user_id) constraint
 * keeps one row per person: a repeated or concurrent submit by the same
 * person gets "already_redeemed", and a submit that took a use of its own
 * then gives it back (`decrementInviteLinkUse`), because the row that got
 * there first holds the person's counted use.
 *
 * A row is never deleted once written, even when the join it belongs to
 * fails part-way: it keeps holding that person's use, so their retry
 * finishes the join without taking another. If they never retry, the use
 * stays taken, which errs on the side of never exceeding max_uses.
 */
export async function recordInviteLinkRedemption(
	db: D1Database,
	input: {
		link: Pick<InviteLinkRecord, "id" | "organization_id">;
		userId: string;
		email: string;
		nowIso: string;
	},
): Promise<"recorded" | "already_redeemed"> {
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO organization_invite_link_redemptions
			 (id, link_id, organization_id, user_id, email, redeemed_on)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId("invlinkuse"),
			input.link.id,
			input.link.organization_id,
			input.userId,
			input.email.trim().toLowerCase(),
			input.nowIso,
		)
		.run();
	// `> 0`, not `=== 1`: D1 counts rows written by triggers too, and reading an
	// inflated count as "already redeemed" would give back the use this row
	// holds.
	return result.meta.changes > 0 ? "recorded" : "already_redeemed";
}

/**
 * Atomically takes one use. Fails when the link is revoked, expired, or used
 * up at the moment of the write, so concurrent redemptions cannot exceed
 * max_uses and a revoke or expiry wins any race with a redemption. A
 * redemption takes its use before it records the redemption row.
 */
export async function consumeInviteLinkUse(
	db: D1Database,
	linkId: string,
	nowIso: string,
) {
	const result = await db
		.prepare(
			`UPDATE organization_invite_links SET use_count = use_count + 1 WHERE id = ? AND revoked_on IS NULL AND (max_uses IS NULL OR use_count < max_uses) AND (expires_on IS NULL OR expires_on > ?)`,
		)
		.bind(linkId, nowIso)
		.run();
	// `> 0`, not `=== 1`: the update matches at most this one link, but D1
	// counts rows written by triggers too.
	return result.meta.changes > 0;
}

/**
 * Gives back one use that a submit took and holds no redemption row for:
 * either a concurrent submit by the same person recorded the row first, and
 * that row holds the counted use, or recording the row failed. Never for a
 * use a row stands for, because rows are never deleted.
 */
export async function decrementInviteLinkUse(db: D1Database, linkId: string) {
	await db
		.prepare(
			`UPDATE organization_invite_links
			 SET use_count = use_count - 1
			 WHERE id = ? AND use_count > 0`,
		)
		.bind(linkId)
		.run();
}

/**
 * Whether the person's redemption of the link is recorded. A recorded
 * redemption holds a counted use, so its holder takes no other. Rows are
 * never deleted, so once this is true it stays true, even when the join that
 * recorded it failed part-way.
 */
export async function hasInviteLinkRedemption(
	db: D1Database,
	linkId: string,
	userId: string,
) {
	const row = await db
		.prepare(
			`SELECT id FROM organization_invite_link_redemptions
			 WHERE link_id = ? AND user_id = ?`,
		)
		.bind(linkId, userId)
		.first<{ id: string }>();
	return Boolean(row);
}

/**
 * A link's status for one signed-in person. A person holding a redemption
 * holds a counted use, even when their join failed part-way, because
 * redemptions are never deleted. A link used up by that use therefore stays
 * open for them, so a retry can finish the join. Everyone else is refused
 * before anything is written. Revoked and expired links stay closed for
 * everyone. This check picks the page to show; the atomic take in
 * `consumeInviteLinkUse` still settles races between concurrent submits.
 */
export async function inviteLinkStatusForUser(
	db: D1Database,
	link: InviteLinkRecord,
	userId: string,
	nowIso: string,
): Promise<InviteLinkStatus> {
	const status = inviteLinkStatus(link, nowIso);
	if (status !== "exhausted") return status;
	return (await hasInviteLinkRedemption(db, link.id, userId))
		? "active"
		: status;
}

export async function hasTeamMembership(
	db: D1Database,
	teamId: string,
	userId: string,
) {
	const row = await db
		.prepare(
			"SELECT team_id FROM team_memberships WHERE team_id = ? AND user_id = ?",
		)
		.bind(teamId, userId)
		.first<{ team_id: string }>();
	return Boolean(row);
}

/**
 * The link, organization, and team behind a join token, or null when any of
 * them is missing or the team belongs to another organization.
 */
export async function loadInviteLinkJoinTarget(
	db: D1Database,
	token: string,
): Promise<InviteLinkJoinTarget | null> {
	const link = await getInviteLinkByToken(db, token);
	if (!link) return null;
	const organization = await getOrganizationById(db, link.organization_id);
	if (!organization) return null;
	if (!link.team_id) return { link, organization, team: null };
	const team = await getTeam(db, link.team_id);
	if (!team || team.organization_id !== organization.id) return null;
	return { link, organization, team };
}

/**
 * Whether the person already has everything the link grants: organization
 * membership, plus membership of the team for a team link.
 */
export async function hasJoinedInviteLinkTarget(
	db: D1Database,
	target: Pick<InviteLinkJoinTarget, "organization" | "team">,
	userId: string,
) {
	const membership = await getOrganizationMembership(
		db,
		target.organization.id,
		userId,
	);
	if (!membership) return false;
	return !target.team || hasTeamMembership(db, target.team.id, userId);
}

/**
 * Administrator-facing view of one link. Built key by key so the stored token
 * only ever appears inside `url`.
 */
export function publicInviteLink(
	record: InviteLinkRecord,
	ctx: {
		appUrl: string;
		teamName: string | null;
		creator: { id: string; email: string };
		redemptions: ReadonlyArray<
			Pick<InviteLinkRedemptionRecord, "user_id" | "email" | "redeemed_on">
		>;
		nowIso: string;
	},
): InviteLinkView {
	return {
		id: record.id,
		organization_id: record.organization_id,
		team_id: record.team_id ?? null,
		team_name: record.team_id ? ctx.teamName : null,
		url: `${ctx.appUrl.replace(/\/+$/, "")}${joinPath(record.token)}`,
		max_uses: record.max_uses ?? null,
		use_count: record.use_count,
		allowed_emails: inviteLinkAllowedEmails(record) ?? [],
		expires_on: record.expires_on ?? null,
		created_by: { id: ctx.creator.id, email: ctx.creator.email },
		created_on: record.created_on,
		revoked_on: record.revoked_on ?? null,
		status: inviteLinkStatus(record, ctx.nowIso),
		redemptions: ctx.redemptions.map(
			(redemption): InviteLinkRedemptionView => ({
				user_id: redemption.user_id,
				email: redemption.email,
				redeemed_on: redemption.redeemed_on,
			}),
		),
	};
}

/**
 * Views for several links, loading team names, creator emails, and
 * redemptions once per distinct team, creator, and batch of links.
 */
export async function loadInviteLinkViews(
	db: D1Database,
	records: readonly InviteLinkRecord[],
	options: {
		appUrl: string;
		nowIso?: string;
		teams?: ReadonlyArray<Pick<TeamRecord, "id" | "name">>;
	},
): Promise<InviteLinkView[]> {
	if (records.length === 0) return [];
	const nowIso = options.nowIso ?? timestamps.now();

	const teamNames = new Map(
		(options.teams ?? []).map((team) => [team.id, team.name] as const),
	);
	const missingTeamIds = [
		...new Set(
			records.flatMap((record) =>
				record.team_id && !teamNames.has(record.team_id) ? [record.team_id] : [],
			),
		),
	];
	for (const team of await Promise.all(
		missingTeamIds.map((teamId) => getTeam(db, teamId)),
	)) {
		if (team) teamNames.set(team.id, team.name);
	}

	const creatorEmails = new Map<string, string>();
	const creatorIds = [...new Set(records.map((record) => record.created_by_user_id))];
	for (const creator of await Promise.all(
		creatorIds.map((creatorId) => getUser(db, creatorId)),
	)) {
		if (creator) creatorEmails.set(creator.id, creator.email);
	}

	const redemptionsByLink = new Map<string, InviteLinkRedemptionRecord[]>();
	for (const redemption of await listRedemptionsForLinks(
		db,
		records.map((record) => record.id),
	)) {
		const existing = redemptionsByLink.get(redemption.link_id);
		if (existing) existing.push(redemption);
		else redemptionsByLink.set(redemption.link_id, [redemption]);
	}

	return records.map((record) =>
		publicInviteLink(record, {
			appUrl: options.appUrl,
			teamName: record.team_id ? (teamNames.get(record.team_id) ?? null) : null,
			creator: {
				id: record.created_by_user_id,
				email: creatorEmails.get(record.created_by_user_id) ?? "",
			},
			redemptions: redemptionsByLink.get(record.id) ?? [],
			nowIso,
		}),
	);
}

/**
 * Server-rendered seed for the workspace invite links island.
 *
 * Every organization gets a `linksByOrganization` entry: its links when the
 * user administers it, and an empty array otherwise (mirroring
 * `apiTokensByOrganization` in `/api/dashboard`). Use `rolesByOrganization`,
 * not the presence of links, to decide whether to show administration.
 */
export async function loadWorkspaceInviteLinksSeed(
	db: D1Database,
	user: Pick<ShipletUser, "id">,
	appUrl: string,
): Promise<WorkspaceInviteLinksSeed> {
	const organizations = await listOrganizationsForUser(db, user.id);
	const nowIso = timestamps.now();
	const seed: WorkspaceInviteLinksSeed = {
		organizations: organizations.map((organization) => ({
			id: organization.id,
			name: organization.name,
		})),
		teamsByOrganization: {},
		rolesByOrganization: {},
		linksByOrganization: {},
		selectedOrganizationId: organizations[0]?.id ?? "",
	};

	for (const organization of organizations) {
		const [membership, teams] = await Promise.all([
			getOrganizationMembership(db, organization.id, user.id),
			listTeamsForOrganization(db, organization.id),
		]);
		seed.teamsByOrganization[organization.id] = teams.map((team) => ({
			id: team.id,
			name: team.name,
		}));
		seed.rolesByOrganization[organization.id] = membership?.role ?? "member";
		seed.linksByOrganization[organization.id] = isOrganizationAdministrator(
			membership,
		)
			? await loadInviteLinkViews(
					db,
					await listInviteLinksForOrganization(db, organization.id),
					{ appUrl, nowIso, teams },
				)
			: [];
	}
	return seed;
}

/**
 * Audits one redemption as intent, then succeeded or failed, like
 * `runAuditedKernelAdminAction`. That helper only records `targetKind`, so
 * this one also records which link (and team) was redeemed. Metadata never
 * holds emails or the token.
 */
export async function runAuditedInviteLinkRedemption<T>(input: {
	db: D1Database;
	organizationId: string;
	actorId: string;
	inviteLinkId: string;
	teamId: string | null;
	operation: () => Promise<T>;
}) {
	const action = "organization_invite_link.redeem";
	const actor = { kind: "human" as const, id: input.actorId };
	const metadata: Record<string, string> = {
		targetKind: "invite_link",
		inviteLinkId: input.inviteLinkId,
	};
	if (input.teamId) metadata.teamId = input.teamId;

	const intent = await appendKernelAdminAuditEvent(input.db, {
		organizationId: input.organizationId,
		actor,
		action,
		outcome: "intent",
		metadata,
	});
	try {
		const result = await input.operation();
		await appendKernelAdminAuditEvent(input.db, {
			organizationId: input.organizationId,
			actor,
			action,
			outcome: "succeeded",
			metadata: { ...metadata, intentEventId: intent.id },
		});
		return result;
	} catch (error) {
		await appendKernelAdminAuditEvent(input.db, {
			organizationId: input.organizationId,
			actor,
			action,
			outcome: "failed",
			metadata: { ...metadata, intentEventId: intent.id },
		});
		throw error;
	}
}
