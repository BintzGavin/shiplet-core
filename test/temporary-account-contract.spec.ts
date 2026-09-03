import { describe, expect, it, vi } from "vitest";

import { validateTemporaryProvisioningResponse } from "../src/cloudflare-support/control-plane";
import { createCloudflareTemporaryTransport } from "../src/cloudflare-support/temporary-transport";

const NOW = 1_800_000_000_000;

function provisioningResponse(overrides: {
  accountExpiresAt?: unknown;
  claimExpiresAt?: unknown;
} = {}) {
  const claimToken = crypto.randomUUID();
  return {
    success: true,
    result: {
      account: {
        id: "temporary_account_fixture",
        name: "Temporary fixture",
        apiToken: crypto.randomUUID(),
        expiresAt: Object.hasOwn(overrides, "accountExpiresAt")
          ? overrides.accountExpiresAt
          : new Date(NOW + 60 * 60_000).toISOString(),
      },
      claim: {
        token: claimToken,
        url: `https://dash.cloudflare.com/claim-preview?claimToken=${claimToken}`,
        expiresAt: Object.hasOwn(overrides, "claimExpiresAt")
          ? overrides.claimExpiresAt
          : new Date(NOW + 60 * 60_000).toISOString(),
      },
    },
  };
}

describe("Cloudflare Temporary Accounts current contract", () => {
  it("Given both official expiry fields, When the response is validated, Then each deadline must be present, future, and no more than sixty minutes from receipt", () => {
    expect(validateTemporaryProvisioningResponse(provisioningResponse(), NOW)).toMatchObject({
      public: {
        accountExpiresAt: NOW + 60 * 60_000,
        claimExpiresAt: NOW + 60 * 60_000,
      },
    });

    for (const candidate of [
      provisioningResponse({ accountExpiresAt: undefined }),
      provisioningResponse({ claimExpiresAt: undefined }),
      provisioningResponse({ accountExpiresAt: new Date(NOW).toISOString() }),
      provisioningResponse({ claimExpiresAt: new Date(NOW).toISOString() }),
      provisioningResponse({
        accountExpiresAt: new Date(NOW + 60 * 60_000 + 1).toISOString(),
      }),
      provisioningResponse({
        claimExpiresAt: new Date(NOW + 60 * 60_000 + 1).toISOString(),
      }),
      provisioningResponse({ accountExpiresAt: "not-a-date" }),
      provisioningResponse({ claimExpiresAt: "not-a-date" }),
    ]) {
      expect(() => validateTemporaryProvisioningResponse(candidate, NOW)).toThrow(
        "temporary_provisioning_response_invalid",
      );
    }
  });

  it("Given the official provisioning API has no idempotency field, When a response is lost after POST, Then transport sends no invented retry key and reports an unknown effect", async () => {
    const requests: Request[] = [];
    const send = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const normalized = request instanceof Request ? request : new Request(request, init);
      requests.push(normalized);
      if (normalized.url.endsWith("/challenge")) {
        return Response.json({
          success: true,
          result: {
            challengeToken: "challenge-token-fixture",
            seed: "A".repeat(43),
            k: 1,
            g: 1,
          },
        });
      }
      throw new Error("temporary_provider_response_lost");
    });
    const transport = createCloudflareTemporaryTransport({
      fetch: send,
      now: () => NOW,
    });

    await expect(
      transport.provisionAccount({
        termsOfService: "https://www.cloudflare.com/terms/",
        privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
        acceptTermsOfService: "yes",
      }),
    ).rejects.toThrow("temporary_provisioning_outcome_ambiguous");
    expect(requests).toHaveLength(2);
    const provisioning = requests[1]!;
    expect(provisioning.headers.has("idempotency-key")).toBe(false);
    expect(provisioning.headers.has("x-idempotency-key")).toBe(false);
    expect(Object.keys(await provisioning.clone().json())).toEqual([
      "termsOfService",
      "privacyPolicy",
      "acceptTermsOfService",
      "challengeToken",
      "solution",
    ]);
  });
});
