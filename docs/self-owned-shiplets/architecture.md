# Self-owned Shiplets architecture specification

Status: integrated candidate, 2026-08-06. Cloudflare-specific details are
grounded in current official sources recorded in `cloudflare-research.md`.
The existing static-first behavior remains the compatibility floor; production
bindings and operated smoke evidence remain release prerequisites.

## Model and ownership

Shiplet remains one trusted kernel around untrusted portable applications.

```text
WorkOS identity / organization policy
                |
                v
        +-------------------+
        | Shiplet kernel    |
        | authz, broker,    |
        | audit, activation,|
        | deploy, secrets   |
        +----+---------+----+
             |         |
 scoped RPC  |         | scoped orchestration
             v         v
 sandboxed artifact +  managed WFP or customer-owned
 trusted widget render Cloudflare revision deployment
             |
             v
 opaque widget Worker
```

The kernel exclusively owns identity, authorization, capability issuance and
validation, actor attribution, immutable audit events, activation/rollback,
Cloudflare OAuth and deployment orchestration, quotas/egress, secret access,
cross-Shiplet routing, and the global event/inbox index. Package content is
always untrusted data, even when authored by an organization owner.

## Domain objects

- **Shiplet**: stable collaborative identity. Existing `projects.id` remains
  its compatibility identifier and URL owner.
- **Package**: portable, credential-free application definition.
- **Draft**: mutable working copy with `base_revision_id` and an optimistic
  `version`. It is not a revision and never runs as active.
- **Revision**: immutable validated package snapshot and digest with parent
  lineage. A revision may be previewed and deployed to multiple targets.
- **Deployment target**: `managed`, `customer_cloudflare`,
  `temporary_claim`, or `detached`, with independent ownership/connection
  metadata.
- **Deployment**: one revision installed on one target. Deployment health and
  drift do not mutate the revision.
- **State namespace**: deployment runtime data is keyed by Shiplet plus
  deployment/application namespace. Kernel-brokered package MCP state is keyed
  by Shiplet plus active revision so a fork/promotion never inherits private
  values implicitly. Neither form is included in a package or fork.

## Portable package v1

The canonical unpacked layout is:

```text
shiplet.json
artifact/**
widget/**
workflow/schema.json
mcp/manifest.json
mcp/handlers/**
AGENTS.md
validation/manifest.json
provenance.json
```

Transport uses media type `application/vnd.shiplet.package+json;version=1`.
The transport is a deterministic JSON envelope containing `manifest` and a
sorted array of file entries `{path, mediaType, encoding, content, sha256,
size}`. `encoding` is `utf8` or `base64`. This avoids platform-specific archive
semantics in v1; CLI `pull`/`eject` materializes the canonical layout.

`shiplet.json` contains:

```json
{
  "schemaVersion": "shiplet.package/v1",
  "runtimeCompatibility": "shiplet.runtime/v1",
  "entrypoints": {
    "artifact": "artifact/index.html",
    "widget": "widget/index.html",
    "workflow": "workflow/schema.json",
    "mcp": "mcp/manifest.json",
    "agentInstructions": "AGENTS.md",
    "validation": "validation/manifest.json",
    "provenance": "provenance.json"
  },
  "requestedCapabilities": [],
  "limits": {},
  "staticFirst": true
}
```

Rules:

- Paths are normalized POSIX relative paths: no empty segments, dot segments,
  backslashes, control characters, absolute paths, or collisions after Unicode
  normalization/case folding.
- Entry, file, decoded-size, package-size, count, manifest-depth, and string
  limits are enforced before persistence.
- Digests cover the canonical manifest and every sorted file entry. A revision
  digest therefore changes for artifact, widget, workflow, MCP, instructions,
  validation, or provenance changes.
- Requested capabilities are declarations, never grants. Importing or forking
  a package creates no authority.
- Provenance records lineage and source metadata but never sessions, grants,
  tokens, state, audit events, claim URLs/codes, or customer resource secrets.
- Unknown required schema/runtime versions fail closed. Unknown optional fields
  are preserved only within explicitly extensible objects.
- `shiplet.runtime/v1` widgets use classic JavaScript plus direct package-local
  leaf resources. The kernel parses the package HTML as inert input, removes
  executable elements, converts non-executable leaves to credentialless data
  authority, and compiles the validated classic scripts into one opaque blob
  Worker. The trusted renderer reconstructs markup from an element and
  attribute allowlist; package JavaScript never receives a browsing context.
  ES modules, import maps, dynamic imports, nested workers, CSS dependency
  graphs, `srcset`, and missing or escaping references are rejected during
  package and CLI validation. Supporting those graphs requires a future runtime
  compatibility version; runtime-v1 never widens CSP to the trusted Shiplet
  origin.
