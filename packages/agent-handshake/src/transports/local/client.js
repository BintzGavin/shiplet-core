// Transport #1, client side: newline-delimited JSON over a unix socket.
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handshakeDir, ensureDir, socketPath } from "./paths.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/shiplet-handshake.js");

export function connectUnix(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(new UnixTransport(socket));
    });
  });
}

class UnixTransport {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.inflight = new Map();
    this.closeCallbacks = [];
    this.closed = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.inflight.get(msg.id);
        if (!pending) continue;
        this.inflight.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message);
          err.code = msg.error.code;
          pending.reject(err);
        } else pending.resolve(msg.result);
      }
    });
    const onGone = () => {
      if (this.closed) return;
      this.closed = true;
      for (const { reject } of this.inflight.values()) {
        const err = new Error("shiplet-handshake broker connection closed");
        err.code = "disconnected";
        reject(err);
      }
      this.inflight.clear();
      for (const cb of this.closeCallbacks) cb();
    };
    socket.on("close", onGone);
    socket.on("error", onGone);
  }
  request(op, args) {
    if (this.closed) {
      const err = new Error("shiplet-handshake broker connection closed");
      err.code = "disconnected";
      return Promise.reject(err);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, op, args }) + "\n");
    });
  }
  onClose(cb) {
    this.closeCallbacks.push(cb);
  }
  close() {
    this.socket.end();
    this.socket.destroy();
  }
}

// Connect to the broker, starting it detached if nobody is listening. Hooks pass
// start=false: with no broker there is nobody to hear from, so they exit quietly.
export async function connectLocal({ env = process.env, start = true, timeoutMs = 4000 } = {}) {
  const dir = handshakeDir(env);
  const sock = socketPath(dir);
  try {
    return await connectUnix(sock);
  } catch (err) {
    if (!start || !["ENOENT", "ECONNREFUSED"].includes(err.code)) throw err;
  }
  ensureDir(dir);
  const child = spawn(process.execPath, [BIN, "broker"], { detached: true, stdio: "ignore", env });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  let delay = 25;
  for (;;) {
    try {
      return await connectUnix(sock);
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`shiplet-handshake broker did not start at ${sock}: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}
