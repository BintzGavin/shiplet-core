# Access and roles

## Summary

This document owns who a person is to Shiplet and what they may do: how they are identified, the roles they can hold in an organization and on a Shiplet, how a Shiplet's visibility combines with those roles, and which actions each role allows. Every feature document's Role row links here. Two rules run through all of it. First, the server checks authority on every request, at the moment the request arrives; nothing is decided when a page loads, and a page often shows a control to someone who will be refused when they use it. Second, viewing and editing are separate: anyone who can view a Shiplet can comment on it, reply, change ticket statuses, and watch it, but only an editor can change who has access or archive it from the Shiplet page.

## Identity

A person signs in through WorkOS AuthKit with an email address, and from then on is that email address to everyone else: it is their name on tickets and replies, the address invitations must match, and the identity in the Account page. A first and last name from the sign-in provider, when present, is used instead in notification messages and in presence; presence never shows an email address, so a person without a name appears there as "Reviewer". Each person also has an avatar, either one of the preset objects or an uploaded image, shown in presence and in the header. The sign-in session lasts 14 days from sign-in and is not extended by activity; after it, the next page load goes back through sign-in ([navigation and URLs](navigation-and-urls.md)).

With default settings a browser holds one signed-in account at a time. Account email switching, which keeps several accounts in one browser, is a feature flag and is off by default; without it, changing identity means signing out and back in.

## Organization roles

Each member of an organization is an **administrator** or a **member**. A person who creates an organization, or who gets one on their first publish, is its administrator.

WorkOS owns organization membership, and the web app has no way to remove a member or change their role. When someone is removed, deactivated, or demoted from administrator to member in WorkOS, Shiplet applies it at that person's next sign-in, and a background check every five minutes applies it for people who do not sign in again (about 20 people per run, so on a large instance it can take a while to reach everyone). A removal also takes the person out of the organization's teams; they keep the Shiplets they own and any grant made to them on a single Shiplet. If WorkOS cannot be reached or answers with an error, nothing changes until the next attempt.

| Action | Administrator | Member |
| --- | --- | --- |
| View every Shiplet in the organization, whatever its visibility | Yes | Only Organization, Unlisted, and Public ones, and Private ones they hold a grant on |
| Edit every Shiplet in the organization (invite reviewers, archive and restore from the Shiplet page) | Yes | Only Shiplets they own or hold an editor or owner grant on |
| Create a Shiplet in the organization | Yes | Yes |
| Invite someone to the organization as a member | Yes | Yes |
| Invite someone to the organization as an administrator | Yes | No (the Admin choice is hidden) |
| Create a team | Yes | No |
| Invite someone to a team | Yes | Yes |
| Create, copy, and revoke invite links | Yes | No |
| Create and revoke API keys | Yes | No |
| Mention people on tickets | Yes, and a mention can give a member who cannot view the Shiplet a reviewer grant | Yes, but a mention reaches only people who can already view the Shiplet, unless the member can edit it |

A person who is not a member of an organization at all can still open that organization's Shiplets when a grant or the visibility allows it, but cannot mention anyone on them (the suggestion list stays empty).

## Shiplet roles and grants

On one Shiplet, a person can edit it if they are its **owner** (its creator), an **organization administrator**, or the holder of a **grant** with the editor or owner role. A grant gives a role on one Shiplet to:

- a **person**, either directly or by email address; an email grant counts only once its invitation has been accepted by someone signed in with exactly that address;
- a **team**, counting for every current and future member of the team;
- the Shiplet's **organization**, counting for every member.

| Grant role | Gives |
| --- | --- |
| Viewer | Viewing (and with it commenting, replying, changing ticket status, watching) |
| Reviewer | The same as viewer. The two names are kept apart, but no rule tells them apart. |
| Editor | Viewing and editing |
| Owner | Viewing and editing |

Grants are made with the invite reviewers form ([the invite reviewers form](../shiplets/the-invite-reviewers-form.md)), which can grant only Reviewer and Viewer, and which grants an organization member's email at once and sends anyone else an invitation to that Shiplet only; by an accepted invitation; and by a mention from someone who can edit the Shiplet, which gives an organization member who could not view it a reviewer grant ([Shiplets and tickets](shiplets-and-tickets.md#mentions)). Mentions by anyone else never create a grant: other organization members' mentions only notify people who can already view, and mentions by people outside the organization have no effect. The web app cannot list or remove grants.

## Visibility

| Visibility | Signed out | Member of the organization | Organization administrator, owner | Grant holder |
| --- | --- | --- | --- | --- |
| Private | No | No, unless granted | Yes | Yes |
| Organization (default) | No | Yes | Yes | Yes |
| Unlisted | Yes, with the link | Yes | Yes | Yes |
| Public | Yes | Yes | Yes | Yes |

