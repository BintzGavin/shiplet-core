import { describe, expect, it, vi } from "vitest";
import * as cloudflareAdapters from "../src/cloudflare-production-adapters";
import {
  CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES,
  CLOUDFLARE_API_ORIGIN,
  CLOUDFLARE_CUSTOMER_WORKER_EGRESS_ENFORCEMENT,
  CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS,
  CloudflareProductionAdapterError,
  createCloudflareOpaqueTemporaryAuthorizationHandle,
  createCloudflareTemporaryClaimHandle,
  createCloudflareCustomerDeploymentProvider as createStrictCloudflareCustomerDeploymentProvider,
  createCloudflarePublicOAuthProvider,
  digestCloudflareProviderRequest,
  parseCloudflareJsonBytesBounded,
  readCloudflareJsonResponseBounded,
  solveCloudflarePreviewChallenge,
  type CloudflareGrantVaultResolver,
  type CloudflareOAuthRedactingFetch,
  type CloudflareRedactingFetch,
  type CloudflareTemporaryAccountBroker,
} from "../src/cloudflare-production-adapters";
import type { CloudflareDeploymentProvider } from "../src/deployment-orchestrator";

const now = 1_900_000_000_000;
const accountId = "account_a1";
const scriptName = "shiplet-a";
const workerId = "worker_a1";
const revisionId = "revision_a1";
const shipletId = "shiplet_a1";
const targetId = "target_a1";
const packageDigest = `sha256:${"a".repeat(64)}`;
const temporaryCreateScopes = [
  "temporary.accounts.create",
  "temporary.workers.deploy",
];
const temporaryCleanupScopes = ["temporary.workers.cleanup"];

type RuntimeCloudflareDeploymentProvider = CloudflareDeploymentProvider & {
  cleanupVersion(input: Record<string, unknown>): Promise<void>;
};

function runtimeDeploymentProvider(
  dependencies: Parameters<
    typeof createStrictCloudflareCustomerDeploymentProvider
  >[0],
) {
  return createStrictCloudflareCustomerDeploymentProvider(
    dependencies,
  ) as unknown as RuntimeCloudflareDeploymentProvider;
}

function providerResponse(
  body: unknown,
  status = 200,
  serializedBodyBytes?: number,
) {
  const bounded = parseCloudflareJsonBytesBounded(
    {
      status,
      bytes: new TextEncoder().encode(JSON.stringify(body)),
    },
    1024 * 1024,
  );
  return serializedBodyBytes === undefined
    ? bounded
    : { ...bounded, serializedBodyBytes };
}

function redirectUri(path = "/api/cloudflare/oauth/callback") {
  return `https://shiplet.invalid${path}`;
}

function opaqueCredential() {
  return Object.freeze(Object.create(null)) as object;
}

function strongClaimHandle() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function clientRegistration() {
  return {
    source: "cloudflare_oauth_client_registration" as const,
    verifiedAt: now,
    scopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
  };
}

function customerUploadRequest(overrides: Record<string, unknown> = {}) {
  return {
    actorId: "user_a1",
    shipletId,
    targetId,
    accountId,
    scriptName,
    revisionId,
    packageDigest,
    mainModule: "worker.mjs",
    modules: [
      {
        name: "worker.mjs",
        mediaType: "application/javascript+module",
        content: "export default { fetch() { return new Response('ok') } }",
      },
    ],
    staticAssets: [],
    bindings: [],
    limits: { cpuMs: 25, subRequests: 8 },
    egress: { status: "customer_controlled_unrestricted" },
    ...overrides,
  };
}

function oauthTransport(
  overrides: Partial<CloudflareOAuthRedactingFetch> = {},
) {
  const material = opaqueCredential();
  const transport: CloudflareOAuthRedactingFetch = {
    exchange: vi.fn(async () => ({
      material,
      accounts: [{ id: accountId, label: "Example account" }],
      scopes: ["workers.scripts.read", "workers.scripts.write"],
      expiresAt: now + 60_000,
      serializedBodyBytes: 512,
    })),
    refresh: vi.fn(async () => ({
      material,
      expiresAt: now + 60_000,
      serializedBodyBytes: 256,
    })),
    revoke: vi.fn(async () => ({ serializedBodyBytes: 64 })),
    ...overrides,
  };
  return { material, transport };
}

