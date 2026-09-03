const CLI_CODE_PREFIX = "shiplet_cli_code_";
const CLI_SESSION_PREFIX = "shiplet_cli_session_";
const REQUEST_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

type AuthorizationRow = {
  id: string;
  user_id: string;
  redirect_uri: string;
  state_value: string;
  code_challenge: string;
  code_hash: string | null;
  expires_on: string;
  approved_on: string | null;
  exchanged_on: string | null;
  exchange_marker: string | null;
};

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Base64Url(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function opaque(prefix: string) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

export function normalizeCliLoopbackRedirect(value: unknown) {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      Number(url.port) < 1024 ||
      Number(url.port) > 65535 ||
      url.pathname !== "/callback" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export async function createCliAuthorizationRequest(
  db: D1Database,
  input: {
    userId: string;
    redirectUri: unknown;
    state: unknown;
    codeChallenge: unknown;
    method: unknown;
    now?: Date;
  },
) {
  const redirectUri = normalizeCliLoopbackRedirect(input.redirectUri);
  if (
    !redirectUri ||
    typeof input.state !== "string" ||
    !STATE_PATTERN.test(input.state) ||
    typeof input.codeChallenge !== "string" ||
    !CHALLENGE_PATTERN.test(input.codeChallenge) ||
    input.method !== "S256"
  ) {
    return null;
  }
  const now = input.now || new Date();
  const request = {
    id: `cli_auth_${crypto.randomUUID().replace(/-/g, "")}`,
    expiresOn: new Date(now.getTime() + REQUEST_TTL_MS).toISOString(),
  };
  await db.batch([
    db.prepare(
      `INSERT INTO cli_authorization_requests (
       id, user_id, redirect_uri, state_value, code_challenge, code_hash,
       expires_on, approved_on, exchanged_on, exchange_marker, created_on
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
    )
    .bind(
      request.id,
      input.userId,
      redirectUri,
      input.state,
      input.codeChallenge,
      request.expiresOn,
      now.toISOString(),
    ),
    db.prepare(
      `INSERT INTO cli_session_audit_events (
       id, authorization_request_id, user_id, event_kind, summary,
       metadata_json, occurred_on
      ) VALUES (?, ?, ?, 'cli.authorization.requested',
       'CLI authorization requested', '{}', ?)`,
    ).bind(
      `cli_audit_${crypto.randomUUID().replace(/-/g, "")}`,
      request.id,
      input.userId,
      now.toISOString(),
    ),
  ]);
  return Object.freeze(request);
}

export async function approveCliAuthorizationRequest(
  db: D1Database,
  input: { requestId: string; userId: string; now?: Date },
) {
  if (!/^cli_auth_[a-f0-9]{32}$/.test(input.requestId)) return null;
  const now = input.now || new Date();
  const code = opaque(CLI_CODE_PREFIX);
  const codeHash = await sha256Hex(code);
  const nowIso = now.toISOString();
  try {
    await db.batch([
      db.prepare(
        `UPDATE cli_authorization_requests SET code_hash = ?, approved_on = ?
         WHERE id = ? AND user_id = ? AND expires_on > ?
          AND approved_on IS NULL AND exchanged_on IS NULL`,
      ).bind(codeHash, nowIso, input.requestId, input.userId, nowIso),
      db.prepare(
        `INSERT INTO cli_session_audit_events (
         id, authorization_request_id, user_id, event_kind, summary,
         metadata_json, occurred_on
        ) SELECT ?, id, user_id, 'cli.authorization.approved',
          'CLI authorization approved', '{}', ?
           FROM cli_authorization_requests
          WHERE id = ? AND user_id = ? AND code_hash = ? AND approved_on = ?`,
      ).bind(
        `cli_audit_${crypto.randomUUID().replace(/-/g, "")}`,
        nowIso,
        input.requestId,
        input.userId,
        codeHash,
        nowIso,
      ),
      db.prepare(
        `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM cli_authorization_requests
           WHERE id = ? AND user_id = ? AND code_hash = ? AND approved_on = ?
         ) THEN 1 ELSE json_extract('cli_authorization_approval_failed', '$.invalid') END AS committed`,
      ).bind(input.requestId, input.userId, codeHash, nowIso),
    ]);
  } catch {
    return null;
  }
  const row = await db
    .prepare("SELECT redirect_uri, state_value FROM cli_authorization_requests WHERE id = ?")
    .bind(input.requestId)
    .first<{ redirect_uri: string; state_value: string }>();
  return row ? Object.freeze({ code, redirectUri: row.redirect_uri, state: row.state_value }) : null;
}

export async function exchangeCliAuthorizationCode(
  db: D1Database,
  input: { code: unknown; verifier: unknown; redirectUri: unknown; now?: Date },
): Promise<
  | { ok: true; accessToken: string; expiresOn: string }
  | { ok: false; reason: "invalid" | "replayed" }
> {
  const redirectUri = normalizeCliLoopbackRedirect(input.redirectUri);
  if (
    typeof input.code !== "string" ||
    !input.code.startsWith(CLI_CODE_PREFIX) ||
    input.code.length > 256 ||
    typeof input.verifier !== "string" ||
    !VERIFIER_PATTERN.test(input.verifier) ||
    !redirectUri
  ) {
    return { ok: false, reason: "invalid" };
  }
  const codeHash = await sha256Hex(input.code);
  const row = await db
    .prepare("SELECT * FROM cli_authorization_requests WHERE code_hash = ? LIMIT 1")
    .bind(codeHash)
    .first<AuthorizationRow>();
  const now = input.now || new Date();
  if (!row) return { ok: false, reason: "invalid" };
  if (row.exchanged_on) return { ok: false, reason: "replayed" };
  if (
    !row.approved_on ||
    row.redirect_uri !== redirectUri ||
    Date.parse(row.expires_on) <= now.getTime() ||
    (await sha256Base64Url(input.verifier)) !== row.code_challenge
  ) {
    return { ok: false, reason: "invalid" };
  }
  const accessToken = opaque(CLI_SESSION_PREFIX);
  const sessionHash = await sha256Hex(accessToken);
  const nowIso = now.toISOString();
  const exchangeMarker = `cli_exchange_${crypto.randomUUID().replace(/-/g, "")}`;
  const expiresOn = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE cli_authorization_requests
           SET exchanged_on = ?, exchange_marker = ?
           WHERE id = ? AND code_hash = ? AND redirect_uri = ?
            AND approved_on IS NOT NULL AND exchanged_on IS NULL
            AND exchange_marker IS NULL AND expires_on > ?`,
        )
        .bind(nowIso, exchangeMarker, row.id, codeHash, redirectUri, nowIso),
      db
        .prepare(
          `INSERT INTO cli_sessions (
           session_hash, authorization_request_id, user_id, scopes_json,
           expires_on, created_on, revoked_on
          ) SELECT ?, id, user_id, ?, ?, ?, NULL FROM cli_authorization_requests
           WHERE id = ? AND exchange_marker = ?`,
        )
        .bind(
          sessionHash,
          JSON.stringify([
            "revision:read",
            "revision:write",
            "deployment:write",
            "session:revoke",
          ]),
          expiresOn,
          nowIso,
          row.id,
          exchangeMarker,
        ),
      db.prepare(
        `INSERT INTO cli_session_audit_events (
         id, authorization_request_id, user_id, event_kind, summary,
         metadata_json, occurred_on
        ) SELECT ?, id, user_id, 'cli.session.exchanged',
          'CLI session exchanged', ?, ?
           FROM cli_authorization_requests
          WHERE id = ? AND exchange_marker = ?`,
      ).bind(
        `cli_audit_${crypto.randomUUID().replace(/-/g, "")}`,
        JSON.stringify({
          scopes: [
            "revision:read",
            "revision:write",
            "deployment:write",
            "session:revoke",
          ],
        }),
        nowIso,
        row.id,
        exchangeMarker,
      ),
      db
        .prepare(
          `SELECT CASE WHEN
           EXISTS (SELECT 1 FROM cli_authorization_requests WHERE id = ? AND exchange_marker = ?)
           AND EXISTS (SELECT 1 FROM cli_sessions WHERE session_hash = ?)
           AND EXISTS (
            SELECT 1 FROM cli_session_audit_events
             WHERE authorization_request_id = ?
              AND event_kind = 'cli.session.exchanged'
           )
           THEN 1 ELSE json_extract('cli_session_exchange_failed', '$.invalid') END AS committed`,
        )
        .bind(row.id, exchangeMarker, sessionHash, row.id),
    ]);
  } catch {
    const replay = await db
      .prepare("SELECT exchanged_on FROM cli_authorization_requests WHERE id = ?")
      .bind(row.id)
      .first<{ exchanged_on: string | null }>();
    return { ok: false, reason: replay?.exchanged_on ? "replayed" : "invalid" };
  }
  return { ok: true, accessToken, expiresOn };
}

