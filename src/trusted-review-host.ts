import {
  AVATAR_PRESETS,
  AVATAR_SPRITE_COLUMNS,
  AVATAR_SPRITE_ROWS,
  AVATAR_SPRITE_URL,
} from "./avatars";

export interface TrustedReviewHostInput {
  shipletId: string;
  revisionId: string;
  title: string;
  artifactUrl: string;
  widgetUrl: string | null;
  hostScriptUrl: string;
  reviewApiUrl: string;
  confirmationUrl?: string;
  reviewPageUrl?: string;
  submissionMode?: "confirmation" | "sandbox";
  allowArtifactDownloads?: boolean;
  frameAncestorOrigins?: string[];
  reviewState?: TrustedReviewHostState;
}

export type TrustedReviewHostState =
  | "ready"
  | "expired"
  | "revoked"
  | "permission_denied"
  | "offline";

export type TrustedWidgetOperationRequest =
  | {
      requestId: string;
      operation: "feedback.create";
      payload: { comment: string };
    }
  | {
      requestId: string;
      operation: "workflow.event.create";
      payload: {
        status: string;
        summary: string;
        fields: Record<string, unknown>;
      };
    };

export type TrustedWidgetOperationEvent = {
  source: unknown;
  origin: string;
  data: unknown;
};

export type TrustedWidgetOperationBinding = {
  expectedSource: unknown;
  channelNonce: string;
  shipletId: string;
  revisionId: string;
  usedRequestIds?: ReadonlySet<string>;
};

export interface SandboxedArtifactResponseInput {
  body: BodyInit;
  contentType: string;
  role: "artifact" | "widget" | "review_context";
  trustedHostOrigin: string;
  widgetRuntime?: {
    scriptSource: string;
    shipletId: string;
    revisionId: string;
  };
  allowedEgressOrigins?: string[];
  allowDownloads?: boolean;
  status?: number;
  sourceHeaders?: Headers;
}

const SENSITIVE_FRAME_QUERY_KEYS = new Set([
  "access_token",
  "authorization_code",
  "bearer",
  "claim",
  "claim_url",
  "code",
  "credential",
  "oauth_token",
  "presence_token",
  "review_token",
  "session",
  "shiplet_preview_token",
  "token",
]);

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

const TRUSTED_WIDGET_REQUEST_KEYS = new Set([
  "protocol",
  "type",
  "requestId",
  "channelNonce",
  "shipletId",
  "revisionId",
  "operation",
  "payload",
]);

