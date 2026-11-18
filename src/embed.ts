import type { Project } from "./types";
import { newId, timestamps, type ShipletUser } from "./store";

export type EmbedExchangePurpose = "review";

export type EmbedInstallationRecord = {
  id: string;
  project_id: string;
  organization_id: string;
  site_origin: string;
  site_url: string;
  site_name: string;
  secret_hash: string;
  created_by_user_id: string;
  created_on: string;
  last_used_on: string | null;
  revoked_on: string | null;
};

type EmbedExchangeCodeRecord = {
  code_hash: string;
  purpose: EmbedExchangePurpose;
  installation_id: string | null;
  project_id: string;
  organization_id: string;
  user_id: string;
  site_origin: string;
  site_url: string;
  site_name: string;
  return_url: string;
  expires_on: string;
  used_on: string | null;
  created_on: string;
};

export type EmbedReviewSessionPublic = {
  installationId: string;
  projectId: string;
  revisionId: string;
  siteOrigin: string;
  pageUrl: string;
  expiresOn: string;
};

export type EmbedReviewSessionBinding = EmbedReviewSessionPublic & {
  actorUserId: string;
  revokedOn: string | null;
};

type EmbedReviewSessionRecord = {
  session_hash: string;
  installation_id: string;
  project_id: string;
  revision_id: string;
  site_origin: string;
  page_url: string;
  actor_user_id: string;
  expires_on: string;
  created_on: string;
};

export type EmbedReviewRequestBinding = {
  installationId: string;
  projectId: string;
  revisionId: string;
  siteOrigin: string;
  pageUrl: string;
  actorUserId: string;
  now: Date;
  operationClaimed: boolean;
};

export type EmbedReviewOperationReceiptClaimInput = {
  receiptHandle: string;
  installationId: string;
  shipletId: string;
  revisionId: string;
  actorUserId: string;
  effect: string;
  payloadDigest: string;
  requestId: string;
  now: Date;
};

const REVIEW_GRANT_PREFIX = "shiplet_embed_auth_";
// Website-widget installations carry this marker instead of a server secret.
// Rows without it belong to the retired server-secret integration and grant
// nothing.
const BROWSER_INSTALLATION_SECRET_PREFIX = "browser-only:";
const MAX_URL_LENGTH = 2_048;
const REVIEW_SESSION_COOKIE_PREFIX = "__Host-shiplet_embed_review_";
const MAX_REVIEW_SESSION_TTL_SECONDS = 5 * 60;
const MAX_EMBED_INSTALLATION_ID_LENGTH = 160;
const MAX_NESTED_REVIEW_URL_DEPTH = 8;
const CREDENTIAL_SHAPED_PAGE_QUERY_KEYS = new Set([
  "authorization_code",
  "claim",
  "claim_url",
  "code",
  "credential",
  "id_token",
  "key_pair_id",
  "magic_link",
  "nonce",
  "oauth_code",
  "oauth_token",
  "password",
  "policy",
  "presence_token",
  "reset_code",
  "session",
  "shiplet_code",
  "shiplet_embed_code",
  "sig",
  "signature",
  "signed",
  "state",
  "token",
]);

