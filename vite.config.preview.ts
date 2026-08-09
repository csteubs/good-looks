// Vite config for the browser preview — and ONLY for the browser preview.
//
// The app's real renderer is built by the Glaze SDK (`node glaze.ts build`),
// which owns its own Vite config; this project has never had one of its own and
// still does not for the app. This file exists solely to serve `preview.html`,
// which runs the same renderer in an ordinary browser tab against a fake
// backend (`renderer/dev/`).
//
// Why a second config rather than a flag on the SDK's: the SDK's build resolves
// `@glaze/core/*` through the Glaze runtime's ESM loader hooks and marks the
// framework's own dependencies external, because the packaged app supplies them
// at runtime. A browser tab supplies nothing, so everything has to be bundled
// and every specifier pointed somewhere real. That is a different build, not a
// variant of the same one.
//
// It reproduces exactly three things the SDK's build does, and nothing else:
//   1. the two framework CSS imports it prepends to renderer/styles.css,
//   2. the `__APP_DISPLAY_NAME__` define (an undeclared global is a hard
//      ReferenceError at module scope, which blanks the whole window),
//   3. the React + Tailwind plugin pair.
// Anything else the SDK does is about packaging a native app and has no meaning
// in a tab.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf-8"));

/** Nearest ancestor of `here` (inclusive) containing `rel`, else `here/rel`.
 *
 *  Same candidate-search idiom as `glaze.ts` and `vitest.config.ts`, for the
 *  same reason: a fixed number of `..` hops only holds while this file sits at
 *  the project root. Run from a git worktree (`.claude/worktrees/<branch>/`) and
 *  it lands three directories short, so every `@glaze/core` import fails and the
 *  error names the design system rather than the path. */
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

/** The SDK's prebuilt ESM bundles — the real design system, not a fake. A
 *  preview rendered against a hand-written stand-in for the component library
 *  would be a preview of the stand-in.
 *
 *  `components.tailwind.css` is aliased too: `renderer/styles.css` imports it by
 *  package specifier (see `frameworkCss` below) and Vite has to resolve that in
 *  CSS as well as in JS. */
const glazeAliases = [
  { find: "@glaze/core/components.tailwind.css", replacement: path.join(SDK, "components.tailwind.css") },
  { find: "@glaze/core/components", replacement: path.join(SDK, "components.js") },
  { find: "@glaze/core/hooks", replacement: path.join(SDK, "hooks.js") },
  { find: "@glaze/core/ipc", replacement: path.join(SDK, "ipc.js") },
  { find: "@glaze/core/utils", replacement: path.join(SDK, "utils.js") },
];

/** Every bare specifier the SDK bundles import, pinned to this project's copy.
 *
 *  The bundles live OUTSIDE the project root, so their bare imports cannot
 *  resolve against the app's node_modules on their own. Pinning them fixes
 *  resolution and — the part that actually bites — guarantees the design system
 *  and the app share ONE React instance. Two copies produce "invalid hook call"
 *  at first render, which reads as a component bug.
 *
 *  To refresh this set if the SDK is upgraded and something suddenly fails to
 *  resolve:  grep -ohE 'from"[^".][^"]*"' <sdk>/components.js | sort -u
 *
 *  Most-specific first: alias matching takes the first entry whose `find` is the
 *  id or a path prefix of it, so a bare `react` entry above `react/jsx-runtime`
 *  would swallow it. */
const bareAliases = [
  { find: "react/jsx-runtime", replacement: path.join(MODULES, "react/jsx-runtime.js") },
  { find: "react/jsx-dev-runtime", replacement: path.join(MODULES, "react/jsx-dev-runtime.js") },
  { find: "react-dom/client", replacement: path.join(MODULES, "react-dom/client.js") },
  { find: "react-dom", replacement: path.join(MODULES, "react-dom") },
  { find: "react", replacement: path.join(MODULES, "react") },
  { find: "@tanstack/react-query", replacement: path.join(MODULES, "@tanstack/react-query") },
  // Unlike the test setup, `sonner` is the real package here: this is a running
  // UI, and a toast that silently does not appear is exactly the kind of thing
  // someone would open the preview to check.
  { find: "sonner", replacement: path.join(MODULES, "sonner") },
];

