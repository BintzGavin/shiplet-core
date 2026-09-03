# Public documentation acceptance specification

Status: candidate contract, 2026-08-07. The production documentation at
`https://shiplet.cc/docs` is the runtime baseline. Shipped routes, tests, and
the self-owned Shiplet architecture are product evidence; internal design
documents are not a substitute for public guidance.

Current surface decision, 2026-08-16: the public product is the review layer
around a separate artifact. The public set contains twelve guides. Package,
revision, CLI, deployment, and detailed external-provider setup contracts remain
in the repository for operators and compatibility. Why Shiplet can name the
future organization-level hosting choice without publishing its implementation
plan. DOC-030 through DOC-035, DOC-037, and DOC-039 are retained internal
evidence under that rule.

## DOC-001 — public discovery and next steps

Given a signed-out visitor opens any public documentation page, when they read
the page, then they can identify the page's place in the documentation, reach a
relevant next step without guessing a URL, and open the app or API reference.

## DOC-002 — zero-friction managed quickstart

Given a first-time reviewer who does not know Cloudflare, when they follow the
quickstart, then the primary browser path explains visibility before publish,
prepares a harmless static artifact, opens its review URL, and provides safe
recovery without creating a provider connection. MCP and documented REST
operations are the optional automation paths.

## DOC-003 — artifact and review-layer model

Given a reviewer evaluates Shiplet, when they read the introduction and review
layer guide, then the artifact is clearly the work being reviewed and Shiplet
is clearly the separate trusted layer that owns the review link, toolbar,
access, and feedback.

## DOC-004 — advanced lifecycle stays internal

Given a reader opens a former package, CLI, or deployment documentation URL,
when the route resolves, then it redirects to current artifact or MCP guidance.
The internal lifecycle contracts remain available to repository operators but
are absent from public navigation and positioning.

## DOC-005 — custom review widgets

Given a team needs different review controls, when they read the review-layer
guide, then custom widgets are described as sandboxed customization of the
toolbar and workflow, never as part of the artifact or as a general application
runtime. Protected effects still cross the trusted host.

## DOC-006 — trusted kernel and browser isolation

Given a security reviewer evaluates artifact or custom-widget code, when they
read the security guide, then the trusted host, separate sandboxed frames,
reviewer attribution, bounded messaging, agent authority, external-URL limits,
and secret exclusions are explicit without exposing internal runtime machinery.

## DOC-007 — provider ownership is not a public review concern

Given a reviewer scans public documentation, when they choose a task, then no
provider ownership or production-deployment decision is presented as part of
preparing, sharing, or reviewing an artifact. Provider contracts remain
operator-internal.

## DOC-008 — API, MCP, and access boundaries

Given a developer automates Shiplet, when they read access and MCP guidance,
then browser OAuth, organization API keys, project rules, the core `search` and
`execute` tools, and OpenAPI discovery are distinct. Examples prepare review
artifacts or work with feedback and never teach users to expose credentials in
artifact or widget code.

## DOC-009 — source parity and discovery

Given Shiplet maintains both Worker-rendered pages and the Mintlify source
tree, when documentation changes, then the same public page set and material
contracts exist in both, `docs.json` lists every public page, sitemap discovery
includes every Worker-rendered route, and docs validation stages every listed
page.

## DOC-010 — accessibility and responsive use

Given a keyboard, screen-reader, or narrow-viewport user, when they navigate the
documentation, then headings and landmarks are coherent, current navigation is
identified, code and tables remain reachable, and navigation does not prevent
access to article content.

## DOC-011 — compatibility and troubleshooting

Given an existing static, external URL, review, WordPress, or API-key user, when
they read the new docs, then existing behavior remains findable. Given a path
is denied, expired, conflicted, failed, revoked, or externally unavailable, the
relevant guide explains the safe recovery or non-destructive outcome.

## DOC-012 — CLI remains contributor-internal

Given a public reader wants automation, when they scan the docs, then they are
routed to MCP or REST rather than a source-checkout CLI. The internal CLI
contract remains truthful for authorized contributors.

## DOC-013 — advanced runtime stays internal

