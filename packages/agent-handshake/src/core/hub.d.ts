// Types for hub.js, the transport-neutral handshake hub.
import type { HandshakeSnapshot, Message } from "./protocol.js";

export interface HubConnection {
  id: string;
  handle(op: "ping" | "register" | "whoami" | "peers" | "send" | "read" | "export", args?: Record<string, unknown>): Promise<any>;
  close(): void;
}

export class Hub {
  constructor(options?: {
    now?: () => Date;
    maxAutoTurns?: number;
    onMessage?: ((message: Message) => void) | null;
    ids?: (prefix: string) => string;
  });
  stats(): { connections: number; peers: number; rooms: number };
  handshakes(): HandshakeSnapshot[];
  open(): HubConnection;
}
