# Glossary

The vocabulary used across these documents. When a document uses one of these words, it means exactly this. Where Shiplet's own interface uses a word, the definition says so and these documents use it too; where the interface uses two words for one thing, the definition names the one these documents use.

## The product

**Shiplet app.** The signed-in web application at the app's own address (`https://shiplet.cc/` in production, `http://localhost:8787/` locally): the Prepare page, the Shiplets list, the Shiplet page, the Feedback view, the Inbox, and the settings pages. It is distinct from a *review link*, which is served on the Shiplet's own address.

**Platform navigation.** The row of links under the header on the Prepare page, the Shiplets list, the Feedback view, the Inbox, and the settings pages: Prepare, Shiplets, Feedback, Inbox, Workspace. Feedback and Inbox carry a *nav badge*. The Shiplet page, the access request page, and the review link have no platform navigation.

**Prepare page.** The page at `/` for a signed-in person, headed "Create a shiplet". It is where a Shiplet is created from the browser. Signed out, `/` shows a sign-in card instead.

**Shiplet page.** The page at `/shiplets/{id}` for one Shiplet, headed "Review bridge" (or "Shiplet ready" just after creation, or "Archived shiplet"). It embeds the *dashboard preview*, lists the Shiplet's tickets, and holds the invite reviewers form, the lifecycle controls, and the agent handoff panel.

**Feedback view.** The page at `/feedback`, headed "All feedback": every ticket on every active Shiplet the person can view, newest first.

**Inbox.** The page at `/inbox`, headed "Notifications": the person's *notifications*, newest first.

**Settings pages.** Four pages that share a local navigation (Overview, Account, Access, Agents): `/workspace` (labeled Overview in that navigation and Workspace in the platform navigation), `/account`, `/access`, and `/agents`. `/settings` redirects to `/workspace`.

## Shiplets and artifacts

**Organization.** A group of people that owns Shiplets, teams, invite links, and API keys. The interface calls it a workspace in several places (the Workspace link, the Workspace select on the Prepare page, the "Workspace" visibility badge) and an organization in others (Organizations, Active organization, Create organization). These documents say organization. A person's first publish creates one for them named "{email prefix}'s Workspace" when they belong to none, and makes them its administrator.

**Shiplet.** One reviewable thing: an *artifact*, its *review link*, its access settings, and its tickets. The interface writes it in lowercase ("Create a shiplet", "All shiplets"); these documents capitalize it. In the code it is a project.

**Artifact.** The work under review: uploaded files (a build output, a static export, or standalone files) or a public URL. Shiplet never edits it. It is shown only inside the *artifact frame*.

**Revision.** One version of a Shiplet's artifact. A Shiplet created in the browser has one revision; agents and CI can publish more through the API. The *active revision* is the one the review link serves. Every ticket records the revision it was written against (older tickets may have none), which is what *provenance* reports.

**Address.** The lowercase, hyphenated name chosen on the Prepare page ("Shiplet address"), 1 to 63 letters or digits with single hyphens between them, unique across the whole installation. It becomes the review link. The code calls it the subdomain.

**Review link.** The Shiplet's public address: `https://{address}.shiplet.cc/` in production, or `{app}/{address}/` when the installation has no custom domain (as in local development). Opening it shows the *trusted host* with the artifact inside. Every path under it (`/{address}/about.html`) is the same Shiplet, reviewed at that page.

**Dashboard preview.** The copy of the review link that the Shiplet page embeds in an iframe and that its "Open review page" button opens (`/shiplets/{id}/review-host`). It runs the same review layer as the review link.

**Visibility.** Who can open a Shiplet without a grant: **Private** (administrators, the owner, and grant holders only), **Organization** (every member of its organization; the default), **Unlisted** (anyone with the link, signed in or not), **Public** (anyone, and intended for discovery). The Shiplets list shows Organization as "Workspace". Visibility never grants editing.

**Archived.** A Shiplet that has been archived: it leaves the active lists, its review link shows an archived page instead of the artifact, and nobody can leave feedback on it. It keeps its tickets and access settings for a 30-day restore window, after which it is scheduled for deletion. The opposite is active.

**Review layer.** Everything Shiplet draws around the artifact on a review link: the launcher dock, the comments panel, pins, the composer, presence, and (when an agent attached one) a *custom review widget*.

**Custom review widget.** Review controls an agent attached to a Shiplet. It runs in its own sandboxed frame inside the comments panel and can only ask for actions, which the reviewer confirms. None is attached by default.

