// Server shells for the trace UI. The React app in traces-app.tsx renders
// into them on the client and reads everything through the trace API.
import { kernelScriptNonceAttribute, type KernelDocumentNonce } from "../kernel-document-nonce";

export const TRACES_CLIENT_ASSET = "/assets/platform/traces.js";

const attribute = (value: string) => value.replace(/[&"<>]/g, (character) => `&#${character.charCodeAt(0)};`);

export function BuildTraceViewerPage(options: { nonce: KernelDocumentNonce; projectId: string; traceId: string }) {
	return `<div class="dashboard-shell shiplet-dashboard-stage trace-page">
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
