/// <reference lib="dom" />
// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Round 2. Locked: a native chat transcript that shows each prompt and the
// agent's final reply only. Under test: how a reader dives into the work.
import * as React from "react";

import { offset, span, type Item, type ToolItem, type Turn } from "./trace-grill-model";
import { LEVEL_NAME, Md } from "./trace-grill-parts";
import type { Shared } from "./trace-grill";
import {
	AssistantText,
	ChatTopBar,
	CodeBlock,
	ContinueBar,
	FAMILY_ICON,
	Icon,
	LevelBanner,
	ReasoningBlock,
	ScrollToEnd,
	ShareSheet,
	StepList,
	SummaryBlock,
	ToolCard,
	UserMessage,
	WorkGroup,
	blocksOf,
	reasoningSeconds,
	stepPhrase,
} from "./trace-grill-chat";

// ---------------------------------------------------------------------------
// Turn helpers

export const workOf = (turn: Turn) => turn.items.filter((item) => item !== turn.reply);
export function toolsOf(items: Item[]): ToolItem[] {
	const out: ToolItem[] = [];
	for (const item of items) {
		if (item.type !== "tool") continue;
		out.push(item);
		if (item.sub) out.push(...toolsOf(item.sub.items));
	}
	return out;
}
export function statsOf(turn: Turn) {
	const tools = toolsOf(workOf(turn));
	const edits = tools.filter((tool) => tool.family === "edit" && tool.path && !tool.error);
	return {
		tools,
		steps: tools.length,
		errors: tools.filter((tool) => tool.error).length,
		files: [...new Set(edits.map((tool) => tool.path!))],
		edits,
		checks: tools.filter((tool) => tool.check),
		duration: span(turn.start, turn.end),
	};
}

function WorkLine({ turn, open, onClick, label }: { turn: Turn; open?: boolean; onClick: () => void; label?: string }) {
	const stats = statsOf(turn);
	if (!stats.steps && !workOf(turn).length) return null;
	return (
		<button type="button" className={`r2-workline${open ? " is-open" : ""}`} aria-expanded={open} onClick={onClick}>
			<Icon name="bot" size={14} />
			<span>
				{label || "Worked"} {stats.duration ? `for ${stats.duration}` : ""} · {stats.steps} steps
			</span>
			{stats.errors ? <span className="tc-badge tc-badge-err">{stats.errors} failed</span> : null}
			{stats.files.length ? (
				<span className="r2-muted">
					{stats.files.length} file{stats.files.length === 1 ? "" : "s"} changed
				</span>
			) : null}
			<Icon name="chevron" className={open ? "is-open" : ""} />
		</button>
	);
}

export function TurnChanges({ turn, shared }: { turn: Turn; shared: Shared }) {
	const stats = statsOf(turn);
	if (!stats.edits.length) return <p className="r2-empty">No files changed in this part of the session.</p>;
	return (
		<div className="r2-stack">
			{shared.level !== "full" ? (
				<p className="tc-hidden">
					<Icon name="eyeOff" size={14} /> Diffs are hidden at {LEVEL_NAME[shared.level]}. These files were changed:
				</p>
			) : null}
			{stats.edits.map((edit) =>
				edit.diff ? (
					<CodeBlock key={edit.id} title={edit.diff.path} diff={edit.diff} />
				) : (
					<span key={edit.id} className="tc-filechip">
						<Icon name="file" size={12} />
						{edit.path}
					</span>
				),
			)}
		</div>
	);
}

function CheckRow({ tool, shared }: { tool: ToolItem; shared: Shared }) {
	const [open, setOpen] = React.useState(false);
	const ok = tool.check?.ok;
	return (
		<li className="r2-check">
			<button type="button" className="r2-check-line" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className={`r2-check-icon r2-${ok === null || ok === undefined ? "unknown" : ok ? "ok" : "err"}`}>
					<Icon name={ok === null || ok === undefined ? "circle" : ok ? "ok" : "err"} size={14} />
				</span>
				<code>{tool.check?.command}</code>
				<span className="r2-muted">{ok === null || ok === undefined ? `result hidden at ${LEVEL_NAME[shared.level]}` : ok ? "passed" : "failed"}</span>
				<Icon name="chevron" className={open ? "is-open" : ""} />
			</button>
			{open ? tool.resultText !== undefined ? <pre className={`tc-output${tool.error ? " is-error" : ""}`}>{tool.resultText || "(no output)"}</pre> : <p className="tc-hidden">Output hidden.</p> : null}
		</li>
	);
}

