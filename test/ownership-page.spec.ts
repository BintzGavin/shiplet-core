import { describe, expect, it } from "vitest";
import { parse } from "acorn";

import {
  AdaptOwnershipPageModel,
  BuildOwnershipActionRequest,
  BuildOwnershipFailurePage,
  BuildShipletOwnershipPage,
  type ShipletOwnershipPageModel,
} from "../src/platform/ownership-page";
import {
  BuildOwnershipController,
  OwnershipActionFailureState,
} from "../src/platform/ownership-controller";
import type { KernelDocumentNonce } from "../src/kernel-document-nonce";

const BASE_MODEL: ShipletOwnershipPageModel = {
  shiplet: {
    id: "shiplet_alpha",
    name: "Launch review",
    activeRevision: {
      id: "rev_active",
      label: "Revision 4",
      createdAt: "2026-08-05T15:00:00.000Z",
      validatedAt: "2026-08-05T15:01:00.000Z",
    },
  },
  managed: {
    status: "active",
    runtime: "static",
    arbitraryWorkerExecution: {
      available: false,
      reason: "managed_dynamic_unavailable",
    },
  },
  revisions: {
    drafts: [],
    history: [],
  },
  cloudflare: {
    state: "empty",
    connectAvailable: true,
    targets: [],
  },
  temporaryClaim: {
    status: "ready",
  },
  export: {
    available: true,
  },
};

function render(overrides: Partial<ShipletOwnershipPageModel> = {}) {
  return BuildShipletOwnershipPage({
    ...BASE_MODEL,
    ...overrides,
    shiplet: { ...BASE_MODEL.shiplet, ...overrides.shiplet },
    managed: { ...BASE_MODEL.managed, ...overrides.managed },
    revisions: { ...BASE_MODEL.revisions, ...overrides.revisions },
    cloudflare: { ...BASE_MODEL.cloudflare, ...overrides.cloudflare },
    temporaryClaim: {
      ...BASE_MODEL.temporaryClaim,
      ...overrides.temporaryClaim,
    },
    export: { ...BASE_MODEL.export, ...overrides.export },
  });
}

