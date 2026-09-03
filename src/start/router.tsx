import { createPlatformStartRouter } from "../platform/start-shell";

export function getRouter() {
	return createPlatformStartRouter("/");
}

export type PlatformStartRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
	interface Register {
		router: PlatformStartRouter;
	}
}
