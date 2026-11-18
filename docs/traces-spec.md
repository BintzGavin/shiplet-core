# Traces: portable, access-controlled agent sessions

Status: plan. Nothing here is built yet. Written against `shiplet-core` `main`
at `a7a714d` (2026-10-28) and re-verified there on 2026-11-18. Slice 1 is specified in full; later
slices are outlines that slice 1 will change. User-facing flows are in
[traces-user-flows.md](./traces-user-flows.md).

## Problem and done check

A Shiplet shows what an agent built. It does not show how: the request, the
reasoning, the tool calls, the dead ends, the checks that passed. That session
is the most reusable thing the work produced, and today it is stuck in one
person's `~/.claude` or `~/.codex` folder.

Traces make a full agent session a first-class part of a Shiplet. A session is
uploaded once, secrets are masked before it leaves the machine and again on
ingest, and it is shared with the same audiences Shiplet already uses (a person,
an exact email, a team, the organization, or the link), at a redaction level the
uploader picks for each audience. People with access can read it in the
dashboard and pull it into their own agent with one command or one MCP call.

Done, for the whole feature, when all of these are true:

1. An agent can run `shiplet trace share --current --shiplet <id>` from inside
   a Claude Code or Codex session, and the session, including subagents,
   inline images, and the screenshots and videos it produced, is stored against
   that Shiplet and pinned revision.
2. A credential planted in the session's text, or in a text attachment, never
   reaches Shiplet storage, whether the upload came from the CLI, the dashboard
   drop zone, or a raw API call.
3. The uploader can give one team Summary, one email Full, and the
   organization Conversation, and each person sees exactly that level in the
   dashboard, the CLI, and MCP; anyone else gets a 404.
4. A colleague with access can read the trace in the browser, then run
   `shiplet trace pull <trace-id> --shiplet <id> --as context` or ask their
   agent to load it,
   and receives only what their level allows.

## Non-goals

- Read-time, viewer-dependent redaction based on what the viewer's connectors
  or data access would reveal (the Cloudflare Guardian model). Redaction is
  chosen by the uploader per audience, rendered once, and served as stored.
- Re-creating a native, resumable Claude Code or Codex session from a trace in
  slice 1. Context handoff comes first; native resume is a later, experimental
  slice.
- Secret detection inside images, video, or PDFs. Media is never scanned; the
  uploader is warned. Text attachments are scanned (D6).
- Regex rules in redaction profiles (see D4).
- Live streaming of a session while it runs.
- Dashboard trace import as the primary path. The dashboard drop zone exists,
  but it recommends asking the agent instead (D14).

## How the existing system works (the parts traces reuse)

- **Shiplet and revisions.** A Shiplet is a row in `projects`
  (`src/schema.ts`) with `visibility` (`private`, `organization`, `unlisted`,
  `public`) and an `owner_user_id`. Immutable revisions live in
  `shiplet_revisions` (`src/self-owned/revisions.ts`, `ensureRevisionSchema`).
- **Grants.** `shiplet_access_grants` targets `user`, `team`, or
  `organization`, with an optional exact `email` that becomes effective only
  when accepted by the matching signed-in identity. Roles are `viewer`,
  `editor`, `owner`.
- **Authorization.** `canViewProject` and `canEditProject` in `src/store.ts`
  decide view and edit; organization admins can view every Shiplet in their
  organization. Revision routes authenticate through
  `requireRevisionRouteAccess` (`src/index.ts`). It accepts an organization API
  key (`authenticateOptionalOrganizationCredential` plus
  `requireOrganizationApiProjectAccess`) or a user from `requireCurrentUser`,
  which accepts a browser session or a CLI session token. Review and feedback
  routes use `authorizeReviewRequest` instead. These helpers throw 401 or 403.
- **CLI sessions.** Browser login mints a `shiplet_cli_session_` token whose
  scopes are stored in `cli_sessions.scopes_json` (`src/cli-session.ts`). There
  are two kinds. A command session (`COMMAND_SESSION_SCOPES`) lives at most 10
  minutes and is revoked when the command ends. A reusable session
  (`REUSABLE_SESSION_SCOPES`, which adds `session:read`) lives 2 hours by
  default and at most 8, and is cached on disk between commands by
  `src/cli/session-cache.cjs`. `scopeForRequest`
  maps an exact list of method and path pairs to one of those scopes, and
  `authenticateCliSession` rejects every other path.
- **API keys.** Scopes are a closed union in `src/org-api-tokens.ts`
  (`shiplets:read`, `shiplets:write`, `shiplets:archive`, `feedback:read`,
  `feedback:write`, `mcp`). Keys carry the `shiplet_org_` prefix. The key
  creation forms hard-code the scope list in `src/platform/settings-page.tsx`
  and `src/render.ts`, and `src/docs.ts` documents it.
- **MCP.** Code Mode exposes exactly `search` and `execute`. `search` reads
  `openapi.json`; `execute` dispatches through a hand-written router
  (`executeCodeModeRequest`) restricted to `CODE_MODE_OPERATION_ALLOWLIST`.
  The marker `x-shiplet-code-mode: true` adds an operation to that allowlist,
  but a dispatcher branch is still required. MCP request bodies are capped at
  128 KiB (`MAX_MCP_REQUEST_BYTES`). OAuth and registered agents are limited to
  `RECOGNIZED_AGENT_REGISTRATION_PERMISSIONS` (`src/mcp-principal.ts`).
  `openapi.json` is also served publicly and published to the docs.
- **Blob storage.** The `REVIEW_ASSETS` R2 binding (configured in both Wrangler
  files) stores feedback screenshots under `projects/<projectId>/feedback/...`
  (`src/review.ts`). It also holds review-feedback attachments
  (`review_feedback_attachments`, digest-addressed keys, at most 5 MiB each and
  10 MiB per comment, with SVG served as a download), which are the closest
  precedent for trace attachments. It also holds external-rewrite spools under
  `_internal/external-rewrite/v1/`.
  `src/cloudflare-external-rewrite-spool.ts` lists by prefix and deletes in
  batches of 1,000 with `deleteR2Keys`.
- **CLI.** `src/cli/shiplet.cjs` is plain CommonJS with no build step, on Node
  22.12 or newer. It is published as the npm package `shiplet-cli`.
  `scripts/build-cli-package.mjs` copies an explicit list of `src/cli` files
  into a flat `lib/`. `packages/cli/package.json` ships `lib/*.cjs`, and
  `scripts/cli-package.test.mjs` pins the exact packed file list.
  `requestKernel` caps JSON responses at 1 MiB (`MAX_API_RESPONSE_BYTES`)
  unless a call passes `maxResponseBytes`, and times out after 30 seconds
  (`API_REQUEST_TIMEOUT_MS`). It has no stdin or TTY prompts. Tests `require`
  the CLI directly (`test/cli.spec.ts`), and some evaluate its source in
  isolation with a substitute `require` and `__dirname`, so optional modules
  are required lazily (as `browser-session.cjs` is).
- **Feature flags.** `src/feature-flags.ts` reads
  `SHIPLET_ENABLED_FEATURE_FLAGS`; `ShipletFeatureFlagKey` is currently a single
  literal type. Tests toggle flags per case with `withFeatureFlags`
  (`test/index.spec.ts`).
- **Schema bootstrap.** `ensureKernelSchemas` in `src/index.ts` calls each
  module's `ensure*Schema` on first request.
- **Archive and delete.** Archived Shiplets are kept 30 days
  (`SHIPLET_ARCHIVE_RETENTION_DAYS`). Permanent deletion requires the Shiplet
  owner (`requireProjectOwner`) and an archived Shiplet (409 otherwise).
  `deleteProjectPermanently` deletes the D1 records first. It then deletes
  stored objects best-effort and returns `cleanupIncomplete` when any of them
  failed. `canViewProject` and `canEditProject` ignore `archived_on`. The
  Worker's `scheduled` handler runs sweeps, such as
  `sweepStaleExternalRewriteSpools`.

## Decisions

