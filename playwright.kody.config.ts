import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const demoRoot = join(tmpdir(), "shiplet-kody");
mkdirSync(demoRoot, { recursive: true });
const envFile = join(demoRoot, "demo.env");
writeFileSync(envFile, "SHIPLET_AUTH_MODE=test\nCUSTOM_DOMAIN=\nSHIPLET_APP_URL=http://localhost:8794\nWORKOS_REDIRECT_URI=http://localhost:8794/auth/callback\n");
export default defineConfig({
  testDir: "./e2e",
  testMatch: "kody-workflow.spec.ts",
  timeout: 90_000,
  workers: 1,
  outputDir: join(demoRoot, "test-results"),
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:8794",
    ...(process.env.SHIPLET_BROWSER_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.SHIPLET_BROWSER_EXECUTABLE } }
      : { channel: "chrome" }),
    viewport: { width: 1360, height: 1000 },
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command:
      `npx wrangler dev --config wrangler.test.jsonc --local --port 8794 --inspector-port 9294 --persist-to "${join(demoRoot, "local-state")}" --env-file "${envFile}"`,
    url: "http://localhost:8794",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
