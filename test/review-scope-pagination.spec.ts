import {
	createExecutionContext,
	env,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	createEmbedReviewSession,
	createEmbedReviewSessionCookieHeader,
} from "../src/embed";
import app from "../src/index";
import { ensureSchema } from "../src/schema";
import { getProjectById, getUser } from "../src/store";

const OWNER = {
	"x-shiplet-user-id": "user_query_scope_owner",
	"x-shiplet-user-email": "query-scope-owner@example.com",
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

async function fixture(options: { external?: boolean } = {}) {
	const organizationResponse = await request("/api/organizations", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER },
		body: JSON.stringify({ name: `Scoped review ${crypto.randomUUID()}` }),
	});
	expect(organizationResponse.status).toBe(201);
	const { organization } = (await organizationResponse.json()) as {
		organization: { id: string };
	};
	const projectResponse = await request("/api/shiplets", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...OWNER },
		body: JSON.stringify({
			name: "Scoped review Shiplet",
			organization_id: organization.id,
			subdomain: `scope-${crypto.randomUUID().slice(0, 8)}`,
			...(options.external
				? { external_url: "https://scope-site.example.com/" }
				: {
						visibility: "private",
						assets: [
							{
								path: "index.html",
								content: btoa("<!doctype html><h1>Scope</h1>"),
							},
						],
					}),
		}),
	});
	expect(projectResponse.status).toBe(201);
	const { project: publicProject } = (await projectResponse.json()) as {
		project: { id: string };
	};
	const packageResponse = await request(
		`/api/shiplets/${publicProject.id}/package`,
		{ headers: OWNER },
	);
	expect(packageResponse.status).toBe(200);
	const { revision } = (await packageResponse.json()) as {
		revision: { id: string };
	};
	const project = await getProjectById((env as Env).DB, publicProject.id);
	const user = await getUser((env as Env).DB, OWNER["x-shiplet-user-id"]);
	if (!project || !user) throw new Error("Scoped review fixture unavailable");
	return { organization, project, revision, user };
}

type SeedFeedback = {
	id: string;
	projectId: string;
	organizationId: string;
	ticketNumber: number;
	pageUrl: string;
	createdOn: string;
	status?: string;
	submittedByUserId?: string | null;
	comment?: string;
};

function pageUrlKey(pageUrl: string) {
	const url = new URL(pageUrl);
	return `${url.origin}${url.pathname}${url.hash.startsWith("#/") ? url.hash.split("?")[0] : ""}`;
}

