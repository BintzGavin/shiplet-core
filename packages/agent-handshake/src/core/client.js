// Client side of the protocol, written against a minimal transport interface so
// the MCP server and hooks do not care where the hub runs.
//
// interface Transport {
//   request(op: string, args: object): Promise<object>  // rejects with err.code set
//   close(): void
//   onClose(callback: () => void): void
// }
//
// Transport #1 is the local unix-socket broker (src/transports/local). A future
// remote relay (HTTPS/WebSocket to one hosted room per handshake) only needs to
// implement the same three members and speak the same ops.
export class HandshakeClient {
  constructor(transport) {
    this.transport = transport;
  }
  register(peer) {
    return this.transport.request("register", peer);
  }
  whoami() {
    return this.transport.request("whoami", {});
  }
  peers() {
    return this.transport.request("peers", {});
  }
  send({ to, text, room, record, topic, request }) {
    return this.transport.request("send", { to, text, room, record, topic, request });
  }
  // Own inbox when registered; a hook instead passes { session, cwd, kind }.
  read({ wait_ms = 0, via = "tool", session, cwd, kind, max } = {}) {
    return this.transport.request("read", { wait_ms, via, session, cwd, kind, max });
  }
  export(room) {
    return this.transport.request("export", { room });
  }
  close() {
    this.transport.close();
  }
}
