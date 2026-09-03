import type { Project } from "./types";
import { newId, timestamps, type ShipletUser } from "./store";

export type OrganizationApiScope =
  | "shiplets:read"
  | "shiplets:write"
  | "shiplets:archive"
  | "feedback:read"
  | "feedback:write"
  | "mcp";

export type ProjectAccessMode = "all" | "selected";
export type ProjectRuleEffect = "allow" | "deny";
type ProjectArchiveStatus = "active" | "archived" | "all";

type TokenRow = {
  id: string;
  organization_id: string;
  name: string;
  token_hash: string;
  scopes: string;
  project_access_mode: ProjectAccessMode;
  created_by_user_id: string;
  created_on: string;
  last_used_on: string | null;
  revoked_on: string | null;
};

type ProjectRuleRow = {
  token_id: string;
  project_id: string;
  effect: ProjectRuleEffect;
  created_on: string;
};

export type OrganizationApiTokenRecord = Omit<
  TokenRow,
  "token_hash" | "scopes"
> & {
  scopes: OrganizationApiScope[];
  project_rules: ProjectRuleRow[];
};

export type CreateOrganizationApiTokenInput = {
  name?: unknown;
  scopes?: unknown;
  projectAccessMode?: unknown;
  projectRules?: unknown;
};

const TOKEN_PREFIX = "shiplet_org_";
const LEGACY_FEEDBACK_MANAGE_SCOPE = "feedback:manage";
const VALID_SCOPES = new Set<OrganizationApiScope>([
  "shiplets:read",
  "shiplets:write",
  "shiplets:archive",
  "feedback:read",
  "feedback:write",
  "mcp",
]);
const VALID_PERSISTED_SCOPES = new Set<string>([
  ...VALID_SCOPES,
  LEGACY_FEEDBACK_MANAGE_SCOPE,
]);

function archiveFilterSql(status: ProjectArchiveStatus = "active") {
  if (status === "archived") return "AND archived_on IS NOT NULL";
  if (status === "all") return "";
  return "AND archived_on IS NULL";
}

export async function createOrganizationApiToken(
  db: D1Database,
  organizationId: string,
  input: CreateOrganizationApiTokenInput,
  user: ShipletUser,
) {
  assertExactKeys(input, [
    "name",
    "scopes",
    "projectAccessMode",
    "projectRules",
  ]);
  const normalizedName =
    normalizeString(input.name, 120) || "Organization API key";
  const scopes = normalizeScopes(input.scopes);
  const projectAccessMode = normalizeProjectAccessMode(input.projectAccessMode);
  const projectRules = normalizeProjectRules(input.projectRules);
  await requireProjectRulesInOrganization(db, organizationId, projectRules);
  const token = `${TOKEN_PREFIX}${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const tokenHash = await hashToken(token);
  const now = timestamps.now();
  const row: TokenRow = {
    id: newId("org_token"),
    organization_id: organizationId,
    name: normalizedName,
    token_hash: tokenHash,
    scopes: scopes.join(","),
    project_access_mode: projectAccessMode,
    created_by_user_id: user.id,
    created_on: now,
    last_used_on: null,
    revoked_on: null,
  };

  const statements = [
    db
      .prepare(
        `INSERT INTO organization_api_tokens
			 (id, organization_id, name, token_hash, scopes, project_access_mode,
			  created_by_user_id, created_on, last_used_on, revoked_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.organization_id,
        row.name,
        row.token_hash,
        row.scopes,
        row.project_access_mode,
        row.created_by_user_id,
        row.created_on,
        row.last_used_on,
        row.revoked_on,
      ),
    ...projectRules.map((rule) =>
      db
        .prepare(
          `INSERT INTO organization_api_token_project_rules
					 (token_id, project_id, effect, created_on)
					 VALUES (?, ?, ?, ?)`,
        )
        .bind(row.id, rule.projectId, rule.effect, now),
    ),
  ];
  await db.batch(statements);

  return {
    token,
    record: await publicTokenWithRules(db, row),
  };
}

export async function listOrganizationApiTokens(
  db: D1Database,
  organizationId: string,
) {
  const result = await db
    .prepare(
      `SELECT *
			 FROM organization_api_tokens
			 WHERE organization_id = ?
			 ORDER BY created_on DESC`,
    )
    .bind(organizationId)
    .all<TokenRow>();
  return Promise.all(
    (result.results || []).map((row) => publicTokenWithRules(db, row)),
  );
}

