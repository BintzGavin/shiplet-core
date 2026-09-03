import { describe, expect, it, vi } from "vitest";

import {
  authorizeCloudflareGrantConnection,
  createCloudflareCredentialCipher,
  openTemporaryClaimBeforeConsume,
  solveCloudflarePreviewChallenge,
  validateCloudflareGrantRequest,
  validateTemporaryProvisioningResponse,
} from "../src/cloudflare-support/control-plane";
import { createCloudflareOAuthRedactingFetch } from "../src/cloudflare-support/oauth-transport";
import { createCloudflareGrantTransport } from "../src/cloudflare-support/provider-transport";
import { createCloudflareTemporaryTransport } from "../src/cloudflare-support/temporary-transport";
import { executeTemporaryProviderEffect } from "../src/cloudflare-support/temporary-effect-fence";
import { createCustomMcpDynamicWorkerInvocation } from "../src/cloudflare-support/custom-mcp-runtime";
// @ts-expect-error Vite's raw loader supplies the support module source text.
import customMcpRuntimeSource from "../src/cloudflare-support/custom-mcp-runtime.ts?raw";
import {
  createManagedDispatchInvocation,
  handleManagedOutboundRequest,
} from "../src/cloudflare-support/managed-runtime";
// @ts-expect-error Vite's raw loader supplies the main Worker config text.
import mainWorkerConfig from "../wrangler.jsonc?raw";
// @ts-expect-error Vite's raw loader supplies the support Worker config text.
import controlPlaneConfig from "../workers/cloudflare-control-plane/wrangler.jsonc?raw";
// @ts-expect-error Vite's raw loader supplies the support Worker source text.
import controlPlaneSource from "../workers/cloudflare-control-plane/index.ts?raw";
// @ts-expect-error Vite's raw loader supplies the additive migration text.
import supportReleaseMigration from "../workers/cloudflare-control-plane/migrations/0002_oauth_support_release.sql?raw";
// @ts-expect-error Vite's raw loader supplies the additive migration text.
import temporaryRecoveryMigration from "../workers/cloudflare-control-plane/migrations/0003_temporary_recovery.sql?raw";
// @ts-expect-error Vite's raw loader supplies the additive migration text.
import oauthFinalizationDeliveryMigration from "../workers/cloudflare-control-plane/migrations/0004_oauth_finalization_delivery.sql?raw";
// @ts-expect-error Vite's raw loader supplies the support Worker config text.
import denyEgressConfig from "../workers/deny-egress/wrangler.jsonc?raw";
// @ts-expect-error Vite's raw loader supplies the support Worker config text.
import managedRuntimeConfig from "../workers/managed-runtime-gateway/wrangler.jsonc?raw";
// @ts-expect-error Vite's raw loader supplies the support Worker source text.
import managedRuntimeSource from "../workers/managed-runtime-gateway/index.ts?raw";
// @ts-expect-error Vite's raw loader supplies the support module source text.
import managedRuntimeCoordinatorSource from "../workers/managed-runtime-gateway/coordinator.ts?raw";
// @ts-expect-error Vite's raw loader supplies the support Worker source text.
import denyEgressSource from "../workers/deny-egress/index.ts?raw";

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

