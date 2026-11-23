// The relay transport against a fake Shiplet relay that runs in this process:
// an HTTP server for the REST calls and a minimal RFC 6455 server (text frames
// only) for the push socket. Covers the relay client on its own, the MCP server
// bridging it in process, and real MCP server and hook processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Hub } from "../src/core/hub.js";
import { formatForModel } from "../src/core/protocol.js";
import { createHandshakeServer } from "../src/mcp/server.js";
import { connectRelay, relayConfig } from "../src/transports/relay/client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin/shiplet-handshake.js");
const KEY = "shk_test_relay_key_never_print_7f3a9c";
const ORG = "org_relay_test";
const FAST = { minDelayMs: 20, maxDelayMs: 100, pingMs: 60 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`);
    await sleep(20);
  }
}

// --- a minimal WebSocket server: unfragmented frames, masked from the client ---

function encodeFrame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const frames = [];
  let buf = buffer;
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    const maskAt = off;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i % 4)];
    frames.push({ opcode, payload });
    buf = buf.subarray(off + len);
  }
  return { frames, rest: buf };
}

// --- the fake relay ---

async function fakeRelay() {
  const state = { calls: [], opened: [], sent: [], deleted: [], tickets: 0, pings: 0, answerPings: true, extraPeers: [], sessions: new Map() };
  const tickets = new Map();
  const sockets = new Set();
  let n = 0;
  let base;

  const reply = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  function handle(req, res, raw) {
    const url = new URL(req.url, base);
    state.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) return reply(res, 401, { error: "unauthorized", message: "unknown API key" });
    const m = url.pathname.match(/^\/api\/organizations\/([^/]+)\/handshake-sessions(?:\/([^/]+)(?:\/(peers|messages|inbox|events))?)?$/);
    if (!m || decodeURIComponent(m[1]) !== ORG) return reply(res, 404, { error: "not_found", message: "no such route" });
    const body = raw ? JSON.parse(raw) : null;
    const [, , id, sub] = m;
    if (!id && req.method === "POST") {
      state.opened.push(body);
      const session = `hss_${++n}`;
      const peer = { id: `peer_relay_self_${n}`, name: body.name, kind: body.kind, app: body.app, machine: body.machine, account: "CI key" };
      state.sessions.set(session, { peer, socket: null, queue: [] });
      return reply(res, 201, { session, peer });
    }
    const s = state.sessions.get(id);
    if (!s) return reply(res, 404, { error: "session_not_found", message: "this handshake session has ended; open a new one" });
    if (!sub && req.method === "DELETE") {
      state.sessions.delete(id);
      state.deleted.push(id);
      s.socket?.end();
      return reply(res, 200, { closed: true });
    }
    if (sub === "peers") {
      const own = [...state.sessions.values()].map((x) => ({ ...x.peer, connectedAt: "2026-11-23T10:00:00.000Z" }));
      return reply(res, 200, { self: s.peer.id, peers: [...own, ...state.extraPeers] });
    }
    if (sub === "messages") {
      state.sent.push({ session: id, body });
      const target = state.extraPeers.find((p) => p.id === body.to || p.name === body.to);
      if (!target) return reply(res, 404, { error: "not_found", message: `no live peer named ${JSON.stringify(body.to)}` });
      return reply(res, 200, {
        id: `msg_relay_${state.sent.length}`,
        handshake: body.handshake ?? "hs_relay_dm",
        at: "2026-11-23T10:00:01.000Z",
        to: { id: target.id, name: target.name, kind: target.kind },
        status: "queued",
        recorded: body.record === true,
      });
    }
    if (sub === "inbox") return reply(res, 200, { messages: [], queued: 0 });
    if (sub === "events" && req.method === "POST") {
      const ticket = `hset_${++state.tickets}`;
      tickets.set(ticket, id);
      const wsBase = base.replace(/^http/, "ws");
      return reply(res, 201, { url: `${wsBase}/api/organizations/${ORG}/handshake-sessions/${id}/events?ticket=${ticket}`, expiresAt: "2026-11-23T10:01:00.000Z" });
    }
    return reply(res, 404, { error: "not_found", message: "no such route" });
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => handle(req, res, raw));
  });

  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const url = new URL(req.url, base);
    const ticket = url.searchParams.get("ticket");
    const id = tickets.get(ticket);
    tickets.delete(ticket); // single use
    const s = id && state.sessions.get(id);
    if (!s || !url.pathname.endsWith(`/${id}/events`)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = {
      session: id,
      ready: false,
      send: (value) => socket.write(encodeFrame(1, typeof value === "string" ? value : JSON.stringify(value))),
      end: () => {
        if (socket.destroyed) return;
        socket.write(encodeFrame(8, Buffer.from([0x03, 0xe8])));
        socket.end();
      },
      destroy: () => socket.destroy(),
    };
    s.socket = conn;
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      const decoded = decodeFrames(Buffer.concat([buf, chunk]));
      buf = decoded.rest;
      for (const frame of decoded.frames) {
        if (frame.opcode === 1 && frame.payload.toString() === "ping") {
          state.pings++;
          if (state.answerPings) conn.send("pong");
        } else if (frame.opcode === 8 && !socket.destroyed) socket.end(encodeFrame(8, frame.payload.subarray(0, 2)));
      }
    });
    socket.on("close", () => {
      if (s.socket === conn) s.socket = null;
    });
    conn.send({ type: "ready", session: id, peer: s.peer });
    if (s.queue.length) conn.send({ type: "messages", messages: s.queue.splice(0) });
    conn.ready = true;
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    url: base,
    state,
    // The session with an open push socket, if any.
    live: () => [...state.sessions.entries()].find(([, s]) => s.socket?.ready)?.[0] ?? null,
    push(id, messages) {
      const s = state.sessions.get(id);
      if (s.socket) s.socket.send({ type: "messages", messages });
      else s.queue.push(...messages);
    },
    drop(id) {
      state.sessions.get(id)?.socket?.destroy();
    },
    // The relay forgets a session, as after an idle timeout or a restart.
    forget(id, { notify = true } = {}) {
      const s = state.sessions.get(id);
      state.sessions.delete(id);
      if (notify && s?.socket) {
        s.socket.send({ type: "closed", code: "session_not_found", message: "the relay restarted" });
        s.socket.end();
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

function relayMessage(n, overrides = {}) {
  return {
    id: `msg_remote_${n}`,
    room: "hs_remote",
    from: {
      id: "peer_r_reviewer",
      name: "reviewer",
      kind: "person",
      app: "shiplet-review",
      machine: null,
      account: "Ana",
      // The relay sends these as null; even if it did not, they must not cross.
      session: "should-not-cross",
      cwd: "/should/not/cross",
    },
    to: { id: "peer_relay_self_1", name: "claude-a", kind: "claude" },
    text: `relay message ${n}`,
    at: "2026-11-23T10:00:00.000Z",
    ...overrides,
  };
}

// --- an in-process MCP server over an in-process Hub ---

function hubTransport(hub) {
  const conn = hub.open();
  const callbacks = [];
  let closed = false;
  const wire = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  return {
    async request(op, args) {
      if (closed) throw Object.assign(new Error("shiplet-handshake broker connection closed"), { code: "disconnected" });
      try {
        return wire(await conn.handle(op, wire(args)));
      } catch (err) {
        throw Object.assign(new Error(err.message), { code: err.code });
      }
    },
    onClose: (cb) => callbacks.push(cb),
    close() {
      if (closed) return;
      closed = true;
      conn.close();
      for (const cb of callbacks) cb();
    },
  };
}

const IDENTITY = { name: "claude-a", kind: "claude", app: "claude-cli", machine: "studio", session: "sess-1", cwd: "/work/secret-project", pid: 4242 };

async function inProcess(hub, relay) {
  const transports = [];
  const logs = [];
  const handshake = createHandshakeServer({
    identity: IDENTITY,
    connect: async () => {
      const t = hubTransport(hub);
      transports.push(t);
      return t;
    },
    relay,
    log: (line) => logs.push(line),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await handshake.server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  await handshake.bridge();
  handshake.startRelay();
  const outputs = [];
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const out = res.content.map((c) => c.text).join("");
    outputs.push(out);
    if (res.isError) throw new Error(out);
    return out;
  };
  return {
    handshake,
    client,
    call,
    outputs,
    logs,
    transports,
    close: async () => {
      await client.close();
      await handshake.close();
    },
  };
}

// --- real processes ---

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "abr-"));
  const dirs = { base, bridge: path.join(base, "b"), home: path.join(base, "home"), cwd: path.join(base, "proj") };
  for (const d of [dirs.home, dirs.cwd]) fs.mkdirSync(d);
  const env = { PATH: process.env.PATH, HOME: dirs.home, SHIPLET_HANDSHAKE_DIR: dirs.bridge, SHIPLET_HANDSHAKE_IDLE_MS: "300" };
  return { dirs, env };
}

async function mcpProcess(env, { kind, name, cwd, session }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp", "--kind", kind, "--name", name],
    cwd,
    env: { ...env, ...(session && { CLAUDE_CODE_SESSION_ID: session }) },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (d) => (stderr += d));
  const client = new Client({ name: `test-${name}`, version: "0" });
  await client.connect(transport);
  const outputs = [];
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 });
    const out = res.content.map((c) => c.text).join("");
    outputs.push(out);
    if (res.isError) throw new Error(out);
    return out;
  };
  return { call, outputs, stderr: () => stderr, close: () => client.close() };
}

function runHook(env, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "hook", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

// --- tests ---

test("relayConfig is on only with all three variables, and only for HTTPS or loopback HTTP", () => {
  const all = { SHIPLET_API_URL: "https://shiplet.example/", SHIPLET_ORGANIZATION_ID: ORG, SHIPLET_API_KEY: KEY };
  assert.deepEqual(relayConfig(all), { apiUrl: "https://shiplet.example", organization: ORG, apiKey: KEY });
  for (const missing of Object.keys(all)) assert.equal(relayConfig({ ...all, [missing]: "" }), null, missing);
  assert.equal(relayConfig({ ...all, SHIPLET_API_URL: "http://127.0.0.1:8787" }).apiUrl, "http://127.0.0.1:8787");
  for (const bad of ["http://shiplet.example", "https://shiplet.example/api", "https://u:p@shiplet.example", "not a url"]) {
    assert.throws(() => relayConfig({ ...all, SHIPLET_API_URL: bad }), (err) => err.code === "bad_config" && !err.message.includes(KEY), bad);
  }
});

test("the relay client holds the push socket: pings, reconnects with a new ticket, and reopens a lost session", async () => {
  const fake = await fakeRelay();
  const received = [];
  const logs = [];
  const link = connectRelay({
    apiUrl: fake.url,
    organization: ORG,
    apiKey: KEY,
    identity: { ...IDENTITY },
    onMessages: (messages) => received.push(...messages),
    log: (line) => logs.push(line),
    ...FAST,
  });
  try {
    await until(() => fake.live() === "hss_1" && link.connected);
    assert.deepEqual(fake.state.opened, [{ name: "claude-a", kind: "claude", app: "claude-cli", machine: "studio" }], "only name, kind, app and machine cross");
    assert.deepEqual(link.status(), { session: "hss_1", peerId: "peer_relay_self_1" });
    await until(() => fake.state.pings >= 2);

    fake.push("hss_1", [relayMessage(1)]);
    await until(() => received.length === 1);

    // The socket drops: same session, a fresh single-use ticket.
    fake.drop("hss_1");
    await until(() => fake.state.tickets === 2 && fake.live() === "hss_1");
    assert.equal(fake.state.opened.length, 1);

    // A `closed` frame with session_not_found: open a new session and carry on.
    fake.forget("hss_1");
    await until(() => fake.live() === "hss_2");
    fake.push("hss_2", [relayMessage(2)]);
    await until(() => received.length === 2);

    // An HTTP 404 session_not_found: reopen, retry the call once, and move the socket.
    fake.forget("hss_2", { notify: false });
    const { self } = await link.peers();
    assert.equal(self, "peer_relay_self_3");
    await until(() => fake.live() === "hss_3");

    // Any other 404 is passed through without reopening.
    await assert.rejects(link.send({ to: "nobody", text: "hi" }), (err) => err.code === "not_found");
    assert.equal(fake.state.opened.length, 3);

    // No answer to a ping: the connection is treated as dead and replaced.
    const ticketsBefore = fake.state.tickets;
    fake.state.answerPings = false;
    await until(() => fake.state.tickets > ticketsBefore);
    fake.state.answerPings = true;
    await until(() => fake.live() === "hss_3" && link.connected);

    assert.deepEqual(received.map((m) => m.text), ["relay message 1", "relay message 2"]);
  } finally {
    await link.close();
  }
  assert.deepEqual(fake.state.deleted, ["hss_3"], "the session is closed on the way out");
  const callsAtClose = fake.state.calls.length;
  await sleep(250);
  assert.equal(fake.state.calls.length, callsAtClose, "nothing runs after close");
  assert.ok(fake.state.calls.every((c) => c.auth === `Bearer ${KEY}` && !c.url.includes(KEY)), "the key goes in the header only");
  assert.ok(logs.every((line) => !line.includes(KEY)));
  await fake.close();
});

test("a pushed relay message reaches a waiting Stop-hook read, marked via relay, even after the broker connection is replaced", async () => {
  const fake = await fakeRelay();
  const hub = new Hub();
  const s = await inProcess(hub, { apiUrl: fake.url, organization: ORG, apiKey: KEY, ...FAST });
  try {
    await until(() => fake.live() === "hss_1");
    const hook = hub.open();
    const waiting = hook.handle("read", { session: "sess-1", via: "stop", wait_ms: 5000 });
    fake.push("hss_1", [relayMessage(1)]);
    const { messages } = await waiting;
    assert.equal(messages.length, 1);
    const [m] = messages;
    assert.equal(m.via, "relay");
    assert.equal(m.text, "relay message 1");
    assert.deepEqual([m.from.name, m.from.kind, m.from.account], ["reviewer", "person", "Ana"]);
    assert.deepEqual([m.from.session, m.from.cwd], [null, null], "no cwd or session id from the relay");
    assert.match(formatForModel(messages), /from="reviewer" kind="person"[^>]*via="relay" account="Ana"/);

    // The local broker connection goes away; the next relay message goes to the new one.
    s.transports[0].close();
    const again = hook.handle("read", { session: "sess-1", via: "stop", wait_ms: 5000 });
    fake.push("hss_1", [relayMessage(2)]);
    const second = await again;
    assert.deepEqual(second.messages.map((x) => [x.text, x.via]), [["relay message 2", "relay"]]);
    assert.equal(s.transports.length, 2);
    hook.close();
  } finally {
    await s.close();
    await fake.close();
  }
});

test("one bad relay message does not cost the rest of its batch, and an old broker is reported once", async () => {
  const fake = await fakeRelay();
  const hub = new Hub();
  const s = await inProcess(hub, { apiUrl: fake.url, organization: ORG, apiKey: KEY, ...FAST });
  try {
    await until(() => fake.live() === "hss_1");
    fake.push("hss_1", [relayMessage(1), relayMessage(2, { text: "" }), relayMessage(3)]);
    await until(() => s.logs.some((line) => /dropped a relay message/.test(line)));
    const { messages } = await hub.open().handle("read", { session: "sess-1" });
    assert.deepEqual(messages.map((m) => m.text), ["relay message 1", "relay message 3"]);

    // A broker from before `inject` existed answers "unknown op".
    const transport = s.transports[0];
    const request = transport.request;
    transport.request = (op, args) =>
      op === "inject" ? Promise.reject(Object.assign(new Error('unknown op "inject"'), { code: "bad_request" })) : request(op, args);
    fake.push("hss_1", [relayMessage(4)]);
    fake.push("hss_1", [relayMessage(5)]);
    await until(() => s.logs.some((line) => /too old/.test(line)));
    await sleep(100);
    assert.equal(s.logs.filter((line) => /too old/.test(line)).length, 1);
  } finally {
    await s.close();
    await fake.close();
  }
});

test("list_peers adds relay peers and send routes by relay id, relay handshake, and name, with local winning a clash", async () => {
  const fake = await fakeRelay();
  fake.state.extraPeers = [
    { id: "peer_r_reviewer", name: "reviewer", kind: "person", app: "shiplet-review", machine: null, account: "Ana", connectedAt: "2026-11-23T09:00:00.000Z" },
    { id: "peer_r_codexb", name: "codex-b", kind: "codex", app: "codex-cli", machine: "ci-04", account: "CI key", connectedAt: "2026-11-23T09:00:00.000Z", cwd: "/not/documented" },
  ];
  const hub = new Hub();
  const codex = hub.open();
  await codex.handle("register", { name: "codex-b", kind: "codex", app: "codex-cli" });
  const s = await inProcess(hub, { apiUrl: fake.url, organization: ORG, apiKey: KEY, ...FAST });
  try {
    await until(() => fake.live() === "hss_1");

    const me = JSON.parse(await s.call("whoami"));
    assert.equal(me.name, "claude-a");
    assert.deepEqual(me.relay, { session: "hss_1", peerId: "peer_relay_self_1" });

    const peers = JSON.parse(await s.call("list_peers"));
    assert.deepEqual(
      peers.map((p) => [p.name, p.where ?? "local", p.you ?? false]),
      [
        ["codex-b", "local", false],
        ["claude-a", "local", true],
        ["reviewer", "relay", false],
        ["codex-b", "relay", false],
      ],
    );
    const relayCodex = peers.find((p) => p.id === "peer_r_codexb");
    assert.equal(relayCodex.account, "CI key");
    assert.equal("cwd" in relayCodex, false, "relay peers carry only the documented fields");
    assert.ok(!peers.some((p) => p.id === "peer_relay_self_1"), "this session's own relay peer is not listed");

    // A name only the relay has goes to the relay; room maps to handshake.
    const toReviewer = JSON.parse(
      await s.call("send", { to: "reviewer", text: "Is the pay button still gray?", topic: "Pay button", request: { shiplet: "proj_1", feedback: "fb_1" } }),
    );
    assert.deepEqual([toReviewer.where, toReviewer.room, toReviewer.status], ["relay", "hs_relay_dm", "queued"]);
    assert.deepEqual(fake.state.sent[0].body, {
      to: "reviewer",
      text: "Is the pay button still gray?",
      topic: "Pay button",
      request: { shiplet: "proj_1", feedback: "fb_1" },
    });

    // A relay peer id goes to the relay, even though a local peer has its name.
    const byId = JSON.parse(await s.call("send", { to: "peer_r_codexb", text: "relay codex, are you there?" }));
    assert.equal(byId.where, "relay");
    assert.equal(fake.state.sent[1].body.to, "peer_r_codexb");

    // A name both have: the local peer wins.
    const local = JSON.parse(await s.call("send", { to: "codex-b", text: "local codex, run the tests" }));
    assert.equal(local.where, undefined);
    assert.match(local.room, /^hs_/);
    assert.equal(fake.state.sent.length, 2);
    assert.deepEqual((await codex.handle("read", {})).messages.map((m) => m.text), ["local codex, run the tests"]);

    // A handshake id from a received relay message routes to the relay, and the message shows in read_inbox.
    fake.push("hss_1", [relayMessage(1, { room: "hs_pushed" })]);
    const inbox = await s.call("read_inbox", { wait_ms: 3000 });
    assert.match(inbox, /from="reviewer" kind="person"[^>]*via="relay" account="Ana" room="hs_pushed"/);
    const inRoom = JSON.parse(await s.call("send", { to: "codex-b", text: "continuing on the relay", room: "hs_pushed" }));
    assert.deepEqual([inRoom.where, inRoom.room], ["relay", "hs_pushed"]);
    assert.equal(fake.state.sent[2].body.handshake, "hs_pushed");
    assert.equal(fake.state.sent[2].body.to, "codex-b");

    // Nobody by that name anywhere: the local error, and nothing sent to the relay.
    await assert.rejects(s.call("send", { to: "nobody", text: "hi" }), /not_found[\s\S]*no live peer named "nobody"/);
    assert.equal(fake.state.sent.length, 3);

    // Relay handshakes are exported with Shiplet MCP, not here.
    await assert.rejects(s.call("export_handshake", { room: "hs_pushed" }), /relay_handshake[\s\S]*Shiplet MCP/);
    await assert.rejects(s.call("export_handshake", { room: "hs_relay_dm" }), /Shiplet MCP/);

    // The tool descriptions explain the routing.
    const { tools } = await s.client.listTools();
    assert.match(tools.find((t) => t.name === "send").description, /local peer gets the message/);

    for (const out of s.outputs) assert.ok(!out.includes(KEY), "no tool output carries the API key");
    for (const line of s.logs) assert.ok(!line.includes(KEY));
  } finally {
    await s.close();
    await fake.close();
  }
  codex.close();
});

test("a real Claude MCP server on the relay wakes a real asyncRewake Stop hook, and leaves the relay on exit", async () => {
  const fake = await fakeRelay();
  const { dirs, env } = sandbox();
  const relayEnv = { ...env, SHIPLET_API_URL: fake.url, SHIPLET_ORGANIZATION_ID: ORG, SHIPLET_API_KEY: KEY };
  const claude = await mcpProcess(relayEnv, { kind: "claude", name: "claude-a", cwd: dirs.cwd, session: "sess-claude-1" });
  try {
    await until(() => fake.live() === "hss_1", 10_000);
    assert.deepEqual(fake.state.opened, [{ name: "claude-a", kind: "claude", app: "claude", machine: os.hostname() }]);

    const input = { session_id: "sess-claude-1", cwd: dirs.cwd, hook_event_name: "Stop" };
    const hook = runHook(env, ["stop", "--kind", "claude", "--wait", "30"], input); // the hook has no relay settings
    await sleep(500);
    fake.push("hss_1", [relayMessage(1, { text: "the pay button is fixed on staging" })]);
    const woke = await hook;
    assert.equal(woke.code, 2);
    assert.match(woke.stderr, /<peer-message [^>]*from="reviewer" kind="person"[^>]*via="relay" account="Ana"[^>]*>\nthe pay button is fixed on staging/);
    assert.doesNotMatch(woke.stderr, /should-not-cross|\/should\/not\/cross/);

    const me = JSON.parse(await claude.call("whoami"));
    assert.equal(me.relay.session, "hss_1");
    assert.equal(me.cwd, fs.realpathSync(dirs.cwd), "the local registration is unchanged");
    await claude.call("list_peers");
    await assert.rejects(claude.call("send", { to: "nobody", text: "hi" }), /not_found/);
  } finally {
    await claude.close();
  }
  await until(() => fake.state.deleted.includes("hss_1"), 5000);
  for (const out of claude.outputs) assert.ok(!out.includes(KEY));
  assert.ok(!claude.stderr().includes(KEY), "stderr never carries the API key");
  await fake.close();
  fs.rmSync(dirs.base, { recursive: true, force: true });
});

test("without all three relay variables, the MCP server never contacts the relay", async () => {
  const fake = await fakeRelay();
  const { dirs, env } = sandbox();
  const partial = [
    {},
    { SHIPLET_API_URL: fake.url, SHIPLET_ORGANIZATION_ID: ORG },
    { SHIPLET_API_URL: fake.url, SHIPLET_API_KEY: KEY },
    { SHIPLET_ORGANIZATION_ID: ORG, SHIPLET_API_KEY: KEY },
  ];
  try {
    for (const [i, extra] of partial.entries()) {
      const peer = await mcpProcess({ ...env, ...extra }, { kind: "codex", name: `codex-${i}`, cwd: dirs.cwd });
      try {
        const me = JSON.parse(await peer.call("whoami"));
        assert.equal("relay" in me, false);
        const peers = JSON.parse(await peer.call("list_peers"));
        assert.ok(peers.every((p) => !("where" in p)));
        await sleep(300);
      } finally {
        await peer.close();
      }
    }
    assert.deepEqual(fake.state.calls, [], "no relay activity at all");
  } finally {
    await fake.close();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  }
});
