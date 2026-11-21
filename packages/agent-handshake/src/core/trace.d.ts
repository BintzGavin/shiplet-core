// Types for trace.js: a recorded handshake as a shiplet.trace/v1 file.
import type { HandshakeRequestRef, Message, Sender } from "./protocol.js";

export const TRACE_FORMAT: "shiplet.trace/v1";
export const HARNESS: "agent-handshake";

export interface HandshakeExport {
  room: { id: string; createdAt: string; topic: string | null; request: HandshakeRequestRef | null; members: Sender[] };
  self: Sender;
  messages: Message[];
}

export function toShipletTrace(exported: HandshakeExport, options?: { version?: string | null }): string;
