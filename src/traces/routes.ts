// REST routes for traces (docs/traces-spec.md). A trace is the full log of an
// agent session: the prompts, the agent's replies, and every tool call and
// result. The logic lives in ./handlers, shared with Code Mode MCP.
import type { Hono } from "hono";
import { TRACE_LIMITS } from "../cli/trace-core.mjs";
import { resolveTraceAccess, traceActorFromRequest, traceError, tracesAvailable } from "./access";
import {
	handleCreateTrace,
	handleDeleteTrace,
	handleGetAttachment,
	handleGetAudiences,
	handleGetContext,
	handleGetSegment,
	handleGetTrace,
	handleListReadableTraces,
	handleListTraces,
	handlePreview,
	handlePutAttachment,
	handlePutAudiences,
} from "./handlers";
import { handleCreateTraceShiplet } from "./trace-shiplets";
import { accessForUploadLink, handleCreateUploadLink, markUploadLinkUsed } from "./uploads";

class PayloadTooLarge extends Error {}

export async function readBodyWithLimit(request: Request, limit: number) {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > limit) {
			await reader.cancel().catch(() => undefined);
			throw new PayloadTooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

async function readUpload(request: Request): Promise<Uint8Array | Response> {
	try {
		return await readBodyWithLimit(request, TRACE_LIMITS.uploadRequestBytes);
	} catch (error) {
		if (error instanceof PayloadTooLarge) {
			return traceError(413, "payload_too_large", "Trace event uploads are limited to 16 MiB; send large files as deferred attachments.");
		}
		throw error;
	}
}

async function readAttachmentBody(request: Request): Promise<Uint8Array | Response> {
	try {
		return await readBodyWithLimit(request, TRACE_LIMITS.attachmentBytes);
	} catch (error) {
		if (error instanceof PayloadTooLarge) return traceError(413, "payload_too_large", "Attachments are limited to 20 MiB.");
		throw error;
	}
}

async function readJson(request: Request, limit: number): Promise<unknown | Response> {
	try {
		return JSON.parse(new TextDecoder().decode(await readBodyWithLimit(request, limit)));
	} catch (error) {
		if (error instanceof PayloadTooLarge) return traceError(413, "payload_too_large", "The request body is too large.");
		return traceError(400, "invalid_json", "The body must be JSON.");
	}
}

function origin(request: Request, env: { SHIPLET_APP_URL?: string }) {
	return env.SHIPLET_APP_URL || new URL(request.url).origin;
}

// biome-ignore lint/suspicious/noExplicitAny: the Worker's Hono app carries app-specific variables.
export function registerTraceRoutes(app: Hono<any>) {
	const project = "/api/shiplets/:projectId/traces";
	const trace = `${project}/:traceId`;

	// A Shiplet made to share one agent session (D19).
	app.post("/api/trace-shiplets", async (c) => {
		const unavailable = tracesAvailable(c.env);
		if (unavailable) return unavailable;
		const actor = await traceActorFromRequest(c.env, c.req.raw, "write");
		if (actor instanceof Response) return actor;
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return traceError(400, "invalid_request", "Send a JSON body: { name, organizationId? }.");
		}
		return handleCreateTraceShiplet(c.env, actor, body, new URL(c.req.url).origin);
	});

	app.post(project, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "write");
		if (access instanceof Response) return access;
		const raw = await readUpload(c.req.raw);
		return raw instanceof Response ? raw : handleCreateTrace(c.env, access, raw);
	});

	app.get(project, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		return handleListTraces(c.env, access, { cursor: c.req.query("cursor"), limit: c.req.query("limit") });
	});

	app.get("/api/traces", async (c) => {
		const unavailable = tracesAvailable(c.env);
		if (unavailable) return unavailable;
		const actor = await traceActorFromRequest(c.env, c.req.raw, "read");
		if (actor instanceof Response) return actor;
		return handleListReadableTraces(c.env, actor, { limit: c.req.query("limit") });
	});

	app.get(trace, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		return handleGetTrace(c.env, access, c.req.param("traceId"));
	});

	app.get(`${trace}/segments/:index`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		return handleGetSegment(c.env, access, c.req.param("traceId"), c.req.param("index"));
	});

	app.get(`${trace}/context`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		return handleGetContext(c.env, access, c.req.param("traceId"), c.req.query("maxTokens"));
	});

	app.get(`${trace}/attachments/:sha256`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		return handleGetAttachment(c.env, access, c.req.param("traceId"), c.req.param("sha256"), c.req.header("range"));
	});

	// Uploads the bytes of a deferred attachment (a session-produced file).
	app.put(`${trace}/attachments/:sha256`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "write");
		if (access instanceof Response) return access;
		const data = await readAttachmentBody(c.req.raw);
		return data instanceof Response ? data : handlePutAttachment(c.env, access, c.req.param("traceId"), c.req.param("sha256"), data);
	});

	app.get(`${trace}/audiences`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		return handleGetAudiences(c.env, access, c.req.param("traceId"));
	});

	app.put(`${trace}/audiences`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "delete");
		if (access instanceof Response) return access;
		const body = await readJson(c.req.raw, 256 * 1024);
		return body instanceof Response ? body : handlePutAudiences(c.env, access, c.req.param("traceId"), body);
	});

	app.post(`${trace}/preview`, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "read");
		if (access instanceof Response) return access;
		const body = await readJson(c.req.raw, 64 * 1024);
		return body instanceof Response ? body : handlePreview(c.env, access, c.req.param("traceId"), body, c.req.query("segment"));
	});

	app.delete(trace, async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "delete");
		if (access instanceof Response) return access;
		return handleDeleteTrace(c.env, access, c.req.param("traceId"));
	});

	app.post("/api/shiplets/:projectId/trace-uploads", async (c) => {
		const access = await resolveTraceAccess(c.env, c.req.raw, c.req.param("projectId"), "write");
		if (access instanceof Response) return access;
		return handleCreateUploadLink(c.env, access, origin(c.req.raw, c.env));
	});

	app.post("/api/trace-uploads/:token", async (c) => {
		const resolved = await accessForUploadLink(c.env, c.req.param("token"));
		if (resolved instanceof Response) return resolved;
		if (resolved.link.trace_id) return traceError(409, "upload_link_used", "This upload link already created a trace.");
		const raw = await readUpload(c.req.raw);
		if (raw instanceof Response) return raw;
		const response = await handleCreateTrace(c.env, resolved.access, raw);
		if (response.ok) {
			const body = (await response.clone().json()) as { trace?: { id?: string } };
			if (body.trace?.id) await markUploadLinkUsed(c.env, resolved.link, body.trace.id);
		}
		return response;
	});

	app.put("/api/trace-uploads/:token/attachments/:sha256", async (c) => {
		const resolved = await accessForUploadLink(c.env, c.req.param("token"));
		if (resolved instanceof Response) return resolved;
		if (!resolved.link.trace_id) return traceError(409, "upload_link_unused", "Upload the trace before its attachments.");
		const data = await readAttachmentBody(c.req.raw);
		return data instanceof Response ? data : handlePutAttachment(c.env, resolved.access, resolved.link.trace_id, c.req.param("sha256"), data);
	});
}
