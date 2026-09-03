# Public documentation behavior ledger

Baseline captured from the production documentation on 2026-08-07 and updated
for the candidate after executable and operated checks. Statuses refer to the
public, user-facing documentation—not whether the underlying product behavior
is implemented. This is the canonical tracker for this audit.

Current scope decision, 2026-08-16: twelve guides form the public review-product
surface. Package, revision, CLI, deployment, detailed external-provider,
managed WFP, and custom MCP runtime records are retained as internal
compatibility evidence.

| ID      | Scope    | Public behavior                                                                                                                                        | Candidate evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status | Remaining action                                                                                                           |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| DOC-001 | in_scope | Public routes are signed-out accessible, navigable, and provide contextual next steps.                                                                 | Twelve Worker routes and matching MDX pages expose grouped review navigation, contextual next links, app and OpenAPI entrypoints.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass   | None.                                                                                                                      |
| DOC-002 | in_scope | Quickstart produces a managed static review without Cloudflare knowledge.                                                                              | Quickstart leads with browser upload, explains visibility before publish, opens the review, makes MCP optional, and includes non-destructive troubleshooting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass   | Production publish remains a product smoke concern, not a docs-contract gap.                                               |
| DOC-003 | in_scope | Artifact and review-layer responsibilities are distinct.                                                                                               | Introduction and review-layer guides state that the artifact is the work under review and the toolbar, access, and feedback belong to Shiplet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass   | None.                                                                                                                      |
| DOC-004 | internal | Package and revision lifecycle contracts remain available to repository operators.                                                                     | Former public package, CLI, and deployment URLs redirect to current artifact or MCP guidance; source files remain internal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | n/a    | Revisit only if lifecycle management becomes a deliberate public product.                                                  |
| DOC-005 | in_scope | Custom widgets are presented only as review-layer customization.                                                                                       | The review-layer guide separates widgets from artifacts and keeps protected effects in the trusted host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass   | A bounded widget authoring API remains future architecture work.                                                           |
| DOC-006 | in_scope | Trusted-host, artifact-frame, widget-frame, identity, and secret boundaries are documented.                                                            | Security guidance explains separate sandboxes, bounded messages, authenticated actors, MCP/key authority, and external-URL limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass   | None.                                                                                                                      |
| DOC-007 | internal | Provider setup and deployment mechanics remain operator concerns.                                                                                      | Why Shiplet names the future organization-level hosting choice without setup steps; executable provider contracts remain internal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | n/a    | None for the current managed review product.                                                                               |
| DOC-008 | in_scope | Core MCP, access, and automation credentials are distinct.                                                                                             | MCP and API-key guides cover browser OAuth, scoped keys, `search`, `execute`, artifact preparation, and feedback without custom package tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass   | None.                                                                                                                      |
| DOC-009 | in_scope | Worker pages, MDX pages, navigation, validation, and sitemap remain in parity.                                                                         | Twelve pages match across renderers; validation stages their MDX and article visuals while public discovery omits retired routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass   | Preserve material review-boundary parity as the guides evolve.                                                             |
| DOC-010 | in_scope | Documentation is keyboard, landmark, and narrow-viewport usable.                                                                                       | Operated 320px, 390×844, and 1280×900 checks cover local table scrolling, collapsed/expanded navigation, first-viewport article access, touch targets, and keyboard skip focus.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass   | None.                                                                                                                      |
| DOC-011 | in_scope | Supported review workflows remain findable and important recovery states are explained.                                                                | Publishing, external URL, feedback, access, API-key, WordPress, quickstart, extensions, and security guides remain public.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pass   | Public WordPress distribution remains excluded until a real signed artifact exists.                                        |
| DOC-012 | internal | Source-checkout CLI distribution remains an internal contributor contract.                                                                             | Public automation starts with MCP or REST; the internal CLI guide remains truthful.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | n/a    | Revisit only after a real public distribution.                                                                             |
| DOC-013 | internal | Advanced Worker and custom MCP runtime contracts stay outside public product copy.                                                                     | Public review guides contain no managed WFP, dispatch namespace, custom MCP handler, or provider-gateway positioning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | n/a    | None for the review product.                                                                                               |
| DOC-014 | in_scope | Artifacts and custom widgets are not credential stores.                                                                                                | Security and API-key guides keep browser sessions and organization keys in the trusted host or automation secret store.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass   | None.                                                                                                                      |
| DOC-015 | in_scope | OpenAPI and Code Mode documentation match the executable review contract.                                                                              | Code Mode parity tests cover the exact two-tool catalog, the path allowlist, focused execution results, and direct REST response shapes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass   | None.                                                                                                                      |
| DOC-016 | in_scope | Organization-token authority rejects malformed declarations and preserves agent attribution.                                                           | Mixed-invalid and persisted-corrupt authority fails closed; selected-project creation is denied; REST and Code Mode review events persist the exact token agent ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass   | Existing D1 schemas rely on hydration validation rather than rebuilt CHECK constraints.                                    |
| DOC-017 | in_scope | Expanded mobile docs navigation, table focus, and the home-logo target remain usable at 320px.                                                         | Operated Chromium measured one wrapping 270px nav column, zero clipped links or document overflow, a 44×44 home target, and a solid 3px keyboard focus ring.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | pass   | None.                                                                                                                      |
| DOC-018 | in_scope | The public entry point names one current review-product contract.                                                                                      | Public copy centers artifact preparation, the review link, feedback, access, and agent handoff without provider setup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pass   | None.                                                                                                                      |
| DOC-019 | in_scope | OpenAPI exposes complete authority, successful response, and optimistic-version contracts.                                                             | The focused OpenAPI checks require bearer scopes, useful success schemas, and an explicit version fence for review-layer previews.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | pass   | None.                                                                                                                      |
| DOC-020 | in_scope | Worker-rendered and MDX review guides preserve the same product boundary and material safety steps.                                                    | Per-page parity covers the twelve public product, artifact, feedback, access, MCP, integration, and review-layer guides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | pass   | Internal CLI detail is not a public parity requirement.                                                                    |
| DOC-021 | in_scope | The Worker MCP guide is a complete first connection and unknown docs URLs recover inside the docs experience.                                          | Operated remote-preview checks proved connect-through-search guidance, a branded noindex HTML 404, honest OpenAPI JSON copy, zero page overflow, and kernel security headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass   | A rendered OpenAPI explorer remains a future convenience, not a claimed current surface.                                   |
| DOC-022 | in_scope | Retired organization-token authority fails closed for new keys and migrates narrowly for existing keys.                                                | New-key rejection and legacy persisted-row projection checks pass; the public record contains only `feedback:read` plus `feedback:write`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pass   | Rotate legacy keys when practical; no destructive migration is required.                                                   |
| DOC-023 | in_scope | Public automation starts with MCP or REST and includes a concrete credential-free MCP client setup.                                                    | Both renderers include a verified VS Code remote-HTTP configuration, browser OAuth, search-first operation discovery, artifact preparation, and feedback access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass   | None.                                                                                                                      |
| DOC-024 | in_scope | Browser widget resource limits and reviewer recovery are stated without implying a hard heap quota.                                                    | Extension and security parity checks require the absent per-widget heap/CPU/lifetime quota plus reload-or-close and owner repair.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass   | A hard browser runtime quota remains separate product hardening.                                                           |
| DOC-025 | in_scope | OpenAPI declares CLI-session eligibility plus authenticated 401/403 status and media contracts.                                                        | The exact twelve-operation CLI-session allowlist and every authenticated operation's reusable 401/403 text-or-JSON response contract pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pass   | None.                                                                                                                      |
| DOC-026 | in_scope | Skip-to-article is first in keyboard document order.                                                                                                   | The operated HTML contract places the skip link before the global brand header on docs and docs-404 routes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | pass   | Confirm visually in the final rendered-browser smoke.                                                                      |
| DOC-027 | internal | External provider setup remains bound to its executable operator Wizard.                                                                               | The internal guide and Wizard contract remain tested, while the guide is absent from public navigation and Mint staging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | n/a    | None for the review product.                                                                                               |
| DOC-028 | in_scope | Account, organization/team, invitation, lifecycle, and collaboration recovery are publicly taught.                                                     | Public access, publishing, and feedback guides cover identity, workspace, visibility, archive/delete, tickets, and agent handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | pass   | Recheck these journeys in the operated production docs smoke.                                                              |
| DOC-029 | in_scope | OpenAPI coverage is stated honestly and material journeys remain complete across renderers.                                                            | Both introductions describe OpenAPI narrowly; expanded parity assertions require browser, side-effecting MCP, and recovery content in the feedback guide.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pass   | Expand OpenAPI only in a separate test-first API-contract slice.                                                           |
| DOC-030 | internal | External setup starts from a trusted release and requests only authority used by this release.                                                         | Internal Wizard and operator checks retain the release and authority contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pass   | Operated provider proof remains separate from the local contract.                                                          |
| DOC-031 | internal | Setup integrity, provider authority, identity switching, and OpenAPI coverage remain precise across pauses.                                            | Internal resume, mutation-fence, identity, and coverage checks preserve the exact actor and account boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | pass   | Authorized live provider smoke remains pending.                                                                            |
| DOC-032 | internal | OAuth availability, build inputs, compensation, and emergency recovery fail closed until evidence exists.                                              | Internal operator checks retain dark-launch, compensation, build, and recovery contracts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | pass   | Operated provider proof is still required before readiness can become enabled.                                             |
| DOC-033 | internal | External runtime evidence is version-exact, live, explicitly ready, and retry-safe.                                                                    | Internal Wizard and authenticated support checks retain immutable-version and cleanup contracts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | pass   | Operated endpoint, reservation, runtime smoke, and provider cleanup remain required production evidence.                   |
| DOC-034 | internal | Support authority is release-fenced per operation and temporary readiness is dark-launched.                                                            | Internal exact-version, release-tag, audit, and readiness recovery checks pass locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | pass   | Operated provider and interruption recovery remain required production evidence.                                           |
| DOC-035 | internal | Temporary provider and claim response loss recovers without duplicate effects or leaked authority.                                                     | Internal provider-inspection, replay, expiry, and version-equality checks remain executable locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | pass   | Operated temporary-account, lost-response, expiry, and provider-cleanup evidence remains external.                         |
| DOC-036 | in_scope | Public entry and docs are task-led, review-focused, and release-smoked against the deployed contract.                                                  | Anonymous landing, Prepare/created-state, MDX/Worker parity, and value-free public route/OpenAPI smoke pass locally; route-specific title/canonical/H1/marker and bounded media checks reject stale, generic, swapped, or oversized responses.                                                                                                                                                                                                                                                                                                                                                                                                             | pass   | Deploy, then require the anonymous production contract smoke and operated UX checks to pass.                               |
| DOC-037 | internal | External setup documentation matches executable OAuth-delivery, custom-MCP isolation, and support-Worker recovery contracts.                           | Internal setup contracts retain delivery, orphan cleanup, per-invocation isolation, recovery, rollback, and smoke requirements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | pass   | Provider operations require the human-run Wizard plus action-time authorization.                                           |
| DOC-038 | in_scope | Every runtime route is either a public OpenAPI automation contract or one explicit browser, protocol, representation, approval, or operator exclusion. | The gate resolves 153 statically registered Hono operations, including local and relative-imported string constants: 32 must match OpenAPI and the remaining 121 must match exactly one non-stale rule in `api-route-ledger.json`; dynamic or unresolvable registrations fail closed.                                                                                                                                                                                                                                                                                                                                                                      | pass   | Re-run the production docs smoke and operated navigation check after deployment.                                           |
| DOC-039 | internal | Managed WFP, its provider reservation, and custom MCP remain separate internal runtime contracts.                                                      | Internal operator docs and executable checks retain credential custody, isolation, retirement, and fail-closed readiness evidence without placing it in public review-product copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | pass   | Live reservation, retirement, support response, dynamic revision smoke, and readiness promotion are production-unverified. |
| DOC-040 | in_scope | Review-layer customization uses strict Code Mode and stays separate from the artifact.                                                                 | MCP always lists exactly search and execute; a bounded ordinary-path catalog supplies trusted active coordinates, then one-Shiplet-focused search/execute calls register authorized activation-fenced operations without physical MCP tools or unbounded package loading. Request-time composition reads only an immutable digest-bound MCP projection; revision fencing, delegated-organization scope, isolated execution, capability checks, and quarantine keep package prose and output outside model context. The public stable contract still exposes widget-relative read, preview, and approved apply operations with an optimistic version fence. | pass   | Run the production MCP, catalog, active-operation, rollback-invalidation, and review-layer smoke after deployment.         |
| DOC-041 | in_scope | Why Shiplet explains the product boundary and gestures toward organization-owned, customizable software without publishing its internal roadmap.       | Full verification, both renderers, six stable image routes, public discovery, and desktop/mobile browser checks pass; the login entry links directly to Why Shiplet as Docs, the custom-widget examples show an engineer-authored acceptance runner and a researcher-authored evidence board, and the page keeps the distribution primitive unnamed.                                                                                                                                                                                                                                                                                                       | pass   | Run the anonymous production docs smoke after an authorized deployment.                                                    |
| DOC-042 | in_scope | Code Mode explains how a person connects an agent to Shiplet, what the agent can do, and where its authority ends.                          | Both renderers give the agent the root guide and MCP endpoint, keep the browser approval at product level, explain the selected-organization boundary and exact Shiplet permissions, and verify the connection through <code>tools/list</code> plus a harmless read. Provider request fields, credential exchange, rotation, and lifetimes stay in the machine guide. The Shiplet-owned visual shows the product flow through Shiplets and feedback.                                                                                                                     | pass   | Re-run the production claim and docs smoke after future identity or authorization changes.                                |

