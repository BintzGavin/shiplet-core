// Device login for the CLI (`shiplet login --device`), after the OAuth 2.0
// device authorization grant (RFC 8628). It is for a CLI that cannot receive
// a browser callback on the same computer: a cloud agent, an SSH session, or a
// container. The CLI shows a short code; the person signs in to Shiplet on any
// device, types the code, and approves. The CLI polls and receives the same
// reusable, scoped session that browser login issues, so every other rule
// (scopes, lifetime caps, revocation, audit) is unchanged.
//
// Safeguards:
// - The device code is 256 random bits, stored only as a hash, and works once.
// - The person must type the user code. There is no link that pre-fills it,
//   so a phishing message cannot hand someone a one-click approval.
// - The approval page shows the account, where the request came from, and how
//   long the session lasts, and says to approve only a sign-in you started.
// - Requests expire after 10 minutes. Polling faster than the interval gets
//   slow_down. Each network address may hold a few pending requests at once.
import {
  REUSABLE_SESSION_DEFAULT_TTL_SECONDS,
  REUSABLE_SESSION_MAX_TTL_SECONDS,
  REUSABLE_SESSION_MIN_TTL_SECONDS,
  REUSABLE_SESSION_SCOPES,
} from "./cli-session";

const DEVICE_CODE_PREFIX = "shiplet_cli_device_";
const CLI_SESSION_PREFIX = "shiplet_cli_session_";
export const DEVICE_REQUEST_TTL_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
export const DEVICE_PENDING_PER_ADDRESS = 5;
// Consonants without look-alikes, so codes are easy to read aloud and cannot
// spell words. 20^8 codes; the request expires long before guessing matters.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_REDIRECT_MARKER = "urn:shiplet:cli:device";

export type DeviceAuthorizationRow = {
  id: string;
  device_code_hash: string;
  user_code: string;
  session_ttl_seconds: number;
  expires_on: string;
  interval_seconds: number;
  last_polled_on: string | null;
  requested_ip_hash: string | null;
  requested_from: string | null;
  user_id: string | null;
  authorization_request_id: string | null;
  approved_on: string | null;
  denied_on: string | null;
  exchanged_on: string | null;
  created_on: string;
};

