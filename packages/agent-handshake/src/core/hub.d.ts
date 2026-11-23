// Types for hub.js, the transport-neutral handshake hub.
import type { HandshakeSnapshot, Message, Peer, PeerKind, Sender } from "./protocol.js";

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
    // Peer kinds this host admits; others register as "other". Defaults to KINDS (no "person").
    kinds?: readonly PeerKind[];
  });
  stats(): { connections: number; peers: number; rooms: number };
  handshakes(): HandshakeSnapshot[];
  findPeer(ref: string): Peer | null;
  roomMembers(roomId: string): Sender[] | null;
  open(): HubConnection;
}
