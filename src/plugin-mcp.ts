// Shiplet's ChatGPT plugin MCP server (`POST /api/plugin/mcp`).
//
// Unlike the Code Mode server at /api/mcp, every model-callable operation is a
// separate, individually described tool. Each tool is a thin adapter over one
// documented REST operation: the injected `execute` callback runs that
// operation through the same trusted Code Mode request path as /api/mcp, so
// authorization, scopes and audit are identical to the REST API. This module
// never reads the database itself.

import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import {
	McpServer,
	type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import {
	ListToolsRequestSchema,
	type CallToolResult,
	type Icon,
	type ResourceLink,
	type Tool,
	type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type {
	OpenAIUiResourceMetadata,
	OpenAIUiToolMetadata,
} from "@openai/mcp-extensions/server";
import { z } from "zod";
import type { CodeModeRequestOptions } from "./codemode";
import {
	FEEDBACK_STATUSES,
	PLUGIN_APP_RESOURCE_URI,
	PLUGIN_MCP_SERVER_NAME,
	PLUGIN_MCP_SERVER_TITLE,
	PLUGIN_TOOL,
	PLUGIN_VISIBILITIES,
	PUBLISH_HTML_LIMITS,
	type FeedbackDetailResult,
	type FeedbackListResult,
	type FeedbackStatus,
	type HtmlFileResult,
	type PluginFeedbackDetail,
	type PluginFeedbackSummary,
	type PluginShiplet,
	type PluginVisibility,
	type PluginWorkspace,
	type PublishResult,
	type ShipletListResult,
	type WorkspaceListResult,
} from "./plugin-contract";
import {
	ALLOWED_STATIC_ASSET_EXTENSIONS,
	ALLOWED_STATIC_ASSET_FILENAMES,
	BLOCKED_STATIC_ASSET_EXTENSIONS,
	staticAssetExtension,
	staticAssetFileName,
} from "./static-asset-types";

export const PLUGIN_MCP_SERVER_VERSION = "1.0.0";
/** Publishing sends file contents, so this is larger than /api/mcp's limit. */
export const PLUGIN_MCP_MAX_REQUEST_BYTES = 3 * 1024 * 1024;

const PLUGIN_MCP_INSTRUCTIONS = [
	"Shiplet turns HTML files and web pages into shareable review links where collaborators leave feedback pinned to the page.",
	"Use these tools when the user wants to publish HTML or a URL for review, find their Shiplets, read or triage review feedback, or reply to it.",
	"Every tool acts only on Shiplets the connected Shiplet account can already access, and replies are posted as that account.",
].join(" ");

const MAX_LISTED_MENTIONS = 20;
const MAX_TITLE_CHARS = 80;
const SUBDOMAIN_SLUG_MAX = 40;
const SUBDOMAIN_SUFFIX_LENGTH = 6;
const SUBDOMAIN_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Monochrome 20x20 sail-and-hull mark drawn with 1.33px currentColor strokes.
const SHIPLET_ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round">' +
	'<path d="M10 2.75v10.5"/>' +
	'<path d="M10 4.25l4.75 8H10"/>' +
	'<path d="M10 6.75l-3.5 5.5H10"/>' +
	'<path d="M3.25 14.75h13.5l-1.9 2.5H5.15z"/>' +
	"</svg>";
export const SHIPLET_TOOL_ICON: Icon = {
	src: `data:image/svg+xml,${encodeURIComponent(SHIPLET_ICON_SVG)}`,
	mimeType: "image/svg+xml",
	sizes: ["any"],
};

export type PluginMcpExecute = (
	request: CodeModeRequestOptions,
) => Promise<unknown>;

export type PluginMcpServerOptions = {
	/** Shiplet app origin, e.g. https://shiplet.cc. */
	appUrl: string;
	/** Artifact apex domain when Shiplets are served on subdomains. */
	customDomain?: string | null;
	/** Runs one documented REST operation as the authenticated principal. */
	execute: PluginMcpExecute;
	/** MCP App HTML served as the UI resource. */
	appHtml: string;
};

type Failure = "invalid" | "denied" | "not_found" | "conflict" | "failed";

/** Raised when a REST operation fails; carries only a coarse, non-sensitive reason. */
class RestFailure extends Error {
	constructor(readonly reason: Failure) {
		super(reason);
	}
}

/** Raised for plugin-side input validation with a user-facing message. */
class PluginInputError extends Error {}

// executeTrustedCodeModeRequest reduces REST errors to these fixed messages.
const FAILURE_BY_MESSAGE: Record<string, Failure> = {
	"Request invalid": "invalid",
	"Authorization denied": "denied",
	"Operation unavailable": "not_found",
	"Request conflict": "conflict",
};

const DEFAULT_FAILURE_MESSAGES: Record<Failure, string> = {
	invalid: "Shiplet rejected the request as invalid.",
	denied: "You don't have access to that Shiplet.",
	not_found: "Shiplet not found.",
	conflict: "The request conflicts with the Shiplet's current state. Try again.",
	failed: "Shiplet could not complete the request. Try again.",
};

const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: false,
};

const idSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use the ID returned by Shiplet.");
const visibilitySchema = z
	.enum(PLUGIN_VISIBILITIES)
	.optional()
	.describe(
		"Who can open the review link. Omit to use the workspace default (organization).",
	);
const workspaceIdSchema = idSchema
	.optional()
	.describe(
		"Workspace to create the Shiplet in, from list_workspaces. Required only when the account belongs to more than one workspace.",
	);
const MULTIPLE_WORKSPACES_MESSAGE =
	"This Shiplet account belongs to more than one workspace, so the workspace must be chosen before publishing. Call list_workspaces, ask the user which workspace to use, then call this tool again with that workspace_id. Nothing was published.";
const shipletNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.describe("Name shown to reviewers, 1-120 characters.");

export function createPluginMcpServer(options: PluginMcpServerOptions) {
	const appUrl = options.appUrl.replace(/\/+$/, "");
	const appOrigin = new URL(appUrl).origin;
	const customDomain = options.customDomain?.trim() || null;

	const server = new McpServer(
		{
			name: PLUGIN_MCP_SERVER_NAME,
			title: PLUGIN_MCP_SERVER_TITLE,
			version: PLUGIN_MCP_SERVER_VERSION,
			icons: [SHIPLET_TOOL_ICON],
		},
		{ instructions: PLUGIN_MCP_INSTRUCTIONS },
	);

	const toolIcons = new Map<string, Icon[]>();
	const registered = new Map<string, RegisteredTool>();
	const track = (name: string, tool: RegisteredTool, icons?: Icon[]) => {
		registered.set(name, tool);
		if (icons) toolIcons.set(name, icons);
	};

	// ---- REST adapters --------------------------------------------------

	async function rest(request: CodeModeRequestOptions) {
		try {
			return await options.execute(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			throw new RestFailure(FAILURE_BY_MESSAGE[message] ?? "failed");
		}
	}

	function reviewUrlFor(subdomain: string) {
		return customDomain
			? `https://${subdomain}.${customDomain}`
			: `${appUrl}/${subdomain}`;
	}

	function feedbackUrlFor(shipletId: string, feedbackId: string) {
		return `${appUrl}/shiplets/${encodeURIComponent(shipletId)}?feedback=${encodeURIComponent(feedbackId)}`;
	}

	function toShiplet(
		value: unknown,
		openFeedbackCount: number | null = null,
	): PluginShiplet | null {
		if (!isRecord(value)) return null;
		const id = str(value.id);
		const name = str(value.name);
		const subdomain = str(value.subdomain);
		if (!id || !name || !subdomain) return null;
		return {
			id,
			name,
			reviewUrl: reviewUrlFor(subdomain),
			visibility: PLUGIN_VISIBILITIES.includes(
				value.visibility as PluginVisibility,
			)
				? (value.visibility as PluginVisibility)
				: "organization",
			archived: Boolean(str(value.archived_on)),
			openFeedbackCount,
			updatedAt: str(value.modified_on),
		};
	}

	function toFeedbackSummary(value: unknown): PluginFeedbackSummary | null {
		if (!isRecord(value)) return null;
		const id = str(value.id);
		const shipletId = str(value.project_id);
		const status = FEEDBACK_STATUSES.includes(value.status as FeedbackStatus)
			? (value.status as FeedbackStatus)
			: null;
		if (!id || !shipletId || !status) return null;
		return {
			id,
			shipletId,
			title: feedbackTitle(str(value.ticket_label), str(value.comment)),
			status,
			authorName: personName(value.name),
			pageUrl: str(value.page_url),
			replyCount: Array.isArray(value.replies) ? value.replies.length : 0,
			createdAt: str(value.created_on),
			url: feedbackUrlFor(shipletId, id),
		};
	}

	function toFeedbackDetail(value: unknown): PluginFeedbackDetail | null {
		const summary = toFeedbackSummary(value);
		if (!summary || !isRecord(value)) return null;
		const replies = Array.isArray(value.replies) ? value.replies : [];
		return {
			...summary,
			comment: str(value.comment) ?? "",
			replies: replies.flatMap((reply) => {
				if (!isRecord(reply)) return [];
				const id = str(reply.id);
				if (!id) return [];
				return [
					{
						id,
						// Replies carry only an account email, which is not returned.
						authorName: null,
						comment: str(reply.comment) ?? "",
						createdAt: str(reply.created_on),
					},
				];
			}),
		};
	}

	async function listShiplets(status: "active" | "archived" | "all") {
		const result = await rest({
			method: "GET",
			path: "/api/shiplets",
			query: { status },
		});
		const projects =
			isRecord(result) && Array.isArray(result.projects) ? result.projects : [];
		return projects.flatMap((project) => {
			const shiplet = toShiplet(project);
			return shiplet ? [shiplet] : [];
		});
	}

	async function listWorkspaces(): Promise<PluginWorkspace[]> {
		const result = await rest({ method: "GET", path: "/api/organizations" });
		const organizations =
			isRecord(result) && Array.isArray(result.organizations)
				? result.organizations
				: [];
		return organizations.flatMap((organization) => {
			if (!isRecord(organization)) return [];
			const id = str(organization.id);
			const name = str(organization.name);
			return id && name ? [{ id, name }] : [];
		});
	}

	/**
	 * The REST publish path cannot guess a workspace for an account with
	 * several, so choose it here: an explicit workspace_id wins, a single
	 * workspace is passed explicitly, and several stop before publishing.
	 * When the workspaces cannot be listed (for example a credential without
	 * read access), REST decides from the credential as it always has.
	 */
	async function resolveWorkspaceId(workspaceId: string | undefined) {
		if (workspaceId) return workspaceId;
		let workspaces: PluginWorkspace[];
		try {
			workspaces = await listWorkspaces();
		} catch {
			return undefined;
		}
		if (workspaces.length > 1) {
			throw new PluginInputError(MULTIPLE_WORKSPACES_MESSAGE);
		}
		return workspaces[0]?.id;
	}

	/** Best-effort name and link for a Shiplet the caller already proved access to. */
	async function shipletLabel(
		shipletId: string,
	): Promise<Pick<PluginShiplet, "id" | "name" | "reviewUrl"> | null> {
		try {
			const match = (await listShiplets("all")).find(
				(shiplet) => shiplet.id === shipletId,
			);
			return match
				? { id: match.id, name: match.name, reviewUrl: match.reviewUrl }
				: null;
		} catch {
			return null;
		}
	}

	async function getFeedbackDetail(shipletId: string, feedbackId: string) {
		const result = await rest({
			method: "GET",
			path: feedbackPath(shipletId, feedbackId),
		});
		const detail = toFeedbackDetail(isRecord(result) ? result.feedback : null);
		if (!detail) throw new RestFailure("not_found");
		return detail;
	}

	async function createShiplet(
		name: string,
		source: Record<string, unknown>,
		visibility: PluginVisibility | undefined,
		workspaceId: string | undefined,
	) {
		const organizationId = await resolveWorkspaceId(workspaceId);
		const slug = subdomainSlug(name);
		for (let attempt = 0; ; attempt += 1) {
			try {
				const result = await rest({
					method: "POST",
					path: "/api/shiplets",
					body: {
						name,
						subdomain: `${slug}-${randomSuffix()}`,
						...source,
						...(organizationId ? { organization_id: organizationId } : {}),
						...(visibility ? { visibility } : {}),
					},
				});
				const shiplet = toShiplet(isRecord(result) ? result.project : null, 0);
				if (!shiplet) throw new RestFailure("failed");
				return shiplet;
			} catch (error) {
				// A random-suffix collision is the only expected conflict; retry once.
				if (
					attempt === 0 &&
					error instanceof RestFailure &&
					error.reason === "conflict"
				) {
					continue;
				}
				throw error;
			}
		}
	}

	// ---- Result helpers -------------------------------------------------

	const ok = (
		text: string,
		structuredContent: Record<string, unknown>,
	): CallToolResult => ({
		content: [{ type: "text", text }],
		structuredContent,
	});

	async function guard(
		messages: Partial<Record<Failure, string>>,
		run: () => Promise<CallToolResult>,
	): Promise<CallToolResult> {
		try {
			return await run();
		} catch (error) {
			let text = DEFAULT_FAILURE_MESSAGES.failed;
			if (error instanceof PluginInputError) text = error.message;
			else if (error instanceof RestFailure) {
				text = messages[error.reason] ?? DEFAULT_FAILURE_MESSAGES[error.reason];
			}
			return { content: [{ type: "text", text }], isError: true };
		}
	}

	const feedbackMessages = {
		not_found: "Shiplet or feedback not found.",
	} satisfies Partial<Record<Failure, string>>;

	async function inboxResult(): Promise<CallToolResult> {
		const shiplets = await listShiplets("active");
		const result: ShipletListResult = { view: "inbox", shiplets };
		return ok(shipletListText(shiplets), result);
	}

	// ---- Model-visible tools --------------------------------------------

	track(
		PLUGIN_TOOL.listShiplets,
		server.registerTool(
			PLUGIN_TOOL.listShiplets,
			{
				title: "List Shiplets",
				description:
					"List the Shiplets (review links for HTML pages and websites) that the connected Shiplet account can access, with each Shiplet's ID, name, review link, visibility, and archive state. Use this to find a Shiplet ID before reading its feedback. Defaults to active Shiplets; pass status \"archived\" or \"all\" to include archived ones. Read-only.",
				inputSchema: z.object({
					status: z
						.enum(["active", "archived", "all"])
						.default("active")
						.describe("Which Shiplets to include. Defaults to active."),
				}),
				annotations: READ_ONLY,
			},
			async ({ status }) =>
				guard(
					{ denied: "This Shiplet connection is not allowed to list Shiplets." },
					async () => {
						const shiplets = await listShiplets(status);
						const result: ShipletListResult = { view: "inbox", shiplets };
						return ok(shipletListText(shiplets), result);
					},
				),
		),
	);

	track(
		PLUGIN_TOOL.listFeedback,
		server.registerTool(
			PLUGIN_TOOL.listFeedback,
			{
				title: "List feedback",
				description:
					"List review feedback left on one Shiplet, newest first, with each item's ID, title, status, author name, page URL, and reply count. By default only unresolved feedback is returned (everything except Done and Dropped); set include_closed to include resolved items, or filter by an exact status or page URL. Returns at most `limit` items (default 25, maximum 100). Read-only.",
				inputSchema: z.object({
					shiplet_id: idSchema.describe("Shiplet ID from list_shiplets."),
					status: z
						.enum(FEEDBACK_STATUSES)
						.optional()
						.describe("Only return feedback with this status."),
					include_closed: z
						.boolean()
						.optional()
						.describe("Include Done and Dropped feedback. Defaults to false."),
					page_url: z
						.string()
						.max(2048)
						.optional()
						.describe(
							"Only return feedback left on this exact page URL (http or https).",
						),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.describe("Maximum items to return, 1-100. Defaults to 25."),
				}),
				annotations: READ_ONLY,
			},
			async ({ shiplet_id, status, include_closed, page_url, limit }) =>
				guard(feedbackMessages, async () => {
					if (page_url !== undefined) assertHttpUrl(page_url, "page_url");
					const query: Record<string, string | number | boolean> = { limit };
					if (status) query.status = status;
					if (include_closed) query.includeClosed = true;
					if (page_url) query.pageUrl = page_url;
					const response = await rest({
						method: "GET",
						path: `/api/projects/${shiplet_id}/review-feedback`,
						query,
					});
					const items =
						isRecord(response) && Array.isArray(response.feedback)
							? response.feedback
							: [];
					const feedback = items.flatMap((item) => {
						const summary = toFeedbackSummary(item);
						return summary ? [summary] : [];
					});
					const shiplet = (await shipletLabel(shiplet_id)) ?? {
						id: shiplet_id,
						name: "Shiplet",
						reviewUrl: `${appUrl}/shiplets/${encodeURIComponent(shiplet_id)}`,
					};
					const result: FeedbackListResult = {
						view: "feedback",
						shiplet,
						feedback,
					};
					return ok(feedbackListText(shiplet.name, feedback), result);
				}),
		),
	);

	track(
		PLUGIN_TOOL.getFeedback,
		server.registerTool(
			PLUGIN_TOOL.getFeedback,
			{
				title: "Get feedback",
				description:
					"Get one review feedback item on a Shiplet, including its full comment, status, page URL, and every reply in order. Use list_feedback first to find the feedback ID. Read-only.",
				inputSchema: z.object({
					shiplet_id: idSchema.describe("Shiplet ID from list_shiplets."),
					feedback_id: idSchema.describe("Feedback ID from list_feedback."),
				}),
				annotations: READ_ONLY,
			},
			async ({ shiplet_id, feedback_id }) =>
				guard(feedbackMessages, async () => {
					const feedback = await getFeedbackDetail(shiplet_id, feedback_id);
					const shiplet = await shipletLabel(shiplet_id);
					const result: FeedbackDetailResult = {
						view: "feedback-detail",
						feedback,
						...(shiplet ? { shiplet } : {}),
					};
					return ok(feedbackDetailText(feedback), result);
				}),
		),
	);

	track(
		PLUGIN_TOOL.listWorkspaces,
		server.registerTool(
			PLUGIN_TOOL.listWorkspaces,
			{
				title: "List workspaces",
				description:
					"List the Shiplet workspaces the connected account belongs to, with each workspace's ID and name. Use this to choose workspace_id for publish_html_for_review or create_url_review when the account belongs to more than one workspace; ask the user which workspace to use rather than picking one. Read-only.",
				inputSchema: z.object({}),
				annotations: READ_ONLY,
			},
			async () =>
				guard(
					{
						denied:
							"This Shiplet connection is not allowed to list workspaces.",
					},
					async () => {
						const workspaces = await listWorkspaces();
						const result: WorkspaceListResult = {
							view: "workspaces",
							workspaces,
						};
						return ok(workspaceListText(workspaces), result);
					},
				),
		),
	);

	track(
		PLUGIN_TOOL.publishHtml,
		server.registerTool(
			PLUGIN_TOOL.publishHtml,
			{
				title: "Publish HTML for review",
				description: `Publish HTML, CSS, JavaScript, and other text files as a new Shiplet and return its shareable review link, where collaborators can leave feedback pinned to the page. Files must include an index.html at the root; paths are relative (no leading slash, no ".." segments). Limits: ${PUBLISH_HTML_LIMITS.maxFiles} files, ${PUBLISH_HTML_LIMITS.maxTotalBytes / (1024 * 1024)} MB of UTF-8 text in total. Each call creates a new Shiplet, so repeating the call creates another Shiplet rather than updating an existing one. Visibility defaults to the workspace (organization) unless set. If the account belongs to more than one workspace, pass workspace_id from list_workspaces; without it the call fails and nothing is published.`,
				inputSchema: z.object({
					name: shipletNameSchema,
					files: z
						.array(
							z.object({
								path: z
									.string()
									.min(1)
									.max(PUBLISH_HTML_LIMITS.maxPathLength)
									.describe("Relative file path, for example index.html or css/site.css."),
								content: z
									.string()
									.max(PUBLISH_HTML_LIMITS.maxTotalBytes)
									.describe("UTF-8 text content of the file."),
							}),
						)
						.min(1)
						.max(PUBLISH_HTML_LIMITS.maxFiles)
						.describe("Files to publish. Must include index.html at the root."),
					visibility: visibilitySchema,
					workspace_id: workspaceIdSchema,
				}),
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					openWorldHint: true,
				},
			},
			async ({ name, files, visibility, workspace_id }) =>
				guard(
					{
						invalid:
							"Shiplet could not publish these files. Check that the name is valid and every file is a supported web file type.",
						denied:
							"This Shiplet connection can't publish to that workspace. Check workspace_id with list_workspaces.",
					},
					async () => {
						const assets = publishAssets(files);
						const shiplet = await createShiplet(
							name,
							{ assets },
							visibility,
							workspace_id,
						);
						const result: PublishResult = { view: "published", shiplet };
						return ok(publishedText(shiplet), result);
					},
				),
		),
	);

	track(
		PLUGIN_TOOL.reviewUrl,
		server.registerTool(
			PLUGIN_TOOL.reviewUrl,
			{
				title: "Create URL review",
				description:
					"Create a new Shiplet that shows an existing public http or https web page for review and return its shareable review link, where collaborators can leave feedback pinned to the page. Shiplet loads the page from its public address when reviewers open the link. Each call creates a new Shiplet, so repeating the call creates another Shiplet. Visibility defaults to the workspace (organization) unless set. If the account belongs to more than one workspace, pass workspace_id from list_workspaces; without it the call fails and nothing is created.",
				inputSchema: z.object({
					name: shipletNameSchema,
					url: z
						.string()
						.min(1)
						.max(2048)
						.describe("Public http or https URL of the page to review."),
					visibility: visibilitySchema,
					workspace_id: workspaceIdSchema,
				}),
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					openWorldHint: true,
				},
			},
			async ({ name, url, visibility, workspace_id }) =>
				guard(
					{
						invalid:
							"Shiplet could not create a review for that URL. Use a public http or https address.",
						denied:
							"This Shiplet connection can't create Shiplets in that workspace. Check workspace_id with list_workspaces.",
					},
					async () => {
						assertHttpUrl(url, "url");
						const shiplet = await createShiplet(
							name,
							{ external_url: url },
							visibility,
							workspace_id,
						);
						const result: PublishResult = { view: "published", shiplet };
						return ok(publishedText(shiplet), result);
					},
				),
		),
	);

	track(
		PLUGIN_TOOL.replyToFeedback,
		server.registerTool(
			PLUGIN_TOOL.replyToFeedback,
			{
				title: "Reply to feedback",
				description:
					"Post a reply on a review feedback thread in a Shiplet. The reply is posted as the connected Shiplet user, is visible to everyone with access to the Shiplet, may notify people watching the thread, and cannot be edited or deleted from here. Only call this when the user asked to reply and approved the text.",
				inputSchema: z.object({
					shiplet_id: idSchema.describe("Shiplet ID from list_shiplets."),
					feedback_id: idSchema.describe("Feedback ID from list_feedback."),
					comment: z
						.string()
						.trim()
						.min(1)
						.max(5000)
						.describe("Reply text, 1-5000 characters."),
				}),
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					openWorldHint: false,
				},
			},
			async ({ shiplet_id, feedback_id, comment }) =>
				guard(
					{
						...feedbackMessages,
						denied: "You don't have access to reply on that Shiplet.",
					},
					async () => {
						const response = await rest({
							method: "POST",
							path: `${feedbackPath(shiplet_id, feedback_id)}/replies`,
							body: { comment },
						});
						const feedback = toFeedbackDetail(
							isRecord(response) ? response.feedback : null,
						);
						if (!feedback) throw new RestFailure("failed");
						const result: FeedbackDetailResult = {
							view: "feedback-detail",
							feedback,
						};
						return ok(`Reply posted on "${feedback.title}".`, result);
					},
				),
		),
	);

	track(
		PLUGIN_TOOL.updateFeedbackStatus,
		server.registerTool(
			PLUGIN_TOOL.updateFeedbackStatus,
			{
				title: "Update feedback status",
				description: `Set the status of a review feedback item on a Shiplet (${FEEDBACK_STATUSES.join(", ")}). Done and Dropped mark the feedback resolved; the status can be changed again later. People watching the thread may be notified.`,
				inputSchema: z.object({
					shiplet_id: idSchema.describe("Shiplet ID from list_shiplets."),
					feedback_id: idSchema.describe("Feedback ID from list_feedback."),
					status: z.enum(FEEDBACK_STATUSES).describe("New status."),
				}),
				annotations: {
					readOnlyHint: false,
					destructiveHint: false,
					openWorldHint: false,
				},
			},
			async ({ shiplet_id, feedback_id, status }) =>
				guard(
					{
						...feedbackMessages,
						denied: "You don't have access to update feedback on that Shiplet.",
					},
					async () => {
						const response = await rest({
							method: "POST",
							path: `${feedbackPath(shiplet_id, feedback_id)}/status`,
							body: { status },
						});
						const feedback = toFeedbackDetail(
							isRecord(response) ? response.feedback : null,
						);
						if (!feedback) throw new RestFailure("failed");
						const result: FeedbackDetailResult = {
							view: "feedback-detail",
							feedback,
						};
						return ok(
							`Status of "${feedback.title}" is now ${feedback.status}.`,
							result,
						);
					},
				),
		),
	);

	// ---- App-only entrypoint and extension tools -------------------------

	const appOnlyMeta = (
		entrypoints?: OpenAIUiToolMetadata["entrypoints"],
		extra: Record<string, unknown> = {},
	) => ({
		ui: { resourceUri: PLUGIN_APP_RESOURCE_URI, visibility: ["app" as const] },
		...(entrypoints
			? { "openai/ui": { entrypoints } satisfies OpenAIUiToolMetadata }
			: {}),
		...extra,
	});

	track(
		PLUGIN_TOOL.openInbox,
		registerAppTool(
			server,
			PLUGIN_TOOL.openInbox,
			{
				title: "Shiplet reviews",
				description:
					"Open the Shiplet review app with the connected account's active Shiplets. Read-only.",
				annotations: READ_ONLY,
				_meta: appOnlyMeta([{ type: "global" }]),
			},
			async () => guard({}, inboxResult),
		),
		[SHIPLET_TOOL_ICON],
	);

	track(
		PLUGIN_TOOL.openPanel,
		registerAppTool(
			server,
			PLUGIN_TOOL.openPanel,
			{
				title: "Review feedback",
				description:
					"Open a Shiplet review feedback panel beside this conversation, starting from the connected account's active Shiplets. Read-only.",
				annotations: READ_ONLY,
				_meta: appOnlyMeta([{ type: "thread" }]),
			},
			async () => guard({}, inboxResult),
		),
		[SHIPLET_TOOL_ICON],
	);

	track(
		PLUGIN_TOOL.openHtmlFile,
		registerAppTool(
			server,
			PLUGIN_TOOL.openHtmlFile,
			{
				title: "Shiplet preview",
				description:
					"Preview a local .html or .htm file in the Shiplet app. The app reads the file through the host; Shiplet's server never receives the file contents from this tool, and nothing is published until the user chooses to. Read-only.",
				inputSchema: z.object({
					file: z.object({
						name: z.string().min(1).max(255),
						resourceUri: z.string().min(1).max(4096),
					}),
				}),
				annotations: READ_ONLY,
				_meta: appOnlyMeta([{ type: "file", extensions: [".html", ".htm"] }]),
			},
			async ({ file }) =>
				guard({}, async () => {
					const result: HtmlFileResult = {
						view: "html-file",
						fileName: file.name,
					};
					return ok(`Opened ${file.name} in Shiplet preview.`, result);
				}),
		),
		[SHIPLET_TOOL_ICON],
	);

	track(
		PLUGIN_TOOL.searchMentions,
		registerAppTool(
			server,
			PLUGIN_TOOL.searchMentions,
			{
				title: "Find Shiplets",
				description:
					"Search the connected account's active Shiplets by name for @-mentions. Returns up to 20 matches as links; an empty query returns the most recently updated Shiplets. Read-only.",
				inputSchema: z.object({
					query: z.string().max(200).describe("Search text; may be empty."),
				}),
				annotations: READ_ONLY,
				_meta: appOnlyMeta(undefined, {
					"openai/extensions": { "mentions/search": {} },
				}),
			},
			async ({ query }) =>
				guard({}, async () => {
					const needle = query.trim().toLowerCase();
					const matches = (await listShiplets("active"))
						.filter((shiplet) =>
							needle ? shiplet.name.toLowerCase().includes(needle) : true,
						)
						.sort((a, b) =>
							String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
						)
						.slice(0, MAX_LISTED_MENTIONS);
					const items: ResourceLink[] = matches.map((shiplet) => ({
						type: "resource_link",
						uri: shiplet.reviewUrl,
						name: shiplet.name,
						title: shiplet.name,
						description: `Shiplet ID ${shiplet.id}. Review link: ${shiplet.reviewUrl}`,
					}));
					return ok(
						items.length === 0
							? "No matching Shiplets."
							: `${items.length} matching Shiplet${items.length === 1 ? "" : "s"}.`,
						{ items },
					);
				}),
		),
		[SHIPLET_TOOL_ICON],
	);

	// ---- UI resource ----------------------------------------------------

	registerAppResource(
		server,
		"Shiplet review app",
		PLUGIN_APP_RESOURCE_URI,
		{
			title: "Shiplet reviews",
			description: "Shiplet review app for browsing Shiplets and their feedback.",
		},
		async () => ({
			contents: [
				{
					uri: PLUGIN_APP_RESOURCE_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: options.appHtml,
					_meta: {
						ui: {
							prefersBorder: true,
							domain: appOrigin,
							csp: {
								connectDomains: [],
								resourceDomains: [appOrigin],
							},
						},
						"openai/ui": {
							preferredDisplayMode: "fullscreen",
							availableDisplayModes: ["inline", "fullscreen"],
						} satisfies OpenAIUiResourceMetadata,
						// `_meta.ui.csp` has no redirect list; ChatGPT still reads this
						// legacy key to trust "Open in Shiplet" links without a prompt.
						"openai/widgetCSP": {
							connect_domains: [],
							resource_domains: [appOrigin],
							redirect_domains: [
								appOrigin,
								...(customDomain ? [`https://*.${customDomain}`] : []),
							],
						},
						"openai/widgetDescription":
							"Shows the user's Shiplets, their review feedback and replies, or a preview of an HTML file. The user can read and act on these directly in the app.",
					},
				},
			],
		}),
	);

	// McpServer's tools/list omits tool `icons`, which ChatGPT reads for
	// entrypoints. Re-list the same registered tools, converted exactly as the
	// SDK does, and add the icons.
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: [...registered.entries()]
			.filter(([, tool]) => tool.enabled)
			.map(([name, tool]): Tool => {
				const input = normalizeObjectSchema(tool.inputSchema);
				const icons = toolIcons.get(name);
				return {
					name,
					title: tool.title,
					description: tool.description,
					inputSchema: (input
						? toJsonSchemaCompat(input, {
								strictUnions: true,
								pipeStrategy: "input",
							})
						: { type: "object", properties: {} }) as Tool["inputSchema"],
					annotations: tool.annotations,
					execution: tool.execution,
					_meta: tool._meta,
					...(icons ? { icons } : {}),
				};
			}),
	}));

	return server;
}

