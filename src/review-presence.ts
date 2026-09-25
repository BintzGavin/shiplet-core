import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

type PresenceKind = "user" | "guest" | "sandbox";

type PresenceViewer = {
	id: string;
	kind: PresenceKind;
	name: string;
	email: string | null;
	avatarPreset: string | null;
	avatarDataUrl: string | null;
	color: string;
};

type PresencePage = {
	pathname: string;
	href: string;
	title: string | null;
};

type PresenceCursor = {
	x: number;
	y: number;
	viewportX: number | null;
	viewportY: number | null;
	scrollX: number;
	scrollY: number;
};

type PresenceViewport = {
	width: number;
	height: number;
	scrollX: number;
	scrollY: number;
};

type PresenceAttachment = {
	connectionId: string;
	joinedAt: number;
	lastSeenAt: number;
	authenticatedUserId: string | null;
	viewer: PresenceViewer;
	page: PresencePage;
	cursor: PresenceCursor | null;
	viewport: PresenceViewport | null;
};

const MAX_TEXT_LENGTH = 240;
const MAX_AVATAR_DATA_URL_LENGTH = 750_000;
const DEFAULT_COLOR = "#2f6e88";

// Signal-flag cursor colors. Every live reviewer is assigned the least-used
// color when they join so people on the same page are always distinguishable;
// reconnects and extra tabs for the same viewer keep the color they already
// have.
export const PRESENCE_COLORS = [
	"#c2502f",
	"#2f6e88",
	"#3f7d50",
	"#c3922e",
	"#8c4a75",
	"#4f5fb8",
	"#1f8a70",
	"#b8336a",
] as const;

export function assignPresenceColor(
	viewerId: string,
	others: ReadonlyArray<{ id: string; color: string }>,
	palette: readonly string[] = PRESENCE_COLORS,
): string {
	const existing = others.find((viewer) => viewer.id === viewerId);
	if (existing && palette.includes(existing.color)) return existing.color;
	const usage = new Map<string, number>();
	for (const color of palette) usage.set(color, 0);
	const counted = new Set<string>();
	for (const viewer of others) {
		if (counted.has(viewer.id)) continue;
		counted.add(viewer.id);
		if (usage.has(viewer.color)) {
			usage.set(viewer.color, (usage.get(viewer.color) || 0) + 1);
		}
	}
	let chosen = palette[0] || DEFAULT_COLOR;
	let lowest = Number.POSITIVE_INFINITY;
	for (const color of palette) {
		const count = usage.get(color) || 0;
		if (count < lowest) {
			lowest = count;
			chosen = color;
		}
	}
	return chosen;
}

