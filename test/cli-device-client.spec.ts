// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { authorizeWithDeviceCode } = require("../src/cli/device-session.cjs") as {
  authorizeWithDeviceCode: (options: Record<string, unknown>) => Promise<{ apiUrl: string; accessToken: string; expiresOn: string }>;
};
const { createSessionCache } = require("../src/cli/session-cache.cjs") as {
  createSessionCache: (options: Record<string, unknown>) => { login: (options: Record<string, unknown>) => Promise<Record<string, any>> };
};

const DEVICE_CODE = `shiplet_cli_device_${"a".repeat(64)}`;
const TOKEN = `shiplet_cli_session_${"b".repeat(64)}`;

function output() {
  let text = "";
  return { stream: { write: (chunk: string) => ((text += chunk), true) }, read: () => text };
}

function deviceServer(polls: Array<{ status: number; body: Record<string, unknown> }>, start: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body || "") });
    if (url.endsWith("/api/cli/device/authorize")) {
      return Response.json(
        { deviceCode: DEVICE_CODE, userCode: "BCDF-GHJK", verificationUri: "https://shiplet.test/cli/device", expiresIn: 600, interval: 5, ...start },
        { status: 201 },
      );
    }
    if (url.endsWith("/api/cli/device/token")) {
      const next = polls.shift() || { status: 400, body: { error: "authorization_pending" } };
      return Response.json(next.body, { status: next.status });
    }
    if (url.endsWith("/api/cli/session")) {
      return Response.json({ account: { id: "user_1", email: "dev@example.com" }, expiresOn: new Date(Date.now() + 3600_000).toISOString() });
    }
    return new Response("no stub", { status: 404 });
  };
  return { fetch, calls };
}

function clock() {
  let time = Date.parse("2026-11-18T12:00:00Z");
  const waits: number[] = [];
  return { now: () => time, sleep: async (ms: number) => void (waits.push(ms), (time += ms)), waits };
}

describe("shiplet login --device (client)", () => {
  it("shows the code and page, waits for approval, and backs off on slow_down", async () => {
    const expiresOn = new Date(Date.parse("2026-11-18T14:00:00Z")).toISOString();
    const server = deviceServer([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 201, body: { accessToken: TOKEN, expiresOn } },
    ]);
    const time = clock();
    const stdout = output();
    const session = await authorizeWithDeviceCode({ apiUrl: "https://shiplet.test", fetch: server.fetch, stdout: stdout.stream, sessionTtlSeconds: 3600, ...time });
    expect(session).toEqual({ apiUrl: "https://shiplet.test", accessToken: TOKEN, expiresOn });
    expect(stdout.read()).toContain("https://shiplet.test/cli/device");
    expect(stdout.read()).toContain("BCDF-GHJK");
    expect(stdout.read()).not.toContain(TOKEN);
    expect(JSON.parse(server.calls[0].body)).toEqual({ sessionTtl: 3600 });
    expect(time.waits).toEqual([5000, 5000, 10000]);
  });

  it("stops on denial, expiry, or a sign-in page on another site", async () => {
    const run = (polls: Array<{ status: number; body: Record<string, unknown> }>, start: Record<string, unknown> = {}) =>
      authorizeWithDeviceCode({ apiUrl: "https://shiplet.test", fetch: deviceServer(polls, start).fetch, stdout: output().stream, ...clock() });
    await expect(run([{ status: 400, body: { error: "access_denied" } }])).rejects.toThrow("denied");
    await expect(run([{ status: 400, body: { error: "expired_token" } }])).rejects.toThrow("expired");
    await expect(run([], { verificationUri: "https://phish.example/cli/device" })).rejects.toThrow("different site");
    // pending forever runs out at the code's expiry
    await expect(run([], { expiresIn: 20 })).rejects.toThrow("expired");
  });

  it("saves the device session like a browser login", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const store = {
      load: async () => null,
      save: async (_origin: string, record: Record<string, unknown>) => (saved.push(record), "test store"),
      remove: async () => undefined,
    };
    let browserUsed = false;
    const cache = createSessionCache({
      store,
      authorize: async () => {
        browserUsed = true;
        throw new Error("browser");
      },
      deviceAuthorize: async (options: { apiUrl: string }) => ({ apiUrl: options.apiUrl, accessToken: TOKEN, expiresOn: new Date(Date.now() + 3600_000).toISOString() }),
    });
    const server = deviceServer([]);
    const result = await cache.login({ apiUrl: "https://shiplet.test", fetch: server.fetch, stdout: output().stream, device: true });
    expect(browserUsed).toBe(false);
    expect(result).toMatchObject({ reused: false, account: { email: "dev@example.com" }, storage: "test store" });
    expect(saved[0]).toMatchObject({ accessToken: TOKEN, origin: "https://shiplet.test" });
  });
});