- Kernel validation and delivery use the same stateful HTML parser for
  resource attributes, including quoted and unquoted values; attribute-shaped
  strings inside scripts are never rewritten. The CLI mirrors that structural
  parser and uses Acorn syntax trees so comments/strings cannot create false
  module or Worker dependencies.
- Runtime-v1 rejects inline event-handler attributes and every package-authored
  Worker, SharedWorker, or importScripts identifier form, including aliases and
  member access. Widget CSP permits only the kernel-created blob Worker, denies
  connections, frames, forms, objects, script attributes, and evaluated code,
  and gives the renderer script nonce-only authority.
- Executable leaves must be package-local HTML `script[src]` resources. Authored
  data/blob script sources and SVG `script[href]`/`script[xlink:href]` forms
  fail closed. The kernel extracts validated classic script bytes before the
  renderer parses the inert package template.

### Runtime-v1 widget compartment

The widget response is an opaque-origin sandbox document, but that document is
kernel code, not package code. It has a fresh nonce-bound renderer,
`worker-src blob:`, `connect-src 'none'`, `frame-src 'none'`,
`form-action 'none'`, and no
ambient trusted-origin script source. The renderer creates a dedicated blob
Worker containing the validated package scripts. The Worker receives a frozen
`shipletWidget` API and a deliberately small compatibility `document` facade;
it has no Window, parent, channel nonce, MessagePort, credential, or capability.

The renderer accepts only bounded declarative text, attribute, property, and
event-binding messages. Review operations are limited to the declared widget
operations and still traverse the revision/source/nonce-bound trusted-human
confirmation channel. Message count and byte budgets, binding and pending
operation caps, startup and lifetime limits, and a heartbeat watchdog terminate
malformed, flooding, or non-yielding package code without disabling trusted
review controls. Every terminal state closes the Worker and channel, clears
pending/binding state, makes package UI inert, and exposes a trusted restart
action. Its exact source/origin/nonce/Shiplet/revision-bound request asks the
trusted parent to reload the no-store renderer, so the nonce, Worker, channel,
timers, and pending state are recreated together without granting the sandbox
self-navigation authority.

Browser Web Workers do not expose an application-controlled heap ceiling.
Runtime-v1 therefore promises browser/renderer containment and recovery, not a
hard per-widget memory quota. Browser process enforcement may terminate the
Worker or renderer under memory pressure; an enforceable heap limit requires a
future isolated runtime or embedded interpreter. This limitation is explicit
and is not presented as a kernel-enforced resource guarantee.

