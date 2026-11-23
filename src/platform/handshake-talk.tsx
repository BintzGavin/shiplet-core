// A person talking in handshakes from the dashboard: join a live handshake
// from its page, or start one with any agent in your organization. The relay
// labels you as a person (kind "person"), named from your account.
//
// Rendered on the server with nothing joined yet; the tab's conversation (kept
// in sessionStorage by PersonChat) appears once the page hydrates.
import * as React from "react";

import { handshakeHref, peerAgent, type HandshakePeer } from "./handshake-model";
import { PersonChat, type ChatLine, type ChatPeer, type ChatState } from "./handshake-person";
import type { OrganizationRef } from "./work-apps";

const EMPTY: ChatState = { self: null, lines: [], error: null };

function usePersonChat(organizationId: string | null) {
	const [chat, setChat] = React.useState<PersonChat | null>(null);
	const [state, setState] = React.useState<ChatState>(EMPTY);
	React.useEffect(() => {
		if (!organizationId) return;
		const created = new PersonChat({ organizationId, app: "shiplet-dashboard" });
		setChat(created);
		setState(created.state);
		const unsubscribe = created.subscribe(setState);
		return () => {
			unsubscribe();
			created.dispose();
		};
	}, [organizationId]);
	return { chat, state };
}

const PERSON_NOTE =
	"You join as yourself, labelled as a person. Agents get your messages as information from a peer, not as instructions from their user, so they still ask their own user before anything that needs permission.";

// ---------------------------------------------------------------------------
// On a live handshake's page: say something to the agents in it.

export function HandshakeTalk(props: { handshakeId: string; organizationId: string; peers: HandshakePeer[] }) {
	const { chat, state } = usePersonChat(props.organizationId);
	const lines = state.lines.filter((line) => line.room === props.handshakeId);
	const recipients = props.peers.filter((peer) => peer.live && peer.id !== state.self?.id);
	const joined = Boolean(state.self && lines.length);
	return (
		<section className="success-card shiplet-panel handshake-talk" aria-labelledby="handshakeTalkTitle">
			<span className="success-card-label">{joined ? `You are in it as ${state.self?.name}` : "Join in"}</span>
			<h2 id="handshakeTalkTitle">Talk to the agents</h2>
			<p className="trace-hint">{PERSON_NOTE}</p>
			<ChatLines lines={lines} selfId={state.self?.id ?? null} />
			{recipients.length ? (
				<Composer
					idPrefix="handshakeTalk"
					recipients={recipients}
					disabled={!chat}
					error={state.error}
					onSend={(to, text) => chat?.send({ to, text, handshake: props.handshakeId }) ?? Promise.resolve(null)}
				/>
			) : (
				<p className="trace-hint">Nobody is connected to this handshake right now, so there is no one to talk to.</p>
			)}
			{state.self ? <LeaveButton chat={chat} /> : null}
		</section>
	);
}

// ---------------------------------------------------------------------------
// On the Handshakes page: start a handshake with any agent in an organization.

export function StartTalk(props: { organizations: OrganizationRef[] }) {
	const [organizationId, setOrganizationId] = React.useState(props.organizations[0]?.id ?? "");
	const { chat, state } = usePersonChat(organizationId || null);
	const [peers, setPeers] = React.useState<ChatPeer[] | null>(null);
	const [looking, setLooking] = React.useState(false);
	const [lookError, setLookError] = React.useState<string | null>(null);
	const [room, setRoom] = React.useState<string | null>(null);

	React.useEffect(() => {
		setPeers(null);
		setRoom(null);
	}, [organizationId]);

	async function look() {
		if (!chat) return;
		setLooking(true);
		setLookError(null);
		try {
			setPeers(await chat.peers());
		} catch (error) {
			setLookError(error instanceof Error ? error.message : "Could not list the agents.");
		} finally {
			setLooking(false);
		}
	}

	const lines = room ? state.lines.filter((line) => line.room === room) : state.lines.filter((line) => line.mine && line.state);
	if (!props.organizations.length) return null;
	return (
		<section className="success-card shiplet-panel handshake-talk" aria-labelledby="startTalkTitle">
			<span className="success-card-label">You can join too</span>
			<h2 id="startTalkTitle">Talk to an agent</h2>
			<p className="trace-hint">{PERSON_NOTE}</p>
			{props.organizations.length > 1 ? (
				<div className="form-group">
					<label htmlFor="startTalkOrganization">Organization</label>
					<select id="startTalkOrganization" value={organizationId} onChange={(event) => setOrganizationId(event.currentTarget.value)}>
						{props.organizations.map((organization) => (
							<option key={organization.id} value={organization.id}>
								{organization.name}
							</option>
						))}
					</select>
				</div>
			) : null}
			{peers === null ? (
				<div className="handshake-talk-actions">
					<button type="button" className="btn btn-secondary btn-sm" disabled={!chat || looking} aria-busy={looking || undefined} onClick={look}>
						See who is connected
					</button>
					<span className="form-help">Agents can see you once you look.</span>
				</div>
			) : peers.length ? (
				<>
					<ChatLines lines={lines} selfId={state.self?.id ?? null} />
					<Composer
						idPrefix="startTalk"
						recipients={peers}
						disabled={!chat}
						error={state.error}
						onSend={async (to, text) => {
							const handshake = (await chat?.send({ to, text, handshake: room })) ?? null;
							if (handshake) setRoom(handshake);
							return handshake;
						}}
					/>
					{room ? (
						<a className="work-link" href={handshakeHref(room)}>
							Open this handshake
						</a>
					) : null}
				</>
			) : (
				<p className="trace-hint">
					No agents are connected to this organization's relay right now.{" "}
					<button type="button" className="btn-link" onClick={look}>
						Look again
					</button>
				</p>
			)}
			{lookError ? (
				<p className="banner banner-error" role="alert">
					{lookError}
				</p>
			) : null}
			{state.self ? <LeaveButton chat={chat} onLeft={() => setPeers(null)} /> : null}
		</section>
	);
}

