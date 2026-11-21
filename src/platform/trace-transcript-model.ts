// Read model for the trace viewer (docs/traces-spec.md D15): pairs tool calls
// with their results, folds each subagent under the call that started it,
// splits the session into turns (a prompt, the work, the final reply), and
// derives diffs from edit inputs and check results from shell commands.
import { isCheckCommand, type TraceEvent, type TraceManifest } from "../cli/trace-core.mjs";

export type Level = "full" | "conversation" | "summary" | "hidden";

export type DiffLine = { type: "ctx" | "add" | "del"; text: string };
export type FileDiff = { path: string; lines: DiffLine[]; added: number; removed: number; isNew: boolean };

type Base = { id: string; seq: number; t: string | null; agent: string; attachmentIds: string[] };

export type ToolItem = Base & {
	type: "tool";
	name: string;
	display: string;
	family: "read" | "search" | "edit" | "shell" | "agent" | "plan" | "web" | "mcp" | "other";
	label: string;
	input?: Record<string, unknown>;
	resultText?: string;
	resultHidden: boolean;
	error: boolean;
	diff?: FileDiff;
	check?: { command: string; ok: boolean | null };
	sub?: Subagent;
	path?: string;
};
export type Item =
	| (Base & { type: "prompt"; text: string })
	| (Base & { type: "reply"; text: string; final?: boolean })
	| (Base & { type: "reasoning"; text: string; hidden: boolean })
	| (Base & { type: "omitted"; text: string })
	| (Base & { type: "note"; text: string })
	| ToolItem;

export type Subagent = {
	id: string;
	title: string;
	// The agent type ("Explore"), or "" when the reader's level dropped it.
	kind: string;
	items: Item[];
	start: string | null;
	end: string | null;
	toolCount: number;
	errors: number;
	finalText?: string;
};

export type Turn = {
	index: number;
	prompt?: Extract<Item, { type: "prompt" }>;
	items: Item[];
	reply?: Extract<Item, { type: "reply" }>;
	start: string | null;
	end: string | null;
};

export type Model = {
	turns: Turn[];
	subagents: Subagent[];
	startMs: number | null;
	endMs: number | null;
};

export function relPath(value: string, cwdLabel: string | null | undefined) {
	if (!value) return value;
	if (cwdLabel) {
		const marker = `/${cwdLabel}/`;
		const at = value.indexOf(marker);
		if (at >= 0) return value.slice(at + marker.length);
	}
	return value.replace(/^\/Users\/[^/]+\//, "~/");
}

export function toolDisplay(name: string) {
	const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
	if (mcp) return `${mcp[1]} · ${mcp[2]}`;
	return name;
}

function family(name: string): ToolItem["family"] {
	if (/^(Read|read_file|NotebookRead|view)$/i.test(name)) return "read";
	if (/^(Grep|Glob|grep|glob|search|LS|list)$/i.test(name)) return "search";
	if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|write_file|edit_file)$/i.test(name)) return "edit";
	if (/^(Bash|shell|exec_command|local_shell)$/i.test(name)) return "shell";
	if (/^(Task|Agent|spawn_agent)$/i.test(name)) return "agent";
	if (/^(TodoWrite|update_plan)$/i.test(name)) return "plan";
	if (/^(WebFetch|WebSearch|web_search)$/i.test(name)) return "web";
	if (name.startsWith("mcp__")) return "mcp";
	return "other";
}

function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length * b.length > 90_000) return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
	const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push({ type: "ctx", text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: a[i++] });
		else out.push({ type: "add", text: b[j++] });
	}
	while (i < a.length) out.push({ type: "del", text: a[i++] });
	while (j < b.length) out.push({ type: "add", text: b[j++] });
	return out;
}

// The model is rebuilt each time a page of the session arrives; an edit's input
// object is kept across rebuilds, so its line diff is computed once.
const diffCache = new WeakMap<object, FileDiff | undefined>();

function diffFor(name: string, input: Record<string, unknown> | undefined, cwdLabel: string | null): FileDiff | undefined {
	if (!input) return undefined;
	if (diffCache.has(input)) return diffCache.get(input);
	const diff = computeDiff(name, input, cwdLabel);
	diffCache.set(input, diff);
	return diff;
}

function computeDiff(name: string, input: Record<string, unknown>, cwdLabel: string | null): FileDiff | undefined {
	const path = typeof input.file_path === "string" ? relPath(input.file_path, cwdLabel) : typeof input.path === "string" ? relPath(input.path, cwdLabel) : null;
	if (!path) return undefined;
	let lines: DiffLine[] = [];
	let isNew = false;
	if (name === "Write" && typeof input.content === "string") {
		lines = input.content.replace(/\n$/, "").split("\n").map((text) => ({ type: "add" as const, text }));
		isNew = true;
	} else if (typeof input.old_string === "string" && typeof input.new_string === "string") {
		lines = lineDiff(input.old_string, input.new_string);
	} else if (Array.isArray(input.edits)) {
		for (const edit of input.edits as Array<{ old_string?: string; new_string?: string }>) {
			if (typeof edit.old_string === "string" && typeof edit.new_string === "string") lines.push(...lineDiff(edit.old_string, edit.new_string));
		}
	} else return undefined;
	return { path, lines, added: lines.filter((line) => line.type === "add").length, removed: lines.filter((line) => line.type === "del").length, isNew };
}

