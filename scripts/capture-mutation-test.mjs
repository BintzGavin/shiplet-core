import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const records = await mkdtemp("/tmp/shiplet-capture-mutations-");
const route = ["npx", ["vitest", "run", "test/browser-capture.spec.ts"]];
const transfer = ["node", ["--test", "--test-name-pattern=capture transfer|host web pages", "scripts/browser-companion.test.mjs"]];
for (const [name, command] of [["route-baseline", route], ["transfer-baseline", transfer]]) {
  const result = spawnSync(command[0], command[1], { cwd: root, encoding: "utf8", timeout: 120000 });
  await writeFile(path.join(records, name + ".log"), (result.stdout || "") + (result.stderr || ""));
  if (result.status !== 0 || result.error) throw new Error(`${name} failed. See ${records}; mutations were not started.`);
}
const mutations = [
  ["confirmation", route, [["src/browser-capture.ts", "input.confirmed !== true", "false"]]],
  ["origin", route, [["src/index.ts", 'if (method !== "GET" && pathname === "/capture") return true;', 'if (method !== "GET" && pathname === "/capture") return false;'], ["src/index.ts", 'if (c.req.header("origin") !== new URL(c.req.url).origin) return c.text("Same-origin capture required", 403);', 'if (false) return c.text("Same-origin capture required", 403);']]],
  ["workspace-access", route, [["src/index.ts", "await requireOrganizationMembership(env.DB, organizationId, user.id);", "/* workspace authorization removed */"]]],
  ["pixel-bound", route, [["src/browser-capture.ts", "if (!width || !height || width > 16_384 || height > 16_384 || width * height > 20_000_000)", "if (false)"]]],
  ["source-privacy", route, [["src/browser-capture.ts", 'url.search = "";', '/* keep query */']]],
  ["destination-origin", transfer, [["browser-companion/background.js", "url.origin !== SHIPLET_ORIGIN || ", ""]]],
  ["destination-tab", transfer, [["browser-companion/background.js", "sender.tab?.id !== pending.destinationTabId || ", ""]]],
  ["expiry", transfer, [["browser-companion/background.js", "pending.expires <= Date.now()", "false"]]],
  ["replay", transfer, [["browser-companion/background.js", 'await chrome.storage.session.remove("pending");\n    return { ok: true, image: pending.image', '/* retained for replay */\n    return { ok: true, image: pending.image']]],
];
let killed = 0;
for (const [name, command, changes] of mutations) {
  const originals = new Map();
  try {
    for (const [file, from, to] of changes) {
      const absolute = path.join(root, file), content = await readFile(absolute, "utf8");
      if (!originals.has(absolute)) originals.set(absolute, content);
      if (!content.includes(from)) throw new Error(`Mutation ${name} no longer matches`);
      await writeFile(absolute, content.replace(from, to));
    }
    const result = spawnSync(command[0], command[1], { cwd: root, encoding: "utf8", timeout: 120000 });
    await writeFile(path.join(records, name + ".log"), (result.stdout || "") + (result.stderr || ""));
    if (result.status !== 0 && !result.error && /FAIL|not ok/.test((result.stdout || "") + (result.stderr || ""))) { killed++; console.log(`${name}: killed`); }
    else { console.log(`${name}: SURVIVED or did not complete`); process.exitCode = 1; }
  } finally { for (const [file, original] of originals) await writeFile(file, original); }
}
console.log(`${killed}/${mutations.length} mutations killed. Logs: ${records}`);
