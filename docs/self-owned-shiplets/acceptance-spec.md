# Self-owned Shiplets executable acceptance specification

These scenarios are implementation-independent contracts. Each production
slice starts by turning the relevant scenarios into failing automated tests or
an executable acceptance check, recording the observed failure, and only then
changing production code.

## Package and revision lifecycle

### AC-REV-001 — portable package completeness

Given a v1 package containing artifact, widget, workflow, custom MCP handlers,
agent instructions, capability requests, validations, and provenance, when it
is parsed and exported, then every declared file is digest-verified and the
round trip is deterministic.

### AC-REV-002 — forbidden package authority

Given a package or export containing a key/path representing credentials,
grants, sessions, state, audit history, OAuth data, or claim data, when it is
validated, then validation fails before persistence and reports only the
forbidden field name/path.

### AC-REV-003 — fork isolation

Given a Shiplet with an active revision, private state, access grants,
deployments, and audit history, when an authorized actor forks it, then the
draft contains only package content, schema, provenance, and parent lineage.

### AC-REV-004 — validation does not activate

Given an active revision and a changed draft, when validation succeeds or
fails, then the active revision ID and served bytes are unchanged.

### AC-REV-005 — atomic promotion and conflict

Given two validated drafts based on revision R1, when draft A promotes to R2
and draft B then attempts promotion, then A atomically activates with an audit
event, B receives a conflict, and R2 remains active.

### AC-REV-006 — deployment failure safety

Given revision R1 is active and draft R2 validates but its required deployment
fails, when promotion is attempted, then R1 and its last-known-good deployment
remain active and the failure is audited without a partial pointer change.

### AC-REV-007 — rollback

Given R1 was known-good before active R2, when an authorized rollback selects
R1, then R1 becomes active atomically, customer deployment selects R1 through a
new provider deployment where applicable, and state is not silently rewound.

### AC-REV-008 — sealed validated-revision preview

Given R1 is active and draft R2 has validated into one immutable revision,
when an authorized actor opens the returned preview URL, then the trusted host
serves exactly R2's artifact and widget through the same opaque sandbox and
revision-bound broker policy as an active review while every active pointer and
active tenant byte remains R1. A stale, foreign-Shiplet, unvalidated, replaced,
or unauthorized revision preview fails closed and cannot mint human attribution
or broader authority.

### AC-REV-009 — trusted preview receipt before browser promotion

Given an exact validated draft is visible in the ownership page, when the
current actor and authenticated browser session have not opened its trusted sealed preview, then the browser
promotion control remains disabled and local/session state cannot enable it.

Given that actor opens the trusted preview host successfully, when ownership
checks the kernel receipt endpoint from that same session, then the response
matches the exact Shiplet, draft, immutable revision, draft version, actor kind,
actor ID, and kernel-derived session-binding digest. The digest is never
returned, audited, or accepted from the browser.
The receipt is immutable, capability-free, audited on first creation, and does
not move an active pointer. Missing, stale, foreign, unauthorized, and
different-actor, different-session, and bearer-only selectors return the same
404 response.

### AC-REV-010 — exact browser reconciliation after an ambiguous mutation

Given a browser promotion, rollback, redeploy, or temporary-claim request has
crossed the side-effect boundary, when the response is lost or the kernel
returns a server-side reconciliation state, then ownership says `Outcome
unknown`, retains the exact idempotency key and semantic input, disables every
competing mutation, and offers only an exact retry. A retry reuses that same
operation identity until the kernel returns a terminal result; the browser
never claims the prior revision or deployment is unchanged without proof.

## Broker and browser isolation

### AC-BROKER-001 — no ambient credentials

Given a hostile artifact and hostile widget that inspect globals, DOM,
storage, cookies, URLs, network requests, errors, and bootstrap messages, when
the review shell loads, then neither can obtain a platform session, reviewer
bearer token, OAuth credential, claim credential/URL, or sibling capability.

### AC-BROKER-002 — sibling denial

Given Shiplet A code guesses Shiplet B’s ID, revision, deployment name, route,
storage namespace, and RPC identifiers, when it sends otherwise well-formed
requests, then every read/write is denied and B is unchanged.

