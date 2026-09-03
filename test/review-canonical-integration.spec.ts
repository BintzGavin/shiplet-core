import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import app from "../src/index";

const REVIEWER = {
	"x-shiplet-user-id": "user_canonical_review_owner",
	"x-shiplet-user-email": "canonical-review-owner@example.com",
};

async function request(path: string, init: RequestInit = {}) {
	const context = createExecutionContext();
	const response = await app.fetch(
		new Request(`http://localhost${path}`, init),
		env as Env,
		context,
	);
	await waitOnExecutionContext(context);
	return response;
}

async function fixture() {
	const organizationResponse = await request("/api/organizations", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...REVIEWER },
		body: JSON.stringify({ name: `Canonical Review ${crypto.randomUUID()}` }),
	});
	const { organization } = (await organizationResponse.json()) as {
		organization: { id: string };
	};
	const publishResponse = await request("/api/shiplets", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...REVIEWER },
		body: JSON.stringify({
			name: "Canonical Review Shiplet",
			organization_id: organization.id,
			subdomain: `canonical-review-${crypto.randomUUID().slice(0, 8)}`,
			visibility: "private",
			assets: [
				{
					path: "index.html",
					content: btoa("<!doctype html><h1>Review</h1>"),
				},
			],
		}),
	});
	const { project } = (await publishResponse.json()) as {
		project: { id: string };
	};
	const packageResponse = await request(`/api/shiplets/${project.id}/package`, {
		headers: REVIEWER,
	});
	const { revision } = (await packageResponse.json()) as {
		revision: { id: string };
	};
	return { organization, project, revision };
}

describe("review workflow canonical event integration", () => {
	it("maps feedback, replies, and custom status changes into the immutable global envelope", async () => {
		const { project, revision } = await fixture();
		const feedbackResponse = await request(
			`/api/projects/${project.id}/review-feedback`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...REVIEWER },
				body: JSON.stringify({
					comment: "Please clarify the headline.",
					pageUrl: `http://localhost/${project.id}`,
					clientFeedbackId: `client-${crypto.randomUUID()}`,
				}),
			},
		);
		expect(feedbackResponse.status).toBe(201);
		const { feedback } = (await feedbackResponse.json()) as {
			feedback: { id: string };
		};

		const replyResponse = await request(
			`/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...REVIEWER },
				body: JSON.stringify({ comment: "I can take this." }),
			},
		);
		expect(replyResponse.status).toBe(201);

		const statusResponse = await request(
			`/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...REVIEWER },
				body: JSON.stringify({ status: "Blocked" }),
			},
		);
		expect(statusResponse.status).toBe(200);

		const rows = await (env as Env).DB.prepare(
			`SELECT revision_id, actor_kind, actor_id, event_kind,
			 canonical_status_category, custom_payload_json
			 FROM shiplet_events WHERE project_id = ? ORDER BY created_at, rowid`,
		)
			.bind(project.id)
			.all<Record<string, unknown>>();
		expect(rows.results).toHaveLength(3);
		expect(rows.results.map((row) => row.event_kind)).toEqual([
			"review.feedback-created",
			"review.reply-created",
			"review.status-changed",
		]);
		expect(rows.results.map((row) => row.canonical_status_category)).toEqual([
			"open",
			"open",
			"in_progress",
		]);
		for (const row of rows.results) {
			expect(row).toMatchObject({
				revision_id: revision.id,
				actor_kind: "human",
				actor_id: REVIEWER["x-shiplet-user-id"],
			});
			expect(JSON.parse(String(row.custom_payload_json))).toMatchObject({
				feedbackId: feedback.id,
			});
		}
	});

	it("Given an organization API key mutates review state, When canonical events are stored, Then the authenticated token principal is the agent actor", async () => {
		const { organization, project } = await fixture();
		const tokenResponse = await request(
			`/api/organizations/${organization.id}/api-tokens`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...REVIEWER },
				body: JSON.stringify({
					name: "Canonical review agent",
					scopes: ["feedback:write", "mcp"],
					projectAccessMode: "all",
					projectRules: [],
				}),
			},
		);
		expect(tokenResponse.status).toBe(201);
		const tokenBody = (await tokenResponse.json()) as {
			token: string;
			record: { id: string };
		};
		const authorization = { Authorization: `Bearer ${tokenBody.token}` };

		const feedbackResponse = await request(
			`/api/projects/${project.id}/review-feedback`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...authorization,
				},
				body: JSON.stringify({
					comment: "Agent-authored review event",
					pageUrl: `http://localhost/${project.id}`,
					clientFeedbackId: `agent-${crypto.randomUUID()}`,
				}),
			},
		);
		expect(feedbackResponse.status).toBe(201);
		const { feedback } = (await feedbackResponse.json()) as {
			feedback: { id: string };
		};

		expect(
			await request(
				`/api/projects/${project.id}/review-feedback/${feedback.id}/replies`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...authorization,
					},
					body: JSON.stringify({ comment: "Agent reply" }),
				},
			),
		).toMatchObject({ status: 201 });
		expect(
			await request(
				`/api/projects/${project.id}/review-feedback/${feedback.id}/status`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...authorization,
					},
					body: JSON.stringify({ status: "In Progress" }),
				},
			),
		).toMatchObject({ status: 200 });

		async function executeCodeMode(
			method: "POST",
			path: string,
			body: Record<string, unknown>,
		) {
			const response = await request("/api/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...authorization,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "tools/call",
					params: {
						name: "execute",
						arguments: {
							code: `async () => await codemode.request(${JSON.stringify({
								method,
								path,
								body,
							})})`,
						},
					},
				}),
			});
			expect(response.status).toBe(200);
			const payload = (await response.json()) as {
				result: { content: Array<{ text: string }> };
			};
			return JSON.parse(payload.result.content[0].text) as Record<
				string,
				any
			>;
		}

		const mcpCreated = await executeCodeMode(
			"POST",
			`/api/projects/${project.id}/review-feedback`,
			{
				comment: "Code Mode agent event",
				pageUrl: `http://localhost/${project.id}/mcp`,
				clientFeedbackId: `mcp-agent-${crypto.randomUUID()}`,
			},
		);
		const mcpFeedbackId = mcpCreated.feedback.id as string;
		await executeCodeMode(
			"POST",
			`/api/projects/${project.id}/review-feedback/${mcpFeedbackId}/replies`,
			{ comment: "Code Mode agent reply" },
		);
		await executeCodeMode(
			"POST",
			`/api/projects/${project.id}/review-feedback/${mcpFeedbackId}/status`,
			{ status: "Blocked" },
		);

		const rows = await (env as Env).DB.prepare(
			`SELECT actor_kind, actor_id, event_kind
			 FROM shiplet_events
			 WHERE project_id = ? AND actor_id = ?
			 ORDER BY created_at, rowid`,
		)
			.bind(project.id, tokenBody.record.id)
			.all<Record<string, unknown>>();
		expect(rows.results).toHaveLength(6);
		expect(rows.results.map((row) => row.event_kind)).toEqual([
			"review.feedback-created",
			"review.reply-created",
			"review.status-changed",
			"review.feedback-created",
			"review.reply-created",
			"review.status-changed",
		]);
		expect(rows.results.every((row) => row.actor_kind === "agent")).toBe(true);
	});
});