Given a public reader evaluates Shiplet, when they scan the docs, then managed
Worker execution, custom MCP handlers, provider gateways, and dispatch
namespaces are not presented as review-product features.

## DOC-014 — authored-content secret boundary

Given an owner prepares an artifact or custom widget, when they read security
and API-key guidance, then they understand that neither is a credential store
and that Shiplet keeps browser sessions and organization keys in the trusted
host or automation secret store.

## DOC-015 — executable API and Code Mode parity

Given a developer discovers an operation through OpenAPI or Code Mode docs,
when they follow the advertised execution marker and request schema, then the
documented review-layer name matches OpenAPI and every supported Code Mode route
accepts the documented inputs and returns the same public response shape as the
direct REST route. Every other registered route remains outside Code Mode.

## DOC-016 — fail-closed agent authority and attribution

Given an administrator creates an organization API key, when any requested
scope, project rule, effect, identifier, or limit is malformed, then the whole
authority declaration is rejected instead of filtering the invalid part into
broader access. Given that key mutates review state, when the canonical event
is stored, then it identifies the authenticated agent credential rather than
the review kernel.

## DOC-017 — narrow-screen navigation and focus visibility

Given a reader expands public documentation navigation at 320 CSS pixels,
when long page labels are shown, then they wrap inside one readable column
without clipping. Given a keyboard user focuses a horizontally scrollable
table or the home logo, then the focus indicator is visible and the target is
at least 44 CSS pixels in both dimensions.

## DOC-018 — one current public contract and least-privilege setup

Given a developer enters through the public repository or publishing guide,
when they follow the named current product contract and setup instructions,
then the destination describes the static-first trusted-host product instead
of a historical dispatch-first MVP, the legacy `POST /projects` form is
identified as browser-only compatibility behavior, and managed static setup is
separated from optional Cloudflare control-plane credentials.

## DOC-019 — machine-readable API authority and retry contracts

Given a client consumes the public OpenAPI document, when an operation can use
an organization API key or returns JSON, then its exact required
`x-shiplet-scopes` and a machine-readable successful response schema are
declared. Given a review-layer write uses an optimistic version, then the
request schema makes that fence explicit so a stale preview cannot replace
newer work.

## DOC-020 — material review guidance parity across renderers

Given a reader opens either renderer, when they follow artifact, feedback,
access, MCP, or review-layer guidance, then both surfaces preserve the same
product boundary and material safety steps. Internal CLI detail is not a public
parity requirement.

## DOC-021 — self-sufficient MCP onboarding and documentation recovery

Given a first-time MCP user opens the Worker-rendered public guide, when they
connect, then the endpoint, protected-resource discovery, browser OAuth
challenge, kernel tool listing, search-first step, and execute example form one
complete journey without requiring the MDX source. Given a reader follows an
unknown documentation URL, then a branded documentation response names the
error and offers a direct route back to the documentation rather than a plain
text dead end. A raw OpenAPI link is labelled as JSON rather than as a rendered
API explorer.

## DOC-022 — retired organization authority remains narrow and compatible

Given an administrator creates a new organization API key, when its requested
scopes include the retired `feedback:manage` alias, then creation fails closed
instead of granting undocumented authority. Given an existing stored key still
contains that historical alias, when it authenticates, then the kernel projects
only the current `feedback:read` and `feedback:write` scopes so existing jobs can
rotate without receiving broader authority.

## DOC-023 — public automation has an installable first step

Given a public reader wants to automate Shiplet, when they choose a supported
path, then Code Mode MCP and direct REST are presented as the public routes.
The MCP guide includes a current named-client configuration,
browser-OAuth handoff, and first successful search call without asking the
reader to paste a credential.

## DOC-024 — widget resource and recovery boundaries are explicit

Given a security reviewer evaluates arbitrary browser widget code, when they
read the extension and security guides, then the docs distinguish message and
authority limits from browser CPU and heap isolation. They state that the
current iframe runtime has no Shiplet-enforced per-widget heap, CPU, or lifetime
ceiling and identify reloading or closing the review, followed by an owner
repair, as the safe recovery from a resource-hungry widget.

## DOC-025 — machine-readable authentication transport matches runtime

