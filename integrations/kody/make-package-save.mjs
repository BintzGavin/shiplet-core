import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const [scope, output] = process.argv.slice(2);
if (!scope || !/^[a-z0-9][a-z0-9-]*$/.test(scope) || !output)
  throw new Error("Usage: node make-package-save.mjs account-scope /absolute/output.json");
const root = fileURLToPath(new URL("./shiplet/", import.meta.url));
const destination = resolve(output);
const relativeOutput = relative(resolve(root, "../../.."), destination);
if (!output.startsWith("/") || !(relativeOutput === ".." || relativeOutput.startsWith("../")))
  throw new Error("Choose an absolute output path outside the repository.");
const files = {};
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile())
      files[relative(root, path)] = (await readFile(path, "utf8")).replaceAll(
        "@your-account/shiplet",
        `@${scope}/shiplet`,
      );
  }
}
await walk(root);
await writeFile(destination, JSON.stringify({ files }, null, 2) + "\n", { flag: "wx" });
console.log(`Prepared ${Object.keys(files).length} source files for packageSave.`);
