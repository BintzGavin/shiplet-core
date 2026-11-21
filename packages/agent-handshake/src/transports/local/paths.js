import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function handshakeDir(env = process.env) {
  return env.SHIPLET_HANDSHAKE_DIR || path.join(os.homedir(), ".shiplet-handshake");
}

export function socketPath(dir) {
  return path.join(dir, "broker.sock");
}

// The directory is the access boundary for the local transport: it must be a
// real directory owned by this user and closed to everyone else.
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} must be a real directory, not a link`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

// Hooks report the cwd as the harness spells it (it may go through a symlink,
// e.g. /var -> /private/var on macOS); compare real paths on both sides.
export function realCwd(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}