Unlisted and Public behave identically today: anyone with the review link can open the artifact and read its tickets, signed in or not. Nothing in the web app lists Public Shiplets for discovery. Visibility never gives editing, and a signed-out visitor to an Unlisted or Public review link can read tickets but cannot send one, reply, or change a status; the review layer reports that its review identity is unavailable ([the review link](the-review-link.md)).

## Who can do what with a Shiplet

| Action | Who | Where the check shows |
| --- | --- | --- |
| Open the review link and the Shiplet page; read tickets | Anyone who can view | Signed out: a redirect to sign-in. Signed in without access: the access request page (`access/the-access-gate.md`). |
| Send a ticket, reply, change a status, watch | Anyone signed in who can view | The review layer's messages on refusal |
| Invite reviewers | Editors | The form is shown to everyone; others get "Shiplet editor access required" |
| Archive, restore | Editors from the Shiplet page; any member of the Shiplet's organization from the Shiplets list | The Shiplet page hides the forms from non-editors ("You can view this shiplet, but lifecycle changes require editor access."); the Shiplets list shows Archive and Restore to everyone |
| Restore from the archived page at the review link | The owner only | The Restore button appears only for the owner |
| Permanently delete | The owner only, and only once archived | The form is shown only to the owner |
| Change name, address, visibility | Nobody, in the web app | Not offered |

> Technical note: organization members keep archive and restore rights on every Shiplet in their organization for compatibility with earlier releases, even where they cannot edit it otherwise. This is why the Shiplets list and the Shiplet page disagree about who may archive.

## Invitations

An invitation is sent through WorkOS to an email address and asks the person to join an organization (as a member or administrator), a team, or one Shiplet. It takes effect only when accepted by someone signed in with exactly that address, ignoring letter case, after they confirm on a consent page that names what they are joining. Accepting a team invitation makes them a member of the organization and the team. A Shiplet invitation is different: it names no organization in WorkOS, and accepting it opens that one Shiplet only, without making the person a member of the organization or of any team, so they cannot open its other Shiplets, archive Shiplets, or invite anyone. Its consent page says so ("Accepting opens this Shiplet only, not the rest of the workspace."), and its button reads "Accept invitation and open Shiplet".

A Shiplet invitation is accepted only after sign-in. Opening a restricted Shiplet or its invitation link while signed out starts an ordinary sign-in that names neither the Shiplet nor the organization. Afterwards only someone signed in with exactly the invited address is offered the consent page, including when they open the Shiplet directly; anyone else continues under the normal rules and, without access, sees the access request page. An organization or team invitation link opened by someone signed in with a different address is refused; they must sign out (or, with account switching enabled, switch accounts) and come back as the invited address. See `access/the-access-gate.md` and `access/invite-links.md`.

## How authority is checked

Every request is checked when it arrives, against the person's roles and grants at that moment. Consequences a person can notice:

- **Controls are not hidden by role** except in the few places listed above. Most refusals appear only after submitting, as a banner on platform pages or a message in the review layer.
- **Changes take effect at once, once Shiplet knows of them.** Adding a grant opens the Shiplet on the person's next request. A removal from an organization in WorkOS takes effect only when Shiplet applies it (at their next sign-in or the next background check, see [Organization roles](#organization-roles)); from then on it blocks their next request on the organization's Shiplets, in an open tab and in CLI and MCP sessions, without a reload, though those sessions stay signed in.
- **Nothing is cached in the page.** A page loaded while the person was an editor still shows editor controls after they lose the role, and those controls fail when used. A page loaded before they gained a role does not show controls that only appear for editors until it is reloaded.

What a page does when a request is refused mid-session is in [the page lifecycle](page-lifecycle.md#what-each-interrupt-means).

## Open questions and verification

- The archive rule disagrees with itself: the Shiplet page treats archiving as an editor action, and the server and the Shiplets list let any organization member archive and restore any Shiplet in the organization. Worth a product call.
- Restoring from the archived page at the review link is owner-only, while restoring from the Shiplet page and the Shiplets list is open to editors and members. Inconsistent; may be worth treating as a bug.
- When a person holds more than one direct grant on the same Shiplet, only the earliest one is consulted for editing. A person granted Viewer first and Editor later (possible only through the API) cannot edit. Read from code, not tried.
- A removed member keeps any grant made to them on a single Shiplet, including reviewer grants created by an editor's mention, and the web app cannot revoke them. Confirm that is the intended outcome of removal.
- Reviewer and viewer are indistinguishable everywhere; the difference, if one is intended, is not implemented.
- `docs/access-control.mdx` says Public is for "broad discovery"; no discovery surface exists.
- A signed-out visitor on a Public review link is shown the review controls and only learns they cannot send when the review layer reports the identity problem. Confirm by hand what they see.

Verified against shiplet-core commit `a7a714d`
