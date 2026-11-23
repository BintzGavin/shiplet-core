// The transport-neutral broker. It keeps live peers, their inboxes and any
// waiting readers in memory only. A transport (the local unix socket today, a
// hosted relay later) opens one connection per client and forwards requests to
// `connection.handle(op, args)`. When a connection closes, the peer it
// registered disappears together with its undelivered messages.
import {
  KINDS,
  RELAY_KINDS,
  checkField,
  LIMITS,
  ProtocolError,
  checkText,
  clampWait,
  newId,
  normalizePeer,
  normalizeRequest,
  normalizeTopic,
  publicPeer,
  senderOf,
} from "./protocol.js";

export class Hub {
  // `ids` makes ids predictable (tests, the dashboard's sample handshakes).
  // `kinds` lists the peer kinds this host admits; anything else registers as
  // "other". Only a host that authenticates people adds "person".
  constructor({ now = () => new Date(), maxAutoTurns = 25, onMessage = null, ids = newId, kinds = KINDS } = {}) {
    this.now = now;
    this.kinds = kinds;
    this.newId = ids;
    this.maxAutoTurns = maxAutoTurns;
    this.onMessage = onMessage; // optional log sink; off by default
    this.peers = new Map(); // peerId -> peer
    this.conns = new Map(); // connId -> { peerId, waiters:Set }
    this.pending = new Set(); // selector waiters whose peer has not registered yet
    this.rooms = new Map(); // roomId -> room
    this.dmRooms = new Map(); // "idA|idB" -> roomId
  }

  stats() {
    return { connections: this.conns.size, peers: this.peers.size, rooms: this.rooms.size };
  }

  // A read-only view of every live handshake, for an observer such as the
  // Shiplet dashboard (a person watching, not a peer). Messages are included
  // only for handshakes being recorded: an unrecorded handshake keeps no
  // messages, so there is nothing to show beyond who is in it and a count.
  handshakes() {
    return [...this.rooms.values()].map((room) => ({
      id: room.id,
      createdAt: room.createdAt,
      topic: room.topic,
      request: room.request,
      record: room.record,
      messageCount: room.messageCount,
      lastMessageAt: room.lastMessageAt,
      members: [...room.members.values()].map((member) => ({ ...member, live: room.live.has(member.id) })),
      transcript: room.record ? room.transcript.slice() : null,
    }));
  }

  // Read-only lookups for a host that enforces its own rules (the relay).
  findPeer(ref) {
    const peer = this.peers.get(ref) ?? [...this.peers.values()].find((p) => p.name === ref);
    return peer ? publicPeer(peer) : null;
  }

  roomMembers(roomId) {
    const room = this.rooms.get(roomId);
    return room ? [...room.members.values()] : null;
  }

  open() {
    const connId = this.newId("conn");
    const conn = { id: connId, peerId: null, waiters: new Set() };
    this.conns.set(connId, conn);
    return this.#connection(conn);
  }

  // The handle of a connection that survived a restore, or null.
  reopen(connId) {
    const conn = this.conns.get(connId);
    return conn ? this.#connection(conn) : null;
  }

