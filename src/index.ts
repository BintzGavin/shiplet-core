// Copyright (c) 2022 Cloudflare, Inc.
// Licensed under the APACHE LICENSE, VERSION 2.0 license found in the LICENSE file or at http://www.apache.org/licenses/LICENSE-2.0

/**
 * Shiplet
 *
 * Shiplet is a static-first multi-tenant artifact publishing and review
 * kernel. Key concepts:
 *
 * 1. MANAGED STATIC STORAGE: Each logical Shiplet stores artifact bytes in
 *    Shiplet-scoped D1/R2 records without an account-level deployment token.
 *
 * 2. D1 DATABASE: Stores project metadata (names, subdomains, custom domains).
 *    Used to look up which Worker to dispatch to based on the incoming request.
 *
 * 3. OPTIONAL RUNTIMES: Advanced Worker execution crosses separately attested
 *    support services and remains unavailable when that boundary is absent.
 *
 * 4. CUSTOM HOSTNAMES: Cloudflare for SaaS allows users to bring
 *    their own domains with automatic SSL certificate provisioning.
 *
 * 5. HONO ROUTER: Lightweight web framework for handling HTTP routes.
 *    Provides middleware support and type-safe request handling.
 */

import { Hono } from "hono";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import {
  openApiMcpServer,
  type RequestOptions as CloudflareCodeModeRequestOptions,
} from "@cloudflare/codemode/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import {
  createStandaloneAssetPreviewIndex,
  STANDALONE_ASSET_PREVIEW_MARKER,
} from "./asset-preview";
import {
  FetchTable,
  CreateProject,
  GetProjectBySubdomain,
  GetProjectByCustomHostname,
} from "./db";
import type { Env } from "./env";
import type { AssetFile } from "./resource";
import { withDb } from "./router";
import {
  renderPage,
  BuildArchivedShipletPage,
  BuildShipletAccessRequestPage,
  BuildShipletReviewPage,
  BuildSandboxPlayPage,
  HARBOR_SCENE_SVG,
} from "./render";
import {
  kernelScriptNonceAttribute,
  type KernelDocumentNonce,
} from "./kernel-document-nonce";
import { BuildPlatformFeedbackPage } from "./platform/feedback-page";
import { timingSafeSecretMatches } from "./timing-safe-secret";
import { BuildPlatformInboxPage } from "./platform/inbox-page";
import { BuildPlatformPublishPage } from "./platform/publish-page";
import {
  BuildPlatformSettingsPage,
  type SettingsRoute,
} from "./platform/settings-page";
import { BuildPlatformShipletsListPage } from "./platform/shiplets-page";
import {
  BuildOwnershipActionRequest,
  BuildOwnershipFailurePage,
  BuildShipletOwnershipPage,
  type OwnershipActionInput,
} from "./platform/ownership-page";
import { BuildOwnershipController } from "./platform/ownership-controller";
import { loadShipletOwnershipPageModel } from "./platform/ownership-data";
import { Project } from "./types";
import { reviewClientScript } from "./review-client";
import {
  createSandboxedArtifactResponse,
  createTrustedReviewHostResponse,
  trustedReviewHostScript,
  trustedReviewHostStyles,
} from "./trusted-review-host";
import {
  injectTrustedArtifactBridge,
  parseTrustedArtifactCapturePayload,
  trustedArtifactBridgeScript,
} from "./trusted-artifact-bridge";
import {
  deleteStaticAssets,
  serveStaticAsset,
  storeStaticAssets,
} from "./static-assets";
import {
  createExternalResourceUrlBuilder,
  EXTERNAL_RESOURCE_PROXY_PATH,
  MAX_EXTERNAL_RESOURCE_URL_LENGTH,
  rewriteExternalCssReferences,
  rewriteExternalHtmlReferences,
  verifiedExternalResourceTarget,
} from "./external-url-proxy";
import { inspectExternalUrlMetadata } from "./external-url-metadata";
import { rewriteExternalTextResponse } from "./external-text-rewrite";
import {
  createCloudflareExternalRewriteSpoolStore,
  sweepStaleExternalRewriteSpools,
} from "./cloudflare-external-rewrite-spool";
import {
  MAX_UPLOAD_JSON_BYTES,
  validateAndNormalizeStaticAssets,
} from "./upload-policy";
import {
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostnameStatus,
} from "./cloudflare-api";
import { D1QB } from "workers-qb";
import {
  ACCOUNT_GROUP_COOKIE,
  LEGACY_ACCOUNT_GROUP_COOKIE,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
  getAccountGroupCookie,
  createUserSessionResponse,
  getCookie,
  getSessionCookie,
  getCurrentUser,
  listCurrentAccountSessions,
  logoutResponse,
  requireCurrentUser,
  requestCanUsePlatformCookies,
  switchAccountSessionResponse,
} from "./auth";
import {
  createInvitationConsentToken,
  verifyInvitationConsentToken,
  type InvitationConsent,
} from "./auth-consent";
import { ensureSchema } from "./schema";
import {
  createRevisionService,
  ensureRevisionSchema,
  RevisionLifecycleError,
  type RevisionPackageStore,
  type RevisionKernelAuthorizationBinding,
  type ShipletActor,
} from "./self-owned/revisions";
import { migrateLegacyShipletRevision } from "./self-owned/legacy-migration";
import { createRevisionMcpManifestValidator } from "./self-owned/mcp-revision-validator";
import {
  addTrustedRevisionPreviewContext,
  parseRevisionPreviewDraftVersion,
  revisionPreviewPath,
  revisionPreviewUrl,
  type RevisionPreviewSelector,
} from "./self-owned/revision-preview";
import {
  loadRevisionPreviewReceipt,
  recordRevisionPreviewReceipt,
} from "./self-owned/revision-preview-receipts";
import {
  digestShipletPackage,
  parseShipletPackage,
  ShipletPackageError,
  type ValidatedShipletPackage,
} from "./self-owned/package";
import {
  compileRuntimeV1Widget,
  UnsupportedWidgetDependencyError,
} from "./self-owned/widget-runtime";
import {
  createD1CapabilityKernel,
  ensureCapabilityKernelSchema,
} from "./d1-capability-kernel";
import { createCapabilityBroker } from "./capability-broker";
import {
  compileVerifiedCustomMcpRegistryFiles,
  composeTrustedCustomMcpSurface,
  createCustomMcpModelBoundary,
  createCustomMcpQuarantineBroker,
  createCustomMcpRuntimeIsolationAttestationAuthority,
  createVerifiedCustomMcpRuntimeAdapter,
  type CompiledCustomMcpRegistry,
  type CompiledCustomMcpTool,
  type CustomMcpLimits,
  type CustomMcpNestedCapabilityDenialAuditEvent,
  type CustomMcpRuntimeIsolationBinding,
  type CustomMcpRuntimeIsolationPolicy,
  type CustomMcpTrustedChildMutationBinding,
  type TrustedCustomMcpSurfaceResult,
  type VerifiedCustomMcpRuntimeIsolation,
  type VerifiedCustomMcpRuntimeIsolationTransport,
} from "./custom-mcp";
import {
  ensureCanonicalEventSchema,
  legacyCanonicalStatusCategory,
} from "./canonical-review-events";
import {
  parseWorkflowSchema,
  validateWorkflowEvent,
  type ValidatedWorkflowEvent,
} from "./self-owned/workflow";
import {
  createD1CustomMcpCapabilityDispatcher,
  ensureD1CustomMcpDispatcherSchema,
} from "./d1-custom-mcp-dispatcher";
import {
  createD1CustomMcpQuarantineVault,
  ensureD1CustomMcpQuarantineSchema,
} from "./d1-custom-mcp-quarantine";
import { createCustomMcpAuthorityPolicy } from "./custom-mcp-authority-policy";
import {
  createCustomMcpApprovalConfirmationRoute,
  createCustomMcpApprovedMutationDispatcher,
  createCustomMcpTrustedChildApprovalDelegate,
  createD1CustomMcpApprovalService,
  ensureCustomMcpApprovalSchema,
  type CustomMcpApprovalService,
  type TrustedCustomMcpApprovalInvocation,
} from "./custom-mcp-approval";
import { ensureCloudflareControlPlaneSchema } from "./d1-cloudflare-control-plane";
import {
  abortManagedRuntimeActivation,
  beginManagedRuntimeActivation,
  commitManagedRuntimeActivation,
  ensureManagedRuntimeKernelSchema,
  loadManagedRuntimeActivationTerminal,
  loadManagedRuntimeInvocationBinding,
  markManagedRuntimeActivationDispatching,
  markManagedRuntimeRemoteCommitted,
} from "./managed-runtime-kernel";
import {
  compileManagedRuntimeRevision,
  ManagedRuntimeCompileError,
} from "./managed-runtime/wrapper";
import { CLOUDFLARE_OAUTH_SCOPES } from "./cloudflare-oauth";
import { reconcileCloudflareOAuthAcknowledgements } from "./cloudflare-oauth-ack-outbox";
import {
  normalizeSupportHealthAttestation,
  verifySupportEntrypointContracts,
  type ManagedRuntimeReleaseExpectation,
  type SupportEntrypointContract,
  type SupportReleaseExpectation,
} from "./cloudflare-support/service-contract";
import {
  createCloudflareCustomMcpRpcIsolation,
  createCloudflareTemporaryRpcComposition,
  resolveCloudflareDeploymentRuntime,
  type CloudflareCustomMcpRuntimeRpcBinding,
  type CloudflareDeploymentRuntimeBindings,
  type CloudflareTemporaryAccountRpcBinding,
} from "./cloudflare-runtime-composition";
import {
  createD1DeploymentRepository,
  ensureD1DeploymentRepositorySchema,
} from "./d1-deployment-repository";
import {
  createD1TemporaryDeploymentAuthorizer,
  ensureD1TemporaryDeploymentAuthoritySchema,
} from "./d1-temporary-deployment-authorizer";
import {
  createD1RevisionDeploymentPreparationStore,
  createRevisionDeploymentCoordinator,
  ensureRevisionDeploymentCoordinatorSchema,
} from "./revision-deployment-coordinator";
import {
  CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES,
  createDeploymentOrchestrator,
  hasExactCloudflareTemporaryAccountPolicyAcceptance,
  type DeploymentConnectionAuthorizer,
  type ImmutableRevisionBundle,
  type TemporaryClaimVault,
} from "./deployment-orchestrator";
import {
  acceptAppInvitation,
  archiveProject,
  canEditProject,
  canViewProject,
  claimShipletAccessRequestEmail,
  createAppInvitation,
  createOrganizationMembershipRecord,
  createOrganizationRecord,
  createShipletAccessRequest,
  createShipletGrant,
  createTeamMembership,
  createTeamRecord,
  ensureOrganizationMembershipRecord,
  findPendingInvitationById,
  findPendingInvitationsByEmail,
  findPendingInvitationsByEmailAndOrganization,
  findPendingInvitationsByEmailAndProject,
  findPendingInvitationsByProject,
  findPendingInvitationsByWorkOSInvitationId,
  findPendingInvitationsByWorkOSInvitationToken,
  getOrganizationMembership,
  getOrganizationById,
  getProjectById,
  getShipletAccessRequest,
  getShipletParticipation,
  getTeam,
  getUser,
  isProjectOwner,
  listOrganizationMentionUsers,
  listProjectsForOrganization,
  listProjectsForUser,
  listOrganizationsForUser,
  listTeamsForOrganization,
  newId,
  permanentlyDeleteProjectRecords,
  isOrganizationAdministrator,
  requireOrganizationAdministrator,
  requireOrganizationMembership,
  restoreProject,
  type AppInvitationRecord,
  type ShipletUser,
  timestamps,
  updateShipletAccessRequestEmailStatus,
  updateUserAvatar,
  upsertUser,
} from "./store";
import { deliverShipletAccessRequestEmail } from "./access-requests";
import {
  AVATAR_PRESETS,
  AVATAR_SPRITE_URL,
  validateAvatarUpdate,
} from "./avatars";
import {
  addWorkOSMembershipToTeam,
  acceptWorkOSInvitationForUser,
  authenticateWorkOSCode,
  createWorkOSOrganization,
  createWorkOSOrganizationMembership,
  createWorkOSTeam,
  findWorkOSInvitationByToken,
  getWorkOSInvitation,
  getWorkOSAuthorizationUrl,
  getWorkOSUser,
  sendWorkOSInvitation,
  type WorkOSUser,
} from "./workos";
import {
  latestWorkOSUserIdForLocalUser,
  resolveVerifiedWorkOSUser,
} from "./workos-identity";
import {
  ReviewScope,
  ReviewCapability,
  ReviewCapabilityScope,
  createReviewFeedback,
  createReviewCapabilityToken,
  createReviewReply,
  createReviewReplyWithNotifications,
  getReviewFeedback,
  getReviewScreenshot,
  listAccessibleReviewFeedback,
  listReviewFeedback,
  requireProjectReviewer,
  updateReviewStatus,
  updateReviewStatusWithNotifications,
  validateReviewFeedbackPayload,
  verifyReviewCapabilityToken,
} from "./review";
import {
  getWatchStatus,
  listNotificationsForUser,
  markNotificationRead,
  normalizeMentionInputs,
  setWatchStatus,
} from "./notifications";
import {
  authenticateOrganizationApiToken,
  canOrganizationApiTokenAccessProject,
  createOrganizationApiToken,
  listOrganizationApiTokens,
  listProjectsForOrganizationApiToken,
  requireOrganizationApiProjectAccess,
  requireOrganizationApiScope,
  requireOrganizationApiShipletCreationAccess,
  revokeOrganizationApiToken,
  type OrganizationApiScope,
  type OrganizationApiTokenRecord,
} from "./org-api-tokens";
import {
  appendKernelAdminAuditEvent,
  requireAuditedOrganizationAdministrator,
  runAuditedKernelAdminAction,
} from "./kernel-admin-audit";
import {
  approveCliAuthorizationRequest,
  createCliAuthorizationRequest,
  exchangeCliAuthorizationCode,
  revokeCliSession,
} from "./cli-session";
import { codeReadsSpec, parseCodeModeRequest } from "./codemode";
import { SHIPLET_OPENAPI_SPEC } from "./openapi";
import {
  compileReviewLayer,
  reviewLayerFileBytes,
  type ReviewLayer,
  type ReviewLayerActor,
} from "./review-layer";

type CodeModeRequestOptions = CloudflareCodeModeRequestOptions & {
  idempotencyKey?: string;
};
import { AVATAR_ASSETS } from "./generated-avatar-assets";
import { PLATFORM_CLIENT_ASSETS } from "./generated-platform-client";
import {
  ASSET_CACHE_CONTROL,
  brandAssetResponse,
  faviconSvgResponse,
  llmsResponse,
  manifestResponse,
  robotsResponse,
  sitemapResponse,
} from "./seo";
import { BuildDocsNotFoundPage, BuildDocsPage, getDocsPage } from "./docs";
import { agentRegistrationFlowResponse } from "./docs-assets";
import { whyShipletAssetResponse } from "./why-shiplet-assets";
import {
  ACCOUNT_EMAIL_SWITCHING_FLAG,
  dashboardFeatureFlags,
  useFeatureFlag,
} from "./feature-flags";
import {
  authenticateMcpOAuthPrincipal,
  authenticateMcpOAuthUser,
  mcpAuthorizationRequiredResponse,
  mcpProtectedResourceMetadataResponse,
  proxyWorkOSAgentAuthGuide,
  proxyWorkOSAuthorizationServerMetadata,
} from "./mcp-auth";
import type { AuthenticatedMcpAgentPrincipal } from "./mcp-principal";
import {
  createD1KernelApprovalService,
  type KernelApprovalAction,
  type KernelApprovalBinding,
} from "./mcp-kernel-approval";
import {
  appendEmbedRedirectParams,
  authenticateEmbedInstallation,
  consumeEmbedExchangeCode,
  createEmbedConnectionCode,
  createEmbedInstallation,
  createEmbedReviewSession,
  createEmbedReviewSessionCookieHeader,
  digestEmbedReviewOperationReceiptHandle,
  embedClientScript,
  getEmbedReviewSession,
  getEmbedInstallation,
  normalizeEmbedConnectionRequest,
  normalizeEmbedReturnUrl,
  normalizeEmbedSiteUrl,
  publicEmbedInstallation,
  readEmbedReviewSessionHandle,
  revokeEmbedInstallation,
  validateEmbedReviewSessionBinding,
} from "./embed";
import {
  SandboxSession,
  SHARED_SANDBOX_SESSION_ID,
  isSharedSandboxSessionId,
  type SandboxFeedbackInput,
  type SandboxSnapshot,
} from "./sandbox";
import { ShipletRoot } from "./shiplet-root";

export { SandboxSession } from "./sandbox";
export { ShipletRoot } from "./shiplet-root";

// Initialize Hono app with type-safe environment bindings
const app = new Hono<{
  Bindings: Env;
  Variables: { db: D1QB; kernelDocumentNonce: KernelDocumentNonce };
}>();

const RESERVED_PLATFORM_PATHS = new Set([
  ".well-known",
  "admin",
  "api",
  "app",
  "apple-touch-icon.png",
  "account",
  "access",
  "agents",
  "assets",
  "auth",
  "brand",
  "dispatch",
  "docs",
  "embed",
  "favicon.ico",
  "favicon.svg",
  "feedback",
  "init",
  "inbox",
  "llms.txt",
  "play",
  "og-image.png",
  "openapi.json",
  "projects",
  "robots.txt",
  "settings",
  "shiplets",
  "site.webmanifest",
  "sitemap.xml",
  "upload",
  "workspace",
]);
const SHIPLET_PREVIEW_TOKEN_PARAM = "shiplet_preview_token";
const ARTIFACT_ACCESS_COOKIE = "__Host-shiplet_artifact_access";
const LOCAL_ARTIFACT_ACCESS_COOKIE = "shiplet_artifact_access";

function isReviewFeedbackApiPath(pathname: string) {
  return /^\/api\/projects\/[^/]+\/(?:review-feedback|review-mention-users|review-watch|review-presence)(?:\/.*)?$/.test(
    pathname,
  );
}

function allowedReviewCorsOrigin(
  env: Env,
  requestUrl: string,
  origin: string | null,
) {
  if (!origin) return null;
  try {
    const originUrl = new URL(origin);
    const requestOrigin = new URL(requestUrl).origin;
    const appOrigin = appBaseUrl(env, requestUrl);
    if (originUrl.origin === requestOrigin || originUrl.origin === appOrigin) {
      return originUrl.origin;
    }
    if (
      originUrl.hostname === "localhost" ||
      originUrl.hostname === "127.0.0.1"
    ) {
      return originUrl.origin;
    }
    if (env.CUSTOM_DOMAIN) {
      const customDomain = env.CUSTOM_DOMAIN.toLowerCase();
      const host = originUrl.hostname.toLowerCase();
      if (host === customDomain || host.endsWith(`.${customDomain}`)) {
        return originUrl.origin;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isEmbedApiPath(pathname: string) {
  return (
    pathname === "/api/embed/client.js" ||
    pathname === "/api/embed/installations/exchange" ||
    pathname === "/api/embed/session/exchange" ||
    pathname.startsWith("/api/embed/installations/")
  );
}

function normalizeOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function controlPlaneOrigin(env: Env, requestUrl: string) {
  return normalizeOrigin(appBaseUrl(env, requestUrl));
}

function isLocalDevOrigin(origin: string) {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isControlPlaneOrigin(
  env: Env,
  requestUrl: string,
  origin: string | null,
  options: { method: string; hasCookie: boolean } = {
    method: "GET",
    hasCookie: false,
  },
) {
  if (!origin) return !options.hasCookie || isSafeMethod(options.method);
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (
    env.SHIPLET_AUTH_MODE === "test" &&
    normalized === normalizeOrigin(requestUrl)
  ) {
    return true;
  }
  const appOrigin = controlPlaneOrigin(env, requestUrl);
  if (normalized === appOrigin) return true;
  if (isLocalDevOrigin(appOrigin)) {
    if (normalized === normalizeOrigin(requestUrl)) return true;
    if (isLocalDevOrigin(normalized)) return true;
  }
  return false;
}

function isPlatformCookieAuthRoute(pathname: string, method: string) {
  if (isReviewFeedbackApiPath(pathname)) return false;
  if (
    pathname.startsWith("/api/play/") ||
    pathname === "/api/mcp" ||
    pathname === "/api/review/client.js" ||
    isEmbedApiPath(pathname) ||
    pathname.startsWith("/api/bootstrap/") ||
    pathname === "/openapi.json"
  ) {
    return false;
  }
  if (pathname.startsWith("/api/")) return true;
  if (method !== "GET" && pathname === "/projects") return true;
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    pathname.startsWith("/shiplets/")
  )
    return true;
  if (method !== "GET" && pathname === "/auth/login") return true;
  if (method !== "GET" && pathname === "/embed/connect") return true;
  if (method !== "GET" && pathname === "/auth/switch-account") return true;
  return false;
}

function hasBearerAuthorization(request: Request) {
  return /^Bearer\s+.+/i.test(request.headers.get("authorization") || "");
}

function applyReviewCorsHeaders(
  headers: Headers,
  env: Env,
  request: Request,
) {
  const origin = allowedReviewCorsOrigin(
    env,
    request.url,
    request.headers.get("origin"),
  );
  if (!origin) return;
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
}

app.use("*", async (c, next) => {
  const nonce = createKernelDocumentNonce();
  c.set("kernelDocumentNonce", nonce);
  await next();
  if (c.res.status !== 101) {
    c.res = withKernelDocumentSecurityHeaders(c.res, c.env, c.req.url, {
      nonce,
    });
    c.res = withWorkerVersionAttestation(c.res, c.env);
  }
});

app.use("*", async (c, next) => {
  await next();
  if (
    c.res.status !== 101 &&
    shouldPreventIndexing(new URL(c.req.url).pathname)
  ) {
    c.res = withNoIndexResponse(c.res);
  }
});

app.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (!isReviewFeedbackApiPath(pathname)) {
    await next();
    return;
  }

  if (c.req.method === "OPTIONS") {
    const headers = new Headers({
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers":
        c.req.header("access-control-request-headers") ||
        "content-type,authorization",
      "access-control-max-age": "86400",
    });
    applyReviewCorsHeaders(headers, c.env, c.req.raw);
    return new Response(null, { status: 204, headers });
  }

  await next();
  if (c.res.status !== 101) {
    const headers = new Headers(c.res.headers);
    applyReviewCorsHeaders(headers, c.env, c.req.raw);
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  }
});

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (
    !isPlatformCookieAuthRoute(url.pathname, c.req.method) ||
    hasBearerAuthorization(c.req.raw)
  ) {
    await next();
    return;
  }

  if (
    !isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin") || null, {
      method: c.req.method,
      hasCookie: Boolean(c.req.header("cookie")),
    })
  ) {
    return c.text("Control-plane origin required", 403);
  }
  await next();
});

/**
 * Automatically initialize database schema on first request
 */
const schemaInitialization = new WeakMap<object, Promise<void>>();

async function ensureKernelSchemas(db: D1Database) {
  await ensureSchema(db);
  await ensureRevisionSchema(db);
  await ensureCapabilityKernelSchema(db);
  await ensureCanonicalEventSchema(db);
  await ensureD1CustomMcpDispatcherSchema(db);
  await ensureD1CustomMcpQuarantineSchema(db);
  await ensureCustomMcpApprovalSchema(db);
  await ensureCloudflareControlPlaneSchema(db);
  await ensureD1DeploymentRepositorySchema(db);
  await ensureD1TemporaryDeploymentAuthoritySchema(db);
  await ensureRevisionDeploymentCoordinatorSchema(db);
  await ensureManagedRuntimeKernelSchema(db);
}

async function autoInitializeDatabase(db: D1Database): Promise<void> {
  let initialization = schemaInitialization.get(db as object);
  if (!initialization) {
    initialization = ensureKernelSchemas(db);
    schemaInitialization.set(db as object, initialization);
  }
  try {
    await initialization;
  } catch (error) {
    schemaInitialization.delete(db as object);
    throw error;
  }
}

// Enhanced withDb middleware that includes auto-initialization
const withDbAndInit = async (c: any, next: any) => {
  // First apply the original withDb middleware
  await withDb(c, async () => {
    // Auto-initialize database on first request
    if (c.env.DB) {
      await autoInitializeDatabase(c.env.DB);
    }
    await next();
  });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isResponse(error: unknown): error is Response {
  return error instanceof Response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(c: any) {
  try {
    const contentLength = Number(c.req.header("content-length") || "0");
    if (contentLength > MAX_UPLOAD_JSON_BYTES) {
      throw new Response("JSON body is too large", { status: 413 });
    }
    const text = await readRequestTextWithLimit(
      c.req.raw,
      MAX_UPLOAD_JSON_BYTES,
    );
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (isResponse(error)) throw error;
    throw new Response("Invalid JSON body", { status: 400 });
  }
}

async function readRequestTextWithLimit(request: Request, limit: number) {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > limit) {
      throw new Response("JSON body is too large", { status: 413 });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function normalizeAssetFiles(value: unknown) {
  return validateAndNormalizeStaticAssets(value);
}

function decodeState(state: string | null) {
  if (!state) return {};
  try {
    return JSON.parse(atob(state));
  } catch {
    return {};
  }
}

function appBaseUrl(env: Env, requestUrl: string) {
  if (env.SHIPLET_APP_URL) return env.SHIPLET_APP_URL.replace(/\/$/, "");
  if (env.CUSTOM_DOMAIN) return `https://${env.CUSTOM_DOMAIN}`;
  const url = new URL(requestUrl);
  return url.origin;
}

const NOINDEX_RESPONSE_PATHS = [
  "/.well-known",
  "/account",
  "/access",
  "/admin",
  "/agents",
  "/api",
  "/auth",
  "/feedback",
  "/inbox",
  "/init",
  "/openapi.json",
  "/play",
  "/projects",
  "/settings",
  "/shiplets",
  "/site.webmanifest",
  "/workspace",
  "/llms.txt",
];

function shouldPreventIndexing(pathname: string) {
  return NOINDEX_RESPONSE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

function withNoIndexResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const KERNEL_DOCUMENT_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src {{SCRIPT_NONCE}}",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

function createKernelDocumentNonce(): KernelDocumentNonce {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary) as KernelDocumentNonce;
}

function kernelDocumentNonce(c: {
  get(name: "kernelDocumentNonce"): KernelDocumentNonce;
}) {
  return c.get("kernelDocumentNonce");
}

function isKernelDocumentRequest(env: Env, requestUrl: string) {
  const url = new URL(requestUrl);
  const requestOrigin = normalizeOrigin(requestUrl);

  // Local and workers.dev hosts multiplex the trusted control plane with
  // /:shiplet path-routed content. Classify those documents by the same route
  // boundary as the router so untrusted artifact HTML never inherits kernel
  // script authority.
  if (isPathTenantFallbackHost(url.hostname)) {
    const firstPathSegment = url.pathname.split("/").filter(Boolean)[0];
    return (
      firstPathSegment === undefined ||
      RESERVED_PLATFORM_PATHS.has(firstPathSegment)
    );
  }

  return (
    requestOrigin === controlPlaneOrigin(env, requestUrl) ||
    isLocalDevOrigin(requestOrigin)
  );
}

function withKernelDocumentSecurityHeaders(
  response: Response,
  env: Env,
  requestUrl: string,
  options: {
    nonce: KernelDocumentNonce;
    knownKernelDocument?: boolean;
    frameAncestors?: "none" | "self";
  },
) {
  if (
    (!options.knownKernelDocument &&
      !isKernelDocumentRequest(env, requestUrl)) ||
    !(response.headers.get("content-type") || "")
      .toLowerCase()
      .includes("text/html")
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (new URL(requestUrl).protocol === "https:") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000; includeSubDomains",
    );
  }
  if (!headers.has("content-security-policy")) {
    const frameAncestors = options.frameAncestors || "none";
    const nonce = options.nonce;
    const csp = KERNEL_DOCUMENT_CSP.replace(
      "{{SCRIPT_NONCE}}",
      `'nonce-${nonce}'`,
    );
    headers.set(
      "content-security-policy",
      frameAncestors === "self"
        ? csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
        : csp,
    );
    headers.set(
      "x-frame-options",
      frameAncestors === "self" ? "SAMEORIGIN" : "DENY",
    );
    headers.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withWorkerVersionAttestation(response: Response, env: Env) {
  const versionId = env.CF_VERSION_METADATA?.id;
  if (
    typeof versionId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(versionId)
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-shiplet-worker-version", versionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isAllowedReturnHost(env: Env, hostname: string) {
  const customDomain = env.CUSTOM_DOMAIN?.toLowerCase();
  if (customDomain) {
    const normalizedHost = hostname.toLowerCase();
    return (
      normalizedHost === customDomain ||
      normalizedHost.endsWith(`.${customDomain}`)
    );
  }
  return false;
}

function safeReturnTo(
  env: Env,
  value: string | null | undefined,
  fallback = "/",
) {
  if (!value) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  try {
    const url = new URL(value);
    if (url.protocol === "https:" && isAllowedReturnHost(env, url.hostname)) {
      return url.toString();
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function authLoginRedirectUrl(env: Env, requestUrl: string, returnTo: string) {
  const loginUrl = new URL("/auth/login", appBaseUrl(env, requestUrl));
  loginUrl.searchParams.set("return_to", returnTo);
  return loginUrl.toString();
}

function escapeEmbedHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function embedRouteReturnTo(requestUrl: string) {
  const url = new URL(requestUrl);
  return `${url.pathname}${url.search}`;
}

function embedProjectSubdomain(siteName: string, siteUrl: string) {
  const hostname = new URL(siteUrl).hostname.replace(/^www\./i, "");
  const stem = (siteName || hostname)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45);
  return `${stem || "wordpress"}-${crypto.randomUUID().slice(0, 8)}`;
}

function renderEmbedConnectPage(options: {
  connection: ReturnType<typeof normalizeEmbedConnectionRequest> & {};
  organizations: Array<{ id: string; name: string }>;
  projects: Project[];
}) {
  const { connection, organizations, projects } = options;
  const selectedProjectId = connection.projectId || "new";
  const projectOptions = [
    `<option value="new"${selectedProjectId === "new" ? " selected" : ""}>Create a new Shiplet project</option>`,
    ...projects.map(
      (project) =>
        `<option value="${escapeEmbedHtml(project.id)}"${selectedProjectId === project.id ? " selected" : ""}>${escapeEmbedHtml(project.name)}</option>`,
    ),
  ].join("");
  const organizationOptions = organizations
    .map(
      (organization) =>
        `<option value="${escapeEmbedHtml(organization.id)}">${escapeEmbedHtml(organization.name)}</option>`,
    )
    .join("");

  return `<section class="success-card" style="max-width:720px;margin-inline:auto">
	<span class="success-card-label">WordPress connection</span>
	<h1>Connect ${escapeEmbedHtml(connection.siteName)}</h1>
	<p style="margin-top:10px">Allow this WordPress site to load Shiplet review mode on <code>${escapeEmbedHtml(connection.siteOrigin)}</code>.</p>
	<form method="post" action="/embed/connect" style="display:grid;gap:16px;margin-top:24px">
		<input type="hidden" name="site_url" value="${escapeEmbedHtml(connection.siteUrl)}">
		<input type="hidden" name="site_name" value="${escapeEmbedHtml(connection.siteName)}">
		<input type="hidden" name="return_url" value="${escapeEmbedHtml(connection.returnUrl)}">
		<input type="hidden" name="state" value="${escapeEmbedHtml(connection.state)}">
		<label style="display:grid;gap:6px">
			<strong>Shiplet project</strong>
			<select name="project_id">${projectOptions}</select>
			<small>Use one project for the whole site; feedback stays grouped by page URL.</small>
		</label>
		<label style="display:grid;gap:6px">
			<strong>Workspace for a new project</strong>
			<select name="organization_id"${organizations.length ? "" : " disabled"}>
				${organizationOptions || '<option value="">A default workspace will be created</option>'}
			</select>
		</label>
		<div class="dashboard-actions">
			<button class="btn btn-primary" type="submit">Connect WordPress site</button>
		</div>
	</form>
</section>`;
}

function projectSubdomainFromReturnTo(env: Env, returnTo: string) {
  if (!env.CUSTOM_DOMAIN) return null;
  try {
    const url = new URL(returnTo);
    if (url.protocol !== "https:") return null;
    const host = normalizeRoutingHostname(url.hostname);
    const customDomain = normalizeRoutingHostname(env.CUSTOM_DOMAIN);
    const configuredAppHost = appUrlHostname(env);
    if (host === customDomain || host === configuredAppHost) return null;
    const suffix = `.${customDomain}`;
    if (!host.endsWith(suffix)) return null;
    const subdomain = host.slice(0, -suffix.length);
    return isDnsSafeShipletSubdomain(subdomain) ? subdomain : null;
  } catch {
    return null;
  }
}

async function projectFromAuthReturnTo(
  env: Env,
  requestUrl: string,
  returnTo: string,
) {
  const normalizedReturnTo = safeReturnTo(env, returnTo, "");
  if (!normalizedReturnTo) return null;
  const subdomain = projectSubdomainFromReturnTo(env, normalizedReturnTo);
  if (subdomain) return findProjectBySubdomain(env.DB, subdomain);

  const url = new URL(normalizedReturnTo, appBaseUrl(env, requestUrl));
  const detailMatch = url.pathname.match(/^\/shiplets\/([^/]+)(?:\/|$)/);
  if (detailMatch?.[1]) {
    return getProjectById(env.DB, decodeURIComponent(detailMatch[1]));
  }
  if (!env.CUSTOM_DOMAIN) {
    const pathSubdomain = url.pathname.split("/").filter(Boolean)[0];
    if (pathSubdomain && !RESERVED_PLATFORM_PATHS.has(pathSubdomain)) {
      return findProjectBySubdomain(env.DB, pathSubdomain);
    }
  }
  return null;
}

function escapeAuthHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInvitationConsentPage(options: {
  project: Project;
  organizationName: string;
  consentToken: string;
  signedIn: boolean;
}) {
  const action = options.signedIn
    ? "Accept invitation and open Shiplet"
    : "Sign in and accept invitation";
  return `<div class="auth-stage">
	<div class="auth-scene" aria-hidden="true">${HARBOR_SCENE_SVG}</div>
	<section class="form-container auth-card" aria-labelledby="invitation-consent-title">
		<span class="success-card-label">Restricted Shiplet</span>
		<h1 id="invitation-consent-title">Review ${escapeAuthHtml(options.project.name)}</h1>
		<p>You are choosing to join <strong>${escapeAuthHtml(options.organizationName)}</strong> and open this restricted Shiplet.</p>
		<p>Continue only if you recognize this workspace. Shiplet will require the exact email address that was invited.</p>
		<form method="post" action="/auth/login">
			<input type="hidden" name="consent_token" value="${escapeAuthHtml(options.consentToken)}">
			<button class="btn btn-primary" type="submit">${action}</button>
			<a class="btn btn-secondary" href="/">Cancel</a>
		</form>
	</section>
</div>`;
}

async function invitationConsentPageResponse(c: any, consentToken: string) {
  const verification = await verifyInvitationConsentToken(c.env, consentToken);
  if (!verification.ok) {
    return c.text("Invitation consent is invalid or expired", 400);
  }
  const consent = verification.consent;
  const project = await getProjectById(c.env.DB, consent.projectId);
  const returnProject = await projectFromAuthReturnTo(
    c.env,
    c.req.url,
    consent.returnTo,
  );
  if (
    !project ||
    project.archived_on ||
    !returnProject ||
    returnProject.id !== project.id
  ) {
    return c.text("Invitation consent is invalid or expired", 400);
  }
  const organization = project.organization_id
    ? await getOrganizationById(c.env.DB, project.organization_id)
    : null;
  if (!organization) return c.text("Invitation workspace not found", 404);

  const user = await getCurrentUser(c.req.raw, c.env);
  if (user && (await canViewProject(c.env.DB, project, user.id))) {
    return c.redirect(
      await resolvePostAuthReturnTo(c, consent.returnTo, user),
      302,
    );
  }

  return c.html(
    renderPage(
      renderInvitationConsentPage({
        project,
        organizationName: organization.name,
        consentToken,
        signedIn: Boolean(user),
      }),
      {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        user,
        title: `Accept invitation to ${organization.name} | Shiplet`,
        description: "Confirm access to a restricted Shiplet.",
        canonicalPath: null,
        indexing: "noindex",
      },
    ),
  );
}

async function organizationIdForAuthReturn(
  env: Env,
  requestUrl: string,
  returnTo: string,
) {
  try {
    const appUrl = new URL(appBaseUrl(env, requestUrl));
    const target = new URL(returnTo, appUrl);
    if (target.origin !== appUrl.origin) return null;
    const match = target.pathname.match(/^\/shiplets\/([^/]+)(?:\/access)?$/);
    if (!match) return null;

    const project = await getProjectById(env.DB, decodeURIComponent(match[1]));
    if (
      !project ||
      project.visibility !== "organization" ||
      !project.organization_id
    ) {
      return null;
    }

    if (target.pathname.endsWith("/access")) {
      const artifactReturnTo = target.searchParams.get("return_to");
      if (
        artifactReturnTo &&
        !projectArtifactReturnTarget(env, requestUrl, project, artifactReturnTo)
      ) {
        return null;
      }
    }

    return project.organization_id;
  } catch {
    return null;
  }
}

async function resolvePostAuthReturnTo(
  c: any,
  returnTo: string,
  user: ShipletUser | null,
) {
  if (!user) return returnTo;
  const subdomain = projectSubdomainFromReturnTo(c.env, returnTo);
  if (!subdomain) return returnTo;
  const project = await findProjectBySubdomain(c.env.DB, subdomain);
  if (!project || !(await canViewProject(c.env.DB, project, user.id))) {
    return returnTo;
  }
  const url = new URL(returnTo);
  return issueArtifactPreviewAccessUrl(
    c.env,
    c.req.url,
    project,
    user,
    url.pathname || "/",
    url.search,
  );
}

let avatarPresetsPngCache: Uint8Array | null = null;

function avatarPresetsAssetResponse() {
  if (!avatarPresetsPngCache) {
    const binary = atob(AVATAR_ASSETS.avatarPresetsPng);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    avatarPresetsPngCache = bytes;
  }
  return new Response(avatarPresetsPngCache.slice(), {
    headers: {
      "cache-control": ASSET_CACHE_CONTROL,
      "content-length": String(avatarPresetsPngCache.byteLength),
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
    },
  });
}

function artifactRelativeUrl(project: Project) {
  return `/${project.subdomain}`;
}

function artifactAbsoluteUrl(env: Env, requestUrl: string, project: Project) {
  if (env.CUSTOM_DOMAIN) {
    return `https://${project.subdomain}.${env.CUSTOM_DOMAIN}`;
  }
  return new URL(
    artifactRelativeUrl(project),
    appBaseUrl(env, requestUrl),
  ).toString();
}

function shipletAccessGateUrl(
  env: Env,
  requestUrl: string,
  project: Project,
  returnTo?: string | null,
) {
  const url = new URL(
    `/shiplets/${encodeURIComponent(project.id)}/access`,
    appBaseUrl(env, requestUrl),
  );
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return url.toString();
}

function projectArtifactReturnTarget(
  env: Env,
  requestUrl: string,
  project: Project,
  returnTo: string | null | undefined,
) {
  if (!returnTo) return null;

  try {
    const target = new URL(returnTo);
    const targetHost = normalizeRoutingHostname(target.hostname);
    const platformHost = env.CUSTOM_DOMAIN
      ? normalizeRoutingHostname(`${project.subdomain}.${env.CUSTOM_DOMAIN}`)
      : null;
    const customHost = project.custom_hostname
      ? normalizeRoutingHostname(project.custom_hostname)
      : null;

    if (platformHost || customHost) {
      if (target.protocol !== "https:") return null;
      if (targetHost !== platformHost && targetHost !== customHost) return null;
      return target;
    }

    const appOrigin = new URL(appBaseUrl(env, requestUrl)).origin;
    const projectPath = `/${project.subdomain}`;
    if (target.origin !== appOrigin) return null;
    if (
      target.pathname !== projectPath &&
      !target.pathname.startsWith(`${projectPath}/`)
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

async function issueArtifactReturnAccessUrl(
  env: Env,
  project: Project,
  user: ShipletUser,
  target: URL,
) {
  const signedTarget = new URL(target);
  signedTarget.searchParams.set(
    SHIPLET_PREVIEW_TOKEN_PARAM,
    await issueReviewCapabilityToken(
      env,
      project,
      user,
      ["feedback:read", "feedback:write", "presence:join", "watch:write"],
      5 * 60,
    ),
  );
  return signedTarget.toString();
}

function artifactPublicUrl(env: Env, requestUrl: string, project: Project) {
  return env.CUSTOM_DOMAIN
    ? artifactAbsoluteUrl(env, requestUrl, project)
    : artifactRelativeUrl(project);
}

function publishResultPayload(
  env: Env,
  requestUrl: string,
  result: { ok: boolean; project: Project },
) {
  return {
    ...result,
    shipletUrl: artifactPublicUrl(env, requestUrl, result.project),
    artifactUrl: artifactAbsoluteUrl(env, requestUrl, result.project),
    reviewUrl: artifactPublicUrl(env, requestUrl, result.project),
    previewUrl: `/shiplets/${result.project.id}/review-host`,
    launchUrl: `/shiplets/${result.project.id}?created=1`,
  };
}

function projectArchiveStatusFromUrl(requestUrl: string) {
  return projectArchiveStatusFromValue(
    new URL(requestUrl).searchParams.get("status"),
  );
}

function projectArchiveStatusFromValue(value: unknown) {
  const status = typeof value === "string" ? value : "";
  if (status === "archived") return "archived" as const;
  if (status === "all") return "all" as const;
  return "active" as const;
}

async function requireProjectEditor(
  c: any,
  project: Project,
  user: ShipletUser,
) {
  if (!(await canEditProject(c.env.DB, project, user))) {
    throw new Response("Shiplet editor access required", { status: 403 });
  }
}

type RevisionRouteAccess = {
  actor: ShipletActor;
  authorizer: {
    authorize(binding: RevisionKernelAuthorizationBinding): Promise<{
      authorizationId: string;
      binding: RevisionKernelAuthorizationBinding;
    }>;
  };
};

function hasExplicitAuthorization(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

async function authenticateOptionalOrganizationCredential(
  db: D1Database,
  authorization: string | null | undefined,
  requiredScopes: OrganizationApiScope[] = [],
) {
  if (!hasExplicitAuthorization(authorization)) return null;
  if (/^Bearer\s+shiplet_cli_session_/i.test(authorization || "")) return null;
  const token = await authenticateOrganizationApiToken(db, authorization);
  if (!token) {
    throw new Response("Invalid or revoked authorization credential", {
      status: 401,
    });
  }
  for (const scope of requiredScopes) {
    requireOrganizationApiScope(token, scope);
  }
  return token;
}

async function requireRevisionRouteAccess(
  c: any,
  project: Project,
  mode: "read" | "write",
): Promise<RevisionRouteAccess> {
  const authorization = c.req.header("authorization");
  const token = await authenticateOptionalOrganizationCredential(
    c.env.DB,
    authorization,
    [mode === "write" ? "shiplets:write" : "shiplets:read"],
  );
  let actor: ShipletActor;
  if (token) {
    requireOrganizationApiProjectAccess(token, project);
    actor = Object.freeze({ kind: "agent", id: token.id });
  } else {
    const user = await requireCurrentUser(c);
    const allowed =
      mode === "write"
        ? await canEditProject(c.env.DB, project, user)
        : await canViewProject(c.env.DB, project, user.id);
    if (!allowed) {
      throw new Response(
        mode === "write"
          ? "Shiplet editor access required"
          : "Shiplet access denied",
        { status: 403 },
      );
    }
    actor = Object.freeze({ kind: "human", id: user.id });
  }
  const authorizationId = `revision-route:${crypto.randomUUID()}`;
  return {
    actor,
    authorizer: {
      async authorize(binding) {
        if (
          binding.shipletId !== project.id ||
          binding.actor.kind !== actor.kind ||
          binding.actor.id !== actor.id
        ) {
          throw new Error("revision_route_binding_denied");
        }
        return {
          authorizationId,
          binding: Object.freeze({
            shipletId: binding.shipletId,
            actor: Object.freeze({ ...actor }),
            action: binding.action,
          }),
        };
      },
    },
  };
}

async function revisionDraftProject(
  db: D1Database,
  draftId: string,
): Promise<Project | null> {
  return db
    .prepare(
      `SELECT project.* FROM shiplet_drafts draft
			 JOIN projects project ON project.id = draft.project_id
			 WHERE draft.id = ? LIMIT 1`,
    )
    .bind(draftId)
    .first<Project>();
}

async function revisionProject(
  db: D1Database,
  revisionId: string,
): Promise<Project | null> {
  return db
    .prepare(
      `SELECT project.* FROM shiplet_revisions revision
			 JOIN projects project ON project.id = revision.project_id
			 WHERE revision.id = ? LIMIT 1`,
    )
    .bind(revisionId)
    .first<Project>();
}

function revisionServiceFor(
  db: D1Database,
  access: RevisionRouteAccess,
  runtimeEnv?: (Env | DeploymentRuntimeEnv) & { SHIPLET_ASSETS?: R2Bucket },
) {
  const deploymentRuntime = runtimeEnv as
    | (DeploymentRuntimeEnv & { SHIPLET_ASSETS?: R2Bucket })
    | undefined;
  const provider = deploymentRuntime
    ? resolveCloudflareDeploymentRuntime(deploymentRuntime, () => Date.now())
        .customerProvider
    : undefined;
  const humanActor =
    access.actor.kind === "human"
      ? Object.freeze({ kind: "human" as const, id: access.actor.id })
      : null;
  const now = () => Date.now();
  const deploymentCoordinator =
    provider && humanActor
      ? createRevisionDeploymentCoordinator({
          repository: createD1DeploymentRepository({ db, now }),
          provider,
          connectionAuthorizer: createD1DeploymentConnectionAuthorizer({
            db,
            now,
          }),
          preparations: createD1RevisionDeploymentPreparationStore({ db }),
          loadRevisionBundle: ({ shipletId, revisionId }) =>
            immutableRevisionDeploymentBundle({
              db,
              shipletId,
              revisionId,
              packageStore: runtimeEnv?.SHIPLET_ASSETS,
            }),
          async resolveHumanActor(request) {
            if (request.shipletId.length === 0) return null;
            return humanActor;
          },
          async loadTargetGeneration({ shipletId, targetId }) {
            const row = await db
              .prepare(
                `SELECT project.deployment_target_generation AS generation
								 FROM projects project
								 JOIN deployment_targets target ON target.project_id = project.id
								 WHERE project.id = ? AND target.id = ?
								 AND target.detached_on IS NULL LIMIT 1`,
              )
              .bind(shipletId, targetId)
              .first<{ generation: number }>();
            return row?.generation ?? null;
          },
          limits: { cpuMs: 25, subRequests: 8 },
          now,
          audit: (event) =>
            recordRevisionDeploymentCoordinatorAudit(db, humanActor, event),
        })
      : undefined;
  return createRevisionService({
    db,
    kernelAuthorizer: access.authorizer,
    mcpManifestValidator: REVISION_MCP_MANIFEST_VALIDATOR,
    validationRunner: {
      async validate(input) {
        if (input.signal.aborted) {
          return { ok: false, errors: [{ code: "validation_aborted" }] };
        }
        try {
          await compileManagedRuntimeRevision({
            shipletId: input.shipletId,
            revisionId: input.draftId,
            packageDigest: `sha256:${await digestShipletPackage(input.package)}`,
            package: input.package,
          });
          return { ok: true, errors: [] };
        } catch (error) {
          if (error instanceof ManagedRuntimeCompileError) {
            return {
              ok: false,
              errors: [
                {
                  code: error.code,
                  ...(error.moduleName ? { path: error.moduleName } : {}),
                },
              ],
            };
          }
          return {
            ok: false,
            errors: [{ code: "managed_runtime_validation_failed" }],
          };
        }
      },
    },
    ...(runtimeEnv?.SHIPLET_ASSETS
      ? { packageStore: r2RevisionPackageStore(runtimeEnv.SHIPLET_ASSETS) }
      : {}),
    ...(deploymentCoordinator ? { deploymentCoordinator } : {}),
  });
}

function r2RevisionPackageStore(bucket: R2Bucket): RevisionPackageStore {
  return {
    async putText(key, value) {
      await bucket.put(key, value, {
        httpMetadata: { contentType: "application/json" },
      });
    },
    async getText(key) {
      const object = await bucket.get(key);
      return object ? object.text() : null;
    },
    async putBytes(key, value) {
      await bucket.put(key, value);
    },
  };
}

function revisionApiError(error: unknown): Response | null {
  if (error instanceof ShipletPackageError) {
    return json(
      {
        ok: false,
        code: error.code,
        ...(error.path ? { path: error.path } : {}),
      },
      400,
    );
  }
  if (!(error instanceof RevisionLifecycleError)) return null;
  const status =
    error.code === "shiplet_not_found" ||
    error.code === "draft_not_found" ||
    error.code === "revision_not_found" ||
    error.code === "active_revision_not_found"
      ? 404
      : error.code === "draft_conflict" ||
          error.code === "revision_conflict" ||
          error.code === "deployment_target_conflict" ||
          error.code === "deployment_baseline_required" ||
          error.code === "draft_not_validated" ||
          error.code === "customer_advanced_runtime_egress_unavailable"
        ? 409
        : error.code === "authorization_denied" ||
            error.code === "authorization_binding_mismatch"
          ? 403
          : error.code === "deployment_failed"
            ? 502
            : 400;
  return json({ ok: false, code: error.code }, status);
}

type CloudflareOAuthControlPlane = {
  contract?(): Promise<SupportEntrypointContract> | SupportEntrypointContract;
  health?(expectation: SupportReleaseExpectation): Promise<unknown> | unknown;
  begin(
    input: {
      actor: { kind: "human"; id: string };
      shipletId: string;
      sessionBinding: string;
      deliveryHandle: string;
      returnKey: string;
      requestedScopes: string[];
      expectedAccountId?: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<
    { ok: true; authorizationUrl: string } | { ok: false; reason: string }
  >;
  finalize(
    input: {
      actor: { kind: "human"; id: string };
      shipletId: string;
      sessionBinding: string;
      deliveryHandle: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<
    | {
        ok: true;
        shipletId: string;
        deliveryExpiresAt: number;
        connection: {
          id: string;
          userId: string;
          accountId: string;
          accountLabel: string;
          scopes: string[];
          expiresAt: number;
          status: "active";
          generation: number;
        };
      }
    | { ok: false; reason: string }
  >;
  acknowledge(
    input: {
      actor: { kind: "human"; id: string };
      shipletId: string;
      sessionBinding: string;
      deliveryHandle: string;
      connectionId: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  reservePlatformConnection?(
    input: {
      schemaVersion: "shiplet.managed-platform-reservation/v1";
      operationId: string;
      purpose: "managed_wfp_provider";
      actor: { kind: "human"; id: string };
      connectionId: string;
      accountId: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<{
    schemaVersion: "shiplet.managed-platform-reservation-proof/v1";
    operationId: string;
    purpose: "managed_wfp_provider";
    connectionId: string;
    accountId: string;
    ownerUserId: string;
    status: "active";
    reservedAt: number;
  }>;
  inspectPlatformConnection?(
    input: {
      schemaVersion: "shiplet.managed-platform-inspection/v1";
      purpose: "managed_wfp_provider";
      actor: { kind: "human"; id: string };
      connectionId: string;
      accountId: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<{
    schemaVersion: "shiplet.managed-platform-reservation-proof/v1";
    operationId: string;
    purpose: "managed_wfp_provider";
    connectionId: string;
    accountId: string;
    ownerUserId: string;
    status: "active";
    reservedAt: number;
  }>;
  retirePlatformConnection?(
    input: {
      schemaVersion: "shiplet.managed-platform-retirement/v1";
      operationId: string;
      purpose: "managed_wfp_provider";
      actor: { kind: "human"; id: string };
      reservationOperationId: string;
      connectionId: string;
      accountId: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<{
    schemaVersion: "shiplet.managed-platform-retirement-proof/v1";
    operationId: string;
    purpose: "managed_wfp_provider";
    reservationOperationId: string;
    connectionId: string;
    accountId: string;
    ownerUserId: string;
    status: "retired";
    retiredAt: number;
  }>;
  revoke(
    input: {
      actor: { kind: "human"; id: string };
      connectionId: string;
      sessionBinding: string;
    },
    expectation: SupportReleaseExpectation,
  ): Promise<
    | {
        ok: true;
        connection: {
          id: string;
          userId: string;
          accountId: string;
          status: "revoked";
          generation: number;
        };
      }
    | {
        ok: false;
        reason: string;
        connection?: {
          id: string;
          userId: string;
          accountId: string;
          status: "revoked";
          generation: number;
        };
      }
  >;
};

type CloudflareManagedRuntimeRpc = {
  contract?(): Promise<SupportEntrypointContract> | SupportEntrypointContract;
  readiness(expectation: ManagedRuntimeReleaseExpectation): Promise<unknown>;
  stageRevision(
    input: {
      actorId: string;
      shipletId: string;
      revisionId: string;
      packageDigest: string;
      mainModule: string;
      modules: readonly {
        name: string;
        mediaType: string;
        content: string;
        encoding?: "utf8" | "base64";
      }[];
      policy: { cpuMs: number; subRequests: number };
    },
    expectation: ManagedRuntimeReleaseExpectation,
  ): Promise<{ ok: true; status: "validated"; scriptName: string }>;
  promote(
    input: {
      actorId: string;
      shipletId: string;
      revisionId: string;
      packageDigest: string;
      expectedActivationGeneration: number;
    },
    expectation: ManagedRuntimeReleaseExpectation,
  ): Promise<{
    ok: true;
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  }>;
  rollback(
    input: {
      actorId: string;
      shipletId: string;
      revisionId: string;
      packageDigest: string;
      expectedActivationGeneration: number;
    },
    expectation: ManagedRuntimeReleaseExpectation,
  ): Promise<{
    ok: true;
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  }>;
  acknowledgeActivation(
    input: {
      actorId: string;
      shipletId: string;
      revisionId: string;
      packageDigest: string;
      expectedActivationGeneration: number;
      reason: "promote" | "rollback";
    },
    expectation: ManagedRuntimeReleaseExpectation,
  ): Promise<{ ok: true }>;
  invoke(
    input: {
      expected: {
        shipletId: string;
        revisionId: string;
        packageDigest: string;
        activationGeneration: number;
      };
      request: Request;
    },
    expectation: ManagedRuntimeReleaseExpectation,
  ): Promise<Response>;
  invokeValidatedRevision(
    input: {
      expected: {
        shipletId: string;
        revisionId: string;
        packageDigest: string;
        activationGeneration: number;
      };
      request: Request;
    },
    expectation: ManagedRuntimeReleaseExpectation,
  ): Promise<Response>;
};

type DeploymentRuntimeEnv = Env &
  CloudflareDeploymentRuntimeBindings & {
    CLOUDFLARE_CLAIM_VAULT?: TemporaryClaimVault;
    CLOUDFLARE_TEMPORARY_ACCOUNT_RPC?: CloudflareTemporaryAccountRpcBinding;
    CLOUDFLARE_OAUTH_CONTROL_PLANE?: CloudflareOAuthControlPlane;
    CLOUDFLARE_OAUTH_READINESS?: "disabled" | "operator_smoke" | "enabled";
    CLOUDFLARE_OAUTH_SMOKE_USER_ID?: string;
    CLOUDFLARE_CONTROL_PLANE_VERSION_ID?: string;
    CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID?: string;
    CLOUDFLARE_DENY_EGRESS_VERSION_ID?: string;
    CLOUDFLARE_SUPPORT_RELEASE_TAG?: string;
    CLOUDFLARE_MANAGED_RUNTIME_READINESS?:
      | "disabled"
      | "operator_smoke"
      | "enabled";
    CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID?: string;
    CLOUDFLARE_MANAGED_RUNTIME_OPERATOR_USER_ID?: string;
    CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS?:
      | "disabled"
      | "operator_smoke"
      | "enabled";
    CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID?: string;
    CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC?: CloudflareCustomMcpRuntimeRpcBinding;
    CLOUDFLARE_MANAGED_RUNTIME_RPC?: CloudflareManagedRuntimeRpc;
    /** Test harness only. Production arbitrary execution requires real WFP isolation. */
    CUSTOM_MCP_RUNTIME_ISOLATION?: {
      bind(
        input: CustomMcpRuntimeIsolationBinding,
      ): VerifiedCustomMcpRuntimeIsolationTransport;
    };
  };

async function attestCloudflareSupportEntrypoints(
  runtime: DeploymentRuntimeEnv,
) {
  const bindings = [
    runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE,
    runtime.CLOUDFLARE_GRANT_VAULT_RPC,
    runtime.CLOUDFLARE_TEMPORARY_ACCOUNT_RPC,
    runtime.CLOUDFLARE_VERSION_HEALTH_RPC,
    runtime.CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC,
    runtime.CLOUDFLARE_MANAGED_RUNTIME_RPC,
  ] as const;
  if (bindings.some((binding) => typeof binding?.contract !== "function")) {
    return { ok: false as const, reason: "support_contract_mismatch" as const };
  }
  try {
    const contracts = await Promise.all(
      bindings.map((binding) => binding!.contract!()),
    );
    return verifySupportEntrypointContracts({
      contracts,
      expectedControlPlaneVersionId:
        runtime.CLOUDFLARE_CONTROL_PLANE_VERSION_ID ?? "",
      expectedRuntimeGatewayVersionId:
        runtime.CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID ?? "",
      expectedVersionTag: runtime.CLOUDFLARE_SUPPORT_RELEASE_TAG ?? "",
    });
  } catch {
    return { ok: false as const, reason: "support_contract_mismatch" as const };
  }
}

async function attestCloudflareSupportHealth(runtime: DeploymentRuntimeEnv) {
  const controlPlane = runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE;
  if (typeof controlPlane?.health !== "function") {
    return { ok: false as const, reason: "support_health_mismatch" as const };
  }
  const expectation = cloudflareSupportExpectation(runtime, "control_plane");
  try {
    return normalizeSupportHealthAttestation(
      await controlPlane.health(expectation),
      expectation,
    );
  } catch {
    return { ok: false as const, reason: "support_health_mismatch" as const };
  }
}

function cloudflareSupportExpectation(
  runtime: DeploymentRuntimeEnv,
  service: "control_plane" | "runtime_gateway",
): SupportReleaseExpectation {
  return Object.freeze({
    versionId:
      service === "control_plane"
        ? (runtime.CLOUDFLARE_CONTROL_PLANE_VERSION_ID ?? "")
        : (runtime.CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID ?? ""),
    versionTag: runtime.CLOUDFLARE_SUPPORT_RELEASE_TAG ?? "",
  });
}

function cloudflareManagedRuntimeExpectation(
  runtime: DeploymentRuntimeEnv,
): ManagedRuntimeReleaseExpectation {
  return Object.freeze({
    gateway: cloudflareSupportExpectation(runtime, "runtime_gateway"),
    deploymentBroker: cloudflareSupportExpectation(runtime, "control_plane"),
    denyEgress: Object.freeze({
      versionId: runtime.CLOUDFLARE_DENY_EGRESS_VERSION_ID ?? "",
      versionTag: runtime.CLOUDFLARE_SUPPORT_RELEASE_TAG ?? "",
    }),
  });
}

function cloudflareManagedRuntimeEnabledForUser(
  runtime: DeploymentRuntimeEnv,
  userId?: string,
) {
  if (runtime.CLOUDFLARE_MANAGED_RUNTIME_READINESS === "enabled") return true;
  return Boolean(
    userId &&
    runtime.CLOUDFLARE_MANAGED_RUNTIME_READINESS === "operator_smoke" &&
    runtime.CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID === userId,
  );
}

async function cloudflareManagedRuntimeGateway(
  runtime: DeploymentRuntimeEnv,
  userId?: string,
  options: { requireDeploymentReadiness?: boolean } = {},
) {
  const gateway = runtime.CLOUDFLARE_MANAGED_RUNTIME_RPC;
  if (
    !cloudflareManagedRuntimeEnabledForUser(runtime, userId) ||
    !gateway ||
    typeof gateway.contract !== "function" ||
    typeof gateway.readiness !== "function" ||
    typeof gateway.stageRevision !== "function" ||
    typeof gateway.promote !== "function" ||
    typeof gateway.rollback !== "function" ||
    typeof gateway.acknowledgeActivation !== "function" ||
    typeof gateway.invoke !== "function" ||
    typeof gateway.invokeValidatedRevision !== "function"
  ) {
    return null;
  }
  const support = await cloudflareSupportMutationReadiness(runtime);
  if (!support.ok) return null;
  const expectation = cloudflareManagedRuntimeExpectation(runtime);
  if (options.requireDeploymentReadiness !== false) {
    try {
      const readiness = await gateway.readiness(expectation);
      if (
        !isRecord(readiness) ||
        Object.keys(readiness).sort().join(",") !== "ok" ||
        readiness.ok !== true
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return Object.freeze({ gateway, expectation });
}

async function cloudflareSupportEntrypointsReady(
  runtime: DeploymentRuntimeEnv,
) {
  return (await cloudflareSupportMutationReadiness(runtime)).ok;
}

async function cloudflareSupportMutationReadiness(
  runtime: DeploymentRuntimeEnv,
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason:
        | "support_contract_mismatch"
        | "support_health_unavailable"
        | "support_health_degraded";
    }
> {
  if (
    runtime.SHIPLET_AUTH_MODE === "test" &&
    !runtime.CLOUDFLARE_CONTROL_PLANE_VERSION_ID &&
    !runtime.CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID &&
    !runtime.CLOUDFLARE_SUPPORT_RELEASE_TAG
  ) {
    return { ok: true };
  }
  const contracts = await attestCloudflareSupportEntrypoints(runtime);
  if (!contracts.ok) {
    return { ok: false, reason: "support_contract_mismatch" };
  }
  const health = await attestCloudflareSupportHealth(runtime);
  if (!health.ok) {
    return { ok: false, reason: "support_health_unavailable" };
  }
  if (health.health.status !== "healthy") {
    return { ok: false, reason: "support_health_degraded" };
  }
  return { ok: true };
}

function cloudflareSupportContractMismatchResponse() {
  return json({ ok: false, code: "cloudflare_support_contract_mismatch" }, 503);
}

function cloudflareSupportMutationUnavailableResponse(
  readiness: Exclude<
    Awaited<ReturnType<typeof cloudflareSupportMutationReadiness>>,
    { ok: true }
  >,
) {
  return json(
    {
      ok: false,
      code: cloudflareSupportMutationFailureCode(readiness),
    },
    503,
  );
}

function cloudflareSupportMutationFailureCode(
  readiness: Exclude<
    Awaited<ReturnType<typeof cloudflareSupportMutationReadiness>>,
    { ok: true }
  >,
) {
  return readiness.reason === "support_contract_mismatch"
    ? "cloudflare_support_contract_mismatch"
    : readiness.reason === "support_health_degraded"
      ? "cloudflare_support_health_degraded"
      : "cloudflare_support_health_unavailable";
}

function cloudflareOAuthControlPlaneBinding(runtime: DeploymentRuntimeEnv) {
  const controlPlane = runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE;
  if (
    !controlPlane ||
    typeof controlPlane.begin !== "function" ||
    typeof controlPlane.finalize !== "function" ||
    typeof controlPlane.acknowledge !== "function" ||
    typeof controlPlane.revoke !== "function"
  ) {
    return null;
  }
  const expectation = cloudflareSupportExpectation(runtime, "control_plane");
  const bound = Object.freeze({
    begin: (input: Parameters<CloudflareOAuthControlPlane["begin"]>[0]) =>
      controlPlane.begin(input, expectation),
    finalize: (input: Parameters<CloudflareOAuthControlPlane["finalize"]>[0]) =>
      controlPlane.finalize(input, expectation),
    acknowledge: (
      input: Parameters<CloudflareOAuthControlPlane["acknowledge"]>[0],
    ) => controlPlane.acknowledge(input, expectation),
    revoke: (input: Parameters<CloudflareOAuthControlPlane["revoke"]>[0]) =>
      controlPlane.revoke(input, expectation),
  });
  return bound;
}

function cloudflareOAuthControlPlaneForUser(
  runtime: DeploymentRuntimeEnv,
  userId: string,
) {
  const bound = cloudflareOAuthControlPlaneBinding(runtime);
  if (!bound) return null;
  if (runtime.CLOUDFLARE_OAUTH_READINESS === "enabled") {
    return bound;
  }
  if (
    runtime.CLOUDFLARE_OAUTH_READINESS === "operator_smoke" &&
    runtime.CLOUDFLARE_OAUTH_SMOKE_USER_ID === userId
  ) {
    return bound;
  }
  return null;
}

function cloudflareOAuthUnavailableCode(runtime: DeploymentRuntimeEnv) {
  return runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE
    ? "cloudflare_oauth_not_verified"
    : "cloudflare_oauth_prerequisite";
}

function cloudflareTemporaryAccountsReadyForUser(
  runtime: DeploymentRuntimeEnv,
  userId?: string,
) {
  if (runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "enabled") {
    return true;
  }
  return Boolean(
    userId &&
    runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS === "operator_smoke" &&
    runtime.CLOUDFLARE_TEMPORARY_ACCOUNTS_SMOKE_USER_ID === userId,
  );
}

function resolveCloudflareRequestRuntime(
  runtimeEnv: DeploymentRuntimeEnv,
  temporaryActorId?: string,
) {
  const effectiveRuntimeEnv: DeploymentRuntimeEnv = {
    ...runtimeEnv,
    CLOUDFLARE_TEMPORARY_ACCOUNTS_READINESS:
      cloudflareTemporaryAccountsReadyForUser(runtimeEnv, temporaryActorId)
        ? "enabled"
        : "disabled",
  };
  let temporary:
    | ReturnType<typeof createCloudflareTemporaryRpcComposition>
    | undefined;
  if (
    effectiveRuntimeEnv.CLOUDFLARE_TEMPORARY_ACCOUNT_RPC &&
    effectiveRuntimeEnv.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN
  ) {
    try {
      temporary = createCloudflareTemporaryRpcComposition({
        rpc: effectiveRuntimeEnv.CLOUDFLARE_TEMPORARY_ACCOUNT_RPC,
        trustedControlPlaneOrigin:
          effectiveRuntimeEnv.CLOUDFLARE_TRUSTED_CONTROL_PLANE_ORIGIN,
        expectation: cloudflareSupportExpectation(
          effectiveRuntimeEnv,
          "control_plane",
        ),
      });
    } catch {
      temporary = undefined;
    }
  }
  const deployment = resolveCloudflareDeploymentRuntime(
    temporary
      ? {
          ...effectiveRuntimeEnv,
          CLOUDFLARE_TEMPORARY_ACCOUNT_BROKER: temporary.broker,
        }
      : effectiveRuntimeEnv,
    () => Date.now(),
  );
  return Object.freeze({
    deployment,
    claimVault:
      effectiveRuntimeEnv.CLOUDFLARE_CLAIM_VAULT ?? temporary?.claimVault,
  });
}

async function cloudflareOAuthSessionBinding(input: {
  request: Request;
  env: Env;
  userId: string;
}) {
  const sessionId = getSessionCookie(input.request, input.env);
  if (!sessionId && input.env.SHIPLET_AUTH_MODE !== "test") {
    throw new Response("Authentication session required", { status: 401 });
  }
  return sha256HexText(
    sessionId
      ? `shiplet-session:${sessionId}`
      : `shiplet-test-actor:${input.userId}`,
  );
}

async function revisionPreviewSessionBinding(input: {
  request: Request;
  env: Env;
  userId: string;
}) {
  const sessionId = getSessionCookie(input.request, input.env);
  if (!sessionId && input.env.SHIPLET_AUTH_MODE !== "test") {
    throw new Response("Authentication session required", { status: 401 });
  }
  return sha256HexText(
    sessionId
      ? `shiplet-preview-session:${sessionId}`
      : `shiplet-preview-test-actor:${input.userId}`,
  );
}

function cloudflareAuthorizationUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8_192) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "dash.cloudflare.com" ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

const CLOUDFLARE_CONTROL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CLOUDFLARE_OAUTH_DELIVERY_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const CLOUDFLARE_OAUTH_RETURN_KEY = /^[A-Za-z0-9_-]{22}$/;
const CLOUDFLARE_OAUTH_DELIVERY_COOKIE =
  "__Host-shiplet_cloudflare_oauth_delivery";
const CLOUDFLARE_OAUTH_DELIVERY_COOKIE_LOCAL =
  "shiplet_cloudflare_oauth_delivery";
const CLOUDFLARE_OAUTH_DELIVERY_COOKIE_MAX_AGE = 10 * 60;
const CLOUDFLARE_CUSTOMER_SCOPES = Object.freeze([
  CLOUDFLARE_OAUTH_SCOPES.workerScriptRead,
  CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite,
]);

function newCloudflareOAuthDeliveryHandle() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function newCloudflareOAuthReturnKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function cloudflareOAuthDeliveryCookieName(
  request: Request,
  returnKey: string,
) {
  if (!CLOUDFLARE_OAUTH_RETURN_KEY.test(returnKey)) {
    throw new TypeError("cloudflare_oauth_return_key_invalid");
  }
  const base =
    new URL(request.url).protocol === "https:"
      ? CLOUDFLARE_OAUTH_DELIVERY_COOKIE
      : CLOUDFLARE_OAUTH_DELIVERY_COOKIE_LOCAL;
  return `${base}_${returnKey}`;
}

function cloudflareOAuthDeliveryCookie(
  request: Request,
  returnKey: string,
  handle: string,
) {
  const secure = new URL(request.url).protocol === "https:";
  return `${cloudflareOAuthDeliveryCookieName(request, returnKey)}=${encodeURIComponent(handle)}; Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax; Max-Age=${CLOUDFLARE_OAUTH_DELIVERY_COOKIE_MAX_AGE}`;
}

function clearCloudflareOAuthDeliveryCookie(
  request: Request,
  returnKey: string,
) {
  const secure = new URL(request.url).protocol === "https:";
  return `${cloudflareOAuthDeliveryCookieName(request, returnKey)}=; Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax; Max-Age=0`;
}

type ValidatedCloudflareConnection = {
  id: string;
  userId: string;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  expiresAt: number;
  status: "active";
  generation: number;
};

function validatedCloudflareFinalizeResult(
  value: unknown,
  input: { userId: string; now: number },
):
  | {
      ok: true;
      shipletId: string;
      deliveryExpiresAt: number;
      connection: ValidatedCloudflareConnection;
    }
  | { ok: false; code: "cross_user" | "invalid_result" } {
  if (!isRecord(value) || value.ok !== true) {
    return { ok: false, code: "invalid_result" };
  }
  const connection = value.connection;
  if (!isRecord(connection)) {
    return { ok: false, code: "invalid_result" };
  }
  if (connection.userId !== input.userId) {
    return { ok: false, code: "cross_user" };
  }
  const scopes = Array.isArray(connection.scopes)
    ? [...new Set(connection.scopes)]
    : [];
  const expectedScopes = [...CLOUDFLARE_CUSTOMER_SCOPES].sort();
  if (
    typeof value.shipletId !== "string" ||
    !CLOUDFLARE_CONTROL_IDENTIFIER.test(value.shipletId) ||
    !Number.isSafeInteger(value.deliveryExpiresAt) ||
    (value.deliveryExpiresAt as number) <= input.now ||
    typeof connection.id !== "string" ||
    !CLOUDFLARE_CONTROL_IDENTIFIER.test(connection.id) ||
    typeof connection.accountId !== "string" ||
    !CLOUDFLARE_CONTROL_IDENTIFIER.test(connection.accountId) ||
    typeof connection.accountLabel !== "string" ||
    connection.accountLabel.trim().length === 0 ||
    connection.accountLabel.length > 256 ||
    scopes.some((scope) => typeof scope !== "string") ||
    scopes.length !== expectedScopes.length ||
    scopes.sort().some((scope, index) => scope !== expectedScopes[index]) ||
    !Number.isSafeInteger(connection.expiresAt) ||
    (connection.expiresAt as number) <= input.now ||
    connection.status !== "active" ||
    !Number.isSafeInteger(connection.generation) ||
    (connection.generation as number) <= 0
  ) {
    return { ok: false, code: "invalid_result" };
  }
  return {
    ok: true,
    shipletId: value.shipletId,
    deliveryExpiresAt: value.deliveryExpiresAt as number,
    connection: {
      id: connection.id,
      userId: connection.userId,
      accountId: connection.accountId,
      accountLabel: connection.accountLabel.trim(),
      scopes: expectedScopes,
      expiresAt: connection.expiresAt as number,
      status: "active",
      generation: connection.generation as number,
    },
  };
}

type DeploymentConnectionRow = {
  id: string;
  user_id: string;
  account_id: string;
  scopes_json: string;
  credential_ref: string;
  expires_at: number;
  status: string;
};

function createD1DeploymentConnectionAuthorizer(input: {
  db: D1Database;
  now: () => number;
}): DeploymentConnectionAuthorizer {
  return {
    async authorize(request) {
      const connection = await input.db
        .prepare(
          `SELECT connection.id, connection.user_id, connection.account_id,
             connection.scopes_json, connection.credential_ref,
             connection.expires_at, connection.status
           FROM cloudflare_connections connection
           JOIN deployment_targets target
             ON target.id = ? AND target.project_id = ?
             AND target.connection_id = connection.id
             AND target.owner_kind = 'human' AND target.owner_id = ?
             AND target.provider_account_id = ? AND target.detached_on IS NULL
           JOIN shiplet_revisions revision
             ON revision.id = ? AND revision.project_id = target.project_id
             AND ('sha256:' || revision.package_digest) = ?
           WHERE connection.id = ? AND connection.user_id = ?
             AND connection.account_id = ? LIMIT 1`,
        )
        .bind(
          request.targetId,
          request.shipletId,
          request.userId,
          request.accountId,
          request.revisionId,
          request.packageDigest,
          request.connectionId,
          request.userId,
          request.accountId,
        )
        .first<DeploymentConnectionRow>();
      const now = input.now();
      const controlPlaneCredential =
        typeof connection?.credential_ref === "string" &&
        connection.credential_ref.startsWith("control-plane:") &&
        CLOUDFLARE_CONTROL_IDENTIFIER.test(
          connection.credential_ref.slice("control-plane:".length),
        );
      if (
        !connection ||
        connection.status !== "active" ||
        !Number.isSafeInteger(connection.expires_at) ||
        (connection.expires_at <= now && !controlPlaneCredential) ||
        typeof connection.credential_ref !== "string" ||
        connection.credential_ref.length === 0
      ) {
        return { ok: false as const, reason: "connection_revoked" as const };
      }
      let scopes: string[];
      try {
        const parsed = JSON.parse(connection.scopes_json) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.some((scope) => typeof scope !== "string")
        ) {
          return { ok: false as const, reason: "connection_scope_invalid" };
        }
        scopes = [...new Set(parsed as string[])].sort();
      } catch {
        return { ok: false as const, reason: "connection_scope_invalid" };
      }
      const granted = new Set(scopes);
      if (request.requiredScopes.some((scope) => !granted.has(scope))) {
        return { ok: false as const, reason: "connection_scope_denied" };
      }
      return {
        ok: true as const,
        grantRef: `deployment_grant_${crypto.randomUUID()}`,
        authorization: {
          handle: connection.credential_ref,
          userId: request.userId,
          shipletId: request.shipletId,
          accountId: request.accountId,
          expiresAt: controlPlaneCredential
            ? now + 30_000
            : Math.min(connection.expires_at, now + 30_000),
          operation: request.operation,
          scopes,
          targetId: request.targetId,
          scriptName: request.scriptName,
          revisionId: request.revisionId,
          packageDigest: request.packageDigest,
          requestDigest: request.requestDigest,
        },
      };
    },
  };
}

type ImmutableRevisionDeploymentBundle = ImmutableRevisionBundle & {
  package: ValidatedShipletPackage;
};

async function immutableRevisionDeploymentBundle(input: {
  db: D1Database;
  shipletId: string;
  revisionId: string;
  packageStore?: R2Bucket;
}): Promise<ImmutableRevisionDeploymentBundle | null> {
  const row = await input.db
    .prepare(
      `SELECT package_json, package_digest FROM shiplet_revisions
			 WHERE id = ? AND project_id = ? LIMIT 1`,
    )
    .bind(input.revisionId, input.shipletId)
    .first<{ package_json: string; package_digest: string }>();
  if (!row) return null;
  let serializedPackage = row.package_json;
  const storedPackage = JSON.parse(serializedPackage) as unknown;
  if (
    storedPackage &&
    typeof storedPackage === "object" &&
    !Array.isArray(storedPackage) &&
    (storedPackage as Record<string, unknown>).storage ===
      "shiplet.package.storage/r2-v1"
  ) {
    const expectedKey = `self-owned/${encodeURIComponent(input.shipletId)}/revision/${encodeURIComponent(input.revisionId)}/package.json`;
    const key = (storedPackage as Record<string, unknown>).key;
    if (key !== expectedKey || !input.packageStore) {
      throw new Error("revision_package_storage_unavailable");
    }
    const object = await input.packageStore.get(key);
    if (!object) throw new Error("revision_package_object_missing");
    serializedPackage = await object.text();
  }
  const portablePackage = await parseShipletPackage(serializedPackage);
  if ((await digestShipletPackage(portablePackage)) !== row.package_digest) {
    throw new Error("revision_package_digest_mismatch");
  }
  const artifactFiles = portablePackage.files.filter((file) =>
    file.path.startsWith("artifact/"),
  );
  if (artifactFiles.length === 0) {
    throw new Error("revision_artifact_missing");
  }
  const isModule = (mediaType: string) =>
    mediaType === "application/wasm" ||
    mediaType.includes("javascript") ||
    mediaType.includes("ecmascript");
  const projected = artifactFiles.map((file) => ({
    path: file.path.slice("artifact/".length),
    mediaType: file.mediaType,
    content: file.content,
    encoding: file.encoding,
  }));
  const modules = portablePackage.manifest.staticFirst
    ? []
    : projected
        .filter((file) => isModule(file.mediaType))
        .map(({ path, ...file }) => ({
          name: path,
          ...file,
          mediaType:
            file.mediaType.includes("javascript") ||
            file.mediaType.includes("ecmascript")
              ? "application/javascript+module"
              : file.mediaType,
        }));
  const artifactEntrypoint =
    portablePackage.manifest.entrypoints.artifact.slice("artifact/".length);
  const mainModule =
    modules.length === 0
      ? "__shiplet_static.mjs"
      : modules.some((module) => module.name === artifactEntrypoint)
        ? artifactEntrypoint
        : modules.length === 1
          ? modules[0]!.name
          : null;
  if (!mainModule) throw new Error("revision_main_module_ambiguous");
  return Object.freeze({
    shipletId: input.shipletId,
    revisionId: input.revisionId,
    packageDigest: `sha256:${row.package_digest}`,
    package: portablePackage,
    mainModule,
    modules,
    staticAssets: projected.filter(
      (file) =>
        portablePackage.manifest.staticFirst || !isModule(file.mediaType),
    ),
  });
}

function encodeManagedOperationDigest(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function managedMainOperationId(parts: readonly string[]) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(parts.join("\u0000")),
    ),
  );
  return `managed_main_${encodeManagedOperationDigest(bytes)}`;
}

type ManagedRuntimeNotDispatchedFailure = Readonly<{
  code: "managed_dynamic_unavailable" | "managed_dynamic_bundle_invalid";
  status: 409 | 422 | 503;
}>;

const managedRuntimeNotDispatchedFailures = new WeakMap<
  Response,
  ManagedRuntimeNotDispatchedFailure
>();

function managedRuntimeNotDispatchedFailure(
  code: "managed_dynamic_unavailable" | "managed_dynamic_bundle_invalid",
  status: 409 | 422 | 503,
  activeRevisionId?: string,
) {
  const response = new Response(
    JSON.stringify({
      ok: false,
      code,
      ...(activeRevisionId ? { activeRevisionId } : {}),
    }),
    { status, headers: { "content-type": "application/json" } },
  );
  managedRuntimeNotDispatchedFailures.set(
    response,
    Object.freeze({ code, status }),
  );
  return response;
}

function replayManagedRuntimeTerminalFailure(input: {
  code: string;
  status: number;
  priorRevisionId: string;
}) {
  return new Response(
    JSON.stringify({
      ok: false,
      code: input.code,
      ...(input.code === "managed_dynamic_unavailable" && input.status === 409
        ? { activeRevisionId: input.priorRevisionId }
        : {}),
    }),
    {
      status: input.status,
      headers: { "content-type": "application/json" },
    },
  );
}

async function stageManagedRuntimeRevision(input: {
  env: DeploymentRuntimeEnv;
  actor: ShipletActor;
  shipletId: string;
  revisionId: string;
}) {
  const runtime = await cloudflareManagedRuntimeGateway(
    input.env,
    input.actor.kind === "human" ? input.actor.id : undefined,
  );
  if (!runtime) {
    throw managedRuntimeNotDispatchedFailure(
      "managed_dynamic_unavailable",
      503,
    );
  }
  let bundle: Awaited<ReturnType<typeof immutableRevisionDeploymentBundle>>;
  try {
    bundle = await immutableRevisionDeploymentBundle({
      db: input.env.DB,
      shipletId: input.shipletId,
      revisionId: input.revisionId,
      packageStore: input.env.SHIPLET_ASSETS,
    });
  } catch {
    throw managedRuntimeNotDispatchedFailure(
      "managed_dynamic_bundle_invalid",
      422,
    );
  }
  if (!bundle || !bundle.mainModule || bundle.modules.length === 0) {
    throw managedRuntimeNotDispatchedFailure(
      "managed_dynamic_bundle_invalid",
      422,
    );
  }
  let plan: NonNullable<
    Awaited<ReturnType<typeof compileManagedRuntimeRevision>>
  >;
  try {
    const compiled = await compileManagedRuntimeRevision({
      shipletId: bundle.shipletId,
      revisionId: bundle.revisionId,
      packageDigest: bundle.packageDigest,
      package: bundle.package,
    });
    if (!compiled) throw new Error("managed_dynamic_bundle_invalid");
    plan = compiled;
  } catch {
    throw managedRuntimeNotDispatchedFailure(
      "managed_dynamic_bundle_invalid",
      422,
    );
  }
  try {
    const staged = await runtime.gateway.stageRevision(
      {
        actorId: input.actor.id,
        shipletId: bundle.shipletId,
        revisionId: bundle.revisionId,
        packageDigest: bundle.packageDigest,
        mainModule: plan.mainModule,
        modules: plan.modules,
        policy: { cpuMs: 25, subRequests: 8 },
      },
      runtime.expectation,
    );
    if (
      staged?.ok !== true ||
      staged.status !== "validated" ||
      typeof staged.scriptName !== "string" ||
      staged.scriptName.length === 0
    ) {
      throw new Error("managed_stage_attestation_mismatch");
    }
  } catch {
    throw new Response(
      JSON.stringify({ ok: false, code: "managed_dynamic_validation_failed" }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
  return Object.freeze({ ...runtime, bundle, plan });
}

async function prepareManagedRuntimeActivation(input: {
  env: DeploymentRuntimeEnv;
  actor: ShipletActor;
  kind: "promote" | "rollback";
  shipletId: string;
  candidateRevisionId: string;
  priorRevisionId: string;
  idempotencyKey?: string;
}) {
  const bundle = await immutableRevisionDeploymentBundle({
    db: input.env.DB,
    shipletId: input.shipletId,
    revisionId: input.candidateRevisionId,
    packageStore: input.env.SHIPLET_ASSETS,
  });
  if (!bundle || bundle.modules.length === 0) {
    throw new Response(
      JSON.stringify({ ok: false, code: "managed_dynamic_bundle_invalid" }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
  }
  const operationParts = [
    input.kind,
    input.actor.kind,
    input.actor.id,
    input.shipletId,
    input.candidateRevisionId,
    bundle.packageDigest,
    input.priorRevisionId,
  ];
  let operationId = "";
  let operation:
    | Awaited<ReturnType<typeof beginManagedRuntimeActivation>>
    | undefined;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    operationId = await managedMainOperationId([
      ...operationParts,
      ...(input.idempotencyKey
        ? ["idempotency", input.idempotencyKey]
        : attempt === 0
          ? []
          : ["attempt", String(attempt)]),
    ]);
    try {
      operation = await beginManagedRuntimeActivation({
        db: input.env.DB,
        operationId,
        projectId: input.shipletId,
        kind: input.kind,
        candidateRevisionId: input.candidateRevisionId,
        candidatePackageDigest: bundle.packageDigest,
        priorRevisionId: input.priorRevisionId,
        actor: input.actor,
      });
      break;
    } catch {
      const terminal = await loadManagedRuntimeActivationTerminal({
        db: input.env.DB,
        operationId,
        actor: input.actor,
      });
      if (!terminal) break;
      if (input.idempotencyKey) {
        if (terminal.failure) {
          throw replayManagedRuntimeTerminalFailure({
            ...terminal.failure,
            priorRevisionId: terminal.priorRevisionId,
          });
        }
        break;
      }
    }
  }
  if (!operation) {
    throw new Response(
      JSON.stringify({ ok: false, code: "managed_activation_conflict" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  let staged: Awaited<ReturnType<typeof stageManagedRuntimeRevision>> | null =
    null;
  if (operation.status === "prepared") {
    if (
      !hasManagedAdvancedRuntime(
        input.env,
        input.actor.kind === "human" ? input.actor.id : undefined,
      )
    ) {
      const failure = managedRuntimeNotDispatchedFailure(
        "managed_dynamic_unavailable",
        409,
        input.priorRevisionId,
      );
      try {
        await abortManagedRuntimeActivation({
          db: input.env.DB,
          operationId,
          outcome: "not_dispatched",
          actor: input.actor,
          failure: managedRuntimeNotDispatchedFailures.get(failure),
        });
      } catch {
        throw new Response(
          JSON.stringify({
            ok: false,
            code: "managed_activation_reconciliation_required",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      throw failure;
    }
    try {
      staged = await stageManagedRuntimeRevision({
        env: input.env,
        actor: input.actor,
        shipletId: input.shipletId,
        revisionId: input.candidateRevisionId,
      });
    } catch (error) {
      if (
        !(error instanceof Response) ||
        !managedRuntimeNotDispatchedFailures.has(error)
      ) {
        throw error;
      }
      try {
        await abortManagedRuntimeActivation({
          db: input.env.DB,
          operationId,
          outcome: "not_dispatched",
          actor: input.actor,
          failure: managedRuntimeNotDispatchedFailures.get(error),
        });
      } catch {
        throw new Response(
          JSON.stringify({
            ok: false,
            code: "managed_activation_reconciliation_required",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      throw error;
    }
    let activation: Awaited<ReturnType<CloudflareManagedRuntimeRpc["promote"]>>;
    try {
      await markManagedRuntimeActivationDispatching({
        db: input.env.DB,
        operationId,
        actor: input.actor,
      });
    } catch {
      throw new Response(
        JSON.stringify({
          ok: false,
          code: "managed_activation_reconciliation_required",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    try {
      activation = await staged.gateway[input.kind](
        {
          actorId: input.actor.id,
          shipletId: input.shipletId,
          revisionId: input.candidateRevisionId,
          packageDigest: bundle.packageDigest,
          expectedActivationGeneration: operation.expectedRemoteGeneration,
        },
        staged.expectation,
      );
    } catch {
      throw new Response(
        JSON.stringify({ ok: false, code: "managed_activation_failed" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    if (
      activation?.ok !== true ||
      activation.shipletId !== input.shipletId ||
      activation.revisionId !== input.candidateRevisionId ||
      activation.packageDigest !== bundle.packageDigest ||
      activation.activationGeneration !== operation.expectedRemoteGeneration + 1
    ) {
      throw new Response(
        JSON.stringify({ ok: false, code: "managed_activation_mismatch" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    try {
      operation = await markManagedRuntimeRemoteCommitted({
        db: input.env.DB,
        operationId,
        expectedRemoteGeneration: operation.expectedRemoteGeneration,
        remoteGeneration: activation.activationGeneration,
      });
    } catch {
      throw new Response(
        JSON.stringify({
          ok: false,
          code: "managed_activation_reconciliation_required",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
  }
  const acknowledgementRuntime =
    staged ??
    (await cloudflareManagedRuntimeGateway(
      input.env,
      input.actor.kind === "human" ? input.actor.id : undefined,
      { requireDeploymentReadiness: false },
    ));
  if (!acknowledgementRuntime) {
    throw new Response(
      JSON.stringify({
        ok: false,
        code: "managed_activation_reconciliation_required",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return Object.freeze({
    operationId,
    bundle,
    localIdempotencyKey: `managed:${operationId}`,
    gateway: acknowledgementRuntime.gateway,
    expectation: acknowledgementRuntime.expectation,
    acknowledgement: Object.freeze({
      actorId: input.actor.id,
      shipletId: input.shipletId,
      revisionId: input.candidateRevisionId,
      packageDigest: bundle.packageDigest,
      expectedActivationGeneration: operation.expectedRemoteGeneration,
      reason: input.kind,
    }),
  });
}

const unavailableClaimVault: TemporaryClaimVault = {
  async store() {
    throw new Error("temporary_claim_vault_unavailable");
  },
  async consumeForBackendRedirect() {
    return { ok: false, reason: "temporary_claim_vault_unavailable" };
  },
  async redeemBackendRedirect() {
    return null;
  },
};

async function recordDeploymentAudit(
  db: D1Database,
  projectId: string,
  revisionId: string,
  actor: ShipletActor,
  event: Record<string, unknown>,
) {
  const eventKind =
    typeof event.eventKind === "string"
      ? event.eventKind
      : "cloudflare.deployment.unknown";
  const now = Date.now();
  const occurredAt =
    typeof event.occurredAt === "number" &&
    Number.isSafeInteger(event.occurredAt)
      ? event.occurredAt
      : now;
  const temporaryClaimEvent =
    eventKind === "cloudflare.temporary_deployment.created";
  const deploymentId =
    !temporaryClaimEvent && typeof event.deploymentId === "string"
      ? event.deploymentId
      : null;
  await db
    .prepare(
      `INSERT INTO shiplet_audit_events (
			 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
			 event_kind, summary, status_category, payload_json,
			 occurred_on, recorded_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `audit_${crypto.randomUUID()}`,
      projectId,
      revisionId,
      deploymentId,
      actor.kind,
      actor.id,
      eventKind,
      eventKind === "cloudflare.deployment.promoted"
        ? "Customer-owned deployment promoted"
        : temporaryClaimEvent
          ? "Temporary customer-owned preview created"
          : "Customer-owned deployment failed",
      event.outcome === "success" ? "resolved" : "failed",
      JSON.stringify({
        targetId:
          typeof event.targetId === "string" ? event.targetId : undefined,
        reason: typeof event.reason === "string" ? event.reason : undefined,
        outcome: typeof event.outcome === "string" ? event.outcome : undefined,
      }),
      new Date(occurredAt).toISOString(),
      new Date(now).toISOString(),
    )
    .run();
}

const REVISION_DEPLOYMENT_AUDIT_SUMMARIES = Object.freeze({
  "cloudflare.revision_candidate.prepared":
    "Customer-owned revision candidate prepared",
  "cloudflare.revision_candidate.activated":
    "Customer-owned revision candidate activated",
  "cloudflare.revision_candidate.restored":
    "Previous customer-owned revision restored",
  "cloudflare.revision_candidate.abandoned":
    "Customer-owned revision candidate abandoned",
} as const);

async function recordRevisionDeploymentCoordinatorAudit(
  db: D1Database,
  actor: { kind: "human"; id: string },
  event: Record<string, unknown>,
) {
  const eventKind = event.eventKind;
  const projectId = event.shipletId;
  const revisionId = event.revisionId;
  if (
    typeof eventKind !== "string" ||
    !(eventKind in REVISION_DEPLOYMENT_AUDIT_SUMMARIES) ||
    typeof projectId !== "string" ||
    typeof revisionId !== "string" ||
    event.actorKind !== "human" ||
    event.actorId !== actor.id
  ) {
    throw new Error("revision_deployment_audit_binding_invalid");
  }
  const now = Date.now();
  const occurredAt =
    typeof event.occurredAt === "number" &&
    Number.isSafeInteger(event.occurredAt)
      ? event.occurredAt
      : now;
  await db
    .prepare(
      `INSERT INTO shiplet_audit_events (
			 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
			 event_kind, summary, status_category, payload_json,
			 occurred_on, recorded_on
			) VALUES (?, ?, ?, NULL, 'human', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `audit_${crypto.randomUUID()}`,
      projectId,
      revisionId,
      actor.id,
      eventKind,
      REVISION_DEPLOYMENT_AUDIT_SUMMARIES[
        eventKind as keyof typeof REVISION_DEPLOYMENT_AUDIT_SUMMARIES
      ],
      event.outcome === "success" ? "informational" : "blocked",
      JSON.stringify({
        targetId:
          typeof event.targetId === "string" ? event.targetId : undefined,
        preparationId:
          typeof event.deploymentId === "string"
            ? event.deploymentId
            : undefined,
        providerVersionId:
          typeof event.providerVersionId === "string"
            ? event.providerVersionId
            : undefined,
        outcome: typeof event.outcome === "string" ? event.outcome : undefined,
      }),
      new Date(occurredAt).toISOString(),
      new Date(now).toISOString(),
    )
    .run();
}

function deploymentFailureStatus(reason: string) {
  if (reason === "target_not_found") return 404;
  if (reason === "connection_revoked" || reason === "connection_scope_denied") {
    return 403;
  }
  if (
    reason === "operation_in_progress" ||
    reason === "deployment_conflict" ||
    reason === "idempotency_intent_mismatch" ||
    reason === "customer_advanced_runtime_egress_unavailable"
  ) {
    return 409;
  }
  if (
    reason === "provider_authorization_unavailable" ||
    reason === "provider_upload_failed" ||
    reason === "candidate_proof_failed" ||
    reason === "provider_deployment_failed" ||
    reason === "deployment_reconciliation_required"
  ) {
    return 502;
  }
  return 400;
}

function exactDeploymentTargetIds(body: Record<string, unknown>) {
  if (body.targetIds === undefined) return undefined;
  if (
    !Array.isArray(body.targetIds) ||
    body.targetIds.length > 64 ||
    body.targetIds.some(
      (targetId) =>
        typeof targetId !== "string" ||
        targetId.length === 0 ||
        targetId.length > 256 ||
        targetId.trim() !== targetId,
    )
  ) {
    throw new Response("Deployment target IDs are invalid", { status: 400 });
  }
  const targetIds = body.targetIds as string[];
  if (new Set(targetIds).size !== targetIds.length) {
    throw new Response("Deployment target IDs must be unique", { status: 400 });
  }
  return [...targetIds];
}

type RevisionOperationReplay = {
  id: string;
  kind: "promotion" | "rollback";
  candidate_revision_id: string;
  prior_revision_id: string;
  status: string;
  target_ids_json: string;
  deployment_ids_json: string;
  idempotency_key: string;
};

function exactRevisionOperationIdempotencyKey(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) {
    throw new Response("Invalid idempotency key", { status: 400 });
  }
  return normalized;
}

function revisionOperationIdempotencyKey(c: any) {
  const value = c.req.header("idempotency-key");
  if (!value) return undefined;
  return exactRevisionOperationIdempotencyKey(value);
}

async function replayRevisionOperation(input: {
  db: D1Database;
  projectId: string;
  idempotencyKey?: string;
  kind: RevisionOperationReplay["kind"];
  candidateRevisionId: string;
  priorRevisionId: string;
  targetIds: string[];
}) {
  if (!input.idempotencyKey) return null;
  const operation = await input.db
    .prepare(
      `SELECT id, kind, candidate_revision_id, prior_revision_id, status,
			 target_ids_json, deployment_ids_json, idempotency_key
			 FROM shiplet_revision_operations
			 WHERE project_id = ? AND idempotency_key = ? LIMIT 1`,
    )
    .bind(input.projectId, input.idempotencyKey)
    .first<RevisionOperationReplay>();
  if (!operation) return null;
  let targetIds: string[];
  try {
    const parsed = JSON.parse(operation.target_ids_json) as unknown;
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
      throw new Error("invalid_operation_targets");
    }
    targetIds = [...parsed].sort();
  } catch {
    throw new Response("Stored revision operation is unavailable", {
      status: 503,
    });
  }
  const expectedTargets = [...input.targetIds].sort();
  if (
    operation.kind !== input.kind ||
    operation.candidate_revision_id !== input.candidateRevisionId ||
    operation.prior_revision_id !== input.priorRevisionId ||
    targetIds.length !== expectedTargets.length ||
    targetIds.some((targetId, index) => targetId !== expectedTargets[index])
  ) {
    throw new Response(
      JSON.stringify({ ok: false, code: "idempotency_intent_mismatch" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  if (operation.status !== "committed") {
    throw new Response(
      JSON.stringify({
        ok: false,
        code: "operation_in_progress",
        operation: { id: operation.id, status: operation.status },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  let deploymentIds: string[] = [];
  try {
    const parsed = JSON.parse(operation.deployment_ids_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      deploymentIds = parsed as string[];
    }
  } catch {
    deploymentIds = [];
  }
  return { ...operation, targetIds, deploymentIds };
}

async function executeRevisionPromotion(input: {
  env: Env;
  access: RevisionRouteAccess;
  project: Project;
  draftId: string;
  expectedActiveRevisionId: string;
  targetIds?: string[];
  idempotencyKey?: string;
}) {
  const draftState = await input.env.DB.prepare(
    `SELECT validated_revision_id FROM shiplet_drafts
			 WHERE id = ? AND project_id = ? LIMIT 1`,
  )
    .bind(input.draftId, input.project.id)
    .first<{ validated_revision_id: string | null }>();
  if (!draftState?.validated_revision_id) {
    throw new Response(
      JSON.stringify({ ok: false, code: "draft_not_validated" }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  }
  const replay = await replayRevisionOperation({
    db: input.env.DB,
    projectId: input.project.id,
    idempotencyKey: input.idempotencyKey,
    kind: "promotion",
    candidateRevisionId: draftState.validated_revision_id,
    priorRevisionId: input.expectedActiveRevisionId,
    targetIds: input.targetIds ?? [],
  });
  const candidatePackage = await storedRevisionPackage(
    input.env,
    input.project.id,
    draftState.validated_revision_id,
  );
  const managedActivation =
    candidatePackage?.manifest?.staticFirst === false
      ? await prepareManagedRuntimeActivation({
          env: input.env as DeploymentRuntimeEnv,
          actor: input.access.actor,
          kind: "promote",
          shipletId: input.project.id,
          candidateRevisionId: draftState.validated_revision_id,
          priorRevisionId: input.expectedActiveRevisionId,
          idempotencyKey: input.idempotencyKey,
        })
      : null;
  const managedReplay =
    !replay && managedActivation
      ? await replayRevisionOperation({
          db: input.env.DB,
          projectId: input.project.id,
          idempotencyKey: managedActivation.localIdempotencyKey,
          kind: "promotion",
          candidateRevisionId: draftState.validated_revision_id,
          priorRevisionId: input.expectedActiveRevisionId,
          targetIds: input.targetIds ?? [],
        })
      : null;
  const effectiveReplay = replay ?? managedReplay;
  if (!effectiveReplay) {
    if (input.targetIds?.length) {
      const readiness = await cloudflareSupportMutationReadiness(
        input.env as DeploymentRuntimeEnv,
      );
      if (!readiness.ok) {
        throw cloudflareSupportMutationUnavailableResponse(readiness);
      }
    }
  }
  const service = revisionServiceFor(
    input.env.DB,
    input.access,
    input.env as DeploymentRuntimeEnv,
  );
  const result = effectiveReplay
    ? {
        operationId: effectiveReplay.id,
        operationStatus: "committed" as const,
        revisionId: effectiveReplay.candidate_revision_id,
        previousRevisionId: effectiveReplay.prior_revision_id,
        deploymentId: effectiveReplay.deploymentIds[0] ?? null,
        deploymentIds: effectiveReplay.deploymentIds,
      }
    : await service.promoteDraft({
        shipletId: input.project.id,
        draftId: input.draftId,
        expectedBaseRevisionId: input.expectedActiveRevisionId,
        ...(input.targetIds ? { targetIds: input.targetIds } : {}),
        ...(managedActivation || input.idempotencyKey
          ? {
              idempotencyKey:
                managedActivation?.localIdempotencyKey ?? input.idempotencyKey,
            }
          : {}),
        actor: input.access.actor,
      });
  if (managedActivation) {
    try {
      await commitManagedRuntimeActivation({
        db: input.env.DB,
        operationId: managedActivation.operationId,
      });
      const acknowledgement =
        await managedActivation.gateway.acknowledgeActivation(
          managedActivation.acknowledgement,
          managedActivation.expectation,
        );
      if (
        !isRecord(acknowledgement) ||
        Object.keys(acknowledgement).join(",") !== "ok" ||
        acknowledgement.ok !== true
      ) {
        throw new Error("managed_activation_acknowledgement_mismatch");
      }
    } catch {
      throw new Response(
        JSON.stringify({
          ok: false,
          code: "managed_activation_reconciliation_required",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
  }
  return {
    result,
    draftId: input.draftId,
    previousRevisionId: result.previousRevisionId,
    targetIds: input.targetIds ?? [],
    operation: {
      id: result.operationId,
      status: result.operationStatus,
      kind: "promote" as const,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    revision: await service.getRevision({
      shipletId: input.project.id,
      revisionId: result.revisionId,
      actor: input.access.actor,
    }),
  };
}

async function executeRevisionRollback(input: {
  env: Env;
  access: RevisionRouteAccess;
  project: Project;
  revisionId: string;
  expectedActiveRevisionId: string;
  targetIds?: string[];
  idempotencyKey?: string;
}) {
  const replay = await replayRevisionOperation({
    db: input.env.DB,
    projectId: input.project.id,
    idempotencyKey: input.idempotencyKey,
    kind: "rollback",
    candidateRevisionId: input.revisionId,
    priorRevisionId: input.expectedActiveRevisionId,
    targetIds: input.targetIds ?? [],
  });
  const candidatePackage = await storedRevisionPackage(
    input.env,
    input.project.id,
    input.revisionId,
  );
  const managedActivation =
    candidatePackage?.manifest?.staticFirst === false
      ? await prepareManagedRuntimeActivation({
          env: input.env as DeploymentRuntimeEnv,
          actor: input.access.actor,
          kind: "rollback",
          shipletId: input.project.id,
          candidateRevisionId: input.revisionId,
          priorRevisionId: input.expectedActiveRevisionId,
          idempotencyKey: input.idempotencyKey,
        })
      : null;
  const managedReplay =
    !replay && managedActivation
      ? await replayRevisionOperation({
          db: input.env.DB,
          projectId: input.project.id,
          idempotencyKey: managedActivation.localIdempotencyKey,
          kind: "rollback",
          candidateRevisionId: input.revisionId,
          priorRevisionId: input.expectedActiveRevisionId,
          targetIds: input.targetIds ?? [],
        })
      : null;
  const effectiveReplay = replay ?? managedReplay;
  if (!effectiveReplay) {
    if (input.targetIds?.length) {
      const readiness = await cloudflareSupportMutationReadiness(
        input.env as DeploymentRuntimeEnv,
      );
      if (!readiness.ok) {
        throw cloudflareSupportMutationUnavailableResponse(readiness);
      }
    }
  }
  const service = revisionServiceFor(
    input.env.DB,
    input.access,
    input.env as DeploymentRuntimeEnv,
  );
  const result = effectiveReplay
    ? {
        operationId: effectiveReplay.id,
        operationStatus: "committed" as const,
        activeRevisionId: effectiveReplay.candidate_revision_id,
        previousRevisionId: effectiveReplay.prior_revision_id,
        deploymentId: effectiveReplay.deploymentIds[0] ?? null,
        deploymentIds: effectiveReplay.deploymentIds,
      }
    : await service.rollbackRevision({
        shipletId: input.project.id,
        revisionId: input.revisionId,
        expectedActiveRevisionId: input.expectedActiveRevisionId,
        ...(input.targetIds ? { targetIds: input.targetIds } : {}),
        ...(managedActivation || input.idempotencyKey
          ? {
              idempotencyKey:
                managedActivation?.localIdempotencyKey ?? input.idempotencyKey,
            }
          : {}),
        actor: input.access.actor,
      });
  if (managedActivation) {
    try {
      await commitManagedRuntimeActivation({
        db: input.env.DB,
        operationId: managedActivation.operationId,
      });
      const acknowledgement =
        await managedActivation.gateway.acknowledgeActivation(
          managedActivation.acknowledgement,
          managedActivation.expectation,
        );
      if (
        !isRecord(acknowledgement) ||
        Object.keys(acknowledgement).join(",") !== "ok" ||
        acknowledgement.ok !== true
      ) {
        throw new Error("managed_activation_acknowledgement_mismatch");
      }
    } catch {
      throw new Response(
        JSON.stringify({
          ok: false,
          code: "managed_activation_reconciliation_required",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
  }
  return {
    result,
    shipletId: input.project.id,
    previousRevisionId: result.previousRevisionId,
    targetIds: input.targetIds ?? [],
    operation: {
      id: result.operationId,
      status: result.operationStatus,
      kind: "rollback" as const,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    revision: await service.getRevision({
      shipletId: input.project.id,
      revisionId: input.revisionId,
      actor: input.access.actor,
    }),
  };
}

function expectedDraftVersion(c: any, body: Record<string, unknown>) {
  const header = c.req
    .header("if-match")
    ?.replace(/^W\//, "")
    .replace(/^"|"$/g, "");
  const bodyValue = body.expectedVersion;
  if (header && bodyValue !== undefined && String(bodyValue) !== header) {
    throw new Response("Draft version preconditions disagree", { status: 400 });
  }
  const value = Number(header || bodyValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Response("A positive draft version precondition is required", {
      status: 428,
    });
  }
  return value;
}

function validatedDraftPreviewUrl(input: {
  env: Env;
  requestUrl: string;
  shipletId: string;
  draftId: string;
  validation: {
    ok: boolean;
    draftVersion: number;
    revisionId: string;
  };
}) {
  if (!input.validation.ok || !input.validation.revisionId) return null;
  return revisionPreviewUrl(appBaseUrl(input.env, input.requestUrl), {
    shipletId: input.shipletId,
    draftId: input.draftId,
    revisionId: input.validation.revisionId,
    draftVersion: input.validation.draftVersion,
  });
}

async function readReviewLayer(input: {
  env: Env;
  project: Project;
  access: RevisionRouteAccess;
}) {
  const layer = await activeReviewLayerState(
    input.env,
    input.project,
    reviewLayerActor(input.access),
  );
  return {
    version: layer.version,
    files: layer.files,
  };
}

async function prepareReviewLayerPreview(input: {
  env: Env;
  project: Project;
  access: RevisionRouteAccess;
  body: Record<string, unknown>;
  requestUrl: string;
}) {
  const actor = reviewLayerActor(input.access);
  const current = await activeReviewLayerState(input.env, input.project, actor);
  if (
    typeof input.body.baseVersion !== "string" ||
    input.body.baseVersion !== current.version
  ) {
    throw new Response("Review layer version conflict", { status: 409 });
  }
  const preview = await shipletRootStub(
    input.env,
    input.project.id,
  ).prepareReviewLayerPreview({
    projectId: input.project.id,
    fallback: await defaultReviewLayerState(input.env, input.project),
    baseVersion: current.version,
    changes: input.body.changes,
    actor,
  });
  if (!preview.ok) {
    if (preview.code === "review_layer_conflict") {
      throw new Response("Review layer version conflict", { status: 409 });
    }
    return {
      ok: false as const,
      response: json(
        {
          ok: false,
          code: "review_layer_invalid",
          diagnostics: preview.diagnostics || [],
        },
        422,
      ),
    };
  }
  return {
    ok: true as const,
    value: {
      previewId: preview.previewId,
      previewUrl: new URL(
        `/shiplets/${encodeURIComponent(input.project.id)}/review-layer/preview/${encodeURIComponent(preview.previewId)}`,
        appBaseUrl(input.env, input.requestUrl),
      ).toString(),
      baseVersion: current.version,
      diagnostics: [],
    },
  };
}

async function commitReviewLayerPreview(input: {
  env: Env;
  project: Project;
  access: RevisionRouteAccess;
  previewId: string;
  body: Record<string, unknown>;
}) {
  if (input.body.approval !== true) {
    throw new Response("Explicit review layer approval is required", {
      status: 428,
    });
  }
  if (typeof input.body.expectedVersion !== "string") {
    throw new Response("Expected review layer version is required", {
      status: 428,
    });
  }
  await activeReviewLayerState(
    input.env,
    input.project,
    reviewLayerActor(input.access),
  );
  const result = await shipletRootStub(
    input.env,
    input.project.id,
  ).applyReviewLayerPreview({
    projectId: input.project.id,
    previewId: input.previewId,
    expectedVersion: input.body.expectedVersion,
    actor: reviewLayerActor(input.access),
  });
  if (!result.ok) {
    throw new Response(
      result.code === "preview_not_found"
        ? "Review layer preview not found"
        : "Review layer version conflict",
      { status: result.code === "preview_not_found" ? 404 : 409 },
    );
  }
  return {
    reviewLayer: await readReviewLayer({
      env: input.env,
      project: input.project,
      access: input.access,
    }),
  };
}

async function findProjectBySubdomain(db: D1Database, subdomain: string) {
  return db
    .prepare("SELECT * FROM projects WHERE subdomain = ? LIMIT 1")
    .bind(subdomain)
    .first<Project>();
}

async function findProjectByCustomHostname(db: D1Database, hostname: string) {
  return db
    .prepare("SELECT * FROM projects WHERE custom_hostname = ? LIMIT 1")
    .bind(hostname)
    .first<Project>();
}

async function requireArchiveProjectAccess(c: any, project: Project) {
  const token = await authenticateOptionalOrganizationCredential(
    c.env.DB,
    c.req.header("authorization"),
    ["shiplets:archive"],
  );
  if (token) {
    requireOrganizationApiProjectAccess(token, project);
    return;
  }

  const user = await requireCurrentUser(c);
  if (await canEditProject(c.env.DB, project, user)) return;

  // Organization members historically had lifecycle access even when they
  // were not project editors. Keep that narrow compatibility promise without
  // granting ambient revision, deployment, sharing, or MCP mutation authority.
  if (
    project.organization_id &&
    (await getOrganizationMembership(
      c.env.DB,
      project.organization_id,
      user.id,
    ))
  ) {
    return;
  }
  throw new Response("Shiplet editor access required", { status: 403 });
}

function requireProjectOwner(project: Project, user: ShipletUser) {
  if (!isProjectOwner(project, user.id)) {
    throw new Response("Shiplet owner access required", { status: 403 });
  }
}

async function deleteProjectPermanently(env: Env, project: Project) {
  await deleteStaticAssets(env.DB, env.SHIPLET_ASSETS, project.id);
  if (project.custom_hostname) {
    await deleteCustomHostname(env, project.custom_hostname);
  }
  await permanentlyDeleteProjectRecords(env.DB, project.id);
}

function archivedShipletPageResponse(
  c: any,
  project: Project,
  user: ShipletUser | null,
) {
  const response = withNoIndexResponse(
    c.html(
      renderPage(
        BuildArchivedShipletPage({
          project,
          canRestore: Boolean(user && isProjectOwner(project, user.id)),
          restoreUrl: `/shiplets/${project.id}/restore`,
        }),
        {
          nonce: kernelDocumentNonce(c),
          customDomain: c.env.CUSTOM_DOMAIN,
          appUrl: appBaseUrl(c.env, c.req.url),
          user,
          indexing: "noindex",
        },
      ),
    ),
  );
  const pathname = new URL(c.req.url).pathname;
  const frameAncestors =
    /\/(?:review-host|artifact-frame|widget-frame)(?:\/|$)/.test(pathname)
      ? "self"
      : "none";
  return withKernelDocumentSecurityHeaders(response, c.env, c.req.url, {
    nonce: kernelDocumentNonce(c),
    knownKernelDocument: true,
    frameAncestors,
  });
}

function isDnsSafeShipletSubdomain(subdomain: string) {
  return (
    subdomain.length > 0 &&
    subdomain.length <= 63 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain)
  );
}

function normalizeRoutingHostname(host: string) {
  return host.toLowerCase().replace(/\.$/, "");
}

function appUrlHostname(env: Env) {
  if (!env.SHIPLET_APP_URL) return null;
  try {
    return normalizeRoutingHostname(new URL(env.SHIPLET_APP_URL).hostname);
  } catch {
    return null;
  }
}

function isPathTenantFallbackHost(host: string) {
  const normalizedHost = normalizeRoutingHostname(host);
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "[::1]" ||
    normalizedHost === "::1" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".workers.dev")
  );
}

function canUsePathTenantRouting(host: string, env: Env) {
  const normalizedHost = normalizeRoutingHostname(host);
  const configuredAppHost = appUrlHostname(env);
  if (!env.CUSTOM_DOMAIN) {
    return (
      isPathTenantFallbackHost(normalizedHost) ||
      Boolean(configuredAppHost && isPathTenantFallbackHost(configuredAppHost))
    );
  }
  return (
    isPathTenantFallbackHost(normalizedHost) ||
    (configuredAppHost !== null && normalizedHost === configuredAppHost)
  );
}

type ArtifactResponseOptions = {
  rootAssetPrefix?: string;
  externalSourceUrl?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

function normalizeRootAssetPrefix(prefix: string | undefined) {
  if (!prefix) return "";
  const normalized = `/${prefix.replace(/^\/+|\/+$/g, "")}`.replace(
    /\/+/g,
    "/",
  );
  return normalized === "/" ? "" : normalized;
}

function rewriteRootRelativeUrl(value: string, prefix: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return value;
  if (value === prefix || value.startsWith(`${prefix}/`)) return value;
  return `${prefix}${value}`;
}

function rewriteSrcset(value: string, prefix: string) {
  return value
    .split(",")
    .map((candidate) => {
      const leading = candidate.match(/^\s*/)?.[0] || "";
      const trailing = candidate.match(/\s*$/)?.[0] || "";
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const parts = trimmed.split(/\s+/);
      parts[0] = rewriteRootRelativeUrl(parts[0], prefix);
      return `${leading}${parts.join(" ")}${trailing}`;
    })
    .join(",");
}

function rewriteRootRelativeHtmlReferences(html: string, prefix: string) {
  if (!prefix) return html;
  const attrPattern =
    /\b(src|href|poster|action|formaction|data)=("([^"]*)"|'([^']*)')/gi;
  return html
    .replace(attrPattern, (match, name: string, quoted: string) => {
      const quote = quoted[0];
      const value = quoted.slice(1, -1);
      const nextValue =
        name.toLowerCase() === "srcset"
          ? rewriteSrcset(value, prefix)
          : rewriteRootRelativeUrl(value, prefix);
      return `${name}=${quote}${nextValue}${quote}`;
    })
    .replace(/\bsrcset=("([^"]*)"|'([^']*)')/gi, (_match, quoted: string) => {
      const quote = quoted[0];
      const value = quoted.slice(1, -1);
      return `srcset=${quote}${rewriteSrcset(value, prefix)}${quote}`;
    })
    .replace(
      /url\(\s*(["']?)(\/(?!\/)[^"')\s]+)\1\s*\)/gi,
      (_match, quote: string, value: string) =>
        `url(${quote}${rewriteRootRelativeUrl(value, prefix)}${quote})`,
    );
}

function rewriteRootRelativeCssReferences(css: string, prefix: string) {
  if (!prefix) return css;
  return css.replace(
    /url\(\s*(["']?)(\/(?!\/)[^"')\s]+)\1\s*\)/gi,
    (_match, quote: string, value: string) =>
      `url(${quote}${rewriteRootRelativeUrl(value, prefix)}${quote})`,
  );
}

export function reviewCapabilitySecret(env: Env) {
  const secret =
    env.SHIPLET_REVIEW_TOKEN_SECRET ||
    (env.SHIPLET_AUTH_MODE === "test"
      ? "shiplet-test-review-capability-secret"
      : "");
  if (!secret) {
    throw new Response("Review capability signing is not configured.", {
      status: 500,
    });
  }
  return secret;
}

async function issueReviewCapabilityToken(
  env: Env,
  project: Project,
  user: ShipletUser,
  scopes: ReviewCapabilityScope[] = [
    "feedback:read",
    "feedback:write",
    "presence:join",
    "watch:write",
  ],
  expiresInSeconds = 15 * 60,
) {
  return createReviewCapabilityToken({
    secret: reviewCapabilitySecret(env),
    projectId: project.id,
    viewer: {
      id: user.id,
      email: user.email,
      name: reviewPresenceUserName(user),
      avatarPreset: user.avatar_preset || null,
      avatarDataUrl: user.avatar_data_url || null,
    },
    scopes,
    expiresInSeconds,
  });
}

async function issueArtifactPreviewAccessUrl(
  env: Env,
  requestUrl: string,
  project: Project,
  user: ShipletUser,
  assetPath = "/",
  search = "",
) {
  const url = new URL(artifactAbsoluteUrl(env, requestUrl, project));
  url.pathname = assetPath || "/";
  url.search = search;
  url.searchParams.set(
    SHIPLET_PREVIEW_TOKEN_PARAM,
    await issueReviewCapabilityToken(
      env,
      project,
      user,
      ["feedback:read", "feedback:write", "presence:join", "watch:write"],
      5 * 60,
    ),
  );
  return url.toString();
}

function requestUsesLocalPreviewRoute(env: Env, requestUrl: string) {
  try {
    const configuredAppHost = appUrlHostname(env);
    return (
      isPathTenantFallbackHost(new URL(requestUrl).hostname) ||
      Boolean(configuredAppHost && isPathTenantFallbackHost(configuredAppHost))
    );
  } catch {
    const configuredAppHost = appUrlHostname(env);
    return Boolean(
      configuredAppHost && isPathTenantFallbackHost(configuredAppHost),
    );
  }
}

async function dashboardArtifactPreviewUrl(
  _env: Env,
  _requestUrl: string,
  project: Project,
  _user: ShipletUser,
) {
  return `/shiplets/${project.id}/review-host`;
}

async function dashboardReviewHostArtifactUrl(
  env: Env,
  requestUrl: string,
  project: Project,
) {
  const appUrl = appBaseUrl(env, requestUrl);
  if (
    !env.CUSTOM_DOMAIN ||
    requestUsesLocalPreviewRoute(env, requestUrl) ||
    !isExternalProject(project)
  ) {
    return new URL(
      `/shiplets/${encodeURIComponent(project.id)}/artifact-frame/`,
      appUrl,
    ).toString();
  }
  const tenantUrl = new URL(artifactAbsoluteUrl(env, requestUrl, project));
  tenantUrl.pathname = "/__shiplet/artifact-frame/";
  tenantUrl.search = "";
  return tenantUrl.toString();
}

async function injectReviewClient(
  _env: Env,
  request: Request,
  response: Response,
  _project: Project,
  _user: ShipletUser | null,
  options: ArtifactResponseOptions = {},
) {
  if (request.method !== "GET") return response;

  const contentType = response.headers.get("content-type") || "";
  const normalizedContentType = contentType.toLowerCase();
  const rootAssetPrefix = normalizeRootAssetPrefix(options.rootAssetPrefix);
  const isHtml = normalizedContentType.includes("text/html");
  const isCss = normalizedContentType.includes("text/css");
  if (!isHtml && !(isCss && rootAssetPrefix)) return response;
  if (isHtml && !rootAssetPrefix) return response;

  if (options.externalSourceUrl) {
    const proxyUrlFor = await createExternalResourceUrlBuilder({
      secret: reviewCapabilitySecret(_env),
      projectId: _project.id,
      rootAssetPrefix,
    });
    return rewriteExternalTextResponse({
      response,
      kind: isHtml ? "html" : "css",
      sourceUrl: options.externalSourceUrl,
      projectId: _project.id,
      proxyUrlFor,
      spoolStore: createCloudflareExternalRewriteSpoolStore(_env.REVIEW_ASSETS),
      rewriteHtmlText: async (html, sourceUrl, scopedProxyUrlFor) =>
        rewriteExternalHtmlReferences({
          html,
          sourceUrl,
          proxyUrlFor: scopedProxyUrlFor,
        }),
      rewriteCssText: async (css, sourceUrl, scopedProxyUrlFor) =>
        rewriteExternalCssReferences({
          css,
          sourceUrl,
          proxyUrlFor: scopedProxyUrlFor,
        }),
      htmlHeadEndContent: isHtml ? injectTrustedArtifactBridge("") : undefined,
      waitUntil: options.waitUntil,
    });
  }

  const nextHtml = isHtml
    ? injectTrustedArtifactBridge(
        rewriteRootRelativeHtmlReferences(
          await response.text(),
          rootAssetPrefix,
        ),
      )
    : rewriteRootRelativeCssReferences(await response.text(), rootAssetPrefix);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set(
    "content-type",
    contentType ||
      (isHtml ? "text/html; charset=utf-8" : "text/css; charset=utf-8"),
  );
  return new Response(nextHtml, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sandboxPreviewResponse(
  env: Env,
  requestUrl: string,
  projectId: string,
  projectName: string,
) {
  const requested = new URL(requestUrl);
  const previewUrl = new URL(requested.pathname, appBaseUrl(env, requestUrl));
  previewUrl.search = "";
  previewUrl.hash = "";
  return createTrustedReviewHostResponse({
    shipletId: projectId,
    revisionId: `sandbox_${projectId}`,
    title: projectName,
    artifactUrl: `${previewUrl.toString().replace(/\/$/, "")}/artifact-frame`,
    widgetUrl: null,
    hostScriptUrl: new URL(
      "/api/review/host.js",
      appBaseUrl(env, requestUrl),
    ).toString(),
    reviewApiUrl: new URL(
      `/api/projects/${encodeURIComponent(projectId)}/review-feedback`,
      appBaseUrl(env, requestUrl),
    ).toString(),
    reviewPageUrl: previewUrl.toString(),
    submissionMode: "sandbox",
  });
}

async function authorizeReviewRequest(
  env: Env,
  request: Request,
  project: Project,
  user: ShipletUser | null,
  requiredScopes: ReviewScope[],
) {
  const capability = await authenticateReviewCapability(
    env,
    request,
    project,
    requiredScopes,
  );
  if (capability) {
    return {
      user: reviewCapabilityUser(capability),
      token: null as OrganizationApiTokenRecord | null,
      capability,
    };
  }

  const authorization = request.headers.get("authorization");
  if (hasExplicitAuthorization(authorization)) {
    const token = await authenticateOptionalOrganizationCredential(
      env.DB,
      authorization,
      requiredScopes as OrganizationApiScope[],
    );
    requireOrganizationApiProjectAccess(token!, project);
    return {
      user: null,
      token: token!,
      capability: null as ReviewCapability | null,
    };
  }

  if (user && (await canViewProject(env.DB, project, user.id))) {
    return {
      user,
      token: null as OrganizationApiTokenRecord | null,
      capability: null as ReviewCapability | null,
    };
  }

  throw new Response("Review access required", { status: user ? 403 : 401 });
}

async function getReviewRequestUser(env: Env, request: Request) {
  const hasCookie = Boolean(request.headers.get("cookie"));
  const origin = request.headers.get("origin");
  if (hasCookie && !origin) {
    const fetchSite = (
      request.headers.get("sec-fetch-site") || ""
    ).toLowerCase();
    const refererOrigin = normalizeOrigin(request.headers.get("referer") || "");
    const appOrigin = controlPlaneOrigin(env, request.url);
    const hasControlPlaneContext = fetchSite
      ? fetchSite === "same-origin" || fetchSite === "none"
      : Boolean(refererOrigin && appOrigin && refererOrigin === appOrigin);
    if (!hasControlPlaneContext) return null;
  }
  if (
    !isControlPlaneOrigin(env, request.url, origin, {
      method: request.method,
      hasCookie,
    })
  ) {
    return null;
  }
  return getCurrentUser(request, env);
}

async function authenticateReviewCapability(
  env: Env,
  request: Request,
  project: Project,
  requiredScopes: ReviewScope[],
) {
  const token = reviewBearerToken(request);
  if (!token || !token.startsWith("shiplet_review_cap_v1.")) return null;
  const requiredCapabilityScopes = requiredScopes.filter(
    (scope): scope is ReviewCapabilityScope =>
      scope === "feedback:read" ||
      scope === "feedback:write" ||
      scope === "presence:join" ||
      scope === "watch:write",
  );
  const result = await verifyReviewCapabilityToken(token, {
    secret: reviewCapabilitySecret(env),
    projectId: project.id,
    requiredScopes: requiredCapabilityScopes,
  });
  if (!result.ok) {
    throw new Response("Review capability denied", {
      status: result.reason === "missing_scope" ? 403 : 401,
    });
  }
  return result.capability;
}

function reviewBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const headerMatch = authorization?.match(/^Bearer\s+(.+)$/i);
  if (headerMatch?.[1]) return headerMatch[1].trim();
  try {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/review-presence/ws")) {
      return url.searchParams.get("reviewToken") || null;
    }
  } catch {
    return null;
  }
  return null;
}

function artifactPreviewQueryToken(request: Request) {
  try {
    return new URL(request.url).searchParams.get(SHIPLET_PREVIEW_TOKEN_PARAM);
  } catch {
    return null;
  }
}

function artifactAccessCookieName(requestUrl: string) {
  return new URL(requestUrl).protocol === "https:"
    ? ARTIFACT_ACCESS_COOKIE
    : LOCAL_ARTIFACT_ACCESS_COOKIE;
}

function artifactAccessCookie(token: string, requestUrl: string) {
  const secure = new URL(requestUrl).protocol === "https:";
  const name = secure ? ARTIFACT_ACCESS_COOKIE : LOCAL_ARTIFACT_ACCESS_COOKIE;
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${5 * 60}`;
}

function tenantReviewMutationRejection(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  if (request.headers.get("origin") !== requestOrigin) {
    return new Response("Review mutation origin required", { status: 403 });
  }
  const mediaType = (request.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return new Response("Review mutation requires application/json", {
      status: 415,
    });
  }
  return null;
}

async function attachArtifactAccessCookie(
  response: Response,
  env: Env,
  requestUrl: string,
  project: Project,
  user: ShipletUser | null,
) {
  if (
    !user ||
    (!env.SHIPLET_REVIEW_TOKEN_SECRET && env.SHIPLET_AUTH_MODE !== "test")
  ) {
    return response;
  }
  const token = await issueReviewCapabilityToken(
    env,
    project,
    user,
    ["feedback:read", "feedback:write", "presence:join", "watch:write"],
    5 * 60,
  );
  const headers = new Headers(response.headers);
  headers.append("set-cookie", artifactAccessCookie(token, requestUrl));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function artifactCapabilityExchangeResponse(request: Request, token: string) {
  const url = new URL(request.url);
  url.searchParams.delete(SHIPLET_PREVIEW_TOKEN_PARAM);
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": artifactAccessCookie(token, request.url),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function staleArtifactCapabilityResponse(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete(SHIPLET_PREVIEW_TOKEN_PARAM);
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

async function verifyArtifactPreviewCapability(
  env: Env,
  token: string,
  project: Project,
) {
  const result = await verifyReviewCapabilityToken(token, {
    secret: reviewCapabilitySecret(env),
    projectId: project.id,
    requiredScopes: ["presence:join"],
  });
  return result.ok ? result.capability : null;
}

async function authenticateArtifactPreviewCapability(
  env: Env,
  request: Request,
  project: Project,
) {
  const token =
    getCookie(request, artifactAccessCookieName(request.url)) || null;
  if (!token) return null;
  return verifyArtifactPreviewCapability(env, token, project);
}

function reviewCapabilityUser(capability: ReviewCapability): ShipletUser {
  const now = new Date().toISOString();
  return {
    id: capability.viewer.id,
    email: capability.viewer.email,
    first_name: capability.viewer.name || null,
    last_name: null,
    avatar_preset: capability.viewer.avatarPreset || null,
    avatar_data_url: capability.viewer.avatarDataUrl || null,
    created_on: now,
    updated_on: now,
  };
}

async function requireReviewProject(c: any) {
  const project = await getProjectById(c.env.DB, c.req.param("projectId"));
  if (!project) {
    throw new Response("Shiplet not found", { status: 404 });
  }
  return project;
}

function reviewPresenceUserName(user: ShipletUser) {
  const parts = [user.first_name, user.last_name]
    .map((part) => normalizeOptionalString(part))
    .filter(Boolean);
  return parts.join(" ") || user.email;
}

async function listTrustedReviewMentionCandidates(
  env: Env,
  project: Project,
  user: ShipletUser | null,
  query: string,
  limit: number,
) {
  if (!project.organization_id || !user) return [];
  const membership = await getOrganizationMembership(
    env.DB,
    project.organization_id,
    user.id,
  );
  if (!membership) return [];
  const users = await listOrganizationMentionUsers(
    env.DB,
    project.organization_id,
    query,
    limit,
  );
  const hydrated = [];
  for (const mentionUser of users) {
    const participation = await getShipletParticipation(
      env.DB,
      project,
      mentionUser,
    );
    hydrated.push({
      id: mentionUser.id,
      email: mentionUser.email,
      name: reviewPresenceUserName(mentionUser),
      avatar_preset: mentionUser.avatar_preset || null,
      avatar_data_url: mentionUser.avatar_data_url || null,
      organization_role: mentionUser.organization_role,
      shiplet_access_status:
        participation.status === "none"
          ? "invite_required"
          : participation.status,
      grant_id: participation.grant_id || null,
    });
  }
  return hydrated;
}

function reviewClientUser(user: ShipletUser | null) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: reviewPresenceUserName(user),
    avatarPreset: user.avatar_preset || null,
    avatarDataUrl: user.avatar_data_url || null,
    kind: "user",
  };
}

function reviewPresenceRequest(
  request: Request,
  project: Project,
  user: ShipletUser | null,
) {
  const headers = new Headers(request.headers);
  headers.set("x-shiplet-presence-project-id", project.id);
  headers.set("x-shiplet-presence-project-name", project.name);
  if (user) {
    headers.set("x-shiplet-presence-user-id", user.id);
    headers.set("x-shiplet-presence-user-email", user.email);
    headers.set("x-shiplet-presence-user-name", reviewPresenceUserName(user));
    if (user.avatar_preset) {
      headers.set(
        "x-shiplet-presence-avatar-preset",
        String(user.avatar_preset),
      );
    }
  }
  return new Request(request, { headers });
}

function hasManagedAdvancedRuntime(env: Env, userId?: string) {
  const runtime = env as DeploymentRuntimeEnv;
  const gateway = runtime.CLOUDFLARE_MANAGED_RUNTIME_RPC;
  // A raw dispatch namespace is deliberately insufficient. Availability is
  // advertised only when the exact gateway surface and all non-secret release
  // pins are installed. Every actual mutation/invocation performs live release
  // and dependency readiness attestation again.
  return Boolean(
    cloudflareManagedRuntimeEnabledForUser(runtime, userId) &&
    runtime.CLOUDFLARE_CONTROL_PLANE_VERSION_ID &&
    runtime.CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID &&
    runtime.CLOUDFLARE_DENY_EGRESS_VERSION_ID &&
    runtime.CLOUDFLARE_SUPPORT_RELEASE_TAG &&
    gateway &&
    typeof gateway.contract === "function" &&
    typeof gateway.readiness === "function" &&
    typeof gateway.stageRevision === "function" &&
    typeof gateway.promote === "function" &&
    typeof gateway.rollback === "function" &&
    typeof gateway.invoke === "function" &&
    typeof gateway.invokeValidatedRevision === "function",
  );
}

function isExternalProject(project: Project) {
  return (
    project.source_type === "external_url" &&
    Boolean(project.external_origin_url)
  );
}

function standalonePreviewDownloadsAllowed(project: Project, assetPath = "/") {
  const normalizedPath = `/${assetPath}`.replace(/\/+/, "/");
  return (
    project.source_type === "static" &&
    project.script_content.startsWith(STANDALONE_ASSET_PREVIEW_MARKER) &&
    (normalizedPath === "/" || normalizedPath === "/index.html")
  );
}

function isPublicExternalArtifactRead(project: Project, request: Request) {
  return (
    isExternalProject(project) &&
    (request.method === "GET" || request.method === "HEAD")
  );
}

const EXTERNAL_TENANT_SUBRESOURCE_DESTINATIONS = new Set([
  "audio",
  "audioworklet",
  "empty",
  "font",
  "image",
  "manifest",
  "paintworklet",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "worker",
]);

function isExternalTenantSubresourceRead(project: Project, request: Request) {
  return (
    isPublicExternalArtifactRead(project, request) &&
    EXTERNAL_TENANT_SUBRESOURCE_DESTINATIONS.has(
      (request.headers.get("sec-fetch-dest") || "").toLowerCase(),
    )
  );
}

function externalOriginRequest(targetUrl: URL, request: Request) {
  const origin = new URL(targetUrl);

  const headers = new Headers();
  for (const name of [
    "accept",
    "accept-language",
    "if-modified-since",
    "if-none-match",
    "range",
    "user-agent",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Request(origin.toString(), {
    method: request.method,
    headers,
    redirect: "manual",
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
  });
}

function exposeExternalArtifactToOpaqueSandbox(
  request: Request,
  response: Response,
) {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  response.headers.delete("access-control-allow-credentials");
  response.headers.delete("set-cookie");
  response.headers.delete("set-cookie2");
  if (
    (response.status >= 200 && response.status < 300) ||
    response.status === 304 ||
    isExternalRedirectStatus(response.status)
  ) {
    response.headers.set("access-control-allow-origin", "*");
  } else {
    response.headers.delete("access-control-allow-origin");
  }
  return response;
}

async function externalOriginTargetUrl(
  env: Env,
  project: Project,
  request: Request,
) {
  const configured = new URL(project.external_origin_url || "");
  const requestUrl = new URL(request.url);
  if (
    requestUrl.pathname === EXTERNAL_RESOURCE_PROXY_PATH ||
    requestUrl.pathname.startsWith(`${EXTERNAL_RESOURCE_PROXY_PATH}/`)
  ) {
    return verifiedExternalResourceTarget({
      requestUrl,
      requestPath: requestUrl.pathname,
      secret: reviewCapabilitySecret(env),
      projectId: project.id,
    });
  }
  if (requestUrl.pathname === "/") {
    if (requestUrl.search) configured.search = requestUrl.search;
    return configured;
  }
  const target = new URL(requestUrl.pathname, configured.origin);
  target.search = requestUrl.search;
  return target;
}

function stripInternalArtifactSearchParams(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete(SHIPLET_PREVIEW_TOKEN_PARAM);
  const headers = new Headers(request.headers);
  const cookieName = artifactAccessCookieName(request.url);
  const platformCookieNames = new Set([
    cookieName,
    SESSION_COOKIE,
    ACCOUNT_GROUP_COOKIE,
    LEGACY_SESSION_COOKIE,
    LEGACY_ACCOUNT_GROUP_COOKIE,
    SANDBOX_COOKIE,
    SANDBOX_ACTOR_COOKIE,
  ]);
  const cookies = (headers.get("cookie") || "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => {
      if (!cookie) return false;
      const separator = cookie.indexOf("=");
      const name = separator === -1 ? cookie : cookie.slice(0, separator);
      return (
        !platformCookieNames.has(name) &&
        !name.startsWith(`${CLOUDFLARE_OAUTH_DELIVERY_COOKIE}_`) &&
        !name.startsWith(`${CLOUDFLARE_OAUTH_DELIVERY_COOKIE_LOCAL}_`)
      );
    });
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));
  else headers.delete("cookie");
  for (const headerName of [
    "authorization",
    "proxy-authorization",
    "x-shiplet-user-id",
    "x-shiplet-user-email",
  ]) {
    headers.delete(headerName);
  }
  const headerNames: string[] = [];
  headers.forEach((_value, headerName) => headerNames.push(headerName));
  for (const headerName of headerNames) {
    if (headerName.toLowerCase().startsWith("x-shiplet-")) {
      headers.delete(headerName);
    }
  }
  return new Request(url.toString(), {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
  });
}

function isSafeExternalFetchUrl(env: Env, url: URL) {
  if (
    url.toString().length > MAX_EXTERNAL_RESOURCE_URL_LENGTH ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    !isPublicHostname(url.hostname)
  ) {
    return false;
  }
  if (
    url.port &&
    !(
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    )
  ) {
    return false;
  }
  const hostname = normalizeRoutingHostname(url.hostname);
  const appHostname = appUrlHostname(env);
  const tenantDomain = env.CUSTOM_DOMAIN
    ? normalizeRoutingHostname(env.CUSTOM_DOMAIN)
    : null;
  return !(
    (appHostname && hostname === appHostname) ||
    (tenantDomain &&
      (hostname === tenantDomain || hostname.endsWith(`.${tenantDomain}`)))
  );
}

function isExternalRedirectStatus(status: number) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

async function serveExternalOrigin(
  env: Env,
  project: Project,
  request: Request,
  rootAssetPrefix?: string,
) {
  if (!project.external_origin_url) {
    return {
      response: new Response("External URL is not configured", { status: 502 }),
      finalUrl: null,
    };
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return {
      response: new Response("External review origins are read-only", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      }),
      finalUrl: null,
    };
  }
  const targetUrl = await externalOriginTargetUrl(env, project, request);
  if (!targetUrl || !isSafeExternalFetchUrl(env, targetUrl)) {
    return {
      response: new Response("External resource URL denied", { status: 502 }),
      finalUrl: null,
    };
  }
  let nextRequest = externalOriginRequest(targetUrl, request);
  const initialTargetUrl = nextRequest.url;
  const requestPath = new URL(request.url).pathname;
  const isPathCapabilityRequest = requestPath.startsWith(
    `${EXTERNAL_RESOURCE_PROXY_PATH}/`,
  );
  const visited = new Set<string>();
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const nextUrl = new URL(nextRequest.url);
    if (!isSafeExternalFetchUrl(env, nextUrl) || visited.has(nextUrl.href)) {
      return {
        response: new Response("External origin redirect denied", {
          status: 502,
        }),
        finalUrl: null,
      };
    }
    visited.add(nextUrl.href);
    try {
      response = await fetch(nextRequest);
    } catch {
      return {
        response: new Response("External origin unavailable", { status: 502 }),
        finalUrl: null,
      };
    }
    if (!isExternalRedirectStatus(response.status)) break;
    const location = response.headers.get("location");
    if (!location || redirectCount === 5) {
      return {
        response: new Response("External origin redirect denied", {
          status: 502,
        }),
        finalUrl: null,
      };
    }
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, nextUrl);
    } catch {
      return {
        response: new Response("External origin redirect denied", {
          status: 502,
        }),
        finalUrl: null,
      };
    }
    if (!isSafeExternalFetchUrl(env, redirectUrl)) {
      return {
        response: new Response("External origin redirect denied", {
          status: 502,
        }),
        finalUrl: null,
      };
    }
    nextRequest = new Request(redirectUrl.toString(), {
      method: request.method,
      headers: nextRequest.headers,
      redirect: "manual",
    });
  }
  if (!response) {
    return {
      response: new Response("External origin unavailable", { status: 502 }),
      finalUrl: null,
    };
  }
  if (
    isPathCapabilityRequest &&
    rootAssetPrefix !== undefined &&
    nextRequest.url !== initialTargetUrl
  ) {
    try {
      const proxyUrlFor = await createExternalResourceUrlBuilder({
        secret: reviewCapabilitySecret(env),
        projectId: project.id,
        rootAssetPrefix,
      });
      return {
        response: new Response(null, {
          status: 302,
          headers: {
            location: await proxyUrlFor(nextRequest.url),
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
          },
        }),
        finalUrl: null,
      };
    } catch {
      return {
        response: new Response("External origin redirect denied", {
          status: 502,
        }),
        finalUrl: null,
      };
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  return {
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    finalUrl: nextRequest.url,
  };
}

async function serveProjectArtifact(
  env: Env,
  request: Request,
  project: Project,
  user: ShipletUser | null,
  assetPath = "/",
  options: ArtifactResponseOptions = {},
) {
  const targetUrl = new URL(request.url);
  targetUrl.pathname = assetPath || "/";
  targetUrl.searchParams.delete(SHIPLET_PREVIEW_TOKEN_PARAM);
  const requestToForward = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
  });

  const revisionResponse = await serveActiveRevisionStaticArtifact(
    env,
    project,
    requestToForward,
    user?.id,
  );
  if (revisionResponse) {
    return injectReviewClient(
      env,
      requestToForward,
      revisionResponse,
      project,
      user,
      options,
    );
  }

  const managedResponse = await serveActiveManagedRuntimeArtifact(
    env,
    project,
    requestToForward,
    user?.id,
  );
  if (managedResponse) {
    return injectReviewClient(
      env,
      requestToForward,
      managedResponse,
      project,
      user,
      options,
    );
  }

  if (isExternalProject(project)) {
    const external = await serveExternalOrigin(
      env,
      project,
      requestToForward,
      options.rootAssetPrefix,
    );
    return injectReviewClient(
      env,
      requestToForward,
      external.response,
      project,
      user,
      { ...options, externalSourceUrl: external.finalUrl || undefined },
    );
  }

  if (project.source_type === "worker") {
    return new Response("Managed arbitrary Worker execution is unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_dynamic_unavailable",
      },
    });
  }

  const response = await serveStaticAsset(
    env.DB,
    env.SHIPLET_ASSETS,
    project,
    requestToForward,
  );
  if (!response)
    return new Response("Shiplet asset not found", { status: 404 });
  return injectReviewClient(
    env,
    requestToForward,
    response,
    project,
    user,
    options,
  );
}

async function requireBootstrapAccess(c: any) {
  const token = c.env.SHIPLET_BOOTSTRAP_TOKEN;
  if (!token) {
    throw new Response("Bootstrap is not configured", { status: 404 });
  }
  const authorization = c.req.header("authorization") || "";
  if (!(await timingSafeSecretMatches(`Bearer ${token}`, authorization))) {
    throw new Response("Bootstrap token required", { status: 401 });
  }
}

function uniqueInvitations(invitations: AppInvitationRecord[]) {
  const byId = new Map<string, AppInvitationRecord>();
  for (const invitation of invitations) {
    byId.set(invitation.id, invitation);
  }
  return [...byId.values()];
}

function publicAppInvitation(invitation: AppInvitationRecord) {
  return Object.freeze({
    id: invitation.id,
    organization_id: invitation.organization_id,
    team_id: invitation.team_id || null,
    project_id: invitation.project_id || null,
    email: invitation.email,
    invite_type: invitation.invite_type,
    role: invitation.role,
    status: invitation.status,
    workos_invitation_id: invitation.workos_invitation_id,
    created_on: invitation.created_on,
    accepted_on: invitation.accepted_on || null,
  });
}

function publicWorkOSInvitation(invitation: { id: string }) {
  return Object.freeze({ id: invitation.id });
}

async function organizationRoleForInvitation(
  env: Env,
  invitation: AppInvitationRecord,
) {
  if (invitation.invite_type !== "organization") return "member";
  const role = invitation.role || "member";
  if (role !== "admin") return role;

  const inviterMembership = await getOrganizationMembership(
    env.DB,
    invitation.organization_id,
    invitation.invited_by_user_id,
  );
  return inviterMembership?.role === "admin" ? "admin" : "member";
}

function logAuthEvent(
  level: "info" | "error",
  event: {
    outcome: string;
    reason?: string;
    invitationId?: string | null;
    projectId?: string | null;
  },
) {
  const payload = JSON.stringify({
    event: "auth.invitation",
    outcome: event.outcome,
    reason: event.reason,
    invitation_id: event.invitationId || undefined,
    project_id: event.projectId || undefined,
  });
  if (level === "error") console.error(payload);
  else console.info(payload);
}

async function syncAuthenticatedWorkOSUser(
  env: Env,
  workosUser: WorkOSUser,
  organizationId?: string | null,
) {
  const user = await resolveVerifiedWorkOSUser(env.DB, workosUser);

  if (organizationId) {
    const existingMembership = await getOrganizationMembership(
      env.DB,
      organizationId,
      user.id,
    );
    if (!existingMembership) {
      await createOrganizationMembershipRecord(env.DB, {
        id: `om_${organizationId}_${user.id}`,
        organization_id: organizationId,
        user_id: user.id,
        role: "member",
        created_on: timestamps.now(),
      });
    }
  }
  return user;
}

async function findPendingInvitationsForUser(
  env: Env,
  options: {
    invitationId?: string | null;
    invitationToken?: string | null;
    organizationId?: string | null;
    email?: string | null;
  },
) {
  let pendingInvitations: AppInvitationRecord[] = [];

  if (options.invitationId) {
    pendingInvitations = await findPendingInvitationsByWorkOSInvitationId(
      env.DB,
      options.invitationId,
    );
  }

  if (pendingInvitations.length === 0 && options.invitationToken) {
    pendingInvitations = await findPendingInvitationsByWorkOSInvitationToken(
      env.DB,
      options.invitationToken,
    );
  }

  if (
    pendingInvitations.length === 0 &&
    options.organizationId &&
    options.email
  ) {
    pendingInvitations = await findPendingInvitationsByEmailAndOrganization(
      env.DB,
      options.email.toLowerCase(),
      options.organizationId,
    );
  }

  return uniqueInvitations(pendingInvitations);
}

async function reconcilePendingInvitationsForUser(
  env: Env,
  workosUser: WorkOSUser,
  options: {
    invitationId?: string | null;
    invitationToken?: string | null;
    organizationId?: string | null;
    pendingInvitations?: AppInvitationRecord[];
  },
) {
  const email = workosUser.email.toLowerCase();
  // AuthKit can select an organization outside this Shiplet instance. Only
  // reconcile memberships for organizations already owned by this instance;
  // an unrelated provider organization must not block the user's login.
  const organizationId =
    options.organizationId &&
    (await getOrganizationById(env.DB, options.organizationId))
      ? options.organizationId
      : undefined;
  const user = await syncAuthenticatedWorkOSUser(
    env,
    workosUser,
    organizationId,
  );

  if (organizationId) {
    await ensureOrganizationMembershipRecord(env.DB, {
      id: `om_${organizationId}_${user.id}`,
      organization_id: organizationId,
      user_id: user.id,
      role: "member",
      created_on: timestamps.now(),
    });
  }

  const pendingInvitations = (
    options.pendingInvitations ||
    (await findPendingInvitationsForUser(env, {
      invitationId: options.invitationId,
      invitationToken: options.invitationToken,
      organizationId,
      email,
    }))
  ).filter((invitation) => invitation.email.trim().toLowerCase() === email);

  for (const invitation of pendingInvitations) {
    const organizationMembershipId = `om_${invitation.organization_id}_${user.id}`;
    if (invitation.organization_id) {
      await ensureOrganizationMembershipRecord(env.DB, {
        id: organizationMembershipId,
        organization_id: invitation.organization_id,
        user_id: user.id,
        role: await organizationRoleForInvitation(env, invitation),
        created_on: timestamps.now(),
      });
    }

    if (invitation.team_id) {
      await createTeamMembership(
        env.DB,
        invitation.team_id,
        user.id,
        organizationMembershipId,
      );
    }

    if (invitation.project_id) {
      const acceptedOn = timestamps.now();
      await createShipletGrant(env.DB, {
        id: newId("grant"),
        project_id: invitation.project_id,
        organization_id: invitation.organization_id,
        target_type: "user",
        target_id: user.id,
        email,
        role: invitation.role || "viewer",
        invited_by_user_id: invitation.invited_by_user_id,
        workos_invitation_id: invitation.workos_invitation_id,
        created_on: acceptedOn,
        accepted_on: acceptedOn,
      });
    }

    await acceptAppInvitation(env.DB, invitation.id);
  }

  return {
    user,
    reconciled: pendingInvitations.length,
    invitations: pendingInvitations,
  };
}

async function acceptInvitationConsentForUser(
  env: Env,
  requestUrl: string,
  workosUser: WorkOSUser,
  consent: InvitationConsent,
) {
  const project = await getProjectById(env.DB, consent.projectId);
  const returnProject = await projectFromAuthReturnTo(
    env,
    requestUrl,
    consent.returnTo,
  );
  if (
    !project ||
    project.archived_on ||
    !project.organization_id ||
    !returnProject ||
    returnProject.id !== project.id
  ) {
    logAuthEvent("error", {
      outcome: "rejected",
      reason: "invalid_scope",
      projectId: consent.projectId,
      invitationId: consent.invitationId,
    });
    throw new Response("Invitation scope is invalid", { status: 403 });
  }

  const email = workosUser.email.trim().toLowerCase();
  const user = await syncAuthenticatedWorkOSUser(env, workosUser);
  const pendingInvitations = consent.invitationId
    ? await findPendingInvitationById(env.DB, consent.invitationId)
    : await findPendingInvitationsByEmailAndProject(env.DB, email, project.id);
  const invitation = pendingInvitations[0];
  if (!invitation) {
    if (await canViewProject(env.DB, project, user.id)) {
      return { project, user, reconciled: 0 };
    }
    logAuthEvent("error", {
      outcome: "rejected",
      reason: "no_matching_invitation",
      projectId: project.id,
      invitationId: consent.invitationId,
    });
    throw new Response("Invitation is not available for this account", {
      status: 403,
    });
  }
  if (
    invitation.project_id !== project.id ||
    invitation.organization_id !== project.organization_id ||
    invitation.email.trim().toLowerCase() !== email
  ) {
    logAuthEvent("error", {
      outcome: "rejected",
      reason: "identity_or_scope_mismatch",
      projectId: project.id,
      invitationId: invitation.id,
    });
    throw new Response("Invitation is not available for this account", {
      status: 403,
    });
  }

  try {
    await acceptWorkOSInvitationForUser(env, {
      invitationId: invitation.workos_invitation_id,
      userId: workosUser.id,
      email,
      organizationId: invitation.organization_id,
    });
  } catch (error) {
    logAuthEvent("error", {
      outcome: "failed",
      reason: "workos_acceptance_failed",
      projectId: project.id,
      invitationId: invitation.id,
    });
    throw error;
  }
  const reconciliation = await reconcilePendingInvitationsForUser(
    env,
    workosUser,
    {
      organizationId: invitation.organization_id,
      pendingInvitations: [invitation],
    },
  );
  logAuthEvent("info", {
    outcome: "accepted",
    projectId: project.id,
    invitationId: invitation.id,
  });
  return {
    project,
    user: reconciliation.user,
    reconciled: reconciliation.reconciled,
  };
}

type PublishShipletPayload = {
  name?: unknown;
  subdomain?: unknown;
  script_content?: unknown;
  external_url?: unknown;
  custom_hostname?: unknown;
  assets?: unknown;
  organization_id?: unknown;
  visibility?: unknown;
  review_layer_source_shiplet_id?: unknown;
};

const PLATFORM_MCP_PROTOCOL_VERSION = "2025-06-18";
const SANDBOX_COOKIE = "shiplet_sandbox";
const SANDBOX_ACTOR_COOKIE = "shiplet_sandbox_actor";
const SANDBOX_SESSION_PATTERN = /^sbx_[a-z0-9]{24}$/;
const SANDBOX_ACTOR_PATTERN = /^sba_[a-z0-9]{32}$/;

function newSandboxActorId() {
  return `sba_${crypto.randomUUID().replace(/-/g, "")}`;
}

function sandboxCookie(sessionId: string) {
  return `${SANDBOX_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${24 * 60 * 60}`;
}

function sandboxActorCookie(actorId: string) {
  return `${SANDBOX_ACTOR_COOKIE}=${encodeURIComponent(actorId)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${24 * 60 * 60}`;
}

function validSandboxSessionId(value: string | null | undefined) {
  return Boolean(value && SANDBOX_SESSION_PATTERN.test(value));
}

function validSandboxActorId(value: string | null | undefined) {
  return Boolean(value && SANDBOX_ACTOR_PATTERN.test(value));
}

function sandboxSessionIdFromRequest(
  request: Request,
  url: URL,
  options: { ignoreCookie?: boolean } = {},
) {
  const fromQuery = url.searchParams.get("session");
  if (validSandboxSessionId(fromQuery)) return fromQuery as string;
  if (!options.ignoreCookie) {
    const fromCookie = getCookie(request, SANDBOX_COOKIE);
    if (validSandboxSessionId(fromCookie)) return fromCookie as string;
  }
  return SHARED_SANDBOX_SESSION_ID;
}

function sandboxActorIdFromRequest(request: Request, url: URL) {
  const fromQuery = url.searchParams.get("actor");
  if (validSandboxActorId(fromQuery)) return fromQuery as string;
  const fromCookie = getCookie(request, SANDBOX_ACTOR_COOKIE);
  if (validSandboxActorId(fromCookie)) return fromCookie as string;
  return newSandboxActorId();
}

function sandboxSessionIdForProject(projectId: string) {
  const match = projectId.match(/^sandbox-(sbx_[a-z0-9]{24})-.+$/);
  return match?.[1] || null;
}

function sandboxStub(env: Env, sessionId: string) {
  if (!env.SANDBOX_SESSION) {
    throw new Response("Sandbox sessions are not configured.", { status: 503 });
  }
  return env.SANDBOX_SESSION.getByName(sessionId);
}

function withSandboxCookies(
  response: Response,
  sessionId: string,
  actorId: string,
) {
  response.headers.append("set-cookie", sandboxCookie(sessionId));
  response.headers.append("set-cookie", sandboxActorCookie(actorId));
  return response;
}

function isSandboxProjectId(projectId: string) {
  return /^sandbox-sbx_[a-z0-9]{24}-.+/.test(projectId);
}

function sandboxProjectIdFromPreviewParam(value: string) {
  return decodeURIComponent(value);
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeVisibility(value: unknown): Project["visibility"] {
  if (
    value === "private" ||
    value === "organization" ||
    value === "unlisted" ||
    value === "public"
  ) {
    return value;
  }
  return "organization";
}

function normalizeExternalOriginUrl(value: unknown) {
  const raw = normalizeOptionalString(value);
  if (!raw) return "";
  if (raw.length > MAX_EXTERNAL_RESOURCE_URL_LENGTH) {
    throw new Response("External URL exceeds the URL limit.", { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Response("External URL must be a valid URL.", {
      status: 400,
    });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Response("External URL must use http or https.", {
      status: 400,
    });
  }
  if (
    url.username ||
    url.password ||
    !isPublicHostname(url.hostname) ||
    (url.port &&
      !(
        (url.protocol === "https:" && url.port === "443") ||
        (url.protocol === "http:" && url.port === "80")
      ))
  ) {
    throw new Response("External URL must be public.", { status: 400 });
  }

  url.hash = "";
  const normalized =
    url.pathname === "/" && !url.search ? url.origin : url.toString();
  if (normalized.length > MAX_EXTERNAL_RESOURCE_URL_LENGTH) {
    throw new Response("External URL exceeds the URL limit.", { status: 400 });
  }
  return normalized;
}

function normalizeCustomHostname(value: unknown) {
  const raw = normalizeOptionalString(value);
  if (!raw) return "";

  let hostname = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      hostname = url.hostname;
    } catch {
      throw new Response("Custom hostname must be a valid hostname.", {
        status: 400,
      });
    }
  } else if (raw.includes("/") || raw.includes("?") || raw.includes("#")) {
    throw new Response("Custom hostname must not include a path or query.", {
      status: 400,
    });
  }

  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !normalized ||
    normalized.includes("*") ||
    !normalized.includes(".") ||
    !isPublicHostname(normalized)
  ) {
    throw new Response("Custom hostname must be a public hostname.", {
      status: 400,
    });
  }

  return normalized;
}

function ipv4LiteralOctets(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  return octets.some((octet) => octet < 0 || octet > 255) ? null : octets;
}

function isPublicIpv4Literal(octets: number[]) {
  const [first, second, third] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function ipv6LiteralWords(value: string) {
  let normalized = value.toLowerCase();
  const embeddedIpv4 = normalized.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedIpv4) {
    const octets = ipv4LiteralOctets(embeddedIpv4[2]);
    if (!octets) return null;
    const ipv4Words = [
      (octets[0] << 8) | octets[1],
      (octets[2] << 8) | octets[3],
    ];
    normalized = `${normalized.slice(0, embeddedIpv4.index)}:${ipv4Words
      .map((word) => word.toString(16))
      .join(":")}`;
  }
  if ((normalized.match(/::/g) || []).length > 1) return null;
  const hasCompression = normalized.includes("::");
  const [left = "", right = ""] = normalized.split("::");
  const parseSide = (side: string) => {
    if (!side) return [];
    const pieces = side.split(":");
    if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
    return pieces.map((piece) => Number.parseInt(piece, 16));
  };
  const leftWords = parseSide(left);
  const rightWords = parseSide(right);
  if (!leftWords || !rightWords) return null;
  const explicitCount = leftWords.length + rightWords.length;
  if (
    (!hasCompression && explicitCount !== 8) ||
    (hasCompression && explicitCount >= 8)
  ) {
    return null;
  }
  return [
    ...leftWords,
    ...Array(hasCompression ? 8 - explicitCount : 0).fill(0),
    ...rightWords,
  ];
}

function isPublicIpv6Literal(words: number[]) {
  if (words.length !== 8) return false;
  const allZero = words.every((word) => word === 0);
  const loopback =
    words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (ipv4Mapped) {
    return isPublicIpv4Literal([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ]);
  }
  const nat64WellKnown =
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0);
  const nat64LocalUse =
    words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001;
  const discardOnly =
    words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0);
  const ietfProtocolAssignment =
    words[0] === 0x2001 && (words[1] & 0xfe00) === 0;
  const documentation =
    (words[0] === 0x2001 && words[1] === 0x0db8) ||
    (words[0] === 0x3fff && (words[1] & 0xf000) === 0);
  const sixToFour = words[0] === 0x2002;
  if (sixToFour) {
    return isPublicIpv4Literal([
      words[1] >> 8,
      words[1] & 0xff,
      words[2] >> 8,
      words[2] & 0xff,
    ]);
  }
  const globalUnicast = (words[0] & 0xe000) === 0x2000;
  return !(
    allZero ||
    loopback ||
    !globalUnicast ||
    nat64WellKnown ||
    nat64LocalUse ||
    discardOnly ||
    ietfProtocolAssignment ||
    documentation ||
    (words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xffc0) === 0xfec0 ||
    (words[0] & 0xff00) === 0xff00 ||
    words[0] === 0
  );
}

function isPublicHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const ipv4 = ipv4LiteralOctets(normalized);
  if (ipv4) return isPublicIpv4Literal(ipv4);
  if (normalized.includes(":")) {
    const ipv6 = ipv6LiteralWords(normalized);
    return Boolean(ipv6 && isPublicIpv6Literal(ipv6));
  }
  if (
    !normalized.includes(".") ||
    normalized.length > 253 ||
    !/^[a-z0-9.-]+$/.test(normalized) ||
    normalized
      .split(".")
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          label.startsWith("-") ||
          label.endsWith("-"),
      )
  ) {
    return false;
  }
  return ![
    ".localhost",
    ".local",
    ".internal",
    ".home.arpa",
    ".test",
    ".invalid",
    ".example",
    ".onion",
    ".lan",
  ].some(
    (suffix) => normalized === suffix.slice(1) || normalized.endsWith(suffix),
  );
}

async function createOrganizationForUser(
  env: Env,
  user: ShipletUser,
  name: string,
) {
  if (!name) {
    throw new Response("Missing required field: name", { status: 400 });
  }

  const pendingOrganizationId = `pending_org:${crypto.randomUUID().replace(/-/g, "")}`;
  const intent = await appendKernelAdminAuditEvent(env.DB, {
    organizationId: pendingOrganizationId,
    actor: { kind: "human", id: user.id },
    action: "organization.create",
    outcome: "intent",
    metadata: { targetKind: "organization" },
  });
  try {
    const organization = await createWorkOSOrganization(env, name);
    const workosUserId =
      (await latestWorkOSUserIdForLocalUser(env.DB, user.id)) || user.id;
    const membership = await createWorkOSOrganizationMembership(env, {
      organizationId: organization.id,
      userId: workosUserId,
      roleSlug: "admin",
    });

    await createOrganizationRecord(env.DB, {
      id: organization.id,
      name: organization.name,
      created_by_user_id: user.id,
      created_on: timestamps.now(),
    });
    await createOrganizationMembershipRecord(env.DB, {
      id: membership.id,
      organization_id: organization.id,
      user_id: user.id,
      role: "admin",
      created_on: timestamps.now(),
    });
    await appendKernelAdminAuditEvent(env.DB, {
      organizationId: organization.id,
      actor: { kind: "human", id: user.id },
      action: "organization.create",
      outcome: "succeeded",
      metadata: { targetKind: "organization", intentEventId: intent.id },
    });
    return { organization, membership };
  } catch (error) {
    await appendKernelAdminAuditEvent(env.DB, {
      organizationId: pendingOrganizationId,
      actor: { kind: "human", id: user.id },
      action: "organization.create",
      outcome: "failed",
      metadata: { targetKind: "organization", intentEventId: intent.id },
    });
    throw error;
  }
}

function defaultOrganizationName(user: ShipletUser) {
  const emailPrefix = user.email.split("@")[0]?.trim();
  if (emailPrefix) return `${emailPrefix}'s Workspace`;
  return "My Shiplet Workspace";
}

async function resolvePublishOrganizationId(env: Env, user: ShipletUser) {
  const organizations = await listOrganizationsForUser(env.DB, user.id);
  if (organizations.length === 1) return organizations[0].id;
  if (organizations.length > 1) {
    throw new Response("Missing required fields: organization_id", {
      status: 400,
    });
  }

  const { organization } = await createOrganizationForUser(
    env,
    user,
    defaultOrganizationName(user),
  );
  return organization.id;
}

async function publishShiplet(
  env: Env,
  db: D1QB,
  user: ShipletUser,
  payload: PublishShipletPayload,
) {
  const organizationId =
    normalizeOptionalString(payload.organization_id) ||
    (await resolvePublishOrganizationId(env, user));

  await requireOrganizationMembership(env.DB, organizationId, user.id);
  return await publishShipletForOrganization(
    env,
    db,
    user.id,
    organizationId,
    payload,
  );
}

async function publishShipletForOrganization(
  env: Env,
  db: D1QB,
  ownerUserId: string,
  organizationId: string,
  payload: PublishShipletPayload,
  initializationActor: ReviewLayerActor = {
    kind: "human",
    id: ownerUserId,
  },
) {
  const name = normalizeOptionalString(payload.name);
  const subdomain = normalizeOptionalString(payload.subdomain);
  const scriptContent = normalizeOptionalString(payload.script_content);
  const externalOriginUrl = normalizeExternalOriginUrl(payload.external_url);
  const customHostname = normalizeCustomHostname(payload.custom_hostname);
  const payloadOrganizationId = normalizeOptionalString(
    payload.organization_id,
  );
  const assets = normalizeAssetFiles(payload.assets);
  const visibility = normalizeVisibility(payload.visibility);
  const reviewLayerSourceShipletId = normalizeOptionalString(
    payload.review_layer_source_shiplet_id,
  );

  if (payloadOrganizationId && payloadOrganizationId !== organizationId) {
    throw new Response("Shiplet organization does not match credentials.", {
      status: 403,
    });
  }

  if (!name || !subdomain || !organizationId) {
    throw new Response(
      "Missing required fields: name, subdomain, organization_id",
      { status: 400 },
    );
  }

  if (!scriptContent && assets.length === 0 && !externalOriginUrl) {
    throw new Response(
      "Missing required fields: script_content or assets or external_url",
      {
        status: 400,
      },
    );
  }

  const sourceCount =
    (assets.length > 0 ? 1 : 0) +
    (scriptContent ? 1 : 0) +
    (externalOriginUrl ? 1 : 0);
  if (sourceCount > 1) {
    throw new Response(
      "Provide only one of assets, script_content, or external_url.",
      { status: 400 },
    );
  }

  if (!isDnsSafeShipletSubdomain(subdomain)) {
    throw new Response(
      "Subdomain must be DNS-safe: 1-63 lowercase letters or numbers with optional single hyphens between them",
      { status: 400 },
    );
  }

  const existingProject = await GetProjectBySubdomain(db, subdomain);
  if (existingProject) {
    throw new Response(
      "This URL is already taken. Please choose a different name.",
      { status: 409 },
    );
  }

  if (customHostname) {
    const existingCustomHostname = await GetProjectByCustomHostname(
      db,
      customHostname,
    );
    if (existingCustomHostname) {
      throw new Response("This domain is already active on the platform", {
        status: 409,
      });
    }
  }

  if (customHostname) {
    const customHostnameCreated = await createCustomHostname(
      env,
      customHostname,
    );
    if (!customHostnameCreated) {
      throw new Response(
        "Custom hostname could not be provisioned on Cloudflare. Check CLOUDFLARE_ZONE_ID and API token permissions, then try again.",
        { status: 502 },
      );
    }
  }

  let scriptPlaceholder: string;
  let staticAssetsToStore: AssetFile[] | null = null;
  let sourceType: Project["source_type"];

  if (externalOriginUrl) {
    sourceType = "external_url";
    scriptPlaceholder = `/* External artifact proxied from ${externalOriginUrl} */`;
  } else if (assets.length > 0) {
    sourceType = "static";
    const validAssets = assets.filter(
      (asset) => asset.path && asset.content && asset.content.length > 0,
    );
    if (validAssets.length === 0) {
      throw new Response(
        "No valid files found. Files may be empty or unsupported.",
        { status: 400 },
      );
    }

    const hasIndex = validAssets.some((asset) => {
      const path = asset.path.toLowerCase();
      return path === "index.html" || path.endsWith("/index.html");
    });

    staticAssetsToStore = hasIndex
      ? validAssets
      : [createStandaloneAssetPreviewIndex(name, validAssets), ...validAssets];

    scriptPlaceholder = hasIndex
      ? `/* Static site with ${staticAssetsToStore.length} assets stored in D1/R2 */`
      : `${STANDALONE_ASSET_PREVIEW_MARKER} /* ${staticAssetsToStore.length} assets stored in D1/R2 */`;
  } else {
    throw new Response(
      "Worker Code deployments require the revision-aware managed runtime gateway and outbound mediation. Use static assets on this deployment.",
      { status: 501 },
    );
  }

  const project: Project = {
    id: newId("project"),
    organization_id: organizationId,
    owner_user_id: ownerUserId,
    name,
    subdomain,
    custom_hostname: customHostname || null,
    source_type: sourceType,
    external_origin_url: externalOriginUrl || null,
    script_content: scriptPlaceholder,
    visibility,
    archived_on: null,
    delete_after: null,
    created_on: new Date().toISOString(),
    modified_on: new Date().toISOString(),
  };

  await CreateProject(db, project);
  if (staticAssetsToStore) {
    await storeStaticAssets(
      env.DB,
      env.SHIPLET_ASSETS,
      project.id,
      staticAssetsToStore,
    );
  }
  await migrateLegacyShipletRevision(env.DB, project.id, env.SHIPLET_ASSETS);

  let initialReviewLayer: ReviewLayer;
  let provenance:
    | { sourceShipletId: string; sourceVersion: string }
    | undefined;
  if (reviewLayerSourceShipletId) {
    const source = await getProjectById(env.DB, reviewLayerSourceShipletId);
    if (
      !source ||
      source.archived_on ||
      source.organization_id !== organizationId
    ) {
      throw new Response("Review layer source Shiplet is unavailable.", {
        status: 404,
      });
    }
    initialReviewLayer = await activeReviewLayerState(env, source);
    provenance = {
      sourceShipletId: source.id,
      sourceVersion: initialReviewLayer.version,
    };
  } else {
    initialReviewLayer = await defaultReviewLayerState(env, project);
  }
  await shipletRootStub(env, project.id).initialize({
    projectId: project.id,
    layer: initialReviewLayer,
    actor: initializationActor,
    provenance,
  });
  const initialized = await shipletRootStub(env, project.id).health(project.id);
  if (!initialized.reviewLayerVersion) {
    throw new Error("shiplet_root_initialization_failed");
  }

  return { ok: true, project };
}

async function handlePlatformMcpRequest(
  env: Env,
  db: D1QB,
  user: ShipletUser,
  request: Request,
  body: unknown,
) {
  return handleCodeModeMcpRequest(
    env,
    db,
    { kind: "user", user },
    request,
    body,
  );
}

async function handleSandboxMcpRequest(
  env: Env,
  sessionId: string,
  actorId: string,
  appUrl: string,
  body: unknown,
) {
  const request = isRecord(body) ? body : {};
  const id = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";
  const params = isRecord(request.params) ? request.params : {};

  try {
    if (method === "initialize") {
      return mcpResult(id, {
        protocolVersion: PLATFORM_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "shiplet-sandbox-codemode", version: "0.1.0" },
      });
    }

    if (method === "tools/list") {
      return mcpResult(id, {
        tools: [
          {
            name: "search",
            description:
              "Search the Shiplet sandbox API surface. Pass JavaScript like async () => await codemode.spec().",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
          {
            name: "execute",
            description:
              "Execute sandbox Shiplet API calls with codemode.request({ method, path, query, body }).",
            inputSchema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
        ],
      });
    }

    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = await callSandboxCodeModeTool(
        env,
        sessionId,
        actorId,
        appUrl,
        name,
        args,
      );
      return mcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }

    return mcpError(id, -32601, "Method not found.");
  } catch (error) {
    if (isResponse(error)) {
      const message = await error.text();
      return mcpError(id, error.status, message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return mcpError(id, -32000, message);
  }
}

async function callSandboxCodeModeTool(
  env: Env,
  sessionId: string,
  actorId: string,
  appUrl: string,
  name: string,
  args: Record<string, unknown>,
) {
  const code = normalizeOptionalString(args.code);
  if (!code) {
    throw new Response("Missing required field: code", { status: 400 });
  }

  if (name === "search") {
    if (!codeReadsSpec(code)) {
      throw new Response("Search code must call codemode.spec().", {
        status: 400,
      });
    }
    return {
      ...SHIPLET_OPENAPI_SPEC,
      "x-shiplet-sandbox": {
        baseUrl: appUrl,
        mcpUrl: `${appUrl}/api/play/mcp?session=${encodeURIComponent(sessionId)}&actor=${encodeURIComponent(actorId)}`,
        note: "Sandbox MCP reads are scoped to this actor by default. Pass includeSharedUntrusted: true only when intentionally pulling the shared public room.",
      },
    };
  }

  if (name === "execute") {
    const request = parseCodeModeRequest(code);
    return executeSandboxCodeModeRequest(
      env,
      sessionId,
      actorId,
      appUrl,
      request,
    );
  }

  throw new Error(`Unknown Code Mode tool: ${name}`);
}

async function executeSandboxCodeModeRequest(
  env: Env,
  sessionId: string,
  actorId: string,
  appUrl: string,
  request: CodeModeRequestOptions,
) {
  const stub = sandboxStub(env, sessionId);
  const body = isRecord(request.body) ? request.body : {};

  if (request.path === "/api/shiplets" && request.method === "GET") {
    return stub.listShiplets(sessionId);
  }

  if (request.path === "/api/shiplets" && request.method === "POST") {
    return stub.publishShiplet(sessionId, appUrl, body);
  }

  const feedbackListMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback$/,
  );
  if (feedbackListMatch && request.method === "GET") {
    return {
      feedback: await stub.listFeedback(sessionId, feedbackListMatch[1], {
        pageUrl: stringQuery(request.query?.pageUrl),
        status: stringQuery(request.query?.status),
        includeClosed: request.query?.includeClosed === true,
        includeSharedUntrusted: request.query?.includeSharedUntrusted === true,
        actorId,
        limit:
          typeof request.query?.limit === "number"
            ? request.query.limit
            : undefined,
      }),
    };
  }

  if (feedbackListMatch && request.method === "POST") {
    const validation = validateReviewFeedbackPayload(body);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    return {
      ok: true,
      feedback: await stub.createFeedback(
        sessionId,
        feedbackListMatch[1],
        actorId,
        sandboxFeedbackInput(validation.value),
      ),
    };
  }

  const replyMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback\/([^/]+)\/replies$/,
  );
  if (replyMatch && request.method === "POST") {
    const feedback = await stub.createReply(
      sessionId,
      replyMatch[1],
      replyMatch[2],
      actorId,
      String(body.comment || ""),
      { requireActorOwned: true },
    );
    if (!feedback) {
      throw new Response("Review feedback not found", { status: 404 });
    }
    return { feedback };
  }

  const statusMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback\/([^/]+)\/status$/,
  );
  if (statusMatch && request.method === "POST") {
    const feedback = await stub.updateStatus(
      sessionId,
      statusMatch[1],
      statusMatch[2],
      String(body.status || ""),
      { actorId, requireActorOwned: true },
    );
    if (!feedback) {
      throw new Response("Review feedback not found", { status: 404 });
    }
    return { feedback };
  }

  throw new Response("Sandbox Code Mode request path is not supported.", {
    status: 404,
  });
}

type CodeModeContext =
  | { kind: "user"; user: ShipletUser }
  | { kind: "token"; token: OrganizationApiTokenRecord }
  | { kind: "oauth_agent"; principal: AuthenticatedMcpAgentPrincipal };

function codeModeSubject(context: CodeModeContext): ShipletUser | null {
  if (context.kind === "user") return context.user;
  if (context.kind === "oauth_agent") return context.principal.subject;
  return null;
}

function codeModeAgentActor(
  context: CodeModeContext,
): Readonly<{ kind: "agent"; id: string }> | undefined {
  if (context.kind === "token") {
    return Object.freeze({ kind: "agent", id: context.token.id });
  }
  return context.kind === "oauth_agent" ? context.principal.actor : undefined;
}

function requireCodeModeOAuthPermission(
  context: CodeModeContext,
  permission: string,
) {
  if (
    context.kind === "oauth_agent" &&
    !context.principal.permissions.includes(permission)
  ) {
    throw new Response("Delegated MCP permission denied", { status: 403 });
  }
}

const CUSTOM_MCP_LIMITS: Readonly<CustomMcpLimits> = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxTools: 32,
  maxNameBytes: 64,
  maxDescriptionBytes: 1_024,
  maxSchemaBytes: 16 * 1024,
  maxHandlerBytes: 256 * 1024,
  maxInputBytes: 64 * 1024,
  maxResultBytes: 64 * 1024,
  maxTreeDepth: 16,
  maxTreeNodes: 2_048,
  maxCapabilityCalls: 4,
  maxCapabilityRequestBytes: 8 * 1024,
  maxExecutionMs: 1_000,
});
const MAX_MCP_REQUEST_BYTES = 128 * 1024;
const CUSTOM_MCP_APPROVAL_TTL_MS = 10 * 60_000;
const CUSTOM_MCP_QUARANTINE_TTL_MS = 10 * 60_000;
const CUSTOM_MCP_MODEL_BOUNDARY = createCustomMcpModelBoundary({
  maxTextBytes: CUSTOM_MCP_LIMITS.maxResultBytes,
});
const CUSTOM_MCP_RUNTIME_ISOLATION_POLICY: CustomMcpRuntimeIsolationPolicy =
  Object.freeze({
    schemaVersion: "shiplet.runtime-isolation-policy/v1",
    hardTermination: "enforced",
    maxCpuMs: CUSTOM_MCP_LIMITS.maxExecutionMs,
    maxMemoryBytes: 128 * 1024 * 1024,
    maxSubrequests: CUSTOM_MCP_LIMITS.maxCapabilityCalls,
    outboundNetwork: "deny_by_default",
    ambientBindings: "none",
    ambientSecrets: "none",
  });
const CUSTOM_MCP_RUNTIME_ATTESTATION_AUTHORITY =
  createCustomMcpRuntimeIsolationAttestationAuthority();

function resolveCustomMcpRuntimeIsolation(
  env: DeploymentRuntimeEnv,
): VerifiedCustomMcpRuntimeIsolation | null {
  if (typeof env.CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC?.start === "function") {
    try {
      return createCloudflareCustomMcpRpcIsolation({
        rpc: env.CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC,
        attestationAuthority: CUSTOM_MCP_RUNTIME_ATTESTATION_AUTHORITY,
        expectation: cloudflareSupportExpectation(env, "runtime_gateway"),
      });
    } catch {
      return null;
    }
  }
  // Structural isolation remains available only to the Miniflare harness.
  // Production fails closed unless the named Dynamic Worker RPC binding is
  // present and can attest the exact immutable handler binding and policy.
  if (
    env.SHIPLET_AUTH_MODE !== "test" ||
    typeof env.CUSTOM_MCP_RUNTIME_ISOLATION?.bind !== "function"
  ) {
    return null;
  }
  const testIsolation = env.CUSTOM_MCP_RUNTIME_ISOLATION;
  return Object.freeze({
    bind(binding: CustomMcpRuntimeIsolationBinding) {
      const transport = testIsolation.bind(binding);
      if (
        typeof transport !== "object" ||
        transport === null ||
        typeof transport.invoke !== "function" ||
        typeof transport.cancel !== "function"
      ) {
        throw new TypeError("test_runtime_isolation_unavailable");
      }
      return Object.freeze({
        transport,
        attestation: CUSTOM_MCP_RUNTIME_ATTESTATION_AUTHORITY.issue(binding),
      });
    },
  });
}

const CUSTOM_MCP_DENIAL_OUTCOMES = new Set([
  "approval_required",
  "audit_unavailable",
  "capability_deadline_exceeded",
  "capability_denied",
  "capability_effect_mismatch",
  "capability_limit_exceeded",
  "capability_payload_too_large",
  "egress_denied",
]);

async function recordCustomMcpNestedCapabilityDenial(
  db: D1Database,
  event: CustomMcpNestedCapabilityDenialAuditEvent,
) {
  const bounded = (value: unknown, maxBytes: number): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maxBytes;
  if (
    event?.schemaVersion !== "shiplet.audit.custom-mcp-nested-denial/v1" ||
    event.eventKind !== "custom_mcp.nested_capability_denied" ||
    !CUSTOM_MCP_DENIAL_OUTCOMES.has(event.outcome) ||
    !["human", "agent", "shiplet", "system"].includes(event.actorKind) ||
    !bounded(event.actorId, 256) ||
    !bounded(event.shipletId, 256) ||
    !bounded(event.revisionId, 256) ||
    !Number.isSafeInteger(event.activationGeneration) ||
    event.activationGeneration <= 0 ||
    !bounded(event.toolName, 512) ||
    !bounded(event.parentRequestId, 256) ||
    !Number.isSafeInteger(event.subcallOrdinal) ||
    event.subcallOrdinal <= 0 ||
    (event.declaredCapability !== null &&
      !CUSTOM_MCP_SUPPORTED_CAPABILITIES.includes(event.declaredCapability))
  ) {
    throw new TypeError("invalid_custom_mcp_denial_audit");
  }
  const now = Date.now();
  const payload = JSON.stringify({
    schemaVersion: event.schemaVersion,
    outcome: event.outcome,
    activationGeneration: event.activationGeneration,
    toolName: event.toolName,
    parentRequestId: event.parentRequestId,
    subcallOrdinal: event.subcallOrdinal,
    declaredCapability: event.declaredCapability,
  });
  if (new TextEncoder().encode(payload).byteLength > 8_192) {
    throw new TypeError("custom_mcp_denial_audit_too_large");
  }
  const result = await db
    .prepare(
      `INSERT INTO shiplet_audit_events (
       id, project_id, revision_id, deployment_id, actor_kind, actor_id,
       event_kind, summary, status_category, payload_json,
       occurred_on, recorded_on
      ) SELECT ?, project.id, revision.id, NULL, ?, ?, ?, ?, 'rejected', ?, ?, ?
       FROM projects project
       JOIN shiplet_revisions revision
        ON revision.id = project.active_revision_id
        AND revision.project_id = project.id
       WHERE project.id = ? AND revision.id = ?
        AND project.active_revision_generation = ?`,
    )
    .bind(
      `audit_${crypto.randomUUID()}`,
      event.actorKind,
      event.actorId,
      event.eventKind,
      "Custom MCP nested capability denied",
      payload,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      event.shipletId,
      event.revisionId,
      event.activationGeneration,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("custom_mcp_denial_audit_scope_stale");
  }
}

async function recordCustomMcpActorPolicyDenial(input: {
  db: D1Database;
  actor: ShipletActor;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  capability: string;
}) {
  const now = Date.now();
  const result = await input.db
    .prepare(
      `INSERT INTO shiplet_audit_events (
       id, project_id, revision_id, deployment_id, actor_kind, actor_id,
       event_kind, summary, status_category, payload_json,
       occurred_on, recorded_on
      ) SELECT ?, project.id, revision.id, NULL, ?, ?,
       'custom_mcp.actor_policy_denied',
       'Custom MCP actor authority denied', 'rejected', ?, ?, ?
       FROM projects project
       JOIN shiplet_revisions revision
        ON revision.id = project.active_revision_id
        AND revision.project_id = project.id
       WHERE project.id = ? AND revision.id = ?
        AND project.active_revision_generation = ?`,
    )
    .bind(
      `audit_${crypto.randomUUID()}`,
      input.actor.kind,
      input.actor.id,
      JSON.stringify({
        activationGeneration: input.activationGeneration,
        capability: input.capability,
      }),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      input.shipletId,
      input.revisionId,
      input.activationGeneration,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("custom_mcp_actor_policy_audit_scope_stale");
  }
}

function customMcpQuarantineBroker(input: {
  db: D1Database;
  now: () => number;
  activeRevisionFence?: Readonly<{
    shipletId: string;
    revisionId: string;
    packageDigest: string;
    activationGeneration: number;
  }>;
  releaseAuditActorId?: string;
  authorizeTrustedHumanRender?: Parameters<
    typeof createCustomMcpQuarantineBroker
  >[0]["authorizeTrustedHumanRender"];
}) {
  const d1Vault = createD1CustomMcpQuarantineVault({
    db: input.db,
    now: input.now,
    ...(input.activeRevisionFence
      ? { activeRevisionFence: input.activeRevisionFence }
      : {}),
  });
  return createCustomMcpQuarantineBroker({
    vault: input.releaseAuditActorId
      ? Object.freeze({
          store: d1Vault.store,
          consume: (request: Parameters<typeof d1Vault.consumeWithAudit>[0]) =>
            d1Vault.consumeWithAudit(request, {
              actorId: input.releaseAuditActorId!,
            }),
        })
      : d1Vault,
    now: input.now,
    ttlMs: CUSTOM_MCP_QUARANTINE_TTL_MS,
    authorizeTrustedHumanRender:
      input.authorizeTrustedHumanRender ?? (async () => null),
  });
}

function createProductionCustomMcpApprovalService(input: {
  env: Env;
  now: () => number;
  capabilityKernel: ReturnType<typeof createD1CapabilityKernel>;
}): CustomMcpApprovalService {
  return createD1CustomMcpApprovalService({
    db: input.env.DB,
    now: input.now,
    limits: {
      maxApprovalTtlMs: CUSTOM_MCP_APPROVAL_TTL_MS,
      maxInputBytes: CUSTOM_MCP_LIMITS.maxCapabilityRequestBytes,
      maxResultBytes: CUSTOM_MCP_LIMITS.maxResultBytes,
      maxMetadataBytes: 1_024,
      claimLeaseMs: 5_000,
      dispatchLeaseMs: 5_000,
    },
    async resolveActiveRevision(shipletId) {
      return input.env.DB.prepare(
        `SELECT active_revision_id, active_revision_generation
				 FROM projects WHERE id = ? AND archived_on IS NULL LIMIT 1`,
      )
        .bind(shipletId)
        .first<{
          active_revision_id: string | null;
          active_revision_generation: number;
        }>()
        .then((row) =>
          row
            ? {
                revisionId: row.active_revision_id,
                activationGeneration: row.active_revision_generation,
              }
            : null,
        );
    },
    issueTrustedApproval: (request) =>
      input.capabilityKernel.issueTrustedApprovalIdempotent(request),
    resolveCapabilityGrant: (request) =>
      input.capabilityKernel.resolveGrantAuthority(request),
    async resolveDispatchAuthorityAtomically(request) {
      const resolved =
        await input.capabilityKernel.resolveDispatchAuthorityAtomically(
          request,
        );
      return resolved
        ? Object.freeze({
            authorized: true as const,
            activationFence: Object.freeze({ ...resolved.activationFence }),
            grant: Object.freeze({
              id: resolved.grant.id,
              generation: resolved.grant.generation,
              expiresAt: resolved.grant.expiresAt,
              revokedAt: null,
            }),
            approval: Object.freeze({ ...resolved.approval }),
          })
        : null;
    },
    revokeTrustedApproval: (request) =>
      input.capabilityKernel.revokeTrustedApproval(request),
    compensateTrustedApproval: (request) =>
      input.capabilityKernel.compensateTrustedApproval(request),
    reconcileTrustedApprovalIssuance: ({ idempotencyKey }) =>
      input.capabilityKernel.reconcileTrustedApprovalIssuance({
        idempotencyKey,
      }),
  });
}

function trustedCustomMcpApprovalInvocation(input: {
  context: CodeModeContext;
  binding: CustomMcpTrustedChildMutationBinding;
}): TrustedCustomMcpApprovalInvocation {
  return Object.freeze({
    invokerActor: Object.freeze({ ...input.binding.actor }),
    trustedApprover: Object.freeze({
      kind: "human" as const,
      id:
        input.context.kind === "user"
          ? input.context.user.id
          : input.context.kind === "oauth_agent"
            ? input.context.principal.subject.id
            : input.context.token.created_by_user_id,
    }),
    shipletId: input.binding.shipletId,
    revisionId: input.binding.revisionId,
    activationGeneration: input.binding.activationGeneration,
    toolName: input.binding.toolName,
    parentRequestId: input.binding.parentRequestId,
    toolInput: input.binding.toolInput,
    declaredCapabilities: input.binding.declaredCapabilities,
    ttlMs: CUSTOM_MCP_APPROVAL_TTL_MS,
  });
}

function trustedCustomMcpChildMutation(
  binding: CustomMcpTrustedChildMutationBinding,
) {
  return Object.freeze({
    actor: binding.actor,
    shipletId: binding.shipletId,
    revisionId: binding.revisionId,
    parentRequestId: binding.parentRequestId,
    childRequestId: binding.childRequestId,
    capability: binding.capability,
    resource: binding.resource,
    effect: "mutation" as const,
    input: binding.input,
  });
}

const CUSTOM_MCP_SUPPORTED_CAPABILITIES = Object.freeze([
  "state.read:review",
  "state.write",
  "workflow.event:create",
  "review.feedback.read",
  "review.feedback.write",
  "egress.fetch",
]);
const REVISION_MCP_MANIFEST_VALIDATOR = createRevisionMcpManifestValidator({
  supportedRuntimeVersions: ["shiplet.runtime/v1"],
  supportedCapabilities: CUSTOM_MCP_SUPPORTED_CAPABILITIES,
  limits: CUSTOM_MCP_LIMITS,
});

const CUSTOM_MCP_AGENT_SCOPES = new Set<OrganizationApiScope>([
  "shiplets:read",
  "shiplets:write",
  "shiplets:archive",
  "feedback:read",
  "feedback:write",
  "mcp",
]);

export function productionCustomMcpAuthorityPolicy(
  db: D1Database,
  delegatedPrincipal?: AuthenticatedMcpAgentPrincipal,
) {
  return createCustomMcpAuthorityPolicy({
    async resolveAuthority({ actor, shipletId }) {
      const project = await getProjectById(db, shipletId);
      if (!project) return null;
      if (actor.kind === "human") {
        const user = await getUser(db, actor.id);
        if (!user) return null;
        const [canView, canEdit] = await Promise.all([
          canViewProject(db, project, user.id),
          canEditProject(db, project, user),
        ]);
        return Object.freeze({
          active: !project.archived_on,
          canView,
          canEdit,
          scopes: Object.freeze([]),
        });
      }
      if (actor.kind !== "agent") return null;
      if (delegatedPrincipal && actor.id === delegatedPrincipal.actor.id) {
        const organizationMatches =
          delegatedPrincipal.organizationId !== null &&
          project.organization_id === delegatedPrincipal.organizationId;
        const [canView, canEdit] = organizationMatches
          ? await Promise.all([
              canViewProject(db, project, delegatedPrincipal.subject.id),
              canEditProject(db, project, delegatedPrincipal.subject),
            ])
          : [false, false];
        const scopes = delegatedPrincipal.permissions.filter(
          (scope): scope is OrganizationApiScope =>
            CUSTOM_MCP_AGENT_SCOPES.has(scope as OrganizationApiScope),
        );
        return Object.freeze({
          active: !project.archived_on && canView,
          canView,
          canEdit,
          scopes: Object.freeze(scopes),
        });
      }
      const row = await db
        .prepare(
          `SELECT id, organization_id, name, scopes, project_access_mode,
           created_by_user_id, created_on, last_used_on, revoked_on
           FROM organization_api_tokens WHERE id = ? LIMIT 1`,
        )
        .bind(actor.id)
        .first<{
          id: string;
          organization_id: string;
          name: string;
          scopes: string;
          project_access_mode: "all" | "selected";
          created_by_user_id: string;
          created_on: string;
          last_used_on: string | null;
          revoked_on: string | null;
        }>();
      if (!row) return null;
      const rules = await db
        .prepare(
          `SELECT token_id, project_id, effect, created_on
           FROM organization_api_token_project_rules WHERE token_id = ?
           ORDER BY created_on ASC`,
        )
        .bind(row.id)
        .all<{
          token_id: string;
          project_id: string;
          effect: "allow" | "deny";
          created_on: string;
        }>();
      const scopes = row.scopes
        .split(",")
        .filter((scope): scope is OrganizationApiScope =>
          CUSTOM_MCP_AGENT_SCOPES.has(scope as OrganizationApiScope),
        );
      const token: OrganizationApiTokenRecord = Object.freeze({
        ...row,
        scopes: [...scopes],
        project_access_mode:
          row.project_access_mode === "selected" ? "selected" : "all",
        project_rules: [...rules.results],
      });
      const projectAllowed =
        row.revoked_on === null &&
        !project.archived_on &&
        canOrganizationApiTokenAccessProject(token, project);
      return Object.freeze({
        active: projectAllowed,
        canView: projectAllowed,
        canEdit: projectAllowed,
        scopes: Object.freeze(scopes),
      });
    },
  });
}

function customMcpCapabilityGrantRequirements(capability: string) {
  if (capability === "state.read:review") {
    return Object.freeze({
      resource: "state:review",
      effect: "read" as const,
      approval: "none" as const,
    });
  }
  if (capability === "state.write") {
    return Object.freeze({
      resource: "state:private",
      effect: "mutation" as const,
      approval: "trusted-human" as const,
    });
  }
  if (capability === "workflow.event:create") {
    return Object.freeze({
      resource: "workflow:events",
      effect: "mutation" as const,
      approval: "trusted-human" as const,
    });
  }
  if (
    capability === "review.feedback.read" ||
    capability === "review.feedback.write"
  ) {
    const effect = capability.endsWith(".write") ? "mutation" : "read";
    return Object.freeze({
      resource: "review:feedback",
      effect,
      approval: effect === "mutation" ? "trusted-human" : "none",
    });
  }
  return null;
}

const CODE_MODE_KERNEL_TOOLS = Object.freeze([
  Object.freeze({
    name: "search",
    description:
      "Search the Shiplet OpenAPI spec. Pass JavaScript like async () => await codemode.spec().",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        code: Object.freeze({
          type: "string",
          description:
            "JavaScript async arrow function that reads codemode.spec().",
        }),
      }),
      required: Object.freeze(["code"]),
    }),
    trust: "trusted_kernel" as const,
  }),
  Object.freeze({
    name: "execute",
    description:
      "Execute Shiplet API calls. First use search, then call codemode.request({ method, path, query, body }).",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        code: Object.freeze({
          type: "string",
          description:
            "JavaScript async arrow function that calls codemode.request({...}).",
        }),
      }),
      required: Object.freeze(["code"]),
    }),
    trust: "trusted_kernel" as const,
  }),
]);

type ActiveCustomMcpPackage = {
  verifiedRegistry: CompiledCustomMcpRegistry;
  workflowSchema: ReturnType<typeof parseWorkflowSchema>;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
};

type CustomMcpProjectedFile = Readonly<{
  path: string;
  sha256: string;
  size: number;
}>;

type CustomMcpProjection = Readonly<{
  manifest: CustomMcpProjectedFile;
  workflow: CustomMcpProjectedFile;
  packageRequestedCapabilities: readonly string[];
  handlers: readonly CustomMcpProjectedFile[];
}>;

const CUSTOM_MCP_PROJECTION_MAX_BYTES = 128 * 1024;
const CUSTOM_MCP_WORKFLOW_MAX_BYTES = 1024 * 1024;
const CUSTOM_MCP_PROJECTED_FILES_MAX_BYTES =
  CUSTOM_MCP_LIMITS.maxManifestBytes +
  CUSTOM_MCP_WORKFLOW_MAX_BYTES +
  CUSTOM_MCP_LIMITS.maxTools * CUSTOM_MCP_LIMITS.maxHandlerBytes;
const CUSTOM_MCP_FILE_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function parseCustomMcpProjectedFile(
  value: unknown,
  input: { kind: "manifest" | "workflow" | "handler"; maxBytes: number },
): CustomMcpProjectedFile | null {
  if (!isRecord(value)) return null;
  const path = value.path;
  const sha256 = value.sha256;
  const size = value.size;
  const pathValid =
    input.kind === "manifest"
      ? path === "mcp/manifest.json"
      : input.kind === "workflow"
        ? path === "workflow/schema.json"
        : typeof path === "string" &&
          /^mcp\/handlers\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u.test(path);
  if (
    !pathValid ||
    typeof path !== "string" ||
    typeof sha256 !== "string" ||
    !CUSTOM_MCP_FILE_DIGEST_PATTERN.test(sha256) ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    (size as number) > input.maxBytes
  ) {
    return null;
  }
  return Object.freeze({ path, sha256, size: size as number });
}

function parseCustomMcpProjection(
  value: string | null,
): CustomMcpProjection | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > CUSTOM_MCP_PROJECTION_MAX_BYTES
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== "shiplet.custom-mcp-projection/v1" ||
    !Array.isArray(parsed.packageRequestedCapabilities) ||
    parsed.packageRequestedCapabilities.length >
      CUSTOM_MCP_SUPPORTED_CAPABILITIES.length ||
    parsed.packageRequestedCapabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        !CUSTOM_MCP_SUPPORTED_CAPABILITIES.includes(capability),
    ) ||
    new Set(parsed.packageRequestedCapabilities).size !==
      parsed.packageRequestedCapabilities.length ||
    !Array.isArray(parsed.handlers) ||
    parsed.handlers.length > CUSTOM_MCP_LIMITS.maxTools
  ) {
    return null;
  }
  const manifest = parseCustomMcpProjectedFile(parsed.manifest, {
    kind: "manifest",
    maxBytes: CUSTOM_MCP_LIMITS.maxManifestBytes,
  });
  const workflow = parseCustomMcpProjectedFile(parsed.workflow, {
    kind: "workflow",
    maxBytes: CUSTOM_MCP_WORKFLOW_MAX_BYTES,
  });
  const handlers = parsed.handlers.map((handler) =>
    parseCustomMcpProjectedFile(handler, {
      kind: "handler",
      maxBytes: CUSTOM_MCP_LIMITS.maxHandlerBytes,
    }),
  );
  if (!manifest || !workflow || handlers.some((handler) => handler === null)) {
    return null;
  }
  const verifiedHandlers = handlers as CustomMcpProjectedFile[];
  if (
    new Set(verifiedHandlers.map((file) => file.path)).size !== handlers.length
  ) {
    return null;
  }
  const totalBytes = [manifest, workflow, ...verifiedHandlers].reduce(
    (sum, file) => sum + file.size,
    0,
  );
  if (totalBytes > CUSTOM_MCP_PROJECTED_FILES_MAX_BYTES) return null;
  return Object.freeze({
    manifest,
    workflow,
    packageRequestedCapabilities: Object.freeze([
      ...(parsed.packageRequestedCapabilities as string[]),
    ]),
    handlers: Object.freeze(verifiedHandlers),
  });
}

async function customMcpProjectedFileBytes(input: {
  shipletId: string;
  revisionId: string;
  descriptor: CustomMcpProjectedFile;
  row: {
    path: string;
    size: number;
    sha256: string | null;
    object_key: string | null;
    content_base64: string | null;
  } | null;
  packageStore?: R2Bucket;
}) {
  const row = input.row;
  if (
    !row ||
    row.path !== input.descriptor.path ||
    row.size !== input.descriptor.size ||
    row.sha256 !== input.descriptor.sha256 ||
    (row.object_key === null) === (row.content_base64 === null)
  ) {
    throw new Error("active_custom_mcp_projection_file_mismatch");
  }
  let bytes: Uint8Array;
  if (row.object_key !== null) {
    const expectedKey =
      `self-owned/${encodeURIComponent(input.shipletId)}/revision/` +
      `${encodeURIComponent(input.revisionId)}/files/${input.descriptor.path}`;
    if (row.object_key !== expectedKey || !input.packageStore) {
      throw new Error("active_custom_mcp_projection_storage_unavailable");
    }
    const object = await input.packageStore.get(expectedKey);
    if (!object) throw new Error("active_custom_mcp_projection_object_missing");
    if (object.size !== input.descriptor.size) {
      throw new Error("active_custom_mcp_projection_size_mismatch");
    }
    bytes = new Uint8Array(await object.arrayBuffer());
  } else {
    const encoded = row.content_base64 as string;
    const expectedBase64Length = Math.ceil(input.descriptor.size / 3) * 4;
    if (encoded.length !== expectedBase64Length) {
      throw new Error("active_custom_mcp_projection_size_mismatch");
    }
    try {
      const binary = atob(encoded);
      bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new Error("active_custom_mcp_projection_encoding_invalid");
    }
  }
  if (bytes.byteLength !== input.descriptor.size) {
    throw new Error("active_custom_mcp_projection_size_mismatch");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (sha256 !== input.descriptor.sha256) {
    throw new Error("active_custom_mcp_projection_digest_mismatch");
  }
  return bytes;
}

async function activeCustomMcpPackage(input: {
  db: D1Database;
  shipletId: string;
  packageStore?: R2Bucket;
}): Promise<ActiveCustomMcpPackage | null> {
  const row = await input.db
    .prepare(
      `SELECT project.active_revision_id, project.active_revision_generation,
			 revision.content_digest, revision.runtime_compatibility,
       revision.custom_mcp_projection_json
			 FROM projects project
			 JOIN shiplet_revisions revision
			 ON revision.id = project.active_revision_id
			 AND revision.project_id = project.id
			 WHERE project.id = ? AND project.archived_on IS NULL
         AND project.active_revision_id IS NOT NULL LIMIT 1`,
    )
    .bind(input.shipletId)
    .first<{
      active_revision_id: string;
      active_revision_generation: number;
      content_digest: string | null;
      runtime_compatibility: string;
      custom_mcp_projection_json: string | null;
    }>();
  if (
    !row ||
    !Number.isSafeInteger(row.active_revision_generation) ||
    row.active_revision_generation <= 0 ||
    !row.content_digest
  ) {
    return null;
  }
  const projection = parseCustomMcpProjection(row.custom_mcp_projection_json);
  if (!projection) {
    throw new Error("active_custom_mcp_projection_unavailable");
  }
  const descriptors = [
    projection.manifest,
    projection.workflow,
    ...projection.handlers,
  ];
  const placeholders = descriptors.map(() => "?").join(", ");
  const fileRows = await input.db
    .prepare(
      `SELECT path, size, sha256, object_key, content_base64
       FROM shiplet_revision_files
       WHERE revision_id = ? AND path IN (${placeholders})`,
    )
    .bind(row.active_revision_id, ...descriptors.map((file) => file.path))
    .all<{
      path: string;
      size: number;
      sha256: string | null;
      object_key: string | null;
      content_base64: string | null;
    }>();
  const rowByPath = new Map(fileRows.results.map((file) => [file.path, file]));
  const loaded = new Map<string, Uint8Array>();
  for (const descriptor of descriptors) {
    loaded.set(
      descriptor.path,
      await customMcpProjectedFileBytes({
        shipletId: input.shipletId,
        revisionId: row.active_revision_id,
        descriptor,
        row: rowByPath.get(descriptor.path) ?? null,
        packageStore: input.packageStore,
      }),
    );
  }
  const handlerFiles: Record<string, Uint8Array> = Object.create(null);
  const handlerDigests: Record<string, string> = Object.create(null);
  for (const handler of projection.handlers) {
    handlerFiles[handler.path] = loaded.get(handler.path) as Uint8Array;
    handlerDigests[handler.path] = handler.sha256;
  }
  const activeRevision = Object.freeze({
    shipletId: input.shipletId,
    revisionId: row.active_revision_id,
    packageDigest: `sha256:${row.content_digest}`,
    activationGeneration: row.active_revision_generation,
  });
  const compiled = await compileVerifiedCustomMcpRegistryFiles({
    activeRevision,
    manifestBytes: loaded.get(projection.manifest.path) as Uint8Array,
    packageRuntimeCompatibility: row.runtime_compatibility,
    packageRequestedCapabilities: projection.packageRequestedCapabilities,
    handlerFiles: Object.freeze(handlerFiles),
    handlerDigests: Object.freeze(handlerDigests),
    supportedRuntimeVersions: ["shiplet.runtime/v1"],
    supportedCapabilities: CUSTOM_MCP_SUPPORTED_CAPABILITIES,
    limits: CUSTOM_MCP_LIMITS,
  });
  if (!compiled.ok) throw new Error(compiled.error.code);
  let workflowValue: unknown;
  try {
    workflowValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        loaded.get(projection.workflow.path) as Uint8Array,
      ),
    );
  } catch {
    throw new Error("active_custom_mcp_workflow_invalid");
  }
  return Object.freeze({
    verifiedRegistry: compiled.registry,
    workflowSchema: parseWorkflowSchema(workflowValue),
    ...activeRevision,
  });
}

async function activeCustomMcpFence(db: D1Database, shipletId: string) {
  return db
    .prepare(
      `SELECT project.active_revision_id, project.active_revision_generation,
       revision.content_digest
       FROM projects project
       JOIN shiplet_revisions revision
        ON revision.id = project.active_revision_id
        AND revision.project_id = project.id
       WHERE project.id = ? AND project.archived_on IS NULL
        AND project.active_revision_id IS NOT NULL LIMIT 1`,
    )
    .bind(shipletId)
    .first<{
      active_revision_id: string;
      active_revision_generation: number;
      content_digest: string | null;
    }>();
}

async function composeCodeModeCustomMcpSurface(input: {
  env: Env;
  context: CodeModeContext;
  shipletId: string;
  runtimeReady?: boolean;
}): Promise<
  | {
      ok: true;
      surface: Extract<TrustedCustomMcpSurfaceResult, { ok: true }>;
      capabilityKernel: ReturnType<typeof createD1CapabilityKernel>;
      authorityPolicy: ReturnType<typeof productionCustomMcpAuthorityPolicy>;
      activePackage: ActiveCustomMcpPackage;
      actor: ShipletActor;
    }
  | { ok: false; code: string }
> {
  const project = await getProjectById(input.env.DB, input.shipletId);
  if (!project) return { ok: false, code: "custom_surface_unavailable" };
  let access: RevisionRouteAccess;
  try {
    access = await requireCodeModeRevisionAccess(
      input.env,
      input.context,
      project,
      "read",
    );
  } catch {
    return { ok: false, code: "custom_surface_unavailable" };
  }
  const deploymentRuntime = input.env as DeploymentRuntimeEnv;
  if (
    input.runtimeReady === false ||
    (input.runtimeReady === undefined &&
      !(await cloudflareSupportEntrypointsReady(deploymentRuntime)))
  ) {
    return { ok: false, code: "runtime_unavailable" };
  }
  const runtimeIsolation = resolveCustomMcpRuntimeIsolation(deploymentRuntime);
  if (!runtimeIsolation) return { ok: false, code: "runtime_unavailable" };
  const activePackage = await activeCustomMcpPackage({
    db: input.env.DB,
    shipletId: project.id,
    packageStore: input.env.SHIPLET_ASSETS,
  });
  if (!activePackage) return { ok: false, code: "active_revision_not_found" };
  const resolver = Object.freeze({
    resolve(shipletId: string) {
      return shipletId === activePackage.shipletId
        ? Object.freeze({
            revisionId: activePackage.revisionId,
            packageDigest: activePackage.packageDigest,
            activationGeneration: activePackage.activationGeneration,
          })
        : null;
    },
  });
  const runtime = createVerifiedCustomMcpRuntimeAdapter({
    registry: activePackage.verifiedRegistry,
    limits: {
      maxRequestBytes: CUSTOM_MCP_LIMITS.maxInputBytes,
      maxResponseBytes: CUSTOM_MCP_LIMITS.maxResultBytes,
    },
    policy: CUSTOM_MCP_RUNTIME_ISOLATION_POLICY,
    attestationAuthority: CUSTOM_MCP_RUNTIME_ATTESTATION_AUTHORITY,
    isolation: runtimeIsolation,
  });
  const now = () => Date.now();
  const capabilityKernel = createD1CapabilityKernel({
    db: input.env.DB,
    now,
  });
  const approvalService = createProductionCustomMcpApprovalService({
    env: input.env,
    now,
    capabilityKernel,
  });
  const customMcpWorkflowSchema = activePackage.workflowSchema;
  const kernelCapabilityDispatcher = createD1CustomMcpCapabilityDispatcher({
    db: input.env.DB,
    now,
    async validateWorkflowEvent({
      shipletId,
      revisionId,
      summary,
      customPayload,
    }) {
      if (
        shipletId !== activePackage.shipletId ||
        revisionId !== activePackage.revisionId
      ) {
        return { ok: false, code: "workflow_schema_scope_mismatch" };
      }
      if (!customMcpWorkflowSchema) {
        return { ok: false, code: "workflow_schema_unavailable" };
      }
      const validation = validateWorkflowEvent(customMcpWorkflowSchema, {
        status: customPayload.status,
        summary,
        fields: customPayload.fields,
      });
      if (!validation.ok) {
        return { ok: false, code: `workflow_${validation.code}` };
      }
      return {
        ok: true,
        canonicalStatusCategory: validation.value.canonicalStatusCategory,
        customPayload: {
          status: validation.value.status,
          fields: validation.value.fields,
        },
      };
    },
  });
  const broker = createCapabilityBroker({
    now,
    limits: {
      maxInputBytes: CUSTOM_MCP_LIMITS.maxInputBytes,
      maxMetadataFieldBytes: 1_024,
    },
    grants: capabilityKernel,
    approvals: capabilityKernel,
    validateActionPayload: () => true,
    audit: (event) => capabilityKernel.audit(event),
  });
  const actor = Object.freeze({ ...access.actor });
  const authorityPolicy = productionCustomMcpAuthorityPolicy(
    input.env.DB,
    input.context.kind === "oauth_agent" ? input.context.principal : undefined,
  );
  const auditActorPolicyDenial = (capability: string) =>
    recordCustomMcpActorPolicyDenial({
      db: input.env.DB,
      actor,
      shipletId: activePackage.shipletId,
      revisionId: activePackage.revisionId,
      activationGeneration: activePackage.activationGeneration,
      capability,
    });
  const surface = await composeTrustedCustomMcpSurface({
    activePackage,
    trustedActor: actor,
    authorization: {
      canDiscover(candidate) {
        return (
          candidate.actor.kind === actor.kind &&
          candidate.actor.id === actor.id &&
          candidate.shipletId === activePackage.shipletId &&
          candidate.revisionId === activePackage.revisionId
        );
      },
      canInvoke(candidate) {
        return (
          candidate.actor.kind === actor.kind &&
          candidate.actor.id === actor.id &&
          candidate.shipletId === activePackage.shipletId &&
          candidate.revisionId === activePackage.revisionId
        );
      },
    },
    broker,
    runtime,
    kernelTools: CODE_MODE_KERNEL_TOOLS,
    supportedRuntimeVersions: ["shiplet.runtime/v1"],
    supportedCapabilities: CUSTOM_MCP_SUPPORTED_CAPABILITIES,
    limits: CUSTOM_MCP_LIMITS,
    activeRevisionResolver: resolver,
    capabilityDispatcher: {
      async dispatch(binding) {
        const allowed = await authorityPolicy.authorizeCapability({
          actor: binding.authorized.actor,
          shipletId: binding.authorized.shipletId,
          capability: binding.authorized.action,
        });
        if (!allowed) {
          await auditActorPolicyDenial(binding.authorized.action);
          return Object.freeze({
            status: "aborted" as const,
            journalId: `policy_denied_${crypto.randomUUID()}`,
          });
        }
        return kernelCapabilityDispatcher.dispatch(binding);
      },
    },
    trustedChildApprovalDelegate: {
      async resolve(binding) {
        const invocation = trustedCustomMcpApprovalInvocation({
          context: input.context,
          binding,
        });
        const trustedApprover = invocation.trustedApprover;
        if (!trustedApprover) {
          await auditActorPolicyDenial(binding.capability);
          return Object.freeze({ status: "denied" as const });
        }
        const [invokerAllowed, approverAllowed] = await Promise.all([
          authorityPolicy.authorizeCapability({
            actor: binding.actor,
            shipletId: binding.shipletId,
            capability: binding.capability,
          }),
          authorityPolicy.authorizeTrustedApprover({
            actor: trustedApprover,
            shipletId: binding.shipletId,
          }),
        ]);
        if (!invokerAllowed || !approverAllowed) {
          await auditActorPolicyDenial(binding.capability);
          return Object.freeze({ status: "denied" as const });
        }
        return createCustomMcpTrustedChildApprovalDelegate({
          service: approvalService,
          invocation,
          resolveGrant: () =>
            capabilityKernel.resolveOpaqueHandle(
              binding.opaqueCapabilityHandle,
            ),
        }).resolve(trustedCustomMcpChildMutation(binding));
      },
    },
    approvedMutationDispatcher: {
      async dispatch(binding) {
        const invocation = trustedCustomMcpApprovalInvocation({
          context: input.context,
          binding,
        });
        const trustedApprover = invocation.trustedApprover;
        if (!trustedApprover) {
          await auditActorPolicyDenial(binding.authorized.action);
          return Object.freeze({
            status: "aborted" as const,
            journalId: `policy_denied_${crypto.randomUUID()}`,
          });
        }
        const [invokerAllowed, approverAllowed] = await Promise.all([
          authorityPolicy.authorizeCapability({
            actor: binding.authorized.actor,
            shipletId: binding.authorized.shipletId,
            capability: binding.authorized.action,
          }),
          authorityPolicy.authorizeTrustedApprover({
            actor: trustedApprover,
            shipletId: binding.shipletId,
          }),
        ]);
        if (!invokerAllowed || !approverAllowed) {
          await auditActorPolicyDenial(binding.authorized.action);
          return Object.freeze({
            status: "aborted" as const,
            journalId: `policy_denied_${crypto.randomUUID()}`,
          });
        }
        return createCustomMcpApprovedMutationDispatcher({
          service: approvalService,
          invocation,
          effect: (request) =>
            kernelCapabilityDispatcher.dispatch({
              authorized: Object.freeze({
                actor: request.actor,
                shipletId: request.shipletId,
                revisionId: request.revisionId,
                action: request.action,
                resource: request.resource,
                requestId: request.requestId,
                input: request.input,
              }),
              stateNamespace: binding.stateNamespace,
              egressPolicy: binding.egressPolicy,
              invocationId: binding.invocationId,
              deadlineAt: binding.deadlineAt,
              signal: binding.signal,
            }),
        }).dispatch({ authorized: binding.authorized });
      },
    },
    auditNestedCapabilityDenial: (event) =>
      recordCustomMcpNestedCapabilityDenial(input.env.DB, event),
    stateNamespace: `shiplet:${activePackage.shipletId}:revision:${activePackage.revisionId}`,
    egressPolicy: { allowedResources: [] },
    now,
  });
  return surface.ok
    ? {
        ok: true,
        surface,
        capabilityKernel,
        authorityPolicy,
        activePackage,
        actor,
      }
    : surface;
}

function validMcpRequestId(value: unknown): value is string | number | null {
  return (
    (typeof value === "string" && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    value === null
  );
}

async function stableCustomMcpRequestId(
  ordinal: number,
  requestFingerprint: string,
) {
  const canonical = `${requestFingerprint}:${ordinal}`;
  return `mcp_jsonrpc_${await sha256HexText(canonical)}`;
}

function canonicalCodeModeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalCodeModeValue(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalCodeModeValue(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function codeModeInvocationFingerprint(
  context: CodeModeContext,
  body: unknown,
) {
  const request = isRecord(body) ? body : {};
  const params = isRecord(request.params) ? request.params : {};
  const principal =
    context.kind === "token"
      ? `token:${context.token.id}`
      : context.kind === "oauth_agent"
        ? `oauth_agent:${context.principal.actor.id}`
        : `user:${context.user.id}`;
  return sha256HexText(
    canonicalCodeModeValue({
      principal,
      toolName: typeof params.name === "string" ? params.name : null,
      arguments: isRecord(params.arguments) ? params.arguments : {},
    }),
  );
}

function customMcpApprovalHttpResponse(
  body: BodyInit,
  status: number,
  contentType: string,
) {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function escapeCustomMcpApprovalText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createProductionCustomMcpApprovalRoute(env: Env) {
  const now = () => Date.now();
  const capabilityKernel = createD1CapabilityKernel({ db: env.DB, now });
  const service = createProductionCustomMcpApprovalService({
    env,
    now,
    capabilityKernel,
  });
  return createCustomMcpApprovalConfirmationRoute({
    service,
    async authenticateHuman(request) {
      const user = await getCurrentUser(request, env);
      return user
        ? Object.freeze({ kind: "human" as const, id: user.id })
        : null;
    },
    async authorizeApprover({ approvalRequestId, actor }) {
      const row = await env.DB.prepare(
        `SELECT project_id FROM shiplet_custom_mcp_approvals
				 WHERE id = ? AND actor_kind = 'human' AND actor_id = ? LIMIT 1`,
      )
        .bind(approvalRequestId, actor.id)
        .first<{ project_id: string }>();
      if (!row) return false;
      const [project, user] = await Promise.all([
        getProjectById(env.DB, row.project_id),
        getUser(env.DB, actor.id),
      ]);
      return Boolean(
        project && user && (await canEditProject(env.DB, project, user)),
      );
    },
    async verifySameOriginCsrf(request) {
      return (
        request.headers.get("sec-fetch-site") === "same-origin" &&
        isControlPlaneOrigin(env, request.url, request.headers.get("origin"), {
          method: request.method,
          hasCookie: Boolean(request.headers.get("cookie")),
        })
      );
    },
  });
}

async function requireCodeModeRevisionAccess(
  env: Env,
  context: CodeModeContext,
  project: Project,
  mode: "read" | "write",
): Promise<RevisionRouteAccess> {
  let actor: ShipletActor;
  if (context.kind === "token") {
    requireOrganizationApiScope(
      context.token,
      mode === "write" ? "shiplets:write" : "shiplets:read",
    );
    requireOrganizationApiProjectAccess(context.token, project);
    actor = Object.freeze({ kind: "agent", id: context.token.id });
  } else if (context.kind === "oauth_agent") {
    requireCodeModeOAuthPermission(
      context,
      mode === "write" ? "shiplets:write" : "shiplets:read",
    );
    if (
      context.principal.organizationId === null ||
      project.organization_id !== context.principal.organizationId
    ) {
      throw new Response("Delegated MCP organization denied", {
        status: 403,
      });
    }
    const allowed =
      mode === "write"
        ? await canEditProject(env.DB, project, context.principal.subject)
        : await canViewProject(env.DB, project, context.principal.subject.id);
    if (!allowed) {
      throw new Response(
        mode === "write"
          ? "Shiplet editor access required"
          : "Shiplet access denied",
        { status: 403 },
      );
    }
    actor = context.principal.actor;
  } else {
    const allowed =
      mode === "write"
        ? await canEditProject(env.DB, project, context.user)
        : await canViewProject(env.DB, project, context.user.id);
    if (!allowed) {
      throw new Response(
        mode === "write"
          ? "Shiplet editor access required"
          : "Shiplet access denied",
        { status: 403 },
      );
    }
    actor = Object.freeze({ kind: "human", id: context.user.id });
  }

  const authorizationId = `revision-mcp:${crypto.randomUUID()}`;
  return {
    actor,
    authorizer: {
      async authorize(binding) {
        if (
          binding.shipletId !== project.id ||
          binding.actor.kind !== actor.kind ||
          binding.actor.id !== actor.id
        ) {
          throw new Error("revision_mcp_binding_denied");
        }
        return {
          authorizationId,
          binding: Object.freeze({
            shipletId: binding.shipletId,
            actor: Object.freeze({ ...actor }),
            action: binding.action,
          }),
        };
      },
    },
  };
}

function codeModeDraftVersion(body: Record<string, unknown>) {
  const value = Number(body.expectedVersion);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Response("A positive draft version precondition is required", {
      status: 428,
    });
  }
  return value;
}

function codeModeKernelApprovalIdentity(context: CodeModeContext) {
  if (context.kind === "user") return null;
  if (context.kind === "oauth_agent") {
    return Object.freeze({
      actorId: context.principal.actor.id,
      subjectUserId: context.principal.subject.id,
    });
  }
  return Object.freeze({
    actorId: context.token.id,
    subjectUserId: context.token.created_by_user_id,
  });
}

function exactKernelApprovalRequestId(value: unknown) {
  return typeof value === "string" &&
    /^mcp_kernel_approval_[A-Za-z0-9-]{1,128}$/.test(value)
    ? value
    : null;
}

async function codeModeKernelApprovalDigest(input: {
  action: KernelApprovalAction;
  projectId: string;
  resourceId: string;
  expectedActiveRevisionId: string;
  candidateRevisionId: string;
  targetIds: readonly string[];
}) {
  return sha256HexText(
    JSON.stringify({
      action: input.action,
      projectId: input.projectId,
      resourceId: input.resourceId,
      expectedActiveRevisionId: input.expectedActiveRevisionId,
      candidateRevisionId: input.candidateRevisionId,
      targetIds: [...input.targetIds],
    }),
  );
}

async function requireCodeModeKernelApproval(input: {
  env: Env;
  context: CodeModeContext;
  binding: Omit<KernelApprovalBinding, "agentActorId" | "subjectUserId">;
  approvalRequestId: unknown;
}) {
  const identity = codeModeKernelApprovalIdentity(input.context);
  if (!identity) {
    return Object.freeze({ ok: true as const, idempotencyKey: undefined });
  }
  const binding: KernelApprovalBinding = Object.freeze({
    ...input.binding,
    agentActorId: identity.actorId,
    subjectUserId: identity.subjectUserId,
  });
  const service = createD1KernelApprovalService({ db: input.env.DB });
  const approvalRequestId = exactKernelApprovalRequestId(
    input.approvalRequestId,
  );
  if (!approvalRequestId) {
    const approval = await service.getOrBegin(binding);
    return Object.freeze({
      ok: false as const,
      code: "trusted_approval_required",
      approval: Object.freeze({
        approvalRequestId: approval.id,
        confirmationPath: `/api/mcp/kernel-approvals/${encodeURIComponent(approval.id)}`,
        expiresAt: approval.expiresAt,
      }),
    });
  }
  const claimed = await service.claim({
    ...binding,
    id: approvalRequestId,
  });
  if (!claimed) {
    return Object.freeze({
      ok: false as const,
      code: "trusted_approval_invalid",
    });
  }
  return Object.freeze({
    ok: true as const,
    idempotencyKey: `mcp-kernel:${approvalRequestId}`,
  });
}

async function parseCodeModePackage(value: unknown) {
  try {
    return await parseShipletPackage(value);
  } catch (error) {
    if (error instanceof ShipletPackageError) {
      throw new Response("Invalid Shiplet package", { status: 400 });
    }
    throw error;
  }
}

function codeModeOpenApiSpec(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const paths = isRecord(source.paths) ? source.paths : {};
  const executablePaths: Record<string, unknown> = Object.create(null);
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (!isRecord(pathItemValue)) continue;
    const pathItem: Record<string, unknown> = Object.create(null);
    for (const [method, operation] of Object.entries(pathItemValue)) {
      if (isRecord(operation) && operation["x-shiplet-code-mode"] === true) {
        pathItem[method] = operation;
      }
    }
    if (Object.keys(pathItem).length > 0) executablePaths[path] = pathItem;
  }
  return { ...source, paths: executablePaths };
}

const CODE_MODE_OPENAPI_SPEC = codeModeOpenApiSpec(
  SHIPLET_OPENAPI_SPEC as unknown as Record<string, unknown>,
);
const CODE_MODE_CUSTOM_MCP_CATALOG_PATH = "/api/shiplets/custom-mcp-catalog";

function codeModeCustomMcpCatalogOpenApiOperation() {
  return Object.freeze({
    get: Object.freeze({
      summary: "List bounded custom-operation discovery candidates",
      description:
        "Returns trusted active Shiplet coordinates. Search the returned exact customMcpPathPrefix to load that revision's dynamic operations.",
      operationId: "listShipletCustomMcpCatalog",
      "x-shiplet-code-mode": true,
      parameters: Object.freeze([
        Object.freeze({
          name: "offset",
          in: "query",
          schema: Object.freeze({ type: "integer", minimum: 0 }),
        }),
        Object.freeze({
          name: "limit",
          in: "query",
          schema: Object.freeze({
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 25,
          }),
        }),
      ]),
      responses: Object.freeze({
        "200": Object.freeze({
          description: "A bounded page of active custom-MCP Shiplets",
          content: Object.freeze({
            "application/json": Object.freeze({
              schema: Object.freeze({ type: "object" }),
            }),
          }),
        }),
      }),
    }),
  });
}

const CODE_MODE_OPERATION_ALLOWLIST = Object.freeze(
  Object.entries(
    isRecord(CODE_MODE_OPENAPI_SPEC.paths) ? CODE_MODE_OPENAPI_SPEC.paths : {},
  ).flatMap(([path, pathItem]) => {
    if (!isRecord(pathItem)) return [];
    const patternSource = path
      .split(/(\{[^}]+\})/g)
      .map((segment) =>
        /^\{[^}]+\}$/.test(segment)
          ? "[^/]+"
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    const pattern = new RegExp(`^${patternSource}$`);
    return Object.keys(pathItem)
      .filter((method) => /^(?:delete|get|patch|post|put)$/.test(method))
      .map((method) => ({ method: method.toUpperCase(), pattern }));
  }),
);

function codeModeOperationAllowed(request: CodeModeRequestOptions) {
  return CODE_MODE_OPERATION_ALLOWLIST.some(
    (operation) =>
      operation.method === request.method &&
      operation.pattern.test(request.path),
  );
}

type CodeModeCustomOperation = Readonly<{
  key: string;
  method: "POST";
  path: string;
  shipletId: string;
  revisionId: string;
  packageDigest: string;
  activationGeneration: number;
  toolName: string;
  localName: string;
  tool: CompiledCustomMcpTool;
}>;

type CodeModeRequestContract = Readonly<{
  spec: Record<string, unknown>;
  customOperations: ReadonlyMap<string, CodeModeCustomOperation>;
  nextInvocationRequestId(): Promise<string>;
}>;

function codeModeCustomOperationKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function codeModeCustomOperationPath(
  shipletId: string,
  revisionId: string,
  activationGeneration: number,
  localName: string,
) {
  return (
    `/api/shiplets/${encodeURIComponent(shipletId)}/custom-mcp/` +
    `${encodeURIComponent(revisionId)}/activation/` +
    `${encodeURIComponent(String(activationGeneration))}/` +
    encodeURIComponent(localName)
  );
}

function codeModeMcpToolName(body: unknown) {
  if (
    !isRecord(body) ||
    body.jsonrpc !== "2.0" ||
    body.method !== "tools/call" ||
    !validMcpRequestId(body.id) ||
    !isRecord(body.params)
  ) {
    return null;
  }
  const params = isRecord(body.params) ? body.params : {};
  return typeof params.name === "string" ? params.name : null;
}

function codeModeCustomMcpShipletIds(body: unknown) {
  if (!isRecord(body) || !isRecord(body.params)) return Object.freeze([]);
  const argumentsValue = isRecord(body.params.arguments)
    ? body.params.arguments
    : {};
  if (typeof argumentsValue.code !== "string") return Object.freeze([]);
  const ids: string[] = [];
  const pattern = /\/api\/shiplets\/([A-Za-z0-9._~%:-]+)\/custom-mcp\//gu;
  for (const match of argumentsValue.code.matchAll(pattern)) {
    try {
      const shipletId = decodeURIComponent(match[1]);
      if (shipletId && !ids.includes(shipletId)) ids.push(shipletId);
    } catch {
      continue;
    }
  }
  return Object.freeze(ids);
}

async function stageCodeModeCustomMcpDescriptions(input: {
  env: Env;
  activePackage: ActiveCustomMcpPackage;
  tools: readonly CompiledCustomMcpTool[];
}) {
  const quarantine = customMcpQuarantineBroker({
    db: input.env.DB,
    now: () => Date.now(),
  });
  // Stable per-revision references make this idempotent even after a trusted
  // human consumes every description. Loop the caller-authorized tools rather
  // than trusting a row count that may describe a different capability set.
  for (const tool of input.tools) {
    const referenceId = `qm_${await sha256HexText(
      canonicalCodeModeValue({
        shipletId: input.activePackage.shipletId,
        revisionId: input.activePackage.revisionId,
        toolName: tool.name,
      }),
    )}`;
    const staged = await quarantine.stageToolDescription({
      tool,
      referenceId,
    });
    if (!staged.ok) return false;
  }
  return true;
}

async function authorizedCodeModeCustomMcpTools(input: {
  authorityPolicy: ReturnType<typeof productionCustomMcpAuthorityPolicy>;
  actor: ShipletActor;
  shipletId: string;
  tools: readonly CompiledCustomMcpTool[];
}) {
  const capabilities = Array.from(
    new Set([
      "state.read:review",
      ...input.tools.flatMap((tool) => tool.requestedCapabilities),
    ]),
  );
  const authorization = await Promise.all(
    capabilities.map(async (capability) =>
      Object.freeze({
        capability,
        allowed: await input.authorityPolicy.authorizeCapability({
          actor: input.actor,
          shipletId: input.shipletId,
          capability,
        }),
      }),
    ),
  ).catch(() => []);
  if (authorization.length !== capabilities.length) return Object.freeze([]);
  const allowed = new Map(
    authorization.map(({ capability, allowed: capabilityAllowed }) => [
      capability,
      capabilityAllowed,
    ]),
  );
  if (allowed.get("state.read:review") !== true) return Object.freeze([]);
  return Object.freeze(
    input.tools.filter((tool) =>
      tool.requestedCapabilities.every(
        (capability) => allowed.get(capability) === true,
      ),
    ),
  );
}

async function discoverCodeModeCustomMcpOperations(input: {
  env: Env;
  context: CodeModeContext;
  project: Project;
  runtimeReady?: boolean;
}): Promise<readonly CodeModeCustomOperation[]> {
  if (input.project.archived_on) return [];
  const custom = await composeCodeModeCustomMcpSurface({
    env: input.env,
    context: input.context,
    shipletId: input.project.id,
    runtimeReady: input.runtimeReady,
  }).catch(() => null);
  if (!custom?.ok || custom.surface.registry.tools.length === 0) return [];
  const initiallyAuthorizedTools = await authorizedCodeModeCustomMcpTools({
    authorityPolicy: custom.authorityPolicy,
    actor: custom.actor,
    shipletId: input.project.id,
    tools: custom.surface.registry.tools,
  });
  if (initiallyAuthorizedTools.length === 0) return [];
  const descriptionsReady = await stageCodeModeCustomMcpDescriptions({
    env: input.env,
    activePackage: custom.activePackage,
    tools: initiallyAuthorizedTools,
  }).catch(() => false);
  if (!descriptionsReady) return [];
  // Quarantine staging crosses an async authority boundary. Re-read both the
  // activation fence and caller authority before advertising an operation so
  // archive, rollback, membership, or token-rule changes cannot leak a stale
  // registration into the live Code Mode catalog.
  const [currentProject, currentFence] = await Promise.all([
    getProjectById(input.env.DB, input.project.id).catch(() => null),
    activeCustomMcpFence(input.env.DB, input.project.id).catch(() => null),
  ]);
  if (
    !currentProject ||
    currentProject.archived_on ||
    !currentFence ||
    currentFence.active_revision_id !== custom.activePackage.revisionId ||
    currentFence.active_revision_generation !==
      custom.activePackage.activationGeneration ||
    `sha256:${currentFence.content_digest}` !==
      custom.activePackage.packageDigest
  ) {
    return [];
  }
  const currentAccess = await requireCodeModeRevisionAccess(
    input.env,
    input.context,
    currentProject,
    "read",
  ).catch(() => null);
  if (
    !currentAccess ||
    currentAccess.actor.kind !== custom.actor.kind ||
    currentAccess.actor.id !== custom.actor.id
  ) {
    return [];
  }
  const currentlyAuthorizedTools = await authorizedCodeModeCustomMcpTools({
    authorityPolicy: productionCustomMcpAuthorityPolicy(
      input.env.DB,
      input.context.kind === "oauth_agent"
        ? input.context.principal
        : undefined,
    ),
    actor: custom.actor,
    shipletId: input.project.id,
    tools: initiallyAuthorizedTools,
  });
  if (currentlyAuthorizedTools.length === 0) return [];
  return Object.freeze(
    currentlyAuthorizedTools.map((tool) => {
      const path = codeModeCustomOperationPath(
        custom.activePackage.shipletId,
        custom.activePackage.revisionId,
        custom.activePackage.activationGeneration,
        tool.localName,
      );
      return Object.freeze({
        key: codeModeCustomOperationKey("POST", path),
        method: "POST" as const,
        path,
        shipletId: custom.activePackage.shipletId,
        revisionId: custom.activePackage.revisionId,
        packageDigest: custom.activePackage.packageDigest,
        activationGeneration: custom.activePackage.activationGeneration,
        toolName: tool.name,
        localName: tool.localName,
        tool,
      });
    }),
  );
}

function codeModeCustomMcpOpenApiOperation(
  registration: CodeModeCustomOperation,
) {
  return Object.freeze({
    summary: "Invoke an active revision-scoped Shiplet operation",
    description: registration.tool.description,
    operationId: [
      "invokeShipletCustomMcp",
      registration.shipletId,
      registration.revisionId,
      registration.activationGeneration,
      registration.localName,
    ].join("_"),
    "x-shiplet-code-mode": true,
    "x-shiplet-custom-mcp": Object.freeze({
      shipletId: registration.shipletId,
      revisionId: registration.revisionId,
      activationGeneration: registration.activationGeneration,
      localName: registration.localName,
      effect: registration.tool.effect,
      approval: registration.tool.approval,
      requestedCapabilities: registration.tool.requestedCapabilities,
    }),
    requestBody: Object.freeze({
      required: true,
      content: Object.freeze({
        "application/json": Object.freeze({
          schema: registration.tool.inputSchema,
        }),
      }),
    }),
    responses: Object.freeze({
      "200": Object.freeze({
        description:
          "Trusted execution status. Package-authored output remains quarantined.",
        content: Object.freeze({
          "application/json": Object.freeze({
            schema: Object.freeze({ type: "object" }),
          }),
        }),
      }),
    }),
  });
}

async function codeModeRequestContract(input: {
  env: Env;
  context: CodeModeContext;
  body: unknown;
}): Promise<CodeModeRequestContract> {
  const customOperations = new Map<string, CodeModeCustomOperation>();
  const toolName = codeModeMcpToolName(input.body);
  const requestedShipletIds = codeModeCustomMcpShipletIds(input.body);
  if (
    (toolName === "search" || toolName === "execute") &&
    requestedShipletIds.length > 0
  ) {
    const project = await getProjectById(input.env.DB, requestedShipletIds[0]);
    if (project) {
      const runtimeReady = await cloudflareSupportEntrypointsReady(
        input.env as DeploymentRuntimeEnv,
      );
      for (const registration of await discoverCodeModeCustomMcpOperations({
        env: input.env,
        context: input.context,
        project,
        runtimeReady,
      })) {
        customOperations.set(registration.key, registration);
      }
    }
  }
  const basePaths = isRecord(CODE_MODE_OPENAPI_SPEC.paths)
    ? CODE_MODE_OPENAPI_SPEC.paths
    : {};
  const paths: Record<string, unknown> = Object.assign(
    Object.create(null),
    basePaths,
  );
  paths[CODE_MODE_CUSTOM_MCP_CATALOG_PATH] =
    codeModeCustomMcpCatalogOpenApiOperation();
  for (const registration of customOperations.values()) {
    paths[registration.path] = Object.freeze({
      post: codeModeCustomMcpOpenApiOperation(registration),
    });
  }
  const requestFingerprint = await codeModeInvocationFingerprint(
    input.context,
    input.body,
  );
  let invocationOrdinal = 0;
  return Object.freeze({
    spec: Object.freeze({
      ...CODE_MODE_OPENAPI_SPEC,
      paths,
      "x-shiplet-custom-mcp-catalog": Object.freeze({
        requiresExactShipletPath: true,
        maxProjectsPerRequest: 1,
        requestedProjects: requestedShipletIds.length,
        loadedProjects: requestedShipletIds.length > 0 ? 1 : 0,
        truncated: requestedShipletIds.length > 1,
      }),
    }),
    customOperations,
    nextInvocationRequestId() {
      invocationOrdinal += 1;
      return stableCustomMcpRequestId(invocationOrdinal, requestFingerprint);
    },
  });
}

async function handleCodeModeMcpRequest(
  env: Env,
  db: D1QB,
  context: CodeModeContext,
  request: Request,
  body: unknown,
) {
  const contract = await codeModeRequestContract({ env, context, body });
  const executor = new DynamicWorkerExecutor({
    loader: env.CODE_MODE_LOADER,
    timeout: 30_000,
    globalOutbound: null,
  });
  const server = openApiMcpServer({
    spec: contract.spec,
    executor,
    name: "shiplet-codemode",
    version: "1.0.0",
    description:
      "Shiplet exposes only the trusted review API. Artifact bytes and credentials never enter the code sandbox.",
    request: (options) =>
      executeTrustedCodeModeRequest(env, db, context, contract, options),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const transportRequest = new Request(request.url, {
    method: "POST",
    headers,
  });
  try {
    return await transport.handleRequest(transportRequest, {
      parsedBody: body,
    });
  } finally {
    await server.close();
  }
}

async function invokeCodeModeCustomMcpOperation(input: {
  env: Env;
  context: CodeModeContext;
  contract: CodeModeRequestContract;
  registration: CodeModeCustomOperation;
  body: unknown;
}) {
  const custom = await composeCodeModeCustomMcpSurface({
    env: input.env,
    context: input.context,
    shipletId: input.registration.shipletId,
  });
  if (!custom.ok) {
    return Object.freeze({
      ok: false as const,
      code:
        custom.code === "custom_surface_unavailable"
          ? "operation_unavailable"
          : custom.code,
    });
  }
  if (
    custom.activePackage.revisionId !== input.registration.revisionId ||
    custom.activePackage.packageDigest !== input.registration.packageDigest ||
    custom.activePackage.activationGeneration !==
      input.registration.activationGeneration
  ) {
    throw new Response("Code Mode custom operation is no longer active.", {
      status: 404,
    });
  }
  const tool = custom.surface.registry.resolve(input.registration.toolName);
  if (
    !tool ||
    tool.localName !== input.registration.localName ||
    tool.handlerPath !== input.registration.tool.handlerPath
  ) {
    throw new Response("Code Mode custom operation is no longer active.", {
      status: 404,
    });
  }

  const requestId = await input.contract.nextInvocationRequestId();
  const invocationGrant = await custom.capabilityKernel.issueGrant({
    actor: custom.actor,
    shipletId: custom.activePackage.shipletId,
    revisionId: custom.activePackage.revisionId,
    activationFence: {
      revisionId: custom.activePackage.revisionId,
      generation: custom.activePackage.activationGeneration,
    },
    action: `mcp.custom.invoke:${tool.localName}`,
    resource: `mcp-tool:${tool.name}`,
    effect: "read",
    approval: "none",
    expiresAt: Date.now() + 30_000,
  });
  const capabilityHandles: Record<string, string> = Object.create(null);
  for (const capability of tool.requestedCapabilities) {
    const requirements = customMcpCapabilityGrantRequirements(capability);
    if (!requirements) continue;
    const actorAllowed = await custom.authorityPolicy.authorizeCapability({
      actor: custom.actor,
      shipletId: custom.activePackage.shipletId,
      capability,
    });
    if (!actorAllowed) {
      await recordCustomMcpActorPolicyDenial({
        db: input.env.DB,
        actor: custom.actor,
        shipletId: custom.activePackage.shipletId,
        revisionId: custom.activePackage.revisionId,
        activationGeneration: custom.activePackage.activationGeneration,
        capability,
      });
      return Object.freeze({
        ok: false as const,
        code: "capability_denied",
      });
    }
    const childGrant = await custom.capabilityKernel.issueGrant({
      actor: custom.actor,
      shipletId: custom.activePackage.shipletId,
      revisionId: custom.activePackage.revisionId,
      activationFence: {
        revisionId: custom.activePackage.revisionId,
        generation: custom.activePackage.activationGeneration,
      },
      action: capability,
      resource: requirements.resource,
      effect: requirements.effect,
      approval: requirements.approval,
      expiresAt: Date.now() + 30_000,
    });
    capabilityHandles[capability] = childGrant.opaqueHandle;
  }

  const result = await custom.surface.executor.invoke({
    trustedActor: custom.actor,
    shipletId: custom.activePackage.shipletId,
    revisionId: custom.activePackage.revisionId,
    toolName: tool.name,
    requestId,
    inputBytes: new TextEncoder().encode(
      JSON.stringify(input.body === undefined ? {} : input.body),
    ),
    invocationCapabilityHandle: invocationGrant.opaqueHandle,
    capabilityHandles: Object.freeze(capabilityHandles),
  });
  if (!result.ok) {
    return Object.freeze({
      ok: false as const,
      code: result.code,
      ...(result.approval
        ? { approval: Object.freeze({ ...result.approval }) }
        : {}),
    });
  }

  const activeAfter = await activeCustomMcpFence(
    input.env.DB,
    custom.activePackage.shipletId,
  );
  if (
    !activeAfter ||
    activeAfter.active_revision_id !== custom.activePackage.revisionId ||
    `sha256:${activeAfter.content_digest}` !==
      custom.activePackage.packageDigest ||
    activeAfter.active_revision_generation !==
      custom.activePackage.activationGeneration
  ) {
    return Object.freeze({ ok: false as const, code: "stale_revision" });
  }
  const staged = await customMcpQuarantineBroker({
    db: input.env.DB,
    now: () => Date.now(),
    activeRevisionFence: {
      shipletId: custom.activePackage.shipletId,
      revisionId: custom.activePackage.revisionId,
      packageDigest: custom.activePackage.packageDigest,
      activationGeneration: custom.activePackage.activationGeneration,
    },
  }).stageResult({ result: result.value });
  if (!staged.ok) {
    return Object.freeze({ ok: false as const, code: staged.code });
  }
  const activeAfterStaging = await activeCustomMcpFence(
    input.env.DB,
    custom.activePackage.shipletId,
  );
  if (
    !activeAfterStaging ||
    activeAfterStaging.active_revision_id !== custom.activePackage.revisionId ||
    `sha256:${activeAfterStaging.content_digest}` !==
      custom.activePackage.packageDigest ||
    activeAfterStaging.active_revision_generation !==
      custom.activePackage.activationGeneration
  ) {
    return Object.freeze({ ok: false as const, code: "stale_revision" });
  }
  const projected = CUSTOM_MCP_MODEL_BOUNDARY.projectResult(result.value);
  return projected.ok
    ? Object.freeze({ ok: true as const, result: projected.value })
    : Object.freeze({ ok: false as const, code: projected.code });
}

async function executeTrustedCodeModeRequest(
  env: Env,
  db: D1QB,
  context: CodeModeContext,
  contract: CodeModeRequestContract,
  request: CodeModeRequestOptions,
) {
  try {
    return await executeCodeModeRequest(env, db, context, request, contract);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    if (error.status === 400 || error.status === 422) {
      throw new Error("Request invalid");
    }
    if (error.status === 401 || error.status === 403) {
      throw new Error("Authorization denied");
    }
    if (error.status === 404) throw new Error("Operation unavailable");
    if (error.status === 409 || error.status === 428) {
      throw new Error("Request conflict");
    }
    throw new Error("Request failed");
  }
}

function boundedCodeModeCatalogInteger(
  value: unknown,
  fallback: number,
  maximum: number,
) {
  const candidate =
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof candidate === "number" &&
    Number.isSafeInteger(candidate) &&
    candidate >= 0
    ? Math.min(candidate, maximum)
    : fallback;
}

async function listCodeModeCustomMcpCatalog(
  env: Env,
  context: CodeModeContext,
  request: CodeModeRequestOptions,
) {
  const limit = Math.max(
    1,
    boundedCodeModeCatalogInteger(request.query?.limit, 25, 50),
  );
  const offset = boundedCodeModeCatalogInteger(
    request.query?.offset,
    0,
    1_000_000,
  );
  let projects: Project[];
  if (context.kind === "token") {
    requireOrganizationApiScope(context.token, "shiplets:read");
    projects = await listProjectsForOrganizationApiToken(
      env.DB,
      context.token,
      { archiveStatus: "active", limit, offset },
    );
  } else {
    if (context.kind === "oauth_agent") {
      requireCodeModeOAuthPermission(context, "shiplets:read");
      if (context.principal.organizationId === null) {
        throw new Response("Delegated MCP organization required", {
          status: 403,
        });
      }
    }
    projects = await listProjectsForUser(env.DB, codeModeSubject(context)!.id, {
      archiveStatus: "active",
      ...(context.kind === "oauth_agent"
        ? { organizationId: context.principal.organizationId as string }
        : {}),
      limit,
      offset,
    });
  }
  if (projects.length === 0) {
    return Object.freeze({
      schemaVersion: "shiplet.custom-mcp-catalog/v1",
      items: Object.freeze([]),
      page: Object.freeze({ offset, limit, nextOffset: null }),
    });
  }
  const placeholders = projects.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT project.id, project.name, project.active_revision_id,
     project.active_revision_generation
     FROM projects project
     JOIN shiplet_revisions revision
      ON revision.id = project.active_revision_id
      AND revision.project_id = project.id
     WHERE project.id IN (${placeholders})
      AND project.archived_on IS NULL
      AND revision.custom_mcp_projection_json IS NOT NULL`,
  )
    .bind(...projects.map((project) => project.id))
    .all<{
      id: string;
      name: string;
      active_revision_id: string;
      active_revision_generation: number;
    }>();
  const rowById = new Map(rows.results.map((row) => [row.id, row]));
  const items = projects.flatMap((project) => {
    const row = rowById.get(project.id);
    if (
      !row ||
      !Number.isSafeInteger(row.active_revision_generation) ||
      row.active_revision_generation <= 0
    ) {
      return [];
    }
    return [
      Object.freeze({
        shipletId: row.id,
        name: row.name,
        activeRevisionId: row.active_revision_id,
        activationGeneration: row.active_revision_generation,
        customMcpPathPrefix: `/api/shiplets/${encodeURIComponent(row.id)}/custom-mcp/`,
      }),
    ];
  });
  return Object.freeze({
    schemaVersion: "shiplet.custom-mcp-catalog/v1",
    items: Object.freeze(items),
    page: Object.freeze({
      offset,
      limit,
      nextOffset: projects.length === limit ? offset + limit : null,
    }),
  });
}

async function executeCodeModeRequest(
  env: Env,
  db: D1QB,
  context: CodeModeContext,
  request: CodeModeRequestOptions,
  contract?: CodeModeRequestContract,
) {
  if (
    contract &&
    request.path === CODE_MODE_CUSTOM_MCP_CATALOG_PATH &&
    request.method === "GET"
  ) {
    return listCodeModeCustomMcpCatalog(env, context, request);
  }
  if (contract) {
    const customOperation = contract.customOperations.get(
      codeModeCustomOperationKey(request.method, request.path),
    );
    if (customOperation) {
      return invokeCodeModeCustomMcpOperation({
        env,
        context,
        contract,
        registration: customOperation,
        body: request.body,
      });
    }
  }
  const body = isRecord(request.body) ? request.body : {};
  if (!codeModeOperationAllowed(request)) {
    throw new Response("Code Mode request path is not supported.", {
      status: 404,
    });
  }

  if (request.path === "/api/organizations" && request.method === "POST") {
    if (context.kind !== "user") {
      throw new Response("Organization creation requires a browser session.", {
        status: 403,
      });
    }
    return createOrganizationForUser(
      env,
      context.user,
      normalizeOptionalString(body.name),
    );
  }

  if (request.path === "/api/shiplets" && request.method === "GET") {
    const archiveStatus = projectArchiveStatusFromValue(request.query?.status);
    if (context.kind === "token") {
      requireOrganizationApiScope(context.token, "shiplets:read");
      return {
        projects: await listProjectsForOrganizationApiToken(
          env.DB,
          context.token,
          {
            archiveStatus,
          },
        ),
      };
    }
    if (context.kind === "oauth_agent") {
      requireCodeModeOAuthPermission(context, "shiplets:read");
      if (context.principal.organizationId === null) {
        throw new Response("Delegated MCP organization required", {
          status: 403,
        });
      }
    }
    return {
      projects: await listProjectsForUser(
        env.DB,
        codeModeSubject(context)!.id,
        {
          archiveStatus,
          ...(context.kind === "oauth_agent"
            ? { organizationId: context.principal.organizationId as string }
            : {}),
        },
      ),
    };
  }

  if (request.path === "/api/shiplets" && request.method === "POST") {
    if (context.kind === "token") {
      requireOrganizationApiScope(context.token, "shiplets:write");
      requireOrganizationApiShipletCreationAccess(context.token);
      const result = await publishShipletForOrganization(
        env,
        db,
        context.token.created_by_user_id,
        context.token.organization_id,
        body,
        { kind: "agent", id: context.token.id },
      );
      return publishResultPayload(env, "https://shiplet.cc/", result);
    }
    if (context.kind === "oauth_agent") {
      requireCodeModeOAuthPermission(context, "shiplets:write");
      if (context.principal.organizationId === null) {
        throw new Response("Delegated MCP organization required", {
          status: 403,
        });
      }
      await requireOrganizationMembership(
        env.DB,
        context.principal.organizationId,
        context.principal.subject.id,
      );
      const result = await publishShipletForOrganization(
        env,
        db,
        context.principal.subject.id,
        context.principal.organizationId,
        body,
        context.principal.actor,
      );
      return publishResultPayload(env, "https://shiplet.cc/", result);
    }
    const result = await publishShiplet(
      env,
      db,
      codeModeSubject(context)!,
      body,
    );
    return publishResultPayload(env, "https://shiplet.cc/", result);
  }

  const reviewLayerMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/review-layer$/,
  );
  if (reviewLayerMatch && request.method === "GET") {
    const project = await getProjectById(env.DB, reviewLayerMatch[1]);
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "read",
    );
    return readReviewLayer({ env, project, access });
  }

  const reviewLayerPreviewMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/review-layer\/previews$/,
  );
  if (reviewLayerPreviewMatch && request.method === "POST") {
    const project = await getProjectById(env.DB, reviewLayerPreviewMatch[1]);
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    const preview = await prepareReviewLayerPreview({
      env,
      project,
      access,
      body,
      requestUrl: env.SHIPLET_APP_URL || "https://shiplet.cc/",
    });
    if (!preview.ok) {
      throw new Response(JSON.stringify(await preview.response.json()), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }
    return preview.value;
  }

  const reviewLayerApplyMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/review-layer\/previews\/([^/]+)\/apply$/,
  );
  if (reviewLayerApplyMatch && request.method === "POST") {
    const project = await getProjectById(env.DB, reviewLayerApplyMatch[1]);
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    return commitReviewLayerPreview({
      env,
      project,
      access,
      previewId: reviewLayerApplyMatch[2],
      body,
    });
  }

  const shipletPackageMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/package$/,
  );
  if (shipletPackageMatch && request.method === "GET") {
    const project = await getProjectById(env.DB, shipletPackageMatch[1]);
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "read",
    );
    const revision = await migrateLegacyShipletRevision(
      env.DB,
      project.id,
      env.SHIPLET_ASSETS,
    );
    const serialized = await revisionServiceFor(
      env.DB,
      access,
      env,
    ).exportRevisionPackage({
      shipletId: project.id,
      revisionId: revision.id,
      actor: access.actor,
    });
    return {
      package: JSON.parse(serialized),
      revision: {
        id: revision.id,
        shipletId: project.id,
        parentRevisionId: revision.parentRevisionId,
        digest: revision.digest,
        contentDigest: revision.contentDigest,
      },
      disposition: request.query?.disposition === "eject" ? "eject" : "pull",
    };
  }

  const shipletRevisionPackageMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/revisions\/([^/]+)\/package$/,
  );
  if (shipletRevisionPackageMatch && request.method === "GET") {
    const project = await getProjectById(
      env.DB,
      shipletRevisionPackageMatch[1],
    );
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "read",
    );
    const service = revisionServiceFor(env.DB, access, env);
    const revision = await service.getRevision({
      shipletId: project.id,
      revisionId: shipletRevisionPackageMatch[2],
      actor: access.actor,
    });
    const serialized = await service.exportRevisionPackage({
      shipletId: project.id,
      revisionId: revision.id,
      actor: access.actor,
    });
    return {
      package: JSON.parse(serialized),
      revision: {
        id: revision.id,
        parentRevisionId: revision.parentRevisionId,
        digest: revision.digest,
        contentDigest: revision.contentDigest,
      },
      disposition: request.query?.disposition === "eject" ? "eject" : "pull",
    };
  }

  const shipletForkMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/drafts$/,
  );
  if (shipletForkMatch && request.method === "POST") {
    const project = await getProjectById(env.DB, shipletForkMatch[1]);
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    const active = await migrateLegacyShipletRevision(
      env.DB,
      project.id,
      env.SHIPLET_ASSETS,
    );
    const fromRevisionId =
      typeof body.fromRevisionId === "string" && body.fromRevisionId.length > 0
        ? body.fromRevisionId
        : active.id;
    return {
      draft: await revisionServiceFor(env.DB, access, env).forkRevision({
        shipletId: project.id,
        revisionId: fromRevisionId,
        actor: access.actor,
      }),
    };
  }

  const draftPackageMatch = request.path.match(
    /^\/api\/drafts\/([^/]+)\/package$/,
  );
  if (draftPackageMatch && request.method === "GET") {
    const draftId = draftPackageMatch[1];
    const project = await revisionDraftProject(env.DB, draftId);
    if (!project) throw new Response("Draft not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "read",
    );
    const serialized = await revisionServiceFor(
      env.DB,
      access,
      env,
    ).exportDraftPackage({
      shipletId: project.id,
      draftId,
      actor: access.actor,
    });
    const draft = await env.DB.prepare(
      `SELECT id, base_revision_id, version, validation_state,
				 validated_revision_id FROM shiplet_drafts
				 WHERE id = ? AND project_id = ?`,
    )
      .bind(draftId, project.id)
      .first<{
        id: string;
        base_revision_id: string;
        version: number;
        validation_state: string;
        validated_revision_id: string | null;
      }>();
    if (!draft) throw new Response("Draft not found", { status: 404 });
    const packageEnvelope = JSON.parse(serialized);
    return {
      package: packageEnvelope,
      draft: {
        id: draft.id,
        shipletId: project.id,
        baseRevisionId: draft.base_revision_id,
        version: draft.version,
        validationState: draft.validation_state,
        validatedRevisionId: draft.validated_revision_id,
        packageDigest: await digestShipletPackage(packageEnvelope),
      },
    };
  }

  if (draftPackageMatch && request.method === "PUT") {
    const draftId = draftPackageMatch[1];
    const project = await revisionDraftProject(env.DB, draftId);
    if (!project) throw new Response("Draft not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    const submittedPackage = await parseCodeModePackage(body.package);
    const packageDigest = await digestShipletPackage(submittedPackage);
    const draft = await revisionServiceFor(env.DB, access, env).updateDraft({
      shipletId: project.id,
      draftId,
      expectedVersion: codeModeDraftVersion(body),
      package: submittedPackage,
      actor: access.actor,
    });
    return {
      draft: { ...draft, packageDigest },
      packageDigest,
    };
  }

  const draftDiffMatch = request.path.match(/^\/api\/drafts\/([^/]+)\/diff$/);
  if (draftDiffMatch && request.method === "POST") {
    const draftId = draftDiffMatch[1];
    const project = await revisionDraftProject(env.DB, draftId);
    if (!project) throw new Response("Draft not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "read",
    );
    const expectedVersion = codeModeDraftVersion(body);
    const draft = await env.DB.prepare(
      "SELECT version FROM shiplet_drafts WHERE id = ? AND project_id = ?",
    )
      .bind(draftId, project.id)
      .first<{ version: number }>();
    if (!draft || draft.version !== expectedVersion) {
      return {
        ok: false,
        code: "draft_conflict",
        currentVersion: draft?.version,
      };
    }
    const currentSerialized = await revisionServiceFor(
      env.DB,
      access,
      env,
    ).exportDraftPackage({
      shipletId: project.id,
      draftId,
      actor: access.actor,
    });
    const [currentDigest, proposedPackage] = await Promise.all([
      digestShipletPackage(JSON.parse(currentSerialized)),
      parseCodeModePackage(body.package),
    ]);
    const proposedDigest = await digestShipletPackage(proposedPackage);
    return {
      ok: true,
      draftId,
      draftVersion: draft.version,
      currentDigest,
      proposedDigest,
      changed: currentDigest !== proposedDigest,
    };
  }

  const draftValidateMatch = request.path.match(
    /^\/api\/drafts\/([^/]+)\/validate$/,
  );
  if (draftValidateMatch && request.method === "POST") {
    const draftId = draftValidateMatch[1];
    const project = await revisionDraftProject(env.DB, draftId);
    if (!project) throw new Response("Draft not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    const service = revisionServiceFor(env.DB, access, env);
    const currentPackage = await parseShipletPackage(
      await service.exportDraftPackage({
        shipletId: project.id,
        draftId,
        actor: access.actor,
      }),
    );
    const currentPackageDigest = await digestShipletPackage(currentPackage);
    if (body.package !== undefined || body.packageDigest !== undefined) {
      if (
        body.package === undefined ||
        typeof body.packageDigest !== "string"
      ) {
        throw new Response("Validation package binding is required", {
          status: 400,
        });
      }
      const submittedPackage = await parseCodeModePackage(body.package);
      const submittedDigest = await digestShipletPackage(submittedPackage);
      if (
        body.packageDigest !== submittedDigest ||
        submittedDigest !== currentPackageDigest
      ) {
        throw new Response("Validation package does not match the draft", {
          status: 409,
        });
      }
    }
    const validation = await service.validateDraft({
      shipletId: project.id,
      draftId,
      expectedVersion: codeModeDraftVersion(body),
      actor: access.actor,
    });
    if (
      validation.ok &&
      currentPackage.manifest.staticFirst === false &&
      hasManagedAdvancedRuntime(
        env,
        access.actor.kind === "human" ? access.actor.id : undefined,
      )
    ) {
      await stageManagedRuntimeRevision({
        env: env as DeploymentRuntimeEnv,
        actor: access.actor,
        shipletId: project.id,
        revisionId: validation.revisionId,
      });
    }
    return {
      validation: {
        ...validation,
        draftId,
        packageDigest: currentPackageDigest,
        previewUrl: validatedDraftPreviewUrl({
          env,
          requestUrl: env.SHIPLET_APP_URL || "https://shiplet.cc/",
          shipletId: project.id,
          draftId,
          validation,
        }),
      },
    };
  }

  const draftPromoteMatch = request.path.match(
    /^\/api\/drafts\/([^/]+)\/promote$/,
  );
  if (draftPromoteMatch && request.method === "POST") {
    if (context.kind === "user" && body.approval !== true) {
      throw new Response("Explicit promotion approval is required", {
        status: 428,
      });
    }
    const expectedActiveRevisionId = String(
      body.expectedActiveRevisionId || "",
    );
    if (!expectedActiveRevisionId) {
      throw new Response("Expected active revision is required", {
        status: 428,
      });
    }
    const draftId = draftPromoteMatch[1];
    const project = await revisionDraftProject(env.DB, draftId);
    if (!project) throw new Response("Draft not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    requireCodeModeOAuthPermission(context, "shiplets:promote");
    const targetIds = exactDeploymentTargetIds(body);
    const requestedIdempotencyKey = exactRevisionOperationIdempotencyKey(
      request.idempotencyKey,
    );
    const active = await env.DB.prepare(
      `SELECT active_revision_id FROM projects WHERE id = ? LIMIT 1`,
    )
      .bind(project.id)
      .first<{ active_revision_id: string | null }>();
    if (
      !exactKernelApprovalRequestId(body.approvalRequestId) &&
      !requestedIdempotencyKey &&
      active?.active_revision_id !== expectedActiveRevisionId
    ) {
      throw new Response("Active revision conflict", { status: 409 });
    }
    const approval = await requireCodeModeKernelApproval({
      env,
      context,
      binding: {
        projectId: project.id,
        revisionId: expectedActiveRevisionId,
        action: "revision.promote",
        resourceId: draftId,
        requestDigest: await codeModeKernelApprovalDigest({
          action: "revision.promote",
          projectId: project.id,
          resourceId: draftId,
          expectedActiveRevisionId,
          candidateRevisionId: draftId,
          targetIds: targetIds ?? [],
        }),
      },
      approvalRequestId: body.approvalRequestId,
    });
    if (!approval.ok) return approval;
    const idempotencyKey = approval.idempotencyKey ?? requestedIdempotencyKey;
    return executeRevisionPromotion({
      env,
      access,
      project,
      draftId,
      expectedActiveRevisionId,
      ...(targetIds ? { targetIds } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  const shipletRollbackMatch = request.path.match(
    /^\/api\/shiplets\/([^/]+)\/rollback$/,
  );
  if (shipletRollbackMatch && request.method === "POST") {
    if (context.kind === "user" && body.approval !== true) {
      throw new Response("Explicit rollback approval is required", {
        status: 428,
      });
    }
    const revisionId = String(body.revisionId || "");
    const expectedActiveRevisionId = String(
      body.expectedActiveRevisionId || "",
    );
    if (!revisionId || !expectedActiveRevisionId) {
      throw new Response("Rollback revision preconditions are required", {
        status: 428,
      });
    }
    const project = await getProjectById(env.DB, shipletRollbackMatch[1]);
    if (!project) throw new Response("Shiplet not found", { status: 404 });
    const access = await requireCodeModeRevisionAccess(
      env,
      context,
      project,
      "write",
    );
    requireCodeModeOAuthPermission(context, "shiplets:rollback");
    const targetIds = exactDeploymentTargetIds(body);
    const requestedIdempotencyKey = exactRevisionOperationIdempotencyKey(
      request.idempotencyKey,
    );
    const revisionFence = await env.DB.prepare(
      `SELECT project.active_revision_id,
        EXISTS(
          SELECT 1 FROM shiplet_revisions revision
          WHERE revision.id = ? AND revision.project_id = project.id
        ) AS candidate_exists
       FROM projects project WHERE project.id = ? LIMIT 1`,
    )
      .bind(revisionId, project.id)
      .first<{
        active_revision_id: string | null;
        candidate_exists: number;
      }>();
    if (
      revisionFence?.candidate_exists !== 1 ||
      (!exactKernelApprovalRequestId(body.approvalRequestId) &&
        !requestedIdempotencyKey &&
        revisionFence?.active_revision_id !== expectedActiveRevisionId)
    ) {
      throw new Response("Rollback revision conflict", { status: 409 });
    }
    const approval = await requireCodeModeKernelApproval({
      env,
      context,
      binding: {
        projectId: project.id,
        revisionId: expectedActiveRevisionId,
        action: "revision.rollback",
        resourceId: revisionId,
        requestDigest: await codeModeKernelApprovalDigest({
          action: "revision.rollback",
          projectId: project.id,
          resourceId: revisionId,
          expectedActiveRevisionId,
          candidateRevisionId: revisionId,
          targetIds: targetIds ?? [],
        }),
      },
      approvalRequestId: body.approvalRequestId,
    });
    if (!approval.ok) return approval;
    const idempotencyKey = approval.idempotencyKey ?? requestedIdempotencyKey;
    return executeRevisionRollback({
      env,
      access,
      project,
      revisionId,
      expectedActiveRevisionId,
      ...(targetIds ? { targetIds } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  if (request.path === "/api/projects/archive" && request.method === "POST") {
    const projectIds = Array.isArray(body.projectIds)
      ? Array.from(
          new Set(
            body.projectIds
              .map((projectId: unknown) => String(projectId || "").trim())
              .filter(Boolean),
          ),
        )
      : [];
    if (projectIds.length === 0) {
      throw new Response("Missing required field: projectIds", { status: 400 });
    }
    const archived: Project[] = [];
    for (const projectId of projectIds) {
      const project = await requireCodeModeArchiveProject(
        env,
        context,
        projectId,
      );
      const nextProject = await archiveProject(env.DB, project.id);
      if (nextProject) archived.push(nextProject);
    }
    return { archived };
  }

  const archiveMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/(archive|restore)$/,
  );
  if (archiveMatch && request.method === "POST") {
    const project = await requireCodeModeArchiveProject(
      env,
      context,
      archiveMatch[1],
    );
    return {
      project:
        archiveMatch[2] === "archive"
          ? await archiveProject(env.DB, project.id)
          : await restoreProject(env.DB, project.id),
    };
  }

  const feedbackListMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback$/,
  );
  if (feedbackListMatch && request.method === "GET") {
    const project = await requireCodeModeProject(
      env,
      context,
      feedbackListMatch[1],
      ["feedback:read"],
    );
    return {
      feedback: await listReviewFeedback(env.DB, project.id, {
        pageUrl: stringQuery(request.query?.pageUrl),
        status: stringQuery(request.query?.status),
        includeClosed: request.query?.includeClosed === true,
        limit:
          typeof request.query?.limit === "number"
            ? request.query.limit
            : undefined,
      }),
    };
  }

  if (feedbackListMatch && request.method === "POST") {
    const project = await requireCodeModeProject(
      env,
      context,
      feedbackListMatch[1],
      ["feedback:write"],
    );
    const validation = validateReviewFeedbackPayload(body);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    return {
      ok: true,
      feedback: await createReviewFeedback(
        env,
        project,
        context.kind === "user" ? context.user : null,
        validation.value,
        undefined,
        codeModeAgentActor(context),
      ),
    };
  }

  const feedbackItemMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback\/([^/]+)$/,
  );
  if (feedbackItemMatch && request.method === "GET") {
    const project = await requireCodeModeProject(
      env,
      context,
      feedbackItemMatch[1],
      ["feedback:read"],
    );
    return {
      feedback: await getReviewFeedback(
        env.DB,
        project.id,
        feedbackItemMatch[2],
      ),
    };
  }

  const replyMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback\/([^/]+)\/replies$/,
  );
  if (replyMatch && request.method === "POST") {
    const project = await requireCodeModeProject(env, context, replyMatch[1], [
      "feedback:write",
    ]);
    return {
      feedback: await createReviewReplyWithNotifications(
        env,
        project,
        replyMatch[2],
        String(body.comment || ""),
        context.kind === "user" ? context.user : null,
        normalizeMentionInputs(body.mentions),
        codeModeAgentActor(context),
      ),
    };
  }

  const statusMatch = request.path.match(
    /^\/api\/projects\/([^/]+)\/review-feedback\/([^/]+)\/status$/,
  );
  if (statusMatch && request.method === "POST") {
    const project = await requireCodeModeProject(env, context, statusMatch[1], [
      "feedback:write",
    ]);
    return {
      feedback: await updateReviewStatusWithNotifications(
        env,
        project,
        statusMatch[2],
        String(body.status || ""),
        context.kind === "user" ? context.user : null,
        codeModeAgentActor(context),
      ),
    };
  }

  throw new Response("Code Mode request path is not supported.", {
    status: 404,
  });
}

async function requireCodeModeProject(
  env: Env,
  context: CodeModeContext,
  projectId: string,
  requiredScopes: OrganizationApiScope[],
) {
  const project = await getProjectById(env.DB, projectId);
  if (!project) {
    throw new Response("Shiplet not found", { status: 404 });
  }
  if (context.kind === "token") {
    for (const scope of requiredScopes) {
      requireOrganizationApiScope(context.token, scope);
    }
    requireOrganizationApiProjectAccess(context.token, project);
    return project;
  }
  if (context.kind === "oauth_agent") {
    for (const scope of requiredScopes) {
      requireCodeModeOAuthPermission(context, scope);
    }
    if (
      context.principal.organizationId === null ||
      project.organization_id !== context.principal.organizationId
    ) {
      throw new Response("Delegated MCP organization denied", {
        status: 403,
      });
    }
  }
  if (!(await canViewProject(env.DB, project, codeModeSubject(context)!.id))) {
    throw new Response("Shiplet access denied", { status: 403 });
  }
  return project;
}

async function requireCodeModeArchiveProject(
  env: Env,
  context: CodeModeContext,
  projectId: string,
) {
  const project = await getProjectById(env.DB, projectId);
  if (!project) {
    throw new Response("Shiplet not found", { status: 404 });
  }
  if (context.kind === "token") {
    requireOrganizationApiScope(context.token, "shiplets:archive");
    requireOrganizationApiProjectAccess(context.token, project);
    return project;
  }
  if (context.kind === "oauth_agent") {
    requireCodeModeOAuthPermission(context, "shiplets:archive");
    if (
      context.principal.organizationId === null ||
      project.organization_id !== context.principal.organizationId
    ) {
      throw new Response("Delegated MCP organization denied", {
        status: 403,
      });
    }
  }
  if (!(await canEditProject(env.DB, project, codeModeSubject(context)!))) {
    throw new Response("Shiplet editor access required", { status: 403 });
  }
  return project;
}

function stringQuery(value: unknown) {
  return typeof value === "string" ? value : null;
}

function sandboxFeedbackInput(value: {
  name: string | null;
  comment: string;
  pageUrl: string;
  pathname: string;
  pageUrlKey: string;
  clientFeedbackId: string;
  screenshotDataUrl: string | null;
  screenshotMode: "page" | "element";
  screenshotFailureNote: string | null;
  viewport: Record<string, unknown> | null;
  coordinates: Record<string, unknown> | null;
  selectedElement: Record<string, unknown> | null;
  captureContext: Record<string, unknown> | null;
  userAgent: string | null;
}): SandboxFeedbackInput {
  return {
    name: value.name,
    comment: value.comment,
    pageUrl: value.pageUrl,
    pathname: value.pathname,
    pageUrlKey: value.pageUrlKey,
    clientFeedbackId: value.clientFeedbackId,
    screenshotDataUrl: value.screenshotDataUrl,
    screenshotMode: value.screenshotMode,
    screenshotFailureNote: value.screenshotFailureNote,
    viewport: value.viewport,
    coordinates: value.coordinates,
    selectedElement: value.selectedElement,
    captureContext: value.captureContext,
    userAgent: value.userAgent,
  };
}

function mcpResult(id: unknown, result: unknown) {
  return json({ jsonrpc: "2.0", id, result });
}

function mcpError(id: unknown, code: number, message: string) {
  return json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

/**
 * Request Routing Middleware
 *
 * This is the core of the multi-tenant routing system. It intercepts all requests
 * and determines whether to:
 * 1. Serve the platform UI (root domain requests)
 * 2. Dispatch to a user's Worker (subdomain or custom hostname requests)
 *
 * Routing modes:
 * - WITH custom domain: site1.platform.com → dispatches to "site1" Worker
 * - WITHOUT custom domain: platform.workers.dev/site1 → dispatches to "site1" Worker
 * - Custom hostname: user-domain.com → looks up in DB, dispatches to associated Worker
 */
app.use("*", withDbAndInit, async (c, next) => {
  const customDomain = c.env.CUSTOM_DOMAIN;
  const url = new URL(c.req.url);
  const host = url.hostname;
  const path = url.pathname;

  let project: any = null;
  let stripPathPrefix = false;

  const routeByPath = async () => {
    if (path === "/" || path === "") {
      return "reserved";
    }

    if (path.startsWith("/") && path.length > 1) {
      const subdomain = path.substring(1).split("/")[0];

      // Reserved paths for platform functionality
      if (RESERVED_PLATFORM_PATHS.has(subdomain)) {
        return "reserved";
      }

      project = await findProjectBySubdomain(c.env.DB, subdomain);
      stripPathPrefix = Boolean(project);
    }
    return project ? "matched" : "missing";
  };

  if (customDomain) {
    const platformSuffix = `.${customDomain}`;
    const configuredAppHost = appUrlHostname(c.env);

    // Root domain and production app hosts go to the platform UI. Local and
    // workers.dev app hosts still support /:subdomain path fallback.
    if (
      host === customDomain ||
      (configuredAppHost &&
        host === configuredAppHost &&
        !isPathTenantFallbackHost(configuredAppHost))
    ) {
      await next();
      return;
    }

    if (host.endsWith(platformSuffix)) {
      const subdomain = host.slice(0, -platformSuffix.length);
      project = await findProjectBySubdomain(c.env.DB, subdomain);
      if (!project) return c.text("Shiplet not found", 404);
    } else {
      // Custom hostname requests keep their path intact. Local/workers.dev
      // requests can still use /:subdomain for development and fallback access.
      project = await findProjectByCustomHostname(c.env.DB, host);
      if (!project && canUsePathTenantRouting(host, c.env)) {
        const result = await routeByPath();
        if (result === "reserved") {
          await next();
          return;
        }
      } else if (!project) {
        return c.text("Shiplet custom hostname not configured", 404);
      }
    }
  } else {
    if (!canUsePathTenantRouting(host, c.env)) {
      await next();
      return;
    }
    const result = await routeByPath();
    if (result === "reserved") {
      await next();
      return;
    }
  }

  // If we found a matching project, dispatch the request to the user's Worker
  if (project) {
    let user = await getCurrentUser(c.req.raw, c.env);
    const authenticatedUserId = user?.id;
    if (project.archived_on) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return c.text("Shiplet has been archived", 410);
      }
      return archivedShipletPageResponse(c, project, user);
    }
    const tenantPath = stripPathPrefix
      ? path.substring(path.substring(1).split("/")[0].length + 1) || "/"
      : path || "/";
    const isPlatformReviewBridgeNamespace =
      tenantPath === "/api/review" || tenantPath.startsWith("/api/review/");
    if (isPlatformReviewBridgeNamespace) {
      await next();
      return;
    }
    const isTrustedReviewNamespace =
      tenantPath === "/__shiplet/review" ||
      tenantPath.startsWith("/__shiplet/review/");
    const artifactFramePrefix = "/__shiplet/artifact-frame";
    const isArtifactFrameRequest =
      tenantPath === artifactFramePrefix ||
      tenantPath.startsWith(`${artifactFramePrefix}/`);
    const isExternalRootSubresourceRead =
      !isArtifactFrameRequest &&
      !isTrustedReviewNamespace &&
      isExternalTenantSubresourceRead(project, c.req.raw);
    const isAnonymousExternalArtifactRead =
      (isArtifactFrameRequest || isExternalRootSubresourceRead) &&
      isPublicExternalArtifactRead(project, c.req.raw);
    let canView = await canViewProject(c.env.DB, project, user?.id);
    let artifactCapability: ReviewCapability | null = null;
    const queryCapabilityToken = artifactPreviewQueryToken(c.req.raw);
    if (queryCapabilityToken) {
      artifactCapability = await verifyArtifactPreviewCapability(
        c.env,
        queryCapabilityToken,
        project,
      );
      if (!artifactCapability) {
        return staleArtifactCapabilityResponse(c.req.raw);
      }
      if (!canView) {
        user = reviewCapabilityUser(artifactCapability);
        canView = true;
      }
      return artifactCapabilityExchangeResponse(
        c.req.raw,
        queryCapabilityToken,
      );
    }
    if (!canView) {
      artifactCapability = await authenticateArtifactPreviewCapability(
        c.env,
        c.req.raw,
        project,
      );
      if (artifactCapability) {
        user = reviewCapabilityUser(artifactCapability);
        canView = true;
      }
    }
    // URL sources are fetched without upstream credentials and are public by
    // construction. Their opaque review iframe cannot send Shiplet cookies for
    // linked CSS, scripts, fonts, or images, so only this read-only artifact
    // proxy is available without a Shiplet session. Review UI and APIs remain
    // access-controlled below.
    if (!canView && isAnonymousExternalArtifactRead) canView = true;
    if (!canView) {
      const accessGateUrl = shipletAccessGateUrl(
        c.env,
        c.req.url,
        project,
        new URL(c.req.url).toString(),
      );
      return user
        ? c.redirect(accessGateUrl)
        : c.redirect(authLoginRedirectUrl(c.env, c.req.url, accessGateUrl));
    }

    const trustedReviewApiPath = "/__shiplet/review/feedback";
    const trustedReviewWidgetMatch = tenantPath.match(
      /^\/__shiplet\/review\/widget\/([^/]+)(?:\/(.*))?$/,
    );
    if (trustedReviewWidgetMatch) {
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return c.text("Method not allowed", 405, { Allow: "GET, HEAD" });
      }
      return serveActiveReviewWidget(
        c.env,
        project,
        trustedReviewWidgetMatch[1],
        stripPathPrefix
          ? new URL(appBaseUrl(c.env, c.req.url)).origin
          : new URL(c.req.url).origin,
        trustedReviewWidgetMatch[2] || undefined,
      );
    }
    const trustedReviewPresencePath = "/__shiplet/review/presence/ws";
    if (tenantPath === trustedReviewPresencePath) {
      if (c.req.method !== "GET") {
        return c.text("Method not allowed", 405, { Allow: "GET" });
      }
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
        return c.text("Review presence expected Upgrade: websocket", 426);
      }
      if (!c.env.SHIPLET_ROOT) {
        return c.text("Review presence is not configured", 503);
      }
      const origin = c.req.header("origin");
      if (!origin || origin !== new URL(c.req.url).origin) {
        return c.text("Review presence origin denied", 403);
      }
      if (
        artifactCapability &&
        !artifactCapability.scopes.includes("presence:join")
      ) {
        return c.text("Review capability denied", 403);
      }
      const stub = c.env.SHIPLET_ROOT.getByName(project.id);
      return stub.fetch(reviewPresenceRequest(c.req.raw, project, user));
    }
    const trustedReviewMentionUsersPath = "/__shiplet/review/mention-users";
    if (tenantPath === trustedReviewMentionUsersPath) {
      if (c.req.method !== "GET") {
        return c.text("Method not allowed", 405, { Allow: "GET" });
      }
      if (
        artifactCapability &&
        !artifactCapability.scopes.includes("feedback:read")
      ) {
        return c.text("Review capability denied", 403);
      }
      const url = new URL(c.req.url);
      return json({
        users: await listTrustedReviewMentionCandidates(
          c.env,
          project,
          artifactCapability ? null : user,
          url.searchParams.get("q") || "",
          Number(url.searchParams.get("limit") || 20),
        ),
      });
    }
    const trustedReviewReplyMatch = tenantPath.match(
      /^\/__shiplet\/review\/feedback\/([^/]+)\/replies$/,
    );
    if (trustedReviewReplyMatch) {
      if (c.req.method !== "POST") {
        return c.text("Method not allowed", 405, { Allow: "POST" });
      }
      const rejection = tenantReviewMutationRejection(c.req.raw);
      if (rejection) return rejection;
      if (
        artifactCapability &&
        !artifactCapability.scopes.includes("feedback:write")
      ) {
        return c.text("Review capability denied", 403);
      }
      if (!user) return c.text("Review access required", 401);
      const body = await readJson(c);
      return json(
        {
          feedback: await createReviewReplyWithNotifications(
            c.env,
            project,
            trustedReviewReplyMatch[1],
            String(body.comment || ""),
            user,
            normalizeMentionInputs(body.mentions),
          ),
        },
        201,
      );
    }
    const trustedReviewStatusMatch = tenantPath.match(
      /^\/__shiplet\/review\/feedback\/([^/]+)\/status$/,
    );
    if (trustedReviewStatusMatch) {
      if (c.req.method !== "POST") {
        return c.text("Method not allowed", 405, { Allow: "POST" });
      }
      const rejection = tenantReviewMutationRejection(c.req.raw);
      if (rejection) return rejection;
      if (
        artifactCapability &&
        !artifactCapability.scopes.includes("feedback:write")
      ) {
        return c.text("Review capability denied", 403);
      }
      if (!user) return c.text("Review access required", 401);
      const body = await readJson(c);
      return json({
        feedback: await updateReviewStatusWithNotifications(
          c.env,
          project,
          trustedReviewStatusMatch[1],
          String(body.status || ""),
          user,
        ),
      });
    }
    const trustedReviewWatchPath = "/__shiplet/review/watch";
    if (tenantPath === trustedReviewWatchPath) {
      if (c.req.method === "POST" || c.req.method === "DELETE") {
        const rejection = tenantReviewMutationRejection(c.req.raw);
        if (rejection) return rejection;
      }
      if (!user || artifactCapability) {
        return c.text("Review watch requires an authenticated reviewer", 403);
      }
      if (c.req.method === "GET") {
        return json({ watch: await getWatchStatus(c.env.DB, project, user) });
      }
      if (c.req.method === "POST" || c.req.method === "DELETE") {
        return json({
          watch: await setWatchStatus(
            c.env.DB,
            project,
            user,
            c.req.method === "POST",
          ),
        });
      }
      return c.text("Method not allowed", 405, {
        Allow: "GET, POST, DELETE",
      });
    }
    if (tenantPath === trustedReviewApiPath) {
      if (c.req.method === "GET") {
        if (
          artifactCapability &&
          !artifactCapability.scopes.includes("feedback:read")
        ) {
          return c.text("Review capability denied", 403);
        }
        const url = new URL(c.req.url);
        return json({
          feedback: await listReviewFeedback(c.env.DB, project.id, {
            pageUrl: url.searchParams.get("pageUrl"),
            status: url.searchParams.get("status"),
            includeClosed: url.searchParams.get("includeClosed") === "true",
            limit: Number(url.searchParams.get("limit") || 100),
          }),
        });
      }
      if (c.req.method === "POST") {
        const rejection = tenantReviewMutationRejection(c.req.raw);
        if (rejection) return rejection;
        if (
          artifactCapability &&
          !artifactCapability.scopes.includes("feedback:write")
        ) {
          return c.text("Review capability denied", 403);
        }
        if (!user) return c.text("Review access required", 401);
        const validation = validateReviewFeedbackPayload(await readJson(c));
        if (!validation.ok) {
          return json({ ok: false, errors: validation.errors }, 400);
        }
        const feedback = await createReviewFeedback(
          c.env,
          project,
          user,
          validation.value,
        );
        return json({ ok: true, feedback }, 201);
      }
      return c.text("Method not allowed", 405, { Allow: "GET, POST" });
    }
    if (isExternalRootSubresourceRead) {
      const subresourceUrl = new URL(c.req.url);
      subresourceUrl.pathname = tenantPath;
      const subresourceRequest = stripInternalArtifactSearchParams(
        new Request(subresourceUrl.toString(), {
          method: c.req.method,
          headers: c.req.raw.headers,
        }),
      );
      const external = await serveExternalOrigin(
        c.env,
        project,
        subresourceRequest,
        stripPathPrefix
          ? `/${project.subdomain}${artifactFramePrefix}`
          : artifactFramePrefix,
      );
      return exposeExternalArtifactToOpaqueSandbox(
        subresourceRequest,
        await injectReviewClient(
          c.env,
          subresourceRequest,
          external.response,
          project,
          user,
          {
            rootAssetPrefix: stripPathPrefix
              ? `/${project.subdomain}${artifactFramePrefix}`
              : artifactFramePrefix,
            externalSourceUrl: external.finalUrl || undefined,
            waitUntil: (promise) => c.executionCtx.waitUntil(promise),
          },
        ),
      );
    }
    const activeRuntime = await managedRuntimeForProject(c.env, project);
    if (
      !isArtifactFrameRequest &&
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      !isExternalProject(project) &&
      activeRuntime !== "worker"
    ) {
      const probeUrl = new URL(c.req.url);
      probeUrl.pathname = tenantPath;
      const probeRequest = stripInternalArtifactSearchParams(
        new Request(probeUrl.toString(), {
          method: c.req.method,
          headers: c.req.raw.headers,
        }),
      );
      const probe =
        (await serveActiveRevisionStaticArtifact(
          c.env,
          project,
          probeRequest,
        )) ??
        (await serveStaticAsset(
          c.env.DB,
          c.env.SHIPLET_ASSETS,
          project,
          probeRequest,
        ));
      if (!probe) return c.text("Shiplet asset not found", 404);
      const probeContentType =
        probe.headers.get("content-type") || "application/octet-stream";
      if (!probeContentType.toLowerCase().includes("text/html")) {
        if (c.req.method === "HEAD" || probe.body === null) return probe;
        return createSandboxedArtifactResponse({
          body: probe.body,
          contentType: probeContentType,
          role: "artifact",
          trustedHostOrigin: new URL(c.req.url).origin,
          status: probe.status,
          sourceHeaders: probe.headers,
        });
      }
    }
    if (
      !isArtifactFrameRequest &&
      (c.req.method === "GET" || c.req.method === "HEAD")
    ) {
      const trustedTenantUrl = stripPathPrefix
        ? new URL(appBaseUrl(c.env, c.req.url))
        : new URL(c.req.url);
      const artifactFrameUrl = new URL(trustedTenantUrl);
      const reviewApiUrl = new URL(trustedTenantUrl);
      const widgetUrl = new URL(trustedTenantUrl);
      artifactFrameUrl.search = "";
      artifactFrameUrl.hash = "";
      reviewApiUrl.search = "";
      reviewApiUrl.hash = "";
      widgetUrl.search = "";
      widgetUrl.hash = "";
      const requestedArtifactPath = tenantPath === "/" ? "/" : tenantPath;
      artifactFrameUrl.pathname = stripPathPrefix
        ? `/${project.subdomain}${artifactFramePrefix}${requestedArtifactPath}`
        : `${artifactFramePrefix}${requestedArtifactPath}`;
      reviewApiUrl.pathname = stripPathPrefix
        ? `/${project.subdomain}${trustedReviewApiPath}`
        : trustedReviewApiPath;
      const widget = await activeReviewWidget(c.env, project);
      if (widget) {
        widgetUrl.pathname = stripPathPrefix
          ? `/${project.subdomain}/__shiplet/review/widget/${encodeURIComponent(widget.revisionId)}/`
          : `/__shiplet/review/widget/${encodeURIComponent(widget.revisionId)}/`;
        if (widget.layerVersion) {
          widgetUrl.searchParams.set("layer", widget.layerVersion);
        }
      }
      const canonicalReviewPageUrl = new URL(
        artifactAbsoluteUrl(c.env, c.req.url, project),
      );
      const canonicalBasePath = canonicalReviewPageUrl.pathname.replace(
        /\/$/,
        "",
      );
      canonicalReviewPageUrl.pathname =
        `${canonicalBasePath}${requestedArtifactPath === "/" ? "" : requestedArtifactPath}` ||
        "/";
      canonicalReviewPageUrl.search = new URL(c.req.url).search;
      return attachArtifactAccessCookie(
        createTrustedReviewHostResponse({
          shipletId: project.id,
          revisionId: trustedReviewRevisionId(project),
          title: project.name,
          artifactUrl: artifactFrameUrl.toString(),
          widgetUrl: widget ? widgetUrl.toString() : null,
          hostScriptUrl: new URL(
            "/api/review/host.js",
            appBaseUrl(c.env, c.req.url),
          ).toString(),
          confirmationUrl: new URL(
            "/review/confirm",
            appBaseUrl(c.env, c.req.url),
          ).toString(),
          reviewApiUrl: reviewApiUrl.toString(),
          reviewPageUrl: canonicalReviewPageUrl.toString(),
          allowArtifactDownloads: standalonePreviewDownloadsAllowed(
            project,
            requestedArtifactPath,
          ),
        }),
        c.env,
        c.req.url,
        project,
        artifactCapability ? null : user,
      );
    }

    let requestToForward = c.req.raw;
    const artifactAssetPath = isArtifactFrameRequest
      ? tenantPath.slice(artifactFramePrefix.length) || "/"
      : tenantPath;
    const rawAssetPrefix = stripPathPrefix
      ? `/${project.subdomain}${artifactFramePrefix}`
      : artifactFramePrefix;
    const artifactOptions: ArtifactResponseOptions = isArtifactFrameRequest
      ? {
          rootAssetPrefix: rawAssetPrefix,
          waitUntil: (promise) => c.executionCtx.waitUntil(promise),
        }
      : stripPathPrefix
        ? {
            rootAssetPrefix: `/${project.subdomain}`,
            waitUntil: (promise) => c.executionCtx.waitUntil(promise),
          }
        : {};
    const finalizeArtifactResponse = async (
      response: Response,
      responseOptions: ArtifactResponseOptions = {},
    ) => {
      const prepared = await injectReviewClient(
        c.env,
        requestToForward,
        response,
        project,
        user,
        { ...artifactOptions, ...responseOptions },
      );
      if (!isArtifactFrameRequest || prepared.body === null) {
        return isExternalProject(project) && isArtifactFrameRequest
          ? exposeExternalArtifactToOpaqueSandbox(requestToForward, prepared)
          : prepared;
      }
      const sandboxed = createSandboxedArtifactResponse({
        body: prepared.body,
        contentType:
          prepared.headers.get("content-type") || "application/octet-stream",
        role: "artifact",
        trustedHostOrigin: stripPathPrefix
          ? new URL(appBaseUrl(c.env, c.req.url)).origin
          : new URL(c.req.url).origin,
        allowDownloads: standalonePreviewDownloadsAllowed(
          project,
          artifactAssetPath,
        ),
        status: prepared.status,
        sourceHeaders: prepared.headers,
      });
      return isExternalProject(project)
        ? exposeExternalArtifactToOpaqueSandbox(requestToForward, sandboxed)
        : sandboxed;
    };

    // In path mode, strip the project name from the path so
    // /site1/page becomes /page for the Worker or static asset lookup.
    if (stripPathPrefix) {
      const subdomain = path.substring(1).split("/")[0];
      const newUrl = new URL(c.req.url);
      newUrl.pathname = artifactAssetPath;
      requestToForward = new Request(newUrl.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.raw.body,
      });
    } else if (isArtifactFrameRequest) {
      const newUrl = new URL(c.req.url);
      newUrl.pathname = artifactAssetPath;
      requestToForward = new Request(newUrl.toString(), {
        method: c.req.method,
        headers: c.req.raw.headers,
        body: c.req.raw.body,
      });
    }
    requestToForward = stripInternalArtifactSearchParams(requestToForward);

    const activeRevisionResponse = await serveActiveRevisionStaticArtifact(
      c.env,
      project,
      requestToForward,
      authenticatedUserId,
    );
    if (activeRevisionResponse) {
      return finalizeArtifactResponse(activeRevisionResponse);
    }

    const activeManagedResponse = await serveActiveManagedRuntimeArtifact(
      c.env,
      project,
      requestToForward,
      authenticatedUserId,
    );
    if (activeManagedResponse) {
      return finalizeArtifactResponse(activeManagedResponse);
    }

    if (isExternalProject(project)) {
      const external = await serveExternalOrigin(
        c.env,
        project,
        requestToForward,
        artifactOptions.rootAssetPrefix,
      );
      return finalizeArtifactResponse(external.response, {
        externalSourceUrl: external.finalUrl || undefined,
      });
    }

    if (project.source_type === "worker") {
      return c.text("Managed arbitrary Worker execution is unavailable", 503, {
        "x-shiplet-runtime-status": "managed_dynamic_unavailable",
      });
    }

    const response = await serveStaticAsset(
      c.env.DB,
      c.env.SHIPLET_ASSETS,
      project,
      requestToForward,
    );
    if (!response) return c.text("Shiplet asset not found", 404);
    return finalizeArtifactResponse(response);
  }

  // No matching project - continue to platform routes
  await next();
});

app.get("/play", async (c) => {
  try {
    const url = new URL(c.req.url);
    const sessionId = sandboxSessionIdFromRequest(c.req.raw, url, {
      ignoreCookie: !url.searchParams.has("session"),
    });
    const actorId = sandboxActorIdFromRequest(c.req.raw, url);
    const snapshot = await sandboxStub(c.env, sessionId).snapshot(
      sessionId,
      actorId,
      appBaseUrl(c.env, c.req.url),
    );
    const response = c.html(
      renderPage(BuildSandboxPlayPage(snapshot, kernelDocumentNonce(c)), {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        indexing: "noindex",
      }),
    );
    return withSandboxCookies(response, sessionId, actorId);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load sandbox: ${message}`, 500);
  }
});

app.get("/api/play/session", async (c) => {
  try {
    const url = new URL(c.req.url);
    const sessionId = sandboxSessionIdFromRequest(c.req.raw, url);
    const actorId = sandboxActorIdFromRequest(c.req.raw, url);
    const response = json(
      await sandboxStub(c.env, sessionId).snapshot(
        sessionId,
        actorId,
        appBaseUrl(c.env, c.req.url),
      ),
    );
    return withSandboxCookies(response, sessionId, actorId);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load sandbox session: ${message}`, 500);
  }
});

app.post("/api/play/reset", async (c) => {
  try {
    const url = new URL(c.req.url);
    const sessionId = sandboxSessionIdFromRequest(c.req.raw, url);
    const actorId = sandboxActorIdFromRequest(c.req.raw, url);
    if (isSharedSandboxSessionId(sessionId)) {
      return c.text("Shared sandbox cannot be reset.", 403);
    }
    const response = json(
      await sandboxStub(c.env, sessionId).reset(
        sessionId,
        actorId,
        appBaseUrl(c.env, c.req.url),
      ),
    );
    return withSandboxCookies(response, sessionId, actorId);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to reset sandbox: ${message}`, 500);
  }
});

app.post("/api/play/mcp", async (c) => {
  try {
    const url = new URL(c.req.url);
    const sessionId = sandboxSessionIdFromRequest(c.req.raw, url);
    const actorId = sandboxActorIdFromRequest(c.req.raw, url);
    const response = await handleSandboxMcpRequest(
      c.env,
      sessionId,
      actorId,
      appBaseUrl(c.env, c.req.url),
      await readJson(c),
    );
    return withSandboxCookies(response, sessionId, actorId);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to handle sandbox MCP request: ${message}`, 500);
  }
});

app.get("/play/preview/:projectId/artifact-frame", async (c) => {
  try {
    const projectId = sandboxProjectIdFromPreviewParam(
      c.req.param("projectId"),
    );
    const sessionId = sandboxSessionIdForProject(projectId);
    if (!sessionId) return c.text("Sandbox shiplet not found", 404);
    const shiplet = await sandboxStub(c.env, sessionId).getShiplet(
      sessionId,
      projectId,
    );
    if (!shiplet) return c.text("Sandbox shiplet not found", 404);
    const response = createSandboxedArtifactResponse({
      body: injectTrustedArtifactBridge(shiplet.html),
      contentType: "text/html; charset=utf-8",
      role: "artifact",
      trustedHostOrigin: new URL(appBaseUrl(c.env, c.req.url)).origin,
    });
    return withSandboxCookies(
      response,
      sessionId,
      sandboxActorIdFromRequest(c.req.raw, new URL(c.req.url)),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load sandbox artifact: ${message}`, 500);
  }
});

app.get("/play/preview/:projectId", async (c) => {
  try {
    const projectId = sandboxProjectIdFromPreviewParam(
      c.req.param("projectId"),
    );
    const sessionId = sandboxSessionIdForProject(projectId);
    if (!sessionId) return c.text("Sandbox shiplet not found", 404);
    const shiplet = await sandboxStub(c.env, sessionId).getShiplet(
      sessionId,
      projectId,
    );
    if (!shiplet) return c.text("Sandbox shiplet not found", 404);
    const response = sandboxPreviewResponse(
      c.env,
      c.req.url,
      projectId,
      shiplet.name,
    );
    return withSandboxCookies(
      response,
      sessionId,
      sandboxActorIdFromRequest(c.req.raw, new URL(c.req.url)),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load sandbox preview: ${message}`, 500);
  }
});

app.get("/favicon.ico", () => brandAssetResponse("logoPng"));

app.get("/favicon.svg", () => faviconSvgResponse());

app.get("/brand/logo.png", () => brandAssetResponse("logoPng"));

app.get("/brand/decor/rope-h.png", () => brandAssetResponse("ropeHPng"));

app.get("/brand/decor/rope-v.png", () => brandAssetResponse("ropeVPng"));

app.get("/brand/decor/rope-knot.png", () => brandAssetResponse("ropeKnotPng"));

app.get("/brand/decor/anchor.png", () => brandAssetResponse("anchorPng"));

app.get("/brand/decor/compass.png", () => brandAssetResponse("compassPng"));

app.get("/brand/docs/agent-registration-flow.svg", () =>
  agentRegistrationFlowResponse(),
);

app.get("/brand/why-shiplet/default-review-flow.webp", () =>
  whyShipletAssetResponse("defaultReviewFlow"),
);

app.get("/brand/why-shiplet/durable-object-benefits.webp", () =>
  whyShipletAssetResponse("durableObjectBenefits"),
);

app.get("/brand/why-shiplet/research-evidence-board.webp", () =>
  whyShipletAssetResponse("researchEvidenceBoard"),
);

app.get("/brand/why-shiplet/ticket-acceptance-runner.webp", () =>
  whyShipletAssetResponse("ticketAcceptanceRunner"),
);

app.get("/brand/why-shiplet/shiplet-root-hero.webp", () =>
  whyShipletAssetResponse("shipletRootHero"),
);

app.get("/brand/why-shiplet/shiplet-root-runtime.webp", () =>
  whyShipletAssetResponse("shipletRootRuntime"),
);

app.get(AVATAR_SPRITE_URL, () => avatarPresetsAssetResponse());

app.get("/brand/avatars/shiplet-avatar-presets-v8.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets-v7.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets-v6.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets-v5.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets-v4.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets-v3.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets-v2.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/brand/avatars/shiplet-avatar-presets.png", () =>
  avatarPresetsAssetResponse(),
);

app.get("/assets/platform/:assetName", (c) => {
  const pathname = new URL(c.req.url).pathname;
  const source =
    PLATFORM_CLIENT_ASSETS[pathname as keyof typeof PLATFORM_CLIENT_ASSETS];
  if (typeof source !== "string") {
    return c.notFound();
  }
  return new Response(source, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "application/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/apple-touch-icon.png", () => brandAssetResponse("appleTouchIconPng"));

app.get("/og-image.png", () => brandAssetResponse("ogImagePng"));

app.get("/site.webmanifest", (c) =>
  manifestResponse(appBaseUrl(c.env, c.req.url)),
);

app.get("/robots.txt", (c) => robotsResponse(appBaseUrl(c.env, c.req.url)));

app.get("/sitemap.xml", (c) => sitemapResponse(appBaseUrl(c.env, c.req.url)));

app.get("/llms.txt", (c) => llmsResponse(appBaseUrl(c.env, c.req.url)));

app.get("/openapi.json", () => json(SHIPLET_OPENAPI_SPEC));

app.get("/docs", (c) => {
  const page = getDocsPage("introduction")!;
  return c.html(
    renderPage(BuildDocsPage(page.slug), {
      nonce: kernelDocumentNonce(c),
      customDomain: c.env.CUSTOM_DOMAIN,
      appUrl: appBaseUrl(c.env, c.req.url),
      title: `${page.title} | Shiplet Docs`,
      description: page.description,
      canonicalPath: "/docs",
      skipLink: { href: "#docs-article", label: "Skip to article" },
    }),
  );
});

app.get("/docs/:slug", (c) => {
  const slug = c.req.param("slug");
  if (slug === "introduction") return c.redirect("/docs", 301);
  const retiredPublicDocRedirects: Record<string, string> = {
    "packages-revisions": "/docs/publishing",
    cli: "/docs/code-mode-mcp",
    deployment: "/docs/publishing",
    "external-setup": "/docs/security",
  };
  const retiredRedirect = retiredPublicDocRedirects[slug];
  if (retiredRedirect) return c.redirect(retiredRedirect, 301);
  const page = getDocsPage(slug);
  if (!page) {
    return c.html(
      renderPage(BuildDocsNotFoundPage(), {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        title: "Documentation page not found | Shiplet Docs",
        description:
          "That Shiplet documentation page does not exist or has moved.",
        canonicalPath: null,
        indexing: "noindex",
        skipLink: { href: "#docs-article", label: "Skip to article" },
      }),
      404,
    );
  }
  return c.html(
    renderPage(BuildDocsPage(page.slug), {
      nonce: kernelDocumentNonce(c),
      customDomain: c.env.CUSTOM_DOMAIN,
      appUrl: appBaseUrl(c.env, c.req.url),
      title: `${page.title} | Shiplet Docs`,
      description: page.description,
      canonicalPath: `/docs/${page.slug}`,
      skipLink: { href: "#docs-article", label: "Skip to article" },
    }),
  );
});

app.get("/.well-known/oauth-protected-resource", (c) =>
  mcpProtectedResourceMetadataResponse(c.env, appBaseUrl(c.env, c.req.url)),
);

app.get("/.well-known/oauth-protected-resource/api/mcp", (c) =>
  mcpProtectedResourceMetadataResponse(c.env, appBaseUrl(c.env, c.req.url)),
);

app.get("/.well-known/oauth-authorization-server", (c) =>
  proxyWorkOSAuthorizationServerMetadata(c.env),
);

app.get("/auth.md", (c) => proxyWorkOSAgentAuthGuide(c.env));

app.get("/cli/authorize", async (c) => {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(
        `/auth/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      );
    }
    const url = new URL(c.req.url);
    const authorization = await createCliAuthorizationRequest(c.env.DB, {
      userId: user.id,
      redirectUri: url.searchParams.get("redirect_uri"),
      state: url.searchParams.get("state"),
      codeChallenge: url.searchParams.get("code_challenge"),
      method: url.searchParams.get("code_challenge_method"),
    });
    if (!authorization) return c.text("Invalid CLI authorization request", 400);
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Shiplet CLI</title></head><body><main><h1>Authorize Shiplet CLI</h1><p>Allow this local CLI process to act as you for ten minutes. It can read and edit Shiplet revisions and perform only explicitly approved deployment actions.</p><form method="post" action="/cli/authorize/complete"><input type="hidden" name="request_id" value="${escapeAuthHtml(authorization.id)}"><button type="submit" name="approval" value="approve">Authorize CLI</button></form></main></body></html>`;
    return new Response(body, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to prepare CLI authorization", 500);
  }
});

app.post("/cli/authorize/complete", async (c) => {
  try {
    const origin = new URL(appBaseUrl(c.env, c.req.url)).origin;
    if (
      !hasTrustedTopLevelFormProvenance(c.req.raw, [
        origin,
        new URL(c.req.url).origin,
      ])
    ) {
      return c.text("Trusted CLI authorization origin required", 403);
    }
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return c.text("CLI authorization form required", 403);
    }
    const user = await requireCurrentUser(c);
    const form = await c.req.raw.formData();
    if (String(form.get("approval") || "") !== "approve") {
      return c.text("CLI authorization denied", 403);
    }
    const approved = await approveCliAuthorizationRequest(c.env.DB, {
      requestId: String(form.get("request_id") || ""),
      userId: user.id,
    });
    if (!approved)
      return c.text("CLI authorization expired or already used", 403);
    const callback = new URL(approved.redirectUri);
    callback.searchParams.set("code", approved.code);
    callback.searchParams.set("state", approved.state);
    return new Response(null, {
      status: 302,
      headers: {
        location: callback.toString(),
        "cache-control": "no-store",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to complete CLI authorization", 500);
  }
});

app.post("/api/cli/session/exchange", async (c) => {
  try {
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/json")) {
      return c.text("CLI session JSON required", 415);
    }
    const body = await readJson(c);
    const result = await exchangeCliAuthorizationCode(c.env.DB, {
      code: body.code,
      verifier: body.verifier,
      redirectUri: body.redirectUri,
    });
    if (!result.ok) {
      const response = json(
        {
          ok: false,
          code:
            result.reason === "replayed"
              ? "cli_code_replayed"
              : "cli_code_invalid",
        },
        result.reason === "replayed" ? 409 : 403,
      );
      response.headers.set("cache-control", "no-store");
      return response;
    }
    const response = json(
      { accessToken: result.accessToken, expiresOn: result.expiresOn },
      201,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return c.text("Failed to exchange CLI authorization", 500, {
      "cache-control": "no-store",
    });
  }
});

app.post("/api/cli/session/revoke", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const revoked = await revokeCliSession(c.env.DB, c.req.raw, user.id);
    if (!revoked) return c.text("CLI session unavailable", 401);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to revoke CLI session", 500, {
      "cache-control": "no-store",
    });
  }
});

function workOSLoginRedirect(
  c: any,
  options: {
    returnTo: string;
    invitationToken?: string | null;
    accountAction?: string;
    consentToken?: string | null;
    organizationId?: string | null;
  },
) {
  const state = btoa(
    JSON.stringify({
      returnTo: options.returnTo,
      invitationToken: options.invitationToken || undefined,
      accountAction: options.accountAction,
      consentToken: options.consentToken || undefined,
    }),
  );
  const authorizationUrl = getWorkOSAuthorizationUrl(c.env, {
    state,
    invitationToken: options.invitationToken,
    organizationId: options.organizationId,
    redirectUri:
      c.env.WORKOS_REDIRECT_URI ||
      new URL("/auth/callback", c.req.url).toString(),
    prompt: options.accountAction === "add" ? "login" : undefined,
  });
  return c.redirect(authorizationUrl);
}

app.get("/auth/login", async (c) => {
  try {
    const url = new URL(c.req.url);
    const consentToken = url.searchParams.get("consent");
    if (consentToken) {
      return invitationConsentPageResponse(c, consentToken);
    }

    const invitationToken = url.searchParams.get("invitation_token");
    const returnTo = safeReturnTo(c.env, url.searchParams.get("return_to"));
    const organizationId = await organizationIdForAuthReturn(
      c.env,
      c.req.url,
      returnTo,
    );
    const accountSwitchingEnabled = useFeatureFlag(
      c.env,
      ACCOUNT_EMAIL_SWITCHING_FLAG,
    );
    const accountAction =
      accountSwitchingEnabled &&
      url.searchParams.get("account_action") === "add"
        ? "add"
        : undefined;

    if (invitationToken) {
      const pending = await findPendingInvitationsByWorkOSInvitationToken(
        c.env.DB,
        invitationToken,
      );
      const invitation = pending[0];
      if (invitation?.project_id) {
        const project = await getProjectById(c.env.DB, invitation.project_id);
        if (project && !project.archived_on) {
          const requestedProject = await projectFromAuthReturnTo(
            c.env,
            c.req.url,
            returnTo,
          );
          const scopedReturnTo =
            requestedProject?.id === project.id
              ? returnTo
              : artifactPublicUrl(c.env, c.req.url, project);
          const signedConsent = await createInvitationConsentToken(c.env, {
            projectId: project.id,
            invitationId: invitation.id,
            returnTo: scopedReturnTo,
          });
          const cleanUrl = new URL("/auth/login", appBaseUrl(c.env, c.req.url));
          cleanUrl.searchParams.set("consent", signedConsent);
          return c.redirect(cleanUrl.toString(), 302);
        }
      }
      return workOSLoginRedirect(c, {
        returnTo,
        invitationToken,
        accountAction,
        organizationId,
      });
    }

    const project = await projectFromAuthReturnTo(c.env, c.req.url, returnTo);
    if (
      project &&
      !project.archived_on &&
      project.visibility !== "public" &&
      project.visibility !== "unlisted" &&
      project.organization_id &&
      (await findPendingInvitationsByProject(c.env.DB, project.id)).length > 0
    ) {
      const signedConsent = await createInvitationConsentToken(c.env, {
        projectId: project.id,
        returnTo,
      });
      return invitationConsentPageResponse(c, signedConsent);
    }

    return workOSLoginRedirect(c, {
      returnTo,
      accountAction,
      organizationId,
    });
  } catch (error) {
    if (isResponse(error)) return error;
    console.error(
      JSON.stringify({
        event: "auth.login",
        outcome: "failed",
        reason: "internal_error",
      }),
    );
    return c.text("Unable to start authentication", 500);
  }
});

app.post("/auth/login", async (c) => {
  try {
    if (
      !isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin") || null, {
        method: "POST",
        hasCookie: true,
      })
    ) {
      return c.text("Invitation consent origin denied", 403);
    }
    const body = await c.req.parseBody();
    const consentToken = String(body.consent_token || "");
    const verification = await verifyInvitationConsentToken(
      c.env,
      consentToken,
    );
    if (!verification.ok) {
      return c.text("Invitation consent is invalid or expired", 400);
    }
    const consent = verification.consent;
    const project = await projectFromAuthReturnTo(
      c.env,
      c.req.url,
      consent.returnTo,
    );
    if (!project || project.id !== consent.projectId) {
      return c.text("Invitation consent is invalid or expired", 400);
    }

    const currentUser = await getCurrentUser(c.req.raw, c.env);
    if (currentUser) {
      const workosUserId =
        (await latestWorkOSUserIdForLocalUser(c.env.DB, currentUser.id)) ||
        currentUser.id;
      await acceptInvitationConsentForUser(
        c.env,
        c.req.url,
        {
          id: workosUserId,
          email: currentUser.email,
          emailVerified: true,
          firstName: currentUser.first_name,
          lastName: currentUser.last_name,
        },
        consent,
      );
      return c.redirect(
        await resolvePostAuthReturnTo(c, consent.returnTo, currentUser),
        302,
      );
    }

    return workOSLoginRedirect(c, {
      returnTo: consent.returnTo,
      consentToken,
      organizationId: await organizationIdForAuthReturn(
        c.env,
        c.req.url,
        consent.returnTo,
      ),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    console.error(
      JSON.stringify({
        event: "auth.invitation",
        outcome: "failed",
        reason: "internal_error",
      }),
    );
    return c.text("Unable to continue invitation", 500);
  }
});

app.get("/auth/callback", async (c) => {
  try {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = decodeState(url.searchParams.get("state")) as {
      returnTo?: string;
      invitationToken?: string;
      accountAction?: string;
      consentToken?: string;
    };

    if (!code) {
      return c.text("Missing WorkOS authorization code", 400);
    }

    const authResponse = await authenticateWorkOSCode(c.env, {
      code,
      invitationToken: state.invitationToken,
      ipAddress: c.req.header("cf-connecting-ip") || null,
      userAgent: c.req.header("user-agent") || null,
    });

    const workosUser: WorkOSUser = authResponse.user;
    let invitationId: string | null = null;
    let organizationId = authResponse.organizationId;
    let callbackReturnTo = safeReturnTo(c.env, state.returnTo);
    let user: ShipletUser;

    if (state.invitationToken) {
      try {
        const invitation = await findWorkOSInvitationByToken(
          c.env,
          state.invitationToken,
        );
        invitationId = invitation.id;
        if (
          invitation.email.trim().toLowerCase() ===
          workosUser.email.trim().toLowerCase()
        ) {
          organizationId =
            organizationId || invitation.organizationId || undefined;
        }
      } catch {
        // The token may already be consumed; local pending invites can still be
        // resolved by token or email below.
      }
    }

    if (state.consentToken) {
      const verification = await verifyInvitationConsentToken(
        c.env,
        state.consentToken,
      );
      if (!verification.ok) {
        return c.text("Invitation consent is invalid or expired", 400);
      }
      callbackReturnTo = verification.consent.returnTo;
      const accepted = await acceptInvitationConsentForUser(
        c.env,
        c.req.url,
        workosUser,
        verification.consent,
      );
      user = accepted.user;
    } else if (state.invitationToken) {
      const reconciliation = await reconcilePendingInvitationsForUser(
        c.env,
        workosUser,
        {
          invitationId,
          invitationToken: state.invitationToken,
          organizationId,
        },
      );
      user = reconciliation.user;
    } else {
      const pendingInvitations = organizationId
        ? (
            await findPendingInvitationsByEmailAndOrganization(
              c.env.DB,
              workosUser.email.trim().toLowerCase(),
              organizationId,
            )
          ).filter((invitation) => invitation.invite_type === "organization")
        : [];
      const reconciliation = await reconcilePendingInvitationsForUser(
        c.env,
        workosUser,
        {
          organizationId,
          pendingInvitations,
        },
      );
      user = reconciliation.user;
    }

    const accountSwitchingEnabled = useFeatureFlag(
      c.env,
      ACCOUNT_EMAIL_SWITCHING_FLAG,
    );
    const seedSessionId = accountSwitchingEnabled
      ? getSessionCookie(c.req.raw, c.env)
      : null;
    const accountGroupId = accountSwitchingEnabled
      ? getAccountGroupCookie(c.req.raw, c.env) || newId("acctgrp")
      : null;
    const redirectTo = await resolvePostAuthReturnTo(c, callbackReturnTo, user);

    return createUserSessionResponse(c.env, user.id, redirectTo, {
      accountGroupId,
      seedSessionId,
    });
  } catch (error) {
    if (isResponse(error)) {
      logAuthEvent("error", {
        outcome: "failed",
        reason: `http_${error.status}`,
      });
      return error;
    }
    console.error(
      JSON.stringify({
        event: "auth.callback",
        outcome: "failed",
        reason: "internal_error",
      }),
    );
    return c.text("Authentication failed", 500);
  }
});

app.post("/auth/switch-account", async (c) => {
  if (!useFeatureFlag(c.env, ACCOUNT_EMAIL_SWITCHING_FLAG)) {
    return c.notFound();
  }

  const body = await c.req.parseBody();
  const sessionId = String(body.session_id || "").trim();
  if (!sessionId) {
    return c.text("Missing required field: session_id", 400);
  }

  return switchAccountSessionResponse(
    c.env,
    c.req.raw,
    sessionId,
    safeReturnTo(c.env, String(body.return_to || ""), "/account"),
  );
});

app.get("/auth/logout", async (c) => {
  return logoutResponse(c.req.raw, c.env);
});

app.get("/embed/connect", async (c) => {
  try {
    const url = new URL(c.req.url);
    const connection = normalizeEmbedConnectionRequest({
      site_url: url.searchParams.get("site_url"),
      site_name: url.searchParams.get("site_name"),
      return_url: url.searchParams.get("return_url"),
      state: url.searchParams.get("state"),
      project_id: url.searchParams.get("project_id"),
    });
    if (!connection || !connection.state) {
      return c.text("Invalid WordPress connection request", 400);
    }

    const user = await getCurrentUser(c.req.raw, c.env);
    if (!user) {
      return c.redirect(
        authLoginRedirectUrl(c.env, c.req.url, embedRouteReturnTo(c.req.url)),
      );
    }

    const organizations = await listOrganizationsForUser(c.env.DB, user.id);
    const accessibleProjects = await listProjectsForUser(c.env.DB, user.id);
    const editableProjects: Project[] = [];
    for (const project of accessibleProjects) {
      if (
        project.organization_id &&
        !project.archived_on &&
        (await canEditProject(c.env.DB, project, user))
      ) {
        editableProjects.push(project);
      }
    }

    return c.html(
      renderPage(
        renderEmbedConnectPage({
          connection,
          organizations,
          projects: editableProjects,
        }),
        {
          nonce: kernelDocumentNonce(c),
          customDomain: c.env.CUSTOM_DOMAIN,
          appUrl: appBaseUrl(c.env, c.req.url),
          user,
          title: `Connect ${connection.siteName} | Shiplet`,
          description: "Connect a WordPress site to Shiplet review mode.",
          canonicalPath: null,
          indexing: "noindex",
        },
      ),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to start WordPress connection: ${message}`, 500);
  }
});

app.post("/embed/connect", async (c) => {
  try {
    const contentLength = Number(c.req.header("content-length") || "0");
    if (contentLength > 16_384) {
      return c.text("WordPress connection request is too large", 413);
    }
    const user = await requireCurrentUser(c);
    const formData = await c.req.raw.formData();
    const form: Record<string, unknown> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") form[key] = value;
    });
    const connection = normalizeEmbedConnectionRequest(form);
    if (!connection || !connection.state) {
      return c.text("Invalid WordPress connection request", 400);
    }

    let project: Project;
    if (!connection.projectId || connection.projectId === "new") {
      const result = await publishShiplet(c.env, c.var.db, user, {
        name: connection.siteName,
        organization_id: normalizeOptionalString(form.organization_id),
        subdomain: embedProjectSubdomain(
          connection.siteName,
          connection.siteUrl,
        ),
        external_url: connection.siteUrl,
        visibility: "organization",
      });
      project = result.project;
    } else {
      const existingProject = await getProjectById(
        c.env.DB,
        connection.projectId,
      );
      if (!existingProject || existingProject.archived_on) {
        return c.text("Shiplet project not found", 404);
      }
      if (!(await canEditProject(c.env.DB, existingProject, user))) {
        return c.text("Shiplet project edit access required", 403);
      }
      project = existingProject;
    }

    const code = await createEmbedConnectionCode(c.env.DB, {
      project,
      user,
      siteOrigin: connection.siteOrigin,
      siteUrl: connection.siteUrl,
      siteName: connection.siteName,
      returnUrl: connection.returnUrl,
    });
    return c.redirect(
      appendEmbedRedirectParams(connection.returnUrl, {
        shiplet_code: code,
        state: connection.state,
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to connect WordPress site: ${message}`, 500);
  }
});

type ActiveReviewWidget = {
  revisionId: string;
  entryPath: string;
  layerVersion?: string;
};

type RevisionPackageFileRow = {
  path: string;
  media_type: string;
  size?: number;
  content_base64: string | null;
  object_key: string | null;
};

function widgetBytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function shipletRootStub(env: Env, projectId: string) {
  if (!env.SHIPLET_ROOT) {
    throw new Response("Shiplet root is not configured", { status: 503 });
  }
  return env.SHIPLET_ROOT.getByName(projectId);
}

async function activeReviewLayerState(
  env: Env,
  project: Project,
  actor: ReviewLayerActor = {
    kind: "human",
    id: project.owner_user_id || "shiplet_root_recovery",
  },
): Promise<ReviewLayer> {
  const fallback = await defaultReviewLayerState(env, project);
  const snapshot = await shipletRootStub(env, project.id).readReviewLayer({
    projectId: project.id,
    layer: fallback,
    actor,
  });
  return snapshot.reviewLayer;
}

async function defaultReviewLayerState(
  env: Env,
  project: Project,
): Promise<ReviewLayer> {
  const activeRevisionId = trustedReviewRevisionId(project);
  const revisionId = activeRevisionId.startsWith("legacy_")
    ? (
        await migrateLegacyShipletRevision(
          env.DB,
          project.id,
          env.SHIPLET_ASSETS,
        )
      ).id
    : activeRevisionId;
  const packageValue = await storedRevisionPackage(env, project.id, revisionId);
  if (!packageValue) throw new Error("active_review_layer_unavailable");
  const widgetEntrypoint = portablePackageEntrypoint(packageValue, "widget");
  if (!widgetEntrypoint) throw new Error("active_review_layer_unavailable");
  const rows = await env.DB.prepare(
    `SELECT path, media_type, content_base64, object_key
     FROM shiplet_revision_files
     WHERE revision_id = ? AND path LIKE 'widget/%'
     ORDER BY path`,
  )
    .bind(revisionId)
    .all<RevisionPackageFileRow>();
  const files = [];
  for (const row of rows.results || []) {
    const bytes = await revisionWidgetFileBytes(env, row);
    if (!bytes) continue;
    files.push({
      path: row.path.slice("widget/".length),
      mediaType: row.media_type,
      encoding: "base64" as const,
      content: widgetBytesToBase64(bytes),
    });
  }
  const entryPath = widgetEntrypoint.replace(/^widget\//, "");
  if (!files.some((file) => file.path === entryPath)) {
    throw new Error("active_review_layer_unavailable");
  }
  return {
    version: `default:${revisionId}`,
    entryPath,
    files,
  };
}

function reviewLayerActor(access: RevisionRouteAccess): ReviewLayerActor {
  if (access.actor.kind !== "human" && access.actor.kind !== "agent") {
    throw new Response("Review layer actor denied", { status: 403 });
  }
  return Object.freeze({ kind: access.actor.kind, id: access.actor.id });
}

async function revisionWidgetFileBytes(
  env: Env,
  file: RevisionPackageFileRow,
): Promise<Uint8Array | null> {
  if (file.content_base64) {
    try {
      const binary = atob(file.content_base64);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      return null;
    }
  }
  if (file.object_key && env.SHIPLET_ASSETS) {
    const object = await env.SHIPLET_ASSETS.get(file.object_key);
    if (object) return new Uint8Array(await object.arrayBuffer());
  }
  return null;
}

async function activeWorkflowSchema(
  env: Env,
  projectId: string,
  revisionId: string,
) {
  const file = await env.DB.prepare(
    `SELECT path, media_type, size, content_base64, object_key
     FROM shiplet_revision_files
     WHERE revision_id = ? AND path = 'workflow/schema.json' LIMIT 1`,
  )
    .bind(revisionId)
    .first<RevisionPackageFileRow>();
  if (!file) return null;
  const revision = await env.DB.prepare(
    `SELECT id FROM shiplet_revisions WHERE id = ? AND project_id = ? LIMIT 1`,
  )
    .bind(revisionId, projectId)
    .first<{ id: string }>();
  if (!revision) return null;
  const bytes = await revisionWidgetFileBytes(env, file);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return null;
  }
  try {
    return parseWorkflowSchema(parsed);
  } catch {
    return null;
  }
}

export async function commitValidatedWorkflowEvent(input: {
  env: Env;
  project: Project;
  actorId: string;
  revisionId: string;
  value: ValidatedWorkflowEvent;
  intentFence?: { intentId: string; confirmedOn: string };
}): Promise<
  | { ok: true; event: Record<string, unknown> }
  | {
      ok: false;
      code:
        | "active_revision_conflict"
        | "workflow_event_limit_exceeded"
        | "confirmation_intent_conflict"
        | "workflow_event_failed";
      status: 409 | 429 | 500;
    }
> {
  const { env, project, actorId, revisionId, value, intentFence } = input;
  const eventId = `event_${crypto.randomUUID().replace(/-/g, "")}`;
  const auditId = `audit_${crypto.randomUUID()}`;
  const occurredOn = new Date().toISOString();
  const customPayload = Object.freeze({
    status: value.status,
    fields: value.fields,
  });
  const recipients = await env.DB.prepare(
    `WITH recipient_ids(id, priority) AS (
       SELECT ?, 0
       UNION
       SELECT user_id, 1 FROM shiplet_watch_subscriptions
       WHERE project_id = ? AND status = 'active'
     )
     SELECT users.id, users.email
     FROM recipient_ids JOIN users ON users.id = recipient_ids.id
     ORDER BY recipient_ids.priority, users.id
     LIMIT 90`,
  )
    .bind(project.owner_user_id || actorId, project.id)
    .all<{ id: string; email: string }>();
  const statements = [
    ...(intentFence
      ? [
          env.DB.prepare(
            `UPDATE embed_review_operation_intents SET confirmed_on = ?
               WHERE id = ? AND project_id = ? AND revision_id = ?
                 AND actor_user_id = ? AND effect = 'workflow.event.create'
                 AND confirmed_on IS NULL AND completed_on IS NULL
                 AND expires_on > ?`,
          ).bind(
            intentFence.confirmedOn,
            intentFence.intentId,
            project.id,
            revisionId,
            actorId,
            intentFence.confirmedOn,
          ),
        ]
      : []),
    env.DB.prepare(
      `INSERT INTO shiplet_events (
       id, project_id, revision_id, actor_kind, actor_id, event_kind,
       summary, canonical_status_category, canonical_status_category_v2,
       custom_payload_json, occurred_at, created_at
      ) SELECT ?, ?, ?, 'human', ?, 'workflow.status-changed', ?, ?, ?, ?, ?, ?
        FROM projects
       WHERE id = ? AND active_revision_id = ?
         AND (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ?) < 10000
         AND (? IS NULL OR EXISTS (
          SELECT 1 FROM embed_review_operation_intents intent
          WHERE intent.id = ? AND intent.project_id = projects.id
            AND intent.revision_id = ? AND intent.actor_user_id = ?
            AND intent.effect = 'workflow.event.create'
            AND intent.confirmed_on = ? AND intent.completed_on IS NULL
         ))`,
    ).bind(
      eventId,
      project.id,
      revisionId,
      actorId,
      value.summary,
      legacyCanonicalStatusCategory(value.canonicalStatusCategory),
      value.canonicalStatusCategory,
      JSON.stringify(customPayload),
      occurredOn,
      occurredOn,
      project.id,
      revisionId,
      project.id,
      intentFence?.intentId ?? null,
      intentFence?.intentId ?? "",
      revisionId,
      actorId,
      intentFence?.confirmedOn ?? "",
    ),
    env.DB.prepare(
      `INSERT INTO shiplet_audit_events (
       id, project_id, revision_id, deployment_id, actor_kind, actor_id,
       event_kind, summary, status_category, payload_json,
       occurred_on, recorded_on
      ) SELECT ?, ?, ?, NULL, 'human', ?, 'workflow.event_created', ?,
       'action_completed', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM shiplet_events WHERE id = ?)`,
    ).bind(
      auditId,
      project.id,
      revisionId,
      actorId,
      value.summary,
      JSON.stringify({
        eventId,
        status: value.status,
        canonicalStatusCategory: value.canonicalStatusCategory,
      }),
      occurredOn,
      occurredOn,
      eventId,
    ),
    ...(recipients.results ?? []).map((recipient) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO review_notifications (
         id, dedupe_key, recipient_user_id, recipient_email,
         organization_id, project_id, feedback_id, reply_id, type, reason,
         actor_user_id, actor_email, message, email_status, created_on
        ) SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, 'workflow', 'custom_event',
         ?, NULL, ?, 'email_not_configured', ?
          WHERE EXISTS (SELECT 1 FROM shiplet_events WHERE id = ?)`,
      ).bind(
        newId("notif"),
        `workflow:${eventId}:${recipient.id}`,
        recipient.id,
        recipient.email,
        project.organization_id || "",
        project.id,
        actorId,
        value.summary,
        occurredOn,
        eventId,
      ),
    ),
    ...(intentFence
      ? [
          env.DB.prepare(
            `UPDATE embed_review_operation_intents SET completed_on = ?
               WHERE id = ? AND project_id = ? AND revision_id = ?
                 AND actor_user_id = ? AND confirmed_on = ?
                 AND completed_on IS NULL
                 AND EXISTS (SELECT 1 FROM shiplet_events WHERE id = ?)`,
          ).bind(
            intentFence.confirmedOn,
            intentFence.intentId,
            project.id,
            revisionId,
            actorId,
            intentFence.confirmedOn,
            eventId,
          ),
        ]
      : []),
    env.DB.prepare(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM shiplet_events WHERE id = ? AND project_id = ?)
         AND EXISTS (SELECT 1 FROM shiplet_audit_events WHERE id = ? AND project_id = ?)
         AND (? IS NULL OR EXISTS (
          SELECT 1 FROM embed_review_operation_intents
          WHERE id = ? AND completed_on IS NOT NULL
         ))
         THEN 1 ELSE json_extract('shiplet_effect_commit_failed', '$.invalid') END
         AS committed`,
    ).bind(
      eventId,
      project.id,
      auditId,
      project.id,
      intentFence?.intentId ?? null,
      intentFence?.intentId ?? "",
    ),
  ];
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch(statements);
  } catch {
    const [current, usage, latestIntent] = await Promise.all([
      env.DB.prepare(
        "SELECT active_revision_id FROM projects WHERE id = ? LIMIT 1",
      )
        .bind(project.id)
        .first<{ active_revision_id: string | null }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?",
      )
        .bind(project.id)
        .first<{ count: number }>(),
      intentFence
        ? env.DB.prepare(
            `SELECT confirmed_on, completed_on FROM embed_review_operation_intents
               WHERE id = ? LIMIT 1`,
          )
            .bind(intentFence.intentId)
            .first<{
              confirmed_on: string | null;
              completed_on: string | null;
            }>()
        : Promise.resolve(null),
    ]);
    if (latestIntent?.confirmed_on || latestIntent?.completed_on) {
      return {
        ok: false,
        code: "confirmation_intent_conflict",
        status: 409,
      };
    }
    const conflict = current?.active_revision_id !== revisionId;
    if (!conflict && (usage?.count || 0) < 10_000) {
      return {
        ok: false,
        code: "workflow_event_failed",
        status: 500,
      };
    }
    return {
      ok: false,
      code: conflict
        ? "active_revision_conflict"
        : "workflow_event_limit_exceeded",
      status: conflict ? 409 : 429,
    };
  }
  if (intentFence && results[0]?.meta.changes !== 1) {
    return {
      ok: false,
      code: "confirmation_intent_conflict",
      status: 409,
    };
  }
  const eventResultIndex = intentFence ? 1 : 0;
  if (results[eventResultIndex]?.meta.changes !== 1) {
    const stillActive = await env.DB.prepare(
      "SELECT active_revision_id FROM projects WHERE id = ? LIMIT 1",
    )
      .bind(project.id)
      .first<{ active_revision_id: string | null }>();
    const conflict = stillActive?.active_revision_id !== revisionId;
    return {
      ok: false,
      code: conflict
        ? "active_revision_conflict"
        : "workflow_event_limit_exceeded",
      status: conflict ? 409 : 429,
    };
  }
  if (intentFence && results.at(-2)?.meta.changes !== 1) {
    return {
      ok: false,
      code: "confirmation_intent_conflict",
      status: 409,
    };
  }
  return {
    ok: true,
    event: {
      eventId,
      shipletId: project.id,
      revisionId,
      actorKind: "human",
      actorId,
      eventKind: "workflow.status-changed",
      summary: value.summary,
      canonicalStatusCategory: value.canonicalStatusCategory,
      customPayload,
      occurredAt: occurredOn,
      createdAt: occurredOn,
    },
  };
}

async function storedRevisionPackage(
  env: Env,
  projectId: string,
  revisionId: string,
): Promise<{
  parentRevisionId: string | null;
  manifest?: {
    staticFirst?: boolean;
    entrypoints?: { artifact?: unknown; widget?: unknown };
  };
} | null> {
  const row = await env.DB.prepare(
    `SELECT package_json, parent_revision_id FROM shiplet_revisions
     WHERE id = ? AND project_id = ? LIMIT 1`,
  )
    .bind(revisionId, projectId)
    .first<{ package_json: string; parent_revision_id: string | null }>();
  if (!row) return null;
  let serialized = row.package_json;
  const stored = JSON.parse(serialized) as unknown;
  if (
    stored &&
    typeof stored === "object" &&
    !Array.isArray(stored) &&
    (stored as Record<string, unknown>).storage ===
      "shiplet.package.storage/r2-v1"
  ) {
    const key = (stored as Record<string, unknown>).key;
    if (typeof key !== "string") return null;
    const packageStore = env.SHIPLET_ASSETS;
    if (!packageStore) return null;
    const object = await packageStore.get(key);
    if (!object) return null;
    serialized = await object.text();
  }
  try {
    const parsed = JSON.parse(serialized) as {
      manifest?: {
        staticFirst?: boolean;
        entrypoints?: { artifact?: unknown; widget?: unknown };
      };
    };
    return { ...parsed, parentRevisionId: row.parent_revision_id };
  } catch {
    return null;
  }
}

function portablePackageEntrypoint(
  packageValue: Awaited<ReturnType<typeof storedRevisionPackage>>,
  kind: "artifact" | "widget",
) {
  const path = packageValue?.manifest?.entrypoints?.[kind];
  if (
    typeof path !== "string" ||
    !path.startsWith(`${kind}/`) ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return path;
}

async function serveRevisionStaticArtifact(
  env: Env,
  project: Project,
  revisionId: string,
  request: Request,
): Promise<Response | null> {
  const packageValue = await storedRevisionPackage(env, project.id, revisionId);
  if (!packageValue) return null;
  const entryPath = portablePackageEntrypoint(packageValue, "artifact");
  if (!entryPath)
    return new Response("Shiplet asset not found", { status: 404 });
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(new URL(request.url).pathname).replace(
      /^\/+/,
      "",
    );
  } catch {
    return new Response("Shiplet asset not found", { status: 404 });
  }
  if (
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    return new Response("Shiplet asset not found", { status: 404 });
  }
  const normalized = relativePath.replace(/\/+/g, "/");
  const basePath = normalized ? `artifact/${normalized}` : entryPath;
  const candidates = [basePath];
  if (normalized.endsWith("/")) {
    candidates.push(`${basePath}index.html`);
  } else if (normalized && !normalized.split("/").pop()?.includes(".")) {
    candidates.push(`${basePath}/index.html`, `${basePath}.html`);
  }
  let file: RevisionPackageFileRow | null = null;
  for (const candidate of Array.from(new Set(candidates))) {
    if (!candidate.startsWith("artifact/")) continue;
    file = await env.DB.prepare(
      `SELECT path, media_type, size, content_base64, object_key
       FROM shiplet_revision_files
       WHERE revision_id = ? AND path = ? LIMIT 1`,
    )
      .bind(revisionId, candidate)
      .first<RevisionPackageFileRow>();
    if (file) break;
  }
  if (!file) return new Response("Shiplet asset not found", { status: 404 });
  const body = await revisionWidgetFileBytes(env, file);
  if (!body) return new Response("Shiplet asset unavailable", { status: 503 });
  const headers = new Headers({
    "content-type": file.media_type || "application/octet-stream",
    "content-length": String(body.byteLength),
    "x-content-type-options": "nosniff",
    "x-shiplet-revision": revisionId,
  });
  if (file.object_key) headers.set("x-shiplet-static-fallback", "r2");
  const responseBody = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  return new Response(request.method === "HEAD" ? null : responseBody, {
    status: 200,
    headers,
  });
}

async function serveActiveRevisionStaticArtifact(
  env: Env,
  project: Project,
  request: Request,
  userId?: string,
): Promise<Response | null> {
  const revisionId = trustedReviewRevisionId(project);
  if (revisionId.startsWith("legacy_")) return null;
  const packageValue = await storedRevisionPackage(env, project.id, revisionId);
  if (!packageValue) return null;
  if (packageValue.manifest?.staticFirst !== true) {
    return hasManagedAdvancedRuntime(env, userId)
      ? null
      : new Response("Managed arbitrary Worker execution is unavailable", {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-shiplet-runtime-status": "managed_dynamic_unavailable",
            "x-shiplet-revision": revisionId,
          },
        });
  }
  if (
    project.source_type === "external_url" &&
    packageValue.parentRevisionId === null
  ) {
    return null;
  }
  return serveRevisionStaticArtifact(env, project, revisionId, request);
}

async function serveActiveManagedRuntimeArtifact(
  env: Env,
  project: Project,
  request: Request,
  userId?: string,
): Promise<Response | null> {
  const revisionId = trustedReviewRevisionId(project);
  if (revisionId.startsWith("legacy_")) return null;
  const packageValue = await storedRevisionPackage(env, project.id, revisionId);
  if (packageValue?.manifest?.staticFirst !== false) return null;
  const runtimeEnv = env as DeploymentRuntimeEnv;
  const runtime = await cloudflareManagedRuntimeGateway(runtimeEnv, userId, {
    requireDeploymentReadiness: false,
  });
  if (!runtime) {
    return new Response("Managed arbitrary Worker execution is unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_dynamic_unavailable",
        "x-shiplet-revision": revisionId,
      },
    });
  }
  let bundle: ImmutableRevisionBundle | null;
  try {
    bundle = await immutableRevisionDeploymentBundle({
      db: env.DB,
      shipletId: project.id,
      revisionId,
      packageStore: env.SHIPLET_ASSETS,
    });
  } catch {
    bundle = null;
  }
  if (!bundle) {
    return new Response("Managed revision is unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_revision_unavailable",
        "x-shiplet-revision": revisionId,
      },
    });
  }
  const binding = await loadManagedRuntimeInvocationBinding({
    db: env.DB,
    projectId: project.id,
    revisionId,
    packageDigest: bundle.packageDigest,
  });
  if (!binding) {
    return new Response("Managed revision activation is unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_activation_unavailable",
        "x-shiplet-revision": revisionId,
      },
    });
  }
  try {
    const response = await runtime.gateway.invoke(
      {
        expected: binding,
        request: stripInternalArtifactSearchParams(request),
      },
      runtime.expectation,
    );
    if (!(response instanceof Response)) {
      throw new Error("managed_response_invalid");
    }
    const headers = new Headers(response.headers);
    for (const name of [
      "set-cookie",
      "authorization",
      "proxy-authenticate",
      "www-authenticate",
    ]) {
      headers.delete(name);
    }
    headers.set("x-shiplet-revision", revisionId);
    headers.set("x-shiplet-runtime-status", "managed_dynamic");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new Response("Managed revision invocation failed", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_invocation_failed",
        "x-shiplet-revision": revisionId,
      },
    });
  }
}

async function serveValidatedManagedRuntimeArtifact(
  env: Env,
  project: Project,
  revisionId: string,
  request: Request,
  userId?: string,
): Promise<Response | null> {
  const packageValue = await storedRevisionPackage(env, project.id, revisionId);
  if (packageValue?.manifest?.staticFirst !== false) return null;
  const runtime = await cloudflareManagedRuntimeGateway(
    env as DeploymentRuntimeEnv,
    userId,
    { requireDeploymentReadiness: false },
  );
  if (!runtime) {
    return new Response("Managed arbitrary Worker execution is unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_dynamic_unavailable",
        "x-shiplet-revision": revisionId,
      },
    });
  }
  let bundle: ImmutableRevisionBundle | null;
  try {
    bundle = await immutableRevisionDeploymentBundle({
      db: env.DB,
      shipletId: project.id,
      revisionId,
      packageStore: env.SHIPLET_ASSETS,
    });
  } catch {
    bundle = null;
  }
  if (!bundle) {
    return new Response("Managed revision is unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_revision_unavailable",
        "x-shiplet-revision": revisionId,
      },
    });
  }
  try {
    const response = await runtime.gateway.invokeValidatedRevision(
      {
        expected: {
          shipletId: project.id,
          revisionId,
          packageDigest: bundle.packageDigest,
          activationGeneration: 1,
        },
        request: stripInternalArtifactSearchParams(request),
      },
      runtime.expectation,
    );
    if (!(response instanceof Response)) {
      throw new Error("managed_response_invalid");
    }
    const headers = new Headers(response.headers);
    for (const name of [
      "set-cookie",
      "authorization",
      "proxy-authenticate",
      "www-authenticate",
    ]) {
      headers.delete(name);
    }
    headers.set("x-shiplet-revision", revisionId);
    headers.set("x-shiplet-runtime-status", "managed_dynamic_preview");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new Response("Managed revision preview failed", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-shiplet-runtime-status": "managed_preview_failed",
        "x-shiplet-revision": revisionId,
      },
    });
  }
}

async function managedRuntimeForProject(
  env: Env,
  project: Project,
): Promise<"static" | "worker" | "external_proxy"> {
  const revisionId = trustedReviewRevisionId(project);
  if (!revisionId.startsWith("legacy_")) {
    const activePackage = await storedRevisionPackage(
      env,
      project.id,
      revisionId,
    );
    if (activePackage?.manifest?.staticFirst === false) return "worker";
    if (activePackage?.manifest?.staticFirst === true) {
      if (
        project.source_type === "external_url" &&
        activePackage.parentRevisionId === null
      ) {
        return "external_proxy";
      }
      return "static";
    }
  }
  return project.source_type === "worker"
    ? "worker"
    : project.source_type === "external_url"
      ? "external_proxy"
      : "static";
}

async function inlineRevisionWidgetReferences(
  env: Env,
  revisionId: string,
  entryPath: string,
) {
  const entryDirectory = entryPath.slice(0, entryPath.lastIndexOf("/") + 1);
  const rows = await env.DB.prepare(
    `SELECT path, media_type, content_base64, object_key
       FROM shiplet_revision_files
      WHERE revision_id = ? AND path LIKE ?`,
  )
    .bind(revisionId, `${entryDirectory}%`)
    .all<RevisionPackageFileRow>();
  const dataUrls = new Map<string, string>();
  const runtimeFiles: Array<{
    path: string;
    mediaType: string;
    bytes: Uint8Array;
  }> = [];
  for (const row of rows.results || []) {
    const bytes = await revisionWidgetFileBytes(env, row);
    if (!bytes) continue;
    runtimeFiles.push({
      path: row.path,
      mediaType: row.media_type || "application/octet-stream",
      bytes,
    });
    dataUrls.set(
      row.path,
      `data:${row.media_type || "application/octet-stream"};base64,${widgetBytesToBase64(bytes)}`,
    );
  }
  return compileRuntimeV1Widget({
    entryPath,
    files: runtimeFiles,
    dataUrls,
  });
}

async function activeReviewWidget(
  env: Env,
  project: Project,
): Promise<ActiveReviewWidget | null> {
  const revisionId = trustedReviewRevisionId(project);
  if (revisionId.startsWith("legacy_")) return null;
  const layer = await activeReviewLayerState(env, project);
  return {
    revisionId,
    entryPath: `widget/${layer.entryPath}`,
    layerVersion: layer.version,
  };
}

async function revisionReviewWidget(
  env: Env,
  projectId: string,
  revisionId: string,
): Promise<ActiveReviewWidget | null> {
  const packageValue = await storedRevisionPackage(env, projectId, revisionId);
  const entryPath = portablePackageEntrypoint(packageValue, "widget");
  return entryPath ? { revisionId, entryPath } : null;
}

async function serveRevisionReviewWidget(
  env: Env,
  project: Project,
  revisionId: string,
  trustedHostOrigin: string,
  requestedPath?: string,
): Promise<Response> {
  const widget = await revisionReviewWidget(env, project.id, revisionId);
  if (!widget) {
    return new Response("Review widget not found", { status: 404 });
  }
  const relativePath = String(requestedPath || "").replace(/^\/+/, "");
  if (
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    return new Response("Review widget file not found", { status: 404 });
  }
  const entryDirectory = widget.entryPath.slice(
    0,
    widget.entryPath.lastIndexOf("/") + 1,
  );
  const filePath = relativePath
    ? `${entryDirectory}${relativePath}`
    : widget.entryPath;
  if (!filePath.startsWith("widget/")) {
    return new Response("Review widget file not found", { status: 404 });
  }
  const file = await env.DB.prepare(
    `SELECT path, media_type, content_base64, object_key
			 FROM shiplet_revision_files
			 WHERE revision_id = ? AND path = ? LIMIT 1`,
  )
    .bind(widget.revisionId, filePath)
    .first<RevisionPackageFileRow>();
  if (!file) return new Response("Review widget not found", { status: 404 });
  let body = await revisionWidgetFileBytes(env, file);
  if (!body)
    return new Response("Review widget is unavailable", { status: 503 });
  let responseBody: BodyInit = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  if (!relativePath && file.media_type.toLowerCase().includes("text/html")) {
    try {
      const compiled = await inlineRevisionWidgetReferences(
        env,
        widget.revisionId,
        widget.entryPath,
      );
      responseBody = compiled.templateHtml;
      const response = createSandboxedArtifactResponse({
        body: responseBody,
        contentType: "text/html; charset=utf-8",
        role: "widget",
        trustedHostOrigin,
        widgetRuntime: {
          scriptSource: compiled.scriptSource,
          shipletId: project.id,
          revisionId: widget.revisionId,
        },
      });
      response.headers.set("x-shiplet-revision", revisionId);
      return response;
    } catch (error) {
      if (error instanceof UnsupportedWidgetDependencyError) {
        return createSandboxedArtifactResponse({
          body: "Unsupported review widget dependency",
          contentType: "text/plain; charset=utf-8",
          role: "review_context",
          trustedHostOrigin,
          status: 422,
        });
      }
      throw error;
    }
  }
  const response = createSandboxedArtifactResponse({
    body: responseBody,
    contentType: file.media_type,
    role: "review_context",
    trustedHostOrigin,
  });
  response.headers.set("x-shiplet-revision", revisionId);
  return response;
}

async function serveActiveReviewWidget(
  env: Env,
  project: Project,
  revisionId: string,
  trustedHostOrigin: string,
  requestedPath?: string,
): Promise<Response> {
  if (trustedReviewRevisionId(project) !== revisionId) {
    return new Response("Review widget not found", { status: 404 });
  }
  return serveReviewLayerWidget(
    await activeReviewLayerState(env, project),
    project.id,
    revisionId,
    trustedHostOrigin,
    requestedPath,
  );
}

async function serveReviewLayerWidget(
  layer: ReviewLayer,
  projectId: string,
  artifactRevisionId: string,
  trustedHostOrigin: string,
  requestedPath?: string,
): Promise<Response> {
  const relativePath = String(requestedPath || "").replace(/^\/+/, "");
  if (
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    return new Response("Review widget file not found", { status: 404 });
  }
  const entryDirectory = layer.entryPath.slice(
    0,
    layer.entryPath.lastIndexOf("/") + 1,
  );
  const filePath = relativePath
    ? `${entryDirectory}${relativePath}`
    : layer.entryPath;
  const file = layer.files.find((candidate) => candidate.path === filePath);
  if (!file) return new Response("Review widget not found", { status: 404 });
  const bytes = reviewLayerFileBytes(file);
  if (!bytes) {
    return new Response("Review widget is unavailable", { status: 503 });
  }
  let response: Response;
  if (!relativePath && file.mediaType.toLowerCase().includes("text/html")) {
    try {
      const compiled = await compileReviewLayer(layer);
      response = createSandboxedArtifactResponse({
        body: compiled.templateHtml,
        contentType: "text/html; charset=utf-8",
        role: "widget",
        trustedHostOrigin,
        widgetRuntime: {
          scriptSource: compiled.scriptSource,
          shipletId: projectId,
          revisionId: artifactRevisionId,
        },
      });
    } catch (error) {
      if (error instanceof UnsupportedWidgetDependencyError) {
        return createSandboxedArtifactResponse({
          body: "Unsupported review widget dependency",
          contentType: "text/plain; charset=utf-8",
          role: "review_context",
          trustedHostOrigin,
          status: 422,
        });
      }
      throw error;
    }
  } else {
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    response = createSandboxedArtifactResponse({
      body,
      contentType: file.mediaType,
      role: "review_context",
      trustedHostOrigin,
    });
  }
  response.headers.set("x-shiplet-revision", artifactRevisionId);
  response.headers.set("x-shiplet-review-layer-version", layer.version);
  return response;
}

async function embedReviewStateResponse(
  c: any,
  reviewState: "expired" | "revoked" | "permission_denied" | "offline",
  known?: {
    installation?: Awaited<ReturnType<typeof getEmbedInstallation>>;
    project?: Project | null;
  },
) {
  const url = new URL(c.req.url);
  const installationId = url.searchParams.get("installation_id")?.trim() || "";
  let installation = known?.installation ?? null;
  let project = known?.project ?? null;
  try {
    if (!installation && installationId) {
      installation = await getEmbedInstallation(c.env.DB, installationId, {
        includeRevoked: true,
      });
    }
    if (!project && installation) {
      project = await getProjectById(c.env.DB, installation.project_id);
    }
  } catch {
    reviewState = "offline";
  }
  if (installation?.revoked_on) reviewState = "revoked";
  const origin = url.origin;
  return createTrustedReviewHostResponse({
    shipletId: project?.id || installation?.project_id || "embed_unavailable",
    revisionId: project
      ? trustedReviewRevisionId(project)
      : "revision_unavailable",
    title: project?.name || installation?.site_name || "Shiplet review",
    artifactUrl: origin,
    widgetUrl: null,
    hostScriptUrl: `${origin}/api/review/host.js`,
    reviewApiUrl: origin,
    reviewState,
    frameAncestorOrigins: installation?.site_origin
      ? [installation.site_origin]
      : [],
  });
}

function embedAuthBootstrapResponse(
  c: any,
  installation: NonNullable<Awaited<ReturnType<typeof getEmbedInstallation>>>,
) {
  const origin = new URL(c.req.url).origin;
  const nonce = createKernelDocumentNonce();
  const loginUrl = authLoginRedirectUrl(
    c.env,
    c.req.url,
    embedRouteReturnTo(c.req.url),
  );
  const html = `<!doctype html><html lang="en" data-shiplet-embed-auth-bootstrap="v1"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to review · Shiplet</title><script src="${origin}/api/embed/auth-bootstrap.js" nonce="${nonce}" defer></script></head><body><main><h1>Sign in to review</h1><p>Authentication opens in a secure Shiplet window.</p><button type="button" data-shiplet-embed-auth-open data-login-url="${escapeEmbedHtml(loginUrl)}">Open secure Shiplet sign-in</button><p role="status" aria-live="polite" data-shiplet-embed-auth-status></p></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${installation.site_origin}`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function digestEmbedFeedbackOperation(input: unknown) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(input)),
    ),
  );
  return `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256HexText(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function trustedConfirmationHtml(input: {
  state: "pending" | "complete";
  intentId?: string;
  summary: string;
  workflowFields?: Record<string, unknown> | null;
  completeHeading?: "Feedback sent" | "Workflow event recorded";
  completePath?: "/embed/review/confirm/complete" | "/review/confirm/complete";
}) {
  const complete = input.state === "complete";
  const completeHeading = input.completeHeading ?? "Feedback sent";
  const exactWorkflowFields = input.workflowFields ?? null;
  const isWorkflow = exactWorkflowFields !== null;
  const workflowFields = isWorkflow
    ? Object.keys(exactWorkflowFields)
        .sort((left, right) => left.localeCompare(right))
        .map(
          (key) =>
            `<div><dt>${escapeEmbedHtml(key)}</dt><dd><code>${escapeEmbedHtml(JSON.stringify(exactWorkflowFields[key]))}</code></dd></div>`,
        )
        .join("")
    : "";
  const fieldDetails = workflowFields
    ? `<section aria-labelledby="workflow-fields-title"><h2 id="workflow-fields-title">Workflow fields</h2><p>These exact values will be attributed to you.</p><dl>${workflowFields}</dl></section>`
    : "";
  const completePath = input.completePath ?? "/embed/review/confirm/complete";
  const form =
    !complete && input.intentId
      ? `<form method="post" action="${completePath}"><input type="hidden" name="intent_id" value="${escapeEmbedHtml(input.intentId)}"><button type="submit" name="approval" value="confirm">${isWorkflow ? "Confirm and record workflow event" : "Confirm and send feedback"}</button></form>`
      : "";
  return `<!doctype html><html lang="en" data-shiplet-confirmation="${input.state === "complete" ? "complete" : "v1"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${complete ? completeHeading : isWorkflow ? "Confirm workflow event" : "Confirm feedback"} · Shiplet</title></head><body><main><h1>${complete ? completeHeading : isWorkflow ? "Confirm workflow event" : "Confirm feedback"}</h1><p>${escapeEmbedHtml(input.summary)}</p>${fieldDetails}${form}</main></body></html>`;
}

function trustedConfirmationResponse(
  requestUrl: string,
  html: string,
  status = 200,
) {
  const origin = new URL(requestUrl).origin;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action ${origin}; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

app.get("/api/embed/auth-bootstrap.js", () => {
  return new Response(
    `(()=>{"use strict";const button=document.querySelector("[data-shiplet-embed-auth-open]");const status=document.querySelector("[data-shiplet-embed-auth-status]");if(!button)return;button.addEventListener("click",event=>{if(!event.isTrusted)return;const url=button.getAttribute("data-login-url");if(!url)return;const popup=window.open(url,"shiplet-embed-auth","popup,width=560,height=720,resizable=yes,scrollbars=yes");if(!popup){if(status)status.textContent="Allow the secure sign-in window to continue.";return;}if(status)status.textContent="Complete sign-in in the secure Shiplet window.";popup.focus();});})();`,
    {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    },
  );
});

app.get("/embed/review/start", async (c) => {
  try {
    const url = new URL(c.req.url);
    const installationId =
      url.searchParams.get("installation_id")?.trim() || "";
    const installation = installationId
      ? await getEmbedInstallation(c.env.DB, installationId, {
          includeRevoked: true,
        })
      : null;
    if (!installation) return c.text("WordPress installation not found", 404);
    if (installation.revoked_on) {
      return embedReviewStateResponse(c, "revoked", { installation });
    }
    const returnUrl = normalizeEmbedReturnUrl(
      url.searchParams.get("return_url"),
      installation.site_origin,
    );
    if (!returnUrl) return c.text("Invalid review return URL", 400);

    const user = await getCurrentUser(c.req.raw, c.env);
    if (!user) {
      return embedAuthBootstrapResponse(c, installation);
    }
    const project = await getProjectById(c.env.DB, installation.project_id);
    if (
      !project ||
      project.archived_on ||
      !(await canViewProject(c.env.DB, project, user.id))
    ) {
      return embedReviewStateResponse(c, "permission_denied", {
        installation,
        project,
      });
    }
    const session = await createEmbedReviewSession(c.env.DB, {
      installation,
      project,
      revisionId: trustedReviewRevisionId(project),
      user,
      pageUrl: returnUrl,
    });
    const trustedHostUrl = new URL(
      "/embed/review/host",
      new URL(c.req.url).origin,
    );
    trustedHostUrl.searchParams.set("installation_id", installation.id);
    trustedHostUrl.searchParams.set("page_url", session.publicSession.pageUrl);
    const response = c.redirect(trustedHostUrl.toString());
    response.headers.append(
      "set-cookie",
      createEmbedReviewSessionCookieHeader({
        installationId: installation.id,
        sessionHandle: session.sessionHandle,
        now: new Date(),
        expiresOn: session.expiresOn,
      }),
    );
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to start embedded review: ${message}`, 500);
  }
});

function managedReviewPageBinding(input: {
  env: Env;
  requestUrl: string;
  project: Project;
  submittedPage: URL;
}) {
  const allowedBases = [
    new URL(artifactAbsoluteUrl(input.env, input.requestUrl, input.project)),
  ];
  if (input.project.custom_hostname) {
    allowedBases.push(new URL(`https://${input.project.custom_hostname}`));
  }
  const requestUrl = new URL(input.requestUrl);
  if (canUsePathTenantRouting(requestUrl.hostname, input.env)) {
    allowedBases.push(
      new URL(
        `/${encodeURIComponent(input.project.subdomain)}`,
        requestUrl.origin,
      ),
    );
  }
  for (const allowedBase of allowedBases) {
    const prefix = allowedBase.pathname.endsWith("/")
      ? allowedBase.pathname
      : `${allowedBase.pathname}/`;
    if (
      input.submittedPage.origin === allowedBase.origin &&
      (input.submittedPage.pathname === allowedBase.pathname ||
        input.submittedPage.pathname.startsWith(prefix))
    ) {
      return { ok: true as const, trustedHostOrigin: allowedBase.origin };
    }
  }
  return { ok: false as const };
}

function trustedReviewCaptureFromForm(
  formData: FormData,
):
  | { ok: true; value: ReturnType<typeof parseTrustedArtifactCapturePayload> }
  | { ok: false } {
  const names = [
    "screenshot_data_url",
    "screenshot_failure_note",
    "screenshot_mode",
    "viewport_json",
    "coordinates_json",
    "selected_element_json",
    "capture_context_json",
  ] as const;
  const present = names.some((name) => formData.has(name));
  if (!present) return { ok: true, value: null };
  const screenshotDataUrl = String(formData.get("screenshot_data_url") || "");
  const screenshotFailureNote = String(
    formData.get("screenshot_failure_note") || "",
  );
  const screenshotMode = String(formData.get("screenshot_mode") || "");
  function parseBoundedObject(name: string) {
    const serialized = String(formData.get(name) || "");
    if (!serialized || serialized.length > 16_384) return null;
    try {
      const parsed = JSON.parse(serialized);
      return typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  const value = parseTrustedArtifactCapturePayload({
    screenshotDataUrl: screenshotDataUrl || null,
    screenshotFailureNote: screenshotFailureNote || null,
    screenshotMode,
    viewport: parseBoundedObject("viewport_json"),
    coordinates: parseBoundedObject("coordinates_json"),
    selectedElement: parseBoundedObject("selected_element_json"),
    captureContext: parseBoundedObject("capture_context_json"),
  });
  return value ? { ok: true, value } : { ok: false };
}

function trustedReviewMentionsFromForm(
  formData: FormData,
): { ok: true; value: Array<{ userId: string }> } | { ok: false } {
  if (!formData.has("mentions_json")) return { ok: true, value: [] };
  const serialized = String(formData.get("mentions_json") || "");
  if (!serialized || serialized.length > 8_192) return { ok: false };
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.length > 20) return { ok: false };
    const userIds = new Set<string>();
    for (const mention of parsed) {
      if (
        typeof mention !== "object" ||
        mention === null ||
        Array.isArray(mention) ||
        Object.keys(mention).length !== 1 ||
        !("userId" in mention) ||
        typeof mention.userId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(mention.userId)
      ) {
        return { ok: false };
      }
      userIds.add(mention.userId);
    }
    return {
      ok: true,
      value: Array.from(userIds).map((userId) => ({ userId })),
    };
  } catch {
    return { ok: false };
  }
}

function hasTrustedTopLevelFormProvenance(
  request: Request,
  allowedOrigins: readonly string[],
) {
  const origin = request.headers.get("origin") || "";
  if (allowedOrigins.includes(origin)) return true;
  return (
    origin === "null" &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  );
}

app.post("/review/confirm", async (c) => {
  try {
    const contentLength = Number(c.req.header("content-length") || "0");
    if (contentLength > 14_000_000) {
      return c.text("Trusted confirmation form is too large", 413);
    }
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return c.text("Trusted confirmation form required", 403);
    }
    const user = await requireCurrentUser(c);
    const formData = await c.req.raw.formData();
    const shipletId = String(formData.get("shiplet_id") || "").trim();
    const revisionId = String(formData.get("revision_id") || "").trim();
    const requestId = String(formData.get("request_id") || "").trim();
    const operation = String(formData.get("operation") || "").trim();
    const clientFeedbackId = String(
      formData.get("client_feedback_id") || "",
    ).trim();
    const comment = String(formData.get("comment") || "").trim();
    const submittedPageUrl = String(formData.get("page_url") || "");
    const capture = trustedReviewCaptureFromForm(formData);
    if (!capture.ok) return c.text("Invalid artifact capture context", 400);
    const mentions = trustedReviewMentionsFromForm(formData);
    if (!mentions.ok) return c.text("Invalid review mentions", 400);
    if (
      !["feedback.create", "workflow.event.create"].includes(operation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(requestId)
    ) {
      return c.text("Invalid confirmation intent", 400);
    }
    const project = await getProjectById(c.env.DB, shipletId);
    if (
      !project ||
      project.archived_on ||
      !(await canViewProject(c.env.DB, project, user.id))
    ) {
      return c.text("Shiplet review access required", 403);
    }
    const activeRevisionId = trustedReviewRevisionId(project);
    let validatedPayload: Record<string, unknown>;
    let validatedPageUrl = submittedPageUrl;
    let confirmationSummary: string;
    let confirmationWorkflowFields: Record<string, unknown> | null = null;
    if (operation === "workflow.event.create") {
      if (capture.value || mentions.value.length > 0) {
        return c.text(
          "Workflow confirmation contains unrelated review data",
          400,
        );
      }
      const fieldsJson = String(formData.get("workflow_fields_json") || "");
      if (!fieldsJson || fieldsJson.length > 65_536) {
        return c.text("Invalid workflow fields", 400);
      }
      let fields: unknown;
      try {
        fields = JSON.parse(fieldsJson);
      } catch {
        return c.text("Invalid workflow fields", 400);
      }
      const workflow = await activeWorkflowSchema(
        c.env,
        project.id,
        activeRevisionId,
      );
      if (!workflow) return c.text("Shiplet workflow unavailable", 503);
      const workflowValidation = validateWorkflowEvent(workflow, {
        status: String(formData.get("workflow_status") || ""),
        summary: String(formData.get("workflow_summary") || ""),
        fields,
      });
      if (!workflowValidation.ok) {
        return json(workflowValidation, 400);
      }
      validatedPayload = { ...workflowValidation.value };
      confirmationSummary = `${workflowValidation.value.status}: ${workflowValidation.value.summary}`;
      confirmationWorkflowFields = workflowValidation.value.fields;
    } else {
      const feedbackValidation = validateReviewFeedbackPayload({
        comment,
        pageUrl: submittedPageUrl,
        clientFeedbackId,
        mentions: mentions.value,
        ...(capture.value || {}),
      });
      if (!feedbackValidation.ok) {
        return json({ ok: false, errors: feedbackValidation.errors }, 400);
      }
      validatedPayload = { ...feedbackValidation.value };
      validatedPageUrl = feedbackValidation.value.pageUrl;
      confirmationSummary = feedbackValidation.value.comment;
    }
    let submittedPage: URL;
    try {
      submittedPage = new URL(validatedPageUrl);
    } catch {
      return c.text("Shiplet review page is invalid", 400);
    }
    const pageBinding = managedReviewPageBinding({
      env: c.env,
      requestUrl: c.req.url,
      project,
      submittedPage,
    });
    if (!pageBinding.ok) {
      return c.text("Shiplet review page mismatch", 403);
    }
    const trustedControlOrigin = new URL(appBaseUrl(c.env, c.req.url)).origin;
    if (
      !hasTrustedTopLevelFormProvenance(c.req.raw, [
        trustedControlOrigin,
        new URL(c.req.url).origin,
        pageBinding.trustedHostOrigin,
      ])
    ) {
      return c.text("Trusted review origin required", 403);
    }
    if (revisionId !== activeRevisionId) {
      return c.text("Shiplet revision changed; reopen review", 409);
    }
    const payloadDigest = await sha256HexText(JSON.stringify(validatedPayload));
    const intentId = `review_intent_${crypto.randomUUID().replace(/-/g, "")}`;
    const installationId = `managed:${project.id}`;
    const now = new Date();
    const expiresOn = new Date(now.getTime() + 2 * 60_000).toISOString();
    const inserted = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO embed_review_operation_intents (
       id, installation_id, project_id, revision_id, actor_user_id,
       effect, payload_json, payload_digest, request_id, page_url,
       expires_on, confirmed_on, completed_on, created_on
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(
        intentId,
        installationId,
        project.id,
        activeRevisionId,
        user.id,
        operation,
        JSON.stringify(validatedPayload),
        payloadDigest,
        requestId,
        validatedPageUrl,
        expiresOn,
        now.toISOString(),
      )
      .run();
    let storedIntentId = intentId;
    if (inserted.meta.changes !== 1) {
      const existing = await c.env.DB.prepare(
        `SELECT id, payload_digest FROM embed_review_operation_intents
         WHERE installation_id = ? AND actor_user_id = ? AND request_id = ?
          AND project_id = ? AND revision_id = ? AND expires_on > ?
          AND confirmed_on IS NULL`,
      )
        .bind(
          installationId,
          user.id,
          requestId,
          project.id,
          activeRevisionId,
          now.toISOString(),
        )
        .first<{ id: string; payload_digest: string }>();
      if (!existing || existing.payload_digest !== payloadDigest) {
        return c.text("Confirmation intent conflict", 409);
      }
      storedIntentId = existing.id;
    }
    return trustedConfirmationResponse(
      appBaseUrl(c.env, c.req.url),
      trustedConfirmationHtml({
        state: "pending",
        intentId: storedIntentId,
        summary: confirmationSummary,
        workflowFields: confirmationWorkflowFields,
        completePath: "/review/confirm/complete",
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to prepare trusted confirmation", 500);
  }
});

app.post("/embed/review/confirm", async (c) => {
  try {
    const origin = new URL(appBaseUrl(c.env, c.req.url)).origin;
    if (
      !hasTrustedTopLevelFormProvenance(c.req.raw, [
        origin,
        new URL(c.req.url).origin,
      ])
    ) {
      return c.text("Trusted review origin required", 403);
    }
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return c.text("Trusted confirmation form required", 403);
    }
    const contentLength = Number(c.req.header("content-length") || "0");
    if (contentLength > 14_000_000) {
      return c.text("Trusted confirmation form is too large", 413);
    }
    const { session, project, pageUrl } = await requireEmbedReviewSession(c);
    const formData = await c.req.raw.formData();
    const requestId = String(formData.get("request_id") || "").trim();
    const operation = String(formData.get("operation") || "").trim();
    const submittedPageUrl = String(formData.get("page_url") || "");
    const clientFeedbackId = String(
      formData.get("client_feedback_id") || "",
    ).trim();
    const comment = String(formData.get("comment") || "").trim();
    const capture = trustedReviewCaptureFromForm(formData);
    if (!capture.ok) return c.text("Invalid artifact capture context", 400);
    const mentions = trustedReviewMentionsFromForm(formData);
    if (!mentions.ok) return c.text("Invalid review mentions", 400);
    if (
      !["feedback.create", "workflow.event.create"].includes(operation) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(requestId)
    ) {
      return c.text("Invalid confirmation intent", 400);
    }
    let validatedPayload: Record<string, unknown>;
    let validatedPageUrl = submittedPageUrl;
    let confirmationSummary: string;
    let confirmationWorkflowFields: Record<string, unknown> | null = null;
    if (operation === "workflow.event.create") {
      if (capture.value || mentions.value.length > 0) {
        return c.text(
          "Workflow confirmation contains unrelated review data",
          400,
        );
      }
      const fieldsJson = String(formData.get("workflow_fields_json") || "");
      if (!fieldsJson || fieldsJson.length > 65_536) {
        return c.text("Invalid workflow fields", 400);
      }
      let fields: unknown;
      try {
        fields = JSON.parse(fieldsJson);
      } catch {
        return c.text("Invalid workflow fields", 400);
      }
      const workflow = await activeWorkflowSchema(
        c.env,
        project.id,
        session.revisionId,
      );
      if (!workflow) return c.text("Shiplet workflow unavailable", 503);
      const workflowValidation = validateWorkflowEvent(workflow, {
        status: String(formData.get("workflow_status") || ""),
        summary: String(formData.get("workflow_summary") || ""),
        fields,
      });
      if (!workflowValidation.ok) return json(workflowValidation, 400);
      validatedPayload = { ...workflowValidation.value };
      confirmationSummary = `${workflowValidation.value.status}: ${workflowValidation.value.summary}`;
      confirmationWorkflowFields = workflowValidation.value.fields;
    } else {
      const feedbackValidation = validateReviewFeedbackPayload({
        comment,
        pageUrl: submittedPageUrl,
        clientFeedbackId,
        mentions: mentions.value,
        ...(capture.value || {}),
      });
      if (!feedbackValidation.ok) {
        return json({ ok: false, errors: feedbackValidation.errors }, 400);
      }
      validatedPayload = { ...feedbackValidation.value };
      validatedPageUrl = feedbackValidation.value.pageUrl;
      confirmationSummary = feedbackValidation.value.comment;
    }
    const normalizedPageUrl = normalizeEmbedReturnUrl(
      validatedPageUrl,
      session.siteOrigin,
    );
    if (normalizedPageUrl !== pageUrl) {
      return c.text("Embedded review page mismatch", 403);
    }
    const payloadDigest = await sha256HexText(JSON.stringify(validatedPayload));
    const intentId = `embed_intent_${crypto.randomUUID().replace(/-/g, "")}`;
    const now = new Date();
    const expiresOn = new Date(now.getTime() + 2 * 60_000).toISOString();
    const inserted = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO embed_review_operation_intents (
				 id, installation_id, project_id, revision_id, actor_user_id,
				 effect, payload_json, payload_digest, request_id, page_url,
				 expires_on, confirmed_on, completed_on, created_on
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
      .bind(
        intentId,
        session.installationId,
        project.id,
        session.revisionId,
        session.actorUserId,
        operation,
        JSON.stringify(validatedPayload),
        payloadDigest,
        requestId,
        pageUrl,
        expiresOn,
        now.toISOString(),
      )
      .run();
    let storedIntentId = intentId;
    if (inserted.meta.changes !== 1) {
      const existing = await c.env.DB.prepare(
        `SELECT id, payload_digest FROM embed_review_operation_intents
					 WHERE installation_id = ? AND actor_user_id = ? AND request_id = ?
					   AND project_id = ? AND revision_id = ? AND expires_on > ?
					   AND confirmed_on IS NULL`,
      )
        .bind(
          session.installationId,
          session.actorUserId,
          requestId,
          project.id,
          session.revisionId,
          now.toISOString(),
        )
        .first<{ id: string; payload_digest: string }>();
      if (!existing || existing.payload_digest !== payloadDigest) {
        return c.text("Confirmation intent conflict", 409);
      }
      storedIntentId = existing.id;
    }
    return trustedConfirmationResponse(
      appBaseUrl(c.env, c.req.url),
      trustedConfirmationHtml({
        state: "pending",
        intentId: storedIntentId,
        summary: confirmationSummary,
        workflowFields: confirmationWorkflowFields,
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to prepare trusted confirmation", 500);
  }
});

type EmbedReviewIntentRow = {
  id: string;
  installation_id: string;
  project_id: string;
  revision_id: string;
  actor_user_id: string;
  effect: string;
  payload_json: string;
  payload_digest: string;
  request_id: string;
  page_url: string;
  expires_on: string;
  confirmed_on: string | null;
  completed_on: string | null;
};

async function completeTrustedReviewConfirmation(c: any) {
  try {
    const origin = new URL(appBaseUrl(c.env, c.req.url)).origin;
    if (
      !hasTrustedTopLevelFormProvenance(c.req.raw, [
        origin,
        new URL(c.req.url).origin,
      ])
    ) {
      return c.text("Trusted confirmation origin required", 403);
    }
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/x-www-form-urlencoded")) {
      return c.text("Trusted confirmation form required", 403);
    }
    const user = await requireCurrentUser(c);
    const formData = await c.req.raw.formData();
    const intentId = String(formData.get("intent_id") || "").trim();
    if (
      String(formData.get("approval") || "") !== "confirm" ||
      !/^(?:embed|review)_intent_[A-Za-z0-9]{16,128}$/.test(intentId)
    ) {
      return c.text("Explicit confirmation is required", 428);
    }
    const intent = (await c.env.DB.prepare(
      "SELECT * FROM embed_review_operation_intents WHERE id = ?",
    )
      .bind(intentId)
      .first()) as EmbedReviewIntentRow | null;
    if (!intent) return c.text("Confirmation intent not found", 404);
    if (intent.actor_user_id !== user.id) {
      return c.text("Confirmation actor mismatch", 403);
    }
    const project = await getProjectById(c.env.DB, intent.project_id);
    if (
      !project ||
      project.archived_on ||
      trustedReviewRevisionId(project) !== intent.revision_id ||
      !(await canViewProject(c.env.DB, project, user.id))
    ) {
      return c.text("Shiplet review access required", 403);
    }
    const now = new Date();
    if (intent.effect === "workflow.event.create") {
      let payload: unknown;
      try {
        payload = JSON.parse(intent.payload_json);
      } catch {
        return c.text("Confirmation payload is invalid", 400);
      }
      const workflow = await activeWorkflowSchema(
        c.env,
        project.id,
        intent.revision_id,
      );
      if (!workflow) return c.text("Shiplet workflow unavailable", 503);
      const record = isRecord(payload) ? payload : {};
      const validation = validateWorkflowEvent(workflow, {
        status: record.status,
        summary: record.summary,
        fields: record.fields,
      });
      if (!validation.ok) {
        return c.text("Confirmation payload is invalid", 400);
      }
      const committed = await commitValidatedWorkflowEvent({
        env: c.env,
        project,
        actorId: user.id,
        revisionId: intent.revision_id,
        value: validation.value,
        intentFence: {
          intentId: intent.id,
          confirmedOn: now.toISOString(),
        },
      });
      if (!committed.ok) {
        return json({ ok: false, code: committed.code }, committed.status);
      }
      return trustedConfirmationResponse(
        appBaseUrl(c.env, c.req.url),
        trustedConfirmationHtml({
          state: "complete",
          completeHeading: "Workflow event recorded",
          summary: "The workflow event was recorded by Shiplet.",
        }),
      );
    }
    const validation = validateReviewFeedbackPayload(
      JSON.parse(intent.payload_json),
    );
    if (!validation.ok || intent.effect !== "feedback.create") {
      return c.text("Confirmation payload is invalid", 400);
    }
    const feedback = await createReviewFeedback(
      c.env,
      project,
      user,
      validation.value,
      {
        revisionId: intent.revision_id,
        intentId: intent.id,
        confirmedOn: now.toISOString(),
        requestId: intent.request_id,
      },
    );
    if (!feedback) {
      const [current, latestIntent] = await Promise.all([
        getProjectById(c.env.DB, project.id),
        c.env.DB.prepare(
          `SELECT confirmed_on, completed_on
             FROM embed_review_operation_intents WHERE id = ? LIMIT 1`,
        )
          .bind(intent.id)
          .first() as Promise<{
          confirmed_on: string | null;
          completed_on: string | null;
        } | null>,
      ]);
      if (current && trustedReviewRevisionId(current) !== intent.revision_id) {
        return c.text("Shiplet revision changed; reopen review", 409);
      }
      return latestIntent?.confirmed_on || latestIntent?.completed_on
        ? c.text("Confirmation intent expired or already used", 409)
        : c.text("Feedback could not be recorded", 500);
    }
    return trustedConfirmationResponse(
      appBaseUrl(c.env, c.req.url),
      trustedConfirmationHtml({
        state: "complete",
        completeHeading: "Feedback sent",
        summary: "Your feedback was recorded by Shiplet.",
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to complete trusted confirmation", 500);
  }
}

app.post("/embed/review/confirm/complete", completeTrustedReviewConfirmation);
app.post("/review/confirm/complete", completeTrustedReviewConfirmation);

async function requireEmbedReviewSession(c: any) {
  const url = new URL(c.req.url);
  const installationId = url.searchParams.get("installation_id")?.trim() || "";
  if (!installationId) {
    throw new Response("Embedded review binding required", { status: 400 });
  }
  const handle = readEmbedReviewSessionHandle(
    c.req.header("cookie") || null,
    installationId,
  );
  if (!handle)
    throw new Response("Embedded review session required", { status: 401 });
  const session = await getEmbedReviewSession(c.env.DB, handle);
  if (!session) {
    throw new Response("Embedded review session expired or invalid", {
      status: 401,
    });
  }
  const pageUrl = normalizeEmbedReturnUrl(
    url.searchParams.get("page_url") || session.pageUrl,
    session.siteOrigin,
  );
  if (!pageUrl) {
    throw new Response("Embedded review binding required", { status: 400 });
  }
  const binding = validateEmbedReviewSessionBinding(session, {
    installationId,
    projectId: session.projectId,
    revisionId: session.revisionId,
    siteOrigin: session.siteOrigin,
    pageUrl,
    actorUserId: session.actorUserId,
    now: new Date(),
    operationClaimed: true,
  });
  if (!binding.ok) {
    throw new Response("Embedded review binding denied", {
      status: binding.reason === "expired" ? 401 : 403,
    });
  }
  const [project, user] = await Promise.all([
    getProjectById(c.env.DB, session.projectId),
    getUser(c.env.DB, session.actorUserId),
  ]);
  if (
    !project ||
    project.archived_on ||
    !user ||
    trustedReviewRevisionId(project) !== session.revisionId ||
    !(await canViewProject(c.env.DB, project, user.id))
  ) {
    throw new Response("Shiplet review access required", { status: 403 });
  }
  return { session, project, user, pageUrl };
}

app.get("/embed/review/host", async (c) => {
  try {
    const { session, project, pageUrl } = await requireEmbedReviewSession(c);
    const origin = new URL(c.req.url).origin;
    const widget = await activeReviewWidget(c.env, project);
    const bindingQuery = new URLSearchParams({
      installation_id: session.installationId,
      page_url: pageUrl,
    });
    return createTrustedReviewHostResponse({
      shipletId: project.id,
      revisionId: session.revisionId,
      title: project.name,
      artifactUrl: `${origin}/embed/review/context?${bindingQuery}`,
      widgetUrl: widget
        ? `${origin}/embed/review/widget?${bindingQuery}`
        : null,
      hostScriptUrl: `${origin}/api/review/host.js`,
      reviewApiUrl: `${origin}/embed/review/feedback?${bindingQuery}`,
      reviewPageUrl: pageUrl,
      frameAncestorOrigins: [session.siteOrigin],
    });
  } catch (error) {
    if (isResponse(error)) {
      if (error.status === 401) return embedReviewStateResponse(c, "expired");
      if (error.status === 403) {
        return embedReviewStateResponse(c, "permission_denied");
      }
      return error;
    }
    return embedReviewStateResponse(c, "offline");
  }
});

app.get("/embed/review/context", async (c) => {
  try {
    const { project, pageUrl } = await requireEmbedReviewSession(c);
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeEmbedHtml(project.name)}</title></head><body><main><h1>${escapeEmbedHtml(project.name)}</h1><p>Reviewing <code>${escapeEmbedHtml(pageUrl)}</code></p></main></body></html>`;
    return createSandboxedArtifactResponse({
      body,
      contentType: "text/html; charset=utf-8",
      role: "review_context",
      trustedHostOrigin: new URL(c.req.url).origin,
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load embedded review context: ${message}`, 500);
  }
});

app.get("/embed/review/widget", async (c) => {
  try {
    const { session, project } = await requireEmbedReviewSession(c);
    return serveActiveReviewWidget(
      c.env,
      project,
      session.revisionId,
      new URL(c.req.url).origin,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load embedded review widget", 503);
  }
});

app.get("/embed/review/feedback", async (c) => {
  try {
    const { project, pageUrl } = await requireEmbedReviewSession(c);
    return json({
      feedback: await listReviewFeedback(c.env.DB, project.id, {
        pageUrl,
        limit: 100,
      }),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list embedded review feedback: ${message}`, 500);
  }
});

app.post("/embed/review/feedback", async (c) => {
  try {
    const requestOrigin = new URL(c.req.url).origin;
    if (c.req.header("origin") !== requestOrigin) {
      return c.text("Trusted review origin required", 403);
    }
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/json")) {
      return c.text("Trusted review JSON request required", 403);
    }
    const receiptHandle = c.req.header("x-shiplet-operation-receipt") || "";
    if (!receiptHandle) return c.text("Operation receipt required", 403);
    const { session, project, user, pageUrl } =
      await requireEmbedReviewSession(c);
    const validation = validateReviewFeedbackPayload(await readJson(c));
    if (!validation.ok) {
      return json({ ok: false, errors: validation.errors }, 400);
    }
    const submittedPage = normalizeEmbedReturnUrl(
      validation.value.pageUrl,
      new URL(pageUrl).origin,
    );
    if (submittedPage !== pageUrl) {
      return c.text("Embedded review page mismatch", 403);
    }
    const receiptHash =
      await digestEmbedReviewOperationReceiptHandle(receiptHandle);
    if (!receiptHash) {
      return c.text("Operation receipt denied", 403);
    }
    const payloadDigest = await digestEmbedFeedbackOperation({
      comment: validation.value.comment,
      pageUrl: validation.value.pageUrl,
      clientFeedbackId: validation.value.clientFeedbackId,
    });
    const claimedOn = new Date().toISOString();
    const feedback = await createReviewFeedback(
      c.env,
      project,
      user,
      validation.value,
      {
        kind: "receipt",
        revisionId: session.revisionId,
        receiptHash,
        installationId: session.installationId,
        payloadDigest,
        requestId: validation.value.clientFeedbackId,
        claimedOn,
      },
    );
    if (!feedback) return c.text("Operation receipt denied", 403);
    return json({ ok: true, feedback }, 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to create embedded review feedback: ${message}`, 500);
  }
});

app.get("/api/embed/client.js", () => {
  return new Response(embedClientScript(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
});

app.post("/api/embed/installations/exchange", async (c) => {
  try {
    const body = await readJson(c);
    if (!isRecord(body)) return c.text("Invalid exchange request", 400);
    const site = normalizeEmbedSiteUrl(body.siteUrl);
    if (!site) return c.text("Invalid WordPress site URL", 400);
    const code = await consumeEmbedExchangeCode(c.env.DB, {
      code: body.code,
      purpose: "connection",
      siteOrigin: site.siteOrigin,
    });
    if (!code) return c.text("Connection code is invalid or expired", 401);
    const project = await getProjectById(c.env.DB, code.project_id);
    if (!project || project.archived_on) {
      return c.text("Shiplet project not found", 404);
    }
    const connected = await createEmbedInstallation(c.env.DB, code);
    return json(
      {
        installation: {
          ...connected.installation,
          projectName: project.name,
        },
        secret: connected.secret,
      },
      201,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to exchange WordPress connection: ${message}`, 500);
  }
});

app.post("/api/embed/session/exchange", async (c) => {
  return c.text("Embedded review exchange is retired", 410);
});

app.delete("/api/embed/installations/:installationId", async (c) => {
  try {
    const installation = await authenticateEmbedInstallation(
      c.env.DB,
      c.req.param("installationId"),
      c.req.header("authorization"),
    );
    if (!installation) {
      return c.text("WordPress installation access required", 401);
    }
    await revokeEmbedInstallation(c.env.DB, installation.id);
    return json({
      installation: {
        ...publicEmbedInstallation(installation),
        revokedOn: timestamps.now(),
      },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to disconnect WordPress site: ${message}`, 500);
  }
});

app.get("/api/me", async (c) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) return json({ authenticated: false }, 401);
  const organizations = await listOrganizationsForUser(c.env.DB, user.id);
  const features = dashboardFeatureFlags(c.env);
  return json({
    authenticated: true,
    user,
    organizations,
    features,
    avatarPresets: AVATAR_PRESETS,
  });
});

app.get("/api/platform/support-contract", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const result = await attestCloudflareSupportEntrypoints(
      c.env as DeploymentRuntimeEnv,
    );
    if (!result.ok) {
      return json(
        { ok: false, code: "cloudflare_support_contract_mismatch" },
        503,
      );
    }
    const supportHealth = await attestCloudflareSupportHealth(
      c.env as DeploymentRuntimeEnv,
    );
    if (!supportHealth.ok) {
      return json(
        { ok: false, code: "cloudflare_support_health_unavailable" },
        503,
      );
    }
    if (supportHealth.health.status !== "healthy") {
      const response = json(
        {
          ok: false,
          code: "cloudflare_support_health_degraded",
          supportHealth: supportHealth.health,
        },
        503,
      );
      response.headers.set("cache-control", "no-store");
      return response;
    }
    let managedRuntimeReadiness: { ok: true } | null = null;
    const runtime = c.env as DeploymentRuntimeEnv;
    if (cloudflareManagedRuntimeEnabledForUser(runtime, user.id)) {
      const gateway = runtime.CLOUDFLARE_MANAGED_RUNTIME_RPC;
      if (typeof gateway?.readiness !== "function") {
        return json(
          { ok: false, code: "managed_runtime_dependency_unavailable" },
          503,
        );
      }
      try {
        const readiness = await gateway.readiness(
          cloudflareManagedRuntimeExpectation(runtime),
        );
        if (
          !isRecord(readiness) ||
          Object.keys(readiness).sort().join(",") !== "ok" ||
          readiness.ok !== true
        ) {
          throw new Error("managed_runtime_dependency_mismatch");
        }
        managedRuntimeReadiness = { ok: true };
      } catch {
        return json(
          { ok: false, code: "managed_runtime_dependency_unavailable" },
          503,
        );
      }
    }
    const response = json({
      ok: true,
      contracts: result.contracts,
      supportHealth: supportHealth.health,
      ...(managedRuntimeReadiness
        ? { managedRuntime: managedRuntimeReadiness }
        : {}),
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return json(
      { ok: false, code: "cloudflare_support_contract_mismatch" },
      503,
    );
  }
});

function isManagedPlatformOperator(
  runtime: DeploymentRuntimeEnv,
  userId: string,
) {
  return (
    (runtime.CLOUDFLARE_MANAGED_RUNTIME_OPERATOR_USER_ID ||
      runtime.CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID ||
      "") === userId
  );
}

async function managedPlatformOperationId(
  kind: "reservation" | "retirement",
  input: {
    userId: string;
    connectionId: string;
    accountId: string;
    reservationOperationId?: string;
  },
) {
  const digest = encodeManagedOperationDigest(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          [
            `managed-platform-${kind}`,
            input.userId,
            input.connectionId,
            input.accountId,
            input.reservationOperationId || "",
          ].join("\u0000"),
        ),
      ),
    ),
  );
  return kind === "reservation"
    ? `managed_platform_${digest}`
    : `managed_platform_retire_${digest}`;
}

function managedPlatformMutationRejection(request: Request) {
  if (request.headers.get("origin") === new URL(request.url).origin) {
    return null;
  }
  return new Response("Managed platform mutation origin required", {
    status: 403,
  });
}

function normalizeManagedPlatformReservationProof(
  value: unknown,
  expected: {
    userId: string;
    connectionId: string;
    accountId: string;
    operationId?: string;
  },
) {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "accountId,connectionId,operationId,ownerUserId,purpose,reservedAt,schemaVersion,status" ||
    value.schemaVersion !== "shiplet.managed-platform-reservation-proof/v1" ||
    typeof value.operationId !== "string" ||
    !/^managed_platform_[A-Za-z0-9_-]{43}$/.test(value.operationId) ||
    (expected.operationId !== undefined &&
      value.operationId !== expected.operationId) ||
    value.purpose !== "managed_wfp_provider" ||
    value.connectionId !== expected.connectionId ||
    value.accountId !== expected.accountId ||
    value.ownerUserId !== expected.userId ||
    value.status !== "active" ||
    !Number.isSafeInteger(value.reservedAt) ||
    (value.reservedAt as number) < 0
  ) {
    throw new Error("managed_platform_reservation_proof_mismatch");
  }
  return Object.freeze(value);
}

app.get("/settings/managed-runtime/reservation", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const runtime = c.env as DeploymentRuntimeEnv;
    if (!isManagedPlatformOperator(runtime, user.id)) {
      return c.text("Managed platform operator access required", 403);
    }
    const connectionId = c.req.query("connectionId") || "";
    const accountId = c.req.query("accountId") || "";
    if (
      !CLOUDFLARE_CONTROL_IDENTIFIER.test(connectionId) ||
      !CLOUDFLARE_CONTROL_IDENTIFIER.test(accountId)
    ) {
      return c.text("Managed platform binding is invalid", 400);
    }
    let reservation: ReturnType<
      typeof normalizeManagedPlatformReservationProof
    > | null = null;
    const readiness = await cloudflareSupportMutationReadiness(runtime);
    if (
      readiness.ok &&
      typeof runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE
        ?.inspectPlatformConnection === "function"
    ) {
      try {
        reservation = normalizeManagedPlatformReservationProof(
          await runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE.inspectPlatformConnection(
            {
              schemaVersion: "shiplet.managed-platform-inspection/v1",
              purpose: "managed_wfp_provider",
              actor: { kind: "human", id: user.id },
              connectionId,
              accountId,
            },
            cloudflareSupportExpectation(runtime, "control_plane"),
          ),
          { userId: user.id, connectionId, accountId },
        );
      } catch {
        reservation = null;
      }
    }
    const reserved = reservation !== null;
    const confirmRetirement =
      reserved && c.req.query("confirmRetirement") === "yes";
    const reservationOperationId = reservation?.operationId ?? "";
    const retirementReviewHref =
      `/settings/managed-runtime/reservation?connectionId=${encodeURIComponent(connectionId)}` +
      `&accountId=${encodeURIComponent(accountId)}&confirmRetirement=yes`;
    const body = `<div class="dashboard-shell shiplet-dashboard-stage">
  <header class="app-page-topbar">
    <div class="app-page-title">
      <span class="success-card-label">Managed runtime</span>
      <h1>${reserved ? "Platform connection reserved" : "Reserve managed runtime connection"}</h1>
      <p>${reserved ? "The exact platform connection is active for managed Worker deployments." : "Confirm the Cloudflare connection Shiplet will use to install isolated managed Worker revisions."}</p>
    </div>
    <div class="dashboard-actions"><a class="btn btn-secondary btn-sm" href="/account">Return to settings</a></div>
  </header>
  <main id="managed-platform-reservation">
    <section class="success-card shiplet-panel shiplet-focus-strip" aria-labelledby="managed-platform-heading">
      <div class="dashboard-section-header">
        <div>
          <span class="status-badge ${reserved ? "status-active" : "status-pending"}">${reserved ? "Reserved" : "Approval required"}</span>
          <h2 id="managed-platform-heading">Cloudflare platform authority</h2>
          <p>Shiplet will use this connection only for the two untrusted Workers for Platforms namespaces. Customer deployment revoke controls will no longer affect it.</p>
        </div>
      </div>
      <dl class="dataContainer" style="margin-top: 16px;">
        <div><dt>Connection</dt><dd><code>${escapeAuthHtml(connectionId)}</code></dd></div>
        <div><dt>Account</dt><dd><code>${escapeAuthHtml(accountId)}</code></dd></div>
        <div><dt>Granted operations</dt><dd>Inspect, upload, and delete Shiplet-managed revision Workers</dd></div>
      </dl>
      ${
        reserved
          ? `<p class="banner banner-success" role="status" style="margin-top: 16px;">Reservation verified. Return to the release checklist to run the staged revision smoke test.</p>
      ${
        confirmRetirement
          ? `<section class="banner banner-error" aria-labelledby="managed-platform-retirement-heading" style="margin-top: 18px;">
        <h3 id="managed-platform-retirement-heading">Confirm platform connection retirement</h3>
        <p>Retire connection <code>${escapeAuthHtml(connectionId)}</code> for account <code>${escapeAuthHtml(accountId)}</code>?</p>
        <p>Managed Shiplet Workers fail closed until a new reservation is approved. Existing customer-owned deployments keep running.</p>
      </section>
      <form method="post" action="/api/platform/managed-runtime/reservation/retire" style="margin-top: 18px;">
        <input type="hidden" name="approval" value="true">
        <input type="hidden" name="reservationOperationId" value="${escapeAuthHtml(reservationOperationId)}">
        <input type="hidden" name="connectionId" value="${escapeAuthHtml(connectionId)}">
        <input type="hidden" name="accountId" value="${escapeAuthHtml(accountId)}">
        <button class="btn btn-danger" type="submit">Confirm retirement</button>
      </form>
      <p class="helper-text">This writes a separate immutable retirement audit record before ordinary OAuth revocation becomes available.</p>`
          : `<p style="margin-top: 18px;"><a class="btn btn-danger" href="${escapeAuthHtml(retirementReviewHref)}">Review retirement</a></p>
      <p class="helper-text">Retirement requires a separate confirmation step and removes future managed deployment authority immediately.</p>`
      }`
          : `<form method="post" action="/api/platform/managed-runtime/reservation" style="margin-top: 18px;">
        <input type="hidden" name="approval" value="true">
        <input type="hidden" name="connectionId" value="${escapeAuthHtml(connectionId)}">
        <input type="hidden" name="accountId" value="${escapeAuthHtml(accountId)}">
        <button class="btn btn-primary" type="submit">Reserve platform connection</button>
      </form>`
      }
    </section>
  </main>
</div>`;
    return c.html(
      renderPage(body, {
        nonce: kernelDocumentNonce(c),
        appUrl: appBaseUrl(c.env, c.req.url),
        user,
        title: "Managed runtime connection · Shiplet",
        indexing: "noindex",
        canonicalPath: null,
        skipLink: {
          href: "#managed-platform-reservation",
          label: "Skip to managed runtime connection",
        },
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load managed platform reservation", 500);
  }
});

app.post("/api/platform/managed-runtime/reservation", async (c) => {
  try {
    const originRejection = managedPlatformMutationRejection(c.req.raw);
    if (originRejection) return originRejection;
    const user = await requireCurrentUser(c);
    const runtime = c.env as DeploymentRuntimeEnv;
    if (!isManagedPlatformOperator(runtime, user.id)) {
      return json(
        { ok: false, code: "managed_platform_operator_required" },
        403,
      );
    }
    const isForm = (c.req.header("content-type") || "")
      .toLowerCase()
      .startsWith("application/x-www-form-urlencoded");
    const body = isForm ? await c.req.parseBody() : await readJson(c);
    if (
      !isRecord(body) ||
      Object.keys(body).sort().join(",") !==
        "accountId,approval,connectionId" ||
      (body.approval !== true && body.approval !== "true")
    ) {
      return json(
        { ok: false, code: "managed_platform_reservation_approval_required" },
        428,
      );
    }
    if (
      typeof body.connectionId !== "string" ||
      !CLOUDFLARE_CONTROL_IDENTIFIER.test(body.connectionId) ||
      typeof body.accountId !== "string" ||
      !CLOUDFLARE_CONTROL_IDENTIFIER.test(body.accountId)
    ) {
      return json({ ok: false, code: "managed_platform_binding_invalid" }, 400);
    }
    const readiness = await cloudflareSupportMutationReadiness(runtime);
    if (!readiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(readiness);
    }
    const controlPlane = runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE;
    if (typeof controlPlane?.reservePlatformConnection !== "function") {
      return json(
        { ok: false, code: "managed_platform_reservation_unavailable" },
        503,
      );
    }
    const operationId = await managedPlatformOperationId("reservation", {
      userId: user.id,
      connectionId: body.connectionId,
      accountId: body.accountId,
    });
    const reservation = await controlPlane.reservePlatformConnection(
      {
        schemaVersion: "shiplet.managed-platform-reservation/v1",
        operationId,
        purpose: "managed_wfp_provider",
        actor: { kind: "human", id: user.id },
        connectionId: body.connectionId,
        accountId: body.accountId,
      },
      cloudflareSupportExpectation(runtime, "control_plane"),
    );
    const normalizedReservation = normalizeManagedPlatformReservationProof(
      reservation,
      {
        userId: user.id,
        connectionId: body.connectionId,
        accountId: body.accountId,
        operationId,
      },
    );
    if (isForm) {
      return c.redirect(
        `/settings/managed-runtime/reservation?connectionId=${encodeURIComponent(body.connectionId)}&accountId=${encodeURIComponent(body.accountId)}`,
        303,
      );
    }
    const response = json(
      { ok: true, reservation: normalizedReservation },
      201,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return json(
      { ok: false, code: "managed_platform_reservation_failed" },
      503,
    );
  }
});

app.post("/api/platform/managed-runtime/reservation/retire", async (c) => {
  try {
    const originRejection = managedPlatformMutationRejection(c.req.raw);
    if (originRejection) return originRejection;
    const user = await requireCurrentUser(c);
    const runtime = c.env as DeploymentRuntimeEnv;
    if (!isManagedPlatformOperator(runtime, user.id)) {
      return json(
        { ok: false, code: "managed_platform_operator_required" },
        403,
      );
    }
    const isForm = (c.req.header("content-type") || "")
      .toLowerCase()
      .startsWith("application/x-www-form-urlencoded");
    const body = isForm ? await c.req.parseBody() : await readJson(c);
    if (
      !isRecord(body) ||
      Object.keys(body).sort().join(",") !==
        "accountId,approval,connectionId,reservationOperationId" ||
      (body.approval !== true && body.approval !== "true")
    ) {
      return json(
        { ok: false, code: "managed_platform_retirement_approval_required" },
        428,
      );
    }
    if (
      typeof body.connectionId !== "string" ||
      !CLOUDFLARE_CONTROL_IDENTIFIER.test(body.connectionId) ||
      typeof body.accountId !== "string" ||
      !CLOUDFLARE_CONTROL_IDENTIFIER.test(body.accountId) ||
      typeof body.reservationOperationId !== "string" ||
      !/^managed_platform_[A-Za-z0-9_-]{43}$/.test(body.reservationOperationId)
    ) {
      return json({ ok: false, code: "managed_platform_binding_invalid" }, 400);
    }
    const readiness = await cloudflareSupportMutationReadiness(runtime);
    if (!readiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(readiness);
    }
    const controlPlane = runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE;
    if (typeof controlPlane?.retirePlatformConnection !== "function") {
      return json(
        { ok: false, code: "managed_platform_retirement_unavailable" },
        503,
      );
    }
    const operationId = await managedPlatformOperationId("retirement", {
      userId: user.id,
      connectionId: body.connectionId,
      accountId: body.accountId,
      reservationOperationId: body.reservationOperationId,
    });
    const retirement = await controlPlane.retirePlatformConnection(
      {
        schemaVersion: "shiplet.managed-platform-retirement/v1",
        operationId,
        purpose: "managed_wfp_provider",
        actor: { kind: "human", id: user.id },
        reservationOperationId: body.reservationOperationId,
        connectionId: body.connectionId,
        accountId: body.accountId,
      },
      cloudflareSupportExpectation(runtime, "control_plane"),
    );
    if (
      !isRecord(retirement) ||
      Object.keys(retirement).sort().join(",") !==
        "accountId,connectionId,operationId,ownerUserId,purpose,reservationOperationId,retiredAt,schemaVersion,status" ||
      retirement.schemaVersion !==
        "shiplet.managed-platform-retirement-proof/v1" ||
      retirement.operationId !== operationId ||
      retirement.purpose !== "managed_wfp_provider" ||
      retirement.reservationOperationId !== body.reservationOperationId ||
      retirement.connectionId !== body.connectionId ||
      retirement.accountId !== body.accountId ||
      retirement.ownerUserId !== user.id ||
      retirement.status !== "retired" ||
      !Number.isSafeInteger(retirement.retiredAt) ||
      (retirement.retiredAt as number) < 0
    ) {
      throw new Error("managed_platform_retirement_proof_mismatch");
    }
    if (isForm) {
      return c.redirect("/account?managedPlatform=retired", 303);
    }
    const response = json({ ok: true, retirement }, 200);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return json({ ok: false, code: "managed_platform_retirement_failed" }, 503);
  }
});

app.post("/api/me/avatar", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const validation = validateAvatarUpdate(await readJson(c));
    if (!validation.ok) {
      return json({ ok: false, errors: validation.errors }, 400);
    }
    const updatedUser = await updateUserAvatar(
      c.env.DB,
      user.id,
      validation.value,
    );
    return json({ ok: true, user: updatedUser, avatarPresets: AVATAR_PRESETS });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to update avatar: ${message}`, 500);
  }
});

app.post("/api/external-url/metadata", async (c) => {
  try {
    await requireCurrentUser(c);
    let body: unknown;
    try {
      const text = await readRequestTextWithLimit(c.req.raw, 16 * 1024);
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      if (isResponse(error)) return error;
      return c.text("Invalid JSON body", 400);
    }
    const normalizedUrl = normalizeExternalOriginUrl(
      isRecord(body) ? body.url : undefined,
    );
    if (!normalizedUrl) {
      return c.text("External URL is required.", 400);
    }
    const metadata = await inspectExternalUrlMetadata({
      url: new URL(normalizedUrl),
      isAllowedUrl: (url) => isSafeExternalFetchUrl(c.env, url),
    });
    const response = json(metadata);
    response.headers.set("cache-control", "private, no-store");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Shiplet could not read metadata from that URL.", 422);
  }
});

app.get("/api/dashboard", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    // The dashboard is the first route many legacy installs load after a
    // deployment. Re-run the additive base-schema repair here so an isolate
    // whose initialization promise predates an out-of-band legacy restore does
    // not issue lifecycle queries against the old projects shape.
    await ensureKernelSchemas(c.env.DB);
    const organizations = await listOrganizationsForUser(c.env.DB, user.id);
    const projects = await listProjectsForUser(c.env.DB, user.id);
    const archivedProjects = await listProjectsForUser(c.env.DB, user.id, {
      archiveStatus: "archived",
    });
    const teamsByOrganization: Record<string, unknown[]> = {};
    const projectsByOrganization: Record<string, Project[]> = {};
    const archivedProjectsByOrganization: Record<string, Project[]> = {};
    const apiTokensByOrganization: Record<string, unknown[]> = {};
    const organizationRolesByOrganization: Record<string, string> = {};
    const featureFlags = dashboardFeatureFlags(c.env);

    for (const organization of organizations) {
      const membership = await requireOrganizationMembership(
        c.env.DB,
        organization.id,
        user.id,
      );
      organizationRolesByOrganization[organization.id] = membership.role;
      teamsByOrganization[organization.id] = await listTeamsForOrganization(
        c.env.DB,
        organization.id,
      );
      projectsByOrganization[organization.id] = projects.filter(
        (project) => project.organization_id === organization.id,
      );
      archivedProjectsByOrganization[organization.id] = archivedProjects.filter(
        (project) => project.organization_id === organization.id,
      );
      apiTokensByOrganization[organization.id] = isOrganizationAdministrator(
        membership,
      )
        ? await listOrganizationApiTokens(c.env.DB, organization.id)
        : [];
    }

    return json({
      user,
      organizations,
      teamsByOrganization,
      projects,
      archivedProjects,
      projectsByOrganization,
      archivedProjectsByOrganization,
      apiTokensByOrganization,
      organizationRolesByOrganization,
      avatarPresets: AVATAR_PRESETS,
      accountSessions: featureFlags.accountEmailSwitching
        ? await listCurrentAccountSessions(c.env, c.req.raw, user)
        : [],
      features: {
        ...featureFlags,
        workerCodePublishing: hasManagedAdvancedRuntime(c.env, user.id),
      },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load dashboard: ${message}`, 500);
  }
});

app.get("/api/organizations/:organizationId/api-tokens", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const organizationId = c.req.param("organizationId");
    await requireAuditedOrganizationAdministrator({
      db: c.env.DB,
      organizationId,
      actorId: user.id,
      action: "organization_token.list",
      authorize: () =>
        requireOrganizationAdministrator(c.env.DB, organizationId, user.id),
    });
    return json({
      tokens: await listOrganizationApiTokens(c.env.DB, organizationId),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list organization API keys: ${message}`, 500);
  }
});

app.post("/api/organizations/:organizationId/api-tokens", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const organizationId = c.req.param("organizationId");
    await requireAuditedOrganizationAdministrator({
      db: c.env.DB,
      organizationId,
      actorId: user.id,
      action: "organization_token.create",
      authorize: () =>
        requireOrganizationAdministrator(c.env.DB, organizationId, user.id),
    });
    const body = await readJson(c);
    const token = await runAuditedKernelAdminAction({
      db: c.env.DB,
      organizationId,
      actorId: user.id,
      action: "organization_token.create",
      targetKind: "organization_api_token",
      operation: () =>
        createOrganizationApiToken(c.env.DB, organizationId, body, user),
    });
    return json(token, 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to create organization API key: ${message}`, 500);
  }
});

app.delete(
  "/api/organizations/:organizationId/api-tokens/:tokenId",
  async (c) => {
    try {
      const user = await requireCurrentUser(c);
      const organizationId = c.req.param("organizationId");
      await requireAuditedOrganizationAdministrator({
        db: c.env.DB,
        organizationId,
        actorId: user.id,
        action: "organization_token.revoke",
        authorize: () =>
          requireOrganizationAdministrator(c.env.DB, organizationId, user.id),
      });
      const token = await runAuditedKernelAdminAction({
        db: c.env.DB,
        organizationId,
        actorId: user.id,
        action: "organization_token.revoke",
        targetKind: "organization_api_token",
        operation: () =>
          revokeOrganizationApiToken(
            c.env.DB,
            organizationId,
            c.req.param("tokenId"),
          ),
      });
      if (!token) return c.text("Organization API key not found", 404);
      return json({ token });
    } catch (error) {
      if (isResponse(error)) return error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.text(`Failed to revoke organization API key: ${message}`, 500);
    }
  },
);

app.get("/api/shiplets", async (c) => {
  try {
    const token = await authenticateOptionalOrganizationCredential(
      c.env.DB,
      c.req.header("authorization"),
      ["shiplets:read"],
    );
    if (token) {
      return json({
        projects: await listProjectsForOrganizationApiToken(c.env.DB, token, {
          archiveStatus: projectArchiveStatusFromUrl(c.req.url),
        }),
      });
    }

    const user = await requireCurrentUser(c);
    return json({
      projects: await listProjectsForUser(c.env.DB, user.id, {
        archiveStatus: projectArchiveStatusFromUrl(c.req.url),
      }),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list shiplets: ${message}`, 500);
  }
});

app.post("/api/shiplets", async (c) => {
  try {
    const body = (await readJson(c)) as PublishShipletPayload;
    const token = await authenticateOptionalOrganizationCredential(
      c.env.DB,
      c.req.header("authorization"),
      ["shiplets:write"],
    );
    if (token) {
      requireOrganizationApiShipletCreationAccess(token);
      const result = await publishShipletForOrganization(
        c.env,
        c.var.db,
        token.created_by_user_id,
        token.organization_id,
        body,
        { kind: "agent", id: token.id },
      );
      return json(publishResultPayload(c.env, c.req.url, result), 201);
    }

    const user = await requireCurrentUser(c);
    const result = await publishShiplet(c.env, c.var.db, user, body);
    return json(publishResultPayload(c.env, c.req.url, result), 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to publish shiplet: ${message}`, 500);
  }
});

app.get("/api/shiplets/:projectId/review-layer", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    return json(await readReviewLayer({ env: c.env, project, access }));
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to read the review layer", 500);
  }
});

app.post("/api/shiplets/:projectId/review-layer/previews", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    const body = await readJson(c);
    if (!isRecord(body)) return c.text("Invalid review layer request", 400);
    const preview = await prepareReviewLayerPreview({
      env: c.env,
      project,
      access,
      body,
      requestUrl: c.req.url,
    });
    return preview.ok ? json(preview.value, 201) : preview.response;
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to prepare the review layer preview", 500);
  }
});

app.post(
  "/api/shiplets/:projectId/review-layer/previews/:previewId/apply",
  async (c) => {
    try {
      const project = await getProjectById(c.env.DB, c.req.param("projectId"));
      if (!project) return c.text("Shiplet not found", 404);
      const access = await requireRevisionRouteAccess(c, project, "write");
      const body = await readJson(c);
      if (!isRecord(body)) return c.text("Invalid review layer request", 400);
      return json(
        await commitReviewLayerPreview({
          env: c.env,
          project,
          access,
          previewId: c.req.param("previewId"),
          body,
        }),
      );
    } catch (error) {
      if (isResponse(error)) return error;
      return c.text("Failed to apply the review layer preview", 500);
    }
  },
);

app.get("/api/shiplets/:projectId/package", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    const revision = await migrateLegacyShipletRevision(
      c.env.DB,
      project.id,
      c.env.SHIPLET_ASSETS,
    );
    const serialized = await revisionServiceFor(
      c.env.DB,
      access,
      c.env,
    ).exportRevisionPackage({
      shipletId: project.id,
      revisionId: revision.id,
      actor: access.actor,
    });
    return json({
      shipletId: project.id,
      package: JSON.parse(serialized),
      revision: {
        id: revision.id,
        parentRevisionId: revision.parentRevisionId,
        digest: revision.digest,
        contentDigest: revision.contentDigest,
      },
      disposition:
        new URL(c.req.url).searchParams.get("disposition") === "eject"
          ? "eject"
          : "pull",
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to export Shiplet package", 500);
  }
});

app.get("/api/shiplets/:projectId/revisions/:revisionId/package", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    const service = revisionServiceFor(c.env.DB, access, c.env);
    const revision = await service.getRevision({
      shipletId: project.id,
      revisionId: c.req.param("revisionId"),
      actor: access.actor,
    });
    const serialized = await service.exportRevisionPackage({
      shipletId: project.id,
      revisionId: revision.id,
      actor: access.actor,
    });
    return json({
      package: JSON.parse(serialized),
      revision: {
        id: revision.id,
        shipletId: project.id,
        parentRevisionId: revision.parentRevisionId,
        digest: revision.digest,
        contentDigest: revision.contentDigest,
      },
      disposition:
        new URL(c.req.url).searchParams.get("disposition") === "eject"
          ? "eject"
          : "pull",
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to export Shiplet revision package", 500);
  }
});

app.post("/api/shiplets/:projectId/workflow-events", async (c) => {
  try {
    const contentType = c.req.header("content-type")?.toLowerCase() || "";
    if (!contentType.startsWith("application/json")) {
      return c.text("Workflow event JSON required", 415);
    }
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project || project.archived_on)
      return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    if (access.actor.kind !== "human") {
      return c.text("Trusted human workflow confirmation required", 403);
    }
    const body = await readJson(c);
    if (
      !isRecord(body) ||
      Object.keys(body).some(
        (key) => !["revisionId", "status", "summary", "fields"].includes(key),
      ) ||
      typeof body.revisionId !== "string"
    ) {
      return json({ ok: false, code: "invalid_event" }, 400);
    }
    const activeRevisionId = trustedReviewRevisionId(project);
    if (body.revisionId !== activeRevisionId) {
      return json({ ok: false, code: "active_revision_conflict" }, 409);
    }
    const workflow = await activeWorkflowSchema(
      c.env,
      project.id,
      activeRevisionId,
    );
    if (!workflow) {
      return json({ ok: false, code: "workflow_unavailable" }, 503);
    }
    const validation = validateWorkflowEvent(workflow, {
      status: body.status,
      summary: body.summary,
      fields: body.fields,
    });
    if (!validation.ok) return json(validation, 400);

    const committed = await commitValidatedWorkflowEvent({
      env: c.env,
      project,
      actorId: access.actor.id,
      revisionId: activeRevisionId,
      value: validation.value,
    });
    return committed.ok
      ? json({ ok: true, event: committed.event }, 201)
      : json({ ok: false, code: committed.code }, committed.status);
  } catch (error) {
    if (isResponse(error)) return error;
    return json({ ok: false, code: "workflow_event_failed" }, 500);
  }
});

app.post("/api/shiplets/:projectId/drafts", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    const body = await readJson(c);
    if (!isRecord(body)) return c.text("Invalid fork request", 400);
    const active = await migrateLegacyShipletRevision(
      c.env.DB,
      project.id,
      c.env.SHIPLET_ASSETS,
    );
    const fromRevisionId =
      typeof body.fromRevisionId === "string" && body.fromRevisionId.length > 0
        ? body.fromRevisionId
        : active.id;
    const draft = await revisionServiceFor(
      c.env.DB,
      access,
      c.env,
    ).forkRevision({
      shipletId: project.id,
      revisionId: fromRevisionId,
      actor: access.actor,
    });
    return json({ draft }, 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to fork Shiplet revision", 500);
  }
});

app.get("/api/drafts/:draftId/package", async (c) => {
  try {
    const project = await revisionDraftProject(
      c.env.DB,
      c.req.param("draftId"),
    );
    if (!project) return c.text("Draft not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    const serialized = await revisionServiceFor(
      c.env.DB,
      access,
      c.env,
    ).exportDraftPackage({
      shipletId: project.id,
      draftId: c.req.param("draftId"),
      actor: access.actor,
    });
    const packageEnvelope = JSON.parse(serialized);
    const draft = await c.env.DB.prepare(
      `SELECT id, base_revision_id, version, validation_state,
				 validated_revision_id FROM shiplet_drafts
				 WHERE id = ? AND project_id = ?`,
    )
      .bind(c.req.param("draftId"), project.id)
      .first();
    if (!draft) return c.text("Draft not found", 404);
    return json({
      package: packageEnvelope,
      draft: {
        id: draft.id,
        shipletId: project.id,
        baseRevisionId: draft.base_revision_id,
        version: draft.version,
        validationState: draft.validation_state,
        validatedRevisionId: draft.validated_revision_id,
        packageDigest: await digestShipletPackage(packageEnvelope),
      },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to export draft package", 500);
  }
});

app.put("/api/drafts/:draftId/package", async (c) => {
  try {
    const project = await revisionDraftProject(
      c.env.DB,
      c.req.param("draftId"),
    );
    if (!project) return c.text("Draft not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    const body = await readJson(c);
    if (!isRecord(body)) return c.text("Invalid draft package request", 400);
    const submittedPackage = await parseShipletPackage(body.package);
    const packageDigest = await digestShipletPackage(submittedPackage);
    const draft = await revisionServiceFor(c.env.DB, access, c.env).updateDraft(
      {
        shipletId: project.id,
        draftId: c.req.param("draftId"),
        expectedVersion: expectedDraftVersion(c, body),
        package: submittedPackage,
        actor: access.actor,
      },
    );
    return json({ draft: { ...draft, packageDigest }, packageDigest });
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to update draft package", 500);
  }
});

app.post("/api/drafts/:draftId/diff", async (c) => {
  try {
    const project = await revisionDraftProject(
      c.env.DB,
      c.req.param("draftId"),
    );
    if (!project) return c.text("Draft not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    const body = await readJson(c);
    if (!isRecord(body)) return c.text("Invalid draft diff request", 400);
    const expectedVersion = expectedDraftVersion(c, body);
    const draft = await c.env.DB.prepare(
      "SELECT version FROM shiplet_drafts WHERE id = ? AND project_id = ?",
    )
      .bind(c.req.param("draftId"), project.id)
      .first<{ version: number }>();
    if (!draft || draft.version !== expectedVersion) {
      return json(
        { ok: false, code: "draft_conflict", currentVersion: draft?.version },
        409,
      );
    }
    const currentSerialized = await revisionServiceFor(
      c.env.DB,
      access,
      c.env,
    ).exportDraftPackage({
      shipletId: project.id,
      draftId: c.req.param("draftId"),
      actor: access.actor,
    });
    const [currentDigest, proposedPackage] = await Promise.all([
      digestShipletPackage(JSON.parse(currentSerialized)),
      parseShipletPackage(body.package),
    ]);
    const proposedDigest = await digestShipletPackage(proposedPackage);
    return json({
      ok: true,
      draftId: c.req.param("draftId"),
      draftVersion: draft.version,
      currentDigest,
      proposedDigest,
      changed: currentDigest !== proposedDigest,
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to diff draft package", 500);
  }
});

app.post("/api/drafts/:draftId/validate", async (c) => {
  try {
    const project = await revisionDraftProject(
      c.env.DB,
      c.req.param("draftId"),
    );
    if (!project) return c.text("Draft not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    const body = await readJson(c);
    if (!isRecord(body)) return c.text("Invalid validation request", 400);
    const service = revisionServiceFor(c.env.DB, access, c.env);
    const currentPackage = await parseShipletPackage(
      await service.exportDraftPackage({
        shipletId: project.id,
        draftId: c.req.param("draftId"),
        actor: access.actor,
      }),
    );
    const currentPackageDigest = await digestShipletPackage(currentPackage);
    if (body.package !== undefined || body.packageDigest !== undefined) {
      if (
        body.package === undefined ||
        typeof body.packageDigest !== "string"
      ) {
        return json(
          { ok: false, code: "validation_package_binding_required" },
          400,
        );
      }
      const submittedPackage = await parseShipletPackage(body.package);
      const submittedDigest = await digestShipletPackage(submittedPackage);
      if (
        body.packageDigest !== submittedDigest ||
        submittedDigest !== currentPackageDigest
      ) {
        return json({ ok: false, code: "validation_package_mismatch" }, 409);
      }
    }
    const validation = await service.validateDraft({
      shipletId: project.id,
      draftId: c.req.param("draftId"),
      expectedVersion: expectedDraftVersion(c, body),
      actor: access.actor,
    });
    if (
      validation.ok &&
      currentPackage.manifest.staticFirst === false &&
      hasManagedAdvancedRuntime(
        c.env,
        access.actor.kind === "human" ? access.actor.id : undefined,
      )
    ) {
      await stageManagedRuntimeRevision({
        env: c.env as DeploymentRuntimeEnv,
        actor: access.actor,
        shipletId: project.id,
        revisionId: validation.revisionId,
      });
    }
    return json(
      {
        validation: {
          ...validation,
          draftId: c.req.param("draftId"),
          packageDigest: currentPackageDigest,
          previewUrl: validatedDraftPreviewUrl({
            env: c.env,
            requestUrl: c.req.url,
            shipletId: project.id,
            draftId: c.req.param("draftId"),
            validation,
          }),
        },
      },
      validation.ok ? 200 : 422,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to validate draft", 500);
  }
});

app.post("/api/drafts/:draftId/promote", async (c) => {
  try {
    const project = await revisionDraftProject(
      c.env.DB,
      c.req.param("draftId"),
    );
    if (!project) return c.text("Draft not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    const body = await readJson(c);
    if (!isRecord(body) || body.approval !== true) {
      return c.text("Explicit promotion approval is required", 428);
    }
    const expectedActiveRevisionId = String(
      body.expectedActiveRevisionId || "",
    );
    if (!expectedActiveRevisionId) {
      return c.text("Expected active revision is required", 428);
    }
    const targetIds = exactDeploymentTargetIds(body);
    const idempotencyKey = revisionOperationIdempotencyKey(c);
    return json(
      await executeRevisionPromotion({
        env: c.env,
        access,
        project,
        draftId: c.req.param("draftId"),
        expectedActiveRevisionId,
        ...(targetIds ? { targetIds } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to promote draft", 500);
  }
});

app.post("/api/shiplets/:projectId/rollback", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    const body = await readJson(c);
    if (!isRecord(body) || body.approval !== true) {
      return c.text("Explicit rollback approval is required", 428);
    }
    const revisionId = String(body.revisionId || "");
    const expectedActiveRevisionId = String(
      body.expectedActiveRevisionId || "",
    );
    if (!revisionId || !expectedActiveRevisionId) {
      return c.text("Rollback revision preconditions are required", 428);
    }
    const targetIds = exactDeploymentTargetIds(body);
    const idempotencyKey = revisionOperationIdempotencyKey(c);
    return json(
      await executeRevisionRollback({
        env: c.env,
        access,
        project,
        revisionId,
        expectedActiveRevisionId,
        ...(targetIds ? { targetIds } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const failure = revisionApiError(error);
    if (failure) return failure;
    return c.text("Failed to roll back Shiplet", 500);
  }
});

app.post("/api/revisions/:revisionId/deployments", async (c) => {
  try {
    const revisionId = c.req.param("revisionId");
    const project = await revisionProject(c.env.DB, revisionId);
    if (!project) return c.text("Revision not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    if (access.actor.kind !== "human") {
      return c.text("Human approval is required for customer deployment", 403);
    }
    const humanActor = Object.freeze({
      kind: "human" as const,
      id: access.actor.id,
    });
    const body = await readJson(c);
    if (!isRecord(body) || body.approval !== true) {
      return c.text("Explicit deployment approval is required", 428);
    }
    const targetId = String(body.targetId || "");
    if (!targetId) return c.text("Deployment target is required", 400);
    const target = await c.env.DB.prepare(
      `SELECT id FROM deployment_targets
				 WHERE id = ? AND project_id = ? AND detached_on IS NULL LIMIT 1`,
    )
      .bind(targetId, project.id)
      .first<{ id: string }>();
    if (!target) return c.text("Deployment target not found", 404);
    const runtimeEnv = c.env as DeploymentRuntimeEnv;
    const supportReadiness =
      await cloudflareSupportMutationReadiness(runtimeEnv);
    if (!supportReadiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(supportReadiness);
    }
    const cloudflareRuntime = resolveCloudflareRequestRuntime(runtimeEnv);
    const provider = cloudflareRuntime.deployment.customerProvider;
    if (!provider) {
      return json(
        {
          ok: false,
          code: "customer_cloudflare_deployment_prerequisite",
          retryable: false,
        },
        503,
      );
    }
    const revision = await immutableRevisionDeploymentBundle({
      db: c.env.DB,
      shipletId: project.id,
      revisionId,
      packageStore: c.env.SHIPLET_ASSETS,
    });
    if (!revision) return c.text("Revision not found", 404);
    const idempotencyKey =
      c.req.header("idempotency-key")?.trim() ||
      (typeof body.idempotencyKey === "string"
        ? body.idempotencyKey.trim()
        : "");
    if (!idempotencyKey) {
      return json({ ok: false, code: "idempotency_key_required" }, 428);
    }
    if (idempotencyKey.length > 255) {
      return c.text("Idempotency key is too long", 400);
    }
    const now = () => Date.now();
    const orchestrator = createDeploymentOrchestrator({
      repository: createD1DeploymentRepository({ db: c.env.DB, now }),
      provider,
      connectionAuthorizer: createD1DeploymentConnectionAuthorizer({
        db: c.env.DB,
        now,
      }),
      temporaryDeploymentAuthorizer: createD1TemporaryDeploymentAuthorizer({
        db: c.env.DB,
        now,
      }),
      claimVault: cloudflareRuntime.claimVault ?? unavailableClaimVault,
      now,
      audit: (event) =>
        recordDeploymentAudit(
          c.env.DB,
          project.id,
          revisionId,
          humanActor,
          event,
        ),
      telemetry: async () => {},
    });
    const result = await orchestrator.deployCustomerRevision({
      actor: humanActor,
      shipletId: project.id,
      targetId,
      revision,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    if (!result.ok) {
      return json(
        { ok: false, code: result.reason, retryable: false },
        deploymentFailureStatus(result.reason),
      );
    }
    const operation = await c.env.DB.prepare(
      `SELECT id, status, result_deployment_id
				 FROM deployment_operation_journals
				 WHERE project_id = ? AND target_id = ? AND idempotency_key = ?
				 AND operation = 'deploy' AND revision_id = ? LIMIT 1`,
    )
      .bind(project.id, targetId, idempotencyKey, revisionId)
      .first<{
        id: string;
        status: string;
        result_deployment_id: string | null;
      }>();
    if (
      !operation ||
      operation.status !== "finalized" ||
      operation.result_deployment_id !== result.deployment.id
    ) {
      return json(
        { ok: false, code: "deployment_reconciliation_required" },
        502,
      );
    }
    return json(
      {
        ok: true,
        result,
        deployment: result.deployment,
        revisionId: result.deployment.revisionId,
        targetId: result.deployment.targetId,
        operation: {
          id: operation.id,
          kind: "deploy",
          status: "committed",
          idempotencyKey,
        },
      },
      201,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    if (error instanceof ShipletPackageError) {
      return json({ ok: false, code: error.code }, 400);
    }
    return c.text("Failed to deploy Shiplet revision", 500);
  }
});

app.post("/api/revisions/:revisionId/temporary-claims", async (c) => {
  try {
    const revisionId = c.req.param("revisionId");
    const project = await revisionProject(c.env.DB, revisionId);
    if (!project) return c.text("Revision not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    if (access.actor.kind !== "human") {
      return json({ ok: false, code: "human_approval_required" }, 403);
    }
    const body = await readJson(c);
    if (!isRecord(body) || body.approval !== true) {
      return c.text("Explicit temporary deployment approval is required", 428);
    }
    if (
      !hasExactCloudflareTemporaryAccountPolicyAcceptance(
        body.cloudflarePolicyAcceptance,
      )
    ) {
      return json(
        {
          ok: false,
          code: "cloudflare_policy_acceptance_required",
          policies: CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES,
        },
        428,
      );
    }
    const cloudflarePolicyAcceptance = body.cloudflarePolicyAcceptance;
    const idempotencyKey =
      c.req.header("idempotency-key")?.trim() ||
      (typeof body.idempotencyKey === "string"
        ? body.idempotencyKey.trim()
        : "");
    if (!idempotencyKey) {
      return json({ ok: false, code: "idempotency_key_required" }, 428);
    }
    if (idempotencyKey.length > 255) {
      return c.text("Idempotency key is too long", 400);
    }
    const runtimeEnv = c.env as DeploymentRuntimeEnv;
    const supportReadiness =
      await cloudflareSupportMutationReadiness(runtimeEnv);
    if (!supportReadiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(supportReadiness);
    }
    const cloudflareRuntime = resolveCloudflareRequestRuntime(
      runtimeEnv,
      access.actor.id,
    );
    const provider = cloudflareRuntime.deployment.temporaryProvider;
    const claimVault = cloudflareRuntime.claimVault;
    if (!provider || !claimVault) {
      return json(
        {
          ok: false,
          code: "temporary_claim_prerequisite",
          retryable: false,
        },
        503,
      );
    }
    const revision = await immutableRevisionDeploymentBundle({
      db: c.env.DB,
      shipletId: project.id,
      revisionId,
      packageStore: c.env.SHIPLET_ASSETS,
    });
    if (!revision) return c.text("Revision not found", 404);
    const actor = Object.freeze({
      kind: "human" as const,
      id: access.actor.id,
    });
    const targetDigest = await sha256HexText(
      `temporary-claim:${project.id}:${revisionId}:${actor.id}:${idempotencyKey}`,
    );
    const targetId = `target_claim_${targetDigest.slice(0, 32)}`;
    const configuration = JSON.stringify({
      scriptName: `shiplet-${targetDigest.slice(32, 64)}`,
      status: "connected",
      resourceBindingRefs: [],
    });
    const createdOn = new Date().toISOString();
    const targetAuditId = `audit_${crypto.randomUUID()}`;
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO deployment_targets (
					 id, project_id, kind, owner_kind, owner_id, connection_id,
					 provider_account_id, configuration_json, created_on, detached_on
					) VALUES (?, ?, 'temporary_claim', 'human', ?, NULL,
					 'temporary_account', ?, ?, NULL)`,
      ).bind(targetId, project.id, actor.id, configuration, createdOn),
      c.env.DB.prepare(
        `INSERT INTO shiplet_audit_events (
					 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
					 event_kind, summary, status_category, payload_json,
					 occurred_on, recorded_on
					) SELECT ?, ?, ?, NULL, 'human', ?,
					 'cloudflare.temporary_target.created',
					 'Temporary customer-owned target created', 'informational', ?, ?, ?
					 WHERE changes() = 1`,
      ).bind(
        targetAuditId,
        project.id,
        revisionId,
        actor.id,
        JSON.stringify({ targetId }),
        createdOn,
        createdOn,
      ),
    ]);
    const target = await c.env.DB.prepare(
      `SELECT project_id, kind, owner_kind, owner_id, connection_id,
				 provider_account_id, configuration_json, detached_on
				 FROM deployment_targets WHERE id = ? LIMIT 1`,
    )
      .bind(targetId)
      .first<Record<string, unknown>>();
    if (
      !target ||
      target.project_id !== project.id ||
      target.kind !== "temporary_claim" ||
      target.owner_kind !== "human" ||
      target.owner_id !== actor.id ||
      target.connection_id !== null ||
      target.provider_account_id !== "temporary_account" ||
      target.configuration_json !== configuration ||
      target.detached_on !== null
    ) {
      return json({ ok: false, code: "temporary_target_conflict" }, 409);
    }
    const now = () => Date.now();
    const orchestrator = createDeploymentOrchestrator({
      repository: createD1DeploymentRepository({ db: c.env.DB, now }),
      provider,
      connectionAuthorizer: createD1DeploymentConnectionAuthorizer({
        db: c.env.DB,
        now,
      }),
      temporaryDeploymentAuthorizer: createD1TemporaryDeploymentAuthorizer({
        db: c.env.DB,
        now,
      }),
      claimVault,
      now,
      audit: (event) =>
        recordDeploymentAudit(c.env.DB, project.id, revisionId, actor, event),
      telemetry: async () => {},
    });
    const result = await orchestrator.createTemporaryClaimDeployment({
      actor,
      shipletId: project.id,
      targetId,
      revision,
      idempotencyKey,
      cloudflarePolicyAcceptance,
    });
    if (!result.ok) {
      const status =
        result.reason === "operation_in_progress" ||
        result.reason === "idempotency_intent_mismatch" ||
        result.reason.startsWith("claim_already")
          ? 409
          : result.reason === "target_not_found"
            ? 404
            : 502;
      return json({ ok: false, code: result.reason }, status);
    }
    return json(
      {
        ok: true,
        deployment: result.deployment,
      },
      201,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    if (error instanceof ShipletPackageError) {
      return json({ ok: false, code: error.code }, 400);
    }
    return c.text("Failed to create temporary Shiplet deployment", 500);
  }
});

app.post("/api/temporary-claims/:targetId/claim", async (c) => {
  try {
    const targetId = c.req.param("targetId");
    const project = await c.env.DB.prepare(
      `SELECT project.* FROM deployment_targets target
				 JOIN projects project ON project.id = target.project_id
				 WHERE target.id = ? AND target.kind = 'temporary_claim'
				 AND target.detached_on IS NULL LIMIT 1`,
    )
      .bind(targetId)
      .first<Project>();
    if (!project) return c.text("Temporary claim not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    if (access.actor.kind !== "human") {
      return c.text("Human approval is required", 403);
    }
    const runtimeEnv = c.env as DeploymentRuntimeEnv;
    const supportReadiness =
      await cloudflareSupportMutationReadiness(runtimeEnv);
    if (!supportReadiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(supportReadiness);
    }
    const cloudflareRuntime = resolveCloudflareRequestRuntime(
      runtimeEnv,
      access.actor.id,
    );
    const provider = cloudflareRuntime.deployment.temporaryProvider;
    if (!provider || !cloudflareRuntime.claimVault) {
      return c.text("Temporary claim is unavailable", 503);
    }
    const now = () => Date.now();
    const orchestrator = createDeploymentOrchestrator({
      repository: createD1DeploymentRepository({ db: c.env.DB, now }),
      provider,
      connectionAuthorizer: createD1DeploymentConnectionAuthorizer({
        db: c.env.DB,
        now,
      }),
      temporaryDeploymentAuthorizer: createD1TemporaryDeploymentAuthorizer({
        db: c.env.DB,
        now,
      }),
      claimVault: cloudflareRuntime.claimVault,
      now,
      audit: async () => {},
      telemetry: async () => {},
    });
    const response = await orchestrator.redeemTemporaryClaim({
      actor: { kind: "human", id: access.actor.id },
      shipletId: project.id,
      targetId,
    });
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Temporary claim is unavailable", 410);
  }
});

app.get("/api/shiplets/:projectId/deployment-status", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "read");
    const targetRows = await c.env.DB.prepare(
      `SELECT target.id, target.kind, target.owner_kind, target.owner_id,
				 target.provider_account_id, target.detached_on, target.connection_id,
				 connection.status AS connection_status,
				 ack.connection_id AS acknowledgement_pending,
				 deployment.id AS deployment_id,
				 deployment.revision_id AS deployment_revision_id,
				 deployment.provider_resource_name,
				 deployment.provider_version_id,
				 deployment.status AS deployment_status,
				 deployment.deployed_on
			 FROM deployment_targets target
			 LEFT JOIN cloudflare_connections connection
			 ON connection.id = target.connection_id
			 LEFT JOIN cloudflare_oauth_ack_outbox ack
			 ON ack.connection_id = connection.id
			 LEFT JOIN shiplet_deployments deployment ON deployment.id = (
				 SELECT latest.id FROM shiplet_deployments latest
				 WHERE latest.target_id = target.id
				 ORDER BY latest.deployed_on DESC, latest.rowid DESC LIMIT 1
			 )
			 WHERE target.project_id = ? ORDER BY target.created_on, target.id`,
    )
      .bind(project.id)
      .all<Record<string, unknown>>();
    const targets = targetRows.results.map((row) => {
      const connectionStatus =
        row.connection_status === "active" && row.acknowledgement_pending
          ? "pending"
          : row.connection_status === "active" ||
              row.connection_status === "revoked"
            ? row.connection_status
            : row.detached_on
              ? "revoked"
              : "unavailable";
      const deploymentStatus =
        typeof row.deployment_status === "string"
          ? row.deployment_status
          : null;
      return {
        id: row.id,
        kind: row.kind,
        ownership: "customer",
        ownerUserId: row.owner_id,
        providerAccountId: row.provider_account_id,
        connection:
          typeof row.connection_id === "string"
            ? { id: row.connection_id, status: connectionStatus }
            : null,
        detached: Boolean(row.detached_on),
        lastDeployment:
          typeof row.deployment_id === "string"
            ? {
                id: row.deployment_id,
                revisionId: row.deployment_revision_id,
                scriptName: row.provider_resource_name,
                providerVersionId: row.provider_version_id,
                status: deploymentStatus,
                deployedOn: row.deployed_on,
                running: deploymentStatus === "healthy",
                updatesAvailable:
                  connectionStatus === "active" && !row.detached_on,
              }
            : null,
      };
    });
    const runtime = c.env as DeploymentRuntimeEnv;
    const supportReadiness = await cloudflareSupportMutationReadiness(runtime);
    const supportReady = supportReadiness.ok;
    const oauthControlPlane = supportReady
      ? cloudflareOAuthControlPlaneForUser(runtime, access.actor.id)
      : null;
    const managedRuntime = await managedRuntimeForProject(c.env, project);
    return json({
      shipletId: project.id,
      managed: {
        default: true,
        owner: "shiplet",
        status: project.archived_on ? "archived" : "active",
        runtime: managedRuntime,
        arbitraryWorkerExecution: hasManagedAdvancedRuntime(
          c.env,
          access.actor.kind === "human" ? access.actor.id : undefined,
        )
          ? { available: true }
          : {
              available: false,
              reason: "managed_dynamic_unavailable",
            },
      },
      customerCloudflare: {
        connectAvailable: Boolean(oauthControlPlane),
        reason: oauthControlPlane
          ? null
          : supportReady
            ? cloudflareOAuthUnavailableCode(runtime)
            : cloudflareSupportMutationFailureCode(supportReadiness),
        targets,
      },
    });
  } catch (error) {
    if (isResponse(error)) return error;
    return json({ ok: false, code: "deployment_status_failed" }, 500);
  }
});

app.post("/api/cloudflare/oauth/start", async (c) => {
  try {
    const body = await readJson(c);
    if (!isRecord(body) || typeof body.shipletId !== "string") {
      return json(
        { ok: false, code: "invalid_cloudflare_connect_request" },
        400,
      );
    }
    const project = await getProjectById(c.env.DB, body.shipletId);
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    if (access.actor.kind !== "human") {
      return json({ ok: false, code: "human_approval_required" }, 403);
    }
    const runtime = c.env as DeploymentRuntimeEnv;
    const supportReadiness = await cloudflareSupportMutationReadiness(runtime);
    if (!supportReadiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(supportReadiness);
    }
    const controlPlane = cloudflareOAuthControlPlaneForUser(
      runtime,
      access.actor.id,
    );
    if (!controlPlane) {
      return json(
        { ok: false, code: cloudflareOAuthUnavailableCode(runtime) },
        503,
      );
    }
    const expectedAccountId =
      typeof body.expectedAccountId === "string"
        ? body.expectedAccountId.trim()
        : "";
    if (
      expectedAccountId &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(expectedAccountId)
    ) {
      return json({ ok: false, code: "invalid_cloudflare_account" }, 400);
    }
    const deliveryHandle = newCloudflareOAuthDeliveryHandle();
    const returnKey = newCloudflareOAuthReturnKey();
    const result = await controlPlane.begin({
      actor: Object.freeze({ kind: "human", id: access.actor.id }),
      shipletId: project.id,
      sessionBinding: await cloudflareOAuthSessionBinding({
        request: c.req.raw,
        env: c.env,
        userId: access.actor.id,
      }),
      deliveryHandle,
      returnKey,
      requestedScopes: [
        CLOUDFLARE_OAUTH_SCOPES.workerScriptRead,
        CLOUDFLARE_OAUTH_SCOPES.workerScriptWrite,
      ],
      ...(expectedAccountId ? { expectedAccountId } : {}),
    });
    if (!result.ok) {
      return json(
        { ok: false, code: "cloudflare_oauth_denied", reason: result.reason },
        403,
      );
    }
    const authorizationUrl = cloudflareAuthorizationUrl(
      result.authorizationUrl,
    );
    if (!authorizationUrl) {
      return json({ ok: false, code: "cloudflare_oauth_unavailable" }, 503);
    }
    const response = json({ ok: true, authorizationUrl });
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set(
      "set-cookie",
      cloudflareOAuthDeliveryCookie(c.req.raw, returnKey, deliveryHandle),
    );
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return json({ ok: false, code: "cloudflare_oauth_unavailable" }, 503);
  }
});

async function finalizeCloudflareOAuthRequest(
  c: any,
  delivery: { shipletId: string; deliveryHandle: string },
) {
  try {
    const user = await requireCurrentUser(c);
    const runtime = c.env as DeploymentRuntimeEnv;
    const supportReadiness = await cloudflareSupportMutationReadiness(runtime);
    if (!supportReadiness.ok) {
      return cloudflareSupportMutationUnavailableResponse(supportReadiness);
    }
    const controlPlane = cloudflareOAuthControlPlaneForUser(runtime, user.id);
    if (!controlPlane) {
      return json(
        { ok: false, code: cloudflareOAuthUnavailableCode(runtime) },
        503,
      );
    }
    const actor = Object.freeze({ kind: "human" as const, id: user.id });
    const sessionBinding = await cloudflareOAuthSessionBinding({
      request: c.req.raw,
      env: c.env,
      userId: user.id,
    });
    const result = await controlPlane.finalize({
      actor,
      shipletId: delivery.shipletId,
      sessionBinding,
      deliveryHandle: delivery.deliveryHandle,
    });
    if (!result.ok) {
      return json(
        { ok: false, code: "cloudflare_oauth_denied", reason: result.reason },
        403,
      );
    }
    const now = Date.now();
    const validated = validatedCloudflareFinalizeResult(result, {
      userId: user.id,
      now,
    });
    if (!validated.ok) {
      if (result.connection.userId === user.id) {
        try {
          const compensation = await controlPlane.revoke({
            actor,
            connectionId: result.connection.id,
            sessionBinding,
          });
          if (
            !compensation.ok &&
            compensation.connection?.status !== "revoked"
          ) {
            return json(
              {
                ok: false,
                code: "cloudflare_connection_compensation_pending",
              },
              503,
            );
          }
        } catch {
          return json(
            {
              ok: false,
              code: "cloudflare_connection_compensation_pending",
            },
            503,
          );
        }
      }
      return json(
        {
          ok: false,
          code:
            validated.code === "cross_user"
              ? "cloudflare_oauth_actor_mismatch"
              : "cloudflare_oauth_invalid_result",
        },
        validated.code === "cross_user" ? 403 : 503,
      );
    }
    if (validated.shipletId !== delivery.shipletId) {
      try {
        const compensation = await controlPlane.revoke({
          actor,
          connectionId: validated.connection.id,
          sessionBinding,
        });
        if (!compensation.ok && compensation.connection?.status !== "revoked") {
          return json(
            { ok: false, code: "cloudflare_connection_compensation_pending" },
            503,
          );
        }
      } catch {
        return json(
          { ok: false, code: "cloudflare_connection_compensation_pending" },
          503,
        );
      }
      return json(
        { ok: false, code: "cloudflare_oauth_shiplet_mismatch" },
        403,
      );
    }
    const compensate = async () => {
      try {
        const compensation = await controlPlane.revoke({
          actor,
          connectionId: validated.connection.id,
          sessionBinding,
        });
        return compensation.ok || compensation.connection?.status === "revoked";
      } catch {
        return false;
      }
    };
    const compensationPending = () =>
      json(
        { ok: false, code: "cloudflare_connection_compensation_pending" },
        503,
      );
    let project;
    try {
      project = await getProjectById(c.env.DB, validated.shipletId);
    } catch {
      if (!(await compensate())) return compensationPending();
      return json({ ok: false, code: "cloudflare_connection_conflict" }, 409);
    }
    if (!project) {
      if (!(await compensate())) return compensationPending();
      return c.text("Shiplet not found", 404);
    }
    let access;
    try {
      access = await requireRevisionRouteAccess(c, project, "write");
    } catch (error) {
      if (!(await compensate())) return compensationPending();
      throw error;
    }
    if (access.actor.kind !== "human" || access.actor.id !== user.id) {
      if (!(await compensate())) return compensationPending();
      return json({ ok: false, code: "human_approval_required" }, 403);
    }
    const targetId = `target_${(
      await sha256HexText(
        `cloudflare-target:${project.id}:${validated.connection.id}`,
      )
    ).slice(0, 48)}`;
    const scriptName = `shiplet-${(
      await sha256HexText(`${project.id}:${validated.connection.id}`)
    ).slice(0, 32)}`;
    const createdOn = new Date(now).toISOString();
    const auditId = `audit_${(
      await sha256HexText(
        `cloudflare-connection-audit:${project.id}:${validated.connection.id}`,
      )
    ).slice(0, 48)}`;
    const expectedTargetConfiguration = {
      scriptName,
      status: "connected",
      resourceBindingRefs: [],
    };
    const expectedAuditPayload = {
      connectionId: validated.connection.id,
      targetId,
      accountId: validated.connection.accountId,
    };
    type PersistedOAuthConnection = {
      id: string;
      user_id: string;
      account_id: string;
      account_label: string;
      scopes_json: string;
      credential_ref: string;
      expires_at: number;
      status: string;
      generation: number;
    };
    type PersistedOAuthTarget = {
      id: string;
      project_id: string;
      kind: string;
      owner_kind: string;
      owner_id: string;
      connection_id: string;
      provider_account_id: string;
      configuration_json: string;
      detached_on: string | null;
    };
    type PersistedOAuthAudit = {
      id: string;
      project_id: string;
      actor_kind: string;
      actor_id: string;
      event_kind: string;
      summary: string;
      status_category: string;
      payload_json: string;
    };
    const readPersistedState = async () => ({
      connection: (await c.env.DB.prepare(
        `SELECT id, user_id, account_id, account_label, scopes_json,
                credential_ref, expires_at, status, generation
         FROM cloudflare_connections WHERE id = ?`,
      )
        .bind(validated.connection.id)
        .first()) as PersistedOAuthConnection | null,
      target: (await c.env.DB.prepare(
        `SELECT id, project_id, kind, owner_kind, owner_id, connection_id,
                provider_account_id, configuration_json, detached_on
         FROM deployment_targets WHERE id = ?`,
      )
        .bind(targetId)
        .first()) as PersistedOAuthTarget | null,
      audit: (await c.env.DB.prepare(
        `SELECT id, project_id, actor_kind, actor_id, event_kind, summary,
                status_category, payload_json
         FROM shiplet_audit_events WHERE id = ?`,
      )
        .bind(auditId)
        .first()) as PersistedOAuthAudit | null,
    });
    const persistedStateMatches = (state: {
      connection: PersistedOAuthConnection | null;
      target: PersistedOAuthTarget | null;
      audit: PersistedOAuthAudit | null;
    }) => {
      let persistedScopes: unknown = null;
      let targetConfiguration: unknown = null;
      let auditPayload: unknown = null;
      try {
        persistedScopes = state.connection
          ? JSON.parse(state.connection.scopes_json)
          : null;
        targetConfiguration = state.target
          ? JSON.parse(state.target.configuration_json)
          : null;
        auditPayload = state.audit
          ? JSON.parse(state.audit.payload_json)
          : null;
      } catch {
        return { compatible: false, complete: false };
      }
      const connectionMatches =
        !state.connection ||
        (state.connection.user_id === user.id &&
          state.connection.account_id === validated.connection.accountId &&
          state.connection.account_label ===
            validated.connection.accountLabel &&
          JSON.stringify(persistedScopes) ===
            JSON.stringify(validated.connection.scopes) &&
          state.connection.credential_ref ===
            `control-plane:${validated.connection.id}` &&
          state.connection.expires_at === validated.connection.expiresAt &&
          state.connection.status === "active" &&
          state.connection.generation === validated.connection.generation);
      const targetMatches =
        !state.target ||
        (state.target.project_id === project.id &&
          state.target.kind === "customer_cloudflare" &&
          state.target.owner_kind === "human" &&
          state.target.owner_id === user.id &&
          state.target.connection_id === validated.connection.id &&
          state.target.provider_account_id === validated.connection.accountId &&
          state.target.detached_on === null &&
          JSON.stringify(targetConfiguration) ===
            JSON.stringify(expectedTargetConfiguration));
      const auditMatches =
        !state.audit ||
        (state.audit.project_id === project.id &&
          state.audit.actor_kind === "human" &&
          state.audit.actor_id === user.id &&
          state.audit.event_kind === "cloudflare.connection.created" &&
          state.audit.summary === "Customer Cloudflare account connected" &&
          state.audit.status_category === "resolved" &&
          JSON.stringify(auditPayload) ===
            JSON.stringify(expectedAuditPayload));
      return {
        compatible:
          connectionMatches &&
          targetMatches &&
          auditMatches &&
          !(state.target && !state.connection),
        complete: Boolean(state.connection && state.target && state.audit),
      };
    };
    let persistedState = await readPersistedState();
    if (!persistedStateMatches(persistedState).compatible) {
      if (!(await compensate())) return compensationPending();
      return json({ ok: false, code: "cloudflare_connection_conflict" }, 409);
    }
    try {
      const statements: D1PreparedStatement[] = [];
      if (!persistedState.connection) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO cloudflare_connections (
						 id, user_id, account_id, account_label, scopes_json,
						 credential_ref, expires_at, status, revoked_at, generation,
						 created_on, refreshed_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`,
          ).bind(
            validated.connection.id,
            user.id,
            validated.connection.accountId,
            validated.connection.accountLabel,
            JSON.stringify(validated.connection.scopes),
            `control-plane:${validated.connection.id}`,
            validated.connection.expiresAt,
            validated.connection.generation,
            createdOn,
          ),
        );
      }
      if (!persistedState.target) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO deployment_targets (
						 id, project_id, kind, owner_kind, owner_id, connection_id,
						 provider_account_id, configuration_json, created_on, detached_on
						) VALUES (?, ?, 'customer_cloudflare', 'human', ?, ?, ?, ?, ?, NULL)`,
          ).bind(
            targetId,
            project.id,
            user.id,
            validated.connection.id,
            validated.connection.accountId,
            JSON.stringify(expectedTargetConfiguration),
            createdOn,
          ),
        );
      }
      if (!persistedState.audit) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO shiplet_audit_events (
						 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
						 event_kind, summary, status_category, payload_json,
						 occurred_on, recorded_on
						) VALUES (?, ?, NULL, NULL, 'human', ?,
						 'cloudflare.connection.created',
						 'Customer Cloudflare account connected', 'resolved', ?, ?, ?)`,
          ).bind(
            auditId,
            project.id,
            user.id,
            JSON.stringify(expectedAuditPayload),
            createdOn,
            createdOn,
          ),
        );
      }
      statements.push(
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO cloudflare_oauth_ack_outbox (
						connection_id, project_id, user_id, shiplet_id,
						delivery_handle, session_binding, delivery_expires_at,
						attempt_count, created_on, last_attempt_on
					) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
        ).bind(
          validated.connection.id,
          project.id,
          user.id,
          project.id,
          delivery.deliveryHandle,
          sessionBinding,
          validated.deliveryExpiresAt,
          createdOn,
        ),
      );
      if (statements.length > 0) await c.env.DB.batch(statements);
    } catch {
      persistedState = await readPersistedState();
      const recovered = persistedStateMatches(persistedState);
      if (!recovered.compatible || !recovered.complete) {
        if (!(await compensate())) return compensationPending();
        return json({ ok: false, code: "cloudflare_connection_conflict" }, 409);
      }
    }
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO cloudflare_oauth_ack_outbox (
				connection_id, project_id, user_id, shiplet_id,
				delivery_handle, session_binding, delivery_expires_at,
				attempt_count, created_on, last_attempt_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)`,
    )
      .bind(
        validated.connection.id,
        project.id,
        user.id,
        project.id,
        delivery.deliveryHandle,
        sessionBinding,
        validated.deliveryExpiresAt,
        createdOn,
      )
      .run();
    const acknowledgement = (await c.env.DB.prepare(
      `SELECT project_id, user_id, shiplet_id, delivery_handle,
			        session_binding, delivery_expires_at
			 FROM cloudflare_oauth_ack_outbox WHERE connection_id = ?`,
    )
      .bind(validated.connection.id)
      .first()) as Record<string, unknown> | null;
    if (
      acknowledgement?.project_id !== project.id ||
      acknowledgement.user_id !== user.id ||
      acknowledgement.shiplet_id !== project.id ||
      acknowledgement.delivery_handle !== delivery.deliveryHandle ||
      acknowledgement.session_binding !== sessionBinding ||
      acknowledgement.delivery_expires_at !== validated.deliveryExpiresAt
    ) {
      if (!(await compensate())) return compensationPending();
      return json({ ok: false, code: "cloudflare_connection_conflict" }, 409);
    }
    try {
      const acknowledged = await controlPlane.acknowledge({
        actor,
        shipletId: project.id,
        sessionBinding,
        deliveryHandle: delivery.deliveryHandle,
        connectionId: validated.connection.id,
      });
      if (!acknowledged.ok) {
        return json({ ok: false, code: "cloudflare_oauth_ack_pending" }, 503);
      }
    } catch {
      return json({ ok: false, code: "cloudflare_oauth_ack_pending" }, 503);
    }
    try {
      const cleared = await c.env.DB.prepare(
        `DELETE FROM cloudflare_oauth_ack_outbox
				 WHERE connection_id = ? AND project_id = ? AND user_id = ?
				   AND delivery_handle = ? AND session_binding = ?`,
      )
        .bind(
          validated.connection.id,
          project.id,
          user.id,
          delivery.deliveryHandle,
          sessionBinding,
        )
        .run();
      if (cleared.meta.changes !== 1) {
        return json({ ok: false, code: "cloudflare_oauth_ack_pending" }, 503);
      }
    } catch {
      return json({ ok: false, code: "cloudflare_oauth_ack_pending" }, 503);
    }
    const response = json(
      {
        ok: true,
        shipletId: project.id,
        connection: validated.connection,
        target: {
          id: targetId,
          shipletId: project.id,
          kind: "customer_cloudflare",
          connectionId: validated.connection.id,
          providerAccountId: validated.connection.accountId,
          scriptName,
          status: "connected",
        },
      },
      201,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return json({ ok: false, code: "cloudflare_oauth_unavailable" }, 503);
  }
}

function invalidCloudflareOAuthReturn() {
  const response = json(
    { ok: false, code: "cloudflare_oauth_return_invalid" },
    400,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

function validCloudflareOAuthDelivery(value: unknown) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "deliveryHandle" ||
    keys[1] !== "shipletId" ||
    typeof value.shipletId !== "string" ||
    !CLOUDFLARE_CONTROL_IDENTIFIER.test(value.shipletId) ||
    typeof value.deliveryHandle !== "string" ||
    !CLOUDFLARE_OAUTH_DELIVERY_HANDLE.test(value.deliveryHandle)
  ) {
    return null;
  }
  return {
    shipletId: value.shipletId,
    deliveryHandle: value.deliveryHandle,
  };
}

app.post("/api/cloudflare/oauth/finalize", async (c) => {
  try {
    const delivery = validCloudflareOAuthDelivery(await readJson(c));
    if (!delivery) return invalidCloudflareOAuthReturn();
    return finalizeCloudflareOAuthRequest(c, delivery);
  } catch (error) {
    if (isResponse(error)) return error;
    return invalidCloudflareOAuthReturn();
  }
});

app.post("/api/cloudflare/oauth/return", async (c) => {
  return invalidCloudflareOAuthReturn();
});

app.get("/api/cloudflare/oauth/return", async (c) => {
  const url = new URL(c.req.url);
  const keys = [...url.searchParams.keys()];
  const status = url.searchParams.get("status");
  const shipletId = url.searchParams.get("shipletId");
  const returnKey = url.searchParams.get("flow");
  if (status === "denied" && keys.length === 1 && keys[0] === "status") {
    const response = c.redirect("/dashboard?cloudflare=denied", 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  if (
    status === "denied" &&
    keys.length === 2 &&
    new Set(keys).size === 2 &&
    keys.every((key) => key === "status" || key === "flow") &&
    returnKey &&
    CLOUDFLARE_OAUTH_RETURN_KEY.test(returnKey)
  ) {
    const response = c.redirect("/dashboard?cloudflare=denied", 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set(
      "set-cookie",
      clearCloudflareOAuthDeliveryCookie(c.req.raw, returnKey),
    );
    return response;
  }
  if (
    status !== "connected" ||
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    !keys.every(
      (key) => key === "status" || key === "shipletId" || key === "flow",
    ) ||
    !shipletId ||
    !CLOUDFLARE_CONTROL_IDENTIFIER.test(shipletId) ||
    !returnKey ||
    !CLOUDFLARE_OAUTH_RETURN_KEY.test(returnKey)
  ) {
    return invalidCloudflareOAuthReturn();
  }
  const deliveryHandle = getCookie(
    c.req.raw,
    cloudflareOAuthDeliveryCookieName(c.req.raw, returnKey),
  );
  if (
    !deliveryHandle ||
    !CLOUDFLARE_OAUTH_DELIVERY_HANDLE.test(deliveryHandle)
  ) {
    return invalidCloudflareOAuthReturn();
  }
  const delivery = { shipletId, deliveryHandle };
  const finalized = await finalizeCloudflareOAuthRequest(c, delivery);
  if (finalized.status !== 201) return finalized;
  const payload = (await finalized.clone().json()) as unknown;
  if (!isRecord(payload) || payload.shipletId !== shipletId) {
    return json({ ok: false, code: "cloudflare_oauth_invalid_result" }, 503);
  }
  const response = c.redirect(
    `/shiplets/${encodeURIComponent(shipletId)}/ownership?cloudflare=connected`,
    303,
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set(
    "set-cookie",
    clearCloudflareOAuthDeliveryCookie(c.req.raw, returnKey),
  );
  return response;
});

app.delete("/api/cloudflare/connections/:connectionId", async (c) => {
  try {
    const body = await readJson(c);
    if (
      !isRecord(body) ||
      typeof body.shipletId !== "string" ||
      body.approval !== true
    ) {
      return json(
        { ok: false, code: "explicit_revocation_approval_required" },
        428,
      );
    }
    const connectionId = c.req.param("connectionId");
    if (!CLOUDFLARE_CONTROL_IDENTIFIER.test(connectionId)) {
      return json({ ok: false, code: "invalid_cloudflare_connection" }, 400);
    }
    const project = await getProjectById(c.env.DB, body.shipletId);
    if (!project) return c.text("Shiplet not found", 404);
    const access = await requireRevisionRouteAccess(c, project, "write");
    if (access.actor.kind !== "human") {
      return json({ ok: false, code: "human_approval_required" }, 403);
    }
    const connection = await c.env.DB.prepare(
      `SELECT connection.id, connection.user_id, connection.account_id,
				 connection.status, connection.generation
				 FROM cloudflare_connections connection
				 WHERE connection.id = ? AND connection.user_id = ?
				 AND EXISTS (
					SELECT 1 FROM deployment_targets target
					WHERE target.connection_id = connection.id
					AND target.project_id = ? AND target.owner_kind = 'human'
					AND target.owner_id = ?
				 ) LIMIT 1`,
    )
      .bind(connectionId, access.actor.id, project.id, access.actor.id)
      .first<{
        id: string;
        user_id: string;
        account_id: string;
        status: string;
        generation: number;
      }>();
    if (!connection) return c.text("Cloudflare connection not found", 404);
    const existingRevocation = await c.env.DB.prepare(
      `SELECT status FROM cloudflare_revocation_requests
       WHERE connection_id = ? AND project_id = ? AND user_id = ?
       LIMIT 1`,
    )
      .bind(connection.id, project.id, access.actor.id)
      .first<{ status: "pending" | "complete" }>();
    if (
      connection.status === "revoked" &&
      existingRevocation?.status !== "pending"
    ) {
      return json({
        ok: true,
        shipletId: project.id,
        connection: { id: connection.id, status: "revoked" },
        lastDeploymentContinues: true,
      });
    }
    const now = Date.now();
    const occurredOn = new Date(now).toISOString();
    if (connection.status !== "revoked") {
      await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE cloudflare_connections
					 SET status = 'revoked', revoked_at = ?
					 WHERE id = ? AND user_id = ? AND status = 'active'`,
        ).bind(now, connection.id, access.actor.id),
        c.env.DB.prepare(
          `UPDATE deployment_targets SET detached_on = ?
					 WHERE project_id = ? AND connection_id = ? AND detached_on IS NULL`,
        ).bind(occurredOn, project.id, connection.id),
        c.env.DB.prepare(
          `INSERT INTO cloudflare_revocation_requests (
             connection_id, project_id, user_id, account_id, status,
             requested_on, completed_on, last_failure_code
           ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)
           ON CONFLICT(connection_id) DO NOTHING`,
        ).bind(
          connection.id,
          project.id,
          access.actor.id,
          connection.account_id,
          occurredOn,
        ),
        c.env.DB.prepare(
          `INSERT INTO shiplet_audit_events (
					 id, project_id, revision_id, deployment_id, actor_kind, actor_id,
					 event_kind, summary, status_category, payload_json,
					 occurred_on, recorded_on
					) VALUES (?, ?, NULL, NULL, 'human', ?,
					 'cloudflare.connection.revocation_requested',
					 'Customer Cloudflare access revoked', 'resolved', ?, ?, ?)`,
        ).bind(
          `audit_${crypto.randomUUID()}`,
          project.id,
          access.actor.id,
          JSON.stringify({
            connectionId: connection.id,
            accountId: connection.account_id,
          }),
          occurredOn,
          occurredOn,
        ),
      ]);
    }
    const runtime = c.env as DeploymentRuntimeEnv;
    const controlPlane = runtime.CLOUDFLARE_OAUTH_CONTROL_PLANE;
    if (!controlPlane?.revoke) {
      await c.env.DB.prepare(
        `UPDATE cloudflare_revocation_requests
         SET last_failure_code = 'cloudflare_oauth_prerequisite'
         WHERE connection_id = ? AND status = 'pending'`,
      )
        .bind(connection.id)
        .run();
      return json(
        {
          ok: false,
          code: "cloudflare_oauth_prerequisite",
          accessRevokedLocally: true,
        },
        503,
      );
    }
    const supportReadiness = await cloudflareSupportMutationReadiness(runtime);
    if (!supportReadiness.ok) {
      const failureCode =
        cloudflareSupportMutationFailureCode(supportReadiness);
      await c.env.DB.prepare(
        `UPDATE cloudflare_revocation_requests
         SET last_failure_code = ?
         WHERE connection_id = ? AND status = 'pending'`,
      )
        .bind(failureCode, connection.id)
        .run();
      return json(
        {
          ok: false,
          code: failureCode,
          accessRevokedLocally: true,
        },
        503,
      );
    }
    const result = await controlPlane.revoke(
      {
        actor: Object.freeze({ kind: "human", id: access.actor.id }),
        connectionId: connection.id,
        sessionBinding: await cloudflareOAuthSessionBinding({
          request: c.req.raw,
          env: c.env,
          userId: access.actor.id,
        }),
      },
      cloudflareSupportExpectation(runtime, "control_plane"),
    );
    if (!result.ok) {
      await c.env.DB.prepare(
        `UPDATE cloudflare_revocation_requests
         SET last_failure_code = 'cloudflare_revocation_cleanup_required'
         WHERE connection_id = ? AND status = 'pending'`,
      )
        .bind(connection.id)
        .run();
      return json(
        {
          ok: false,
          code: "cloudflare_revocation_cleanup_required",
          accessRevokedLocally: true,
        },
        502,
      );
    }
    if (
      result.connection.id !== connection.id ||
      result.connection.userId !== access.actor.id ||
      result.connection.accountId !== connection.account_id ||
      result.connection.status !== "revoked" ||
      !Number.isSafeInteger(result.connection.generation) ||
      result.connection.generation <= connection.generation
    ) {
      await c.env.DB.prepare(
        `UPDATE cloudflare_revocation_requests
         SET last_failure_code = 'cloudflare_revocation_reconciliation_required'
         WHERE connection_id = ? AND status = 'pending'`,
      )
        .bind(connection.id)
        .run();
      return json(
        {
          ok: false,
          code: "cloudflare_revocation_reconciliation_required",
          accessRevokedLocally: true,
        },
        502,
      );
    }
    const completedOn = new Date().toISOString();
    const completion = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE cloudflare_revocation_requests
         SET status = 'complete', completed_on = ?, last_failure_code = NULL
         WHERE connection_id = ? AND project_id = ? AND user_id = ?
           AND status = 'pending'`,
      ).bind(completedOn, connection.id, project.id, access.actor.id),
      c.env.DB.prepare(
        `INSERT INTO shiplet_audit_events (
           id, project_id, revision_id, deployment_id, actor_kind, actor_id,
           event_kind, summary, status_category, payload_json,
           occurred_on, recorded_on
         ) VALUES (?, ?, NULL, NULL, 'human', ?,
           'cloudflare.connection.revocation_reconciled',
           'Customer Cloudflare provider access revoked', 'resolved', ?, ?, ?)`,
      ).bind(
        `audit_${crypto.randomUUID()}`,
        project.id,
        access.actor.id,
        JSON.stringify({
          connectionId: connection.id,
          accountId: connection.account_id,
          generation: result.connection.generation,
        }),
        completedOn,
        completedOn,
      ),
    ]);
    if (completion[0]?.meta.changes !== 1) {
      return json(
        {
          ok: false,
          code: "cloudflare_revocation_reconciliation_required",
          accessRevokedLocally: true,
        },
        502,
      );
    }
    const response = json({
      ok: true,
      shipletId: project.id,
      connection: { id: connection.id, status: "revoked" },
      lastDeploymentContinues: true,
    });
    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return json({ ok: false, code: "cloudflare_revocation_failed" }, 500);
  }
});

app.post("/api/projects/archive", async (c) => {
  try {
    const body = (await readJson(c)) as { projectIds?: unknown };
    const rawProjectIds = Array.isArray(body.projectIds) ? body.projectIds : [];
    const projectIds: string[] = Array.from(
      new Set(
        rawProjectIds
          .map((projectId: unknown) => String(projectId || "").trim())
          .filter(Boolean),
      ),
    );
    if (projectIds.length === 0) {
      return c.text("Missing required field: projectIds", 400);
    }

    const archived: Project[] = [];
    for (const projectId of projectIds) {
      const project = await getProjectById(c.env.DB, projectId);
      if (!project) return c.text("Shiplet not found", 404);
      await requireArchiveProjectAccess(c, project);
      const nextProject = await archiveProject(c.env.DB, project.id);
      if (nextProject) archived.push(nextProject);
    }

    return json({ archived });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to archive shiplets: ${message}`, 500);
  }
});

app.post("/api/projects/:projectId/archive", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    await requireArchiveProjectAccess(c, project);
    return json({ project: await archiveProject(c.env.DB, project.id) });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to archive shiplet: ${message}`, 500);
  }
});

app.post("/api/projects/:projectId/restore", async (c) => {
  try {
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    await requireArchiveProjectAccess(c, project);
    return json({ project: await restoreProject(c.env.DB, project.id) });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to restore shiplet: ${message}`, 500);
  }
});

app.delete("/api/projects/:projectId", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    requireProjectOwner(project, user);
    if (!project.archived_on) {
      return c.text("Archive shiplet before permanently deleting it.", 409);
    }

    const body = await readJson(c);
    if (String(body.confirmSubdomain || "") !== project.subdomain) {
      return c.text("Type the shiplet subdomain to confirm deletion.", 400);
    }

    await deleteProjectPermanently(c.env, project);
    return json({ deleted: true, projectId: project.id });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to permanently delete shiplet: ${message}`, 500);
  }
});

app.get("/api/notifications", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const url = new URL(c.req.url);
    return json({
      notifications: await listNotificationsForUser(c.env.DB, user, {
        unreadOnly: url.searchParams.get("unreadOnly") === "true",
        limit: Number(url.searchParams.get("limit") || 100),
      }),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list notifications: ${message}`, 500);
  }
});

app.post("/api/notifications/:notificationId/read", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const notification = await markNotificationRead(
      c.env.DB,
      user,
      c.req.param("notificationId"),
    );
    if (!notification) return c.text("Notification not found", 404);
    return json({ notification });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to update notification: ${message}`, 500);
  }
});

app.get("/api/feedback", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const url = new URL(c.req.url);
    const feedback = await listAccessibleReviewFeedback(c.env.DB, user, {
      projectId: url.searchParams.get("projectId"),
      status: url.searchParams.get("status"),
      mentionedMe: url.searchParams.get("mentionedMe") === "true",
      watched: url.searchParams.get("watched") === "true",
      submittedByMe: url.searchParams.get("submittedByMe") === "true",
      limit: Number(url.searchParams.get("limit") || 100),
    });
    return json({ feedback });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list feedback: ${message}`, 500);
  }
});

app.get("/shiplets/:projectId/custom-mcp/quarantine", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) {
      return customMcpApprovalHttpResponse(
        "Not found",
        404,
        "text/plain; charset=utf-8",
      );
    }
    if (!(await canEditProject(c.env.DB, project, user))) {
      return customMcpApprovalHttpResponse(
        "Editor access required",
        403,
        "text/plain; charset=utf-8",
      );
    }
    const now = Date.now();
    const references = await createD1CustomMcpQuarantineVault({
      db: c.env.DB,
      now: () => Date.now(),
    }).listActive({ shipletId: project.id, now, limit: 100 });
    const rows = references
      .map((reference) => {
        const label =
          reference.contentKind === "custom_mcp_description"
            ? "Tool description"
            : "Tool result";
        const releasePath = `/shiplets/${encodeURIComponent(project.id)}/custom-mcp/quarantine/${encodeURIComponent(reference.referenceId)}/release`;
        return `<li><strong>${label}</strong> from revision <code>${escapeCustomMcpApprovalText(reference.revisionId)}</code>; expires <time>${escapeCustomMcpApprovalText(new Date(reference.expiresAt).toISOString())}</time><form method="post" action="${releasePath}"><button type="submit">Review this held content once</button></form></li>`;
      })
      .join("");
    return customMcpApprovalHttpResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Held custom MCP content</title></head><body><main><h1>Held custom MCP content</h1><p>Package-authored descriptions and results stay out of MCP responses. An authorized human can reveal each item once on this trusted page.</p>${rows ? `<ul>${rows}</ul>` : "<p>No held content is available.</p>"}</main></body></html>`,
      200,
      "text/html; charset=utf-8",
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return customMcpApprovalHttpResponse(
      "Quarantine unavailable",
      503,
      "text/plain; charset=utf-8",
    );
  }
});

app.post(
  "/shiplets/:projectId/custom-mcp/quarantine/:referenceId/release",
  async (c) => {
    try {
      const user = await requireCurrentUser(c);
      const project = await getProjectById(c.env.DB, c.req.param("projectId"));
      if (!project) {
        return customMcpApprovalHttpResponse(
          "Not found",
          404,
          "text/plain; charset=utf-8",
        );
      }
      if (!(await canEditProject(c.env.DB, project, user))) {
        return customMcpApprovalHttpResponse(
          "Editor access required",
          403,
          "text/plain; charset=utf-8",
        );
      }
      if (
        c.req.header("sec-fetch-site") !== "same-origin" ||
        !isControlPlaneOrigin(
          c.env,
          c.req.url,
          c.req.header("origin") || null,
          {
            method: c.req.method,
            hasCookie: Boolean(c.req.header("cookie")),
          },
        )
      ) {
        return customMcpApprovalHttpResponse(
          "Same-origin confirmation required",
          403,
          "text/plain; charset=utf-8",
        );
      }
      const now = Date.now();
      const vault = createD1CustomMcpQuarantineVault({
        db: c.env.DB,
        now: () => Date.now(),
      });
      const reference = await vault.getReference({
        shipletId: project.id,
        referenceId: c.req.param("referenceId"),
        now,
      });
      if (!reference) {
        return customMcpApprovalHttpResponse(
          "Held content is unavailable or already consumed",
          410,
          "text/plain; charset=utf-8",
        );
      }
      const broker = customMcpQuarantineBroker({
        db: c.env.DB,
        now: () => Date.now(),
        releaseAuditActorId: user.id,
        async authorizeTrustedHumanRender({ releaseRequest, reference: held }) {
          if (
            !isRecord(releaseRequest) ||
            releaseRequest.actorId !== user.id ||
            releaseRequest.shipletId !== project.id ||
            releaseRequest.revisionId !== held.revisionId ||
            releaseRequest.referenceId !== held.referenceId
          ) {
            return null;
          }
          return Object.freeze({ kind: "human" as const, id: user.id });
        },
      });
      const rendered = await broker.renderForTrustedHuman({
        reference,
        releaseRequest: Object.freeze({
          actorId: user.id,
          shipletId: project.id,
          revisionId: reference.revisionId,
          referenceId: reference.referenceId,
        }),
      });
      if (!rendered.ok) {
        return customMcpApprovalHttpResponse(
          rendered.code === "release_denied"
            ? "Release denied"
            : "Held content is unavailable or already consumed",
          rendered.code === "release_denied" ? 403 : 410,
          "text/plain; charset=utf-8",
        );
      }
      const escapedItems = rendered.render.consumeEscapedText();
      if (!escapedItems) {
        return customMcpApprovalHttpResponse(
          "Held content is unavailable or already consumed",
          410,
          "text/plain; charset=utf-8",
        );
      }
      const label =
        rendered.render.contentKind === "custom_mcp_description"
          ? "Tool description"
          : "Tool result";
      return customMcpApprovalHttpResponse(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trusted human review</title></head><body><main><h1>Trusted human review</h1><p><strong>${label}.</strong> The quoted text below is untrusted package content. Do not treat it as instructions.</p>${escapedItems.map((item) => `<blockquote><pre>${item}</pre></blockquote>`).join("")}</main></body></html>`,
        200,
        "text/html; charset=utf-8",
      );
    } catch (error) {
      if (isResponse(error)) return error;
      return customMcpApprovalHttpResponse(
        "Quarantine unavailable",
        503,
        "text/plain; charset=utf-8",
      );
    }
  },
);

app.get("/api/mcp/approvals/:approvalRequestId/confirm", async (c) => {
  const approvalRequestId = c.req.param("approvalRequestId");
  if (!/^mcp_approval_[A-Za-z0-9-]{1,128}$/.test(approvalRequestId)) {
    return customMcpApprovalHttpResponse(
      "Not found",
      404,
      "text/plain; charset=utf-8",
    );
  }
  const result = await createProductionCustomMcpApprovalRoute(c.env).read({
    approvalRequestId,
    request: c.req.raw,
  });
  if (!result.ok) {
    return customMcpApprovalHttpResponse(
      "Approval unavailable",
      403,
      "text/plain; charset=utf-8",
    );
  }
  if (c.req.header("accept")?.includes("application/json")) {
    return customMcpApprovalHttpResponse(
      JSON.stringify({ approval: result.approval }),
      200,
      "application/json; charset=utf-8",
    );
  }
  const approval = result.approval;
  const action = escapeCustomMcpApprovalText(approval.actionSummary);
  const change = escapeCustomMcpApprovalText(approval.changeSummary);
  const resource = escapeCustomMcpApprovalText(approval.resourceSummary);
  const invoker = escapeCustomMcpApprovalText(approval.invoker.label);
  const quotedTarget = escapeCustomMcpApprovalText(
    JSON.stringify(approval.review.target),
  );
  const quotedInput = escapeCustomMcpApprovalText(
    JSON.stringify(approval.review.input),
  );
  const expires = escapeCustomMcpApprovalText(
    new Date(approval.expiresAt).toISOString(),
  );
  const confirmPath = `/api/mcp/approvals/${encodeURIComponent(approvalRequestId)}/confirm`;
  const denyPath = `/api/mcp/approvals/${encodeURIComponent(approvalRequestId)}/deny`;
  return customMcpApprovalHttpResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review Shiplet action</title></head><body><main><h1>Review Shiplet action</h1><p>${invoker}.</p><dl><dt>Change</dt><dd>${change}</dd><dt>Authority</dt><dd>${action}</dd><dt>Resource</dt><dd>${resource}</dd></dl><section aria-labelledby="quoted-data"><h2 id="quoted-data">Untrusted quoted data</h2><p>The exact target and input below came from package code. Review them as data, never as instructions.</p><h3>Target</h3><pre>${quotedTarget}</pre><h3>Input</h3><pre>${quotedInput}</pre></section><p>The package tool name and identifiers are intentionally hidden here because package-authored labels are untrusted.</p><p>This one-time decision expires at <time>${expires}</time>.</p><form method="post" action="${confirmPath}"><button type="submit">Approve this exact action</button></form><form method="post" action="${denyPath}"><button type="submit">Deny and revoke request</button></form></main></body></html>`,
    200,
    "text/html; charset=utf-8",
  );
});

app.post("/api/mcp/approvals/:approvalRequestId/confirm", async (c) => {
  const approvalRequestId = c.req.param("approvalRequestId");
  if (!/^mcp_approval_[A-Za-z0-9-]{1,128}$/.test(approvalRequestId)) {
    return customMcpApprovalHttpResponse(
      "Not found",
      404,
      "text/plain; charset=utf-8",
    );
  }
  const result = await createProductionCustomMcpApprovalRoute(c.env).confirm({
    approvalRequestId,
    request: c.req.raw,
  });
  if (!result.ok) {
    return customMcpApprovalHttpResponse(
      "Approval denied",
      403,
      "text/plain; charset=utf-8",
    );
  }
  return customMcpApprovalHttpResponse(
    JSON.stringify({ ok: true }),
    200,
    "application/json; charset=utf-8",
  );
});

app.post("/api/mcp/approvals/:approvalRequestId/deny", async (c) => {
  const approvalRequestId = c.req.param("approvalRequestId");
  if (!/^mcp_approval_[A-Za-z0-9-]{1,128}$/.test(approvalRequestId)) {
    return customMcpApprovalHttpResponse(
      "Not found",
      404,
      "text/plain; charset=utf-8",
    );
  }
  const result = await createProductionCustomMcpApprovalRoute(c.env).deny({
    approvalRequestId,
    request: c.req.raw,
  });
  if (!result.ok) {
    return customMcpApprovalHttpResponse(
      "Denial unavailable",
      403,
      "text/plain; charset=utf-8",
    );
  }
  return customMcpApprovalHttpResponse(
    JSON.stringify({ ok: true }),
    200,
    "application/json; charset=utf-8",
  );
});

async function authorizedKernelApproval(c: any) {
  const approvalRequestId = c.req.param("approvalRequestId");
  if (!/^mcp_kernel_approval_[A-Za-z0-9-]{1,128}$/.test(approvalRequestId)) {
    return null;
  }
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) return null;
  const approval = await createD1KernelApprovalService({
    db: c.env.DB,
  }).read(approvalRequestId);
  if (!approval || approval.subjectUserId !== user.id) return null;
  const project = await getProjectById(c.env.DB, approval.projectId);
  if (!project || !(await canEditProject(c.env.DB, project, user))) return null;
  return Object.freeze({ approval, user, project });
}

function kernelApprovalSameOrigin(c: any) {
  return (
    c.req.header("sec-fetch-site") === "same-origin" &&
    isControlPlaneOrigin(c.env, c.req.url, c.req.header("origin"), {
      method: c.req.method,
      hasCookie: Boolean(c.req.header("cookie")),
    })
  );
}

app.get("/api/mcp/kernel-approvals/:approvalRequestId", async (c) => {
  const authorized = await authorizedKernelApproval(c);
  if (!authorized) {
    return customMcpApprovalHttpResponse(
      "Approval unavailable",
      403,
      "text/plain; charset=utf-8",
    );
  }
  const { approval } = authorized;
  if (approval.status !== "pending") {
    return customMcpApprovalHttpResponse(
      "Approval is no longer pending",
      410,
      "text/plain; charset=utf-8",
    );
  }
  if (c.req.header("accept")?.includes("application/json")) {
    return customMcpApprovalHttpResponse(
      JSON.stringify({
        approval: {
          id: approval.id,
          action: approval.action,
          resourceId: approval.resourceId,
          expiresAt: approval.expiresAt,
          status: approval.status,
        },
      }),
      200,
      "application/json; charset=utf-8",
    );
  }
  const action =
    approval.action === "revision.promote"
      ? "Promote this validated draft"
      : "Roll back to this known-good revision";
  const resource = escapeCustomMcpApprovalText(approval.resourceId);
  const expires = escapeCustomMcpApprovalText(
    new Date(approval.expiresAt).toISOString(),
  );
  const confirmPath = `/api/mcp/kernel-approvals/${encodeURIComponent(approval.id)}/confirm`;
  const denyPath = `/api/mcp/kernel-approvals/${encodeURIComponent(approval.id)}/deny`;
  return customMcpApprovalHttpResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review delegated Shiplet action</title></head><body><main><h1>Review delegated Shiplet action</h1><p>An OAuth-connected agent requested a kernel-owned change. The agent cannot approve this request itself.</p><dl><dt>Action</dt><dd>${action}</dd><dt>Bound resource</dt><dd><code>${resource}</code></dd><dt>Expires</dt><dd><time>${expires}</time></dd></dl><form method="post" action="${confirmPath}"><button type="submit">Approve this exact action</button></form><form method="post" action="${denyPath}"><button type="submit">Deny request</button></form></main></body></html>`,
    200,
    "text/html; charset=utf-8",
  );
});

async function decideKernelApproval(c: any, decision: "approved" | "denied") {
  if (!kernelApprovalSameOrigin(c)) {
    return customMcpApprovalHttpResponse(
      "Approval denied",
      403,
      "text/plain; charset=utf-8",
    );
  }
  const authorized = await authorizedKernelApproval(c);
  if (!authorized) {
    return customMcpApprovalHttpResponse(
      "Approval denied",
      403,
      "text/plain; charset=utf-8",
    );
  }
  const approval = await createD1KernelApprovalService({
    db: c.env.DB,
  }).decide({
    id: authorized.approval.id,
    subjectUserId: authorized.user.id,
    decision,
  });
  if (!approval) {
    return customMcpApprovalHttpResponse(
      "Approval unavailable",
      409,
      "text/plain; charset=utf-8",
    );
  }
  return customMcpApprovalHttpResponse(
    JSON.stringify({ ok: true, status: approval.status }),
    200,
    "application/json; charset=utf-8",
  );
}

app.post("/api/mcp/kernel-approvals/:approvalRequestId/confirm", (c) =>
  decideKernelApproval(c, "approved"),
);

app.post("/api/mcp/kernel-approvals/:approvalRequestId/deny", (c) =>
  decideKernelApproval(c, "denied"),
);

app.post("/api/mcp", async (c) => {
  try {
    const contentLength = Number(c.req.header("content-length") || "0");
    if (contentLength > MAX_MCP_REQUEST_BYTES) {
      return c.text("MCP request is too large", 413);
    }
    let body: unknown;
    try {
      const text = await readRequestTextWithLimit(
        c.req.raw,
        MAX_MCP_REQUEST_BYTES,
      );
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      if (isResponse(error) && error.status === 413) {
        return c.text("MCP request is too large", 413);
      }
      return mcpError(null, -32700, "Parse error");
    }
    const appUrl = appBaseUrl(c.env, c.req.url);
    const authorization = c.req.header("authorization");
    const token = await authenticateOrganizationApiToken(
      c.env.DB,
      authorization,
    );
    if (token) {
      requireOrganizationApiScope(token, "mcp");
      return handleCodeModeMcpRequest(
        c.env,
        c.var.db,
        { kind: "token", token },
        c.req.raw,
        body,
      );
    }

    const oauthPrincipal = await authenticateMcpOAuthPrincipal(
      c.env,
      c.req.raw,
      { appUrl },
    );
    if (oauthPrincipal) {
      if (
        oauthPrincipal.credentialKind === "agent_registration" &&
        !oauthPrincipal.permissions.includes("mcp")
      ) {
        throw new Response("Registered agent is missing required permission: mcp", {
          status: 403,
        });
      }
      return handleCodeModeMcpRequest(
        c.env,
        c.var.db,
        { kind: "oauth_agent", principal: oauthPrincipal },
        c.req.raw,
        body,
      );
    }

    const oauthUser = await authenticateMcpOAuthUser(c.env, c.req.raw, appUrl);
    if (oauthUser) {
      return handlePlatformMcpRequest(
        c.env,
        c.var.db,
        oauthUser,
        c.req.raw,
        body,
      );
    }

    if (hasExplicitAuthorization(authorization)) {
      return mcpAuthorizationRequiredResponse(appUrl);
    }

    const user = await getCurrentUser(c.req.raw, c.env);
    if (!user) return mcpAuthorizationRequiredResponse(appUrl);
    return handlePlatformMcpRequest(c.env, c.var.db, user, c.req.raw, body);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to handle platform MCP request: ${message}`, 500);
  }
});

app.get("/api/review/client.js", () => {
  return new Response(reviewClientScript(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});

app.get("/api/review/host.js", () => {
  return new Response(trustedReviewHostScript(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/api/review/artifact-bridge.js", () => {
  return new Response(trustedArtifactBridgeScript(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
});

app.get("/api/review/host.css", () => {
  return new Response(trustedReviewHostStyles(), {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
});

app.post("/api/bootstrap/production-test", async (c) => {
  try {
    await requireBootstrapAccess(c);
    const body = await readJson(c);
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return c.text("Missing required field: email", 400);
    }

    const timestamp = Date.now();
    const bootstrapUserId = "user_shiplet_bootstrap";
    await upsertUser(c.env.DB, {
      id: bootstrapUserId,
      email: "bootstrap@shiplet.local",
      firstName: "Shiplet",
      lastName: "Bootstrap",
    });

    const organization = await createWorkOSOrganization(
      c.env,
      `Shiplet Production Test ${timestamp}`,
    );
    await createOrganizationRecord(c.env.DB, {
      id: organization.id,
      name: organization.name,
      created_by_user_id: bootstrapUserId,
      created_on: timestamps.now(),
    });
    const bootstrapMembershipId = `om_${organization.id}_${bootstrapUserId}`;
    await createOrganizationMembershipRecord(c.env.DB, {
      id: bootstrapMembershipId,
      organization_id: organization.id,
      user_id: bootstrapUserId,
      role: "admin",
      created_on: timestamps.now(),
    });

    const workosTeam = await createWorkOSTeam(c.env, {
      organizationId: organization.id,
      name: `Review Team ${timestamp}`,
      description: "Production smoke-test reviewers",
    });
    const team = await createTeamRecord(c.env.DB, {
      id: workosTeam.id,
      organization_id: organization.id,
      name: workosTeam.name,
      description: workosTeam.description || null,
      created_by_user_id: bootstrapUserId,
      created_on: timestamps.now(),
    });
    await createTeamMembership(
      c.env.DB,
      team.id,
      bootstrapUserId,
      bootstrapMembershipId,
    );

    const project: Project = {
      id: newId("project"),
      organization_id: organization.id,
      owner_user_id: bootstrapUserId,
      name: `Review Smoke Test ${timestamp}`,
      subdomain: `shiplet-smoke-${timestamp.toString(36)}`,
      custom_hostname: null,
      script_content: "/* Static production smoke test stored in D1 */",
      visibility: "private",
      created_on: new Date().toISOString(),
      modified_on: new Date().toISOString(),
    };
    const indexHtml = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>Shiplet Review Smoke Test</title>
		<style>
			body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
			main { width: min(760px, calc(100vw - 32px)); background: white; border: 1px solid #dbe3ef; border-radius: 8px; padding: 28px; box-shadow: 0 12px 40px rgba(15, 23, 42, .08); }
			h1 { margin: 0 0 10px; font-size: 28px; }
			p { margin: 0; color: #475569; line-height: 1.6; }
		</style>
	</head>
	<body>
		<main>
			<h1>Shiplet production smoke test</h1>
			<p>This static shiplet is served from Cloudflare Worker + D1 fallback and should receive the review overlay for authenticated invitees.</p>
		</main>
	</body>
</html>`;
    await CreateProject(c.var.db, project);
    await storeStaticAssets(c.env.DB, c.env.SHIPLET_ASSETS, project.id, [
      {
        path: "index.html",
        content: btoa(indexHtml),
        size: indexHtml.length,
      },
    ]);

    await createShipletGrant(c.env.DB, {
      id: newId("grant"),
      project_id: project.id,
      organization_id: organization.id,
      target_type: "team",
      target_id: team.id,
      role: "reviewer",
      invited_by_user_id: bootstrapUserId,
      created_on: timestamps.now(),
    });

    const workosInvitation = await sendWorkOSInvitation(c.env, {
      email,
      organizationId: organization.id,
      roleSlug: "member",
    });
    const invitation = await createAppInvitation(c.env.DB, {
      id: newId("appinv"),
      organization_id: organization.id,
      team_id: team.id,
      project_id: project.id,
      email,
      invite_type: "production_test",
      role: "reviewer",
      status: "pending",
      invited_by_user_id: bootstrapUserId,
      workos_invitation_id: workosInvitation.id,
      workos_invitation_token: workosInvitation.token || null,
      created_on: timestamps.now(),
    });

    return json(
      {
        ok: true,
        organization,
        team,
        project,
        invitation: {
          id: invitation.id,
          email: invitation.email,
          invite_type: invitation.invite_type,
          workos_invitation_id: invitation.workos_invitation_id,
        },
        shipletUrl: artifactPublicUrl(c.env, c.req.url, project),
      },
      201,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to bootstrap production test: ${message}`, 500);
  }
});

app.post("/api/bootstrap/reconcile-invitation", async (c) => {
  try {
    await requireBootstrapAccess(c);
    const body = (await readJson(c)) as Record<string, unknown>;
    const rawInvitationId =
      typeof body.invitationId === "string" ? body.invitationId.trim() : "";
    const appInvitationId =
      typeof body.appInvitationId === "string"
        ? body.appInvitationId.trim()
        : rawInvitationId.startsWith("appinv_")
          ? rawInvitationId
          : "";
    const workosInvitationId =
      typeof body.workosInvitationId === "string"
        ? body.workosInvitationId.trim()
        : rawInvitationId && !rawInvitationId.startsWith("appinv_")
          ? rawInvitationId
          : "";
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!appInvitationId && !workosInvitationId && !email) {
      return c.text(
        "Missing one of appInvitationId, workosInvitationId, invitationId, or email",
        400,
      );
    }

    let pendingInvitations: AppInvitationRecord[] = [];
    if (appInvitationId) {
      pendingInvitations.push(
        ...(await findPendingInvitationById(c.env.DB, appInvitationId)),
      );
    }
    if (workosInvitationId) {
      pendingInvitations.push(
        ...(await findPendingInvitationsByWorkOSInvitationId(
          c.env.DB,
          workosInvitationId,
        )),
      );
    }
    if (email) {
      pendingInvitations.push(
        ...(await findPendingInvitationsByEmail(c.env.DB, email)),
      );
    }
    pendingInvitations = uniqueInvitations(pendingInvitations);

    if (pendingInvitations.length === 0) {
      return json({ ok: true, reconciled: 0, results: [] });
    }

    const results: Array<{ localInvitationId: string; state: string }> = [];
    let reconciled = 0;

    for (const pendingInvitation of pendingInvitations) {
      const workosInvitation = await getWorkOSInvitation(
        c.env,
        pendingInvitation.workos_invitation_id,
      );

      if (workosInvitation.state !== "accepted") {
        results.push({
          localInvitationId: pendingInvitation.id,
          state: workosInvitation.state || "unknown",
        });
        continue;
      }

      if (!workosInvitation.acceptedUserId) {
        results.push({
          localInvitationId: pendingInvitation.id,
          state: "accepted_without_user",
        });
        continue;
      }

      const workosUser = await getWorkOSUser(
        c.env,
        workosInvitation.acceptedUserId,
      );
      const reconciliation = await reconcilePendingInvitationsForUser(
        c.env,
        workosUser,
        {
          organizationId:
            workosInvitation.organizationId ||
            pendingInvitation.organization_id,
          pendingInvitations: [pendingInvitation],
        },
      );
      reconciled += reconciliation.reconciled;
      results.push({
        localInvitationId: pendingInvitation.id,
        state: "accepted",
      });
    }

    return json({ ok: true, reconciled, results });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to reconcile invitation: ${message}`, 500);
  }
});

/*
 * Main page - publish a shiplet
 */
app.get("/", async (c) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) {
    return c.html(
      renderPage(
        `<div class="auth-stage">
					<div class="auth-scene" aria-hidden="true">${HARBOR_SCENE_SVG}</div>
					<div class="form-container auth-card">
						<span class="success-card-label">Shiplet</span>
						<h1>Review any build, file, or live URL</h1>
						<p class="auth-card-copy">Shiplet puts a trusted review layer around the artifact so people can comment in context and agents can pick up the feedback.</p>
						<a class="link-btn" href="/auth/login">Prepare a review</a>
						<a class="btn btn-secondary" href="/play">Try the sandbox</a>
						<a class="auth-docs-link" href="/docs/why-shiplet">Docs</a>
					</div>
				</div>`,
        {
          nonce: kernelDocumentNonce(c),
          customDomain: c.env.CUSTOM_DOMAIN,
          appUrl: appBaseUrl(c.env, c.req.url),
          hideHeader: true,
        },
      ),
    );
  }

  const customDomain = c.env.CUSTOM_DOMAIN;
  return withNoIndexResponse(
    c.html(
      renderPage(
        BuildPlatformPublishPage({
          nonce: kernelDocumentNonce(c),
          user,
          customDomain,
        }),
        {
          nonce: kernelDocumentNonce(c),
          customDomain,
          appUrl: appBaseUrl(c.env, c.req.url),
          user,
        },
      ),
    ),
  );
});

async function renderPlatformSettingsRoute(c: any, route: SettingsRoute) {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) {
    return c.redirect(
      `/auth/login?return_to=${encodeURIComponent(`/${route}`)}`,
    );
  }

  return c.html(
    renderPage(
      BuildPlatformSettingsPage({
        nonce: kernelDocumentNonce(c),
        user,
        route,
      }),
      {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        user,
      },
    ),
  );
}

app.get("/settings", async (c) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) {
    return c.redirect(
      `/auth/login?return_to=${encodeURIComponent("/workspace")}`,
    );
  }
  return c.redirect("/workspace");
});

app.get("/workspace", async (c) => {
  return renderPlatformSettingsRoute(c, "workspace");
});

app.get("/account", async (c) => {
  return renderPlatformSettingsRoute(c, "account");
});

app.get("/access", async (c) => {
  return renderPlatformSettingsRoute(c, "access");
});

app.get("/agents", async (c) => {
  return renderPlatformSettingsRoute(c, "agents");
});

app.get("/shiplets", async (c) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) {
    return c.redirect(
      `/auth/login?return_to=${encodeURIComponent("/shiplets")}`,
    );
  }

  const organizations = await listOrganizationsForUser(c.env.DB, user.id);
  const projects = await listProjectsForUser(c.env.DB, user.id);
  const archivedProjects = await listProjectsForUser(c.env.DB, user.id, {
    archiveStatus: "archived",
  });
  return c.html(
    renderPage(
      BuildPlatformShipletsListPage({
        nonce: kernelDocumentNonce(c),
        organizations,
        projects,
        archivedProjects,
        customDomain: c.env.CUSTOM_DOMAIN,
      }),
      {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        user,
      },
    ),
  );
});

app.get("/inbox", async (c) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) {
    return c.redirect(`/auth/login?return_to=${encodeURIComponent("/inbox")}`);
  }

  const notifications = await listNotificationsForUser(c.env.DB, user, {
    limit: 100,
  });
  return c.html(
    renderPage(
      BuildPlatformInboxPage({
        nonce: kernelDocumentNonce(c),
        notifications,
      }),
      {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        user,
      },
    ),
  );
});

app.get("/feedback", async (c) => {
  const user = await getCurrentUser(c.req.raw, c.env);
  if (!user) {
    return c.redirect(
      `/auth/login?return_to=${encodeURIComponent("/feedback")}`,
    );
  }

  const url = new URL(c.req.url);
  const feedback = await listAccessibleReviewFeedback(c.env.DB, user, {
    projectId: url.searchParams.get("projectId"),
    status: url.searchParams.get("status"),
    mentionedMe: url.searchParams.get("mentionedMe") === "true",
    watched: url.searchParams.get("watched") === "true",
    submittedByMe: url.searchParams.get("submittedByMe") === "true",
    limit: Number(url.searchParams.get("limit") || 100),
  });
  return c.html(
    renderPage(
      BuildPlatformFeedbackPage({
        nonce: kernelDocumentNonce(c),
        feedback,
        filters: {
          projectId: url.searchParams.get("projectId"),
          status: url.searchParams.get("status"),
          mentionedMe: url.searchParams.get("mentionedMe") === "true",
          watched: url.searchParams.get("watched") === "true",
          submittedByMe: url.searchParams.get("submittedByMe") === "true",
        },
      }),
      {
        nonce: kernelDocumentNonce(c),
        customDomain: c.env.CUSTOM_DOMAIN,
        appUrl: appBaseUrl(c.env, c.req.url),
        user,
      },
    ),
  );
});

app.post("/shiplets/:projectId/restore", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    await requireProjectEditor(c, project, user);
    const restored = await restoreProject(c.env.DB, project.id);
    return c.redirect(
      artifactPublicUrl(c.env, c.req.url, restored || project),
      303,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to restore shiplet: ${message}`, 500);
  }
});

app.post("/api/shiplets/:projectId/ownership/actions", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (!(await canEditProject(c.env.DB, project, user))) {
      return c.text("Shiplet ownership access denied", 403);
    }
    const body = await readJson(c);
    if (!isRecord(body) || typeof body.action !== "string") {
      return json({ ok: false, code: "invalid_ownership_action" }, 400);
    }
    const plan = BuildOwnershipActionRequest({
      ...(body as Omit<OwnershipActionInput, "shipletId">),
      shipletId: project.id,
    });
    return json(plan);
  } catch (error) {
    if (isResponse(error)) return error;
    const code =
      error instanceof Error ? error.message : "invalid_ownership_action";
    return json(
      { ok: false, code },
      code === "trusted_approval_required" ||
        code === "cloudflare_policy_acceptance_required"
        ? 428
        : 400,
    );
  }
});

function renderOwnershipFailureResponse(
  c: any,
  input: {
    user: ShipletUser;
    status: 403 | 500;
    shipletId: string;
    shipletName?: string;
    viewState: "error" | "permission_denied";
    errorSummary?: string;
  },
) {
  const page = BuildOwnershipFailurePage({
    shipletId: input.shipletId,
    shipletName: input.shipletName,
    viewState: input.viewState,
    errorSummary: input.errorSummary,
  });
  return c.html(
    renderPage(page.body, {
      nonce: kernelDocumentNonce(c),
      customDomain: c.env.CUSTOM_DOMAIN,
      appUrl: appBaseUrl(c.env, c.req.url),
      user: input.user,
      title: page.title,
      description: page.description,
      indexing: "noindex",
    }),
    input.status,
  );
}

app.get("/shiplets/:projectId/ownership", async (c) => {
  let user: ShipletUser | null = null;
  let project: Project | null = null;
  try {
    user = await getCurrentUser(c.req.raw, c.env);
    if (!user) {
      const path = new URL(c.req.url).pathname;
      return c.redirect(`/auth/login?return_to=${encodeURIComponent(path)}`);
    }
    project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (!(await canViewProject(c.env.DB, project, user.id))) {
      return renderOwnershipFailureResponse(c, {
        user,
        status: 403,
        shipletId: project.id,
        viewState: "permission_denied",
      });
    }
    if (!(await canEditProject(c.env.DB, project, user))) {
      return renderOwnershipFailureResponse(c, {
        user,
        status: 403,
        shipletId: project.id,
        shipletName: project.name,
        viewState: "permission_denied",
      });
    }
    await migrateLegacyShipletRevision(
      c.env.DB,
      project.id,
      c.env.SHIPLET_ASSETS,
    );
    project = (await getProjectById(c.env.DB, project.id)) ?? project;
    const runtime = c.env as DeploymentRuntimeEnv;
    const supportReady = await cloudflareSupportEntrypointsReady(runtime);
    const cloudflareRuntime = supportReady
      ? resolveCloudflareRequestRuntime(runtime, user.id)
      : null;
    const model = await loadShipletOwnershipPageModel({
      db: c.env.DB,
      project,
      managedRuntime: await managedRuntimeForProject(c.env, project),
      managedWorkerAvailable: hasManagedAdvancedRuntime(c.env, user.id),
      cloudflareConnectAvailable: Boolean(
        supportReady && cloudflareOAuthControlPlaneForUser(runtime, user.id),
      ),
      temporaryClaimAvailable: Boolean(
        cloudflareRuntime?.deployment.temporaryReady &&
        cloudflareRuntime.claimVault,
      ),
    });
    const page = BuildShipletOwnershipPage(model);
    return c.html(
      renderPage(
        `${page.body}${BuildOwnershipController({
          nonce: kernelDocumentNonce(c),
          shipletId: project.id,
        })}`,
        {
          nonce: kernelDocumentNonce(c),
          customDomain: c.env.CUSTOM_DOMAIN,
          appUrl: appBaseUrl(c.env, c.req.url),
          user,
          title: page.title,
          description: page.description,
        },
      ),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    if (!user) return c.text("Failed to load Shiplet ownership", 500);
    return renderOwnershipFailureResponse(c, {
      user,
      status: 500,
      shipletId: project?.id ?? c.req.param("projectId"),
      shipletName: project?.name,
      viewState: "error",
      errorSummary:
        "Shiplet could not load ownership state. The active revision was not changed.",
    });
  }
});

app.get("/shiplets/:projectId/access", async (c) => {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(
        `/auth/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      );
    }

    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    const url = new URL(c.req.url);
    const returnTarget = projectArtifactReturnTarget(
      c.env,
      c.req.url,
      project,
      url.searchParams.get("return_to"),
    );
    if (await canViewProject(c.env.DB, project, user.id)) {
      if (returnTarget) {
        return c.redirect(
          await issueArtifactReturnAccessUrl(
            c.env,
            project,
            user,
            returnTarget,
          ),
        );
      }
      return c.redirect(`/shiplets/${encodeURIComponent(project.id)}`);
    }

    const request = await getShipletAccessRequest(
      c.env.DB,
      project.id,
      user.id,
    );
    return c.html(
      renderPage(
        BuildShipletAccessRequestPage({
          project,
          userEmail: user.email,
          request,
          returnTo: returnTarget?.toString() || null,
        }),
        {
          nonce: kernelDocumentNonce(c),
          customDomain: c.env.CUSTOM_DOMAIN,
          appUrl: appBaseUrl(c.env, c.req.url),
          user,
          title: `Request access to ${project.name}`,
          indexing: "noindex",
        },
      ),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load the access request.", 500);
  }
});

app.post("/shiplets/:projectId/access-requests", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);

    const body = await c.req.parseBody();
    const requestedReturnTo =
      typeof body.return_to === "string" ? body.return_to : null;
    const returnTarget = projectArtifactReturnTarget(
      c.env,
      c.req.url,
      project,
      requestedReturnTo,
    );
    if (await canViewProject(c.env.DB, project, user.id)) {
      if (returnTarget) {
        return c.redirect(
          await issueArtifactReturnAccessUrl(
            c.env,
            project,
            user,
            returnTarget,
          ),
          303,
        );
      }
      return c.redirect(`/shiplets/${encodeURIComponent(project.id)}`, 303);
    }

    const accessRequest = await createShipletAccessRequest(c.env.DB, {
      projectId: project.id,
      organizationId: project.organization_id,
      requester: user,
    });
    if (!accessRequest) {
      return c.text("Failed to record the access request.", 500);
    }

    const claimedRequest = await claimShipletAccessRequestEmail(
      c.env.DB,
      accessRequest.id,
    );
    if (claimedRequest) {
      const owner = project.owner_user_id
        ? await getUser(c.env.DB, project.owner_user_id)
        : null;
      if (owner) {
        await deliverShipletAccessRequestEmail(c.env, {
          request: claimedRequest,
          project,
          owner,
          manageUrl: new URL(
            `/shiplets/${encodeURIComponent(project.id)}`,
            appBaseUrl(c.env, c.req.url),
          ).toString(),
        });
      } else {
        await updateShipletAccessRequestEmailStatus(
          c.env.DB,
          claimedRequest.id,
          claimedRequest.updated_on,
          "failed",
          "owner_not_found",
        );
      }
    }

    const location = new URL(
      `/shiplets/${encodeURIComponent(project.id)}/access`,
      "https://shiplet.invalid",
    );
    if (returnTarget) {
      location.searchParams.set("return_to", returnTarget.toString());
    }
    return c.redirect(`${location.pathname}${location.search}`, 303);
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to request access.", 500);
  }
});

app.get("/shiplets/:projectId/review-layer/preview/:previewId", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (!(await canEditProject(c.env.DB, project, user))) {
      return c.text("Shiplet editor access required", 403);
    }
    await activeReviewLayerState(c.env, project, {
      kind: "human",
      id: user.id,
    });
    const preview = await shipletRootStub(
      c.env,
      project.id,
    ).readReviewLayerPreview({
      projectId: project.id,
      previewId: c.req.param("previewId"),
    });
    if (!preview || preview.applied) {
      return c.text("Review layer preview not found", 404);
    }
    const revision = await migrateLegacyShipletRevision(
      c.env.DB,
      project.id,
      c.env.SHIPLET_ASSETS,
    );
    return serveReviewLayerWidget(
      preview,
      project.id,
      revision.id,
      new URL(appBaseUrl(c.env, c.req.url)).origin,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load the review layer preview", 500);
  }
});

app.get("/shiplets/:projectId", async (c) => {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    if (!user) {
      const url = new URL(c.req.url);
      return c.redirect(
        `/auth/login?return_to=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
      );
    }
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (!(await canViewProject(c.env.DB, project, user.id))) {
      return c.redirect(`/shiplets/${encodeURIComponent(project.id)}/access`);
    }
    const canEditLifecycle = await canEditProject(c.env.DB, project, user);
    const url = new URL(c.req.url);
    const previewUrl = await dashboardArtifactPreviewUrl(
      c.env,
      c.req.url,
      project,
      user,
    );
    return c.html(
      renderPage(
        BuildShipletReviewPage({
          nonce: kernelDocumentNonce(c),
          project,
          artifactUrl: previewUrl,
          reviewUrl: previewUrl,
          previewUrl,
          created: url.searchParams.get("created") === "1",
          canEditLifecycle,
          canPermanentlyDelete: isProjectOwner(project, user.id),
        }),
        {
          nonce: kernelDocumentNonce(c),
          customDomain: c.env.CUSTOM_DOMAIN,
          appUrl: appBaseUrl(c.env, c.req.url),
          user,
        },
      ),
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load shiplet: ${message}`, 500);
  }
});

function trustedReviewRevisionId(project: Project): string {
  const activeRevisionId = (
    project as Project & { active_revision_id?: unknown }
  ).active_revision_id;
  return typeof activeRevisionId === "string" && activeRevisionId.length > 0
    ? activeRevisionId
    : `legacy_${project.id}`;
}

async function handleActiveReviewWidgetFrame(c: any, requestedPath?: string) {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (!(await canViewProject(c.env.DB, project, user?.id))) {
      return user
        ? c.text("Shiplet access denied", 403)
        : c.redirect(
            `/auth/login?return_to=${encodeURIComponent(new URL(c.req.url).pathname)}`,
          );
    }
    return serveActiveReviewWidget(
      c.env,
      project,
      c.req.param("revisionId"),
      new URL(appBaseUrl(c.env, c.req.url)).origin,
      requestedPath,
    );
  } catch {
    return c.text("Failed to load review widget", 503);
  }
}

app.get("/shiplets/:projectId/widget-frame/:revisionId", (c) =>
  handleActiveReviewWidgetFrame(c),
);
app.get("/shiplets/:projectId/widget-frame/:revisionId/", (c) =>
  handleActiveReviewWidgetFrame(c),
);
app.get("/shiplets/:projectId/widget-frame/:revisionId/*", (c) =>
  handleActiveReviewWidgetFrame(c, c.req.param("*")),
);

async function requireValidatedRevisionPreview(c: any): Promise<{
  project: Project;
  selector: RevisionPreviewSelector;
  access: RevisionRouteAccess;
}> {
  const project = await getProjectById(c.env.DB, c.req.param("projectId"));
  if (!project || project.archived_on) {
    throw new Response("Revision preview not found", { status: 404 });
  }
  const access = await requireRevisionRouteAccess(c, project, "read");
  const draftVersion = parseRevisionPreviewDraftVersion(
    c.req.param("draftVersion"),
  );
  if (!draftVersion) {
    throw new Response("Revision preview not found", { status: 404 });
  }
  const selector = {
    shipletId: project.id,
    draftId: c.req.param("draftId"),
    revisionId: c.req.param("revisionId"),
    draftVersion,
  };
  const binding = await c.env.DB.prepare(
    `SELECT draft.id
       FROM shiplet_drafts draft
       JOIN shiplet_revisions revision
         ON revision.id = draft.validated_revision_id
        AND revision.project_id = draft.project_id
      WHERE draft.id = ? AND draft.project_id = ?
        AND draft.version = ? AND draft.validation_state = 'validated'
        AND draft.validated_revision_id = ? AND revision.id = ?
      LIMIT 1`,
  )
    .bind(
      selector.draftId,
      selector.shipletId,
      selector.draftVersion,
      selector.revisionId,
      selector.revisionId,
    )
    .first();
  if (!binding) {
    throw new Response("Revision preview not found", { status: 404 });
  }
  return { project, selector, access };
}

async function handleValidatedRevisionPreviewHost(c: any) {
  try {
    const { project, selector, access } =
      await requireValidatedRevisionPreview(c);
    const appUrl = appBaseUrl(c.env, c.req.url);
    const path = revisionPreviewPath(selector);
    const widget = await revisionReviewWidget(
      c.env,
      project.id,
      selector.revisionId,
    );
    const host = createTrustedReviewHostResponse({
      shipletId: project.id,
      revisionId: selector.revisionId,
      title: `${project.name} revision preview`,
      artifactUrl: new URL(`${path}/artifact-frame/`, appUrl).toString(),
      widgetUrl: widget
        ? new URL(`${path}/widget-frame/`, appUrl).toString()
        : null,
      hostScriptUrl: new URL("/api/review/host.js", appUrl).toString(),
      confirmationUrl: new URL("/review/confirm", appUrl).toString(),
      reviewApiUrl: new URL(
        `/api/projects/${encodeURIComponent(project.id)}/review-feedback`,
        appUrl,
      ).toString(),
      reviewPageUrl: new URL(path, appUrl).toString(),
    });
    const response = addTrustedRevisionPreviewContext(host, selector);
    if (access.actor.kind === "human") {
      await recordRevisionPreviewReceipt({
        db: c.env.DB,
        ...selector,
        actor: access.actor,
        sessionBindingDigest: await revisionPreviewSessionBinding({
          request: c.req.raw,
          env: c.env,
          userId: access.actor.id,
        }),
      });
    }
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load revision preview", 500);
  }
}

const REVISION_PREVIEW_ROUTE =
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview";

app.get(REVISION_PREVIEW_ROUTE, handleValidatedRevisionPreviewHost);

const REVISION_PREVIEW_RECEIPT_ROUTE =
  "/api/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview-receipt";

app.get(REVISION_PREVIEW_RECEIPT_ROUTE, async (c) => {
  try {
    const { selector, access } = await requireValidatedRevisionPreview(c);
    if (access.actor.kind !== "human") {
      return c.text("Revision preview receipt not found", 404);
    }
    const receipt = await loadRevisionPreviewReceipt({
      db: c.env.DB,
      ...selector,
      actor: access.actor,
      sessionBindingDigest: await revisionPreviewSessionBinding({
        request: c.req.raw,
        env: c.env,
        userId: access.actor.id,
      }),
    });
    return receipt
      ? json(receipt)
      : c.text("Revision preview receipt not found", 404);
  } catch (error) {
    if (
      isResponse(error) &&
      error.status === 403 &&
      c.req.header("authorization")
    ) {
      return error;
    }
    if (isResponse(error) && [403, 404].includes(error.status)) {
      return c.text("Revision preview receipt not found", 404);
    }
    if (isResponse(error)) return error;
    return c.text("Failed to load revision preview receipt", 500);
  }
});

function revisionPreviewFramePath(c: any) {
  const suffix = String(c.req.param("*") || "").replace(/^\/+/, "");
  if (!suffix) return "/";
  return `/${suffix}`;
}

async function handleValidatedRevisionArtifactFrame(c: any) {
  try {
    const { project, selector, access } =
      await requireValidatedRevisionPreview(c);
    const assetPath = revisionPreviewFramePath(c);
    const artifactUrl = new URL(c.req.url);
    artifactUrl.pathname = assetPath;
    artifactUrl.search = "";
    const artifactRequest = new Request(artifactUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
    });
    const packageValue = await storedRevisionPackage(
      c.env,
      project.id,
      selector.revisionId,
    );
    const response =
      packageValue?.manifest?.staticFirst === false
        ? await serveValidatedManagedRuntimeArtifact(
            c.env,
            project,
            selector.revisionId,
            artifactRequest,
            access.actor.kind === "human" ? access.actor.id : undefined,
          )
        : await serveRevisionStaticArtifact(
            c.env,
            project,
            selector.revisionId,
            artifactRequest,
          );
    if (!response) return c.text("Revision artifact not found", 404);
    if (
      response.status < 200 ||
      response.status >= 300 ||
      response.body === null
    ) {
      return response;
    }
    const prefix = `${revisionPreviewPath(selector)}/artifact-frame`;
    const bridged = await injectReviewClient(
      c.env,
      artifactRequest,
      response,
      project,
      null,
      { rootAssetPrefix: prefix },
    );
    const sandboxed = createSandboxedArtifactResponse({
      body: bridged.body!,
      contentType:
        bridged.headers.get("content-type") || "application/octet-stream",
      role: "artifact",
      trustedHostOrigin: new URL(appBaseUrl(c.env, c.req.url)).origin,
      status: bridged.status,
      sourceHeaders: bridged.headers,
    });
    sandboxed.headers.set("x-shiplet-revision", selector.revisionId);
    sandboxed.headers.set("cache-control", "private, no-store, no-transform");
    return sandboxed;
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load revision artifact", 500);
  }
}

async function handleValidatedRevisionWidgetFrame(c: any) {
  try {
    const { project, selector } = await requireValidatedRevisionPreview(c);
    const response = await serveRevisionReviewWidget(
      c.env,
      project,
      selector.revisionId,
      new URL(appBaseUrl(c.env, c.req.url)).origin,
      revisionPreviewFramePath(c),
    );
    response.headers.set("cache-control", "private, no-store, no-transform");
    return response;
  } catch (error) {
    if (isResponse(error)) return error;
    return c.text("Failed to load revision widget", 500);
  }
}

app.get(
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview/artifact-frame",
  (c) => handleValidatedRevisionArtifactFrame(c),
);
app.get(
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview/artifact-frame/",
  (c) => handleValidatedRevisionArtifactFrame(c),
);
app.get(
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview/artifact-frame/*",
  (c) => handleValidatedRevisionArtifactFrame(c),
);
app.get(
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview/widget-frame",
  (c) => handleValidatedRevisionWidgetFrame(c),
);
app.get(
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview/widget-frame/",
  (c) => handleValidatedRevisionWidgetFrame(c),
);
app.get(
  "/shiplets/:projectId/drafts/:draftId/revisions/:revisionId/versions/:draftVersion/preview/widget-frame/*",
  (c) => handleValidatedRevisionWidgetFrame(c),
);

app.get("/shiplets/:projectId/review-host", async (c) => {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (project.archived_on)
      return archivedShipletPageResponse(c, project, user);
    if (!(await canViewProject(c.env.DB, project, user?.id))) {
      return user
        ? c.redirect(`/shiplets/${encodeURIComponent(project.id)}/access`)
        : c.redirect(
            `/auth/login?return_to=${encodeURIComponent(new URL(c.req.url).pathname)}`,
          );
    }
    const appUrl = appBaseUrl(c.env, c.req.url);
    const widget = await activeReviewWidget(c.env, project);
    const artifactUrl = await dashboardReviewHostArtifactUrl(
      c.env,
      c.req.url,
      project,
    );
    return attachArtifactAccessCookie(
      createTrustedReviewHostResponse({
        shipletId: project.id,
        revisionId: trustedReviewRevisionId(project),
        title: project.name,
        artifactUrl,
        widgetUrl: widget
          ? new URL(
              `/shiplets/${encodeURIComponent(project.id)}/widget-frame/${encodeURIComponent(widget.revisionId)}/`,
              appUrl,
            ).toString()
          : null,
        hostScriptUrl: new URL("/api/review/host.js", appUrl).toString(),
        confirmationUrl: new URL("/review/confirm", appUrl).toString(),
        reviewApiUrl: new URL(
          `/api/projects/${encodeURIComponent(project.id)}/review-feedback`,
          appUrl,
        ).toString(),
        reviewPageUrl: artifactAbsoluteUrl(c.env, c.req.url, project),
        allowArtifactDownloads: standalonePreviewDownloadsAllowed(project),
      }),
      c.env,
      c.req.url,
      project,
      user,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load trusted review host: ${message}`, 500);
  }
});

async function handleSandboxedArtifactFrame(c: any, assetPath = "/") {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (project.archived_on)
      return archivedShipletPageResponse(c, project, user);
    const canReadArtifact =
      isPublicExternalArtifactRead(project, c.req.raw) ||
      (await canViewProject(c.env.DB, project, user?.id));
    if (!canReadArtifact) {
      return user
        ? c.text("Shiplet access denied", 403)
        : c.redirect(
            `/auth/login?return_to=${encodeURIComponent(new URL(c.req.url).pathname)}`,
          );
    }
    const prefix = `/shiplets/${project.id}/artifact-frame`;
    const artifact = await serveProjectArtifact(
      c.env,
      c.req.raw,
      project,
      user,
      assetPath,
      {
        rootAssetPrefix: prefix,
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
      },
    );
    if (artifact.body === null) {
      return isExternalProject(project)
        ? exposeExternalArtifactToOpaqueSandbox(c.req.raw, artifact)
        : artifact;
    }
    const sandboxed = createSandboxedArtifactResponse({
      body: artifact.body,
      contentType:
        artifact.headers.get("content-type") || "application/octet-stream",
      role: "artifact",
      trustedHostOrigin: new URL(appBaseUrl(c.env, c.req.url)).origin,
      allowDownloads: standalonePreviewDownloadsAllowed(project, assetPath),
      status: artifact.status,
      sourceHeaders: artifact.headers,
    });
    return isExternalProject(project)
      ? exposeExternalArtifactToOpaqueSandbox(c.req.raw, sandboxed)
      : sandboxed;
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load sandboxed artifact: ${message}`, 500);
  }
}

function artifactFramePathFromRequest(c: any) {
  const marker = `/shiplets/${c.req.param("projectId")}/artifact-frame`;
  const pathname = new URL(c.req.url).pathname;
  const suffix = pathname.startsWith(marker)
    ? pathname.slice(marker.length)
    : "";
  return suffix || "/";
}

app.get("/shiplets/:projectId/artifact-frame/*", (c) =>
  handleSandboxedArtifactFrame(c, artifactFramePathFromRequest(c)),
);

app.get("/shiplets/:projectId/artifact-frame", (c) =>
  handleSandboxedArtifactFrame(c, artifactFramePathFromRequest(c)),
);

async function handleShipletPreview(c: any, assetPath = "/") {
  try {
    const user = await getCurrentUser(c.req.raw, c.env);
    const project = await getProjectById(c.env.DB, c.req.param("projectId"));
    if (!project) return c.text("Shiplet not found", 404);
    if (project.archived_on) {
      return archivedShipletPageResponse(c, project, user);
    }
    const canView = await canViewProject(c.env.DB, project, user?.id);
    if (!canView) {
      return user
        ? c.redirect(`/shiplets/${encodeURIComponent(project.id)}/access`)
        : c.redirect(
            `/auth/login?return_to=${encodeURIComponent(new URL(c.req.url).pathname)}`,
          );
    }
    if (assetPath === "/") {
      return c.redirect(`/shiplets/${project.id}/review-host`, 302);
    }
    const suffix = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
    const search = new URL(c.req.url).search;
    return c.redirect(
      `/shiplets/${project.id}/artifact-frame${suffix}${search}`,
      302,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load shiplet preview: ${message}`, 500);
  }
}

function previewAssetPathFromRequest(c: any) {
  const marker = `/shiplets/${c.req.param("projectId")}/preview`;
  const pathname = new URL(c.req.url).pathname;
  const suffix = pathname.startsWith(marker)
    ? pathname.slice(marker.length)
    : "";
  return suffix || "/";
}

app.get("/shiplets/:projectId/preview/*", (c) => {
  return handleShipletPreview(c, previewAssetPathFromRequest(c));
});

app.get("/shiplets/:projectId/preview", (c) => {
  return handleShipletPreview(c, previewAssetPathFromRequest(c));
});

/*
 * Admin page - For debugging/management (hidden)
 */
app.get("/admin", async (c) => {
  // The template's global inventory/debug surface is not a production product
  // boundary. Keep the reserved route fail-closed so tenant routing cannot claim
  // it, but never initialize the database, enumerate projects, or call provider
  // APIs for an unauthenticated request.
  return c.text("Not found", 404);

  let body = `
    <div class="form-container">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
        <h3 style="margin: 0;">Admin Dashboard</h3>
        <form action="/init" style="margin: 0;">
          <button type="submit" class="btn btn-destructive btn-sm">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>
            Reset All Data
          </button>
        </form>
      </div>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 20px;">Manage projects and view dispatch namespace scripts.</p>
      
      <div class="success-card-label" style="margin-top: 24px;">Projects</div>`;

  /*
   * DB data with custom hostname status
   */
  try {
    const projects = (await FetchTable(
      c.var.db,
      "projects",
    )) as unknown as Project[];
    if (projects && projects.length > 0) {
      body += `
        <div class="dataContainer">
          <table class="dataTable">
            <tr>
              <th>Name</th>
              <th>Subdomain</th>
              <th>Custom Domain</th>
              <th>Hostname Status</th>
              <th>SSL Status</th>
              <th>Actions</th>
            </tr>`;

      for (const project of projects) {
        const subdomain = project.subdomain;
        const customHostname = project.custom_hostname || "-";
        let hostnameStatus = "-";
        let sslStatus = "-";
        let hostnameErrors: string[] = [];
        let sslErrors: string[] = [];
        let sslMethod = "";

        const configuredCustomHostname = project.custom_hostname;
        if (configuredCustomHostname) {
          try {
            const status = await getCustomHostnameStatus(
              c.env,
              String(configuredCustomHostname),
            );
            hostnameStatus = status.status;
            sslStatus = status.ssl?.status || "-";
            hostnameErrors = status.verification_errors || [];
            sslErrors = status.ssl?.validation_errors || [];
            sslMethod = status.ssl?.validation_method || "";
          } catch {
            hostnameStatus = "error";
          }
        }

        const statusBadge = (status: string) => {
          if (status === "active")
            return `<span class="status-badge status-active">Active</span>`;
          if (
            status === "pending" ||
            status === "pending_validation" ||
            status === "pending_issuance" ||
            status === "pending_deployment"
          )
            return `<span class="status-badge status-pending">${status.replace(/_/g, " ")}</span>`;
          if (
            status === "error" ||
            status === "deleted" ||
            status === "validation_timed_out" ||
            status === "expired"
          )
            return `<span class="status-badge status-error">${status.replace(/_/g, " ")}</span>`;
          if (status === "-") return "-";
          return `<span class="status-badge status-pending">${status.replace(/_/g, " ")}</span>`;
        };

        // Helper to get user-friendly error message
        const getFriendlyError = (errors: string[]) => {
          const rawError = errors.join(" ").toLowerCase();

          const fallbackOrigin =
            c.env.FALLBACK_ORIGIN ||
            (c.env.CUSTOM_DOMAIN
              ? `my.${c.env.CUSTOM_DOMAIN}`
              : "your-platform-domain");
          if (
            rawError.includes("a or aaaa records") ||
            rawError.includes("ownership verification")
          ) {
            return `Your domain is not pointing to our servers. Add a CNAME record pointing to <strong>${fallbackOrigin}</strong> and wait for DNS propagation (can take up to 24 hours).`;
          }
          if (rawError.includes("cname") && rawError.includes("not found")) {
            return `CNAME record not found. Add a CNAME record pointing to <strong>${fallbackOrigin}</strong>.`;
          }
          if (rawError.includes("timeout") || rawError.includes("timed out")) {
            return "Verification timed out. Please check your DNS settings and try again.";
          }

          // Return original if no match
          return errors.join("<br>");
        };

        // Helper to get user-friendly SSL status message
        const getSSLMessage = (status: string, method: string) => {
          const sslFallbackOrigin =
            c.env.FALLBACK_ORIGIN ||
            (c.env.CUSTOM_DOMAIN
              ? `my.${c.env.CUSTOM_DOMAIN}`
              : "your-platform-domain");
          const messages: Record<string, string> = {
            pending_validation:
              "Waiting for SSL certificate validation. This happens automatically once DNS is verified.",
            pending_issuance:
              "SSL certificate is being issued. This usually takes a few minutes.",
            pending_deployment:
              "SSL certificate is being deployed to edge servers.",
            validation_timed_out: `SSL validation timed out. Make sure your domain points to <strong>${sslFallbackOrigin}</strong> and click refresh.`,
            expired: "SSL certificate has expired and needs renewal.",
            initializing: "SSL certificate is being set up.",
          };
          return messages[status] || "";
        };

        const hasHostnameErrors =
          hostnameErrors.length > 0 && hostnameStatus !== "active";
        const hasSSLDetails = sslStatus !== "active" && sslStatus !== "-";
        const rowId = `row-${subdomain}`;

        body += `
          <tr>
            <td>${project.name}</td>
            <td><a href="${c.env.CUSTOM_DOMAIN ? `https://${subdomain}.${c.env.CUSTOM_DOMAIN}` : `https://${subdomain}.workers.dev`}" target="_blank" class="table-link">${subdomain}</a></td>
            <td>${customHostname !== "-" ? `<a href="https://${customHostname}" target="_blank" class="table-link">${customHostname}</a>` : "-"}</td>
            <td class="status-cell">
              <div class="status-row">
                ${statusBadge(hostnameStatus)}
                ${hasHostnameErrors ? `<button type="button" class="btn-icon" onclick="toggleDetails('${rowId}-hostname')" title="Show details"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg></button>` : ""}
              </div>
              ${hasHostnameErrors ? `<div id="${rowId}-hostname" class="status-details error" style="display: none;"><div class="status-details-item">${getFriendlyError(hostnameErrors)}</div></div>` : ""}
            </td>
            <td class="status-cell">
              <div class="status-row">
                ${statusBadge(sslStatus)}
                ${hasSSLDetails ? `<button type="button" class="btn-icon" onclick="toggleDetails('${rowId}-ssl')" title="Show details"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg></button>` : ""}
              </div>
              ${
                hasSSLDetails
                  ? `<div id="${rowId}-ssl" class="status-details${sslStatus === "validation_timed_out" || sslStatus === "expired" ? " error" : ""}" style="display: none;">
                <div class="status-details-item">${getSSLMessage(sslStatus, sslMethod) || `Status: ${sslStatus.replace(/_/g, " ")}`}</div>
              </div>`
                  : ""
              }
            </td>
            <td>
              ${customHostname !== "-" ? `<button type="button" class="btn-icon" onclick="refreshStatus('${subdomain}')" title="Refresh status" id="refresh-${subdomain}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256"><path d="M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64A81.59,81.59,0,0,0,46.37,90.32a8,8,0,1,1-14.54-6.64A97.49,97.49,0,0,1,128,32a98.33,98.33,0,0,1,69.07,28.94L224,84.07V56a8,8,0,0,1,16,0Zm-32.16,109.68a81.65,81.65,0,0,1-138.45,18.68L44.6,160H72a8,8,0,0,0,0-16H24a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V171.93l26.94,24.13A97.51,97.51,0,0,0,225.54,172.32a8,8,0,0,0-14.54-6.64Z"/></svg></button>` : "-"}
            </td>
          </tr>`;
      }

      body += `</table></div>`;
    } else {
      body += `
        <div class="banner banner-info">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z"/></svg>
          <p>No projects yet.</p>
        </div>`;
    }
  } catch (e) {
    body += `
      <div class="banner banner-info">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z"/></svg>
        <p>No projects yet. Database will auto-initialize on first project creation.</p>
      </div>`;
  }

  body += `</div>
  
  <script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(kernelDocumentNonce(c))}>
  function toggleDetails(elementId) {
    const detailsDiv = document.getElementById(elementId);
    if (detailsDiv) {
      detailsDiv.style.display = detailsDiv.style.display === 'none' ? 'block' : 'none';
    }
  }
  
  async function refreshStatus(subdomain) {
    const btn = document.getElementById('refresh-' + subdomain);
    if (btn) {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" class="animate-spin"><path d="M232,128a104,104,0,0,1-208,0c0-41,23.81-78.36,60.66-95.27a8,8,0,0,1,6.68,14.54C60.15,61.59,40,93.27,40,128a88,88,0,0,0,176,0c0-34.73-20.15-66.41-51.34-80.73a8,8,0,0,1,6.68-14.54C208.19,49.64,232,87,232,128Z"/></svg>';
    }
    // Reload the page to refresh all statuses
    window.location.reload();
  }
  </script>`;

  return c.html(
    renderPage(body, {
      nonce: kernelDocumentNonce(c),
      customDomain: c.env.CUSTOM_DOMAIN,
      appUrl: appBaseUrl(c.env, c.req.url),
      indexing: "noindex",
    }),
  );
});

/*
 * Initialize example data (now optional since auto-init handles schema)
 */
app.get("/init", async (c) => {
  // Database and dispatch resets must only happen through an explicit,
  // separately authenticated operational workflow. A public GET is never an
  // acceptable reset primitive.
  return c.text("Not found", 404);
});

app.post("/api/organizations", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const body = await readJson(c);
    const name = String(body.name || "").trim();
    return json(await createOrganizationForUser(c.env, user, name), 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to create organization: ${message}`, 500);
  }
});

app.post("/api/organizations/:organizationId/teams", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const organizationId = c.req.param("organizationId");
    const membership = await requireAuditedOrganizationAdministrator({
      db: c.env.DB,
      organizationId,
      actorId: user.id,
      action: "team.create",
      authorize: () =>
        requireOrganizationAdministrator(c.env.DB, organizationId, user.id),
    });
    const body = await readJson(c);
    const name = String(body.name || "").trim();
    const description = body.description
      ? String(body.description).trim()
      : null;

    if (!name) {
      return c.text("Missing required field: name", 400);
    }

    const team = await runAuditedKernelAdminAction({
      db: c.env.DB,
      organizationId,
      actorId: user.id,
      action: "team.create",
      targetKind: "team",
      operation: async () => {
        const workosTeam = await createWorkOSTeam(c.env, {
          organizationId,
          name,
          description,
        });
        const created = await createTeamRecord(c.env.DB, {
          id: workosTeam.id,
          organization_id: organizationId,
          name: workosTeam.name,
          description: workosTeam.description || null,
          created_by_user_id: user.id,
          created_on: timestamps.now(),
        });
        await createTeamMembership(
          c.env.DB,
          created.id,
          user.id,
          membership.id,
        );
        await addWorkOSMembershipToTeam(c.env, {
          organizationId,
          teamId: created.id,
          organizationMembershipId: membership.id,
        });
        return created;
      },
    });

    return json({ team }, 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to create team: ${message}`, 500);
  }
});

app.post("/api/organizations/:organizationId/invitations", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const organizationId = c.req.param("organizationId");
    const membership = await requireOrganizationMembership(
      c.env.DB,
      organizationId,
      user.id,
    );
    const body = await readJson(c);
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const role = String(body.role || "member").trim();

    if (!email) {
      return c.text("Missing required field: email", 400);
    }
    if (role !== "member" && role !== "admin") {
      return c.text(
        "Organization invitations must use the member or admin role",
        400,
      );
    }
    if (role === "admin") {
      await requireAuditedOrganizationAdministrator({
        db: c.env.DB,
        organizationId,
        actorId: user.id,
        action: "organization_invitation.create",
        authorize: () =>
          requireOrganizationAdministrator(c.env.DB, organizationId, user.id),
      });
    } else if (!membership) {
      return c.text("Organization membership required", 403);
    }

    const { invitation, workosInvitation } = await runAuditedKernelAdminAction({
      db: c.env.DB,
      organizationId,
      actorId: user.id,
      action: "organization_invitation.create",
      targetKind: "invitation",
      operation: async () => {
        const workosInvitation = await sendWorkOSInvitation(c.env, {
          email,
          organizationId,
          roleSlug: role,
          inviterUserId: user.id,
        });
        const invitation = await createAppInvitation(c.env.DB, {
          id: newId("appinv"),
          organization_id: organizationId,
          email,
          invite_type: "organization",
          role,
          status: "pending",
          invited_by_user_id: user.id,
          workos_invitation_id: workosInvitation.id,
          workos_invitation_token: workosInvitation.token || null,
          created_on: timestamps.now(),
        });
        return { invitation, workosInvitation };
      },
    });

    return json(
      {
        invitation: publicAppInvitation(invitation),
        workosInvitation: publicWorkOSInvitation(workosInvitation),
      },
      201,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to invite user: ${message}`, 500);
  }
});

app.post(
  "/api/organizations/:organizationId/teams/:teamId/invitations",
  async (c) => {
    try {
      const user = await requireCurrentUser(c);
      const organizationId = c.req.param("organizationId");
      const teamId = c.req.param("teamId");
      await requireOrganizationMembership(c.env.DB, organizationId, user.id);

      const team = await getTeam(c.env.DB, teamId);
      if (!team || team.organization_id !== organizationId) {
        return c.text("Team not found", 404);
      }

      const body = await readJson(c);
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const role = String(body.role || "member").trim();

      if (!email) {
        return c.text("Missing required field: email", 400);
      }
      if (role !== "member") {
        return c.text(
          "Team invitations must use the member organization role",
          400,
        );
      }

      const { invitation, workosInvitation } =
        await runAuditedKernelAdminAction({
          db: c.env.DB,
          organizationId,
          actorId: user.id,
          action: "team_invitation.create",
          targetKind: "invitation",
          operation: async () => {
            const workosInvitation = await sendWorkOSInvitation(c.env, {
              email,
              organizationId,
              roleSlug: role,
              inviterUserId: user.id,
            });
            const invitation = await createAppInvitation(c.env.DB, {
              id: newId("appinv"),
              organization_id: organizationId,
              team_id: teamId,
              email,
              invite_type: "team",
              role,
              status: "pending",
              invited_by_user_id: user.id,
              workos_invitation_id: workosInvitation.id,
              workos_invitation_token: workosInvitation.token || null,
              created_on: timestamps.now(),
            });
            return { invitation, workosInvitation };
          },
        });

      return json(
        {
          invitation: publicAppInvitation(invitation),
          workosInvitation: publicWorkOSInvitation(workosInvitation),
        },
        201,
      );
    } catch (error) {
      if (isResponse(error)) return error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.text(`Failed to invite team member: ${message}`, 500);
    }
  },
);

/**
 * Create a new project (shiplet)
 *
 * This endpoint handles two types of deployments:
 * 1. Code deployment: User provides raw Worker script code
 * 2. Static site deployment: User uploads files (HTML, CSS, JS, images)
 *
 * For static sites, files are deployed using the Workers Assets API,
 * which optimizes serving of static content from Cloudflare's edge.
 *
 * Custom domains are set up using Cloudflare for SaaS (custom hostnames),
 * which handles SSL certificate provisioning automatically.
 */
app.post("/projects", withDbAndInit, async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const body = await readJson(c);
    const result = await publishShiplet(c.env, c.var.db, user, body);
    return json(publishResultPayload(c.env, c.req.url, result), 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("POST /projects error:", errorMessage, error);
    return c.text(`Internal server error: ${errorMessage}`, 500);
  }
});

app.post("/api/projects/:projectId/invitations", async (c) => {
  try {
    const user = await requireCurrentUser(c);
    const projectId = c.req.param("projectId");
    const project = await getProjectById(c.env.DB, projectId);
    if (!project) {
      return c.text("Shiplet not found", 404);
    }
    if (!project.organization_id) {
      return c.text("Shiplet is missing organization scope", 409);
    }

    await requireAuditedOrganizationAdministrator({
      db: c.env.DB,
      organizationId: project.organization_id,
      projectId: project.id,
      actorId: user.id,
      action: "shiplet_share.create",
      authorize: () => requireProjectEditor(c, project, user),
    });

    const body = await readJson(c);
    const targetType = String(body.targetType || "").trim();
    const role = String(body.role || "viewer").trim();

    if (!["organization", "team", "user"].includes(targetType)) {
      return c.text(
        "targetType must be one of organization, team, or user",
        400,
      );
    }
    if (!new Set(["viewer", "reviewer", "editor"]).has(role)) {
      return c.text("role must be viewer, reviewer, or editor", 400);
    }

    if (targetType === "organization") {
      const targetOrganizationId = String(
        body.organizationId || project.organization_id,
      ).trim();

      const grant = await runAuditedKernelAdminAction({
        db: c.env.DB,
        organizationId: project.organization_id,
        projectId: project.id,
        actorId: user.id,
        action: "shiplet_share.create",
        targetKind: "organization",
        operation: () =>
          createShipletGrant(c.env.DB, {
            id: newId("grant"),
            project_id: project.id,
            organization_id: project.organization_id!,
            target_type: "organization",
            target_id: targetOrganizationId,
            role,
            invited_by_user_id: user.id,
            created_on: timestamps.now(),
          }),
      });

      return json({ grant }, 201);
    }

    if (targetType === "team") {
      const teamId = String(body.teamId || "").trim();
      if (!teamId) {
        return c.text("Missing required field: teamId", 400);
      }

      const team = await getTeam(c.env.DB, teamId);
      if (!team || team.organization_id !== project.organization_id) {
        return c.text("Team not found", 404);
      }

      const grant = await runAuditedKernelAdminAction({
        db: c.env.DB,
        organizationId: project.organization_id,
        projectId: project.id,
        actorId: user.id,
        action: "shiplet_share.create",
        targetKind: "team",
        operation: () =>
          createShipletGrant(c.env.DB, {
            id: newId("grant"),
            project_id: project.id,
            organization_id: project.organization_id!,
            target_type: "team",
            target_id: teamId,
            role,
            invited_by_user_id: user.id,
            created_on: timestamps.now(),
          }),
      });

      return json({ grant }, 201);
    }

    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    if (!email) {
      return c.text("Missing required field: email", 400);
    }

    const { workosInvitation, appInvitation, grant } =
      await runAuditedKernelAdminAction({
        db: c.env.DB,
        organizationId: project.organization_id,
        projectId: project.id,
        actorId: user.id,
        action: "shiplet_share.create",
        targetKind: "user_invitation",
        operation: async () => {
          const workosInvitation = await sendWorkOSInvitation(c.env, {
            email,
            organizationId: project.organization_id!,
            roleSlug: "member",
            inviterUserId: user.id,
          });
          const appInvitation = await createAppInvitation(c.env.DB, {
            id: newId("appinv"),
            organization_id: project.organization_id!,
            project_id: project.id,
            email,
            invite_type: "shiplet_user",
            role,
            status: "pending",
            invited_by_user_id: user.id,
            workos_invitation_id: workosInvitation.id,
            workos_invitation_token: workosInvitation.token || null,
            created_on: timestamps.now(),
          });
          const grant = await createShipletGrant(c.env.DB, {
            id: newId("grant"),
            project_id: project.id,
            organization_id: project.organization_id!,
            target_type: "user",
            email,
            role,
            invited_by_user_id: user.id,
            workos_invitation_id: workosInvitation.id,
            created_on: timestamps.now(),
          });
          return { workosInvitation, appInvitation, grant };
        },
      });

    return json(
      {
        grant,
        appInvitation: publicAppInvitation(appInvitation),
        workosInvitation: publicWorkOSInvitation(workosInvitation),
      },
      201,
    );
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to share shiplet: ${message}`, 500);
  }
});

app.get("/api/projects/:projectId/review-mention-users", async (c) => {
  try {
    const project = await requireReviewProject(c);
    if (!project.organization_id) {
      return json({ users: [] });
    }
    const user = await getReviewRequestUser(c.env, c.req.raw);
    await authorizeReviewRequest(c.env, c.req.raw, project, user, [
      "feedback:read",
    ]);
    const url = new URL(c.req.url);
    return json({
      users: await listTrustedReviewMentionCandidates(
        c.env,
        project,
        user,
        url.searchParams.get("q") || "",
        Number(url.searchParams.get("limit") || 20),
      ),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list mention users: ${message}`, 500);
  }
});

app.get("/api/projects/:projectId/review-watch", async (c) => {
  try {
    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    const authorization = await authorizeReviewRequest(
      c.env,
      c.req.raw,
      project,
      user,
      ["feedback:read"],
    );
    if (!authorization.user) {
      throw new Response("Review watch requires a reviewer.", { status: 403 });
    }
    const reviewer = authorization.user;
    return json({ watch: await getWatchStatus(c.env.DB, project, reviewer) });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to load watch status: ${message}`, 500);
  }
});

app.post("/api/projects/:projectId/review-watch", async (c) => {
  try {
    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    const authorization = await authorizeReviewRequest(
      c.env,
      c.req.raw,
      project,
      user,
      ["watch:write"],
    );
    if (!authorization.user) {
      throw new Response("Review watch requires a reviewer.", { status: 403 });
    }
    const reviewer = authorization.user;
    return json({
      watch: await setWatchStatus(c.env.DB, project, reviewer, true),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to watch shiplet: ${message}`, 500);
  }
});

app.delete("/api/projects/:projectId/review-watch", async (c) => {
  try {
    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    const authorization = await authorizeReviewRequest(
      c.env,
      c.req.raw,
      project,
      user,
      ["watch:write"],
    );
    if (!authorization.user) {
      throw new Response("Review watch requires a reviewer.", { status: 403 });
    }
    const reviewer = authorization.user;
    return json({
      watch: await setWatchStatus(c.env.DB, project, reviewer, false),
    });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to unwatch shiplet: ${message}`, 500);
  }
});

app.get("/api/projects/:projectId/review-presence/ws", async (c) => {
  try {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Review presence expected Upgrade: websocket", 426);
    }
    if (!c.env.SHIPLET_ROOT) {
      return c.text("Review presence is not configured", 503);
    }

    const projectId = c.req.param("projectId");
    const origin = c.req.header("origin");
    if (origin && !allowedReviewCorsOrigin(c.env, c.req.url, origin)) {
      return c.text("Review presence origin denied", 403);
    }

    if (isSandboxProjectId(projectId)) {
      const stub = c.env.SHIPLET_ROOT.getByName(projectId);
      return stub.fetch(c.req.raw);
    }

    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    let reviewer = user;
    if (!(await canViewProject(c.env.DB, project, user?.id))) {
      const authorization = await authorizeReviewRequest(
        c.env,
        c.req.raw,
        project,
        user,
        ["presence:join"],
      );
      reviewer = authorization.user;
    }
    if (!(await canViewProject(c.env.DB, project, reviewer?.id))) {
      return user
        ? c.text("Shiplet access denied", 403)
        : c.text("Review presence access required", 401);
    }

    const stub = c.env.SHIPLET_ROOT.getByName(project.id);
    return stub.fetch(reviewPresenceRequest(c.req.raw, project, reviewer));
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to connect review presence: ${message}`, 500);
  }
});

app.get("/api/projects/:projectId/review-feedback", async (c) => {
  try {
    const projectId = c.req.param("projectId");
    if (isSandboxProjectId(projectId)) {
      const sessionId = sandboxSessionIdForProject(projectId)!;
      const actorId = sandboxActorIdFromRequest(c.req.raw, new URL(c.req.url));
      const url = new URL(c.req.url);
      const response = json({
        feedback: await sandboxStub(c.env, sessionId).listFeedback(
          sessionId,
          projectId,
          {
            pageUrl: url.searchParams.get("pageUrl"),
            status: url.searchParams.get("status"),
            includeClosed: url.searchParams.get("includeClosed") === "true",
            limit: Number(url.searchParams.get("limit") || 100),
          },
        ),
      });
      return withSandboxCookies(response, sessionId, actorId);
    }

    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    await authorizeReviewRequest(c.env, c.req.raw, project, user, [
      "feedback:read",
    ]);
    const url = new URL(c.req.url);
    const feedback = await listReviewFeedback(c.env.DB, project.id, {
      pageUrl: url.searchParams.get("pageUrl"),
      status: url.searchParams.get("status"),
      includeClosed: url.searchParams.get("includeClosed") === "true",
      limit: Number(url.searchParams.get("limit") || 100),
    });
    return json({ feedback });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to list review feedback: ${message}`, 500);
  }
});

app.post("/api/projects/:projectId/review-feedback", async (c) => {
  try {
    const projectId = c.req.param("projectId");
    if (isSandboxProjectId(projectId)) {
      const sessionId = sandboxSessionIdForProject(projectId)!;
      const actorId = sandboxActorIdFromRequest(c.req.raw, new URL(c.req.url));
      const validation = validateReviewFeedbackPayload(await readJson(c));
      if (!validation.ok) {
        return withSandboxCookies(
          json({ ok: false, errors: validation.errors }, 400),
          sessionId,
          actorId,
        );
      }
      const response = json(
        {
          ok: true,
          feedback: await sandboxStub(c.env, sessionId).createFeedback(
            sessionId,
            projectId,
            actorId,
            sandboxFeedbackInput(validation.value),
          ),
        },
        201,
      );
      return withSandboxCookies(response, sessionId, actorId);
    }

    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    const authorization = await authorizeReviewRequest(
      c.env,
      c.req.raw,
      project,
      user,
      ["feedback:write"],
    );
    const validation = validateReviewFeedbackPayload(await readJson(c));
    if (!validation.ok) {
      return json({ ok: false, errors: validation.errors }, 400);
    }
    const feedback = await createReviewFeedback(
      c.env,
      project,
      authorization.user,
      validation.value,
      undefined,
      authorization.token
        ? { kind: "agent", id: authorization.token.id }
        : undefined,
    );
    return json({ ok: true, feedback }, 201);
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to create review feedback: ${message}`, 500);
  }
});

app.get("/api/projects/:projectId/review-feedback/:feedbackId", async (c) => {
  try {
    const projectId = c.req.param("projectId");
    if (isSandboxProjectId(projectId)) {
      const sessionId = sandboxSessionIdForProject(projectId)!;
      const actorId = sandboxActorIdFromRequest(c.req.raw, new URL(c.req.url));
      const feedback = await sandboxStub(c.env, sessionId).getFeedback(
        sessionId,
        projectId,
        c.req.param("feedbackId"),
      );
      if (!feedback) return c.text("Review feedback not found", 404);
      return withSandboxCookies(json({ feedback }), sessionId, actorId);
    }

    const project = await requireReviewProject(c);
    const user = await getReviewRequestUser(c.env, c.req.raw);
    await authorizeReviewRequest(c.env, c.req.raw, project, user, [
      "feedback:read",
    ]);
    const feedback = await getReviewFeedback(
      c.env.DB,
      project.id,
      c.req.param("feedbackId"),
    );
    if (!feedback) return c.text("Review feedback not found", 404);
    return json({ feedback });
  } catch (error) {
    if (isResponse(error)) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.text(`Failed to get review feedback: ${message}`, 500);
  }
});

app.get(
  "/api/projects/:projectId/review-feedback/:feedbackId/screenshot",
  async (c) => {
    try {
      const projectId = c.req.param("projectId");
      if (isSandboxProjectId(projectId)) {
        return c.text("Review screenshot not found", 404);
      }

      const project = await requireReviewProject(c);
      const user = await getReviewRequestUser(c.env, c.req.raw);
      await authorizeReviewRequest(c.env, c.req.raw, project, user, [
        "feedback:read",
      ]);

      const screenshot = await getReviewScreenshot(
        c.env,
        project.id,
        c.req.param("feedbackId"),
      );
      if (!screenshot) return c.text("Review screenshot not found", 404);

      const contentType =
        screenshot.object.httpMetadata?.contentType ||
        screenshot.feedback.screenshot_content_type ||
        "application/octet-stream";
      const extension =
        contentType === "image/jpeg"
          ? "jpg"
          : contentType.startsWith("image/")
            ? contentType.replace("image/", "")
            : "bin";
      const headers = new Headers({
        "content-type": contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="${screenshot.feedback.ticket_label.toLowerCase()}-screenshot.${extension}"`,
      });
      headers.set("content-length", String(screenshot.object.size));

      return new Response(screenshot.object.body, { headers });
    } catch (error) {
      if (isResponse(error)) return error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.text(`Failed to get review screenshot: ${message}`, 500);
    }
  },
);

app.post(
  "/api/projects/:projectId/review-feedback/:feedbackId/replies",
  async (c) => {
    try {
      const projectId = c.req.param("projectId");
      if (isSandboxProjectId(projectId)) {
        const sessionId = sandboxSessionIdForProject(projectId)!;
        const actorId = sandboxActorIdFromRequest(
          c.req.raw,
          new URL(c.req.url),
        );
        const body = await readJson(c);
        const feedback = await sandboxStub(c.env, sessionId).createReply(
          sessionId,
          projectId,
          c.req.param("feedbackId"),
          actorId,
          String(body.comment || ""),
        );
        if (!feedback) return c.text("Review feedback not found", 404);
        return withSandboxCookies(json({ feedback }, 201), sessionId, actorId);
      }

      const project = await requireReviewProject(c);
      const user = await getReviewRequestUser(c.env, c.req.raw);
      const authorization = await authorizeReviewRequest(
        c.env,
        c.req.raw,
        project,
        user,
        ["feedback:write"],
      );
      const body = await readJson(c);
      const feedback = await createReviewReplyWithNotifications(
        c.env,
        project,
        c.req.param("feedbackId"),
        String(body.comment || ""),
        authorization.user,
        normalizeMentionInputs(body.mentions),
        authorization.token
          ? { kind: "agent", id: authorization.token.id }
          : undefined,
      );
      return json({ feedback }, 201);
    } catch (error) {
      if (isResponse(error)) return error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.text(`Failed to reply to review feedback: ${message}`, 500);
    }
  },
);

app.post(
  "/api/projects/:projectId/review-feedback/:feedbackId/status",
  async (c) => {
    try {
      const projectId = c.req.param("projectId");
      if (isSandboxProjectId(projectId)) {
        const sessionId = sandboxSessionIdForProject(projectId)!;
        const actorId = sandboxActorIdFromRequest(
          c.req.raw,
          new URL(c.req.url),
        );
        const body = await readJson(c);
        const feedback = await sandboxStub(c.env, sessionId).updateStatus(
          sessionId,
          projectId,
          c.req.param("feedbackId"),
          String(body.status || ""),
        );
        if (!feedback) return c.text("Review feedback not found", 404);
        return withSandboxCookies(json({ feedback }), sessionId, actorId);
      }

      const project = await requireReviewProject(c);
      const user = await getReviewRequestUser(c.env, c.req.raw);
      const authorization = await authorizeReviewRequest(
        c.env,
        c.req.raw,
        project,
        user,
        ["feedback:write"],
      );
      const body = await readJson(c);
      const feedback = await updateReviewStatusWithNotifications(
        c.env,
        project,
        c.req.param("feedbackId"),
        String(body.status || ""),
        authorization.user,
        authorization.token
          ? { kind: "agent", id: authorization.token.id }
          : undefined,
      );
      return json({ feedback });
    } catch (error) {
      if (isResponse(error)) return error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return c.text(`Failed to update review feedback: ${message}`, 500);
    }
  },
);

/*
 * Check custom domain status
 */
app.get(
  "/projects/:subdomain/custom-domain-status",
  withDbAndInit,
  async (c) => {
    try {
      const subdomain = c.req.param("subdomain");

      // Get project by subdomain
      const project = await GetProjectBySubdomain(c.var.db, subdomain);
      if (!project) {
        return c.text("Project not found", 404);
      }

      // Check if project has custom hostname
      if (!project.custom_hostname) {
        return c.json({
          has_custom_domain: false,
          worker_url: c.env.CUSTOM_DOMAIN
            ? `https://${subdomain}.${c.env.CUSTOM_DOMAIN}`
            : `https://${c.env.WORKERS_DEV_SUBDOMAIN || "my-worker"}.workers.dev/${subdomain}`,
        });
      }

      // Get custom hostname status from Cloudflare
      const status = await getCustomHostnameStatus(
        c.env,
        project.custom_hostname,
      );

      return c.json({
        has_custom_domain: true,
        custom_domain: project.custom_hostname,
        status: status.status,
        ssl_status: status.ssl?.status,
        verification_errors: status.verification_errors || [],
        worker_url: c.env.CUSTOM_DOMAIN
          ? `https://${subdomain}.${c.env.CUSTOM_DOMAIN}`
          : `https://${c.env.WORKERS_DEV_SUBDOMAIN || "my-worker"}.workers.dev/${subdomain}`,
        is_active: status.status === "active",
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return c.text(`Internal server error: ${errorMessage}`, 500);
    }
  },
);

const scheduledApp = app as typeof app & {
  scheduled(
    controller: ScheduledController,
    environment: Env,
    context: ExecutionContext,
  ): Promise<void>;
};

scheduledApp.scheduled = async (controller, environment, context) => {
  const reconciliation = (async () => {
    try {
      await sweepStaleExternalRewriteSpools(environment.REVIEW_ASSETS, {
        now: controller.scheduledTime,
      });
    } catch {
      // Temporary rewrite parts are already isolated under a reserved prefix
      // and will be retried by the next sweep. Cleanup must not starve the
      // unrelated database and OAuth reconciliation work in this cron run.
    }
    await autoInitializeDatabase(environment.DB);
    const runtime = environment as DeploymentRuntimeEnv;
    if (!(await cloudflareSupportEntrypointsReady(runtime))) return;
    await reconcileCloudflareOAuthAcknowledgements({
      db: environment.DB,
      now: Date.now(),
      limit: 25,
      controlForUser: () => cloudflareOAuthControlPlaneBinding(runtime),
    });
  })();
  context.waitUntil(reconciliation);
};

export default scheduledApp;
