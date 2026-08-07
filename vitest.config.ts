// Vitest configuration.
//
// Two projects, because this app has two very different halves:
//   • "node"   — backend services and pure renderer logic. No DOM.
//   • "dom"    — React components, which need a DOM to render into.
//
// The Electron port removed the whole SDK-resolution problem this file used to
// exist for: `@glaze/core/*` resolved through the Glaze runtime's ESM loader
// hooks, which no runner could see, so every path had to be discovered by
// walking up the tree. Now the only alias that matters is `@shell/backend`,
// which must point at the STUB, never Electron's real module — a test that
// reached the real one would need an Electron process and would touch the
// user's actual userData.
//
// Keep the aliases here in sync with tsconfig.json paths and
// scripts/build-main.mjs.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

const aliases = {
  // Backend: stubbed. Never the real Electron module — see the header.
  "@shell/backend": path.resolve(here, "main/services/__tests__/shell-backend-stub.ts"),
  "@ui": path.resolve(here, "renderer/ui/index.ts"),
  "@renderer": path.resolve(here, "renderer"),
  "@main": path.resolve(here, "main"),
};

/** `sonner` is a real dependency now, but the stub is kept: it makes toasts
 *  assertable, which several component tests rely on (see the stub's header). */
const sonnerAlias = { sonner: path.resolve(here, "renderer/__tests__/sonner-stub.tsx") };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { ...aliases } },
  test: {
    // Fail loudly rather than silently passing an empty run — a glob typo would
    // otherwise look like a green suite.
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["main/**/*.ts", "renderer/**/*.ts", "renderer/**/*.tsx", "mcp/*.mjs"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.check.ts",
        "**/*.check.mjs",
        "**/__tests__/**",
        "**/*.d.ts",
        "**/*.d.mts",
        "main/services/step-reporter-source.ts",
        "main/services/capture-fixture-source.ts",
        "renderer/preload.ts",
      ],
    },
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { ...aliases } },
        test: {
          name: "node",
          environment: "node",
          include: ["main/**/*.test.ts", "mcp/**/*.test.ts", "renderer/lib/**/*.test.ts"],
          // *.dom.test.ts belongs to the dom project. Without this it matches
          // BOTH globs and every DOM test runs a second time with no document,
          // failing for a reason that has nothing to do with the code.
          exclude: ["**/*.dom.test.ts", "**/node_modules/**"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: { ...aliases, ...sonnerAlias },
          dedupe: ["react", "react-dom"],
        },
        test: {
          name: "dom",
          environment: "jsdom",
          // *.dom.test.ts covers BACKEND code that produces DOM-executing
          // scripts (the injected replayer / capture helpers) — not React, but
          // it genuinely needs a document to run against.
          include: ["renderer/**/*.test.tsx", "main/**/*.dom.test.ts"],
          setupFiles: [path.resolve(here, "renderer/__tests__/setup.ts")],
          css: false,
        },
      },
    ],
  },
});
