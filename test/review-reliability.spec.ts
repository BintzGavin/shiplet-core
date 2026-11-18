import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
import type { Project } from "../src/types";
import { createReviewFeedback, updateReviewStatus, validateReviewFeedbackPayload } from "../src/review";

const bindings = env as Env;
const headers = {
	"Content-Type": "application/json",
	"x-shiplet-user-id": "user_review_reliability",
	"x-shiplet-user-email": "review-reliability@example.com",
};

async function request(path: string, init: RequestInit = {}, runtime = bindings) {
	const context = createExecutionContext();
	const response = await app.fetch(new Request(`http://localhost${path}`, {
		...init, headers: { ...headers, ...init.headers },
	}), runtime, context);
	await waitOnExecutionContext(context);
	return response;
}

async function fixture() {
	const organizationResponse = await request("/api/organizations", {
		method: "POST", body: JSON.stringify({ name: `Reliability ${crypto.randomUUID()}` }),
	});
	expect(organizationResponse.status).toBe(201);
	const { organization } = await organizationResponse.json() as { organization: { id: string } };
	const response = await request("/api/shiplets", {
		method: "POST",
		body: JSON.stringify({
			name: "Reliability", organization_id: organization.id,
			subdomain: `reliability-${crypto.randomUUID().slice(0, 8)}`, visibility: "private",
			assets: [{ path: "index.html", content: btoa("<!doctype html><h1>Preserve me</h1>") }],
		}),
	});
	expect(response.status).toBe(201);
	return (await response.json() as { project: Project }).project;
}

function payload(screenshot = false) {
	const input = {
		comment: "Keep this review", pageUrl: "https://example.com/",
		clientFeedbackId: `client-${crypto.randomUUID()}`,
		...(screenshot ? { screenshotDataUrl: "data:image/png;base64,YQ==" } : {}),
	};
	const validation = validateReviewFeedbackPayload(input);
	if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
	return { input, value: validation.value };
}

