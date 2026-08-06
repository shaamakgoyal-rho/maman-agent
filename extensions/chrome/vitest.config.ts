import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Node by default. dom-adapter.test.ts opts into jsdom with a per-file
    // docblock: making jsdom global breaks manifest.test.ts, which loads the vite
    // config and with it esbuild.
    coverage: { provider: "v8", include: ["src/**"] },
  },
});