## Candidate coverage

- Public pass: 29
- Internal compatibility evidence: 13 (8 passing executable contracts, 5 not applicable to the public surface)
- Partial: 0
- Fail: 0
- Untested: 0
- Ambiguous: 0 unresolved (one branch resolved conservatively)
- Excluded: 0

## Pre-repair blind benchmark

The fresh blind critic inspecting frozen candidate
`3f5a8c5e19ffea7c40d5e6bca6b059e3a4f66f43` scored:

- Functional completeness: 87/100
- UX fluency: 89/100
- Developer experience: 86/100
- Security isolation: 96/100
- Critical/high security findings: 0

The critic identified five medium gaps: overstated OpenAPI coverage, incomplete
Worker feedback guidance, missing lifecycle/account journeys, under-explained
OAuth protections, and no discoverable operator-setup journey. This repair
addresses those findings. A post-repair benchmark must score the exact frozen
repair candidate; the earlier benchmark is not reused as release evidence.

## First repair review

The environment's retained-thread limit prevented a genuinely fresh second
critic after `d9a6c97`; two non-builder agents were reactivated independently
and are not represented as fresh. The security/Cloudflare review scored
security 88, functional 55, UX 70, and DX 74. It found two High contract
defects: the public setup implied WFP support namespaces activated an
integration absent from the main kernel, and the account-list request used
unsupported pagination. It also found the selected-account Workers Scripts Write
blast radius under-explained. The UX review scored security 96, functional 92,
UX 88, and DX 89, finding an over-compressed Worker renderer, missing stage
anchors, and no trusted-release checkout fence.