describe("Cloudflare public OAuth production adapter", () => {
  it("fails honestly until an exact public-client registration assertion is supplied", () => {
    const { transport } = oauthTransport();
    expect(() =>
      createCloudflarePublicOAuthProvider({
        clientId: "shiplet_public_client",
        redirectUris: [redirectUri()],
        allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
        now: () => now,
        fetch: transport,
      }),
    ).toThrow("cloudflare_oauth_client_registration_prerequisite");
  });

  it("accepts an exact public-client registration assertion without a daily credentialed scope lookup", () => {
    const { transport } = oauthTransport();
    expect(() =>
      createCloudflarePublicOAuthProvider({
        clientId: "shiplet_public_client",
        redirectUris: [redirectUri()],
        allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
        clientRegistration: {
          source: "cloudflare_oauth_client_registration",
          verifiedAt: now - 30 * 24 * 60 * 60 * 1_000,
          scopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
        },
        now: () => now,
        fetch: transport,
      }),
    ).not.toThrow();
  });

  it.each([
    ["an extra scope", [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES, "account.settings.write"]],
    ["a missing scope", ["workers.scripts.read", "workers.scripts.write"]],
  ])("rejects a registration assertion with %s", (_label, scopes) => {
    const { transport } = oauthTransport();
    expect(() =>
      createCloudflarePublicOAuthProvider({
        clientId: "shiplet_public_client",
        redirectUris: [redirectUri()],
        allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
        clientRegistration: {
          source: "cloudflare_oauth_client_registration",
          verifiedAt: now,
          scopes,
        },
        now: () => now,
        fetch: transport,
      }),
    ).toThrow("cloudflare_oauth_client_registration_prerequisite");
  });

  it("Given an exact public-client PKCE request, when authorization begins, then it uses only Cloudflare's allowlisted endpoint and exact dot scopes", async () => {
    const { transport } = oauthTransport();
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });

    const authorization = new URL(
      await provider.createAuthorizationUrl({
        clientId: "shiplet_public_client",
        redirectUri: redirectUri(),
        state: "state_a1.signature_b1",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        scopes: ["workers.scripts.write", "workers.scripts.read"],
      }),
    );

    expect(authorization.origin + authorization.pathname).toBe(
      CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.authorization,
    );
    expect(authorization.searchParams.get("response_type")).toBe("code");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("scope")).toBe(
      "workers.scripts.read workers.scripts.write",
    );
    expect([...authorization.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
  });

  it("requires the exact 43-character SHA-256 PKCE challenge representation", async () => {
    const { transport } = oauthTransport();
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });

    await expect(
      provider.createAuthorizationUrl({
        clientId: "shiplet_public_client",
        redirectUri: redirectUri(),
        state: "state_a1.signature_b1",
        codeChallenge: "a".repeat(44),
        codeChallengeMethod: "S256",
        scopes: ["workers.scripts.write"],
      }),
    ).rejects.toMatchObject({ code: "oauth_request_invalid" });
  });

  it.each([
    ["unregistered redirect", { redirectUri: redirectUri("/wrong") }],
    [
      "unknown scope",
      { scopes: ["workers.scripts.write", "account.settings.write"] },
    ],
    [
      "duplicate scope",
      { scopes: ["workers.scripts.write", "workers.scripts.write"] },
    ],
    ["wrong client", { clientId: "different_client" }],
  ])("fails closed for %s", async (_label, change) => {
    const { transport } = oauthTransport();
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });
    await expect(
      provider.createAuthorizationUrl({
        clientId: "shiplet_public_client",
        redirectUri: redirectUri(),
        state: "state_a1.signature_b1",
        codeChallenge: "a".repeat(43),
        codeChallengeMethod: "S256",
        scopes: ["workers.scripts.write"],
        ...change,
      }),
    ).rejects.toMatchObject({ code: "oauth_request_invalid" });
  });

  it("seals token handling behind the redacting fetch and accepts exactly one account", async () => {
    const { material, transport } = oauthTransport();
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });

    const result = await provider.exchangeAuthorization({
      authorizationCode: crypto.randomUUID(),
      redirectUri: redirectUri(),
      codeVerifier: "v".repeat(43),
    });

    expect(result.material).toBe(material);
    expect(result).toMatchObject({
      accountId,
      accountLabel: "Example account",
      scopes: ["workers.scripts.read", "workers.scripts.write"],
      expiresAt: now + 60_000,
    });
    expect(transport.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token,
        grantType: "authorization_code",
        clientId: "shiplet_public_client",
      }),
    );
  });

  it("hands the redacting transport an exact form-encoded authorization exchange", async () => {
    const authorizationCode = crypto.randomUUID();
    const codeVerifier = `v${"-".repeat(42)}`;
    const { transport } = oauthTransport();
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });

    await provider.exchangeAuthorization({
      authorizationCode,
      redirectUri: redirectUri(),
      codeVerifier,
    });

    const exchange = vi.mocked(transport.exchange).mock
      .calls[0]![0] as unknown as {
      method: string;
      contentType: string;
      form: string;
      redactedFields: string[];
    };
    expect(exchange.method).toBe("POST");
    expect(exchange.contentType).toBe("application/x-www-form-urlencoded");
    expect(exchange.redactedFields).toEqual(["code", "code_verifier"]);
    expect(Object.fromEntries(new URLSearchParams(exchange.form))).toEqual({
      client_id: "shiplet_public_client",
      code: authorizationCode,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(),
    });
  });

  it.each([
    [
      "cross-account ambiguity",
      {
        accounts: [
          { id: accountId, label: "A" },
          { id: "account_b1", label: "B" },
        ],
      },
    ],
    [
      "unexpected granted scope",
      { scopes: ["workers.scripts.write", "account.settings.write"] },
    ],
    ["stale authorization", { expiresAt: now }],
  ])("rejects a malicious token response: %s", async (_label, override) => {
    const { transport } = oauthTransport({
      exchange: vi.fn(async () => ({
        material: opaqueCredential(),
        accounts: [{ id: accountId, label: "Example account" }],
        scopes: ["workers.scripts.write"],
        expiresAt: now + 60_000,
        serializedBodyBytes: 512,
        ...override,
      })),
    });
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });

    await expect(
      provider.exchangeAuthorization({
        authorizationCode: crypto.randomUUID(),
        redirectUri: redirectUri(),
        codeVerifier: "v".repeat(43),
      }),
    ).rejects.toMatchObject({ code: "oauth_response_invalid" });
  });

  it("refreshes and revokes only through the opaque material identity and sanitizes provider failures", async () => {
    const material = opaqueCredential();
    const transport: CloudflareOAuthRedactingFetch = {
      exchange: vi.fn(),
      refresh: vi.fn(async () => {
        throw new Error(`provider detail ${crypto.randomUUID()}`);
      }),
      revoke: vi.fn(async (request) => {
        expect(request.opaqueSubstitution.material).toBe(material);
        expect(request.endpoint).toBe(CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.revoke);
        return { serializedBodyBytes: 64 };
      }),
    };
    const provider = createCloudflarePublicOAuthProvider({
      clientId: "shiplet_public_client",
      redirectUris: [redirectUri()],
      allowedScopes: [...CLOUDFLARE_ALLOWED_PUBLIC_OAUTH_SCOPES],
      clientRegistration: clientRegistration(),
      now: () => now,
      fetch: transport,
    });

    await expect(provider.refresh(material)).rejects.toEqual(
      new CloudflareProductionAdapterError("oauth_refresh_failed"),
    );
    expect(transport.refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: CLOUDFLARE_PUBLIC_OAUTH_ENDPOINTS.token,
        grantType: "refresh_token",
        clientId: "shiplet_public_client",
        opaqueSubstitution: { field: "refresh_token", material },
      }),
    );
    const refresh = vi.mocked(transport.refresh).mock.calls[0]![0];
    expect(new URLSearchParams(refresh.form).has("refresh_token")).toBe(false);
    expect(refresh).not.toHaveProperty("material");
    await provider.revoke(material);
    const revoke = vi.mocked(transport.revoke).mock.calls[0]![0] as unknown as {
      form: string;
      opaqueSubstitution: { field: string; material: object };
    };
    expect(new URLSearchParams(revoke.form).has("token")).toBe(false);
    expect(revoke.opaqueSubstitution).toEqual({ field: "token", material });
  });
});