export async function createEmbedReviewSession(
  db: D1Database,
  input: {
    installation: EmbedInstallationRecord;
    project: Project;
    revisionId: string;
    user: ShipletUser;
    pageUrl: string;
    now?: Date;
    expiresOn?: Date;
  },
) {
  if (input.installation.revoked_on) {
    throw new Response("Site installation is disconnected", {
      status: 410,
    });
  }
  if (input.installation.project_id !== input.project.id) {
    throw new Response("Site installation project mismatch", {
      status: 403,
    });
  }
  const pageUrl = normalizeEmbedReviewPageUrl(
    input.pageUrl,
    input.installation.site_origin,
  );
  if (!pageUrl) {
    throw new Response("Invalid review page URL", { status: 400 });
  }
  const now = input.now || new Date();
  const expiresOn = new Date(
    Math.min(
      now.getTime() + MAX_REVIEW_SESSION_TTL_SECONDS * 1_000,
      input.expiresOn?.getTime() ?? Infinity,
    ),
  );
  if (
    !Number.isFinite(expiresOn.getTime()) ||
    expiresOn.getTime() <= now.getTime()
  ) {
    throw new Response("Embedded review session expired", { status: 401 });
  }
  const sessionHandle = secureToken("shiplet_embed_session_");
  const sessionHash = await hashToken(sessionHandle);
  await db
    .prepare(
      `INSERT INTO embed_review_sessions
			 (session_hash, installation_id, project_id, revision_id, site_origin,
			  page_url, actor_user_id, expires_on, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      sessionHash,
      input.installation.id,
      input.project.id,
      input.revisionId,
      input.installation.site_origin,
      pageUrl,
      input.user.id,
      expiresOn.toISOString(),
      now.toISOString(),
    )
    .run();
  return {
    sessionHandle,
    expiresOn,
    publicSession: {
      installationId: input.installation.id,
      projectId: input.project.id,
      revisionId: input.revisionId,
      siteOrigin: input.installation.site_origin,
      pageUrl,
      expiresOn: expiresOn.toISOString(),
    } satisfies EmbedReviewSessionPublic,
  };
}

export function readEmbedReviewSessionHandle(
  cookieHeader: string | null,
  installationId: string,
) {
  const cookieName = embedReviewSessionCookieName(installationId);
  if (!cookieHeader || !cookieName) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== cookieName) continue;
    try {
      const handle = decodeURIComponent(part.slice(separator + 1).trim());
      return /^[A-Za-z0-9._~-]{16,512}$/.test(handle) ? handle : null;
    } catch {
      return null;
    }
  }
  return null;
}

export async function getEmbedReviewSession(
  db: D1Database,
  sessionHandle: string,
  now = new Date(),
): Promise<EmbedReviewSessionBinding | null> {
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(sessionHandle)) return null;
  const sessionHash = await hashToken(sessionHandle);
  const row = await db
    .prepare(
      `SELECT session.*, installation.revoked_on
			 FROM embed_review_sessions AS session
			 JOIN embed_installations AS installation
			   ON installation.id = session.installation_id
			 WHERE session.session_hash = ?
			   AND session.expires_on > ?
			 LIMIT 1`,
    )
    .bind(sessionHash, now.toISOString())
    .first<EmbedReviewSessionRecord & { revoked_on: string | null }>();
  if (!row) return null;
  return {
    installationId: row.installation_id,
    projectId: row.project_id,
    revisionId: row.revision_id,
    siteOrigin: row.site_origin,
    pageUrl: row.page_url,
    actorUserId: row.actor_user_id,
    expiresOn: row.expires_on,
    revokedOn: row.revoked_on,
  };
}

export function createEmbedReviewSessionCookieHeader(input: {
  installationId: string;
  sessionHandle: string;
  now: Date;
  expiresOn: Date;
}) {
  const cookieName = embedReviewSessionCookieName(input.installationId);
  if (!cookieName) {
    throw new TypeError("Invalid embed installation ID");
  }
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(input.sessionHandle)) {
    throw new TypeError("Invalid embed review session handle");
  }
  const now = input.now.getTime();
  const expiresOn = input.expiresOn.getTime();
  if (!Number.isFinite(now) || !Number.isFinite(expiresOn)) {
    throw new TypeError("Invalid embed review session lifetime");
  }
  const requestedTtl = Math.floor((expiresOn - now) / 1_000);
  if (requestedTtl <= 0) {
    throw new RangeError("Embed review session has already expired");
  }
  const maxAge = Math.min(requestedTtl, MAX_REVIEW_SESSION_TTL_SECONDS);
  return [
    `${cookieName}=${encodeURIComponent(input.sessionHandle)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Partitioned",
  ].join("; ");
}

export function publicEmbedReviewSession(
  input: EmbedReviewSessionBinding & Record<string, unknown>,
): EmbedReviewSessionPublic {
  const pageUrl = normalizeEmbedReviewPageUrl(input.pageUrl, input.siteOrigin);
  if (!pageUrl) throw new TypeError("Invalid embed review page URL");
  return {
    installationId: input.installationId,
    projectId: input.projectId,
    revisionId: input.revisionId,
    siteOrigin: input.siteOrigin,
    pageUrl,
    expiresOn: input.expiresOn,
  };
}

export function validateEmbedReviewSessionBinding(
  session: EmbedReviewSessionBinding,
  request: EmbedReviewRequestBinding,
): { ok: true } | { ok: false; reason: string } {
  if (session.revokedOn !== null) {
    return { ok: false, reason: "revoked" };
  }
  const expiresOn = Date.parse(session.expiresOn);
  const now = request.now.getTime();
  if (
    !Number.isFinite(expiresOn) ||
    !Number.isFinite(now) ||
    expiresOn <= now
  ) {
    return { ok: false, reason: "expired" };
  }
  if (!request.operationClaimed) {
    return { ok: false, reason: "replayed" };
  }
  if (session.installationId !== request.installationId) {
    return { ok: false, reason: "installation_mismatch" };
  }
  if (session.projectId !== request.projectId) {
    return { ok: false, reason: "project_mismatch" };
  }
  if (session.revisionId !== request.revisionId) {
    return { ok: false, reason: "revision_mismatch" };
  }
  if (session.actorUserId !== request.actorUserId) {
    return { ok: false, reason: "actor_mismatch" };
  }
  const sessionOrigin = normalizeEmbedBindingOrigin(session.siteOrigin);
  const requestOrigin = normalizeEmbedBindingOrigin(request.siteOrigin);
  if (!sessionOrigin || !requestOrigin || sessionOrigin !== requestOrigin) {
    return { ok: false, reason: "origin_mismatch" };
  }
  const sessionPage = normalizeEmbedReviewPageUrl(
    session.pageUrl,
    sessionOrigin,
  );
  const requestPage = normalizeEmbedReviewPageUrl(
    request.pageUrl,
    requestOrigin,
  );
  if (!sessionPage || !requestPage || sessionPage !== requestPage) {
    return { ok: false, reason: "page_mismatch" };
  }
  return { ok: true };
}

export function normalizeEmbedSiteUrl(value: unknown) {
  const url = parseEmbedUrl(value);
  if (!url) return null;
  url.hash = "";
  url.search = "";
  return {
    siteUrl: url.toString(),
    siteOrigin: url.origin,
  };
}

export function normalizeEmbedReturnUrl(
  value: unknown,
  expectedOrigin: string,
) {
  return normalizeEmbedReviewPageUrl(value, expectedOrigin);
}

export function normalizeEmbedReviewPageUrl(
  value: unknown,
  expectedOrigin: string,
) {
  const url = parseEmbedUrl(value);
  if (!url || url.origin !== expectedOrigin) return null;
  return sanitizeEmbedReviewPageUrl(url, 0).toString();
}

export async function claimEmbedReviewOperationReceipt(
  db: D1Database,
  input: EmbedReviewOperationReceiptClaimInput,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isValidEmbedReviewOperationReceiptClaim(input)) {
    return { ok: false, reason: "invalid_binding" };
  }
  const claimedOn = input.now.toISOString();
  const receiptHash = await hashToken(input.receiptHandle);
  try {
    const result = await db
      .prepare(
        `UPDATE embed_review_operation_receipts
				 SET claimed_on = ?
				 WHERE receipt_hash = ?
				   AND installation_id = ?
				   AND project_id = ?
				   AND revision_id = ?
				   AND actor_user_id = ?
				   AND effect = ?
				   AND payload_digest = ?
				   AND request_id = ?
				   AND claimed_on IS NULL
				   AND expires_on > ?`,
      )
      .bind(
        claimedOn,
        receiptHash,
        input.installationId,
        input.shipletId,
        input.revisionId,
        input.actorUserId,
        input.effect,
        input.payloadDigest,
        input.requestId,
        claimedOn,
      )
      .run();
    return result.meta.changes === 1
      ? { ok: true }
      : { ok: false, reason: "invalid_expired_or_replayed" };
  } catch {
    return { ok: false, reason: "receipt_store_unavailable" };
  }
}

