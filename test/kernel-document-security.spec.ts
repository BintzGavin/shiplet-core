import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

const SELECTIVE_NONCE_FIXTURE_PATH =
  "/__security-acceptance/kernel-selective-script-nonce";

app.get(SELECTIVE_NONCE_FIXTURE_PATH, (c) =>
  c.html(`<!doctype html>
<html lang="en"><head><title>Selective nonce fixture</title></head>
<body>
<script data-shiplet-kernel-script="v1" data-attacker-forged-marker-inline>globalThis.attackerInjected = true;</script>
<script data-shiplet-kernel-script="v1" data-attacker-forged-marker-external src="/api/review/client.js"></script>
</body></html>`),
);

const AUTH_HEADERS = {
  "x-shiplet-user-id": "user_kernel_document_security",
  "x-shiplet-user-email": "kernel-document-security@example.com",
};

async function request(
  url: string,
  init?: RequestInit,
  requestEnv: Env = env as unknown as Env,
) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(url, init),
    requestEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

function expectOnlyMarkedKernelScriptsCarryNonce(html: string, csp: string) {
  const nonce = csp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || "";
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];

  expect(nonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
  expect(scriptTags.length).toBeGreaterThan(0);
  for (const tag of scriptTags) {
    expect(tag).toContain('data-shiplet-kernel-script="v1"');
    expect(tag).toContain(`nonce="${nonce}"`);
  }
}

