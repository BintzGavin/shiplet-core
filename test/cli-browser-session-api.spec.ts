import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  approveCliAuthorizationRequest,
  authenticateCliSession,
  createCliAuthorizationRequest,
  exchangeCliAuthorizationCode,
} from "../src/cli-session";

const PRIVILEGED_PATHS = [
  "/api/drafts/draft_cli_reusable/promote",
  "/api/shiplets/project_cli_reusable/rollback",
  "/api/revisions/revision_cli_reusable/deployments",
];

const OWNER = {
  "x-shiplet-user-id": "user_cli_browser_session_owner",
  "x-shiplet-user-email": "cli-browser-session-owner@example.com",
};
const OUTSIDER = {
  "x-shiplet-user-id": "user_cli_browser_session_outsider",
  "x-shiplet-user-email": "cli-browser-session-outsider@example.com",
};

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

function hidden(html: string, name: string) {
  return html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] || "";
}

async function callbackFromHandoff(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
  const page = await response.text();
  expect(page).toContain("Authorization approved");
  expect(page).toContain("Return to CLI");
  expect(page).toContain("shiplet-brand-shell");
  expect(page).toContain('<span class="success-card-label">CLI access approved</span>');
  expect(page).toContain("this tab confirms the handoff");
  expect(page).toContain("If your browser says the page can't be reached");
  expect(page).toContain("noindex,nofollow,noarchive");
  const href = page.match(/<a id="cli-return-link"[^>]*href="([^"]+)"/)?.[1];
  expect(href).toBeTruthy();
  return new URL(href!.replace(/&amp;/g, "&"));
}

