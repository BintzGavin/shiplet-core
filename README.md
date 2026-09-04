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

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
