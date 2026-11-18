// @vitest-environment node
import { mkdtemp, mkdir, copyFile, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import claudeMainText from "./fixtures/traces/claude-code-main.jsonl?raw";
import claudeSubText from "./fixtures/traces/claude-code-main/subagents/agent-a1.jsonl?raw";
import codexText from "./fixtures/traces/codex-rollout.jsonl?raw";

const require = createRequire(import.meta.url);
const cli = require("../src/cli/shiplet.cjs") as {
  runCli: (input: Record<string, unknown>) => Promise<number>;
  findCurrentSession: (env: Record<string, string>, cwd: string) => Promise<{ main: string; subagents: string[]; how: string }>;
};

const cleanup: string[] = [];
let fixtures = "";
// The Workers test runtime cannot read repository files, so the fixtures are
// imported as text and written to a temporary folder.
beforeAll(async () => {
  fixtures = await mkdtemp(path.join(tmpdir(), "shiplet-trace-fixtures-"));
  await mkdir(path.join(fixtures, "claude-code-main/subagents"), { recursive: true });
  await writeFile(path.join(fixtures, "claude-code-main.jsonl"), claudeMainText);
  await writeFile(path.join(fixtures, "claude-code-main/subagents/agent-a1.jsonl"), claudeSubText);
  await writeFile(path.join(fixtures, "codex-rollout.jsonl"), codexText);
});
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "shiplet-trace-cli-"));
  cleanup.push(dir);
  return dir;
}

function output() {
  let text = "";
  return { stream: { write: (chunk: string) => ((text += chunk), true) }, read: () => text };
}

type Call = { method: string; url: string; body?: string; authorization?: string | null };

function stubServer(handlers: Array<(call: Call) => Response | undefined>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const call: Call = { method: init.method || "GET", url, body: init.body as string | undefined, authorization: headers.get("authorization") };
    calls.push(call);
    for (const handler of handlers) {
      const response = handler(call);
      if (response) return response;
    }
    return Response.json({ error: "not_found", message: "no stub" }, { status: 404 });
  };
  return { fetch, calls };
}

async function run(argv: string[], extra: Record<string, unknown> = {}) {
  const stdout = output();
  const stderr = output();
  const code = await cli.runCli({ argv, stdout: stdout.stream, stderr: stderr.stream, env: {}, cwd: process.cwd(), ...extra });
  return { code, stdout: stdout.read(), stderr: stderr.read() };
}