### AC-BROKER-003 — channel validation matrix

Given a valid broker channel, when a message has the wrong source window,
wrong bootstrap origin, reused nonce, non-monotonic sequence, duplicate request
ID, malformed body, oversized body, expired assertion, wrong Shiplet, or wrong
revision, then the broker rejects it without performing the requested action.

### AC-BROKER-004 — trusted human attribution

Given a hostile widget sends a write request naming a real human actor, when no
trusted-shell approval gesture occurs, then no human-attributed event is
created; after explicit trusted approval, the kernel derives the actor from the
host session and ignores child-supplied identity.

### AC-BROKER-005 — failure and accessibility

Given widget load failure, runtime error, permission denial, offline state, or
keyboard/mobile use, when review loads, then trusted review/navigation remains
usable, status is announced, focus is visible and recoverable, and one safe
next action is present.

### AC-BROKER-006 — credentialless artifact capture compatibility

Given an arbitrary artifact running in an opaque-origin sandbox, when a
reviewer selects an element, then a capture-only bridge may return bounded
inert visual context but receives no cookie, bearer token, session, OAuth
credential, claim credential, or platform API response.

Given a capture response with the wrong source window, channel nonce, Shiplet,
revision, request ID, unknown keys, malformed values, or credential-shaped
metadata, when the trusted host validates it, then it rejects the response
without changing state.

Given a reviewer submits feedback with captured context, when the trusted host
opens confirmation, then the kernel binds the context to the same human,
Shiplet, active revision, page, and one-use request before creating feedback.

### AC-BROKER-007 — tenant confirmation provenance

Given a reviewer submits from an exact managed tenant origin to the first-party
confirmation route, when the browser opens the credential-free top-level POST,
then it sends exact origin provenance without disclosing a path, query, fragment,
or opener. The kernel accepts only that bound tenant origin; an opaque, missing,
sibling, or attacker origin remains denied without creating an intent.

## Capabilities, state, egress, and audit

### AC-ISO-001 — authoritative scope tuple

Given any capability, when it is validated, then actor kind/ID, Shiplet ID,
revision where relevant, operation, resource, expiry, revocation, nonce/call ID,
and constraints must all match; omission or mismatch fails closed.

### AC-ISO-002 — revoked access

Given a previously valid capability or Cloudflare connection is revoked, when
it is used again, then no fallback session/ambient authority is accepted and a
non-secret denial audit event is recorded.

### AC-ISO-003 — namespaced state

Given two Shiplets and two deployments of one revision, when each reads/writes
the same logical namespace/key, then every value remains isolated by the full
kernel-owned scope and quotas apply independently.

### AC-ISO-004 — deny-by-default egress

Given untrusted runtime code with no egress grant, when it fetches any origin,
then the request is denied; an exact explicit grant permits only its declared
resource/method/limits and strips ambient headers.

### AC-ISO-005 — enforced limits

Given code exceeds CPU, subrequest, storage, payload, state, event, or deployment
limits, when it runs, then the operation terminates predictably, is audited,
and sibling Shiplets remain healthy.

### AC-ISO-006 — immutable audit

Given a side-effecting action succeeds, fails, or is denied, when queried by an
authorized auditor, then its actor/scope/outcome event exists; update or delete
attempts fail at both application and database boundaries.

### AC-ISO-007 — capability-scoped application state mutation

Given an active revision whose package and custom MCP tool both declare
`state.write`, when an authorized actor confirms the exact key and value, then
the kernel writes only that revision's namespaced state, records an immutable
dispatch/audit trail, and returns no ambient storage authority to package code.

Given the approval is absent, expired, revoked, or bound to another actor,
Shiplet, revision, generation, action, resource, key, or value, when the write
reaches storage, then no value changes. Given the namespace would exceed 128
keys, 256 KiB, or 32 KiB for one value, the write fails closed and prior state
remains intact.

### AC-ISO-008 — raw dispatch binding is not runtime attestation

