#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { build } from "vite";

import { createPlatformClientBuildConfig } from "./platform-client-build-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedBundlePackages = new Set([
	"@tanstack/query-core",
	"@tanstack/react-query",
	"@tanstack/react-table",
	"@tanstack/table-core",
	"react",
	"react-dom",
	"scheduler",
	"zustand",
]);
const allowedLicenses = new Set([
	"0BSD",
	"Apache-2.0",
	"Apache-2.0 AND LGPL-3.0-or-later",
	"Apache-2.0 AND LGPL-3.0-or-later AND MIT",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"CC-BY-4.0",
	"CC0-1.0",
	"ISC",
	"LGPL-3.0-or-later",
	"MIT",
	"MIT OR Apache-2.0",
	"MPL-2.0",
	"Python-2.0",
	"Unlicense",
]);

function packageNameFromModule(id) {
	const marker = "/node_modules/";
	const markerIndex = id.lastIndexOf(marker);
	if (markerIndex < 0) return null;
	const segments = id.slice(markerIndex + marker.length).split("/");
	return segments[0].startsWith("@")
		? segments.slice(0, 2).join("/")
		: segments[0];
}

const observedBundlePackages = new Set();
const inventoryPlugin = () => ({
	name: "shiplet-platform-license-inventory",
	generateBundle(_options, bundle) {
		for (const chunk of Object.values(bundle)) {
			if (chunk.type !== "chunk") continue;
			for (const id of Object.keys(chunk.modules)) {
				const packageName = packageNameFromModule(id);
				if (packageName) observedBundlePackages.add(packageName);
			}
		}
	},
});

for (const entry of [
	"src/platform/shiplets-client.tsx",
	"src/platform/inbox-client.tsx",
	"src/platform/feedback-client.tsx",
]) {
	const config = createPlatformClientBuildConfig({
		entry: path.join(root, entry),
		fileName: "license-audit.js",
		outDir: path.join(root, ".shiplet-platform-client-license-audit"),
		plugins: [react(), inventoryPlugin()],
		root,
	});
	config.build.write = false;
	await build(config);
}

assert.deepEqual(
	[...observedBundlePackages].sort(),
	[...expectedBundlePackages].sort(),
	"generated browser dependency inventory changed; update notices deliberately",
);

const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
	if (!packagePath) continue;
	assert.equal(
		typeof metadata.license,
		"string",
		`${packagePath} is missing declared license metadata`,
	);
	assert.equal(
		allowedLicenses.has(metadata.license),
		true,
		`${packagePath} introduced an unreviewed license expression`,
	);
}

const notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
for (const packageName of expectedBundlePackages) {
	const metadata = lock.packages?.[`node_modules/${packageName}`];
	assert.ok(metadata?.version, `missing lock metadata for ${packageName}`);
	assert.match(
		notices,
		new RegExp(`${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*${metadata.version.replaceAll(".", "\\.")}`, "i"),
		`third-party notices are missing ${packageName} ${metadata.version}`,
	);
}

process.stdout.write(
	`Verified ${Object.keys(lock.packages ?? {}).length - 1} dependency licenses and ${observedBundlePackages.size} bundled browser packages.\n`,
);
