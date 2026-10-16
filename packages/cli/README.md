# Shiplet CLI

Prepare static artifacts for review and manage portable drafts, revisions,
deployments, and exports. Requires Node.js 22.12.0 or newer.

The unscoped npm package `shiplet` belongs to an unrelated project. Do not use
`npx shiplet` to run this CLI. The intended registry name is
`shiplet-cli`; registry publication is pending.

Run the versioned GitHub release without a source checkout:

```sh
npx --package=https://github.com/BintzGavin/shiplet-core/releases/download/cli-v0.1.2/shiplet-cli-0.1.2.tgz shiplet --help
```

Or install that same tarball once:

```sh
npm install -g https://github.com/BintzGavin/shiplet-core/releases/download/cli-v0.1.2/shiplet-cli-0.1.2.tgz
shiplet prepare ./dist --name "Review build" --subdomain review-build --visibility organization --dry-run --json
```

Remove `--dry-run` to publish. Network commands open browser authorization when
needed. Run `shiplet login` to approve a session, `shiplet whoami` to inspect its
account and expiry, and `shiplet logout` to revoke it. Sessions last two hours
by default; use `--no-session-cache` for approval on every command. The CLI and
browser must run on the same computer. Credentials are never printed.

Draft writes require the expected `--version`; activation requires
`--expected-active` and `--approve`. Packaging does not change these checks.
The CLI has no feedback list/reply/status commands: use the review link or
[Feedback](https://shiplet.cc/feedback), with MCP or REST as optional automation.

See the [CLI guide](https://shiplet.cc/docs/cli) for all commands, session storage,
scope restrictions, and trusted `--api-url` overrides.
