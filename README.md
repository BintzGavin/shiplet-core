# Shiplet Core

Shiplet Core is the source-preview release of Shiplet, a Cloudflare-native
review layer for agent-first product teams. It turns static build output,
exports, files, and supported external URLs into durable review rooms without
changing the reviewed application.

## Source-preview boundary

This repository is published so developers can inspect the architecture, build
the project, run its behavior-focused test suite, and evaluate supported local
and self-hosted paths. It is not an invitation to submit pull requests or use
GitHub Issues or Discussions for support or product feedback. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the participation policy and
[`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

The repository contains no credential or workflow capable of deploying
Shiplet.cc. Its checked-in Wrangler files use synthetic, user-replaceable
resources and have no Shiplet.cc route.

## Canonical source and production releases

This repository owns Shiplet application changes and records maintainer
history. Operators promote a production release only after the private
operations repository pins its protected tag and full commit SHA. Public CI
verifies commits and has no credentials or configuration that can deploy
Shiplet.cc.

## Supported local verification

Use Node.js 22.12.0 or newer:

```bash
npm ci
npm run generate:public
npm run verify
```

Start a local Worker using the public-safe example configuration:

```bash
npm run dev
```

The example configuration is intended for builds and local evaluation. A
self-hosted deployment requires your own Wrangler configuration and resources:

```bash
npm run deploy -- --config ./wrangler.self-hosted.jsonc
```

The deploy command rejects the checked-in example configurations and refuses to
run unless an explicit user-owned configuration path is provided.

## Kody review workflow

The maintained [Kody source package](integrations/kody/shiplet/README.md) turns a
caller's Shiplet connection into a complete static artifact review workflow:
publish, page through contextual feedback, prepare an immutable revision,
collect before/after evidence, and activate after trusted owner approval.

Run the [local browser demo](integrations/kody/demo/README.md) to exercise a real
annotation and revision at the original review link. The demo uses local
Wrangler storage and a synthetic account; hosted OAuth consent and a hosted
Kody package installation remain separate verification steps.

## Architecture

Shiplet defaults to static artifact publishing. The trusted host owns identity,
access policy, feedback, and review state; artifact and widget code run behind
that boundary without reviewer sessions, platform credentials, or direct
storage authority. Worker-code deployments are an advanced path with a higher
security burden.

Current behavior and security contracts are documented in:

- [`docs/public-documentation/acceptance-spec.md`](docs/public-documentation/acceptance-spec.md)
- [`docs/public-documentation/behavior-ledger.md`](docs/public-documentation/behavior-ledger.md)
- [`docs/self-owned-shiplets/architecture.md`](docs/self-owned-shiplets/architecture.md)
- [`docs/self-owned-shiplets/threat-model.md`](docs/self-owned-shiplets/threat-model.md)
- [`openapi.json`](openapi.json)

## Review an existing website

Install Shiplet's web component on a site your team can edit. It keeps the page
on its original origin and shares pinned comments, replies, and resolution with
teammates and Shiplet's agent feedback queue.

Open [Connect a website](https://shiplet.cc/embed/install) to register your site
and get the two-tag snippet. The [website widget guide](https://shiplet.cc/docs/embed)
includes HTML and framework examples, a copyable agent installation prompt, CSP
settings, privacy controls, and removal instructions.

For pages your team cannot edit, use [Browser capture](https://shiplet.cc/capture).
Capture a tab with the browser picker or the downloadable Chromium companion,
or upload a screenshot. Review and redact it locally, then share a private
visual copy with the same pins, conversations, and agent feedback APIs.
The [capture guide](https://shiplet.cc/docs/browser-capture) includes installation,
privacy details, and a copyable agent prompt. URL previews remain experimental.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
