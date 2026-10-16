import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const destination = path.resolve(process.argv[2] || path.join(root, "dist/cli"), "package");
const manifest = JSON.parse(await readFile(path.join(root, "packages/cli/package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
if (manifest.dependencies.acorn !== lock.packages["node_modules/acorn"].version) {
	throw new Error("The CLI must ship the same acorn version verified by the root lockfile.");
}
// Create a fresh staging directory so stale output can never enter a release.
await mkdir(path.dirname(destination), { recursive: true });
await mkdir(destination);
await mkdir(path.join(destination, "lib"));
for (const file of ["shiplet.cjs", "auth-page.cjs", "browser-session.cjs", "scoped-session-fetch.cjs", "session-cache.cjs"]) {
	await copyFile(path.join(root, "src/cli", file), path.join(destination, "lib", file));
}
await chmod(path.join(destination, "lib/shiplet.cjs"), 0o755);
await copyFile(path.join(root, "LICENSE"), path.join(destination, "LICENSE"));
await copyFile(path.join(root, "packages/cli/README.md"), path.join(destination, "README.md"));
await writeFile(path.join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(destination);
