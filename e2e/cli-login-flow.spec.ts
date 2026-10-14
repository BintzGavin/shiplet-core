import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { loginAs, testUser } from "./helpers";

// Exercise the shipped process and real Worker. Only the external identity
// provider and OS browser launcher are replaced with controlled test adapters.
// Do not persist auth URLs, request bodies, headers, or browser traces.
test.use({ trace: "off", video: "off", screenshot: "off" });

for (const existingSession of [false, true]) {
  test(`CLI publishes and revokes after ${existingSession ? "reusing browser sign-in" : "signing in through the provider callback"}`, async ({ page, request }) => {
    test.skip(process.platform === "win32", "POSIX browser launcher adapter");
    const user = testUser("cli-combined");
    const directory = await mkdtemp(path.join(tmpdir(), "shiplet-cli-flow-"));
    const events: Array<{ path: string; status: number }> = [];
    let acceptAuthorization!: (url: string) => void;
    const authorization = new Promise<string>(resolve => { acceptAuthorization = resolve; });
    const bridge = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.url === "/open") acceptAuthorization(body);
      else if (req.url === "/event") events.push(JSON.parse(body));
      res.writeHead(204).end();
    });
    await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Test bridge did not start");
    const bridgeUrl = `http://127.0.0.1:${address.port}`;
    const launcher = path.join(directory, process.platform === "darwin" ? "open" : "xdg-open");
    const observer = path.join(directory, "observe.cjs");
    const artifact = path.join(directory, "index.html");
    await writeFile(artifact, "<!doctype html><title>CLI flow fixture</title><h1>CLI flow verified</h1>");
    await writeFile(launcher, `#!${process.execPath}\nfetch(${JSON.stringify(`${bridgeUrl}/open`)},{method:"POST",body:process.argv[2]}).catch(()=>{process.exitCode=1});\n`, { mode: 0o700 });
    await writeFile(observer, `const actualFetch=globalThis.fetch;globalThis.fetch=async (...args)=>{const response=await actualFetch(...args);const route=new URL(args[0]).pathname;if(["/api/cli/session/exchange","/api/shiplets","/api/cli/session/revoke"].includes(route))await actualFetch(${JSON.stringify(`${bridgeUrl}/event`)},{method:"POST",body:JSON.stringify({path:route,status:response.status})});return response;};\n`);

    let providerVisits = 0;
    await page.route("**/auth/login?**", async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      const providerUrl = response.headers().location;
      if (!providerUrl || new URL(providerUrl).origin !== "https://authkit.test") {
        await route.fulfill({ response });
        return;
      }
      providerVisits++;
      const login = new URL(providerUrl);
      const callback = new URL(login.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", `test-code::${encodeURIComponent(user.email)}`);
      callback.searchParams.set("state", login.searchParams.get("state")!);
      await route.fulfill({ status: 302, headers: { location: callback.toString() } });
    });
    if (existingSession) await loginAs(page, user);
    const cspErrors: string[] = [];
    let failedNavigation = "";
    page.on("requestfailed", request => {
      if (request.isNavigationRequest()) {
        const url = new URL(request.url());
        failedNavigation = `${url.origin}${url.pathname}`;
      }
    });
    page.on("console", message => {
      if (/Content Security Policy|violates.*directive/i.test(message.text())) cspErrors.push("Browser CSP violation");
    });
    const cli = spawn(process.execPath, [
      "--require", observer, path.resolve("src/cli/shiplet.cjs"),
      "prepare", artifact, "--name", "CLI flow fixture", "--subdomain", `cli-flow-${Date.now()}`,
      "--visibility", "organization", "--api-url", "http://127.0.0.1:8787", "--json",
      // This test covers the single-command flow; the reusable session has its own test.
      "--no-session-cache",
    ], {
      // Worker type generation adds required bindings to ProcessEnv, but this
      // child intentionally receives only the test launcher path and a
      // throwaway session store, never the developer's keychain.
      env: { PATH: directory, SHIPLET_CLI_SESSION_STORE: "file", SHIPLET_CONFIG_DIR: path.join(directory, "config") } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    cli.stdout.on("data", chunk => { output += chunk.toString(); });
    cli.stderr.on("data", chunk => { errors += chunk.toString(); });
    const exited = new Promise<number | null>(resolve => cli.once("exit", resolve));
    try {
      // The CLI accepts only 127.0.0.1 for a development API. Use this test
      // app's canonical browser host so cookies and asset CSP share its origin.
      const browserUrl = new URL(await Promise.race([
        authorization,
        exited.then(() => { throw new Error("CLI exited before requesting browser authorization"); }),
      ]));
      browserUrl.hostname = new URL(String(test.info().project.use.baseURL)).hostname;
      let navigationUrl = browserUrl.toString();
      if (!existingSession) {
        // Routing intercepts only the first hop in a redirect chain. Verify
        // the signed-out redirect, then let the provider adapter handle login.
        const redirect = await page.request.get(navigationUrl, { maxRedirects: 0 });
        expect(redirect.status()).toBe(302);
        navigationUrl = new URL(redirect.headers().location, browserUrl).toString();
        expect(new URL(navigationUrl).pathname).toBe("/auth/login");
      }
      try {
        await page.goto(navigationUrl);
      } catch {
        throw new Error(`Browser navigation failed at ${failedNavigation || "the authorization page"}`);
      }
      await expect(page.getByRole("heading", { name: "Authorize Shiplet CLI" })).toBeVisible();
      await expect(page.getByText(user.email, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Authorization approved", exact: true })).toBeVisible();
      expect(events).toEqual([]);
      await page.getByRole("link", { name: "Return to CLI", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Return to your terminal" })).toBeVisible();
      expect(await exited).toBe(0);
      // Boolean assertions keep any unexpected credential-bearing output out of
      // the failure report. The real CLI is responsible for sanitizing output.
      expect(errors.length === 0, "CLI must finish without an error").toBe(true);
      expect(/shiplet_cli_(?:session|code)_/.test(output + errors), "CLI must not print credentials").toBe(false);
      expect(events).toEqual([
        { path: "/api/cli/session/exchange", status: 201 },
        { path: "/api/shiplets", status: 201 },
        { path: "/api/cli/session/revoke", status: 204 },
      ]);
      expect(providerVisits).toBe(existingSession ? 0 : 1);
      expect(cspErrors).toEqual([]);
      const published = JSON.parse(output.slice(output.indexOf("{")));
      expect(published.ok).toBe(true);
      const list = await request.get("/api/shiplets", { headers: {
        "x-shiplet-user-id": user.id,
        "x-shiplet-user-email": user.email,
      } });
      expect(list.status()).toBe(200);
      expect(await list.text()).toContain("CLI flow fixture");
    } finally {
      if (cli.exitCode === null) cli.kill();
      await new Promise<void>(resolve => bridge.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("CLI reuses one browser approval across commands until logout revokes it", async ({ page, request }) => {
  test.skip(process.platform === "win32", "POSIX browser launcher adapter");
  const user = testUser("cli-reusable");
  const directory = await mkdtemp(path.join(tmpdir(), "shiplet-cli-reuse-"));
  const configDir = path.join(directory, "config");
  const events: Array<{ path: string; status: number }> = [];
  const authorizations: string[] = [];
  let acceptAuthorization: ((url: string) => void) | null = null;
  const bridge = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/open") {
      authorizations.push(body);
      acceptAuthorization?.(body);
    } else if (req.url === "/event") events.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  if (!address || typeof address === "string") throw new Error("Test bridge did not start");
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  const launcher = path.join(directory, process.platform === "darwin" ? "open" : "xdg-open");
  const observer = path.join(directory, "observe.cjs");
  const artifact = path.join(directory, "index.html");
  await writeFile(artifact, "<!doctype html><title>CLI reuse fixture</title><h1>CLI reuse verified</h1>");
  await writeFile(launcher, `#!${process.execPath}\nfetch(${JSON.stringify(`${bridgeUrl}/open`)},{method:"POST",body:process.argv[2]}).catch(()=>{process.exitCode=1});\n`, { mode: 0o700 });
  await writeFile(observer, `const actualFetch=globalThis.fetch;globalThis.fetch=async (...args)=>{const response=await actualFetch(...args);const route=new URL(args[0]).pathname;if(["/api/cli/session/exchange","/api/cli/session","/api/shiplets","/api/cli/session/revoke"].includes(route))await actualFetch(${JSON.stringify(`${bridgeUrl}/event`)},{method:"POST",body:JSON.stringify({path:route,status:response.status})});return response;};\n`);

  const runCli = (args: string[]) => {
    const child = spawn(process.execPath, [
      "--require", observer, path.resolve("src/cli/shiplet.cjs"), ...args,
      "--api-url", "http://127.0.0.1:8787",
    ], {
      env: { PATH: directory, SHIPLET_CLI_SESSION_STORE: "file", SHIPLET_CONFIG_DIR: configDir } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
    return { child, exited, output: () => output, errors: () => errors };
  };
  const prepareArgs = (label: string) => [
    "prepare", artifact, "--name", `CLI reuse ${label}`, "--subdomain", `cli-reuse-${label}-${Date.now()}`,
    "--visibility", "organization", "--json",
  ];
  let printed = "";

  try {
    await loginAs(page, user);
    const authorization = new Promise<string>(resolve => { acceptAuthorization = resolve; });
    const first = runCli(prepareArgs("first"));
    const browserUrl = new URL(await Promise.race([
      authorization,
      first.exited.then(() => { throw new Error("CLI exited before requesting browser authorization"); }),
    ]));
    expect(browserUrl.searchParams.get("session_ttl")).toBe("7200");
    browserUrl.hostname = new URL(String(test.info().project.use.baseURL)).hostname;
    await page.goto(browserUrl.toString());
    await expect(page.getByRole("heading", { name: "Authorize Shiplet CLI" })).toBeVisible();
    await expect(page.getByText(/up to 2 hours/)).toBeVisible();
    await page.getByRole("button", { name: "Authorize CLI", exact: true }).click();
    await page.getByRole("link", { name: "Return to CLI", exact: true }).click();
    expect(await first.exited).toBe(0);
    printed += first.output() + first.errors();
    expect(events.splice(0)).toEqual([
      { path: "/api/cli/session/exchange", status: 201 },
      { path: "/api/cli/session", status: 200 },
      { path: "/api/shiplets", status: 201 },
    ]);

    // A second command reuses the session: no browser, no exchange, no revoke.
    const second = runCli(prepareArgs("second"));
    expect(await second.exited).toBe(0);
    printed += second.output() + second.errors();
    expect(authorizations).toHaveLength(1);
    expect(events.splice(0)).toEqual([
      { path: "/api/cli/session", status: 200 },
      { path: "/api/shiplets", status: 201 },
    ]);

    const whoami = runCli(["whoami", "--json"]);
    expect(await whoami.exited).toBe(0);
    printed += whoami.output();
    const status = JSON.parse(whoami.output());
    expect(status.account.email).toBe(user.email);
    expect(status.origin).toBe("http://127.0.0.1:8787");
    events.splice(0);

    // Keep the stored session to prove the server rejects it after logout.
    // Boolean assertions keep it out of any failure report.
    const stored = JSON.parse(await readFile(path.join(configDir, "cli-sessions.json"), "utf8"));
    const storedSession = String(stored.sessions["http://127.0.0.1:8787"].accessToken);
    const logout = runCli(["logout"]);
    expect(await logout.exited).toBe(0);
    printed += logout.output();
    expect(events.splice(0)).toEqual([{ path: "/api/cli/session/revoke", status: 204 }]);
    const afterLogout = await request.get("/api/shiplets", { headers: { authorization: `Bearer ${storedSession}` } });
    expect(afterLogout.status() === 401, "a revoked session is rejected immediately").toBe(true);

    const signedOut = runCli(["whoami"]);
    expect(await signedOut.exited).toBe(1);
    expect(signedOut.output()).toContain("Not signed in");
    expect(/shiplet_cli_(?:session|code)_/.test(printed), "CLI must not print credentials").toBe(false);

    const list = await request.get("/api/shiplets", { headers: {
      "x-shiplet-user-id": user.id,
      "x-shiplet-user-email": user.email,
    } });
    const listed = await list.text();
    expect(listed).toContain("CLI reuse first");
    expect(listed).toContain("CLI reuse second");
  } finally {
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
