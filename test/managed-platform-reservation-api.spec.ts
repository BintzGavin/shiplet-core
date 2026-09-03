import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { SUPPORT_ENTRYPOINTS } from "../src/cloudflare-support/service-contract";

/**
 * Managed platform reservation acceptance specification
 *
 * Given a provider connection is already present and the main release is in
 * exact-operator smoke mode, when that human explicitly approves reserving the
 * public connection/account binding, then the kernel delegates one immutable,
 * purpose-scoped reservation to the exact control-plane release. A different
 * user, missing approval, malformed identifiers, or RPC failure must have zero
 * reservation effect.
 */

const OPERATOR = {
  "x-shiplet-user-id": "user_managed_platform_operator",
  "x-shiplet-user-email": "managed-platform-operator@example.com",
};
const CONTROL_VERSION = "11111111-1111-4111-8111-111111111111";
const GATEWAY_VERSION = "22222222-2222-4222-8222-222222222222";
const DENY_VERSION = "33333333-3333-4333-8333-333333333333";
const RELEASE_TAG = "shiplet-managed-platform-reservation-fixture";
const ACTIVE_RESERVATION_OPERATION = `managed_platform_${"p".repeat(43)}`;

function runtime(
  calls: unknown[],
  releaseTag = RELEASE_TAG,
  reservationActive = false,
) {
  const contracts = SUPPORT_ENTRYPOINTS.map((entrypoint) => ({
    schemaVersion: "shiplet.support/v1" as const,
    ...entrypoint,
    versionId:
      entrypoint.service === "shiplet-cloudflare-control-plane"
        ? CONTROL_VERSION
        : GATEWAY_VERSION,
    versionTag: releaseTag,
  }));
  const health = {
    schemaVersion: "shiplet.support-health/v1" as const,
    status: "healthy" as const,
    schemaReady: true,
    credentialContinuity: "verified" as const,
    reconciliation: {
      status: "success" as const,
      fresh: true,
      completedAt: 1_800_000_000_000,
    },
    backlog: {
      cleanupPending: 0,
      revocationPending: 0,
      temporaryAmbiguous: 0,
      temporaryAmbiguityExpired: 0,
      boundedAt: 101,
    },
    release: { versionId: CONTROL_VERSION, versionTag: releaseTag },
  };
  return Object.assign({}, env, {
    CLOUDFLARE_CONTROL_PLANE_VERSION_ID: CONTROL_VERSION,
    CLOUDFLARE_RUNTIME_GATEWAY_VERSION_ID: GATEWAY_VERSION,
    CLOUDFLARE_DENY_EGRESS_VERSION_ID: DENY_VERSION,
    CLOUDFLARE_SUPPORT_RELEASE_TAG: releaseTag,
    CLOUDFLARE_MANAGED_RUNTIME_READINESS: "operator_smoke",
    CLOUDFLARE_MANAGED_RUNTIME_OPERATOR_USER_ID: OPERATOR["x-shiplet-user-id"],
    CLOUDFLARE_MANAGED_RUNTIME_SMOKE_USER_ID: OPERATOR["x-shiplet-user-id"],
    CLOUDFLARE_OAUTH_CONTROL_PLANE: {
      contract: async () => contracts[0],
      health: async () => health,
      inspectPlatformConnection: async (
        input: unknown,
        expectation: unknown,
      ) => {
        calls.push({ kind: "inspect", input, expectation });
        if (!reservationActive)
          throw new Error("managed_platform_reservation_required");
        const inspection = input as {
          connectionId: string;
          accountId: string;
          actor: { id: string };
        };
        return {
          schemaVersion: "shiplet.managed-platform-reservation-proof/v1",
          operationId: ACTIVE_RESERVATION_OPERATION,
          purpose: "managed_wfp_provider",
          connectionId: inspection.connectionId,
          accountId: inspection.accountId,
          ownerUserId: inspection.actor.id,
          status: "active",
          reservedAt: 1_800_000_000_000,
        };
      },
      reservePlatformConnection: async (
        input: unknown,
        expectation: unknown,
      ) => {
        calls.push({ kind: "reserve", input, expectation });
        const reservation = input as {
          operationId: string;
          connectionId: string;
          accountId: string;
          actor: { id: string };
        };
        return {
          schemaVersion: "shiplet.managed-platform-reservation-proof/v1",
          operationId: reservation.operationId,
          purpose: "managed_wfp_provider",
          connectionId: reservation.connectionId,
          accountId: reservation.accountId,
          ownerUserId: reservation.actor.id,
          status: "active",
          reservedAt: 1_800_000_000_000,
        };
      },
      retirePlatformConnection: async (
        input: unknown,
        expectation: unknown,
      ) => {
        calls.push({ kind: "retire", input, expectation });
        const retirement = input as {
          operationId: string;
          reservationOperationId: string;
          connectionId: string;
          accountId: string;
          actor: { id: string };
        };
        return {
          schemaVersion: "shiplet.managed-platform-retirement-proof/v1",
          operationId: retirement.operationId,
          purpose: "managed_wfp_provider",
          reservationOperationId: retirement.reservationOperationId,
          connectionId: retirement.connectionId,
          accountId: retirement.accountId,
          ownerUserId: retirement.actor.id,
          status: "retired",
          retiredAt: 1_800_000_010_000,
        };
      },
    },
    CLOUDFLARE_GRANT_VAULT_RPC: { contract: async () => contracts[1] },
    CLOUDFLARE_TEMPORARY_ACCOUNT_RPC: { contract: async () => contracts[2] },
    CLOUDFLARE_VERSION_HEALTH_RPC: { contract: async () => contracts[3] },
    CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC: { contract: async () => contracts[4] },
    CLOUDFLARE_MANAGED_RUNTIME_RPC: { contract: async () => contracts[5] },
  }) as unknown as Env;
}