describe("Cloudflare bounded response serialization boundary", () => {
  it("caps streamed bytes before parsing provider JSON", async () => {
    const readBounded = (
      cloudflareAdapters as unknown as {
        readCloudflareJsonResponseBounded?: (
          response: Response,
          maximumBytes: number,
        ) => Promise<unknown>;
      }
    ).readCloudflareJsonResponseBounded;
    expect(typeof readBounded).toBe("function");
    if (!readBounded) return;
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":true,'));
          controller.enqueue(new TextEncoder().encode('"padding":"aaaaaaaa"}'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(readBounded(oversized, 24)).rejects.toMatchObject({
      code: "provider_response_too_large",
    });
  });
});

type RecordedRequest = Parameters<CloudflareRedactingFetch["request"]>[0];

function customerProviderFixture(
  options: { executeUploadedStaticCandidate?: boolean } = {},
) {
  const requests: RecordedRequest[] = [];
  let uploadedMainModule: string | null = null;
  const assetsFetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    return new Response(`asset:${path}`, { status: 200 });
  });
  const executeUploadedCandidate = async (
    request: Request,
    versionId: string,
  ) => {
    if (!uploadedMainModule) throw new Error("uploaded_candidate_missing");
    const executable = uploadedMainModule.replace(
      /^export default\s+/u,
      "return ",
    );
    const candidate = new Function(executable)() as {
      fetch(
        request: Request,
        environment: Record<string, unknown>,
      ): Promise<Response> | Response;
    };
    return candidate.fetch(request, {
      ASSETS: { fetch: assetsFetch },
      CF_VERSION_METADATA: {
        id: versionId,
        tag: packageDigest,
        timestamp: new Date(now).toISOString(),
      },
    });
  };
  const versionHealthVerifier = {
    execute: vi.fn(
      async (input: {
        versionId: string;
        revisionId: string;
        packageDigest: string;
      }) => {
        if (!options.executeUploadedStaticCandidate) {
          return providerResponse({
            ok: true,
            versionId: input.versionId,
            revisionId: input.revisionId,
            packageDigest: input.packageDigest,
          });
        }
        const response = await executeUploadedCandidate(
          new Request(
            `https://candidate-${input.versionId.slice(0, 8)}.workers.dev/__shiplet/health`,
          ),
          input.versionId,
        );
        return readCloudflareJsonResponseBounded(response, 1024 * 1024);
      },
    ),
  };
  const transport: CloudflareRedactingFetch = {
    request: vi.fn(async (request) => {
      requests.push(request);
      if (request.url.includes("/workers/scripts-search?")) {
        return providerResponse({
          success: true,
          result: [{ id: workerId, script_name: scriptName }],
        });
      }
      if (request.url.endsWith("/script-settings")) {
        return providerResponse({ success: true, result: {} });
      }
      if (
        new URL(request.url).pathname.endsWith("/versions") &&
        request.method === "POST"
      ) {
        if (request.body?.kind === "worker_version") {
          const mainModule = request.body.metadata.main_module;
          uploadedMainModule =
            typeof mainModule === "string"
              ? (request.body.modules.find(
                  (module: { name: string; content: string }) =>
                    module.name === mainModule,
                )?.content ?? null)
              : null;
        }
        return providerResponse({
          success: true,
          result: { id: crypto.randomUUID() },
        });
      }
      if (request.url.includes("/versions/") && request.method === "GET") {
        const versionId = request.url.split("/").at(-1)!;
        return providerResponse({
          success: true,
          result: {
            id: versionId,
            annotations: { "workers/tag": packageDigest },
            urls: [
              `https://${versionId.slice(0, 8)}-${scriptName}.workers.dev`,
            ],
          },
        });
      }
      if (request.url.endsWith("/deployments")) {
        const versionId = (
          request.body?.kind === "json" &&
          Array.isArray(request.body.value.versions)
            ? request.body.value.versions[0]
            : undefined
        ) as { version_id?: unknown } | undefined;
        return providerResponse({
          success: true,
          result: {
            id: crypto.randomUUID(),
            strategy: "percentage",
            versions: [{ version_id: versionId?.version_id, percentage: 100 }],
          },
        });
      }
      if (request.url.endsWith("/workers/workers")) {
        return providerResponse({
          success: true,
          result: { id: workerId, name: scriptName },
        });
      }
      return providerResponse({ success: false, result: null }, 404);
    }),
    uploadStaticAssets: vi.fn(async (request) => ({
      completion: Object.freeze(Object.create(null)) as object,
      manifestDigest: request.packageDigest,
      serializedBodyBytes: 256,
    })),
  };
  const grants: CloudflareGrantVaultResolver = {
    withGrant: vi.fn(async (_binding, operation) => await operation(transport)),
  };
  return {
    requests,
    transport,
    grants,
    provider: runtimeDeploymentProvider({
      now: () => now,
      grants,
      versionHealthVerifier,
    }),
    versionHealthVerifier,
    assetsFetch,
    executeUploadedCandidate,
  };
}

async function envelope(
  request: Record<string, unknown>,
  operation: string,
  scopes: string[],
) {
  const scopedRequest: Record<string, unknown> = {
    actorId: "user_a1",
    shipletId,
    targetId,
    ...request,
  };
  return {
    authorization: {
      handle: `grant_${crypto.randomUUID()}`,
      userId: "user_a1",
      shipletId,
      accountId,
      expiresAt: now + 60_000,
      operation,
      scopes,
      targetId,
      scriptName,
      revisionId,
      ...(typeof scopedRequest["packageDigest"] === "string"
        ? { packageDigest: scopedRequest["packageDigest"] }
        : {}),
      requestDigest: await digestCloudflareProviderRequest(scopedRequest),
    },
    request: scopedRequest,
    ...scopedRequest,
  };
}

async function temporaryEnvelope(
  request: Record<string, unknown>,
  operation: string,
  scopes: string[],
) {
  const requestDigest = await digestCloudflareProviderRequest(request);
  return {
    authorization: {
      handle: `temporary_grant_${crypto.randomUUID()}`,
      userId: "user_a1",
      shipletId,
      accountId,
      expiresAt: now + 60_000,
      operation,
      scopes,
      targetId,
      scriptName,
      revisionId,
      packageDigest,
      operationId: request.operationId,
      requestDigest,
    },
    request,
    ...request,
  };
}