Given an operator adds only a Workers for Platforms dispatch namespace binding,
when a package requests managed arbitrary execution, the dashboard, promotion,
rollback, publish, and artifact routes still report
`managed_dynamic_unavailable`; no dispatch call occurs and the active revision
does not change. Managed execution may become available only after a
revision-aware gateway can stage the exact immutable package, verify it before
activation, strip platform cookies and authorization, enforce CPU/subrequest
limits, and route all package egress through a deny-by-default outbound Worker.

### AC-ISO-009 — coordinated managed-runtime activation

Given a validated advanced package and an exact-version-attested managed
runtime, when the kernel stages, promotes, serves, or rolls back a revision,
then the kernel and remote runtime advance through one durable operation journal
with an expected-active compare-and-swap fence. A lost response or failure
before or after any remote transition leaves the previous known-good revision
serving, or makes the tenant fail closed until reconciliation proves the exact
kernel-authorized revision, package digest, and activation generation.

Given a caller guesses a sibling Shiplet, revision, script name, state
namespace, or generation, when it reaches the gateway, then no upload, D1
mutation, dispatch, state access, or invocation occurs. User Worker requests
receive no cookie, authorization header, platform credential, WorkOS authority,
shared D1/R2/DO binding, or sibling capability.

### AC-ISO-010 — complete managed-runtime release attestation

Given managed arbitrary execution is requested, when readiness is evaluated,
then the main kernel proves the exact live managed gateway and the gateway
proves its deployment broker and deny-egress release before any deployment,
storage, or dispatch effect. The two dispatch namespaces are machine-attested
as untrusted, every invocation receives bounded CPU and subrequest limits, and
no Durable Object or mTLS binding can bypass outbound mediation. Missing,
swapped, stale, or drifted evidence keeps managed execution unavailable while
managed static publishing continues.

### AC-ISO-011 — support health is mutation authority

Given support entrypoint identities are correct but credential continuity,
schema readiness, reconciliation freshness, or bounded cleanup health is
degraded, when OAuth, customer deployment, temporary claim, custom MCP, or
managed-runtime mutation is requested, then Shiplet rejects it before any
provider or runtime call. Read-only status reports the degraded reason without
claiming that the capability is running.

### AC-ISO-012 — managed WFP provider reservation and readiness

Given the platform operator has one active exact-scope OAuth connection in the
Shiplet-owned account, when the exact `operator_smoke` human approves it through
the trusted reservation page, then the kernel persists an immutable managed-only
reservation for purpose `managed_wfp_provider`. The reservation binds the
public account and connection identifiers to one deterministic operation. It
contains no credential, grant, state, or package data.

Given the same lifecycle operator retires that exact reservation through the
release-fenced trusted action, when the control plane accepts it, then a separate
immutable retirement audit record is written before ordinary OAuth revocation
is allowed. Customer-owned deployments continue running on separate resources.
Managed Worker operations fail closed until a new fixed reservation is
configured and passes readiness.

Given a managed revision is staged or invoked, when the kernel crosses the six
named entrypoint release boundary through `CLOUDFLARE_MANAGED_RUNTIME_RPC`, then
the broker requires that reservation plus exact live control-plane, gateway, and
deny-egress evidence. The control plane holds provider credentials. The gateway
and package code receive none, their ambient bindings are empty, and package
egress is denied by default.

Given local checks pass, when release status is recorded, then managed WFP stays
production-unverified until the live six exact named entrypoint contract reports
`managedRuntime.ok=true`, the exact operator completes dynamic preview,
promotion, invocation, sibling-isolation, deny-egress, and rollback checks, and
a separate confirmed deploy enables ordinary access. Static publishing remains
the default. Custom MCP uses the separate Dynamic Workers contract.

### AC-ISO-013 — one provider attempt and recoverable activation ambiguity

Given a managed provider upload or delete has crossed its durable apply fence,
when the local call is delayed, times out, or loses its response, then every
exact retry only inspects and reconciles that single provider attempt. It never
dispatches a second mutation, never changes the apply identity, and keeps
reservation retirement fenced until exact terminal proof releases the exact
operation lease.