DOC-030 and its executable checks repair all of those concrete findings. A
critic must inspect the new exact frozen commit before its scores can be used as
release evidence.

## Second repair review

Three independently reactivated non-builder critics inspected exact commit
`95057226029813f93728e0401fd2f1934b4434b8`; the thread limit still prevented a
new agent, so these are explicitly not represented as fresh. The operated UX
critic passed the bar at security 98, functional 95, UX 93, and DX 95. The
general contract critic scored 94/92/89/89 and found one High authority-wording
contradiction plus identity-selection and OpenAPI overclaims. The Cloudflare
critic scored 88/89/87/88 and found one High release-integrity TOCTOU plus
non-blocking WFP and provider-proof gaps.

DOC-031 records the executable repair. The Wizard now rejects a worktree changed
after approval, invalidates legacy and previous-commit completion flags, rechecks
the exact commit before every scripted mutation and human-controlled mutation
ceremony, does not create dormant WFP namespaces, and keeps
Bearer account discovery unavailable pending authorized provider smoke. A new
exact-SHA review remains required for release evidence.

## Fourth repair checkpoint

The strengthened Wizard check failed because a public legacy resume ledger with
completion flags but no release commit remained reusable, and because scripted
mutations did not pass through a per-command release fence. The implementation
now clears legacy or mismatched public resume state after confirmation and
routes every D1 create/migration, Worker deployment, secret write, main deploy,
through one `wrangler_mutate` fence. Emergency rollback instead uses the
captured Worker version UUID through a source-independent `wrangler_recover`
path, so checkout drift cannot prevent recovery. The focused Wizard and
documentation contracts pass 14/14, the focused rendered route passes 1/1,
and shell syntax, type checking, and Mint validation pass. No provider operation
was performed.

