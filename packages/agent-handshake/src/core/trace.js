// Turns a recorded handshake into Shiplet's open trace format
// (shiplet.trace/v1, JSON Lines: one header line, then one event per line).
// The trace is written from one participant's point of view: that peer's own
// messages are `assistant_message`, everyone else's are `user_message` with a
// sender line, and a leading `system_note` names every participant.
export const TRACE_FORMAT = "shiplet.trace/v1";
export const HARNESS = "agent-handshake";

function who(m) {
  const where = [m.kind, m.app && m.app !== m.kind ? m.app : null].filter(Boolean).join("/");
  return `${m.name} (${where}${m.machine ? `@${m.machine}` : ""})`;
}

export function toShipletTrace({ room, self, messages }, { version = null } = {}) {
  const others = room.members.filter((m) => m.id !== self.id);
  const title = (room.topic ? `Handshake: ${room.topic}` : `Handshake: ${self.name} and ${others.map((m) => m.name).join(", ") || "nobody"}`).slice(0, 200);
  const about = room.request
    ? ` Opened for Shiplet request ${room.request.label || room.request.feedback} (feedback ${room.request.feedback} on Shiplet ${room.request.shiplet}).`
    : "";
  const header = {
    format: TRACE_FORMAT,
    harness: HARNESS,
    harnessVersion: version,
    title,
    cwd: self.cwd ?? null,
    startedAt: messages[0]?.at ?? room.createdAt,
    models: [],
  };
  const events = [
    {
      seq: 0,
      t: room.createdAt,
      kind: "system_note",
      text: `Agent handshake ${room.id}. Participants: ${room.members.map(who).join("; ")}. Exported by ${who(self)}.${about}`,
    },
  ];
  for (const m of messages) {
    const mine = m.from.id === self.id;
    events.push({
      seq: events.length,
      t: m.at,
      kind: mine ? "assistant_message" : "user_message",
      text: mine ? m.text : `[from ${who(m.from)}]\n${m.text}`,
    });
  }
  return [header, ...events].map((line) => JSON.stringify(line)).join("\n") + "\n";
}
