# Shiplet for WordPress

## Product contract

Shiplet for WordPress embeds Shiplet's existing review widget on a connected
WordPress site's original URLs. Reviewers do not need to open a proxied Shiplet
URL, and ordinary site visitors do not see or download the remote review client.

One WordPress site maps to one Shiplet project. Feedback remains separated by
the original page URL inside that project.

## Installation and connection

The plugin adds a Shiplet settings page for WordPress administrators.

The administrator connects through a browser-based Shiplet authorization flow:

1. WordPress creates an unpredictable state value and redirects the
   administrator to Shiplet.
2. Shiplet authenticates the administrator and asks them to select an editable
   project or create a new project for the site.
3. Shiplet redirects to the same WordPress origin with a short-lived,
   single-use connection code.
4. WordPress validates the state value and exchanges the code from its server.
5. Shiplet returns a site-scoped installation identifier and secret. WordPress
   stores the secret server-side and never renders it into public HTML.

Disconnecting revokes the installation in Shiplet and removes the local
credentials.

## Review activation

The plugin's local loader is inert unless the browser opens a URL with
`?shiplet-review=1` or review mode is already active in that tab's session
storage.

When review mode is active:

1. The loader redirects the current tab to Shiplet's first-party authentication
   endpoint when it does not have a current review session.
2. Shiplet verifies that the signed-in reviewer can view the connected project.
3. Shiplet redirects back to the exact client-site origin with a short-lived,
   single-use review code.
4. The loader exchanges that code for short-lived, user-bound review and
   presence capabilities.
5. The loader removes exchange parameters from the visible URL, configures
   `window.__SHIPLET_REVIEW__`, and loads Shiplet's existing review client.

Review capabilities are stored only in the current tab's session storage and
expire after 15 minutes. A later activation repeats the first-party Shiplet
authorization redirect.

## Origin and credential boundaries

- Connection and review return URLs must use the exact WordPress site origin.
- Production installations require HTTPS. HTTP is accepted only for local
  development origins.
- Shiplet reflects CORS headers for review APIs only when the request origin has
  an active installation for that project.
- Public installation identifiers may appear in page source. Installation
  secrets and organization credentials must not.
- Connection and review codes are single-use, expire within minutes, and are
  stored as hashes.
- Installation secrets are independently revocable and are stored as hashes by
  Shiplet.
- WordPress nonces and a separately generated state value protect administrator
  actions and the connection callback.

## Acceptance criteria

### Connect a site

Given a WordPress administrator starts a connection, when they authenticate
with Shiplet and choose an editable project, then WordPress stores a site-scoped
installation and shows the connected project without exposing its secret in
frontend markup.

Given a WordPress administrator chooses to create a project, when they confirm
the connection, then Shiplet creates one external-URL project for the WordPress
site and binds the installation to its exact origin.

Given a connection code has already been exchanged or has expired, when a
client attempts another exchange, then Shiplet rejects it.

Given the callback state does not match the initiating WordPress administrator's
state, when WordPress receives the callback, then it rejects the connection and
does not store credentials.

### Activate review mode

Given an ordinary visitor opens a connected WordPress page without review mode,
when the local loader runs, then it makes no Shiplet request and renders no
Shiplet UI.

Given an authorized reviewer opens a connected page with
`?shiplet-review=1`, when they finish Shiplet authentication, then the existing
Shiplet review client mounts on the original WordPress URL under that reviewer's
identity.

Given a signed-in Shiplet user cannot view the connected project, when they try
to start review mode, then Shiplet denies the review session.

Given a review code is presented from a different origin, for a different
installation, after expiry, or for a second time, when it is exchanged, then
Shiplet rejects it without issuing capabilities.

### Review APIs

Given a valid embedded review capability and an active installation for the
request origin, when the review client lists or creates feedback, then Shiplet
allows the cross-origin request and associates feedback with the connected
project and original page URL.

Given an origin has no active installation for the project, when it sends a
review API preflight or request, then Shiplet does not grant that origin CORS
access.

Given an installation is disconnected, when a previously activated client site
tries to start or exchange a review session, then Shiplet rejects the request.

## Deliberate first-release limits

- The first release connects one exact origin per WordPress installation.
  Separate staging and production origins require separate plugin connections.
- Review mode is tab-scoped; closing the tab clears its locally cached
  capabilities.
- Sites with a Content Security Policy must allow Shiplet's script and API
  origin.
- WordPress multisite installs connect each site independently.
