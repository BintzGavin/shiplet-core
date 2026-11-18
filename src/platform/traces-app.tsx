/// <reference lib="dom" />
// Dashboard UI for traces (docs/traces-spec.md D14, D15, D19). A trace is the
// full log of an agent session: the prompts, the agent's replies, and every
// tool call and result. All trace text renders as plain text; no HTML from a
// trace is ever interpreted.
import * as React from "react";

import {
	TRACE_LIMITS,
	parseJsonl,
	prepareTraceUpload,
	type TraceEvent,
	type TraceManifest,
} from "../cli/trace-core.mjs";

export const TRACE_DEFINITION =
	"A trace is the full log of an agent session: your prompts, the agent's replies, and every tool call and result.";

type Level = "full" | "conversation" | "summary" | "hidden";

type TraceSummary = {
	id: string;
	projectId: string;
	title: string;
	harness: string;
	eventCount: number;
	attachmentCount: number;
	sharing: "private" | "shared";
	createdOn: string;
	access?: { level: Level; via: string };
};

type TraceDetail = {
	trace: TraceSummary;
	manifest: TraceManifest & { level?: Level };
	access: { level: Level; via: string; canManage: boolean };
};

type Rule = { op: string } & Record<string, unknown>;
type Audience = { targetType: string; targetId: string; profile: { level: Level; rules: Rule[] } };

const LEVEL_TEXT: Record<Level, { label: string; description: string }> = {
	full: { label: "Full", description: "Everything except secrets." },
	conversation: { label: "Conversation", description: "Messages and tool steps, without tool output or reasoning." },
	summary: { label: "Summary", description: "What was done, files touched, checks, and the outcome. No text." },
	hidden: { label: "Hidden", description: "Not shown." },
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
	});
	const text = await response.text();
	const body = text ? JSON.parse(text) : {};
	if (!response.ok) throw Object.assign(new Error(body?.message || `Request failed (${response.status})`), { status: response.status, body });
	return body as T;
}

const tracePath = (projectId: string, traceId?: string) =>
	`/api/shiplets/${encodeURIComponent(projectId)}/traces${traceId ? `/${encodeURIComponent(traceId)}` : ""}`;

function countLabel(count: number, noun: string) {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDuration(seconds: number | null | undefined) {
	if (seconds === null || seconds === undefined) return "unknown length";
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function formatBytes(bytes: number) {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

function LevelStamp({ level }: { level: Level }) {
	return <span className={`status-badge trace-level trace-level-${level}`}>{LEVEL_TEXT[level].label}</span>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = React.useState(false);
	return (
		<button
			type="button"
			className="btn btn-secondary btn-sm"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					window.prompt("Copy this:", text);
				}
			}}
		>
			{copied ? "Copied" : label}
		</button>
	);
}

// ---------------------------------------------------------------------------
// Trace viewer page

