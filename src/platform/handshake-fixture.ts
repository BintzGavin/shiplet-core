// SAMPLE handshakes. There is no hosted relay yet, so this is the only
// HandshakeSource. It runs the real handshake Hub from
// packages/agent-handshake in the Worker: sample agents register, open
// handshakes around the reader's own newest open request, and talk. The
// screens then read Hub#handshakes(), exactly what a relay would return.
// Every screen that shows these says they are sample data.
//
// It is enabled only by the "agent-handshakes" feature flag (see
// src/feature-flags.ts). Never enable it in production.
import { Hub } from "../../packages/agent-handshake/src/core/hub.js";
import type { HubConnection } from "../../packages/agent-handshake/src/core/hub.js";
import type { HandshakeSnapshot } from "../../packages/agent-handshake/src/core/protocol.js";
import type { HandshakeSource } from "./handshake-model";

export type FixtureRequestAnchor = {
	id: string;
	projectId: string;
	ticketLabel: string;
	comment: string;
	status: string;
};

const OPEN_FOR_WORK = new Set(["New", "In Progress", "Blocked"]);

export function createSampleHandshakeSource(input: { requests: FixtureRequestAnchor[]; now: Date }): HandshakeSource {
	let handshakes: Promise<HandshakeSnapshot[]> | null = null;
	return {
		kind: "sample",
		list() {
			handshakes ??= buildSampleHandshakes(input);
			return handshakes;
		},
	};
}

export async function buildSampleHandshakes(input: { requests: FixtureRequestAnchor[]; now: Date }): Promise<HandshakeSnapshot[]> {
	let clock = input.now.getTime();
	const at = (minutesAgo: number) => {
		clock = input.now.getTime() - minutesAgo * 60_000;
	};
	// Predictable ids, so a sample handshake keeps its URL between page loads.
	let count = 0;
	const hub = new Hub({
		now: () => new Date(clock),
		ids: (prefix) => `${prefix}_sample${String(++count).padStart(3, "0")}`,
	});
	const join = async (fields: Record<string, unknown>, minutesAgo: number) => {
		at(minutesAgo);
		const connection = hub.open();
		await connection.handle("register", fields);
		return connection;
	};
	const say = (from: HubConnection, minutesAgo: number, args: Record<string, unknown>) => {
		at(minutesAgo);
		return from.handle("send", args) as Promise<{ room: string }>;
	};

	const request = input.requests.find((candidate) => OPEN_FOR_WORK.has(candidate.status));

	// 1. Two agents splitting the work on the newest open request, recorded so
	// it can come back as a trace. A third joined to review and has left.
	const builder = await join({ name: "builder", kind: "claude", app: "claude-cli", machine: "studio-mbp" }, 15);
	const checker = await join({ name: "checker", kind: "codex", app: "codex-cli", machine: "ci-runner-04" }, 12);
	const reviewer = await join({ name: "a11y-review", kind: "other", app: "acme-review", machine: "review-pool-2" }, 9);
	const label = request?.ticketLabel ?? "the request";
	const opened = await say(builder, 14, {
		to: "checker",
		record: true,
		topic: request ? `${request.ticketLabel}: ${clip(request.comment, 72)}` : "Fix the checkout button contrast",
		request: request ? { shiplet: request.projectId, feedback: request.id, label: request.ticketLabel } : undefined,
		text: `Picking up ${label}. The annotation gives me the page, the element, a screenshot and the version it was left on. Can you run the checks on that version while I make the change?`,
	});
	const room = opened.room;
	await say(checker, 11, {
		to: "builder",
		room,
		text: "Yes. Baseline on the annotated version: the page spec passes, the contrast check fails on the element you were pointed at. Same as the screenshot.",
	});
	await say(builder, 9, {
		to: "a11y-review",
		room,
		text: `Can you look at the color change for ${label} before I publish? Proposed: darken the label to meet 4.5:1 and keep the brand hue.`,
	});
	await say(reviewer, 7, { to: "builder", room, text: "Looks right. 4.8:1 on the default background. Nothing else on the page changes." });
	reviewer.close();
	await say(builder, 4, { to: "checker", room, text: "Edit is in. Publishing a new version now. Rerun both checks on it?" });
	await say(checker, 1, { to: "builder", room, text: "Both pass on the new version. Export the handshake and share it to the Shiplet so the person who asked can read how we got there." });

	// 2. Two people's agents on different machines agreeing on an approach,
	// not opened for a request and not recorded: only who and how many show.
	const desk = await join({ name: "dana-desktop", kind: "claude", app: "claude-desktop", machine: "dana-mbp" }, 6);
	const lee = await join({ name: "lee-codex", kind: "codex", app: "codex-app", machine: "lee-workstation" }, 6);
	const side = await say(desk, 5, { to: "lee-codex", topic: "Agree on one retry policy for trace uploads", text: "Proposal: three retries with backoff." });
	await say(lee, 4, { to: "dana-desktop", room: side.room, text: "Agreed, cap at 30 s." });
	await say(desk, 2, { to: "lee-codex", room: side.room, text: "Writing it up." });

	return hub.handshakes();
}

function clip(text: string, length: number) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
