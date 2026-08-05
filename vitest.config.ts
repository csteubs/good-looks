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
// The SDK path is resolved from this file rather than hardcoded, so the config
// keeps working if the SDK moves.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The Glaze SDK install this project builds against (see tsconfig paths). */
const SDK = path.resolve(here, "../../../sdk/current/@glaze/core");

/** The SDK bundles live OUTSIDE this project root, so bare `react` imports
 *  inside them can't resolve against the app's node_modules on their own.
 *  Pointing the aliases at the installed copies fixes resolution and, just as
 *  importantly, guarantees components and tests share ONE React instance —
 *  two copies produce "invalid hook call" failures that look like component
 *  bugs. */
const reactAliases = {
  react: path.resolve(here, "node_modules/react"),
  "react-dom": path.resolve(here, "node_modules/react-dom"),
  "react/jsx-runtime": path.resolve(here, "node_modules/react/jsx-runtime.js"),
  "react/jsx-dev-runtime": path.resolve(here, "node_modules/react/jsx-dev-runtime.js"),
  "react-dom/client": path.resolve(here, "node_modules/react-dom/client.js"),
  // Same problem, same fix: every bare specifier the SDK bundle imports has to
  // be pinned to this project's copy. To find the current set if the SDK is
  // upgraded and a test suddenly can't resolve something:
  //   grep -ohE 'from"[^".][^"]*"' <sdk>/components.js | sort -u
  "@tanstack/react-query": path.resolve(here, "node_modules/@tanstack/react-query"),
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
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { ...glazeAliases } },
        test: {
          name: "node",
          environment: "node",
          include: ["main/**/*.test.ts", "mcp/**/*.test.ts", "renderer/lib/**/*.test.ts"],
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
          include: ["renderer/**/*.test.tsx"],
          setupFiles: [path.resolve(here, "renderer/__tests__/setup.ts")],
          // The design system ships CSS the components import; jsdom can't parse
          // it and doesn't need it for behavior assertions.
          css: false,
        },
      },
    ],
  },
});
