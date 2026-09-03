import {
	AVATAR_PRESETS,
	AVATAR_SPRITE_COLUMNS,
	AVATAR_SPRITE_ROWS,
	AVATAR_SPRITE_URL,
} from "./avatars";

export type BubbleLayoutPoint = {
	id: string;
	x: number;
	y: number;
};

export type BubbleLayoutViewport = {
	width: number;
	height: number;
};

export type BubbleLayoutResult = BubbleLayoutPoint & {
	clusterId: string;
	clusterIndex: number;
	clusterSize: number;
};

export type ContextualReviewPlacement = "right" | "left" | "below" | "above";

export type ContextualReviewFrame = {
	left: number;
	top: number;
	width: number;
	height: number;
	placement: ContextualReviewPlacement;
	arrowOffset: number;
};

export type ReviewKeyboardIntent =
	| "close-annotation"
	| "cancel-composer"
	| "stop-capture"
	| "close-comment-list"
	| "close-panel"
	| "collapse-bubble"
	| "collapse-toolbar"
	| "start-capture"
	| "submit-comment"
	| "submit-reply"
	| "previous-thread"
	| "next-thread";

export function placeContextualReviewFrame(
	anchor: { x: number; y: number },
	viewport: BubbleLayoutViewport,
	options: {
		preferredWidth?: number;
		preferredHeight?: number;
		margin?: number;
		gap?: number;
	} = {},
): ContextualReviewFrame {
	const margin = Math.max(0, Number(options.margin ?? 12));
	const gap = Math.max(0, Number(options.gap ?? 14));
	const viewportWidth = Math.max(1, Number(viewport.width || 1));
	const viewportHeight = Math.max(1, Number(viewport.height || 1));
	const width = Math.min(
		Math.max(220, Number(options.preferredWidth ?? 344)),
		Math.max(1, viewportWidth - margin * 2),
	);
	const height = Math.min(
		Math.max(150, Number(options.preferredHeight ?? 190)),
		Math.max(1, viewportHeight - margin * 2),
	);
	const x = clampNumber(Number(anchor.x || 0), 0, viewportWidth);
	const y = clampNumber(Number(anchor.y || 0), 0, viewportHeight);
	const available = {
		right: viewportWidth - margin - (x + gap),
		left: x - gap - margin,
		below: viewportHeight - margin - (y + gap),
		above: y - gap - margin,
	};
	const candidates: Array<{
		placement: ContextualReviewPlacement;
		fits: boolean;
		score: number;
	}> = [
		{ placement: "right", fits: available.right >= width, score: available.right / width },
		{ placement: "left", fits: available.left >= width, score: available.left / width },
		{ placement: "below", fits: available.below >= height, score: available.below / height },
		{ placement: "above", fits: available.above >= height, score: available.above / height },
	];
	const placement =
		candidates.find((candidate) => candidate.fits)?.placement ||
		candidates.reduce((best, candidate) =>
			candidate.score > best.score ? candidate : best,
		).placement;

	let left = x + gap;
	let top = y - 32;
	if (placement === "left") left = x - width - gap;
	if (placement === "below" || placement === "above") left = x - 28;
	if (placement === "below") top = y + gap;
	if (placement === "above") top = y - height - gap;
	left = clampNumber(left, margin, viewportWidth - width - margin);
	top = clampNumber(top, margin, viewportHeight - height - margin);
	const arrowOffset =
		placement === "left" || placement === "right"
			? clampNumber(y - top, 18, Math.max(18, height - 18))
			: clampNumber(x - left, 18, Math.max(18, width - 18));

	return {
		left: Math.round(left),
		top: Math.round(top),
		width: Math.round(width),
		height: Math.round(height),
		placement,
		arrowOffset: Math.round(arrowOffset),
	};
}

export function reviewKeyboardIntent(
	event: {
		key?: string;
		altKey?: boolean;
		ctrlKey?: boolean;
		metaKey?: boolean;
		shiftKey?: boolean;
		isComposing?: boolean;
	},
	context: {
		annotationEditorOpen?: boolean;
		targetSelected?: boolean;
		capturing?: boolean;
		commentListOpen?: boolean;
		panelOpen?: boolean;
		expandedBubble?: boolean;
		toolbarExpanded?: boolean;
		commentInput?: boolean;
		replyInput?: boolean;
		editableTarget?: boolean;
	} = {},
): ReviewKeyboardIntent | null {
	if (event.isComposing) return null;
	const key = String(event.key || "");
	if (key === "Escape") {
		if (context.annotationEditorOpen) return "close-annotation";
		if (context.targetSelected) return "cancel-composer";
		if (context.capturing) return "stop-capture";
		if (context.commentListOpen) return "close-comment-list";
		if (context.panelOpen) return "close-panel";
		if (context.expandedBubble) return "collapse-bubble";
		if (context.toolbarExpanded) return "collapse-toolbar";
		return null;
	}
	if (
		key.toLowerCase() === "c" &&
		!context.editableTarget &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey
	) {
		return "start-capture";
	}
	if (
		key === "Enter" &&
		context.commentInput &&
		(event.metaKey || event.ctrlKey)
	) {
		return "submit-comment";
	}
	if (
		key === "Enter" &&
		context.replyInput &&
		!event.shiftKey &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey
	) {
		return "submit-reply";
	}
	if (context.commentListOpen && !context.editableTarget) {
		if (key === "ArrowUp") return "previous-thread";
		if (key === "ArrowDown") return "next-thread";
	}
	return null;
}

export function clampNumber(value: number, min: number, max: number) {
	const numeric = Number.isFinite(value) ? value : min;
	if (max < min) return min;
	return Math.max(min, Math.min(max, numeric));
}

export function pointDistance(
	first: { x: number; y: number },
	second: { x: number; y: number },
) {
	const x = Number(first.x || 0) - Number(second.x || 0);
	const y = Number(first.y || 0) - Number(second.y || 0);
	return Math.sqrt(x * x + y * y);
}

export function clampExpandedBubbleFrame(
	center: { x: number; y: number },
	viewport: BubbleLayoutViewport,
	options: { width?: number; minHeight?: number; margin?: number } = {},
) {
	const margin = Number(options.margin ?? 14);
	const viewportWidth = Math.max(1, Number(viewport.width || 1));
	const viewportHeight = Math.max(1, Number(viewport.height || 1));
	const width = Math.min(
		Number(options.width || 320),
		Math.max(160, viewportWidth - margin * 2),
	);
	const minHeight = Math.min(
		Number(options.minHeight || 168),
		Math.max(120, viewportHeight - margin * 2),
	);
	const maxHeight = Math.max(120, viewportHeight - margin * 2);
	return {
		left: Math.round(
			clampNumber(Number(center.x || 0) - width / 2, margin, viewportWidth - width - margin),
		),
		top: Math.round(
			clampNumber(Number(center.y || 0) - 12, margin, viewportHeight - minHeight - margin),
		),
		width: Math.round(width),
		minHeight: Math.round(minHeight),
		maxHeight: Math.round(maxHeight),
	};
}

export function layoutReviewBubbles(
	items: BubbleLayoutPoint[],
	viewport: BubbleLayoutViewport,
	options: {
		activeClusterId?: string;
		bubbleMargin?: number;
		clusterRadius?: number;
		stackOffset?: number;
		fanRadius?: number;
	} = {},
): BubbleLayoutResult[] {
	const margin = Number(options.bubbleMargin || 24);
	const clusterRadius = Number(options.clusterRadius || 58);
	const stackOffset = Number(options.stackOffset || 7);
	const fanRadius = Number(options.fanRadius || 58);
	const viewportWidth = Math.max(margin * 2 + 1, Number(viewport.width || 1));
	const viewportHeight = Math.max(margin * 2 + 1, Number(viewport.height || 1));
	const clusters: Array<{
		id: string;
		x: number;
		y: number;
		items: BubbleLayoutPoint[];
	}> = [];

	for (const item of items || []) {
		const point = {
			id: String(item.id || ""),
			x: clampNumber(Number(item.x || 0), margin, viewportWidth - margin),
			y: clampNumber(Number(item.y || 0), margin, viewportHeight - margin),
		};
		if (!point.id) continue;
		let cluster = clusters.find((candidate) => pointDistance(candidate, point) <= clusterRadius);
		if (!cluster) {
			cluster = {
				id: "bubble-cluster-" + clusters.length,
				x: point.x,
				y: point.y,
				items: [],
			};
			clusters.push(cluster);
		}
		cluster.items.push(point);
		cluster.x =
			cluster.items.reduce((sum, candidate) => sum + candidate.x, 0) /
			cluster.items.length;
		cluster.y =
			cluster.items.reduce((sum, candidate) => sum + candidate.y, 0) /
			cluster.items.length;
	}

	const results: BubbleLayoutResult[] = [];
	for (const cluster of clusters) {
		const size = cluster.items.length;
		const isActive = options.activeClusterId === cluster.id && size > 1;
		const stackDirectionX = cluster.x > viewportWidth / 2 ? -1 : 1;
		const stackDirectionY = cluster.y > viewportHeight / 2 ? -1 : 1;
		cluster.items.forEach((item, index) => {
			let x = cluster.x;
			let y = cluster.y;
			if (isActive) {
				const angle = -Math.PI / 2 + (index / size) * Math.PI * 2;
				x += Math.cos(angle) * fanRadius;
				y += Math.sin(angle) * fanRadius;
			} else {
				x += stackDirectionX * index * stackOffset;
				y += stackDirectionY * index * stackOffset;
			}
			results.push({
				id: item.id,
				x: Math.round(clampNumber(x, margin, viewportWidth - margin)),
				y: Math.round(clampNumber(y, margin, viewportHeight - margin)),
				clusterId: cluster.id,
				clusterIndex: index,
				clusterSize: size,
			});
		});
	}
	return results;
}

export function absolutizeCssUrlsForSnapshot(css: string, baseUrl: string) {
	return String(css || "").replace(
		/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
		(match, quote: string, rawValue: string) => {
			const value = rawValue.trim();
			if (
				!value ||
				value.startsWith("#") ||
				/^(?:data|blob|about|javascript):/i.test(value)
			) {
				return `url(${quote}${value}${quote})`;
			}
			try {
				return `url(${quote}${new URL(value, baseUrl).href}${quote})`;
			} catch {
				return match;
			}
		},
	);
}

export function resolveReviewAssetUrl(assetPath: string, apiBaseUrl: string) {
	const value = String(assetPath || "");
	const base = String(apiBaseUrl || "").trim().replace(/\/+$/, "");
	if (!value || !base) return value;

	try {
		return new URL(value, `${base}/`).href;
	} catch {
		return value;
	}
}

export function reviewSessionRecoveryUrl(href: string) {
	const url = new URL(href);
	url.searchParams.delete("shiplet_preview_token");
	return url.toString();
}

export function shouldRecoverReviewSession(
	status: number,
	hasReviewToken: boolean,
	lastAttemptAt: number,
	now = Date.now(),
	cooldownMs = 60_000,
) {
	return (
		status === 401 &&
		hasReviewToken &&
		(!lastAttemptAt || now - lastAttemptAt >= cooldownMs)
	);
}

