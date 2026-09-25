import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

async function requestHelper(path: string, options?: RequestInit) {

	const request = new Request(
		/^https?:\/\//.test(path) ? path : `http://localhost${path}`,
		options,
	);
	const context = createExecutionContext();
	const response = await app.fetch(request, env as unknown as Env, context);
	await waitOnExecutionContext(context);
	return response;
}

function cookieHeaderFromResponse(response: Response) {
	return (response.headers.get("set-cookie") || "")
		.split(/,(?=\s*(?:shiplet_sandbox|shiplet_sandbox_actor)=)/)
		.map((value) => value.split(";")[0])
		.join("; ");
}

async function createSandbox() {
	const sessionId = `sbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
	const response = await requestHelper(`/api/play/session?session=${sessionId}`);
	const body = (await response.json()) as {
		session: { mcpUrl: string };
		shiplets: Array<{ id: string; previewUrl: string }>;
	};
	return {
		sessionId,
		cookie: cookieHeaderFromResponse(response),
		project: body.shiplets[0],
		mcpUrl: body.session.mcpUrl,
	};
}

async function createSandboxActor(sessionId: string) {
	const response = await requestHelper(`/api/play/session?session=${sessionId}`);
	return cookieHeaderFromResponse(response);
}

function sandboxNamespace() {
	return (env as unknown as Env).SANDBOX_SESSION;
}

async function createFeedback(
	project: { id: string; previewUrl: string },
	cookie: string,
	input: {
		comment?: string;
		pageUrl?: string;
		name?: string;
		revisionId?: string;
	},
) {
	const pageUrl = input.pageUrl || `https://shiplet.cc${project.previewUrl}`;
	const response = await requestHelper(
		`/api/projects/${project.id}/review-feedback`,
		{
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({
				comment: input.comment || `modern-${crypto.randomUUID()}`,
				name: input.name,
				pageUrl,
				clientFeedbackId: `client-${crypto.randomUUID().slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
				screenshotMode: "page",
				revisionId: input.revisionId,
			}),
		},
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as {
		feedback: { id: string; comment: string; status: string };
	};
	return body.feedback;
}

async function updateStatus(
	projectId: string,
	cookie: string,
	feedbackId: string,
	status: string,
) {
	const response = await requestHelper(
		`/api/projects/${projectId}/review-feedback/${feedbackId}/status`,
		{
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ status }),
		},
	);
	expect(response.status).toBe(200);
}

async function modernList(
	projectId: string,
	cookie: string,
	query: Record<string, string | undefined> = {},
) {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) params.set(key, value);
	}
	return requestHelper(
		`/api/projects/${projectId}/review-feedback?${params.toString()}`,
		{ headers: { cookie } },
	);
}

describe("sandbox modern feedback query", () => {
	it("returns the modern page envelope from the real sandbox route", async () => {
		const { cookie, project } = await createSandbox();
		const response = await requestHelper(
			`/api/projects/${project.id}/review-feedback?state=open&limit=1`,
			{ headers: { cookie } },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			feedback: Array<{ revision_id: string | null }>;
			nextCursor: string | null;
		};
		expect(body).toHaveProperty("nextCursor");
		expect(body.feedback[0]).toHaveProperty("revision_id");
		expect(response.headers.get("cache-control")).toBe("no-store");

		const falseMentions = await modernList(project.id, cookie, {
			state: "open",
			mentionedMe: "false",
			limit: "1",
		});
		expect(falseMentions.status).toBe(200);
		expect(falseMentions.headers.get("cache-control")).toBe("no-store");

		const legacy = await requestHelper(
			`/api/projects/${project.id}/review-feedback?pageUrl=https%3A%2F%2Fshiplet.cc${encodeURIComponent(project.previewUrl)}&limit=1`,
			{ headers: { cookie } },
		);
		expect(legacy.status).toBe(200);
		const legacyBody = (await legacy.json()) as Record<string, unknown>;
		expect(Object.keys(legacyBody)).toEqual(["feedback"]);
	});

	it("returns the explicit recoverable Mentions capability error", async () => {
		const { cookie, project } = await createSandbox();
		const response = await requestHelper(
			`/api/projects/${project.id}/review-feedback?state=open&mentionedMe=true`,
			{ headers: { cookie } },
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "sandbox_filter_unsupported",
			filter: "mentionedMe",
		});
	});

	it("binds explicit modern scopes to their required page or prefix fields", async () => {
		const { cookie, project } = await createSandbox();
		const base = `https://shiplet.cc${project.previewUrl}`;
		await createFeedback(project, cookie, { comment: "scope-page", pageUrl: `${base}/docs/start` });
		await createFeedback(project, cookie, { comment: "scope-other", pageUrl: `${base}/other` });

		const missingPage = await modernList(project.id, cookie, {
			state: "all",
			scope: "page",
			limit: "100",
		});
		expect(missingPage.status).toBe(400);
		expect(missingPage.headers.get("cache-control")).toBe("no-store");

		const page = await modernList(project.id, cookie, {
			state: "all",
			scope: "page",
			pageUrl: `${base}/docs/start?tab=ignored`,
			limit: "100",
		});
		expect(page.status).toBe(200);
		const pageBody = (await page.json()) as { feedback: Array<{ comment: string }> };
		expect(pageBody.feedback.map((item) => item.comment)).toEqual(["scope-page"]);

		const missingPrefix = await modernList(project.id, cookie, {
			state: "all",
			scope: "prefix",
			limit: "100",
		});
		expect(missingPrefix.status).toBe(400);

		const siteWithPage = await modernList(project.id, cookie, {
			state: "all",
			scope: "site",
			pageUrl: base,
			limit: "100",
		});
		expect(siteWithPage.status).toBe(400);

		const repeatedScope = await requestHelper(
			`/api/projects/${project.id}/review-feedback?state=all&scope=page&scope=page&pageUrl=${encodeURIComponent(base)}`,
			{ headers: { cookie } },
		);
		expect(repeatedScope.status).toBe(400);
	});

	it("traverses every eligible row beyond 250 with a complete tied timestamp order", async () => {
		const { sessionId, cookie, project } = await createSandbox();
		const created: string[] = [];
		for (let index = 0; index < 256; index += 1) {
			created.push(
				(
					await createFeedback(project, cookie, {
						comment: `bulk-${index}`,
					})
				).id,
			);
		}
		const stub = sandboxNamespace().getByName(sessionId);
		const tiedTimestamp = new Date(Date.now() - 1_000).toISOString();
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE feedback SET created_on = ?, updated_on = ? WHERE project_id = ?",
				tiedTimestamp,
				tiedTimestamp,
				project.id,
			);
			return undefined;
		});

		const ids: string[] = [];
		const timestamps: string[] = [];
		const pageSizes: number[] = [];
		let cursor: string | undefined;
		do {
			const response = await modernList(project.id, cookie, {
				state: "all",
				limit: "37",
				cursor,
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				feedback: Array<{ id: string; created_on: string }>;
				nextCursor: string | null;
			};
			pageSizes.push(body.feedback.length);
			ids.push(...body.feedback.map((item) => item.id));
			timestamps.push(...body.feedback.map((item) => item.created_on));
			cursor = body.nextCursor || undefined;
		} while (cursor);

		expect(ids).toHaveLength(257);
		expect(new Set(ids).size).toBe(257);
		expect(new Set(timestamps)).toEqual(new Set([tiedTimestamp]));
		expect(Math.max(...pageSizes)).toBeLessThanOrEqual(37);
		expect(ids).toEqual([...ids].sort().reverse());
		expect(created.every((id) => ids.includes(id))).toBe(true);
	});

	it("applies state, exact page, prefix, revision, and Mine filters before pagination", async () => {
		const { sessionId, cookie, project } = await createSandbox();
		const actorB = await createSandboxActor(sessionId);
		const base = `https://shiplet.cc${project.previewUrl}`;
		const rows = await Promise.all(
			Array.from({ length: 24 }, (_, index) =>
				createFeedback(index % 2 ? project : project, index % 2 ? actorB : cookie, {
					comment: `filter-${index}`,
					pageUrl:
						index % 4 === 0
							? `${base}/docs/start?mode=edit`
							: index % 4 === 1
								? `${base}/docs/start?mode=view`
								: index % 4 === 2
									? `${base}/docs/other`
									: `${base}/docs/${index}`,
					revisionId: "caller-must-not-win",
				}),
			),
		);
		await updateStatus(project.id, cookie, rows[1].id, "Done");
		await updateStatus(project.id, cookie, rows[2].id, "Dropped");
		await updateStatus(project.id, cookie, rows[3].id, "Staging");

		const open = await modernList(project.id, cookie, {
			state: "open",
			pagePrefix: `${base}/docs`,
			limit: "3",
		});
		expect(open.status).toBe(200);
		const openBody = (await open.json()) as {
			feedback: Array<{ status: string; page_url: string; revision_id: string | null }>;
			nextCursor: string | null;
		};
		expect(openBody.feedback.length).toBeLessThanOrEqual(3);
		expect(openBody.feedback.every((item) => !["Done", "Dropped"].includes(item.status))).toBe(true);
		expect(openBody.feedback.every((item) => item.revision_id === `sandbox_${project.id}`)).toBe(true);
		expect(openBody.nextCursor).toBeTruthy();

		const mine = await modernList(project.id, cookie, {
			state: "all",
			submittedByMe: "true",
			limit: "100",
		});
		expect(mine.status).toBe(200);
		const mineBody = (await mine.json()) as {
			feedback: Array<{ id: string }>;
			nextCursor: string | null;
		};
		const actorARows = new Set(rows.filter((_, index) => index % 2 === 0).map((row) => row.id));
		expect(mineBody.feedback.every((item) => actorARows.has(item.id))).toBe(true);
		expect(mineBody.feedback.some((item) => item.id === rows[1].id)).toBe(false);

		const everyone = await modernList(project.id, cookie, {
			state: "all",
			limit: "100",
		});
		expect(everyone.status).toBe(200);
		const everyoneBody = (await everyone.json()) as { feedback: Array<{ id: string }> };
		expect(everyoneBody.feedback.map((item) => item.id)).toEqual(
			expect.arrayContaining(rows.map((row) => row.id)),
		);

		const closed = await modernList(project.id, cookie, {
			state: "closed",
			limit: "100",
		});
		expect(closed.status).toBe(200);
		const closedBody = (await closed.json()) as {
			feedback: Array<{ id: string; status: string }>;
		};
		expect(closedBody.feedback.map((item) => item.id)).toEqual(
			expect.arrayContaining([rows[1].id, rows[2].id]),
		);
		expect(closedBody.feedback.some((item) => item.id === rows[3].id)).toBe(false);
	});

	it("preserves the legacy public and Code Mode actor visibility contract", async () => {
		const first = await createSandbox();
		const secondCookie = await createSandboxActor(first.sessionId);
		const firstRow = await createFeedback(first.project, first.cookie, {
			comment: "legacy actor one",
		});
		const secondRow = await createFeedback(first.project, secondCookie, {
			comment: "legacy actor two",
		});

		const publicResponse = await requestHelper(
			`/api/projects/${first.project.id}/review-feedback?includeClosed=true`,
			{ headers: { cookie: first.cookie } },
		);
		expect(publicResponse.status).toBe(200);
		const publicBody = (await publicResponse.json()) as {
			feedback: Array<{ id: string }>;
		};
		expect(publicBody.feedback.map((item) => item.id)).toEqual(
			expect.arrayContaining([firstRow.id, secondRow.id]),
		);

		async function codeModeList(query: string) {
			const response = await requestHelper(first.mcpUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "tools/call",
					params: {
						name: "execute",
						arguments: {
							code: `async () => await codemode.request({ method: "GET", path: "/api/projects/${first.project.id}/review-feedback", query: ${query} })`,
						},
					},
				}),
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
			return JSON.parse(body.result.content[0].text) as { feedback: Array<{ id: string }> };
		}

		const actorScoped = await codeModeList("{ includeClosed: true }");
		expect(actorScoped.feedback.map((item) => item.id)).toContain(firstRow.id);
		expect(actorScoped.feedback.map((item) => item.id)).not.toContain(secondRow.id);
		const publicCodeMode = await codeModeList("{ includeClosed: true, includeSharedUntrusted: true }");
		expect(publicCodeMode.feedback.map((item) => item.id)).toContain(secondRow.id);
	});

	it("keeps ordinary queries collapsed, hash routes distinct, and prefixes segment-aware", async () => {
		const { cookie, project } = await createSandbox();
		const base = `https://shiplet.cc${project.previewUrl}`;
		await createFeedback(project, cookie, { comment: "query-one", pageUrl: `${base}/app?tab=one` });
		await createFeedback(project, cookie, { comment: "query-two", pageUrl: `${base}/app?tab=two` });
		await createFeedback(project, cookie, { comment: "hash-edit", pageUrl: `${base}/app#/docs/start?mode=edit` });
		await createFeedback(project, cookie, { comment: "hash-view", pageUrl: `${base}/app#/docs/start?mode=view` });
		await createFeedback(project, cookie, { comment: "hash-other", pageUrl: `${base}/app#/docs/other` });
		await createFeedback(project, cookie, { comment: "percent", pageUrl: `${base}/literal%25/_value` });
		await createFeedback(project, cookie, { comment: "percent-descendant", pageUrl: `${base}/literal%25/child` });
		await createFeedback(project, cookie, { comment: "percent-sibling", pageUrl: `${base}/literalX25/child` });
		await createFeedback(project, cookie, { comment: "underscore-descendant", pageUrl: `${base}/literal%25/_/child` });
		await createFeedback(project, cookie, { comment: "underscore-sibling", pageUrl: `${base}/literal%25/X/child` });
		await createFeedback(project, cookie, { comment: "case", pageUrl: `${base}/App` });

		const exact = await modernList(project.id, cookie, {
			state: "all",
			pageUrl: `${base}/app?tab=other`,
			limit: "100",
		});
		expect(exact.status).toBe(200);
		const exactBody = (await exact.json()) as { feedback: Array<{ comment: string }> };
		expect(exactBody.feedback.map((item) => item.comment)).toEqual(
			expect.arrayContaining(["query-one", "query-two"]),
		);

		const hashExact = await modernList(project.id, cookie, {
			state: "all",
			pageUrl: `${base}/app#/docs/start?mode=preview`,
			limit: "100",
		});
		const hashBody = (await hashExact.json()) as { feedback: Array<{ comment: string }> };
		expect(hashBody.feedback.map((item) => item.comment)).toEqual(
			expect.arrayContaining(["hash-edit", "hash-view"]),
		);
		expect(hashBody.feedback.map((item) => item.comment)).not.toContain("hash-other");

		const prefix = await modernList(project.id, cookie, {
			state: "all",
			pagePrefix: `${base}/app#/docs`,
			limit: "100",
		});
		const prefixBody = (await prefix.json()) as { feedback: Array<{ comment: string }> };
		expect(prefixBody.feedback.map((item) => item.comment)).toEqual(
			expect.arrayContaining(["hash-edit", "hash-view", "hash-other"]),
		);
		expect(prefixBody.feedback.map((item) => item.comment)).not.toContain("query-one");

		const percentPrefix = await modernList(project.id, cookie, {
			state: "all",
			pagePrefix: `${base}/literal%25`,
			limit: "100",
		});
		const percentPrefixBody = (await percentPrefix.json()) as { feedback: Array<{ comment: string }> };
		expect(percentPrefixBody.feedback.map((item) => item.comment)).toEqual(
			expect.arrayContaining(["percent", "percent-descendant"]),
		);
		expect(percentPrefixBody.feedback.map((item) => item.comment)).not.toContain("percent-sibling");

		const underscorePrefix = await modernList(project.id, cookie, {
			state: "all",
			pagePrefix: `${base}/literal%25/_`,
			limit: "100",
		});
		const underscorePrefixBody = (await underscorePrefix.json()) as { feedback: Array<{ comment: string }> };
		expect(underscorePrefixBody.feedback.map((item) => item.comment)).toContain("underscore-descendant");
		expect(underscorePrefixBody.feedback.map((item) => item.comment)).not.toContain("underscore-sibling");

		const caseExact = await modernList(project.id, cookie, {
			state: "all",
			pageUrl: `${base}/App?case=preserved`,
			limit: "100",
		});
		const caseBody = (await caseExact.json()) as { feedback: Array<{ comment: string }> };
		expect(caseBody.feedback.map((item) => item.comment)).toEqual(["case"]);

		for (const bad of [
			`${base}/literal%2Fbad`,
			`${base}/literal%5Cbad`,
			`https://other.test${project.previewUrl}/docs`,
		]) {
			const response = await modernList(project.id, cookie, {
				state: "all",
				pagePrefix: bad,
			});
				expect(response.status).toBe(400);
		}
	});

	it("rejects transplanted, malformed, oversized, and filter-mismatched cursors", async () => {
		const first = await createSandbox();
		const second = await createSandbox();
		const actorB = await createSandboxActor(first.sessionId);
		for (let index = 0; index < 4; index += 1) {
			await createFeedback(first.project, cookieHeaderFromResponse(await requestHelper(`/api/play/session?session=${first.sessionId}`)), {
				comment: `cursor-${index}`,
			});
		}
		const page = await modernList(first.project.id, first.cookie, {
			state: "all",
			limit: "1",
		});
		const pageBody = (await page.json()) as { nextCursor: string | null };
		expect(pageBody.nextCursor).toBeTruthy();
		const cursor = pageBody.nextCursor!;

		const attempts = [
			[first.project.id, actorB, { state: "all", limit: "1", cursor }],
			[first.project.id, first.cookie, { state: "closed", limit: "1", cursor }],
			[first.project.id, first.cookie, { state: "all", pagePrefix: "https://shiplet.cc/other", limit: "1", cursor }],
			[first.project.id, first.cookie, { state: "all", revisionId: `sandbox_${first.project.id}`, limit: "1", cursor }],
			[second.project.id, second.cookie, { state: "all", limit: "1", cursor }],
			[first.project.id, first.cookie, { state: "all", submittedByMe: "true", limit: "1", cursor }],
		];
		for (const [projectId, cookie, query] of attempts) {
			const response = await modernList(projectId as string, cookie as string, query as Record<string, string>);
			expect(response.status).toBe(400);
			expect((await response.json()) as { feedback?: unknown }).not.toHaveProperty("feedback");
		}
		for (const query of [
			{ state: "unknown" },
			{ state: "open", limit: "0" },
			{ state: "open", limit: "101" },
			{ submittedByMe: "maybe" },
			{ state: "open", status: "New" },
			{ state: "open", pageUrl: "https://shiplet.cc/app", pagePrefix: "https://shiplet.cc/app" },
		]) {
			const response = await modernList(first.project.id, first.cookie, query);
			expect(response.status, JSON.stringify(query)).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
		for (const malformed of ["", "not-a-cursor", "v2", "A".repeat(1025)]) {
			const response = await modernList(first.project.id, first.cookie, {
				state: "all",
				limit: "1",
				cursor: malformed,
			});
			expect(response.status).toBe(400);
		}
		const tampered = Buffer.from(cursor, "base64url").toString("base64url").replace(/.$/, "A");
		const tamperedResponse = await modernList(first.project.id, first.cookie, {
			state: "all",
			limit: "1",
			cursor: tampered,
		});
		expect(tamperedResponse.status).toBe(400);
	});

	it("keeps trusted sandbox revisions immutable through status and reply mutations", async () => {
		const { cookie, project } = await createSandbox();
		const row = await createFeedback(project, cookie, {
			comment: "immutable revision row",
			revisionId: "caller-revision-must-be-ignored",
		});
		const expectedRevision = `sandbox_${project.id}`;
		const before = await modernList(project.id, cookie, {
			state: "all",
			revisionId: expectedRevision,
			pageUrl: `https://shiplet.cc${project.previewUrl}`,
			limit: "100",
		});
		const beforeBody = (await before.json()) as {
			feedback: Array<{ id: string; revision_id: string | null }>;
		};
		expect(beforeBody.feedback.find((item) => item.id === row.id)?.revision_id).toBe(expectedRevision);

		await updateStatus(project.id, cookie, row.id, "Done");
		const reply = await requestHelper(
			`/api/projects/${project.id}/review-feedback/${row.id}/replies`,
			{
				method: "POST",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({ comment: "revision must survive replies" }),
			},
		);
		expect(reply.status).toBe(201);
		const after = await modernList(project.id, cookie, {
			state: "all",
			limit: "100",
		});
		const afterBody = (await after.json()) as {
			feedback: Array<{ id: string; revision_id: string | null; status: string }>;
		};
		const afterRow = afterBody.feedback.find((item) => item.id === row.id);
		expect(afterRow?.status).toBe("Done");
		expect(afterRow?.revision_id).toBe(expectedRevision);
	});

	it("migrates nullable legacy provenance and recovered hash keys idempotently", async () => {
		const { sessionId, cookie, project } = await createSandbox();
		const stub = sandboxNamespace().getByName(sessionId);
		const validUrl = `https://shiplet.cc${project.previewUrl}#/docs/start?mode=edit`;
		const invalidUrl = "not-a-valid-url";
		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec("DROP TABLE feedback");
			state.storage.sql.exec(`
				CREATE TABLE feedback (
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
				)
			`);
			const now = new Date().toISOString();
			for (const [id, pageUrl] of [["legacy-valid", validUrl], ["legacy-invalid", invalidUrl]]) {
				state.storage.sql.exec(
					`INSERT INTO feedback
					 (id, project_id, ticket_number, client_feedback_id, name, comment, status,
					  page_url, pathname, page_url_key, screenshot_mode, submitted_by_email,
					  created_by_actor, created_on, updated_on)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					id,
					project.id,
					id === "legacy-valid" ? 2 : 3,
					`client-${id}-legacy`,
					null,
					id,
					"New",
					pageUrl,
					new URL(validUrl).pathname,
					new URL(validUrl).pathname,
					"page",
					null,
					"sandbox_seed",
					now,
					now,
				);
			}
			(instance as unknown as { migrate(): void }).migrate();
			(instance as unknown as { migrate(): void }).migrate();
			return undefined;
		});

		const first = await modernList(project.id, cookie, { state: "all", limit: "100" });
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			feedback: Array<{ id: string; revision_id: string | null; page_url: string }>;
		};
		const valid = firstBody.feedback.find((item) => item.id === "legacy-valid");
		const invalid = firstBody.feedback.find((item) => item.id === "legacy-invalid");
		expect(valid?.revision_id).toBeNull();
		expect(invalid?.revision_id).toBeNull();
		const hash = await modernList(project.id, cookie, {
			state: "all",
			pageUrl: `${validUrl}#ignored`,
			limit: "100",
		});
		expect(hash.status).toBe(200);
		const hashBody = (await hash.json()) as { feedback: Array<{ id: string }> };
		expect(hashBody.feedback.map((item) => item.id)).toContain("legacy-valid");

		const second = await modernList(project.id, cookie, { state: "all", limit: "100" });
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			feedback: Array<{ id: string; revision_id: string | null }>;
		};
		expect(secondBody.feedback.find((item) => item.id === "legacy-valid")?.revision_id).toBeNull();
		const legacyColumns = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.sql
				.exec<{ id: string; page_url: string; page_url_key: string; modern_page_url_key: string | null }>(
					"SELECT id, page_url, page_url_key, modern_page_url_key FROM feedback WHERE id IN (?, ?)",
					"legacy-valid",
					"legacy-invalid",
				)
				.toArray(),
		);
		expect(legacyColumns).toEqual(
			expect.arrayContaining([
			{
				id: "legacy-valid",
				page_url: validUrl,
				page_url_key: new URL(validUrl).pathname,
				modern_page_url_key: `${new URL(validUrl).origin}${new URL(validUrl).pathname}#/docs/start`,
			},
			{
				id: "legacy-invalid",
				page_url: invalidUrl,
				page_url_key: new URL(validUrl).pathname,
				modern_page_url_key: null,
			},
			]),
		);
	});
});
