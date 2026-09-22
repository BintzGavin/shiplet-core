import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeedbackApp } from "../src/platform/feedback-app";
import { BuildGlobalFeedbackPage, DashboardRuntimeScript } from "../src/render";
import { reviewClientScript } from "../src/review-client";
import type { ReviewFeedbackRecord } from "../src/review";
import type { KernelDocumentNonce } from "../src/kernel-document-nonce";
import app from "../src/index";

const NONCE = "staging-surface-test-nonce" as KernelDocumentNonce;

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

function mcpPath(value: string) {
	const url = new URL(value);
	return `${url.pathname}${url.search}`;
}

async function execute(mcpEndpoint: string, id: number, operation: Record<string, unknown>) {
	const response = await request(mcpPath(mcpEndpoint), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id,
			method: "tools/call",
			params: {
				name: "execute",
				arguments: {
					code: `async () => await codemode.request(${JSON.stringify(operation)})`,
				},
			},
		}),
	});
	const body = (await response.json()) as {
		result?: { content?: Array<{ text?: string }> };
		error?: { code?: number; message?: string };
	};
	const text = body.result?.content?.[0]?.text;
	return {
		response,
		body,
		result: text ? (JSON.parse(text) as Record<string, any>) : null,
	};
}

function feedback(status: ReviewFeedbackRecord["status"]): ReviewFeedbackRecord {
	return {
		id: "feedback_staging_surface",
		project_id: "project_staging_surface",
		organization_id: "org_staging_surface",
		revision_id: null,
		ticket_number: 1,
		ticket_label: "PF-1",
		client_feedback_id: "client_staging_surface",
		name: "Reviewer",
		comment: "Stage this review",
		status,
		page_url: "https://shiplet.cc/review",
		pathname: "/review",
		page_url_key: "/review",
		screenshot_key: null,
		screenshot_url: null,
		screenshot_content_type: null,
		screenshot_size: null,
		screenshot_failure_note: null,
		screenshot_mode: "page",
		viewport: null,
		coordinates: null,
		selected_element: null,
		capture_context: null,
		user_agent: null,
		submitted_by_user_id: null,
		submitted_by_email: "reviewer@example.com",
		submitted_by_avatar_preset: null,
		submitted_by_avatar_data_url: null,
		source: "test",
		created_on: "2026-09-20T00:00:00.000Z",
		updated_on: "2026-09-20T00:00:00.000Z",
		project_name: "Staging surface",
		project_subdomain: "staging-surface",
		replies: [],
		mentions: [],
	};
}

describe("WRITE-15 Staging status surfaces", () => {
	it("persists Staging through the sandbox route, keeps it open, and rejects invalid or foreign writes", async () => {
		const sessionId = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
		const sessionResponse = await request(`/api/play/session?session=${sessionId}`);
		expect(sessionResponse.status).toBe(200);
		const session = (await sessionResponse.json()) as {
			session: { mcpUrl: string };
			shiplets: Array<{ id: string }>;
		};
		const endpoint = session.session.mcpUrl;
		const projectId = session.shiplets[0]?.id;
		expect(projectId).toBeTruthy();

		const created = await execute(endpoint, 1, {
			method: "POST",
			path: `/api/projects/${projectId}/review-feedback`,
			body: {
				comment: "Stage this review",
				pageUrl: `https://shiplet.cc/play/preview/${projectId}`,
				clientFeedbackId: `staging-${crypto.randomUUID()}`,
				screenshotMode: "page",
			},
		});
		expect(created.response.status).toBe(200);
		const feedbackId = created.result?.feedback?.id as string;
		expect(feedbackId).toMatch(/^sbf_/);

		const staged = await execute(endpoint, 2, {
			method: "POST",
			path: `/api/projects/${projectId}/review-feedback/${feedbackId}/status`,
			body: { status: "Staging" },
		});
		expect(staged.response.status).toBe(200);
		expect(staged.body.error).toBeUndefined();
		expect(staged.result?.feedback?.status).toBe("Staging");

		const openList = await execute(endpoint, 3, {
			method: "GET",
			path: `/api/projects/${projectId}/review-feedback`,
		});
		expect(openList.result?.feedback).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: feedbackId, status: "Staging" }),
			]),
		);

		const filtered = await execute(endpoint, 4, {
			method: "GET",
			path: `/api/projects/${projectId}/review-feedback`,
			query: { status: "Staging" },
		});
		expect(filtered.result?.feedback).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: feedbackId })]),
		);

		const malformed = await execute(endpoint, 5, {
			method: "POST",
			path: `/api/projects/${projectId}/review-feedback/${feedbackId}/status`,
			body: { status: "staging" },
		});
		expect(malformed.body.error).toMatchObject({
			code: -32000,
			message: "Invalid review status.",
		});

		const foreignEndpoint = new URL(endpoint);
		foreignEndpoint.searchParams.set("actor", `sba_${"f".repeat(32)}`);
		const foreign = await execute(foreignEndpoint.toString(), 6, {
			method: "POST",
			path: `/api/projects/${projectId}/review-feedback/${feedbackId}/status`,
			body: { status: "Staging" },
		});
		expect(foreign.body.error).toMatchObject({
			code: 404,
			message: "Review feedback not found",
		});
	});

	it("renders Staging as a usable option in every owned status surface", () => {
		const item = feedback("Staging");
		const platform = renderToStaticMarkup(
			React.createElement(FeedbackApp, {
				feedbackEndpoint: "/api/feedback",
				initialFeedback: [item],
				initialFilters: {
					projectId: null,
					status: null,
					mentionedMe: false,
					watched: false,
					submittedByMe: false,
				},
			}),
		);
		const globalFeedback = BuildGlobalFeedbackPage({ feedback: [item] });
		const dashboard = DashboardRuntimeScript(NONCE);
		const reviewClient = reviewClientScript();

		expect(platform).toContain('<option value="Staging">Staging</option>');
		expect(globalFeedback).toContain('<option value="Staging">Staging</option>');
		expect(dashboard).toContain(
			'["New", "In Progress", "Blocked", "Staging", "Done", "Dropped"]',
		);
		expect(reviewClient).toContain(
			'["New", "In Progress", "Blocked", "Staging", "Done", "Dropped"]',
		);
	});
});
