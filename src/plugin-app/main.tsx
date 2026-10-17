/// <reference lib="dom" />

import "@openai/mcp-extensions/app/styles.css";
import "./app.css";

import {
	App,
	applyDocumentTheme,
	applyHostFonts,
	applyHostStyleVariables,
	type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import {
	OPENAI_DEEP_LINK_KEY,
	OPENAI_MODEL_CONTEXT_KEY,
	OpenAIExtensions,
	OpenAIFileEntrypointInputSchema,
} from "@openai/mcp-extensions/app";
import * as React from "react";
import { createRoot } from "react-dom/client";

import { ShipletApp } from "./app";
import { ShipletController } from "./controller";
import { createShipletHost } from "./host";

const controller = new ShipletController();
const app = new App(
	{ name: "shiplet-review", version: "0.1.0" },
	{ availableDisplayModes: ["inline", "fullscreen"] },
);
const extensions = new OpenAIExtensions(app);

let fontsApplied = false;

function applyHostContext(context: McpUiHostContext | undefined) {
	if (!context) return;
	if (context.theme) applyDocumentTheme(context.theme);
	if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
	if (!fontsApplied && typeof context.styles?.css?.fonts === "string") {
		applyHostFonts(context.styles.css.fonts);
		fontsApplied = true;
	}
	const full = app.getHostContext() ?? context;
	const mode = full.displayMode;
	controller.setHostView({
		displayMode: mode === "fullscreen" || mode === "pip" ? mode : "inline",
		canFullscreen:
			mode !== "fullscreen" &&
			(full.availableDisplayModes ?? []).includes("fullscreen"),
		platform: full.platform ?? null,
	});
}

// Register every handler before connect() so the initial tool input and
// result render directly instead of being fetched a second time.
app.ontoolinput = (params) => {
	const parsed = OpenAIFileEntrypointInputSchema.safeParse(params.arguments);
	controller.handleToolInput(parsed.success ? parsed.data.file : null);
};
app.ontoolresult = (result) => {
	controller.handleToolResult(result.structuredContent, result.isError);
};
app.addEventListener("hostcontextchanged", (params) => {
	applyHostContext(params);
	if (Object.hasOwn(params, OPENAI_DEEP_LINK_KEY)) {
		controller.handleDeepLink(extensions.deepLink.getCurrent()?.url);
	}
	if (Object.hasOwn(params, OPENAI_MODEL_CONTEXT_KEY) && params[OPENAI_MODEL_CONTEXT_KEY] === null) {
		controller.handleModelContextCleared();
	}
});
app.onteardown = () => ({});

const ready = app.connect();
controller.setHost(createShipletHost(app, extensions, ready));

const rootElement = document.getElementById("shiplet-app");
if (rootElement) {
	createRoot(rootElement).render(<ShipletApp controller={controller} />);
}

ready.then(
	() => {
		applyHostContext(app.getHostContext());
		controller.handleConnected();
		controller.handleModelContextRestored(
			extensions.modelContext?.getCurrent()?.structuredContent,
		);
		controller.handleDeepLink(extensions.deepLink.getCurrent()?.url);
		controller.flushModelContext();
	},
	() => controller.handleConnectFailed(),
);
