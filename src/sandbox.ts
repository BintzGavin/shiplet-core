import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { ReviewStatus } from "./review";
import type { Project } from "./types";

const SANDBOX_STATUSES = new Set<ReviewStatus>([
	"New",
	"In Progress",
	"Blocked",
	"Done",
	"Dropped",
]);
export const SHARED_SANDBOX_SESSION_ID = "sbx_sharedsandboxdemo0000000";
export const SANDBOX_FEEDBACK_TTL_MS = 24 * 60 * 60 * 1000;
const SANDBOX_SEED_ACTOR_ID = "sandbox_seed";
const SANDBOX_PROFANITY_REPLACEMENT = "[filtered]";
const SANDBOX_PROFANITY_PATTERNS = [
	/\b(?:fuck|fucker|fucking|shit|bullshit|asshole|bitch|cunt|dick|piss)\b/gi,
];
const SANDBOX_CONTROL_CHARACTERS =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

type SandboxShipletRow = {
	id: string;
	name: string;
	subdomain: string;
	description: string | null;
	html: string;
	created_on: string;
};

type SandboxFeedbackRow = {
	id: string;
	project_id: string;
	ticket_number: number;
	client_feedback_id: string;
	name: string | null;
	comment: string;
	status: ReviewStatus;
	page_url: string;
	pathname: string;
	page_url_key: string;
	screenshot_data_url: string | null;
	screenshot_failure_note: string | null;
	screenshot_mode: "page" | "element";
	viewport_json: string | null;
	coordinates_json: string | null;
	selected_element_json: string | null;
	capture_context_json: string | null;
	user_agent: string | null;
	submitted_by_email: string | null;
	created_by_actor: string | null;
	created_on: string;
	updated_on: string;
};

type SandboxReplyRow = {
	id: string;
	feedback_id: string;
	project_id: string;
	comment: string;
	author_email: string | null;
	created_by_actor: string | null;
	created_on: string;
};

export type SandboxFeedbackInput = {
	name: string | null;
	comment: string;
	pageUrl: string;
	pathname: string;
	pageUrlKey: string;
	clientFeedbackId: string;
	screenshotDataUrl: string | null;
	screenshotMode: "page" | "element";
	screenshotFailureNote: string | null;
	viewport: Record<string, unknown> | null;
	coordinates: Record<string, unknown> | null;
	selectedElement: Record<string, unknown> | null;
	captureContext: Record<string, unknown> | null;
	userAgent: string | null;
};

type SandboxFeedbackListOptions = {
	pageUrl?: string | null;
	status?: string | null;
	includeClosed?: boolean;
	limit?: number;
	actorId?: string | null;
	includeSharedUntrusted?: boolean;
};

export type SandboxSnapshot = {
	session: {
		id: string;
		mcpUrl: string;
		resetUrl: string | null;
		expiresInHours: number;
		shared: boolean;
	};
	shiplets: SandboxShipletSummary[];
	feedback: SandboxFeedbackRecord[];
};

export type SandboxShipletSummary = {
	id: string;
	name: string;
	subdomain: string;
	description: string | null;
	previewUrl: string;
	reviewUrl: string;
	artifactUrl: string;
	created_on: string;
	feedbackCount: number;
};

export type SandboxFeedbackRecord = {
	id: string;
	project_id: string;
	organization_id: string;
	ticket_number: number;
	ticket_label: string;
	client_feedback_id: string;
	name: string | null;
	comment: string;
	status: ReviewStatus;
	page_url: string;
	pathname: string;
	page_url_key: string;
	screenshot_key: string | null;
	screenshot_url: string | null;
	screenshot_content_type: string | null;
	screenshot_size: number | null;
	screenshot_failure_note: string | null;
	screenshot_mode: "page" | "element";
	viewport: Record<string, unknown> | null;
	coordinates: Record<string, unknown> | null;
	selected_element: Record<string, unknown> | null;
	capture_context: Record<string, unknown> | null;
	user_agent: string | null;
	submitted_by_user_id: string | null;
	submitted_by_email: string | null;
	submitted_by_avatar_preset: string | null;
	submitted_by_avatar_data_url: string | null;
	source: string;
	created_on: string;
	updated_on: string;
	replies: SandboxReplyRecord[];
};

