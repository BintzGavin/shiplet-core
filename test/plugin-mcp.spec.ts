import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import app from "../src/index";
import { PLUGIN_APP_HTML } from "../src/generated-plugin-app";
import {
	PLUGIN_APP_RESOURCE_URI,
	PLUGIN_MCP_PATH,
	PLUGIN_TOOL,
	type FeedbackDetailResult,
	type FeedbackListResult,
	type PublishResult,
	type ShipletListResult,
	type WorkspaceListResult,
} from "../src/plugin-contract";
import { ensureSchema } from "../src/schema";

/*
 * Behavioral specification
 *
 * Given ChatGPT connects to Shiplet's plugin MCP endpoint,
 * When it lists tools, Then it sees exactly the eleven discrete tools, each
 * with a title, a description, explicit boolean safety annotations, and the
 * OpenAI entrypoint, mention, visibility, and icon metadata the plugin needs.
 *
 * Given a connected Shiplet user,
 * When the model publishes HTML, lists Shiplets, and triages feedback,
 * Then every operation runs through the same authorization as the REST API,
 * and another user's Shiplet IDs return an error result instead of data.
 *
 * Given an unauthenticated client, When it calls the endpoint, Then it is
 * challenged with the plugin's own protected-resource metadata while /api/mcp
 * keeps its original challenge.
 */

const testEnv = env as Env;
const APP_URL = "https://shiplet.cc";
const PLUGIN_METADATA_URL = `${APP_URL}/.well-known/oauth-protected-resource${PLUGIN_MCP_PATH}`;
const MODEL_TOOLS = [
	PLUGIN_TOOL.listShiplets,
	PLUGIN_TOOL.listFeedback,
	PLUGIN_TOOL.getFeedback,
	PLUGIN_TOOL.publishHtml,
	PLUGIN_TOOL.reviewUrl,
	PLUGIN_TOOL.replyToFeedback,
	PLUGIN_TOOL.updateFeedbackStatus,
	PLUGIN_TOOL.listWorkspaces,
];
const APP_TOOLS = [
	PLUGIN_TOOL.openInbox,
	PLUGIN_TOOL.openPanel,
	PLUGIN_TOOL.openHtmlFile,
	PLUGIN_TOOL.searchMentions,
];

type ToolResult = {
	content?: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

type ListedTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	_meta?: Record<string, any>;
	icons?: Array<{ src: string; mimeType?: string }>;
};

function oauthToken(email: string) {
	return `shiplet_oauth_${btoa(email).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

/** The local user id that the test OAuth token for this email resolves to. */
function oauthUserId(email: string) {
	const slug =
		email
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 64) || "user";
	return `user_oauth_${slug}`;
}

function sessionHeaders(email: string) {
	return {
		"x-shiplet-user-id": oauthUserId(email),
		"x-shiplet-user-email": email,
	};
}

async function createWorkspace(email: string, name: string) {
	const response = await request("/api/organizations", {
		method: "POST",
		headers: { ...sessionHeaders(email), "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { organization: { id: string } })
		.organization.id;
}

async function restProjects(email: string) {
	const response = await request("/api/shiplets?status=all", {
		headers: sessionHeaders(email),
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as {
		projects: Array<{ id: string; organization_id: string }>;
	}).projects;
}

function uniqueEmail(label: string) {
	return `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;
}

async function request(
	path: string,
	init: RequestInit = {},
	bindings: Env = testEnv,
) {
	const context = createExecutionContext();
	const response = await app.fetch(
		new Request(`http://localhost${path}`, init),
		bindings,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

async function rpc(
	token: string | null,
	method: string,
	params: Record<string, unknown> = {},
) {
	const response = await request(PLUGIN_MCP_PATH, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: crypto.randomUUID(),
			method,
			params,
		}),
	});
	return response;
}

async function rpcResult<T>(
	token: string,
	method: string,
	params: Record<string, unknown> = {},
) {
	const response = await rpc(token, method, params);
	expect(response.status).toBe(200);
	const payload = (await response.json()) as {
		result?: T;
		error?: { message: string };
	};
	expect(payload.error).toBeUndefined();
	return payload.result as T;
}

function callTool(token: string, name: string, args: Record<string, unknown>) {
	return rpcResult<ToolResult>(token, "tools/call", { name, arguments: args });
}

function errorText(result: ToolResult) {
	expect(result.isError).toBe(true);
	expect(result.structuredContent).toBeUndefined();
	return result.content?.[0]?.text || "";
}