export class ReviewPresenceCoordinator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "GET") {
			return new Response("Review presence requires GET.", { status: 405 });
		}
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Review presence expected Upgrade: websocket", {
				status: 426,
			});
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const attachment = this.initialAttachment(request);
		attachment.viewer.color = assignPresenceColor(
			attachment.viewer.id,
			this.colorRoster(),
		);
		server.serializeAttachment(attachment);
		this.ctx.acceptWebSocket(server);
		this.safeSend(server, {
			type: "presence:ready",
			connectionId: attachment.connectionId,
			viewer: attachment.viewer,
			viewers: this.viewers(),
			at: Date.now(),
		});
		this.broadcastPresence();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== "string") return;
		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(message);
			if (!isRecord(parsed)) return;
			payload = parsed;
		} catch {
			this.safeSend(ws, { type: "presence:error", message: "Invalid JSON." });
			return;
		}

		const type = typeof payload.type === "string" ? payload.type : "";
		if (type === "hello") {
			const attachment = this.mergeAttachment(ws, payload, true);
			ws.serializeAttachment(attachment);
			this.broadcastPresence();
			return;
		}

		if (type === "page:update") {
			const attachment = this.mergeAttachment(ws, payload, false);
			ws.serializeAttachment(attachment);
			this.broadcastPresence();
			return;
		}

		if (type === "cursor:update") {
			const attachment = this.mergeAttachment(ws, payload, false);
			ws.serializeAttachment(attachment);
			this.broadcastCursor(ws, attachment);
			return;
		}

		if (type === "cursor:leave") {
			const attachment = { ...this.mergeAttachment(ws, payload, false), cursor: null };
			ws.serializeAttachment(attachment);
			this.broadcastToPage(ws, attachment, {
				type: "cursor:leave",
				viewer: attachment.viewer,
				page: attachment.page,
				at: Date.now(),
			});
			return;
		}

		if (type === "viewport:update") {
			const attachment = this.mergeAttachment(ws, payload, false);
			ws.serializeAttachment(attachment);
			if (!attachment.viewport) return;
			this.broadcastToPage(ws, attachment, {
				type: "viewport:update",
				viewer: attachment.viewer,
				page: attachment.page,
				viewport: attachment.viewport,
				at: Date.now(),
			});
			return;
		}
	}

	async webSocketClose(ws: WebSocket) {
		this.broadcastPresence(ws);
	}

	async webSocketError(ws: WebSocket) {
		this.broadcastPresence(ws);
	}

	private initialAttachment(request: Request): PresenceAttachment {
		const now = Date.now();
		const url = new URL(request.url);
		const connectionId = crypto.randomUUID();
		const userId = normalizeText(
			request.headers.get("x-shiplet-presence-user-id"),
			120,
		);
		const email = normalizeText(
			request.headers.get("x-shiplet-presence-user-email"),
			MAX_TEXT_LENGTH,
		);
		const name =
			normalizeText(
				request.headers.get("x-shiplet-presence-user-name"),
				MAX_TEXT_LENGTH,
			) ||
			email ||
			`Guest ${connectionId.slice(0, 3).toUpperCase()}`;
		const avatarPreset = normalizeText(
			request.headers.get("x-shiplet-presence-avatar-preset"),
			MAX_TEXT_LENGTH,
		);
		const viewer: PresenceViewer = {
			id: userId || `guest_${connectionId.replace(/-/g, "").slice(0, 16)}`,
			kind: userId ? "user" : isSandboxProject(url) ? "sandbox" : "guest",
			name,
			email: email || null,
			avatarPreset: avatarPreset || null,
			avatarDataUrl: null,
			color: DEFAULT_COLOR,
		};

		return {
			connectionId,
			joinedAt: now,
			lastSeenAt: now,
			authenticatedUserId: userId || null,
			viewer,
			page: normalizePage(
				{
					pathname: url.searchParams.get("path") || "/",
					href: url.searchParams.get("href") || "",
					title: url.searchParams.get("title") || null,
				},
				null,
			),
			cursor: null,
			viewport: normalizeViewport(
				{
					width: url.searchParams.get("viewportWidth"),
					height: url.searchParams.get("viewportHeight"),
					scrollX: url.searchParams.get("scrollX"),
					scrollY: url.searchParams.get("scrollY"),
				},
				null,
			),
		};
	}

	private mergeAttachment(
		ws: WebSocket,
		payload: Record<string, unknown>,
		allowViewerUpdate: boolean,
	): PresenceAttachment {
		const current = this.attachmentFor(ws);
		const viewer = allowViewerUpdate
			? normalizeViewer(payload.viewer, current.viewer, current.authenticatedUserId)
			: current.viewer;
		return {
			...current,
			lastSeenAt: Date.now(),
			viewer,
			page: normalizePage(payload.page, current.page),
			cursor: normalizeCursor(payload.cursor, current.cursor),
			viewport: normalizeViewport(payload.viewport, current.viewport),
		};
	}

	private attachmentFor(ws: WebSocket): PresenceAttachment {
		const attachment = ws.deserializeAttachment();
		if (isPresenceAttachment(attachment)) return attachment;
		const now = Date.now();
		const connectionId = crypto.randomUUID();
		return {
			connectionId,
			joinedAt: now,
			lastSeenAt: now,
			authenticatedUserId: null,
			viewer: {
				id: `guest_${connectionId.replace(/-/g, "").slice(0, 16)}`,
				kind: "guest",
				name: `Guest ${connectionId.slice(0, 3).toUpperCase()}`,
				email: null,
				avatarPreset: null,
				avatarDataUrl: null,
				color: DEFAULT_COLOR,
			},
			page: { pathname: "/", href: "", title: null },
			cursor: null,
			viewport: null,
		};
	}

	private colorRoster(excludedSocket?: WebSocket) {
		const roster: Array<{ id: string; color: string }> = [];
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === excludedSocket) continue;
			const attachment = this.attachmentFor(ws);
			roster.push({ id: attachment.viewer.id, color: attachment.viewer.color });
		}
		return roster;
	}

	private viewers(excludedSocket?: WebSocket) {
		const byViewer = new Map<string, PresenceAttachment>();
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === excludedSocket) continue;
			const attachment = this.attachmentFor(ws);
			const existing = byViewer.get(attachment.viewer.id);
			if (!existing || attachment.lastSeenAt >= existing.lastSeenAt) {
				byViewer.set(attachment.viewer.id, attachment);
			}
		}

		return Array.from(byViewer.values())
			.sort((a, b) => a.joinedAt - b.joinedAt)
			.map((attachment) => ({
				...attachment.viewer,
				connectionId: attachment.connectionId,
				page: attachment.page,
				cursor: attachment.cursor,
				viewport: attachment.viewport,
				joinedAt: attachment.joinedAt,
				lastSeenAt: attachment.lastSeenAt,
			}));
	}

	private broadcastPresence(excludedSocket?: WebSocket) {
		const payload = {
			type: "presence:update",
			viewers: this.viewers(excludedSocket),
			at: Date.now(),
		};
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === excludedSocket) continue;
			this.safeSend(ws, payload);
		}
	}

	private broadcastCursor(sender: WebSocket, attachment: PresenceAttachment) {
		if (!attachment.cursor) return;
		this.broadcastToPage(sender, attachment, {
			type: "cursor:update",
			viewer: attachment.viewer,
			page: attachment.page,
			cursor: attachment.cursor,
			at: Date.now(),
		});
	}

	private broadcastToPage(
		sender: WebSocket,
		attachment: PresenceAttachment,
		payload: unknown,
	) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === sender) continue;
			const peer = this.attachmentFor(ws);
			if (peer.page.pathname !== attachment.page.pathname) continue;
			this.safeSend(ws, payload);
		}
	}

	private safeSend(ws: WebSocket, payload: unknown) {
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			// Stale sockets are removed by the runtime; presence will converge on
			// the next close/error/message event.
		}
	}
}

