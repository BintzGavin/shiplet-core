import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  consumeInviteLinkUse,
  decrementInviteLinkUse,
  loadWorkspaceInviteLinksSeed,
  recordInviteLinkRedemption,
} from "../src/organization-invite-links";
import {
  INVITE_LINK_MAX_ALLOWED_EMAILS,
  INVITE_LINK_MAX_EXPIRES_IN_DAYS,
  INVITE_LINK_MAX_USES_LIMIT,
  inviteLinkEndpoint,
  inviteLinksEndpoint,
  joinPath,
  type InviteLinkListResponse,
  type InviteLinkResponse,
  type InviteLinkView,
} from "../src/platform/invite-links-types";

type Actor = {
  "x-shiplet-user-id": string;
  "x-shiplet-user-email": string;
};

type FeatureFlagEnv = { SHIPLET_ENABLED_FEATURE_FLAGS?: string };

const OWNER: Actor = {
  "x-shiplet-user-id": "user_invite_links_owner",
  "x-shiplet-user-email": "invite-links-owner@example.com",
};

const JSON_HEADERS = { "Content-Type": "application/json" };

// Mirrors the credential-key guard in test/index.spec.ts: no response key may
// look like a token, code, or other credential.
const CREDENTIAL_KEY_PATTERN =
  /"(?:token|code|[^"]*(?:access[_-]?token|refresh[_-]?token|invitation[_-]?token|oauth[_-]?token|authorization(?:[_-]?(?:code|header))?|credential|password|secret|claim[_-]?url)[^"]*)"\s*:/i;

function db() {
  return (env as Env).DB;
}

function person(label: string): Actor {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    "x-shiplet-user-id": `user_invite_links_${label}_${suffix}`,
    "x-shiplet-user-email": `invite-links-${label}-${suffix}@example.com`,
  };
}

function userId(actor: Actor) {
  return actor["x-shiplet-user-id"];
}

function email(actor: Actor) {
  return actor["x-shiplet-user-email"];
}

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    env as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function withFeatureFlags<T>(flags: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as FeatureFlagEnv;
  const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
  testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = flags;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
  }
}