async function sha256Base64Url(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function databaseWithConcurrentExchangeBarrier(db: D1Database): D1Database {
  let readers = 0;
  let release: (() => void) | null = null;
  const bothReaders = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrap = (
    statement: D1PreparedStatement,
    exchangeSelection: boolean,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrap(target.bind(...values), exchangeSelection);
        }
        if (property === "first" && exchangeSelection) {
          return async (...values: unknown[]) => {
            readers += 1;
            if (readers === 2) release?.();
            await bothReaders;
            return values.length === 0
              ? target.first()
              : target.first(String(values[0]));
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) =>
          wrap(
            target.prepare(query),
            query.includes(
              "SELECT * FROM cli_authorization_requests WHERE code_hash",
            ),
          );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("CLI browser authorization session", () => {
  it("allows exactly one exchange when two PKCE exchanges race at the same timestamp", async () => {
    await request("/health");
    const now = new Date("2031-03-04T05:06:07.000Z");
    const userId = `user_cli_exchange_race_${crypto.randomUUID()}`;
    await (env as Env).DB.prepare(
      `INSERT INTO users (id, email, created_on, updated_on)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        userId,
        `${crypto.randomUUID()}@example.invalid`,
        now.toISOString(),
        now.toISOString(),
      )
      .run();
    const verifier = "r".repeat(64);
    const redirectUri = "http://127.0.0.1:43192/callback";
    const authorization = await createCliAuthorizationRequest((env as Env).DB, {
      userId,
      redirectUri,
      state: `state_${crypto.randomUUID().replace(/-/g, "")}`,
      codeChallenge: await sha256Base64Url(verifier),
      method: "S256",
      now,
    });
    if (!authorization) throw new Error("CLI authorization fixture failed");
    const approved = await approveCliAuthorizationRequest((env as Env).DB, {
      requestId: authorization.id,
      userId,
      now,
    });
    if (!approved) throw new Error("CLI approval fixture failed");
    const racedDb = databaseWithConcurrentExchangeBarrier((env as Env).DB);

    const results = await Promise.all([
      exchangeCliAuthorizationCode(racedDb, {
        code: approved.code,
        verifier,
        redirectUri,
        now,
      }),
      exchangeCliAuthorizationCode(racedDb, {
        code: approved.code,
        verifier,
        redirectUri,
        now,
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "replayed" },
    ]);
    await expect(
      (env as Env).DB.prepare(
        "SELECT COUNT(*) AS count FROM cli_sessions WHERE user_id = ?",
      )
        .bind(userId)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 1 });
  });

  it("binds loopback redirect, actor, state, PKCE, expiry, replay, and route scope", async () => {
    const organizationResponse = await request("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OWNER },
      body: JSON.stringify({ name: `CLI session ${crypto.randomUUID()}` }),
    });
    const org = ((await organizationResponse.json()) as { organization: { id: string } }).organization;
    const verifier = "v".repeat(64);
    const challenge = await sha256Base64Url(verifier);
    const state = `state_${crypto.randomUUID().replace(/-/g, "")}`;
    const redirectUri = "http://127.0.0.1:43191/callback";
    const authorize = await request(
      `/cli/authorize?${new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { headers: OWNER },
    );
    expect(authorize.status).toBe(200);
    const page = await authorize.text();
    expect(page).toContain("Authorize Shiplet CLI");
    expect(page).not.toContain(state);
    expect(page).not.toContain(challenge);
    const requestId = hidden(page, "request_id");
    expect(requestId).toMatch(/^cli_auth_/);

    const mixedUp = await request("/cli/authorize/complete", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OUTSIDER },
      body: new URLSearchParams({ request_id: requestId, approval: "approve" }),
    });
    expect(mixedUp.status).toBe(403);
    const approved = await request("/cli/authorize/complete", {
      method: "POST",
      redirect: "manual",
      headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
      body: new URLSearchParams({ request_id: requestId, approval: "approve" }),
    });
    expect(approved.headers.get("cache-control")).toBe("no-store");
    expect(approved.headers.get("pragma")).toBe("no-cache");
    expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
    const callback = await callbackFromHandoff(approved);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code") || "";
    expect(code).toMatch(/^shiplet_cli_code_/);

    const repeatedApproval = await request("/cli/authorize/complete", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded", ...OWNER },
      body: new URLSearchParams({ request_id: requestId, approval: "approve" }),
    });
    expect(repeatedApproval.status).toBe(403);

    const wrongPkce = await request("/api/cli/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier: "x".repeat(64), redirectUri }),
    });
    expect(wrongPkce.status).toBe(403);
    const exchange = await request("/api/cli/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier, redirectUri }),
    });
    expect(exchange.status).toBe(201);
    const session = (await exchange.json()) as { accessToken: string; expiresOn: string };
    expect(session.accessToken).toMatch(/^shiplet_cli_session_/);
    expect(Date.parse(session.expiresOn)).toBeGreaterThan(Date.now());
    const replay = await request("/api/cli/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier, redirectUri }),
    });
    expect(replay.status).toBe(409);

    const allowed = await request("/api/shiplets", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(allowed.status).toBe(200);
    const outOfScope = await request(`/api/organizations/${org.id}/api-tokens`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Must not work", scopes: ["shiplets:read"] }),
    });
    expect(outOfScope.status).toBe(401);

    await (env as Env).DB.prepare("UPDATE cli_sessions SET expires_on = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), OWNER["x-shiplet-user-id"])
      .run();
    const expired = await request("/api/shiplets", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(expired.status).toBe(401);
  });

  it("records credential-free immutable lifecycle events and lets the holder revoke its exact session", async () => {
    const verifier = "a".repeat(64);
    const challenge = await sha256Base64Url(verifier);
    const state = `state_${crypto.randomUUID().replace(/-/g, "")}`;
    const redirectUri = "http://127.0.0.1:43193/callback";
    const authorize = await request(
      `/cli/authorize?${new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { headers: OWNER },
    );
    const requestId = hidden(await authorize.text(), "request_id");
    const approved = await request("/cli/authorize/complete", {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...OWNER,
      },
      body: new URLSearchParams({ request_id: requestId, approval: "approve" }),
    });
    const code = (await callbackFromHandoff(approved)).searchParams.get("code");
    const exchange = await request("/api/cli/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier, redirectUri }),
    });
    const session = (await exchange.json()) as { accessToken: string };

    const revoked = await request("/api/cli/session/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(revoked.status).toBe(204);
    const deniedAfterRevoke = await request("/api/shiplets", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(deniedAfterRevoke.status).toBe(401);

    const events = await (env as Env).DB.prepare(
      `SELECT event_kind, summary, metadata_json
       FROM cli_session_audit_events
       WHERE user_id = ? AND authorization_request_id = ?
       ORDER BY occurred_on, sequence`,
    )
      .bind(OWNER["x-shiplet-user-id"], requestId)
      .all<{
        event_kind: string;
        summary: string;
        metadata_json: string;
      }>();
    expect(events.results.map((event) => event.event_kind)).toEqual([
      "cli.authorization.requested",
      "cli.authorization.approved",
      "cli.session.exchanged",
      "cli.session.revoked",
    ]);
    expect(
      JSON.stringify(events.results).toLowerCase(),
    ).not.toMatch(/access.?token|bearer|code.?challenge|code.?hash|redirect.?uri|secret|session.?hash|state.?value|verifier/);
    await expect(
      (env as Env).DB.prepare(
        `UPDATE cli_session_audit_events SET summary = 'changed'
         WHERE authorization_request_id = ?`,
      )
        .bind(requestId)
        .run(),
    ).rejects.toThrow(/immutable/i);
  });

  async function approvedSession(
    sessionTtl: string | null,
    port: number,
    headers: Record<string, string> = OWNER,
  ) {
    const verifier = "s".repeat(64);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state: `state_${crypto.randomUUID().replace(/-/g, "")}`,
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: "S256",
    });
    if (sessionTtl !== null) params.set("session_ttl", sessionTtl);
    const authorize = await request(`/cli/authorize?${params}`, { headers });
    expect(authorize.status).toBe(200);
    const page = await authorize.text();
    const approved = await request("/cli/authorize/complete", {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: "http://localhost",
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams({ request_id: hidden(page, "request_id"), approval: "approve" }),
    });
    const code = (await callbackFromHandoff(approved)).searchParams.get("code");
    const exchange = await request("/api/cli/session/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier, redirectUri }),
    });
    expect(exchange.status).toBe(201);
    const session = (await exchange.json()) as { accessToken: string; expiresOn: string };
    return { page, session };
  }

  it("issues a reusable session for the requested lifetime that can deploy, promote, and roll back", async () => {
    const before = Date.now();
    const { page, session } = await approvedSession("7200", 43194);
    expect(page).toContain("up to 2 hours");
    expect(page).toContain("shiplet logout");
    expect(page).toContain("explicitly asks with <code>--approve</code>");
    const lifetime = Date.parse(session.expiresOn) - before;
    expect(lifetime).toBeGreaterThan(7190_000);
    expect(lifetime).toBeLessThanOrEqual(7200_000 + 5_000);

    const exchanged = await (env as Env).DB.prepare(
      `SELECT metadata_json FROM cli_session_audit_events
       WHERE user_id = ? AND event_kind = 'cli.session.exchanged'
       ORDER BY sequence DESC LIMIT 1`,
    )
      .bind(OWNER["x-shiplet-user-id"])
      .first<{ metadata_json: string }>();
    expect(JSON.parse(exchanged!.metadata_json)).toMatchObject({ reusable: true, ttlSeconds: 7200 });

    const status = await request("/api/cli/session", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    const described = (await status.json()) as {
      account: { id: string; email: string };
      expiresOn: string;
      scopes: string[];
    };
    expect(described.account).toEqual({
      id: OWNER["x-shiplet-user-id"],
      email: OWNER["x-shiplet-user-email"],
    });
    expect(described.expiresOn).toBe(session.expiresOn);
    expect(described.scopes).toContain("deployment:write");
    expect(JSON.stringify(described)).not.toContain(session.accessToken);

    const reused = await request("/api/shiplets", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(reused.status).toBe(200);
    // The privileged routes resolve their record before authenticating, so
    // assert at the session boundary: the reusable session is the human there.
    for (const path of PRIVILEGED_PATHS) {
      await expect(
        authenticateCliSession(
          (env as Env).DB,
          new Request(`https://shiplet.cc${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
          }),
        ),
      ).resolves.toBe(OWNER["x-shiplet-user-id"]);
    }

  });

  it("revokes a reusable session immediately for every route", async () => {
    const { session } = await approvedSession("3600", 43195);
    const revoke = await request("/api/cli/session/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(revoke.status).toBe(204);
    for (const path of ["/api/cli/session", "/api/shiplets"]) {
      const denied = await request(path, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
      expect(denied.status).toBe(401);
    }
    for (const path of PRIVILEGED_PATHS) {
      await expect(
        authenticateCliSession(
          (env as Env).DB,
          new Request(`https://shiplet.cc${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
          }),
        ),
      ).resolves.toBeNull();
    }
    const secondRevoke = await request("/api/cli/session/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(secondRevoke.status).toBe(401);
  });

  it("reports an expired reusable session as unavailable", async () => {
    const { session } = await approvedSession("3600", 43196);
    await (env as Env).DB.prepare(
      "UPDATE cli_sessions SET expires_on = ? WHERE user_id = ? AND expires_on > ?",
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), OWNER["x-shiplet-user-id"], new Date().toISOString())
      .run();
    const status = await request("/api/cli/session", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(status.status).toBe(401);
  });

  it("clamps a requested lifetime to the server's 8 hour maximum", async () => {
    const before = Date.now();
    const { page, session } = await approvedSession("999999", 43197);
    expect(page).toContain("up to 8 hours");
    expect(Date.parse(session.expiresOn) - before).toBeLessThanOrEqual(8 * 3600_000 + 5_000);
    expect(Date.parse(session.expiresOn) - before).toBeGreaterThan(8 * 3600_000 - 10_000);
  });

  it("keeps the single-command session at ten minutes with deploy authority and no status access", async () => {
    const before = Date.now();
    const { page, session } = await approvedSession(null, 43198);
    expect(page).toContain("up to ten minutes, revoked when the command finishes");
    expect(Date.parse(session.expiresOn) - before).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    const status = await request("/api/cli/session", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(status.status).toBe(401);
    const scopes = await (env as Env).DB.prepare(
      "SELECT scopes_json FROM cli_sessions WHERE expires_on = ?",
    )
      .bind(session.expiresOn)
      .first<{ scopes_json: string }>();
    expect(JSON.parse(scopes!.scopes_json)).toContain("deployment:write");
  });

  it.each(["abc", "-1", "1.5", "1234567"])(
    "rejects a malformed session lifetime: %s",
    async (sessionTtl) => {
      const response = await request(
        `/cli/authorize?${new URLSearchParams({
          redirect_uri: "http://127.0.0.1:43199/callback",
          state: `state_${"a".repeat(32)}`,
          code_challenge: "b".repeat(43),
          code_challenge_method: "S256",
          session_ttl: sessionTtl,
        })}`,
        { headers: OWNER },
      );
      expect(response.status).toBe(400);
    },
  );

  it("does not describe a session without a CLI bearer", async () => {
    for (const headers of [
      {},
      OWNER,
      { Authorization: "Bearer shiplet_cli_session_invalid" },
    ] as Array<Record<string, string>>) {
      const response = await request("/api/cli/session", { headers });
      expect(response.status).toBe(401);
    }
  });

  async function createWorkspace(headers: Record<string, string>, label: string) {
    const name = `CLI ${label} ${crypto.randomUUID()}`;
    const created = await request("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ name }),
    });
    expect(created.status).toBe(201);
    const { organization } = (await created.json()) as {
      organization: { id: string };
    };
    return { id: organization.id, name };
  }

  async function twoWorkspaceMember(port: number) {
    const member = {
      "x-shiplet-user-id": `user_cli_two_workspaces_${crypto.randomUUID().replace(/-/g, "")}`,
      "x-shiplet-user-email": `cli-two-workspaces-${crypto.randomUUID()}@example.com`,
    };
    const workspaces = [
      await createWorkspace(member, "Design"),
      await createWorkspace(member, "Research"),
    ];
    const { session } = await approvedSession("7200", port, member);
    const html = "<h1>Two workspace review</h1>";
    // The body `shiplet prepare` sends, before and after it names a workspace.
    const payload = {
      name: "Two workspace review",
      subdomain: `cli-two-workspaces-${crypto.randomUUID().slice(0, 8)}`,
      visibility: "organization",
      assets: [{ path: "index.html", content: btoa(html), size: html.length }],
    };
    const publish = (
      body: Record<string, unknown>,
      headers: Record<string, string> = {},
      bearer = session.accessToken,
    ) =>
      request("/api/shiplets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
    return { member, workspaces, payload, publish };
  }

  const byId = (left: { id: string }, right: { id: string }) =>
    left.id.localeCompare(right.id);

  it("asks a CLI session in two workspaces to name one, then publishes into the named workspace", async () => {
    const { workspaces, payload, publish } = await twoWorkspaceMember(43200);

    const unnamed = await publish(payload);
    expect(unnamed.status).toBe(400);
    // Browsers and older CLIs that do not ask for JSON keep exactly this text.
    expect(await unnamed.text()).toBe("Missing required fields: organization_id");

    const named = await publish({ ...payload, organization_id: workspaces[1].id });
    expect(named.status).toBe(201);
    const published = (await named.json()) as {
      project: { organization_id: string };
    };
    expect(published.project.organization_id).toBe(workspaces[1].id);
  });

  it("lists exactly the caller's own workspaces when a session asking for JSON publishes without naming one", async () => {
    const outsider = {
      "x-shiplet-user-id": `user_cli_outsider_${crypto.randomUUID().replace(/-/g, "")}`,
      "x-shiplet-user-email": `cli-outsider-${crypto.randomUUID()}@example.com`,
    };
    const unrelated = await createWorkspace(outsider, "Unrelated");
    const { workspaces, payload, publish } = await twoWorkspaceMember(43201);

    const unnamed = await publish(payload, { Accept: "application/json" });
    expect(unnamed.status).toBe(400);
    expect(unnamed.headers.get("content-type")).toContain("application/json");
    const body = (await unnamed.json()) as {
      ok: boolean;
      code: string;
      error: string;
      organizations: Array<{ id: string; name: string }>;
    };
    expect(body).toMatchObject({
      ok: false,
      code: "organization_required",
      error: "Missing required fields: organization_id",
    });
    expect([...body.organizations].sort(byId)).toEqual(
      [...workspaces].sort(byId),
    );
    expect(JSON.stringify(body)).not.toContain(unrelated.id);
    expect(JSON.stringify(body)).not.toContain(unrelated.name);
  });

  it("never lists workspaces to an organization key, which publishes into its own", async () => {
    const { member, workspaces, payload, publish } = await twoWorkspaceMember(43202);
    const minted = await request(`/api/organizations/${workspaces[0].id}/api-tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...member },
      body: JSON.stringify({
        name: `CLI key ${crypto.randomUUID().slice(0, 8)}`,
        scopes: ["shiplets:read", "shiplets:write"],
        projectAccessMode: "all",
      }),
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };

    const published = await publish(payload, { Accept: "application/json" }, token);
    expect(published.status).toBe(201);
    const body = (await published.json()) as {
      organizations?: unknown;
      project: { organization_id: string };
    };
    expect(body.project.organization_id).toBe(workspaces[0].id);
    expect(body.organizations).toBeUndefined();
  });

  it.each([
    "https://attacker.example/callback",
    "http://localhost:43191/callback",
    "http://127.0.0.1:43191/not-callback",
  ])("rejects an unsafe or non-canonical loopback redirect: %s", async (redirectUri) => {
    const response = await request(
      `/cli/authorize?${new URLSearchParams({
        redirect_uri: redirectUri,
        state: `state_${"a".repeat(32)}`,
        code_challenge: "b".repeat(43),
        code_challenge_method: "S256",
      })}`,
      { headers: OWNER },
    );
    expect(response.status).toBe(400);
  });
});
