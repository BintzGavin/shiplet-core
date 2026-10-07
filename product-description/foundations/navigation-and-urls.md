# Navigation and URLs

## Summary

This document owns how a person moves around Shiplet: the header and the two navigation bars, every route of the web app and what is in its URL, what happens when a signed-out person opens a protected page, the deep links other pages and emails use, the two shapes a review link takes, and the theme switch. Feature documents link here for "where the person lands" and "what is restored on return".

## The header

Every page of the Shiplet app (but not a review link, the dashboard preview, or the signed-out landing card) starts with the same header: the Shiplet mark on the left, which links to `/` and is labeled "Shiplet home", and on the right a Docs link, the theme switch, and, when signed in, the person's avatar, which links to the Account page. A thin animated waterline runs under it; it stops when the tab is hidden or the person prefers reduced motion.

**The theme switch** is a sun-and-moon switch labeled "Dark mode". Until the person uses it, every page follows the operating system's light or dark setting. Using it sets the theme for every Shiplet page in that browser, remembered in local storage, and applied before the page paints, so there is no flash on the next load. Turning dark mode on sends a single lightning strike across the header (not when the page opens in dark mode, not with reduced motion). The switch is hidden when scripts are off. The review link has no theme switch; its review layer has its own light styling.

## Platform navigation

Under the page title, the Prepare page, the Shiplets list, the Feedback view, the Inbox, and the settings pages show the platform navigation: **Prepare** (`/`), **Shiplets** (`/shiplets`), **Feedback** (`/feedback`, with a badge), **Inbox** (`/inbox`, with a badge), and **Workspace** (`/workspace`). The current page's link is marked; on the Account, Access, and Agents pages, Workspace is marked. The badges are defined in the [glossary](../glossary.md#interface) and refresh as described in [the page lifecycle](page-lifecycle.md#live-updates-and-polling).

The Shiplet page and the access request page have no platform navigation: the way back is the header's Shiplet mark, the browser's back button, or the Shiplet page's "Create another shiplet" link.

**Settings navigation.** The four settings pages share a second, local navigation: Overview (`/workspace`), Account (`/account`), Access (`/access`), Agents (`/agents`). It sits beside the page's sections on wide screens and above them on narrow ones.

## Routes

| URL | What it shows | Signed out |
| --- | --- | --- |
| `/` | The Prepare page | A card: "Review any build, file, or live URL", with Prepare a review (sign-in), Try the sandbox, and Docs |
| `/shiplets` | The Shiplets list | Sign-in, then back here |
| `/shiplets/{id}` | The Shiplet page. `?created=1` adds the "Shiplet ready" heading and a "Published for review." card. | Sign-in, then back here |
| `/shiplets/{id}/review-host` | The dashboard preview on its own (what "Open review page" opens) | Sign-in, then back here (Unlisted and Public Shiplets open without it) |
| `/shiplets/{id}/preview` | Redirects to `/shiplets/{id}/review-host` | As above |
| `/shiplets/{id}/access` | The access request page; redirects to the Shiplet page (or back to the review link it came from) if the person can view | Sign-in, then back here |
| `/feedback` | The Feedback view. Its filters are in the query: `status`, `mentionedMe`, `watched`, `submittedByMe`, `projectId`. | Sign-in, then back here |
| `/inbox` | The Inbox | Sign-in, then back here |
| `/workspace`, `/account`, `/access`, `/agents` | The settings pages. `/settings` redirects to `/workspace`. | Sign-in, then back here (`/settings` returns to `/workspace`) |
| `/join/{token}` | Joining through an invite link (`access/invite-links.md`) | Shows the organization and asks to sign in |
| `/auth/login`, `/auth/logout` | Sign-in (through WorkOS); sign-out, which lands on `/` | |
| The review link | The trusted host and the artifact (below and in [the review link](the-review-link.md)) | Private and Organization Shiplets: sign-in, then back to the same page of the review link. Unlisted and Public: opens at once. |

**Return after sign-in.** A protected page opened while signed out redirects to `/auth/login` with the page's own path as `return_to`, and sign-in comes back to exactly that path, query included. Only paths on the app itself and addresses on the installation's own domains are accepted as a return; anything else returns to `/`. A person who is already signed in and opens `/auth/login` is sent straight to the return address.

**What is restored on return.** Only what is in the URL. The Feedback view's filters are in its URL; nothing else on a platform page is (the Shiplets list's search, the active organization on the Workspace page, and every form's typed values start over). The review layer restores its drafts, filters, and preferences from browser storage instead ([the page lifecycle](page-lifecycle.md#saved-unsaved-and-where-unsent-work-lives)).

## Deep links

- **To a ticket.** The Feedback view, the Inbox, notification emails, and the review layer's "Open feedback" link all point at `/shiplets/{Shiplet id}?feedback={ticket id}`. The Shiplet page opens normally; it does not scroll to, open, or highlight that ticket.
- **To a new Shiplet.** Creating a Shiplet lands on `/shiplets/{id}?created=1`, which shows "Shiplet ready". Reloading keeps the parameter and the message.
- **To a review link with parts hidden.** The review layer's clean links add `shiplet_review=hidden` or `shiplet_comments=hidden` to a review link (`review/review-settings-and-links.md`).

## Review link addresses

A Shiplet's review link has one of two shapes, depending on the installation, not on the Shiplet:

- **Its own host**, `https://{address}.{domain}/`, when the installation has a custom domain (production: `https://{address}.shiplet.cc/`). The Shiplet app's session does not reach that host; the review link learns who the person is by sending them through the app's access check once, which hands back a short-lived review pass (see [the review link](the-review-link.md#who-the-reviewer-is)).
- **A path on the app**, `{app}/{address}/`, when it has none (local development and the verification setup). The app's session reaches it directly.

Every path after the address is a page of the artifact: `{review link}/about.html` opens the review link at the artifact's `about.html`. The Shiplets list's Copy URL and View live use whichever shape the installation has; the Shiplet page's buttons use the dashboard preview instead.

On a path-shaped installation, an address that is also one of the app's own route names (for example `feedback`, `docs`, `join`, `settings`, `account`) can be chosen when publishing, but its review link opens the app's page of that name instead of the Shiplet.

## Open questions and verification

- `?feedback={ticket id}` is used by four surfaces and honored by none: the Shiplet page ignores it. May be worth treating as a bug rather than documenting.
- Addresses that collide with the app's route names are accepted on the Prepare page and unreachable as path-shaped review links. Read from code; not tried.
- The exact list of hosts accepted as a return address after sign-in depends on installation settings and was not enumerated.
- The theme's storage key and the absence of a flash on load were read from code, not watched.

Verified against shiplet-core commit `3327af4`
