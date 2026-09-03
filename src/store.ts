import type { Project } from "./types";
import {
  avatarPresetForUser,
  normalizeAvatarPreset,
  type AvatarPresetId,
} from "./avatars";

export interface ShipletUser {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  avatar_preset?: AvatarPresetId | string | null;
  avatar_data_url?: string | null;
  created_on: string;
  updated_on: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  expires_on: string;
  created_on: string;
}

export interface AccountSessionRecord {
  group_id: string;
  session_id: string;
  user_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  avatar_preset?: AvatarPresetId | string | null;
  avatar_data_url?: string | null;
  created_on: string;
  last_selected_on: string;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  created_by_user_id: string;
  created_on: string;
}

export interface OrganizationMembershipRecord {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  created_on: string;
}

export interface TeamRecord {
  id: string;
  organization_id: string;
  name: string;
  description?: string | null;
  created_by_user_id: string;
  created_on: string;
}

export interface AppInvitationRecord {
  id: string;
  organization_id: string;
  team_id?: string | null;
  project_id?: string | null;
  email: string;
  invite_type: string;
  role: string;
  status: string;
  invited_by_user_id: string;
  workos_invitation_id: string;
  workos_invitation_token?: string | null;
  created_on: string;
  accepted_on?: string | null;
}

export interface ShipletAccessGrantRecord {
  id: string;
  project_id: string;
  organization_id: string;
  target_type: "organization" | "team" | "user";
  target_id?: string | null;
  email?: string | null;
  role: string;
  invited_by_user_id: string;
  workos_invitation_id?: string | null;
  created_on: string;
  accepted_on?: string | null;
}

export type ShipletAccessRequestEmailStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "not_configured";

export interface ShipletAccessRequestRecord {
  id: string;
  project_id: string;
  organization_id?: string | null;
  requester_user_id: string;
  requester_email: string;
  status: "pending" | "approved" | "denied";
  email_status: ShipletAccessRequestEmailStatus;
  email_error?: string | null;
  created_on: string;
  updated_on: string;
}

export interface OrganizationMentionUserRecord extends ShipletUser {
  organization_role: string;
  membership_created_on: string;
}

export type ShipletParticipationStatus = "active" | "invited" | "none";

export interface ShipletParticipationRecord {
  status: ShipletParticipationStatus;
  grant_id?: string | null;
}

export const SHIPLET_ARCHIVE_RETENTION_DAYS = 30;
const SHIPLET_ACCESS_REQUEST_EMAIL_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

type ProjectArchiveStatus = "active" | "archived" | "all";

type ListProjectsOptions = {
  archiveStatus?: ProjectArchiveStatus;
  organizationId?: string;
  limit?: number;
  offset?: number;
};

function now() {
  return new Date().toISOString();
}

function archiveFilterSql(status: ProjectArchiveStatus = "active") {
  if (status === "archived") return "AND projects.archived_on IS NOT NULL";
  if (status === "all") return "";
  return "AND projects.archived_on IS NULL";
}

