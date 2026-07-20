import { defineConfig, devices } from "@playwright/test";

/**
 * Full-journey E2E against the desktop panel (web build). Headless in CI.
 * The webServer builds the desktop bundle and serves it on a fixed port; the
 * journey drives the same client-side flow the desktop app runs.
 */
const PORT = 4318;

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm --filter @maman/desktop build && pnpm --filter @maman/desktop preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
