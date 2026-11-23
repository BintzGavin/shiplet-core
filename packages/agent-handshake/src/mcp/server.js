// The MCP server both apps load (stdio). It registers this session as a peer
// when it starts and stays registered while the process lives; the peer
// disappears when the app closes the server.
//
// With SHIPLET_API_URL, SHIPLET_ORGANIZATION_ID and SHIPLET_API_KEY all set,
// it also opens a session on the hosted Shiplet relay and hands every pushed
// relay message to its own local peer, so hooks deliver them like local ones.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HandshakeClient } from "../core/client.js";
import { formatForModel, LIMITS, ProtocolError } from "../core/protocol.js";
import { toShipletTrace } from "../core/trace.js";
import { realCwd } from "../transports/local/paths.js";
import { connectRelay, relayConfig } from "../transports/relay/client.js";

const VERSION = "0.1.0";

export function detectIdentity({ env = process.env, kind, app, name } = {}) {
  const k = kind || (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID ? "claude" : env.CODEX_THREAD_ID ? "codex" : "other");
  const cwd = realCwd(env.CLAUDE_PROJECT_DIR || process.cwd());
  const base = path.basename(cwd).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "session";
  return {
    name: name || `${k}-${base}`,
    kind: k,
    app: app || k,
    machine: os.hostname(),
    session: env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID || null,
    cwd,
    pid: process.ppid,
  };
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (err) => ({ content: [{ type: "text", text: `shiplet-handshake error (${err.code || "error"}): ${err.message}` }], isError: true });
const stderrLog = (line) => process.stderr.write(`${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INJECT_BATCH = 50; // the hub's limit per inject

// `relay` is null (local only) or the options for connectRelay.
export function createHandshakeServer({ identity, connect, relay = null, log = stderrLog }) {
  let client = null;
  let connecting = null;
  let localName = null; // the name the local broker gave this peer
  const me = { ...identity };
  let link = null; // the relay session, once started
  const relayPeers = new Map(); // relay peer id -> name, from list_peers, sends and received messages
  const relayRooms = new Set(); // relay handshake ids seen in received messages or relay sends
  let oldBrokerLogged = false;

  async function bridge() {
    if (client) return client;
    connecting ??= (async () => {
      const transport = await connect();
      const c = new HandshakeClient(transport);
      transport.onClose(() => {
        if (client === c) client = null;
      });
      localName = (await c.register(me)).peer?.name ?? null;
      client = c;
      return c;
    })().finally(() => (connecting = null));
    return connecting;
  }

  const guard = (fn) => async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return failure(err);
    }
  };

  // Relay messages go to this session's own local peer. If the broker
  // connection was replaced, bridge() reconnects and they go to the new one.
  async function injectBatch(batch, attempt = 0) {
    try {
      await (await bridge()).inject(batch);
    } catch (err) {
      if (err.code === "bad_request" && /unknown op/.test(err.message)) {
        // A broker started by an older version of this package is still running.
        if (!oldBrokerLogged) log("shiplet-handshake relay: the running local broker is too old to receive relay messages; restart it (close every session using it)");
        oldBrokerLogged = true;
        return;
      }
      if (err.code === "bad_request") {
        if (batch.length > 1) {
          for (const message of batch) await injectBatch([message]);
        } else log(`shiplet-handshake relay: dropped a relay message the local broker refused (${err.message})`);
        return;
      }
      if (attempt >= 4) {
        log(`shiplet-handshake relay: could not hand ${batch.length} relay message(s) to this session (${err.message})`);
        return;
      }
      await sleep(250 * 2 ** attempt);
      await injectBatch(batch, attempt + 1);
    }
  }

  async function receiveRelay(messages) {
    for (const m of messages) {
      if (typeof m?.room === "string") relayRooms.add(m.room);
      if (typeof m?.from?.id === "string") relayPeers.set(m.from.id, m.from.name);
    }
    for (let i = 0; i < messages.length; i += INJECT_BATCH) await injectBatch(messages.slice(i, i + INJECT_BATCH));
  }

  function startRelay() {
    if (!relay || link) return link;
    link = connectRelay({
      ...relay,
      identity: { name: localName ?? me.name, kind: me.kind, app: me.app, machine: me.machine },
      onMessages: receiveRelay,
      log,
    });
    return link;
  }

  // Relay peers other than this session's own, with only the fields the relay documents.
  async function relayPeerList() {
    const { self, peers = [] } = await link.peers();
    const others = peers
      .filter((p) => p && p.id !== self && p.id !== link.self?.id)
      .map(({ id, name, kind, app, machine, account, connectedAt }) => ({ id, name, kind, app, machine, account, connectedAt, where: "relay" }));
    for (const p of others) relayPeers.set(p.id, p.name);
    return others;
  }

  // Local wins. The relay gets the message for a known relay peer id or relay
  // handshake, or for a name that no local peer has and a relay peer does.
  async function routesToRelay({ to, room }) {
    if (!link) return false;
    if (room && relayRooms.has(room)) return true;
    if (relayPeers.has(to)) return true;
    const { peers } = await (await bridge()).peers();
    if (peers.some((p) => p.id === to || p.name === to)) return false;
    let remote;
    try {
      remote = await relayPeerList();
    } catch (err) {
      throw new ProtocolError(err.code || "relay_error", `no live local peer named ${JSON.stringify(to)}, and the Shiplet relay could not be asked: ${err.message}`);
    }
    return remote.some((p) => p.id === to || p.name === to);
  }

  const server = new McpServer({ name: "shiplet-handshake", version: VERSION });
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, guard(handler));

  tool(
    "whoami",
    relay
      ? "Show how this session appears to other agent sessions on this machine, and its Shiplet relay session when connected."
      : "Show how this session appears to other agent sessions on this machine.",
    {},
    async () => {
      const { peer } = await (await bridge()).whoami();
      const onRelay = link?.status();
      return text(peer && onRelay ? { ...peer, relay: onRelay } : peer);
    },
  );

  tool(
    "register",
    "Change this session's peer name, or bind it to a harness session id so hooks can deliver messages into it.",
    { name: z.string().max(LIMITS.nameChars).optional(), session: z.string().max(255).optional() },
    async ({ name, session }) => {
      const c = await bridge();
      const { peer } = await c.register({ ...me, ...(name && { name }), ...(session && { session }) });
      Object.assign(me, { name: peer.name, session: peer.session });
      return text(peer);
    },
  );

  tool(
    "list_peers",
    relay
      ? 'List the agent sessions (Claude Code, Codex, ...) you can open a handshake with: on this machine, and on the Shiplet relay (marked where: "relay", with the Shiplet account each acts for).'
      : "List the agent sessions (Claude Code, Codex, ...) you can open a handshake with.",
    {},
    async () => {
      const { self, peers } = await (await bridge()).peers();
      const local = peers.map((p) => ({ ...p, you: p.id === self }));
      if (!link) return text(local);
      let remote = [];
      try {
        remote = await relayPeerList();
      } catch (err) {
        log(`shiplet-handshake relay: could not list relay peers (${err.message})`);
      }
      return text([...local, ...remote]);
    },
  );

  const sendDescription =
    "Send a message to another agent session by peer name or id. Messages are held in memory only until the peer reads them. Set record=true to keep this handshake in memory so it can be exported. When the work comes from a Shiplet annotation, pass it as request so the person who asked can follow the handshake from it.";
  tool(
    "send",
    relay
      ? `${sendDescription} Relay peers (where: "relay" in list_peers) and relay handshakes go through the Shiplet relay. When a local peer and a relay peer share a name, the local peer gets the message: use the relay peer's id to reach it.`
      : sendDescription,
    {
      to: z.string().describe("peer name or id from list_peers"),
      text: z.string().describe("message body"),
      room: z.string().optional().describe("handshake id to continue; defaults to the direct handshake with this peer"),
      record: z.boolean().optional().describe("keep this handshake's messages in memory for export_handshake"),
      topic: z.string().max(200).optional().describe("what this handshake is about, shown to people watching it in Shiplet"),
      request: z
        .object({
          shiplet: z.string().max(128).describe("Shiplet id the annotation was left on"),
          feedback: z.string().max(128).describe("the annotation (feedback) id"),
          label: z.string().max(64).optional().describe("its ticket label, such as PF-12"),
        })
        .optional()
        .describe("the Shiplet annotation that asked for this work, when you are working on one"),
    },
    async (args) => {
      if (!(await routesToRelay(args))) return text(await (await bridge()).send(args));
      const { to, text: body, room, record, topic, request } = args;
      const sent = await link.send({ to, text: body, handshake: room, record, topic, request });
      if (typeof sent.handshake === "string") relayRooms.add(sent.handshake);
      if (typeof sent.to?.id === "string") relayPeers.set(sent.to.id, sent.to.name);
      return text({ id: sent.id, room: sent.handshake, at: sent.at, to: sent.to, status: sent.status, recorded: sent.recorded, where: "relay" });
    },
  );

  tool(
    "read_inbox",
    "Read messages other agents sent to this session. With wait_ms, waits (long-poll) up to that long for the first message. Messages are deleted once returned.",
    { wait_ms: z.number().int().min(0).max(LIMITS.maxWaitMs).optional() },
    async ({ wait_ms = 0 }) => {
      const { messages } = await (await bridge()).read({ wait_ms, via: "tool" });
      if (!messages.length) return text(wait_ms ? `No messages after waiting ${Math.round(wait_ms / 1000)}s.` : "No messages.");
      return text(formatForModel(messages));
    },
  );

  tool(
    "export_handshake",
    "Write a recorded handshake to a local file in Shiplet's open trace format (shiplet.trace/v1 JSON Lines). Nothing is uploaded.",
    {
      room: z.string().describe("handshake id (the `room` returned by send)"),
      path: z.string().optional().describe("output file; defaults to ./handshake-<room>.trace.jsonl in the session's cwd"),
    },
    async ({ room, path: out }) => {
      if (relayRooms.has(room)) {
        throw new ProtocolError("relay_handshake", `${room} is a Shiplet relay handshake; export it with Shiplet MCP instead`);
      }
      const exported = await (await bridge()).export(room);
      const file = path.resolve(me.cwd || process.cwd(), out || `handshake-${room}.trace.jsonl`);
      fs.writeFileSync(file, toShipletTrace(exported, { version: VERSION }), { mode: 0o600, flag: "wx" });
      return text({ file, messages: exported.messages.length });
    },
  );

  return {
    server,
    bridge,
    startRelay,
    relay: () => link,
    close: async () => {
      const leaving = link?.close(); // best effort, bounded by a short timeout
      client?.close();
      await leaving;
    },
  };
}

export async function runMcpServer({ identity, connect, env = process.env }) {
  let relay = null;
  try {
    relay = relayConfig(env);
  } catch (err) {
    stderrLog(`shiplet-handshake relay: ${err.message}; the relay is off`);
  }
  const bridge = createHandshakeServer({ identity, connect, relay });
  const transport = new StdioServerTransport();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    bridge.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  transport.onclose = shutdown;
  if (relay) {
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }
  await bridge.server.connect(transport);
  // Register right away so peers and hooks can find this session before its
  // first tool call, then join the relay under the same name.
  bridge
    .bridge()
    .catch((err) => stderrLog(`shiplet-handshake: ${err.message}`))
    .finally(() => {
      try {
        bridge.startRelay();
      } catch (err) {
        stderrLog(`shiplet-handshake relay: ${err.message}; the relay is off`);
      }
    });
}
