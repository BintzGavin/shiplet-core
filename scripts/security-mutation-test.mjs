import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const keepTmp = process.argv.includes("--keep-tmp");
const matchArgument = process.argv.find((argument) =>
  argument.startsWith("--match="),
);
const mutationNameMatch = matchArgument?.slice("--match=".length) ?? "";
const startAtArgument = process.argv.find((argument) =>
  argument.startsWith("--start-at="),
);
const startAt = startAtArgument
  ? Number(startAtArgument.slice("--start-at=".length))
  : 0;
if (!Number.isSafeInteger(startAt) || startAt < 0) {
  throw new Error(`Invalid security mutation start index: ${startAtArgument}`);
}

const mutations = [
  {
    name: "kernel document security middleware is bypassed",
    file: "src/index.ts",
    from: "c.res = withKernelDocumentSecurityHeaders(c.res, c.env, c.req.url, {\n      nonce,\n    });",
    to: "c.res = c.res;",
  },
  {
    name: "public URL preview assets require Shiplet credentials",
    file: "src/index.ts",
    from: '    isExternalProject(project) &&\n    (request.method === "GET" || request.method === "HEAD")',
    to: '    false &&\n    (request.method === "GET" || request.method === "HEAD")',
  },
  {
    name: "uploaded preview assets become anonymously readable",
    file: "src/index.ts",
    from: '    isExternalProject(project) &&\n    (request.method === "GET" || request.method === "HEAD")',
    to: '    true &&\n    (request.method === "GET" || request.method === "HEAD")',
  },
  {
    name: "workers.dev fallback kernel routes lose trusted document classification",
    file: "src/index.ts",
    from: "  if (isPathTenantFallbackHost(url.hostname)) {",
    to: "  if (false && isPathTenantFallbackHost(url.hostname)) {",
  },
  {
    name: "public Worker version attestation is omitted",
    file: "src/index.ts",
    from: "c.res = withWorkerVersionAttestation(c.res, c.env);",
    to: "c.res = c.res;",
  },
  {
    name: "kernel documents become frameable",
    file: "src/index.ts",
    from: "  \"object-src 'none'\",\n  \"frame-ancestors 'none'\",\n  \"form-action 'self'\",",
    to: "  \"object-src 'none'\",\n  \"frame-ancestors 'self'\",\n  \"form-action 'self'\",",
  },
  {
    name: "kernel scripts regain unsafe inline authority",
    file: "src/index.ts",
    from: '  "script-src {{SCRIPT_NONCE}}",',
    to: "  \"script-src 'unsafe-inline'\",",
  },
  {
    name: "kernel scripts regain ambient same-origin authority",
    file: "src/index.ts",
    from: '  "script-src {{SCRIPT_NONCE}}",',
    to: "  \"script-src 'self' {{SCRIPT_NONCE}}\",",
  },
  {
    name: "kernel inline event handlers are permitted",
    file: "src/index.ts",
    from: "  \"script-src-attr 'none'\",",
    to: "  \"script-src-attr 'unsafe-inline'\",",
  },
  {
    name: "trusted renderer loses nonce provenance",
    file: "src/kernel-document-nonce.ts",
    from: '\treturn `nonce="${nonce}"`;',
    to: '\treturn `data-nonce-provenance-lost="${nonce}"`;',
  },
  {
    name: "forged public kernel marker regains nonce inference",
    file: "src/index.ts",
    from: '    headers.delete("content-length");\n    return new Response(response.body, {\n      status: response.status,\n      statusText: response.statusText,\n      headers,\n    });',
    to: '    headers.delete("content-length");\n    const securedResponse = new Response(response.body, {\n      status: response.status,\n      statusText: response.statusText,\n      headers,\n    });\n    return new HTMLRewriter()\n      .on(\'script[data-shiplet-kernel-script="v1"]\', {\n        element(element) {\n          element.setAttribute("nonce", nonce);\n        },\n      })\n      .transform(securedResponse);',
  },
  {
    name: "trusted review host restores ambient origin script authority",
    file: "src/trusted-review-host.ts",
    from: "  const csp = [\n    \"default-src 'none'\",\n    `script-src 'nonce-${nonce}'`,",
    to: "  const csp = [\n    \"default-src 'none'\",\n    `script-src ${hostScriptUrl.origin}`,",
  },
  {
    name: "trusted review host script loses its matching nonce",
    file: "src/trusted-review-host.ts",
    from: '<script src="${escapeHtml(hostScriptUrl.toString())}" nonce="${nonce}" defer></script>',
    to: '<script src="${escapeHtml(hostScriptUrl.toString())}" defer></script>',
  },
  {
    name: "trusted artifact frame forces the review host color scheme",
    file: "src/trusted-review-host.ts",
    from: "iframe[data-shiplet-artifact-frame]{display:block;width:100%;height:100%;border:0;background:#fff;color-scheme:light dark}",
    to: "iframe[data-shiplet-artifact-frame]{display:block;width:100%;height:100%;border:0;background:#fff}",
  },
  {
    name: "artifact selection is enabled before the opaque channel handshake",
    file: "src/trusted-review-host.ts",
    from: '\tselectTarget.textContent = "Choose another element";\n\tselectTarget.disabled = true;',
    to: '\tselectTarget.textContent = "Choose another element";\n\tselectTarget.disabled = false;',
  },
  {
    name: "cached opaque frames lose the immediate channel offer",
    file: "src/trusted-review-host.ts",
    from: '\tif (artifact) {\n\t\tartifact.addEventListener("load", offerArtifactChannel);\n\t\tofferArtifactChannel();\n\t}\n\tif (widget) {\n\t\twidget.addEventListener("load", offerWidgetChannel);\n\t\tofferWidgetChannel();\n\t}',
    to: '\tif (artifact) artifact.addEventListener("load", offerArtifactChannel);\n\tif (widget) widget.addEventListener("load", offerWidgetChannel);',
  },
  {
    name: "opaque frame reloads return to a one-shot handshake",
    file: "src/trusted-review-host.ts",
    from: '\tif (artifact) {\n\t\tartifact.addEventListener("load", offerArtifactChannel);\n\t\tofferArtifactChannel();\n\t}\n\tif (widget) {\n\t\twidget.addEventListener("load", offerWidgetChannel);\n\t\tofferWidgetChannel();\n\t}',
    to: '\tif (artifact) {\n\t\tartifact.addEventListener("load", offerArtifactChannel, { once: true });\n\t\tofferArtifactChannel();\n\t}\n\tif (widget) {\n\t\twidget.addEventListener("load", offerWidgetChannel, { once: true });\n\t\tofferWidgetChannel();\n\t}',
  },
  {
    name: "trusted widget retry reuses a mutable frame URL",
    file: "src/trusted-review-host.ts",
    from: "\t\twidget.src = widgetFrameUrl;",
    to: "\t\twidget.src = widget.src;",
  },
  {
    name: "artifact bridge refuses a fresh same-origin channel offer",
    file: "src/trusted-artifact-bridge.ts",
    from: "\t\t\tif (hostOrigin && event.origin !== hostOrigin) return;",
    to: "\t\t\tif (hostOrigin) return;",
  },
  {
    name: "portable package validation accepts unsupported widget graphs",
    file: "src/self-owned/package.ts",
    from: "    validateRuntimeV1Widget({",
    to: "    false && validateRuntimeV1Widget({",
  },
  {
    name: "stored widget delivery accepts unsupported dependency graphs",
    file: "src/index.ts",
    from: "  return compileRuntimeV1Widget({\n    entryPath,\n    files: runtimeFiles,\n    dataUrls,\n  });",
    to: "  return compileRuntimeV1Widget({\n    entryPath,\n    files: runtimeFiles,\n    dataUrls: new Map(),\n  });",
  },
  {
    name: "widget delivery restores package script elements to the renderer",
    file: "src/self-owned/widget-runtime.ts",
    from: '      replacements.push({ start: element.start, end: element.end, value: "" });',
    to: "      replacements.push({ start: element.start, end: element.end, value: element.content });",
  },
  {
    name: "CLI widget validation ignores parsed HTML attributes",
    file: "src/cli/shiplet.cjs",
    from: "\t\tconst attributes = parseWidgetAttributes(\n\t\t\tsource.slice(nameEnd, tagEnd),\n\t\t\tfilePath,\n\t\t);",
    to: "\t\tconst attributes = new Map();",
  },
  {
    name: "static embedded review context regains executable sandbox authority",
    file: "src/trusted-review-host.ts",
    from: '    input.role === "review_context"',
    to: '    false && input.role === "review_context"',
  },
  {
    name: "custom widget renderer regains ambient inline script authority",
    file: "src/trusted-review-host.ts",
    from: "            \"sandbox allow-scripts\",\n            \"default-src 'none'\",\n            `script-src 'nonce-${nonce}'`,",
    to: '            "sandbox allow-scripts",\n            "default-src \'none\'",\n            "script-src \'unsafe-inline\'",',
  },
  {
    name: "custom widget regains evaluated-code authority",
    file: "src/trusted-review-host.ts",
    from: "            \"sandbox allow-scripts\",\n            \"default-src 'none'\",\n            `script-src 'nonce-${nonce}'`,",
    to: "            \"sandbox allow-scripts\",\n            \"default-src 'none'\",\n            `script-src 'nonce-${nonce}' 'unsafe-eval'`,",
  },
  {
    name: "custom widget inline event handlers regain execution authority",
    file: "src/trusted-review-host.ts",
    from: "            `script-src 'nonce-${nonce}'`,\n            \"script-src-attr 'none'\",",
    to: "            `script-src 'nonce-${nonce}'`,\n            \"script-src-attr 'unsafe-inline'\",",
  },
  {
    name: "custom widget Worker loses its only local bootstrap authority",
    file: "src/trusted-review-host.ts",
    from: '            "worker-src blob:",',
    to: "            \"worker-src 'none'\",",
  },
  {
    name: "custom widget Worker regains BroadcastChannel authority",
    file: "src/trusted-review-host.ts",
    from: '    "BroadcastChannel",\n    "EventSource",',
    to: '    "EventSource",',
  },
  {
    name: "custom widget Worker regains WebSocketStream authority",
    file: "src/trusted-review-host.ts",
    from: '    "WebSocket",\n    "WebSocketStream",\n    "WebTransport",',
    to: '    "WebSocket",\n    "WebTransport",',
  },
  {
    name: "custom widget Worker regains fetch authority",
    file: "src/trusted-review-host.ts",
    from: '    "Worker",\n    "XMLHttpRequest",\n    "fetch",\n    "importScripts",',
    to: '    "Worker",\n    "XMLHttpRequest",\n    "importScripts",',
  },
  {
    name: "custom widget liveness watchdog stops terminating stalled execution",
    file: "src/trusted-review-host.ts",
    from: 'heartbeatDeadline = window.setTimeout(() => failWidget("Custom widget exceeded its execution limit."), 750);',
    to: 'heartbeatDeadline = window.setTimeout(() => postWorker({ protocol: "shiplet.widget.worker.v1", type: "ping", heartbeatId }), 750);',
  },
  {
    name: "terminated custom widget hides its trusted recovery action",
    file: "src/trusted-review-host.ts",
    from: "\t\tif (restart) restart.hidden = false;",
    to: "\t\tif (restart) restart.hidden = true;",
  },
  {
    name: "runtime-v1 validation accepts aliased Worker constructors",
    file: "src/self-owned/widget-runtime.ts",
    from: '    record.type === "Identifier" &&\n    (record.name === "Worker" ||',
    to: '    false && record.type === "Identifier" &&\n    (record.name === "Worker" ||',
  },
  {
    name: "runtime-v1 validation accepts inline event handlers",
    file: "src/self-owned/widget-runtime.ts",
    from: '        ([name, attribute]) => name.startsWith("on") && attribute.value,',
    to: "        () => false,",
  },
  {
    name: "runtime-v1 validation accepts alternate SVG script sources",
    file: "src/self-owned/widget-runtime.ts",
    from: '        element.attributes.has("href") ||\n        Array.from(element.attributes).some(([name]) => name.endsWith(":href"))',
    to: "        false",
  },
  {
    name: "runtime-v1 validation accepts authored data script sources",
    file: "src/self-owned/widget-runtime.ts",
    from: "        const file = requireFile(src, entry.path);\n        if (!file) unsupported(entry.path);\n        checkScript(file);",
    to: "        const file = requireFile(src, entry.path);\n        if (file) checkScript(file);",
  },
  {
    name: "embed auth restores ambient origin script authority",
    file: "src/index.ts",
    from: "script-src 'nonce-${nonce}'; script-src-attr 'none';",
    to: "script-src ${origin}; script-src-attr 'none';",
  },
  {
    name: "embed auth script loses its matching nonce",
    file: "src/index.ts",
    from: '<script src="${origin}/api/embed/auth-bootstrap.js" nonce="${nonce}" defer></script>',
    to: '<script src="${origin}/api/embed/auth-bootstrap.js" defer></script>',
  },
  {
    name: "bootstrap authorization restores direct secret equality",
    file: "src/timing-safe-secret.ts",
    from: "\tconst [expectedDigest, presentedDigest] = await Promise.all([\n\t\tdigestSecret(expectedSecret),\n\t\tdigestSecret(presentedSecret),\n\t]);\n\treturn constantTimeEqualSha256(expectedDigest, presentedDigest);",
    to: "\treturn expectedSecret === presentedSecret;",
  },
  {
    name: "archived review notice loses same-origin frame allowance",
    file: "src/index.ts",
    from: "    frameAncestors,\n  });\n}",
    to: '    frameAncestors: "none",\n  });\n}',
  },
  {
    name: "kernel enhancement restores remote executable code",
    file: "src/render.ts",
    from: 'const EnhanceScript = (nonce: KernelDocumentNonce) => `\n<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>',
    to: 'const EnhanceScript = (nonce: KernelDocumentNonce) => `\n<script defer src="https://cdn.example.invalid/remote.js"></script>\n<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)}>',
  },
  {
    name: "raw dispatch namespace re-enables unmediated managed execution",
    file: "src/index.ts",
    from: "  // and dependency readiness attestation again.\n  return Boolean(",
    to: "  // and dependency readiness attestation again.\n  return Boolean((env as unknown as { dispatcher?: unknown }).dispatcher) || Boolean(",
  },
  {
    name: "platform cookies lose __Host prefix",
    file: "src/auth.ts",
    from: 'export const SESSION_COOKIE = "__Host-shiplet_session";',
    to: 'export const SESSION_COOKIE = "shiplet_session";',
  },
  {
    name: "https app URL uses non-secure cookie mode",
    file: "src/auth.ts",
    from: 'return new URL(env.SHIPLET_APP_URL).protocol === "https:";',
    to: 'return new URL(env.SHIPLET_APP_URL).protocol !== "https:";',
  },
  {
    name: "local Wrangler sessions rejected",
    file: "src/auth.ts",
    from: "if (appHost && isLocalDevHostname(appHost)) {\n\t\treturn true;\n\t}",
    to: "if (appHost && isLocalDevHostname(appHost)) {\n\t\treturn false;\n\t}",
  },
  {
    name: "configured app host comparison inverted",
    file: "src/auth.ts",
    from: "if (appHost) return requestHost === appHost;",
    to: "if (appHost) return requestHost !== appHost;",
  },
  {
    name: "review token signature is ignored",
    file: "src/review.ts",
    from: 'if (!signatureValid) return { ok: false, reason: "invalid_signature" };',
    to: 'if (false && !signatureValid) return { ok: false, reason: "invalid_signature" };',
  },
  {
    name: "invitation consent signature is ignored",
    file: "src/auth-consent.ts",
    from: 'if (!signatureValid) return { ok: false, reason: "invalid_signature" };',
    to: 'if (false && !signatureValid) return { ok: false, reason: "invalid_signature" };',
  },
  {
    name: "invitation consent expiry is ignored",
    file: "src/auth-consent.ts",
    from: "if (consent.expiresAt <= nowSeconds || consent.issuedAt > nowSeconds + 60) {",
    to: "if (false && (consent.expiresAt <= nowSeconds || consent.issuedAt > nowSeconds + 60)) {",
  },
  {
    name: "review token project check inverted",
    file: "src/review.ts",
    from: "if (projectId !== options.projectId) {",
    to: "if (projectId === options.projectId) {",
  },
  {
    name: "review token expiry ignored",
    file: "src/review.ts",
    from: "if (!exp || nowSeconds > exp) {",
    to: "if (false && (!exp || nowSeconds > exp)) {",
  },
  {
    name: "review token scope check ignored",
    file: "src/review.ts",
    from: 'if (missingScope) return { ok: false, reason: "missing_scope" };',
    to: 'if (false && missingScope) return { ok: false, reason: "missing_scope" };',
  },
  {
    name: "review signing reuses WorkOS secret",
    file: "src/index.ts",
    from: 'env.SHIPLET_REVIEW_TOKEN_SECRET ||\n    (env.SHIPLET_AUTH_MODE === "test"\n      ? "shiplet-test-review-capability-secret"\n      : "");',
    to: 'env.SHIPLET_REVIEW_TOKEN_SECRET ||\n    env.WORKOS_API_KEY ||\n    (env.SHIPLET_AUTH_MODE === "test"\n      ? "shiplet-test-review-capability-secret"\n      : "");',
  },
  {
    name: "artifact access cookie cannot authorize subresources",
    file: "src/index.ts",
    from: "getCookie(request, artifactAccessCookieName(request.url)) || null;",
    to: 'request.headers.get("x-missing-artifact-cookie") || null;',
  },
  {
    name: "artifact access cookie is forwarded to tenant code",
    file: "src/index.ts",
    from: "        !platformCookieNames.has(name) &&",
    to: "        true &&",
  },
  {
    name: "artifact capability is not exchanged for a host-only cookie",
    file: "src/index.ts",
    from: "if (queryCapabilityToken) {",
    to: "if (false && queryCapabilityToken) {",
  },
  {
    name: "expired artifact query capability returns a raw error",
    file: "src/index.ts",
    from: "return staleArtifactCapabilityResponse(c.req.raw);",
    to: 'throw new Response("Artifact preview capability denied", { status: 401 });',
  },
  {
    name: "idle review recovery responds to forbidden instead of expired auth",
    file: "src/review-client.ts",
    from: "status === 401 &&",
    to: "status === 403 &&",
  },
  {
    name: "idle review recovery keeps bootstrap token in the URL",
    file: "src/review-client.ts",
    from: 'url.searchParams.delete("shiplet_preview_token");',
    to: '// url.searchParams.delete("shiplet_preview_token");',
  },
  {
    name: "post-login project return is not signed",
    file: "src/index.ts",
    from: "const subdomain = projectSubdomainFromReturnTo(c.env, returnTo);",
    to: "return returnTo;\n\tconst subdomain = projectSubdomainFromReturnTo(c.env, returnTo);",
  },
  {
    name: "unsigned OAuth state overrides the consent return URL",
    file: "src/index.ts",
    from: "callbackReturnTo = verification.consent.returnTo;",
    to: "// callbackReturnTo = verification.consent.returnTo;",
  },
  {
    name: "local configured app host loses path fallback",
    file: "src/index.ts",
    from: "host === configuredAppHost &&\n        !isPathTenantFallbackHost(configuredAppHost))",
    to: "host === configuredAppHost)",
  },
  {
    name: "path tenant routing allowed on production app host",
    file: "src/index.ts",
    from: "if (!env.CUSTOM_DOMAIN) {\n    return (\n      isPathTenantFallbackHost(normalizedHost) ||\n      Boolean(configuredAppHost && isPathTenantFallbackHost(configuredAppHost))\n    );",
    to: "if (!env.CUSTOM_DOMAIN) {\n    return (\n      isPathTenantFallbackHost(normalizedHost) ||\n      Boolean(configuredAppHost)\n    );",
  },
  {
    name: "artifact-origin mutation guard disabled",
    file: "src/index.ts",
    from: '!isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin") || null, {\n      method: c.req.method,',
    to: 'false && !isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin") || null, {\n      method: c.req.method,',
  },
  {
    name: "cross-origin invitation consent is allowed",
    file: "src/index.ts",
    from: '!isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin") || null, {\n        method: "POST",\n        hasCookie: true,\n      })',
    to: 'false && !isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin") || null, {\n        method: "POST",\n        hasCookie: true,\n      })',
  },
  {
    name: "generic login silently reconciles pending invitations",
    file: "src/index.ts",
    from: '.filter((invitation) => invitation.invite_type === "organization")',
    to: ".filter(() => true)",
  },
  {
    name: "local exact-email invitation check is ignored",
    file: "src/index.ts",
    from: "invitation.email.trim().toLowerCase() !== email",
    to: "false",
  },
  {
    name: "WorkOS exact-email invitation check is ignored",
    file: "src/workos.ts",
    from: "if (invitation.email.trim().toLowerCase() !== normalizedEmail) {",
    to: "if (false && invitation.email.trim().toLowerCase() !== normalizedEmail) {",
  },
  {
    name: "WorkOS acceptance is skipped before local reconciliation",
    file: "src/index.ts",
    from: "await acceptWorkOSInvitationForUser(env, {\n      invitationId: invitation.workos_invitation_id,\n      userId: workosUser.id,\n      email,\n      organizationId: invitation.organization_id,\n    });",
    to: "await Promise.resolve();",
  },
  {
    name: "originless cookie mutations allowed",
    file: "src/index.ts",
    from: "if (!origin) return !options.hasCookie || isSafeMethod(options.method);",
    to: "if (!origin) return true;",
  },
  {
    name: "tenant review mutation exact-origin guard disabled",
    file: "src/index.ts",
    from: '  if (request.headers.get("origin") !== requestOrigin) {',
    to: '  if (false && request.headers.get("origin") !== requestOrigin) {',
  },
  {
    name: "tenant review mutation JSON media-type guard disabled",
    file: "src/index.ts",
    from: '  if (mediaType !== "application/json") {',
    to: '  if (false && mediaType !== "application/json") {',
  },
  {
    name: "local rewritten request origin rejected",
    file: "src/index.ts",
    from: "if (normalized === normalizeOrigin(requestUrl)) return true;",
    to: "if (normalized === normalizeOrigin(requestUrl)) return false;",
  },
  {
    name: "review CORS allow-origin header omitted",
    file: "src/index.ts",
    from: 'headers.set("access-control-allow-origin", origin);',
    to: '// headers.set("access-control-allow-origin", origin);',
  },
  {
    name: "custom MCP namespace drops immutable revision",
    file: "src/custom-mcp.ts",
    from: "name: `shiplet.${input.shipletId}.${input.revisionId}.${tool.name}`,",
    to: "name: `shiplet.${input.shipletId}.${tool.name}`,",
  },
  {
    name: "Code Mode custom operation drops activation generation fence",
    file: "src/index.ts",
    from: "    `${encodeURIComponent(revisionId)}/activation/` +\n    `${encodeURIComponent(String(activationGeneration))}/` +",
    to: "    `${encodeURIComponent(revisionId)}/activation/current/` +\n    `` +",
  },
  {
    name: "delegated custom MCP authority ignores selected organization",
    file: "src/index.ts",
    from: "        const organizationMatches =\n          delegatedPrincipal.organizationId !== null &&\n          project.organization_id === delegatedPrincipal.organizationId;",
    to: "        const organizationMatches = true;",
  },
  {
    name: "Code Mode custom discovery ignores declared capability authority",
    file: "src/index.ts",
    from: "      tool.requestedCapabilities.every(\n        (capability) => allowed.get(capability) === true,\n      ),",
    to: "      true,",
  },
  {
    name: "Code Mode custom result skips the post-quarantine activation fence",
    file: "src/index.ts",
    from: "  const activeAfterStaging = await activeCustomMcpFence(\n    input.env.DB,\n    custom.activePackage.shipletId,\n  );",
    to: "  const activeAfterStaging = activeAfter;",
  },
  {
    name: "custom MCP projection buffers an oversized R2 object",
    file: "src/index.ts",
    from: '    if (object.size !== input.descriptor.size) {\n      throw new Error("active_custom_mcp_projection_size_mismatch");\n    }',
    to: '    if (false) {\n      throw new Error("active_custom_mcp_projection_size_mismatch");\n    }',
  },
  {
    name: "production custom MCP grant drops activation fence",
    file: "src/index.ts",
    from: "  const invocationGrant = await custom.capabilityKernel.issueGrant({\n    actor: custom.actor,\n    shipletId: custom.activePackage.shipletId,\n    revisionId: custom.activePackage.revisionId,\n    activationFence: {\n      revisionId: custom.activePackage.revisionId,\n      generation: custom.activePackage.activationGeneration,\n    },",
    to: "  const invocationGrant = await custom.capabilityKernel.issueGrant({\n    actor: custom.actor,\n    shipletId: custom.activePackage.shipletId,\n    revisionId: custom.activePackage.revisionId,\n    activationFence: undefined,",
  },
  {
    name: "revision routes drop strict custom MCP manifest validation",
    file: "src/index.ts",
    from: "mcpManifestValidator: REVISION_MCP_MANIFEST_VALIDATOR,",
    to: "mcpManifestValidator: undefined,",
  },
  {
    name: "custom MCP actor revocation is ignored",
    file: "src/custom-mcp-authority-policy.ts",
    from: "if (!authority?.active) return false;",
    to: "if (false && !authority?.active) return false;",
  },
  {
    name: "custom MCP feedback read drops feedback scope",
    file: "src/custom-mcp-authority-policy.ts",
    from: '"mcp" as const,\n        "shiplets:read" as const,\n        "feedback:read" as const,',
    to: '"mcp" as const,\n        "shiplets:read" as const,',
  },
  {
    name: "custom MCP approver edit authority is ignored",
    file: "src/custom-mcp-authority-policy.ts",
    from: "return Boolean(authority?.active && authority.canEdit);",
    to: "return Boolean(authority?.active);",
  },
  {
    name: "D1 custom MCP grant ignores active revision generation",
    file: "src/d1-capability-kernel.ts",
    from: "project.active_revision_id = ?\n\t\t\t\t\t\t\t\tAND project.active_revision_generation = ?",
    to: "? IS NOT NULL\n\t\t\t\t\t\t\t\tAND ? IS NOT NULL",
  },
  {
    name: "first customer promotion can activate without restorable baseline",
    file: "src/self-owned/revisions.ts",
    from: 'reason: "promotion",\n          };\n          const previousDeployment = await latestHealthyDeployment(\n            db,\n            targetId,\n          );\n          if (!previousDeployment) {',
    to: 'reason: "promotion",\n          };\n          const previousDeployment = await latestHealthyDeployment(\n            db,\n            targetId,\n          );\n          if (false && !previousDeployment) {',
  },
  {
    name: "customer advanced runtime bypasses fail-closed egress prerequisite",
    file: "src/revision-deployment-coordinator.ts",
    from: 'if (bundle.modules.length > 0) {\n      failure("customer_advanced_runtime_egress_unavailable");\n    }',
    to: 'if (false && bundle.modules.length > 0) {\n      failure("customer_advanced_runtime_egress_unavailable");\n    }',
  },
  {
    name: "trusted feedback drops effect-time active revision predicate",
    file: "src/review.ts",
    from: "WHERE project.id = ? AND project.active_revision_id = ?\n\t\t   AND intent.project_id = project.id AND intent.revision_id = ?",
    to: "WHERE project.id = ? AND ? IS NOT NULL\n\t\t   AND intent.project_id = project.id AND intent.revision_id = ?",
  },
  {
    name: "public invitation projection exposes local bearer material",
    file: "src/index.ts",
    from: "accepted_on: invitation.accepted_on || null,\n  });",
    to: "accepted_on: invitation.accepted_on || null,\n    workos_invitation_token: invitation.workos_invitation_token,\n  });",
  },
  {
    name: "kernel admin audit update immutability is disabled",
    file: "src/schema.ts",
    from: "BEFORE UPDATE ON kernel_admin_audit_events\n\t\t\t BEGIN",
    to: "BEFORE UPDATE ON kernel_admin_audit_events\n\t\t\t WHEN 0\n\t\t\t BEGIN",
  },
  {
    name: "kernel admin authorization denial is mislabeled",
    file: "src/kernel-admin-audit.ts",
    from: 'outcome: "denied",\n      metadata: { reason:',
    to: 'outcome: "failed",\n      metadata: { reason:',
  },
  {
    name: "trusted top-level workflow confirmation hides exact fields",
    file: "src/index.ts",
    from: "<p>${escapeEmbedHtml(input.summary)}</p>${fieldDetails}${form}</main>",
    to: "<p>${escapeEmbedHtml(input.summary)}</p>${form}</main>",
  },
  {
    name: "CLI authorization exchange ignores PKCE verifier",
    file: "src/cli-session.ts",
    from: "(await sha256Base64Url(input.verifier)) !== row.code_challenge",
    to: "false && (await sha256Base64Url(input.verifier)) !== row.code_challenge",
  },
  {
    name: "CLI concurrent exchange reuses the millisecond timestamp as ownership marker",
    file: "src/cli-session.ts",
    from: 'const exchangeMarker = `cli_exchange_${crypto.randomUUID().replace(/-/g, "")}`;',
    to: "const exchangeMarker = nowIso;",
  },
  {
    name: "custom MCP private-state key quota accepts one extra key",
    file: "src/d1-custom-mcp-dispatcher.ts",
    from: "const MAX_STATE_KEYS_PER_NAMESPACE = 128;",
    to: "const MAX_STATE_KEYS_PER_NAMESPACE = 129;",
  },
  {
    name: "OAuth binding bypasses operated readiness",
    file: "src/index.ts",
    from: '  if (runtime.CLOUDFLARE_OAUTH_READINESS === "enabled") {\n    return bound;\n  }',
    to: '  if (runtime.CLOUDFLARE_OAUTH_READINESS !== "disabled") {\n    return bound;\n  }',
  },
  {
    name: "OAuth operator smoke ignores the exact user",
    file: "src/index.ts",
    from: '    runtime.CLOUDFLARE_OAUTH_READINESS === "operator_smoke" &&\n    runtime.CLOUDFLARE_OAUTH_SMOKE_USER_ID === userId',
    to: '    runtime.CLOUDFLARE_OAUTH_READINESS === "operator_smoke" &&\n    Boolean(runtime.CLOUDFLARE_OAUTH_SMOKE_USER_ID)',
  },
  {
    name: "OAuth finalization conflict skips compensating revoke",
    file: "src/index.ts",
    from: `      if (!recovered.compatible || !recovered.complete) {
        if (!(await compensate())) return compensationPending();
        return json({ ok: false, code: "cloudflare_connection_conflict" }, 409);
      }`,
    to: `      if (!recovered.compatible || !recovered.complete) {
        return json({ ok: false, code: "cloudflare_connection_conflict" }, 409);
      }`,
  },
  {
    name: "OAuth browser start clears rather than delivers its HttpOnly flow cookie",
    file: "src/index.ts",
    from: "      cloudflareOAuthDeliveryCookie(c.req.raw, returnKey, deliveryHandle),",
    to: "      clearCloudflareOAuthDeliveryCookie(c.req.raw, returnKey),",
  },
  {
    name: "OAuth flow cookies collapse back to one ambient browser credential",
    file: "src/index.ts",
    from: "  return `${base}_${returnKey}`;",
    to: "  return base;",
  },
  {
    name: "OAuth return re-enables the cross-site POST endpoint",
    file: "src/index.ts",
    from: 'app.post("/api/cloudflare/oauth/return", async (c) => {',
    to: 'app.put("/api/cloudflare/oauth/return", async (c) => {',
  },
  {
    name: "OAuth connection creation ignores its pre-reserved identity",
    file: "src/cloudflare-oauth.ts",
    from: "\t\t\t\t\t...(input.connectionId ? { id: input.connectionId } : {}),",
    to: "\t\t\t\t\t...{},",
  },
  {
    name: "OAuth initial exchange bypasses the recoverable credential coordinator",
    file: "src/cloudflare-oauth.ts",
    from: "\t\t\tif (dependencies.recoverableCommitConnection) {",
    to: "\t\t\tif (false && dependencies.recoverableCommitConnection) {",
  },
  {
    name: "OAuth recovery ciphertext activates before exact connection attachment",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: ") VALUES (?, ?, ?, ?, 'cleanup', NULL, ?, NULL)`,",
    to: ") VALUES (?, ?, ?, ?, 'active', NULL, ?, NULL)`,",
  },
  {
    name: "OAuth staged recovery attachment ignores the provider account binding",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t\t  AND recovery.account_id = ? AND recovery.account_label = ?",
    to: "\t\t\t\t  AND ? IS NOT NULL AND recovery.account_label = ?",
  },
  {
    name: "OAuth cleanup omits its exclusive staged-exchange claim",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: '\t\tif (row.status === "staged") {',
    to: '\t\tif (false && row.status === "staged") {',
  },
  {
    name: "OAuth credential transaction omits encrypted provider material",
    file: "src/cloudflare-support/d1-vault.ts",
    from: "      await input.db.batch([credentialInsert, connectionInsert]);",
    to: "      await credentialInsert.run();\n      await connectionInsert.run();",
  },
  {
    name: "credential continuity initialization ignores reconciliation history",
    file: "src/cloudflare-support/d1-vault.ts",
    from: "          + (SELECT COUNT(*) FROM support_reconciliation_runs)",
    to: "          + 0",
  },
  {
    name: "scheduled reconciliation records state before credential continuity",
    file: "src/cloudflare-support/support-health.ts",
    from: `  const continuity = await initializeD1CredentialContinuity({
    db: input.db,
    encodedKey: input.encodedKey,
    now: input.now,
  });
  if (!continuity.ok) {
    throw new Error("credential_continuity_unavailable");
  }`,
    to: "  const continuity = { ok: true as const };",
  },
  {
    name: "OAuth pre-state reservation stores the wrong delivery digest",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: `\t\t\tinput.expectedAccountId ?? null,
\t\t\tdeliveryHandleDigest,
\t\t\tinput.returnKey,`,
    to: `\t\t\tinput.expectedAccountId ?? null,
\t\t\t"0".repeat(64),
\t\t\tinput.returnKey,`,
  },
  {
    name: "OAuth rejected pre-state quota still runs state creation",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\tif (!reserved.ok) return reserved;",
    to: "\tif (!reserved.ok) { await input.begin(); return reserved; }",
  },
  {
    name: "OAuth final flow ignores its exact live pre-state reservation",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t\tWHERE id = ? AND status = 'reserved' AND expires_at > ?`,",
    to: "\t\t\t\tWHERE ? IS NOT NULL AND 'reserved' = 'reserved' AND ? > 0`,",
  },
  {
    name: "OAuth provider cleanup omits its durable revocation checkpoint",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t\t\t\t SET provider_revoked_on = COALESCE(provider_revoked_on, ?)",
    to: "\t\t\t\t\t\t SET provider_revoked_on = provider_revoked_on || ?",
  },
  {
    name: "OAuth cleanup reopens provider material after durable revocation",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\tif (!row.provider_revoked_on) {",
    to: "\t\tif (true) {",
  },
  {
    name: "OAuth cleanup re-retires already retired provider material",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: '\t\tif (credential.status !== "retired") {',
    to: "\t\tif (true) {",
  },
  {
    name: "expired pending OAuth authority skips orphan revocation",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: '\t\tif (connection?.status === "active") {',
    to: '\t\tif (false && connection?.status === "active") {',
  },
  {
    name: "OAuth provider authorization code exchange can be claimed twice",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t   AND expires_at > ? AND exchange_started_on IS NULL`,",
    to: "\t\t\t   AND expires_at > ?`,",
  },
  {
    name: "custom MCP reuses one Dynamic Worker across actor capabilities",
    file: "src/cloudflare-support/custom-mcp-runtime.ts",
    from: `      const worker = input.loader
        .load(code)
        .getEntrypoint(undefined, { limits: binding.limits });`,
    to: `      const worker = input.loader
        .get("custom-mcp-shared", async () => code)
        .getEntrypoint(undefined, { limits: binding.limits });`,
  },
  {
    name: "OAuth delivery lookup ignores the exact Shiplet",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: `\t\t\t WHERE delivery_handle_digest = ? AND shiplet_id = ? AND user_id = ?
\t\t\t   AND session_binding_digest = ? AND status IN ('completed', 'consumed')`,
    to: `\t\t\t WHERE delivery_handle_digest = ? AND ? IS NOT NULL AND user_id = ?
\t\t\t   AND session_binding_digest = ? AND status IN ('completed', 'consumed')`,
  },
  {
    name: "consumed OAuth acknowledgement replay expires again",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t   AND status = 'consumed'`,",
    to: "\t\t\t   AND status = 'consumed' AND delivery_expires_at > 9999999999999`,",
  },
  {
    name: "OAuth pre-state outstanding quota permits one extra start",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t) < ?\n\t\t\tAND (",
    to: "\t\t\t) <= ?\n\t\t\tAND (",
  },
  {
    name: "OAuth pre-state start-rate quota permits one extra start",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t) < ?`,",
    to: "\t\t\t) <= ?`,",
  },
  {
    name: "OAuth retention deletes consumed acknowledgement state for active connections",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: "\t\t\t         AND connection.status = 'active'",
    to: "\t\t\t         AND connection.status = 'revoked'",
  },
  {
    name: "OAuth delivery is returned without kernel acknowledgement",
    file: "src/index.ts",
    from: `      const acknowledged = await controlPlane.acknowledge({
        actor,
        shipletId: project.id,
        sessionBinding,
        deliveryHandle: delivery.deliveryHandle,
        connectionId: validated.connection.id,
      });`,
    to: "      const acknowledged = { ok: true as const };",
  },
  {
    name: "OAuth local commit omits durable acknowledgement retry",
    file: "src/index.ts",
    from: `      statements.push(
        c.env.DB.prepare(
          \`INSERT OR IGNORE INTO cloudflare_oauth_ack_outbox (`,
    to: `      if (false) statements.push(
        c.env.DB.prepare(
          \`INSERT OR IGNORE INTO cloudflare_oauth_ack_outbox (`,
  },
  {
    name: "pending OAuth acknowledgement is reported as active",
    file: "src/index.ts",
    from: 'row.connection_status === "active" && row.acknowledgement_pending',
    to: 'false && row.connection_status === "active" && row.acknowledgement_pending',
  },
  {
    name: "scheduled OAuth acknowledgement reconciliation is skipped",
    file: "src/index.ts",
    from: "    await reconcileCloudflareOAuthAcknowledgements({",
    to: "    await (async () => undefined)();\n    if (false) await reconcileCloudflareOAuthAcknowledgements({",
  },
  {
    name: "concurrent OAuth retry revokes the already committed winner",
    file: "src/index.ts",
    from: "      if (!recovered.compatible || !recovered.complete) {",
    to: "      if (true) {",
  },
  {
    name: "expired unacknowledged OAuth authority is never revoked",
    file: "src/cloudflare-support/oauth-finalization-delivery.ts",
    from: `\t\tif (!result.ok) continue;
\t\tconst updated = await input.db
\t\t\t.prepare(
\t\t\t\t\`UPDATE oauth_flows SET status = 'denied', consumed_on = ?`,
    to: `\t\tif (true) continue;
\t\tconst updated = await input.db
\t\t\t.prepare(
\t\t\t\t\`UPDATE oauth_flows SET status = 'denied', consumed_on = ?`,
  },
  {
    name: "near-expiry provider authority bypasses grant validation before refresh",
    file: "src/cloudflare-support/control-plane.ts",
    from: "  if (connection.expiresAt > input.now + 60_000) return connection;",
    to: "  if (connection.expiresAt > 0) return connection;",
  },
  {
    name: "direct customer deployment bypasses the shared static-only gate",
    file: "src/deployment-orchestrator.ts",
    from: "    if (input.revision.modules.length > 0) {",
    to: "    if (false && input.revision.modules.length > 0) {",
  },
  {
    name: "OAuth compensation falsely reports provider cleanup success",
    file: "src/index.ts",
    from: '        return compensation.ok || compensation.connection?.status === "revoked";',
    to: "        return true;",
  },
  {
    name: "revocation reconciliation exceeds its bounded batch",
    file: "src/cloudflare-support/revocation-reconciler.ts",
    from: "const MAX_REVOCATION_CLEANUP_BATCH = 25;",
    to: "const MAX_REVOCATION_CLEANUP_BATCH = 26;",
  },
  {
    name: "support-service attestation accepts a drifted Worker version",
    file: "src/cloudflare-support/service-contract.ts",
    from: "    if (candidate.versionId.toLowerCase() !== expectedVersion.toLowerCase()) {",
    to: "    if (false && candidate.versionId.toLowerCase() !== expectedVersion.toLowerCase()) {",
  },
  {
    name: "support-service attestation accepts a drifted release tag",
    file: "src/cloudflare-support/service-contract.ts",
    from: "      candidate.versionTag !== input.expectedVersionTag ||",
    to: "      false ||",
  },
  {
    name: "support-service attestation accepts reordered bindings",
    file: "src/cloudflare-support/service-contract.ts",
    from: "      candidate.service !== SUPPORT_ENTRYPOINTS[index]?.service ||",
    to: "      false ||",
  },
  {
    name: "support health omits the managed retirement schema boundary",
    file: "src/cloudflare-support/support-health.ts",
    from: '  "managed_platform_connection_retirements",\n',
    to: "",
  },
  {
    name: "support health omits the managed operation lease schema boundary",
    file: "src/cloudflare-support/support-health.ts",
    from: '  "managed_platform_operation_leases",\n',
    to: "",
  },
  {
    name: "privileged support operations bypass live attestation",
    file: "src/index.ts",
    from: "  if (!contracts.ok) {",
    to: "  if (false && !contracts.ok) {",
  },
  {
    name: "managed platform reservation UI trusts a forged query flag",
    file: "src/index.ts",
    from: "    const reserved = reservation !== null;",
    to: '    const reserved = c.req.query("reserved") === "yes";',
  },
  {
    name: "MCP promotion replay is rejected by the stale active pointer",
    file: "src/index.ts",
    from: "      !exactKernelApprovalRequestId(body.approvalRequestId) &&\n      !requestedIdempotencyKey &&\n      active?.active_revision_id !== expectedActiveRevisionId",
    to: "      !exactKernelApprovalRequestId(body.approvalRequestId) &&\n      active?.active_revision_id !== expectedActiveRevisionId",
  },
  {
    name: "MCP rollback replay is rejected by the stale active pointer",
    file: "src/index.ts",
    from: "      (!exactKernelApprovalRequestId(body.approvalRequestId) &&\n        !requestedIdempotencyKey &&\n        revisionFence?.active_revision_id !== expectedActiveRevisionId)",
    to: "      (!exactKernelApprovalRequestId(body.approvalRequestId) &&\n        revisionFence?.active_revision_id !== expectedActiveRevisionId)",
  },
  {
    name: "managed runtime state authority ignores its Shiplet namespace",
    file: "src/managed-runtime/state.ts",
    from: "        AND r.state_scope_namespace = ?\n",
    to: "        AND substr(?, 1) IS NOT NULL\n",
  },
  {
    name: "managed runtime invocation skips the live platform reservation",
    file: "workers/managed-runtime-gateway/coordinator.ts",
    from: `    normalizePlatformReservationAssertion(
      await this.#env.MANAGED_DEPLOYMENT_BROKER.assertPlatformReservation(
        expectation.deploymentBroker,
      ),
    );`,
    to: "    normalizePlatformReservationAssertion({ ok: true });",
  },
  {
    name: "pending managed activation cannot serve the exact prior revision",
    file: "workers/managed-runtime-gateway/coordinator.ts",
    from: "    if (!selected && active.operation_id) {",
    to: "    if (false && !selected && active.operation_id) {",
  },
  {
    name: "managed activation acknowledgement leaves pending authority open",
    file: "workers/managed-runtime-gateway/coordinator.ts",
    from: "      `UPDATE managed_activations SET operation_id = NULL\n",
    to: "      `UPDATE managed_activations SET operation_id = operation_id\n",
  },
  {
    name: "managed provider retry redispatches an in-flight attempt",
    file: "src/cloudflare-support/managed-deployment-broker.ts",
    from: '  if (input.row.status === "applying") return false;',
    to: '  if (input.row.status === "applying") return input.row.applying_on || false;',
  },
  {
    name: "revision preview receipt ignores its exact actor boundary",
    file: "src/self-owned/revision-preview-receipts.ts",
    from: "         AND draft_version = ? AND actor_kind = ? AND actor_id = ?\n",
    to: "         AND draft_version = ? AND ? IS NOT NULL AND ? IS NOT NULL\n",
  },
  {
    name: "revision preview receipt ignores its exact browser session",
    file: "src/self-owned/revision-preview-receipts.ts",
    from: "         AND session_binding_digest = ?\n",
    to: "         AND ? IS NOT NULL\n",
  },
  {
    name: "managed runtime deployment omits activation acknowledgement RPC",
    file: "workers/managed-runtime-gateway/index.ts",
    from: `  acknowledgeActivation(
    input: AcknowledgeActivationInput,
    expectation: ManagedRuntimeReleaseExpectation,
  ) {
    return new ManagedRuntimeCoordinator(
      coordinatorEnvironment(this.env),
    ).acknowledgeActivation(input, expectation);
  }

`,
    to: "",
  },
  {
    name: "ownership exact retry discards the original operation identity",
    file: "src/platform/ownership-controller.ts",
    from: "    if (existing) return existing;",
    to: "    if (false && existing) return existing;",
  },
  {
    name: "ownership presents an ambiguous applied operation as terminal",
    file: "src/platform/ownership-controller.ts",
    from: "      const canRetryExactly = effectStarted && exactRetryActions.has(action);",
    to: "      const canRetryExactly = false && effectStarted && exactRetryActions.has(action);",
  },
  {
    name: "managed runtime state effect ignores the exact active tuple",
    file: "src/managed-runtime/state.ts",
    from: "  const activation =\n    context.invocationKind === \"active\"\n      ? `AND EXISTS (\n           SELECT 1 FROM managed_activations a\n           WHERE a.shiplet_id = r.shiplet_id\n             AND (\n               (\n                 a.revision_id = r.revision_id\n                 AND a.package_digest = r.package_digest\n                 AND a.generation = ?\n               )\n               OR (\n                 a.operation_id IS NOT NULL\n                 AND EXISTS (\n                   SELECT 1 FROM managed_activation_history history\n                   WHERE history.id = a.operation_id\n                     AND history.shiplet_id = a.shiplet_id\n                     AND history.to_revision_id = a.revision_id\n                     AND history.to_generation = a.generation\n                     AND history.from_revision_id = r.revision_id\n                     AND history.from_generation = ?\n                 )\n                 AND EXISTS (\n                   SELECT 1 FROM managed_revisions candidate\n                   WHERE candidate.shiplet_id = a.shiplet_id\n                     AND candidate.revision_id = a.revision_id\n                     AND candidate.package_digest = a.package_digest\n                     AND candidate.script_name = a.script_name\n                     AND candidate.stage_status = 'validated'\n                 )\n               )\n             )\n         )`\n      : `AND ? = 1`;",
    to: "  const activation = `AND ? IS NOT NULL AND ? IS NOT NULL`;",
  },
  {
    name: "managed activation begin ignores the atomic active pointer comparison",
    file: "src/managed-runtime-kernel.ts",
    from: "        WHERE project.id = ? AND project.active_revision_id = ?\n",
    to: "        WHERE project.id = ? AND substr(?, 1) IS NOT NULL\n",
  },
  {
    name: "prepared managed activation permits premature pointer movement",
    file: "src/managed-runtime-kernel.ts",
    from: "               operation.status = 'prepared'\n               OR NEW.active_revision_id != operation.candidate_revision_id\n",
    to: "               false\n               OR NEW.active_revision_id != operation.candidate_revision_id\n",
  },
  {
    name: "concurrent managed staging ignores the owning lease",
    file: "workers/managed-runtime-gateway/coordinator.ts",
    from: '    if (\n      !ownsLease ||\n      persisted.stage_operation_id !== stageOperationId ||\n      persisted.stage_lease_id !== stageLeaseId\n    ) {\n      throw new Error("managed_revision_stage_in_progress");\n    }',
    to: '    if (false) {\n      throw new Error("managed_revision_stage_in_progress");\n    }',
  },
  {
    name: "managed platform retirement ignores an in-flight provider lease",
    file: "src/cloudflare-support/managed-deployment-broker.ts",
    from: "             AND NOT EXISTS (\n               SELECT 1 FROM managed_platform_operation_leases lease\n               WHERE lease.reservation_operation_id = reservation.operation_id\n                 AND lease.connection_id = reservation.connection_id\n                 AND lease.account_id = reservation.account_id\n                 AND lease.user_id = reservation.user_id\n                 AND lease.status = 'active'\n             )\n",
    to: "",
  },
  {
    name: "managed runtime preview regains write authority",
    file: "src/managed-runtime/state.ts",
    from: '  const write = invocationKind === "active" && exact.includes("write");',
    to: '  const write = exact.includes("write");',
  },
  {
    name: "managed runtime state quota accepts a 129th key",
    file: "workers/managed-runtime-gateway/migrations/0003_namespaced_state.sql",
    from: "      AND entry_count + 1 <= entry_limit",
    to: "      AND entry_count <= entry_limit",
  },
  {
    name: "temporary-account readiness gate is inverted",
    file: "src/cloudflare-runtime-composition.ts",
    from: '    bindings.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "enabled";',
    to: '    bindings.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS !== "enabled";',
  },
  {
    name: "temporary-account operator smoke ignores the exact user",
    file: "src/index.ts",
    from: '  return Boolean(\n    userId &&\n    runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "operator_smoke" &&\n    runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID === userId,\n  );',
    to: '  return Boolean(\n    userId &&\n    runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "operator_smoke" &&\n    Boolean(runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID),\n  );',
  },
  {
    name: "revocation cleanup starts before durable audit intent",
    file: "src/cloudflare-support/revocation-reconciler.ts",
    from: '    await input.audit({\n      eventKind: "cloudflare.oauth.revocation_cleanup_requested",\n      connectionId: row.connectionId,\n      outcome: "retry_started",\n      occurredAt: input.now(),\n    });',
    to: "    await Promise.resolve();",
  },
  {
    name: "locally revoked connection skips a pending provider revocation",
    file: "src/index.ts",
    from: '      existingRevocation?.status !== "pending"',
    to: "      true",
  },
  {
    name: "temporary provider reservation bypasses immutable intent audit",
    file: "src/cloudflare-support/d1-temporary-operations.ts",
    from: "    results = await input.db.batch(statements);\n  } catch (error) {\n    const consumed = await input.db\n      .prepare(\n        `SELECT 1 AS consumed FROM temporary_grant_consumptions\n         WHERE grant_digest = ? OR handle_digest = ? LIMIT 1`,\n      )\n      .bind(input.grant.grantDigest, input.grant.handleDigest)\n      .first<{ consumed: number }>();\n    if (consumed?.consumed === 1) {\n      return { ok: false as const, reason: \"temporary_grant_replayed\" };\n    }\n    throw error;\n  }\n  if (results.some((result) => result.meta.changes !== 1)) {\n    throw new Error(\"temporary_operation_intent_transaction_failed\");",
    to: "    results = await input.db.batch(statements.slice(0, -1));\n  } catch (error) {\n    const consumed = await input.db\n      .prepare(\n        `SELECT 1 AS consumed FROM temporary_grant_consumptions\n         WHERE grant_digest = ? OR handle_digest = ? LIMIT 1`,\n      )\n      .bind(input.grant.grantDigest, input.grant.handleDigest)\n      .first<{ consumed: number }>();\n    if (consumed?.consumed === 1) {\n      return { ok: false as const, reason: \"temporary_grant_replayed\" };\n    }\n    throw error;\n  }\n  if (results.some((result) => result.meta.changes !== 1)) {\n    throw new Error(\"temporary_operation_intent_transaction_failed\");",
  },
  {
    name: "revoked provider credential is lost when cleanup indexing fails",
    file: "src/cloudflare-support/d1-revocation-index.ts",
    from: "credential.status IN ('active', 'cleanup')",
    to: "credential.status = 'cleanup'",
  },
  {
    name: "provider capability ignores the exact Shiplet binding",
    file: "src/deployment-orchestrator.ts",
    from: "    authorization.shipletId === input.shipletId &&",
    to: "    true &&",
  },
  {
    name: "temporary provider capability ignores the operation journal",
    file: "src/deployment-orchestrator.ts",
    from: "    (input.operationId === undefined ||\n      authorization.operationId === input.operationId) &&",
    to: "    true &&",
  },
  {
    name: "temporary claim callback ignores the support deployment binding",
    file: "src/deployment-orchestrator.ts",
    from: "            delivery.deploymentId !== record.vaultRef ||",
    to: "            false ||",
  },
  {
    name: "scheduled temporary cleanup runs before its durable checkpoint",
    file: "src/cloudflare-support/d1-temporary-operations.ts",
    from: '    if (operation.state !== "cleanup_pending") {',
    to: '    if (false && operation.state !== "cleanup_pending") {',
  },
  {
    name: "claim redemption ignores the encrypted redirect handle record",
    file: "src/cloudflare-support/d1-temporary-operations.ts",
    from: "             AND handle_record.purpose = 'temporary_redirect_handle'",
    to: "             AND true",
  },
  {
    name: "temporary delete accepts an unconfirmed provider 404",
    file: "src/cloudflare-support/temporary-transport.ts",
    from: "        if (inspection.status !== 404) {",
    to: "        if (false && inspection.status !== 404) {",
  },
  {
    name: "prepared temporary claim accepts a different delivery event",
    file: "src/cloudflare-support/d1-temporary-operations.ts",
    from: "    row.delivery_event_id === input.deliveryEventId &&",
    to: "    true &&",
  },
  {
    name: "ambiguous temporary deployment uploads a second Worker version",
    file: "src/cloudflare-support/d1-temporary-operations.ts",
    from: '  if (input.state === "account_ready") {',
    to: "  if (true) {",
  },
  {
    name: "committed claim redirect cannot recover a lost response",
    file: "src/cloudflare-support/d1-temporary-operations.ts",
    from: "  if (row.consumed_on !== null) return location;",
    to: "  if (row.consumed_on !== null) return null;",
  },
  {
    name: "temporary deployment recovery ignores the package tag",
    file: "src/cloudflare-support/temporary-transport.ts",
    from: '      settingsResult.annotations["workers/tag"] !== request.packageDigest',
    to: "      false",
  },
  {
    name: "temporary deployment recovery accepts split traffic",
    file: "src/cloudflare-support/temporary-transport.ts",
    from: "      latest.versions.length !== 1 ||\n      !isRecord(latest.versions[0]) ||\n      latest.versions[0].percentage !== 100 ||",
    to: "      false ||\n      false ||\n      false ||",
  },
  {
    name: "agent guide drops the required MCP resource binding",
    file: "src/mcp-auth.ts",
    from: "\tbody.set(SHIPLET_AGENT_GUIDE_RESOURCE_NOTE_BYTES, offset);",
    to: "\t// Resource binding note omitted.",
  },
];

