// Client side of the protocol, written against a minimal transport interface so
// the MCP server and hooks do not care where the hub runs.
//
// interface Transport {
//   request(op: string, args: object): Promise<object>  // rejects with err.code set
//   close(): void
//   onClose(callback: () => void): void
// }
//
// Transport #1 is the local unix-socket broker (src/transports/local). The
// hosted relay (src/transports/relay) is not a Transport: the MCP server keeps
// its local registration and passes relay messages to `inject`.
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
  // Hand messages received from the hosted relay to this connection's own
  // peer, so waiting hooks and read_inbox deliver them like local ones.
  inject(messages) {
    return this.transport.request("inject", { messages });
  }
  close() {
    this.transport.close();
  }
}
