import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("the distributable installs in isolation and runs the real CLI, including browser authorization", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "shiplet-package-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
	const options = { cwd: directory, env, timeout: 120_000, maxBuffer: 2_000_000 };
	const npmFlags = ["--registry=https://registry.npmjs.org", `--userconfig=${directory}/user.npmrc`, `--globalconfig=${directory}/global.npmrc`, `--cache=${directory}/cache`, "--logs-max=0", "--fetch-retries=0", "--fetch-timeout=30000"];
	await writeFile(path.join(directory, "user.npmrc"), "");
	await writeFile(path.join(directory, "global.npmrc"), "");
	await exec(process.execPath, [path.join(root, "scripts/build-cli-package.mjs"), directory], options);
	const { stdout } = await exec("npm", ["pack", path.join(directory, "package"), "--json", "--ignore-scripts", ...npmFlags], options);
	const [packed] = JSON.parse(stdout);
	assert.deepEqual(packed.files.map((file) => file.path).sort(), [
		"LICENSE", "README.md", "package.json",
		...((await readdir(path.join(root, "src/cli"))).filter((file) => file.endsWith(".cjs")).map((file) => `lib/${file}`)),
	].sort());
	assert.ok(packed.files.find((file) => file.path === "lib/shiplet.cjs").mode & 0o111);
	await writeFile(path.join(directory, "package.json"), '{"private":true}');
	await exec("npm", ["install", path.join(directory, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund", ...npmFlags], options);
	const installed = path.join(directory, "node_modules/shiplet-cli");
	const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
	assert.equal(manifest.name, "shiplet-cli");
	assert.deepEqual(manifest.dependencies, { acorn: "8.17.0" });
	assert.equal(manifest.bin.shiplet, "lib/shiplet.cjs");
	assert.equal(manifest.scripts, undefined, "consumers need no install hooks");
	const run = (args) => exec(path.join(directory, "node_modules/.bin/shiplet"), args, options);
	assert.match((await run(["--help"])).stdout, /Shiplet CLI/);
	const npx = await exec("npm", ["exec", "--offline", ...npmFlags, "--", "shiplet-cli", "--help"], options);
	assert.match(npx.stdout, /shiplet login/);
	await writeFile(path.join(directory, "index.html"), "<!doctype html><h1>Packed CLI review</h1>");
	const prepared = await run(["prepare", "index.html", "--name", "Packed CLI review", "--subdomain", "packed-cli-review", "--dry-run", "--json"]);
	assert.match(prepared.stdout, /packed-cli-review/);
	assert.match(prepared.stdout, /index.html/);
	await assert.rejects(run(["not-a-command"]), (error) => error.code === 1 && /Unknown command/.test(error.stderr));
	const auth = await exec(process.execPath, ["--test-reporter=tap", path.join(root, "scripts/cli-subprocess.test.mjs"), path.join(installed, "lib/shiplet.cjs")], options);
	assert.match(auth.stdout, /# fail 0/);
	assert.match(auth.stdout, /# tests 2/);
});
