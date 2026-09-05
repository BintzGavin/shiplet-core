import type { Project } from "./types";
import { newId, timestamps, type ShipletUser } from "./store";

export type EmbedExchangePurpose = "connection";

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

export type EmbedConnectionRequest = {
  siteUrl: string;
  siteOrigin: string;
  siteName: string;
  returnUrl: string;
  state: string;
  projectId: string;
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

const CONNECTION_CODE_PREFIX = "shiplet_embed_connect_";
const INSTALLATION_SECRET_PREFIX = "shiplet_embed_install_";
const MAX_URL_LENGTH = 2_048;
const MAX_SITE_NAME_LENGTH = 160;
const MAX_STATE_LENGTH = 512;
const CONNECTION_CODE_TTL_SECONDS = 5 * 60;
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
  },
) {
  if (input.installation.revoked_on) {
    throw new Response("WordPress installation is disconnected", {
      status: 410,
    });
  }
  if (input.installation.project_id !== input.project.id) {
    throw new Response("WordPress installation project mismatch", {
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
    now.getTime() + MAX_REVIEW_SESSION_TTL_SECONDS * 1_000,
  );
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

export function normalizeEmbedConnectionRequest(
  input: Record<string, unknown>,
): EmbedConnectionRequest | null {
  const site = normalizeEmbedSiteUrl(input.site_url ?? input.siteUrl);
  if (!site) return null;
  const returnUrl = normalizeEmbedReturnUrl(
    input.return_url ?? input.returnUrl,
    site.siteOrigin,
  );
  if (!returnUrl) return null;
  const siteName = normalizeString(
    input.site_name ?? input.siteName,
    MAX_SITE_NAME_LENGTH,
  );
  const state = normalizeString(input.state, MAX_STATE_LENGTH);
  const projectId = normalizeString(input.project_id ?? input.projectId, 160);
  return {
    ...site,
    siteName: siteName || new URL(site.siteUrl).hostname,
    returnUrl,
    state,
    projectId,
  };
}

export function appendEmbedRedirectParams(
  returnUrl: string,
  params: Record<string, string>,
) {
  const url = new URL(returnUrl);
  for (const [name, value] of Object.entries(params)) {
    if (value) url.searchParams.set(name, value);
  }
  return url.toString();
}

export async function createEmbedConnectionCode(
  db: D1Database,
  input: {
    project: Project;
    user: ShipletUser;
    siteOrigin: string;
    siteUrl: string;
    siteName: string;
    returnUrl: string;
  },
) {
  return createEmbedExchangeCode(db, {
    purpose: "connection",
    prefix: CONNECTION_CODE_PREFIX,
    installationId: null,
    project: input.project,
    user: input.user,
    siteOrigin: input.siteOrigin,
    siteUrl: input.siteUrl,
    siteName: input.siteName,
    returnUrl: input.returnUrl,
    expiresInSeconds: CONNECTION_CODE_TTL_SECONDS,
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
  if (!code.startsWith(CONNECTION_CODE_PREFIX)) return null;
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

export async function createEmbedInstallation(
  db: D1Database,
  code: EmbedExchangeCodeRecord,
) {
  const secret = secureToken(INSTALLATION_SECRET_PREFIX);
  const secretHash = await hashToken(secret);
  const now = timestamps.now();
  const installation: EmbedInstallationRecord = {
    id: newId("embed_installation"),
    project_id: code.project_id,
    organization_id: code.organization_id,
    site_origin: code.site_origin,
    site_url: code.site_url,
    site_name: code.site_name,
    secret_hash: secretHash,
    created_by_user_id: code.user_id,
    created_on: now,
    last_used_on: null,
    revoked_on: null,
  };

  await db.batch([
    db
      .prepare(
        `UPDATE embed_installations
				 SET revoked_on = ?
				 WHERE site_origin = ? AND revoked_on IS NULL`,
      )
      .bind(now, installation.site_origin),
    db
      .prepare(
        `INSERT INTO embed_installations
				 (id, project_id, organization_id, site_origin, site_url, site_name,
				  secret_hash, created_by_user_id, created_on, last_used_on, revoked_on)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        installation.id,
        installation.project_id,
        installation.organization_id,
        installation.site_origin,
        installation.site_url,
        installation.site_name,
        installation.secret_hash,
        installation.created_by_user_id,
        installation.created_on,
        installation.last_used_on,
        installation.revoked_on,
      ),
  ]);

  return {
    installation: publicEmbedInstallation(installation),
    secret,
  };
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
			 WHERE id = ? ${revokedFilter}
			 LIMIT 1`,
    )
    .bind(installationId)
    .first<EmbedInstallationRecord>();
}

export async function authenticateEmbedInstallation(
  db: D1Database,
  installationId: string,
  authorization: string | null | undefined,
) {
  const secret = parseBearerToken(authorization);
  if (!secret?.startsWith(INSTALLATION_SECRET_PREFIX)) return null;
  const secretHash = await hashToken(secret);
  const installation = await db
    .prepare(
      `SELECT *
			 FROM embed_installations
			 WHERE id = ? AND secret_hash = ? AND revoked_on IS NULL
			 LIMIT 1`,
    )
    .bind(installationId, secretHash)
    .first<EmbedInstallationRecord>();
  if (!installation) return null;
  await db
    .prepare(
      `UPDATE embed_installations
			 SET last_used_on = ?
			 WHERE id = ? AND revoked_on IS NULL`,
    )
    .bind(timestamps.now(), installation.id)
    .run();
  return installation;
}

export async function revokeEmbedInstallation(
  db: D1Database,
  installationId: string,
) {
  const revokedOn = timestamps.now();
  const result = await db
    .prepare(
      `UPDATE embed_installations
			 SET revoked_on = ?
			 WHERE id = ? AND revoked_on IS NULL`,
    )
    .bind(revokedOn, installationId)
    .run();
  return result.meta.changes === 1;
}

export function publicEmbedInstallation(installation: EmbedInstallationRecord) {
  return {
    id: installation.id,
    projectId: installation.project_id,
    organizationId: installation.organization_id,
    siteOrigin: installation.site_origin,
    siteUrl: installation.site_url,
    siteName: installation.site_name,
    createdOn: installation.created_on,
    lastUsedOn: installation.last_used_on,
    revokedOn: installation.revoked_on,
  };
}

export function embedClientScript() {
  return String.raw`
(() => {
	const embed = window.__SHIPLET_EMBED__;
	const mountKey = "__SHIPLET_EMBED_CLIENT_MOUNTED__";
	if (!embed || !embed.installationId || window[mountKey]) return;
	const scriptSource = document.currentScript && document.currentScript.src;
	if (!scriptSource) return;
	let scriptUrl;
	try {
		scriptUrl = new URL(scriptSource, location.href);
	} catch {
		return;
	}
	if (scriptUrl.protocol !== "https:" && scriptUrl.hostname !== "localhost") return;

	const installationId = String(embed.installationId).trim();
	if (!/^[A-Za-z0-9_-]{1,160}$/.test(installationId)) return;
	const pageUrl = new URL(location.href);
	pageUrl.hash = "";
	const credentialKeys = new Set(["authorization_code", "claim", "claim_url", "code", "credential", "id_token", "key_pair_id", "magic_link", "nonce", "oauth_code", "oauth_token", "password", "policy", "presence_token", "reset_code", "session", "shiplet_code", "shiplet_embed_code", "sig", "signature", "signed", "state", "token"]);
	function isCredentialKey(key) {
		const normalized = String(key).trim().toLowerCase().replace(/-/g, "_");
		const compact = normalized.replace(/[^a-z0-9]/g, "");
		return credentialKeys.has(normalized) || normalized.startsWith("x_amz_") || compact.includes("token") || compact.includes("secret") || compact.includes("password") || compact.includes("credential") || compact.includes("authorization") || compact.includes("signature") || compact === "apikey" || compact === "keypairid";
	}
	function parsePageCandidate(value) {
		if (typeof value !== "string" || value.length > 2048) return null;
		try {
			const candidate = new URL(value);
			const localHttp = candidate.protocol === "http:" && (candidate.hostname === "localhost" || candidate.hostname === "127.0.0.1" || candidate.hostname === "[::1]" || candidate.hostname.endsWith(".localhost"));
			if ((candidate.protocol !== "https:" && !localHttp) || candidate.username || candidate.password) return null;
			return candidate;
		} catch {
			return null;
		}
	}
	function sanitizePage(candidate, depth) {
		candidate.hash = "";
		const entries = Array.from(candidate.searchParams.entries());
		candidate.search = "";
		for (const [key, value] of entries) {
			if (isCredentialKey(key)) continue;
			const nested = parsePageCandidate(value);
			if (!nested) {
				candidate.searchParams.append(key, value);
				continue;
			}
			if (depth >= 8) continue;
			candidate.searchParams.append(key, sanitizePage(nested, depth + 1).toString());
		}
		return candidate;
	}
	sanitizePage(pageUrl, 0);

	const start = new URL("/embed/review/start", scriptUrl.origin);
	start.searchParams.set("installation_id", installationId);
	start.searchParams.set("return_url", pageUrl.toString());

	const frame = document.createElement("iframe");
	frame.src = start.toString();
	frame.title = "Review this page in Shiplet";
	frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox");
	frame.setAttribute("referrerpolicy", "no-referrer");
	frame.setAttribute("loading", "lazy");
	frame.setAttribute("aria-label", frame.title);
	frame.style.cssText = "position:fixed;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));height:min(680px,calc(100vh - 32px));z-index:2147483647;border:0;border-radius:12px;background:#fff;box-shadow:0 16px 48px rgba(15,23,42,.28)";
	frame.dataset.shipletTrustedReview = "";
	window[mountKey] = true;
	document.body.appendChild(frame);
})();
`;
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
  url.hash = "";
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

function parseBearerToken(authorization: string | null | undefined) {
  if (!authorization) return null;
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null;
}
