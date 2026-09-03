import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import app, { reviewCapabilitySecret } from "../src/index";
import {
  createReviewCapabilityToken,
  verifyReviewCapabilityToken,
} from "../src/review";

interface TestEnv {
  DB: D1Database;
  SHIPLET_ASSETS: R2Bucket;
  REVIEW_ASSETS: R2Bucket;
  SANDBOX_SESSION: DurableObjectNamespace;
  dispatcher: {
    get: (name: string) => { fetch: (req: Request) => Promise<Response> };
  };
  DISPATCH_NAMESPACE_NAME: string;
  CUSTOM_DOMAIN: string;
  SHIPLET_APP_URL?: string;
  SHIPLET_REVIEW_TOKEN_SECRET?: string;
  WORKOS_API_KEY?: string;
  SHIPLET_BOOTSTRAP_TOKEN?: string;
  SHIPLET_AUTH_MODE: "workos" | "test";
  SHIPLET_ENABLED_FEATURE_FLAGS?: string;
}

const AUTH_HEADERS = {
  "x-shiplet-user-id": "user_test",
  "x-shiplet-user-email": "test@example.com",
};

async function requestHelper(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const requestUrl = /^https?:\/\//.test(path)
    ? path
    : `http://localhost${path}`;
  const request = new Request(requestUrl, options);
  const ctx = createExecutionContext();
  let response: Response;
  try {
    response = await app.fetch(request, env as unknown as TestEnv, ctx);
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    response = error;
  }
  await waitOnExecutionContext(ctx);
  return response;
}

async function withCustomDomain<T>(domain: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as TestEnv;
  const previous = testEnv.CUSTOM_DOMAIN;
  testEnv.CUSTOM_DOMAIN = domain;
  try {
    return await callback();
  } finally {
    testEnv.CUSTOM_DOMAIN = previous;
  }
}

async function withAppUrl<T>(url: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as TestEnv;
  const previous = testEnv.SHIPLET_APP_URL;
  testEnv.SHIPLET_APP_URL = url;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_APP_URL = previous;
  }
}

async function withFeatureFlags<T>(flags: string, callback: () => Promise<T>) {
  const testEnv = env as unknown as TestEnv;
  const previous = testEnv.SHIPLET_ENABLED_FEATURE_FLAGS;
  testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = flags;
  try {
    return await callback();
  } finally {
    testEnv.SHIPLET_ENABLED_FEATURE_FLAGS = previous;
  }
}

async function withReviewSigningEnv<T>(
  overrides: Partial<
    Pick<
      TestEnv,
      | "SHIPLET_AUTH_MODE"
      | "SHIPLET_REVIEW_TOKEN_SECRET"
      | "WORKOS_API_KEY"
      | "SHIPLET_BOOTSTRAP_TOKEN"
    >
  >,
  callback: () => Promise<T>,
) {
  const testEnv = env as unknown as TestEnv;
  const previous = {
    SHIPLET_AUTH_MODE: testEnv.SHIPLET_AUTH_MODE,
    SHIPLET_REVIEW_TOKEN_SECRET: testEnv.SHIPLET_REVIEW_TOKEN_SECRET,
    WORKOS_API_KEY: testEnv.WORKOS_API_KEY,
    SHIPLET_BOOTSTRAP_TOKEN: testEnv.SHIPLET_BOOTSTRAP_TOKEN,
  };
  Object.assign(testEnv, overrides);
  try {
    return await callback();
  } finally {
    Object.assign(testEnv, previous);
  }
}

function setCookieHeader(response: Response) {
  return response.headers.get("set-cookie") || "";
}

function cookieValue(setCookie: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    setCookie.match(new RegExp(`(?:^|,\\s*)${escaped}=([^;,]+)`))?.[1] || ""
  );
}

function cookieHeaderFromSetCookie(setCookie: string) {
  const cookies = new Map<string, string>();
  for (const name of [
    "__Host-shiplet_session",
    "__Host-shiplet_account_group",
    "__Host-shiplet_artifact_access",
    "shiplet_session",
    "shiplet_account_group",
    "shiplet_artifact_access",
  ]) {
    const value = cookieValue(setCookie, name);
    if (value) cookies.set(name, value);
  }
  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function hiddenInput(html: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(
    new RegExp(`<input[^>]+name="${escapedName}"[^>]+value="([^"]*)"`),
  )?.[1];
}

async function bootstrapRestrictedInvitation(email: string) {
  const response = await requestHelper(
    "https://app.shiplet.cc/api/bootstrap/production-test",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-bootstrap-token",
        Origin: "https://app.shiplet.cc",
      },
      body: JSON.stringify({ email }),
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    organization: { id: string; name: string };
    project: { id: string; name: string; subdomain: string };
    invitation: { id: string };
    shipletUrl: string;
  };
}

async function startRestrictedInvitationConsent(returnTo: string) {
  const loginUrl = new URL("https://app.shiplet.cc/auth/login");
  loginUrl.searchParams.set("return_to", returnTo);
  const consentPage = await requestHelper(loginUrl.toString(), {
    redirect: "manual",
  });
  expect(consentPage.status).toBe(200);
  const html = await consentPage.text();
  const state = await submitRestrictedInvitationConsent(html);
  return { html, state };
}

async function submitRestrictedInvitationConsent(html: string) {
  const consentToken = hiddenInput(html, "consent_token");
  expect(consentToken).toBeTruthy();

  const beginAuth = await requestHelper("https://app.shiplet.cc/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://app.shiplet.cc",
    },
    body: new URLSearchParams({ consent_token: consentToken! }),
    redirect: "manual",
  });
  expect(beginAuth.status).toBe(302);
  const authorizationUrl = new URL(beginAuth.headers.get("location") || "");
  const state = authorizationUrl.searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

function reviewCapabilitySecretForTest() {
  const testEnv = env as unknown as TestEnv;
  return (
    testEnv.SHIPLET_REVIEW_TOKEN_SECRET ||
    "shiplet-test-review-capability-secret"
  );
}

