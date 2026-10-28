import { WorkOS } from "@workos-inc/node";
import type { Env } from "./env";
import { newId } from "./store";

export interface WorkOSOrganization {
  id: string;
  name: string;
}

export interface WorkOSMembership {
  id: string;
}

/** One of a person's WorkOS organization memberships, as reconciliation reads it. */
export interface WorkOSUserOrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  status: "active" | "inactive" | "pending";
  /** Every role slug WorkOS reports for the membership, or null for none. */
  roleSlugs: string[] | null;
}

export interface WorkOSUserOrganizationMembershipPage {
  memberships: WorkOSUserOrganizationMembership[];
  /** The cursor for the next page, or null on the last page. */
  after: string | null;
}

export interface WorkOSTeam {
  id: string;
  name: string;
  description?: string | null;
}

export interface WorkOSInvitation {
  id: string;
  email: string;
  organizationId?: string | null;
  token?: string | null;
  acceptInvitationUrl?: string | null;
  state?: "pending" | "accepted" | "expired" | "revoked";
  acceptedAt?: string | null;
  acceptedUserId?: string | null;
}

export interface WorkOSUser {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
}

const testInvitations = new Map<string, WorkOSInvitation>();
// Test mode stands in for WorkOS memberships. Like WorkOS, it refuses a second
// membership for the same user and organization, and refuses to add a
// membership it never issued to a team.
const testOrganizationMemberships = new Map<
  string,
  { id: string; organizationId: string; userId: string }
>();
const testTeamMembershipIds = new Map<string, Set<string>>();
// Test mode's WorkOS reports the memberships and roles Shiplet recorded, except
// where a test simulated a change in WorkOS: a removed membership, a changed
// role, or WorkOS failing to answer for a person.
const testRemovedOrganizationMemberships = new Set<string>();
const testOrganizationMembershipRoles = new Map<string, string>();
const testFailingMembershipListings = new Set<string>();
const testFailingMembershipLookups = new Set<string>();
const testHangingMembershipListings = new Set<string>();
const testMembershipListings: string[] = [];

function testOrganizationMembershipKey(organizationId: string, userId: string) {
  return JSON.stringify([organizationId, userId]);
}

function slug(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function getWorkOS(env: Env) {
  if (!env.WORKOS_API_KEY) {
    throw new Response("WORKOS_API_KEY is not configured", { status: 500 });
  }
  return new WorkOS(env.WORKOS_API_KEY);
}

function serializeInvitation(invitation: {
  id: string;
  email: string;
  organizationId?: string | null;
  token?: string | null;
  acceptInvitationUrl?: string | null;
  state?: "pending" | "accepted" | "expired" | "revoked";
  acceptedAt?: string | null;
  acceptedUserId?: string | null;
}): WorkOSInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    organizationId: invitation.organizationId,
    token: invitation.token,
    acceptInvitationUrl: invitation.acceptInvitationUrl,
    state: invitation.state,
    acceptedAt: invitation.acceptedAt,
    acceptedUserId: invitation.acceptedUserId,
  };
}

function serializeUser(user: {
  id: string;
  email: string;
  emailVerified?: boolean;
  firstName?: string | null;
  lastName?: string | null;
}): WorkOSUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified ?? true,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

export function getWorkOSAuthorizationUrl(
  env: Env,
  options: {
    state?: string;
    invitationToken?: string | null;
    organizationId?: string | null;
    redirectUri?: string;
    prompt?: string;
  },
) {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const url = new URL("https://authkit.test/authorize");
    url.searchParams.set("provider", "authkit");
    url.searchParams.set("client_id", env.WORKOS_CLIENT_ID || "client_test");
    if (options.state) url.searchParams.set("state", options.state);
    if (options.organizationId) {
      url.searchParams.set("organization_id", options.organizationId);
    }
    if (options.redirectUri) {
      url.searchParams.set("redirect_uri", options.redirectUri);
    }
    if (options.prompt) url.searchParams.set("prompt", options.prompt);
    if (options.invitationToken) {
      url.searchParams.set("invitation_token", options.invitationToken);
    }
    return url.toString();
  }

  if (!env.WORKOS_CLIENT_ID) {
    throw new Response("WORKOS_CLIENT_ID is not configured", { status: 500 });
  }

  const redirectUri =
    options.redirectUri ||
    env.WORKOS_REDIRECT_URI ||
    (env.SHIPLET_APP_URL ? `${env.SHIPLET_APP_URL}/auth/callback` : "");
  if (!redirectUri || redirectUri.includes("undefined")) {
    throw new Response("WORKOS_REDIRECT_URI or SHIPLET_APP_URL is required", {
      status: 500,
    });
  }

  const authorizationUrl = getWorkOS(env).userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: env.WORKOS_CLIENT_ID,
    redirectUri,
    state: options.state,
    prompt: options.prompt,
    organizationId: options.organizationId || undefined,
  });
  if (!options.invitationToken) return authorizationUrl;

  const url = new URL(authorizationUrl);
  url.searchParams.set("invitation_token", options.invitationToken);
  return url.toString();
}

