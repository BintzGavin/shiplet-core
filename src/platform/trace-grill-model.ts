// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Shared read model for the trace viewer variants: pairs tool calls with their
// results, splits the session into turns, folds subagents under the Task call
// that started them, and derives diffs and checks from tool inputs.
import type { TraceEvent, TraceManifest } from "../cli/trace-core.mjs";

export type Level = "full" | "conversation" | "summary" | "hidden";

export type DiffLine = { type: "ctx" | "add" | "del"; text: string };
export type FileDiff = { path: string; lines: DiffLine[]; added: number; removed: number; isNew: boolean };

export type ToolItem = {
	type: "tool";
	id: string;
	seq: number;
	t: string | null;
	agent: string;
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
	| { type: "prompt"; id: string; seq: number; t: string | null; agent: string; text: string }
	| { type: "reply"; id: string; seq: number; t: string | null; agent: string; text: string; final?: boolean }
	| { type: "reasoning"; id: string; seq: number; t: string | null; agent: string; text: string; hidden: boolean }
	| { type: "omitted"; id: string; seq: number; t: string | null; agent: string; text: string }
	| { type: "note"; id: string; seq: number; t: string | null; agent: string; text: string }
	| ToolItem;

export type Subagent = {
	id: string;
	title: string;
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
	toolCount: number;
	errors: number;
	hiddenCount: number;
	files: string[];
	start: string | null;
	end: string | null;
	checks: Array<{ command: string; ok: boolean | null }>;
};

export type Model = {
	items: Item[];
	turns: Turn[];
	subagents: Subagent[];
	files: Array<{ path: string; edits: ToolItem[]; added: number; removed: number; isNew: boolean; reads: number }>;
	checks: ToolItem[];
	startMs: number | null;
	endMs: number | null;
	hiddenCount: number;
	toolCount: number;
	errorCount: number;
};

const CHECK = /\b(test|vitest|jest|lint|eslint|typecheck|tsc|build|pytest|cargo test)\b/;

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

function diffFor(name: string, input: Record<string, unknown> | undefined, cwdLabel: string | null): FileDiff | undefined {
	if (!input) return undefined;
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
	if (name.startsWith("mcp__") && typeof input?.code === "string") {
		const call = /method:\s*'(\w+)'[\s\S]*?path:\s*[`'"]([^`'"]+)/.exec(input.code);
		if (call) return `${call[1]} ${call[2]}`;
	}
	if (name === "Grep" && input?.pattern) return `"${input.pattern}" in ${relPath(String(input.path || "."), cwdLabel) || "."}`;
	if (name === "WebFetch" && input?.url) return String(input.url).replace(/^https?:\/\//, "");
	return relPath(String(event.tool?.inputSummary || name), cwdLabel);
}

export function buildModel(events: TraceEvent[], manifest: TraceManifest & { cwdLabel?: string | null }): Model {
	const cwdLabel = manifest.cwdLabel || null;
	const results = new Map<string, TraceEvent>();
	for (const event of events) if (event.kind === "tool_result" && event.result) results.set(event.result.callId, event);
	const pending = new Map<string, ToolItem[]>();
	const all: Item[] = [];
	const agents = new Map<string, Subagent>();
	const seenSubPrompt = new Set<string>();
	for (const event of events) {
		const base = { id: event.id, seq: event.seq, t: event.t, agent: event.agent || "main" };
		switch (event.kind) {
			case "user_message":
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
				if (fam === "shell") {
					const command = String(input?.command || event.tool?.inputSummary || "");
					if (CHECK.test(command)) item.check = { command, ok: result ? !result.result?.isError : null };
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
					const queue = pending.get(base.agent) || [];
					const call = queue.shift();
					if (call) {
						call.resultHidden = true;
						if (call.check) call.check.ok = null;
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
				agents.set(base.agent, { id: base.agent, title: event.text || base.agent, kind: "Subagent", items: [], start: event.t, end: null, toolCount: 0, errors: 0 });
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
	// Fold subagent items under their subagent, and link each Task call to one.
	const main: Item[] = [];
	for (const item of all) {
		if (item.agent !== "main" && agents.has(item.agent)) {
			const sub = agents.get(item.agent)!;
			sub.items.push(item);
			if (item.type === "tool") {
				sub.toolCount++;
				if (item.error) sub.errors++;
			}
		} else main.push(item);
	}
	const subs = [...agents.values()];
	for (const sub of subs) {
		const last = [...sub.items].reverse().find((item) => item.type === "reply");
		sub.finalText = last?.text;
	}
	const unclaimed = [...subs];
	for (const item of main) {
		if (item.type !== "tool" || item.family !== "agent") continue;
		const prompt = String(item.input?.prompt || "");
		let index = prompt ? unclaimed.findIndex((sub) => prompt.startsWith(sub.title.slice(0, 60))) : -1;
		if (index < 0) index = 0;
		const sub = unclaimed.splice(index, 1)[0];
		if (sub) {
			item.sub = sub;
			sub.kind = String(item.input?.subagent_type || "Subagent");
			sub.title = item.label;
		}
	}
	// Turns.
	const turns: Turn[] = [];
	let current: Turn | null = null;
	const open = (prompt?: Extract<Item, { type: "prompt" }>) => {
		current = { index: turns.length, prompt, items: [], toolCount: 0, errors: 0, hiddenCount: 0, files: [], start: prompt?.t || null, end: null, checks: [] };
		turns.push(current);
	};
	for (const item of main) {
		if (item.type === "prompt") {
			open(item);
			continue;
		}
		if (!current) open();
		const turn = current!;
		turn.items.push(item);
		turn.end = item.t || turn.end;
		if (!turn.start) turn.start = item.t;
		if (item.type === "tool") {
			const nested = item.sub ? item.sub.items.filter((sub) => sub.type === "tool") : [];
			turn.toolCount += 1 + nested.length;
			if (item.error) turn.errors++;
			turn.errors += item.sub?.errors || 0;
			if (item.resultHidden) turn.hiddenCount++;
			turn.hiddenCount += nested.filter((sub) => sub.type === "tool" && sub.resultHidden).length;
			if (item.family === "edit" && item.path && !turn.files.includes(item.path)) turn.files.push(item.path);
			if (item.check) turn.checks.push(item.check);
		}
		if (item.type === "reasoning" && item.hidden) turn.hiddenCount++;
	}
	for (const turn of turns) {
		const replies = turn.items.filter((item) => item.type === "reply") as Array<Extract<Item, { type: "reply" }>>;
		const last = replies[replies.length - 1];
		if (last) {
			last.final = true;
			turn.reply = last;
		}
	}
	// Files.
	const fileMap = new Map<string, Model["files"][number]>();
	const touch = (path: string) => {
		if (!fileMap.has(path)) fileMap.set(path, { path, edits: [], added: 0, removed: 0, isNew: false, reads: 0 });
		return fileMap.get(path)!;
	};
	const everyTool = all.filter((item): item is ToolItem => item.type === "tool");
	for (const tool of everyTool) {
		if (tool.family === "edit" && tool.path) {
			const file = touch(tool.path);
			file.edits.push(tool);
			if (tool.diff) {
				file.added += tool.diff.added;
				file.removed += tool.diff.removed;
				if (tool.diff.isNew) file.isNew = true;
			}
		} else if (tool.family === "read" && tool.path) touch(tool.path).reads++;
	}
	const times = events.map((event) => event.t).filter(Boolean).map((t) => Date.parse(t!));
	return {
		items: main,
		turns,
		subagents: subs,
		files: [...fileMap.values()].sort((a, b) => b.edits.length - a.edits.length || a.path.localeCompare(b.path)),
		checks: everyTool.filter((tool) => tool.check),
		startMs: manifest.startedAt ? Date.parse(manifest.startedAt) : times.length ? Math.min(...times) : null,
		endMs: manifest.endedAt ? Date.parse(manifest.endedAt) : times.length ? Math.max(...times) : null,
		hiddenCount: all.filter((item) => (item.type === "tool" && item.resultHidden) || (item.type === "reasoning" && item.hidden)).length,
		toolCount: everyTool.length,
		errorCount: everyTool.filter((tool) => tool.error).length,
	};
}

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