describe("shiplet trace (CLI)", () => {
  it("dry-runs a session folder with masked counts, without any network", async () => {
    const result = await run(["trace", "share", path.join(fixtures, "claude-code-main"), "--shiplet", "proj_1", "--dry-run", "--json"], {
      fetch: () => {
        throw new Error("network used");
      },
    });
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ dryRun: true, format: "claude-code", title: "Add pagination to orders.", attachments: 1, masked: { count: 1 } });
    expect(body.files).toHaveLength(2);
  });

  it("--no-attachments leaves images out", async () => {
    const result = await run(["trace", "share", path.join(fixtures, "claude-code-main.jsonl"), "--shiplet", "p", "--no-attachments", "--dry-run", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ attachments: 0 });
  });

  it("explains what a trace is and requires --shiplet", async () => {
    const missing = await run(["trace", "nope"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("A trace is the full log of an agent session");
    expect(missing.stderr).toContain("Usage: shiplet trace");
    expect((await run(["trace", "list"])).stderr).toContain("Missing --shiplet");
    expect((await run(["trace", "list", "--shiplet", "p", "--as", "context"])).stderr).toContain("apply to trace pull only");
    expect((await run(["--help"])).stdout).toContain("A trace is the full log of an agent session");
  });

  it("finds the current session: Claude Code by session ID, then Codex, then newest Claude Code", async () => {
    const home = await tempDir();
    const cwd = "/work/app";
    const claudeProject = path.join(home, ".claude/projects/-work-app");
    await mkdir(path.join(claudeProject, "sess-12345678/subagents"), { recursive: true });
    await copyFile(path.join(fixtures, "claude-code-main.jsonl"), path.join(claudeProject, "sess-12345678.jsonl"));
    await copyFile(path.join(fixtures, "claude-code-main/subagents/agent-a1.jsonl"), path.join(claudeProject, "sess-12345678/subagents/agent-a1.jsonl"));
    const found = await cli.findCurrentSession({ HOME: home, CLAUDE_CODE_SESSION_ID: "sess-12345678" }, cwd);
    expect(found.main).toBe(path.join(claudeProject, "sess-12345678.jsonl"));
    expect(found.subagents).toHaveLength(1);
    await expect(cli.findCurrentSession({ HOME: home, CLAUDE_CODE_SESSION_ID: "sess-missing1" }, cwd)).rejects.toThrow("No Claude Code session file");

    const now = new Date();
    const day = path.join(home, ".codex/sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
    await mkdir(day, { recursive: true });
    await copyFile(path.join(fixtures, "codex-rollout.jsonl"), path.join(day, "rollout-a.jsonl"));
    await writeFile(path.join(day, "rollout-other.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: "/elsewhere" } })}\n`);
    const codex = await cli.findCurrentSession({ HOME: home }, cwd);
    expect(codex.main).toBe(path.join(day, "rollout-a.jsonl"));
    expect(codex.how).toContain("Codex");

    const codexHome = await tempDir();
    const newer = path.join(claudeProject, "newer.jsonl");
    await copyFile(path.join(fixtures, "claude-code-main.jsonl"), newer);
    await utimes(newer, now, new Date(now.getTime() + 60_000));
    const claude = await cli.findCurrentSession({ HOME: home, CODEX_HOME: codexHome }, cwd);
    expect(claude.main).toBe(newer);
    await expect(cli.findCurrentSession({ HOME: await tempDir() }, cwd)).rejects.toThrow("No session found");
  });

  it("uploads once with an API key and retries a 5xx with the identical body", async () => {
    let attempts = 0;
    const server = stubServer([
      (call) => {
        if (call.method !== "POST") return undefined;
        attempts++;
        if (attempts === 1) return new Response("overloaded", { status: 503 });
        return Response.json(
          { trace: { id: "trc_1", sharing: "private" }, serverMasked: { count: 0, kinds: {} } },
          { status: 201 },
        );
      },
    ]);
    const result = await run(
      ["trace", "share", path.join(fixtures, "codex-rollout.jsonl"), "--shiplet", "proj_1", "--json", "--api-url", "https://shiplet.test"],
      { fetch: server.fetch, env: { SHIPLET_API_KEY: "shiplet_org_testkeyvalue1234567890" } },
    );
    expect(result.code).toBe(0);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0].body).toBe(server.calls[1].body);
    expect(server.calls[0].url).toBe("https://shiplet.test/api/shiplets/proj_1/traces");
    expect(server.calls[0].authorization).toBe("Bearer shiplet_org_testkeyvalue1234567890");
    expect(JSON.parse(result.stdout)).toMatchObject({ trace: { id: "trc_1" }, link: "https://shiplet.test/shiplets/proj_1/traces/trc_1" });
  });

  it("re-approves a session once when the cached one lacks trace scopes", async () => {
    let bootstraps = 0;
    let revoked = 0;
    const makeSessionFetch = (generation: number) => {
      const sessionFetch = async (url: string) => {
        if (generation === 1) return Response.json({ error: "cli_session_reauth_required", message: "sign in" }, { status: 401 });
        expect(url).toContain("/traces");
        return Response.json({ traces: [{ id: "trc_9", harness: "codex", eventCount: 3, sharing: "private", title: "t" }], nextCursor: null });
      };
      return Object.assign(sessionFetch, { revoke: async () => void revoked++ });
    };
    const result = await run(["trace", "list", "--shiplet", "proj_1", "--api-url", "https://shiplet.test"], {
      sessionBootstrap: async () => makeSessionFetch(++bootstraps),
    });
    expect(result.code).toBe(0);
    expect(bootstraps).toBe(2);
    expect(result.stdout).toContain("trc_9");
  });

  it("pulls a trace with one session and writes the files and context", async () => {
    const manifest = {
      schemaVersion: "shiplet.trace/v1",
      title: "Pulled",
      source: { harness: "codex", harnessVersion: null, importer: null },
      models: [],
      agents: [],
      summary: { durationSeconds: 60, filesTouched: ["src/a.ts"], checks: [], outcome: "no-checks-run", errorCount: 0 },
      segments: [{ index: 0 }, { index: 1 }],
      attachments: [{ sha256: "a".repeat(64), mediaType: "image/png", bytes: 3, source: "inline" }],
    };
    const event = (seq: number, text: string) => ({ id: `e${String(seq).padStart(6, "0")}`, seq, t: null, agent: "main", kind: "user_message", text });
    const server = stubServer([
      (call) => (call.url.endsWith("/traces/trc_1") ? Response.json({ trace: { id: "trc_1" }, manifest }) : undefined),
      (call) => (call.url.endsWith("/segments/0") ? Response.json({ index: 0, events: [event(0, "first prompt")] }) : undefined),
      (call) => (call.url.endsWith("/segments/1") ? Response.json({ index: 1, events: [event(1, "second prompt")] }) : undefined),
      (call) => (call.url.includes("/attachments/") ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }) : undefined),
    ]);
    let bootstraps = 0;
    const sessionBootstrap = async () => {
      bootstraps++;
      return Object.assign((url: string, init: RequestInit) => server.fetch(url, init), { revoke: async () => undefined });
    };
    const cwd = await tempDir();
    const pulled = await run(["trace", "pull", "trc_1", "--shiplet", "proj_1", "out", "--api-url", "https://shiplet.test"], { sessionBootstrap, cwd });
    expect(pulled.code).toBe(0);
    expect(bootstraps).toBe(1);
    const saved = JSON.parse(await readFile(path.join(cwd, "out/trace.json"), "utf8"));
    expect(saved.events).toHaveLength(2);
    expect((await readFile(path.join(cwd, "out/attachments", "a".repeat(64)))).byteLength).toBe(3);
    expect(await readFile(path.join(cwd, "out/context.md"), "utf8")).toContain("**User:** second prompt");

    const context = await run(["trace", "pull", "trc_1", "--shiplet", "proj_1", "--as", "context", "--api-url", "https://shiplet.test"], { sessionBootstrap, cwd });
    expect(context.code).toBe(0);
    expect(context.stdout).toContain("# Pulled");
    expect(context.stdout).toContain("A trace is the full log of an agent session");
  });

  it("attaches a screenshot the session produced, uploads its bytes, and shares the trace", async () => {
    const work = await tempDir();
    await mkdir(path.join(work, "out"), { recursive: true });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    await writeFile(path.join(work, "out/shot.png"), png);
    await writeFile(path.join(work, "outside.png"), png.slice(0, 9));
    const now = new Date();
    const at = (offset: number) => new Date(now.getTime() + offset * 1000 - 60_000).toISOString();
    const rollout = [
      { timestamp: at(0), type: "session_meta", payload: { id: "c2", cwd: work } },
      { timestamp: at(1), type: "event_msg", payload: { type: "user_message", message: "Take a screenshot" } },
      { timestamp: at(2), type: "response_item", payload: { type: "function_call", name: "shell", call_id: "s1", arguments: JSON.stringify({ command: ["bash", "-lc", "playwright screenshot out/shot.png"] }) } },
      { timestamp: at(3), type: "response_item", payload: { type: "function_call_output", call_id: "s1", output: "Saved out/shot.png and ../elsewhere.png" } },
      { timestamp: at(120), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
    ];
    const session = path.join(work, "rollout.jsonl");
    await writeFile(session, rollout.map((record) => JSON.stringify(record)).join("\n"));
    const audiencesFile = path.join(work, "audiences.json");
    await writeFile(audiencesFile, JSON.stringify([{ targetType: "email", targetId: "alex@example.com", profile: { level: "full", rules: [{ op: "mask_terms", terms: ["secret project"] }] } }]));

    const dry = await run(["trace", "share", session, "--shiplet", "p", "--dry-run", "--json"]);
    expect(JSON.parse(dry.stdout).producedFiles).toEqual([{ path: path.join("out", "shot.png"), mediaType: "image/png", bytes: png.byteLength }]);

    let uploaded: any;
    let audiences: any;
    let putBytes: Uint8Array | null = null;
    const server = stubServer([
      (call) => {
        if (call.method === "POST" && call.url.endsWith("/traces")) {
          uploaded = JSON.parse(call.body!);
          const deferred = uploaded.attachments.filter((attachment: any) => attachment.deferred);
          return Response.json({ trace: { id: "trc_2" }, serverMasked: { count: 0, kinds: {} }, pendingAttachments: deferred.map((a: any) => a.sha256) }, { status: 201 });
        }
        return undefined;
      },
      (call) => {
        if (call.method === "PUT" && call.url.includes("/attachments/")) {
          putBytes = call.body as unknown as Uint8Array;
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
      (call) => {
        if (call.method === "PUT" && call.url.endsWith("/audiences")) {
          audiences = JSON.parse(call.body!);
          return Response.json({ sharing: "shared", audiences: audiences.audiences.map((audience: any) => ({ ...audience })) });
        }
        return undefined;
      },
    ]);
    const result = await run(
      ["trace", "share", session, "--shiplet", "proj_1", "--api-url", "https://shiplet.test", "--audience", "organization=conversation", "--audiences", audiencesFile],
      { fetch: server.fetch, env: { SHIPLET_API_KEY: "shiplet_org_testkeyvalue1234567890" } },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const deferred = uploaded.attachments.filter((attachment: any) => attachment.deferred);
    expect(deferred).toEqual([expect.objectContaining({ mediaType: "image/png", bytes: png.byteLength, source: "file", name: path.join("out", "shot.png") })]);
    expect(uploaded.events.some((event: any) => event.attachmentIds?.includes(deferred[0].sha256))).toBe(true);
    expect(putBytes && Buffer.from(putBytes).equals(Buffer.from(png))).toBe(true);
    expect(audiences.audiences).toEqual([
      { targetType: "organization", targetId: "organization", profile: { level: "conversation", rules: [] } },
      expect.objectContaining({ targetType: "email", targetId: "alex@example.com" }),
    ]);
    expect(result.stdout).toContain("Shared with: organization=conversation, email:alex@example.com=full");

    const noFiles = await run(["trace", "share", session, "--shiplet", "p", "--dry-run", "--json", "--no-files"]);
    expect(JSON.parse(noFiles.stdout).producedFiles).toEqual([]);
    expect((await run(["trace", "share", session, "--shiplet", "p", "--dry-run", "--audience", "team=full"])).stderr).toContain("needs an id");
  });

  it("changes sharing without dropping audiences, and previews a level", async () => {
    const calls: any[] = [];
    const server = stubServer([
      (call) => {
        calls.push(call);
        if (call.url.endsWith("/audiences")) return Response.json({ sharing: "private", audiences: [{ targetType: "team", targetId: "t1", profile: { level: "summary", rules: [] } }] });
        if (call.url.endsWith("/preview")) return Response.json({ events: [{ kind: "user_message" }, { kind: "omitted" }], manifest: { attachments: [], summary: { filesTouched: ["a.ts"] } } });
        return undefined;
      },
    ]);
    const env = { SHIPLET_API_KEY: "shiplet_org_testkeyvalue1234567890" };
    const privateResult = await run(["trace", "audiences", "trc_1", "--shiplet", "p", "--private", "--api-url", "https://shiplet.test"], { fetch: server.fetch, env });
    expect(privateResult.code).toBe(0);
    expect(JSON.parse(calls[0].body)).toEqual({ sharing: "private" });
    expect(privateResult.stdout).toContain("team:t1 = summary");
    const preview = await run(["trace", "preview", "trc_1", "--shiplet", "p", "--level", "conversation", "--api-url", "https://shiplet.test"], { fetch: server.fetch, env });
    expect(preview.code).toBe(0);
    expect(JSON.parse(calls[1].body)).toEqual({ profile: { level: "conversation", rules: [] } });
    expect(preview.stdout).toContain("user_message 1, omitted 1");
  });

  it("reports when traces are not enabled", async () => {
    const server = stubServer([() => Response.json({ error: "traces_not_enabled", message: "off" }, { status: 404 })]);
    const result = await run(["trace", "list", "--shiplet", "p", "--api-url", "https://shiplet.test"], {
      fetch: server.fetch,
      env: { SHIPLET_API_KEY: "shiplet_org_testkeyvalue1234567890" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Traces are not enabled on this server.");
  });
});
