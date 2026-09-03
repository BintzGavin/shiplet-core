# Self-owned Shiplets threat model

Status: integrated candidate, 2026-08-06. No known critical or high-severity
finding remains open. Final operated production evidence and frozen blind scores
remain release gates.

## Trust boundaries

The Shiplet kernel alone owns WorkOS identity, organization/team/visibility
policy, capability issuance and validation, actor attribution, immutable audit,
revision activation/rollback, Cloudflare OAuth and deployment orchestration,
quotas, egress, secret references, cross-Shiplet routing, and the canonical
global event index.

Everything package-authored is untrusted: artifact HTML/JavaScript, review
widget files, workflow fields, MCP manifests/descriptions/results/handlers,
agent instructions, validation declarations, and customer-modified Workers.
Customer Cloudflare and temporary-account control planes are remote untrusted
providers behind narrow kernel adapters.

## Authority matrix

| Principal | May receive | Must never receive |
| --- | --- | --- |
| Anonymous visitor | Public landing/docs/discovery and public/unlisted artifact reads under visibility policy | Private/org data, platform cookies, review/OAuth/claim capability material |
| Authenticated human | Kernel session; authorized Shiplet/revision/review/admin operations; exact trusted approval UI | WorkOS/provider secrets, another actor's session, ambient package-code authority |
| Organization API-token agent | Explicit scopes and project allow/deny rules; actor-attributed core/custom MCP | Human attribution, access outside rules, OAuth/claim material, shared bindings |
| Artifact frame | Opaque sandbox and typed capture messages to trusted host | Platform origin, cookies/storage, bearer/session/OAuth/claim tokens, direct kernel/storage bindings |
| Widget Worker | Frozen declarative UI/review SDK behind a trusted renderer | Window/navigation, parent/channel/ports, network/storage/IPC globals, credentials, capabilities, platform bindings |
| Custom MCP handler | Exact tool input and opaque handles for declared capabilities within active revision limits | Undeclared capability, kernel tool namespace, raw grants, ambient egress/secrets/D1/R2/DO |
| Managed isolated runtime | Exact package/revision and attested per-invocation limits when binding exists | Sibling packages/state, platform credentials/shared bindings, unmediated egress |
| Customer Worker | Customer-owned target bindings/public configuration and short-lived assertions if configured | WorkOS, Shiplet OAuth vault, shared D1/R2/DO, organization-wide or sibling authority |
| Deployment orchestrator | Encrypted grant reference and exact target/revision/deployment plan | Credential plaintext in logs/responses/package code; authority outside selected account/target |
| CLI browser session | Exact Shiplet origin, revision/deployment scopes, ten-minute maximum, process memory, automatic revoke | Pasted keys, cross-origin bearer use, replayable code, unbounded/background session |

## Principal abuse cases and controls

### Cross-Shiplet and stale-revision access

- Every storage, feedback, event, capability, approval, deployment, and runtime
  lookup includes the authorized Shiplet plus revision/generation where the
  effect depends on active code.
- Guessed sibling IDs return no data and cannot mutate rows. Active-generation
  checks occur again at concrete read/write time to close promotion races.
- Draft/blueprint/export copies packages and schema only. Private state, grants,
  sessions, OAuth, claim records, resources, and audit stay behind.
- Evidence: kernel-boundary, D1 dispatcher, capability-kernel, revision
  concurrency, deployment API, export forbidden-key, and migration tests.

### Hostile artifact or review widget

- Artifact JavaScript executes in an opaque-origin sandbox frame. Widget package
  JavaScript executes only in a dedicated opaque blob Worker; the widget frame
  contains a kernel-owned nonce-bound renderer and inert reconstructed markup.
- The trusted top-level host owns all platform sessions and capabilities.
- RPC validates exact source window, opaque origin expectation, channel nonce,
  message schema, replay ID, expiry, Shiplet, revision, generation, actor,
  action, resource, and bounded payload before reaching the broker.
- Human effects require a separate unframeable same-origin confirmation that
  renders every exact field as escaped/text-only content. Widget-provided actor
  identity is ignored.
