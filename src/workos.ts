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
    return { id: `om_${slug(options.organizationId)}_${slug(options.userId)}` };
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