Given the managed runtime remotely commits a promotion or rollback before the
main kernel records or acknowledges it, when either the prior or candidate
exact tuple is requested, then the gateway serves only those two immutable
tuples while the activation is pending and rejects every stale or third tuple.
State effects use the same effect-time fence. After the main kernel commits,
an idempotent exact acknowledgement closes pending authority; a lost
acknowledgement response is safely retryable. A definite pre-dispatch failure
may be terminalized and retried as a fresh unkeyed attempt, while an explicit
idempotency key replays its exact stored terminal response.

Given the fixed managed platform reservation is retired or its exact live
support release no longer matches, when active or preview invocation begins,
then the gateway rejects it before dispatching package code or state access.

## Workflow and MCP

### AC-EVENT-001 — canonical envelope

Given arbitrary workflow statuses and payload fields, when a valid event is
accepted, then custom data remains intact and namespaced while the canonical
event ID, Shiplet/revision, actor, kind, summary, status category, and timestamps
support global inbox ordering/filtering.

### AC-MCP-001 — namespace integrity

Given a package declares a custom tool with a kernel name, reserved prefix,
duplicate, or Unicode-confusable collision, when validated, then the entire MCP
manifest is rejected and no partial tool is registered.

### AC-MCP-002 — untrusted descriptions/results

Given a tool description or result contains HTML, control characters, prompt
instructions, protocol-shaped JSON, or oversized data, when discovered/called,
then it remains escaped/structured untrusted content and cannot alter kernel
tool selection, authorization, or surrounding MCP messages.

### AC-MCP-003 — handler authority and approval

Given a custom handler requests state, egress, secrets, or side effects outside
its declaration/call grant, when invoked, then access fails closed; an allowed
side effect still requires its declared approval policy and is audited.

### AC-MCP-004 — invoker and approver attribution

Given an organization API token invokes a side-effecting custom tool, when its
designated human owner approves the exact request in the trusted Shiplet host,
then the capability grant, effect, and canonical audit event remain attributed
to the agent token while the approval evidence records the distinct human
approver. The agent cannot approve its own request, the human cannot be
substituted by package input, and either identity mismatch fails closed.

### AC-MCP-005 — delegated OAuth agent identity and kernel approval

Given an MCP OAuth access token, when Shiplet authenticates it, then the trusted
principal retains the subject user separately from the OAuth client and grant
identity and from its exact operation permissions. Authorization may use the
subject's Shiplet membership, but every MCP invocation, effect, canonical event,
and audit record is attributed to the delegated agent identity.

Given an OAuth client or organization token requests promotion, rollback,
deployment, revocation, archive, or another sensitive kernel mutation, when its
JSON body contains `approval: true`, then no effect occurs. Shiplet returns a
trusted same-origin confirmation path bound to the exact agent, subject,
Shiplet, revision, operation, request digest, expiry, and one-use nonce. Only a
separately authenticated authorized human may approve it; wrong-subject,
wrong-operation, expired, replayed, or package-supplied approval fails closed.

### AC-MCP-006 — claimed WorkOS agent registration

Given a WorkOS Agent Registration access token issued for Shiplet, when the
agent connects to Code Mode MCP, then Shiplet verifies its issuer, audience,
signature, and lifetime before retaining the registration `sub` as the stable
agent actor, the claimed `act.sub` as the distinct delegated user, the exact
`org_id` as the organization boundary, and only the token's recognized
space-separated `scope` values as operation permissions. Token rotation does
not change the agent actor, bearer or refresh material is never persisted, and
an agent-shaped token can never fall back to a human principal.

Given an unclaimed or malformed registration, a missing `mcp` permission, a
removed local organization membership, or a request targeting a different
organization, when the agent calls Code Mode, then Shiplet fails closed without
revealing or mutating cross-organization data. The first release supports only
claimed `service_auth` registrations and WorkOS-issued short-lived access
tokens; anonymous registration and WorkOS-issued durable agent API keys remain
out of scope.

