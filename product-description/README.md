# Shiplet product description

A written description of the user experience of Shiplet: what the user sees, what they can do, and exactly what happens when they do it.

## Purpose

Shiplet is, from the user's point of view, a large state chart. The user moves through it with page loads, form submissions, clicks, keyboard shortcuts (C, Escape, Ctrl/Cmd+Enter), pointer gestures on a reviewed artifact (choosing an element, drawing on a screenshot, dragging a card), and with whatever the server, other tabs, and other people change in the meantime. Most of that behavior is defined implicitly, spread across a Worker router, a server-rendered dashboard script, a handful of React pages, a 4,600-line review host script, an artifact-frame bridge, and the tests. There is no single place that says, in plain language, "when the user does X, this is what happens, and this is what happens if they do Y halfway through."

This project is that place. It describes the full experience a signed-in organization member has in the Shiplet web app, with default settings and nothing customized: publishing an artifact from the browser, managing Shiplets and who can open them, and above all opening a review link and leaving, reading, and moving feedback on it.

The documents are for people who need to understand or change the product: designers, engineers, writers, testers, and anyone evaluating whether a behavior is intentional. They are written from the outside in. They describe the experience, not the implementation.

### What this is not

- Not API documentation. The REST contract is `openapi.json` in the source repo, and agent access is described in `docs/code-mode-mcp.mdx` and `docs/cli.mdx`.
- Not organized by package. The router, the dashboard runtime script, the React platform pages, the trusted review host, and the artifact bridge are not described separately. A single behavior is described once, wherever the user encounters it.
- Not a technical design document. Where a technical detail is critical to understanding the experience, it appears in a block quote labeled `Technical note:` and nowhere else.

## Conventions

- Describe the experience, not the code. "The Send button stays disabled until the server answers" rather than "`setComposerBusy(true)` disables the form controls".
- Technical detail goes in block quotes, prefixed with `Technical note:`. Use it only when the mechanism changes what the user would expect.
- Use sentence case for headings.
- Name the vocabulary consistently. The [glossary](glossary.md) is the source of truth for terms like Shiplet, review link, ticket, thread, pin, composer, draft, and saved.
- Every document ends with the commit of shiplet-core it was verified against and a list of open questions.
- When a behavior is surprising, say so and say why it is that way if the reason is known. Do not smooth it over.

## The work to be done

Each document describes one feature. Features are large things (the composer that turns a click on the artifact into a ticket) or small things (the form that grants one person access to one Shiplet), but each is described in full, including its edge cases and its interactions with other features.

### Document template

Every feature document follows the same skeleton so that documents are comparable and nothing is skipped.