/** The SDK's build prepends these two lines to `renderer/styles.css`, and the
 *  file's own header comment says so. Without them Tailwind emits no utilities
 *  and no theme tokens: the app renders as unstyled HTML, which reads as a
 *  broken bundle rather than a missing import. Copied verbatim from
 *  `<sdk>/build.js` (`FRAMEWORK_CSS_IMPORTS`) — if that ever changes, this is
 *  the line that has to follow it. */
const FRAMEWORK_CSS_IMPORTS = ['@import "@glaze/core/components.tailwind.css";', '@import "tailwindcss";'];
const stylesPath = path.resolve(here, "renderer/styles.css");

/** Serve `preview.html` for any path, not just `/preview.html`.
 *
 *  Vite's built-in SPA fallback serves `index.html`; this project's entry is
 *  `preview.html`, so without this every path except that exact one 404s.
 *
 *  Note what this does NOT do. The app's router uses `createMemoryHistory()`,
 *  so a URL path can never select a view — `/stats` loads the app at its
 *  initial route. Opening one view directly is done with `?view=` / `?test=`
 *  instead (see `preview-boot.ts`). The fallback still earns its place: it
 *  makes a mistyped or stale link land on the app rather than on a Vite 404,
 *  and it is what lets `?view=stats` be written as `/?view=stats`.
 *
 *  Anything with a file extension is left alone so real 404s on assets stay
 *  real 404s rather than silently returning HTML. */
function previewSpaFallback() {
  return {
    name: "preview-spa-fallback",
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(
        (
          req: { url?: string; method?: string; headers: Record<string, string | undefined> },
          _res: unknown,
          next: () => void,
        ) => {
          const url = req.url ?? "/";
          const pathOnly = url.split("?")[0];
          const wantsHtml = (req.headers.accept ?? "").includes("text/html");
          const isAsset = /\.[a-zA-Z0-9]+$/.test(pathOnly);
          if (req.method === "GET" && wantsHtml && !isAsset && !pathOnly.startsWith("/@")) {
            req.url = "/preview.html";
          }
          next();
        },
      );
    },
  };
}

function frameworkCss() {
  return {
    name: "preview-glaze-framework-css",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      const clean = id.includes("?") ? id.slice(0, id.indexOf("?")) : id;
      if (path.resolve(clean) !== stylesPath) return;
      return { code: FRAMEWORK_CSS_IMPORTS.join("\n") + "\n\n" + code, map: null };
    },
  };
}

export default defineConfig({
  root: here,
  // Absolute asset URLs, served from the root.
  //
  // The packaged app uses `base: "./"` because it loads over file:// — but this
  // page cannot. The renderer routes with the history API, so `/stats` and
  // `/test/<id>` serve this same document from a deeper path, and relative
  // asset URLs would resolve against THAT path and 404. Deep links are the
  // point of the preview, so they win; a built preview is served from a host
  // root (and that host needs the same SPA fallback the dev server has).
  base: "/",
  define: {
    __APP_DISPLAY_NAME__: JSON.stringify(pkg.productName ?? pkg.name),
  },
  plugins: [
    previewSpaFallback(),
    react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
    frameworkCss(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      ...glazeAliases,
      ...bareAliases,
      { find: "@renderer", replacement: path.resolve(here, "renderer") },
      { find: "@main", replacement: path.resolve(here, "main") },
    ],
  },
  // A fixed port, not Vite's default 5173: the preview is a thing people and
  // agents link to, and `.claude/launch.json` names the same number. strictPort
  // so a clash fails loudly instead of silently moving the URL.
  server: { port: 5199, strictPort: true, open: "/" },
  build: {
    // Its own directory, so a preview build can never overwrite the renderer the
    // packaged app loads — and so publishing it is just "upload this folder".
    outDir: "build-preview",
    emptyOutDir: true,
    rollupOptions: { input: { preview: path.resolve(here, "preview.html") } },
  },
});