Given a client consumes OpenAPI, when a lifecycle route accepts a short-lived
CLI session, then that transport is explicit on the operation. Given an
authenticated operation rejects missing or insufficient authority, then its
401 and 403 responses and their possible response media types are declared
instead of being left implicit.

## DOC-026 — skip navigation precedes global navigation

Given a keyboard user opens a public documentation page, when they press Tab
for the first time, then the skip-to-article link is the first focusable element
in document order before the global brand and documentation navigation.

## DOC-027 — external setup remains operator-internal

Given a repository operator needs the external provider ceremony, when they
open the internal guide, then it remains bound to the executable Wizard and its
safe-stop contract. It is not listed or staged as public documentation.

## DOC-028 — account, collaboration, and lifecycle recovery

Given an owner administers a Shiplet, when they read the public access,
publishing, and feedback guides, then they can switch accounts,
create an organization and team, consent to an exact-email invitation, archive
and restore a Shiplet, understand permanent-delete authority and irreversibility,
use mentions, watches, notifications, and presence without guessing a route or
widening access.

## DOC-029 — honest API coverage and complete renderer journeys

Given a developer follows the public OpenAPI link, when the document does not
describe every browser-only or product-management route, then the surrounding
copy identifies it as the machine-readable contract for documented public REST
operations rather than the full product API surface. Given either public docs
renderer is used, when a material workflow includes browser steps, side-effecting
MCP examples, or recovery guidance, then those operations remain present in both
renderers rather than being represented by phrase-only parity.

## DOC-030 — trusted external setup and honest provider authority

Given the Wizard is about to use a browser-authenticated Cloudflare session,
when Stage 1 begins, then it refuses a dirty checkout, records the exact release
commit, and requires the operator to confirm that commit is trusted before any
provider access. Given Cloudflare account selection, when accounts are listed,
then the request uses a provider-compatible pagination value. Given Workers for
Platforms support namespaces are available, when the current release is set up,
then neither the Wizard nor public docs claim that namespaces activate managed
arbitrary execution, the Wizard does not create unused namespaces or request a
separate WFP deployment credential, and customer OAuth's account-level Workers
Scripts Write grant is distinguished as a later owner-authorized action for one
selected account.

## DOC-031 — release-integrity, identity, and coverage precision

Given a Wizard run resumes or pauses before a provider mutation, when the
approved commit or worktree changes, then legacy and commit-sensitive completion
state is invalidated and every Wizard-executed mutation, plus entry into each
human-controlled mutation ceremony, stops before provider state changes. Given
a failed production smoke after the checkout drifts, when rollback is approved,
then the account-pinned captured Worker UUID remains recoverable without local
source deployment. Given
a reader wants to change context, when they read access guidance, then account
identity switching at `/account` is separated from active-organization
selection at `/workspace` and feature availability is explicit. Given a reader
follows the OpenAPI link, then it is described as the contract for documented
public REST operations rather than the full REST surface. Account pinning claims
apply to account-scoped resource and status operations after selection, not the
earlier login ceremony.

## DOC-032 — dark-launched OAuth and recoverable setup boundaries

Given the named OAuth service is bound without operated provider proof, when an
ordinary owner reads deployment status or ownership guidance, then Connect stays
unavailable because readiness defaults to `disabled`. Given a verified public
client, when the exact configured operator runs account discovery, connect,
denial, and revoke smoke, then only that operator can connect in
`operator_smoke`; a separate confirmed deploy enables ordinary owners. Given
local persistence fails after remote finalization, then the kernel compensates
through the control plane before returning conflict. Given a trusted client
build, then Vite environment-file discovery is disabled and no fixture `.env`
value reaches the browser bundle. Given failed production smoke and checkout
drift, then captured-version rollback remains available without source deploy.

## DOC-033 — exact external runtime evidence and retry-safe cleanup

