import assert from "node:assert/strict";
import crypto from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createSessionCache } = require("../src/cli/session-cache.cjs");
const { parseSessionTtl } = require("../src/cli/shiplet.cjs");

const ORIGIN = "http://127.0.0.1:43211";
const OTHER_ORIGIN = "http://127.0.0.1:43212";
const ACCOUNT = { id: "user_cli_cache", email: "cli-cache@example.com" };

function token() {
  return `shiplet_cli_session_${crypto.randomBytes(32).toString("hex")}`;
}

function captureOutput() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, value: () => value };
}

async function configDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shiplet-cli-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "config");
}

// A fake Shiplet server: tracks live sessions, answers the session status and
// revoke routes, and records which bearer reached each operation.
function fakeServer({ account = ACCOUNT, ttlMs = 2 * 60 * 60_000 } = {}) {
  const live = new Map();
  const calls = [];
  const server = {
    live,
    calls,
    authorizations: 0,
    commandSessions: 0,
    issue() {
      const accessToken = token();
      live.set(accessToken, { account, expiresOn: new Date(Date.now() + ttlMs).toISOString() });
      return accessToken;
    },
    async authorize({ apiUrl, sessionTtlSeconds }) {
      server.authorizations += 1;
      server.lastTtl = sessionTtlSeconds;
      const accessToken = server.issue();
      return { apiUrl, accessToken, expiresOn: live.get(accessToken).expiresOn };
    },
    async commandSession({ apiUrl }) {
      server.commandSessions += 1;
      const commandFetch = async () => new Response("{}", { status: 200 });
      commandFetch.revoke = async () => {};
      commandFetch.apiUrl = apiUrl;
      return commandFetch;
    },
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      const bearer = (new Headers(init.headers).get("authorization") || "").replace(/^Bearer /, "");
      calls.push({ origin: parsed.origin, path: parsed.pathname, method: init.method || "GET", bearer });
      const session = live.get(bearer);
      if (parsed.pathname === "/api/cli/session") {
        if (!session) return new Response("CLI session unavailable", { status: 401 });
        return new Response(JSON.stringify({ ...session, createdOn: new Date().toISOString(), scopes: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/api/cli/session/revoke") {
        if (!session) return new Response("CLI session unavailable", { status: 401 });
        live.delete(bearer);
        return new Response(null, { status: 204 });
      }
      if (!session) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return server;
}

function cacheFor(server, directory, extraEnv = {}) {
  return createSessionCache({
    env: { SHIPLET_CLI_SESSION_STORE: "file", SHIPLET_CONFIG_DIR: directory, ...extraEnv },
    platform: process.platform,
    authorize: (options) => server.authorize(options),
    commandSession: (options) => server.commandSession(options),
  });
}

async function bootstrap(cache, server, overrides = {}) {
  return cache.bootstrap({
    apiUrl: ORIGIN,
    fetch: (url, init) => server.fetch(url, init),
    stdout: overrides.stdout || captureOutput(),
    sessionCache: true,
    sessionTtlSeconds: 7200,
    ...overrides,
  });
}

function sessionsFile(directory) {
  return path.join(directory, "cli-sessions.json");
}

test("session lifetime accepts hour and minute forms within the 5 minute to 8 hour bounds", () => {
  assert.equal(parseSessionTtl(undefined), 7200);
  assert.equal(parseSessionTtl("2h"), 7200);
  assert.equal(parseSessionTtl("90m"), 5400);
  assert.equal(parseSessionTtl("1h30m"), 5400);
  assert.equal(parseSessionTtl("3600"), 3600);
  assert.equal(parseSessionTtl("8h"), 28800);
  assert.throws(() => parseSessionTtl("9h"), /between 5 minutes and 8 hours/);
  assert.throws(() => parseSessionTtl("1m"), /between 5 minutes and 8 hours/);
  assert.throws(() => parseSessionTtl("two hours"), /must look like/);
});

test("one browser approval is reused by later commands within its lifetime", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  const output = captureOutput();

  const first = await bootstrap(cacheFor(server, directory), server, { stdout: output });
  assert.equal(server.authorizations, 1);
  assert.equal(server.lastTtl, 7200);
  assert.equal(first.revoke, undefined, "a cached session must not be revoked when a command finishes");
  await first(`${ORIGIN}/api/shiplets`);

  // A new process: a fresh cache instance reading the same store.
  for (let command = 0; command < 4; command += 1) {
    const reused = await bootstrap(cacheFor(server, directory), server, { stdout: output });
    await reused(`${ORIGIN}/api/shiplets`);
  }
  assert.equal(server.authorizations, 1, "five commands needed one approval");
  const bearers = new Set(server.calls.filter((call) => call.path === "/api/shiplets").map((call) => call.bearer));
  assert.equal(bearers.size, 1);
  assert.equal(server.calls.filter((call) => call.path === "/api/cli/session/revoke").length, 0);

  const directoryMode = (await stat(directory)).mode & 0o777;
  const fileMode = (await stat(sessionsFile(directory))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(fileMode, 0o600);
  assert.doesNotMatch(output.value(), /shiplet_cli_session_/);
});

test("an expired or nearly expired cached session is discarded and a new approval is requested", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  await bootstrap(cacheFor(server, directory), server);
  const stored = JSON.parse(await readFile(sessionsFile(directory), "utf8"));
  stored.sessions[ORIGIN].expiresOn = new Date(Date.now() + 30_000).toISOString();
  await writeFile(sessionsFile(directory), JSON.stringify(stored), { mode: 0o600 });

  await bootstrap(cacheFor(server, directory), server);
  assert.equal(server.authorizations, 2);
  const refreshed = JSON.parse(await readFile(sessionsFile(directory), "utf8"));
  assert.ok(Date.parse(refreshed.sessions[ORIGIN].expiresOn) > Date.now() + 60 * 60_000);
});

test("a session revoked on the server is not reused and is deleted locally", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  const output = captureOutput();
  await bootstrap(cacheFor(server, directory), server);
  server.live.clear();

  await bootstrap(cacheFor(server, directory), server, { stdout: output });
  assert.equal(server.authorizations, 2);
  assert.match(output.value(), /saved Shiplet CLI session has ended/);
});

test("a revocation that lands mid-command makes the next command ask again", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  const sessionFetch = await bootstrap(cacheFor(server, directory), server);
  server.live.clear();
  const response = await sessionFetch(`${ORIGIN}/api/shiplets`);
  assert.equal(response.status, 401);
  await assert.rejects(readFile(sessionsFile(directory), "utf8"), { code: "ENOENT" });
});

test("a session is pinned to its exact origin and account", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  const sessionFetch = await bootstrap(cacheFor(server, directory), server);
  await assert.rejects(sessionFetch(`${OTHER_ORIGIN}/api/shiplets`), /outside the Shiplet API origin/);
  await assert.rejects(sessionFetch("https://attacker.example/collect"), /outside the Shiplet API origin/);

  // Another origin never sees this origin's session.
  const [originToken] = [...server.live.keys()];
  await bootstrap(cacheFor(server, directory), server, { apiUrl: OTHER_ORIGIN });
  assert.equal(server.authorizations, 2);
  assert.ok(!server.calls.some((call) => call.origin === OTHER_ORIGIN && call.bearer === originToken));

  // A record filed under the wrong origin is rejected, not sent.
  const stored = JSON.parse(await readFile(sessionsFile(directory), "utf8"));
  const misfiled = { ...stored.sessions[ORIGIN] };
  stored.sessions[OTHER_ORIGIN] = misfiled;
  await writeFile(sessionsFile(directory), JSON.stringify(stored), { mode: 0o600 });
  const beforeCalls = server.calls.length;
  await bootstrap(cacheFor(server, directory), server, { apiUrl: OTHER_ORIGIN });
  assert.equal(server.authorizations, 3);
  assert.ok(!server.calls.slice(beforeCalls).some((call) => call.bearer === misfiled.accessToken));

  // The server reporting a different account for the token voids the cache.
  const accountServer = fakeServer();
  const accountDir = await configDir(t);
  await bootstrap(cacheFor(accountServer, accountDir), accountServer);
  for (const session of accountServer.live.values()) session.account = { id: "user_other", email: "other@example.com" };
  await bootstrap(cacheFor(accountServer, accountDir), accountServer);
  assert.equal(accountServer.authorizations, 2);
});

