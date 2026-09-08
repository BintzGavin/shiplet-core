import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

test("the downloadable archive is current, valid, bundled-only and limited to invoked tabs plus the Shiplet receiver", async () => {
  execFileSync("node", [new URL("./build-browser-companion.mjs", import.meta.url).pathname, "--check"]);
  const generated = await readFile(new URL("../src/generated-browser-companion.ts", import.meta.url), "utf8");
  const archive = JSON.parse(generated.match(/BROWSER_COMPANION_ZIP = ("[^"]+")/)[1]);
  const folder = await mkdtemp("/tmp/shiplet-companion-archive-");
  await writeFile(`${folder}/companion.zip`, Buffer.from(archive, "base64"));
  execFileSync("unzip", ["-t", `${folder}/companion.zip`]);
  const manifest = JSON.parse(execFileSync("unzip", ["-p", `${folder}/companion.zip`, "manifest.json"], { encoding: "utf8" }));
  assert.deepEqual(manifest.permissions, ["activeTab", "storage", "alarms"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://shiplet.cc/capture"]);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});

async function extension() {
  const state = {};
  let listener;
  const context = vm.createContext({ URL, Date, setTimeout, clearTimeout, crypto: globalThis.crypto, importScripts() {}, chrome: {
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: { async get(key) { return { [key]: state[key] }; }, async set(values) { Object.assign(state, values); }, async remove(key) { delete state[key]; } } },
    tabs: { onRemoved: { addListener() {} }, async create({ url }) { return { id: 42, url }; } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  } });
  for (const path of ["config.js", "background.js"]) vm.runInContext(await readFile(new URL(`../browser-companion/${path}`, import.meta.url), "utf8"), context);
  async function send(message, sender) { return await new Promise(resolve => listener(message, sender, resolve)); }
  return { state, send };
}

test("capture transfer is bound to the exact destination tab, origin, path, expiry and one consumption", async () => {
  const { state, send } = await extension();
  state.pending = { id: "fixture-capture", destinationTabId: 42, expires: Date.now() + 60000, image: "data:image/png;base64,fixture", sourceUrl: "https://example.com/" };
  const request = { type: "shiplet.capture.take", id: "fixture-capture" };
  const sender = { id: "fixture", tab: { id: 42 }, url: "https://shiplet.cc/capture#companion=fixture-capture", frameId: 0 };
  for (const invalid of [{ ...sender, tab: { id: 43 } }, { ...sender, url: "https://evil.example/capture" }, { ...sender, url: "https://shiplet.cc/other" }, { ...sender, frameId: 1 }, { ...sender, id: "another-extension" }]) {
    assert.equal((await send(request, invalid)).ok, false);
    assert.ok(state.pending);
  }
  assert.equal((await send({ ...request, id: "wrong" }, sender)).ok, false);
  const concurrent = await Promise.all([send(request, sender), send(request, sender)]);
  assert.equal(concurrent.filter(response => response.ok).length, 1);
  assert.equal(state.pending, undefined);
  state.pending = { id: "fixture-capture", destinationTabId: 42, expires: Date.now() - 1, image: "expired" };
  assert.equal((await send(request, sender)).ok, false);
  assert.equal(state.pending, undefined);
});

test("host web pages cannot initiate uploads or retrieve the local preview", async () => {
  const { state, send } = await extension();
  state.draft = { image: "local pixels", expires: Date.now() + 60000 };
  const host = { id: "fixture", tab: { id: 1 }, frameId: 0, url: "https://example.com/" };
  for (const type of ["shiplet.capture.preview", "shiplet.capture.share", "shiplet.capture.cancel"]) assert.equal((await send({ type }, host)).ok, false);
  assert.equal(state.draft.image, "local pixels");
});