export async function ensureCliDeviceSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS cli_device_authorizations (
        id TEXT PRIMARY KEY,
        device_code_hash TEXT NOT NULL UNIQUE,
        user_code TEXT NOT NULL,
        session_ttl_seconds INTEGER NOT NULL,
        expires_on TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL,
        last_polled_on TEXT,
        requested_ip_hash TEXT,
        requested_from TEXT,
        user_id TEXT,
        authorization_request_id TEXT,
        approved_on TEXT,
        denied_on TEXT,
        exchanged_on TEXT,
        created_on TEXT NOT NULL
      )`,
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS cli_device_authorizations_user_code ON cli_device_authorizations(user_code, expires_on)"),
    db.prepare("CREATE INDEX IF NOT EXISTS cli_device_authorizations_address ON cli_device_authorizations(requested_ip_hash, expires_on)"),
  ]);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hex(bytes: number) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomUserCode() {
  // Rejection sampling keeps every letter equally likely.
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
  return code;
}

export function formatUserCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Accepts what a person types: any case, with or without the dash or spaces.
export function normalizeUserCode(value: unknown) {
  if (typeof value !== "string" || value.length > 32) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const character of code) if (!USER_CODE_ALPHABET.includes(character)) return null;
  return code;
}

export function normalizeDeviceSessionTtl(value: unknown) {
  if (value === undefined || value === null || value === "") return REUSABLE_SESSION_DEFAULT_TTL_SECONDS;
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{1,6}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(seconds) || seconds <= 0) return null;
  return Math.min(REUSABLE_SESSION_MAX_TTL_SECONDS, Math.max(REUSABLE_SESSION_MIN_TTL_SECONDS, seconds));
}

export async function createDeviceAuthorization(
  db: D1Database,
  input: { sessionTtl?: unknown; ipAddress?: string | null; requestedFrom?: string | null; now?: Date },
): Promise<
  | { ok: true; deviceCode: string; userCode: string; expiresIn: number; interval: number; sessionTtlSeconds: number }
  | { ok: false; reason: "invalid_ttl" | "too_many_requests" }
> {
  const sessionTtlSeconds = normalizeDeviceSessionTtl(input.sessionTtl);
  if (sessionTtlSeconds === null) return { ok: false, reason: "invalid_ttl" };
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const ipHash = input.ipAddress ? await sha256Hex(`cli-device:${input.ipAddress}`) : null;
  if (ipHash) {
    const pending = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM cli_device_authorizations
         WHERE requested_ip_hash = ? AND expires_on > ? AND approved_on IS NULL AND denied_on IS NULL`,
      )
      .bind(ipHash, nowIso)
      .first<{ count: number }>();
    if (Number(pending?.count || 0) >= DEVICE_PENDING_PER_ADDRESS) return { ok: false, reason: "too_many_requests" };
  }
  let userCode = randomUserCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = await db
      .prepare("SELECT 1 FROM cli_device_authorizations WHERE user_code = ? AND expires_on > ? LIMIT 1")
      .bind(userCode, nowIso)
      .first();
    if (!taken) break;
    userCode = randomUserCode();
  }
  const deviceCode = `${DEVICE_CODE_PREFIX}${hex(32)}`;
  await db
    .prepare(
      `INSERT INTO cli_device_authorizations (
        id, device_code_hash, user_code, session_ttl_seconds, expires_on, interval_seconds,
        last_polled_on, requested_ip_hash, requested_from, user_id, authorization_request_id,
        approved_on, denied_on, exchanged_on, created_on
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
    .bind(
      `cli_device_${hex(16)}`,
      await sha256Hex(deviceCode),
      userCode,
      sessionTtlSeconds,
      new Date(now.getTime() + DEVICE_REQUEST_TTL_SECONDS * 1000).toISOString(),
      DEVICE_POLL_INTERVAL_SECONDS,
      ipHash,
      input.requestedFrom ? input.requestedFrom.slice(0, 120) : null,
      nowIso,
    )
    .run();
  return {
    ok: true,
    deviceCode,
    userCode: formatUserCode(userCode),
    expiresIn: DEVICE_REQUEST_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
    sessionTtlSeconds,
  };
}

// The pending request a person is approving, found by the code they typed.
export async function findPendingDeviceAuthorization(db: D1Database, userCode: unknown, now = new Date()) {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  return db
    .prepare(
      `SELECT * FROM cli_device_authorizations
       WHERE user_code = ? AND expires_on > ? AND approved_on IS NULL AND denied_on IS NULL
       ORDER BY created_on DESC LIMIT 1`,
    )
    .bind(code, now.toISOString())
    .first<DeviceAuthorizationRow>();
}

export async function getPendingDeviceAuthorizationById(db: D1Database, id: unknown, now = new Date()) {
  if (typeof id !== "string" || !/^cli_device_[a-f0-9]{32}$/.test(id)) return null;
  return db
    .prepare(
      `SELECT * FROM cli_device_authorizations
       WHERE id = ? AND expires_on > ? AND approved_on IS NULL AND denied_on IS NULL`,
    )
    .bind(id, now.toISOString())
    .first<DeviceAuthorizationRow>();
}

export async function denyDeviceAuthorization(db: D1Database, input: { id: string; userId: string; now?: Date }) {
  const nowIso = (input.now || new Date()).toISOString();
  const result = await db
    .prepare(
      `UPDATE cli_device_authorizations SET denied_on = ?, user_id = ?
       WHERE id = ? AND expires_on > ? AND approved_on IS NULL AND denied_on IS NULL`,
    )
    .bind(nowIso, input.userId, input.id, nowIso)
    .run();
  return (result.meta?.changes || 0) > 0;
}

// Approval records an ordinary, already-approved CLI authorization request for
// the person, so the session that follows is audited and revoked like any other.
export async function approveDeviceAuthorization(db: D1Database, input: { id: string; userId: string; now?: Date }) {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const requestId = `cli_auth_${hex(16)}`;
  const audit = (kind: string, summary: string) =>
    db
      .prepare(
        `INSERT INTO cli_session_audit_events (
          id, authorization_request_id, user_id, event_kind, summary, metadata_json, occurred_on
        ) SELECT ?, id, user_id, ?, ?, '{"flow":"device"}', ?
          FROM cli_authorization_requests WHERE id = ? AND user_id = ?`,
      )
      .bind(`cli_audit_${hex(16)}`, kind, summary, nowIso, requestId, input.userId);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE cli_device_authorizations SET approved_on = ?, user_id = ?, authorization_request_id = ?
           WHERE id = ? AND expires_on > ? AND approved_on IS NULL AND denied_on IS NULL`,
        )
        .bind(nowIso, input.userId, requestId, input.id, nowIso),
      db
        .prepare(
          `INSERT INTO cli_authorization_requests (
            id, user_id, redirect_uri, state_value, code_challenge, code_hash,
            expires_on, approved_on, exchanged_on, exchange_marker, session_ttl_seconds, created_on
          ) SELECT ?, user_id, ?, id, 'device', NULL, expires_on, approved_on, NULL, NULL, session_ttl_seconds, ?
            FROM cli_device_authorizations WHERE id = ? AND authorization_request_id = ?`,
        )
        .bind(requestId, DEVICE_REDIRECT_MARKER, nowIso, input.id, requestId),
      audit("cli.authorization.requested", "CLI device authorization requested"),
      audit("cli.authorization.approved", "CLI device authorization approved"),
      db
        .prepare(
          `SELECT CASE WHEN EXISTS (
            SELECT 1 FROM cli_authorization_requests WHERE id = ? AND user_id = ? AND approved_on = ?
          ) THEN 1 ELSE json_extract('cli_device_approval_failed', '$.invalid') END AS committed`,
        )
        .bind(requestId, input.userId, nowIso),
    ]);
  } catch {
    return false;
  }
  return true;
}

