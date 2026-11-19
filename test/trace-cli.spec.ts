// @vitest-environment node
import { mkdtemp, mkdir, copyFile, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import claudeMainText from "./fixtures/traces/claude-code-main.jsonl?raw";
import claudeSubText from "./fixtures/traces/claude-code-main/subagents/agent-a1.jsonl?raw";
import codexText from "./fixtures/traces/codex-rollout.jsonl?raw";
import openText from "./fixtures/traces/open-format.jsonl?raw";

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
  await writeFile(path.join(fixtures, "acme-session.jsonl"), openText);
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

  it("creates a trace-only Shiplet with --new, then uploads to it", async () => {
    const server = stubServer([
      (call) =>
        call.method === "POST" && call.url.endsWith("/api/trace-shiplets")
          ? Response.json({ shiplet: { id: "project_new1", name: "Codex fix", traceOnly: true } }, { status: 201 })
          : undefined,
      (call) =>
        call.method === "POST" && call.url.endsWith("/api/shiplets/project_new1/traces")
          ? Response.json({ trace: { id: "trc_9", projectId: "project_new1", sharing: "private" }, serverMasked: { count: 0, kinds: {} } }, { status: 201 })
          : undefined,
    ]);
    const result = await run(
      ["trace", "share", path.join(fixtures, "codex-rollout.jsonl"), "--new", "--title", "Codex fix", "--organization", "org_1", "--api-url", "https://shiplet.test"],
      { fetch: server.fetch, env: { SHIPLET_API_KEY: "shiplet_org_testkeyvalue1234567890" } },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(server.calls.map((call) => call.url)).toEqual([
      "https://shiplet.test/api/trace-shiplets",
      "https://shiplet.test/api/shiplets/project_new1/traces",
    ]);
    expect(JSON.parse(server.calls[0].body || "{}")).toEqual({ name: "Codex fix", organizationId: "org_1" });
    expect(result.stdout).toContain("Created Shiplet: Codex fix (project_new1)");
    expect(result.stdout).toContain("https://shiplet.test/shiplets/project_new1/traces/trc_9");

    const dry = await run(["trace", "share", path.join(fixtures, "codex-rollout.jsonl"), "--new", "--dry-run"]);
    expect(dry.stdout).toContain("a new Shiplet would be created");
    const conflict = await run(["trace", "share", path.join(fixtures, "codex-rollout.jsonl"), "--new", "--shiplet", "p"]);
    expect(conflict.stderr).toContain("--new works with trace share alone");
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

  it("uploads with an MCP upload link without signing in", async () => {
    const token = `shiplet_trace_upload_${"ab".repeat(32)}`;
    const server = stubServer([
      (call) =>
        call.method === "POST" && call.url === `https://shiplet.test/api/trace-uploads/${token}`
          ? Response.json({ trace: { id: "trc_link", projectId: "proj_9" }, serverMasked: { count: 0, kinds: {} }, pendingAttachments: [] }, { status: 201 })
          : undefined,
    ]);
    const result = await run(["trace", "share", path.join(fixtures, "codex-rollout.jsonl"), "--upload-url", `https://shiplet.test/api/trace-uploads/${token}`], {
      fetch: server.fetch,
      sessionBootstrap: async () => {
        throw new Error("must not sign in");
      },
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(server.calls[0].authorization).toBeNull();
    expect(result.stdout).toContain("https://shiplet.test/shiplets/proj_9/traces/trc_link");
    expect((await run(["trace", "share", path.join(fixtures, "codex-rollout.jsonl"), "--upload-url", "http://evil.test/x"])).stderr).toContain("https Shiplet trace upload link");
  });

  it("dry-runs an open-format session from any agent", async () => {
    const result = await run(["trace", "share", path.join(fixtures, "acme-session.jsonl"), "--shiplet", "proj_1", "--dry-run", "--json"], {
      fetch: () => {
        throw new Error("network used");
      },
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      format: "shiplet",
      harness: "acme-agent",
      title: "Fix the checkout total",
      events: 16,
      masked: { count: 1, kinds: { "github-token": 1 } },
    });
    const text = await run(["trace", "share", path.join(fixtures, "acme-session.jsonl"), "--shiplet", "proj_1", "--dry-run"]);
    expect(text.stdout).toContain("Format:      shiplet.trace/v1 from Acme Agent 1.4.0");
  });

  it("explains exactly what is wrong with an invalid open-format file", async () => {
    const dir = await tempDir();
    const broken = path.join(dir, "broken.jsonl");
    const lines = openText.trim().split("\n");
    lines[3] = lines[3].replace('"input":{"path":"src/checkout.ts"}', '"input":"src/checkout.ts"');
    await writeFile(broken, lines.join("\n"));
    const result = await run(["trace", "share", broken, "--shiplet", "p", "--dry-run"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${broken} is not a valid shiplet.trace/v1 file: line 4, tool.input: must be an object`);
    const unknown = path.join(dir, "unknown.jsonl");
    await writeFile(unknown, `${JSON.stringify({ hello: "world" })}\n`);
    expect((await run(["trace", "share", unknown, "--shiplet", "p", "--dry-run"])).stderr).toContain("is not a Claude Code, Codex, or shiplet.trace/v1 session file");
  });

  it("--current reads SHIPLET_TRACE_FILE first, accepts only a regular .jsonl file, and never uploads its path", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "private-folder-name", "session.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, openText);
    const found = await cli.findCurrentSession({ HOME: dir, SHIPLET_TRACE_FILE: file, CLAUDE_CODE_SESSION_ID: "sess-12345678" }, "/work/shop");
    expect(found).toMatchObject({ main: file, subagents: [], how: "SHIPLET_TRACE_FILE" });
    const relative = await cli.findCurrentSession({ HOME: dir, SHIPLET_TRACE_FILE: "private-folder-name/session.jsonl" }, dir);
    expect(relative.main).toBe(file);

    const link = path.join(dir, "link.jsonl");
    await symlink(file, link);
    await expect(cli.findCurrentSession({ HOME: dir, SHIPLET_TRACE_FILE: link }, dir)).rejects.toThrow("SHIPLET_TRACE_FILE must name a regular .jsonl file");
    await expect(cli.findCurrentSession({ HOME: dir, SHIPLET_TRACE_FILE: path.dirname(file) }, dir)).rejects.toThrow("SHIPLET_TRACE_FILE must name a regular .jsonl file");
    await expect(cli.findCurrentSession({ HOME: dir, SHIPLET_TRACE_FILE: path.join(dir, "missing.jsonl") }, dir)).rejects.toThrow("SHIPLET_TRACE_FILE must name a regular .jsonl file");
    await writeFile(path.join(dir, "session.txt"), openText);
    await expect(cli.findCurrentSession({ HOME: dir, SHIPLET_TRACE_FILE: path.join(dir, "session.txt") }, dir)).rejects.toThrow("SHIPLET_TRACE_FILE must name a regular .jsonl file");

    const token = `shiplet_trace_upload_${"cd".repeat(32)}`;
    const server = stubServer([
      (call) =>
        call.method === "POST" && call.url === `https://shiplet.test/api/trace-uploads/${token}`
          ? Response.json({ trace: { id: "trc_acme", projectId: "proj_9", harness: "acme-agent" }, serverMasked: { count: 0, kinds: {} }, pendingAttachments: [] }, { status: 201 })
          : undefined,
    ]);
    const result = await run(["trace", "share", "--current", "--upload-url", `https://shiplet.test/api/trace-uploads/${token}`], {
      fetch: server.fetch,
      env: { HOME: dir, SHIPLET_TRACE_FILE: file },
      cwd: dir,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(SHIPLET_TRACE_FILE)");
    const body = server.calls[0].body || "";
    expect(JSON.parse(body).source.harness).toBe("acme-agent");
    expect(body).not.toContain("private-folder-name");
    expect(body).not.toContain(dir);
  });

  it("attaches files an open-format event names, only from inside the session folder", async () => {
    const work = await tempDir();
    await mkdir(path.join(work, "shots"), { recursive: true });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
    await writeFile(path.join(work, "shots/home.png"), png);
    const records = openText.trim().split("\n").map((line) => JSON.parse(line));
    records[0].cwd = work;
    records[16] = { ...records[16], files: ["shots/home.png"] };
    const session = path.join(work, "acme.jsonl");
    await writeFile(session, records.map((record) => JSON.stringify(record)).join("\n"));

    const dry = await run(["trace", "share", session, "--shiplet", "p", "--dry-run", "--json"]);
    expect(dry.stderr).toBe("");
    expect(JSON.parse(dry.stdout).producedFiles).toEqual([{ path: path.join("shots", "home.png"), mediaType: "image/png", bytes: png.byteLength }]);

    let uploaded: any;
    let putBytes: Uint8Array | null = null;
    const server = stubServer([
      (call) => {
        if (call.method === "POST" && call.url.endsWith("/traces")) {
          uploaded = JSON.parse(call.body!);
          return Response.json({ trace: { id: "trc_3" }, serverMasked: { count: 0, kinds: {} }, pendingAttachments: uploaded.attachments.map((a: any) => a.sha256) }, { status: 201 });
        }
        if (call.method === "PUT" && call.url.includes("/attachments/")) {
          putBytes = call.body as unknown as Uint8Array;
          return new Response(null, { status: 204 });
        }
        return undefined;
      },
    ]);
    const result = await run(["trace", "share", session, "--shiplet", "proj_1", "--api-url", "https://shiplet.test"], {
      fetch: server.fetch,
      env: { SHIPLET_API_KEY: "shiplet_org_testkeyvalue1234567890" },
    });
    expect(result.stderr).toBe("");
    expect(uploaded.attachments).toEqual([expect.objectContaining({ mediaType: "image/png", deferred: true, source: "file", name: path.join("shots", "home.png") })]);
    expect(uploaded.events[15].attachmentIds).toEqual([uploaded.attachments[0].sha256]);
    expect(putBytes && Buffer.from(putBytes).equals(Buffer.from(png))).toBe(true);

    const noFiles = await run(["trace", "share", session, "--shiplet", "p", "--dry-run", "--json", "--no-files"]);
    expect(JSON.parse(noFiles.stdout)).toMatchObject({ producedFiles: [], skippedFiles: [{ path: "shots/home.png", reason: "--no-files" }] });

    // A named file must exist, and a symlink cannot lead outside the folder.
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.png"), png);
    await symlink(path.join(outside, "secret.png"), path.join(work, "shots/escape.png"));
    for (const [name, message] of [
      ["shots/missing.png", "line 17, files: shots/missing.png was not found"],
      ["shots/escape.png", "line 17, files: shots/escape.png resolves outside cwd"],
    ]) {
      records[16] = { ...records[16], files: [name] };
      await writeFile(session, records.map((record) => JSON.stringify(record)).join("\n"));
      const refused = await run(["trace", "share", session, "--shiplet", "p", "--dry-run"]);
      expect(refused.code, name).toBe(1);
      expect(refused.stderr, name).toContain(message);
    }
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
