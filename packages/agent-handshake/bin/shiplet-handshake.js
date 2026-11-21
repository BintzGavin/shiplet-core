#!/usr/bin/env node
// shiplet-handshake: live messaging between Claude Code and Codex sessions on one machine.
//
//   shiplet-handshake mcp [--kind claude|codex] [--app NAME] [--name NAME]   stdio MCP server
//   shiplet-handshake hook <session-start|prompt|post-tool|stop> --kind claude|codex [--wait SECONDS]
//   shiplet-handshake broker                                                 run the local broker in the foreground
//   shiplet-handshake peers                                                  list live peers (debugging)
import { parseArgs } from "node:util";
import { HandshakeClient } from "../src/core/client.js";
import { runHook } from "../src/core/hooks.js";
import { connectLocal } from "../src/transports/local/client.js";
import { realCwd } from "../src/transports/local/paths.js";

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    kind: { type: "string" },
    app: { type: "string" },
    name: { type: "string" },
    wait: { type: "string" },
  },
});

async function readStdin(limit = 1024 * 1024) {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > limit) break;
  }
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

switch (command) {
  case "mcp": {
    const { detectIdentity, runMcpServer } = await import("../src/mcp/server.js");
    await runMcpServer({ identity: detectIdentity(values), connect: () => connectLocal() });
    break;
  }
  case "broker": {
    const { startBroker } = await import("../src/transports/local/broker.js");
    const broker = await startBroker();
    if (!broker) process.exit(0); // another broker already owns the socket
    const stop = () => broker.stop();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    await broker.closed;
    break;
  }
  case "hook": {
    const input = await readStdin();
    const result = await runHook({
      event: positionals[0],
      kind: values.kind === "claude" ? "claude" : "codex",
      input,
      waitSeconds: Number(values.wait) || 0,
      connect: async () => new HandshakeClient(await connectLocal({ start: false })),
      normalizeCwd: realCwd,
    });
    if (result.stdout) process.stdout.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exitCode = result.code;
    break;
  }
  case "peers": {
    const client = new HandshakeClient(await connectLocal({ start: false }).catch(() => null) ?? { request: async () => ({ peers: [] }), close() {} });
    const { peers } = await client.peers();
    console.log(JSON.stringify(peers, null, 2));
    client.close();
    break;
  }
  default:
    console.error("usage: shiplet-handshake <mcp|hook|broker|peers> ...");
    process.exitCode = 64;
}