export async function revokeOrganizationApiToken(
  db: D1Database,
  organizationId: string,
  tokenId: string,
) {
  await db
    .prepare(
      `UPDATE organization_api_tokens
			 SET revoked_on = ?
			 WHERE organization_id = ? AND id = ? AND revoked_on IS NULL`,
    )
    .bind(timestamps.now(), organizationId, tokenId)
    .run();

  const row = await db
    .prepare(
      `SELECT *
			 FROM organization_api_tokens
			 WHERE organization_id = ? AND id = ?`,
    )
    .bind(organizationId, tokenId)
    .first<TokenRow>();
  return row ? publicTokenWithRules(db, row) : null;
}

export async function authenticateOrganizationApiToken(
  db: D1Database,
  authorization: string | null | undefined,
  requiredScopes: OrganizationApiScope[] = [],
) {
  const token = parseBearerToken(authorization);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await db
    .prepare(
      `SELECT *
			 FROM organization_api_tokens
			 WHERE token_hash = ? AND revoked_on IS NULL`,
    )
    .bind(tokenHash)
    .first<TokenRow>();
  if (!row) return null;
  if (!(await persistedAuthorityIsValid(db, row))) return null;

  const record = await publicTokenWithRules(db, row);
  const hasScopes = requiredScopes.every((scope) =>
    record.scopes.includes(scope),
  );
  if (!hasScopes) return null;

  await db
    .prepare(`UPDATE organization_api_tokens SET last_used_on = ? WHERE id = ?`)
    .bind(timestamps.now(), row.id)
    .run();

  return record;
}

export async function listProjectsForOrganizationApiToken(
  db: D1Database,
  token: OrganizationApiTokenRecord,
  options: {
    archiveStatus?: ProjectArchiveStatus;
    limit?: number;
    offset?: number;
  } = {},
) {
  const archiveFilter = archiveFilterSql(options.archiveStatus);
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
  const bindings: Array<string | number> = [token.organization_id];
  const allowFilter =
    token.project_access_mode === "selected"
      ? `AND EXISTS (
				 SELECT 1 FROM organization_api_token_project_rules access_rule
				 WHERE access_rule.token_id = ?
				  AND access_rule.project_id = projects.id
				  AND access_rule.effect = 'allow'
			 )`
      : "";
  const denyFilter = `AND NOT EXISTS (
		SELECT 1 FROM organization_api_token_project_rules deny_rule
		WHERE deny_rule.token_id = ?
		 AND deny_rule.project_id = projects.id
		 AND deny_rule.effect = 'deny'
	)`;
  if (token.project_access_mode === "selected") {
    bindings.push(token.id);
  }
  bindings.push(token.id);
  if (limit !== null) bindings.push(limit, offset);
  const result = await db
    .prepare(
      `SELECT *
			 FROM projects
			 WHERE organization_id = ?
			   ${archiveFilter}
			   ${allowFilter}
			   ${denyFilter}
			 ORDER BY created_on DESC
			 ${paginationSql}`,
    )
    .bind(...bindings)
    .all<Project>();
  return result.results || [];
}

export function canOrganizationApiTokenAccessProject(
  token: OrganizationApiTokenRecord,
  project: Project,
) {
  if (
    !project.organization_id ||
    project.organization_id !== token.organization_id
  ) {
    return false;
  }

  const rules = token.project_rules.filter(
    (rule) => rule.project_id === project.id,
  );
  if (rules.some((rule) => rule.effect === "deny")) return false;
  if (token.project_access_mode === "selected") {
    return rules.some((rule) => rule.effect === "allow");
  }
  return true;
}

export function requireOrganizationApiScope(
  token: OrganizationApiTokenRecord,
  scope: OrganizationApiScope,
) {
  if (!token.scopes.includes(scope)) {
    throw new Response(`API key is missing required scope: ${scope}`, {
      status: 403,
    });
  }
}

export function requireOrganizationApiProjectAccess(
  token: OrganizationApiTokenRecord,
  project: Project,
) {
  if (!canOrganizationApiTokenAccessProject(token, project)) {
    throw new Response("Project access denied for this API key.", {
      status: 403,
    });
  }
}

export function requireOrganizationApiShipletCreationAccess(
  token: OrganizationApiTokenRecord,
) {
  if (token.project_access_mode !== "all") {
    throw new Response(
      "Creating a new Shiplet requires all-project organization authority.",
      { status: 403 },
    );
  }
}

