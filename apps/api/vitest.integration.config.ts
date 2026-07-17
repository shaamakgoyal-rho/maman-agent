import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Each integration file starts its own Testcontainer; run them sequentially
    // in separate forks so containers never contend within one worker.
    pool: "forks",
    fileParallelism: false,
    poolOptions: { forks: { singleFork: false, maxForks: 1 } },
  },
});
