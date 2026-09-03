import {
  CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES,
  type CloudflareTemporaryAccountPolicyAcceptance,
} from "../deployment-orchestrator";
import { revisionPreviewPath } from "../self-owned/revision-preview";

export type OwnershipRevision = {
  id: string;
  label: string;
  createdAt: string;
  validatedAt: string | null;
};

export type OwnershipDraft = {
  id: string;
  label: string;
  parentRevisionId: string;
  state: "draft" | "validating" | "validated" | "invalid";
  version: number;
  validatedRevisionId?: string | null;
  updatedAt: string;
  summary?: string | null;
  validationSummary?: string | null;
};

export type OwnershipRevisionHistoryItem = {
  id: string;
  label: string;
  createdAt: string;
  status: "known_good" | "rolled_back";
};

export type OwnershipSealedRevisionItem = {
  id: string;
  label: string;
  createdAt: string;
};

export type CustomerDeploymentTarget = {
  id: string;
  label: string;
  ownership: "customer";
  status: "healthy" | "pending" | "deployment_failed" | "offline";
  activeRevisionId?: string | null;
  lastDeployedAt?: string | null;
  healthVerifiedAt?: string | null;
  drift?: "in_sync" | "drifted" | "unknown";
  detached?: boolean;
  updatesAvailable: boolean;
  running: boolean;
  failureSummary?: string | null;
};

export type ShipletOwnershipPageModel = {
  shiplet: {
    id: string;
    name: string;
    activeRevision: OwnershipRevision | null;
  };
  managed: {
    status: "active" | "degraded" | "unavailable";
    runtime: "static" | "worker" | "external_proxy";
    arbitraryWorkerExecution: {
      available: boolean;
      reason?: "managed_dynamic_unavailable" | "runtime_unavailable" | null;
    };
  };
  revisions: {
    drafts: OwnershipDraft[];
    history: OwnershipRevisionHistoryItem[];
    sealed?: OwnershipSealedRevisionItem[];
  };
  cloudflare: {
    state: "empty" | "denied" | "revoked" | "connected" | "error";
    connectAvailable: boolean;
    connectionId?: string | null;
    reason?: "cloudflare_oauth_prerequisite" | null;
    accountLabel?: string | null;
    scopes?: string[];
    targets: CustomerDeploymentTarget[];
  };
  temporaryClaim: {
    status: "unavailable" | "ready" | "awaiting_claim" | "claimed" | "expired";
    targetId?: string | null;
    expiresAt?: string | null;
  };
  export: {
    available: boolean;
    detached?: boolean;
  };
  viewState?: "ready" | "loading" | "error" | "offline" | "permission_denied";
  errorSummary?: string | null;
};

export type ShipletOwnershipPage = {
  title: string;
  description: string;
  body: string;
};

export type OwnershipActionInput = {
  action:
    | "fork"
    | "validate"
    | "promote"
    | "rollback"
    | "connect_cloudflare"
    | "revoke_cloudflare"
    | "redeploy"
    | "temporary_claim";
  shipletId: string;
  draftId?: string;
  revisionId?: string;
  connectionId?: string;
  targetId?: string;
  expectedVersion?: number;
  expectedActiveRevisionId?: string;
  idempotencyKey?: string;
  approved?: boolean;
  acceptedCloudflarePolicies?: boolean;
};

export type OwnershipActionRequest = {
  method: "POST" | "DELETE";
  path: string;
  body: Record<string, unknown>;
  headers?: { "idempotency-key": string };
  requiresApproval: boolean;
};

type DeploymentStatusEnvelope = {
  shipletId: string;
  managed: {
    default: true;
    owner: "shiplet";
    status: "active" | "archived";
    runtime: "static" | "worker" | "external_proxy";
    arbitraryWorkerExecution: {
      available: boolean;
      reason?: "managed_dynamic_unavailable" | "runtime_unavailable" | null;
    };
  };
  customerCloudflare: {
    connectAvailable: boolean;
    reason?: "cloudflare_oauth_prerequisite" | null;
    targets: Array<{
      id: string;
      kind: string;
      ownership: "customer";
      providerAccountId?: string | null;
      connection: {
        id: string;
        status: "active" | "revoked" | "unavailable";
      } | null;
      detached: boolean;
      lastDeployment: {
        id: string;
        revisionId: string;
        scriptName?: string | null;
        status: string | null;
        deployedOn?: string | null;
        running: boolean;
        updatesAvailable: boolean;
      } | null;
    }>;
  };
};

export type OwnershipPageAdapterInput = {
  shiplet: { id: string; name: string };
  activeRevision: OwnershipRevision | null;
  drafts: OwnershipDraft[];
  history: OwnershipRevisionHistoryItem[];
  sealed?: OwnershipSealedRevisionItem[];
  deploymentStatus: DeploymentStatusEnvelope;
  cloudflareAuthority?: {
    accountLabel?: string | null;
    scopes?: string[];
  };
  targetEvidenceById?: Record<
    string,
    {
      healthVerifiedAt?: string | null;
      drift?: CustomerDeploymentTarget["drift"];
      failureSummary?: string | null;
    }
  >;
  temporaryClaim: ShipletOwnershipPageModel["temporaryClaim"];
  export: ShipletOwnershipPageModel["export"];
};

