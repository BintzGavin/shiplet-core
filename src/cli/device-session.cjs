// Device login: `shiplet login --device`. For a CLI that cannot receive a
// browser callback on its own computer (a cloud agent, an SSH session, a
// container). The CLI prints a short code; the person opens Shiplet on any
// device, types the code, and approves. Then the CLI receives the same
// reusable, scoped session that browser login issues.
const { normalizeApiUrl } = require("./browser-session.cjs");

const DEVICE_CODE_PATTERN = /^shiplet_cli_device_[a-f0-9]{64}$/;
const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;
const SESSION_TOKEN_PATTERN = /^shiplet_cli_session_[A-Za-z0-9]{32,200}$/;
const MAX_WAIT_MS = 15 * 60_000;

async function boundedJson(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Shiplet device sign-in response was too large.");
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { apiUrl, accessToken, expiresOn }. Callers must never print or log
// `accessToken`.
async function authorizeWithDeviceCode(options) {
  const apiUrl = normalizeApiUrl(options.apiUrl);
  const fetchImpl = options.fetch;
  if (typeof fetchImpl !== "function") throw new Error("This Node runtime does not provide fetch.");
  const sleep = options.sleep || defaultSleep;
  const now = options.now || (() => Date.now());
  const sessionTtlSeconds = options.sessionTtlSeconds;
  const started = await fetchImpl(`${apiUrl}/api/cli/device/authorize`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(sessionTtlSeconds === undefined ? {} : { sessionTtl: sessionTtlSeconds }),
  });
  const start = await boundedJson(started);
  if (started.status === 404) {
    throw new Error(`${apiUrl} does not support device sign-in yet. Use shiplet login in a terminal with a browser, or an organization API key for automation.`);
  }
  if (started.status === 429) {
    throw new Error("Too many pending sign-ins from this network. Finish one, or wait 10 minutes and try again.");
  }
  if (
    started.status !== 201 ||
    !start ||
    typeof start.deviceCode !== "string" ||
    !DEVICE_CODE_PATTERN.test(start.deviceCode) ||
    typeof start.userCode !== "string" ||
    !USER_CODE_PATTERN.test(start.userCode) ||
    typeof start.verificationUri !== "string"
  ) {
    throw new Error("Shiplet did not start a device sign-in.");
  }
  // Only ever send the person to the Shiplet origin the CLI talks to.
  let verification;
  try {
    verification = new URL(start.verificationUri);
  } catch {
    throw new Error("Shiplet returned an invalid sign-in page.");
  }
  if (verification.origin !== new URL(apiUrl).origin || verification.pathname !== "/cli/device") {
    throw new Error("Shiplet returned a sign-in page on a different site, so the CLI stopped.");
  }
  const expiresIn = Number.isInteger(start.expiresIn) && start.expiresIn > 0 ? Math.min(start.expiresIn, MAX_WAIT_MS / 1000) : 600;
  let interval = Number.isInteger(start.interval) && start.interval > 0 ? Math.min(start.interval, 60) : 5;
  options.stdout.write(
    [
      "To sign in this CLI, open this page on any device where you can sign in to Shiplet:",
      `  ${verification.toString()}`,
      `and enter the code:  ${start.userCode}`,
      `The code expires in ${Math.round(expiresIn / 60)} minutes. Approve only a sign-in you started. Waiting for approval…`,
      "",
    ].join("\n"),
  );
  const deadline = now() + expiresIn * 1000;
  while (now() < deadline) {
    await sleep(interval * 1000);
    let response;
    try {
      response = await fetchImpl(`${apiUrl}/api/cli/device/token`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      });
    } catch {
      // A dropped connection while waiting is retried at the next interval.
      continue;
    }
    const body = await boundedJson(response);
    if (response.status === 201) {
      if (
        !body ||
        typeof body.accessToken !== "string" ||
        !SESSION_TOKEN_PATTERN.test(body.accessToken) ||
        typeof body.expiresOn !== "string" ||
        Date.parse(body.expiresOn) <= now()
      ) {
        throw new Error("Shiplet did not return a valid scoped CLI session.");
      }
      return { apiUrl, accessToken: body.accessToken, expiresOn: body.expiresOn };
    }
    const error = body && typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = Math.min(interval + 5, 60);
      continue;
    }
    if (error === "access_denied") throw new Error("The sign-in was denied in the browser.");
    if (error === "expired_token") throw new Error("The sign-in code expired. Run shiplet login --device again.");
    if (response.status >= 500) continue;
    throw new Error("Shiplet stopped the device sign-in. Run shiplet login --device again.");
  }
  throw new Error("The sign-in code expired. Run shiplet login --device again.");
}

module.exports = { authorizeWithDeviceCode };
