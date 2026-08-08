// Vitest configuration.
//
// Two projects, because this app has two very different halves:
//   • "node"   — backend services and pure renderer logic. No DOM.
//   • "jsdom"  — React components, which need a DOM to render into.
//
// The whole reason a config is needed at all is `@glaze/core/*`. Those
// specifiers resolve through the Glaze runtime's ESM loader hooks and the
// tsconfig path aliases, neither of which exist under a test runner, so every
// import has to be pointed somewhere real:
//   • `@glaze/core/backend`  → the existing test stub. It must NOT be the real
//     module: that one talks to the native host, and a test that reached it
//     would touch the user's actual userData.
//   • `@glaze/core/components`, `/hooks`, `/ipc` → the SDK's REAL prebuilt ESM
//     bundles, so component tests exercise the actual design system rather than
//     a hand-written fake that can drift from it.
//
// The SDK and node_modules paths are DISCOVERED by walking up from this file
// rather than fixed at a set number of `..` hops. A single hardcoded depth only
// holds while the config sits at the project root: run the suite from a git
// worktree (`.claude/worktrees/<branch>/`) and the same relative path lands
// three directories short, so `@glaze/core/components` and React both fail to
// resolve and EVERY component test errors at import with a message that reads
// like a missing dependency. Same candidate-list idiom as `glaze.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Nearest ancestor of `here` (inclusive) containing `rel`, else `here/rel`. */
function findUp(rel: string): string {
  let dir = here;
  for (;;) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return path.join(here, rel);
    dir = parent;
  }
}

/** The Glaze SDK install this project builds against (see tsconfig paths). */
const SDK = findUp(path.join("sdk", "current", "@glaze", "core"));

/** The installed dependency tree. In a worktree this resolves to the main
 *  checkout's, which is what we want: one React instance, shared. */
const MODULES = findUp("node_modules");

/** The SDK bundles live OUTSIDE this project root, so bare `react` imports
 *  inside them can't resolve against the app's node_modules on their own.
 *  Pointing the aliases at the installed copies fixes resolution and, just as
 *  importantly, guarantees components and tests share ONE React instance —
 *  two copies produce "invalid hook call" failures that look like component
 *  bugs. */
const reactAliases = {
  react: path.join(MODULES, "react"),
  "react-dom": path.join(MODULES, "react-dom"),
  "react/jsx-runtime": path.join(MODULES, "react/jsx-runtime.js"),
  "react/jsx-dev-runtime": path.join(MODULES, "react/jsx-dev-runtime.js"),
  "react-dom/client": path.join(MODULES, "react-dom/client.js"),
  // Same problem, same fix: every bare specifier the SDK bundle imports has to
  // be pinned to this project's copy. To find the current set if the SDK is
  // upgraded and a test suddenly can't resolve something:
  //   grep -ohE 'from"[^".][^"]*"' <sdk>/components.js | sort -u
  "@tanstack/react-query": path.join(MODULES, "@tanstack/react-query"),
};

/** `sonner` is a dependency of the SDK bundle, not of this app — the real
 *  runtime resolves it from the SDK's own install context. Stubbed rather than
 *  installed, which also makes toasts assertable (see the stub's header). */
const sonnerAlias = { sonner: path.resolve(here, "renderer/__tests__/sonner-stub.tsx") };

const glazeAliases = {
  // Backend: stubbed. Never the real thing — see the header.
  "@glaze/core/backend": path.resolve(here, "main/services/__tests__/glaze-backend-stub.ts"),
  // Frontend: the real prebuilt bundles.
  "@glaze/core/components": path.join(SDK, "components.js"),
  "@glaze/core/hooks": path.join(SDK, "hooks.js"),
  "@glaze/core/ipc": path.join(SDK, "ipc.js"),
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      ...glazeAliases,
      ...reactAliases,
      ...sonnerAlias,
      "@renderer": path.resolve(here, "renderer"),
      "@main": path.resolve(here, "main"),
    },
  },
  test: {
    // Fail loudly rather than silently passing an empty run — a glob typo would
    // otherwise look like a green suite.
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // App code only. Test files, generated sources (the reporter/fixture are
      // strings shipped to a subprocess) and config aren't meaningful targets.
      include: ["main/**/*.ts", "renderer/**/*.ts", "renderer/**/*.tsx", "mcp/*.mjs", "shared/*.mjs"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.test.mjs",
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
        resolve: { alias: { ...glazeAliases } },
        test: {
          name: "node",
          environment: "node",
          // `shared/**/*.test.mjs` — the pure core both the app and the MCP
          // import. It was only ever covered INDIRECTLY, through whichever
          // check happened to exercise it, so a rule that both sides depend on
          // had no test naming it. These are plain .mjs, like the modules.
          include: [
            "main/**/*.test.ts",
            "mcp/**/*.test.ts",
            "renderer/lib/**/*.test.ts",
            "shared/**/*.test.mjs",
          ],
          // *.dom.test.ts belongs to the jsdom project. Without this it matches
          // BOTH globs and every DOM test runs a second time with no document,
          // failing for a reason that has nothing to do with the code.
          exclude: ["**/*.dom.test.ts", "**/node_modules/**"],
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: { ...glazeAliases, ...reactAliases, ...sonnerAlias },
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
          // The design system ships CSS the components import; jsdom can't parse
          // it and doesn't need it for behavior assertions.
          css: false,
        },
      },
    ],
  },
});