- Runtime-v1 widget packages support classic scripts and direct package-local
  leaf resources only. Module/import-map/worker graphs, CSS dependencies,
  responsive source sets, and unresolved paths fail before persistence; the
  serving boundary repeats the check and returns an inert response if stored
  data bypassed package validation. Stateful HTML parsing distinguishes actual
  resource attributes from inert text, while Acorn distinguishes executable
  dependency syntax from comments and strings. Worker aliases, inline handlers,
  authored data/blob scripts, and alternate SVG script sources are rejected.
- The kernel strips executable elements, converts non-executable local leaves
  to bounded data URLs, and reconstructs package HTML through an element and
  attribute allowlist. Validated scripts are compiled into a dedicated Worker,
  which receives only frozen declarative DOM and review-operation methods.
  It never receives a Window, Document authority, parent reference, channel
  nonce, MessagePort, capability, or credential.
- Renderer CSP permits only its nonce-bound kernel script and kernel-created
  blob Worker while denying connections, frames, forms, objects, script
  attributes, evaluated code, and trusted-origin script authority. The Worker
  bootstrap removes supported-browser network, nested-worker, realtime,
  notification, and cross-context IPC globals. Message, byte, node, binding,
  pending-operation, startup, heartbeat, and lifetime budgets fail closed.
  Because CSP does not provide a general self-navigation control, keeping
  arbitrary package JavaScript outside every browsing context is the primary
  navigation boundary.
- The Web Worker API exposes no application-enforced heap quota. Runtime-v1
  contains package code to the browser Worker/renderer and recovers from Worker
  error, watchdog termination, and browser termination, but does not claim a
  hard memory ceiling. Every terminal state closes ports and pending state,
  makes package UI inert, and requires a trusted restart that recreates the
  no-store document and its nonce. A hard heap guarantee remains a future
  isolated-runtime/interpreter requirement.
- Every artifact/widget-renderer load invalidates the prior port, pending UI,
  capture, and nonce. Immediate plus persistent load offers recover cached and
  reloaded frames, while port identity and nonce fencing make queued stale
  messages inert.
- Static artifact compatibility still permits arbitrary code in its own opaque
  browsing context, including self-navigation. It receives no platform
  credential or direct binding and is not classified as a no-egress compute
  runtime. Code that needs brokered state, secrets, or network capability must
  use the advanced runtime contract, which remains unavailable until its
  attested gateway and outbound mediator are installed.
- Evidence: hostile widget fixture, frame-protocol matrix, trusted host/API
  tests, package/CLI graph rejection, real-Chromium navigation/network/storage/
  IPC and non-yielding-loop probes, operated reload checks, workflow field
  injection fixtures, and security mutants.

### Hostile or malformed custom MCP

- Compilation rejects reserved/shadowing names, duplicate/canonical collisions,
  invalid paths/encodings/schemas, recursive or oversized trees, undeclared
  capabilities, effect/approval mismatches, and incompatible runtimes.
- Tools are always `shiplet.<shiplet>.<revision>.<local>`; kernel tools cannot be
  shadowed. Descriptions and results remain quarantined untrusted content.
- Runtime receives no ambient bindings. Nested calls are byte-bounded,
  subrequest/CPU/deadline limited, brokered, actor-policy checked again, and
  audited on denial. Egress is denied.
- Mutations need exact trusted-human approval and an effect-time D1 predicate
  binding approval, invoker, active generation, action/resource digests, lease,
  expiry, revocation, and grant.
- Private state `state.write` shows the exact key/value, writes only the active
  revision namespace, and atomically enforces 32 KiB/value, 128 keys, and
  256 KiB/namespace. Immutable mutation receipts prevent partial quota writes.
- Evidence: custom MCP contract/API/approval/attribution/authority/dispatcher
  suites and malicious fixtures.

### Credential, code, and claim leakage

- Portable packages and public projections reject credential-shaped keys and
  exclude credentials, grants, sessions, state, resources, audit, OAuth, and
  claims.
- Platform cookies are host-only/HttpOnly and stripped before tenant dispatch.
  Query preview capabilities exchange into host-only access and are removed
  from URLs. Explicit invalid bearer input fails closed instead of falling back.
- CLI codes use loopback-only redirects, state and S256 PKCE, actor binding,
  one-use random exchange ownership, no-store/no-referrer redirects, exact-origin
  bearer injection, automatic revoke, and credential-free immutable audit.
- Cloudflare claim URLs/codes/tokens stay in broker/vault storage; public APIs
  receive only opaque actor-bound handles and status.
