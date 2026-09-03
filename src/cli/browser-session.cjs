const http = require("node:http");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { createScopedSessionFetch } = require("./scoped-session-fetch.cjs");

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeApiUrl(value) {
  const url = new URL(String(value || "https://shiplet.cc"));
  const loopback = url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("CLI browser authorization requires an HTTPS Shiplet origin or explicit 127.0.0.1 test origin.");
  }
  return url.origin;
}

function launchSystemBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  const child = childProcess.spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not establish the local CLI authorization callback.");
  return address.port;
}

async function boundedJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("CLI authorization response was too large.");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createBrowserSessionFetch(options) {
  const apiUrl = normalizeApiUrl(options.apiUrl);
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== "function") throw new Error("This Node runtime does not provide fetch.");
  const state = base64Url(crypto.randomBytes(32));
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const server = http.createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const receivedState = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const stateMatches =
        receivedState.length === state.length &&
        crypto.timingSafeEqual(Buffer.from(receivedState), Buffer.from(state));
      if (
        request.method !== "GET" ||
        url.pathname !== "/callback" ||
        !stateMatches ||
        !/^shiplet_cli_code_[A-Za-z0-9]{32,200}$/.test(code)
      ) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Authorization did not match this CLI process.");
        rejectCallback(new Error("CLI authorization state did not match."));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      });
      response.end("<!doctype html><title>Shiplet CLI authorized</title><p>Authorization complete. You can close this window.</p>");
      resolveCallback(code);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid callback.");
      rejectCallback(new Error("Invalid CLI authorization callback."));
    }
  });
  const port = await listenLoopback(server);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = new URL("/cli/authorize", apiUrl);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  options.stdout.write("Complete Shiplet CLI authorization in your browser.\n");
  (options.openBrowser || launchSystemBrowser)(authorizeUrl.toString());
  let timeout;
  try {
    const code = await Promise.race([
      callback,
      new Promise((_, reject) => {
        const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
          ? Math.min(options.timeoutMs, 3 * 60_000)
          : 3 * 60_000;
        timeout = setTimeout(() => reject(new Error("CLI browser authorization timed out.")), timeoutMs);
      }),
    ]);
    const response = await fetchImpl(`${apiUrl}/api/cli/session/exchange`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, verifier, redirectUri }),
    });
    const body = await boundedJson(response);
    if (
      !response.ok ||
      !body ||
      typeof body.accessToken !== "string" ||
      !/^shiplet_cli_session_[A-Za-z0-9]{32,200}$/.test(body.accessToken) ||
      typeof body.expiresOn !== "string" ||
      Date.parse(body.expiresOn) <= Date.now() ||
      Date.parse(body.expiresOn) > Date.now() + 15 * 60_000
    ) {
      throw new Error("Shiplet did not return a valid scoped CLI session.");
    }
    return createScopedSessionFetch({
      apiUrl,
      accessToken: body.accessToken,
      fetch: fetchImpl,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    server.close();
  }
}

module.exports = { createBrowserSessionFetch };