/**
 * Produces the storage-only receipt identifier used by the trusted kernel.
 * The opaque receipt itself must stay in the trusted host request and is never
 * persisted or forwarded to arbitrary artifact/widget code.
 */
export async function digestEmbedReviewOperationReceiptHandle(value: unknown) {
  if (!isBoundedReceiptValue(value, 16, 512)) return null;
  return hashToken(value);
}

export async function createEmbedReviewGrant(
  db: D1Database,
  input: {
    installation: EmbedInstallationRecord;
    project: Project;
    user: ShipletUser;
    pageUrl: string;
  },
) {
  return createEmbedExchangeCode(db, {
    purpose: "review",
    prefix: REVIEW_GRANT_PREFIX,
    installationId: input.installation.id,
    project: input.project,
    user: input.user,
    siteOrigin: input.installation.site_origin,
    siteUrl: input.installation.site_url,
    siteName: input.installation.site_name,
    returnUrl: input.pageUrl,
    expiresInSeconds: 60,
  });
}

export async function consumeEmbedExchangeCode(
  db: D1Database,
  input: {
    code: unknown;
    purpose: EmbedExchangePurpose;
    siteOrigin: string;
  },
) {
  const code = normalizeString(input.code, 512);
  if (!code.startsWith(REVIEW_GRANT_PREFIX)) return null;
  const codeHash = await hashToken(code);
  const now = timestamps.now();
  const row = await db
    .prepare(
      `SELECT *
			 FROM embed_exchange_codes
			 WHERE code_hash = ?
			   AND purpose = ?
			   AND used_on IS NULL
			   AND expires_on > ?
			 LIMIT 1`,
    )
    .bind(codeHash, input.purpose, now)
    .first<EmbedExchangeCodeRecord>();
  if (!row || row.site_origin !== input.siteOrigin) return null;
  const claimed = await db
    .prepare(
      `UPDATE embed_exchange_codes
			 SET used_on = ?
			 WHERE code_hash = ?
			   AND used_on IS NULL
			   AND expires_on > ?`,
    )
    .bind(now, codeHash, now)
    .run();
  if (claimed.meta.changes !== 1) return null;
  return { ...row, used_on: now };
}

