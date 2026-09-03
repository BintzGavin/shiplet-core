import type {
  CapabilityActor,
  CapabilityGrant,
  TrustedApprovalBinding,
} from "./capability-broker";

export interface CustomMcpMutationApprovalRequest {
  /** Legacy human-invoker shape; mutually exclusive with explicit identities. */
  trustedActor?: CapabilityActor;
  /** Kernel-owned invoker identity; never derived from package input. */
  invokerActor?: CapabilityActor;
  /** Kernel-authenticated human who may approve this exact invocation. */
  trustedApprover?: Readonly<{ kind: "human"; id: string }>;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  toolName: string;
  parentRequestId: string;
  childRequestId: string;
  toolInput: unknown;
  declaredCapabilities: readonly string[];
  capability: string;
  resource: string;
  effect: "mutation";
  capabilityInput: unknown;
  ttlMs: number;
}

export interface CustomMcpApprovalLimits {
  maxApprovalTtlMs: number;
  maxInputBytes: number;
  maxResultBytes: number;
  maxMetadataBytes: number;
  claimLeaseMs: number;
  dispatchLeaseMs: number;
}

export type CustomMcpApprovalDenied = {
  ok: false;
  code: "approval_denied";
};

export type CustomMcpApprovalChallenge = {
  approvalRequestId: string;
  /**
   * A one-time value for the trusted browser host. It must never be sent to a
   * package handler, serialized runtime, MCP response, analytics, or logs.
   */
  confirmationNonce: string;
  expiresAt: number;
};

export type ResumableCustomMcpApproval = {
  /** Correlation only; this value grants no authority. */
  approvalRequestId: string;
  expiresAt: number;
  /** Trusted same-origin UI route. This path grants no authority by itself. */
  confirmationPath: string;
};

export type CustomMcpMutationDispatchOutcome =
  | { status: "committed"; journalId: string; value: unknown }
  | { status: "aborted"; journalId: string }
  | { status: "reconciliation_required"; journalId: string };

export interface ConstrainedCustomMcpMutation {
  actor: Readonly<CapabilityActor>;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  toolName: string;
  parentRequestId: string;
  /** Kernel-held approval identity used by the concrete mutation boundary. */
  requestId: string;
  approval: Readonly<{
    approvalRequestId: string;
    activationGeneration: number;
    expiresAt: number;
    dispatchLeaseExpiresAt: number;
    state: "dispatching";
  }>;
  action: string;
  resource: string;
  effect: "mutation";
  input: unknown;
}

