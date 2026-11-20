/// <reference lib="dom" />
// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Round 3. Locked: a native chat transcript, prompt and final reply by default,
// and each reply carries Answer / Steps / Changes / Checks tabs. Under test:
// where a minimal timeline strip lives and what picking a step does.
import * as React from "react";

import { offset, span, type ToolItem, type Turn } from "./trace-grill-model";
import type { Shared } from "./trace-grill";
import { AssistantText, FAMILY_ICON, Icon, StepList, stepPhrase, type StepFocus } from "./trace-grill-chat";
import { Shell, StepDetail, TurnChanges, TurnChecks, TurnFrame, statsOf, workOf } from "./trace-grill-r2";

type Tab = "answer" | "steps" | "changes" | "checks";

// ---------------------------------------------------------------------------
// Strip

const marksOf = (turn: Turn) => workOf(turn).filter((item): item is ToolItem => item.type === "tool");

function toneOf(tool: ToolItem) {
	if (tool.sub) return tool.sub.errors ? "sub-err" : "sub";
	if (tool.error) return "err";
	if (tool.check) return tool.check.ok === false ? "err" : tool.check.ok ? "ok" : "unknown";
	return tool.family === "edit" ? "edit" : "plain";
}

function labelOf(tool: ToolItem, shared: Shared) {
	const status = tool.error ? " (failed)" : tool.check?.ok ? " (passed)" : "";
	const at = offset(tool.t, shared.model.startMs);
	return `${stepPhrase(tool)}${status}${at ? `, at ${at}` : ""}`;
}

// Time each step held the floor: from its start to the next step's start.
function weightsByTime(turn: Turn, marks: ToolItem[]) {
	const end = turn.end ? Date.parse(turn.end) : null;
	const raw = marks.map((tool, index) => {
		const from = tool.t ? Date.parse(tool.t) : null;
		const nextT = marks[index + 1]?.t;
		const to = nextT ? Date.parse(nextT) : end;
		return from !== null && to !== null ? Math.max(0, to - from) : 0;
	});
	const total = raw.reduce((a, b) => a + b, 0) || 1;
	// Never thinner than 0.6% of the bar, so every step stays clickable.
	return raw.map((ms) => Math.max(0.6, (ms / total) * 100));
}