export async function getEmbedInstallation(
  db: D1Database,
  installationId: string,
  options: { includeRevoked?: boolean } = {},
) {
  const revokedFilter = options.includeRevoked ? "" : "AND revoked_on IS NULL";
  return db
    .prepare(
      `SELECT *
			 FROM embed_installations
			 WHERE id = ? AND ${BROWSER_INSTALLATION_FILTER} ${revokedFilter}
			 LIMIT 1`,
    )
    .bind(installationId)
    .first<EmbedInstallationRecord>();
}

/** SQL predicate that admits only website-widget installation rows. */
export const BROWSER_INSTALLATION_FILTER = `substr(secret_hash, 1, ${BROWSER_INSTALLATION_SECRET_PREFIX.length}) = '${BROWSER_INSTALLATION_SECRET_PREFIX}'`;

export function browserInstallationSecretMarker(installationId: string) {
  return `${BROWSER_INSTALLATION_SECRET_PREFIX}${installationId}`;
}

async function createEmbedExchangeCode(
  db: D1Database,
  input: {
    purpose: EmbedExchangePurpose;
    prefix: string;
    installationId: string | null;
    project: Project;
    user: ShipletUser;
    siteOrigin: string;
    siteUrl: string;
    siteName: string;
    returnUrl: string;
    expiresInSeconds: number;
  },
) {
  if (!input.project.organization_id) {
    throw new Response("Embed projects require an organization.", {
      status: 400,
    });
  }
  const code = secureToken(input.prefix);
  const codeHash = await hashToken(code);
  const createdOn = timestamps.now();
  const expiresOn = new Date(
    Date.now() + input.expiresInSeconds * 1000,
  ).toISOString();
  await db
    .prepare(
      `INSERT INTO embed_exchange_codes
			 (code_hash, purpose, installation_id, project_id, organization_id,
			  user_id, site_origin, site_url, site_name, return_url, expires_on,
			  used_on, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      codeHash,
      input.purpose,
      input.installationId,
      input.project.id,
      input.project.organization_id,
      input.user.id,
      input.siteOrigin,
      input.siteUrl,
      input.siteName,
      input.returnUrl,
      expiresOn,
      null,
      createdOn,
    )
    .run();
  return code;
}

function parseEmbedUrl(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !isLocalHostname(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function normalizeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function normalizeEmbedBindingOrigin(value: string) {
  const url = parseEmbedUrl(value);
  return url?.origin || "";
}

function embedReviewSessionCookieName(installationId: string) {
  if (
    typeof installationId !== "string" ||
    installationId.length === 0 ||
    installationId.length > MAX_EMBED_INSTALLATION_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(installationId)
  ) {
    return null;
  }
  return `${REVIEW_SESSION_COOKIE_PREFIX}${installationId}`;
}

function isCredentialShapedPageQueryKey(key: string) {
  const normalized = key.trim().toLowerCase().replace(/-/g, "_");
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return (
    CREDENTIAL_SHAPED_PAGE_QUERY_KEYS.has(normalized) ||
    normalized.startsWith("x_amz_") ||
    compact.includes("token") ||
    compact.includes("secret") ||
    compact.includes("password") ||
    compact.includes("credential") ||
    compact.includes("authorization") ||
    compact.includes("signature") ||
    compact === "apikey" ||
    compact === "keypairid"
  );
}

function sanitizeEmbedReviewPageUrl(url: URL, depth: number): URL {
  const fragment = url.hash;
  url.hash = "";
  if (fragment.startsWith("#/") && !fragment.startsWith("#//") && depth < 8) {
    const route = new URL(fragment.slice(1), url.origin);
    if (route.origin === url.origin) {
      const sanitized = sanitizeEmbedReviewPageUrl(route, depth + 1);
      url.hash = `#${sanitized.pathname}${sanitized.search}`;
    }
  }
  const entries = Array.from(url.searchParams.entries());
  url.search = "";
  for (const [key, value] of entries) {
    if (isCredentialShapedPageQueryKey(key)) continue;
    const nested = parseEmbedUrl(value);
    if (!nested) {
      url.searchParams.append(key, value);
      continue;
    }
    if (depth >= MAX_NESTED_REVIEW_URL_DEPTH) continue;
    url.searchParams.append(
      key,
      sanitizeEmbedReviewPageUrl(nested, depth + 1).toString(),
    );
  }
  return url;
}

function isValidEmbedReviewOperationReceiptClaim(
  input: EmbedReviewOperationReceiptClaimInput,
): boolean {
  const now = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  return (
    Number.isFinite(now) &&
    isBoundedReceiptValue(input.receiptHandle, 16, 512) &&
    isBoundedReceiptIdentifier(input.installationId) &&
    isBoundedReceiptIdentifier(input.shipletId) &&
    isBoundedReceiptIdentifier(input.revisionId) &&
    isBoundedReceiptIdentifier(input.actorUserId) &&
    isBoundedReceiptIdentifier(input.effect) &&
    /^sha256:[a-f0-9]{64}$/.test(input.payloadDigest) &&
    isBoundedReceiptIdentifier(input.requestId)
  );
}

function isBoundedReceiptIdentifier(value: unknown): value is string {
  return (
    isBoundedReceiptValue(value, 1, 256) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function isBoundedReceiptValue(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxLength &&
    new TextEncoder().encode(value).byteLength <= maxLength
  );
}

function normalizeString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function secureToken(prefix: string) {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