describe("review persistence reliability", () => {
	it("Given two simultaneous submissions, when both commit, then unique tickets match their canonical events", async () => {
		const project = await fixture();
		let arrivals = 0;
		let release!: () => void;
		const ready = new Promise<void>((resolve) => { release = resolve; });
		const runtime = {
			...bindings,
			REVIEW_ASSETS: {
				async put(...args: Parameters<R2Bucket["put"]>) {
					const stored = await bindings.REVIEW_ASSETS!.put(...args);
					if (++arrivals === 2) release();
					await ready;
					return stored;
				},
				delete: bindings.REVIEW_ASSETS!.delete.bind(bindings.REVIEW_ASSETS),
			} as R2Bucket,
		};
		const feedback = await Promise.all([
			createReviewFeedback(runtime, project, null, payload(true).value),
			createReviewFeedback(runtime, project, null, payload(true).value),
		]);
		expect(feedback.every(Boolean)).toBe(true);
		expect(feedback.map((item) => item!.ticket_number).sort()).toEqual([1, 2]);
		const events = await bindings.DB.prepare(
			"SELECT custom_payload_json FROM shiplet_events WHERE project_id = ? AND event_kind = 'review.feedback-created'",
		).bind(project.id).all<{ custom_payload_json: string }>();
		expect(events.results).toHaveLength(2);
		for (const row of events.results) {
			const event = JSON.parse(row.custom_payload_json);
			expect(event.ticketNumber).toBe(feedback.find((item) => item!.id === event.feedbackId)!.ticket_number);
		}
	});

	it("Given retries with the same client ID, when submitted together and again, then each returns the original ticket without duplicate events", async () => {
		const project = await fixture();
		const body = payload(true).input;
		const submit = () => request(`/api/projects/${project.id}/review-feedback`, {
			method: "POST", body: JSON.stringify(body),
		});
		const responses = await Promise.all([submit(), submit()]);
		responses.push(await submit());
		const ids: string[] = [];
		for (const response of responses) {
			expect(response.status).toBe(201);
			const result = await response.json() as { feedback: { id: string } | null };
			expect(result.feedback).not.toBeNull();
			ids.push(result.feedback!.id);
		}
		expect(new Set(ids).size).toBe(1);
		const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?").bind(project.id).first<{ count: number }>();
		expect(count?.count).toBe(1);
		const objects = await bindings.REVIEW_ASSETS!.list({ prefix: `projects/${project.id}/feedback/` });
		expect(objects.objects).toHaveLength(1);
	});

	it.each(["review_feedback", "shiplet_events"])("Given %s persistence fails, when a screenshot was uploaded, then the API fails and rolls back every review effect", async (table) => {
		const project = await fixture();
		const trigger = `reject_review_${crypto.randomUUID().replace(/-/g, "")}`;
		await bindings.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} WHEN NEW.project_id = '${project.id}' BEGIN SELECT RAISE(ABORT, 'injected review failure'); END`).run();
		try {
			const response = await request(`/api/projects/${project.id}/review-feedback`, {
				method: "POST", body: JSON.stringify(payload(true).input),
			});
			expect(response.status).toBe(500);
			const objects = await bindings.REVIEW_ASSETS!.list({ prefix: `projects/${project.id}/feedback/` });
			expect(objects.objects).toHaveLength(0);
			for (const effectTable of ["review_feedback", "shiplet_events"]) {
				const count = await bindings.DB.prepare(`SELECT COUNT(*) AS count FROM ${effectTable} WHERE project_id = ?`).bind(project.id).first<{ count: number }>();
				expect(count?.count).toBe(0);
			}
		} finally {
			await bindings.DB.prepare(`DROP TRIGGER ${trigger}`).run();
		}
	});

	it("Given a nonexistent ticket, when its status is changed, then 404 leaves no canonical event", async () => {
		const project = await fixture();
		const response = await request(`/api/projects/${project.id}/review-feedback/missing/status`, {
			method: "POST", body: JSON.stringify({ status: "Done" }),
		});
		expect(response.status).toBe(404);
		const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?").bind(project.id).first<{ count: number }>();
		expect(count?.count).toBe(0);
	});

	it("Given an empty ticket ID from an agent, when its status is changed, then no canonical event is created", async () => {
		const project = await fixture();
		await expect(updateReviewStatus(bindings.DB, project.id, "", "Done", {
			revisionId: `legacy_${project.id}`, actor: { kind: "agent", id: "test-agent" },
		})).rejects.toMatchObject({ status: 404 });
		const count = await bindings.DB.prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?").bind(project.id).first<{ count: number }>();
		expect(count?.count).toBe(0);
	});

	it("Given a rejected revision fence, when feedback includes a screenshot, then no screenshot survives", async () => {
		const project = await fixture();
		const result = await createReviewFeedback(bindings, project, null, payload(true).value, {
			kind: "receipt", receiptHash: "nonexistent-receipt", installationId: "missing",
			revisionId: "missing", payloadDigest: "missing", requestId: "missing",
			claimedOn: new Date().toISOString(),
		});
		expect(result).toBeNull();
		const objects = await bindings.REVIEW_ASSETS!.list({ prefix: `projects/${project.id}/feedback/` });
		expect(objects.objects).toHaveLength(0);
	});

	it("Given a rejected fence and a cleanup failure, when discarding the screenshot, then the fence denial is preserved", async () => {
		const project = await fixture();
		let cleanupAttempted = false;
		const runtime = { ...bindings, REVIEW_ASSETS: {
			put: bindings.REVIEW_ASSETS!.put.bind(bindings.REVIEW_ASSETS),
			async delete() { cleanupAttempted = true; throw new Error("injected cleanup failure"); },
		} as unknown as R2Bucket };
		const result = await createReviewFeedback(runtime, project, null, payload(true).value, {
			kind: "receipt", receiptHash: "nonexistent-receipt", installationId: "missing",
			revisionId: "missing", payloadDigest: "missing", requestId: "missing",
			claimedOn: new Date().toISOString(),
		});
		expect(result).toBeNull();
		expect(cleanupAttempted).toBe(true);
	});
});

describe("permanent deletion safety", () => {
	it("Given the record purge fails, when deletion is attempted, then all original and review assets survive and the project can be restored", async () => {
		const project = await fixture();
		const feedback = await createReviewFeedback(bindings, project, null, payload(true).value);
		expect(feedback?.screenshot_key).toBeTruthy();
		const before = await bindings.DB.prepare("SELECT object_key FROM project_assets WHERE project_id = ?").bind(project.id).all<{ object_key: string }>();
		expect(before.results.length).toBeGreaterThan(0);
		expect((await request(`/api/projects/${project.id}/archive`, { method: "POST" })).status).toBe(200);
		const trigger = `reject_purge_${crypto.randomUUID().replace(/-/g, "")}`;
		await bindings.DB.prepare(`CREATE TRIGGER ${trigger} BEFORE DELETE ON review_feedback WHEN OLD.project_id = '${project.id}' BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END`).run();
		try {
			const response = await request(`/api/projects/${project.id}`, {
				method: "DELETE", body: JSON.stringify({ confirmSubdomain: project.subdomain }),
			});
			expect(response.status).toBe(500);
		} finally {
			await bindings.DB.prepare(`DROP TRIGGER ${trigger}`).run();
		}
		const after = await bindings.DB.prepare("SELECT object_key FROM project_assets WHERE project_id = ?").bind(project.id).all<{ object_key: string }>();
		expect(after.results).toEqual(before.results);
		for (const row of before.results) expect(await bindings.SHIPLET_ASSETS!.get(row.object_key)).not.toBeNull();
		expect(await bindings.REVIEW_ASSETS!.head(feedback!.screenshot_key!)).not.toBeNull();
		expect(await bindings.DB.prepare("SELECT COUNT(*) AS count FROM shiplet_events WHERE project_id = ?").bind(project.id).first<{ count: number }>())
			.toEqual({ count: 1 });
		expect((await request(`/api/projects/${project.id}/restore`, { method: "POST" })).status).toBe(200);
		const restoredArtifact = await request(`/${project.subdomain}/__shiplet/artifact-frame/`);
		expect(restoredArtifact.status).toBe(200);
		expect(await restoredArtifact.text()).toContain("Preserve me");
	});

	it("Given canonical events outside a permanent deletion, when one is deleted, then it remains immutable", async () => {
		const project = await fixture();
		await createReviewFeedback(bindings, project, null, payload().value);
		await expect(bindings.DB.prepare("DELETE FROM shiplet_events WHERE project_id = ?").bind(project.id).run())
			.rejects.toThrow(/shiplet_events are immutable/);
	});

	it("Given a deletable project, when record and object cleanup succeed, then no incomplete-cleanup warning is returned", async () => {
		const project = await fixture();
		const assets = await bindings.DB.prepare("SELECT object_key FROM project_assets WHERE project_id = ?").bind(project.id).all<{ object_key: string }>();
		await request(`/api/projects/${project.id}/archive`, { method: "POST" });
		const response = await request(`/api/projects/${project.id}`, {
			method: "DELETE", body: JSON.stringify({ confirmSubdomain: project.subdomain }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: true, projectId: project.id, cleanupIncomplete: false });
		for (const asset of assets.results) expect(await bindings.SHIPLET_ASSETS!.get(asset.object_key)).toBeNull();
		expect(await bindings.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).toBeNull();
	});

	it("Given feedback with a screenshot and an attachment, when the Shiplet is permanently deleted, then both review objects are removed", async () => {
		const project = await fixture();
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
		const submitted = await request(`/api/projects/${project.id}/review-feedback`, {
			method: "POST",
			body: JSON.stringify({
				comment: "Remove my evidence",
				pageUrl: "https://example.com/",
				clientFeedbackId: `client-${crypto.randomUUID()}`,
				screenshotDataUrl: "data:image/png;base64,YQ==",
				richPayload: {
					version: 1,
					screenshotAnnotations: null,
					captureFidelity: null,
					attachments: [{
						id: "evidence-1", name: "evidence.png", mimeType: "image/png",
						size: pngBytes.byteLength, dataUrl: `data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`,
					}],
					copyRequest: null,
				},
			}),
		});
		expect(submitted.status, await submitted.clone().text()).toBe(201);
		const { feedback } = await submitted.json() as { feedback: { id: string } };
		const screenshot = await bindings.DB.prepare("SELECT screenshot_key FROM review_feedback WHERE id = ?")
			.bind(feedback.id).first<{ screenshot_key: string | null }>();
		const attachment = await bindings.DB.prepare("SELECT object_key FROM review_feedback_attachments WHERE feedback_id = ?")
			.bind(feedback.id).first<{ object_key: string }>();
		const reviewKeys = [screenshot?.screenshot_key, attachment?.object_key];
		expect(reviewKeys.every(Boolean)).toBe(true);
		for (const key of reviewKeys) expect(await bindings.REVIEW_ASSETS!.head(key!)).not.toBeNull();

		expect((await request(`/api/projects/${project.id}/archive`, { method: "POST" })).status).toBe(200);
		const response = await request(`/api/projects/${project.id}`, {
			method: "DELETE", body: JSON.stringify({ confirmSubdomain: project.subdomain }),
		});
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toEqual({ deleted: true, projectId: project.id, cleanupIncomplete: false });
		for (const key of reviewKeys) expect(await bindings.REVIEW_ASSETS!.head(key!)).toBeNull();
	});

	it("Given more than 1,000 review objects and a failing review bucket, when deleting, then keys are deleted in batches and incomplete cleanup is reported", async () => {
		const project = await fixture();
		const feedback = await createReviewFeedback(bindings, project, null, payload(true).value);
		const createdOn = new Date().toISOString();
		const attachmentKeys = Array.from({ length: 1_000 }, (_, index) => `projects/${project.id}/feedback/${feedback!.id}/attachments/a${index}/digest`);
		for (let index = 0; index < attachmentKeys.length; index += 50) {
			await bindings.DB.batch(attachmentKeys.slice(index, index + 50).map((key, offset) => bindings.DB.prepare(
				`INSERT INTO review_feedback_attachments (project_id, feedback_id, attachment_id, ordinal, file_name, content_type, byte_length, digest, object_key, created_on)
				 VALUES (?, ?, ?, ?, 'a.png', 'image/png', 1, 'sha256:digest', ?, ?)`,
			).bind(project.id, feedback!.id, `a${index + offset}`, index + offset, key, createdOn)));
		}
		await request(`/api/projects/${project.id}/archive`, { method: "POST" });
		const batches: string[][] = [];
		const runtime = { ...bindings, REVIEW_ASSETS: {
			async delete(keys: string | string[]) {
				batches.push(Array.isArray(keys) ? keys : [keys]);
				if (batches.length === 1) throw new Error("injected review cleanup failure");
			},
		} as unknown as R2Bucket };
		const response = await request(`/api/projects/${project.id}`, {
			method: "DELETE", body: JSON.stringify({ confirmSubdomain: project.subdomain }),
		}, runtime);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: true, projectId: project.id, cleanupIncomplete: true });
		expect(batches.map((keys) => keys.length)).toEqual([1_000, 1]);
		expect(new Set(batches.flat())).toEqual(new Set([feedback!.screenshot_key!, ...attachmentKeys]));
		expect(await bindings.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).toBeNull();
	});

	it("Given cleanup fails after record deletion, when deleting, then the response truthfully reports deletion and incomplete cleanup", async () => {
		const project = await fixture();
		await request(`/api/projects/${project.id}/archive`, { method: "POST" });
		const runtime = { ...bindings, SHIPLET_ASSETS: {
			async delete() { throw new Error("injected cleanup failure"); },
		} as unknown as R2Bucket };
		const response = await request(`/api/projects/${project.id}`, {
			method: "DELETE", body: JSON.stringify({ confirmSubdomain: project.subdomain }),
		}, runtime);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ deleted: true, projectId: project.id, cleanupIncomplete: true });
		expect(await bindings.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).toBeNull();
	});
});