Each decision records who made it: **owner** (confirmed in conversation on
2026-11-18), **code** (the repository already decides it), or **agent**
(proposed here; owner should confirm).

### D1. A trace belongs to a Shiplet and is pinned to a revision (owner)

`project_traces.project_id` is required; `revision_id` is optional and must
belong to the same Shiplet. A Shiplet can hold many traces. A trace-only
Shiplet, with no artifact and just the session, is allowed for sharing a session
on its own (slice 4).

Rejected: Shiplet-only (loses which session made which revision); standalone
trace objects with their own grants (duplicates the access-control system).

### D2. Private until shared; organization admins read every shared trace (owner)

A trace's `sharing` is `private` or `shared`.

- **New traces are private.** A private trace is readable only by its uploader
  and the Shiplet owner (`projects.owner_user_id`), even on a public or unlisted
  Shiplet, and even by organization admins.
- **A trace becomes shared** when its first audience is added, or explicitly
  with `--share`. Removing the last audience does not make it private again;
  only an explicit `--private` (or the dashboard toggle) does.
- **Organization admins** of the Shiplet's organization read every shared trace
  at `full`, whether or not an audience names them. That matches Shiplet's own
  rule that admins see every Shiplet in their organization, while leaving the
  uploader a way to keep a session to themselves.
- **Pre-filled candidates.** The share screen and CLI pre-fill candidate
  audiences from the Shiplet's grants, but none is enabled until chosen. A grant
  with role `owner` is an audience candidate like any other grant, not a trace
  owner.

Rejected: inheriting Shiplet access at Conversation or Full by default (a public
Shiplet would silently publish its session); giving admins private traces too
(uploaders would have no private option).

### D3. Redaction is a level plus ordered rules, chosen per audience (owner)

A **profile** is `{ level, rules }`. The dashboard exposes the level ladder and
the simple rules; the CLI and MCP accept every rule. Agents drive most uploads,
so the full surface lives where they work.

**Levels**, applied first:

| Level | Events | Tool calls | Tool results | Reasoning | Attachments | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| `full` | All | Name, input summary, full input | Full text | Kept | All | Yes |
| `conversation` | User and assistant messages, tool calls, subagent markers, system notes | Name and input summary only | Replaced by an `omitted` marker with byte count | Dropped | Only those on user messages | Yes |
| `summary` | None | None | None | None | None | Yes |
| `hidden` | Trace is not listed; every read returns 404 | | | | | No |

**Rules**, applied in order after the level. A profile holds at most 50 rules
and its canonical JSON is at most 32 KiB.

| Rule | Shape | Effect | Dashboard |
| --- | --- | --- | --- |
| `mask_terms` | `{ op, terms: string[], caseSensitive?: false }` | Each term (2 to 200 chars, at most 200 terms) is replaced with `[masked]` in every string field and the summary | Yes |
| `drop_paths` | `{ op, globs: string[] }` | Events whose tool input path or input summary matches a glob become `omitted`, along with the results of those tool calls; matching `filesTouched` entries are removed. A glob without a leading `/` may match any trailing part of a path, so `src/**` matches `/work/app/src/a.ts` | Yes |
| `drop_kinds` | `{ op, kinds: EventKind[] }` | Drops events of these kinds | Only "hide reasoning" |
| `drop_tools` | `{ op, tools: string[] }` | Drops calls and results for these tool names | No |
| `drop_agents` | `{ op, agents: string[] }` | Drops every event from these subagents | No |
| `drop_events` | `{ op, ids: string[] }` | Drops specific events, chosen from a preview | No |
| `drop_attachments` | `{ op, mediaTypes: string[] }` | Drops attachments by type, with `*` wildcards such as `video/*` | Only "hide videos" |
| `truncate` | `{ op, maxChars: number }` | Truncates every text field to `maxChars`, keeping the head and noting the original size | No |

A dropped event becomes `{ kind: "omitted", id, seq, reason }` so sequence
numbers and counts stay honest. Rules never add content.

Rejected: levels only (agents need finer control); fully custom rules with no
levels (hard to explain in the dashboard and easy to get wrong).

### D4. No regex rules in v1 (agent)

`mask_terms` takes literal strings. Regex evaluated on the server risks
catastrophic backtracking inside a Worker's CPU budget, and nothing in the
owner's request needs it. Revisit if agents ask for pattern rules; the likely
answer is a linear-time matcher, or regex applied client-side before upload
only.

### D5. Audience resolution: most specific tier wins, then most permissive (agent)

An audience is `(target_type, target_id, profile)`, with `target_type` one of
`user`, `email`, `team`, `organization`, `link`, `api_token`.

To resolve a reader:

1. The reader must still be able to view the Shiplet: `canViewProject` for
   people, organization and project access for API keys. This applies to
   uploaders too: losing view access to the Shiplet loses access to its traces.
2. The uploader and the Shiplet owner get `full` with no rules, and can manage
   audiences. Organization admins get `full` on shared traces only (D2); they
   can delete any trace but cannot change audiences. For an upload made with an API key, the uploader is that key, not
   the person who created it. Once the key is revoked, only the Shiplet owner
   can read the trace until it is shared.
3. Otherwise find matching audiences in tiers, most specific first:
   - `user` or `email`: `user` matches the reader's ID; `email` matches only
     the signed-in identity with that exact email (case-insensitive), as Shiplet
     invitations already do.
   - `team`: the reader belongs to the team.
   - `organization`: the reader is a member of the Shiplet's organization.
   - `link`: any reader who passed step 1, including anonymous viewers of a
     public or unlisted Shiplet.

   `api_token` is its own tier and is the only audience an organization API key
   can match.
4. Use the first tier with any match. Within it, take the profile with the most
   permissive level (`full` > `conversation` > `summary` > `hidden`); on a tie,
   the audience created first. Profiles are never merged.
5. No match means `hidden`, which is a 404 for every read.

Specificity lets an uploader say "the organization sees Conversation, but the
contractors team sees Summary, and alex@example.com sees Full." That is the
"redact it for this team or these emails" control the owner asked for.

Agents connected over MCP OAuth or a claimed `service_auth` registration act as
their delegated user. Shiplet editors cannot change trace audiences; only the
uploader and the Shiplet owner can, so edit access cannot be used to widen what
others see. Every slice 1 trace is private, so admins have no trace access
until slice 2 adds sharing.

Rejected: union with most permissive overall (a team-level restriction could
never narrow an organization-level share); most restrictive overall (one stray
`summary` audience would blind everyone it touches).

### D6. Secrets are masked on the client and again on ingest (owner)

One plain-JavaScript module (D17) masks secrets. The CLI runs it before upload,
the dashboard drop zone runs it in the browser before upload, and the Worker
runs it again on every ingest path. The upload response reports how many
secrets the server masked, so uploaders learn when a client skipped masking.

**Placeholder.** A match is replaced with `[secret:<kind>]`. Masking is
idempotent: no pattern matches text that begins with `[secret:`, so masking
already-masked text masks nothing. A test asserts
`maskSecrets(maskSecrets(x).text).count === 0` for every fixture.

**Patterns, in this order** (all literal-anchored and linear-time; `\b` is a
word boundary):

| Kind | Pattern |
| --- | --- |
| `private-key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` through the matching `-----END [A-Z ]*PRIVATE KEY-----`, or to the end of the string |
| `shiplet-api-key` | `\bshiplet_(?:org\|cli_session)_[A-Za-z0-9]{16,}` |
| `anthropic-key` | `\bsk-ant-[A-Za-z0-9_-]{20,}` |
| `stripe-key` | `\b(?:sk\|rk)_live_[A-Za-z0-9]{16,}` |
| `openai-style-key` | `\b(?:sk\|pk\|rk)-[A-Za-z0-9_-]{20,}` (after `anthropic-key`) |
| `github-token` | `\bgh[pousr]_[A-Za-z0-9]{30,}` or `\bgithub_pat_[A-Za-z0-9_]{30,}` |
| `slack-token` | `\bxox[abprs]-[A-Za-z0-9-]{10,}` |
| `slack-webhook` | `https://hooks\.slack\.com/services/[A-Za-z0-9/]{20,}` |
| `aws-access-key-id` | `\b(?:AKIA\|ASIA)[0-9A-Z]{16}\b` |
| `google-api-key` | `\bAIza[0-9A-Za-z_-]{35}` |
| `npm-token` | `\bnpm_[A-Za-z0-9]{36}\b` |
| `jwt` | `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}` |
| `bearer` | `\b[Bb]earer\s+` followed by a value of 16 or more characters from `[A-Za-z0-9._~+/=-]` (only the value is replaced) |
| `url-credentials` | `[a-z][a-z0-9+.-]*://` then `user:password@`, where the password is replaced |
| `credential-assignment` | Key, separator, value (only the value is replaced; see below) |

