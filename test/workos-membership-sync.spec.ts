import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { createShipletGrant, createTeamMembership } from "../src/store";
import { workosTestDouble } from "../src/workos";
import { sweepWorkOSMemberships } from "../src/workos-membership-sync";

type Actor = {
  "x-shiplet-user-id": string;
  "x-shiplet-user-email": string;
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function db() {
  return (env as unknown as Env).DB;
}

function suffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    env as unknown as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function cookieHeaderFromResponse(response: Response) {
  return (response.headers.get("set-cookie") || "")
    .split(/,(?=\s*(?:__Host-shiplet_|shiplet_))/)
    .map((cookie) => cookie.trim().split(";")[0])
    .filter(Boolean)
    .join("; ");
}

/**
 * Signs the person in through the test AuthKit callback. Test mode issues the
 * WorkOS user ID user_<slug of email>, and the callback records it as the
 * person's WorkOS identity.
 */
async function signIn(email: string, organizationId = "") {
  const normalized = email.toLowerCase();
  const response = await request(
    `/auth/callback?code=${encodeURIComponent(
      `test-code:${organizationId}:${encodeURIComponent(normalized)}`,
    )}`,
    { redirect: "manual" },
  );
  const id = `user_${normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
  const actor: Actor = {
    "x-shiplet-user-id": id,
    "x-shiplet-user-email": normalized,
  };
  return { response, id, actor, cookie: cookieHeaderFromResponse(response) };
}

async function createOrganization(actor: Actor) {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify({ name: `Membership sync ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { organization: { id: string } })
    .organization;
}

