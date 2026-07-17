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
