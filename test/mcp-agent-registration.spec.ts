import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import app from "../src/index";
import {
  authenticateMcpOAuthPrincipal,
  proxyWorkOSAgentAuthGuide,
} from "../src/mcp-auth";
import { ensureSchema } from "../src/schema";

/*
 * Behavioral specification
 *
 * Given a claimed WorkOS service-auth registration, when Shiplet authenticates
 * its access token, then the stable registration actor, delegated human,
 * organization, and recognized operation permissions remain separate across
 * token rotation and no credential material is retained.
 *
 * Given an anonymous, malformed, under-scoped, cross-organization, or locally
 * deauthorized registration, when it calls Code Mode MCP, then Shiplet fails
 * closed without widening to a human principal or another organization.
 *
 * Given an agent discovers Shiplet through /auth.md, when Shiplet retrieves the
 * guide, then only the configured AuthKit issuer is used and the response is
 * bounded public Markdown.
 */

type RegistrationClaims = {
  sub?: unknown;
  act?: unknown;
  org_id?: unknown;
  scope?: unknown;
  jti?: unknown;
  email?: unknown;
};

const testEnv = env as Env;
const TEST_REGISTRATION_TOKEN_PREFIX = "shiplet_agent_registration_";

function registrationToken(overrides: RegistrationClaims = {}) {
  const claims: RegistrationClaims = {
    sub: "agent_reg_shiplet_test",
    act: { sub: "user_agent_registration" },
    org_id: "org_agent_registration",
    scope:
      "openid mcp shiplets:read shiplets:write feedback:read feedback:write future:unknown",
    jti: `registration_rotation_${crypto.randomUUID()}`,
    email: "registered-agent-owner@example.test",
    ...overrides,
  };
  const encoded = btoa(JSON.stringify(claims))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${TEST_REGISTRATION_TOKEN_PREFIX}${encoded}`;
}

function bearerRequest(token: string) {
  return new Request("https://shiplet.cc/api/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(`http://localhost${path}`, init),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function createOrganization(
  user: Record<string, string>,
  name: string,
) {
  const response = await request("/api/organizations", {
    method: "POST",
    headers: { "content-type": "application/json", ...user },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { organization: { id: string } };
}

async function publishAsUser(
  user: Record<string, string>,
  organizationId: string,
  label: string,
) {
  const response = await request("/api/shiplets", {
    method: "POST",
    headers: { "content-type": "application/json", ...user },
    body: JSON.stringify({
      name: label,
      organization_id: organizationId,
      subdomain: `agent-registration-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "private",
      assets: [
        {
          path: "index.html",
          content: btoa(`<!doctype html><h1>${label}</h1>`),
        },
      ],
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    project: { id: string; organization_id: string };
  };
}

async function executeCodeMode(
  token: string,
  operation: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  },
) {
  const response = await request("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "execute",
        arguments: {
          code: `async () => await codemode.request(${JSON.stringify(operation)})`,
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    result?: {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
  };
  const text = payload.result?.content?.[0]?.text || "";
  return { response, payload, text };
}

describe("WorkOS service-auth agent registration", () => {
  beforeAll(async () => {
    await ensureSchema(testEnv.DB);
  });

  it("retains a stable registration actor separately from its delegated human", async () => {
    const firstToken = registrationToken({ jti: "rotation_one" });
    const rotatedToken = registrationToken({ jti: "rotation_two" });
    const first = await authenticateMcpOAuthPrincipal(
      testEnv,
      bearerRequest(firstToken),
    );
    const rotated = await authenticateMcpOAuthPrincipal(
      testEnv,
      bearerRequest(rotatedToken),
    );

    expect(first).toMatchObject({
      kind: "agent",
      credentialKind: "agent_registration",
      registrationId: "agent_reg_shiplet_test",
      actorId: "workos-agent-registration:agent_reg_shiplet_test",
      actor: {
        kind: "agent",
        id: "workos-agent-registration:agent_reg_shiplet_test",
      },
      subject: {
        id: "user_agent_registration",
        email: "registered-agent-owner@example.test",
      },
      organizationId: "org_agent_registration",
      permissions: [
        "mcp",
        "shiplets:read",
        "shiplets:write",
        "feedback:read",
        "feedback:write",
      ],
    });
    expect(rotated?.actorId).toBe(first?.actorId);
    expect(first?.actorId).not.toBe(first?.subject.id);
    expect(JSON.stringify(first)).not.toContain(firstToken);
    expect(JSON.stringify(first)).not.toContain(rotatedToken);
    expect(first?.permissions).not.toContain("openid");
    expect(first?.permissions).not.toContain("future:unknown");
  });

  it.each([
    ["unclaimed anonymous registration", { act: undefined }],
    ["missing registration identity", { sub: undefined }],
    ["malformed delegated user", { act: { sub: "user with spaces" } }],
    ["missing organization", { org_id: undefined }],
    ["malformed organization", { org_id: "org with spaces" }],
    ["missing scopes", { scope: undefined }],
    ["duplicate scopes", { scope: "mcp shiplets:read shiplets:read" }],
  ])("rejects %s without falling back to a human", async (_label, claims) => {
    await expect(
      authenticateMcpOAuthPrincipal(
        testEnv,
        bearerRequest(registrationToken(claims)),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("requires the mcp permission before serving the registered agent", async () => {
    const token = registrationToken({ scope: "shiplets:read" });
    const response = await request("/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(403);
  });

  it("constrains listing and publishing to the claimed organization and records the agent actor", async () => {
    const user = {
      "x-shiplet-user-id": `user_agent_${crypto.randomUUID()}`,
      "x-shiplet-user-email": `agent-${crypto.randomUUID()}@example.test`,
    };
    const first = await createOrganization(
      user,
      `Registered Agent A ${crypto.randomUUID()}`,
    );
    const second = await createOrganization(
      user,
      `Registered Agent B ${crypto.randomUUID()}`,
    );
    const firstProject = await publishAsUser(
      user,
      first.organization.id,
      "Visible to registered agent",
    );
    await publishAsUser(user, second.organization.id, "Cross-org hidden");
    const token = registrationToken({
      sub: `agent_reg_${crypto.randomUUID()}`,
      act: { sub: user["x-shiplet-user-id"] },
      org_id: first.organization.id,
      email: user["x-shiplet-user-email"],
      scope: "mcp shiplets:read shiplets:write",
    });

    const listed = await executeCodeMode(token, {
      method: "GET",
      path: "/api/shiplets",
    });
    expect(listed.response.status).toBe(200);
    expect(listed.payload.result?.isError).not.toBe(true);
    const listResult = JSON.parse(listed.text) as {
      projects: Array<{ id: string; organization_id: string }>;
    };
    expect(listResult.projects.map((project) => project.id)).toContain(
      firstProject.project.id,
    );
    expect(
      new Set(listResult.projects.map((project) => project.organization_id)),
    ).toEqual(new Set([first.organization.id]));

    const crossOrganizationSubdomain = `cross-org-${crypto.randomUUID().slice(0, 8)}`;
    const denied = await executeCodeMode(token, {
      method: "POST",
      path: "/api/shiplets",
      body: {
        name: "Cross-org attempt",
        organization_id: second.organization.id,
        subdomain: crossOrganizationSubdomain,
        visibility: "private",
        assets: [
          {
            path: "index.html",
            content: btoa("<!doctype html><h1>Denied</h1>"),
          },
        ],
      },
    });
    expect(denied.response.status).toBe(200);
    expect(denied.payload.result?.isError).toBe(true);
    expect(denied.text).toContain("Authorization denied");
    await expect(
      testEnv.DB.prepare("SELECT id FROM projects WHERE subdomain = ?")
        .bind(crossOrganizationSubdomain)
        .first(),
    ).resolves.toBeNull();

    const created = await executeCodeMode(token, {
      method: "POST",
      path: "/api/shiplets",
      body: {
        name: "Agent-created Shiplet",
        subdomain: `agent-created-${crypto.randomUUID().slice(0, 8)}`,
        visibility: "private",
        assets: [
          {
            path: "index.html",
            content: btoa("<!doctype html><h1>Created by agent</h1>"),
          },
        ],
      },
    });
    expect(created.payload.result?.isError).not.toBe(true);
    const createResult = JSON.parse(created.text) as {
      project: { id: string; organization_id: string };
    };
    expect(createResult.project.organization_id).toBe(first.organization.id);
    const root = testEnv.SHIPLET_ROOT.getByName(createResult.project.id);
    await expect(root.health(createResult.project.id)).resolves.toMatchObject({
      reviewLayerActor: {
        kind: "agent",
        id: expect.stringMatching(/^workos-agent-registration:/),
      },
    });

    await testEnv.DB.prepare(
      "DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?",
    )
      .bind(first.organization.id, user["x-shiplet-user-id"])
      .run();
    const deauthorizedSubdomain = `former-member-${crypto.randomUUID().slice(0, 8)}`;
    const deauthorized = await executeCodeMode(token, {
      method: "POST",
      path: "/api/shiplets",
      body: {
        name: "Former member attempt",
        subdomain: deauthorizedSubdomain,
        visibility: "private",
        assets: [
          {
            path: "index.html",
            content: btoa("<!doctype html><h1>Denied</h1>"),
          },
        ],
      },
    });
    expect(deauthorized.payload.result?.isError).toBe(true);
    expect(deauthorized.text).toContain("Authorization denied");
    await expect(
      testEnv.DB.prepare("SELECT id FROM projects WHERE subdomain = ?")
        .bind(deauthorizedSubdomain)
        .first(),
    ).resolves.toBeNull();
  });
});

describe("WorkOS generated agent guide proxy", () => {
  it("retrieves bounded Markdown only from the configured AuthKit issuer", async () => {
    const requests: string[] = [];
    const redirectModes: Array<RequestRedirect | undefined> = [];
    const response = await proxyWorkOSAgentAuthGuide(
      {
        ...testEnv,
        SHIPLET_AUTH_MODE: "workos",
        WORKOS_AUTHKIT_ISSUER: "https://example.authkit.app/",
      } as unknown as Env,
      async (input, init) => {
        requests.push(String(input));
        redirectModes.push(init?.redirect);
        return new Response("# Register with Shiplet\n", {
          headers: { "content-type": "text/markdown" },
        });
      },
    );

    expect(requests).toEqual([
      "https://example.authkit.app/agent/auth.md",
    ]);
    expect(redirectModes).toEqual(["manual"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const guide = await response.text();
    expect(guide).toContain("# Register with Shiplet\n");
    expect(guide).toContain("## Shiplet MCP resource");
    expect(guide).toContain(
      '--data-urlencode "resource=https://shiplet.cc/api/mcp"',
    );
    expect(guide).toContain(
      "WorkOS places this URI in the access token audience",
    );
  });

  it("fails closed when the upstream guide exceeds the response bound", async () => {
    const response = await proxyWorkOSAgentAuthGuide(
      {
        ...testEnv,
        SHIPLET_AUTH_MODE: "workos",
        WORKOS_AUTHKIT_ISSUER: "https://example.authkit.app",
      } as unknown as Env,
      async () =>
        new Response("oversized", {
          headers: { "content-length": String(300 * 1024) },
        }),
    );
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe(
      "AuthKit agent guide is unavailable",
    );
  });
});