function deleteAfterForArchive(archivedOn: string) {
  return new Date(
    new Date(archivedOn).getTime() +
      SHIPLET_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function isEditorRole(role: string | null | undefined) {
  return role === "owner" || role === "editor";
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function upsertUser(
  db: D1Database,
  user: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    avatarPreset?: string | null;
    avatarDataUrl?: string | null;
  },
) {
  const timestamp = now();
  const avatarPreset = normalizeAvatarPreset(
    user.avatarPreset || avatarPresetForUser(user.id, user.email),
  );
  await db
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, avatar_preset, avatar_data_url, created_on, updated_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			 email = excluded.email,
			 first_name = excluded.first_name,
			 last_name = excluded.last_name,
			 avatar_preset = COALESCE(users.avatar_preset, excluded.avatar_preset),
			 avatar_data_url = users.avatar_data_url,
			 updated_on = excluded.updated_on`,
    )
    .bind(
      user.id,
      user.email,
      user.firstName || null,
      user.lastName || null,
      avatarPreset,
      user.avatarDataUrl || null,
      timestamp,
      timestamp,
    )
    .run();
}

export async function getUser(db: D1Database, userId: string) {
  return db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<ShipletUser>();
}

export async function getUserByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.trim().toLowerCase())
    .first<ShipletUser>();
}

export async function updateUserAvatar(
  db: D1Database,
  userId: string,
  avatar: { avatarPreset: string; avatarDataUrl: string | null },
) {
  await db
    .prepare(
      `UPDATE users
			 SET avatar_preset = ?, avatar_data_url = ?, updated_on = ?
			 WHERE id = ?`,
    )
    .bind(
      normalizeAvatarPreset(avatar.avatarPreset),
      avatar.avatarDataUrl,
      now(),
      userId,
    )
    .run();
  return getUser(db, userId);
}

export async function createSession(db: D1Database, userId: string) {
  const session: SessionRecord = {
    id: newId("sess"),
    user_id: userId,
    created_on: now(),
    expires_on: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  };

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_on, created_on)
			 VALUES (?, ?, ?, ?)`,
    )
    .bind(session.id, session.user_id, session.expires_on, session.created_on)
    .run();

  return session;
}

export async function attachSessionToAccountGroup(
  db: D1Database,
  groupId: string,
  sessionId: string,
  userId: string,
) {
  await db
    .prepare(
      `INSERT INTO account_group_sessions
			 (group_id, user_id, session_id, created_on, last_selected_on)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(group_id, user_id) DO UPDATE SET
			 session_id = excluded.session_id,
			 last_selected_on = excluded.last_selected_on`,
    )
    .bind(groupId, userId, sessionId, now(), now())
    .run();
}

export async function listAccountGroupSessions(
  db: D1Database,
  groupId: string,
) {
  const result = await db
    .prepare(
      `SELECT
			 account_group_sessions.group_id,
			 account_group_sessions.session_id,
			 account_group_sessions.user_id,
			 account_group_sessions.created_on,
			 account_group_sessions.last_selected_on,
			 users.email,
			 users.first_name,
			 users.last_name,
			 users.avatar_preset,
			 users.avatar_data_url
			 FROM account_group_sessions
			 JOIN sessions ON sessions.id = account_group_sessions.session_id
			 JOIN users ON users.id = account_group_sessions.user_id
			 WHERE account_group_sessions.group_id = ?
			   AND sessions.expires_on > ?
			 ORDER BY account_group_sessions.last_selected_on DESC`,
    )
    .bind(groupId, now())
    .all<AccountSessionRecord>();
  return result.results || [];
}

export async function getAccountGroupSession(
  db: D1Database,
  groupId: string,
  sessionId: string,
) {
  const row = await db
    .prepare(
      `SELECT
			 account_group_sessions.group_id,
			 account_group_sessions.session_id,
			 account_group_sessions.user_id,
			 account_group_sessions.created_on,
			 account_group_sessions.last_selected_on,
			 users.email,
			 users.first_name,
			 users.last_name,
			 users.avatar_preset,
			 users.avatar_data_url
			 FROM account_group_sessions
			 JOIN sessions ON sessions.id = account_group_sessions.session_id
			 JOIN users ON users.id = account_group_sessions.user_id
			 WHERE account_group_sessions.group_id = ?
			   AND account_group_sessions.session_id = ?
			   AND sessions.expires_on > ?`,
    )
    .bind(groupId, sessionId, now())
    .first<AccountSessionRecord>();
  return row || null;
}

export async function touchAccountGroupSession(
  db: D1Database,
  groupId: string,
  sessionId: string,
) {
  await db
    .prepare(
      `UPDATE account_group_sessions
			 SET last_selected_on = ?
			 WHERE group_id = ? AND session_id = ?`,
    )
    .bind(now(), groupId, sessionId)
    .run();
}

export async function getSessionWithUser(db: D1Database, sessionId: string) {
  const row = await db
    .prepare(
      `SELECT users.*
			 FROM sessions
			 JOIN users ON users.id = sessions.user_id
			 WHERE sessions.id = ? AND sessions.expires_on > ?`,
    )
    .bind(sessionId, now())
    .first<ShipletUser>();
  return row || null;
}

export async function deleteSession(db: D1Database, sessionId: string) {
  await db
    .prepare("DELETE FROM account_group_sessions WHERE session_id = ?")
    .bind(sessionId)
    .run();
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export async function deleteAccountGroupSessions(
  db: D1Database,
  groupId: string,
) {
  const sessions = await listAccountGroupSessions(db, groupId);
  await db
    .prepare("DELETE FROM account_group_sessions WHERE group_id = ?")
    .bind(groupId)
    .run();
  for (const session of sessions) {
    await db
      .prepare("DELETE FROM sessions WHERE id = ?")
      .bind(session.session_id)
      .run();
  }
}

export async function createOrganizationRecord(
  db: D1Database,
  organization: OrganizationRecord,
) {
  await db
    .prepare(
      `INSERT INTO organizations (id, name, created_by_user_id, created_on)
			 VALUES (?, ?, ?, ?)`,
    )
    .bind(
      organization.id,
      organization.name,
      organization.created_by_user_id,
      organization.created_on,
    )
    .run();
  return organization;
}

export async function getOrganizationById(
  db: D1Database,
  organizationId: string,
) {
  return db
    .prepare("SELECT * FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<OrganizationRecord>();
}

export async function createOrganizationMembershipRecord(
  db: D1Database,
  membership: OrganizationMembershipRecord,
) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO organization_memberships
			 (id, organization_id, user_id, role, created_on)
			 VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      membership.id,
      membership.organization_id,
      membership.user_id,
      membership.role,
      membership.created_on,
    )
    .run();
  return membership;
}

export async function ensureOrganizationMembershipRecord(
  db: D1Database,
  membership: OrganizationMembershipRecord,
) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO organization_memberships
			 (id, organization_id, user_id, role, created_on)
			 VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      membership.id,
      membership.organization_id,
      membership.user_id,
      membership.role,
      membership.created_on,
    )
    .run();
  if (membership.role === "admin") {
    await db
      .prepare(
        `UPDATE organization_memberships
				 SET role = 'admin'
				 WHERE organization_id = ?
				   AND user_id = ?
				   AND role <> 'admin'`,
      )
      .bind(membership.organization_id, membership.user_id)
      .run();
  }
}

