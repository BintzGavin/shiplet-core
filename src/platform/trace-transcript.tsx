/// <reference lib="dom" />
// The trace viewer (docs/traces-spec.md D15, docs/trace-viewer-design.md): a
// chat transcript. Each prompt shows the agent's final reply; the work behind
// it sits in Steps, Changes and Checks tabs on that reply. Trace text renders
// as plain text or simple markdown built from React nodes; no HTML from a
// trace is ever interpreted.
import * as React from "react";

import { harnessLabel, type TraceEvent, type TraceManifest } from "../cli/trace-core.mjs";
import {
	buildModel,
	failedOf,
	offset,
	span,
	stepsOf,
	toolsOf,
	workOf,
	type Item,
	type Level,
	type Model,
	type ToolItem,
	type Turn,
} from "./trace-transcript-model";

export const LEVEL_NAME: Record<Level, string> = { full: "Full", conversation: "Conversation", summary: "Summary", hidden: "Hidden" };

// What each level keeps and leaves out, in reader terms.
export const LEVEL_SEES: Record<Level, { keeps: string[]; leaves: string[] }> = {
	full: { keeps: ["prompts and replies", "every step with its output", "diffs", "reasoning"], leaves: [] },
	conversation: {
		keeps: ["prompts and replies", "every step the agent took", "which checks passed or failed"],
		leaves: ["tool output", "diffs", "reasoning", "errors from steps that aren't checks"],
	},
	summary: { keeps: ["what was done", "files touched", "checks and the outcome"], leaves: ["the conversation itself"] },
	hidden: { keeps: [], leaves: ["everything"] },
};

// Redaction rules write reasons such as "tool output hidden"; anything else is
// the agent's own reason for leaving something out (open format, D20).
export function omittedText(reason: string | undefined) {
	if (!reason) return "Hidden at your level.";
	if (/\bhidden$/.test(reason)) return `${reason[0].toUpperCase()}${reason.slice(1)} at your level.`;
	return `Left out by the agent: ${reason}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatDuration(seconds: number | null | undefined) {
	if (seconds === null || seconds === undefined) return "";
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const OUTCOME = {
	"last-check-passed": { text: "Checks passed", tone: "ok" },
	"last-check-failed": { text: "Checks failed", tone: "err" },
	"no-checks-run": { text: "No checks run", tone: "none" },
} as const;

// ---------------------------------------------------------------------------
// Icons (Lucide paths, inlined)

const PATHS = {
	chevron: <path d="m6 9 6 6 6-6" />,
	check: <path d="M20 6 9 17l-5-5" />,
	copy: (
		<>
			<rect width="14" height="14" x="8" y="8" rx="2" />
			<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
		</>
	),
	arrowDown: (
		<>
			<path d="M12 5v14" />
			<path d="m19 12-7 7-7-7" />
		</>
	),
	ok: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="m9 12 2 2 4-4" />
		</>
	),
	err: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="m15 9-6 6" />
			<path d="m9 9 6 6" />
		</>
	),
	circle: <circle cx="12" cy="12" r="10" />,
	search: (
		<>
			<circle cx="11" cy="11" r="8" />
			<path d="m21 21-4.3-4.3" />
		</>
	),
	file: (
		<>
			<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
			<path d="M14 2v4a2 2 0 0 0 2 2h4" />
		</>
	),
	terminal: (
		<>
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" x2="20" y1="19" y2="19" />
		</>
	),
	pencil: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
	wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
	bulb: (
		<>
			<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
			<path d="M9 18h6" />
			<path d="M10 22h4" />
		</>
	),
	eyeOff: (
		<>
			<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
			<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
			<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
			<line x1="2" x2="22" y1="2" y2="22" />
		</>
	),
	bot: (
		<>
			<path d="M12 8V4H8" />
			<rect width="16" height="12" x="4" y="8" rx="2" />
			<path d="M2 14h2" />
			<path d="M20 14h2" />
			<path d="M15 13v2" />
			<path d="M9 13v2" />
		</>
	),
	list: (
		<>
			<rect x="3" y="5" width="6" height="6" rx="1" />
			<path d="m3 17 2 2 4-4" />
			<path d="M13 6h8" />
			<path d="M13 12h8" />
			<path d="M13 18h8" />
		</>
	),
	globe: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
			<path d="M2 12h20" />
		</>
	),
	plug: (
		<>
			<path d="M12 22v-5" />
			<path d="M9 8V2" />
			<path d="M15 8V2" />
			<path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
		</>
	),
	share: (
		<>
			<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
			<polyline points="16 6 12 2 8 6" />
			<line x1="12" x2="12" y1="2" y2="15" />
		</>
	),
	info: (
		<>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 16v-4" />
			<path d="M12 8h.01" />
		</>
	),
	x: (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	),
} satisfies Record<string, React.ReactNode>;

type IconName = keyof typeof PATHS;

function Icon({ name, size = 16, className = "" }: { name: IconName; size?: number; className?: string }) {
	return (
		<svg className={`tt-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{PATHS[name]}
		</svg>
	);
}

