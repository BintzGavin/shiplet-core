const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const {
  authorizeInBrowser,
  createBrowserSessionFetch,
  normalizeApiUrl,
} = require("./browser-session.cjs");
const { createScopedSessionFetch } = require("./scoped-session-fetch.cjs");

// Matches the CLI default; the CLI normally passes an explicit lifetime.
const DEFAULT_SESSION_TTL_SECONDS = 2 * 60 * 60;
// A cached session this close to expiry is not reused, so a command does not
// start with a session that lapses part-way through.
const REUSE_MARGIN_MS = 60_000;
const RECORD_VERSION = 1;
const KEYCHAIN_SERVICE = "cc.shiplet.cli.session";
const SESSIONS_FILE = "cli-sessions.json";
const SESSION_TOKEN_PATTERN = /^shiplet_cli_session_[A-Za-z0-9]{32,200}$/;
const MAX_STORE_BYTES = 256 * 1024;
const HELPER_TIMEOUT_MS = 10_000;

function sessionCacheDisabled(env) {
  return /^(?:0|false|off|no)$/i.test(String(env.SHIPLET_CLI_SESSION_CACHE || "").trim());
}

function configDirectory(env, platform) {
  if (env.SHIPLET_CONFIG_DIR) {
    if (!path.isAbsolute(env.SHIPLET_CONFIG_DIR)) {
      throw new Error("SHIPLET_CONFIG_DIR must be an absolute path.");
    }
    return env.SHIPLET_CONFIG_DIR;
  }
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Shiplet");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "shiplet");
}

function validRecord(value, origin) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === RECORD_VERSION &&
      value.origin === origin &&
      typeof value.accessToken === "string" &&
      SESSION_TOKEN_PATTERN.test(value.accessToken) &&
      typeof value.expiresOn === "string" &&
      Number.isFinite(Date.parse(value.expiresOn)) &&
      value.account &&
      typeof value.account.id === "string" &&
      value.account.id &&
      typeof value.account.email === "string",
  );
}

