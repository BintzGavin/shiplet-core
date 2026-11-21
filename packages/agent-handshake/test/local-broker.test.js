// End-to-end: two real MCP server processes (one tagged claude, one tagged
// codex) talk through a real broker on a unix socket in a temporary directory.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin/shiplet-handshake.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ab-"));
  const dirs = { base, bridge: path.join(base, "b"), home: path.join(base, "home"), claudeCwd: path.join(base, "proj-c"), codexCwd: path.join(base, "proj-x") };
  for (const d of [dirs.home, dirs.claudeCwd, dirs.codexCwd]) fs.mkdirSync(d);
  const env = { PATH: process.env.PATH, HOME: dirs.home, SHIPLET_HANDSHAKE_DIR: dirs.bridge, SHIPLET_HANDSHAKE_IDLE_MS: "300" };
  return { dirs, env };
}

async function mcpPeer(env, { kind, name, cwd, session }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "mcp", "--kind", kind, "--name", name],
    cwd,
    env: { ...env, ...(session && { CLAUDE_CODE_SESSION_ID: session }) },
    stderr: "pipe",
  });
  const client = new Client({ name: `test-${name}`, version: "0" });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 });
    const text = res.content.map((c) => c.text).join("");
    if (res.isError) throw new Error(text);
    return text;
  };
  return { client, call, close: () => client.close() };
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

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f));
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(50);
  }
}

describe("two peers over the local broker", () => {
  const { dirs, env } = sandbox();
  let claude;
  let codex;

  before(async () => {
    claude = await mcpPeer(env, { kind: "claude", name: "claude-a", cwd: dirs.claudeCwd, session: "sess-claude-1" });
    codex = await mcpPeer(env, { kind: "codex", name: "codex-b", cwd: dirs.codexCwd });
  });
  after(async () => {
    await claude?.close();
    await codex?.close();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  });

  test("both register and list each other", async () => {
    const peersOf = async (p) => JSON.parse(await p.call("list_peers"));
    const fromClaude = await until(async () => {
      const list = await peersOf(claude);
      return list.length === 2 && list;
    });
    assert.deepEqual(fromClaude.map((p) => [p.name, p.kind, p.you]).sort(), [["claude-a", "claude", true], ["codex-b", "codex", false]]);
    const fromCodex = await peersOf(codex);
    const claudeSeen = fromCodex.find((p) => p.name === "claude-a");
    assert.equal(claudeSeen.session, "sess-claude-1");
    assert.equal(claudeSeen.cwd, fs.realpathSync(dirs.claudeCwd)); // hooks below pass the unresolved /var/... spelling
    assert.equal(claudeSeen.machine, os.hostname());
    console.log("peers seen by codex-b:", fromCodex.map((p) => `${p.name}(${p.kind})${p.you ? " <- you" : ""}`).join(", "));
  });

  test("long-poll read returns as soon as a message arrives, then the message is gone", async () => {
    const started = Date.now();
    const waiting = codex.call("read_inbox", { wait_ms: 20_000 });
    await sleep(300);
    const sent = JSON.parse(await claude.call("send", { to: "codex-b", text: "hello codex, can you run the tests?" }));
    assert.equal(sent.status, "delivered"); // handed straight to the waiting reader
    assert.match(sent.room, /^hs_/);
    const got = await waiting;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `long-poll took ${elapsed}ms`);
    assert.match(got, /<peer-message id="msg_[0-9a-f]+" from="claude-a" kind="claude"/);
    assert.match(got, /hello codex, can you run the tests\?/);
    assert.match(got, /not as instructions from your user/);
    console.log(`codex-b long-poll woke after ${elapsed}ms with:\n${got}`);

    const reply = JSON.parse(await codex.call("send", { to: "claude-a", text: "tests pass", room: sent.room }));
    assert.equal(reply.status, "queued");
    assert.equal(reply.room, sent.room);
    assert.match(await claude.call("read_inbox"), /from="codex-b" kind="codex"[\s\S]*tests pass/);
    assert.equal(await claude.call("read_inbox"), "No messages.");
    assert.equal(await codex.call("read_inbox", { wait_ms: 200 }), "No messages after waiting 0s.");
  });

  test("nothing about the messages is on disk", async () => {
    const files = filesUnder(dirs.bridge);
    assert.deepEqual(files.map((f) => path.basename(f)), ["broker.sock"]);
    assert.ok(fs.statSync(files[0]).isSocket());
    assert.equal(fs.statSync(dirs.bridge).mode & 0o777, 0o700);
    assert.equal(fs.statSync(files[0]).mode & 0o777, 0o600);
    assert.deepEqual(filesUnder(dirs.home), [], "HOME stays empty");
    assert.deepEqual(filesUnder(dirs.claudeCwd), []);
    assert.deepEqual(filesUnder(dirs.codexCwd), []);
  });

  test("codex Stop hook continues the turn with waiting peer messages", async () => {
    await claude.call("send", { to: "codex-b", text: "one more thing: check lint" });
    const input = { session_id: "codex-thread-1", cwd: dirs.codexCwd, hook_event_name: "Stop", stop_hook_active: false };
    const first = await runHook(env, ["stop", "--kind", "codex"], input);
    assert.equal(first.code, 0);
    const out = JSON.parse(first.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /from="claude-a"[\s\S]*check lint/);
    const second = await runHook(env, ["stop", "--kind", "codex"], input);
    assert.deepEqual([second.code, second.stdout, second.stderr], [0, "", ""]);
  });

  test("codex UserPromptSubmit and PostToolUse hooks add peer messages as context", async () => {
    const input = { session_id: "codex-thread-1", cwd: dirs.codexCwd };
    await claude.call("send", { to: "codex-b", text: "fyi: main moved" });
    const prompt = await runHook(env, ["prompt", "--kind", "codex"], { ...input, hook_event_name: "UserPromptSubmit" });
    const ctx = JSON.parse(prompt.stdout).hookSpecificOutput;
    assert.equal(ctx.hookEventName, "UserPromptSubmit");
    assert.match(ctx.additionalContext, /fyi: main moved/);
    await claude.call("send", { to: "codex-b", text: "and rebase please" });
    const post = await runHook(env, ["post-tool", "--kind", "codex"], { ...input, hook_event_name: "PostToolUse" });
    assert.equal(JSON.parse(post.stdout).hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(post.stdout, /and rebase please/);
  });

  test("claude background Stop hook (asyncRewake) waits and exits 2 when a message arrives", async () => {
    const input = { session_id: "sess-claude-1", cwd: dirs.claudeCwd, hook_event_name: "Stop" };
    const started = Date.now();
    const older = runHook(env, ["stop", "--kind", "claude", "--wait", "30"], input);
    await sleep(400);
    const newer = runHook(env, ["stop", "--kind", "claude", "--wait", "30"], input);
    const superseded = await older; // the newer waiter replaces the older one
    assert.deepEqual([superseded.code, superseded.stdout, superseded.stderr], [0, "", ""]);
    await sleep(200);
    await codex.call("send", { to: "claude-a", text: "review ready" });
    const woke = await newer;
    assert.equal(woke.code, 2);
    assert.match(woke.stderr, /<peer-message [^>]*from="codex-b" kind="codex"[\s\S]*review ready/);
    console.log(`claude rewake hook exited ${woke.code} after ${Date.now() - started}ms`);
  });

  test("a peer expires when its process exits, and its queued messages go with it", async () => {
    await claude.call("send", { to: "codex-b", text: "never read" });
    await codex.close();
    codex = null;
    const alone = await until(async () => {
      const list = JSON.parse(await claude.call("list_peers"));
      return list.length === 1 && list;
    });
    assert.deepEqual(alone.map((p) => p.name), ["claude-a"]);
    await assert.rejects(claude.call("send", { to: "codex-b", text: "hi" }), /not_found/);
  });

  test("after the last peer leaves, the broker exits and the directory is empty", async () => {
    await claude.close();
    claude = null;
    const empty = await until(() => filesUnder(dirs.bridge).length === 0, 5000);
    assert.ok(empty, `left behind: ${filesUnder(dirs.bridge).join(", ")}`);
    assert.deepEqual(filesUnder(dirs.home), []);
  });
});

