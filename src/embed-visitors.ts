// Public visitor feedback on a website with the Shiplet widget.
//
// An editor turns it on per installation (off by default). A visitor first
// passes a Cloudflare Turnstile check, rendered on Shiplet's own visitor frame,
// and gets a short-lived bearer token. With it they can leave a note, stored
// as an annotation with source "visitor" and no author. Feedback is one way:
// visitors never talk with agents, which is only for signed-in team members.
// Every check fails closed: no Turnstile keys, a revoked installation, or
// visitor feedback turned off all stop a visitor at once.
import type { Hono } from "hono";
import type { Env } from "./env";
import { getEmbedInstallation, normalizeEmbedReviewPageUrl, type EmbedInstallationRecord } from "./embed";
import { createReviewFeedback, validateReviewFeedbackPayload } from "./review";
import { getProjectById, timestamps } from "./store";
import type { Project } from "./types";

export const VISITOR_TURNSTILE_ACTION = "visitor";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TOKEN_PREFIX = "shiplet_visitor_";
const SESSION_MS = 2 * 60 * 60_000;
const FEEDBACK_PER_TEN_MINUTES = 5;
const INSTALLATION_FEEDBACK_PER_HOUR = 100;
// Note length, counted in characters after trimming.
const VISITOR_TEXT_CHARS = 2000;

type Installation = EmbedInstallationRecord & { visitors_enabled_on?: string | null };

type VisitorSessionRow = {
	token_hash: string;
	installation_id: string;
	project_id: string;
	organization_id: string;
	site_origin: string;
	page_url: string;
	expires_on: string;
};

type Visitor = { row: VisitorSessionRow; installation: Installation; project: Project; key: string };

function fail(status: number, error: string, message: string) {
	return Response.json({ error, message }, { status, headers: { "Cache-Control": "no-store" } });
}

function ok(body: unknown, status = 200) {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function turnstileConfigured(env: Env) {
	return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

// An installation whose visitor feedback is on, on a server that can check for bots.
export async function visitorInstallation(env: Env, installationId: unknown): Promise<Installation | null> {
	if (typeof installationId !== "string" || !installationId || !turnstileConfigured(env)) return null;
	const installation = (await getEmbedInstallation(env.DB, installationId)) as Installation | null;
	return installation?.visitors_enabled_on ? installation : null;
}

export async function setInstallationVisitors(db: D1Database, projectId: string, installationId: string, on: boolean) {
	const result = await db
		.prepare("UPDATE embed_installations SET visitors_enabled_on = ? WHERE id = ? AND project_id = ? AND revoked_on IS NULL")
		.bind(on ? timestamps.now() : null, installationId, projectId)
		.run();
	if (!on) await db.prepare("DELETE FROM embed_visitor_sessions WHERE installation_id = ?").bind(installationId).run();
	return (result.meta?.changes ?? 0) > 0;
}

// Canonical siteverify: success, the visitor action, and Shiplet's own
// hostname (the widget renders on Shiplet's visitor frame). Fails closed.
async function passedTurnstile(env: Env, request: Request, token: unknown) {
	if (typeof token !== "string" || !token || token.length > 2048 || !env.TURNSTILE_SECRET) return false;
	const expectedHostname = new URL(request.url).hostname;
	const remoteip = request.headers.get("CF-Connecting-IP") ?? "";
	try {
		const response = await fetch(SITEVERIFY_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal: AbortSignal.timeout(10_000),
			body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, ...(remoteip ? { remoteip } : {}) }),
		});
		if (!response.ok) return false;
		const result = (await response.json()) as { success?: boolean; action?: string; hostname?: string };
		return result.success === true && result.action === VISITOR_TURNSTILE_ACTION && result.hostname === expectedHostname;
	} catch {
		return false;
	}
}