**`credential-assignment`.** The key is one of `api_key`, `apikey`,
`api-key`, `access_key`, `secret_key`, `client_secret`, `auth_token`,
`access_token`, `refresh_token`, `token`, `secret`, `password`, `passwd`,
`authorization`, or `cookie`. It is matched case-insensitively as a whole word
(so `max_tokens` and `input_tokens` do not match), optionally quoted. It is
followed by optional spaces, `=` or `:`, and optional spaces. The value is
either quoted (`"..."` or `'...'`, 8 to 4,096 characters inside) or unquoted (8
or more characters from `[A-Za-z0-9._~+/=-]`). It is masked only when it
contains at least one letter and at least one digit, and does not start with
`[secret:`. This leaves `password: string`, `token: 32000`, and
`secret: process.env.SECRET` alone.

**What is scanned.** Every string field in events and in the upload's `title`,
and the decoded bytes of `text/plain` attachments. These event fields are exempt
so references stay intact: `id`, `seq`, `t`, `agent`, `kind`, `tool.callId`,
`result.callId`, `attachmentIds`. Attachments of other types are never scanned.

Email addresses and file paths are not masked; they are often the point of the
trace, and `mask_terms` covers them per audience.

Rejected: entropy-based detection (masks commit SHAs, digests, and IDs, which
traces are full of); client-only masking (raw API and MCP uploads skip the CLI).
The CLI's existing `sanitizeOutputText` serves a different purpose (scrubbing
the CLI's own output) and stays as is; unifying the two is out of scope.

### D7. Upload bytes go through an upload URL, not MCP request bodies (agent, from a code constraint)

The code fixes one fact: MCP requests are capped at 128 KiB. Making a model copy
a multi-megabyte file through tool-call arguments would also waste its context
even without the cap. So in slice 3, MCP creates the trace record and returns a
short-lived upload URL, and the CLI or `curl` sends the bytes. Every other
operation (list, read, share, levels, rules, pull, delete) becomes a normal Code
Mode operation in slice 3. Slice 1 uses REST from the CLI only.

### D8. Canonical format is `shiplet.trace/v1`, built by the server (agent)

The client normalizes Claude Code JSONL (including subagent files) and Codex
rollout JSONL into **events**, and uploads only those events plus attachments.
The server masks them again, then derives everything else: input summaries,
the summary, segments, hashes, and the manifest. Raw harness logs are never
uploaded, and the server never trusts a client-built summary.

- **Event** (one JSON object): `id` (`e` plus a 6-digit zero-padded `seq`),
  `seq` (integer from 0), `t` (ISO time or null), `agent` (`main` or a subagent
  ID), `kind`, and by kind:
  - `user_message`, `assistant_message`, `reasoning`, `system_note`: `text`.
  - `tool_call`: `tool { name, callId, input }`, where `input` is the tool's
    input object.
  - `tool_result`: `result { callId, isError, text }`.
  - `subagent_start`: `text` (the subagent's title or first prompt line, at
    most 200 chars). `subagent_end`: no extra field.
  - `omitted`: `reason`.
  - Any kind may carry `attachmentIds[]`.
- **inputSummary** is added to each `tool_call` by `finalizeTrace`: the command
  for shell tools (tool name `Bash`, `shell`, `exec_command`, or
  `local_shell`, from `input.command` as a string, the last element of an
  array, or `input.cmd`), at most 200 chars; otherwise `input.file_path`,
  `input.path`, or `input.notebook_path`; otherwise the tool name, a colon, and
  the first string value in `input`, at most 120 chars.
