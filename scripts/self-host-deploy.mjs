#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let parsed;
try {
	parsed = parseArgs({
		args: process.argv.slice(2),
		options: {
			config: { type: "string" },
			"dry-run": { type: "boolean" },
			env: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
		tokens: true,
	});
	for (const name of ["config", "env"]) {
		if (parsed.tokens.filter((token) => token.name === name).length > 1) {
			throw new Error(`--${name} may only be provided once.`);
		}
	}
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exit(2);
}
const configArgument = parsed.values.config;
const checkedInExamples = new Set([
	"wrangler.jsonc",
	"wrangler.test.jsonc",
	"workers/cloudflare-control-plane/wrangler.jsonc",
	"workers/managed-runtime-gateway/wrangler.jsonc",
	"workers/deny-egress/wrangler.jsonc",
].map((entry) => path.resolve(root, entry)));

if (!configArgument) {
	process.stderr.write(
		"Self-hosted deploy requires --config <path-to-your-wrangler-config>.\n",
	);
	process.exit(2);
}

const configPath = path.resolve(process.cwd(), configArgument);
if (!existsSync(configPath) || checkedInExamples.has(configPath)) {
	process.stderr.write(
		"Provide an existing user-owned Wrangler config, not a checked-in example.\n",
	);
	process.exit(2);
}

const wrangler = path.resolve(root, "node_modules", ".bin", "wrangler");
const wranglerArgs = ["deploy", "--config", configPath];
if (parsed.values["dry-run"]) wranglerArgs.push("--dry-run");
if (parsed.values.env !== undefined) wranglerArgs.push("--env", parsed.values.env);
const child = spawn(wrangler, wranglerArgs, {
	cwd: root,
	stdio: "inherit",
	shell: false,
});
child.on("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
