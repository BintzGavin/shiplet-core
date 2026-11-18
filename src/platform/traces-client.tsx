/// <reference lib="dom" />
// Mounts the trace viewer page or the Shiplet page's traces panel.
import * as React from "react";
import { createRoot } from "react-dom/client";

import { TraceViewerApp, TracesPanel } from "./traces-app";

const viewer = document.getElementById("trace-viewer-root");
if (viewer?.dataset.projectId && viewer.dataset.traceId) {
	createRoot(viewer).render(
		<TraceViewerApp projectId={viewer.dataset.projectId} traceId={viewer.dataset.traceId} origin={window.location.origin} />,
	);
}

const panel = document.getElementById("traces-panel-root");
if (panel?.dataset.projectId) {
	createRoot(panel).render(<TracesPanel projectId={panel.dataset.projectId} canEdit={panel.dataset.canEdit === "true"} />);
}
