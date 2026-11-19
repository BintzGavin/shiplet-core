import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import { createDeviceAuthorization, pollDeviceAuthorization } from "../src/cli-device";

const OWNER = {
  "x-shiplet-user-id": "user_cli_device_owner",
  "x-shiplet-user-email": "cli-device-owner@example.com",
};
const FORM = { Origin: "http://localhost", "Content-Type": "application/x-www-form-urlencoded" };
const JSON_HEADERS = { "Content-Type": "application/json" };

async function request(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(`http://localhost${path}`, init), env as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

async function start(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  const response = await request("/api/cli/device/authorize", { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
  return { response, body: (await response.json()) as Record<string, any> };
}

const poll = async (deviceCode: string) => {
  const response = await request("/api/cli/device/token", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ deviceCode }) });
  return { status: response.status, body: (await response.json()) as Record<string, any>, cache: response.headers.get("cache-control") };
};

const hidden = (html: string, name: string) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1] || "";

describe("CLI device sign-in", () => {
  it("issues a reusable CLI session after the person types the code and approves", async () => {
    const started = await start({}, { sessionTtl: 3600 });
    expect(started.response.status).toBe(201);
    expect(started.response.headers.get("cache-control")).toBe("no-store");
    const { deviceCode, userCode, verificationUri, interval, expiresIn } = started.body;
    expect(deviceCode).toMatch(/^shiplet_cli_device_[a-f0-9]{64}$/);
    expect(userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(verificationUri).toBe("http://localhost/cli/device");
    expect(verificationUri).not.toContain(userCode);
    expect({ interval, expiresIn }).toEqual({ interval: 5, expiresIn: 600 });

    expect((await poll(deviceCode)).body.error).toBe("authorization_pending");
    expect((await poll(deviceCode)).body.error).toBe("slow_down");

    // signed out, the page sends the person to sign in first
    const signedOut = await request("/cli/device", { redirect: "manual" });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toContain("/auth/login?return_to=%2Fcli%2Fdevice");
    const page = await request("/cli/device", { headers: OWNER });
    expect(await page.text()).toContain('name="user_code"');

    const crossSite = await request("/cli/device/confirm", {
      method: "POST",
      headers: { ...FORM, Origin: "https://attacker.example", ...OWNER },
      body: new URLSearchParams({ user_code: userCode }),
    });
    expect(crossSite.status).toBe(403);
    const wrong = await request("/cli/device/confirm", { method: "POST", headers: { ...FORM, ...OWNER }, body: new URLSearchParams({ user_code: "BCDF-BCDF" }) });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("That code is not valid");

    // what a person types: lower case, no dash
    const confirm = await request("/cli/device/confirm", {
      method: "POST",
      headers: { ...FORM, ...OWNER },
      body: new URLSearchParams({ user_code: userCode.replace("-", "").toLowerCase() }),
    });
    expect(confirm.status).toBe(200);
    const confirmHtml = await confirm.text();
    expect(confirmHtml).toContain("Approve CLI sign-in?");
    expect(confirmHtml).toContain(OWNER["x-shiplet-user-email"]);
    expect(confirmHtml).toContain(userCode);
    expect(confirmHtml).toContain("1 hour");
    const deviceId = hidden(confirmHtml, "device_id");
    expect(deviceId).toMatch(/^cli_device_[a-f0-9]{32}$/);

    const approved = await request("/cli/device/complete", {
      method: "POST",
      headers: { ...FORM, ...OWNER },
      body: new URLSearchParams({ device_id: deviceId, approval: "approve" }),
    });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain("CLI approved");
    const again = await request("/cli/device/complete", {
      method: "POST",
      headers: { ...FORM, ...OWNER },
      body: new URLSearchParams({ device_id: deviceId, approval: "approve" }),
    });
    expect(again.status).toBe(403);

    const issued = await poll(deviceCode);
    expect(issued.status).toBe(201);
    expect(issued.cache).toBe("no-store");
    expect(issued.body.accessToken).toMatch(/^shiplet_cli_session_[A-Za-z0-9]{32,200}$/);
    const lifetime = Date.parse(issued.body.expiresOn) - Date.now();
    expect(lifetime).toBeGreaterThan(3500_000);
    expect(lifetime).toBeLessThanOrEqual(3600_000);
    // the device code works once
    expect((await poll(deviceCode)).body.error).toBe("invalid_grant");

    const session = await request("/api/cli/session", { headers: { Authorization: `Bearer ${issued.body.accessToken}` } });
    expect(session.status).toBe(200);
    const described = (await session.json()) as { account: { id: string } };
    expect(described.account.id).toBe(OWNER["x-shiplet-user-id"]);

    const audit = await (env as Env).DB.prepare(
      `SELECT event_kind, metadata_json FROM cli_session_audit_events e
        JOIN cli_device_authorizations d ON d.authorization_request_id = e.authorization_request_id
       WHERE d.id = ? ORDER BY e.sequence`,
    )
      .bind(deviceId)
      .all<{ event_kind: string; metadata_json: string }>();
    expect(audit.results.map((row) => row.event_kind)).toEqual(["cli.authorization.requested", "cli.authorization.approved", "cli.session.exchanged"]);
    expect(audit.results.every((row) => JSON.parse(row.metadata_json).flow === "device")).toBe(true);

    // logout revokes it like any CLI session
    const revoked = await request("/api/cli/session/revoke", { method: "POST", headers: { Authorization: `Bearer ${issued.body.accessToken}` } });
    expect(revoked.status).toBe(204);
    expect((await request("/api/cli/session", { headers: { Authorization: `Bearer ${issued.body.accessToken}` } })).status).toBe(401);
  });

  it("tells the CLI when the person denies, and when the code expires", async () => {
    const started = await start();
    const confirm = await request("/cli/device/confirm", { method: "POST", headers: { ...FORM, ...OWNER }, body: new URLSearchParams({ user_code: started.body.userCode }) });
    const deviceId = hidden(await confirm.text(), "device_id");
    const denied = await request("/cli/device/complete", { method: "POST", headers: { ...FORM, ...OWNER }, body: new URLSearchParams({ device_id: deviceId, approval: "deny" }) });
    expect(await denied.text()).toContain("Sign-in denied");
    expect((await poll(started.body.deviceCode)).body.error).toBe("access_denied");

    const db = (env as Env).DB;
    const old = new Date(Date.now() - 11 * 60_000);
    const stale = await createDeviceAuthorization(db, { now: old });
    if (!stale.ok) throw new Error("expected a device authorization");
    expect(await pollDeviceAuthorization(db, { deviceCode: stale.deviceCode })).toEqual({ ok: false, error: "expired_token" });
    const late = await request("/cli/device/confirm", { method: "POST", headers: { ...FORM, ...OWNER }, body: new URLSearchParams({ user_code: stale.userCode }) });
    expect(late.status).toBe(400);
    expect((await poll("shiplet_cli_device_nope")).body.error).toBe("invalid_grant");
  });

  it("limits pending sign-ins per network and validates input", async () => {
    const address = { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
    for (let index = 0; index < 5; index++) expect((await start(address)).response.status).toBe(201);
    const limited = await start(address);
    expect(limited.response.status).toBe(429);
    expect(limited.body.error).toBe("too_many_requests");
    expect((await start({}, { sessionTtl: -1 })).response.status).toBe(400);
    const text = await request("/api/cli/device/authorize", { method: "POST", body: "x" });
    expect(text.status).toBe(415);
    // the lifetime is clamped to the reusable session bounds
    expect((await start({}, { sessionTtl: 999999 })).body.sessionTtlSeconds).toBe(8 * 60 * 60);
    expect((await start()).body.sessionTtlSeconds).toBe(2 * 60 * 60);
  });
});