export async function getOrganizationMembership(
  db: D1Database,
  organizationId: string,
  userId: string,
) {
  return db
    .prepare(
      `SELECT * FROM organization_memberships
			 WHERE organization_id = ? AND user_id = ?`,
    )
    .bind(organizationId, userId)
    .first<OrganizationMembershipRecord>();
}

export async function requireOrganizationMembership(
  db: D1Database,
  organizationId: string,
  userId: string,
) {
  const membership = await getOrganizationMembership(
    db,
    organizationId,
    userId,
  );
  if (!membership) {
    throw new Response("Organization access required", { status: 403 });
  }
  return membership;
}

export function isOrganizationAdministrator(
  membership: OrganizationMembershipRecord | null | undefined,
) {
  const role = membership?.role.trim().toLowerCase();
  return role === "admin" || role === "owner";
}

export async function requireOrganizationAdministrator(
  db: D1Database,
  organizationId: string,
  userId: string,
) {
  const membership = await requireOrganizationMembership(
    db,
    organizationId,
    userId,
  );
  if (!isOrganizationAdministrator(membership)) {
    throw new Response("Organization administrator access required", {
      status: 403,
    });
  }
  return membership;
}

export async function listOrganizationsForUser(db: D1Database, userId: string) {
  const result = await db
    .prepare(
      `SELECT organizations.*
			 FROM organizations
			 JOIN organization_memberships
			 ON organization_memberships.organization_id = organizations.id
			 WHERE organization_memberships.user_id = ?
			 ORDER BY organizations.created_on DESC`,
    )
    .bind(userId)
    .all<OrganizationRecord>();
  return result.results || [];
}