async function post(
  runtimeEnv: Env,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request("http://localhost/api/platform/managed-runtime/reservation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    runtimeEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function postRetirement(
  runtimeEnv: Env,
  headers: Record<string, string>,
  body: Record<string, unknown>,
) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(
      "http://localhost/api/platform/managed-runtime/reservation/retire",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          ...headers,
        },
        body: JSON.stringify(body),
      },
    ),
    runtimeEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function get(
  runtimeEnv: Env,
  headers: Record<string, string>,
  reservedQuery = false,
  confirmRetirement = false,
) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(
      `http://localhost/settings/managed-runtime/reservation?connectionId=connection_managed_platform&accountId=account_managed_platform${reservedQuery ? "&reserved=yes" : ""}${confirmRetirement ? "&confirmRetirement=yes" : ""}`,
      { headers },
    ),
    runtimeEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("managed platform reservation API", () => {
  it("renders one trusted, keyboard-operable operator confirmation surface", async () => {
    const page = await get(runtime([]), OPERATOR);
    expect(page.status, await page.clone().text()).toBe(200);
    const html = await page.text();
    expect(html).toContain("Reserve managed runtime connection");
    expect(html).toContain(
      'action="/api/platform/managed-runtime/reservation"',
    );
    expect(html).toContain('name="approval" value="true"');
    expect(html).toContain("connection_managed_platform");
    expect(html).toContain("account_managed_platform");
    expect(html).toContain(
      "Customer deployment revoke controls will no longer affect it",
    );

    const denied = await get(runtime([]), {
      "x-shiplet-user-id": "user_not_platform_operator",
      "x-shiplet-user-email": "not-platform-operator@example.com",
    });
    expect(denied.status).toBe(403);
  });

  it("does not treat a forged reserved query parameter as provider-backed reservation proof", async () => {
    for (const confirmRetirement of [false, true]) {
      const page = await get(runtime([]), OPERATOR, true, confirmRetirement);
      expect(page.status, await page.clone().text()).toBe(200);
      const html = await page.text();
      expect(html).toContain("Reserve managed runtime connection");
      expect(html).not.toContain("Platform connection reserved");
      expect(html).not.toContain("Review retirement");
      expect(html).not.toContain("Confirm retirement");
      expect(html).not.toContain(
        'action="/api/platform/managed-runtime/reservation/retire"',
      );
    }
  });

  it("requires a separate review step after exact release-fenced reservation attestation before rendering retirement", async () => {
    const calls: unknown[] = [];
    const page = await get(runtime(calls, RELEASE_TAG, true), OPERATOR, true);
    expect(page.status, await page.clone().text()).toBe(200);
    const html = await page.text();
    expect(html).toContain("Platform connection reserved");
    expect(html).toContain("Review retirement");
    expect(html).toContain("confirmRetirement=yes");
    expect(html).not.toContain(
      'action="/api/platform/managed-runtime/reservation/retire"',
    );

    const reviewPage = await get(
      runtime(calls, RELEASE_TAG, true),
      OPERATOR,
      true,
      true,
    );
    expect(reviewPage.status, await reviewPage.clone().text()).toBe(200);
    const reviewHtml = await reviewPage.text();
    expect(reviewHtml).toContain("Confirm platform connection retirement");
    expect(reviewHtml).toContain(
      "Managed Shiplet Workers fail closed until a new reservation is approved",
    );
    expect(reviewHtml).toContain("connection_managed_platform");
    expect(reviewHtml).toContain("account_managed_platform");
    expect(reviewHtml).toContain(
      'action="/api/platform/managed-runtime/reservation/retire"',
    );
    expect(reviewHtml).toContain("Confirm retirement");
    expect(reviewHtml).toContain(
      `name="reservationOperationId" value="${ACTIVE_RESERVATION_OPERATION}"`,
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        kind: "inspect",
        input: {
          schemaVersion: "shiplet.managed-platform-inspection/v1",
          purpose: "managed_wfp_provider",
          actor: { kind: "human", id: OPERATOR["x-shiplet-user-id"] },
          connectionId: "connection_managed_platform",
          accountId: "account_managed_platform",
        },
        expectation: { versionId: CONTROL_VERSION, versionTag: RELEASE_TAG },
      }),
    );
  });

  it("reserves one exact public connection binding only after operator approval", async () => {
    const calls: unknown[] = [];
    const response = await post(runtime(calls), OPERATOR, {
      approval: true,
      connectionId: "connection_managed_platform",
      accountId: "account_managed_platform",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      reservation: {
        schemaVersion: "shiplet.managed-platform-reservation-proof/v1",
        purpose: "managed_wfp_provider",
        connectionId: "connection_managed_platform",
        accountId: "account_managed_platform",
        ownerUserId: OPERATOR["x-shiplet-user-id"],
        status: "active",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "reserve",
      input: {
        schemaVersion: "shiplet.managed-platform-reservation/v1",
        operationId: expect.stringMatching(
          /^managed_platform_[A-Za-z0-9_-]{43}$/,
        ),
        purpose: "managed_wfp_provider",
        actor: { kind: "human", id: OPERATOR["x-shiplet-user-id"] },
        connectionId: "connection_managed_platform",
        accountId: "account_managed_platform",
      },
      expectation: { versionId: CONTROL_VERSION, versionTag: RELEASE_TAG },
    });
  });

  it("keeps the reservation identity stable when support releases are upgraded", async () => {
    const initialCalls: unknown[] = [];
    const upgradedCalls: unknown[] = [];
    expect(
      (
        await post(
          runtime(initialCalls, "shiplet-support-release-one"),
          OPERATOR,
          {
            approval: true,
            connectionId: "connection_managed_platform",
            accountId: "account_managed_platform",
          },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await post(
          runtime(upgradedCalls, "shiplet-support-release-two"),
          OPERATOR,
          {
            approval: true,
            connectionId: "connection_managed_platform",
            accountId: "account_managed_platform",
          },
        )
      ).status,
    ).toBe(201);
    expect((upgradedCalls[0] as any).input.operationId).toBe(
      (initialCalls[0] as any).input.operationId,
    );
    expect((upgradedCalls[0] as any).expectation.versionTag).not.toBe(
      (initialCalls[0] as any).expectation.versionTag,
    );
  });

  it("retires the exact reservation through a separate destructive confirmation and keeps provider credentials out of the response", async () => {
    const calls: unknown[] = [];
    const reservationOperationId = `managed_platform_${"r".repeat(43)}`;
    const response = await postRetirement(runtime(calls), OPERATOR, {
      approval: true,
      reservationOperationId,
      connectionId: "connection_managed_platform",
      accountId: "account_managed_platform",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      retirement: {
        schemaVersion: "shiplet.managed-platform-retirement-proof/v1",
        reservationOperationId,
        connectionId: "connection_managed_platform",
        accountId: "account_managed_platform",
        ownerUserId: OPERATOR["x-shiplet-user-id"],
        status: "retired",
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /authorization|bearer|secret|token|credentialRef/i,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "retire",
      input: {
        schemaVersion: "shiplet.managed-platform-retirement/v1",
        operationId: expect.stringMatching(
          /^managed_platform_retire_[A-Za-z0-9_-]{43}$/,
        ),
        purpose: "managed_wfp_provider",
        actor: { kind: "human", id: OPERATOR["x-shiplet-user-id"] },
        reservationOperationId,
      },
      expectation: { versionId: CONTROL_VERSION, versionTag: RELEASE_TAG },
    });
  });

  it("denies retirement without exact approval or lifecycle-operator identity before RPC", async () => {
    const calls: unknown[] = [];
    const body = {
      approval: true,
      reservationOperationId: `managed_platform_${"r".repeat(43)}`,
      connectionId: "connection_managed_platform",
      accountId: "account_managed_platform",
    };
    expect(
      (
        await postRetirement(runtime(calls), OPERATOR, {
          ...body,
          approval: false,
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await postRetirement(
          runtime(calls),
          {
            "x-shiplet-user-id": "user_not_platform_operator",
            "x-shiplet-user-email": "not-platform-operator@example.com",
          },
          body,
        )
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("denies missing approval and every user except the configured operator before RPC", async () => {
    const calls: unknown[] = [];
    const missingApproval = await post(runtime(calls), OPERATOR, {
      connectionId: "connection_managed_platform",
      accountId: "account_managed_platform",
    });
    expect(missingApproval.status).toBe(428);
    const wrongUser = await post(
      runtime(calls),
      {
        "x-shiplet-user-id": "user_not_platform_operator",
        "x-shiplet-user-email": "not-platform-operator@example.com",
      },
      {
        approval: true,
        connectionId: "connection_managed_platform",
        accountId: "account_managed_platform",
      },
    );
    expect(wrongUser.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