// ---- Pure helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** A person's display name, never an email address (some names fall back to one). */
function personName(value: unknown) {
	const name = str(value)?.trim();
	return name && !name.includes("@") ? name : null;
}

function workspaceListText(workspaces: PluginWorkspace[]) {
	if (workspaces.length === 0) return "No workspaces found.";
	return [
		`${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}:`,
		...workspaces.map((workspace) => `- ${workspace.name} (ID ${workspace.id})`),
	].join("\n");
}

function feedbackPath(shipletId: string, feedbackId: string) {
	return `/api/projects/${shipletId}/review-feedback/${feedbackId}`;
}

function feedbackTitle(ticketLabel: string | null, comment: string | null) {
	const firstLine =
		(comment ?? "")
			.split(/\r?\n/)
			.map((line) => line.replace(/\s+/g, " ").trim())
			.find(Boolean) ?? "";
	const excerpt =
		firstLine.length > MAX_TITLE_CHARS
			? `${firstLine.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
			: firstLine;
	if (ticketLabel && excerpt) return `${ticketLabel}: ${excerpt}`;
	return ticketLabel || excerpt || "Feedback";
}

function assertHttpUrl(value: string, field: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PluginInputError(`${field} must be a valid http or https URL.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new PluginInputError(`${field} must be a valid http or https URL.`);
	}
}