export async function createTeamRecord(db: D1Database, team: TeamRecord) {
  await db
    .prepare(
      `INSERT INTO teams
			 (id, organization_id, name, description, created_by_user_id, created_on)
			 VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      team.id,
      team.organization_id,
      team.name,
      team.description || null,
      team.created_by_user_id,
      team.created_on,
    )
    .run();
  return team;
}

export async function getTeam(db: D1Database, teamId: string) {
  return db
    .prepare("SELECT * FROM teams WHERE id = ?")
    .bind(teamId)
    .first<TeamRecord>();
}

export async function listTeamsForOrganization(
  db: D1Database,
  organizationId: string,
) {
  const result = await db
    .prepare(
      `SELECT teams.*
			 FROM teams
			 WHERE organization_id = ?
			 ORDER BY created_on DESC`,
    )
    .bind(organizationId)
    .all<TeamRecord>();
  return result.results || [];
}

export async function listProjectsForUser(
  db: D1Database,
  userId: string,
  options: ListProjectsOptions = {},
) {
  const user = await getUser(db, userId);
  const archiveFilter = archiveFilterSql(options.archiveStatus);
  const organizationFilter =
    typeof options.organizationId === "string" && options.organizationId
      ? "AND projects.organization_id = ?"
      : "";
  const limit =
    typeof options.limit === "number" && Number.isSafeInteger(options.limit)
      ? Math.min(Math.max(options.limit, 1), 100)
      : null;
  const offset =
    typeof options.offset === "number" &&
    Number.isSafeInteger(options.offset) &&
    options.offset >= 0
      ? options.offset
      : 0;
  const paginationSql = limit === null ? "" : "LIMIT ? OFFSET ?";
  const bindings: Array<string | number> = [
    userId,
    userId,
    user?.email || "",
    userId,
    userId,
  ];
  if (organizationFilter) bindings.push(options.organizationId as string);
  if (limit !== null) bindings.push(limit, offset);
  const result = await db
    .prepare(
      `SELECT DISTINCT projects.*
			 FROM projects
			 LEFT JOIN organization_memberships
			 ON organization_memberships.organization_id = projects.organization_id
			 AND organization_memberships.user_id = ?
			 LEFT JOIN shiplet_access_grants user_grants
			 ON user_grants.project_id = projects.id
			 AND user_grants.target_type = 'user'
			 AND (
			   user_grants.target_id = ?
			   OR (user_grants.email = ? AND user_grants.accepted_on IS NOT NULL)
			 )
			 LEFT JOIN team_memberships
			 ON team_memberships.user_id = ?
			 LEFT JOIN shiplet_access_grants team_grants
			 ON team_grants.project_id = projects.id
			 AND team_grants.target_type = 'team'
			 AND team_grants.target_id = team_memberships.team_id
			 LEFT JOIN shiplet_access_grants organization_grants
			 ON organization_grants.project_id = projects.id
			 AND organization_grants.target_type = 'organization'
			 AND organization_grants.target_id = projects.organization_id
			 WHERE (
			    projects.owner_user_id = ?
			    OR (
			      organization_memberships.user_id IS NOT NULL
			      AND (
			        COALESCE(projects.visibility, 'organization') = 'organization'
			        OR lower(organization_memberships.role) IN ('admin', 'owner')
			        OR organization_grants.id IS NOT NULL
			      )
			    )
			    OR user_grants.id IS NOT NULL
			    OR team_grants.id IS NOT NULL
			 )
			 ${archiveFilter}
       ${organizationFilter}
			 ORDER BY projects.created_on DESC
       ${paginationSql}`,
    )
    .bind(...bindings)
    .all<Project>();
  return result.results || [];
}

export async function listOrganizationMentionUsers(
  db: D1Database,
  organizationId: string,
  query = "",
  limit = 20,
) {
  const normalizedQuery = query.trim().toLowerCase();
  const cappedLimit = Math.min(Math.max(limit, 1), 50);
  const bindings: Array<string | number> = [organizationId];
  let searchClause = "";
  if (normalizedQuery) {
    searchClause = `AND (
			lower(users.email) LIKE ?
			OR lower(COALESCE(users.first_name, '')) LIKE ?
			OR lower(COALESCE(users.last_name, '')) LIKE ?
			OR lower(trim(COALESCE(users.first_name, '') || ' ' || COALESCE(users.last_name, ''))) LIKE ?
		)`;
    const like = `%${normalizedQuery}%`;
    bindings.push(like, like, like, like);
  }
  bindings.push(cappedLimit);
  const result = await db
    .prepare(
      `SELECT users.*,
			        organization_memberships.role AS organization_role,
			        organization_memberships.created_on AS membership_created_on
			 FROM organization_memberships
			 JOIN users ON users.id = organization_memberships.user_id
			 WHERE organization_memberships.organization_id = ?
			 ${searchClause}
			 ORDER BY users.email ASC
			 LIMIT ?`,
    )
    .bind(...bindings)
    .all<OrganizationMentionUserRecord>();
  return result.results || [];
}

export async function getOrganizationMentionUser(
  db: D1Database,
  organizationId: string,
  identifier: { userId?: string | null; email?: string | null },
) {
  const userId = identifier.userId?.trim();
  const email = identifier.email?.trim().toLowerCase();
  if (!userId && !email) return null;
  const row = await db
    .prepare(
      `SELECT users.*,
			        organization_memberships.role AS organization_role,
			        organization_memberships.created_on AS membership_created_on
			 FROM organization_memberships
			 JOIN users ON users.id = organization_memberships.user_id
			 WHERE organization_memberships.organization_id = ?
			   AND (users.id = ? OR users.email = ?)
			 LIMIT 1`,
    )
    .bind(organizationId, userId || "", email || "")
    .first<OrganizationMentionUserRecord>();
  return row || null;
}

export async function listProjectsForOrganization(
  db: D1Database,
  organizationId: string,
  options: ListProjectsOptions = {},
) {
  const archiveFilter = archiveFilterSql(options.archiveStatus);
  const result = await db
    .prepare(
      `SELECT *
			 FROM projects
			 WHERE organization_id = ?
			 ${archiveFilter}
			 ORDER BY created_on DESC`,
    )
    .bind(organizationId)
    .all<Project>();
  return result.results || [];
}

export async function createTeamMembership(
  db: D1Database,
  teamId: string,
  userId: string,
  organizationMembershipId?: string | null,
) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO team_memberships
			 (team_id, user_id, organization_membership_id, created_on)
			 VALUES (?, ?, ?, ?)`,
    )
    .bind(teamId, userId, organizationMembershipId || null, now())
    .run();
}