const OWNERSHIP_PAGE_CSS = `
<style data-shiplet-ownership-styles>
.ownership-page {
  --ownership-ink: var(--text, oklch(23% 0.04 255));
  --ownership-soft: var(--text-soft, oklch(34% 0.035 255));
  --ownership-muted: var(--text-muted, oklch(47% 0.03 252));
  --ownership-line: var(--line, oklch(80% 0.02 250));
  --ownership-strong: var(--line-strong, oklch(34% 0.035 255));
  --ownership-surface: var(--surface, oklch(99% 0.005 95));
  --ownership-sunken: var(--surface-sunken, oklch(94% 0.015 92));
  --ownership-action: var(--action, oklch(54% 0.165 35));
  --ownership-action-hover: var(--action-hover, oklch(48% 0.16 35));
  --ownership-action-contrast: var(--action-contrast, white);
  --ownership-ring: var(--ring, oklch(47% 0.085 220));
  --ownership-ok: var(--ok, oklch(42% 0.1 155));
  --ownership-ok-surface: var(--ok-surface, oklch(93% 0.055 155));
  --ownership-warn: var(--warn, oklch(45% 0.1 75));
  --ownership-warn-surface: var(--warn-surface, oklch(94% 0.08 90));
  --ownership-err: var(--err, oklch(50% 0.19 27));
  --ownership-err-surface: var(--err-surface, oklch(93% 0.045 27));
  --ownership-info: var(--info, oklch(40% 0.075 220));
  --ownership-info-surface: var(--info-surface, oklch(92% 0.04 215));
  color: var(--ownership-ink);
  display: grid;
  gap: 20px;
  margin: 0 auto;
  max-width: 1080px;
  padding-bottom: 48px;
}
.ownership-page *, .ownership-page *::before, .ownership-page *::after { box-sizing: border-box; }
.ownership-page h1, .ownership-page h2, .ownership-page h3, .ownership-page p { margin-top: 0; }
.ownership-page h1 { font-size: 2rem; letter-spacing: -0.025em; line-height: 1.12; margin-bottom: 8px; text-wrap: balance; }
.ownership-page h2 { font-size: 1.25rem; line-height: 1.25; margin-bottom: 6px; text-wrap: balance; }
.ownership-page h3 { font-size: 1rem; line-height: 1.35; margin-bottom: 4px; }
.ownership-page p { color: var(--ownership-soft); line-height: 1.55; max-width: 72ch; }
.ownership-page code { overflow-wrap: anywhere; }
.ownership-page-head { align-items: end; display: flex; flex-wrap: wrap; gap: 14px; justify-content: space-between; }
.ownership-page-head p { margin-bottom: 0; }
.ownership-nav { display: flex; flex-wrap: wrap; gap: 6px; }
.ownership-nav a { border-radius: 999px; color: var(--ownership-soft); font-size: .875rem; font-weight: 650; padding: 8px 11px; text-decoration: none; }
.ownership-nav a[aria-current="page"] { background: var(--ownership-sunken); color: var(--ownership-ink); }
.ownership-nav a:hover { background: var(--ownership-sunken); color: var(--ownership-ink); }
.ownership-section {
  background: var(--ownership-surface);
  border: 1px solid var(--ownership-strong);
  border-bottom-width: 3px;
  border-radius: 10px;
  padding: 20px;
}
.ownership-focus { border-bottom-color: var(--ownership-action); }
.ownership-section-head { align-items: start; display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; margin-bottom: 18px; }
.ownership-section-head > div > p { margin-bottom: 0; }
.ownership-kicker { color: var(--ownership-muted); display: block; font: 600 .6875rem/1.3 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .07em; margin-bottom: 5px; text-transform: uppercase; }
.ownership-status { align-items: center; border: 1px solid currentColor; border-radius: 999px; display: inline-flex; font: 600 .6875rem/1.2 "IBM Plex Mono", ui-monospace, monospace; gap: 6px; padding: 5px 8px; text-transform: uppercase; }
.ownership-status::before { background: currentColor; border-radius: 50%; content: ""; height: 7px; width: 7px; }
.ownership-status-ok { background: var(--ownership-ok-surface); color: var(--ownership-ok); }
.ownership-status-warn { background: var(--ownership-warn-surface); color: var(--ownership-warn); }
.ownership-status-error { background: var(--ownership-err-surface); color: var(--ownership-err); }
.ownership-status-info { background: var(--ownership-info-surface); color: var(--ownership-info); }
.ownership-ledger { border-top: 1px dashed var(--ownership-line); display: grid; }
.ownership-row { align-items: center; border-bottom: 1px dashed var(--ownership-line); display: grid; gap: 8px 18px; grid-template-columns: minmax(135px, .65fr) minmax(0, 1.65fr) auto; padding: 13px 0; }
.ownership-row:last-child { border-bottom: 0; }
.ownership-row-label { color: var(--ownership-muted); font-size: .8125rem; font-weight: 650; }
.ownership-row-value { color: var(--ownership-ink); line-height: 1.45; min-width: 0; overflow-wrap: anywhere; }
.ownership-row-detail { color: var(--ownership-muted); font-size: .8125rem; }
.ownership-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; }
.ownership-action {
  align-items: center;
  background: var(--ownership-surface);
  border: 1px solid var(--ownership-strong);
  border-bottom-width: 2px;
  border-radius: 7px;
  color: var(--ownership-ink);
  cursor: pointer;
  display: inline-flex;
  font: 650 .875rem/1 system-ui, sans-serif;
  justify-content: center;
  min-height: 38px;
  padding: 9px 13px;
  text-decoration: none;
}
.ownership-action:hover { background: var(--ownership-sunken); }
.ownership-action:active { border-bottom-width: 1px; transform: translateY(1px); }
.ownership-action-primary { background: var(--ownership-action); border-color: var(--ownership-action-hover); color: var(--ownership-action-contrast); }
.ownership-action-primary:hover { background: var(--ownership-action-hover); }
.ownership-action[disabled] { cursor: not-allowed; opacity: .62; transform: none; }
.ownership-page :focus-visible { outline: 2px solid var(--ownership-ring); outline-offset: 2px; }
.ownership-notice { background: var(--ownership-info-surface); border: 1px solid var(--ownership-info); border-radius: 8px; color: var(--ownership-info); margin: 14px 0 0; padding: 11px 12px; }
.ownership-notice p { color: inherit; margin: 0; }
.ownership-notice-warning { background: var(--ownership-warn-surface); border-color: var(--ownership-warn); color: var(--ownership-warn); }
.ownership-notice-error { background: var(--ownership-err-surface); border-color: var(--ownership-err); color: var(--ownership-err); }
.ownership-split { display: grid; gap: 18px; grid-template-columns: minmax(0, 1.45fr) minmax(260px, .75fr); }
.ownership-draft { border-top: 1px dashed var(--ownership-line); padding: 15px 0 4px; }
.ownership-draft:first-of-type { border-top: 0; padding-top: 0; }
.ownership-draft-head { align-items: start; display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; }
.ownership-draft p { margin-bottom: 9px; }
.ownership-secondary { background: var(--ownership-sunken); border-radius: 8px; padding: 15px; }
.ownership-secondary p:last-child { margin-bottom: 0; }
.ownership-secondary-section + .ownership-secondary-section { border-top: 1px dashed var(--ownership-line); margin-top: 16px; padding-top: 16px; }
.ownership-session-note { color: var(--ownership-muted); font-size: .8125rem; margin: 9px 0 0; }
.ownership-target { border-top: 1px dashed var(--ownership-line); padding: 14px 0; }
.ownership-target:first-of-type { border-top: 0; padding-top: 0; }
.ownership-target:last-child { padding-bottom: 0; }
.ownership-target-head { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; }
.ownership-target-meta { color: var(--ownership-muted); display: flex; flex-wrap: wrap; font-size: .8125rem; gap: 6px 14px; margin-top: 5px; }
.ownership-target .ownership-notice { margin-top: 10px; }
.ownership-disclosure { border-top: 1px dashed var(--ownership-line); margin-top: 14px; padding-top: 10px; }
.ownership-disclosure summary { color: var(--ownership-soft); cursor: pointer; font-size: .875rem; font-weight: 650; min-height: 38px; padding: 9px 0; }
.ownership-disclosure[open] summary { color: var(--ownership-ink); }
.ownership-policy { align-items: start; color: var(--ownership-soft); display: grid; font-size: .8125rem; gap: 8px; grid-template-columns: auto 1fr; line-height: 1.5; margin: 12px 0; }
.ownership-policy input { height: 18px; margin: 1px 0 0; width: 18px; }
.ownership-policy a { color: var(--ownership-info); }
.ownership-skeleton { display: grid; gap: 11px; }
.ownership-skeleton-line { animation: ownership-pulse 1.2s ease-in-out infinite alternate; background: var(--ownership-sunken); border-radius: 5px; height: 14px; max-width: 620px; width: 82%; }
.ownership-skeleton-line:nth-child(2) { width: 54%; }
@keyframes ownership-pulse { from { opacity: .55; } to { opacity: 1; } }
@media (max-width: 640px) {
  .ownership-page { gap: 14px; padding-bottom: 32px; }
  .ownership-page h1 { font-size: 1.65rem; }
  .ownership-page-head { align-items: start; flex-direction: column; }
  .ownership-section { padding: 16px; }
  .ownership-split { grid-template-columns: 1fr; }
  .ownership-row { align-items: start; grid-template-columns: 1fr; }
  .ownership-row-detail { margin-top: -3px; }
  .ownership-action { min-height: 44px; }
  .ownership-nav a { min-height: 44px; align-items: center; display: inline-flex; }
  .ownership-actions { align-items: stretch; flex-direction: column; }
  .ownership-actions .ownership-action { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .ownership-page *, .ownership-page *::before, .ownership-page *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
}
</style>`;

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pathSegment(value: unknown) {
  return encodeURIComponent(String(value ?? ""));
}

