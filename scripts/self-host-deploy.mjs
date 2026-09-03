#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configArgument = configIndex >= 0 ? args[configIndex + 1] : undefined;
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
const child = spawn(wrangler, ["deploy", "--config", configPath], {
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