describe("kernel document security", () => {
  it("never treats a forgeable public inventory marker as script trust provenance", async () => {
    const response = await request(
      `https://shiplet.cc${SELECTIVE_NONCE_FIXTURE_PATH}`,
    );
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") || "";
    const nonce = csp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1] || "";
    const forgedInlineTag =
      html.match(/<script\b[^>]*data-attacker-forged-marker-inline[^>]*>/i)?.[0] ||
      "";
    const forgedExternalTag =
      html.match(/<script\b[^>]*data-attacker-forged-marker-external[^>]*>/i)?.[0] ||
      "";

    expect(response.status).toBe(200);
    expect(nonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
    expect(forgedInlineTag).toContain('data-shiplet-kernel-script="v1"');
    expect(forgedInlineTag).not.toContain("nonce=");
    expect(forgedExternalTag).toContain('data-shiplet-kernel-script="v1"');
    expect(forgedExternalTag).toContain('src="/api/review/client.js"');
    expect(forgedExternalTag).not.toContain("nonce=");
  });

  it("attests the exact non-secret Worker version without exposing other metadata", async () => {
    const response = await request("https://shiplet.cc/robots.txt", undefined, {
      ...(env as unknown as Env),
      CF_VERSION_METADATA: {
        id: "12345678-1234-4abc-8def-1234567890ab",
        tag: "internal-release-tag",
        timestamp: "2026-08-06T12:34:56.000Z",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-shiplet-worker-version")).toBe(
      "12345678-1234-4abc-8def-1234567890ab",
    );
    const responseHeaderValues: string[] = [];
    response.headers.forEach((value) => responseHeaderValues.push(value));
    const serializedHeaderValues = responseHeaderValues.join("\n");
    expect(serializedHeaderValues).not.toContain("internal-release-tag");
    expect(serializedHeaderValues).not.toContain(
      "2026-08-06T12:34:56.000Z",
    );
  });

  it("omits release attestation when the version ID is malformed", async () => {
    const response = await request("https://shiplet.cc/robots.txt", undefined, {
      ...(env as unknown as Env),
      CF_VERSION_METADATA: {
        id: "not a valid response-header value\r\nforged: true",
        tag: "malformed-id-fixture",
        timestamp: "2026-08-06T12:34:56.000Z",
      },
    });

    expect(response.headers.get("x-shiplet-worker-version")).toBeNull();
  });

  it("serves trusted HTML with fresh nonce-bound scripts and no third-party code", async () => {
    const response = await request("https://shiplet.cc/");
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") || "";
    const scriptPolicy =
      csp
        .split(";")
        .find((directive) => directive.trim().startsWith("script-src ")) || "";
    const nonce = scriptPolicy.match(/'nonce-([^']+)'/)?.[1] || "";
    const secondResponse = await request("https://shiplet.cc/");
    const secondCsp = secondResponse.headers.get("content-security-policy") || "";
    const secondNonce = secondCsp.match(/'nonce-([^']+)'/)?.[1] || "";

    expect(response.status).toBe(200);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
    expect(html).not.toMatch(
      /<link[^>]+rel=["']stylesheet["'][^>]+href=["']https?:\/\//i,
    );
    expect(html).not.toContain("window.POSTHOG_CONFIG");
    expect(html).not.toContain("cdnjs.cloudflare.com");
    expect(scriptPolicy.trim()).toBe(`script-src 'nonce-${nonce}'`);
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(scriptPolicy).not.toContain("https:");
    expect(csp).toContain("script-src-attr 'none'");
    expectOnlyMarkedKernelScriptsCarryNonce(html, csp);
    const markupWithoutRawText = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
    expect(markupWithoutRawText).not.toMatch(/\son[a-z]+\s*=/i);
    expect(secondNonce).toMatch(/^[A-Za-z0-9+/_=-]{20,}$/);
    expect(secondNonce).not.toBe(nonce);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("does not emit HSTS on local HTTP while keeping the remaining boundary", async () => {
    const response = await request("http://localhost/");

    expect(response.status).toBe(200);
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it.each(["/", "/docs"])(
    "protects the workers.dev fallback kernel document at %s",
    async (pathname) => {
      const response = await request(
        `https://shiplet-fallback.workers.dev${pathname}`,
      );
      const html = await response.text();
      const csp = response.headers.get("content-security-policy") || "";

      expect(response.status).toBe(200);
      expectOnlyMarkedKernelScriptsCarryNonce(html, csp);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(response.headers.get("strict-transport-security")).toBe(
        "max-age=31536000; includeSubDomains",
      );
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    },
  );

  it("does not grant kernel script authority to a workers.dev path-routed artifact", async () => {
    const organizationResponse = await request(
      "https://shiplet.cc/api/organizations",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ name: `Fallback ${crypto.randomUUID()}` }),
      },
    );
    const organization = (await organizationResponse.json()) as {
      organization: { id: string };
    };
    const subdomain = `fallback-${crypto.randomUUID().slice(0, 8)}`;
    const artifact = "<!doctype html><h1>Untrusted fallback artifact</h1>";
    const publishResponse = await request("https://shiplet.cc/projects", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        name: "Fallback boundary",
        organization_id: organization.organization.id,
        subdomain,
        assets: [
          {
            path: "index.html",
            content: btoa(artifact),
            size: new TextEncoder().encode(artifact).byteLength,
          },
        ],
      }),
    });
    expect(publishResponse.status).toBe(201);

    const response = await request(
      `https://shiplet-fallback.workers.dev/${subdomain}/__shiplet/artifact-frame/`,
      { headers: AUTH_HEADERS },
    );
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") || "";

    expect(response.status).toBe(200);
    expect(html).toContain("Untrusted fallback artifact");
    expect(csp).not.toMatch(/script-src[^;]*'nonce-/);
  });

  it.each([
    ["anonymous sandbox", "https://shiplet.cc/play", undefined],
    ["public documentation", "https://shiplet.cc/docs", undefined],
    ["authenticated publish", "https://shiplet.cc/", { headers: AUTH_HEADERS }],
    ["Shiplet list", "https://shiplet.cc/shiplets", { headers: AUTH_HEADERS }],
    ["global inbox", "https://shiplet.cc/inbox", { headers: AUTH_HEADERS }],
    [
      "global feedback",
      "https://shiplet.cc/feedback",
      { headers: AUTH_HEADERS },
    ],
    [
      "workspace settings",
      "https://shiplet.cc/workspace",
      { headers: AUTH_HEADERS },
    ],
  ])(
    "nonce-binds every explicitly marked script on the %s kernel document",
    async (_name, url, init) => {
      const response = await request(url, init);
      const html = await response.text();
      const csp = response.headers.get("content-security-policy") || "";

      expect(response.status).toBe(200);
      expectOnlyMarkedKernelScriptsCarryNonce(html, csp);
    },
  );

  it("allows only Shiplet's own dashboard to frame an archived review notice", async () => {
    const organizationResponse = await request(
      "https://shiplet.cc/api/organizations",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ name: `Kernel ${crypto.randomUUID()}` }),
      },
    );
    const organization = (await organizationResponse.json()) as {
      organization: { id: string };
    };
    const subdomain = `kernel-frame-${crypto.randomUUID().slice(0, 8)}`;
    const artifact = "<!doctype html><h1>Archived boundary</h1>";
    const publishResponse = await request("https://shiplet.cc/projects", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        name: "Archived boundary",
        organization_id: organization.organization.id,
        subdomain,
        assets: [
          {
            path: "index.html",
            content: btoa(artifact),
            size: new TextEncoder().encode(artifact).byteLength,
          },
        ],
      }),
    });
    const published = (await publishResponse.json()) as {
      project: { id: string };
    };
    const activeDetail = await request(
      `https://shiplet.cc/shiplets/${published.project.id}`,
      { headers: AUTH_HEADERS },
    );
    const activeDetailHtml = await activeDetail.text();
    expect(activeDetail.status).toBe(200);
    expectOnlyMarkedKernelScriptsCarryNonce(
      activeDetailHtml,
      activeDetail.headers.get("content-security-policy") || "",
    );
    const archiveResponse = await request(
      `https://shiplet.cc/api/projects/${published.project.id}/archive`,
      { method: "POST", headers: AUTH_HEADERS },
    );
    expect(archiveResponse.status).toBe(200);

    const embedded = await request(
      `https://shiplet.cc/shiplets/${published.project.id}/review-host`,
      { headers: AUTH_HEADERS },
    );
    expect(embedded.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(embedded.headers.get("x-frame-options")).toBe("SAMEORIGIN");

    const testEnv = env as unknown as Env;
    const previousCustomDomain = testEnv.CUSTOM_DOMAIN;
    testEnv.CUSTOM_DOMAIN = "example.test";
    try {
      const topLevelTenant = await request(
        `https://${subdomain}.example.test/`,
        { headers: AUTH_HEADERS },
      );
      expect(topLevelTenant.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(topLevelTenant.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      testEnv.CUSTOM_DOMAIN = previousCustomDomain;
    }
  });
});
