/// <reference lib="dom" />
// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Small pieces the five trace viewer variants share.
import * as React from "react";

import type { DiffLine, FileDiff, Item, Level, ToolItem } from "./trace-grill-model";

export const LEVEL_NAME: Record<Level, string> = { full: "Full", conversation: "Conversation", summary: "Summary", hidden: "Hidden" };

// Plain-text renderer for agent text: paragraphs, "- " lists, **bold** and
// `code`. Builds React nodes only; nothing from the trace is parsed as HTML.
function inline(text: string, key: string): React.ReactNode[] {
	const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
	return parts.map((part, index) => {
		if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong>;
		if (part.startsWith("`") && part.endsWith("`")) return <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>;
		return <React.Fragment key={`${key}-${index}`}>{part}</React.Fragment>;
	});
}

export function Md({ text, className = "" }: { text: string; className?: string }) {
	const blocks: React.ReactNode[] = [];
	let list: string[] = [];
	const flush = () => {
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
	let para: string[] = [];
	const flushPara = () => {
		if (!para.length) return;
		const lines = para;
		para = [];
		blocks.push(<p key={`p${blocks.length}`}>{lines.flatMap((line, index) => [index ? <br key={`b${index}`} /> : null, ...inline(line, `p${blocks.length}-${index}`)])}</p>);
	};
	for (const line of text.split("\n")) {
		if (/^\s*[-•]\s+/.test(line)) {
			flushPara();
			list.push(line.replace(/^\s*[-•]\s+/, ""));
		} else if (!line.trim()) {
			flushPara();
			flush();
		} else {
			flush();
			para.push(line);
		}
	}
	flushPara();
	flush();
	return <div className={`tg-md ${className}`}>{blocks}</div>;
}

export function DiffView({ diff, compact = false }: { diff: FileDiff; compact?: boolean }) {
	let lines: DiffLine[] = diff.lines;
	if (compact && lines.length > 14) lines = [...lines.slice(0, 12), { type: "ctx", text: `… ${lines.length - 12} more lines` }];
	return (
		<div className="tg-diff" role="table" aria-label={`Changes to ${diff.path}`}>
			{lines.map((line, index) => (
				<div key={index} role="row" className={`tg-diff-line tg-diff-${line.type}`}>
					<span className="tg-diff-sign" aria-hidden="true">
						{line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
					</span>
					<span className="tg-diff-text">{line.text || " "}</span>
				</div>
			))}
		</div>
	);
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="tg-diffstat" aria-label={`${added} lines added, ${removed} removed`}>
			{added ? <span className="tg-add">+{added}</span> : null}
			{removed ? <span className="tg-del">−{removed}</span> : null}
		</span>
	);
}

export function ToolBody({ tool, level, showInput = true }: { tool: ToolItem; level: Level; showInput?: boolean }) {
	const input = tool.input;
	return (
		<div className="tg-toolbody">
			{tool.diff ? <DiffView diff={tool.diff} /> : null}
			{!tool.diff && showInput && input ? (
				typeof input.command === "string" ? (
					<pre className="tg-code tg-command">$ {input.command}</pre>
				) : typeof input.code === "string" ? (
					<pre className="tg-code">{input.code}</pre>
				) : typeof input.prompt === "string" ? (
					<p className="tg-subprompt">{input.prompt}</p>
				) : (
					<pre className="tg-code">{JSON.stringify(input, null, 2)}</pre>
				)
			) : null}
			{!input && level !== "full" ? <p className="tg-hidden-note">Tool input is hidden at {LEVEL_NAME[level]}.</p> : null}
			{tool.resultText !== undefined && !tool.diff ? <pre className={`tg-code tg-result${tool.error ? " tg-result-error" : ""}`}>{tool.resultText || "(no output)"}</pre> : null}
			{tool.resultText !== undefined && tool.diff && tool.error ? <pre className="tg-code tg-result tg-result-error">{tool.resultText}</pre> : null}
			{tool.resultHidden ? <p className="tg-hidden-note">Output hidden at {LEVEL_NAME[level]}.</p> : null}
		</div>
	);
}

export const FAMILY_GLYPH: Record<ToolItem["family"], string> = {
	read: "R",
	search: "S",
	edit: "E",
	shell: "$",
	agent: "A",
	plan: "P",
	web: "W",
	mcp: "M",
	other: "·",
};

export function itemText(item: Item) {
	if (item.type === "tool") return `${item.display} ${item.label}`;
	return item.text;
}

export function words(text: string) {
	return text.trim() ? text.trim().split(/\s+/).length : 0;
}
