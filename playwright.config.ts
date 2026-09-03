import { defineConfig, devices } from "@playwright/test";

const port = 8787;
const baseURL = `http://localhost:${port}`;
const envFile = `/tmp/shiplet-e2e-${port}.env`;
const envLines = [
	"SHIPLET_AUTH_MODE=test",
	"CUSTOM_DOMAIN=",
	`SHIPLET_APP_URL=${baseURL}`,
	`WORKOS_REDIRECT_URI=${baseURL}/auth/callback`,
	"SHIPLET_ENABLED_FEATURE_FLAGS=account-email-switching",
];

export default defineConfig({
	testDir: "./e2e",
	timeout: 45_000,
	expect: { timeout: 8_000 },
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		channel: "chrome",
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		video: "retain-on-failure",
	},
	webServer: {
		command: `printf '%s\\n' ${envLines.map((line) => `'${line}'`).join(" ")} > ${envFile} && npx wrangler dev --config wrangler.test.jsonc --local --port ${port} --env-file ${envFile}`,
		reuseExistingServer: false,
		timeout: 120_000,
		url: baseURL,
	},
});
