import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

// Portable package format: https://developers.openai.com/plugins/build/plugins
// The remote Worker serves the tools and UI; the ZIP declares its connection.
const { values } = parseArgs({
	options: { origin: { type: "string" }, out: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
	console.log("Usage: npm run package:chatgpt-plugin -- --origin https://your-shiplet.example --out /path/to/shiplet.zip\nRequires zip on PATH. Does not deploy or submit the plugin.");
} else {
	if (!values.origin || !values.out) throw new Error("Provide --origin and --out; use --help for usage.");
	let origin;
	try { origin = new URL(values.origin); } catch { throw new Error("--origin must be an HTTPS origin."); }
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
		throw new Error("--origin must be an HTTPS origin without authentication, a path, query, or fragment.");
	}
	if (!values.out.endsWith(".zip")) throw new Error("--out must name a .zip file.");
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	const manifests = {
		"plugin.json": {
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name: "shiplet", version: pkg.version,
			description: "Publish pages for review and work through Shiplet feedback.",
			author: { name: "Shiplet" }, license: pkg.license,
			homepage: origin.origin,
			repository: "https://github.com/BintzGavin/shiplet-core",
		},
		"mcp.json": {
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: { shiplet: { type: "streamable-http", url: `${origin.origin}/api/plugin/mcp` } },
		},
	};
	const staging = await mkdtemp(path.join(os.tmpdir(), "shiplet-plugin-package-"));
	try {
		for (const [name, data] of Object.entries(manifests)) {
			await writeFile(path.join(staging, name), `${JSON.stringify(data, null, 2)}\n`);
		}
		// An allowlist keeps source code, local configuration, and unrelated files out.
		const archive = execFileSync("zip", ["-X", "-q", "-", "plugin.json", "mcp.json"], { cwd: staging });
		const output = path.resolve(values.out);
		await writeFile(output, archive, { flag: "wx" });
		console.log(`Created ${output}`);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
