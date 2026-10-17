import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./package-chatgpt-plugin.mjs", import.meta.url));

test("packages only portable manifests for the explicit remote origin", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "shiplet-plugin-package-test-"));
	try {
		const out = path.join(dir, "plugin.zip");
		execFileSync(process.execPath, [script, "--origin", "https://preview.example.test/", "--out", out]);
		const entries = execFileSync("unzip", ["-Z1", out], { encoding: "utf8" }).trim().split("\n");
		assert.deepEqual(entries.sort(), ["mcp.json", "plugin.json"]);
		const manifest = JSON.parse(execFileSync("unzip", ["-p", out, "plugin.json"], { encoding: "utf8" }));
		const mcp = JSON.parse(execFileSync("unzip", ["-p", out, "mcp.json"], { encoding: "utf8" }));
		assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
		assert.equal(manifest.name, "shiplet");
		assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
		assert.deepEqual(mcp.mcpServers, { shiplet: { type: "streamable-http", url: "https://preview.example.test/api/plugin/mcp" } });
		const original = await readFile(out);
		assert.notEqual(spawnSync(process.execPath, [script, "--origin", "https://other.example.test", "--out", out]).status, 0);
		assert.deepEqual(await readFile(out), original);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("requires an HTTPS origin and an explicit output without embedded authentication or URL suffixes", () => {
	for (const args of [[], ["--origin", "https://example.test"], ...[
		"http://example.test", "https://example.test/path", "https://example.test/?q=x",
		"https://example.test/#fragment", "https://fixture:fixture@example.test",
	].map(origin => ["--origin", origin, "--out", "/unused-plugin-test.zip"])]) {
		assert.notEqual(spawnSync(process.execPath, [script, ...args]).status, 0);
	}
});
