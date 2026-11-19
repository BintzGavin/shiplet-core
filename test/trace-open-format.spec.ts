// The open trace format (docs/traces-spec.md D20): any agent can write a
// shiplet.trace/v1 JSONL file, and the shared core reads it strictly.
import { describe, expect, it } from "vitest";
import openTrace from "./fixtures/traces/open-format.jsonl?raw";
import {
  HARNESS_PATTERN,
  detectFormat,
  finalizeTrace,
  harnessLabel,
  maskEvents,
  normalize,
  parseJsonl,
  prepareTraceUpload,
  validateUpload,
} from "../src/cli/trace-core.mjs";

const lines = () => openTrace.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
const toText = (records: Array<Record<string, unknown>>) => records.map((record) => JSON.stringify(record)).join("\n");
const parsed = (text = openTrace) => ({ fileName: "acme.jsonl", ...parseJsonl(text) });

// Replace the record on a 1-based file line (line 1 is the header).
function withLine(line: number, change: (record: Record<string, any>) => Record<string, any> | null) {
  const records = lines();
  const next = change({ ...records[line - 1] });
  if (next === null) records.splice(line - 1, 1);
  else records[line - 1] = next;
  return toText(records);
}

async function normalizeText(text: string) {
  return normalize({ format: "shiplet", main: parsed(text) });
}

describe("open trace format: reading", () => {
  it("detects the header on the first line", () => {
    expect(detectFormat(parseJsonl(openTrace).records)).toBe("shiplet");
    const headerLater = toText([lines()[1], lines()[0]]);
    expect(() => detectFormat(parseJsonl(headerLater).records)).toThrow("must be the first line");
  });

  it("keeps file order, sequence numbers, inline subagents, and header metadata", async () => {
    const normalized = await normalizeText(openTrace);
    expect(normalized.harness).toBe("acme-agent");
    expect(normalized.harnessVersion).toBe("1.4.0");
    expect(normalized.title).toBe("Fix the checkout total");
    expect(normalized.cwd).toBe("/work/shop");
    expect(normalized.models).toEqual(["acme-large"]);
    expect(normalized.startedAt).toBe("2026-11-19T09:00:00Z");
    expect(normalized.endedAt).toBe("2026-11-19T09:00:33Z");
    expect(normalized.attachments).toEqual([]);
    expect(normalized.events).toHaveLength(16);
    normalized.events.forEach((event, index) => {
      expect(event.seq).toBe(index);
      expect(event.id).toBe(`e${String(index).padStart(6, "0")}`);
    });
    expect(normalized.events[0]).toEqual({
      id: "e000000",
      seq: 0,
      t: "2026-11-19T09:00:01Z",
      agent: "main",
      kind: "user_message",
      text: "The checkout total ignores discounts. Fix it and run the tests.",
    });
    expect(normalized.events.map((event) => `${event.agent}:${event.kind}`).slice(4, 9)).toEqual([
      "reviewer:subagent_start",
      "reviewer:user_message",
      "reviewer:tool_call",
      "reviewer:tool_result",
      "reviewer:subagent_end",
    ]);
    // isError defaults to false
    expect(normalized.events[3].result).toEqual({ callId: "c1", isError: false, text: "export const total = (items) => sum(items);" });
    expect(normalized.events[13]).toMatchObject({ kind: "omitted", reason: "planning notes not exported" });
  });

  it("builds a valid upload that names the harness, masks secrets, and derives the summary", async () => {
    const prepared = await prepareTraceUpload({ main: parsed(), importer: "test" });
    expect(prepared.format).toBe("shiplet");
    expect(prepared.upload.source).toEqual({ harness: "acme-agent", harnessVersion: "1.4.0", importer: "test" });
    expect(prepared.upload.title).toBe("Fix the checkout total");
    expect(prepared.masked).toEqual({ count: 1, kinds: { "github-token": 1 } });
    expect(JSON.stringify(prepared.upload)).not.toContain("ghp_0123456789");
    expect(await validateUpload(prepared.upload)).toEqual({ ok: true });
    expect((await prepareTraceUpload({ main: parsed(), title: "Mine", importer: "test" })).upload.title).toBe("Mine");

    const finalized = await finalizeTrace({
      events: prepared.upload.events,
      cwd: prepared.upload.cwd,
      title: prepared.upload.title,
      source: { harness: "acme-agent", harnessVersion: "1.4.0", importer: "test" },
      startedAt: prepared.upload.startedAt,
      endedAt: prepared.upload.endedAt,
      models: prepared.upload.models,
    });
    expect(finalized.manifest.summary).toMatchObject({
      durationSeconds: 33,
      promptCount: 1,
      filesTouched: ["src/checkout.ts"],
      checks: [{ command: "npm test", ok: true }],
      outcome: "last-check-passed",
      errorCount: 0,
    });
    expect(finalized.manifest.agents).toEqual([{ id: "reviewer", title: "Check the discount rules" }]);
  });

  it("masks open-format events on the server exactly as on the client", async () => {
    const unmasked = await normalizeText(openTrace);
    const masked = await maskEvents(unmasked.events);
    expect(masked.count).toBe(1);
    expect(masked.events[12].result?.text).toContain("[secret:github-token]");
  });

  it("masks a secret in the header title, as D6 requires for every title", async () => {
    const text = withLine(1, (record) => ({ ...record, title: "Rotate sk-ant-api03-abcdefghijklmnopqrstuv" }));
    const prepared = await prepareTraceUpload({ main: parsed(text), importer: "test" });
    expect(prepared.upload.title).toBe("Rotate [secret:anthropic-key]");
    expect(prepared.masked.kinds["anthropic-key"]).toBe(1);
    const flagged = await prepareTraceUpload({ main: parsed(), title: "token=abc123def456", importer: "test" });
    expect(flagged.upload.title).toBe("token=[secret:credential-assignment]");
  });

  it("closes a subagent that is still running at the end of the file", async () => {
    const records = lines().filter((record) => record.kind !== "subagent_end");
    const renumbered = records.map((record, index) => (index === 0 ? record : { ...record, seq: index - 1 }));
    const normalized = await normalizeText(toText(renumbered));
    const last = normalized.events[normalized.events.length - 1];
    expect(last).toMatchObject({ kind: "subagent_end", agent: "reviewer", seq: normalized.events.length - 1 });
  });

  it("skips a half-written last line but rejects a broken line in the middle", async () => {
    const tolerated = await normalize({ format: "shiplet", main: parsed(`${openTrace.trim()}\n{"seq":16,"kind":"assi`) });
    expect(tolerated.skippedLines).toBe(1);
    const all = openTrace.trim().split("\n");
    const broken = [...all.slice(0, 3), "{oops", ...all.slice(3)].join("\n");
    await expect(normalizeText(broken)).rejects.toThrow("line 4: not a JSON object");
  });

  it("rejects separate subagent files, because subagents are inline", async () => {
    await expect(
      prepareTraceUpload({ main: parsed(), subagents: [{ fileName: "agent-x.jsonl", ...parseJsonl(openTrace) }] }),
    ).rejects.toThrow("subagents inline");
  });
});

