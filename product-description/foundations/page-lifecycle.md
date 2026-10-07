# The page lifecycle

## Summary

Every page, panel, and form in Shiplet goes through the same five phases, and every one of them can be interrupted by the same twelve events. This document defines both once, for the whole product, so that feature documents can say "the request fails" or "the tab is hidden" and mean exactly the same thing. It also owns where unsent work lives, every polling interval, how results and errors are shown, and what each value of the variant axis means. There are two families of page with different rules: the **platform pages** (the Prepare page, the Shiplets list, the Shiplet page, the Feedback view, the Inbox, the settings pages, the access request page), which keep nothing the person has not submitted, and the **review layer** on a review link or the dashboard preview, which keeps every draft in the browser and checks the reviewer's identity again and again. The review layer's own machinery (the artifact connection, review identity, the Escape ladder, route changes) is defined in [the review link](the-review-link.md).

## The five phases

A feature document narrates its interaction in these five phases, in this order, with these headings.

**Arrive.** The page loads or the panel, card, or form opens. On a platform page this is a full page load: the server checks the session (signed out, it redirects to sign-in and comes back afterwards; see [navigation and URLs](navigation-and-urls.md)), renders the page with the data it already has, and a script then asks for the rest. The Prepare page, the Shiplet page, and the Workspace and Access settings pages show "Loading workspace..." in a banner until that second load finishes. In the review layer, arriving is opening a control: the comments panel, a thread, the composer.

**Leave untouched.** The person goes away before changing anything. On a platform page nothing is recorded, ever. In the review layer, closing something leaves any existing drafts in place and records nothing new.

**Begin editing.** The first change. Platform forms do not track it: no button enables, nothing is saved, no warning is armed. In the review layer the first change makes a draft, which is written to the browser's storage within about 150 ms.

**While editing.** Typing, choosing, and pointer work. Platform forms validate nothing until submit, apart from what the browser itself checks on submit (an email field's format, a URL field's format, a required field). The review layer keeps saving the draft, keeps polling, and keeps the composer anchored to its target as the artifact scrolls.

**Submit.** The work is sent. Platform forms send one request and wait; most do not disable their button, so a second click sends a second request. The review layer disables the form while a ticket is pending and can only ever create one ticket per Send, even across a failure and a retry (see `review/sending-and-drafts.md`).

## Saved, unsaved, and where unsent work lives

Nothing in Shiplet is saved by typing. Work is saved when the server answers the request that sent it. Before that, it lives in one of three places.