export function TurnChecks({ turn, shared }: { turn: Turn; shared: Shared }) {
	const stats = statsOf(turn);
	if (!stats.checks.length) return <p className="r2-empty">No tests, lint or builds were run in this part of the session.</p>;
	return (
		<ol className="r2-checks">
			{stats.checks.map((tool) => (
				<CheckRow key={tool.id} tool={tool} shared={shared} />
			))}
		</ol>
	);
}

export function Shell({ shared, children, wide = false, toolbar }: { shared: Shared; children: React.ReactNode; wide?: boolean; toolbar?: React.ReactNode }) {
	const [sheet, setSheet] = React.useState(false);
	return (
		<div className={`tg-v tc r2${wide ? " r2-wide" : ""}`}>
			<ChatTopBar shared={shared} onShare={shared.share ? () => setSheet(true) : null} />
			<LevelBanner shared={shared} />
			{toolbar}
			{shared.level === "summary" ? <SummaryBlock shared={shared} /> : children}
			<ContinueBar shared={shared} />
			<ScrollToEnd />
			<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />
		</div>
	);
}

export function TurnFrame({ turn, shared, between, aboveReply, reply }: { turn: Turn; shared: Shared; between?: React.ReactNode; aboveReply?: React.ReactNode; reply?: React.ReactNode }) {
	return (
		<section className="r2-turn" id={`tg-turn-${turn.index}`} aria-label={turn.prompt ? `Prompt ${turn.index + 1}` : "Session start"}>
			{turn.prompt ? <UserMessage item={turn.prompt} /> : null}
			{between}
			{aboveReply}
			{reply ?? (turn.reply ? <AssistantText item={turn.reply} shared={shared} first /> : null)}
		</section>
	);
}

// ---------------------------------------------------------------------------
// 1. Unfold in place

function UnfoldTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const [open, setOpen] = React.useState(false);
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			between={
				<div className="r2-unfold">
					<WorkLine turn={turn} open={open} onClick={() => setOpen(!open)} />
					{open ? (
						<div className="r2-unfold-body">
							<StepList items={workOf(turn)} shared={shared} />
						</div>
					) : null}
				</div>
			}
		/>
	);
}

function UnfoldInPlace({ shared }: { shared: Shared }) {
	return (
		<Shell shared={shared}>
			<div className="tc-conversation" role="log">
				{shared.model.turns.map((turn) => (
					<UnfoldTurn key={turn.index} turn={turn} shared={shared} />
				))}
			</div>
		</Shell>
	);
}

// ---------------------------------------------------------------------------
// 2. Trace panel: the chat stays put; the work opens beside it.