describe("external Cloudflare support services", () => {
  it("Given an invalid near-expiry operation grant, When authority is resolved, Then refresh cannot run before full binding validation", async () => {
    const now = Date.now();
    const connection = {
      id: "connection_fixture",
      userId: "user_fixture",
      accountId: "0123456789abcdef0123456789abcdef",
      status: "active" as const,
      scopes: ["workers.scripts.read", "workers.scripts.write"],
      expiresAt: now + 30_000,
      generation: 1,
    };
    const grant = {
      handle: `control-plane:${connection.id}`,
      userId: connection.userId,
      shipletId: "shiplet_fixture",
      accountId: connection.accountId,
      targetId: "target_fixture",
      scriptName: "shiplet-fixture",
      revisionId: "revision_fixture",
      packageDigest: `sha256:${"a".repeat(64)}`,
      operation: "worker.version.upload",
      requestDigest: `sha256:${"b".repeat(64)}`,
      requiredScopes: ["workers.scripts.write"],
      expiresAt: now + 20_000,
    };
    const refresh = vi.fn(async () => true);

    await expect(
      authorizeCloudflareGrantConnection({
        grant: { ...grant, revisionId: "revision_attacker" },
        expected: grant,
        now,
        load: async () => connection,
        refresh,
      }),
    ).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();

    const refreshed = { ...connection, expiresAt: now + 120_000, generation: 2 };
    let loaded = connection;
    await expect(
      authorizeCloudflareGrantConnection({
        grant,
        expected: grant,
        now,
        load: async () => loaded,
        refresh: async () => {
          loaded = refreshed;
          return true;
        },
      }),
    ).resolves.toEqual(refreshed);
  });

  it("Given malformed input or an unavailable audit, When a temporary provider effect is requested, Then one-time authority and provider effects are ordered fail-closed", async () => {
    const observed: string[] = [];
    const run = (validationError?: Error, auditError?: Error) =>
      executeTemporaryProviderEffect({
        validate: () => {
          observed.push("validate");
          if (validationError) throw validationError;
        },
        consume: () => {
          observed.push("consume");
        },
        audit: () => {
          observed.push("audit");
          if (auditError) throw auditError;
        },
        effect: () => {
          observed.push("effect");
          return "complete";
        },
      });

    await expect(run(new Error("invalid"))).rejects.toThrow("invalid");
    expect(observed).toEqual(["validate"]);

    observed.length = 0;
    await expect(run(undefined, new Error("audit unavailable"))).rejects.toThrow(
      "audit unavailable",
    );
    expect(observed).toEqual(["validate", "consume", "audit"]);

    observed.length = 0;
    await expect(run()).resolves.toBe("complete");
    expect(observed).toEqual(["validate", "consume", "audit", "effect"]);
  });

  it("Given credential material, When sealed, Then only matching record AAD can open it", async () => {
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    const cipher = createCloudflareCredentialCipher(base64Url(key));
    const material = {
      opaqueA: crypto.randomUUID(),
      opaqueB: crypto.randomUUID(),
    };

    const sealed = await cipher.seal({
      recordId: "connection_a",
      purpose: "oauth_credential",
      material,
    });

    expect(JSON.stringify(sealed)).not.toContain(material.opaqueA);
    expect(JSON.stringify(sealed)).not.toContain(material.opaqueB);
    await expect(
      cipher.open({
        recordId: "connection_a",
        purpose: "oauth_credential",
        sealed,
      }),
    ).resolves.toEqual(material);
    await expect(
      cipher.open({
        recordId: "connection_b",
        purpose: "oauth_credential",
        sealed,
      }),
    ).rejects.toThrow("credential_ciphertext_invalid");
  });

  it("Given a deployment grant, When any authority dimension drifts, Then validation fails closed", () => {
    const now = 1_000;
    const grant = {
      handle: "control-plane:connection_a",
      userId: "user_a",
      shipletId: "shiplet_a",
      accountId: "account_a",
      targetId: "target_a",
      scriptName: "shiplet-a",
      revisionId: "revision_a",
      packageDigest: `sha256:${"a".repeat(64)}`,
      operation: "worker.inspect",
      requestDigest: `sha256:${"b".repeat(64)}`,
      requiredScopes: ["workers.scripts.read"],
      expiresAt: now + 30_000,
    } as const;
    const connection = {
      id: "connection_a",
      userId: "user_a",
      accountId: "account_a",
      status: "active",
      scopes: ["workers.scripts.read", "workers.scripts.write"],
      expiresAt: now + 60_000,
      generation: 3,
    } as const;

    expect(
      validateCloudflareGrantRequest({
        grant,
        connection,
        expected: grant,
        now,
      }),
    ).toEqual({ ok: true, connectionId: "connection_a", generation: 3 });
    for (const mutation of [
      { ...grant, userId: "user_b" },
      { ...grant, shipletId: "shiplet_b" },
      { ...grant, accountId: "account_b" },
      { ...grant, revisionId: "revision_b" },
      { ...grant, requestDigest: `sha256:${"c".repeat(64)}` },
      { ...grant, requiredScopes: ["workers.scripts.write"] },
      { ...grant, expiresAt: now },
    ]) {
      expect(
        validateCloudflareGrantRequest({
          grant: mutation,
          connection,
          expected: grant,
          now,
        }),
      ).toEqual({ ok: false, reason: expect.any(String) });
    }
  });

  it("Given an OAuth exchange, When transported, Then credential material is substituted only behind the redacting boundary", async () => {
    const opaqueAccess = crypto.randomUUID();
    const opaqueRefresh = crypto.randomUUID();
    const calls: Array<{ url: string; hasAuthority: boolean }> = [];
    const transport = createCloudflareOAuthRedactingFetch({
      now: () => 1_000,
      fetch: async (request) => {
        const normalized =
          request instanceof Request ? request : new Request(request);
        const url = new URL(normalized.url);
        calls.push({
          url: url.toString(),
          hasAuthority: normalized.headers.has("authorization"),
        });
        if (url.pathname === "/oauth2/token") {
          return Response.json({
            access_token: opaqueAccess,
            refresh_token: opaqueRefresh,
            expires_in: 3_600,
            scope: "workers.scripts.read workers.scripts.write offline_access",
          });
        }
        return Response.json({
          success: true,
          result: [
            {
              id: "0123456789abcdef0123456789abcdef",
              name: "Fixture account",
            },
          ],
        });
      },
    });
    const response = await transport.exchange({
      endpoint: "https://dash.cloudflare.com/oauth2/token",
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      grantType: "authorization_code",
      clientId: "client_fixture",
      form: new URLSearchParams({
        client_id: "client_fixture",
        code: crypto.randomUUID(),
        code_verifier: crypto.randomUUID().repeat(2),
        grant_type: "authorization_code",
        redirect_uri: "https://control.example/oauth/callback",
      }).toString(),
      redactedFields: ["code", "code_verifier"],
    });

    expect(calls).toEqual([
      {
        url: "https://dash.cloudflare.com/oauth2/token",
        hasAuthority: false,
      },
      {
        url: "https://api.cloudflare.com/client/v4/accounts?per_page=5",
        hasAuthority: true,
      },
    ]);
    expect(response.accounts).toEqual([
      {
        id: "0123456789abcdef0123456789abcdef",
        label: "Fixture account",
      },
    ]);
    expect(response.scopes).toEqual([
      "offline_access",
      "workers.scripts.read",
      "workers.scripts.write",
    ]);
    expect(Reflect.ownKeys(response.material).sort()).toEqual([
      "accessToken",
      "refreshToken",
    ]);
    expect(JSON.stringify({ ...response, material: undefined })).not.toContain(
      opaqueAccess,
    );
  });

  it("Given a bounded preview challenge, When solved, Then checkpoints follow the documented chain", async () => {
    const seed = new Uint8Array(32);
    seed[0] = 7;
    const solved = await solveCloudflarePreviewChallenge({
      challengeToken: "challenge_fixture",
      seed: base64Url(seed),
      k: 2,
      g: 3,
      maximumWork: 12,
    });
    const bytes = Uint8Array.from(atob(solved.solution.checkpoints), (value) =>
      value.charCodeAt(0),
    );
    expect(bytes.byteLength).toBe(96);
    expect(solved.challengeToken).toBe("challenge_fixture");
    await expect(
      solveCloudflarePreviewChallenge({
        challengeToken: "challenge_fixture",
        seed: base64Url(seed),
        k: 4,
        g: 4,
        maximumWork: 12,
      }),
    ).rejects.toThrow("temporary_challenge_limit_exceeded");
  });

  it("Given a transient claim-vault failure, When redemption is attempted, Then the one-time redirect remains unconsumed", async () => {
    const consume = vi.fn(async () => true);
    await expect(
      openTemporaryClaimBeforeConsume({
        open: async () => {
          throw new Error("credential_ciphertext_invalid");
        },
        consume,
      }),
    ).rejects.toThrow("credential_ciphertext_invalid");
    expect(consume).not.toHaveBeenCalled();

    const location = "https://dash.cloudflare.com/claim-preview";
    await expect(
      openTemporaryClaimBeforeConsume({
        open: async () => location,
        consume,
      }),
    ).resolves.toBe(location);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("Given accepted policies and static assets, When a temporary account is provisioned, Then credentials stay inside the support transport", async () => {
    const now = 1_000;
    const opaqueApiCredential = crypto.randomUUID();
    const opaqueClaim = crypto.randomUUID();
    const uploadCredential = crypto.randomUUID();
    const completionCredential = crypto.randomUUID();
    let uploadedHash = "";
    const seed = new Uint8Array(32);
    seed[0] = 9;
    const calls: Array<{
      path: string;
      method: string;
      hasAuthority: boolean;
    }> = [];
    const transport = createCloudflareTemporaryTransport({
      now: () => now,
      fetch: async (request) => {
        const normalized =
          request instanceof Request ? request : new Request(request);
        const url = new URL(normalized.url);
        calls.push({
          path: `${url.pathname}${url.search}`,
          method: normalized.method,
          hasAuthority: normalized.headers.has("authorization"),
        });
        if (url.pathname.endsWith("/challenge")) {
          return Response.json({
            success: true,
            result: {
              challengeToken: "challenge_fixture",
              seed: base64Url(seed),
              k: 1,
              g: 1,
            },
          });
        }
        if (url.pathname.endsWith("/provisioning/previews")) {
          return Response.json({
            success: true,
            result: {
              account: {
                id: "0123456789abcdef0123456789abcdef",
                name: "Fixture account",
                apiToken: opaqueApiCredential,
                expiresAt: new Date(now + 3_600_000).toISOString(),
              },
              claim: {
                token: opaqueClaim,
                url: `https://dash.cloudflare.com/claim-preview?claimToken=${opaqueClaim}`,
                expiresAt: new Date(now + 3_000_000).toISOString(),
              },
            },
          });
        }
        if (url.pathname.endsWith("/assets-upload-session")) {
          const body = (await normalized.clone().json()) as {
            manifest: Record<string, { hash: string }>;
          };
          uploadedHash = body.manifest["/index.html"]?.hash ?? "";
          return Response.json({
            success: true,
            result: { buckets: [[uploadedHash]], jwt: uploadCredential },
          });
        }
        if (url.pathname.endsWith("/workers/assets/upload")) {
          return Response.json({
            success: true,
            result: { jwt: completionCredential },
          });
        }
        if (url.pathname.endsWith("/settings")) {
          return Response.json({
            success: true,
            result: {
              annotations: { "workers/tag": `sha256:${"a".repeat(64)}` },
            },
          });
        }
        if (url.pathname.endsWith("/deployments")) {
          return Response.json({
            success: true,
            result: {
              deployments: [
                {
                  id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (url.pathname.endsWith("/workers/subdomain")) {
          return Response.json({
            success: true,
            result: { subdomain: "fixture-account" },
          });
        }
        return Response.json({ success: true, result: {} });
      },
    });
    const provisioned = await transport.provisionAccount({
      termsOfService: "https://www.cloudflare.com/terms/",
      privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
      acceptTermsOfService: "yes",
    });
    expect(calls).toHaveLength(2);
    const deployed = await transport.deployStaticToProvisionedAccount({
      accountId: provisioned.public.accountId,
      apiToken: provisioned.sensitive.apiToken,
      scriptName: "shiplet-preview",
      compatibilityDate: "2026-08-07",
      packageDigest: `sha256:${"a".repeat(64)}`,
      staticAssets: [
        {
          path: "/index.html",
          mediaType: "text/html",
          content: "<!doctype html><title>Preview</title>",
          encoding: "utf8",
        },
      ],
    });
    const result = {
      public: {
        ...provisioned.public,
        workersDevUrl: deployed.workersDevUrl,
        serializedBodyBytes:
          provisioned.serializedBodyBytes + deployed.serializedBodyBytes,
      },
      sensitive: provisioned.sensitive,
    };

    expect(result.public).toMatchObject({
      accountId: "0123456789abcdef0123456789abcdef",
      accountLabel: "Fixture account",
      workersDevUrl: "https://shiplet-preview.fixture-account.workers.dev/",
    });
    expect(JSON.stringify(result.public)).not.toContain(opaqueApiCredential);
    expect(JSON.stringify(result.public)).not.toContain(opaqueClaim);
    expect(result.sensitive).toEqual({
      apiToken: opaqueApiCredential,
      claimUrl: `https://dash.cloudflare.com/claim-preview?claimToken=${opaqueClaim}`,
    });
    expect(calls.map((call) => call.hasAuthority)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("Given Cloudflare confirms deletion with an empty 2xx response, When cleanup runs, Then the exact script is treated as deleted", async () => {
    const calls: Request[] = [];
    const transport = createCloudflareTemporaryTransport({
      now: () => 1_000,
      fetch: async (request) => {
        calls.push(request instanceof Request ? request : new Request(request));
        return new Response(null, { status: 204 });
      },
    });

    await expect(
      transport.deleteScript({
        accountId: "0123456789abcdef0123456789abcdef",
        apiToken: crypto.randomUUID(),
        scriptName: "shiplet-preview",
      }),
    ).resolves.toEqual({ success: true, serializedBodyBytes: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
  });

  it("Given an ambiguous upload response, When inspected, Then only the exact tagged 100-percent deployment is recovered", async () => {
    const packageDigest = `sha256:${"a".repeat(64)}`;
    const calls: string[] = [];
    const transport = createCloudflareTemporaryTransport({
      now: () => 1_000,
      fetch: async (request) => {
        const normalized =
          request instanceof Request ? request : new Request(request);
        const url = new URL(normalized.url);
        calls.push(url.pathname);
        if (url.pathname.endsWith("/settings")) {
          return Response.json({
            success: true,
            result: { annotations: { "workers/tag": packageDigest } },
          });
        }
        if (url.pathname.endsWith("/deployments")) {
          return Response.json({
            success: true,
            result: {
              deployments: [
                {
                  id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
                  strategy: "percentage",
                  versions: [
                    {
                      percentage: 100,
                      version_id: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
                    },
                  ],
                },
              ],
            },
          });
        }
        return Response.json({
          success: true,
          result: { subdomain: "fixture-account" },
        });
      },
    });

    await expect(
      transport.inspectStaticDeployment({
        accountId: "0123456789abcdef0123456789abcdef",
        apiToken: crypto.randomUUID(),
        scriptName: "shiplet-preview",
        packageDigest,
      }),
    ).resolves.toEqual({
      ok: true,
      deployment: {
        providerDeploymentId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
        providerVersionId: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
        workersDevUrl: "https://shiplet-preview.fixture-account.workers.dev/",
        serializedBodyBytes: expect.any(Number),
      },
    });
    expect(calls).toEqual([
      "/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/shiplet-preview/settings",
      "/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/shiplet-preview/deployments",
      "/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/subdomain",
    ]);
  });

  it.each([
    {
      name: "a mismatched package tag",
      settingsTag: `sha256:${"b".repeat(64)}`,
      versions: [
        {
          percentage: 100,
          version_id: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
        },
      ],
      expectedCalls: 1,
    },
    {
      name: "split traffic",
      settingsTag: `sha256:${"a".repeat(64)}`,
      versions: [
        {
          percentage: 50,
          version_id: "282bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
        },
        {
          percentage: 50,
          version_id: "382bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
        },
      ],
      expectedCalls: 2,
    },
  ])("rejects $name while recovering an ambiguous upload", async (fixture) => {
    const calls: Request[] = [];
    const transport = createCloudflareTemporaryTransport({
      now: () => 1_000,
      fetch: async (request) => {
        const normalized =
          request instanceof Request ? request : new Request(request);
        calls.push(normalized);
        const url = new URL(normalized.url);
        if (url.pathname.endsWith("/settings")) {
          return Response.json({
            success: true,
            result: { annotations: { "workers/tag": fixture.settingsTag } },
          });
        }
        if (url.pathname.endsWith("/deployments")) {
          return Response.json({
            success: true,
            result: {
              deployments: [
                {
                  id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
                  strategy: "percentage",
                  versions: fixture.versions,
                },
              ],
            },
          });
        }
        return Response.json({
          success: true,
          result: { subdomain: "fixture-account" },
        });
      },
    });

    await expect(
      transport.inspectStaticDeployment({
        accountId: "0123456789abcdef0123456789abcdef",
        apiToken: crypto.randomUUID(),
        scriptName: "shiplet-preview",
        packageDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "temporary_deployment_unproven",
    });
    expect(calls).toHaveLength(fixture.expectedCalls);
  });

  it("Given DELETE returns 404, When exact GET also returns 404, Then cleanup accepts only that confirmed absence", async () => {
    const calls: Request[] = [];
    const transport = createCloudflareTemporaryTransport({
      now: () => 1_000,
      fetch: async (request) => {
        const normalized =
          request instanceof Request ? request : new Request(request);
        calls.push(normalized);
        return new Response(null, { status: 404 });
      },
    });

    await expect(
      transport.deleteScript({
        accountId: "0123456789abcdef0123456789abcdef",
        apiToken: crypto.randomUUID(),
        scriptName: "shiplet-preview",
      }),
    ).resolves.toEqual({ success: true, serializedBodyBytes: 0 });
    expect(calls.map((request) => request.method)).toEqual(["DELETE", "GET"]);
    expect(calls[1]?.url).toBe(calls[0]?.url);
  });

  it.each([200, 500])(
    "Given DELETE returns 404 and exact GET returns %i, Then cleanup remains pending",
    async (inspectionStatus) => {
      const calls: Request[] = [];
      const transport = createCloudflareTemporaryTransport({
        now: () => 1_000,
        fetch: async (request) => {
          const normalized =
            request instanceof Request ? request : new Request(request);
          calls.push(normalized);
          return calls.length === 1
            ? new Response(null, { status: 404 })
            : Response.json(
                inspectionStatus === 200
                  ? { success: true, result: {} }
                  : { success: false, errors: [] },
                { status: inspectionStatus },
              );
        },
      });

      await expect(
        transport.deleteScript({
          accountId: "0123456789abcdef0123456789abcdef",
          apiToken: crypto.randomUUID(),
          scriptName: "shiplet-preview",
        }),
      ).rejects.toThrow("temporary_cleanup_failed");
      expect(calls.map((request) => request.method)).toEqual([
        "DELETE",
        "GET",
      ]);
    },
  );

  it("Given verified handler bytes, When a custom MCP Dynamic Worker is loaded, Then it receives only scoped callback authority and enforced limits", async () => {
    const handlerBytes = new TextEncoder().encode(
      "export default async ({ input }) => ({ content: [{ type: 'text', text: input.value }] });",
    );
    const handlerDigest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", handlerBytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const handlerSetDigest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([["mcp/handlers/read.js", handlerDigest]]),
          ),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const binding = {
      shipletId: "shiplet_a",
      revisionId: "revision_a",
      packageDigest: `sha256:${"a".repeat(64)}`,
      activationGeneration: 3,
      handlerSetDigest: `sha256:${handlerSetDigest}`,
      handlers: [
        {
          path: "mcp/handlers/read.js",
          digest: handlerDigest,
          bytes: handlerBytes,
        },
      ],
      policy: {
        schemaVersion: "shiplet.runtime-isolation-policy/v1" as const,
        hardTermination: "enforced" as const,
        maxCpuMs: 1_000,
        maxMemoryBytes: 128 * 1024 * 1024,
        maxSubrequests: 4,
        outboundNetwork: "deny_by_default" as const,
        ambientBindings: "none" as const,
        ambientSecrets: "none" as const,
      },
    };
    const loadedCodes: Record<string, unknown>[] = [];
    const invokedRequests: Request[] = [];
    let releaseFirstCapability!: () => void;
    let markFirstCapabilityEntered!: () => void;
    const firstCapabilityEntered = new Promise<void>((resolve) => {
      markFirstCapabilityEntered = resolve;
    });
    const firstCapabilityReleased = new Promise<void>((resolve) => {
      releaseFirstCapability = resolve;
    });
    const capability = Object.freeze({
      request: async () => {
        markFirstCapabilityEntered();
        await firstCapabilityReleased;
        return new Uint8Array([1]);
      },
    });
    const loader = {
      load(code: Record<string, unknown>) {
        loadedCodes.push(code);
        return {
          getEntrypoint(_name?: string, options?: unknown) {
            expect(options).toEqual({
              limits: { cpuMs: 1_000, subRequests: 4 },
            });
            return {
              async fetch(request: Request) {
                invokedRequests.push(request);
                const dynamicCapability = (
                  code.env as {
                    SHIPLET_CAPABILITY: { request(bytes: Uint8Array): Promise<Uint8Array> };
                  }
                ).SHIPLET_CAPABILITY;
                return new Response(
                  Uint8Array.from(
                    await dynamicCapability.request(new Uint8Array([9])),
                  ).buffer,
                );
              },
            };
          },
        };
      },
    };
    const invocation = createCustomMcpDynamicWorkerInvocation({
      loader,
      capability,
      binding,
      invocationId: "invocation_a",
      requestBytes: new TextEncoder().encode("{}"),
    });
    const nextCapability = Object.freeze({
      request: async () => new Uint8Array([2]),
    });
    const nextInvocation = createCustomMcpDynamicWorkerInvocation({
      loader,
      capability: nextCapability,
      binding,
      invocationId: "invocation_next_actor",
      requestBytes: new TextEncoder().encode("{}"),
    });
    const firstResult = invocation.run();
    await firstCapabilityEntered;
    await expect(nextInvocation.run()).resolves.toEqual(new Uint8Array([2]));
    releaseFirstCapability();
    await expect(firstResult).resolves.toEqual(new Uint8Array([1]));

    const loadedCode = loadedCodes.find(
      (candidate) =>
        (candidate.env as Record<string, unknown>).SHIPLET_CAPABILITY === capability,
    );
    expect(loadedCode).toMatchObject({
      compatibilityDate: "2026-08-07",
      compatibilityFlags: ["enable_request_signal"],
      mainModule: "__shiplet_custom_mcp.mjs",
      limits: { cpuMs: 1_000, subRequests: 4 },
      globalOutbound: null,
      env: {
        SHIPLET_CAPABILITY: capability,
        SHIPLET_SCOPE: {
          shipletId: "shiplet_a",
          revisionId: "revision_a",
          activationGeneration: 3,
        },
      },
    });
    expect(Object.keys((loadedCode?.env ?? {}) as object).sort()).toEqual([
      "SHIPLET_CAPABILITY",
      "SHIPLET_SCOPE",
    ]);
    expect(
      invokedRequests.every((request) => !request.headers.has("authorization")),
    ).toBe(true);
    await invocation.cancel();
    expect(invokedRequests[0]?.signal.aborted).toBe(true);
    expect(loadedCodes).toHaveLength(2);
    expect(
      loadedCodes.some(
        (candidate) =>
          (candidate.env as Record<string, unknown>).SHIPLET_CAPABILITY === capability,
      ),
    ).toBe(true);
    expect(
      loadedCodes.some(
        (candidate) =>
          (candidate.env as Record<string, unknown>).SHIPLET_CAPABILITY ===
          nextCapability,
      ),
    ).toBe(true);
    expect(loadedCodes[0]).not.toBe(loadedCodes[1]);

    const tampered = createCustomMcpDynamicWorkerInvocation({
      loader: {
        load() {
          return {
            getEntrypoint() {
              return {
                async fetch() {
                  return new Response("unreachable");
                },
              };
            },
          };
        },
      },
      capability,
      binding: {
        ...binding,
        handlers: [
          {
            path: "mcp/handlers/read.js",
            digest: handlerDigest,
            bytes: new TextEncoder().encode("export default async () => null"),
          },
        ],
      },
      invocationId: "invocation_b",
      requestBytes: new TextEncoder().encode("{}"),
    });
    await expect(tampered.run()).rejects.toThrow("custom_mcp_handler_invalid");
  });

  it("Given a grant-bound provider transport, When the route drifts, Then no provider request is sent", async () => {
    const requests: Array<{ url: string; hasAuthority: boolean }> = [];
    const transport = createCloudflareGrantTransport({
      credential: { accessToken: crypto.randomUUID() },
      binding: {
        accountId: "0123456789abcdef0123456789abcdef",
        scriptName: "shiplet-a",
        operation: "worker.inspect",
        revisionId: "revision_a",
        packageDigest: `sha256:${"a".repeat(64)}`,
      },
      fetch: async (request) => {
        const normalized =
          request instanceof Request ? request : new Request(request);
        requests.push({
          url: normalized.url,
          hasAuthority: normalized.headers.has("authorization"),
        });
        return Response.json({ success: true, result: {} });
      },
    });
    const allowed = await transport.requestBytes({
      method: "GET",
      url: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/shiplet-a/script-settings",
    });
    expect(allowed.status).toBe(200);
    expect(allowed.bytes.byteLength).toBeGreaterThan(0);
    expect(requests).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/shiplet-a/script-settings",
        hasAuthority: true,
      },
    ]);
    await expect(
      transport.requestBytes({
        method: "GET",
        url: "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/scripts/shiplet-b/script-settings",
      }),
    ).rejects.toThrow("cloudflare_provider_route_denied");
    expect(requests).toHaveLength(1);
  });

  it("Given a provisioning response, When accepted, Then sensitive values stay in the sealed payload only", () => {
    const opaqueAccountMaterial = crypto.randomUUID();
    const opaqueClaimMaterial = crypto.randomUUID();
    const claimLocation = new URL("https://dash.cloudflare.com/claim-preview");
    claimLocation.searchParams.set("claimToken", opaqueClaimMaterial);
    const parsed = validateTemporaryProvisioningResponse(
      {
        success: true,
        result: {
          account: {
            id: "0123456789abcdef0123456789abcdef",
            name: "Temporary fixture",
            apiToken: opaqueAccountMaterial,
            tokenId: crypto.randomUUID(),
            expiresAt: "2026-08-07T19:00:00.000Z",
          },
          claim: {
            token: opaqueClaimMaterial,
            url: claimLocation.toString(),
            expiresAt: "2026-08-07T18:30:00.000Z",
          },
        },
      },
      Date.parse("2026-08-07T18:00:00.000Z"),
    );

    expect(parsed.public).toEqual({
      accountId: "0123456789abcdef0123456789abcdef",
      accountLabel: "Temporary fixture",
      accountExpiresAt: Date.parse("2026-08-07T19:00:00.000Z"),
      claimExpiresAt: Date.parse("2026-08-07T18:30:00.000Z"),
    });
    expect(JSON.stringify(parsed.public)).not.toContain(opaqueAccountMaterial);
    expect(JSON.stringify(parsed.public)).not.toContain("claim-preview");
    expect(parsed.sensitive.apiToken.length).toBe(36);
    expect(new URL(parsed.sensitive.claimUrl).hostname).toBe(
      "dash.cloudflare.com",
    );
  });

  it("Given a managed invocation, When composed, Then authority headers are stripped and limits are exact", async () => {
    const headers = new Headers({ accept: "text/html" });
    headers.set("authorization", ["Bearer", crypto.randomUUID()].join(" "));
    headers.set("cookie", `session=${crypto.randomUUID()}`);
    headers.set("cf-connecting-ip", "192.0.2.1");
    headers.set("x-forwarded-for", "192.0.2.2");
    headers.set("x-shiplet-capability", crypto.randomUUID());
    const request = new Request("https://tenant.shiplet.cc/private", {
      headers,
    });
    const invocation = await createManagedDispatchInvocation({
      request,
      expected: {
        shipletId: "shiplet_a",
        revisionId: "revision_a",
        packageDigest: `sha256:${"a".repeat(64)}`,
        activationGeneration: 4,
      },
      active: {
        shipletId: "shiplet_a",
        revisionId: "revision_a",
        packageDigest: `sha256:${"a".repeat(64)}`,
        activationGeneration: 4,
        scriptName: "shiplet-a-r4",
      },
      limits: { cpuMs: 20, subRequests: 8 },
    });

    expect(invocation.scriptName).toBe("shiplet-a-r4");
    expect(invocation.options).toEqual({
      limits: { cpuMs: 20, subRequests: 8 },
      outbound: {
        policy: "deny_by_default",
        shiplet: "shiplet_a",
        revision: "revision_a",
        generation: "4",
      },
    });
    for (const name of [
      "authorization",
      "cookie",
      "cf-connecting-ip",
      "x-forwarded-for",
      "x-shiplet-capability",
    ]) {
      expect(invocation.request.headers.has(name)).toBe(false);
    }
    expect(invocation.request.headers.get("accept")).toBe("text/html");

    await expect(
      createManagedDispatchInvocation({
        request,
        expected: {
          shipletId: "shiplet_a",
          revisionId: "revision_a",
          packageDigest: `sha256:${"a".repeat(64)}`,
          activationGeneration: 3,
        },
        active: invocation.active,
        limits: { cpuMs: 20, subRequests: 8 },
      }),
    ).rejects.toThrow("managed_revision_binding_mismatch");
  });

  it("Given outbound fetch, When no exact grant exists, Then the mediator never calls fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const denied = await handleManagedOutboundRequest({
      request: new Request("https://example.com/resource"),
      context: {
        policy: "deny_by_default",
        shiplet: "shiplet_a",
        revision: "revision_a",
        generation: "4",
      },
      allow: [],
      fetch: fetcher,
    });
    expect(denied.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();

    fetcher.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const allowed = await handleManagedOutboundRequest({
      request: new Request("https://api.example.com/resource", {
        method: "POST",
      }),
      context: {
        policy: "deny_by_default",
        shiplet: "shiplet_a",
        revision: "revision_a",
        generation: "4",
      },
      allow: [{ origin: "https://api.example.com", methods: ["POST"] }],
      fetch: fetcher,
    });
    expect(allowed.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Given deployable configs, When inspected, Then names and authority boundaries are stable", async () => {
    const configs = [
      controlPlaneConfig,
      managedRuntimeConfig,
      denyEgressConfig,
    ];
    expect(configs[0]).toContain('"name": "shiplet-example-control-plane"');
    expect(configs[1]).toContain('"name": "shiplet-example-runtime-gateway"');
    expect(configs[2]).toContain('"name": "shiplet-example-deny-egress"');
    expect(configs[0]).toContain('"binding": "CONTROL_DB"');
    expect(controlPlaneSource).toContain("class CloudflareTemporaryAccountRpc");
    expect(controlPlaneSource).toContain("consumeForBackendRedirect");
    expect(controlPlaneSource).toContain("redeemBackendRedirect");
    expect(controlPlaneSource).toContain("prepareD1TemporaryClaimDelivery");
    expect(controlPlaneSource).toContain("deliverD1PreparedTemporaryClaim");
    expect(controlPlaneSource).toContain("redeemD1TemporaryClaimRedirect");
    expect(controlPlaneSource).toContain(
      "reconcileD1TemporaryProviderOperations",
    );
    expect(controlPlaneSource).not.toContain("await markDelivered()");
    expect(controlPlaneSource).toContain("scheduled(");
    expect(
      (controlPlaneSource.match(/assertSupportReleaseExpectation/g) || [])
        .length,
    ).toBeGreaterThanOrEqual(10);
    expect(managedRuntimeCoordinatorSource).toContain(
      "attestDependencies(expectation",
    );
    for (const managedMethod of [
      "stageRevision",
      "promote",
      "rollback",
      "invoke",
    ]) {
      expect(`${managedRuntimeSource}\n${managedRuntimeCoordinatorSource}`).toMatch(
        new RegExp(
          `${managedMethod}\\([\\s\\S]{0,700}ManagedRuntimeReleaseExpectation[\\s\\S]{0,500}(?:attestDependencies|ManagedRuntimeCoordinator)`,
        ),
      );
    }
    expect(supportReleaseMigration).toContain("support_version_id");
    expect(supportReleaseMigration).toContain("support_version_tag");
    expect(temporaryRecoveryMigration).toContain(
      "temporary_provider_operations",
    );
    expect(temporaryRecoveryMigration).toContain(
      "idx_backend_redirects_deployment_delivery",
    );
    expect(oauthFinalizationDeliveryMigration).toContain(
      "delivery_handle_digest",
    );
    expect(oauthFinalizationDeliveryMigration).toContain(
      "delivery_result_json",
    );
    expect(controlPlaneSource).toContain(
      "reconcileD1ExpiredOAuthFinalizationDeliveries",
    );
    expect(controlPlaneConfig).toContain('"crons": ["*/15 * * * *"]');
    for (const config of configs) {
      const parsed = JSON.parse(config) as {
        observability?: {
          enabled?: boolean;
          logs?: { invocation_logs?: boolean };
        };
      };
      expect(parsed.observability).toEqual({
        enabled: true,
        logs: { invocation_logs: false },
      });
    }
    expect(configs[1]).toContain('"binding": "STAGING_DISPATCH"');
    expect(configs[1]).toContain('"binding": "PRODUCTION_DISPATCH"');
    expect(configs[1]).toContain('"service": "shiplet-example-deny-egress"');
    expect(managedRuntimeSource).toContain("export class ManagedRuntimeGateway");
    expect(managedRuntimeSource).toMatch(
      /acknowledgeActivation\([\s\S]{0,500}\.acknowledgeActivation\(input, expectation\)/,
    );
    expect(managedRuntimeSource).not.toContain(
      "export default ManagedRuntimeGateway",
    );
    expect(managedRuntimeSource).toContain("managed_runtime_unavailable");
    expect(managedRuntimeSource).toContain("class CloudflareVersionHealthRpc");
    expect(managedRuntimeSource).toContain("class CustomMcpRuntimeRpc");
    expect(customMcpRuntimeSource).toContain("globalOutbound: null");
    expect(managedRuntimeConfig).toContain('"binding": "CUSTOM_MCP_LOADER"');
    expect(managedRuntimeCoordinatorSource).toContain(
      "expectedActivationGeneration",
    );
    expect(managedRuntimeCoordinatorSource).toContain("STAGING_DISPATCH");
    expect(managedRuntimeCoordinatorSource).toContain("PRODUCTION_DISPATCH");
    expect(managedRuntimeSource).toContain("MANAGED_DEPLOYMENT_BROKER");
    expect(managedRuntimeSource).toContain("DENY_EGRESS_CONTRACT");
    expect(`${managedRuntimeSource}\n${managedRuntimeCoordinatorSource}`).not.toMatch(
      /WFP_DEPLOYMENT_CREDENTIAL|authorization["']?\s*,\s*["']Bearer|CLOUDFLARE_API_ORIGIN/,
    );
    expect(managedRuntimeCoordinatorSource).toContain(
      "bindings: NO_AMBIENT_BINDINGS",
    );
    expect(denyEgressSource).toContain("class DenyEgressWorker");
    expect(denyEgressSource).toContain("class DenyEgressContractRpc");
    expect(denyEgressSource).toContain("handleManagedOutboundRequest");
    expect(denyEgressConfig).toContain('"binding": "CF_VERSION_METADATA"');
    for (const config of configs) {
      expect(config).toContain('"compatibility_date": "2026-08-07"');
      expect(config).not.toMatch(
        /api[_-]?token|client[_-]?secret|claim[_-]?url/i,
      );
    }
    expect(mainWorkerConfig).toContain('"compatibility_date": "2026-08-07"');
  });

  it("Given installed support services, When the main Worker is deployed, Then each authority is bound through its named entrypoint", () => {
    for (const binding of [
      "CLOUDFLARE_OAUTH_CONTROL_PLANE",
      "CLOUDFLARE_GRANT_VAULT_RPC",
      "CLOUDFLARE_TEMPORARY_ACCOUNT_RPC",
    ]) {
      expect(mainWorkerConfig).toContain(`"binding": "${binding}"`);
      expect(mainWorkerConfig).toContain(
        '"service": "shiplet-example-control-plane"',
      );
    }
    expect(mainWorkerConfig).toContain(
      '"entrypoint": "CloudflareOAuthControlPlane"',
    );
    expect(mainWorkerConfig).toContain(
      '"entrypoint": "CloudflareGrantVaultRpc"',
    );
    expect(mainWorkerConfig).toContain(
      '"entrypoint": "CloudflareTemporaryAccountRpc"',
    );
    expect(mainWorkerConfig).toContain(
      '"binding": "CLOUDFLARE_VERSION_HEALTH_RPC"',
    );
    expect(mainWorkerConfig).toContain(
      '"service": "shiplet-example-runtime-gateway"',
    );
    expect(mainWorkerConfig).toContain(
      '"entrypoint": "CloudflareVersionHealthRpc"',
    );
    expect(mainWorkerConfig).toContain(
      '"binding": "CLOUDFLARE_CUSTOM_MCP_RUNTIME_RPC"',
    );
    expect(mainWorkerConfig).toContain('"entrypoint": "CustomMcpRuntimeRpc"');
  });
});
