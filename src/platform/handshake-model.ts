// Agent Handshakes: a live conversation between two or more agents (Claude
// Code, Codex, or any other), relayed through Shiplet. Nothing is stored by
// default. An agent in the handshake can record it and export it as a trace.
//
// The screens read the same shapes the handshake hub produces
// (packages/agent-handshake/src/core/protocol.d.ts): a HandshakeSnapshot per
// live handshake, with its members and, only when it is being recorded, its
// messages. A handshake that has ended is gone; if it was recorded and shared,
// it lives on as a trace with harness "agent-handshake".
//
// There is no hosted relay yet. The only HandshakeSource is the sample one in
// ./handshake-fixture.ts, which runs the real Hub. What the relay still needs
// is in packages/agent-handshake/README.md.
import type {
	HandshakeSnapshot,
	Message,
	PeerKind,
	Sender,
} from "../../packages/agent-handshake/src/core/protocol.js";

export type { HandshakeSnapshot, Message as HandshakeMessage };

// The harness slug an exported handshake carries in its trace header.
export const HANDSHAKE_TRACE_HARNESS = "agent-handshake";

export type HandshakePeer = Sender & {
	// Still connected to this handshake.
	live: boolean;
	// The peer that sent the first message.
	opened: boolean;
};

// The annotation a handshake was opened for, resolved against the requests
// the reader can see. A handshake naming an annotation the reader cannot see
// shows no request at all.
export type HandshakeRequestView = {
	feedbackId: string;
	projectId: string;
	ticketLabel: string;
	comment: string;
	shipletName: string;
};

export type HandshakeSummary = {
	id: string;
	topic: string;
	openedOn: string;
	lastMessageOn: string | null;
	messageCount: number;
	// Being recorded, so its messages can be exported as a trace.
	recording: boolean;
	peers: HandshakePeer[];
	request: HandshakeRequestView | null;
	// True for sample data that no agent produced.
	sample: boolean;
};

export type HandshakeDetail = HandshakeSummary & {
	// Null when the handshake is not recorded: the relay keeps no messages.
	messages: Message[] | null;
};

export interface HandshakeSource {
	// "sample" is the fixture; "relay" will be the hosted service.
	readonly kind: "sample" | "relay";
	// Every live handshake this reader may watch.
	list(): Promise<HandshakeSnapshot[]>;
}

export function toHandshakeDetail(
	snapshot: HandshakeSnapshot,
	options: { requests: Array<Omit<HandshakeRequestView, "feedbackId"> & { id: string }>; sample: boolean },
): HandshakeDetail {
	const ref = snapshot.request;
	const match = ref
		? options.requests.find((request) => request.id === ref.feedback && request.projectId === ref.shiplet)
		: undefined;
	const firstSender = snapshot.transcript?.[0]?.from.id ?? snapshot.members[0]?.id;
	return {
		id: snapshot.id,
		topic: snapshot.topic || defaultTopic(snapshot.members),
		openedOn: snapshot.createdAt,
		lastMessageOn: snapshot.lastMessageAt,
		messageCount: snapshot.messageCount,
		recording: snapshot.record,
		peers: snapshot.members.map((member) => ({ ...member, opened: member.id === firstSender })),
		request: match
			? {
					feedbackId: match.id,
					projectId: match.projectId,
					ticketLabel: match.ticketLabel,
					comment: match.comment,
					shipletName: match.shipletName,
				}
			: null,
		sample: options.sample,
		messages: snapshot.record ? (snapshot.transcript ?? []) : null,
	};
}

export function toHandshakeSummary(detail: HandshakeDetail): HandshakeSummary {
	const { messages: _messages, ...summary } = detail;
	return summary;
}

function defaultTopic(members: Sender[]) {
	const names = members.map((member) => member.name);
	return names.length ? `${names.join(" and ")}` : "Handshake";
}

const KIND_LABELS: Record<PeerKind, string> = { claude: "Claude Code", codex: "Codex", other: "Agent" };

// "Claude Code", "Codex", or the app an "other" agent named.
export function peerAgent(peer: Pick<Sender, "kind" | "app">) {
	if (peer.kind === "other") return peer.app && peer.app !== "other" ? peer.app : KIND_LABELS.other;
	return KIND_LABELS[peer.kind] ?? KIND_LABELS.other;
}

export function livePeers<T extends Pick<HandshakePeer, "live">>(handshake: { peers: T[] }) {
	return handshake.peers.filter((peer) => peer.live);
}

export function handshakesForRequest<T extends Pick<HandshakeSummary, "request">>(handshakes: T[], feedbackId: string) {
	return handshakes.filter((handshake) => handshake.request?.feedbackId === feedbackId);
}

export function handshakesForShiplet<T extends Pick<HandshakeSummary, "request">>(handshakes: T[], projectId: string) {
	return handshakes.filter((handshake) => handshake.request?.projectId === projectId);
}

export function isHandshakeTrace(trace: { harness: string }) {
	return trace.harness === HANDSHAKE_TRACE_HARNESS;
}

export function handshakeHref(handshakeId: string) {
	return `/handshakes/${encodeURIComponent(handshakeId)}`;
}

export const HANDSHAKE_DEFINITION =
	"A handshake is a live conversation between agents, relayed through Shiplet. Nothing is stored unless an agent in it records it and shares it as a trace.";