describe("open trace format: strict validation names the line and field", () => {
  it.each<[string, string, string]>([
    ["an unknown kind", withLine(3, (record) => ({ ...record, kind: "thought" })), 'line 3, kind: unknown kind "thought"'],
    ["a missing seq", withLine(3, ({ seq, ...record }) => record), "line 3, seq: must be 1"],
    ["a seq gap", withLine(3, (record) => ({ ...record, seq: 7 })), "line 3, seq: must be 1"],
    ["an id that does not match seq", withLine(3, (record) => ({ ...record, id: "e000009" })), "line 3, id: must be e000001"],
    ["a bad time", withLine(3, (record) => ({ ...record, t: "yesterday" })), "line 3, t:"],
    ["a non-string text", withLine(2, (record) => ({ ...record, text: 42 })), "line 2, text: must be a string"],
    ["an unknown event field", withLine(2, (record) => ({ ...record, colour: "red" })), "line 2, colour: unknown field"],
    ["attachmentIds", withLine(2, (record) => ({ ...record, attachmentIds: ["a"] })), "line 2, attachmentIds: unknown field"],
    ["a tool input that is not an object", withLine(4, (record) => ({ ...record, tool: { ...record.tool, input: "x" } })), "line 4, tool.input: must be an object"],
    ["a client-built input summary", withLine(4, (record) => ({ ...record, tool: { ...record.tool, inputSummary: "x" } })), "line 4, tool.inputSummary:"],
    ["a duplicate call ID", withLine(8, (record) => ({ ...record, tool: { ...record.tool, callId: "c1" } })), 'line 8, tool.callId: "c1" is already used on line 4'],
    ["a result with no call", withLine(5, (record) => ({ ...record, result: { ...record.result, callId: "zz" } })), 'line 5, result.callId: no earlier tool_call has callId "zz"'],
    ["a non-boolean isError", withLine(5, (record) => ({ ...record, result: { ...record.result, isError: "no" } })), "line 5, result.isError: must be true or false"],
    ["an omitted event with no reason", withLine(15, ({ reason, ...record }) => record), "line 15, reason: must be a non-empty string"],
    ["a subagent event before its start", withLine(6, (record) => ({ ...record, kind: "system_note", text: "x" })), 'line 6, agent: subagent "reviewer" has no subagent_start'],
    ["a subagent event after its end", withLine(11, (record) => ({ ...record, agent: "reviewer" })), 'line 11, agent: subagent "reviewer" ended on line 10'],
    ["a subagent_start for main", withLine(6, ({ agent, ...record }) => record), "line 6, agent: subagent_start needs a subagent ID"],
    ["a future format version", withLine(1, (record) => ({ ...record, format: "shiplet.trace/v2" })), 'line 1, format: "shiplet.trace/v2" is not supported'],
    ["a missing harness", withLine(1, ({ harness, ...record }) => record), "line 1, harness:"],
    ["a harness with spaces", withLine(1, (record) => ({ ...record, harness: "Acme Agent" })), "line 1, harness: must match"],
    ["the reserved claude-code harness", withLine(1, (record) => ({ ...record, harness: "claude-code" })), 'line 1, harness: "claude-code" is reserved'],
    ["the reserved codex harness", withLine(1, (record) => ({ ...record, harness: "codex" })), 'line 1, harness: "codex" is reserved'],
    ["an unknown header field", withLine(1, (record) => ({ ...record, owner: "me" })), "line 1, owner: unknown field"],
    ["a bad header time", withLine(1, (record) => ({ ...record, startedAt: "soon" })), "line 1, startedAt:"],
    ["too many models", withLine(1, (record) => ({ ...record, models: Array.from({ length: 21 }, (_, index) => `m${index}`) })), "line 1, models:"],
    ["files without a cwd", withLine(2, (record) => ({ ...record, files: ["shot.png"] })).replace(',"cwd":"/work/shop"', ""), 'line 2, files: needs "cwd" in the header'],
    ["a file outside cwd", withLine(2, (record) => ({ ...record, files: ["../secrets/shot.png"] })), "line 2, files[0]: must stay inside cwd"],
    ["an absolute file outside cwd", withLine(2, (record) => ({ ...record, files: ["/etc/shot.png"] })), "line 2, files[0]: must stay inside cwd"],
    ["a file type that is not allowed", withLine(2, (record) => ({ ...record, files: ["notes.txt"] })), "line 2, files[0]: must end in"],
  ])("rejects %s", async (_name, text, message) => {
    await expect(normalizeText(text)).rejects.toThrow(message);
  });

  it("returns file references for the CLI to attach, relative to cwd", async () => {
    const text = withLine(2, (record) => ({ ...record, files: ["shots/home.png", "/work/shop/out/run.webm"] }));
    const normalized = await normalizeText(text);
    expect(normalized.files).toEqual([
      { eventId: "e000000", line: 2, path: "shots/home.png", mediaType: "image/png" },
      { eventId: "e000000", line: 2, path: "/work/shop/out/run.webm", mediaType: "video/webm" },
    ]);
    expect(normalized.events[0]).not.toHaveProperty("files");
  });
});

