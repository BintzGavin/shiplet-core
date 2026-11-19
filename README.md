# Shiplet

Shiplet is where teams share what their agents made, and how they made it.

- **Artifacts:** a build, static export, file, or public preview URL gets one
  review link. People comment on the work itself, and every comment keeps the
  revision it was left on.
- **Traces:** the full agent session behind the work, with prompts, replies,
  every tool call and result, screenshots, and videos. Secrets are masked on
  your computer before it leaves, and it stays private until you share it.
- **Access you choose:** a Shiplet can be private, organization-wide, unlisted,
  or public, with view and edit granted separately to people, email addresses,
  and teams. Each trace is shared per audience at Full, Conversation, or Summary
  level, with optional rules to mask terms or hide paths, reasoning, or videos.
- **Every agent:** Claude Code and Codex are built in, any agent can share by
  writing the [open trace format](https://shiplet.cc/docs/trace-format), and any
  agent that speaks MCP or runs the CLI can load a trace and carry on.

[Open Shiplet](https://shiplet.cc/) · [Read the docs](https://shiplet.cc/docs) ·
[View the OpenAPI contract](https://shiplet.cc/openapi.json)

## Choose your task

- **[Share your first artifact and session](https://shiplet.cc/docs/quickstart):**
  ask your agent to "publish ./dist to Shiplet for review, then share this
  session to it".
- **[Share an agent session](https://shiplet.cc/docs/traces):** run
  `npx shiplet-cli trace share --current --shiplet <id>`, then choose who can
  read it and at what level.
- **[Collect feedback](https://shiplet.cc/docs/review-feedback):** leave
  comments on the work and work through review tickets.
- **[Connect your agent](https://shiplet.cc/docs/authentication):** sign in the
  CLI or Code Mode MCP with OAuth, including from cloud agents.
- **[Manage access](https://shiplet.cc/docs/access-control):** choose who can
  open each Shiplet and read each session.
- **[Connect a website](https://shiplet.cc/docs/embed):** collect feedback on a
  live site.

## How Shiplet fits together

```text
Shiplet review link
├── trusted host      identity, access policy, feedback, and review actions
├── artifact frame    the page, file, build, or URL under review
├── widget frame      optional custom review controls and workflow
└── traces            agent sessions behind the work, shared per audience
```

The artifact and optional widget run in separate sandboxed frames. Neither
receives reviewer credentials, organization API keys, or direct access to
Shiplet storage. Static artifacts are the supported default because
artifact-owned Worker code carries a higher security burden.

## Quickstart

The fastest path starts in the browser:

1. [Open Shiplet](https://shiplet.cc/) and sign in.
2. Connect a website with the embeddable widget, or upload supported files.
3. Name the artifact, choose its review subdomain, and select who can see it.
4. Open the review link, leave a comment, and find the resulting ticket in the
   Shiplet detail page or Feedback view.

For local and agent workflows, start with the [CLI guide](https://shiplet.cc/docs/cli).
No source checkout or custom MCP server is required:

```bash
npx shiplet-cli --help
```

The public `shiplet-cli` package requires no npm account to install.
The unscoped npm package `shiplet` belongs to an unrelated project.
Browser approval creates a reusable session for two hours by default. Use
`npx shiplet-cli whoami` to inspect it and `npx shiplet-cli logout` to revoke it.
[Code Mode MCP](https://shiplet.cc/docs/code-mode-mcp) is also supported for API
discovery and operations beyond the CLI, including feedback automation. Its
endpoint is `https://shiplet.cc/api/mcp`.

## Run the source locally

This repository is the canonical application source for Shiplet's
Apache-2.0-licensed source-preview release. Use Node.js 22.12.0 or newer:

```bash
npm ci
npm run generate:public
npm run dev
```

The checked-in Wrangler configuration uses synthetic resource names and local
test authentication. It is suitable for build, test, and public-surface
evaluation, so a normal signed-in browser session needs your WorkOS application.
To exercise
that flow, copy [`.dev.vars.example`](.dev.vars.example) to an ignored
`.dev.vars` file and configure your own WorkOS AuthKit application. Keep every
credential in the provider or platform secret store and out of source control.

Run the complete public verification gate before relying on a change:

```bash
npm run verify
```

That gate runs generated-source checks, type checking, behavior-focused tests,
Worker dry-runs, license checks, and the dependency audit.

## What is in this repository

| Path | Responsibility |
| --- | --- |
| [`src/`](src/) | Shiplet application, trusted review host, API, MCP, and CLI |
| [`workers/`](workers/) | Advanced Cloudflare support Workers and public-safe example configs |
| [`docs/`](docs/) | Product guidance plus behavior, architecture, and threat-model contracts |
| [`test/`](test/) and [`e2e/`](e2e/) | Unit, integration, security, and browser behavior checks |
| [`openapi.json`](openapi.json) | Supported public automation contract |

## Static-first self-hosting

The supported self-hosting wizard installs Shiplet's static review product in a
Cloudflare account you own:

```bash
npm ci
npm run setup:self-host
```

It provisions one main Worker, one D1 database, two private R2 buckets, and the
required Durable Objects. During setup, it guides you through a WorkOS AuthKit
application and installs secrets directly in Cloudflare. The wizard deploys a
bootstrap Worker before identity setup, deploys the finished config afterward,
and checks the public application and OpenAPI contract. The main D1 schema
initializes on first use. Generated configuration and live resource identifiers
stay in the ignored `.shiplet-self-host/` directory, and secret values are never
written there.

Static artifacts, public-URL reviews, identity and access, feedback, revisions,
and the REST API are the supported default. The wizard does not require or
attempt to provision Worker Loader, dispatch namespaces, support Workers, or
Workers for Platforms. Its capability report marks those paths as optional and
unavailable while the static product continues to work.

Workers for Platforms remains an opt-in upgrade. This repository includes the
support Worker source and public-safe example configs, and the capability
inspector can evaluate an operator-owned advanced config set:

```bash
npm run self-host:capabilities -- \
  --main-config .shiplet-self-host/<name>/wrangler.jsonc \
  --control-config /path/to/control.wrangler.jsonc \
  --runtime-config /path/to/runtime.wrangler.jsonc \
  --deny-config /path/to/deny.wrangler.jsonc
```

The inspector checks configuration shape and readiness gates. It does not buy a
plan, create advanced infrastructure, run migrations, or enable a capability.
See [`docs/self-hosting.mdx`](docs/self-hosting.mdx) for the complete setup,
recovery, and upgrade contracts.

Production operations are intentionally separate. The private operations
repository used for Shiplet.cc contains the protected release lock, production
and isolated rehearsal configs, exact Worker deployment ordering, database
migration orchestration, smoke suites, rollback checks, and immutable release
records. Shiplet's application implementation lives in this public repository,
which remains sufficient for inspection, builds, tests, and evaluation.

## Source-preview boundary

Public CI verifies this source without credentials or authority to deploy
Shiplet.cc. GitHub pull requests, Issues, and Discussions are not supported
participation or product-support paths during source preview. See
[`CONTRIBUTING.md`](CONTRIBUTING.md). Report vulnerabilities privately through
the process in [`SECURITY.md`](SECURITY.md).

For the detailed contracts behind the implementation, start with:

- [`docs/public-documentation/acceptance-spec.md`](docs/public-documentation/acceptance-spec.md)
- [`docs/public-documentation/behavior-ledger.md`](docs/public-documentation/behavior-ledger.md)
- [`docs/self-owned-shiplets/architecture.md`](docs/self-owned-shiplets/architecture.md)
- [`docs/self-owned-shiplets/threat-model.md`](docs/self-owned-shiplets/threat-model.md)

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

Apache-2.0. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
