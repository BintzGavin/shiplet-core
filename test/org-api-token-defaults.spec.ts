import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  authenticateOrganizationApiToken,
  createOrganizationApiToken,
  listProjectsForOrganizationApiToken,
} from "../src/org-api-tokens";
import { ensureSchema } from "../src/schema";
import type { ShipletUser } from "../src/store";

describe("organization API token authority defaults", () => {
  beforeAll(async () => {
    await ensureSchema((env as Env).DB);
  });

  it.each([
    {
      caseName: "omitted scopes",
      input: { projectAccessMode: "selected" },
    },
    {
      caseName: "an empty scope list",
      input: { scopes: [], projectAccessMode: "all" },
    },
    {
      caseName: "a wholly invalid scope list",
      input: {
        scopes: ["admin", null, 42],
        projectAccessMode: "selected",
      },
    },
    {
      caseName: "an omitted project access mode",
      input: { scopes: ["shiplets:read"] },
    },
    {
      caseName: "an invalid project access mode",
      input: { scopes: ["shiplets:read"], projectAccessMode: "everything" },
    },
    {
      caseName: "a mixed valid and invalid scope list",
      input: {
        scopes: ["shiplets:read", "organization:admin"],
        projectAccessMode: "all",
      },
    },
    {
      caseName: "the retired feedback management alias",
      input: {
        scopes: ["feedback:manage"],
        projectAccessMode: "all",
      },
    },
    {
      caseName: "a non-array project-rule declaration",
      input: {
        scopes: ["shiplets:read"],
        projectAccessMode: "all",
        projectRules: { projectId: "project_A", effect: "deny" },
      },
    },
    {
      caseName: "a malformed deny rule mixed with a valid rule",
      input: {
        scopes: ["shiplets:read"],
        projectAccessMode: "all",
        projectRules: [
          { projectId: "project_A", effect: "deny" },
          { projectId: "project_B", effect: "block" },
        ],
      },
    },
    {
      caseName: "a rule with an empty project identifier",
      input: {
        scopes: ["shiplets:read"],
        projectAccessMode: "selected",
        projectRules: [{ projectId: "", effect: "allow" }],
      },
    },
    {
      caseName: "an unknown authority limit",
      input: {
        scopes: ["shiplets:read"],
        projectAccessMode: "all",
        limits: { projects: 1 },
      },
    },
  ])(
    "Given $caseName, When an administrator creates a token, Then validation rejects the request without creating authority",
    async ({ input }) => {
      const { db, organizationId, user } = await createOrganizationFixture();

      const outcome = await createOrganizationApiToken(
        db,
        organizationId,
        input,
        user,
      ).then(
        () => null,
        (error: unknown) => error,
      );

      expect(outcome).toBeInstanceOf(Response);
      expect((outcome as Response).status).toBe(400);
      expect(await (outcome as Response).text()).toContain(
        "Explicit valid API key scopes and project access mode are required",
      );
      const persisted = await db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM organization_api_tokens
           WHERE organization_id = ?`,
        )
        .bind(organizationId)
        .first<{ count: number }>();
      expect(Number(persisted?.count || 0)).toBe(0);
    },
  );

  it("Given explicit valid authority, When an administrator creates a token, Then its scopes and all-project access remain compatible", async () => {
    const { db, organizationId, user } = await createOrganizationFixture();

    const { record } = await createOrganizationApiToken(
      db,
      organizationId,
      {
        scopes: ["shiplets:read", "feedback:write", "shiplets:read"],
        projectAccessMode: "all",
      },
      user,
    );

    expect(record.scopes).toEqual(["shiplets:read", "feedback:write"]);
    expect(record.project_access_mode).toBe("all");
  });

  it("Given explicit selected-project authority, When an administrator creates a token, Then its valid allow rule remains compatible", async () => {
    const { db, organizationId, user } = await createOrganizationFixture();
    const projectId = `project_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO projects (
           id, organization_id, owner_user_id, name, subdomain,
           script_content, created_on, modified_on
         ) VALUES (?, ?, ?, 'Selected project', ?, '', ?, ?)`,
      )
      .bind(
        projectId,
        organizationId,
        user.id,
        `selected-${crypto.randomUUID()}`,
        now,
        now,
      )
      .run();

    const { record } = await createOrganizationApiToken(
      db,
      organizationId,
      {
        scopes: ["mcp"],
        projectAccessMode: "selected",
        projectRules: [{ projectId, effect: "allow" }],
      },
      user,
    );

    expect(record.scopes).toEqual(["mcp"]);
    expect(record.project_access_mode).toBe("selected");
    expect(record.project_rules).toEqual([
      expect.objectContaining({ project_id: projectId, effect: "allow" }),
    ]);
  });

  it("paginates after selected-project and deny rules are enforced", async () => {
    const { db, organizationId, user } = await createOrganizationFixture();
    const allowedProjectId = `project_${crypto.randomUUID()}`;
    const deniedProjectId = `project_${crypto.randomUUID()}`;
    for (const [index, projectId] of [
      allowedProjectId,
      deniedProjectId,
    ].entries()) {
      await db
        .prepare(
          `INSERT INTO projects (
             id, organization_id, owner_user_id, name, subdomain,
             script_content, created_on, modified_on
           ) VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
        )
        .bind(
          projectId,
          organizationId,
          user.id,
          `Rule project ${index}`,
          `rule-project-${crypto.randomUUID()}`,
          new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        )
        .run();
    }
    const selected = await createOrganizationApiToken(
      db,
      organizationId,
      {
        scopes: ["mcp", "shiplets:read"],
        projectAccessMode: "selected",
        projectRules: [{ projectId: allowedProjectId, effect: "allow" }],
      },
      user,
    );
    const allExceptDenied = await createOrganizationApiToken(
      db,
      organizationId,
      {
        scopes: ["mcp", "shiplets:read"],
        projectAccessMode: "all",
        projectRules: [{ projectId: deniedProjectId, effect: "deny" }],
      },
      user,
    );

    await expect(
      listProjectsForOrganizationApiToken(db, selected.record, { limit: 1 }),
    ).resolves.toEqual([expect.objectContaining({ id: allowedProjectId })]);
    await expect(
      listProjectsForOrganizationApiToken(db, allExceptDenied.record, {
        limit: 1,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: allowedProjectId })]);
  });

  it("Given a stored key predates the feedback scope split, When it authenticates, Then the retired alias projects only current read and write authority", async () => {
    const { db, organizationId, user } = await createOrganizationFixture();
    const created = await createOrganizationApiToken(
      db,
      organizationId,
      {
        scopes: ["feedback:read"],
        projectAccessMode: "all",
      },
      user,
    );
    await db
      .prepare(
        "UPDATE organization_api_tokens SET scopes = 'feedback:manage' WHERE id = ?",
      )
      .bind(created.record.id)
      .run();

    const authenticated = await authenticateOrganizationApiToken(
      db,
      `Bearer ${created.token}`,
      ["feedback:read", "feedback:write"],
    );

    expect(authenticated?.scopes).toEqual(["feedback:read", "feedback:write"]);
    expect(authenticated?.scopes).not.toContain("feedback:manage");
  });

  it.each([
    {
      caseName: "an unknown persisted access mode",
      corrupt: async (db: D1Database, tokenId: string) => {
        await db
          .prepare(
            "UPDATE organization_api_tokens SET project_access_mode = 'unexpected' WHERE id = ?",
          )
          .bind(tokenId)
          .run();
      },
    },
    {
      caseName: "an unknown persisted scope",
      corrupt: async (db: D1Database, tokenId: string) => {
        await db
          .prepare(
            "UPDATE organization_api_tokens SET scopes = 'shiplets:read,unknown' WHERE id = ?",
          )
          .bind(tokenId)
          .run();
      },
    },
    {
      caseName: "an unknown persisted rule effect",
      corrupt: async (db: D1Database, tokenId: string) => {
        await db
          .prepare(
            "UPDATE organization_api_token_project_rules SET effect = 'unexpected' WHERE token_id = ?",
          )
          .bind(tokenId)
          .run();
      },
    },
  ])(
    "Given $caseName, When the credential authenticates, Then persisted corruption fails closed",
    async ({ corrupt }) => {
      const { db, organizationId, user } = await createOrganizationFixture();
      const projectId = `project_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO projects (
             id, organization_id, owner_user_id, name, subdomain,
             script_content, created_on, modified_on
           ) VALUES (?, ?, ?, 'Persisted authority project', ?, '', ?, ?)`,
        )
        .bind(
          projectId,
          organizationId,
          user.id,
          `persisted-${crypto.randomUUID()}`,
          now,
          now,
        )
        .run();
      const created = await createOrganizationApiToken(
        db,
        organizationId,
        {
          scopes: ["shiplets:read"],
          projectAccessMode: "selected",
          projectRules: [{ projectId, effect: "allow" }],
        },
        user,
      );
      await corrupt(db, created.record.id);

      const authenticated = await authenticateOrganizationApiToken(
        db,
        `Bearer ${created.token}`,
        ["shiplets:read"],
      );
      expect(authenticated).toBeNull();
    },
  );

  it("Given a project rule names a missing resource, When token creation fails, Then no partial token row remains", async () => {
    const { db, organizationId, user } = await createOrganizationFixture();

    const outcome = await createOrganizationApiToken(
      db,
      organizationId,
      {
        scopes: ["shiplets:read"],
        projectAccessMode: "selected",
        projectRules: [
          {
            projectId: `project_missing_${crypto.randomUUID()}`,
            effect: "allow",
          },
        ],
      },
      user,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(Response);
    expect((outcome as Response).status).toBe(400);
    const persisted = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM organization_api_tokens WHERE organization_id = ?",
      )
      .bind(organizationId)
      .first<{ count: number }>();
    expect(Number(persisted?.count || 0)).toBe(0);
  });
});

async function createOrganizationFixture() {
  const db = (env as Env).DB;
  const now = new Date().toISOString();
  const user: ShipletUser = {
    id: `user_${crypto.randomUUID()}`,
    email: `${crypto.randomUUID()}@example.test`,
    created_on: now,
    updated_on: now,
  };
  const organizationId = `org_${crypto.randomUUID()}`;

  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, email, created_on, updated_on)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(user.id, user.email, now, now),
    db
      .prepare(
        `INSERT INTO organizations (id, name, created_by_user_id, created_on)
         VALUES (?, 'API token default test', ?, ?)`,
      )
      .bind(organizationId, user.id, now),
  ]);

  return { db, organizationId, user };
}
