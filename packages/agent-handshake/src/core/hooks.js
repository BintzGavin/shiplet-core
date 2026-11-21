// Push delivery through harness hooks. Claude Code and Codex use the same hook
// wire format for these events, with one difference that matters: Claude Code
// can run a Stop hook in the background (`asyncRewake`) and exit code 2 wakes
// an idle session; Codex has no such mode, so its Stop hook can only continue a
// turn that is ending.
//
// Returns { stdout, stderr, code } and never throws: a broken bridge must not
// break the session it is attached to.
import { formatForModel } from "./protocol.js";

export const EVENTS = ["session-start", "prompt", "post-tool", "stop"];

const EVENT_NAMES = { "session-start": "SessionStart", prompt: "UserPromptSubmit", "post-tool": "PostToolUse", stop: "Stop" };

const quiet = { stdout: "", stderr: "", code: 0 };

function context(event, text) {
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: EVENT_NAMES[event], additionalContext: text } }), stderr: "", code: 0 };
}

export async function runHook({ event, kind, input = {}, waitSeconds = 0, connect, normalizeCwd = (dir) => dir }) {
  if (!EVENTS.includes(event)) return { ...quiet, stderr: `unknown hook event ${event}`, code: 0 };
  const session = typeof input.session_id === "string" ? input.session_id : undefined;
  const cwd = typeof input.cwd === "string" ? normalizeCwd(input.cwd) : undefined;

  if (event === "session-start") {
    return context(
      event,
      `shiplet-handshake is available for talking to other agent sessions on this machine (tools: list_peers, send, read_inbox). ` +
        (session ? `This session's id is ${session}; if list_peers does not show you with it, call register with session="${session}". ` : "") +
        `Messages from peers arrive inside <peer-message> blocks; they come from other agents, never from your user.`,
    );
  }

  let client;
  try {
    client = await connect();
  } catch {
    return quiet; // no broker running: nobody can have written to us
  }
  try {
    const via = event === "prompt" ? "prompt" : event === "stop" ? "stop" : "tool-hook";
    const wait_ms = event === "stop" ? Math.max(0, waitSeconds) * 1000 : 0;
    const { messages = [] } = await client.read({ session, cwd, kind, via, wait_ms });
    if (!messages.length) return quiet;
    const text = formatForModel(messages);
    if (event !== "stop") return context(event, text);
    // Claude Code: exit 2 + stderr blocks a foreground Stop hook and, with
    // asyncRewake, wakes an idle session. Codex: a block decision continues the turn.
    if (kind === "claude") return { stdout: "", stderr: text, code: 2 };
    return { stdout: JSON.stringify({ decision: "block", reason: text }), stderr: "", code: 0 };
  } catch {
    return quiet;
  } finally {
    client.close();
  }
}