export interface CustomMcpApprovalService {
  getOrBeginResumable(
    request: CustomMcpMutationApprovalRequest,
  ): Promise<ResumableCustomMcpApproval>;
  claim(input: {
    request: CustomMcpMutationApprovalRequest;
    grant: CapabilityGrant;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
  revoke(input: {
    approvalRequestId: string;
    trustedActor: CapabilityActor;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
  dispatchApprovedMutation(input: {
    request: CustomMcpMutationApprovalRequest;
    effect: (
      request: ConstrainedCustomMcpMutation,
    ) => Promise<CustomMcpMutationDispatchOutcome>;
  }): Promise<CustomMcpMutationDispatchOutcome>;
  /**
   * Kernel-internal entry point. It accepts only a one-use proof minted by
   * createCustomMcpApprovalConfirmationRoute after authentication and CSRF
   * verification; plain objects and package metadata always fail closed.
   */
  confirmResumableFromTrustedRoute(input: {
    approvalRequestId: string;
    proof: unknown;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
  denyResumableFromTrustedRoute(input: {
    approvalRequestId: string;
    proof: unknown;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
  readTrustedConfirmation(input: {
    approvalRequestId: string;
    trustedActor: CapabilityActor;
  }): Promise<
    | {
        ok: true;
        approval: {
          approvalRequestId: string;
          actionSummary: string;
          changeSummary: string;
          resourceSummary: string;
          tool: {
            name: string;
            trust: "untrusted_package_content";
          };
          invoker: {
            kind: CapabilityActor["kind"];
            label: string;
          };
          scope: {
            shipletId: string;
            revisionId: string;
            activationGeneration: number;
          };
          review: {
            trust: "untrusted_quoted_data";
            target: {
              capability: string;
              resource: string;
            };
            input: unknown;
          };
          expiresAt: number;
          trust: "trusted_kernel";
        };
      }
    | CustomMcpApprovalDenied
  >;
  recoverApprovalIssuance(input: {
    approvalRequestId: string;
    trustedActor: CapabilityActor;
  }): Promise<{ ok: true; status: "compensated" } | CustomMcpApprovalDenied>;
  recoverStuckClaim(input: {
    approvalRequestId: string;
    trustedActor: CapabilityActor;
  }): Promise<
    | { ok: true; status: "compensated" | "reconciliation_required" }
    | CustomMcpApprovalDenied
  >;
  recoverStuckDispatch(input: {
    approvalRequestId: string;
    trustedActor: CapabilityActor;
  }): Promise<
    { ok: true; status: "reconciliation_required" } | CustomMcpApprovalDenied
  >;
}

/**
 * Compatibility-only nonce ceremony. Keep this object inside the trusted
 * kernel; resumable MCP/package code receives CustomMcpApprovalService only.
 */
export interface LegacyCustomMcpNonceApprovalCeremony {
  begin(input: {
    request: CustomMcpMutationApprovalRequest;
    grant: CapabilityGrant;
  }): Promise<CustomMcpApprovalChallenge>;
  confirm(input: {
    approvalRequestId: string;
    confirmationNonce: string;
    trustedActor: CapabilityActor;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
}

export interface D1CustomMcpApprovalKernel extends CustomMcpApprovalService {
  readonly legacyNonceCeremony: LegacyCustomMcpNonceApprovalCeremony;
}

export interface CustomMcpAuthoritativeGrantResolution {
  grant: CapabilityGrant;
  activationFence: { revisionId: string; generation: number };
}

export interface CustomMcpAtomicDispatchAuthorityResolution {
  authorized: true;
  activationFence: { revisionId: string; generation: number };
  grant: {
    id: string;
    generation: number;
    expiresAt: number;
    revokedAt: null;
  };
  approval: {
    digest: string;
    expiresAt: number;
    revokedAt: null;
  };
}

export interface D1CustomMcpApprovalServiceOptions {
  db: D1Database;
  now: () => number;
  limits: CustomMcpApprovalLimits;
  resolveActiveRevision(shipletId: string): Promise<{
    revisionId: string | null;
    activationGeneration: number;
  } | null>;
  /** Must be idempotent for the supplied non-authority idempotency key. */
  issueTrustedApproval(input: {
    binding: TrustedApprovalBinding;
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<{ approvalId: string }>;
  /** Resolve from the kernel authority store; never echo the caller's grant. */
  resolveCapabilityGrant(input: {
    grantId: string;
    grantGeneration: number;
    expected: {
      actor: Readonly<CapabilityActor>;
      shipletId: string;
      revisionId: string;
      activationGeneration: number;
      action: string;
      resource: string;
    };
  }): Promise<CustomMcpAuthoritativeGrantResolution | null>;
  /**
   * MUST read activation, grant, and approval state from one authoritative
   * transaction/snapshot. This is the only external authority decision used
   * immediately before a side effect.
   */
  resolveDispatchAuthorityAtomically(input: {
    now: number;
    actor: Readonly<CapabilityActor>;
    shipletId: string;
    revisionId: string;
    activationGeneration: number;
    grantId: string;
    grantGeneration: number;
    approvalDigest: string;
    binding: TrustedApprovalBinding;
    idempotencyKey: string;
  }): Promise<CustomMcpAtomicDispatchAuthorityResolution | null>;
  /** Idempotently revoke authority without recovering or accepting a bearer. */
  revokeTrustedApproval(input: {
    approvalDigest: string;
    idempotencyKey: string;
  }): Promise<{ ok: true } | { ok: false }>;
  /** Kernel-internal sealing hook; defaults to SHA-256. */
  digestTrustedApprovalId?(approvalId: string): Promise<string>;
  /** Idempotently revoke an issued approval when durable finalization fails. */
  compensateTrustedApproval(input: {
    approvalId: string;
    binding: TrustedApprovalBinding;
    idempotencyKey: string;
  }): Promise<{ ok: true } | { ok: false }>;
  /** Reconcile an uncertain issuance by idempotency key without recovering a bearer. */
  reconcileTrustedApprovalIssuance(input: {
    bindingDigest: string;
    idempotencyKey: string;
  }): Promise<{ status: "compensated" } | { status: "pending" }>;
}

export interface TrustedCustomMcpApprovalInvocation {
  /** Legacy human-invoker shape; mutually exclusive with explicit identities. */
  trustedActor?: CapabilityActor;
  invokerActor?: CapabilityActor;
  trustedApprover?: Readonly<{ kind: "human"; id: string }>;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  toolName: string;
  parentRequestId: string;
  toolInput: unknown;
  declaredCapabilities: readonly string[];
  ttlMs: number;
}

export interface TrustedCustomMcpChildMutationRequest {
  actor: CapabilityActor;
  shipletId: string;
  revisionId: string;
  parentRequestId: string;
  childRequestId: string;
  capability: string;
  resource: string;
  effect: "mutation";
  input: unknown;
}

type TrustedRouteConfirmationProof = Readonly<{
  approvalRequestId: string;
  actor: Readonly<{ kind: "human"; id: string }>;
  decision: "confirm" | "deny";
}>;

const trustedRouteConfirmationProofs = new WeakSet<object>();

export type CustomMcpMutationEffectAuthority = Readonly<{
  approvalRequestId: string;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  actor: Readonly<CapabilityActor>;
  action: string;
  resource: string;
  expiresAt: number;
  dispatchLeaseExpiresAt: number;
  state: "dispatching";
}>;

const trustedMutationEffectAuthorities = new WeakMap<
  object,
  CustomMcpMutationEffectAuthority
>();

/** Kernel-only opaque handoff consumed by concrete effect adapters. */
export function resolveCustomMcpMutationEffectAuthority(
  actor: Readonly<CapabilityActor>,
): CustomMcpMutationEffectAuthority | null {
  if (typeof actor !== "object" || actor === null) return null;
  return trustedMutationEffectAuthorities.get(actor) ?? null;
}

export function createCustomMcpApprovalConfirmationRoute(input: {
  service: CustomMcpApprovalService;
  /** Must derive the actor from the trusted platform session, never request data. */
  authenticateHuman(request: Request): Promise<CapabilityActor | null>;
  /** Re-check current kernel authorization without accepting package scope. */
  authorizeApprover(input: {
    approvalRequestId: string;
    actor: Readonly<{ kind: "human"; id: string }>;
  }): Promise<boolean>;
  /** Must verify same-origin POST CSRF using kernel-owned session state. */
  verifySameOriginCsrf(
    request: Request,
    actor: Readonly<{ kind: "human"; id: string }>,
  ): Promise<boolean>;
}): {
  read(input: {
    approvalRequestId: string;
    request: Request;
  }): ReturnType<CustomMcpApprovalService["readTrustedConfirmation"]>;
  confirm(input: {
    approvalRequestId: string;
    request: Request;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
  deny(input: {
    approvalRequestId: string;
    request: Request;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied>;
} {
  if (
    typeof input?.service?.confirmResumableFromTrustedRoute !== "function" ||
    typeof input.service.denyResumableFromTrustedRoute !== "function" ||
    typeof input.service.readTrustedConfirmation !== "function" ||
    typeof input.authenticateHuman !== "function" ||
    typeof input.authorizeApprover !== "function" ||
    typeof input.verifySameOriginCsrf !== "function"
  ) {
    throw new TypeError("Invalid custom MCP approval confirmation route");
  }
  return Object.freeze({
    async read(routeInput: { approvalRequestId: string; request: Request }) {
      if (
        !(routeInput?.request instanceof Request) ||
        routeInput.request.method !== "GET" ||
        typeof routeInput.approvalRequestId !== "string" ||
        routeInput.approvalRequestId.length === 0
      ) {
        return denied();
      }
      let path: string;
      try {
        path = new URL(routeInput.request.url).pathname;
      } catch {
        return denied();
      }
      if (
        path !==
        `/api/mcp/approvals/${encodeURIComponent(routeInput.approvalRequestId)}/confirm`
      ) {
        return denied();
      }
      let actor: CapabilityActor | null;
      try {
        actor = await input.authenticateHuman(routeInput.request);
      } catch {
        actor = null;
      }
      if (!validHumanActor(actor as CapabilityActor, 1_024)) return denied();
      let currentlyAuthorized = false;
      try {
        currentlyAuthorized = await input.authorizeApprover({
          approvalRequestId: routeInput.approvalRequestId,
          actor: actor as { kind: "human"; id: string },
        });
      } catch {
        currentlyAuthorized = false;
      }
      if (currentlyAuthorized !== true) return denied();
      return input.service.readTrustedConfirmation({
        approvalRequestId: routeInput.approvalRequestId,
        trustedActor: actor as { kind: "human"; id: string },
      });
    },
    async confirm(routeInput: { approvalRequestId: string; request: Request }) {
      if (
        !(routeInput?.request instanceof Request) ||
        routeInput.request.method !== "POST" ||
        typeof routeInput.approvalRequestId !== "string" ||
        routeInput.approvalRequestId.length === 0
      ) {
        return denied();
      }
      let actor: CapabilityActor | null;
      try {
        actor = await input.authenticateHuman(routeInput.request);
      } catch {
        actor = null;
      }
      if (!validHumanActor(actor as CapabilityActor, 1_024)) return denied();
      const humanActor = actor as { kind: "human"; id: string };
      let currentlyAuthorized = false;
      try {
        currentlyAuthorized = await input.authorizeApprover({
          approvalRequestId: routeInput.approvalRequestId,
          actor: humanActor,
        });
      } catch {
        currentlyAuthorized = false;
      }
      if (currentlyAuthorized !== true) return denied();
      let csrfVerified = false;
      try {
        csrfVerified = await input.verifySameOriginCsrf(
          routeInput.request,
          humanActor,
        );
      } catch {
        csrfVerified = false;
      }
      if (csrfVerified !== true) return denied();
      let path: string;
      try {
        path = new URL(routeInput.request.url).pathname;
      } catch {
        return denied();
      }
      if (
        path !==
        `/api/mcp/approvals/${encodeURIComponent(routeInput.approvalRequestId)}/confirm`
      ) {
        return denied();
      }
      const proof: TrustedRouteConfirmationProof = Object.freeze({
        approvalRequestId: routeInput.approvalRequestId,
        actor: Object.freeze({ kind: "human", id: humanActor.id }),
        decision: "confirm",
      });
      trustedRouteConfirmationProofs.add(proof);
      return input.service.confirmResumableFromTrustedRoute({
        approvalRequestId: routeInput.approvalRequestId,
        proof,
      });
    },
    async deny(routeInput: { approvalRequestId: string; request: Request }) {
      if (
        !(routeInput?.request instanceof Request) ||
        routeInput.request.method !== "POST" ||
        typeof routeInput.approvalRequestId !== "string" ||
        routeInput.approvalRequestId.length === 0
      ) {
        return denied();
      }
      let actor: CapabilityActor | null;
      try {
        actor = await input.authenticateHuman(routeInput.request);
      } catch {
        actor = null;
      }
      if (!validHumanActor(actor as CapabilityActor, 1_024)) return denied();
      const humanActor = actor as { kind: "human"; id: string };
      let currentlyAuthorized = false;
      try {
        currentlyAuthorized = await input.authorizeApprover({
          approvalRequestId: routeInput.approvalRequestId,
          actor: humanActor,
        });
      } catch {
        currentlyAuthorized = false;
      }
      if (currentlyAuthorized !== true) return denied();
      let csrfVerified = false;
      try {
        csrfVerified = await input.verifySameOriginCsrf(
          routeInput.request,
          humanActor,
        );
      } catch {
        csrfVerified = false;
      }
      if (csrfVerified !== true) return denied();
      let path: string;
      try {
        path = new URL(routeInput.request.url).pathname;
      } catch {
        return denied();
      }
      if (
        path !==
        `/api/mcp/approvals/${encodeURIComponent(routeInput.approvalRequestId)}/deny`
      ) {
        return denied();
      }
      const proof: TrustedRouteConfirmationProof = Object.freeze({
        approvalRequestId: routeInput.approvalRequestId,
        actor: Object.freeze({ kind: "human", id: humanActor.id }),
        decision: "deny",
      });
      trustedRouteConfirmationProofs.add(proof);
      return input.service.denyResumableFromTrustedRoute({
        approvalRequestId: routeInput.approvalRequestId,
        proof,
      });
    },
  });
}

/**
 * Combines kernel-owned invocation context with the narrow child request that
 * crossed the isolated runtime boundary. Approval-like fields on package input
 * or MCP metadata are intentionally absent from this contract.
 */
export function bindCustomMcpMutationApprovalRequest(input: {
  invocation: TrustedCustomMcpApprovalInvocation;
  child: TrustedCustomMcpChildMutationRequest;
}): CustomMcpMutationApprovalRequest {
  const { invocation, child } = input;
  const actors = normalizeApprovalActors(invocation, 1_024);
  if (
    actors === null ||
    !sameActor(child.actor, actors.invokerActor) ||
    child.shipletId !== invocation.shipletId ||
    child.revisionId !== invocation.revisionId ||
    child.parentRequestId !== invocation.parentRequestId ||
    child.effect !== "mutation" ||
    !invocation.declaredCapabilities.includes(child.capability)
  ) {
    throw new TypeError("Invalid trusted custom MCP mutation binding");
  }
  const legacyInvocation =
    invocation.trustedActor !== undefined &&
    invocation.invokerActor === undefined &&
    invocation.trustedApprover === undefined;
  return Object.freeze({
    ...(legacyInvocation
      ? { trustedActor: Object.freeze({ ...actors.invokerActor }) }
      : {
          invokerActor: actors.invokerActor,
          trustedApprover: actors.trustedApprover,
        }),
    shipletId: invocation.shipletId,
    revisionId: invocation.revisionId,
    activationGeneration: invocation.activationGeneration,
    toolName: invocation.toolName,
    parentRequestId: invocation.parentRequestId,
    childRequestId: child.childRequestId,
    toolInput: invocation.toolInput,
    declaredCapabilities: Object.freeze([...invocation.declaredCapabilities]),
    capability: child.capability,
    resource: child.resource,
    effect: "mutation" as const,
    capabilityInput: child.input,
    ttlMs: invocation.ttlMs,
  });
}

export function createCustomMcpTrustedChildApprovalDelegate(input: {
  service: CustomMcpApprovalService;
  invocation: TrustedCustomMcpApprovalInvocation;
  resolveGrant(
    request: CustomMcpMutationApprovalRequest,
  ): Promise<CapabilityGrant | null>;
}): {
  resolve(
    child: TrustedCustomMcpChildMutationRequest,
  ): Promise<
    | { status: "approved" }
    | { status: "approval_required"; approval: ResumableCustomMcpApproval }
    | { status: "denied" }
  >;
} {
  if (
    typeof input?.service?.claim !== "function" ||
    typeof input.resolveGrant !== "function"
  ) {
    throw new TypeError("Invalid custom MCP approval delegate");
  }
  const actors = normalizeApprovalActors(input.invocation, 1_024);
  if (actors === null) {
    throw new TypeError("Invalid custom MCP approval attribution");
  }
  const legacyInvocation =
    input.invocation.trustedActor !== undefined &&
    input.invocation.invokerActor === undefined &&
    input.invocation.trustedApprover === undefined;
  const invocation = Object.freeze({
    ...(legacyInvocation
      ? { trustedActor: Object.freeze({ ...actors.invokerActor }) }
      : {
          invokerActor: actors.invokerActor,
          trustedApprover: actors.trustedApprover,
        }),
    shipletId: input.invocation.shipletId,
    revisionId: input.invocation.revisionId,
    activationGeneration: input.invocation.activationGeneration,
    toolName: input.invocation.toolName,
    parentRequestId: input.invocation.parentRequestId,
    toolInput: input.invocation.toolInput,
    declaredCapabilities: Object.freeze([
      ...input.invocation.declaredCapabilities,
    ]),
    ttlMs: input.invocation.ttlMs,
  });
  return Object.freeze({
    async resolve(child: TrustedCustomMcpChildMutationRequest) {
      if (
        !sameActor(child.actor, actors.invokerActor) ||
        child.shipletId !== invocation.shipletId ||
        child.revisionId !== invocation.revisionId ||
        child.parentRequestId !== invocation.parentRequestId ||
        child.effect !== "mutation" ||
        !invocation.declaredCapabilities.includes(child.capability)
      ) {
        return { status: "denied" as const };
      }
      const request = bindCustomMcpMutationApprovalRequest({
        invocation,
        child,
      });
      let grant: CapabilityGrant | null;
      try {
        grant = await input.resolveGrant(request);
      } catch {
        grant = null;
      }
      if (grant === null) return { status: "denied" as const };
      const result = await input.service.claim({ request, grant });
      if (result.ok) return Object.freeze({ status: "approved" as const });
      try {
        const approval = await input.service.getOrBeginResumable(request);
        return Object.freeze({
          status: "approval_required" as const,
          approval,
        });
      } catch {
        return Object.freeze({ status: "denied" as const });
      }
    },
  });
}

export function createCustomMcpApprovedMutationDispatcher(input: {
  service: CustomMcpApprovalService;
  invocation: TrustedCustomMcpApprovalInvocation;
  effect(
    request: ConstrainedCustomMcpMutation,
  ): Promise<CustomMcpMutationDispatchOutcome>;
}): {
  dispatch(input: {
    authorized: {
      actor: CapabilityActor;
      shipletId: string;
      revisionId: string;
      action: string;
      resource: string;
      requestId: string;
      input: unknown;
    };
  }): Promise<CustomMcpMutationDispatchOutcome>;
} {
  if (
    typeof input?.service?.dispatchApprovedMutation !== "function" ||
    typeof input.effect !== "function"
  ) {
    throw new TypeError("Invalid custom MCP mutation dispatcher");
  }
  const actors = normalizeApprovalActors(input.invocation, 1_024);
  if (actors === null) {
    throw new TypeError("Invalid custom MCP dispatch attribution");
  }
  const legacyInvocation =
    input.invocation.trustedActor !== undefined &&
    input.invocation.invokerActor === undefined &&
    input.invocation.trustedApprover === undefined;
  const invocation = Object.freeze({
    ...(legacyInvocation
      ? { trustedActor: Object.freeze({ ...actors.invokerActor }) }
      : {
          invokerActor: actors.invokerActor,
          trustedApprover: actors.trustedApprover,
        }),
    shipletId: input.invocation.shipletId,
    revisionId: input.invocation.revisionId,
    activationGeneration: input.invocation.activationGeneration,
    toolName: input.invocation.toolName,
    parentRequestId: input.invocation.parentRequestId,
    toolInput: input.invocation.toolInput,
    declaredCapabilities: Object.freeze([
      ...input.invocation.declaredCapabilities,
    ]),
    ttlMs: input.invocation.ttlMs,
  });
  return Object.freeze({
    async dispatch(dispatchInput: {
      authorized: {
        actor: CapabilityActor;
        shipletId: string;
        revisionId: string;
        action: string;
        resource: string;
        requestId: string;
        input: unknown;
      };
    }) {
      const { authorized } = dispatchInput;
      if (
        !authorized ||
        !sameActor(authorized.actor, actors.invokerActor) ||
        authorized.shipletId !== invocation.shipletId ||
        authorized.revisionId !== invocation.revisionId ||
        !invocation.declaredCapabilities.includes(authorized.action)
      ) {
        return deniedDispatch();
      }
      const request = bindCustomMcpMutationApprovalRequest({
        invocation,
        child: {
          actor: authorized.actor,
          shipletId: authorized.shipletId,
          revisionId: authorized.revisionId,
          parentRequestId: invocation.parentRequestId,
          childRequestId: authorized.requestId,
          capability: authorized.action,
          resource: authorized.resource,
          effect: "mutation",
          input: authorized.input,
        },
      });
      return input.service.dispatchApprovedMutation({
        request,
        effect: input.effect,
      });
    },
  });
}

type JsonSnapshot =
  | string
  | number
  | boolean
  | null
  | readonly JsonSnapshot[]
  | { readonly [key: string]: JsonSnapshot };

type JsonSnapshotResult = {
  value: JsonSnapshot;
  canonical: string;
};

type JsonSnapshotState = {
  nodes: number;
  stringUnits: number;
  canonicalBytes: number;
  maximumBytes: number;
  ancestors: Set<object>;
};

type StableApprovalRequest = {
  invokerActor: Readonly<CapabilityActor>;
  trustedApprover: Readonly<{ kind: "human"; id: string }>;
  shipletId: string;
  revisionId: string;
  activationGeneration: number;
  toolName: string;
  parentRequestId: string;
  childRequestId: string;
  toolInputDigest: string;
  declaredCapabilitiesDigest: string;
  declaredCapabilities: readonly string[];
  capability: string;
  capabilityDigest: string;
  resource: string;
  resourceDigest: string;
  actionSummary: string;
  changeSummary: string;
  resourceSummary: string;
  reviewTargetJson: string;
  reviewInputJson: string;
  effect: "mutation";
  capabilityInputDigest: string;
  bindingDigest: string;
  capabilityInput: JsonSnapshot;
  ttlMs: number;
};

type ApprovalRow = {
  id: string;
  project_id: string;
  revision_id: string;
  activation_generation: number;
  actor_kind: string;
  actor_id: string;
  invoker_actor_kind: string;
  invoker_actor_id: string;
  tool_name: string;
  parent_request_id: string;
  child_request_id: string;
  tool_input_digest: string;
  declared_capabilities_digest: string;
  capability: string;
  resource: string;
  action_summary: string;
  change_summary: string;
  resource_summary: string;
  review_target_json: string | null;
  review_input_json: string | null;
  effect: string;
  capability_input_digest: string;
  binding_digest: string;
  confirmation_nonce_digest: string | null;
  grant_id: string | null;
  grant_generation: number | null;
  approval_digest: string | null;
  issuance_idempotency_key: string;
  expires_at_ms: number;
  claim_lease_expires_at_ms: number | null;
  dispatch_lease_expires_at_ms: number | null;
  status: string;
};

const MAX_CANONICAL_INPUT_NODES = 10_000;
const MAX_CANONICAL_INPUT_DEPTH = 64;
const MAX_CANONICAL_INPUT_STRING_UNITS = 1_000_000;
const MAX_CANONICAL_INPUT_PROPERTIES = 256;

function addCanonicalBytes(state: JsonSnapshotState, amount: number): boolean {
  if (amount > state.maximumBytes - state.canonicalBytes) return false;
  state.canonicalBytes += amount;
  return true;
}

function addJsonStringBytes(value: string, state: JsonSnapshotState): boolean {
  if (!addCanonicalBytes(state, 2)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    let bytes: number;
    if (unit === 0x22 || unit === 0x5c) {
      bytes = 2;
    } else if (unit <= 0x1f) {
      bytes =
        unit === 0x08 ||
        unit === 0x09 ||
        unit === 0x0a ||
        unit === 0x0c ||
        unit === 0x0d
          ? 2
          : 6;
    } else if (unit <= 0x7f) {
      bytes = 1;
    } else if (unit <= 0x7ff) {
      bytes = 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4;
        index += 1;
      } else {
        bytes = 6;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes = 6;
    } else {
      bytes = 3;
    }
    if (!addCanonicalBytes(state, bytes)) return false;
  }
  return true;
}

function normalizeJsonSnapshot(
  value: unknown,
  state: JsonSnapshotState,
  depth = 0,
): JsonSnapshotResult | null {
  state.nodes += 1;
  if (
    state.nodes > MAX_CANONICAL_INPUT_NODES ||
    depth > MAX_CANONICAL_INPUT_DEPTH
  ) {
    return null;
  }
  if (value === null || typeof value === "boolean") {
    if (!addCanonicalBytes(state, value === null ? 4 : value ? 4 : 5)) {
      return null;
    }
    return { value, canonical: JSON.stringify(value) };
  }
  if (typeof value === "string") {
    state.stringUnits += value.length;
    if (
      state.stringUnits > MAX_CANONICAL_INPUT_STRING_UNITS ||
      !addJsonStringBytes(value, state)
    ) {
      return null;
    }
    return { value, canonical: JSON.stringify(value) };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return null;
    const canonical = JSON.stringify(value);
    return addCanonicalBytes(state, canonical.length)
      ? { value, canonical }
      : null;
  }
  if (typeof value !== "object" || state.ancestors.has(value)) return null;

  state.ancestors.add(value);
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string") ||
      ownKeys.length !== value.length + 1
    ) {
      state.ancestors.delete(value);
      return null;
    }
    const entries: JsonSnapshot[] = [];
    const canonicalEntries: string[] = [];
    if (!addCanonicalBytes(state, 1)) {
      state.ancestors.delete(value);
      return null;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0 && !addCanonicalBytes(state, 1)) {
        state.ancestors.delete(value);
        return null;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        state.ancestors.delete(value);
        return null;
      }
      const normalized = normalizeJsonSnapshot(
        descriptor.value,
        state,
        depth + 1,
      );
      if (normalized === null) {
        state.ancestors.delete(value);
        return null;
      }
      entries.push(normalized.value);
      canonicalEntries.push(normalized.canonical);
    }
    if (!addCanonicalBytes(state, 1)) {
      state.ancestors.delete(value);
      return null;
    }
    state.ancestors.delete(value);
    return {
      value: Object.freeze(entries),
      canonical: `[${canonicalEntries.join(",")}]`,
    };
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    state.ancestors.delete(value);
    return null;
  }
  const ownKeys = Reflect.ownKeys(value);
  const enumerableKeys = Object.keys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== enumerableKeys.length ||
    enumerableKeys.length > MAX_CANONICAL_INPUT_PROPERTIES
  ) {
    state.ancestors.delete(value);
    return null;
  }
  const snapshot: Record<string, JsonSnapshot> = {};
  const canonicalEntries: string[] = [];
  if (!addCanonicalBytes(state, 1)) {
    state.ancestors.delete(value);
    return null;
  }
  for (const [index, key] of enumerableKeys.sort().entries()) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      state.ancestors.delete(value);
      return null;
    }
    if (
      (index > 0 && !addCanonicalBytes(state, 1)) ||
      !addJsonStringBytes(key, state) ||
      !addCanonicalBytes(state, 1)
    ) {
      state.ancestors.delete(value);
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      state.ancestors.delete(value);
      return null;
    }
    const normalized = normalizeJsonSnapshot(
      descriptor.value,
      state,
      depth + 1,
    );
    if (normalized === null) {
      state.ancestors.delete(value);
      return null;
    }
    snapshot[key] = normalized.value;
    canonicalEntries.push(`${JSON.stringify(key)}:${normalized.canonical}`);
  }
  if (!addCanonicalBytes(state, 1)) {
    state.ancestors.delete(value);
    return null;
  }
  state.ancestors.delete(value);
  return {
    value: Object.freeze(snapshot),
    canonical: `{${canonicalEntries.join(",")}}`,
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function snapshotInput(
  value: unknown,
  maximumBytes: number,
): JsonSnapshotResult {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("Invalid custom MCP approval input limit");
  }
  const snapshot = normalizeJsonSnapshot(value, {
    nodes: 0,
    stringUnits: 0,
    canonicalBytes: 0,
    maximumBytes,
    ancestors: new Set<object>(),
  });
  if (snapshot === null) {
    throw new TypeError("Invalid custom MCP approval input");
  }
  return snapshot;
}

function exactEnumerableDataProperties(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, PropertyDescriptor>> | null {
  if (typeof value !== "object" || value === null) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return null;
  }
  const descriptors: Record<string, PropertyDescriptor> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return null;
    }
    descriptors[key] = descriptor;
  }
  return Object.freeze(descriptors);
}

function projectDispatchOutcome(
  providerOutcome: unknown,
  limits: CustomMcpApprovalLimits,
): CustomMcpMutationDispatchOutcome | null {
  const statusDescriptor = Object.getOwnPropertyDescriptor(
    typeof providerOutcome === "object" && providerOutcome !== null
      ? providerOutcome
      : {},
    "status",
  );
  if (
    !statusDescriptor ||
    !("value" in statusDescriptor) ||
    typeof statusDescriptor.value !== "string"
  ) {
    return null;
  }
  const status = statusDescriptor.value;
  const expectedKeys =
    status === "committed"
      ? (["status", "journalId", "value"] as const)
      : status === "aborted" || status === "reconciliation_required"
        ? (["status", "journalId"] as const)
        : null;
  if (expectedKeys === null) return null;
  const descriptors = exactEnumerableDataProperties(
    providerOutcome,
    expectedKeys,
  );
  if (descriptors === null) return null;
  const journalId = descriptors.journalId?.value;
  if (!safeOpaqueJournalId(journalId, limits.maxMetadataBytes)) return null;
  if (status === "committed") {
    const projectedValue = snapshotInput(
      descriptors.value?.value,
      limits.maxResultBytes,
    ).value;
    return Object.freeze({
      status: "committed" as const,
      journalId,
      value: projectedValue,
    });
  }
  return status === "aborted"
    ? Object.freeze({ status: "aborted" as const, journalId })
    : Object.freeze({
        status: "reconciliation_required" as const,
        journalId,
      });
}

export async function digestCustomMcpApprovalInput(
  value: unknown,
  maximumBytes: number,
): Promise<string> {
  return sha256(snapshotInput(value, maximumBytes).canonical);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8Length(value) <= maximumBytes
  );
}

function safeOpaqueJournalId(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    boundedString(value, maximumBytes) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function sameActor(left: unknown, right: unknown): boolean {
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const leftActor = left as Partial<CapabilityActor>;
  const rightActor = right as Partial<CapabilityActor>;
  return (
    typeof leftActor.kind === "string" &&
    typeof leftActor.id === "string" &&
    leftActor.kind === rightActor.kind &&
    leftActor.id === rightActor.id
  );
}

function validHumanActor(
  actor: CapabilityActor,
  maximumBytes: number,
): actor is { kind: "human"; id: string } {
  return actor?.kind === "human" && boundedString(actor.id, maximumBytes);
}

function validCapabilityActor(
  actor: CapabilityActor,
  maximumBytes: number,
): actor is CapabilityActor {
  return (
    (actor?.kind === "human" ||
      actor?.kind === "agent" ||
      actor?.kind === "shiplet" ||
      actor?.kind === "system") &&
    boundedString(actor.id, maximumBytes)
  );
}

function normalizeApprovalActors(
  value: {
    trustedActor?: CapabilityActor;
    invokerActor?: CapabilityActor;
    trustedApprover?: Readonly<{ kind: "human"; id: string }>;
  },
  maximumBytes: number,
): {
  invokerActor: Readonly<CapabilityActor>;
  trustedApprover: Readonly<{ kind: "human"; id: string }>;
} | null {
  const legacy =
    value.invokerActor === undefined &&
    value.trustedApprover === undefined &&
    validHumanActor(value.trustedActor as CapabilityActor, maximumBytes);
  if (legacy) {
    const actor = value.trustedActor as { kind: "human"; id: string };
    return Object.freeze({
      invokerActor: Object.freeze({ kind: "human", id: actor.id }),
      trustedApprover: Object.freeze({ kind: "human", id: actor.id }),
    });
  }
  if (
    value.trustedActor !== undefined ||
    !validCapabilityActor(
      value.invokerActor as CapabilityActor,
      maximumBytes,
    ) ||
    !validHumanActor(value.trustedApprover as CapabilityActor, maximumBytes)
  ) {
    return null;
  }
  const invokerActor = value.invokerActor as CapabilityActor;
  const trustedApprover = value.trustedApprover as {
    kind: "human";
    id: string;
  };
  if (invokerActor.kind === "agent" && invokerActor.id === trustedApprover.id) {
    return null;
  }
  return Object.freeze({
    invokerActor: Object.freeze({
      kind: invokerActor.kind,
      id: invokerActor.id,
    }),
    trustedApprover: Object.freeze({
      kind: "human",
      id: trustedApprover.id,
    }),
  });
}

function validLimits(limits: CustomMcpApprovalLimits): boolean {
  return (
    Number.isSafeInteger(limits?.maxApprovalTtlMs) &&
    limits.maxApprovalTtlMs > 0 &&
    Number.isSafeInteger(limits.maxInputBytes) &&
    limits.maxInputBytes > 0 &&
    Number.isSafeInteger(limits.maxResultBytes) &&
    limits.maxResultBytes > 0 &&
    Number.isSafeInteger(limits.maxMetadataBytes) &&
    limits.maxMetadataBytes > 0 &&
    Number.isSafeInteger(limits.claimLeaseMs) &&
    limits.claimLeaseMs > 0 &&
    Number.isSafeInteger(limits.dispatchLeaseMs) &&
    limits.dispatchLeaseMs > 0
  );
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `mcp_confirmation_${btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")}`;
}

function nowFrom(options: D1CustomMcpApprovalServiceOptions): number {
  const now = options.now();
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Custom MCP approval clock unavailable");
  }
  return now;
}

function safeActionSummary(capability: string): string {
  if (capability === "review.feedback.write") {
    return "Post or update review feedback";
  }
  if (capability === "review.feedback.reply") {
    return "Reply to review feedback";
  }
  if (capability === "review.feedback.status") {
    return "Change review feedback status";
  }
  if (capability === "workflow.event:create") {
    return "Create a Shiplet workflow event";
  }
  if (capability === "state.write") return "Update private Shiplet state";
  if (capability === "deployment.promote") {
    return "Promote a Shiplet revision to this deployment";
  }
  if (capability === "deployment.rollback") {
    return "Roll back this Shiplet deployment";
  }
  return "Run a custom Shiplet-scoped mutation";
}

function safeResourceSummary(resource: string): string {
  if (resource.startsWith("feedback:")) {
    return "Review feedback thread (identifier hidden)";
  }
  if (resource.startsWith("state:")) {
    return "Private Shiplet state key (identifier hidden)";
  }
  if (resource.startsWith("deployment:")) {
    return "Deployment target (identifier hidden)";
  }
  if (resource === "workflow:events") {
    return "Shiplet workflow event stream";
  }
  return "Shiplet-owned resource (identifier hidden)";
}

function safeChangeSummary(capability: string, input: JsonSnapshot): string {
  const record =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Readonly<Record<string, JsonSnapshot>>)
      : null;
  if (capability === "review.feedback.write") {
    const status = record?.status;
    if (
      record?.operation === "set_status" &&
      (status === "New" ||
        status === "In Progress" ||
        status === "Blocked" ||
        status === "Done" ||
        status === "Dropped")
    ) {
      return `Set review feedback status to ${status}`;
    }
    return "Post or update review feedback";
  }
  if (capability === "review.feedback.reply") {
    return "Add a reply to review feedback";
  }
  if (capability === "review.feedback.status") {
    return "Change review feedback status";
  }
  if (capability === "workflow.event:create") {
    const category = record?.canonicalStatusCategory;
    if (
      category === "open" ||
      category === "in_progress" ||
      category === "resolved" ||
      category === "closed" ||
      category === "unknown"
    ) {
      return `Create a workflow event categorized as ${category}`;
    }
    return "Create a workflow event";
  }
  if (capability === "state.write") {
    return "Update one private Shiplet state value";
  }
  if (capability === "deployment.promote") {
    return "Promote the selected Shiplet revision";
  }
  if (capability === "deployment.rollback") {
    return "Restore the previous known-good Shiplet revision";
  }
  return "Run the exact Shiplet-scoped mutation shown above";
}

function safeInvokerLabel(kind: CapabilityActor["kind"]): string {
  if (kind === "human") return "Signed-in human requested this change";
  if (kind === "agent") return "Authorized agent requested this change";
  if (kind === "shiplet") return "Shiplet runtime requested this change";
  return "Trusted system process requested this change";
}

const MAX_TRUSTED_REVIEW_PROJECTION_BYTES = 4_096;
const FORBIDDEN_TRUSTED_REVIEW_KEY_PARTS = [
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "claim",
  "clientsecret",
  "cookie",
  "credential",
  "oauth",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "session",
  "signingkey",
  "token",
] as const;

function normalizedReviewKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forbiddenReviewKey(key: string): boolean {
  const normalized = normalizedReviewKey(key);
  return (
    normalized === "auth" ||
    normalized.startsWith("authentication") ||
    FORBIDDEN_TRUSTED_REVIEW_KEY_PARTS.some((part) => normalized.includes(part))
  );
}

function forbiddenReviewString(value: string): boolean {
  if (/^\s*bearer\s+/i.test(value)) return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username || parsed.password) return true;
  for (const key of parsed.searchParams.keys()) {
    if (forbiddenReviewKey(key)) return true;
  }
  return parsed.pathname
    .split("/")
    .filter(Boolean)
    .some((segment) => {
      const normalized = normalizedReviewKey(segment);
      return (
        normalized === "claim" ||
        normalized === "authorize" ||
        normalized === "authorization" ||
        normalized === "oauth" ||
        normalized === "callback" ||
        normalized === "token"
      );
    });
}

function assertSafeTrustedReviewValue(value: JsonSnapshot): void {
  if (typeof value === "string") {
    if (forbiddenReviewString(value)) {
      throw new TypeError("Unsafe custom MCP trusted review value");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTrustedReviewValue(item);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenReviewKey(key)) {
      throw new TypeError("Unsafe custom MCP trusted review key");
    }
    assertSafeTrustedReviewValue(child);
  }
}

function trustedReviewProjection(input: {
  capability: string;
  resource: string;
  capabilityInput: JsonSnapshotResult;
}): { targetJson: string; inputJson: string } {
  if (forbiddenReviewString(input.resource)) {
    throw new TypeError("Unsafe custom MCP trusted review target");
  }
  assertSafeTrustedReviewValue(input.capabilityInput.value);
  const targetJson = JSON.stringify({
    capability: input.capability,
    resource: input.resource,
  });
  const inputJson = input.capabilityInput.canonical;
  if (
    utf8Length(targetJson) + utf8Length(inputJson) >
    MAX_TRUSTED_REVIEW_PROJECTION_BYTES
  ) {
    throw new TypeError("Custom MCP trusted review projection is too large");
  }
  return { targetJson, inputJson };
}

function parseTrustedReviewProjection(row: ApprovalRow): {
  target: Readonly<{ capability: string; resource: string }>;
  input: JsonSnapshot;
} | null {
  if (row.review_target_json === null || row.review_input_json === null) {
    return null;
  }
  try {
    const target = JSON.parse(row.review_target_json) as unknown;
    if (
      typeof target !== "object" ||
      target === null ||
      Array.isArray(target) ||
      Object.keys(target).sort().join(",") !== "capability,resource"
    ) {
      return null;
    }
    const candidate = target as Record<string, unknown>;
    if (
      !boundedString(candidate.capability, 1_024) ||
      !boundedString(candidate.resource, 1_024) ||
      forbiddenReviewString(candidate.resource)
    ) {
      return null;
    }
    const reviewInput = snapshotInput(
      JSON.parse(row.review_input_json),
      MAX_TRUSTED_REVIEW_PROJECTION_BYTES,
    );
    assertSafeTrustedReviewValue(reviewInput.value);
    if (
      utf8Length(row.review_target_json) + utf8Length(reviewInput.canonical) >
      MAX_TRUSTED_REVIEW_PROJECTION_BYTES
    ) {
      return null;
    }
    return Object.freeze({
      target: Object.freeze({
        capability: candidate.capability,
        resource: candidate.resource,
      }),
      input: reviewInput.value,
    });
  } catch {
    return null;
  }
}

async function stableRequest(
  request: CustomMcpMutationApprovalRequest,
  limits: CustomMcpApprovalLimits,
): Promise<StableApprovalRequest> {
  const actors =
    typeof request === "object" && request !== null
      ? normalizeApprovalActors(request, limits.maxMetadataBytes)
      : null;
  if (
    typeof request !== "object" ||
    request === null ||
    actors === null ||
    !boundedString(request.shipletId, limits.maxMetadataBytes) ||
    !boundedString(request.revisionId, limits.maxMetadataBytes) ||
    !Number.isSafeInteger(request.activationGeneration) ||
    request.activationGeneration <= 0 ||
    !boundedString(request.toolName, limits.maxMetadataBytes) ||
    !boundedString(request.parentRequestId, limits.maxMetadataBytes) ||
    !boundedString(request.childRequestId, limits.maxMetadataBytes) ||
    !Array.isArray(request.declaredCapabilities) ||
    request.declaredCapabilities.length === 0 ||
    request.declaredCapabilities.length > 64 ||
    !boundedString(request.capability, limits.maxMetadataBytes) ||
    !boundedString(request.resource, limits.maxMetadataBytes) ||
    request.effect !== "mutation" ||
    !Number.isSafeInteger(request.ttlMs) ||
    request.ttlMs <= 0 ||
    request.ttlMs > limits.maxApprovalTtlMs
  ) {
    throw new TypeError("Invalid custom MCP approval request");
  }
  const declaredCapabilities = [...request.declaredCapabilities];
  if (
    declaredCapabilities.some(
      (capability) => !boundedString(capability, limits.maxMetadataBytes),
    ) ||
    new Set(declaredCapabilities).size !== declaredCapabilities.length ||
    !declaredCapabilities.includes(request.capability)
  ) {
    throw new TypeError("Invalid custom MCP declared capabilities");
  }
  declaredCapabilities.sort();
  const toolInput = snapshotInput(request.toolInput, limits.maxInputBytes);
  const capabilityInput = snapshotInput(
    request.capabilityInput,
    limits.maxInputBytes,
  );
  const reviewProjection = trustedReviewProjection({
    capability: request.capability,
    resource: request.resource,
    capabilityInput,
  });
  const toolInputDigest = await sha256(toolInput.canonical);
  const declaredCapabilitiesDigest = await sha256(
    JSON.stringify(declaredCapabilities),
  );
  const capabilityInputDigest = await sha256(capabilityInput.canonical);
  const capabilityDigest = await sha256(request.capability);
  const resourceDigest = await sha256(request.resource);
  const legacyRequest =
    request.trustedActor !== undefined &&
    request.invokerActor === undefined &&
    request.trustedApprover === undefined;
  const bindingDigest = await sha256(
    JSON.stringify(
      legacyRequest
        ? {
            actorKind: actors.invokerActor.kind,
            actorId: actors.invokerActor.id,
            shipletId: request.shipletId,
            revisionId: request.revisionId,
            activationGeneration: request.activationGeneration,
            toolName: request.toolName,
            parentRequestId: request.parentRequestId,
            childRequestId: request.childRequestId,
            toolInputDigest,
            declaredCapabilitiesDigest,
            capabilityDigest,
            resourceDigest,
            effect: "mutation",
            capabilityInputDigest,
          }
        : {
            invokerActorKind: actors.invokerActor.kind,
            invokerActorId: actors.invokerActor.id,
            approverKind: actors.trustedApprover.kind,
            approverId: actors.trustedApprover.id,
            shipletId: request.shipletId,
            revisionId: request.revisionId,
            activationGeneration: request.activationGeneration,
            toolName: request.toolName,
            parentRequestId: request.parentRequestId,
            childRequestId: request.childRequestId,
            toolInputDigest,
            declaredCapabilitiesDigest,
            capabilityDigest,
            resourceDigest,
            effect: "mutation",
            capabilityInputDigest,
          },
    ),
  );
  return Object.freeze({
    invokerActor: actors.invokerActor,
    trustedApprover: actors.trustedApprover,
    shipletId: request.shipletId,
    revisionId: request.revisionId,
    activationGeneration: request.activationGeneration,
    toolName: request.toolName,
    parentRequestId: request.parentRequestId,
    childRequestId: request.childRequestId,
    toolInputDigest,
    declaredCapabilitiesDigest,
    declaredCapabilities: Object.freeze(declaredCapabilities),
    capability: request.capability,
    capabilityDigest,
    resource: request.resource,
    resourceDigest,
    actionSummary: safeActionSummary(request.capability),
    changeSummary: safeChangeSummary(request.capability, capabilityInput.value),
    resourceSummary: safeResourceSummary(request.resource),
    reviewTargetJson: reviewProjection.targetJson,
    reviewInputJson: reviewProjection.inputJson,
    effect: "mutation",
    capabilityInputDigest,
    bindingDigest,
    capabilityInput: capabilityInput.value,
    ttlMs: request.ttlMs,
  });
}

function validGrant(
  grant: CapabilityGrant,
  request: StableApprovalRequest,
  now: number,
  maximumBytes: number,
): boolean {
  return (
    typeof grant === "object" &&
    grant !== null &&
    boundedString(grant.id, maximumBytes) &&
    Number.isSafeInteger(grant.generation) &&
    grant.generation > 0 &&
    validCapabilityActor(grant.actor, maximumBytes) &&
    sameActor(grant.actor, request.invokerActor) &&
    grant.shipletId === request.shipletId &&
    grant.revisionId === request.revisionId &&
    grant.action === request.capability &&
    grant.resource === request.resource &&
    grant.effect === "mutation" &&
    grant.approval === "trusted-human" &&
    Number.isFinite(grant.expiresAt) &&
    grant.expiresAt > now &&
    grant.revokedAt === null
  );
}

async function resolveAuthoritativeGrant(
  options: D1CustomMcpApprovalServiceOptions,
  request: StableApprovalRequest,
  reference: Pick<CapabilityGrant, "id" | "generation">,
  now: number,
): Promise<CapabilityGrant | null> {
  if (
    !boundedString(reference?.id, options.limits.maxMetadataBytes) ||
    !Number.isSafeInteger(reference.generation) ||
    reference.generation <= 0
  ) {
    return null;
  }
  let resolved: CustomMcpAuthoritativeGrantResolution | null;
  try {
    resolved = await options.resolveCapabilityGrant({
      grantId: reference.id,
      grantGeneration: reference.generation,
      expected: {
        actor: request.invokerActor,
        shipletId: request.shipletId,
        revisionId: request.revisionId,
        activationGeneration: request.activationGeneration,
        action: request.capability,
        resource: request.resource,
      },
    });
  } catch {
    resolved = null;
  }
  if (
    resolved === null ||
    resolved.grant.id !== reference.id ||
    resolved.grant.generation !== reference.generation ||
    !validGrant(
      resolved.grant,
      request,
      now,
      options.limits.maxMetadataBytes,
    ) ||
    resolved.activationFence.revisionId !== request.revisionId ||
    resolved.activationFence.generation !== request.activationGeneration
  ) {
    return null;
  }
  return Object.freeze({
    ...resolved.grant,
    actor: Object.freeze({ ...resolved.grant.actor }),
  });
}

function trustedApprovalBinding(
  request: StableApprovalRequest,
  grant: CapabilityGrant,
): TrustedApprovalBinding {
  return Object.freeze({
    requestId: request.childRequestId,
    actor: request.invokerActor,
    grantId: grant.id,
    grantGeneration: grant.generation,
    shipletId: request.shipletId,
    revisionId: request.revisionId,
    action: request.capability,
    resource: request.resource,
    effect: "mutation",
    approvalPolicy: "trusted-human",
    inputDigest: request.capabilityInputDigest,
  });
}

function validAtomicDispatchAuthorityResolution(
  value: unknown,
  expected: {
    request: StableApprovalRequest;
    row: ApprovalRow;
    now: number;
  },
): value is CustomMcpAtomicDispatchAuthorityResolution {
  const root = exactEnumerableDataProperties(value, [
    "authorized",
    "activationFence",
    "grant",
    "approval",
  ]);
  if (root === null || root.authorized?.value !== true) return false;
  const activation = exactEnumerableDataProperties(
    root.activationFence?.value,
    ["revisionId", "generation"],
  );
  const grant = exactEnumerableDataProperties(root.grant?.value, [
    "id",
    "generation",
    "expiresAt",
    "revokedAt",
  ]);
  const approval = exactEnumerableDataProperties(root.approval?.value, [
    "digest",
    "expiresAt",
    "revokedAt",
  ]);
  return (
    activation !== null &&
    activation.revisionId?.value === expected.request.revisionId &&
    activation.generation?.value === expected.request.activationGeneration &&
    grant !== null &&
    grant.id?.value === expected.row.grant_id &&
    grant.generation?.value === expected.row.grant_generation &&
    Number.isFinite(grant.expiresAt?.value) &&
    grant.expiresAt.value > expected.now &&
    grant.revokedAt?.value === null &&
    approval !== null &&
    approval.digest?.value === expected.row.approval_digest &&
    Number.isFinite(approval.expiresAt?.value) &&
    approval.expiresAt.value > expected.now &&
    approval.revokedAt?.value === null
  );
}

async function activeMatches(
  options: D1CustomMcpApprovalServiceOptions,
  request: StableApprovalRequest,
): Promise<boolean> {
  let active: Awaited<
    ReturnType<D1CustomMcpApprovalServiceOptions["resolveActiveRevision"]>
  >;
  try {
    active = await options.resolveActiveRevision(request.shipletId);
  } catch {
    return false;
  }
  return (
    active !== null &&
    active.revisionId === request.revisionId &&
    active.activationGeneration === request.activationGeneration
  );
}

function rowMatchesRequest(row: ApprovalRow, request: StableApprovalRequest) {
  return (
    row.binding_digest === request.bindingDigest &&
    row.project_id === request.shipletId &&
    row.revision_id === request.revisionId &&
    row.activation_generation === request.activationGeneration &&
    row.actor_kind === request.trustedApprover.kind &&
    row.actor_id === request.trustedApprover.id &&
    row.invoker_actor_kind === request.invokerActor.kind &&
    row.invoker_actor_id === request.invokerActor.id &&
    row.tool_name === request.toolName &&
    row.parent_request_id === request.parentRequestId &&
    row.child_request_id === request.childRequestId &&
    row.tool_input_digest === request.toolInputDigest &&
    row.declared_capabilities_digest === request.declaredCapabilitiesDigest &&
    row.capability === request.capabilityDigest &&
    row.resource === request.resourceDigest &&
    row.action_summary === request.actionSummary &&
    row.change_summary === request.changeSummary &&
    row.resource_summary === request.resourceSummary &&
    row.review_target_json === request.reviewTargetJson &&
    row.review_input_json === request.reviewInputJson &&
    row.effect === request.effect &&
    row.capability_input_digest === request.capabilityInputDigest
  );
}

function rowMatchesGrant(row: ApprovalRow, grant: CapabilityGrant) {
  return (
    (row.grant_id === null && row.grant_generation === null) ||
    (row.grant_id === grant.id && row.grant_generation === grant.generation)
  );
}

function denied(): CustomMcpApprovalDenied {
  return { ok: false, code: "approval_denied" };
}

function deniedDispatch(): CustomMcpMutationDispatchOutcome {
  return {
    status: "aborted",
    journalId: `approval-denied:${crypto.randomUUID()}`,
  };
}

function reconciliationDispatch(): CustomMcpMutationDispatchOutcome {
  return {
    status: "reconciliation_required",
    journalId: `approval-reconcile:${crypto.randomUUID()}`,
  };
}

export async function ensureCustomMcpApprovalSchema(
  db: D1Database,
): Promise<void> {
  await db.batch([
    db.prepare(
      `DROP TRIGGER IF EXISTS shiplet_custom_mcp_approval_binding_immutable`,
    ),
    db.prepare(
      `DROP TRIGGER IF EXISTS shiplet_custom_mcp_approval_state_machine`,
    ),
    db.prepare(
      `DROP TRIGGER IF EXISTS shiplet_custom_mcp_approval_audit_no_update`,
    ),
  ]);
  const approvalTable = await db
    .prepare(
      `SELECT name FROM sqlite_master
	       WHERE type = 'table' AND name = 'shiplet_custom_mcp_approvals'`,
    )
    .first<{ name: string }>();
  if (approvalTable !== null) {
    const columns = await db
      .prepare(`PRAGMA table_info(shiplet_custom_mcp_approvals)`)
      .all<{ name: string }>();
    const names = new Set(columns.results.map((column) => column.name));
    if (!names.has("invoker_actor_kind")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approvals ADD COLUMN invoker_actor_kind TEXT`,
        )
        .run();
    }
    if (!names.has("invoker_actor_id")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approvals ADD COLUMN invoker_actor_id TEXT`,
        )
        .run();
    }
    if (!names.has("claim_lease_expires_at_ms")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approvals ADD COLUMN claim_lease_expires_at_ms REAL`,
        )
        .run();
    }
    if (!names.has("change_summary")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approvals ADD COLUMN change_summary TEXT`,
        )
        .run();
    }
    if (!names.has("review_target_json")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approvals ADD COLUMN review_target_json TEXT`,
        )
        .run();
    }
    if (!names.has("review_input_json")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approvals ADD COLUMN review_input_json TEXT`,
        )
        .run();
    }
    await db
      .prepare(
        `UPDATE shiplet_custom_mcp_approvals
		    SET invoker_actor_kind = COALESCE(invoker_actor_kind, actor_kind),
		        invoker_actor_id = COALESCE(invoker_actor_id, actor_id),
		        change_summary = COALESCE(change_summary, action_summary)
		  WHERE invoker_actor_kind IS NULL OR invoker_actor_id IS NULL`,
      )
      .run();
    await db
      .prepare(
        `UPDATE shiplet_custom_mcp_approvals
		    SET change_summary = action_summary WHERE change_summary IS NULL`,
      )
      .run();
  }
  const auditTable = await db
    .prepare(
      `SELECT name FROM sqlite_master
	       WHERE type = 'table' AND name = 'shiplet_custom_mcp_approval_audit'`,
    )
    .first<{ name: string }>();
  if (auditTable !== null) {
    const columns = await db
      .prepare(`PRAGMA table_info(shiplet_custom_mcp_approval_audit)`)
      .all<{ name: string }>();
    const names = new Set(columns.results.map((column) => column.name));
    if (!names.has("approver_kind")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approval_audit ADD COLUMN approver_kind TEXT`,
        )
        .run();
    }
    if (!names.has("approver_id")) {
      await db
        .prepare(
          `ALTER TABLE shiplet_custom_mcp_approval_audit ADD COLUMN approver_id TEXT`,
        )
        .run();
    }
    await db
      .prepare(
        `UPDATE shiplet_custom_mcp_approval_audit
		    SET approver_kind = COALESCE(approver_kind, actor_kind),
		        approver_id = COALESCE(approver_id, actor_id)
		  WHERE approver_kind IS NULL OR approver_id IS NULL`,
      )
      .run();
  }
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_custom_mcp_approvals (
				id TEXT PRIMARY KEY,
				binding_digest TEXT NOT NULL UNIQUE,
				confirmation_nonce_digest TEXT UNIQUE,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				activation_generation INTEGER NOT NULL,
				actor_kind TEXT NOT NULL CHECK (actor_kind = 'human'),
				actor_id TEXT NOT NULL,
				invoker_actor_kind TEXT NOT NULL CHECK (
					invoker_actor_kind IN ('human', 'agent', 'shiplet', 'system')
				),
				invoker_actor_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				parent_request_id TEXT NOT NULL,
				child_request_id TEXT NOT NULL,
				tool_input_digest TEXT NOT NULL,
				declared_capabilities_digest TEXT NOT NULL,
				capability TEXT NOT NULL,
				resource TEXT NOT NULL,
				action_summary TEXT NOT NULL,
				change_summary TEXT NOT NULL,
				resource_summary TEXT NOT NULL,
				review_target_json TEXT,
				review_input_json TEXT,
				effect TEXT NOT NULL CHECK (effect = 'mutation'),
				capability_input_digest TEXT NOT NULL,
				grant_id TEXT,
				grant_generation INTEGER,
				approval_digest TEXT,
				issuance_idempotency_key TEXT NOT NULL UNIQUE,
				expires_at_ms REAL NOT NULL,
				status TEXT NOT NULL,
				confirmed_at_ms REAL,
				claimed_at_ms REAL,
				claim_lease_expires_at_ms REAL,
				dispatch_started_at_ms REAL,
				dispatch_lease_expires_at_ms REAL,
				dispatch_completed_at_ms REAL,
				revoked_at_ms REAL,
				created_at_ms REAL NOT NULL,
				CHECK (
					(grant_id IS NULL AND grant_generation IS NULL)
					OR (grant_id IS NOT NULL AND grant_generation IS NOT NULL)
				),
				UNIQUE (
					project_id, revision_id, activation_generation,
					actor_kind, actor_id, parent_request_id, child_request_id
				),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS shiplet_custom_mcp_approval_audit (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				approval_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				revision_id TEXT NOT NULL,
				actor_kind TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				approver_kind TEXT NOT NULL CHECK (approver_kind = 'human'),
				approver_id TEXT NOT NULL,
				event_kind TEXT NOT NULL,
				outcome TEXT NOT NULL,
				request_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				capability TEXT NOT NULL,
				resource TEXT NOT NULL,
				input_digest TEXT NOT NULL,
				occurred_at_ms REAL NOT NULL,
				FOREIGN KEY (approval_id)
					REFERENCES shiplet_custom_mcp_approvals(id),
				FOREIGN KEY (project_id) REFERENCES projects(id),
				FOREIGN KEY (revision_id) REFERENCES shiplet_revisions(id)
			)`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_custom_mcp_approval_exact_scope
			 ON shiplet_custom_mcp_approvals (
				project_id, revision_id, parent_request_id, child_request_id,
				capability, status, expires_at_ms
			)`,
    ),
    db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_mcp_approval_attributed_identity
			 ON shiplet_custom_mcp_approvals (
				project_id, revision_id, activation_generation,
				invoker_actor_kind, invoker_actor_id, actor_kind, actor_id,
				parent_request_id, child_request_id
			)`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_attribution_required
			 BEFORE INSERT ON shiplet_custom_mcp_approvals
			 WHEN NEW.actor_kind != 'human'
				OR NEW.actor_id IS NULL OR NEW.actor_id = ''
				OR NEW.invoker_actor_kind NOT IN ('human', 'agent', 'shiplet', 'system')
				OR NEW.invoker_actor_id IS NULL OR NEW.invoker_actor_id = ''
				OR NEW.change_summary IS NULL OR NEW.change_summary = ''
				OR NEW.review_target_json IS NULL OR NEW.review_target_json = ''
				OR NEW.review_input_json IS NULL OR NEW.review_input_json = ''
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_attribution_required');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_audit_attribution_required
			 BEFORE INSERT ON shiplet_custom_mcp_approval_audit
			 WHEN NEW.actor_kind NOT IN ('human', 'agent', 'shiplet', 'system')
				OR NEW.actor_id IS NULL OR NEW.actor_id = ''
				OR NEW.approver_kind != 'human'
				OR NEW.approver_id IS NULL OR NEW.approver_id = ''
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_audit_attribution_required');
			 END`,
    ),
    db.prepare(`DROP INDEX IF EXISTS idx_custom_mcp_approval_audit_event`),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_custom_mcp_approval_audit_event_v2
			 ON shiplet_custom_mcp_approval_audit (approval_id, event_kind, sequence)`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_binding_immutable
			 BEFORE UPDATE ON shiplet_custom_mcp_approvals
			 WHEN OLD.id IS NOT NEW.id
				OR OLD.binding_digest IS NOT NEW.binding_digest
				OR OLD.confirmation_nonce_digest IS NOT NEW.confirmation_nonce_digest
				OR OLD.project_id IS NOT NEW.project_id
				OR OLD.revision_id IS NOT NEW.revision_id
				OR OLD.activation_generation IS NOT NEW.activation_generation
				OR OLD.actor_kind IS NOT NEW.actor_kind
				OR OLD.actor_id IS NOT NEW.actor_id
				OR OLD.invoker_actor_kind IS NOT NEW.invoker_actor_kind
				OR OLD.invoker_actor_id IS NOT NEW.invoker_actor_id
				OR OLD.tool_name IS NOT NEW.tool_name
				OR OLD.parent_request_id IS NOT NEW.parent_request_id
				OR OLD.child_request_id IS NOT NEW.child_request_id
				OR OLD.tool_input_digest IS NOT NEW.tool_input_digest
				OR OLD.declared_capabilities_digest IS NOT NEW.declared_capabilities_digest
				OR OLD.capability IS NOT NEW.capability
				OR OLD.resource IS NOT NEW.resource
				OR OLD.action_summary IS NOT NEW.action_summary
				OR OLD.change_summary IS NOT NEW.change_summary
				OR OLD.resource_summary IS NOT NEW.resource_summary
				OR OLD.review_target_json IS NOT NEW.review_target_json
				OR OLD.review_input_json IS NOT NEW.review_input_json
				OR OLD.effect IS NOT NEW.effect
				OR OLD.capability_input_digest IS NOT NEW.capability_input_digest
				OR (
					(OLD.grant_id IS NOT NEW.grant_id
						OR OLD.grant_generation IS NOT NEW.grant_generation)
					AND NOT (
						OLD.status = 'confirmed' AND NEW.status = 'claiming'
						AND OLD.grant_id IS NULL
						AND OLD.grant_generation IS NULL
						AND NEW.grant_id IS NOT NULL
						AND NEW.grant_generation IS NOT NULL
					)
				)
				OR (
					OLD.approval_digest IS NOT NEW.approval_digest
					AND NOT (
						OLD.status = 'claiming' AND NEW.status = 'claimed'
						AND OLD.approval_digest IS NULL
						AND NEW.approval_digest IS NOT NULL
					)
				)
				OR OLD.issuance_idempotency_key IS NOT NEW.issuance_idempotency_key
				OR OLD.expires_at_ms IS NOT NEW.expires_at_ms
				OR (
					OLD.confirmed_at_ms IS NOT NEW.confirmed_at_ms
					AND NOT (
						OLD.status = 'pending' AND NEW.status = 'confirmed'
						AND OLD.confirmed_at_ms IS NULL
						AND NEW.confirmed_at_ms IS NOT NULL
					)
				)
				OR (
					OLD.claimed_at_ms IS NOT NEW.claimed_at_ms
					AND NOT (
						OLD.status = 'confirmed' AND NEW.status = 'claiming'
						AND OLD.claimed_at_ms IS NULL
						AND NEW.claimed_at_ms IS NOT NULL
					)
				)
				OR (
					OLD.claim_lease_expires_at_ms IS NOT NEW.claim_lease_expires_at_ms
					AND NOT (
						OLD.status = 'confirmed' AND NEW.status = 'claiming'
						AND OLD.claim_lease_expires_at_ms IS NULL
						AND NEW.claim_lease_expires_at_ms IS NOT NULL
					)
				)
				OR (
					OLD.dispatch_started_at_ms IS NOT NEW.dispatch_started_at_ms
					AND NOT (
						OLD.status = 'claimed' AND NEW.status = 'dispatching'
						AND OLD.dispatch_started_at_ms IS NULL
						AND NEW.dispatch_started_at_ms IS NOT NULL
					)
				)
				OR (
					OLD.dispatch_lease_expires_at_ms IS NOT NEW.dispatch_lease_expires_at_ms
					AND NOT (
						OLD.status = 'claimed' AND NEW.status = 'dispatching'
						AND OLD.dispatch_lease_expires_at_ms IS NULL
						AND NEW.dispatch_lease_expires_at_ms IS NOT NULL
					)
				)
				OR (
					OLD.dispatch_completed_at_ms IS NOT NEW.dispatch_completed_at_ms
					AND NOT (
						OLD.status = 'dispatching'
						AND NEW.status IN ('dispatched', 'aborted', 'reconciliation_required')
						AND OLD.dispatch_completed_at_ms IS NULL
						AND NEW.dispatch_completed_at_ms IS NOT NULL
					)
				)
				OR (
					OLD.revoked_at_ms IS NOT NEW.revoked_at_ms
					AND NOT (
						OLD.status IN ('pending', 'confirmed', 'claimed')
						AND NEW.status = 'revoked'
						AND OLD.revoked_at_ms IS NULL
						AND NEW.revoked_at_ms IS NOT NULL
					)
				)
				OR OLD.created_at_ms IS NOT NEW.created_at_ms
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_binding_immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_state_machine
			 BEFORE UPDATE OF status ON shiplet_custom_mcp_approvals
			 WHEN NOT (
				(OLD.status = 'pending' AND NEW.status IN ('confirmed', 'revoked'))
				OR (OLD.status = 'confirmed' AND NEW.status IN ('claiming', 'revoked'))
				OR (OLD.status = 'claiming' AND NEW.status IN (
					'claimed', 'failed', 'reconciliation_required'
				))
				OR (OLD.status = 'reconciliation_required' AND NEW.status = 'failed')
				OR (OLD.status = 'claimed' AND NEW.status IN ('dispatching', 'revoked'))
				OR (OLD.status = 'dispatching' AND NEW.status IN (
					'dispatched', 'aborted', 'reconciliation_required'
				))
			 )
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_invalid_transition');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_no_delete
			 BEFORE DELETE ON shiplet_custom_mcp_approvals
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_audit_no_update
			 BEFORE UPDATE ON shiplet_custom_mcp_approval_audit
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_audit_immutable');
			 END`,
    ),
    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS shiplet_custom_mcp_approval_audit_no_delete
			 BEFORE DELETE ON shiplet_custom_mcp_approval_audit
			 BEGIN
				SELECT RAISE(ABORT, 'custom_mcp_approval_audit_immutable');
			 END`,
    ),
  ]);
}

export function createD1CustomMcpApprovalService(
  options: D1CustomMcpApprovalServiceOptions,
): D1CustomMcpApprovalKernel {
  if (
    typeof options !== "object" ||
    options === null ||
    !options.db ||
    typeof options.now !== "function" ||
    !validLimits(options.limits) ||
    typeof options.resolveActiveRevision !== "function" ||
    typeof options.issueTrustedApproval !== "function" ||
    typeof options.resolveCapabilityGrant !== "function" ||
    typeof options.resolveDispatchAuthorityAtomically !== "function" ||
    typeof options.revokeTrustedApproval !== "function" ||
    (options.digestTrustedApprovalId !== undefined &&
      typeof options.digestTrustedApprovalId !== "function") ||
    typeof options.compensateTrustedApproval !== "function" ||
    typeof options.reconcileTrustedApprovalIssuance !== "function"
  ) {
    throw new TypeError("Invalid custom MCP approval service options");
  }
  const { db } = options;

  const findExact = async (
    request: StableApprovalRequest,
    status: string,
  ): Promise<ApprovalRow | null> =>
    db
      .prepare(
        `SELECT * FROM shiplet_custom_mcp_approvals
				 WHERE binding_digest = ? AND project_id = ? AND revision_id = ?
					AND activation_generation = ? AND actor_kind = 'human'
					AND actor_id = ? AND invoker_actor_kind = ?
					AND invoker_actor_id = ? AND tool_name = ?
					AND parent_request_id = ? AND child_request_id = ?
					AND tool_input_digest = ?
					AND declared_capabilities_digest = ?
					AND capability = ? AND resource = ? AND effect = 'mutation'
					AND capability_input_digest = ? AND status = ?`,
      )
      .bind(
        request.bindingDigest,
        request.shipletId,
        request.revisionId,
        request.activationGeneration,
        request.trustedApprover.id,
        request.invokerActor.kind,
        request.invokerActor.id,
        request.toolName,
        request.parentRequestId,
        request.childRequestId,
        request.toolInputDigest,
        request.declaredCapabilitiesDigest,
        request.capabilityDigest,
        request.resourceDigest,
        request.capabilityInputDigest,
        status,
      )
      .first<ApprovalRow>();

  const findByRequestIdentity = async (
    request: StableApprovalRequest,
  ): Promise<ApprovalRow | null> =>
    db
      .prepare(
        `SELECT * FROM shiplet_custom_mcp_approvals
			 WHERE project_id = ? AND revision_id = ?
			   AND activation_generation = ? AND actor_kind = 'human'
			   AND actor_id = ? AND invoker_actor_kind = ? AND invoker_actor_id = ?
			   AND parent_request_id = ? AND child_request_id = ?`,
      )
      .bind(
        request.shipletId,
        request.revisionId,
        request.activationGeneration,
        request.trustedApprover.id,
        request.invokerActor.kind,
        request.invokerActor.id,
        request.parentRequestId,
        request.childRequestId,
      )
      .first<ApprovalRow>();

  const auditDeniedAttempt = async (input: {
    row: ApprovalRow;
    eventKind: string;
    outcome: "denied" | "mismatched" | "replayed" | "revoked";
    actor?: Readonly<{ kind: "human"; id: string }>;
    now: number;
  }): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO shiplet_custom_mcp_approval_audit (
				approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
				event_kind, outcome, request_id, tool_name, capability,
				resource, input_digest, occurred_at_ms
			) VALUES (?, ?, ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.row.id,
        input.row.project_id,
        input.row.revision_id,
        input.row.invoker_actor_kind,
        input.row.invoker_actor_id,
        input.row.actor_id,
        input.eventKind,
        input.outcome,
        input.row.child_request_id,
        input.row.tool_name,
        input.row.capability,
        input.row.resource,
        input.row.capability_input_digest,
        input.now,
      )
      .run();
  };

  const denialOutcomeForRow = (
    row: ApprovalRow,
  ): "denied" | "replayed" | "revoked" => {
    if (row.status === "revoked") return "revoked";
    if (
      row.status === "claimed" ||
      row.status === "dispatching" ||
      row.status === "dispatched" ||
      row.status === "aborted" ||
      row.status === "reconciliation_required" ||
      row.status === "failed"
    ) {
      return "replayed";
    }
    return "denied";
  };

  const revokeApprovalForHuman = async (input: {
    approvalRequestId: string;
    trustedActor: Readonly<{ kind: "human"; id: string }>;
  }): Promise<{ ok: true } | CustomMcpApprovalDenied> => {
    if (
      !boundedString(
        input.approvalRequestId,
        options.limits.maxMetadataBytes,
      ) ||
      !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
    ) {
      return denied();
    }
    let now: number;
    try {
      now = nowFrom(options);
    } catch {
      return denied();
    }
    const row = await db
      .prepare(
        `SELECT * FROM shiplet_custom_mcp_approvals
			 WHERE id = ? AND actor_kind = 'human' AND actor_id = ?`,
      )
      .bind(input.approvalRequestId, input.trustedActor.id)
      .first<ApprovalRow>();
    if (row === null) return denied();
    if (row.status === "claimed") {
      if (row.approval_digest === null) {
        await auditDeniedAttempt({
          row,
          eventKind: "approval_revoke_denied",
          outcome: "denied",
          actor: input.trustedActor,
          now,
        });
        return denied();
      }
      let authorityRevoked = false;
      try {
        authorityRevoked = (
          await options.revokeTrustedApproval({
            approvalDigest: row.approval_digest,
            idempotencyKey: row.issuance_idempotency_key,
          })
        ).ok;
      } catch {
        authorityRevoked = false;
      }
      if (!authorityRevoked) {
        await auditDeniedAttempt({
          row,
          eventKind: "approval_revoke_denied",
          outcome: "denied",
          actor: input.trustedActor,
          now,
        });
        return denied();
      }
    } else if (row.status !== "pending" && row.status !== "confirmed") {
      await auditDeniedAttempt({
        row,
        eventKind: "approval_revoke_denied",
        outcome: denialOutcomeForRow(row),
        actor: input.trustedActor,
        now,
      });
      return denied();
    }
    const updated = await db
      .prepare(
        `UPDATE shiplet_custom_mcp_approvals
			    SET status = 'revoked', revoked_at_ms = ?
			  WHERE id = ? AND actor_kind = 'human' AND actor_id = ?
			    AND status IN ('pending', 'confirmed', 'claimed')`,
      )
      .bind(now, row.id, input.trustedActor.id)
      .run();
    if (updated.meta.changes !== 1) {
      await auditDeniedAttempt({
        row,
        eventKind: "approval_revoke_denied",
        outcome: "denied",
        actor: input.trustedActor,
        now,
      });
      return denied();
    }
    await db
      .prepare(
        `INSERT INTO shiplet_custom_mcp_approval_audit (
				approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
				event_kind, outcome, request_id, tool_name, capability,
				resource, input_digest, occurred_at_ms
			) VALUES (?, ?, ?, ?, ?, 'human', ?, 'approval_revoked', 'revoked',
			          ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.project_id,
        row.revision_id,
        row.invoker_actor_kind,
        row.invoker_actor_id,
        row.actor_id,
        row.child_request_id,
        row.tool_name,
        row.capability,
        row.resource,
        row.capability_input_digest,
        now,
      )
      .run();
    return { ok: true as const };
  };

  const revokeIfActivationBecameInactive = async (
    row: ApprovalRow,
    trustedActor: Readonly<{ kind: "human"; id: string }>,
  ): Promise<ApprovalRow> => {
    if (
      (row.status !== "pending" && row.status !== "confirmed") ||
      row.actor_kind !== "human" ||
      row.actor_id !== trustedActor.id
    ) {
      return row;
    }
    const active = await db
      .prepare(
        `SELECT 1 AS active FROM projects project
         WHERE project.id = ? AND project.archived_on IS NULL
          AND project.active_revision_id = ?
          AND project.active_revision_generation = ? LIMIT 1`,
      )
      .bind(row.project_id, row.revision_id, row.activation_generation)
      .first<{ active: number }>();
    if (active?.active === 1) return row;
    await revokeApprovalForHuman({
      approvalRequestId: row.id,
      trustedActor,
    });
    return (
      (await db
        .prepare(`SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?`)
        .bind(row.id)
        .first<ApprovalRow>()) ?? row
    );
  };

  const implementation = {
    async begin(input: {
      request: CustomMcpMutationApprovalRequest;
      grant: CapabilityGrant;
    }): Promise<CustomMcpApprovalChallenge> {
      const now = nowFrom(options);
      const request = await stableRequest(input.request, options.limits);
      const authoritativeGrant = await resolveAuthoritativeGrant(
        options,
        request,
        input.grant,
        now,
      );
      if (
        authoritativeGrant === null ||
        !(await activeMatches(options, request))
      ) {
        throw new Error("Custom MCP approval scope unavailable");
      }
      const approvalRequestId = `mcp_approval_${crypto.randomUUID()}`;
      const confirmationNonce = randomNonce();
      const nonceDigest = await sha256(confirmationNonce);
      const expiresAt = Math.min(
        now + request.ttlMs,
        authoritativeGrant.expiresAt,
      );
      const issuanceIdempotencyKey = `mcp-approval-issuance:${approvalRequestId}`;
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO shiplet_custom_mcp_approvals (
							id, binding_digest, confirmation_nonce_digest, project_id, revision_id,
							activation_generation, actor_kind, actor_id,
							invoker_actor_kind, invoker_actor_id, tool_name,
							parent_request_id, child_request_id, tool_input_digest,
							declared_capabilities_digest, capability, resource,
							action_summary, change_summary, resource_summary,
							review_target_json, review_input_json, effect,
							capability_input_digest, grant_id, grant_generation,
							approval_digest, issuance_idempotency_key,
							expires_at_ms, status, created_at_ms
						) SELECT ?, ?, ?, ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
						         'mutation', ?, ?, ?, NULL, ?, ?, 'pending', ?
						   FROM projects project
						   JOIN shiplet_revisions revision
						     ON revision.id = ? AND revision.project_id = project.id
						  WHERE project.id = ?
						    AND project.archived_on IS NULL
						    AND project.active_revision_id = ?
						    AND project.active_revision_generation = ?`,
          )
          .bind(
            approvalRequestId,
            request.bindingDigest,
            nonceDigest,
            request.shipletId,
            request.revisionId,
            request.activationGeneration,
            request.trustedApprover.id,
            request.invokerActor.kind,
            request.invokerActor.id,
            request.toolName,
            request.parentRequestId,
            request.childRequestId,
            request.toolInputDigest,
            request.declaredCapabilitiesDigest,
            request.capabilityDigest,
            request.resourceDigest,
            request.actionSummary,
            request.changeSummary,
            request.resourceSummary,
            request.reviewTargetJson,
            request.reviewInputJson,
            request.capabilityInputDigest,
            authoritativeGrant.id,
            authoritativeGrant.generation,
            issuanceIdempotencyKey,
            expiresAt,
            now,
            request.revisionId,
            request.shipletId,
            request.revisionId,
            request.activationGeneration,
          ),
        db
          .prepare(
            `INSERT INTO shiplet_custom_mcp_approval_audit (
							approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
							event_kind, outcome, request_id, tool_name, capability,
							resource, input_digest, occurred_at_ms
						) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
						         'approval_requested', 'pending', child_request_id,
						         tool_name, capability, resource, capability_input_digest, ?
						    FROM shiplet_custom_mcp_approvals WHERE id = ?`,
          )
          .bind(now, approvalRequestId),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        throw new Error("Custom MCP approval scope unavailable");
      }
      return Object.freeze({
        approvalRequestId,
        confirmationNonce,
        expiresAt,
      });
    },