function scriptSafeJson(value: unknown) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function reviewClientScript() {
	const avatarPresetJson = scriptSafeJson(AVATAR_PRESETS);
	const avatarSpritePath = scriptSafeJson(AVATAR_SPRITE_URL);
	const bubbleLayoutHelpers = [
		resolveReviewAssetUrl,
		clampNumber,
		placeContextualReviewFrame,
		reviewKeyboardIntent,
		pointDistance,
		clampExpandedBubbleFrame,
		layoutReviewBubbles,
		absolutizeCssUrlsForSnapshot,
		reviewSessionRecoveryUrl,
		shouldRecoverReviewSession,
	]
		.map((helper) => helper.toString())
		.join("\n");

	return String.raw`
(() => {
	const config = window.__SHIPLET_REVIEW__;
	const mountKey = "__SHIPLET_REVIEW_CLIENT_MOUNTED__";
	if (!config || !config.projectId || window[mountKey]) return;
	window[mountKey] = true;
	document.querySelectorAll(
		"[data-shiplet-review-style],#shiplet-review-root,.shiplet-review-bubble-layer,.shiplet-review-comment-list-root,.shiplet-review-highlight,.shiplet-review-picker-cursor,.shiplet-review-annotation-layer,.shiplet-review-presence-root,.shiplet-review-cursor-layer",
	).forEach((node) => node.remove());

${bubbleLayoutHelpers}
	const apiBase = String(config.apiBaseUrl || "").replace(/\/$/, "");
	const reviewToken = String(config.reviewToken || "");
	const presenceToken = String(config.presenceToken || reviewToken || "");
	const appOrigin = (() => {
		try {
			return new URL(config.appOrigin || apiBase).origin;
		} catch {
			return apiBase || location.origin;
		}
	})();
	const projectId = config.projectId;
	const sessionRecoveryStorageKey = "shiplet-review-session-recovery:" + projectId;
	const avatarPresets = ${avatarPresetJson};
	const avatarSpritePath = ${avatarSpritePath};
	const avatarSpriteUrl = resolveReviewAssetUrl(avatarSpritePath, apiBase);
	const avatarSpriteColumns = ${AVATAR_SPRITE_COLUMNS};
	const avatarSpriteRows = ${AVATAR_SPRITE_ROWS};
	const annotationToolStorageKey = "shiplet-review-annotation-tool";
	const annotationColorStorageKey = "shiplet-review-annotation-color";
	const annotationStrokeWidthStorageKey = "shiplet-review-annotation-stroke-width";
	const showBubblesStorageKey = "shiplet-review-show-bubbles:" + projectId;
	const showClosedStorageKey = "shiplet-review-show-closed:" + projectId;
	const presenceGuestStorageKey = "shiplet-review-presence-guest";
	const feedbackEnabled = config.feedbackEnabled !== false;
	const feedbackPollIntervalMs = Math.max(5000, Number(config.feedbackPollIntervalMs || 10000));
	const isEmbeddedFrame = (() => {
		try {
			return window.self !== window.top;
		} catch {
			return true;
		}
	})();
	const canRenderPresenceRoster = !isEmbeddedFrame;
	const canRenderCommentList = !isEmbeddedFrame;
	const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const selfPresenceViewer = currentPresenceViewer();
	const state = {
		open: false,
		toolbarExpanded: false,
		panelOpen: false,
		sheetCollapsed: false,
		capturing: false,
		loading: false,
		submitting: false,
		items: [],
		target: null,
		comment: "",
		mentions: [],
		mentionCandidates: [],
		mentionQuery: "",
		mentionOpen: false,
		mentionLoading: false,
		mentionError: "",
		expandedBubbleId: "",
		activeBubbleClusterId: "",
		activeTicketId: "",
		replyingTicketId: "",
		commentListOpen: false,
		settingsOpen: false,
		showBubbles: readBooleanPreference(showBubblesStorageKey, true),
		showClosed: readBooleanPreference(showClosedStorageKey, false),
		pendingStatusIds: {},
		pendingReplyIds: {},
		optimisticCreatedFeedback: {},
		annotationEditorOpen: false,
		annotationTool: readAnnotationTool(),
		annotationColor: readAnnotationColor(),
		annotationStrokeWidth: readAnnotationStrokeWidth(),
		annotations: [],
		annotationDraft: null,
		annotationPointerId: null,
		activeTextBox: null,
		presenceViewers: [],
		remoteCursors: {},
		followingId: "",
		followingName: "",
		presenceConnected: false,
		error: "",
	};

	function isElementTarget(value) {
		return !!value && typeof value.closest === "function" && typeof value.matches === "function";
	}

	function targetTagName(value) {
		return value && typeof value.tagName === "string" ? value.tagName.toUpperCase() : "";
	}

	function isInputTarget(value) {
		return isElementTarget(value) && targetTagName(value) === "INPUT";
	}

	function isSelectTarget(value) {
		return isElementTarget(value) && targetTagName(value) === "SELECT";
	}

	function isTextAreaTarget(value) {
		return isElementTarget(value) && targetTagName(value) === "TEXTAREA";
	}

	let presenceSocket = null;
	let presenceReconnectTimer = 0;
	let lastCursorSentAt = 0;
	let mentionRequestSerial = 0;
	let feedbackLoadSerial = 0;
	let feedbackPollTimer = 0;
	let feedbackLocationCheckTimer = 0;
	let lastFeedbackPageKey = currentFeedbackPageKey();

	// Harbor Office palette, self-contained because the widget is injected into
	// arbitrary pages. Motion uses a spring-like curve to echo the Framer Motion
	// bubble interaction without shipping a runtime dependency into every asset.
	const css = document.createElement("style");
	css.setAttribute("data-shiplet-review-style", "");
	css.textContent = [
		"#shiplet-review-root,.shiplet-review-bubble-layer,.shiplet-review-comment-list-root,.shiplet-review-annotation-layer{--shiplet-ink:#20293a;--shiplet-ink-soft:#3a4459;--shiplet-muted:#5d6b85;--shiplet-line:#d7dbe3;--shiplet-line-strong:#bfc4cf;--shiplet-surface:#fbf9f4;--shiplet-surface-raised:#fdfcf8;--shiplet-surface-sunken:#f1eee6;--shiplet-action:#c2502f;--shiplet-action-hover:#ad4222;--shiplet-action-strong:#93391b;--shiplet-accent:#2f6e88;--shiplet-accent-strong:#28586c;--shiplet-accent-surface:#e3edf2}",
		"#shiplet-review-root{position:fixed;right:16px;bottom:16px;z-index:2147483000;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--shiplet-ink)}",
		"#shiplet-review-root *{box-sizing:border-box}",
		".shiplet-review-bubble-layer,.shiplet-review-bubble-layer *{box-sizing:border-box}",
		".shiplet-review-comment-list-root,.shiplet-review-comment-list-root *{box-sizing:border-box}",
		"#shiplet-review-root :focus-visible,.shiplet-review-bubble-layer :focus-visible,.shiplet-review-comment-list-root :focus-visible,.shiplet-review-annotation-layer :focus-visible{outline:2px solid var(--shiplet-accent);outline-offset:2px}",
		".shiplet-review-visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}",
		"@media (min-width:1024px){#shiplet-review-root[data-comment-list-open='true']{right:376px}}",
		".shiplet-review-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 11px;border:0;border-radius:7px;background:var(--shiplet-action);color:#fff;font-size:12px;font-weight:750;letter-spacing:0;cursor:pointer;transition:background-color .16s ease-out,transform .16s ease-out}",
		".shiplet-review-button:hover{background:var(--shiplet-action-hover)}",
		".shiplet-review-button:active{transform:translateY(1px)}",
		".shiplet-review-button .shiplet-review-icon-svg{width:14px;height:14px}",
		".shiplet-review-panel{width:min(356px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 24px));display:flex;flex-direction:column;background:var(--shiplet-surface);border:1px solid var(--shiplet-line-strong);border-radius:10px;box-shadow:0 4px 8px rgba(32,41,58,.18);overflow:hidden}",
		".shiplet-review-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border-bottom:1px solid var(--shiplet-line);background:var(--shiplet-surface)}",
		".shiplet-review-sheet-grip{display:none;width:44px;height:4px;border:0;border-radius:999px;background:#bfc4cf;margin:8px auto 0;padding:0}",
		".shiplet-review-title{min-width:0;font-size:13px;font-weight:780;line-height:1.2;color:var(--shiplet-ink)}",
		".shiplet-review-title small{display:block;max-width:160px;margin-top:2px;font-size:10.5px;font-weight:550;color:var(--shiplet-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-actions{display:flex;align-items:center;gap:4px}",
		".shiplet-review-icon,.shiplet-review-small{appearance:none;border:1px solid var(--shiplet-line-strong);background:var(--shiplet-surface-raised);color:var(--shiplet-ink);border-radius:6px;font-size:12px;font-weight:700;line-height:1;cursor:pointer;transition:background-color .16s ease-out,border-color .16s ease-out}",
		".shiplet-review-icon:hover,.shiplet-review-small:hover{background:var(--shiplet-surface-sunken);border-color:var(--shiplet-muted)}",
		".shiplet-review-icon{display:inline-grid;place-items:center;width:30px;height:30px;padding:0;border-color:transparent;background:transparent}",
		".shiplet-review-icon-svg{display:block;width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}",
		".shiplet-review-sheet-toggle{display:none}",
		".shiplet-review-small{height:30px;padding:0 9px;font-size:11px}",
		".shiplet-review-small.primary{border-color:var(--shiplet-action-strong);background:var(--shiplet-action);color:#fff}",
		".shiplet-review-small.primary:hover{background:var(--shiplet-action-hover)}",
		".shiplet-review-small:disabled{opacity:.55;cursor:not-allowed}",
		".shiplet-review-body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px}",
		".shiplet-review-empty{border:1px dashed #5d6b85;border-radius:8px;padding:14px;color:#3a4459;font-size:13px;line-height:1.4;background:#f1eee6}",
		".shiplet-review-error{border:1px solid #d8a79b;border-radius:8px;padding:10px;color:#8c2a1c;background:#f7e3df;font-size:12px;line-height:1.35}",
		".shiplet-review-composer{border:1px solid var(--shiplet-line-strong);border-radius:8px;padding:8px;background:var(--shiplet-surface-raised);display:flex;flex-direction:column;gap:8px}",
		".shiplet-review-target{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--shiplet-ink-soft);background:var(--shiplet-surface-sunken);border-radius:5px;padding:5px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-textarea{width:100%;min-height:78px;resize:vertical;border:0;border-radius:6px;padding:8px;font:inherit;font-size:13px;line-height:1.45;color:var(--shiplet-ink);background:transparent;outline:0}",
		".shiplet-review-textarea::placeholder,.shiplet-review-input::placeholder{color:#5d6b85;opacity:1}",
		".shiplet-review-mention-row{display:flex;flex-wrap:wrap;gap:6px;min-height:0}",
		".shiplet-review-mention-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;height:24px;padding:0 7px;border:1px solid #bfc4cf;border-radius:999px;background:#e3edf2;color:#28586c;font-size:11px;font-weight:750}",
		".shiplet-review-mention-chip[data-access='invited'],.shiplet-review-mention-chip[data-access='invite_required']{background:#fff5df;color:#7a4d06;border-color:#d7b45b}",
		".shiplet-review-mention-chip[data-access='invite_failed']{background:#f7e3df;color:#8c2a1c;border-color:#d8a79b}",
		".shiplet-review-mention-chip button{appearance:none;border:0;background:transparent;color:inherit;font:800 13px/1 ui-sans-serif;cursor:pointer;padding:0}",
		".shiplet-review-mention-menu{display:grid;gap:4px;padding:6px;border:1px solid #bfc4cf;border-radius:8px;background:#fbf9f4;box-shadow:0 4px 8px rgba(32,41,58,.14)}",
		".shiplet-review-mention-option{appearance:none;width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:#20293a;text-align:left;cursor:pointer}",
		".shiplet-review-mention-option:hover{border-color:#2f6e88;background:#e3edf2}",
		".shiplet-review-mention-name{display:grid;gap:2px;font-size:12px;font-weight:750;min-width:0}",
		".shiplet-review-mention-name small{font:600 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5d6b85;overflow-wrap:anywhere}",
		".shiplet-review-settings{display:grid;gap:2px;padding:2px;background:var(--shiplet-surface)}",
		".shiplet-review-settings-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
		".shiplet-review-settings-actions .shiplet-review-small{height:30px}",
		".shiplet-review-toggle{display:flex;align-items:center;gap:9px;min-height:36px;padding:0 6px;border-radius:6px;font-size:12px;font-weight:650;color:var(--shiplet-ink-soft)}",
		".shiplet-review-toggle:hover{background:var(--shiplet-surface-sunken)}",
		".shiplet-review-toggle input{width:16px;height:16px;margin:0;accent-color:var(--shiplet-action)}",
		".shiplet-review-row{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}",
		".shiplet-review-list-summary{display:flex;align-items:center;gap:0}",
		".shiplet-review-list-summary>small{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}",
		".shiplet-review-comment-list-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--shiplet-ink);font:700 11.5px/1 ui-sans-serif,system-ui;cursor:pointer;white-space:nowrap;transition:background-color .16s ease-out,color .16s ease-out}",
		".shiplet-review-comment-list-button:hover,.shiplet-review-comment-list-button[aria-expanded='true']{background:var(--shiplet-accent-surface);color:var(--shiplet-accent-strong)}",
		".shiplet-review-comment-list-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:var(--shiplet-surface-sunken);color:var(--shiplet-muted);font-size:10px;font-weight:800}",
		".shiplet-review-comment-list-root{position:fixed;inset:0;z-index:2147483002;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
		".shiplet-review-comment-list-panel{position:fixed;right:16px;top:16px;bottom:16px;display:flex;flex-direction:column;width:344px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);background:var(--shiplet-surface);border:1px solid var(--shiplet-line-strong);border-radius:10px;box-shadow:0 8px 24px rgba(7,14,26,.22);color:var(--shiplet-ink);pointer-events:auto;z-index:2147483003;overflow:hidden}",
		".shiplet-review-comment-list-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;min-height:54px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--shiplet-line);background:var(--shiplet-surface)}",
		".shiplet-review-comment-list-heading{display:grid;grid-template-columns:auto auto;align-items:baseline;gap:2px 7px;min-width:0}",
		".shiplet-review-comment-list-title{margin:0;color:var(--shiplet-ink);font-size:14px;font-weight:780;line-height:1.2}",
		".shiplet-review-comment-list-meta{margin:0;color:var(--shiplet-muted);font-size:11px;font-weight:600;line-height:1.35}",
		".shiplet-review-context{grid-column:1/-1;max-width:156px;margin:0;overflow:hidden;color:var(--shiplet-muted);font:550 9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-comment-list-header-actions{display:flex;align-items:center;gap:4px}",
		".shiplet-review-comment-list-new{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 9px;border:1px solid var(--shiplet-action-strong);border-radius:6px;background:var(--shiplet-action);color:#fff;font-family:ui-sans-serif,system-ui,sans-serif;font-size:11px;font-weight:750;line-height:1;cursor:pointer}",
		".shiplet-review-comment-list-new:hover{background:var(--shiplet-action-hover)}",
		".shiplet-review-comment-list-new .shiplet-review-icon-svg{width:13px;height:13px}",
		".shiplet-review-comment-list-close{appearance:none;display:inline-grid;place-items:center;flex:0 0 auto;width:32px;height:32px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--shiplet-ink);cursor:pointer}",
		".shiplet-review-comment-list-close:hover{background:var(--shiplet-surface-sunken)}",
		".shiplet-review-comment-list-items{display:flex;flex:1 1 auto;flex-direction:column;min-height:0;margin:0;padding:0;overflow-y:auto;overscroll-behavior:contain;list-style:none}",
		".shiplet-review-comment-list-empty{margin:auto;padding:24px;color:var(--shiplet-muted);font-size:13px;line-height:1.5;text-align:center}",
		".shiplet-review-comment-list-item{display:flex;flex:0 0 auto;flex-direction:column;border-bottom:1px solid var(--shiplet-line);background:var(--shiplet-surface)}",
		".shiplet-review-comment-list-item-main{display:grid;grid-template-columns:1fr;align-items:start;gap:6px;padding:10px 12px}",
		".shiplet-review-comment-list-item-main:hover{background:color-mix(in srgb,var(--shiplet-accent-surface) 38%,transparent)}",
		".shiplet-review-comment-list-item.is-active .shiplet-review-comment-list-item-main{background:color-mix(in srgb,var(--shiplet-accent-surface) 42%,transparent)}",
		".shiplet-review-comment-list-item-button{appearance:none;display:flex;align-items:flex-start;gap:10px;width:100%;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
		".shiplet-review-comment-list-avatar{display:inline-grid;place-items:center;flex:0 0 auto;width:30px;height:30px;border:1px solid color-mix(in srgb,var(--shiplet-accent) 38%,transparent);border-radius:999px;background:var(--shiplet-accent-surface);color:var(--shiplet-accent-strong);font-size:9px;font-weight:850;letter-spacing:.01em}",
		".shiplet-review-comment-list-avatar-small{width:24px;height:24px;font-size:8px}",
		".shiplet-review-comment-list-index{display:inline-flex;align-items:center;justify-content:center;height:18px;margin-left:auto;padding:0 5px;border:1px solid color-mix(in srgb,var(--shiplet-accent) 45%,transparent);border-radius:4px;background:var(--shiplet-accent-surface);color:var(--shiplet-accent-strong);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8.5px;font-weight:800;line-height:1}",
		".shiplet-review-comment-list-body{display:flex;flex:1;flex-direction:column;gap:5px;min-width:0}",
		".shiplet-review-comment-list-item-header{display:flex;align-items:center;gap:6px;min-height:20px;min-width:0}",
		".shiplet-review-comment-list-name{overflow:hidden;color:var(--shiplet-ink);font-size:11.5px;font-weight:760;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-comment-list-time{overflow:hidden;color:var(--shiplet-muted);font-size:9.5px;font-weight:550;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-comment-list-comment{display:block;color:var(--shiplet-ink-soft);font-size:12px;font-weight:500;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}",
		".shiplet-review-comment-list-thread-actions{display:flex;align-items:center;gap:5px;padding-left:40px}",
		".shiplet-review-status-label,.shiplet-review-comment-list-reply-count{color:var(--shiplet-muted);font-size:9.5px;font-weight:700}",
		".shiplet-review-status-label{margin-right:auto}",
		".shiplet-review-thread-action{appearance:none;height:26px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--shiplet-ink-soft);font:750 10px/1 ui-sans-serif,system-ui;cursor:pointer}",
		".shiplet-review-thread-action:hover{background:var(--shiplet-surface-sunken)}",
		".shiplet-review-thread-more{position:relative}",
		".shiplet-review-thread-more summary{display:grid;place-items:center;width:26px;height:26px;border-radius:5px;color:var(--shiplet-ink-soft);cursor:pointer;list-style:none;font:800 10px/1 ui-sans-serif}",
		".shiplet-review-thread-more summary::-webkit-details-marker{display:none}",
		".shiplet-review-thread-more[open] summary{background:var(--shiplet-surface-sunken)}",
		".shiplet-review-thread-more .shiplet-review-comment-list-status-select{position:absolute;right:0;top:30px;z-index:2;width:112px;height:30px;box-shadow:0 5px 16px rgba(7,14,26,.18)}",
		".shiplet-review-thread-nav{display:flex;align-items:center}",
		".shiplet-review-thread-nav .shiplet-review-comment-list-close{width:26px;height:30px}",
		".shiplet-review-comment-list-status-select{width:90px;height:24px;border:1px solid var(--shiplet-line-strong);border-radius:5px;background:var(--shiplet-surface-raised);color:var(--shiplet-ink);font:650 10px/1.2 ui-sans-serif,system-ui;padding:2px 4px}",
		".shiplet-review-comment-list-send-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:5px;background:var(--shiplet-action);color:#fff;font:750 0/1 ui-sans-serif;cursor:pointer}",
		".shiplet-review-comment-list-send-button::after{content:'→';font-size:15px}",
		".shiplet-review-comment-list-send-button:hover{background:var(--shiplet-action-hover)}",
		".shiplet-review-comment-list-replies{padding:2px 12px 6px 52px}",
		".shiplet-review-comment-list-replies-title{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}",
		".shiplet-review-comment-list-replies-items{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}",
		".shiplet-review-comment-list-reply{display:flex;align-items:flex-start;gap:8px;padding:7px 0}",
		".shiplet-review-comment-list-reply-body{flex:1;min-width:0}",
		".shiplet-review-comment-list-reply-header{display:flex;align-items:center;gap:6px;margin-bottom:3px}",
		".shiplet-review-comment-list-reply-name{overflow:hidden;color:var(--shiplet-ink);font-size:10.5px;font-weight:750;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-comment-list-reply-time{overflow:hidden;color:var(--shiplet-muted);font-size:9px;font-weight:550;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}",
		".shiplet-review-comment-list-reply-comment{margin:0;color:var(--shiplet-ink-soft);font-size:11.5px;font-weight:500;line-height:1.45;overflow-wrap:anywhere;white-space:pre-wrap}",
		".shiplet-review-comment-list-reply-form{display:flex;align-items:flex-start;gap:8px;padding:4px 12px 12px 52px}",
		".shiplet-review-comment-list-reply-actions{display:grid;grid-template-columns:minmax(0,1fr) 30px;gap:5px;flex:1;min-width:0}",
		".shiplet-review-ticket-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:750;letter-spacing:.04em;text-transform:uppercase;color:var(--shiplet-accent-strong);background:var(--shiplet-accent-surface);border:1px solid color-mix(in srgb,var(--shiplet-accent) 45%,transparent);border-radius:5px;padding:3px 6px}",
		".shiplet-review-select{height:28px;max-width:134px;border:1px solid var(--shiplet-line-strong);border-radius:6px;background:var(--shiplet-surface-raised);font-size:12px;color:var(--shiplet-ink)}",
		".shiplet-review-input{min-width:0;height:30px;border:1px solid var(--shiplet-line-strong);border-radius:5px;padding:0 8px;font:inherit;font-size:11.5px;background:var(--shiplet-surface-raised);color:var(--shiplet-ink)}",
		".shiplet-review-highlight{position:fixed;z-index:2147482999;pointer-events:none;border:2px solid #c2502f;background:rgba(194,80,47,.12);border-radius:6px;display:none}",
		".shiplet-review-picker-cursor{position:fixed;left:0;top:0;z-index:2147483004;display:none;pointer-events:none;transform:translate(12px,12px);filter:drop-shadow(0 10px 20px rgba(32,41,58,.26))}",
		".shiplet-review-picker-cursor svg{display:block;width:38px;height:34px}",
		".shiplet-review-picker-cursor span{position:absolute;left:13px;top:8px;width:10px;height:10px;border-radius:999px;background:#fbf9f4;box-shadow:9px 0 0 #fbf9f4,18px 0 0 #fbf9f4}",
		".shiplet-review-launcher{display:flex;align-items:center;justify-content:flex-end;gap:2px;max-width:calc(100vw - 24px);padding:4px;border:1px solid var(--shiplet-line-strong);border-radius:10px;background:color-mix(in srgb,var(--shiplet-surface) 96%,transparent);box-shadow:0 3px 7px rgba(32,41,58,.18)}",
		".shiplet-review-launcher-meta{display:flex;align-items:center;gap:2px}",
		".shiplet-review-sleeper{appearance:none;display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 10px;border:1px solid rgba(255,255,255,.72);border-radius:9px;background:#20293a;color:#fff;box-shadow:0 3px 9px rgba(7,14,26,.28);font:750 12px/1 ui-sans-serif,system-ui;cursor:pointer}",
		".shiplet-review-sleeper:hover{background:#2d374b}",
		".shiplet-review-sleeper kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border:1px solid rgba(255,255,255,.42);border-radius:4px;background:rgba(255,255,255,.08);color:#fff;font:750 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace}",
		".shiplet-review-launcher[data-expanded='true']{animation:shiplet-review-enter .16s ease-out both}",
		"@keyframes shiplet-review-enter{from{opacity:0;transform:translateY(3px) scale(.985)}to{opacity:1;transform:none}}",
		".shiplet-review-inline-composer{position:fixed;z-index:2147483001;width:min(368px,calc(100vw - 24px));border:1px solid var(--shiplet-line-strong);border-radius:10px;background:var(--shiplet-surface);color:var(--shiplet-ink);box-shadow:0 4px 8px rgba(32,41,58,.2);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
		".shiplet-review-inline-composer::before{content:\"\";position:absolute;width:12px;height:12px;background:var(--shiplet-surface);transform:rotate(45deg)}",
		".shiplet-review-inline-composer[data-placement='right']::before{left:-7px;top:calc(var(--shiplet-arrow-offset) * 1px - 6px);border-left:1px solid var(--shiplet-line-strong);border-bottom:1px solid var(--shiplet-line-strong)}",
		".shiplet-review-inline-composer[data-placement='left']::before{right:-7px;top:calc(var(--shiplet-arrow-offset) * 1px - 6px);border-right:1px solid var(--shiplet-line-strong);border-top:1px solid var(--shiplet-line-strong)}",
		".shiplet-review-inline-composer[data-placement='below']::before{left:calc(var(--shiplet-arrow-offset) * 1px - 6px);top:-7px;border-left:1px solid var(--shiplet-line-strong);border-top:1px solid var(--shiplet-line-strong)}",
		".shiplet-review-inline-composer[data-placement='above']::before{left:calc(var(--shiplet-arrow-offset) * 1px - 6px);bottom:-7px;border-right:1px solid var(--shiplet-line-strong);border-bottom:1px solid var(--shiplet-line-strong)}",
		".shiplet-review-inline-context{position:relative;z-index:1;display:flex;align-items:center;gap:9px;min-height:50px;padding:8px 9px 8px 10px;border-bottom:1px solid var(--shiplet-line)}",
		".shiplet-review-inline-avatar{display:inline-grid;place-items:center;flex:0 0 auto;width:28px;height:28px;border:1px solid color-mix(in srgb,var(--shiplet-accent) 38%,transparent);border-radius:999px;background:var(--shiplet-accent-surface);color:var(--shiplet-accent-strong);font-size:9px;font-weight:850}",
		".shiplet-review-inline-context-copy{display:flex;align-items:center;gap:7px;min-width:0;color:var(--shiplet-muted);font-size:10.5px;font-weight:650}",
		".shiplet-review-inline-context-copy>span{flex:0 0 auto}",
		".shiplet-review-inline-context-copy .shiplet-review-target{min-width:0;max-width:200px}",
		".shiplet-review-inline-editor{position:relative;z-index:1}",
		".shiplet-review-inline-row{position:relative;z-index:1;display:block}",
		".shiplet-review-inline-textarea{display:block;width:100%;min-height:76px;max-height:144px;resize:none;overflow:hidden;border:0;padding:11px 12px;font:inherit;font-size:13px;line-height:1.45;color:var(--shiplet-ink);background:transparent;outline:0}",
		"#shiplet-review-root .shiplet-review-inline-textarea:focus-visible{outline:0;box-shadow:inset 0 0 0 2px var(--shiplet-accent)}",
		".shiplet-review-inline-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 9px;border-top:1px solid var(--shiplet-line)}",
		".shiplet-review-inline-tools,.shiplet-review-inline-actions{display:flex;align-items:center;gap:6px}",
		".shiplet-review-inline-tools>span{color:var(--shiplet-muted);font-size:9.5px;font-weight:600;white-space:nowrap}",
		".shiplet-review-inline-tool,.shiplet-review-inline-cancel,.shiplet-review-inline-submit{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:30px;border-radius:6px;padding:0 9px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:10.5px;font-weight:700;line-height:1;cursor:pointer}",
		".shiplet-review-inline-tool,.shiplet-review-inline-cancel{border:1px solid var(--shiplet-line-strong);background:var(--shiplet-surface-raised);color:var(--shiplet-ink-soft)}",
		".shiplet-review-inline-tool:hover,.shiplet-review-inline-cancel:hover{background:var(--shiplet-surface-sunken)}",
		".shiplet-review-inline-submit{border:1px solid var(--shiplet-action-strong);background:var(--shiplet-action);color:#fff}",
		".shiplet-review-inline-submit:hover{background:var(--shiplet-action-hover)}",
		".shiplet-review-inline-submit:disabled{opacity:.58;cursor:not-allowed}",
		".shiplet-review-inline-close{appearance:none;display:grid;place-items:center;flex:0 0 auto;width:28px;height:28px;margin-left:auto;border:0;border-radius:6px;background:transparent;color:var(--shiplet-ink);cursor:pointer}",
		".shiplet-review-inline-close:hover{background:var(--shiplet-surface-sunken)}",
		".shiplet-review-bubble-layer{position:fixed;inset:0;z-index:2147482998;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
		".shiplet-review-bubble{position:absolute;left:0;top:0;pointer-events:auto;display:grid;place-items:center;width:28px;height:28px;border:2px solid #fff;border-radius:999px;background:var(--shiplet-action);color:#fff;box-shadow:0 0 0 1px var(--shiplet-action-strong),0 3px 8px rgba(7,14,26,.34);cursor:pointer;transform:translate(-50%,-50%) scale(1);transition:left .2s cubic-bezier(.16,1,.3,1),top .2s cubic-bezier(.16,1,.3,1),transform .2s ease-out,background-color .16s ease-out;overflow:hidden}",
		".shiplet-review-bubble[data-status='Done'],.shiplet-review-bubble[data-status='Dropped']{border-color:var(--shiplet-muted);background:var(--shiplet-muted)}",
		".shiplet-review-bubble:hover{transform:translate(-50%,-54%) scale(1.06)}",
		".shiplet-review-bubble-label{position:relative;z-index:1;display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:999px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:850;color:#fff}",
		".shiplet-review-bubble-card{display:none;position:relative;z-index:2;width:100%;height:100%;box-sizing:border-box;min-width:0;overflow:hidden;padding:12px;background:var(--shiplet-surface);color:var(--shiplet-ink)}",
		".shiplet-review-bubble.is-expanded{height:auto;min-height:168px;border-color:var(--shiplet-line-strong);border-radius:10px;background:var(--shiplet-surface);place-items:stretch;transform:none;overflow-x:hidden;overflow-y:auto;box-shadow:0 4px 8px rgba(32,41,58,.2)}",
		".shiplet-review-bubble.is-expanded:hover{transform:none}",
		".shiplet-review-bubble.is-expanded .shiplet-review-bubble-label{display:none}",
		".shiplet-review-bubble.is-expanded .shiplet-review-bubble-card{display:grid;gap:8px}",
		".shiplet-review-bubble.is-expanded .shiplet-review-row{justify-content:flex-start;flex-wrap:wrap;min-width:0}",
		".shiplet-review-bubble-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
		".shiplet-review-bubble-card-text{min-width:0;margin:0;font-size:13px;line-height:1.35;overflow-wrap:anywhere;white-space:pre-wrap}",
		".shiplet-review-bubble-card-meta{min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:#5d6b85;overflow-wrap:anywhere}",
		".shiplet-review-bubble-dismiss{justify-self:start}",
		".shiplet-review-presence{position:fixed;right:16px;top:16px;z-index:2147482996;display:flex;align-items:center;gap:6px;padding:5px;border:1px solid rgba(32,41,58,.22);border-radius:999px;background:#fbf9f4;box-shadow:0 3px 7px rgba(32,41,58,.16);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
		".shiplet-review-presence-avatar{appearance:none;position:relative;width:32px;height:32px;border:2px solid #20293a;border-radius:999px;background:#fdfcf8;background-repeat:no-repeat;background-size:cover;background-position:center;box-shadow:0 2px 0 rgba(32,41,58,.22);cursor:pointer;padding:0;overflow:hidden}",
		".shiplet-review-presence-avatar.is-self{cursor:default}",
		".shiplet-review-presence-avatar.is-following{border-color:#c2502f;box-shadow:0 0 0 3px rgba(194,80,47,.2)}",
		".shiplet-review-presence-avatar span{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;min-width:18px;height:18px;border-radius:999px;background:rgba(251,249,244,.86);color:#20293a;font:800 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}",
		".shiplet-review-follow-pill{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147482996;display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #20293a;border-radius:999px;background:#fbf9f4;color:#20293a;box-shadow:0 3px 7px rgba(32,41,58,.18);font:750 12px/1 ui-sans-serif,system-ui}",
		".shiplet-review-follow-pill button{appearance:none;border:1px solid #20293a;border-radius:999px;background:#fdfcf8;color:#20293a;font:750 11px/1 ui-sans-serif;padding:4px 8px;cursor:pointer}",
		".shiplet-review-cursor-layer{position:fixed;inset:0;z-index:2147482995;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
		".shiplet-review-remote-cursor{position:absolute;left:0;top:0;transform:translate(-3px,-2px);transition:left .08s linear,top .08s linear;color:#20293a}",
		".shiplet-review-remote-cursor svg{display:block;filter:drop-shadow(0 2px 4px rgba(32,41,58,.28))}",
		".shiplet-review-remote-cursor span{position:absolute;left:14px;top:18px;max-width:160px;padding:4px 7px;border-radius:999px;background:#20293a;color:#fff;font-size:11px;font-weight:750;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		".shiplet-review-annotation-layer{position:fixed;inset:0;z-index:2147482997;pointer-events:none;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
		".shiplet-review-annotation-layer.is-editing{z-index:2147483001;pointer-events:auto;cursor:crosshair}",
		".shiplet-review-annotation-editor{position:absolute;inset:0;background:rgba(32,41,58,.08)}",
		".shiplet-review-annotation-hitarea,.shiplet-review-annotation-svg{position:absolute;inset:0;width:100vw;height:100vh;touch-action:none;overflow:visible}",
		".shiplet-review-annotation-toolbar{position:absolute;left:50%;top:14px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;max-width:calc(100vw - 28px);padding:8px;border:1px solid #20293a;border-radius:10px;background:#fbf9f4;box-shadow:0 4px 8px rgba(32,41,58,.22);pointer-events:auto}",
		".shiplet-review-annotation-tool-group{display:flex;align-items:center;gap:4px;padding-right:6px;border-right:1px solid #bfc4cf}",
		".shiplet-review-annotation-button{appearance:none;display:inline-grid;place-items:center;min-width:32px;height:32px;border:1px solid #20293a;border-bottom-width:2px;border-radius:6px;background:#fdfcf8;color:#20293a;font:800 12px/1 ui-sans-serif,system-ui;cursor:pointer}",
		".shiplet-review-annotation-button:hover,.shiplet-review-annotation-button[aria-pressed='true']{background:#e3edf2;color:#28586c}",
		".shiplet-review-annotation-button.primary{display:inline-flex;gap:5px;padding:0 10px;border-color:#93391b;background:#c2502f;color:#fff}",
		".shiplet-review-annotation-button:disabled{opacity:.5;cursor:not-allowed}",
		".shiplet-review-annotation-color{width:32px;height:32px;padding:2px;border:1px solid #20293a;border-radius:6px;background:#fdfcf8;cursor:pointer}",
		".shiplet-review-annotation-range{width:76px;accent-color:#c2502f}",
		".shiplet-review-annotation-hint{position:absolute;left:50%;top:66px;transform:translateX(-50%);max-width:min(420px,calc(100vw - 28px));margin:0;padding:6px 10px;border-radius:999px;background:rgba(251,249,244,.94);color:#3a4459;font-size:12px;font-weight:700;box-shadow:0 8px 24px rgba(32,41,58,.16);pointer-events:none}",
		".shiplet-review-annotation-textbox{position:absolute;min-width:140px;min-height:58px;border:2px solid #c2502f;border-radius:8px;background:rgba(251,249,244,.95);box-shadow:0 4px 8px rgba(32,41,58,.2);pointer-events:auto;overflow:hidden}",
		".shiplet-review-annotation-textbox textarea{width:100%;height:100%;min-height:58px;border:0;background:transparent;color:#20293a;font:800 18px/1.25 ui-sans-serif,system-ui;padding:9px;resize:none;outline:0}",
		".shiplet-review-annotation-text-mark{font:800 18px/1.25 ui-sans-serif,system-ui;white-space:pre-wrap;overflow-wrap:anywhere;text-shadow:0 1px 0 rgba(251,249,244,.9),0 -1px 0 rgba(251,249,244,.9),1px 0 0 rgba(251,249,244,.9),-1px 0 0 rgba(251,249,244,.9)}",
		"body.shiplet-review-capturing,body.shiplet-review-capturing *{cursor:none!important}",
		"body.shiplet-review-capturing #shiplet-review-root,body.shiplet-review-capturing #shiplet-review-root *,body.shiplet-review-capturing .shiplet-review-comment-list-root,body.shiplet-review-capturing .shiplet-review-comment-list-root *{cursor:auto!important}",
		"@media (max-width:859px){#shiplet-review-root[data-comment-list-open='true']{right:16px}.shiplet-review-bubble-layer{display:none}.shiplet-review-comment-list-panel{width:360px}.shiplet-review-comment-list-item-main{grid-template-columns:1fr}.shiplet-review-comment-list-thread-actions{padding-left:40px}.shiplet-review-comment-list-status-select{width:auto;min-width:104px}.shiplet-review-comment-list-replies,.shiplet-review-comment-list-reply-form{padding-left:54px}}",
		"@media (max-width:640px){#shiplet-review-root,#shiplet-review-root[data-comment-list-open='true']{left:auto;right:12px;bottom:12px}.shiplet-review-launcher{max-width:calc(100vw - 24px)}.shiplet-review-button,.shiplet-review-comment-list-button,.shiplet-review-icon{min-height:44px}.shiplet-review-button{height:44px;padding:0 13px;font-size:14px}.shiplet-review-comment-list-button{height:44px;font-size:14px}.shiplet-review-icon{width:44px;height:44px}.shiplet-review-panel{position:fixed;left:0;right:0;bottom:0;width:100vw;max-height:82dvh;border-radius:12px 12px 0 0;border-left:0;border-right:0;border-bottom:0}.shiplet-review-sheet-grip{display:block}.shiplet-review-sheet-toggle{display:inline-flex}.shiplet-review-bottom-sheet.shiplet-review-sheet-collapsed{transform:translateY(calc(100% - 62px))}.shiplet-review-bottom-sheet{transition:transform .24s cubic-bezier(.16,1,.3,1)}.shiplet-review-bottom-sheet.shiplet-review-sheet-collapsed .shiplet-review-body{display:none}.shiplet-review-body{max-height:calc(82dvh - 56px)}.shiplet-review-inline-composer{max-width:calc(100vw - 24px)}.shiplet-review-inline-context-copy{font-size:12px}.shiplet-review-inline-textarea{min-height:88px;font-size:14px}.shiplet-review-inline-footer{align-items:flex-end}.shiplet-review-inline-tools>span{display:none}.shiplet-review-inline-tool,.shiplet-review-inline-cancel,.shiplet-review-inline-submit{min-height:44px;font-size:13px}.shiplet-review-comment-list-panel{left:0;right:0;top:0;bottom:0;width:auto;max-width:none;max-height:none;border-radius:0;border:0}.shiplet-review-comment-list-header{min-height:64px;padding-left:16px}.shiplet-review-comment-list-title{font-size:16px}.shiplet-review-comment-list-meta,.shiplet-review-comment-list-name,.shiplet-review-comment-list-comment,.shiplet-review-comment-list-reply-name,.shiplet-review-comment-list-reply-comment,.shiplet-review-input{font-size:14px}.shiplet-review-comment-list-new,.shiplet-review-comment-list-close{min-height:44px}.shiplet-review-comment-list-new{font-size:13px}.shiplet-review-comment-list-close{width:44px}.shiplet-review-comment-list-item-main{padding:16px}.shiplet-review-comment-list-thread-actions{padding-left:40px}.shiplet-review-comment-list-replies,.shiplet-review-comment-list-reply-form{padding-left:56px;padding-right:16px}.shiplet-review-comment-list-reply-actions{grid-template-columns:minmax(0,1fr) 44px}.shiplet-review-input,.shiplet-review-comment-list-send-button{height:44px}.shiplet-review-comment-list-status-select{height:44px;font-size:13px}.shiplet-review-annotation-toolbar{left:8px;right:8px;top:8px;transform:none;justify-content:center;flex-wrap:wrap}.shiplet-review-annotation-hint{top:104px}}",
		"@media (max-width:640px){.shiplet-review-sleeper{min-width:44px;min-height:44px}.shiplet-review-comment-list-panel{left:8px;right:8px;top:auto;bottom:8px;width:auto;max-width:none;max-height:min(70dvh,620px);border:1px solid var(--shiplet-line-strong);border-radius:12px}.shiplet-review-comment-list-header{min-height:56px;padding:6px 6px 6px 12px}.shiplet-review-comment-list-heading{gap:1px 6px}.shiplet-review-context{max-width:130px}.shiplet-review-comment-list-new{width:44px;padding:0;justify-content:center}.shiplet-review-comment-list-new span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.shiplet-review-thread-nav .shiplet-review-comment-list-close{width:44px}.shiplet-review-comment-list-item-main{padding:12px}.shiplet-review-comment-list-thread-actions{padding-left:40px}.shiplet-review-thread-action{min-height:44px;padding:0 9px}.shiplet-review-thread-more summary{width:44px;height:44px}.shiplet-review-comment-list-replies,.shiplet-review-comment-list-reply-form{padding-left:52px;padding-right:12px}}",
		"@media (prefers-reduced-motion:reduce){.shiplet-review-button,.shiplet-review-icon,.shiplet-review-small,.shiplet-review-comment-list-button,.shiplet-review-bubble,.shiplet-review-bottom-sheet,.shiplet-review-remote-cursor{transition:none!important;animation:none!important}.shiplet-review-launcher[data-expanded='true']{animation:none!important}.shiplet-review-bubble:hover{transform:translate(-50%,-50%)}.shiplet-review-bubble.is-expanded:hover{transform:none}}",
	].join("");
	document.head.appendChild(css);

	const root = document.createElement("div");
	root.id = "shiplet-review-root";
	document.body.appendChild(root);

	const bubbleLayer = document.createElement("div");
	bubbleLayer.className = "shiplet-review-bubble-layer";
	document.body.appendChild(bubbleLayer);

	const commentListRoot = document.createElement("div");
	commentListRoot.className = "shiplet-review-comment-list-root";
	document.body.appendChild(commentListRoot);

	const highlight = document.createElement("div");
	highlight.className = "shiplet-review-highlight";
	document.body.appendChild(highlight);

	const pickerCursor = document.createElement("div");
	pickerCursor.className = "shiplet-review-picker-cursor";
	pickerCursor.innerHTML = "<svg viewBox='0 0 44 38' aria-hidden='true'><path d='M6 4h28a6 6 0 0 1 6 6v13a6 6 0 0 1-6 6H20l-9 6 2-6H6a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6Z' fill='#c2502f' stroke='#20293a' stroke-width='2.25' stroke-linejoin='round'/></svg><span aria-hidden='true'></span>";
	document.body.appendChild(pickerCursor);

	const annotationLayer = document.createElement("div");
	annotationLayer.className = "shiplet-review-annotation-layer";
	document.body.appendChild(annotationLayer);

	const presenceRoot = document.createElement("div");
	presenceRoot.className = "shiplet-review-presence-root";
	document.body.appendChild(presenceRoot);

	const cursorLayer = document.createElement("div");
	cursorLayer.className = "shiplet-review-cursor-layer";
	document.body.appendChild(cursorLayer);

	function endpoint(path) {
		return apiBase + "/api/projects/" + encodeURIComponent(projectId) + path;
	}

	function esc(value) {
		return String(value == null ? "" : value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function cssUrl(value) {
		return String(value || "").replace(/["\\\n\r]/g, "");
	}

	function clientFeedbackId() {
		const random = Math.random().toString(36).slice(2, 10);
		return "client-" + Date.now().toString(36) + "-" + random;
	}

	function readPresenceGuest() {
		try {
			const parsed = JSON.parse(localStorage.getItem(presenceGuestStorageKey) || "null");
			if (parsed && parsed.id && parsed.name) return parsed;
		} catch {
			// Fall through and create a fresh guest identity.
		}
		const random = Math.random().toString(36).slice(2, 10);
		const id = "guest_" + random;
		const number = 100 + Math.floor(Math.random() * 900);
		const preset = avatarPresets[Math.floor(Math.random() * avatarPresets.length)] || avatarPresets[0] || { id: "aurora-grid" };
		const colors = ["#c2502f", "#2f6e88", "#3f7d50", "#c3922e", "#5d6b85", "#8c4a75"];
		const guest = {
			id,
			kind: "guest",
			name: "Guest " + number,
			email: null,
			avatarPreset: preset.id || "aurora-grid",
			avatarDataUrl: null,
			color: colors[number % colors.length],
		};
		try {
			localStorage.setItem(presenceGuestStorageKey, JSON.stringify(guest));
		} catch {
			// Guest identity still works for this page load.
		}
		return guest;
	}

	function currentPresenceViewer() {
		const user = config.user || null;
		if (user && user.id && user.id !== "sandbox") {
			return {
				id: String(user.id),
				kind: "user",
				name: user.name || user.email || "Reviewer",
				email: user.email || null,
				avatarPreset: user.avatarPreset || "aurora-grid",
				avatarDataUrl: user.avatarDataUrl || null,
				color: "#2f6e88",
			};
		}
		return readPresenceGuest();
	}

	function avatarPresetFor(id) {
		return avatarPresets.find((preset) => preset.id === id) || avatarPresets[0] || { column: 0, row: 0 };
	}

	function avatarBackgroundForViewer(viewer) {
		if (viewer && viewer.avatarDataUrl) {
			return "background-image:url('" + cssUrl(viewer.avatarDataUrl) + "');background-size:cover;background-position:center;";
		}
		const preset = avatarPresetFor(viewer && viewer.avatarPreset);
		const x = avatarSpriteColumns <= 1 ? 0 : (Number(preset.column || 0) / (avatarSpriteColumns - 1)) * 100;
		const y = avatarSpriteRows <= 1 ? 0 : (Number(preset.row || 0) / (avatarSpriteRows - 1)) * 100;
		return "background-color:" + cssUrl(viewer && viewer.color || "#fdfcf8") + ";background-image:url('" + avatarSpriteUrl + "');background-size:" + avatarSpriteColumns * 100 + "% " + avatarSpriteRows * 100 + "%;background-position:" + x + "% " + y + "%;";
	}

	function initialsFor(name) {
		const cleaned = String(name || "Guest").trim();
		const parts = cleaned.split(/\s+/).filter(Boolean);
		return (parts.length > 1 ? parts[0][0] + parts[1][0] : cleaned.slice(0, 2)).toUpperCase();
	}

	function reviewerDisplayName(value) {
		const raw = String(value || "Reviewer").trim();
		if (!raw.includes("@")) return raw;
		const localPart = raw.split("@")[0] || "Reviewer";
		return localPart
			.split(/[._-]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ") || "Reviewer";
	}

	function readPreviewStorage(key) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	function writePreviewStorage(key, value) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Annotation preferences are best-effort.
		}
	}

	function readBooleanPreference(key, fallback) {
		const value = readPreviewStorage(key);
		if (value === "true") return true;
		if (value === "false") return false;
		return fallback;
	}

	function writeBooleanPreference(key, value) {
		writePreviewStorage(key, value ? "true" : "false");
	}

	function normalizeAnnotationTool(value) {
		return value === "arrow" || value === "text" ? value : "pen";
	}

	function normalizeAnnotationColor(value) {
		const color = String(value || "").trim();
		return /^#[0-9a-f]{6}$/i.test(color) ? color : "#ff0033";
	}

	function normalizeAnnotationStrokeWidth(value) {
		const width = Number(value);
		return Number.isFinite(width) ? Math.max(1, Math.min(10, Math.round(width))) : 4;
	}

	function readAnnotationTool() {
		return normalizeAnnotationTool(readPreviewStorage(annotationToolStorageKey));
	}

	function readAnnotationColor() {
		return normalizeAnnotationColor(readPreviewStorage(annotationColorStorageKey));
	}

	function readAnnotationStrokeWidth() {
		return normalizeAnnotationStrokeWidth(readPreviewStorage(annotationStrokeWidthStorageKey));
	}

	function setAnnotationTool(tool) {
		state.annotationTool = normalizeAnnotationTool(tool);
		writePreviewStorage(annotationToolStorageKey, state.annotationTool);
		renderAnnotations();
	}

	function setAnnotationColor(color) {
		state.annotationColor = normalizeAnnotationColor(color);
		writePreviewStorage(annotationColorStorageKey, state.annotationColor);
		renderAnnotations();
	}

	function setAnnotationStrokeWidth(width) {
		state.annotationStrokeWidth = normalizeAnnotationStrokeWidth(width);
		writePreviewStorage(annotationStrokeWidthStorageKey, String(state.annotationStrokeWidth));
		renderAnnotations();
	}

	function createAnnotationId() {
		if (window.crypto && typeof window.crypto.randomUUID === "function") {
			return window.crypto.randomUUID();
		}
		return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
	}

	function mergeFailureNotes(first, second) {
		const notes = [first, second].filter(Boolean);
		return notes.length ? notes.join(" ") : null;
	}

	function annotationPoint(event) {
		return {
			x: Math.round(Number(event.pageX || 0)),
			y: Math.round(Number(event.pageY || 0)),
		};
	}

	function viewportPoint(point) {
		return {
			x: Math.round(Number(point.x || 0) - window.scrollX),
			y: Math.round(Number(point.y || 0) - window.scrollY),
		};
	}

	function activeAnnotations() {
		let annotations = state.annotations.slice();
		if (state.annotationDraft) annotations = annotations.concat(state.annotationDraft);
		if (state.activeTextBox && state.activeTextBox.text.trim()) {
			annotations = annotations.filter((annotation) => annotation.id !== state.activeTextBox.id);
			annotations.push({
				id: state.activeTextBox.id,
				type: "text",
				position: state.activeTextBox.position,
				size: state.activeTextBox.size,
				text: state.activeTextBox.text,
				color: state.activeTextBox.color,
			});
		}
		return annotations;
	}

	function commitActiveTextBox() {
		if (!state.activeTextBox) return;
		const textBox = state.activeTextBox;
		state.annotations = state.annotations.filter((annotation) => annotation.id !== textBox.id);
		if (textBox.text.trim()) {
			state.annotations.push({
				id: textBox.id,
				type: "text",
				position: textBox.position,
				size: textBox.size,
				text: textBox.text,
				color: textBox.color,
			});
		}
		state.activeTextBox = null;
	}

	function clearAnnotations() {
		state.annotationEditorOpen = false;
		state.annotationDraft = null;
		state.annotationPointerId = null;
		state.activeTextBox = null;
		state.annotations = [];
		renderAnnotations();
	}

	function annotationStylePoint(point) {
		const view = viewportPoint(point);
		return { x: Math.round(view.x), y: Math.round(view.y) };
	}

	function arrowHeadSegments(start, end, size) {
		const angle = Math.atan2(end.y - start.y, end.x - start.x);
		const left = {
			x: end.x - Math.cos(angle - Math.PI / 6) * size,
			y: end.y - Math.sin(angle - Math.PI / 6) * size,
		};
		const right = {
			x: end.x - Math.cos(angle + Math.PI / 6) * size,
			y: end.y - Math.sin(angle + Math.PI / 6) * size,
		};
		return { left, right };
	}

	function svgNumber(value) {
		const number = Number(value);
		return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0;
	}

	function annotationMarksHtml(annotations) {
		return annotations.map((annotation) => {
			const color = esc(normalizeAnnotationColor(annotation.color));
			if (annotation.type === "text") {
				const point = annotationStylePoint(annotation.position || { x: 0, y: 0 });
				const size = annotation.size || { width: 220, height: 86 };
				return "<foreignObject x='" + svgNumber(point.x) + "' y='" + svgNumber(point.y) + "' width='" + svgNumber(size.width || 220) + "' height='" + svgNumber(size.height || 86) + "'>" +
					"<div xmlns='http://www.w3.org/1999/xhtml' class='shiplet-review-annotation-text-mark' style='color:" + color + "'>" + esc(annotation.text || "") + "</div>" +
				"</foreignObject>";
			}
			if (annotation.type === "arrow") {
				const start = annotationStylePoint(annotation.start || { x: 0, y: 0 });
				const end = annotationStylePoint(annotation.end || start);
				const strokeWidth = svgNumber(annotation.strokeWidth || state.annotationStrokeWidth);
				const head = arrowHeadSegments(start, end, Math.max(10, strokeWidth * 3));
				return "<g fill='none' stroke='" + color + "' stroke-linecap='round' stroke-linejoin='round' stroke-width='" + strokeWidth + "'>" +
					"<line x1='" + svgNumber(start.x) + "' y1='" + svgNumber(start.y) + "' x2='" + svgNumber(end.x) + "' y2='" + svgNumber(end.y) + "'></line>" +
					"<path d='M " + svgNumber(head.left.x) + " " + svgNumber(head.left.y) + " L " + svgNumber(end.x) + " " + svgNumber(end.y) + " L " + svgNumber(head.right.x) + " " + svgNumber(head.right.y) + "'></path>" +
				"</g>";
			}
			const points = (annotation.points || []).map((point) => {
				const view = annotationStylePoint(point);
				return svgNumber(view.x) + "," + svgNumber(view.y);
			}).join(" ");
			if (!points) return "";
			return "<polyline fill='none' points='" + esc(points) + "' stroke='" + color + "' stroke-linecap='round' stroke-linejoin='round' stroke-width='" + svgNumber(annotation.strokeWidth || state.annotationStrokeWidth) + "'></polyline>";
		}).join("");
	}

	function compactElementText(element) {
		const text = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
		return text.length > 180 ? text.slice(0, 177) + "..." : text;
	}

	function selectorFor(element) {
		if (!element || element === document.body) return "body";
		if (element.id) return "#" + CSS.escape(element.id);
		const parts = [];
		let current = element;
		while (current && current.nodeType === 1 && current !== document.body && parts.length < 4) {
			let part = current.tagName.toLowerCase();
			if (current.classList && current.classList.length) {
				part += "." + Array.from(current.classList).slice(0, 2).map((name) => CSS.escape(name)).join(".");
			}
			const parent = current.parentElement;
			if (parent) {
				const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
				if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
			}
			parts.unshift(part);
			current = parent;
		}
		return parts.join(" > ") || element.tagName.toLowerCase();
	}

	function describeTarget(element, event) {
		const rect = element.getBoundingClientRect();
		return {
			coordinates: {
				pageX: Math.round(event.pageX),
				pageY: Math.round(event.pageY),
				viewportX: Math.round(event.clientX),
				viewportY: Math.round(event.clientY),
			},
			selectedElement: {
				selector: selectorFor(element),
				tagName: element.tagName,
				text: compactElementText(element),
				ariaLabel: element.getAttribute("aria-label"),
				className: element.getAttribute("class"),
				rect: {
					top: Math.round(rect.top),
					left: Math.round(rect.left),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
				},
			},
		};
	}

	function fallbackSubmissionCoordinates() {
		const viewportX = Math.round(Math.max(24, Math.min(window.innerWidth - 24, window.innerWidth / 2)));
		const viewportY = Math.round(Math.max(24, Math.min(window.innerHeight - 24, window.innerHeight / 2)));
		return {
			pageX: Math.round(window.scrollX + viewportX),
			pageY: Math.round(window.scrollY + viewportY),
			viewportX,
			viewportY,
		};
	}

	function captureContext() {
		return {
			elementCount: document.querySelectorAll("*").length,
			imageCount: document.images.length,
			documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
			documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
			scrollX: Math.round(window.scrollX),
			scrollY: Math.round(window.scrollY),
			title: document.title,
		};
	}

	function canvasPoint(point) {
		return {
			x: Number(point && point.x ? point.x : 0) - window.scrollX,
			y: Number(point && point.y ? point.y : 0) - window.scrollY,
		};
	}

	function drawAnnotationOnCanvas(ctx, annotation) {
		ctx.save();
		const color = normalizeAnnotationColor(annotation.color);
		const strokeWidth = normalizeAnnotationStrokeWidth(annotation.strokeWidth || state.annotationStrokeWidth);
		ctx.strokeStyle = color;
		ctx.fillStyle = color;
		ctx.lineWidth = strokeWidth;
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		if (annotation.type === "pen") {
			const points = annotation.points || [];
			if (points.length < 2) {
				ctx.restore();
				return;
			}
			const first = canvasPoint(points[0]);
			ctx.beginPath();
			ctx.moveTo(first.x, first.y);
			for (const point of points.slice(1)) {
				const next = canvasPoint(point);
				ctx.lineTo(next.x, next.y);
			}
			ctx.stroke();
			ctx.restore();
			return;
		}

		if (annotation.type === "arrow") {
			const start = canvasPoint(annotation.start || { x: 0, y: 0 });
			const end = canvasPoint(annotation.end || start);
			const head = arrowHeadSegments(start, end, Math.max(12, strokeWidth * 3));
			ctx.beginPath();
			ctx.moveTo(start.x, start.y);
			ctx.lineTo(end.x, end.y);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(end.x, end.y);
			ctx.lineTo(head.left.x, head.left.y);
			ctx.lineTo(head.right.x, head.right.y);
			ctx.closePath();
			ctx.fill();
			ctx.restore();
			return;
		}

		if (annotation.type === "text") {
			const point = canvasPoint(annotation.position || { x: 0, y: 0 });
			const size = annotation.size || { width: 220, height: 86 };
			ctx.fillStyle = "rgba(251,249,244,.86)";
			ctx.strokeStyle = color;
			ctx.lineWidth = 2;
			ctx.fillRect(point.x - 4, point.y - 4, Math.max(80, size.width || 220) + 8, Math.max(32, size.height || 86) + 8);
			ctx.strokeRect(point.x - 4, point.y - 4, Math.max(80, size.width || 220) + 8, Math.max(32, size.height || 86) + 8);
			ctx.fillStyle = color;
			ctx.font = "800 18px system-ui, sans-serif";
			drawWrappedAnnotationText(ctx, annotation.text || "", point.x + 8, point.y + 24, Math.max(80, size.width || 220) - 16, 23);
		}

		ctx.restore();
	}

	function drawWrappedAnnotationText(ctx, text, x, y, maxWidth, lineHeight) {
		const paragraphs = String(text || "").split(/\n/);
		let currentY = y;
		for (const paragraph of paragraphs) {
			const words = paragraph.split(/\s+/).filter(Boolean);
			if (words.length === 0) {
				currentY += lineHeight;
				continue;
			}
			let line = "";
			for (const word of words) {
				const candidate = line ? line + " " + word : word;
				if (ctx.measureText(candidate).width > maxWidth && line) {
					ctx.fillText(line, x, currentY);
					currentY += lineHeight;
					line = word;
				} else {
					line = candidate;
				}
			}
			if (line) {
				ctx.fillText(line, x, currentY);
				currentY += lineHeight;
			}
		}
	}

	async function captureScreenshotDataUrl(target, annotations) {
		const domCapture = await captureDomScreenshotDataUrl();
		if (domCapture.screenshotDataUrl) {
			const annotated = await drawScreenshotOverlay(domCapture.screenshotDataUrl, target, annotations);
			if (annotated.screenshotDataUrl) {
				return {
					screenshotDataUrl: annotated.screenshotDataUrl,
					failureNote: mergeFailureNotes(domCapture.failureNote, annotated.failureNote),
				};
			}
		}
		const fallback = await captureSyntheticScreenshotDataUrl(target, annotations);
		return {
			screenshotDataUrl: fallback.screenshotDataUrl,
			failureNote: mergeFailureNotes(domCapture.failureNote, fallback.failureNote),
		};
	}

	async function captureDomScreenshotDataUrl() {
		try {
			const width = Math.max(320, Math.min(1600, window.innerWidth));
			const height = Math.max(220, Math.min(1100, window.innerHeight));
			const backgroundColor = snapshotBackgroundColor();
			const clone = document.documentElement.cloneNode(true);
			inlineSnapshotStyles(clone);
			clone.querySelectorAll("script,[data-shiplet-review-style],#shiplet-review-root,.shiplet-review-bubble-layer,.shiplet-review-comment-list-root,.shiplet-review-highlight,.shiplet-review-annotation-layer,.shiplet-review-presence-root,.shiplet-review-cursor-layer").forEach((node) => node.remove());
			const body = clone.querySelector("body");
			if (!body) throw new Error("Document body unavailable.");
			body.style.margin = getComputedStyle(document.body).margin || "0";
			body.style.transform = "translate(" + (-window.scrollX) + "px," + (-window.scrollY) + "px)";
			body.style.transformOrigin = "top left";
			body.style.width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, width) + "px";
			body.style.minHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, height) + "px";
			const serialized = new XMLSerializer().serializeToString(clone);
			const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + width + "' height='" + height + "'>" +
				"<foreignObject width='100%' height='100%'>" + serialized + "</foreignObject>" +
			"</svg>";
			const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
			const image = await loadImage(dataUrl);
			const scale = Math.min(2, window.devicePixelRatio || 1);
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(width * scale);
			canvas.height = Math.round(height * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas unavailable.");
			ctx.scale(scale, scale);
			ctx.fillStyle = backgroundColor;
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(image, 0, 0, width, height);
			if (isCanvasVisuallyBlank(ctx, canvas)) {
				return { screenshotDataUrl: null, failureNote: "DOM screenshot capture was blank; used fallback capture." };
			}
			return { screenshotDataUrl: canvas.toDataURL("image/png"), failureNote: null };
		} catch (error) {
			const message = error && error.message ? error.message : "unknown DOM capture error";
			return { screenshotDataUrl: null, failureNote: "DOM screenshot capture failed; used fallback capture. " + message };
		}
	}

	function isCanvasVisuallyBlank(ctx, canvas) {
		try {
			const width = Math.max(1, canvas.width || 1);
			const height = Math.max(1, canvas.height || 1);
			const data = ctx.getImageData(0, 0, width, height).data;
			const stepX = Math.max(1, Math.floor(width / 72));
			const stepY = Math.max(1, Math.floor(height / 72));
			let first = null;
			let opaqueSamples = 0;
			let variedSamples = 0;
			for (let y = 0; y < height; y += stepY) {
				for (let x = 0; x < width; x += stepX) {
					const index = (y * width + x) * 4;
					const alpha = data[index + 3];
					if (alpha < 16) continue;
					const sample = [data[index], data[index + 1], data[index + 2], alpha];
					opaqueSamples += 1;
					if (!first) {
						first = sample;
						continue;
					}
					const distance =
						Math.abs(sample[0] - first[0]) +
						Math.abs(sample[1] - first[1]) +
						Math.abs(sample[2] - first[2]) +
						Math.abs(sample[3] - first[3]);
					if (distance > 24) variedSamples += 1;
					if (variedSamples > 12) return false;
				}
			}
			return opaqueSamples === 0 || variedSamples <= 12;
		} catch {
			return false;
		}
	}

	function inlineSnapshotStyles(clone) {
		const cssText = collectSnapshotStylesheetText();
		const head = clone.querySelector("head") || document.createElement("head");
		if (!head.parentNode) clone.insertBefore(head, clone.firstChild);
		head.querySelectorAll("link[rel~='stylesheet']").forEach((node) => node.remove());
		if (!cssText) return;
		const style = document.createElement("style");
		style.setAttribute("data-shiplet-screenshot-style", "");
		style.textContent = cssText;
		head.appendChild(style);
	}

	function collectSnapshotStylesheetText() {
		const chunks = [];
		const baseUrl = document.baseURI || location.href;
		for (const sheet of Array.from(document.styleSheets || [])) {
			const owner = sheet.ownerNode;
			if (owner && owner.nodeType === 1 && owner.hasAttribute && owner.hasAttribute("data-shiplet-review-style")) continue;
			try {
				const rules = sheet.cssRules;
				let sheetText = "";
				for (let index = 0; index < rules.length; index += 1) {
					const ruleText = rules[index] && rules[index].cssText;
					if (ruleText) sheetText += ruleText + "\n";
				}
				if (sheetText) chunks.push(absolutizeCssUrlsForSnapshot(sheetText, sheet.href || baseUrl));
			} catch {
				// Cross-origin stylesheets may deny cssRules access; cloned inline
				// and same-origin styles still give the screenshot its page chrome.
			}
		}
		return chunks.join("\n");
	}

	function snapshotBackgroundColor() {
		const candidates = [document.body, document.documentElement];
		for (const node of candidates) {
			if (!node) continue;
			const color = getComputedStyle(node).backgroundColor;
			if (!isTransparentColor(color)) return color;
		}
		return "#ffffff";
	}

	function isTransparentColor(value) {
		const color = String(value || "").trim().toLowerCase();
		if (!color || color === "transparent") return true;
		if (color === "rgba(0, 0, 0, 0)" || color === "rgb(0 0 0 / 0)") return true;
		const commaAlpha = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\s*\)$/);
		if (commaAlpha && Number(commaAlpha[1]) === 0) return true;
		const slashAlpha = color.match(/^rgb[a]?\(.+\/\s*([0-9.]+%?)\s*\)$/);
		if (slashAlpha) {
			const alpha = slashAlpha[1].endsWith("%")
				? Number(slashAlpha[1].slice(0, -1)) / 100
				: Number(slashAlpha[1]);
			return alpha === 0;
		}
		return false;
	}

	async function drawScreenshotOverlay(dataUrl, target, annotations) {
		try {
			const image = await loadImage(dataUrl);
			const scale = Math.min(2, window.devicePixelRatio || 1);
			const width = Math.max(320, Math.min(1600, window.innerWidth));
			const height = Math.max(220, Math.min(1100, window.innerHeight));
			const backgroundColor = snapshotBackgroundColor();
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(width * scale);
			canvas.height = Math.round(height * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas unavailable.");
			ctx.scale(scale, scale);
			ctx.fillStyle = backgroundColor;
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(image, 0, 0, width, height);
			drawTargetHighlight(ctx, target, width, height);
			for (const annotation of annotations || []) {
				drawAnnotationOnCanvas(ctx, annotation);
			}
			return { screenshotDataUrl: canvas.toDataURL("image/png"), failureNote: null };
		} catch (error) {
			const message = error && error.message ? error.message : "unknown overlay error";
			return { screenshotDataUrl: null, failureNote: "Screenshot overlay failed: " + message };
		}
	}

	function loadImage(dataUrl) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error("Image decode failed."));
			image.src = dataUrl;
		});
	}

	function drawTargetHighlight(ctx, target, width, height, options) {
		if (!target || !target.coordinates) return;
		const coordinates = target.coordinates || {};
		const pageX = Number(coordinates.pageX);
		const pageY = Number(coordinates.pageY);
		const viewportX = Number(coordinates.viewportX);
		const viewportY = Number(coordinates.viewportY);
		const minY = Number(options && options.minY);
		const x = Math.max(18, Math.min(width - 18, Number.isFinite(pageX) ? pageX - window.scrollX : viewportX || 0));
		const y = Math.max(Number.isFinite(minY) ? minY : 18, Math.min(height - 18, Number.isFinite(pageY) ? pageY - window.scrollY : viewportY || 0));
		ctx.fillStyle = "rgba(194,80,47,.18)";
		ctx.strokeStyle = "#c2502f";
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.arc(x, y, 28, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}

	async function captureSyntheticScreenshotDataUrl(target, annotations) {
		try {
			const scale = Math.min(2, window.devicePixelRatio || 1);
			const width = Math.max(320, Math.min(1280, window.innerWidth));
			const height = Math.max(220, Math.min(900, window.innerHeight));
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(width * scale);
			canvas.height = Math.round(height * scale);
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Canvas unavailable.");
			ctx.scale(scale, scale);
			ctx.fillStyle = "#fbf9f4";
			ctx.fillRect(0, 0, width, height);
			ctx.fillStyle = "#20293a";
			ctx.font = "700 18px system-ui, sans-serif";
			ctx.fillText(document.title || config.projectName || "Shiplet preview", 18, 34);
			ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
			ctx.fillStyle = "#5d6b85";
			ctx.fillText(location.pathname, 18, 56);
			ctx.strokeStyle = "#bfc4cf";
			ctx.lineWidth = 1;
			for (let y = 86; y < height; y += 28) {
				ctx.beginPath();
				ctx.moveTo(18, y);
				ctx.lineTo(width - 18, y);
				ctx.stroke();
			}
			drawTargetHighlight(ctx, target, width, height, { minY: 74 });
			for (const annotation of annotations || []) {
				drawAnnotationOnCanvas(ctx, annotation);
			}
			const screenshotDataUrl = canvas.toDataURL("image/png");
			return { screenshotDataUrl, failureNote: null };
		} catch (error) {
			const message = error && error.message ? error.message : "unknown capture error";
			return { screenshotDataUrl: null, failureNote: "Client-side bitmap capture failed: " + message };
		}
	}

	function recoverExpiredReviewSession(status) {
		let lastAttemptAt = 0;
		try {
			lastAttemptAt = Number(sessionStorage.getItem(sessionRecoveryStorageKey) || "0");
		} catch {
			// Session storage is an optimization; recovery must still work without it.
		}
		const now = Date.now();
		if (!shouldRecoverReviewSession(status, Boolean(reviewToken), lastAttemptAt, now)) {
			return false;
		}
		try {
			sessionStorage.setItem(sessionRecoveryStorageKey, String(now));
		} catch {
			// Continue with the clean navigation even when storage is unavailable.
		}
		const recoveryUrl = reviewSessionRecoveryUrl(location.href);
		location.replace(recoveryUrl);
		return true;
	}

	async function request(path, options) {
		const requestOptions = options || {};
		const headers = { ...(requestOptions.headers || {}) };
		if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
			headers["content-type"] = "application/json";
		}
		if (reviewToken) {
			headers.Authorization = "Bearer " + reviewToken;
		}
		const response = await fetch(endpoint(path), {
			...requestOptions,
			credentials: "omit",
			headers,
		});
		if (!response.ok) {
			if (recoverExpiredReviewSession(response.status)) {
				throw new Error("Review session expired. Reconnecting…");
			}
			const text = await response.text();
			throw new Error(text || "Review request failed.");
		}
		try {
			sessionStorage.removeItem(sessionRecoveryStorageKey);
		} catch {
			// No cleanup is required when storage is unavailable.
		}
		return response.json();
	}

	function mentionDisplayName(user) {
		return user && (user.name || user.email) || "Reviewer";
	}

	function mentionAccessLabel(accessStatus) {
		if (accessStatus === "invite_required") return "Will invite as reviewer";
		if (accessStatus === "invited") return "Invited but has not joined this shiplet yet";
		if (accessStatus === "invite_failed") return "Invite failed";
		return "Active on this shiplet";
	}

	function mentionTokenFor(textarea) {
		const value = textarea ? textarea.value : state.comment;
		const cursor = textarea && typeof textarea.selectionStart === "number" ? textarea.selectionStart : value.length;
		const beforeCursor = value.slice(0, cursor);
		const match = beforeCursor.match(/(^|\s)@([^\s@]{1,80})$/);
		if (!match) return null;
		return { query: match[2], start: beforeCursor.length - match[2].length - 1, end: cursor };
	}

	async function loadMentionCandidates(query) {
		const normalized = String(query || "").trim();
		if (!normalized) {
			state.mentionCandidates = [];
			state.mentionOpen = false;
			renderMentionMenu();
			return;
		}
		const serial = ++mentionRequestSerial;
		state.mentionLoading = true;
		state.mentionError = "";
		state.mentionOpen = true;
		renderMentionMenu();
		try {
			const data = await request("/review-mention-users?q=" + encodeURIComponent(normalized) + "&limit=8", { method: "GET", headers: {} });
			if (serial !== mentionRequestSerial) return;
			state.mentionCandidates = data.users || [];
		} catch (error) {
			if (serial !== mentionRequestSerial) return;
			state.mentionError = error && error.message ? error.message : "Could not load people.";
			state.mentionCandidates = [];
		} finally {
			if (serial === mentionRequestSerial) {
				state.mentionLoading = false;
				renderMentionMenu();
			}
		}
	}

	function addMention(user) {
		if (!user || !user.id) return;
		if (!state.mentions.some((mention) => mention.userId === user.id)) {
			state.mentions.push({
				userId: user.id,
				email: user.email,
				name: mentionDisplayName(user),
				accessStatus: user.shiplet_access_status || "active",
			});
		}
		const textarea = root.querySelector("[data-shiplet-comment]");
		const token = mentionTokenFor(textarea);
		if (textarea && token) {
			const before = textarea.value.slice(0, token.start);
			const after = textarea.value.slice(token.end);
			state.comment = before + "@" + user.email + " " + after.replace(/^\s+/, "");
			textarea.value = state.comment;
		}
		state.mentionOpen = false;
		state.mentionCandidates = [];
		renderComposerMentionState();
		if (textarea) textarea.focus();
	}

	function removeMention(userId) {
		state.mentions = state.mentions.filter((mention) => mention.userId !== userId);
		renderComposerMentionState();
	}

	function setShowBubbles(value) {
		state.showBubbles = !!value;
		writeBooleanPreference(showBubblesStorageKey, state.showBubbles);
		renderBubbles();
		render();
	}

	function setShowClosed(value) {
		state.showClosed = !!value;
		writeBooleanPreference(showClosedStorageKey, state.showClosed);
		loadFeedback();
	}

	function notifyParentFeedbackChanged(reason) {
		if (!window.parent || window.parent === window) return;
		const eventType = reason === "created" ? "shiplet:feedback-created" : "shiplet:feedback-updated";
		try {
			window.parent.postMessage({ type: eventType, projectId, reason, at: Date.now() }, appOrigin);
		} catch {
			// Parent refresh is a convenience; the local widget refresh still handles the write path.
		}
	}

	function currentFeedbackPageKey() {
		return location.origin + location.pathname;
	}

	function feedbackUrl() {
		return "/review-feedback?pageUrl=" + encodeURIComponent(location.href) + (state.showClosed ? "&includeClosed=true" : "");
	}

	function mergeFeedbackItems(items) {
		const incoming = Array.isArray(items) ? items.slice() : [];
		const incomingIds = new Set(incoming.map((item) => item && item.id).filter(Boolean));
		for (const id of Object.keys(state.optimisticCreatedFeedback)) {
			if (incomingIds.has(id)) {
				delete state.optimisticCreatedFeedback[id];
				continue;
			}
			incoming.unshift(state.optimisticCreatedFeedback[id]);
		}
		return incoming;
	}

	function replaceFeedbackItems(items) {
		state.items = mergeFeedbackItems(items);
		if (state.expandedBubbleId && !state.items.some((item) => item.id === state.expandedBubbleId)) {
			state.expandedBubbleId = "";
		}
	}

	function upsertFeedbackItem(feedback) {
		if (!feedback || !feedback.id) return;
		const closed = feedback.status === "Done" || feedback.status === "Dropped";
		const keep = state.showClosed || !closed;
		state.items = keep
			? [feedback].concat(state.items.filter((item) => item.id !== feedback.id))
			: state.items.filter((item) => item.id !== feedback.id);
		if (!keep && state.expandedBubbleId === feedback.id) state.expandedBubbleId = "";
		renderBubbles();
		renderCommentList();
		render();
	}

	function refreshForPossiblePageChange() {
		const nextKey = currentFeedbackPageKey();
		if (nextKey === lastFeedbackPageKey) return;
		lastFeedbackPageKey = nextKey;
		state.expandedBubbleId = "";
		state.activeBubbleClusterId = "";
		state.items = [];
		state.optimisticCreatedFeedback = {};
		renderBubbles();
		renderCommentList();
		loadFeedback({ quiet: true });
		sendPagePresence();
	}

	function installLocationWatcher() {
		const dispatchLocationChange = () => window.setTimeout(refreshForPossiblePageChange, 0);
		["pushState", "replaceState"].forEach((method) => {
			const original = history[method];
			if (typeof original !== "function" || original.__shipletReviewWrapped) return;
			const wrapped = function() {
				const result = original.apply(this, arguments);
				dispatchLocationChange();
				return result;
			};
			wrapped.__shipletReviewWrapped = true;
			history[method] = wrapped;
		});
		window.addEventListener("popstate", dispatchLocationChange);
		window.addEventListener("hashchange", dispatchLocationChange);
		feedbackLocationCheckTimer = window.setInterval(refreshForPossiblePageChange, 1200);
	}

	function startFeedbackPolling() {
		if (!feedbackEnabled || feedbackPollTimer) return;
		feedbackPollTimer = window.setInterval(() => {
			refreshForPossiblePageChange();
			if (document.hidden || state.submitting) return;
			loadFeedback({ quiet: true });
		}, feedbackPollIntervalMs);
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) loadFeedback({ quiet: true });
		});
		window.addEventListener("focus", () => loadFeedback({ quiet: true }));
	}

	function presenceSocketUrl() {
		const url = new URL(endpoint("/review-presence/ws"));
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("path", location.pathname);
		url.searchParams.set("href", location.href);
		url.searchParams.set("title", document.title || "");
		if (presenceToken) url.searchParams.set("reviewToken", presenceToken);
		return url.toString();
	}

	function currentPagePresence() {
		return {
			pathname: location.pathname || "/",
			href: location.href,
			title: document.title || null,
		};
	}

	function currentViewportPresence() {
		return {
			width: window.innerWidth,
			height: window.innerHeight,
			scrollX: Math.round(window.scrollX),
			scrollY: Math.round(window.scrollY),
		};
	}

	function sendPresence(payload) {
		if (!presenceSocket || presenceSocket.readyState !== WebSocket.OPEN) return;
		try {
			presenceSocket.send(JSON.stringify(payload));
		} catch {
			// Reconnect will handle stale sockets.
		}
	}

	function sendPresenceHello() {
		sendPresence({
			type: "hello",
			viewer: selfPresenceViewer,
			page: currentPagePresence(),
			viewport: currentViewportPresence(),
		});
	}

	function sendPagePresence() {
		sendPresence({
			type: "page:update",
			page: currentPagePresence(),
			viewport: currentViewportPresence(),
		});
	}

	function sendCursorPresence(event) {
		const now = Date.now();
		if (now - lastCursorSentAt < 60) return;
		lastCursorSentAt = now;
		sendPresence({
			type: "cursor:update",
			page: currentPagePresence(),
			cursor: {
				x: Math.round(event.pageX),
				y: Math.round(event.pageY),
				viewportX: Math.round(event.clientX),
				viewportY: Math.round(event.clientY),
				scrollX: Math.round(window.scrollX),
				scrollY: Math.round(window.scrollY),
			},
		});
	}

	function connectPresence() {
		if (!window.WebSocket) return;
		try {
			presenceSocket = new WebSocket(presenceSocketUrl());
		} catch {
			return;
		}
		presenceSocket.addEventListener("open", () => {
			state.presenceConnected = true;
			sendPresenceHello();
			renderPresence();
		});
		presenceSocket.addEventListener("message", (event) => {
			let message = null;
			try {
				message = JSON.parse(String(event.data || "{}"));
			} catch {
				return;
			}
			handlePresenceMessage(message);
		});
		presenceSocket.addEventListener("close", () => {
			state.presenceConnected = false;
			renderPresence();
			clearTimeout(presenceReconnectTimer);
			presenceReconnectTimer = setTimeout(connectPresence, 1200);
		});
		presenceSocket.addEventListener("error", () => {
			state.presenceConnected = false;
			renderPresence();
		});
	}

	function handlePresenceMessage(message) {
		if (!message || !message.type) return;
		if (message.type === "presence:update" && Array.isArray(message.viewers)) {
			state.presenceViewers = message.viewers;
			reconcileRemoteCursors();
			renderPresence();
			renderRemoteCursors();
			followActiveViewer();
			return;
		}
		if (message.type === "cursor:update" && message.viewer && message.cursor) {
			const viewer = message.viewer;
			if (!viewer.id || viewer.id === selfPresenceViewer.id) return;
			state.remoteCursors[viewer.id] = {
				viewer,
				page: message.page || currentPagePresence(),
				cursor: message.cursor,
				at: Date.now(),
			};
			renderRemoteCursors();
			if (state.followingId === viewer.id) keepCursorInView(message.cursor);
		}
	}

	function reconcileRemoteCursors() {
		const activeIds = new Set(state.presenceViewers.map((viewer) => viewer.id));
		for (const id of Object.keys(state.remoteCursors)) {
			const entry = state.remoteCursors[id];
			if (!activeIds.has(id) || !entry.page || entry.page.pathname !== location.pathname) {
				delete state.remoteCursors[id];
			}
		}
	}

	function presenceRosterHtml() {
		if (!canRenderPresenceRoster || !state.presenceViewers.length) return "";
		const viewers = state.presenceViewers.slice(0, 8);
		return "<div class='shiplet-review-presence' aria-label='Live reviewers'>" +
			viewers.map((viewer) => {
				const isSelf = viewer.id === selfPresenceViewer.id;
				const isFollowing = viewer.id === state.followingId;
				const classes = "shiplet-review-presence-avatar" + (isSelf ? " is-self" : "") + (isFollowing ? " is-following" : "");
				const label = isSelf ? "You are viewing this page" : "Follow " + (viewer.name || "reviewer");
				return "<button type='button' class='" + classes + "' data-presence-avatar-id='" + esc(viewer.id || "") + "' aria-label='" + esc(label) + "' title='" + esc(viewer.name || "Reviewer") + "'" + (isSelf ? " disabled" : "") + " style=\"" + esc(avatarBackgroundForViewer(viewer)) + "\"><span>" + esc(initialsFor(viewer.name)) + "</span></button>";
			}).join("") +
		"</div>";
	}

	function renderPresence() {
		const followHtml = state.followingId
			? "<div class='shiplet-review-follow-pill'>Following " + esc(state.followingName || "reviewer") + "<button type='button' data-stop-follow>Stop</button></div>"
			: "";
		presenceRoot.innerHTML = presenceRosterHtml() + followHtml;
	}

	function cursorColor(viewer) {
		return /^#[0-9a-f]{6}$/i.test(String(viewer && viewer.color || "")) ? viewer.color : "#c2502f";
	}

	function remoteCursorHtml(entry) {
		if (!entry || !entry.cursor || !entry.viewer) return "";
		if (!entry.page || entry.page.pathname !== location.pathname) return "";
		const left = Math.round(Number(entry.cursor.x || 0) - window.scrollX);
		const top = Math.round(Number(entry.cursor.y || 0) - window.scrollY);
		if (left < -80 || top < -80 || left > window.innerWidth + 80 || top > window.innerHeight + 80) {
			if (state.followingId !== entry.viewer.id) return "";
		}
		const color = cursorColor(entry.viewer);
		return "<div class='shiplet-review-remote-cursor' style='left:" + left + "px;top:" + top + "px;color:" + esc(color) + "'>" +
			"<svg width='24' height='24' viewBox='0 0 24 24' aria-hidden='true'><path d='M4 3.5 19.5 13 12.2 14.5 9.3 21 4 3.5Z' fill='currentColor' stroke='#fbf9f4' stroke-width='1.5' stroke-linejoin='round'/></svg>" +
			"<span style='background:" + esc(color) + "'>" + esc(entry.viewer.name || "Reviewer") + "</span>" +
		"</div>";
	}

	function renderRemoteCursors() {
		cursorLayer.innerHTML = Object.keys(state.remoteCursors)
			.map((id) => remoteCursorHtml(state.remoteCursors[id]))
			.join("");
	}

	function hasUnsavedFeedbackDraft() {
		return Boolean(
			state.comment.trim() ||
			state.target ||
			state.annotations.length ||
			state.annotationDraft ||
			state.activeTextBox,
		);
	}

	function startFollowing(viewer) {
		if (!viewer || viewer.id === selfPresenceViewer.id) return;
		if (hasUnsavedFeedbackDraft() && !window.confirm("Follow this reviewer and leave your unsaved feedback draft?")) {
			return;
		}
		state.followingId = viewer.id;
		state.followingName = viewer.name || "reviewer";
		renderPresence();
		followViewer(viewer);
	}

	function stopFollowing() {
		state.followingId = "";
		state.followingName = "";
		renderPresence();
	}

	function followActiveViewer() {
		if (!state.followingId) return;
		const viewer = state.presenceViewers.find((candidate) => candidate.id === state.followingId);
		if (viewer) followViewer(viewer);
	}

	function followViewer(viewer) {
		if (!viewer || !viewer.page) return;
		const targetPath = viewer.page.pathname || "/";
		const targetHref = safeFollowHref(viewer.page.href || targetPath);
		if (targetPath !== location.pathname && targetHref) {
			location.href = targetHref;
			return;
		}
		if (viewer.cursor) keepCursorInView(viewer.cursor);
	}

	function safeFollowHref(href) {
		try {
			const target = new URL(href || "/", location.href);
			if (target.origin !== location.origin) return "";
			return target.href;
		} catch {
			return "";
		}
	}

	function keepCursorInView(cursor) {
		const x = Number(cursor.x || 0) - window.scrollX;
		const y = Number(cursor.y || 0) - window.scrollY;
		const margin = 96;
		let nextX = window.scrollX;
		let nextY = window.scrollY;
		if (x < margin) nextX = Math.max(0, Number(cursor.x || 0) - margin);
		if (x > window.innerWidth - margin) nextX = Math.max(0, Number(cursor.x || 0) - window.innerWidth + margin);
		if (y < margin) nextY = Math.max(0, Number(cursor.y || 0) - margin);
		if (y > window.innerHeight - margin) nextY = Math.max(0, Number(cursor.y || 0) - window.innerHeight + margin);
		if (nextX !== window.scrollX || nextY !== window.scrollY) {
			window.scrollTo({ left: nextX, top: nextY, behavior: "smooth" });
		}
	}

	async function loadFeedback(options) {
		if (!feedbackEnabled) return;
		const quiet = !!(options && options.quiet);
		const serial = ++feedbackLoadSerial;
		if (!quiet) {
			state.loading = true;
			state.error = "";
			render();
		}
		try {
			const data = await request(feedbackUrl(), { method: "GET", headers: {} });
			if (serial !== feedbackLoadSerial) return;
			replaceFeedbackItems(data.feedback || []);
		} catch (error) {
			if (!quiet && serial === feedbackLoadSerial) {
				state.error = error && error.message ? error.message : "Could not load feedback.";
			}
		} finally {
			if (serial === feedbackLoadSerial) {
				if (!quiet) state.loading = false;
				render();
			}
		}
	}

	function openPanel(options) {
		state.open = true;
		state.panelOpen = true;
		state.sheetCollapsed = false;
		state.commentListOpen = false;
		if (options && options.settingsOpen) state.settingsOpen = true;
		render();
		loadFeedback();
	}

	function closePanel() {
		state.panelOpen = false;
		state.settingsOpen = false;
		if (!state.target && !state.capturing && !state.commentListOpen) state.open = false;
		render();
	}

	function cancelInlineComposer() {
		state.target = null;
		state.comment = "";
		state.mentions = [];
		state.mentionOpen = false;
		state.mentionCandidates = [];
		clearAnnotations();
		if (!state.panelOpen && !state.commentListOpen) state.open = false;
		render();
	}

	function stopCapture() {
		state.capturing = false;
		document.body.classList.remove("shiplet-review-capturing");
		highlight.style.display = "none";
		pickerCursor.style.display = "none";
		window.removeEventListener("mousemove", onMouseMove, true);
		window.removeEventListener("click", onCaptureClick, true);
		render();
	}

	function startCapture() {
		state.capturing = true;
		state.open = true;
		state.panelOpen = false;
		state.commentListOpen = false;
		state.settingsOpen = false;
		state.target = null;
		state.annotationEditorOpen = false;
		state.annotationDraft = null;
		state.annotationPointerId = null;
		state.activeTextBox = null;
		state.annotations = [];
		document.body.classList.add("shiplet-review-capturing");
		window.addEventListener("mousemove", onMouseMove, true);
		window.addEventListener("click", onCaptureClick, true);
		renderAnnotations();
		render();
	}

	function isReviewUiElement(element) {
		return !!(
			element &&
			(root.contains(element) ||
				commentListRoot.contains(element) ||
				bubbleLayer.contains(element) ||
				annotationLayer.contains(element) ||
				presenceRoot.contains(element))
		);
	}

	function captureElementFromPoint(event) {
		const eventTarget = isElementTarget(event.target) ? event.target : null;
		if (eventTarget && isReviewUiElement(eventTarget)) return null;
		const element = document.elementFromPoint(event.clientX, event.clientY);
		if (!element || isReviewUiElement(element)) return null;
		return element;
	}

	function movePickerCursor(event) {
		pickerCursor.style.display = "block";
		pickerCursor.style.left = Math.max(0, event.clientX) + "px";
		pickerCursor.style.top = Math.max(0, event.clientY) + "px";
	}

	function onMouseMove(event) {
		if (!state.capturing) return;
		const element = captureElementFromPoint(event);
		if (!element) {
			highlight.style.display = "none";
			pickerCursor.style.display = "none";
			return;
		}
		movePickerCursor(event);
		const rect = element.getBoundingClientRect();
		highlight.style.display = "block";
		highlight.style.top = Math.max(0, rect.top) + "px";
		highlight.style.left = Math.max(0, rect.left) + "px";
		highlight.style.width = Math.max(0, rect.width) + "px";
		highlight.style.height = Math.max(0, rect.height) + "px";
	}

	function onCaptureClick(event) {
		if (!state.capturing) return;
		const element = captureElementFromPoint(event);
		if (!element) return;
		event.preventDefault();
		event.stopPropagation();
		state.target = describeTarget(element, event);
		stopCapture();
		requestAnimationFrame(() => {
			const input = root.querySelector("[data-shiplet-comment]");
			if (input) input.focus();
		});
	}

	async function submitFeedback() {
		const textarea = root.querySelector("[data-shiplet-comment]");
		state.comment = textarea ? textarea.value : state.comment;
		const comment = state.comment.trim();
		if (!comment) return;
		const submittedFromInlineComposer = !state.panelOpen;
		state.submitting = true;
		state.error = "";
		render();
		try {
			commitActiveTextBox();
			const annotations = state.annotations.slice();
			state.annotationEditorOpen = false;
			renderAnnotations();
			const capture = await captureScreenshotDataUrl(state.target, annotations);
			const screenshotFailureNote = mergeFailureNotes(
				capture.failureNote,
				annotations.length ? "Screenshot includes reviewer annotations." : null,
			);
			const created = await request("/review-feedback", {
				method: "POST",
				body: JSON.stringify({
					comment,
					pageUrl: location.href,
					clientFeedbackId: clientFeedbackId(),
					screenshotMode: state.target ? "element" : "page",
					screenshotDataUrl: capture.screenshotDataUrl,
					viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
					coordinates: state.target ? state.target.coordinates : fallbackSubmissionCoordinates(),
					selectedElement: state.target ? state.target.selectedElement : null,
					captureContext: captureContext(),
					userAgent: navigator.userAgent,
					screenshotFailureNote,
					mentions: state.mentions.map((mention) => ({
						userId: mention.userId,
						email: mention.email,
						name: mention.name,
					})),
				}),
			});
			const createdFeedback = created && created.feedback;
			if (createdFeedback && createdFeedback.id) {
				state.optimisticCreatedFeedback[createdFeedback.id] = createdFeedback;
				state.items = [createdFeedback].concat(state.items.filter((item) => item.id !== createdFeedback.id));
				state.expandedBubbleId = createdFeedback.id;
				state.showBubbles = true;
				writeBooleanPreference(showBubblesStorageKey, true);
				renderBubbles();
				renderCommentList();
			}
			state.target = null;
			state.comment = "";
			state.mentions = [];
			state.mentionOpen = false;
			state.mentionCandidates = [];
			state.annotations = [];
			state.annotationDraft = null;
			state.activeTextBox = null;
			if (submittedFromInlineComposer) {
				state.open = false;
				state.panelOpen = false;
			} else {
				collapseSheetAfterSubmit();
			}
			renderAnnotations();
			notifyParentFeedbackChanged("created");
			await loadFeedback({ quiet: true });
		} catch (error) {
			state.error = error && error.message ? error.message : "Could not submit feedback.";
		} finally {
			state.submitting = false;
			render();
		}
	}

	async function updateStatus(id, status) {
		if (state.pendingStatusIds[id]) return;
		state.pendingStatusIds[id] = true;
		state.error = "";
		renderCommentList();
		try {
			const data = await request("/review-feedback/" + encodeURIComponent(id) + "/status", {
				method: "POST",
				body: JSON.stringify({ status }),
			});
			delete state.optimisticCreatedFeedback[id];
			if (data && data.feedback) upsertFeedbackItem(data.feedback);
			notifyParentFeedbackChanged("updated");
			await loadFeedback({ quiet: true });
		} catch (error) {
			state.error = error && error.message ? error.message : "Could not update status.";
			render();
		} finally {
			delete state.pendingStatusIds[id];
			renderCommentList();
		}
	}

	async function addReply(id, input) {
		if (state.pendingReplyIds[id]) return;
		const comment = input.value.trim();
		if (!comment) return;
		state.pendingReplyIds[id] = true;
		state.error = "";
		renderCommentList();
		try {
			const data = await request("/review-feedback/" + encodeURIComponent(id) + "/replies", {
				method: "POST",
				body: JSON.stringify({ comment }),
			});
			input.value = "";
			delete state.optimisticCreatedFeedback[id];
			if (data && data.feedback) upsertFeedbackItem(data.feedback);
			notifyParentFeedbackChanged("updated");
			await loadFeedback({ quiet: true });
		} catch (error) {
			state.error = error && error.message ? error.message : "Could not add reply.";
			render();
		} finally {
			delete state.pendingReplyIds[id];
			renderCommentList();
		}
	}

	function ticketLabel(item) {
		return item.ticket_label || ("PF-" + item.ticket_number);
	}

	function commentCountLabel() {
		const count = state.items.length;
		return count + " " + (count === 1 ? "comment" : "comments");
	}

	function commentListMeta() {
		if (state.loading) return "Loading comments";
		return commentCountLabel() + (state.showClosed ? " including closed" : "");
	}

	function commentListButtonHtml() {
		if (!canRenderCommentList) return "";
		const count = state.loading ? "..." : state.items.length;
		const accessibleLabel = state.loading ? "View comments, loading" : "View " + count + " " + (count === 1 ? "comment" : "comments");
		return "<button class='shiplet-review-comment-list-button' data-toggle-comment-list type='button' aria-label='" + esc(accessibleLabel) + "' aria-expanded='" + (state.commentListOpen ? "true" : "false") + "' aria-controls='shiplet-review-comment-list'>" +
			"<span class='shiplet-review-comment-list-button-label'>Comments</span>" +
			"<span class='shiplet-review-comment-list-count'>" + esc(count) + "</span>" +
		"</button>";
	}

	function formatTicketTime(value) {
		try {
			const date = new Date(value);
			return Number.isFinite(date.getTime())
				? date.toLocaleString(undefined, {
					month: "short",
					day: "numeric",
					hour: "numeric",
					minute: "2-digit",
				})
				: "";
		} catch {
			return "";
		}
	}

	function mentionsHtml(mentions, removable) {
		const rows = mentions || [];
		if (!rows.length) return "";
		return "<div class='shiplet-review-mention-row'>" + rows.map((mention) => {
			const userId = mention.userId || mention.mentioned_user_id || "";
			const email = mention.email || mention.mentioned_email || "";
			const name = mention.name || mention.mentioned_name || email;
			const accessStatus = mention.accessStatus || mention.access_status || "active";
			const remove = removable ? "<button type='button' aria-label='Remove mention' data-remove-mention='" + esc(userId) + "'>×</button>" : "";
			return "<span class='shiplet-review-mention-chip' data-access='" + esc(accessStatus) + "' title='" + esc(mentionAccessLabel(accessStatus)) + "'>@" + esc(name) + remove + "</span>";
		}).join("") + "</div>";
	}

	function mentionMenuHtml() {
		if (!state.mentionOpen) return "";
		if (state.mentionLoading) return "<div class='shiplet-review-mention-menu'><div class='shiplet-review-empty'>Finding people...</div></div>";
		if (state.mentionError) return "<div class='shiplet-review-mention-menu'><div class='shiplet-review-error'>" + esc(state.mentionError) + "</div></div>";
		if (!state.mentionCandidates.length) return "<div class='shiplet-review-mention-menu'><div class='shiplet-review-empty'>No people found.</div></div>";
		return "<div class='shiplet-review-mention-menu' role='listbox' aria-label='Mention people'>" +
			state.mentionCandidates.map((user) =>
				"<button class='shiplet-review-mention-option' type='button' data-mention-user='" + esc(user.id) + "'>" +
					"<span class='shiplet-review-mention-name'>" + esc(mentionDisplayName(user)) + "<small>" + esc(user.email) + "</small></span>" +
					"<span class='shiplet-review-mention-chip' data-access='" + esc(user.shiplet_access_status || "active") + "'>" + esc(mentionAccessLabel(user.shiplet_access_status || "active")) + "</span>" +
				"</button>"
			).join("") +
		"</div>";
	}

	function renderMentionMenu() {
		const slot = root.querySelector("[data-mention-menu-slot]");
		if (slot) slot.innerHTML = mentionMenuHtml();
	}

	function renderComposerMentions() {
		const slot = root.querySelector("[data-mention-row-slot]");
		if (slot) slot.innerHTML = mentionsHtml(state.mentions, true);
	}

	function renderComposerMentionState() {
		renderMentionMenu();
		renderComposerMentions();
	}

	function ticketHtml(item, index) {
		const label = ticketLabel(item) || ("PF-" + (index + 1));
		const statusPending = !!state.pendingStatusIds[item.id];
		const replyPending = !!state.pendingReplyIds[item.id];
		const active = state.activeTicketId === item.id;
		const replyOpen = active && state.replyingTicketId === item.id;
		const authorEmail = item.submitted_by_email || "Reviewer";
		const author = reviewerDisplayName(authorEmail);
		const createdTime = formatTicketTime(item.created_on || item.createdAt);
		const replies = (item.replies || []).map((reply) => {
			const replyEmail = reply.author_email || reply.submitted_by_email || reply.name || "Reviewer";
			const replyAuthor = reviewerDisplayName(replyEmail);
			const time = formatTicketTime(reply.created_on || reply.createdAt);
			return "<li class='shiplet-review-comment-list-reply'>" +
				"<span class='shiplet-review-comment-list-avatar shiplet-review-comment-list-avatar-small' aria-hidden='true'>" + esc(initialsFor(replyAuthor)) + "</span>" +
				"<div class='shiplet-review-comment-list-reply-body'>" +
					"<div class='shiplet-review-comment-list-reply-header'>" +
						"<span class='shiplet-review-comment-list-reply-name' title='" + esc(replyEmail) + "'>" + esc(replyAuthor) + "</span>" +
						(time ? "<span class='shiplet-review-comment-list-reply-time'>" + esc(time) + "</span>" : "") +
					"</div>" +
					"<p class='shiplet-review-comment-list-reply-comment'>" + esc(reply.comment) + "</p>" +
					mentionsHtml(reply.mentions || [], false) +
				"</div>" +
			"</li>";
		}).join("");
		const statusOptions = ["New", "In Progress", "Blocked", "Done", "Dropped"]
			.map((status) => "<option value='" + esc(status) + "'" + (item.status === status ? " selected" : "") + ">" + esc(status) + "</option>")
			.join("");
		const replyCount = (item.replies || []).length;
		const quickStatus = item.status === "Done" || item.status === "Dropped" ? "New" : "Done";
		const quickStatusLabel = quickStatus === "Done" ? "Resolve" : "Reopen";
		return "<li class='shiplet-review-comment-list-item" + (active ? " is-active" : "") + "' data-ticket='" + esc(item.id) + "'>" +
			"<div class='shiplet-review-comment-list-item-main'>" +
				"<button class='shiplet-review-comment-list-item-button' data-select-ticket='" + esc(item.id) + "' type='button' aria-expanded='" + (active ? "true" : "false") + "'>" +
					"<span class='shiplet-review-comment-list-avatar' aria-hidden='true'>" + esc(initialsFor(author)) + "</span>" +
					"<span class='shiplet-review-comment-list-body'>" +
						"<span class='shiplet-review-comment-list-item-header'>" +
							"<span class='shiplet-review-comment-list-name' title='" + esc(authorEmail) + "'>" + esc(author) + "</span>" +
							(createdTime ? "<span class='shiplet-review-comment-list-time'>" + esc(createdTime) + "</span>" : "") +
							"<span class='shiplet-review-comment-list-index'>" + esc(label) + "</span>" +
						"</span>" +
						"<span class='shiplet-review-comment-list-comment'>" + esc(item.comment) + "</span>" +
						mentionsHtml(item.mentions || [], false) +
						(!active && replyCount ? "<span class='shiplet-review-comment-list-reply-count'>" + replyCount + " " + (replyCount === 1 ? "reply" : "replies") + "</span>" : "") +
					"</span>" +
				"</button>" +
				(active ? "<div class='shiplet-review-comment-list-thread-actions'>" +
					"<span class='shiplet-review-status-label' data-status-label='" + esc(item.status) + "'>" + esc(item.status) + "</span>" +
					"<button class='shiplet-review-thread-action' data-open-reply='" + esc(item.id) + "' type='button' aria-expanded='" + (replyOpen ? "true" : "false") + "'>Reply</button>" +
					"<button class='shiplet-review-thread-action' data-quick-status='" + esc(quickStatus) + "' data-feedback-id='" + esc(item.id) + "' type='button'" + (statusPending ? " disabled" : "") + ">" + esc(quickStatusLabel) + "</button>" +
					"<details class='shiplet-review-thread-more'><summary aria-label='More status options'>•••</summary><label class='shiplet-review-visually-hidden' for='shiplet-review-status-" + esc(item.id) + "'>Change status</label><select class='shiplet-review-comment-list-status-select' data-status='" + esc(item.id) + "' id='shiplet-review-status-" + esc(item.id) + "' aria-label='Status for " + esc(label) + "'" + (statusPending ? " disabled" : "") + ">" + statusOptions + "</select></details>" +
				"</div>" : "") +
			"</div>" +
			(active && replies ? "<section class='shiplet-review-comment-list-replies' aria-label='Replies to " + esc(label) + "'>" +
				"<h3 class='shiplet-review-comment-list-replies-title'>Replies</h3>" +
				"<ol class='shiplet-review-comment-list-replies-items'>" + replies + "</ol>" +
			"</section>" : "") +
			(replyOpen ? "<div class='shiplet-review-comment-list-reply-form'>" +
				"<span class='shiplet-review-comment-list-avatar shiplet-review-comment-list-avatar-small' aria-hidden='true'>" + esc(initialsFor(selfPresenceViewer.name || selfPresenceViewer.email || "You")) + "</span>" +
				"<div class='shiplet-review-comment-list-reply-actions'>" +
					"<label class='shiplet-review-visually-hidden' for='shiplet-review-reply-" + esc(item.id) + "'>Reply to " + esc(label) + "</label>" +
					"<input id='shiplet-review-reply-" + esc(item.id) + "' class='shiplet-review-input' data-reply-input='" + esc(item.id) + "' placeholder='Reply to this thread...'" + (replyPending ? " disabled" : "") + ">" +
					"<button class='shiplet-review-comment-list-send-button' data-reply='" + esc(item.id) + "' type='button' aria-label='Send reply'" + (replyPending ? " disabled" : "") + ">" + (replyPending ? "Sending" : "Send") + "</button>" +
				"</div>" +
			"</div>" : "") +
		"</li>";
	}

	function renderCommentListPanel() {
		if (!canRenderCommentList) return "";
		if (!feedbackEnabled || !state.commentListOpen) return "";
		const listHtml = state.loading
			? "<div class='shiplet-review-comment-list-empty'>Loading comments...</div>"
			: state.items.length
				? "<ol class='shiplet-review-comment-list-items'>" + state.items.map(ticketHtml).join("") + "</ol>"
				: "<div class='shiplet-review-comment-list-empty'>No comments on this page yet.</div>";
			return "<aside class='shiplet-review-comment-list-panel' id='shiplet-review-comment-list' aria-label='Page feedback comments' data-shiplet-comment-list-panel='true'>" +
				"<header class='shiplet-review-comment-list-header'>" +
					"<div class='shiplet-review-comment-list-heading'>" +
						"<h2 class='shiplet-review-comment-list-title'>Comments</h2>" +
						"<p class='shiplet-review-comment-list-meta'>" + esc(commentListMeta()) + "</p>" +
						"<p class='shiplet-review-context' data-review-context>" + esc(config.projectName || "Shiplet") + " · " + esc(location.pathname || "/") + "</p>" +
					"</div>" +
					"<div class='shiplet-review-comment-list-header-actions'>" +
						"<span class='shiplet-review-thread-nav' role='group' aria-label='Navigate comments'>" +
							"<button class='shiplet-review-comment-list-close' data-previous-comment type='button' aria-label='Previous comment'>" + shipletReviewIcon("chevron-up") + "</button>" +
							"<button class='shiplet-review-comment-list-close' data-next-comment type='button' aria-label='Next comment'>" + shipletReviewIcon("chevron-down") + "</button>" +
						"</span>" +
						"<button class='shiplet-review-comment-list-new' data-new-comment type='button' aria-label='New comment'>" + shipletReviewIcon("plus") + "<span>New comment</span></button>" +
					"<button class='shiplet-review-comment-list-close' data-close-comment-list type='button' aria-label='Close comment list'>" + shipletReviewIcon("x") + "</button>" +
				"</div>" +
			"</header>" +
			listHtml +
		"</aside>";
	}

	function renderCommentList() {
		commentListRoot.innerHTML = renderCommentListPanel();
	}

	function shouldAutoCollapseSheet() {
		if (typeof window.matchMedia === "function") {
			return window.matchMedia("(max-width: 640px)").matches;
		}
		return window.innerWidth <= 640;
	}

	function collapseSheetAfterSubmit() {
		if (shouldAutoCollapseSheet()) state.sheetCollapsed = true;
	}

	function collapseSheetForViewportInteraction() {
		if (shouldAutoCollapseSheet()) state.sheetCollapsed = true;
	}

	function scrollTicketIntoView(item) {
		if (!item) return;
		const scrollBehavior = reducedMotion ? "auto" : "smooth";
		const selector = item.selected_element && item.selected_element.selector;
		if (selector) {
			try {
				const element = document.querySelector(selector);
				if (element && element.scrollIntoView) {
					const rect = element.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						element.scrollIntoView({ block: "center", inline: "center", behavior: scrollBehavior });
						return;
					}
				}
			} catch {
				// Historic selectors may no longer match the current page.
			}
		}
		const coordinates = item.coordinates || {};
		const pageX = Number(coordinates.pageX);
		const pageY = Number(coordinates.pageY);
		if (Number.isFinite(pageX) || Number.isFinite(pageY)) {
			window.scrollTo({
				left: Math.max(0, (Number.isFinite(pageX) ? pageX : window.scrollX) - window.innerWidth / 2),
				top: Math.max(0, (Number.isFinite(pageY) ? pageY : window.scrollY) - window.innerHeight / 2),
				behavior: scrollBehavior,
			});
		}
	}

	function selectTicket(id) {
		const item = state.items.find((candidate) => candidate.id === id);
		if (!item) return;
		state.activeTicketId = id;
		state.replyingTicketId = "";
		state.expandedBubbleId = id;
		renderCommentList();
		renderBubbles();
		scrollTicketIntoView(item);
	}

	function navigateTicket(direction) {
		if (!state.items.length) return;
		const activeIndex = state.items.findIndex((item) => item.id === state.activeTicketId);
		const startIndex = activeIndex >= 0 ? activeIndex : direction > 0 ? -1 : 0;
		const nextIndex = (startIndex + direction + state.items.length) % state.items.length;
		const next = state.items[nextIndex];
		if (!next) return;
		selectTicket(next.id);
		requestAnimationFrame(() => {
			const ticket = commentListRoot.querySelector("[data-ticket='" + CSS.escape(next.id) + "'] [data-select-ticket]");
			if (ticket) ticket.focus({ preventScroll: true });
		});
	}

	function bubblePointFor(item, index) {
		const selector = item && item.selected_element && item.selected_element.selector;
		if (selector) {
			try {
				const element = document.querySelector(selector);
				if (element) {
					const rect = element.getBoundingClientRect();
					if (rect.width > 0 && rect.height > 0) {
						return {
							x: Math.max(24, Math.min(window.innerWidth - 24, rect.left + rect.width / 2)),
							y: Math.max(24, Math.min(window.innerHeight - 24, rect.top + rect.height / 2)),
						};
					}
				}
			} catch {
				// Invalid historic selector; fall back to coordinates.
			}
		}
		if (item && item.coordinates) {
			const documentWidth = Math.max(document.documentElement.scrollWidth || 0, document.body && document.body.scrollWidth || 0, window.innerWidth || 0);
			const documentHeight = Math.max(document.documentElement.scrollHeight || 0, document.body && document.body.scrollHeight || 0, window.innerHeight || 0);
			const pageX = clampNumber(Number(item.coordinates.pageX || 72), 24, Math.max(24, documentWidth - 24));
			const pageY = clampNumber(Number(item.coordinates.pageY || 120), 24, Math.max(24, documentHeight - 24));
			return {
				x: Math.max(24, Math.min(window.innerWidth - 24, pageX - window.scrollX)),
				y: Math.max(24, Math.min(window.innerHeight - 24, pageY - window.scrollY)),
			};
		}
		return {
			x: Math.max(34, Math.min(window.innerWidth - 34, 72 + (index % 4) * 48)),
			y: Math.max(34, Math.min(window.innerHeight - 34, 110 + Math.floor(index / 4) * 48)),
		};
	}

	function viewportForBubbles() {
		return {
			width: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1),
			height: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1),
		};
	}

	function visibleBubbleItems() {
		return state.items || [];
	}

	function bubbleLayoutMap(items) {
		const viewport = viewportForBubbles();
		const points = (items || []).map((item, index) => {
			const point = bubblePointFor(item, index);
			return { id: item.id, x: point.x, y: point.y };
		});
		const initial = layoutReviewBubbles(points, viewport);
		const expandedLayout = initial.find((layout) => layout.id === state.expandedBubbleId);
		const activeClusterId = state.activeBubbleClusterId || (expandedLayout && expandedLayout.clusterId) || "";
		const finalLayouts = layoutReviewBubbles(points, viewport, { activeClusterId });
		const byId = new Map();
		for (const layout of finalLayouts) byId.set(layout.id, layout);
		return byId;
	}

	function bubbleStyle(layout, expanded) {
		const viewport = viewportForBubbles();
		if (expanded) {
			const frame = clampExpandedBubbleFrame(
				{ x: layout.x, y: layout.y },
				viewport,
				{ width: 320, minHeight: 168, margin: 14 },
			);
			return "left:" + frame.left + "px;top:" + frame.top + "px;width:" + frame.width + "px;max-height:" + frame.maxHeight + "px;z-index:" + (40 + layout.clusterIndex) + ";";
		}
		return "left:" + layout.x + "px;top:" + layout.y + "px;z-index:" + (10 + layout.clusterIndex) + ";";
	}

	function bubbleHtml(item, index, layout) {
		const point = layout || { ...bubblePointFor(item, index), clusterId: "bubble-cluster-single", clusterIndex: 0, clusterSize: 1 };
		const expanded = state.expandedBubbleId === item.id;
		const label = ticketLabel(item);
		const markerLabel = item.ticket_number || index + 1;
		const clusterLabel = point.clusterSize > 1 ? "Feedback cluster, item " + (point.clusterIndex + 1) + " of " + point.clusterSize : "Feedback bubble";
		return "<div class='shiplet-review-bubble" + (expanded ? " is-expanded" : "") + "' role='button' tabindex='0' aria-label='" + esc(clusterLabel + " " + label) + "' data-status='" + esc(item.status || "New") + "' data-preview-feedback-id='" + esc(item.id) + "' data-bubble-cluster='" + esc(point.clusterId) + "' data-bubble-cluster-size='" + esc(point.clusterSize) + "' data-bubble-cluster-index='" + esc(point.clusterIndex) + "' style='" + bubbleStyle(point, expanded) + "'>" +
			"<span class='shiplet-review-bubble-label'>" + esc(markerLabel) + "</span>" +
			"<span class='shiplet-review-bubble-card'>" +
				"<span class='shiplet-review-bubble-card-head'><span class='shiplet-review-ticket-id'>" + esc(label) + "</span><span class='shiplet-review-bubble-card-meta'>" + esc(item.status || "New") + "</span></span>" +
				"<span class='shiplet-review-bubble-card-text'>" + esc(item.comment) + "</span>" +
				"<span class='shiplet-review-bubble-card-meta'>" + esc(item.submitted_by_email || "Reviewer") + "</span>" +
				"<span class='shiplet-review-row'><button class='shiplet-review-small shiplet-review-bubble-dismiss' type='button' data-collapse-bubble>Collapse</button><button class='shiplet-review-small' type='button' data-bubble-status='Done'>Done</button><button class='shiplet-review-small primary' type='button' data-open-panel>Open</button></span>" +
			"</span>" +
		"</div>";
	}

	function renderBubbles() {
		if (!state.showBubbles) {
			bubbleLayer.innerHTML = "";
			return;
		}
		const items = visibleBubbleItems();
		const layouts = bubbleLayoutMap(items);
		bubbleLayer.innerHTML = items.map((item, index) => bubbleHtml(item, index, layouts.get(item.id))).join("");
	}

	function openAnnotationEditor() {
		stopCapture();
		commitActiveTextBox();
		state.annotationEditorOpen = true;
		state.annotationDraft = null;
		state.annotationPointerId = null;
		collapseSheetForViewportInteraction();
		renderAnnotations();
		render();
	}

	function closeAnnotationEditor() {
		commitActiveTextBox();
		state.annotationEditorOpen = false;
		state.annotationDraft = null;
		state.annotationPointerId = null;
		renderAnnotations();
		render();
	}

	function annotationToolbarHtml() {
		const toolButton = (tool, label, icon) =>
			"<button class='shiplet-review-annotation-button' type='button' title='" + esc(label) + "' aria-label='" + esc(label) + "' aria-pressed='" + (state.annotationTool === tool ? "true" : "false") + "' data-annotation-tool='" + esc(tool) + "'>" + esc(icon) + "</button>";
		return "<div class='shiplet-review-annotation-toolbar' data-annotation-toolbar='true'>" +
			"<div class='shiplet-review-annotation-tool-group' role='group' aria-label='Drawing tools'>" +
				toolButton("pen", "Free draw", "P") +
				toolButton("arrow", "Arrow", "↗") +
				toolButton("text", "Text", "T") +
			"</div>" +
			"<input class='shiplet-review-annotation-color' type='color' aria-label='Annotation color' data-annotation-color value='" + esc(state.annotationColor) + "'>" +
			"<input class='shiplet-review-annotation-range' type='range' min='1' max='10' aria-label='Annotation stroke width' data-annotation-stroke-width value='" + esc(state.annotationStrokeWidth) + "'>" +
			"<button class='shiplet-review-annotation-button' type='button' aria-label='Undo annotation' title='Undo annotation' data-annotation-undo" + (state.annotations.length || state.activeTextBox ? "" : " disabled") + ">↶</button>" +
			"<button class='shiplet-review-annotation-button primary' type='button' data-annotation-done>Done</button>" +
			"<button class='shiplet-review-annotation-button' type='button' aria-label='Close drawing mode' title='Close drawing mode' data-annotation-done>×</button>" +
		"</div>";
	}

	function activeTextBoxHtml() {
		if (!state.activeTextBox) return "";
		const point = annotationStylePoint(state.activeTextBox.position);
		const size = state.activeTextBox.size;
		return "<div class='shiplet-review-annotation-textbox' style='left:" + point.x + "px;top:" + point.y + "px;width:" + Math.max(140, size.width) + "px;height:" + Math.max(58, size.height) + "px;' data-annotation-textbox='true'>" +
			"<textarea aria-label='Screenshot text annotation' data-annotation-text-input placeholder='Type here'>" + esc(state.activeTextBox.text || "") + "</textarea>" +
		"</div>";
	}

	function renderAnnotations() {
		const visibleAnnotations = activeAnnotations();
		annotationLayer.className = "shiplet-review-annotation-layer" + (state.annotationEditorOpen ? " is-editing" : "");
		if (state.annotationEditorOpen) {
			annotationLayer.innerHTML =
				"<div class='shiplet-review-annotation-editor' data-preview-feedback-ui='true' data-annotation-editor='true'>" +
					"<svg class='shiplet-review-annotation-hitarea' data-annotation-canvas='true' aria-label='Drawing canvas' role='img'>" +
						annotationMarksHtml(visibleAnnotations) +
					"</svg>" +
					annotationToolbarHtml() +
					"<p class='shiplet-review-annotation-hint'>Draw directly on the page. These marks will appear in the screenshot only.</p>" +
					activeTextBoxHtml() +
				"</div>";
			const input = annotationLayer.querySelector("[data-annotation-text-input]");
			if (input && document.activeElement !== input) input.focus();
			return;
		}
		if (visibleAnnotations.length === 0) {
			annotationLayer.innerHTML = "";
			return;
		}
		annotationLayer.innerHTML =
			"<svg class='shiplet-review-annotation-svg' aria-label='Screenshot annotations'>" +
				annotationMarksHtml(visibleAnnotations) +
			"</svg>";
	}

	function shipletReviewIcon(name) {
		const icons = {
			comment: { viewBox: "0 0 24 24", paths: "<path d='M7 18.5 3.5 21v-5.2A8.5 8.5 0 1 1 7 18.5Z'></path><path d='M8 10h8'></path><path d='M8 14h5'></path>" },
			plus: { viewBox: "0 0 24 24", paths: "<path d='M12 5v14'></path><path d='M5 12h14'></path>" },
			refresh: { viewBox: "0 0 24 24", paths: "<path d='M21 12a9 9 0 1 1-2.64-6.36'></path><path d='M21 3v7h-7'></path>" },
			settings: { viewBox: "0 0 24 24", paths: "<path d='M4 21v-7'></path><path d='M4 10V3'></path><path d='M12 21v-9'></path><path d='M12 8V3'></path><path d='M20 21v-5'></path><path d='M20 12V3'></path><path d='M2 14h4'></path><path d='M10 8h4'></path><path d='M18 16h4'></path>" },
			send: { viewBox: "0 0 24 24", paths: "<path d='M5 12h14'></path><path d='m13 6 6 6-6 6'></path>" },
			"chevron-down": { viewBox: "0 0 16 16", paths: "<path d='M4 6.25 8 10.25 12 6.25'></path>" },
			"chevron-up": { viewBox: "0 0 16 16", paths: "<path d='M4 9.75 8 5.75 12 9.75'></path>" },
			x: { viewBox: "0 0 24 24", paths: "<path d='M18 6 6 18'></path><path d='m6 6 12 12'></path>" },
		};
		const icon = icons[name] || { viewBox: "0 0 24 24", paths: "" };
		return "<svg class='shiplet-review-icon-svg' viewBox='" + icon.viewBox + "' aria-hidden='true' focusable='false'>" + icon.paths + "</svg>";
	}

	function sheetToggleLabel() {
		return state.sheetCollapsed ? "Expand review sheet" : "Collapse review sheet";
	}

	function sheetToggleIcon() {
		return state.sheetCollapsed ? "chevron-up" : "chevron-down";
	}

	function settingsActionsHtml() {
		return "<div class='shiplet-review-settings-actions'>" +
			"<button class='shiplet-review-small' data-annotate type='button'>Draw on screenshot</button>" +
			"<button class='shiplet-review-small' data-refresh type='button'>Refresh</button>" +
		"</div>";
	}

	function launcherHtml() {
		const reviewLabel = state.capturing ? "Selecting" : "Review";
		const primaryAttr = state.capturing ? "data-capture" : "data-open";
		if (!state.toolbarExpanded && !state.capturing) {
			const count = state.loading ? "" : state.items.length;
			const countLabel = count === "" ? "" : " <span aria-hidden='true'>· " + esc(count) + "</span>";
			return "<button class='shiplet-review-sleeper' data-expand-launcher type='button' aria-label='Open review tools'>" +
				shipletReviewIcon("comment") + "<span>Review" + countLabel + "</span><kbd aria-hidden='true'>C</kbd></button>";
		}
		const comments = canRenderCommentList
			? "<span class='shiplet-review-list-summary'><small>" + esc(commentListMeta()) + "</small>" + commentListButtonHtml() + "</span>"
			: "";
		return "<div class='shiplet-review-launcher shiplet-review-toolbar' data-expanded='true' role='toolbar' aria-label='Review tools'>" +
			"<button class='shiplet-review-button' " + primaryAttr + " type='button'>" + shipletReviewIcon("comment") + "<span>" + esc(reviewLabel) + "</span></button>" +
			"<span class='shiplet-review-launcher-meta'>" +
				comments +
				"<button class='shiplet-review-icon' data-toggle-settings type='button' aria-label='Review settings' title='Review settings'>" + shipletReviewIcon("settings") + "</button>" +
				"<button class='shiplet-review-icon' data-collapse-launcher type='button' aria-label='Close review tools' title='Close review tools'>" + shipletReviewIcon("x") + "</button>" +
			"</span>" +
		"</div>";
	}

	function inlineComposerFrame() {
		const coordinates = state.target && state.target.coordinates || {};
		const anchorX = Number.isFinite(Number(coordinates.viewportX)) ? Number(coordinates.viewportX) : window.innerWidth / 2;
		const anchorY = Number.isFinite(Number(coordinates.viewportY)) ? Number(coordinates.viewportY) : window.innerHeight / 2;
		return placeContextualReviewFrame(
			{ x: anchorX, y: anchorY },
			{ width: window.innerWidth, height: window.innerHeight },
			{ preferredWidth: 344, preferredHeight: 190, margin: 12, gap: 14 },
		);
	}

	function inlineComposerFrameStyle(frame) {
		return "left:" + frame.left + "px;top:" + frame.top + "px;width:" + frame.width + "px;--shiplet-arrow-offset:" + frame.arrowOffset;
	}

	function renderInlineComposer() {
		const frame = inlineComposerFrame();
		const targetText = state.target && state.target.selectedElement
			? state.target.selectedElement.selector
			: "Selected element";
		const viewerName = reviewerDisplayName(selfPresenceViewer.name || selfPresenceViewer.email || "You");
		return "<section class='shiplet-review-inline-composer' data-inline-composer data-placement='" + esc(frame.placement) + "' aria-label='Leave review comment' style='" + inlineComposerFrameStyle(frame) + "'>" +
			"<div class='shiplet-review-inline-context'>" +
				"<span class='shiplet-review-inline-avatar' aria-hidden='true'>" + esc(initialsFor(viewerName)) + "</span>" +
				"<div class='shiplet-review-inline-context-copy'>" +
					"<span>Comment on</span>" +
					"<div class='shiplet-review-target'>" + esc(targetText) + "</div>" +
				"</div>" +
				"<button class='shiplet-review-inline-close' data-close-composer type='button' aria-label='Close review composer'>" + shipletReviewIcon("x") + "</button>" +
			"</div>" +
			(state.error ? "<div class='shiplet-review-error'>" + esc(state.error) + "</div>" : "") +
			"<div class='shiplet-review-inline-editor'>" +
				"<div class='shiplet-review-inline-row'>" +
					"<textarea class='shiplet-review-inline-textarea' aria-label='Comment' data-shiplet-comment rows='2' placeholder='Leave a comment...'>" + esc(state.comment) + "</textarea>" +
				"</div>" +
				"<div data-mention-menu-slot>" + mentionMenuHtml() + "</div>" +
				"<div data-mention-row-slot>" + mentionsHtml(state.mentions, true) + "</div>" +
				"<div class='shiplet-review-inline-footer'>" +
					"<div class='shiplet-review-inline-tools'>" +
						"<button class='shiplet-review-inline-tool' data-annotate type='button' title='Draw on screenshot'>Draw</button>" +
						"<span>@ mention · ⌘↵ send</span>" +
					"</div>" +
					"<div class='shiplet-review-inline-actions'>" +
						"<button class='shiplet-review-inline-cancel' data-close-composer type='button'>Cancel</button>" +
						"<button class='shiplet-review-inline-submit' data-submit type='button' aria-label='Add comment'" + (state.submitting ? " disabled" : "") + ">" + (state.submitting ? "Adding..." : "Add comment") + "</button>" +
					"</div>" +
				"</div>" +
			"</div>" +
		"</section>";
	}

	function renderPanel() {
		const targetText = state.target && state.target.selectedElement
			? state.target.selectedElement.selector
			: state.capturing ? "Select an element on the page" : "Page-level note";
		return "<section class='shiplet-review-panel shiplet-review-bottom-sheet" + (state.sheetCollapsed ? " shiplet-review-sheet-collapsed" : "") + "' aria-label='Shiplet review'>" +
			"<div class='shiplet-review-sheet-grip' aria-hidden='true'></div>" +
			"<div class='shiplet-review-head'>" +
				"<div class='shiplet-review-title'>" + (state.settingsOpen ? "Review settings" : "Add comment") + "<small>" + esc(config.projectName || "Shiplet") + "</small></div>" +
				"<div class='shiplet-review-actions'>" +
					"<button class='shiplet-review-small primary' data-capture type='button'>" + (state.capturing ? "Selecting" : "Add") + "</button>" +
					"<button class='shiplet-review-icon' data-toggle-settings type='button' aria-label='Review settings' title='Review settings'>" + shipletReviewIcon("settings") + "</button>" +
					"<button class='shiplet-review-icon shiplet-review-sheet-toggle' data-toggle-sheet type='button' aria-label='" + esc(sheetToggleLabel()) + "' title='" + esc(sheetToggleLabel()) + "'>" + shipletReviewIcon(sheetToggleIcon()) + "</button>" +
					"<button class='shiplet-review-icon' data-close type='button' aria-label='Close' title='Close'>" + shipletReviewIcon("x") + "</button>" +
				"</div>" +
			"</div>" +
			"<div class='shiplet-review-body'>" +
				(state.error ? "<div class='shiplet-review-error'>" + esc(state.error) + "</div>" : "") +
				(state.settingsOpen ? "<div class='shiplet-review-settings'>" +
					settingsActionsHtml() +
					"<label class='shiplet-review-toggle'><input type='checkbox' data-show-bubbles " + (state.showBubbles ? "checked" : "") + "> Show feedback bubbles</label>" +
					"<label class='shiplet-review-toggle'><input type='checkbox' data-show-closed " + (state.showClosed ? "checked" : "") + "> Include closed comments</label>" +
				"</div>" : "<div class='shiplet-review-composer'>" +
					"<div class='shiplet-review-target'>" + esc(targetText) + "</div>" +
					"<textarea class='shiplet-review-textarea' aria-label='Comment' data-shiplet-comment placeholder='Leave a comment...'>" + esc(state.comment) + "</textarea>" +
					"<div data-mention-menu-slot>" + mentionMenuHtml() + "</div>" +
					"<div data-mention-row-slot>" + mentionsHtml(state.mentions, true) + "</div>" +
					"<div class='shiplet-review-row'>" +
						"<button class='shiplet-review-small' data-annotate type='button' aria-pressed='" + (state.annotationEditorOpen ? "true" : "false") + "'>Draw on screenshot</button>" +
						"<button class='shiplet-review-small' data-clear-target type='button'>Clear</button>" +
						"<button class='shiplet-review-small primary' data-submit type='button'" + (state.submitting ? " disabled" : "") + ">" + (state.submitting ? "Adding..." : "Add comment") + "</button>" +
					"</div>" +
				"</div>") +
				(canRenderCommentList ? "<div class='shiplet-review-list-summary'>" +
					"<small>" + esc(commentListMeta()) + "</small>" +
					commentListButtonHtml() +
				"</div>" : "") +
			"</div>" +
		"</section>";
	}

	function render() {
		const activeCommentInput =
			document.activeElement instanceof HTMLTextAreaElement &&
			document.activeElement.matches("[data-shiplet-comment]")
				? document.activeElement
				: null;
		const commentSelectionStart = activeCommentInput ? activeCommentInput.selectionStart : null;
		const commentSelectionEnd = activeCommentInput ? activeCommentInput.selectionEnd : null;
		root.setAttribute("data-comment-list-open", canRenderCommentList && state.open && state.commentListOpen ? "true" : "false");
		root.innerHTML = feedbackEnabled
			? (state.panelOpen
				? renderPanel()
				: state.target
					? renderInlineComposer()
					: launcherHtml())
			: "";
		if (activeCommentInput && state.open) {
			const nextCommentInput = root.querySelector("[data-shiplet-comment]");
			if (nextCommentInput instanceof HTMLTextAreaElement) {
				nextCommentInput.focus();
				if (
					typeof commentSelectionStart === "number" &&
					typeof commentSelectionEnd === "number"
				) {
					const nextLength = nextCommentInput.value.length;
					nextCommentInput.setSelectionRange(
						Math.min(commentSelectionStart, nextLength),
						Math.min(commentSelectionEnd, nextLength),
					);
				}
			}
		}
		resizeInlineCommentTextareas();
		renderCommentList();
		renderBubbles();
		renderAnnotations();
	}

	function resizeInlineCommentTextareas() {
		root.querySelectorAll(".shiplet-review-inline-textarea").forEach((textarea) => {
			if (!(textarea instanceof HTMLTextAreaElement)) return;
			textarea.style.height = "0px";
			const nextHeight = Math.max(76, Math.min(144, textarea.scrollHeight));
			textarea.style.height = nextHeight + "px";
			textarea.style.overflowY = textarea.scrollHeight > 144 ? "auto" : "hidden";
		});
	}

	function isAnnotationCanvasTarget(target) {
		if (!isElementTarget(target)) return false;
		if (target.closest("[data-annotation-toolbar]")) return false;
		if (target.closest("[data-annotation-textbox]")) return false;
		return !!(target.closest("[data-annotation-canvas]") || target.closest("[data-annotation-editor]"));
	}

	function isActiveAnnotationPointer(event) {
		return state.annotationPointerId == null || event.pointerId == null || event.pointerId === state.annotationPointerId;
	}

	function captureAnnotationPointer(event) {
		state.annotationPointerId = event.pointerId == null ? null : event.pointerId;
		if (annotationLayer.setPointerCapture && event.pointerId != null) {
			try {
				annotationLayer.setPointerCapture(event.pointerId);
			} catch {
				// Pointer capture is a progressive enhancement for smoother drawing.
			}
		}
	}

	function releaseAnnotationPointer(event) {
		if (event && annotationLayer.releasePointerCapture && event.pointerId != null) {
			try {
				annotationLayer.releasePointerCapture(event.pointerId);
			} catch {
				// The pointer may already be released when the browser completes a drag.
			}
		}
		state.annotationPointerId = null;
	}

	function handleAnnotationPointerDown(event) {
		if (!state.annotationEditorOpen) return;
		const target = event.target;
		if (!isAnnotationCanvasTarget(target)) return;
		if (typeof event.button === "number" && event.button !== 0) return;
		event.preventDefault();
		const point = annotationPoint(event);
		commitActiveTextBox();
		captureAnnotationPointer(event);

		if (state.annotationTool === "text") {
			state.activeTextBox = {
				id: createAnnotationId(),
				position: point,
				size: { width: 240, height: 90 },
				text: "",
				color: state.annotationColor,
			};
			renderAnnotations();
			return;
		}

		state.annotationDraft = state.annotationTool === "arrow"
			? {
				id: createAnnotationId(),
				type: "arrow",
				start: point,
				end: point,
				color: state.annotationColor,
				strokeWidth: state.annotationStrokeWidth,
			}
			: {
				id: createAnnotationId(),
				type: "pen",
				points: [point],
				color: state.annotationColor,
				strokeWidth: state.annotationStrokeWidth,
			};
		renderAnnotations();
	}

	function handleAnnotationPointerMove(event) {
		if (!state.annotationEditorOpen || !state.annotationDraft) return;
		if (!isActiveAnnotationPointer(event)) return;
		event.preventDefault();
		const point = annotationPoint(event);
		if (state.annotationDraft.type === "pen") {
			state.annotationDraft = {
				...state.annotationDraft,
				points: state.annotationDraft.points.concat(point),
			};
		} else {
			state.annotationDraft = {
				...state.annotationDraft,
				end: point,
			};
		}
		renderAnnotations();
	}

	function finishAnnotationDraft(event) {
		if (event && !isActiveAnnotationPointer(event)) return;
		releaseAnnotationPointer(event);
		if (!state.annotationDraft) return;
		if (state.annotationDraft.type === "pen" && state.annotationDraft.points.length < 2) {
			state.annotationDraft = null;
			renderAnnotations();
			return;
		}
		state.annotations.push(state.annotationDraft);
		state.annotationDraft = null;
		renderAnnotations();
	}

	function undoAnnotation() {
		if (state.activeTextBox) {
			state.activeTextBox = null;
			renderAnnotations();
			return;
		}
		state.annotations = state.annotations.slice(0, -1);
		renderAnnotations();
	}

	root.addEventListener("click", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		if (target.closest("[data-expand-launcher]")) {
			state.toolbarExpanded = true;
			state.open = true;
			render();
			return;
		}
		if (target.closest("[data-collapse-launcher]")) {
			state.toolbarExpanded = false;
			state.open = false;
			render();
			return;
		}
		if (target.closest("[data-open]")) {
			startCapture();
			loadFeedback();
			return;
		}
		if (target.closest("[data-close-composer]")) {
			cancelInlineComposer();
			return;
		}
		if (target.closest("[data-close]")) {
			stopCapture();
			state.annotationEditorOpen = false;
			state.annotationDraft = null;
			state.activeTextBox = null;
			renderAnnotations();
			state.open = false;
			state.panelOpen = false;
			state.commentListOpen = false;
			render();
			return;
		}
		if (canRenderCommentList && target.closest("[data-toggle-comment-list]")) {
			if (state.capturing) stopCapture();
			state.open = true;
			state.commentListOpen = !state.commentListOpen;
			render();
			return;
		}
		if (target.closest("[data-toggle-sheet]")) {
			state.sheetCollapsed = !state.sheetCollapsed;
			render();
			return;
		}
		if (target.closest("[data-refresh]")) {
			loadFeedback();
			return;
		}
		if (target.closest("[data-toggle-settings]")) {
			if (!state.panelOpen) {
				if (state.capturing) stopCapture();
				openPanel({ settingsOpen: true });
				return;
			}
			state.settingsOpen = !state.settingsOpen;
			render();
			return;
		}
		if (target.closest("[data-capture]")) {
			state.capturing ? stopCapture() : startCapture();
			return;
		}
		if (target.closest("[data-annotate]")) {
			openAnnotationEditor();
			return;
		}
		if (target.closest("[data-clear-target]")) {
			state.target = null;
			clearAnnotations();
			render();
			return;
		}
		if (target.closest("[data-submit]")) {
			submitFeedback();
			return;
		}
		const mentionOption = target.closest("[data-mention-user]");
		if (mentionOption) {
			const id = mentionOption.getAttribute("data-mention-user") || "";
			const user = state.mentionCandidates.find((candidate) => candidate.id === id);
			if (user) addMention(user);
			return;
		}
		const removeMentionButton = target.closest("[data-remove-mention]");
		if (removeMentionButton) {
			removeMention(removeMentionButton.getAttribute("data-remove-mention") || "");
			return;
		}
		const replyButton = target.closest("[data-reply]");
		if (replyButton) {
			const id = replyButton.getAttribute("data-reply") || "";
			const input = id ? root.querySelector("[data-reply-input='" + CSS.escape(id) + "']") : null;
			if (id && input) addReply(id, input);
			return;
		}
	});

	commentListRoot.addEventListener("click", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		if (target.closest("[data-previous-comment]")) {
			navigateTicket(-1);
			return;
		}
		if (target.closest("[data-next-comment]")) {
			navigateTicket(1);
			return;
		}
		if (target.closest("[data-new-comment]")) {
			startCapture();
			return;
		}
		if (target.closest("[data-close-comment-list]")) {
			state.commentListOpen = false;
			render();
			return;
		}
		const quickStatusButton = target.closest("[data-quick-status]");
		if (quickStatusButton) {
			const id = quickStatusButton.getAttribute("data-feedback-id") || "";
			const status = quickStatusButton.getAttribute("data-quick-status") || "";
			if (id && status) updateStatus(id, status);
			return;
		}
		const openReplyButton = target.closest("[data-open-reply]");
		if (openReplyButton) {
			const id = openReplyButton.getAttribute("data-open-reply") || "";
			if (!id) return;
			state.activeTicketId = id;
			state.replyingTicketId = state.replyingTicketId === id ? "" : id;
			renderCommentList();
			if (state.replyingTicketId) {
				requestAnimationFrame(() => {
					const input = commentListRoot.querySelector("[data-reply-input='" + CSS.escape(id) + "']");
					if (input) input.focus();
				});
			}
			return;
		}
		const replyButton = target.closest("[data-reply]");
		if (replyButton) {
			const id = replyButton.getAttribute("data-reply") || "";
			const input = id ? commentListRoot.querySelector("[data-reply-input='" + CSS.escape(id) + "']") : null;
			if (id && input) addReply(id, input);
			return;
		}
		const selectButton = target.closest("[data-select-ticket]");
		if (selectButton) {
			const id = selectButton.getAttribute("data-select-ticket") || "";
			selectTicket(id);
		}
	});

	commentListRoot.addEventListener("change", (event) => {
		const target = event.target;
		if (!isSelectTarget(target)) return;
		const id = target.getAttribute("data-status");
		if (id) updateStatus(id, target.value);
	});

	bubbleLayer.addEventListener("click", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		if (target.closest("[data-collapse-bubble]")) {
			event.preventDefault();
			event.stopPropagation();
			state.expandedBubbleId = "";
			renderBubbles();
			return;
		}
		if (target.closest("[data-open-panel]")) {
			event.preventDefault();
			event.stopPropagation();
			openPanel();
			return;
		}
		const bubbleStatus = target.closest("[data-bubble-status]");
		if (bubbleStatus) {
			event.preventDefault();
			event.stopPropagation();
			const bubble = target.closest("[data-preview-feedback-id]");
			const id = bubble && bubble.getAttribute("data-preview-feedback-id") || "";
			const status = bubbleStatus.getAttribute("data-bubble-status") || "";
			if (id && status) updateStatus(id, status);
			return;
		}
		const bubble = target.closest("[data-preview-feedback-id]");
		if (bubble) {
			const id = bubble.getAttribute("data-preview-feedback-id") || "";
			state.expandedBubbleId = state.expandedBubbleId === id ? "" : id;
			renderBubbles();
		}
	});

	function setActiveBubbleCluster(clusterId) {
		if (state.activeBubbleClusterId === clusterId) return;
		state.activeBubbleClusterId = clusterId || "";
		renderBubbles();
	}

	bubbleLayer.addEventListener("pointerover", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		const bubble = target.closest("[data-preview-feedback-id]");
		if (!bubble) return;
		setActiveBubbleCluster(bubble.getAttribute("data-bubble-cluster") || "");
	});

	bubbleLayer.addEventListener("pointerout", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		const bubble = target.closest("[data-preview-feedback-id]");
		if (!bubble) return;
		const clusterId = bubble.getAttribute("data-bubble-cluster") || "";
		const nextTarget = isElementTarget(event.relatedTarget) ? event.relatedTarget : null;
		if (nextTarget && nextTarget.closest("[data-bubble-cluster='" + CSS.escape(clusterId) + "']")) return;
		setActiveBubbleCluster("");
	});

	bubbleLayer.addEventListener("focusin", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		const bubble = target.closest("[data-preview-feedback-id]");
		if (bubble) setActiveBubbleCluster(bubble.getAttribute("data-bubble-cluster") || "");
	});

	bubbleLayer.addEventListener("focusout", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		const bubble = target.closest("[data-preview-feedback-id]");
		if (!bubble) return;
		const clusterId = bubble.getAttribute("data-bubble-cluster") || "";
		const nextTarget = isElementTarget(event.relatedTarget) ? event.relatedTarget : null;
		if (nextTarget && nextTarget.closest("[data-bubble-cluster='" + CSS.escape(clusterId) + "']")) return;
		setActiveBubbleCluster("");
	});

	bubbleLayer.addEventListener("keydown", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		const bubble = target.closest("[data-preview-feedback-id]");
		if (!bubble) return;
		if (event.key !== "Enter" && event.key !== " ") return;
		if (target.closest("button")) return;
		event.preventDefault();
		const id = bubble.getAttribute("data-preview-feedback-id") || "";
		state.expandedBubbleId = state.expandedBubbleId === id ? "" : id;
		renderBubbles();
	});

	annotationLayer.addEventListener("pointerdown", handleAnnotationPointerDown);
	window.addEventListener("pointermove", handleAnnotationPointerMove, true);
	window.addEventListener("pointerup", finishAnnotationDraft, true);
	window.addEventListener("pointercancel", finishAnnotationDraft, true);

	annotationLayer.addEventListener("input", (event) => {
		const target = event.target;
		if (!(isInputTarget(target) || isTextAreaTarget(target))) return;
		if (target.matches("[data-annotation-color]")) setAnnotationColor(target.value);
		if (target.matches("[data-annotation-stroke-width]")) setAnnotationStrokeWidth(target.value);
		if (target.matches("[data-annotation-text-input]") && state.activeTextBox) {
			state.activeTextBox = { ...state.activeTextBox, text: target.value };
		}
	});

	annotationLayer.addEventListener("change", (event) => {
		const target = event.target;
		if (!isInputTarget(target)) return;
		if (target.matches("[data-annotation-color]")) setAnnotationColor(target.value);
		if (target.matches("[data-annotation-stroke-width]")) setAnnotationStrokeWidth(target.value);
	});

	annotationLayer.addEventListener("click", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		const tool = target.closest("[data-annotation-tool]");
		if (tool) {
			commitActiveTextBox();
			setAnnotationTool(tool.getAttribute("data-annotation-tool"));
			return;
		}
		if (target.closest("[data-annotation-undo]")) {
			undoAnnotation();
			return;
		}
		if (target.closest("[data-annotation-done]")) {
			closeAnnotationEditor();
		}
	});

	presenceRoot.addEventListener("click", (event) => {
		const target = event.target;
		if (!isElementTarget(target)) return;
		if (target.closest("[data-stop-follow]")) {
			stopFollowing();
			return;
		}
		const avatar = target.closest("[data-presence-avatar-id]");
		if (avatar) {
			const viewerId = avatar.getAttribute("data-presence-avatar-id") || "";
			const viewer = state.presenceViewers.find((candidate) => candidate.id === viewerId);
			if (viewer) startFollowing(viewer);
		}
	});

	root.addEventListener("change", (event) => {
		const target = event.target;
		if (isSelectTarget(target)) {
			const id = target.getAttribute("data-status");
			if (id) updateStatus(id, target.value);
			return;
		}
		if (!isInputTarget(target)) return;
		if (target.matches("[data-show-bubbles]")) setShowBubbles(target.checked);
		if (target.matches("[data-show-closed]")) setShowClosed(target.checked);
	});

	root.addEventListener("input", (event) => {
		const target = event.target;
		if (isTextAreaTarget(target) && target.matches("[data-shiplet-comment]")) {
			state.comment = target.value;
			resizeInlineCommentTextareas();
			const token = mentionTokenFor(target);
			if (token) {
				state.mentionQuery = token.query;
				loadMentionCandidates(token.query);
			} else {
				state.mentionOpen = false;
				state.mentionCandidates = [];
				state.mentionQuery = "";
				renderMentionMenu();
			}
		}
	});

	window.addEventListener("resize", () => {
		render();
		renderBubbles();
		renderAnnotations();
		renderPresence();
		renderRemoteCursors();
	});

	function isEditableReviewTarget(target) {
		if (!isElementTarget(target)) return false;
		return !!(
			target.matches("input,textarea,select,[contenteditable='true']") ||
			target.closest("[contenteditable='true']")
		);
	}

	function handleReviewKeydown(event) {
		const target = event.target;
		const commentInput = isTextAreaTarget(target) && target.matches("[data-shiplet-comment]");
		const replyInput = isInputTarget(target) && target.matches("[data-reply-input]");
		const intent = reviewKeyboardIntent(event, {
			annotationEditorOpen: state.annotationEditorOpen,
			targetSelected: !!state.target,
			capturing: state.capturing,
			commentListOpen: state.commentListOpen,
			panelOpen: state.panelOpen,
			expandedBubble: !!state.expandedBubbleId,
			toolbarExpanded: state.toolbarExpanded,
			commentInput,
			replyInput,
			editableTarget: isEditableReviewTarget(target),
		});
		if (!intent) return;
		event.preventDefault();
		event.stopPropagation();
		if (intent === "close-annotation") {
			closeAnnotationEditor();
			return;
		}
		if (intent === "cancel-composer") {
			cancelInlineComposer();
			return;
		}
		if (intent === "stop-capture") {
			stopCapture();
			return;
		}
		if (intent === "close-comment-list") {
			state.commentListOpen = false;
			render();
			return;
		}
		if (intent === "close-panel") {
			closePanel();
			return;
		}
		if (intent === "collapse-bubble") {
			state.expandedBubbleId = "";
			renderBubbles();
			return;
		}
		if (intent === "collapse-toolbar") {
			state.toolbarExpanded = false;
			state.open = false;
			render();
			return;
		}
		if (intent === "start-capture") {
			startCapture();
			return;
		}
		if (intent === "submit-comment") {
			submitFeedback();
			return;
		}
		if (intent === "submit-reply") {
			const id = target.getAttribute("data-reply-input") || "";
			if (id) addReply(id, target);
			return;
		}
		if (intent === "previous-thread") navigateTicket(-1);
		if (intent === "next-thread") navigateTicket(1);
	}

	window.addEventListener("keydown", handleReviewKeydown, true);
	window.addEventListener("scroll", () => {
		if (state.target && !state.panelOpen) render();
		renderBubbles();
		renderAnnotations();
		renderRemoteCursors();
		sendPagePresence();
	}, { passive: true });
	window.addEventListener("mousemove", sendCursorPresence, { passive: true });
	window.addEventListener("beforeunload", () => {
		try {
			if (presenceSocket) presenceSocket.close(1000, "page unloading");
		} catch {
			// Best-effort close.
		}
		clearInterval(feedbackPollTimer);
		clearInterval(feedbackLocationCheckTimer);
	});

	render();
	renderPresence();
	connectPresence();
	installLocationWatcher();
	startFeedbackPolling();
	loadFeedback();
})();
`;
}
