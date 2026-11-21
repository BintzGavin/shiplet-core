# Traces: user flows

How people and agents use traces and artifacts together, end to end. Shiplet
is where teams share what their agents made and how they made it, with access
set per audience, across every agent. The design and its decisions are in
[traces-spec.md](./traces-spec.md). The public guide is `docs/traces.mdx`
(under Start in `docs.json`), and the format any agent can write is
`docs/trace-format.mdx`.

| Flow | Status |
| --- | --- |
| 1. Share from inside the agent | Shipped (Claude Code and Codex via `--current`; MCP-only agents via an upload link) |
| 2. Share a file from the dashboard | Shipped |
| 3. Choose who sees what | Shipped (CLI, MCP, and dashboard) |
| 4. A colleague reads it in the browser | Shipped |
| 5. A colleague pulls it without the dashboard | Shipped |
| 6. Change your mind | Shipped |
| 7. Share from any other agent | Open trace format (D20), shipping with this reframe |
| 8. Hand work across agents | Shipped: any MCP or CLI agent can load any trace |
| 9. Share a session with no artifact | Shipped (trace-only Shiplets, D19) |
| 10. Find out which version a comment was about | Shipped (every comment keeps its revision) |

## 1. Share a session from inside the agent (recommended)

The agent already knows which session it is in, including its subagents, so
there is no file to find.

1. Ask the agent: "Share this session to Shiplet `<shiplet>` and give the
   design team Conversation access."
2. The agent runs `shiplet trace share --current --shiplet <id> --revision <id>`.
   Secrets are masked on your machine before anything is sent, and the CLI
   prints what it masked by kind.
3. The trace is private. Only you and the Shiplet owner can see it, not even
   organization admins. Once you share it with anyone, organization admins can
   read it too.
4. Screenshots, videos, and PDFs the session produced in the project are
   attached automatically (`--dry-run` lists them; `--no-files` skips them).
5. The agent adds the audience you named (slice 2: `shiplet trace share`
   accepts `--audience team:<id>=conversation`, repeatable; slice 3 adds the
   same through MCP).
6. The agent replies with the trace link.

Without the CLI, an MCP-only agent creates the trace through Code Mode, gets a
short-lived upload URL, and uploads the file with `curl` (slice 3). The
response includes the server's masking count.

## 2. Share a session file from the dashboard

Use this when the session is not running anymore and you would rather not open
a terminal.

1. Open the Shiplet, then **Traces**, then **Add a trace**.
2. The drop zone opens with this first line:

   > **Easiest: ask your agent.** Say "share this session to Shiplet" in
   > Claude Code or Codex, or run `shiplet trace share --current --shiplet <id>`.
   > [Copy prompt] [Copy command]

3. Below it, drop a Claude Code `.jsonl` file or session folder, or a Codex
   `rollout-*.jsonl`. Where they live:
   - Claude Code: `~/.claude/projects/<project folder>/<session id>.jsonl`.
     Drop the session folder of the same name too, to include subagents.
   - Codex: `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`.
   - On macOS, Finder hides these folders. Press Cmd+Shift+. to show them.
4. The browser masks secrets and shows a preview. Nothing leaves the machine
   until you click **Upload**.
5. Continue with flow 3.

Dragging a session straight out of the Claude Code or Codex desktop sidebar
does not work today, because those apps put no file on the drag. If they add
it, this drop zone accepts it as is.

## 3. Choose who sees what

1. The share screen lists candidate audiences from the Shiplet's grants: people,
   emails, teams, the organization, and anyone with the link. None is enabled.
2. For each audience you enable, pick a level:
   - **Full**: everything except secrets.
   - **Conversation**: messages and the tool steps, without tool output or
     reasoning.
   - **Summary**: what was done, files touched, checks, and the outcome; no text.
   - **Hidden**.
3. Optionally add simple rules: terms to mask, paths to hide, hide reasoning,
   hide videos. Agents can use every rule through the CLI and MCP.
4. Use **Preview as** to see exactly what that audience will see.
5. A more specific audience overrides a broader one. An email or person
   overrides their team, and a team overrides the organization. That is how
   you say "the organization sees Conversation, but contractors see Summary."
6. Images, video, and PDFs are not scanned for secrets. The screen says so next
   to any audience that will see attachments.

