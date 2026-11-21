import { describe, expect, it } from "vitest";

import { Hub } from "../packages/agent-handshake/src/core/hub.js";
import { buildSampleHandshakes, createSampleHandshakeSource } from "../src/platform/handshake-fixture";
import {
	handshakesForRequest,
	livePeers,
	peerAgent,
	toHandshakeDetail,
	toHandshakeSummary,
	type HandshakeSummary,
} from "../src/platform/handshake-model";
import {
	buildWorkLoop,
	elementLabel,
	requestStage,
	requestsBeforeTrace,
	shortRevision,
	toLoopRequest,
	tracesSinceRequest,
	type LoopRequest,
	type LoopTrace,
} from "../src/platform/work-loop";
import type { ReviewFeedbackRecord } from "../src/review";

const NOW = new Date("2026-11-21T12:00:00.000Z");

function request(overrides: Partial<LoopRequest> = {}): LoopRequest {
	return {
		id: "fb_1",
		projectId: "proj_a",
		shipletName: "Checkout",
		ticketLabel: "PF-1",
		comment: "Make the pay button readable",
		status: "New",
		createdOn: "2026-11-21T09:00:00.000Z",
		submittedBy: "dana@example.com",
		pagePath: "/checkout",
		element: "button “Pay”",
		hasScreenshot: true,
		revisionId: "rev_abc1234567",
		href: "/shiplets/proj_a?feedback=fb_1",
		...overrides,
	};
}

function trace(overrides: Partial<LoopTrace> = {}): LoopTrace {
	return {
		id: "trc_1",
		projectId: "proj_a",
		revisionId: "rev_def",
		title: "Fix pay button contrast",
		harness: "claude-code",
		startedOn: "2026-11-21T09:30:00.000Z",
		endedOn: "2026-11-21T10:00:00.000Z",
		createdOn: "2026-11-21T10:05:00.000Z",
		eventCount: 40,
		sharing: "shared",
		...overrides,
	};
}