export async function authenticateWorkOSCode(
  env: Env,
  options: {
    code: string;
    invitationToken?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
) {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const [, organizationId, encodedEmail] = options.code.split(":");
    const email = encodedEmail
      ? decodeURIComponent(encodedEmail)
      : "invited@example.com";
    const userId =
      email === "invited@example.com" ? "user_invited" : `user_${slug(email)}`;
    return {
      user: {
        id: userId,
        email,
        emailVerified: true,
        firstName: "Invited",
        lastName: "Reviewer",
      },
      organizationId: organizationId || undefined,
    };
  }

  if (!env.WORKOS_CLIENT_ID) {
    throw new Response("WORKOS_CLIENT_ID is not configured", { status: 500 });
  }

  return getWorkOS(env).userManagement.authenticateWithCode({
    clientId: env.WORKOS_CLIENT_ID,
    code: options.code,
    invitationToken: options.invitationToken || undefined,
    ipAddress: options.ipAddress || undefined,
    userAgent: options.userAgent || undefined,
  });
}

export async function findWorkOSInvitationByToken(env: Env, token: string) {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const existing = [...testInvitations.values()].find(
      (invitation) => invitation.token === token,
    );
    if (existing) return serializeInvitation(existing);
    const testOrganizationInvitation = token.match(
      /^test-org-invitation:([^:]+):([^:]+)$/,
    );
    if (testOrganizationInvitation) {
      return serializeInvitation({
        id: `inv_${slug(token)}`,
        email: decodeURIComponent(testOrganizationInvitation[2]),
        organizationId: decodeURIComponent(testOrganizationInvitation[1]),
        token,
        acceptInvitationUrl: `/auth/login?invitation_token=${encodeURIComponent(token)}`,
        state: "pending",
        acceptedAt: null,
        acceptedUserId: null,
      });
    }
    return serializeInvitation({
      id: `inv_${slug(token)}`,
      email: "invited@example.com",
      organizationId: undefined,
      token,
      acceptInvitationUrl: `/auth/login?invitation_token=${encodeURIComponent(token)}`,
      state: "pending",
      acceptedAt: null,
      acceptedUserId: null,
    });
  }

  const invitation =
    await getWorkOS(env).userManagement.findInvitationByToken(token);
  return serializeInvitation(invitation);
}

export async function getWorkOSInvitation(env: Env, invitationId: string) {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const existing = testInvitations.get(invitationId);
    if (existing) return serializeInvitation(existing);
    return serializeInvitation({
      id: invitationId,
      email: "accepted@example.com",
      organizationId: undefined,
      token: `tok_${slug(invitationId)}`,
      acceptInvitationUrl: `/auth/login?invitation_token=tok_${slug(invitationId)}`,
      state: "accepted",
      acceptedAt: new Date().toISOString(),
      acceptedUserId: "user_accepted",
    });
  }

  const invitation =
    await getWorkOS(env).userManagement.getInvitation(invitationId);
  return serializeInvitation(invitation);
}