const FAMILY_ICON: Record<ToolItem["family"], IconName> = {
	read: "file",
	search: "search",
	edit: "pencil",
	shell: "terminal",
	agent: "bot",
	plan: "list",
	web: "globe",
	mcp: "plug",
	other: "wrench",
};

// ---------------------------------------------------------------------------
// Text

// Paragraphs, "- " lists, **bold** and `code`, as React nodes only.
function inline(text: string, key: string): React.ReactNode[] {
	return text
		.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
		.filter(Boolean)
		.map((part, index) => {
			if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong>;
			if (part.startsWith("`") && part.endsWith("`")) return <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>;
			return <React.Fragment key={`${key}-${index}`}>{part}</React.Fragment>;
		});
}

function Md({ text }: { text: string }) {
	const blocks: React.ReactNode[] = [];
	let list: string[] = [];
	let para: string[] = [];
	const flushList = () => {
		if (!list.length) return;
		const items = list;
		list = [];
		blocks.push(
			<ul key={`l${blocks.length}`}>
				{items.map((item, index) => (
					<li key={index}>{inline(item, `li${blocks.length}-${index}`)}</li>
				))}
			</ul>,
		);
	};
	const flushPara = () => {
		if (!para.length) return;
		const lines = para;
		para = [];
		blocks.push(<p key={`p${blocks.length}`}>{lines.flatMap((line, index) => [index ? <br key={`b${index}`} /> : null, ...inline(line, `p${blocks.length}-${index}`)])}</p>);
	};
	for (const line of text.split("\n")) {
		if (/^\s*[-•*]\s+/.test(line)) {
			flushPara();
			list.push(line.replace(/^\s*[-•*]\s+/, ""));
		} else if (!line.trim()) {
			flushPara();
			flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return <div className="tt-md">{blocks}</div>;
}

export function stepPhrase(tool: ToolItem) {
	const file = tool.path ? tool.path.split("/").pop() : "";
	switch (tool.family) {
		case "read":
			return `Read ${file || tool.label}`;
		case "search":
			return tool.name === "Glob" ? `Listed ${tool.label}` : `Searched for ${tool.label}`;
		case "edit":
			return tool.diff?.isNew || tool.name === "Write" ? `Created ${file || tool.label}` : `Edited ${file || tool.label}`;
		case "shell":
			return `Ran ${tool.label}`;
		case "agent":
			return `${tool.sub?.kind || "Subagent"}: ${tool.label}`;
		case "plan":
			return tool.label.startsWith("Plan:") ? `Updated the plan (${tool.label.slice(6).split(" · ")[0]})` : "Updated the plan";
		case "web":
			return `Fetched ${tool.label}`;
		case "mcp": {
			const server = tool.display.split(" · ")[0];
			return `${server.charAt(0).toUpperCase()}${server.slice(1)}: ${tool.label}`;
		}
		default:
			return `${tool.display} ${tool.label}`;
	}
}

// ---------------------------------------------------------------------------
// Shared pieces

type Ctx = {
	level: Level;
	startMs: number | null;
	sessionLabel: string;
	media: (ids: string[]) => React.ReactNode;
};

function CopyIconButton({ text, label }: { text: string; label: string }) {
	const [done, setDone] = React.useState(false);
	return (
		<button
			type="button"
			className="tt-iconbtn"
			aria-label={done ? "Copied" : label}
			title={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setDone(true);
					setTimeout(() => setDone(false), 2000);
				} catch {
					window.prompt("Copy this:", text);
				}
			}}
		>
			<Icon name={done ? "check" : "copy"} size={14} />
		</button>
	);
}

