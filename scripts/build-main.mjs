// Bundles the Electron main process and the preload script.
//
// Two esbuild passes because the two artifacts have opposite constraints:
//   • main  — ESM (package.json "type": "module", Electron loads it natively),
//             everything bundled except `electron` and the node builtins.
//   • preload — CJS single file. Sandboxed preloads get a require() shim for
//             `electron` but cannot load ESM, so the bundle must be classic.
//
// The renderer build (vite.config.ts) is separate; `npm run build` runs both.

import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const outRoot = new URL("../build/", import.meta.url).pathname;
mkdirSync(outRoot, { recursive: true });

/** Shared: the shim alias mirrors tsconfig paths so the bundle and the
 *  type-checker agree about what `@shell/backend` means. */
const alias = {
  "@shell/backend": "./main/shell/backend.ts",
};

await build({
  entryPoints: ["main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: "build/main/index.js",
  sourcemap: true,
  alias,
  // `playwright` stays out of the bundle: the live page imports it
  // dynamically (main/services/live-page-service.ts) and it resolves from
  // the same node_modules the runner's CLI comes from.
  external: ["electron", "playwright"],
  banner: {
    // Bundling CJS dependencies (pngjs, pixelmatch) into an ESM output makes
    // esbuild emit a `__require` shim, and that shim throws "Dynamic require of
    // 'util' is not supported" the moment one of them requires a node builtin
    // at load time — the app dies before the first window. Restoring a real
    // `require` from import.meta.url gives the shim something to delegate to.
    // Only `require` — main/index.ts declares its own __filename/__dirname, and
    // re-declaring them here is a duplicate-binding SyntaxError at module load.
    js: [
      `import { createRequire as __nodeCreateRequire } from "node:module";`,
      `const require = __nodeCreateRequire(import.meta.url);`,
    ].join("\n"),
  },
  logLevel: "info",
});

// The TypeScript service child (main/services/ts-service/child.ts): forked by
// `utilityProcess` from build/main/ts-service.js. `typescript` stays external —
// 9 MB the child resolves at runtime from the node_modules the parent names,
// the same tree @playwright/test's types are read from.
await build({
  entryPoints: ["main/services/ts-service/child.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  outfile: "build/main/ts-service.js",
  sourcemap: true,
  alias,
  external: ["electron", "typescript"],
  banner: {
    js: [
      `import { createRequire as __nodeCreateRequire } from "node:module";`,
      `const require = __nodeCreateRequire(import.meta.url);`,
    ].join("\n"),
  },
  logLevel: "info",
});

await build({
  entryPoints: ["renderer/preload.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  outfile: "build/assets/preload.js",
  sourcemap: false,
  external: ["electron"],
  logLevel: "info",
});

console.log("[build] main + ts-service + preload bundled");
