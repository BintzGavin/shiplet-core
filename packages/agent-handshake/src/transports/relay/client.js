// Transport #2: a session on the hosted Shiplet relay, over HTTPS for calls and
// a WebSocket for pushed messages. It is not a Hub transport: the MCP server
// keeps its local registration and hands relay messages to its own local peer
// (the hub's `inject` op), so hooks deliver them like local ones.
//
// Only `fetch` and the global `WebSocket` (Node 22) are used. The API key goes
// in the Authorization header of HTTPS calls and nowhere else: never in a URL,
// a log line or an error message. The push socket authenticates with a
// single-use ticket instead.

const DEFAULTS = Object.freeze({
  minDelayMs: 1000, // first reconnect delay, doubling to maxDelayMs
  maxDelayMs: 30_000,
  pingMs: 30_000, // a ping every 30 s; no answer by the next one means the socket is dead
  requestTimeoutMs: 15_000,
  closeTimeoutMs: 1500, // the DELETE on shutdown is best effort
});

const SESSION_GONE = ["session_not_found", "session_closed"];

export class RelayError extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isLoopback(hostname) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

// Same rule as the Shiplet CLI: an HTTPS origin, or plain HTTP on loopback only.
export function relayOrigin(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new RelayError("bad_config", "SHIPLET_API_URL must be an HTTPS origin, such as https://shiplet.cc");
  }
  const allowed = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!allowed || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new RelayError("bad_config", "SHIPLET_API_URL must be an origin-only HTTPS URL (plain HTTP only for localhost)");
  }
  return url.origin;
}

// The relay is on only when all three variables are set. Returns null otherwise.
export function relayConfig(env = process.env) {
  const { SHIPLET_API_URL: apiUrl, SHIPLET_ORGANIZATION_ID: organization, SHIPLET_API_KEY: apiKey } = env;
  if (!apiUrl || !organization || !apiKey) return null;
  return { apiUrl: relayOrigin(apiUrl), organization, apiKey };
}

export function connectRelay(options) {
  return new RelayLink(options);
}

class RelayLink {
  #key;
  #fetch;
  #WebSocket;
  #log;
  #opening = null;
  #socket = null; // { session, ws, finish }
  #delay;
  #sleeping = null; // { timer, resolve }
  #lastLogged = null;
  #delivering = Promise.resolve();

  constructor({
    apiUrl,
    organization,
    apiKey,
    identity,
    onMessages = () => {},
    log = (line) => process.stderr.write(`${line}\n`),
    fetch = globalThis.fetch,
    WebSocket = globalThis.WebSocket,
    ...timing
  }) {
    if (!organization || !apiKey) throw new RelayError("bad_config", "the relay needs an organization id and an API key");
    this.base = `${relayOrigin(apiUrl)}/api/organizations/${encodeURIComponent(organization)}`;
    this.loopback = isLoopback(new URL(this.base).hostname);
    this.#key = apiKey;
    this.#fetch = fetch;
    this.#WebSocket = WebSocket;
    this.#log = log;
    this.timing = { ...DEFAULTS, ...Object.fromEntries(Object.entries(timing).filter(([k, v]) => k in DEFAULTS && v > 0)) };
    // Only these four fields cross to the relay: never the local session id, cwd or pid.
    const { name, kind, app, machine } = identity ?? {};
    this.identity = { name, kind, app, machine: machine ?? null };
    this.onMessages = onMessages;
    this.closed = false;
    this.sessionId = null;
    this.self = null; // this session's own relay peer
    this.#delay = this.timing.minDelayMs;
    this.#run();
  }

  // { session, peerId } while a relay session is open, else null.
  status() {
    return this.sessionId ? { session: this.sessionId, peerId: this.self?.id ?? null } : null;
  }

  get connected() {
    return Boolean(this.#socket?.ready);
  }

  peers() {
    return this.#withSession((p) => this.#call("GET", `${p}/peers`));
  }

  // body: { to, text, handshake?, record?, topic?, request? }
  send(body) {
    return this.#withSession((p) => this.#call("POST", `${p}/messages`, body));
  }

  inbox() {
    return this.#withSession((p) => this.#call("GET", `${p}/inbox?wait=0`));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.#wake();
    this.#socket?.finish(true);
    const id = this.sessionId;
    this.sessionId = null;
    this.self = null;
    if (id) await this.#call("DELETE", this.#path(id), undefined, this.timing.closeTimeoutMs).catch(() => {});
  }

  #path(id) {
    return `/handshake-sessions/${encodeURIComponent(id)}`;
  }

