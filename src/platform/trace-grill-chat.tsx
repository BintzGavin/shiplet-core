/// <reference lib="dom" />
// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Two native chat-transcript variants modelled on Vercel AI Elements
// (Conversation, Message, Reasoning, Tool, Task, Queue, CodeBlock,
// ChainOfThought), drawn with the app's own tokens instead of Tailwind.
import * as React from "react";

import { offset, span, type Item, type Level, type Subagent, type ToolItem, type Turn } from "./trace-grill-model";
import { LEVEL_NAME, Md } from "./trace-grill-parts";
import type { Shared } from "./trace-grill";

// ---------------------------------------------------------------------------
// Icons (lucide shapes, 24px grid, stroke = currentColor)

const PATHS: Record<string, React.ReactNode> = {
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
	x: (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	),
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof PATHS; size?: number; className?: string }) {
	return (
		<svg className={`tc-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{PATHS[name]}
		</svg>
	);
}

export const FAMILY_ICON: Record<ToolItem["family"], keyof typeof PATHS> = {
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
// Shared chat pieces

export function CopyIconButton({ text, label }: { text: string; label: string }) {
	const [done, setDone] = React.useState(false);
	return (
		<button
			type="button"
			className="tc-iconbtn"
			aria-label={label}
			title={label}
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setDone(true);
					setTimeout(() => setDone(false), 2000);
				} catch {
					/* clipboard blocked */
				}
			}}
		>
			<Icon name={done ? "check" : "copy"} size={14} />
		</button>
	);
}

export function CodeBlock({ title, text, diff }: { title?: string; text?: string; diff?: ToolItem["diff"] }) {
	const raw = diff ? diff.lines.map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "} ${line.text}`).join("\n") : text || "";
	return (
		<div className="tc-code">
			{title ? (
				<div className="tc-code-head">
					<span className="tc-code-title">
						<Icon name={diff ? "pencil" : "file"} size={14} />
						<span>{title}</span>
						{diff ? (
							<span className="tc-diffstat">
								{diff.added ? <span className="tc-add">+{diff.added}</span> : null}
								{diff.removed ? <span className="tc-del">−{diff.removed}</span> : null}
							</span>
						) : null}
					</span>
					<CopyIconButton text={raw} label="Copy" />
				</div>
			) : null}
			<pre className="tc-code-body">
				{diff
					? diff.lines.map((line, index) => (
							<div key={index} className={`tc-line tc-line-${line.type}`}>
								<span className="tc-sign" aria-hidden="true">
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

export function statusOf(tool: ToolItem): { label: string; tone: "ok" | "err" | "hidden" | "muted"; icon: keyof typeof PATHS } {
	if (tool.error) return { label: "Error", tone: "err", icon: "err" };
	if (tool.resultHidden) return { label: "Output hidden", tone: "hidden", icon: "eyeOff" };
	if (tool.resultText === undefined) return { label: "No output", tone: "muted", icon: "circle" };
	return { label: "Completed", tone: "ok", icon: "ok" };
}

export function StatusBadge({ tool }: { tool: ToolItem }) {
	const status = statusOf(tool);
	return (
		<span className={`tc-badge tc-badge-${status.tone}`}>
			<Icon name={status.icon} size={12} />
			{status.label}
		</span>
	);
}

export function ReasoningBlock({ item, level, seconds }: { item: Extract<Item, { type: "reasoning" }>; level: Level; seconds: number | null }) {
	const [open, setOpen] = React.useState(false);
	if (item.hidden) {
		return (
			<p className="tc-reasoning-trigger is-static" id={`tg-ev-${item.id}`}>
				<Icon name="eyeOff" />
				<span>Reasoning hidden at {LEVEL_NAME[level]}</span>
			</p>
		);
	}
	return (
		<div className="tc-reasoning" id={`tg-ev-${item.id}`}>
			<button type="button" className="tc-reasoning-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name="bulb" />
				<span>{seconds ? `Thought for ${seconds} second${seconds === 1 ? "" : "s"}` : "Thought for a few seconds"}</span>
				<Icon name="chevron" className={open ? "is-open" : ""} />
			</button>
			{open ? <div className="tc-reasoning-body">{item.text}</div> : null}
		</div>
	);
}

export function TodoQueue({ tool }: { tool: ToolItem }) {
	const todos = Array.isArray(tool.input?.todos) ? (tool.input!.todos as Array<{ content: string; status: string }>) : null;
	if (!todos) return null;
	const done = todos.filter((todo) => todo.status === "completed").length;
	return (
		<div className="tc-queue" id={`tg-ev-${tool.id}`}>
			<div className="tc-queue-head">
				<Icon name="list" size={14} />
				<span>
					Plan · {done} of {todos.length} done
				</span>
			</div>
			<ul>
				{todos.map((todo) => (
					<li key={todo.content} className={`tc-todo tc-todo-${todo.status}`}>
						<span className="tc-todo-dot" aria-hidden="true" />
						<span>{todo.content}</span>
						{todo.status === "in_progress" ? <span className="tc-todo-now">now</span> : null}
					</li>
				))}
			</ul>
		</div>
	);
}

export function stepPhrase(tool: ToolItem) {
	const path = tool.path ? tool.path.split("/").pop() : "";
	switch (tool.family) {
		case "read":
			return `Read ${path || tool.label}`;
		case "search":
			return tool.name === "Glob" ? `Listed ${tool.label}` : `Searched for ${tool.label}`;
		case "edit":
			return tool.diff?.isNew || tool.name === "Write" ? `Created ${path || tool.label}` : `Edited ${path || tool.label}`;
		case "shell":
			return tool.check ? `Ran ${tool.label}` : `Ran ${tool.label}`;
		case "agent":
			return `${tool.sub?.kind || "Subagent"}: ${tool.label}`;
		case "plan":
			return tool.label.startsWith("Plan:") ? `Updated the plan (${tool.label.slice(6).split(" · ")[0]})` : "Updated the plan";
		case "web":
			return `Fetched ${tool.label}`;
		case "mcp":
			return `Shiplet: ${tool.label}`;
		default:
			return `${tool.display} ${tool.label}`;
	}
}

export function reasoningSeconds(items: Item[], index: number) {
	const item = items[index];
	const before = items[index - 1];
	if (!item?.t || !before?.t) return null;
	const seconds = Math.round((Date.parse(item.t) - Date.parse(before.t)) / 1000);
	return seconds > 0 ? seconds : null;
}

export function LevelBanner({ shared }: { shared: Shared }) {
	if (shared.level === "full") return null;
	return (
		<div className="tc-levelbanner" role="note">
			<Icon name="eyeOff" />
			<span>
				{shared.level === "summary"
					? "You can see this session's summary only: what was done, files touched, checks and the outcome."
					: "You're reading the Conversation version. Prompts, replies and every tool step are here; tool output and reasoning are hidden."}
			</span>
		</div>
	);
}

export function ChatTopBar({ shared, onShare }: { shared: Shared; onShare: (() => void) | null }) {
	const { manifest, model } = shared;
	return (
		<header className="tc-topbar">
			<div className="tc-topbar-main">
				<span className="tc-topbar-kind">
					<Icon name="bot" size={14} /> {shared.sessionLabel} session
				</span>
				<h1>{manifest.title}</h1>
				<p className="tc-topbar-meta">
					{shared.duration} · {manifest.summary?.promptCount ?? 0} prompts · {manifest.counts.toolCalls} tool calls · {model.subagents.length} subagents ·{" "}
					<span className={`tc-outcome tc-outcome-${shared.outcome.tone}`}>{shared.outcome.text}</span>
				</p>
			</div>
			<div className="tc-topbar-actions">
				<span className={`tc-levelpill tc-levelpill-${shared.level}`}>{LEVEL_NAME[shared.level]}</span>
				{onShare ? (
					<button type="button" className="btn btn-secondary btn-sm tc-sharebtn" onClick={onShare}>
						<Icon name="share" size={14} /> Share
					</button>
				) : null}
			</div>
		</header>
	);
}

export function ShareSheet({ shared, open, onClose }: { shared: Shared; open: boolean; onClose: () => void }) {
	if (!open || !shared.share) return null;
	return (
		<div className="tc-sheet-backdrop" onClick={onClose}>
			<aside className="tc-sheet" role="dialog" aria-label="Who sees what" onClick={(event) => event.stopPropagation()}>
				<button type="button" className="tc-iconbtn tc-sheet-close" aria-label="Close" onClick={onClose}>
					<Icon name="x" />
				</button>
				{shared.share}
			</aside>
		</div>
	);
}

// The place a chat app keeps its composer: here it hands the session to an agent.
export function ContinueBar({ shared }: { shared: Shared }) {
	return <div className="tc-continue">{shared.actions}</div>;
}

export function ScrollToEnd() {
	const [show, setShow] = React.useState(false);
	React.useEffect(() => {
		const onScroll = () => setShow(window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 400);
		onScroll();
		window.addEventListener("scroll", onScroll, { passive: true });
		return () => window.removeEventListener("scroll", onScroll);
	}, []);
	if (!show) return null;
	return (
		<button type="button" className="tc-scrollend" aria-label="Scroll to the end" onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}>
			<Icon name="arrowDown" />
		</button>
	);
}

export function UserMessage({ item }: { item: Extract<Item, { type: "prompt" }> }) {
	return (
		<div className="tc-msg tc-msg-user" id={`tg-ev-${item.id}`}>
			<div className="tc-bubble">
				<Md text={item.text} />
			</div>
		</div>
	);
}

export function AssistantText({ item, shared, first }: { item: Extract<Item, { type: "reply" }>; shared: Shared; first: boolean }) {
	return (
		<div className={`tc-msg tc-msg-agent${item.final ? " is-final" : ""}`} id={`tg-ev-${item.id}`}>
			{first ? (
				<span className="tc-agentname">
					<Icon name="bot" size={14} /> {shared.sessionLabel}
				</span>
			) : null}
			<Md text={item.text} />
			{item.final ? (
				<div className="tc-msgactions">
					<CopyIconButton text={item.text} label="Copy message" />
					<span className="tc-msgtime">{offset(item.t, shared.model.startMs)}</span>
				</div>
			) : null}
		</div>
	);
}

export function SummaryBlock({ shared }: { shared: Shared }) {
	const files = shared.manifest.summary?.filesTouched || [];
	const checks = shared.manifest.summary?.checks || [];
	return (
		<div className="tc-summaryonly">
			<p>
				{shared.manifest.summary?.promptCount ?? 0} prompts, {shared.manifest.counts.toolCalls} tool calls, {shared.manifest.counts.errors} errors over {shared.duration}.
			</p>
			{checks.length ? (
				<ul className="tc-chips">
					{checks.map((check, index) => (
						<li key={index} className={`tc-badge tc-badge-${check.ok ? "ok" : "err"}`}>
							<Icon name={check.ok ? "ok" : "err"} size={12} />
							{check.command}
						</li>
					))}
				</ul>
			) : null}
			{files.length ? (
				<ul className="tc-chips">
					{files.map((file) => (
						<li key={file} className="tc-filechip">
							<Icon name="file" size={12} />
							{file}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Variant A: AI Elements, as built. Every tool call is a Tool card.

export function ToolCard({ tool, shared }: { tool: ToolItem; shared: Shared }) {
	const [open, setOpen] = React.useState(Boolean(tool.diff && !tool.error));
	if (tool.family === "plan" && tool.input?.todos) return <TodoQueue tool={tool} />;
	if (tool.sub) return <TaskBlock tool={tool} sub={tool.sub} shared={shared} />;
	const input = tool.input;
	return (
		<div className={`tc-tool${tool.error ? " is-error" : ""}`} id={`tg-ev-${tool.id}`}>
			<button type="button" className="tc-tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="tc-tool-name">
					<Icon name={FAMILY_ICON[tool.family]} className="tc-muted" />
					<span className="tc-tool-title">{tool.display}</span>
					<span className="tc-tool-label">{tool.label}</span>
				</span>
				<StatusBadge tool={tool} />
				<Icon name="chevron" className={open ? "is-open" : ""} />
			</button>
			{open ? (
				<div className="tc-tool-body">
					{tool.diff ? (
						<CodeBlock title={tool.diff.path} diff={tool.diff} />
					) : input ? (
						<section>
							<h4 className="tc-tool-h">Parameters</h4>
							<CodeBlock text={typeof input.command === "string" ? `$ ${input.command}` : typeof input.code === "string" ? input.code : JSON.stringify(input, null, 2)} />
						</section>
					) : (
						<p className="tc-hidden">
							<Icon name="eyeOff" size={14} /> Parameters are hidden at {LEVEL_NAME[shared.level]}.
						</p>
					)}
					{tool.resultText !== undefined && !(tool.diff && !tool.error) ? (
						<section>
							<h4 className="tc-tool-h">{tool.error ? "Error" : "Result"}</h4>
							<pre className={`tc-output${tool.error ? " is-error" : ""}`}>{tool.resultText || "(no output)"}</pre>
						</section>
					) : null}
					{tool.resultHidden ? (
						<p className="tc-hidden">
							<Icon name="eyeOff" size={14} /> The result is hidden at {LEVEL_NAME[shared.level]}.
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function TaskBlock({ tool, sub, shared }: { tool: ToolItem; sub: Subagent; shared: Shared }) {
	const [open, setOpen] = React.useState(false);
	const files = [...new Set(sub.items.filter((item): item is ToolItem => item.type === "tool" && Boolean(item.path)).map((item) => item.path!.split("/").pop()!))];
	return (
		<div className="tc-task" id={`tg-ev-${tool.id}`}>
			<button type="button" className="tc-task-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name="search" />
				<span>
					{sub.kind}: {sub.title}
				</span>
				<span className="tc-task-meta">
					{sub.toolCount} steps · {span(sub.start, sub.end)}
					{sub.errors ? ` · ${sub.errors} errors` : ""}
				</span>
				<Icon name="chevron" className={open ? "is-open" : ""} />
			</button>
			{files.length ? (
				<div className="tc-task-files">
					{files.map((file) => (
						<span key={file} className="tc-filechip">
							<Icon name="file" size={12} />
							{file}
						</span>
					))}
				</div>
			) : null}
			{open ? (
				<div className="tc-task-body">
					{sub.items.map((item, index) =>
						item.type === "tool" ? (
							<ToolCard key={item.id} tool={item} shared={shared} />
						) : item.type === "reply" ? (
							<div key={item.id} className="tc-task-reply">
								<Md text={item.text} />
							</div>
						) : item.type === "reasoning" ? (
							<ReasoningBlock key={item.id} item={item} level={shared.level} seconds={reasoningSeconds(sub.items, index)} />
						) : null,
					)}
				</div>
			) : sub.finalText ? (
				<div className="tc-task-result">
					<Md text={sub.finalText} />
				</div>
			) : null}
		</div>
	);
}

export function ChatElements({ shared }: { shared: Shared }) {
	const [sheet, setSheet] = React.useState(false);
	const items = shared.model.items;
	return (
		<div className="tg-v tc tc-elements">
			<ChatTopBar shared={shared} onShare={shared.share ? () => setSheet(true) : null} />
			<LevelBanner shared={shared} />
			<div className="tc-conversation" role="log" aria-label="Session transcript">
				{shared.level === "summary" ? (
					<SummaryBlock shared={shared} />
				) : (
					items.map((item, index) => {
						const previous = items[index - 1];
						if (item.type === "prompt") return <UserMessage key={item.id} item={item} />;
						if (item.type === "reply") return <AssistantText key={item.id} item={item} shared={shared} first={!previous || previous.type === "prompt"} />;
						if (item.type === "reasoning") return <ReasoningBlock key={item.id} item={item} level={shared.level} seconds={reasoningSeconds(items, index)} />;
						if (item.type === "tool") return <ToolCard key={item.id} tool={item} shared={shared} />;
						return (
							<p key={item.id} className="tc-note">
								{item.text}
							</p>
						);
					})
				)}
			</div>
			<ContinueBar shared={shared} />
			<ScrollToEnd />
			<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Variant B: the agent-app pattern. Work between messages folds into one
// "Read 3 files, ran 2 commands" line that opens into a chain of steps.

export type Block = { kind: "item"; item: Item; index: number } | { kind: "work"; items: Item[] };

export function blocksOf(items: Item[]): Block[] {
	const blocks: Block[] = [];
	items.forEach((item, index) => {
		const isWork = item.type === "tool" || item.type === "reasoning" || item.type === "omitted" || item.type === "note";
		const last = blocks[blocks.length - 1];
		if (isWork && last?.kind === "work") last.items.push(item);
		else if (isWork) blocks.push({ kind: "work", items: [item] });
		else blocks.push({ kind: "item", item, index });
	});
	return blocks;
}

export function workSummary(items: Item[]) {
	const tools = items.filter((item): item is ToolItem => item.type === "tool");
	const count = (family: ToolItem["family"]) => tools.filter((tool) => tool.family === family).length;
	const parts: string[] = [];
	const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("#", String(n)));
	if (count("agent")) parts.push(plural(count("agent"), "ran a subagent", "ran # subagents"));
	if (count("read")) parts.push(plural(count("read"), "read a file", "read # files"));
	if (count("search")) parts.push(plural(count("search"), "searched once", "searched # times"));
	if (count("edit")) parts.push(plural(count("edit"), "made an edit", "made # edits"));
	if (count("shell")) parts.push(plural(count("shell"), "ran a command", "ran # commands"));
	if (count("mcp")) parts.push(plural(count("mcp"), "called Shiplet", "called Shiplet # times"));
	if (count("web")) parts.push(plural(count("web"), "fetched a page", "fetched # pages"));
	if (count("plan")) parts.push("updated the plan");
	if (!parts.length && items.some((item) => item.type === "reasoning")) parts.push("thought it through");
	const text = parts.join(", ");
	return text ? text[0].toUpperCase() + text.slice(1) : "Worked";
}

// A strip outside the list can point at one step: `focus` opens it (unless
// open is false) and scrolls it into view; `active` marks the step in view.
export type StepFocus = { id: string; n: number; open: boolean } | null;

function StepRow({ tool, shared, focus, active }: { tool: ToolItem; shared: Shared; focus?: StepFocus; active?: boolean }) {
	const [open, setOpen] = React.useState(false);
	const ref = React.useRef<HTMLLIElement>(null);
	const status = statusOf(tool);
	const expandable = Boolean(tool.diff || tool.input || tool.resultText !== undefined || tool.sub);
	const focusN = focus && focus.id === tool.id ? focus.n : 0;
	React.useEffect(() => {
		if (!focusN || !ref.current) return;
		if (focus?.open && expandable) setOpen(true);
		const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const top = ref.current.getBoundingClientRect().top + window.scrollY - 96;
		window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
		ref.current.classList.remove("is-focus");
		void ref.current.offsetWidth;
		ref.current.classList.add("is-focus");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focusN]);
	return (
		<li ref={ref} className={`tc-step${tool.error ? " is-error" : ""}${active ? " is-active" : ""}`} id={`tg-ev-${tool.id}`}>
			<span className={`tc-step-icon${tool.error ? " is-error" : ""}`}>
				<Icon name={tool.error ? "err" : FAMILY_ICON[tool.family]} size={14} />
			</span>
			<div className="tc-step-main">
				<button type="button" className="tc-step-line" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen(!open)}>
					<span className="tc-step-text">{stepPhrase(tool)}</span>
					{tool.diff ? (
						<span className="tc-diffstat">
							{tool.diff.added ? <span className="tc-add">+{tool.diff.added}</span> : null}
							{tool.diff.removed ? <span className="tc-del">−{tool.diff.removed}</span> : null}
						</span>
					) : null}
					{tool.check && !tool.error && tool.check.ok ? <span className="tc-badge tc-badge-ok">passed</span> : null}
					{tool.error ? <span className="tc-badge tc-badge-err">failed</span> : null}
					{tool.resultHidden && status.tone === "hidden" ? (
						<span className="tc-step-hidden" title={`Output hidden at ${LEVEL_NAME[shared.level]}`}>
							<Icon name="eyeOff" size={12} />
						</span>
					) : null}
				</button>
				{tool.sub && !open ? <p className="tc-step-desc">{tool.sub.finalText?.split("\n")[0]}</p> : null}
				{open ? (
					tool.sub ? (
						<StepList items={tool.sub.items} shared={shared} nested />
					) : tool.diff && !tool.error ? (
						<CodeBlock title={tool.diff.path} diff={tool.diff} />
					) : (
						<>
							{tool.input && typeof tool.input.command === "string" ? <CodeBlock text={`$ ${tool.input.command}`} /> : null}
							{tool.resultText !== undefined ? <pre className={`tc-output${tool.error ? " is-error" : ""}`}>{tool.resultText || "(no output)"}</pre> : null}
							{tool.resultHidden ? (
								<p className="tc-hidden">
									<Icon name="eyeOff" size={14} /> Output hidden at {LEVEL_NAME[shared.level]}.
								</p>
							) : null}
						</>
					)
				) : null}
			</div>
		</li>
	);
}

export function StepList({ items, shared, nested = false, focus, activeId }: { items: Item[]; shared: Shared; nested?: boolean; focus?: StepFocus; activeId?: string | null }) {
	return (
		<ol className={`tc-steps${nested ? " is-nested" : ""}`}>
			{items.map((item, index) => {
				if (item.type === "tool") return <StepRow key={item.id} tool={item} shared={shared} focus={focus} active={activeId === item.id} />;
				if (item.type === "reasoning")
					return (
						<li key={item.id} className="tc-step tc-step-thought" id={`tg-ev-${item.id}`}>
							<span className="tc-step-icon">
								<Icon name={item.hidden ? "eyeOff" : "bulb"} size={14} />
							</span>
							<div className="tc-step-main">
								<p className="tc-step-thoughttext">{item.hidden ? `Reasoning hidden at ${LEVEL_NAME[shared.level]}` : item.text}</p>
							</div>
						</li>
					);
				if (item.type === "reply")
					return (
						<li key={item.id} className="tc-step tc-step-say" id={`tg-ev-${item.id}`}>
							<span className="tc-step-icon">
								<Icon name="bot" size={14} />
							</span>
							<div className="tc-step-main">
								<Md text={item.text} />
							</div>
						</li>
					);
				if (item.type === "prompt") return null;
				return (
					<li key={item.id ?? index} className="tc-step tc-step-thought">
						<span className="tc-step-icon">
							<Icon name="circle" size={14} />
						</span>
						<div className="tc-step-main">{item.text}</div>
					</li>
				);
			})}
		</ol>
	);
}

export function WorkGroup({ items, shared }: { items: Item[]; shared: Shared }) {
	const tools = items.filter((item): item is ToolItem => item.type === "tool");
	const failed = tools.filter((tool) => tool.error).length + tools.reduce((n, tool) => n + (tool.sub?.errors || 0), 0);
	const [open, setOpen] = React.useState(false);
	const first = items.find((item) => item.t)?.t ?? null;
	const last = [...items].reverse().find((item) => item.t)?.t ?? null;
	if (!tools.length && items.every((item) => item.type === "reasoning")) {
		const thought = items[0] as Extract<Item, { type: "reasoning" }>;
		return <ReasoningBlock item={thought} level={shared.level} seconds={reasoningSeconds(shared.model.items, shared.model.items.indexOf(thought))} />;
	}
	return (
		<div className={`tc-work${open ? " is-open" : ""}`}>
			<button type="button" className="tc-work-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span>{workSummary(items)}</span>
				{failed ? <span className="tc-badge tc-badge-err">{failed} failed</span> : null}
				{span(first, last) && span(first, last) !== "0s" ? <span className="tc-work-time">{span(first, last)}</span> : null}
				<Icon name="chevron" className={open ? "is-open" : ""} />
			</button>
			{open ? <StepList items={items} shared={shared} /> : null}
		</div>
	);
}

export function ChatSteps({ shared }: { shared: Shared }) {
	const [sheet, setSheet] = React.useState(false);
	const blocks = React.useMemo(() => blocksOf(shared.model.items), [shared.model]);
	return (
		<div className="tg-v tc tc-stepsvariant">
			<ChatTopBar shared={shared} onShare={shared.share ? () => setSheet(true) : null} />
			<LevelBanner shared={shared} />
			<div className="tc-conversation" role="log" aria-label="Session transcript">
				{shared.level === "summary" ? (
					<SummaryBlock shared={shared} />
				) : (
					blocks.map((block, index) => {
						if (block.kind === "work") return <WorkGroup key={`w${index}`} items={block.items} shared={shared} />;
						const item = block.item;
						const previous = blocks[index - 1];
						if (item.type === "prompt") return <UserMessage key={item.id} item={item} />;
						if (item.type === "reply") return <AssistantText key={item.id} item={item} shared={shared} first={!previous || (previous.kind === "item" && previous.item.type === "prompt")} />;
						return null;
					})
				)}
			</div>
			<ContinueBar shared={shared} />
			<ScrollToEnd />
			<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />
		</div>
	);
}

export type { Turn };