function requiredIdentifier(value: string | undefined, code: string) {
  if (!value || value.trim() !== value || value.length > 256) {
    throw new Error(code);
  }
  return value;
}

function expectedVersion(value: number | undefined) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error("expected_version_required");
  }
  return Number(value);
}

function operationHeaders(idempotencyKey: string | undefined) {
  if (
    !idempotencyKey ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(idempotencyKey)
  ) {
    throw new Error("idempotency_key_required");
  }
  return { "idempotency-key": idempotencyKey } as const;
}

function requireTrustedApproval(approved: boolean | undefined) {
  if (approved !== true) throw new Error("trusted_approval_required");
}

export function BuildOwnershipActionRequest(
  input: OwnershipActionInput,
): OwnershipActionRequest {
  const shipletId = requiredIdentifier(input.shipletId, "shiplet_id_required");
  if (input.action === "fork") {
    return {
      method: "POST",
      path: `/api/shiplets/${pathSegment(shipletId)}/drafts`,
      body: input.revisionId ? { fromRevisionId: input.revisionId } : {},
      requiresApproval: false,
    };
  }
  if (input.action === "validate") {
    const draftId = requiredIdentifier(input.draftId, "draft_id_required");
    return {
      method: "POST",
      path: `/api/drafts/${pathSegment(draftId)}/validate`,
      body: { expectedVersion: expectedVersion(input.expectedVersion) },
      requiresApproval: false,
    };
  }
  if (input.action === "promote") {
    const draftId = requiredIdentifier(input.draftId, "draft_id_required");
    const activeRevisionId = requiredIdentifier(
      input.expectedActiveRevisionId,
      "expected_active_revision_required",
    );
    expectedVersion(input.expectedVersion);
    requireTrustedApproval(input.approved);
    return {
      method: "POST",
      path: `/api/drafts/${pathSegment(draftId)}/promote`,
      body: { approval: true, expectedActiveRevisionId: activeRevisionId },
      headers: operationHeaders(input.idempotencyKey),
      requiresApproval: true,
    };
  }
  if (input.action === "rollback") {
    const revisionId = requiredIdentifier(
      input.revisionId,
      "revision_id_required",
    );
    const activeRevisionId = requiredIdentifier(
      input.expectedActiveRevisionId,
      "expected_active_revision_required",
    );
    requireTrustedApproval(input.approved);
    return {
      method: "POST",
      path: `/api/shiplets/${pathSegment(shipletId)}/rollback`,
      body: {
        approval: true,
        revisionId,
        expectedActiveRevisionId: activeRevisionId,
      },
      headers: operationHeaders(input.idempotencyKey),
      requiresApproval: true,
    };
  }
  if (input.action === "connect_cloudflare") {
    return {
      method: "POST",
      path: "/api/cloudflare/oauth/start",
      body: { shipletId },
      requiresApproval: false,
    };
  }
  if (input.action === "revoke_cloudflare") {
    const connectionId = requiredIdentifier(
      input.connectionId,
      "connection_id_required",
    );
    requireTrustedApproval(input.approved);
    return {
      method: "DELETE",
      path: `/api/cloudflare/connections/${pathSegment(connectionId)}`,
      body: { shipletId, approval: true },
      requiresApproval: true,
    };
  }
  if (input.action === "redeploy") {
    const revisionId = requiredIdentifier(
      input.revisionId,
      "revision_id_required",
    );
    const targetId = requiredIdentifier(input.targetId, "target_id_required");
    requireTrustedApproval(input.approved);
    return {
      method: "POST",
      path: `/api/revisions/${pathSegment(revisionId)}/deployments`,
      body: { approval: true, targetId },
      headers: operationHeaders(input.idempotencyKey),
      requiresApproval: true,
    };
  }
  if (input.action === "temporary_claim") {
    const revisionId = requiredIdentifier(
      input.revisionId,
      "revision_id_required",
    );
    requireTrustedApproval(input.approved);
    if (input.acceptedCloudflarePolicies !== true) {
      throw new Error("cloudflare_policy_acceptance_required");
    }
    const cloudflarePolicyAcceptance: CloudflareTemporaryAccountPolicyAcceptance =
      {
        ...CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES,
        acceptTermsOfService: "yes",
      };
    return {
      method: "POST",
      path: `/api/revisions/${pathSegment(revisionId)}/temporary-claims`,
      body: { approval: true, cloudflarePolicyAcceptance },
      headers: operationHeaders(input.idempotencyKey),
      requiresApproval: true,
    };
  }
  throw new Error("unknown_ownership_action");
}

