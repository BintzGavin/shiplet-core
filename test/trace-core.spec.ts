import { describe, expect, it } from "vitest";
import claudeMain from "./fixtures/traces/claude-code-main.jsonl?raw";
import claudeSub from "./fixtures/traces/claude-code-main/subagents/agent-a1.jsonl?raw";
import codexRollout from "./fixtures/traces/codex-rollout.jsonl?raw";
import {
  TRACE_LIMITS,
  buildContext,
  isCheckCommand,
  detectFormat,
  dropAttachments,
  finalizeTrace,
  maskAttachments,
  maskEvents,
  maskSecrets,
  normalize,
  parseJsonl,
  prepareTraceUpload,
  segmentEvents,
  sha256Hex,
  truncateEvents,
  validateUpload,
  type TraceEvent,
} from "../src/cli/trace-core.mjs";

const claude = () => ({
  main: { fileName: "claude-code-main.jsonl", ...parseJsonl(claudeMain) },
  subagents: [{ fileName: "agent-a1.jsonl", ...parseJsonl(claudeSub) }],
});

describe("trace core: parsing and normalization", () => {
  it("skips a half-written last line and detects both formats", () => {
    const parsed = parseJsonl(claudeMain);
    expect(parsed.skippedLines).toBe(1);
    expect(detectFormat(parsed.records)).toBe("claude-code");
    expect(detectFormat(parseJsonl(codexRollout).records)).toBe("codex");
    expect(() => detectFormat([{ hello: "world" }])).toThrow("unrecognized session format");
  });

  it("normalizes a Claude Code session with a subagent file, inline sidechain, and image", async () => {
    const { main, subagents } = claude();
    const normalized = await normalize({ format: "claude-code", main, subagents });
    const kinds = normalized.events.map((event) => `${event.agent}:${event.kind}`);
    expect(normalized.cwd).toBe("/work/app");
    expect(normalized.harnessVersion).toBe("2.3.1");
    expect(normalized.models).toEqual(["model-a", "model-b"]);
    expect(normalized.skippedLines).toBe(1);
    // reminder-only and meta messages are dropped; reminders are stripped
    const prompts = normalized.events.filter((event) => event.kind === "user_message" && event.agent === "main");
    expect(prompts.map((event) => event.text)).toEqual(["Add pagination to orders."]);
    expect(prompts[0].attachmentIds).toHaveLength(1);
    expect(normalized.attachments[0].mediaType).toBe("image/png");
    expect(kinds).toContain("main:reasoning");
    expect(kinds).toContain("main:system_note");
    // subagent events sit between markers, ordered by time
    const start = kinds.indexOf("a1:subagent_start");
    const end = kinds.indexOf("a1:subagent_end");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(kinds.slice(start + 1, end).every((kind) => kind.startsWith("a1:") || kind.startsWith("inline1:"))).toBe(true);
    expect(normalized.events[start].text).toBe("Find the order tests");
    expect(kinds).toContain("inline1:subagent_start");
    // sequence numbers and ids are dense
    normalized.events.forEach((event, index) => {
      expect(event.seq).toBe(index);
      expect(event.id).toBe(`e${String(index).padStart(6, "0")}`);
    });
    const failing = normalized.events.find((event) => event.kind === "tool_result" && event.result?.callId === "t3");
    expect(failing?.result?.isError).toBe(true);
  });

  it("normalizes a Codex rollout with every tool-call record type", async () => {
    const normalized = await normalize({ format: "codex", main: parseJsonl(codexRollout) });
    expect(normalized.cwd).toBe("/work/app");
    expect(normalized.harnessVersion).toBe("0.150.0");
    expect(normalized.models).toEqual(["model-c"]);
    const summary = normalized.events.map((event) => event.kind);
    expect(summary.filter((kind) => kind === "user_message")).toHaveLength(1);
    expect(summary.filter((kind) => kind === "assistant_message")).toHaveLength(1);
    expect(summary).toContain("reasoning");
    const calls = normalized.events.filter((event) => event.kind === "tool_call");
    expect(calls.map((event) => [event.tool?.name, event.tool?.callId])).toEqual([
      ["shell", "c1"],
      ["apply_patch", "c2"],
      ["local_shell", "ls1"],
    ]);
    expect(calls[1].tool?.input).toEqual({ input: expect.stringContaining("Add File") });
    const results = normalized.events.filter((event) => event.kind === "tool_result");
    expect(results.map((event) => event.result?.isError)).toEqual([false, false, true]);
    expect(results[0].result?.text).toBe("ok");
  });
});

