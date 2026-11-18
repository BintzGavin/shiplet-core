// Types for trace-core.mjs, the shared trace module (CLI, Worker, browser).

export const CORE_VERSION: string;
export const TRACE_SCHEMA_VERSION: "shiplet.trace/v1";
export const TRACE_LIMITS: Readonly<{
  textFieldBytes: number;
  truncateKeepBytes: number;
  eventBytes: number;
  segmentEvents: number;
  segmentBytes: number;
  segmentsPerTrace: number;
  canonicalBytes: number;
  attachmentBytes: number;
  attachmentsTotalBytes: number;
  attachmentsPerTrace: number;
  uploadRequestBytes: number;
  organizationQuotaBytes: number;
  personalQuotaBytes: number;
  titleChars: number;
}>;
export const ATTACHMENT_TYPES: readonly string[];
export const EVENT_KINDS: readonly TraceEventKind[];

export type TraceEventKind =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "system_note"
  | "tool_call"
  | "tool_result"
  | "subagent_start"
  | "subagent_end"
  | "omitted";

export interface TraceEvent {
  id: string;
  seq: number;
  t: string | null;
  agent: string;
  kind: TraceEventKind;
  text?: string;
  reason?: string;
  tool?: { name: string; callId: string; input: Record<string, unknown>; inputSummary?: string };
  result?: { callId: string; isError: boolean; text: string };
  attachmentIds?: string[];
}

export interface TraceAttachment {
  sha256: string;
  mediaType: string;
  bytes: number;
  data: Uint8Array;
  source?: "inline" | "file";
}

export interface MaskCounts {
  count: number;
  kinds: Record<string, number>;
}

export interface TraceSummaryBlock {
  durationSeconds: number | null;
  models: string[];
  promptCount: number;
  toolCounts: Record<string, number>;
  filesTouched: string[];
  checks: Array<{ command: string; ok: boolean }>;
  outcome: "last-check-passed" | "last-check-failed" | "no-checks-run";
  errorCount: number;
}

export interface TraceManifest {
  schemaVersion: "shiplet.trace/v1";
  title: string;
  source: { harness: string; harnessVersion: string | null; importer: string | null };
  startedAt: string | null;
  endedAt: string | null;
  models: string[];
  cwdLabel: string | null;
  agents: Array<{ id: string; title: string }>;
  counts: {
    events: number;
    toolCalls: number;
    errors: number;
    attachments: number;
    skippedLines: number;
    droppedAttachments: number;
  };
  summary: TraceSummaryBlock;
  segments: Array<{ index: number; firstSeq: number; lastSeq: number; events: number; bytes: number; sha256: string }>;
  attachments: Array<{ sha256: string; mediaType: string; bytes: number; source: string }>;
  masking: {
    coreVersion: string;
    clientCount: number;
    clientKinds: Record<string, number>;
    serverCount: number;
    serverKinds: Record<string, number>;
  };
}

export interface TraceUpload {
  schemaVersion: "shiplet.trace/v1";
  revisionId?: string | null;
  title: string;
  source: { harness: "claude-code" | "codex"; harnessVersion?: string | null; importer?: string | null };
  cwd?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  models: string[];
  skippedLines?: number;
  droppedAttachments?: number;
  clientMasking: { coreVersion: string; count: number; kinds: Record<string, number> };
  events: TraceEvent[];
  attachments: Array<{ sha256: string; mediaType: string; bytes: number; base64: string }>;
}

export class TraceFormatError extends Error {}

export function parseJsonl(text: string): { records: Array<Record<string, unknown>>; skippedLines: number };
export function detectFormat(records: Array<Record<string, unknown>>): "claude-code" | "codex";
export function normalize(input: {
  format: "claude-code" | "codex";
  main: { fileName?: string; records: Array<Record<string, unknown>>; skippedLines: number };
  subagents?: Array<{ fileName?: string; records: Array<Record<string, unknown>>; skippedLines: number }>;
}): Promise<{
  events: TraceEvent[];
  attachments: TraceAttachment[];
  cwd: string | null;
  startedAt: string | null;
  endedAt: string | null;
  models: string[];
  harnessVersion: string | null;
  skippedLines: number;
}>;
export function maskSecrets(text: string): { text: string } & MaskCounts;
export function maskEvents(events: TraceEvent[]): Promise<{ events: TraceEvent[] } & MaskCounts>;
export function maskAttachments(
  attachments: TraceAttachment[],
  events: TraceEvent[],
): Promise<{ attachments: TraceAttachment[]; events: TraceEvent[] } & MaskCounts>;
export function truncateEvents(events: TraceEvent[]): TraceEvent[];
export function dropAttachments(events: TraceEvent[]): { events: TraceEvent[]; dropped: number };
export function inputSummary(tool: TraceEvent["tool"]): string;
export function isCheckCommand(command: string): boolean;
export function buildSummary(
  events: TraceEvent[],
  options?: { cwd?: string | null; models?: string[]; startedAt?: string | null; endedAt?: string | null },
): TraceSummaryBlock;
export function segmentEvents(events: TraceEvent[]): Array<{
  index: number;
  ndjson: string;
  events: number;
  bytes: number;
  firstSeq: number;
  lastSeq: number;
}>;
export function finalizeTrace(input: {
  events: TraceEvent[];
  attachments?: TraceAttachment[];
  cwd?: string | null;
  title: string;
  source: TraceManifest["source"];
  startedAt?: string | null;
  endedAt?: string | null;
  models?: string[];
  skippedLines?: number;
  droppedAttachments?: number;
  masking?: { clientCount?: number; clientKinds?: Record<string, number>; serverCount?: number; serverKinds?: Record<string, number> };
}): Promise<{ manifest: TraceManifest; segments: Array<{ index: number; ndjson: string }>; events: TraceEvent[] }>;
export function validateUpload(upload: unknown): Promise<{ ok: true } | { ok: false; errors: Array<{ path: string; message: string }> }>;
export function decodeUploadAttachments(upload: TraceUpload): TraceAttachment[];
export function buildContext(
  manifest: TraceManifest,
  events: TraceEvent[],
  options?: { level?: string; maxTokens?: number },
): string;
export function sha256Hex(data: string | Uint8Array): Promise<string>;
export function bytesToBase64(bytes: Uint8Array): string;
export function prepareTraceUpload(input: {
  main: { fileName?: string; records: Array<Record<string, unknown>>; skippedLines: number };
  subagents?: Array<{ fileName?: string; records: Array<Record<string, unknown>>; skippedLines: number }>;
  title?: string;
  revisionId?: string | null;
  importer?: string;
  noAttachments?: boolean;
}): Promise<{ upload: TraceUpload; format: "claude-code" | "codex"; masked: MaskCounts; attachments: TraceAttachment[] }>;
