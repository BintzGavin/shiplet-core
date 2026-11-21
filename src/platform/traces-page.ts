// Server shells for the trace UI. The React app in traces-app.tsx renders
// into them on the client and reads everything through the trace API.
import { kernelScriptNonceAttribute, type KernelDocumentNonce } from "../kernel-document-nonce";

export const TRACES_CLIENT_ASSET = "/assets/platform/traces.js";

const attribute = (value: string) => value.replace(/[&"<>]/g, (character) => `&#${character.charCodeAt(0)};`);

// Where this trace sits in the loop: the open annotations on its Shiplet that
// agents were asked to do, agents still talking about that Shiplet, and the
// version to check.
export type TraceLoopContext = {
	shipletName: string;
	openRequests: Array<{ ticketLabel: string; comment: string; href: string }>;
	requestCount: number;
	handshakes: Array<{ id: string; topic: string; sample: boolean }>;
};

const text = (value: string) => value.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);

function TraceLoopStrip(projectId: string, loop: TraceLoopContext) {
	const shiplet = `/shiplets/${encodeURIComponent(projectId)}`;
	const requests = loop.openRequests
		.slice(0, 3)
		.map(
			(request) =>
				`<li><a class="feedback-ticket-id" href="${attribute(request.href)}">${text(request.ticketLabel)}</a> <span>${text(request.comment.length > 90 ? `${request.comment.slice(0, 89)}…` : request.comment)}</span></li>`,
		)
		.join("");
	const handshake = loop.handshakes
		.slice(0, 2)
		.map(
			(item) =>
				`<p class="trace-loop-handshake"><span class="work-live-dot" aria-hidden="true"></span> Agents talking now: <a href="/handshakes/${attribute(encodeURIComponent(item.id))}">${text(item.topic)}</a>${item.sample ? ' <span class="status-badge status-muted">Sample</span>' : ""}</p>`,
		)
		.join("");
	return `<nav class="success-card shiplet-panel trace-loop" aria-label="Where this trace came from">
    <div class="trace-loop-part">
      <span class="success-card-label">Asked for</span>
      ${requests ? `<ul class="trace-loop-requests">${requests}</ul>` : `<p class="trace-loop-empty">No open annotations on ${text(loop.shipletName)}.</p>`}
      ${loop.requestCount ? `<a class="work-link" href="/feedback?projectId=${attribute(encodeURIComponent(projectId))}">All ${loop.requestCount === 1 ? "1 annotation" : `${loop.requestCount} annotations`} on ${text(loop.shipletName)}</a>` : ""}
      ${handshake}
    </div>
    <div class="trace-loop-part trace-loop-next">
      <span class="success-card-label">Check it</span>
      <p>Open the new version, check the work, and annotate anything that still needs to change.</p>
      <a class="btn btn-primary btn-sm" href="${attribute(shiplet)}">Check and annotate</a>
    </div>
  </nav>`;
}

export function BuildTraceViewerPage(options: { nonce: KernelDocumentNonce; projectId: string; traceId: string; loop?: TraceLoopContext | null }) {
	return `<div class="dashboard-shell shiplet-dashboard-stage trace-page">
  ${options.loop ? TraceLoopStrip(options.projectId, options.loop) : ""}
  <div id="trace-viewer-root" data-project-id="${attribute(options.projectId)}" data-trace-id="${attribute(options.traceId)}">
    <div class="banner banner-info">Loading trace…</div>
    <p class="trace-definition">A trace is the full log of an agent session: your prompts, the agent's replies, and every tool call and result.</p>
  </div>
</div>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${TRACES_CLIENT_ASSET}"></script>`;
}

export function TracesPanelMount(options: { nonce: KernelDocumentNonce; projectId: string; canEdit: boolean }) {
	return `<div id="traces-panel-root" data-project-id="${attribute(options.projectId)}" data-can-edit="${options.canEdit ? "true" : "false"}"></div>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${TRACES_CLIENT_ASSET}"></script>`;
}

// The page of a trace-only Shiplet (D19): the viewer, showing the newest trace
// this reader can open, where the artifact frame would be.
export function BuildTraceOnlyViewerMount(options: { nonce: KernelDocumentNonce; projectId: string }) {
	return `<div id="trace-viewer-root" class="trace-viewer-embedded" data-project-id="${attribute(options.projectId)}" data-trace-id="" data-embedded="true">
  <div class="banner banner-info">Loading trace…</div>
  <p class="trace-definition">A trace is the full log of an agent session: your prompts, the agent's replies, and every tool call and result.</p>
</div>
<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(options.nonce)} type="module" src="${TRACES_CLIENT_ASSET}"></script>`;
}