async function publish(
	token: string,
	name: string,
	extra: Record<string, unknown> = {},
) {
	const result = await callTool(token, PLUGIN_TOOL.publishHtml, {
		name,
		files: [
			{
				path: "index.html",
				content: `<!doctype html><title>${name}</title><h1>${name}</h1>`,
			},
		],
		...extra,
	});
	expect(result.isError).toBeFalsy();
	return (result.structuredContent as PublishResult).shiplet;
}

async function createFeedback(
	token: string,
	shipletId: string,
	comment: string,
	reviewerName = "Riley Reviewer",
) {
	const response = await request("/api/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "execute",
				arguments: {
					code: `async () => await codemode.request(${JSON.stringify({
						method: "POST",
						path: `/api/projects/${shipletId}/review-feedback`,
						body: {
							comment,
							name: reviewerName,
							pageUrl: "https://example.com/pricing",
							clientFeedbackId: crypto.randomUUID(),
						},
					})})`,
				},
			},
		}),
	});
	expect(response.status).toBe(200);
	const payload = (await response.json()) as {
		result: { content: Array<{ text: string }> };
	};
	const created = JSON.parse(payload.result.content[0].text) as {
		ok: boolean;
		feedback: { id: string };
	};
	expect(created.ok).toBe(true);
	return created.feedback.id;
}

