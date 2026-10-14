import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { createBrowserSessionFetch } = require("../src/cli/browser-session.cjs");
const { LOOPBACK_TOKENS, SHIPLET_MARK_SVG } = require("../src/cli/auth-page.cjs");

function sessionPayload() {
  return {
    accessToken: `shiplet_cli_session_${crypto.randomBytes(48).toString("hex")}`,
    expiresOn: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

function captureOutput() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, value: () => value };
}

test("loopback authorization shows styled completion and recovery pages without exposing callback data", async () => {
  for (const valid of [true, false]) {
    let callbackResponse;
    const session = createBrowserSessionFetch({
      apiUrl: "http://127.0.0.1:43111",
      stdout: captureOutput(),
      fetch: async () => new Response(JSON.stringify(sessionPayload()), { status: 201 }),
      openBrowser(authorizeValue) {
        const authorize = new URL(authorizeValue);
        const callback = new URL(authorize.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", `shiplet_cli_code_${"a".repeat(64)}`);
        callback.searchParams.set("state", valid ? authorize.searchParams.get("state") : "wrong");
        callbackResponse = fetch(callback);
      },
      timeoutMs: 1_000,
    });
    if (valid) await session;
    else await assert.rejects(session, /state did not match/);
    const response = await callbackResponse;
    assert.equal(response.status, valid ? 200 : 400);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const html = await response.text();
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<style/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, valid ? /Return to your terminal/ : /Run your CLI command again/);
    assert.match(html, valid ? /You’re done/ : /Authorization stopped/);
    assert.match(html, valid ? /You can close this tab/ : /close this tab and return to your terminal/);
    assert.ok(html.includes(SHIPLET_MARK_SVG), "loopback page carries the Shiplet mark");
    assert.match(html, /class="stamp"/);
    assert.doesNotMatch(html, /<(?:script|link|img)\b|url\(/, "loopback page loads nothing remote");
    assert.doesNotMatch(html, /shiplet_cli_code_|shiplet_cli_session_/);
  }
});

function cssTokens(block) {
  return Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function resolveTokens(tokens, fallback = {}) {
  const lookup = name => tokens[name] ?? fallback[name];
  const resolve = (value, depth = 0) => depth > 8 ? value
    : value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name) => resolve(lookup(name), depth + 1));
  return Object.fromEntries(Object.entries(tokens).map(([name, value]) => [name, resolve(value)]));
}

test("loopback page mirrors the Harbor Office tokens and mark used by hosted pages", () => {
  const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
  const seo = readFileSync(new URL("../src/seo.ts", import.meta.url), "utf8");
  const css = render.slice(render.indexOf("export const CSS"));
  const light = resolveTokens(cssTokens(css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")))));
  const nightWatch = render.match(/const NIGHT_WATCH_TOKENS = `([^`]+)`/)[1];
  const dark = resolveTokens(cssTokens(nightWatch), light);
  for (const [name, value] of Object.entries(LOOPBACK_TOKENS.light)) assert.equal(value, light[name], `light ${name}`);
  for (const [name, value] of Object.entries(LOOPBACK_TOKENS.dark)) assert.equal(value, dark[name], `dark ${name}`);
  assert.deepEqual(Object.keys(LOOPBACK_TOKENS.dark).sort(), Object.keys(LOOPBACK_TOKENS.light).sort());
  assert.equal(SHIPLET_MARK_SVG, seo.match(/export const SHIPLET_FAVICON_SVG = `([^`]+)`/)[1]);
});

test("browser session rejects state mismatch and closes without exchanging", async () => {
  let exchangeCalls = 0;
  await assert.rejects(
    createBrowserSessionFetch({
      apiUrl: "http://127.0.0.1:43111",
      stdout: captureOutput(),
      fetch: async () => {
        exchangeCalls += 1;
        return new Response();
      },
      openBrowser(authorizeValue) {
        const authorize = new URL(authorizeValue);
        const callback = new URL(authorize.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", `shiplet_cli_code_${"a".repeat(64)}`);
        callback.searchParams.set("state", `mismatch_${"b".repeat(32)}`);
        setTimeout(() => fetch(callback), 0);
      },
      timeoutMs: 1_000,
    }),
    /state did not match/,
  );
  assert.equal(exchangeCalls, 0);
});

test("browser session times out without opening an ambient credential path", async () => {
  await assert.rejects(
    createBrowserSessionFetch({
      apiUrl: "http://127.0.0.1:43112",
      stdout: captureOutput(),
      fetch: async () => new Response(),
      openBrowser() {},
      timeoutMs: 10,
    }),
    /timed out/,
  );
});

test("browser session pins bearer use to the API origin and never prints it", async () => {
  const output = captureOutput();
  const session = sessionPayload();
  let operationAuthorization = "";
  let revokeAuthorization = "";
  let revokeCalls = 0;
  let callbackUrl = "";
  const sessionFetch = await createBrowserSessionFetch({
    apiUrl: "http://127.0.0.1:43113",
    stdout: output,
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/cli/session/exchange") {
        return new Response(JSON.stringify(session), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/api/cli/session/revoke") {
        revokeCalls += 1;
        revokeAuthorization = new Headers(init.headers).get("authorization") || "";
        return new Response(null, { status: 204 });
      }
      operationAuthorization = new Headers(init.headers).get("authorization") || "";
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
    openBrowser(authorizeValue) {
      const authorize = new URL(authorizeValue);
      const callback = new URL(authorize.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", `shiplet_cli_code_${"c".repeat(64)}`);
      callback.searchParams.set("state", authorize.searchParams.get("state"));
      callbackUrl = callback.toString();
      setTimeout(() => fetch(callback), 0);
    },
    timeoutMs: 1_000,
  });
  await assert.rejects(
    sessionFetch("https://attacker.example/collect"),
    /outside the Shiplet API origin/,
  );
  await sessionFetch("http://127.0.0.1:43113/api/shiplets");
  assert.equal(operationAuthorization, `Bearer ${session.accessToken}`);
  await sessionFetch.revoke();
  await sessionFetch.revoke();
  assert.equal(revokeCalls, 1);
  assert.equal(revokeAuthorization, `Bearer ${session.accessToken}`);
  await assert.rejects(
    sessionFetch("http://127.0.0.1:43113/api/shiplets"),
    /revoked/,
  );
  assert.doesNotMatch(output.value(), /shiplet_cli_session_/);
  await assert.rejects(fetch(callbackUrl), /fetch failed/);
});

test("browser session retries revocation and only closes after server confirmation", async () => {
  const output = captureOutput();
  const session = sessionPayload();
  let revokeCalls = 0;
  const sessionFetch = await createBrowserSessionFetch({
    apiUrl: "http://127.0.0.1:43114",
    stdout: output,
    async fetch(url) {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/cli/session/exchange") {
        return new Response(JSON.stringify(session), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (parsed.pathname === "/api/cli/session/revoke") {
        revokeCalls += 1;
        return new Response(null, { status: revokeCalls === 1 ? 503 : 204 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    },
    openBrowser(authorizeValue) {
      const authorize = new URL(authorizeValue);
      const callback = new URL(authorize.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", `shiplet_cli_code_${"d".repeat(64)}`);
      callback.searchParams.set("state", authorize.searchParams.get("state"));
      setTimeout(() => fetch(callback), 0);
    },
    timeoutMs: 1_000,
  });

  await sessionFetch.revoke();
  assert.equal(revokeCalls, 2);
  await assert.rejects(
    sessionFetch("http://127.0.0.1:43114/api/shiplets"),
    /revoked/,
  );
  assert.doesNotMatch(output.value(), /shiplet_cli_session_/);
});