describe("work loop", () => {
	it("groups request statuses by where the request is in the loop", () => {
		expect(requestStage("New")).toBe("waiting");
		expect(requestStage("Blocked")).toBe("waiting");
		expect(requestStage("In Progress")).toBe("working");
		expect(requestStage("Staging")).toBe("check");
		expect(requestStage("Done")).toBe("closed");
		expect(requestStage("Dropped")).toBe("closed");
		// Unknown statuses from older data stay visible as waiting, never vanish.
		expect(requestStage("Something else")).toBe("waiting");
	});

	it("links a request to traces on the same Shiplet that finished after it", () => {
		const asked = request();
		const after = trace({ id: "trc_after" });
		const before = trace({ id: "trc_before", endedOn: "2026-11-21T08:00:00.000Z", createdOn: "2026-11-21T08:10:00.000Z" });
		const otherShiplet = trace({ id: "trc_other", projectId: "proj_b" });
		// A session uploaded without an end time falls back to its upload time.
		const noEnd = trace({ id: "trc_noend", endedOn: null, createdOn: "2026-11-21T11:00:00.000Z" });
		expect(tracesSinceRequest(asked, [before, after, otherShiplet, noEnd]).map((item) => item.id)).toEqual(["trc_noend", "trc_after"]);
	});

	it("links a trace back to the requests on its Shiplet made before it finished", () => {
		const earlier = request({ id: "fb_early", createdOn: "2026-11-21T08:00:00.000Z" });
		const later = request({ id: "fb_late", createdOn: "2026-11-21T11:00:00.000Z" });
		const elsewhere = request({ id: "fb_else", projectId: "proj_b" });
		expect(requestsBeforeTrace(trace(), [later, elsewhere, earlier, request()]).map((item) => item.id)).toEqual(["fb_1", "fb_early"]);
	});

	it("puts each request in one lane and treats a live handshake as work in progress", async () => {
		const waiting = request({ id: "fb_wait", createdOn: "2026-11-21T08:00:00.000Z" });
		const pickedUp = request({ id: "fb_live", ticketLabel: "PF-2", createdOn: "2026-11-21T08:30:00.000Z" });
		const inProgress = request({ id: "fb_prog", status: "In Progress" });
		const staging = request({ id: "fb_stage", status: "Staging" });
		const done = request({ id: "fb_done", status: "Done" });
		const requests = [waiting, pickedUp, inProgress, staging, done];
		const handshakes = await sampleViews([pickedUp], requests);
		const fromHandshake = trace({ id: "trc_hs", harness: "agent-handshake" });
		const loop = buildWorkLoop({ requests, traces: [trace(), fromHandshake], handshakes });
		expect(loop.asked.map((card) => card.id)).toEqual(["fb_wait"]);
		expect(loop.working.map((card) => card.id).sort()).toEqual(["fb_live", "fb_prog"]);
		expect(loop.toCheck.map((card) => card.id)).toEqual(["fb_stage"]);
		expect(loop.counts).toMatchObject({ asked: 1, working: 2, toCheck: 1, traces: 2, live: 2 });
		// Home counts what it shows: two live handshakes (one carries fb_live) and fb_prog.
		expect(loop.counts).toMatchObject({ inMotion: 3, cameBack: 3 });
		expect(loop.working.find((card) => card.id === "fb_live")?.handshakes.map((item) => item.topic)).toEqual(["PF-2: Make the pay button readable"]);
		// The trace that came back knows which requests came before it, and whether it was a handshake.
		expect(loop.traces[0].requests.map((item) => item.id)).toContain("fb_wait");
		expect(loop.traces.map((item) => [item.id, item.fromHandshake])).toEqual([["trc_1", false], ["trc_hs", true]]);
	});

	it("caps each lane but keeps the full counts", () => {
		const many = Array.from({ length: 9 }, (_, index) => request({ id: `fb_${index}`, createdOn: `2026-11-21T0${index}:00:00.000Z` }));
		const loop = buildWorkLoop({ requests: many, traces: [], handshakes: [], limit: 3 });
		expect(loop.asked.map((card) => card.id)).toEqual(["fb_8", "fb_7", "fb_6"]);
		expect(loop.counts.asked).toBe(9);
	});

	it("turns a feedback record into a request that keeps its context", () => {
		const record = {
			id: "fb_x",
			project_id: "proj_a",
			project_name: "Checkout",
			ticket_number: 7,
			ticket_label: "",
			comment: "Too small",
			status: "New",
			created_on: "2026-11-21T09:00:00.000Z",
			submitted_by_email: null,
			name: "Dana",
			pathname: "",
			page_url: "https://checkout.example.com/pay?x=1",
			selected_element: { tagName: "BUTTON", text: "  Pay   now ", selector: "main > button" },
			screenshot_url: null,
			screenshot_key: "shots/1.png",
			revision_id: "rev_0123456789",
		} as unknown as ReviewFeedbackRecord;
		expect(toLoopRequest(record)).toMatchObject({
			ticketLabel: "PF-7",
			submittedBy: "Dana",
			pagePath: "/pay",
			element: "button “Pay now”",
			hasScreenshot: true,
			href: "/shiplets/proj_a?feedback=fb_x",
		});
	});

	it("labels elements without trusting their shape", () => {
		expect(elementLabel(null)).toBeNull();
		expect(elementLabel("button")).toBeNull();
		expect(elementLabel({ selector: "body > main > div:nth-of-type(2) > a" })).toBe("div:nth-of-type(2) > a");
		expect(elementLabel({ ariaLabel: "Close dialog", tagName: "BUTTON" })).toBe("button “Close dialog”");
		expect(elementLabel({ tagName: "IMG" })).toBe("img");
	});

	it("shortens revisions and hides legacy ones", () => {
		expect(shortRevision("rev_0123456789")).toBe("0123456");
		expect(shortRevision("legacy_proj")).toBeNull();
		expect(shortRevision(null)).toBeNull();
	});
});

async function sampleViews(anchors: LoopRequest[], visible: LoopRequest[] = anchors): Promise<HandshakeSummary[]> {
	const snapshots = await buildSampleHandshakes({ requests: anchors, now: NOW });
	return snapshots.map((snapshot) => toHandshakeSummary(toHandshakeDetail(snapshot, { requests: visible, sample: true })));
}

