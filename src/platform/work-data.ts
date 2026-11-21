// Loads what the loop screens show, for one signed-in person: their requests
// (annotations they can see), the traces they can read, the Shiplets they can
// annotate, and the live handshakes from the configured HandshakeSource.
import type { Env } from "../env";
import { AGENT_HANDSHAKES_FLAG, TRACES_FLAG, useFeatureFlag } from "../feature-flags";
import { listAccessibleReviewFeedback } from "../review";
import { listProjectsForUser, type ShipletUser } from "../store";
import { handleListReadableTraces } from "../traces/handlers";
import { createSampleHandshakeSource } from "./handshake-fixture";
import { toHandshakeDetail, type HandshakeDetail } from "./handshake-model";
import type { HandshakeMode, ShipletRef } from "./work-apps";
import { toLoopRequest, type LoopRequest, type LoopTrace } from "./work-loop";

export type WorkData = {
	now: number;
	requests: LoopRequest[];
	traces: LoopTrace[];
	tracesEnabled: boolean;
	shiplets: ShipletRef[];
	handshakeMode: HandshakeMode;
	handshakes: HandshakeDetail[];
};

export async function loadWorkData(env: Env, user: ShipletUser, options: { traceLimit?: number } = {}): Promise<WorkData> {
	const now = Date.now();
	const [feedback, projects] = await Promise.all([
		listAccessibleReviewFeedback(env.DB, user, { limit: 100 }),
		listProjectsForUser(env.DB, user.id),
	]);
	const requests = feedback.map(toLoopRequest);
	const tracesEnabled = useFeatureFlag(env, TRACES_FLAG) && Boolean(env.REVIEW_ASSETS);
	const traces = tracesEnabled ? await readableTraces(env, user, options.traceLimit ?? 50) : [];
	const shiplets = (projects as Array<{ id: string; name: string; archived_on?: string | null }>)
		.filter((project) => !project.archived_on)
		.map((project) => ({ id: project.id, name: project.name }));
	const handshakeMode: HandshakeMode = useFeatureFlag(env, AGENT_HANDSHAKES_FLAG) ? "sample" : "off";
	const source = handshakeMode === "sample" ? createSampleHandshakeSource({ requests, now: new Date(now) }) : null;
	const snapshots = source ? await source.list() : [];
	// A handshake's request is shown only when it names an annotation this
	// person can already see.
	const handshakes = snapshots.map((snapshot) => toHandshakeDetail(snapshot, { requests, sample: source?.kind === "sample" }));
	return { now, requests, traces, tracesEnabled, shiplets, handshakeMode, handshakes };
}

// The same list GET /api/traces returns: every trace this person can read,
// newest first, already filtered to their level. A failure drops traces from
// the page rather than failing it.
async function readableTraces(env: Env, user: ShipletUser, limit: number): Promise<LoopTrace[]> {
	try {
		const response = await handleListReadableTraces(env, { kind: "user", user }, { limit });
		if (!response.ok) return [];
		const body = (await response.json()) as { traces?: LoopTrace[] };
		return Array.isArray(body.traces) ? body.traces : [];
	} catch {
		console.error(JSON.stringify({ event: "work_loop.traces", outcome: "failed" }));
		return [];
	}
}