| Unsent work | Where it lives until submit | Survives a reload |
| --- | --- | --- |
| Any platform form (Prepare, invite reviewers, Workspace forms, the Shiplet page's comment and follow-up fields, an avatar choice not yet saved) | The page only | No |
| The Feedback view's filters | The page until Filter; then the URL | Yes, once applied |
| The Shiplets list search | The page only | No |
| The composer's comment, mentions, target, capture, screenshot, and drawing; the copy request text; every reply field's text and mentions | The browser (IndexedDB), under the review identity and page | Yes, for the same person on the same Shiplet, revision, and page |
| The composer's attachments | The page only | No |
| The comments panel's filters | The browser (local storage), per Shiplet | Yes |
| Review preferences (dock, launch, motion, copy requests) | The browser (local storage), per person and Shiplet | Yes |
| The theme choice | The browser (local storage) | Yes |

The browser storage is per browser profile. A private window starts empty and loses everything when closed, and when the browser refuses storage the review layer says so in its storage notice and keeps working from memory.

No page in Shiplet warns before leaving. Platform pages have nothing to protect; the review layer saves its drafts first instead of asking.

> Technical note: a request that has already left the browser is not stopped by leaving, reloading, or closing the tab. The server finishes it. This is why a platform form whose result was never seen may still have taken effect.

## What each interrupt means

These are the twelve rows of every document's Cancel and interrupt table, in order. Each feature document says what the event does to that feature; this table says what the event is and what it does everywhere.

| Event | On platform pages | In the review layer |
| --- | --- | --- |
| Escape or Cancel | Escape is not handled, except that it closes the screenshot viewer on the Shiplet page and backs out of revoking an invite link. Platform forms have no Cancel button. Browser confirmation dialogs (bulk archive) treat Escape as their own Cancel. | Escape closes the innermost open thing (the Escape ladder in [the review link](the-review-link.md#keyboard)). Cancel in the composer or in annotation mode discards the draft. |
| Leaving by a link inside Shiplet | The page is replaced and everything typed is gone. A request already sent completes on the server. | Leaving the review link is leaving the page: drafts are saved to the browser first and come back on return. |
| Browser back or forward | As leaving. The settings pages are marked never to be cached and always load fresh; other pages may come back from the browser's back-forward cache as they were left. The Feedback view reapplies the filters in the URL it returns to. | As leaving, for the top-level page. Back or forward inside the artifact frame is a route change instead (last row). |
| Reload, or the tab or window is closed | Everything not submitted is gone; state in the URL (Feedback filters, `?created=1`) is reapplied on reload. | Drafts are restored on reload, but the composer is not reopened: it reopens with the draft the next time the reviewer starts a ticket. A ticket that was pending at the moment of reload comes back as failed, with a Retry that cannot create a duplicate. |
| The window loses focus or the tab is hidden | Polling pauses while the tab is hidden and runs at once when it is visible or focused again. Forms are untouched. | Drafts are saved at once when the tab is hidden. Polling pauses while hidden. Regaining focus or visibility re-checks the review identity and restarts the artifact connection. |
| Network lost | The next request fails and the banner shows the browser's own error text ("Failed to fetch" in Chrome, "NetworkError when attempting to fetch resource." in Firefox, "Load failed" in Safari). Polling pages put that text in their live status. Nothing retries by itself. | The list keeps what it has and a stale notice says "You’re offline. Showing saved comments and drafts."; a send fails and keeps its draft. When the browser reports the connection is back, the list refreshes by itself. Presence reconnects with growing delays. |
| Request fails | The server's text is shown verbatim (see [How results and errors read](#how-results-and-errors-read)). Values typed are kept. | Each failure has a plain message ("Feedback could not be saved. Retry the same submission.", "Could not reply to PF-3. Try again."), drafts are kept, and the list keeps showing the last tickets it loaded. |
| Session expires or access is revoked | The next request fails with "Authentication required" (signed out) or a permission message, and the page stays where it is. The next full page load redirects to sign-in and returns to the same page afterwards. Sessions last 14 days from sign-in. | The next request is refused; the layer re-checks the review identity, keeps every draft private to the old identity, and says "Review access changed. Your draft is retained." or "Review identity is unavailable. Use Refresh after access is restored." |
| The same record changed in another tab | Nothing detects it. The last request to arrive wins. Pages that poll show the other tab's change within 15 seconds; the Shiplet page shows it only after Refresh or reload. | The two tabs share one saved draft per page: whichever saved last is what a reload restores. Tickets created or changed in the other tab appear within 5 seconds. |
| The same record changed by another person | As in another tab. Nothing is locked and nothing warns. | Their tickets, replies, and status changes appear within 5 seconds; their presence and cursor appear at once. A status change the reviewer has in flight is not overwritten by the poll. |
| Autofill, a password manager, or an input method (IME) writes into a field | No special handling. Autofill fills fields without submitting; an IME composition's Enter does not submit a form. | Enter, Ctrl/Cmd+Enter, Escape, and C are ignored while an IME composition is in progress, so finishing a composition never sends, cancels, or starts a ticket. |
| The artifact navigates to another page (review link only) | Not applicable: platform pages have no artifact. | A route change: drafts for the old page are saved, the review switches to the new page, and its list and pins reload ([route changes](the-review-link.md#routes-inside-the-artifact)). |

"Before editing" and "While editing or submitting", the two columns of every feature's table, are the phases either side of Begin editing. A request in flight belongs to the second column.

## Live updates and polling

| What refreshes | On which pages | How often | Also |
| --- | --- | --- | --- |
| The Inbox and Feedback navigation badges, and the Feedback and Inbox lists | Prepare, Shiplets list, Feedback view, Inbox, settings pages | Every 15 seconds, the first time 1.5 seconds after load | At once when the window regains focus or the tab becomes visible. Skipped while the tab is hidden. |
| The Shiplets list's data | Shiplets list | Not on a timer | When the window regains focus, if more than 30 seconds old, and after each archive or restore |
| Invite links | Workspace page | Not on a timer | When the window regains focus, if more than 30 seconds old |
| The Shiplet page's comment list | Shiplet page | Never by itself | After each change made on that page, and on Refresh |
| The review layer's ticket list | Review link and dashboard preview | Every 5 seconds while the tab is visible | When the browser comes back online. A poll merges new tickets into what is shown and never discards a loaded page of results. |
| Presence | Review link and dashboard preview | Live (a socket) | Reconnects after 1, 2, 4, 8, 16, then every 30 seconds |

## How results and errors read

**Banners.** Platform pages report the last action in a top banner (the one that starts as "Loading workspace...") and, for forms, in a result banner under the form. A success replaces the previous message; a failure replaces it in red. Banners are not announced to screen readers.

**Server text, verbatim.** Platform forms show the server's answer as it came: a sentence ("This URL is already taken. Please choose a different name."), a terse rule ("role must be viewer, reviewer, or editor"), or, when the server answered in JSON, the raw JSON text. Nothing is translated into friendlier words, and no field is highlighted.

**The review layer translates.** The review layer never shows raw server text. It has a fixed set of messages for each outcome, placed where the reviewer is working: in the composer under the comment field, in a thread under its reply field, in the panel's status line, or in the stale notice.

**Live status.** The Feedback view and the Inbox show "Live. Updated {time}." after each refresh and the error text when a refresh fails; the list keeps its last contents.

**Nav badges** never show errors; a failed refresh leaves the last count.

## What the variant rows mean

Every feature's Modifiers table has these five rows, with these meanings.

**Role.** The signed-in person's authority over the Shiplet or organization involved, as defined in [access and roles](access-and-roles.md): an organization administrator; the Shiplet's owner; an editor (an editor or owner grant); or someone who can only view (a member, or a viewer or reviewer grant holder). Authority is checked by the server on every request, never latched when the page loaded.

**Shiplet state.** Its visibility (Private, Organization, Unlisted, Public) and whether it is active or archived ([Shiplets and tickets](shiplets-and-tickets.md)).

**Flags and preferences.** Feature flags are set per installation, not per person, and all are off by default; the only one that reaches this surface is account email switching, which adds Switch accounts and Add account to sign-in. Preferences are the review preferences (dock, launch, motion, copy requests; all default as described in `review/review-settings-and-links.md`), the panel's filters, and the theme (follows the system until the person picks one with the header switch).

**Keyboard.** Enter (submits a platform form from a text field; adds a line in the review layer's text areas), Ctrl/Cmd+Enter (sends from the composer or a reply), Escape, Tab, and the C shortcut on a review link.

**Narrow screen.** A viewport 640 px wide or less. Platform pages turn every multi-column grid into one column (the Shiplet page already stacks its two columns at 900 px or less). The review layer closes its comments panel by itself after a ticket is sent, and at 480 px or less it widens the panel to the screen and grows the composer's buttons to 44 px.

## Edge cases

- **A double submit is two requests** on every platform form that does not disable its button. The review layer's ticket and reply forms are the exceptions that make it impossible.
- **A request in flight finishes after the page is gone.** Leaving, reloading, or closing never cancels a request that has left the browser.
- **Errors in JSON** appear as raw JSON text in a platform banner, for example `{"ok":false,"errors":["Comment is required."]}`.
- **Hidden tabs fall behind.** A tab hidden for an hour shows hour-old data until it is shown again, then catches up in one refresh.
- **Two browsers are two people for drafts.** Drafts and preferences live in one browser profile; the same person in another browser starts empty.

## Open questions and verification

- The browser error texts for a lost network are the browsers' own and vary by version; the three quoted were not checked by hand.
- Back-forward cache behavior on the pages that are not marked no-store (the Prepare page, the Shiplet page, the Shiplets list, the Feedback view, the Inbox) was not tested.
- The 150 ms draft save delay and the immediate save on hide were read from code; how much typing a crash can lose was not measured.
- Whether any banner should be a live region for screen readers is a product question; none is today.

Verified against shiplet-core commit `3327af4`
