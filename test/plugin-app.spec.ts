import { describe, expect, it } from "vitest";

import { PLUGIN_APP_HTML } from "../src/generated-plugin-app";
import {
	PLUGIN_TOOL,
	PUBLISH_HTML_LIMITS,
	type PluginFeedbackDetail,
	type PluginFeedbackSummary,
	type PluginShiplet,
} from "../src/plugin-contract";
import {
	buildAskMessage,
	buildFeedbackModelContext,
	checkPublishSize,
	feedbackListArguments,
	filterFeedback,
	isValidId,
	pagePath,
	parseDeepLink,
	parseViewResult,
	parseWorkspaceList,
	prettifyFileName,
	relativeTime,
	searchShiplets,
	toolErrorMessage,
} from "../src/plugin-app/model";
import {
	createInitialState,
	reduce,
	type AppState,
} from "../src/plugin-app/state";

function shiplet(overrides: Partial<PluginShiplet> = {}): PluginShiplet {
	return {
		id: "shiplet_one",
		name: "Pricing page",
		reviewUrl: "https://review.example.test/s/shiplet_one",
		visibility: "organization",
		archived: false,
		openFeedbackCount: 2,
		updatedAt: "2026-09-30T12:00:00.000Z",
		...overrides,
	};
}

function summary(
	overrides: Partial<PluginFeedbackSummary> = {},
): PluginFeedbackSummary {
	return {
		id: "review_1",
		shipletId: "shiplet_one",
		title: "Hero copy is cut off",
		status: "New",
		authorName: "Ada",
		pageUrl: "https://review.example.test/s/shiplet_one/pricing?plan=pro",
		replyCount: 1,
		createdAt: "2026-09-30T11:00:00.000Z",
		url: "https://review.example.test/s/shiplet_one#feedback=review_1",
		...overrides,
	};
}

function detail(overrides: Partial<PluginFeedbackDetail> = {}): PluginFeedbackDetail {
	return {
		...summary(),
		comment: "The headline wraps under the nav on 1280px screens.",
		replies: [],
		...overrides,
	};
}

describe("plugin app deep links", () => {
	it("routes the inbox, a Shiplet and one feedback thread", () => {
		expect(parseDeepLink("/")).toEqual({ kind: "inbox" });
		expect(parseDeepLink("")).toEqual({ kind: "inbox" });
		expect(parseDeepLink("/shiplets/shiplet_one")).toEqual({
			kind: "feedback",
			shipletId: "shiplet_one",
		});
		expect(parseDeepLink("/shiplets/shiplet_one/")).toEqual({
			kind: "feedback",
			shipletId: "shiplet_one",
		});
		expect(
			parseDeepLink("/shiplets/shiplet_one/feedback/review_1?from=mail"),
		).toEqual({
			kind: "detail",
			shipletId: "shiplet_one",
			feedbackId: "review_1",
		});
	});

	it("rejects unknown routes and unsafe IDs", () => {
		expect(parseDeepLink("/settings")).toBeNull();
		expect(parseDeepLink("/shiplets")).toBeNull();
		expect(parseDeepLink("/shiplets/a/b")).toBeNull();
		expect(parseDeepLink("/shiplets/..%2Fadmin")).toBeNull();
		expect(parseDeepLink("/shiplets/%E0%A4%A")).toBeNull();
		expect(parseDeepLink("/shiplets/a%20b")).toBeNull();
		expect(parseDeepLink(`/shiplets/${"x".repeat(129)}`)).toBeNull();
		expect(parseDeepLink("https://evil.example/shiplets/one")).toBeNull();
		expect(parseDeepLink("//evil.example/shiplets/one")).toBeNull();
		expect(isValidId("review_1")).toBe(true);
		expect(isValidId("")).toBe(false);
		expect(isValidId("a/b")).toBe(false);
	});
});

