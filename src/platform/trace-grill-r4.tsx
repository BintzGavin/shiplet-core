/// <reference lib="dom" />
// DESIGN GRILL PROTOTYPE (branch-local, remove before production).
// Round 4. Locked: chat transcript (prompt + final reply), Answer / Steps /
// Changes / Checks tabs on each reply, and a sticky activity bar inside the
// Steps tab only. Under test: what the top of the page says about the session
// (the summary's role) and how a reader learns what their share level leaves out.
import * as React from "react";

import { LEVEL_NAME } from "./trace-grill-parts";
import type { Shared } from "./trace-grill";
import { ContinueBar, Icon, ScrollToEnd, ShareSheet, SummaryBlock } from "./trace-grill-chat";
import { TurnFrame, statsOf } from "./trace-grill-r2";
import { SyncTurn, type Tab } from "./trace-grill-r3";

// What each level keeps and leaves out, in reader terms.
const SEES: Record<string, { keeps: string[]; leaves: string[] }> = {
	full: { keeps: ["Prompts and replies", "Every step with its output", "Diffs", "Reasoning"], leaves: [] },
	conversation: { keeps: ["Prompts and replies", "Every step the agent took", "Which checks passed"], leaves: ["Tool output", "Diffs", "Reasoning"] },
	summary: { keeps: ["What was done", "Files touched", "Checks and the outcome"], leaves: ["The conversation itself"] },
	hidden: { keeps: [], leaves: ["Everything"] },
};
const levelLine = (level: string) =>
	level === "full" ? "Full trace: every message, step and output." : `Shared as ${LEVEL_NAME[level as keyof typeof LEVEL_NAME]}: ${SEES[level].leaves.join(", ").toLowerCase()} left out.`;

