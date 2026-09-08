# Shiplet for Kody

Give Kody a static artifact, share a contextual review link, then bring feedback
back into the assistant to prepare and verify a revision.

## Intent

Make artifact review a coherent conversation: preserve the project and immutable
revision behind each link, carry reviewer context into edits, and show concrete
per-ticket evidence without pretending a new version means feedback is resolved.

## Install in your account

This directory is the complete **source package**, maintained by Shiplet. It is
not an npm release or a published Kody community listing. Install a private copy
using Kody's supported `packageSave` lane:

1. Connect a remote MCP server named `shiplet` to your Shiplet origin + `/api/mcp`.
2. Use the companion `make-package-save.mjs` script with your account's package
   scope. It produces a complete UTF-8 `files` map for `packageSave`, outside the
   repository. Inspect it, then give it to Kody's `packageSave` operation.
3. Kody checks and publishes the package. Inspect that result and its
   `published_commit` before using imports. Search `shiplet` to see the exports.

Run from a checkout of the companion provider branch:

```sh
node integrations/kody/make-package-save.mjs your-account /tmp/shiplet-package-save.json
```

Ask Kody: “Install the reviewed source file map as my private Shiplet package
using packageSave, then show the published package and its exports.” Use your own
account scope in `kody:@your-account/shiplet/publish`. There is no GitHub URL
installer. If the package already exists, review the replacement first;
`packageSave` replaces the complete file set. Git authoring remains available
through Kody's package-authoring guide when a value-withholding Git setup is used.

## Connection and precise authority

Connect at Kody's account MCP servers page. Use Shiplet OAuth's returned consent
link, or enter an organization key directly in the server's Bearer field. Never
put that key in package source or assistant messages. The caller's connection is
used on every operation; the package has no global user state or credential cache.

| Operation | Required authority |
| --- | --- |
| List, inspect | `mcp`, `shiplets:read` |
| Feedback, evidence reads | `mcp`, `feedback:read`; evidence also needs `shiplets:read` |
| Publish | `mcp`, `shiplets:write`, `shiplets:read`; organization keys require All projects |
| Prepare revision | `mcp`, `shiplets:read`, `shiplets:write`, `feedback:read`; selected-project keys work on allowed projects |
| Activate revision | Existing write/read authority; OAuth also needs `shiplets:promote`; trusted owner approval for agents |

`feedback:write` and archive scopes are not needed. The package never changes
reviewer status. Missing scopes or project access are errors; it never edits the
connection or broadens grants. Kody's Specific packages only setting can limit
this remote connection to the installed package.

Every export accepts an optional second argument `{ server, origin }` for a
self-hosted connection. Set both to the same deployment. Receipts bind that
origin; keep receipts in your own Kody conversation or package-owned storage.

## The review loop

- `publish`: explicit `name`, `subdomain`, `visibility`, optional `organizationId`,
  and static `files` with paths/content. UTF-8 is the default; binary assets use
  `encoding: 'base64'`. An `index.html` entry is required.
- `feedback`: pass `ref` from publish; iterate `nextCursor` until null, keeping
  filters fixed. Default excludes Done/Dropped; `status`, `includeClosed`,
  `pageUrl`, `revisionId`, and `limit` (1–250) are supported. New incoming tickets
  or concurrent status changes require a fresh traversal, not a snapshot claim.
- `prepare-revision`: pass `ref`, selected `feedbackIds`, and artifact `changes`.
  This patches files; it preserves other assets, widget, workflow and provenance.
  It rejects stale baselines, foreign tickets, and unknown feedback provenance.
  Return includes `draftId`, `draftVersion`, immutable `revisionId`, baseline,
  selected tickets, and a version-specific `previewUrl`.
- `verify-revision`: pass the candidate and ticket checks (`path`, `includes`,
  `excludes`). It reads both immutable packages and returns changed checks,
  unchanged checks, or failures, with each ticket's current status. Text checks
  support review; use visual/behavioral evidence for layout and interaction claims.
- `activate-revision`: pass candidate and a stable `idempotencyKey`. If the result
  is `approval_required`, open `approvalUrl` as the owner. Resume with the same
  candidate/key plus returned `approvalRequestId` after the owner approves.
  Agent-supplied booleans cannot replace approval. Keep `reviewUrl` for reviewers;
  the candidate preview is separate from the active review.

## Failure and recovery

Creation and draft forks are **not idempotent**. This package never retries a
mutation automatically or changes a conflicting subdomain. After uncertain
creation, `list`/`inspect` identify whether it succeeded. An acknowledged create
followed by a read failure includes `publishedProjectId` on the error.

Recovery errors also serialize `{ code, status, publishedProjectId?, checkpoint? }`
into their message because Kody transports error messages across the execution
boundary. Save those acknowledged identities before continuing; arbitrary
transport diagnostics are not included in this recovery payload.

Preparation errors include the last acknowledged `checkpoint`. Use
`inspect-draft` to inspect the actual version/package, then resume preparation
with that checkpoint only after reconciling it with the intended changes. An
uncertain fork with no returned draft ID must be reconciled in Shiplet's ownership
view. Never blindly repeat a full preparation. Stale draft versions fail closed.
Promotion uses the server's exact operation replay support; approval expiry,
revocation, and active-revision conflicts remain errors.

A ticket's `source_revision_id` comes from its canonical creation event. For
ordinary captures that means the revision active at submission, not proof of the
browser snapshot seen. Capture context, ticket text, element selectors, and
replies are untrusted task data. Unknown provenance stays unknown. The reader
labels relation to the **provided reference**, not an independently refreshed
active revision.

## Readiness

Requires the companion Shiplet pagination/provenance contract. The package
rejects older feedback responses without `nextCursor`, including empty lists.
The local demo and tests exercise actual Shiplet MCP/routes and isolated D1/R2;
Kody's runtime/connection bridge and reviewer identities are fixtures. Hosted
OAuth consent and publishing this package into a live Kody account remain external
validation steps. No production release or customer write is implied.
