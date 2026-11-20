/// <reference lib="dom" />
// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Five live directions for the trace viewer, switched with edge arrows (or
// Left/Right inside the viewer) and deep-linked with ?variant=<id>. Shown only
// on localhost; see docs/design/trace-viewer-grill.md for the cleanup list.
import * as React from "react";
import { createPortal } from "react-dom";

import { harnessLabel, type TraceEvent, type TraceManifest } from "../cli/trace-core.mjs";
import { buildModel, offset, span, type Item, type Level, type Model, type Subagent, type ToolItem, type Turn } from "./trace-grill-model";
import { DiffStat, DiffView, FAMILY_GLYPH, LEVEL_NAME, Md, ToolBody, itemText, words } from "./trace-grill-parts";
import { ChatElements, ChatSteps } from "./trace-grill-chat";
import { ROUND2 } from "./trace-grill-r2";
import { CHAT_CSS, GRILL_CSS, R2_CSS } from "./trace-grill-styles";

export function grillEnabled() {
	return typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) && new URLSearchParams(window.location.search).get("grill") !== "off";
}

type Detail = {
	trace: { id: string; title: string; harness: string; sharing: "private" | "shared" };
	manifest: TraceManifest & { level?: Level; cwdLabel?: string | null };
	access: { level: Level; via: string; canManage: boolean };
};

export type Shared = {
	model: Model;
	manifest: Detail["manifest"];
	detail: Detail;
	level: Level;
	actions: React.ReactNode;
	share: React.ReactNode;
	sessionLabel: string;
	duration: string;
	outcome: { text: string; tone: "ok" | "err" | "none" };
};

// ---------------------------------------------------------------------------
// Common bits

function Outcome({ outcome }: { outcome: Shared["outcome"] }) {
	return <span className={`status-badge tg-outcome tg-outcome-${outcome.tone}`}>{outcome.text}</span>;
}

function LevelBadge({ level }: { level: Level }) {
	return <span className={`status-badge trace-level trace-level-${level}`}>{LEVEL_NAME[level]}</span>;
}

function useFlash() {
	return React.useCallback((id: string) => {
		const node = document.getElementById(`tg-ev-${id}`);
		if (!node) return;
		node.scrollIntoView({ behavior: "smooth", block: "center" });
		node.classList.remove("tg-flash");
		void node.offsetWidth;
		node.classList.add("tg-flash");
	}, []);
}

function hiddenSummary(level: Level, model: Model) {
	if (level === "full") return null;
	if (level === "summary") return "You can see the summary of this session: what was done, files touched, checks and the outcome. The conversation itself is not shared at your level.";
	return `You're reading the Conversation version: prompts, replies and every tool step, without tool output or reasoning (${model.hiddenCount} items hidden).`;
}

type Filter = "all" | "talk" | "tools" | "errors" | "edits";
const FILTERS: Array<{ id: Filter; label: string }> = [
	{ id: "all", label: "All" },
	{ id: "talk", label: "Messages" },
	{ id: "tools", label: "Tools" },
	{ id: "errors", label: "Errors" },
	{ id: "edits", label: "Edits" },
];
function matches(item: Item, filter: Filter, query: string) {
	if (query && !itemText(item).toLowerCase().includes(query.toLowerCase())) return false;
	if (filter === "all") return true;
	if (filter === "talk") return item.type === "prompt" || item.type === "reply";
	if (filter === "tools") return item.type === "tool";
	if (filter === "errors") return item.type === "tool" && (item.error || Boolean(item.sub?.errors));
	if (filter === "edits") return item.type === "tool" && item.family === "edit";
	return true;
}

function FilterBar({ filter, setFilter, query, setQuery, counts }: { filter: Filter; setFilter: (f: Filter) => void; query: string; setQuery: (q: string) => void; counts: Partial<Record<Filter, number>> }) {
	return (
		<div className="tg-filterbar">
			<div className="tg-chips" role="radiogroup" aria-label="Show">
				{FILTERS.map((option) => (
					<button key={option.id} type="button" role="radio" aria-checked={filter === option.id} className={`tg-chip${filter === option.id ? " is-on" : ""}`} onClick={() => setFilter(option.id)}>
						{option.label}
						{counts[option.id] !== undefined ? <span className="tg-chip-count">{counts[option.id]}</span> : null}
					</button>
				))}
			</div>
			<input className="tg-search" type="search" placeholder="Search the session" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search the session" />
		</div>
	);
}

function filterCounts(items: Item[]) {
	const tools = items.filter((item): item is ToolItem => item.type === "tool");
	return {
		talk: items.filter((item) => item.type === "prompt" || item.type === "reply").length,
		tools: tools.length,
		errors: tools.filter((tool) => tool.error || tool.sub?.errors).length,
		edits: tools.filter((tool) => tool.family === "edit").length,
	};
}

function SummaryOnly({ shared }: { shared: Shared }) {
	const { manifest } = shared;
	return (
		<div className="tg-summary-only">
			<p>{hiddenSummary("summary", shared.model)}</p>
			<dl className="tg-facts">
				<dt>Prompts</dt>
				<dd>{manifest.summary?.promptCount ?? 0}</dd>
				<dt>Tool calls</dt>
				<dd>{manifest.counts.toolCalls}</dd>
				<dt>Errors</dt>
				<dd>{manifest.counts.errors}</dd>
			</dl>
			<ChecksList shared={shared} />
			<FilesList shared={shared} />
		</div>
	);
}

function ChecksList({ shared, limit = 12 }: { shared: Shared; limit?: number }) {
	const checks = shared.model.checks.length ? shared.model.checks.map((tool) => ({ command: tool.check!.command, ok: tool.check!.ok, id: tool.id })) : (shared.manifest.summary?.checks || []).map((check, index) => ({ ...check, id: String(index) }));
	if (!checks.length) return null;
	return (
		<div className="tg-checks">
			<h3>Checks</h3>
			<ol>
				{checks.slice(-limit).map((check, index) => (
					<li key={`${check.id}-${index}`}>
						<span className={`tg-dot tg-dot-${check.ok === null ? "unknown" : check.ok ? "ok" : "err"}`} aria-label={check.ok === null ? "result hidden" : check.ok ? "passed" : "failed"} />
						<code title={check.command}>{check.command}</code>
					</li>
				))}
			</ol>
		</div>
	);
}

