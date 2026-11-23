// Types for protocol.js: the wire shapes every transport and every reader
// (the MCP server, the hooks, the Shiplet dashboard) share.

export const PROTOCOL: "shiplet.handshake/v1";
export const LIMITS: Readonly<{
  textBytes: number;
  inboxMessages: number;
  nameChars: number;
  fieldChars: number;
  maxWaitMs: number;
  roomTranscript: number;
}>;
export const KINDS: readonly PeerKind[];
export const PERSON_KIND: "person";
export const RELAY_KINDS: readonly PeerKind[];
export const PEER_NOTICE: string;

// "person" is a person at a Shiplet page; only the hosted relay admits it.
export type PeerKind = "claude" | "codex" | "other" | "person";

// One live agent session. Identity is descriptive, not authenticated.
export interface Peer {
  id: string;
  name: string;
  kind: PeerKind;
  // claude-desktop, claude-cli, codex-app, codex-cli, ...
  app: string;
  machine: string | null;
  // The harness session or thread id, when known.
  session: string | null;
  cwd: string | null;
  pid: number | null;
  connectedAt: string;
  // Set by the hosted relay: the Shiplet account the agent acts for.
  account?: string | null;
}

// The sender identity stamped on every message and kept per handshake member.
export type Sender = Pick<Peer, "id" | "name" | "kind" | "app" | "machine" | "session" | "cwd" | "account">;

// The Shiplet annotation a handshake was opened for. Ids and a label only.
export interface HandshakeRequestRef {
  shiplet: string;
  feedback: string;
  label: string | null;
}

export interface Message {
  id: string;
  // The handshake (room) id, "hs_...".
  room: string;
  from: Sender;
  to: Pick<Peer, "id" | "name" | "kind">;
  text: string;
  at: string;
}

// Hub#handshakes(): what an observer can see of one live handshake.
export interface HandshakeSnapshot {
  id: string;
  createdAt: string;
  topic: string | null;
  request: HandshakeRequestRef | null;
  // True once any sender passed record: true. Only then are messages kept.
  record: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  // Everyone who has been in it; `live` is false once they have left.
  members: Array<Sender & { live: boolean }>;
  // The recorded messages, or null when the handshake is not recorded.
  transcript: Message[] | null;
}

export class ProtocolError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export function newId(prefix: string): string;
export function normalizeTopic(value: unknown): string | null;
export function normalizeRequest(value: unknown): HandshakeRequestRef | null;
export function formatForModel(messages: Message[]): string;