## Fifth repair checkpoint

Three non-builder blind critics inspected exact commit
`d2a746146ff3e026644a5caeae3fa14619ed4b46`. They identified release blockers
in Vite environment discovery, emergency rollback coupling, OAuth availability
before provider proof, finalization compensation, and the legacy token-based
setup aliases. Executable RED checks were added before each repair. The
platform-client build now disables Vite environment discovery and proves a
sentinel in a temporary `.env` cannot enter the bundle; emergency rollback
validates only the captured version UUID; OAuth remains dark until an exact
operator smoke succeeds and a second explicit confirmation enables it; local
finalization conflicts trigger remote revocation; and both legacy setup aliases
delegate to the value-free external Wizard. Focused build/Wizard, OAuth route,
documentation, rendered-route, shell, and type checks pass. Complete exact-SHA
gates and a post-repair blind review remain required; no provider operation was
performed.

## Sixth repair checkpoint

The exact `a31fa26` blind runtime review found two High and two Medium release
gaps: the direct deployment API could bypass the static-only coordinator guard,
emergency rollback still trusted a mutable Worker name from repository config,
failed provider cleanup had no production retry caller, and source/dry-run
binding checks did not attest the exact live service versions. Executable RED
checks reproduced each gap. The shared deployment orchestrator now rejects
module-bearing customer revisions before authority or provider effects; recovery
accepts only the literal `shiplet` Worker plus an account-pinned immutable UUID;
the control-plane schedule retries bounded cleanup; and Stage 10 requires an
authenticated five-entrypoint live contract matching the captured support
Worker versions. Focused runtime, route, Wizard, docs, and type checks pass; a
new exact-SHA blind review and operated provider evidence remain required.