function FilesList({ shared }: { shared: Shared }) {
	const edited = shared.model.files.filter((file) => file.edits.length);
	const list = edited.length ? edited : (shared.manifest.summary?.filesTouched || []).map((path) => ({ path, added: 0, removed: 0, edits: [], isNew: false }));
	if (!list.length) return null;
	return (
		<div className="tg-files">
			<h3>Files changed</h3>
			<ul>
				{list.map((file) => (
					<li key={file.path}>
						<code>{file.path}</code>
						{file.isNew ? <span className="tg-new">new</span> : null}
						<DiffStat added={file.added} removed={file.removed} />
					</li>
				))}
			</ul>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 1. Ship's log: one line per event, prompts break the rhythm.

function LogRow({ item, shared, depth = 0 }: { item: Item; shared: Shared; depth?: number }) {
	const [open, setOpen] = React.useState(false);
	const time = offset(item.t, shared.model.startMs);
	if (item.type === "prompt") {
		return (
			<li id={`tg-ev-${item.id}`} className="tg-log-prompt">
				<span className="tg-log-time">{time}</span>
				<div>
					<span className="tg-eyebrow">Prompt</span>
					<Md text={item.text} />
				</div>
			</li>
		);
	}
	if (item.type === "reply") {
		return (
			<li id={`tg-ev-${item.id}`} className={`tg-log-row tg-log-reply${item.final ? " is-final" : ""}`} style={{ ["--depth" as string]: depth }}>
				<span className="tg-log-time">{time}</span>
				<span className="tg-log-glyph tg-g-agent" aria-hidden="true">›</span>
				<span className="tg-log-name">Agent</span>
				<div className={`tg-log-text${item.final || open ? "" : " is-clamped"}`} onClick={() => setOpen(!open)}>
					{item.final ? <Md text={item.text} /> : item.text}
				</div>
				<span />
			</li>
		);
	}
	if (item.type === "reasoning") {
		return (
			<li id={`tg-ev-${item.id}`} className="tg-log-row tg-log-muted" style={{ ["--depth" as string]: depth }}>
				<span className="tg-log-time">{time}</span>
				<span className="tg-log-glyph" aria-hidden="true">~</span>
				<span className="tg-log-name">Thinking</span>
				{item.hidden ? (
					<span className="tg-log-text tg-striped">hidden at {LEVEL_NAME[shared.level]}</span>
				) : (
					<button type="button" className={`tg-log-text tg-linklike${open ? "" : " is-clamped"}`} onClick={() => setOpen(!open)}>
						{open ? item.text : `${words(item.text)} words · ${item.text}`}
					</button>
				)}
				<span />
			</li>
		);
	}
	if (item.type !== "tool") {
		return (
			<li id={`tg-ev-${item.id}`} className="tg-log-row tg-log-muted" style={{ ["--depth" as string]: depth }}>
				<span className="tg-log-time">{time}</span>
				<span className="tg-log-glyph">·</span>
				<span className="tg-log-name">Note</span>
				<span className="tg-log-text">{item.text}</span>
				<span />
			</li>
		);
	}
	const tool = item;
	const status = tool.error ? (
		<span className="tg-st tg-st-err">error</span>
	) : tool.diff ? (
		<DiffStat added={tool.diff.added} removed={tool.diff.removed} />
	) : tool.check ? (
		<span className={`tg-st ${tool.check.ok === null ? "" : "tg-st-ok"}`}>{tool.check.ok === null ? "result hidden" : "passed"}</span>
	) : tool.resultHidden ? (
		<span className="tg-st tg-striped">output hidden</span>
	) : tool.sub ? (
		<span className="tg-st">{tool.sub.toolCount} calls</span>
	) : null;
	return (
		<>
			<li id={`tg-ev-${tool.id}`} className={`tg-log-row tg-log-tool${tool.error ? " is-error" : ""}${open ? " is-open" : ""}`} style={{ ["--depth" as string]: depth }}>
				<span className="tg-log-time">{time}</span>
				<span className={`tg-log-glyph tg-g-${tool.family}`} aria-hidden="true">
					{FAMILY_GLYPH[tool.family]}
				</span>
				<button type="button" className="tg-log-name tg-linklike" aria-expanded={open} onClick={() => setOpen(!open)}>
					{tool.display}
				</button>
				<button type="button" className="tg-log-text tg-log-label tg-linklike" onClick={() => setOpen(!open)}>
					{tool.label}
				</button>
				{status}
			</li>
			{open ? (
				<li className="tg-log-detail" style={{ ["--depth" as string]: depth }}>
					<ToolBody tool={tool} level={shared.level} showInput={!tool.sub} />
				</li>
			) : null}
			{tool.sub && (open || depth === 0) ? (
				<li className="tg-log-sub" style={{ ["--depth" as string]: depth + 1 }}>
					<details open={open}>
						<summary>
							{tool.sub.kind} · {tool.sub.title} · {tool.sub.toolCount} calls · {span(tool.sub.start, tool.sub.end)}
						</summary>
						<ol className="tg-log">
							{tool.sub.items.map((sub) => (
								<LogRow key={sub.id} item={sub} shared={shared} depth={depth + 1} />
							))}
						</ol>
					</details>
				</li>
			) : null}
		</>
	);
}

function ShipsLog({ shared }: { shared: Shared }) {
	const { model, manifest, level } = shared;
	const [filter, setFilter] = React.useState<Filter>("all");
	const [query, setQuery] = React.useState("");
	const [shareOpen, setShareOpen] = React.useState(false);
	const visible = model.items.filter((item) => item.type === "prompt" || matches(item, filter, query));
	return (
		<div className="tg-v tg-ledger">
			<header className="tg-l-head">
				<div className="tg-l-titles">
					<span className="tg-eyebrow">Trace · {shared.sessionLabel} session</span>
					<h1>{manifest.title}</h1>
					<p className="tg-l-facts">
						<span>{shared.duration}</span>
						<span>{manifest.summary?.promptCount ?? 0} prompts</span>
						<span>{manifest.counts.toolCalls} tool calls</span>
						<span>{model.subagents.length} subagents</span>
						<span className={manifest.counts.errors ? "tg-err-text" : ""}>{manifest.counts.errors} errors</span>
						<span>{model.files.filter((file) => file.edits.length).length || manifest.summary?.filesTouched?.length || 0} files changed</span>
						<Outcome outcome={shared.outcome} />
						<span>
							Viewing <LevelBadge level={level} />
						</span>
					</p>
				</div>
				<div className="tg-l-actions">
					{shared.actions}
					{shared.share ? (
						<button type="button" className="btn btn-secondary btn-sm" aria-expanded={shareOpen} onClick={() => setShareOpen(!shareOpen)}>
							Who sees what
						</button>
					) : null}
				</div>
			</header>
			{shareOpen ? <div className="tg-l-share">{shared.share}</div> : null}
			{level === "summary" ? (
				<SummaryOnly shared={shared} />
			) : (
				<>
					<div className="tg-l-sticky">
						<FilterBar filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} counts={filterCounts(model.items)} />
						{level !== "full" ? <p className="tg-l-levelnote">{hiddenSummary(level, model)}</p> : null}
					</div>
					<ol className="tg-log">
						{visible.map((item) => (
							<LogRow key={item.id} item={item} shared={shared} />
						))}
					</ol>
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 2. Turn by turn: read it like a conversation; the work folds between.

function WorkStep({ item, shared }: { item: Item; shared: Shared }) {
	const [open, setOpen] = React.useState(false);
	if (item.type === "reply") return <li id={`tg-ev-${item.id}`} className="tg-step-note">{item.text}</li>;
	if (item.type === "reasoning") return <li id={`tg-ev-${item.id}`} className="tg-step-think">{item.hidden ? `Reasoning hidden at ${LEVEL_NAME[shared.level]}` : item.text}</li>;
	if (item.type !== "tool") return <li className="tg-step-think">{item.text}</li>;
	if (item.sub) {
		return (
			<li id={`tg-ev-${item.id}`} className="tg-step-sub">
				<details>
					<summary>
						<span className="tg-step-kind">{item.sub.kind}</span> {item.sub.title}
						<span className="tg-step-meta">
							{item.sub.toolCount} tool calls · {span(item.sub.start, item.sub.end)}
						</span>
					</summary>
					<ol className="tg-steps">
						{item.sub.items.map((sub) => (
							<WorkStep key={sub.id} item={sub} shared={shared} />
						))}
					</ol>
				</details>
				{item.sub.finalText ? <Md className="tg-step-subresult" text={item.sub.finalText} /> : null}
			</li>
		);
	}
	return (
		<li id={`tg-ev-${item.id}`} className={`tg-step${item.error ? " is-error" : ""}`}>
			<button type="button" className="tg-step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className={`tg-step-glyph tg-g-${item.family}`} aria-hidden="true">
					{FAMILY_GLYPH[item.family]}
				</span>
				<span className="tg-step-name">{item.display}</span>
				<span className="tg-step-label">{item.label}</span>
				{item.diff ? <DiffStat added={item.diff.added} removed={item.diff.removed} /> : null}
				{item.error ? <span className="tg-st tg-st-err">error</span> : null}
			</button>
			{open ? <ToolBody tool={item} level={shared.level} /> : null}
		</li>
	);
}

function TurnSection({ turn, shared, number }: { turn: Turn; shared: Shared; number: number }) {
	const [open, setOpen] = React.useState(false);
	const work = turn.items.filter((item) => item !== turn.reply);
	return (
		<section className="tg-turn" id={`tg-turn-${turn.index}`} aria-label={`Turn ${number}`}>
			{turn.prompt ? (
				<div className="tg-turn-prompt" id={`tg-ev-${turn.prompt.id}`}>
					<span className="tg-eyebrow">
						Prompt {number} · {offset(turn.prompt.t, shared.model.startMs)}
					</span>
					<Md text={turn.prompt.text} />
				</div>
			) : null}
			{work.length ? (
				<div className={`tg-work${open ? " is-open" : ""}`}>
					<button type="button" className="tg-work-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
						<span className="tg-work-caret" aria-hidden="true">
							{open ? "▾" : "▸"}
						</span>
						<span>
							Worked {span(turn.start, turn.end) || "briefly"} · {turn.toolCount} tool calls
							{turn.errors ? <span className="tg-err-text"> · {turn.errors} errors</span> : null}
							{turn.files.length ? ` · edited ${turn.files.map((file) => file.split("/").pop()).join(", ")}` : ""}
						</span>
						{turn.checks.length ? (
							<span className="tg-work-checks" aria-label="checks in this turn">
								{turn.checks.map((check, index) => (
									<span key={index} className={`tg-dot tg-dot-${check.ok === null ? "unknown" : check.ok ? "ok" : "err"}`} />
								))}
							</span>
						) : null}
					</button>
					{open ? (
						<ol className="tg-steps">
							{work.map((item) => (
								<WorkStep key={item.id} item={item} shared={shared} />
							))}
						</ol>
					) : null}
				</div>
			) : null}
			{turn.reply ? (
				<div className="tg-turn-reply" id={`tg-ev-${turn.reply.id}`}>
					<span className="tg-eyebrow">Agent</span>
					<Md text={turn.reply.text} />
				</div>
			) : null}
		</section>
	);
}

function TurnByTurn({ shared }: { shared: Shared }) {
	const { model, manifest, level } = shared;
	const flash = useFlash();
	const [shareOpen, setShareOpen] = React.useState(false);
	const ending = [...model.turns].reverse().find((turn) => turn.reply && turn.toolCount > 0) || model.turns[model.turns.length - 1];
	return (
		<div className="tg-v tg-chapters">
			<aside className="tg-ch-rail" aria-label="Turns">
				<span className="tg-eyebrow">This session</span>
				<ol className="tg-ch-toc">
					{model.turns.map((turn, index) => (
						<li key={turn.index}>
							<button type="button" onClick={() => document.getElementById(`tg-turn-${turn.index}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
								<span className="tg-ch-num">{index + 1}</span>
								<span className="tg-ch-q">{turn.prompt?.text.split("\n")[0] || "Session start"}</span>
								<span className="tg-ch-meta">
									{turn.toolCount} tools{turn.errors ? ` · ${turn.errors} errors` : ""}
								</span>
							</button>
						</li>
					))}
				</ol>
				{shared.share ? (
					<div className="tg-ch-access">
						<span className="tg-eyebrow">Who sees what</span>
						<p>
							You're seeing <LevelBadge level={shared.detail.access.level} />
						</p>
						<button type="button" className="btn btn-secondary btn-sm" onClick={() => setShareOpen(!shareOpen)} aria-expanded={shareOpen}>
							{shareOpen ? "Close sharing" : "Manage sharing"}
						</button>
					</div>
				) : null}
			</aside>
			<div className="tg-ch-main">
				<header className="tg-ch-head">
					<span className="tg-eyebrow">Trace · {shared.sessionLabel} session</span>
					<h1>{manifest.title}</h1>
					<p className="tg-ch-facts">
						{shared.duration} · {manifest.summary?.promptCount ?? 0} prompts · {manifest.counts.toolCalls} tool calls · {model.subagents.length} subagents <Outcome outcome={shared.outcome} />
					</p>
					<div className="trace-actions">{shared.actions}</div>
				</header>
				{shareOpen ? <div className="tg-ch-share">{shared.share}</div> : null}
				{level !== "full" ? <p className="tg-ribbon">{hiddenSummary(level, model)}</p> : null}
				{level === "summary" ? (
					<SummaryOnly shared={shared} />
				) : (
					<>
						{ending?.reply ? (
							<section className="tg-result" aria-label="Where it ended">
								<div className="tg-result-head">
									<span className="tg-eyebrow">Where it ended</span>
									<button type="button" className="tg-linklike" onClick={() => flash(ending.reply!.id)}>
										Jump to it
									</button>
								</div>
								<Md text={ending.reply.text} />
								<div className="tg-result-grid">
									<FilesList shared={shared} />
									<ChecksList shared={shared} limit={6} />
								</div>
							</section>
						) : null}
						{model.turns.map((turn, index) => (
							<TurnSection key={turn.index} turn={turn} shared={shared} number={index + 1} />
						))}
					</>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// 3. What changed (retired in round 1b, kept until cleanup).

function WhatChanged({ shared }: { shared: Shared }) {
	const { model, manifest, level } = shared;
	const [tab, setTab] = React.useState<"changes" | "conversation" | "checks" | "sharing">("changes");
	const [selected, setSelected] = React.useState<string | null>(null);
	// Why each edit happened: the nearest agent message before it.
	const why = new Map<string, string>();
	let lastNote = "";
	const walk = (items: Item[]) => {
		for (const item of items) {
			if (item.type === "reply" || item.type === "prompt") lastNote = item.text.split("\n")[0];
			if (item.type === "tool" && item.family === "edit") why.set(item.id, lastNote);
			if (item.type === "tool" && item.sub) walk(item.sub.items);
		}
	};
	walk(model.items);
	const edited = model.files.filter((file) => file.edits.length);
	const readOnly = model.files.filter((file) => !file.edits.length);
	const files = selected ? edited.filter((file) => file.path === selected) : edited;
	const tabs: Array<[typeof tab, string]> = [
		["changes", `Changes · ${edited.length || manifest.summary?.filesTouched?.length || 0} files`],
		["conversation", `Conversation · ${model.turns.length} prompts`],
		["checks", `Checks · ${model.checks.length || manifest.summary?.checks?.length || 0}`],
		...(shared.share ? ([["sharing", "Who sees what"]] as Array<[typeof tab, string]>) : []),
	];
	return (
		<div className="tg-v tg-changes">
			<header className="tg-c-head">
				<div>
					<span className="tg-eyebrow">Trace · {shared.sessionLabel} session</span>
					<h1>{manifest.title}</h1>
					<p className="tg-c-facts">
						<DiffStat added={edited.reduce((n, file) => n + file.added, 0)} removed={edited.reduce((n, file) => n + file.removed, 0)} /> across {edited.length || manifest.summary?.filesTouched?.length || 0} files · {shared.duration} ·{" "}
						{manifest.counts.toolCalls} tool calls <Outcome outcome={shared.outcome} /> <LevelBadge level={level} />
					</p>
				</div>
				<div className="trace-actions">{shared.actions}</div>
			</header>
			<div className="tg-tabs" role="tablist">
				{tabs.map(([id, label]) => (
					<button key={id} type="button" role="tab" aria-selected={tab === id} className={`tg-tab${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
						{label}
					</button>
				))}
			</div>
			{tab === "sharing" ? <div className="tg-c-share">{shared.share}</div> : null}
			{tab === "changes" ? (
				level === "summary" ? (
					<SummaryOnly shared={shared} />
				) : (
					<div className="tg-c-grid">
						<nav className="tg-c-files" aria-label="Files">
							<button type="button" className={`tg-c-file${selected === null ? " is-on" : ""}`} onClick={() => setSelected(null)}>
								All changed files
							</button>
							{edited.map((file) => (
								<button key={file.path} type="button" className={`tg-c-file${selected === file.path ? " is-on" : ""}`} onClick={() => setSelected(file.path)}>
									<span className="tg-c-path">{file.path}</span>
									{file.isNew ? <span className="tg-new">new</span> : null}
									<DiffStat added={file.added} removed={file.removed} />
								</button>
							))}
							{readOnly.length ? (
								<>
									<span className="tg-eyebrow tg-c-readhead">Read, not changed</span>
									{readOnly.map((file) => (
										<span key={file.path} className="tg-c-file is-read">
											<span className="tg-c-path">{file.path}</span>
										</span>
									))}
								</>
							) : null}
						</nav>
						<div className="tg-c-diffs">
							{level !== "full" ? <p className="tg-ribbon">Diffs are hidden at {LEVEL_NAME[level]}. You can see which files were edited, when, and why.</p> : null}
							{files.map((file) => (
								<section key={file.path} className="tg-c-filecard">
									<header>
										<code>{file.path}</code>
										{file.isNew ? <span className="tg-new">new</span> : null}
										<DiffStat added={file.added} removed={file.removed} />
										<span className="tg-c-editcount">
											{file.edits.length} edit{file.edits.length === 1 ? "" : "s"}
										</span>
									</header>
									{file.edits.map((edit) => (
										<div key={edit.id} className={`tg-c-edit${edit.error ? " is-error" : ""}`} id={`tg-ev-${edit.id}`}>
											<p className="tg-c-why">
												<span className="tg-c-time">{offset(edit.t, model.startMs)}</span>
												{edit.agent !== "main" ? <span className="tg-step-kind">subagent</span> : null}
												{why.get(edit.id) ? <span>“{why.get(edit.id)}”</span> : <span>{edit.display}</span>}
											</p>
											{edit.error ? <pre className="tg-code tg-result tg-result-error">{edit.resultText || "This edit failed."}</pre> : null}
											{edit.diff && !edit.error ? <DiffView diff={edit.diff} /> : null}
										</div>
									))}
								</section>
							))}
							{!edited.length && level !== "full"
								? (manifest.summary?.filesTouched || []).map((path) => (
										<section key={path} className="tg-c-filecard">
											<header>
												<code>{path}</code>
											</header>
										</section>
									))
								: null}
						</div>
					</div>
				)
			) : null}
			{tab === "conversation" ? (
				level === "summary" ? (
					<SummaryOnly shared={shared} />
				) : (
					<ol className="tg-c-convo">
						{model.items.map((item) =>
							item.type === "prompt" ? (
								<li key={item.id} className="tg-c-prompt">
									<Md text={item.text} />
								</li>
							) : item.type === "reply" ? (
								<li key={item.id} className="tg-c-reply">
									<Md text={item.text} />
								</li>
							) : item.type === "tool" ? (
								<li key={item.id} className={`tg-c-tool${item.error ? " is-error" : ""}`}>
									<span className={`tg-step-glyph tg-g-${item.family}`}>{FAMILY_GLYPH[item.family]}</span> {item.display} <span className="tg-step-label">{item.label}</span>
									{item.diff ? <DiffStat added={item.diff.added} removed={item.diff.removed} /> : null}
								</li>
							) : null,
						)}
					</ol>
				)
			) : null}
			{tab === "checks" ? (
				<ol className="tg-c-checks">
					{model.checks.map((check) => (
						<li key={check.id} className={check.check?.ok === false ? "is-error" : ""}>
							<header>
								<span className={`tg-dot tg-dot-${check.check?.ok === null ? "unknown" : check.check?.ok ? "ok" : "err"}`} />
								<code>{check.check?.command}</code>
								<span className="tg-c-time">{offset(check.t, model.startMs)}</span>
							</header>
							{check.resultText ? <pre className="tg-code tg-result">{check.resultText}</pre> : check.resultHidden ? <p className="tg-hidden-note">Output hidden at {LEVEL_NAME[level]}.</p> : null}
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 4. Session map: the whole session on one time axis, then the transcript.

function laneMarks(items: Item[], model: Model) {
	const total = Math.max(1, (model.endMs ?? 0) - (model.startMs ?? 0));
	return items
		.filter((item) => item.t)
		.map((item) => ({ item, x: Math.min(100, Math.max(0, ((Date.parse(item.t!) - (model.startMs ?? 0)) / total) * 100)) }));
}

function MapMark({ item, x, onPick }: { item: Item; x: number; onPick: (id: string) => void }) {
	if (item.type === "prompt") return <button type="button" className="tg-m-prompt" style={{ left: `${x}%` }} title={`Prompt: ${item.text.slice(0, 80)}`} aria-label={`Prompt at ${x.toFixed(0)}%`} onClick={() => onPick(item.id)} />;
	if (item.type === "reply") return <button type="button" className="tg-m-reply" style={{ left: `${x}%` }} title={item.text.slice(0, 80)} aria-label="Agent message" onClick={() => onPick(item.id)} />;
	if (item.type !== "tool") return null;
	const cls = item.check ? (item.check.ok === false ? "tg-m-check-err" : item.check.ok ? "tg-m-check-ok" : "tg-m-check") : item.error ? "tg-m-err" : `tg-m-${item.family}`;
	return <button type="button" className={`tg-m-tick ${cls}${item.resultHidden ? " is-hollow" : ""}`} style={{ left: `${x}%` }} title={`${item.display} ${item.label}`} aria-label={`${item.display} ${item.label}`} onClick={() => onPick(item.id)} />;
}

function SessionMap({ shared }: { shared: Shared }) {
	const { model, manifest, level } = shared;
	const flash = useFlash();
	const minutes = Math.max(1, Math.ceil(((model.endMs ?? 0) - (model.startMs ?? 0)) / 60000));
	const total = Math.max(1, (model.endMs ?? 0) - (model.startMs ?? 0));
	const pos = (t: string | null) => (t ? Math.min(100, Math.max(0, ((Date.parse(t) - (model.startMs ?? 0)) / total) * 100)) : 0);
	const step = minutes > 20 ? 5 : minutes > 8 ? 2 : 1;
	const [openSub, setOpenSub] = React.useState<string | null>(null);
	const pick = (id: string) => {
		const sub = model.subagents.find((candidate) => candidate.items.some((item) => item.id === id));
		if (sub) {
			setOpenSub(sub.id);
			setTimeout(() => flash(id), 50);
		} else flash(id);
	};
	// Group consecutive quiet tool calls into runs; errors and edits stand alone.
	const blocks: Array<{ kind: "item"; item: Item } | { kind: "run"; items: ToolItem[] }> = [];
	for (const item of model.items) {
		const quiet = item.type === "tool" && !item.error && !item.sub && item.family !== "edit" && !item.check;
		const last = blocks[blocks.length - 1];
		if (quiet && last?.kind === "run") last.items.push(item as ToolItem);
		else if (quiet) blocks.push({ kind: "run", items: [item as ToolItem] });
		else blocks.push({ kind: "item", item });
	}
	return (
		<div className="tg-v tg-lanes">
			<header className="tg-m-head">
				<div>
					<span className="tg-eyebrow">Trace · {shared.sessionLabel} session</span>
					<h1>{manifest.title}</h1>
				</div>
				<div className="trace-actions">{shared.actions}</div>
			</header>
			<section className="tg-map" aria-label="Session map">
				<div className="tg-map-legend">
					<span>
						<b>{shared.duration}</b> · {manifest.summary?.promptCount ?? 0} prompts · {manifest.counts.toolCalls} tool calls · {manifest.counts.errors} errors
					</span>
					<span className="tg-map-keys">
						<i className="tg-k tg-m-read" /> read <i className="tg-k tg-m-edit" /> edit <i className="tg-k tg-m-shell" /> shell <i className="tg-k tg-m-err" /> error <i className="tg-k tg-m-check-ok tg-k-dot" /> check passed{" "}
						<i className="tg-k tg-m-check-err tg-k-dot" /> check failed
					</span>
					<Outcome outcome={shared.outcome} />
					<LevelBadge level={level} />
				</div>
				{level === "summary" ? null : (
					<div className="tg-map-body">
						<div className="tg-lane">
							<span className="tg-lane-label">Main agent</span>
							<div className="tg-lane-track">
								{laneMarks(model.items, model).map(({ item, x }) => (
									<MapMark key={item.id} item={item} x={x} onPick={pick} />
								))}
							</div>
						</div>
						{model.subagents.map((sub) => (
							<div className="tg-lane" key={sub.id}>
								<span className="tg-lane-label" title={sub.title}>
									{sub.kind} · {sub.title}
								</span>
								<div className="tg-lane-track">
									<span className="tg-lane-span" style={{ left: `${pos(sub.start)}%`, width: `${Math.max(0.6, pos(sub.end) - pos(sub.start))}%` }} />
									{laneMarks(sub.items, model).map(({ item, x }) => (
										<MapMark key={item.id} item={item} x={x} onPick={pick} />
									))}
								</div>
							</div>
						))}
						<div className="tg-axis">
							<span className="tg-lane-label" />
							<div className="tg-lane-track">
								{Array.from({ length: Math.floor(minutes / step) + 1 }, (_, index) => index * step).map((minute) => (
									<span key={minute} className="tg-axis-tick" style={{ left: `${Math.min(100, (minute * 60000 * 100) / total)}%` }}>
										{minute}m
									</span>
								))}
							</div>
						</div>
					</div>
				)}
			</section>
			{level !== "full" ? <p className="tg-ribbon">{hiddenSummary(level, model)} Hollow ticks on the map are steps whose output is hidden.</p> : null}
			<div className="tg-m-grid">
				<div className="tg-m-transcript">
					{level === "summary" ? (
						<SummaryOnly shared={shared} />
					) : (
						blocks.map((block, index) =>
							block.kind === "run" ? (
								<RunBlock key={`run-${index}`} items={block.items} shared={shared} />
							) : (
								<MapItem key={block.item.id} item={block.item} shared={shared} openSub={openSub} />
							),
						)
					)}
				</div>
				<aside className="tg-m-rail">
					<section className="tg-panel">
						<span className="tg-eyebrow">Outcome</span>
						<ChecksList shared={shared} limit={8} />
						<FilesList shared={shared} />
					</section>
					{shared.share}
				</aside>
			</div>
		</div>
	);
}

function RunBlock({ items, shared }: { items: ToolItem[]; shared: Shared }) {
	const [open, setOpen] = React.useState(false);
	const counts = new Map<string, number>();
	for (const item of items) counts.set(item.display, (counts.get(item.display) || 0) + 1);
	if (items.length === 1) return <MapItem item={items[0]} shared={shared} openSub={null} />;
	return (
		<div className="tg-run">
			<button type="button" className="tg-run-bar" aria-expanded={open} onClick={() => setOpen(!open)}>
				{open ? "▾" : "▸"} {items.length} steps: {[...counts.entries()].map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ""}`).join(", ")}
				<span className="tg-run-time">{offset(items[0].t, shared.model.startMs)}</span>
			</button>
			{open ? items.map((item) => <MapItem key={item.id} item={item} shared={shared} openSub={null} />) : items.map((item) => <span key={item.id} id={`tg-ev-${item.id}`} />)}
		</div>
	);
}

function MapItem({ item, shared, openSub }: { item: Item; shared: Shared; openSub: string | null }) {
	const [open, setOpen] = React.useState(false);
	if (item.type === "prompt")
		return (
			<div className="tg-mi-prompt" id={`tg-ev-${item.id}`}>
				<span className="tg-eyebrow">Prompt · {offset(item.t, shared.model.startMs)}</span>
				<Md text={item.text} />
			</div>
		);
	if (item.type === "reply")
		return (
			<div className={`tg-mi-reply${item.final ? " is-final" : ""}`} id={`tg-ev-${item.id}`}>
				<Md text={item.text} />
			</div>
		);
	if (item.type === "reasoning")
		return (
			<details className="tg-mi-think" id={`tg-ev-${item.id}`}>
				<summary>{item.hidden ? `Reasoning hidden at ${LEVEL_NAME[shared.level]}` : `Reasoning · ${words(item.text)} words`}</summary>
				{item.hidden ? null : <p>{item.text}</p>}
			</details>
		);
	if (item.type !== "tool") return <p className="tg-mi-note">{item.text}</p>;
	if (item.sub) return <SubCard sub={item.sub} tool={item} shared={shared} forceOpen={openSub === item.sub.id} />;
	return (
		<div className={`tg-mi-tool${item.error ? " is-error" : ""}`} id={`tg-ev-${item.id}`}>
			<button type="button" className="tg-step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className={`tg-step-glyph tg-g-${item.family}`} aria-hidden="true">
					{FAMILY_GLYPH[item.family]}
				</span>
				<span className="tg-step-name">{item.display}</span>
				<span className="tg-step-label">{item.label}</span>
				{item.diff ? <DiffStat added={item.diff.added} removed={item.diff.removed} /> : null}
				{item.check ? <span className={`tg-st ${item.check.ok === false ? "tg-st-err" : item.check.ok ? "tg-st-ok" : ""}`}>{item.check.ok === null ? "hidden" : item.check.ok ? "passed" : "failed"}</span> : item.error ? <span className="tg-st tg-st-err">error</span> : null}
			</button>
			{open || (item.diff && !item.error && shared.level === "full") ? <ToolBody tool={item} level={shared.level} /> : null}
		</div>
	);
}

function SubCard({ sub, tool, shared, forceOpen }: { sub: Subagent; tool: ToolItem; shared: Shared; forceOpen: boolean }) {
	return (
		<details className="tg-subcard" id={`tg-ev-${tool.id}`} open={forceOpen || undefined}>
			<summary>
				<span className="tg-step-kind">{sub.kind}</span> {sub.title}
				<span className="tg-step-meta">
					{sub.toolCount} tool calls · {span(sub.start, sub.end)}
					{sub.errors ? ` · ${sub.errors} errors` : ""}
				</span>
			</summary>
			<div className="tg-subcard-body">
				{sub.items.map((item) => (
					<MapItem key={item.id} item={item} shared={shared} openSub={null} />
				))}
			</div>
		</details>
	);
}

// ---------------------------------------------------------------------------
// 5. Inspector (retired in round 1b, kept until cleanup).

type Row = { item: Item; depth: number; sub?: Subagent };
function flatten(items: Item[], depth = 0, out: Row[] = []) {
	for (const item of items) {
		out.push({ item, depth });
		if (item.type === "tool" && item.sub) flatten(item.sub.items, depth + 1, out);
	}
	return out;
}

function Inspector({ shared }: { shared: Shared }) {
	const { model, manifest, level } = shared;
	const rows = React.useMemo(() => flatten(model.items), [model]);
	const [filter, setFilter] = React.useState<Filter>("all");
	const [query, setQuery] = React.useState("");
	const [selected, setSelected] = React.useState<string | null>(null);
	const visible = rows.filter((row) => matches(row.item, filter, query));
	const index = visible.findIndex((row) => row.item.id === selected);
	const current = index >= 0 ? visible[index].item : null;
	const listRef = React.useRef<HTMLOListElement>(null);
	const go = (next: number) => {
		const row = visible[Math.max(0, Math.min(visible.length - 1, next))];
		if (!row) return;
		setSelected(row.item.id);
		listRef.current?.querySelector(`[data-id="${row.item.id}"]`)?.scrollIntoView({ block: "nearest" });
	};
	const nextError = (direction: 1 | -1) => {
		for (let at = index + direction; at >= 0 && at < visible.length; at += direction) {
			const item = visible[at].item;
			if (item.type === "tool" && item.error) return go(at);
		}
	};
	return (
		<div className="tg-v tg-inspector">
			<header className="tg-i-head">
				<div>
					<span className="tg-eyebrow">Trace · {shared.sessionLabel} session</span>
					<h1>{manifest.title}</h1>
				</div>
				<p className="tg-i-facts">
					{shared.duration} · {manifest.counts.toolCalls} tool calls · {manifest.counts.errors} errors <Outcome outcome={shared.outcome} />
				</p>
				<div className="trace-actions">{shared.actions}</div>
			</header>
			<div className="tg-i-split">
				<div className="tg-i-listpane">
					<FilterBar filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} counts={filterCounts(rows.map((row) => row.item))} />
					<p className="tg-i-level">
						<LevelBadge level={level} /> {level === "full" ? "Everything except secrets" : level === "summary" ? "Summary only" : `${model.hiddenCount} outputs and reasoning hidden`}
					</p>
					{level === "summary" ? null : (
						<ol
							className="tg-i-list"
							ref={listRef}
							tabIndex={0}
							aria-label="Events. Use Up and Down to move."
							onKeyDown={(event) => {
								if (event.key === "ArrowDown" || event.key === "j") {
									event.preventDefault();
									go(index + 1);
								} else if (event.key === "ArrowUp" || event.key === "k") {
									event.preventDefault();
									go(index - 1);
								}
							}}
						>
							<li>
								<button type="button" className={`tg-i-row tg-i-overview${selected === null ? " is-on" : ""}`} onClick={() => setSelected(null)}>
									Overview
								</button>
							</li>
							{visible.map(({ item, depth }) => (
								<li key={item.id}>
									<button
										type="button"
										data-id={item.id}
										className={`tg-i-row tg-i-${item.type}${item.type === "tool" && item.error ? " is-error" : ""}${selected === item.id ? " is-on" : ""}`}
										style={{ ["--depth" as string]: depth }}
										onClick={() => setSelected(item.id)}
									>
										<span className="tg-log-time">{offset(item.t, model.startMs)}</span>
										<span className={`tg-step-glyph tg-g-${item.type === "tool" ? item.family : item.type}`} aria-hidden="true">
											{item.type === "tool" ? FAMILY_GLYPH[item.family] : item.type === "prompt" ? "?" : item.type === "reply" ? "›" : "~"}
										</span>
										<span className="tg-i-title">{item.type === "tool" ? `${item.display} ${item.label}` : item.type === "reasoning" ? (item.hidden ? "Reasoning (hidden)" : "Reasoning") : item.text.split("\n")[0]}</span>
										{item.type === "tool" && item.diff ? <DiffStat added={item.diff.added} removed={item.diff.removed} /> : null}
										{item.type === "tool" && item.error ? <span className="tg-st tg-st-err">error</span> : null}
									</button>
								</li>
							))}
						</ol>
					)}
				</div>
				<div className="tg-i-detail" aria-live="polite">
					{current ? (
						<>
							<div className="tg-i-nav">
								<button type="button" className="btn btn-secondary btn-sm" onClick={() => go(index - 1)} disabled={index <= 0}>
									Previous
								</button>
								<button type="button" className="btn btn-secondary btn-sm" onClick={() => go(index + 1)} disabled={index >= visible.length - 1}>
									Next
								</button>
								<button type="button" className="btn btn-secondary btn-sm" onClick={() => nextError(1)}>
									Next error
								</button>
								<span className="tg-i-pos">
									{index + 1} of {visible.length}
								</span>
							</div>
							<InspectorDetail item={current} shared={shared} />
						</>
					) : (
						<div className="tg-i-overviewpane">
							<span className="tg-eyebrow">Overview</span>
							{level !== "full" ? <p className="tg-ribbon">{hiddenSummary(level, model)}</p> : null}
							{model.turns.length && level !== "summary" ? (
								<ol className="tg-i-turns">
									{model.turns.map((turn, number) => (
										<li key={turn.index}>
											<button type="button" className="tg-linklike" onClick={() => turn.prompt && setSelected(turn.prompt.id)}>
												{number + 1}. {turn.prompt?.text.split("\n")[0]}
											</button>
											<span className="tg-ch-meta">
												{turn.toolCount} tools · {span(turn.start, turn.end)}
												{turn.errors ? ` · ${turn.errors} errors` : ""}
											</span>
										</li>
									))}
								</ol>
							) : null}
							<div className="tg-result-grid">
								<FilesList shared={shared} />
								<ChecksList shared={shared} limit={8} />
							</div>
							{shared.share}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function InspectorDetail({ item, shared }: { item: Item; shared: Shared }) {
	const time = offset(item.t, shared.model.startMs);
	if (item.type !== "tool") {
		return (
			<article className="tg-i-article">
				<p className="tg-i-meta">
					{item.type === "prompt" ? "Prompt" : item.type === "reply" ? "Agent" : item.type === "reasoning" ? "Reasoning" : "Note"} · {time}
					{item.agent !== "main" ? " · subagent" : ""}
				</p>
				{item.type === "reasoning" && item.hidden ? <p className="tg-hidden-note">Reasoning is hidden at {LEVEL_NAME[shared.level]}.</p> : <Md text={item.text} />}
			</article>
		);
	}
	return (
		<article className="tg-i-article">
			<p className="tg-i-meta">
				{item.display} · {time}
				{item.agent !== "main" ? " · subagent" : ""}
				{item.error ? <span className="tg-st tg-st-err">error</span> : null}
			</p>
			<h2 className="tg-i-h">{item.label}</h2>
			{item.sub ? (
				<>
					<p>
						{item.sub.kind} ran {item.sub.toolCount} tool calls in {span(item.sub.start, item.sub.end)}.
					</p>
					{item.sub.finalText ? <Md text={item.sub.finalText} /> : null}
				</>
			) : (
				<ToolBody tool={item} level={shared.level} />
			)}
		</article>
	);
}

// ---------------------------------------------------------------------------
// Registry and stage

type Variant = { id: string; name: string; descriptor: string; render: (shared: Shared) => React.ReactNode };
void WhatChanged;
void Inspector;

// Round 1 (kept until cleanup): Ship's log, Turn by turn, two chat transcripts, Session map.
const ROUND1: Variant[] = [
	{ id: "ships-log", name: "Ship's log", descriptor: "One line per event, full width, filters and search; prompts break the rhythm.", render: (shared) => <ShipsLog shared={shared} /> },
	{ id: "turn-by-turn", name: "Turn by turn", descriptor: "Reads like the conversation; each prompt's work folds into one bar, the ending is on top.", render: (shared) => <TurnByTurn shared={shared} /> },
	{ id: "chat-elements", name: "Chat, every step a card", descriptor: "A native chat transcript: your prompts as bubbles, the agent's replies flat, each tool call an AI Elements tool card.", render: (shared) => <ChatElements shared={shared} /> },
	{ id: "session-map", name: "Session map", descriptor: "The whole session on a time axis with a lane per subagent, above a grouped transcript.", render: (shared) => <SessionMap shared={shared} /> },
	{ id: "chat-steps", name: "Chat, work folded", descriptor: "A native chat transcript where the work between replies folds into one line that opens into a chain of steps.", render: (shared) => <ChatSteps shared={shared} /> },
];
void ROUND1;

// Round 2: the locked chat default with five ways into the work.
export const GRILL_VARIANTS: Variant[] = ROUND2;

function useVariantIndex(count: number) {
	const [index, setIndex] = React.useState(0);
	React.useEffect(() => {
		const id = new URLSearchParams(window.location.search).get("variant");
		const found = GRILL_VARIANTS.findIndex((variant) => variant.id === id);
		if (found >= 0) setIndex(found);
	}, []);
	const select = React.useCallback(
		(next: number) => {
			const normalized = ((next % count) + count) % count;
			setIndex(normalized);
			const url = new URL(window.location.href);
			url.searchParams.set("variant", GRILL_VARIANTS[normalized].id);
			window.history.replaceState(window.history.state, "", url);
		},
		[count],
	);
	return [index, select] as const;
}

const TEXT_ENTRY = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

export function TraceGrill(props: {
	detail: Detail;
	events: TraceEvent[];
	projectId: string;
	traceId: string;
	actions: React.ReactNode;
	share: React.ReactNode;
	tracePath: string;
}) {
	const { detail } = props;
	const [index, select] = useVariantIndex(GRILL_VARIANTS.length);
	const [viewAs, setViewAs] = React.useState<Level>(detail.access.level);
	const [preview, setPreview] = React.useState<{ level: Level; events: TraceEvent[]; manifest: Detail["manifest"] } | null>(null);
	const rootRef = React.useRef<HTMLDivElement>(null);
	const [edges, setEdges] = React.useState({ left: 8, right: 8 });

	React.useEffect(() => {
		if (document.getElementById("trace-grill-css")) return;
		const style = document.createElement("style");
		style.id = "trace-grill-css";
		const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
		if (nonce) style.nonce = nonce;
		style.textContent = GRILL_CSS + CHAT_CSS + R2_CSS;
		document.head.append(style);
	}, []);

	React.useEffect(() => {
		const measure = () => {
			const rect = rootRef.current?.getBoundingClientRect();
			if (!rect) return;
			setEdges({ left: Math.max(4, rect.left - 60), right: Math.max(4, window.innerWidth - rect.right - 60) });
		};
		measure();
		const frame = requestAnimationFrame(measure);
		const observer = new ResizeObserver(measure);
		if (rootRef.current) observer.observe(rootRef.current);
		window.addEventListener("resize", measure);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);

	React.useEffect(() => {
		if (viewAs === detail.access.level) return setPreview(null);
		let cancelled = false;
		fetch(`${props.tracePath}/preview`, {
			method: "POST",
			credentials: "same-origin",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ profile: { level: viewAs, rules: [] } }),
		})
			.then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
			.then((body) => {
				if (!cancelled) setPreview({ level: viewAs, events: viewAs === "summary" ? [] : body.events, manifest: { ...detail.manifest, ...body.manifest, cwdLabel: detail.manifest.cwdLabel } });
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [viewAs, detail, props.tracePath]);

	const level = preview?.level ?? detail.access.level;
	const events = preview ? preview.events : level === "summary" ? [] : props.events;
	const manifest = preview?.manifest ?? detail.manifest;
	const model = React.useMemo(() => buildModel(events, manifest), [events, manifest]);
	const summary = manifest.summary;
	const shared: Shared = {
		model,
		manifest,
		detail,
		level,
		actions: props.actions,
		share: props.share,
		sessionLabel: harnessLabel(manifest.source?.harness),
		duration: summary?.durationSeconds ? (summary.durationSeconds < 90 ? `${summary.durationSeconds}s` : `${Math.round(summary.durationSeconds / 60)} min`) : "unknown length",
		outcome:
			summary?.outcome === "last-check-passed"
				? { text: "Checks passed", tone: "ok" }
				: summary?.outcome === "last-check-failed"
					? { text: "Checks failed", tone: "err" }
					: { text: "No checks run", tone: "none" },
	};
	const variant = GRILL_VARIANTS[index];
	const prev = GRILL_VARIANTS[(index - 1 + GRILL_VARIANTS.length) % GRILL_VARIANTS.length];
	const next = GRILL_VARIANTS[(index + 1) % GRILL_VARIANTS.length];

	return (
		<div
			className="tg-root"
			ref={rootRef}
			role="group"
			aria-label="Trace viewer design variants"
			tabIndex={-1}
			onKeyDown={(event) => {
				if (event.defaultPrevented || event.nativeEvent.isComposing) return;
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				const target = event.target as HTMLElement;
				if (target.closest(TEXT_ENTRY) || target.closest("[role=radiogroup], [role=tablist], .tg-i-list")) return;
				event.preventDefault();
				select(index + (event.key === "ArrowLeft" ? -1 : 1));
			}}
		>
			<span className="sr-only" aria-live="polite">
				Design {index + 1} of {GRILL_VARIANTS.length}: {variant.name}. {variant.descriptor}
			</span>
			{createPortal(
				<div className="tg-edges">
			<button type="button" className="tg-edge tg-edge-left" style={{ left: edges.left }} aria-label={`Previous design: ${prev.name}`} title={`Previous design: ${prev.name}`} onClick={() => select(index - 1)}>
				<span aria-hidden="true">‹</span>
			</button>
			<button type="button" className="tg-edge tg-edge-right" style={{ right: edges.right }} aria-label={`Next design: ${next.name}`} title={`Next design: ${next.name}`} onClick={() => select(index + 1)}>
				<span aria-hidden="true">›</span>
			</button>
				</div>,
				document.body,
			)}
			{detail.access.canManage ? (
				<div className="tg-stateline" role="radiogroup" aria-label="Preview the page at a level">
					<span>Preview as</span>
					{(["full", "conversation", "summary"] as Level[]).map((option) => (
						<button key={option} type="button" role="radio" aria-checked={viewAs === option} className={`tg-chip${viewAs === option ? " is-on" : ""}`} onClick={() => setViewAs(option)}>
							{LEVEL_NAME[option]}
						</button>
					))}
				</div>
			) : null}
			<div key={variant.id} data-variant={variant.id}>
				{variant.render(shared)}
			</div>
		</div>
	);
}

export type { Detail as GrillDetail };