describe("Cloudflare customer-owned Worker deployment provider", () => {
  it("exports the stable upload, exact OAuth registration, isolated beta preview/delete, and executed-health prerequisites", () => {
    const prerequisite = (
      cloudflareAdapters as unknown as {
        CLOUDFLARE_PRODUCTION_PREREQUISITES?: Record<string, unknown>;
      }
    ).CLOUDFLARE_PRODUCTION_PREREQUISITES;
    expect(prerequisite).toMatchObject({
      workerVersionApi: {
        primary: "workers.scripts.versions",
        stability: "stable",
        betaUsage: "version_preview_and_delete_only",
      },
      oauthClientRegistration: {
        status: "exact_registration_required",
        source: "operator_verified_cloudflare_client",
      },
      candidateExecution: {
        status: "version_preview_health_verifier_required",
      },
    });
  });

  it("inspects only the exact encoded account/script path through the opaque grant resolver", async () => {
    const fixture = customerProviderFixture();
    const request = { accountId, scriptName };

    await expect(
      fixture.provider.hasScript(
        await envelope(request, "worker.inspect", ["workers.scripts.read"]),
      ),
    ).resolves.toBe(true);
    expect(fixture.requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/scripts/${scriptName}/script-settings`,
      }),
    ]);
    expect(fixture.requests[0]).not.toHaveProperty("headers.Authorization");
  });

  it.each([
    ["path injection", { accountId: "../account_b1", scriptName }],
    [
      "script injection",
      { accountId, scriptName: "shiplet-a/../../shiplet-b" },
    ],
  ])("rejects %s before resolving authority", async (_label, request) => {
    const fixture = customerProviderFixture();
    await expect(
      fixture.provider.hasScript(
        await envelope(request, "worker.inspect", ["workers.scripts.read"]),
      ),
    ).rejects.toMatchObject({ code: "deployment_request_invalid" });
    expect(fixture.grants.withGrant).not.toHaveBeenCalled();
  });

  it("rejects cross-account, stale, wrong-operation, and digest-mismatched grants", async () => {
    const fixture = customerProviderFixture();
    const request = { accountId, scriptName };
    const valid = await envelope(request, "worker.inspect", [
      "workers.scripts.read",
    ]);
    const candidates = [
      {
        ...valid,
        authorization: { ...valid.authorization, accountId: "account_b1" },
      },
      { ...valid, authorization: { ...valid.authorization, expiresAt: now } },
      {
        ...valid,
        authorization: {
          ...valid.authorization,
          operation: "worker.version.upload",
        },
      },
      {
        ...valid,
        authorization: { ...valid.authorization, requestDigest: packageDigest },
      },
    ];

    for (const candidate of candidates) {
      await expect(fixture.provider.hasScript(candidate)).rejects.toMatchObject(
        {
          code: "deployment_authorization_invalid",
        },
      );
    }
    expect(fixture.grants.withGrant).not.toHaveBeenCalled();
  });

  it("fails closed when the opaque credential grant is revoked without reflecting resolver detail", async () => {
    const resolverMarker = crypto.randomUUID();
    const grants: CloudflareGrantVaultResolver = {
      withGrant: vi.fn(async () => {
        throw new Error(resolverMarker);
      }),
    };
    const provider = runtimeDeploymentProvider({
      now: () => now,
      grants,
    });
    let thrown: unknown;
    try {
      await provider.hasScript(
        await envelope({ accountId, scriptName }, "worker.inspect", [
          "workers.scripts.read",
        ]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "deployment_authority_unavailable" });
    expect(String(thrown)).not.toContain(resolverMarker);
  });

  it("treats a missing script as absent without accepting other provider failures", async () => {
    const transport: CloudflareRedactingFetch = {
      request: vi.fn(async () =>
        providerResponse({ success: false, result: null }, 404),
      ),
      uploadStaticAssets: vi.fn(),
    };
    const grants: CloudflareGrantVaultResolver = {
      withGrant: vi.fn(
        async (_binding, operation) => await operation(transport),
      ),
    };
    const provider = runtimeDeploymentProvider({
      now: () => now,
      grants,
    });
    await expect(
      provider.hasScript(
        await envelope({ accountId, scriptName }, "worker.inspect", [
          "workers.scripts.read",
        ]),
      ),
    ).resolves.toBe(false);
  });

  it("creates an inert undeployed Worker baseline before returning its immutable version", async () => {
    const fixture = customerProviderFixture();
    const request = {
      accountId,
      scriptName,
      bootstrap: { kind: "inert_known_good" as const },
      bindings: [],
    };
    await expect(
      fixture.provider.initializeScript(
        await envelope(request, "worker.script.initialize", [
          "workers.scripts.write",
        ]),
      ),
    ).resolves.toMatchObject({
      versionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(fixture.requests[0]).toMatchObject({
      method: "POST",
      url: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/workers`,
      body: {
        kind: "json",
        value: {
          name: scriptName,
          subdomain: { enabled: true, previews_enabled: true },
        },
      },
    });
    expect(fixture.requests[1]?.url).toContain(
      `/workers/scripts/${scriptName}/versions`,
    );
  });

  it("uploads one immutable version with static assets, digest annotation, explicit limits, and only scoped bindings", async () => {
    const fixture = customerProviderFixture();
    const request = {
      actorId: "user_a1",
      shipletId,
      targetId,
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          content: "export default { fetch() { return new Response('ok') } }",
        },
      ],
      staticAssets: [
        {
          path: "/index.html",
          mediaType: "text/html; charset=utf-8",
          content: "<h1>Revision A</h1>",
        },
      ],
      bindings: [
        { name: "APP_DATA", kind: "d1", providerResourceId: "database_a1" },
        { name: "PUBLIC_MODE", kind: "plain_text", value: "review" },
      ],
      limits: { cpuMs: 25, subRequests: 8 },
      egress: { status: "customer_controlled_unrestricted" },
    };

    const uploaded = await fixture.provider.uploadVersion(
      await envelope(request, "worker.version.upload", [
        "workers.scripts.write",
      ]),
    );

    expect(uploaded.versionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.transport.uploadStaticAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        scriptName,
        revisionId,
        packageDigest,
        assets: request.staticAssets,
        manifestEndpoint: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
        uploadEndpoint: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/assets/upload?base64=true`,
        serialization: {
          kind: "cloudflare_static_assets_multipart",
          completionAssertion: "opaque_transport_substitution",
        },
      }),
    );
    const versionRequest = fixture.requests.at(-1)!;
    expect(versionRequest).toMatchObject({
      method: "POST",
      url: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/scripts/${scriptName}/versions`,
      body: {
        kind: "worker_version",
        serialization: {
          kind: "cloudflare_worker_version_multipart",
          completionAssertion: "opaque_transport_substitution",
        },
        metadata: {
          main_module: "worker.mjs",
          annotations: { "workers/tag": packageDigest },
          compatibility_date: "2026-08-05",
          bindings: [
            { name: "APP_DATA", type: "d1", database_id: "database_a1" },
            { name: "PUBLIC_MODE", type: "plain_text", text: "review" },
          ],
          limits: { cpu_ms: 25, subrequests: 8 },
          assets: { jwt: "__SHIPLET_OPAQUE_ASSET_COMPLETION__" },
        },
        assetCompletion: expect.any(Object),
      },
    });
    expect(
      versionRequest.body?.kind === "worker_version"
        ? versionRequest.body.metadata
        : {},
    ).not.toHaveProperty("deploy");
    expect(CLOUDFLARE_CUSTOMER_WORKER_EGRESS_ENFORCEMENT).toBe(
      "customer_controlled_unrestricted",
    );
    expect(
      versionRequest.body?.kind === "worker_version"
        ? versionRequest.body.metadata
        : {},
    ).not.toHaveProperty("egress");
    expect(
      fixture.requests.some((candidate) =>
        candidate.url.includes("/workers/scripts-search?"),
      ),
    ).toBe(false);
  });

  it("executes the actual uploaded static wrapper for exact health while preserving asset delivery", async () => {
    const fixture = customerProviderFixture({
      executeUploadedStaticCandidate: true,
    });
    const uploadRequest = customerUploadRequest({
      mainModule: "__shiplet_static.mjs",
      modules: [],
      staticAssets: [
        {
          path: "/index.html",
          mediaType: "text/html",
          content: "<h1>Static candidate</h1>",
        },
      ],
    });

    const uploaded = await fixture.provider.uploadVersion(
      await envelope(uploadRequest, "worker.version.upload", [
        "workers.scripts.write",
      ]),
    );
    await expect(
      fixture.provider.proveCandidate(
        await envelope(
          {
            accountId,
            scriptName,
            revisionId,
            versionId: uploaded.versionId,
            packageDigest,
            healthCheck: {
              path: "/__shiplet/health",
              expectedStatus: 200,
            },
          },
          "worker.candidate.prove",
          ["workers.scripts.read"],
        ),
      ),
    ).resolves.toMatchObject({
      healthy: true,
      observedVersionId: uploaded.versionId,
      observedPackageDigest: packageDigest,
    });

    const versionRequest = fixture.requests.find(
      (candidate) =>
        candidate.method === "POST" &&
        candidate.body?.kind === "worker_version",
    )!;
    expect(versionRequest.body).toMatchObject({
      kind: "worker_version",
      metadata: {
        main_module: "__shiplet_static.mjs",
        bindings: [
          { name: "ASSETS", type: "assets" },
          { name: "CF_VERSION_METADATA", type: "version_metadata" },
        ],
        assets: {
          jwt: "__SHIPLET_OPAQUE_ASSET_COMPLETION__",
          config: { run_worker_first: ["/__shiplet/health"] },
        },
      },
    });
    expect(fixture.assetsFetch).not.toHaveBeenCalled();
    const asset = await fixture.executeUploadedCandidate(
      new Request("https://candidate.invalid/index.html"),
      uploaded.versionId,
    );
    await expect(asset.text()).resolves.toBe("asset:/index.html");
    expect(fixture.assetsFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing actor scope", { actorId: undefined }],
    ["missing target scope", { targetId: undefined }],
    ["missing explicit main module", { mainModule: undefined }],
    ["unlisted main module", { mainModule: "missing.mjs" }],
    [
      "header-injecting module path",
      {
        modules: [
          {
            name: "worker.mjs\r\nx-invalid",
            mediaType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        mainModule: "worker.mjs\r\nx-invalid",
      },
    ],
    [
      "noncanonical relative module path",
      {
        modules: [
          {
            name: "./worker.mjs",
            mediaType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        mainModule: "./worker.mjs",
      },
    ],
    [
      "parameterized module media type",
      {
        modules: [
          {
            name: "worker.mjs",
            mediaType: "application/javascript+module; charset=utf-8",
            content: "export default {};",
          },
        ],
      },
    ],
    [
      "noncanonical asset path",
      {
        staticAssets: [
          {
            path: "/assets//logo.svg",
            mediaType: "image/svg+xml",
            content: "<svg/>",
          },
        ],
      },
    ],
  ] as const)(
    "rejects %s before any multipart boundary",
    async (_label, change) => {
      const fixture = customerProviderFixture();
      const request = customerUploadRequest(change as Record<string, unknown>);
      await expect(
        fixture.provider.uploadVersion(
          await envelope(request, "worker.version.upload", [
            "workers.scripts.write",
          ]),
        ),
      ).rejects.toMatchObject({ code: "deployment_request_invalid" });
      expect(fixture.transport.uploadStaticAssets).not.toHaveBeenCalled();
      expect(fixture.requests).toEqual([]);
    },
  );

  it("rejects legacy deny-all metadata because customer Worker egress is not kernel-enforced", async () => {
    const fixture = customerProviderFixture();
    const request = customerUploadRequest({ egress: { mode: "deny_all" } });
    await expect(
      fixture.provider.uploadVersion(
        await envelope(request, "worker.version.upload", [
          "workers.scripts.write",
        ]),
      ),
    ).rejects.toMatchObject({ code: "deployment_request_invalid" });
    expect(fixture.requests).toEqual([]);
  });

  it("rejects a reserved ambient binding before upload", async () => {
    const fixture = customerProviderFixture();
    const request = {
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          content: "export default {};",
        },
      ],
      staticAssets: [],
      bindings: [
        { name: "SHARED_D1", kind: "d1", providerResourceId: "database_a1" },
      ],
      limits: { cpuMs: 25, subRequests: 8 },
      egress: { status: "customer_controlled_unrestricted" },
    };
    await expect(
      fixture.provider.uploadVersion(
        await envelope(request, "worker.version.upload", [
          "workers.scripts.write",
        ]),
      ),
    ).rejects.toMatchObject({ code: "deployment_request_invalid" });
    expect(fixture.requests).toEqual([]);
  });

  it("rejects a static-asset completion bound to another package digest", async () => {
    const fixture = customerProviderFixture();
    vi.mocked(fixture.transport.uploadStaticAssets).mockResolvedValueOnce({
      completion: opaqueCredential(),
      manifestDigest: `sha256:${"b".repeat(64)}`,
      serializedBodyBytes: 256,
    });
    const request = {
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      mainModule: "__shiplet_static.mjs",
      modules: [],
      staticAssets: [
        { path: "/index.html", mediaType: "text/html", content: "<h1>A</h1>" },
      ],
      bindings: [],
      limits: { cpuMs: 25, subRequests: 8 },
      egress: { status: "customer_controlled_unrestricted" },
    };
    await expect(
      fixture.provider.uploadVersion(
        await envelope(request, "worker.version.upload", [
          "workers.scripts.write",
        ]),
      ),
    ).rejects.toMatchObject({ code: "provider_upload_failed" });
    expect(fixture.requests).toEqual([]);
  });

  it("proves the exact candidate version and immutable package digest before activation", async () => {
    const fixture = customerProviderFixture();
    const versionId = crypto.randomUUID();
    const request = {
      accountId,
      scriptName,
      revisionId,
      versionId,
      packageDigest,
      healthCheck: { path: "/__shiplet/health", expectedStatus: 200 },
    };

    await expect(
      fixture.provider.proveCandidate(
        await envelope(request, "worker.candidate.prove", [
          "workers.scripts.read",
        ]),
      ),
    ).resolves.toEqual({
      healthy: true,
      observedVersionId: versionId,
      observedPackageDigest: packageDigest,
    });
    expect(fixture.versionHealthVerifier.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateUrl: expect.stringMatching(
          /^https:\/\/[a-z0-9-]+\.workers\.dev\/__shiplet\/health$/,
        ),
        versionId,
        revisionId,
        packageDigest,
      }),
    );
    expect(fixture.requests[0]).toMatchObject({
      method: "GET",
      url: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/workers/${scriptName}/versions/${versionId}`,
    });
  });

  it("fails with a precise prerequisite when metadata exists but no version-targeted execution verifier is installed", async () => {
    const fixture = customerProviderFixture();
    const provider = runtimeDeploymentProvider({
      now: () => now,
      grants: fixture.grants,
    });
    const versionId = crypto.randomUUID();
    const request = {
      actorId: "user_a1",
      shipletId,
      targetId,
      accountId,
      scriptName,
      revisionId,
      versionId,
      packageDigest,
      healthCheck: {
        path: "/__shiplet/health",
        expectedStatus: 200,
      },
    };

    await expect(
      provider.proveCandidate(
        await envelope(request, "worker.candidate.prove", [
          "workers.scripts.read",
        ]),
      ),
    ).rejects.toMatchObject({
      code: "version_execution_health_prerequisite",
    });
  });

  it("activates exactly one version at 100 percent and returns only the deployment ID", async () => {
    const fixture = customerProviderFixture();
    const versionId = crypto.randomUUID();
    const request = {
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      versionId,
      percentage: 100 as const,
    };

    const result = await fixture.provider.createDeployment(
      await envelope(request, "worker.deployment.promote", [
        "workers.scripts.write",
      ]),
    );

    expect(result.deploymentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fixture.requests.at(-1)).toMatchObject({
      method: "POST",
      url: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/scripts/${scriptName}/deployments`,
      body: {
        kind: "json",
        value: {
          strategy: "percentage",
          versions: [{ version_id: versionId, percentage: 100 }],
        },
      },
    });
  });

  it("binds promotion and cleanup to the exact revision and package digest", async () => {
    const fixture = customerProviderFixture();
    const versionId = crypto.randomUUID();
    for (const request of [
      { accountId, scriptName, versionId, percentage: 100 },
      { accountId, scriptName, versionId },
    ]) {
      const operation =
        "percentage" in request
          ? "worker.deployment.promote"
          : "worker.version.cleanup";
      const call =
        "percentage" in request
          ? fixture.provider.createDeployment.bind(fixture.provider)
          : fixture.provider.cleanupVersion.bind(fixture.provider);
      await expect(
        call(await envelope(request, operation, ["workers.scripts.write"])),
      ).rejects.toMatchObject({ code: "deployment_request_invalid" });
    }
    expect(fixture.requests).toEqual([]);
  });

  it("rejects a deployment response that selects any version other than the authorized revision candidate", async () => {
    const fixture = customerProviderFixture();
    const versionId = crypto.randomUUID();
    vi.mocked(fixture.transport.request).mockResolvedValueOnce(
      providerResponse({
        success: true,
        result: {
          id: crypto.randomUUID(),
          strategy: "percentage",
          versions: [{ version_id: crypto.randomUUID(), percentage: 100 }],
        },
      }),
    );
    const request = {
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      versionId,
      percentage: 100 as const,
    };

    await expect(
      fixture.provider.createDeployment(
        await envelope(request, "worker.deployment.promote", [
          "workers.scripts.write",
        ]),
      ),
    ).rejects.toMatchObject({ code: "provider_deployment_failed" });
  });

  it("rejects a 2xx cleanup whose Cloudflare envelope reports success false", async () => {
    const fixture = customerProviderFixture();
    const versionId = crypto.randomUUID();
    vi.mocked(fixture.transport.request).mockResolvedValueOnce(
      providerResponse({ success: false, result: null }),
    );
    const request = {
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      versionId,
    };

    await expect(
      fixture.provider.cleanupVersion(
        await envelope(request, "worker.version.cleanup", [
          "workers.scripts.write",
        ]),
      ),
    ).rejects.toMatchObject({ code: "provider_cleanup_failed" });
    expect(fixture.transport.request).toHaveBeenCalledWith({
      method: "DELETE",
      url: `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/workers/workers/${scriptName}/versions/${versionId}`,
    });
  });

  it("fails closed before deserializing an oversized provider response assertion", async () => {
    const transport: CloudflareRedactingFetch = {
      request: vi.fn(async () =>
        providerResponse({ success: true, result: {} }, 200, 2 * 1024 * 1024),
      ),
      uploadStaticAssets: vi.fn(),
    };
    const grants: CloudflareGrantVaultResolver = {
      withGrant: vi.fn(
        async (_binding, operation) => await operation(transport),
      ),
    };
    const provider = runtimeDeploymentProvider({
      now: () => now,
      grants,
    });

    await expect(
      provider.hasScript(
        await envelope({ accountId, scriptName }, "worker.inspect", [
          "workers.scripts.read",
        ]),
      ),
    ).rejects.toMatchObject({ code: "provider_inspection_failed" });
  });

  it("never reflects provider response content through a thrown error", async () => {
    const responseMarker = crypto.randomUUID();
    const transport: CloudflareRedactingFetch = {
      request: vi.fn(async () =>
        providerResponse(
          { success: false, errors: [{ message: responseMarker }] },
          403,
        ),
      ),
      uploadStaticAssets: vi.fn(),
    };
    const grants: CloudflareGrantVaultResolver = {
      withGrant: vi.fn(
        async (_binding, operation) => await operation(transport),
      ),
    };
    const provider = runtimeDeploymentProvider({
      now: () => now,
      grants,
    });

    let thrown: unknown;
    try {
      await provider.hasScript(
        await envelope({ accountId, scriptName }, "worker.inspect", [
          "workers.scripts.read",
        ]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "provider_inspection_failed" });
    expect(String(thrown)).not.toContain(responseMarker);
  });
});