const MAX_NESTED_REVIEW_URL_DEPTH = 8;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8Length(value) > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isLocalDevelopmentHttpUrl(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return (
    url.protocol === "http:" &&
    (hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "127.0.0.1" ||
      hostname === "[::]" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost"))
  );
}

function parseHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid HTTPS ${label} URL`);
  }
  const localHttp = isLocalDevelopmentHttpUrl(url);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`Invalid HTTPS ${label} URL`);
  }
  return url;
}

function parseFrameUrl(value: string): URL {
  const url = parseHttpsUrl(value, "frame");
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_FRAME_QUERY_KEYS.has(key.toLowerCase())) {
      throw new TypeError("Credential-bearing frame URL is forbidden");
    }
  }
  return url;
}

function parseReviewApiUrl(value: string): URL {
  const url = parseHttpsUrl(value, "review API");
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_FRAME_QUERY_KEYS.has(key.toLowerCase())) {
      throw new TypeError("Credential-bearing review API URL is forbidden");
    }
  }
  return url;
}

function parseConfirmationUrl(value: string, trustedOrigin: string): URL {
  const url = parseHttpsUrl(value, "confirmation");
  if (
    url.origin !== trustedOrigin ||
    (url.pathname !== "/embed/review/confirm" &&
      url.pathname !== "/review/confirm") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Invalid confirmation URL or origin");
  }
  return url;
}

function isCredentialShapedPageQueryKey(key: string): boolean {
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

function parseReviewPageUrl(value: string, allowLocalKernelHttp = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Invalid HTTPS review page URL");
  }
  const localHttp =
    isLocalDevelopmentHttpUrl(url) ||
    (allowLocalKernelHttp && url.protocol === "http:");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new TypeError("Invalid HTTPS review page URL");
  }
  return sanitizeReviewPageUrl(url, 0);
}

function sanitizeReviewPageUrl(url: URL, depth: number): URL {
  url.hash = "";
  const entries = Array.from(url.searchParams.entries());
  url.search = "";
  for (const [key, value] of entries) {
    if (isCredentialShapedPageQueryKey(key)) continue;
    let nested: URL;
    try {
      nested = new URL(value);
      const localHttp = isLocalDevelopmentHttpUrl(nested);
      if (
        (nested.protocol !== "https:" && !localHttp) ||
        nested.username !== "" ||
        nested.password !== ""
      ) {
        throw new TypeError("Invalid nested review page URL");
      }
    } catch {
      url.searchParams.append(key, value);
      continue;
    }
    if (depth >= MAX_NESTED_REVIEW_URL_DEPTH) continue;
    url.searchParams.append(
      key,
      sanitizeReviewPageUrl(nested, depth + 1).toString(),
    );
  }
  return url;
}

function parseOrigin(value: string, label: string): string {
  const url = parseHttpsUrl(value, label);
  if (
    (value !== url.origin && value !== `${url.origin}/`) ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`Invalid ${label} origin`);
  }
  return url.origin;
}

function securityHeaders(
  contentSecurityPolicy: string,
  referrerPolicy = "no-referrer",
): Headers {
  return new Headers({
    "cache-control": "private, no-store, no-transform",
    "content-security-policy": contentSecurityPolicy,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
    "referrer-policy": referrerPolicy,
    "x-content-type-options": "nosniff",
  });
}

function createDocumentNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: Set<string>) {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Length(value) <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

export function validateTrustedWidgetOperationRequest(
  event: TrustedWidgetOperationEvent,
  binding: TrustedWidgetOperationBinding,
):
  | { ok: true; request: TrustedWidgetOperationRequest }
  | { ok: false; reason: string } {
  if (!binding.expectedSource || event.source !== binding.expectedSource) {
    return { ok: false, reason: "source_mismatch" };
  }
  if (event.origin !== "null") {
    return { ok: false, reason: "origin_mismatch" };
  }
  if (!isRecord(event.data)) {
    return { ok: false, reason: "malformed" };
  }
  try {
    if (utf8Length(JSON.stringify(event.data)) > 16_384) {
      return { ok: false, reason: "oversized" };
    }
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!hasExactKeys(event.data, TRUSTED_WIDGET_REQUEST_KEYS)) {
    return { ok: false, reason: "malformed" };
  }
  if (
    event.data.protocol !== "shiplet.widget.operation.v1" ||
    event.data.type !== "request" ||
    event.data.channelNonce !== binding.channelNonce ||
    event.data.shipletId !== binding.shipletId ||
    event.data.revisionId !== binding.revisionId ||
    !isBoundedIdentifier(event.data.requestId) ||
    binding.usedRequestIds?.has(event.data.requestId) === true ||
    !isRecord(event.data.payload)
  ) {
    return { ok: false, reason: "binding_or_operation_mismatch" };
  }
  if (event.data.operation === "workflow.event.create") {
    if (
      !hasExactKeys(
        event.data.payload,
        new Set(["status", "summary", "fields"]),
      ) ||
      typeof event.data.payload.status !== "string" ||
      event.data.payload.status.trim().length === 0 ||
      event.data.payload.status.length > 128 ||
      typeof event.data.payload.summary !== "string" ||
      event.data.payload.summary.trim().length === 0 ||
      utf8Length(event.data.payload.summary.trim()) > 512 ||
      !isRecord(event.data.payload.fields)
    ) {
      return { ok: false, reason: "invalid_payload" };
    }
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(JSON.stringify(event.data.payload.fields));
    } catch {
      return { ok: false, reason: "invalid_payload" };
    }
    if (!isRecord(fields)) return { ok: false, reason: "invalid_payload" };
    return {
      ok: true,
      request: {
        requestId: event.data.requestId,
        operation: "workflow.event.create",
        payload: {
          status: event.data.payload.status.trim(),
          summary: event.data.payload.summary.trim(),
          fields,
        },
      },
    };
  }
  if (
    event.data.operation !== "feedback.create" ||
    !hasExactKeys(event.data.payload, new Set(["comment"]))
  ) {
    return { ok: false, reason: "binding_or_operation_mismatch" };
  }
  const comment = event.data.payload.comment;
  if (
    typeof comment !== "string" ||
    comment.trim().length === 0 ||
    comment.length > 5_000 ||
    utf8Length(comment.trim()) > 6_000
  ) {
    return { ok: false, reason: "invalid_payload" };
  }
  return {
    ok: true,
    request: {
      requestId: event.data.requestId,
      operation: "feedback.create",
      payload: { comment: comment.trim() },
    },
  };
}

export function projectTrustedWidgetConfirmation(
  request: TrustedWidgetOperationRequest,
) {
  if (request.operation === "workflow.event.create") {
    if (
      !isBoundedIdentifier(request.requestId) ||
      !isRecord(request.payload) ||
      typeof request.payload.status !== "string" ||
      typeof request.payload.summary !== "string" ||
      !isRecord(request.payload.fields)
    ) {
      throw new TypeError("Invalid trusted widget confirmation request");
    }
    return {
      requestId: request.requestId,
      operation: request.operation,
      heading: "Custom widget requests a workflow action",
      summary: `${request.payload.status}: ${request.payload.summary}`,
      fieldsText: Object.keys(request.payload.fields)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => `${key}: ${JSON.stringify(request.payload.fields[key])}`)
        .join("\n"),
      confirmLabel: "Record workflow event",
    } as const;
  }
  if (
    !isBoundedIdentifier(request.requestId) ||
    request.operation !== "feedback.create" ||
    !isRecord(request.payload) ||
    typeof request.payload.comment !== "string" ||
    request.payload.comment.length === 0 ||
    request.payload.comment.length > 5_000 ||
    utf8Length(request.payload.comment) > 6_000
  ) {
    throw new TypeError("Invalid trusted widget confirmation request");
  }
  return {
    requestId: request.requestId,
    operation: request.operation,
    heading: "Custom widget requests an action",
    summary: request.payload.comment,
    confirmLabel: "Send feedback",
  } as const;
}

export function createTrustedReviewHostResponse(
  input: TrustedReviewHostInput,
): Response {
  assertIdentifier(input.shipletId, "Shiplet ID");
  assertIdentifier(input.revisionId, "revision ID");
  if (
    typeof input.title !== "string" ||
    input.title.length === 0 ||
    utf8Length(input.title) > 512
  ) {
    throw new TypeError("Invalid review title");
  }
  const reviewState = input.reviewState ?? "ready";
  if (
    !["ready", "expired", "revoked", "permission_denied", "offline"].includes(
      reviewState,
    )
  ) {
    throw new TypeError("Invalid trusted review state");
  }
  const frameAncestorOrigins = Array.from(
    new Set(
      (input.frameAncestorOrigins ?? []).map((origin) =>
        parseOrigin(origin, "frame ancestor"),
      ),
    ),
  ).sort();
  const frameAncestors = `frame-ancestors 'self'${
    frameAncestorOrigins.length ? ` ${frameAncestorOrigins.join(" ")}` : ""
  }`;
  const title = escapeHtml(input.title);
  if (reviewState !== "ready") {
    const states = {
      expired: {
        status: 401,
        heading: "Review session expired",
        message:
          "This review session has expired. Reopen Shiplet review to continue.",
      },
      revoked: {
        status: 410,
        heading: "Review access revoked",
        message: "This review access has been revoked by its owner.",
      },
      permission_denied: {
        status: 403,
        heading: "Permission required",
        message: "You do not have permission to review this Shiplet.",
      },
      offline: {
        status: 503,
        heading: "Review is offline",
        message:
          "Shiplet review is offline. Try again when connectivity returns.",
      },
    } as const;
    const state = states[reviewState];
    const csp = [
      "default-src 'none'",
      "script-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "img-src 'none'",
      "style-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      frameAncestors,
    ].join("; ");
    const html = `<!doctype html>
<html lang="en" data-shiplet-trusted-review-host="v1" data-shiplet-id="${escapeHtml(input.shipletId)}" data-revision-id="${escapeHtml(input.revisionId)}" data-review-state="${reviewState}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(state.heading)} · Shiplet</title></head>
<body><main aria-label="${title}"><section id="shiplet-kernel-review-panel" role="alert" aria-live="assertive"><h1>${escapeHtml(state.heading)}</h1><p>${escapeHtml(state.message)}</p></section></main></body>
</html>`;
    const headers = securityHeaders(csp);
    headers.set("content-type", "text/html; charset=utf-8");
    if (reviewState === "offline") headers.set("retry-after", "30");
    return new Response(html, { status: state.status, headers });
  }
  const artifactUrl = parseFrameUrl(input.artifactUrl);
  const widgetUrl =
    input.widgetUrl === null ? null : parseFrameUrl(input.widgetUrl);
  const hostScriptUrl = parseHttpsUrl(input.hostScriptUrl, "host script");
  const reviewApiUrl = parseReviewApiUrl(input.reviewApiUrl);
  const confirmationUrl = parseConfirmationUrl(
    input.confirmationUrl ??
      new URL("/embed/review/confirm", hostScriptUrl.origin).toString(),
    hostScriptUrl.origin,
  );
  const reviewPageUrl = input.reviewPageUrl
    ? parseReviewPageUrl(
        input.reviewPageUrl,
        isLocalDevelopmentHttpUrl(hostScriptUrl),
      ).toString()
    : artifactUrl.toString();
  const submissionMode = input.submissionMode ?? "confirmation";
  if (submissionMode !== "confirmation" && submissionMode !== "sandbox") {
    throw new TypeError("Invalid review submission mode");
  }
  const frameOrigins = Array.from(
    new Set([artifactUrl.origin, ...(widgetUrl ? [widgetUrl.origin] : [])]),
  ).sort();
  const connectOrigins = Array.from(
    new Set([hostScriptUrl.origin, reviewApiUrl.origin]),
  ).sort();
  const websocketOrigins = connectOrigins.map((origin) => {
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.origin;
  });
  const nonce = createDocumentNonce();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "script-src-attr 'none'",
    `connect-src ${Array.from(new Set([...connectOrigins, ...websocketOrigins]))
      .sort()
      .join(" ")}`,
    `frame-src ${frameOrigins.join(" ")}`,
    "img-src 'self' data: blob:",
    `style-src ${hostScriptUrl.origin}`,
    "base-uri 'none'",
    `form-action ${confirmationUrl.origin}`,
    frameAncestors,
  ].join("; ");
  const artifactSandbox = input.allowArtifactDownloads
    ? "allow-scripts allow-forms allow-downloads"
    : "allow-scripts allow-forms";
  const widgetSandbox = "allow-scripts allow-forms";
  const widget = widgetUrl
    ? `<iframe data-shiplet-widget-frame="v1" title="Review widget for ${title}" src="${escapeHtml(widgetUrl.toString())}" sandbox="${widgetSandbox}" referrerpolicy="no-referrer"></iframe>`
    : "";
  const html = `<!doctype html>
<html lang="en" data-shiplet-trusted-review-host="v1" data-review-state="ready" data-shiplet-id="${escapeHtml(input.shipletId)}" data-revision-id="${escapeHtml(input.revisionId)}" data-review-api-url="${escapeHtml(reviewApiUrl.toString())}" data-review-confirm-url="${escapeHtml(confirmationUrl.toString())}" data-review-page-url="${escapeHtml(reviewPageUrl)}" data-review-submission-mode="${submissionMode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Shiplet</title>
<link rel="stylesheet" href="${escapeHtml(`${hostScriptUrl.origin}/api/review/host.css`)}">
<script src="${escapeHtml(hostScriptUrl.toString())}" nonce="${nonce}" defer></script>
</head>
<body>
<main aria-label="${title}">
<iframe data-shiplet-artifact-frame="v1" title="Artifact for ${title}" src="${escapeHtml(artifactUrl.toString())}" sandbox="${artifactSandbox}" referrerpolicy="no-referrer"></iframe>
<section id="shiplet-kernel-review-panel" aria-label="Review ${title}" aria-live="polite" hidden>
<div data-shiplet-kernel-review-controls="v1"></div>
${widget}
<section data-shiplet-widget-confirmation="v1" hidden aria-live="assertive"><h3></h3><p></p><pre data-shiplet-widget-confirmation-fields hidden aria-label="Workflow fields"></pre><button type="button" data-shiplet-widget-confirm>Send feedback</button><button type="button" data-shiplet-widget-cancel>Cancel</button></section>
</section>
</main>
</body>
</html>`;
  const headers = securityHeaders(csp, "strict-origin");
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status: 200, headers });
}

export function trustedReviewHostScript(): string {
  const avatarPresets = JSON.stringify(AVATAR_PRESETS).replace(/</g, "\\u003c");
  const avatarSpriteUrl = JSON.stringify(AVATAR_SPRITE_URL).replace(
    /</g,
    "\\u003c",
  );
  return String.raw`(() => {
	"use strict";
	const page = document.documentElement;
	const panel = document.getElementById("shiplet-kernel-review-panel");
	const controls = document.querySelector("[data-shiplet-kernel-review-controls]");
	const apiUrl = page.getAttribute("data-review-api-url") || "";
	const reviewConfirmationUrl = page.getAttribute("data-review-confirm-url") || "";
	const reviewPageUrl = page.getAttribute("data-review-page-url") || location.href;
	const reviewSubmissionMode = page.getAttribute("data-review-submission-mode") === "sandbox" ? "sandbox" : "confirmation";
	const shipletId = page.getAttribute("data-shiplet-id") || "";
	const revisionId = page.getAttribute("data-revision-id") || "";
	const avatarPresets = ${avatarPresets};
	const avatarSpriteUrl = ${avatarSpriteUrl};
	const avatarSpriteColumns = ${AVATAR_SPRITE_COLUMNS};
	const avatarSpriteRows = ${AVATAR_SPRITE_ROWS};
	let reviewPath = "/";
	try { reviewPath = new URL(reviewPageUrl).pathname || "/"; } catch {}
	const artifact = document.querySelector("[data-shiplet-artifact-frame]");
	const widget = document.querySelector("[data-shiplet-widget-frame]");
	const widgetFrameUrl = widget ? new URL(widget.getAttribute("src") || "", location.href).toString() : "";
	const confirmation = document.querySelector("[data-shiplet-widget-confirmation]");
	const confirmationHeading = confirmation && confirmation.querySelector("h3");
	const confirmationSummary = confirmation && confirmation.querySelector("p");
	const confirmationFields = confirmation && confirmation.querySelector("[data-shiplet-widget-confirmation-fields]");
	const confirm = confirmation && confirmation.querySelector("[data-shiplet-widget-confirm]");
	const cancel = confirmation && confirmation.querySelector("[data-shiplet-widget-cancel]");
	if (!panel || !controls || !apiUrl || !reviewConfirmationUrl || !shipletId || !revisionId) return;

	const launcher = document.createElement("button");
	launcher.type = "button";
	launcher.className = "shiplet-review-launcher";
	launcher.textContent = "Annotate";
	launcher.setAttribute("aria-controls", "shiplet-annotation-composer");
	launcher.setAttribute("aria-expanded", "false");
	launcher.setAttribute("aria-keyshortcuts", "c");
	launcher.setAttribute("aria-label", "Annotate " + revisionId + " at " + reviewPath);
	launcher.setAttribute("title", "Annotate this revision · C");
	launcher.setAttribute("data-panel-open", "false");
	const launcherDock = document.createElement("div");
	launcherDock.className = "shiplet-review-launcher-dock";
	const commentsLauncher = document.createElement("button");
	commentsLauncher.type = "button";
	commentsLauncher.className = "shiplet-review-comments-launcher";
	commentsLauncher.setAttribute("aria-controls", "shiplet-kernel-review-panel");
	commentsLauncher.setAttribute("aria-expanded", "false");
	commentsLauncher.setAttribute("aria-label", "Open comments for " + revisionId);
	commentsLauncher.setAttribute("title", "Comments");
	const launcherCount = document.createElement("span");
	launcherCount.className = "shiplet-review-count";
	launcherCount.textContent = "0";
	launcherCount.setAttribute("aria-label", "0 comments");
	commentsLauncher.appendChild(launcherCount);
	launcherDock.append(launcher, commentsLauncher);
	const header = document.createElement("header");
	header.className = "shiplet-review-head";
	const headingGroup = document.createElement("div");
	headingGroup.className = "shiplet-review-heading";
	const heading = document.createElement("h2");
	heading.textContent = "Comments";
	const contextDisclosure = document.createElement("details");
	contextDisclosure.className = "shiplet-review-context-disclosure";
	const contextSummary = document.createElement("summary");
	contextSummary.setAttribute("data-shiplet-review-context-summary", "v1");
	const context = document.createElement("p");
	context.className = "shiplet-review-context";
	context.textContent = "Shiplet " + shipletId + " · Revision " + revisionId + " · " + reviewPath;
	contextSummary.textContent = reviewPath;
	contextSummary.setAttribute("aria-label", "Show exact review context for " + reviewPath);
	contextDisclosure.append(contextSummary, context);
	headingGroup.append(heading, contextDisclosure);
	const actions = document.createElement("div");
	actions.className = "shiplet-review-actions";
	const previousButton = document.createElement("button");
	previousButton.type = "button";
	previousButton.className = "shiplet-review-icon shiplet-review-nav";
	previousButton.textContent = "↑";
	previousButton.setAttribute("aria-label", "Previous comment");
	previousButton.setAttribute("data-shiplet-review-previous", "v1");
	const nextButton = document.createElement("button");
	nextButton.type = "button";
	nextButton.className = "shiplet-review-icon shiplet-review-nav";
	nextButton.textContent = "↓";
	nextButton.setAttribute("aria-label", "Next comment");
	nextButton.setAttribute("data-shiplet-review-next", "v1");
	const composeButton = document.createElement("button");
	composeButton.type = "button";
	composeButton.className = "shiplet-review-secondary shiplet-review-compose";
	composeButton.textContent = "+";
	composeButton.setAttribute("aria-label", "New comment");
	composeButton.setAttribute("title", "New comment");
	composeButton.setAttribute("data-shiplet-review-compose", "v1");
	const refreshButton = document.createElement("button");
	refreshButton.type = "button";
	refreshButton.className = "shiplet-review-secondary";
	refreshButton.textContent = "Refresh";
	refreshButton.setAttribute("data-shiplet-review-refresh", "v1");
	const watchButton = document.createElement("button");
	watchButton.type = "button";
	watchButton.className = "shiplet-review-secondary";
	watchButton.textContent = "Watch artifact";
	watchButton.setAttribute("aria-pressed", "false");
	watchButton.setAttribute("data-shiplet-review-watch", "v1");
	const optionsMenu = document.createElement("details");
	optionsMenu.className = "shiplet-review-options";
	const optionsSummary = document.createElement("summary");
	optionsSummary.textContent = "•••";
	optionsSummary.setAttribute("aria-label", "Review options");
	const optionsActions = document.createElement("div");
	optionsActions.append(watchButton, refreshButton);
	optionsMenu.append(optionsSummary, optionsActions);
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "shiplet-review-icon";
	closeButton.textContent = "Close";
	closeButton.setAttribute("aria-label", "Close review panel");
	closeButton.setAttribute("data-shiplet-review-close", "v1");
	actions.append(previousButton, nextButton, composeButton, optionsMenu, closeButton);
	header.append(headingGroup, actions);
	const status = document.createElement("p");
	status.className = "shiplet-review-status";
	status.setAttribute("role", "status");
	const list = document.createElement("ol");
	list.className = "shiplet-review-list";
	list.setAttribute("aria-label", "Review comments");
	list.setAttribute("aria-busy", "true");
	const form = document.createElement("form");
	form.className = "shiplet-review-form";
	form.id = "shiplet-annotation-composer";
	form.setAttribute("data-annotation-state", "compact");
	form.setAttribute("aria-label", "Annotation for " + revisionId + " at " + reviewPath);
	const annotationCardHeader = document.createElement("header");
	annotationCardHeader.className = "shiplet-annotation-card-header";
	const annotationCardHeading = document.createElement("div");
	annotationCardHeading.className = "shiplet-annotation-card-heading";
	const annotationCardTitle = document.createElement("strong");
	annotationCardTitle.className = "shiplet-annotation-card-title";
	annotationCardTitle.textContent = "New annotation";
	const annotationExactContext = document.createElement("span");
	annotationExactContext.className = "shiplet-annotation-exact-context";
	annotationExactContext.textContent = "Revision " + revisionId + " · " + reviewPath;
	annotationExactContext.title = "Shiplet " + shipletId;
	annotationCardHeading.append(annotationCardTitle, annotationExactContext);
	const annotationCardControls = document.createElement("div");
	annotationCardControls.className = "shiplet-annotation-card-controls";
	const dragHandle = document.createElement("button");
	dragHandle.type = "button";
	dragHandle.className = "shiplet-annotation-drag-handle";
	dragHandle.textContent = "Drag";
	dragHandle.setAttribute("aria-label", "Move annotation card");
	dragHandle.setAttribute("title", "Drag to move annotation card");
	dragHandle.setAttribute("data-shiplet-annotation-drag-handle", "v1");
	const closeAnnotationCard = document.createElement("button");
	closeAnnotationCard.type = "button";
	closeAnnotationCard.className = "shiplet-annotation-card-close";
	closeAnnotationCard.textContent = "Close";
	closeAnnotationCard.setAttribute("aria-label", "Close annotation settings");
	closeAnnotationCard.setAttribute("data-shiplet-annotation-card-close", "v1");
	annotationCardControls.append(dragHandle, closeAnnotationCard);
	annotationCardHeader.append(annotationCardHeading, annotationCardControls);
	const label = document.createElement("label");
	label.setAttribute("for", "shiplet-review-comment");
	label.className = "shiplet-review-visually-hidden";
	label.textContent = "Annotation";
	const composerContext = document.createElement("p");
	composerContext.className = "shiplet-review-composer-context";
	composerContext.textContent = "Revision " + revisionId + " · " + reviewPath;
	composerContext.title = composerContext.textContent;
	composerContext.hidden = true;
	const comment = document.createElement("textarea");
	comment.id = "shiplet-review-comment";
	comment.name = "comment";
	comment.placeholder = "Add a comment…";
	comment.setAttribute("aria-label", "Annotation");
	comment.required = true;
	comment.maxLength = 5000;
	comment.rows = 2;
	const mentionDetails = document.createElement("details");
	mentionDetails.className = "shiplet-review-mentions";
	mentionDetails.hidden = true;
	const mentionSummary = document.createElement("summary");
	mentionSummary.textContent = "Mention reviewers";
	const mentionSelect = document.createElement("select");
	mentionSelect.multiple = true;
	mentionSelect.size = 3;
	mentionSelect.setAttribute("aria-label", "Mention reviewers");
	mentionDetails.append(mentionSummary, mentionSelect);
	const submit = document.createElement("button");
	submit.type = "submit";
	submit.textContent = "Send";
	submit.setAttribute("aria-label", "Send annotation");
	const cancelComposer = document.createElement("button");
	cancelComposer.type = "button";
	cancelComposer.className = "shiplet-review-secondary";
	cancelComposer.textContent = "Cancel";
	cancelComposer.setAttribute("aria-label", "Cancel annotation");
	cancelComposer.setAttribute("data-shiplet-review-cancel-compose", "v1");
	const annotationSettings = document.createElement("button");
	annotationSettings.type = "button";
	annotationSettings.className = "shiplet-annotation-settings";
	annotationSettings.textContent = "Details";
	annotationSettings.setAttribute("aria-label", "Show annotation details and target properties");
	annotationSettings.setAttribute("aria-expanded", "false");
	annotationSettings.setAttribute("aria-controls", "shiplet-annotation-properties");
	annotationSettings.setAttribute("data-shiplet-annotation-settings", "v1");
	const composerActions = document.createElement("div");
	composerActions.className = "shiplet-review-composer-actions";
	composerActions.append(annotationSettings, cancelComposer, submit);
	const captureTools = document.createElement("div");
	captureTools.className = "shiplet-review-capture-tools";
	const selectTarget = document.createElement("button");
	selectTarget.type = "button";
	selectTarget.className = "shiplet-review-secondary";
	selectTarget.textContent = "Choose another element";
	selectTarget.disabled = true;
	selectTarget.setAttribute("data-shiplet-review-select-target", "v1");
	const clearTarget = document.createElement("button");
	clearTarget.type = "button";
	clearTarget.className = "shiplet-review-secondary";
	clearTarget.textContent = "Remove target";
	clearTarget.hidden = true;
	clearTarget.setAttribute("data-shiplet-review-clear-target", "v1");
	const drawOnScreenshot = document.createElement("button");
	drawOnScreenshot.type = "button";
	drawOnScreenshot.className = "shiplet-review-secondary";
	drawOnScreenshot.textContent = "Markup screenshot";
	drawOnScreenshot.hidden = true;
	drawOnScreenshot.setAttribute("data-shiplet-review-annotate", "v1");
	const selectedTarget = document.createElement("p");
	selectedTarget.className = "shiplet-review-target";
	selectedTarget.textContent = "Page · " + reviewPath;
	selectedTarget.title = reviewPath;
	selectedTarget.setAttribute("aria-live", "polite");
	const annotationProperties = document.createElement("details");
	annotationProperties.id = "shiplet-annotation-properties";
	annotationProperties.className = "shiplet-annotation-properties";
	const annotationPropertiesSummary = document.createElement("summary");
	annotationPropertiesSummary.textContent = "Element details";
	const annotationPropertyRows = document.createElement("dl");
	annotationPropertyRows.className = "shiplet-annotation-property-rows";
	annotationProperties.append(annotationPropertiesSummary, annotationPropertyRows);
	annotationProperties.hidden = true;
	captureTools.append(selectTarget, clearTarget, drawOnScreenshot);
	form.append(annotationCardHeader, selectedTarget, label, comment, composerActions, annotationProperties, mentionDetails, captureTools, composerContext);
	form.hidden = true;
	controls.replaceChildren(header, status, list);
	panel.hidden = true;
	document.body.appendChild(launcherDock);
	document.body.appendChild(form);
	const annotationModeBar = document.createElement("section");
	annotationModeBar.className = "shiplet-annotation-modebar";
	annotationModeBar.setAttribute("data-shiplet-annotation-modebar", "v1");
	annotationModeBar.setAttribute("aria-live", "polite");
	annotationModeBar.hidden = true;
	annotationModeBar.textContent = "Annotating · " + reviewPath;
	const cancelAnnotationMode = document.createElement("button");
	cancelAnnotationMode.type = "button";
	cancelAnnotationMode.textContent = "Cancel";
	cancelAnnotationMode.setAttribute("aria-label", "Cancel annotation mode");
	cancelAnnotationMode.setAttribute("data-shiplet-annotation-mode-cancel", "v1");
	annotationModeBar.append(cancelAnnotationMode);
	document.body.appendChild(annotationModeBar);
	const annotationTargetPin = document.createElement("span");
	annotationTargetPin.className = "shiplet-annotation-target-pin";
	annotationTargetPin.setAttribute("data-shiplet-annotation-target-pin", "v1");
	annotationTargetPin.setAttribute("aria-hidden", "true");
	annotationTargetPin.hidden = true;
	document.body.appendChild(annotationTargetPin);
	const annotationTargetFocus = document.createElement("span");
	annotationTargetFocus.className = "shiplet-annotation-target-focus";
	annotationTargetFocus.setAttribute("data-shiplet-annotation-target-focus", "v1");
	annotationTargetFocus.setAttribute("aria-hidden", "true");
	annotationTargetFocus.hidden = true;
	document.body.appendChild(annotationTargetFocus);
	const pinLayer = document.createElement("section");
	pinLayer.className = "shiplet-review-pin-layer";
	pinLayer.setAttribute("aria-label", "Contextual review comments");
	document.body.appendChild(pinLayer);
	const widgetRecovery = widget ? document.createElement("section") : null;
	const widgetRecoveryMessage = widget ? document.createElement("p") : null;
	const widgetRetry = widget ? document.createElement("button") : null;
	if (widgetRecovery && widgetRecoveryMessage && widgetRetry) {
		widgetRecovery.className = "shiplet-widget-recovery";
		widgetRecovery.hidden = true;
		widgetRecovery.setAttribute("role", "alert");
		widgetRecovery.setAttribute("aria-live", "assertive");
		widgetRecovery.setAttribute("data-shiplet-widget-recovery", "v1");
		widgetRecoveryMessage.textContent = "Custom review widget could not load.";
		widgetRecoveryMessage.setAttribute("data-shiplet-widget-recovery-message", "v1");
		widgetRetry.type = "button";
		widgetRetry.className = "shiplet-review-secondary";
		widgetRetry.textContent = "Retry widget";
		widgetRetry.setAttribute("data-shiplet-widget-retry", "v1");
		widgetRecovery.append(widgetRecoveryMessage, widgetRetry);
		panel.appendChild(widgetRecovery);
	}
	const presenceRoot = document.createElement("section");
	presenceRoot.className = "shiplet-review-presence";
	presenceRoot.setAttribute("aria-label", "Live reviewers");
	presenceRoot.setAttribute("aria-live", "polite");
	presenceRoot.hidden = true;
	document.body.appendChild(presenceRoot);
	let pendingWidgetRequest = null;
	let artifactPort = null;
	let artifactSourceWindow = null;
	let artifactChannelNonce = "";
	let artifactChannelConnected = false;
	let pendingArtifactRequestId = "";
	let artifactCapture = null;
	let artifactCaptureRequestId = "";
	let artifactViewport = null;
	let artifactAnchor = null;
	let artifactScreenshotBase = null;
	let annotationLayer = null;
	let annotationCanvas = null;
	let annotationContext = null;
	let annotationDrawing = false;
	let annotationEditing = false;
	let annotationToolbar = null;
	let annotationStrokeCheckpoint = 0;
	let annotationStrokes = [];
	let annotationActive = false;
	let annotationExpanded = false;
	let annotationSelecting = false;
	let annotationDrag = null;
	let annotationComposerOffset = null;
	let watching = false;
	let renderedItems = [];
	let activeFeedbackId = "";
	let threadViews = [];
	let mentionUsers = [];
	let presenceSocket = null;
	let presenceReconnectTimer = 0;
	let presenceReconnectAttempt = 0;
	let presenceStopped = false;
	let widgetPort = null;
	let sourceWindow = null;
	let channelNonce = "";
	let channelConnected = false;
	let widgetHandshakeTimer = 0;
	const seenWidgetRequestIds = new Set();
	const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	function itemText(item) {
		if (!item || typeof item !== "object") return "Comment";
		const ticket = typeof item.ticket_label === "string" ? item.ticket_label : "";
		const summary = typeof item.summary === "string" ? item.summary : "";
		const body = typeof item.comment === "string" ? item.comment : "";
		const state = typeof item.status === "string" ? item.status : "";
		return [ticket, state, summary || body].filter(Boolean).join(" · ") || "Comment";
	}

	function childApiUrl(kind, feedbackId) {
		try {
			const url = new URL(apiUrl);
			if (kind === "mentions" && /\/review-feedback$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/review-feedback$/, "/review-mention-users");
			else if (kind === "mentions" && /\/__shiplet\/review\/feedback$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/feedback$/, "/mention-users");
			else if (kind === "watch" && /\/review-feedback$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/review-feedback$/, "/review-watch");
			else if (kind === "watch" && /\/__shiplet\/review\/feedback$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/feedback$/, "/watch");
			else if (feedbackId && (kind === "status" || kind === "replies") && (/\/review-feedback$/.test(url.pathname) || /\/__shiplet\/review\/feedback$/.test(url.pathname))) url.pathname += "/" + encodeURIComponent(feedbackId) + "/" + kind;
			else return "";
			url.search = "";
			url.hash = "";
			return url.toString();
		} catch {
			return "";
		}
	}

	function presenceSocketUrl() {
		try {
			const url = new URL(apiUrl);
			if (/\/review-feedback$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/review-feedback$/, "/review-presence/ws");
			else if (/\/__shiplet\/review\/feedback$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/feedback$/, "/presence/ws");
			else return "";
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.search = "";
			url.hash = "";
			const reviewed = new URL(reviewPageUrl);
			url.searchParams.set("path", reviewed.pathname || "/");
			url.searchParams.set("href", reviewed.toString());
			url.searchParams.set("title", String(document.title || "").slice(0, 200));
			return url.toString();
		} catch {
			return "";
		}
	}

	function parsePresenceViewers(message) {
		if (!isRecord(message) || (message.type !== "presence:ready" && message.type !== "presence:update") || !Array.isArray(message.viewers)) return null;
		const viewers = [];
		for (const viewer of message.viewers.slice(0, 32)) {
			if (!isRecord(viewer) || !isIdentifier(viewer.id) || !boundedString(viewer.name, 200)) continue;
			if (viewer.kind !== "user" && viewer.kind !== "guest" && viewer.kind !== "sandbox") continue;
			viewers.push({
				id: viewer.id,
				kind: viewer.kind,
				name: viewer.name || "Reviewer",
				avatarPreset: boundedString(viewer.avatarPreset, 64) ? viewer.avatarPreset : null,
				avatarDataUrl: typeof viewer.avatarDataUrl === "string" && viewer.avatarDataUrl.length <= 65536 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(viewer.avatarDataUrl) ? viewer.avatarDataUrl : null,
			});
		}
		return viewers;
	}

	function avatarPresetFor(id) {
		return avatarPresets.find((preset) => preset.id === id) || avatarPresets[0];
	}

	function stylePresenceAvatar(avatar, viewer) {
		if (viewer.avatarDataUrl) {
			avatar.style.backgroundImage = "url('" + viewer.avatarDataUrl + "')";
			avatar.style.backgroundPosition = "center";
			avatar.style.backgroundSize = "cover";
			return;
		}
		const preset = avatarPresetFor(viewer.avatarPreset);
		if (!preset) return;
		const x = avatarSpriteColumns <= 1 ? 0 : (preset.column / (avatarSpriteColumns - 1)) * 100;
		const y = avatarSpriteRows <= 1 ? 0 : (preset.row / (avatarSpriteRows - 1)) * 100;
		avatar.style.backgroundImage = "url('" + avatarSpriteUrl + "')";
		avatar.style.backgroundPosition = x + "% " + y + "%";
		avatar.style.backgroundSize = avatarSpriteColumns * 100 + "% " + avatarSpriteRows * 100 + "%";
	}

	function renderPresence(viewers) {
		presenceRoot.replaceChildren();
		if (!Array.isArray(viewers) || viewers.length === 0) {
			presenceRoot.hidden = true;
			return;
		}
		presenceRoot.hidden = false;
		const summary = document.createElement("span");
		summary.className = "shiplet-review-presence-summary";
		summary.textContent = viewers.length === 1 ? "1 reviewer here" : viewers.length + " reviewers here";
		presenceRoot.appendChild(summary);
		for (const viewer of viewers) {
			const avatar = document.createElement("span");
			avatar.className = "shiplet-review-presence-avatar";
			avatar.setAttribute("role", "img");
			avatar.setAttribute("aria-label", viewer.name);
			avatar.setAttribute("title", viewer.name);
			avatar.setAttribute("data-shiplet-presence-viewer", viewer.id);
			stylePresenceAvatar(avatar, viewer);
			presenceRoot.appendChild(avatar);
		}
	}

	function schedulePresenceReconnect() {
		if (presenceStopped || typeof window.setTimeout !== "function") return;
		window.clearTimeout(presenceReconnectTimer);
		const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(presenceReconnectAttempt, 5)));
		presenceReconnectAttempt += 1;
		presenceReconnectTimer = window.setTimeout(connectPresence, delay);
	}

	function connectPresence() {
		if (presenceStopped || typeof window.WebSocket !== "function") return;
		const url = presenceSocketUrl();
		if (!url) return;
		try {
			presenceSocket = new window.WebSocket(url);
		} catch {
			schedulePresenceReconnect();
			return;
		}
		presenceSocket.addEventListener("open", () => {
			presenceReconnectAttempt = 0;
			try {
				presenceSocket.send(JSON.stringify({
					type: "hello",
					page: { pathname: new URL(reviewPageUrl).pathname || "/", href: reviewPageUrl, title: String(document.title || "").slice(0, 200) },
				}));
			} catch {}
		});
		presenceSocket.addEventListener("message", (event) => {
			const raw = typeof event.data === "string" ? event.data : "";
			if (!raw || raw.length > 65536) return;
			try {
				const viewers = parsePresenceViewers(JSON.parse(raw));
				if (viewers) renderPresence(viewers);
			} catch {}
		});
		presenceSocket.addEventListener("close", schedulePresenceReconnect);
		presenceSocket.addEventListener("error", () => {});
	}

	function setStatus(message, kind) {
		status.textContent = message;
		status.setAttribute("role", kind === "error" ? "alert" : "status");
		status.setAttribute("data-state", kind || "ready");
		status.hidden = kind === "ready" && /^\d+ comments?\.$/.test(message);
	}

	function updateCount(value) {
		const count = Math.max(0, Math.min(100, Number(value) || 0));
		launcherCount.textContent = String(count);
		launcherCount.setAttribute("aria-label", count + (count === 1 ? " comment" : " comments"));
		commentsLauncher.setAttribute("aria-label", "Open " + count + (count === 1 ? " comment" : " comments") + " for " + revisionId);
		previousButton.hidden = count < 2;
		nextButton.hidden = count < 2;
	}

	function populateMentionSelect(select) {
		select.replaceChildren();
		for (const user of mentionUsers) {
			const option = document.createElement("option");
			option.value = user.id;
			option.textContent = user.name + (user.email ? " · " + user.email : "");
			select.appendChild(option);
		}
	}

	function selectedMentions(select) {
		const selected = [];
		for (const option of Array.from(select.selectedOptions || []).slice(0, 20)) {
			if (isIdentifier(option.value) && mentionUsers.some((user) => user.id === option.value)) selected.push({ userId: option.value });
		}
		return selected;
	}

	function createReplyMentionSelect(ticket) {
		const select = document.createElement("select");
		select.multiple = true;
		select.size = Math.min(3, Math.max(1, mentionUsers.length));
		select.setAttribute("aria-label", "Mention reviewers in reply to " + ticket);
		select.hidden = mentionUsers.length === 0;
		populateMentionSelect(select);
		return select;
	}

	function formatReviewTime(value) {
		if (!boundedString(value, 120) || !value) return "";
		try {
			const date = new Date(value);
			if (!Number.isFinite(date.getTime())) return "";
			return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
		} catch {
			return "";
		}
	}

	function reviewActor(value, fallback) {
		return boundedString(value, 320) && value ? value : fallback;
	}

	function reviewCoordinates(item) {
		if (!isRecord(item.coordinates)) return null;
		const pageX = Number(item.coordinates.pageX);
		const pageY = Number(item.coordinates.pageY);
		const sourceX = artifactViewport && Number.isFinite(pageX) ? pageX - artifactViewport.scrollX : Number(item.coordinates.viewportX);
		const sourceY = artifactViewport && Number.isFinite(pageY) ? pageY - artifactViewport.scrollY : Number(item.coordinates.viewportY);
		if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY)) return null;
		const capturedViewportY = Number(item.coordinates.viewportY);
		const x = sourceX + 16;
		const y = sourceY + (Number.isFinite(capturedViewportY) && capturedViewportY < 44 ? 16 : -16);
		return {
			x,
			y,
		};
	}

	function annotationCardSize(expanded) {
		const fallbackWidth = Math.min(360, Math.max(280, Number(window.innerWidth || 360) - 16));
		const fallbackHeight = expanded ? Math.min(400, Math.max(240, Number(window.innerHeight || 400) - 16)) : 96;
		if (typeof form.getBoundingClientRect !== "function") return { width: fallbackWidth, height: fallbackHeight };
		const rect = form.getBoundingClientRect();
		return {
			width: Number.isFinite(rect.width) && rect.width > 0 ? rect.width : fallbackWidth,
			height: Number.isFinite(rect.height) && rect.height > 0 ? rect.height : fallbackHeight,
		};
	}

	function clampAnnotationPosition(left, top, expanded) {
		const margin = 8;
		const size = annotationCardSize(expanded);
		const maxLeft = Math.max(margin, Number(window.innerWidth || size.width) - size.width - margin);
		const maxTop = Math.max(margin, Number(window.innerHeight || size.height) - size.height - margin);
		return {
			left: Math.round(Math.max(margin, Math.min(maxLeft, Number(left) || margin))),
			top: Math.round(Math.max(margin, Math.min(maxTop, Number(top) || margin))),
		};
	}

	function moveAnnotationComposer(left, top) {
		const position = clampAnnotationPosition(left, top, annotationExpanded);
		form.style.left = position.left + "px";
		form.style.top = position.top + "px";
		const targetPoint = currentAnnotationTargetPoint(artifactCapture);
		annotationComposerOffset = targetPoint ? { x: position.left - targetPoint.x, y: position.top - targetPoint.y } : null;
	}

	function placeAnnotationComposer(left, top) {
		form.style.left = Math.round(Number(left) || 0) + "px";
		form.style.top = Math.round(Number(top) || 0) + "px";
	}

	function currentAnnotationTargetPoint(captureValue) {
		if (!captureValue || !isRecord(captureValue.coordinates)) return null;
		const coordinates = artifactAnchor && artifactAnchor.requestId === artifactCaptureRequestId ? artifactAnchor.coordinates : captureValue.coordinates;
		const fallbackScrollX = Number(captureValue.captureContext && captureValue.captureContext.scrollX) || 0;
		const fallbackScrollY = Number(captureValue.captureContext && captureValue.captureContext.scrollY) || 0;
		const scrollX = artifactViewport ? artifactViewport.scrollX : fallbackScrollX;
		const scrollY = artifactViewport ? artifactViewport.scrollY : fallbackScrollY;
		const viewportX = artifactAnchor && artifactAnchor.requestId === artifactCaptureRequestId
			? Number(coordinates.viewportX)
			: Number(coordinates.viewportX) + fallbackScrollX - scrollX;
		const viewportY = artifactAnchor && artifactAnchor.requestId === artifactCaptureRequestId
			? Number(coordinates.viewportY)
			: Number(coordinates.viewportY) + fallbackScrollY - scrollY;
		if (!Number.isFinite(viewportX) || !Number.isFinite(viewportY)) return null;
		return {
			x: viewportX,
			y: viewportY,
			viewportWidth: Number(window.innerWidth || captureValue.viewport.width || 1),
			viewportHeight: Number(window.innerHeight || captureValue.viewport.height || 1),
		};
	}

	function positionAnnotationTarget(captureValue) {
		const targetPoint = currentAnnotationTargetPoint(captureValue);
		if (!targetPoint) {
			annotationTargetPin.hidden = true;
			annotationTargetFocus.hidden = true;
			return null;
		}
		const liveRect = artifactAnchor && artifactAnchor.requestId === artifactCaptureRequestId ? artifactAnchor.targetRect : null;
		const focusWidth = liveRect ? liveRect.width : Math.min(112, Math.max(56, targetPoint.viewportWidth - 16));
		const focusHeight = liveRect ? liveRect.height : Math.min(72, Math.max(44, targetPoint.viewportHeight - 16));
		const focusLeft = liveRect ? liveRect.left : targetPoint.x - focusWidth / 2;
		const focusTop = liveRect ? liveRect.top : targetPoint.y - focusHeight / 2;
		annotationTargetPin.style.left = Math.round(targetPoint.x) + "px";
		annotationTargetPin.style.top = Math.round(targetPoint.y) + "px";
		annotationTargetPin.hidden = false;
		annotationTargetFocus.style.left = Math.round(focusLeft) + "px";
		annotationTargetFocus.style.top = Math.round(focusTop) + "px";
		annotationTargetFocus.style.width = Math.round(focusWidth) + "px";
		annotationTargetFocus.style.height = Math.round(focusHeight) + "px";
		annotationTargetFocus.hidden = false;
		return targetPoint;
	}

	function anchorAnnotationComposer(captureValue, resetOffset) {
		const targetPoint = positionAnnotationTarget(captureValue);
		if (!targetPoint) {
			moveAnnotationComposer(Number(window.innerWidth || 368) - 376, Number(window.innerHeight || 640) - 120);
			return;
		}
		if (!resetOffset && annotationComposerOffset) {
			placeAnnotationComposer(targetPoint.x + annotationComposerOffset.x, targetPoint.y + annotationComposerOffset.y);
			return;
		}
		const size = annotationCardSize(annotationExpanded);
		const gap = 70;
		const candidates = [
			{ left: targetPoint.x + gap, top: targetPoint.y + gap },
			{ left: targetPoint.x - size.width - gap, top: targetPoint.y + gap },
			{ left: targetPoint.x + gap, top: targetPoint.y - size.height - gap },
			{ left: targetPoint.x - size.width - gap, top: targetPoint.y - size.height - gap },
		];
		let best = candidates[0];
		let bestOverflow = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) {
			const overflow = Math.max(0, 8 - candidate.left) + Math.max(0, 8 - candidate.top) + Math.max(0, candidate.left + size.width + 8 - targetPoint.viewportWidth) + Math.max(0, candidate.top + size.height + 8 - targetPoint.viewportHeight);
			if (overflow < bestOverflow) {
				best = candidate;
				bestOverflow = overflow;
			}
		}
		moveAnnotationComposer(best.left, best.top);
	}

	function updateAnnotationProperties(captureValue) {
		annotationPropertyRows.replaceChildren();
		annotationProperties.open = false;
		if (!captureValue) {
			annotationProperties.hidden = true;
			return;
		}
		annotationProperties.hidden = false;
		for (const property of [
			["Viewport", captureValue.viewport.width + " × " + captureValue.viewport.height],
			["Page offset", captureValue.captureContext.scrollX + " × " + captureValue.captureContext.scrollY],
			["Capture", captureValue.screenshotDataUrl ? "Element image ready" : "Element context only"],
		]) {
			const term = document.createElement("dt");
			term.className = "shiplet-annotation-property-label";
			term.textContent = property[0];
			const value = document.createElement("dd");
			value.className = "shiplet-annotation-property-value";
			value.textContent = property[1];
			annotationPropertyRows.append(term, value);
		}
	}

	function setAnnotationExpanded(expanded) {
		annotationExpanded = Boolean(expanded);
		form.setAttribute("data-annotation-state", annotationExpanded ? "expanded" : "compact");
		annotationSettings.setAttribute("aria-expanded", annotationExpanded ? "true" : "false");
		if (annotationExpanded) form.setAttribute("role", "dialog");
		else form.removeAttribute("role");
		if (artifactCapture) anchorAnnotationComposer(artifactCapture, true);
		else moveAnnotationComposer(parseFloat(form.style.left || "8"), parseFloat(form.style.top || "8"));
	}

	function setAnnotationMode(active, selecting) {
		annotationActive = Boolean(active);
		annotationSelecting = Boolean(active && selecting);
		annotationModeBar.hidden = !annotationActive;
		launcherDock.setAttribute("data-annotation-active", annotationActive ? "true" : "false");
		launcher.setAttribute("aria-expanded", annotationActive ? "true" : "false");
		launcher.setAttribute("data-panel-open", annotationActive ? "true" : "false");
		artifact.setAttribute("data-shiplet-selecting", annotationSelecting ? "true" : "false");
		document.body.setAttribute("data-shiplet-annotating", annotationActive ? "true" : "false");
	}

	function cancelTargetSelection() {
		if (artifactPort && pendingArtifactRequestId) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "cancel", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingArtifactRequestId }); } catch {}
		}
		pendingArtifactRequestId = "";
		annotationSelecting = false;
		artifact.setAttribute("data-shiplet-selecting", "false");
		selectTarget.textContent = artifactCapture ? "Change element" : "Select element";
	}

	function cancelAnnotationFlow() {
		cancelTargetSelection();
		form.hidden = true;
		annotationTargetPin.hidden = true;
		annotationTargetFocus.hidden = true;
		setAnnotationExpanded(false);
		setAnnotationMode(false, false);
		clearArtifactCapture();
		composeButton.setAttribute("aria-expanded", "false");
		launcher.focus();
	}

	function showComposer(open) {
		if (!open) {
			cancelAnnotationFlow();
			return;
		}
		setAnnotationMode(true, false);
		setAnnotationExpanded(false);
		form.hidden = false;
		anchorAnnotationComposer(artifactCapture, true);
		composeButton.setAttribute("aria-expanded", "true");
		comment.focus();
	}

	function setActiveThread(next) {
		activeFeedbackId = next ? next.id : "";
		for (const entry of threadViews) {
			const active = entry === next;
			entry.details.hidden = !active;
			entry.button.setAttribute("aria-expanded", active ? "true" : "false");
			entry.preview.hidden = active;
			entry.row.setAttribute("data-active", active ? "true" : "false");
			if (entry.pin) {
				entry.pin.setAttribute("data-active", active ? "true" : "false");
				if (active) entry.pin.setAttribute("aria-current", "true");
				else entry.pin.removeAttribute("aria-current");
			}
		}
	}

	function scrollToThread(index) {
		if (!threadViews.length) return;
		const activeIndex = threadViews.findIndex((entry) => entry.id === activeFeedbackId);
		const startIndex = activeIndex >= 0 ? activeIndex : index > 0 ? -1 : 0;
		const nextIndex = (startIndex + index + threadViews.length) % threadViews.length;
		const next = threadViews[nextIndex];
		if (!next) return;
		setActiveThread(next);
		if (next.row && typeof next.row.scrollIntoView === "function") {
			next.row.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
		}
		if (next.button) next.button.focus({ preventScroll: true });
	}

	function updateReviewPinPositions() {
		for (const entry of threadViews) {
			if (!entry.pin || !entry.item) continue;
			const point = reviewCoordinates(entry.item);
			if (!point) {
				entry.pin.hidden = true;
				continue;
			}
			entry.pin.hidden = false;
			entry.pin.style.left = point.x + "px";
			entry.pin.style.top = point.y + "px";
		}
	}

	async function loadMentionUsers() {
		const url = childApiUrl("mentions");
		if (!url) return;
		try {
			const response = await requestAt(url, "GET");
			const users = [];
			for (const user of isRecord(response) && Array.isArray(response.users) ? response.users.slice(0, 50) : []) {
				if (!isRecord(user) || !isIdentifier(user.id) || !boundedString(user.name, 200) || !boundedString(user.email, 320)) continue;
				users.push({ id: user.id, name: user.name || user.email || "Reviewer", email: user.email || "" });
			}
			mentionUsers = users;
			mentionDetails.hidden = users.length === 0;
			populateMentionSelect(mentionSelect);
			if (renderedItems.length > 0) render(renderedItems);
		} catch {
			mentionDetails.hidden = true;
		}
	}

	function render(items) {
		const requestedActiveId = activeFeedbackId;
		renderedItems = Array.isArray(items) ? items.slice(0, 100) : [];
		list.replaceChildren();
		pinLayer.replaceChildren();
		threadViews = [];
		for (const item of renderedItems) {
			if (!isRecord(item)) continue;
			const row = document.createElement("li");
			const feedbackId = isIdentifier(item.id) ? item.id : "";
			const ticket = boundedString(item.ticket_label, 120) ? item.ticket_label : "Comment";
			row.setAttribute("aria-label", itemText(item).slice(0, 6000));
			row.setAttribute("data-shiplet-review-thread", feedbackId || ticket);
			row.setAttribute("data-active", "false");
			const summaryButton = document.createElement("button");
			summaryButton.type = "button";
			summaryButton.className = "shiplet-review-thread-summary";
			summaryButton.setAttribute("aria-expanded", "false");
			const author = document.createElement("span");
			author.className = "shiplet-review-thread-author";
			author.textContent = reviewActor(item.submitted_by_email, "Reviewer");
			const createdTime = document.createElement("span");
			createdTime.className = "shiplet-review-thread-time";
			createdTime.textContent = formatReviewTime(item.created_on || item.createdAt);
			const summaryTicket = document.createElement("strong");
			summaryTicket.textContent = ticket;
			const summaryComment = document.createElement("span");
			summaryComment.className = "shiplet-review-thread-summary-comment";
			summaryComment.textContent = boundedString(item.comment, 5000) ? item.comment : "Comment";
			summaryButton.append(author, createdTime, summaryTicket, summaryComment);
			const details = document.createElement("div");
			details.className = "shiplet-review-thread-details";
			details.hidden = true;
			const threadView = { id: feedbackId, item, row, button: summaryButton, details, preview: summaryComment, pin: null };
			summaryButton.addEventListener("click", (event) => {
				if (!event || event.isTrusted !== true) return;
				const open = details.hidden;
				setActiveThread(open ? threadView : null);
			});
			const meta = document.createElement("div");
			meta.className = "shiplet-review-thread-meta";
			const statusSelect = document.createElement("select");
			statusSelect.setAttribute("aria-label", "Status " + ticket);
			for (const statusValue of ["New", "In Progress", "Blocked", "Done", "Dropped"]) {
				const option = document.createElement("option");
				option.value = statusValue;
				option.textContent = statusValue;
				statusSelect.appendChild(option);
			}
			statusSelect.value = boundedString(item.status, 40) ? item.status : "New";
			statusSelect.disabled = !feedbackId;
			const quickStatus = item.status === "Done" || item.status === "Dropped" ? "New" : "Done";
			const quickStatusButton = document.createElement("button");
			quickStatusButton.type = "button";
			quickStatusButton.className = "shiplet-review-thread-action";
			quickStatusButton.textContent = quickStatus === "Done" ? "Resolve" : "Reopen";
			quickStatusButton.setAttribute("aria-label", quickStatusButton.textContent + " " + ticket);
			quickStatusButton.setAttribute("data-shiplet-review-quick-status", quickStatus);
			quickStatusButton.disabled = !feedbackId;
			quickStatusButton.addEventListener("click", async (event) => {
				if (!event || event.isTrusted !== true || statusSelect.disabled || quickStatusButton.disabled) return;
				statusSelect.disabled = true;
				quickStatusButton.disabled = true;
				try {
					const response = await requestAt(childApiUrl("status", feedbackId), "POST", { status: quickStatus });
					if (isRecord(response) && isRecord(response.feedback) && response.feedback.id === feedbackId) {
						renderedItems = renderedItems.map((entry) => isRecord(entry) && entry.id === feedbackId ? response.feedback : entry);
						render(renderedItems);
					} else {
						await refresh();
					}
					setStatus(ticket + " status updated.", "ready");
				} catch {
					setStatus("Could not update " + ticket + ".", "error");
				} finally {
					statusSelect.disabled = false;
					quickStatusButton.disabled = false;
				}
			});
			const statusMore = document.createElement("details");
			statusMore.className = "shiplet-review-status-more";
			const statusMoreSummary = document.createElement("summary");
			statusMoreSummary.textContent = "Status";
			statusMoreSummary.setAttribute("aria-label", "More status options for " + ticket);
			statusMore.append(statusMoreSummary, statusSelect);
			statusSelect.addEventListener("change", async (event) => {
				if (!event || event.isTrusted !== true || statusSelect.disabled) return;
				statusSelect.disabled = true;
				try {
					const response = await requestAt(childApiUrl("status", feedbackId), "POST", { status: statusSelect.value });
					if (isRecord(response) && isRecord(response.feedback) && response.feedback.id === feedbackId) render(renderedItems.map((entry) => isRecord(entry) && entry.id === feedbackId ? response.feedback : entry));
					else await refresh();
					setStatus(ticket + " status updated.", "ready");
				} catch { setStatus("Could not update " + ticket + ".", "error"); }
				finally { statusSelect.disabled = false; }
			});
			meta.append(quickStatusButton, statusMore);
			const body = document.createElement("p");
			body.className = "shiplet-review-thread-comment";
			body.textContent = boundedString(item.comment, 5000) ? item.comment : "Comment";
			const replies = document.createElement("ol");
			replies.className = "shiplet-review-replies";
			for (const reply of Array.isArray(item.replies) ? item.replies.slice(0, 100) : []) {
				if (!isRecord(reply) || !boundedString(reply.comment, 5000)) continue;
				const replyRow = document.createElement("li");
				const replyMeta = document.createElement("div");
				replyMeta.className = "shiplet-review-reply-meta";
				const replyAuthor = document.createElement("span");
				replyAuthor.className = "shiplet-review-reply-author";
				replyAuthor.textContent = reviewActor(reply.author_email || reply.submitted_by_email, "Reviewer");
				const replyTime = document.createElement("span");
				replyTime.className = "shiplet-review-reply-time";
				replyTime.textContent = formatReviewTime(reply.created_on || reply.createdAt);
				const replyBody = document.createElement("p");
				replyBody.textContent = reply.comment;
				replyMeta.append(replyAuthor, replyTime);
				replyRow.append(replyMeta, replyBody);
				replies.appendChild(replyRow);
			}
			const replyForm = document.createElement("div");
			replyForm.className = "shiplet-review-reply-form";
			const replyInput = document.createElement("input");
			replyInput.type = "text";
			replyInput.maxLength = 5000;
			replyInput.placeholder = "Reply to this thread…";
			replyInput.setAttribute("aria-label", "Reply text for " + ticket);
			const replyButton = document.createElement("button");
			replyButton.type = "button";
			replyButton.textContent = "Send";
			replyButton.setAttribute("aria-label", "Reply to " + ticket);
			replyButton.setAttribute("data-shiplet-review-reply-submit", feedbackId);
			replyButton.disabled = !feedbackId;
			const replyMentions = createReplyMentionSelect(ticket);
			async function submitReply() {
				const replyValue = String(replyInput.value || "").trim();
				if (!replyValue || replyButton.disabled) return;
				replyButton.disabled = true;
				try {
					const response = await requestAt(childApiUrl("replies", feedbackId), "POST", { comment: replyValue, mentions: selectedMentions(replyMentions) });
					replyInput.value = "";
					if (isRecord(response) && isRecord(response.feedback) && response.feedback.id === feedbackId) {
						render(renderedItems.map((entry) => isRecord(entry) && entry.id === feedbackId ? response.feedback : entry));
					} else {
						await refresh();
					}
					setStatus("Reply added to " + ticket + ".", "ready");
				} catch {
					setStatus("Could not reply to " + ticket + ".", "error");
				} finally {
					replyButton.disabled = false;
				}
			}
			replyButton.addEventListener("click", async (event) => {
				if (!event || event.isTrusted !== true) return;
				await submitReply();
			});
			replyInput.addEventListener("keydown", async (event) => {
				if (!event || event.isTrusted !== true || event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
				event.preventDefault();
				await submitReply();
			});
			replyForm.append(replyInput, replyMentions, replyButton);
			details.append(body, meta, replies, replyForm);
			row.append(summaryButton, details);
			list.appendChild(row);
			threadViews.push(threadView);
			const pinPoint = reviewCoordinates(item);
			if (pinPoint && feedbackId) {
				const pin = document.createElement("button");
				pin.type = "button";
				pin.className = "shiplet-review-pin";
				pin.textContent = String(threadViews.length);
				pin.setAttribute("aria-label", "Open " + ticket);
				pin.setAttribute("data-active", "false");
				pin.style.left = pinPoint.x + "px";
				pin.style.top = pinPoint.y + "px";
				pin.addEventListener("click", (event) => {
					if (!event || event.isTrusted !== true) return;
					setPanelOpen(true);
					setActiveThread(threadView);
					summaryButton.focus();
				});
				threadView.pin = pin;
				pinLayer.appendChild(pin);
			}
		}
		const restoredThread = requestedActiveId ? threadViews.find((entry) => entry.id === requestedActiveId) : null;
		setActiveThread(restoredThread || null);
		updateCount(list.childElementCount);
		setStatus(list.childElementCount === 0 ? "No comments yet. Add the first comment." : list.childElementCount + (list.childElementCount === 1 ? " comment." : " comments."), "ready");
	}

	async function requestAt(url, method, body) {
		if (!url) throw new Error("Review endpoint unavailable.");
		const options = { method, credentials: "include", headers: { "content-type": "application/json" } };
		if (body !== undefined) options.body = JSON.stringify(body);
		const response = await fetch(url, options);
		if (!response.ok) {
			const error = new Error("Review request failed (" + response.status + ").");
			error.status = response.status;
			throw error;
		}
		return response.json();
	}

	async function request(method, body) {
		return requestAt(apiUrl, method, body);
	}

	function renderWatch() {
		watchButton.textContent = watching ? "Watching" : "Watch artifact";
		watchButton.setAttribute("aria-pressed", watching ? "true" : "false");
	}

	async function loadWatch() {
		const url = childApiUrl("watch");
		if (!url) return;
		try {
			const response = await requestAt(url, "GET");
			watching = Boolean(response && response.watch && response.watch.watching);
			renderWatch();
		} catch {
			watchButton.hidden = true;
		}
	}

	async function refresh() {
		refreshButton.disabled = true;
		list.setAttribute("aria-busy", "true");
		setStatus("Loading comments…", "loading");
		try {
			const response = await request("GET");
			render(response && response.feedback);
		} catch (error) {
			if (error && (error.status === 401 || error.status === 403)) {
				setStatus("Review access was denied. Reopen the review or ask the owner for access.", "error");
			} else if (typeof navigator === "object" && navigator && navigator.onLine === false) {
				setStatus("You’re offline. Comments will be available when the connection returns.", "error");
			} else if (renderedItems.length > 0) {
				setStatus(renderedItems.length + (renderedItems.length === 1 ? " comment." : " comments."), "ready");
			} else {
				setStatus("Could not load comments. Use Refresh to try again.", "error");
			}
		} finally {
			list.setAttribute("aria-busy", "false");
			refreshButton.disabled = false;
		}
	}

	function setPanelOpen(open) {
		panel.hidden = !open;
		commentsLauncher.setAttribute("aria-expanded", open ? "true" : "false");
		if (open) closeButton.focus();
		else commentsLauncher.focus();
	}

	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function hasExactKeys(value, keys) {
		const actual = Object.keys(value);
		return actual.length === keys.length && actual.every((key) => keys.includes(key));
	}

	function isIdentifier(value) {
		return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
	}

	function finiteNumber(value, minimum, maximum) {
		return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
	}

	function boundedString(value, maximum) {
		return typeof value === "string" && value.length <= maximum;
	}

	function parseArtifactCapture(data) {
		if (!pendingArtifactRequestId || !isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "requestId", "status", "payload"])) return null;
		if (data.protocol !== "shiplet.artifact.capture.result.v1" || data.type !== "result" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || data.requestId !== pendingArtifactRequestId || data.status !== "captured" || !isRecord(data.payload)) return null;
		const value = data.payload;
		if (!hasExactKeys(value, ["screenshotDataUrl", "screenshotFailureNote", "screenshotMode", "viewport", "coordinates", "selectedElement", "captureContext"]) || value.screenshotMode !== "element" || !isRecord(value.viewport) || !isRecord(value.coordinates) || !isRecord(value.selectedElement) || !isRecord(value.captureContext)) return null;
		if (value.screenshotDataUrl !== null && (!boundedString(value.screenshotDataUrl, 13400000) || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.screenshotDataUrl))) return null;
		if (value.screenshotFailureNote !== null && !boundedString(value.screenshotFailureNote, 500)) return null;
		if (!hasExactKeys(value.viewport, ["width", "height", "devicePixelRatio"]) || !finiteNumber(value.viewport.width, 1, 100000) || !finiteNumber(value.viewport.height, 1, 100000) || !finiteNumber(value.viewport.devicePixelRatio, .1, 10)) return null;
		if (!hasExactKeys(value.coordinates, ["pageX", "pageY", "viewportX", "viewportY"]) || !finiteNumber(value.coordinates.pageX, -10000000, 10000000) || !finiteNumber(value.coordinates.pageY, -10000000, 10000000) || !finiteNumber(value.coordinates.viewportX, -100000, 100000) || !finiteNumber(value.coordinates.viewportY, -100000, 100000)) return null;
		if (!hasExactKeys(value.selectedElement, ["selector", "tagName", "text"]) || !boundedString(value.selectedElement.selector, 1200) || !value.selectedElement.selector || !boundedString(value.selectedElement.tagName, 64) || !/^[A-Z][A-Z0-9-]{0,63}$/.test(value.selectedElement.tagName) || !boundedString(value.selectedElement.text, 500)) return null;
		if (!hasExactKeys(value.captureContext, ["documentWidth", "documentHeight", "scrollX", "scrollY"]) || !finiteNumber(value.captureContext.documentWidth, 1, 100000) || !finiteNumber(value.captureContext.documentHeight, 1, 100000) || !finiteNumber(value.captureContext.scrollX, -10000000, 10000000) || !finiteNumber(value.captureContext.scrollY, -10000000, 10000000)) return null;
		return value;
	}

	function parseArtifactViewport(data) {
		if (!isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "viewport"])) return null;
		if (data.protocol !== "shiplet.artifact.viewport.v1" || data.type !== "change" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || !isRecord(data.viewport)) return null;
		const value = data.viewport;
		if (!hasExactKeys(value, ["width", "height", "documentWidth", "documentHeight", "scrollX", "scrollY"])) return null;
		if (!finiteNumber(value.width, 1, 100000) || !finiteNumber(value.height, 1, 100000) || !finiteNumber(value.documentWidth, 1, 100000) || !finiteNumber(value.documentHeight, 1, 100000) || !finiteNumber(value.scrollX, -10000000, 10000000) || !finiteNumber(value.scrollY, -10000000, 10000000)) return null;
		return value;
	}

	function parseArtifactAnchor(data) {
		if (!artifactCaptureRequestId || !isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "requestId", "coordinates", "targetRect"])) return null;
		if (data.protocol !== "shiplet.artifact.anchor.v1" || data.type !== "position" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || data.requestId !== artifactCaptureRequestId || !isRecord(data.coordinates) || !isRecord(data.targetRect)) return null;
		if (!hasExactKeys(data.coordinates, ["pageX", "pageY", "viewportX", "viewportY"]) || !finiteNumber(data.coordinates.pageX, -10000000, 10000000) || !finiteNumber(data.coordinates.pageY, -10000000, 10000000) || !finiteNumber(data.coordinates.viewportX, -100000, 100000) || !finiteNumber(data.coordinates.viewportY, -100000, 100000)) return null;
		if (!hasExactKeys(data.targetRect, ["left", "top", "width", "height"]) || !finiteNumber(data.targetRect.left, -100000, 100000) || !finiteNumber(data.targetRect.top, -100000, 100000) || !finiteNumber(data.targetRect.width, 0, 100000) || !finiteNumber(data.targetRect.height, 0, 100000)) return null;
		return { requestId: data.requestId, coordinates: data.coordinates, targetRect: data.targetRect };
	}

	function clearArtifactCapture() {
		if (artifactPort && artifactCaptureRequestId) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "release", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: artifactCaptureRequestId }); } catch {}
		}
		clearAnnotationMarkup();
		artifactCapture = null;
		artifactCaptureRequestId = "";
		artifactAnchor = null;
		artifactScreenshotBase = null;
		annotationComposerOffset = null;
		pendingArtifactRequestId = "";
		selectedTarget.textContent = "Page · " + reviewPath;
		selectedTarget.title = reviewPath;
		annotationTargetPin.hidden = true;
		annotationTargetFocus.hidden = true;
		updateAnnotationProperties(null);
		clearTarget.hidden = true;
		drawOnScreenshot.hidden = true;
		selectTarget.textContent = "Select element";
		annotationTargetPin.hidden = true;
	}

	function configureAnnotationContext(context, scale) {
		context.strokeStyle = "#d92d5b";
		context.lineWidth = 5 * (scale || 1);
		context.lineCap = "round";
		context.lineJoin = "round";
	}

	function currentArtifactScroll() {
		return {
			x: artifactViewport ? artifactViewport.scrollX : Number(artifactCapture && artifactCapture.captureContext && artifactCapture.captureContext.scrollX) || 0,
			y: artifactViewport ? artifactViewport.scrollY : Number(artifactCapture && artifactCapture.captureContext && artifactCapture.captureContext.scrollY) || 0,
		};
	}

	function drawAnnotationStrokes(context, offsetX, offsetY, scaleX, scaleY) {
		configureAnnotationContext(context, Math.max(scaleX, scaleY));
		for (const stroke of annotationStrokes) {
			if (!Array.isArray(stroke) || stroke.length === 0) continue;
			context.beginPath();
			for (let index = 0; index < stroke.length; index += 1) {
				const point = stroke[index];
				const x = (point.pageX - offsetX) * scaleX;
				const y = (point.pageY - offsetY) * scaleY;
				if (index === 0) context.moveTo(x, y);
				else context.lineTo(x, y);
			}
			if (stroke.length === 1) context.lineTo((stroke[0].pageX - offsetX) * scaleX + .01, (stroke[0].pageY - offsetY) * scaleY + .01);
			context.stroke();
		}
	}

	function renderAnnotationCanvas() {
		if (!annotationCanvas) return;
		const width = Math.max(1, Math.round(window.innerWidth || (artifactCapture && artifactCapture.viewport.width) || 1));
		const height = Math.max(1, Math.round(window.innerHeight || (artifactCapture && artifactCapture.viewport.height) || 1));
		if (annotationCanvas.width !== width) annotationCanvas.width = width;
		if (annotationCanvas.height !== height) annotationCanvas.height = height;
		annotationContext = annotationCanvas.getContext("2d");
		if (!annotationContext) return;
		annotationContext.clearRect(0, 0, width, height);
		const scroll = currentArtifactScroll();
		drawAnnotationStrokes(annotationContext, scroll.x, scroll.y, 1, 1);
	}

	function clearAnnotationMarkup() {
		annotationDrawing = false;
		annotationEditing = false;
		annotationStrokeCheckpoint = 0;
		annotationStrokes = [];
		annotationContext = null;
		annotationCanvas = null;
		annotationToolbar = null;
		if (annotationLayer) annotationLayer.remove();
		annotationLayer = null;
	}

	function closeAnnotationEditor() {
		if (!annotationEditing) return;
		annotationStrokes = annotationStrokes.slice(0, annotationStrokeCheckpoint);
		annotationDrawing = false;
		annotationEditing = false;
		if (annotationLayer) annotationLayer.setAttribute("data-drawing", "false");
		if (annotationToolbar) annotationToolbar.hidden = true;
		if (annotationStrokes.length === 0) clearAnnotationMarkup();
		else renderAnnotationCanvas();
	}

	async function applyAnnotations() {
		if (!artifactCapture || !artifactScreenshotBase || annotationStrokes.length === 0) return false;
		try {
			const image = new Image();
			const loaded = new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("Screenshot could not be annotated.")); });
			image.src = artifactScreenshotBase;
			await loaded;
			const output = document.createElement("canvas");
			output.width = image.naturalWidth || Math.max(1, Math.round(artifactCapture.viewport.width));
			output.height = image.naturalHeight || Math.max(1, Math.round(artifactCapture.viewport.height));
			const context = output.getContext("2d");
			if (!context) return false;
			context.drawImage(image, 0, 0, output.width, output.height);
			const scaleX = output.width / Math.max(1, artifactCapture.viewport.width);
			const scaleY = output.height / Math.max(1, artifactCapture.viewport.height);
			drawAnnotationStrokes(context, artifactCapture.captureContext.scrollX, artifactCapture.captureContext.scrollY, scaleX, scaleY);
			const screenshotDataUrl = output.toDataURL("image/png");
			if (screenshotDataUrl.length > 13400000) return false;
			artifactCapture = { ...artifactCapture, screenshotDataUrl };
			return true;
		} catch {
			return false;
		}
	}

	function openAnnotationEditor() {
		if (!artifactCapture || !artifactScreenshotBase || annotationEditing) return;
		if (!annotationLayer) {
			annotationLayer = document.createElement("section");
			annotationLayer.className = "shiplet-review-annotation-editor";
			annotationLayer.setAttribute("aria-label", "Draw on screenshot");
			annotationCanvas = document.createElement("canvas");
			annotationCanvas.setAttribute("data-shiplet-annotation-canvas", "v1");
			annotationCanvas.setAttribute("aria-label", "Screenshot drawing canvas");
			annotationToolbar = document.createElement("div");
			annotationToolbar.className = "shiplet-review-annotation-toolbar";
			const done = document.createElement("button");
			done.type = "button";
			done.textContent = "Done drawing";
			const cancelDrawing = document.createElement("button");
			cancelDrawing.type = "button";
			cancelDrawing.textContent = "Cancel drawing";
			annotationToolbar.append(done, cancelDrawing);
			annotationLayer.append(annotationCanvas, annotationToolbar);
			document.body.appendChild(annotationLayer);
			annotationCanvas.addEventListener("pointerdown", (event) => {
				if (!annotationEditing || !event || event.isTrusted !== true) return;
				const scroll = currentArtifactScroll();
				annotationDrawing = true;
				annotationStrokes.push([{ pageX: event.clientX + scroll.x, pageY: event.clientY + scroll.y }]);
				renderAnnotationCanvas();
				if (annotationCanvas.setPointerCapture && event.pointerId !== undefined) annotationCanvas.setPointerCapture(event.pointerId);
			});
			annotationCanvas.addEventListener("pointermove", (event) => {
				if (!annotationDrawing || !annotationEditing || !event || event.isTrusted !== true) return;
				const stroke = annotationStrokes[annotationStrokes.length - 1];
				if (!stroke) return;
				const scroll = currentArtifactScroll();
				stroke.push({ pageX: event.clientX + scroll.x, pageY: event.clientY + scroll.y });
				renderAnnotationCanvas();
			});
			const endDrawing = () => { annotationDrawing = false; };
			annotationCanvas.addEventListener("pointerup", endDrawing);
			annotationCanvas.addEventListener("pointercancel", endDrawing);
			done.addEventListener("click", async (event) => {
				if (!event || event.isTrusted !== true || !annotationEditing) return;
				done.disabled = true;
				const applied = await applyAnnotations();
				annotationDrawing = false;
				annotationEditing = false;
				annotationLayer.setAttribute("data-drawing", "false");
				annotationToolbar.hidden = true;
				done.disabled = false;
				if (annotationStrokes.length === 0) clearAnnotationMarkup();
				else renderAnnotationCanvas();
				setStatus(applied ? "Screenshot annotations added." : "Screenshot annotations could not be added.", applied ? "ready" : "error");
			});
			cancelDrawing.addEventListener("click", (event) => { if (event && event.isTrusted === true) closeAnnotationEditor(); });
		}
		annotationStrokeCheckpoint = annotationStrokes.length;
		annotationEditing = true;
		annotationLayer.setAttribute("data-drawing", "true");
		annotationToolbar.hidden = false;
		renderAnnotationCanvas();
		const done = annotationToolbar.children && annotationToolbar.children[0];
		if (done && typeof done.focus === "function") done.focus();
	}

	function parseWidgetRequest(data, channelNonce) {
		if (!isRecord(data)) return null;
		try {
			if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 16384) return null;
		} catch {
			return null;
		}
		if (!hasExactKeys(data, ["protocol", "type", "requestId", "channelNonce", "shipletId", "revisionId", "operation", "payload"])) return null;
		if (data.protocol !== "shiplet.widget.operation.v1" || data.type !== "request" || data.channelNonce !== channelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || !isIdentifier(data.requestId) || !isRecord(data.payload)) return null;
		if (data.operation === "workflow.event.create") {
			if (!hasExactKeys(data.payload, ["status", "summary", "fields"]) || typeof data.payload.status !== "string" || typeof data.payload.summary !== "string" || !isRecord(data.payload.fields)) return null;
			const status = data.payload.status.trim();
			const summary = data.payload.summary.trim();
			if (!status || status.length > 128 || !summary || new TextEncoder().encode(summary).byteLength > 512) return null;
			let fields;
			try { fields = JSON.parse(JSON.stringify(data.payload.fields)); } catch { return null; }
			if (!isRecord(fields)) return null;
			return { requestId: data.requestId, operation: "workflow.event.create", payload: { status, summary, fields } };
		}
		if (data.operation !== "feedback.create" || !hasExactKeys(data.payload, ["comment"])) return null;
		const value = typeof data.payload.comment === "string" ? data.payload.comment.trim() : "";
		if (!value || value.length > 5000 || new TextEncoder().encode(value).byteLength > 6000) return null;
		return { requestId: data.requestId, operation: "feedback.create", payload: { comment: value } };
	}

	function submitTopLevelConfirmation(requestValue, captureValue, mentionValues) {
		if (!isRecord(requestValue) || !hasExactKeys(requestValue, ["requestId", "operation", "payload"])) return false;
		if (!isIdentifier(requestValue.requestId) || !isRecord(requestValue.payload)) return false;
		const workflowOperation = requestValue.operation === "workflow.event.create";
		if (workflowOperation) {
			if (!hasExactKeys(requestValue.payload, ["status", "summary", "fields"]) || typeof requestValue.payload.status !== "string" || typeof requestValue.payload.summary !== "string" || !isRecord(requestValue.payload.fields)) return false;
		} else if (requestValue.operation !== "feedback.create" || !hasExactKeys(requestValue.payload, ["comment"])) return false;
		const confirmationComment = workflowOperation ? "" : (typeof requestValue.payload.comment === "string" ? requestValue.payload.comment.trim() : "");
		if (!workflowOperation && (!confirmationComment || confirmationComment.length > 5000 || new TextEncoder().encode(confirmationComment).byteLength > 6000)) return false;
		const confirmedMentions = [];
		for (const mention of Array.isArray(mentionValues) ? mentionValues.slice(0, 20) : []) {
			if (!isRecord(mention) || !hasExactKeys(mention, ["userId"]) || !isIdentifier(mention.userId)) return false;
			if (!confirmedMentions.some((entry) => entry.userId === mention.userId)) confirmedMentions.push({ userId: mention.userId });
		}
		let confirmationUrl;
		try {
			const trustedKernelOrigin = new URL(reviewConfirmationUrl).origin;
			confirmationUrl = new URL(reviewConfirmationUrl);
			if (confirmationUrl.origin !== trustedKernelOrigin || (confirmationUrl.pathname !== "/embed/review/confirm" && confirmationUrl.pathname !== "/review/confirm") || confirmationUrl.search || confirmationUrl.hash) return false;
		} catch {
			return false;
		}
		const confirmationForm = document.createElement("form");
		confirmationForm.method = "POST";
		confirmationForm.action = confirmationUrl.toString();
		confirmationForm.target = "_blank";
		confirmationForm.rel = "noopener";
		confirmationForm.hidden = true;
		function appendField(name, value) {
			const field = document.createElement("input");
			field.type = "hidden";
			field.name = name;
			field.value = value;
			confirmationForm.appendChild(field);
		}
		appendField("request_id", requestValue.requestId);
		appendField("operation", requestValue.operation);
		if (workflowOperation) {
			appendField("workflow_status", requestValue.payload.status);
			appendField("workflow_summary", requestValue.payload.summary);
			appendField("workflow_fields_json", JSON.stringify(requestValue.payload.fields));
		} else {
			appendField("comment", confirmationComment);
			appendField("client_feedback_id", "embed-" + crypto.randomUUID());
		}
		appendField("page_url", reviewPageUrl);
		appendField("shiplet_id", shipletId);
		appendField("revision_id", revisionId);
		if (!workflowOperation && confirmedMentions.length > 0) appendField("mentions_json", JSON.stringify(confirmedMentions));
		if (!workflowOperation && captureValue) {
			appendField("screenshot_mode", captureValue.screenshotMode);
			if (captureValue.screenshotDataUrl) appendField("screenshot_data_url", captureValue.screenshotDataUrl);
			if (captureValue.screenshotFailureNote) appendField("screenshot_failure_note", captureValue.screenshotFailureNote);
			appendField("viewport_json", JSON.stringify(captureValue.viewport));
			appendField("coordinates_json", JSON.stringify(captureValue.coordinates));
			appendField("selected_element_json", JSON.stringify(captureValue.selectedElement));
			appendField("capture_context_json", JSON.stringify(captureValue.captureContext));
		}
		try {
			document.body.appendChild(confirmationForm);
			if (typeof confirmationForm.requestSubmit === "function") confirmationForm.requestSubmit();
			else confirmationForm.submit();
			return true;
		} catch {
			return false;
		} finally {
			confirmationForm.remove();
		}
	}

	function hideWidgetConfirmation() {
		pendingWidgetRequest = null;
		if (confirmation) confirmation.hidden = true;
		if (confirmationHeading) confirmationHeading.textContent = "";
		if (confirmationSummary) confirmationSummary.textContent = "";
		if (confirmationFields) { confirmationFields.textContent = ""; confirmationFields.hidden = true; }
	}

	function showWidgetConfirmation(requestValue) {
		if (!confirmation || !confirmationHeading || !confirmationSummary || !confirm) return;
		if (pendingWidgetRequest) return;
		pendingWidgetRequest = requestValue;
		const workflowOperation = requestValue.operation === "workflow.event.create";
		confirmationHeading.textContent = workflowOperation ? "Custom widget requests a workflow action" : "Custom widget requests an action";
		confirmationSummary.textContent = workflowOperation ? requestValue.payload.status + ": " + requestValue.payload.summary : requestValue.payload.comment;
		if (confirmationFields) {
			confirmationFields.textContent = workflowOperation
				? Object.keys(requestValue.payload.fields).sort().map((key) => key + ": " + JSON.stringify(requestValue.payload.fields[key])).join("\n")
				: "";
			confirmationFields.hidden = !workflowOperation;
		}
		confirm.textContent = workflowOperation ? "Record workflow event" : "Send feedback";
		confirmation.hidden = false;
		confirm.focus();
	}

	function clearWidgetHandshakeTimer() {
		if (!widgetHandshakeTimer || typeof window.clearTimeout !== "function") return;
		window.clearTimeout(widgetHandshakeTimer);
		widgetHandshakeTimer = 0;
	}

	function showWidgetRecovery() {
		clearWidgetHandshakeTimer();
		if (!widgetRecovery || !widgetRecoveryMessage || !widgetRetry || !widget) return;
		delete widget.dataset.shipletRestarting;
		widget.hidden = true;
		widgetRecovery.setAttribute("role", "alert");
		widgetRecoveryMessage.textContent = "Custom review widget could not load.";
		widgetRetry.disabled = false;
		widgetRecovery.hidden = false;
	}

	function scheduleWidgetHandshakeTimeout() {
		clearWidgetHandshakeTimer();
		if (typeof window.setTimeout !== "function") return;
		widgetHandshakeTimer = window.setTimeout(() => {
			widgetHandshakeTimer = 0;
			if (!channelConnected) showWidgetRecovery();
		}, 8000);
	}

	function retireWidgetChannel() {
		if (widgetPort && pendingWidgetRequest) {
			try { widgetPort.postMessage({ protocol: "shiplet.widget.operation.result.v1", requestId: pendingWidgetRequest.requestId, status: "denied" }); } catch {}
		}
		try { if (widgetPort && typeof widgetPort.close === "function") widgetPort.close(); } catch {}
		widgetPort = null;
		sourceWindow = null;
		channelConnected = false;
		seenWidgetRequestIds.clear();
		hideWidgetConfirmation();
		if (confirm) confirm.disabled = false;
		clearWidgetHandshakeTimer();
	}

	function offerWidgetChannel() {
		if (!widget || !widget.contentWindow || typeof MessageChannel !== "function") return;
		delete widget.dataset.shipletRestarting;
		retireWidgetChannel();
		sourceWindow = widget.contentWindow;
		channelNonce = crypto.randomUUID();
		sourceWindow.postMessage({
			protocol: "shiplet.widget.channel.v1",
			type: "offer",
			channelNonce,
			shipletId,
			revisionId,
		}, "*");
		scheduleWidgetHandshakeTimeout();
	}

	function reloadWidget() {
		if (!widget || widget.dataset.shipletRestarting === "true") return;
		widget.dataset.shipletRestarting = "true";
		retireWidgetChannel();
		if (widgetRecovery && widgetRecoveryMessage && widgetRetry) {
			widgetRecovery.setAttribute("role", "status");
			widgetRecoveryMessage.textContent = "Retrying custom review widget…";
			widgetRetry.disabled = true;
			widgetRecovery.hidden = false;
		}
		scheduleWidgetHandshakeTimeout();
		widget.src = widgetFrameUrl;
	}

	function offerArtifactChannel() {
		if (!artifact || !artifact.contentWindow || typeof MessageChannel !== "function") return;
		if (artifactPort && pendingArtifactRequestId) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "cancel", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingArtifactRequestId }); } catch {}
		}
		try { if (artifactPort && typeof artifactPort.close === "function") artifactPort.close(); } catch {}
		artifactPort = null;
		artifactSourceWindow = null;
		artifactChannelConnected = false;
		closeAnnotationEditor();
		form.hidden = true;
		setAnnotationExpanded(false);
		setAnnotationMode(false, false);
		clearArtifactCapture();
		selectTarget.disabled = true;
		artifactSourceWindow = artifact.contentWindow;
		artifactChannelNonce = crypto.randomUUID();
		artifactSourceWindow.postMessage({ protocol: "shiplet.artifact.channel.v1", type: "offer", channelNonce: artifactChannelNonce, shipletId, revisionId }, "*");
	}

	window.addEventListener("message", (event) => {
		if (!artifactSourceWindow || event.source !== artifactSourceWindow || event.origin !== "null" || artifactChannelConnected) return;
		const data = event.data;
		if (!isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"])) return;
		if (data.protocol !== "shiplet.artifact.channel.v1" || data.type !== "ready" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId) return;
		artifactChannelConnected = true;
		const channel = new MessageChannel();
		const connectedPort = channel.port1;
		const connectedNonce = artifactChannelNonce;
		artifactPort = connectedPort;
		connectedPort.addEventListener("message", (portEvent) => {
			if (artifactPort !== connectedPort || artifactChannelNonce !== connectedNonce) return;
			const viewportValue = parseArtifactViewport(portEvent.data);
			if (viewportValue) {
				artifactViewport = viewportValue;
				updateReviewPinPositions();
				renderAnnotationCanvas();
				if (artifactCapture && !form.hidden) anchorAnnotationComposer(artifactCapture, false);
				return;
			}
			const anchorValue = parseArtifactAnchor(portEvent.data);
			if (anchorValue) {
				artifactAnchor = anchorValue;
				if (artifactCapture && !form.hidden) anchorAnnotationComposer(artifactCapture, false);
				return;
			}
			const captureValue = parseArtifactCapture(portEvent.data);
			if (!captureValue) return;
			clearAnnotationMarkup();
			artifactCapture = captureValue;
			artifactCaptureRequestId = pendingArtifactRequestId;
			artifactAnchor = null;
			artifactScreenshotBase = captureValue.screenshotDataUrl;
			artifactViewport = {
				width: captureValue.viewport.width,
				height: captureValue.viewport.height,
				documentWidth: captureValue.captureContext.documentWidth,
				documentHeight: captureValue.captureContext.documentHeight,
				scrollX: captureValue.captureContext.scrollX,
				scrollY: captureValue.captureContext.scrollY,
			};
			annotationComposerOffset = null;
			pendingArtifactRequestId = "";
			setAnnotationMode(true, false);
			selectedTarget.textContent = captureValue.selectedElement.tagName + (captureValue.selectedElement.text ? " · " + captureValue.selectedElement.text : "") + " · " + captureValue.selectedElement.selector;
			selectedTarget.title = captureValue.selectedElement.selector;
			updateAnnotationProperties(captureValue);
			clearTarget.hidden = false;
			drawOnScreenshot.hidden = !captureValue.screenshotDataUrl;
			selectTarget.textContent = "Change element";
			showComposer(true);
			setStatus("Element context captured. Add an annotation and continue to secure confirmation.", "ready");
		});
		connectedPort.start();
		artifactSourceWindow.postMessage({ protocol: "shiplet.artifact.channel.v1", type: "connect", channelNonce: artifactChannelNonce, shipletId, revisionId }, "*", [channel.port2]);
		selectTarget.disabled = false;
		if (annotationSelecting && !pendingArtifactRequestId) startTargetSelection();
	});

	window.addEventListener("message", (event) => {
		if (!sourceWindow || event.source !== sourceWindow || event.origin !== "null" || channelConnected) return;
		const data = event.data;
		if (!isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"])) return;
		if (data.protocol !== "shiplet.widget.channel.v1" || data.type !== "ready" || data.channelNonce !== channelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId) return;
		channelConnected = true;
		clearWidgetHandshakeTimer();
		if (widget) { delete widget.dataset.shipletRestarting; widget.hidden = false; }
		if (widgetRecovery) widgetRecovery.hidden = true;
		if (widgetRetry) widgetRetry.disabled = false;
		const channel = new MessageChannel();
		const connectedPort = channel.port1;
		const connectedNonce = channelNonce;
		widgetPort = connectedPort;
		connectedPort.addEventListener("message", (event) => {
			if (widgetPort !== connectedPort || channelNonce !== connectedNonce) return;
			const requestValue = parseWidgetRequest(event.data, connectedNonce);
			if (!requestValue || seenWidgetRequestIds.has(requestValue.requestId) || seenWidgetRequestIds.size >= 256) return;
			seenWidgetRequestIds.add(requestValue.requestId);
			showWidgetConfirmation(requestValue);
		});
		connectedPort.start();
		sourceWindow.postMessage({
			protocol: "shiplet.widget.channel.v1",
			type: "connect",
			channelNonce,
			shipletId,
			revisionId,
		}, "*", [channel.port2]);
	});

	window.addEventListener("message", (event) => {
		if (!widget || !sourceWindow || event.source !== sourceWindow || event.origin !== "null") return;
		const data = event.data;
		if (!isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"])) return;
		if (data.protocol !== "shiplet.widget.restart.v1" || data.type !== "request" || data.channelNonce !== channelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId) return;
		reloadWidget();
	});

	async function submitReviewFeedback() {
		const value = comment.value.trim();
		if (!value || submit.disabled) return;
		submit.disabled = true;
		if (reviewSubmissionMode === "sandbox") {
			setStatus("Adding feedback to this sandbox…", "loading");
			try {
				const payload = {
					comment: value,
					pageUrl: reviewPageUrl,
					clientFeedbackId: "client-" + Date.now().toString(36) + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
					mentions: selectedMentions(mentionSelect),
					...(artifactCapture || {}),
				};
				const response = await request("POST", payload);
				comment.value = "";
				clearArtifactCapture();
				if (isRecord(response) && isRecord(response.feedback)) {
					render([response.feedback, ...renderedItems.filter((entry) => !isRecord(entry) || entry.id !== response.feedback.id)]);
				} else {
					await refresh();
				}
					setStatus("Feedback added to this sandbox.", "ready");
					showComposer(false);
					if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches) setPanelOpen(false);
			} catch {
				setStatus("Sandbox feedback could not be added. Try again.", "error");
			} finally {
				submit.disabled = false;
			}
			return;
		}
		setStatus("Opening secure confirmation…", "loading");
		const submitted = submitTopLevelConfirmation({
			requestId: "request_" + crypto.randomUUID().replace(/-/g, ""),
			operation: "feedback.create",
			payload: { comment: value },
		}, artifactCapture, selectedMentions(mentionSelect));
		if (!submitted) {
			setStatus("Secure confirmation could not be opened. Try again.", "error");
			submit.disabled = false;
			return;
		}
		comment.value = "";
		setStatus("Complete this action in the secure confirmation window.", "ready");
		showComposer(false);
		if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches) setPanelOpen(false);
		submit.disabled = false;
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!event || event.isTrusted !== true) return;
		await submitReviewFeedback();
	});

	function startTargetSelection() {
		if (pendingArtifactRequestId) return;
		setPanelOpen(false);
		form.hidden = true;
		annotationTargetPin.hidden = true;
		annotationTargetFocus.hidden = true;
		setAnnotationExpanded(false);
		setAnnotationMode(true, true);
		if (!artifactPort) {
			setStatus("Connecting to the artifact…", "loading");
			return;
		}
		pendingArtifactRequestId = "capture_request_" + crypto.randomUUID().replace(/-/g, "");
		selectTarget.textContent = "Selecting…";
		setStatus("Select an element to annotate. Press Escape to cancel.", "ready");
		artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "start", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingArtifactRequestId });
	}

	selectTarget.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true) return;
		startTargetSelection();
	});

	clearTarget.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true) return;
		cancelTargetSelection();
		clearArtifactCapture();
	});

	annotationSettings.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true || form.hidden) return;
		setAnnotationExpanded(!annotationExpanded);
	});
	closeAnnotationCard.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true || !annotationExpanded) return;
		setAnnotationExpanded(false);
		comment.focus();
	});

	dragHandle.addEventListener("pointerdown", (event) => {
		if (!event || event.isTrusted !== true || !annotationExpanded) return;
		event.preventDefault();
		annotationDrag = {
			pointerId: event.pointerId,
			startX: Number(event.clientX || 0),
			startY: Number(event.clientY || 0),
			left: parseFloat(form.style.left || "8"),
			top: parseFloat(form.style.top || "8"),
		};
		form.setAttribute("data-dragging", "true");
	});

	window.addEventListener("pointermove", (event) => {
		if (!annotationDrag || !event || event.pointerId !== annotationDrag.pointerId) return;
		if (event.isTrusted === true && typeof event.preventDefault === "function") event.preventDefault();
		moveAnnotationComposer(
			annotationDrag.left + Number(event.clientX || 0) - annotationDrag.startX,
			annotationDrag.top + Number(event.clientY || 0) - annotationDrag.startY,
		);
	});

	window.addEventListener("pointerup", (event) => {
		if (!annotationDrag || !event || event.pointerId !== annotationDrag.pointerId) return;
		annotationDrag = null;
		form.removeAttribute("data-dragging");
	});

	window.addEventListener("pointercancel", () => {
		annotationDrag = null;
		form.removeAttribute("data-dragging");
	});

	drawOnScreenshot.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true) return;
		openAnnotationEditor();
	});

	if (confirm) confirm.addEventListener("click", (event) => {
		const requestValue = pendingWidgetRequest;
		if (!requestValue || confirm.disabled || !event || event.isTrusted !== true) return;
		confirm.disabled = true;
		if (!submitTopLevelConfirmation(requestValue)) {
			setStatus("Secure confirmation could not be opened. Try again.", "error");
			confirm.disabled = false;
			return;
		}
		setStatus("Complete this action in the secure confirmation window.", "ready");
	});

	if (cancel) cancel.addEventListener("click", () => {
		if (widgetPort && pendingWidgetRequest) widgetPort.postMessage({ protocol: "shiplet.widget.operation.result.v1", requestId: pendingWidgetRequest.requestId, status: "denied" });
		hideWidgetConfirmation();
	});

	if (artifact) {
		artifact.addEventListener("load", offerArtifactChannel);
		offerArtifactChannel();
	}
	if (widget) {
		widget.addEventListener("load", offerWidgetChannel);
		offerWidgetChannel();
	}
	if (widget) widget.addEventListener("error", showWidgetRecovery);
	if (widgetRetry) widgetRetry.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true || widgetRetry.disabled) return;
		reloadWidget();
	});
	refreshButton.addEventListener("click", async () => { await refresh(); });
	watchButton.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true || watchButton.disabled) return;
		watchButton.disabled = true;
		try {
			const response = await requestAt(childApiUrl("watch"), watching ? "DELETE" : "POST");
			watching = Boolean(response && response.watch && response.watch.watching);
			renderWatch();
		} catch {
			setStatus("Watch status could not be changed.", "error");
		} finally {
			watchButton.disabled = false;
		}
	});
	previousButton.addEventListener("click", (event) => { if (event && event.isTrusted === true) scrollToThread(-1); });
	nextButton.addEventListener("click", (event) => { if (event && event.isTrusted === true) scrollToThread(1); });
	composeButton.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true) return;
		startTargetSelection();
	});
	cancelComposer.addEventListener("click", (event) => { if (event && event.isTrusted === true) cancelAnnotationFlow(); });
	cancelAnnotationMode.addEventListener("click", (event) => { if (event && event.isTrusted === true) cancelAnnotationFlow(); });
	closeButton.addEventListener("click", (event) => { if (event && event.isTrusted === true) setPanelOpen(false); });
	commentsLauncher.addEventListener("click", (event) => { if (event && event.isTrusted === true) setPanelOpen(panel.hidden); });
	launcher.addEventListener("click", (event) => { if (event && event.isTrusted === true) startTargetSelection(); });
	window.addEventListener("keydown", async (event) => {
		if (!event || event.isTrusted !== true) return;
		const target = event.target;
		const tagName = target && typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
		const editable = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || Boolean(target && target.isContentEditable);
		if (event.key === "Escape") {
			if (annotationEditing) {
				event.preventDefault();
				closeAnnotationEditor();
				return;
			}
			if (!form.hidden && annotationExpanded) {
				event.preventDefault();
				setAnnotationExpanded(false);
				return;
			}
			if (!form.hidden || annotationActive) {
				event.preventDefault();
				cancelAnnotationFlow();
				return;
			}
			if (!panel.hidden) {
				event.preventDefault();
				setPanelOpen(false);
			}
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && target === comment) {
			event.preventDefault();
			await submitReviewFeedback();
			return;
		}
		if (!editable && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "c") {
			event.preventDefault();
			startTargetSelection();
		}
	});
	window.addEventListener("resize", () => {
		renderAnnotationCanvas();
		if (form.hidden) return;
		if (artifactCapture) anchorAnnotationComposer(artifactCapture, true);
		else moveAnnotationComposer(parseFloat(form.style.left || "8"), parseFloat(form.style.top || "8"));
	});
	window.addEventListener("online", () => { void refresh(); });
	window.addEventListener("beforeunload", () => {
		presenceStopped = true;
		window.clearTimeout(presenceReconnectTimer);
		clearWidgetHandshakeTimer();
		try { if (presenceSocket) presenceSocket.close(1000, "page unloading"); } catch {}
	});
	if (typeof window.setInterval === "function") window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);

	void refresh();
	void loadWatch();
	void loadMentionUsers();
	connectPresence();
})();`;
}

export function trustedReviewHostStyles(): string {
  return String.raw`