    async getOrBeginResumable(
      input: CustomMcpMutationApprovalRequest,
    ): Promise<ResumableCustomMcpApproval> {
      const now = nowFrom(options);
      const request = await stableRequest(input, options.limits);
      if (!(await activeMatches(options, request))) {
        throw new Error("Custom MCP approval scope unavailable");
      }
      const identity = await findByRequestIdentity(request);
      if (
        identity !== null &&
        identity.binding_digest !== request.bindingDigest
      ) {
        await auditDeniedAttempt({
          row: identity,
          eventKind: "approval_binding_mismatch",
          outcome: "mismatched",
          actor: request.trustedApprover,
          now,
        });
        throw new Error("Custom MCP request identity already bound");
      }
      const existing = await db
        .prepare(
          `SELECT * FROM shiplet_custom_mcp_approvals
				 WHERE binding_digest = ?`,
        )
        .bind(request.bindingDigest)
        .first<ApprovalRow>();
      if (existing !== null) {
        if (
          !rowMatchesRequest(existing, request) ||
          existing.confirmation_nonce_digest !== null ||
          (existing.status !== "pending" && existing.status !== "confirmed") ||
          existing.expires_at_ms <= now
        ) {
          throw new Error("Custom MCP approval unavailable");
        }
        return Object.freeze({
          approvalRequestId: existing.id,
          expiresAt: existing.expires_at_ms,
          confirmationPath: `/api/mcp/approvals/${encodeURIComponent(existing.id)}/confirm`,
        });
      }

      const approvalRequestId = `mcp_approval_${crypto.randomUUID()}`;
      const expiresAt = now + request.ttlMs;
      const issuanceIdempotencyKey = `mcp-approval-issuance:${approvalRequestId}`;
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO shiplet_custom_mcp_approvals (
							id, binding_digest, confirmation_nonce_digest,
							project_id, revision_id, activation_generation,
							actor_kind, actor_id, invoker_actor_kind, invoker_actor_id,
							tool_name, parent_request_id,
							child_request_id, tool_input_digest,
							declared_capabilities_digest, capability, resource,
							action_summary, change_summary, resource_summary,
							review_target_json, review_input_json, effect,
							capability_input_digest, grant_id, grant_generation,
							approval_digest, issuance_idempotency_key,
							expires_at_ms, status, created_at_ms
						) SELECT ?, ?, NULL, ?, ?, ?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
						         'mutation', ?, NULL, NULL, NULL, ?, ?, 'pending', ?
						    FROM projects project
						    JOIN shiplet_revisions revision
						      ON revision.id = ? AND revision.project_id = project.id
						   WHERE project.id = ?
						     AND project.archived_on IS NULL
						     AND project.active_revision_id = ?
						     AND project.active_revision_generation = ?`,
          )
          .bind(
            approvalRequestId,
            request.bindingDigest,
            request.shipletId,
            request.revisionId,
            request.activationGeneration,
            request.trustedApprover.id,
            request.invokerActor.kind,
            request.invokerActor.id,
            request.toolName,
            request.parentRequestId,
            request.childRequestId,
            request.toolInputDigest,
            request.declaredCapabilitiesDigest,
            request.capabilityDigest,
            request.resourceDigest,
            request.actionSummary,
            request.changeSummary,
            request.resourceSummary,
            request.reviewTargetJson,
            request.reviewInputJson,
            request.capabilityInputDigest,
            issuanceIdempotencyKey,
            expiresAt,
            now,
            request.revisionId,
            request.shipletId,
            request.revisionId,
            request.activationGeneration,
          ),
        db
          .prepare(
            `INSERT OR IGNORE INTO shiplet_custom_mcp_approval_audit (
							approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
							event_kind, outcome, request_id, tool_name, capability,
							resource, input_digest, occurred_at_ms
						) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
						         'approval_requested', 'pending', child_request_id,
						         tool_name, capability, resource, capability_input_digest, ?
						    FROM shiplet_custom_mcp_approvals WHERE id = ?`,
          )
          .bind(now, approvalRequestId),
      ]);
      const persisted = await db
        .prepare(
          `SELECT * FROM shiplet_custom_mcp_approvals
				 WHERE binding_digest = ?`,
        )
        .bind(request.bindingDigest)
        .first<ApprovalRow>();
      if (
        persisted === null ||
        !rowMatchesRequest(persisted, request) ||
        persisted.confirmation_nonce_digest !== null ||
        (persisted.status !== "pending" && persisted.status !== "confirmed") ||
        persisted.expires_at_ms <= now
      ) {
        throw new Error("Custom MCP approval scope unavailable");
      }
      return Object.freeze({
        approvalRequestId: persisted.id,
        expiresAt: persisted.expires_at_ms,
        confirmationPath: `/api/mcp/approvals/${encodeURIComponent(persisted.id)}/confirm`,
      });
    },

    async confirm(input: {
      approvalRequestId: string;
      confirmationNonce: string;
      trustedActor: CapabilityActor;
    }) {
      let now: number;
      if (
        !boundedString(
          input?.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !boundedString(
          input.confirmationNonce,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      try {
        now = nowFrom(options);
      } catch {
        return denied();
      }
      const results = await db.batch([
        db
          .prepare(
            `UPDATE shiplet_custom_mcp_approvals
						    SET status = 'confirmed', confirmed_at_ms = ?
						  WHERE id = ? AND confirmation_nonce_digest = ?
						    AND actor_kind = 'human' AND actor_id = ?
						    AND status = 'pending' AND expires_at_ms > ?
						    AND EXISTS (
							SELECT 1 FROM projects project
							 WHERE project.id = project_id
							   AND project.archived_on IS NULL
							   AND project.active_revision_id = revision_id
							   AND project.active_revision_generation = activation_generation
						    )`,
          )
          .bind(
            now,
            input.approvalRequestId,
            await sha256(input.confirmationNonce),
            input.trustedActor.id,
            now,
          ),
        db
          .prepare(
            `INSERT INTO shiplet_custom_mcp_approval_audit (
							approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
							event_kind, outcome, request_id, tool_name, capability,
							resource, input_digest, occurred_at_ms
						) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
						         'approval_confirmed', 'allowed', child_request_id,
						         tool_name, capability, resource, capability_input_digest, ?
						    FROM shiplet_custom_mcp_approvals
						   WHERE id = ? AND status = 'confirmed'
						     AND confirmed_at_ms = ? AND changes() = 1`,
          )
          .bind(now, input.approvalRequestId, now),
      ]);
      if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
        return { ok: true as const };
      }
      let deniedRow = await db
        .prepare(`SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?`)
        .bind(input.approvalRequestId)
        .first<ApprovalRow>();
      if (deniedRow !== null) {
        deniedRow = await revokeIfActivationBecameInactive(
          deniedRow,
          input.trustedActor,
        );
        await auditDeniedAttempt({
          row: deniedRow,
          eventKind: "approval_confirmation_denied",
          outcome: denialOutcomeForRow(deniedRow),
          actor: input.trustedActor,
          now,
        });
      }
      return denied();
    },

    async confirmResumableFromTrustedRoute(input: {
      approvalRequestId: string;
      proof: unknown;
    }) {
      if (
        typeof input?.proof !== "object" ||
        input.proof === null ||
        !trustedRouteConfirmationProofs.has(input.proof)
      ) {
        return denied();
      }
      trustedRouteConfirmationProofs.delete(input.proof);
      const proof = input.proof as TrustedRouteConfirmationProof;
      if (
        proof.decision !== "confirm" ||
        proof.approvalRequestId !== input.approvalRequestId ||
        !boundedString(
          input.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(proof.actor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      let now: number;
      try {
        now = nowFrom(options);
      } catch {
        return denied();
      }
      const results = await db.batch([
        db
          .prepare(
            `UPDATE shiplet_custom_mcp_approvals
						    SET status = 'confirmed', confirmed_at_ms = ?
						  WHERE id = ? AND confirmation_nonce_digest IS NULL
						    AND actor_kind = 'human' AND actor_id = ?
						    AND status = 'pending' AND expires_at_ms > ?
						    AND EXISTS (
							SELECT 1 FROM projects project
							 WHERE project.id = project_id
							   AND project.archived_on IS NULL
							   AND project.active_revision_id = revision_id
							   AND project.active_revision_generation = activation_generation
						    )`,
          )
          .bind(now, input.approvalRequestId, proof.actor.id, now),
        db
          .prepare(
            `INSERT INTO shiplet_custom_mcp_approval_audit (
							approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
							event_kind, outcome, request_id, tool_name, capability,
							resource, input_digest, occurred_at_ms
						) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
						         'approval_confirmed', 'allowed', child_request_id,
						         tool_name, capability, resource, capability_input_digest, ?
						    FROM shiplet_custom_mcp_approvals
						   WHERE id = ? AND status = 'confirmed'
						     AND confirmed_at_ms = ? AND changes() = 1`,
          )
          .bind(now, input.approvalRequestId, now),
      ]);
      if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
        return { ok: true as const };
      }
      let deniedRow = await db
        .prepare(`SELECT * FROM shiplet_custom_mcp_approvals WHERE id = ?`)
        .bind(input.approvalRequestId)
        .first<ApprovalRow>();
      if (deniedRow !== null) {
        deniedRow = await revokeIfActivationBecameInactive(
          deniedRow,
          proof.actor,
        );
        await auditDeniedAttempt({
          row: deniedRow,
          eventKind: "approval_confirmation_denied",
          outcome: denialOutcomeForRow(deniedRow),
          actor: proof.actor,
          now,
        });
      }
      return denied();
    },

    async denyResumableFromTrustedRoute(input: {
      approvalRequestId: string;
      proof: unknown;
    }) {
      if (
        typeof input?.proof !== "object" ||
        input.proof === null ||
        !trustedRouteConfirmationProofs.has(input.proof)
      ) {
        return denied();
      }
      trustedRouteConfirmationProofs.delete(input.proof);
      const proof = input.proof as TrustedRouteConfirmationProof;
      if (
        proof.decision !== "deny" ||
        proof.approvalRequestId !== input.approvalRequestId ||
        !boundedString(
          input.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(proof.actor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      return revokeApprovalForHuman({
        approvalRequestId: input.approvalRequestId,
        trustedActor: proof.actor,
      });
    },

    async readTrustedConfirmation(input: {
      approvalRequestId: string;
      trustedActor: CapabilityActor;
    }) {
      let now: number;
      if (
        !boundedString(
          input?.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      try {
        now = nowFrom(options);
      } catch {
        return denied();
      }
      const row = await db
        .prepare(
          `SELECT * FROM shiplet_custom_mcp_approvals
				 WHERE id = ? AND actor_kind = 'human' AND actor_id = ?
				   AND status IN ('pending', 'confirmed') AND expires_at_ms > ?
				   AND EXISTS (
					SELECT 1 FROM projects project
					 WHERE project.id = project_id
					   AND project.archived_on IS NULL
					   AND project.active_revision_id = revision_id
					   AND project.active_revision_generation = activation_generation
				   )`,
        )
        .bind(input.approvalRequestId, input.trustedActor.id, now)
        .first<ApprovalRow>();
      if (row === null) return denied();
      const review = parseTrustedReviewProjection(row);
      if (review === null) return denied();
      return Object.freeze({
        ok: true as const,
        approval: Object.freeze({
          approvalRequestId: row.id,
          actionSummary: row.action_summary,
          changeSummary: row.change_summary,
          resourceSummary: row.resource_summary,
          tool: Object.freeze({
            name: row.tool_name,
            trust: "untrusted_package_content" as const,
          }),
          invoker: Object.freeze({
            kind: row.invoker_actor_kind as CapabilityActor["kind"],
            label: safeInvokerLabel(
              row.invoker_actor_kind as CapabilityActor["kind"],
            ),
          }),
          scope: Object.freeze({
            shipletId: row.project_id,
            revisionId: row.revision_id,
            activationGeneration: row.activation_generation,
          }),
          review: Object.freeze({
            trust: "untrusted_quoted_data" as const,
            target: review.target,
            input: review.input,
          }),
          expiresAt: row.expires_at_ms,
          trust: "trusted_kernel" as const,
        }),
      });
    },

    async claim(input: {
      request: CustomMcpMutationApprovalRequest;
      grant: CapabilityGrant;
    }) {
      let now: number;
      let request: StableApprovalRequest;
      try {
        now = nowFrom(options);
        request = await stableRequest(input.request, options.limits);
      } catch {
        return denied();
      }
      const authoritativeGrant = await resolveAuthoritativeGrant(
        options,
        request,
        input.grant,
        now,
      );
      if (
        authoritativeGrant === null ||
        !(await activeMatches(options, request))
      ) {
        const deniedRow = await findByRequestIdentity(request);
        if (deniedRow !== null) {
          await auditDeniedAttempt({
            row: deniedRow,
            eventKind: "approval_claim_denied",
            outcome:
              deniedRow.binding_digest === request.bindingDigest
                ? denialOutcomeForRow(deniedRow)
                : "mismatched",
            actor: request.trustedApprover,
            now,
          });
        }
        return denied();
      }
      const candidate = await findExact(request, "confirmed");
      if (
        candidate === null ||
        !rowMatchesRequest(candidate, request) ||
        !rowMatchesGrant(candidate, authoritativeGrant) ||
        candidate.expires_at_ms <= now
      ) {
        const deniedRow = await findByRequestIdentity(request);
        if (deniedRow !== null) {
          await auditDeniedAttempt({
            row: deniedRow,
            eventKind: "approval_claim_denied",
            outcome:
              deniedRow.binding_digest === request.bindingDigest
                ? denialOutcomeForRow(deniedRow)
                : "mismatched",
            actor: request.trustedApprover,
            now,
          });
        }
        return denied();
      }
      const claim = await db
        .prepare(
          `UPDATE shiplet_custom_mcp_approvals
					    SET status = 'claiming', claimed_at_ms = ?,
					        claim_lease_expires_at_ms = ?,
					        grant_id = COALESCE(grant_id, ?),
					        grant_generation = COALESCE(grant_generation, ?)
					  WHERE id = ? AND status = 'confirmed' AND expires_at_ms > ?
					    AND (
						(grant_id IS NULL AND grant_generation IS NULL)
						OR (grant_id = ? AND grant_generation = ?)
					    )
					    AND EXISTS (
						SELECT 1 FROM projects project
						 WHERE project.id = project_id
						   AND project.archived_on IS NULL
						   AND project.active_revision_id = revision_id
						   AND project.active_revision_generation = activation_generation
					    )`,
        )
        .bind(
          now,
          now + options.limits.claimLeaseMs,
          authoritativeGrant.id,
          authoritativeGrant.generation,
          candidate.id,
          now,
          authoritativeGrant.id,
          authoritativeGrant.generation,
        )
        .run();
      if (claim.meta.changes !== 1) {
        await auditDeniedAttempt({
          row: candidate,
          eventKind: "approval_claim_denied",
          outcome: denialOutcomeForRow(candidate),
          actor: request.trustedApprover,
          now,
        });
        return denied();
      }

      const binding = trustedApprovalBinding(request, authoritativeGrant);
      const compensateIssuedAuthority = async (
        approvalId: string,
        eventKind: string,
      ): Promise<void> => {
        let compensated = false;
        try {
          compensated = (
            await options.compensateTrustedApproval({
              approvalId,
              binding,
              idempotencyKey: candidate.issuance_idempotency_key,
            })
          ).ok;
        } catch {
          compensated = false;
        }
        const terminalStatus = compensated
          ? "failed"
          : "reconciliation_required";
        try {
          await db.batch([
            db
              .prepare(
                `UPDATE shiplet_custom_mcp_approvals SET status = ?
							    WHERE id = ? AND status = 'claiming'`,
              )
              .bind(terminalStatus, candidate.id),
            db
              .prepare(
                `INSERT INTO shiplet_custom_mcp_approval_audit (
								approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
								event_kind, outcome, request_id, tool_name, capability,
								resource, input_digest, occurred_at_ms
							) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
							         ?, ?, child_request_id, tool_name, capability,
							         resource, capability_input_digest, ?
							    FROM shiplet_custom_mcp_approvals WHERE id = ?`,
              )
              .bind(
                eventKind,
                compensated ? "compensated" : "reconciliation_required",
                now,
                candidate.id,
              ),
          ]);
        } catch {
          // The durable claim lease lets recovery reconcile even when D1 is
          // unavailable at this exact post-issuance point.
        }
      };

      let approvalId: string;
      try {
        const issued = await options.issueTrustedApproval({
          binding,
          expiresAt: Math.min(
            candidate.expires_at_ms,
            authoritativeGrant.expiresAt,
          ),
          idempotencyKey: candidate.issuance_idempotency_key,
        });
        if (
          !boundedString(issued?.approvalId, options.limits.maxMetadataBytes)
        ) {
          throw new Error("Trusted approval issuer returned invalid authority");
        }
        approvalId = issued.approvalId;
      } catch {
        try {
          await db.batch([
            db
              .prepare(
                `UPDATE shiplet_custom_mcp_approvals
							    SET status = 'reconciliation_required'
							  WHERE id = ? AND status = 'claiming'`,
              )
              .bind(candidate.id),
            db
              .prepare(
                `INSERT INTO shiplet_custom_mcp_approval_audit (
								approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
								event_kind, outcome, request_id, tool_name, capability,
								resource, input_digest, occurred_at_ms
							) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
							         'approval_issuance_uncertain', 'reconciliation_required',
							         child_request_id, tool_name, capability, resource,
							         capability_input_digest, ?
							    FROM shiplet_custom_mcp_approvals WHERE id = ?`,
              )
              .bind(now, candidate.id),
          ]);
        } catch {
          // Recovery owns expired claiming rows when the failure itself cannot
          // be persisted.
        }
        return denied();
      }
      let approvalDigest: string;
      try {
        approvalDigest = await (options.digestTrustedApprovalId ?? sha256)(
          approvalId,
        );
        if (!/^sha256:[a-f0-9]{64}$/.test(approvalDigest)) {
          throw new Error("Invalid trusted approval digest");
        }
      } catch {
        await compensateIssuedAuthority(
          approvalId,
          "approval_digest_compensation",
        );
        return denied();
      }
      let finalized = false;
      try {
        const finalizationNow = nowFrom(options);
        const results = await db.batch([
          db
            .prepare(
              `UPDATE shiplet_custom_mcp_approvals
							    SET status = 'claimed', approval_digest = ?
							  WHERE id = ? AND status = 'claiming' AND claimed_at_ms = ?
							    AND claim_lease_expires_at_ms > ?`,
            )
            .bind(approvalDigest, candidate.id, now, finalizationNow),
          db
            .prepare(
              `INSERT INTO shiplet_custom_mcp_approval_audit (
								approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
								event_kind, outcome, request_id, tool_name, capability,
								resource, input_digest, occurred_at_ms
							) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
							         'approval_claimed', 'allowed', child_request_id,
							         tool_name, capability, resource, capability_input_digest, ?
							    FROM shiplet_custom_mcp_approvals
							   WHERE id = ? AND status = 'claimed' AND changes() = 1`,
            )
            .bind(finalizationNow, candidate.id),
        ]);
        if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
          throw new Error("approval_finalization_failed");
        }
        finalized = true;
      } catch {
        finalized = false;
      }
      if (!finalized) {
        await compensateIssuedAuthority(
          approvalId,
          "approval_issuance_compensation",
        );
        return denied();
      }
      return Object.freeze({ ok: true as const });
    },

    async revoke(input: {
      approvalRequestId: string;
      trustedActor: CapabilityActor;
    }) {
      if (
        !boundedString(
          input?.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      let now: number;
      try {
        now = nowFrom(options);
      } catch {
        return denied();
      }
      const row = await db
        .prepare(
          `SELECT * FROM shiplet_custom_mcp_approvals
			 WHERE id = ? AND actor_kind = 'human' AND actor_id = ?`,
        )
        .bind(input.approvalRequestId, input.trustedActor.id)
        .first<ApprovalRow>();
      if (row === null) return denied();
      if (row.status === "claimed") {
        if (row.approval_digest === null) {
          await auditDeniedAttempt({
            row,
            eventKind: "approval_revoke_denied",
            outcome: "denied",
            actor: input.trustedActor,
            now,
          });
          return denied();
        }
        let authorityRevoked = false;
        try {
          authorityRevoked = (
            await options.revokeTrustedApproval({
              approvalDigest: row.approval_digest,
              idempotencyKey: row.issuance_idempotency_key,
            })
          ).ok;
        } catch {
          authorityRevoked = false;
        }
        if (!authorityRevoked) {
          await auditDeniedAttempt({
            row,
            eventKind: "approval_revoke_denied",
            outcome: "denied",
            actor: input.trustedActor,
            now,
          });
          return denied();
        }
      } else if (row.status !== "pending" && row.status !== "confirmed") {
        await auditDeniedAttempt({
          row,
          eventKind: "approval_revoke_denied",
          outcome: denialOutcomeForRow(row),
          actor: input.trustedActor,
          now,
        });
        return denied();
      }
      const updated = await db
        .prepare(
          `UPDATE shiplet_custom_mcp_approvals
			    SET status = 'revoked', revoked_at_ms = ?
			  WHERE id = ? AND actor_kind = 'human' AND actor_id = ?
			    AND status IN ('pending', 'confirmed', 'claimed')`,
        )
        .bind(now, row.id, input.trustedActor.id)
        .run();
      if (updated.meta.changes !== 1) {
        await auditDeniedAttempt({
          row,
          eventKind: "approval_revoke_denied",
          outcome: "denied",
          actor: input.trustedActor,
          now,
        });
        return denied();
      }
      await db
        .prepare(
          `INSERT INTO shiplet_custom_mcp_approval_audit (
				approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
				event_kind, outcome, request_id, tool_name, capability,
				resource, input_digest, occurred_at_ms
			) VALUES (?, ?, ?, ?, ?, 'human', ?, 'approval_revoked', 'revoked',
			          ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.project_id,
          row.revision_id,
          row.invoker_actor_kind,
          row.invoker_actor_id,
          row.actor_id,
          row.child_request_id,
          row.tool_name,
          row.capability,
          row.resource,
          row.capability_input_digest,
          now,
        )
        .run();
      return { ok: true as const };
    },

