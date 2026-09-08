# Embeddable feedback acceptance contract

Shiplet's built-in review layer can be installed on a site's original origin with
a public installation ID. It shares the existing project's feedback and access
policy. The host page is untrusted; reviewer identity and confirmation remain in
Shiplet. No framework, build step, or host backend is required.

- Given an editor, when they register an exact HTTPS origin (or localhost for
  development), then Shiplet returns a copyable script and custom element.
  Registration and revocation require project edit access and same-origin forms.
  Registering another project's origin must not revoke an existing installation.
- Given the script and `<shiplet-feedback installation-id="…">`, when the page
  loads, then one isolated, keyboard-accessible launcher appears. Review frames
  load on demand. Duplicate scripts, remounts, removal, and disabled state must
  not leak frames, listeners, timers, or global history patches.
- Given an authorized reviewer, when they select a host-page element, then the
  existing review composer receives bounded element context and screenshots.
  Normal page interaction works outside selection mode. The host never receives
  session credentials and cannot approve feedback on the reviewer's behalf.
- Given an SPA route change, when history or hash navigation occurs, then the
  next feedback is bound to the current sanitized URL. Pending selection is
  canceled on navigation. Credential-shaped query values are excluded.
- Given blocked third-party cookies, sign-in opens in Shiplet and a single-use
  handoff resumes the trusted frame. Navigation may reuse that session but must
  not extend its original expiry. Failures remain actionable.
- Given shared feedback, numbered pins appear on the original page. Authorized
  teammates see the same threads, can reply and resolve after top-level
  confirmation, and agents receive the same canonical feedback records.
- Given private descendants inside a selected element, selection text and both
  DOM and fallback captures exclude them and form field values.
- Given a revoked installation, wrong origin, missing permission, expired
  session, or failed connection, then the widget exposes a clear recovery state
  and does not send feedback with stale authority.
- Given a public URL, its existing HTML/CSS/redirect/read-only security contract
  remains intact. Add regression cases for demonstrable rendering failures.
  Signed-in apps, writes, sockets, and origin-bound browser APIs use the embed;
  the UI and public docs explain this boundary instead of promising universal
  proxy compatibility.
- Public docs include exact setup, HTML and framework mounting examples,
  CSP requirements, disable/remove/revoke instructions, limitations, and a
  complete copyable prompt for a coding agent.

Validation: route authorization tests, browser lifecycle/context tests, existing
URL fidelity suite, embed security mutation checks, and `npm run verify`.