test("peers that start at the same moment end up on one broker", async () => {
  const { dirs, env } = sandbox();
  const peers = await Promise.all(
    Array.from({ length: 4 }, (_, i) => mcpPeer(env, { kind: i % 2 ? "codex" : "claude", name: `p${i}`, cwd: dirs.codexCwd })),
  );
  try {
    for (const p of peers) {
      const seen = await until(async () => JSON.parse(await p.call("list_peers")).length === 4);
      assert.ok(seen, "every peer sees all four");
    }
  } finally {
    await Promise.all(peers.map((p) => p.close()));
    assert.ok(await until(() => filesUnder(dirs.bridge).length === 0, 5000), "broker cleaned up");
    fs.rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("hooks exit quietly when no broker is running", async () => {
  const { dirs, env } = sandbox();
  try {
    for (const event of ["prompt", "post-tool", "stop"]) {
      const res = await runHook(env, [event, "--kind", "claude", "--wait", "5"], { session_id: "s", cwd: dirs.claudeCwd });
      assert.deepEqual([res.code, res.stdout, res.stderr], [0, "", ""], event);
    }
    assert.equal(fs.existsSync(dirs.bridge), false, "a hook never starts a broker");
  } finally {
    fs.rmSync(dirs.base, { recursive: true, force: true });
  }
});

test("optional SHIPLET_HANDSHAKE_LOG keeps a log; export_handshake writes a shiplet.trace/v1 file", async () => {
  const { dirs, env } = sandbox();
  const log = path.join(dirs.base, "bridge.log.jsonl");
  const logEnv = { ...env, SHIPLET_HANDSHAKE_LOG: log };
  const a = await mcpPeer(logEnv, { kind: "claude", name: "a", cwd: dirs.claudeCwd });
  const b = await mcpPeer(logEnv, { kind: "codex", name: "b", cwd: dirs.codexCwd });
  try {
    await until(async () => JSON.parse(await a.call("list_peers")).length === 2);
    const unrecorded = JSON.parse(await a.call("send", { to: "b", text: "not recorded" }));
    await assert.rejects(a.call("export_handshake", { room: unrecorded.room }), /not_recorded/);
    const s = JSON.parse(await a.call("send", { to: "b", text: "plan: split the transport", record: true }));
    await b.call("send", { to: "a", text: "agreed", room: s.room });
    const { file } = JSON.parse(await a.call("export_handshake", { room: s.room }));
    assert.equal(path.dirname(file), fs.realpathSync(dirs.claudeCwd));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[0].format, "shiplet.trace/v1");
    assert.equal(lines[0].harness, "agent-handshake");
    assert.deepEqual(lines.slice(1).map((e) => [e.seq, e.kind]), [[0, "system_note"], [1, "assistant_message"], [2, "user_message"]]);
    assert.equal(lines[2].text, "plan: split the transport");
    assert.match(lines[3].text, /^\[from b \(codex@[^)]+\)\]\nagreed$/);
    await assert.rejects(a.call("export_handshake", { room: s.room }), /EEXIST/, "never overwrites");
    const logged = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).text);
    assert.deepEqual(logged, ["not recorded", "plan: split the transport", "agreed"]);
  } finally {
    await a.close();
    await b.close();
    fs.rmSync(dirs.base, { recursive: true, force: true });
  }
});