export function subdomainSlug(name: string) {
	const slug = name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, SUBDOMAIN_SLUG_MAX)
		.replace(/-+$/, "");
	return slug || "shiplet";
}

function randomSuffix() {
	const bytes = new Uint8Array(SUBDOMAIN_SUFFIX_LENGTH);
	crypto.getRandomValues(bytes);
	let suffix = "";
	for (const byte of bytes) {
		suffix += SUBDOMAIN_SUFFIX_ALPHABET[byte % SUBDOMAIN_SUFFIX_ALPHABET.length];
	}
	return suffix;
}

/**
 * Validate plugin file input before it reaches the REST publish path and
 * encode each file as base64 UTF-8. Rejects absolute paths, traversal,
 * duplicates, unsupported types, oversize input, and a missing root index.html.
 */
export function publishAssets(files: { path: string; content: string }[]) {
	if (files.length === 0 || files.length > PUBLISH_HTML_LIMITS.maxFiles) {
		throw new PluginInputError(
			`Provide between 1 and ${PUBLISH_HTML_LIMITS.maxFiles} files.`,
		);
	}
	const encoder = new TextEncoder();
	const seen = new Set<string>();
	let totalBytes = 0;
	let hasIndex = false;
	const assets = files.map((file) => {
		const path = normalizePublishPath(file.path);
		const key = path.toLowerCase();
		if (seen.has(key)) {
			throw new PluginInputError(`Duplicate file path: ${path}`);
		}
		seen.add(key);
		assertSupportedPublishType(path);
		const bytes = encoder.encode(file.content);
		totalBytes += bytes.byteLength;
		if (totalBytes > PUBLISH_HTML_LIMITS.maxTotalBytes) {
			throw new PluginInputError(
				`Files exceed the ${PUBLISH_HTML_LIMITS.maxTotalBytes / (1024 * 1024)} MB total limit.`,
			);
		}
		if (path === "index.html" && bytes.byteLength > 0) hasIndex = true;
		return { path, content: bytesToBase64(bytes), size: bytes.byteLength };
	});
	if (!hasIndex) {
		throw new PluginInputError(
			"Include a non-empty index.html at the root of the files.",
		);
	}
	return assets;
}