function scopeForRequest(request: Request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const path = url.pathname;
  if (method === "GET" && path === "/api/shiplets") return "revision:read";
  if (method === "POST" && path === "/api/shiplets") return "revision:write";
  if (method === "GET" && /^\/api\/(?:drafts\/[^/]+\/package|shiplets\/[^/]+\/(?:package|revisions\/[^/]+\/package))$/.test(path)) return "revision:read";
  if ((method === "POST" || method === "PUT") && /^\/api\/(?:shiplets\/[^/]+\/drafts|drafts\/[^/]+\/(?:package|diff|validate))$/.test(path)) return "revision:write";
  if (method === "POST" && /^\/api\/(?:drafts\/[^/]+\/promote|shiplets\/[^/]+\/rollback|revisions\/[^/]+\/deployments)$/.test(path)) return "deployment:write";
  if (method === "POST" && path === "/api/cli/session/revoke") return "session:revoke";
  return null;
}

export async function revokeCliSession(
  db: D1Database,
  request: Request,
  userId: string,
) {
  const authorization = request.headers.get("authorization") || "";
  const accessToken = authorization.match(
    /^Bearer\s+(shiplet_cli_session_[A-Za-z0-9]+)$/i,
  )?.[1];
  if (!accessToken) return false;
  const sessionHash = await sha256Hex(accessToken);
  const nowIso = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(
        `UPDATE cli_sessions SET revoked_on = ?
         WHERE session_hash = ? AND user_id = ? AND revoked_on IS NULL`,
      ).bind(nowIso, sessionHash, userId),
      db.prepare(
        `INSERT INTO cli_session_audit_events (
         id, authorization_request_id, user_id, event_kind, summary,
         metadata_json, occurred_on
        ) SELECT ?, authorization_request_id, user_id, 'cli.session.revoked',
          'CLI session revoked', '{}', ?
           FROM cli_sessions
          WHERE session_hash = ? AND user_id = ? AND revoked_on = ?`,
      ).bind(
        `cli_audit_${crypto.randomUUID().replace(/-/g, "")}`,
        nowIso,
        sessionHash,
        userId,
        nowIso,
      ),
      db.prepare(
        `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM cli_sessions
           WHERE session_hash = ? AND user_id = ? AND revoked_on = ?
         ) THEN 1 ELSE json_extract('cli_session_revoke_failed', '$.invalid') END AS committed`,
      ).bind(sessionHash, userId, nowIso),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function authenticateCliSession(db: D1Database, request: Request) {
  const scope = scopeForRequest(request);
  if (!scope) return null;
  const authorization = request.headers.get("authorization") || "";
  const accessToken = authorization.match(/^Bearer\s+(shiplet_cli_session_[A-Za-z0-9]+)$/i)?.[1];
  if (!accessToken) return null;
  const row = await db
    .prepare(
      `SELECT user_id, scopes_json FROM cli_sessions
       WHERE session_hash = ? AND expires_on > ? AND revoked_on IS NULL LIMIT 1`,
    )
    .bind(await sha256Hex(accessToken), new Date().toISOString())
    .first<{ user_id: string; scopes_json: string }>();
  if (!row) return null;
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes_json);
  } catch {
    return null;
  }
  return Array.isArray(scopes) && scopes.includes(scope) ? row.user_id : null;
}