export type SandboxReplyRecord = {
	id: string;
	feedback_id: string;
	project_id: string;
	comment: string;
	author_user_id: string | null;
	author_email: string | null;
	created_on: string;
};

export class SandboxSession extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
		});
	}

	private migrate() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS shiplets (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				subdomain TEXT NOT NULL,
				description TEXT,
				html TEXT NOT NULL,
				created_on TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS feedback (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL,
				ticket_number INTEGER NOT NULL,
				client_feedback_id TEXT NOT NULL,
				name TEXT,
				comment TEXT NOT NULL,
				status TEXT NOT NULL,
				page_url TEXT NOT NULL,
				pathname TEXT NOT NULL,
				page_url_key TEXT NOT NULL,
				screenshot_data_url TEXT,
				screenshot_failure_note TEXT,
				screenshot_mode TEXT NOT NULL,
				viewport_json TEXT,
				coordinates_json TEXT,
				selected_element_json TEXT,
				capture_context_json TEXT,
				user_agent TEXT,
				submitted_by_email TEXT,
				created_by_actor TEXT,
				created_on TEXT NOT NULL,
				updated_on TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS replies (
				id TEXT PRIMARY KEY,
				feedback_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				comment TEXT NOT NULL,
				author_email TEXT,
				created_by_actor TEXT,
				created_on TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_feedback_project ON feedback(project_id, ticket_number);
			CREATE INDEX IF NOT EXISTS idx_replies_feedback ON replies(feedback_id, created_on);
		`);
		this.ensureFeedbackColumn("screenshot_data_url", "TEXT");
		this.ensureFeedbackColumn("screenshot_failure_note", "TEXT");
		this.ensureFeedbackColumn("created_by_actor", "TEXT");
		this.ensureReplyColumn("created_by_actor", "TEXT");
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_feedback_actor ON feedback(project_id, created_by_actor, ticket_number)",
		);
	}

	private ensureFeedbackColumn(name: string, definition: string) {
		const columns = this.ctx.storage.sql
			.exec<{ name: string }>("PRAGMA table_info(feedback)")
			.toArray();
		if (columns.some((column) => column.name === name)) return;
		this.ctx.storage.sql.exec(`ALTER TABLE feedback ADD COLUMN ${name} ${definition}`);
	}

	private ensureReplyColumn(name: string, definition: string) {
		const columns = this.ctx.storage.sql
			.exec<{ name: string }>("PRAGMA table_info(replies)")
			.toArray();
		if (columns.some((column) => column.name === name)) return;
		this.ctx.storage.sql.exec(`ALTER TABLE replies ADD COLUMN ${name} ${definition}`);
	}

	async snapshot(
		sessionId: string,
		actorId: string,
		appUrl: string,
	): Promise<SandboxSnapshot> {
		this.ensureSeeded(sessionId);
		this.purgeExpiredFeedback();
		const shiplets = this.listShipletsForSession(sessionId);
		const shared = isSharedSandboxSessionId(sessionId);
		return {
			session: {
				id: sessionId,
				mcpUrl: `${appUrl}/api/play/mcp?session=${encodeURIComponent(sessionId)}&actor=${encodeURIComponent(actorId)}`,
				resetUrl: shared
					? null
					: `/api/play/reset?session=${encodeURIComponent(sessionId)}`,
				expiresInHours: 24,
				shared,
			},
			shiplets,
			feedback: shiplets[0]
				? await this.listFeedback(sessionId, shiplets[0].id, {})
				: [],
		};
	}

	async reset(
		sessionId: string,
		actorId: string,
		appUrl: string,
	): Promise<SandboxSnapshot> {
		this.ctx.storage.sql.exec("DELETE FROM replies");
		this.ctx.storage.sql.exec("DELETE FROM feedback");
		this.ctx.storage.sql.exec("DELETE FROM shiplets");
		this.ctx.storage.sql.exec("DELETE FROM meta");
		this.seed(sessionId);
		return this.snapshot(sessionId, actorId, appUrl);
	}

	async getShiplet(sessionId: string, projectId: string) {
		this.ensureSeeded(sessionId);
		this.purgeExpiredFeedback();
		this.assertProjectBelongsToSession(sessionId, projectId);
		const row = this.ctx.storage.sql
			.exec<SandboxShipletRow>("SELECT * FROM shiplets WHERE id = ?", projectId)
			.toArray()[0];
		return row || null;
	}

	async publishShiplet(
		sessionId: string,
		appUrl: string,
		payload: Record<string, unknown>,
	) {
		this.ensureSeeded(sessionId);
		this.purgeExpiredFeedback();
		const name = filterSandboxText(
			normalizeString(payload.name, "Sandbox shiplet"),
		).slice(0, 90);
		const subdomain = slugify(
			filterSandboxText(
				normalizeString(payload.subdomain, name || "sandbox-shiplet"),
			),
		);
		const id = `sandbox-${sessionId}-${subdomain}-${randomToken(6)}`;
		const createdOn = now();
		this.ctx.storage.sql.exec(
			`INSERT INTO shiplets (id, name, subdomain, description, html, created_on)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			id,
			name,
			subdomain,
			"Published from the anonymous sandbox API.",
			sandboxArtifactHtml(name),
			createdOn,
		);
		const project = this.projectFromShiplet(
			this.ctx.storage.sql
				.exec<SandboxShipletRow>("SELECT * FROM shiplets WHERE id = ?", id)
				.toArray()[0],
		);
		const previewUrl = `/play/preview/${id}`;
		return {
			ok: true,
			project,
			shipletUrl: previewUrl,
			artifactUrl: new URL(previewUrl, appUrl).toString(),
			reviewUrl: previewUrl,
			previewUrl,
			launchUrl: "/play",
		};
	}

	async listShiplets(sessionId: string): Promise<{ projects: SandboxShipletSummary[] }> {
		this.ensureSeeded(sessionId);
		this.purgeExpiredFeedback();
		return { projects: this.listShipletsForSession(sessionId) };
	}

	async createFeedback(
		sessionId: string,
		projectId: string,
		actorId: string,
		payload: SandboxFeedbackInput,
	): Promise<SandboxFeedbackRecord> {
		this.ensureSeeded(sessionId);
		this.assertProjectBelongsToSession(sessionId, projectId);
		this.purgeExpiredFeedback();
		const ticketNumber = this.nextTicketNumber(projectId);
		const id = `sbf_${randomToken(18)}`;
		const createdOn = now();
		const name = payload.name ? filterSandboxText(payload.name) : null;
		const comment = filterSandboxText(payload.comment);
		this.ctx.storage.sql.exec(
			`INSERT INTO feedback
			 (id, project_id, ticket_number, client_feedback_id, name, comment, status,
			  page_url, pathname, page_url_key, screenshot_data_url, screenshot_failure_note,
			  screenshot_mode, viewport_json,
			  coordinates_json, selected_element_json, capture_context_json,
			  user_agent, submitted_by_email, created_by_actor, created_on, updated_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			projectId,
			ticketNumber,
			payload.clientFeedbackId,
			name,
			comment,
			"New",
			payload.pageUrl,
			payload.pathname,
			sandboxPageUrlKey(payload.pageUrl || payload.pathname),
			payload.screenshotDataUrl,
			payload.screenshotFailureNote,
			payload.screenshotMode,
			stringifyJson(payload.viewport),
			stringifyJson(payload.coordinates),
			stringifyJson(payload.selectedElement),
			stringifyJson(payload.captureContext),
			payload.userAgent,
			name || "sandbox.reviewer@shiplet.cc",
			actorId,
			createdOn,
			createdOn,
		);
		const feedback = await this.getFeedback(sessionId, projectId, id);
		if (!feedback) throw new Error("Failed to create sandbox feedback.");
		return feedback;
	}

	async listFeedback(
		sessionId: string,
		projectId: string,
		options: SandboxFeedbackListOptions,
	): Promise<SandboxFeedbackRecord[]> {
		this.ensureSeeded(sessionId);
		this.assertProjectBelongsToSession(sessionId, projectId);
		this.purgeExpiredFeedback();
		return this.listFeedbackRows(projectId, options).map((row) =>
			this.feedbackFromRow(row, options),
		);
	}

	async getFeedback(
		sessionId: string,
		projectId: string,
		feedbackId: string,
		options: Pick<SandboxFeedbackListOptions, "actorId" | "includeSharedUntrusted"> = {},
	): Promise<SandboxFeedbackRecord | null> {
		this.ensureSeeded(sessionId);
		this.assertProjectBelongsToSession(sessionId, projectId);
		this.purgeExpiredFeedback();
		const row = this.ctx.storage.sql
			.exec<SandboxFeedbackRow>(
				"SELECT * FROM feedback WHERE project_id = ? AND id = ?",
				projectId,
				feedbackId,
			)
			.toArray()[0];
		if (!row || !this.rowVisibleToActor(row, options)) return null;
		return this.feedbackFromRow(row, options);
	}

	async createReply(
		sessionId: string,
		projectId: string,
		feedbackId: string,
		actorId: string,
		comment: string,
		options: { requireActorOwned?: boolean } = {},
	): Promise<SandboxFeedbackRecord | null> {
		this.ensureSeeded(sessionId);
		this.assertProjectBelongsToSession(sessionId, projectId);
		this.purgeExpiredFeedback();
		if (!comment.trim()) throw new Error("Reply comment is required.");
		const existing = this.feedbackRow(projectId, feedbackId);
		if (!existing) return null;
		if (options.requireActorOwned && existing.created_by_actor !== actorId) {
			return null;
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO replies (id, feedback_id, project_id, comment, author_email, created_by_actor, created_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			`sbr_${randomToken(18)}`,
			feedbackId,
			projectId,
			filterSandboxText(comment).slice(0, 2000),
			"sandbox.agent@shiplet.cc",
			actorId,
			now(),
		);
		return this.getFeedback(
			sessionId,
			projectId,
			feedbackId,
			options.requireActorOwned ? { actorId } : {},
		);
	}

	async updateStatus(
		sessionId: string,
		projectId: string,
		feedbackId: string,
		status: string,
		options: { actorId?: string | null; requireActorOwned?: boolean } = {},
	): Promise<SandboxFeedbackRecord | null> {
		this.ensureSeeded(sessionId);
		this.assertProjectBelongsToSession(sessionId, projectId);
		this.purgeExpiredFeedback();
		if (!SANDBOX_STATUSES.has(status as ReviewStatus)) {
			throw new Error("Invalid review status.");
		}
		if (options.requireActorOwned) {
			const existing = this.feedbackRow(projectId, feedbackId);
			if (!existing || existing.created_by_actor !== options.actorId) {
				return null;
			}
		}
		this.ctx.storage.sql.exec(
			"UPDATE feedback SET status = ?, updated_on = ? WHERE project_id = ? AND id = ?",
			status,
			now(),
			projectId,
			feedbackId,
		);
		return this.getFeedback(
			sessionId,
			projectId,
			feedbackId,
			options.requireActorOwned ? { actorId: options.actorId } : {},
		);
	}

	private ensureSeeded(sessionId: string) {
		const seeded = this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'seeded'")
			.toArray()[0];
		if (!seeded) this.seed(sessionId);
	}

	private purgeExpiredFeedback() {
		const cutoff = new Date(Date.now() - SANDBOX_FEEDBACK_TTL_MS).toISOString();
		const expired = this.ctx.storage.sql
			.exec<{ id: string }>(
				"SELECT id FROM feedback WHERE created_on <= ?",
				cutoff,
			)
			.toArray();
		for (const row of expired) {
			this.ctx.storage.sql.exec("DELETE FROM replies WHERE feedback_id = ?", row.id);
			this.ctx.storage.sql.exec("DELETE FROM feedback WHERE id = ?", row.id);
		}
	}

	private seed(sessionId: string) {
		const createdOn = now();
		const projectId = `sandbox-${sessionId}-launch-board`;
		this.ctx.storage.sql.exec(
			`INSERT INTO shiplets (id, name, subdomain, description, html, created_on)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			projectId,
			"Launch review board",
			"launch-review-board",
			"A realistic preview with review feedback already flowing.",
			seedArtifactHtml(),
			createdOn,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO feedback
			 (id, project_id, ticket_number, client_feedback_id, name, comment, status,
			  page_url, pathname, page_url_key, screenshot_mode, viewport_json,
			  coordinates_json, selected_element_json, capture_context_json,
			  submitted_by_email, created_by_actor, created_on, updated_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			`sbf_${randomToken(18)}`,
			projectId,
			1,
			`client-${randomToken(8)}-${randomToken(8)}`,
			"Jordan",
			"Can we make the handoff CTA more explicit for PMs who are not living inside Codex yet?",
			"New",
			`https://shiplet.cc/play/preview/${projectId}`,
			`/play/preview/${projectId}`,
			`/play/preview/${projectId}`,
			"page",
			stringifyJson({ width: 1280, height: 720, devicePixelRatio: 1 }),
			stringifyJson({ pageX: 672, pageY: 310, viewportX: 672, viewportY: 310 }),
			stringifyJson({
				selector: ".hero",
				tagName: "DIV",
				text: "Share previews. Collect feedback. Keep shipping.",
				ariaLabel: null,
				className: "hero",
				rect: { top: 280, left: 520, width: 304, height: 62 },
			}),
			stringifyJson({
				elementCount: 30,
				imageCount: 0,
				documentWidth: 1280,
				documentHeight: 900,
				scrollX: 0,
				scrollY: 0,
			}),
			"jordan@example.com",
			SANDBOX_SEED_ACTOR_ID,
			createdOn,
			createdOn,
		);
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (key, value) VALUES ('seeded', ?)",
			createdOn,
		);
	}

	private listShipletsForSession(sessionId: string): SandboxShipletSummary[] {
		const rows = this.ctx.storage.sql
			.exec<SandboxShipletRow>("SELECT * FROM shiplets ORDER BY created_on ASC")
			.toArray();
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			subdomain: row.subdomain,
			description: row.description,
			previewUrl: `/play/preview/${row.id}`,
			reviewUrl: `/play/preview/${row.id}`,
			artifactUrl: `/play/preview/${row.id}`,
			created_on: row.created_on,
			feedbackCount: this.ctx.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) as count FROM feedback WHERE project_id = ?",
					row.id,
				)
				.one().count,
		})).filter((project) => project.id.startsWith(`sandbox-${sessionId}-`));
	}

	private listFeedbackRows(
		projectId: string,
		options: SandboxFeedbackListOptions,
	) {
		const limit = Math.max(1, Math.min(options.limit || 100, 250));
		const rows = this.ctx.storage.sql
			.exec<SandboxFeedbackRow>(
				"SELECT * FROM feedback WHERE project_id = ? ORDER BY ticket_number ASC",
				projectId,
			)
			.toArray();
		return rows
			.filter((row) => {
				if (!this.rowVisibleToActor(row, options)) return false;
				if (options.pageUrl && row.page_url_key !== sandboxPageUrlKey(options.pageUrl)) {
					return false;
				}
				if (options.status && row.status !== options.status) return false;
				if (!options.includeClosed && ["Done", "Dropped"].includes(row.status)) {
					return false;
				}
				return true;
			})
			.slice(0, limit);
	}

	private rowVisibleToActor(
		row: SandboxFeedbackRow,
		options: Pick<SandboxFeedbackListOptions, "actorId" | "includeSharedUntrusted">,
	) {
		if (!options.actorId || options.includeSharedUntrusted) return true;
		return [options.actorId, SANDBOX_SEED_ACTOR_ID].includes(
			row.created_by_actor || "",
		);
	}

	private feedbackRow(projectId: string, feedbackId: string) {
		return this.ctx.storage.sql
			.exec<SandboxFeedbackRow>(
				"SELECT * FROM feedback WHERE project_id = ? AND id = ?",
				projectId,
				feedbackId,
			)
			.toArray()[0] || null;
	}

	private feedbackFromRow(
		row: SandboxFeedbackRow,
		options: Pick<SandboxFeedbackListOptions, "actorId" | "includeSharedUntrusted"> = {},
	): SandboxFeedbackRecord {
		const replies = this.ctx.storage.sql
			.exec<SandboxReplyRow>(
				"SELECT * FROM replies WHERE feedback_id = ? ORDER BY created_on ASC",
				row.id,
			)
			.toArray()
			.filter((reply) => {
				if (!options.actorId || options.includeSharedUntrusted) return true;
				return [options.actorId, SANDBOX_SEED_ACTOR_ID].includes(
					reply.created_by_actor || "",
				);
			})
			.map((reply) => ({
				id: reply.id,
				feedback_id: reply.feedback_id,
				project_id: reply.project_id,
				comment: reply.comment,
				author_user_id: null,
				author_email: reply.author_email,
				created_on: reply.created_on,
			}));
		return {
			id: row.id,
			project_id: row.project_id,
			organization_id: "sandbox",
			ticket_number: row.ticket_number,
			ticket_label: `PF-${row.ticket_number}`,
			client_feedback_id: row.client_feedback_id,
			name: row.name,
			comment: row.comment,
			status: row.status,
			page_url: row.page_url,
			pathname: row.pathname,
			page_url_key: row.page_url_key,
			screenshot_key: null,
			screenshot_url: row.screenshot_data_url || null,
			screenshot_content_type: sandboxScreenshotContentType(row.screenshot_data_url),
			screenshot_size: sandboxScreenshotSize(row.screenshot_data_url),
			screenshot_failure_note: row.screenshot_failure_note || null,
			screenshot_mode: row.screenshot_mode,
			viewport: parseJson(row.viewport_json),
			coordinates: parseJson(row.coordinates_json),
			selected_element: parseJson(row.selected_element_json),
			capture_context: parseJson(row.capture_context_json),
			user_agent: row.user_agent,
			submitted_by_user_id: null,
			submitted_by_email: row.submitted_by_email,
			submitted_by_avatar_preset: "aurora-grid",
			submitted_by_avatar_data_url: null,
			source: "sandbox",
			created_on: row.created_on,
			updated_on: row.updated_on,
			replies,
		};
	}

	private nextTicketNumber(projectId: string) {
		const row = this.ctx.storage.sql
			.exec<{ next: number }>(
				"SELECT COALESCE(MAX(ticket_number), 0) + 1 as next FROM feedback WHERE project_id = ?",
				projectId,
			)
			.one();
		return row.next;
	}

	private assertProjectBelongsToSession(sessionId: string, projectId: string) {
		if (!projectId.startsWith(`sandbox-${sessionId}-`)) {
			throw new Error("Sandbox project does not belong to this session.");
		}
	}

	private projectFromShiplet(row: SandboxShipletRow): Project {
		return {
			id: row.id,
			organization_id: "sandbox",
			owner_user_id: "sandbox",
			name: row.name,
			subdomain: row.subdomain,
			custom_hostname: null,
			source_type: "static",
			external_origin_url: null,
			script_content: "/* Sandbox simulated publish */",
			visibility: "unlisted",
			created_on: row.created_on,
			modified_on: row.created_on,
		};
	}
}