function runHelper(command, args, input) {
  return new Promise((resolve) => {
    const child = childProcess.execFile(
      command,
      args,
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_STORE_BYTES, windowsHide: true },
      (error, stdout) => resolve({ ok: !error, code: error?.code, stdout: String(stdout || "") }),
    );
    child.on("error", () => {});
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

// macOS login keychain through /usr/bin/security. The secret is written over
// stdin in interactive mode so it never appears in another process's argv.
function macosKeychain() {
  const security = "/usr/bin/security";
  return {
    kind: "keychain",
    location: "macOS Keychain",
    async available() {
      try {
        await fs.access(security);
        return true;
      } catch {
        return false;
      }
    },
    async read(origin) {
      const result = await runHelper(security, [
        "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", origin, "-w",
      ]);
      return result.ok ? result.stdout.trim() : null;
    },
    async write(origin, value) {
      if (!/^[A-Za-z0-9_-]+$/.test(value) || /["\\\s]/.test(origin)) return false;
      const result = await runHelper(
        security,
        ["-i"],
        `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${origin}" -l "Shiplet CLI session" -w "${value}"\n`,
      );
      return result.ok && (await this.read(origin)) === value;
    },
    async remove(origin) {
      await runHelper(security, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", origin]);
    },
  };
}

// Linux Secret Service through libsecret's secret-tool, which reads the secret
// from stdin.
function secretServiceKeychain(env) {
  return {
    kind: "keychain",
    location: "Secret Service keyring",
    async available() {
      if (!env.DBUS_SESSION_BUS_ADDRESS) return false;
      const probe = await runHelper("secret-tool", ["--version"]);
      return probe.ok;
    },
    async read(origin) {
      const result = await runHelper("secret-tool", [
        "lookup", "service", KEYCHAIN_SERVICE, "origin", origin,
      ]);
      return result.ok ? result.stdout.trim() : null;
    },
    async write(origin, value) {
      const result = await runHelper(
        "secret-tool",
        ["store", "--label", "Shiplet CLI session", "service", KEYCHAIN_SERVICE, "origin", origin],
        value,
      );
      return result.ok && (await this.read(origin)) === value;
    },
    async remove(origin) {
      await runHelper("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "origin", origin]);
    },
  };
}

// User-only file fallback: a 0700 directory and a 0600 file, replaced
// atomically. A file that another user could read or that is not a regular
// file owned by this user is never trusted.
function fileStore(directory, platform) {
  const file = path.join(directory, SESSIONS_FILE);
  const posix = platform !== "win32";

  async function readAll() {
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch {
      return { sessions: {}, problem: null };
    }
    if (
      !stat.isFile() ||
      stat.size > MAX_STORE_BYTES ||
      (posix && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    ) {
      return { sessions: {}, problem: "unsafe" };
    }
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.sessions || typeof parsed.sessions !== "object") {
        return { sessions: {}, problem: "corrupt" };
      }
      return { sessions: { ...parsed.sessions }, problem: null };
    } catch {
      return { sessions: {}, problem: "corrupt" };
    }
  }

  async function writeAll(sessions) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (posix) {
      const dirStat = await fs.lstat(directory);
      if (!dirStat.isDirectory() || dirStat.uid !== process.getuid()) {
        throw new Error("Shiplet config directory is not a directory owned by this user.");
      }
      if ((dirStat.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
    }
    if (Object.keys(sessions).length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    const temporary = path.join(directory, `.${SESSIONS_FILE}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(
        temporary,
        `${JSON.stringify({ version: RECORD_VERSION, sessions }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  return {
    kind: "file",
    location: file,
    async available() {
      return true;
    },
    async read(origin) {
      const { sessions, problem } = await readAll();
      if (problem) return { problem };
      return sessions[origin] === undefined ? null : sessions[origin];
    },
    async write(origin, record) {
      const { sessions, problem } = await readAll();
      // An unreadable or unsafe file is replaced, not merged.
      const next = problem ? {} : sessions;
      next[origin] = record;
      await writeAll(next);
      return true;
    },
    async remove(origin) {
      const { sessions, problem } = await readAll();
      if (problem) {
        await fs.rm(file, { force: true });
        return;
      }
      if (!(origin in sessions)) return;
      delete sessions[origin];
      await writeAll(sessions);
    },
  };
}

function encodeRecord(record) {
  return Buffer.from(JSON.stringify(record)).toString("base64url");
}

function decodeRecord(value) {
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function createSessionStore({ env = process.env, platform = process.platform } = {}) {
  const mode = String(env.SHIPLET_CLI_SESSION_STORE || "auto").trim().toLowerCase();
  if (!["auto", "keychain", "file"].includes(mode)) {
    throw new Error('SHIPLET_CLI_SESSION_STORE must be "auto", "keychain", or "file".');
  }
  const file = fileStore(configDirectory(env, platform), platform);
  const keychain =
    mode === "file"
      ? null
      : platform === "darwin"
        ? macosKeychain()
        : platform === "linux"
          ? secretServiceKeychain(env)
          : null;
  let keychainReady;
  const useKeychain = async () => {
    if (!keychain) return false;
    keychainReady ??= keychain.available();
    return keychainReady;
  };

  return {
    /** Returns { record, location } or { problem } or null. Never throws for a bad cache. */
    async load(origin) {
      if (await useKeychain()) {
        const stored = await keychain.read(origin);
        if (stored) {
          const record = decodeRecord(stored);
          if (validRecord(record, origin)) return { record, location: keychain.location };
          await keychain.remove(origin);
          return { problem: "corrupt" };
        }
      }
      if (mode === "keychain") return null;
      let stored;
      try {
        stored = await file.read(origin);
      } catch {
        return { problem: "corrupt" };
      }
      if (!stored) return null;
      if (stored.problem) return { problem: stored.problem };
      if (validRecord(stored, origin)) return { record: stored, location: file.location };
      await file.remove(origin).catch(() => {});
      return { problem: "corrupt" };
    },
    /** Returns the storage location, or null when no store accepted the session. */
    async save(origin, record) {
      if (await useKeychain()) {
        if (await keychain.write(origin, encodeRecord(record))) {
          await file.remove(origin).catch(() => {});
          return keychain.location;
        }
      }
      if (mode === "keychain") return null;
      try {
        await file.write(origin, record);
        return file.location;
      } catch {
        return null;
      }
    },
    async remove(origin) {
      if (await useKeychain()) await keychain.remove(origin);
      await file.remove(origin).catch(() => {});
    },
  };
}

async function describeRemoteSession(apiUrl, accessToken, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${apiUrl}/api/cli/session`, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { status: "unreachable" };
  }
  if (response.status === 401 || response.status === 403) return { status: "ended" };
  if (!response.ok) return { status: "unreachable" };
  let body;
  try {
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) return { status: "unreachable" };
    body = JSON.parse(text);
  } catch {
    return { status: "unreachable" };
  }
  if (
    !body ||
    typeof body.expiresOn !== "string" ||
    !Number.isFinite(Date.parse(body.expiresOn)) ||
    !body.account ||
    typeof body.account.id !== "string" ||
    typeof body.account.email !== "string"
  ) {
    return { status: "unreachable" };
  }
  return {
    status: "active",
    account: { id: body.account.id, email: body.account.email },
    expiresOn: body.expiresOn,
  };
}

async function revokeRemoteSession(apiUrl, accessToken, fetchImpl) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(`${apiUrl}/api/cli/session/revoke`, {
        method: "POST",
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 204) return "revoked";
      // 401 means the server no longer accepts this session: already revoked or expired.
      if (response.status === 401) return "already-ended";
    } catch {
      // A second bounded attempt covers one transient transport failure.
    }
  }
  return "unconfirmed";
}

function createSessionCache({
  env = process.env,
  platform = process.platform,
  store,
  authorize = authorizeInBrowser,
  commandSession = createBrowserSessionFetch,
  now = () => Date.now(),
} = {}) {
  let resolvedStore = store;
  const getStore = () => (resolvedStore ??= createSessionStore({ env, platform }));

  // A cached session's fetch has no revoke(): the command must not end it.
  // A 401 means it was revoked or expired server-side, so it is forgotten.
  function reusableFetch(apiUrl, accessToken, fetchImpl) {
    const scoped = createScopedSessionFetch({ apiUrl, accessToken, fetch: fetchImpl });
    const sessionFetch = async (url, init) => {
      const response = await scoped(url, init);
      if (response.status === 401) await getStore().remove(apiUrl);
      return response;
    };
    sessionFetch.reusable = true;
    return sessionFetch;
  }

  async function loadActive(apiUrl, fetchImpl, stdout) {
    const loaded = await getStore().load(apiUrl);
    if (!loaded) return null;
    if (loaded.problem) {
      stdout?.write(
        loaded.problem === "unsafe"
          ? "Ignored a saved Shiplet CLI session file that other users could read or that is not a regular file.\n"
          : "Ignored an unreadable saved Shiplet CLI session.\n",
      );
      return null;
    }
    const { record, location } = loaded;
    if (Date.parse(record.expiresOn) - now() <= REUSE_MARGIN_MS) {
      await getStore().remove(apiUrl);
      return null;
    }
    const remote = await describeRemoteSession(apiUrl, record.accessToken, fetchImpl);
    if (remote.status === "unreachable") {
      throw new Error(`Could not confirm the saved Shiplet CLI session with ${apiUrl}. Check your connection and retry.`);
    }
    if (remote.status === "ended" || remote.account.id !== record.account.id) {
      await getStore().remove(apiUrl);
      stdout?.write("Your saved Shiplet CLI session has ended. Approve a new one in your browser.\n");
      return null;
    }
    return { record: { ...record, expiresOn: remote.expiresOn }, location };
  }

  async function authorizeAndSave(apiUrl, fetchImpl, stdout, sessionTtlSeconds) {
    const session = await authorize({ apiUrl, fetch: fetchImpl, stdout, sessionTtlSeconds });
    const remote = await describeRemoteSession(apiUrl, session.accessToken, fetchImpl);
    if (remote.status !== "active") {
      await revokeRemoteSession(apiUrl, session.accessToken, fetchImpl);
      throw new Error("Shiplet did not confirm the new CLI session.");
    }
    const record = {
      version: RECORD_VERSION,
      origin: apiUrl,
      accessToken: session.accessToken,
      expiresOn: remote.expiresOn,
      account: remote.account,
      createdOn: new Date(now()).toISOString(),
    };
    const location = await getStore().save(apiUrl, record);
    return { record, location };
  }

  async function bootstrap(options) {
    const apiUrl = normalizeApiUrl(options.apiUrl);
    const fetchImpl = options.fetch;
    // Deploy, promote and rollback always get a fresh single-command approval,
    // as does every command when caching is turned off.
    if (options.purpose === "step-up" || options.sessionCache === false || sessionCacheDisabled(env)) {
      return commandSession({ apiUrl, fetch: fetchImpl, stdout: options.stdout });
    }
    const active = await loadActive(apiUrl, fetchImpl, options.stdout);
    if (active) return reusableFetch(apiUrl, active.record.accessToken, fetchImpl);
    const created = await authorizeAndSave(
      apiUrl,
      fetchImpl,
      options.stdout,
      options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
    );
    if (!created.location) {
      // Nowhere safe to keep it: use it for this command only, then revoke it.
      options.stdout?.write("Could not save the Shiplet CLI session; it will end when this command finishes.\n");
      return createScopedSessionFetch({ apiUrl, accessToken: created.record.accessToken, fetch: fetchImpl });
    }
    return reusableFetch(apiUrl, created.record.accessToken, fetchImpl);
  }

  function publicStatus(record, location) {
    return {
      origin: record.origin,
      account: { id: record.account.id, email: record.account.email },
      expiresOn: record.expiresOn,
      storage: location,
    };
  }

  return {
    bootstrap,
    async login({ apiUrl: rawApiUrl, fetch: fetchImpl, stdout, sessionTtlSeconds }) {
      const apiUrl = normalizeApiUrl(rawApiUrl);
      const active = await loadActive(apiUrl, fetchImpl, stdout);
      if (active) return { ...publicStatus(active.record, active.location), reused: true };
      const created = await authorizeAndSave(
        apiUrl,
        fetchImpl,
        stdout,
        sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      );
      if (!created.location) {
        await revokeRemoteSession(apiUrl, created.record.accessToken, fetchImpl);
        throw new Error("Could not save the Shiplet CLI session securely, so it was revoked.");
      }
      return { ...publicStatus(created.record, created.location), reused: false };
    },
    async status({ apiUrl: rawApiUrl, fetch: fetchImpl, stdout }) {
      const apiUrl = normalizeApiUrl(rawApiUrl);
      const active = await loadActive(apiUrl, fetchImpl, stdout);
      return active ? publicStatus(active.record, active.location) : null;
    },
    async logout({ apiUrl: rawApiUrl, fetch: fetchImpl }) {
      const apiUrl = normalizeApiUrl(rawApiUrl);
      const loaded = await getStore().load(apiUrl);
      if (!loaded || loaded.problem) {
        await getStore().remove(apiUrl);
        return { origin: apiUrl, hadSession: false, revocation: "none" };
      }
      const revocation =
        Date.parse(loaded.record.expiresOn) <= now()
          ? "already-ended"
          : await revokeRemoteSession(apiUrl, loaded.record.accessToken, fetchImpl);
      // Always forget it locally: the user asked to sign out on this computer.
      await getStore().remove(apiUrl);
      return {
        origin: apiUrl,
        hadSession: true,
        revocation,
        expiresOn: loaded.record.expiresOn,
      };
    },
  };
}

module.exports = {
  DEFAULT_SESSION_TTL_SECONDS,
  createSessionCache,
  createSessionStore,
  sessionCacheDisabled,
};