async function createOrganization(cookie: string) {
  const response = await requestHelper("https://shiplet.cc/api/organizations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: "https://shiplet.cc",
    },
    body: JSON.stringify({ name: `Security ${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    organization: { id: string; name: string };
  };
}

async function publishShiplet(
  organizationId: string,
  options: {
    cookie?: string;
    authHeaders?: HeadersInit;
    body?: Record<string, unknown>;
  },
) {
  const subdomain =
    typeof options.body?.subdomain === "string"
      ? options.body.subdomain
      : `secure-${crypto.randomUUID().slice(0, 8)}`;
  const response = await requestHelper("https://shiplet.cc/projects", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.cookie
        ? { Cookie: options.cookie, Origin: "https://shiplet.cc" }
        : {}),
      ...(options.authHeaders || {}),
    },
    body: JSON.stringify({
      name: `Security Shiplet ${crypto.randomUUID().slice(0, 8)}`,
      organization_id: organizationId,
      subdomain,
      assets: [
        {
          path: "index.html",
          content: btoa("<!doctype html><h1>Security artifact</h1>"),
          size: 45,
        },
      ],
      ...(options.body || {}),
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: { id: string; subdomain: string; organization_id: string };
    previewUrl: string;
  };
}

describe("artifact and app security model", () => {
  it("never reuses WorkOS configuration as review signing authority", () => {
    const isolatedEnv = {
      SHIPLET_AUTH_MODE: "workos",
      WORKOS_API_KEY: String.fromCharCode(120),
    } as unknown as Env;
    let failure: unknown;
    try {
      reviewCapabilitySecret(isolatedEnv);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Response);
    expect((failure as Response).status).toBe(500);
  });
  it("sets host-only platform cookies and clears legacy domain cookies", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://shiplet.cc", async () => {
        await withFeatureFlags("account-email-switching", async () => {
          const response = await requestHelper(
            "https://shiplet.cc/auth/callback?code=test-code%3A%3Acookie%2540example.com",
            { redirect: "manual" },
          );
          const setCookie = setCookieHeader(response);

          expect(response.status).toBe(302);
          expect(setCookie).toContain("__Host-shiplet_session=");
          expect(setCookie).toContain("__Host-shiplet_account_group=");
          expect(setCookie).not.toMatch(/__Host-shiplet_session=[^,]*Domain=/i);
          expect(setCookie).not.toMatch(
            /__Host-shiplet_account_group=[^,]*Domain=/i,
          );
          expect(setCookie).toContain("shiplet_session=;");
          expect(setCookie).toContain("shiplet_account_group=;");
          expect(setCookie).toMatch(
            /shiplet_session=[^,]*Max-Age=0[^,]*Domain=shiplet\.cc/i,
          );
          expect(setCookie).toMatch(
            /shiplet_account_group=[^,]*Max-Age=0[^,]*Domain=shiplet\.cc/i,
          );
        });
      });
    });
  });

  it("keeps local Wrangler session cookies usable when routes rewrite request hosts", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("http://localhost:8787", async () => {
        const response = await requestHelper(
          "http://shiplet.cc/auth/callback?code=test-code%3A%3Alocal%2540example.com",
          { redirect: "manual" },
        );
        const setCookie = setCookieHeader(response);
        const cookie = cookieHeaderFromSetCookie(setCookie);

        expect(response.status).toBe(302);
        expect(setCookie).toContain("shiplet_session=");
        expect(setCookie).not.toContain("__Host-shiplet_session=");
        expect(setCookie).not.toContain("Secure");

        const me = await requestHelper("http://shiplet.cc/api/me", {
          headers: { Cookie: cookie },
        });
        expect(me.status).toBe(200);
        await expect(me.json()).resolves.toMatchObject({
          authenticated: true,
          user: { email: "local@example.com" },
        });

        const mutation = await requestHelper(
          "http://shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookie,
              Origin: "http://shiplet.cc",
            },
            body: JSON.stringify({ name: `Local ${crypto.randomUUID()}` }),
          },
        );
        expect(mutation.status).toBe(201);
      });
    });
  });

  it("authenticates dashboard requests but not legacy or project-origin session cookies", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://shiplet.cc", async () => {
        const callback = await requestHelper(
          "https://shiplet.cc/auth/callback?code=test-code%3A%3Asecure%2540example.com",
          { redirect: "manual" },
        );
        const setCookie = setCookieHeader(callback);
        const cookie = cookieHeaderFromSetCookie(setCookie);
        const sessionId = cookieValue(setCookie, "__Host-shiplet_session");
        const organization = await createOrganization(cookie);
        const { project } = await publishShiplet(organization.organization.id, {
          cookie,
        });

        const dashboard = await requestHelper(
          "https://shiplet.cc/api/dashboard",
          {
            headers: { Cookie: cookie },
          },
        );
        expect(dashboard.status).toBe(200);

        const legacyDashboard = await requestHelper(
          "https://shiplet.cc/api/dashboard",
          {
            headers: { Cookie: `shiplet_session=${sessionId}` },
          },
        );
        expect(legacyDashboard.status).toBe(401);

        const projectOrigin = await requestHelper(
          `https://${project.subdomain}.shiplet.cc/`,
          {
            headers: { Cookie: cookie },
            redirect: "manual",
          },
        );
        expect(projectOrigin.status).toBe(302);
        const projectLoginUrl = new URL(projectOrigin.headers.get("location")!);
        const projectAccessGate = new URL(
          projectLoginUrl.searchParams.get("return_to")!,
        );
        expect(projectAccessGate.origin).toBe("https://shiplet.cc");
        expect(projectAccessGate.pathname).toBe(
          `/shiplets/${project.id}/access`,
        );
        expect(projectAccessGate.searchParams.get("return_to")).toBe(
          `https://${project.subdomain}.shiplet.cc/`,
        );
      });
    });
  });

  it("routes the configured app subdomain as the control plane", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const response = await requestHelper("https://app.shiplet.cc/", {
          headers: AUTH_HEADERS,
        });
        const html = await response.text();

        expect(response.status).toBe(200);
        expect(html).toContain("Create a shiplet");
      });
    });
  });

  it("does not serve path-tenant artifacts from a production app host without project domains", async () => {
    await withCustomDomain("", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const organizationResponse = await requestHelper(
          "https://app.shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({ name: `Path Guard ${crypto.randomUUID()}` }),
          },
        );
        expect(organizationResponse.status).toBe(201);
        const organization = (await organizationResponse.json()) as {
          organization: { id: string };
        };
        const { project } = await publishShiplet(organization.organization.id, {
          authHeaders: AUTH_HEADERS,
        });

        const appHostArtifact = await requestHelper(
          `https://app.shiplet.cc/${project.subdomain}/`,
          { headers: AUTH_HEADERS },
        );
        expect(appHostArtifact.status).toBe(404);
        expect(appHostArtifact.headers.get("x-shiplet-review")).toBeNull();
        await expect(appHostArtifact.text()).resolves.not.toContain(
          "Security artifact",
        );

        const localFallbackArtifact = await requestHelper(
          `http://localhost/${project.subdomain}/`,
          { headers: AUTH_HEADERS },
        );
        expect(localFallbackArtifact.status).toBe(200);
        await expect(localFallbackArtifact.text()).resolves.toContain(
          'data-shiplet-trusted-review-host="v1"',
        );
        const localRawArtifact = await requestHelper(
          `http://localhost/${project.subdomain}/__shiplet/artifact-frame/`,
          { headers: AUTH_HEADERS },
        );
        await expect(localRawArtifact.text()).resolves.toContain(
          "Security artifact",
        );
      });
    });
  });

  it("keeps path-tenant fallback on a local configured app host", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("http://localhost:8787", async () => {
        const organizationResponse = await requestHelper(
          "http://localhost:8787/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
              Origin: "http://localhost:8787",
            },
            body: JSON.stringify({ name: `Local Path ${crypto.randomUUID()}` }),
          },
        );
        expect(organizationResponse.status).toBe(201);
        const organization = (await organizationResponse.json()) as {
          organization: { id: string };
        };
        const { project } = await publishShiplet(organization.organization.id, {
          authHeaders: AUTH_HEADERS,
        });

        const localFallbackArtifact = await requestHelper(
          `http://localhost:8787/${project.subdomain}/`,
          { headers: AUTH_HEADERS },
        );
        expect(localFallbackArtifact.status).toBe(200);
        const localFallbackHtml = await localFallbackArtifact.text();
        expect(localFallbackHtml).toContain(
          'data-shiplet-trusted-review-host="v1"',
        );
        const localWidgetUrl = localFallbackHtml.match(
          /<iframe[^>]+data-shiplet-widget-frame="v1"[^>]+src="([^"]+)"/,
        )?.[1];
        expect(localWidgetUrl).toBeTruthy();
        const localWidget = await requestHelper(localWidgetUrl!, {
          headers: AUTH_HEADERS,
        });
        expect(localWidget.status).toBe(200);
        expect(localWidget.headers.get("content-security-policy")).toContain(
          "frame-ancestors http://localhost:8787",
        );
        const localRawArtifact = await requestHelper(
          `http://localhost:8787/${project.subdomain}/__shiplet/artifact-frame/`,
          { headers: AUTH_HEADERS },
        );
        await expect(localRawArtifact.text()).resolves.toContain(
          "Security artifact",
        );
      });
    });
  });

  it("loads dashboard previews through the trusted host without exposing project access", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const organizationResponse = await requestHelper(
          "https://app.shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({
              name: `Project Origin ${crypto.randomUUID()}`,
            }),
          },
        );
        expect(organizationResponse.status).toBe(201);
        const organization = (await organizationResponse.json()) as {
          organization: { id: string };
        };
        const subdomain = `origin-${crypto.randomUUID().slice(0, 8)}`;
        const publishResponse = await requestHelper(
          "https://app.shiplet.cc/projects",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({
              name: "Project Origin Preview",
              organization_id: organization.organization.id,
              subdomain,
              assets: [
                {
                  path: "index.html",
                  content: btoa(
                    '<!doctype html><link rel="stylesheet" href="/styles/site.css"><h1>Project origin preview</h1>',
                  ),
                  size: 101,
                },
                {
                  path: "styles/site.css",
                  content: btoa("h1 { color: navy; }"),
                  size: 19,
                },
              ],
            }),
          },
        );
        expect(publishResponse.status).toBe(201);
        const publishBody = (await publishResponse.json()) as {
          project: { id: string; subdomain: string };
        };

        const detail = await requestHelper(
          `https://app.shiplet.cc/shiplets/${publishBody.project.id}`,
          { headers: AUTH_HEADERS },
        );
        expect(detail.status).toBe(200);
        const detailHtml = await detail.text();
        const frameSrc = detailHtml.match(
          /<iframe[^>]+id="artifactPreviewFrame"[^>]+src="([^"]+)"/,
        )?.[1];
        expect(frameSrc).toBeTruthy();
        expect(frameSrc).toBe(
          `/shiplets/${publishBody.project.id}/review-host`,
        );
        expect(frameSrc).not.toContain("shiplet_preview_token=");
        const trustedHost = await requestHelper(
          `https://app.shiplet.cc${frameSrc}`,
          { headers: AUTH_HEADERS },
        );
        expect(trustedHost.status).toBe(200);
        const trustedHostCookie = setCookieHeader(trustedHost);
        expect(trustedHostCookie).toContain("__Host-shiplet_artifact_access=");
        expect(trustedHostCookie).toContain("HttpOnly");
        expect(trustedHostCookie).toContain("Secure");
        expect(trustedHostCookie).toContain("SameSite=None");
        expect(trustedHostCookie).toContain("Max-Age=300");
        const trustedHostCapability = decodeURIComponent(
          cookieHeaderFromSetCookie(trustedHostCookie).split("=", 2)[1] || "",
        );
        await expect(
          verifyReviewCapabilityToken(trustedHostCapability, {
            secret: reviewCapabilitySecretForTest(),
            projectId: publishBody.project.id,
            requiredScopes: [
              "feedback:read",
              "feedback:write",
              "presence:join",
              "watch:write",
            ],
          }),
        ).resolves.toMatchObject({ ok: true });
        const trustedHostHtml = await trustedHost.text();
        expect(trustedHostHtml).toContain(
          `/shiplets/${publishBody.project.id}/artifact-frame/`,
        );
        expect(trustedHostHtml).not.toContain("shiplet_preview_token=");
        expect(trustedHostHtml).not.toMatch(/shiplet_review_cap_v1\./);

        const previewToken = await createReviewCapabilityToken({
          secret: reviewCapabilitySecretForTest(),
          projectId: publishBody.project.id,
          viewer: {
            id: "user_test",
            email: "test@example.com",
            name: "Test reviewer",
          },
          scopes: [
            "feedback:read",
            "feedback:write",
            "presence:join",
            "watch:write",
          ],
          expiresInSeconds: 5 * 60,
        });
        expect(previewToken).toMatch(/^shiplet_review_cap_v1\./);
        await expect(
          verifyReviewCapabilityToken(previewToken!, {
            secret: reviewCapabilitySecretForTest(),
            projectId: publishBody.project.id,
            requiredScopes: ["presence:join"],
          }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          verifyReviewCapabilityToken(previewToken!, {
            secret: reviewCapabilitySecretForTest(),
            projectId: publishBody.project.id,
            requiredScopes: ["feedback:write"],
          }),
        ).resolves.toMatchObject({ ok: true });

        const legacyPreview = await requestHelper(
          `https://app.shiplet.cc/shiplets/${publishBody.project.id}/preview`,
          { headers: AUTH_HEADERS, redirect: "manual" },
        );
        expect(legacyPreview.status).toBe(302);
        expect(legacyPreview.headers.get("location")).toBe(
          `/shiplets/${publishBody.project.id}/review-host`,
        );

        const bareProjectOrigin = await requestHelper(
          `https://${publishBody.project.subdomain}.shiplet.cc/`,
          { redirect: "manual" },
        );
        expect(bareProjectOrigin.status).toBe(302);
        expect(bareProjectOrigin.headers.get("location")).toContain(
          "https://app.shiplet.cc/auth/login",
        );

        const signedProjectUrl = new URL(
          `https://${publishBody.project.subdomain}.shiplet.cc/`,
        );
        signedProjectUrl.searchParams.set(
          "shiplet_preview_token",
          previewToken,
        );
        const signedProjectOrigin = await requestHelper(
          signedProjectUrl.toString(),
          {
            redirect: "manual",
          },
        );
        expect(signedProjectOrigin.status).toBe(302);
        const cleanProjectUrl = signedProjectOrigin.headers.get("location");
        expect(cleanProjectUrl).toBe(
          `https://${publishBody.project.subdomain}.shiplet.cc/`,
        );
        const artifactCookie = cookieHeaderFromSetCookie(
          setCookieHeader(signedProjectOrigin),
        );
        expect(artifactCookie).toContain("__Host-shiplet_artifact_access=");

        const cleanProjectOrigin = await requestHelper(cleanProjectUrl!, {
          headers: { Cookie: artifactCookie },
        });
        expect(cleanProjectOrigin.status).toBe(200);
        expect(cleanProjectOrigin.headers.get("x-shiplet-review")).toBeNull();
        const signedHtml = await cleanProjectOrigin.text();
        expect(signedHtml).toContain('data-shiplet-trusted-review-host="v1"');
        expect(signedHtml).toContain("Project Origin Preview");
        expect(signedHtml).not.toContain("__SHIPLET_REVIEW__");
        expect(signedHtml).not.toMatch(/shiplet_review_cap_v1\./);
        expect(signedHtml).toContain("/api/review/host.js");
        expect(signedHtml).toContain(
          `data-review-api-url="https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/review/feedback"`,
        );
        const tenantWidgetPath = signedHtml.match(
          /<iframe[^>]+data-shiplet-widget-frame="v1"[^>]+src="([^"]+)"/,
        )?.[1];
        expect(tenantWidgetPath).toBeTruthy();
        const tenantWidget = await requestHelper(tenantWidgetPath!, {
          headers: { Cookie: artifactCookie },
        });
        expect(tenantWidget.status).toBe(200);
        expect(tenantWidget.headers.get("content-security-policy")).toContain(
          `frame-ancestors https://${publishBody.project.subdomain}.shiplet.cc`,
        );
        const tenantFeedback = await requestHelper(
          `https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/review/feedback`,
          { headers: { Cookie: artifactCookie } },
        );
        expect(tenantFeedback.status).toBe(200);
        expect(tenantFeedback.headers.get("content-type")).toContain(
          "application/json",
        );
        const tenantCreate = await requestHelper(
          `https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/review/feedback`,
          {
            method: "POST",
            headers: {
              Cookie: artifactCookie,
              "Content-Type": "application/json",
              Origin: `https://${publishBody.project.subdomain}.shiplet.cc`,
            },
            body: JSON.stringify({
              comment: "Tenant trusted-host feedback.",
              pageUrl: `https://${publishBody.project.subdomain}.shiplet.cc/`,
              clientFeedbackId: `client-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
            }),
          },
        );
        expect(tenantCreate.status).toBe(201);
        const tenantCreated = (await tenantCreate.json()) as {
          feedback: { submitted_by_user_id: string };
        };
        expect(tenantCreated.feedback.submitted_by_user_id).toBe("user_test");
        const rawArtifactUrl = `https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/`;
        const rawArtifact = await requestHelper(rawArtifactUrl, {
          headers: { Cookie: artifactCookie },
        });
        expect(rawArtifact.status).toBe(200);
        expect(await rawArtifact.text()).toContain("Project origin preview");
        expect(rawArtifact.headers.get("content-security-policy")).toContain(
          "sandbox allow-scripts",
        );

        const expiredQueryToken = await createReviewCapabilityToken({
          secret: reviewCapabilitySecretForTest(),
          projectId: publishBody.project.id,
          viewer: {
            id: "user_test",
            email: "test@example.com",
            name: "Test reviewer",
          },
          scopes: ["presence:join"],
          expiresInSeconds: 60,
          now: new Date("2020-01-01T00:00:00.000Z"),
        });
        const staleProjectUrl = new URL(cleanProjectUrl!);
        staleProjectUrl.pathname = "/__shiplet/artifact-frame/styles/site.css";
        staleProjectUrl.searchParams.set("mode", "review");
        staleProjectUrl.searchParams.set(
          "shiplet_preview_token",
          expiredQueryToken,
        );
        const staleQueryResponse = await requestHelper(
          staleProjectUrl.toString(),
          {
            headers: { Cookie: artifactCookie },
            redirect: "manual",
          },
        );
        expect(staleQueryResponse.status).toBe(302);
        expect(staleQueryResponse.headers.get("location")).toBe(
          `https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/styles/site.css?mode=review`,
        );
        const expiredCookieResponse = await requestHelper(
          staleQueryResponse.headers.get("location")!,
          {
            headers: {
              Cookie: `__Host-shiplet_artifact_access=${encodeURIComponent(expiredQueryToken)}`,
            },
            redirect: "manual",
          },
        );
        expect(expiredCookieResponse.status).toBe(302);
        const expiredCookieLogin = new URL(
          expiredCookieResponse.headers.get("location")!,
        );
        expect(expiredCookieLogin.origin).toBe("https://app.shiplet.cc");
        expect(expiredCookieLogin.pathname).toBe("/auth/login");
        const expiredAccessGate = new URL(
          expiredCookieLogin.searchParams.get("return_to")!,
        );
        expect(expiredAccessGate.pathname).toBe(
          `/shiplets/${publishBody.project.id}/access`,
        );
        expect(expiredAccessGate.searchParams.get("return_to")).toBe(
          staleQueryResponse.headers.get("location"),
        );
        const recoveredProjectOrigin = await requestHelper(
          staleQueryResponse.headers.get("location")!,
          { headers: { Cookie: artifactCookie } },
        );
        expect(recoveredProjectOrigin.status).toBe(200);
        expect(await recoveredProjectOrigin.text()).toContain("color: navy");

        const linkedAsset = await requestHelper(
          `https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/styles/site.css`,
          { headers: { Cookie: artifactCookie }, redirect: "manual" },
        );
        expect(linkedAsset.status).toBe(200);
        expect(await linkedAsset.text()).toContain("color: navy");

        const testEnv = env as unknown as TestEnv;
        const previousDispatcher = testEnv.dispatcher;
        const workerProjectId = `project_${crypto.randomUUID().replace(/-/g, "")}`;
        const workerSubdomain = `worker-${crypto.randomUUID().slice(0, 8)}`;
        const createdOn = new Date().toISOString();
        await testEnv.DB.prepare(
          `INSERT INTO projects
					 (id, organization_id, owner_user_id, name, subdomain, source_type,
					  script_content, visibility, created_on, modified_on)
					 VALUES (?, ?, ?, ?, ?, 'worker', ?, 'public', ?, ?)`,
        )
          .bind(
            workerProjectId,
            organization.organization.id,
            "user_test",
            "Credential stripping Worker",
            workerSubdomain,
            "export default { fetch() { return new Response('ok') } }",
            createdOn,
            createdOn,
          )
          .run();
        let forwardedCookie = "not-called";
        let forwardedAuthorization = "not-called";
        testEnv.dispatcher = {
          get: () => ({
            fetch: async (request: Request) => {
              forwardedCookie = request.headers.get("cookie") || "";
              forwardedAuthorization =
                request.headers.get("authorization") || "";
              return new Response("h1 { color: navy; }", {
                headers: { "content-type": "text/css" },
              });
            },
          }),
        };
        try {
          const tenantWorkerAsset = await requestHelper(
            `https://${workerSubdomain}.shiplet.cc/__shiplet/artifact-frame/styles/site.css`,
            {
              headers: {
                Cookie: `${artifactCookie}; __Host-shiplet_session=platform-session; __Host-shiplet_account_group=platform-account; shiplet_session=legacy-session; shiplet_account_group=legacy-account; tenant_cookie=preserved`,
                Authorization: "Bearer platform-authorization",
              },
            },
          );
          expect(tenantWorkerAsset.status).toBe(503);
          expect(
            tenantWorkerAsset.headers.get("x-shiplet-runtime-status"),
          ).toBe("managed_dynamic_unavailable");
          expect(forwardedCookie).toBe("not-called");
          expect(forwardedAuthorization).toBe("not-called");
        } finally {
          testEnv.dispatcher = previousDispatcher;
        }
      });
    });
  });

  it("does not forward dashboard preview access tokens to external origins", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const organizationResponse = await requestHelper(
          "https://app.shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({
              name: `External Origin ${crypto.randomUUID()}`,
            }),
          },
        );
        expect(organizationResponse.status).toBe(201);
        const organization = (await organizationResponse.json()) as {
          organization: { id: string };
        };
        const subdomain = `external-origin-${crypto.randomUUID().slice(0, 8)}`;
        const originRequests: string[] = [];
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          originRequests.push(url);
          return new Response(
            "<!doctype html><body><h1>External project origin</h1></body>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        });

        try {
          const publishResponse = await requestHelper(
            "https://app.shiplet.cc/projects",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...AUTH_HEADERS,
                Origin: "https://app.shiplet.cc",
              },
              body: JSON.stringify({
                name: "External Project Origin",
                organization_id: organization.organization.id,
                subdomain,
                external_url: "https://preview.example.com/root",
              }),
            },
          );
          expect(publishResponse.status).toBe(201);
          const publishBody = (await publishResponse.json()) as {
            project: { id: string; subdomain: string };
          };
          const detail = await requestHelper(
            `https://app.shiplet.cc/shiplets/${publishBody.project.id}`,
            { headers: AUTH_HEADERS },
          );
          const detailHtml = await detail.text();
          const frameSrc = detailHtml.match(
            /<iframe[^>]+id="artifactPreviewFrame"[^>]+src="([^"]+)"/,
          )?.[1];
          expect(frameSrc).toBe(
            `/shiplets/${publishBody.project.id}/review-host`,
          );
          expect(frameSrc).not.toContain("shiplet_preview_token=");

          const cleanProjectOrigin = await requestHelper(
            `https://app.shiplet.cc${frameSrc}`,
            { headers: AUTH_HEADERS },
          );
          expect(cleanProjectOrigin.status).toBe(200);
          expect(await cleanProjectOrigin.text()).toContain(
            'data-shiplet-trusted-review-host="v1"',
          );
          const rawExternal = await requestHelper(
            `https://app.shiplet.cc/shiplets/${publishBody.project.id}/artifact-frame/`,
            { redirect: "manual" },
          );
          expect(rawExternal.status).toBe(200);
          expect(await rawExternal.text()).toContain("External project origin");
          expect(originRequests).toContain("https://preview.example.com/root");
          expect(
            originRequests.some((url) => url.includes("shiplet_preview_token")),
          ).toBe(false);
        } finally {
          vi.stubGlobal("fetch", originalFetch);
        }
      });
    });
  });

  it("serves the trusted review host separately from an opaque artifact frame without ambient credentials", async () => {
    const organizationResponse = await requestHelper(
      "https://shiplet.cc/api/organizations",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ name: `Trusted host ${crypto.randomUUID()}` }),
      },
    );
    expect(organizationResponse.status).toBe(201);
    const organization = (await organizationResponse.json()) as {
      organization: { id: string };
    };
    const { project } = await publishShiplet(organization.organization.id, {
      authHeaders: AUTH_HEADERS,
    });

    const host = await requestHelper(
      `https://shiplet.cc/shiplets/${project.id}/review-host`,
      { headers: AUTH_HEADERS },
    );
    expect(host.status).toBe(200);
    const hostHtml = await host.text();
    expect(hostHtml).toContain('data-shiplet-trusted-review-host="v1"');
    expect(hostHtml).toContain(
      `src="https://shiplet.cc/shiplets/${project.id}/artifact-frame/"`,
    );
    expect(hostHtml).toContain('sandbox="allow-scripts');
    expect(hostHtml).not.toContain("allow-same-origin");
    expect(hostHtml).not.toContain("__SHIPLET_REVIEW__");
    expect(hostHtml).not.toContain("reviewToken");
    expect(hostHtml).not.toMatch(/shiplet_review_cap_v1\./);

    const frame = await requestHelper(
      `https://shiplet.cc/shiplets/${project.id}/artifact-frame/`,
      { headers: AUTH_HEADERS },
    );
    expect(frame.status).toBe(200);
    expect(await frame.text()).toContain("Security artifact");
    expect(frame.headers.get("content-security-policy")).toContain(
      "sandbox allow-scripts",
    );
    expect(
      frame.headers
        .get("content-security-policy")
        ?.split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("connect-src ")),
    ).toBe("connect-src https://shiplet.cc");
    expect(frame.headers.get("x-shiplet-review")).toBeNull();

    const anonymousFrame = await requestHelper(
      `https://shiplet.cc/shiplets/${project.id}/artifact-frame/`,
      { redirect: "manual" },
    );
    expect(anonymousFrame.status).toBe(302);
    expect(anonymousFrame.headers.get("location")).toContain("/auth/login");
  });

  it("converts project-origin login returns into signed project-origin preview URLs", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const reviewerHeaders = {
          "x-shiplet-user-id": "user_project-return-example-com",
          "x-shiplet-user-email": "project-return@example.com",
        };
        const organizationResponse = await requestHelper(
          "https://app.shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...reviewerHeaders,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({
              name: `Return Flow ${crypto.randomUUID()}`,
            }),
          },
        );
        expect(organizationResponse.status).toBe(201);
        const organization = (await organizationResponse.json()) as {
          organization: { id: string };
        };
        const subdomain = `return-${crypto.randomUUID().slice(0, 8)}`;
        const publishResponse = await requestHelper(
          "https://app.shiplet.cc/projects",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...reviewerHeaders,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({
              name: "Return Flow Preview",
              organization_id: organization.organization.id,
              subdomain,
              assets: [
                {
                  path: "docs/index.html",
                  content: btoa("<!doctype html><h1>Return flow preview</h1>"),
                  size: 50,
                },
              ],
            }),
          },
        );
        expect(publishResponse.status).toBe(201);
        const publishBody = (await publishResponse.json()) as {
          project: { id: string; subdomain: string };
        };
        const returnTo = `https://${publishBody.project.subdomain}.shiplet.cc/docs/?mode=review`;
        const state = btoa(JSON.stringify({ returnTo }));
        const callback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            "test-code::project-return@example.com",
          )}&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(callback.status).toBe(302);
        const location = callback.headers.get("location") || "";
        expect(location).toContain(
          `https://${publishBody.project.subdomain}.shiplet.cc/docs/`,
        );
        expect(location).toContain("mode=review");
        expect(location).toContain("shiplet_preview_token=");
        expect(callback.headers.get("set-cookie")).toContain(
          "__Host-shiplet_session=",
        );

        const signedProjectOrigin = await requestHelper(location, {
          redirect: "manual",
        });
        expect(signedProjectOrigin.status).toBe(302);
        const cleanProjectOrigin = await requestHelper(
          signedProjectOrigin.headers.get("location")!,
          {
            headers: {
              Cookie: cookieHeaderFromSetCookie(
                setCookieHeader(signedProjectOrigin),
              ),
            },
          },
        );
        expect(cleanProjectOrigin.status).toBe(200);
        const html = await cleanProjectOrigin.text();
        expect(html).toContain('data-shiplet-trusted-review-host="v1"');
        expect(html).not.toContain("__SHIPLET_REVIEW__");
        const rawDocs = await requestHelper(
          `https://${publishBody.project.subdomain}.shiplet.cc/__shiplet/artifact-frame/docs/`,
          {
            headers: {
              Cookie: cookieHeaderFromSetCookie(
                setCookieHeader(signedProjectOrigin),
              ),
            },
          },
        );
        expect(await rawDocs.text()).toContain("Return flow preview");
      });
    });
  });

  it("Given an access-gate reviewer cookie, When tenant and hostile origins attempt review mutations, Then only exact-origin application/json requests can create human effects", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const organizationResponse = await requestHelper(
          "https://app.shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...AUTH_HEADERS,
              Origin: "https://app.shiplet.cc",
            },
            body: JSON.stringify({
              name: `Verified Domain ${crypto.randomUUID()}`,
            }),
          },
        );
        expect(organizationResponse.status).toBe(201);
        const organization = (await organizationResponse.json()) as {
          organization: { id: string };
        };
        const { project } = await publishShiplet(organization.organization.id, {
          authHeaders: AUTH_HEADERS,
        });
        const tenantUrl = `https://${project.subdomain}.shiplet.cc/?mode=review`;

        const anonymousTenant = await requestHelper(tenantUrl, {
          redirect: "manual",
        });
        expect(anonymousTenant.status).toBe(302);
        const loginUrl = new URL(anonymousTenant.headers.get("location")!);
        expect(loginUrl.origin).toBe("https://app.shiplet.cc");
        expect(loginUrl.pathname).toBe("/auth/login");
        const accessGate = loginUrl.searchParams.get("return_to")!;
        const accessGateUrl = new URL(accessGate);
        expect(accessGateUrl.pathname).toBe(`/shiplets/${project.id}/access`);
        expect(accessGateUrl.searchParams.get("return_to")).toBe(tenantUrl);

        const authKitRedirect = await requestHelper(loginUrl.toString(), {
          redirect: "manual",
        });
        expect(authKitRedirect.status).toBe(302);
        const authKitUrl = new URL(authKitRedirect.headers.get("location")!);
        expect(authKitUrl.searchParams.get("organization_id")).toBe(
          organization.organization.id,
        );

        const memberState = btoa(JSON.stringify({ returnTo: accessGate }));
        const memberCallback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            `test-code:${organization.organization.id}:Colleague@ACME.EXAMPLE`,
          )}&state=${encodeURIComponent(memberState)}`,
          { redirect: "manual" },
        );
        expect(memberCallback.status).toBe(302);
        expect(memberCallback.headers.get("location")).toBe(accessGate);
        const memberCookie = cookieHeaderFromSetCookie(
          setCookieHeader(memberCallback),
        );

        const memberGate = await requestHelper(accessGate, {
          headers: { Cookie: memberCookie },
          redirect: "manual",
        });
        expect(memberGate.status).toBe(302);
        const signedTenantUrl = memberGate.headers.get("location") || "";
        expect(signedTenantUrl).toContain(
          `https://${project.subdomain}.shiplet.cc/`,
        );
        expect(signedTenantUrl).toContain("mode=review");
        expect(signedTenantUrl).toContain("shiplet_preview_token=");

        const capabilityExchange = await requestHelper(signedTenantUrl, {
          redirect: "manual",
        });
        expect(capabilityExchange.status).toBe(302);
        const cleanTenantUrl = capabilityExchange.headers.get("location") || "";
        expect(cleanTenantUrl).not.toContain("shiplet_preview_token=");
        const artifactCookie = cookieHeaderFromSetCookie(
          setCookieHeader(capabilityExchange),
        );
        const artifact = await requestHelper(cleanTenantUrl, {
          headers: { Cookie: artifactCookie },
        });
        expect(artifact.status).toBe(200);
        const trustedHostHtml = await artifact.text();
        expect(trustedHostHtml).toContain(
          'data-shiplet-trusted-review-host="v1"',
        );
        const artifactFrameUrl = trustedHostHtml.match(
          /data-shiplet-artifact-frame="v1"[^>]+src="([^"]+)"/,
        )?.[1];
        expect(artifactFrameUrl).toBeTruthy();
        expect(artifactFrameUrl).not.toContain("shiplet_preview_token=");
        const artifactFrame = await requestHelper(artifactFrameUrl!, {
          headers: { Cookie: artifactCookie },
        });
        expect(artifactFrame.status).toBe(200);
        expect(await artifactFrame.text()).toContain("Security artifact");

        const reviewApiUrl = `https://${project.subdomain}.shiplet.cc/__shiplet/review/feedback`;
        const feedbackList = await requestHelper(reviewApiUrl, {
          headers: { Cookie: artifactCookie },
        });
        expect(feedbackList.status).toBe(200);
        expect(feedbackList.headers.get("content-type")).toContain(
          "application/json",
        );

        const feedbackCreate = await requestHelper(reviewApiUrl, {
          method: "POST",
          headers: {
            Cookie: artifactCookie,
            "Content-Type": "application/json",
            Origin: `https://${project.subdomain}.shiplet.cc`,
          },
          body: JSON.stringify({
            comment: "Access-gate capability cookie remains review-capable.",
            pageUrl: tenantUrl,
            clientFeedbackId: `client-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          }),
        });
        expect(feedbackCreate.status).toBe(201);
        const createdFeedback = (await feedbackCreate.json()) as {
          feedback: { id: string };
        };

        const effectSnapshot = () =>
          (env as unknown as TestEnv).DB.prepare(
            `SELECT
              (SELECT COUNT(*) FROM review_feedback WHERE project_id = ?) AS feedback_count,
              (SELECT COUNT(*) FROM review_feedback_replies WHERE project_id = ?) AS reply_count,
              (SELECT COUNT(*) FROM shiplet_events WHERE project_id = ?) AS event_count,
              (SELECT COUNT(*) FROM shiplet_watch_subscriptions WHERE project_id = ?) AS watch_count,
              (SELECT status FROM review_feedback WHERE id = ?) AS feedback_status`,
          )
            .bind(
              project.id,
              project.id,
              project.id,
              project.id,
              createdFeedback.feedback.id,
            )
            .first<{
              feedback_count: number;
              reply_count: number;
              event_count: number;
              watch_count: number;
              feedback_status: string;
            }>();
        const beforeRejectedMutations = await effectSnapshot();
        const tenantOrigin = `https://${project.subdomain}.shiplet.cc`;
        const mutationCases = [
          {
            name: "feedback create",
            method: "POST",
            url: reviewApiUrl,
            json: JSON.stringify({
              comment: "Forged feedback",
              pageUrl: tenantUrl,
              clientFeedbackId: `forged-${crypto.randomUUID()}`,
            }),
          },
          {
            name: "feedback reply",
            method: "POST",
            url: `${reviewApiUrl}/${createdFeedback.feedback.id}/replies`,
            json: JSON.stringify({ comment: "Forged reply" }),
          },
          {
            name: "feedback status",
            method: "POST",
            url: `${reviewApiUrl}/${createdFeedback.feedback.id}/status`,
            json: JSON.stringify({ status: "Resolved" }),
          },
          {
            name: "watch create",
            method: "POST",
            url: `${tenantOrigin}/__shiplet/review/watch`,
            json: "{}",
          },
          {
            name: "watch delete",
            method: "DELETE",
            url: `${tenantOrigin}/__shiplet/review/watch`,
            json: "{}",
          },
        ] as const;

        for (const mutation of mutationCases) {
          const missingOrigin = await requestHelper(mutation.url, {
            method: mutation.method,
            headers: {
              Cookie: artifactCookie,
              "Content-Type": "application/json",
            },
            body: "{",
          });
          expect
            .soft(missingOrigin.status, `${mutation.name} without Origin`)
            .toBe(403);

          const wrongOrigin = await requestHelper(mutation.url, {
            method: mutation.method,
            headers: {
              Cookie: artifactCookie,
              "Content-Type": "application/json",
              Origin: "https://hostile.example",
            },
            body: mutation.json,
          });
          expect
            .soft(wrongOrigin.status, `${mutation.name} with a hostile Origin`)
            .toBe(403);

          const wrongContentType = await requestHelper(mutation.url, {
            method: mutation.method,
            headers: {
              Cookie: artifactCookie,
              "Content-Type": "text/plain",
              Origin: tenantOrigin,
            },
            body: mutation.json,
          });
          expect
            .soft(
              wrongContentType.status,
              `${mutation.name} with text/plain JSON`,
            )
            .toBe(415);
        }

        expect(await effectSnapshot()).toEqual(beforeRejectedMutations);

        const maliciousGateUrl = new URL(accessGate);
        maliciousGateUrl.searchParams.set(
          "return_to",
          "https://other-shiplet.shiplet.cc/",
        );
        const maliciousGate = await requestHelper(maliciousGateUrl.toString(), {
          headers: { Cookie: memberCookie },
          redirect: "manual",
        });
        expect(maliciousGate.status).toBe(302);
        expect(maliciousGate.headers.get("location")).toBe(
          `/shiplets/${project.id}`,
        );

        const outsiderState = btoa(JSON.stringify({ returnTo: accessGate }));
        const outsiderCallback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            "test-code::outsider@gmail.com",
          )}&state=${encodeURIComponent(outsiderState)}`,
          { redirect: "manual" },
        );
        expect(outsiderCallback.status).toBe(302);
        const outsiderCookie = cookieHeaderFromSetCookie(
          setCookieHeader(outsiderCallback),
        );
        const outsiderGate = await requestHelper(accessGate, {
          headers: { Cookie: outsiderCookie },
        });
        expect(outsiderGate.status).toBe(200);
        const outsiderHtml = await outsiderGate.text();
        expect(outsiderHtml).toContain("Request access to");
        expect(outsiderHtml).toContain("outsider@gmail.com");
        expect(outsiderHtml).not.toContain("Security artifact");
      });
    });
  });

  it("rejects artifact-origin platform cookie requests while preserving app-origin review access", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://shiplet.cc", async () => {
        const callback = await requestHelper(
          "https://shiplet.cc/auth/callback?code=test-code%3A%3Aorigin%2540example.com",
          { redirect: "manual" },
        );
        const cookie = cookieHeaderFromSetCookie(setCookieHeader(callback));
        const organization = await createOrganization(cookie);
        const { project } = await publishShiplet(organization.organization.id, {
          cookie,
        });

        const artifactOriginMutation = await requestHelper(
          `https://shiplet.cc/api/projects/${project.id}/archive`,
          {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: `https://${project.subdomain}.shiplet.cc`,
            },
          },
        );
        expect(artifactOriginMutation.status).toBe(403);

        const artifactOriginReviewMutation = await requestHelper(
          `https://shiplet.cc/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: {
              "Content-Type": "text/plain",
              Cookie: cookie,
              Origin: `https://${project.subdomain}.shiplet.cc`,
            },
            body: JSON.stringify({
              comment: "Ambient cookie authority must not cross origins.",
              pageUrl: `https://${project.subdomain}.shiplet.cc/`,
              clientFeedbackId: `cross-origin-${crypto.randomUUID()}`,
            }),
          },
        );
        expect(artifactOriginReviewMutation.status).toBe(401);

        const artifactSubresourceReviewRead = await requestHelper(
          `https://shiplet.cc/api/projects/${project.id}/review-feedback`,
          {
            headers: {
              Cookie: cookie,
              Referer: `https://${project.subdomain}.shiplet.cc/`,
              "Sec-Fetch-Mode": "no-cors",
              "Sec-Fetch-Site": "same-site",
            },
          },
        );
        expect(artifactSubresourceReviewRead.status).toBe(401);

        const appOriginReviewRead = await requestHelper(
          `https://shiplet.cc/api/projects/${project.id}/review-feedback`,
          {
            headers: {
              Cookie: cookie,
              Referer: `https://shiplet.cc/shiplets/${project.id}`,
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
          },
        );
        expect(appOriginReviewRead.status).toBe(200);

        const missingOriginMutation = await requestHelper(
          "https://shiplet.cc/api/organizations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookie,
            },
            body: JSON.stringify({ name: `No Origin ${crypto.randomUUID()}` }),
          },
        );
        expect(missingOriginMutation.status).toBe(403);

        const appOriginMutation = await requestHelper(
          `https://shiplet.cc/api/projects/${project.id}/archive`,
          {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: "https://shiplet.cc",
            },
          },
        );
        expect(appOriginMutation.status).toBe(200);

        const appOriginReviewMutation = await requestHelper(
          `https://shiplet.cc/api/projects/${project.id}/review-feedback`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookie,
              Origin: "https://shiplet.cc",
            },
            body: JSON.stringify({
              comment: "App-origin cookie authority remains available.",
              pageUrl: `https://${project.subdomain}.shiplet.cc/`,
              clientFeedbackId: `app-origin-${crypto.randomUUID()}`,
            }),
          },
        );
        expect(appOriginReviewMutation.status).toBe(201);
      });
    });
  });

  it("validates signed review capabilities by expiry, project, scope, and signature", async () => {
    const secret = "test-review-capability-secret";
    const token = await createReviewCapabilityToken({
      secret,
      projectId: "project_a",
      viewer: {
        id: "user_1",
        email: "reviewer@example.com",
        name: "Reviewer",
      },
      scopes: ["feedback:read"],
      expiresInSeconds: 60,
      nonce: "nonce-a",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(
      verifyReviewCapabilityToken(token, {
        secret,
        projectId: "project_a",
        requiredScopes: ["feedback:read"],
        now: new Date("2026-01-01T00:00:30.000Z"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      capability: {
        projectId: "project_a",
        viewer: { id: "user_1", email: "reviewer@example.com" },
        scopes: ["feedback:read"],
      },
    });

    await expect(
      verifyReviewCapabilityToken(token, {
        secret,
        projectId: "project_a",
        requiredScopes: ["feedback:read"],
        now: new Date("2026-01-01T00:01:01.000Z"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "expired" });

    await expect(
      verifyReviewCapabilityToken(token, {
        secret,
        projectId: "project_b",
        requiredScopes: ["feedback:read"],
        now: new Date("2026-01-01T00:00:30.000Z"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "wrong_project" });

    await expect(
      verifyReviewCapabilityToken(token, {
        secret,
        projectId: "project_a",
        requiredScopes: ["feedback:write"],
        now: new Date("2026-01-01T00:00:30.000Z"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "missing_scope" });

    const tampered = token.replace(/.$/, token.endsWith("a") ? "b" : "a");
    await expect(
      verifyReviewCapabilityToken(tampered, {
        secret,
        projectId: "project_a",
        requiredScopes: ["feedback:read"],
        now: new Date("2026-01-01T00:00:30.000Z"),
      }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("serves the trusted review host without serializing signing authority", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://shiplet.cc", async () => {
        const callback = await requestHelper(
          "https://shiplet.cc/auth/callback?code=test-code%3A%3Areview-secret%2540example.com",
          { redirect: "manual" },
        );
        const cookie = cookieHeaderFromSetCookie(setCookieHeader(callback));
        const organization = await createOrganization(cookie);
        const { project } = await publishShiplet(organization.organization.id, {
          cookie,
        });

        await withReviewSigningEnv(
          {
            SHIPLET_AUTH_MODE: "workos",
            SHIPLET_REVIEW_TOKEN_SECRET: undefined,
            WORKOS_API_KEY: "fallback-workos-secret-not-allowed",
            SHIPLET_BOOTSTRAP_TOKEN: "fallback-bootstrap-secret-not-allowed",
          },
          async () => {
            const legacyPreview = await requestHelper(
              `/shiplets/${project.id}/preview`,
              { headers: { Cookie: cookie }, redirect: "manual" },
            );
            expect(legacyPreview.status).toBe(302);
            expect(legacyPreview.headers.get("location")).toBe(
              `/shiplets/${project.id}/review-host`,
            );
            const preview = await requestHelper(
              `/shiplets/${project.id}/review-host`,
              { headers: { Cookie: cookie } },
            );
            const html = await preview.text();
            expect(preview.status).toBe(200);
            expect(html).toContain('data-shiplet-trusted-review-host="v1"');
            expect(html).not.toContain("window.__SHIPLET_REVIEW__");
            expect(html).not.toContain("reviewToken");
            expect(html).not.toContain("shiplet_review_cap_v1.");
          },
        );

        await withReviewSigningEnv(
          {
            SHIPLET_AUTH_MODE: "workos",
            SHIPLET_REVIEW_TOKEN_SECRET: "explicit-review-secret",
            WORKOS_API_KEY: "fallback-workos-secret-not-used",
            SHIPLET_BOOTSTRAP_TOKEN: "fallback-bootstrap-secret-not-used",
          },
          async () => {
            const legacyPreview = await requestHelper(
              `/shiplets/${project.id}/preview`,
              { headers: { Cookie: cookie }, redirect: "manual" },
            );
            expect(legacyPreview.status).toBe(302);
            expect(legacyPreview.headers.get("location")).toBe(
              `/shiplets/${project.id}/review-host`,
            );
            const preview = await requestHelper(
              `/shiplets/${project.id}/review-host`,
              { headers: { Cookie: cookie } },
            );
            const html = await preview.text();
            expect(preview.status).toBe(200);
            expect(html).toContain('data-shiplet-trusted-review-host="v1"');
            expect(html).not.toContain("window.__SHIPLET_REVIEW__");
            expect(html).not.toContain("reviewToken");
            expect(html).not.toContain("shiplet_review_cap_v1.");
          },
        );
      });
    });
  });

  it("lets only the trusted host session attribute human feedback", async () => {
    const organization = await requestHelper("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ name: `Review ${crypto.randomUUID()}` }),
    }).then(
      (response) =>
        response.json() as Promise<{ organization: { id: string } }>,
    );
    const { project } = await publishShiplet(organization.organization.id, {
      authHeaders: AUTH_HEADERS,
    });

    const preview = await requestHelper(`/shiplets/${project.id}/review-host`, {
      headers: AUTH_HEADERS,
    });
    const html = await preview.text();
    expect(preview.status).toBe(200);
    expect(html).toContain('data-shiplet-trusted-review-host="v1"');
    expect(html).not.toContain("window.__SHIPLET_REVIEW__");
    expect(html).not.toContain("reviewToken");
    expect(html).not.toContain("presenceToken");
    expect(html).not.toContain("shiplet_review_cap_v1.");

    const createResponse = await requestHelper(
      `/api/projects/${project.id}/review-feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...AUTH_HEADERS,
        },
        body: JSON.stringify({
          comment: "Trusted-host session feedback.",
          pageUrl: `https://${project.subdomain}.shiplet.cc/`,
          clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      feedback: { submitted_by_user_id: string; submitted_by_email: string };
    };
    expect(created.feedback.submitted_by_user_id).toBe("user_test");
    expect(created.feedback.submitted_by_email).toBe("test@example.com");

    const anonymousCreate = await requestHelper(
      `/api/projects/${project.id}/review-feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: "No ambient cookie authority.",
          pageUrl: `https://${project.subdomain}.shiplet.cc/`,
          clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
        }),
      },
    );
    expect(anonymousCreate.status).toBe(401);
  });

  it("uses bearer-capability CORS without credentialed wildcard-style access", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      const response = await requestHelper(
        "/api/projects/project_test/review-feedback",
        {
          method: "OPTIONS",
          headers: {
            Origin: "https://demo.shiplet.cc",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type, authorization",
          },
        },
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://demo.shiplet.cc",
      );
      expect(response.headers.get("access-control-allow-headers")).toContain(
        "authorization",
      );
      expect(
        response.headers.get("access-control-allow-credentials"),
      ).toBeNull();
    });
  });

  it("shows named, scoped consent before accepting a restricted Shiplet invitation", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `consent-${crypto.randomUUID()}@example.com`;
        const setup = await bootstrapRestrictedInvitation(email);
        const returnTo = new URL(
          "/docs/?mode=review",
          `${setup.shipletUrl}/`,
        ).toString();

        const { html } = await startRestrictedInvitationConsent(returnTo);

        expect(html).toContain(setup.project.name);
        expect(html).toContain(setup.organization.name);
        expect(html).toContain("Sign in and accept invitation");
        expect(html).not.toContain(email);
        expect(html).not.toContain("invitation_token");
      });
    });
  });

  it("accepts only the requested invitation after exact-email authentication", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `scoped-${crypto.randomUUID()}@example.com`;
        const requested = await bootstrapRestrictedInvitation(email);
        const unrelated = await bootstrapRestrictedInvitation(email);
        const returnTo = new URL(
          "/docs/?mode=review",
          `${requested.shipletUrl}/`,
        ).toString();
        const { state } = await startRestrictedInvitationConsent(returnTo);
        const tamperedStateValue = JSON.parse(atob(state)) as Record<
          string,
          unknown
        >;
        tamperedStateValue.returnTo = unrelated.shipletUrl;
        const tamperedState = btoa(JSON.stringify(tamperedStateValue));

        const callback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            `test-code::${encodeURIComponent(email)}`,
          )}&state=${encodeURIComponent(tamperedState)}`,
          { redirect: "manual" },
        );

        expect(callback.status).toBe(302);
        const signedReturn = new URL(callback.headers.get("location") || "");
        expect(signedReturn.origin).toBe(new URL(returnTo).origin);
        expect(signedReturn.pathname).toBe("/docs/");
        expect(signedReturn.searchParams.get("mode")).toBe("review");
        expect(
          signedReturn.searchParams.get("shiplet_preview_token"),
        ).toBeTruthy();

        const invitationStates = await (env as unknown as TestEnv).DB.prepare(
          `SELECT id, status FROM app_invitations WHERE id IN (?, ?)`,
        )
          .bind(requested.invitation.id, unrelated.invitation.id)
          .all<{ id: string; status: string }>();
        expect(
          invitationStates.results?.find(
            (invitation) => invitation.id === requested.invitation.id,
          )?.status,
        ).toBe("accepted");
        expect(
          invitationStates.results?.find(
            (invitation) => invitation.id === unrelated.invitation.id,
          )?.status,
        ).toBe("pending");

        const capabilityExchange = await requestHelper(
          signedReturn.toString(),
          {
            redirect: "manual",
          },
        );
        expect(capabilityExchange.status).toBe(302);
        expect(capabilityExchange.headers.get("location")).toBe(returnTo);
        const artifactCookie = cookieHeaderFromSetCookie(
          setCookieHeader(capabilityExchange),
        );
        expect(artifactCookie).toContain("__Host-shiplet_artifact_access=");
        const artifact = await requestHelper(returnTo, {
          headers: { Cookie: artifactCookie },
        });
        expect(artifact.status).toBe(404);
        expect(artifact.headers.get("location")).toBeNull();
      });
    });
  });

  it("does not accept invitations after a generic login without scoped consent", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `generic-${crypto.randomUUID()}@example.com`;
        const setup = await bootstrapRestrictedInvitation(email);
        const state = btoa(JSON.stringify({ returnTo: setup.shipletUrl }));
        const code = `test-code:${setup.organization.id}:${encodeURIComponent(email)}`;

        const callback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(callback.status).toBe(302);

        const invitation = await (env as unknown as TestEnv).DB.prepare(
          `SELECT status, accepted_on FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ status: string; accepted_on: string | null }>();
        expect(invitation).toEqual({ status: "pending", accepted_on: null });
        const teamMembership = await (env as unknown as TestEnv).DB.prepare(
          `SELECT team_memberships.team_id
					 FROM team_memberships
					 JOIN app_invitations ON app_invitations.team_id = team_memberships.team_id
					 WHERE app_invitations.id = ? AND team_memberships.user_id != 'user_shiplet_bootstrap'`,
        )
          .bind(setup.invitation.id)
          .first<{ team_id: string }>();
        expect(teamMembership).toBeNull();
      });
    });
  });

  it("rejects a same-domain email mismatch without changing WorkOS or local access", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const invitedEmail = `invited-${crypto.randomUUID()}@corp.example`;
        const otherEmail = `other-${crypto.randomUUID()}@corp.example`;
        const setup = await bootstrapRestrictedInvitation(invitedEmail);
        const { state } = await startRestrictedInvitationConsent(
          setup.shipletUrl,
        );

        const callback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            `test-code::${encodeURIComponent(otherEmail)}`,
          )}&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(callback.status).toBe(403);
        const failure = await callback.text();
        expect(failure).not.toContain(invitedEmail);
        expect(failure).not.toContain(otherEmail);

        const invitation = await (env as unknown as TestEnv).DB.prepare(
          `SELECT status, accepted_on FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ status: string; accepted_on: string | null }>();
        expect(invitation).toEqual({ status: "pending", accepted_on: null });
      });
    });
  });

  it("rejects a same-domain mismatch for consent created from an email link", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const invitedEmail = `email-invited-${crypto.randomUUID()}@corp.example`;
        const otherEmail = `email-other-${crypto.randomUUID()}@corp.example`;
        const setup = await bootstrapRestrictedInvitation(invitedEmail);
        const pending = await (env as unknown as TestEnv).DB.prepare(
          `SELECT workos_invitation_token FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ workos_invitation_token: string }>();
        const emailLink = new URL("https://app.shiplet.cc/auth/login");
        emailLink.searchParams.set(
          "invitation_token",
          pending!.workos_invitation_token,
        );
        const removeToken = await requestHelper(emailLink.toString(), {
          redirect: "manual",
        });
        const consentPage = await requestHelper(
          removeToken.headers.get("location")!,
        );
        const state = await submitRestrictedInvitationConsent(
          await consentPage.text(),
        );

        const errorLog = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        try {
          const callback = await requestHelper(
            `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
              `test-code::${encodeURIComponent(otherEmail)}`,
            )}&state=${encodeURIComponent(state)}`,
            { redirect: "manual" },
          );
          expect(callback.status).toBe(403);
          const logs = errorLog.mock.calls.flat().map(String).join("\n");
          expect(logs).toContain('"reason":"identity_or_scope_mismatch"');
          expect(logs).not.toContain("workos_acceptance_failed");
        } finally {
          errorLog.mockRestore();
        }
        const invitation = await (env as unknown as TestEnv).DB.prepare(
          `SELECT status FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ status: string }>();
        expect(invitation?.status).toBe("pending");
      });
    });
  });

  it("rejects tampered consent and cross-origin consent submissions", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `tamper-${crypto.randomUUID()}@example.com`;
        const setup = await bootstrapRestrictedInvitation(email);
        const loginUrl = new URL("https://app.shiplet.cc/auth/login");
        loginUrl.searchParams.set("return_to", setup.shipletUrl);
        const consentPage = await requestHelper(loginUrl.toString());
        const html = await consentPage.text();
        const consentToken = hiddenInput(html, "consent_token")!;
        const consentParts = consentToken.split(".");
        const signature = consentParts[2];
        consentParts[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
        const tampered = consentParts.join(".");

        const tamperedResponse = await requestHelper(
          "https://app.shiplet.cc/auth/login",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: "https://app.shiplet.cc",
            },
            body: new URLSearchParams({ consent_token: tampered }),
          },
        );
        expect(tamperedResponse.status).toBe(400);

        const crossOriginResponse = await requestHelper(
          "https://app.shiplet.cc/auth/login",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: "https://attacker.example",
            },
            body: new URLSearchParams({ consent_token: consentToken }),
          },
        );
        expect(crossOriginResponse.status).toBe(403);

        const originlessResponse = await requestHelper(
          "https://app.shiplet.cc/auth/login",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ consent_token: consentToken }),
          },
        );
        expect(originlessResponse.status).toBe(403);

        const invitation = await (env as unknown as TestEnv).DB.prepare(
          `SELECT status FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ status: string }>();
        expect(invitation?.status).toBe("pending");
      });
    });
  });

  it("keeps local access pending when WorkOS invitation acceptance fails", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `workos-failure-${crypto.randomUUID()}@example.com`;
        const setup = await bootstrapRestrictedInvitation(email);
        await (env as unknown as TestEnv).DB.prepare(
          `UPDATE app_invitations SET workos_invitation_id = 'inv_test_failure' WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .run();
        const { state } = await startRestrictedInvitationConsent(
          setup.shipletUrl,
        );

        const callback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            `test-code::${encodeURIComponent(email)}`,
          )}&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(callback.status).toBe(502);
        expect(await callback.text()).toBe("Invitation acceptance failed");

        const invitation = await (env as unknown as TestEnv).DB.prepare(
          `SELECT status, accepted_on FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ status: string; accepted_on: string | null }>();
        expect(invitation).toEqual({ status: "pending", accepted_on: null });
      });
    });
  });

  it("logs invitation outcomes without email addresses, codes, state, or tokens", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `observability-${crypto.randomUUID()}@example.com`;
        const setup = await bootstrapRestrictedInvitation(email);
        const { state } = await startRestrictedInvitationConsent(
          setup.shipletUrl,
        );
        const info = vi
          .spyOn(console, "info")
          .mockImplementation(() => undefined);
        try {
          const callback = await requestHelper(
            `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
              `test-code::${encodeURIComponent(email)}`,
            )}&state=${encodeURIComponent(state)}`,
            { redirect: "manual" },
          );
          expect(callback.status).toBe(302);
          const logs = info.mock.calls.flat().map(String).join("\n");
          expect(logs).toContain('"event":"auth.invitation"');
          expect(logs).toContain('"outcome":"accepted"');
          expect(logs).toContain(setup.project.id);
          expect(logs).toContain(setup.invitation.id);
          expect(logs).not.toContain(email);
          expect(logs).not.toContain("test-code");
          expect(logs).not.toContain(state);
          expect(logs).not.toContain("shiplet_invite_consent_v1");
        } finally {
          info.mockRestore();
        }
      });
    });
  });

  it("removes an email invitation token before rendering scoped consent", async () => {
    await withCustomDomain("shiplet.cc", async () => {
      await withAppUrl("https://app.shiplet.cc", async () => {
        const email = `email-link-${crypto.randomUUID()}@example.com`;
        const setup = await bootstrapRestrictedInvitation(email);
        const pending = await (env as unknown as TestEnv).DB.prepare(
          `SELECT workos_invitation_token FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ workos_invitation_token: string }>();

        const emailLink = new URL("https://app.shiplet.cc/auth/login");
        emailLink.searchParams.set(
          "invitation_token",
          pending!.workos_invitation_token,
        );
        emailLink.searchParams.set("return_to", setup.shipletUrl);
        const removeToken = await requestHelper(emailLink.toString(), {
          redirect: "manual",
        });
        expect(removeToken.status).toBe(302);
        const cleanConsentUrl = new URL(
          removeToken.headers.get("location") || "",
        );
        expect(cleanConsentUrl.searchParams.has("invitation_token")).toBe(
          false,
        );
        expect(cleanConsentUrl.searchParams.get("consent")).toBeTruthy();

        const consentPage = await requestHelper(cleanConsentUrl.toString());
        expect(consentPage.status).toBe(200);
        const html = await consentPage.text();
        expect(html).toContain(setup.project.name);
        expect(html).toContain(setup.organization.name);
        expect(html).not.toContain(email);
        const state = await submitRestrictedInvitationConsent(html);
        const callback = await requestHelper(
          `https://app.shiplet.cc/auth/callback?code=${encodeURIComponent(
            `test-code::${encodeURIComponent(email)}`,
          )}&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(callback.status).toBe(302);
        const invitation = await (env as unknown as TestEnv).DB.prepare(
          `SELECT status, accepted_on FROM app_invitations WHERE id = ?`,
        )
          .bind(setup.invitation.id)
          .first<{ status: string; accepted_on: string | null }>();
        expect(invitation?.status).toBe("accepted");
        expect(invitation?.accepted_on).toBeTruthy();
      });
    });
  });
});