Given support services are deployed, when the Wizard prepares the main release,
then it captures immutable version IDs for all three Workers and states that the
Stage 7 dry run is compile-only. Given the main Worker is deployed, when an
authenticated operator opens `/api/platform/support-contract`, then all five
named live entrypoints must match the captured control-plane and runtime-gateway
versions before production smoke may pass. Given OAuth finalization cannot be
persisted and immediate cleanup is not confirmed, then the public deployment
guide describes the compensation-pending state and bounded scheduled retry.
Given a direct customer deployment contains Worker modules, then the docs state
that the shared static-only boundary rejects it before provider authority or a
remote effect. Given a temporary broker is bound while the provider prerequisite
is unavailable, then the docs state that explicit runtime readiness keeps both
the claim API and ownership UI unavailable.

## DOC-034 — operational support fencing and temporary dark launch

Given a privileged OAuth, grant, customer deployment, temporary-account,
version-health, or custom-MCP request, when any named support binding reports a
different service position, immutable version, or trusted-release tag, then the
kernel and owning support entrypoint reject the request before credential,
provider, claim, health, or arbitrary-code authority is exercised. Given
Temporary Accounts are available, when production proof has not completed,
then availability alone leaves readiness `disabled`; only one exact operator
may use `operator_smoke`, and skip, failure, or interruption restores
`disabled`. Given revocation cleanup is retried, then an immutable retry-intent
audit succeeds before provider cleanup begins. Given an unauthenticated reader
opens Deployment, Security, Extensions, or the rendered equivalents, then the
static copy describes only invariant prerequisites and fail-closed behavior;
it never asserts whether the mutable production Worker Loader or custom-MCP
runtime is currently installed. The authenticated deployment-status surface is
the authority for live readiness.

Given Stage 10 is about to change the main Worker, when the selected account
already has `shiplet`, then the Wizard requires an exact validated rollback
UUID. When the status lookup does not resolve an existing Worker, first-deploy
cleanup remains disarmed until the operator confirms that exact account has no
Worker named `shiplet`; the initial deployment is provider-disabled and any
ambiguous or failed required smoke automatically rolls it back or removes only
that newly created Worker. A recovered deployment failure is reported as
failure, never verified success. Resume state is fenced to the release, selected
account, app origin, and control-plane origin without discarding same-run stage
evidence when that control-plane origin is recorded for the first time.

## DOC-035 — response-loss-safe temporary ownership

Given a temporary Worker upload commits but its response is lost, when the
same durable operation is retried, then the support service never uploads a
second version. It may advance only after read-only provider inspection proves
the exact package tag, latest one-version 100-percent deployment, provider
identifiers, and account subdomain; absent or mismatched proof stays ambiguous
for verified cleanup. Given the final trusted claim redirect response is lost,
when the same authenticated human retries the exact opaque handle, then only
the same backend redirect is returned until expiry. Claim and redirect records
remain unavailable to package code and are removed by scheduled expiry. Given
readiness stages change the main Worker, then the Wizard captures the final
main version and requires that same version after production smoke.

## DOC-036 — task-led review entrypoint and deployed contract parity

Given a signed-out visitor opens Shiplet or its documentation, when they decide
whether to try the product, then preparing an artifact, sharing the review link,
and collecting feedback are clear before sign-in. Given an owner publishes an
artifact, then the created Shiplet points to review and sharing rather than an
infrastructure migration. Given a release candidate is deployed, when the anonymous
public-documentation smoke runs against an explicit origin, then every
canonical docs route returns 200 and the served OpenAPI preserves the required
paths, per-operation authentication/scopes, and Code Mode markers without
sending cookies, credentials, or authorization material.

The smoke does not accept status alone. Each response must be bounded HTML with
the route's exact title, canonical URL, single H1, and stable page-identity
marker, so a generic fallback, swapped page, stale renderer, wrong media type,
or oversized body fails the release gate. In the actual Worker-rendered `/docs`
response, the task chooser precedes review-layer detail.

## DOC-037 — external authority setup follows executable service contracts

