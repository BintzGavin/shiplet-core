import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "kody-workflow.spec.ts",
  timeout: 90_000,
  workers: 1,
  outputDir: "/private/tmp/shiplet-kody-test-results",
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:8794",
    channel: "chrome",
    viewport: { width: 1360, height: 1000 },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command:
      "npx wrangler dev --config wrangler.test.jsonc --local --port 8794 --persist-to /private/tmp/shiplet-kody-local-state --var SHIPLET_APP_URL:http://localhost:8794 --var WORKOS_REDIRECT_URI:http://localhost:8794/auth/callback",
    url: "http://localhost:8794",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