export async function createAppInvitation(
  db: D1Database,
  invitation: AppInvitationRecord,
) {
  await db
    .prepare(
      `INSERT INTO app_invitations
			 (id, organization_id, team_id, project_id, email, invite_type, role, status,
			  invited_by_user_id, workos_invitation_id, workos_invitation_token, created_on, accepted_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      invitation.id,
      invitation.organization_id,
      invitation.team_id || null,
      invitation.project_id || null,
      invitation.email,
      invitation.invite_type,
      invitation.role,
      invitation.status,
      invitation.invited_by_user_id,
      invitation.workos_invitation_id,
      invitation.workos_invitation_token || null,
      invitation.created_on,
      invitation.accepted_on || null,
    )
    .run();
  return invitation;
}

export async function findPendingInvitationsByWorkOSInvitationId(
  db: D1Database,
  workosInvitationId: string,
) {
  const result = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE workos_invitation_id = ? AND status = 'pending'`,
    )
    .bind(workosInvitationId)
    .all<AppInvitationRecord>();
  return result.results || [];
}

export async function findPendingInvitationById(
  db: D1Database,
  invitationId: string,
) {
  const invitation = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE id = ? AND status = 'pending'`,
    )
    .bind(invitationId)
    .first<AppInvitationRecord>();
  return invitation ? [invitation] : [];
}

export async function findPendingInvitationsByWorkOSInvitationToken(
  db: D1Database,
  workosInvitationToken: string,
) {
  const result = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE workos_invitation_token = ? AND status = 'pending'`,
    )
    .bind(workosInvitationToken)
    .all<AppInvitationRecord>();
  return result.results || [];
}

export async function findPendingInvitationsByEmail(
  db: D1Database,
  email: string,
) {
  const result = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE email = ? AND status = 'pending'
			 ORDER BY created_on ASC`,
    )
    .bind(email)
    .all<AppInvitationRecord>();
  return result.results || [];
}

export async function findPendingInvitationsByEmailAndOrganization(
  db: D1Database,
  email: string,
  organizationId: string,
) {
  const result = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE email = ? AND organization_id = ? AND status = 'pending'
			 ORDER BY created_on ASC`,
    )
    .bind(email, organizationId)
    .all<AppInvitationRecord>();
  return result.results || [];
}

export async function findPendingInvitationsByEmailAndProject(
  db: D1Database,
  email: string,
  projectId: string,
) {
  const result = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE email = ? AND project_id = ? AND status = 'pending'
			 ORDER BY created_on ASC`,
    )
    .bind(email, projectId)
    .all<AppInvitationRecord>();
  return result.results || [];
}

export async function findPendingInvitationsByProject(
  db: D1Database,
  projectId: string,
) {
  const result = await db
    .prepare(
      `SELECT * FROM app_invitations
			 WHERE project_id = ? AND status = 'pending'
			 ORDER BY created_on ASC`,
    )
    .bind(projectId)
    .all<AppInvitationRecord>();
  return result.results || [];
}

export async function acceptAppInvitation(
  db: D1Database,
  invitationId: string,
) {
  await db
    .prepare(
      `UPDATE app_invitations
			 SET status = 'accepted', accepted_on = ?
			 WHERE id = ?`,
    )
    .bind(now(), invitationId)
    .run();
}

export async function createShipletGrant(
  db: D1Database,
  grant: ShipletAccessGrantRecord,
) {
  await db
    .prepare(
      `INSERT INTO shiplet_access_grants
			 (id, project_id, organization_id, target_type, target_id, email, role,
			  invited_by_user_id, workos_invitation_id, created_on, accepted_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      grant.id,
      grant.project_id,
      grant.organization_id,
      grant.target_type,
      grant.target_id || null,
      grant.email || null,
      grant.role,
      grant.invited_by_user_id,
      grant.workos_invitation_id || null,
      grant.created_on,
      grant.accepted_on || null,
    )
    .run();
  return grant;
}

