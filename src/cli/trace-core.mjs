// Shared trace core: normalizes Claude Code and Codex session logs into
// shiplet.trace/v1 events, masks secrets, truncates, validates, and builds the
// manifest and agent context. It runs unchanged in Node (the CLI), Workers,
// and browsers, so it uses only Web-standard APIs and has no dependencies.
//
// A trace is the full log of an agent session: the prompts, the agent's
// replies, and every tool call and result. See docs/traces-spec.md.

export const CORE_VERSION = "1";
export const TRACE_SCHEMA_VERSION = "shiplet.trace/v1";

const KiB = 1024;
const MiB = 1024 * KiB;

export const TRACE_LIMITS = Object.freeze({
  textFieldBytes: 256 * KiB,
  truncateKeepBytes: 64 * KiB,
  eventBytes: 512 * KiB,
  segmentEvents: 2000,
  segmentBytes: 1 * MiB,
  segmentsPerTrace: 128,
  canonicalBytes: 64 * MiB,
  attachmentBytes: 20 * MiB,
  attachmentsTotalBytes: 256 * MiB,
  attachmentsPerTrace: 200,
  uploadRequestBytes: 16 * MiB,
  organizationQuotaBytes: 10 * 1024 * MiB,
  personalQuotaBytes: 1024 * MiB,
  titleChars: 200,
});

export const ATTACHMENT_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
]);
const INLINE_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"]);

export const EVENT_KINDS = Object.freeze([
  "user_message",
  "assistant_message",
  "reasoning",
  "system_note",
  "tool_call",
  "tool_result",
  "subagent_start",
  "subagent_end",
  "omitted",
]);
const TEXT_KINDS = new Set(["user_message", "assistant_message", "reasoning", "system_note"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "exec_command", "local_shell"]);
// Search tools take a directory to search, not a file the agent touched.
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS", "grep", "glob"]);
// A check is a command that runs a test, lint, typecheck, or build tool, after
// leading "cd dir &&", environment assignments, and "timeout N" are removed.
const CHECK_COMMANDS = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|build|verify|check)(?:[:\s]|$)/,
  /^(?:npx|pnpx|bunx)\s+(?:vitest|jest|tsc|eslint|playwright|mocha|biome)\b/,
  /^(?:pytest|vitest|jest|tsc|eslint|mocha|ruff|mypy|rspec|phpunit)\b/,
  /^python3?\s+-m\s+(?:pytest|unittest|mypy)\b/,
  /^node\s+--test\b/,
  /^(?:go|cargo|deno|dotnet|mix|swift)\s+(?:test|build|check|vet|clippy)\b/,
  /^(?:make|just)\s+(?:test|check|lint|build|verify)\b/,
  /^(?:\.\/)?gradlew?\s+(?:test|check|build)\b/,
];

export function isCheckCommand(command) {
  let rest = String(command || "").trim();
  for (let guard = 0; guard < 10; guard++) {
    const before = rest;
    rest = rest
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, "")
      .replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "")
      .replace(/^timeout\s+\S+\s+/, "")
      .replace(/^(?:env|time|nice)\s+/, "");
    if (rest === before) break;
  }
  return CHECK_COMMANDS.some((pattern) => pattern.test(rest));
}

export class TraceFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "TraceFormatError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLength = (text) => encoder.encode(String(text)).byteLength;

// ---------------------------------------------------------------------------
// Parsing and format detection

export function parseJsonl(text) {
  const records = [];
  let skippedLines = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
      else skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  return { records, skippedLines };
}

const CODEX_TYPES = new Set(["session_meta", "response_item", "turn_context", "event_msg"]);

export function detectFormat(records) {
  if (records.some((record) => record && typeof record.payload === "object" && record.payload && CODEX_TYPES.has(record.type))) {
    return "codex";
  }
  if (records.some((record) => (record?.type === "user" || record?.type === "assistant") && record.message && typeof record.message === "object")) {
    return "claude-code";
  }
  throw new TraceFormatError("unrecognized session format");
}

// ---------------------------------------------------------------------------
// Normalization

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripReminders(text) {
  return String(text ?? "").replace(SYSTEM_REMINDER, "").trim();
}

function partsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function base64ToBytes(base64) {
  const binary = atob(String(base64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedMediaType(mediaType) {
  const type = String(mediaType || "").toLowerCase().split(";")[0].trim();
  return ATTACHMENT_TYPES.includes(type) ? type : "text/plain";
}

// Collects attachments keyed by sha256 while normalizing; events hold ids.
function attachmentCollector() {
  const pending = [];
  return {
    add(event, { mediaType, bytes, source = "inline" }) {
      pending.push({ event, mediaType: normalizedMediaType(mediaType), bytes, source });
    },
    async finish() {
      const attachments = new Map();
      for (const item of pending) {
        const sha256 = await sha256Hex(item.bytes);
        if (!attachments.has(sha256)) {
          attachments.set(sha256, { sha256, mediaType: item.mediaType, bytes: item.bytes.byteLength, data: item.bytes, source: item.source });
        }
        const ids = (item.event.attachmentIds ||= []);
        if (!ids.includes(sha256)) ids.push(sha256);
      }
      return [...attachments.values()];
    },
  };
}

function firstLine(text, max) {
  const line = String(text || "").split("\n").find((value) => value.trim()) || "";
  return line.trim().slice(0, max);
}

function claudeEvents(records, defaultAgent, collector, meta) {
  const events = [];
  let position = 0;
  for (const record of records) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.isMeta === true) continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    if (!meta.cwd && typeof record.cwd === "string") meta.cwd = record.cwd;
    if (!meta.harnessVersion && typeof record.version === "string") meta.harnessVersion = record.version;
    if (typeof message.model === "string" && !meta.models.includes(message.model) && !message.model.startsWith("<")) {
      meta.models.push(message.model);
    }
    const agent = record.isSidechain === true && defaultAgent === "main"
      ? (typeof record.agentId === "string" && record.agentId) || "sidechain"
      : defaultAgent;
    const t = typeof record.timestamp === "string" ? record.timestamp : null;
    const push = (event) => events.push({ ...event, agent, t, _position: position++ });
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const recordStart = events.length;
    const images = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") {
        const text = record.type === "user" ? stripReminders(part.text) : String(part.text ?? "");
        if (!text) continue;
        if (record.type === "user") {
          push({ kind: record.isCompactSummary === true ? "system_note" : "user_message", text });
        } else {
          push({ kind: "assistant_message", text });
        }
      } else if (part.type === "thinking" && record.type === "assistant") {
        const text = String(part.thinking ?? part.text ?? "");
        if (text) push({ kind: "reasoning", text });
      } else if (part.type === "tool_use") {
        push({
          kind: "tool_call",
          tool: { name: String(part.name ?? "tool"), callId: String(part.id ?? ""), input: part.input && typeof part.input === "object" ? part.input : { value: part.input ?? null } },
        });
      } else if (part.type === "tool_result") {
        const event = {
          kind: "tool_result",
          result: { callId: String(part.tool_use_id ?? ""), isError: part.is_error === true, text: partsText(part.content) },
        };
        push(event);
        const nested = Array.isArray(part.content) ? part.content : [];
        for (const child of nested) {
          if (child?.type === "image" && child.source?.type === "base64" && child.source.data) {
            collector.add(events[events.length - 1], { mediaType: child.source.media_type, bytes: base64ToBytes(child.source.data) });
          }
        }
      } else if (part.type === "image" && part.source?.type === "base64" && part.source.data) {
        images.push({ mediaType: part.source.media_type, bytes: base64ToBytes(part.source.data) });
      }
    }
    if (images.length) {
      const kind = record.type === "user" ? "user_message" : "assistant_message";
      let target = events.slice(recordStart).find((event) => event.kind === kind);
      if (!target) {
        push({ kind, text: "" });
        target = events[events.length - 1];
      }
      for (const image of images) collector.add(target, image);
    }
  }
  return events;
}

function codexExit(output) {
  let text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  let code = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (Number.isInteger(parsed.metadata?.exit_code)) code = parsed.metadata.exit_code;
      if (typeof parsed.output === "string") text = parsed.output;
    }
  } catch {
    // plain text output
  }
  if (code === null) {
    const match = text.match(/^Exit code: (-?\d+)/m) || text.match(/Process exited with code (-?\d+)/m);
    if (match) code = Number(match[1]);
  }
  return { text, isError: code !== null && code !== 0 };
}

function codexEvents(records, meta) {
  const events = [];
  let position = 0;
  const hasUserEvents = records.some((record) => record.type === "event_msg" && record.payload?.type === "user_message");
  for (const record of records) {
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;
    const t = typeof record.timestamp === "string" ? record.timestamp : null;
    const push = (event) => events.push({ ...event, agent: "main", t, _position: position++ });
    if (record.type === "session_meta") {
      if (typeof payload.cwd === "string") meta.cwd = payload.cwd;
      if (typeof payload.cli_version === "string") meta.harnessVersion = payload.cli_version;
      continue;
    }
    if (record.type === "turn_context") {
      if (typeof payload.model === "string" && !meta.models.includes(payload.model)) meta.models.push(payload.model);
      continue;
    }
    if (record.type === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string" && payload.message.trim()) {
        push({ kind: "user_message", text: payload.message });
      }
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message") {
      const text = partsText(payload.content);
      if (payload.role === "user" && !hasUserEvents && text && !text.trimStart().startsWith("<")) {
        push({ kind: "user_message", text });
      } else if (payload.role === "assistant" && text) {
        push({ kind: "assistant_message", text });
      }
    } else if (payload.type === "reasoning") {
      const text = Array.isArray(payload.summary)
        ? payload.summary.map((item) => (typeof item?.text === "string" ? item.text : "")).filter(Boolean).join("\n")
        : "";
      if (text) push({ kind: "reasoning", text });
    } else if (payload.type === "function_call") {
      let input;
      try {
        input = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
      } catch {
        input = { raw: String(payload.arguments) };
      }
      if (!input || typeof input !== "object") input = { raw: String(payload.arguments ?? "") };
      push({ kind: "tool_call", tool: { name: String(payload.name ?? "tool"), callId: String(payload.call_id ?? ""), input } });
    } else if (payload.type === "custom_tool_call") {
      push({ kind: "tool_call", tool: { name: String(payload.name ?? "tool"), callId: String(payload.call_id ?? ""), input: { input: payload.input ?? null } } });
    } else if (payload.type === "local_shell_call") {
      push({
        kind: "tool_call",
        tool: { name: "local_shell", callId: String(payload.call_id ?? payload.id ?? ""), input: payload.action && typeof payload.action === "object" ? payload.action : {} },
      });
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const { text, isError } = codexExit(payload.output);
      push({ kind: "tool_result", result: { callId: String(payload.call_id ?? ""), isError, text } });
    }
  }
  return events;
}

