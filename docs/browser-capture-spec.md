# Browser work capture acceptance contract

The live widget reviews running sites. Browser capture closes coverage for work
that cannot embed it: authenticated third-party apps, canvas, PDFs, documents,
strict CSP pages, and local browser work. A capture is an explicit visual copy,
not a live proxy. The standard shared review room owns pins, replies, status,
access control, and the canonical agent queue.

- Given an invoked Chromium extension, when the user captures the current tab,
  then the browser produces the visible pixels without injecting into the site,
  fetching its source, accessing cookies, or installing persistent site access.
- Given a browser capture, when the user previews it locally, then they can
  redact rectangles before transferring only the edited PNG to Shiplet. The
  original remains in extension memory and is never uploaded. Navigation or a
  changed active tab during capture fails rather than capturing another page.
- Given a completed preview, when the companion opens Shiplet, only that exact
  destination tab on the configured trusted origin can receive the pending
  image. Pending transfers expire, are consumed once, and are erased on tab
  closure or cancellation. The extension contains all its executable code.
- Given any browser without the companion or a protected page where capture
  fails, when the user opens Capture in Shiplet, they can upload a PNG/JPEG/WebP
  screenshot and review it. They can also use browser-authorized screen sharing.
  Failure explains the image-upload path. No auto-publishing occurs.
- Given a preview, publishing requires sign-in, same-origin request, workspace
  membership, explicit confirmation and bounded valid PNG bytes/dimensions.
  A new organization-visible static artifact is created with screenshot,
  sanitized source URL and timestamp metadata. Query strings, URL credentials,
  and non-web local paths never enter the artifact. HTML is escaped.
- Given published pixels, two authorized reviewers can pin distinct points,
  see each other's comments, reply and resolve. Agents can read the same feedback
  and screenshot evidence through the existing API. Outsiders cannot read either.
- Given the shipped application, a downloadable versioned extension archive and
  public install/privacy/agent instructions are available. Store submission is
  a separate distribution channel; unpacked Chromium installation works now.

Required evidence: failing route/transfer tests first; real extension browser
capture including CSP/canvas pixels, file upload, redaction, sharing and access
checks; critical mutation checks; full verify; rehearsal and production smoke.