describe("plugin app feedback filtering", () => {
	const items = [
		summary({ id: "a", status: "New" }),
		summary({ id: "b", status: "In Progress" }),
		summary({ id: "c", status: "Blocked" }),
		summary({ id: "d", status: "Done" }),
		summary({ id: "e", status: "Dropped" }),
		summary({ id: "f", status: "Staging" }),
	];

	it("keeps every unresolved status under Open, like the server", () => {
		expect(filterFeedback(items, "open").map((item) => item.id)).toEqual([
			"a",
			"b",
			"c",
			"f",
		]);
		expect(filterFeedback(items, "done").map((item) => item.id)).toEqual([
			"d",
		]);
		expect(filterFeedback(items, "all")).toHaveLength(6);
	});

	it("asks the server for the matching slice", () => {
		expect(feedbackListArguments("shiplet_one", "open")).toEqual({
			shiplet_id: "shiplet_one",
		});
		expect(feedbackListArguments("shiplet_one", "done")).toEqual({
			shiplet_id: "shiplet_one",
			status: "Done",
			include_closed: true,
		});
		expect(feedbackListArguments("shiplet_one", "all")).toEqual({
			shiplet_id: "shiplet_one",
			include_closed: true,
		});
	});
});

describe("plugin app inbox helpers", () => {
	it("searches Shiplets by name and ID, case-insensitively", () => {
		const list = [
			shiplet({ id: "shiplet_one", name: "Pricing page" }),
			shiplet({ id: "shiplet_two", name: "Onboarding flow" }),
		];
		expect(searchShiplets(list, "  PRICING ").map((s) => s.id)).toEqual([
			"shiplet_one",
		]);
		expect(searchShiplets(list, "two").map((s) => s.id)).toEqual([
			"shiplet_two",
		]);
		expect(searchShiplets(list, "")).toHaveLength(2);
	});

	it("formats relative update times without future drift", () => {
		const now = Date.parse("2026-09-30T12:00:00.000Z");
		expect(relativeTime("2026-09-30T11:59:40.000Z", now)).toBe("just now");
		expect(relativeTime("2026-09-30T11:55:00.000Z", now)).toBe("5m ago");
		expect(relativeTime("2026-09-30T09:00:00.000Z", now)).toBe("3h ago");
		expect(relativeTime("2026-09-28T12:00:00.000Z", now)).toBe("2d ago");
		expect(relativeTime("2026-09-30T12:05:00.000Z", now)).toBe("just now");
		expect(relativeTime("2026-06-01T12:00:00.000Z", now)).toMatch(/Jun/);
		expect(relativeTime(null, now)).toBe("");
		expect(relativeTime("not a date", now)).toBe("");
	});

	it("shows the page path of a feedback URL", () => {
		expect(pagePath("https://review.example.test/s/one/pricing?plan=pro")).toBe(
			"/s/one/pricing",
		);
		expect(pagePath(null)).toBe("");
		expect(pagePath("/relative/path")).toBe("/relative/path");
	});
});

describe("plugin app HTML file publishing", () => {
	it("prettifies a file name into a Shiplet name", () => {
		expect(prettifyFileName("landing-page_v2.html")).toBe("Landing page v2");
		expect(prettifyFileName("INDEX.HTM")).toBe("INDEX");
		expect(prettifyFileName("docs/site/pricing.table.html")).toBe(
			"Pricing table",
		);
		expect(prettifyFileName("  .html")).toBe("Untitled page");
		expect(prettifyFileName("a".repeat(200) + ".html")).toHaveLength(80);
	});

	it("enforces the publish byte limit in UTF-8 bytes", () => {
		expect(checkPublishSize("<p>hi</p>")).toEqual({ ok: true, bytes: 9 });
		const multibyte = "é".repeat(PUBLISH_HTML_LIMITS.maxTotalBytes / 2 + 1);
		const result = checkPublishSize(multibyte);
		expect(result.ok).toBe(false);
		expect(result.bytes).toBe(PUBLISH_HTML_LIMITS.maxTotalBytes + 2);
		if (!result.ok) {
			expect(result.message).toContain("2 MB");
		}
		expect(
			checkPublishSize("a".repeat(PUBLISH_HTML_LIMITS.maxTotalBytes)).ok,
		).toBe(true);
	});
});

