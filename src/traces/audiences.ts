// Trace audiences and level resolution (docs/traces-spec.md D2, D5, slice 2).
// An audience pairs a target (a person, an exact email, a team, the
// organization, anyone who can open the link, or one API key) with a profile:
// a redaction level plus ordered rules.
import type { Env } from "../env";
import { getOrganizationMembership, isOrganizationAdministrator, type ShipletUser } from "../store";
import type { Project } from "../types";
import type { TraceRow } from "./store";

export const AUDIENCE_TARGET_TYPES = ["user", "email", "team", "organization", "link", "api_token"] as const;
export type AudienceTargetType = (typeof AUDIENCE_TARGET_TYPES)[number];
export const LEVELS = ["full", "conversation", "summary", "hidden"] as const;
export type TraceLevel = (typeof LEVELS)[number];
const LEVEL_RANK: Record<TraceLevel, number> = { full: 3, conversation: 2, summary: 1, hidden: 0 };

export type TraceProfile = { level: TraceLevel; rules: Array<Record<string, unknown>> };

export type AudienceRow = {
	id: string;
	trace_id: string;
	project_id: string;
	target_type: AudienceTargetType;
	target_id: string;
	profile_json: string;
	profile_digest: string;
	created_by: string;
	created_on: string;
};

export async function ensureTraceAudienceSchema(db: D1Database) {
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS trace_audiences (
				id TEXT PRIMARY KEY,
				trace_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				target_type TEXT NOT NULL,
				target_id TEXT NOT NULL,
				profile_json TEXT NOT NULL,
				profile_digest TEXT NOT NULL,
				created_by TEXT NOT NULL,
				created_on TEXT NOT NULL,
				UNIQUE (trace_id, target_type, target_id)
			)`,
		),
		db.prepare("CREATE INDEX IF NOT EXISTS trace_audiences_trace ON trace_audiences(trace_id)"),
		db.prepare("CREATE INDEX IF NOT EXISTS trace_audiences_project ON trace_audiences(project_id)"),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS trace_variants (
				trace_id TEXT NOT NULL,
				profile_digest TEXT NOT NULL,
				segment_count INTEGER NOT NULL,
				manifest_sha256 TEXT NOT NULL,
				created_on TEXT NOT NULL,
				PRIMARY KEY (trace_id, profile_digest)
			)`,
		),
	]);
}

export async function listAudiences(db: D1Database, traceId: string) {
	const rows = await db
		.prepare("SELECT * FROM trace_audiences WHERE trace_id = ? ORDER BY created_on ASC, id ASC")
		.bind(traceId)
		.all<AudienceRow>();
	return rows.results || [];
}

export function audienceView(row: AudienceRow) {
	return {
		targetType: row.target_type,
		targetId: row.target_id,
		profile: JSON.parse(row.profile_json) as TraceProfile,
		profileDigest: row.profile_digest,
		createdOn: row.created_on,
	};
}

export type TraceViewer =
	| { kind: "user"; user: ShipletUser }
	| { kind: "api_key"; tokenId: string }
	| { kind: "anonymous" };

export type ResolvedAccess =
	| { level: "full"; via: "uploader" | "owner" | "admin"; profile: null }
	| { level: TraceLevel; via: "audience"; profile: TraceProfile; profileDigest: string; audience: AudienceRow }
	| { level: "hidden"; via: "none"; profile: null };

async function teamIdsFor(db: D1Database, userId: string) {
	const rows = await db.prepare("SELECT team_id FROM team_memberships WHERE user_id = ?").bind(userId).all<{ team_id: string }>();
	return new Set((rows.results || []).map((row) => row.team_id));
}

function pickMostPermissive(candidates: AudienceRow[]) {
	let best: { row: AudienceRow; profile: TraceProfile } | null = null;
	for (const row of candidates) {
		const profile = JSON.parse(row.profile_json) as TraceProfile;
		if (!best || LEVEL_RANK[profile.level] > LEVEL_RANK[best.profile.level]) best = { row, profile };
	}
	return best;
}

// D5. The caller has already established that the viewer may view the
// Shiplet (canViewProject for people, project access for API keys).
export async function resolveTraceLevel(
	env: Env,
	project: Project,
	trace: TraceRow,
	viewer: TraceViewer,
	audiences?: AudienceRow[],
): Promise<ResolvedAccess> {
	if (viewer.kind === "api_key" && trace.uploader_token_id === viewer.tokenId) {
		return { level: "full", via: "uploader", profile: null };
	}
	if (viewer.kind === "user") {
		if (trace.uploader_user_id === viewer.user.id) return { level: "full", via: "uploader", profile: null };
		if (project.owner_user_id === viewer.user.id) return { level: "full", via: "owner", profile: null };
	}
	if (trace.sharing !== "shared") return { level: "hidden", via: "none", profile: null };
	if (viewer.kind === "user" && project.organization_id) {
		const membership = await getOrganizationMembership(env.DB, project.organization_id, viewer.user.id);
		if (isOrganizationAdministrator(membership)) return { level: "full", via: "admin", profile: null };
	}
	const rows = audiences ?? (await listAudiences(env.DB, trace.id));
	let tier: AudienceRow[] = [];
	if (viewer.kind === "api_key") {
		tier = rows.filter((row) => row.target_type === "api_token" && row.target_id === viewer.tokenId);
	} else if (viewer.kind === "user") {
		const email = viewer.user.email.toLowerCase();
		const tiers: Array<() => Promise<AudienceRow[]> | AudienceRow[]> = [
			() =>
				rows.filter(
					(row) => (row.target_type === "user" && row.target_id === viewer.user.id) || (row.target_type === "email" && row.target_id === email),
				),
			async () => {
				const teamRows = rows.filter((row) => row.target_type === "team");
				if (!teamRows.length) return [];
				const teams = await teamIdsFor(env.DB, viewer.user.id);
				return teamRows.filter((row) => teams.has(row.target_id));
			},
			async () => {
				const orgRows = rows.filter((row) => row.target_type === "organization" && row.target_id === project.organization_id);
				if (!orgRows.length || !project.organization_id) return [];
				return (await getOrganizationMembership(env.DB, project.organization_id, viewer.user.id)) ? orgRows : [];
			},
			() => rows.filter((row) => row.target_type === "link"),
		];
		for (const next of tiers) {
			tier = await next();
			if (tier.length) break;
		}
	} else {
		tier = rows.filter((row) => row.target_type === "link");
	}
	const best = pickMostPermissive(tier);
	if (!best || best.profile.level === "hidden") return { level: "hidden", via: "none", profile: null };
	return { level: best.profile.level, via: "audience", profile: best.profile, profileDigest: best.row.profile_digest, audience: best.row };
}

export function canManageAudiences(project: Project, trace: TraceRow, viewer: TraceViewer) {
	if (viewer.kind === "api_key") return trace.uploader_token_id === viewer.tokenId;
	if (viewer.kind === "user") return trace.uploader_user_id === viewer.user.id || project.owner_user_id === viewer.user.id;
	return false;
}

export async function canDeleteTrace(env: Env, project: Project, trace: TraceRow, viewer: TraceViewer) {
	if (canManageAudiences(project, trace, viewer)) return true;
	if (viewer.kind !== "user" || !project.organization_id) return false;
	return isOrganizationAdministrator(await getOrganizationMembership(env.DB, project.organization_id, viewer.user.id));
}
