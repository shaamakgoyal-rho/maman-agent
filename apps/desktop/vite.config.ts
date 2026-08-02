import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Two entry points: the panel (index.html) and the pet (pet.html).
// `vite dev`/`vite preview` also serve both for CI and non-macOS demo preview.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        panel: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
        statusbar: resolve(__dirname, "statusbar.html"),
        // Developer-only Pet Lab (not referenced by any Tauri window).
        lab: resolve(__dirname, "lab.html"),
      },
    },
  },
});