export type DevicePollResult =
  | { ok: true; accessToken: string; expiresOn: string }
  | { ok: false; error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" };

// The CLI polls with its device code until the person decides.
export async function pollDeviceAuthorization(db: D1Database, input: { deviceCode: unknown; now?: Date }): Promise<DevicePollResult> {
  if (typeof input.deviceCode !== "string" || !/^shiplet_cli_device_[a-f0-9]{64}$/.test(input.deviceCode)) {
    return { ok: false, error: "invalid_grant" };
  }
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const row = await db
    .prepare("SELECT * FROM cli_device_authorizations WHERE device_code_hash = ?")
    .bind(await sha256Hex(input.deviceCode))
    .first<DeviceAuthorizationRow>();
  if (!row || row.exchanged_on) return { ok: false, error: "invalid_grant" };
  if (row.denied_on) return { ok: false, error: "access_denied" };
  if (Date.parse(row.expires_on) <= now.getTime()) return { ok: false, error: "expired_token" };
  if (!row.approved_on || !row.authorization_request_id) {
    const tooSoon = row.last_polled_on && now.getTime() - Date.parse(row.last_polled_on) < (row.interval_seconds - 1) * 1000;
    await db.prepare("UPDATE cli_device_authorizations SET last_polled_on = ? WHERE id = ?").bind(nowIso, row.id).run();
    return { ok: false, error: tooSoon ? "slow_down" : "authorization_pending" };
  }

  const accessToken = `${CLI_SESSION_PREFIX}${hex(32)}`;
  const sessionHash = await sha256Hex(accessToken);
  const exchangeMarker = `cli_exchange_${hex(16)}`;
  const ttlSeconds = Math.min(REUSABLE_SESSION_MAX_TTL_SECONDS, Math.max(REUSABLE_SESSION_MIN_TTL_SECONDS, Number(row.session_ttl_seconds)));
  const expiresOn = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const requestId = row.authorization_request_id;
  try {
    await db.batch([
      db
        .prepare("UPDATE cli_device_authorizations SET exchanged_on = ? WHERE id = ? AND exchanged_on IS NULL AND approved_on IS NOT NULL")
        .bind(nowIso, row.id),
      db
        .prepare(
          `UPDATE cli_authorization_requests SET exchanged_on = ?, exchange_marker = ?
           WHERE id = ? AND redirect_uri = ? AND approved_on IS NOT NULL AND exchanged_on IS NULL
            AND exchange_marker IS NULL AND expires_on > ?
            AND EXISTS (SELECT 1 FROM cli_device_authorizations WHERE id = ? AND exchanged_on = ?)`,
        )
        .bind(nowIso, exchangeMarker, requestId, DEVICE_REDIRECT_MARKER, nowIso, row.id, nowIso),
      db
        .prepare(
          `INSERT INTO cli_sessions (
            session_hash, authorization_request_id, user_id, scopes_json, expires_on, created_on, revoked_on
          ) SELECT ?, id, user_id, ?, ?, ?, NULL FROM cli_authorization_requests WHERE id = ? AND exchange_marker = ?`,
        )
        .bind(sessionHash, JSON.stringify(REUSABLE_SESSION_SCOPES), expiresOn, nowIso, requestId, exchangeMarker),
      db
        .prepare(
          `INSERT INTO cli_session_audit_events (
            id, authorization_request_id, user_id, event_kind, summary, metadata_json, occurred_on
          ) SELECT ?, id, user_id, 'cli.session.exchanged', 'CLI session exchanged', ?, ?
            FROM cli_authorization_requests WHERE id = ? AND exchange_marker = ?`,
        )
        .bind(
          `cli_audit_${hex(16)}`,
          JSON.stringify({ flow: "device", scopes: REUSABLE_SESSION_SCOPES, reusable: true, ttlSeconds }),
          nowIso,
          requestId,
          exchangeMarker,
        ),
      db
        .prepare(
          `SELECT CASE WHEN EXISTS (SELECT 1 FROM cli_sessions WHERE session_hash = ?)
           THEN 1 ELSE json_extract('cli_device_exchange_failed', '$.invalid') END AS committed`,
        )
        .bind(sessionHash),
    ]);
  } catch {
    return { ok: false, error: "invalid_grant" };
  }
  return { ok: true, accessToken, expiresOn };
}

export async function sweepExpiredDeviceAuthorizations(db: D1Database, now = new Date()) {
  // Keep a day of finished requests for support, then drop them.
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM cli_device_authorizations WHERE expires_on <= ?").bind(cutoff).run();
}
