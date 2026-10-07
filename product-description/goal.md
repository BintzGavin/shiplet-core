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

(Filled in as the foundations are written.)

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