describe("Shiplet ownership page", () => {
  it("discloses the fail-closed customer Worker egress prerequisite", () => {
    const html = render().body;
    expect(html).toContain("Static packages can deploy here now");
    expect(html).toContain("enforceable outbound mediation path");
    expect(html).toContain(
      "will not deploy arbitrary customer-owned code with unrestricted network access",
    );
  });
  it("Given a static Shiplet, when ownership is opened, then managed hosting is the obvious default and advanced runtime limits are honest", () => {
    const page = render();

    expect(page.title).toBe("Ownership · Launch review · Shiplet");
    expect(page.body).toContain("Where this Shiplet runs");
    expect(page.body).toContain("Shiplet-managed");
    expect(page.body).toContain("Running");
    expect(page.body).toContain("Static files");
    expect(page.body).toContain("Owned and operated by Shiplet");
    expect(page.body).toContain(
      "Shiplet manages publishing, review access, revisions, and rollback.",
    );
    expect(page.body).toContain(
      "Managed arbitrary Worker execution is not available",
    );
    expect(page.body).toContain("Create draft");
    expect(page.body).not.toContain("Connect Cloudflare</a></div>");
  });

  it("Given a validated draft, when revisions render, then comparison and promotion are the primary path and rollback remains available", () => {
    const page = render({
      revisions: {
        drafts: [
          {
            id: "draft_5",
            label: "Draft 5",
            parentRevisionId: "rev_parent",
            state: "validated",
            version: 3,
            validatedRevisionId: "rev_validated_5",
            updatedAt: "2026-08-05T16:00:00.000Z",
            summary: "Updated widget and review workflow",
          },
        ],
        history: [
          {
            id: "rev_previous",
            label: "Revision 3",
            createdAt: "2026-08-04T15:00:00.000Z",
            status: "known_good",
          },
        ],
      },
    });

    expect(page.body).toContain("Validated and ready to promote");
    expect(page.body).toContain("Compare with active revision");
    expect(page.body).toContain('data-shiplet-action="compare"');
    expect(page.body).toContain(
      'data-draft-package-endpoint="/api/drafts/draft_5/package"',
    );
    expect(page.body).toContain(
      'data-base-package-endpoint="/api/shiplets/shiplet_alpha/revisions/rev_active/package"',
    );
    expect(page.body).toContain('data-shiplet-action="promote"');
    expect(page.body).toContain(
      'data-action-endpoint="/api/drafts/draft_5/promote"',
    );
    expect(page.body).toContain('data-expected-version="3"');
    expect(page.body).toContain(
      'data-expected-active-revision-id="rev_active"',
    );
    expect(page.body).toContain('data-requires-approval="true"');
    expect(page.body).toContain('data-preview-revision-id="rev_validated_5"');
    expect(page.body).toMatch(
      /data-shiplet-action="promote"[^>]+disabled[^>]*>Promote Draft 5/,
    );
    expect(page.body).toContain(
      "Open the sealed preview in this browser session to enable promotion",
    );
    expect(page.body).toContain("Promote Draft 5");
    expect(page.body).toContain('data-shiplet-action="rollback"');
    expect(page.body).toContain(
      'data-action-endpoint="/api/shiplets/shiplet_alpha/rollback"',
    );
    expect(page.body).toContain("Roll back to Revision 3");
    expect(page.body.indexOf("Promote Draft 5")).toBeLessThan(
      page.body.indexOf("Connect Cloudflare"),
    );
  });

  it("Given rollback, promotion, redeployment, and revocation controls, when ownership renders, then each trusted confirmation names the exact subject and consequence", () => {
    const page = render({
      revisions: {
        drafts: [
          {
            id: "draft_5",
            label: "Draft 5",
            parentRevisionId: "rev_active",
            state: "validated",
            version: 3,
            validatedRevisionId: "rev_validated_5",
            updatedAt: "2026-08-05T16:00:00.000Z",
          },
        ],
        history: [
          {
            id: "rev_previous",
            label: "Revision 3",
            createdAt: "2026-08-04T15:00:00.000Z",
            status: "known_good",
          },
        ],
      },
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        connectionId: "connection_customer",
        accountLabel: "Example Cloudflare account",
        scopes: ["workers.scripts.read", "workers.scripts.write"],
        targets: [
          {
            id: "target_customer",
            label: "Production Worker",
            ownership: "customer",
            status: "offline",
            activeRevisionId: "rev_previous",
            drift: "drifted",
            updatesAvailable: true,
            running: false,
          },
        ],
      },
    });

    expect(page.body).toContain(
      "Promote Draft 5 as revision rev_validated_5 to the Shiplet-managed target",
    );
    expect(page.body).toContain(
      "replace active revision rev_active for managed traffic",
    );
    expect(page.body).toContain(
      "Roll back the Shiplet-managed target from Revision 4 (rev_active) to Revision 3 (rev_previous)",
    );
    expect(page.body).toContain(
      "Redeploy Revision 4 (rev_active) to Production Worker (target_customer)",
    );
    expect(page.body).toContain(
      "Revoke Shiplet access to Example Cloudflare account through connection connection_customer",
    );
    expect(page.body).not.toContain(
      "Confirm this Shiplet revision or deployment change",
    );
  });

  it("Given trusted package content, when comparison and editing open, then structured summaries lead and raw JSON stays progressively disclosed", () => {
    const controller = BuildOwnershipController({
      shipletId: "shiplet_alpha",
      nonce: "ownership-page-test-nonce-12345" as KernelDocumentNonce,
    });

    expect(controller).toContain("Changed files");
    expect(controller).toContain("Manifest changes");
    expect(controller).toContain("Capability changes");
    expect(controller).toContain("Package contents");
    expect(controller).toContain("Advanced: view raw package JSON");
    expect(controller).toContain("Advanced: edit raw package JSON");
    expect(controller).toContain("data-preview-receipt-required");
    expect(controller).toContain("receiptVerifiedPromotions");
    expect(controller).toContain("receipt.shipletId === config.shipletId");
    expect(controller).not.toContain("sessionStorage");
    expect(controller).toContain("operationIntents");
    expect(controller).toContain("uncertainOperation");
    expect(controller).toContain("data-operation-retry");
    expect(controller).toContain("if (existing) return existing");
    expect(controller).toContain(
      "effectStarted && exactRetryActions.has(action)",
    );
    expect(controller).toContain("button.dataset.confirmationMessage");
    expect(controller).not.toContain(
      "Confirm this Shiplet revision or deployment change",
    );
    const script = controller.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => parse(script || "", { ecmaVersion: "latest" })).not.toThrow();
  });

  it.each([
    {
      input: { offline: true, status: 503 },
      tone: "warning",
      copy: "You appear to be offline. No deployment or revision change was attempted. Reconnect before retrying.",
    },
    {
      input: { offline: false, status: 401 },
      tone: "warning",
      copy: "Your current session does not have access to complete this action. Sign in with an authorized account or ask a Shiplet owner.",
    },
    {
      input: { offline: false, status: 403 },
      tone: "warning",
      copy: "Your current session does not have access to complete this action. Sign in with an authorized account or ask a Shiplet owner.",
    },
    {
      input: { offline: false, status: 428 },
      tone: "warning",
      copy: "Shiplet needs a fresh trusted approval or prerequisite before this action. Review the action details and try again.",
    },
    {
      input: { offline: false, status: 422 },
      tone: "warning",
      copy: "The draft or deployment input did not pass validation. Review the revision details, validate again, and retry.",
    },
    {
      input: { offline: false, status: 503 },
      tone: "error",
      copy: "Shiplet could not reach or verify the target service. Refresh ownership status before starting another revision or deployment action.",
    },
    {
      input: { offline: false, status: 503, effectStarted: true },
      tone: "warning",
      copy: "Outcome unknown. Retry this exact operation to reconcile it; do not start another revision or deployment action until Shiplet confirms the result.",
    },
  ])(
    "Given action failure $input, when recovery is selected, then trusted $tone guidance is returned without server text",
    ({ input, tone, copy }) => {
      expect(OwnershipActionFailureState(input)).toEqual({
        tone,
        message: copy,
        ...(input.effectStarted
          ? { retryExact: true, blockCompeting: true }
          : {}),
      });
    },
  );

  it("Given an action request fails, when the browser controller recovers, then it maps trusted status only and never presents raw response text", () => {
    const controller = BuildOwnershipController({
      shipletId: "shiplet_alpha",
      nonce: "ownership-page-test-nonce-12345" as KernelDocumentNonce,
    });

    expect(controller).toContain("navigator.onLine === false");
    expect(controller).toContain("config.actionFailureCopy");
    expect(controller).toContain("error && Number(error.status)");
    expect(controller).not.toContain("error.message");
    expect(controller).not.toContain("body.message");
  });

  it.each([
    {
      state: "empty" as const,
      needle: "Connect your Cloudflare account",
    },
    {
      state: "denied" as const,
      needle: "Cloudflare access was not granted",
    },
    {
      state: "revoked" as const,
      needle: "Shiplet access is revoked",
    },
    {
      state: "error" as const,
      needle: "Cloudflare status could not be loaded",
    },
  ])(
    "Given the Cloudflare connection is $state, when ownership renders, then the page explains the recoverable state",
    ({ state, needle }) => {
      const page = render({
        cloudflare: {
          state,
          connectAvailable: true,
          targets: [],
        },
      });

      expect(page.body).toContain(needle);
      expect(page.body).toContain(
        "Shiplet-managed publishing remains available",
      );
    },
  );

  it("Given a route-level ownership failure, when the kernel renders it without private deployment state, then the exact recovery state and Shiplet route remain available", () => {
    const page = BuildOwnershipFailurePage({
      shipletId: "shiplet_alpha",
      shipletName: "Launch review",
      viewState: "permission_denied",
    });

    expect(page.title).toBe("Ownership · Launch review · Shiplet");
    expect(page.body).toContain("Ownership access is required");
    expect(page.body).toContain('href="/shiplets/shiplet_alpha"');
    expect(page.body).not.toMatch(
      /Cloudflare account|deployment target|scope/i,
    );
  });

  it("Given no OAuth control plane, when the customer-owned path renders, then it fails honestly without requesting a token", () => {
    const page = render({
      cloudflare: {
        state: "empty",
        connectAvailable: false,
        reason: "cloudflare_oauth_prerequisite",
        targets: [],
      },
    });

    expect(page.body).toContain("Cloudflare connection is not configured");
    expect(page.body).toContain("No API token is needed here");
    expect(page.body).not.toMatch(/paste (?:an? )?(?:api )?token/i);
    expect(page.body).not.toContain('data-shiplet-action="connect-cloudflare"');
  });

  it("Given a connected customer target, when ownership renders, then account ownership, least privilege, and deployment health are visible", () => {
    const page = render({
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        connectionId: "connection_customer",
        accountLabel: "Example Cloudflare account",
        scopes: ["workers.scripts.read", "workers.scripts.write"],
        targets: [
          {
            id: "target_customer",
            label: "Production Worker",
            ownership: "customer",
            status: "healthy",
            activeRevisionId: "rev_active",
            lastDeployedAt: "2026-08-05T15:04:00.000Z",
            healthVerifiedAt: "2026-08-05T15:05:00.000Z",
            drift: "in_sync",
            updatesAvailable: true,
            running: true,
          },
        ],
      },
    });

    expect(page.body).toContain("Runs in your Cloudflare account");
    expect(page.body).toContain("Owned by you");
    expect(page.body).toContain("Example Cloudflare account");
    expect(page.body).toContain(
      "Cloudflare grants account-level access to read and write Workers scripts",
    );
    expect(page.body).toContain("workers.scripts.read");
    expect(page.body).toContain("workers.scripts.write");
    expect(page.body).toContain(
      "Shiplet policy restricts deployment operations to this Shiplet&#39;s target",
    );
    expect(page.body).toContain(
      "No access to zones, DNS, account members, WorkOS identity, or Shiplet state",
    );
    expect(page.body).toContain("script settings, secrets, and cron triggers");
    expect(page.body).not.toContain("Cannot access your other Workers");
    expect(page.body).toContain('data-shiplet-action="revoke-cloudflare"');
    expect(page.body).toContain(
      'data-action-endpoint="/api/cloudflare/connections/connection_customer"',
    );
    expect(page.body).toContain("Revoke Shiplet access");
    expect(page.body).toContain("Production Worker");
    expect(page.body).toContain("Healthy");
    expect(page.body).toContain("Revision 4");
    expect(page.body).toContain("Drift: In sync");
    expect(page.body).toContain("Health checked Aug 5, 2026, 3:05 PM");
  });

  it("Given missing or additional OAuth scopes, when authority renders, then it never labels the grant least-privilege or invents excluded access", () => {
    const missing = render({
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        targets: [],
      },
    });
    const additional = render({
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        scopes: ["workers.scripts.read", "account.members.read"],
        targets: [],
      },
    });

    expect(missing.body).toContain("Granted scope details are unavailable");
    expect(missing.body).not.toContain(
      "No access to zones, DNS, account members",
    );
    expect(additional.body).toContain("Additional scope requires review");
    expect(additional.body).toContain("account.members.read");
    expect(additional.body).not.toContain("Least privilege");
  });

  it("Given a failed customer deployment, when ownership renders, then it says the active revision did not change", () => {
    const page = render({
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        targets: [
          {
            id: "target_failed",
            label: "Production Worker",
            ownership: "customer",
            status: "deployment_failed",
            activeRevisionId: "rev_active",
            updatesAvailable: true,
            running: true,
            failureSummary: "Health check did not pass",
          },
        ],
      },
    });

    expect(page.body).toContain("Deployment failed");
    expect(page.body).toContain("Health check did not pass");
    expect(page.body).toContain(
      "The active revision did not change. The last known-good deployment is still running.",
    );
    expect(page.body).toContain("Redeploy active revision");
    expect(page.body).toContain(
      'data-action-endpoint="/api/revisions/rev_active/deployments"',
    );
  });

  it("Given a failed deployment with no running fallback, when ownership renders, then it never claims a known-good deployment is running", () => {
    const page = render({
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        targets: [
          {
            id: "target_failed_offline",
            label: "Production Worker",
            ownership: "customer",
            status: "deployment_failed",
            activeRevisionId: "rev_active",
            updatesAvailable: true,
            running: false,
          },
        ],
      },
    });

    expect(page.body).toContain(
      "The active revision did not change. Shiplet could not confirm a running known-good deployment.",
    );
    expect(page.body).not.toContain(
      "The last known-good deployment is still running",
    );
  });

  it("Given revoked access and a prior deployment, when ownership renders, then execution remains customer-owned while updates fail closed", () => {
    const page = render({
      cloudflare: {
        state: "revoked",
        connectAvailable: true,
        accountLabel: "Customer account",
        targets: [
          {
            id: "target_revoked",
            label: "Customer Worker",
            ownership: "customer",
            status: "healthy",
            activeRevisionId: "rev_active",
            updatesAvailable: false,
            running: true,
          },
        ],
      },
    });

    expect(page.body).toContain(
      "The last customer-owned deployment keeps running",
    );
    expect(page.body).toContain("Future updates are blocked");
    expect(page.body).toContain("Last known healthy");
    expect(page.body).toContain(
      "Shiplet cannot recheck health after access is revoked",
    );
    expect(page.body).toContain("Customer account");
    expect(page.body).toContain("Reconnect Cloudflare");
  });

  it.each([
    {
      viewState: "offline" as const,
      title: "You appear to be offline",
      copy: "No deployment or revision change was attempted",
    },
    {
      viewState: "permission_denied" as const,
      title: "Ownership access is required",
      copy: "Ask a Shiplet owner for access",
    },
  ])(
    "Given the page is $viewState, when it renders, then it fails closed with one recovery path",
    ({ viewState, title, copy }) => {
      const page = render({ viewState });
      expect(page.body).toContain(title);
      expect(page.body).toContain(copy);
      expect(
        page.body.match(
          /<(?:a|button)[^>]+class="[^"]*ownership-action-primary/g,
        ),
      ).toHaveLength(1);
    },
  );

  it("Given two validated drafts with no explicit selection, when revisions render, then neither is silently chosen for promotion", () => {
    const page = render({
      revisions: {
        drafts: [
          {
            id: "draft_a",
            label: "Draft A",
            parentRevisionId: "rev_active",
            state: "validated",
            version: 2,
            updatedAt: "2026-08-05T16:00:00.000Z",
          },
          {
            id: "draft_b",
            label: "Draft B",
            parentRevisionId: "rev_active",
            state: "validated",
            version: 4,
            updatedAt: "2026-08-05T17:00:00.000Z",
          },
        ],
        history: [],
      },
    });

    expect(page.body).toContain("Choose a draft to promote");
    expect(page.body).toContain("Promote Draft A");
    expect(page.body).toContain("Promote Draft B");
    expect(
      page.body.match(/data-expected-active-revision-id="rev_active"/g),
    ).toHaveLength(2);
    expect(page.body).not.toContain(
      'ownership-action-primary" type="button" data-shiplet-action="promote"',
    );
  });

  it("Given temporary claim and export options, when portability renders, then claim is clearly separate from future OAuth and detached ownership", () => {
    const page = render({
      temporaryClaim: {
        status: "awaiting_claim",
        targetId: "target_claim_alpha",
        expiresAt: "2026-08-06T15:00:00.000Z",
      },
      export: {
        available: true,
        detached: true,
      },
    });

    expect(page.body).toContain("Temporary preview and claim");
    expect(page.body).toContain("Awaiting claim");
    expect(page.body).toContain(
      "Future updates require a separate Cloudflare OAuth connection",
    );
    const ready = render();
    expect(ready.body).toContain(
      'data-cloudflare-policy-acceptance="required"',
    );
    expect(ready.body).toContain("Cloudflare Terms of Service");
    expect(ready.body).toContain("Cloudflare Privacy Policy");
    expect(page.body).toContain(
      'data-action-endpoint="/api/temporary-claims/target_claim_alpha/claim"',
    );
    expect(page.body).not.toContain(
      'href="/api/temporary-claims/target_claim_alpha/claim"',
    );
    expect(page.body).not.toMatch(/https:\/\/[^"< ]+claim/i);
    expect(page.body).toContain("Detached package");
    expect(page.body).toContain("Export package");
    expect(page.body).toContain(
      'href="/api/shiplets/shiplet_alpha/package?disposition=eject"',
    );
    expect(page.body).toContain('data-export-mode="eject"');
    expect(page.body).toContain(
      "Eject opens portable package JSON in the browser. It does not detach a deployment or revoke Shiplet access.",
    );
    expect(page.body).toContain(
      "Exports include package files and lineage, never state, credentials, grants, or audit history.",
    );
  });

  it("Given untrusted server data, when the page renders, then text and route segments cannot inject markup or browser authority", () => {
    const page = render({
      shiplet: {
        id: 'bad/id?<script id="shiplet-injection">',
        name: '<img src=x onerror="globalThis.pwned=true">',
        activeRevision: {
          id: 'rev/active"><script>',
          label: '<svg onload="globalThis.pwned=true">',
          createdAt: "not-a-date<script>",
          validatedAt: null,
        },
      },
      revisions: {
        drafts: [
          {
            id: 'draft/5"><img src=x onerror=alert(1)>',
            label: '<script id="draft-injection">',
            parentRevisionId: "rev_active",
            state: "invalid",
            version: 1,
            updatedAt: "bad",
            summary: '<a href="javascript:alert(1)">bad</a>',
            validationSummary: '<script id="validation-injection">',
          },
        ],
        history: [],
      },
      cloudflare: {
        state: "connected",
        connectAvailable: true,
        accountLabel: '<script id="account-injection">',
        targets: [],
      },
    });

    expect(page.body).not.toMatch(
      /<script id="(?:shiplet|draft|validation|account)-injection">/,
    );
    expect(page.body).not.toMatch(
      /<(?:img|svg)[^>]+\son(?:error|load)=|href="javascript:/,
    );
    expect(page.body).toContain(
      "bad%2Fid%3F%3Cscript%20id%3D%22shiplet-injection%22%3E",
    );
    expect(page.body).toContain(
      "draft%2F5%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    );
    expect(page.body).not.toMatch(
      /bearer|oauth[_-]?token|claimUrl|credentialRef/i,
    );
  });

  it("Given loading and empty states, when the shell renders, then assistive technology receives status and progress semantics", () => {
    const loading = render({ viewState: "loading" });
    const empty = render({
      shiplet: {
        id: "shiplet_new",
        name: "New Shiplet",
        activeRevision: null,
      },
      revisions: { drafts: [], history: [] },
      viewState: "ready",
    });

    expect(loading.body).toContain('aria-busy="true"');
    expect(loading.body).toContain('role="status"');
    expect(loading.body).toContain("Loading ownership and revision status");
    expect(empty.body).toContain("No active revision yet");
    expect(empty.body).toContain("Prepare first revision");
  });

  it("Given exact managed-runtime prerequisites, when degraded states render, then they are not collapsed into generic copy", () => {
    const disabled = render();
    const unavailable = render({
      managed: {
        status: "degraded",
        runtime: "worker",
        arbitraryWorkerExecution: {
          available: false,
          reason: "runtime_unavailable",
        },
      },
    });

    expect(disabled.body).toContain("Managed dynamic execution is not enabled");
    expect(disabled.body).toContain(
      "a customer target with enforceable outbound mediation",
    );
    expect(disabled.body).not.toContain(
      "use a customer-owned Cloudflare target for dynamic packages",
    );
    expect(disabled.body).toContain(
      "<summary>Advanced runtime availability</summary>",
    );
    expect(unavailable.body).toContain(
      "The isolated managed runtime is not configured",
    );
  });

  it("builds exact trusted action requests with approval, concurrency, and idempotency inputs", () => {
    expect(
      BuildOwnershipActionRequest({
        action: "validate",
        shipletId: "shiplet_alpha",
        draftId: "draft_5",
        expectedVersion: 3,
      }),
    ).toEqual({
      method: "POST",
      path: "/api/drafts/draft_5/validate",
      body: { expectedVersion: 3 },
      requiresApproval: false,
    });
    expect(
      BuildOwnershipActionRequest({
        action: "promote",
        shipletId: "shiplet_alpha",
        draftId: "draft_5",
        expectedVersion: 3,
        expectedActiveRevisionId: "rev_active",
        idempotencyKey: "operation_5",
        approved: true,
      }),
    ).toEqual({
      method: "POST",
      path: "/api/drafts/draft_5/promote",
      body: { approval: true, expectedActiveRevisionId: "rev_active" },
      headers: { "idempotency-key": "operation_5" },
      requiresApproval: true,
    });
    expect(
      BuildOwnershipActionRequest({
        action: "temporary_claim",
        shipletId: "shiplet_alpha",
        revisionId: "rev_active",
        idempotencyKey: "claim_operation",
        approved: true,
        acceptedCloudflarePolicies: true,
      }),
    ).toEqual({
      method: "POST",
      path: "/api/revisions/rev_active/temporary-claims",
      body: {
        approval: true,
        cloudflarePolicyAcceptance: {
          termsOfService: "https://www.cloudflare.com/terms/",
          privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
          acceptTermsOfService: "yes",
        },
      },
      headers: { "idempotency-key": "claim_operation" },
      requiresApproval: true,
    });
    expect(() =>
      BuildOwnershipActionRequest({
        action: "promote",
        shipletId: "shiplet_alpha",
        draftId: "draft_5",
        expectedVersion: 3,
        expectedActiveRevisionId: "rev_active",
        idempotencyKey: "operation_5",
      }),
    ).toThrow("trusted_approval_required");
    expect(() =>
      BuildOwnershipActionRequest({
        action: "promote",
        shipletId: "shiplet_alpha",
        draftId: "draft_5",
        expectedVersion: 3,
        approved: true,
      }),
    ).toThrow("expected_active_revision_required");
    expect(() =>
      BuildOwnershipActionRequest({
        action: "unexpected" as "temporary_claim",
        shipletId: "shiplet_alpha",
        revisionId: "rev_active",
        approved: true,
        idempotencyKey: "operation_unknown",
      }),
    ).toThrow("unknown_ownership_action");
    expect(
      BuildOwnershipActionRequest({
        action: "redeploy",
        shipletId: "shiplet_alpha",
        revisionId: "rev_active",
        targetId: "target_failed",
        idempotencyKey: "redeploy_operation",
        approved: true,
      }),
    ).toEqual({
      method: "POST",
      path: "/api/revisions/rev_active/deployments",
      body: { approval: true, targetId: "target_failed" },
      headers: { "idempotency-key": "redeploy_operation" },
      requiresApproval: true,
    });
  });

  it("adapts the deployed status envelope without inventing missing authority or health evidence", () => {
    const model = AdaptOwnershipPageModel({
      shiplet: { id: "shiplet_alpha", name: "Launch review" },
      activeRevision: BASE_MODEL.shiplet.activeRevision,
      drafts: [],
      history: [],
      deploymentStatus: {
        shipletId: "shiplet_alpha",
        managed: {
          default: true,
          owner: "shiplet",
          status: "active",
          runtime: "static",
          arbitraryWorkerExecution: {
            available: false,
            reason: "managed_dynamic_unavailable",
          },
        },
        customerCloudflare: {
          connectAvailable: true,
          reason: null,
          targets: [
            {
              id: "target_customer",
              kind: "customer_cloudflare",
              ownership: "customer",
              providerAccountId: "account_customer",
              connection: { id: "connection_customer", status: "active" },
              detached: false,
              lastDeployment: {
                id: "deployment_customer",
                revisionId: "rev_active",
                scriptName: "customer-worker",
                status: "healthy",
                deployedOn: "2026-08-05T15:04:00.000Z",
                running: true,
                updatesAvailable: true,
              },
            },
          ],
        },
      },
      temporaryClaim: { status: "unavailable" },
      export: { available: true },
    });

    expect(model.cloudflare.state).toBe("connected");
    expect(model.cloudflare.scopes).toBeUndefined();
    expect(model.cloudflare.targets[0]).toMatchObject({
      id: "target_customer",
      label: "customer-worker",
      status: "healthy",
      drift: "unknown",
      healthVerifiedAt: null,
    });
    expect(BuildShipletOwnershipPage(model).body).toContain(
      "Recorded healthy, verification time unavailable",
    );
  });

  it("keeps an active OAuth connection distinct from a detached target and degrades unavailable managed Workers", () => {
    const model = AdaptOwnershipPageModel({
      shiplet: { id: "shiplet_alpha", name: "Launch review" },
      activeRevision: BASE_MODEL.shiplet.activeRevision,
      drafts: [],
      history: [],
      deploymentStatus: {
        shipletId: "shiplet_alpha",
        managed: {
          default: true,
          owner: "shiplet",
          status: "active",
          runtime: "worker",
          arbitraryWorkerExecution: {
            available: false,
            reason: "runtime_unavailable",
          },
        },
        customerCloudflare: {
          connectAvailable: true,
          targets: [
            {
              id: "target_detached",
              kind: "customer_cloudflare",
              ownership: "customer",
              connection: { id: "connection_active", status: "active" },
              detached: true,
              lastDeployment: null,
            },
          ],
        },
      },
      temporaryClaim: { status: "unavailable" },
      export: { available: true },
    });

    expect(model.cloudflare.state).toBe("connected");
    expect(model.cloudflare.targets[0]?.detached).toBe(true);
    expect(model.managed.status).toBe("degraded");
  });

  it("handles runtime-invalid state values without crashing or presenting a false failure state", () => {
    const unsafe = structuredClone(BASE_MODEL) as unknown as Record<
      string,
      unknown
    >;
    (unsafe.revisions as ShipletOwnershipPageModel["revisions"]).drafts = [
      {
        id: "draft_unknown",
        label: "Unknown draft",
        parentRevisionId: "rev_active",
        state: "unknown" as "draft",
        version: 1,
        updatedAt: "2026-08-05T16:00:00.000Z",
      },
    ];
    (unsafe.cloudflare as ShipletOwnershipPageModel["cloudflare"]).targets = [
      {
        id: "target_unknown",
        label: "Unknown target",
        ownership: "customer",
        status: "unknown" as "healthy",
        updatesAvailable: false,
        running: false,
      },
    ];

    expect(() =>
      BuildShipletOwnershipPage(unsafe as unknown as ShipletOwnershipPageModel),
    ).not.toThrow();
    const page = BuildShipletOwnershipPage(
      unsafe as unknown as ShipletOwnershipPageModel,
    );
    expect(page.body).toContain("Unknown draft state");
    expect(page.body).toContain("Unknown deployment state");
    expect(page.body).not.toContain("Deployment failed");
  });

  it("emits one semantic page heading, labelled regions, visible focus, reduced-motion, and mobile touch behavior", () => {
    const page = render();

    expect(page.body.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(page.body).toMatch(/<nav[^>]+aria-label="Shiplet sections"/);
    expect(page.body).toContain('aria-labelledby="ownership-managed-title"');
    expect(page.body).toContain('aria-labelledby="ownership-revisions-title"');
    expect(page.body).toContain('aria-labelledby="ownership-cloudflare-title"');
    expect(page.body).toContain(":focus-visible");
    expect(page.body).toContain("@media (prefers-reduced-motion: reduce)");
    expect(page.body).toContain("@media (max-width: 640px)");
    expect(page.body).toMatch(/min-height:\s*44px/);
    expect(page.body).toContain(".ownership-nav a { min-height: 44px;");
    expect(page.body).not.toMatch(/outline:\s*none/);
    expect(
      page.body.match(
        /<(?:a|button)[^>]+class="[^"]*ownership-action-primary/g,
      ),
    ).toHaveLength(1);
  });
});