test("a missing, corrupted, or unsafe cache file falls back to a new approval", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();

  // Missing.
  await bootstrap(cacheFor(server, directory), server);
  assert.equal(server.authorizations, 1);

  // Corrupted JSON.
  await writeFile(sessionsFile(directory), "{not json", { mode: 0o600 });
  const corruptOutput = captureOutput();
  await bootstrap(cacheFor(server, directory), server, { stdout: corruptOutput });
  assert.equal(server.authorizations, 2);
  assert.match(corruptOutput.value(), /Ignored an unreadable saved Shiplet CLI session/);
  const repaired = JSON.parse(await readFile(sessionsFile(directory), "utf8"));
  assert.match(repaired.sessions[ORIGIN].accessToken, /^shiplet_cli_session_/);

  // A record with a malformed token.
  repaired.sessions[ORIGIN].accessToken = "not-a-session";
  await writeFile(sessionsFile(directory), JSON.stringify(repaired), { mode: 0o600 });
  await bootstrap(cacheFor(server, directory), server);
  assert.equal(server.authorizations, 3);

  // Readable by other users.
  await chmod(sessionsFile(directory), 0o644);
  const unsafeOutput = captureOutput();
  await bootstrap(cacheFor(server, directory), server, { stdout: unsafeOutput });
  assert.equal(server.authorizations, 4);
  assert.match(unsafeOutput.value(), /other users could read/);
  assert.equal((await stat(sessionsFile(directory))).mode & 0o777, 0o600);
});