function subagentId(file) {
  const fromRecord = file.records.find((record) => typeof record.agentId === "string" && record.agentId)?.agentId;
  if (fromRecord) return fromRecord;
  const name = String(file.fileName || "").split(/[\\/]/).pop() || "subagent";
  return name.replace(/\.jsonl$/i, "").replace(/^agent-/, "") || "subagent";
}

export async function normalize({ format, main, subagents = [] }) {
  const meta = { cwd: null, harnessVersion: null, models: [] };
  const collector = attachmentCollector();
  let events;
  if (format === "claude-code") {
    events = claudeEvents(main.records, "main", collector, meta);
    subagents.forEach((file, fileIndex) => {
      const id = subagentId(file);
      const offset = (fileIndex + 1) * 10_000_000;
      for (const event of claudeEvents(file.records, id, collector, meta)) {
        events.push({ ...event, _position: event._position + offset });
      }
    });
  } else if (format === "codex") {
    events = codexEvents(main.records, meta);
  } else {
    throw new TraceFormatError("unrecognized session format");
  }
  const attachments = await collector.finish();
  events = orderEvents(events);
  const times = events.map((event) => event.t).filter(Boolean).sort();
  const skippedLines = main.skippedLines + subagents.reduce((sum, file) => sum + (file.skippedLines || 0), 0);
  return {
    events,
    attachments,
    cwd: meta.cwd,
    startedAt: times[0] || null,
    endedAt: times[times.length - 1] || null,
    models: meta.models,
    harnessVersion: meta.harnessVersion,
    skippedLines,
  };
}

// Sort by time (untimed events keep their place after the last timed event
// before them), main first on ties, then wrap each non-main agent in markers.
function orderEvents(events) {
  let lastTime = "";
  const keyed = events
    .sort((a, b) => a._position - b._position)
    .map((event) => {
      if (event.t) lastTime = event.t;
      return { event, time: event.t || lastTime };
    });
  keyed.sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    const aMain = a.event.agent === "main" ? 0 : 1;
    const bMain = b.event.agent === "main" ? 0 : 1;
    if (aMain !== bMain) return aMain - bMain;
    return a.event._position - b.event._position;
  });
  const ordered = keyed.map(({ event }) => event);
  const first = new Map();
  const last = new Map();
  ordered.forEach((event, index) => {
    if (event.agent === "main") return;
    if (!first.has(event.agent)) first.set(event.agent, index);
    last.set(event.agent, index);
  });
  const result = [];
  ordered.forEach((event, index) => {
    if (first.get(event.agent) === index) {
      const prompt = ordered.find((candidate) => candidate.agent === event.agent && candidate.kind === "user_message");
      result.push({ kind: "subagent_start", agent: event.agent, t: event.t, text: firstLine(prompt?.text, 200) || event.agent });
    }
    const { _position, ...clean } = event;
    result.push(clean);
    if (last.get(event.agent) === index) result.push({ kind: "subagent_end", agent: event.agent, t: event.t });
  });
  return result.map((event, seq) => ({ id: eventId(seq), seq, ...event }));
}