  #connection(conn) {
    return {
      id: conn.id,
      handle: (op, args = {}) => this.#handle(conn, op, args ?? {}),
      close: () => this.#close(conn),
    };
  }

  // Everything a host needs to bring this hub back after a restart, as plain
  // JSON: peers with their queued messages, handshakes, and the connections
  // that registered a peer. Waiting readers are not included; they belong to
  // requests that ended with the restart.
  snapshot() {
    return {
      peers: [...this.peers.values()].map(({ waiter: _waiter, ...peer }) => ({ ...peer, inbox: peer.inbox.slice() })),
      rooms: [...this.rooms.values()].map((room) => ({
        ...room,
        members: [...room.members.values()],
        live: [...room.live],
        transcript: room.transcript.slice(),
      })),
      conns: [...this.conns.values()].filter((conn) => conn.peerId).map((conn) => ({ id: conn.id, peerId: conn.peerId })),
    };
  }

  restore({ peers = [], rooms = [], conns = [] } = {}) {
    this.peers.clear();
    this.conns.clear();
    this.pending.clear();
    this.rooms.clear();
    this.dmRooms.clear();
    for (const peer of peers) this.peers.set(peer.id, { ...peer, inbox: peer.inbox.slice(), waiter: null });
    for (const room of rooms) {
      this.rooms.set(room.id, {
        ...room,
        members: new Map(room.members.map((member) => [member.id, member])),
        live: new Set(room.live),
        transcript: room.transcript.slice(),
      });
      if (room.dmKey) this.dmRooms.set(room.dmKey, room.id);
    }
    for (const conn of conns) if (this.peers.has(conn.peerId)) this.conns.set(conn.id, { id: conn.id, peerId: conn.peerId, waiters: new Set() });
  }

  async #handle(conn, op, args) {
    switch (op) {
      case "ping":
        return { ok: true };
      case "register":
        return { peer: publicPeer(this.#register(conn, args)) };
      case "whoami":
        return { peer: conn.peerId ? publicPeer(this.peers.get(conn.peerId)) : null };
      case "peers":
        return { self: conn.peerId, peers: [...this.peers.values()].map(publicPeer) };
      case "send":
        return this.#send(conn, args);
      case "read":
        return this.#read(conn, args);
      case "export":
        return this.#export(conn, args);
      case "inject":
        return this.#inject(conn, args);
      default:
        throw new ProtocolError("bad_request", `unknown op ${JSON.stringify(op)}`);
    }
  }

  #register(conn, args) {
    const fields = normalizePeer(args, this.kinds);
    let peer = conn.peerId ? this.peers.get(conn.peerId) : null;
    fields.name = this.#uniqueName(fields.name, peer?.id);
    if (peer) {
      Object.assign(peer, fields);
    } else {
      peer = { ...fields, id: this.newId("peer"), connectedAt: this.now().toISOString(), inbox: [], waiter: null, autoTurns: 0 };
      this.peers.set(peer.id, peer);
      conn.peerId = peer.id;
    }
    for (const waiter of [...this.pending]) {
      if (this.#pick(waiter.selector, [peer])) {
        this.pending.delete(waiter);
        this.#attachWaiter(peer, waiter);
      }
    }
    return peer;
  }

  #uniqueName(name, selfId) {
    const taken = (candidate) => [...this.peers.values()].some((p) => p.name === candidate && p.id !== selfId);
    if (!taken(name)) return name;
    for (let n = 2; ; n++) if (!taken(`${name}-${n}`)) return `${name}-${n}`;
  }

  #self(conn) {
    const peer = conn.peerId && this.peers.get(conn.peerId);
    if (!peer) throw new ProtocolError("not_registered", "register before sending");
    return peer;
  }

  #find(ref) {
    if (typeof ref !== "string" || !ref) throw new ProtocolError("bad_request", "to is required");
    const byId = this.peers.get(ref);
    if (byId) return byId;
    const byName = [...this.peers.values()].find((p) => p.name === ref);
    if (byName) return byName;
    throw new ProtocolError("not_found", `no live peer named ${JSON.stringify(ref)}; call list_peers`);
  }

  #room(from, to, roomId, record, about) {
    let room;
    if (roomId) {
      room = this.rooms.get(roomId);
      if (!room) throw new ProtocolError("not_found", `no live handshake ${JSON.stringify(roomId)}`);
    } else {
      const key = [from.id, to.id].sort().join("|");
      room = this.rooms.get(this.dmRooms.get(key));
      if (!room) {
        room = {
          id: this.newId("hs"),
          createdAt: this.now().toISOString(),
          members: new Map(),
          live: new Set(),
          record: false,
          transcript: [],
          dmKey: key,
          topic: null,
          request: null,
          messageCount: 0,
          lastMessageAt: null,
        };
        this.rooms.set(room.id, room);
        this.dmRooms.set(key, room.id);
      }
    }
    for (const peer of [from, to]) {
      room.members.set(peer.id, senderOf(peer));
      room.live.add(peer.id);
    }
    if (record) room.record = true;
    if (about.topic) room.topic = about.topic;
    if (about.request) room.request = about.request;
    return room;
  }

  #send(conn, args) {
    const from = this.#self(conn);
    const text = checkText(args.text);
    const about = { topic: normalizeTopic(args.topic), request: normalizeRequest(args.request) };
    const to = this.#find(args.to);
    if (to.id === from.id) throw new ProtocolError("bad_request", "cannot send to yourself");
    const room = this.#room(from, to, args.room ?? null, args.record === true, about);
    const message = {
      id: this.newId("msg"),
      room: room.id,
      from: senderOf(from),
      to: { id: to.id, name: to.name, kind: to.kind },
      text,
      at: this.now().toISOString(),
    };
    room.messageCount++;
    room.lastMessageAt = message.at;
    if (room.record) {
      room.transcript.push(message);
      if (room.transcript.length > LIMITS.roomTranscript) room.transcript.shift();
    }
    this.onMessage?.(message);
    const handed = this.#deliver(to, message);
    return { id: message.id, room: room.id, at: message.at, to: message.to, status: handed ? "delivered" : "queued", recorded: room.record };
  }

  #deliver(peer, message) {
    if (peer.waiter) {
      const waiter = peer.waiter;
      peer.waiter = null;
      this.#finish(waiter, peer, [message]);
      return true;
    }
    peer.inbox.push(message);
    if (peer.inbox.length > LIMITS.inboxMessages) peer.inbox.shift();
    return false;
  }

  // Hooks do not register; they name the session they run in. Match on the
  // session id first, then on a single live peer of the same kind in the same
  // cwd that has no session id of its own (Codex does not always expose one).
  #pick(selector, peers) {
    if (selector.session) {
      const exact = peers.find((p) => p.session === selector.session);
      if (exact) return exact;
    }
    if (selector.cwd) {
      const same = [...this.peers.values()].filter(
        (p) => p.cwd === selector.cwd && (!selector.kind || p.kind === selector.kind) && (!p.session || !selector.session),
      );
      if (same.length === 1 && peers.includes(same[0])) return same[0];
    }
    return null;
  }

  #resolve(conn, args) {
    if (!args.session && !args.cwd) {
      if (!conn.peerId) throw new ProtocolError("not_registered", "register first, or name a session");
      return this.peers.get(conn.peerId);
    }
    return this.#pick({ session: args.session, cwd: args.cwd, kind: args.kind }, [...this.peers.values()]);
  }

  #read(conn, args) {
    const via = ["tool", "prompt", "stop", "tool-hook"].includes(args.via) ? args.via : "tool";
    const waitMs = clampWait(args.wait_ms);
    const max = Number.isInteger(args.max) && args.max > 0 ? args.max : 50;
    const peer = this.#resolve(conn, args);
    if (peer) {
      if (via === "prompt") peer.autoTurns = 0;
      if (via === "stop" && peer.autoTurns >= this.maxAutoTurns) {
        return { peer: publicPeer(peer), messages: [], capped: true, queued: peer.inbox.length };
      }
      if (peer.inbox.length) {
        const messages = peer.inbox.splice(0, max);
        if (via === "stop") peer.autoTurns++;
        return { peer: publicPeer(peer), messages, queued: peer.inbox.length };
      }
    }
    if (!waitMs) return { peer: peer ? publicPeer(peer) : null, messages: [], queued: 0 };
    return new Promise((resolve) => {
      const waiter = { conn, resolve, via, selector: { session: args.session ?? null, cwd: args.cwd ?? null, kind: args.kind ?? null }, timer: null };
      waiter.timer = setTimeout(() => {
        const owner = this.#waiterPeer(waiter);
        if (owner) owner.waiter = null;
        this.pending.delete(waiter);
        conn.waiters.delete(waiter);
        resolve({ peer: owner ? publicPeer(owner) : null, messages: [], queued: owner?.inbox.length ?? 0, timedOut: true });
      }, waitMs);
      conn.waiters.add(waiter);
      if (peer) this.#attachWaiter(peer, waiter);
      else this.pending.add(waiter);
    });
  }

  #waiterPeer(waiter) {
    for (const peer of this.peers.values()) if (peer.waiter === waiter) return peer;
    return null;
  }

  // One waiting reader per peer: a newer wait (for example the next Stop hook)
  // replaces an older one, which returns empty and marked superseded.
  #attachWaiter(peer, waiter) {
    if (peer.inbox.length) {
      this.#finish(waiter, peer, peer.inbox.splice(0, 50));
      return;
    }
    if (peer.waiter) {
      const old = peer.waiter;
      peer.waiter = null;
      clearTimeout(old.timer);
      old.conn.waiters.delete(old);
      old.resolve({ peer: publicPeer(peer), messages: [], queued: 0, superseded: true });
    }
    peer.waiter = waiter;
  }

  #finish(waiter, peer, messages) {
    clearTimeout(waiter.timer);
    waiter.conn.waiters.delete(waiter);
    if (waiter.via === "stop") peer.autoTurns++;
    waiter.resolve({ peer: publicPeer(peer), messages, queued: peer.inbox.length });
  }

  #export(conn, args) {
    const self = this.#self(conn);
    const room = this.rooms.get(args.room);
    if (!room || !room.members.has(self.id)) throw new ProtocolError("not_found", `no live handshake ${JSON.stringify(args.room)} that you are part of`);
    if (!room.record) throw new ProtocolError("not_recorded", "this handshake was not recorded; send with record=true to start recording it");
    return {
      room: { id: room.id, createdAt: room.createdAt, topic: room.topic, request: room.request, members: [...room.members.values()] },
      self: senderOf(self),
      messages: room.transcript.slice(),
    };
  }

  // A transport bridged to the hosted relay hands relay messages to its own
  // peer, so hooks deliver them like local ones. They are marked via "relay",
  // keep the relay's ids, and never join a local handshake.
  #inject(conn, args) {
    const self = this.#self(conn);
    if (!Array.isArray(args.messages) || args.messages.length > 50) {
      throw new ProtocolError("bad_request", "messages must be a list of at most 50 relay messages");
    }
    const messages = args.messages.map((m) => {
      if (!m || typeof m !== "object" || !m.from || typeof m.from !== "object") throw new ProtocolError("bad_request", "each message needs from");
      return {
        id: checkField(m.id, "id", { max: 128, optional: false }),
        room: checkField(m.room, "room", { max: 128, optional: false }),
        from: {
          id: checkField(m.from.id, "from.id", { max: 128, optional: false }),
          name: checkField(m.from.name, "from.name", { max: LIMITS.nameChars, optional: false }),
          kind: RELAY_KINDS.includes(m.from.kind) ? m.from.kind : "other",
          app: checkField(m.from.app, "from.app", { max: 64 }),
          machine: checkField(m.from.machine, "from.machine", { max: 255 }),
          session: null,
          cwd: null,
          account: checkField(m.from.account, "from.account", { max: 255 }),
        },
        to: { id: self.id, name: self.name, kind: self.kind },
        text: checkText(m.text),
        at: typeof m.at === "string" && m.at.length <= 64 ? m.at : this.now().toISOString(),
        via: "relay",
      };
    });
    for (const message of messages) this.#deliver(self, message);
    return { injected: messages.length };
  }

  #close(conn) {
    if (!this.conns.delete(conn.id)) return;
    for (const waiter of conn.waiters) {
      clearTimeout(waiter.timer);
      this.pending.delete(waiter);
      const owner = this.#waiterPeer(waiter);
      if (owner) owner.waiter = null;
    }
    conn.waiters.clear();
    const peer = conn.peerId && this.peers.get(conn.peerId);
    if (!peer) return;
    this.peers.delete(peer.id);
    if (peer.waiter) {
      const waiter = peer.waiter;
      peer.waiter = null;
      clearTimeout(waiter.timer);
      waiter.conn.waiters.delete(waiter);
      waiter.resolve({ peer: publicPeer(peer), messages: [], queued: 0, gone: true });
    }
    peer.inbox.length = 0; // undelivered messages die with the peer
    for (const room of [...this.rooms.values()]) {
      room.live.delete(peer.id);
      if (room.live.size === 0) {
        this.rooms.delete(room.id);
        if (room.dmKey) this.dmRooms.delete(room.dmKey);
      }
    }
  }
}