async function createOrganization(actor: Actor = OWNER) {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify({ name: `Invite links ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as {
    organization: { id: string; name: string };
  }).organization;
}

async function createTeam(organizationId: string, actor: Actor = OWNER) {
  const response = await request(`/api/organizations/${organizationId}/teams`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify({ name: `Design ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { team: { id: string; name: string } })
    .team;
}

async function postLink(
  organizationId: string,
  body: unknown,
  actor: Partial<Actor> = OWNER,
) {
  return request(inviteLinksEndpoint(organizationId), {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify(body),
  });
}

async function createLink(
  organizationId: string,
  body: Record<string, unknown> = {},
  actor: Actor = OWNER,
) {
  const response = await postLink(organizationId, body, actor);
  expect(response.status).toBe(201);
  return ((await response.json()) as InviteLinkResponse).link;
}

async function listLinks(organizationId: string) {
  const response = await request(inviteLinksEndpoint(organizationId), {
    headers: OWNER,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as InviteLinkListResponse).links;
}

async function findLink(organizationId: string, linkId: string) {
  const link = (await listLinks(organizationId)).find(
    (candidate) => candidate.id === linkId,
  );
  expect(link).toBeTruthy();
  return link as InviteLinkView;
}

async function revokeLink(organizationId: string, linkId: string) {
  return request(inviteLinkEndpoint(organizationId, linkId), {
    method: "DELETE",
    headers: OWNER,
  });
}

function tokenOf(link: InviteLinkView) {
  return new URL(link.url).pathname.split("/").pop() as string;
}

async function openJoinPage(token: string, actor?: Actor) {
  return request(joinPath(token), actor ? { headers: actor } : {});
}

async function acceptInvitation(token: string, actor: Actor) {
  return request(joinPath(token), { method: "POST", headers: actor });
}

async function membershipRole(organizationId: string, actor: Actor) {
  const row = await db()
    .prepare(
      `SELECT role FROM organization_memberships
       WHERE organization_id = ? AND user_id = ?`,
    )
    .bind(organizationId, userId(actor))
    .first<{ role: string }>();
  return row?.role ?? null;
}

async function inTeam(teamId: string, actor: Actor) {
  const row = await db()
    .prepare(
      "SELECT team_id FROM team_memberships WHERE team_id = ? AND user_id = ?",
    )
    .bind(teamId, userId(actor))
    .first<{ team_id: string }>();
  return Boolean(row);
}

async function withFailingInsert<T>(
  table: "organization_memberships" | "team_memberships",
  actor: Actor,
  callback: () => Promise<T>,
) {
  const trigger = `test_invite_link_failure_${crypto.randomUUID().replace(/-/g, "")}`;
  await db()
    .prepare(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table}
       WHEN NEW.user_id = '${userId(actor)}'
       BEGIN SELECT RAISE(ABORT, 'forced invite link test failure'); END`,
    )
    .run();
  try {
    return await callback();
  } finally {
    await db().prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  }
}

/**
 * Runs `callback` with temporary triggers installed. Each definition is the
 * rest of a CREATE TRIGGER statement after the trigger's name.
 */
async function withTriggers<T>(
  definitions: readonly string[],
  callback: () => Promise<T>,
) {
  const names = definitions.map(
    () => `test_invite_link_trigger_${crypto.randomUUID().replace(/-/g, "")}`,
  );
  try {
    for (const [index, definition] of definitions.entries()) {
      await db().prepare(`CREATE TRIGGER ${names[index]} ${definition}`).run();
    }
    return await callback();
  } finally {
    for (const name of names) {
      await db().prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
    }
  }
}

async function storedUseCount(linkId: string) {
  const row = await db()
    .prepare("SELECT use_count FROM organization_invite_links WHERE id = ?")
    .bind(linkId)
    .first<{ use_count: number }>();
  return row?.use_count;
}

async function storedRedemptions(linkId: string) {
  const rows = await db()
    .prepare(
      `SELECT id, user_id FROM organization_invite_link_redemptions
       WHERE link_id = ? ORDER BY user_id`,
    )
    .bind(linkId)
    .all<{ id: string; user_id: string }>();
  return rows.results;
}

// A "twin" is a second, concurrent submit by the same person. These helpers
// play the twin's writes directly in D1, so a test can place them anywhere
// in the submit under test.
async function takeUseAsTwin(linkId: string) {
  await db()
    .prepare(
      "UPDATE organization_invite_links SET use_count = use_count + 1 WHERE id = ?",
    )
    .bind(linkId)
    .run();
}

function twinRedemptionId(actor: Actor) {
  return `invlinkuse_twin_${userId(actor)}`;
}

/** The twin's redemption insert; also usable inside a trigger body. */
function twinRedemptionSql(link: InviteLinkView, actor: Actor) {
  return `INSERT OR IGNORE INTO organization_invite_link_redemptions
    (id, link_id, organization_id, user_id, email, redeemed_on)
    VALUES ('${twinRedemptionId(actor)}', '${link.id}', '${link.organization_id}',
      '${userId(actor)}', '${email(actor)}', '${new Date().toISOString()}')`;
}

async function recordAsTwin(link: InviteLinkView, actor: Actor) {
  await db().prepare(twinRedemptionSql(link, actor)).run();
}

function hrefs(html: string) {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
    match[1].replace(/&amp;/g, "&"),
  );
}

function loginHref(html: string) {
  const href = hrefs(html).find((value) => value.startsWith("/auth/login?"));
  expect(href).toBeTruthy();
  return new URL(href as string, "http://localhost");
}

function expectCredentialFreeInvitationPayload(value: unknown) {
  const visit = (current: unknown) => {
    if (Array.isArray(current)) return current.forEach(visit);
    if (!current || typeof current !== "object") return;
    for (const [key, item] of Object.entries(current)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      expect(normalized).not.toMatch(
        /(?:accesstoken|refreshtoken|invitationtoken|oauthtoken|authorizationcode|authorizationheader|credential|password|secret|claimurl)/,
      );
      expect(normalized).not.toBe("token");
      visit(item);
    }
  };
  visit(value);
}

describe("organization invite link administration", () => {
  it("lets an administrator create an organization-wide link with a shareable join URL", async () => {
    const organization = await createOrganization();

    const response = await postLink(organization.id, {});

    expect(response.status).toBe(201);
    const text = await response.clone().text();
    const { link } = (await response.json()) as InviteLinkResponse;
    expect(link.url).toMatch(/^https:\/\/shiplet\.cc\/join\/[A-Za-z0-9_-]{32}$/);
    expect(link).toMatchObject({
      organization_id: organization.id,
      team_id: null,
      team_name: null,
      max_uses: null,
      use_count: 0,
      allowed_emails: [],
      expires_on: null,
      revoked_on: null,
      status: "active",
      redemptions: [],
      created_by: { id: userId(OWNER), email: email(OWNER) },
    });
    expect(Date.parse(link.created_on)).not.toBeNaN();
    expectCredentialFreeInvitationPayload(JSON.parse(text));
    expect(text).not.toMatch(CREDENTIAL_KEY_PATTERN);
  });

  it("creates a team link and refuses a team from another organization", async () => {
    const organization = await createOrganization();
    const team = await createTeam(organization.id);
    const otherOrganization = await createOrganization();
    const otherTeam = await createTeam(otherOrganization.id);

    const link = await createLink(organization.id, { teamId: team.id });
    expect(link.team_id).toBe(team.id);
    expect(link.team_name).toBe(team.name);

    const foreignTeam = await postLink(organization.id, {
      teamId: otherTeam.id,
    });
    expect(foreignTeam.status).toBe(404);
    expect(await foreignTeam.text()).toBe("Team not found");
    expect((await listLinks(organization.id)).map((item) => item.id)).toEqual([
      link.id,
    ]);
  });

  it("rejects invalid use limits, expiry, and email restrictions without creating links", async () => {
    const organization = await createOrganization();

    for (const maxUses of [0, -1, 1.5, "abc", INVITE_LINK_MAX_USES_LIMIT + 1]) {
      const response = await postLink(organization.id, { maxUses });
      expect(response.status, `maxUses ${String(maxUses)}`).toBe(400);
    }
    for (const expiresInDays of [0, 2.5, INVITE_LINK_MAX_EXPIRES_IN_DAYS + 1]) {
      const response = await postLink(organization.id, { expiresInDays });
      expect(response.status, `expiresInDays ${expiresInDays}`).toBe(400);
    }
    const invalidEmail = await postLink(organization.id, {
      allowedEmails: ["not-an-email"],
    });
    expect(invalidEmail.status).toBe(400);
    expect(await invalidEmail.text()).toContain("not-an-email");
    const tooMany = await postLink(organization.id, {
      allowedEmails: Array.from(
        { length: INVITE_LINK_MAX_ALLOWED_EMAILS + 1 },
        (_, index) => `person-${index}@example.com`,
      ),
    });
    expect(tooMany.status).toBe(400);
    const notAnObject = await postLink(organization.id, ["maxUses", 1]);
    expect(notAnObject.status).toBe(400);
    expect(await listLinks(organization.id)).toEqual([]);

    const normalized = await createLink(organization.id, {
      allowedEmails: "A@Example.com, b@example.com\nA@example.com",
    });
    expect(normalized.allowed_emails).toEqual([
      "a@example.com",
      "b@example.com",
    ]);

    const before = Date.now();
    const limited = await createLink(organization.id, {
      maxUses: INVITE_LINK_MAX_USES_LIMIT,
      expiresInDays: 7,
    });
    expect(limited.max_uses).toBe(INVITE_LINK_MAX_USES_LIMIT);
    const expiresAt = Date.parse(limited.expires_on as string);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 1_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 1_000);
    expect(limited.status).toBe("active");
  });

  it("allows only organization administrators to list, create, and revoke links", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id);
    const member = person("member");
    const outsider = person("outsider");
    expect((await acceptInvitation(tokenOf(link), member)).status).toBe(303);
    expect(await membershipRole(organization.id, member)).toBe("member");

    for (const actor of [member, outsider]) {
      const list = await request(inviteLinksEndpoint(organization.id), {
        headers: actor,
      });
      expect(list.status).toBe(403);
      const create = await postLink(organization.id, {}, actor);
      expect(create.status).toBe(403);
      const revoke = await request(inviteLinkEndpoint(organization.id, link.id), {
        method: "DELETE",
        headers: actor,
      });
      expect(revoke.status).toBe(403);
    }

    const signedOutList = await request(inviteLinksEndpoint(organization.id));
    expect(signedOutList.status).toBe(401);
    const signedOutCreate = await postLink(organization.id, {}, {});
    expect(signedOutCreate.status).toBe(401);
    const signedOutRevoke = await request(
      inviteLinkEndpoint(organization.id, link.id),
      { method: "DELETE" },
    );
    expect(signedOutRevoke.status).toBe(401);

    const links = await listLinks(organization.id);
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe("active");
    const denied = await db()
      .prepare(
        `SELECT actor_id, action FROM kernel_admin_audit_events
         WHERE organization_id = ? AND outcome = 'denied'
           AND action LIKE 'organization_invite_link.%'`,
      )
      .bind(organization.id)
      .all<{ actor_id: string; action: string }>();
    expect(denied.results).toEqual(
      expect.arrayContaining([
        { actor_id: userId(member), action: "organization_invite_link.list" },
        { actor_id: userId(member), action: "organization_invite_link.create" },
        { actor_id: userId(outsider), action: "organization_invite_link.revoke" },
      ]),
    );
  });

  it("lists links newest first with their redemptions and revokes idempotently", async () => {
    const organization = await createOrganization();
    const first = await createLink(organization.id);
    const second = await createLink(organization.id, { maxUses: 3 });
    const joiner = person("listed");
    expect((await acceptInvitation(tokenOf(first), joiner)).status).toBe(303);

    const links = await listLinks(organization.id);
    expect(links.map((link) => link.id)).toEqual([second.id, first.id]);
    expect(links[1].use_count).toBe(1);
    expect(links[1].redemptions).toEqual([
      {
        user_id: userId(joiner),
        email: email(joiner),
        redeemed_on: expect.any(String),
      },
    ]);
    expect(links[0].redemptions).toEqual([]);
    expect(links[1].url).toBe(first.url);

    const revoked = await revokeLink(organization.id, first.id);
    expect(revoked.status).toBe(200);
    const { link } = (await revoked.json()) as InviteLinkResponse;
    expect(link.id).toBe(first.id);
    expect(link.status).toBe("revoked");
    expect(link.revoked_on).toEqual(expect.any(String));
    expect(link.redemptions).toHaveLength(1);

    const revokedAgain = await revokeLink(organization.id, first.id);
    expect(revokedAgain.status).toBe(200);
    const again = ((await revokedAgain.json()) as InviteLinkResponse).link;
    expect(again.status).toBe("revoked");
    expect(again.revoked_on).toBe(link.revoked_on);

    const otherOrganization = await createOrganization();
    const foreign = await createLink(otherOrganization.id);
    const crossOrganization = await revokeLink(organization.id, foreign.id);
    expect(crossOrganization.status).toBe(404);
    expect((await findLink(otherOrganization.id, foreign.id)).status).toBe(
      "active",
    );
    const unknown = await revokeLink(organization.id, "invlink_missing");
    expect(unknown.status).toBe(404);
  });
});

describe("invite link join page", () => {
  it("shows signed-out visitors the organization and a sign-in step without joining anyone", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id);
    const token = tokenOf(link);

    const response = await openJoinPage(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    const html = await response.text();
    expect(html).toContain(`Join ${organization.name}`);
    expect(html).toContain("Sign in to continue");
    expect(html).not.toContain("Accept invitation");
    const login = loginHref(html);
    expect(login.pathname).toBe("/auth/login");
    expect(login.searchParams.get("return_to")).toBe(`/join/${token}`);

    const memberships = await db()
      .prepare(
        "SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id = ?",
      )
      .bind(organization.id)
      .first<{ count: number }>();
    expect(memberships?.count).toBe(1);
    expect((await findLink(organization.id, link.id)).use_count).toBe(0);
  });

  it("reports unknown and malformed links as not valid", async () => {
    const unknownToken = "A".repeat(32);
    const unknown = await openJoinPage(unknownToken);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("isn't valid");

    const malformed = await openJoinPage("not-a-real-token");
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toContain("isn't valid");

    const accept = await acceptInvitation(unknownToken, person("unknown"));
    expect(accept.status).toBe(404);
    expect(await accept.text()).toContain("isn't valid");
  });

  it("sends signed-out accept attempts to sign in and back to the link", async () => {
    const organization = await createOrganization();
    const token = tokenOf(await createLink(organization.id));

    const response = await request(joinPath(token), { method: "POST" });

    expect(response.status).toBe(302);
    const location = new URL(
      response.headers.get("location") as string,
      "http://localhost",
    );
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("return_to")).toBe(`/join/${token}`);
  });

  it("joins a new person as a member through one accept action without consuming a second use", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id);
    const token = tokenOf(link);
    const joiner = person("joiner");

    const page = await openJoinPage(token, joiner);
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain(`Join ${organization.name}`);
    expect(pageHtml).toContain(`<strong>${email(joiner)}</strong>`);
    expect(pageHtml).toContain(`action="/join/${token}"`);
    expect(pageHtml).toContain("Accept invitation");
    expect(pageHtml).toContain("Not you? Sign out");
    expect(await membershipRole(organization.id, joiner)).toBeNull();

    const accepted = await acceptInvitation(token, joiner);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe(`/join/${token}`);

    const dashboard = await request("/api/dashboard", { headers: joiner });
    expect(dashboard.status).toBe(200);
    const dashboardBody = (await dashboard.json()) as {
      organizations: Array<{ id: string }>;
      organizationRolesByOrganization: Record<string, string>;
    };
    expect(dashboardBody.organizations.map((org) => org.id)).toContain(
      organization.id,
    );
    expect(dashboardBody.organizationRolesByOrganization[organization.id]).toBe(
      "member",
    );

    const afterJoin = await findLink(organization.id, link.id);
    expect(afterJoin.use_count).toBe(1);
    expect(afterJoin.redemptions.map((redemption) => redemption.email)).toEqual([
      email(joiner),
    ]);

    const repeated = await acceptInvitation(token, joiner);
    expect(repeated.status).toBe(303);
    expect(repeated.headers.get("location")).toBe(`/join/${token}`);
    expect((await findLink(organization.id, link.id)).use_count).toBe(1);

    const joined = await openJoinPage(token, joiner);
    expect(joined.status).toBe(200);
    const joinedHtml = await joined.text();
    expect(joinedHtml).toContain("You're in");
    expect(joinedHtml).toContain(
      `You're a member of ${organization.name}.`,
    );
    expect(joinedHtml).not.toContain("Accept invitation");
  });

  it("adds a new person to the team named by a team link as a member", async () => {
    const organization = await createOrganization();
    const team = await createTeam(organization.id);
    const link = await createLink(organization.id, { teamId: team.id });
    const token = tokenOf(link);
    const joiner = person("team-joiner");

    const page = await openJoinPage(token, joiner);
    expect(await page.text()).toContain(
      `You'll be added to the ${team.name} team.`,
    );

    expect((await acceptInvitation(token, joiner)).status).toBe(303);

    expect(await inTeam(team.id, joiner)).toBe(true);
    expect(await membershipRole(organization.id, joiner)).toBe("member");
    const joined = await (await openJoinPage(token, joiner)).text();
    expect(joined).toContain("You're in");
    expect(joined).toContain(
      `You're a member of ${organization.name} and the ${team.name} team.`,
    );
    expect((await findLink(organization.id, link.id)).use_count).toBe(1);
  });

  it("adds existing members to a team without consuming organization links", async () => {
    const organization = await createOrganization();
    const team = await createTeam(organization.id);
    const organizationLink = await createLink(organization.id);
    const secondOrganizationLink = await createLink(organization.id);
    const teamLink = await createLink(organization.id, { teamId: team.id });
    const member = person("existing");
    expect(
      (await acceptInvitation(tokenOf(organizationLink), member)).status,
    ).toBe(303);
    expect(await inTeam(team.id, member)).toBe(false);

    const page = await openJoinPage(tokenOf(teamLink), member);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Accept invitation");

    const joinedTeam = await acceptInvitation(tokenOf(teamLink), member);
    expect(joinedTeam.status).toBe(303);
    expect(await inTeam(team.id, member)).toBe(true);
    expect(await membershipRole(organization.id, member)).toBe("member");
    expect((await findLink(organization.id, teamLink.id)).use_count).toBe(1);

    const alreadyMember = await acceptInvitation(
      tokenOf(secondOrganizationLink),
      member,
    );
    expect(alreadyMember.status).toBe(303);
    const unused = await findLink(organization.id, secondOrganizationLink.id);
    expect(unused.use_count).toBe(0);
    expect(unused.redemptions).toEqual([]);

    // The owner created the team, so the team link has nothing left to grant.
    expect((await acceptInvitation(tokenOf(teamLink), OWNER)).status).toBe(303);
    expect((await findLink(organization.id, teamLink.id)).use_count).toBe(1);
    expect(await membershipRole(organization.id, OWNER)).toBe("admin");
  });

  it("stops a limited link after its last use while earlier joiners keep access", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    const first = person("first");
    const second = person("second");

    expect((await acceptInvitation(token, first)).status).toBe(303);

    const page = await openJoinPage(token, second);
    expect(page.status).toBe(410);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("no longer active");
    expect(pageHtml).toContain(
      "The link has already been used the maximum number of times.",
    );
    expect(pageHtml).not.toContain("Accept invitation");
    const refused = await acceptInvitation(token, second);
    expect(refused.status).toBe(410);
    expect(await refused.text()).toContain("no longer active");
    expect(await membershipRole(organization.id, second)).toBeNull();

    const firstPage = await openJoinPage(token, first);
    expect(firstPage.status).toBe(200);
    expect(await firstPage.text()).toContain("You're in");

    const exhausted = await findLink(organization.id, link.id);
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.use_count).toBe(1);
    expect(exhausted.redemptions).toHaveLength(1);
  });

  it("never records a redemption for a person refused by a used-up link", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    expect((await acceptInvitation(token, person("holder"))).status).toBe(303);
    const latecomer = person("latecomer");
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const log = `test_invite_link_insert_log_${suffix}`;
    const trigger = `test_invite_link_insert_trigger_${suffix}`;
    await db()
      .prepare(`CREATE TABLE ${log} (link_id TEXT NOT NULL, user_id TEXT NOT NULL)`)
      .run();
    await db()
      .prepare(
        `CREATE TRIGGER ${trigger} AFTER INSERT ON organization_invite_link_redemptions
         WHEN NEW.user_id = '${userId(latecomer)}'
         BEGIN INSERT INTO ${log} (link_id, user_id) VALUES (NEW.link_id, NEW.user_id); END`,
      )
      .run();
    try {
      // A redemption row is never deleted and stands for a counted use, and a
      // concurrent second submit by the same person would reuse it to skip
      // the use limit, so a refused person must never write one.
      const refused = await acceptInvitation(token, latecomer);
      expect(refused.status).toBe(410);
      const inserts = await db()
        .prepare(`SELECT COUNT(*) AS count FROM ${log}`)
        .first<{ count: number }>();
      expect(inserts?.count).toBe(0);
    } finally {
      await db().prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
      await db().prepare(`DROP TABLE IF EXISTS ${log}`).run();
    }
    expect(await membershipRole(organization.id, latecomer)).toBeNull();
    expect((await findLink(organization.id, link.id)).use_count).toBe(1);
  });

  it("refuses revoked and expired links to new people but not to existing members", async () => {
    const organization = await createOrganization();
    const revokedLink = await createLink(organization.id);
    const earlyJoiner = person("early");
    expect(
      (await acceptInvitation(tokenOf(revokedLink), earlyJoiner)).status,
    ).toBe(303);
    expect((await revokeLink(organization.id, revokedLink.id)).status).toBe(200);
    const late = person("late");

    const revokedPage = await openJoinPage(tokenOf(revokedLink), late);
    expect(revokedPage.status).toBe(410);
    expect(await revokedPage.text()).toContain(
      `The link was turned off by an administrator of ${organization.name}.`,
    );
    expect((await acceptInvitation(tokenOf(revokedLink), late)).status).toBe(
      410,
    );
    expect(await membershipRole(organization.id, late)).toBeNull();
    const memberView = await openJoinPage(tokenOf(revokedLink), earlyJoiner);
    expect(memberView.status).toBe(200);
    expect(await memberView.text()).toContain("You're in");

    const expiringLink = await createLink(organization.id, { expiresInDays: 1 });
    await db()
      .prepare(
        "UPDATE organization_invite_links SET expires_on = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .bind(expiringLink.id)
      .run();
    const expiredPage = await openJoinPage(tokenOf(expiringLink), late);
    expect(expiredPage.status).toBe(410);
    const expiredHtml = await expiredPage.text();
    expect(expiredHtml).toContain("no longer active");
    expect(expiredHtml).toContain("The link expired on January 1, 2000.");
    const signedOutExpired = await openJoinPage(tokenOf(expiringLink));
    expect(signedOutExpired.status).toBe(410);
    expect((await acceptInvitation(tokenOf(expiringLink), late)).status).toBe(
      410,
    );
    expect(await membershipRole(organization.id, late)).toBeNull();
    const expired = await findLink(organization.id, expiringLink.id);
    expect(expired.status).toBe("expired");
    expect(expired.use_count).toBe(0);
    expect(expired.redemptions).toEqual([]);
  });

  it("reserves a link for listed email addresses regardless of letter case", async () => {
    const organization = await createOrganization();
    const suffix = crypto.randomUUID().slice(0, 8);
    const invited: Actor = {
      "x-shiplet-user-id": `user_invite_links_invited_${suffix}`,
      "x-shiplet-user-email": `invited-${suffix}@example.com`,
    };
    const other: Actor = {
      "x-shiplet-user-id": `user_invite_links_other_${suffix}`,
      "x-shiplet-user-email": `other-${suffix}@example.com`,
    };
    const link = await createLink(organization.id, {
      allowedEmails: [`Invited-${suffix}@Example.com`],
    });
    const token = tokenOf(link);
    expect(link.allowed_emails).toEqual([`invited-${suffix}@example.com`]);

    const signedOut = await (await openJoinPage(token)).text();
    expect(signedOut).toContain(
      "This link is reserved for specific email addresses.",
    );
    expect(signedOut).not.toContain(`invited-${suffix}@example.com`);

    const wrongAccount = await openJoinPage(token, other);
    expect(wrongAccount.status).toBe(403);
    const wrongHtml = await wrongAccount.text();
    expect(wrongHtml).toContain("different email address");
    expect(wrongHtml).toContain(`You're signed in as ${email(other)}.`);
    expect(wrongHtml).not.toContain(`invited-${suffix}@example.com`);
    expect(hrefs(wrongHtml)).toContain("/auth/logout");
    const refused = await acceptInvitation(token, other);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("different email address");
    expect(await membershipRole(organization.id, other)).toBeNull();

    await withFeatureFlags("account-email-switching", async () => {
      const switching = await (await openJoinPage(token, other)).text();
      expect(switching).toContain("Use a different account");
      const switchUrl = loginHref(switching);
      expect(switchUrl.searchParams.get("account_action")).toBe("add");
      expect(switchUrl.searchParams.get("return_to")).toBe(`/join/${token}`);
    });

    expect((await acceptInvitation(token, invited)).status).toBe(303);
    expect(await membershipRole(organization.id, invited)).toBe("member");
    const joined = await findLink(organization.id, link.id);
    expect(joined.use_count).toBe(1);
    expect(joined.redemptions.map((redemption) => redemption.user_id)).toEqual([
      userId(invited),
    ]);
  });

  it("applies the origin check and kernel page headers to percent-encoded join and API paths", async () => {
    const organization = await createOrganization();
    const token = tokenOf(await createLink(organization.id));
    const foreign = {
      Origin: "https://evil.example",
      Cookie: "__Host-shiplet_session=x",
    };

    // Hono routes /%6Aoin/... to /join/:token, so it must get the same checks.
    const encodedJoin = await request(`/%6Aoin/${token}`, {
      method: "POST",
      headers: foreign,
    });
    expect(encodedJoin.status).toBe(403);
    expect(await encodedJoin.text()).toBe("Control-plane origin required");

    const encodedApi = await request(
      `/%61pi/organizations/${encodeURIComponent(organization.id)}/invite-links`,
      { method: "POST", headers: { ...foreign, ...JSON_HEADERS }, body: "{}" },
    );
    expect(encodedApi.status).toBe(403);
    expect(await encodedApi.text()).toBe("Control-plane origin required");

    const page = await request(`/%6Aoin/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    expect(page.headers.get("cache-control")).toContain("no-store");
  });

  it("escapes organization and team names on the join page", async () => {
    const organization = await createOrganization();
    const hostile = `<img src=x onerror=alert(1)> Team ${crypto.randomUUID().slice(0, 6)}`;
    const teamResponse = await request(
      `/api/organizations/${organization.id}/teams`,
      {
        method: "POST",
        headers: { ...JSON_HEADERS, ...OWNER },
        body: JSON.stringify({ name: hostile }),
      },
    );
    expect(teamResponse.status).toBe(201);
    const team = ((await teamResponse.json()) as { team: { id: string } }).team;
    const token = tokenOf(await createLink(organization.id, { teamId: team.id }));

    for (const actor of [undefined, person("escape")]) {
      const response = await openJoinPage(token, actor);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });

  it("requires the control-plane origin for cookie-authenticated accepts", async () => {
    const organization = await createOrganization();
    const token = tokenOf(await createLink(organization.id));

    const crossSite = await request(joinPath(token), {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        Cookie: "__Host-shiplet_session=x",
      },
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).toBe("Control-plane origin required");

    const joiner = person("origin");
    const sameOrigin = await request(joinPath(token), {
      method: "POST",
      headers: { Origin: "http://localhost", ...joiner },
    });
    expect(sameOrigin.status).toBe(303);
    expect(await membershipRole(organization.id, joiner)).toBe("member");
  });

  it("reserves the use for the person's retry when joining fails before any membership is granted", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    const joiner = person("reserved");
    const latecomer = person("reserved-latecomer");

    const failed = await withFailingInsert(
      "organization_memberships",
      joiner,
      () => acceptInvitation(token, joiner),
    );

    expect(failed.status).toBe(502);
    const failedHtml = await failed.text();
    expect(failedHtml).toContain("We couldn't add you just yet");
    expect(failedHtml).toContain(`action="/join/${token}"`);
    expect(failedHtml).toContain("Try again");
    expect(await membershipRole(organization.id, joiner)).toBeNull();
    // The redemption stays recorded and keeps holding the only use.
    expect(
      (await storedRedemptions(link.id)).map((row) => row.user_id),
    ).toEqual([userId(joiner)]);
    expect(await storedUseCount(link.id)).toBe(1);
    const reserved = await findLink(organization.id, link.id);
    expect(reserved).toMatchObject({
      max_uses: 1,
      use_count: 1,
      status: "exhausted",
    });
    expect(reserved.redemptions).toEqual([
      {
        user_id: userId(joiner),
        email: email(joiner),
        redeemed_on: expect.any(String),
      },
    ]);

    const refused = await acceptInvitation(token, latecomer);
    expect(refused.status).toBe(410);
    expect(await refused.text()).toContain(
      "The link has already been used the maximum number of times.",
    );
    expect(await membershipRole(organization.id, latecomer)).toBeNull();

    const retryPage = await openJoinPage(token, joiner);
    expect(retryPage.status).toBe(200);
    expect(await retryPage.text()).toContain("Accept invitation");
    const retried = await acceptInvitation(token, joiner);
    expect(retried.status).toBe(303);
    expect(retried.headers.get("location")).toBe(`/join/${token}`);
    expect(await membershipRole(organization.id, joiner)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
    expect(
      (await storedRedemptions(link.id)).map((row) => row.user_id),
    ).toEqual([userId(joiner)]);
  });

  it("keeps the use after a partial team join and finishes the team step on retry", async () => {
    const organization = await createOrganization();
    const team = await createTeam(organization.id);
    const link = await createLink(organization.id, {
      teamId: team.id,
      maxUses: 1,
    });
    const token = tokenOf(link);
    const joiner = person("partial");

    const failed = await withFailingInsert("team_memberships", joiner, () =>
      acceptInvitation(token, joiner),
    );

    expect(failed.status).toBe(502);
    expect(await membershipRole(organization.id, joiner)).toBe("member");
    expect(await inTeam(team.id, joiner)).toBe(false);
    const kept = await findLink(organization.id, link.id);
    expect(kept.use_count).toBe(1);
    expect(kept.redemptions.map((redemption) => redemption.user_id)).toEqual([
      userId(joiner),
    ]);
    const retryPage = await openJoinPage(token, joiner);
    expect(retryPage.status).toBe(200);
    expect(await retryPage.text()).toContain("Accept invitation");

    expect((await acceptInvitation(token, joiner)).status).toBe(303);
    expect(await inTeam(team.id, joiner)).toBe(true);
    expect((await findLink(organization.id, link.id)).use_count).toBe(1);
  });

  it("does not let an earlier redemption finish joining through a revoked link", async () => {
    const organization = await createOrganization();
    const team = await createTeam(organization.id);
    const link = await createLink(organization.id, { teamId: team.id });
    const token = tokenOf(link);
    const joiner = person("revoked-retry");
    const failed = await withFailingInsert("team_memberships", joiner, () =>
      acceptInvitation(token, joiner),
    );
    expect(failed.status).toBe(502);
    expect(await membershipRole(organization.id, joiner)).toBe("member");

    expect((await revokeLink(organization.id, link.id)).status).toBe(200);
    const retry = await acceptInvitation(token, joiner);

    expect(retry.status).toBe(410);
    expect(await retry.text()).toContain(
      `The link was turned off by an administrator of ${organization.name}.`,
    );
    expect(await inTeam(team.id, joiner)).toBe(false);
    expect(await membershipRole(organization.id, joiner)).toBe("member");
  });

  it("keeps /join on the platform even when a Shiplet uses the join subdomain", async () => {
    const organization = await createOrganization();
    const token = tokenOf(await createLink(organization.id));
    const existing = await db()
      .prepare("SELECT id FROM projects WHERE subdomain = 'join'")
      .first<{ id: string }>();
    if (!existing) {
      // Publishing does not reserve platform path names as subdomains today.
      const published = await request("/api/shiplets", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...OWNER },
        body: JSON.stringify({
          name: "Join lookalike",
          organization_id: organization.id,
          subdomain: "join",
          visibility: "public",
          assets: [{ path: "index.html", content: btoa("<h1>Not Shiplet</h1>") }],
        }),
      });
      expect(published.status).toBe(201);
    }

    const response = await openJoinPage(token);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Sign in to continue");
    expect(html).not.toContain("Not Shiplet");
  });
});

describe("invite link use limits under repeated and concurrent submits", () => {
  it("takes the use before it records the redemption for a new joiner", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 2 });
    const joiner = person("ordered");
    const log = `test_invite_link_write_log_${crypto.randomUUID().replace(/-/g, "")}`;
    await db().prepare(`CREATE TABLE ${log} (write TEXT NOT NULL)`).run();
    try {
      const accepted = await withTriggers(
        [
          `AFTER UPDATE OF use_count ON organization_invite_links
           WHEN NEW.id = '${link.id}'
           BEGIN INSERT INTO ${log} (write)
             VALUES ('use ' || OLD.use_count || ' -> ' || NEW.use_count); END`,
          `AFTER INSERT ON organization_invite_link_redemptions
           WHEN NEW.link_id = '${link.id}'
           BEGIN INSERT INTO ${log} (write)
             VALUES ('redemption for ' || NEW.user_id); END`,
        ],
        () => acceptInvitation(tokenOf(link), joiner),
      );

      const writes = await db()
        .prepare(`SELECT write FROM ${log} ORDER BY rowid`)
        .all<{ write: string }>();
      expect(writes.results.map((row) => row.write)).toEqual([
        "use 0 -> 1",
        `redemption for ${userId(joiner)}`,
      ]);
      expect(accepted.status).toBe(303);
    } finally {
      await db().prepare(`DROP TABLE IF EXISTS ${log}`).run();
    }
    expect(await membershipRole(organization.id, joiner)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
  });

  it("joins a person whose twin submit already took and recorded their use without taking another", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    const twin = person("twin-won");
    const other = person("twin-other");
    // The twin took the only use and recorded the redemption, but has not
    // added the membership yet.
    await takeUseAsTwin(link.id);
    await recordAsTwin(link, twin);

    const accepted = await acceptInvitation(token, twin);

    expect(accepted.status).toBe(303);
    expect(await membershipRole(organization.id, twin)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
    expect(await storedRedemptions(link.id)).toEqual([
      { id: twinRedemptionId(twin), user_id: userId(twin) },
    ]);
    const refused = await acceptInvitation(token, other);
    expect(refused.status).toBe(410);
    expect(await membershipRole(organization.id, other)).toBeNull();
    expect(await storedUseCount(link.id)).toBe(1);
  });

  it("gives back the extra use when a twin submit records the redemption first", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 2 });
    const twin = person("twin-first");
    // The twin took a use a moment earlier and records the redemption right
    // after this submit takes its own use.
    await takeUseAsTwin(link.id);

    const accepted = await withTriggers(
      [
        `AFTER UPDATE OF use_count ON organization_invite_links
         WHEN NEW.id = '${link.id}' AND NEW.use_count > OLD.use_count
         BEGIN ${twinRedemptionSql(link, twin)}; END`,
      ],
      () => acceptInvitation(tokenOf(link), twin),
    );

    expect(accepted.status).toBe(303);
    expect(await membershipRole(organization.id, twin)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
    expect(await storedRedemptions(link.id)).toEqual([
      { id: twinRedemptionId(twin), user_id: userId(twin) },
    ]);
  });

  it("leaves the twin's redemption and use in place when joining fails after the extra use is given back", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 2 });
    const token = tokenOf(link);
    const twin = person("twin-then-failure");
    // The twin took a use a moment earlier and records the redemption right
    // after this submit takes its own use; then this submit's join fails.
    await takeUseAsTwin(link.id);

    const failed = await withFailingInsert(
      "organization_memberships",
      twin,
      () =>
        withTriggers(
          [
            `AFTER UPDATE OF use_count ON organization_invite_links
             WHEN NEW.id = '${link.id}' AND NEW.use_count > OLD.use_count
             BEGIN ${twinRedemptionSql(link, twin)}; END`,
          ],
          () => acceptInvitation(token, twin),
        ),
    );

    // This submit recorded nothing and already gave its extra use back, and
    // its failure leaves the twin's redemption and counted use alone.
    expect(failed.status).toBe(502);
    expect(await membershipRole(organization.id, twin)).toBeNull();
    expect(await storedUseCount(link.id)).toBe(1);
    expect(await storedRedemptions(link.id)).toEqual([
      { id: twinRedemptionId(twin), user_id: userId(twin) },
    ]);

    expect((await acceptInvitation(token, twin)).status).toBe(303);
    expect(await membershipRole(organization.id, twin)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
  });

  it("sends a failed submit to the joined page when its twin finished the join", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    const twin = person("twin-finished");
    const other = person("twin-finished-other");
    const twinMembershipId = `om_twin_${userId(twin)}`;

    // This submit takes the only use and records the redemption, then its
    // membership write fails. The twin saw that redemption, so it took no
    // use, and its membership write lands while this submit handles the
    // failure.
    const response = await withTriggers(
      [
        `BEFORE INSERT ON organization_memberships
         WHEN NEW.user_id = '${userId(twin)}' AND NEW.id <> '${twinMembershipId}'
         BEGIN SELECT RAISE(ABORT, 'forced invite link test failure'); END`,
        `AFTER INSERT ON kernel_admin_audit_events
         WHEN NEW.actor_id = '${userId(twin)}'
           AND NEW.action = 'organization_invite_link.redeem'
           AND NEW.outcome = 'failed'
         BEGIN INSERT INTO organization_memberships
           (id, organization_id, user_id, role, created_on)
           VALUES ('${twinMembershipId}', '${organization.id}',
             '${userId(twin)}', 'member', '${new Date().toISOString()}'); END`,
      ],
      () => acceptInvitation(token, twin),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/join/${token}`);
    expect(await membershipRole(organization.id, twin)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
    expect(
      (await storedRedemptions(link.id)).map((row) => row.user_id),
    ).toEqual([userId(twin)]);
    const refused = await acceptInvitation(token, other);
    expect(refused.status).toBe(410);
    expect(await membershipRole(organization.id, other)).toBeNull();
    expect(await storedUseCount(link.id)).toBe(1);
  });

  it("returns a use to the link when a submit that took one finds its twin's redemption recorded", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 3 });
    const twin = person("store-twin");
    await takeUseAsTwin(link.id);
    await recordAsTwin(link, twin);
    const before = await storedUseCount(link.id);
    const nowIso = new Date().toISOString();

    expect(await consumeInviteLinkUse(db(), link.id, nowIso)).toBe(true);
    expect(await storedUseCount(link.id)).toBe((before as number) + 1);
    expect(
      await recordInviteLinkRedemption(db(), {
        link: { id: link.id, organization_id: link.organization_id },
        userId: userId(twin),
        email: email(twin),
        nowIso,
      }),
    ).toBe("already_redeemed");
    await decrementInviteLinkUse(db(), link.id);

    expect(await storedUseCount(link.id)).toBe(before);
    expect(await storedRedemptions(link.id)).toEqual([
      { id: twinRedemptionId(twin), user_id: userId(twin) },
    ]);
  });

  it("leaves the twin's redemption in place when a submit loses the race for the last use", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const twin = person("twin-last");
    const redeemEvent = `NEW.actor_id = '${userId(twin)}'
      AND NEW.action = 'organization_invite_link.redeem'`;
    // After this submit passes the up-front check, the twin takes the last
    // use. The twin records its redemption after this submit's take failed.
    const refused = await withTriggers(
      [
        `AFTER INSERT ON kernel_admin_audit_events
         WHEN ${redeemEvent} AND NEW.outcome = 'intent'
         BEGIN UPDATE organization_invite_links SET use_count = use_count + 1
           WHERE id = '${link.id}'; END`,
        `AFTER INSERT ON kernel_admin_audit_events
         WHEN ${redeemEvent} AND NEW.outcome = 'failed'
         BEGIN ${twinRedemptionSql(link, twin)}; END`,
      ],
      () => acceptInvitation(tokenOf(link), twin),
    );

    expect(refused.status).toBe(410);
    expect(await refused.text()).toContain(
      "The link has already been used the maximum number of times.",
    );
    expect(await storedUseCount(link.id)).toBe(1);
    expect(await storedRedemptions(link.id)).toEqual([
      { id: twinRedemptionId(twin), user_id: userId(twin) },
    ]);
  });

  it("gives the use back when recording the redemption fails after the use was taken", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    const joiner = person("record-fails");

    const failed = await withTriggers(
      [
        `BEFORE INSERT ON organization_invite_link_redemptions
         WHEN NEW.user_id = '${userId(joiner)}'
         BEGIN SELECT RAISE(ABORT, 'forced invite link test failure'); END`,
      ],
      () => acceptInvitation(token, joiner),
    );

    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain("We couldn't add you just yet");
    expect(await membershipRole(organization.id, joiner)).toBeNull();
    expect(await storedUseCount(link.id)).toBe(0);
    expect(await storedRedemptions(link.id)).toEqual([]);

    expect((await acceptInvitation(token, joiner)).status).toBe(303);
    expect(await membershipRole(organization.id, joiner)).toBe("member");
    expect(await storedUseCount(link.id)).toBe(1);
  });

  it("admits exactly the maximum number of people when they join one after another", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 2 });
    const token = tokenOf(link);
    const first = person("sequential-first");
    const second = person("sequential-second");
    const third = person("sequential-third");

    expect((await acceptInvitation(token, first)).status).toBe(303);
    expect((await acceptInvitation(token, first)).status).toBe(303);
    expect(await storedUseCount(link.id)).toBe(1);
    expect((await acceptInvitation(token, second)).status).toBe(303);
    const refused = await acceptInvitation(token, third);

    expect(refused.status).toBe(410);
    expect(await refused.text()).toContain(
      "The link has already been used the maximum number of times.",
    );
    expect(await membershipRole(organization.id, third)).toBeNull();
    expect(
      (await storedRedemptions(link.id)).map((row) => row.user_id),
    ).not.toContain(userId(third));
    const exhausted = await findLink(organization.id, link.id);
    expect(exhausted.status).toBe("exhausted");
    expect(exhausted.use_count).toBe(2);
    expect(
      exhausted.redemptions.map((redemption) => redemption.user_id).sort(),
    ).toEqual([userId(first), userId(second)].sort());
  });

  it("never deletes a redemption row when a join fails, succeeds, or loses the race for the last use", async () => {
    const organization = await createOrganization();
    const reservedLink = await createLink(organization.id, { maxUses: 1 });
    const racedLink = await createLink(organization.id, { maxUses: 2 });
    const joiner = person("kept-joiner");
    const latecomer = person("kept-latecomer");
    const member = person("kept-member");
    const twin = person("kept-twin");
    const redeemEvent = `NEW.actor_id = '${userId(twin)}'
      AND NEW.action = 'organization_invite_link.redeem'`;
    const log = `test_invite_link_delete_log_${crypto.randomUUID().replace(/-/g, "")}`;
    await db()
      .prepare(`CREATE TABLE ${log} (link_id TEXT NOT NULL, user_id TEXT NOT NULL)`)
      .run();
    try {
      const statuses = await withTriggers(
        [
          `AFTER DELETE ON organization_invite_link_redemptions
           WHEN OLD.link_id IN ('${reservedLink.id}', '${racedLink.id}')
           BEGIN INSERT INTO ${log} (link_id, user_id)
             VALUES (OLD.link_id, OLD.user_id); END`,
        ],
        async () => {
          // A join that fails before any membership is granted, a refusal
          // while its use is reserved, and the retry that finishes it.
          const failed = await withFailingInsert(
            "organization_memberships",
            joiner,
            () => acceptInvitation(tokenOf(reservedLink), joiner),
          );
          const refused = await acceptInvitation(
            tokenOf(reservedLink),
            latecomer,
          );
          const retried = await acceptInvitation(tokenOf(reservedLink), joiner);
          // A first-time join that succeeds.
          const joined = await acceptInvitation(tokenOf(racedLink), member);
          // A submit that passes the up-front check, then loses the last use
          // to its twin, which records its redemption right after.
          const lost = await withTriggers(
            [
              `AFTER INSERT ON kernel_admin_audit_events
               WHEN ${redeemEvent} AND NEW.outcome = 'intent'
               BEGIN UPDATE organization_invite_links SET use_count = use_count + 1
                 WHERE id = '${racedLink.id}'; END`,
              `AFTER INSERT ON kernel_admin_audit_events
               WHEN ${redeemEvent} AND NEW.outcome = 'failed'
               BEGIN ${twinRedemptionSql(racedLink, twin)}; END`,
            ],
            () => acceptInvitation(tokenOf(racedLink), twin),
          );
          return [failed, refused, retried, joined, lost].map(
            (response) => response.status,
          );
        },
      );

      const deleted = await db()
        .prepare(`SELECT link_id, user_id FROM ${log}`)
        .all<{ link_id: string; user_id: string }>();
      expect(deleted.results).toEqual([]);
      expect(statuses).toEqual([502, 410, 303, 303, 410]);
    } finally {
      await db().prepare(`DROP TABLE IF EXISTS ${log}`).run();
    }
    expect(
      (await storedRedemptions(reservedLink.id)).map((row) => row.user_id),
    ).toEqual([userId(joiner)]);
    expect(await storedUseCount(reservedLink.id)).toBe(1);
    expect(
      (await storedRedemptions(racedLink.id)).map((row) => row.user_id).sort(),
    ).toEqual([userId(member), userId(twin)].sort());
    expect(await storedUseCount(racedLink.id)).toBe(2);
  });
});