export function TraceViewerApp({ projectId, traceId, origin }: { projectId: string; traceId: string; origin: string }) {
	const [detail, setDetail] = React.useState<TraceDetail | null>(null);
	const [events, setEvents] = React.useState<TraceEvent[]>([]);
	const [nextSegment, setNextSegment] = React.useState(0);
	const [loadingMore, setLoadingMore] = React.useState(false);
	const [error, setError] = React.useState("");

	const loadSegment = React.useCallback(
		async (index: number) => {
			setLoadingMore(true);
			try {
				const page = await api<{ events: TraceEvent[] }>(`${tracePath(projectId, traceId)}/segments/${index}`);
				setEvents((current) => [...current, ...page.events]);
				setNextSegment(index + 1);
			} catch (caught) {
				setError((caught as Error).message);
			} finally {
				setLoadingMore(false);
			}
		},
		[projectId, traceId],
	);

	React.useEffect(() => {
		api<TraceDetail>(tracePath(projectId, traceId))
			.then((loaded) => {
				setDetail(loaded);
				if (loaded.manifest.segments.length) void loadSegment(0);
			})
			.catch((caught) => setError(caught.status === 404 ? "This trace does not exist, or it is not shared with you." : caught.message));
	}, [projectId, traceId, loadSegment]);

	if (error && !detail) {
		return (
			<section className="success-card shiplet-panel">
				<span className="success-card-label">Trace</span>
				<h1>Trace not available</h1>
				<p>{error}</p>
				<a className="btn btn-secondary btn-sm" href={`/shiplets/${encodeURIComponent(projectId)}`}>
					Back to the Shiplet
				</a>
			</section>
		);
	}
	if (!detail) return <div className="banner banner-info">Loading trace…</div>;

	const { manifest, access } = detail;
	const summary = manifest.summary;
	const totalSegments = manifest.segments.length;
	const attachments = manifest.attachments || [];
	const attachmentUrl = (sha256: string) => `${tracePath(projectId, traceId)}/attachments/${sha256}`;
	const agentPrompt = `Load Shiplet trace ${traceId} from Shiplet ${projectId} into context and summarize where it left off.`;
	const cliCommand = `npx shiplet-cli trace pull ${traceId} --shiplet ${projectId} --as context`;

	return (
		<div className="trace-viewer" data-trace-id={traceId}>
			<section className="success-card shiplet-panel shiplet-focus-strip trace-header">
				<span className="success-card-label">Trace · {manifest.source?.harness === "codex" ? "Codex" : "Claude Code"} session</span>
				<h1>{manifest.title}</h1>
				<p className="trace-definition">{TRACE_DEFINITION}</p>
				<div className="trace-meta">
					<span>You're seeing</span> <LevelStamp level={access.level} />
					<span>{formatDuration(summary?.durationSeconds)}</span>
					<span>{(manifest.models || []).join(", ") || "unknown model"}</span>
					<span className={`status-badge trace-outcome trace-outcome-${summary?.outcome}`}>
						{summary?.outcome === "last-check-passed" ? "Checks passed" : summary?.outcome === "last-check-failed" ? "Checks failed" : "No checks run"}
					</span>
					<span className={`status-badge trace-sharing-${detail.trace.sharing}`}>{detail.trace.sharing === "shared" ? "Shared" : "Private"}</span>
				</div>
				<div className="trace-actions">
					<CopyButton text={agentPrompt} label="Copy prompt for your agent" />
					<CopyButton text={cliCommand} label="Copy CLI command" />
					<a className="btn btn-secondary btn-sm" href={`/shiplets/${encodeURIComponent(projectId)}`}>
						Back to the Shiplet
					</a>
				</div>
				<p className="trace-hint">
					Your browser cannot write into Claude Code or Codex. To continue this work, give your agent the prompt (it loads the trace over Shiplet MCP), or run the
					command to print an agent-ready handoff.
				</p>
			</section>

			<div className="trace-layout">
				<section className="success-card shiplet-panel trace-timeline-card" aria-labelledby="traceTimelineTitle">
					<div className="dashboard-section-header">
						<div>
							<span className="success-card-label">Session</span>
							<h2 id="traceTimelineTitle">Timeline</h2>
							<p>
								{countLabel(manifest.counts.events, "event")} · {countLabel(manifest.counts.toolCalls, "tool call")} · {countLabel(manifest.counts.errors, "error")}
							</p>
						</div>
					</div>
					{access.level === "summary" ? (
						<p className="trace-empty">You can see this trace's summary only. Ask its owner for a higher level to read the session.</p>
					) : (
						<TraceTimeline events={events} attachmentUrl={attachmentUrl} attachments={attachments} />
					)}
					{nextSegment < totalSegments && access.level !== "summary" ? (
						<button type="button" className="btn btn-secondary btn-sm trace-load-more" disabled={loadingMore} onClick={() => loadSegment(nextSegment)}>
							{loadingMore ? "Loading…" : `Load more (${nextSegment} of ${totalSegments} pages)`}
						</button>
					) : null}
					{error ? <div className="banner banner-error">{error}</div> : null}
				</section>

				<aside className="trace-side">
					<section className="success-card shiplet-panel">
						<span className="success-card-label">Summary</span>
						<h2>What happened</h2>
						<dl className="trace-facts">
							<dt>Prompts</dt>
							<dd>{summary?.promptCount ?? 0}</dd>
							<dt>Errors</dt>
							<dd>{summary?.errorCount ?? 0}</dd>
							<dt>Subagents</dt>
							<dd>{(manifest.agents || []).length}</dd>
						</dl>
						{summary?.checks?.length ? (
							<>
								<h3>Checks</h3>
								<ul className="trace-checks">
									{summary.checks.slice(-8).map((check, index) => (
										<li key={`${check.command}-${index}`}>
											<span className={`status-badge ${check.ok ? "trace-check-ok" : "trace-check-failed"}`}>{check.ok ? "Passed" : "Failed"}</span>
											<code>{check.command}</code>
										</li>
									))}
								</ul>
							</>
						) : null}
						{summary?.filesTouched?.length ? (
							<>
								<h3>Files touched</h3>
								<ul className="trace-files-touched">
									{summary.filesTouched.slice(0, 40).map((file) => (
										<li key={file}>
											<code>{file}</code>
										</li>
									))}
								</ul>
							</>
						) : null}
					</section>
					{attachments.length ? (
						<section className="success-card shiplet-panel" aria-labelledby="traceFilesTitle">
							<span className="success-card-label">Files</span>
							<h2 id="traceFilesTitle">Images, video, and files</h2>
							<ul className="trace-attachment-list">
								{attachments.map((attachment, index) => (
									<li key={attachment.sha256}>
										<a href={attachmentUrl(attachment.sha256)} target="_blank" rel="noreferrer">
											{attachment.name || `${attachment.mediaType.startsWith("image/") ? "Image" : "File"} ${index + 1}`}
										</a>
										<span className="trace-attachment-meta">
											{attachment.mediaType} · {formatBytes(attachment.bytes)} · {attachment.source === "file" ? "made in the session" : "pasted or returned by a tool"}
										</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
					{access.canManage ? <TraceSharePanel projectId={projectId} traceId={traceId} /> : null}
				</aside>
			</div>
		</div>
	);
}

function TraceText({ text }: { text: string }) {
	return <pre className="trace-text">{text}</pre>;
}

function AttachmentPreview({ url, mediaType, name }: { url: string; mediaType: string; name: string }) {
	if (mediaType.startsWith("image/")) {
		return (
			<a href={url} target="_blank" rel="noreferrer" className="trace-inline-media">
				<img src={url} alt={name} loading="lazy" />
			</a>
		);
	}
	if (mediaType.startsWith("video/")) {
		return (
			<video className="trace-inline-media" src={url} controls preload="metadata">
				<a href={url}>{name}</a>
			</video>
		);
	}
	return (
		<a href={url} target="_blank" rel="noreferrer" className="trace-file-link">
			{name}
		</a>
	);
}

function TraceTimeline({
	events,
	attachmentUrl,
	attachments,
}: {
	events: TraceEvent[];
	attachmentUrl: (sha256: string) => string;
	attachments: TraceManifest["attachments"];
}) {
	const byId = new Map((attachments || []).map((attachment) => [attachment.sha256, attachment]));
	const results = new Map<string, TraceEvent>();
	for (const event of events) if (event.kind === "tool_result" && event.result) results.set(event.result.callId, event);
	if (!events.length) return <p className="trace-empty">Loading the session…</p>;
	return (
		<ol className="trace-timeline">
			{events.map((event) => {
				if (event.kind === "tool_result" && event.result && events.some((candidate) => candidate.kind === "tool_call" && candidate.tool?.callId === event.result?.callId)) {
					return null;
				}
				const media = (event.attachmentIds || [])
					.map((id) => byId.get(id))
					.filter(Boolean)
					.map((attachment) => (
						<AttachmentPreview key={attachment!.sha256} url={attachmentUrl(attachment!.sha256)} mediaType={attachment!.mediaType} name={attachment!.name || attachment!.mediaType} />
					));
				const nested = event.agent !== "main" ? " trace-event-subagent" : "";
				switch (event.kind) {
					case "user_message":
						return (
							<li key={event.id} className={`trace-event trace-event-user${nested}`}>
								<span className="trace-role">{event.agent === "main" ? "You" : "Task"}</span>
								{event.text ? <TraceText text={event.text} /> : null}
								{media}
							</li>
						);
					case "assistant_message":
						return (
							<li key={event.id} className={`trace-event trace-event-agent${nested}`}>
								<span className="trace-role">Agent</span>
								<TraceText text={event.text || ""} />
								{media}
							</li>
						);
					case "reasoning":
						return (
							<li key={event.id} className={`trace-event trace-event-reasoning${nested}`}>
								<details>
									<summary>Reasoning</summary>
									<TraceText text={event.text || ""} />
								</details>
							</li>
						);
					case "tool_call": {
						const result = results.get(event.tool?.callId || "");
						const failed = result?.result?.isError;
						return (
							<li key={event.id} className={`trace-event trace-event-tool${failed ? " trace-event-failed" : ""}${nested}`}>
								<details>
									<summary>
										<span className="trace-tool-name">{event.tool?.name}</span>
										<code className="trace-tool-summary">{event.tool?.inputSummary}</code>
										{failed ? <span className="status-badge trace-check-failed">Error</span> : null}
									</summary>
									{event.tool?.input ? <TraceText text={JSON.stringify(event.tool.input, null, 2)} /> : null}
									{result?.result ? (
										<div className="trace-tool-result">
											<span className="trace-role">{failed ? "Error" : "Result"}</span>
											<TraceText text={result.result.text} />
										</div>
									) : null}
								</details>
								{[...media, ...((result?.attachmentIds || []).map((id) => byId.get(id)).filter(Boolean).map((attachment) => (
									<AttachmentPreview key={attachment!.sha256} url={attachmentUrl(attachment!.sha256)} mediaType={attachment!.mediaType} name={attachment!.name || attachment!.mediaType} />
								)))]}
							</li>
						);
					}
					case "tool_result":
						return (
							<li key={event.id} className={`trace-event trace-event-tool${nested}`}>
								<TraceText text={event.result?.text || ""} />
								{media}
							</li>
						);
					case "subagent_start":
						return (
							<li key={event.id} className="trace-event trace-event-marker">
								<span className="status-badge">Subagent</span> {event.text}
							</li>
						);
					case "subagent_end":
						return null;
					case "omitted":
						return (
							<li key={event.id} className={`trace-event trace-event-omitted${nested}`}>
								{event.reason ? `${event.reason[0].toUpperCase()}${event.reason.slice(1)} at your level.` : "Hidden at your level."}
							</li>
						);
					default:
						return (
							<li key={event.id} className={`trace-event trace-event-note${nested}`}>
								<TraceText text={event.text || ""} />
							</li>
						);
				}
			})}
		</ol>
	);
}

// ---------------------------------------------------------------------------
// Share panel: who sees what

const TARGET_LABELS: Record<string, string> = {
	email: "A person, by email",
	team: "A team",
	organization: "Everyone in the organization",
	link: "Anyone with the link",
	user: "A person, by user ID",
};

function rulesFor(form: { maskTerms: string; hidePaths: string; hideReasoning: boolean; hideVideos: boolean }) {
	const split = (value: string) =>
		value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	const rules: Rule[] = [];
	if (split(form.maskTerms).length) rules.push({ op: "mask_terms", terms: split(form.maskTerms) });
	if (split(form.hidePaths).length) rules.push({ op: "drop_paths", globs: split(form.hidePaths) });
	if (form.hideReasoning) rules.push({ op: "drop_kinds", kinds: ["reasoning"] });
	if (form.hideVideos) rules.push({ op: "drop_attachments", mediaTypes: ["video/*"] });
	return rules;
}

function describeRules(rules: Rule[]) {
	return rules
		.map((rule) => {
			if (rule.op === "mask_terms") return `masks ${(rule.terms as string[]).length} term(s)`;
			if (rule.op === "drop_paths") return `hides ${(rule.globs as string[]).join(", ")}`;
			if (rule.op === "drop_kinds") return `hides ${(rule.kinds as string[]).join(", ")}`;
			if (rule.op === "drop_attachments") return "hides videos";
			return rule.op;
		})
		.join("; ");
}

export function TraceSharePanel({ projectId, traceId }: { projectId: string; traceId: string }) {
	const [sharing, setSharing] = React.useState<"private" | "shared">("private");
	const [audiences, setAudiences] = React.useState<Audience[]>([]);
	const [status, setStatus] = React.useState("");
	const [preview, setPreview] = React.useState<{ level: Level; kinds: Record<string, number>; attachments: number } | null>(null);
	const [form, setForm] = React.useState({ targetType: "organization", targetId: "", level: "conversation" as Level, maskTerms: "", hidePaths: "", hideReasoning: false, hideVideos: false });
	const base = `${tracePath(projectId, traceId)}/audiences`;

	React.useEffect(() => {
		api<{ sharing: "private" | "shared"; audiences: Audience[] }>(base)
			.then((loaded) => {
				setSharing(loaded.sharing);
				setAudiences(loaded.audiences.map(({ targetType, targetId, profile }) => ({ targetType, targetId, profile })));
			})
			.catch((caught) => setStatus(caught.message));
	}, [base]);

	const save = async (next: Audience[], nextSharing?: "private" | "shared") => {
		setStatus("Saving…");
		try {
			const saved = await api<{ sharing: "private" | "shared"; audiences: Audience[] }>(base, {
				method: "PUT",
				body: JSON.stringify({ ...(nextSharing ? { sharing: nextSharing } : {}), audiences: next.map(({ targetType, targetId, profile }) => ({ targetType, targetId, profile })) }),
			});
			setSharing(saved.sharing);
			setAudiences(saved.audiences.map(({ targetType, targetId, profile }) => ({ targetType, targetId, profile })));
			setStatus(saved.sharing === "shared" ? "Shared. Organization admins can also read shared traces." : "Private to you and the Shiplet owner.");
		} catch (caught) {
			const errors = (caught as { body?: { errors?: Array<{ message: string }> } }).body?.errors;
			setStatus(errors?.length ? errors.map((error) => error.message).join(" ") : (caught as Error).message);
		}
	};

	const profile = { level: form.level, rules: rulesFor(form) };
	const needsId = form.targetType === "email" || form.targetType === "team" || form.targetType === "user";

	return (
		<section className="success-card shiplet-panel trace-share" aria-labelledby="traceShareTitle">
			<span className="success-card-label">Sharing</span>
			<h2 id="traceShareTitle">Who sees what</h2>
			<p>
				This trace is <strong>{sharing === "shared" ? "shared" : "private"}</strong>. A more specific audience wins: a person or email over their team, a team over the
				organization.
			</p>
			{audiences.length ? (
				<ul className="trace-audience-list">
					{audiences.map((audience, index) => (
						<li key={`${audience.targetType}:${audience.targetId}`}>
							<span>
								{TARGET_LABELS[audience.targetType] || audience.targetType}
								{audience.targetType === "organization" || audience.targetType === "link" ? "" : `: ${audience.targetId}`}
							</span>
							<LevelStamp level={audience.profile.level} />
							{audience.profile.rules.length ? <span className="trace-attachment-meta">{describeRules(audience.profile.rules)}</span> : null}
							<button type="button" className="btn btn-secondary btn-sm" onClick={() => save(audiences.filter((_, other) => other !== index))}>
								Remove
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="trace-empty">No audiences yet.</p>
			)}
			<form
				className="trace-share-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save([...audiences, { targetType: form.targetType, targetId: needsId ? form.targetId.trim() : form.targetType, profile }]);
				}}
			>
				<div className="form-group">
					<label htmlFor="traceAudienceType">Share with</label>
					<select id="traceAudienceType" value={form.targetType} onChange={(event) => setForm({ ...form, targetType: event.target.value })}>
						{Object.entries(TARGET_LABELS).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</div>
				{needsId ? (
					<div className="form-group">
						<label htmlFor="traceAudienceTarget">{form.targetType === "email" ? "Email" : form.targetType === "team" ? "Team ID" : "User ID"}</label>
						<input id="traceAudienceTarget" value={form.targetId} required onChange={(event) => setForm({ ...form, targetId: event.target.value })} />
					</div>
				) : null}
				<fieldset className="trace-levels">
					<legend>Level</legend>
					{(["full", "conversation", "summary"] as Level[]).map((level) => (
						<label key={level} className="trace-level-option">
							<input type="radio" name="traceLevel" value={level} checked={form.level === level} onChange={() => setForm({ ...form, level })} />
							<span>
								<strong>{LEVEL_TEXT[level].label}</strong> {LEVEL_TEXT[level].description}
							</span>
						</label>
					))}
				</fieldset>
				<div className="form-group">
					<label htmlFor="traceMaskTerms">Terms to mask (comma-separated)</label>
					<input id="traceMaskTerms" value={form.maskTerms} placeholder="Project Falcon, acme-internal" onChange={(event) => setForm({ ...form, maskTerms: event.target.value })} />
				</div>
				<div className="form-group">
					<label htmlFor="traceHidePaths">Paths to hide (comma-separated)</label>
					<input id="traceHidePaths" value={form.hidePaths} placeholder="secrets/**, .env*" onChange={(event) => setForm({ ...form, hidePaths: event.target.value })} />
				</div>
				<label className="trace-check-option">
					<input type="checkbox" checked={form.hideReasoning} onChange={(event) => setForm({ ...form, hideReasoning: event.target.checked })} /> Hide reasoning
				</label>
				<label className="trace-check-option">
					<input type="checkbox" checked={form.hideVideos} onChange={(event) => setForm({ ...form, hideVideos: event.target.checked })} /> Hide videos
				</label>
				<p className="trace-hint">Images, video, and PDFs are not scanned for secrets.</p>
				<div className="trace-actions">
					<button
						type="button"
						className="btn btn-secondary btn-sm"
						onClick={async () => {
							try {
								const result = await api<{ events: TraceEvent[]; manifest: TraceManifest }>(`${tracePath(projectId, traceId)}/preview`, {
									method: "POST",
									body: JSON.stringify({ profile }),
								});
								const kinds: Record<string, number> = {};
								for (const event of result.events) kinds[event.kind] = (kinds[event.kind] || 0) + 1;
								setPreview({ level: form.level, kinds, attachments: result.manifest.attachments.length });
							} catch (caught) {
								setStatus((caught as Error).message);
							}
						}}
					>
						Preview as this audience
					</button>
					<button type="submit" className="btn btn-primary btn-sm">
						Add audience
					</button>
				</div>
			</form>
			{preview ? (
				<div className="banner banner-info trace-preview">
					At {LEVEL_TEXT[preview.level].label}, this audience sees{" "}
					{Object.entries(preview.kinds)
						.map(([kind, count]) => `${count} ${kind.replace(/_/g, " ")}`)
						.join(", ") || "the summary only"}{" "}
					on the first page, and {preview.attachments} file(s).
				</div>
			) : null}
			<div className="trace-actions">
				{sharing === "shared" ? (
					<button type="button" className="btn btn-secondary btn-sm" onClick={() => save(audiences, "private")}>
						Make private
					</button>
				) : audiences.length ? (
					<button type="button" className="btn btn-secondary btn-sm" onClick={() => save(audiences, "shared")}>
						Share again
					</button>
				) : null}
			</div>
			{status ? <p className="trace-status" role="status">{status}</p> : null}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Shiplet page: the traces list and the drop zone

type DroppedFile = { path: string; file: File };

async function filesFromDrop(items: DataTransferItemList | null, files: FileList | null): Promise<DroppedFile[]> {
	const collected: DroppedFile[] = [];
	const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
		if (entry.isFile) {
			const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
			collected.push({ path: `${prefix}${entry.name}`, file });
		} else if (entry.isDirectory) {
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			const children = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			for (const child of children) await walk(child, `${prefix}${entry.name}/`);
		}
	};
	const entries = items ? Array.from(items).map((item) => item.webkitGetAsEntry?.()).filter(Boolean) : [];
	if (entries.length) for (const entry of entries) await walk(entry as FileSystemEntry, "");
	else for (const file of Array.from(files || [])) collected.push({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file });
	return collected.filter((item) => item.path.endsWith(".jsonl"));
}

export function TracesPanel({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
	const [traces, setTraces] = React.useState<TraceSummary[] | null>(null);
	const [enabled, setEnabled] = React.useState(true);
	const [adding, setAdding] = React.useState(false);
	const [prepared, setPrepared] = React.useState<Awaited<ReturnType<typeof prepareTraceUpload>> | null>(null);
	const [title, setTitle] = React.useState("");
	const [status, setStatus] = React.useState("");
	const [dragging, setDragging] = React.useState(false);

	React.useEffect(() => {
		api<{ traces: TraceSummary[] }>(tracePath(projectId))
			.then((loaded) => setTraces(loaded.traces))
			.catch((caught) => {
				if (caught.body?.error === "traces_not_enabled") setEnabled(false);
				else setTraces([]);
			});
	}, [projectId]);

	if (!enabled) return null;
	const prompt = `Share this session to Shiplet ${projectId}.`;
	const command = `npx shiplet-cli trace share --current --shiplet ${projectId}`;

	const accept = async (dropped: DroppedFile[]) => {
		setStatus("");
		setPrepared(null);
		if (!dropped.length) return setStatus("Drop a Claude Code .jsonl file or session folder, or a Codex rollout-*.jsonl.");
		const subagents = dropped.filter((item) => item.path.includes("/subagents/"));
		const mains = dropped.filter((item) => !item.path.includes("/subagents/")).sort((a, b) => b.file.size - a.file.size);
		const main = mains[0] || subagents.shift();
		if (!main) return;
		try {
			const read = async (item: DroppedFile) => ({ fileName: item.path, ...parseJsonl(await item.file.text()) });
			const result = await prepareTraceUpload({
				main: await read(main),
				subagents: await Promise.all(subagents.map(read)),
				importer: "shiplet-dashboard",
			});
			setPrepared(result);
			setTitle(result.upload.title);
		} catch (caught) {
			setStatus((caught as Error).name === "TraceFormatError" ? "That file is not a Claude Code or Codex session." : (caught as Error).message);
		}
	};

	return (
		<section className="success-card shiplet-panel traces-panel" aria-labelledby="tracesPanelTitle">
			<div className="dashboard-section-header">
				<div>
					<span className="success-card-label">Traces</span>
					<h2 id="tracesPanelTitle">Agent sessions</h2>
					<p>{TRACE_DEFINITION}</p>
				</div>
				{canEdit ? (
					<button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(!adding)} aria-expanded={adding}>
						{adding ? "Close" : "Add a trace"}
					</button>
				) : null}
			</div>
			{adding ? (
				<div className="trace-dropzone-panel">
					<div className="banner banner-info trace-agent-first">
						<strong>Easiest: ask your agent.</strong> Say “{prompt}” in Claude Code or Codex, or run <code>{command}</code>. Your agent knows which session it is in,
						including subagents, screenshots, and videos.
						<div className="trace-actions">
							<CopyButton text={prompt} label="Copy prompt" />
							<CopyButton text={command} label="Copy command" />
						</div>
					</div>
					<label
						className={`trace-dropzone${dragging ? " trace-dropzone-active" : ""}`}
						onDragOver={(event) => {
							event.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={async (event) => {
							event.preventDefault();
							setDragging(false);
							await accept(await filesFromDrop(event.dataTransfer.items, event.dataTransfer.files));
						}}
					>
						<input type="file" accept=".jsonl" multiple className="sr-only" onChange={async (event) => accept(await filesFromDrop(null, event.target.files))} />
						<strong>Or drop a session file here</strong>
						<span>
							Claude Code: ~/.claude/projects/&lt;project&gt;/&lt;session&gt;.jsonl (drop its folder too, for subagents). Codex: ~/.codex/sessions/…/rollout-*.jsonl.
							On a Mac, Cmd+Shift+. shows hidden folders.
						</span>
					</label>
					{prepared ? (
						<form
							className="trace-share-form"
							onSubmit={async (event) => {
								event.preventDefault();
								setStatus("Uploading…");
								try {
									const body = JSON.stringify({ ...prepared.upload, title: title.trim() || prepared.upload.title });
									if (body.length > TRACE_LIMITS.uploadRequestBytes) throw new Error("This session is larger than 16 MB. Ask your agent to share it instead.");
									const created = await api<{ trace: { id: string } }>(tracePath(projectId), { method: "POST", body });
									window.location.assign(`/shiplets/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(created.trace.id)}`);
								} catch (caught) {
									setStatus((caught as Error).message);
								}
							}}
						>
							<div className="form-group">
								<label htmlFor="traceUploadTitle">Title</label>
								<input id="traceUploadTitle" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
							</div>
							<p>
								{prepared.format === "codex" ? "Codex" : "Claude Code"} session · {prepared.upload.events.length} events · {prepared.upload.attachments.length} image(s) ·
								secrets masked in this browser: {prepared.masked.count}. Nothing has been sent yet. The trace starts private.
							</p>
							<button type="submit" className="btn btn-primary btn-sm">
								Upload
							</button>
						</form>
					) : null}
					{status ? <p className="trace-status" role="status">{status}</p> : null}
				</div>
			) : null}
			{traces === null ? (
				<p className="trace-empty">Loading traces…</p>
			) : traces.length ? (
				<ul className="trace-list">
					{traces.map((trace) => (
						<li key={trace.id}>
							<a href={`/shiplets/${encodeURIComponent(projectId)}/traces/${encodeURIComponent(trace.id)}`}>{trace.title}</a>
							<span className="trace-attachment-meta">
								{trace.harness === "codex" ? "Codex" : "Claude Code"} · {trace.eventCount} events · {new Date(trace.createdOn).toLocaleDateString()}
							</span>
							{trace.access ? <LevelStamp level={trace.access.level} /> : null}
							<span className={`status-badge trace-sharing-${trace.sharing}`}>{trace.sharing === "shared" ? "Shared" : "Private"}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="trace-empty">No traces yet. Ask your agent to share the session that built this.</p>
			)}
		</section>
	);
}