describe("trace core: secret masking", () => {
  const secrets: Array<[string, string]> = [
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"],
    ["shiplet-api-key", "shiplet_org_abcdefghijklmnop1234"],
    ["anthropic-key", "sk-ant-api03-abcdefghijklmnopqrstuv"],
    ["stripe-key", "sk_live_abcdefghijklmnop1234"],
    ["openai-style-key", "sk-proj-abcdefghijklmnopqrstuv"],
    ["github-token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["slack-token", "xoxb-1234567890-abcdef"],
    ["slack-webhook", "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop"],
    ["aws-access-key-id", "AKIAABCDEFGHIJKLMNOP"],
    ["google-api-key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
    ["npm-token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["jwt", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijk"],
    ["bearer", "Authorization: Bearer abcdefghijklmnop1234"],
    ["url-credentials", "https://user:hunter2pass@example.com/repo.git"],
    ["credential-assignment", 'api_key = "abc123def456"'],
  ];

  it.each(secrets)("masks %s", (kind, text) => {
    const result = maskSecrets(`before ${text} after`);
    expect(result.kinds[kind]).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain(`[secret:${kind}]`);
    expect(maskSecrets(result.text).count).toBe(0);
  });

  it("leaves non-secrets alone", () => {
    for (const text of [
      "commit 9c42566a65cbd31f92fc4a9319771561fe70a56d",
      "mail someone@example.com",
      "max_tokens: 32000",
      "token: 32000",
      "password: string",
      "secret: process.env.SECRET",
      'indexOf("[secret:", i + 1)',
    ]) {
      expect(maskSecrets(text)).toMatchObject({ count: 0, text });
    }
  });

  it("masks event strings but not structural fields, and is idempotent", async () => {
    const { main, subagents } = claude();
    const normalized = await normalize({ format: "claude-code", main, subagents });
    const masked = await maskEvents(normalized.events);
    expect(masked.kinds["credential-assignment"]).toBe(1);
    expect(JSON.stringify(masked.events)).not.toContain("abc123def456ghi");
    expect(masked.events.map((event) => event.id)).toEqual(normalized.events.map((event) => event.id));
    expect((await maskEvents(masked.events)).count).toBe(0);
  });

  it("masks text attachments and re-hashes and merges them", async () => {
    const plain = new TextEncoder().encode("token=abc123def456 in a log");
    const other = new TextEncoder().encode("token=zzz999yyy888 in a log");
    const sha = await sha256Hex(plain);
    const otherSha = await sha256Hex(other);
    const events: TraceEvent[] = [
      { id: "e000000", seq: 0, t: null, agent: "main", kind: "user_message", text: "see", attachmentIds: [sha, otherSha] },
    ];
    const result = await maskAttachments(
      [
        { sha256: sha, mediaType: "text/plain", bytes: plain.byteLength, data: plain },
        { sha256: otherSha, mediaType: "text/plain", bytes: other.byteLength, data: other },
      ],
      events,
    );
    expect(result.count).toBe(2);
    expect(result.attachments).toHaveLength(1);
    const merged = result.attachments[0];
    expect(new TextDecoder().decode(merged.data)).toBe("token=[secret:credential-assignment] in a log");
    expect(merged.sha256).toBe(await sha256Hex(merged.data));
    expect(result.events[0].attachmentIds).toEqual([merged.sha256]);
  });
});

describe("trace core: truncation, segments, and validation", () => {
  it("masks before truncating, so a cut cannot shorten a secret", async () => {
    const filler = "x".repeat(TRACE_LIMITS.truncateKeepBytes - 10);
    const text = `${filler}sk-ant-api03-abcdefghijklmnopqrstuvwxyz${"y".repeat(TRACE_LIMITS.textFieldBytes)}`;
    const masked = await maskEvents([{ id: "e000000", seq: 0, t: null, agent: "main", kind: "assistant_message", text }]);
    const [event] = truncateEvents(masked.events);
    expect(event.text).toContain("[truncated:");
    expect(event.text).not.toMatch(/sk-ant-api03/);
  });

  it("reduces an event with a huge tool input below the event limit", () => {
    const fields = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`f${index}`, "z".repeat(200 * 1024)]));
    const [event] = truncateEvents([
      { id: "e000000", seq: 0, t: null, agent: "main", kind: "tool_call", tool: { name: "Write", callId: "x", input: { file_path: "a.ts", ...fields } } },
    ]);
    expect(new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeLessThanOrEqual(TRACE_LIMITS.eventBytes);
    expect(event.tool?.input).toMatchObject({ truncated: true });
    expect(event.tool?.inputSummary).toBe("a.ts");
  });

  it("splits segments at the event limit and the byte limit", () => {
    const small = Array.from({ length: TRACE_LIMITS.segmentEvents + 5 }, (_, seq) => ({
      id: `e${String(seq).padStart(6, "0")}`,
      seq,
      t: null,
      agent: "main",
      kind: "assistant_message" as const,
      text: "hi",
    }));
    expect(segmentEvents(small).map((segment) => segment.events)).toEqual([TRACE_LIMITS.segmentEvents, 5]);
    const big = Array.from({ length: 6 }, (_, seq) => ({
      id: `e${String(seq).padStart(6, "0")}`,
      seq,
      t: null,
      agent: "main",
      kind: "assistant_message" as const,
      text: "b".repeat(200 * 1024),
    }));
    const segments = segmentEvents(big);
    expect(segments.length).toBe(2);
    expect(segments.every((segment) => segment.bytes <= TRACE_LIMITS.segmentBytes)).toBe(true);
  });

  it("builds a valid upload, and --no-attachments stays valid", async () => {
    const prepared = await prepareTraceUpload({ ...claude(), importer: "test" });
    expect(prepared.upload.title).toBe("Add pagination to orders.");
    expect(await validateUpload(prepared.upload)).toEqual({ ok: true });
    const stripped = await prepareTraceUpload({ ...claude(), importer: "test", noAttachments: true });
    expect(stripped.upload.attachments).toEqual([]);
    expect(stripped.upload.droppedAttachments).toBe(1);
    expect(await validateUpload(stripped.upload)).toEqual({ ok: true });
    expect(dropAttachments(prepared.upload.events).dropped).toBe(1);
  });

  it.each([
    ["schemaVersion", { schemaVersion: "v0" }],
    ["title", { title: "   " }],
    ["source.harness", { source: { harness: "other" } }],
    ["startedAt", { startedAt: "yesterday" }],
    ["models", { models: ["x".repeat(101)] }],
    ["skippedLines", { skippedLines: -1 }],
    ["clientMasking", { clientMasking: { count: 1 } }],
    ["surprise", { surprise: true }],
  ])("rejects a bad %s", async (path, override) => {
    const prepared = await prepareTraceUpload({ ...claude(), importer: "test" });
    const result = await validateUpload({ ...prepared.upload, ...override });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((error) => error.path)).toContain(path);
  });

  it("rejects broken events and attachments", async () => {
    const prepared = await prepareTraceUpload({ ...claude(), importer: "test" });
    const { upload } = prepared;
    const cases: Array<[string, unknown]> = [
      ["events[1].seq", { ...upload, events: upload.events.map((event, index) => (index === 1 ? { ...event, seq: 9 } : event)) }],
      ["events[0].kind", { ...upload, events: upload.events.map((event, index) => (index === 0 ? { ...event, kind: "nope" } : event)) }],
      ["attachments[0].sha256", { ...upload, attachments: upload.attachments.map((attachment) => ({ ...attachment, sha256: "0".repeat(64) })) }],
      ["attachments[0].mediaType", { ...upload, attachments: upload.attachments.map((attachment) => ({ ...attachment, mediaType: "text/html" })) }],
      ["attachments[1].sha256", { ...upload, attachments: [...upload.attachments, ...upload.attachments] }],
    ];
    for (const [path, candidate] of cases) {
      const result = await validateUpload(candidate);
      expect(result.ok, path).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.path)).toContain(path);
    }
  });
});

