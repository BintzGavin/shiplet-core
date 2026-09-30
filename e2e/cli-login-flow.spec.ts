import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    ], {
      // Worker type generation adds required bindings to ProcessEnv, but this
      // child intentionally receives only the test launcher path.
      env: { PATH: directory } as unknown as NodeJS.ProcessEnv,
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