// ---------------------------------------------------------------------------

function ChatLines(props: { lines: ChatLine[]; selfId: string | null }) {
	if (!props.lines.length) return null;
	return (
		<ol className="handshake-messages handshake-talk-lines" aria-live="polite">
			{props.lines.map((line) => (
				<li key={line.id} className="handshake-message" data-peer-opened={line.mine ? undefined : "true"} data-line-state={line.state}>
					<div className="handshake-message-head">
						<strong>{line.mine ? "You" : line.from.name}</strong>
						<span className="work-meta">
							{line.mine ? `to ${line.to.name}` : `${peerAgent(line.from)}${line.from.kind === "person" ? "" : " · agent"}`}
							{line.state === "pending" ? " · sending" : ""}
						</span>
					</div>
					<p>{line.text}</p>
					{line.state === "failed" ? <p className="handshake-talk-failed">Not sent: {line.error}</p> : null}
				</li>
			))}
		</ol>
	);
}

function Composer(props: {
	idPrefix: string;
	recipients: Array<Pick<ChatPeer, "id" | "name" | "kind" | "app" | "machine">>;
	disabled: boolean;
	error: string | null;
	onSend: (to: string, text: string) => Promise<string | null>;
}) {
	const [to, setTo] = React.useState(props.recipients[0]?.id ?? "");
	const [text, setText] = React.useState("");
	const [sending, setSending] = React.useState(false);
	const recipient = props.recipients.find((peer) => peer.id === to) ?? props.recipients[0];

	async function submit(event?: React.FormEvent) {
		event?.preventDefault();
		if (!recipient || !text.trim() || sending) return;
		setSending(true);
		const draft = text;
		setText("");
		const sent = await props.onSend(recipient.id, draft);
		if (!sent) setText(draft);
		setSending(false);
	}

	return (
		<form className="handshake-talk-form" onSubmit={submit}>
			{props.recipients.length > 1 ? (
				<div className="form-group">
					<label htmlFor={`${props.idPrefix}To`}>To</label>
					<select id={`${props.idPrefix}To`} value={recipient?.id ?? ""} onChange={(event) => setTo(event.currentTarget.value)}>
						{props.recipients.map((peer) => (
							<option key={peer.id} value={peer.id}>
								{peer.name} · {peerAgent(peer)}
								{peer.machine ? ` on ${peer.machine}` : ""}
							</option>
						))}
					</select>
				</div>
			) : null}
			<div className="form-group">
				<label htmlFor={`${props.idPrefix}Text`}>
					Message {props.recipients.length === 1 && recipient ? `to ${recipient.name}` : ""}
				</label>
				<textarea
					id={`${props.idPrefix}Text`}
					rows={3}
					value={text}
					onChange={(event) => setText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
					}}
				/>
			</div>
			{props.error ? (
				<p className="banner banner-error" role="alert">
					{props.error}
				</p>
			) : null}
			<button type="submit" className="btn btn-primary btn-sm" disabled={props.disabled || sending || !text.trim()} aria-busy={sending || undefined}>
				Send
			</button>
		</form>
	);
}

function LeaveButton(props: { chat: PersonChat | null; onLeft?: () => void }) {
	return (
		<button
			type="button"
			className="btn-link handshake-talk-leave"
			onClick={async () => {
				await props.chat?.leave();
				props.onLeft?.();
			}}
		>
			Leave the relay
		</button>
	);
}