:root{color-scheme:light;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20293a;background:#fff;--shiplet-ink:#20293a;--shiplet-muted:#5d6b85;--shiplet-line:#c8cbd3;--shiplet-surface:#fbf9f4;--shiplet-raised:#fff;--shiplet-action:#b44729;--shiplet-accent:#2f6e88}
*{box-sizing:border-box}body{margin:0;min-height:100vh}main{height:100vh;background:#fff}iframe[data-shiplet-artifact-frame]{display:block;width:100%;height:100%;border:0;background:#fff;color-scheme:light dark}
.shiplet-review-launcher-dock{position:fixed;right:16px;bottom:16px;z-index:31;display:flex;align-items:stretch;gap:6px;transition:opacity .14s ease,transform .14s ease}.shiplet-review-launcher-dock[data-annotation-active="true"]{visibility:hidden;opacity:0;pointer-events:none;transform:translateY(8px)}
.shiplet-review-launcher,.shiplet-review-comments-launcher{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid rgba(255,255,255,.34);background:#20293a;box-shadow:0 4px 16px rgba(0,0,0,.32),0 0 0 1px rgba(0,0,0,.32);color:#fff;font:750 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.shiplet-review-launcher{padding:0 13px;border-radius:9px}.shiplet-review-launcher::before{content:"+";display:grid;place-items:center;width:17px;height:17px;margin-right:7px;border:1.5px solid #fff;border-radius:999px;font:800 14px/1 ui-sans-serif}.shiplet-review-launcher[data-panel-open="true"]{visibility:hidden;opacity:0;pointer-events:none;transform:translateY(8px)}.shiplet-review-comments-launcher{width:40px;padding:0;border-radius:9px}
.shiplet-review-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#fff;color:var(--shiplet-ink);font-size:10px;font-weight:800}
.shiplet-annotation-modebar{position:fixed;top:12px;left:50%;z-index:2147483550;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);min-height:42px;padding:5px 6px 5px 12px;transform:translateX(-50%);border:1px solid var(--shiplet-accent);border-radius:10px;background:var(--shiplet-surface);box-shadow:0 7px 22px rgba(0,0,0,.26);color:var(--shiplet-ink);font:800 12px/1.2 ui-sans-serif,system-ui,sans-serif;white-space:nowrap}.shiplet-annotation-modebar[hidden]{display:none}.shiplet-annotation-modebar button{min-width:34px;min-height:32px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui;cursor:pointer}
.shiplet-annotation-target-focus{position:fixed;z-index:2147483518;border:2px solid var(--shiplet-accent);border-radius:6px;background:rgba(47,110,136,.05);box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 4px rgba(47,110,136,.16);pointer-events:none}.shiplet-annotation-target-focus::before,.shiplet-annotation-target-focus::after{content:"";position:absolute;width:18px;height:18px;border-color:var(--shiplet-action)}.shiplet-annotation-target-focus::before{top:-3px;left:-3px;border-top:3px solid var(--shiplet-action);border-left:3px solid var(--shiplet-action);border-radius:6px 0 0}.shiplet-annotation-target-focus::after{right:-3px;bottom:-3px;border-right:3px solid var(--shiplet-action);border-bottom:3px solid var(--shiplet-action);border-radius:0 0 6px}.shiplet-annotation-target-focus[hidden]{display:none}.shiplet-annotation-target-pin{position:fixed;z-index:2147483520;width:28px;height:24px;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:9px;background:var(--shiplet-action);box-shadow:0 0 0 2px var(--shiplet-ink),0 5px 12px rgba(0,0,0,.34);pointer-events:none}.shiplet-annotation-target-pin::after{content:"";position:absolute;left:5px;bottom:-6px;width:8px;height:8px;border-right:2px solid #fff;border-bottom:2px solid #fff;background:var(--shiplet-action);transform:rotate(45deg)}.shiplet-annotation-target-pin[hidden]{display:none}
.shiplet-review-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
iframe[data-shiplet-artifact-frame][data-shiplet-selecting="true"]{outline:3px solid #1677ff;outline-offset:-3px;filter:saturate(.96) brightness(.94)}
.shiplet-review-pin-layer{position:fixed;inset:0;z-index:28;pointer-events:none}.shiplet-review-pin{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;width:28px;height:28px;padding:0;border:2px solid #fff;border-radius:999px;background:#fff;box-shadow:0 0 0 2px #20293a,0 3px 10px rgba(0,0,0,.32);color:var(--shiplet-ink);font:800 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;pointer-events:auto;transition:background .14s ease,color .14s ease,box-shadow .14s ease,transform .14s ease}.shiplet-review-pin[data-active="true"]{transform:translate(-50%,-50%) scale(1.12);background:var(--shiplet-action);box-shadow:0 0 0 3px #20293a,0 5px 14px rgba(0,0,0,.36);color:#fff}
.shiplet-review-presence{position:fixed;top:16px;left:16px;z-index:30;display:flex;align-items:center;gap:6px;min-height:38px;padding:4px 7px 4px 10px;border:1px solid var(--shiplet-line);border-radius:999px;background:var(--shiplet-surface);box-shadow:0 3px 12px rgba(32,41,58,.18)}.shiplet-review-presence[hidden]{display:none}.shiplet-review-presence-summary{margin-right:3px;color:var(--shiplet-muted);font-size:11px;font-weight:700}.shiplet-review-presence-avatar{display:inline-grid;place-items:center;width:28px;height:28px;border:2px solid var(--shiplet-ink);border-radius:999px;background:#fff;color:var(--shiplet-ink);font:800 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
#shiplet-kernel-review-panel{position:fixed;right:12px;bottom:12px;z-index:30;display:grid;align-content:start;width:min(312px,calc(100vw - 24px));max-height:min(520px,calc(100dvh - 24px));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--shiplet-line);border-radius:11px;background:var(--shiplet-surface);box-shadow:0 10px 32px rgba(32,41,58,.2)}#shiplet-kernel-review-panel[hidden]{display:none}[data-shiplet-kernel-review-controls]{display:grid;min-width:0;grid-template-columns:minmax(0,1fr)}
.shiplet-review-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:9px 9px 8px 11px;border-bottom:1px solid #d7dbe3;background:rgba(251,249,244,.97);backdrop-filter:blur(8px)}.shiplet-review-heading{min-width:0}.shiplet-review-head h2{margin:0;font-size:14px;line-height:1.2}.shiplet-review-context-disclosure{position:relative;max-width:100%;margin-top:2px}.shiplet-review-context-disclosure summary{display:block;max-width:100%;overflow:hidden;color:var(--shiplet-muted);font:700 10px/1.3 ui-sans-serif,system-ui,sans-serif;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;list-style:none}.shiplet-review-context-disclosure summary::-webkit-details-marker{display:none}.shiplet-review-context-disclosure summary::before{content:"↳ ";color:var(--shiplet-action)}.shiplet-review-context{position:absolute;top:18px;left:0;z-index:4;width:min(294px,calc(100vw - 44px));margin:0;padding:7px 8px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;box-shadow:0 6px 18px rgba(32,41,58,.18);color:var(--shiplet-muted);font:650 10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.shiplet-review-composer-context{margin:3px 0 0;color:var(--shiplet-muted);font:650 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shiplet-review-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.shiplet-review-secondary,.shiplet-review-icon,.shiplet-review-primary,.shiplet-review-thread-action,.shiplet-review-status-more summary,.shiplet-review-options summary,.shiplet-review-reply-form button{min-height:32px;padding:0 8px;border:1px solid var(--shiplet-line);border-radius:7px;background:var(--shiplet-raised);color:var(--shiplet-ink);font:700 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.shiplet-review-primary{border-color:#8f321c;background:var(--shiplet-action);color:#fff}.shiplet-review-icon{font-size:0;width:32px;padding:0}.shiplet-review-icon::before{content:"×";font-size:20px;font-weight:400}.shiplet-review-nav{width:30px;font-size:13px}.shiplet-review-nav::before{content:none}.shiplet-review-compose{width:32px;padding:0;font-size:17px;color:var(--shiplet-muted)}.shiplet-review-options,.shiplet-review-status-more{position:relative}.shiplet-review-options summary,.shiplet-review-status-more summary{display:grid;place-items:center;padding:0;list-style:none}.shiplet-review-options summary{width:30px}.shiplet-review-status-more summary{width:auto;padding:0 7px;color:var(--shiplet-muted)}.shiplet-review-options summary::-webkit-details-marker,.shiplet-review-status-more summary::-webkit-details-marker{display:none}.shiplet-review-options>div{position:absolute;top:36px;right:0;display:grid;gap:5px;min-width:126px;padding:6px;border:1px solid var(--shiplet-line);border-radius:8px;background:#fff;box-shadow:0 8px 22px rgba(32,41,58,.2)}
.shiplet-review-status{min-height:0;margin:0;padding:6px 11px;color:var(--shiplet-muted);font-size:10px}.shiplet-review-status[hidden]{display:none}.shiplet-review-status[data-state="error"]{border-bottom:1px solid #e5b7ad;background:#f8e9e5;color:#8c2a1c}
.shiplet-review-list{display:grid;min-width:0;gap:6px;margin:0;padding:7px 8px 8px;list-style:none}.shiplet-review-list>li{min-width:0;padding:0;border:1px solid #d7dbe3;border-radius:8px;background:var(--shiplet-raised);color:#3a4459;overflow-wrap:anywhere;transition:border-color .14s ease,box-shadow .14s ease,background .14s ease}.shiplet-review-list>li[data-active="true"]{border-color:#a7b9c3;box-shadow:inset 2px 0 0 var(--shiplet-accent);background:#f8fbfc}.shiplet-review-thread-summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 8px;width:100%;max-width:100%;min-width:0;min-height:48px;padding:8px 9px;border:0;border-radius:7px;background:transparent;color:var(--shiplet-ink);text-align:left;cursor:pointer}.shiplet-review-thread-author{grid-column:1/3;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:800}.shiplet-review-thread-time{grid-column:3;color:var(--shiplet-muted);font-size:10px}.shiplet-review-thread-summary strong{grid-column:1;font-size:10px;color:var(--shiplet-action)}.shiplet-review-thread-summary-comment{grid-column:2/4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3a4459;font-size:12px}.shiplet-review-thread-summary-comment[hidden]{display:none}.shiplet-review-thread-details{display:grid;gap:8px;padding:8px 9px 9px;border-top:1px solid #e5e7eb}.shiplet-review-thread-details[hidden],.shiplet-review-form[hidden]{display:none}.shiplet-review-thread-meta{display:flex;align-items:center;justify-content:flex-start;gap:5px;flex-wrap:wrap}.shiplet-review-status-more select{position:absolute;right:0;z-index:2;width:130px;padding:6px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff}.shiplet-review-thread-comment{margin:0;font-size:13px;white-space:pre-wrap}.shiplet-review-replies{display:grid;gap:6px;margin:0;padding:0 0 0 12px;list-style:none}.shiplet-review-replies:empty{display:none}.shiplet-review-replies li{padding:7px 8px;border-left:2px solid #d7dbe3;background:#f7f8fa}.shiplet-review-reply-meta{display:flex;gap:7px;color:var(--shiplet-muted);font-size:10px}.shiplet-review-reply-author{font-weight:800;color:#3a4459}.shiplet-review-replies p{margin:3px 0 0;font-size:12px}.shiplet-review-reply-form{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:5px;padding-top:8px;border-top:1px solid #e5e7eb}.shiplet-review-reply-form input{min-width:0;min-height:34px;width:100%;padding:0 8px;border:1px solid #9ca3af;border-radius:7px;background:#fff;color:var(--shiplet-ink)}.shiplet-review-reply-form button{border-color:#8f321c;background:var(--shiplet-action);color:#fff}.shiplet-review-reply-form select{grid-column:1/-1;max-width:100%}
.shiplet-review-form{position:fixed;z-index:2147483530;display:grid;width:min(360px,calc(100vw - 16px));max-width:calc(100vw - 16px);margin:0;border:1px solid var(--shiplet-accent);background:var(--shiplet-surface);box-shadow:0 16px 42px rgba(32,41,58,.28),0 0 0 1px rgba(255,255,255,.75);color:var(--shiplet-ink);font:13px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}.shiplet-review-form[data-annotation-state="compact"]{grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px;border-radius:12px}.shiplet-review-form[data-annotation-state="expanded"]{gap:10px;max-height:min(520px,calc(100dvh - 16px));padding:0 12px 12px;border-radius:12px;overflow-x:hidden;overflow-y:auto}.shiplet-review-form[hidden]{display:none}
.shiplet-annotation-card-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 -12px;padding:10px 10px 9px 12px;border-bottom:1px solid #d7dbe3;background:rgba(251,249,244,.97);backdrop-filter:blur(8px)}.shiplet-annotation-card-heading{display:grid;min-width:0;gap:2px}.shiplet-annotation-card-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.shiplet-annotation-exact-context{color:var(--shiplet-muted);font:700 10px/1.3 ui-sans-serif,system-ui,sans-serif;overflow-wrap:anywhere}.shiplet-annotation-card-controls{display:flex;flex:0 0 auto;gap:5px}.shiplet-annotation-drag-handle,.shiplet-annotation-card-close{min-height:32px;padding:0 9px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-muted)}.shiplet-annotation-drag-handle{display:inline-flex;align-items:center;gap:6px;cursor:grab;touch-action:none;font:750 10px/1 ui-sans-serif,system-ui}.shiplet-annotation-drag-handle::before{content:"⠿";font-size:16px;letter-spacing:-2px}.shiplet-annotation-card-close{width:34px;padding:0;cursor:pointer;font-size:0}.shiplet-annotation-card-close::before{content:"×";font:400 20px/1 ui-sans-serif}.shiplet-review-form[data-dragging="true"] .shiplet-annotation-drag-handle{cursor:grabbing;border-color:var(--shiplet-accent);background:#e3edf2;color:var(--shiplet-accent)}
.shiplet-review-form textarea{grid-column:1;min-width:0;width:100%;min-height:46px;max-height:120px;resize:none;padding:11px 10px;border:1px solid #aeb5c2;border-radius:8px;background:#fff;color:var(--shiplet-ink);font:inherit;line-height:1.35}.shiplet-review-form textarea::placeholder{color:#748097}.shiplet-review-form textarea:focus{border-color:var(--shiplet-accent);outline:2px solid rgba(47,110,136,.18)}.shiplet-review-form[data-annotation-state="expanded"] textarea{grid-column:auto;min-height:92px;resize:vertical}.shiplet-review-composer-context{display:none}.shiplet-review-mentions{padding:7px 8px;border:1px solid #d7dbe3;border-radius:7px;background:#fff}.shiplet-review-mentions summary{cursor:pointer;font-size:11px;font-weight:700}.shiplet-review-mentions select{width:100%;margin-top:7px}.shiplet-review-capture-tools,.shiplet-review-composer-actions{display:flex;flex-wrap:wrap;gap:6px}.shiplet-review-capture-tools{padding-top:2px}.shiplet-review-composer-actions{grid-column:2;align-items:center;justify-content:flex-end}.shiplet-review-composer-actions button{min-height:40px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:8px;background:#fff;color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui;cursor:pointer}.shiplet-review-composer-actions button[type="submit"],[data-shiplet-widget-confirm]{border-color:#8f321c;background:var(--shiplet-action);color:#fff}.shiplet-annotation-settings{width:40px;padding:0!important;border-color:#9cb8c4!important;background:#edf5f7!important;color:var(--shiplet-accent)!important;font-size:0!important}.shiplet-annotation-settings::before{content:"⚙";font-size:17px}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions{flex-wrap:nowrap}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions [data-shiplet-review-cancel-compose]{display:none}.shiplet-review-form[data-annotation-state="compact"] .shiplet-annotation-card-header,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-context,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-target,.shiplet-review-form[data-annotation-state="compact"] .shiplet-annotation-properties,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-mentions,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-capture-tools{display:none}.shiplet-review-form[data-annotation-state="expanded"] .shiplet-review-composer-actions{grid-column:auto}.shiplet-review-form[data-annotation-state="expanded"] .shiplet-annotation-settings{display:none}.shiplet-review-target{justify-self:start;max-width:100%;min-height:28px;margin:0;padding:6px 9px;border:1px solid #9cb8c4;border-radius:999px;background:#edf5f7;color:#245b72;font-size:11px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shiplet-annotation-properties{margin:0;border:1px solid #d7dbe3;border-radius:8px;background:#fff;color:var(--shiplet-ink);overflow:hidden}.shiplet-annotation-properties summary{min-height:38px;padding:10px 12px;color:#3a4459;font-size:11px;font-weight:800;cursor:pointer;list-style:none}.shiplet-annotation-properties summary::after{content:"+";float:right;color:var(--shiplet-accent);font-size:16px;line-height:12px}.shiplet-annotation-properties[open] summary::after{content:"−"}.shiplet-annotation-property-rows{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 12px;margin:0;padding:10px 12px;border-top:1px solid #e5e7eb;font:11px/1.35 ui-sans-serif,system-ui,sans-serif}.shiplet-annotation-property-label{margin:0;color:var(--shiplet-muted);font-weight:700}.shiplet-annotation-property-value{min-width:0;margin:0;color:var(--shiplet-ink);text-align:right;overflow-wrap:anywhere}
.shiplet-review-annotation-editor{position:fixed;inset:0;z-index:2147483510;pointer-events:none}.shiplet-review-annotation-editor[data-drawing="true"]{z-index:2147483600;background:rgba(32,41,58,.08);pointer-events:auto}.shiplet-review-annotation-editor canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none}.shiplet-review-annotation-editor[data-drawing="true"] canvas{pointer-events:auto;cursor:crosshair}.shiplet-review-annotation-toolbar{position:absolute;top:14px;left:50%;display:flex;gap:8px;transform:translateX(-50%);padding:8px;border:1px solid var(--shiplet-ink);border-radius:9px;background:var(--shiplet-surface);box-shadow:0 6px 24px rgba(32,41,58,.28);pointer-events:auto}.shiplet-review-annotation-toolbar button{min-height:38px;padding:0 12px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font-weight:750}
.shiplet-widget-recovery{display:grid;gap:8px;margin:0 10px 10px;padding:10px;border:1px solid #e5b7ad;border-radius:8px;background:#f8e9e5;color:#8c2a1c}.shiplet-widget-recovery[hidden]{display:none}.shiplet-widget-recovery p{margin:0;overflow-wrap:anywhere}iframe[data-shiplet-widget-frame]{width:calc(100% - 20px);min-height:220px;margin:0 10px 10px;border:1px solid #d7dbe3;border-radius:8px;background:#fff}[data-shiplet-widget-confirmation]{display:grid;gap:8px;margin:0 10px 10px;padding:10px;border:2px solid var(--shiplet-accent);border-radius:8px;background:#fff}[data-shiplet-widget-confirmation][hidden]{display:none}[data-shiplet-widget-confirmation] h3,[data-shiplet-widget-confirmation] p{margin:0;overflow-wrap:anywhere}[data-shiplet-widget-cancel]{justify-self:start;min-height:34px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font:700 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
button:disabled{cursor:wait;opacity:.58}:focus-visible{outline:3px solid #2f6e88;outline-offset:2px}
@media (max-width:480px){#shiplet-kernel-review-panel{right:8px;bottom:8px;width:calc(100vw - 16px);max-height:min(68dvh,560px);border-radius:12px}.shiplet-review-launcher-dock{right:10px;bottom:10px}.shiplet-review-launcher,.shiplet-review-comments-launcher{min-height:44px}.shiplet-review-comments-launcher{width:44px}.shiplet-annotation-modebar{top:8px;width:calc(100vw - 16px);min-height:44px;justify-content:space-between}.shiplet-annotation-modebar button{min-width:44px;min-height:44px}.shiplet-review-form{width:calc(100vw - 16px);max-width:calc(100vw - 16px)}.shiplet-review-form[data-annotation-state="compact"]{grid-template-columns:minmax(0,1fr) auto}.shiplet-review-form[data-annotation-state="expanded"]{max-height:calc(100dvh - 16px)}.shiplet-review-form textarea{min-height:52px;font-size:16px}.shiplet-annotation-drag-handle,.shiplet-annotation-card-close,.shiplet-review-composer-actions button{min-width:44px;min-height:44px}.shiplet-review-presence{top:10px;left:10px;max-width:calc(100vw - 20px)}.shiplet-review-presence-summary{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.shiplet-review-head{flex-wrap:wrap}.shiplet-review-heading{flex-basis:100%}.shiplet-review-context-disclosure summary{display:flex;align-items:center;min-height:44px}.shiplet-review-actions{width:100%;justify-content:flex-end}.shiplet-review-compose{width:44px;padding:0;font-size:18px}.shiplet-review-secondary,.shiplet-review-icon,.shiplet-review-primary,.shiplet-review-thread-action,.shiplet-review-status-more summary,.shiplet-review-options summary,.shiplet-review-reply-form button,.shiplet-review-composer-actions button,.shiplet-review-capture-tools button{min-width:44px;min-height:44px}.shiplet-review-reply-form input{min-height:44px}.shiplet-review-thread-summary{min-height:52px}.shiplet-review-annotation-toolbar{top:8px;left:8px;right:8px;transform:none;justify-content:center}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}
`;
}

function utf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function trustedWidgetWorkerSource(source: string): string {
  const userSource = source.replace(/^#!([^\r\n]*)/, "//$1");
  return (
    String.raw`"use strict";
const __shipletRuntime = (() => {
  const handlers = new Map();
  const pending = new Map();
  let sequence = 0;
  const send = (value) => postMessage(value);
  const denyGlobal = (name) => {
    let current = globalThis;
    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        try {
          if (descriptor.configurable) delete current[name];
          else if (descriptor.writable) current[name] = undefined;
        } catch {}
      }
      current = Object.getPrototypeOf(current);
    }
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}
  };
  for (const name of [
    "BroadcastChannel",
    "EventSource",
    "FileSystemFileHandle",
    "FileSystemHandle",
    "FileSystemWritableFileStream",
    "Notification",
    "RTCPeerConnection",
    "SharedWorker",
    "WebSocket",
    "WebSocketStream",
    "WebTransport",
    "Worker",
    "XMLHttpRequest",
    "fetch",
    "importScripts",
  ]) denyGlobal(name);
  const selector = (value) => {
    if (typeof value !== "string" || value.length > 256) throw new TypeError("Invalid widget selector");
    return value;
  };
  const api = Object.freeze({
    text(value, text) {
      send({ protocol: "shiplet.widget.worker.v1", type: "mutation", kind: "text", selector: selector(value), value: String(text).slice(0, 4096) });
    },
    attribute(value, name, attributeValue) {
      send({ protocol: "shiplet.widget.worker.v1", type: "mutation", kind: "attribute", selector: selector(value), name: String(name), value: String(attributeValue).slice(0, 4096) });
    },
    property(value, name, propertyValue) {
      send({ protocol: "shiplet.widget.worker.v1", type: "mutation", kind: "property", selector: selector(value), name: String(name), value: propertyValue });
    },
    on(value, eventType, handler) {
      if (typeof handler !== "function" || handlers.size >= 128) throw new TypeError("Invalid widget handler");
      const handlerId = "handler_" + (++sequence).toString(36);
      handlers.set(handlerId, handler);
      send({ protocol: "shiplet.widget.worker.v1", type: "bind", selector: selector(value), eventType: String(eventType), handlerId });
      return handlerId;
    },
    request(operation, payload) {
      const requestId = "request_" + (++sequence).toString(36);
      send({ protocol: "shiplet.widget.worker.v1", type: "operation", requestId, operation, payload });
      return new Promise((resolve) => pending.set(requestId, resolve));
    },
  });
  const element = (value) => Object.freeze({
    addEventListener: (eventType, handler) => api.on(value, eventType, handler),
    setAttribute: (name, attributeValue) => api.attribute(value, name, attributeValue),
    set textContent(text) { api.text(value, text); },
    set hidden(next) { api.property(value, "hidden", Boolean(next)); },
    set disabled(next) { api.property(value, "disabled", Boolean(next)); },
  });
  Object.defineProperty(globalThis, "shipletWidget", { value: api, writable: false, configurable: false });
  Object.defineProperty(globalThis, "document", {
    value: Object.freeze({
      querySelector: (value) => element(selector(value)),
      getElementById: (value) => element("#" + String(value)),
    }),
    writable: false,
    configurable: false,
  });
  addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.protocol !== "shiplet.widget.worker.v1") return;
    if (data.type === "ping" && typeof data.heartbeatId === "number") {
      send({ protocol: "shiplet.widget.worker.v1", type: "pong", heartbeatId: data.heartbeatId });
    } else if (data.type === "event" && handlers.has(data.handlerId)) {
      try { handlers.get(data.handlerId)(Object.freeze({ ...data.event, isTrusted: true })); }
      finally { send({ protocol: "shiplet.widget.worker.v1", type: "event.complete", handlerId: data.handlerId }); }
    } else if (data.type === "operation.result" && pending.has(data.requestId)) {
      const resolve = pending.get(data.requestId);
      pending.delete(data.requestId);
      resolve(data);
    }
  });
  return Object.freeze({
    ready() { send({ protocol: "shiplet.widget.worker.v1", type: "ready" }); },
    failed() { send({ protocol: "shiplet.widget.worker.v1", type: "failed" }); },
  });
})();
try {
  (() => {
` +
    userSource +
    String.raw`
  })();
  __shipletRuntime.ready();
} catch {
  __shipletRuntime.failed();
}`
  );
}

function trustedWidgetCompartmentScript(input: {
  templateHtml: string;
  scriptSource: string;
  shipletId: string;
  revisionId: string;
  trustedHostOrigin: string;
}): string {
  const templateBase64 = JSON.stringify(utf8Base64(input.templateHtml));
  const sourceBase64 = JSON.stringify(
    utf8Base64(trustedWidgetWorkerSource(input.scriptSource)),
  );
  const shipletId = JSON.stringify(input.shipletId);
  const revisionId = JSON.stringify(input.revisionId);
  const trustedHostOrigin = JSON.stringify(input.trustedHostOrigin);
  return String.raw`(() => {
	"use strict";
	const templateBase64 = ${templateBase64};
	const sourceBase64 = ${sourceBase64};
	const shipletId = ${shipletId};
	const revisionId = ${revisionId};
	const trustedHostOrigin = ${trustedHostOrigin};
	const root = document.querySelector("[data-shiplet-widget-root]");
	const status = document.querySelector("[data-shiplet-widget-status]");
	const restart = document.querySelector("[data-shiplet-widget-restart]");
	const allowedElements = new Set(["a","article","aside","audio","b","blockquote","br","button","code","dd","details","div","dl","dt","em","fieldset","figcaption","figure","footer","form","h1","h2","h3","h4","h5","h6","header","hr","i","img","input","label","legend","li","main","nav","ol","option","p","pre","progress","section","select","small","source","span","strong","style","summary","table","tbody","td","textarea","tfoot","th","thead","tr","track","u","ul","video"]);
	const allowedEvents = new Set(["click", "change", "input", "submit"]);
	const allowedInputTypes = new Set(["button","checkbox","color","date","datetime-local","email","month","number","radio","range","search","tel","text","time","url","week"]);
	const bindings = new Map();
	const pendingOperations = new Set();
	let nodeCount = 0;
	let messageCount = 0;
	let messageBytes = 0;
	let worker = null;
	let workerReady = false;
	let channelPort = null;
	let channelNonce = "";
	let channelConnected = false;
	let startupTimer = 0;
	let lifetimeTimer = 0;
	let heartbeatTimer = 0;
	let heartbeatDeadline = 0;
	let heartbeatSequence = 0;
	let terminal = false;

	function decodeBase64(value) {
		const binary = atob(value);
		return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
	}

	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	function bounded(value, max) {
		return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= max;
	}

	function simpleSelector(value) {
		return bounded(value, 256) && /^(?:#[A-Za-z][A-Za-z0-9_.:-]*|\.[A-Za-z][A-Za-z0-9_-]*|[a-z][a-z0-9-]*)$/.test(value);
	}

	function safeCss(value) {
		if (typeof value !== "string" || value.length > 32768 || /@import|expression\s*\(|behavior\s*:|-moz-binding/i.test(value)) return false;
		for (const match of value.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
			if (!/^(?:data:|blob:|#)/i.test(String(match[2] || "").trim())) return false;
		}
		return true;
	}

	function safeDataResource(value) {
		return typeof value === "string" && value.length <= 1048576 && /^data:(?:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|webp)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+|application\/(?:font-woff|font-woff2|octet-stream));base64,[A-Za-z0-9+/=]*$/i.test(value);
	}

	function copyAttribute(target, name, value) {
		if (value.length > 4096) return;
		if (name === "id" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) target.id = value;
		else if (name === "class" && /^[A-Za-z0-9 _-]{0,512}$/.test(value)) target.className = value;
		else if ((name.startsWith("aria-") || name.startsWith("data-")) && /^[a-z][a-z0-9_.:-]{0,63}$/i.test(name)) target.setAttribute(name, value);
		else if (["alt","autocomplete","cols","for","height","label","max","maxlength","min","minlength","name","placeholder","role","rows","scope","step","title","width"].includes(name)) target.setAttribute(name, value);
		else if (["checked","controls","disabled","hidden","loop","multiple","open","readonly","required","selected"].includes(name)) target.setAttribute(name, "");
		else if (name === "style" && safeCss(value)) target.setAttribute("style", value);
		else if ((name === "src" || name === "poster") && safeDataResource(value)) target.setAttribute(name, value);
		else if (name === "href" && value.startsWith("#") && value.length <= 129) target.setAttribute(name, value);
		else if (name === "type" && target.localName === "input" && allowedInputTypes.has(value.toLowerCase())) target.setAttribute(name, value.toLowerCase());
		else if (name === "type" && target.localName === "button") target.setAttribute(name, "button");
		else if (name === "value" && ["input","option","textarea"].includes(target.localName)) target.setAttribute(name, value);
	}

	function sanitizeNode(node, depth) {
		if (depth > 32 || nodeCount >= 512) return null;
		if (node.nodeType === Node.TEXT_NODE) {
			nodeCount += 1;
			return document.createTextNode(String(node.textContent || "").slice(0, 16384));
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return null;
		const name = String(node.localName || "").toLowerCase();
		if (name === "html" || name === "head" || name === "body") {
			const fragment = document.createDocumentFragment();
			for (const child of Array.from(node.childNodes)) {
				const safe = sanitizeNode(child, depth + 1);
				if (safe) fragment.appendChild(safe);
			}
			return fragment;
		}
		if (!allowedElements.has(name)) return null;
		nodeCount += 1;
		if (name === "style") {
			const css = String(node.textContent || "");
			if (!safeCss(css)) return null;
			const style = document.createElement("style");
			style.textContent = css;
			return style;
		}
		const target = document.createElement(name);
		if (name === "button") target.setAttribute("type", "button");
		if (name === "form") target.addEventListener("submit", (event) => event.preventDefault());
		for (const attribute of Array.from(node.attributes)) copyAttribute(target, attribute.name.toLowerCase(), attribute.value);
		for (const child of Array.from(node.childNodes)) {
			const safe = sanitizeNode(child, depth + 1);
			if (safe) target.appendChild(safe);
		}
		return target;
	}

	function renderTemplate() {
		if (!root) return false;
		const template = document.createElement("template");
		template.innerHTML = decodeBase64(templateBase64);
		const fragment = document.createDocumentFragment();
		for (const child of Array.from(template.content.childNodes)) {
			const safe = sanitizeNode(child, 0);
			if (safe) fragment.appendChild(safe);
		}
		root.replaceChildren(fragment);
		return true;
	}

	function failWidget(message) {
		if (terminal) return;
		terminal = true;
		window.clearTimeout(startupTimer);
		window.clearTimeout(lifetimeTimer);
		window.clearInterval(heartbeatTimer);
		window.clearTimeout(heartbeatDeadline);
		try { if (worker) worker.terminate(); } catch {}
		try { if (channelPort) channelPort.close(); } catch {}
		worker = null;
		channelPort = null;
		channelConnected = false;
		bindings.clear();
		pendingOperations.clear();
		if (root) root.inert = true;
		if (status) { status.hidden = false; status.textContent = message; }
		if (restart) restart.hidden = false;
	}

	function postWorker(value) {
		try { if (worker) worker.postMessage(value); } catch { failWidget("Custom widget stopped safely."); }
	}

	function applyMutation(data) {
		if (!root || !simpleSelector(data.selector)) return;
		let element = null;
		try { element = root.querySelector(data.selector); } catch { return; }
		if (!element) return;
		if (data.kind === "text" && typeof data.value === "string" && data.value.length <= 4096) element.textContent = data.value;
		else if (data.kind === "attribute" && bounded(data.name, 64) && typeof data.value === "string") copyAttribute(element, data.name.toLowerCase(), data.value);
		else if (data.kind === "property" && (data.name === "hidden" || data.name === "disabled") && typeof data.value === "boolean") element[data.name] = data.value;
	}

	function bindEvent(data) {
		if (!root || bindings.size >= 128 || !simpleSelector(data.selector) || !allowedEvents.has(data.eventType) || !bounded(data.handlerId, 128) || bindings.has(data.handlerId)) return;
		let element = null;
		try { element = root.querySelector(data.selector); } catch { return; }
		if (!element) return;
		bindings.set(data.handlerId, true);
		element.addEventListener(data.eventType, (event) => {
			if (!event.isTrusted) return;
			if (data.eventType === "submit") event.preventDefault();
			postWorker({ protocol: "shiplet.widget.worker.v1", type: "event", handlerId: data.handlerId, event: { type: event.type, value: typeof event.currentTarget?.value === "string" ? event.currentTarget.value.slice(0, 4096) : "", checked: event.currentTarget?.checked === true } });
		});
	}

	function forwardOperation(data) {
		if (!channelPort || !channelConnected || !bounded(data.requestId, 128) || pendingOperations.size >= 32 || pendingOperations.has(data.requestId)) return;
		if (data.operation !== "feedback.create" && data.operation !== "workflow.event.create") return;
		if (!isRecord(data.payload)) return;
		pendingOperations.add(data.requestId);
		channelPort.postMessage({ protocol: "shiplet.widget.operation.v1", type: "request", requestId: data.requestId, channelNonce, shipletId, revisionId, operation: data.operation, payload: data.payload });
	}

	function handleWorkerMessage(event) {
		const data = event.data;
		let size = 0;
		try { size = new TextEncoder().encode(JSON.stringify(data)).byteLength; } catch { failWidget("Custom widget sent an invalid message."); return; }
		messageCount += 1;
		messageBytes += size;
		if (size > 16384 || messageCount > 512 || messageBytes > 262144 || !isRecord(data) || data.protocol !== "shiplet.widget.worker.v1") { failWidget("Custom widget exceeded its runtime limit."); return; }
		if (data.type === "ready") {
			workerReady = true;
			window.clearTimeout(startupTimer);
			if (status) status.hidden = true;
			heartbeatTimer = window.setInterval(() => {
				if (!worker) return;
				const heartbeatId = ++heartbeatSequence;
				postWorker({ protocol: "shiplet.widget.worker.v1", type: "ping", heartbeatId });
				window.clearTimeout(heartbeatDeadline);
				heartbeatDeadline = window.setTimeout(() => failWidget("Custom widget exceeded its execution limit."), 750);
			}, 1000);
			return;
		}
		if (data.type === "pong" && data.heartbeatId === heartbeatSequence) { window.clearTimeout(heartbeatDeadline); return; }
		if (data.type === "mutation") applyMutation(data);
		else if (data.type === "bind") bindEvent(data);
		else if (workerReady && data.type === "operation") forwardOperation(data);
	}

	function startWorker() {
		if (!renderTemplate()) { failWidget("Custom widget could not be rendered."); return; }
		const bootstrap = decodeBase64(sourceBase64);
		const workerUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
		try { worker = new Worker(workerUrl, { name: "shiplet-widget-runtime-v1" }); } catch { URL.revokeObjectURL(workerUrl); failWidget("Custom widget could not start safely."); return; }
		URL.revokeObjectURL(workerUrl);
		worker.addEventListener("message", handleWorkerMessage);
		worker.addEventListener("error", (event) => { event.preventDefault(); failWidget("Custom widget stopped safely."); });
		startupTimer = window.setTimeout(() => { if (!workerReady) failWidget("Custom widget exceeded its startup limit."); }, 1000);
		lifetimeTimer = window.setTimeout(() => failWidget("Custom widget reached its session limit."), 300000);
	}

	window.addEventListener("message", (event) => {
		if (terminal) return;
		if (event.source !== parent || event.origin !== trustedHostOrigin || !isRecord(event.data)) return;
		const data = event.data;
		if (data.protocol !== "shiplet.widget.channel.v1" || data.channelNonce !== channelNonce && channelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId) return;
		if (data.type === "offer" && !channelConnected) {
			channelNonce = data.channelNonce;
			parent.postMessage({ protocol: "shiplet.widget.channel.v1", type: "ready", channelNonce, shipletId, revisionId }, trustedHostOrigin);
		} else if (data.type === "connect" && !channelConnected && data.channelNonce === channelNonce && event.ports.length === 1) {
			channelConnected = true;
			channelPort = event.ports[0];
			channelPort.addEventListener("message", (portEvent) => {
				const result = portEvent.data;
				if (!isRecord(result) || result.protocol !== "shiplet.widget.operation.result.v1" || !bounded(result.requestId, 128) || !pendingOperations.has(result.requestId)) return;
				pendingOperations.delete(result.requestId);
				postWorker({ protocol: "shiplet.widget.worker.v1", type: "operation.result", requestId: result.requestId, status: result.status });
			});
			channelPort.start();
		}
	});
	if (restart) restart.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true || !terminal || restart.disabled) return;
		restart.disabled = true;
		parent.postMessage({ protocol: "shiplet.widget.restart.v1", type: "request", channelNonce, shipletId, revisionId }, trustedHostOrigin);
	});

	window.addEventListener("beforeunload", () => failWidget("Custom widget stopped."));
	startWorker();
})();`;
}

function createTrustedWidgetCompartmentDocument(input: {
  templateHtml: string;
  scriptSource: string;
  nonce: string;
  shipletId: string;
  revisionId: string;
  trustedHostOrigin: string;
}): string {
  assertIdentifier(input.shipletId, "widget Shiplet ID");
  assertIdentifier(input.revisionId, "widget revision ID");
  const script = trustedWidgetCompartmentScript(input).replace(
    /<\/script/gi,
    "<\\/script",
  );
  return `<!doctype html><html lang="en" data-shiplet-widget-compartment="worker-v1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shiplet review widget</title><style>:root{font:14px/1.45 ui-sans-serif,system-ui,sans-serif;color:#20293a;background:#fff}*{box-sizing:border-box}body{margin:0;padding:12px}[data-shiplet-widget-status]{margin:0 0 10px;color:#8c2a1c}[data-shiplet-widget-restart]{min-height:36px;padding:0 12px;border:1px solid #8f321c;border-radius:7px;background:#b44729;color:#fff;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}[data-shiplet-widget-restart]:focus-visible{outline:3px solid #2f6e88;outline-offset:2px}</style></head><body><main data-shiplet-widget-root></main><p data-shiplet-widget-status role="status" hidden>Custom widget unavailable.</p><button type="button" data-shiplet-widget-restart hidden>Restart widget</button><script nonce="${escapeHtml(input.nonce)}">${script}</script></body></html>`;
}

export function createSandboxedArtifactResponse(
  input: SandboxedArtifactResponseInput,
): Response {
  if (
    typeof input.contentType !== "string" ||
    input.contentType.length === 0 ||
    utf8Length(input.contentType) > 256 ||
    /[\r\n]/.test(input.contentType)
  ) {
    throw new TypeError("Invalid artifact content type");
  }
  const trustedHostOrigin = parseOrigin(
    input.trustedHostOrigin,
    "trusted host",
  );
  if (input.allowDownloads && input.role !== "artifact") {
    throw new TypeError("Downloads can only be enabled for artifact responses");
  }
  const allowedEgressOrigins = Array.from(
    new Set(
      (input.allowedEgressOrigins ?? []).map((origin) =>
        parseOrigin(origin, "egress"),
      ),
    ),
  ).sort();
  if (allowedEgressOrigins.length > 0) {
    throw new TypeError(
      "Artifact egress is limited to the trusted host origin",
    );
  }
  const connectSource =
    input.role === "artifact" ? trustedHostOrigin : "'none'";
  const baseSource = input.role === "artifact" ? trustedHostOrigin : "'none'";
  const sharedTail = [
    "object-src 'none'",
    `connect-src ${connectSource}`,
    "form-action 'none'",
    `base-uri ${baseSource}`,
    `frame-ancestors ${trustedHostOrigin}`,
  ];
  const nonce = createDocumentNonce();
  const csp =
    input.role === "review_context"
      ? [
          "sandbox",
          "default-src 'none'",
          "script-src 'none'",
          "script-src-attr 'none'",
          "style-src 'none'",
          "img-src 'none'",
          "font-src 'none'",
          "media-src 'none'",
          ...sharedTail,
        ].join("; ")
      : input.role === "widget"
        ? [
            "sandbox allow-scripts",
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            "script-src-attr 'none'",
            "worker-src blob:",
            "frame-src 'none'",
            "style-src 'unsafe-inline' data: blob:",
            "img-src data: blob:",
            "font-src data:",
            "media-src data: blob:",
            ...sharedTail,
          ].join("; ")
        : [
            input.allowDownloads
              ? "sandbox allow-scripts allow-forms allow-downloads"
              : "sandbox allow-scripts allow-forms",
            "default-src 'none'",
            `script-src ${trustedHostOrigin} 'unsafe-inline' 'unsafe-eval' data: blob:`,
            `style-src ${trustedHostOrigin} 'unsafe-inline' blob:`,
            `img-src ${trustedHostOrigin} data: blob:`,
            `font-src ${trustedHostOrigin} data:`,
            `media-src ${trustedHostOrigin} data: blob:`,
            ...sharedTail,
          ].join("; ");
  const headers = securityHeaders(csp);
  const widgetBody =
    input.role === "widget"
      ? createTrustedWidgetCompartmentDocument({
          templateHtml:
            typeof input.body === "string"
              ? input.body
              : (() => {
                  throw new TypeError("Widget template must be UTF-8 text");
                })(),
          scriptSource: input.widgetRuntime?.scriptSource ?? "",
          nonce,
          shipletId: input.widgetRuntime?.shipletId ?? "shiplet_preview",
          revisionId: input.widgetRuntime?.revisionId ?? "revision_preview",
          trustedHostOrigin,
        })
      : input.body;
  headers.set(
    "content-type",
    input.role === "widget" ? "text/html; charset=utf-8" : input.contentType,
  );
  for (const name of [
    "accept-ranges",
    "allow",
    "content-disposition",
    "content-length",
    "content-range",
    "etag",
    "last-modified",
    "x-shiplet-runtime-status",
    "x-shiplet-static-fallback",
  ]) {
    if (input.role === "widget" && name === "content-length") continue;
    const value = input.sourceHeaders?.get(name);
    if (value !== null && value !== undefined) headers.set(name, value);
  }
  const status = input.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new TypeError("Invalid artifact response status");
  }
  return new Response(widgetBody, { status, headers });
}
