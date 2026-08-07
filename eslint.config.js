// Flat ESLint config. Under Glaze this was supplied by the SDK CLI
// (`glaze lint`); the port owns it.
//
// The one rule that carries real weight is the `electron` import restriction.
// The original codebase had a "Forbidden imports" list guarding the boundary
// between app code and SDK internals; the Electron port has exactly one such
// boundary, and it is worth the same protection: main-process code goes through
// `@shell/backend`, not `electron` directly. Otherwise the adapter stops being
// a seam — `windowKey` stripping, the logger, and the navigation-event types
// all silently bypass, and swapping or stubbing the shell layer (which is what
// makes the backend testable at all) stops working.

import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: ["build/**", "dist/**", "node_modules/**", "**/*.d.ts"],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,mjs}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
        ...globals.browser,
        __APP_DISPLAY_NAME__: "readonly",
      },
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      // TypeScript's own checker owns these; the base rules produce false
      // positives on type-only and ambient constructs.
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-redeclare": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Main-process code: the shim is the only door to Electron.
    files: ["main/**/*.ts"],
    ignores: ["main/shell/**", "main/**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message:
                "Import from '@shell/backend' instead. main/shell/* is the only place that may touch Electron directly — see main/shell/backend.ts.",
            },
          ],
        },
      ],
    },
  },
  {
    // The preload is a special case: it runs in the renderer's process and
    // legitimately needs contextBridge/ipcRenderer from Electron itself.
    files: ["renderer/preload.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.check.ts", "**/__tests__/**"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
