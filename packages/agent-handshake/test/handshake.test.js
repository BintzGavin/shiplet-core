// What a handshake carries beyond its messages: its topic, the Shiplet
// annotation it was opened for, the read-only view an observer (the Shiplet
// dashboard) gets, and the trace it exports to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../src/core/hub.js";
import { toShipletTrace } from "../src/core/trace.js";
// Shiplet's own trace reader, the one the Worker and the CLI use on upload.
import { detectFormat, normalize, parseJsonl } from "../../../src/cli/trace-core.mjs";

function counter() {
  let n = 0;
  return (prefix) => `${prefix}_${String(++n).padStart(3, "0")}`;
}

async function pair(opts = {}) {
  const hub = new Hub({ ids: counter(), now: () => new Date("2026-11-21T12:00:00.000Z"), ...opts });
  const a = hub.open();
  const b = hub.open();
  await a.handle("register", { name: "builder", kind: "claude", app: "claude-cli", machine: "studio" });
  await b.handle("register", { name: "checker", kind: "codex", app: "codex-cli", machine: "ci-04" });
  return { hub, a, b };
}

const REQUEST = { shiplet: "proj_checkout", feedback: "fb_12", label: "PF-12" };

test("a handshake keeps the topic and the annotation it was opened for", async () => {
  const { hub, a, b } = await pair();
  const sent = await a.handle("send", { to: "checker", text: "picking up PF-12", topic: "  Pay button   contrast ", request: REQUEST });
  await b.handle("send", { to: "builder", text: "on it", room: sent.room });
  const [handshake] = hub.handshakes();
  assert.equal(handshake.id, sent.room);
  assert.equal(handshake.topic, "Pay button contrast");
  assert.deepEqual(handshake.request, REQUEST);
  assert.equal(handshake.messageCount, 2);
  assert.equal(handshake.lastMessageAt, "2026-11-21T12:00:00.000Z");
});

test("ids can be made predictable", async () => {
  const { hub, a } = await pair();
  const sent = await a.handle("send", { to: "checker", text: "hi" });
  assert.match(sent.id, /^msg_\d{3}$/);
  assert.match(sent.room, /^hs_\d{3}$/);
  assert.deepEqual(hub.handshakes().map((h) => h.members.map((m) => m.id)), [["peer_003", "peer_004"]]);
});

test("a bad request reference or topic is refused", async () => {
  const { a } = await pair();
  await assert.rejects(a.handle("send", { to: "checker", text: "x", request: { shiplet: "p" } }), /request.feedback is required/);
  await assert.rejects(a.handle("send", { to: "checker", text: "x", request: { ...REQUEST, comment: "leak" } }), /unknown field "comment"/);
  await assert.rejects(a.handle("send", { to: "checker", text: "x", request: "fb_12" }), /request must be an object/);
  await assert.rejects(a.handle("send", { to: "checker", text: "x", topic: "t".repeat(201) }), /topic is longer/);
});

test("an observer sees no messages from an unrecorded handshake, only who and how many", async () => {
  const { hub, a } = await pair();
  await a.handle("send", { to: "checker", text: "secret plan" });
  const [handshake] = hub.handshakes();
  assert.equal(handshake.record, false);
  assert.equal(handshake.transcript, null);
  assert.equal(handshake.messageCount, 1);
  assert.equal(JSON.stringify(handshake).includes("secret plan"), false);
});

test("an observer sees a recorded handshake's messages and who has left", async () => {
  const { hub, a, b } = await pair();
  const third = hub.open();
  await third.handle("register", { name: "reviewer", kind: "other", app: "acme" });
  const sent = await a.handle("send", { to: "checker", text: "plan", record: true });
  await a.handle("send", { to: "reviewer", text: "can you look too?", room: sent.room });
  await b.handle("send", { to: "builder", text: "done", room: sent.room });
  third.close();
  const [handshake] = hub.handshakes();
  assert.deepEqual(handshake.transcript.map((m) => [m.from.name, m.to.name, m.text]), [
    ["builder", "checker", "plan"],
    ["builder", "reviewer", "can you look too?"],
    ["checker", "builder", "done"],
  ]);
  assert.deepEqual(handshake.members.map((m) => [m.name, m.live]), [["builder", true], ["checker", true], ["reviewer", false]]);
  a.close();
  b.close();
  assert.deepEqual(hub.handshakes(), [], "a handshake is gone once everyone has left");
});

test("an exported handshake reads back through Shiplet's own trace reader", async () => {
  const { a, b } = await pair();
  const sent = await a.handle("send", { to: "checker", text: "plan: fix the contrast", record: true, topic: "Pay button contrast", request: REQUEST });
  await b.handle("send", { to: "builder", text: "agreed", room: sent.room });
  const file = toShipletTrace(await a.handle("export", { room: sent.room }), { version: "0.1.0" });
  const main = parseJsonl(file);
  assert.equal(detectFormat(main.records), "shiplet");
  const normalized = await normalize({ format: "shiplet", main });
  assert.equal(normalized.harness, "agent-handshake");
  assert.equal(normalized.title, "Handshake: Pay button contrast");
  assert.deepEqual(normalized.events.map((e) => e.kind), ["system_note", "assistant_message", "user_message"]);
  assert.match(normalized.events[0].text, /Opened for Shiplet request PF-12 \(feedback fb_12 on Shiplet proj_checkout\)/);
  assert.match(normalized.events[2].text, /^\[from checker \(codex\/codex-cli@ci-04\)\]\nagreed$/);
});