    async recoverApprovalIssuance(input: {
      approvalRequestId: string;
      trustedActor: CapabilityActor;
    }) {
      if (
        !boundedString(
          input?.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      const row = await db
        .prepare(
          `SELECT * FROM shiplet_custom_mcp_approvals
				 WHERE id = ? AND actor_kind = 'human' AND actor_id = ?
				   AND status = 'reconciliation_required'
				   AND dispatch_started_at_ms IS NULL`,
        )
        .bind(input.approvalRequestId, input.trustedActor.id)
        .first<ApprovalRow>();
      if (row === null) return denied();
      let reconciliation: { status: "compensated" } | { status: "pending" };
      try {
        reconciliation = await options.reconcileTrustedApprovalIssuance({
          bindingDigest: row.binding_digest,
          idempotencyKey: row.issuance_idempotency_key,
        });
      } catch {
        return denied();
      }
      if (reconciliation.status !== "compensated") return denied();
      const now = nowFrom(options);
      const results = await db.batch([
        db
          .prepare(
            `UPDATE shiplet_custom_mcp_approvals SET status = 'failed'
						  WHERE id = ? AND status = 'reconciliation_required'
						    AND dispatch_started_at_ms IS NULL`,
          )
          .bind(row.id),
        db
          .prepare(
            `INSERT OR IGNORE INTO shiplet_custom_mcp_approval_audit (
							approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
							event_kind, outcome, request_id, tool_name, capability,
							resource, input_digest, occurred_at_ms
						) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
						         'approval_issuance_reconciled', 'compensated',
						         child_request_id, tool_name, capability, resource,
						         capability_input_digest, ?
						    FROM shiplet_custom_mcp_approvals WHERE id = ?`,
          )
          .bind(now, row.id),
      ]);
      return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1
        ? { ok: true as const, status: "compensated" as const }
        : denied();
    },

    async recoverStuckClaim(input: {
      approvalRequestId: string;
      trustedActor: CapabilityActor;
    }) {
      let now: number;
      if (
        !boundedString(
          input?.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      try {
        now = nowFrom(options);
      } catch {
        return denied();
      }
      const row = await db
        .prepare(
          `SELECT * FROM shiplet_custom_mcp_approvals
			 WHERE id = ? AND actor_kind = 'human' AND actor_id = ?
			   AND status = 'claiming' AND claim_lease_expires_at_ms IS NOT NULL
			   AND claim_lease_expires_at_ms <= ?`,
        )
        .bind(input.approvalRequestId, input.trustedActor.id, now)
        .first<ApprovalRow>();
      if (row === null) return denied();
      const recovered = await db
        .prepare(
          `UPDATE shiplet_custom_mcp_approvals
			    SET status = 'reconciliation_required'
			  WHERE id = ? AND status = 'claiming'
			    AND claim_lease_expires_at_ms <= ?`,
        )
        .bind(row.id, now)
        .run();
      if (recovered.meta.changes !== 1) return denied();
      await db
        .prepare(
          `INSERT INTO shiplet_custom_mcp_approval_audit (
				approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
				event_kind, outcome, request_id, tool_name, capability,
				resource, input_digest, occurred_at_ms
			) VALUES (?, ?, ?, ?, ?, 'human', ?, 'approval_claim_lease_expired',
			          'reconciliation_required', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.project_id,
          row.revision_id,
          row.invoker_actor_kind,
          row.invoker_actor_id,
          row.actor_id,
          row.child_request_id,
          row.tool_name,
          row.capability,
          row.resource,
          row.capability_input_digest,
          now,
        )
        .run();
      let reconciliation: { status: "compensated" } | { status: "pending" };
      try {
        reconciliation = await options.reconcileTrustedApprovalIssuance({
          bindingDigest: row.binding_digest,
          idempotencyKey: row.issuance_idempotency_key,
        });
      } catch {
        reconciliation = { status: "pending" };
      }
      if (reconciliation.status !== "compensated") {
        return {
          ok: true as const,
          status: "reconciliation_required" as const,
        };
      }
      const terminal = await db
        .prepare(
          `UPDATE shiplet_custom_mcp_approvals SET status = 'failed'
			  WHERE id = ? AND status = 'reconciliation_required'
			    AND dispatch_started_at_ms IS NULL`,
        )
        .bind(row.id)
        .run();
      if (terminal.meta.changes !== 1) return denied();
      await db
        .prepare(
          `INSERT INTO shiplet_custom_mcp_approval_audit (
				approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
				event_kind, outcome, request_id, tool_name, capability,
				resource, input_digest, occurred_at_ms
			) VALUES (?, ?, ?, ?, ?, 'human', ?, 'approval_issuance_reconciled',
			          'compensated', ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.project_id,
          row.revision_id,
          row.invoker_actor_kind,
          row.invoker_actor_id,
          row.actor_id,
          row.child_request_id,
          row.tool_name,
          row.capability,
          row.resource,
          row.capability_input_digest,
          now,
        )
        .run();
      return { ok: true as const, status: "compensated" as const };
    },

    async recoverStuckDispatch(input: {
      approvalRequestId: string;
      trustedActor: CapabilityActor;
    }) {
      let now: number;
      if (
        !boundedString(
          input?.approvalRequestId,
          options.limits.maxMetadataBytes,
        ) ||
        !validHumanActor(input.trustedActor, options.limits.maxMetadataBytes)
      ) {
        return denied();
      }
      try {
        now = nowFrom(options);
      } catch {
        return denied();
      }
      const results = await db.batch([
        db
          .prepare(
            `UPDATE shiplet_custom_mcp_approvals
						    SET status = 'reconciliation_required',
						        dispatch_completed_at_ms = ?
						  WHERE id = ? AND actor_kind = 'human' AND actor_id = ?
						    AND status = 'dispatching'
						    AND dispatch_lease_expires_at_ms IS NOT NULL
						    AND dispatch_lease_expires_at_ms <= ?`,
          )
          .bind(now, input.approvalRequestId, input.trustedActor.id, now),
        db
          .prepare(
            `INSERT OR IGNORE INTO shiplet_custom_mcp_approval_audit (
							approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
							event_kind, outcome, request_id, tool_name, capability,
							resource, input_digest, occurred_at_ms
						) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
						         'dispatch_completion', 'reconciliation_required',
						         child_request_id, tool_name, capability, resource,
						         capability_input_digest, ?
						    FROM shiplet_custom_mcp_approvals
						   WHERE id = ? AND status = 'reconciliation_required'
						     AND dispatch_completed_at_ms = ? AND changes() = 1`,
          )
          .bind(now, input.approvalRequestId, now),
      ]);
      return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1
        ? { ok: true as const, status: "reconciliation_required" as const }
        : denied();
    },

    async dispatchApprovedMutation(input: {
      request: CustomMcpMutationApprovalRequest;
      effect: (
        request: ConstrainedCustomMcpMutation,
      ) => Promise<CustomMcpMutationDispatchOutcome>;
    }) {
      let now: number;
      let request: StableApprovalRequest;
      try {
        now = nowFrom(options);
        request = await stableRequest(input.request, options.limits);
      } catch {
        return deniedDispatch();
      }
      if (typeof input.effect !== "function") {
        return deniedDispatch();
      }
      const candidate = await findExact(request, "claimed");
      if (
        candidate === null ||
        !rowMatchesRequest(candidate, request) ||
        candidate.grant_id === null ||
        candidate.grant_generation === null ||
        candidate.approval_digest === null ||
        candidate.expires_at_ms <= now
      ) {
        const deniedRow = await findByRequestIdentity(request);
        if (deniedRow !== null) {
          await auditDeniedAttempt({
            row: deniedRow,
            eventKind: "dispatch_denied",
            outcome:
              deniedRow.binding_digest === request.bindingDigest
                ? denialOutcomeForRow(deniedRow)
                : "mismatched",
            actor: request.trustedApprover,
            now,
          });
        }
        return deniedDispatch();
      }
      let intentResults: D1Result<unknown>[];
      const dispatchLeaseExpiresAt = now + options.limits.dispatchLeaseMs;
      try {
        intentResults = await db.batch([
          db
            .prepare(
              `UPDATE shiplet_custom_mcp_approvals
							    SET status = 'dispatching', dispatch_started_at_ms = ?,
							        dispatch_lease_expires_at_ms = ?
							  WHERE id = ? AND status = 'claimed' AND expires_at_ms > ?
							    AND EXISTS (
								SELECT 1 FROM projects project
								 WHERE project.id = project_id
								   AND project.archived_on IS NULL
								   AND project.active_revision_id = revision_id
								   AND project.active_revision_generation = activation_generation
							    )`,
            )
            .bind(now, dispatchLeaseExpiresAt, candidate.id, now),
          db
            .prepare(
              `INSERT INTO shiplet_custom_mcp_approval_audit (
								approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
								event_kind, outcome, request_id, tool_name, capability,
								resource, input_digest, occurred_at_ms
							) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
							         'dispatch_intent', 'allowed', child_request_id,
							         tool_name, capability, resource, capability_input_digest, ?
							    FROM shiplet_custom_mcp_approvals
							   WHERE id = ? AND status = 'dispatching' AND changes() = 1`,
            )
            .bind(now, candidate.id),
        ]);
      } catch {
        return deniedDispatch();
      }
      if (
        intentResults[0]?.meta.changes !== 1 ||
        intentResults[1]?.meta.changes !== 1
      ) {
        const latest = await findByRequestIdentity(request);
        if (latest !== null) {
          await auditDeniedAttempt({
            row: latest,
            eventKind: "dispatch_denied",
            outcome: denialOutcomeForRow(latest),
            actor: request.trustedApprover,
            now,
          });
        }
        return deniedDispatch();
      }

      let authorityNow: number;
      let authorityResolution: CustomMcpAtomicDispatchAuthorityResolution | null;
      try {
        authorityNow = nowFrom(options);
        authorityResolution = await options.resolveDispatchAuthorityAtomically({
          now: authorityNow,
          actor: request.invokerActor,
          shipletId: request.shipletId,
          revisionId: request.revisionId,
          activationGeneration: request.activationGeneration,
          grantId: candidate.grant_id,
          grantGeneration: candidate.grant_generation,
          approvalDigest: candidate.approval_digest,
          binding: Object.freeze({
            requestId: request.childRequestId,
            actor: request.invokerActor,
            grantId: candidate.grant_id,
            grantGeneration: candidate.grant_generation,
            shipletId: request.shipletId,
            revisionId: request.revisionId,
            action: request.capability,
            resource: request.resource,
            effect: "mutation" as const,
            approvalPolicy: "trusted-human" as const,
            inputDigest: request.capabilityInputDigest,
          }),
          idempotencyKey: candidate.issuance_idempotency_key,
        });
      } catch {
        authorityNow = now;
        authorityResolution = null;
      }
      if (
        !validAtomicDispatchAuthorityResolution(authorityResolution, {
          request,
          row: candidate,
          now: authorityNow,
        })
      ) {
        await db.batch([
          db
            .prepare(
              `UPDATE shiplet_custom_mcp_approvals
							    SET status = 'aborted', dispatch_completed_at_ms = ?
							  WHERE id = ? AND status = 'dispatching'`,
            )
            .bind(now, candidate.id),
          db
            .prepare(
              `INSERT OR IGNORE INTO shiplet_custom_mcp_approval_audit (
								approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
								event_kind, outcome, request_id, tool_name, capability,
								resource, input_digest, occurred_at_ms
							) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
							         'dispatch_completion', 'denied', child_request_id,
							         tool_name, capability, resource, capability_input_digest, ?
							    FROM shiplet_custom_mcp_approvals WHERE id = ?`,
            )
            .bind(now, candidate.id),
        ]);
        return deniedDispatch();
      }

      const effectActor = Object.freeze({ ...request.invokerActor });
      const effectAuthority: CustomMcpMutationEffectAuthority = Object.freeze({
        approvalRequestId: candidate.id,
        shipletId: request.shipletId,
        revisionId: request.revisionId,
        activationGeneration: request.activationGeneration,
        actor: effectActor,
        action: request.capability,
        resource: request.resource,
        expiresAt: candidate.expires_at_ms,
        dispatchLeaseExpiresAt,
        state: "dispatching",
      });
      trustedMutationEffectAuthorities.set(effectActor, effectAuthority);
      const constrained: ConstrainedCustomMcpMutation = Object.freeze({
        actor: effectActor,
        shipletId: request.shipletId,
        revisionId: request.revisionId,
        activationGeneration: request.activationGeneration,
        toolName: request.toolName,
        parentRequestId: request.parentRequestId,
        requestId: request.childRequestId,
        approval: Object.freeze({
          approvalRequestId: candidate.id,
          activationGeneration: request.activationGeneration,
          expiresAt: candidate.expires_at_ms,
          dispatchLeaseExpiresAt,
          state: "dispatching" as const,
        }),
        action: request.capability,
        resource: request.resource,
        effect: "mutation",
        input: request.capabilityInput,
      });
      let outcome: CustomMcpMutationDispatchOutcome;
      try {
        const candidateOutcome = await input.effect(constrained);
        const projectedOutcome = projectDispatchOutcome(
          candidateOutcome,
          options.limits,
        );
        if (projectedOutcome === null) {
          throw new Error("Invalid custom MCP dispatch outcome");
        }
        outcome = projectedOutcome;
      } catch {
        outcome = reconciliationDispatch();
      } finally {
        trustedMutationEffectAuthorities.delete(effectActor);
      }
      const completionTime = (() => {
        try {
          return nowFrom(options);
        } catch {
          return now;
        }
      })();
      const terminalStatus =
        outcome.status === "committed"
          ? "dispatched"
          : outcome.status === "aborted"
            ? "aborted"
            : "reconciliation_required";
      try {
        const completionResults = await db.batch([
          db
            .prepare(
              `UPDATE shiplet_custom_mcp_approvals
							    SET status = ?, dispatch_completed_at_ms = ?
							  WHERE id = ? AND status = 'dispatching'`,
            )
            .bind(terminalStatus, completionTime, candidate.id),
          db
            .prepare(
              `INSERT INTO shiplet_custom_mcp_approval_audit (
								approval_id, project_id, revision_id, actor_kind, actor_id,
				approver_kind, approver_id,
								event_kind, outcome, request_id, tool_name, capability,
								resource, input_digest, occurred_at_ms
							) SELECT id, project_id, revision_id, invoker_actor_kind, invoker_actor_id,
						         actor_kind, actor_id,
							         'dispatch_completion', ?, child_request_id,
							         tool_name, capability, resource, capability_input_digest, ?
							    FROM shiplet_custom_mcp_approvals
							   WHERE id = ? AND status = ? AND changes() = 1`,
            )
            .bind(outcome.status, completionTime, candidate.id, terminalStatus),
        ]);
        if (
          completionResults[0]?.meta.changes !== 1 ||
          completionResults[1]?.meta.changes !== 1
        ) {
          return reconciliationDispatch();
        }
      } catch {
        return reconciliationDispatch();
      }
      return outcome;
    },
  } as const;
  const { begin, confirm, ...resumableService } = implementation;
  return Object.freeze({
    ...resumableService,
    legacyNonceCeremony: Object.freeze({ begin, confirm }),
  });
}