export async function acceptWorkOSInvitationForUser(
  env: Env,
  options: {
    invitationId: string;
    userId: string;
    email: string;
    organizationId: string;
  },
) {
  if (
    env.SHIPLET_AUTH_MODE === "test" &&
    options.invitationId === "inv_test_failure"
  ) {
    throw new Response("Invitation acceptance failed", { status: 502 });
  }
  let invitation = await getWorkOSInvitation(env, options.invitationId);
  const normalizedEmail = options.email.trim().toLowerCase();
  if (invitation.email.trim().toLowerCase() !== normalizedEmail) {
    throw new Response("Invitation is not available for this account", {
      status: 403,
    });
  }
  if (
    invitation.organizationId &&
    invitation.organizationId !== options.organizationId
  ) {
    throw new Response("Invitation scope is invalid", { status: 403 });
  }
  if (invitation.state === "accepted") {
    if (
      invitation.acceptedUserId &&
      invitation.acceptedUserId !== options.userId
    ) {
      throw new Response("Invitation is not available for this account", {
        status: 403,
      });
    }
    return invitation;
  }
  if (invitation.state !== "pending") {
    throw new Response("Invitation is no longer available", { status: 410 });
  }

  try {
    if (env.SHIPLET_AUTH_MODE === "test") {
      invitation = {
        ...invitation,
        state: "accepted",
        acceptedAt: new Date().toISOString(),
        acceptedUserId: options.userId,
      };
      testInvitations.set(invitation.id, invitation);
    } else {
      invitation = serializeInvitation(
        await getWorkOS(env).userManagement.acceptInvitation(
          options.invitationId,
        ),
      );
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response("Invitation acceptance failed", { status: 502 });
  }

  if (invitation.state !== "accepted") {
    throw new Response("Invitation acceptance failed", { status: 502 });
  }
  if (
    invitation.acceptedUserId &&
    invitation.acceptedUserId !== options.userId
  ) {
    throw new Response("Invitation is not available for this account", {
      status: 403,
    });
  }
  return invitation;
}

export async function getWorkOSUser(env: Env, userId: string) {
  if (env.SHIPLET_AUTH_MODE === "test") {
    return serializeUser({
      id: userId,
      email:
        userId === "user_accepted"
          ? "accepted@example.com"
          : `${slug(userId)}@example.com`,
      firstName: "Accepted",
      lastName: "Reviewer",
    });
  }

  const user = await getWorkOS(env).userManagement.getUser(userId);
  return serializeUser(user);
}

export async function createWorkOSOrganization(
  env: Env,
  name: string,
): Promise<WorkOSOrganization> {
  if (env.SHIPLET_AUTH_MODE === "test") {
    return { id: `org_${slug(name)}`, name };
  }

  const organization = await getWorkOS(env).organizations.createOrganization({
    name,
  });
  return { id: organization.id, name: organization.name };
}

export async function createWorkOSOrganizationMembership(
  env: Env,
  options: { organizationId: string; userId: string; roleSlug?: string },
): Promise<WorkOSMembership> {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const key = testOrganizationMembershipKey(
      options.organizationId,
      options.userId,
    );
    if (testOrganizationMemberships.has(key)) {
      throw new Error("Organization membership already exists");
    }
    testRemovedOrganizationMemberships.delete(key);
    const id = `om_${slug(options.organizationId)}_${slug(options.userId)}`;
    testOrganizationMemberships.set(key, {
      id,
      organizationId: options.organizationId,
      userId: options.userId,
    });
    return { id };
  }

  const membership = await getWorkOS(
    env,
  ).userManagement.createOrganizationMembership({
    organizationId: options.organizationId,
    userId: options.userId,
    roleSlug: options.roleSlug,
  });
  return { id: membership.id };
}

/**
 * The person's active or pending WorkOS membership of the organization, or
 * null when WorkOS has none. WorkOS lists only active memberships unless asked
 * for other statuses.
 */
export async function findWorkOSOrganizationMembership(
  env: Env,
  options: { organizationId: string; userId: string },
): Promise<WorkOSMembership | null> {
  if (env.SHIPLET_AUTH_MODE === "test") {
    if (testFailingMembershipLookups.has(options.userId)) {
      throw new Response("WorkOS is unavailable", { status: 503 });
    }
    const membership = testOrganizationMemberships.get(
      testOrganizationMembershipKey(options.organizationId, options.userId),
    );
    return membership ? { id: membership.id } : null;
  }

  const memberships = await getWorkOS(
    env,
  ).userManagement.listOrganizationMemberships({
    organizationId: options.organizationId,
    userId: options.userId,
    statuses: ["active", "pending"],
  });
  const membership = memberships.data.find(
    (candidate) =>
      candidate.organizationId === options.organizationId &&
      candidate.userId === options.userId,
  );
  return membership ? { id: membership.id } : null;
}