function formatTime(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function statusBadge(label: string, tone: "ok" | "warn" | "error" | "info") {
  return `<span class="ownership-status ownership-status-${tone}">${escapeHtml(label)}</span>`;
}

function confirmationAttribute(message: string) {
  return `data-confirmation-message="${escapeHtml(message)}"`;
}

function promotionButton(input: {
  draft: OwnershipDraft;
  shipletId: string;
  activeRevisionId: string;
  primary: boolean;
}) {
  const revisionId = input.draft.validatedRevisionId || "unavailable";
  const ceremonyId = `ownership-preview-${pathSegment(input.draft.id)}`;
  const receiptEndpoint = `/api/shiplets/${pathSegment(input.shipletId)}/drafts/${pathSegment(input.draft.id)}/revisions/${pathSegment(revisionId)}/versions/${pathSegment(input.draft.version)}/preview-receipt`;
  const confirmation = `Promote ${input.draft.label} as revision ${revisionId} to the Shiplet-managed target? This will replace active revision ${input.activeRevisionId || "none"} for managed traffic. The prior active revision remains available for rollback.`;
  return `<button class="ownership-action${input.primary ? " ownership-action-primary" : ""}" type="button" data-shiplet-action="promote" data-action-endpoint="/api/drafts/${pathSegment(input.draft.id)}/promote" data-expected-version="${escapeHtml(input.draft.version)}" data-expected-active-revision-id="${escapeHtml(input.activeRevisionId)}" data-preview-required="true" data-preview-receipt-required="true" data-preview-receipt-endpoint="${receiptEndpoint}" data-preview-draft-id="${escapeHtml(input.draft.id)}" data-preview-revision-id="${escapeHtml(revisionId)}" data-preview-version="${escapeHtml(input.draft.version)}" data-requires-approval="true" ${confirmationAttribute(confirmation)} aria-describedby="${ceremonyId}" aria-disabled="true" disabled>Promote ${escapeHtml(input.draft.label)}</button>`;
}

function primaryRevisionAction(model: ShipletOwnershipPageModel) {
  const shipletPath = pathSegment(model.shiplet.id);
  const validatedDrafts = model.revisions.drafts.filter(
    (draft) => draft.state === "validated",
  );
  if (validatedDrafts.length > 1) {
    return `<span class="ownership-row-detail">Choose a draft to promote</span>`;
  }
  const validated = validatedDrafts[0];
  if (validated) {
    return promotionButton({
      draft: validated,
      shipletId: model.shiplet.id,
      activeRevisionId: model.shiplet.activeRevision?.id || "",
      primary: true,
    });
  }
  const validating = model.revisions.drafts.find(
    (draft) => draft.state === "validating",
  );
  if (validating) {
    return `<button class="ownership-action ownership-action-primary" type="button" disabled>Validation in progress</button>`;
  }
  const draft = model.revisions.drafts[0];
  if (draft) {
    return `<button class="ownership-action ownership-action-primary" type="button" data-shiplet-action="open-draft" data-action-endpoint="/api/drafts/${pathSegment(draft.id)}/package">Continue ${escapeHtml(draft.label)}</button>`;
  }
  if (!model.shiplet.activeRevision) {
    return `<a class="ownership-action ownership-action-primary" href="/">Prepare first revision</a>`;
  }
  return `<button class="ownership-action ownership-action-primary" type="button" data-shiplet-action="fork" data-action-endpoint="/api/shiplets/${shipletPath}/drafts">Create draft</button>`;
}

function renderManaged(model: ShipletOwnershipPageModel) {
  const active = model.shiplet.activeRevision;
  const status =
    model.managed.status === "active"
      ? statusBadge("Running", "ok")
      : model.managed.status === "degraded"
        ? statusBadge("Needs attention", "warn")
        : statusBadge("Unavailable", "error");
  const runtime =
    model.managed.runtime === "static"
      ? "Static files"
      : model.managed.runtime === "external_proxy"
        ? "External URL proxy"
        : "Worker";
  const executionMessage = model.managed.arbitraryWorkerExecution.available
    ? `<div class="ownership-notice"><p>Managed Worker execution is isolated and available for this Shiplet.</p></div>`
    : model.managed.arbitraryWorkerExecution.reason === "runtime_unavailable"
      ? `<div class="ownership-notice ownership-notice-warning"><p><strong>Managed arbitrary Worker execution is not available.</strong> The isolated managed runtime is not configured in this environment. Static artifacts still publish normally; dynamic packages need a customer-owned Cloudflare target until that prerequisite is installed.</p></div>`
      : `<div class="ownership-notice ownership-notice-warning"><p><strong>Managed arbitrary Worker execution is not available.</strong> Managed dynamic execution is not enabled for this Shiplet. Static artifacts still publish normally. Dynamic packages require the revision-aware managed gateway or a customer target with enforceable outbound mediation.</p></div>`;
  const executionNotice =
    model.managed.runtime === "static" ||
    model.managed.runtime === "external_proxy"
      ? `<details class="ownership-disclosure"><summary>Advanced runtime availability</summary>${executionMessage}</details>`
      : executionMessage;

  return `<section class="ownership-section ownership-focus" aria-labelledby="ownership-managed-title">
  <div class="ownership-section-head">
    <div>
      <span class="ownership-kicker">Default destination</span>
      <h2 id="ownership-managed-title">Shiplet-managed</h2>
      <p>Publish and review without configuring a Cloudflare account.</p>
    </div>
    ${status}
  </div>
  <div class="ownership-ledger">
    <div class="ownership-row">
      <span class="ownership-row-label">Runs on</span>
      <strong class="ownership-row-value">Shiplet-managed infrastructure</strong>
      <span class="ownership-row-detail">${escapeHtml(runtime)}</span>
    </div>
    <div class="ownership-row">
      <span class="ownership-row-label">Owner</span>
      <span class="ownership-row-value">Owned and operated by Shiplet</span>
      <span class="ownership-row-detail">Managed</span>
    </div>
    <div class="ownership-row">
      <span class="ownership-row-label">Shiplet access</span>
      <span class="ownership-row-value">Shiplet manages publishing, review access, revisions, and rollback.</span>
      <span class="ownership-row-detail">This Shiplet only</span>
    </div>
    <div class="ownership-row">
      <span class="ownership-row-label">Active revision</span>
      <span class="ownership-row-value">${active ? escapeHtml(active.label) : "No active revision yet"}</span>
      <span class="ownership-row-detail">${active ? escapeHtml(formatTime(active.createdAt)) : "Prepare a package to begin"}</span>
    </div>
  </div>
  ${executionNotice}
</section>`;
}

const DRAFT_STATE: Record<
  OwnershipDraft["state"],
  { label: string; description: string; tone: "ok" | "warn" | "error" | "info" }
> = {
  draft: {
    label: "Draft",
    description: "Changes are isolated from the active revision.",
    tone: "info",
  },
  validating: {
    label: "Validating",
    description:
      "Automated checks are running. The active revision is unchanged.",
    tone: "info",
  },
  validated: {
    label: "Validated",
    description:
      "Validated and ready to promote. Promotion creates a new active revision atomically.",
    tone: "ok",
  },
  invalid: {
    label: "Validation failed",
    description:
      "Fix the draft and validate again. The active revision is unchanged.",
    tone: "error",
  },
};

function renderDraft(
  draft: OwnershipDraft,
  showExplicitPromote: boolean,
  expectedActiveRevisionId: string,
  shipletId: string,
) {
  const state = DRAFT_STATE[draft.state] || {
    label: "Unknown draft state",
    description:
      "Shiplet cannot act on this draft until its state is refreshed.",
    tone: "warn" as const,
  };
  const previewUrl =
    draft.state === "validated" && draft.validatedRevisionId
      ? revisionPreviewPath({
          shipletId,
          draftId: draft.id,
          revisionId: draft.validatedRevisionId,
          draftVersion: draft.version,
        })
      : null;
  const ceremonyId = `ownership-preview-${pathSegment(draft.id)}`;
  return `<article class="ownership-draft">
  <div class="ownership-draft-head">
    <div>
      <h3>${escapeHtml(draft.label)}</h3>
      <p>${escapeHtml(draft.summary || state.description)}</p>
    </div>
    ${statusBadge(state.label, state.tone)}
  </div>
  ${draft.summary ? `<p>${escapeHtml(state.description)}</p>` : ""}
  ${draft.validationSummary ? `<div class="ownership-notice ${draft.state === "invalid" ? "ownership-notice-error" : ""}"><p>${escapeHtml(draft.validationSummary)}</p></div>` : ""}
  <div class="ownership-target-meta"><span>Updated ${escapeHtml(formatTime(draft.updatedAt))}</span><span>Forked from <code>${escapeHtml(draft.parentRevisionId)}</code></span></div>
  <div class="ownership-actions" style="margin-top: 11px;">
    <button class="ownership-action" type="button" data-shiplet-action="compare" data-draft-package-endpoint="/api/drafts/${pathSegment(draft.id)}/package" data-base-package-endpoint="/api/shiplets/${pathSegment(shipletId)}/revisions/${pathSegment(expectedActiveRevisionId || draft.parentRevisionId)}/package" data-expected-version="${escapeHtml(draft.version)}">${expectedActiveRevisionId ? "Compare with active revision" : "Compare with base revision"}</button>
    ${
      draft.state === "draft" || draft.state === "invalid"
        ? `<button class="ownership-action" type="button" data-shiplet-action="validate" data-action-endpoint="/api/drafts/${pathSegment(draft.id)}/validate" data-expected-version="${escapeHtml(draft.version)}">Validate ${escapeHtml(draft.label)}</button>`
        : ""
    }
    ${
      draft.state === "validated" && showExplicitPromote
        ? promotionButton({
            draft,
            shipletId,
            activeRevisionId: expectedActiveRevisionId,
            primary: false,
          })
        : ""
    }
    ${previewUrl ? `<a class="ownership-action" href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener" data-shiplet-action="preview" data-preview-draft-id="${escapeHtml(draft.id)}" data-preview-revision-id="${escapeHtml(draft.validatedRevisionId)}" data-preview-version="${escapeHtml(draft.version)}" aria-describedby="${ceremonyId}">Preview ${escapeHtml(draft.label)}</a>` : ""}
  </div>
  ${draft.state === "validated" ? `<p class="ownership-session-note" id="${ceremonyId}" data-preview-ceremony-status>${previewUrl ? "Open the sealed preview in this browser session to enable promotion. Shiplet requires a kernel receipt bound to your identity and this exact draft, revision, and version." : "Promotion is unavailable because the exact sealed preview revision was not recorded. Validate the draft again."}</p>` : ""}
</article>`;
}

function renderRevisions(model: ShipletOwnershipPageModel) {
  const shipletPath = pathSegment(model.shiplet.id);
  const validatedDraftCount = model.revisions.drafts.filter(
    (draft) => draft.state === "validated",
  ).length;
  const drafts = model.revisions.drafts.length
    ? model.revisions.drafts
        .map((draft) =>
          renderDraft(
            draft,
            validatedDraftCount > 1,
            model.shiplet.activeRevision?.id || "",
            model.shiplet.id,
          ),
        )
        .join("")
    : `<div class="ownership-secondary"><h3>No drafts in progress</h3><p>Fork the active revision to change the artifact, widget, workflow, MCP tools, or instructions without affecting reviewers.</p></div>`;
  const history = model.revisions.history.length
    ? `<div class="ownership-ledger">${model.revisions.history
        .map(
          (revision) => `<div class="ownership-row">
      <span class="ownership-row-label">${escapeHtml(revision.label)}</span>
      <span class="ownership-row-value">${revision.status === "rolled_back" ? "Previously restored" : "Known-good revision"}</span>
      <button class="ownership-action" type="button" data-shiplet-action="rollback" data-action-endpoint="/api/shiplets/${shipletPath}/rollback" data-revision-id="${escapeHtml(revision.id)}" data-expected-active-revision-id="${escapeHtml(model.shiplet.activeRevision?.id || "")}" data-requires-approval="true" ${confirmationAttribute(`Roll back the Shiplet-managed target from ${model.shiplet.activeRevision?.label || "no active revision"} (${model.shiplet.activeRevision?.id || "none"}) to ${revision.label} (${revision.id})? Managed traffic will switch to the selected known-good revision. The current revision remains in immutable history.`)}>Roll back to ${escapeHtml(revision.label)}</button>
    </div>`,
        )
        .join("")}</div>`
    : `<p>No previous revisions are available for rollback.</p>`;
  const sealedRevisions = model.revisions.sealed?.length
    ? `<div class="ownership-ledger">${model.revisions.sealed
        .map(
          (
            revision,
          ) => `<div class="ownership-row" data-sealed-revision-id="${escapeHtml(revision.id)}">
      <span class="ownership-row-label">${escapeHtml(revision.label)}</span>
      <span class="ownership-row-value">Validated, never activated</span>
      <span class="ownership-row-detail">Sealed ${escapeHtml(formatTime(revision.createdAt))}</span>
    </div>`,
        )
        .join("")}</div>`
    : `<p>No sealed, never-activated revisions.</p>`;

  return `<section class="ownership-section" aria-labelledby="ownership-revisions-title">
  <div class="ownership-section-head">
    <div>
      <span class="ownership-kicker">Revision control</span>
      <h2 id="ownership-revisions-title">Draft, validate, then promote</h2>
      <p>A running revision never edits itself. Failed validation or deployment leaves the active revision intact.</p>
    </div>
    <div class="ownership-actions">${primaryRevisionAction(model)}</div>
  </div>
  <div class="ownership-split">
    <div>${drafts}</div>
    <aside class="ownership-secondary" aria-label="Rollback history">
      <div class="ownership-secondary-section">
        <h3>Known-good history</h3>
        <p>Only revisions with activation evidence can be restored.</p>
        ${history}
      </div>
      <div class="ownership-secondary-section">
        <h3>Validated revisions not yet activated</h3>
        <p>These sealed revisions are available for inspection, not rollback.</p>
        ${sealedRevisions}
      </div>
    </aside>
  </div>
</section>`;
}

function cloudflareState(model: ShipletOwnershipPageModel) {
  const cloudflare = model.cloudflare;
  if (!cloudflare.connectAvailable) {
    return {
      tone: "warn" as const,
      label: "Not configured",
      title: "Cloudflare connection is not configured",
      copy: "The scoped OAuth control plane is unavailable. Shiplet-managed publishing remains available. No API token is needed here.",
    };
  }
  if (cloudflare.state === "denied") {
    return {
      tone: "warn" as const,
      label: "Not connected",
      title: "Cloudflare access was not granted",
      copy: "Nothing was deployed and Shiplet received no account access. Shiplet-managed publishing remains available.",
    };
  }
  if (cloudflare.state === "revoked") {
    return {
      tone: "warn" as const,
      label: "Revoked",
      title: "Shiplet access is revoked",
      copy: "The last customer-owned deployment keeps running in your account. Future updates are blocked until you reconnect. Shiplet-managed publishing remains available.",
    };
  }
  if (cloudflare.state === "error") {
    return {
      tone: "error" as const,
      label: "Status unavailable",
      title: "Cloudflare status could not be loaded",
      copy: "No deployment action was taken. Retry after the connection recovers. Shiplet-managed publishing remains available.",
    };
  }
  if (cloudflare.state === "connected") {
    return {
      tone: "ok" as const,
      label: "Connected",
      title: "Runs in your Cloudflare account",
      copy: "Owned by you. Shiplet can deploy this Shiplet to the selected account while the connection remains active.",
    };
  }
  return {
    tone: "info" as const,
    label: "Optional",
    title: "Connect your Cloudflare account",
    copy: "Graduate a revision to customer-owned infrastructure when you want direct runtime ownership. Shiplet-managed publishing remains available.",
  };
}

function targetRevisionLabel(
  model: ShipletOwnershipPageModel,
  revisionId?: string | null,
) {
  if (!revisionId) return "No deployed revision";
  if (model.shiplet.activeRevision?.id === revisionId) {
    return model.shiplet.activeRevision.label;
  }
  const history = model.revisions.history.find(
    (item) => item.id === revisionId,
  );
  return history?.label || revisionId;
}

function renderTarget(
  model: ShipletOwnershipPageModel,
  target: CustomerDeploymentTarget,
) {
  const isRevoked = model.cloudflare.state === "revoked";
  const badge = target.detached
    ? statusBadge("Detached", "warn")
    : isRevoked
      ? target.status === "healthy"
        ? statusBadge("Last known healthy", "warn")
        : statusBadge("Health unknown", "warn")
      : target.status === "healthy"
        ? target.healthVerifiedAt
          ? statusBadge("Healthy", "ok")
          : statusBadge("Recorded healthy", "warn")
        : target.status === "pending"
          ? statusBadge("Deploying", "info")
          : target.status === "offline"
            ? statusBadge("Offline", "warn")
            : target.status === "deployment_failed"
              ? statusBadge("Deployment failed", "error")
              : statusBadge("Unknown deployment state", "warn");
  const failure =
    target.status === "deployment_failed"
      ? `<div class="ownership-notice ownership-notice-error"><p><strong>${escapeHtml(target.failureSummary || "The deployment did not pass its health check.")}</strong> ${target.running ? "The active revision did not change. The last known-good deployment is still running." : "The active revision did not change. Shiplet could not confirm a running known-good deployment."}</p></div>`
      : "";
  const updateState = target.updatesAvailable
    ? "Updates available through Shiplet"
    : "Future updates are blocked";
  const drift =
    target.drift === "in_sync"
      ? "Drift: In sync"
      : target.drift === "drifted"
        ? "Drift: External changes detected"
        : "Drift: Not verified";
  const canRedeploy =
    !target.detached &&
    target.updatesAvailable &&
    Boolean(model.shiplet.activeRevision) &&
    (target.status === "deployment_failed" ||
      target.status === "offline" ||
      target.drift === "drifted");
  return `<article class="ownership-target">
  <div class="ownership-target-head"><h3>${escapeHtml(target.label)}</h3>${badge}</div>
  <p>Owned by you${target.running ? (target.healthVerifiedAt ? `. Shiplet last verified the Worker running ${escapeHtml(formatTime(target.healthVerifiedAt))}.` : ". The last deployment record reports the Worker running; current health is unverified.") : ". The last deployment record does not report a running Worker."}</p>
  <div class="ownership-target-meta">
    <span>${escapeHtml(targetRevisionLabel(model, target.activeRevisionId))}</span>
    <span>${escapeHtml(updateState)}</span>
    <span>${escapeHtml(drift)}</span>
    ${target.lastDeployedAt ? `<span>Deployed ${escapeHtml(formatTime(target.lastDeployedAt))}</span>` : ""}
    <span>${target.healthVerifiedAt ? `Health checked ${escapeHtml(formatTime(target.healthVerifiedAt))}` : target.status === "healthy" ? "Recorded healthy, verification time unavailable" : "Health check time not reported"}</span>
  </div>
  ${failure}
  ${isRevoked || target.detached ? `<div class="ownership-notice ownership-notice-warning"><p>Shiplet cannot recheck health after access is revoked or the target is detached, and drift is no longer verifiable. Cloudflare retains the last installed deployment.</p></div>` : ""}
  ${canRedeploy ? `<div class="ownership-actions" style="margin-top: 10px;"><button class="ownership-action" type="button" data-shiplet-action="redeploy" data-action-endpoint="/api/revisions/${pathSegment(model.shiplet.activeRevision?.id)}/deployments" data-target-id="${escapeHtml(target.id)}" data-requires-approval="true" ${confirmationAttribute(`Redeploy ${model.shiplet.activeRevision?.label || "active revision"} (${model.shiplet.activeRevision?.id || "unknown"}) to ${target.label} (${target.id})? This replaces that customer target only if deployment and health checks pass. The Shiplet active revision remains unchanged.`)}>Redeploy active revision</button></div>` : ""}
</article>`;
}

const KNOWN_CLOUDFLARE_SCOPES: Record<string, string> = {
  "workers.scripts.read":
    "Read Worker script metadata and code across the selected account",
  "workers.scripts.write":
    "Create, update, and delete Worker scripts across the selected account, including script settings, secrets, and cron triggers",
};

function renderCloudflareAuthority(model: ShipletOwnershipPageModel) {
  const account = model.cloudflare.accountLabel
    ? `<div class="ownership-row"><span class="ownership-row-label">Account</span><strong class="ownership-row-value">${escapeHtml(model.cloudflare.accountLabel)}</strong><span class="ownership-row-detail">Customer-owned</span></div>`
    : "";
  const scopes = model.cloudflare.scopes;
  if (!scopes?.length) {
    return `<div class="ownership-ledger">${account}
      <div class="ownership-row"><span class="ownership-row-label">Cloudflare grant</span><span class="ownership-row-value">Granted scope details are unavailable. Review the connection before authorizing a deployment or revocation.</span><span class="ownership-row-detail">Authority unknown</span></div>
    </div>`;
  }
  const uniqueScopes = [...new Set(scopes)];
  const unknownScopes = uniqueScopes.filter(
    (scope) => !KNOWN_CLOUDFLARE_SCOPES[scope],
  );
  const scopeRows = uniqueScopes
    .map(
      (scope) =>
        `<div class="ownership-row"><span class="ownership-row-label"><code>${escapeHtml(scope)}</code></span><span class="ownership-row-value">${escapeHtml(KNOWN_CLOUDFLARE_SCOPES[scope] || "Additional scope requires review in Cloudflare before continuing")}</span><span class="ownership-row-detail">${KNOWN_CLOUDFLARE_SCOPES[scope] ? "Account-level scope" : "Unknown reach"}</span></div>`,
    )
    .join("");
  const reach =
    uniqueScopes.includes("workers.scripts.read") &&
    uniqueScopes.includes("workers.scripts.write")
      ? `<div class="ownership-row"><span class="ownership-row-label">Account reach</span><span class="ownership-row-value">Cloudflare grants account-level access to read and write Workers scripts</span><span class="ownership-row-detail">Not per-Worker</span></div>`
      : "";
  const knownExclusions =
    unknownScopes.length === 0
      ? `<div class="ownership-row"><span class="ownership-row-label">Not requested</span><span class="ownership-row-value">No access to zones, DNS, account members, WorkOS identity, or Shiplet state</span><span class="ownership-row-detail">Outside the listed scopes</span></div>`
      : `<div class="ownership-notice ownership-notice-warning"><p><strong>Additional scope requires review.</strong> Shiplet cannot summarize the full reach of ${escapeHtml(unknownScopes.join(", "))}.</p></div>`;
  return `<div class="ownership-ledger">
    ${account}
    ${reach}
    ${scopeRows}
    <div class="ownership-row"><span class="ownership-row-label">Shiplet policy</span><span class="ownership-row-value">Shiplet policy restricts deployment operations to this Shiplet&#39;s target and records each change</span><span class="ownership-row-detail">Kernel enforced</span></div>
    ${knownExclusions}
  </div>`;
}

function renderCloudflare(model: ShipletOwnershipPageModel) {
  const state = cloudflareState(model);
  const connected = model.cloudflare.state === "connected";
  const showAuthority = connected || model.cloudflare.state === "revoked";
  const authority = showAuthority ? renderCloudflareAuthority(model) : "";
  const targets = model.cloudflare.targets.length
    ? model.cloudflare.targets
        .map((target) => renderTarget(model, target))
        .join("")
    : `<div class="ownership-secondary"><h3>No customer deployments</h3><p>Connect an account, then choose a validated revision and target. Managed hosting continues until you decide to deploy.</p></div>`;
  const connectAction = model.cloudflare.connectAvailable
    ? `<button class="ownership-action" type="button" data-shiplet-action="connect-cloudflare" data-action-endpoint="/api/cloudflare/oauth/start" data-shiplet-id="${escapeHtml(model.shiplet.id)}">${model.cloudflare.state === "revoked" ? "Reconnect Cloudflare" : connected && model.cloudflare.targets.length === 0 ? "Select account and target" : connected ? "Manage connection" : "Connect Cloudflare"}</button>`
    : "";
  const revokeAction =
    connected && model.cloudflare.connectionId
      ? `<button class="ownership-action" type="button" data-shiplet-action="revoke-cloudflare" data-action-endpoint="/api/cloudflare/connections/${pathSegment(model.cloudflare.connectionId)}" data-requires-approval="true" ${confirmationAttribute(`Revoke Shiplet access to ${model.cloudflare.accountLabel || "the selected Cloudflare account"} through connection ${model.cloudflare.connectionId}? Existing customer-owned deployments keep running, but Shiplet updates and health checks stop until you reconnect.`)}>Revoke Shiplet access</button>`
      : "";

  return `<section class="ownership-section" aria-labelledby="ownership-cloudflare-title">
  <div class="ownership-section-head">
    <div>
      <span class="ownership-kicker">Customer-owned destination</span>
      <h2 id="ownership-cloudflare-title">${escapeHtml(state.title)}</h2>
      <p>${escapeHtml(state.copy)}</p>
    </div>
    ${statusBadge(state.label, state.tone)}
  </div>
  <div class="ownership-notice ownership-notice-warning"><p><strong>Static packages can deploy here now.</strong> Advanced Worker packages remain blocked until an enforceable outbound mediation path is configured; Shiplet will not deploy arbitrary customer-owned code with unrestricted network access.</p></div>
  ${authority}
  <div class="ownership-actions" style="margin-top: 14px;">${connectAction}${revokeAction}</div>
  <div style="margin-top: 18px;">${targets}</div>
</section>`;
}

function renderClaim(model: ShipletOwnershipPageModel) {
  const claim = model.temporaryClaim;
  const state =
    claim.status === "awaiting_claim"
      ? {
          label: "Awaiting claim",
          tone: "info" as const,
          copy: "The temporary deployment is ready to claim through the trusted Cloudflare flow.",
        }
      : claim.status === "claimed"
        ? {
            label: "Claimed",
            tone: "ok" as const,
            copy: "The deployment was claimed. Connect Cloudflare separately before making future updates.",
          }
        : claim.status === "expired"
          ? {
              label: "Expired",
              tone: "warn" as const,
              copy: "The temporary claim window expired. Create a new isolated preview if needed.",
            }
          : claim.status === "unavailable"
            ? {
                label: "Unavailable",
                tone: "warn" as const,
                copy: "Temporary preview and claim is not available in this environment.",
              }
            : {
                label: "Available",
                tone: "info" as const,
                copy: "Create a temporary preview that can be claimed into a Cloudflare account.",
              };
  const action =
    claim.status === "ready"
      ? model.shiplet.activeRevision
        ? `<button class="ownership-action" type="button" data-shiplet-action="create-temporary-claim" data-action-endpoint="/api/revisions/${pathSegment(model.shiplet.activeRevision.id)}/temporary-claims" data-requires-approval="true" data-cloudflare-policy-acceptance="required" ${confirmationAttribute(`Create a temporary Cloudflare claim target for ${model.shiplet.activeRevision.label} (${model.shiplet.activeRevision.id})? A time-limited preview will be created under Cloudflare's temporary-account policies. Future updates require a separate OAuth connection.`)}>Create temporary preview</button>`
        : `<button class="ownership-action" type="button" disabled>Active revision required</button>`
      : claim.status === "awaiting_claim"
        ? claim.targetId
          ? `<button class="ownership-action" type="button" data-shiplet-action="continue-temporary-claim" data-action-endpoint="/api/temporary-claims/${pathSegment(claim.targetId)}/claim" data-requires-user-intent="true">Continue trusted claim flow</button>`
          : `<button class="ownership-action" type="button" disabled>Claim target unavailable</button>`
        : "";
  const policyAcceptance =
    claim.status === "ready"
      ? `<label class="ownership-policy"><input type="checkbox" data-cloudflare-policy-checkbox> I accept the <a href="${escapeHtml(CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES.termsOfService)}" target="_blank" rel="noreferrer">Cloudflare Terms of Service</a> and acknowledge the <a href="${escapeHtml(CLOUDFLARE_TEMPORARY_ACCOUNT_POLICIES.privacyPolicy)}" target="_blank" rel="noreferrer">Cloudflare Privacy Policy</a> for this temporary account.</label>`
      : "";

  return `<div>
  <div class="ownership-target-head"><h3>Temporary preview and claim</h3>${statusBadge(state.label, state.tone)}</div>
  <p>${escapeHtml(state.copy)} Future updates require a separate Cloudflare OAuth connection.</p>
  ${claim.expiresAt ? `<p class="ownership-row-detail">Expires ${escapeHtml(formatTime(claim.expiresAt))}</p>` : ""}
  ${policyAcceptance}
  <div class="ownership-actions">${action}</div>
</div>`;
}

function renderPortability(model: ShipletOwnershipPageModel) {
  const shipletPath = pathSegment(model.shiplet.id);
  return `<section class="ownership-section" aria-labelledby="ownership-portability-title">
  <div class="ownership-section-head">
    <div>
      <span class="ownership-kicker">Portability</span>
      <h2 id="ownership-portability-title">Claim or export</h2>
      <p>Move code and schema without moving private runtime data or platform authority.</p>
    </div>
    ${model.export.detached ? statusBadge("Detached package", "info") : ""}
  </div>
  <div class="ownership-split">
    ${renderClaim(model)}
    <div class="ownership-secondary">
      <h3>${model.export.detached ? "Detached package" : "Portable package"}</h3>
      <p>Exports include package files and lineage, never state, credentials, grants, or audit history.</p>
      <p>Eject opens portable package JSON in the browser. It does not detach a deployment or revoke Shiplet access.</p>
      <div class="ownership-actions">
        ${model.export.available ? `<a class="ownership-action" href="/api/shiplets/${shipletPath}/package?disposition=eject" data-shiplet-action="export" data-export-mode="eject">Export package</a>` : `<button class="ownership-action" type="button" disabled>Export unavailable</button>`}
      </div>
    </div>
  </div>
</section>`;
}

function renderLoading() {
  return `<section class="ownership-section" aria-busy="true" aria-labelledby="ownership-loading-title">
  <h2 id="ownership-loading-title">Ownership status</h2>
  <div class="ownership-skeleton" aria-hidden="true"><span class="ownership-skeleton-line"></span><span class="ownership-skeleton-line"></span></div>
  <p role="status">Loading ownership and revision status</p>
</section>`;
}

function renderError(model: ShipletOwnershipPageModel) {
  return `<section class="ownership-section" aria-labelledby="ownership-error-title">
  <h2 id="ownership-error-title">Ownership status is unavailable</h2>
  <div class="ownership-notice ownership-notice-error" role="alert"><p>${escapeHtml(model.errorSummary || "Shiplet could not load revision and deployment status. No change was made.")}</p></div>
  <div class="ownership-actions" style="margin-top: 14px;"><a class="ownership-action ownership-action-primary" href="">Retry status</a></div>
</section>`;
}

function renderOffline() {
  return `<section class="ownership-section" aria-labelledby="ownership-offline-title">
  <h2 id="ownership-offline-title">You appear to be offline</h2>
  <div class="ownership-notice ownership-notice-warning" role="status"><p>No deployment or revision change was attempted. Reconnect before relying on ownership status.</p></div>
  <div class="ownership-actions" style="margin-top: 14px;"><a class="ownership-action ownership-action-primary" href="">Retry when online</a></div>
</section>`;
}

function renderPermissionDenied() {
  return `<section class="ownership-section" aria-labelledby="ownership-permission-title">
  <h2 id="ownership-permission-title">Ownership access is required</h2>
  <div class="ownership-notice ownership-notice-warning" role="alert"><p>Ask a Shiplet owner for access to revisions and deployment settings. No private deployment details are shown.</p></div>
  <div class="ownership-actions" style="margin-top: 14px;"><a class="ownership-action ownership-action-primary" href="/shiplets">Return to Shiplets</a></div>
</section>`;
}

export function AdaptOwnershipPageModel(
  input: OwnershipPageAdapterInput,
): ShipletOwnershipPageModel {
  if (input.deploymentStatus.shipletId !== input.shiplet.id) {
    throw new Error("deployment_status_shiplet_mismatch");
  }
  const statusTargets = input.deploymentStatus.customerCloudflare.targets;
  const activeConnection = statusTargets.find(
    (target) => target.connection?.status === "active",
  )?.connection;
  const revokedConnection = statusTargets.find(
    (target) => target.connection?.status === "revoked",
  )?.connection;
  const connectionState: ShipletOwnershipPageModel["cloudflare"]["state"] =
    activeConnection ? "connected" : revokedConnection ? "revoked" : "empty";
  const accountId = statusTargets.find(
    (target) => typeof target.providerAccountId === "string",
  )?.providerAccountId;
  const targets: CustomerDeploymentTarget[] = statusTargets.map((target) => {
    const deployment = target.lastDeployment;
    const evidence = input.targetEvidenceById?.[target.id];
    const status: CustomerDeploymentTarget["status"] = target.detached
      ? "offline"
      : !deployment
        ? "pending"
        : deployment.status === "healthy"
          ? "healthy"
          : deployment.status === "failed" ||
              deployment.status === "deployment_failed"
            ? "deployment_failed"
            : "offline";
    return {
      id: target.id,
      label: deployment?.scriptName || "Cloudflare Worker",
      ownership: "customer",
      status,
      activeRevisionId: deployment?.revisionId || null,
      lastDeployedAt: deployment?.deployedOn || null,
      healthVerifiedAt: evidence?.healthVerifiedAt || null,
      drift: evidence?.drift || "unknown",
      detached: target.detached,
      updatesAvailable: Boolean(
        deployment?.updatesAvailable && !target.detached,
      ),
      running: Boolean(deployment?.running),
      failureSummary: evidence?.failureSummary || null,
    };
  });

  return {
    shiplet: {
      ...input.shiplet,
      activeRevision: input.activeRevision,
    },
    managed: {
      status:
        input.deploymentStatus.managed.status === "archived"
          ? "unavailable"
          : input.deploymentStatus.managed.runtime === "worker" &&
              !input.deploymentStatus.managed.arbitraryWorkerExecution.available
            ? "degraded"
            : "active",
      runtime: input.deploymentStatus.managed.runtime,
      arbitraryWorkerExecution: {
        ...input.deploymentStatus.managed.arbitraryWorkerExecution,
      },
    },
    revisions: {
      drafts: input.drafts,
      history: input.history,
      ...(input.sealed ? { sealed: input.sealed } : {}),
    },
    cloudflare: {
      state: connectionState,
      connectAvailable:
        input.deploymentStatus.customerCloudflare.connectAvailable,
      reason: input.deploymentStatus.customerCloudflare.reason || null,
      connectionId: activeConnection?.id || revokedConnection?.id || null,
      accountLabel:
        input.cloudflareAuthority?.accountLabel || accountId || null,
      ...(input.cloudflareAuthority?.scopes
        ? { scopes: [...input.cloudflareAuthority.scopes] }
        : {}),
      targets,
    },
    temporaryClaim: { ...input.temporaryClaim },
    export: { ...input.export },
    viewState: "ready",
  };
}

export function BuildShipletOwnershipPage(
  model: ShipletOwnershipPageModel,
): ShipletOwnershipPage {
  const shipletPath = pathSegment(model.shiplet.id);
  const view = model.viewState || "ready";
  const content =
    view === "loading"
      ? renderLoading()
      : view === "error"
        ? renderError(model)
        : view === "offline"
          ? renderOffline()
          : view === "permission_denied"
            ? renderPermissionDenied()
            : `${renderManaged(model)}${renderRevisions(model)}${renderCloudflare(model)}${renderPortability(model)}`;

  return {
    title: `Ownership · ${model.shiplet.name} · Shiplet`,
    description: `Revision and deployment ownership for ${model.shiplet.name}.`,
    body: `${OWNERSHIP_PAGE_CSS}
<div class="ownership-page" data-shiplet-ownership-page data-view-state="${escapeHtml(view)}">
  <header class="ownership-page-head">
    <div>
      <span class="ownership-kicker">${escapeHtml(model.shiplet.name)}</span>
      <h1>Where this Shiplet runs</h1>
      <p>See the active revision, prepare the next change, and choose who owns each deployment.</p>
    </div>
    <nav class="ownership-nav" aria-label="Shiplet sections">
      <a href="/shiplets/${shipletPath}">Review</a>
      <a href="/shiplets/${shipletPath}/ownership" aria-current="page">Ownership</a>
    </nav>
  </header>
  ${content}
</div>`,
  };
}

export function BuildOwnershipFailurePage(input: {
  shipletId?: string;
  shipletName?: string;
  viewState: "error" | "offline" | "permission_denied";
  errorSummary?: string | null;
}): ShipletOwnershipPage {
  return BuildShipletOwnershipPage({
    shiplet: {
      id: input.shipletId || "shiplet",
      name: input.shipletName || "Shiplet",
      activeRevision: null,
    },
    managed: {
      status: "unavailable",
      runtime: "static",
      arbitraryWorkerExecution: {
        available: false,
        reason: "runtime_unavailable",
      },
    },
    revisions: { drafts: [], history: [], sealed: [] },
    cloudflare: {
      state: "empty",
      connectAvailable: false,
      targets: [],
    },
    temporaryClaim: { status: "unavailable" },
    export: { available: false },
    viewState: input.viewState,
    errorSummary: input.errorSummary || null,
  });
}