describe("trace core: manifest and context", () => {
  it("counts only commands that run a test, lint, typecheck, or build tool as checks", () => {
    for (const command of [
      "npm test",
      "npm run typecheck",
      "cd app && NODE_ENV=test timeout 900 npx vitest run test/a.spec.ts",
      "pytest -q",
      "python -m pytest",
      "node --test scripts/a.test.mjs",
      "cargo test",
      "go test ./...",
      "make check",
    ]) {
      expect(isCheckCommand(command), command).toBe(true);
    }
    for (const command of ["cat scripts/check-pack.mjs", "grep -n test src", "python3 - <<'EOF'", "ls test", "git checkout main"]) {
      expect(isCheckCommand(command), command).toBe(false);
    }
  });

  it("computes the summary on finalize", async () => {
    const prepared = await prepareTraceUpload({ ...claude(), importer: "test" });
    const { manifest, segments } = await finalizeTrace({
      events: prepared.upload.events,
      cwd: prepared.upload.cwd,
      title: prepared.upload.title,
      source: { harness: "claude-code", harnessVersion: "2.3.1", importer: "test" },
      startedAt: prepared.upload.startedAt,
      endedAt: prepared.upload.endedAt,
      models: prepared.upload.models,
    });
    expect(manifest.summary.filesTouched).toEqual(["src/orders.ts"]);
    expect(manifest.summary.checks).toEqual([
      { command: "npm test -- --token=[secret:credential-assignment]", ok: false },
      { command: "npm test", ok: true },
    ]);
    expect(manifest.summary.outcome).toBe("last-check-passed");
    expect(manifest.summary.promptCount).toBe(1);
    expect(manifest.agents.map((agent) => agent.id)).toEqual(expect.arrayContaining(["a1", "inline1"]));
    expect(manifest.segments).toHaveLength(segments.length);
    expect(manifest.segments[0].sha256).toBe(await sha256Hex(segments[0].ndjson));
  });

  it("builds a context handoff that keeps the summary under a tiny budget", async () => {
    const prepared = await prepareTraceUpload({ ...claude(), importer: "test" });
    const { manifest, events } = await finalizeTrace({
      events: prepared.upload.events,
      cwd: prepared.upload.cwd,
      title: prepared.upload.title,
      source: { harness: "claude-code", harnessVersion: null, importer: null },
      models: prepared.upload.models,
    });
    const full = buildContext(manifest, events);
    expect(full).toContain("A trace is the full log of an agent session");
    expect(full).toContain("**User:** Add pagination to orders.");
    expect(full).toContain("→ Bash: npm test");
    expect(full).toContain("← error: Exit code 1");
    expect(full).toContain('[Subagent "Find the order tests"');
    const tiny = buildContext(manifest, events, { maxTokens: 10 });
    expect(tiny).toContain("## Summary");
    expect(tiny).not.toContain("← error:");
    expect(tiny).not.toContain("→ Read:");
  });
});