async function createTeam(organizationId: string, actor: Actor) {
  const response = await request(`/api/organizations/${organizationId}/teams`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify({ name: `Reviewers ${suffix()}` }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { team: { id: string } }).team;
}

async function publishShiplet(
  organizationId: string,
  actor: Actor,
  visibility: "organization" | "private" = "organization",
) {
  const response = await request("/projects", {
    method: "POST",
    headers: { ...JSON_HEADERS, ...actor },
    body: JSON.stringify({
      name: `Shiplet ${suffix()}`,
      organization_id: organizationId,
      subdomain: `membership-sync-${suffix()}`,
      visibility,
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Review artifact</h1>"),
          size: 43,
        },
      ],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: { id: string };
    launchUrl: string;
  };
}

async function canOpen(launchUrl: string, headers: Record<string, string>) {
  const response = await request(launchUrl, { headers, redirect: "manual" });
  return response.status === 200;
}

async function membershipRole(organizationId: string, userId: string) {
  const row = await db()
    .prepare(
      `SELECT role FROM organization_memberships
			 WHERE organization_id = ? AND user_id = ?`,
    )
    .bind(organizationId, userId)
    .first<{ role: string }>();
  return row?.role ?? null;
}

async function inTeam(teamId: string, userId: string) {
  const row = await db()
    .prepare("SELECT 1 AS found FROM team_memberships WHERE team_id = ? AND user_id = ?")
    .bind(teamId, userId)
    .first<{ found: number }>();
  return Boolean(row);
}

async function setSweepCursor(cursor: string) {
  await db()
    .prepare(
      `INSERT INTO workos_membership_sync_state (id, cursor_user_id, updated_on)
			 VALUES ('organization_memberships', ?, ?)
			 ON CONFLICT(id) DO UPDATE SET cursor_user_id = excluded.cursor_user_id`,
    )
    .bind(cursor, new Date().toISOString())
    .run();
}

async function sweepCursor() {
  const row = await db()
    .prepare(
      `SELECT cursor_user_id FROM workos_membership_sync_state
			 WHERE id = 'organization_memberships'`,
    )
    .first<{ cursor_user_id: string }>();
  return row?.cursor_user_id ?? null;
}

/** A workspace with an owner and a member who joined through WorkOS. */
async function workspaceWithMember(label: string) {
  const key = suffix();
  const owner = await signIn(`sync-owner-${label}-${key}@example.com`);
  const organization = await createOrganization(owner.actor);
  const member = await signIn(
    `sync-member-${label}-${key}@example.com`,
    organization.id,
  );
  expect(member.response.status).toBe(302);
  expect(await membershipRole(organization.id, member.id)).toBe("member");
  return { owner, organization, member };
}

describe("WorkOS membership reconciliation at sign-in", () => {
  it("Given a member WorkOS removed, When they sign in again, Then their membership is gone and the organization's Shiplets are closed to them", async () => {
    const { owner, organization, member } = await workspaceWithMember("removed");
    const shiplet = await publishShiplet(organization.id, owner.actor);
    expect(await canOpen(shiplet.launchUrl, member.actor)).toBe(true);

    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    const again = await signIn(member.actor["x-shiplet-user-email"]);

    expect(again.response.status).toBe(302);
    expect(await membershipRole(organization.id, member.id)).toBeNull();
    expect(await canOpen(shiplet.launchUrl, member.actor)).toBe(false);
    const archive = await request(`/api/projects/${shiplet.project.id}/archive`, {
      method: "POST",
      headers: member.actor,
    });
    expect(archive.status).toBe(403);
  });

  it("Given a removed member with an explicit Shiplet grant, When they sign in again, Then the grant survives and still opens that Shiplet", async () => {
    const { owner, organization, member } = await workspaceWithMember("grant");
    const granted = await publishShiplet(organization.id, owner.actor, "private");
    const ungranted = await publishShiplet(organization.id, owner.actor);
    await createShipletGrant(db(), {
      id: `grant_${suffix()}`,
      project_id: granted.project.id,
      organization_id: organization.id,
      target_type: "user",
      target_id: member.id,
      email: member.actor["x-shiplet-user-email"],
      role: "viewer",
      invited_by_user_id: owner.id,
      created_on: new Date().toISOString(),
      accepted_on: new Date().toISOString(),
    });

    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    await signIn(member.actor["x-shiplet-user-email"]);

    expect(await membershipRole(organization.id, member.id)).toBeNull();
    expect(await canOpen(granted.launchUrl, member.actor)).toBe(true);
    expect(await canOpen(ungranted.launchUrl, member.actor)).toBe(false);
    const grant = await db()
      .prepare(
        `SELECT 1 AS found FROM shiplet_access_grants
				 WHERE project_id = ? AND target_type = 'user' AND target_id = ?`,
      )
      .bind(granted.project.id, member.id)
      .first<{ found: number }>();
    expect(grant).not.toBeNull();
  });

  it("Given a member of teams in two organizations, When WorkOS removes them from one, Then only that organization's team memberships and team grants go", async () => {
    const { owner, organization, member } = await workspaceWithMember("teams");
    const otherOrganization = await createOrganization(owner.actor);
    await signIn(member.actor["x-shiplet-user-email"], otherOrganization.id);
    const leftTeam = await createTeam(organization.id, owner.actor);
    const keptTeam = await createTeam(otherOrganization.id, owner.actor);
    await createTeamMembership(db(), leftTeam.id, member.id);
    await createTeamMembership(db(), keptTeam.id, member.id);
    const teamShiplet = await publishShiplet(
      organization.id,
      owner.actor,
      "private",
    );
    await createShipletGrant(db(), {
      id: `grant_${suffix()}`,
      project_id: teamShiplet.project.id,
      organization_id: organization.id,
      target_type: "team",
      target_id: leftTeam.id,
      role: "viewer",
      invited_by_user_id: owner.id,
      created_on: new Date().toISOString(),
      accepted_on: new Date().toISOString(),
    });
    expect(await canOpen(teamShiplet.launchUrl, member.actor)).toBe(true);

    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    await signIn(member.actor["x-shiplet-user-email"]);

    expect(await inTeam(leftTeam.id, member.id)).toBe(false);
    expect(await inTeam(keptTeam.id, member.id)).toBe(true);
    expect(await membershipRole(otherOrganization.id, member.id)).toBe("member");
    expect(await canOpen(teamShiplet.launchUrl, member.actor)).toBe(false);
  });

  it("Given an administrator WorkOS demoted, When they sign in again, Then they keep membership as a member and lose administrator actions", async () => {
    const key = suffix();
    const admin = await signIn(`sync-admin-${key}@example.com`);
    const organization = await createOrganization(admin.actor);
    expect(await membershipRole(organization.id, admin.id)).toBe("admin");

    workosTestDouble.setOrganizationMembershipRole(
      organization.id,
      admin.id,
      "member",
    );
    await signIn(admin.actor["x-shiplet-user-email"], organization.id);

    expect(await membershipRole(organization.id, admin.id)).toBe("member");
    const tokens = await request(
      `/api/organizations/${organization.id}/api-tokens`,
      { headers: admin.actor },
    );
    expect(tokens.status).toBe(403);
  });

  it("Given WorkOS fails to list memberships, When a removed member signs in, Then sign-in succeeds and the membership is kept for the next attempt", async () => {
    const { organization, member } = await workspaceWithMember("outage");
    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    workosTestDouble.setMembershipListingFailure(member.id, true);
    try {
      const again = await signIn(member.actor["x-shiplet-user-email"]);
      expect(again.response.status).toBe(302);
      expect(again.cookie).toContain("shiplet_session=");
      expect(await membershipRole(organization.id, member.id)).toBe("member");
    } finally {
      workosTestDouble.setMembershipListingFailure(member.id, false);
    }

    await signIn(member.actor["x-shiplet-user-email"]);
    expect(await membershipRole(organization.id, member.id)).toBeNull();
  });

  it("Given WorkOS lists no membership but the organization-scoped confirmation fails, When the member signs in, Then the membership is kept", async () => {
    const { organization, member } = await workspaceWithMember("confirm");
    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    workosTestDouble.setMembershipLookupFailure(member.id, true);
    try {
      const again = await signIn(member.actor["x-shiplet-user-email"]);
      expect(again.response.status).toBe(302);
      expect(await membershipRole(organization.id, member.id)).toBe("member");
    } finally {
      workosTestDouble.setMembershipLookupFailure(member.id, false);
    }
  });
});

describe("scheduled WorkOS membership sweep", () => {
  it("Given a removed member who never signs in again, When the scheduled job runs, Then their membership is removed and their open session loses access", async () => {
    const { owner, organization, member } = await workspaceWithMember("sweep");
    const shiplet = await publishShiplet(organization.id, owner.actor);
    expect(await canOpen(shiplet.launchUrl, { cookie: member.cookie })).toBe(true);

    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    // Start just before this member so the first run reaches them.
    await setSweepCursor(member.id.slice(0, -1));
    const context = createExecutionContext();
    await app.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now() } as ScheduledController,
      env as unknown as Parameters<typeof app.scheduled>[1],
      context,
    );
    await waitOnExecutionContext(context);

    expect(await membershipRole(organization.id, member.id)).toBeNull();
    expect(await canOpen(shiplet.launchUrl, { cookie: member.cookie })).toBe(
      false,
    );
  });

  it("Given more people than one run may visit, When the sweep runs, Then it visits a bounded batch and the next run resumes after the cursor", async () => {
    const key = suffix();
    const owner = await signIn(`sweep-batch-${key}-0@example.com`);
    const organization = await createOrganization(owner.actor);
    const members = [];
    for (const index of [1, 2, 3]) {
      members.push(
        await signIn(`sweep-batch-${key}-${index}@example.com`, organization.id),
      );
    }
    const people = [owner, ...members].map((person) => person.id).sort();
    workosTestDouble.removeOrganizationMembership(organization.id, people[3]);
    await setSweepCursor(`user_sweep-batch-${key}-`);

    const listedBefore = workosTestDouble.membershipListings().length;
    const first = await sweepWorkOSMemberships(env as unknown as Env, {
      limit: 2,
    });
    expect(first).toEqual({
      visited: 2,
      passComplete: false,
      stoppedReason: null,
      cursor: people[1],
    });
    expect(await sweepCursor()).toBe(people[1]);
    expect(workosTestDouble.membershipListings().slice(listedBefore)).toEqual(
      people.slice(0, 2),
    );

    const second = await sweepWorkOSMemberships(env as unknown as Env, {
      limit: 2,
    });
    expect(second?.visited).toBe(2);
    expect(second?.cursor).toBe(people[3]);
    expect(workosTestDouble.membershipListings().slice(listedBefore)).toEqual(
      people,
    );
    expect(await membershipRole(organization.id, people[3])).toBeNull();
    for (const kept of people.slice(0, 3)) {
      expect(await membershipRole(organization.id, kept)).not.toBeNull();
    }

    // Running the same batch again changes nothing more.
    await setSweepCursor(`user_sweep-batch-${key}-`);
    await sweepWorkOSMemberships(env as unknown as Env, { limit: 4 });
    for (const kept of people.slice(0, 3)) {
      expect(await membershipRole(organization.id, kept)).not.toBeNull();
    }
  });

  it("Given WorkOS fails or the request budget runs out, When the sweep runs, Then it stops without passing the person and resumes with them next run", async () => {
    const key = suffix();
    const owner = await signIn(`sweep-stop-${key}-0@example.com`);
    const organization = await createOrganization(owner.actor);
    const member = await signIn(
      `sweep-stop-${key}-1@example.com`,
      organization.id,
    );
    workosTestDouble.removeOrganizationMembership(organization.id, member.id);
    await setSweepCursor(owner.id);

    workosTestDouble.setMembershipListingFailure(member.id, true);
    try {
      const failed = await sweepWorkOSMemberships(env as unknown as Env, {
        limit: 5,
      });
      expect(failed).toMatchObject({
        visited: 0,
        stoppedReason: "http_503",
        cursor: owner.id,
      });
      expect(await sweepCursor()).toBe(owner.id);
      expect(await membershipRole(organization.id, member.id)).toBe("member");
    } finally {
      workosTestDouble.setMembershipListingFailure(member.id, false);
    }

    await setSweepCursor(`user_sweep-stop-${key}-`);
    const budgeted = await sweepWorkOSMemberships(env as unknown as Env, {
      limit: 5,
      workosRequestBudget: 1,
    });
    expect(budgeted).toMatchObject({
      visited: 1,
      stoppedReason: "workos_request_budget_exhausted",
      cursor: owner.id,
    });
    expect(await membershipRole(organization.id, member.id)).toBe("member");

    const resumed = await sweepWorkOSMemberships(env as unknown as Env, {
      limit: 5,
    });
    expect(resumed?.stoppedReason).toBeNull();
    expect(await membershipRole(organization.id, member.id)).toBeNull();
  });
});