## Tickets

**Ticket.** One saved piece of feedback on a Shiplet: a comment, a status, a *ticket label*, who wrote it and when, the page it was written on, optionally a *target* and a *capture*, and its replies and mentions. The review layer calls tickets "comments" ("Comments", "New comment", "3 comments"); the Feedback view calls them "feedback". These documents say ticket for the record and comment for its text.

**Ticket label.** The ticket's name inside its Shiplet: `PF-1`, `PF-2`, and so on, numbered in order of creation and never reused. The number alone appears on its *pin*.

**Status.** Where a ticket is in its lifecycle. Exactly six values, in this order everywhere: New, In Progress, Blocked, Staging, Done, Dropped. A new ticket is New.

**Open and closed.** A ticket is closed when its status is Done or Dropped, and open otherwise. Resolve sets Done; Reopen sets New.

**Page comment.** A ticket with no target: it is about the page as a whole. It has no pin; it is reached through the comments panel and the *Page comments menu*.

**Target.** The element of the artifact a ticket points at, recorded as a CSS selector, the element's tag, and up to 500 characters of its visible text. A ticket with a target has a pin that follows that element.

**Capture.** What the review layer records about the artifact when a ticket is started on it: the viewport size and pixel ratio, the scroll offset, the point clicked, the target (for an element capture), and usually a screenshot. An element capture comes from choosing an element; a page capture comes from Draw on page and has no target.

**Capture fidelity.** How faithful a capture's screenshot is, shown under the comment field: captured from the selected image, reconstructed from the visible page (images, canvas, media, form values, and external styles may be missing), an approximate fallback, or no image.

**Reply.** A follow-up comment on a ticket, with its own author and time. Replies cannot be edited or deleted.

**Mention.** A person named on a ticket or reply so that they are notified. Only members of the Shiplet's organization can be mentioned. Mentioning a member who cannot yet view the Shiplet gives them a reviewer grant on it.

**Provenance.** The line on a thread that says which revision a ticket belongs to: "Current revision", "Earlier revision", or "Earlier feedback" when the ticket predates revision tracking.

**Watching.** Being subscribed to a Shiplet's future review activity. The Shiplet's owner watches it by default; anyone who can view it can turn watching on or off ("Watch artifact" / "Watching").

**Notification.** An Inbox entry for one person about one event: they were mentioned, or a Shiplet they watch got a new ticket, a reply, or a status change. Notifications have a read or unread state; the event's author is never notified of their own action.

## People and access

**Organization administrator.** A member of an organization with the admin (or owner) role. Administrators can view and edit every Shiplet in the organization, manage invite links and API keys, and invite administrators.

**Member.** A person who belongs to an organization without the administrator role. A member can view every Organization-visibility Shiplet in it and create Shiplets of their own.

**Owner.** The person who created a Shiplet. The owner can view and edit it, is the only one who can permanently delete it, and watches it by default.

**Grant.** Access to one Shiplet given to a person (by user or email), a team, or the whole organization, with a role. A grant always gives viewing; only the owner and editor roles give editing.

**Grant role.** The role on a grant: viewer, reviewer, editor, or owner. Viewer and reviewer give the same authority (view, comment, reply, and change status); editor and owner add editing (invite, archive, restore). The invite reviewers form offers Reviewer, Viewer, and Owner.

**Editing.** Changing a Shiplet's access or lifecycle: inviting, archiving, restoring. Commenting, replying, and changing a ticket's status are not editing; anyone who can view can do them.

**Invitation.** An email, sent through WorkOS, asking someone to join an organization, a team, or one Shiplet. It takes effect only for the signed-in identity with exactly that email address.

**Invite link.** One shareable URL that lets anyone who opens it, signs in, and accepts join an organization or one team in it as a member, subject to a use limit, an expiry, and an optional list of reserved emails.

**Access request.** A signed-in person's request to view a Shiplet they cannot open, recorded once per person and Shiplet and emailed to the Shiplet's owner.

**Access gate.** What a review link or Shiplet page does when the person cannot view it: a sign-in redirect when signed out, and the access request page when signed in.

## The review link

**Trusted host.** The page Shiplet serves at a review link. It owns the person's identity and every review action; the artifact and any custom widget run inside it in sandboxed frames and never see the session.

**Artifact frame.** The sandboxed iframe that fills the trusted host and shows the artifact. Scripts in the artifact run, but cannot reach Shiplet's session or APIs.

