import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Testcontainers-backed: single fork so containers are managed predictably.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
