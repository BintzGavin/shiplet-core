import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	envDir: false,
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.test.jsonc" },
			remoteBindings: false,
			miniflare: {
				// Mock bindings for testing
				d1Databases: ["DB"],
				r2Buckets: ["SHIPLET_ASSETS", "REVIEW_ASSETS"],
				bindings: {
					SHIPLET_AUTH_MODE: "test",
					SHIPLET_APP_URL: "https://shiplet.cc",
					WORKOS_AUTHKIT_ISSUER:
						"https://example.authkit.app",
					DISPATCH_NAMESPACE_NAME: "test-namespace",
					CUSTOM_DOMAIN: "",
					// Required for API calls - mock values for testing
					ACCOUNT_ID: "test-account-id",
					DISPATCH_NAMESPACE_API_TOKEN: "test-api-token",
					SHIPLET_BOOTSTRAP_TOKEN: "test-bootstrap-token",
				},
			},
		}),
	],
	test: {
		testTimeout: 60_000,
		include: ["test/**/*.spec.ts"],
	},
});