Given an agent starts at Shiplet's root `auth.md`, when the Worker retrieves the
guide, then it reverse-proxies only the configured AuthKit issuer's generated
agent guide through a bounded public response. AuthKit remains the system of
record for registration and credential lifecycle while D1 stores only Shiplet
authorization and stable actor attribution.

## Package-defined review workflows

### AC-WF-001 — active-revision schema enforcement

Given a validated package declares custom workflow statuses and fields, when a
trusted human or approved custom MCP handler records a workflow event, then the
kernel accepts only a status and payload declared by the currently active
revision. A stale, sibling, undeclared, malformed, oversized, or credential-
shaped event fails closed and does not create an event or notification.

### AC-WF-002 — canonical projection

Given an accepted package-defined workflow event, when it is committed, then
the immutable canonical envelope retains the custom status and payload while
mapping it to one of `open`, `in_progress`, `blocked`, `resolved`, `closed`, or
`informational`; the event is visible through the global inbox to the Shiplet
owner and active watchers with trusted actor and revision attribution.

### AC-WF-003 — hostile-widget mediation

Given arbitrary widget code requests a package-defined workflow action, when
the trusted host receives the request, then source window, opaque origin,
channel nonce, Shiplet, active revision, replay identifier, operation, status,
and payload are validated before the kernel presents a human-mediated
confirmation. The trusted host and top-level confirmation render every exact
workflow field as bounded inert text before either click. Widget input alone
can never attribute the action to a human or hide consequential fields behind
a benign summary.

### AC-REVIEW-004 — atomic legacy embed effects

Given a legacy trusted-host operation receipt bound to a Shiplet revision, when
feedback is committed, then receipt claim, active-revision verification,
feedback, canonical event, and immutable audit record succeed in one D1 batch.
If activation races the request, every write rolls back and the receipt remains
unclaimed so the prior or new revision cannot receive a partially attributed
effect.

### AC-KRN-005 — privileged administration audit

Given organization, team, invitation, organization-token, or Shiplet-share
administration, when an authenticated actor attempts the operation, then the
trusted kernel appends a bounded, credential-free, organization-scoped audit
event for denied access and for every accepted intent and outcome. External
WorkOS effects have an immutable intent before dispatch, and audit rows cannot
be updated or deleted through D1.

### AC-KRN-006 — trusted document supply-chain boundary

Given any public or authenticated document rendered by the Shiplet kernel,
when optional analytics or visual enhancement configuration is present, then
the document loads no executable code from a third-party origin and an enforced
baseline policy limits scripts to Shiplet's own origin, denies foreign framing
and plugins, and constrains forms and base URLs. An explicitly embedded kernel
notice may allow only its same-origin Shiplet parent. HTTPS responses carry HSTS,
content-type sniffing protection, a bounded referrer policy, and legacy frame
denial. Package artifacts and broker/embed documents retain their separate,
route-specific policies rather than inheriting kernel-page authority.

## Cloudflare connection and deployment

### AC-CF-001 — OAuth mix-up protections

Given Cloudflare OAuth authorization, when callback state is missing, reused,
expired, wrong-session, wrong-user, wrong-redirect, wrong-account, or PKCE does
not verify, then no connection is created and no authorization artifact enters
logs or public responses.

### AC-CF-002 — refresh and revocation

Given an expiring connection, when refresh succeeds, then rotated ciphertext
replaces prior ciphertext atomically; when refresh/revocation fails or the grant
is revoked, orchestration fails closed while deployed customer code continues.

### AC-CF-003 — customer binding isolation

Given a customer deployment, when its Worker manifest is inspected and the
Worker executes, then it has only target-specific resources/public config and
cannot access shared Shiplet D1/R2/DO, WorkOS, OAuth, or sibling resources.

### AC-CF-004 — immutable provider deployment

Given a validated revision, when customer deployment begins, then Shiplet
uploads an immutable version, validates its preview/health, and atomically
creates a deployment; failure leaves the last known-good provider deployment.

### AC-CF-005 — preview claim secrecy and ownership

Given an officially supported temporary preview/claim deployment, when it is
created and claimed, then temporary authorization and claim URL remain backend
only, are absent from logs/analytics/screenshots/public APIs/arbitrary code,
expire on schedule, and future updates require a separate normal OAuth
connection.

