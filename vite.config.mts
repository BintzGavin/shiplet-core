import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		tanstackStart({
			srcDirectory: "src/start",
			client: {
				base: "/_build",
			},
			router: {
				basepath: "/",
			},
			serverFns: {
				base: "/_serverFn",
			},
			sitemap: {
				enabled: false,
			},
		}),
		viteReact(),
	],
});