## Seventh repair checkpoint

Two exact-`881f7a5` blind critics found that temporary availability enabled its
public path before smoke, live version checks were diagnostic rather than an
authority fence, swapped binding identities were accepted, and successful
cleanup could precede its immutable audit. Executable checks reproduced each
gap. Temporary readiness now follows `disabled` → exact-user
`operator_smoke` → separately confirmed `enabled`, with failure and interruption
recovery. Support Workers carry the trusted-commit release tag; every privileged
RPC receives and validates its exact version/tag before authority, and route
preflight rejects any five-entrypoint drift. Cleanup records an immutable retry
intent before its provider effect. A new exact-SHA full gate and fresh blind
review remain required; no external resource was changed.

## Eighth repair checkpoint — operation ownership and exhaustive API classification

Two fresh critics inspected frozen commit
`fcb944b337da0020d4964720bdc3072151bf37ff`. The documentation/Wizard critic
scored security 88, functional completeness 84, UX fluency 88, developer
experience 85, and overall 85. It found ambient dispatch authority, ambiguous
secret-response recovery, same-tag cross-clone ownership drift, incomplete
first-deploy absence handling, generic terminal success, and no complete route
ledger. The support-security critic scored security 82, functional 89, UX 87,
developer experience 92, and overall 85. It found provider-token orphan and
acknowledgement response-loss risks plus unbounded OAuth start/retention debt.
The candidate was rejected and was not merged or deployed.

