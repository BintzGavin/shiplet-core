// Transport #1, server side: one Hub behind a unix socket in a 0700 directory.
// No network listener. The broker exits on its own once no client has been
// connected for `idleMs`, and removes its socket file when it goes.
import fs from "node:fs";
import net from "node:net";
import { Hub } from "../../core/hub.js";
import { handshakeDir, ensureDir, socketPath } from "./paths.js";
import { connectUnix } from "./client.js";

const MAX_LINE = 256 * 1024;

function openLog(file) {
  if (!file) return null;
  const fd = fs.openSync(file, "a", 0o600);
  return (message) => fs.writeSync(fd, JSON.stringify(message) + "\n");
}

async function listen(server, sock) {
  const attempt = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await attempt();
  } catch (err) {
    if (err.code !== "EADDRINUSE") throw err;
    // A live broker already owns the socket: let it be.
    try {
      const probe = await connectUnix(sock);
      probe.close();
      return false;
    } catch {
      fs.rmSync(sock, { force: true }); // stale socket left by a crash
      await attempt();
    }
  }
  return true;
}

export async function startBroker({ env = process.env, idleMs = Number(env.SHIPLET_HANDSHAKE_IDLE_MS) || 30_000 } = {}) {
  const dir = ensureDir(handshakeDir(env));
  const sock = socketPath(dir);
  const hub = new Hub({
    maxAutoTurns: Number(env.SHIPLET_HANDSHAKE_MAX_AUTO_TURNS) || 25,
    onMessage: openLog(env.SHIPLET_HANDSHAKE_LOG), // opt-in; nothing is written without it
  });
  let idleTimer = null;
  const server = net.createServer((socket) => {
    const conn = hub.open();
    noteActivity();
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
        socket.destroy();
        return;
      }
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    const handleLine = async (line) => {
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      let reply;
      try {
        reply = { id: req.id, result: await conn.handle(req.op, req.args) };
      } catch (err) {
        reply = { id: req.id, error: { code: err.code || "internal", message: err.message } };
      }
      if (!socket.destroyed) socket.write(JSON.stringify(reply) + "\n");
    };
    socket.on("close", () => {
      conn.close();
      noteActivity();
    });
    socket.on("error", () => socket.destroy());
  });

  if (!(await listen(server, sock))) return null;
  fs.chmodSync(sock, 0o600);
  const ino = fs.statSync(sock).ino;

  function noteActivity() {
    clearTimeout(idleTimer);
    if (hub.stats().connections === 0) idleTimer = setTimeout(stop, idleMs);
  }
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    server.close();
    // Remove the socket only if it is still ours (another broker may own the path now).
    try {
      if (fs.statSync(sock).ino === ino) fs.rmSync(sock, { force: true });
    } catch {}
  }
  noteActivity();
  return { hub, sock, stop, closed: new Promise((r) => server.on("close", r)) };
}