function eventId(seq) {
  return `e${String(seq).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Secret masking (docs/traces-spec.md D6)

const VALUE_CHARS = "[A-Za-z0-9._~+/=-]";
const ASSIGNMENT_KEYS = "api_key|apikey|api-key|access_key|secret_key|client_secret|auth_token|access_token|refresh_token|token|secret|password|passwd|authorization|cookie";

const SECRET_PATTERNS = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: "shiplet-api-key", pattern: /\bshiplet_(?:org|cli_session)_[A-Za-z0-9]{16,}/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe-key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { kind: "openai-style-key", pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bearer", pattern: new RegExp(`(\\b[Bb]earer\\s+)(?!\\[secret:)(${VALUE_CHARS}{16,})`, "g"), group: 2 },
  { kind: "url-credentials", pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)(?!\[secret:)([^\s@/]+)(@)/gi, group: 2 },
  {
    kind: "credential-assignment",
    pattern: new RegExp(
      `((?<![\\[\\w])["']?\\b(?:${ASSIGNMENT_KEYS})\\b["']?\\s*[:=]\\s*)(?!\\[secret:)("[^"\\n]{8,4096}"|'[^'\\n]{8,4096}'|${VALUE_CHARS}{8,})`,
      "gi",
    ),
    group: 2,
    accept: (value) => {
      const inner = value.replace(/^["']|["']$/g, "");
      return /[A-Za-z]/.test(inner) && /[0-9]/.test(inner) && !inner.startsWith("[secret:");
    },
  },
];

export function maskSecrets(input) {
  let text = String(input ?? "");
  let count = 0;
  const kinds = {};
  if (!text) return { text, count, kinds };
  for (const { kind, pattern, group, accept } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (...args) => {
      const match = args[0];
      if (group === undefined) {
        if (match.startsWith("[secret:")) return match;
        count++;
        kinds[kind] = (kinds[kind] || 0) + 1;
        return `[secret:${kind}]`;
      }
      const groups = args.slice(1, -2);
      const value = groups[group - 1];
      if (typeof value !== "string" || (accept && !accept(value))) return match;
      count++;
      kinds[kind] = (kinds[kind] || 0) + 1;
      const quote = /^["']/.test(value) ? value[0] : "";
      const replacement = `${quote}[secret:${kind}]${quote}`;
      return groups.map((part, index) => (index === group - 1 ? replacement : part ?? "")).join("");
    });
  }
  return { text, count, kinds };
}

function mergeKinds(target, source) {
  for (const [kind, value] of Object.entries(source)) target[kind] = (target[kind] || 0) + value;
  return target;
}

const EXEMPT_KEYS = new Set(["id", "seq", "t", "agent", "kind", "callId", "attachmentIds", "isError"]);

function maskValue(value, totals, key) {
  if (key && EXEMPT_KEYS.has(key)) return value;
  if (typeof value === "string") {
    const result = maskSecrets(value);
    totals.count += result.count;
    mergeKinds(totals.kinds, result.kinds);
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, totals));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = maskValue(childValue, totals, childKey);
    return output;
  }
  return value;
}

export async function maskEvents(events) {
  const totals = { count: 0, kinds: {} };
  const masked = events.map((event) => maskValue(event, totals));
  return { events: masked, count: totals.count, kinds: totals.kinds };
}

// Masks text/plain attachments (their bytes are text), re-hashes them, and
// rewrites event references. Attachments that end up identical are merged.
export async function maskAttachments(attachments, events) {
  const totals = { count: 0, kinds: {} };
  const rename = new Map();
  const output = new Map();
  for (const attachment of attachments) {
    let data = attachment.data;
    let sha256 = attachment.sha256;
    if (attachment.mediaType === "text/plain") {
      const result = maskSecrets(decoder.decode(data));
      if (result.count) {
        totals.count += result.count;
        mergeKinds(totals.kinds, result.kinds);
        data = encoder.encode(result.text);
        sha256 = await sha256Hex(data);
      }
    }
    rename.set(attachment.sha256, sha256);
    if (!output.has(sha256)) output.set(sha256, { ...attachment, sha256, data, bytes: data.byteLength });
  }
  const renamed = events.map((event) =>
    event.attachmentIds
      ? { ...event, attachmentIds: [...new Set(event.attachmentIds.map((id) => rename.get(id) || id))] }
      : event,
  );
  return { attachments: [...output.values()], events: renamed, count: totals.count, kinds: totals.kinds };
}

// ---------------------------------------------------------------------------
// Truncation (D10). Runs after masking.

function truncateText(text, maxBytes, keepBytes) {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const head = decodeWhole(bytes.subarray(0, keepBytes), false);
  const tail = decodeWhole(bytes.subarray(bytes.byteLength - keepBytes), true);
  return `${head}\n[truncated: ${bytes.byteLength} bytes]\n${tail}`;
}

// Decode a byte slice, dropping a partial character at the cut edge.
function decodeWhole(slice, fromEnd) {
  let start = 0;
  let end = slice.byteLength;
  if (fromEnd) {
    while (start < end && (slice[start] & 0xc0) === 0x80) start++;
  } else {
    let back = end - 1;
    let continuation = 0;
    while (back >= 0 && (slice[back] & 0xc0) === 0x80) {
      continuation++;
      back--;
    }
    if (back >= 0) {
      const lead = slice[back];
      const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
      if (need !== continuation) end = back;
    }
  }
  return decoder.decode(slice.subarray(start, end));
}

function truncateStrings(value, maxBytes, keepBytes, key) {
  if (key && EXEMPT_KEYS.has(key)) return value;
  if (typeof value === "string") return truncateText(value, maxBytes, keepBytes);
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxBytes, keepBytes));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = truncateStrings(childValue, maxBytes, keepBytes, childKey);
    return output;
  }
  return value;
}

export function truncateEvents(events) {
  const { textFieldBytes, truncateKeepBytes, eventBytes } = TRACE_LIMITS;
  return events.map((event) => {
    let next = truncateStrings(event, textFieldBytes, truncateKeepBytes);
    if (byteLength(JSON.stringify(next)) <= eventBytes) return next;
    if (next.tool) {
      const inputBytes = byteLength(JSON.stringify(next.tool.input ?? null));
      next = {
        ...next,
        tool: { ...next.tool, inputSummary: next.tool.inputSummary ?? inputSummary(next.tool), input: { truncated: true, bytes: inputBytes } },
      };
    }
    if (typeof next.text === "string") next = { ...next, text: truncateText(next.text, truncateKeepBytes, truncateKeepBytes / 2) };
    if (next.result && typeof next.result.text === "string") {
      next = { ...next, result: { ...next.result, text: truncateText(next.result.text, truncateKeepBytes, truncateKeepBytes / 2) } };
    }
    return next;
  });
}

export function dropAttachments(events) {
  let dropped = 0;
  const output = events.map((event) => {
    if (!event.attachmentIds) return event;
    dropped += event.attachmentIds.length;
    const { attachmentIds, ...rest } = event;
    return rest;
  });
  return { events: output, dropped };
}

// ---------------------------------------------------------------------------
// Summaries, segments, manifest

function shellCommand(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command;
  if (Array.isArray(input.command)) return String(input.command[input.command.length - 1] ?? "");
  if (typeof input.cmd === "string") return input.cmd;
  return "";
}

export function inputSummary(tool) {
  const input = tool?.input && typeof tool.input === "object" ? tool.input : {};
  if (SHELL_TOOLS.has(tool?.name)) {
    const command = shellCommand(input);
    if (command) return command.slice(0, 200);
  }
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof input[key] === "string") return input[key].slice(0, 200);
  }
  const first = Object.values(input).find((value) => typeof value === "string");
  return `${tool?.name ?? "tool"}${first ? `: ${first}` : ""}`.slice(0, 120);
}

function relativePath(path, cwd) {
  if (!cwd || typeof path !== "string") return null;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return null;
  if (path.startsWith(base)) return path.slice(base.length);
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("..")) return path;
  return null;
}

export function buildSummary(events, { cwd = null, models = [], startedAt = null, endedAt = null } = {}) {
  const toolCounts = {};
  const files = [];
  const results = new Map();
  for (const event of events) if (event.kind === "tool_result") results.set(event.result?.callId, event.result);
  const checks = [];
  let errorCount = 0;
  for (const event of events) {
    if (event.kind === "tool_result" && event.result?.isError) errorCount++;
    if (event.kind !== "tool_call") continue;
    const name = event.tool?.name ?? "tool";
    toolCounts[name] = (toolCounts[name] || 0) + 1;
    const input = event.tool?.input && typeof event.tool.input === "object" ? event.tool.input : {};
    for (const key of SEARCH_TOOLS.has(name) ? [] : ["file_path", "path", "notebook_path"]) {
      const relative = relativePath(input[key], cwd);
      if (relative && !files.includes(relative)) files.push(relative);
    }
    const summary = event.tool?.inputSummary ?? inputSummary(event.tool);
    if (SHELL_TOOLS.has(name) && isCheckCommand(summary)) {
      const result = results.get(event.tool?.callId);
      checks.push({ command: firstLine(summary, 200), ok: !(result && result.isError) });
    }
  }
  const last = checks[checks.length - 1];
  const durationSeconds = startedAt && endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) : null;
  return {
    durationSeconds,
    models: [...models],
    promptCount: events.filter((event) => event.kind === "user_message" && event.agent === "main").length,
    toolCounts,
    filesTouched: files,
    checks,
    outcome: !last ? "no-checks-run" : last.ok ? "last-check-passed" : "last-check-failed",
    errorCount,
  };
}

export function segmentEvents(events) {
  const segments = [];
  let current = [];
  let bytes = 0;
  const flush = () => {
    if (!current.length) return;
    segments.push({ index: segments.length, events: current, ndjson: current.map((line) => line.json).join("\n") + "\n", bytes });
    current = [];
    bytes = 0;
  };
  for (const event of events) {
    const json = JSON.stringify(event);
    const size = byteLength(json) + 1;
    if (current.length && (current.length >= TRACE_LIMITS.segmentEvents || bytes + size > TRACE_LIMITS.segmentBytes)) flush();
    current.push({ event, json });
    bytes += size;
  }
  flush();
  return segments.map((segment) => ({
    index: segment.index,
    ndjson: segment.ndjson,
    events: segment.events.length,
    bytes: segment.bytes,
    firstSeq: segment.events[0].event.seq,
    lastSeq: segment.events[segment.events.length - 1].event.seq,
  }));
}

export async function finalizeTrace({
  events,
  attachments = [],
  cwd = null,
  title,
  source,
  startedAt = null,
  endedAt = null,
  models = [],
  skippedLines = 0,
  droppedAttachments = 0,
  masking = {},
}) {
  const withSummaries = events.map((event) =>
    event.kind === "tool_call" ? { ...event, tool: { ...event.tool, inputSummary: event.tool.inputSummary ?? inputSummary(event.tool) } } : event,
  );
  const summary = buildSummary(withSummaries, { cwd, models, startedAt, endedAt });
  const segments = segmentEvents(withSummaries);
  const segmentRecords = [];
  for (const segment of segments) {
    segmentRecords.push({
      index: segment.index,
      firstSeq: segment.firstSeq,
      lastSeq: segment.lastSeq,
      events: segment.events,
      bytes: segment.bytes,
      sha256: await sha256Hex(segment.ndjson),
    });
  }
  const agents = [];
  for (const event of withSummaries) {
    if (event.kind === "subagent_start") agents.push({ id: event.agent, title: event.text || event.agent });
  }
  const cwdLabel = cwd ? String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null : null;
  const manifest = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    title,
    source,
    startedAt,
    endedAt,
    models: [...models],
    cwdLabel,
    agents,
    counts: {
      events: withSummaries.length,
      toolCalls: withSummaries.filter((event) => event.kind === "tool_call").length,
      errors: summary.errorCount,
      attachments: attachments.length,
      skippedLines,
      droppedAttachments,
    },
    summary,
    segments: segmentRecords,
    attachments: attachments.map(({ sha256, mediaType, bytes, source: attachmentSource = "inline" }) => ({ sha256, mediaType, bytes, source: attachmentSource })),
    masking: {
      coreVersion: CORE_VERSION,
      clientCount: masking.clientCount ?? 0,
      clientKinds: masking.clientKinds ?? {},
      serverCount: masking.serverCount ?? 0,
      serverKinds: masking.serverKinds ?? {},
    },
  };
  return { manifest, segments: segments.map(({ index, ndjson }) => ({ index, ndjson })), events: withSummaries };
}

// ---------------------------------------------------------------------------
// Upload envelope

const UPLOAD_FIELDS = new Set([
  "schemaVersion",
  "revisionId",
  "title",
  "source",
  "cwd",
  "startedAt",
  "endedAt",
  "models",
  "skippedLines",
  "droppedAttachments",
  "clientMasking",
  "events",
  "attachments",
]);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export async function buildUpload({ normalized, title, revisionId = null, source, events, attachments, droppedAttachments = 0, clientMasking }) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    revisionId,
    title,
    source,
    cwd: normalized.cwd ?? null,
    startedAt: normalized.startedAt ?? null,
    endedAt: normalized.endedAt ?? null,
    models: normalized.models ?? [],
    skippedLines: normalized.skippedLines ?? 0,
    droppedAttachments,
    clientMasking,
    events,
    attachments: attachments.map(({ sha256, mediaType, bytes, data }) => ({ sha256, mediaType, bytes, base64: bytesToBase64(data) })),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value, max) {
  return value === null || (typeof value === "string" && value.length <= max);
}

const nonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export async function validateUpload(upload) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (!isPlainObject(upload)) return { ok: false, errors: [{ path: "", message: "Upload must be an object." }] };
  for (const key of Object.keys(upload)) if (!UPLOAD_FIELDS.has(key)) fail(key, "Unknown field.");
  if (upload.schemaVersion !== TRACE_SCHEMA_VERSION) fail("schemaVersion", `Must be ${TRACE_SCHEMA_VERSION}.`);
  const title = typeof upload.title === "string" ? upload.title.trim() : "";
  if (!title || title.length > TRACE_LIMITS.titleChars) fail("title", `Must be 1 to ${TRACE_LIMITS.titleChars} characters.`);
  if (!(upload.revisionId === null || upload.revisionId === undefined || (typeof upload.revisionId === "string" && upload.revisionId.length <= 200))) {
    fail("revisionId", "Must be a string or null.");
  }
  const source = upload.source;
  if (!isPlainObject(source)) fail("source", "Must be an object.");
  else {
    if (source.harness !== "claude-code" && source.harness !== "codex") fail("source.harness", "Must be claude-code or codex.");
    if (!nullableString(source.harnessVersion ?? null, 64)) fail("source.harnessVersion", "Must be at most 64 characters or null.");
    if (!nullableString(source.importer ?? null, 64)) fail("source.importer", "Must be at most 64 characters or null.");
    for (const key of Object.keys(source)) if (!["harness", "harnessVersion", "importer"].includes(key)) fail(`source.${key}`, "Unknown field.");
  }
  if (!nullableString(upload.cwd ?? null, 4096)) fail("cwd", "Must be at most 4096 characters or null.");
  for (const key of ["startedAt", "endedAt"]) {
    const value = upload[key] ?? null;
    if (!(value === null || (typeof value === "string" && ISO_DATE_TIME.test(value)))) fail(key, "Must be an ISO 8601 date-time or null.");
  }
  if (!Array.isArray(upload.models) || upload.models.length > 20 || upload.models.some((model) => typeof model !== "string" || model.length > 100)) {
    fail("models", "Must be at most 20 strings of at most 100 characters.");
  }
  if (!nonNegativeInteger(upload.skippedLines ?? 0)) fail("skippedLines", "Must be a non-negative integer.");
  if (!nonNegativeInteger(upload.droppedAttachments ?? 0)) fail("droppedAttachments", "Must be a non-negative integer.");
  const clientMasking = upload.clientMasking;
  if (
    !isPlainObject(clientMasking) ||
    typeof clientMasking.coreVersion !== "string" ||
    !nonNegativeInteger(clientMasking.count) ||
    !isPlainObject(clientMasking.kinds) ||
    Object.values(clientMasking.kinds).some((value) => !nonNegativeInteger(value))
  ) {
    fail("clientMasking", "Must be { coreVersion, count, kinds }.");
  }

  const attachmentIds = new Set();
  let attachmentBytes = 0;
  if (!Array.isArray(upload.attachments)) fail("attachments", "Must be an array.");
  else {
    if (upload.attachments.length > TRACE_LIMITS.attachmentsPerTrace) fail("attachments", `At most ${TRACE_LIMITS.attachmentsPerTrace} attachments.`);
    for (const [index, attachment] of upload.attachments.entries()) {
      const path = `attachments[${index}]`;
      if (!isPlainObject(attachment)) {
        fail(path, "Must be an object.");
        continue;
      }
      if (typeof attachment.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(attachment.sha256)) fail(`${path}.sha256`, "Must be a lowercase sha256.");
      else if (attachmentIds.has(attachment.sha256)) fail(`${path}.sha256`, "Duplicate attachment.");
      else attachmentIds.add(attachment.sha256);
      if (!ATTACHMENT_TYPES.includes(attachment.mediaType)) fail(`${path}.mediaType`, "Type not allowed.");
      if (!nonNegativeInteger(attachment.bytes) || attachment.bytes > TRACE_LIMITS.attachmentBytes) fail(`${path}.bytes`, "Size out of bounds.");
      if (typeof attachment.base64 !== "string") {
        fail(`${path}.base64`, "Must be base64.");
        continue;
      }
      let data;
      try {
        data = base64ToBytes(attachment.base64);
      } catch {
        fail(`${path}.base64`, "Must be base64.");
        continue;
      }
      if (data.byteLength !== attachment.bytes) fail(`${path}.bytes`, "Does not match the decoded size.");
      else if ((await sha256Hex(data)) !== attachment.sha256) fail(`${path}.sha256`, "Does not match the decoded bytes.");
      attachmentBytes += data.byteLength;
    }
    if (attachmentBytes > TRACE_LIMITS.attachmentsTotalBytes) fail("attachments", "Total attachment size exceeds the limit.");
  }

  if (!Array.isArray(upload.events) || upload.events.length === 0) fail("events", "Must be a non-empty array.");
  else {
    let total = 0;
    for (const [index, event] of upload.events.entries()) {
      const path = `events[${index}]`;
      if (!isPlainObject(event)) {
        fail(path, "Must be an object.");
        continue;
      }
      if (event.seq !== index) fail(`${path}.seq`, "Must equal its position.");
      if (event.id !== eventId(index)) fail(`${path}.id`, `Must be ${eventId(index)}.`);
      if (!EVENT_KINDS.includes(event.kind)) fail(`${path}.kind`, "Unknown kind.");
      if (!(event.t === null || event.t === undefined || typeof event.t === "string")) fail(`${path}.t`, "Must be a string or null.");
      if (typeof event.agent !== "string" || !event.agent || event.agent.length > 200) fail(`${path}.agent`, "Must be a non-empty string.");
      if (TEXT_KINDS.has(event.kind) || event.kind === "subagent_start") {
        if (typeof event.text !== "string") fail(`${path}.text`, "Must be a string.");
      }
      if (event.kind === "tool_call") {
        if (!isPlainObject(event.tool) || typeof event.tool.name !== "string" || typeof event.tool.callId !== "string" || !isPlainObject(event.tool.input)) {
          fail(`${path}.tool`, "Must have name, callId, and an input object.");
        }
      }
      if (event.kind === "tool_result") {
        if (!isPlainObject(event.result) || typeof event.result.callId !== "string" || typeof event.result.isError !== "boolean" || typeof event.result.text !== "string") {
          fail(`${path}.result`, "Must have callId, isError, and text.");
        }
      }
      if (event.kind === "omitted" && typeof event.reason !== "string") fail(`${path}.reason`, "Must be a string.");
      if (event.attachmentIds !== undefined) {
        if (!Array.isArray(event.attachmentIds)) fail(`${path}.attachmentIds`, "Must be an array.");
        else for (const id of event.attachmentIds) if (!attachmentIds.has(id)) fail(`${path}.attachmentIds`, `Unknown attachment ${id}.`);
      }
      const size = byteLength(JSON.stringify(event));
      if (size > TRACE_LIMITS.eventBytes) fail(path, "Event exceeds 512 KiB.");
      for (const field of [event.text, event.result?.text]) {
        if (typeof field === "string" && byteLength(field) > TRACE_LIMITS.textFieldBytes) fail(path, "A text field exceeds 256 KiB.");
      }
      total += size;
      if (errors.length > 50) break;
    }
    if (total > TRACE_LIMITS.canonicalBytes) fail("events", "Trace exceeds 64 MiB.");
  }
  return errors.length ? { ok: false, errors: errors.slice(0, 50) } : { ok: true };
}

export function decodeUploadAttachments(upload) {
  return (upload.attachments || []).map((attachment) => ({
    sha256: attachment.sha256,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    data: base64ToBytes(attachment.base64),
    source: "inline",
  }));
}

// ---------------------------------------------------------------------------
// Context handoff for agents (D13)

const estimateTokens = (text) => Math.ceil(text.length / 4);

export function buildContext(manifest, events, { level = "full", maxTokens = 32000 } = {}) {
  const summary = manifest.summary || {};
  const minutes = summary.durationSeconds == null ? "?" : Math.round(summary.durationSeconds / 60);
  const header = [
    `# ${manifest.title}`,
    `Source: ${manifest.source?.harness ?? "agent"}${manifest.source?.harnessVersion ? ` ${manifest.source.harnessVersion}` : ""} · Models: ${(manifest.models || []).join(", ") || "unknown"} · Duration: ${minutes} min · Outcome: ${summary.outcome ?? "no-checks-run"} · Your level: ${level}`,
    "",
    "A trace is the full log of an agent session, including the prompts, the agent's replies, and every tool call and result.",
    "",
    "## Summary",
    `Files touched: ${(summary.filesTouched || []).slice(0, 50).join(", ") || "none"}`,
    `Checks: ${(summary.checks || []).length ? "" : "none"}`,
    ...(summary.checks || []).slice(-20).map((check) => `- ${check.command} (${check.ok ? "passed" : "failed"})`),
    `Errors: ${summary.errorCount ?? 0} · Subagents: ${(manifest.agents || []).length}`,
    "",
    "## Session",
  ].join("\n");

  const results = new Map(events.filter((event) => event.kind === "tool_result").map((event) => [event.result?.callId, event.result]));
  const subagentCounts = new Map();
  for (const event of events) {
    if (event.agent === "main") continue;
    const entry = subagentCounts.get(event.agent) || { calls: 0, errors: 0 };
    if (event.kind === "tool_call") entry.calls++;
    if (event.kind === "tool_result" && event.result?.isError) entry.errors++;
    subagentCounts.set(event.agent, entry);
  }
  const lines = [];
  for (const event of events) {
    if (event.kind === "subagent_start") {
      const counts = subagentCounts.get(event.agent) || { calls: 0, errors: 0 };
      lines.push({ type: "subagent", text: `[Subagent "${event.text}": ${counts.calls} tool calls, ${counts.errors} errors]` });
      continue;
    }
    if (event.agent !== "main") continue;
    if (event.kind === "user_message") lines.push({ type: "message", text: `**User:** ${event.text}` });
    else if (event.kind === "assistant_message") lines.push({ type: "message", text: `**Assistant:** ${event.text}` });
    else if (event.kind === "tool_call") {
      const result = results.get(event.tool?.callId);
      lines.push({ type: "call", failed: Boolean(result?.isError), text: `→ ${event.tool?.name}: ${event.tool?.inputSummary ?? inputSummary(event.tool)}` });
      if (result?.isError && level === "full" && typeof result.text === "string") {
        lines.push({ type: "error", text: `← error: ${result.text.slice(0, 400)}` });
      }
    }
  }
  const render = (items) => `${header}\n${items.map((item) => item.text).join("\n")}\n`;
  let items = lines;
  if (estimateTokens(render(items)) <= maxTokens) return render(items);
  items = items.filter((item) => item.type !== "error");
  if (estimateTokens(render(items)) <= maxTokens) return render(items);
  items = items.filter((item) => item.type !== "call" || item.failed);
  if (estimateTokens(render(items)) <= maxTokens) return render(items);
  const messageIndexes = items.map((item, index) => (item.type === "message" ? index : -1)).filter((index) => index >= 0);
  if (messageIndexes.length > 13) {
    const keep = new Set([...messageIndexes.slice(0, 3), ...messageIndexes.slice(-10)]);
    const elided = messageIndexes.length - 13;
    const firstElided = messageIndexes[3];
    items = items.flatMap((item, index) => {
      if (item.type !== "message" || keep.has(index)) return [item];
      return index === firstElided ? [{ type: "elided", text: `[… ${elided} messages elided …]` }] : [];
    });
  }
  if (estimateTokens(render(items)) <= maxTokens) return render(items);
  items = items.map((item) => (item.text.length > 2000 ? { ...item, text: `${item.text.slice(0, 2000)}…` } : item));
  return render(items);
}

// ---------------------------------------------------------------------------
// Whole client pipeline: files → upload body (used by the CLI and browser)

export async function prepareTraceUpload({ main, subagents = [], title, revisionId = null, importer, noAttachments = false }) {
  const format = detectFormat(main.records);
  const normalized = await normalize({ format, main, subagents });
  const maskedEvents = await maskEvents(normalized.events);
  const maskedAttachments = await maskAttachments(normalized.attachments, maskedEvents.events);
  let events = truncateEvents(maskedAttachments.events);
  let attachments = maskedAttachments.attachments;
  let droppedAttachments = 0;
  if (noAttachments) {
    const dropped = dropAttachments(events);
    events = dropped.events;
    droppedAttachments = dropped.dropped;
    attachments = [];
  }
  const firstPrompt = events.find((event) => event.kind === "user_message" && event.agent === "main" && firstLine(event.text, 80))?.text;
  const resolvedTitle = (title || firstLine(firstPrompt, 80) || "Agent session").trim().slice(0, TRACE_LIMITS.titleChars);
  const count = maskedEvents.count + maskedAttachments.count;
  const kinds = mergeKinds(mergeKinds({}, maskedEvents.kinds), maskedAttachments.kinds);
  const upload = await buildUpload({
    normalized,
    title: resolvedTitle,
    revisionId,
    source: { harness: format, harnessVersion: normalized.harnessVersion ? String(normalized.harnessVersion).slice(0, 64) : null, importer: importer ?? null },
    events,
    attachments,
    droppedAttachments,
    clientMasking: { coreVersion: CORE_VERSION, count, kinds },
  });
  return { upload, format, masked: { count, kinds }, attachments };
}