function Strip({
	turn,
	shared,
	selectedId,
	activeId,
	onPick,
	mode = "dots",
	className = "",
}: {
	turn: Turn;
	shared: Shared;
	selectedId?: string | null;
	activeId?: string | null;
	onPick: (tool: ToolItem) => void;
	mode?: "dots" | "bar";
	className?: string;
}) {
	const marks = marksOf(turn);
	const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
	const [focusIndex, setFocusIndex] = React.useState(0);
	if (!marks.length) return null;
	const onKey = (event: React.KeyboardEvent) => {
		const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -Infinity : event.key === "End" ? Infinity : 0;
		if (!delta) return;
		event.preventDefault();
		event.stopPropagation();
		const next = Math.min(marks.length - 1, Math.max(0, focusIndex + (Number.isFinite(delta) ? delta : delta > 0 ? marks.length : -marks.length)));
		setFocusIndex(next);
		refs.current[next]?.focus();
	};
	const weights =
		mode === "bar"
			? weightsByTime(turn, marks)
			: marks.map((tool) => (tool.sub ? Math.max(3, Math.min(8, tool.sub.toolCount / 2)) : 1));
	return (
		<div className={`r3-strip r3-strip-${mode} ${className}`} role="listbox" aria-label={`Steps for prompt ${turn.index + 1}`} aria-orientation="horizontal" onKeyDown={onKey}>
			{marks.map((tool, index) => {
				const on = selectedId === tool.id || activeId === tool.id;
				const tone = toneOf(tool);
				return (
					<button
						key={tool.id}
						ref={(node) => {
							refs.current[index] = node;
						}}
						type="button"
						role="option"
						aria-selected={selectedId === tool.id}
						aria-label={labelOf(tool, shared)}
						title={labelOf(tool, shared)}
						tabIndex={index === focusIndex ? 0 : -1}
						className={`r3-mark r3-${tone}${tool.sub ? " is-sub" : ""}${on ? " is-on" : ""}`}
						style={{ flexGrow: weights[index], flexBasis: 0 }}
						onFocus={() => setFocusIndex(index)}
						onClick={() => onPick(tool)}
					>
						<span className="r3-pip" aria-hidden="true" />
						{tool.sub && mode === "dots" ? <span className="r3-sub-label">{tool.sub.kind}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Tabs, shared by every variant

function TabRow({ turn, tab, setTab, after }: { turn: Turn; tab: Tab; setTab: (tab: Tab) => void; after?: React.ReactNode }) {
	const stats = statsOf(turn);
	// Count steps the way the strip does: a subagent is one step.
	const tabs = [
		["answer", "Answer"],
		["steps", `Steps · ${marksOf(turn).length}`],
		["changes", `Changes · ${stats.files.length}`],
		["checks", `Checks · ${stats.checks.length}`],
	] as const;
	return (
		<div className={`r3-tabrow${after ? " has-after" : ""}`}>
			<div className="r2-tabs r3-tabs" role="tablist" aria-label="This reply">
				{tabs.map(([id, label]) => (
					<button key={id} type="button" role="tab" aria-selected={tab === id} className={`r2-tab${tab === id ? " is-on" : ""}`} onClick={() => setTab(id)}>
						{label}
						{id === "steps" && stats.errors ? <span className="r2-tab-err">{stats.errors}</span> : null}
					</button>
				))}
			</div>
			{after}
		</div>
	);
}

function TabBody({ turn, shared, tab, steps }: { turn: Turn; shared: Shared; tab: Tab; steps: React.ReactNode }) {
	if (tab === "answer") return turn.reply ? <AssistantText item={turn.reply} shared={shared} first={false} /> : <p className="r2-empty">No reply in this part of the session.</p>;
	if (tab === "steps") return <>{steps}</>;
	if (tab === "changes") return <TurnChanges turn={turn} shared={shared} />;
	return <TurnChecks turn={turn} shared={shared} />;
}

function Transcript({ shared, Turn: TurnView }: { shared: Shared; Turn: (props: { turn: Turn; shared: Shared }) => React.ReactElement }) {
	return (
		<Shell shared={shared}>
			<div className="tc-conversation" role="log">
				{shared.model.turns.map((turn) => (statsOf(turn).steps ? <TurnView key={turn.index} turn={turn} shared={shared} /> : <TurnFrame key={turn.index} turn={turn} shared={shared} />))}
			</div>
		</Shell>
	);
}

// Picking on a strip outside the tabs switches to Steps and opens that step.
function usePickToSteps() {
	const [tab, setTab] = React.useState<Tab>("answer");
	const [focus, setFocus] = React.useState<StepFocus>(null);
	const pick = (tool: ToolItem) => {
		setTab("steps");
		setFocus((prev) => ({ id: tool.id, n: (prev?.n || 0) + 1, open: true }));
	};
	return { tab, setTab, focus, pick };
}

// ---------------------------------------------------------------------------
// 1. Strip above the tabs

function AboveTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const { tab, setTab, focus, pick } = usePickToSteps();
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			reply={
				<div className="r2-tabbed">
					<Strip turn={turn} shared={shared} selectedId={tab === "steps" ? focus?.id : null} onPick={pick} className="r3-above" />
					<TabRow turn={turn} tab={tab} setTab={setTab} />
					<TabBody turn={turn} shared={shared} tab={tab} steps={<StepList items={workOf(turn)} shared={shared} focus={focus} />} />
				</div>
			}
		/>
	);
}

// ---------------------------------------------------------------------------
// 2. Strip in the tab row

function RowTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const { tab, setTab, focus, pick } = usePickToSteps();
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			reply={
				<div className="r2-tabbed">
					<TabRow turn={turn} tab={tab} setTab={setTab} after={<Strip turn={turn} shared={shared} selectedId={tab === "steps" ? focus?.id : null} onPick={pick} className="r3-inrow" />} />
					<TabBody turn={turn} shared={shared} tab={tab} steps={<StepList items={workOf(turn)} shared={shared} focus={focus} />} />
				</div>
			}
		/>
	);
}

// ---------------------------------------------------------------------------
// 3. Activity bar: one thin bar, each step as wide as the time it took

function BarTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const { tab, setTab, focus, pick } = usePickToSteps();
	const stats = statsOf(turn);
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			reply={
				<div className="r2-tabbed">
					<div className="r3-barline">
						<Strip turn={turn} shared={shared} mode="bar" selectedId={tab === "steps" ? focus?.id : null} onPick={pick} />
						{stats.duration ? <span className="r3-bar-time">{stats.duration}</span> : null}
					</div>
					<TabRow turn={turn} tab={tab} setTab={setTab} />
					<TabBody turn={turn} shared={shared} tab={tab} steps={<StepList items={workOf(turn)} shared={shared} focus={focus} />} />
				</div>
			}
		/>
	);
}

// ---------------------------------------------------------------------------
// 4. Steps tab reads one step at a time

function noteBefore(turn: Turn, tool: ToolItem) {
	const work = workOf(turn);
	for (let index = work.indexOf(tool) - 1; index >= 0; index--) {
		const item = work[index];
		if (item.type === "reply") return item.text.split("\n")[0];
		if (item.type === "tool") return null;
	}
	return null;
}

function StepReader({ turn, shared }: { turn: Turn; shared: Shared }) {
	const marks = marksOf(turn);
	const firstFail = marks.findIndex((tool) => tool.error);
	const [index, setIndex] = React.useState(firstFail >= 0 ? firstFail : 0);
	const [list, setList] = React.useState(false);
	const tool = marks[index];
	const note = tool ? noteBefore(turn, tool) : null;
	return (
		<div className="r3-reader">
			<Strip turn={turn} shared={shared} selectedId={list ? null : tool?.id} onPick={(picked) => { setIndex(marks.indexOf(picked)); setList(false); }} />
			<div className="r3-reader-ends" aria-hidden="true">
				<span>{offset(turn.start, shared.model.startMs)}</span>
				<button type="button" className="r2-link" onClick={() => setList(!list)} aria-expanded={list}>
					{list ? "Read one at a time" : "List every step"}
				</button>
				<span>{offset(turn.end, shared.model.startMs)}</span>
			</div>
			{list ? (
				<StepList items={workOf(turn)} shared={shared} />
			) : tool ? (
				<div className="r2-tl-detail r3-reader-card">
					<header>
						<span className={`tc-step-icon${tool.error ? " is-error" : ""}`}>
							<Icon name={tool.error ? "err" : FAMILY_ICON[tool.family]} size={14} />
						</span>
						<strong>{stepPhrase(tool)}</strong>
						<span className="r2-muted">
							Step {index + 1} of {marks.length}
							{offset(tool.t, shared.model.startMs) ? ` · ${offset(tool.t, shared.model.startMs)}` : ""}
						</span>
						<span className="r2-tl-nav">
							<button type="button" className="tc-iconbtn" aria-label="Previous step" disabled={index === 0} onClick={() => setIndex(index - 1)}>
								<Icon name="chevron" className="r2-rot90" />
							</button>
							<button type="button" className="tc-iconbtn" aria-label="Next step" disabled={index === marks.length - 1} onClick={() => setIndex(index + 1)}>
								<Icon name="chevron" className="r2-rotm90" />
							</button>
						</span>
					</header>
					{note ? <p className="r2-tl-note">“{note}”</p> : null}
					<StepDetail tool={tool} shared={shared} />
				</div>
			) : null}
		</div>
	);
}

function ReaderTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const [tab, setTab] = React.useState<Tab>("answer");
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			reply={
				<div className="r2-tabbed">
					<TabRow turn={turn} tab={tab} setTab={setTab} />
					<TabBody turn={turn} shared={shared} tab={tab} steps={<StepReader turn={turn} shared={shared} />} />
				</div>
			}
		/>
	);
}