Given an operator follows the external setup guide, when support services are
deployed, interrupted, or resumed, then the public instructions name the three
real Workers and describe the same reverse-order exact-version rollback or
first-deploy removal contract as the executable Wizard. Main and temporary
rollout ledgers recover before normal startup fencing, every rollback is
version-exact, first-deploy deletion requires live release attestation, and the
anonymous documentation/OpenAPI smoke runs before guided human smoke. Given
Cloudflare OAuth completes, then the docs describe the first-party HttpOnly
delivery cookie, top-level GET return without a delivery secret in the URL,
exact Shiplet/human/session binding, predetermined connection identity, kernel
acknowledgement after local commit, response-loss replay, and expired pending or
unacknowledged cleanup without exposing opaque delivery or provider authority.
Given custom MCP is enabled, then the docs state that every invocation receives
a fresh Dynamic Worker compartment and invocation-local capability binding
rather than a cached actor-agnostic Worker.

## DOC-038 — every runtime route has one public-contract classification

Given the Worker registers a literal Hono route, when the documentation gate
parses the runtime source, then the exact method and normalized path either
appear in the complete candidate OpenAPI document or match exactly one narrow
entry in `api-route-ledger.json`. An OpenAPI operation with no runtime route, an
unclassified runtime route, a route matching two exclusions, or an exclusion
matching no route fails the gate. Given a public reader asks why a route is not
in OpenAPI, then the API-surface page distinguishes the public automation
contract from browser-only identity and product state, trusted review/embed
protocols, human approvals, public representations, and operator-internal
recovery without implying that exclusion weakens authorization.

## DOC-039 — internal managed WFP contract stays outside the public review model

Given an operator opens the internal Deployment or External Setup guides, when
managed arbitrary application execution is described, then those internal
contracts name the six exact live support entrypoints, including
`CLOUDFLARE_MANAGED_RUNTIME_RPC`. They state that managed WFP uses one
exact-scope OAuth connection under a fixed managed-only reservation with purpose
`managed_wfp_provider`. The control plane holds provider credentials. The
gateway and package receive none, and user Workers start with ambient bindings
empty plus deny-by-default egress.

Given the same operator checks custom MCP, then the internal docs describe its separate
Dynamic Workers and Worker Loader contract without treating it as managed
application WFP authority. Static publishing remains the default. Managed WFP
readiness moves through `disabled`, exact-user `operator_smoke`, and a separate
confirmed `enabled` release.

Given the lifecycle operator needs to remove that managed authority, when the
operator uses the trusted retirement action, then the docs state that it writes
a separate immutable retirement audit record before ordinary OAuth revocation
is allowed. Customer-owned deployments continue running. Managed Worker
operations fail closed until a new fixed reservation is configured and passes
readiness.

Given local contracts pass before the platform services are operated, when the
behavior ledger records status, then it keeps the live reservation, six-entrypoint
support response, dynamic revision ceremony, and readiness promotion marked
production-unverified. Historical evidence retains the facts and verdicts from
its recorded candidate. It does not attest the current release.

## DOC-040 — review-layer customization uses strict Code Mode

Given any authenticated MCP client lists Shiplet tools, when it supplies no
scope, a Shiplet identifier, or arbitrary extra parameters, then the complete
top-level catalog is always exactly `search` and `execute`; package-authored
tools never become physical MCP tools or accept direct MCP invocation.

Given an authorized client performs a broad ordinary-path search, then it can
discover `/api/shiplets/custom-mcp-catalog` without loading custom packages.
When it executes that bounded, paginated catalog, Shiplet returns only trusted
active coordinates inside the caller's project and delegated-organization
scope.

Given the client then calls `search` with one returned Shiplet's literal
`/api/shiplets/{id}/custom-mcp/` prefix in the search program, when its active
revision declares a valid custom operation and the isolated handler runtime is
ready, then Shiplet dynamically registers that operation as a concrete,
revision-fenced OpenAPI path inside the Code Mode spec. The operation uses a
platform-authored safe description and the validated input schema; package
prose remains quarantined. An inaccessible, archived, invalid, inactive, or
runtime-unavailable operation is absent. Promotion or rollback changes the
search surface immediately. A broad search and an unrelated built-in execute
load no custom package. A focused search reads only the revision's immutable,
digest-bound MCP projection and referenced files, never unrelated package
assets.

Given the same client calls `execute` for a registered operation, when the
active revision, package digest, activation generation, actor authority,
declared capabilities, input schema, and approval requirements still match,
then Shiplet invokes the isolated revision handler through the trusted custom
MCP kernel. Package output remains quarantined and the model receives only the
platform-owned completion notice. The operation is never callable as a third
MCP tool.