## CLI, API, compatibility, and operations

### AC-CLI-001 — command parity

Given the same authorized actor/package/target, when CLI or core MCP performs
fork, pull, validate, push, diff, deploy, promote, rollback, or eject, then both
surfaces use the same kernel contracts, concurrency and approval rules, and
stable machine-readable outcomes.

### AC-CLI-002 — value-free browser session

Given a human runs a production CLI command without an organization API key,
when the CLI starts authentication, then it uses a loopback-only authorization
redirect, high-entropy state, PKCE S256, an explicit same-origin browser
confirmation, a single-use short-lived code, and a process-memory-only scoped
session. Wrong actor, redirect, verifier, state, expiry, replay, or out-of-scope
route fails closed; no user is asked to paste a credential.

### AC-CLI-003 — session audit and revocation

Given a browser-authorized CLI session, when authorization is requested,
approved, exchanged, or revoked, then an immutable credential-free audit event
attributes the transition to the human. The session holder can revoke the exact
session without exposing its bearer value. A transient failure receives one
bounded retry, local closure occurs only after a 204 confirmation, and every
later request fails closed.

### AC-COMPAT-001 — representative legacy migration

Given representative legacy static-with-index, static-without-index, external
URL, advanced Worker, private/org/unlisted/public, custom-hostname, archived,
review-history, API-token, and WordPress rows, when additive migration runs,
then existing URLs/content/access/review/inbox/embed/lifecycle behavior remains
equivalent and a compatibility revision is active.

### AC-OPS-001 — honest unavailable states

Given Workers for Platforms, R2, customer OAuth, provider health, network, or
claim prerequisites are absent, when a user reaches the related path, then
static managed review still works where possible and the unavailable surface
states the exact prerequisite without implying success.

### AC-OPS-002 — production rollback protocol

Given all pre-production gates pass and the previous version is recorded, when
production deploy/smoke detects authentication breakage, cross-Shiplet access,
data corruption, missing primary routes, or critical widget/MCP failure, then
the established reversible rollback runs and the operated smoke suite repeats.

### AC-OPS-003 — public release attestation

Given Cloudflare supplies the trusted Worker version-metadata binding, when any
non-upgrade response leaves the Shiplet kernel, then it carries the exact
non-secret Worker version ID in `x-shiplet-worker-version`; tag and timestamp
metadata are not exposed, and absent or malformed version IDs produce no
attestation header.

### AC-OPS-004 — managed runtime prerequisite accuracy

Given a user reads public publishing or deployment documentation, when managed
dynamic execution is described, then the documentation states that a raw
Workers for Platforms dispatch namespace is insufficient and names immutable
revision staging, platform-credential stripping, enforced invocation limits,
and deny-by-default outbound mediation as prerequisites.

## Release hardening

### AC-HARD-001 — generated Worker binding contract

Given Wrangler configuration adds, removes, or changes a Worker binding, when
the default typecheck gate runs, then it verifies the committed generated
Worker declaration with `wrangler types --check` and fails until
`worker-configuration.d.ts` exactly matches the deployable configuration. The
application `Env` derives from `Cloudflare.Env`; it may explicitly widen or add
only test, secret, or intentionally unconfigured bindings, and it must preserve
the requiredness of deployable bindings. An executable drift check mutates a
disposable Wrangler configuration and proves the real default gate fails,
rather than merely inspecting package-script text.

### AC-HARD-002 — nonce-bound trusted kernel scripts

Given a public or authenticated HTML document rendered by the trusted Shiplet
kernel, when the response leaves the Worker, then its script policy contains a
fresh unpredictable nonce and does not contain script `unsafe-inline`. Every
explicitly trusted script element carries the exact response nonce, arbitrary
or injected script markup is never blessed even when it copies every public
trusted-script marker or same-origin script path, no
inline event-handler attribute is emitted, the script directive grants no
ambient `'self'` or origin authority, third-party executable origins remain
denied, and a second response receives a different nonce. The trusted
review-host and embed-auth bootstrap bind their exact first-party scripts to
fresh nonce-only route policies. Artifact, widget, review-broker, embed, and
confirmation documents retain their separate route-specific policies and do
not inherit trusted-kernel authority. The enabled `workers.dev` fallback uses
the same reserved-route classification as the request router: root and
reserved platform documents receive the kernel policy, while `/:shiplet`
artifact and widget paths retain only their own sandbox policies.

