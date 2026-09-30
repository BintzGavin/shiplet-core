/// <reference lib="dom" />

// Thin adapter over the MCP Apps SDK and OpenAI extensions. React components
// talk to this interface only; every method resolves or rejects with an Error
// whose message is safe to show inline.

import type { App } from "@modelcontextprotocol/ext-apps";
import type { OpenAIExtensions } from "@openai/mcp-extensions/app";

import type { PluginToolName } from "../plugin-contract";
import {
	buildAskMessage,
	buildFeedbackModelContext,
	toolErrorMessage,
} from "./model";
import type { DetailData } from "./state";

export type ShipletHost = {
	callTool(name: PluginToolName, args: Record<string, unknown>): Promise<unknown>;
	openLink(url: string): Promise<void>;
	askChatGPT(detail: DetailData): Promise<void>;
	/** Returns true when the host acknowledged the context update. */
	attachFeedback(detail: DetailData): Promise<boolean>;
	clearAttachedFeedback(): Promise<void>;
	requestFullscreen(): Promise<void>;
	canReadFiles(): boolean;
	readTextFile(resourceUri: string): Promise<string>;
	/** Resolves once `ui/initialize` finished; rejects if it failed. */
	ready: Promise<void>;
};

export function createShipletHost(
	app: App,
	extensions: OpenAIExtensions,
	ready: Promise<void>,
): ShipletHost {
	async function afterReady() {
		await ready;
	}

	return {
		ready,
		async callTool(name, args) {
			await afterReady();
			let result: Awaited<ReturnType<App["callServerTool"]>>;
			try {
				result = await app.callServerTool({ name, arguments: args });
			} catch (error) {
				throw new Error(toolErrorMessage(error));
			}
			if (result.isError) throw new Error(toolErrorMessage(result));
			return result.structuredContent;
		},
		async openLink(url) {
			await afterReady();
			const result = await app.openLink({ url });
			if (result.isError) throw new Error("ChatGPT could not open that link.");
		},
		async askChatGPT(detail) {
			await afterReady();
			const message = buildAskMessage(detail.feedback, detail.shiplet);
			const result = extensions.message
				? await extensions.message.send(message)
				: await app.sendMessage(message);
			if (result.isError) throw new Error("ChatGPT did not accept the message.");
		},
		async attachFeedback(detail) {
			await afterReady();
			const modelContext = extensions.modelContext;
			const params = buildFeedbackModelContext(detail.feedback, detail.shiplet);
			if (modelContext) return (await modelContext.update(params)) !== undefined;
			if (!app.getHostCapabilities()?.updateModelContext) return false;
			await app.updateModelContext(params);
			return true;
		},
		async clearAttachedFeedback() {
			await afterReady();
			if (extensions.modelContext) {
				await extensions.modelContext.update({ content: [] });
			} else if (app.getHostCapabilities()?.updateModelContext) {
				await app.updateModelContext({ content: [] });
			}
		},
		async requestFullscreen() {
			await afterReady();
			await app.requestDisplayMode({ mode: "fullscreen" });
		},
		canReadFiles() {
			return extensions.resources !== undefined;
		},
		async readTextFile(resourceUri) {
			await afterReady();
			const resources = extensions.resources;
			if (!resources) throw new Error("File access is not available here.");
			const result = await resources.read({ uri: resourceUri, representation: "text" });
			const content = result.contents[0];
			if (content && "text" in content && typeof content.text === "string") {
				return content.text;
			}
			if (content && "blob" in content && typeof content.blob === "string") {
				return decodeBase64Utf8(content.blob);
			}
			throw new Error("The file came back empty.");
		},
	};
}

function decodeBase64Utf8(blob: string): string {
	const binary = atob(blob);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new TextDecoder().decode(bytes);
}