export async function getShipletUserGrant(
  db: D1Database,
  projectId: string,
  user: Pick<ShipletUser, "id" | "email">,
) {
  return db
    .prepare(
      `SELECT * FROM shiplet_access_grants
			 WHERE project_id = ?
			   AND target_type = 'user'
			   AND (target_id = ? OR email = ?)
			 ORDER BY created_on ASC
			 LIMIT 1`,
    )
    .bind(projectId, user.id, user.email)
    .first<ShipletAccessGrantRecord>();
}

export async function getShipletParticipation(
  db: D1Database,
  project: Project,
  user: Pick<ShipletUser, "id" | "email">,
): Promise<ShipletParticipationRecord> {
  if (project.owner_user_id === user.id) {
    return { status: "active", grant_id: null };
  }

  const directGrant = await getShipletUserGrant(db, project.id, user);
  if (directGrant) {
    return {
      status: directGrant.accepted_on ? "active" : "invited",
      grant_id: directGrant.id,
    };
  }

  if (project.organization_id) {
    const organizationGrant = await db
      .prepare(
        `SELECT * FROM shiplet_access_grants
				 WHERE project_id = ?
				   AND target_type = 'organization'
				   AND target_id = ?
				 LIMIT 1`,
      )
      .bind(project.id, project.organization_id)
      .first<ShipletAccessGrantRecord>();
    if (organizationGrant) {
      return {
        status: organizationGrant.accepted_on ? "active" : "invited",
        grant_id: organizationGrant.id,
      };
    }
  }

  const teamGrant = await db
    .prepare(
      `SELECT shiplet_access_grants.*
			 FROM shiplet_access_grants
			 JOIN team_memberships ON team_memberships.team_id = shiplet_access_grants.target_id
			 WHERE shiplet_access_grants.project_id = ?
			   AND shiplet_access_grants.target_type = 'team'
			   AND team_memberships.user_id = ?
			 ORDER BY shiplet_access_grants.created_on ASC
			 LIMIT 1`,
    )
    .bind(project.id, user.id)
    .first<ShipletAccessGrantRecord>();
  if (teamGrant) {
    return {
      status: teamGrant.accepted_on ? "active" : "invited",
      grant_id: teamGrant.id,
    };
  }

  return { status: "none", grant_id: null };
}

export async function getProjectById(db: D1Database, projectId: string) {
  return db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .bind(projectId)
    .first<Project>();
}

export async function getShipletAccessRequest(
  db: D1Database,
  projectId: string,
  requesterUserId: string,
) {
  return db
    .prepare(
      `SELECT * FROM shiplet_access_requests
			 WHERE project_id = ? AND requester_user_id = ?
			 LIMIT 1`,
    )
    .bind(projectId, requesterUserId)
    .first<ShipletAccessRequestRecord>();
}