Executable RED checks preceded the repair. The Wizard now persists a unique
UUIDv4 operation identity before mutation, tags every provider-created Worker
version to that operation, reconciles a lost secret-write response only from
one exact matching version, proves first-deploy absence, and reports distinct
verified, safe-stop, recovered-failure, and unrecovered-failure outcomes. The
kernel no longer accepts an ambient dispatch credential or direct namespace
mutation path. OAuth provider material enters an encrypted cleanup index before
attachment, attachment and cleanup claim ownership atomically, consumed
acknowledgements replay authoritatively, and quotas plus bounded retention are
enforced. DOC-038 now parses all 151 literal Hono operations: 32 are OpenAPI
operations and 119 match exactly one non-stale exclusion.

Current local evidence is 1,356/1,356 Vitest checks, 26/26 Wizard scenarios,
25/25 public-documentation checks, 24 enabled browser E2E checks with one
declared stress skip, 105/105 killed security mutants, 8/8 killed embed
mutants, plus passing typecheck, Mint validation, main Worker dry run,
WordPress tests, and WordPress packaging. A new immutable-commit blind review
and operated production evidence remain required; no provider operation was
performed by these checks.

## Ninth repair checkpoint — executable operator setup and fail-closed route proof

Three fresh critics inspected exact commit
`3342616c546d409c8284200f3ebac9f895b977ee`. The documentation/Wizard
critic rejected it at security 93, functional completeness 82, UX fluency 84,
developer experience 82, and overall 84. The security critic rejected it at
90/88/87/91 and overall 89 because a repeat Wizard could replace the sole
encryption key and strand provider grants. The integrated critic conditionally
passed the local design at 95/92/91/91 and overall 92, but reproduced incomplete
route coverage and correctly withheld production acceptance. The candidate was
not merged or deployed.

Executable RED checks then drove the repair. The Wizard distinguishes exact
unfinished-operation resume from a new operation, invalidates stale completion
claims, inventories required secret names without values, proves exact D1
bindings and no pending migrations, and permits key creation only for a
machine-proven empty first install owned by the current operation. Unsupported
rotation and lost-key incidents fail closed for provider-side manual recovery.
OAuth quota is reserved atomically before state sealing, and provider cleanup
now checkpoints revocation and ciphertext retirement so response loss resumes.
The account page exposes the public, non-credential operator ID with an
accessible copy action. The authenticated support-contract ceremony shows the
expected tuple and establishes a browser session first.

The docs gate now validates all 15 rendered content digests in the normal test
path and resolves static route constants, Hono aliases, and relative named
imports. It classifies 153 operations—32 OpenAPI and 121 exact exclusions—and
rejects dynamic or unsupported registration. Current local evidence is 1,360
Vitest checks, 29 Wizard scenarios, 42 public-documentation checks, 25 enabled
browser E2E checks with one declared stress skip, 110/110 killed security
mutants, and 8/8 killed embed mutants, plus green typecheck, Mint validation,
main/support Worker dry runs, WordPress tests/package, and dependency audit.
Fresh exact-commit blind review and operated production evidence remain
required; no provider operation was performed by these checks.