async function requireProjectRulesInOrganization(
  db: D1Database,
  organizationId: string,
  projectRules: Array<{ projectId: string; effect: ProjectRuleEffect }>,
) {
  for (const projectId of new Set(projectRules.map((rule) => rule.projectId))) {
    const project = await db
      .prepare(
        `SELECT id FROM projects
				 WHERE id = ? AND organization_id = ? LIMIT 1`,
      )
      .bind(projectId, organizationId)
      .first<{ id: string }>();
    if (!project) throw invalidAuthorityInput();
  }
}

async function persistedAuthorityIsValid(db: D1Database, row: TokenRow) {
  if (
    row.project_access_mode !== "all" &&
    row.project_access_mode !== "selected"
  ) {
    return false;
  }
  const scopes = row.scopes.split(",");
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !scope || !VALID_PERSISTED_SCOPES.has(scope)) ||
    new Set(scopes).size !== scopes.length
  ) {
    return false;
  }
  const result = await db
    .prepare(
      `SELECT rule.project_id, rule.effect,
			        project.organization_id AS project_organization_id
			 FROM organization_api_token_project_rules rule
			 LEFT JOIN projects project ON project.id = rule.project_id
			 WHERE rule.token_id = ?`,
    )
    .bind(row.id)
    .all<{
      project_id: string;
      effect: string;
      project_organization_id: string | null;
    }>();
  return (result.results || []).every(
    (rule) =>
      Boolean(rule.project_id) &&
      (rule.effect === "allow" || rule.effect === "deny") &&
      rule.project_organization_id === row.organization_id,
  );
}

async function publicTokenWithRules(db: D1Database, row: TokenRow) {
  const result = await db
    .prepare(
      `SELECT *
			 FROM organization_api_token_project_rules
			 WHERE token_id = ?
			 ORDER BY created_on ASC`,
    )
    .bind(row.id)
    .all<ProjectRuleRow>();

  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    scopes: Array.from(
      new Set(
        row.scopes.split(",").flatMap((scope) => {
          if (scope === LEGACY_FEEDBACK_MANAGE_SCOPE) {
            return [
              "feedback:read",
              "feedback:write",
            ] as OrganizationApiScope[];
          }
          return VALID_SCOPES.has(scope as OrganizationApiScope)
            ? [scope as OrganizationApiScope]
            : [];
        }),
      ),
    ),
    project_access_mode: row.project_access_mode === "all" ? "all" : "selected",
    project_rules: (result.results || []).filter(
      (rule) =>
        Boolean(rule.project_id) &&
        (rule.effect === "allow" || rule.effect === "deny"),
    ),
    created_by_user_id: row.created_by_user_id,
    created_on: row.created_on,
    last_used_on: row.last_used_on,
    revoked_on: row.revoked_on,
  } satisfies OrganizationApiTokenRecord;
}

function normalizeScopes(scopes: unknown): OrganizationApiScope[] {
  if (!Array.isArray(scopes)) {
    throw invalidAuthorityInput();
  }
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !VALID_SCOPES.has(scope as OrganizationApiScope),
    )
  ) {
    throw invalidAuthorityInput();
  }
  return Array.from(new Set(scopes as OrganizationApiScope[]));
}

function normalizeProjectAccessMode(value: unknown): ProjectAccessMode {
  if (value !== "all" && value !== "selected") {
    throw invalidAuthorityInput();
  }
  return value;
}

function invalidAuthorityInput() {
  return new Response(
    "Explicit valid API key scopes and project access mode are required.",
    { status: 400 },
  );
}

function normalizeProjectRules(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw invalidAuthorityInput();
  }
  const seen = new Set<string>();
  const rules: Array<{ projectId: string; effect: ProjectRuleEffect }> = [];
  for (const item of value) {
    if (!isRecord(item)) throw invalidAuthorityInput();
    assertExactKeys(item, ["projectId", "effect"]);
    const rawProjectId = item.projectId;
    const projectId = normalizeString(rawProjectId, 160);
    const effect =
      item.effect === "allow" ? "allow" : item.effect === "deny" ? "deny" : "";
    if (
      typeof rawProjectId !== "string" ||
      !projectId ||
      rawProjectId.trim().length > 160 ||
      !effect
    ) {
      throw invalidAuthorityInput();
    }
    const key = `${projectId}:${effect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ projectId, effect });
  }
  return rules;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidAuthorityInput();
  }
}

function normalizeString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hashToken(token: string) {
  const encoded = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseBearerToken(authorization: string | null | undefined) {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