- **Summary**: `durationSeconds` (first to last non-null `t`), `models[]`,
  `promptCount` (number of `user_message` events from `main`),
  `toolCounts { name: count }`, `filesTouched[]` (D8a), `checks[]`, `outcome`,
  `errorCount` (`tool_result` events with `isError`). A **check** is a shell
  `tool_call` whose command runs a test, lint, typecheck, or build tool
  (`isCheckCommand` in the core: `npm test`, `npx vitest`, `pytest`,
  `node --test`, `cargo test`, `make check`, and similar), after a leading
  `cd dir &&`, environment assignments, and `timeout N` are removed. A command
  that merely mentions such a word, such as `grep test`, is not a check. It is
  recorded as `{ command, ok }` (the command's first line), where `ok` is the negation of its result's
  `isError` (true when no result exists). `outcome` is `last-check-passed`,
  `last-check-failed`, or `no-checks-run`, from the last check.
- **D8a. filesTouched** is the de-duplicated list of `file_path`, `path`, and
  `notebook_path` inputs of tools other than search tools (`Grep`, `Glob`,
  `LS`, whose `path` is a folder to search), made relative to the session's working directory
  (`cwd`, sent in the upload and not stored). Paths outside it are dropped, and
  so are all paths when no working directory is known.
- **Manifest**: `schemaVersion`, `title`,
  `source { harness, harnessVersion, importer }`, `startedAt`, `endedAt`,
  `models[]`, `cwdLabel` (the working directory's base name only), `agents[]`
  (`{ id, title }`), `counts { events, toolCalls, errors, attachments, skippedLines }`,
  `summary`, `segments[] { index, firstSeq, lastSeq, events, bytes, sha256 }`,
  `attachments[] { sha256, mediaType, bytes }`,
  `masking { coreVersion, clientCount, clientKinds, serverCount, serverKinds }`.
- **Segments**: at most 2,000 events and at most 1 MiB of uncompressed NDJSON
  each, whichever comes first. An event is never split, and no serialized
  event exceeds 512 KiB (D10), so every segment holds at least one event. `bytes` and `sha256` cover the
  uncompressed NDJSON. Storage gzips it with `CompressionStream("gzip")`.
  Segments page the dashboard viewer and let slice 2 render redacted variants
  one segment at a time.

Rejected: storing raw harness JSONL (formats change without notice and contain
fields no viewer needs); trusting a client-built manifest and segments (server
masking would make their hashes stale and let a client lie in the summary);
OpenTelemetry GenAI spans (built for telemetry, not reading, and still
settling).

### D9. Files: inline media and session-produced files are kept (owner direction, agent mechanism)

A session often produces files besides the Shiplet's main artifact: screenshots,
rendered videos, generated images, and PDFs. These are kept with the trace.

- **Inline media** already inside the session, such as pasted screenshots or
  images a tool returned, is extracted by the client into content-addressed
  attachments (`sha256` of the decoded bytes), with `source: "inline"`
  (slice 1).
- **Session-produced files** are attached by default (slice 2), with
  `source: "file"` and a project-relative `path`. A file qualifies when all of
  these hold:
  - it exists under the session's working directory;
  - its extension is `png`, `jpg`, `jpeg`, `gif`, `webp`, `mp4`, `webm`, or
    `pdf`;
  - its path appears in a tool call's input or a tool result's text;
  - it was modified between the session's start and five minutes after its end.

  That catches browser screenshots, rendered videos, and exported PDFs, and
  skips the rest of the repository. `trace share --dry-run` lists them,
  `--no-files` skips them, and `--attach <glob>` adds others explicitly.
- **Files the agent wrote or edited as text** (code, Markdown, config) are
  already in the trace as tool inputs, and follow the level like any other text.
- **The Shiplet's main artifact** is already stored as the pinned revision, so a
  trace does not duplicate it.
- **The viewer** shows attachments in a Files panel beside the timeline, and
  inline at the event that produced or referenced them.

Allowed attachment types: `image/png`, `image/jpeg`, `image/gif`,
`image/webp`, `video/mp4`, `video/webm`, `application/pdf`, `text/plain`. The
client converts anything else, including SVG and HTML, to `text/plain` before
upload. The server rejects any other type with 400. `text/plain` attachments are
secret-scanned like event text; their sha256 is computed after masking. Images
and video are served with `content-disposition: inline`, everything else with
`attachment`, and all with `x-content-type-options: nosniff`. This follows the
review-feedback attachment precedent, with higher limits (D10) because videos
are expected.

Rejected: uploading every file the session touched (repositories leak
wholesale); copying session-produced files into the Shiplet's artifact (they
are evidence of the session, not part of the work under review).

### D10. Size limits (agent)

| Limit | Value | Why |
| --- | --- | --- |
| Single text field | 256 KiB of UTF-8 | Larger values are almost always dumped tool output. `truncateEvents` keeps the first and last 64 KiB, cut back to whole characters, with `[truncated: <n> bytes]` between. It runs after masking, so a cut cannot shorten a secret below its pattern. |
| Single event | 512 KiB serialized | When an event is still larger after field truncation, `truncateEvents` replaces `tool.input` with `{ "truncated": true, "bytes": <n> }` (the input summary is kept), then truncates `text` and `result.text` to 64 KiB. The server rejects any event over 512 KiB. |
| Segment | 2,000 events or 1 MiB uncompressed | Fits in Worker memory and one dashboard page. |
| Segments per trace | 128 | An independent cap; at most 64 MiB of events. |
| Canonical events per trace | 64 MiB uncompressed | Long Claude Code sessions run from a few MB to tens of MB. |
| Attachment | 20 MiB each | Covers screenshots and short screen recordings. |
| Attachments per trace | 256 MiB total, 200 files | Keeps one trace from becoming a video archive. Files over the limit are skipped and listed, not fatal. |
| Slice 1 upload request | 16 MiB of JSON | Slice 1 parses the whole upload in one Worker request, so it stays far below the 128 MB isolate limit. The existing 80 MiB static-upload limit is for assets that are stored, not parsed and rewritten. Slice 2's multipart upload removes this cap. |
| Upload part (slice 2) | 8 MiB | Above R2's 5 MiB multipart minimum. |
| Quota | 10 GiB per organization; 1 GiB per uploading user for Shiplets with no organization | A placeholder until pricing decides (open question 2). |

Quota counts `canonical_bytes + attachment_bytes` across the organization's
traces (or, on Shiplets with no organization, the uploading user's traces on
such Shiplets). It is checked
before storage. Two concurrent uploads can overshoot it by at most one upload
(16 MiB in slice 1), which is accepted.

All limits live in `TRACE_LIMITS` in the shared core (D17).

### D11. Storage: the existing R2 binding, under a separate prefix (agent)

Traces reuse `REVIEW_ASSETS` under `traces/v1/<projectId>/<traceId>/`:

```text
canonical/manifest.json
canonical/seg-00000.ndjson.gz
attachments/<sha256>
variants/<profileDigest>/manifest.json        (slice 2)
variants/<profileDigest>/seg-00000.ndjson.gz  (slice 2)
```

The binding is configured in both Wrangler files, but trace routes still check
it and return 503 `traces_storage_unavailable` when it is absent. Unlike
screenshots, which `src/review.ts` silently skips, a trace without storage is
useless, so it fails loudly. Rejected: a new bucket binding now (it adds setup and
type-contract churn for no present benefit). Revisit when traces need their own
retention, jurisdiction, or quota accounting.

### D12. Redacted variants are rendered when sharing changes, not per request (owner intent, agent mechanism; slice 2)

When an audience is added or its profile changes, the Worker renders that
profile's variant once, segment by segment, from the canonical copy, and stores
it under `variants/<profileDigest>/`. Reads serve the stored variant. Two
audiences with the same profile share one variant. The canonical copy is read
only to render variants and to serve `full` to the uploader and Shiplet owner.
The uploader can preview any variant before enabling it.

### D13. Pull hands context to the agent; it does not fake a native session (agent)

`buildContext(manifest, events, { level = "full", maxTokens = 32000 })` in the shared core
returns Markdown. Tokens are estimated as `ceil(characters / 4)`; there is no
tokenizer. Layout:

```text
# <title>
Source: <harness> <harnessVersion> · Models: <models> · Duration: <minutes> min · Outcome: <outcome> · Your level: <level>

## Summary
Files touched: <filesTouched, comma-separated, at most 50>
Checks: <command> (passed|failed), one per line, at most 20
Errors: <errorCount> · Subagents: <agents count>

## Session
**User:** <text>
**Assistant:** <text>
→ <tool name>: <inputSummary>
← error: <first 400 chars of result text>      (only for failed results, only at full level)
[Subagent "<title>": <n> tool calls, <m> errors]  (one line per subagent, at its start)
```

Main-agent events appear in `seq` order. Successful tool results are never
printed; subagent internals are reduced to their one line. When the estimate
exceeds `maxTokens`, content is dropped in this order until it fits:

1. Error excerpts.
2. Tool call lines, except those whose result failed.
3. Whole user and assistant messages from the middle, keeping the first 3 and
   the last 10, replaced by `[… <n> messages elided …]`.
4. If it still does not fit, each remaining message is truncated to 2,000
   characters.

The summary block is never dropped.

- `shiplet trace pull <trace-id> --shiplet <id> [dir]` writes `trace.json`
  (manifest plus all events at the caller's level), `attachments/`, and
  `context.md`.
- `--as context` prints only the Markdown to stdout, for piping into an agent.
- In slice 3, the MCP operation `getTraceContext` returns the same Markdown at
  the caller's level.
- Native resume, writing a Claude Code or Codex session file so the colleague
  can `--resume` it, is slice 5, experimental. The harnesses' internal formats
  are undocumented and change between versions.

### D14. Dashboard: browse and share; the drop zone points to the agent first (owner; slice 4)

The dashboard reads traces (D15) and manages audiences and levels. It also
offers a drop zone for `.jsonl` session files or a Claude Code session folder.
Its first line recommends asking the agent instead, with the exact prompt and
CLI command to copy. It runs the shared core in the browser to mask secrets and
show a preview before anything is sent. Desktop apps cannot drag a session out
of their sidebars today. The drop zone accepts any drag that carries a file, so
it starts working if they add that.

### D15. The trace viewer is read-only, text-first, and paged by segment (agent; slice 4)

The dashboard page `/shiplets/:projectId/traces/:traceId` shows:

- A header with title, source, models, duration, outcome, and the reader's level.
- The timeline, one segment per page: messages; tool calls collapsed to their
  input summary; results expandable; subagents as nested threads.
- Attachments inline (images and video) or as downloads.
- "Copy prompt for your agent" and "Copy CLI command" buttons (see
  [traces-user-flows.md](./traces-user-flows.md)).

All trace text renders as escaped text. Markdown is limited to code fences and
line breaks; no HTML is ever rendered.

### D16. Scopes, CLI sessions, and the feature flag (agent)

- New organization API scopes `traces:read` and `traces:write`, in the scope
  union and `VALID_SCOPES`, both key-creation forms, and the scope tables in
  `src/docs.ts` and `docs/api-keys.mdx`.
- New CLI session scopes `trace:read` and `trace:write`, added to both
  `COMMAND_SESSION_SCOPES` and `REUSABLE_SESSION_SCOPES`, with
  `scopeForRequest` mapping the trace routes to them. A reusable session cached
  before the release (up to 8 hours old) lacks them. A trace route that receives
  a `shiplet_cli_session_` token without the needed scope returns 401
  `{ "error": "cli_session_reauth_required" }`. The CLI then drops its cached
  session, runs browser login once, and retries.
- Agent registration and MCP scopes follow in slice 3, with
  `RECOGNIZED_AGENT_REGISTRATION_PERMISSIONS` and matching WorkOS configuration.
- A new `traces` feature flag. With the flag off, every trace route returns 404
  `{ "error": "traces_not_enabled" }`, which the CLI reports as "Traces are
  not enabled on this server." Whether the feature is on is not a secret; whether
  a trace exists is. Production `wrangler.jsonc` stays unchanged in slice 1, and
  tests enable the flag with `withFeatureFlags("traces", ...)`.
- **Error bodies.** Every trace route error is JSON
  `{ "error": "<code>", "message": "<text>" }`, plus `errors` for validation.
  A missing or unreadable trace is always 404 `{ "error": "not_found" }`.

### D17. The shared core is an ES module next to the CLI (agent)

`src/cli/trace-core.mjs`, with a hand-written `src/cli/trace-core.d.mts`.

- **CLI.** It lives in `src/cli` because the published CLI is a flat copy of
  named `src/cli` files into `lib/`, so the CLI's relative `require` works both
  in the repository and in the package. The CLI requires it lazily inside the
  trace command handlers, never at the top of the file, which Node 22.12 and
  newer support without a flag. The top-level isolated-source tests in
  `test/cli.spec.ts` are unaffected.
- **Worker and browser.** The Worker imports `./cli/trace-core.mjs` with types
  (`allowJs: false` is satisfied by the declaration file). Vite and the Workers
  test pool load ES modules natively.
- **Constraints.** It has no top-level `await`, no dependencies, and uses only
  APIs present in Node 22, Workers, and browsers (`crypto.subtle`,
  `TextEncoder`, `CompressionStream`), so its hashing functions are `async`.

Rejected: CommonJS (`allowJs: false` and Vite's CommonJS handling would both
need configuration changes); a separate directory outside `src/cli` (the
package builder flattens files into `lib/`, so a relative path outside it would
break in the published package); TypeScript compiled for the CLI (the CLI has no
build step).

### D18. Archived Shiplets' traces expire after 7 days (owner)

When a Shiplet is archived, its traces are deleted 7 days later, ahead of the
Shiplet's own 30 days. Restoring the Shiplet within 7 days keeps them. A
`scheduled` sweep (slice 2) deletes traces whose Shiplet's `archived_on` is more
than 7 days old. Until then, traces leave with the Shiplet at 30 days.

### D19. A trace-only Shiplet is an ordinary Shiplet whose page is the trace viewer (owner)

There is no new Shiplet type.

- **No artifact.** A Shiplet created to share a session alone
  (`shiplet trace share --new --title <t>`) has no artifact. Its review page
  renders the trace viewer (D15) where the artifact frame would be.
- **Artifact and traces.** A Shiplet with both shows the same viewer component
  in a Traces tab beside the artifact.
- **One component.** Both cases use one viewer, one URL scheme, and the same
  access rules.

Rejected: a new `source_type` (every route that branches on source type would
need a case).

## Slice 1: owner-only upload, read, pull, and delete over REST and the CLI

Proves the format, the shared core, double masking, and storage end to end,
with no sharing and no MCP yet. Under D2, owner-only is already the correct
behavior for every trace. The routes are not added to `openapi.json` or Code
Mode in this slice; that happens in slice 3, once they are callable over MCP.

**Entry point:** `shiplet trace share <path> --shiplet <projectId>
[--revision <revisionId>] [--title <text>] [--no-attachments] [--dry-run]
[--json]`, where `<path>` is a Claude Code `.jsonl` file, a Codex rollout
`.jsonl` file, or a Claude Code session folder. `--current` replaces `<path>`.
The command is the published `shiplet-cli` binary (`npx shiplet-cli`); from a
checkout it is `npm run shiplet -- trace share ...`.

### Pipeline

```text
client: parseJsonl → detectFormat → normalize → maskEvents + maskAttachments
        → truncateEvents → validateUpload → POST
server: read ≤16 MiB → validateUpload → maskEvents + maskAttachments
        → truncateEvents → finalizeTrace → quota → createTrace
```

Masking always runs before truncation, on both sides.

### Files

**Create `src/cli/trace-core.mjs` and `src/cli/trace-core.d.mts`.**
Exports:

- `TRACE_LIMITS`: the D10 constants. `CORE_VERSION`: `"1"`.
- `parseJsonl(text)`: returns `{ records, skippedLines }`. Unparsable lines are
  skipped and counted; a live session's half-written last line is the common
  case.
- `detectFormat(records)`: returns `"codex"` when any record has a `payload`
  object and `type` of `session_meta`, `response_item`, `turn_context`, or
  `event_msg`; otherwise `"claude-code"` when any record has `type` of `user`
  or `assistant` and a `message` object; otherwise throws
  `TraceFormatError("unrecognized session format")`.
- `normalize({ format, main, subagents = [] })`, where `main` and each
  subagent are `{ fileName, records, skippedLines }`. Returns
  `{ events, attachments, cwd, startedAt, endedAt, models, harnessVersion, skippedLines }`.
  It does not mask or truncate. Every event's `t` is its record's `timestamp`
  (or null). `seq` and `id` are assigned last (see "Ordering").
  - **Claude Code.** Records whose `type` is not `user` or `assistant` are
    ignored. So are records with `isMeta: true`, and user messages made only of
    `<system-reminder>` blocks (those blocks are stripped from any other user
    text). For each content part, in order:
    - `user` text: `user_message`; `system_note` when the record has
      `isCompactSummary: true`.
    - `assistant` `text`: `assistant_message`.
    - `thinking`: `reasoning`.
    - `tool_use`: `tool_call` (`name`, `callId` from `id`, `input`).
    - `tool_result`: `tool_result` (`callId` from `tool_use_id`, `isError` from
      `is_error === true`, text from the content string or the joined text
      parts).
    - `image` parts (base64 `source`): attachments on the text event from the
      same record (an empty-text message is created only when the record has
      no text), and images inside a `tool_result` attach to that result.

    Each part is its own event, so records split across one assistant
    `message.id` need no merging. `cwd` comes from the first record with one.
    `harnessVersion` comes from the first record's `version`. `models` lists
    every distinct `message.model`, in first-seen order, across the main and
    subagent files.
  - **Claude Code agents.** The main file's events have agent `main`, except
    records with `isSidechain: true`. A subagent file's agent ID is the first
    record's `agentId`, else its file name without `agent-` and `.jsonl`. An
    inline sidechain record's agent is its `agentId`, else `"sidechain"`.
  - **Codex.**
    - `session_meta.payload.cwd` gives `cwd`.
      `session_meta.payload.cli_version` gives `harnessVersion` (else null).
      `models` lists every distinct `turn_context.payload.model`.
    - User messages come from `event_msg` `user_message` (`payload.message`).
      Only when there are none, `response_item` `message` records with role
      `user` whose text does not start with `<` are used instead.
    - `response_item` `message` with role `assistant` (its `output_text` parts)
      becomes `assistant_message`.
    - `response_item` `reasoning` (its `summary[].text`, joined) becomes
      `reasoning`.
    - Tool calls:

      | Record | `name` | `callId` | `input` |
      | --- | --- | --- | --- |
      | `function_call` | `payload.name` | `payload.call_id` | `payload.arguments`, parsed as JSON, else `{ "raw": <string> }` |
      | `custom_tool_call` | `payload.name` | `payload.call_id` | `{ "input": payload.input }` |
      | `local_shell_call` | `"local_shell"` | `payload.call_id`, else `payload.id` | `payload.action` |

    - `function_call_output` and `custom_tool_call_output` become
      `tool_result`, with `callId` from `payload.call_id`. Exit code rule: if
      `payload.output` parses as JSON with `metadata.exit_code`, use it, and
      take the text from its `output` field. Otherwise take the first match of
      `^Exit code: (-?\d+)` or `Process exited with code (-?\d+)`, multiline.
      `isError` is true when a code is found and is not 0, and false otherwise.
    - `event_msg` `agent_message` is ignored, because the `response_item`
      assistant message carries the same text.
  - **Ordering.** All events, from the main file and from subagent files, are
    sorted by `t` ascending. Events with no `t` keep their file position after
    the last timed event before them. Ties go to `main` first, then file order.
    Every non-main agent, inline or from a file, gets a `subagent_start` just
    before its first event and a `subagent_end` just after its last. The start
    marker's `text` is the first line of that agent's first `user_message`, at
    most 200 characters, else the agent ID. Then `seq` is assigned from 0.
  - **Attachment types.** Media types outside the allowlist become `text/plain`.
    Attachments with the same sha256 are stored once and referenced by every
    event that has them.
- `maskSecrets(text)`: returns `{ text, count, kinds }` (D6).
- `maskEvents(events)` and `maskAttachments(attachments)`, both async. They
  return masked copies plus `{ count, kinds }`. They re-hash masked
  `text/plain` attachments, rewrite matching `attachmentIds`, and merge
  attachments that end up with the same sha256.
- `truncateEvents(events)`: applies the D10 field and event limits.
  Truncation counts UTF-8 bytes and cuts back to the previous whole character.
- `dropAttachments(events)`: removes every `attachmentIds` field and returns
  `{ events, dropped }`, for `--no-attachments`.
- `finalizeTrace({ events, attachments, cwd, title, source, startedAt, endedAt, models, skippedLines, droppedAttachments, masking })`,
  async: adds `inputSummary`, computes the summary and `filesTouched`,
  segments, hashes, and the manifest (D8). Returns
  `{ manifest, segments: [{ index, ndjson }] }`.
- `validateUpload(upload)`, async: returns `{ ok: true }` or
  `{ ok: false, errors: [{ path, message }] }`. Checks:
  - **Top-level fields.** No unknown fields.
    - `schemaVersion` must be `"shiplet.trace/v1"`.
    - `title`: a string of 1 to 200 characters after trimming.
    - `revisionId`: a string or null.
    - `source.harness`: `"claude-code"` or `"codex"`.
    - `source.harnessVersion` and `source.importer`: strings of at most 64
      characters, or null.
    - `cwd`: a string of at most 4,096 characters, or null.
    - `startedAt` and `endedAt`: ISO 8601 date-times, or null.
    - `models`: at most 20 strings of at most 100 characters.
    - `skippedLines` and `droppedAttachments`: integers of 0 or more.
    - `clientMasking`: `{ coreVersion: string, count: integer, kinds: { [kind]: integer } }`.
      It is stored as client-reported and is informational only.
  - **Events.** Count, field sizes, event sizes, and total size against D10;
    unique IDs, `seq` from 0 without gaps, and IDs matching `seq`; known kinds
    with their required fields.
  - **Attachments.** Every `attachmentIds` entry present in `attachments`; no
    two `attachments` entries with the same sha256; types in the allowlist; each
    attachment's decoded bytes matching its `sha256` and `bytes`.
- `buildContext(manifest, events, { level = "full", maxTokens = 32000 })` (D13).

**The upload body** (`POST`):

```json
{
  "schemaVersion": "shiplet.trace/v1",
  "revisionId": null,
  "title": "Checkout pagination",
  "source": { "harness": "claude-code", "harnessVersion": "2.3.1", "importer": "shiplet-cli/<version>" },
  "cwd": "/Users/me/app",
  "startedAt": "2026-11-18T10:00:00Z",
  "endedAt": "2026-11-18T10:42:00Z",
  "models": ["..."],
  "skippedLines": 1,
  "droppedAttachments": 0,
  "clientMasking": { "coreVersion": "1", "count": 2, "kinds": { "github-token": 2 } },
  "events": [],
  "attachments": [{ "sha256": "...", "mediaType": "image/png", "bytes": 1234, "base64": "..." }]
}
```

**Create `src/traces/schema.ts`.** `ensureTraceSchema(db)` creates:

```sql
CREATE TABLE IF NOT EXISTS project_traces (
  id TEXT PRIMARY KEY,                 -- newId("trc")
  project_id TEXT NOT NULL,
  organization_id TEXT,                -- copied from the project at upload
  revision_id TEXT,
  uploader_user_id TEXT,               -- set for session and CLI uploads
  uploader_token_id TEXT,              -- set for API key uploads
  upload_sha256 TEXT NOT NULL,         -- sha256 of the raw request body
  sharing TEXT NOT NULL DEFAULT 'private',  -- private | shared (always private in slice 1)
  title TEXT NOT NULL,
  harness TEXT NOT NULL,
  started_on TEXT,
  ended_on TEXT,
  event_count INTEGER NOT NULL,
  segment_count INTEGER NOT NULL,
  canonical_bytes INTEGER NOT NULL,
  attachment_count INTEGER NOT NULL,
  attachment_bytes INTEGER NOT NULL,
  client_masked_count INTEGER NOT NULL,
  server_masked_count INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_on TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_traces_upload ON project_traces(project_id, upload_sha256);
CREATE INDEX IF NOT EXISTS project_traces_project ON project_traces(project_id, created_on);
CREATE INDEX IF NOT EXISTS project_traces_org ON project_traces(organization_id);
CREATE INDEX IF NOT EXISTS project_traces_uploader ON project_traces(uploader_user_id);
```

**Modify `src/cloudflare-external-rewrite-spool.ts`.** Export the existing
`deleteR2Keys`. No behavior change.

**Create `src/traces/store.ts`.** Functions over D1 and `REVIEW_ASSETS`:

- `createTrace(env, input)`: puts every R2 object, then inserts the row. If any
  put or the insert fails, it deletes the objects it already put and rethrows.
  No row exists without its objects.
- `findTraceByUpload(db, projectId, uploadSha256)`, for retries.
- `listTracesForReader(db, projectId, reader, { cursor, limit })`.
- `getTrace(db, projectId, traceId)`.
- `readManifest(env, trace)`, `readSegment(env, trace, index)` (gunzip with
  `DecompressionStream`), and `readAttachment(env, trace, sha256)`.
- `deleteTrace(env, trace)`: deletes the row first, then lists
  `traces/v1/<projectId>/<traceId>/` and deletes it with `deleteR2Keys`. A
  failure after the row is gone leaves only orphaned objects, which
  `deleteProjectTraceObjects` or the slice 2 sweep later removes.
- `deleteProjectTraceObjects(env, projectId)`: lists and deletes the whole
  `traces/v1/<projectId>/` prefix, which also catches orphans. It returns
  `false` instead of throwing when any delete fails, following
  `deleteProjectPermanently`'s best-effort cleanup convention.
- `traceQuotaUsage(db, { organizationId, uploaderUserId })`.

**Create `src/traces/access.ts`.** `resolveTraceAccess(c, project, mode)`,
where `mode` is `"read"`, `"write"`, or `"delete"`. It returns
`{ actor, reader }` or a JSON error `Response` (D16), checking in this order:

1. With the `traces` flag off: 404 `traces_not_enabled`.
2. Without `REVIEW_ASSETS`: 503 `traces_storage_unavailable`.
3. A `shiplet_cli_session_` bearer token whose session lacks the needed CLI
   scope: 401 `cli_session_reauth_required` (`cliSessionHasScope`).
4. An organization API key (`authenticateOptionalOrganizationCredential`,
   caught): needs `traces:write` for `write` and `delete`, and `traces:read`
   for `read`, plus project access (`requireOrganizationApiProjectAccess`,
   caught). Failing these is 403 `forbidden` for `write`, and 404 `not_found`
   for `read` and `delete`. An invalid key is 401 `unauthorized`.
5. A user from `requireCurrentUser` (`src/auth.ts`), caught. No user is 401
   `unauthorized` for `write`, and 404 `not_found` for `read` and `delete`.
6. For `write`, `canEditProject` is required (403 `forbidden` otherwise), and
   an archived Shiplet is 409 `shiplet_archived`. For `read` and `delete`,
   `canViewProject` is required (404 `not_found` otherwise).

Each read or delete handler then requires the reader to be the trace's uploader
(`uploader_user_id` equal to the user's ID, or `uploader_token_id` equal to the
key's ID) or the Shiplet owner (`projects.owner_user_id`). Otherwise 404
`not_found`.

**Create `src/traces/routes.ts`.** `registerTraceRoutes(app)` registers the
routes below on the Worker's Hono app. `src/index.ts` calls it once, after the
other `/api/shiplets/:projectId/*` routes. Bodies are read with a local
16 MiB limit that mirrors `readRequestTextWithLimit` and returns 413
`payload_too_large`.

| Method and path | Mode | Behavior |
| --- | --- | --- |
| `POST /api/shiplets/:projectId/traces` | write | Steps 1 to 7 below. |
| `GET /api/shiplets/:projectId/traces?cursor=&limit=` | read | `{ traces: TraceSummary[], nextCursor }`. Newest first. `limit` is 1 to 100 (default 50). The cursor is opaque (base64 of `createdOn` and `id`). The list holds the traces the reader uploaded, or every trace when the reader is the Shiplet owner. |
| `GET /api/shiplets/:projectId/traces/:traceId` | read | `{ trace: TraceSummary, manifest }`. |
| `GET /api/shiplets/:projectId/traces/:traceId/segments/:index` | read | `{ index, events }`. An index out of range is 404 `not_found`. |
| `GET /api/shiplets/:projectId/traces/:traceId/attachments/:sha256` | read | Streams the bytes with the D9 headers. |
| `DELETE /api/shiplets/:projectId/traces/:traceId` | delete | 204. |

`POST` steps:

1. Compute `upload_sha256` of the raw body. If a trace with that digest already
   exists on this Shiplet and the caller may read it, return 200 with it and
   `"duplicate": true`. Retries never create a second trace or use quota.
2. Parse the body and run `validateUpload`. Failures are 400
   `invalid_upload` with `errors`.
3. A `revisionId` not in `shiplet_revisions` for this project is 400
   `revision_not_in_shiplet`.
4. Run `maskEvents` and `maskAttachments`, then `truncateEvents`, then
   `finalizeTrace`.
5. Over quota is 413 `quota_exceeded`.
6. `createTrace`.
7. Return 201 `{ trace: TraceSummary, manifest, serverMasked: { count, kinds } }`.

`TraceSummary` is the only row shape any route returns:

```json
{
  "id": "trc_…", "projectId": "…", "revisionId": null, "title": "…",
  "harness": "claude-code", "startedOn": "…", "endedOn": "…",
  "eventCount": 0, "segmentCount": 0, "canonicalBytes": 0,
  "attachmentCount": 0, "attachmentBytes": 0, "serverMaskedCount": 0,
  "sharing": "private", "uploadedBy": { "kind": "user", "id": "…" }, "createdOn": "…"
}
```

`uploadedBy.kind` is `"user"` or `"api_key"`. `organization_id`,
`upload_sha256`, `manifest_sha256`, and `client_masked_count` are not returned.

**Modify `src/index.ts`.**

- `ensureKernelSchemas`: call `ensureTraceSchema(db)` after
  `ensureRevisionSchema`.
- `deleteProjectPermanently`: after the D1 records are gone, call
  `deleteProjectTraceObjects(env, project.id)`, and set `cleanupIncomplete`
  when it returns `false`. Uploads to archived Shiplets are refused (409), and
  permanent deletion requires an archived Shiplet, so an upload cannot race a
  permanent delete.
- Call `registerTraceRoutes(app)`.

**Modify `src/store.ts`.** In `permanentlyDeleteProjectRecords`, delete
`project_traces` rows for the project in the same batch as the other records.

**Modify `src/cli-session.ts`.** Add `trace:read` and `trace:write` to
`COMMAND_SESSION_SCOPES` and `REUSABLE_SESSION_SCOPES`. Export
`cliSessionHasScope(db, request, scope)`, which looks the session up as
`authenticateCliSession` does, without the path mapping. In `scopeForRequest`, map `GET` on the four trace read routes to
`trace:read`, and `POST` or `DELETE` on the trace routes to `trace:write`.

**Modify `src/org-api-tokens.ts`.** Add `traces:read` and `traces:write` to the
`OrganizationApiScope` union and to `VALID_SCOPES`, from which persisted-scope
validation and normalization already derive.

**Modify `src/platform/settings-page.tsx`, `src/render.ts`, `src/docs.ts`, and
`docs/api-keys.mdx`.** Add the two scopes to the key-creation scope lists and
the scope tables. `docs/code-mode-mcp.mdx` lists agent permissions, which are
unchanged until slice 3.

**Modify `scripts/build-cli-package.mjs`, `packages/cli/package.json`, and
`scripts/cli-package.test.mjs`.** Add `trace-core.mjs` to the builder's file
list. Add `lib/*.mjs` to the package's `files`. Add `lib/trace-core.mjs` to the
pinned packed-file list. The package test's install and `--help` checks then
prove the published CLI can load the core.

**Modify `src/feature-flags.ts`.** Export `TRACES_FLAG = "traces"`, and widen
`ShipletFeatureFlagKey` to the union of both flag constants.

**Modify `src/cli/shiplet.cjs`.** Add a `trace` command group using the existing
`--api-url`, `--token`, `SHIPLET_API_KEY`, and `--json` handling.

- Require `./trace-core.mjs` lazily inside the handlers.
- Each command bootstraps at most one CLI session and passes it as
  `sessionFetch` to every request it makes, so a multi-request `pull` opens
  one browser login, as the revision commands do.
- JSON requests go through `requestKernel` with `maxResponseBytes` of 2 MiB.
  Attachment bytes use a new binary request helper with a 20 MiB cap.
- The upload request times out after 120 seconds. On a timeout or 5xx it
  retries once with the identical body, and the server's digest check (step 1)
  makes that safe.
- A 404 `traces_not_enabled` prints "Traces are not enabled on this server."
- On a 401 `cli_session_reauth_required`, it drops the cached reusable session
  (`session-cache.cjs`), runs browser login once, and retries the request.

Commands:

- `trace share <path>|--current --shiplet <id> [--revision <id>] [--title <t>] [--no-attachments] [--dry-run] [--json]`:
  1. Read the files and run the client pipeline. `--no-attachments` adds
     `dropAttachments` before validation.
  2. Print the chosen files, the masked counts by kind, and the upload size.
  3. If the body exceeds 16 MiB, stop with "Trace is <n> MiB; uploads are
     limited to 16 MiB until multipart upload ships." Add "Retry with
     --no-attachments" when that would fit.
  4. Upload unless `--dry-run`.

  Path rules:
  - A folder path means `<folder>.jsonl` next to it plus
    `<folder>/subagents/*.jsonl`.
  - A `.jsonl` path also picks up its sibling `<name>/subagents/*.jsonl` when
    that folder exists.
  - The title defaults to the first user message, cut to 80 characters, else
    the file name.

  `--current` finds the running session and never prompts:
  1. If `CLAUDE_CODE_SESSION_ID` is set, search
     `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<id>.jsonl`. A missing file is
     an error; there is no fallback.
  2. Otherwise, look under `<CODEX_HOME or ~/.codex>/sessions/` in the local-time
     date folders for today and the previous 7 days. Use the newest rollout
     whose `session_meta.payload.cwd` equals the current working directory.
  3. Otherwise, use the newest `.jsonl` in
     `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd with every non-alphanumeric character replaced by ->/`.
  4. Otherwise, fail with "No session found for this folder; pass a path."

  The CLI always prints the chosen file. The trace is private, and `--dry-run`
  shows the choice without uploading, so a wrong pick in cases 2 and 3 is
  visible and harmless.
- `trace list --shiplet <id> [--json]`.
- `trace pull <traceId> --shiplet <id> [dir] [--as context] [--max-tokens n] [--json]`:
  fetches the manifest, every segment, and the attachments, and writes
  `<dir or ./shiplet-trace-<traceId>>/trace.json`, `attachments/<sha256>`, and
  `context.md`. With `--as context`, it fetches the manifest and segments only,
  prints `buildContext` output, and writes nothing.
- `trace delete <traceId> --shiplet <id> [--json]`.

**Create tests and fixtures.**

- `test/fixtures/traces/`:
  - `claude-code-main.jsonl`, with a compaction summary, an inline image, a
    `<system-reminder>`-only message, an inline sidechain record, and a
    half-written last line;
  - `claude-code-main/subagents/agent-a1.jsonl`;
  - `codex-rollout.jsonl`, with assistant messages, reasoning, each tool-call
    record type, a passing JSON output, and a failing plain-text `Exit code: 1`
    output.
  All are synthetic, with no real secrets.
- `test/trace-core.spec.ts`:
  - `parseJsonl` skips the bad line;
  - `normalize` produces the expected events for each fixture, including
    ordering, agent IDs, subagent markers, and the Codex tool table;
  - every D6 kind is masked;
  - non-secrets stay unmasked: commit SHAs, emails, `max_tokens: 32000`,
    `password: string`;
  - masking is idempotent;
  - a secret straddling a truncation cut is still masked, because masking runs
    first;
  - masked text attachments are re-hashed and merged;
  - an event with a huge `tool.input` is reduced under 512 KiB;
  - segments split at both the event limit and the byte limit;
  - `dropAttachments` leaves a valid upload;
  - each `validateUpload` rejection, including every top-level field;
  - `buildContext` keeps the summary under a tiny budget and elides in the D13
    order.
- `test/trace-api.spec.ts` (Workers pool, using `withFeatureFlags("traces", ...)`):
  - every route's success path, list pagination, and the `TraceSummary` shape;
  - flag off returns 404 `traces_not_enabled`; R2 missing returns 503;
    over 16 MiB returns 413; over quota returns 413; a foreign revision returns
    400; an archived Shiplet returns 409;
  - a repeated identical upload returns 200 `duplicate` with no second row;
  - another org member, an org admin, and an anonymous viewer of a public
    Shiplet each get 404 on read;
  - an API key reads only its own uploads;
  - permanent Shiplet deletion removes the trace rows and the R2 prefix,
    including an orphaned object;
  - a CLI session without trace scopes gets 401 `cli_session_reauth_required`;
  - a generated upload just under 16 MiB succeeds, which checks memory headroom
    in the test runtime. If it fails, slice 1 switches the server to processing
    one segment at a time before merging;
  - the first failing test (below).
- `test/cli.spec.ts`:
  - `trace share --dry-run` against the fixtures, with masked counts in
    `--json`;
  - `--current` resolution in all four cases, with a temporary `HOME`,
    `CLAUDE_CODE_SESSION_ID`, and `CODEX_HOME`;
  - `--no-attachments`;
  - one session bootstrap per `pull`;
  - on `cli_session_reauth_required`, the cached session is dropped and login
    runs once;
  - the retry with an identical body;
  - `trace pull --as context` against a stubbed server.

### Acceptance check that should fail first

Write this test in `test/trace-api.spec.ts` first: "a secret that skipped
client masking is masked on ingest". It posts, with an owner session, a valid
upload whose `tool_result` text contains `shiplet_org_` followed by 24
alphanumeric characters, with `clientMasking.count` 0. It expects 201 with
`serverMasked.count` 1 and `kinds["shiplet-api-key"]` 1. Reading segment 0 as
the owner must contain `[secret:shiplet-api-key]` and not the key. It fails
until the core, route, and store exist.

### Rollback

Turn off the `traces` flag; every route returns 404 and the CLI reports traces
disabled. The table, indexes, R2 prefix, and new scopes are additive. Removing
traces entirely is `DROP TABLE project_traces` and deleting the `traces/`
prefix; no other table references them.

## Later slices

2. **Sharing.** Covers:
   - audiences (a `trace_audiences` table), D5 resolution, and profiles with
     every D3 rule;
   - the `sharing` flag, with admins reading shared traces (D2);
   - variant rendering (D12) with preview, and the CLI `--audience`, `--share`,
     and `--private` flags;
   - large files as deferred attachments;
   - session-produced files (D9);
   - the D18 retention sweep.

   Retires the risk that matters most: a reader seeing more than their level.

   **Built.** What shipped differs from this outline in places:
   - **Large files.** Instead of multipart event upload, the event JSON stays
     at most 16 MiB per request. Attachments up to 20 MiB each can be declared
     `deferred` (binary types only; text is always inline so it is masked) and
     sent afterwards with
     `PUT /api/shiplets/:id/traces/:traceId/attachments/:sha256`. Until then,
     reads of them return 404 `attachment_pending`. Raising the 16 MiB event
     limit is still open.
   - **Audience API.** `GET` and `PUT /api/shiplets/:id/traces/:traceId/audiences`
     replace the whole set (`{ sharing?, audiences? }`; omitting `audiences`
     keeps the current set and changes only `sharing`), and
     `POST .../preview` renders a profile without storing it.
   - **Reads.** Reads return the reader's level in `access`.
   - **CLI.** `shiplet trace audiences` and `shiplet trace preview`, plus
     `--audience <type>:<id>=<level>` and `--audiences <file.json>` on share.
   - **Schema.** These tables are kernel schema epoch 6.
3. **MCP parity.** `openapi.json` entries, Code Mode dispatcher branches and
   allowlist entries, and `traces:*` agent permissions. Covers list, read,
   `getTraceContext` (paginated), share, audiences, profiles, and preview, plus
   upload URLs (D7) and a cross-Shiplet listing of readable traces
   (`GET /api/traces`). Retires the agent-driven path, including colleagues
   pulling traces from any Shiplet they can read.

   **Built.** What shipped:
   - **Operations.** `listReadableTraces` (`GET /api/traces`), `listTraces`,
     `getTrace`, `getTraceSegment`, `getTraceContext`, `getTraceAudiences`,
     `setTraceAudiences`, `previewTraceProfile`, `deleteTrace`, and
     `createTraceUploadLink`, all Code Mode operations sharing the REST
     handlers in `src/traces/handlers.ts`. `createTrace` and
     `uploadTraceWithLink` are REST only.
   - **Upload links.** They live 30 minutes and create one trace. The
     creator's access is rechecked at use, and attachments go to
     `<link>/attachments/<sha256>`.
   - **CLI.** `shiplet trace share --current --upload-url <link>` uploads with
     a link and no sign-in.
   - **Agents.** Delegated agents need `traces:read` or `traces:write` and are
     limited to their selected organization.
   - **Deletes** now return `200 { deleted: true }`, so every operation has a
     JSON success schema.
   - **Schema.** Kernel schema epoch 7.
   - **WorkOS.** Agents registered through WorkOS can be granted the new
     permissions only after they are added to the WorkOS application; that is
     an operator step.

4. **Dashboard.** Trace list on each Shiplet, the D15 viewer (as a Traces tab
   and as the page of a trace-only Shiplet, D19), the share screen (ladder plus
   simple rules, with preview as each audience), and the D14 drop zone.
   Retires browse-before-pull for colleagues.
5. **Native resume (experimental).** Write a Claude Code or Codex session from a
   trace for `--resume`, behind a flag, per harness version. Do it only if
   context handoff proves too thin.

## Open questions

1. **Quota and pricing.** Are 10 GiB per organization and 1 GiB per user the
   right defaults, and do they differ by plan?
2. **Codex current session.** No Codex environment variable for the running
   session was found. If Codex exposes one, `--current` should use it before
   the newest-rollout fallback.

## Owner decisions recorded 2026-11-18

- Organization admins read every shared trace; private traces stay private
  (D2).
- Archived Shiplets' traces expire sooner: 7 days (D18).
- A trace-only Shiplet is an ordinary Shiplet whose page is the shared trace
  viewer (D19).
- A session's other files (screenshots, videos, images) are kept with the trace
  (D9).
- The dashboard drop zone recommends asking the agent first (D14).

## Related finding outside this plan

`deleteProjectPermanently` (`src/index.ts`) deletes D1 records and, best-effort,
static asset objects and the custom hostname. Nothing in `src/` deletes
review-feedback screenshots or `review_feedback_attachments` objects from
`REVIEW_ASSETS`; the only delete there discards a rejected screenshot
(`discardReviewScreenshot`, `src/review.ts`). Those objects appear to remain
after a Shiplet is permanently deleted. Slice 1 deletes trace objects
explicitly, so traces do not inherit this gap.