**Artifact connection.** The private channel between the trusted host and a small Shiplet script inside the artifact frame. Element selection, captures, pins that follow their targets, the C and Escape shortcuts pressed inside the artifact, following, and route changes all need it. The host renews it every second and treats it as disconnected after 3 seconds without an answer.

**Review identity.** The trusted host's check, on arrival and again on focus, before sending, and after a route change, of who the reviewer is, for which Shiplet, revision, and page. Drafts and review preferences are stored under it, so a different person or page never sees them.

**Launcher dock.** The bordered group at a corner of the review link (bottom right by default) holding **Annotate** (starts a new ticket on an element) and **Comments** (opens the comments panel, with the ticket count).

**Comments panel.** The panel that lists tickets for the current scope, with filters, pagination, an options menu (•••), and a Close button.

**Thread.** A ticket shown in full: its comment, replies, reply field, Resolve or Reopen, the Status picker, provenance, and Open feedback. A thread is shown either in the comments panel (the list presentation) or in a card beside its pin (the contextual presentation). At most one thread is active at a time.

**Pin.** The numbered marker drawn over the artifact at a ticket's target or captured point, on the page the ticket was written on. Clicking it opens that ticket's thread beside it.

**Pin stack.** One marker standing for two or more pins within 36 px of each other, labeled with their count. Clicking it opens a menu of the tickets it holds.

**Page comments menu.** The "Page comments (n)" button and menu that list the current page's tickets that have no target and no captured point, so they can still be opened from the artifact.

**Composer.** The card where a new ticket is written: a comment field, the target line, capture fidelity, attachments, Details, Cancel, and Send. It is compact (comment and actions) or expanded (Details open, with element details, the drag handle, and drawing tools). The interface calls it the annotation card; its heading is "New annotation".

**Annotation mode.** The state between pressing Annotate (or C) and choosing an element: the artifact highlights the element under the pointer, a bar reads "Annotating · {path}" with a Cancel button, and pins are hidden.

**Creation menu.** The three choices the panel's "+" (New comment) button offers: Page comment, Draw on page, Select an element.

**Scope.** Which tickets the comments panel lists: a page scope (Current page, Path prefix, or All authorized pages), a state (Open, Closed, or Open and closed), people (Everyone, Mine, Mentions of me), and a revision (All revisions or Current revision). The default is Current page, Open, Everyone, All revisions.

**Presence.** The live list of people with the Shiplet's review link open, shown as avatars at the top left, with their cursors drawn over the artifact when they are on the same page. Each live reviewer gets one of eight signal-flag colors.

**Following.** Mirroring another live reviewer's scroll position. It starts from their avatar and stops with Stop following, Escape, or the follower's own scrolling.

## State words

**Saved.** Stored on Shiplet's server, so that anyone who can view the Shiplet sees it after a refresh. A ticket is saved when the server answers Send with the ticket; a grant is saved when the share request succeeds. Nothing is saved by typing.

**Draft.** Unsent work in the review layer: the composer's comment, mentions, target, capture, drawing, attachments, and copy request, and the text and mentions typed into any reply field. Drafts are kept in the browser (IndexedDB) under the review identity and survive a reload; they never reach the server until sent.

**Dirty.** A form or draft with at least one change since it was opened or last sent. Platform forms (everything outside the review link) track no dirty state and never warn before leaving; the review layer keeps dirty drafts in the browser instead.

**Pending.** Sent and not yet answered. While a ticket or reply is pending, its Send button is disabled and the same work cannot be sent twice.

**Failed.** Sent and not confirmed saved. A failed ticket keeps its draft and offers "Retry submission", which resends exactly the same request so it cannot create a second ticket.

**Stale.** Showing data that could not be refreshed. The review layer keeps the last tickets it loaded and says so in a notice with a Refresh (or Retry) button, instead of emptying the list.

**Active.** Of a thread: the one thread currently expanded, in the panel or beside its pin. Of a Shiplet: not archived. Of a revision: the one the review link serves.

**Selected.** Of an element in annotation mode: the element the pointer is over, outlined in teal; clicking it makes it the target. Platform pages also have selected rows (Shiplets list checkboxes), which is a different thing and is always written "checked".

## The interaction

**Form lifecycle.** The unit of interaction every document narrates: a page, panel, or form from the moment it opens to the moment its work is sent or abandoned. Its five phases are *arrive*, *leave untouched*, *begin editing*, *while editing*, and *submit*.

**Arrive.** The phase in which the page, panel, or form opens: the route or control that opens it, what loads, what is focused, and what is prefilled.

