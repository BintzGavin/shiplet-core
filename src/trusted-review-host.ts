import {
  AVATAR_PRESETS,
  AVATAR_SPRITE_COLUMNS,
  AVATAR_SPRITE_ROWS,
  AVATAR_SPRITE_URL,
} from "./avatars";
import {
  reviewAnnotationEditorScript,
  reviewAnnotationEditorStyles,
} from "./review-annotation-editor";
import {
  reviewAttachmentDraftScript,
  reviewAttachmentDraftStyles,
} from "./review-attachment-drafts";

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
  embeddedSiteOrigin?: string;
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
  const fragment = url.hash;
  url.hash = "";
  if (fragment.startsWith("#/") && !fragment.startsWith("#//") && depth < 8) {
    const route = new URL(fragment.slice(1), url.origin);
    if (route.origin === url.origin) {
      const sanitized = sanitizeReviewPageUrl(route, depth + 1);
      url.hash = `#${sanitized.pathname}${sanitized.search}`;
    }
  }
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
  const embeddedSiteOrigin = input.embeddedSiteOrigin
    ? parseOrigin(input.embeddedSiteOrigin, "embedded site")
    : "";
  if (embeddedSiteOrigin && !frameAncestorOrigins.includes(embeddedSiteOrigin))
    throw new TypeError("Embedded site must be an allowed frame ancestor");
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
  const draftContextUrl = (() => {
    const url = new URL(reviewApiUrl);
    if (embeddedSiteOrigin) {
      url.pathname = "/embed/review/draft-context";
      url.search = "";
      url.searchParams.set("installation_id", new URL(reviewApiUrl).searchParams.get("installation_id") || "");
      return url.toString();
    }
    if (/\/__shiplet\/review\/feedback$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(
        /\/__shiplet\/review\/feedback$/,
        "/__shiplet/review/draft-context",
      );
      url.search = "";
      return url.toString();
    }
    if (/\/review-feedback$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/review-feedback$/, "/review-draft-context");
      url.search = "";
      return url.toString();
    }
    throw new TypeError("Invalid review API URL for draft context");
  })();
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
    `img-src 'self' ${hostScriptUrl.origin} data: blob:`,
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
<html lang="en" data-shiplet-trusted-review-host="v1" data-review-state="ready" data-review-embed-origin="${escapeHtml(embeddedSiteOrigin)}" data-shiplet-embed-origin="${escapeHtml(embeddedSiteOrigin)}" data-shiplet-id="${escapeHtml(input.shipletId)}" data-revision-id="${escapeHtml(input.revisionId)}" data-review-avatar-url="${escapeHtml(new URL(AVATAR_SPRITE_URL, hostScriptUrl.origin).toString())}" data-review-api-url="${escapeHtml(reviewApiUrl.toString())}" data-review-draft-context-url="${escapeHtml(draftContextUrl)}" data-review-artifact-url="${escapeHtml(artifactUrl.toString())}" data-review-confirm-url="${escapeHtml(confirmationUrl.toString())}" data-review-page-url="${escapeHtml(reviewPageUrl)}" data-review-submission-mode="${submissionMode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Shiplet</title>
<link rel="stylesheet" href="${escapeHtml(`${hostScriptUrl.origin}/api/review/host.css`)}">
<script src="${escapeHtml(hostScriptUrl.toString())}" nonce="${nonce}" defer></script>
</head>
<body>
<main aria-label="${title}">
${embeddedSiteOrigin ? '<div data-shiplet-artifact-frame="v1" hidden></div>' : `<iframe data-shiplet-artifact-frame="v1" title="Artifact for ${title}" src="${escapeHtml(artifactUrl.toString())}" sandbox="${artifactSandbox}" referrerpolicy="no-referrer"></iframe>`}
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
  const annotationEditor = reviewAnnotationEditorScript();
  const attachmentDrafts = reviewAttachmentDraftScript();
  return String.raw`(() => {
	"use strict";
${annotationEditor}
${attachmentDrafts}
	const page = document.documentElement;
	const embeddedSiteOrigin = page.getAttribute("data-shiplet-embed-origin") || "";
	const draftContextUrl = page.getAttribute("data-review-draft-context-url") || "";
	const artifactInitialUrl = page.getAttribute("data-review-artifact-url") || "";
	let currentArtifactRouteUrl = artifactInitialUrl;
	const panel = document.getElementById("shiplet-kernel-review-panel");
	const controls = document.querySelector("[data-shiplet-kernel-review-controls]");
	const apiUrl = page.getAttribute("data-review-api-url") || "";
	const reviewConfirmationUrl = page.getAttribute("data-review-confirm-url") || "";
	let reviewPageUrl = page.getAttribute("data-review-page-url") || location.href;
	const reviewSubmissionMode = page.getAttribute("data-review-submission-mode") === "sandbox" ? "sandbox" : "confirmation";
	const shipletId = page.getAttribute("data-shiplet-id") || "";
	const revisionId = page.getAttribute("data-revision-id") || "";
	const avatarPresets = ${avatarPresets};
	const avatarSpriteUrl = page.getAttribute("data-review-avatar-url") || "";
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
	artifact.setAttribute("data-shiplet-selecting", "false");

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
	const overlayToggle = document.createElement("button");
	overlayToggle.type = "button";
	overlayToggle.className = "shiplet-review-secondary shiplet-review-overlay-toggle";
	overlayToggle.textContent = "Hide comments";
	overlayToggle.setAttribute("aria-pressed", "false");
	overlayToggle.setAttribute("data-shiplet-review-overlay-toggle", "v1");
	const pageCommentsButton = document.createElement("button");
	pageCommentsButton.type = "button";
	pageCommentsButton.className = "shiplet-review-page-comments";
	pageCommentsButton.textContent = "Page comments";
	pageCommentsButton.setAttribute("aria-haspopup", "menu");
	pageCommentsButton.setAttribute("aria-expanded", "false");
	pageCommentsButton.setAttribute("data-shiplet-review-page-comments", "v1");
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
	const settings = document.createElement("details");
	settings.className = "shiplet-review-settings";
	const settingsSummary = document.createElement("summary");
	settingsSummary.textContent = "Settings";
	const settingsPanel = document.createElement("div");
	settingsPanel.setAttribute("data-shiplet-review-settings", "v1");
	const dockLabel = document.createElement("label");
	dockLabel.textContent = "Dock";
	const dockSelect = document.createElement("select");
	dockSelect.setAttribute("aria-label", "Review dock");
	for (const dock of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
		const option = document.createElement("option");
		option.value = dock;
		option.textContent = dock.split("-").map(value => value[0].toUpperCase() + value.slice(1)).join(" ");
		dockSelect.appendChild(option);
	}
	dockLabel.appendChild(dockSelect);
	const launchLabel = document.createElement("label");
	launchLabel.textContent = "Launch";
	const launchSelect = document.createElement("select");
	launchSelect.setAttribute("aria-label", "Review launch behavior");
	for (const entry of [["manual", "Manual"], ["open-comments", "Open comments"]]) {
		const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; launchSelect.appendChild(option);
	}
	launchLabel.appendChild(launchSelect);
	const motionLabel = document.createElement("label");
	motionLabel.textContent = "Motion";
	const motionSelect = document.createElement("select");
	motionSelect.setAttribute("aria-label", "Review motion");
	for (const entry of [["system", "Use system setting"], ["reduced", "Reduce motion"]]) {
		const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; motionSelect.appendChild(option);
	}
	motionLabel.appendChild(motionSelect);
	const copyRequestsLabel = document.createElement("label");
	const copyRequestsToggle = document.createElement("input");
	copyRequestsToggle.type = "checkbox";
	copyRequestsToggle.setAttribute("aria-label", "Enable copy requests");
	const copyRequestsHelp = document.createElement("span");
	copyRequestsHelp.textContent = " Enable Copy request proposals. These are review proposals and never edit the artifact.";
	copyRequestsLabel.append(copyRequestsToggle, copyRequestsHelp);
	const copyHiddenReview = document.createElement("button");
	copyHiddenReview.type = "button";
	copyHiddenReview.textContent = "Copy review link with review UI hidden";
	const copyHiddenComments = document.createElement("button");
	copyHiddenComments.type = "button";
	copyHiddenComments.textContent = "Copy review link with comments hidden";
	const cleanLinkFallback = document.createElement("input");
	cleanLinkFallback.readOnly = true;
	cleanLinkFallback.hidden = true;
	cleanLinkFallback.setAttribute("aria-label", "Review link to copy");
	const restoreVisibility = document.createElement("button");
	restoreVisibility.type = "button";
	restoreVisibility.textContent = "Show review UI";
	restoreVisibility.hidden = true;
	settingsPanel.append(dockLabel, launchLabel, motionLabel, copyRequestsLabel, copyHiddenReview, copyHiddenComments, cleanLinkFallback, restoreVisibility);
	settings.append(settingsSummary, settingsPanel);
	const customActions = document.createElement("details");
	customActions.className = "shiplet-review-custom-actions";
	customActions.hidden = !widget;
	const customActionsSummary = document.createElement("summary");
	customActionsSummary.textContent = "Custom actions";
	const customActionsBody = document.createElement("p");
	customActionsBody.textContent = "Configured review actions run in an isolated widget and require confirmation.";
	customActions.append(customActionsSummary, customActionsBody);
	optionsActions.append(watchButton, refreshButton, overlayToggle, settings, customActions);
	optionsMenu.append(optionsSummary, optionsActions);
	const closeButton = document.createElement("button");
	closeButton.type = "button";
	closeButton.className = "shiplet-review-icon";
	closeButton.textContent = "Close";
	closeButton.setAttribute("aria-label", "Close review panel");
	closeButton.setAttribute("data-shiplet-review-close", "v1");
	if (embeddedSiteOrigin) {
		pageCommentsButton.className += " shiplet-review-page-comments-embedded";
		actions.append(pageCommentsButton);
	}
	actions.append(previousButton, nextButton, composeButton, optionsMenu, closeButton);
	header.append(headingGroup, actions);
	const creationMenu = document.createElement("section");
	creationMenu.className = "shiplet-review-create-menu";
	creationMenu.setAttribute("aria-label", "Create review feedback");
	creationMenu.hidden = true;
	const pageComment = document.createElement("button");
	pageComment.type = "button";
	pageComment.textContent = "Page comment";
	pageComment.setAttribute("aria-label", "Page comment");
	const drawOnPage = document.createElement("button");
	drawOnPage.type = "button";
	drawOnPage.textContent = "Draw on page";
	drawOnPage.setAttribute("aria-label", "Draw on page");
	const selectElement = document.createElement("button");
	selectElement.type = "button";
	selectElement.textContent = "Select an element";
	selectElement.setAttribute("aria-label", "Select an element");
	creationMenu.append(pageComment, drawOnPage, selectElement);
	const status = document.createElement("p");
	status.className = "shiplet-review-status";
	status.setAttribute("role", "status");
	const staleIndicator = document.createElement("section");
	staleIndicator.className = "shiplet-review-status shiplet-review-stale";
	staleIndicator.setAttribute("data-shiplet-review-stale", "v1");
	staleIndicator.setAttribute("role", "status");
	staleIndicator.setAttribute("aria-live", "polite");
	staleIndicator.hidden = true;
	const staleMessage = document.createElement("span");
	const staleRefresh = document.createElement("button");
	staleRefresh.type = "button";
	staleRefresh.className = "shiplet-review-secondary";
	staleRefresh.textContent = "Refresh";
	staleRefresh.setAttribute("aria-label", "Refresh comments");
	staleIndicator.append(staleMessage, staleRefresh);
	const storageNotice = document.createElement("section");
	storageNotice.className = "shiplet-review-status shiplet-review-storage-notice";
	storageNotice.setAttribute("data-shiplet-review-storage", "v1");
	storageNotice.setAttribute("role", "status");
	storageNotice.hidden = true;
	const storageMessage = document.createElement("span");
	const storageRetry = document.createElement("button");
	storageRetry.type = "button";
	storageRetry.className = "shiplet-review-secondary";
	storageRetry.textContent = "Retry storage";
	storageRetry.setAttribute("aria-label", "Retry storage");
	storageNotice.append(storageMessage, storageRetry);
	const filterBar = document.createElement("section");
	filterBar.className = "shiplet-review-filter-bar";
	filterBar.setAttribute("aria-label", "Comment scope");
	const filters = document.createElement("details");
	filters.className = "shiplet-review-filters";
	const filtersSummary = document.createElement("summary");
	filtersSummary.textContent = "Filters";
	filtersSummary.setAttribute("aria-label", "Filters");
	const activeScopeSummary = document.createElement("span");
	activeScopeSummary.className = "shiplet-review-scope-summary";
	activeScopeSummary.setAttribute("data-shiplet-review-scope-summary", "v1");
	const resetFilters = document.createElement("button");
	resetFilters.type = "button";
	resetFilters.className = "shiplet-review-secondary";
	resetFilters.textContent = "Reset";
	resetFilters.setAttribute("aria-label", "Reset comment filters");
	const filterFields = document.createElement("div");
	filterFields.className = "shiplet-review-filter-fields";
	const scopeLabel = document.createElement("label");
	scopeLabel.textContent = "Page scope";
	const scopeSelect = document.createElement("select");
	scopeSelect.setAttribute("aria-label", "Page scope");
	for (const entry of [["page", "Current page"], ["prefix", "Path prefix"], ["site", embeddedSiteOrigin ? "All pages on this site" : "All authorized pages"]]) {
		const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; scopeSelect.appendChild(option);
	}
	scopeLabel.appendChild(scopeSelect);
	const prefixLabel = document.createElement("label");
	prefixLabel.textContent = "Path prefix";
	const prefixInput = document.createElement("input");
	prefixInput.type = "url";
	prefixInput.setAttribute("aria-label", "Path prefix URL");
	prefixInput.setAttribute("autocomplete", "off");
	const applyPrefix = document.createElement("button");
	applyPrefix.type = "button";
	applyPrefix.className = "shiplet-review-secondary";
	applyPrefix.textContent = "Apply prefix";
	const prefixHelp = document.createElement("span");
	prefixHelp.className = "shiplet-review-filter-help";
	prefixHelp.textContent = "Matches this exact path and its / descendants on the authorized origin.";
	prefixLabel.append(prefixInput, applyPrefix, prefixHelp);
	const stateLabel = document.createElement("label");
	stateLabel.textContent = "State";
	const stateSelect = document.createElement("select");
	stateSelect.setAttribute("aria-label", "State");
	for (const entry of [["open", "Open"], ["closed", "Closed"], ["all", "Open and closed"]]) {
		const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; stateSelect.appendChild(option);
	}
	stateLabel.appendChild(stateSelect);
	const actorLabel = document.createElement("label");
	actorLabel.textContent = "People";
	const actorSelect = document.createElement("select");
	actorSelect.setAttribute("aria-label", "People");
	for (const entry of [["everyone", "Everyone"], ["mine", "Mine"], ["mentions", "Mentions of me"]]) {
		const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; actorSelect.appendChild(option);
	}
	actorLabel.appendChild(actorSelect);
	const revisionLabel = document.createElement("label");
	revisionLabel.textContent = "Revision";
	const revisionSelect = document.createElement("select");
	revisionSelect.setAttribute("aria-label", "Revision");
	for (const entry of [["all", "All revisions"], ["current", "Current revision"]]) {
		const option = document.createElement("option"); option.value = entry[0]; option.textContent = entry[1]; revisionSelect.appendChild(option);
	}
	revisionLabel.appendChild(revisionSelect);
	const filterError = document.createElement("p");
	filterError.className = "shiplet-review-filter-error";
	filterError.setAttribute("role", "alert");
	filterError.hidden = true;
	filterFields.append(scopeLabel, prefixLabel, stateLabel, actorLabel, revisionLabel, filterError);
	filters.append(filtersSummary, filterFields);
	filterBar.append(filters, activeScopeSummary, resetFilters);
	const list = document.createElement("ol");
	list.className = "shiplet-review-list";
	list.setAttribute("aria-label", "Review comments");
	list.setAttribute("aria-busy", "true");
	const pinLimit = document.createElement("p");
	pinLimit.className = "shiplet-review-pin-limit";
	pinLimit.setAttribute("data-shiplet-review-pin-limit", "v1");
	pinLimit.hidden = true;
	const pagination = document.createElement("section");
	pagination.className = "shiplet-review-pagination";
	pagination.setAttribute("aria-label", "Comment pages");
	const loadedCount = document.createElement("p");
	loadedCount.setAttribute("data-shiplet-review-loaded-count", "v1");
	loadedCount.setAttribute("role", "status");
	const loadMore = document.createElement("button");
	loadMore.type = "button";
	loadMore.className = "shiplet-review-secondary";
	loadMore.textContent = "Load more";
	loadMore.setAttribute("aria-label", "Load more comments");
	const retryPage = document.createElement("button");
	retryPage.type = "button";
	retryPage.className = "shiplet-review-secondary";
	retryPage.textContent = "Retry";
	retryPage.setAttribute("aria-label", "Retry loading comments");
	retryPage.hidden = true;
	const pageError = document.createElement("p");
	pageError.className = "shiplet-review-page-error";
	pageError.setAttribute("role", "alert");
	pageError.hidden = true;
	pagination.append(loadedCount, loadMore, retryPage, pageError);
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
	annotationExactContext.textContent = embeddedSiteOrigin ? reviewPath : "Revision " + revisionId + " · " + reviewPath;
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
	composerContext.textContent = embeddedSiteOrigin ? reviewPath : "Revision " + revisionId + " · " + reviewPath;
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
	const composerMessage = document.createElement("p");
	composerMessage.className = "shiplet-review-status shiplet-review-composer-message";
	composerMessage.setAttribute("role", "status");
	composerMessage.hidden = true;
	const retryOperationButton = document.createElement("button");
	retryOperationButton.type = "button";
	retryOperationButton.className = "shiplet-review-secondary shiplet-review-operation-retry";
	retryOperationButton.textContent = "Start a new attempt";
	retryOperationButton.setAttribute("aria-label", "Start a new attempt");
	retryOperationButton.hidden = true;
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
	const mentionListbox = document.createElement("div");
	mentionListbox.className = "shiplet-review-mention-listbox";
	mentionListbox.setAttribute("role", "listbox");
	mentionListbox.setAttribute("aria-label", "Mention suggestions");
	mentionListbox.hidden = true;
	const richTools = document.createElement("section");
	richTools.className = "shiplet-review-rich-tools";
	richTools.setAttribute("data-shiplet-review-attachments", "v1");
	const attachmentDrafts = typeof Element === "function" ? createReviewAttachmentDrafts({
		container: richTools,
		idFactory: () => "attachment_" + crypto.randomUUID().replace(/-/g, ""),
		onError: errors => setComposerMessage(errors.join(" "), "error"),
	}) : { current: () => [], serialize: async () => [], clear: () => false, hide: () => false, show: () => false };
	const fidelityDisclosure = document.createElement("p");
	fidelityDisclosure.className = "shiplet-review-fidelity";
	fidelityDisclosure.textContent = "No image attached.";
	const copyRequest = document.createElement("details");
	copyRequest.className = "shiplet-review-copy-request";
	copyRequest.hidden = true;
	const copyRequestSummary = document.createElement("summary");
	copyRequestSummary.textContent = "Copy request";
	const copyRequestHelp = document.createElement("p");
	copyRequestHelp.textContent = "Propose bounded text, template, or admitted-image changes for review. Shiplet never edits the artifact from this form.";
	const copyRequestChange = document.createElement("textarea");
	copyRequestChange.maxLength = 4000;
	copyRequestChange.placeholder = "Describe a proposed text, template, or image change";
	copyRequestChange.setAttribute("aria-label", "Copy request change");
	copyRequest.append(copyRequestSummary, copyRequestHelp, copyRequestChange);
	const annotationEditorContainer = document.createElement("section");
	annotationEditorContainer.className = "shiplet-review-structured-editor";
	const structuredEditor = typeof Element === "function" ? createReviewAnnotationEditor({
		container: annotationEditorContainer,
		initialPreferences: { tool: "pen", color: "#D92D5B", strokeWidth: 5 },
		onApply: result => {
			if (!artifactCapture || !result) return;
			artifactCapture = { ...artifactCapture, screenshotDataUrl: result.screenshotDataUrl, screenshotAnnotations: result.screenshotAnnotations };
			fidelityDisclosure.textContent = fidelityText(artifactCapture.fidelity, artifactCapture.screenshotFailureNote);
			void scheduleDraftSave(true);
		},
		onCancel: () => comment.focus(),
		onError: message => setComposerMessage(message, "error"),
	}) : { open: async () => false, close: () => false, current: null };
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
	drawOnScreenshot.textContent = "Draw on screenshot";
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
	const quickDraw = document.createElement("button");
	quickDraw.type = "button";
	quickDraw.className = "shiplet-review-quick-draw";
	quickDraw.textContent = "Draw";
	quickDraw.setAttribute("aria-label", "Draw on screenshot");
	quickDraw.setAttribute("title", "Draw on screenshot");
	quickDraw.hidden = true;
	quickDraw.addEventListener("click", event => { if (event && event.isTrusted === true) openAnnotationEditor(); });
	composerActions.insertBefore(quickDraw, submit);
	captureTools.append(selectTarget, clearTarget, drawOnScreenshot);
	form.append(annotationCardHeader, selectedTarget, label, comment, mentionListbox, composerMessage, retryOperationButton, composerActions, fidelityDisclosure, richTools, copyRequest, annotationEditorContainer, annotationProperties, mentionDetails, captureTools, composerContext);
	form.hidden = true;
	controls.replaceChildren(header, creationMenu, filterBar, status, pinLimit, list, pagination);
	if (embeddedSiteOrigin) watchButton.hidden = true;
	panel.hidden = true;
	document.body.appendChild(launcherDock);
	document.body.appendChild(restoreVisibility);
	document.body.appendChild(form);
	document.body.appendChild(staleIndicator);
	document.body.appendChild(storageNotice);
	const annotationModeBar = document.createElement("section");
	annotationModeBar.className = "shiplet-annotation-modebar";
	annotationModeBar.setAttribute("data-shiplet-annotation-modebar", "v1");
	annotationModeBar.setAttribute("aria-live", "polite");
	annotationModeBar.hidden = true;
	const annotationModeLabel = document.createElement("span");
	annotationModeLabel.className = "shiplet-annotation-mode-label";
	annotationModeLabel.textContent = "Annotating · " + reviewPath;
	annotationModeBar.appendChild(annotationModeLabel);
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
	const pageCommentsMenu = document.createElement("div");
	pageCommentsMenu.className = "shiplet-review-page-comments-menu";
	pageCommentsMenu.setAttribute("role", "menu");
	pageCommentsMenu.hidden = true;
	pageCommentsMenu.addEventListener("keydown", (event) => {
		if (!event || event.isTrusted !== true) return;
		const choices = Array.from(pageCommentsMenu.querySelectorAll("button"));
		const active = choices.indexOf(document.activeElement);
		if (event.key === "Escape") { event.preventDefault(); pageCommentsMenu.hidden = true; pageCommentsButton.setAttribute("aria-expanded", "false"); pageCommentsButton.focus(); }
		else if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); choices[(active + 1 + choices.length) % choices.length]?.focus(); }
		else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); choices[(active - 1 + choices.length) % choices.length]?.focus(); }
		else if (event.key === "Home") { event.preventDefault(); choices[0]?.focus(); }
		else if (event.key === "End") { event.preventDefault(); choices[choices.length - 1]?.focus(); }
	});
	if (embeddedSiteOrigin) {
		pageCommentsMenu.className += " shiplet-review-page-comments-menu-embedded";
		actions.append(pageCommentsMenu);
	} else {
		document.body.appendChild(pageCommentsButton);
		document.body.appendChild(pageCommentsMenu);
	}
	const contextualThread = document.createElement("section");
	contextualThread.id = "shiplet-contextual-review-thread";
	contextualThread.className = "shiplet-contextual-thread";
	contextualThread.setAttribute("role", "region");
	contextualThread.setAttribute("data-shiplet-contextual-thread", "v1");
	contextualThread.hidden = true;
	const contextualThreadHeader = document.createElement("header");
	contextualThreadHeader.className = "shiplet-contextual-thread-header";
	const contextualThreadTitle = document.createElement("strong");
	contextualThreadTitle.className = "shiplet-contextual-thread-title";
	const contextualTargetStatus = document.createElement("p");
	contextualTargetStatus.className = "shiplet-contextual-thread-target-status";
	contextualTargetStatus.setAttribute("role", "status");
	contextualTargetStatus.hidden = true;
	const contextualThreadClose = document.createElement("button");
	contextualThreadClose.type = "button";
	contextualThreadClose.className = "shiplet-contextual-thread-close";
	contextualThreadClose.textContent = "Close";
	contextualThreadClose.setAttribute("data-shiplet-contextual-thread-close", "v1");
	const contextualThreadBody = document.createElement("div");
	contextualThreadBody.className = "shiplet-contextual-thread-body";
	contextualThreadHeader.append(contextualThreadTitle, contextualThreadClose);
	contextualThread.append(contextualThreadHeader, contextualTargetStatus, contextualThreadBody);
	document.body.appendChild(contextualThread);
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
	const cursorLayer = document.createElement("section");
	cursorLayer.className = "shiplet-review-cursor-layer";
	cursorLayer.setAttribute("aria-hidden", "true");
	document.body.appendChild(cursorLayer);
	const followBar = document.createElement("div");
	followBar.className = "shiplet-review-follow";
	followBar.setAttribute("role", "status");
	followBar.setAttribute("data-shiplet-follow-bar", "v1");
	followBar.hidden = true;
	const followAvatar = document.createElement("span");
	followAvatar.className = "shiplet-review-follow-avatar";
	followAvatar.setAttribute("aria-hidden", "true");
	const followText = document.createElement("span");
	followText.className = "shiplet-review-follow-text";
	const followStop = document.createElement("button");
	followStop.type = "button";
	followStop.className = "shiplet-review-follow-stop";
	followStop.setAttribute("data-shiplet-follow-stop", "v1");
	followStop.textContent = "Stop following";
	followStop.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true) return;
		stopFollowing();
	});
	followBar.append(followAvatar, followText, followStop);
	document.body.appendChild(followBar);
	let pendingWidgetRequest = null;
	let artifactPort = null;
	let artifactSourceWindow = null;
	let artifactChannelNonce = "";
	let artifactChannelConnected = false;
	let pendingArtifactRequestId = "";
	let pendingPageCaptureRequestId = "";
	let pendingPageCapturePageUrl = "";
	let artifactCaptureReadyRequestId = "";
	let artifactCapturePostedNonce = "";
	let artifactCapture = null;
	let artifactCaptureRequestId = "";
	const defaultReviewPreferences = Object.freeze({ version: 1, dock: "bottom-right", launch: "manual", overlaysVisible: true, bubbleColor: "#B44729", annotation: { tool: "pen", color: "#D92D5B", strokeWidth: 5 }, motion: "system", copyRequestsEnabled: false });
	let reviewPreferences = JSON.parse(JSON.stringify(defaultReviewPreferences));
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
	let annotationPreparing = false;
	let annotationSelecting = false;
	let annotationDrag = null;
	let annotationComposerOffset = null;
	let watching = false;
	let renderedItems = [];
	let activeFeedbackId = "";
	let activeThreadPresentation = "";
	let contextualTrigger = null;
	let threadViews = [];
	const threadStates = new Map();
	let refreshGeneration = 0;
	let firstPageSerial = 0;
	let nextCursor = null;
	let nextPageInFlight = "";
	let nextPageFailed = false;
	let unsupportedFilter = "";
	const filterPreferenceKey = "shiplet.review.filters.v1:" + new URL(location.href).origin + ":" + shipletId;
	const defaultFilters = { scope: "page", prefix: "", state: "open", actor: "everyone", revision: "all" };
	let filterPreferences = { ...defaultFilters };
	let memoryFilterPreferences = null;
	let composerOperation = null;
	let topDraftVersion = 1;
	let topOperationSnapshot = null;
	let composerMessageKind = "";
	let activeComposition = false;
	let reviewContext = null;
	let reviewContextKey = "";
	let contextGeneration = 0;
	let contextReady = !draftContextUrl || reviewSubmissionMode === "sandbox";
	let contextFailure = "";
	let draftDb = null;
	let draftStorageState = "unknown";
	let draftSaveTimer = 0;
	let draftSaveInFlight = null;
	let restoredDraft = null;
	let overlayVisible = true;
	let savedTargetDescriptors = [];
	let savedTargetGeometry = new Map();
	let bridgeLifecycleSequence = 0;
	let bridgeLifecycleTimer = 0;
	let bridgeLeaseTimer = 0;
	let bridgeGeneration = 0;
	let bridgeReady = false;
	let bridgeLastAlive = 0;
	let bridgeReconnectTimer = 0;
	let bridgeRouteGeneration = 0;
	let bridgeGeometrySeen = false;
	let pageCommentsItems = [];
	let overlapStacks = [];
	const operationReceipts = [];
	let pendingRevealId = "";
	let operationPollRequestId = "";
	let mentionUsers = [];
	let presenceSocket = null;
	let presenceReconnectTimer = 0;
	let presenceReconnectAttempt = 0;
	let presenceStopped = false;
	let presenceOpen = false;
	let presenceSelfId = "";
	let presenceViewers = [];
	let followingId = "";
	let followingName = "";
	let cursorSendTimer = 0;
	let cursorLastSentAt = 0;
	let cursorPending = null;
	let viewportSendTimer = 0;
	let viewportLastSentAt = 0;
	let viewportPending = false;
	const remoteCursors = new Map();
	let widgetPort = null;
	let sourceWindow = null;
	let channelNonce = "";
	let channelConnected = false;
	let widgetHandshakeTimer = 0;
	const seenWidgetRequestIds = new Set();
	const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	function canonicalReviewPageKey(value) {
		try {
			const url = new URL(value);
			url.search = "";
			if (url.hash.startsWith("#/") && !url.hash.startsWith("#//")) url.hash = url.hash.split("?")[0];
			else url.hash = "";
			return url.origin + url.pathname + url.hash;
		} catch { return ""; }
	}

	function normalizedPrefix(value) {
		try {
			const current = new URL(reviewPageUrl);
			const url = new URL(String(value || ""), current.origin);
			if (url.origin !== current.origin || url.username || url.password || url.search || url.hash) return "";
			url.pathname = url.pathname || "/";
			return url.origin + url.pathname;
		} catch { return ""; }
	}

	function readFilterPreferences() {
		let raw = "";
		try { if (typeof localStorage === "object" && localStorage) raw = localStorage.getItem(filterPreferenceKey) || ""; } catch {}
		let parsed = memoryFilterPreferences;
		if (raw && raw.length <= 2048) {
			try { parsed = JSON.parse(raw); } catch {}
		}
		if (!isRecord(parsed)) return { ...defaultFilters };
		return {
			scope: ["page", "prefix", "site"].includes(parsed.scope) ? parsed.scope : "page",
			prefix: normalizedPrefix(parsed.prefix) || "",
			state: ["open", "closed", "all"].includes(parsed.state) ? parsed.state : "open",
			actor: ["everyone", "mine", "mentions"].includes(parsed.actor) ? parsed.actor : "everyone",
			revision: parsed.revision === "current" ? "current" : "all",
		};
	}

	function persistFilterPreferences() {
		const safe = {
			scope: filterPreferences.scope,
			prefix: filterPreferences.prefix,
			state: filterPreferences.state,
			actor: filterPreferences.actor,
			revision: filterPreferences.revision,
		};
		memoryFilterPreferences = safe;
		try { if (typeof localStorage === "object" && localStorage) localStorage.setItem(filterPreferenceKey, JSON.stringify(safe)); } catch {}
	}

	function filterScopeLabel() {
		if (filterPreferences.scope === "prefix") {
			try { return "Path " + new URL(filterPreferences.prefix).pathname; } catch { return "Path prefix"; }
		}
		if (filterPreferences.scope === "site") return embeddedSiteOrigin ? "All pages on this site" : "All authorized pages";
		return "Current page";
	}

	function updateFilterUi() {
		scopeSelect.value = filterPreferences.scope;
		stateSelect.value = filterPreferences.state;
		actorSelect.value = filterPreferences.actor;
		revisionSelect.value = filterPreferences.revision;
		prefixInput.value = filterPreferences.prefix || normalizedPrefix(reviewPageUrl);
		prefixLabel.hidden = filterPreferences.scope !== "prefix";
		const stateLabelValue = filterPreferences.state === "all" ? "Open and closed" : filterPreferences.state === "closed" ? "Closed" : "Open";
		const actorLabelValue = filterPreferences.actor === "mine" ? "Mine" : filterPreferences.actor === "mentions" ? "Mentions of me" : "Everyone";
		const revisionLabelValue = filterPreferences.revision === "current" ? "Current revision" : "All revisions";
		activeScopeSummary.textContent = [filterScopeLabel(), stateLabelValue, revisionLabelValue, actorLabelValue].join(" · ");
		resetFilters.hidden = filterPreferences.scope === "page" && filterPreferences.state === "open" && filterPreferences.actor === "everyone" && filterPreferences.revision === "all";
	}

	function showFilterError(message) {
		filterError.textContent = message || "";
		filterError.hidden = !message;
	}

	function buildListUrl(cursor) {
		const url = new URL(apiUrl);
		for (const key of ["includeClosed", "status", "pageUrl", "pagePrefix", "scope", "state", "revisionId", "submittedByMe", "mentionedMe", "cursor", "limit"]) url.searchParams.delete(key);
		url.searchParams.set("limit", "100");
		url.searchParams.set("state", filterPreferences.state);
		if (embeddedSiteOrigin) {
			url.searchParams.set("scope", filterPreferences.scope);
			if (filterPreferences.scope === "page") url.searchParams.set("pageUrl", reviewPageUrl);
			if (filterPreferences.scope === "prefix") url.searchParams.set("pagePrefix", filterPreferences.prefix);
		} else if (filterPreferences.scope === "page") {
			url.searchParams.set("pageUrl", reviewPageUrl);
		} else if (filterPreferences.scope === "prefix") {
			url.searchParams.set("pagePrefix", filterPreferences.prefix);
		}
		if (filterPreferences.revision === "current") url.searchParams.set("revisionId", revisionId);
		if (filterPreferences.actor === "mine") url.searchParams.set("submittedByMe", "true");
		if (filterPreferences.actor === "mentions") url.searchParams.set("mentionedMe", "true");
		if (cursor) url.searchParams.set("cursor", cursor);
		return url.toString();
	}

	function validateListPayload(value) {
		if (!isRecord(value) || !Array.isArray(value.feedback) || !Object.prototype.hasOwnProperty.call(value, "nextCursor") || (value.nextCursor !== null && (!boundedString(value.nextCursor, 4096) || !value.nextCursor))) {
			throw new Error("Review service returned an incomplete page.");
		}
		return { feedback: value.feedback, nextCursor: value.nextCursor };
	}

	function mergeByFeedbackId(primary, retained) {
		const merged = [];
		const seen = new Set();
		for (const entry of [...primary, ...retained]) {
			if (!isRecord(entry) || !isIdentifier(entry.id) || seen.has(entry.id)) continue;
			seen.add(entry.id); merged.push(entry);
		}
		return merged;
	}

	function currentPageItem(item) {
		return isRecord(item) && boundedString(item.page_url, 4096) && canonicalReviewPageKey(item.page_url) === canonicalReviewPageKey(reviewPageUrl);
	}

	function statusMatchesFilter(value) {
		const closed = value === "Done" || value === "Dropped";
		return filterPreferences.state === "all" || (filterPreferences.state === "closed" ? closed : !closed);
	}

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
			if (embeddedSiteOrigin && feedbackId && (kind === "status" || kind === "replies")) {
				url.pathname = "/embed/review/thread";
				url.searchParams.set("feedback_id", feedbackId);
				url.searchParams.set("action", kind);
				return url.toString();
			}
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

	function parsePresenceColor(value) {
		return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "";
	}

	function parsePresencePoint(value) {
		if (!isRecord(value) || !finiteNumber(value.x, -10000000, 10000000) || !finiteNumber(value.y, -10000000, 10000000)) return null;
		return { x: value.x, y: value.y };
	}

	function parsePresenceViewport(value) {
		if (!isRecord(value) || !finiteNumber(value.scrollX, -10000000, 10000000) || !finiteNumber(value.scrollY, -10000000, 10000000)) return null;
		return {
			scrollX: value.scrollX,
			scrollY: value.scrollY,
			width: finiteNumber(value.width, 0, 100000) ? value.width : 0,
			height: finiteNumber(value.height, 0, 100000) ? value.height : 0,
		};
	}

	function parsePresencePathname(value) {
		if (!isRecord(value) || !boundedString(value.pathname, 2048) || !value.pathname.startsWith("/")) return "";
		return value.pathname;
	}

	function parsePresenceViewer(viewer) {
		if (!isRecord(viewer) || !isIdentifier(viewer.id)) return null;
		if (viewer.kind !== "user" && viewer.kind !== "guest" && viewer.kind !== "sandbox") return null;
		return {
			id: viewer.id,
			kind: viewer.kind,
			name: (boundedString(viewer.name, 200) && viewer.name.trim()) || (boundedString(viewer.email, 254) && viewer.email.trim()) || "Reviewer",
			avatarPreset: boundedString(viewer.avatarPreset, 64) ? viewer.avatarPreset : null,
			avatarDataUrl: typeof viewer.avatarDataUrl === "string" && viewer.avatarDataUrl.length <= 65536 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(viewer.avatarDataUrl) ? viewer.avatarDataUrl : null,
			color: parsePresenceColor(viewer.color),
			pathname: parsePresencePathname(viewer.page),
			cursor: parsePresencePoint(viewer.cursor),
			viewport: parsePresenceViewport(viewer.viewport),
		};
	}

	function parsePresenceViewers(message) {
		if (!isRecord(message) || (message.type !== "presence:ready" && message.type !== "presence:update") || !Array.isArray(message.viewers)) return null;
		const viewers = [];
		for (const viewer of message.viewers.slice(0, 32)) {
			const parsed = parsePresenceViewer(viewer);
			if (parsed) viewers.push(parsed);
		}
		return viewers;
	}

	function reviewedPathname() {
		try { return new URL(reviewPageUrl).pathname || "/"; } catch { return "/"; }
	}

	function validReviewPreferences(value) {
		if (!isRecord(value) || !hasExactKeys(value, ["version", "dock", "launch", "overlaysVisible", "bubbleColor", "annotation", "motion", "copyRequestsEnabled"]) || value.version !== 1) return null;
		if (!["top-left", "top-right", "bottom-left", "bottom-right"].includes(value.dock) || !["manual", "open-comments"].includes(value.launch) || typeof value.overlaysVisible !== "boolean" || !/^#[0-9A-Fa-f]{6}$/.test(value.bubbleColor) || !["system", "reduced"].includes(value.motion) || typeof value.copyRequestsEnabled !== "boolean") return null;
		if (!isRecord(value.annotation) || !hasExactKeys(value.annotation, ["tool", "color", "strokeWidth"]) || !["pen", "arrow", "text"].includes(value.annotation.tool) || !/^#[0-9A-Fa-f]{6}$/.test(value.annotation.color) || !Number.isInteger(value.annotation.strokeWidth) || value.annotation.strokeWidth < 1 || value.annotation.strokeWidth > 16) return null;
		return JSON.parse(JSON.stringify(value));
	}

	function preferenceStorageKey() {
		if (!reviewContext || !reviewContext.actor || !isIdentifier(reviewContext.actor.id) || !isIdentifier(reviewContext.projectId)) return "";
		return "shiplet.review.preferences.v1:" + reviewContext.actor.kind + ":" + reviewContext.actor.id + ":" + reviewContext.projectId;
	}

	function applyReviewPreferences() {
		const dock = reviewPreferences.dock;
		page.setAttribute("data-review-dock", dock);
		document.body.setAttribute("data-review-dock", dock);
		launcherDock.setAttribute("data-review-dock", dock);
		panel.setAttribute("data-review-dock", dock);
		form.setAttribute("data-review-dock", dock);
		dockSelect.value = dock;
		launchSelect.value = reviewPreferences.launch;
		motionSelect.value = reviewPreferences.motion;
		copyRequestsToggle.checked = reviewPreferences.copyRequestsEnabled;
		copyRequest.hidden = !reviewPreferences.copyRequestsEnabled;
		page.style.setProperty("--shiplet-review-bubble", reviewPreferences.bubbleColor);
		const osReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
		document.body.setAttribute("data-review-reduced-motion", osReduced || reviewPreferences.motion === "reduced" ? "true" : "false");
		if (overlayVisible !== reviewPreferences.overlaysVisible) setOverlayVisible(reviewPreferences.overlaysVisible);
		if (embeddedSiteOrigin && window !== parent) parent.postMessage({ protocol: "shiplet.embed.presentation.v1", dock, overlayVisible: Boolean(reviewPreferences.overlaysVisible), reviewVisible: true }, embeddedSiteOrigin);
	}

	function hydrateReviewPreferences() {
		const key = preferenceStorageKey();
		if (!key) return;
		try {
			const stored = localStorage.getItem(key);
			if (stored) {
				const parsed = validReviewPreferences(JSON.parse(stored));
				if (parsed) reviewPreferences = parsed;
				else storageDisclosure("Saved review preferences were corrupt and were reset.");
			}
		} catch { storageDisclosure("Preferences are using memory only and will not persist."); }
		applyReviewPreferences();
		if (reviewPreferences.launch === "open-comments") setPanelOpen(true);
	}

	function persistReviewPreferences() {
		const key = preferenceStorageKey();
		if (!key) return;
		try { localStorage.setItem(key, JSON.stringify(reviewPreferences)); }
		catch { storageDisclosure("Preferences are using memory only and will not persist."); }
		applyReviewPreferences();
	}

	function cleanReviewLink(mode) {
		const target = new URL(reviewPageUrl);
		for (const key of Array.from(target.searchParams.keys())) {
			const normalized = key.toLowerCase();
			if (["access_token", "authorization_code", "claim", "claim_url", "code", "credential", "id_token", "magic_link", "nonce", "oauth_code", "oauth_token", "password", "policy", "presence_token", "review_token", "session", "sig", "signature", "signed", "state", "token"].includes(normalized) || normalized.startsWith("__shiplet") || normalized.startsWith("shiplet_internal")) target.searchParams.delete(key);
		}
		target.searchParams.delete("shiplet_review");
		target.searchParams.delete("shiplet_comments");
		target.searchParams.set(mode === "review" ? "shiplet_review" : "shiplet_comments", "hidden");
		return target.toString();
	}

	async function copyCleanReviewLink(mode) {
		const value = cleanReviewLink(mode);
		try {
			if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") throw new Error("clipboard");
			await navigator.clipboard.writeText(value);
			cleanLinkFallback.hidden = true;
			setStatus("Review link copied.", "ready");
		} catch {
			cleanLinkFallback.value = value;
			cleanLinkFallback.hidden = false;
			cleanLinkFallback.focus();
			if (typeof cleanLinkFallback.select === "function") cleanLinkFallback.select();
			setStatus("Clipboard access was denied. Copy the selected review link or retry.", "error");
		}
	}

	function applyTransientVisibility() {
		let hidden = "";
		try { const current = new URL(location.href); hidden = current.searchParams.get("shiplet_review") === "hidden" ? "review" : current.searchParams.get("shiplet_comments") === "hidden" ? "comments" : ""; } catch {}
		launcherDock.hidden = hidden === "review";
		if (hidden) { panel.hidden = true; if (hidden === "comments") setOverlayVisible(false); restoreVisibility.hidden = false; restoreVisibility.textContent = hidden === "review" ? "Show review UI" : "Show comments"; }
		else restoreVisibility.hidden = true;
	}

	function sendPresence(payload) {
		if (!presenceSocket || !presenceOpen) return;
		try { presenceSocket.send(JSON.stringify(payload)); } catch {}
	}

	function presencePage() {
		return { pathname: reviewedPathname(), href: reviewPageUrl, title: String(document.title || "").slice(0, 200) };
	}

	function presenceViewport() {
		if (!artifactViewport) return null;
		return { width: artifactViewport.width, height: artifactViewport.height, scrollX: artifactViewport.scrollX, scrollY: artifactViewport.scrollY };
	}

	function flushCursorPresence() {
		cursorSendTimer = 0;
		if (!cursorPending) return;
		const cursor = cursorPending;
		cursorPending = null;
		cursorLastSentAt = Date.now();
		sendPresence({ type: "cursor:update", page: presencePage(), cursor });
	}

	function queueCursorPresence(pointer) {
		const scrollX = artifactViewport ? artifactViewport.scrollX : pointer.pageX - pointer.viewportX;
		const scrollY = artifactViewport ? artifactViewport.scrollY : pointer.pageY - pointer.viewportY;
		cursorPending = { x: pointer.pageX, y: pointer.pageY, viewportX: pointer.viewportX, viewportY: pointer.viewportY, scrollX, scrollY };
		const elapsed = Date.now() - cursorLastSentAt;
		if (elapsed >= 50) { flushCursorPresence(); return; }
		if (!cursorSendTimer && typeof window.setTimeout === "function") cursorSendTimer = window.setTimeout(flushCursorPresence, 50 - elapsed);
	}

	function sendCursorLeave() {
		cursorPending = null;
		if (cursorSendTimer && typeof window.clearTimeout === "function") window.clearTimeout(cursorSendTimer);
		cursorSendTimer = 0;
		sendPresence({ type: "cursor:leave", page: presencePage() });
	}

	function flushViewportPresence() {
		viewportSendTimer = 0;
		if (!viewportPending) return;
		viewportPending = false;
		const viewport = presenceViewport();
		if (!viewport) return;
		viewportLastSentAt = Date.now();
		sendPresence({ type: "viewport:update", page: presencePage(), viewport });
	}

	function queueViewportPresence() {
		viewportPending = true;
		const elapsed = Date.now() - viewportLastSentAt;
		if (elapsed >= 80) { flushViewportPresence(); return; }
		if (!viewportSendTimer && typeof window.setTimeout === "function") viewportSendTimer = window.setTimeout(flushViewportPresence, 80 - elapsed);
	}

	function handlePresenceMessage(message) {
		if (!isRecord(message) || typeof message.type !== "string") return;
		if (message.type === "presence:ready") {
			const self = parsePresenceViewer(message.viewer);
			if (self) presenceSelfId = self.id;
		}
		const viewers = parsePresenceViewers(message);
		if (viewers) {
			presenceViewers = viewers;
			reconcileRemoteCursors();
			renderPresence(viewers);
			if (followingId) {
				const followed = viewers.find((viewer) => viewer.id === followingId);
				if (!followed) stopFollowing();
				else if (followed.viewport) applyFollowViewport(followed.viewport);
			}
			return;
		}
		const viewer = parsePresenceViewer(message.viewer);
		if (!viewer || viewer.id === presenceSelfId) return;
		const pathname = parsePresencePathname(message.page);
		if (message.type === "cursor:update") {
			const cursor = parsePresencePoint(message.cursor);
			if (!cursor || pathname !== reviewedPathname()) return;
			updateRemoteCursor(viewer, cursor);
			return;
		}
		if (message.type === "cursor:leave") {
			removeRemoteCursor(viewer.id);
			return;
		}
		if (message.type === "viewport:update") {
			const viewport = parsePresenceViewport(message.viewport);
			if (!viewport) return;
			const known = presenceViewers.find((candidate) => candidate.id === viewer.id);
			if (known) known.viewport = viewport;
			if (followingId === viewer.id && pathname === reviewedPathname()) applyFollowViewport(viewport);
		}
	}

	function remoteCursorEntry(viewer) {
		let entry = remoteCursors.get(viewer.id);
		if (entry) {
			entry.viewer = viewer;
			return entry;
		}
		const node = document.createElement("div");
		node.className = "shiplet-review-remote-cursor";
		node.setAttribute("data-shiplet-remote-cursor", viewer.id);
		const arrow = document.createElement("span");
		arrow.className = "shiplet-review-remote-cursor-arrow";
		const label = document.createElement("span");
		label.className = "shiplet-review-remote-cursor-label";
		const avatar = document.createElement("span");
		avatar.className = "shiplet-review-remote-cursor-avatar";
		const name = document.createElement("span");
		name.className = "shiplet-review-remote-cursor-name";
		label.append(avatar, name);
		node.append(arrow, label);
		cursorLayer.appendChild(node);
		entry = { viewer, cursor: null, node, arrow, label, avatar, name, styledFor: "", at: 0 };
		remoteCursors.set(viewer.id, entry);
		return entry;
	}

	function updateRemoteCursor(viewer, cursor) {
		const entry = remoteCursorEntry(viewer);
		entry.cursor = cursor;
		entry.at = Date.now();
		const color = viewer.color || "#20293a";
		entry.arrow.style.color = color;
		entry.label.style.backgroundColor = color;
		entry.name.textContent = viewer.name;
		const avatarKey = String(viewer.avatarPreset || "") + "|" + String(viewer.avatarDataUrl || "") + "|" + viewer.name;
		if (entry.styledFor !== avatarKey) {
			entry.styledFor = avatarKey;
			entry.avatar.style.backgroundImage = "";
			stylePresenceAvatar(entry.avatar, viewer);
		}
		positionRemoteCursor(entry);
	}

	function positionRemoteCursor(entry) {
		if (!entry.cursor) { entry.node.hidden = true; return; }
		const scrollX = artifactViewport ? artifactViewport.scrollX : 0;
		const scrollY = artifactViewport ? artifactViewport.scrollY : 0;
		const x = entry.cursor.x - scrollX;
		const y = entry.cursor.y - scrollY;
		const width = Number(window.innerWidth) || 0;
		const height = Number(window.innerHeight) || 0;
		const margin = 48;
		const offscreen = width > 0 && height > 0 && (x < -margin || y < -margin || x > width + margin || y > height + margin);
		entry.node.hidden = offscreen;
		entry.node.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)";
	}

	function renderRemoteCursors() {
		for (const entry of remoteCursors.values()) positionRemoteCursor(entry);
	}

	function removeRemoteCursor(viewerId) {
		const entry = remoteCursors.get(viewerId);
		if (!entry) return;
		remoteCursors.delete(viewerId);
		try { entry.node.remove(); } catch {}
	}

	function reconcileRemoteCursors() {
		const live = new Set(presenceViewers.map((viewer) => viewer.id));
		for (const id of Array.from(remoteCursors.keys())) {
			if (!live.has(id) || id === presenceSelfId) removeRemoteCursor(id);
		}
	}

	function sendFollowCommand(payload) {
		if (!artifactPort) return;
		try { artifactPort.postMessage(Object.assign({ protocol: "shiplet.artifact.follow.command.v1", channelNonce: artifactChannelNonce, shipletId, revisionId }, payload)); } catch {}
	}

	function applyFollowViewport(viewport) {
		if (!followingId || !viewport) return;
		if (artifactViewport && artifactViewport.scrollX === viewport.scrollX && artifactViewport.scrollY === viewport.scrollY) return;
		sendFollowCommand({ type: "scroll", scrollX: viewport.scrollX, scrollY: viewport.scrollY });
	}

	function startFollowing(viewerId) {
		const viewer = presenceViewers.find((candidate) => candidate.id === viewerId);
		if (!viewer || viewer.id === presenceSelfId) return;
		followingId = viewer.id;
		followingName = viewer.name;
		followText.textContent = "Following " + viewer.name;
		followBar.hidden = false;
		followBar.setAttribute("data-shiplet-following", viewer.id);
		followBar.style.borderColor = viewer.color || "";
		followAvatar.style.borderColor = viewer.color || "";
		followAvatar.style.backgroundImage = "";
		stylePresenceAvatar(followAvatar, viewer);
		renderPresence(presenceViewers);
		if (viewer.viewport) applyFollowViewport(viewer.viewport);
	}

	function stopFollowing() {
		if (!followingId) return;
		followingId = "";
		followingName = "";
		followBar.hidden = true;
		followBar.removeAttribute("data-shiplet-following");
		followText.textContent = "";
		sendFollowCommand({ type: "stop" });
		renderPresence(presenceViewers);
	}

	function parseArtifactPointer(data) {
		if (!isRecord(data) || data.protocol !== "shiplet.artifact.pointer.v1" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId) return null;
		if (data.type === "leave" && hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"])) return { type: "leave" };
		if (data.type !== "move" || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "pointer"]) || !isRecord(data.pointer)) return null;
		const pointer = data.pointer;
		if (!hasExactKeys(pointer, ["pageX", "pageY", "viewportX", "viewportY"]) || !finiteNumber(pointer.pageX, -10000000, 10000000) || !finiteNumber(pointer.pageY, -10000000, 10000000) || !finiteNumber(pointer.viewportX, -100000, 100000) || !finiteNumber(pointer.viewportY, -100000, 100000)) return null;
		return { type: "move", pointer };
	}

	function parseArtifactFollowInterrupt(data) {
		return isRecord(data) && hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId"]) && data.protocol === "shiplet.artifact.follow.v1" && data.type === "interrupt" && data.channelNonce === artifactChannelNonce && data.shipletId === shipletId && data.revisionId === revisionId;
	}

	function avatarPresetFor(id) {
		return avatarPresets.find((preset) => preset.id === id) || avatarPresets[0];
	}

	function stylePresenceAvatar(avatar, viewer) {
		const initials = viewer.name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] || "").join("").toUpperCase();
		avatar.textContent = initials || "?";
		const source = viewer.avatarDataUrl || avatarSpriteUrl;
		if (!source) return;
		// Keep the fallback until the browser has actually loaded the image.
		// CSS background declarations alone cannot report failed requests.
		const image = document.createElement("img");
		image.addEventListener("load", () => {
			avatar.style.backgroundImage = "url('" + source + "')";
			if (viewer.avatarDataUrl) {
				avatar.style.backgroundPosition = "center";
				avatar.style.backgroundSize = "cover";
			} else {
				const preset = avatarPresetFor(viewer.avatarPreset);
				const x = avatarSpriteColumns <= 1 ? 0 : (preset.column / (avatarSpriteColumns - 1)) * 100;
				const y = avatarSpriteRows <= 1 ? 0 : (preset.row / (avatarSpriteRows - 1)) * 100;
				avatar.style.backgroundPosition = x + "% " + y + "%";
				avatar.style.backgroundSize = avatarSpriteColumns * 100 + "% " + avatarSpriteRows * 100 + "%";
			}
			avatar.textContent = "";
		}, { once: true });
		image.src = source;
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
			if (viewer.color) avatar.style.borderColor = viewer.color;
			stylePresenceAvatar(avatar, viewer);
			const isSelf = Boolean(presenceSelfId) && viewer.id === presenceSelfId;
			if (isSelf) {
				const self = document.createElement("span");
				self.className = "shiplet-review-presence-viewer";
				self.setAttribute("data-shiplet-presence-self", "v1");
				self.setAttribute("data-shiplet-presence-name", viewer.name + " (you)");
				self.appendChild(avatar);
				presenceRoot.appendChild(self);
				continue;
			}
			const following = viewer.id === followingId;
			const button = document.createElement("button");
			button.type = "button";
			button.className = "shiplet-review-presence-viewer";
			button.setAttribute("data-shiplet-presence-follow", viewer.id);
			button.setAttribute("aria-pressed", following ? "true" : "false");
			button.setAttribute("aria-label", (following ? "Stop following " : "Follow ") + viewer.name);
			button.setAttribute("data-shiplet-presence-name", viewer.name + (following ? " · Following" : " · Click to follow"));
			if (viewer.color) button.style.color = viewer.color;
			button.addEventListener("click", (event) => {
				if (!event || event.isTrusted !== true) return;
				if (followingId === viewer.id) stopFollowing();
				else startFollowing(viewer.id);
			});
			button.appendChild(avatar);
			presenceRoot.appendChild(button);
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
		const socket = presenceSocket;
		presenceSocket.addEventListener("open", () => {
			if (presenceSocket !== socket) return;
			presenceReconnectAttempt = 0;
			presenceOpen = true;
			const hello = { type: "hello", page: presencePage() };
			const viewport = presenceViewport();
			if (viewport) hello.viewport = viewport;
			sendPresence(hello);
		});
		presenceSocket.addEventListener("message", (event) => {
			if (presenceSocket !== socket) return;
			const raw = typeof event.data === "string" ? event.data : "";
			if (!raw || raw.length > 262144) return;
			try {
				handlePresenceMessage(JSON.parse(raw));
			} catch {}
		});
		presenceSocket.addEventListener("close", () => {
			if (presenceSocket === socket) presenceOpen = false;
			schedulePresenceReconnect();
		});
		presenceSocket.addEventListener("error", () => {});
	}

	function setStatus(message, kind) {
		status.textContent = message;
		status.setAttribute("role", kind === "error" ? "alert" : "status");
		status.setAttribute("data-state", kind || "ready");
		status.hidden = kind === "ready" && /^\d+ comments?\.$/.test(message);
	}

	function updateOverlayUi() {
		const effectiveReviewOverlay = overlayVisible && !annotationSelecting;
		overlayToggle.textContent = overlayVisible ? "Hide comments" : "Show comments";
		overlayToggle.setAttribute("aria-label", overlayVisible ? "Hide comments" : "Show comments");
		overlayToggle.setAttribute("aria-pressed", overlayVisible ? "false" : "true");
		pinLayer.hidden = !effectiveReviewOverlay;
		pageCommentsButton.hidden = !effectiveReviewOverlay || pageCommentsItems.length === 0 || activeThreadPresentation === "contextual";
		if (!effectiveReviewOverlay) {
			pageCommentsButton.hidden = true;
			if (pageCommentsMenu) pageCommentsMenu.hidden = true;
			for (const stack of overlapStacks) if (stack.menu) { stack.menu.hidden = true; stack.trigger?.setAttribute("aria-expanded", "false"); }
		}
		updateReviewPinPositions();
	}

	function setOverlayVisible(next, persist = true) {
		overlayVisible = Boolean(next);
		updateOverlayUi();
		notifyEmbedView();
		if (persist) void scheduleDraftSave(false);
		if (overlayVisible && bridgeReady) {
			registerSavedTargets();
			if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => updateReviewPinPositions());
			else updateReviewPinPositions();
		}
	}

	function renderPageCommentsMenu() {
		if (!pageCommentsMenu) return;
		pageCommentsMenu.replaceChildren();
		for (const item of pageCommentsItems) {
			const view = threadViews.find((entry) => entry.id === item.id);
			if (!view) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			button.textContent = (boundedString(item.ticket_label, 120) ? item.ticket_label : "Comment") + " · " + String(item.comment || "Comment").replace(/\s+/g, " ").slice(0, 96);
			button.addEventListener("click", (event) => {
				if (!event || event.isTrusted !== true) return;
				pageCommentsMenu.hidden = true;
				pageCommentsButton.setAttribute("aria-expanded", "false");
				setActiveThread(view, "list", pageCommentsButton);
				view.row.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
				view.button.focus({ preventScroll: true });
			});
			pageCommentsMenu.appendChild(button);
		}
	}

	function renderPinStacks() {
		overlapStacks = [];
		const candidates = threadViews.filter((entry) => entry.pin && entry.id && !entry.pin.hidden && liveReviewPinPoint(entry.item));
		const visited = new Set();
		for (const entry of candidates) {
			if (visited.has(entry.id)) continue;
			const group = [];
			const queue = [entry];
			visited.add(entry.id);
			while (queue.length) {
				const current = queue.shift();
				group.push(current);
				const currentPoint = liveReviewPinPoint(current.item);
				for (const other of candidates) {
					if (visited.has(other.id)) continue;
					const otherPoint = liveReviewPinPoint(other.item);
					if (!currentPoint || !otherPoint) continue;
					if (Math.abs(currentPoint.x - otherPoint.x) <= 36 && Math.abs(currentPoint.y - otherPoint.y) <= 36) {
						visited.add(other.id);
						queue.push(other);
					}
				}
			}
			if (group.length < 2) continue;
			const stack = { entries: group, trigger: null, menu: null };
			const trigger = document.createElement("button");
			trigger.type = "button";
			trigger.className = "shiplet-review-pin-stack";
			trigger.textContent = String(group.length);
			trigger.setAttribute("aria-label", group.length + " comments at this location");
			trigger.setAttribute("aria-haspopup", "menu");
			trigger.setAttribute("aria-expanded", "false");
			const menu = document.createElement("div");
			menu.className = "shiplet-review-pin-stack-menu";
			menu.setAttribute("role", "menu");
			menu.hidden = true;
			for (const member of group) {
				if (member.pin) member.pin.hidden = true;
				const choice = document.createElement("button");
				choice.type = "button";
				choice.setAttribute("role", "menuitem");
				const ticket = boundedString(member.item.ticket_label, 120) ? member.item.ticket_label : "Comment";
				const status = threadState(member.id, member.item).confirmedStatus;
				choice.textContent = ticket + " · " + status + " · " + (boundedString(member.item.comment, 180) ? member.item.comment : "Comment");
				choice.addEventListener("click", (event) => {
					if (!event || event.isTrusted !== true) return;
					menu.hidden = true;
					trigger.setAttribute("aria-expanded", "false");
					setActiveThread(member, "contextual", trigger);
					requestSavedTargetReveal(member.id);
				});
				menu.appendChild(choice);
			}
			trigger.addEventListener("click", (event) => {
				if (!event || event.isTrusted !== true) return;
				const opening = menu.hidden;
				for (const other of overlapStacks) if (other.menu && other.menu !== menu) { other.menu.hidden = true; other.trigger?.setAttribute("aria-expanded", "false"); }
				menu.hidden = !opening;
				trigger.setAttribute("aria-expanded", opening ? "true" : "false");
				if (opening) menu.querySelector("button")?.focus();
			});
			menu.addEventListener("keydown", (event) => {
				if (!event || event.isTrusted !== true) return;
				const choices = Array.from(menu.querySelectorAll("button"));
				const active = choices.indexOf(document.activeElement);
				if (event.key === "Escape") { event.preventDefault(); menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); }
				else if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); choices[(active + 1 + choices.length) % choices.length]?.focus(); }
				else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); choices[(active - 1 + choices.length) % choices.length]?.focus(); }
				else if (event.key === "Home") { event.preventDefault(); choices[0]?.focus(); }
				else if (event.key === "End") { event.preventDefault(); choices[choices.length - 1]?.focus(); }
			});
			stack.trigger = trigger;
			stack.menu = menu;
			pinLayer.append(trigger, menu);
			overlapStacks.push(stack);
		}
		positionPinStacks();
	}

	function positionPinStacks() {
		const effectiveReviewOverlay = overlayVisible && !annotationSelecting;
		for (const stack of overlapStacks) {
			const points = stack.entries.map((entry) => liveReviewPinPoint(entry.item)).filter((point) => point && point.x >= 0 && point.x <= window.innerWidth && point.y >= -16 && point.y <= window.innerHeight);
			if (!points.length || !effectiveReviewOverlay) { stack.trigger.hidden = true; stack.menu.hidden = true; continue; }
			stack.trigger.hidden = false;
			const point = points.reduce((sum, value) => ({ x: sum.x + value.x, y: sum.y + value.y }), { x: 0, y: 0 });
			point.x /= points.length; point.y /= points.length;
			stack.trigger.style.left = point.x + "px";
			stack.trigger.style.top = point.y + "px";
			stack.menu.style.left = Math.max(8, Math.min(window.innerWidth - 328, point.x - 150)) + "px";
			stack.menu.style.top = Math.max(8, Math.min(window.innerHeight - 180, point.y + 24)) + "px";
		}
	}

	function updateCount(value) {
		const count = Math.max(0, Math.floor(Number(value) || 0));
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
		if (!select) return selected;
		for (const option of Array.from(select.selectedOptions || []).slice(0, 20)) {
			if (isIdentifier(option.value) && mentionUsers.some((user) => user.id === option.value)) selected.push({ userId: option.value });
		}
		return selected;
	}

	function threadState(feedbackId, item) {
		const key = shipletId + "\n" + revisionId + "\n" + reviewPageUrl + "\n" + feedbackId;
		let state = threadStates.get(key);
		if (!state) {
			state = {
				key,
				text: "",
				mentions: [],
				confirmedStatus: boundedString(item && item.status, 40) ? item.status : "New",
				replyOperation: null,
				statusOperation: null,
				message: "",
				messageKind: "",
			};
			threadStates.set(key, state);
		} else if (!state.statusOperation && boundedString(item && item.status, 40)) {
			state.confirmedStatus = item.status;
		}
		return state;
	}

	function syncRenderedThreadDrafts() {
		for (const view of threadViews) {
			if (!view || !view.id || !view.state) continue;
			if (view.replyInput) view.state.text = String(view.replyInput.value || "").slice(0, 5000);
			if (view.replyMentions) view.state.mentions = selectedMentions(view.replyMentions);
		}
	}

	function setComposerMessage(message, kind) {
		composerMessageKind = kind || "";
		composerMessage.textContent = message || "";
		composerMessage.hidden = !message;
		composerMessage.setAttribute("role", kind === "error" ? "alert" : "status");
		composerMessage.setAttribute("data-state", kind || "ready");
		retryOperationButton.hidden = !(topOperationSnapshot && topOperationSnapshot.state === "failed");
	}

	function setComposerBusy(pending) {
		const busy = Boolean(pending) || Boolean(topOperationSnapshot && ["pending", "unknown"].includes(topOperationSnapshot.state));
		comment.disabled = busy;
		mentionSelect.disabled = busy;
		submit.disabled = busy;
		cancelComposer.disabled = false;
	}

	function showStaleIndicator(message, action) {
		staleMessage.textContent = message;
		if (action === "retry-mentions") {
			staleRefresh.textContent = "Retry";
			staleRefresh.setAttribute("aria-label", "Retry Mentions");
		} else {
			staleRefresh.textContent = "Refresh";
			staleRefresh.setAttribute("aria-label", "Refresh comments");
		}
		staleIndicator.hidden = false;
	}

	function clearStaleIndicator() {
		staleIndicator.hidden = true;
		staleMessage.textContent = "";
		staleRefresh.textContent = "Refresh";
		staleRefresh.setAttribute("aria-label", "Refresh comments");
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

	function savedTargetForItem(item) {
		if (!isRecord(item) || !isIdentifier(item.id) || !currentPageItem(item) || !isRecord(item.selected_element) || !boundedString(item.selected_element.selector, 1200) || !item.selected_element.selector || !boundedString(item.selected_element.tagName, 64) || !/^[A-Z][A-Z0-9-]{0,63}$/.test(item.selected_element.tagName)) return null;
		return { feedbackId: item.id, selector: item.selected_element.selector, expectedTag: item.selected_element.tagName };
	}

	function liveReviewPinPoint(item) {
		if (!isRecord(item) || !isIdentifier(item.id) || !currentPageItem(item)) return null;
		const descriptor = savedTargetForItem(item);
		if (descriptor) {
			if (!bridgeGeometrySeen) return reviewCoordinates(item);
			const geometry = savedTargetGeometry.get(item.id);
			if (!geometry || geometry.eligible !== true || geometry.offscreen === true || !isRecord(geometry.coordinates)) return null;
			const x = Number(geometry.coordinates.viewportX);
			const y = Number(geometry.coordinates.viewportY);
			return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
		}
		return reviewCoordinates(item);
	}

	function parseSavedTargetGeometry(data) {
		if (!isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "targets"]) || data.protocol !== "shiplet.artifact.saved-targets.geometry.v1" || data.type !== "update" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || !Array.isArray(data.targets) || data.targets.length > 250) return null;
		const next = new Map();
		for (const target of data.targets) {
			if (!isRecord(target) || !hasExactKeys(target, ["feedbackId", "eligible", "offscreen", "coordinates", "targetRect"]) || !isIdentifier(target.feedbackId) || typeof target.eligible !== "boolean" || typeof target.offscreen !== "boolean" || (target.coordinates !== null && !isRecord(target.coordinates)) || (target.targetRect !== null && !isRecord(target.targetRect))) return null;
			if (target.coordinates && (!hasExactKeys(target.coordinates, ["pageX", "pageY", "viewportX", "viewportY"]) || !finiteNumber(target.coordinates.pageX, -10000000, 10000000) || !finiteNumber(target.coordinates.pageY, -10000000, 10000000) || !finiteNumber(target.coordinates.viewportX, -100000, 100000) || !finiteNumber(target.coordinates.viewportY, -100000, 100000))) return null;
			if (target.targetRect && (!hasExactKeys(target.targetRect, ["left", "top", "width", "height"]) || !finiteNumber(target.targetRect.left, -100000, 100000) || !finiteNumber(target.targetRect.top, -100000, 100000) || !finiteNumber(target.targetRect.width, 0, 100000) || !finiteNumber(target.targetRect.height, 0, 100000))) return null;
			next.set(target.feedbackId, target);
		}
		return next;
	}

	function registerSavedTargets() {
		if (!artifactPort || !artifactChannelConnected || !bridgeReady || !overlayVisible || !contextReady) return;
		const candidates = renderedItems.filter((item) => savedTargetForItem(item));
		const selected = activeFeedbackId ? candidates.find((item) => item.id === activeFeedbackId) : null;
		const ordered = selected ? [selected, ...candidates.filter((item) => item !== selected)] : candidates;
		savedTargetDescriptors = ordered.slice(0, 250).map((item) => savedTargetForItem(item)).filter(Boolean);
		try { artifactPort.postMessage({ protocol: "shiplet.artifact.saved-targets.command.v1", type: "replace", channelNonce: artifactChannelNonce, shipletId, revisionId, targets: savedTargetDescriptors }); } catch {}
	}

	function requestSavedTargetReveal(id) {
		if (!id || !bridgeReady || !artifactPort || !savedTargetDescriptors.some((descriptor) => descriptor.feedbackId === id)) {
			pendingRevealId = "";
			if (id && savedTargetForItem(threadViews.find((entry) => entry.id === id)?.item)) setStatus("Target unavailable", "ready");
			return;
		}
		pendingRevealId = id;
		setStatus("Revealing target…", "loading");
		try { artifactPort.postMessage({ protocol: "shiplet.artifact.saved-target.reveal.v1", type: "reveal", channelNonce: artifactChannelNonce, shipletId, revisionId, feedbackId: id }); } catch { setStatus("Target unavailable", "ready"); }
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
		notifyEmbedView();
	}

	function notifyEmbedView() {
		if (!embeddedSiteOrigin || window === parent) return;
		const view = annotationEditing ? "drawing" : annotationSelecting ? "selecting" : annotationActive ? (annotationExpanded ? "expanded" : "composer") : activeThreadPresentation === "contextual" && activeFeedbackId ? "thread" : !panel.hidden ? "comments" : "toolbar";
		page.setAttribute("data-shiplet-embed-view", view);
		const coordinates = artifactCapture && artifactCapture.coordinates;
		parent.postMessage({ protocol: "shiplet.embed.ui.v1", view, anchor: coordinates ? { x: coordinates.pageX, y: coordinates.pageY } : null, activeFeedbackId: activeThreadPresentation === "contextual" ? activeFeedbackId : "", overlayVisible }, embeddedSiteOrigin);
	}

	function setAnnotationMode(active, selecting) {
		annotationPreparing = false;
		annotationActive = Boolean(active);
		annotationSelecting = Boolean(active && selecting);
		annotationModeBar.hidden = !annotationActive;
		launcherDock.setAttribute("data-annotation-active", annotationActive ? "true" : "false");
		launcher.setAttribute("aria-expanded", annotationActive ? "true" : "false");
		launcher.setAttribute("data-panel-open", annotationActive ? "true" : "false");
		artifact.setAttribute("data-shiplet-selecting", annotationSelecting ? "true" : "false");
		document.body.setAttribute("data-shiplet-annotating", annotationActive ? "true" : "false");
		updateOverlayUi();
		notifyEmbedView();
	}

	function cancelTargetSelection() {
		if (artifactPort && pendingPageCaptureRequestId) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.page-capture.command.v1", type: "cancel", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingPageCaptureRequestId, pageUrl: pendingPageCapturePageUrl }); } catch {}
		}
		pendingPageCaptureRequestId = "";
		pendingPageCapturePageUrl = "";
		if (artifactPort && pendingArtifactRequestId && artifactCapturePostedNonce === artifactChannelNonce) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "cancel", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingArtifactRequestId }); } catch {}
		}
		pendingArtifactRequestId = "";
		artifactCaptureReadyRequestId = "";
		artifactCapturePostedNonce = "";
		annotationPreparing = false;
		annotationSelecting = false;
		artifact.setAttribute("data-shiplet-selecting", "false");
		updateOverlayUi();
		notifyEmbedView();
		selectTarget.textContent = artifactCapture ? "Change element" : "Select element";
	}

	function hasAnnotationDraft() {
		return Boolean(comment.value.trim() || selectedMentions(mentionSelect).length || artifactCapture || annotationStrokes.length || composerMessageKind === "pending");
	}

	function closeAnnotationFlow() {
		const wasPreparing = annotationPreparing;
		cancelTargetSelection();
		closeAnnotationEditor();
		if (annotationLayer) annotationLayer.hidden = true;
		form.hidden = true;
		annotationTargetPin.hidden = true;
		annotationTargetFocus.hidden = true;
		setAnnotationExpanded(false);
		setAnnotationMode(false, false);
		composeButton.setAttribute("aria-expanded", "false");
		(wasPreparing ? commentsLauncher : launcher).focus();
	}

	function discardAnnotationDraft() {
		composerOperation = null;
		setComposerBusy(false);
		comment.value = "";
		for (const option of Array.from(mentionSelect.options || [])) option.selected = false;
		setComposerMessage("", "");
		clearArtifactCapture();
	}

	function cancelAnnotationFlow() {
		const wasPreparing = annotationPreparing;
		closeAnnotationFlow();
		discardAnnotationDraft();
		if (wasPreparing) {
			commentsLauncher.focus();
			if (typeof window.setTimeout === "function") window.setTimeout(() => commentsLauncher.focus(), 0);
		}
	}

	function showComposer(open) {
		if (!open) {
			closeAnnotationFlow();
			return;
		}
		setAnnotationMode(true, false);
		setAnnotationExpanded(false);
		form.hidden = false;
		if (annotationLayer && annotationStrokes.length > 0) {
			annotationLayer.hidden = false;
			renderAnnotationCanvas();
		}
		anchorAnnotationComposer(artifactCapture, true);
		composeButton.setAttribute("aria-expanded", "true");
		comment.focus();
	}

	function canonicalPinLabel(item, ticket) {
		const ticketNumber = Number(item && item.ticket_number);
		if (Number.isInteger(ticketNumber) && ticketNumber > 0) return String(ticketNumber);
		const match = boundedString(ticket, 120) ? ticket.match(/(?:^|[^0-9])(\d{1,9})$/) : null;
		return match ? match[1] : "•";
	}

	function positionContextualThread(entry) {
		if (!entry || embeddedSiteOrigin) {
			contextualThread.style.left = "";
			contextualThread.style.top = "";
			return;
		}
		const point = liveReviewPinPoint(entry.item);
		if (!point) {
			contextualThread.style.left = "8px";
			contextualThread.style.top = "8px";
			return;
		}
		const margin = 8;
		const viewportWidth = Math.max(1, Number(window.innerWidth) || 1);
		const viewportHeight = Math.max(1, Number(window.innerHeight) || 1);
		const width = Math.min(440, Math.max(280, viewportWidth - margin * 2));
		const height = Math.min(560, Math.max(240, viewportHeight - margin * 2));
		const preferredLeft = point.x + width + 32 <= viewportWidth ? point.x + 24 : point.x - width - 24;
		const left = Math.max(margin, Math.min(viewportWidth - width - margin, preferredLeft));
		const top = Math.max(margin, Math.min(viewportHeight - height - margin, point.y - 40));
		contextualThread.style.left = Math.round(left) + "px";
		contextualThread.style.top = Math.round(top) + "px";
	}

	function setReviewSurfaceOpenState() {
		launcherDock.setAttribute("data-review-surface-open", !panel.hidden || !contextualThread.hidden ? "true" : "false");
	}

	function setActiveThread(next, presentation, trigger) {
		const nextPresentation = next ? (presentation === "contextual" ? "contextual" : "list") : "";
		activeFeedbackId = next ? next.id : "";
		activeThreadPresentation = nextPresentation;
		contextualTrigger = nextPresentation === "contextual" ? (trigger || next.pin || contextualTrigger) : null;
		contextualThread.hidden = nextPresentation !== "contextual";
		for (const entry of threadViews) {
			if (entry.details.parentElement === contextualThreadBody) entry.row.appendChild(entry.details);
		}
		contextualThreadBody.replaceChildren();
		for (const entry of threadViews) {
			const active = entry === next;
			const contextual = active && nextPresentation === "contextual";
			entry.details.hidden = !active;
			entry.button.setAttribute("aria-expanded", active && !contextual ? "true" : "false");
			entry.preview.hidden = active && !contextual;
			entry.row.setAttribute("data-active", active ? "true" : "false");
			if (entry.pin) {
				entry.pin.setAttribute("data-active", active ? "true" : "false");
				entry.pin.setAttribute("aria-expanded", contextual ? "true" : "false");
				if (active) entry.pin.setAttribute("aria-current", "true");
				else entry.pin.removeAttribute("aria-current");
			}
		}
		if (next && nextPresentation === "contextual") {
			const ticket = boundedString(next.item.ticket_label, 120) ? next.item.ticket_label : "Comment";
			contextualThreadTitle.textContent = ticket;
			contextualThread.setAttribute("aria-label", "Thread " + ticket);
			contextualThread.setAttribute("data-feedback-id", next.id);
			contextualThreadClose.setAttribute("aria-label", "Close thread " + ticket);
			const targetUnavailable = Boolean(savedTargetForItem(next.item) && !liveReviewPinPoint(next.item));
			contextualTargetStatus.textContent = targetUnavailable ? "Target unavailable" : "";
			contextualTargetStatus.hidden = !targetUnavailable;
			contextualThreadBody.appendChild(next.details);
			next.details.hidden = false;
			positionContextualThread(next);
		} else {
			contextualTargetStatus.hidden = true;
			contextualTargetStatus.textContent = "";
			contextualThread.removeAttribute("aria-label");
			contextualThread.removeAttribute("data-feedback-id");
		}
		setReviewSurfaceOpenState();
		const effectiveReviewOverlay = overlayVisible && !annotationSelecting;
		pageCommentsButton.hidden = !effectiveReviewOverlay || pageCommentsItems.length === 0 || activeThreadPresentation === "contextual";
		if (activeThreadPresentation === "contextual") { pageCommentsMenu.hidden = true; pageCommentsButton.setAttribute("aria-expanded", "false"); }
		notifyEmbedView();
	}

	function contextualFocusTarget(feedbackId) {
		const isConnectedVisible = (element) => {
			if (!element || element.isConnected === false || element.hidden) return false;
			const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(element) : null;
			return !style || (style.display !== "none" && style.visibility !== "hidden");
		};
		const stack = overlapStacks.find((entry) => entry.entries.some((member) => member && member.id === feedbackId));
		if (stack && isConnectedVisible(stack.trigger)) return stack.trigger;
		const member = threadViews.find((entry) => entry.id === feedbackId);
		if (member && isConnectedVisible(member.pin)) return member.pin;
		if (isConnectedVisible(contextualTrigger)) return contextualTrigger;
		return null;
	}

	function closeContextualThread(restoreFocus) {
		if (activeThreadPresentation !== "contextual") return;
		const feedbackId = activeFeedbackId;
		const trigger = restoreFocus ? contextualFocusTarget(feedbackId) : null;
		setActiveThread(null);
		const focusTarget = trigger || (restoreFocus && (() => {
			if (!commentsLauncher || commentsLauncher.isConnected === false || commentsLauncher.hidden) return null;
			const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(commentsLauncher) : null;
			return !style || (style.display !== "none" && style.visibility !== "hidden") ? commentsLauncher : null;
		})());
		if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus({ preventScroll: true });
	}

	function scrollToThread(index) {
		if (!threadViews.length) return;
		const activeIndex = threadViews.findIndex((entry) => entry.id === activeFeedbackId);
		const startIndex = activeIndex >= 0 ? activeIndex : index > 0 ? -1 : 0;
		const nextIndex = (startIndex + index + threadViews.length) % threadViews.length;
		const next = threadViews[nextIndex];
		if (!next) return;
		setActiveThread(next);
		requestSavedTargetReveal(next.id);
		if (next.row && typeof next.row.scrollIntoView === "function") {
			next.row.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
		}
		if (next.button) next.button.focus({ preventScroll: true });
	}

	function updateReviewPinPositions() {
		const effectiveReviewOverlay = overlayVisible && !annotationSelecting;
		for (const entry of threadViews) {
			if (!entry.pin || !entry.item) continue;
			const point = effectiveReviewOverlay ? liveReviewPinPoint(entry.item) : null;
			if (!point) {
				entry.pin.hidden = true;
				continue;
			}
			entry.pin.hidden = false;
			entry.pin.style.left = point.x + "px";
			entry.pin.style.top = point.y + "px";
		}
		positionPinStacks();
		pageCommentsButton.hidden = !effectiveReviewOverlay || pageCommentsItems.length === 0 || activeThreadPresentation === "contextual";
		if (activeThreadPresentation === "contextual") positionContextualThread(threadViews.find((entry) => entry.id === activeFeedbackId));
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

	let mentionSearchGeneration = 0;
	let mentionSearchResults = [];
	let mentionSearchIndex = 0;
	let mentionComposing = false;
	function activeMentionQuery() {
		const caret = Number(comment.selectionStart);
		if (!Number.isInteger(caret) || caret < 0) return null;
		const prefix = String(comment.value || "").slice(0, caret);
		const match = prefix.match(/(?:^|\s)@([\p{L}\p{N}._-]{1,80})$/u);
		return match ? { query: match[1], start: caret - match[1].length - 1, end: caret } : null;
	}
	function renderMentionSearch(message) {
		mentionListbox.replaceChildren();
		if (message) {
			const state = document.createElement("p"); state.textContent = message; state.setAttribute("role", "status"); mentionListbox.appendChild(state);
		}
		for (let index = 0; index < mentionSearchResults.length; index += 1) {
			const user = mentionSearchResults[index];
			const option = document.createElement("button"); option.type = "button"; option.setAttribute("role", "option"); option.setAttribute("aria-selected", index === mentionSearchIndex ? "true" : "false"); option.textContent = user.label; option.dataset.userId = user.id; mentionListbox.appendChild(option);
		}
		mentionListbox.hidden = !message && mentionSearchResults.length === 0;
	}
	async function searchMentions() {
		if (mentionComposing) return;
		const active = activeMentionQuery();
		if (!active) { mentionSearchResults = []; renderMentionSearch(""); return; }
		const generation = ++mentionSearchGeneration;
		renderMentionSearch("Loading mention suggestions…");
		const base = childApiUrl("mentions");
		if (!base) { renderMentionSearch("Mentions unavailable."); return; }
		try {
			const url = new URL(base); url.searchParams.set("q", active.query); url.searchParams.set("limit", "20");
			const users = [];
			let cursor = "";
			do {
				if (cursor) url.searchParams.set("cursor", cursor); else url.searchParams.delete("cursor");
				const response = await requestAt(url.toString(), "GET");
				if (generation !== mentionSearchGeneration) return;
				for (const user of isRecord(response) && Array.isArray(response.users) ? response.users : []) if (isRecord(user) && hasExactKeys(user, ["id", "label"]) && isIdentifier(user.id) && boundedString(user.label, 200) && user.label) users.push({ id: user.id, label: user.label });
				cursor = isRecord(response) && boundedString(response.nextCursor, 1024) ? response.nextCursor : "";
			} while (cursor && users.length < 200);
			if (generation !== mentionSearchGeneration) return;
			mentionSearchResults = users; mentionSearchIndex = 0; renderMentionSearch(users.length ? "" : "No matching reviewers.");
		} catch (error) {
			if (generation !== mentionSearchGeneration) return;
			mentionSearchResults = []; renderMentionSearch(error && error.status === 409 ? "Mentions unavailable." : "Mention suggestions could not be loaded.");
		}
	}
	function chooseMention(user) {
		const active = activeMentionQuery();
		if (!active || !user || !isIdentifier(user.id)) return;
		comment.setRangeText("@" + user.label + " ", active.start, active.end, "end");
		let option = Array.from(mentionSelect.options || []).find(candidate => candidate.value === user.id);
		if (!option) { option = document.createElement("option"); option.value = user.id; option.textContent = user.label; mentionSelect.appendChild(option); mentionUsers.push({ id: user.id, name: user.label, email: "" }); }
		option.selected = true;
		mentionSearchResults = []; renderMentionSearch(""); comment.focus(); topDraftVersion += 1; void scheduleDraftSave(false);
	}

	function postEmbeddedPins() {
		if (!embeddedSiteOrigin) return;
		const candidates = threadViews.filter((view) => view.id && currentPageItem(view.item) && liveReviewPinPoint(view.item));
		const selected = activeFeedbackId ? candidates.find((view) => view.id === activeFeedbackId) : null;
		const ordered = selected ? [selected, ...candidates.filter((view) => view !== selected)] : candidates;
		const pinnedIds = new Set(ordered.slice(0, 250).map((view) => view.id));
		parent.postMessage({ protocol: "shiplet.embed.ui.v1", overlayVisible, pins: threadViews.map((view, index) => {
			const point = liveReviewPinPoint(view.item);
			const geometry = savedTargetGeometry.get(view.id);
			return { index, feedbackId: view.id, ticket: boundedString(view.item.ticket_label, 120) ? view.item.ticket_label : "Comment", label: canonicalPinLabel(view.item, view.item.ticket_label), selector: view.item.selected_element?.selector || "", pageX: point ? point.x : Number.NaN, pageY: point ? point.y : Number.NaN, geometry: geometry && point ? { eligible: geometry.eligible, offscreen: geometry.offscreen, viewportX: point.x, viewportY: point.y } : null };
		}).filter((pin) => pinnedIds.has(pin.feedbackId) && (pin.geometry || (Number.isFinite(pin.pageX) && Number.isFinite(pin.pageY)))).slice(0, 250) }, embeddedSiteOrigin);
	}

	if (embeddedSiteOrigin) window.addEventListener("message", event => {
		if (event.source !== parent || event.origin !== embeddedSiteOrigin || !event.data) return;
		if (event.data.protocol === "shiplet.embed.overlay.v1") {
			if (!hasExactKeys(event.data, ["protocol", "type", "visible"]) || event.data.type !== "set" || typeof event.data.visible !== "boolean" || !contextReady) return;
			setOverlayVisible(event.data.visible);
			return;
		}
		if (event.data.protocol === "shiplet.embed.route-transition.v1") {
			if (!hasExactKeys(event.data, ["protocol", "type", "pageUrl", "overlayVisible", "retained"]) || event.data.type !== "request" || !boundedString(event.data.pageUrl, 4096) || typeof event.data.overlayVisible !== "boolean" || typeof event.data.retained !== "boolean") return;
			const candidate = trustedRouteCandidate(event.data.pageUrl);
			if (!candidate || candidate === canonicalOperationPageUrl(reviewPageUrl)) return;
			void handleArtifactRouteChange(candidate).finally(() => {
				const retained = hasAnnotationDraft() || threadViews.some(view => Boolean(view.draft?.text || view.draft?.mentions?.length)) || Boolean(topOperationSnapshot && ["pending", "unknown"].includes(topOperationSnapshot.state));
				try { parent.postMessage({ protocol: "shiplet.embed.route-transition.v1", type: "retained", pageUrl: candidate, retained, safeToReplace: contextReady }, embeddedSiteOrigin); } catch {}
			});
			return;
		}
		if (event.data.protocol === "shiplet.embed.dismiss.v1") {
			if (activeThreadPresentation === "contextual") closeContextualThread(false);
			else { closeAnnotationFlow(); setPanelOpen(false); }
			return;
		}
		if (event.data.protocol !== "shiplet.embed.focus.v1") return;
		const feedbackId = isIdentifier(event.data.feedbackId) ? event.data.feedbackId : "";
		const index = event.data.index;
		const next = feedbackId ? threadViews.find((entry) => entry.id === feedbackId) : Number.isInteger(index) && index >= 0 && index < threadViews.length ? threadViews[index] : null;
		if (!next) return;
		if (activeThreadPresentation === "contextual" && activeFeedbackId === next.id) closeContextualThread(false);
		else { setActiveThread(next, "contextual"); requestSavedTargetReveal(next.id); }
	});

	function render(items) {
		const requestedActiveId = activeFeedbackId;
		const requestedPresentation = activeThreadPresentation;
		const editingThread = threadViews.find(view => view.replyInput && view.replyInput === document.activeElement);
		const editingSelection = editingThread ? [editingThread.replyInput.selectionStart, editingThread.replyInput.selectionEnd] : null;
		syncRenderedThreadDrafts();
		renderedItems = Array.isArray(items) ? items.slice() : [];
		list.replaceChildren();
		pinLayer.replaceChildren();
		contextualThreadBody.replaceChildren();
		threadViews = [];
		const eligiblePins = renderedItems.filter(item => isRecord(item) && isIdentifier(item.id) && currentPageItem(item) && liveReviewPinPoint(item));
		pageCommentsItems = renderedItems.filter(item => isRecord(item) && isIdentifier(item.id) && currentPageItem(item) && !savedTargetForItem(item) && !reviewCoordinates(item));
		const pinnedIds = new Set();
		if (requestedActiveId && eligiblePins.some(item => item.id === requestedActiveId)) pinnedIds.add(requestedActiveId);
		for (const item of eligiblePins) {
			if (pinnedIds.size >= 250) break;
			pinnedIds.add(item.id);
		}
		for (const item of renderedItems) {
			if (!isRecord(item)) continue;
			const row = document.createElement("li");
			const feedbackId = isIdentifier(item.id) ? item.id : "";
			const ticket = boundedString(item.ticket_label, 120) ? item.ticket_label : "Comment";
			const state = threadState(feedbackId, item);
			row.setAttribute("aria-label", itemText(item).slice(0, 6000));
			row.setAttribute("data-shiplet-review-thread", feedbackId || ticket);
			row.setAttribute("data-confirmed-status", state.confirmedStatus);
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
			const summaryStatus = document.createElement("span");
			summaryStatus.className = "shiplet-review-thread-summary-status";
			summaryStatus.setAttribute("data-shiplet-review-collapsed-status", "v1");
			summaryStatus.textContent = state.confirmedStatus;
			summaryButton.append(author, createdTime, summaryTicket, summaryStatus, summaryComment);
			const details = document.createElement("div");
			details.className = "shiplet-review-thread-details";
			details.hidden = true;
			const threadView = { id: feedbackId, item, state, row, button: summaryButton, details, preview: summaryComment, pin: null };
			summaryButton.addEventListener("click", (event) => {
				if (!event || event.isTrusted !== true) return;
				const open = details.hidden || activeThreadPresentation === "contextual";
				setActiveThread(open ? threadView : null, "list");
				if (open) requestSavedTargetReveal(threadView.id);
				if (open && currentPageItem(item) && eligiblePins.length > 250 && !pinnedIds.has(feedbackId)) render(renderedItems);
			});
			const meta = document.createElement("div");
			meta.className = "shiplet-review-thread-meta";
			const statusSelect = document.createElement("select");
			statusSelect.setAttribute("aria-label", "Status " + ticket);
			for (const statusValue of ["New", "In Progress", "Blocked", "Staging", "Done", "Dropped"]) {
				const option = document.createElement("option");
				option.value = statusValue;
				option.textContent = statusValue;
				statusSelect.appendChild(option);
			}
			statusSelect.value = state.confirmedStatus;
			statusSelect.disabled = !feedbackId || Boolean(state.statusOperation);
			const quickStatus = state.confirmedStatus === "Done" || state.confirmedStatus === "Dropped" ? "New" : "Done";
			const quickStatusButton = document.createElement("button");
			quickStatusButton.type = "button";
			quickStatusButton.className = "shiplet-review-thread-action";
			quickStatusButton.textContent = quickStatus === "Done" ? "Resolve" : "Reopen";
			quickStatusButton.setAttribute("aria-label", quickStatusButton.textContent + " " + ticket);
			quickStatusButton.setAttribute("data-shiplet-review-quick-status", quickStatus);
			quickStatusButton.disabled = !feedbackId || Boolean(state.statusOperation);
			async function submitStatusChange(nextStatus) {
				if (!feedbackId || state.statusOperation || !boundedString(nextStatus, 40)) return;
				const token = crypto.randomUUID();
				state.statusOperation = { token, value: nextStatus };
				state.message = "Updating " + ticket + " status…";
				state.messageKind = "pending";
				render(renderedItems);
				try {
					const response = await requestAt(childApiUrl("status", feedbackId), "POST", { status: nextStatus });
					if (!state.statusOperation || state.statusOperation.token !== token) return;
					state.statusOperation = null;
					if (response.pendingConfirmation) {
						state.message = "Awaiting confirmation for this status change. Use the status control to reopen confirmation.";
						state.messageKind = "pending";
						render(renderedItems);
						return;
					}
					if (isRecord(response) && isRecord(response.feedback) && response.feedback.id === feedbackId) {
						state.confirmedStatus = boundedString(response.feedback.status, 40) ? response.feedback.status : state.confirmedStatus;
						state.message = ticket + " status updated.";
						state.messageKind = "ready";
						renderedItems = renderedItems.map((entry) => isRecord(entry) && entry.id === feedbackId ? response.feedback : entry);
						if (!statusMatchesFilter(state.confirmedStatus)) renderedItems = renderedItems.filter((entry) => !isRecord(entry) || entry.id !== feedbackId);
						render(renderedItems);
					} else {
						state.message = "";
						state.messageKind = "";
						await refresh();
					}
				} catch {
					if (!state.statusOperation || state.statusOperation.token !== token) return;
					state.statusOperation = null;
					state.message = "Could not update " + ticket + ". Try again.";
					state.messageKind = "error";
					render(renderedItems);
				}
			}
			quickStatusButton.addEventListener("click", async (event) => {
				if (!event || event.isTrusted !== true || quickStatusButton.disabled) return;
				await submitStatusChange(quickStatus);
			});
			const statusMore = document.createElement("details");
			statusMore.className = "shiplet-review-status-more";
			const statusMoreSummary = document.createElement("summary");
			statusMoreSummary.textContent = "Status";
			statusMoreSummary.setAttribute("aria-label", "More status options for " + ticket);
			statusMore.append(statusMoreSummary, statusSelect);
			statusSelect.addEventListener("change", async (event) => {
				if (!event || event.isTrusted !== true || statusSelect.disabled) return;
				const nextStatus = statusSelect.value;
				statusSelect.value = state.confirmedStatus;
				await submitStatusChange(nextStatus);
			});
			const provenance = document.createElement("details");
			provenance.className = "shiplet-review-provenance";
			provenance.setAttribute("data-shiplet-review-provenance", "v1");
			const provenanceSummary = document.createElement("summary");
			const provenanceLabel = item.revision_id === null ? "Earlier feedback" : item.revision_id === revisionId ? "Current revision" : "Earlier revision";
			provenanceSummary.textContent = provenanceLabel;
			const provenanceBody = document.createElement("span");
			provenanceBody.textContent = item.revision_id === null ? "Revision unknown" : provenanceLabel + " · " + item.revision_id;
			provenance.append(provenanceSummary, provenanceBody);
			const openFeedback = document.createElement("a");
			const feedbackUrl = new URL("/shiplets/" + encodeURIComponent(shipletId), new URL(location.href).origin);
			feedbackUrl.searchParams.set("feedback", feedbackId);
			openFeedback.href = feedbackUrl.toString();
			openFeedback.target = "_blank";
			openFeedback.rel = "noopener noreferrer";
			openFeedback.textContent = "Open feedback";
			openFeedback.setAttribute("aria-label", "Open feedback " + ticket);
			meta.append(quickStatusButton, statusMore, provenance, openFeedback);
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
			const replyInput = document.createElement("textarea");
			replyInput.rows = 3;
			replyInput.value = state.text;
			threadView.replyInput = replyInput;
			replyInput.maxLength = 5000;
			replyInput.placeholder = "Reply to this thread…";
			replyInput.setAttribute("aria-label", "Reply text for " + ticket);
			replyInput.disabled = Boolean(state.replyOperation);
			const replyButton = document.createElement("button");
			replyButton.type = "button";
			replyButton.textContent = "Send";
			replyButton.setAttribute("aria-label", "Reply to " + ticket);
			replyButton.setAttribute("data-shiplet-review-reply-submit", feedbackId);
			replyButton.disabled = !feedbackId || Boolean(state.replyOperation);
			const replyMentions = createReplyMentionSelect(ticket);
			threadView.replyMentions = replyMentions;
			for (const option of Array.from(replyMentions.options || [])) option.selected = state.mentions.some(mention => mention.userId === option.value);
			replyMentions.disabled = Boolean(state.replyOperation);
			const threadMessage = document.createElement("p");
			threadMessage.className = "shiplet-review-status shiplet-review-thread-message";
			threadMessage.textContent = state.message;
			threadMessage.hidden = !state.message;
			threadMessage.setAttribute("role", state.messageKind === "error" ? "alert" : "status");
			threadMessage.setAttribute("data-state", state.messageKind || "ready");
			replyInput.addEventListener("input", () => {
				state.text = String(replyInput.value || "").slice(0, 5000);
			});
			replyMentions.addEventListener("change", () => {
				state.mentions = selectedMentions(replyMentions);
			});
			async function submitReply() {
				state.text = String(replyInput.value || "").slice(0, 5000);
				state.mentions = selectedMentions(replyMentions);
				const replyValue = state.text.trim();
				if (!replyValue || state.replyOperation || !feedbackId) return;
				const submittedMentions = state.mentions.map((mention) => ({ userId: mention.userId }));
				const token = crypto.randomUUID();
				state.replyOperation = { token, text: replyValue, mentions: submittedMentions };
				state.message = "Sending reply to " + ticket + "…";
				state.messageKind = "pending";
				render(renderedItems);
				try {
					const response = await requestAt(childApiUrl("replies", feedbackId), "POST", { comment: replyValue, mentions: submittedMentions });
					if (!state.replyOperation || state.replyOperation.token !== token) return;
					state.replyOperation = null;
					if (response.pendingConfirmation) {
						state.message = "Reply awaiting confirmation. Use Send to reopen confirmation.";
						state.messageKind = "pending";
						render(renderedItems);
						return;
					}
					const currentView = threadViews.find((view) => view.id === feedbackId);
					if (currentView && currentView.replyInput) currentView.replyInput.value = "";
					if (currentView && currentView.replyMentions) for (const option of Array.from(currentView.replyMentions.options || [])) option.selected = false;
					state.text = "";
					state.mentions = [];
					state.message = "Reply added to " + ticket + ".";
					state.messageKind = "ready";
					if (isRecord(response) && isRecord(response.feedback) && response.feedback.id === feedbackId) {
						renderedItems = renderedItems.map((entry) => isRecord(entry) && entry.id === feedbackId ? response.feedback : entry);
						render(renderedItems);
					} else {
						await refresh();
					}
				} catch {
					if (!state.replyOperation || state.replyOperation.token !== token) return;
					state.replyOperation = null;
					state.message = "Could not reply to " + ticket + ". Try again.";
					state.messageKind = "error";
					render(renderedItems);
				}
			}
			replyButton.addEventListener("click", async (event) => {
				if (!event || event.isTrusted !== true) return;
				await submitReply();
			});
			replyInput.addEventListener("keydown", async (event) => {
				if (!event || event.isTrusted !== true || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey || activeComposition || event.isComposing || event.keyCode === 229) return;
				event.preventDefault();
				await submitReply();
			});
			replyForm.append(replyInput, replyMentions, replyButton, threadMessage);
			details.append(body, meta, replies, replyForm);
			row.append(summaryButton, details);
			list.appendChild(row);
			threadViews.push(threadView);
			const pinPoint = liveReviewPinPoint(item);
			if (pinPoint && feedbackId && pinnedIds.has(feedbackId) && !embeddedSiteOrigin) {
				const pin = document.createElement("button");
				pin.type = "button";
				pin.className = "shiplet-review-pin";
				pin.textContent = canonicalPinLabel(item, ticket);
				pin.setAttribute("aria-label", "Open " + ticket);
				pin.setAttribute("aria-controls", contextualThread.id);
				pin.setAttribute("aria-expanded", "false");
				pin.setAttribute("data-active", "false");
				pin.style.left = pinPoint.x + "px";
				pin.style.top = pinPoint.y + "px";
				pin.addEventListener("click", (event) => {
					if (!event || event.isTrusted !== true) return;
					if (activeThreadPresentation === "contextual" && activeFeedbackId === threadView.id) closeContextualThread(true);
					else { setActiveThread(threadView, "contextual", pin); requestSavedTargetReveal(threadView.id); }
				});
				threadView.pin = pin;
				pinLayer.appendChild(pin);
			}
		}
		postEmbeddedPins();
		pinLimit.hidden = eligiblePins.length <= 250;
		pinLimit.textContent = eligiblePins.length > 250 ? "250 of " + eligiblePins.length + " page pins shown. All comments remain in the list; selecting a comment reveals its pin." : "";
		const restoredThread = requestedActiveId ? threadViews.find((entry) => entry.id === requestedActiveId) : null;
		setActiveThread(restoredThread || null, requestedPresentation, restoredThread?.pin || null);
		renderPinStacks();
		updateReviewPinPositions();
		registerSavedTargets();
		pageCommentsButton.textContent = "Page comments (" + pageCommentsItems.length + ")";
		const effectiveReviewOverlay = overlayVisible && !annotationSelecting;
		pageCommentsButton.hidden = !effectiveReviewOverlay || pageCommentsItems.length === 0;
		renderPageCommentsMenu();
		const restoredEditor = editingThread && threadViews.find(view => view.id === editingThread.id)?.replyInput;
		if (restoredEditor && restoredThread?.id === editingThread.id) {
			restoredEditor.focus();
			if (editingSelection && typeof restoredEditor.setSelectionRange === "function") restoredEditor.setSelectionRange(editingSelection[0], editingSelection[1]);
		}
		updateCount(list.childElementCount);
		setStatus(list.childElementCount === 0 ? "No comments yet in this scope. Reset filters or add a comment." : list.childElementCount + (list.childElementCount === 1 ? " comment." : " comments."), "ready");
		loadedCount.textContent = list.childElementCount + (list.childElementCount === 1 ? " comment loaded" : " comments loaded") + (nextCursor === null && !nextPageFailed ? " · End of results" : "");
		loadMore.hidden = nextCursor === null || nextPageFailed;
		loadMore.disabled = Boolean(nextPageInFlight);
		retryPage.hidden = !nextPageFailed;
	}

	async function requestAt(url, method, body) {
		if (!url) throw new Error("Review endpoint unavailable.");
		if (embeddedSiteOrigin && new URL(url).pathname === "/embed/review/thread") {
			const actionUrl = new URL(url);
			const form = document.createElement("form");
			form.method = "POST"; form.action = actionUrl.origin + "/embed/review/thread"; form.target = "_blank"; form.rel = "noopener"; form.hidden = true;
			const values = { installation_id: actionUrl.searchParams.get("installation_id"), shiplet_id: shipletId, revision_id: revisionId, page_url: reviewPageUrl, feedback_id: actionUrl.searchParams.get("feedback_id"), action: actionUrl.searchParams.get("action"), value: body.comment || body.status };
			for (const [name, value] of Object.entries(values)) { const input = document.createElement("input"); input.name = name; input.value = value || ""; form.append(input); }
			document.body.append(form); form.requestSubmit(); form.remove();
			return { pendingConfirmation: true };
		}
		const options = { method, credentials: "include", headers: { "content-type": "application/json" } };
		if (body !== undefined) options.body = JSON.stringify(body);
		const response = await fetch(url, options);
		if (!response.ok) {
			let errorPayload = null;
			if (response.status === 409) {
				try { errorPayload = await response.json(); } catch {}
			}
			const error = new Error("Review request failed (" + response.status + ").");
			error.status = response.status;
			const unsupportedMentions = response.status === 409 && isRecord(errorPayload) && hasExactKeys(errorPayload, ["error", "filter"]) && errorPayload.error === "sandbox_filter_unsupported" && errorPayload.filter === "mentionedMe";
			if (unsupportedMentions) error.sandboxCapability = "mentionedMe";
			else if (error.status === 401 || error.status === 403 || error.status === 409) void fetchFreshReviewContext("authority");
			throw error;
		}
		return response.json();
	}

	async function request(method, body) {
		return requestAt(method === "GET" ? buildListUrl(null) : apiUrl, method, body);
	}

	function operationEndpoint(requestId, cancel = false) {
		if (!draftContextUrl || !isIdentifier(requestId)) return "";
		try {
			const url = new URL(draftContextUrl);
			if (url.pathname.endsWith("/draft-context")) url.pathname = url.pathname.replace(/\/draft-context$/, "/operations/" + encodeURIComponent(requestId));
			else if (url.pathname.endsWith("/review-draft-context")) url.pathname = url.pathname.replace(/\/review-draft-context$/, "/review-operations/" + encodeURIComponent(requestId));
			else return "";
			if (cancel) url.pathname += "/cancel";
			url.search = "";
			return url.toString();
		} catch { return ""; }
	}

	function operationReadUrl(snapshot) {
		const endpoint = operationEndpoint(snapshot.requestId, false);
		if (!endpoint) return "";
		try {
			const url = new URL(endpoint);
			url.searchParams.set("revision_id", snapshot.binding.revisionId);
			url.searchParams.set("page_url", snapshot.binding.pageUrl);
			url.searchParams.set("effect", snapshot.effect);
			if (snapshot.feedbackId) url.searchParams.set("feedback_id", snapshot.feedbackId);
			if (embeddedSiteOrigin) url.searchParams.set("installation_id", snapshot.binding.installationId || "");
			return url.toString();
		} catch { return ""; }
	}

	function operationSnapshotFor(effect, feedbackId, draftVersion, immutablePayload) {
		const requestId = "request_" + crypto.randomUUID().replace(/-/g, "");
		const payload = JSON.parse(JSON.stringify(immutablePayload));
		if (effect === "feedback.create" && isRecord(payload)) payload.clientFeedbackId = "client-" + crypto.randomUUID().replace(/-/g, "");
		return { requestId, effect, feedbackId: feedbackId || null, draftVersion, immutablePayload: payload, state: "pending", submittedOn: new Date().toISOString(), lastCheckedOn: new Date().toISOString(), binding: { actor: reviewContext?.actor || null, projectId: shipletId, revisionId, pageUrl: reviewPageUrl, installationId: reviewContext?.installationId || (embeddedSiteOrigin ? new URL(apiUrl).searchParams.get("installation_id") || "" : "") } };
	}

	function saveOperationReceipt(snapshot) {
		const persisted = { requestId: snapshot.requestId, effect: snapshot.effect, feedbackId: snapshot.feedbackId, draftVersion: snapshot.draftVersion, immutablePayload: snapshot.immutablePayload, state: snapshot.state, submittedOn: snapshot.submittedOn, lastCheckedOn: snapshot.lastCheckedOn };
		const index = operationReceipts.findIndex((operation) => operation.requestId === persisted.requestId);
		if (index >= 0) operationReceipts[index] = persisted; else operationReceipts.push(persisted);
		while (operationReceipts.length > 64) operationReceipts.shift();
		return scheduleDraftSave(true);
	}

	function showOperationState(state) {
		if (!state) return;
		const messages = { pending: "Awaiting confirmation. Reopen confirmation, check status, or cancel submission.", completed: "Feedback saved.", expired: "Confirmation expired. Retry the same submission.", failed: "Submission failed. Start a new attempt to try again.", unknown: "Submission status is unknown. Check status before retrying.", cancelled: "Submission cancelled." };
		setComposerMessage(messages[state] || "", state === "failed" || state === "unknown" ? "error" : state === "pending" || state === "expired" ? "pending" : "ready");
		if (state === "pending" || state === "unknown") setComposerBusy(true);
	}

	async function readOperationOutcome(snapshot) {
		const url = operationReadUrl(snapshot);
		if (!url || reviewSubmissionMode === "sandbox") return null;
		try {
			const response = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
			if (response.status === 404) return { state: "unknown", result: null };
			if (!response.ok) return { state: "unknown", result: null };
			const payload = await response.json();
			if (!isRecord(payload) || !isRecord(payload.operation) || !hasExactKeys(payload.operation, ["requestId", "effect", "state", "result"]) || payload.operation.requestId !== snapshot.requestId || payload.operation.effect !== snapshot.effect || !["pending", "completed", "expired", "failed", "unknown", "cancelled"].includes(payload.operation.state)) return { state: "unknown", result: null };
			return { state: payload.operation.state, result: payload.operation.result };
		} catch { return { state: "unknown", result: null }; }
	}

	async function pollOperation(snapshot) {
		if (!snapshot || operationPollRequestId === snapshot.requestId) return;
		operationPollRequestId = snapshot.requestId;
		const delays = [0, 1000, 2000, 4000, 8000];
		try { for (const delay of delays) {
			if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
			if (!topOperationSnapshot || topOperationSnapshot.requestId !== snapshot.requestId) return;
			const outcome = await readOperationOutcome(snapshot);
			if (!outcome) return;
			snapshot.state = outcome.state;
			snapshot.lastCheckedOn = new Date().toISOString();
			await saveOperationReceipt(snapshot);
			topOperationSnapshot = snapshot;
			if (outcome.state !== "pending") {
				showOperationState(outcome.state);
				if (outcome.state === "completed" && isRecord(outcome.result) && isIdentifier(outcome.result.feedbackId)) void refresh("poll");
				if (outcome.state === "completed" && topDraftVersion === snapshot.draftVersion) {
					clearEditableDraftOnly();
					topDraftVersion += 1;
				}
				setComposerBusy(false);
				return;
			}
			showOperationState("pending");
		}
		showOperationState("pending");
		} finally { if (operationPollRequestId === snapshot.requestId) operationPollRequestId = ""; }
	}

	async function cancelPendingOperation(snapshot) {
		if (!snapshot || reviewSubmissionMode === "sandbox") return false;
		const previousContextKey = reviewContextKey;
		await fetchFreshReviewContext("cancel");
		if (!contextReady || reviewContextKey !== previousContextKey) return false;
		const endpoint = operationEndpoint(snapshot.requestId, true);
		if (!endpoint) return false;
		try {
			const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ revisionId: snapshot.binding.revisionId, pageUrl: snapshot.binding.pageUrl, effect: snapshot.effect, feedbackId: snapshot.feedbackId }) });
			if (!response.ok) { snapshot.state = "unknown"; await saveOperationReceipt(snapshot); topOperationSnapshot = snapshot; showOperationState("unknown"); return false; }
			const payload = await response.json();
			const state = isRecord(payload) && isRecord(payload.operation) && payload.operation.state === "cancelled" ? "cancelled" : "unknown";
			snapshot.state = state;
			await saveOperationReceipt(snapshot);
			topOperationSnapshot = snapshot;
			showOperationState(state);
			if (state === "cancelled" && topDraftVersion === snapshot.draftVersion) { clearEditableDraftOnly(); topDraftVersion += 1; setComposerBusy(false); }
			return state === "cancelled";
		} catch { snapshot.state = "unknown"; await saveOperationReceipt(snapshot); topOperationSnapshot = snapshot; showOperationState("unknown"); return false; }
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

	async function refresh(mode) {
		const generation = refreshGeneration;
		const serial = ++firstPageSerial;
		refreshButton.disabled = true;
		staleRefresh.disabled = true;
		list.setAttribute("aria-busy", "true");
		if (renderedItems.length === 0) setStatus("Loading comments…", "loading");
		try {
			const response = validateListPayload(await request("GET"));
			if (generation !== refreshGeneration || serial !== firstPageSerial) return;
				if (mode === "poll") {
				if (renderedItems.length <= 100) nextCursor = response.nextCursor;
				render(mergeByFeedbackId(response.feedback, renderedItems));
			} else {
				const active = renderedItems.find(entry => isRecord(entry) && entry.id === activeFeedbackId);
				nextCursor = response.nextCursor;
				nextPageFailed = false;
				pageError.hidden = true;
				pageError.textContent = "";
					const replacement = active && !response.feedback.some(entry => isRecord(entry) && entry.id === activeFeedbackId) ? [...response.feedback, active] : response.feedback;
					render(replacement);
				}
				unsupportedFilter = "";
				clearStaleIndicator();
		} catch (error) {
			if (generation !== refreshGeneration || serial !== firstPageSerial) return;
			if (error && error.sandboxCapability === "mentionedMe") {
				unsupportedFilter = "mentionedMe";
				showStaleIndicator("Mentions is unavailable in this sandbox. Showing comments from the previously loaded scope; these are not Mentions results.", "retry-mentions");
				if (renderedItems.length === 0) setStatus("Mentions is unavailable in this sandbox. No previously loaded comments are available.", "error");
			} else if (error && error.status === 400) {
				showFilterError("These filters are not valid for the authorized review scope. Adjust them and try again.");
			} else if (error && (error.status === 401 || error.status === 403)) {
				if (embeddedSiteOrigin && !annotationActive && renderedItems.length === 0 && threadStates.size === 0 && !hasAnnotationDraft()) returnToEmbedSignIn();
				else if (renderedItems.length === 0) setStatus("Review access was denied. Reopen the review or ask the owner for access.", "error");
				showStaleIndicator(renderedItems.length > 0 ? "Review access changed. Showing saved comments and drafts." : "Review access was denied. Use Refresh after access is restored.");
			} else if (typeof navigator === "object" && navigator && navigator.onLine === false) {
				if (renderedItems.length === 0) setStatus("You’re offline. Comments will be available when the connection returns.", "error");
				showStaleIndicator(renderedItems.length > 0 ? "You’re offline. Showing saved comments and drafts." : "You’re offline. Use Refresh when the connection returns.");
			} else if (renderedItems.length > 0) {
				showStaleIndicator("Refresh failed. Showing saved comments and drafts.");
			} else {
				setStatus("Could not load comments. Use Refresh to try again.", "error");
				showStaleIndicator("Could not load comments. Use Refresh to try again.");
			}
		} finally {
			if (generation === refreshGeneration && serial === firstPageSerial) {
				list.setAttribute("aria-busy", "false");
				refreshButton.disabled = false;
				staleRefresh.disabled = false;
			}
		}
	}

	async function resetListAndRefresh(options = {}) {
		const retainPrevious = options.retainPrevious !== false;
		refreshGeneration += 1;
		firstPageSerial += 1;
		nextCursor = null;
		nextPageInFlight = "";
		nextPageFailed = false;
		unsupportedFilter = "";
		pageError.hidden = true;
		pageError.textContent = "";
		syncRenderedThreadDrafts();
		clearStaleIndicator();
		if (retainPrevious && renderedItems.length > 0) {
			render(renderedItems);
			showStaleIndicator("Loading the new filter. Showing comments from the previously loaded scope until it succeeds.");
		} else {
			render([]);
			loadedCount.textContent = "Loading comments…";
		}
		loadMore.hidden = true;
		retryPage.hidden = true;
		await refresh("replace");
	}

	async function manualRefresh() {
		refreshGeneration += 1;
		firstPageSerial += 1;
		nextPageInFlight = "";
		nextPageFailed = false;
		pageError.hidden = true;
		pageError.textContent = "";
		await refresh("replace");
	}

	async function loadNextPage() {
		const cursor = nextCursor;
		const generation = refreshGeneration;
		if (!cursor || nextPageInFlight === cursor) return;
		nextPageInFlight = cursor;
		nextPageFailed = false;
		pageError.hidden = true;
		loadMore.disabled = true;
		list.setAttribute("aria-busy", "true");
		try {
			const response = validateListPayload(await requestAt(buildListUrl(cursor), "GET"));
			if (generation !== refreshGeneration || nextPageInFlight !== cursor) return;
			nextCursor = response.nextCursor;
			nextPageInFlight = "";
			render(mergeByFeedbackId(renderedItems, response.feedback));
		} catch {
			if (generation !== refreshGeneration || nextPageInFlight !== cursor) return;
			nextPageInFlight = "";
			nextPageFailed = true;
			pageError.textContent = "Could not load more comments. Existing comments and drafts are unchanged.";
			pageError.hidden = false;
			loadMore.hidden = true;
			retryPage.hidden = false;
		} finally {
			if (generation === refreshGeneration) {
				list.setAttribute("aria-busy", "false");
				loadMore.disabled = false;
			}
		}
	}

	function setPanelOpen(open) {
		if (open && activeThreadPresentation === "contextual") {
			const active = threadViews.find((entry) => entry.id === activeFeedbackId);
			setActiveThread(active || null, "list");
		}
		panel.hidden = !open;
		commentsLauncher.setAttribute("aria-expanded", open ? "true" : "false");
		setReviewSurfaceOpenState();
		if (open) closeButton.focus();
		else commentsLauncher.focus();
		notifyEmbedView();
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

	function canonicalOperationPageUrl(value) {
		try {
			const url = new URL(String(value || ""));
			if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
			const hash = url.hash;
			url.hash = "";
			if (hash.startsWith("#/") && !hash.startsWith("#//")) {
				try {
					const nested = new URL(hash.slice(1), url.origin);
					if (nested.origin === url.origin) {
						url.hash = "#" + nested.pathname + nested.search;
					}
				} catch {}
			} else if (hash && !hash.startsWith("#")) {
				url.hash = "";
			}
			return url.toString();
		} catch { return ""; }
	}

	function contextKeyFor(value) {
		if (!isRecord(value) || !isRecord(value.actor) || !isIdentifier(value.actor.id) || !boundedString(value.actor.kind, 32) || !isIdentifier(value.projectId) || !isIdentifier(value.revisionId) || !boundedString(value.pageUrl, 4096)) return "";
		const pageUrl = canonicalOperationPageUrl(value.pageUrl);
		if (!pageUrl) return "";
		return ["v1", value.actor.kind, value.actor.id, value.projectId, value.revisionId, pageUrl, value.installationId || ""].join("|");
	}

	function localContextKeyFor(value) {
		if (!isRecord(value) || !isIdentifier(value.actorKind) || !isIdentifier(value.actorId) || !isIdentifier(value.projectId) || !isIdentifier(value.revisionId) || !boundedString(value.pageUrl, 4096)) return "";
		const pageUrl = canonicalOperationPageUrl(value.pageUrl);
		if (!pageUrl) return "";
		return ["v1", value.actorKind, value.actorId, value.projectId, value.revisionId, pageUrl, value.installationId || ""].join("|");
	}

	function validStoredCapture(value) {
		if (value === null) return true;
		if (!isRecord(value) || !hasExactKeys(value, ["screenshotDataUrl", "screenshotFailureNote", "screenshotMode", "viewport", "coordinates", "selectedElement", "captureContext"]) || value.screenshotMode !== "element" || !isRecord(value.viewport) || !isRecord(value.coordinates) || !isRecord(value.selectedElement) || !isRecord(value.captureContext)) return false;
		if (value.screenshotDataUrl !== null && (!boundedString(value.screenshotDataUrl, 13400000) || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.screenshotDataUrl))) return false;
		if (value.screenshotFailureNote !== null && !boundedString(value.screenshotFailureNote, 500)) return false;
		if (!hasExactKeys(value.viewport, ["width", "height", "devicePixelRatio"]) || !finiteNumber(value.viewport.width, 1, 100000) || !finiteNumber(value.viewport.height, 1, 100000) || !finiteNumber(value.viewport.devicePixelRatio, .1, 10)) return false;
		if (!hasExactKeys(value.coordinates, ["pageX", "pageY", "viewportX", "viewportY"]) || !finiteNumber(value.coordinates.pageX, -10000000, 10000000) || !finiteNumber(value.coordinates.pageY, -10000000, 10000000) || !finiteNumber(value.coordinates.viewportX, -100000, 100000) || !finiteNumber(value.coordinates.viewportY, -100000, 100000)) return false;
		if (!hasExactKeys(value.selectedElement, ["selector", "tagName", "text"]) || !boundedString(value.selectedElement.selector, 1200) || !value.selectedElement.selector || !boundedString(value.selectedElement.tagName, 64) || !/^[A-Z][A-Z0-9-]{0,63}$/.test(value.selectedElement.tagName) || !boundedString(value.selectedElement.text, 500)) return false;
		return hasExactKeys(value.captureContext, ["documentWidth", "documentHeight", "scrollX", "scrollY"]) && finiteNumber(value.captureContext.documentWidth, 1, 100000) && finiteNumber(value.captureContext.documentHeight, 1, 100000) && finiteNumber(value.captureContext.scrollX, -10000000, 10000000) && finiteNumber(value.captureContext.scrollY, -10000000, 10000000);
	}

	function exactDraftRecord(value) {
		if (!isRecord(value) || !hasExactKeys(value, ["version", "key", "context", "updatedOn", "overlayVisible", "topDraft", "threadDrafts", "operations"]) || value.version !== 1 || typeof value.key !== "string" || value.key.length > 2000 || !isRecord(value.context) || localContextKeyFor(value.context) !== value.key || !boundedString(value.updatedOn, 64) || typeof value.overlayVisible !== "boolean" || !isRecord(value.topDraft) || !isRecord(value.threadDrafts) || !Array.isArray(value.operations)) return null;
		if (Object.keys(value.threadDrafts).length > 256 || value.operations.length > 64) return null;
		for (const [id, draft] of Object.entries(value.threadDrafts)) {
			if (!isIdentifier(id) || !isRecord(draft) || !hasExactKeys(draft, ["version", "text", "mentionIds", "desiredStatus"]) || draft.version !== 1 || !boundedString(draft.text, 5000) || !Array.isArray(draft.mentionIds) || draft.mentionIds.length > 20 || !["New", "In Progress", "Blocked", "Staging", "Done", "Dropped"].includes(draft.desiredStatus)) return null;
			if (draft.mentionIds.some((mention) => !isIdentifier(mention))) return null;
		}
		if (!hasExactKeys(value.topDraft, ["version", "text", "mentionIds", "target", "capture", "screenshotDataUrl", "annotationStrokes", "mode"]) || value.topDraft.version !== 1 || !boundedString(value.topDraft.text, 5000) || !Array.isArray(value.topDraft.mentionIds) || value.topDraft.mentionIds.length > 20 || value.topDraft.mentionIds.some((mention) => !isIdentifier(mention)) || (value.topDraft.target !== null && (!isRecord(value.topDraft.target) || !hasExactKeys(value.topDraft.target, ["selector", "tagName", "text"]))) || !validStoredCapture(value.topDraft.capture) || (value.topDraft.screenshotDataUrl !== null && (!boundedString(value.topDraft.screenshotDataUrl, 13400000) || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.topDraft.screenshotDataUrl))) || !Array.isArray(value.topDraft.annotationStrokes) || value.topDraft.annotationStrokes.length > 256 || value.topDraft.annotationStrokes.some((stroke) => !Array.isArray(stroke) || stroke.length > 512 || stroke.some((point) => !isRecord(point) || !hasExactKeys(point, ["pageX", "pageY"]) || !finiteNumber(point.pageX, -10000000, 10000000) || !finiteNumber(point.pageY, -10000000, 10000000))) || !["closed", "composer", "expanded"].includes(value.topDraft.mode)) return null;
		for (const operation of value.operations) {
			if (!isRecord(operation) || !hasExactKeys(operation, ["requestId", "effect", "feedbackId", "draftVersion", "immutablePayload", "state", "submittedOn", "lastCheckedOn"]) || !isIdentifier(operation.requestId) || !boundedString(operation.effect, 64) || (operation.feedbackId !== null && !isIdentifier(operation.feedbackId)) || !Number.isInteger(operation.draftVersion) || operation.draftVersion < 1 || !isRecord(operation.immutablePayload) || !["pending", "completed", "expired", "failed", "unknown", "cancelled"].includes(operation.state) || !boundedString(operation.submittedOn, 64) || !boundedString(operation.lastCheckedOn, 64)) return null;
		}
		let serialized = "";
		try { serialized = JSON.stringify(value); } catch { return null; }
		if (new TextEncoder().encode(serialized).byteLength > 20971520) return null;
		return value;
	}

	function storageDisclosure(message) {
		if (!message) return;
		storageMessage.textContent = message;
		storageNotice.hidden = false;
		storageRetry.hidden = false;
		draftStorageState = "memory";
	}

	function storageReady() {
		storageNotice.hidden = true;
		storageMessage.textContent = "";
		storageRetry.hidden = true;
		draftStorageState = "ready";
	}

	function clearEditableDraftOnly() {
		comment.value = "";
		for (const option of Array.from(mentionSelect.options || [])) option.selected = false;
		setComposerMessage("", "");
		clearArtifactCapture();
		annotationStrokes = [];
		for (const state of threadStates.values()) { state.text = ""; state.mentions = []; }
	}

	function currentDraftRecord() {
		if (!reviewContext || !reviewContextKey) return null;
		const threadDrafts = {};
		for (const [key, state] of threadStates.entries()) {
			const id = key.split("\n").at(-1);
			if (!id || !isIdentifier(id) || (!state.text && !state.mentions.length)) continue;
			threadDrafts[id] = { version: 1, text: String(state.text || "").slice(0, 5000), mentionIds: state.mentions.slice(0, 20).map((mention) => mention.userId), desiredStatus: String(state.confirmedStatus || "New").slice(0, 40) };
		}
		const topDraft = { version: 1, text: String(comment.value || "").slice(0, 5000), mentionIds: selectedMentions(mentionSelect).slice(0, 20).map((mention) => mention.userId), target: artifactCapture && artifactCapture.selectedElement ? artifactCapture.selectedElement : null, capture: artifactCapture ? { ...artifactCapture, screenshotDataUrl: null } : null, screenshotDataUrl: artifactCapture?.screenshotDataUrl || null, annotationStrokes: annotationStrokes.slice(0, 256), mode: annotationExpanded ? "expanded" : annotationActive ? "composer" : "closed" };
		const operations = [];
		for (const operation of operationReceipts.slice(-64)) operations.push(operation);
		return { version: 1, key: reviewContextKey, context: { actorKind: reviewContext.actor.kind, actorId: reviewContext.actor.id, projectId: reviewContext.projectId, revisionId: reviewContext.revisionId, pageUrl: reviewContext.pageUrl, installationId: reviewContext.installationId || "" }, updatedOn: new Date().toISOString(), overlayVisible, topDraft, threadDrafts, operations };
	}

	function draftRecordNeedsRetention(record) {
		if (!record || !isRecord(record.topDraft) || !isRecord(record.threadDrafts) || !Array.isArray(record.operations)) return true;
		if (record.topDraft.text || record.topDraft.mentionIds?.length || record.topDraft.capture || record.topDraft.screenshotDataUrl || record.topDraft.annotationStrokes?.length) return true;
		if (Object.keys(record.threadDrafts).length > 0) return true;
		return record.operations.some((operation) => operation && ["pending", "unknown"].includes(operation.state));
	}

	function scheduleDraftSave(immediate) {
		if (!reviewContextKey || draftStorageState === "blocked") return Promise.resolve(false);
		if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = 0; }
		const save = async () => {
			const record = exactDraftRecord(currentDraftRecord());
			if (!record) return false;
			if (!draftDb) { storageDisclosure("Persistence is unavailable; a full reload can lose unsaved work."); return false; }
			try {
				await new Promise((resolve, reject) => {
					const transaction = draftDb.transaction("drafts", "readwrite");
					transaction.oncomplete = resolve;
					transaction.onerror = () => reject(transaction.error || new Error("storage"));
					transaction.onabort = () => reject(transaction.error || new Error("storage"));
					const store = transaction.objectStore("drafts");
					store.put(record);
					const all = store.getAll();
					all.onsuccess = () => {
						const clean = (Array.isArray(all.result) ? all.result : []).filter((entry) => !draftRecordNeedsRetention(entry)).sort((left, right) => String(left.updatedOn || "").localeCompare(String(right.updatedOn || "")));
						for (const entry of clean.slice(0, Math.max(0, clean.length - 32))) if (entry && entry.key !== record.key) store.delete(entry.key);
					};
				});
				storageReady();
				return true;
			} catch { storageDisclosure("Persistence is unavailable; a full reload can lose unsaved work."); return false; }
		};
		if (immediate) { draftSaveInFlight = save(); return draftSaveInFlight; }
		return new Promise((resolve) => { draftSaveTimer = window.setTimeout(() => { draftSaveTimer = 0; draftSaveInFlight = save().then(resolve); }, 150); });
	}

	function openDraftStorage() {
		if (typeof indexedDB !== "object" || !indexedDB) { storageDisclosure("Persistence is unavailable; a full reload can lose unsaved work."); return Promise.resolve(false); }
		return new Promise((resolve) => {
			try {
				const request = indexedDB.open("shiplet-review-drafts-v1", 1);
				request.onupgradeneeded = () => { const database = request.result; if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "key" }); };
				request.onerror = () => { storageDisclosure("Persistence is unavailable; a full reload can lose unsaved work."); resolve(false); };
				request.onsuccess = () => { draftDb = request.result; draftDb.onversionchange = () => draftDb.close(); storageReady(); resolve(true); };
			} catch { storageDisclosure("Persistence is unavailable; a full reload can lose unsaved work."); resolve(false); }
		});
	}

	function restoreDraftRecord() {
		if (!draftDb || !reviewContextKey) return Promise.resolve(false);
		return new Promise((resolve) => {
			try {
				const request = draftDb.transaction("drafts", "readonly").objectStore("drafts").get(reviewContextKey);
				request.onerror = () => resolve(false);
				request.onsuccess = () => {
					const record = exactDraftRecord(request.result);
					if (!record) { if (request.result) storageDisclosure("Saved review state was corrupt and was not restored."); resolve(false); return; }
					restoredDraft = record;
					overlayVisible = record.overlayVisible;
					const top = record.topDraft;
					comment.value = top.text;
					for (const option of Array.from(mentionSelect.options || [])) option.selected = top.mentionIds.includes(option.value);
					if (top.capture) { artifactCapture = { ...top.capture, screenshotDataUrl: top.screenshotDataUrl }; artifactCaptureRequestId = ""; artifactScreenshotBase = top.screenshotDataUrl || null; selectedTarget.textContent = top.capture.selectedElement?.tagName + (top.capture.selectedElement?.text ? " · " + top.capture.selectedElement.text : ""); clearTarget.hidden = false; drawOnScreenshot.hidden = !top.screenshotDataUrl; quickDraw.hidden = !top.screenshotDataUrl; }
					annotationStrokes = Array.isArray(top.annotationStrokes) ? top.annotationStrokes : [];
					for (const [id, value] of Object.entries(record.threadDrafts)) { const state = threadState(id, { status: value.desiredStatus }); state.text = value.text; state.mentions = value.mentionIds.map((userId) => ({ userId })); }
					for (const operation of record.operations) operationReceipts.push(operation);
					const latest = record.operations[record.operations.length - 1];
					if (latest && ["pending", "unknown", "expired", "failed"].includes(latest.state)) topOperationSnapshot = { ...latest, binding: { actor: reviewContext.actor, projectId: reviewContext.projectId, revisionId: reviewContext.revisionId, pageUrl: reviewContext.pageUrl, installationId: reviewContext.installationId || "" } };
					updateOverlayUi();
					resolve(true);
				};
			} catch { resolve(false); }
		});
	}

	async function fetchFreshReviewContext(reason) {
		if (!draftContextUrl || typeof fetch !== "function") { contextReady = true; return true; }
		const generation = ++contextGeneration;
		contextReady = false;
		contextFailure = "";
		try {
			const url = new URL(draftContextUrl);
			url.searchParams.set("revision_id", revisionId);
			url.searchParams.set("page_url", reviewPageUrl);
			if (embeddedSiteOrigin) url.searchParams.set("installation_id", new URL(apiUrl).searchParams.get("installation_id") || "");
			const response = await fetch(url.toString(), { method: "GET", credentials: "include", cache: "no-store" });
			if (generation !== contextGeneration) return false;
			if (!response.ok) throw new Error("Review context unavailable (" + response.status + ").");
			const payload = await response.json();
			const value = isRecord(payload) && isRecord(payload.context) ? payload.context : null;
			if (!value || !hasExactKeys(value, ["actor", "projectId", "revisionId", "pageUrl", "installationId", "expiresOn", "durableOperations"]) || !isRecord(value.actor) || !hasExactKeys(value.actor, ["kind", "id"]) || !["human", "sandbox"].includes(value.actor.kind) || !isIdentifier(value.actor.id) || value.projectId !== shipletId || value.revisionId !== revisionId || canonicalOperationPageUrl(value.pageUrl) !== canonicalOperationPageUrl(reviewPageUrl) || (embeddedSiteOrigin ? value.installationId !== (new URL(apiUrl).searchParams.get("installation_id") || "") : value.installationId !== null) || (value.expiresOn !== null && !boundedString(value.expiresOn, 64)) || typeof value.durableOperations !== "boolean") throw new Error("Review context binding was rejected.");
			const nextContextKey = contextKeyFor({ actor: value.actor, projectId: value.projectId, revisionId: value.revisionId, pageUrl: value.pageUrl, installationId: value.installationId || "" });
			if (!nextContextKey) throw new Error("Review context binding was rejected.");
			const contextChanged = nextContextKey !== reviewContextKey;
			reviewContext = value;
			reviewContextKey = nextContextKey;
			contextReady = true;
			await openDraftStorage();
			if (contextChanged) await restoreDraftRecord();
			if (contextChanged) hydrateReviewPreferences();
			return true;
		} catch (error) {
			if (generation !== contextGeneration) return false;
			contextFailure = error instanceof Error ? error.message : "Review context unavailable.";
			contextReady = reviewSubmissionMode === "sandbox";
			if (reviewSubmissionMode !== "sandbox") { storageDisclosure("Review identity is unavailable. Saved review content stays private until access is restored."); setStatus("Review identity is unavailable. Use Refresh after access is restored.", "error"); }
			return false;
		}
	}

	async function hydrateForContext(options = {}) {
		if (!contextReady) return;
		updateFilterUi();
		await resetListAndRefresh(options);
	}

	function parseArtifactCapture(data) {
		if (!pendingArtifactRequestId || artifactCaptureReadyRequestId !== pendingArtifactRequestId || !isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "requestId", "status", "payload"])) return null;
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

	function fidelityText(fidelity, failureNote) {
		if (fidelity === null || fidelity === undefined) return "Capture method unavailable for this earlier feedback.";
		if (fidelity.kind === "raster-source") return "Captured from the selected image.";
		if (fidelity.kind === "sanitized-dom") {
			const labels = { images: "images", canvas: "canvas", media: "media", "form-values": "form values", "external-styles": "external styles" };
			const limitations = Array.isArray(fidelity.limitations) ? fidelity.limitations.map(value => labels[value]).filter(Boolean) : [];
			return "Reconstructed from the visible page" + (limitations.length ? "; " + limitations.join(", ") + " may be omitted." : ".");
		}
		if (fidelity.kind === "fallback") return "Approximate fallback capture." + (failureNote ? " " + failureNote : "");
		return "No image attached.";
	}

	function parsePageCapture(data) {
		if (!pendingPageCaptureRequestId || !isRecord(data) || !hasExactKeys(data, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "requestId", "pageUrl", "status", "payload"])) return null;
		if (data.protocol !== "shiplet.artifact.page-capture.result.v1" || data.type !== "result" || data.channelNonce !== artifactChannelNonce || data.shipletId !== shipletId || data.revisionId !== revisionId || data.requestId !== pendingPageCaptureRequestId || data.pageUrl !== pendingPageCapturePageUrl || data.status !== "captured" || !isRecord(data.payload)) return null;
		const value = data.payload;
		if (!hasExactKeys(value, ["screenshotDataUrl", "screenshotFailureNote", "screenshotMode", "viewport", "captureContext", "fidelity"]) || value.screenshotMode !== "page" || !isRecord(value.viewport) || !isRecord(value.captureContext) || !isRecord(value.fidelity)) return null;
		if (value.screenshotDataUrl !== null && (!boundedString(value.screenshotDataUrl, 13400000) || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.screenshotDataUrl))) return null;
		if (value.screenshotFailureNote !== null && !boundedString(value.screenshotFailureNote, 500)) return null;
		if (!hasExactKeys(value.viewport, ["width", "height", "devicePixelRatio"]) || !finiteNumber(value.viewport.width, 1, 100000) || !finiteNumber(value.viewport.height, 1, 100000) || !finiteNumber(value.viewport.devicePixelRatio, .1, 10)) return null;
		if (!hasExactKeys(value.captureContext, ["documentWidth", "documentHeight", "scrollX", "scrollY"]) || !finiteNumber(value.captureContext.documentWidth, 1, 100000) || !finiteNumber(value.captureContext.documentHeight, 1, 100000) || !finiteNumber(value.captureContext.scrollX, -10000000, 10000000) || !finiteNumber(value.captureContext.scrollY, -10000000, 10000000)) return null;
		if (!hasExactKeys(value.fidelity, ["version", "kind", "limitations"]) || value.fidelity.version !== 1 || !["raster-source", "sanitized-dom", "fallback", "none"].includes(value.fidelity.kind) || !Array.isArray(value.fidelity.limitations)) return null;
		const allowed = ["images", "canvas", "media", "form-values", "external-styles"];
		if (value.fidelity.limitations.length > 5 || new Set(value.fidelity.limitations).size !== value.fidelity.limitations.length || value.fidelity.limitations.some(item => !allowed.includes(item)) || (value.fidelity.kind === "none" && value.fidelity.limitations.length)) return null;
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
		artifactCaptureReadyRequestId = "";
		artifactCapturePostedNonce = "";
		selectedTarget.textContent = "Page · " + reviewPath;
		selectedTarget.title = reviewPath;
		annotationTargetPin.hidden = true;
		annotationTargetFocus.hidden = true;
		updateAnnotationProperties(null);
		clearTarget.hidden = true;
		drawOnScreenshot.hidden = true;
		quickDraw.hidden = true;
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
		notifyEmbedView();
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
				notifyEmbedView();
				setStatus(applied ? "Screenshot annotations added." : "Screenshot annotations could not be added.", applied ? "ready" : "error");
			});
			cancelDrawing.addEventListener("click", (event) => { if (event && event.isTrusted === true) closeAnnotationEditor(); });
		}
		annotationLayer.hidden = false;
		annotationStrokeCheckpoint = annotationStrokes.length;
		annotationEditing = true;
		notifyEmbedView();
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

	function submitTopLevelConfirmation(requestValue, captureValue, mentionValues, clientFeedbackId) {
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
			appendField("client_feedback_id", isIdentifier(clientFeedbackId) ? clientFeedbackId : "embed-" + crypto.randomUUID());
		}
		appendField("page_url", reviewPageUrl);
		if (embeddedSiteOrigin) appendField("installation_id", new URL(apiUrl).searchParams.get("installation_id") || "");
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

	function stopArtifactLifecycle(sendDisconnect) {
		if (bridgeLifecycleTimer && typeof window.clearInterval === "function") window.clearInterval(bridgeLifecycleTimer);
		if (bridgeLeaseTimer && typeof window.clearTimeout === "function") window.clearTimeout(bridgeLeaseTimer);
		if (bridgeReconnectTimer && typeof window.clearTimeout === "function") window.clearTimeout(bridgeReconnectTimer);
		bridgeLifecycleTimer = 0;
		bridgeLeaseTimer = 0;
		bridgeReconnectTimer = 0;
		if (sendDisconnect && artifactPort) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.lifecycle.command.v1", type: "disconnect", channelNonce: artifactChannelNonce, shipletId, revisionId }); } catch {}
		}
		bridgeReady = false;
		artifactChannelConnected = false;
		bridgeGeneration += 1;
		savedTargetGeometry = new Map();
		bridgeGeometrySeen = false;
		selectTarget.disabled = true;
	}

	function sendArtifactLifecycleRenewal(generation) {
		if (!artifactPort || !artifactChannelConnected || generation !== bridgeGeneration || !contextReady) return;
		bridgeLifecycleSequence = Math.min(2147483647, bridgeLifecycleSequence + 1);
		try { artifactPort.postMessage({ protocol: "shiplet.artifact.lifecycle.command.v1", type: "renew", channelNonce: artifactChannelNonce, shipletId, revisionId, sequence: bridgeLifecycleSequence }); } catch {}
	}

	function startArtifactLifecycle() {
		if (!draftContextUrl) return;
		const generation = bridgeGeneration;
		bridgeLifecycleSequence = 0;
		bridgeLastAlive = Date.now();
		if (bridgeLifecycleTimer && typeof window.clearInterval === "function") window.clearInterval(bridgeLifecycleTimer);
		sendArtifactLifecycleRenewal(generation);
		if (typeof window.setInterval === "function") bridgeLifecycleTimer = window.setInterval(() => sendArtifactLifecycleRenewal(generation), 1000);
		if (bridgeLeaseTimer && typeof window.clearTimeout === "function") window.clearTimeout(bridgeLeaseTimer);
		if (typeof window.setTimeout === "function") bridgeLeaseTimer = window.setTimeout(() => {
			if (generation !== bridgeGeneration || Date.now() - bridgeLastAlive < 3000) return;
			bridgeReady = false;
			artifactChannelConnected = false;
			selectTarget.disabled = true;
			if (annotationPreparing) cancelTargetSelection();
			showStaleIndicator("Artifact tracking disconnected. Use Retry to reconnect.");
		}, 3200);
	}

	function enableArtifactShortcuts() {
		if (!artifactPort || !bridgeReady || !contextReady) return;
		try { artifactPort.postMessage({ protocol: "shiplet.artifact.shortcuts.command.v1", type: "enable", channelNonce: artifactChannelNonce, shipletId, revisionId }); } catch {}
	}

	function disableArtifactShortcuts() {
		if (!artifactPort) return;
		try { artifactPort.postMessage({ protocol: "shiplet.artifact.shortcuts.command.v1", type: "disable", channelNonce: artifactChannelNonce, shipletId, revisionId }); } catch {}
	}

	function trustedRouteCandidate(value) {
		try {
			const candidate = new URL(value);
			const initialPublic = new URL(page.getAttribute("data-review-page-url") || reviewPageUrl);
			const initialArtifact = new URL(artifactInitialUrl || candidate.toString());
			if (candidate.origin !== (embeddedSiteOrigin || initialArtifact.origin)) return "";
			if (embeddedSiteOrigin) return canonicalOperationPageUrl(candidate.toString());
			const marker = "/artifact-frame";
			const artifactPath = initialArtifact.pathname;
			const markerIndex = artifactPath.indexOf(marker);
			if (markerIndex < 0) return candidate.origin === initialPublic.origin ? canonicalOperationPageUrl(candidate.toString()) : "";
			const deliveryBase = artifactPath.slice(0, markerIndex + marker.length);
			const initialSuffix = artifactPath.slice(markerIndex + marker.length).replace(/^\/+/, "");
			const initialPublicPath = initialPublic.pathname;
			if (initialSuffix && !initialPublicPath.endsWith("/" + initialSuffix) && initialPublicPath !== "/" + initialSuffix) return "";
			const publicBase = initialSuffix ? initialPublicPath.slice(0, initialPublicPath.length - initialSuffix.length).replace(/\/$/, "") : initialPublicPath.replace(/\/$/, "");
			let suffix = "";
			if (candidate.pathname.startsWith(deliveryBase + "/")) suffix = candidate.pathname.slice(deliveryBase.length + 1);
			else if (candidate.origin === initialArtifact.origin && candidate.pathname.startsWith("/")) suffix = candidate.pathname.replace(/^\/+/, "");
			if (suffix.includes("..") || /%2f|%5c|\\/i.test(suffix)) return "";
			const mapped = new URL(initialPublic.origin + (publicBase || "") + (suffix ? "/" + suffix : ""));
			mapped.search = candidate.search;
			mapped.hash = candidate.hash.startsWith("#/") ? candidate.hash : "";
			return canonicalOperationPageUrl(mapped.toString());
		} catch { return ""; }
	}

	async function handleArtifactRouteChange(value) {
		const candidate = trustedRouteCandidate(value);
		if (!candidate || candidate === canonicalOperationPageUrl(reviewPageUrl)) return;
		const previousContext = reviewContext;
		const previousKey = reviewContextKey;
		syncRenderedThreadDrafts();
		await scheduleDraftSave(true);
		refreshGeneration += 1;
		firstPageSerial += 1;
		nextCursor = null;
		nextPageInFlight = "";
		nextPageFailed = false;
		unsupportedFilter = "";
		pageError.hidden = true;
		pageError.textContent = "";
		clearStaleIndicator();
		savedTargetDescriptors = [];
		pendingRevealId = "";
		pageCommentsMenu.hidden = true;
		pageCommentsButton.setAttribute("aria-expanded", "false");
		if (artifactPort && artifactChannelConnected) {
			try { artifactPort.postMessage({ protocol: "shiplet.artifact.saved-targets.command.v1", type: "replace", channelNonce: artifactChannelNonce, shipletId, revisionId, targets: [] }); } catch {}
		}
		render([]);
		list.setAttribute("aria-busy", "true");
		loadedCount.textContent = "Loading comments…";
		setStatus("Loading comments…", "loading");
		reviewPageUrl = candidate;
		try { reviewPath = new URL(candidate).pathname || "/"; } catch { reviewPath = "/"; }
		contextGeneration += 1;
		contextReady = false;
		savedTargetGeometry = new Map();
		await fetchFreshReviewContext("route");
		if (!contextReady) {
			reviewContext = previousContext;
			reviewContextKey = previousKey;
			reviewPageUrl = previousContext?.pageUrl || reviewPageUrl;
			showStaleIndicator("This page route cannot be reviewed until it is reopened through Shiplet.");
			return;
		}
		page.setAttribute("data-review-page-url", reviewPageUrl);
		contextDisclosure.querySelector?.("p") && (context.textContent = "Shiplet " + shipletId + " · Revision " + revisionId + " · " + reviewPath);
		await hydrateForContext({ retainPrevious: false });
	}

	function offerArtifactChannel() {
		if (!artifact || (!embeddedSiteOrigin && !artifact.contentWindow) || typeof MessageChannel !== "function") return;
		const wasPreparing = annotationPreparing;
		stopArtifactLifecycle(true);
		if (artifactPort && pendingArtifactRequestId) {
			if (artifactCapturePostedNonce === artifactChannelNonce) {
				try { artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "cancel", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingArtifactRequestId }); } catch {}
			}
			pendingArtifactRequestId = "";
			annotationSelecting = false;
			selectTarget.textContent = artifactCapture ? "Change element" : "Select element";
		}
		artifactCaptureReadyRequestId = "";
		artifactCapturePostedNonce = "";
		if (wasPreparing) pendingArtifactRequestId = "";
		annotationPreparing = wasPreparing;
		if (wasPreparing) {
			annotationSelecting = false;
			artifact.setAttribute("data-shiplet-selecting", "false");
			updateOverlayUi();
			setStatus("Connecting to the artifact…", "loading");
		}
		try { if (artifactPort && typeof artifactPort.close === "function") artifactPort.close(); } catch {}
		artifactPort = null;
		artifactSourceWindow = null;
		artifactChannelConnected = false;
		if (followingId) stopFollowing();
		closeAnnotationEditor();
		selectTarget.disabled = true;
		savedTargetGeometry = new Map();
		savedTargetDescriptors = [];
		artifactSourceWindow = embeddedSiteOrigin ? parent : artifact.contentWindow;
		artifactChannelNonce = crypto.randomUUID();
		artifactSourceWindow.postMessage({ protocol: "shiplet.artifact.channel.v1", type: "offer", channelNonce: artifactChannelNonce, shipletId, revisionId }, embeddedSiteOrigin || "*");
	}

	window.addEventListener("message", (event) => {
		if (!artifactSourceWindow || event.source !== artifactSourceWindow || event.origin !== (embeddedSiteOrigin || "null") || artifactChannelConnected) return;
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
			const pageCaptureValue = parsePageCapture(portEvent.data);
			if (pageCaptureValue) {
				pendingPageCaptureRequestId = "";
				pendingPageCapturePageUrl = "";
				artifactCapture = { ...pageCaptureValue, coordinates: { pageX: pageCaptureValue.captureContext.scrollX, pageY: pageCaptureValue.captureContext.scrollY, viewportX: 0, viewportY: 0 }, selectedElement: null };
				artifactCaptureRequestId = "";
				artifactScreenshotBase = pageCaptureValue.screenshotDataUrl;
				selectedTarget.textContent = "Page · " + reviewPath;
				selectedTarget.title = reviewPath;
				fidelityDisclosure.textContent = fidelityText(pageCaptureValue.fidelity, pageCaptureValue.screenshotFailureNote);
				showComposer(true);
				if (pageCaptureValue.screenshotDataUrl) {
					void structuredEditor.open({ screenshotDataUrl: pageCaptureValue.screenshotDataUrl, defaults: reviewPreferences.annotation });
					setStatus("Visible page captured. Add annotations or continue with a page comment.", "ready");
				} else setComposerMessage("Visible page capture was unavailable. Your text-only page comment is still available.", "error");
				return;
			}
			const lifecycle = portEvent.data;
			if (isRecord(lifecycle) && hasExactKeys(lifecycle, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "sequence"]) && lifecycle.protocol === "shiplet.artifact.lifecycle.v1" && lifecycle.type === "alive" && lifecycle.channelNonce === connectedNonce && lifecycle.shipletId === shipletId && lifecycle.revisionId === revisionId && Number.isInteger(lifecycle.sequence) && lifecycle.sequence === bridgeLifecycleSequence) {
				bridgeLastAlive = Date.now();
				bridgeReady = true;
				if (bridgeLeaseTimer && typeof window.clearTimeout === "function") window.clearTimeout(bridgeLeaseTimer);
				if (typeof window.setTimeout === "function") bridgeLeaseTimer = window.setTimeout(() => { if (Date.now() - bridgeLastAlive >= 3000 && artifactPort === connectedPort) { bridgeReady = false; selectTarget.disabled = true; if (annotationPreparing) cancelTargetSelection(); showStaleIndicator("Artifact tracking disconnected. Use Retry to reconnect."); } }, 3200);
				registerSavedTargets();
				enableArtifactShortcuts();
				return;
			}
			const geometry = parseSavedTargetGeometry(portEvent.data);
			if (geometry) {
				bridgeGeometrySeen = true;
				savedTargetGeometry = geometry;
				const needsHostedPinRender = !embeddedSiteOrigin && threadViews.some((entry) => !entry.pin && savedTargetForItem(entry.item) && liveReviewPinPoint(entry.item));
				if (needsHostedPinRender) render(renderedItems);
				else {
					updateReviewPinPositions();
					postEmbeddedPins();
				}
				if (pendingRevealId) {
					const target = geometry.get(pendingRevealId);
					if (target?.eligible && !target.offscreen) { pendingRevealId = ""; setStatus("Target revealed.", "ready"); }
					else if (target && (!target.eligible || target.offscreen)) { pendingRevealId = ""; setStatus("Target unavailable", "ready"); }
				}
				return;
			}
			const route = portEvent.data;
			if (isRecord(route) && hasExactKeys(route, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "pageUrl"]) && route.protocol === "shiplet.artifact.route.v1" && route.type === "change" && route.channelNonce === connectedNonce && route.shipletId === shipletId && route.revisionId === revisionId && boundedString(route.pageUrl, 4096)) {
				currentArtifactRouteUrl = route.pageUrl;
				void handleArtifactRouteChange(route.pageUrl);
				return;
			}
			const shortcut = portEvent.data;
			if (isRecord(shortcut) && hasExactKeys(shortcut, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "action"]) && shortcut.protocol === "shiplet.artifact.shortcuts.v1" && shortcut.type === "action" && shortcut.channelNonce === connectedNonce && shortcut.shipletId === shipletId && shortcut.revisionId === revisionId && (shortcut.action === "comment" || shortcut.action === "cancel")) {
				if (shortcut.action === "comment") void beginAnnotation();
				else if (annotationSelecting || annotationActive || annotationPreparing) cancelAnnotationFlow();
				else if (activeThreadPresentation === "contextual") closeContextualThread(true);
				else if (!panel.hidden) setPanelOpen(false);
				return;
			}
			const viewportValue = parseArtifactViewport(portEvent.data);
			if (viewportValue) {
				artifactViewport = viewportValue;
				updateReviewPinPositions();
				renderRemoteCursors();
				renderAnnotationCanvas();
				if (artifactCapture && !form.hidden) anchorAnnotationComposer(artifactCapture, false);
				queueViewportPresence();
				return;
			}
			const pointerValue = parseArtifactPointer(portEvent.data);
			if (pointerValue) {
				if (pointerValue.type === "move") queueCursorPresence(pointerValue.pointer);
				else sendCursorLeave();
				return;
			}
			if (parseArtifactFollowInterrupt(portEvent.data)) {
				stopFollowing();
				return;
			}
			const captureReady = portEvent.data;
			if (
				annotationPreparing &&
				!annotationSelecting &&
				!artifactCaptureReadyRequestId &&
				pendingArtifactRequestId &&
				isRecord(captureReady) &&
				hasExactKeys(captureReady, ["protocol", "type", "channelNonce", "shipletId", "revisionId", "requestId"]) &&
				captureReady.protocol === "shiplet.artifact.capture.state.v1" &&
				captureReady.type === "ready" &&
				captureReady.channelNonce === connectedNonce &&
				captureReady.shipletId === shipletId &&
				captureReady.revisionId === revisionId &&
				captureReady.requestId === pendingArtifactRequestId &&
				isIdentifier(captureReady.requestId)
			) {
				artifactCaptureReadyRequestId = captureReady.requestId;
				annotationPreparing = false;
				setPanelOpen(false);
				form.hidden = true;
				annotationTargetPin.hidden = true;
				annotationTargetFocus.hidden = true;
				setAnnotationExpanded(false);
				setAnnotationMode(true, true);
				selectTarget.textContent = "Selecting…";
				setStatus("Select an element to annotate. Press Escape to cancel.", "ready");
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
			artifactCaptureReadyRequestId = "";
			artifactCapturePostedNonce = "";
			setAnnotationMode(true, false);
			selectedTarget.textContent = captureValue.selectedElement.tagName + (captureValue.selectedElement.text ? " · " + captureValue.selectedElement.text : "") + " · " + captureValue.selectedElement.selector;
			selectedTarget.title = captureValue.selectedElement.selector;
			updateAnnotationProperties(captureValue);
			clearTarget.hidden = false;
			drawOnScreenshot.hidden = !captureValue.screenshotDataUrl;
			quickDraw.hidden = !captureValue.screenshotDataUrl;
			selectTarget.textContent = "Change element";
			if (embeddedSiteOrigin) setPanelOpen(true);
			showComposer(true);
			setStatus("Element context captured. Add an annotation and continue to secure confirmation.", "ready");
		});
		connectedPort.start();
		artifactSourceWindow.postMessage({ protocol: "shiplet.artifact.channel.v1", type: "connect", channelNonce: artifactChannelNonce, shipletId, revisionId }, embeddedSiteOrigin || "*", [channel.port2]);
		selectTarget.disabled = false;
		startArtifactLifecycle();
		if (annotationPreparing) sendPendingArtifactCaptureStart();
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
		if (!value || composerOperation || !contextReady || (topOperationSnapshot && ["pending", "unknown", "failed"].includes(topOperationSnapshot.state))) return;
		if (draftContextUrl) {
			const previousContextKey = reviewContextKey;
			await fetchFreshReviewContext("submit");
			if (!contextReady || reviewContextKey !== previousContextKey) { setComposerMessage("Review identity is unavailable. Use Refresh after access is restored.", "error"); return; }
		}
		const token = crypto.randomUUID();
		const submittedMentions = selectedMentions(mentionSelect).map((mention) => ({ userId: mention.userId }));
		const submittedCapture = artifactCapture;
		composerOperation = { token, value };
		setComposerBusy(true);
		if (reviewSubmissionMode === "sandbox") {
			setStatus("Adding feedback to this sandbox…", "loading");
			setComposerMessage("Adding this feedback…", "pending");
			try {
				const payload = {
					comment: value,
					pageUrl: reviewPageUrl,
					clientFeedbackId: "client-" + Date.now().toString(36) + "-" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
					mentions: submittedMentions,
					...(submittedCapture || {}),
				};
				const response = await request("POST", payload);
				if (!composerOperation || composerOperation.token !== token) return;
				composerOperation = null;
				discardAnnotationDraft();
				if (isRecord(response) && isRecord(response.feedback)) {
					render([response.feedback, ...renderedItems.filter((entry) => !isRecord(entry) || entry.id !== response.feedback.id)]);
				} else {
					await refresh();
				}
				setStatus("Feedback added to this sandbox.", "ready");
				showComposer(false);
				if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches) setPanelOpen(false);
			} catch {
				if (!composerOperation || composerOperation.token !== token) return;
				composerOperation = null;
				setStatus("Sandbox feedback could not be added. Try again.", "error");
				setComposerMessage("Sandbox feedback could not be added. Try again.", "error");
			} finally {
				if (!composerOperation || composerOperation.token === token) setComposerBusy(false);
			}
			return;
		}
		setStatus("Opening secure confirmation…", "loading");
		setComposerMessage("Opening secure confirmation…", "pending");
		const snapshot = topOperationSnapshot && ["expired"].includes(topOperationSnapshot.state) ? topOperationSnapshot : operationSnapshotFor("feedback.create", null, topDraftVersion, { comment: value, mentions: submittedMentions, capture: submittedCapture });
		snapshot.immutablePayload = snapshot.immutablePayload || { comment: value, mentions: submittedMentions, capture: submittedCapture };
		if (!topOperationSnapshot || topOperationSnapshot.requestId !== snapshot.requestId) { topOperationSnapshot = snapshot; await saveOperationReceipt(snapshot); }
		const submitted = submitTopLevelConfirmation({
			requestId: snapshot.requestId,
			operation: "feedback.create",
			payload: { comment: String(snapshot.immutablePayload.comment || value) },
		}, submittedCapture, submittedMentions, snapshot.immutablePayload.clientFeedbackId);
		if (!composerOperation || composerOperation.token !== token) return;
		composerOperation = null;
		setComposerBusy(false);
		if (!submitted) {
			snapshot.state = "failed";
			await saveOperationReceipt(snapshot);
			topOperationSnapshot = snapshot;
			setStatus("Secure confirmation could not be opened. Try again.", "error");
			setComposerMessage("Secure confirmation could not be opened. Try again.", "error");
			return;
		}
		setStatus("Awaiting secure confirmation. This draft has been retained.", "ready");
		showOperationState("pending");
		void pollOperation(snapshot);
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!event || event.isTrusted !== true) return;
		await submitReviewFeedback();
	});
	comment.addEventListener("compositionstart", () => { mentionComposing = true; mentionSearchGeneration += 1; });
	comment.addEventListener("compositionend", () => { mentionComposing = false; void searchMentions(); });
	comment.addEventListener("input", () => { topDraftVersion += 1; void scheduleDraftSave(false); if (!mentionComposing) void searchMentions(); });
	comment.addEventListener("keydown", event => {
		if (mentionListbox.hidden || mentionComposing || event.isComposing || event.keyCode === 229) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const delta = event.key === "ArrowDown" ? 1 : -1; mentionSearchIndex = (mentionSearchIndex + delta + mentionSearchResults.length) % Math.max(1, mentionSearchResults.length); renderMentionSearch(""); }
		else if ((event.key === "Enter" || event.key === "Tab") && mentionSearchResults[mentionSearchIndex]) { event.preventDefault(); chooseMention(mentionSearchResults[mentionSearchIndex]); }
		else if (event.key === "Escape") { event.preventDefault(); mentionSearchGeneration += 1; mentionSearchResults = []; renderMentionSearch(""); }
	});
	mentionListbox.addEventListener("click", event => { if (!event || event.isTrusted !== true || !(event.target instanceof Element)) return; const option = event.target.closest("button[role=option]"); if (!option) return; chooseMention(mentionSearchResults.find(user => user.id === option.dataset.userId)); });
	mentionSelect.addEventListener("change", () => { topDraftVersion += 1; void scheduleDraftSave(false); });
	window.addEventListener("focus", () => { void (async () => { await fetchFreshReviewContext("focus"); if (topOperationSnapshot && ["pending", "unknown"].includes(topOperationSnapshot.state)) void pollOperation(topOperationSnapshot); })(); });
	window.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" || document.visibilityState === undefined) { void (async () => { await fetchFreshReviewContext("visibility"); if (topOperationSnapshot && ["pending", "unknown"].includes(topOperationSnapshot.state)) void pollOperation(topOperationSnapshot); })(); if (artifactChannelConnected) startArtifactLifecycle(); } else void scheduleDraftSave(true); });
	window.addEventListener("pagehide", () => { void scheduleDraftSave(true); });

	function returnToEmbedSignIn() {
		const start = new URL("/embed/review/start", location.href);
		start.searchParams.set("installation_id", new URL(apiUrl).searchParams.get("installation_id") || new URL(location.href).searchParams.get("installation_id") || "");
		start.searchParams.set("return_url", reviewPageUrl);
		location.replace(start.toString());
	}

	async function beginAnnotation() {
		if (hasAnnotationDraft()) {
			showComposer(true);
			return;
		}
		if (embeddedSiteOrigin) {
			try { await request("GET"); }
			catch (error) {
				if (error && (error.status === 401 || error.status === 403)) returnToEmbedSignIn();
				else { setStatus("Could not check review access. Check your connection and try again.", "error"); setPanelOpen(true); }
				return;
			}
		}
		startTargetSelection();
	}

	function sendPendingArtifactCaptureStart() {
		if (!annotationPreparing || annotationSelecting || !artifactPort) return;
		if (!pendingArtifactRequestId) pendingArtifactRequestId = "capture_request_" + crypto.randomUUID().replace(/-/g, "");
		if (artifactCapturePostedNonce === artifactChannelNonce) return;
		artifactCaptureReadyRequestId = "";
		artifactCapturePostedNonce = artifactChannelNonce;
		selectTarget.textContent = "Preparing…";
		try {
			artifactPort.postMessage({ protocol: "shiplet.artifact.capture.command.v1", type: "start", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingArtifactRequestId });
		} catch {
			artifactCapturePostedNonce = "";
			setStatus("Artifact tracking disconnected. Use Retry to reconnect.", "error");
		}
	}

	function startTargetSelection() {
		if (pendingArtifactRequestId || annotationPreparing || annotationSelecting) return;
		annotationPreparing = true;
		pendingArtifactRequestId = "capture_request_" + crypto.randomUUID().replace(/-/g, "");
		artifactCaptureReadyRequestId = "";
		artifactCapturePostedNonce = "";
		selectTarget.textContent = "Preparing…";
		setStatus(artifactPort ? "Preparing element selection…" : "Connecting to the artifact…", "loading");
		sendPendingArtifactCaptureStart();
	}

	selectTarget.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true) return;
		await beginAnnotation();
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
	refreshButton.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await manualRefresh(); });
	staleRefresh.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await manualRefresh(); });
	loadMore.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await loadNextPage(); });
	retryPage.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await loadNextPage(); });
	async function applyFilterChange(key, value) {
		showFilterError("");
		if (key === "prefix") {
			const prefix = normalizedPrefix(value);
			if (!prefix) { showFilterError("Enter a path on the authorized review origin without query parameters or a fragment."); return; }
			filterPreferences.prefix = prefix;
			filterPreferences.scope = "prefix";
		} else filterPreferences[key] = value;
		persistFilterPreferences();
		updateFilterUi();
		await resetListAndRefresh();
	}
	scopeSelect.addEventListener("change", async (event) => {
		if (!event || event.isTrusted !== true) return;
		if (scopeSelect.value === "prefix") {
			const prefix = normalizedPrefix(prefixInput.value) || normalizedPrefix(reviewPageUrl);
			await applyFilterChange("prefix", prefix);
		} else await applyFilterChange("scope", scopeSelect.value);
	});
	stateSelect.addEventListener("change", async (event) => { if (event && event.isTrusted === true) await applyFilterChange("state", stateSelect.value); });
	actorSelect.addEventListener("change", async (event) => { if (event && event.isTrusted === true) await applyFilterChange("actor", actorSelect.value); });
	revisionSelect.addEventListener("change", async (event) => { if (event && event.isTrusted === true) await applyFilterChange("revision", revisionSelect.value); });
	applyPrefix.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await applyFilterChange("prefix", prefixInput.value); });
	prefixInput.addEventListener("keydown", async (event) => {
		if (!event || event.isTrusted !== true || event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
		event.preventDefault(); await applyFilterChange("prefix", prefixInput.value);
	});
	resetFilters.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true) return;
		filterPreferences = { ...defaultFilters };
		persistFilterPreferences(); updateFilterUi(); showFilterError(""); await resetListAndRefresh();
	});
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
	pageComment.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true) return;
		creationMenu.hidden = true;
		clearArtifactCapture();
		fidelityDisclosure.textContent = "No image attached.";
		setPanelOpen(false);
		showComposer(true);
	});
	drawOnPage.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true || !artifactPort || !bridgeReady || pendingPageCaptureRequestId) return;
		creationMenu.hidden = true;
		pendingPageCaptureRequestId = "page_capture_" + crypto.randomUUID().replace(/-/g, "");
		pendingPageCapturePageUrl = currentArtifactRouteUrl;
		setStatus("Capturing the visible page…", "loading");
		try { artifactPort.postMessage({ protocol: "shiplet.artifact.page-capture.command.v1", type: "capture", channelNonce: artifactChannelNonce, shipletId, revisionId, requestId: pendingPageCaptureRequestId, pageUrl: pendingPageCapturePageUrl }); }
		catch { pendingPageCaptureRequestId = ""; pendingPageCapturePageUrl = ""; showComposer(true); setComposerMessage("Visible page capture was unavailable. Your text-only page comment is still available.", "error"); }
	});
	selectElement.addEventListener("click", (event) => { if (event && event.isTrusted === true) { creationMenu.hidden = true; startTargetSelection(); } });
	composeButton.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true) return;
		if (embeddedSiteOrigin) { await beginAnnotation(); return; }
		creationMenu.hidden = !creationMenu.hidden;
		composeButton.setAttribute("aria-expanded", creationMenu.hidden ? "false" : "true");
	});
	dockSelect.addEventListener("change", event => { if (event && event.isTrusted === true && ["top-left", "top-right", "bottom-left", "bottom-right"].includes(dockSelect.value)) { reviewPreferences.dock = dockSelect.value; persistReviewPreferences(); } });
	launchSelect.addEventListener("change", event => { if (event && event.isTrusted === true && ["manual", "open-comments"].includes(launchSelect.value)) { reviewPreferences.launch = launchSelect.value; persistReviewPreferences(); } });
	motionSelect.addEventListener("change", event => { if (event && event.isTrusted === true && ["system", "reduced"].includes(motionSelect.value)) { reviewPreferences.motion = motionSelect.value; persistReviewPreferences(); } });
	copyRequestsToggle.addEventListener("change", event => { if (event && event.isTrusted === true) { reviewPreferences.copyRequestsEnabled = Boolean(copyRequestsToggle.checked); persistReviewPreferences(); } });
	copyHiddenReview.addEventListener("click", event => { if (event && event.isTrusted === true) void copyCleanReviewLink("review"); });
	copyHiddenComments.addEventListener("click", event => { if (event && event.isTrusted === true) void copyCleanReviewLink("comments"); });
	restoreVisibility.addEventListener("click", event => { if (!event || event.isTrusted !== true) return; launcherDock.hidden = false; restoreVisibility.hidden = true; setOverlayVisible(reviewPreferences.overlaysVisible); });
	cancelComposer.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true) return;
		if (topOperationSnapshot && ["pending", "unknown"].includes(topOperationSnapshot.state)) {
			const cancelled = await cancelPendingOperation(topOperationSnapshot);
			if (!cancelled) return;
		}
		cancelAnnotationFlow();
	});
	cancelAnnotationMode.addEventListener("click", (event) => { if (event && event.isTrusted === true) cancelAnnotationFlow(); });
	retryOperationButton.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true || !topOperationSnapshot || topOperationSnapshot.state !== "failed") return;
		await fetchFreshReviewContext("retry");
		if (!contextReady) { setComposerMessage("Review identity is unavailable. Use Refresh after access is restored.", "error"); return; }
		topOperationSnapshot = null;
		setComposerBusy(false);
		setComposerMessage("", "");
		void scheduleDraftSave(true);
	});
	overlayToggle.addEventListener("click", (event) => { if (event && event.isTrusted === true) setOverlayVisible(!overlayVisible); });
	pageCommentsButton.addEventListener("click", (event) => {
		if (!event || event.isTrusted !== true || !(overlayVisible && !annotationSelecting) || pageCommentsItems.length === 0) return;
		renderPageCommentsMenu();
		pageCommentsMenu.hidden = !pageCommentsMenu.hidden;
		pageCommentsButton.setAttribute("aria-expanded", pageCommentsMenu.hidden ? "false" : "true");
		if (!pageCommentsMenu.hidden) pageCommentsMenu.querySelector?.("button")?.focus?.();
	});
	storageRetry.addEventListener("click", async (event) => {
		if (!event || event.isTrusted !== true) return;
		if (await openDraftStorage()) { await scheduleDraftSave(true); await restoreDraftRecord(); }
	});
	closeButton.addEventListener("click", (event) => { if (event && event.isTrusted === true) setPanelOpen(false); });
	contextualThreadClose.addEventListener("click", (event) => { if (event && event.isTrusted === true) closeContextualThread(true); });
	commentsLauncher.addEventListener("click", (event) => { if (event && event.isTrusted === true) setPanelOpen(panel.hidden); });
	launcher.addEventListener("click", async (event) => { if (event && event.isTrusted === true) await beginAnnotation(); });
	window.addEventListener("compositionstart", () => { activeComposition = true; });
	window.addEventListener("compositionend", () => { activeComposition = false; });
	window.addEventListener("keydown", (event) => {
		if (event && event.key === "Escape" && followingId && !activeComposition && !event.isComposing && event.keyCode !== 229) stopFollowing();
	});
	window.addEventListener("keydown", async (event) => {
		if (!event || event.isTrusted !== true) return;
		const target = event.target;
		const tagName = target && typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
		const editable = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || Boolean(target && target.isContentEditable);
		if (event.key === "Escape") {
			if (activeComposition || event.isComposing || event.keyCode === 229) return;
			if (activeThreadPresentation === "contextual") {
				event.preventDefault();
				closeContextualThread(true);
				return;
			}
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
			if (!form.hidden || annotationActive || annotationPreparing) {
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
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && target === comment && !activeComposition && !event.isComposing && event.keyCode !== 229) {
			event.preventDefault();
			await submitReviewFeedback();
			return;
		}
		if (!editable && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "c") {
			event.preventDefault();
			await beginAnnotation();
		}
	});
	window.addEventListener("resize", () => {
		renderAnnotationCanvas();
		updateReviewPinPositions();
		if (form.hidden) return;
		if (artifactCapture) anchorAnnotationComposer(artifactCapture, true);
		else moveAnnotationComposer(parseFloat(form.style.left || "8"), parseFloat(form.style.top || "8"));
	});
	window.addEventListener("online", () => { void refresh("poll"); });
	window.addEventListener("beforeunload", () => {
		presenceStopped = true;
		window.clearTimeout(presenceReconnectTimer);
		clearWidgetHandshakeTimer();
		try { if (presenceSocket) presenceSocket.close(1000, "page unloading"); } catch {}
	});
	if (typeof window.setInterval === "function") window.setInterval(() => { if (!document.hidden) void refresh("poll"); }, 5000);

	if (embeddedSiteOrigin) {
		// Intent is written only inside the trusted frame by a real launcher click.
		const intentKey = "shiplet.embed.intent:" + (new URL(location.href).searchParams.get("installation_id") || "");
		let intent; try { intent = sessionStorage.getItem(intentKey); sessionStorage.removeItem(intentKey); } catch {}
		if (intent === "annotate") startTargetSelection();
		else if (intent === "comments") setPanelOpen(true);
		else notifyEmbedView();
	}
	filterPreferences = readFilterPreferences();
	if (filterPreferences.scope === "prefix" && !filterPreferences.prefix) filterPreferences.scope = "page";
	updateFilterUi();
	updateOverlayUi();
	void (async () => { await fetchFreshReviewContext("initial"); if (contextReady) await hydrateForContext(); else { list.setAttribute("aria-busy", "false"); setStatus("Review identity is unavailable. Use Refresh after access is restored.", "error"); } })();
	void loadWatch();
	void loadMentionUsers();
	connectPresence();
	applyTransientVisibility();
})();`;
}