## Eleventh repair checkpoint — conditional custom MCP and sealed-preview ceremony

The fresh documentation/Wizard critic rejected exact pushed commit
`43000a289ad060f417f4c75aa68646f8d79e57ce` at security 93, functional 82,
UX 84, and DX 87. It directly reproduced an invalid-option write to the ignored
resume ledger, found that Stage 10 always demanded `runtime_unavailable` even
when the separate Dynamic Workers Loader was available, observed that production
smoke skipped the authenticated sealed preview, and found the Extensions guide
denying the route documented by CLI and Packages. The candidate was not merged
or deployed.

Executable RED checks produced eight failures across Wizard and docs contracts.
The repair rejects invalid arguments before temp state, traps, ledger, or lock;
installs the exact lockfile graph and invokes repository-local Wrangler/Vitest;
branches custom MCP evidence on Worker Loader availability; and requires
validate → authenticated sealed preview with unchanged active tenant/revision →
promote. MDX and Worker-rendered Extensions plus the operator guide now state
the same contract. Focused evidence is Wizard 38/38 and docs 17/17. Aggregate
gates are also green: 1,376 Vitest checks, Wizard 38/38, public docs 43/43,
typecheck/build/Mint, 26 E2E passes plus one declared stress skip, 110/110
security and 8/8 embed mutants killed, support Worker dry-runs, WordPress
package, and zero dependency vulnerabilities. A fresh frozen-candidate review
remains pending; no external service was mutated.

## Twelfth repair checkpoint — truthful Wizard timing and locked Mint

Exact commit `14cbca1dad8eb55283445851c0f6f674f9964d29` was not
merged or deployed after a fresh documentation/Wizard critic found the stage
estimates summed to 135 minutes while the banner claimed 75, and the documented
validation command could acquire an unpinned Mint CLI. RED checks reproduced
both defects. The repaired contract computes the exact authored total and uses
an isolated, exact Mint lock restored before documentation validation or any
privileged provider call. A digest-fenced compatibility patch permits the
advisory-free YAML parser; real Mint validation and both dependency audits pass.
A new exact-SHA critic and operated production proof remain required.

The complete post-repair local gate also passes: 1,376 Vitest checks, all 38
Wizard scenarios, 43 public-documentation checks, type/build/Mint, 26 E2E
passes plus one declared stress skip, 110/110 security and 8/8 embed mutants,
support dry runs, WordPress packaging, shell/diff checks, and both dependency
audits. The repaired commit and fresh blind verdict remain pending.

## Thirteenth repair checkpoint — runnable preview and operator entry

Exact pushed commit `197d5964d72dd0bfacb75d77379531158d2c4501` was held
after a fresh docs/Wizard critic reproduced a clean-install Mint preview crash.
The locked graph had selected Express 5 for a Mint preview route that requires
Express 4 semantics. It was not merged or deployed.

The repaired isolated graph uses the current advisory-free Express 4 release.
The normal documentation gate now performs a clean install, Mint build
validation, starts the actual preview, and fetches Quickstart plus External
Setup. The Wizard exposes value-free `--help` and `--preflight` before all state
or provider setup, and both public renderers list the exact static extensions
while explaining why active SVG is rejected. Focused docs 18/18, Wizard 39/39,
preview 2/2, and both audits pass. The complete repaired gate also passes:
1,376 Vitest checks, WordPress 4/4, build boundary 8/8, CLI subprocess 5/5,
support migration 1/1, typecheck/build/docs, 26 E2E passes plus one declared
stress skip, 110/110 security and 8/8 embed mutants killed, all four Worker
dry-runs, WordPress packaging, shell/diff checks, and zero known vulnerabilities
in both lockfiles. A cohesive commit/push and fresh exact-SHA critic remain
pending.

## Fourteenth repair checkpoint — Wizard authority and macOS operability