**Leave untouched.** The phase in which the person closes or leaves before changing anything. Whether anything is recorded is stated even when the answer is nothing.

**Begin editing.** The first change: what becomes dirty, what is saved locally, what validation runs, and what buttons enable.

**While editing.** Everything between the first change and submit: typing, choosing, pointer work on the artifact, local draft saving, polling, and what other people's changes do meanwhile.

**Submit.** Sending the work: what is sent, what is disabled meanwhile, the success and failure paths, and where the person lands.

**Polling.** Asking the server again on a timer. The review layer asks for its tickets every 5 seconds while its tab is visible. The Prepare page, the Shiplets list, the Feedback view, the Inbox, and the settings pages ask for notifications and feedback every 15 seconds and when the window regains focus or the tab becomes visible. Invite links are asked for again only when the window regains focus. The Shiplet page does not poll.

## Input

**C shortcut.** Pressing C (without Ctrl, Cmd, Alt, or Shift) on a review link, when no text field has focus, starts a new ticket on an element, the same as Annotate. It works whether focus is in the trusted host or inside the artifact.

**Escape ladder.** On a review link, Escape closes the innermost open thing and stops: an open contextual thread first, then a drawing in progress, then the expanded composer (back to compact), then the composer or annotation mode itself (discarding the draft), then the comments panel. While following another reviewer, Escape also stops following.

**Ctrl/Cmd+Enter.** Sends from the composer's comment field or a reply field. Plain Enter adds a new line in both.

**Input method composition.** Typing through an IME (for example for Japanese or Chinese). While a composition is in progress, Enter, Ctrl/Cmd+Enter, and Escape belong to the IME and do nothing in Shiplet.

## Events that end or interrupt

**Cancel.** Ending a piece of work on purpose with Escape or a Cancel button. In the review layer, Cancel discards the composer's draft (text, target, capture, drawing); in platform forms, there is no Cancel and nothing to discard.

**Close.** Hiding a panel, card, or menu without discarding anything in it. Closing the comments panel or a contextual thread keeps reply drafts; closing the expanded composer returns it to compact.

**Discard.** Removing unsent work from the screen and from browser storage. Only Cancel (and a successful send of that same work) discards a draft.

**Retained.** Kept after an interrupt. A retained draft reappears when the person comes back to the same Shiplet, revision, and page as the same person.

**Leaving.** Going to another page of the Shiplet app or another site by following a link in the same tab. Platform pages lose anything typed; the review layer saves its drafts to the browser first.

**Session expires.** The sign-in session ends or the person's access is revoked while a page is open. The next request is refused; the page says so and keeps what is on screen. The next full page load goes to sign-in or the access gate.

**Route change.** The artifact moving to another page inside the artifact frame (a link, a script, or the browser's back inside it). The review layer saves the current page's drafts, switches its page binding, and reloads the list for the new page.

## Interface

**Banner.** A full-width colored message box on platform pages (info, success, warning, error). The Prepare, Shiplet, and settings pages have a top banner that starts as "Loading workspace..." and reports the last action; forms also have their own result banner beneath them.

**Status line.** The one-line message at the top of the comments panel ("Loading comments…", "3 comments.", "No comments yet in this scope. Reset filters or add a comment.", errors). It is read out to screen readers; errors are announced as alerts.

**Live status.** The small "Live. Updated {time}." line on the Feedback view and the Inbox, which becomes an error message when a refresh fails.

**Nav badge.** The count on the Feedback and Inbox links in the platform navigation: for Inbox, the number of unread notifications; for Feedback, the number of tickets returned for an unfiltered Feedback view (all statuses, at most 100). Hidden at zero.

**Stale notice.** The review layer's notice, outside the panel, that its list could not be refreshed, with a Refresh (or Retry) button. See *stale*.

**Storage notice.** The review layer's notice that drafts or preferences cannot be stored in the browser ("Persistence is unavailable; a full reload can lose unsaved work."), with a Retry storage button.

## Units and time

**Pixels.** Distances are CSS pixels of the browser viewport unless a document says page coordinates (measured from the top of the artifact's document, so they include its scroll offset).

**Sizes.** File and payload sizes are in MiB (1,048,576 bytes). Text lengths are in characters.

**Times.** The review layer shows times in the browser's locale and time zone. The Shiplets list, the Feedback view, and the Inbox show dates in UTC, formatted in US English. The live status time is in UTC on the Inbox and in the browser's time zone on the Feedback view.
