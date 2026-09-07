import { defineConfig } from "@playwright/test";

/**
 * The console is tested against the real Stage 2 API, so these are integration
 * tests by construction -- there is no mock to drift from. The API must already
 * be running on :3000; the config only starts the console.
 *
 * Workers are 1 because several tests assert on shared stock levels, and two
 * tests racing for the same SKU would be testing the harness rather than the
 * app. The concurrency test creates its own contention deliberately.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5174",
    launchOptions: { args: ["--no-sandbox"] },
  },
  webServer: {
    command: "npm run preview",
    url: "http://localhost:5174",
    // false on purpose: reusing whatever answers on the port once pointed these
    // tests at an unrelated dev server that happened to be running.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