function now() {
	return new Date().toISOString();
}

function normalizeString(value: unknown, fallback: string) {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function slugify(value: string) {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 44);
	return slug || "sandbox-shiplet";
}

function randomToken(length: number) {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, length);
}

function stringifyJson(value: Record<string, unknown> | null) {
	return value ? JSON.stringify(value) : null;
}

function parseJson(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

function sandboxScreenshotContentType(value: string | null) {
	const match = String(value || "").match(/^data:(image\/(?:png|jpeg|webp));base64,/);
	return match ? match[1] : null;
}

function sandboxScreenshotSize(value: string | null) {
	const match = String(value || "").match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
	if (!match) return null;
	const base64 = match[1];
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function isSharedSandboxSessionId(sessionId: string) {
	return sessionId === SHARED_SANDBOX_SESSION_ID;
}

export function filterSandboxText(value: string) {
	let text = String(value || "")
		.normalize("NFKC")
		.replace(/\r\n?/g, "\n")
		.replace(SANDBOX_CONTROL_CHARACTERS, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/[ \t]{3,}/g, "  ")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
	for (const pattern of SANDBOX_PROFANITY_PATTERNS) {
		text = text.replace(pattern, SANDBOX_PROFANITY_REPLACEMENT);
	}
	return text;
}

function sandboxPageUrlKey(pageUrl: string) {
	try {
		return new URL(pageUrl).pathname || "/";
	} catch {
		return String(pageUrl || "/");
	}
}

function escapeHtml(text: string) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function seedArtifactHtml() {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Launch review board</title>
  <style>
    body{margin:0;font-family:ui-sans-serif,system-ui;background:#fbf9f4;color:#20293a}
    main{min-height:100vh;padding:42px;display:grid;gap:24px;align-content:start}
    .hero{border:2px solid #20293a;border-radius:10px;background:#f1eee6;padding:28px;box-shadow:0 12px 0 #2f6e88}
    h1{font-size:clamp(2rem,6vw,4rem);line-height:.95;margin:0 0 12px}
    p{max-width:62ch;font-size:18px;line-height:1.55}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
    .card{border:1px solid #bfc4cf;border-bottom:3px solid #20293a;border-radius:8px;background:#fffaf0;padding:18px}
    .tag{display:inline-block;border:1px solid #2f6e88;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:700;color:#2f6e88}
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <span class="tag">Sandbox artifact</span>
      <h1>Share previews. Collect feedback. Keep shipping.</h1>
      <p>This is a realistic Shiplet preview. Open the review widget, leave a note, then pull the comment through the sandbox MCP endpoint.</p>
    </section>
    <section class="grid">
      <article class="card"><strong>Preview</strong><p>Stakeholders can inspect the thing itself instead of a screenshot.</p></article>
      <article class="card"><strong>Review</strong><p>Feedback lands as contextual comments tied to this artifact.</p></article>
      <article class="card"><strong>Agent handoff</strong><p>Local agents can fetch the comment manifest and turn review into edits.</p></article>
    </section>
  </main>
</body>
</html>`;
}

function sandboxArtifactHtml(name: string) {
	const safeName = escapeHtml(name);
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeName}</title>
  <style>
    body{margin:0;font-family:ui-sans-serif,system-ui;background:#fbf9f4;color:#20293a}
    main{min-height:100vh;display:grid;place-items:center;padding:32px}
    section{max-width:720px;border:2px solid #20293a;border-radius:10px;background:#f1eee6;padding:32px;box-shadow:0 12px 0 #c2502f}
    h1{margin:0 0 12px;font-size:clamp(2rem,5vw,3.8rem);line-height:1}
    p{font-size:18px;line-height:1.55}
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${safeName}</h1>
      <p>This sandbox shiplet was published through the anonymous API/MCP flow. It behaves like a reviewable artifact without storing arbitrary uploaded files.</p>
    </section>
  </main>
</body>
</html>`;
}
