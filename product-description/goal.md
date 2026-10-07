# Goal: complete the Shiplet product description

You are working in the `product-description/` directory of the shiplet-core repo. Read `README.md`, `glossary.md`, `foundations/page-lifecycle.md`, and `shiplets/the-invite-reviewers-form.md` first. The README defines the purpose, the document template, the method, the structure, and the coverage table. The other three are the exemplars: match their depth, tone, and structure exactly. For any document under `review/`, also read `foundations/the-review-link.md` and `review/the-composer.md`. Your job is to write every document in the README's structure until the coverage table has no `not started` rows, then run a consistency pass.

## Source of truth

shiplet-core is checked out at `/home/user/shiplet-core`. Everything outside `product-description/` is the source; never modify it. Describe the experience of the Shiplet web app as a signed-in organization member sees it, with default settings: no feature flags enabled, no custom review widget attached, the theme following the system, and every review preference at its default. The default viewpoint is a fresh account that has published a Shiplet (and so is the administrator of the workspace Shiplet created for it and the Shiplet's owner); a member without administrator rights and a person holding only a viewer or reviewer grant are the lesser roles. The CLI, Code Mode MCP, the REST API and API keys, the embeddable website widget, browser capture, the public sandbox, self-hosting, the ownership page, and Worker-code artifacts are out of scope; the README's Scope decisions say why.

For each document, read in this order before writing:

1. The route in `src/index.ts` that serves the page or answers the request. Review link requests go through the tenant routing middleware (around lines 10878 to 11760); platform pages are around line 19763 onward; the JSON endpoints the pages call are named in the page code.
2. The code that draws and drives the page. For platform pages: `src/render.ts` (`renderPage`, `BuildShipletReviewPage`, `BuildShipletAccessRequestPage`, and `DashboardRuntimeScript`, which handles most forms) and `src/platform/*` (React pages, `live-updates.ts`, `navigation.tsx`). For the review link: `src/trusted-review-host.ts` (`trustedReviewHostScript`, lines 687 to 5347: every control, state variable, and handler), `src/trusted-artifact-bridge.ts` (the half inside the artifact frame), `src/review-annotation-editor.ts`, and `src/review-attachment-drafts.ts`.
3. The server rules behind each action: `src/store.ts` (`canViewProject`, `canEditProject`, grants, projects), `src/review.ts` (tickets, statuses, list queries), `src/review-operations.ts` (durable submissions), `src/notifications.ts` (mentions, watching, notifications), `src/review-presence.ts` (presence), `src/organization-invite-links.ts`, `src/access-requests.ts`, `src/workos.ts`, `src/auth.ts`.
4. The tests. `e2e/` holds browser tests that are close to executable specifications: `trusted-review-host.spec.ts`, `review-local-recovery.spec.ts`, `contextual-review-thread.spec.ts`, `review-navigation-draft-pins.spec.ts`, `review-scope-browser.spec.ts`, `saved-review-anchor-bridge.spec.ts`, `review-annotation-editor.spec.ts`, `review-attachment-drafts.spec.ts`, `feedback-inbox.spec.ts`, `shiplets-lifecycle.spec.ts`, `invite-links.spec.ts`, `access-gate-cookie.spec.ts`. `test/` settles server rules: `index.spec.ts`, `trusted-review-host.spec.ts`, `trusted-artifact-bridge.spec.ts`, `review-scope-pagination.spec.ts`, `review-local-recovery`-style specs (`review-session-recovery.spec.ts`, `review-operation-recovery.spec.ts`), `organization-invite-links.spec.ts`, `ownership-route.spec.ts`.
5. The product's own contracts and audits in `docs/`: `review-widget-parity-audit.md` (56 behavior contracts with IDs such as PIN-01 and WRITE-07; cite them when a document describes the same behavior), `review-friction.md`, `shiplet-root-behavior-spec.md`, `access-control.mdx`, `review-feedback.mdx`, `publishing.mdx`, `quickstart.mdx`. Where code and docs disagree, describe the code and put the disagreement in "Open questions".
6. Defaults and limits: the constants at the top of `trustedReviewHostScript` (`defaultReviewPreferences`, `defaultFilters`), `REVIEW_ATTACHMENT_*` in `src/review-attachment-drafts.ts`, `REVIEW_STATUSES` in `src/review.ts`, `PRESENCE_COLORS` in `src/review-presence.ts`, `SHIPLET_ARCHIVE_RETENTION_DAYS` in `src/store.ts`, and the polling intervals in `src/platform/*`.

Do not describe code. Describe what the user sees and does. Technical detail goes only in `> Technical note:` block quotes, and only when the mechanism changes what the user would expect.

## Writing rules

- Follow the eight-section template in the README for every feature document. Foundation and cross-cutting documents may drop sections that do not apply but must still cover cancel and interrupt behavior wherever an interaction exists.
- Section 3 always has the five subsections `### Arrive`, `### Leave untouched`, `### Begin editing`, `### While editing`, `### Submit`, in that order, as in the pilot.
- Modifiers and cancel/interrupt go in tables, as in the pilot. The Modifiers table has exactly the five rows Role, Shiplet state, Flags and preferences, Keyboard, Narrow screen, with the columns "At arrival" and "During editing". The Cancel and interrupt table has exactly the twelve rows listed in the README, in that order, with the columns "Before editing" and "While editing or submitting". Do not add, drop, rename, or reorder rows in a single document; if a row does not apply, say "No effect" and why in a few words.
- "Interactions with other systems" walks the twelve concerns in the README's order, one bold-led paragraph each.
- Use the glossary's words. If you need a term the glossary lacks, add it to `glossary.md` in the right section with a full definition, then use it. Do not coin a synonym for an existing term (say ticket, not issue or card; say draft, not unsent message; say review link, not preview URL).
- Sentence case for all headings. Direct, concrete language. No hedging, no marketing.
- State surprising behavior plainly and say why if the reason is in the code or a comment. If it looks like a bug, say so in "Open questions" ("may be worth treating as a bug rather than documenting") rather than smoothing it over.
- Cross-reference other documents with relative links rather than repeating their content. `foundations/page-lifecycle.md` owns what every interrupt means and every polling interval; `foundations/the-review-link.md` owns the artifact connection, review identity, the Escape ladder, the C shortcut, and route changes; `foundations/access-and-roles.md` owns who can view and edit; `foundations/shiplets-and-tickets.md` owns what a ticket, status, and revision are. Do not restate them; link.
- Link only to files that exist. A document that is still `not started` in the coverage table is named in code font (`review/pins.md`), not linked, until it lands.
- Every document ends with "## Open questions and verification" listing what was read from code but not confirmed by hand, followed by `Verified against shiplet-core commit \`3327af4\``. The commit is pinned: do not use `git rev-parse HEAD`, which moves with every commit to this directory.
- One Mermaid `stateDiagram-v2` per interaction. Keep it to the states the user passes through; omit internal bookkeeping states.

## Things already established (do not re-derive, do not contradict)

Numbers and timings:

- Review layer: the ticket list polls every 5 s while the tab is visible and refreshes when the browser comes back online; the first page and every Load more bring up to 100 tickets; a poll adds and updates tickets but never removes one. Drafts are saved to IndexedDB about 150 ms after a change and at once when the tab is hidden or the page is left. The artifact connection is renewed every second and counts as disconnected after 3 s of silence. Presence reconnects after 1, 2, 4, 8, 16, then every 30 s. Cursors are sent at most every 50 ms, viewport changes every 80 ms. The bridge checks the artifact's address every 100 ms.
- Platform pages: notification and feedback counts (and the Feedback and Inbox lists) poll every 15 s, first 1.5 s after load, and on focus or visibility; skipped while hidden. The Shiplets list and invite links refresh only on focus when older than 30 s. The Shiplet page never polls.
- Sign-in sessions last 14 days from sign-in, not extended by use. A review pass on a review link with its own host lasts 5 minutes.
- Archive restore window: 30 days as promised and recorded (a delete-after date); nothing in this source enforces it. Comment and reply: 5,000 characters. Copy request: 4,000. Mentions: 20 from the review layer (25 accepted from agents). Attachments: 4 files, 5 MiB each, 10 MiB total, photos and video. Pins: at most 250 drawn per page; pins within 36 px of each other form a stack. Replies shown per thread: 100.
- Narrow screen is 640 px or less (the review layer's panel also closes after sending at that width); the review layer's CSS changes again at 480 px; the Shiplet page stacks its columns at 900 px.

Rules and definitions:

- What every interrupt row means, platform pages versus the review layer, is the table in `foundations/page-lifecycle.md`. The review layer's own machinery (artifact connection, review identity, the Escape ladder, the C shortcut, route changes, the dashboard preview) is in `foundations/the-review-link.md`.
- Platform forms keep nothing unsent, track no dirty state, never warn before leaving, and mostly do not disable their button while a request is in flight (a double click sends twice). They show the server's text verbatim in a top banner and a result banner; banners are not announced to screen readers.
- The review layer keeps every draft (composer and reply fields) in the browser under the review identity (person, Shiplet, revision, page). Attachments are not kept across reload. It never shows raw server text; its messages are fixed strings placed where the reviewer is working.
- Authority is checked by the server on every request, never latched at page load; most controls are shown to everyone and refuse on use. Viewing permits commenting, replying, changing status, and watching. Editing (owner, organization administrator, editor or owner grant) permits inviting and archiving from the Shiplet page; any organization member can archive and restore from the Shiplets list; only the owner can permanently delete, and only the owner sees Restore on the archived page.
- Viewer and reviewer grants are identical in effect. The invite reviewers form offers Reviewer, Viewer, and Owner, and the server refuses Owner.
- A mention of an organization member who cannot view the Shiplet gives them a reviewer grant. Accepting a Shiplet invitation also makes the invitee an organization member.
- Statuses are exactly New, In Progress, Blocked, Staging, Done, Dropped, in that order. Done and Dropped are closed. Resolve sets Done; Reopen sets New. Any status can change to any other.
- Tickets are labeled PF-n per Shiplet, never reused; tickets and replies cannot be edited or deleted. A Send carries an identity the server remembers, so a retry never creates a second ticket.
- Name, address, visibility, organization, and artifact of a Shiplet cannot be changed in the web app.
- `?feedback={ticket id}` deep links land on the Shiplet page, which ignores the parameter.
- Unlisted and Public behave identically. Signed-out visitors on them see tickets from the first poll but cannot send anything.

Naming decisions:

- Say Shiplet (capitalized) for the code's project; organization for what the interface also calls a workspace; ticket for the saved record and comment for its text; review link for the Shiplet's address; dashboard preview for the Shiplet page's embedded copy; composer for the "New annotation" card; draft for unsent review-layer work.
- The code's "subdomain" is the interface's "Shiplet address"; write address.
- Ctrl/Cmd for the code's ctrlKey or metaKey.

Ownership of review-layer states (each state is described in exactly one document; others link):

- `foundations/the-review-link.md`: arriving (access check, identity, first load), review identity and its re-checks, the artifact connection, the Escape ladder and the C shortcut, route changes inside the artifact, the dashboard preview.
- `review/the-comments-panel.md`: the launcher dock; panel open and closed; the ticket list's loading, empty, loaded, stale, and error states; polling and Refresh; filters and their storage; pagination; the options menu (it links out for Watch, Hide comments, and Settings); previous and next.
- `review/threads-and-replies.md`: which thread is active and in which presentation (list or contextual); the reply field and its sending state; Resolve, Reopen, and the Status picker and their sending state; provenance; Open feedback.
- `review/pins.md`: where pins are drawn and when they are hidden (overlay off, annotation mode, target hidden or offscreen, 250 limit); pin stacks and their menus; the Page comments menu; revealing a target; Hide comments and Show comments.
- `review/the-composer.md`: every way the composer opens (Annotate, C, the creation menu, a capture arriving, a restored draft); compact and expanded; anchoring and dragging; Close versus Cancel; what the Send button does up to handing the submission over.
- `review/selecting-and-capturing.md`: annotation mode (preparing, selecting), the element capture and its target, Draw on page's page capture, Remove target and Change element, capture fidelity.
- `review/drawing-on-screenshots.md`: the freehand overlay (Draw on screenshot) and the structured editor (pen, arrow, text, undo, Apply, Cancel).
- `review/attachments-mentions-and-copy-requests.md`: the attachment chooser and its limits, mention suggestions and the Mention reviewers list, the copy request field.
- `review/sending-and-drafts.md`: a ticket submission from Send to saved or failed; Retry submission; what a failed submission blocks; draft saving, restoring, and the storage notice.
- `review/presence-and-following.md`: the presence roster, cursors, colors, following and stopping.
- `review/review-settings-and-links.md`: Settings (dock, launch, motion, copy requests), clean review links and Show review UI, Watch artifact.

## Leads for the remaining documents (read from code during reconnaissance; verify before stating)

These are starting points, not established facts. Each was read once; confirm it in the code named before writing it down, and put anything you cannot confirm in "Open questions".

- `preparing/the-prepare-page.md` (`src/platform/publish-page.tsx`, `DashboardRuntimeScript` in `src/render.ts`: the `projectForm` handlers, `publishShiplet` in `src/index.ts`): the address is filled from the name until the address field is edited; files are read into the page as base64 before sending; dropped folders are not expanded; server errors are shown verbatim ("This URL is already taken. Please choose a different name."); success lands on `/shiplets/{id}?created=1`; "Agent or CI" can never submit; the Workspace select is hidden with one organization; addresses that equal app route names are accepted.
- `preparing/how-artifacts-are-shown.md` (`src/asset-preview.ts`, `src/static-asset-types.ts`, `createStandaloneAssetPreviewIndex`, `src/external-url-proxy.ts`, `docs/publishing.mdx`): without an HTML entry a file review page is generated; standalone previews allow downloads; URL artifacts are fetched read-only (GET and HEAD, no private addresses, text up to 64 MiB); non-HTML paths open without the review layer.
- `shiplets/the-shiplets-list.md` (`src/platform/shiplets-app.tsx`, and `renderProjects` in `src/render.ts` for the Access page's compact table): Archive and Restore are shown on every row and allowed for any organization member; dates are UTC; Copy URL and View live use the review link's address.
- `shiplets/the-shiplet-page.md` (`BuildShipletReviewPage` and `DashboardRuntimeScript` in `src/render.ts`): Open review page and Open URL both open the dashboard preview; the page's own "New comment" form records the ticket against the Shiplet page's address (`/shiplets/{id}`), not a page of the artifact; the comment list loads up to 250 tickets including closed ones, never polls, and is not refreshed by tickets sent from the embedded preview; a status change or follow-up error replaces the whole list with an error banner; follow-ups show no author.
- `shiplets/archive-restore-and-delete.md` (`/api/projects/:id/archive`, `restore`, `DELETE /api/projects/:id`, `archivedShipletPageResponse`, `BuildArchivedShipletPage`): see the archive and restore rules under "Things already established"; permanent delete requires typing the address ("Type the shiplet subdomain to confirm deletion."); POSTs to an archived review link get 410.
- `access/your-account.md` (`/auth/*` routes, `src/auth.ts`, `ProfileSection` and `AccountSection` in `src/platform/settings-page.tsx`, avatar handlers in `DashboardRuntimeScript`): avatar uploads are PNG, JPEG, or WebP up to 10 MB, cropped with drag and a 1 to 3 zoom; Add account appears only with account switching on; sign-out lands on `/`.
- `access/the-access-gate.md` (`/shiplets/:id/access`, `/shiplets/:id/access-requests`, `BuildShipletAccessRequestPage`, `invitationConsentPageResponse`): one request per person and Shiplet; the owner is emailed a link to the Shiplet page and has no in-app approval (granting is the invite reviewers form); an invitee who opens a Private review link directly lands here rather than on the invitation.
- `access/the-workspace-page.md` (`WorkspaceSection`, `TeamsSection`, and the organization, team, and invitation handlers): any member can invite members and invite to teams; only administrators can create teams or invite administrators; the active organization is not remembered between loads.
- `access/invite-links.md` (`src/platform/invite-links-app.tsx`, `src/organization-invite-links.ts`, `/join/:token`, `e2e/invite-links.spec.ts`).
- `review/pins.md`: choosing an item in the Page comments menu while the comments panel is closed activates the thread in the hidden panel, so nothing visible happens; Escape in the pin stack and Page comments menus also climbs the Escape ladder; `e2e/review-navigation-draft-pins.spec.ts` expects New comment to start element selection directly, which the code does not do (it opens the creation menu).
- `review/drawing-on-screenshots.md` (`openAnnotationEditor` in the host script; `src/review-annotation-editor.ts`): the freehand overlay draws fixed 5 px #d92d5b strokes in page coordinates and burns them in on Done drawing; the structured editor opens only for Draw on page; Apply leaves the editor open; Escape inside the structured editor also reaches the composer's Escape ladder and can discard the whole draft.
- `review/attachments-mentions-and-copy-requests.md` (`src/review-attachment-drafts.ts`, `searchMentions` and `chooseMention`, the copy request field): attachments are neither restored after reload nor cleared by Cancel; the Mention reviewers list shows names with email addresses; reply mentions use the list only.
- `review/presence-and-following.md` (`src/review-presence.ts`, presence functions in the host script, follow handling in the bridge): the roster includes the reviewer ("(you)"); cursors are drawn only for people on the same path; following stops on Escape, the follower's wheel, touch, pointer press, or scrolling keys inside the artifact, or the followed person leaving.
- `review/review-settings-and-links.md`: preferences are stored per person and Shiplet; clean links strip credential-like query parameters and add `shiplet_review=hidden` or `shiplet_comments=hidden`; a clean link's address is a different page address for drafts.
- `feedback/the-feedback-view.md` (`src/platform/feedback-app.tsx`, `feedback-state.ts`, `listAccessibleReviewFeedback` in `src/review.ts`): filters apply only on Filter and are pushed to the URL; back and forward reapply them; archived Shiplets are left out; an unknown `status` in the URL shows everything; `projectId` has no control; the ID link goes to the Shiplet page.
- `feedback/the-inbox.md` (`src/platform/inbox-app.tsx`, `src/notifications.ts`): the Inbox has no way to mark a notification read (the API exists), so every notification stays Unread and keeps counting in the badge.
- `cross-cutting/notifications-and-watching.md` (`src/notifications.ts`): watchers are notified whether or not they can still view the Shiplet; email goes out only when the installation configures it.
- `cross-cutting/custom-review-widgets.md` (`docs/extensions.mdx`, widget functions in the host script, `e2e/trusted-review-host.spec.ts` widget tests): a widget's requests go through a confirmation section and then a secure confirmation tab, unlike the built-in composer; the widget shows "Custom review widget could not load." with Retry widget after 8 s without a handshake.

## Order of work

1. `foundations/` first, in this order: `page-lifecycle.md`, `shiplets-and-tickets.md`, `access-and-roles.md`, `navigation-and-urls.md`, `the-review-link.md`. Everything else links to them.
2. `review/` next. This is the hardest part and the bulk of the experience. Read the whole of `trustedReviewHostScript` and the bridge before starting any of them, because the states hand off to each other and the documents must agree on where one ends and the next begins. Which document owns which state is recorded under "Things already established" once decided.
3. The remaining documents: `preparing/`, `shiplets/`, `access/`, `feedback/`, `cross-cutting/`. These are independent of each other and can be drafted in parallel with subagents once the foundations and the review documents that own the state handoffs exist to link to. If you parallelize, give each subagent this file, the four exemplars, and the specific documents to write; then review every result yourself for consistency with the glossary and the established facts above before accepting it.
4. Consistency pass over the whole set: same term for the same thing everywhere, no two documents describing the same behavior differently, every relative link resolves (`python3 /root/.claude/skills/product-description/references/check-links.py /home/user/shiplet-core/product-description`), every document has a verification footer, every glossary term used is defined.
5. Update the coverage table in `README.md` as you go: `drafted` when written, never `verified` (verification by hand is a separate pass).

## Working rules

- Commit after each document or coherent group of documents with a message of the form `docs: add {path}` or `docs: revise {path}`. Stage only paths under `product-description/`, and run every git command from `/home/user/shiplet-core`. End every commit message with these two trailer lines, after a blank line:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RvKATuyEexQVifnHmBk32K
  ```

  Do not push, open pull requests, or file issues.
- Do not modify anything outside `product-description/`. It is read-only reference material.
- Do not add files outside the README's structure without updating the structure and coverage table to match.
- When a behavior cannot be determined from code and tests, write down what you could determine, put the rest in "Open questions", and move on. Do not guess and do not block.
- Depth bar: `shiplets/the-invite-reviewers-form.md` is roughly 200 lines for a small form. The `review/` documents will be longer (250 to 300 lines); settings-like pages will often be shorter. Completeness matters more than length. Every state, every modifier row, every cancel/interrupt row must be accounted for, even if the answer is "No effect".
- If you find that the README's structure is wrong for something you discover (a document that should be split, two that should merge), make the change, update the structure and coverage table, and note why in the commit message.

You are done when the coverage table has no `not started` rows, the consistency pass is complete, and everything is committed.