// ---------------------------------------------------------------------------
// 5. Steps tab with a sticky strip that follows the list

function SyncedSteps({ turn, shared }: { turn: Turn; shared: Shared }) {
	const marks = marksOf(turn);
	const [activeId, setActiveId] = React.useState<string | null>(marks[0]?.id ?? null);
	const [focus, setFocus] = React.useState<StepFocus>(null);
	const stripRef = React.useRef<HTMLDivElement>(null);
	React.useEffect(() => {
		let frame = 0;
		const update = () => {
			frame = 0;
			const line = (stripRef.current?.getBoundingClientRect().bottom ?? 0) + 24;
			let current: string | null = marks[0]?.id ?? null;
			for (const tool of marks) {
				const node = document.getElementById(`tg-ev-${tool.id}`);
				if (node && node.getBoundingClientRect().top <= line) current = tool.id;
			}
			setActiveId(current);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		window.addEventListener("scroll", onScroll, { passive: true });
		update();
		return () => {
			window.removeEventListener("scroll", onScroll);
			if (frame) cancelAnimationFrame(frame);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [turn]);
	const stats = statsOf(turn);
	const active = marks.find((tool) => tool.id === activeId);
	return (
		<div className="r3-sync">
			<div className="r3-sync-bar" ref={stripRef}>
				<Strip turn={turn} shared={shared} activeId={activeId} onPick={(tool) => setFocus((prev) => ({ id: tool.id, n: (prev?.n || 0) + 1, open: false }))} />
				<div className="r3-sync-meta" aria-live="polite">
					<span>{active ? `Step ${marks.indexOf(active) + 1} of ${marks.length}` : ""}</span>
					<span>{span(turn.start, turn.end)}{stats.errors ? ` · ${stats.errors} failed` : ""}</span>
				</div>
			</div>
			<StepList items={workOf(turn)} shared={shared} focus={focus} activeId={activeId} />
		</div>
	);
}

function SyncTurn({ turn, shared }: { turn: Turn; shared: Shared }) {
	const [tab, setTab] = React.useState<Tab>("answer");
	return (
		<TurnFrame
			turn={turn}
			shared={shared}
			reply={
				<div className="r2-tabbed">
					<TabRow turn={turn} tab={tab} setTab={setTab} />
					<TabBody turn={turn} shared={shared} tab={tab} steps={<SyncedSteps turn={turn} shared={shared} />} />
				</div>
			}
		/>
	);
}

export const ROUND3 = [
	{ id: "strip-above", name: "Strip above the tabs", descriptor: "A thin row of dots sits over each reply's tabs; picking a dot opens that step in Steps.", render: (shared: Shared) => <Transcript shared={shared} Turn={AboveTurn} /> },
	{ id: "strip-in-row", name: "Strip in the tab row", descriptor: "The dots share the tab row, to the right of the tabs; picking one opens that step in Steps.", render: (shared: Shared) => <Transcript shared={shared} Turn={RowTurn} /> },
	{ id: "activity-bar", name: "Activity bar", descriptor: "One thin bar over the tabs where each step is as wide as the time it took.", render: (shared: Shared) => <Transcript shared={shared} Turn={BarTurn} /> },
	{ id: "steps-reader", name: "Strip in Steps, one at a time", descriptor: "Answer stays clean; the Steps tab opens on a strip and reads one step at a time, starting at the first failure.", render: (shared: Shared) => <Transcript shared={shared} Turn={ReaderTurn} /> },
	{ id: "steps-follow", name: "Strip in Steps, follows the list", descriptor: "The Steps tab keeps a sticky strip that lights up the step you're reading as you scroll.", render: (shared: Shared) => <Transcript shared={shared} Turn={SyncTurn} /> },
];