### AC-HARD-003 — high-severity dependency gate

Given the locked production and development dependency graph, when the
repository security audit runs at the High threshold, then it reports no High
or Critical advisory. Direct dependencies carry a patched minimum version,
transitive fixes remain locked reproducibly, and any temporary override names
the exact patched package version until its owner dependency adopts it.

### AC-HARD-004 — executable Node toolchain contract

Given a contributor installs the repository on a Node version allowed by
`package.json`, when the default typecheck, build, test, and Wrangler gates run,
then every locked tool supports that version. The minimum version is pinned in
the repository and an executable boundary check rejects a declared engine
range lower than the locked Cloudflare toolchain supports.

### AC-HARD-005 — value-free deployment secret delivery

Given deployment setup must store a credential through Wrangler, when the
helper invokes the child process, then the credential is supplied only on
standard input to a shell-free executable call. It never enters a command
string, argument list, error message, prefix log, status summary, test fixture,
or diagnostic output. Failures identify only the secret key and redacted child
status. The default static-first setup does not provision a dispatch namespace
or privileged dispatch token that the deployable runtime cannot safely use.

### AC-HARD-006 — timing-safe bootstrap authorization

Given a request presents the privileged setup bootstrap bearer, when the
kernel authorizes it, then both configured and presented values are reduced to
fixed-size digests and compared without content- or length-dependent early
exit. Missing or mismatched credentials fail closed without being logged.

### AC-HARD-007 — static-first setup truth

Given a contributor reads the README or operates the default setup, when
managed dynamic execution is unavailable, then the instructions describe the
working static-managed path and identify revision-aware staging, credential
stripping, enforced limits, and deny-by-default outbound mediation as external
advanced-runtime prerequisites. They do not ask for a raw dispatch namespace
or API token as if either enabled the feature. Every public setup alias and the
default development template remain credential-free and static-first, and the
documented aggregate verification command includes generated-contract drift,
tests, build, documentation validation, and the High-threshold audit.

### AC-HARD-008 — artifact capture readiness

Given the trusted review host is still establishing its opaque artifact
channel, when a reviewer reaches the capture controls, then element selection
remains disabled and no click is silently discarded. The control becomes
actionable only after the trusted host accepts the exact source window, opaque
origin, channel nonce, Shiplet ID, and revision ID and transfers the typed
message channel. A subsequent operated artifact click produces bounded element
context and screenshot data in the trusted document.

### AC-HARD-009 — sandbox document-role policies

Given artifact, custom-widget renderer, and static embedded-review documents
have different responsibilities, when each response is emitted, then its CSP is
selected by an explicit role rather than a generic sandbox default. Artifact
documents retain only the compatibility needed for arbitrary static code and
the trusted bridge; widget documents run only nonce-bound kernel rendering code
and its kernel-created blob Worker without ambient trusted-host script
authority; static review context has no script, form, or egress authority.
Route checks and mutants must fail if those roles collapse.

### AC-HARD-010 — credentialless widget dependency contract

Given a runtime-v1 custom widget using classic JavaScript and direct
package-local leaf resources, when the active revision is rendered in its
opaque-origin compartment, then non-executable resources are converted from
immutable revision bytes to credentialless data authority and package scripts
are compiled into the dedicated opaque Worker without granting a browsing
context, same-origin URL, cookie-bearing fetch path, or ambient trusted-host
script authority. Given a module/import-map/dynamic-import/worker graph, CSS
`url()`/`@import`,
`srcset`, or missing/escaping reference, package and CLI validation reject it
with a bounded path-only error. A bypassed stored revision receives an inert
widget error while trusted review controls remain usable. A future graph-aware
widget runtime requires a new compatibility contract rather than widening the
runtime-v1 CSP.