// Temporary migration export. Production routing moves to ShipletRoot before
// this compatibility class and its namespace are removed.

function normalizeViewer(
	value: unknown,
	current: PresenceViewer,
	authenticatedUserId: string | null,
): PresenceViewer {
	const input = isRecord(value) ? value : {};
	const requestedKind =
		input.kind === "user" || input.kind === "sandbox" || input.kind === "guest"
			? input.kind
			: current.kind;
	const kind = authenticatedUserId ? "user" : requestedKind;
	const id = authenticatedUserId || normalizeViewerId(input.id, current.id);
	const email = normalizeText(input.email, MAX_TEXT_LENGTH) || current.email;
	const name =
		normalizeText(input.name, MAX_TEXT_LENGTH) ||
		email ||
		current.name ||
		"Guest";
	return {
		id,
		kind,
		name,
		email,
		avatarPreset:
			normalizeText(input.avatarPreset, MAX_TEXT_LENGTH) || current.avatarPreset,
		avatarDataUrl: normalizeAvatarDataUrl(input.avatarDataUrl) || current.avatarDataUrl,
		// Colors are assigned by the coordinator so every live reviewer stays
		// distinguishable; client-supplied colors are ignored.
		color: current.color,
	};
}

function normalizeViewerId(value: unknown, fallback: string) {
	const id = normalizeText(value, 120);
	if (!id) return fallback;
	return id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || fallback;
}

function normalizePage(value: unknown, fallback: PresencePage | null): PresencePage {
	const input = isRecord(value) ? value : {};
	const pathname =
		normalizePath(input.pathname) ||
		normalizePath(input.path) ||
		fallback?.pathname ||
		"/";
	const href = normalizeText(input.href, 2048) || fallback?.href || pathname;
	const title = normalizeText(input.title, MAX_TEXT_LENGTH) || fallback?.title || null;
	return { pathname, href, title };
}

function normalizeCursor(
	value: unknown,
	fallback: PresenceCursor | null,
): PresenceCursor | null {
	if (!isRecord(value)) return fallback;
	const x = normalizeFiniteNumber(value.x);
	const y = normalizeFiniteNumber(value.y);
	if (x === null || y === null) return fallback;
	return {
		x,
		y,
		viewportX: normalizeFiniteNumber(value.viewportX),
		viewportY: normalizeFiniteNumber(value.viewportY),
		scrollX: normalizeFiniteNumber(value.scrollX) ?? 0,
		scrollY: normalizeFiniteNumber(value.scrollY) ?? 0,
	};
}

function normalizeViewport(
	value: unknown,
	fallback: PresenceViewport | null,
): PresenceViewport | null {
	if (!isRecord(value)) return fallback;
	const width = normalizeFiniteNumber(value.width);
	const height = normalizeFiniteNumber(value.height);
	const scrollX = normalizeFiniteNumber(value.scrollX);
	const scrollY = normalizeFiniteNumber(value.scrollY);
	if (scrollX === null || scrollY === null) return fallback;
	return {
		width: width === null ? (fallback?.width ?? 0) : Math.max(0, width),
		height: height === null ? (fallback?.height ?? 0) : Math.max(0, height),
		scrollX,
		scrollY,
	};
}

function normalizePath(value: unknown) {
	const raw = normalizeText(value, 2048);
	if (!raw) return "";
	try {
		const url = raw.startsWith("http://") || raw.startsWith("https://")
			? new URL(raw)
			: null;
		const pathname = url ? url.pathname : raw;
		return pathname.startsWith("/") ? pathname : `/${pathname}`;
	} catch {
		return raw.startsWith("/") ? raw : `/${raw}`;
	}
}

function normalizeFiniteNumber(value: unknown) {
	const number = Number(value);
	if (!Number.isFinite(number)) return null;
	return Math.round(number);
}

function normalizeText(value: unknown, maxLength: number) {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function normalizeAvatarDataUrl(value: unknown) {
	const dataUrl = normalizeText(value, MAX_AVATAR_DATA_URL_LENGTH);
	if (!dataUrl) return null;
	if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
		return null;
	}
	return dataUrl;
}

function isSandboxProject(url: URL) {
	return /^sandbox-sbx_[a-z0-9]{24}-.+/.test(
		url.pathname.split("/")[3] || "",
	);
}

function isPresenceAttachment(value: unknown): value is PresenceAttachment {
	return (
		isRecord(value) &&
		typeof value.connectionId === "string" &&
		isRecord(value.viewer) &&
		isRecord(value.page)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
