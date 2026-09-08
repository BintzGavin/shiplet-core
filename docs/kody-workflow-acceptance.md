# Kody static review workflow acceptance

## Contract and boundaries

The provider-owned package uses the caller's Kody remote MCP connection. No
provider builtin, package service, credentials, or cross-user cache is added.
Shiplet owns projects, immutable revisions, draft version fences, review state,
and trusted promotion approval. Kody receives explicit receipts and evidence.

- Given UTF-8 static files and explicit visibility, when published, then return
  the same project identity, immutable initial revision, and absolute links.
- Given a repeated create with the same subdomain, when retried, then fail with
  conflict; never claim initial creation is idempotent or choose another name.
- Given more tickets than a page, when read, then expose a continuation cursor
  bound to project and filters, preserve ticket/reply/element provenance, and
  distinguish an empty page from transport failure or an unsupported server.
- Given a ticket, when read after promotion, then its source revision remains
  the revision in its canonical creation event. That event records the active
  revision at submission, not proof of which browser snapshot a person saw.
- Given an unknown or stale source, wrong-project ticket, or stale active
  revision, when preparing a revision, then reject before creating a draft.
- Given a valid baseline and selected tickets, when preparing a revision, then
  fork that immutable baseline, edit artifact files only, validate using the
  returned draft version, and return the exact candidate preview and checkpoint.
- Given a prepared revision, when activation is requested, then return Shiplet's
  trusted approval requirement. Resume only with its approval request ID. A
  caller boolean never supplies an agent's approval. Surface conflicts/errors.
- Given a changed artifact, when evidence is checked against source and candidate
  packages, then report per-ticket changed checks / failures / unchanged checks.
  Never set a ticket Done or equate a passing text check with human acceptance.
- Given a revoked/expired identity, missing write permission, restricted project,
  another organization or owner, when any operation is attempted, then enforce
  the existing server authorization without widening scopes or retrying writes.
- Given a failure midway through preparation, when returning an error, then
  include the last acknowledged draft checkpoint; do not silently fork again.
- Given every copyable JS/TS guide block, when run in its stated context, then
  it parses and executes through the real request parser / package interface.

## Executable proof

Worker tests call real app routes and MCP with isolated D1/R2 bindings. Browser
proof uses an isolated local Wrangler service and synthetic reviewer identities.
The Kody runtime bridge and login are explicit fixture boundaries; no live OAuth,
customer mutation, hosted Kody package publish, or production deployment is proved.