describe("handshakes on the loop screens", () => {
	it("reads what the real hub reports, and links to an annotation only the reader can see", async () => {
		let n = 0;
		const hub = new Hub({ ids: (prefix) => `${prefix}_${++n}`, now: () => NOW });
		const a = hub.open();
		const b = hub.open();
		await a.handle("register", { name: "builder", kind: "claude", app: "claude-cli", machine: "studio" });
		await b.handle("register", { name: "checker", kind: "codex", app: "codex-app", machine: "ci" });
		const sent = await a.handle("send", {
			to: "checker",
			text: "picking it up",
			record: true,
			request: { shiplet: "proj_a", feedback: "fb_1", label: "PF-1" },
		});
		await b.handle("send", { to: "builder", room: sent.room, text: "running checks" });
		b.close();
		const [snapshot] = hub.handshakes();

		const seen = toHandshakeDetail(snapshot, { requests: [request()], sample: false });
		expect(seen).toMatchObject({
			id: sent.room,
			topic: "builder and checker",
			recording: true,
			messageCount: 2,
			request: { feedbackId: "fb_1", projectId: "proj_a", ticketLabel: "PF-1", comment: "Make the pay button readable", shipletName: "Checkout" },
		});
		expect(seen.messages?.map((message) => [message.from.name, message.to.name, message.text])).toEqual([
			["builder", "checker", "picking it up"],
			["checker", "builder", "running checks"],
		]);
		expect(seen.peers.map((peer) => [peer.name, peer.opened, peer.live, peerAgent(peer)])).toEqual([
			["builder", true, true, "Claude Code"],
			["checker", false, false, "Codex"],
		]);
		expect(livePeers(seen).map((peer) => peer.name)).toEqual(["builder"]);

		// The same handshake for someone who cannot see fb_1 (or names a different Shiplet) shows no request.
		expect(toHandshakeDetail(snapshot, { requests: [], sample: false }).request).toBeNull();
		expect(toHandshakeDetail(snapshot, { requests: [request({ projectId: "proj_b" })], sample: false }).request).toBeNull();
		expect("messages" in toHandshakeSummary(seen)).toBe(false);
	});

	it("shows no messages for a handshake that is not recorded", async () => {
		const hub = new Hub({ now: () => NOW });
		const a = hub.open();
		const b = hub.open();
		await a.handle("register", { name: "a", kind: "claude" });
		await b.handle("register", { name: "b", kind: "other", app: "acme-agent" });
		await a.handle("send", { to: "b", text: "not kept", topic: "Retry policy" });
		const detail = toHandshakeDetail(hub.handshakes()[0], { requests: [], sample: false });
		expect(detail).toMatchObject({ topic: "Retry policy", recording: false, messageCount: 1, messages: null });
		expect(peerAgent(detail.peers[1])).toBe("acme-agent");
	});
});

describe("sample handshakes", () => {
	it("run the real hub around the newest open request and keep their ids between loads", async () => {
		const anchors = [
			request({ id: "fb_done", ticketLabel: "PF-1", comment: "old", status: "Done" }),
			request({ id: "fb_open", ticketLabel: "PF-2", comment: "Fix the header", status: "New" }),
		];
		const source = createSampleHandshakeSource({ requests: anchors, now: NOW });
		expect(source.kind).toBe("sample");
		const first = await source.list();
		const again = await buildSampleHandshakes({ requests: anchors, now: NOW });
		expect(first.map((item) => item.id)).toEqual(again.map((item) => item.id));
		expect(first.map((item) => item.request)).toEqual([{ shiplet: "proj_a", feedback: "fb_open", label: "PF-2" }, null]);

		const views = first.map((snapshot) => toHandshakeDetail(snapshot, { requests: anchors, sample: true }));
		expect(handshakesForRequest(views, "fb_open")).toHaveLength(1);
		expect(handshakesForRequest(views, "fb_done")).toEqual([]);
		const [work, side] = views;
		// The work handshake is recorded, and the reviewer who joined has left.
		expect(work.recording).toBe(true);
		expect(work.messages?.length).toBe(work.messageCount);
		expect(work.peers.map((peer) => [peer.name, peer.live])).toEqual([["builder", true], ["checker", true], ["a11y-review", false]]);
		// The side conversation was never recorded, so only who and how many show.
		expect(side).toMatchObject({ topic: "Agree on one retry policy for trace uploads", recording: false, messageCount: 3, messages: null });
	});

	it("without an open request, the work handshake names none", async () => {
		const views = await sampleViews([]);
		expect(views.every((handshake) => handshake.request === null)).toBe(true);
		expect(views[0].topic).toBe("Fix the checkout button contrast");
	});
});