Given quoted or unquoted direct leaf attributes and script text that merely
contains attribute-shaped strings, when validation and rendering run, then the
kernel parses the HTML structure, rewrites only actual resource attributes,
and preserves inert text byte-for-byte. CLI validation must make the same
accept/reject decision for quoted/unquoted attributes and JavaScript syntax;
comments and strings that mention module/worker syntax are not dependencies.
Given a Worker identifier/member alias, inline event-handler code, or evaluated
code path, validation and delivery fail closed: package and CLI reject the
declared form, while widget CSP permits only the kernel-created blob Worker,
sets `script-src-attr 'none'`, and grants no `unsafe-eval` fallback.
Given an authored data/blob script source or SVG `script[href]`/
`script[xlink:href]`, validation rejects the uninspectable alternate executable
source. Validated package-local HTML `script[src]` bytes are compiled into the
opaque Worker before the trusted renderer parses the inert package template.

### AC-HARD-011 — reload-safe opaque channels

Given the artifact or widget frame loads before the deferred trusted-host
client, reloads, or navigates while a selection or confirmation is pending,
when the frame lifecycle changes, then the host closes and invalidates the old
port, clears pending and captured state, disables the affected control, creates
a fresh nonce-bound offer, and accepts only the new exact source/origin/Shiplet/
revision handshake. Queued stale-port messages and prior confirmations cannot
cause or authorize an action; the first valid post-reload interaction succeeds.

### AC-HARD-012 — non-navigable widget execution compartment

Given a runtime-v1 package contains arbitrary classic widget JavaScript, when
the active widget loads, then package JavaScript executes only in a dedicated
opaque blob Worker and never in a browsing context. The iframe document is a
trusted, nonce-bound renderer which reconstructs allowlisted package markup,
starts the Worker, and accepts only bounded declarative DOM operations and
review-operation requests. Package code never receives a Window, Document,
parent frame, channel nonce, capability, credential, or raw MessagePort.

Given hostile package code attempts self-navigation, top navigation, `fetch`,
XHR, WebSocket, EventSource, `importScripts`, dynamic import, nested frames,
form submission, or an alternate executable HTML/SVG path, when Chromium runs
the real widget response, then no outbound request occurs and the trusted host
remains on the active revision. The response policy uses a fresh script nonce,
permits only the kernel-created blob Worker, denies connections, frames,
objects, form actions, and script attributes, and exposes no WebRTC primitive
to package code. It does not grant inline-script or trusted-origin authority.

Given package code renders UI or requests feedback/workflow activity, when its
typed message reaches the trusted renderer, then size, rate, node, selector,
attribute, event, operation, Shiplet, and revision limits are enforced before
the renderer mutates its own DOM or forwards a request through the existing
source/origin/nonce-bound human-confirmation channel. A malformed, replayed,
oversized, over-budget, or stale Worker message is ignored or terminates only
that widget; trusted review controls remain usable.

### AC-HARD-013 — terminal widget recovery and browser memory boundary

Given a widget fails startup, throws, exceeds its heartbeat/message/lifetime
budget, or its Worker is terminated by the browser, when the terminal state is
shown, then package UI is inert, the old Worker and port are closed, pending
operations and bindings are cleared, and an accessible trusted “Restart widget”
action is visible. A trusted human click sends an exact source/origin/nonce/
Shiplet/revision-bound restart request to the trusted parent, which reloads the
no-store widget document and creates a fresh renderer nonce, Worker, channel,
timers, and pending state; normal review controls remain responsive throughout.

The browser Worker contract enforces execution-liveness and message/storage/
network authority limits, but does not advertise a hard per-widget JavaScript
heap ceiling because the Web Worker platform exposes no application-controlled
heap quota. Browser process memory enforcement and termination are an explicit
runtime boundary; a future hard heap guarantee requires an isolated runtime or
embedded interpreter with enforceable memory limits. Acceptance evidence must
prove bounded termination and trusted recovery without destructive OOM testing.
