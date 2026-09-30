// Shared contract between the Shiplet plugin MCP server (src/plugin-mcp.ts)
// and the Shiplet MCP App UI (src/plugin-app/). Both sides import from here so
// tool names, the UI resource URI, and structuredContent shapes cannot drift.

export const PLUGIN_MCP_PATH = "/api/plugin/mcp";
export const PLUGIN_MCP_SERVER_NAME = "shiplet";
export const PLUGIN_MCP_SERVER_TITLE = "Shiplet";
export const PLUGIN_APP_RESOURCE_URI = "ui://shiplet/review-app.html";

export const PLUGIN_TOOL = {
	// Model-visible tools. Each maps to exactly one documented REST operation.
	listShiplets: "list_shiplets",
	listFeedback: "list_feedback",
	getFeedback: "get_feedback",
	publishHtml: "publish_html_for_review",
	reviewUrl: "create_url_review",
	replyToFeedback: "reply_to_feedback",
	updateFeedbackStatus: "update_feedback_status",
	listWorkspaces: "list_workspaces",
	// App-only entrypoint and extension tools (`_meta.ui.visibility: ["app"]`).
	openInbox: "open_review_inbox",
	openPanel: "open_review_panel",
	openHtmlFile: "open_html_file",
	searchMentions: "search_mentions",
} as const;

export type PluginToolName = (typeof PLUGIN_TOOL)[keyof typeof PLUGIN_TOOL];

// Mirrors REVIEW_STATUSES in src/review.ts, in the same order. "Staging" is a
// live REST status; omitting it would drop real feedback from plugin results.
export const FEEDBACK_STATUSES = [
	"New",
	"In Progress",
	"Blocked",
	"Staging",
	"Done",
	"Dropped",
] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const PLUGIN_VISIBILITIES = [
	"private",
	"organization",
	"unlisted",
	"public",
] as const;
export type PluginVisibility = (typeof PLUGIN_VISIBILITIES)[number];

/** One Shiplet as returned to the model and the app. No internal IDs beyond the Shiplet ID. */
export type PluginShiplet = {
	id: string;
	name: string;
	reviewUrl: string;
	visibility: PluginVisibility;
	archived: boolean;
	/** Unresolved feedback count (New, In Progress, Blocked) when known. */
	openFeedbackCount: number | null;
	updatedAt: string | null;
};

export type PluginFeedbackSummary = {
	id: string;
	shipletId: string;
	title: string;
	status: FeedbackStatus;
	authorName: string | null;
	pageUrl: string | null;
	replyCount: number;
	createdAt: string | null;
	/** Link that opens this feedback thread in Shiplet. */
	url: string;
};

export type PluginFeedbackReply = {
	id: string;
	authorName: string | null;
	comment: string;
	createdAt: string | null;
};

export type PluginFeedbackDetail = PluginFeedbackSummary & {
	comment: string;
	replies: PluginFeedbackReply[];
};

/** structuredContent of list_shiplets, open_review_inbox and open_review_panel. */
export type ShipletListResult = {
	view: "inbox";
	shiplets: PluginShiplet[];
};

/** structuredContent of list_feedback. */
export type FeedbackListResult = {
	view: "feedback";
	shiplet: Pick<PluginShiplet, "id" | "name" | "reviewUrl">;
	feedback: PluginFeedbackSummary[];
};

/** structuredContent of get_feedback. */
export type FeedbackDetailResult = {
	view: "feedback-detail";
	feedback: PluginFeedbackDetail;
	/** Optional. Lets the app label a detail opened without the feedback list (inline results, deep links). */
	shiplet?: Pick<PluginShiplet, "id" | "name" | "reviewUrl">;
};

/** structuredContent of publish_html_for_review and create_url_review. */
export type PublishResult = {
	view: "published";
	shiplet: PluginShiplet;
};

/** structuredContent of open_html_file. The app reads the file bytes itself through the host. */
export type HtmlFileResult = {
	view: "html-file";
	fileName: string;
};

/** Input of publish_html_for_review. Text files only; the server base64-encodes them. */
export type PublishHtmlInput = {
	name: string;
	files: { path: string; content: string }[];
	visibility?: PluginVisibility;
	/** Required only when the account belongs to more than one workspace. */
	workspace_id?: string;
};

export const PUBLISH_HTML_LIMITS = {
	maxFiles: 50,
	maxPathLength: 512,
	/** Total UTF-8 bytes across all file contents. */
	maxTotalBytes: 2 * 1024 * 1024,
} as const;

/** A workspace (organization) the connected account belongs to. */
export type PluginWorkspace = {
	id: string;
	name: string;
};

/** structuredContent of list_workspaces. */
export type WorkspaceListResult = {
	view: "workspaces";
	workspaces: PluginWorkspace[];
};
