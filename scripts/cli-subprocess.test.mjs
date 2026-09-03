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
