#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wordpressRoot = path.join(root, "wordpress");
const outputDirectory = path.join(root, "dist");
const outputPath = path.join(
	outputDirectory,
	"shiplet-wordpress-0.1.0.zip",
);

await mkdir(outputDirectory, { recursive: true });
await rm(outputPath, { force: true });

await new Promise((resolve, reject) => {
	const child = spawn("zip", ["-qr", outputPath, "shiplet"], {
		cwd: wordpressRoot,
		stdio: "inherit",
	});
	child.on("error", reject);
	child.on("exit", (code) => {
		if (code === 0) resolve();
		else reject(new Error(`zip exited with status ${code}`));
	});
});

process.stdout.write(`${outputPath}\n`);