describe("invite link audit and sign-in", () => {
  it("records create, redeem, and revoke in the kernel audit ledger without emails or tokens", async () => {
    const organization = await createOrganization();
    const team = await createTeam(organization.id);
    const link = await createLink(organization.id, {
      teamId: team.id,
      allowedEmails: ["audited@example.com"],
    });
    const token = tokenOf(link);
    const joiner: Actor = {
      "x-shiplet-user-id": `user_invite_links_audited_${crypto.randomUUID().slice(0, 8)}`,
      "x-shiplet-user-email": "audited@example.com",
    };
    expect((await acceptInvitation(token, joiner)).status).toBe(303);
    expect((await revokeLink(organization.id, link.id)).status).toBe(200);

    const rows = await db()
      .prepare(
        `SELECT actor_id, action, outcome, metadata_json
         FROM kernel_admin_audit_events
         WHERE organization_id = ? AND action LIKE 'organization_invite_link.%'
         ORDER BY rowid ASC`,
      )
      .bind(organization.id)
      .all<{
        actor_id: string;
        action: string;
        outcome: string;
        metadata_json: string;
      }>();
    const events = rows.results;
    for (const [action, actor] of [
      ["organization_invite_link.create", OWNER],
      ["organization_invite_link.redeem", joiner],
      ["organization_invite_link.revoke", OWNER],
    ] as const) {
      expect(
        events.some(
          (event) =>
            event.action === action &&
            event.outcome === "succeeded" &&
            event.actor_id === userId(actor),
        ),
        action,
      ).toBe(true);
    }
    for (const event of events) {
      expect(event.metadata_json).not.toContain("@");
      expect(event.metadata_json).not.toContain(token);
    }
    const redeemed = events.find(
      (event) =>
        event.action === "organization_invite_link.redeem" &&
        event.outcome === "succeeded",
    );
    expect(JSON.parse(redeemed?.metadata_json || "{}")).toMatchObject({
      targetKind: "invite_link",
      inviteLinkId: link.id,
      teamId: team.id,
    });
  });

  it("audits a failed join as failed and its retry as succeeded without emails or the token", async () => {
    const organization = await createOrganization();
    const link = await createLink(organization.id, { maxUses: 1 });
    const token = tokenOf(link);
    const joiner = person("audited-retry");

    const failed = await withFailingInsert(
      "organization_memberships",
      joiner,
      () => acceptInvitation(token, joiner),
    );
    expect(failed.status).toBe(502);
    expect((await acceptInvitation(token, joiner)).status).toBe(303);

    const rows = await db()
      .prepare(
        `SELECT id, actor_id, outcome, metadata_json
         FROM kernel_admin_audit_events
         WHERE organization_id = ? AND action = 'organization_invite_link.redeem'
         ORDER BY rowid ASC`,
      )
      .bind(organization.id)
      .all<{
        id: string;
        actor_id: string;
        outcome: string;
        metadata_json: string;
      }>();
    const events = rows.results;
    expect(events.map((event) => event.outcome)).toEqual([
      "intent",
      "failed",
      "intent",
      "succeeded",
    ]);
    for (const event of events) {
      expect(event.actor_id).toBe(userId(joiner));
      expect(event.metadata_json).not.toContain("@");
      expect(event.metadata_json).not.toContain(token);
    }
    const [failedIntent, failedOutcome, retryIntent, retryOutcome] = events;
    expect(JSON.parse(failedOutcome.metadata_json)).toEqual({
      targetKind: "invite_link",
      inviteLinkId: link.id,
      intentEventId: failedIntent.id,
    });
    expect(JSON.parse(retryOutcome.metadata_json)).toEqual({
      targetKind: "invite_link",
      inviteLinkId: link.id,
      intentEventId: retryIntent.id,
    });
  });

  it("returns people to the join page after they sign in", async () => {
    const organization = await createOrganization();
    const token = tokenOf(await createLink(organization.id));
    const returnTo = `/join/${token}`;

    const login = await request(
      `/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    );
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("location") as string);
    const state = authorize.searchParams.get("state") as string;
    expect(JSON.parse(atob(state)).returnTo).toBe(returnTo);

    const signInEmail = `invite-links-callback-${crypto.randomUUID()}@example.com`;
    const callback = await request(
      `/auth/callback?code=${encodeURIComponent(
        `test-code::${encodeURIComponent(signInEmail)}`,
      )}&state=${encodeURIComponent(btoa(JSON.stringify({ returnTo })))}`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(returnTo);
  });
});

describe("workspace invite links seed", () => {
  it("seeds administered organizations with their links and other organizations with none", async () => {
    const admin = person("seed-admin");
    const otherOwner = person("seed-owner");
    const administered = await createOrganization(admin);
    const team = await createTeam(administered.id, admin);
    const link = await createLink(administered.id, { teamId: team.id }, admin);
    const joined = await createOrganization(otherOwner);
    const joinedLink = await createLink(joined.id, {}, otherOwner);
    expect((await acceptInvitation(tokenOf(joinedLink), admin)).status).toBe(303);

    const seed = await loadWorkspaceInviteLinksSeed(
      db(),
      { id: userId(admin) },
      "https://shiplet.cc",
    );

    expect(seed.organizations).toHaveLength(2);
    expect(seed.organizations).toEqual(
      expect.arrayContaining([
        { id: administered.id, name: administered.name },
        { id: joined.id, name: joined.name },
      ]),
    );
    expect(seed.selectedOrganizationId).toBe(seed.organizations[0].id);
    expect(seed.rolesByOrganization).toEqual({
      [administered.id]: "admin",
      [joined.id]: "member",
    });
    expect(seed.teamsByOrganization[administered.id]).toEqual([
      { id: team.id, name: team.name },
    ]);
    expect(seed.teamsByOrganization[joined.id]).toEqual([]);
    expect(seed.linksByOrganization[administered.id]).toEqual([link]);
    expect(seed.linksByOrganization[joined.id]).toEqual([]);
    expectCredentialFreeInvitationPayload(seed);
    expect(JSON.stringify(seed)).not.toMatch(CREDENTIAL_KEY_PATTERN);
  });

  it("seeds an empty workspace for a person without organizations", async () => {
    const seed = await loadWorkspaceInviteLinksSeed(
      db(),
      { id: userId(person("seed-empty")) },
      "https://shiplet.cc",
    );

    expect(seed).toEqual({
      organizations: [],
      teamsByOrganization: {},
      rolesByOrganization: {},
      linksByOrganization: {},
      selectedOrganizationId: "",
    });
  });
});