async function sha256(value: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number) {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const text = await request.text();
		if (text.length > 64 * 1024) return {};
		const parsed = text ? JSON.parse(text) : {};
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

// The visitor behind a bearer token, if their installation still admits visitors.
async function visitorFrom(env: Env, request: Request): Promise<Visitor | Response> {
	const token = request.headers.get("authorization")?.match(/^Bearer\s+(shiplet_visitor_[0-9a-f]{48})$/)?.[1];
	if (!token) return fail(401, "visitor_session_required", "Start a visitor session first.");
	const hash = await sha256(token);
	const row = await env.DB.prepare("SELECT * FROM embed_visitor_sessions WHERE token_hash = ? LIMIT 1").bind(hash).first<VisitorSessionRow>();
	if (!row || row.expires_on <= timestamps.now()) return fail(401, "visitor_session_required", "Your visitor session ended. Start again.");
	const installation = await visitorInstallation(env, row.installation_id);
	if (!installation) return fail(403, "visitors_off", "Visitor feedback is off for this website.");
	const project = (await getProjectById(env.DB, row.project_id)) as Project | null;
	if (!project || project.archived_on) return fail(403, "visitors_off", "Visitor feedback is off for this website.");
	return { row, installation, project, key: hash.slice(0, 16) };
}

function boundedElement(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const text = (key: string, max: number) => (typeof input[key] === "string" ? (input[key] as string).slice(0, max) : undefined);
	return { selector: text("selector", 512), tagName: text("tagName", 32), text: text("text", 280) };
}

function boundedViewport(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { width, height } = value as Record<string, unknown>;
	return typeof width === "number" && typeof height === "number" ? { width: Math.round(width), height: Math.round(height) } : undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono app carries app-specific variables.
export function registerVisitorRoutes(app: Hono<any>) {
	app.get("/api/embed/visitors/config", async (c) => {
		const env = c.env as Env;
		const installation = await visitorInstallation(env, c.req.query("installation_id"));
		if (!installation) return ok({ enabled: false });
		return ok({ enabled: true, siteKey: env.TURNSTILE_SITE_KEY });
	});

	app.post("/api/embed/visitors/session", async (c) => {
		const env = c.env as Env;
		const body = await readJson(c.req.raw);
		if (!turnstileConfigured(env)) return fail(503, "visitors_unavailable", "Visitor feedback is not set up on this Shiplet server.");
		const installationId = typeof body.installation_id === "string" ? body.installation_id : "";
		const installation = await visitorInstallation(env, installationId);
		if (!installation) return fail(403, "visitors_off", "Visitor feedback is off for this website.");
		const pageUrl = normalizeEmbedReviewPageUrl(body.page_url, installation.site_origin);
		if (!pageUrl) return fail(400, "bad_page", "That page is not on this website.");
		if (!(await passedTurnstile(env, c.req.raw, body.turnstile_token))) {
			return fail(403, "turnstile_failed", "The check did not pass. Try again.");
		}
		const token = `${TOKEN_PREFIX}${randomHex(24)}`;
		const now = Date.now();
		const expiresOn = new Date(now + SESSION_MS).toISOString();
		await env.DB.prepare(
			`INSERT INTO embed_visitor_sessions
			 (token_hash, installation_id, project_id, organization_id, site_origin, page_url, created_on, expires_on)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(await sha256(token), installation.id, installation.project_id, installation.organization_id, installation.site_origin, pageUrl, new Date(now).toISOString(), expiresOn)
			.run();
		return ok({ token, expiresOn }, 201);
	});

	app.post("/api/embed/visitors/feedback", async (c) => {
		const env = c.env as Env;
		const visitor = await visitorFrom(env, c.req.raw);
		if (visitor instanceof Response) return visitor;
		const body = await readJson(c.req.raw);
		const comment = typeof body.comment === "string" ? body.comment.trim() : "";
		if (!comment || comment.length > VISITOR_TEXT_CHARS) {
			return fail(400, "bad_request", `Write a note of at most ${VISITOR_TEXT_CHARS} characters.`);
		}
		const pageUrl = normalizeEmbedReviewPageUrl(body.pageUrl, visitor.row.site_origin);
		if (!pageUrl) return fail(400, "bad_page", "That page is not on this website.");
		const since = (ms: number) => new Date(Date.now() - ms).toISOString();
		const mine = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM review_feedback WHERE project_id = ? AND source = 'visitor' AND client_feedback_id LIKE ? AND created_on > ?",
		)
			.bind(visitor.project.id, `visitor-${visitor.key}-%`, since(10 * 60_000))
			.first<{ n: number }>();
		const site = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_feedback WHERE project_id = ? AND source = 'visitor' AND created_on > ?")
			.bind(visitor.project.id, since(60 * 60_000))
			.first<{ n: number }>();
		if ((mine?.n ?? 0) >= FEEDBACK_PER_TEN_MINUTES || (site?.n ?? 0) >= INSTALLATION_FEEDBACK_PER_HOUR) {
			return fail(429, "rate_limited", "Thanks, that is plenty for now. Try again in a few minutes.");
		}
		const validation = validateReviewFeedbackPayload({
			clientFeedbackId: `visitor-${visitor.key}-${randomHex(8)}`,
			name: "Visitor",
			comment,
			pageUrl,
			screenshotMode: "element",
			viewport: boundedViewport(body.viewport),
			selectedElement: boundedElement(body.selectedElement),
		});
		if (!validation.ok) return fail(400, "bad_request", validation.errors.join(" "));
		const feedback = await createReviewFeedback(env, visitor.project, null, validation.value, undefined, { kind: "system", id: "embed_visitor" }, { source: "visitor" });
		return ok({ feedback }, 201);
	});
}