  async #call(method, path, body, timeoutMs = this.timing.requestTimeoutMs) {
    const headers = { authorization: `Bearer ${this.#key}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await this.#fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === "TimeoutError" ? "timed out" : err?.cause?.message || err?.message || "network error";
      throw new RelayError("relay_unreachable", `could not reach the Shiplet relay (${reason})`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const code = typeof data?.error === "string" ? data.error : `http_${res.status}`;
      const message = typeof data?.message === "string" ? data.message : `the Shiplet relay answered ${res.status}`;
      throw new RelayError(code, message, res.status);
    }
    return data ?? {};
  }

  #open() {
    this.#opening ??= (async () => {
      const data = await this.#call("POST", "/handshake-sessions", this.identity);
      if (typeof data.session !== "string") throw new RelayError("bad_relay_reply", "the relay did not return a session");
      if (this.closed) {
        await this.#call("DELETE", this.#path(data.session), undefined, this.timing.closeTimeoutMs).catch(() => {});
        throw new RelayError("closed", "the relay connection is closed");
      }
      this.sessionId = data.session;
      this.self = data.peer ?? null;
      return data.session;
    })().finally(() => (this.#opening = null));
    return this.#opening;
  }

  // The session is gone (timed out, closed, or the relay restarted). Forget it,
  // and drop a socket still attached to it, so the next call opens a new one.
  #lost(id) {
    if (this.sessionId === id) {
      this.sessionId = null;
      this.self = null;
    }
    if (this.#socket?.session === id) this.#socket.finish(true);
  }

  async #withSession(fn) {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new RelayError("closed", "the relay connection is closed");
      const id = this.sessionId ?? (await this.#open());
      try {
        return await fn(this.#path(id));
      } catch (err) {
        if (attempt > 0 || !SESSION_GONE.includes(err.code)) throw err;
        this.#lost(id); // open a new session and try once more
      }
    }
  }

  // Hold the push socket for as long as the link is open: open a session if
  // there is none, get a ticket, listen; on any failure wait and start over.
  async #run() {
    while (!this.closed) {
      let ready = false;
      try {
        const id = this.sessionId ?? (await this.#open());
        let ticket;
        try {
          ticket = await this.#call("POST", `${this.#path(id)}/events`);
        } catch (err) {
          if (SESSION_GONE.includes(err.code)) this.#lost(id);
          throw err;
        }
        ready = await this.#listen(id, ticket?.url);
        if (!ready && this.sessionId === id) throw new RelayError("socket_failed", "the relay's event socket closed before it was ready");
      } catch (err) {
        this.#report(err);
      }
      if (this.closed) break;
      if (ready) this.#delay = this.timing.minDelayMs;
      await this.#sleep(this.#delay);
      if (!ready) this.#delay = Math.min(this.#delay * 2, this.timing.maxDelayMs);
    }
  }

  #socketUrl(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new RelayError("bad_relay_reply", "the relay did not return an event socket URL");
    }
    if (url.protocol === "wss:" || (url.protocol === "ws:" && this.loopback && isLoopback(url.hostname))) return url.href;
    throw new RelayError("bad_relay_reply", "the relay's event socket is not a wss:// URL");
  }

  // Resolves when the socket is gone: true if it got as far as `ready`.
  #listen(id, raw) {
    const url = this.#socketUrl(raw);
    return new Promise((resolve) => {
      const ws = new this.#WebSocket(url);
      let pinger = null;
      let lastSeen = Date.now();
      let lastPing = 0;
      const sock = {
        session: id,
        ws,
        ready: false,
        done: false,
        finish: (closeIt = false) => {
          if (sock.done) return;
          sock.done = true;
          clearInterval(pinger);
          if (closeIt) {
            try {
              ws.close();
            } catch {}
          }
          if (this.#socket === sock) this.#socket = null;
          resolve(sock.ready);
        },
      };
      this.#socket = sock;
      ws.addEventListener("open", () => {
        pinger = setInterval(() => {
          if (lastPing && lastSeen < lastPing) return sock.finish(true); // no answer to the last ping
          lastPing = Date.now();
          try {
            ws.send("ping");
          } catch {}
        }, this.timing.pingMs);
      });
      ws.addEventListener("message", (event) => {
        lastSeen = Date.now();
        if (sock.done || typeof event.data !== "string" || event.data === "pong") return;
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame?.type === "ready") {
          sock.ready = true;
          this.#lastLogged = null;
          if (frame.peer && this.sessionId === id) this.self = frame.peer;
        } else if (frame?.type === "messages" && Array.isArray(frame.messages) && frame.messages.length) {
          this.#deliver(frame.messages);
        } else if (frame?.type === "closed") {
          if (SESSION_GONE.includes(frame.code)) this.#lost(id);
          else sock.finish(true);
        }
      });
      ws.addEventListener("close", () => sock.finish());
      ws.addEventListener("error", () => sock.finish(true));
    });
  }

  // Pushed messages are already delivered on the relay's side, so hand them on
  // in order, one batch at a time.
  #deliver(messages) {
    this.#delivering = this.#delivering
      .then(() => this.onMessages(messages))
      .catch((err) => this.#report(err));
  }

  #report(err) {
    if (this.closed) return;
    const line = `shiplet-handshake relay: ${err?.message || err}`;
    if (line === this.#lastLogged) return; // one line per distinct failure, not one per retry
    this.#lastLogged = line;
    this.#log(line);
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#sleeping = null;
        resolve();
      }, ms);
      this.#sleeping = { timer, resolve };
    });
  }

  #wake() {
    if (!this.#sleeping) return;
    clearTimeout(this.#sleeping.timer);
    this.#sleeping.resolve();
    this.#sleeping = null;
  }
}