function membershipRoleSlugs(membership: {
  role?: { slug?: unknown } | null;
  roles?: Array<{ slug?: unknown } | null> | null;
}) {
  const slugs = [membership.role, ...(membership.roles ?? [])]
    .map((role) => role?.slug)
    .filter((slug): slug is string => typeof slug === "string" && slug !== "");
  return slugs.length > 0 ? [...new Set(slugs)] : null;
}

/**
 * One page of the person's active and pending WorkOS organization
 * memberships, across every organization. WorkOS leaves out inactive
 * (deactivated) and deleted memberships. Throws when WorkOS does not answer or
 * answers with something other than a list, so a caller never mistakes a
 * failed read for a person with no memberships.
 */
export async function listWorkOSOrganizationMembershipsPage(
  env: Env,
  options: { userId: string; after?: string | null },
): Promise<WorkOSUserOrganizationMembershipPage> {
  if (env.SHIPLET_AUTH_MODE === "test") {
    testMembershipListings.push(options.userId);
    if (testFailingMembershipListings.has(options.userId)) {
      throw new Response("WorkOS is unavailable", { status: 503 });
    }
    if (testHangingMembershipListings.has(options.userId)) {
      return new Promise<never>(() => {});
    }
    const identity = await env.DB.prepare(
      `SELECT user_id FROM workos_user_identities
			 WHERE workos_user_id = ? LIMIT 1`,
    )
      .bind(options.userId)
      .first<{ user_id: string }>();
    const recorded = await env.DB.prepare(
      `SELECT id, organization_id, role FROM organization_memberships
			 WHERE user_id = ? ORDER BY organization_id`,
    )
      .bind(identity?.user_id ?? options.userId)
      .all<{ id: string; organization_id: string; role: string }>();
    const memberships = (recorded.results || [])
      .filter(
        (row) =>
          !testRemovedOrganizationMemberships.has(
            testOrganizationMembershipKey(row.organization_id, options.userId),
          ),
      )
      .map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        userId: options.userId,
        status: "active" as const,
        roleSlugs: [
          testOrganizationMembershipRoles.get(
            testOrganizationMembershipKey(row.organization_id, options.userId),
          ) ?? row.role,
        ],
      }));
    return { memberships, after: null };
  }

  const list = await getWorkOS(env).userManagement.listOrganizationMemberships({
    userId: options.userId,
    statuses: ["active", "pending"],
    limit: 100,
    after: options.after || undefined,
  });
  if (!Array.isArray(list.data)) {
    throw new Error("WorkOS returned a malformed membership list");
  }
  return {
    memberships: list.data.map((membership) => ({
      id: membership.id,
      organizationId: membership.organizationId,
      userId: membership.userId,
      status: membership.status,
      roleSlugs: membershipRoleSlugs(membership),
    })),
    after: list.listMetadata?.after || null,
  };
}

/**
 * Creates the person's WorkOS membership of the organization, or continues
 * with the one WorkOS already has. Without this, a join whose membership
 * WorkOS created but that failed to record it locally would be refused as a
 * duplicate on every retry. When creating fails and WorkOS has no membership
 * either, the create error is thrown.
 */
export async function createOrFindWorkOSOrganizationMembership(
  env: Env,
  options: { organizationId: string; userId: string; roleSlug?: string },
): Promise<WorkOSMembership> {
  try {
    return await createWorkOSOrganizationMembership(env, options);
  } catch (error) {
    const existing = await findWorkOSOrganizationMembership(env, options).catch(
      () => null,
    );
    if (existing) return existing;
    throw error;
  }
}

