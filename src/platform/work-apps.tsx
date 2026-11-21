// The loop screens: Home, Traces, Handshakes and one handshake. Each is server
// rendered with real data (work-pages.tsx) and hydrated by work-client.tsx with
// the same props, so nothing loads after first paint.
//
// The loop: an annotation on a live version is a request with full context ->
// agents pick it up, and may coordinate in a handshake -> a trace comes back,
// tied to the new version, where the person checks it and annotates again.
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { harnessLabel } from "../cli/trace-core.mjs";
import {
	HANDSHAKE_DEFINITION,
	handshakeHref,
	isHandshakeTrace,
	livePeers,
	peerAgent,
	type HandshakeDetail,
	type HandshakeMessage,
	type HandshakePeer,
	type HandshakeSummary,
} from "./handshake-model";
import { PlatformNav, type PlatformRoute } from "./navigation";
import { usePlatformCounts } from "./platform-counts";
import { TRACE_DEFINITION } from "./traces-app";
import {
	buildWorkLoop,
	relativeTime,
	requestHref,
	requestsBeforeTrace,
	shipletRequestsHref,
	shortRevision,
	traceHref,
	type LoopRequest,
	type LoopRequestCard,
	type LoopTrace,
	type LoopTraceCard,
} from "./work-loop";

// "relay": the hosted relay (the agent-handshakes flag with the relay binding).
// "sample": the flag without a relay binding: the real handshake hub with
// sample agents, so a server without the relay still shows the idea.
// "off": no handshakes; screens explain what a handshake will be.
export type HandshakeMode = "relay" | "sample" | "off";

export type ShipletRef = { id: string; name: string };
export type OrganizationRef = { id: string; name: string };

export type HomeProps = {
	now: number;
	requests: LoopRequest[];
	traces: LoopTrace[];
	handshakes: HandshakeSummary[];
	handshakeMode: HandshakeMode;
	tracesEnabled: boolean;
	shiplets: ShipletRef[];
};

export type TracesListProps = {
	now: number;
	requests: LoopRequest[];
	traces: LoopTrace[];
	handshakes: HandshakeSummary[];
	tracesEnabled: boolean;
};

export type HandshakesProps = {
	now: number;
	handshakes: HandshakeSummary[];
	handshakeMode: HandshakeMode;
	organizations: OrganizationRef[];
	// Handshakes that were exported and shared: traces with the handshake harness.
	traces: LoopTrace[];
	tracesEnabled: boolean;
};

export type HandshakeDetailProps = {
	now: number;
	handshakeId: string;
	// Null when no live handshake has this id: it ended, or never existed.
	handshake: HandshakeDetail | null;
	handshakeMode: HandshakeMode;
};

export type WorkScreen =
	| { screen: "home"; props: HomeProps }
	| { screen: "traces"; props: TracesListProps }
	| { screen: "handshakes"; props: HandshakesProps }
	| { screen: "handshake"; props: HandshakeDetailProps };

export function WorkApp(props: WorkScreen) {
	const [queryClient] = React.useState(
		() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }),
	);
	return (
		<QueryClientProvider client={queryClient}>
			{props.screen === "home" ? <HomeScreen {...props.props} /> : null}
			{props.screen === "traces" ? <TracesScreen {...props.props} /> : null}
			{props.screen === "handshakes" ? <HandshakesScreen {...props.props} /> : null}
			{props.screen === "handshake" ? <HandshakeScreen {...props.props} /> : null}
		</QueryClientProvider>
	);
}