function seedFeedbackStatement(input: SeedFeedback) {
	const url = new URL(input.pageUrl);
	return (env as Env).DB.prepare(
		`INSERT INTO review_feedback (
		 id, project_id, organization_id, ticket_number, client_feedback_id,
		 comment, status, page_url, pathname, page_url_key,
		 submitted_by_user_id, submitted_by_email, created_on, updated_on
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		input.id,
		input.projectId,
		input.organizationId,
		input.ticketNumber,
		`client-${input.id}`,
		input.comment || input.id,
		input.status || "New",
		input.pageUrl,
		url.pathname || "/",
		pageUrlKey(input.pageUrl),
		input.submittedByUserId === undefined
			? OWNER["x-shiplet-user-id"]
			: input.submittedByUserId,
		input.submittedByUserId === null
			? null
			: OWNER["x-shiplet-user-email"],
		input.createdOn,
		input.createdOn,
	);
}

async function listProject(
	projectId: string,
	query: Record<string, string>,
	headers: HeadersInit = OWNER,
) {
	const response = await request(
		`/api/projects/${projectId}/review-feedback?${new URLSearchParams(query)}`,
		{ headers },
	);
	const responseText = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(responseText);
	} catch {
		body = responseText;
	}
	return { response, body };
}

describe("review feedback scope, provenance, and pagination", () => {
	it("migrates legacy feedback rows idempotently without inventing revision provenance", async () => {
		const db = (env as Env).DB;
		await ensureSchema(db);
		await db.prepare("PRAGMA foreign_keys = OFF").run();
		await db.prepare("DROP TABLE review_feedback").run();
		await db
			.prepare(
				`CREATE TABLE review_feedback (
				 id TEXT PRIMARY KEY,
				 project_id TEXT NOT NULL,
				 organization_id TEXT NOT NULL,
				 ticket_number INTEGER NOT NULL,
				 client_feedback_id TEXT NOT NULL,
				 name TEXT,
				 comment TEXT NOT NULL,
				 status TEXT NOT NULL DEFAULT 'New',
				 page_url TEXT NOT NULL,
				 pathname TEXT NOT NULL,
				 page_url_key TEXT NOT NULL,
				 screenshot_key TEXT,
				 screenshot_content_type TEXT,
				 screenshot_size INTEGER,
				 screenshot_failure_note TEXT,
				 screenshot_mode TEXT NOT NULL DEFAULT 'page',
				 viewport_json TEXT,
				 coordinates_json TEXT,
				 selected_element_json TEXT,
				 capture_context_json TEXT,
				 user_agent TEXT,
				 submitted_by_user_id TEXT,
				 submitted_by_email TEXT,
				 source TEXT NOT NULL DEFAULT 'web',
				 created_on TEXT NOT NULL,
				 updated_on TEXT NOT NULL,
				 UNIQUE (project_id, ticket_number),
				 UNIQUE (project_id, client_feedback_id)
				)`,
			)
			.run();
		await db
			.prepare(
				`INSERT INTO review_feedback (
				 id, project_id, organization_id, ticket_number, client_feedback_id,
				 comment, page_url, pathname, page_url_key, created_on, updated_on
				) VALUES ('legacy-review', 'legacy-project', 'legacy-org', 1,
				 'legacy-client', 'Earlier feedback', 'https://legacy.example/docs',
				 '/docs', 'https://legacy.example/docs', '2026-01-01T00:00:00.000Z',
				 '2026-01-01T00:00:00.000Z')`,
			)
			.run();
		await ensureSchema(db);
		await ensureSchema(db);
		const columns = await db
			.prepare("PRAGMA table_info(review_feedback)")
			.all<{ name: string }>();
		expect(columns.results?.map((column) => column.name)).toContain(
			"revision_id",
		);
		const legacy = await db
			.prepare("SELECT id, revision_id FROM review_feedback WHERE id = ?")
			.bind("legacy-review")
			.first<{ id: string; revision_id: string | null }>();
		expect(legacy).toEqual({ id: "legacy-review", revision_id: null });
		await db
			.prepare(
				`INSERT INTO review_feedback (
				 id, project_id, organization_id, revision_id, ticket_number,
				 client_feedback_id, comment, page_url, pathname, page_url_key,
				 created_on, updated_on
				) VALUES ('current-review', 'legacy-project', 'legacy-org',
				 'revision_current', 2, 'current-client', 'Current feedback',
				 'https://legacy.example/docs', '/docs',
				 'https://legacy.example/docs', '2026-02-01T00:00:00.000Z',
				 '2026-02-01T00:00:00.000Z')`,
			)
			.run();
		const migratedRows = await db
			.prepare(
				"SELECT id, revision_id FROM review_feedback ORDER BY created_on",
			)
			.all<{ id: string; revision_id: string | null }>();
		expect(migratedRows.results).toEqual([
			{ id: "legacy-review", revision_id: null },
			{ id: "current-review", revision_id: "revision_current" },
		]);
		await db.prepare("PRAGMA foreign_keys = ON").run();
	});

	it("stores server-owned revision provenance for direct and confirmed writes", async () => {
		const { organization, project, revision, user } = await fixture({
			external: true,
		});
		const pageUrl = "https://scope-site.example.com/docs/current";
		const direct = await request(
			`/api/projects/${project.id}/review-feedback`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", ...OWNER },
				body: JSON.stringify({
					comment: "Direct current revision",
					pageUrl,
					clientFeedbackId: `direct-${crypto.randomUUID()}`,
					revisionId: "revision_client_spoof",
				}),
			},
		);
		expect(direct.status).toBe(201);

		const installationId = `embed_installation_${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		await (env as Env).DB.prepare(
			`INSERT INTO embed_installations (
			 id, project_id, organization_id, site_origin, site_url, site_name,
			 secret_hash, created_by_user_id, created_on, last_used_on, revoked_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		)
			.bind(
				installationId,
				project.id,
				organization.id,
				"https://scope-site.example.com",
				"https://scope-site.example.com/",
				"Scope site",
				crypto.randomUUID(),
				user.id,
				now,
			)
			.run();
		const installation = await (env as Env).DB.prepare(
			"SELECT * FROM embed_installations WHERE id = ?",
		)
			.bind(installationId)
			.first<any>();
		const session = await createEmbedReviewSession((env as Env).DB, {
			installation,
			project,
			revisionId: revision.id,
			user,
			pageUrl,
		});
		const cookie = createEmbedReviewSessionCookieHeader({
			installationId,
			sessionHandle: session.sessionHandle,
			now: new Date(),
			expiresOn: session.expiresOn,
		}).split(";", 1)[0];
		const confirmedClientId = `confirmed-${crypto.randomUUID()}`;
		const intent = await request(
			`/embed/review/confirm?${new URLSearchParams({ installation_id: installationId, page_url: pageUrl })}`,
			{
				method: "POST",
				headers: {
					Cookie: cookie,
					Origin: "http://localhost",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					request_id: `request_${crypto.randomUUID()}`,
					operation: "feedback.create",
					comment: "Confirmed current revision",
					page_url: pageUrl,
					client_feedback_id: confirmedClientId,
				}),
			},
		);
		expect(intent.status).toBe(200);
		const intentId = (await intent.text()).match(
			/name="intent_id" value="([^"]+)"/,
		)?.[1];
		expect(intentId).toMatch(/^embed_intent_/);
		const complete = await request("/embed/review/confirm/complete", {
			method: "POST",
			headers: {
				Origin: "http://localhost",
				"Content-Type": "application/x-www-form-urlencoded",
				...OWNER,
			},
			body: new URLSearchParams({
				intent_id: intentId || "",
				approval: "confirm",
			}),
		});
		expect(complete.status).toBe(200);

		await (env as Env).DB.batch([
			seedFeedbackStatement({
				id: `legacy-${crypto.randomUUID()}`,
				projectId: project.id,
				organizationId: organization.id,
				ticketNumber: 90,
				pageUrl,
				createdOn: "2025-01-01T00:00:00.000Z",
			}),
			seedFeedbackStatement({
				id: `old-revision-${crypto.randomUUID()}`,
				projectId: project.id,
				organizationId: organization.id,
				ticketNumber: 91,
				pageUrl,
				createdOn: "2025-02-01T00:00:00.000Z",
			}),
		]);
		await (env as Env).DB.prepare(
			"UPDATE review_feedback SET revision_id = ? WHERE project_id = ? AND ticket_number = 91",
		)
			.bind("revision_proven_earlier", project.id)
			.run();

		const stored = await (env as Env).DB.prepare(
			`SELECT comment, revision_id FROM review_feedback
			 WHERE project_id = ? ORDER BY ticket_number`,
		)
			.bind(project.id)
			.all<{ comment: string; revision_id: string | null }>();
		expect(
			stored.results
				?.filter((row) => row.comment.includes("current revision"))
				.map((row) => row.revision_id),
		).toEqual([revision.id, revision.id]);
		expect(stored.results?.some((row) => row.revision_id === "revision_client_spoof")).toBe(false);

		const exact = await listProject(project.id, {
			revisionId: revision.id,
			state: "all",
			limit: "100",
		});
		expect(exact.response.status).toBe(200);
		expect(
			(exact.body as { feedback: Array<{ revision_id: string | null }> }).feedback.map(
				(row) => row.revision_id,
			),
		).toEqual([revision.id, revision.id]);
		const all = await listProject(project.id, { state: "all", limit: "100" });
		expect(
			(all.body as { feedback: Array<{ revision_id: string | null }> }).feedback.map(
				(row) => row.revision_id,
			),
		).toEqual(expect.arrayContaining([revision.id, null, "revision_proven_earlier"]));
	});

	it("applies exact page, segment prefix, state, mine, and mention filters before paging", async () => {
		const { organization, project } = await fixture();
		const baseTime = Date.parse("2026-06-01T00:00:00.000Z");
		const initial: SeedFeedback[] = Array.from({ length: 275 }, (_, index) => ({
			id: `review-page-${String(index).padStart(3, "0")}`,
			projectId: project.id,
			organizationId: organization.id,
			ticketNumber: index + 1,
			pageUrl:
				index === 270
					? "https://query.example/docstring"
					: index === 271
						? "https://foreign.example/docs/start"
						: index === 272
							? "https://query.example/100%25/child"
							: index === 273
								? "https://query.example/under_score/child"
								: index === 274
									? "https://query.example/docs%2Fencoded"
									: index === 266
										? "https://query.example/docs"
										: "https://query.example/docs/start",
			createdOn: new Date(baseTime + Math.floor(index / 3) * 1000).toISOString(),
			status:
				index === 268 ? "Done" : index === 267 ? "Dropped" : index === 269 ? "Staging" : "New",
			submittedByUserId: index === 269 ? "user_someone_else" : OWNER["x-shiplet-user-id"],
		}));
		await (env as Env).DB.batch(initial.map(seedFeedbackStatement));
		const mentionedId = initial[2].id;
		const replyMentionedId = initial[3].id;
		await (env as Env).DB.batch([
			(env as Env).DB.prepare(
				`INSERT INTO review_feedback_mentions (
				 id, project_id, organization_id, feedback_id, reply_id,
				 mentioned_user_id, mentioned_email, access_status, created_on
				) VALUES (?, ?, ?, ?, NULL, ?, ?, 'active', ?)`,
			).bind(
				`mention-${crypto.randomUUID()}`,
				project.id,
				organization.id,
				mentionedId,
				OWNER["x-shiplet-user-id"],
				OWNER["x-shiplet-user-email"],
				"2026-06-02T00:00:00.000Z",
			),
			(env as Env).DB.prepare(
				`INSERT INTO review_feedback_replies (
				 id, feedback_id, project_id, comment, author_user_id, author_email, created_on
				) VALUES (?, ?, ?, 'Reply mention', ?, ?, ?)`,
			).bind(
				"reply-query-mention",
				replyMentionedId,
				project.id,
				"user_someone_else",
				"someone@example.com",
				"2026-06-02T00:00:00.000Z",
			),
			(env as Env).DB.prepare(
				`INSERT INTO review_feedback_mentions (
				 id, project_id, organization_id, feedback_id, reply_id,
				 mentioned_user_id, mentioned_email, access_status, created_on
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
			).bind(
				`mention-${crypto.randomUUID()}`,
				project.id,
				organization.id,
				replyMentionedId,
				"reply-query-mention",
				OWNER["x-shiplet-user-id"],
				OWNER["x-shiplet-user-email"],
				"2026-06-02T00:00:00.000Z",
			),
		]);
		const hostedWidgetList = await request(
			`/${project.subdomain}/__shiplet/review/feedback?${new URLSearchParams({
				pagePrefix: "https://query.example/docs",
				state: "all",
				limit: "2",
			})}`,
			{ headers: OWNER },
		);
		expect(hostedWidgetList.status).toBe(200);
		const hostedWidgetPayload = (await hostedWidgetList.json()) as {
			feedback: Array<{ id: string }>;
			nextCursor: string | null;
		};
		expect(hostedWidgetPayload.feedback).toHaveLength(2);
		expect(hostedWidgetPayload.nextCursor).toBeTruthy();

		const expectedInitialIds = initial
			.slice()
			.sort((left, right) =>
				right.createdOn.localeCompare(left.createdOn) || right.id.localeCompare(left.id),
			)
			.map((row) => row.id);
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const page = await listProject(project.id, {
				state: "all",
				limit: "37",
				...(cursor ? { cursor } : {}),
			});
			expect(page.response.status).toBe(200);
			const payload = page.body as {
				feedback: Array<{ id: string }>;
				nextCursor: string | null;
			};
			seen.push(...payload.feedback.map((row) => row.id));
			cursor = payload.nextCursor;
			if (seen.length === 37) {
				await (env as Env).DB.batch([
					seedFeedbackStatement({
						id: "review-inserted-after-page-one",
						projectId: project.id,
						organizationId: organization.id,
						ticketNumber: 500,
						pageUrl: "https://query.example/docs/start",
						createdOn: "2027-01-01T00:00:00.000Z",
					}),
				]);
			}
		} while (cursor);
		expect(seen).toEqual(expectedInitialIds);
		expect(new Set(seen).size).toBe(seen.length);

		const prefix = await listProject(project.id, {
			pagePrefix: "https://query.example/docs",
			state: "all",
			limit: "100",
		});
		expect(prefix.response.status).toBe(200);
		const prefixIds = (prefix.body as { feedback: Array<{ id: string }> }).feedback.map(
			(row) => row.id,
		);
		expect(prefixIds).toContain(initial[266].id);
		expect(prefixIds).not.toContain(initial[270].id);
		expect(prefixIds).not.toContain(initial[271].id);
		expect(prefixIds).not.toContain(initial[274].id);
		const exactPage = await listProject(project.id, {
			pageUrl: "https://query.example/docs/start",
			state: "all",
			limit: "100",
		});
		const exactPageIds = (
			exactPage.body as { feedback: Array<{ id: string }> }
		).feedback.map((row) => row.id);
		expect(exactPageIds).not.toContain(initial[266].id);
		expect(exactPageIds).not.toContain(initial[270].id);
		expect(exactPageIds).not.toContain(initial[271].id);

		const literalPercent = await listProject(project.id, {
			pagePrefix: "https://query.example/100%25",
			state: "all",
			limit: "10",
		});
		expect(
			(literalPercent.body as { feedback: Array<{ id: string }> }).feedback.map(
				(row) => row.id,
			),
		).toEqual([initial[272].id]);
		const literalUnderscore = await listProject(project.id, {
			pagePrefix: "https://query.example/under_score",
			state: "all",
			limit: "10",
		});
		expect(
			(literalUnderscore.body as { feedback: Array<{ id: string }> }).feedback.map(
				(row) => row.id,
			),
		).toEqual([initial[273].id]);

		const closed = await listProject(project.id, { state: "closed", limit: "10" });
		expect(
			(closed.body as { feedback: Array<{ status: string }> }).feedback.map(
				(row) => row.status,
			),
		).toEqual(expect.arrayContaining(["Done", "Dropped"]));
		const open = await listProject(project.id, { state: "open", limit: "100" });
		expect(
			(open.body as { feedback: Array<{ status: string }> }).feedback.map(
				(row) => row.status,
			),
		).toContain("Staging");

		const mine = await listProject(project.id, {
			state: "all",
			submittedByMe: "true",
			userId: "user_someone_else",
			limit: "100",
		});
		expect(
			(mine.body as { feedback: Array<{ submitted_by_user_id: string | null }> }).feedback.every(
				(row) => row.submitted_by_user_id === OWNER["x-shiplet-user-id"],
			),
		).toBe(true);
		const mentioned = await listProject(project.id, {
			state: "all",
			mentionedMe: "true",
			limit: "10",
		});
		expect(
			(mentioned.body as { feedback: Array<{ id: string }> }).feedback.map(
				(row) => row.id,
			),
		).toEqual(expect.arrayContaining([mentionedId, replyMentionedId]));
	});

	it("binds cursors to the authorized actor and effective filters and rejects malformed queries", async () => {
		const { organization, project } = await fixture();
		await (env as Env).DB.batch(
			Array.from({ length: 4 }, (_, index) =>
				seedFeedbackStatement({
					id: `cursor-review-${index}`,
					projectId: project.id,
					organizationId: organization.id,
					ticketNumber: index + 1,
					pageUrl: "https://cursor.example/docs",
					createdOn: new Date(Date.parse("2026-07-01T00:00:00.000Z") + index).toISOString(),
				}),
			),
		);
		const first = await listProject(project.id, { state: "all", limit: "2" });
		expect(first.response.status).toBe(200);
		const cursor = (first.body as { nextCursor: string }).nextCursor;
		expect(cursor).toBeTruthy();
		const invalidQueries: Array<Record<string, string>> = [
			{ state: "open", limit: "2", cursor },
			{ state: "all", pageUrl: "https://cursor.example/elsewhere", limit: "2", cursor },
			{ state: "all", limit: "2", cursor: "not-a-valid-cursor" },
			{ state: "unknown", limit: "2" },
			{ state: "all", limit: "101" },
			{ state: "all", revisionId: "bad revision id", limit: "2" },
			{
				state: "all",
				pageUrl: "https://cursor.example/docs",
				pagePrefix: "https://cursor.example/docs",
				limit: "2",
			},
		];
		for (const query of invalidQueries) {
			const result = await listProject(project.id, query);
			expect(result.response.status).toBe(400);
			expect(String(result.body)).not.toMatch(/SQL|SELECT|review_feedback/i);
		}

		const otherActor = {
			"x-shiplet-user-id": "user_query_scope_member",
			"x-shiplet-user-email": "query-scope-member@example.com",
		};
		await (env as Env).DB.batch([
			(env as Env).DB.prepare(
				"UPDATE projects SET visibility = 'organization' WHERE id = ?",
			).bind(project.id),
			(env as Env).DB.prepare(
				`INSERT INTO users (id, email, created_on, updated_on)
				 VALUES (?, ?, ?, ?)`,
			).bind(
				otherActor["x-shiplet-user-id"],
				otherActor["x-shiplet-user-email"],
				new Date().toISOString(),
				new Date().toISOString(),
			),
			(env as Env).DB.prepare(
				`INSERT INTO organization_memberships
				 (id, organization_id, user_id, role, created_on)
				 VALUES (?, ?, ?, 'member', ?)`,
			).bind(
				`membership-${crypto.randomUUID()}`,
				organization.id,
				otherActor["x-shiplet-user-id"],
				new Date().toISOString(),
			),
		]);
		const transplanted = await listProject(
			project.id,
			{ state: "all", limit: "2", cursor },
			otherActor,
		);
		expect(transplanted.response.status).toBe(400);
		const otherProject = await fixture();
		const otherProjectCursor = await listProject(otherProject.project.id, {
			state: "all",
			limit: "2",
			cursor,
		});
		expect(otherProjectCursor.response.status).toBe(400);
		const anonymous = await listProject(
			project.id,
			{ state: "all", limit: "2" },
			{},
		);
		expect(anonymous.response.status).toBe(401);
	});

	it("keeps embedded reads on the session site and leaves the exact write binding intact", async () => {
		const { organization, project, revision, user } = await fixture({ external: true });
		const installationId = `embed_installation_${crypto.randomUUID()}`;
		const siteOrigin = "https://scope-site.example.com";
		await (env as Env).DB.prepare(
			`INSERT INTO embed_installations (
			 id, project_id, organization_id, site_origin, site_url, site_name,
			 secret_hash, created_by_user_id, created_on, last_used_on, revoked_on
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
		)
			.bind(
				installationId,
				project.id,
				organization.id,
				siteOrigin,
				`${siteOrigin}/`,
				"Scope site",
				crypto.randomUUID(),
				user.id,
				new Date().toISOString(),
			)
			.run();
		const installation = await (env as Env).DB.prepare(
			"SELECT * FROM embed_installations WHERE id = ?",
		)
			.bind(installationId)
			.first<any>();
		const pageUrl = `${siteOrigin}/docs/start`;
		const session = await createEmbedReviewSession((env as Env).DB, {
			installation,
			project,
			revisionId: revision.id,
			user,
			pageUrl,
		});
		const cookie = createEmbedReviewSessionCookieHeader({
			installationId,
			sessionHandle: session.sessionHandle,
			now: new Date(),
			expiresOn: session.expiresOn,
		}).split(";", 1)[0];
		await (env as Env).DB.batch(
			[
				["embed-exact", pageUrl],
				["embed-prefix", `${siteOrigin}/docs/child`],
				["embed-site", `${siteOrigin}/account`],
				["embed-foreign", "https://foreign.example/docs/start"],
			].map(([id, rowPageUrl], index) =>
				seedFeedbackStatement({
					id,
					projectId: project.id,
					organizationId: organization.id,
					ticketNumber: index + 1,
					pageUrl: rowPageUrl,
					createdOn: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index).toISOString(),
				}),
			),
		);
		const embedPath = (extra: Record<string, string> = {}) =>
			`/embed/review/feedback?${new URLSearchParams({
				installation_id: installationId,
				page_url: pageUrl,
				...extra,
			})}`;
		const getIds = async (extra: Record<string, string> = {}) => {
			const response = await request(embedPath(extra), { headers: { Cookie: cookie } });
			const body = (await response.json()) as { feedback?: Array<{ id: string }> };
			return { response, ids: body.feedback?.map((row) => row.id) || [] };
		};
		expect((await getIds()).ids).toEqual(["embed-exact"]);
		expect(
			(await getIds({ scope: "prefix", pagePrefix: `${siteOrigin}/docs`, state: "all" })).ids,
		).toEqual(expect.arrayContaining(["embed-exact", "embed-prefix"]));
		expect((await getIds({ scope: "site", state: "all" })).ids).toEqual(
			expect.arrayContaining(["embed-exact", "embed-prefix", "embed-site"]),
		);
		expect((await getIds({ scope: "site", state: "all" })).ids).not.toContain(
			"embed-foreign",
		);
		const crossOrigin = await request(
			embedPath({
				scope: "prefix",
				pagePrefix: "https://foreign.example/docs",
				state: "all",
			}),
			{ headers: { Cookie: cookie } },
		);
		expect(crossOrigin.status).toBe(400);

		const crossPageWrite = await request(embedPath(), {
			method: "POST",
			headers: {
				Cookie: cookie,
				Origin: "http://localhost",
				"Content-Type": "application/json",
				"x-shiplet-operation-receipt": "not-a-valid-receipt",
			},
			body: JSON.stringify({
				comment: "Cross-page write",
				pageUrl: `${siteOrigin}/docs/child`,
				clientFeedbackId: `cross-${crypto.randomUUID()}`,
			}),
		});
		expect(crossPageWrite.status).toBe(403);
	});

	it("keeps page-prefix identity case-sensitive across path and hash routes", async () => {
		const { organization, project } = await fixture();
		const pageRows: Array<[string, string]> = [
			["q1-doc-upper", "https://prefix.example/Docs/Guide"],
			["q1-doc-lower", "https://prefix.example/docs/start"],
			["q1-doc-sibling", "https://prefix.example/Docs2/start"],
			["q1-app", "https://prefix.example/app"],
			["q1-app-child", "https://prefix.example/app/child"],
		["q1-app-ordinary-hash", "https://prefix.example/app#section"],
		["q1-app-hash-docs", "https://prefix.example/app#/docs"],
		["q1-app-hash-docs-child", "https://prefix.example/app#/docs/child"],
		["q1-app-hash-upper", "https://prefix.example/app#/Docs"],
		["q1-app-hash-docs2", "https://prefix.example/app#/docs2"],
			["q1-app-hash-other", "https://prefix.example/app#/other"],
			["q1-app-hash-query", "https://prefix.example/app#/docs?plan=team"],
		["q1-app-slash-hash", "https://prefix.example/app/#/docs"],
		["q1-app-slash-hash-child", "https://prefix.example/app/#/docs/child"],
		["q1-app2-hash", "https://prefix.example/app2#/docs"],
		["q1-percent", "https://prefix.example/100%25/child"],
		["q1-underscore", "https://prefix.example/under_score/child"],
		["q1-root", "https://prefix.example/"],
			["q1-root-hash", "https://prefix.example/#/docs"],
			["q1-other", "https://prefix.example/other"],
		];
		await (env as Env).DB.batch(
			pageRows.map(([id, pageUrl], index) =>
				seedFeedbackStatement({
					id,
					projectId: project.id,
					organizationId: organization.id,
					ticketNumber: index + 1,
					pageUrl,
					createdOn: new Date(Date.parse("2026-09-01T00:00:00.000Z") + index).toISOString(),
				}),
			),
		);
		const readPrefix = async (pagePrefix: string) => {
			const result = await listProject(project.id, {
				pagePrefix,
				state: "all",
				limit: "100",
			});
			expect(result.response.status).toBe(200);
			return (result.body as { feedback: Array<{ id: string }> }).feedback.map(
				(row) => row.id,
			);
		};
		const docs = await readPrefix("https://prefix.example/Docs");
		expect(docs).toEqual(["q1-doc-upper"]);
		const app = await readPrefix("https://prefix.example/app");
		expect(app).toHaveLength(11);
		expect(app).toEqual(
			expect.arrayContaining([
				"q1-app",
				"q1-app-child",
				"q1-app-ordinary-hash",
				"q1-app-hash-docs",
				"q1-app-hash-docs-child",
				"q1-app-hash-upper",
				"q1-app-hash-docs2",
				"q1-app-hash-other",
				"q1-app-slash-hash",
				"q1-app-slash-hash-child",
			]),
		);
		expect(await readPrefix("https://prefix.example/app/")).toEqual(app);
		const docsRoute = await readPrefix("https://prefix.example/app#/docs?plan=team");
		expect(docsRoute).toHaveLength(3);
		expect(docsRoute).toEqual(
			expect.arrayContaining([
				"q1-app-hash-docs",
				"q1-app-hash-docs-child",
				"q1-app-hash-query",
			]),
		);
		expect(await readPrefix("https://prefix.example/app#/Docs")).toEqual([
			"q1-app-hash-upper",
		]);
		const slashDocsRoute = await readPrefix("https://prefix.example/app/#/docs");
		expect(slashDocsRoute).toEqual(
			expect.arrayContaining(["q1-app-slash-hash", "q1-app-slash-hash-child"]),
		);
		expect(slashDocsRoute).toHaveLength(2);
		expect(await readPrefix("https://prefix.example/app#section")).toEqual(app);
		const root = await readPrefix("https://prefix.example/");
		expect(root).toHaveLength(pageRows.length);
		expect(new Set(root)).toEqual(new Set(pageRows.map(([id]) => id)));
		const literalPercent = await readPrefix("https://prefix.example/100%25");
		expect(literalPercent).toEqual(["q1-percent"]);
		const literalUnderscore = await readPrefix("https://prefix.example/under_score");
		expect(literalUnderscore).toEqual(["q1-underscore"]);
		for (const pagePrefix of [
			"https://prefix.example/app%2Fdocs",
			"https://prefix.example/app#/docs%2Fchild",
			"https://prefix.example/app%5Cdocs",
			"https://prefix.example/app#/docs%5Cchild",
		]) {
			const rejected = await listProject(project.id, {
				pagePrefix,
				state: "all",
				limit: "10",
			});
			expect(rejected.response.status).toBe(400);
		}
	});

	it("continues a legacy 250-row page and hydrates dependent records in bounded batches", async () => {
		const { organization, project } = await fixture();
		const createdOn = "2026-09-01T00:00:00.000Z";
		const authorRows = Array.from({ length: 255 }, (_, index) => {
			const id = `q1-author-${String(index).padStart(3, "0")}`;
			return (env as Env).DB.prepare(
				`INSERT INTO users (id, email, avatar_preset, created_on, updated_on)
				 VALUES (?, ?, ?, ?, ?)`,
			).bind(
				id,
				`${id}@example.com`,
				index === 254 ? "q1-avatar" : "aurora-grid",
				createdOn,
				createdOn,
			);
		});
		await (env as Env).DB.batch(authorRows);
		await (env as Env).DB.batch(
			Array.from({ length: 255 }, (_, index) =>
				seedFeedbackStatement({
					id: `q1-legacy-${String(index).padStart(3, "0")}`,
					projectId: project.id,
					organizationId: organization.id,
					ticketNumber: index + 1,
					pageUrl: "https://legacy-page.example/docs",
					createdOn,
					submittedByUserId: `q1-author-${String(index).padStart(3, "0")}`,
				}),
			),
		);
		const firstFeedbackId = "q1-legacy-254";
		const replyId = "q1-legacy-reply";
		await (env as Env).DB.batch([
			(env as Env).DB.prepare(
				`INSERT INTO review_feedback_replies (
				 id, feedback_id, project_id, comment, author_user_id, author_email, created_on
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				replyId,
				firstFeedbackId,
				project.id,
				"Hydrated reply",
				"q1-author-254",
				"q1-author-254@example.com",
				createdOn,
			),
			(env as Env).DB.prepare(
				`INSERT INTO review_feedback_mentions (
				 id, project_id, organization_id, feedback_id, reply_id,
				 mentioned_user_id, mentioned_email, access_status, created_on
				) VALUES (?, ?, ?, ?, NULL, ?, ?, 'active', ?)`,
			).bind(
				"q1-legacy-feedback-mention",
				project.id,
				organization.id,
				firstFeedbackId,
				OWNER["x-shiplet-user-id"],
				OWNER["x-shiplet-user-email"],
				createdOn,
			),
			(env as Env).DB.prepare(
				`INSERT INTO review_feedback_mentions (
				 id, project_id, organization_id, feedback_id, reply_id,
				 mentioned_user_id, mentioned_email, access_status, created_on
				) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
			).bind(
				"q1-legacy-reply-mention",
				project.id,
				organization.id,
				firstFeedbackId,
				replyId,
				OWNER["x-shiplet-user-id"],
				OWNER["x-shiplet-user-email"],
				createdOn,
			),
		]);

		const first = await listProject(project.id, { limit: "250" });
		expect(first.response.status).toBe(200);
		const firstPayload = first.body as {
			feedback: Array<{
				id: string;
				submitted_by_user_id: string | null;
				submitted_by_avatar_preset: string | null;
				replies: Array<{ id: string; mentions: Array<{ id: string }> }>;
				mentions: Array<{ id: string }>;
			}>;
			nextCursor: string | null;
		};
		expect(firstPayload.feedback).toHaveLength(250);
		expect(firstPayload.nextCursor).toBeTruthy();
		expect(new Set(firstPayload.feedback.map((row) => row.id)).size).toBe(250);
		const hydrated = firstPayload.feedback.find((row) => row.id === firstFeedbackId);
		expect(hydrated).toMatchObject({
			submitted_by_user_id: "q1-author-254",
			submitted_by_avatar_preset: "q1-avatar",
		});
		expect(hydrated?.replies).toEqual([
			expect.objectContaining({
				id: replyId,
				mentions: [expect.objectContaining({ id: "q1-legacy-reply-mention" })],
			}),
		]);
		expect(hydrated?.mentions).toEqual([
			expect.objectContaining({ id: "q1-legacy-feedback-mention" }),
		]);

		const resized = await listProject(project.id, {
			limit: "100",
			cursor: firstPayload.nextCursor || "",
		});
		expect(resized.response.status).toBe(200);
		expect((resized.body as { feedback: unknown[] }).feedback).toHaveLength(5);

		await (env as Env).DB.batch([
			seedFeedbackStatement({
				id: "q1-legacy-inserted-after-page",
				projectId: project.id,
				organizationId: organization.id,
				ticketNumber: 1000,
				pageUrl: "https://legacy-page.example/docs",
				createdOn: "2027-01-01T00:00:00.000Z",
			}),
		]);
		const continuation = await listProject(project.id, {
			limit: "250",
			cursor: firstPayload.nextCursor || "",
		});
		expect(continuation.response.status).toBe(200);
		const remaining = (continuation.body as {
			feedback: Array<{ id: string }>;
			nextCursor: string | null;
		}).feedback.map((row) => row.id);
		expect(remaining).toHaveLength(5);
		expect(remaining).not.toContain("q1-legacy-inserted-after-page");
		expect(new Set(remaining).size).toBe(5);
		expect(
			new Set([...firstPayload.feedback.map((row) => row.id), ...remaining]).size,
		).toBe(255);
		const rejectedOversizeContinuation = await listProject(project.id, {
			limit: "251",
			cursor: firstPayload.nextCursor || "",
		});
		expect(rejectedOversizeContinuation.response.status).toBe(400);
	});

	it("hides internal database details when feedback hydration fails", async () => {
		const { organization, project } = await fixture();
		await (env as Env).DB.batch([
			seedFeedbackStatement({
				id: "q1-hydration-error",
				projectId: project.id,
				organizationId: organization.id,
				ticketNumber: 1,
				pageUrl: "https://error.example/docs",
				createdOn: "2026-09-01T00:00:00.000Z",
			}),
		]);
		const db = (env as Env).DB;
		await db
			.prepare("ALTER TABLE review_feedback_replies RENAME TO q1_review_feedback_replies")
			.run();
		try {
			const result = await listProject(project.id, { state: "all", limit: "10" });
			expect(result.response.status).toBe(500);
			expect(String(result.body)).toBe("Failed to list review feedback");
			expect(String(result.body)).not.toMatch(/D1|SQL|q1_review_feedback_replies/i);
		} finally {
			await db
				.prepare("ALTER TABLE q1_review_feedback_replies RENAME TO review_feedback_replies")
				.run();
		}
	});
});