describe("ChatGPT plugin MCP endpoint", () => {
	beforeAll(async () => {
		await ensureSchema(testEnv.DB);
	});

	it("initializes as Shiplet and lists exactly the eleven annotated tools", async () => {
		const token = oauthToken(uniqueEmail("plugin-list"));
		const init = await rpcResult<{
			serverInfo: { name: string; title?: string; version: string };
			instructions?: string;
			capabilities: Record<string, unknown>;
		}>(token, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "1.0.0" },
		});
		expect(init.serverInfo).toMatchObject({ name: "shiplet", title: "Shiplet" });
		expect(init.instructions).toMatch(/Shiplet/);
		expect(init.instructions).not.toMatch(/plugin/i);
		expect(init.capabilities).toHaveProperty("tools");
		expect(init.capabilities).toHaveProperty("resources");

		const { tools } = await rpcResult<{ tools: ListedTool[] }>(
			token,
			"tools/list",
		);
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[...MODEL_TOOLS, ...APP_TOOLS].sort(),
		);
		for (const tool of tools) {
			expect(tool.title, tool.name).toBeTruthy();
			expect(tool.description?.length, tool.name).toBeGreaterThan(20);
			expect(tool.inputSchema.type, tool.name).toBe("object");
			for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
				expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
					"boolean",
				);
			}
		}

		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const annotations = (name: string) => byName.get(name)?.annotations;
		for (const name of [
			PLUGIN_TOOL.listShiplets,
			PLUGIN_TOOL.listFeedback,
			PLUGIN_TOOL.getFeedback,
			PLUGIN_TOOL.listWorkspaces,
			...APP_TOOLS,
		]) {
			expect(annotations(name), name).toEqual({
				readOnlyHint: true,
				destructiveHint: false,
				openWorldHint: false,
			});
		}
		expect(annotations(PLUGIN_TOOL.publishHtml)).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: true,
		});
		expect(annotations(PLUGIN_TOOL.reviewUrl)).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: true,
		});
		expect(annotations(PLUGIN_TOOL.replyToFeedback)).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		});
		expect(annotations(PLUGIN_TOOL.updateFeedbackStatus)).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			openWorldHint: false,
		});
		expect(byName.get(PLUGIN_TOOL.publishHtml)?.description).toMatch(
			/creates another Shiplet/,
		);
		expect(byName.get(PLUGIN_TOOL.replyToFeedback)?.description).toMatch(
			/connected Shiplet user.*visible to everyone/s,
		);

		for (const name of MODEL_TOOLS) {
			expect(byName.get(name)?._meta?.ui?.visibility, name).toBeUndefined();
		}
		for (const name of APP_TOOLS) {
			const tool = byName.get(name)!;
			expect(tool._meta?.ui).toMatchObject({
				resourceUri: PLUGIN_APP_RESOURCE_URI,
				visibility: ["app"],
			});
			expect(tool.icons?.length, name).toBe(1);
			const icon = tool.icons![0];
			expect(icon.mimeType).toBe("image/svg+xml");
			expect(icon.src.startsWith("data:image/svg+xml,")).toBe(true);
			const svg = decodeURIComponent(icon.src.slice("data:image/svg+xml,".length));
			expect(svg).toContain('viewBox="0 0 20 20"');
			expect(svg).toContain('stroke="currentColor"');
			expect(svg).toContain('stroke-width="1.33"');
			expect(svg).not.toMatch(/fill="(?!none)/);
		}
		expect(byName.get(PLUGIN_TOOL.openInbox)).toMatchObject({
			title: "Shiplet reviews",
			_meta: { "openai/ui": { entrypoints: [{ type: "global" }] } },
		});
		expect(byName.get(PLUGIN_TOOL.openPanel)).toMatchObject({
			title: "Review feedback",
			_meta: { "openai/ui": { entrypoints: [{ type: "thread" }] } },
		});
		expect(byName.get(PLUGIN_TOOL.openHtmlFile)).toMatchObject({
			title: "Shiplet preview",
			_meta: {
				"openai/ui": {
					entrypoints: [{ type: "file", extensions: [".html", ".htm"] }],
				},
			},
			inputSchema: {
				properties: {
					file: {
						type: "object",
						required: ["name", "resourceUri"],
					},
				},
				required: ["file"],
			},
		});
		expect(byName.get(PLUGIN_TOOL.searchMentions)).toMatchObject({
			title: "Find Shiplets",
			_meta: { "openai/extensions": { "mentions/search": {} } },
		});
	});

	it("opens entrypoints with empty arguments and previews a file without receiving its bytes", async () => {
		const token = oauthToken(uniqueEmail("plugin-entry"));
		const shiplet = await publish(token, "Entrypoint Shiplet");
		for (const name of [PLUGIN_TOOL.openInbox, PLUGIN_TOOL.openPanel]) {
			const result = await callTool(token, name, {});
			expect(result.isError).toBeFalsy();
			const content = result.structuredContent as ShipletListResult;
			expect(content.view).toBe("inbox");
			expect(content.shiplets.map((item) => item.id)).toContain(shiplet.id);
		}
		const preview = await callTool(token, PLUGIN_TOOL.openHtmlFile, {
			file: { name: "landing.html", resourceUri: "host-resource://landing" },
		});
		expect(preview.structuredContent).toEqual({
			view: "html-file",
			fileName: "landing.html",
		});
	});

	it("serves the MCP App resource with its CSP and display metadata", async () => {
		const token = oauthToken(uniqueEmail("plugin-resource"));
		const result = await rpcResult<{
			contents: Array<{
				uri: string;
				mimeType: string;
				text: string;
				_meta: Record<string, any>;
			}>;
		}>(token, "resources/read", { uri: PLUGIN_APP_RESOURCE_URI });
		expect(result.contents).toHaveLength(1);
		const [content] = result.contents;
		expect(content.uri).toBe(PLUGIN_APP_RESOURCE_URI);
		expect(content.mimeType).toBe("text/html;profile=mcp-app");
		expect(content.text).toBe(PLUGIN_APP_HTML);
		expect(content._meta.ui).toEqual({
			prefersBorder: true,
			domain: APP_URL,
			csp: { connectDomains: [], resourceDomains: [APP_URL] },
		});
		expect(content._meta["openai/ui"]).toEqual({
			preferredDisplayMode: "fullscreen",
			availableDisplayModes: ["inline", "fullscreen"],
		});
		expect(content._meta["openai/widgetCSP"]).toEqual({
			connect_domains: [],
			resource_domains: [APP_URL],
			redirect_domains: expect.arrayContaining([APP_URL]),
		});
		expect(content._meta["openai/widgetDescription"]).toEqual(
			expect.any(String),
		);
	});

	it("challenges unauthenticated clients with the plugin resource metadata", async () => {
		const response = await rpc(null, "tools/list");
		expect(response.status).toBe(401);
		const challenge = response.headers.get("www-authenticate") || "";
		expect(challenge).toContain(`resource_metadata="${PLUGIN_METADATA_URL}"`);
		expect(challenge).toContain('scope="openid profile email"');

		const invalid = await rpc("not-a-shiplet-token", "tools/list");
		expect(invalid.status).toBe(401);
		expect(invalid.headers.get("www-authenticate")).toContain(
			PLUGIN_METADATA_URL,
		);
	});

	it("publishes plugin protected-resource metadata bound to the plugin path", async () => {
		const response = await request(
			`/.well-known/oauth-protected-resource${PLUGIN_MCP_PATH}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("public, max-age=300");
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			resource: `${APP_URL}${PLUGIN_MCP_PATH}`,
			authorization_servers: ["https://example.authkit.app"],
			bearer_methods_supported: ["header"],
			scopes_supported: ["openid", "profile", "email"],
			resource_documentation: `${APP_URL}/docs/chatgpt-plugin`,
			resource_name: "Shiplet",
		});
	});

	it("keeps the Code Mode MCP challenge and metadata unchanged", async () => {
		const response = await request("/api/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			[
				'Bearer error="unauthorized"',
				'error_description="Authorization needed"',
				`resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`,
				'scope="openid profile email"',
			].join(", "),
		);
		for (const path of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/api/mcp",
		]) {
			const metadata = (await (await request(path)).json()) as Record<
				string,
				unknown
			>;
			expect(metadata.resource).toBe(`${APP_URL}/api/mcp`);
			expect(metadata.resource_name).toBe("Shiplet Code Mode MCP");
		}
	});

	it("publishes HTML as a new Shiplet that list_shiplets then returns", async () => {
		const token = oauthToken(uniqueEmail("plugin-publish"));
		const result = await callTool(token, PLUGIN_TOOL.publishHtml, {
			name: "Café Pricing Page!",
			files: [
				{
					path: "index.html",
					content:
						'<!doctype html><link rel="stylesheet" href="css/site.css"><h1>Café prices</h1>',
				},
				{ path: "./css/site.css", content: "h1 { color: rebeccapurple; }" },
			],
			visibility: "public",
		});
		expect(result.isError).toBeFalsy();
		const published = result.structuredContent as PublishResult;
		expect(published.view).toBe("published");
		expect(published.shiplet).toMatchObject({
			name: "Café Pricing Page!",
			visibility: "public",
			archived: false,
			openFeedbackCount: 0,
		});
		expect(published.shiplet.reviewUrl).toMatch(
			/^https:\/\/shiplet\.cc\/cafe-pricing-page-[a-z0-9]{6}$/,
		);
		expect(JSON.stringify(published)).not.toMatch(
			/organization_id|owner_user_id|@example\.com/,
		);
		expect(result.content?.[0]?.text).toContain(published.shiplet.reviewUrl);

		const subdomain = new URL(published.shiplet.reviewUrl).pathname.slice(1);
		const frame = await request(`/${subdomain}/__shiplet/artifact-frame/`);
		expect(frame.status).toBe(200);
		expect(await frame.text()).toContain("Café prices");

		const listed = await callTool(token, PLUGIN_TOOL.listShiplets, {});
		const inbox = listed.structuredContent as ShipletListResult;
		expect(inbox.view).toBe("inbox");
		expect(inbox.shiplets).toContainEqual(
			expect.objectContaining({
				id: published.shiplet.id,
				reviewUrl: published.shiplet.reviewUrl,
				openFeedbackCount: null,
			}),
		);
		for (const shiplet of inbox.shiplets) {
			expect(Object.keys(shiplet).sort()).toEqual(
				[
					"archived",
					"id",
					"name",
					"openFeedbackCount",
					"reviewUrl",
					"updatedAt",
					"visibility",
				].sort(),
			);
		}

		const second = await publish(token, "Café Pricing Page!");
		expect(second.id).not.toBe(published.shiplet.id);
		expect(second.reviewUrl).not.toBe(published.shiplet.reviewUrl);
	});

	it("rejects unsafe paths, unsupported files and a missing index.html before publishing", async () => {
		const token = oauthToken(uniqueEmail("plugin-reject"));
		const cases: Array<[Array<{ path: string; content: string }>, RegExp]> = [
			[
				[
					{ path: "index.html", content: "<h1>ok</h1>" },
					{ path: "../escape.html", content: "x" },
				],
				/Unsafe file path/,
			],
			[
				[
					{ path: "index.html", content: "<h1>ok</h1>" },
					{ path: "assets/../../escape.html", content: "x" },
				],
				/Unsafe file path/,
			],
			[[{ path: "/index.html", content: "<h1>abs</h1>" }], /Unsafe file path/],
			[[{ path: "C:\\site\\index.html", content: "<h1>win</h1>" }], /Unsafe file path/],
			[[{ path: "about.html", content: "<h1>no index</h1>" }], /index\.html/],
			[[{ path: "pages/index.html", content: "<h1>nested</h1>" }], /index\.html/],
			[[{ path: "index.html", content: "" }], /index\.html/],
			[
				[
					{ path: "index.html", content: "<h1>ok</h1>" },
					{ path: "tool.exe", content: "MZ" },
				],
				/Unsupported file type/,
			],
			[
				[
					{ path: "index.html", content: "<h1>ok</h1>" },
					{ path: "INDEX.html", content: "<h1>dup</h1>" },
				],
				/Duplicate file path/,
			],
		];
		for (const [files, message] of cases) {
			const result = await callTool(token, PLUGIN_TOOL.publishHtml, {
				name: "Rejected",
				files,
			});
			expect(errorText(result), JSON.stringify(files)).toMatch(message);
		}
		const listed = await callTool(token, PLUGIN_TOOL.listShiplets, {
			status: "all",
		});
		expect((listed.structuredContent as ShipletListResult).shiplets).toEqual([]);

		const nonHttp = await callTool(token, PLUGIN_TOOL.reviewUrl, {
			name: "Not a web page",
			url: "file:///etc/passwd",
		});
		expect(errorText(nonHttp)).toMatch(/http or https/);
	});

	it("lists, reads, replies to, and resolves feedback for the owner", async () => {
		const token = oauthToken(uniqueEmail("plugin-owner"));
		const shiplet = await publish(token, "Feedback Shiplet");
		const feedbackId = await createFeedback(
			token,
			shiplet.id,
			"The pricing table overflows on mobile.\nSecond line with details.",
		);

		const listed = await callTool(token, PLUGIN_TOOL.listFeedback, {
			shiplet_id: shiplet.id,
		});
		expect(listed.isError).toBeFalsy();
		const list = listed.structuredContent as FeedbackListResult;
		expect(list.view).toBe("feedback");
		expect(list.shiplet).toEqual({
			id: shiplet.id,
			name: "Feedback Shiplet",
			reviewUrl: shiplet.reviewUrl,
		});
		expect(list.feedback).toHaveLength(1);
		expect(list.feedback[0]).toMatchObject({
			id: feedbackId,
			shipletId: shiplet.id,
			status: "New",
			authorName: "Riley Reviewer",
			pageUrl: "https://example.com/pricing",
			replyCount: 0,
			url: `${APP_URL}/shiplets/${shiplet.id}?feedback=${feedbackId}`,
		});
		const emailNamed = await createFeedback(
			token,
			shiplet.id,
			"Named only by an email address.",
			"reviewer.person@example.org",
		);
		const withEmailName = await callTool(token, PLUGIN_TOOL.getFeedback, {
			shiplet_id: shiplet.id,
			feedback_id: emailNamed,
		});
		const emailDetail = withEmailName.structuredContent as FeedbackDetailResult;
		expect(emailDetail.feedback.authorName).toBeNull();
		expect(JSON.stringify(withEmailName)).not.toContain("reviewer.person@");
		const listedWithEmail = await callTool(token, PLUGIN_TOOL.listFeedback, {
			shiplet_id: shiplet.id,
		});
		expect(JSON.stringify(listedWithEmail)).not.toMatch(/@example\.(org|com)/);
		await callTool(token, PLUGIN_TOOL.updateFeedbackStatus, {
			shiplet_id: shiplet.id,
			feedback_id: emailNamed,
			status: "Dropped",
		});

		expect(list.feedback[0].title).toMatch(
			/The pricing table overflows on mobile\.$/,
		);
		expect(JSON.stringify(list)).not.toMatch(/@example\.com|organization_id/);

		const detail = await callTool(token, PLUGIN_TOOL.getFeedback, {
			shiplet_id: shiplet.id,
			feedback_id: feedbackId,
		});
		const detailContent = detail.structuredContent as FeedbackDetailResult;
		expect(detailContent.view).toBe("feedback-detail");
		expect(detailContent.feedback.comment).toContain("Second line with details.");
		expect(detailContent.feedback.replies).toEqual([]);
		expect(detailContent.shiplet?.id).toBe(shiplet.id);

		const replied = await callTool(token, PLUGIN_TOOL.replyToFeedback, {
			shiplet_id: shiplet.id,
			feedback_id: feedbackId,
			comment: "Fixed in the next revision.",
		});
		expect(replied.isError).toBeFalsy();
		const replyContent = replied.structuredContent as FeedbackDetailResult;
		expect(replyContent.feedback.replies).toHaveLength(1);
		expect(replyContent.feedback.replies[0]).toMatchObject({
			comment: "Fixed in the next revision.",
			authorName: null,
		});
		expect(JSON.stringify(replyContent)).not.toContain("@example.com");

		const updated = await callTool(token, PLUGIN_TOOL.updateFeedbackStatus, {
			shiplet_id: shiplet.id,
			feedback_id: feedbackId,
			status: "Done",
		});
		expect(
			(updated.structuredContent as FeedbackDetailResult).feedback.status,
		).toBe("Done");

		const openOnly = await callTool(token, PLUGIN_TOOL.listFeedback, {
			shiplet_id: shiplet.id,
		});
		expect((openOnly.structuredContent as FeedbackListResult).feedback).toEqual(
			[],
		);
		const withClosed = await callTool(token, PLUGIN_TOOL.listFeedback, {
			shiplet_id: shiplet.id,
			include_closed: true,
		});
		expect(
			(withClosed.structuredContent as FeedbackListResult).feedback.find(
				(item) => item.id === feedbackId,
			),
		).toMatchObject({ id: feedbackId, status: "Done", replyCount: 1 });

		const missing = await callTool(token, PLUGIN_TOOL.getFeedback, {
			shiplet_id: shiplet.id,
			feedback_id: "review_does_not_exist",
		});
		expect(errorText(missing)).toMatch(/not found/i);

		const invalidStatus = await callTool(
			token,
			PLUGIN_TOOL.updateFeedbackStatus,
			{ shiplet_id: shiplet.id, feedback_id: feedbackId, status: "Closed" },
		);
		expect(invalidStatus.isError).toBe(true);
	});

	it("denies another user's Shiplet feedback without returning data", async () => {
		const ownerToken = oauthToken(uniqueEmail("plugin-victim"));
		const intruderToken = oauthToken(uniqueEmail("plugin-intruder"));
		const shiplet = await publish(ownerToken, "Private Shiplet", {
			visibility: "private",
		});
		const feedbackId = await createFeedback(
			ownerToken,
			shiplet.id,
			"Confidential launch copy.",
		);
		await publish(intruderToken, "Intruder Shiplet");

		const attempts: Array<[string, Record<string, unknown>]> = [
			[PLUGIN_TOOL.listFeedback, { shiplet_id: shiplet.id }],
			[
				PLUGIN_TOOL.getFeedback,
				{ shiplet_id: shiplet.id, feedback_id: feedbackId },
			],
			[
				PLUGIN_TOOL.updateFeedbackStatus,
				{ shiplet_id: shiplet.id, feedback_id: feedbackId, status: "Dropped" },
			],
			[
				PLUGIN_TOOL.replyToFeedback,
				{
					shiplet_id: shiplet.id,
					feedback_id: feedbackId,
					comment: "Injected reply",
				},
			],
		];
		for (const [name, args] of attempts) {
			const result = await callTool(intruderToken, name, args);
			const text = errorText(result);
			expect(text, name).toMatch(/access/i);
			expect(text, name).not.toContain("Confidential");
		}

		const intruderInbox = await callTool(
			intruderToken,
			PLUGIN_TOOL.listShiplets,
			{ status: "all" },
		);
		expect(
			(intruderInbox.structuredContent as ShipletListResult).shiplets.map(
				(item) => item.id,
			),
		).not.toContain(shiplet.id);

		const ownerView = await callTool(ownerToken, PLUGIN_TOOL.getFeedback, {
			shiplet_id: shiplet.id,
			feedback_id: feedbackId,
		});
		const ownerFeedback = (ownerView.structuredContent as FeedbackDetailResult)
			.feedback;
		expect(ownerFeedback.status).toBe("New");
		expect(ownerFeedback.replies).toEqual([]);
	});

	it("returns matching Shiplets as resource links for @-mentions", async () => {
		const token = oauthToken(uniqueEmail("plugin-mentions"));
		const alpha = await publish(token, "Alpha Launch Page");
		const beta = await publish(token, "Beta Checkout Flow");

		const search = async (query: string) => {
			const result = await callTool(token, PLUGIN_TOOL.searchMentions, {
				query,
			});
			expect(result.isError).toBeFalsy();
			return (result.structuredContent as {
				items: Array<Record<string, string>>;
			}).items;
		};

		const matches = await search("launch");
		expect(matches).toEqual([
			{
				type: "resource_link",
				uri: alpha.reviewUrl,
				name: "Alpha Launch Page",
				title: "Alpha Launch Page",
				description: expect.stringContaining(alpha.id),
			},
		]);
		expect((await search("CHECKOUT")).map((item) => item.uri)).toEqual([
			beta.reviewUrl,
		]);
		expect(await search("no such shiplet")).toEqual([]);
		const all = await search("");
		expect(all.map((item) => item.uri).sort()).toEqual(
			[alpha.reviewUrl, beta.reviewUrl].sort(),
		);
		expect(all.length).toBeLessThanOrEqual(20);
	});

	it("publishes into the only workspace and guides multi-workspace accounts", async () => {
		const email = uniqueEmail("plugin-workspaces");
		const token = oauthToken(email);
		const first = await createWorkspace(email, "Studio One");

		const single = await publish(token, "Single Workspace Page");
		expect(
			(await restProjects(email)).find((project) => project.id === single.id)
				?.organization_id,
		).toBe(first);

		const second = await createWorkspace(email, "Client Team");
		const listed = await callTool(token, PLUGIN_TOOL.listWorkspaces, {});
		expect(listed.isError).toBeFalsy();
		const workspaces = listed.structuredContent as WorkspaceListResult;
		expect(workspaces.view).toBe("workspaces");
		expect(workspaces.workspaces).toEqual(
			expect.arrayContaining([
				{ id: first, name: "Studio One" },
				{ id: second, name: "Client Team" },
			]),
		);
		expect(workspaces.workspaces).toHaveLength(2);
		expect(JSON.stringify(workspaces)).not.toContain("@");

		const guided = await callTool(token, PLUGIN_TOOL.publishHtml, {
			name: "Ambiguous Workspace Page",
			files: [{ path: "index.html", content: "<h1>Which one?</h1>" }],
		});
		const guidance = errorText(guided);
		expect(guidance).toMatch(/more than one workspace/);
		expect(guidance).toMatch(/list_workspaces/);
		expect(guidance).toMatch(/ask the user/);
		const urlGuided = await callTool(token, PLUGIN_TOOL.reviewUrl, {
			name: "Ambiguous URL Review",
			url: "https://example.com/",
		});
		expect(errorText(urlGuided)).toMatch(/more than one workspace/);
		expect(await restProjects(email)).toHaveLength(1);

		const chosen = await publish(token, "Client Team Page", {
			workspace_id: second,
		});
		expect(
			(await restProjects(email)).find((project) => project.id === chosen.id)
				?.organization_id,
		).toBe(second);

		const outsiderEmail = uniqueEmail("plugin-outsider-org");
		const foreign = await createWorkspace(outsiderEmail, "Someone Else");
		const denied = await callTool(token, PLUGIN_TOOL.publishHtml, {
			name: "Foreign Workspace Page",
			files: [{ path: "index.html", content: "<h1>No</h1>" }],
			workspace_id: foreign,
		});
		expect(errorText(denied)).toMatch(/can't publish to that workspace/);
		expect(await restProjects(email)).toHaveLength(2);
		expect(await restProjects(outsiderEmail)).toHaveLength(0);
	});

	it("scopes GET /api/organizations to what each credential may see", async () => {
		const email = uniqueEmail("plugin-org-scope");
		const first = await createWorkspace(email, "Scoped One");
		const second = await createWorkspace(email, "Scoped Two");

		const anonymous = await request("/api/organizations");
		expect(anonymous.status).toBe(401);

		const session = await request("/api/organizations", {
			headers: sessionHeaders(email),
		});
		expect(session.status).toBe(200);
		const sessionBody = (await session.json()) as {
			organizations: Array<Record<string, unknown>>;
		};
		expect(sessionBody.organizations).toHaveLength(2);
		expect(sessionBody.organizations).toEqual(
			expect.arrayContaining([
				{ id: first, name: "Scoped One", role: "admin" },
				{ id: second, name: "Scoped Two", role: "admin" },
			]),
		);

		const createKey = async (scopes: string[]) => {
			const response = await request(`/api/organizations/${first}/api-tokens`, {
				method: "POST",
				headers: {
					...sessionHeaders(email),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					name: `Plugin ${scopes.join(" ")}`,
					scopes,
					projectAccessMode: "all",
					projectRules: [],
				}),
			});
			expect(response.status).toBe(201);
			return ((await response.json()) as { token: string }).token;
		};

		const readKey = await createKey(["mcp", "shiplets:read"]);
		const keyed = await request("/api/organizations", {
			headers: { authorization: `Bearer ${readKey}` },
		});
		expect(keyed.status).toBe(200);
		expect(await keyed.json()).toEqual({
			organizations: [{ id: first, name: "Scoped One", role: null }],
		});
		const keyedTool = await callTool(readKey, PLUGIN_TOOL.listWorkspaces, {});
		expect(
			(keyedTool.structuredContent as WorkspaceListResult).workspaces,
		).toEqual([{ id: first, name: "Scoped One" }]);

		const writeOnlyKey = await createKey(["mcp", "shiplets:write"]);
		const writeOnly = await request("/api/organizations", {
			headers: { authorization: `Bearer ${writeOnlyKey}` },
		});
		expect(writeOnly.status).toBe(403);
		expect(
			errorText(await callTool(writeOnlyKey, PLUGIN_TOOL.listWorkspaces, {})),
		).toMatch(/not allowed to list workspaces/);
		// Without read access the credential's own organization still applies.
		const keyPublished = await publish(writeOnlyKey, "Key Published Page");
		expect(
			(await restProjects(email)).find(
				(project) => project.id === keyPublished.id,
			)?.organization_id,
		).toBe(first);

		const encode = (claims: Record<string, unknown>) =>
			btoa(JSON.stringify(claims))
				.replace(/=/g, "")
				.replace(/\+/g, "-")
				.replace(/\//g, "_");
		const agentToken = (orgId: string | undefined) =>
			`shiplet_mcp_principal_${encode({
				sub: oauthUserId(email),
				client_id: "client_chatgpt_plugin",
				sid: "consent_plugin_orgs",
				...(orgId ? { org_id: orgId } : {}),
				permissions: ["shiplets:read"],
				email,
			})}`;
		const agentTool = await callTool(
			agentToken(second),
			PLUGIN_TOOL.listWorkspaces,
			{},
		);
		expect(
			(agentTool.structuredContent as WorkspaceListResult).workspaces,
		).toEqual([{ id: second, name: "Scoped Two" }]);
		expect(
			errorText(
				await callTool(agentToken(undefined), PLUGIN_TOOL.listWorkspaces, {}),
			),
		).toMatch(/not allowed to list workspaces/);
	});

	it("applies delegated OAuth and agent-registration permissions like /api/mcp", async () => {
		const encode = (claims: Record<string, unknown>) =>
			btoa(JSON.stringify(claims))
				.replace(/=/g, "")
				.replace(/\+/g, "-")
				.replace(/\//g, "_");
		const delegated = (permissions: string[]) =>
			`shiplet_mcp_principal_${encode({
				sub: `user_plugin_delegated_${crypto.randomUUID().slice(0, 8)}`,
				client_id: "client_chatgpt_plugin",
				sid: "consent_plugin",
				org_id: "org_plugin_delegated",
				permissions,
				email: uniqueEmail("plugin-delegated"),
			})}`;

		const allowed = await callTool(
			delegated(["shiplets:read"]),
			PLUGIN_TOOL.listShiplets,
			{},
		);
		expect(allowed.isError).toBeFalsy();
		expect((allowed.structuredContent as ShipletListResult).shiplets).toEqual(
			[],
		);

		const denied = await callTool(
			delegated(["feedback:read"]),
			PLUGIN_TOOL.listShiplets,
			{},
		);
		expect(errorText(denied)).toMatch(/not allowed to list Shiplets/);

		const registration = `shiplet_agent_registration_${encode({
			sub: "agent_reg_plugin_without_mcp",
			act: { sub: "user_plugin_registration" },
			org_id: "org_plugin_registration",
			scope: "openid shiplets:read",
			email: uniqueEmail("plugin-registration"),
		})}`;
		const response = await rpc(registration, "tools/list");
		expect(response.status).toBe(403);
	});

	it("rejects oversize bodies and non-POST methods", async () => {
		const token = oauthToken(uniqueEmail("plugin-limits"));
		const oversize = "x".repeat(3 * 1024 * 1024 + 1);
		const tooLarge = await request(PLUGIN_MCP_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(oversize.length),
				authorization: `Bearer ${token}`,
			},
			body: oversize,
		});
		expect(tooLarge.status).toBe(413);

		// A body over /api/mcp's 128 KiB limit is still accepted here.
		const largeButAllowed = await callTool(token, PLUGIN_TOOL.publishHtml, {
			name: "Large Page",
			files: [
				{
					path: "index.html",
					content: `<!doctype html><p>${"a".repeat(400 * 1024)}</p>`,
				},
			],
		});
		expect(largeButAllowed.isError).toBeFalsy();

		for (const method of ["GET", "DELETE"]) {
			const response = await request(PLUGIN_MCP_PATH, { method });
			expect(response.status, method).toBe(405);
			expect(response.headers.get("allow"), method).toBe("POST");
		}
	});

	it("serves the OpenAI domain-verification token only when configured", async () => {
		const missing = await request("/.well-known/openai-apps-challenge");
		expect(missing.status).toBe(404);

		const configured = await request(
			"/.well-known/openai-apps-challenge",
			{},
			{ ...testEnv, OPENAI_APPS_CHALLENGE_TOKEN: "challenge-token-123" },
		);
		expect(configured.status).toBe(200);
		expect(configured.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(configured.headers.get("cache-control")).toBe("no-store");
		expect(await configured.text()).toBe("challenge-token-123");
	});
});