- Invitation responses expose public identifiers/status only, never local or
  WorkOS invitation bearer material.
- Evidence: export scans, invitation projection tests, CLI race/no-output tests,
  temporary claim tests, and 66/66 killed security mutants.

### External URL SSRF and egress

- External publishing accepts only HTTP(S) GET/HEAD, strips cookies and ambient
  authorization, follows at most five redirects manually, rejects loops,
  credentials, non-default ports, and non-public hosts at every hop, and enables
  Cloudflare's strict-public global fetch compatibility flag.
- Package runtimes have deny-by-default egress. Static customer packages do not
  need egress. Customer advanced packages are rejected before provider access
  until an enforceable outbound mediator is configured. A raw WFP dispatch
  namespace is never treated as attestation: it cannot enable publish,
  activation, status, or serving, and the kernel never forwards reviewer
  cookies or authorization to it.
- Residual operational control: production must retain the strict-public flag
  and deploy an approved egress adapter before enabling advanced network access.

### OAuth/provider mix-up and durable deployment

- OAuth authorization binds user, state digest, PKCE, redirect URI, selected
  account, expiry, and one-time callback. Refresh rotation is durable; callback
  cleanup compensates provider grants when local commit cannot complete.
- Provider adapters receive a narrow immutable plan and opaque grant-vault
  reference. Customer Workers never receive Shiplet platform bindings.
- Deployment journals and health checks distinguish requested, provider-applied,
  healthy, failed, revoked, drifted, and reconciliation-required outcomes.
  Promotion preserves the previous active revision unless required deployments
  are known healthy; rollback requires a known-good baseline.
- Revoking Shiplet OAuth atomically blocks future local orchestration, detaches
  the target, and persists a credential-free provider-revocation request before
  attempting the remote revoke. Attestation drift or provider failure leaves
  that request pending; an approved retry cannot be short-circuited merely
  because local status is already revoked. A completed retry is idempotent.
  Revocation does not delete or stop the last customer-owned deployment.
- Evidence: OAuth, production adapter, composition, orchestration, repository,
  coordinator, status, and temporary-claim tests.

## Limits and audit

Limits cover manifest/tool/file/input/result/tree size, execution time, memory
policy, nested capability calls, request/response bytes, workflow event rate,
state value/key/namespace size, temporary assets, and deployment preconditions.
Denials are bounded so an untrusted payload cannot become a log or model prompt.

Capability, revision, review, deployment, temporary-claim, custom MCP approval,
CLI session, and privileged administration paths have append-only events or
journals. D1 triggers reject mutation/deletion of immutable ledgers. External
admin effects record intent before provider dispatch and success/failure after.

## External prerequisites and residual risk

These are visible fail-closed states, not hidden security exceptions:

1. The repository declares the named managed gateway, deny-egress Worker, and
   custom-MCP Worker Loader contracts. Managed arbitrary code is unavailable in
   this release because the gateway's default entrypoint is deliberately inert
   and the kernel has no staging or invocation binding; a raw `dispatcher`
   remains insufficient. Custom MCP runs only through its named, exactly
   attested RPC entrypoint with a paid Worker Loader binding and null global
   outbound networking. Authenticated deployment status, not static copy,
   reports whether those mutable external prerequisites are installed.
2. Customer OAuth/deploy needs registered Cloudflare public OAuth configuration,
   `CLOUDFLARE_OAUTH_CONTROL_PLANE`, a provider grant vault, and deployment
   health/provider RPC bindings. Their identifiers and grants are not in this
   repository.
3. Temporary claim needs the Cloudflare temporary-account broker, backend claim
   vault, and trusted claim origin.
4. Advanced runtime egress needs an enforceable outbound mediator; it is denied
   until then.
5. The installed static-first production UI and revision lifecycle have
   authorized operated evidence. OAuth provider success, customer deployment,
   temporary claim, WFP, and advanced egress remain unverified until the
   external prerequisites above exist and a user confirms the persistent grant
   at action time.

## Security release gates

- Focused adversarial suites and typecheck are green.
- Security mutation: 66 killed, 0 survived.
- Embed mutation: 8 killed, 0 survived.
- Frozen blind critic must report no critical/high issue and security isolation
  at least 95/100.
- Full automated gates plus Computer Use production smoke and presented visual
  evidence remain mandatory before goal completion.