function labelFor(event: TraceEvent, cwdLabel: string | null) {
	const input = event.tool?.input as Record<string, unknown> | undefined;
	const name = event.tool?.name || "tool";
	if (name === "Task" || name === "Agent") return String(input?.description || event.tool?.inputSummary || "Subagent");
	if (name === "TodoWrite" && Array.isArray(input?.todos)) {
		const todos = input!.todos as Array<{ status: string; content: string }>;
		const active = todos.find((todo) => todo.status === "in_progress");
		return `Plan: ${todos.filter((todo) => todo.status === "completed").length} of ${todos.length} done${active ? ` · now: ${active.content}` : ""}`;
	}
	if (name === "TodoWrite") return "Updated the plan";
	// Code-mode calls read as "GET /path". Below Full only the input summary is
	// kept, and it carries the same code.
	const code = typeof input?.code === "string" ? input.code : name.startsWith("mcp__") ? event.tool?.inputSummary : undefined;
	if (name.startsWith("mcp__") && code) {
		const call = /method:\s*'(\w+)'[\s\S]*?path:\s*[`'"]([^`'"]+)/.exec(code);
		if (call) return `${call[1]} ${call[2]}`;
	}
	if (name === "Grep" && input?.pattern) return `"${input.pattern}" in ${relPath(String(input.path || "."), cwdLabel) || "."}`;
	if (name === "WebFetch" && input?.url) return String(input.url).replace(/^https?:\/\//, "");
	return relPath(String(event.tool?.inputSummary || name), cwdLabel);
}

export function buildModel(events: TraceEvent[], manifest: Pick<TraceManifest, "cwdLabel" | "startedAt" | "endedAt" | "summary">): Model {
	const cwdLabel = manifest.cwdLabel || null;
	const results = new Map<string, TraceEvent>();
	for (const event of events) if (event.kind === "tool_result" && event.result) results.set(event.result.callId, event);
	// Calls whose result has not been seen yet, per agent: a level below Full
	// replaces each result with an "omitted" event in the same order.
	const pending = new Map<string, ToolItem[]>();
	const all: Item[] = [];
	const agents = new Map<string, Subagent>();
	const seenSubPrompt = new Set<string>();
	for (const event of events) {
		const base: Base = { id: event.id, seq: event.seq, t: event.t, agent: event.agent || "main", attachmentIds: event.attachmentIds || [] };
		switch (event.kind) {
			case "user_message":
				// A subagent's first message is the prompt its Task call already shows.
				if (base.agent !== "main" && !seenSubPrompt.has(base.agent)) {
					seenSubPrompt.add(base.agent);
					break;
				}
				all.push({ ...base, type: "prompt", text: event.text || "" });
				break;
			case "assistant_message":
				all.push({ ...base, type: "reply", text: event.text || "" });
				break;
			case "reasoning":
				all.push({ ...base, type: "reasoning", text: event.text || "", hidden: false });
				break;
			case "tool_call": {
				const name = event.tool?.name || "tool";
				const input = event.tool?.input as Record<string, unknown> | undefined;
				const result = results.get(event.tool?.callId || "");
				const fam = family(name);
				const item: ToolItem = {
					...base,
					attachmentIds: [...base.attachmentIds, ...(result?.attachmentIds || [])],
					type: "tool",
					name,
					display: toolDisplay(name),
					family: fam,
					label: labelFor(event, cwdLabel),
					input,
					resultText: result?.result?.text,
					resultHidden: false,
					error: Boolean(result?.result?.isError),
					diff: fam === "edit" ? diffFor(name, input, cwdLabel) : undefined,
					path:
						typeof input?.file_path === "string"
							? relPath(input.file_path, cwdLabel)
							: fam === "edit" || fam === "read"
								? relPath(String(event.tool?.inputSummary || ""), cwdLabel)
								: undefined,
				};
				// The server's rule, so every level agrees on what counts as a check.
				if (fam === "shell" && isCheckCommand(String(event.tool?.inputSummary || input?.command || ""))) {
					item.check = { command: String(input?.command || event.tool?.inputSummary || ""), ok: result ? !result.result?.isError : null };
				}
				if (!result) pending.set(base.agent, [...(pending.get(base.agent) || []), item]);
				all.push(item);
				break;
			}
			case "tool_result":
				break;
			case "omitted": {
				const reason = event.reason || "";
				if (/tool output hidden/.test(reason)) {
					const call = (pending.get(base.agent) || []).shift();
					if (call) {
						call.resultHidden = true;
						call.attachmentIds.push(...base.attachmentIds);
						break;
					}
				}
				if (/reasoning hidden/.test(reason)) {
					all.push({ ...base, type: "reasoning", text: "", hidden: true });
					break;
				}
				all.push({ ...base, type: "omitted", text: reason });
				break;
			}
			case "subagent_start":
				agents.set(base.agent, { id: base.agent, title: event.text || base.agent, kind: "", items: [], start: event.t, end: null, toolCount: 0, errors: 0 });
				break;
			case "subagent_end": {
				const sub = agents.get(base.agent);
				if (sub) sub.end = event.t;
				break;
			}
			default:
				all.push({ ...base, type: "note", text: event.text || "" });
		}
	}
	// Every level keeps the session's check results in the manifest summary
	// (command and passed/failed) even when tool output is dropped. Match them to
	// the check steps in order, so a Conversation reader sees which checks passed.
	const summaryChecks = manifest.summary?.checks || [];
	let cursor = 0;
	for (const item of all) {
		if (item.type !== "tool" || !item.check) continue;
		const head = item.check.command.split("\n")[0].slice(0, 120);
		const at = summaryChecks.findIndex((check, index) => index >= cursor && check.command.split("\n")[0].slice(0, 120) === head);
		if (at < 0) continue;
		cursor = at + 1;
		if (item.check.ok === null) item.check.ok = summaryChecks[at].ok;
	}
	// Fold subagent items under their subagent, then link each Task call to one.
	const main: Item[] = [];
	for (const item of all) {
		const sub = item.agent !== "main" ? agents.get(item.agent) : undefined;
		if (!sub) {
			main.push(item);
			continue;
		}
		sub.items.push(item);
		if (item.type === "tool") {
			sub.toolCount++;
			if (item.error || item.check?.ok === false) sub.errors++;
		}
	}
	const subs = [...agents.values()];
	for (const sub of subs) sub.finalText = [...sub.items].reverse().find((item) => item.type === "reply")?.text;
	const unclaimed = [...subs];
	for (const item of main) {
		if (item.type !== "tool" || item.family !== "agent") continue;
		const prompt = String(item.input?.prompt || "");
		let index = prompt ? unclaimed.findIndex((sub) => prompt.startsWith(sub.title.slice(0, 60))) : -1;
		if (index < 0) index = 0;
		const sub = unclaimed.splice(index, 1)[0];
		if (sub) {
			item.sub = sub;
			// The agent type lives in the call's input, which levels below Full drop.
			sub.kind = typeof item.input?.subagent_type === "string" ? item.input.subagent_type : "";
			sub.title = item.label;
		}
	}
	// Turns: each main prompt opens one; its last reply is the final reply.
	const turns: Turn[] = [];
	let current: Turn | null = null;
	for (const item of main) {
		if (item.type === "prompt") {
			current = { index: turns.length, prompt: item, items: [], start: item.t, end: item.t };
			turns.push(current);
			continue;
		}
		if (!current) {
			current = { index: turns.length, items: [], start: item.t, end: item.t };
			turns.push(current);
		}
		current.items.push(item);
		current.end = item.t || current.end;
		current.start ||= item.t;
	}
	for (const turn of turns) {
		const last = [...turn.items].reverse().find((item): item is Extract<Item, { type: "reply" }> => item.type === "reply");
		if (last) {
			last.final = true;
			turn.reply = last;
		}
	}
	const times = events.map((event) => event.t).filter((t): t is string => Boolean(t)).map((t) => Date.parse(t));
	return {
		turns,
		subagents: subs,
		startMs: manifest.startedAt ? Date.parse(manifest.startedAt) : times.length ? Math.min(...times) : null,
		endMs: manifest.endedAt ? Date.parse(manifest.endedAt) : times.length ? Math.max(...times) : null,
	};
}

// Every tool step of a turn, subagent steps included.
export function toolsOf(items: Item[]): ToolItem[] {
	const out: ToolItem[] = [];
	for (const item of items) {
		if (item.type !== "tool") continue;
		out.push(item);
		if (item.sub) out.push(...toolsOf(item.sub.items));
	}
	return out;
}

export const workOf = (turn: Turn) => turn.items.filter((item) => item !== turn.reply);
// The steps shown on a turn's bar and counted on its Steps tab: a subagent is one step.
export const stepsOf = (turn: Turn) => workOf(turn).filter((item): item is ToolItem => item.type === "tool");
export const failedOf = (tool: ToolItem) => tool.error || tool.check?.ok === false;

export function offset(t: string | null, startMs: number | null) {
	if (!t || startMs === null) return "";
	const seconds = Math.max(0, Math.round((Date.parse(t) - startMs) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function span(start: string | null, end: string | null) {
	if (!start || !end) return "";
	const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
