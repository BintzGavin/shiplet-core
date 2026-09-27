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
	it("Given feedback prevents the record purge, when deletion fails, then all original assets survive and the project can be restored", async () => {
		const project = await fixture();
		await createReviewFeedback(bindings, project, null, payload().value);
		const before = await bindings.DB.prepare("SELECT object_key FROM project_assets WHERE project_id = ?").bind(project.id).all<{ object_key: string }>();
		expect(before.results.length).toBeGreaterThan(0);
		expect((await request(`/api/projects/${project.id}/archive`, { method: "POST" })).status).toBe(200);
		const response = await request(`/api/projects/${project.id}`, {
			method: "DELETE", body: JSON.stringify({ confirmSubdomain: project.subdomain }),
		});
		expect(response.status).toBe(500);
		const after = await bindings.DB.prepare("SELECT object_key FROM project_assets WHERE project_id = ?").bind(project.id).all<{ object_key: string }>();
		expect(after.results).toEqual(before.results);
		for (const row of before.results) expect(await bindings.SHIPLET_ASSETS!.get(row.object_key)).not.toBeNull();
		expect((await request(`/api/projects/${project.id}/restore`, { method: "POST" })).status).toBe(200);
		const restoredArtifact = await request(`/${project.subdomain}/__shiplet/artifact-frame/`);
		expect(restoredArtifact.status).toBe(200);
		expect(await restoredArtifact.text()).toContain("Preserve me");
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
