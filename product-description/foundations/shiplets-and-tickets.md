# Shiplets and tickets

## Summary

This is the data model as a person meets it: what an organization, a Shiplet, an artifact, a revision, and a ticket are, what each holds, what can change after it is created, and what is shared with other people. Other documents link here instead of restating it. Who can see and change each thing is in [access and roles](access-and-roles.md); how each is reached by URL is in [navigation and URLs](navigation-and-urls.md).

## Organizations

An organization owns Shiplets, teams, invite links, and API keys, and has members with a role (administrator or member). A person can belong to several; the Prepare page and the settings pages work on one at a time (the Workspace select, the Active organization select). A person with no organization gets one on their first publish, named "{the part of their email before @}'s Workspace", with themselves as its administrator. Organizations are also created by hand on the Workspace page; they cannot be renamed or deleted in the web app.

## Shiplets

A Shiplet is created on the Prepare page (or by an agent through the API) and holds:

- a **name** (free text, shown in lists and as the review link's page title);
- an **address**, the lowercase name that becomes its review link: 1 to 63 letters or digits with single hyphens between them, unique across the whole installation, never reused while the Shiplet exists;
- a **visibility**: Private, Organization (the default), Unlisted, or Public;
- an **organization** and an **owner**, the person who created it;
- an **artifact** of one kind, shown in lists as "Static bundle" (uploaded files), "External URL" (a public URL, an experimental option), or "Worker" (code; unavailable on a default installation);
- an **active revision**;
- its **tickets**, its **grants** and pending invitations, and its watchers.

Name, address, visibility, organization, and owner are chosen once. The web app has no way to rename a Shiplet, change its address, change its visibility, move it to another organization, or replace its artifact; a new revision can only come from the API.

A Shiplet is **active** or **archived**. Archiving hides it from the active lists, replaces its review link with an archived page, and stops all new feedback, but keeps its tickets, grants, and watchers. The restore window is 30 days from archiving; after it, the Shiplet is scheduled for deletion. During the window an archived Shiplet can be restored, or (by its owner only, after typing its address) permanently deleted, which cannot be undone. See `shiplets/archive-restore-and-delete.md`.

## Artifacts and revisions

The **artifact** is the work under review, never edited by Shiplet. Uploaded files keep their names and folder paths; an `index.html` (or any top-level `.html` file) becomes the entry page, and without one Shiplet generates a file review page listing the files. A URL artifact is fetched from its public origin, read-only, each time it is viewed. How each kind looks inside the artifact frame is described in `preparing/how-artifacts-are-shown.md`.

A **revision** is one version of the artifact. A Shiplet made in the browser has exactly one. The review link always serves the **active revision**, and every review screen names it ("Revision {id}" in the composer and the panel's context line). Each ticket records the revision it was written against, which the thread reports as provenance: "Current revision" when it matches the active one, "Earlier revision" when it does not, and "Earlier feedback" for tickets that predate revision tracking. Tickets from earlier revisions stay with the Shiplet; the comments panel shows them unless its Revision filter is set to Current revision.

> Technical note: a Shiplet that predates revisions is given a stand-in revision named `legacy_{Shiplet id}`, which is what its review screens show.

## The review link

Every Shiplet's address is a review link: `https://{address}.shiplet.cc/` on an installation with a custom domain, or `{app}/{address}/` without one (local development, and any installation without `CUSTOM_DOMAIN`). Each path under it is a page of the same Shiplet, and every ticket belongs to the page it was written on. Tickets are matched to pages by origin and path: the query string and the fragment are ignored, except a fragment that starts with `#/`, which single-page apps use as their route and which therefore counts as part of the page. The trusted host, the frames, and how the review layer finds the reviewer are in [the review link](the-review-link.md).

## Tickets

A ticket is created by sending the composer on a review link or the dashboard preview, by the comment form on the Shiplet page, or by an agent. It holds:

- its **ticket label**, `PF-{n}`, where n counts up from 1 within the Shiplet and is never reused (tickets cannot be deleted);
- the **comment**, 1 to 5,000 characters, trimmed;
- its **status** (below) and its **author**: the person's email address, or "Reviewer" when there is none; tickets written by agents carry the agent's identity;
- the **page** it was written on, and the **revision**;
- optionally a **target** (CSS selector, tag, and up to 500 characters of visible text) and the **capture** around it: viewport size and pixel ratio, scroll offset, the point clicked, and capture fidelity;
- optionally a **screenshot** (a PNG of the visible artifact, with any drawing burned in) and, when the structured drawing editor was used, the drawing itself as shapes (pen strokes, arrows, text boxes) so that agents can read it;
- optionally up to four **attachments** (photos or video, at most 5 MiB each and 10 MiB together) and one **copy request** (a proposed text change of at most 4,000 characters, which never edits the artifact);
- its **replies** and **mentions**, and when it was created.

Nothing about a ticket can be edited after it is saved, and neither a ticket nor a reply can be deleted in the web app. Only its status changes, and replies are added.

A ticket is created at most once per submission: every Send carries an identity that the server remembers, so a retry of the same Send returns the ticket already saved instead of making a second one.

## Statuses

Every ticket has exactly one of six statuses, always listed in this order: **New**, **In Progress**, **Blocked**, **Staging**, **Done**, **Dropped**. New tickets start as New. Done and Dropped are **closed**; the other four are **open**. Any status can change to any other; there is no enforced order. In the review layer, Resolve sets Done and Reopen (shown on a closed ticket) sets New; the Status picker reaches the rest. The Shiplet page has a status list on each ticket; the Feedback view only shows status and filters by it.

Anyone who can view a Shiplet can change the status of its tickets. Each change notifies the Shiplet's watchers.

## Replies

A reply belongs to one ticket and holds its text (1 to 5,000 characters), its author, its time, and any mentions. Replies are listed oldest first, at most 100 per thread in the review layer. They cannot be edited or deleted.

## Mentions

A ticket or reply sent from the review layer can mention up to 20 people (the server itself accepts 25, which only agents can reach). Only members of the Shiplet's organization can be mentioned, and the suggestions offered include members who cannot view the Shiplet yet. Mentioning such a member gives them a reviewer grant on the Shiplet on the spot, so they can open the ticket they were mentioned on; the Feedback view marks that mention as invited ("Invited but has not joined this shiplet yet") rather than active. A mentioned person gets a notification unless they are the author.

## Watching and notifications

A person watching a Shiplet gets a notification for every new ticket, reply, and status change on it, except their own and except one they are mentioned in (which gives them a mention notification instead). The owner watches by default until they turn it off; anyone else who can view the Shiplet can turn watching on from the Shiplet page or the review link. Notifications appear in the Inbox and, when the installation has email configured, by email. The rules in full are in `cross-cutting/notifications-and-watching.md`.

## What is shared and what is personal

Everything saved is shared: a Shiplet, its tickets, statuses, replies, mentions, and grants are the same for everyone who can view it, and appear for them on their next load or poll. Everything not yet saved is personal to one browser profile: drafts, the panel's filters, review preferences, the theme, and any platform form's typed values (see [the page lifecycle](page-lifecycle.md#saved-unsaved-and-where-unsent-work-lives)). Watching and notifications are personal and server-side.

## Limits

| Thing | Limit |
| --- | --- |
| Shiplet address | 1 to 63 characters: lowercase letters, digits, single hyphens between them; unique |
| Ticket comment, reply | 5,000 characters |
| Copy request | 4,000 characters |
| Mentions per ticket or reply | 20 from the review layer (25 accepted from agents) |
| Attachments per ticket | 4 files, 5 MiB each, 10 MiB in total, photos and video only |
| Screenshot | About 10 MB as sent |
| Target text | 500 characters; selector 1,200 characters |
| Page address of a ticket | 2,048 characters |
| Replies shown per thread in the review layer | 100 |
| Archive restore window | 30 days |

## Open questions and verification

- Watchers are notified whether or not they can still view the Shiplet; a person whose access was removed but who still watches it keeps getting notifications naming its tickets. Read from code, not tried.
- Mentioning an organization member grants them access to a Private Shiplet. `docs/review-feedback.mdx` says mentions "notify only collaborators who can already access the Shiplet" and that a mention "does not widen access". The code widens it. This needs a product call.
- The 100-reply display cap in the review layer has no "more replies" control; a thread with more replies silently shows the first 100. Not tried.
- Whether an agent-written ticket shows the agent's name or "Reviewer" as its author in each surface was not checked.

Verified against shiplet-core commit `3327af4`