function CodeBlock({ title, text, diff }: { title?: string; text?: string; diff?: ToolItem["diff"] }) {
	const raw = diff ? diff.lines.map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "} ${line.text}`).join("\n") : text || "";
	return (
		<div className="tt-code">
			{title ? (
				<div className="tt-code-head">
					<span className="tt-code-title">
						<Icon name={diff ? "pencil" : "file"} size={14} />
						<span>{title}</span>
						{diff ? <DiffStat added={diff.added} removed={diff.removed} /> : null}
					</span>
					<CopyIconButton text={raw} label="Copy" />
				</div>
			) : null}
			<pre className={`tt-code-body${diff ? " is-diff" : ""}`}>
				{diff
					? diff.lines.map((line, index) => (
							<div key={index} className={`tt-line tt-line-${line.type}`}>
								<span className="tt-sign" aria-hidden="true">
									{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
								</span>
								{line.text || " "}
							</div>
						))
					: raw}
			</pre>
		</div>
	);
}

function DiffStat({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="tt-diffstat" aria-label={`${added} lines added, ${removed} removed`}>
			{added ? <span className="tt-add">+{added}</span> : null}
			{removed ? <span className="tt-del">−{removed}</span> : null}
		</span>
	);
}

function HiddenNote({ children }: { children: React.ReactNode }) {
	return (
		<p className="tt-hidden">
			<Icon name="eyeOff" size={14} /> {children}
		</p>
	);
}

// ---------------------------------------------------------------------------
// Messages

function UserMessage({ item, ctx }: { item: Extract<Item, { type: "prompt" }>; ctx: Ctx }) {
	return (
		<div className="tt-msg tt-msg-user" id={`tt-ev-${item.id}`}>
			<div className="tt-bubble">
				<Md text={item.text} />
				{ctx.media(item.attachmentIds)}
			</div>
		</div>
	);
}

function AgentReply({ item, ctx, final }: { item: Extract<Item, { type: "reply" }>; ctx: Ctx; final: boolean }) {
	return (
		<div className="tt-msg tt-msg-agent" id={`tt-ev-${item.id}`}>
			<Md text={item.text} />
			{ctx.media(item.attachmentIds)}
			{final ? (
				<div className="tt-msgactions">
					<CopyIconButton text={item.text} label="Copy reply" />
					{offset(item.t, ctx.startMs) ? <span className="tt-msgtime">{offset(item.t, ctx.startMs)}</span> : null}
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Steps

export type StepFocus = { id: string; n: number } | null;

function StepBody({ tool, ctx }: { tool: ToolItem; ctx: Ctx }) {
	if (tool.sub) return <StepList items={tool.sub.items} ctx={ctx} nested />;
	if (tool.diff && !tool.error) return <CodeBlock title={tool.diff.path} diff={tool.diff} />;
	return (
		<>
			{typeof tool.input?.command === "string" ? <CodeBlock text={`$ ${tool.input.command}`} /> : null}
			{tool.resultText !== undefined ? <pre className={`tt-output${tool.error ? " is-error" : ""}`}>{tool.resultText || "(no output)"}</pre> : null}
			{tool.resultHidden && ctx.level === "full" ? <HiddenNote>Output hidden by a sharing rule.</HiddenNote> : null}
			{ctx.media(tool.attachmentIds)}
		</>
	);
}

function StepRow({ tool, ctx, focus, active }: { tool: ToolItem; ctx: Ctx; focus?: StepFocus; active?: boolean }) {
	const [open, setOpen] = React.useState(false);
	const ref = React.useRef<HTMLLIElement>(null);
	const failed = failedOf(tool);
	// Below Full the header already says output is left out, so a row whose only
	// content would be "Output hidden" neither expands nor carries an icon.
	const markHidden = tool.resultHidden && ctx.level === "full";
	const expandable = Boolean(tool.sub || tool.diff || typeof tool.input?.command === "string" || tool.resultText !== undefined || markHidden || tool.attachmentIds.length);
	const focusN = focus && focus.id === tool.id ? focus.n : 0;
	React.useEffect(() => {
		const node = ref.current;
		if (!focusN || !node) return;
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		window.scrollTo({ top: node.getBoundingClientRect().top + window.scrollY - 96, behavior: reduce ? "auto" : "smooth" });
		node.classList.remove("is-focus");
		void node.offsetWidth;
		node.classList.add("is-focus");
	}, [focusN]);
	return (
		<li ref={ref} className={`tt-step${failed ? " is-error" : ""}${active ? " is-active" : ""}`} id={`tt-ev-${tool.id}`}>
			<span className="tt-step-icon">
				<Icon name={failed ? "err" : FAMILY_ICON[tool.family]} size={14} />
			</span>
			<div className="tt-step-main">
				<button type="button" className="tt-step-line" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen(!open)}>
					<span className="tt-step-text" title={stepPhrase(tool)}>
						{stepPhrase(tool)}
					</span>
					{tool.diff ? <DiffStat added={tool.diff.added} removed={tool.diff.removed} /> : null}
					{tool.check && !failed && tool.check.ok ? <span className="tt-badge">passed</span> : null}
					{failed ? <span className="tt-badge tt-badge-err">failed</span> : null}
					{tool.sub ? <span className="tt-step-count">{plural(tool.sub.toolCount, "step")}</span> : null}
					{markHidden ? (
						<span className="tt-step-hidden" title={`Output hidden at ${LEVEL_NAME[ctx.level]}`}>
							<Icon name="eyeOff" size={12} />
						</span>
					) : null}
				</button>
				{tool.sub && !open && tool.sub.finalText ? <p className="tt-step-desc">{tool.sub.finalText.split("\n")[0]}</p> : null}
				{open ? <StepBody tool={tool} ctx={ctx} /> : null}
			</div>
		</li>
	);
}

function StepList({ items, ctx, nested = false, focus, activeId }: { items: Item[]; ctx: Ctx; nested?: boolean; focus?: StepFocus; activeId?: string | null }) {
	return (
		<ol className={`tt-steps${nested ? " is-nested" : ""}`}>
			{items.map((item) => {
				switch (item.type) {
					case "tool":
						return <StepRow key={item.id} tool={item} ctx={ctx} focus={focus} active={activeId === item.id} />;
					case "reasoning":
						// Below Full, hidden reasoning is said once in the header, not per row.
						if (item.hidden && ctx.level !== "full") return null;
						return (
							<li key={item.id} className="tt-step tt-step-thought" id={`tt-ev-${item.id}`}>
								<span className="tt-step-icon">
									<Icon name={item.hidden ? "eyeOff" : "bulb"} size={14} />
								</span>
								<div className="tt-step-main">
									<p className="tt-step-thoughttext">{item.hidden ? "Reasoning hidden by a sharing rule" : item.text}</p>
								</div>
							</li>
						);
					case "reply":
						return (
							<li key={item.id} className="tt-step tt-step-say" id={`tt-ev-${item.id}`}>
								<span className="tt-step-icon">
									<Icon name="bot" size={14} />
								</span>
								<div className="tt-step-main">
									<Md text={item.text} />
									{ctx.media(item.attachmentIds)}
								</div>
							</li>
						);
					case "prompt":
						return null;
					default:
						return (
							<li key={item.id} className="tt-step tt-step-thought" id={`tt-ev-${item.id}`}>
								<span className="tt-step-icon">
									<Icon name={item.type === "omitted" ? "eyeOff" : "circle"} size={14} />
								</span>
								<div className="tt-step-main">
									<p className="tt-step-thoughttext">{item.type === "omitted" ? omittedText(item.text) : item.text}</p>
									{ctx.media(item.attachmentIds)}
								</div>
							</li>
						);
				}
			})}
		</ol>
	);
}

// The activity bar: one row of segments, each as wide as the time that step
// took (until the next step began); subagents are named pills.
function barWeights(turn: Turn, steps: ToolItem[]) {
	const end = turn.end ? Date.parse(turn.end) : null;
	const raw = steps.map((tool, index) => {
		const from = tool.t ? Date.parse(tool.t) : null;
		const nextT = steps[index + 1]?.t;
		const to = nextT ? Date.parse(nextT) : end;
		return from !== null && to !== null ? Math.max(0, to - from) : 0;
	});
	const total = raw.reduce((a, b) => a + b, 0) || 1;
	// Never thinner than 0.6% of the bar, so every step stays clickable; a
	// subagent keeps room for its name.
	return raw.map((ms, index) => Math.max(steps[index].sub ? 9 : 0.6, (ms / total) * 100));
}

function toneOf(tool: ToolItem) {
	if (tool.sub) return tool.sub.errors ? "sub is-sub-err" : "sub";
	if (failedOf(tool)) return "err";
	if (tool.check) return tool.check.ok ? "ok" : "unknown";
	return tool.family === "edit" ? "edit" : "plain";
}

function ActivityBar({ turn, ctx, activeId, onPick }: { turn: Turn; ctx: Ctx; activeId: string | null; onPick: (tool: ToolItem) => void }) {
	const steps = stepsOf(turn);
	const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
	const [focusIndex, setFocusIndex] = React.useState(0);
	const weights = barWeights(turn, steps);
	const onKey = (event: React.KeyboardEvent) => {
		const moves: Record<string, number> = { ArrowRight: focusIndex + 1, ArrowLeft: focusIndex - 1, Home: 0, End: steps.length - 1 };
		if (!(event.key in moves)) return;
		event.preventDefault();
		const next = Math.min(steps.length - 1, Math.max(0, moves[event.key]));
		setFocusIndex(next);
		refs.current[next]?.focus();
	};
	return (
		<div className="tt-bar" role="listbox" aria-label={`Steps for prompt ${turn.index + 1}`} aria-orientation="horizontal" onKeyDown={onKey}>
			{steps.map((tool, index) => {
				const at = offset(tool.t, ctx.startMs);
				const label = `${stepPhrase(tool)}${failedOf(tool) ? " (failed)" : tool.check?.ok ? " (passed)" : ""}${at ? `, at ${at}` : ""}`;
				return (
					<button
						key={tool.id}
						ref={(node) => {
							refs.current[index] = node;
						}}
						type="button"
						role="option"
						aria-selected={activeId === tool.id}
						aria-label={label}
						title={label}
						tabIndex={index === focusIndex ? 0 : -1}
						className={`tt-mark tt-mark-${toneOf(tool)}${activeId === tool.id ? " is-on" : ""}`}
						style={{ flexGrow: weights[index], flexBasis: 0, minWidth: tool.sub ? `${Math.min((tool.sub.kind || tool.label).length, 14) * 6 + 18}px` : undefined }}
						onFocus={() => setFocusIndex(index)}
						onClick={() => onPick(tool)}
					>
						<span className="tt-pip" aria-hidden="true" />
						{tool.sub ? <span className="tt-sub-label">{tool.sub.kind || tool.label}</span> : null}
					</button>
				);
			})}
		</div>
	);
}

function StepsPanel({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
	const steps = stepsOf(turn);
	const [activeId, setActiveId] = React.useState<string | null>(steps[0]?.id ?? null);
	const [focus, setFocus] = React.useState<StepFocus>(null);
	const barRef = React.useRef<HTMLDivElement>(null);
	// Light the step being read: the last one whose top has passed the bar.
	React.useEffect(() => {
		let frame = 0;
		const rows = steps.map((tool) => document.getElementById(`tt-ev-${tool.id}`));
		// Rows are in document order, so the last one above the reading line is
		// found by binary search: a few layout reads per frame, not one per step.
		const update = () => {
			frame = 0;
			const line = (barRef.current?.getBoundingClientRect().bottom ?? 0) + 24;
			let low = 0;
			let high = rows.length - 1;
			let found = 0;
			while (low <= high) {
				const mid = (low + high) >> 1;
				const top = rows[mid]?.getBoundingClientRect().top ?? Infinity;
				if (top <= line) {
					found = mid;
					low = mid + 1;
				} else high = mid - 1;
			}
			setActiveId(steps[found]?.id ?? null);
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
	const failed = toolsOf(workOf(turn)).filter(failedOf).length;
	const active = steps.findIndex((tool) => tool.id === activeId);
	return (
		<div className="tt-stepspanel">
			<div className="tt-barwrap" ref={barRef}>
				<ActivityBar turn={turn} ctx={ctx} activeId={activeId} onPick={(tool) => setFocus((prev) => ({ id: tool.id, n: (prev?.n || 0) + 1 }))} />
				<div className="tt-barmeta">
					<span>{active >= 0 ? `Step ${active + 1} of ${steps.length}` : ""}</span>
					<span>
						{span(turn.start, turn.end)}
						{failed ? ` · ${failed} failed` : ""}
					</span>
				</div>
			</div>
			<StepList items={workOf(turn)} ctx={ctx} focus={focus} activeId={activeId} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Changes and checks

function ChangesPanel({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
	const edits = toolsOf(workOf(turn)).filter((tool) => tool.family === "edit" && tool.path && !tool.error);
	if (!edits.length) return <p className="tt-empty">No files changed for this prompt.</p>;
	if (ctx.level !== "full" || edits.every((edit) => !edit.diff)) {
		const files = [...new Set(edits.map((edit) => edit.path!))];
		return (
			<div className="tt-stack">
				{ctx.level !== "full" ? <HiddenNote>Diffs are hidden at {LEVEL_NAME[ctx.level]}. These files changed:</HiddenNote> : null}
				<ul className="tt-files">
					{files.map((file) => (
						<li key={file} className="tt-filechip">
							<Icon name="file" size={12} />
							{file}
						</li>
					))}
				</ul>
			</div>
		);
	}
	return (
		<div className="tt-stack">
			{edits.map((edit) =>
				edit.diff ? (
					<CodeBlock key={edit.id} title={edit.diff.path} diff={edit.diff} />
				) : (
					<span key={edit.id} className="tt-filechip">
						<Icon name="file" size={12} />
						{edit.path}
					</span>
				),
			)}
		</div>
	);
}

function CheckRow({ tool, ctx }: { tool: ToolItem; ctx: Ctx }) {
	const [open, setOpen] = React.useState(false);
	const ok = tool.check?.ok;
	const tone = ok === null || ok === undefined ? "unknown" : ok && !tool.error ? "ok" : "err";
	return (
		<li className="tt-check">
			<button type="button" className="tt-check-line" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className={`tt-check-icon tt-check-${tone}`}>
					<Icon name={tone === "unknown" ? "circle" : tone === "ok" ? "ok" : "err"} size={14} />
				</span>
				<code title={tool.check?.command}>{tool.check?.command.split("\n")[0]}</code>
				<span className="tt-muted">{tone === "unknown" ? "result not shared" : tone === "ok" ? "passed" : "failed"}</span>
				<Icon name="chevron" className={open ? "is-open" : ""} />
			</button>
			{open ? (
				tool.resultText !== undefined ? (
					<pre className={`tt-output${tool.error ? " is-error" : ""}`}>{tool.resultText || "(no output)"}</pre>
				) : (
					<HiddenNote>Output hidden at {LEVEL_NAME[ctx.level]}.</HiddenNote>
				)
			) : null}
		</li>
	);
}

function ChecksPanel({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
	const checks = toolsOf(workOf(turn)).filter((tool) => tool.check);
	if (!checks.length) return <p className="tt-empty">No tests, lint or builds ran for this prompt.</p>;
	return (
		<ol className="tt-checks">
			{checks.map((tool) => (
				<CheckRow key={tool.id} tool={tool} ctx={ctx} />
			))}
		</ol>
	);
}

// ---------------------------------------------------------------------------
// A turn: the prompt, then the final reply with its tabs

type Tab = "answer" | "steps" | "changes" | "checks";
const TABS: Tab[] = ["answer", "steps", "changes", "checks"];

function ReplyTabs({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
	const [tab, setTab] = React.useState<Tab>("answer");
	const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
	const all = toolsOf(workOf(turn));
	const failed = all.filter(failedOf).length;
	const files = new Set(all.filter((tool) => tool.family === "edit" && tool.path && !tool.error).map((tool) => tool.path)).size;
	const labels: Record<Tab, string> = {
		answer: "Answer",
		steps: `Steps · ${stepsOf(turn).length}`,
		changes: `Changes · ${files}`,
		checks: `Checks · ${all.filter((tool) => tool.check).length}`,
	};
	const id = (name: Tab) => `tt-${turn.index}-${name}`;
	const onKey = (event: React.KeyboardEvent) => {
		const at = TABS.indexOf(tab);
		const moves: Record<string, number> = { ArrowRight: (at + 1) % TABS.length, ArrowLeft: (at + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 };
		if (!(event.key in moves)) return;
		event.preventDefault();
		const next = TABS[moves[event.key]];
		setTab(next);
		refs.current[next]?.focus();
	};
	return (
		<div className="tt-tabbed">
			<div className="tt-tabs" role="tablist" aria-label={`Reply to prompt ${turn.index + 1}`} onKeyDown={onKey}>
				{TABS.map((name) => (
					<button
						key={name}
						ref={(node) => {
							refs.current[name] = node;
						}}
						type="button"
						role="tab"
						id={`${id(name)}-tab`}
						aria-selected={tab === name}
						aria-controls={tab === name ? `${id(name)}-panel` : undefined}
						tabIndex={tab === name ? 0 : -1}
						className={`tt-tab${tab === name ? " is-on" : ""}`}
						onClick={() => setTab(name)}
					>
						{labels[name]}
						{name === "steps" && failed ? (
							<span className="tt-tab-err" aria-label={`${failed} failed`}>
								{failed}
							</span>
						) : null}
					</button>
				))}
			</div>
			<div role="tabpanel" id={`${id(tab)}-panel`} aria-labelledby={`${id(tab)}-tab`} className="tt-tabpanel">
				{tab === "answer" ? (
					turn.reply ? (
						<AgentReply item={turn.reply} ctx={ctx} final />
					) : (
						<p className="tt-empty">The agent did not reply to this prompt.</p>
					)
				) : tab === "steps" ? (
					<StepsPanel turn={turn} ctx={ctx} />
				) : tab === "changes" ? (
					<ChangesPanel turn={turn} ctx={ctx} />
				) : (
					<ChecksPanel turn={turn} ctx={ctx} />
				)}
			</div>
		</div>
	);
}

function TurnView({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
	const steps = stepsOf(turn);
	return (
		<section className="tt-turn" aria-label={turn.prompt ? `Prompt ${turn.index + 1}` : "Session start"}>
			{turn.prompt ? <UserMessage item={turn.prompt} ctx={ctx} /> : null}
			{steps.length ? (
				<ReplyTabs turn={turn} ctx={ctx} />
			) : (
				// No tool work: the replies are the whole answer.
				turn.items.map((item) => (item.type === "reply" ? <AgentReply key={item.id} item={item} ctx={ctx} final={item === turn.reply} /> : null))
			)}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Header, summary, sheet, page

function LevelPhrase({ level }: { level: Level }) {
	const [open, setOpen] = React.useState(false);
	const ref = React.useRef<HTMLSpanElement>(null);
	React.useEffect(() => {
		if (!open) return;
		const close = (event: Event) => {
			if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", close);
		document.addEventListener("pointerdown", close);
		return () => {
			document.removeEventListener("keydown", close);
			document.removeEventListener("pointerdown", close);
		};
	}, [open]);
	const sees = LEVEL_SEES[level];
	return (
		<span className="tt-levelphrase" ref={ref}>
			Shared as {LEVEL_NAME[level]}
			<button type="button" className="tt-infobtn" aria-expanded={open} aria-label="What this level leaves out" onClick={() => setOpen(!open)}>
				<Icon name="info" size={14} />
			</button>
			{open ? (
				<span className="tt-popover" role="note">
					<strong>Left out:</strong> {sees.leaves.join(", ")}.
					<br />
					<strong>Kept:</strong> {sees.keeps.join(", ")}.
				</span>
			) : null}
		</span>
	);
}

function Header({ manifest, level, model, embedded, onShare }: { manifest: TraceManifest; level: Level; model: Model; embedded: boolean; onShare: (() => void) | null }) {
	const summary = manifest.summary;
	const fromSteps = new Set(model.turns.flatMap((turn) => toolsOf(turn.items)).filter((tool) => tool.family === "edit" && tool.path && !tool.error).map((tool) => tool.path)).size;
	const files = fromSteps || summary?.filesTouched?.length || 0;
	const outcome = OUTCOME[summary?.outcome || "no-checks-run"] || OUTCOME["no-checks-run"];
	const facts = [formatDuration(summary?.durationSeconds), plural(summary?.promptCount ?? 0, "prompt"), `${plural(files, "file")} ${fromSteps ? "changed" : "touched"}`].filter(Boolean);
	const Title = embedded ? "h2" : "h1";
	return (
		<header className="tt-header">
			<div className="tt-header-main">
				<span className="tt-kind">
					<Icon name="bot" size={14} /> {harnessLabel(manifest.source?.harness)} session
				</span>
				<Title className="tt-title">{manifest.title}</Title>
				<p className="tt-meta">
					{facts.join(" · ")} · <span className={`tt-outcome tt-outcome-${outcome.tone}`}>{outcome.text}</span>
					{level !== "full" ? (
						<>
							{" · "}
							<LevelPhrase level={level} />
						</>
					) : null}
				</p>
			</div>
			{onShare ? (
				<button type="button" className="btn btn-secondary btn-sm tt-sharebtn" onClick={onShare}>
					<Icon name="share" size={14} /> Share
				</button>
			) : null}
		</header>
	);
}

function SummaryOnly({ manifest }: { manifest: TraceManifest }) {
	const summary = manifest.summary;
	return (
		<div className="tt-summaryonly">
			<p>
				{plural(summary?.promptCount ?? 0, "prompt")}, {plural(manifest.counts.toolCalls, "tool call")} and {plural(manifest.counts.errors, "error")}
				{summary?.durationSeconds ? ` over ${formatDuration(summary.durationSeconds)}` : ""}.
			</p>
			{summary?.checks?.length ? (
				<ul className="tt-files">
					{summary.checks.slice(-12).map((check, index) => (
						<li key={index} className={`tt-filechip tt-check-${check.ok ? "ok" : "err"}`}>
							<Icon name={check.ok ? "ok" : "err"} size={12} />
							{check.command.split("\n")[0]}
						</li>
					))}
				</ul>
			) : null}
			{summary?.filesTouched?.length ? (
				<ul className="tt-files">
					{summary.filesTouched.slice(0, 40).map((file) => (
						<li key={file} className="tt-filechip">
							<Icon name="file" size={12} />
							{file}
						</li>
					))}
				</ul>
			) : null}
			<p className="tt-muted">You can see this session's summary only. Ask its owner for a higher level to read the conversation.</p>
		</div>
	);
}

function ShareSheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
	const closeRef = React.useRef<HTMLButtonElement>(null);
	React.useEffect(() => {
		// Focus moves into the sheet, and back to what opened it on close.
		const opener = document.activeElement as HTMLElement | null;
		closeRef.current?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			opener?.focus();
		};
	}, [onClose]);
	return (
		<div className="tt-sheet-backdrop" onClick={onClose}>
			<aside className="tt-sheet" role="dialog" aria-modal="true" aria-label="Who sees what" onClick={(event) => event.stopPropagation()}>
				<button ref={closeRef} type="button" className="tt-iconbtn tt-sheet-close" aria-label="Close" onClick={onClose}>
					<Icon name="x" />
				</button>
				{children}
			</aside>
		</div>
	);
}

function ScrollToEnd() {
	const [show, setShow] = React.useState(false);
	React.useEffect(() => {
		const onScroll = () => setShow(window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 400);
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	if (!show) return null;
	return (
		<button type="button" className="tt-scrollend" aria-label="Scroll to the end" onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}>
			<Icon name="arrowDown" />
		</button>
	);
}

type AttachmentMeta = { sha256: string; mediaType: string; name?: string };

function Media({ attachment, url }: { attachment: AttachmentMeta; url: string }) {
	const name = attachment.name || attachment.mediaType;
	if (attachment.mediaType.startsWith("image/")) {
		return (
			<a href={url} target="_blank" rel="noreferrer" className="tt-media">
				<img src={url} alt={name} loading="lazy" />
			</a>
		);
	}
	if (attachment.mediaType.startsWith("video/")) {
		return (
			<video className="tt-media" src={url} controls preload="metadata">
				<a href={url}>{name}</a>
			</video>
		);
	}
	return (
		<a href={url} target="_blank" rel="noreferrer" className="tt-filechip">
			<Icon name="file" size={12} />
			{name}
		</a>
	);
}

export function TraceTranscript({
	manifest,
	level,
	events,
	complete,
	embedded = false,
	share,
	actions,
	attachmentUrl,
}: {
	manifest: TraceManifest;
	level: Level;
	events: TraceEvent[];
	// True once every page of the session has loaded.
	complete: boolean;
	embedded?: boolean;
	// The sharing controls, for readers who manage the trace.
	share?: React.ReactNode;
	// The buttons that hand the session to an agent.
	actions: React.ReactNode;
	attachmentUrl: (sha256: string) => string;
}) {
	const [sheet, setSheet] = React.useState(false);
	const closeSheet = React.useCallback(() => setSheet(false), []);
	const model = React.useMemo(() => buildModel(events, manifest), [events, manifest]);
	const byId = React.useMemo(() => new Map((manifest.attachments || []).map((attachment) => [attachment.sha256, attachment])), [manifest]);
	const ctx: Ctx = {
		level,
		startMs: model.startMs,
		sessionLabel: harnessLabel(manifest.source?.harness),
		media: (ids) => {
			const found = ids.flatMap((id) => {
				const attachment = byId.get(id);
				return attachment ? [attachment] : [];
			});
			return found.length ? (
				<div className="tt-medialist">
					{found.map((attachment) => (
						<Media key={attachment.sha256} attachment={attachment} url={attachmentUrl(attachment.sha256)} />
					))}
				</div>
			) : null;
		},
	};
	// Attachments no loaded event points at (a file the session produced, say)
	// are listed after the conversation, so none goes missing.
	const unplaced = React.useMemo(() => {
		if (!complete) return [];
		const placed = new Set(events.flatMap((event) => event.attachmentIds || []));
		return (manifest.attachments || []).filter((attachment) => !placed.has(attachment.sha256));
	}, [complete, events, manifest]);
	return (
		<div className={`tt${embedded ? " is-embedded" : ""}`} data-level={level}>
			<Header manifest={manifest} level={level} model={model} embedded={embedded} onShare={share ? () => setSheet(true) : null} />
			{level === "summary" ? (
				<SummaryOnly manifest={manifest} />
			) : (
				<div className="tt-conversation" role="log" aria-busy={!complete}>
					{model.turns.map((turn) => (
						<TurnView key={turn.index} turn={turn} ctx={ctx} />
					))}
					{complete && !model.turns.length ? <p className="tt-empty">This session has no messages to show.</p> : null}
				</div>
			)}
			{level !== "summary" && unplaced.length ? (
				<section className="tt-unplaced" aria-label="Files from this session">
					<h2 className="tt-muted">Files from this session</h2>
					<div className="tt-medialist">
						{unplaced.map((attachment) => (
							<Media key={attachment.sha256} attachment={attachment} url={attachmentUrl(attachment.sha256)} />
						))}
					</div>
				</section>
			) : null}
			<div className="tt-continue">{actions}</div>
			{embedded ? null : <ScrollToEnd />}
			{sheet && share ? <ShareSheet onClose={closeSheet}>{share}</ShareSheet> : null}
		</div>
	);
}
