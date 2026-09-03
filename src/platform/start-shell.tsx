import * as React from "react";
import {
	Outlet,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from "@tanstack/react-router";
import { createStart } from "@tanstack/react-start";

import { platformStartRouteByPath } from "./start-shell-contract";

export * from "./start-shell-contract";

export const platformStart = createStart(() => ({
	defaultSsr: "data-only",
}));

const platformStartRootRoute = createRootRoute({
	component: PlatformStartRoot,
});

const publishRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "/",
	component: PlatformStartRoutePlaceholder,
});

const shipletsRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "shiplets",
	component: PlatformStartRoutePlaceholder,
});

const inboxRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "inbox",
	component: PlatformStartRoutePlaceholder,
});

const feedbackRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "feedback",
	component: PlatformStartRoutePlaceholder,
});

const workspaceRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "workspace",
	component: PlatformStartRoutePlaceholder,
});

const accountRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "account",
	component: PlatformStartRoutePlaceholder,
});

const accessRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "access",
	component: PlatformStartRoutePlaceholder,
});

const agentsRoute = createRoute({
	getParentRoute: () => platformStartRootRoute,
	path: "agents",
	component: PlatformStartRoutePlaceholder,
});

export const platformStartRouteTree = platformStartRootRoute.addChildren([
	publishRoute,
	shipletsRoute,
	inboxRoute,
	feedbackRoute,
	workspaceRoute,
	accountRoute,
	accessRoute,
	agentsRoute,
]);

export function createPlatformStartRouter(initialPath = "/") {
	const initialRoute = platformStartRouteByPath(initialPath);
	return createRouter({
		routeTree: platformStartRouteTree,
		history: createMemoryHistory({
			initialEntries: [initialRoute?.path || "/"],
		}),
		scrollRestoration: true,
		defaultPreload: "intent",
	});
}

function PlatformStartRoot() {
	return <Outlet />;
}

function PlatformStartRoutePlaceholder() {
	return null;
}
