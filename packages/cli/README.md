# Shiplet CLI

Prepare static artifacts for review and manage portable drafts, revisions,
deployments, and exports. Requires Node.js 22.12.0 or newer.

Run the public package without a source checkout or npm account:

```sh
npx shiplet-cli --help
```

The unscoped npm package `shiplet` belongs to an unrelated project.
Use `npx shiplet-cli` for this CLI.

Or install globally to use the `shiplet` command:

```sh
npm install -g shiplet-cli
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
[Feedback](https://shiplet.cc/feedback), with MCP and REST also supported for automation.

See the [CLI guide](https://shiplet.cc/docs/cli) for all commands, session storage,
scope restrictions, and trusted `--api-url` overrides.
