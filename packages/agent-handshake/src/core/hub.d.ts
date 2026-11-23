// Types for hub.js, the transport-neutral handshake hub.
import type { HandshakeSnapshot, Message, Peer, PeerKind, Sender } from "./protocol.js";

export interface HubConnection {
  id: string;
  handle(op: "ping" | "register" | "whoami" | "peers" | "send" | "read" | "export" | "inject", args?: Record<string, unknown>): Promise<any>;
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
  // A restored connection's handle, or null when it is not part of this hub.
  reopen(connId: string): HubConnection | null;
  // Plain JSON a host can store and pass to restore() after a restart.
  snapshot(): HubSnapshot;
  restore(snapshot: HubSnapshot): void;
}

export interface HubSnapshot {
  peers: Array<Record<string, unknown> & { id: string; inbox: Message[] }>;
  rooms: Array<Record<string, unknown> & { id: string; members: Sender[]; live: string[]; transcript: Message[] }>;
  conns: Array<{ id: string; peerId: string }>;
}
