import { describe, expect, it } from "vitest";

import {
	PLATFORM_START_ROUTES,
	createPlatformStartRouter,
	platformStartRouteByPath,
	platformStartShellState,
} from "../src/platform/start-shell";

describe("platform Start shell manifest", () => {
	it("declares every signed-in platform page route in one shell registry", () => {
		expect(PLATFORM_START_ROUTES.map((route) => route.path)).toEqual([
			"/",
			"/shiplets",
			"/inbox",
			"/feedback",
			"/workspace",
			"/account",
			"/access",
			"/agents",
		]);
		expect(new Set(PLATFORM_START_ROUTES.map((route) => route.id)).size).toBe(
			PLATFORM_START_ROUTES.length,
		);
		expect(
			PLATFORM_START_ROUTES.every((route) => route.shell === "tanstack-start"),
		).toBe(true);
	});

	it("normalizes legacy settings and route aliases onto the Start shell route ids", () => {
		expect(platformStartRouteByPath("/")?.id).toBe("publish");
		expect(platformStartRouteByPath("/settings")?.id).toBe("workspace");
		expect(platformStartRouteByPath("/workspace")?.id).toBe("workspace");
		expect(platformStartRouteByPath("/shiplets")?.id).toBe("shiplets");
		expect(platformStartRouteByPath("/shiplets/project_123")).toBeUndefined();
	});

	it("serializes route state without leaking implementation-only fields", () => {
		const state = platformStartShellState("feedback");

		expect(state.currentRoute).toBe("feedback");
		expect(state.shell).toBe("tanstack-start");
		expect(state.routes).toContainEqual(
			expect.objectContaining({ id: "feedback", path: "/feedback" }),
		);
		expect(JSON.stringify(state)).not.toContain("component");
	});

	it("creates an executable TanStack router at the current platform path", () => {
		const router = createPlatformStartRouter("/feedback?status=Blocked");

		expect(router.history.location.pathname).toBe("/feedback");
		expect(router.options.scrollRestoration).toBe(true);
		expect(router.options.defaultPreload).toBe("intent");
	});
});