export async function createShipletAccessRequest(
  db: D1Database,
  options: {
    projectId: string;
    organizationId?: string | null;
    requester: Pick<ShipletUser, "id" | "email">;
  },
) {
  const timestamp = now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO shiplet_access_requests
			 (id, project_id, organization_id, requester_user_id, requester_email,
			  status, email_status, created_on, updated_on)
			 VALUES (?, ?, ?, ?, ?, 'pending', 'pending', ?, ?)`,
    )
    .bind(
      newId("access_request"),
      options.projectId,
      options.organizationId || null,
      options.requester.id,
      options.requester.email.toLowerCase(),
      timestamp,
      timestamp,
    )
    .run();
  return getShipletAccessRequest(db, options.projectId, options.requester.id);
}

export async function claimShipletAccessRequestEmail(
  db: D1Database,
  requestId: string,
) {
  const claimedAt = now();
  const staleBefore = new Date(
    new Date(claimedAt).getTime() -
      SHIPLET_ACCESS_REQUEST_EMAIL_CLAIM_TIMEOUT_MS,
  ).toISOString();
  const result = await db
    .prepare(
      `UPDATE shiplet_access_requests
			 SET email_status = 'sending', email_error = NULL, updated_on = ?
			 WHERE id = ?
			   AND status = 'pending'
			   AND (
			      email_status IN ('pending', 'failed', 'not_configured')
			      OR (email_status = 'sending' AND updated_on <= ?)
			   )`,
    )
    .bind(claimedAt, requestId, staleBefore)
    .run();
  if (!result.meta.changes) return null;
  return db
    .prepare("SELECT * FROM shiplet_access_requests WHERE id = ?")
    .bind(requestId)
    .first<ShipletAccessRequestRecord>();
}

export async function updateShipletAccessRequestEmailStatus(
  db: D1Database,
  requestId: string,
  claimUpdatedOn: string,
  emailStatus: ShipletAccessRequestEmailStatus,
  emailError: string | null = null,
) {
  await db
    .prepare(
      `UPDATE shiplet_access_requests
			 SET email_status = ?, email_error = ?, updated_on = ?
			 WHERE id = ?
			   AND email_status = 'sending'
			   AND updated_on = ?`,
    )
    .bind(emailStatus, emailError, now(), requestId, claimUpdatedOn)
    .run();
  return db
    .prepare("SELECT * FROM shiplet_access_requests WHERE id = ?")
    .bind(requestId)
    .first<ShipletAccessRequestRecord>();
}

export async function canViewProject(
  db: D1Database,
  project: Project,
  userId?: string,
) {
  if (project.visibility === "public" || project.visibility === "unlisted") {
    return true;
  }
  if (!userId) return false;
  if (project.owner_user_id === userId) return true;
  const organizationMembership = project.organization_id
    ? await getOrganizationMembership(db, project.organization_id, userId)
    : null;
  if (
    isOrganizationAdministrator(organizationMembership) ||
    (project.visibility === "organization" && organizationMembership)
  ) {
    return true;
  }

  const directGrant = await db
    .prepare(
      `SELECT id FROM shiplet_access_grants
			 WHERE project_id = ? AND target_type = 'user' AND target_id = ?
			 LIMIT 1`,
    )
    .bind(project.id, userId)
    .first<{ id: string }>();

  if (directGrant) return true;

  if (project.organization_id && organizationMembership) {
    const organizationGrant = await db
      .prepare(
        `SELECT id FROM shiplet_access_grants
				 WHERE project_id = ?
				   AND target_type = 'organization'
				   AND target_id = ?
				 LIMIT 1`,
      )
      .bind(project.id, project.organization_id)
      .first<{ id: string }>();
    if (organizationGrant) return true;
  }

  const teamGrant = await db
    .prepare(
      `SELECT shiplet_access_grants.id
			 FROM shiplet_access_grants
			 JOIN team_memberships ON team_memberships.team_id = shiplet_access_grants.target_id
			 WHERE shiplet_access_grants.project_id = ?
			 AND shiplet_access_grants.target_type = 'team'
			 AND team_memberships.user_id = ?
			 LIMIT 1`,
    )
    .bind(project.id, userId)
    .first<{ id: string }>();

  return Boolean(teamGrant);
}

export async function canEditProject(
  db: D1Database,
  project: Project,
  user: Pick<ShipletUser, "id" | "email">,
) {
  if (project.owner_user_id === user.id) return true;
  let organizationMembership: OrganizationMembershipRecord | null = null;
  if (project.organization_id) {
    organizationMembership = await getOrganizationMembership(
      db,
      project.organization_id,
      user.id,
    );
    if (isOrganizationAdministrator(organizationMembership)) return true;
  }

  const directGrant = await db
    .prepare(
      `SELECT role FROM shiplet_access_grants
			 WHERE project_id = ?
			   AND target_type = 'user'
			   AND (target_id = ? OR (email = ? AND accepted_on IS NOT NULL))
			 ORDER BY created_on ASC
			 LIMIT 1`,
    )
    .bind(project.id, user.id, user.email)
    .first<{ role: string }>();
  if (isEditorRole(directGrant?.role)) return true;

  if (project.organization_id && organizationMembership) {
    const organizationGrant = await db
      .prepare(
        `SELECT role FROM shiplet_access_grants
				 WHERE project_id = ?
				   AND target_type = 'organization'
				   AND target_id = ?
				   AND role IN ('owner', 'editor')
				 ORDER BY created_on ASC
				 LIMIT 1`,
      )
      .bind(project.id, project.organization_id)
      .first<{ role: string }>();
    if (organizationMembership && isEditorRole(organizationGrant?.role)) {
      return true;
    }
  }

  const teamGrant = await db
    .prepare(
      `SELECT shiplet_access_grants.role
			 FROM shiplet_access_grants
			 JOIN team_memberships ON team_memberships.team_id = shiplet_access_grants.target_id
			 WHERE shiplet_access_grants.project_id = ?
			   AND shiplet_access_grants.target_type = 'team'
			   AND team_memberships.user_id = ?
			   AND shiplet_access_grants.role IN ('owner', 'editor')
			 ORDER BY shiplet_access_grants.created_on ASC
			 LIMIT 1`,
    )
    .bind(project.id, user.id)
    .first<{ role: string }>();

  return isEditorRole(teamGrant?.role);
}

export function isProjectOwner(project: Project, userId: string) {
  return project.owner_user_id === userId;
}

export async function archiveProject(db: D1Database, projectId: string) {
  const project = await getProjectById(db, projectId);
  if (!project) return null;

  const archivedOn = project.archived_on || now();
  const deleteAfter = project.delete_after || deleteAfterForArchive(archivedOn);
  await db
    .prepare(
      `UPDATE projects
			 SET archived_on = ?, delete_after = ?, modified_on = ?
			 WHERE id = ?`,
    )
    .bind(archivedOn, deleteAfter, now(), projectId)
    .run();

  return getProjectById(db, projectId);
}

export async function restoreProject(db: D1Database, projectId: string) {
  const project = await getProjectById(db, projectId);
  if (!project) return null;

  await db
    .prepare(
      `UPDATE projects
			 SET archived_on = NULL, delete_after = NULL, modified_on = ?
			 WHERE id = ?`,
    )
    .bind(now(), projectId)
    .run();

  return getProjectById(db, projectId);
}

export async function permanentlyDeleteProjectRecords(
  db: D1Database,
  projectId: string,
) {
  await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO shiplet_kernel_purge_authorizations
				 (project_id, authorized_on) VALUES (?, ?)`,
      )
      .bind(projectId, now()),
    db
      .prepare(
        `UPDATE projects SET active_revision_id = NULL,
				 revision_operation_id = NULL WHERE id = ?`,
      )
      .bind(projectId),
    db
      .prepare("DELETE FROM shiplet_revision_activations WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare(
        "DELETE FROM shiplet_revision_preview_receipts WHERE project_id = ?",
      )
      .bind(projectId),
    db
      .prepare(
        "DELETE FROM shiplet_revision_preview_receipts_v2 WHERE project_id = ?",
      )
      .bind(projectId),
    db
      .prepare("DELETE FROM shiplet_audit_events WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare(
        `DELETE FROM shiplet_revision_files WHERE revision_id IN
				 (SELECT id FROM shiplet_revisions WHERE project_id = ?)`,
      )
      .bind(projectId),
    db
      .prepare(
        `DELETE FROM shiplet_revision_seals WHERE revision_id IN
				 (SELECT id FROM shiplet_revisions WHERE project_id = ?)`,
      )
      .bind(projectId),
    db
      .prepare("DELETE FROM shiplet_revisions WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM embed_exchange_codes WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM embed_installations WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM review_notifications WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM review_feedback_mentions WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM review_feedback_replies WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM review_feedback WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM shiplet_watch_subscriptions WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM review_api_tokens WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare(
        "DELETE FROM organization_api_token_project_rules WHERE project_id = ?",
      )
      .bind(projectId),
    db
      .prepare("DELETE FROM shiplet_access_requests WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM shiplet_access_grants WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM app_invitations WHERE project_id = ?")
      .bind(projectId),
    db
      .prepare("DELETE FROM project_assets WHERE project_id = ?")
      .bind(projectId),
    db.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
    db
      .prepare(
        "DELETE FROM shiplet_kernel_purge_authorizations WHERE project_id = ?",
      )
      .bind(projectId),
  ]);
}

export const timestamps = {
  now,
};
