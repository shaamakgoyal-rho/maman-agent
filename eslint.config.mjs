// Root ESLint flat config shared by every workspace package.
// Package-boundary rule: packages/* must never import from apps/*.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/target/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/src-tauri/gen/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Dependency-boundary rule: shared packages cannot depend on applications.
    files: ["packages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@maman/api", "@maman/web", "@maman/worker", "@maman/desktop", "**/apps/**"],
              message: "packages/* must not import from apps/*.",
            },
          ],
        },
      ],
    },
  },
  {
    // The desktop webview is untrusted and CSP-locked: it must NEVER talk HTTP.
    // All device→server HTTP originates in the Rust core and is reached via
    // Tauri commands (invokeCommand). Direct fetch/XHR/axios is forbidden here
    // so the enrollment/connectors CSP regression (M18.1) cannot return.
    files: ["apps/desktop/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message:
            "The webview never talks HTTP (CSP-locked). Route the call through a Tauri command in src-tauri/src/lib.rs (SyncClient) and invoke it.",
        },
        {
          name: "XMLHttpRequest",
          message:
            "The webview never talks HTTP (CSP-locked). Route the call through a Tauri command instead.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "axios", message: "The webview never talks HTTP; use a Tauri command." }],
        },
      ],
    },
  },
  {
    // Scripts, configs, and tests may use console output.
    files: [
      "**/*.config.{ts,js,mjs}",
      "scripts/**",
      "**/scripts/**",
      "**/*.test.{ts,tsx}",
      "**/test/**",
      "**/tests/**",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Node scripts use Node globals.
    files: ["scripts/**", "**/scripts/**", "**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        URL: "readonly",
      },
    },
  },
);