function copyHarness(destination) {
  for (const entry of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "openapi.json",
    "vitest.config.mts",
    "vitest.security-mutation.config.mts",
    "wrangler.jsonc",
    "wrangler.test.jsonc",
    "worker-configuration.d.ts",
  ]) {
    cpSync(path.join(repoRoot, entry), path.join(destination, entry));
  }

  cpSync(path.join(repoRoot, "src"), path.join(destination, "src"), {
    recursive: true,
  });
  cpSync(path.join(repoRoot, "public"), path.join(destination, "public"), {
    recursive: true,
  });
  cpSync(path.join(repoRoot, "workers"), path.join(destination, "workers"), {
    recursive: true,
  });
  cpSync(path.join(repoRoot, "test"), path.join(destination, "test"), {
    recursive: true,
  });
  symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(destination, "node_modules"),
    "dir",
  );
}

function applyMutation(workdir, mutation) {
  const filePath = path.join(workdir, mutation.file);
  const source = readFileSync(filePath, "utf8");
  const occurrences = source.split(mutation.from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.name}: expected one match in ${mutation.file}, found ${occurrences}`,
    );
  }
  writeFileSync(filePath, source.replace(mutation.from, mutation.to));
}

function runSecurityTests(workdir) {
  const reportPath = path.join(workdir, "mutation-results.json");
  let failed = false;
  try {
    execFileSync(
      "npx",
      ["vitest", "run", "--config", "vitest.security-mutation.config.mts", "--reporter=json", "--outputFile", reportPath],
      { cwd: workdir, stdio: "pipe", timeout: 90_000 },
    );
  } catch (error) {
    if (error.status !== 1 || !existsSync(reportPath)) throw error;
    failed = true;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.numTotalTests === 0 || (failed && report.numFailedTests === 0)) {
    throw new Error(`Security tests failed to execute; this is not a killed mutant\n${report.testResults.map((suite) => suite.message).filter(Boolean).join("\n")}`);
  }
  if (report.numFailedTests > 0) {
    for (const suite of report.testResults) {
      for (const test of suite.assertionResults ?? []) {
        if (test.status === "failed") console.log(`  Failed: ${test.fullName}`);
      }
    }
    return false;
  }
  return true;
}

const selectedMutations = mutations.filter(
  (mutation, index) =>
    index >= startAt &&
    (!mutationNameMatch || mutation.name.includes(mutationNameMatch)),
);
if (selectedMutations.length === 0) {
  throw new Error(`No security mutations matched: ${mutationNameMatch}`);
}

const invalidMutations = selectedMutations.flatMap((mutation) => {
  const source = readFileSync(path.join(repoRoot, mutation.file), "utf8");
  const occurrences = source.split(mutation.from).length - 1;
  return occurrences === 1
    ? []
    : [
        `${mutation.name}: expected one match in ${mutation.file}, found ${occurrences}`,
      ];
});
if (invalidMutations.length > 0) {
  throw new Error(
    `Security mutation preflight failed:\n${invalidMutations.join("\n")}`,
  );
}
if (process.argv.includes("--preflight-only")) {
  console.log(
    `Security mutation preflight passed: ${selectedMutations.length} exact mutants.`,
  );
  process.exit(0);
}

const baselineWorkdir = path.join(tmpdir(), `shiplet-security-baseline-${process.pid}`);
mkdirSync(baselineWorkdir, { recursive: true });
try {
  copyHarness(baselineWorkdir);
  if (!runSecurityTests(baselineWorkdir)) throw new Error("Security mutation baseline must pass before applying mutants");
  console.log("Security mutation baseline passed.");
} finally {
  rmSync(baselineWorkdir, { recursive: true, force: true });
}

const survivors = [];

for (const mutation of selectedMutations) {
  const workdir = path.join(
    tmpdir(),
    `shiplet-security-mutant-${process.pid}-${mutations.indexOf(mutation)}`,
  );
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });

  try {
    copyHarness(workdir);
    applyMutation(workdir, mutation);
    if (runSecurityTests(workdir)) {
      survivors.push(mutation.name);
      console.log(`SURVIVED ${mutation.name}`);
    } else {
      console.log(`KILLED   ${mutation.name}`);
    }
  } finally {
    if (!keepTmp && existsSync(workdir)) {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}

if (survivors.length > 0) {
  console.error(`\nSurviving security mutants:\n- ${survivors.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `\nSecurity mutation smoke passed: ${selectedMutations.length} killed, 0 survived.`,
);
