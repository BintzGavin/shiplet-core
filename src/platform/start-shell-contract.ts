import {
	kernelScriptNonceAttribute,
	type KernelDocumentNonce,
} from "../kernel-document-nonce";

export const PLATFORM_START_SHELL = "tanstack-start" as const;

export type PlatformStartRouteId =
	| "publish"
	| "shiplets"
	| "inbox"
	| "feedback"
	| "workspace"
	| "account"
	| "access"
	| "agents";

export type PlatformStartRoute = {
	id: PlatformStartRouteId;
	label: string;
	path: string;
	shell: typeof PLATFORM_START_SHELL;
};

export type PlatformStartShellState = {
	apiOwner: "hono-worker";
	assetsBase: "/_build";
	currentRoute: PlatformStartRouteId;
	routes: PlatformStartRoute[];
	serverFnBase: "/_serverFn";
	shell: typeof PLATFORM_START_SHELL;
};

export const PLATFORM_START_ROUTES = [
	{
		id: "publish",
		label: "Publish",
		path: "/",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "shiplets",
		label: "Shiplets",
		path: "/shiplets",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "inbox",
		label: "Inbox",
		path: "/inbox",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "feedback",
		label: "Feedback",
		path: "/feedback",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "workspace",
		label: "Workspace",
		path: "/workspace",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "account",
		label: "Account",
		path: "/account",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "access",
		label: "Access",
		path: "/access",
		shell: PLATFORM_START_SHELL,
	},
	{
		id: "agents",
		label: "Agents",
		path: "/agents",
		shell: PLATFORM_START_SHELL,
	},
] as const satisfies readonly PlatformStartRoute[];

const PLATFORM_START_ROUTE_ALIASES = new Map<string, PlatformStartRouteId>([
	["/settings", "workspace"],
]);

const PLATFORM_START_ROUTES_BY_ID = new Map<PlatformStartRouteId, PlatformStartRoute>(
	PLATFORM_START_ROUTES.map((route) => [route.id, route]),
);

const PLATFORM_START_ROUTES_BY_PATH = new Map<string, PlatformStartRoute>(
	PLATFORM_START_ROUTES.map((route) => [route.path, route]),
);

export function platformStartRouteByPath(pathname: string) {
	const normalizedPath = normalizePlatformPath(pathname);
	const aliasRouteId = PLATFORM_START_ROUTE_ALIASES.get(normalizedPath);
	if (aliasRouteId) {
		return PLATFORM_START_ROUTES_BY_ID.get(aliasRouteId);
	}
	return PLATFORM_START_ROUTES_BY_PATH.get(normalizedPath);
}

export function platformStartShellState(
	currentRoute: PlatformStartRouteId,
): PlatformStartShellState {
	return {
		apiOwner: "hono-worker",
		assetsBase: "/_build",
		currentRoute,
		routes: PLATFORM_START_ROUTES.map((route) => ({
			id: route.id,
			label: route.label,
			path: route.path,
			shell: route.shell,
		})),
		serverFnBase: "/_serverFn",
		shell: PLATFORM_START_SHELL,
	};
}

export function platformStartShellAttributes(
	currentRoute: PlatformStartRouteId,
) {
	return {
		"data-platform-start-route": currentRoute,
		"data-platform-start-shell": PLATFORM_START_SHELL,
	};
}

export function PlatformStartShellStateScript(
	currentRoute: PlatformStartRouteId,
	nonce: KernelDocumentNonce,
) {
	return `<script data-shiplet-kernel-script="v1" ${kernelScriptNonceAttribute(nonce)} type="application/json" id="shiplet-platform-start-shell">${safeJson(
		platformStartShellState(currentRoute),
	)}</script>`;
}

function normalizePlatformPath(pathname: string) {
	const urlPath = pathname.startsWith("http://") || pathname.startsWith("https://")
		? new URL(pathname).pathname
		: pathname.split(/[?#]/, 1)[0] || "/";
	const path = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
	if (path === "/") return path;
	return path.replace(/\/+$/, "");
}

function safeJson(value: unknown) {
	return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
		switch (character) {
			case "<":
				return "\\u003c";
			case ">":
				return "\\u003e";
			case "&":
				return "\\u0026";
			case "\u2028":
				return "\\u2028";
			case "\u2029":
				return "\\u2029";
			default:
				return character;
		}
	});
}