describe("Cloudflare temporary account proof-of-work boundary", () => {
  it("solves the bounded checkpoint chain without exposing temporary-account material", async () => {
    const seed = new Uint8Array(32);
    const solution = await solveCloudflarePreviewChallenge({
      challengeToken: crypto.randomUUID(),
      seed: btoa(String.fromCharCode(...seed))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
      k: 1,
      g: 1,
    });
    expect(solution.solution.checkpoints).toBe(
      "Zmh6rfhivXdsj8GLjp+OIAiXFIVu4jOzkCpZHQ1fKSUrMttsLApiNfsTl+giXqheDw5ujHsSbQAWzL3g5mcVHg==",
    );
  });

  it.each([
    ["bad seed", { seed: "AA", k: 1, g: 1 }],
    ["zero segment count", { seed: "A".repeat(43), k: 0, g: 1 }],
    ["zero work factor", { seed: "A".repeat(43), k: 1, g: 0 }],
    ["excessive work", { seed: "A".repeat(43), k: 8_001, g: 8_000 }],
  ])("rejects %s before work begins", async (_label, change) => {
    await expect(
      solveCloudflarePreviewChallenge({
        challengeToken: crypto.randomUUID(),
        ...change,
      }),
    ).rejects.toMatchObject({ code: "temporary_challenge_invalid" });
  });

  it("reports the exact trusted-backend prerequisite when no temporary-account broker is installed", async () => {
    const fixture = customerProviderFixture();
    await expect(
      fixture.provider.createTemporaryDeployment({
        termsOfService: "https://www.cloudflare.com/terms/",
        privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
        acceptTermsOfService: "yes",
        accountId,
        scriptName,
        revisionId,
        packageDigest,
        modules: [],
        staticAssets: [],
        bindings: [],
      }),
    ).rejects.toMatchObject({
      code: "temporary_accounts_backend_prerequisite",
    });
  });

  function temporaryRequest(overrides: Record<string, unknown> = {}) {
    return {
      operationId: "operation_a1",
      termsOfService: "https://www.cloudflare.com/terms/",
      privacyPolicy: "https://www.cloudflare.com/privacypolicy/",
      acceptTermsOfService: "yes",
      actorId: "user_a1",
      shipletId,
      targetId,
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      modules: [],
      staticAssets: [
        {
          path: "/index.html",
          mediaType: "text/html",
          content: "<h1>Temporary preview</h1>",
        },
      ],
      bindings: [],
      ...overrides,
    };
  }

  function temporaryBrokerFixture(
    overrides: Partial<CloudflareTemporaryAccountBroker> = {},
  ) {
    const temporaryAuthorizationHandle =
      createCloudflareOpaqueTemporaryAuthorizationHandle();
    const claimHandle = createCloudflareTemporaryClaimHandle();
    const providerDeploymentId = crypto.randomUUID();
    const providerVersionId = crypto.randomUUID();
    const broker = {
      createAndDeploy: vi.fn(async (input: Record<string, unknown>) => {
        const authorization = input.authorization as Record<string, unknown>;
        return {
          providerDeploymentId,
          providerVersionId,
          selectedVersionId: providerVersionId,
          temporaryAuthorizationHandle,
          claimHandle,
          binding: {
            userId: authorization.userId,
            shipletId: authorization.shipletId,
            targetId: authorization.targetId,
            accountHandle: authorization.accountHandle,
            scriptName: authorization.scriptName,
            revisionId: authorization.revisionId,
            packageDigest: authorization.packageDigest,
            requestDigest: authorization.requestDigest,
            operationId: authorization.operationId,
          },
          expiresAt: now + 30_000,
          serializedBodyBytes: 512,
        };
      }),
      cleanup: vi.fn(async (input: Record<string, unknown>) => {
        const authorization = input.authorization as Record<string, unknown>;
        const request = input.request as Record<string, unknown>;
        return {
          success: true,
          selectedVersionId: request.providerVersionId,
          binding: {
            userId: authorization.userId,
            shipletId: authorization.shipletId,
            targetId: authorization.targetId,
            accountHandle: authorization.accountHandle,
            scriptName: authorization.scriptName,
            revisionId: authorization.revisionId,
            packageDigest: authorization.packageDigest,
            requestDigest: authorization.requestDigest,
            operationId: authorization.operationId,
          },
          serializedBodyBytes: 128,
        };
      }),
      ...overrides,
    } as unknown as CloudflareTemporaryAccountBroker;
    const provider = runtimeDeploymentProvider({
      now: () => now,
      grants: customerProviderFixture().grants,
      temporaryAccounts: broker,
      trustedControlPlaneOrigin: "https://shiplet.invalid",
    });
    return {
      broker,
      provider,
      temporaryAuthorizationHandle,
      claimHandle,
      providerDeploymentId,
      providerVersionId,
    };
  }

  it("capability-binds a static temporary deployment and returns only opaque Shiplet handles", async () => {
    const fixture = temporaryBrokerFixture();
    const request = temporaryRequest();
    const result = await fixture.provider.createTemporaryDeployment(
      await temporaryEnvelope(
        request,
        "temporary.deployment.create",
        temporaryCreateScopes,
      ),
    );

    expect(result).toMatchObject({
      providerDeploymentId: fixture.providerDeploymentId,
      providerVersionId: fixture.providerVersionId,
      temporaryAuthorization: fixture.temporaryAuthorizationHandle,
      expiresAt: now + 30_000,
    });
    expect(result.claimUrl.origin + result.claimUrl.pathname).toBe(
      "https://shiplet.invalid/api/cloudflare/temporary/claim",
    );
    expect(result.claimUrl.searchParams.get("handle")).toBe(
      fixture.claimHandle,
    );
    expect(result.claimUrl.searchParams.has("claimToken")).toBe(false);

    const brokerInput = vi.mocked(fixture.broker.createAndDeploy).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(brokerInput.authorization).toMatchObject({
      userId: "user_a1",
      targetId,
      accountHandle: accountId,
      scriptName,
      revisionId,
      packageDigest,
      operation: "temporary.deployment.create",
      operationId: "operation_a1",
      requiredScopes: temporaryCreateScopes,
      expiresAt: now + 60_000,
    });
    expect(
      await digestCloudflareProviderRequest(brokerInput.canonicalRequest),
    ).toBe(
      (brokerInput.authorization as Record<string, unknown>).requestDigest,
    );
    expect(brokerInput.request).toMatchObject({
      accountHandle: accountId,
      scriptName,
      revisionId,
      packageDigest,
      staticAssets: request.staticAssets,
      serialization: {
        kind: "cloudflare_temporary_static_multipart",
        maxAssets: 1_000,
        maxDecodedAssetBytes: 5 * 1024 * 1024,
      },
    });
    expect(brokerInput.request).not.toHaveProperty("modules");
    expect(brokerInput.request).not.toHaveProperty("bindings");
  });

  it.each([
    [
      "claim expiry beyond 60 minutes",
      { expiresAt: now + 60 * 60 * 1_000 + 1 },
    ],
    ["weak claim handle", { claimHandle: "weak_handle" }],
    [
      "unregistered high-entropy-looking claim handle",
      { claimHandle: strongClaimHandle() },
    ],
    [
      "unregistered frozen empty authorization object",
      { temporaryAuthorizationHandle: opaqueCredential() },
    ],
  ] as const)("rejects a broker response with %s", async (_label, override) => {
    const fixture = temporaryBrokerFixture();
    const implementation = vi
      .mocked(fixture.broker.createAndDeploy)
      .getMockImplementation()!;
    vi.mocked(fixture.broker.createAndDeploy).mockImplementationOnce(
      async (input) => ({ ...(await implementation(input)), ...override }),
    );

    await expect(
      fixture.provider.createTemporaryDeployment(
        await temporaryEnvelope(
          temporaryRequest(),
          "temporary.deployment.create",
          temporaryCreateScopes,
        ),
      ),
    ).rejects.toMatchObject({ code: "temporary_provider_response_invalid" });
  });

  it.each([
    "https://elsewhere.invalid/api/cloudflare/temporary/claim",
    "https://shiplet.invalid/api/cloudflare/temporary/wrong",
  ])(
    "rejects a temporary claim redirect outside the exact trusted control-plane route: %s",
    (temporaryClaimRedirectBase) => {
      const fixture = temporaryBrokerFixture();
      expect(() =>
        runtimeDeploymentProvider({
          now: () => now,
          grants: customerProviderFixture().grants,
          temporaryAccounts: fixture.broker,
          temporaryClaimRedirectBase,
        }),
      ).toThrow("invalid_cloudflare_temporary_claim_redirect");
    },
  );

  it("rejects any altered temporary actor, target, account, script, revision, package, operation ID, operation, scope, expiry, or request digest", async () => {
    const fixture = temporaryBrokerFixture();
    const request = temporaryRequest();
    const valid = await temporaryEnvelope(
      request,
      "temporary.deployment.create",
      temporaryCreateScopes,
    );
    const candidates = [
      { ...valid, authorization: { ...valid.authorization, userId: "" } },
      {
        ...valid,
        authorization: { ...valid.authorization, shipletId: "shiplet_b1" },
      },
      {
        ...valid,
        authorization: { ...valid.authorization, targetId: "target_b1" },
      },
      {
        ...valid,
        authorization: { ...valid.authorization, accountId: "account_b1" },
      },
      {
        ...valid,
        authorization: { ...valid.authorization, scriptName: "shiplet-b" },
      },
      {
        ...valid,
        authorization: { ...valid.authorization, revisionId: "revision_b1" },
      },
      {
        ...valid,
        authorization: {
          ...valid.authorization,
          packageDigest: `sha256:${"b".repeat(64)}`,
        },
      },
      {
        ...valid,
        authorization: {
          ...valid.authorization,
          operationId: "operation_b1",
        },
      },
      {
        ...valid,
        authorization: {
          ...valid.authorization,
          operation: "temporary.deployment.cleanup",
        },
      },
      { ...valid, authorization: { ...valid.authorization, scopes: [] } },
      { ...valid, authorization: { ...valid.authorization, expiresAt: now } },
      {
        ...valid,
        authorization: {
          ...valid.authorization,
          requestDigest: packageDigest,
        },
      },
    ];

    for (const candidate of candidates) {
      await expect(
        fixture.provider.createTemporaryDeployment(candidate),
      ).rejects.toMatchObject({
        code: "temporary_deployment_authorization_invalid",
      });
    }
    expect(fixture.broker.createAndDeploy).not.toHaveBeenCalled();
  });

  it("keeps temporary execution static-only and validates bindings before the broker", async () => {
    const fixture = temporaryBrokerFixture();
    const dynamic = temporaryRequest({
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          content: "export default {};",
        },
      ],
    });
    const reserved = temporaryRequest({
      bindings: [
        { name: "SHARED_D1", kind: "d1", providerResourceId: "database_a1" },
      ],
    });

    for (const request of [dynamic, reserved]) {
      await expect(
        fixture.provider.createTemporaryDeployment(
          await temporaryEnvelope(
            request,
            "temporary.deployment.create",
            temporaryCreateScopes,
          ),
        ),
      ).rejects.toMatchObject({ code: "temporary_deployment_request_invalid" });
    }
    expect(fixture.broker.createAndDeploy).not.toHaveBeenCalled();
  });

  it("enforces the temporary account's current asset count, decoded size, and media-type limits", async () => {
    const fixture = temporaryBrokerFixture();
    const invalidRequests = [
      temporaryRequest({
        staticAssets: Array.from({ length: 1_001 }, (_, index) => ({
          path: `/asset-${index}.txt`,
          mediaType: "text/plain",
          content: "a",
        })),
      }),
      temporaryRequest({
        staticAssets: [
          {
            path: "/large.txt",
            mediaType: "text/plain",
            content: "a".repeat(5 * 1024 * 1024 + 1),
          },
        ],
      }),
      temporaryRequest({
        staticAssets: [
          {
            path: "/index.html",
            mediaType: "text/html; charset=utf-8\r\nx-invalid: value",
            content: "safe",
          },
        ],
      }),
      temporaryRequest({
        staticAssets: [
          {
            path: "/image.bin",
            mediaType: "application/octet-stream",
            content: "not-canonical-base64",
            encoding: "base64",
          },
        ],
      }),
    ];

    for (const request of invalidRequests) {
      await expect(
        fixture.provider.createTemporaryDeployment(
          await temporaryEnvelope(
            request,
            "temporary.deployment.create",
            temporaryCreateScopes,
          ),
        ),
      ).rejects.toMatchObject({ code: "temporary_deployment_request_invalid" });
    }
    expect(fixture.broker.createAndDeploy).not.toHaveBeenCalled();
  });

  it("enforces separate decoded-bundle and serialized-body bounds for temporary static uploads", async () => {
    const fixture = temporaryBrokerFixture();
    {
      const exactlyFiveDecodedMiB = "😀".repeat((5 * 1024 * 1024) / 4);
      const request = temporaryRequest({
        staticAssets: Array.from({ length: 11 }, (_, index) => ({
          path: `/bundle-${index}.txt`,
          mediaType: "text/plain",
          content: exactlyFiveDecodedMiB,
        })),
      });
      await expect(
        fixture.provider.createTemporaryDeployment(
          await temporaryEnvelope(
            request,
            "temporary.deployment.create",
            temporaryCreateScopes,
          ),
        ),
      ).rejects.toMatchObject({ code: "temporary_deployment_request_invalid" });
    }
    {
      const almostFiveDecodedMiB = "AAAA".repeat(1_747_626);
      const request = temporaryRequest({
        staticAssets: Array.from({ length: 10 }, (_, index) => ({
          path: `/body-${index}.bin`,
          mediaType: "application/octet-stream",
          content: almostFiveDecodedMiB,
          encoding: "base64",
        })),
      });
      await expect(
        fixture.provider.createTemporaryDeployment(
          await temporaryEnvelope(
            request,
            "temporary.deployment.create",
            temporaryCreateScopes,
          ),
        ),
      ).rejects.toMatchObject({ code: "temporary_deployment_request_invalid" });
    }
    expect(fixture.broker.createAndDeploy).not.toHaveBeenCalled();
  }, 15_000);

  it("capability-binds temporary cleanup to the exact revision, package, provider deployment, and selected version", async () => {
    const fixture = temporaryBrokerFixture();
    const request = {
      operationId: "operation_cleanup_a1",
      actorId: "user_a1",
      shipletId,
      targetId,
      accountId,
      scriptName,
      revisionId,
      packageDigest,
      providerDeploymentId: fixture.providerDeploymentId,
      providerVersionId: fixture.providerVersionId,
    };

    await expect(
      fixture.provider.cleanupTemporaryDeployment(
        await temporaryEnvelope(
          request,
          "temporary.deployment.cleanup",
          temporaryCleanupScopes,
        ),
      ),
    ).resolves.toBeUndefined();
    expect(fixture.broker.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          userId: "user_a1",
          shipletId,
          targetId,
          accountHandle: accountId,
          scriptName,
          revisionId,
          packageDigest,
          operationId: "operation_cleanup_a1",
          operation: "temporary.deployment.cleanup",
          requiredScopes: temporaryCleanupScopes,
        }),
        request: expect.objectContaining({
          providerDeploymentId: fixture.providerDeploymentId,
          providerVersionId: fixture.providerVersionId,
        }),
      }),
    );
  });

  it("rejects trusted claim redirect configuration containing a provider bearer parameter", () => {
    const fixture = temporaryBrokerFixture();
    const redirect = new URL(redirectUri("/api/cloudflare/temporary/claim"));
    redirect.searchParams.set(["claim", "Token"].join(""), "");
    expect(() =>
      runtimeDeploymentProvider({
        now: () => now,
        grants: customerProviderFixture().grants,
        temporaryAccounts: fixture.broker,
        temporaryClaimRedirectBase: redirect.toString(),
      }),
    ).toThrow("invalid_cloudflare_temporary_claim_redirect");
  });
});
