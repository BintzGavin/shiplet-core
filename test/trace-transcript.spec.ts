import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TraceEvent, TraceManifest } from "../src/cli/trace-core.mjs";
import { LEVEL_SEES, TraceTranscript } from "../src/platform/trace-transcript";
import { buildModel, stepsOf, toolsOf } from "../src/platform/trace-transcript-model";

// A small Claude Code style session: one prompt, a subagent, an edit, a failed
// then passing typecheck, a note between steps, and the final reply.
function session(): TraceEvent[] {
	let seq = 0;
	const at = (second: number) => new Date(Date.UTC(2026, 10, 2, 9, 0, second)).toISOString();
	const event = (second: number, fields: Partial<TraceEvent> & Pick<TraceEvent, "kind">): TraceEvent => ({ id: `e${++seq}`, seq, t: at(second), agent: "main", ...fields });
	const call = (second: number, callId: string, name: string, input: Record<string, unknown>, inputSummary: string, agent = "main") =>
		event(second, { kind: "tool_call", agent, tool: { name, callId, input, inputSummary } });
	const result = (second: number, callId: string, text: string, isError = false, agent = "main") => event(second, { kind: "tool_result", agent, result: { callId, isError, text } });
	return [
		event(0, { kind: "user_message", text: "Add a CSV export. Emily wants it for Friday.", attachmentIds: ["a".repeat(64)] }),
		call(2, "t1", "Task", { description: "Map the export path", prompt: "Map the export path in the dashboard", subagent_type: "Explore" }, "Map the export path"),
		event(3, { kind: "subagent_start", agent: "sub1", text: "Map the export path in the dashboard" }),
		event(3, { kind: "user_message", agent: "sub1", text: "Map the export path in the dashboard" }),
		call(4, "s1", "Grep", { pattern: "export", path: "src" }, "export", "sub1"),
		result(5, "s1", "src/dashboard.ts:12", false, "sub1"),
		event(6, { kind: "assistant_message", agent: "sub1", text: "The Export button lives in src/dashboard.ts." }),
		event(6, { kind: "subagent_end", agent: "sub1" }),
		result(7, "t1", "The Export button lives in src/dashboard.ts."),
		event(8, { kind: "assistant_message", text: "Wiring the Export button." }),
		call(10, "t2", "Edit", { file_path: "/work/q3/src/dashboard.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, "/work/q3/src/dashboard.ts"),
		result(12, "t2", "ok"),
		call(14, "t3", "Bash", { command: "npm run typecheck" }, "npm run typecheck"),
		result(40, "t3", "src/dashboard.ts(4,26): error TS2307", true),
		call(42, "t4", "Bash", { command: "npm run typecheck" }, "npm run typecheck"),
		result(60, "t4", "done"),
		event(62, { kind: "assistant_message", text: "Done. **Export** is wired and `npm run typecheck` passes." }),
		event(70, { kind: "user_message", text: "Thanks <script>alert(1)</script> <img src=x onerror=alert(2)>" }),
		event(71, { kind: "assistant_message", text: "You're welcome." }),
	];
}

function manifest(overrides: Partial<TraceManifest> = {}): TraceManifest {
	return {
		schemaVersion: "shiplet.trace/v1",
		title: "Add CSV export",
		source: { harness: "claude-code", harnessVersion: "9.8.7", importer: null },
		startedAt: "2026-11-02T09:00:00.000Z",
		endedAt: "2026-11-02T09:01:11.000Z",
		models: ["example-model-name-4"],
		cwdLabel: "q3",
		agents: [{ id: "sub1", title: "Map the export path" }],
		counts: { events: 19, toolCalls: 5, errors: 1, attachments: 1, skippedLines: 0, droppedAttachments: 0 },
		summary: {
			durationSeconds: 71,
			models: ["example-model-name-4"],
			promptCount: 2,
			toolCounts: {},
			filesTouched: ["src/dashboard.ts"],
			checks: [
				{ command: "npm run typecheck", ok: false },
				{ command: "npm run typecheck", ok: true },
			],
			outcome: "last-check-passed",
			errorCount: 1,
		},
		segments: [],
		attachments: [{ sha256: "a".repeat(64), mediaType: "image/png", bytes: 10, source: "inline", name: "mockup.png" }],
		masking: { coreVersion: "1", clientCount: 0, clientKinds: {}, serverCount: 0, serverKinds: {} },
		...overrides,
	};
}

// What the server sends a Conversation reader: tool output and reasoning are
// replaced by "omitted" events, in order.
function atConversation(events: TraceEvent[]): TraceEvent[] {
	return events.map((event) =>
		event.kind === "tool_result" ? { id: event.id, seq: event.seq, t: event.t, agent: event.agent, kind: "omitted", reason: "tool output hidden" } : event,
	);
}

function render(props: Partial<React.ComponentProps<typeof TraceTranscript>> = {}) {
	return renderToStaticMarkup(
		React.createElement(TraceTranscript, {
			manifest: manifest(),
			level: "full",
			events: session(),
			complete: true,
			actions: React.createElement("button", { type: "button" }, "Copy prompt for your agent"),
			attachmentUrl: (sha256: string) => `/files/${sha256}`,
			...props,
		}),
	);
}

describe("trace transcript model", () => {
	it("splits the session into one turn per prompt and keeps the last reply as the final one", () => {
		const model = buildModel(session(), manifest());
		expect(model.turns).toHaveLength(2);
		expect(model.turns[0].prompt?.text).toContain("CSV export");
		expect(model.turns[0].reply?.text).toMatch(/^Done\./);
		expect(model.turns[0].reply?.final).toBe(true);
		expect(model.turns[1].reply?.text).toBe("You're welcome.");
	});

	it("folds a subagent's steps under the Task call that started it", () => {
		const turn = buildModel(session(), manifest()).turns[0];
		const steps = stepsOf(turn);
		expect(steps.map((tool) => tool.name)).toEqual(["Task", "Edit", "Bash", "Bash"]);
		expect(steps[0].sub?.kind).toBe("Explore");
		expect(steps[0].sub?.items.map((item) => item.type)).toEqual(["tool", "reply"]);
		expect(toolsOf(turn.items).map((tool) => tool.name)).toContain("Grep");
	});

	it("derives a diff from an edit and a pass or fail from each check", () => {
		const steps = stepsOf(buildModel(session(), manifest()).turns[0]);
		const edit = steps.find((tool) => tool.name === "Edit")!;
		expect(edit.path).toBe("src/dashboard.ts");
		expect(edit.diff?.lines).toEqual([
			{ type: "del", text: "const a = 1;" },
			{ type: "add", text: "const a = 2;" },
		]);
		expect(steps.filter((tool) => tool.check).map((tool) => tool.check!.ok)).toEqual([false, true]);
	});

	it("keeps check results at Conversation from the manifest summary, without the output", () => {
		const steps = stepsOf(buildModel(atConversation(session()), manifest()).turns[0]);
		const checks = steps.filter((tool) => tool.check);
		expect(checks.map((tool) => tool.check!.ok)).toEqual([false, true]);
		expect(checks.every((tool) => tool.resultHidden && tool.resultText === undefined)).toBe(true);
	});

	it("names a subagent by its task when the level dropped its type", () => {
		const events = session().map((event) => (event.kind === "tool_call" ? { ...event, tool: { ...event.tool!, input: {} } } : event));
		const task = stepsOf(buildModel(atConversation(events), manifest()).turns[0])[0];
		expect(task.sub?.kind).toBe("");
		expect(task.label).toBe("Map the export path");
	});

	it("labels a code-mode call by its method and path at every level", () => {
		const events = session();
		const at = events.findIndex((event) => event.tool?.callId === "t3");
		const code = "async () => await codemode.request({ method: 'GET', path: '/api/projects/q3/review-feedback' })";
		events.splice(at, 0, { id: "mcp1", seq: 0.5, t: events[at].t, agent: "main", kind: "tool_call", tool: { name: "mcp__shiplet__execute", callId: "m1", input: { code }, inputSummary: code } });
		const full = stepsOf(buildModel(events, manifest()).turns[0]).find((tool) => tool.family === "mcp")!;
		const dropped = events.map((event) => (event.tool?.callId === "m1" ? { ...event, tool: { ...event.tool!, input: {} } } : event));
		const conversation = stepsOf(buildModel(atConversation(dropped), manifest()).turns[0]).find((tool) => tool.family === "mcp")!;
		expect(full.label).toBe("GET /api/projects/q3/review-feedback");
		expect(conversation.label).toBe("GET /api/projects/q3/review-feedback");
	});

	it("treats only the server's check commands as checks", () => {
		const events = session();
		const loop = events.find((event) => event.tool?.callId === "t4")!;
		loop.tool = { ...loop.tool!, input: { command: "for i in 1 2 3; do npx vitest run; done" }, inputSummary: "for i in 1 2 3; do npx vitest run; done" };
		const steps = stepsOf(buildModel(events, manifest()).turns[0]);
		expect(steps.filter((tool) => tool.check)).toHaveLength(1);
	});
});

describe("trace transcript view", () => {
	it("shows each prompt and the final reply, with the work behind tabs", () => {
		const html = render();
		expect(html).toContain("Add a CSV export. Emily wants it for Friday.");
		expect(html).toContain("<strong>Export</strong>");
		expect(html).toContain('role="tablist"');
		expect(html).toContain("Steps · 4");
		expect(html).toContain("Changes · 1");
		expect(html).toContain("Checks · 2");
		expect(html).toMatch(/aria-label="1 failed"/);
		// Intermediate notes and tool output stay behind the Steps tab.
		expect(html).not.toContain("Wiring the Export button.");
		expect(html).not.toContain("error TS2307");
	});

	it("renders a reply without tabs when the agent used no tools", () => {
		const html = render();
		const lastTurn = html.slice(html.indexOf("Thanks"));
		expect(lastTurn).toContain("You&#x27;re welcome.");
		expect(lastTurn).not.toContain('role="tablist"');
	});

	it("never shows model names or harness version numbers", () => {
		const html = render();
		expect(html).toContain("Claude Code session");
		expect(html).not.toContain("example-model-name-4");
		expect(html).not.toContain("9.8.7");
	});

	it("puts duration, prompts, files and the outcome on one meta line", () => {
		const html = render();
		expect(html).toMatch(/71s · 2 prompts · 1 file changed · <span class="tt-outcome tt-outcome-ok">Checks passed<\/span>/);
	});

	it("tells a reader below Full what their level leaves out, and says nothing at Full", () => {
		expect(render()).not.toContain("Shared as");
		const html = render({ level: "conversation", events: atConversation(session()) });
		expect(html).toContain("Shared as Conversation");
		expect(html).toContain('aria-label="What this level leaves out"');
		expect(html).toContain("Steps · 4");
		expect(html).toMatch(/aria-label="1 failed"/);
	});

	it("says that Conversation leaves out errors from steps that aren't checks", () => {
		expect(LEVEL_SEES.conversation.leaves).toContain("errors from steps that aren't checks");
		expect(LEVEL_SEES.conversation.keeps).toContain("which checks passed or failed");
	});

	it("shows only the summary at the Summary level", () => {
		const html = render({ level: "summary", events: [] });
		expect(html).toContain("summary only");
		expect(html).toContain("src/dashboard.ts");
		expect(html).not.toContain("Emily wants it for Friday");
		expect(html).not.toContain('role="tablist"');
	});

	it("offers sharing only to readers who manage the trace", () => {
		expect(render()).not.toContain(">Share<");
		expect(render({ share: React.createElement("p", null, "Who sees what") })).toMatch(/Share<\/button>/);
	});

	it("shows attachments inline and renders trace text as text, never as HTML", () => {
		const html = render();
		expect(html).toContain(`src="/files/${"a".repeat(64)}"`);
		expect(html).toContain('alt="mockup.png"');
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	it("lists attachments no event points at after the conversation", () => {
		const extra = { sha256: "b".repeat(64), mediaType: "application/pdf", bytes: 10, source: "file", name: "report.pdf" };
		const base = manifest();
		const html = render({ manifest: manifest({ attachments: [...base.attachments, extra] }) });
		expect(html).toContain("Files from this session");
		expect(html).toContain("report.pdf");
		expect(render()).not.toContain("Files from this session");
	});

	it("uses a second-level heading when embedded in a Shiplet page", () => {
		expect(render()).toContain('<h1 class="tt-title">Add CSV export</h1>');
		expect(render({ embedded: true })).toContain('<h2 class="tt-title">Add CSV export</h2>');
	});
});
