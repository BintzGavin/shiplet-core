import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("the shipped CLI binary completes deploy through browser PKCE without printing its session", async (t) => {
  if (process.platform === "win32") t.skip("Windows browser launcher is covered by unit contract only");
  let authorization = null;
  let revocationCount = 0;
  const sessionMarker = `shiplet_cli_session_${crypto.randomBytes(48).toString("hex")}`;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/cli/authorize") {
      authorization = Object.fromEntries(url.searchParams);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Approved by test browser</title>");
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/cli/session/exchange") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      const challenge = base64Url(crypto.createHash("sha256").update(parsed.verifier).digest());
      assert.equal(parsed.redirectUri, authorization.redirect_uri);
      assert.equal(challenge, authorization.code_challenge);
      response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accessToken: sessionMarker, expiresOn: new Date(Date.now() + 5 * 60_000).toISOString() }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/revisions/revision_A/deployments") {
      assert.equal(request.headers.authorization, `Bearer ${sessionMarker}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        deployment: { id: "deployment_A", revisionId: "revision_A", targetId: "target_A" },
        operation: {
          id: "operation_A",
          kind: "deploy",
          status: "committed",
          idempotencyKey: request.headers["idempotency-key"],
        },
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/cli/session/revoke") {
      assert.equal(request.headers.authorization, `Bearer ${sessionMarker}`);
      revocationCount += 1;
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "shiplet-cli-browser-"));
  const launcherName = process.platform === "darwin" ? "open" : "xdg-open";
  const launcherPath = path.join(directory, launcherName);
  await writeFile(
    launcherPath,
    `#!${process.execPath}\nconst u=new URL(process.argv[2]);fetch(u).then(()=>fetch(u.searchParams.get("redirect_uri")+"?code=shiplet_cli_code_"+"a".repeat(64)+"&state="+encodeURIComponent(u.searchParams.get("state"))));\n`,
  );
  await chmod(launcherPath, 0o700);
  const cliPath = path.resolve("src/cli/shiplet.cjs");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      "deploy",
      "revision_A",
      "--target",
      "target_A",
      "--approve",
      "--api-url",
      `http://127.0.0.1:${port}`,
      "--json",
    ],
    { env: { PATH: directory }, timeout: 15_000 },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /Complete Shiplet CLI authorization in your browser/);
  assert.match(stdout, /"operationStatus": "committed"/);
  assert.doesNotMatch(stdout, /shiplet_cli_session_/);
  assert.equal(revocationCount, 1);
});

test("the shipped CLI reuses one browser approval across commands and still steps up for deploy", async (t) => {
  if (process.platform === "win32") t.skip("Windows browser launcher is covered by unit contract only");
  const authorizations = [];
  const live = new Map();
  const revoked = [];
  const operations = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const bearer = String(request.headers.authorization || "").replace(/^Bearer /, "");
    if (request.method === "GET" && url.pathname === "/cli/authorize") {
      authorizations.push(Object.fromEntries(url.searchParams));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Approved by test browser</title>");
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/cli/session/exchange") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      const authorization = authorizations.find((item) => item.redirect_uri === parsed.redirectUri);
      assert.equal(base64Url(crypto.createHash("sha256").update(parsed.verifier).digest()), authorization.code_challenge);
      const ttlSeconds = authorization.session_ttl ? Number(authorization.session_ttl) : 600;
      const accessToken = `shiplet_cli_session_${crypto.randomBytes(48).toString("hex")}`;
      const expiresOn = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      live.set(accessToken, { expiresOn, reusable: Boolean(authorization.session_ttl) });
      response.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ accessToken, expiresOn }));
      return;
    }
    const session = live.get(bearer);
    if (!session) {
      response.writeHead(401).end("CLI session unavailable");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/cli/session") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ account: { id: "user_A", email: "person@example.com" }, expiresOn: session.expiresOn }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/cli/session/revoke") {
      live.delete(bearer);
      revoked.push(session.reusable ? "reusable" : "command");
      response.writeHead(204).end();
      return;
    }
    operations.push({ path: url.pathname, reusable: session.reusable });
    if (request.method === "POST" && url.pathname === "/api/shiplets/project_A/drafts") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ draft: { id: "draft_A", shipletId: "project_A", baseRevisionId: "revision_A", version: 1 } }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/revisions/revision_A/deployments") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        deployment: { id: "deployment_A", revisionId: "revision_A", targetId: "target_A" },
        operation: { id: "operation_A", kind: "deploy", status: "committed", idempotencyKey: request.headers["idempotency-key"] },
      }));
      return;
    }
    response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => server.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "shiplet-cli-reuse-"));
  const configDir = path.join(directory, "config");
  const launcherPath = path.join(directory, process.platform === "darwin" ? "open" : "xdg-open");
  await writeFile(
    launcherPath,
    `#!${process.execPath}\nconst u=new URL(process.argv[2]);fetch(u).then(()=>fetch(u.searchParams.get("redirect_uri")+"?code=shiplet_cli_code_"+"a".repeat(64)+"&state="+encodeURIComponent(u.searchParams.get("state"))));\n`,
  );
  await chmod(launcherPath, 0o700);
  const cliPath = path.resolve("src/cli/shiplet.cjs");
  const env = { PATH: directory, SHIPLET_CLI_SESSION_STORE: "file", SHIPLET_CONFIG_DIR: configDir };
  const apiUrl = `http://127.0.0.1:${port}`;
  const run = (args) => execFileAsync(process.execPath, [cliPath, ...args, "--api-url", apiUrl], { env, timeout: 15_000 });
  let printed = "";

  for (let index = 0; index < 3; index += 1) {
    const { stdout, stderr } = await run(["fork", "project_A", "--json"]);
    assert.equal(stderr, "");
    printed += stdout;
  }
  assert.equal(authorizations.length, 1, "three commands needed one approval");
  assert.equal(authorizations[0].session_ttl, "7200");
  assert.deepEqual(operations.map((operation) => operation.reusable), [true, true, true]);
  assert.deepEqual(revoked, []);

  const whoami = await run(["whoami", "--json"]);
  printed += whoami.stdout;
  const status = JSON.parse(whoami.stdout);
  assert.equal(status.account.email, "person@example.com");
  assert.equal(status.origin, apiUrl);
  assert.equal(status.storage, path.join(configDir, "cli-sessions.json"));

  const deploy = await run(["deploy", "revision_A", "--target", "target_A", "--approve", "--json"]);
  printed += deploy.stdout;
  assert.equal(authorizations.length, 2, "deploy asks for its own approval");
  assert.equal(authorizations[1].session_ttl, undefined);
  assert.equal(operations.at(-1).reusable, false);
  assert.deepEqual(revoked, ["command"]);

  const logout = await run(["logout"]);
  printed += logout.stdout;
  assert.match(logout.stdout, /Revoked the Shiplet CLI session/);
  assert.deepEqual(revoked, ["command", "reusable"]);
  await assert.rejects(run(["whoami"]), (error) => error.code === 1 && /Not signed in/.test(error.stdout));
  assert.doesNotMatch(printed, /shiplet_cli_session_/);
});
