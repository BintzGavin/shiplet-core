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
needed. With no browser on this computer (a cloud agent, SSH, or a container),
run `shiplet login --device` and approve with a code on any device. Run `shiplet login` to approve a session, `shiplet whoami` to inspect its
account and expiry, and `shiplet logout` to revoke it. Sessions last two hours
by default; use `--no-session-cache` for approval on every command. The CLI and
browser must run on the same computer. Credentials are never printed.

If your account belongs to more than one workspace, choose where to publish with
`--organization <id>` or `SHIPLET_ORGANIZATION_ID`. Without either, the error
lists your workspaces and their IDs, which start with `org_`.

Draft writes require the expected `--version`; activation requires
`--expected-active` and `--approve`. Packaging does not change these checks.
The CLI has no feedback list/reply/status commands: use the review link or
[Feedback](https://shiplet.cc/feedback), with MCP and REST also supported for automation.

## Share an agent session

A trace is the full log of an agent session: your prompts, the agent's replies,
and every tool call and result. From inside Claude Code or Codex, share the
session you are in:

```sh
npx shiplet-cli trace share --current --shiplet <shiplet-id>
npx shiplet-cli trace share --current --new --title "Fix the flaky test"
```

The CLI masks secrets before anything leaves your computer. New traces are
private until you share them with `--audience`. Colleagues read them in the
browser or load them into their own agent with
`npx shiplet-cli trace pull <trace-id> --shiplet <shiplet-id> --as context`.
See [Traces](https://shiplet.cc/docs/traces).

See the [CLI guide](https://shiplet.cc/docs/cli) for all commands, session storage,
scope restrictions, and trusted `--api-url` overrides.