1. **Summary.** One paragraph describing the feature abstractly. For example: "The invite reviewers form grants one person, one team, or the whole organization a role on one Shiplet, and for a person it also sends an invitation email."
2. **The simple case.** The common path in prose.
3. **The interaction, event by event.** The five phases of a page or form lifecycle: **Arrive** (the route or control that opens it, what loads, what is focused, what is prefilled), **Leave untouched** (closing or navigating away before changing anything, and whether anything is recorded), **Begin editing** (the first change: what becomes dirty, what is saved locally, what validation runs, what buttons enable), **While editing** (live validation, local draft saving, polling, dependent fields, pointer work on the artifact, what the URL does), and **Submit** (what is sent, what is disabled meanwhile, the success and failure paths, where the user lands). Every document uses these five subsection headings in this order. Include a small state diagram (Mermaid `stateDiagram-v2`) of the states the user passes through.
4. **Modifiers.** A table of the variant axis, with the same five rows in every document, in this order: **Role** (organization administrator, the Shiplet's owner, an editor grant, or a member or grant holder who can only view); **Shiplet state** (visibility private, organization, unlisted, or public; active or archived); **Flags and preferences** (feature flags, which are all off by default, the review preferences, and the theme); **Keyboard** (Enter, Ctrl/Cmd+Enter, Escape, Tab, and the C shortcut); **Narrow screen** (a viewport 640 px wide or less). Two columns: what each one does when set at arrival, and what changes if it changes during editing.
5. **Cancel and interrupt.** The same checklist in every document, in this order:
   - Escape or Cancel
   - Leaving by a link inside Shiplet (the platform navigation, a row link, Open review)
   - Browser back or forward
   - Reload, or the tab or window is closed
   - The window loses focus or the tab is hidden
   - Network lost
   - Request fails (a server error, rejected input, or no answer)
   - Session expires or access is revoked
   - The same record changed in another tab
   - The same record changed by another person
   - Autofill, a password manager, or an input method (IME) writes into a field
   - The artifact navigates to another page (review link only)

   Two columns: before editing, and while editing or submitting. Every cell filled, "No effect." where that is the answer.
6. **Interactions with other systems.** One bold-led paragraph per concern, in this order: **Permissions and roles.** **Validation and error display.** **Unsaved changes and drafts.** **Undo.** **Optimistic updates and rollback.** **Offline and reconnection.** **Live updates and collaboration.** **Status messages and notifications.** **URL and browser storage.** **Localization and time.** **Accessibility.** **Side effects others notice.** A concern with no interaction still gets its one line.
7. **Edge cases.** Anything a user could notice that is not covered above.
8. **Open questions and verification.** The shiplet-core commit the document was verified against, and any behavior that could not be confirmed.

Item 5 matters most. Asking the same interrupt questions of every feature is how gaps and inconsistencies are found. What each interrupt means across the product is defined once, in `foundations/page-lifecycle.md`.

### Method

For each document:

1. Read the route in `src/index.ts` that serves the page or handles the request, and the code that renders the page: `src/render.ts` (page shell, Shiplet page, dashboard runtime script), `src/platform/*` (React pages), or `src/trusted-review-host.ts` (the review layer) with `src/trusted-artifact-bridge.ts` (its half inside the artifact frame).
2. Read the matching tests. The browser tests in `e2e/` are close to executable specifications of the edge cases: `e2e/trusted-review-host.spec.ts`, `e2e/review-local-recovery.spec.ts`, `e2e/contextual-review-thread.spec.ts`, `e2e/review-navigation-draft-pins.spec.ts`, `e2e/review-scope-browser.spec.ts`, `e2e/feedback-inbox.spec.ts`, `e2e/shiplets-lifecycle.spec.ts`, `e2e/invite-links.spec.ts`. The unit and integration tests in `test/` (`test/index.spec.ts`, `test/trusted-review-host.spec.ts`, `test/trusted-artifact-bridge.spec.ts`, `test/review-scope-pagination.spec.ts`, `test/organization-invite-links.spec.ts`) settle server rules.
3. Draft the document.
4. Try anything ambiguous in the running product (see "Where to run it" under Scope decisions). Tests settle "what happens"; the running product settles how it feels, what is visible while the interaction is in progress, and what the timing is like.
5. Record the commit verified against.

### Verification

Drafting reads the code; verification watches the product. The `verification/` directory holds one checklist per cluster of documents, each item a single observable claim with setup, steps, expected result, a priority, and the device it needs. A tester runs them against a local test-mode Shiplet (or a throwaway account on a staging deployment), records `pass`, `fail`, or `blocked` in the Result column, and files every failure in `bug-triage.md` with the item's ID. A document moves from `drafted` to `verified` in the coverage table only when every P1 and P2 item for it has passed or been filed.

`bug-triage.md` is the other half: every behavior the documents flagged as a likely defect, deduplicated, with reproduction steps, the reason in the code, a severity, and the decision the product team needs to make. Entries confirmed in the running product carry a Status line.

### Order of work

1. **Pilot: the invite reviewers form.** Small and self-contained. Used to settle the template, tone, and depth.
2. **Foundations: the page lifecycle, the data model, access and roles, navigation, and the review link.** Everything else refers to them.
3. **The review link (`review/`).** The bulk of the experience and the hardest part. Written third so the template is already proven. The documents that own the state handoffs (the comments panel, the composer, selecting and capturing, sending and drafts) come first.
4. **Everything else.** Once the template and the exemplars exist, the remaining documents can be drafted in parallel, followed by a consistency pass and a verification pass across the whole set.

Progress is tracked in the [coverage table](#coverage) below.

### Scope decisions

These were decided without the user, from the code and the product docs, because nobody was available to ask. Each says why.

- **Where this description lives.** A new top-level directory, `product-description/`, inside the shiplet-core repo, on the branch `claude/global-skill-repos-wcchad`, instead of a separate git repo, because a new repo could not be created for this work. Everything outside `product-description/` is the read-only source of truth and is never modified. The new directory does not touch any of `npm run verify`'s inputs: TypeScript includes only `src/`, `workers/`, `e2e/`, and `test/`; Vitest runs `test/**/*.spec.ts`; `scripts/public-source-preview.test.mjs` reads only named files and the pages listed in `docs.json`. A Mintlify docs build from the repo root may still pick up these Markdown files as unlisted pages; that is a deployment question for the docs site, not a verify failure.
- **The source commit.** Commits to this directory move the repo's HEAD, so the source commit is pinned once, as the last commit that touched anything outside `product-description/` (`git log -1 --format=%h -- . ':!product-description'`): `3327af4`. Every document's footer cites it.
- **Product and surface.** The Shiplet web app (`src/index.ts` platform routes plus the tenant review routes), as a signed-in organization member sees it, with default settings: no feature flags enabled (account email switching is off), no custom review widget attached, the theme following the system, and every review preference at its default. The default viewpoint is a fresh account: on its first publish Shiplet creates a workspace for it, which makes it that organization's administrator and the owner of every Shiplet it creates. Where a lesser role sees something different (an organization member without administrator rights, or a person holding only a viewer or reviewer grant), the Modifiers table says so. The surface covers the Prepare page, the Shiplets list, the Shiplet page, the Feedback view, the Inbox, the Workspace, Account, and Access settings, the access gate, invite links, and the review link: the trusted host, the artifact frame, comments and annotations, pins, presence, and tickets.
- **Out of scope: automation surfaces.** The CLI (`src/cli/`), Code Mode MCP (`/api/mcp`), the REST API (`openapi.json`), organization API keys, and the Agents settings page (`/agents`) are how agents and CI reach Shiplet, not how a person uses the web app. Where their results show up in the web app (a ticket written by an agent, a revision published through the API), the document that shows the result says so.
- **Out of scope: other ways in.** The embeddable website widget (`/embed/*`, `src/embed*.ts`) and its install page, browser capture (`/capture`) and the downloadable browser companion, and the public sandbox (`/play`) each run the review layer under different rules (a third-party page around it, a local capture, or no sign-in at all). The review host code has embedded-site branches; these documents describe only the hosted review link and do not describe embedded behavior.
- **Out of scope: operator and advanced paths.** Self-hosting and deployment (`scripts/self-host-*`, `workers/`), the Shiplet ownership page (`/shiplets/:id/ownership`: revision packages, Cloudflare connection, managed runtime), Worker-code artifacts (unavailable unless Workers for Platforms is configured), custom hostnames, and the docs site (`/docs`) are left out. The docs site is content, not behavior.
- **Custom review widgets get one cross-cutting document.** They are not part of the default surface, but an agent can attach one to any Shiplet, and then the review link visibly changes (a widget frame, Custom actions, confirmations). One document describes that change rather than every review document carrying a widget row.
- **Notifications are described once.** Who is notified of what (mentions, new tickets, replies, status changes, watching) lives in `cross-cutting/notifications-and-watching.md`; every document's "Side effects others notice" paragraph links there instead of restating the rules.
- **What each interrupt means is described once.** `foundations/page-lifecycle.md` owns the meaning of every row of the interrupt table and the polling intervals; the review-specific meanings (a disconnected artifact, a route change inside the artifact) are owned by `foundations/the-review-link.md`.
- **The dashboard preview is the review link.** The Shiplet page embeds the same review layer in an iframe. The review documents describe both at once and note the few differences; the foundation for the review link owns them.
- **Interaction shape.** The unit of interaction is a page or form lifecycle, and its phases are Arrive, Leave untouched, Begin editing, While editing, and Submit. Pointer work inside the review link (choosing an element, drawing, dragging the composer) is narrated inside While editing. The variant rows, the interrupt list, and the order of cross-cutting concerns are fixed as written in the document template above.
- **Where to run it.** For verification, the product runs locally in test-auth mode exactly as the browser tests run it: `npm ci`, then `npm run build:platform-client`, then `npx wrangler dev --config wrangler.test.jsonc --local --port 8787 --env-file {file}` with `SHIPLET_AUTH_MODE=test`, `CUSTOM_DOMAIN=` (empty), `SHIPLET_APP_URL=http://localhost:8787`, and `WORKOS_REDIRECT_URI=http://localhost:8787/auth/callback` in that file. Sign in by opening `/auth/callback?code=test-code::{email}`. With `CUSTOM_DOMAIN` empty, a review link is `http://localhost:8787/{address}/` rather than `https://{address}.shiplet.cc/`. A real sign-in needs a WorkOS AuthKit application (`.dev.vars` from `.dev.vars.example`), and invitation emails are only simulated in test mode.
- **Numbered rules.** These are prose documents, not numbered specifications. Stable heading anchors are enough for cross-references.

## Structure

```
README.md                        this file
goal.md                          the standing instructions for whoever drafts
AGENTS.md, CLAUDE.md             entry points for agents: read README.md, then goal.md
glossary.md                      shared vocabulary
bug-triage.md                    suspected defects collected from every document, with repro steps and decisions needed

verification/
  README.md                      how to run a hand-verification pass and record results
  foundations-and-review.md      checklists for foundations/ and review/
  app-pages.md                   checklists for preparing/, shiplets/, access/, feedback/
  cross-cutting.md               checklists for cross-cutting/

foundations/
  page-lifecycle.md              the five phases, what each interrupt means, saved and unsaved,
                                 live updates and polling, status messages (core foundation)
  shiplets-and-tickets.md        the data model: organizations, Shiplets, artifacts, revisions,
                                 the review link, tickets, statuses, replies, mentions, watching
  access-and-roles.md            identity, organization roles, Shiplet grants, visibility,
                                 who can view, edit, and manage
  navigation-and-urls.md         the header and platform navigation, routes, return after sign-in,
                                 deep links, review link addresses, the theme switch
  the-review-link.md             the trusted host, the artifact frame and its connection, review
                                 identity, what loads on arrival, Escape and C, routes inside the artifact

preparing/
  the-prepare-page.md            creating a Shiplet in the browser: source, files or URL, name and
                                 address, workspace, visibility, Create shiplet
  how-artifacts-are-shown.md     what an uploaded build, a standalone file, or a URL becomes
                                 inside the artifact frame

shiplets/
  the-shiplets-list.md           all Shiplets in a workspace: search, copy URL, archive, restore
  the-shiplet-page.md            one Shiplet's page: the embedded review, the comment list, Watch,
                                 lifecycle, agent handoff
  the-invite-reviewers-form.md   granting a person, a team, or the organization a role on one
                                 Shiplet (pilot)
  archive-restore-and-delete.md  archiving, the restore window, the archived page, permanent delete

access/
  your-account.md                signing in and out, returning after sign-in, the Account page
  the-access-gate.md             opening a Shiplet you cannot view: sign-in, Request access,
                                 invitation consent
  the-workspace-page.md          organizations, the active organization, organization and team
                                 invitations, teams
  invite-links.md                creating, copying, and revoking invite links; joining through one

review/
  the-comments-panel.md          the Comments launcher and panel: list, count, filters, pagination,
                                 refresh, stale and error states, the options menu
  threads-and-replies.md         a ticket's thread in the list or beside its pin: reply, Resolve,
                                 Reopen, status, provenance
  pins.md                        pins on the artifact, pin stacks, the Page comments menu,
                                 revealing a target, Hide comments
  the-composer.md                the new-comment card: how it opens, compact and expanded,
                                 moving it, Cancel, Send
  selecting-and-capturing.md     annotation mode: choosing an element, element and page captures,
                                 capture fidelity
  drawing-on-screenshots.md      the freehand drawing overlay and the structured editor
                                 (pen, arrow, text)
  attachments-mentions-and-copy-requests.md
                                 the optional additions inside the composer
  sending-and-drafts.md          what Send commits, failure and retry, drafts kept across reload,
                                 storage notices
  presence-and-following.md      live reviewers, cursors, colors, following another reviewer
  review-settings-and-links.md   Settings (dock, launch, motion, copy requests), clean review
                                 links, Watch artifact

feedback/
  the-feedback-view.md           every ticket you can access, newest first, filtered
  the-inbox.md                   notifications for mentions, watched Shiplets, replies, and statuses

cross-cutting/
  notifications-and-watching.md  who is notified of what, watching, email delivery, nav badges
  custom-review-widgets.md       how an agent-attached custom widget changes the review link
```

## Coverage

Status is one of `not started`, `drafted`, or `verified`.

| Document | Status |
| --- | --- |
| glossary.md | drafted |
| goal.md | drafted |
| bug-triage.md | not started |
| verification/ (3 checklists and a README) | not started |
| foundations/page-lifecycle.md | not started |
| foundations/shiplets-and-tickets.md | not started |
| foundations/access-and-roles.md | not started |
| foundations/navigation-and-urls.md | not started |
| foundations/the-review-link.md | not started |
| preparing/the-prepare-page.md | not started |
| preparing/how-artifacts-are-shown.md | not started |
| shiplets/the-shiplets-list.md | not started |
| shiplets/the-shiplet-page.md | not started |
| shiplets/the-invite-reviewers-form.md | not started |
| shiplets/archive-restore-and-delete.md | not started |
| access/your-account.md | not started |
| access/the-access-gate.md | not started |
| access/the-workspace-page.md | not started |
| access/invite-links.md | not started |
| review/the-comments-panel.md | not started |
| review/threads-and-replies.md | not started |
| review/pins.md | not started |
| review/the-composer.md | not started |
| review/selecting-and-capturing.md | not started |
| review/drawing-on-screenshots.md | not started |
| review/attachments-mentions-and-copy-requests.md | not started |
| review/sending-and-drafts.md | not started |
| review/presence-and-following.md | not started |
| review/review-settings-and-links.md | not started |
| feedback/the-feedback-view.md | not started |
| feedback/the-inbox.md | not started |
| cross-cutting/notifications-and-watching.md | not started |
| cross-cutting/custom-review-widgets.md | not started |

## Reference

The source of truth is shiplet-core, the repository this directory sits in (`/home/user/shiplet-core`), at commit `3327af4`. The relevant locations are:

- `src/index.ts`: every route. The tenant routing middleware (around lines 10878 to 11760) decides whether a request is a review link and serves the trusted host, the artifact frame, and the review APIs under `/__shiplet/review/`. The platform pages are served from around line 19763 (`/`, `/workspace`, `/account`, `/access`, `/shiplets`, `/inbox`, `/feedback`, `/shiplets/:id`, `/shiplets/:id/review-host`, `/shiplets/:id/access`). The JSON APIs the pages call (`/api/dashboard`, `/projects`, `/api/projects/:id/...`, `/api/feedback`, `/api/notifications`) are throughout.
- `src/trusted-review-host.ts`: the review layer. `createTrustedReviewHostResponse` builds the host document; `trustedReviewHostScript` (lines 687 to 5347) is the whole review UI and its state; `trustedReviewHostStyles` is its stylesheet.
- `src/trusted-artifact-bridge.ts`: the script injected into the artifact frame that selects elements, captures screenshots, reports scroll and route changes, relays shortcuts, and follows another reviewer.
- `src/review-annotation-editor.ts`, `src/review-attachment-drafts.ts`: the structured drawing editor and the attachment chooser, both embedded in the review host script.
- `src/render.ts`: the page shell and header, the Shiplet page (`BuildShipletReviewPage`), the access request page, and `DashboardRuntimeScript`, which drives the Prepare form, the share forms, the Workspace forms, the Shiplet page's comment list, and the Shiplets list actions.
- `src/platform/`: the React pages (Prepare, Shiplets, Feedback, Inbox, settings, invite links) and the live-update polling script.
- `src/store.ts`: organizations, Shiplets, grants, and the view and edit rules (`canViewProject`, `canEditProject`).
- `src/review.ts`, `src/review-operations.ts`, `src/notifications.ts`, `src/review-presence.ts`: tickets and their statuses, durable submissions, mentions and notifications, and live presence.
- `src/organization-invite-links.ts`, `src/access-requests.ts`, `src/workos.ts`, `src/auth.ts`: invite links, access requests, invitations, and sign-in.
- `e2e/` and `test/`: the behavior tests named under Method.
- `docs/`: product guidance (`quickstart.mdx`, `publishing.mdx`, `access-control.mdx`, `review-feedback.mdx`, `extensions.mdx`) and behavior contracts (`review-widget-parity-audit.md`, `review-friction.md`, `shiplet-root-behavior-spec.md`). `PRODUCT.md` and `DESIGN.md` hold the product's own voice and design rules.