describe("plugin app ChatGPT hand-off", () => {
	const ref = { id: "shiplet_one", name: "Pricing page", reviewUrl: "https://review.example.test/s/shiplet_one" };

	it("builds a short instruction plus a titled feedback context block", () => {
		const message = buildAskMessage(detail(), ref);
		expect(message.role).toBe("user");
		expect(message.content).toHaveLength(2);
		const [instruction, context] = message.content;
		expect(instruction.text.length).toBeLessThan(240);
		expect(instruction.text).toContain("Hero copy is cut off");
		expect(context._meta).toEqual({
			"openai/title": "Feedback: Hero copy is cut off",
		});
		for (const expected of [
			"Pricing page",
			"shiplet_one",
			"review_1",
			"Hero copy is cut off",
			"The headline wraps under the nav",
			"https://review.example.test/s/shiplet_one/pricing?plan=pro",
			"New",
		]) {
			expect(context.text).toContain(expected);
		}
	});

	it("works without a known Shiplet name and bounds long comments", () => {
		const message = buildAskMessage(
			detail({ comment: "x".repeat(20_000), pageUrl: null }),
			null,
		);
		expect(message.content[1].text).toContain("shiplet_one");
		expect(message.content[1].text.length).toBeLessThan(5_000);
	});

	it("summarizes the selected feedback for model context", () => {
		const context = buildFeedbackModelContext(detail(), ref);
		expect(context.structuredContent).toEqual({
			shipletId: "shiplet_one",
			feedbackId: "review_1",
		});
		expect(context.content[0]._meta).toEqual({
			"openai/title": "Feedback: Hero copy is cut off",
		});
		expect(context.content[0].text).toContain("review_1");
	});
});

describe("plugin app tool results", () => {
	it("accepts the documented structuredContent views", () => {
		expect(parseViewResult({ view: "inbox", shiplets: [shiplet()] })).toEqual({
			view: "inbox",
			shiplets: [shiplet()],
		});
		expect(
			parseViewResult({
				view: "feedback",
				shiplet: { id: "shiplet_one", name: "Pricing page", reviewUrl: "https://x.test" },
				feedback: [summary()],
			})?.view,
		).toBe("feedback");
		expect(
			parseViewResult({ view: "feedback-detail", feedback: detail() })?.view,
		).toBe("feedback-detail");
		expect(
			parseViewResult({ view: "published", shiplet: shiplet() })?.view,
		).toBe("published");
		expect(
			parseViewResult({ view: "html-file", fileName: "a.html" })?.view,
		).toBe("html-file");
	});

	it("drops malformed rows instead of rendering broken ones", () => {
		expect(parseViewResult(null)).toBeNull();
		expect(parseViewResult({ view: "unknown" })).toBeNull();
		expect(parseViewResult({ view: "inbox", shiplets: "nope" })).toBeNull();
		const parsed = parseViewResult({
			view: "inbox",
			shiplets: [shiplet(), { id: 4 }, null],
		});
		expect(parsed?.view === "inbox" && parsed.shiplets).toHaveLength(1);
		expect(
			parseViewResult({ view: "feedback-detail", feedback: { id: "x" } }),
		).toBeNull();
	});

	it("reads the workspace list and skips malformed entries", () => {
		expect(
			parseWorkspaceList({
				view: "workspaces",
				workspaces: [
					{ id: "org_a", name: "Acme" },
					{ id: "org_b", name: "  " },
					{ id: "", name: "Empty" },
					{ name: "No id" },
				],
			}),
		).toEqual([
			{ id: "org_a", name: "Acme" },
			{ id: "org_b", name: "org_b" },
		]);
		expect(parseWorkspaceList({ view: "inbox", shiplets: [] })).toBeNull();
		expect(parseWorkspaceList(undefined)).toBeNull();
	});

	it("turns tool errors into one calm sentence", () => {
		expect(
			toolErrorMessage({
				isError: true,
				content: [{ type: "text", text: "Shiplet not found." }],
			}),
		).toBe("Shiplet not found.");
		expect(toolErrorMessage(new Error("Request timed out"))).toBe(
			"Request timed out",
		);
		expect(toolErrorMessage(undefined)).toBe(
			"Shiplet could not complete that request.",
		);
		expect(
			toolErrorMessage({ isError: true, content: [{ type: "text", text: "x".repeat(900) }] }).length,
		).toBeLessThanOrEqual(240);
	});
});

