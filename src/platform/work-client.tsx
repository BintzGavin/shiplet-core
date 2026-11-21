/// <reference lib="dom" />
// Hydrates the loop screens (Home, Traces, Handshakes) with the props the
// server rendered them with.
import * as React from "react";
import { hydrateRoot } from "react-dom/client";

import { WorkApp, type WorkScreen } from "./work-apps";

const root = document.getElementById("work-platform-root");
const state = readState();
if (root && state) hydrateRoot(root, <WorkApp {...state} />);

function readState(): WorkScreen | null {
	const node = document.getElementById("shiplet-platform-work-state");
	if (!node?.textContent) return null;
	try {
		return JSON.parse(node.textContent) as WorkScreen;
	} catch {
		return null;
	}
}