function facts(shared: Shared) {
	const { model, manifest } = shared;
	const checks = manifest.summary?.checks || [];
	const files = model.files.filter((file) => file.edits.length);
	return {
		prompts: manifest.summary?.promptCount ?? model.turns.filter((turn) => turn.prompt).length,
		files: files.length ? files.map((file) => file.path) : (manifest.summary?.filesTouched || []),
		checks,
		failedChecks: checks.filter((check) => !check.ok).length,
		errors: manifest.counts.errors ?? 0,
		subagents: model.subagents.length,
	};
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Transcript({ shared, locked }: { shared: Shared; locked?: Partial<Record<Tab, string>> }) {
	return (
		<div className="tc-conversation" role="log">
			{shared.model.turns.map((turn) => (statsOf(turn).steps ? <SyncTurn key={turn.index} turn={turn} shared={shared} locked={locked} /> : <TurnFrame key={turn.index} turn={turn} shared={shared} />))}
		</div>
	);
}

function Page({ shared, header, children, sheet }: { shared: Shared; header: React.ReactNode; children?: React.ReactNode; sheet?: React.ReactNode }) {
	return (
		<div className="tg-v tc r2 r4">
			{header}
			{shared.level === "summary" ? <SummaryBlock shared={shared} /> : (children ?? <Transcript shared={shared} />)}
			<ContinueBar shared={shared} />
			<ScrollToEnd />
			{sheet}
		</div>
	);
}

function ShareButton({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" className="btn btn-secondary btn-sm tc-sharebtn" onClick={onClick}>
			<Icon name="share" size={14} /> Share
		</button>
	);
}

function TitleBlock({ shared, meta }: { shared: Shared; meta?: React.ReactNode }) {
	return (
		<div className="tc-topbar-main">
			<span className="tc-topbar-kind">
				<Icon name="bot" size={14} /> {shared.sessionLabel} session
			</span>
			<h1>{shared.manifest.title}</h1>
			{meta}
		</div>
	);
}

// ---------------------------------------------------------------------------
// 1. Quiet header: one meta line; the level is a phrase with an info popover.

function QuietHeader({ shared }: { shared: Shared }) {
	const [sheet, setSheet] = React.useState(false);
	const [info, setInfo] = React.useState(false);
	const f = facts(shared);
	const sees = SEES[shared.level];
	return (
		<Page
			shared={shared}
			header={
				<header className="tc-topbar">
					<TitleBlock
						shared={shared}
						meta={
							<p className="tc-topbar-meta r4-meta">
								{shared.duration} · {plural(f.prompts, "prompt")} · {plural(f.files.length, "file")} changed ·{" "}
								<span className={`tc-outcome tc-outcome-${shared.outcome.tone}`}>{shared.outcome.text}</span>
								{shared.level !== "full" ? (
									<span className="r4-levelphrase">
										{" "}
										· Shared as {LEVEL_NAME[shared.level]}
										<button type="button" className="r4-infobtn" aria-expanded={info} aria-label="What this level leaves out" onClick={() => setInfo(!info)}>
											<Icon name="info" size={14} />
										</button>
										{info ? (
											<span className="r4-popover" role="note">
												<strong>Left out:</strong> {sees.leaves.join(", ").toLowerCase()}.<br />
												<strong>Kept:</strong> {sees.keeps.join(", ").toLowerCase()}.
											</span>
										) : null}
									</span>
								) : null}
							</p>
						}
					/>
					{shared.share ? (
						<div className="tc-topbar-actions">
							<ShareButton onClick={() => setSheet(true)} />
						</div>
					) : null}
				</header>
			}
			sheet={<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />}
		/>
	);
}

// ---------------------------------------------------------------------------
// 2. Outcome card: the summary leads, before the first prompt.

function OutcomeCard({ shared }: { shared: Shared }) {
	const [sheet, setSheet] = React.useState(false);
	const f = facts(shared);
	const lastChecks = f.checks.slice(-3);
	return (
		<Page
			shared={shared}
			header={
				<>
					<header className="tc-topbar r4-noline">
						<TitleBlock shared={shared} meta={<p className="tc-topbar-meta">{shared.duration} · {plural(f.prompts, "prompt")}</p>} />
						{shared.share ? (
							<div className="tc-topbar-actions">
								<ShareButton onClick={() => setSheet(true)} />
							</div>
						) : null}
					</header>
					<section className="r4-card" aria-label="Outcome">
						<div className="r4-card-col">
							<span className="r4-card-k">Outcome</span>
							<span className={`r4-card-v tc-outcome-${shared.outcome.tone}`}>{shared.outcome.text}</span>
							<span className="r2-muted">
								{plural(f.errors, "error")} along the way{f.subagents ? ` · ${plural(f.subagents, "subagent")}` : ""}
							</span>
						</div>
						<div className="r4-card-col">
							<span className="r4-card-k">Changed</span>
							<span className="r4-card-v">{plural(f.files.length, "file")}</span>
							<ul className="r4-mini">
								{f.files.slice(0, 3).map((file) => (
									<li key={file}>
										<Icon name="file" size={12} /> {file}
									</li>
								))}
								{f.files.length > 3 ? <li className="r2-muted">and {f.files.length - 3} more</li> : null}
							</ul>
						</div>
						<div className="r4-card-col">
							<span className="r4-card-k">Checks</span>
							<span className="r4-card-v">
								{plural(f.checks.length, "run")}
								{f.failedChecks ? <span className="r2-muted"> · {f.failedChecks} failed{shared.outcome.tone === "ok" ? ", then fixed" : ""}</span> : null}
							</span>
							<ul className="r4-mini">
								{lastChecks.map((check, index) => (
									<li key={index} className={check.ok ? "r4-ok" : "r4-err"}>
										<Icon name={check.ok ? "ok" : "err"} size={12} /> <code>{check.command.split("\n")[0]}</code>
									</li>
								))}
							</ul>
						</div>
						<p className="r4-card-foot">
							<Icon name={shared.level === "full" ? "users" : "eyeOff"} size={14} /> {levelLine(shared.level)}
						</p>
					</section>
				</>
			}
			sheet={<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />}
		/>
	);
}

// ---------------------------------------------------------------------------
// 3. Level scale: Summary · Conversation · Full, with the reader's place lit.

function LevelScale({ shared }: { shared: Shared }) {
	const [sheet, setSheet] = React.useState(false);
	const order = ["summary", "conversation", "full"] as const;
	const at = order.indexOf(shared.level as (typeof order)[number]);
	const f = facts(shared);
	return (
		<Page
			shared={shared}
			header={
				<header className="tc-topbar r4-scalehead">
					<TitleBlock
						shared={shared}
						meta={
							<p className="tc-topbar-meta">
								{shared.duration} · {plural(f.prompts, "prompt")} · {plural(f.files.length, "file")} changed ·{" "}
								<span className={`tc-outcome tc-outcome-${shared.outcome.tone}`}>{shared.outcome.text}</span>
							</p>
						}
					/>
					<div className="r4-scalewrap">
						<ol className="r4-scale" aria-label={`Share level: ${LEVEL_NAME[shared.level]}`}>
							{order.map((level, index) => (
								<li key={level} className={`r4-step${index <= at ? " is-in" : ""}${index === at ? " is-here" : ""}`} title={`${LEVEL_NAME[level]}: ${SEES[level].keeps.join(", ").toLowerCase()}`}>
									{index > at ? <Icon name="lock" size={12} /> : null}
									{LEVEL_NAME[level]}
								</li>
							))}
						</ol>
						<p className="r4-scalecap">
							{shared.level === "full" ? "You're seeing everything." : `Not shared with you: ${SEES[shared.level].leaves.join(", ").toLowerCase()}.`}
							{shared.share ? (
								<button type="button" className="r2-link r4-inline" onClick={() => setSheet(true)}>
									Change who sees what
								</button>
							) : null}
						</p>
					</div>
				</header>
			}
			sheet={<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />}
		/>
	);
}

// ---------------------------------------------------------------------------
// 4. Marked where it's missing: no notice up top; locks sit on what's held back.

function MarkedWhereMissing({ shared }: { shared: Shared }) {
	const [sheet, setSheet] = React.useState(false);
	const f = facts(shared);
	const name = LEVEL_NAME[shared.level];
	const locked: Partial<Record<Tab, string>> | undefined =
		shared.level === "full"
			? undefined
			: {
					steps: `Step output and reasoning aren't shared at ${name}`,
					changes: `Diffs aren't shared at ${name}; you can see which files changed`,
				};
	return (
		<Page
			shared={shared}
			header={
				<header className="tc-topbar">
					<TitleBlock
						shared={shared}
						meta={
							<p className="tc-topbar-meta">
								{shared.duration} · {plural(f.prompts, "prompt")} · {plural(f.files.length, "file")} changed ·{" "}
								<span className={`tc-outcome tc-outcome-${shared.outcome.tone}`}>{shared.outcome.text}</span>
							</p>
						}
					/>
					{shared.share ? (
						<div className="tc-topbar-actions">
							<ShareButton onClick={() => setSheet(true)} />
						</div>
					) : null}
				</header>
			}
			sheet={<ShareSheet shared={shared} open={sheet} onClose={() => setSheet(false)} />}
		>
			<Transcript shared={shared} locked={locked} />
		</Page>
	);
}

// ---------------------------------------------------------------------------
// 5. About this session: a bare title; everything else in one sheet.

function AboutSheet({ shared }: { shared: Shared }) {
	const [open, setOpen] = React.useState(false);
	const f = facts(shared);
	const sees = SEES[shared.level];
	return (
		<Page
			shared={shared}
			header={
				<header className="tc-topbar">
					<TitleBlock shared={shared} />
					<div className="tc-topbar-actions">
						<button type="button" className="btn btn-secondary btn-sm tc-sharebtn" aria-haspopup="dialog" onClick={() => setOpen(true)}>
							<Icon name="info" size={14} /> About this session
						</button>
					</div>
				</header>
			}
			sheet={
				open ? (
					<div className="tc-sheet-backdrop" onClick={() => setOpen(false)}>
						<aside className="tc-sheet r4-about" role="dialog" aria-label="About this session" onClick={(event) => event.stopPropagation()}>
							<button type="button" className="tc-iconbtn tc-sheet-close" aria-label="Close" onClick={() => setOpen(false)}>
								<Icon name="x" />
							</button>
							<h2>About this session</h2>
							<dl className="r4-dl">
								<dt>Took</dt>
								<dd>
									{shared.duration} · {plural(f.prompts, "prompt")} · {plural(f.subagents, "subagent")}
								</dd>
								<dt>Outcome</dt>
								<dd className={`tc-outcome-${shared.outcome.tone}`}>
									{shared.outcome.text} · {plural(f.errors, "error")} along the way
								</dd>
								<dt>Changed</dt>
								<dd>
									<ul className="r4-mini">
										{f.files.map((file) => (
											<li key={file}>
												<Icon name="file" size={12} /> {file}
											</li>
										))}
									</ul>
								</dd>
								<dt>Checks</dt>
								<dd>
									<ul className="r4-mini">
										{f.checks.map((check, index) => (
											<li key={index} className={check.ok ? "r4-ok" : "r4-err"}>
												<Icon name={check.ok ? "ok" : "err"} size={12} /> <code>{check.command.split("\n")[0]}</code>
											</li>
										))}
									</ul>
								</dd>
								<dt>You can see</dt>
								<dd>
									{LEVEL_NAME[shared.level]}: {sees.keeps.join(", ").toLowerCase()}.
									{sees.leaves.length ? <span className="r2-muted"> Not shared: {sees.leaves.join(", ").toLowerCase()}.</span> : null}
								</dd>
							</dl>
							{shared.share ? (
								<section className="r4-about-share">
									<h3>Who sees what</h3>
									{shared.share}
								</section>
							) : null}
						</aside>
					</div>
				) : null
			}
		/>
	);
}

export const ROUND4 = [
	{ id: "quiet-header", name: "Quiet header", descriptor: "One meta line; a reader below Full sees 'Shared as Conversation' with an info button that lists what was left out.", render: (shared: Shared) => <QuietHeader shared={shared} /> },
	{ id: "outcome-card", name: "Outcome card", descriptor: "The summary leads: outcome, files changed and checks in a card above the first prompt, with the share level in its footer.", render: (shared: Shared) => <OutcomeCard shared={shared} /> },
	{ id: "level-scale", name: "Level scale", descriptor: "Summary, Conversation and Full as a scale beside the title, with the reader's level lit and the rest locked.", render: (shared: Shared) => <LevelScale shared={shared} /> },
	{ id: "marked-where-missing", name: "Marked where it's missing", descriptor: "No notice up top; a lock sits on the tabs that hold back output or diffs at this level.", render: (shared: Shared) => <MarkedWhereMissing shared={shared} /> },
	{ id: "about-sheet", name: "About this session", descriptor: "A bare title and one button; the summary, checks, what you can see and sharing all live in one sheet.", render: (shared: Shared) => <AboutSheet shared={shared} /> },
];