function normalizePublishPath(value: string) {
	const raw = value.trim().replace(/\\/g, "/");
	const unsafe = () =>
		new PluginInputError(
			`Unsafe file path "${value.slice(0, 80)}". Use relative paths without leading slashes or ".." segments.`,
		);
	if (
		!raw ||
		raw.length > PUBLISH_HTML_LIMITS.maxPathLength ||
		raw.includes("\0") ||
		raw.startsWith("/") ||
		/^[a-zA-Z]:/.test(raw) ||
		/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
	) {
		throw unsafe();
	}
	const path = raw.replace(/^(?:\.\/)+/, "");
	const segments = path.split("/");
	if (
		segments.some(
			(segment) => !segment || segment === "." || segment === "..",
		)
	) {
		throw unsafe();
	}
	return path;
}

function assertSupportedPublishType(path: string) {
	const extension = staticAssetExtension(path);
	const fileName = staticAssetFileName(path);
	if (
		(!extension && !ALLOWED_STATIC_ASSET_FILENAMES.has(fileName)) ||
		BLOCKED_STATIC_ASSET_EXTENSIONS.has(extension) ||
		(!ALLOWED_STATIC_ASSET_EXTENSIONS.has(extension) &&
			!ALLOWED_STATIC_ASSET_FILENAMES.has(fileName))
	) {
		throw new PluginInputError(`Unsupported file type: ${path}`);
	}
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	const chunk = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	}
	return btoa(binary);
}