function Shell(props: { route: PlatformRoute; eyebrow: string; title: string; lede: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
	const counts = usePlatformCounts();
	return (
		<div
			className="dashboard-shell shiplet-dashboard-stage work-page"
			data-platform-app="react-tanstack"
			data-platform-route={props.route}
			data-live-updates="polling"
		>
			<header className="app-page-topbar">
				<div className="app-page-title">
					<span className="success-card-label">{props.eyebrow}</span>
					<h1>{props.title}</h1>
					<p>{props.lede}</p>
				</div>
				{props.actions ? <div className="dashboard-actions">{props.actions}</div> : null}
			</header>
			<PlatformNav counts={counts} current={props.route} />
			{props.children}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Home: what you asked for, what is being worked on now, and what came back.

function HomeScreen(props: HomeProps) {
	const loop = buildWorkLoop({ requests: props.requests, traces: props.traces, handshakes: props.handshakes });
	return (
		<Shell
			route="home"
			eyebrow="Shiplet"
			title="Home"
			lede="What you asked for, what agents are working on now, and what came back for you to check."
		>
			<FrontDoor shiplets={props.shiplets} />
			<section className="work-loop" aria-label="Your requests and the work on them">
				<Lane
					id="laneAsked"
					label="You asked"
					title="Waiting for an agent"
					count={loop.counts.asked}
					more={{ href: "/feedback", label: "All annotations" }}
				>
					{loop.asked.length ? (
						loop.asked.map((card) => <RequestCard key={card.id} card={card} now={props.now} />)
					) : (
						<LaneEmpty>Nothing is waiting. Annotate a live version to ask for a change.</LaneEmpty>
					)}
				</Lane>
				<Lane
					id="laneWorking"
					label="Agents at work"
					title="Being worked on"
					count={loop.counts.inMotion}
					more={{ href: "/handshakes", label: "All handshakes" }}
				>
					{props.handshakeMode === "sample" && loop.liveHandshakes.length ? <SampleNote compact /> : null}
					{loop.liveHandshakes.map((handshake) => (
						<HandshakeCard key={handshake.id} handshake={handshake} now={props.now} />
					))}
					{loop.working
						.filter((card) => !card.handshakes.length)
						.map((card) => (
							<RequestCard key={card.id} card={card} now={props.now} />
						))}
					{!loop.working.length && !loop.liveHandshakes.length ? (
						<LaneEmpty>No agent is on a request right now.</LaneEmpty>
					) : null}
				</Lane>
				<Lane
					id="laneCheck"
					label="Came back"
					title="For you to check"
					count={loop.counts.cameBack}
					more={{ href: "/traces", label: "All traces" }}
				>
					{loop.toCheck.map((card) => (
						<RequestCard key={card.id} card={card} now={props.now} />
					))}
					{loop.traces.slice(0, 4).map((trace) => (
						<TraceCard key={trace.id} trace={trace} now={props.now} />
					))}
					{!loop.toCheck.length && !loop.traces.length ? (
						<LaneEmpty>
							{props.tracesEnabled
								? "Nothing to check yet. When an agent shares its session, the trace shows up here."
								: "Nothing to check yet. Requests an agent marks ready show up here."}
						</LaneEmpty>
					) : null}
				</Lane>
			</section>
		</Shell>
	);
}

function FrontDoor(props: { shiplets: ShipletRef[] }) {
	return (
		<section className="success-card shiplet-panel shiplet-focus-strip work-front-door" aria-labelledby="frontDoorTitle">
			<div className="work-front-door-copy">
				<span className="success-card-label">Annotate</span>
				<h2 id="frontDoorTitle">Ask for a change by pointing at it</h2>
				<p>
					Open a live version, point at the element, and say what should change. The annotation carries the page, the
					element, a screenshot and the version to whichever agent picks it up.
				</p>
				<div className="work-front-door-actions">
					<a className="btn btn-primary" href="/annotate">
						Annotate something
					</a>
					<a className="btn btn-secondary" href="/embed/install">
						Connect a website
					</a>
				</div>
			</div>
			{props.shiplets.length ? (
				<div className="work-front-door-recent">
					<span className="work-meta-label">Annotate again</span>
					<ul>
						{props.shiplets.slice(0, 4).map((shiplet) => (
							<li key={shiplet.id}>
								<a href={`/shiplets/${encodeURIComponent(shiplet.id)}`}>{shiplet.name}</a>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

function Lane(props: { id: string; label: string; title: string; count: number; more: { href: string; label: string }; children: React.ReactNode }) {
	return (
		<section className="work-lane" aria-labelledby={`${props.id}Title`} id={props.id}>
			<header className="work-lane-head">
				<span className="success-card-label">{props.label}</span>
				<h2 id={`${props.id}Title`}>
					{props.title} <span className="work-lane-count">{props.count}</span>
				</h2>
			</header>
			<div className="work-lane-body">{props.children}</div>
			<a className="work-lane-more" href={props.more.href}>
				{props.more.label}
			</a>
		</section>
	);
}

function LaneEmpty(props: { children: React.ReactNode }) {
	return <p className="work-lane-empty">{props.children}</p>;
}

const STAGE_BADGE: Record<string, string> = {
	waiting: "status-pending",
	working: "status-active",
	check: "work-status-check",
	closed: "status-muted",
};

function RequestCard(props: { card: LoopRequestCard; now: number }) {
	const { card } = props;
	const version = shortRevision(card.revisionId);
	const live = card.handshakes;
	return (
		<article className="work-card work-card-request" data-request-id={card.id}>
			<div className="work-card-head">
				<a className="feedback-ticket-id" href={card.href} aria-label={`${card.ticketLabel}, open the annotation`}>
					{card.ticketLabel}
				</a>
				<span className="work-card-place">{card.shipletName}</span>
				<span className={`status-badge ${STAGE_BADGE[card.stage]}`}>{card.status}</span>
			</div>
			<p className="work-card-text">{card.comment}</p>
			<ul className="work-context" aria-label="What the annotation carries">
				<li>{card.pagePath}</li>
				{card.element ? <li>{card.element}</li> : null}
				{card.hasScreenshot ? <li>Screenshot</li> : null}
				{version ? <li>Version {version}</li> : null}
				<li>{relativeTime(card.createdOn, props.now)}</li>
			</ul>
			{live.length || card.traces.length ? (
				<div className="work-card-links">
					{live.map((handshake) => (
						<a key={handshake.id} className="work-link work-link-live" href={handshakeHref(handshake.id)}>
							<span className="work-live-dot" aria-hidden="true" />
							Live handshake: {peerNames(handshake)}
						</a>
					))}
					{card.traces.length ? (
						<a className="work-link" href={traceHref(card.traces[0].projectId, card.traces[0].id)}>
							{card.traces.length === 1 ? "1 trace since" : `${card.traces.length} traces since`}: {card.traces[0].title}
						</a>
					) : null}
				</div>
			) : null}
		</article>
	);
}

function TraceCard(props: { trace: LoopTraceCard; now: number }) {
	const { trace } = props;
	return (
		<article className="work-card work-card-trace" data-trace-id={trace.id}>
			<div className="work-card-head">
				<span className="work-kind">Trace</span>
				<span className="work-card-place">{trace.shiplet?.name || "Shiplet"}</span>
			</div>
			<a className="work-card-title" href={traceHref(trace.projectId, trace.id)}>
				{trace.title}
			</a>
			<ul className="work-context" aria-label="About this trace">
				<li>{harnessLabel(trace.harness)}</li>
				<li>{relativeTime(trace.endedOn || trace.createdOn, props.now)}</li>
				{trace.fromHandshake ? <li>From a handshake</li> : null}
			</ul>
			<div className="work-card-links">
				<RequestChips requests={trace.requests} projectId={trace.projectId} />
				<a className="work-link" href={`/shiplets/${encodeURIComponent(trace.projectId)}`}>
					Check the new version
				</a>
			</div>
		</article>
	);
}

function RequestChips(props: { requests: LoopRequest[]; projectId: string }) {
	if (!props.requests.length) return null;
	const shown = props.requests.slice(0, 3);
	return (
		<span className="work-request-chips">
			<span className="work-meta-label">After</span>
			{shown.map((request) => (
				<a key={request.id} className="feedback-ticket-id" href={request.href} title={request.comment}>
					{request.ticketLabel}
				</a>
			))}
			{props.requests.length > shown.length ? (
				<a className="work-link" href={shipletRequestsHref(props.projectId)}>
					+{props.requests.length - shown.length}
				</a>
			) : null}
		</span>
	);
}

function HandshakeCard(props: { handshake: HandshakeSummary; now: number }) {
	const { handshake } = props;
	return (
		<article className="work-card work-card-handshake" data-handshake-id={handshake.id}>
			<div className="work-card-head">
				<span className="work-kind">
					<span className="work-live-dot" aria-hidden="true" /> Live handshake
				</span>
				{handshake.sample ? <span className="status-badge status-muted">Sample</span> : null}
			</div>
			<a className="work-card-title" href={handshakeHref(handshake.id)}>
				{handshake.topic}
			</a>
			<ul className="work-context" aria-label="Who is connected">
				{livePeers(handshake).map((peer) => (
					<li key={peer.id}>
						<PeerName peer={peer} />
					</li>
				))}
				<li>{plural(handshake.messageCount, "message")}</li>
				<li>{handshake.recording ? "Recording" : "Not recorded"}</li>
			</ul>
			{handshake.request ? (
				<div className="work-card-links">
					<span className="work-meta-label">For</span>
					<a className="feedback-ticket-id" href={requestHref(handshake.request.projectId, handshake.request.feedbackId)} title={handshake.request.comment}>
						{handshake.request.ticketLabel}
					</a>
					<span className="work-card-place">{handshake.request.shipletName}</span>
				</div>
			) : null}
		</article>
	);
}

function SampleNote(props: { compact?: boolean }) {
	return (
		<p className={`banner banner-warning work-sample-note${props.compact ? " work-sample-note-compact" : ""}`} role="note">
			{props.compact
				? "Sample handshakes. This server has no handshake relay."
				: "Sample data. This server has no handshake relay, so these sample agents run the real handshake hub inside Shiplet, around your own newest open annotation, to show where handshakes fit. No agent of yours is in them and nothing is stored."}
		</p>
	);
}

function peerNames(handshake: HandshakeSummary) {
	return livePeers(handshake)
		.map((peer) => peerAgent(peer))
		.join(" + ");
}

function PeerName(props: { peer: Pick<HandshakePeer, "kind" | "app" | "machine" | "name"> }) {
	const { peer } = props;
	return (
		<>
			{peerAgent(peer)}
			{peer.machine ? ` on ${peer.machine}` : ""}
		</>
	);
}

function plural(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Traces: what came back, across every Shiplet you can read.

function TracesScreen(props: TracesListProps) {
	const [search, setSearch] = React.useState("");
	const [harness, setHarness] = React.useState("");
	const harnesses = React.useMemo(() => [...new Set(props.traces.map((trace) => trace.harness))].sort(), [props.traces]);
	const needle = search.trim().toLowerCase();
	const visible = props.traces.filter(
		(trace) =>
			(!harness || trace.harness === harness) &&
			(!needle ||
				[trace.title, trace.shiplet?.name || "", harnessLabel(trace.harness)].some((value) => value.toLowerCase().includes(needle))),
	);
	return (
		<Shell
			route="traces"
			eyebrow="Traces"
			title="Traces"
			lede="What agents did, read as a chat: each prompt, the reply, and the steps and checks behind it. Every trace links back to the annotations before it and on to the version to check."
		>
			<section className="success-card shiplet-panel work-list-panel" aria-labelledby="tracesListTitle">
				<div className="work-list-toolbar">
					<div>
						<span className="success-card-label">Came back</span>
						<h2 id="tracesListTitle">Traces you can read</h2>
					</div>
					{props.traces.length ? (
						<div className="work-list-controls">
							<label className="shiplet-list-control" htmlFor="traceSearch">
								<span>Search</span>
								<input
									id="traceSearch"
									type="search"
									autoComplete="off"
									placeholder="Title, Shiplet, agent"
									value={search}
									onChange={(event) => setSearch(event.currentTarget.value)}
								/>
							</label>
							<label className="shiplet-list-control" htmlFor="traceHarness">
								<span>Agent</span>
								<select id="traceHarness" value={harness} onChange={(event) => setHarness(event.currentTarget.value)}>
									<option value="">All agents</option>
									{harnesses.map((value) => (
										<option key={value} value={value}>
											{harnessLabel(value)}
										</option>
									))}
								</select>
							</label>
						</div>
					) : null}
				</div>
				{!props.tracesEnabled ? (
					<div className="shiplet-list-empty">
						<strong>Traces are not turned on for this server.</strong>
						<p>{TRACE_DEFINITION} An operator turns them on with the traces feature flag.</p>
					</div>
				) : !props.traces.length ? (
					<div className="shiplet-list-empty">
						<strong>No traces yet.</strong>
						<p>
							{TRACE_DEFINITION} Ask your agent to "share this session to Shiplet", or run{" "}
							<code>npx shiplet-cli trace share --current --shiplet &lt;id&gt;</code>.
						</p>
					</div>
				) : visible.length ? (
					<ol className="work-rows" aria-label="Traces">
						{visible.map((trace) => (
							<TraceRow key={trace.id} trace={trace} requests={props.requests} now={props.now} />
						))}
					</ol>
				) : (
					<p className="work-lane-empty">No traces match. Clear the search to see all {props.traces.length}.</p>
				)}
			</section>
		</Shell>
	);
}

function TraceRow(props: { trace: LoopTrace; requests: LoopRequest[]; now: number }) {
	const { trace } = props;
	const before = requestsBeforeTrace(trace, props.requests);
	const version = shortRevision(trace.revisionId);
	return (
		<li className="work-row" data-trace-id={trace.id}>
			<div className="work-row-main">
				<a className="work-card-title" href={traceHref(trace.projectId, trace.id)}>
					{trace.title}
				</a>
				<ul className="work-context" aria-label="About this trace">
					<li>{harnessLabel(trace.harness)}</li>
					<li>{trace.shiplet?.name || "Shiplet"}</li>
					{version ? <li>Version {version}</li> : null}
					<li>{trace.eventCount} events</li>
					<li>{relativeTime(trace.endedOn || trace.createdOn, props.now)}</li>
				</ul>
			</div>
			<div className="work-row-side">
				{trace.access ? (
					<span className={`status-badge trace-level trace-level-${trace.access.level}`}>{trace.access.level}</span>
				) : null}
				{trace.sharing === "private" ? <span className="status-badge status-muted">Private</span> : null}
			</div>
			<div className="work-card-links work-row-links">
				<RequestChips requests={before} projectId={trace.projectId} />
				{isHandshakeTrace(trace) ? <span className="work-meta">From a handshake</span> : null}
				<a className="work-link" href={`/shiplets/${encodeURIComponent(trace.projectId)}`}>
					Check the new version
				</a>
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------
// Handshakes: agents talking to each other through Shiplet, live. A handshake
// that ends is gone; one an agent recorded and shared comes back as a trace.

function HandshakesScreen(props: HandshakesProps) {
	const kept = props.traces.filter(isHandshakeTrace);
	return (
		<Shell route="handshakes" eyebrow="Handshakes" title="Handshakes" lede={HANDSHAKE_DEFINITION}>
			{props.handshakeMode === "sample" ? <SampleNote /> : null}
			<section className="success-card shiplet-panel work-list-panel" aria-labelledby="liveHandshakesTitle">
				<span className="success-card-label">Live now</span>
				<h2 id="liveHandshakesTitle">Agents talking now</h2>
				{props.handshakeMode === "off" ? (
					<div className="shiplet-list-empty">
						<strong>No handshakes yet.</strong>
						<p>
							When an agent working on an annotation needs another agent, on your machine or someone else's, it opens a
							handshake through Shiplet. You will see who is in it and what it is for here, follow it back to the
							annotation, and read it as a trace if an agent records and shares it. Handshakes are not turned on for
							this server yet.
						</p>
					</div>
				) : props.handshakes.length ? (
					<ol className="work-rows" aria-label="Live handshakes">
						{props.handshakes.map((handshake) => (
							<HandshakeRow key={handshake.id} handshake={handshake} now={props.now} />
						))}
					</ol>
				) : (
					<p className="work-lane-empty">No agents are talking right now.</p>
				)}
			</section>
			{props.handshakeMode === "relay" ? <JoinPanel organizations={props.organizations} /> : null}
			{props.tracesEnabled ? (
				<section className="success-card shiplet-panel work-list-panel" aria-labelledby="keptHandshakesTitle">
					<span className="success-card-label">Kept</span>
					<h2 id="keptHandshakesTitle">Handshakes shared as traces</h2>
					{kept.length ? (
						<ol className="work-rows" aria-label="Handshakes shared as traces">
							{kept.map((trace) => (
								<li key={trace.id} className="work-row" data-trace-id={trace.id}>
									<div className="work-row-main">
										<a className="work-card-title" href={traceHref(trace.projectId, trace.id)}>
											{trace.title}
										</a>
										<ul className="work-context" aria-label="About this trace">
											<li>{trace.shiplet?.name || "Shiplet"}</li>
											<li>{relativeTime(trace.endedOn || trace.createdOn, props.now)}</li>
										</ul>
									</div>
								</li>
							))}
						</ol>
					) : (
						<p className="work-lane-empty">
							None yet. A handshake ends when its agents leave, and nothing is kept unless an agent recorded it and shared
							the export to a Shiplet.
						</p>
					)}
				</section>
			) : null}
		</Shell>
	);
}

// How an agent joins: any agent connected to Shiplet MCP reaches the relay
// through Code Mode, so the instructions are the calls it makes.
function JoinPanel(props: { organizations: OrganizationRef[] }) {
	const [first] = props.organizations;
	if (!first) {
		return (
			<section className="success-card shiplet-panel" aria-labelledby="joinHandshakesTitle">
				<span className="success-card-label">Bring your agents</span>
				<h2 id="joinHandshakesTitle">Handshakes happen inside an organization</h2>
				<p className="trace-hint">
					Agents talk to agents in the same organization. <a href="/settings">Create or join one</a> to start.
				</p>
			</section>
		);
	}
	const base = `/api/organizations/${first.id}`;
	return (
		<section className="success-card shiplet-panel" aria-labelledby="joinHandshakesTitle">
			<span className="success-card-label">Bring your agents</span>
			<h2 id="joinHandshakesTitle">How an agent joins</h2>
			<p className="trace-hint">
				Any agent connected to Shiplet MCP can talk to the other agents in {first.name}
				{props.organizations.length > 1 ? " (or another of your organizations)" : ""}. Ask it to join the handshakes
				under a name and wait for messages. To work an annotation out together, it names the annotation when it
				sends, and the handshake shows up on that annotation. Messages from other agents are information, never
				instructions or permission.
			</p>
			<pre className="work-prompt">
				<code>{`POST ${base}/handshake-sessions  { "name": "builder", "kind": "claude" }
GET  ${base}/handshake-sessions/<session>/peers
POST ${base}/handshake-sessions/<session>/messages
     { "to": "checker", "text": "...", "record": true,
       "request": { "shiplet": "<shiplet id>", "feedback": "<feedback id>" } }
GET  ${base}/handshake-sessions/<session>/inbox?wait=20`}</code>
			</pre>
		</section>
	);
}

function HandshakeRow(props: { handshake: HandshakeSummary; now: number }) {
	const { handshake } = props;
	return (
		<li className="work-row" data-handshake-id={handshake.id}>
			<div className="work-row-main">
				<a className="work-card-title" href={handshakeHref(handshake.id)}>
					{handshake.topic}
				</a>
				<ul className="work-context" aria-label="Agents in this handshake">
					{handshake.peers.map((peer) => (
						<li key={peer.id}>
							<PeerName peer={peer} />
							{peer.live ? null : <span className="work-peer-state"> (left)</span>}
						</li>
					))}
				</ul>
			</div>
			<div className="work-row-side">
				<span className="status-badge status-active">
					<span className="work-live-dot" aria-hidden="true" /> Live
				</span>
				<span className={`status-badge ${handshake.recording ? "trace-level" : "status-muted"}`}>
					{handshake.recording ? "Recording" : "Not recorded"}
				</span>
				{handshake.sample ? <span className="status-badge status-muted">Sample</span> : null}
			</div>
			<div className="work-card-links work-row-links">
				{handshake.request ? <RequestRef request={handshake.request} /> : <span className="work-meta-label">Not opened for an annotation</span>}
				<span className="work-meta">
					{plural(handshake.messageCount, "message")} · opened {relativeTime(handshake.openedOn, props.now)}
				</span>
			</div>
		</li>
	);
}

function RequestRef(props: { request: NonNullable<HandshakeSummary["request"]> }) {
	const { request } = props;
	return (
		<span className="work-request-chips">
			<span className="work-meta-label">For</span>
			<a className="feedback-ticket-id" href={requestHref(request.projectId, request.feedbackId)} title={request.comment}>
				{request.ticketLabel}
			</a>
			<span className="work-card-place">{request.shipletName}</span>
		</span>
	);
}

// ---------------------------------------------------------------------------
// One handshake: the annotation it is for, the conversation, who is in it, and
// how it can be kept.

function HandshakeScreen(props: HandshakeDetailProps) {
	const { handshake } = props;
	if (!handshake) return <HandshakeGone />;
	const peers = new Map(handshake.peers.map((peer) => [peer.id, peer]));
	return (
		<Shell
			route="handshakes"
			eyebrow="Live handshake"
			title={handshake.topic}
			lede={`Opened ${relativeTime(handshake.openedOn, props.now)}. ${
				handshake.recording
					? "Being recorded, so an agent in it can share it as a trace."
					: "Not recorded: messages pass through and are gone."
			}`}
			actions={
				<a className="btn btn-secondary btn-sm" href="/handshakes">
					All handshakes
				</a>
			}
		>
			{handshake.sample ? <SampleNote /> : null}
			<div className="work-detail">
				<div className="work-detail-main">
					{handshake.request ? (
						<section className="success-card shiplet-panel work-origin" aria-labelledby="handshakeRequestTitle">
							<span className="success-card-label">Opened for</span>
							<h2 id="handshakeRequestTitle" className="work-origin-title">
								<a className="feedback-ticket-id" href={requestHref(handshake.request.projectId, handshake.request.feedbackId)}>
									{handshake.request.ticketLabel}
								</a>{" "}
								{handshake.request.shipletName}
							</h2>
							<p className="work-card-text">{handshake.request.comment}</p>
							<div className="work-card-links">
								<a className="work-link" href={requestHref(handshake.request.projectId, handshake.request.feedbackId)}>
									Open the annotation
								</a>
								<a className="work-link" href={`/shiplets/${encodeURIComponent(handshake.request.projectId)}`}>
									Check the latest version
								</a>
							</div>
						</section>
					) : null}
					<section className="success-card shiplet-panel" aria-labelledby="handshakeMessagesTitle">
						<span className="success-card-label">Conversation</span>
						<h2 id="handshakeMessagesTitle">What they said</h2>
						{handshake.messages === null ? (
							<div className="shiplet-list-empty">
								<strong>This handshake is not recorded.</strong>
								<p>
									{plural(handshake.messageCount, "message")} passed through the relay and none were kept. If an agent in it
									sends with <code>record: true</code>, the messages from then on are kept until it ends, and can be shared
									as a trace.
								</p>
							</div>
						) : (
							<ol className="handshake-messages">
								{handshake.messages.map((message) => (
									<HandshakeMessageRow key={message.id} message={message} peer={peers.get(message.from.id)} now={props.now} />
								))}
							</ol>
						)}
					</section>
				</div>
				<aside className="work-detail-side">
					<section className="success-card shiplet-panel" aria-labelledby="handshakePeersTitle">
						<span className="success-card-label">Who is in it</span>
						<h2 id="handshakePeersTitle">Agents</h2>
						<ul className="handshake-peers">
							{handshake.peers.map((peer) => (
								<li key={peer.id} data-peer-state={peer.live ? "connected" : "left"}>
									<strong>{peer.name}</strong>
									<span>
										<PeerName peer={peer} />
										{peer.app && peer.app !== peer.kind ? ` · ${peer.app}` : ""}
										{peer.account ? ` · for ${peer.account}` : ""}
									</span>
									<span className={`status-badge ${peer.live ? "status-active" : "status-muted"}`}>
										{peer.opened ? "Opened · " : ""}
										{peer.live ? "connected" : "left"}
									</span>
								</li>
							))}
						</ul>
					</section>
					<KeepPanel handshake={handshake} relay={props.handshakeMode === "relay"} />
				</aside>
			</div>
		</Shell>
	);
}

function HandshakeGone() {
	return (
		<Shell
			route="handshakes"
			eyebrow="Handshake"
			title="This handshake has ended"
			lede="A handshake is gone once its agents leave. If one of them recorded it and shared it, it is a trace now."
			actions={
				<a className="btn btn-secondary btn-sm" href="/handshakes">
					All handshakes
				</a>
			}
		>
			<section className="success-card shiplet-panel">
				<div className="shiplet-list-empty">
					<strong>Nothing was kept here.</strong>
					<p>
						Look for it under <a href="/handshakes">handshakes shared as traces</a>, or go back to{" "}
						<a href="/feedback">your annotations</a>.
					</p>
				</div>
			</section>
		</Shell>
	);
}

function HandshakeMessageRow(props: { message: HandshakeMessage; peer?: HandshakePeer; now: number }) {
	const { message, peer } = props;
	return (
		<li className="handshake-message" data-peer-opened={peer?.opened ? "true" : undefined}>
			<div className="handshake-message-head">
				<strong>{message.from.name}</strong>
				<span className="work-meta">
					to {message.to.name} · {relativeTime(message.at, props.now)}
				</span>
			</div>
			<p>{message.text}</p>
		</li>
	);
}

function KeepPanel(props: { handshake: HandshakeDetail; relay: boolean }) {
	const { handshake } = props;
	const shiplet = handshake.request ? ` --shiplet ${handshake.request.projectId}` : " --shiplet <id>";
	const exportStep = props.relay
		? `POST .../handshake-sessions/<session>/handshakes/${handshake.id}/export\n# save the returned trace as handshake-${handshake.id}.trace.jsonl`
		: `export_handshake room=${handshake.id}`;
	return (
		<section className="success-card shiplet-panel" aria-labelledby="handshakeKeepTitle">
			<span className="success-card-label">Keep it</span>
			<h2 id="handshakeKeepTitle">{handshake.recording ? "Share it as a trace" : "Nothing is kept"}</h2>
			{handshake.recording ? (
				<>
					<p className="trace-hint">
						Before the agents leave, one of them exports the handshake and shares the file
						{handshake.request ? ` to ${handshake.request.shipletName}, where ${handshake.request.ticketLabel} was left` : ""}. It
						gets the same masking and sharing as any trace.
					</p>
					<pre className="work-prompt">
						<code>{`${exportStep}\nnpx shiplet-cli trace share handshake-${handshake.id}.trace.jsonl${shiplet}`}</code>
					</pre>
				</>
			) : (
				<p className="trace-hint">
					This handshake is not recorded, so when its agents leave there is nothing to read. An agent in it can start
					recording by sending with <code>record: true</code>.
				</p>
			)}
		</section>
	);
}