The Worker bootstrap removes the browser network, nested-worker, realtime,
notification, and cross-context IPC globals available in the supported Chromium
runtime. That deny list is defense in depth around the non-browsing compartment:
new browser APIs are unsupported until executable browser and mutation checks
prove them closed. The boundary follows the
[W3C Content Security Policy](https://www.w3.org/TR/CSP/),
[WHATWG iframe sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox),
and [WHATWG Worker](https://html.spec.whatwg.org/multipage/workers.html) processing
models; because CSP has no general self-navigation directive, arbitrary widget
package code is never given a browsing context.

## Data model and additive migration

Existing `projects` remains the Shiplet table. Add nullable
`active_revision_id` and `revision_migrated_on`; existing rows keep working
through the legacy adapter until migration completes.

New tables are additive:

- `shiplet_drafts(id, project_id, base_revision_id, package_json,
  package_digest, version, validation_state, validation_report_json,
  validated_revision_id, created_by_actor_kind, created_by_actor_id,
  created_on, updated_on)`.
- `shiplet_revisions(id, project_id, parent_revision_id, package_json,
  package_digest, runtime_compatibility, validation_report_json,
  created_by_actor_kind, created_by_actor_id, created_on)`.
- `shiplet_revision_files(revision_id, path, media_type, size, object_key,
  content_base64)` for indexed/static serving and optional R2 offload.
- `shiplet_capability_grants(id, project_id, revision_id, actor_kind,
  actor_id, capability, resource_json, constraints_json, issued_on,
  expires_on, revoked_on)`; package requests never write this table directly.
- `shiplet_audit_events(id, project_id, revision_id, deployment_id,
  actor_kind, actor_id, event_kind, summary, status_category, payload_json,
  occurred_on, recorded_on)` with database triggers rejecting update/delete.
- `shiplet_state(project_id, deployment_id, namespace, key, value_json,
  byte_size, version, updated_on)` for deployment-owned kernel state.
- `shiplet_mcp_state(namespace, state_key, value_json, updated_on)`,
  `shiplet_mcp_capability_dispatches`, and immutable
  `shiplet_mcp_state_mutation_receipts` for active-revision package state,
  effect journals, and atomic quota proof.
- `shiplet_broker_grants`, `shiplet_broker_approvals`, and
  `shiplet_broker_uses` for hashed opaque capability handles, activation fences,
  one-use approvals, revocation, and lifecycle metering.
- `cloudflare_connections(id, user_id, account_id, account_label,
  credential_ref, token_expires_on, scopes, connected_on, revoked_on,
  last_refresh_on)`. `credential_ref` is an opaque handle into the platform
  secret store, never ciphertext or token material readable by application
  repositories.
- `deployment_targets(id, project_id, kind, owner_kind, owner_id,
  connection_id, provider_account_id, configuration_json, created_on,
  detached_on)`.
- `shiplet_deployments(id, target_id, revision_id, provider_resource_name,
  provider_version_id, status, health_json, deployed_on, failed_on,
  supersedes_deployment_id)`.
- `deployment_operation_journals`, `deployment_effect_outbox`,
  `deployment_target_resources`, `deployment_temporary_claims`, and
  `deployment_failure_events` for durable two-phase provider coordination,
  reconciliation, exact resource ownership, claim custody, and failures.
- `cli_authorization_requests`, `cli_sessions`, and append-only
  `cli_session_audit_events` for actor-bound loopback PKCE, random one-use
  exchange ownership, scoped short-lived sessions, and explicit revocation.

OAuth material lives behind an established platform secret-store binding and
is referenced only by an opaque `credential_ref`. Plaintext tokens and their
ciphertext are never returned by application store APIs, included in logs or
package JSON, or accessible to untrusted runtimes. The agent phase never reads
or supplies any key or credential value.

Legacy migration is lazy and idempotent:

1. Read the legacy `projects` row and sorted `project_assets`.
2. Construct the exact v1 compatibility package, preserving static,
   external-URL, or Worker source behavior.
3. Insert one immutable revision and its file index.
4. Compare-and-set `projects.active_revision_id` only when still null.
5. Record a non-secret audit/migration marker. Review IDs/history, URL,
   visibility, owner, grants, archive state, and runtime state are untouched.

## Draft, validation, promotion, and rollback

1. `fork` authorizes against the logical Shiplet, copies only the selected
   revision package, records `base_revision_id`, and starts draft `version=1`.
2. Draft updates require `If-Match`/expected version; each successful update
   increments the version.
3. Validation re-parses the whole package, verifies digests, limits, manifest,
   workflow/MCP schemas, requested capabilities, runtime compatibility, and
   declared executable checks. A successful validation inserts or reuses an
   immutable revision and binds it to the exact draft version.
4. Preview addresses the validated revision explicitly; active routing remains
   unchanged.
5. Promotion requires an explicit authorized action and expected
   `base_revision_id`. A conditional `projects` update and audit event occur in
   one D1 batch. A zero-row update is a conflict.
6. Deployment preparation happens before activation when a target must be
   available atomically. Failed validation/deployment never changes the active
   pointer. Target activation happens only after provider health succeeds.
7. Rollback is a new audited activation of a known-good prior revision and, for
   customer Cloudflare, a new deployment selecting that revision’s provider
   version. State is not versioned or silently rewound.

## Trusted review host and capability broker

The current injected `window.__SHIPLET_REVIEW__` bearer-capability model is
removed. The trusted shell owns all credentials and authorization.

- Artifact and widget run in separate sandboxed frames without
  `allow-same-origin`; they have opaque origins and receive no platform cookies
  or bootstrap configuration containing credentials.
- The shell establishes a one-time `MessageChannel` with each expected
  `contentWindow`. The bootstrap message is accepted only from that exact
  source with the expected opaque origin and single-use nonce. Subsequent RPC
  uses the transferred port, monotonically increasing sequence, expiry, and
  Shiplet/revision/channel binding.
- Every message is a versioned discriminated union with maximum depth/size,
  strict known fields, request ID, sequence, action, Shiplet ID, revision ID,
  and capability request. Malformed, replayed, mismatched, or expired messages
  fail closed.
- The browser broker holds no broad bearer token. It calls same-origin kernel
  endpoints with host-only cookies and a short-lived channel assertion bound
  to user, Shiplet, revision, action, and request ID.
- Children never supply actor identity. The kernel derives it from the trusted
  session/API/MCP assertion.
- Passive display reads may be directly brokered. Human-attributed writes and
  other side effects require a trusted-shell user gesture/confirmation surface;
  a child cannot synthesize approval.
- Widget failure or denial cannot remove the trusted shell, default review
  controls, ownership indicator, or recovery action.

Direct tenant URLs render the trusted shell first. The artifact is served from
a dedicated revision path inside the sandbox frame. External URLs are embedded
where their frame policy permits; otherwise the shell exposes an honest
open-origin/review limitation without proxying credentials. Legacy review URLs
redirect or adapt without exposing capabilities in query strings or globals.

## Canonical workflow event envelope

Every accepted custom or kernel event becomes:

```json
{
  "schemaVersion": "shiplet.event/v1",
  "eventId": "event_...",
  "shipletId": "project_...",
  "revisionId": "revision_...",
  "deploymentId": null,
  "actor": { "kind": "human|agent|shiplet|system", "id": "..." },
  "eventKind": "workflow.status_changed",
  "summary": "Review requested",
  "statusCategory": "open|in_progress|blocked|resolved|closed|informational",
  "custom": {},
  "occurredAt": "...",
  "recordedAt": "..."
}
```

Custom status/field names stay in `custom`; the kernel-controlled canonical
category powers inbox, notifications, audit, and MCP. Content is size-limited,
schema-validated, escaped on display, and never interpreted as instructions.

## Custom MCP

- Kernel tools keep reserved names. Package tools are registered as
  `shiplet.<shiplet-id>.<revision-id>.<tool-name>` so simultaneous discovery
  can never confuse two immutable revisions.
- Descriptions, schemas, handler output, and error text are untrusted package
  content. They are returned only in protocol data fields, never spliced into
  kernel instructions or HTML.
- Manifest validation rejects reserved prefixes, duplicates, Unicode-confusable
  collisions, invalid/oversized schemas, undeclared handlers/capabilities, and
  side effects without approval declarations.
- Handler invocation receives a per-call capability object bound to actor,
  Shiplet, revision, tool, call ID, expiry, approved effects, state namespace,
  egress allowlist, and limits. No platform binding is passed through.
- `state.read:review` is read-only. `state.write` is a separate declared
  mutation capability bound to resource `state:private`; trusted confirmation
  renders the exact key/value before effect. D1 enforces 32 KiB per value, 128
  keys, and 256 KiB per revision namespace atomically.
- Custom MCP handlers use a fresh Dynamic Worker for each call, with an
  invocation-local capability RPC and no global outbound network. Missing
  Worker Loader or exact release attestation returns `runtime_unavailable`
  without executing package code in the kernel.
- Side-effecting API-token calls preserve the token as the agent invoker. The
  trusted approval record separately names the exact human approver: grant,
  effect, and canonical audit attribution stay agent-scoped, while confirmation
  and revocation authority remain human-scoped. Both identities are immutable
  and atomically revalidated immediately before the effect.
- Customer-owned handlers run in the customer Worker and may verify short-lived
  Shiplet assertions. They remain untrusted and must request kernel capabilities
  for Shiplet-owned effects.

## Cloudflare targets and deployment

Managed static hosting is always the default and uses the existing Shiplet
kernel plus D1/R2 assets. Managed arbitrary Worker execution is advanced and
uses the revision-aware managed Workers for Platforms gateway. A dispatcher
binding by itself is not readiness evidence.

The main kernel reaches managed application code only through
`CLOUDFLARE_MANAGED_RUNTIME_RPC`. Platform setup selects one exact-scope OAuth
connection in the Shiplet-owned account, then the trusted kernel records a
fixed managed-only reservation for purpose `managed_wfp_provider`. The control
plane holds the encrypted credential and the deployment broker turns it into
bounded provider calls. The gateway receives no Cloudflare credential, and
package code receives no Cloudflare credential. Every invocation starts with
ambient bindings empty and deny-by-default egress through the exact-attested
outbound Worker. Readiness moves through `disabled`, one exact-user
`operator_smoke`, and an explicitly confirmed `enabled` deployment. Custom MCP
remains a separate Dynamic Workers contract.

The active reservation is immutable and tied to the lifecycle operator that
created it. That operator can retire it only through an exact, release-fenced
kernel action that writes a separate immutable retirement audit record. After
retirement, ordinary OAuth revocation is allowed. Customer-owned deployments
continue running because their resources and grants are separate. Managed
Worker operations fail closed until a new fixed reservation is configured and
passes live readiness.

Customer connection uses Cloudflare public OAuth Authorization Code flow with
PKCE, exact registered redirect URI, signed single-use state bound to the
Shiplet user and browser session, explicit account selection, least-privilege
scopes, refresh rotation, and revocation. A connection belongs to one user and
provider account; it is never inferred from organization membership.

Customer deployment uploads an immutable per-revision Worker version, validates
through a preview/health path, then creates an atomic provider deployment. The
Worker receives only its own static assets/resources and public configuration;
no WorkOS secret, shared D1/R2/DO, platform OAuth token, or sibling resource.
Names include non-secret stable Shiplet/target/revision components and are
validated against ownership records rather than trusted from package code.

Revoking Shiplet’s OAuth connection marks the target revoked and blocks future
orchestration. It does not delete or disable the customer-owned Worker. Drift
and health become unknown/unavailable until reconnected.

Temporary preview-and-claim is a separate, static-only target type in Shiplet.
The trusted broker/vault alone receives temporary authorization and the bearer
claim URL; application code receives one opaque, intended-user-bound redirect
handle. Temporary deployments reject arbitrary modules, reserved bindings,
more than 1,000 assets, or an asset over 5 MiB. Claim expires according to
Cloudflare’s contract, transfers ownership, and requires a separate normal
OAuth connection for future Shiplet updates.

The checked-in configuration declares six narrow support entrypoints for the
control plane and runtime gateway. Customer deployment still requires a
registered public OAuth client, healthy exact-version support services, and a
user-scoped connection. Temporary claims additionally require the
temporary-account broker, backend claim vault, and trusted claim origin.
Managed arbitrary code requires the fixed platform reservation plus live
attestation of the revision-aware Workers for Platforms gateway, deployment
broker, two untrusted dispatch namespaces, and deny-egress release. The gateway
stages one opaque script name per immutable revision, verifies health before
activation, routes by the kernel's active pointer, strips platform cookies and
authorization, and applies per-invocation CPU and subrequest limits. Adding only
a raw `dispatcher` leaves publishing, promotion, rollback, status, and serving
fail-closed and performs no provider mutation.

Every non-upgrade kernel response also carries
`x-shiplet-worker-version`, sourced only from Cloudflare's trusted
version-metadata binding. The value is the immutable, non-secret Worker version
ID used for release attestation and rollback diagnosis; version tags and
timestamps are not reflected. Missing or malformed IDs fail closed by omitting
the header. Release smoke compares this header across control-plane, docs,
discovery, and tenant routes with the version Wrangler reports at 100% traffic.

## CLI browser session contract

The shipped CLI uses an ephemeral browser authorization when no established
session is injected. It listens only on `127.0.0.1` at `/callback`, creates
high-entropy state and S256 PKCE, opens the trusted Shiplet consent page, and
exchanges the actor-bound one-use code for a ten-minute session held only in
process memory. The server uses a random per-attempt compare-and-set marker so
same-millisecond exchanges cannot both win. The client pins bearer use to the
exact configured Shiplet origin, never prints it, and revokes the exact session
once the command completes. Authorization request, approval, exchange, and
revocation append credential-free immutable audit rows.

## Isolation, egress, limits, and secrets

- Every storage/API/RPC/deployment lookup begins with an authorized Shiplet
  scope; guessed child IDs are never sufficient.
- Managed user Workers receive no platform binding. A revision-aware gateway
  strips platform auth/cookie headers before invocation, and an outbound Worker
  mediates the exact granted origin/method/path class. Raw `dispatcher.get()` is
  not a supported kernel execution path.
- Deny-by-default limits cover CPU, subrequests, memory where supported,
  request/response bytes, package/storage bytes, state keys, event rate,
  deployment rate, and concurrent builds. Unsupported provider limits are
  enforced at the broker/orchestrator boundary and documented.
- Customer Workers cannot be trusted to honor local limits, so kernel APIs
  enforce limits again on every capability use.
- Customer-owned Workers retain customer-controlled public `fetch`. Shiplet
  enforces deny-by-default egress only for Shiplet kernel capabilities and must
  never describe an unenforceable package metadata flag as remote network
  isolation.
- Secrets are referenced by kernel-owned grant IDs. Package code sees only a
  scoped operation result, never the value. Packages/export/fork cannot contain
  secret grants or resolved values.

## Compatibility and operational truth

Static Shiplets, external URLs, advanced Worker packages, review links,
organization API keys/project rules, WordPress embeds, archived Shiplets,
custom hostnames, sandbox, docs, and discovery routes remain supported through
adapters and representative migration tests. New routes never silently change
legacy active content.

`npm run build` is a value-free deterministic dry run; credential-aware setup
and deployment are separate operations. Production deployment and Computer Use
smoke remain explicit later phases with user confirmation immediately before
any new OAuth grant or persistent access. No adapter/unit result is described
as a live customer deployment without those operated checks.