function TracePanel({ shared }: { shared: Shared }) {
	const [openTurn, setOpenTurn] = React.useState<number | null>(null);
	const [tab, setTab] = React.useState<"steps" | "changes" | "checks">("steps");
	const turn = openTurn === null ? null : shared.model.turns[openTurn];
	const stats = turn ? statsOf(turn) : null;
	return (
		<Shell shared={shared} wide={turn !== null}>
			<div className={`r2-split${turn ? " is-open" : ""}`}>
				<div className="tc-conversation" role="log">
					{shared.model.turns.map((each) => {
						const s = statsOf(each);
						const active = openTurn === each.index;
						return (
							<TurnFrame
								key={each.index}
								turn={each}
								shared={shared}
								between={
									s.steps ? (
										<button type="button" className={`r2-chip${active ? " is-on" : ""}`} aria-pressed={active} onClick={() => setOpenTurn(active ? null : each.index)}>
											<Icon name="list" size={14} /> {active ? "Showing the work" : "Show the work"} · {s.steps} steps{s.errors ? ` · ${s.errors} failed` : ""}
										</button>
									) : null
								}
							/>
						);
					})}
				</div>
				{turn && stats ? (
					<aside className="r2-panel" aria-label="Work for this prompt">
						<header className="r2-panel-head">
							<div>
								<span className="r2-panel-title">Prompt {turn.index + 1}</span>
								<span className="r2-muted">
									{" "}
									· {stats.duration} · {stats.steps} steps
								</span>
								<p className="r2-panel-q">{turn.prompt?.text.split("\n")[0]}</p>
							</div>
							<button type="button" className="tc-iconbtn" aria-label="Close" onClick={() => setOpenTurn(null)}>
								<Icon name="x" />
							</button>
						</header>
						<div className="r2-tabs" role="tablist">
							{(
								[
									["steps", `Steps ${stats.steps}`],
									["changes", `Changes ${stats.files.length}`],
									["checks", `Checks ${stats.checks.length}`],
								] as const
							).map(([id, label]) => (
								<button key={id} type="button" role="tab" aria-selected={tab === id} className={`r2-tab${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
									{label}
								</button>
							))}
						</div>
						<div className="r2-panel-body">
							{tab === "steps" ? <StepList items={workOf(turn)} shared={shared} /> : tab === "changes" ? <TurnChanges turn={turn} shared={shared} /> : <TurnChecks turn={turn} shared={shared} />}
						</div>
					</aside>
				) : null}
			</div>
		</Shell>
	);
}

// ---------------------------------------------------------------------------
// 3. Timeline under each prompt: a clean strip of steps; click one to read it.

type Mark = { tool: ToolItem; sub?: boolean };

export function StepDetail({ tool, shared }: { tool: ToolItem; shared: Shared }) {
	if (tool.sub) {
		return (
			<div className="r2-stack">
				{tool.sub.finalText ? <Md text={tool.sub.finalText} /> : null}
				<StepList items={tool.sub.items} shared={shared} />
			</div>
		);
	}
	if (tool.diff && !tool.error) return <CodeBlock title={tool.diff.path} diff={tool.diff} />;
	return (
		<div className="r2-stack">
			{tool.input && typeof tool.input.command === "string" ? <CodeBlock text={`$ ${tool.input.command}`} /> : null}
			{tool.resultText !== undefined ? <pre className={`tc-output${tool.error ? " is-error" : ""}`}>{tool.resultText || "(no output)"}</pre> : null}
			{tool.resultHidden ? (
				<p className="tc-hidden">
					<Icon name="eyeOff" size={14} /> Output hidden at {LEVEL_NAME[shared.level]}.
				</p>
			) : null}
		</div>
	);
}

function TimelineTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const work = workOf(turn);
	const marks: Mark[] = work.filter((item): item is ToolItem => item.type === "tool").map((tool) => ({ tool }));
	const [selected, setSelected] = React.useState<number | null>(null);
	const [list, setList] = React.useState(false);
	const stats = statsOf(turn);
	const current = selected === null ? null : marks[selected];
	// The note the agent wrote just before a step explains it.
	const noteFor = (tool: ToolItem) => {
		const at = work.indexOf(tool);
		for (let index = at - 1; index >= 0; index--) {
			const item = work[index];
			if (item.type === "reply") return item.text.split("\n")[0];
			if (item.type === "tool") return null;
		}
		return null;
	};
	if (!marks.length) return <TurnFrame turn={turn} shared={shared} />;
	const total = marks.reduce((n, mark) => n + (mark.tool.sub ? Math.max(3, mark.tool.sub.toolCount) : 1), 0);
	let cursor = 0;
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			between={
				<div className="r2-timeline">
					<div className="r2-tl-head">
						<span>
							{stats.duration} · {marks.length} steps
							{marks.some((mark) => mark.tool.sub) ? ` (subagents ran ${stats.steps - marks.length} more)` : ""}
						</span>
						{stats.errors ? <span className="tc-badge tc-badge-err">{stats.errors} failed</span> : null}
						<button type="button" className="r2-link" onClick={() => setList(!list)} aria-expanded={list}>
							{list ? "Hide the list" : "List every step"}
						</button>
					</div>
					<div className="r2-tl-track" role="listbox" aria-label="Steps">
						<span className="r2-tl-rail" aria-hidden="true" />
						{marks.map((mark, index) => {
							const width = mark.tool.sub ? Math.max(3, mark.tool.sub.toolCount) : 1;
							const left = ((cursor + width / 2) / total) * 100;
							cursor += width;
							const tool = mark.tool;
							const tone = tool.error ? "err" : tool.check ? (tool.check.ok === false ? "err" : tool.check.ok ? "ok" : "unknown") : tool.family === "edit" ? "edit" : "plain";
							if (tool.sub) {
								return (
									<button
										key={tool.id}
										type="button"
										role="option"
										aria-selected={selected === index}
										className={`r2-tl-sub${selected === index ? " is-on" : ""}`}
										style={{ left: `${((cursor - width) / total) * 100}%`, width: `${(width / total) * 100}%` }}
										title={stepPhrase(tool)}
										onClick={() => setSelected(selected === index ? null : index)}
									>
										<span>{tool.sub.kind}</span>
									</button>
								);
							}
							return (
								<button
									key={tool.id}
									type="button"
									role="option"
									aria-selected={selected === index}
									aria-label={stepPhrase(tool)}
									title={stepPhrase(tool)}
									className={`r2-tl-dot r2-tl-${tone}${tool.check ? " is-check" : ""}${selected === index ? " is-on" : ""}`}
									style={{ left: `${left}%` }}
									onClick={() => setSelected(selected === index ? null : index)}
								/>
							);
						})}
					</div>
					<div className="r2-tl-ends" aria-hidden="true">
						<span>{offset(turn.start, shared.model.startMs)}</span>
						<span>{offset(turn.end, shared.model.startMs)}</span>
					</div>
					{current ? (
						<div className="r2-tl-detail">
							<header>
								<span className={`tc-step-icon${current.tool.error ? " is-error" : ""}`}>
									<Icon name={current.tool.error ? "err" : FAMILY_ICON[current.tool.family]} size={14} />
								</span>
								<strong>{stepPhrase(current.tool)}</strong>
								<span className="r2-muted">
									Step {selected! + 1} of {marks.length} · {offset(current.tool.t, shared.model.startMs)}
								</span>
								<span className="r2-tl-nav">
									<button type="button" className="tc-iconbtn" aria-label="Previous step" disabled={selected === 0} onClick={() => setSelected(Math.max(0, selected! - 1))}>
										<Icon name="chevron" className="r2-rot90" />
									</button>
									<button type="button" className="tc-iconbtn" aria-label="Next step" disabled={selected === marks.length - 1} onClick={() => setSelected(Math.min(marks.length - 1, selected! + 1))}>
										<Icon name="chevron" className="r2-rotm90" />
									</button>
								</span>
							</header>
							{noteFor(current.tool) ? <p className="r2-tl-note">“{noteFor(current.tool)}”</p> : null}
							<StepDetail tool={current.tool} shared={shared} />
						</div>
					) : null}
					{list ? <StepList items={work} shared={shared} /> : null}
				</div>
			}
		/>
	);
}

function TimelineStrips({ shared }: { shared: Shared }) {
	return (
		<Shell shared={shared}>
			<div className="tc-conversation" role="log">
				{shared.model.turns.map((turn) => (
					<TimelineTurn key={turn.index} turn={turn} shared={shared} />
				))}
			</div>
		</Shell>
	);
}

// ---------------------------------------------------------------------------
// 4. Detail level: one control for the whole transcript.

type Depth = "conversation" | "steps" | "everything";

function DetailLevel({ shared }: { shared: Shared }) {
	const [depth, setDepth] = React.useState<Depth>("conversation");
	const toolbar = (
		<div className="r2-depth" role="radiogroup" aria-label="How much to show">
			{(
				[
					["conversation", "Conversation", "Prompts and final replies"],
					["steps", "Steps", "Plus the work, folded"],
					["everything", "Everything", "Every message, tool call and result"],
				] as const
			).map(([id, label, hint]) => (
				<button key={id} type="button" role="radio" aria-checked={depth === id} className={`r2-depth-opt${depth === id ? " is-on" : ""}`} onClick={() => setDepth(id)} title={hint}>
					{label}
				</button>
			))}
		</div>
	);
	return (
		<Shell shared={shared} toolbar={toolbar}>
			<div className="tc-conversation" role="log">
				{shared.model.turns.map((turn) => {
					const work = workOf(turn);
					if (depth === "conversation") return <TurnFrame key={turn.index} turn={turn} shared={shared} />;
					if (depth === "steps") {
						return (
							<TurnFrame
								key={turn.index}
								turn={turn}
								shared={shared}
								between={blocksOf(work).map((block, index) =>
									block.kind === "work" ? (
										<WorkGroup key={`w${index}`} items={block.items} shared={shared} />
									) : block.item.type === "reply" ? (
										<AssistantText key={block.item.id} item={block.item} shared={shared} first={false} />
									) : null,
								)}
							/>
						);
					}
					return (
						<TurnFrame
							key={turn.index}
							turn={turn}
							shared={shared}
							between={work.map((item, index) =>
								item.type === "tool" ? (
									<ToolCard key={item.id} tool={item} shared={shared} />
								) : item.type === "reasoning" ? (
									<ReasoningBlock key={item.id} item={item} level={shared.level} seconds={reasoningSeconds(work, index)} />
								) : item.type === "reply" ? (
									<AssistantText key={item.id} item={item} shared={shared} first={false} />
								) : null,
							)}
						/>
					);
				})}
			</div>
		</Shell>
	);
}

// ---------------------------------------------------------------------------
// 5. Answer tabs: each reply carries its own Steps, Changes and Checks.

function TabbedTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const [tab, setTab] = React.useState<"answer" | "steps" | "changes" | "checks">("answer");
	const stats = statsOf(turn);
	if (!stats.steps) return <TurnFrame turn={turn} shared={shared} />;
	const tabs = [
		["answer", "Answer"],
		["steps", `Steps · ${stats.steps}`],
		["changes", `Changes · ${stats.files.length}`],
		["checks", `Checks · ${stats.checks.length}`],
	] as const;
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			reply={
				<div className="r2-tabbed">
					<div className="r2-tabs" role="tablist" aria-label="This reply">
						{tabs.map(([id, label]) => (
							<button key={id} type="button" role="tab" aria-selected={tab === id} className={`r2-tab${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
								{label}
								{id === "steps" && stats.errors ? <span className="r2-tab-err">{stats.errors}</span> : null}
							</button>
						))}
					</div>
					{tab === "answer" ? (
						turn.reply ? (
							<AssistantText item={turn.reply} shared={shared} first={false} />
						) : (
							<p className="r2-empty">No reply in this part of the session.</p>
						)
					) : tab === "steps" ? (
						<StepList items={workOf(turn)} shared={shared} />
					) : tab === "changes" ? (
						<TurnChanges turn={turn} shared={shared} />
					) : (
						<TurnChecks turn={turn} shared={shared} />
					)}
				</div>
			}
		/>
	);
}

function AnswerTabs({ shared }: { shared: Shared }) {
	return (
		<Shell shared={shared}>
			<div className="tc-conversation" role="log">
				{shared.model.turns.map((turn) => (
					<TabbedTurn key={turn.index} turn={turn} shared={shared} />
				))}
			</div>
		</Shell>
	);
}

export const ROUND2 = [
	{ id: "unfold", name: "Unfold in place", descriptor: "One quiet line between prompt and reply; it opens into every step right there.", render: (shared: Shared) => <UnfoldInPlace shared={shared} /> },
	{ id: "trace-panel", name: "Trace panel", descriptor: "The chat stays put; Show the work opens that prompt's steps, changes and checks in a panel beside it.", render: (shared: Shared) => <TracePanel shared={shared} /> },
	{ id: "timeline", name: "Timeline strip", descriptor: "A clean strip of steps under each prompt; pick a step to read it, or list them all.", render: (shared: Shared) => <TimelineStrips shared={shared} /> },
	{ id: "detail-level", name: "Detail level", descriptor: "One control for the whole transcript: Conversation, Steps, or Everything.", render: (shared: Shared) => <DetailLevel shared={shared} /> },
	{ id: "answer-tabs", name: "Answer tabs", descriptor: "Each reply has tabs for its Steps, Changes and Checks.", render: (shared: Shared) => <AnswerTabs shared={shared} /> },
];