describe("harness identity", () => {
  it("accepts any lowercase slug on upload, including the built-in importers", async () => {
    const prepared = await prepareTraceUpload({ main: parsed(), importer: "test" });
    for (const harness of ["acme-agent", "claude-code", "codex", "agent.v2", "x"]) {
      expect(await validateUpload({ ...prepared.upload, source: { ...prepared.upload.source, harness } }), harness).toEqual({ ok: true });
    }
    for (const harness of ["Acme", "-acme", "acme_agent", "a".repeat(41), "", 7]) {
      const result = await validateUpload({ ...prepared.upload, source: { ...prepared.upload.source, harness } });
      expect(result.ok, String(harness)).toBe(false);
      if (!result.ok) expect(result.errors.map((error) => error.path)).toContain("source.harness");
    }
    expect(HARNESS_PATTERN.source).toBe("^[a-z0-9][a-z0-9.-]{0,39}$");
  });

  it("labels built-in harnesses by name and others by their title-cased slug", () => {
    expect(harnessLabel("claude-code")).toBe("Claude Code");
    expect(harnessLabel("codex")).toBe("Codex");
    expect(harnessLabel("acme-agent")).toBe("Acme Agent");
    expect(harnessLabel("hal.9000")).toBe("Hal.9000");
    expect(harnessLabel("")).toBe("Agent");
    expect(harnessLabel(undefined)).toBe("Agent");
  });
});