test("logout revokes the session on the server and deletes it locally", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  const sessionFetch = await bootstrap(cacheFor(server, directory), server);
  await sessionFetch(`${ORIGIN}/api/shiplets`);
  const [issued] = [...server.live.keys()];

  const cache = cacheFor(server, directory);
  const status = await cache.status({ apiUrl: ORIGIN, fetch: (u, i) => server.fetch(u, i) });
  assert.equal(status.account.email, ACCOUNT.email);
  assert.equal(status.origin, ORIGIN);
  assert.equal(status.storage, sessionsFile(directory));
  assert.ok(!JSON.stringify(status).includes(issued));

  const result = await cache.logout({ apiUrl: ORIGIN, fetch: (u, i) => server.fetch(u, i) });
  assert.equal(result.revocation, "revoked");
  assert.equal(server.live.has(issued), false, "the server rejects the session immediately");
  await assert.rejects(readFile(sessionsFile(directory), "utf8"), { code: "ENOENT" });
  assert.equal(await cache.status({ apiUrl: ORIGIN, fetch: (u, i) => server.fetch(u, i) }), null);

  const again = await cache.logout({ apiUrl: ORIGIN, fetch: (u, i) => server.fetch(u, i) });
  assert.equal(again.revocation, "none");
});

test("logout still deletes the local session when the server cannot confirm revocation", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  await bootstrap(cacheFor(server, directory), server);
  const result = await cacheFor(server, directory).logout({
    apiUrl: ORIGIN,
    fetch: async () => { throw new Error("offline"); },
  });
  assert.equal(result.revocation, "unconfirmed");
  await assert.rejects(readFile(sessionsFile(directory), "utf8"), { code: "ENOENT" });
});

test("the per-command opt-outs never read or write the cache", { skip: process.platform === "win32" }, async (t) => {
  const directory = await configDir(t);
  const server = fakeServer();
  await bootstrap(cacheFor(server, directory), server);
  const cached = await readFile(sessionsFile(directory), "utf8");

  const flagged = await bootstrap(cacheFor(server, directory), server, { sessionCache: false });
  assert.equal(typeof flagged.revoke, "function", "a per-command session is revoked after its command");
  await bootstrap(cacheFor(server, directory, { SHIPLET_CLI_SESSION_CACHE: "0" }), server);
  assert.equal(server.commandSessions, 2);
  assert.equal(server.authorizations, 1);
  assert.equal(await readFile(sessionsFile(directory), "utf8"), cached);
});
