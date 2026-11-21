// The MCP server both apps load (stdio). It registers this session as a peer
// when it starts and stays registered while the process lives; the peer
// disappears when the app closes the server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HandshakeClient } from "../core/client.js";
import { formatForModel, LIMITS } from "../core/protocol.js";
import { toShipletTrace } from "../core/trace.js";
import { realCwd } from "../transports/local/paths.js";

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

export function createHandshakeServer({ identity, connect }) {
  let client = null;
  let connecting = null;
  const me = { ...identity };

  async function bridge() {
    if (client) return client;
    connecting ??= (async () => {
      const transport = await connect();
      const c = new HandshakeClient(transport);
      transport.onClose(() => {
        if (client === c) client = null;
      });
      await c.register(me);
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

  const server = new McpServer({ name: "shiplet-handshake", version: VERSION });
  const tool = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, guard(handler));

  tool("whoami", "Show how this session appears to other agent sessions on this machine.", {}, async () => text((await (await bridge()).whoami()).peer));

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
    "List the agent sessions (Claude Code, Codex, ...) you can open a handshake with.",
    {},
    async () => {
      const { self, peers } = await (await bridge()).peers();
      return text(peers.map((p) => ({ ...p, you: p.id === self })));
    },
  );

  tool(
    "send",
    "Send a message to another agent session by peer name or id. Messages are held in memory only until the peer reads them. Set record=true to keep this handshake in memory so it can be exported. When the work comes from a Shiplet annotation, pass it as request so the person who asked can follow the handshake from it.",
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
    async (args) => text(await (await bridge()).send(args)),
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
      const exported = await (await bridge()).export(room);
      const file = path.resolve(me.cwd || process.cwd(), out || `handshake-${room}.trace.jsonl`);
      fs.writeFileSync(file, toShipletTrace(exported, { version: VERSION }), { mode: 0o600, flag: "wx" });
      return text({ file, messages: exported.messages.length });
    },
  );

  return { server, bridge, close: () => client?.close() };
}

export async function runMcpServer({ identity, connect }) {
  const bridge = createHandshakeServer({ identity, connect });
  const transport = new StdioServerTransport();
  const shutdown = () => {
    bridge.close();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  transport.onclose = shutdown;
  await bridge.server.connect(transport);
  // Register right away so peers and hooks can find this session before its first tool call.
  bridge.bridge().catch((err) => process.stderr.write(`shiplet-handshake: ${err.message}\n`));
}