Two fresh exact-SHA critics held `adaca3f` after reproducing a real macOS Bash
failure and finding that the Wizard did not distinguish browser OAuth from
ambient Wrangler credentials. The ignored public resume file also lacked a
defensible no-follow boundary. No merge or deployment occurred.

The public external-setup contract now states Bash 3.2/OpenSSL prerequisites,
the fixed experimental `shiplet-external-setup` profile, OS-backed encrypted
storage, ambient-token and dotenv refusal, no-follow public-state behavior, and
the separation between this local operator profile and customer deployment
grants. The full local release gate now passes: core Vitest 1,376/1,376,
WordPress 4/4, build boundary 8/8, CLI/session 5/5, Wizard 44/44, support
migration 1/1, public docs 44/44, Playwright 26 pass with one declared stress
skip, type/build/docs validation, all four Worker dry-runs, WordPress packaging,
110/110 security and 8/8 embed mutants killed, shell/diff checks, and zero known
vulnerabilities in both lockfiles. Commit, push, and a fresh exact-SHA critic
remain pending.

The integration audit also replaced the Wizard's `env -u` launcher with a
subprocess-local named authority scrubber after a new Secret Safety assertion
failed. The behavioral OAuth fixture and all 44 Wizard checks remain green.

## Fifteenth repair checkpoint — deterministic bootstrap and complete help

Fresh critics rejected exact pushed commit `d60153c`; no merge or deployment
occurred. The support first-bootstrap fixture could cross its ten-second harness
deadline under process pressure, and public help omitted required verification
and recovery operands.

Help now prints exact commit, Worker-version, and account operands. Malformed
public options exit before temporary state, traps, locks, or the public ledger.
The bootstrap harness deadline is 30 seconds, and four concurrent eight-case
suites pass 4/4. Full gates, replacement commit/push, and a fresh blind round
remain pending. Candidate public routes and Stage 10 operation remain correctly
unverified until deployment.

The replacement aggregate is green: core Vitest 1,376/1,376, WordPress 4/4,
build boundary 8/8, CLI/session 5/5, Wizard 44/44, support migration 1/1,
public docs 44/44, typecheck/build/docs validation, all four Worker dry-runs,
WordPress packaging, Playwright 26 pass with one declared stress skip,
shell/diff checks, and zero known vulnerabilities in both lockfiles. Security
and embed mutation target sources are unchanged from their 110/110 and 8/8 pass.

## Sixteenth repair checkpoint — credential-root continuity

Fresh exact-SHA critics passed `633ab5e` above every numerical threshold and
found no Critical or High issue. One Medium held live setup: the first-install
emptiness proof omitted the two newest immutable support-health tables.

The repair adds continuity-only and reconciliation-only partial-root fixtures,
counts all 16 durable control-plane tables in both Wizard and runtime
predicates, and derives a drift check from every migration. The replacement
aggregate passes 1,377 Vitest checks, Wizard 45/45, public docs 44/44,
typecheck/build/docs, 26 E2E plus one declared skip, three support Worker
dry-runs, and 111/111 security plus 8/8 embed mutants. Replacement commit/push
and one fresh bounded review remain pending. No external state changed.

## Seventeenth repair checkpoint — scheduled-first continuity

Fresh exact-SHA review rejected `0717559` before merge or provider access.
Cron-first startup could write reconciliation history before creating the
credential-continuity sentinel, making safe initialization impossible. The
migration drift test also discovered only a fixed filename list.

The repair requires continuity before any reconciliation row, covers the real
D1 cron-first ordering, and kills a dedicated regression mutant. Migration
inventory now enumerates the directory, with a temporary future-table fixture
proving uncounted durable state is detected. The aggregate passes 1,378 Vitest
checks, Wizard 46/46, public docs 44/44, support migration 1/1, and 112/112
security mutants with zero survivors. Typecheck/build/docs, Playwright 26 pass
with one declared skip, three support Worker dry-runs, WordPress packaging,
both dependency audits, and 8/8 embed mutants also pass. Replacement
commit/push and one fresh blind review remain pending. No external state changed.