## 4. A colleague reads it in the browser

1. The colleague opens the trace link. They need view access to the Shiplet and
   a matching audience; anyone else gets "not found".
2. The header shows the session's source, duration, prompts, files changed, and
   outcome. Below Full it says **the level they are seeing**, and an info button
   lists what that level leaves out.
3. They read each prompt and the agent's final reply. To see how it got there,
   they open the reply's Steps tab: every step in order, with an activity bar
   that lights the step they are reading. Changes shows the diffs and Checks
   shows the test, lint, and build runs. Subagents fold under the step that
   started them, and images and video play inline.
4. When they want to continue the work in their own agent, they pick one of
   two buttons:
   - **Copy prompt for your agent** copies:
     `Load Shiplet trace <trace-id> from Shiplet <shiplet-id> into context and summarize where it left off.`
     An agent connected to Shiplet's MCP calls `getTraceContext` and receives
     the handoff at the colleague's level.
   - **Copy CLI command** copies:
     `shiplet trace pull <trace-id> --shiplet <shiplet-id> --as context`
     which prints the handoff for piping into any agent. Without `--as context`
     it writes `trace.json`, `attachments/`, and `context.md` to a folder.
5. The browser cannot write into a local Claude Code or Codex app, so the
   handoff always goes through the agent or the CLI.

## 5. A colleague pulls it without the dashboard

1. They ask their agent, "What traces are on Shiplet `<shiplet>`?" The agent
   lists them through MCP (`listTraces`). Each trace shows the caller's level,
   and traces they cannot read are not listed.
2. They ask, "Load the checkout trace." The agent calls `getTraceContext` and
   pages through it within its token budget.
3. Or from a terminal: `shiplet trace list --shiplet <id>`, then
   `shiplet trace pull <trace-id> --shiplet <id>`.

## 6. Change your mind

- Change an audience's level or rules at any time. The new variant is rendered
  once, and the old one is deleted when no audience uses it.
- Remove an audience and it gets "not found" at once. Copies already pulled to
  someone's machine stay there, and the share screen says so before you share.
- Delete the trace. The canonical copy, every variant, and every attachment are
  removed. Permanently deleting the Shiplet deletes its traces too.

## 7. Share a session from any other agent

Claude Code and Codex are built in. Any other agent, including one released
after this was written, shares a session by writing the open trace format.

1. The agent (or a small adapter for it) writes its session as a
   `shiplet.trace/v1` JSONL file: a header line naming the agent, then one event
   per line for messages, reasoning, tool calls, tool results, and subagents.
2. It runs `shiplet trace share <file.jsonl> --shiplet <id>`, or sets
   `SHIPLET_TRACE_FILE` so `--current` finds the file. `--dry-run` shows what
   would be sent.
3. Masking, audiences, levels, and the viewer work exactly as in flows 1–4. The
   viewer shows the agent's name from the header.

## 8. Hand work across agents

1. Someone shares a Claude Code session at Conversation level with their team.
2. A teammate working in Codex, or in any agent connected to Shiplet's MCP,
   says "Load Shiplet trace `<trace>` and carry on."
3. The agent calls `getTraceContext` (or runs
   `shiplet trace pull <trace> --shiplet <id> --as context`) and receives the
   handoff at the teammate's level: the goal, what was done, files touched,
   checks, and where it stopped.
4. The new agent continues in its own session. That session can be shared back
   to the same Shiplet, so the work's full history stays in one place.

Native resume (reopening the original session inside the original app) is not
part of this flow.

## 9. Share a session with no artifact

1. Ask the agent to "share this session to a new Shiplet", or run
   `shiplet trace share --current --new --title "Fix the flaky test"`.
2. Shiplet creates an ordinary Shiplet whose page is the trace viewer, with the
   same access, lifecycle, and URLs as any Shiplet.
3. Continue with flow 3.

## 10. Find out which version a comment was about

1. A reviewer leaves a comment on Monday. The agent publishes six revisions
   during the week.
2. Every comment keeps the revision it was left on. The comments panel's
   revision filter shows comments from the current revision or all revisions.
3. The trace for each revision shows what the agent changed in response, so the
   comment, the version it was about, and the fix can be read together.