Given an agent needs to customize a review toolbar, when it searches the public
OpenAPI document, then only the requested review-layer operations and schemas
enter model context. When it executes those operations, model-written code may
compose API calls and return a focused result while credentials and direct
network authority remain outside the sandbox.

Given an authorized editor reads a review layer, when the response is returned,
then it contains only an opaque version and bounded widget-relative files. It
never returns artifact files, package manifests, lifecycle metadata, custom MCP
handlers, agent instructions, provenance, or validation declarations.

Given an authorized editor submits a review-layer changeset, when every path,
file, capability, and runtime check succeeds against the named base version,
then Shiplet creates an exact non-active preview and leaves the shared review
layer unchanged. When the editor explicitly applies that preview against the
same current version, then every file changes atomically. Invalid changes,
stale versions, failed checks, or missing approval leave the active review layer
unchanged and return structured diagnostics or a conflict.

Given a client searches the public contract, when it inspects available paths,
then package export, draft, diff, validation, promotion, rollback, deployment,
and custom-MCP lifecycle operations are absent. Their compatibility machinery
may remain repository-internal but is not a user-facing or Code Mode product.

## DOC-041 — Why Shiplet carries the product argument

Given a visitor understands the basic review workflow, when they want to know
why Shiplet has one durable root per review link, then a first-class Why Shiplet
page follows Introduction in public navigation and explains the review room,
custom widget, browser sandbox, short-lived Code Mode Worker, and ShipletRoot
coordination boundary through two concrete product-team examples.

Given a team reviews an artifact produced for a ticket, when its author shapes
the Shiplet around that work, then the widget can turn the ticket's acceptance
criteria into review controls. An engineer-authored build lets PM, design, and
engineering reviewers open the named edge cases, mark a criterion passed or
blocked, and attach evidence to that criterion.

Given a researcher publishes a prototype and its findings, when product and
design reviewers examine a claim, then a distinct evidence-board widget keeps
the claim traceable to its observations. Reviewers can record whether evidence
supports or contradicts the claim and flag an assumption that still needs
testing. The article and image routes contain no legal-agreement or generic
homepage-conversion widget examples.

Given an anonymous visitor opens Shiplet's login entry page, when they follow
the link labeled Docs, then it opens the Why Shiplet page directly.

Given an organization considers where Shiplet should live, when it reaches the
future-facing section, then the page says the organization can choose Shiplet
Cloud or its own Cloudflare account, move between those homes, customize the
software with local coding agents, and retain a path to upstream improvements.
The public page leaves the distribution primitive unnamed and contains no
internal roadmap, implementation phases, transfer-state design, update-bundle
format, or release-channel plan.

Given the page is published through both documentation renderers, when a reader
or crawler opens it, then the MDX and Worker versions preserve the same material
argument, the six article visuals resolve from stable Shiplet URLs, and the
canonical route appears in navigation, the sitemap, and AI discovery guidance.

## DOC-042 — agent registration stays focused on Shiplet

Given a Shiplet user wants an external agent to work through MCP, when they read
the Code Mode guide, then the page explains what the agent can do in Shiplet,
how the user grants access to one organization, and how to verify the connection
through `tools/list` and a harmless read. The page gives the agent the root
`auth.md` guide and names the Shiplet MCP endpoint.

Given the identity provider owns the registration ceremony, when a person reads
Shiplet's product documentation, then the page leaves provider request fields,
credential exchanges, token rotation, and credential lifetimes to the
machine-readable guide. The human-facing page contains no claim-code or
assertion choreography.

Given Shiplet authorizes each registered agent, when the page explains access,
then it keeps the selected organization, current membership, Shiplet grants,
and required permission in view. The page describes the agent as a distinct
actor whose work appears in Shiplet's audit history.

Given both public documentation renderers describe this feature, when the guide
is built, then each version references one stable, accessible Shiplet-owned
visual. The visual shows the agent asking for access, the person choosing a
Shiplet organization, and the agent working with Shiplets and feedback through
MCP. It contains no identity-provider or credential lifecycle detail.