function shipletListText(shiplets: PluginShiplet[]) {
	if (shiplets.length === 0) return "No Shiplets found.";
	const lines = shiplets.map(
		(shiplet) =>
			`- ${shiplet.name} (ID ${shiplet.id}${shiplet.archived ? ", archived" : ""}): ${shiplet.reviewUrl}`,
	);
	return [
		`${shiplets.length} Shiplet${shiplets.length === 1 ? "" : "s"}:`,
		...lines,
	].join("\n");
}

function feedbackListText(name: string, feedback: PluginFeedbackSummary[]) {
	if (feedback.length === 0) return `No matching feedback on ${name}.`;
	return [
		`${feedback.length} feedback item${feedback.length === 1 ? "" : "s"} on ${name}:`,
		...feedback.map(
			(item) =>
				`- ${item.title} [${item.status}] (ID ${item.id}, ${item.replyCount} ${item.replyCount === 1 ? "reply" : "replies"})`,
		),
	].join("\n");
}

function feedbackDetailText(feedback: PluginFeedbackDetail) {
	return [
		`${feedback.title} [${feedback.status}]`,
		feedback.comment,
		...(feedback.pageUrl ? [`Page: ${feedback.pageUrl}`] : []),
		`${feedback.replies.length} ${feedback.replies.length === 1 ? "reply" : "replies"}.`,
		`Open in Shiplet: ${feedback.url}`,
	].join("\n");
}

function publishedText(shiplet: PluginShiplet) {
	return `Created Shiplet "${shiplet.name}" (ID ${shiplet.id}, visibility ${shiplet.visibility}). Review link: ${shiplet.reviewUrl}`;
}