export function trustedReviewHostStyles(): string {
  return String.raw`
:root{color-scheme:light;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20293a;background:#fff;--shiplet-ink:#20293a;--shiplet-muted:#5d6b85;--shiplet-line:#c8cbd3;--shiplet-surface:#fbf9f4;--shiplet-raised:#fff;--shiplet-action:#b44729;--shiplet-accent:#2f6e88}
*{box-sizing:border-box}body{margin:0;min-height:100vh}main{height:100vh;background:#fff}iframe[data-shiplet-artifact-frame]{display:block;width:100%;height:100%;border:0;background:#fff;color-scheme:light dark}
.shiplet-review-launcher-dock{position:fixed;right:16px;bottom:16px;z-index:31;display:flex;align-items:stretch;gap:6px;transition:opacity .14s ease,transform .14s ease}.shiplet-review-launcher-dock[data-annotation-active="true"],.shiplet-review-launcher-dock[data-review-surface-open="true"]{visibility:hidden;opacity:0;pointer-events:none;transform:translateY(8px)}
.shiplet-review-launcher,.shiplet-review-comments-launcher{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid rgba(255,255,255,.34);background:#20293a;box-shadow:0 4px 16px rgba(0,0,0,.32),0 0 0 1px rgba(0,0,0,.32);color:#fff;font:750 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.shiplet-review-launcher{padding:0 13px;border-radius:9px}.shiplet-review-launcher::before{content:"+";display:grid;place-items:center;width:17px;height:17px;margin-right:7px;border:1.5px solid #fff;border-radius:999px;font:800 14px/1 ui-sans-serif}.shiplet-review-launcher[data-panel-open="true"]{visibility:hidden;opacity:0;pointer-events:none;transform:translateY(8px)}.shiplet-review-comments-launcher{width:40px;padding:0;border-radius:9px}
.shiplet-review-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#fff;color:var(--shiplet-ink);font-size:10px;font-weight:800}
.shiplet-annotation-modebar{position:fixed;top:12px;left:50%;z-index:2147483550;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);min-height:42px;padding:5px 6px 5px 12px;transform:translateX(-50%);border:1px solid var(--shiplet-accent);border-radius:10px;background:var(--shiplet-surface);box-shadow:0 7px 22px rgba(0,0,0,.26);color:var(--shiplet-ink);font:800 12px/1.2 ui-sans-serif,system-ui,sans-serif;white-space:nowrap}.shiplet-annotation-mode-label{min-width:0;overflow:hidden;text-overflow:ellipsis}.shiplet-annotation-modebar[hidden]{display:none}.shiplet-annotation-modebar button{min-width:34px;min-height:32px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui;cursor:pointer}
.shiplet-annotation-target-focus{position:fixed;z-index:2147483518;border:2px solid var(--shiplet-accent);border-radius:6px;background:rgba(47,110,136,.05);box-shadow:0 0 0 1px rgba(255,255,255,.9),0 0 0 4px rgba(47,110,136,.16);pointer-events:none}.shiplet-annotation-target-focus::before,.shiplet-annotation-target-focus::after{content:"";position:absolute;width:18px;height:18px;border-color:var(--shiplet-action)}.shiplet-annotation-target-focus::before{top:-3px;left:-3px;border-top:3px solid var(--shiplet-action);border-left:3px solid var(--shiplet-action);border-radius:6px 0 0}.shiplet-annotation-target-focus::after{right:-3px;bottom:-3px;border-right:3px solid var(--shiplet-action);border-bottom:3px solid var(--shiplet-action);border-radius:0 0 6px}.shiplet-annotation-target-focus[hidden]{display:none}.shiplet-annotation-target-pin{position:fixed;z-index:2147483520;width:28px;height:24px;transform:translate(-50%,-50%);border:2px solid #fff;border-radius:9px;background:var(--shiplet-action);box-shadow:0 0 0 2px var(--shiplet-ink),0 5px 12px rgba(0,0,0,.34);pointer-events:none}.shiplet-annotation-target-pin::after{content:"";position:absolute;left:5px;bottom:-6px;width:8px;height:8px;border-right:2px solid #fff;border-bottom:2px solid #fff;background:var(--shiplet-action);transform:rotate(45deg)}.shiplet-annotation-target-pin[hidden]{display:none}
.shiplet-review-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
iframe[data-shiplet-artifact-frame][data-shiplet-selecting="true"]{outline:3px solid #1677ff;outline-offset:-3px;filter:saturate(.96) brightness(.94)}
.shiplet-review-pin-layer{position:fixed;inset:0;z-index:28;pointer-events:none}.shiplet-review-pin{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;width:28px;height:28px;padding:0;border:2px solid #fff;border-radius:999px;background:#fff;box-shadow:0 0 0 2px #20293a,0 3px 10px rgba(0,0,0,.32);color:var(--shiplet-ink);font:800 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;pointer-events:auto;transition:background .14s ease,color .14s ease,box-shadow .14s ease,transform .14s ease}.shiplet-review-pin[data-active="true"]{transform:translate(-50%,-50%) scale(1.12);background:var(--shiplet-action);box-shadow:0 0 0 3px #20293a,0 5px 14px rgba(0,0,0,.36);color:#fff}
.shiplet-review-pin-stack{position:absolute;transform:translate(-50%,-50%);display:grid;place-items:center;width:32px;height:32px;padding:0;border:2px solid #fff;border-radius:999px;background:var(--shiplet-action);box-shadow:0 0 0 2px #20293a,0 4px 12px rgba(0,0,0,.36);color:#fff;font:800 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;pointer-events:auto}.shiplet-review-pin-stack:focus-visible{outline:3px solid var(--shiplet-accent);outline-offset:3px}.shiplet-review-pin-stack-menu{position:fixed;z-index:34;display:grid;gap:4px;width:min(320px,calc(100vw - 16px));max-height:min(220px,calc(100vh - 16px));padding:6px;overflow:auto;border:1px solid var(--shiplet-line);border-radius:9px;background:#fff;box-shadow:0 10px 28px rgba(32,41,58,.28);pointer-events:auto}.shiplet-review-pin-stack-menu[hidden]{display:none}.shiplet-review-pin-stack-menu button{min-height:36px;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:#fff;color:var(--shiplet-ink);font:700 11px/1.3 ui-sans-serif,system-ui,sans-serif;text-align:left;cursor:pointer}.shiplet-review-pin-stack-menu button:hover,.shiplet-review-pin-stack-menu button:focus-visible{border-color:var(--shiplet-accent);background:#edf5f7;outline:0}
.shiplet-review-page-comments{position:fixed;right:16px;top:16px;z-index:33;min-height:36px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:8px;background:var(--shiplet-surface);box-shadow:0 4px 14px rgba(32,41,58,.2);color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;pointer-events:auto}.shiplet-review-page-comments[hidden]{display:none}.shiplet-review-page-comments-menu{position:fixed;right:16px;top:58px;z-index:34;display:grid;gap:4px;width:min(320px,calc(100vw - 16px));max-height:min(260px,calc(100vh - 76px));padding:6px;overflow:auto;border:1px solid var(--shiplet-line);border-radius:9px;background:#fff;box-shadow:0 10px 28px rgba(32,41,58,.28);pointer-events:auto}.shiplet-review-page-comments-menu[hidden]{display:none}.shiplet-review-page-comments-menu button{min-height:36px;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:#fff;color:var(--shiplet-ink);font:700 11px/1.3 ui-sans-serif,system-ui,sans-serif;text-align:left;cursor:pointer}.shiplet-review-page-comments-menu button:hover,.shiplet-review-page-comments-menu button:focus-visible{border-color:var(--shiplet-accent);background:#edf5f7;outline:0}
.shiplet-contextual-thread{position:fixed;z-index:32;display:grid;grid-template-rows:auto minmax(0,1fr);width:min(440px,calc(100vw - 16px));max-height:min(560px,calc(100dvh - 16px));overflow:hidden;border:1px solid var(--shiplet-line);border-radius:12px;background:var(--shiplet-surface);box-shadow:0 14px 42px rgba(32,41,58,.26)}.shiplet-contextual-thread[hidden]{display:none}.shiplet-contextual-thread-header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:8px 10px;border-bottom:1px solid var(--shiplet-line);background:var(--shiplet-raised)}.shiplet-contextual-thread-title{color:var(--shiplet-action);font:800 12px/1.2 ui-sans-serif,system-ui,sans-serif}.shiplet-contextual-thread-close{min-width:56px;min-height:36px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.shiplet-contextual-thread-body{min-height:0;overflow:auto;overscroll-behavior:contain}.shiplet-contextual-thread-body>.shiplet-review-thread-details{border-top:0;padding:12px}.shiplet-contextual-thread-body .shiplet-review-thread-comment{font-size:14px}
.shiplet-review-presence{position:fixed;top:16px;left:16px;z-index:30;display:flex;align-items:center;gap:6px;min-height:38px;padding:4px 7px 4px 10px;border:1px solid var(--shiplet-line);border-radius:999px;background:var(--shiplet-surface);box-shadow:0 3px 12px rgba(32,41,58,.18)}.shiplet-review-presence[hidden]{display:none}.shiplet-review-presence-summary{margin-right:3px;color:var(--shiplet-muted);font-size:11px;font-weight:700}.shiplet-review-presence-avatar{display:inline-grid;place-items:center;width:28px;height:28px;border:2px solid var(--shiplet-ink);border-radius:999px;background:#fff;color:var(--shiplet-ink);font:800 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.shiplet-review-presence-viewer{appearance:none;position:relative;display:inline-grid;place-items:center;padding:0;border:0;border-radius:999px;background:transparent;color:var(--shiplet-ink);font:inherit}.shiplet-review-presence-viewer::after{content:attr(data-shiplet-presence-name);position:absolute;top:calc(100% + 9px);left:50%;z-index:1;padding:6px 9px;border-radius:7px;background:var(--shiplet-ink);color:#fff;font:700 11px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;box-shadow:0 4px 12px rgba(32,41,58,.24);opacity:0;transform:translate(-50%,-3px);pointer-events:none;transition:opacity .12s ease,transform .12s ease}.shiplet-review-presence-viewer:first-of-type::after,.shiplet-review-presence-viewer:nth-of-type(2)::after{left:0;transform:translate(0,-3px)}.shiplet-review-presence-viewer:hover::after,.shiplet-review-presence-viewer:focus-visible::after{opacity:1;transform:translate(-50%,0)}.shiplet-review-presence-viewer:first-of-type:hover::after,.shiplet-review-presence-viewer:nth-of-type(2):hover::after,.shiplet-review-presence-viewer:first-of-type:focus-visible::after,.shiplet-review-presence-viewer:nth-of-type(2):focus-visible::after{transform:translate(0,0)}button.shiplet-review-presence-viewer{cursor:pointer;transition:transform .14s ease,box-shadow .14s ease}button.shiplet-review-presence-viewer:hover,button.shiplet-review-presence-viewer:focus-visible{transform:translateY(-1px);box-shadow:0 0 0 3px color-mix(in srgb,currentColor 28%,transparent);outline:0}button.shiplet-review-presence-viewer[aria-pressed="true"]{box-shadow:0 0 0 3px currentColor}button.shiplet-review-presence-viewer[aria-pressed="true"] .shiplet-review-presence-avatar{border-color:#fff}.shiplet-review-presence-viewer[data-shiplet-presence-self]{opacity:.82}
.shiplet-review-cursor-layer{position:fixed;inset:0;z-index:29;overflow:hidden;pointer-events:none}.shiplet-review-remote-cursor{position:absolute;left:0;top:0;display:flex;align-items:flex-start;gap:0;will-change:transform;transition:transform .09s linear}.shiplet-review-remote-cursor[hidden]{display:none}.shiplet-review-remote-cursor-arrow{position:relative;display:block;width:20px;height:22px;filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff) drop-shadow(0 2px 3px rgba(0,0,0,.35))}.shiplet-review-remote-cursor-arrow::before{content:"";position:absolute;inset:0;background:currentColor;clip-path:polygon(0 0,100% 58%,56% 64%,38% 100%)}.shiplet-review-remote-cursor-label{display:inline-flex;align-items:center;gap:6px;max-width:220px;margin:14px 0 0 -4px;padding:3px 9px 3px 3px;border-radius:999px;background:#20293a;color:#fff;font:750 11px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}.shiplet-review-remote-cursor-avatar{display:inline-grid;place-items:center;flex:0 0 auto;width:18px;height:18px;border:1.5px solid #fff;border-radius:999px;background:#fff;background-repeat:no-repeat;color:var(--shiplet-ink);font:800 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}.shiplet-review-remote-cursor-name{overflow:hidden;text-overflow:ellipsis}
.shiplet-review-follow{position:fixed;top:16px;left:50%;z-index:30;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);min-height:38px;padding:4px 5px 4px 5px;transform:translateX(-50%);border:2px solid var(--shiplet-ink);border-radius:999px;background:var(--shiplet-surface);box-shadow:0 3px 12px rgba(32,41,58,.18);color:var(--shiplet-ink);font:750 12px/1 ui-sans-serif,system-ui,sans-serif;white-space:nowrap}.shiplet-review-follow[hidden]{display:none}.shiplet-review-follow-avatar{display:inline-grid;place-items:center;width:26px;height:26px;border:2px solid var(--shiplet-ink);border-radius:999px;background:#fff;background-repeat:no-repeat;color:var(--shiplet-ink);font:800 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}.shiplet-review-follow-text{overflow:hidden;text-overflow:ellipsis}.shiplet-review-follow-stop{appearance:none;min-height:28px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:999px;background:#fff;color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.shiplet-review-follow-stop:hover{border-color:var(--shiplet-ink)}
#shiplet-kernel-review-panel{position:fixed;right:12px;bottom:12px;z-index:30;display:grid;align-content:start;width:min(312px,calc(100vw - 24px));max-height:min(520px,calc(100dvh - 24px));overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--shiplet-line);border-radius:11px;background:var(--shiplet-surface);box-shadow:0 10px 32px rgba(32,41,58,.2)}#shiplet-kernel-review-panel[hidden]{display:none}[data-shiplet-kernel-review-controls]{display:grid;min-width:0;grid-template-columns:minmax(0,1fr)}
.shiplet-review-head{position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:9px 9px 8px 11px;border-bottom:1px solid #d7dbe3;background:rgba(251,249,244,.97);backdrop-filter:blur(8px)}.shiplet-review-heading{min-width:0}.shiplet-review-head h2{margin:0;font-size:14px;line-height:1.2}.shiplet-review-context-disclosure{position:relative;max-width:100%;margin-top:2px}.shiplet-review-context-disclosure summary{display:block;max-width:100%;overflow:hidden;color:var(--shiplet-muted);font:700 10px/1.3 ui-sans-serif,system-ui,sans-serif;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;list-style:none}.shiplet-review-context-disclosure summary::-webkit-details-marker{display:none}.shiplet-review-context-disclosure summary::before{content:"↳ ";color:var(--shiplet-action)}.shiplet-review-context{position:absolute;top:18px;left:0;z-index:4;width:min(294px,calc(100vw - 44px));margin:0;padding:7px 8px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;box-shadow:0 6px 18px rgba(32,41,58,.18);color:var(--shiplet-muted);font:650 10px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.shiplet-review-composer-context{margin:3px 0 0;color:var(--shiplet-muted);font:650 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shiplet-review-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
.shiplet-review-secondary,.shiplet-review-icon,.shiplet-review-primary,.shiplet-review-thread-action,.shiplet-review-status-more summary,.shiplet-review-options summary,.shiplet-review-reply-form button{min-height:32px;padding:0 8px;border:1px solid var(--shiplet-line);border-radius:7px;background:var(--shiplet-raised);color:var(--shiplet-ink);font:700 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}.shiplet-review-primary{border-color:#8f321c;background:var(--shiplet-action);color:#fff}.shiplet-review-icon{font-size:0;width:32px;padding:0}.shiplet-review-icon::before{content:"×";font-size:20px;font-weight:400}.shiplet-review-nav{width:30px;font-size:13px}.shiplet-review-nav::before{content:none}.shiplet-review-compose{width:32px;padding:0;font-size:17px;color:var(--shiplet-muted)}.shiplet-review-options,.shiplet-review-status-more{position:relative}.shiplet-review-options summary,.shiplet-review-status-more summary{display:grid;place-items:center;padding:0;list-style:none}.shiplet-review-options summary{width:30px}.shiplet-review-status-more summary{width:auto;padding:0 7px;color:var(--shiplet-muted)}.shiplet-review-options summary::-webkit-details-marker,.shiplet-review-status-more summary::-webkit-details-marker{display:none}.shiplet-review-options>div{position:absolute;top:36px;right:0;display:grid;gap:5px;min-width:126px;padding:6px;border:1px solid var(--shiplet-line);border-radius:8px;background:#fff;box-shadow:0 8px 22px rgba(32,41,58,.2)}
.shiplet-review-status{min-height:0;margin:0;padding:6px 11px;color:var(--shiplet-muted);font-size:10px}.shiplet-review-status[hidden]{display:none}.shiplet-review-status[data-state="error"]{border-bottom:1px solid #e5b7ad;background:#f8e9e5;color:#8c2a1c}
.shiplet-review-create-menu{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:8px;border-bottom:1px solid var(--shiplet-line);background:#fff}.shiplet-review-create-menu[hidden]{display:none}.shiplet-review-create-menu button{min-height:44px;padding:7px;border:1px solid var(--shiplet-line);border-radius:8px;background:#fff;color:var(--shiplet-ink);font:750 11px/1.25 ui-sans-serif,system-ui;cursor:pointer}.shiplet-review-create-menu button:first-child{border-color:var(--shiplet-action);background:var(--shiplet-action);color:#fff}
.shiplet-review-settings>summary,.shiplet-review-custom-actions>summary{min-height:32px;padding:9px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;font:750 11px/1 ui-sans-serif,system-ui;cursor:pointer}.shiplet-review-settings>div{display:grid;gap:8px;width:min(300px,calc(100vw - 32px));padding:9px}.shiplet-review-settings label{display:grid;gap:4px;font-size:11px}.shiplet-review-settings select,.shiplet-review-settings button,.shiplet-review-settings input[readonly]{min-height:38px;max-width:100%;padding:7px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink)}.shiplet-review-custom-actions p{max-width:260px;margin:0;padding:8px;font-size:11px}.shiplet-review-mention-listbox{display:grid;max-height:180px;overflow:auto;border:1px solid var(--shiplet-line);border-radius:8px;background:#fff}.shiplet-review-mention-listbox[hidden]{display:none}.shiplet-review-mention-listbox button{min-height:38px;padding:7px 9px;border:0;border-bottom:1px solid var(--shiplet-line);background:#fff;text-align:left}.shiplet-review-mention-listbox button[aria-selected="true"]{background:#e3edf2}.shiplet-review-fidelity{margin:0;padding:8px;border-radius:7px;background:#edf5f7;color:#245b72;font-size:11px}.shiplet-review-rich-tools,.shiplet-review-copy-request,.shiplet-review-structured-editor{grid-column:1/-1}.shiplet-review-copy-request{padding:8px;border:1px solid var(--shiplet-line);border-radius:8px}.shiplet-review-copy-request p{font-size:11px}.shiplet-review-copy-request textarea{width:100%}body[data-review-dock="top-left"] #shiplet-kernel-review-panel,body[data-review-dock="top-right"] #shiplet-kernel-review-panel{top:max(12px,env(safe-area-inset-top));bottom:auto}body[data-review-dock="top-left"] #shiplet-kernel-review-panel,body[data-review-dock="bottom-left"] #shiplet-kernel-review-panel{left:max(12px,env(safe-area-inset-left));right:auto}body[data-review-dock="top-right"] #shiplet-kernel-review-panel,body[data-review-dock="bottom-right"] #shiplet-kernel-review-panel{right:max(12px,env(safe-area-inset-right));left:auto}.shiplet-review-launcher-dock[data-review-dock="top-left"],.shiplet-review-launcher-dock[data-review-dock="top-right"]{top:max(12px,env(safe-area-inset-top));bottom:auto}.shiplet-review-launcher-dock[data-review-dock="top-left"],.shiplet-review-launcher-dock[data-review-dock="bottom-left"]{left:max(12px,env(safe-area-inset-left));right:auto}.shiplet-review-launcher-dock[data-review-dock="top-right"],.shiplet-review-launcher-dock[data-review-dock="bottom-right"]{right:max(12px,env(safe-area-inset-right));left:auto}body[data-review-reduced-motion="true"] *,body[data-review-reduced-motion="true"] *::before,body[data-review-reduced-motion="true"] *::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}
.shiplet-review-filter-bar{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid #e5e7eb;background:#fff}.shiplet-review-filters{position:relative}.shiplet-review-filters>summary{min-height:34px;padding:9px 10px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;font-size:11px;font-weight:800;cursor:pointer;list-style:none}.shiplet-review-filter-fields{position:absolute;top:40px;left:0;z-index:5;display:grid;width:min(330px,calc(100vw - 32px));gap:9px;padding:11px;border:1px solid var(--shiplet-line);border-radius:9px;background:#fff;box-shadow:0 8px 24px rgba(32,41,58,.2)}.shiplet-review-filter-fields label{display:grid;gap:4px;color:var(--shiplet-muted);font-size:10px;font-weight:800}.shiplet-review-filter-fields select,.shiplet-review-filter-fields input{min-height:38px;width:100%;padding:7px 8px;border:1px solid #9ca3af;border-radius:7px;background:#fff;color:var(--shiplet-ink);font:inherit}.shiplet-review-filter-help{font-size:10px;font-weight:500;line-height:1.35}.shiplet-review-filter-error,.shiplet-review-page-error{margin:0;color:#8c2a1c;font-size:11px}.shiplet-review-scope-summary{min-width:0;overflow:hidden;color:var(--shiplet-muted);font-size:10px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.shiplet-review-pin-limit{margin:7px 9px 0;padding:7px 8px;border-radius:7px;background:#edf5f7;color:#245b72;font-size:10px}.shiplet-review-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 9px 10px}.shiplet-review-pagination p{margin:0;color:var(--shiplet-muted);font-size:10px}.shiplet-review-pagination .shiplet-review-page-error{flex:1;color:#8c2a1c}.shiplet-review-pagination button{min-height:36px}
.shiplet-review-list{display:grid;min-width:0;gap:6px;margin:0;padding:7px 8px 8px;list-style:none}.shiplet-review-list>li{min-width:0;padding:0;border:1px solid #d7dbe3;border-radius:8px;background:var(--shiplet-raised);color:#3a4459;overflow-wrap:anywhere;transition:border-color .14s ease,box-shadow .14s ease,background .14s ease}.shiplet-review-list>li[data-active="true"]{border-color:#a7b9c3;box-shadow:inset 2px 0 0 var(--shiplet-accent);background:#f8fbfc}.shiplet-review-thread-summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 8px;width:100%;max-width:100%;min-width:0;min-height:48px;padding:8px 9px;border:0;border-radius:7px;background:transparent;color:var(--shiplet-ink);text-align:left;cursor:pointer}.shiplet-review-thread-author{grid-column:1/3;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:800}.shiplet-review-thread-time{grid-column:3;color:var(--shiplet-muted);font-size:10px}.shiplet-review-thread-summary strong{grid-column:1;font-size:10px;color:var(--shiplet-action)}.shiplet-review-thread-summary-status{grid-column:2;color:var(--shiplet-muted);font-size:10px;font-weight:750}.shiplet-review-thread-summary-comment{grid-column:2/4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3a4459;font-size:12px}.shiplet-review-thread-summary-comment[hidden]{display:none}.shiplet-review-thread-details{display:grid;gap:8px;padding:8px 9px 9px;border-top:1px solid #e5e7eb}.shiplet-review-thread-details[hidden],.shiplet-review-form[hidden]{display:none}.shiplet-review-thread-meta{display:flex;align-items:center;justify-content:flex-start;gap:5px;flex-wrap:wrap}.shiplet-review-thread-meta>a{color:#245b72;font-size:11px;font-weight:750}.shiplet-review-provenance{font-size:10px}.shiplet-review-provenance summary{cursor:pointer;font-weight:750}.shiplet-review-provenance span{display:block;max-width:220px;margin-top:4px;overflow-wrap:anywhere;color:var(--shiplet-muted)}.shiplet-review-status-more select{position:absolute;right:0;z-index:2;width:130px;padding:6px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff}.shiplet-review-thread-comment{margin:0;font-size:13px;white-space:pre-wrap}.shiplet-review-replies{display:grid;gap:6px;margin:0;padding:0 0 0 12px;list-style:none}.shiplet-review-replies:empty{display:none}.shiplet-review-replies li{padding:7px 8px;border-left:2px solid #d7dbe3;background:#f7f8fa}.shiplet-review-reply-meta{display:flex;gap:7px;color:var(--shiplet-muted);font-size:10px}.shiplet-review-reply-author{font-weight:800;color:#3a4459}.shiplet-review-replies p{margin:3px 0 0;font-size:12px}.shiplet-review-reply-form{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:5px;padding-top:8px;border-top:1px solid #e5e7eb}.shiplet-review-reply-form textarea{min-width:0;min-height:54px;width:100%;padding:7px 8px;border:1px solid #9ca3af;border-radius:7px;background:#fff;font:inherit;resize:vertical}.shiplet-review-reply-form button{border-color:#8f321c;background:var(--shiplet-action);color:#fff}.shiplet-review-reply-form select,.shiplet-review-thread-message,.shiplet-review-composer-message{grid-column:1/-1}.shiplet-review-stale{position:fixed;right:12px;bottom:68px;z-index:2147483540;max-width:calc(100vw - 24px);border:1px solid #b8a978;border-radius:9px;background:#fff8df}
.shiplet-review-form{position:fixed;z-index:2147483530;display:grid;width:min(360px,calc(100vw - 16px));max-width:calc(100vw - 16px);margin:0;border:1px solid var(--shiplet-accent);background:var(--shiplet-surface);box-shadow:0 16px 42px rgba(32,41,58,.28),0 0 0 1px rgba(255,255,255,.75);color:var(--shiplet-ink);font:13px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}.shiplet-review-form[data-annotation-state="compact"]{grid-template-columns:minmax(0,1fr) auto;align-items:stretch;gap:0;padding:0;border-color:var(--shiplet-line);border-radius:10px;box-shadow:0 3px 8px rgba(32,41,58,.18)}.shiplet-review-form[data-annotation-state="compact"]:focus-within{border-color:var(--shiplet-accent)}.shiplet-review-form[data-annotation-state="expanded"]{gap:10px;max-height:min(520px,calc(100dvh - 16px));padding:0 12px 12px;border-radius:12px;overflow-x:hidden;overflow-y:auto}.shiplet-review-form[hidden]{display:none}
.shiplet-annotation-card-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 -12px;padding:10px 10px 9px 12px;border-bottom:1px solid #d7dbe3;background:rgba(251,249,244,.97);backdrop-filter:blur(8px)}.shiplet-annotation-card-heading{display:grid;min-width:0;gap:2px}.shiplet-annotation-card-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.shiplet-annotation-exact-context{color:var(--shiplet-muted);font:700 10px/1.3 ui-sans-serif,system-ui,sans-serif;overflow-wrap:anywhere}.shiplet-annotation-card-controls{display:flex;flex:0 0 auto;gap:5px}.shiplet-annotation-drag-handle,.shiplet-annotation-card-close{min-height:32px;padding:0 9px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-muted)}.shiplet-annotation-drag-handle{display:inline-flex;align-items:center;gap:6px;cursor:grab;touch-action:none;font:750 10px/1 ui-sans-serif,system-ui}.shiplet-annotation-drag-handle::before{content:"⠿";font-size:16px;letter-spacing:-2px}.shiplet-annotation-card-close{width:34px;padding:0;cursor:pointer;font-size:0}.shiplet-annotation-card-close::before{content:"×";font:400 20px/1 ui-sans-serif}.shiplet-review-form[data-dragging="true"] .shiplet-annotation-drag-handle{cursor:grabbing;border-color:var(--shiplet-accent);background:#e3edf2;color:var(--shiplet-accent)}
.shiplet-review-form textarea{grid-column:1;min-width:0;width:100%;min-height:46px;max-height:120px;resize:none;padding:11px 10px;border:1px solid #aeb5c2;border-radius:8px;background:#fff;color:var(--shiplet-ink);font:inherit;line-height:1.35}.shiplet-review-form textarea::placeholder{color:#748097}.shiplet-review-form textarea:focus{border-color:var(--shiplet-accent);outline:2px solid rgba(47,110,136,.18)}.shiplet-review-form[data-annotation-state="expanded"] textarea{grid-column:auto;min-height:92px;resize:vertical}.shiplet-review-composer-context{display:none}.shiplet-review-mentions{padding:7px 8px;border:1px solid #d7dbe3;border-radius:7px;background:#fff}.shiplet-review-mentions summary{cursor:pointer;font-size:11px;font-weight:700}.shiplet-review-mentions select{width:100%;margin-top:7px}.shiplet-review-capture-tools,.shiplet-review-composer-actions{display:flex;flex-wrap:wrap;gap:6px}.shiplet-review-capture-tools{padding-top:2px}.shiplet-review-composer-actions{grid-column:2;align-items:center;justify-content:flex-end}.shiplet-review-composer-actions button{min-height:40px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:8px;background:#fff;color:var(--shiplet-ink);font:750 11px/1 ui-sans-serif,system-ui;cursor:pointer}.shiplet-review-composer-actions button[type="submit"],[data-shiplet-widget-confirm]{border-color:#8f321c;background:var(--shiplet-action);color:#fff}.shiplet-review-composer-actions .shiplet-annotation-settings{width:44px;padding:0;background:var(--shiplet-surface);color:var(--shiplet-muted);font-size:0}.shiplet-annotation-settings::before{content:"⚙";font-size:24px;line-height:1}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions{align-items:stretch;flex-wrap:nowrap;gap:0}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions [data-shiplet-review-cancel-compose]{display:none}.shiplet-review-form[data-annotation-state="compact"] .shiplet-annotation-card-header,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-context,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-target,.shiplet-review-form[data-annotation-state="compact"] .shiplet-annotation-properties,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-mentions,.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-capture-tools{display:none}.shiplet-review-form[data-annotation-state="expanded"] .shiplet-review-composer-actions{grid-column:auto}.shiplet-review-form[data-annotation-state="expanded"] .shiplet-annotation-settings{display:none}.shiplet-review-target{justify-self:start;max-width:100%;min-height:28px;margin:0;padding:6px 9px;border:1px solid #9cb8c4;border-radius:999px;background:#edf5f7;color:#245b72;font-size:11px;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.shiplet-annotation-properties{margin:0;border:1px solid #d7dbe3;border-radius:8px;background:#fff;color:var(--shiplet-ink);overflow:hidden}.shiplet-annotation-properties summary{min-height:38px;padding:10px 12px;color:#3a4459;font-size:11px;font-weight:800;cursor:pointer;list-style:none}.shiplet-annotation-properties summary::after{content:"+";float:right;color:var(--shiplet-accent);font-size:16px;line-height:12px}.shiplet-annotation-properties[open] summary::after{content:"−"}.shiplet-annotation-property-rows{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 12px;margin:0;padding:10px 12px;border-top:1px solid #e5e7eb;font:11px/1.35 ui-sans-serif,system-ui,sans-serif}.shiplet-annotation-property-label{margin:0;color:var(--shiplet-muted);font-weight:700}.shiplet-annotation-property-value{min-width:0;margin:0;color:var(--shiplet-ink);text-align:right;overflow-wrap:anywhere}
.shiplet-review-annotation-editor{position:fixed;inset:0;z-index:2147483510;pointer-events:none}.shiplet-review-annotation-editor[data-drawing="true"]{z-index:2147483600;background:rgba(32,41,58,.08);pointer-events:auto}.shiplet-review-annotation-editor canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;touch-action:none}.shiplet-review-annotation-editor[data-drawing="true"] canvas{pointer-events:auto;cursor:crosshair}.shiplet-review-annotation-toolbar{position:absolute;top:14px;left:50%;display:flex;gap:8px;transform:translateX(-50%);padding:8px;border:1px solid var(--shiplet-ink);border-radius:9px;background:var(--shiplet-surface);box-shadow:0 6px 24px rgba(32,41,58,.28);pointer-events:auto}.shiplet-review-annotation-toolbar button{min-height:38px;padding:0 12px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font-weight:750}
.shiplet-widget-recovery{display:grid;gap:8px;margin:0 10px 10px;padding:10px;border:1px solid #e5b7ad;border-radius:8px;background:#f8e9e5;color:#8c2a1c}.shiplet-widget-recovery[hidden]{display:none}.shiplet-widget-recovery p{margin:0;overflow-wrap:anywhere}iframe[data-shiplet-widget-frame]{width:calc(100% - 20px);min-height:220px;margin:0 10px 10px;border:1px solid #d7dbe3;border-radius:8px;background:#fff}[data-shiplet-widget-confirmation]{display:grid;gap:8px;margin:0 10px 10px;padding:10px;border:2px solid var(--shiplet-accent);border-radius:8px;background:#fff}[data-shiplet-widget-confirmation][hidden]{display:none}[data-shiplet-widget-confirmation] h3,[data-shiplet-widget-confirmation] p{margin:0;overflow-wrap:anywhere}[data-shiplet-widget-cancel]{justify-self:start;min-height:34px;padding:0 10px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);font:700 11px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer}
.shiplet-review-form[data-annotation-state="compact"] textarea{min-height:60px;margin:0;padding:12px;border:0;border-radius:9px 0 0 9px;background:transparent}.shiplet-review-form[data-annotation-state="compact"] textarea:focus{outline:2px solid var(--shiplet-accent);outline-offset:-2px}
.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions button{min-width:44px;min-height:44px;margin:0;border:0;border-left:1px solid var(--shiplet-line);border-radius:0}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions button[type="submit"]{min-width:60px;padding:0 14px;font-size:12px}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions button:focus-visible{outline:3px solid var(--shiplet-accent);outline-offset:-3px}.shiplet-review-form[data-annotation-state="compact"] .shiplet-review-composer-actions button[type="submit"]:focus-visible{outline-color:#fff}
.shiplet-review-composer-actions .shiplet-annotation-settings:hover:not(:disabled){background:color-mix(in srgb,var(--shiplet-surface),var(--shiplet-ink) 6%);color:var(--shiplet-ink)}.shiplet-review-composer-actions .shiplet-annotation-settings:active:not(:disabled){background:color-mix(in srgb,var(--shiplet-surface),var(--shiplet-ink) 12%)}.shiplet-review-form[data-annotation-state="compact"] button[type="submit"]:hover:not(:disabled){background:color-mix(in srgb,var(--shiplet-action),var(--shiplet-ink) 12%)}.shiplet-review-form[data-annotation-state="compact"] button[type="submit"]:active:not(:disabled){background:color-mix(in srgb,var(--shiplet-action),var(--shiplet-ink) 22%)}
button:disabled{cursor:wait;opacity:.58}:focus-visible{outline:3px solid #2f6e88;outline-offset:2px}
@media (max-width:480px){#shiplet-kernel-review-panel{right:8px;bottom:8px;width:calc(100vw - 16px);max-height:min(68dvh,560px);border-radius:12px}.shiplet-contextual-thread{left:8px!important;top:8px!important;width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.shiplet-contextual-thread-close{min-width:64px;min-height:44px}.shiplet-review-launcher-dock{right:10px;bottom:10px}.shiplet-review-launcher,.shiplet-review-comments-launcher{min-height:44px}.shiplet-review-comments-launcher{width:44px}.shiplet-annotation-modebar{top:8px;width:calc(100vw - 16px);min-height:44px;justify-content:space-between}.shiplet-annotation-modebar button{min-width:44px;min-height:44px}.shiplet-review-form{width:calc(100vw - 16px);max-width:calc(100vw - 16px)}.shiplet-review-form[data-annotation-state="compact"]{grid-template-columns:minmax(0,1fr) auto}.shiplet-review-form[data-annotation-state="expanded"]{max-height:calc(100dvh - 16px)}.shiplet-review-form textarea{min-height:52px;font-size:16px}.shiplet-annotation-drag-handle,.shiplet-annotation-card-close,.shiplet-review-composer-actions button{min-width:44px;min-height:44px}.shiplet-review-presence{top:10px;left:10px;max-width:calc(100vw - 20px)}.shiplet-review-presence-summary{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.shiplet-review-head{flex-wrap:wrap}.shiplet-review-heading{flex-basis:100%}.shiplet-review-context-disclosure summary{display:flex;align-items:center;min-height:44px}.shiplet-review-actions{width:100%;justify-content:flex-end}.shiplet-review-compose{width:44px;padding:0;font-size:18px}.shiplet-review-secondary,.shiplet-review-icon,.shiplet-review-primary,.shiplet-review-thread-action,.shiplet-review-status-more summary,.shiplet-review-options summary,.shiplet-review-reply-form button,.shiplet-review-composer-actions button,.shiplet-review-capture-tools button{min-width:44px;min-height:44px}.shiplet-review-reply-form input{min-height:44px}.shiplet-review-thread-summary{min-height:52px}.shiplet-review-annotation-toolbar{top:8px;left:8px;right:8px;transform:none;justify-content:center}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}

html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]),html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) body,html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) main{background:transparent}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) #shiplet-kernel-review-panel{inset:8px 8px 72px;width:auto;max-width:none;max-height:none}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-actions{position:relative}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-page-comments-embedded{position:static;top:auto;right:auto;z-index:auto;flex:0 1 auto;max-width:100%;white-space:nowrap}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-page-comments-menu-embedded{position:absolute;top:calc(100% + 4px);right:0;z-index:34}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-contextual-thread{inset:8px;width:auto;max-height:none}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-form{left:12px!important;top:auto!important;bottom:12px;width:calc(100% - 24px);max-height:calc(100dvh - 24px)}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-target{max-width:100%;white-space:normal;border-radius:8px}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-annotation-modebar{max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-annotation-modebar button{flex-shrink:0}
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-annotation-drag-handle,
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-annotation-target-focus,
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-annotation-target-pin,
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-presence,
html[data-shiplet-embed-origin]:not([data-shiplet-embed-origin=""]) .shiplet-review-cursor-layer,
.shiplet-review-form[data-annotation-state="expanded"] .shiplet-review-quick-draw,
html[data-shiplet-embed-view="drawing"] .shiplet-review-form,
html[data-shiplet-embed-view="drawing"] .shiplet-annotation-modebar,
html[data-shiplet-embed-view="composer"] .shiplet-annotation-modebar,
html[data-shiplet-embed-view="expanded"] .shiplet-annotation-modebar{display:none!important}
.shiplet-embed-auth-status{position:fixed;inset:8px 8px 72px;margin:0;padding:12px;border:1px solid var(--shiplet-line);border-radius:10px;background:var(--shiplet-surface);color:var(--shiplet-ink);font:14px/1.4 system-ui;overflow:auto}.shiplet-embed-auth-status[hidden]{display:none}.shiplet-embed-auth-status button{min-height:44px;margin-left:8px;border:1px solid var(--shiplet-line);border-radius:7px;background:#fff;color:var(--shiplet-ink);cursor:pointer}
@media(max-width:480px){html[data-shiplet-embed-view="comments"] #shiplet-kernel-review-panel{inset:0 0 72px;border-radius:12px 12px 0 0}}

${reviewAnnotationEditorStyles()}
${reviewAttachmentDraftStyles()}
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
		template.content.appendChild(document.createRange().createContextualFragment(decodeBase64(templateBase64)));
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
