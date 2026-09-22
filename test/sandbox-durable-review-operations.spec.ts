import {
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";
import type { Env } from "../src/env";

type SandboxFixture = Awaited<ReturnType<typeof sandboxFixture>>;

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	const response = await app.fetch(
		new Request(/^https?:\/\//.test(path) ? path : `http://localhost${path}`, init),
		env as unknown as Env,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

function cookies(response: Response) {
	return (response.headers.get("set-cookie") || "")
		.split(/,(?=\s*(?:shiplet_sandbox|shiplet_sandbox_actor)=)/)
		.map((value) => value.split(";")[0])
		.join("; ");
}

function actorId(fixture: SandboxFixture) {
	return decodeURIComponent(fixture.cookie.match(/shiplet_sandbox_actor=([^;]+)/)![1]);
}

function pngBytes() {
	return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}

function dataUrl(bytes: Uint8Array, contentType: string) {
	return `data:${contentType};base64,${btoa(String.fromCharCode(...bytes))}`;
}

async function sandboxFixture() {
	const sessionId = `sbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const response = await request(`/api/play/session?session=${sessionId}`);
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		shiplets: Array<{ id: string; previewUrl: string }>;
	};
	const project = body.shiplets[0];
	return {
		sessionId,
		project,
		cookie: cookies(response),
		pageUrl: `https://shiplet.cc/play/preview/${encodeURIComponent(project.id)}`,
		revisionId: `sandbox_${project.id}`,
	};
}

function operationQuery(
	fixture: SandboxFixture,
	effect: "feedback.create" | "feedback.reply" | "feedback.status",
	feedbackId?: string,
) {
	const query = new URLSearchParams({
		revision_id: fixture.revisionId,
		page_url: fixture.pageUrl,
		effect,
	});
	if (feedbackId) query.set("feedback_id", feedbackId);
	return query.toString();
}

function createBody(fixture: SandboxFixture, requestId?: string) {
	return {
		comment: "Durable sandbox feedback",
		pageUrl: fixture.pageUrl,
		clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
		screenshotMode: "page",
		...(requestId ? { requestId } : {}),
	};
}

async function createFeedback(
	fixture: SandboxFixture,
	body: Record<string, unknown>,
) {
	return request(`/api/projects/${fixture.project.id}/review-feedback`, {
		method: "POST",
		headers: { "content-type": "application/json", cookie: fixture.cookie },
		body: JSON.stringify(body),
	});
}

async function feedbackCount(fixture: SandboxFixture) {
	const stub = (env as unknown as Env).SANDBOX_SESSION.getByName(fixture.sessionId);
	return runInDurableObject(stub, async (_instance, state) =>
		state.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) AS count FROM feedback WHERE project_id = ?", fixture.project.id)
			.one().count,
	);
}

describe("sandbox durable review operations", () => {
	it("publishes the canonical durable context from server-resolved bindings", async () => {
		const fixture = await sandboxFixture();
		const response = await request(
			`/api/projects/${fixture.project.id}/review-draft-context?revision_id=caller&` +
				`page_url=${encodeURIComponent("https://attacker.invalid/preview")}`,
			{ headers: { cookie: fixture.cookie } },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			context: {
				actor: { kind: "sandbox", id: expect.stringMatching(/^sba_[a-z0-9]{32}$/) },
				projectId: fixture.project.id,
				revisionId: fixture.revisionId,
				pageUrl: fixture.pageUrl,
				installationId: null,
				expiresOn: null,
				durableOperations: true,
			},
		});
	});

	it("recovers a response-lost create and exact replay without a second effect", async () => {
		const fixture = await sandboxFixture();
		const requestId = `request_${crypto.randomUUID()}`;
		const body = createBody(fixture, requestId);
		const before = await feedbackCount(fixture);
		const created = await createFeedback(fixture, body);
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { feedback: { id: string } };

		const outcome = await request(
			`/api/projects/${fixture.project.id}/review-operations/${requestId}?${operationQuery(fixture, "feedback.create")}`,
			{ headers: { cookie: fixture.cookie } },
		);
		expect(outcome.status).toBe(200);
		expect(await outcome.json()).toEqual({
			operation: {
				requestId,
				effect: "feedback.create",
				state: "completed",
				result: { feedbackId: createdBody.feedback.id },
			},
		});

		const replay = await createFeedback(fixture, body);
		expect(replay.status).toBe(201);
		expect(((await replay.json()) as { feedback: { id: string } }).feedback.id).toBe(
			createdBody.feedback.id,
		);
		expect(await feedbackCount(fixture)).toBe(before + 1);

		const changed = await createFeedback(fixture, { ...body, comment: "Changed replay" });
		expect(changed.status).toBe(409);
		expect(await feedbackCount(fixture)).toBe(before + 1);
	});

	it("recovers response-lost reply and status with one preallocated identity", async () => {
		const fixture = await sandboxFixture();
		const base = await createFeedback(fixture, createBody(fixture));
		const feedback = ((await base.json()) as { feedback: { id: string } }).feedback;
		const replyRequestId = `request_${crypto.randomUUID()}`;
		const replyBody = { comment: "One durable reply", requestId: replyRequestId };
		const replyPath = `/api/projects/${fixture.project.id}/review-feedback/${feedback.id}/replies`;
		const firstReply = await request(replyPath, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: fixture.cookie },
			body: JSON.stringify(replyBody),
		});
		expect(firstReply.status).toBe(201);
		const firstReplyFeedback = ((await firstReply.json()) as { feedback: { replies: Array<{ id: string }> } }).feedback;
		const replyId = firstReplyFeedback.replies.at(-1)!.id;
		const replayReply = await request(replyPath, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: fixture.cookie },
			body: JSON.stringify(replyBody),
		});
		const replayReplyFeedback = ((await replayReply.json()) as { feedback: { replies: Array<{ id: string }> } }).feedback;
		expect(replayReplyFeedback.replies.filter((reply) => reply.id === replyId)).toHaveLength(1);

		const statusRequestId = `request_${crypto.randomUUID()}`;
		const statusPath = `/api/projects/${fixture.project.id}/review-feedback/${feedback.id}/status`;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await request(statusPath, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: fixture.cookie },
				body: JSON.stringify({ status: "Done", requestId: statusRequestId }),
			});
			expect(response.status).toBe(200);
			expect(((await response.json()) as { feedback: { status: string } }).feedback.status).toBe("Done");
		}

		for (const [requestId, effect, result] of [
			[replyRequestId, "feedback.reply", { feedbackId: feedback.id, replyId }],
			[statusRequestId, "feedback.status", { feedbackId: feedback.id }],
		] as const) {
			const response = await request(
				`/api/projects/${fixture.project.id}/review-operations/${requestId}?${operationQuery(fixture, effect, feedback.id)}`,
				{ headers: { cookie: fixture.cookie } },
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				operation: { requestId, effect, state: "completed", result },
			});
		}
	});

	it("lets cancellation win once and keeps foreign or malformed requests mutation-free", async () => {
		const fixture = await sandboxFixture();
		const requestId = `request_${crypto.randomUUID()}`;
		const stub = (env as unknown as Env).SANDBOX_SESSION.getByName(fixture.sessionId);
		await runInDurableObject(stub, async (instance: any) => {
			await instance.prepareDurableOperation({
				requestId,
				actorId: actorId(fixture),
				sessionId: fixture.sessionId,
				projectId: fixture.project.id,
				revisionId: fixture.revisionId,
				pageUrl: fixture.pageUrl,
				effect: "feedback.create",
				targetId: null,
				payloadDigest: "0".repeat(64),
			});
		});
		const before = await feedbackCount(fixture);
		const cancel = await request(
			`/api/projects/${fixture.project.id}/review-operations/${requestId}/cancel`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: fixture.cookie,
					origin: "http://localhost",
				},
				body: JSON.stringify({
					revisionId: fixture.revisionId,
					pageUrl: fixture.pageUrl,
					effect: "feedback.create",
				}),
			},
		);
		expect(cancel.status).toBe(200);
		expect(await cancel.json()).toEqual({
			operation: { requestId, effect: "feedback.create", state: "cancelled", result: null },
		});
		expect(await feedbackCount(fixture)).toBe(before);

		const malformed = await request(
			`/api/projects/${fixture.project.id}/review-operations/${requestId}/cancel?effect=feedback.create`,
			{
				method: "POST",
				headers: { "content-type": "text/plain", cookie: fixture.cookie, origin: "http://localhost" },
				body: "{}",
			},
		);
		expect(malformed.status).toBe(415);
		expect(malformed.headers.get("cache-control")).toBe("private, no-store");
		expect(await feedbackCount(fixture)).toBe(before);

		const cancelledRetry = await createFeedback(fixture, {
			...createBody(fixture),
			requestId,
		});
		expect(cancelledRetry.status).toBe(409);
		expect(await feedbackCount(fixture)).toBe(before);
	});

	it("keeps completed, expired, failed, and unknown IDs terminal", async () => {
		const fixture = await sandboxFixture();
		const completedId = `request_${crypto.randomUUID()}`;
		const completed = await createFeedback(fixture, createBody(fixture, completedId));
		const completedFeedback = ((await completed.json()) as { feedback: { id: string } }).feedback;
		const cancelCompleted = await request(
			`/api/projects/${fixture.project.id}/review-operations/${completedId}/cancel`,
			{
				method: "POST",
				headers: { "content-type": "application/json", cookie: fixture.cookie, origin: "http://localhost" },
				body: JSON.stringify({
					revisionId: fixture.revisionId,
					pageUrl: fixture.pageUrl,
					effect: "feedback.create",
				}),
			},
		);
		expect(await cancelCompleted.json()).toEqual({
			operation: {
				requestId: completedId,
				effect: "feedback.create",
				state: "completed",
				result: { feedbackId: completedFeedback.id },
			},
		});

		const stub = (env as unknown as Env).SANDBOX_SESSION.getByName(fixture.sessionId);
		for (const state of ["expired", "failed", "unknown"] as const) {
			const requestId = `request_${state}_${crypto.randomUUID()}`;
			await runInDurableObject(stub, async (instance: any, stateStorage) => {
				await instance.prepareDurableOperation({
					requestId,
					actorId: actorId(fixture),
					sessionId: fixture.sessionId,
					projectId: fixture.project.id,
					revisionId: fixture.revisionId,
					pageUrl: fixture.pageUrl,
					effect: "feedback.create",
					targetId: null,
					payloadDigest: "1".repeat(64),
				});
				stateStorage.storage.sql.exec(
					"UPDATE durable_review_operations SET state = ? WHERE request_id = ?",
					state,
					requestId,
				);
			});
			const outcome = await request(
				`/api/projects/${fixture.project.id}/review-operations/${requestId}?${operationQuery(fixture, "feedback.create")}`,
				{ headers: { cookie: fixture.cookie } },
			);
			expect(outcome.status).toBe(200);
			expect(await outcome.json()).toEqual({
				operation: { requestId, effect: "feedback.create", state, result: null },
			});
			const retry = await createFeedback(fixture, { ...createBody(fixture), requestId });
			expect(retry.status).toBe(409);
		}
	});

	it("fails actor, page, revision, effect, and target transplants closed", async () => {
		const fixture = await sandboxFixture();
		const requestId = `request_${crypto.randomUUID()}`;
		await createFeedback(fixture, createBody(fixture, requestId));
		const anotherActor = await request(`/api/play/session?session=${fixture.sessionId}`);
		const foreignCookie = cookies(anotherActor);
		const paths = [
			`/api/projects/${fixture.project.id}/review-operations/${requestId}?${operationQuery(fixture, "feedback.create")}`,
			`/api/projects/${fixture.project.id}/review-operations/${requestId}?revision_id=foreign&page_url=${encodeURIComponent(fixture.pageUrl)}&effect=feedback.create`,
			`/api/projects/${fixture.project.id}/review-operations/${requestId}?revision_id=${encodeURIComponent(fixture.revisionId)}&page_url=${encodeURIComponent("https://attacker.invalid/play")}&effect=feedback.create`,
			`/api/projects/${fixture.project.id}/review-operations/${requestId}?revision_id=${encodeURIComponent(fixture.revisionId)}&page_url=${encodeURIComponent(fixture.pageUrl)}&effect=feedback.reply&feedback_id=sbf_foreign`,
		];
		const responses = await Promise.all(paths.map((path, index) =>
			request(path, { headers: { cookie: index === 0 ? foreignCookie : fixture.cookie } }),
		));
		for (const response of responses) {
			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
			expect(await response.json()).toEqual({ error: "review_operation_not_found" });
		}
	});

	it("stages rich attachments before the atomic effect and serves only verified private bytes", async () => {
		const fixture = await sandboxFixture();
		const bytes = pngBytes();
		const requestId = `request_${crypto.randomUUID()}`;
		const response = await createFeedback(fixture, {
			...createBody(fixture, requestId),
			richPayload: {
				version: 1,
				screenshotAnnotations: null,
				captureFidelity: { version: 1, kind: "raster-source", limitations: [] },
				attachments: [{
					id: "asset-1",
					name: "capture.png",
					mimeType: "image/png",
					size: bytes.byteLength,
					dataUrl: dataUrl(bytes, "image/png"),
				}],
				copyRequest: null,
			},
		});
		expect(response.status).toBe(201);
		const feedback = ((await response.json()) as {
			feedback: { id: string; attachments: Array<{ content_url: string; digest: string }> };
		}).feedback;
		expect(feedback.attachments).toHaveLength(1);
		expect(JSON.stringify(feedback)).not.toContain("object_key");
		const get = await request(feedback.attachments[0].content_url, { headers: { cookie: fixture.cookie } });
		expect(get.status).toBe(200);
		expect(get.headers.get("content-type")).toBe("image/png");
		expect(get.headers.get("cache-control")).toBe("private, no-store");
		expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
		const head = await request(feedback.attachments[0].content_url, {
			method: "HEAD",
			headers: { cookie: fixture.cookie },
		});
		expect(head.status).toBe(200);
		expect((await head.arrayBuffer()).byteLength).toBe(0);

		const key =
			`projects/${fixture.project.id}/feedback/${feedback.id}/attachments/asset-1/` +
			feedback.attachments[0].digest.replace(/^sha256:/, "");
		await (env as unknown as Env).REVIEW_ASSETS.put(key, new Uint8Array([1, 2, 3]), {
			httpMetadata: { contentType: "image/png" },
		});
		const tampered = await request(feedback.attachments[0].content_url, { headers: { cookie: fixture.cookie } });
		expect(tampered.status).toBe(404);
		expect(await tampered.json()).toEqual({ error: "review_attachment_not_found" });
	});

	it("preserves legacy synchronous writes without creating operation rows", async () => {
		const fixture = await sandboxFixture();
		const response = await createFeedback(fixture, createBody(fixture));
		expect(response.status).toBe(201);
		const created = ((await response.clone().json()) as { feedback: { id: string } }).feedback;
		const listed = await request(
			`/api/projects/${fixture.project.id}/review-feedback?includeClosed=true&limit=100`,
			{ headers: { cookie: fixture.cookie } },
		);
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as { feedback: Array<{ id: string }> };
		expect(Object.keys(listedBody)).toEqual(["feedback"]);
		expect(listedBody.feedback.some((item) => item.id === created.id)).toBe(true);
		const stub = (env as unknown as Env).SANDBOX_SESSION.getByName(fixture.sessionId);
		const counts = await runInDurableObject(stub, async (_instance, state) => ({
			operations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_review_operations").one().count,
			feedback: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM feedback WHERE project_id = ?", fixture.project.id).one().count,
		}));
		expect(counts.operations).toBe(0);
		expect(counts.feedback).toBeGreaterThanOrEqual(2);
	});
});
