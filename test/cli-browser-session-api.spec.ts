import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import {
  approveCliAuthorizationRequest,
  createCliAuthorizationRequest,
  exchangeCliAuthorizationCode,
} from "../src/cli-session";

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
    expect(approved.status).toBe(302);
    expect(approved.headers.get("cache-control")).toBe("no-store");
    expect(approved.headers.get("pragma")).toBe("no-cache");
    expect(approved.headers.get("referrer-policy")).toBe("no-referrer");
    const callback = new URL(approved.headers.get("location") || "");
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code") || "";
    expect(code).toMatch(/^shiplet_cli_code_/);

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
    const code = new URL(approved.headers.get("location") || "").searchParams.get("code");
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