describe("plugin app state", () => {
	function withDetail(): AppState {
		let state = createInitialState();
		state = reduce(state, {
			type: "initial-result",
			result: {
				view: "feedback",
				shiplet: { id: "shiplet_one", name: "Pricing page", reviewUrl: "https://x.test" },
				feedback: [summary()],
			},
		});
		state = reduce(state, {
			type: "navigate",
			route: { kind: "detail", shipletId: "shiplet_one", feedbackId: "review_1" },
		});
		state = reduce(state, { type: "detail-request", key: "shiplet_one/review_1", token: 1 });
		return reduce(state, {
			type: "detail-resolve",
			key: "shiplet_one/review_1",
			token: 1,
			data: { feedback: detail(), shiplet: null },
		});
	}

	it("applies status changes optimistically and reverts on failure", () => {
		let state = withDetail();
		state = reduce(state, {
			type: "status-start",
			feedbackId: "review_1",
			next: "Done",
		});
		expect(state.detail.data?.feedback.status).toBe("Done");
		expect(state.feedbackList.data?.feedback[0].status).toBe("Done");
		expect(state.statusMutation?.pending).toBe(true);

		state = reduce(state, {
			type: "status-fail",
			feedbackId: "review_1",
			message: "Not allowed.",
		});
		expect(state.detail.data?.feedback.status).toBe("New");
		expect(state.feedbackList.data?.feedback[0].status).toBe("New");
		expect(state.statusMutation).toMatchObject({
			pending: false,
			error: "Not allowed.",
			next: "Done",
		});
	});

	it("keeps the server's status when the update succeeds", () => {
		let state = withDetail();
		state = reduce(state, { type: "status-start", feedbackId: "review_1", next: "Blocked" });
		state = reduce(state, {
			type: "status-settle",
			feedbackId: "review_1",
			feedback: detail({ status: "Blocked", replyCount: 3 }),
		});
		expect(state.detail.data?.feedback.status).toBe("Blocked");
		expect(state.feedbackList.data?.feedback[0]).toMatchObject({
			status: "Blocked",
			replyCount: 3,
		});
		expect(state.statusMutation).toBeNull();
	});

	it("ignores responses that arrive after a newer request", () => {
		let state = createInitialState();
		state = reduce(state, { type: "feedback-request", key: "a|open", token: 1 });
		state = reduce(state, { type: "feedback-request", key: "b|open", token: 2 });
		state = reduce(state, {
			type: "feedback-resolve",
			key: "a|open",
			token: 1,
			data: {
				shiplet: { id: "a", name: "A", reviewUrl: "https://x.test" },
				feedback: [],
			},
		});
		expect(state.feedbackList.status).toBe("loading");
		expect(state.feedbackList.key).toBe("b|open");
	});

	it("clears the attached highlight when the host drops model context", () => {
		let state = withDetail();
		state = reduce(state, { type: "attached", feedbackId: "review_1" });
		expect(state.attachedFeedbackId).toBe("review_1");
		state = reduce(state, { type: "attached", feedbackId: null });
		expect(state.attachedFeedbackId).toBeNull();
	});

	it("adds a posted reply and bumps the reply count", () => {
		let state = withDetail();
		state = reduce(state, {
			type: "reply-added",
			feedbackId: "review_1",
			reply: { id: "r1", authorName: "You", comment: "On it", createdAt: null },
		});
		expect(state.detail.data?.feedback.replies).toHaveLength(1);
		expect(state.detail.data?.feedback.replyCount).toBe(2);
		expect(state.feedbackList.data?.feedback[0].replyCount).toBe(2);
	});
});

describe("generated plugin app document", () => {
	it("is one self-contained HTML document", () => {
		expect(PLUGIN_APP_HTML.startsWith("<!doctype html>")).toBe(true);
		expect(PLUGIN_APP_HTML).not.toMatch(/<script[^>]*\ssrc\s*=/i);
		expect(PLUGIN_APP_HTML).not.toMatch(/<link[^>]*\shref\s*=/i);
		expect(PLUGIN_APP_HTML).not.toMatch(
			/<(?:script|link|img|iframe)[^>]*\s(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i,
		);
		expect(PLUGIN_APP_HTML).not.toMatch(/@import\s+(?:url\()?["']?https?:/i);
		expect(PLUGIN_APP_HTML).toContain(PLUGIN_TOOL.listFeedback);
		expect(PLUGIN_APP_HTML.match(/<\/script/gi)).toHaveLength(1);
	});
});