export async function createWorkOSTeam(
  env: Env,
  options: {
    organizationId: string;
    name: string;
    description?: string | null;
  },
): Promise<WorkOSTeam> {
  if (env.SHIPLET_AUTH_MODE === "test") {
    return {
      id: `team_${slug(options.organizationId)}_${slug(options.name)}`,
      name: options.name,
      description: options.description || null,
    };
  }

  const group = await getWorkOS(env).groups.createGroup({
    organizationId: options.organizationId,
    name: options.name,
    description: options.description || undefined,
  });
  return {
    id: group.id,
    name: group.name,
    description: group.description,
  };
}

export async function addWorkOSMembershipToTeam(
  env: Env,
  options: {
    organizationId: string;
    teamId: string;
    organizationMembershipId: string;
  },
) {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const issued = [...testOrganizationMemberships.values()].some(
      (membership) =>
        membership.organizationId === options.organizationId &&
        membership.id === options.organizationMembershipId,
    );
    if (!issued) throw new Error("Organization membership not found");
    const members =
      testTeamMembershipIds.get(options.teamId) ?? new Set<string>();
    members.add(options.organizationMembershipId);
    testTeamMembershipIds.set(options.teamId, members);
    return;
  }

  await getWorkOS(env).groups.addOrganizationMembership({
    organizationId: options.organizationId,
    groupId: options.teamId,
    organizationMembershipId: options.organizationMembershipId,
  });
}

export async function sendWorkOSInvitation(
  env: Env,
  options: {
    email: string;
    organizationId?: string;
    roleSlug?: string;
    inviterUserId?: string;
  },
): Promise<WorkOSInvitation> {
  if (env.SHIPLET_AUTH_MODE === "test") {
    const id = newId("inv");
    const token = `tok_${slug(options.email)}_${id.slice(-8)}`;
    const invitation = serializeInvitation({
      id,
      email: options.email,
      organizationId: options.organizationId,
      token,
      acceptInvitationUrl: `/auth/login?invitation_token=${encodeURIComponent(token)}`,
      state: options.email === "accepted@example.com" ? "accepted" : "pending",
      acceptedAt:
        options.email === "accepted@example.com"
          ? new Date().toISOString()
          : null,
      acceptedUserId:
        options.email === "accepted@example.com" ? "user_accepted" : null,
    });
    testInvitations.set(id, invitation);
    return invitation;
  }

  const invitation = await getWorkOS(env).userManagement.sendInvitation({
    email: options.email,
    organizationId: options.organizationId,
    roleSlug: options.roleSlug,
    inviterUserId: options.inviterUserId,
  });

  return serializeInvitation(invitation);
}

/** Test mode's WorkOS stand-in, for tests to inspect and change. */
export const workosTestDouble = {
  teamMembershipIds(teamId: string) {
    return [...(testTeamMembershipIds.get(teamId) ?? [])];
  },
  /** Simulates an administrator removing the person in WorkOS. */
  removeOrganizationMembership(organizationId: string, userId: string) {
    const key = testOrganizationMembershipKey(organizationId, userId);
    testRemovedOrganizationMemberships.add(key);
    testOrganizationMemberships.delete(key);
  },
  /** Simulates an administrator changing the person's role in WorkOS. */
  setOrganizationMembershipRole(
    organizationId: string,
    userId: string,
    roleSlug: string,
  ) {
    testOrganizationMembershipRoles.set(
      testOrganizationMembershipKey(organizationId, userId),
      roleSlug,
    );
  },
  /** Makes WorkOS fail to list the person's memberships. */
  setMembershipListingFailure(userId: string, failing: boolean) {
    if (failing) testFailingMembershipListings.add(userId);
    else testFailingMembershipListings.delete(userId);
  },
  /** Makes WorkOS never answer a listing of the person's memberships. */
  setMembershipListingHang(userId: string, hanging: boolean) {
    if (hanging) testHangingMembershipListings.add(userId);
    else testHangingMembershipListings.delete(userId);
  },
  /** Makes WorkOS fail to look up the person's membership of one organization. */
  setMembershipLookupFailure(userId: string, failing: boolean) {
    if (failing) testFailingMembershipLookups.add(userId);
    else testFailingMembershipLookups.delete(userId);
  },
  /** The WorkOS user IDs whose memberships were listed, in order. */
  membershipListings() {
    return [...testMembershipListings];
  },
};
