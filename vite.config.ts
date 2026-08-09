// Renderer build: three windows, three HTML entries, one shared bundle set.
// The main-process and preload bundles are esbuild's job (scripts/build-main.mjs);
// this config only ever sees browser code.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf-8"));

// `--mode preview` builds the browser preview instead of the app's renderer:
// preview.html plus renderer/dev/, which stand `window.glazeAPI` up over
// fixtures so the whole UI runs in an ordinary browser tab.
//
// A separate mode rather than a fourth entry in the normal build, because the
// preview bundle must never reach the packaged app. The fixtures are fake data
// and the bridge answers every channel without a backend — shipping that
// alongside the real renderer is one bad import away from a build that looks
// fine and silently shows made-up tests.

/** Serve `preview.html` for any path, not just `/preview.html`.
 *
 *  Vite's built-in SPA fallback serves `index.html`; this project's preview
 *  entry is `preview.html`, so without this every path except that exact one
 *  404s.
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

export default defineConfig(({ mode }) => ({
  define: {
    // The Glaze build injected this; the entry points read it to set
    // document.title. An undeclared global is a hard ReferenceError at module
    // scope, which blanks the whole window — so it has to be defined, not just
    // tolerated.
    __APP_DISPLAY_NAME__: JSON.stringify(pkg.productName ?? pkg.name),
  },
  plugins: [
    ...(mode === "preview" ? [previewSpaFallback()] : []),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@ui": path.resolve(here, "renderer/ui"),
      "@renderer": path.resolve(here, "renderer"),
      "@main": path.resolve(here, "main"),
    },
  },
  // The packaged app loads over file://, which needs relative asset URLs — an
  // absolute /assets/… would resolve against the filesystem root and 404.
  //
  // The preview cannot use those. It is served over http from a host root, and
  // the SPA fallback above serves this same document from deeper paths, where a
  // relative URL would resolve against THAT path instead. Deep links are the
  // point of the preview, so it gets absolute URLs.
  base: mode === "preview" ? "/" : "./",
  // A fixed port, not Vite's default: the preview is a thing people and agents
  // link to, and `.claude/launch.json` names the same number. strictPort so a
  // clash fails loudly instead of silently moving the URL.
  server: { port: 5199, strictPort: true, open: "/" },
  build:
    mode === "preview"
      ? {
          // Its own directory, so a preview build can never overwrite the
          // renderer the packaged app loads — and so publishing it is just
          // "upload this folder".
          outDir: "build-preview",
          emptyOutDir: true,
          rollupOptions: {
            input: { preview: path.resolve(here, "preview.html") },
          },
        }
      : {
          outDir: "build",
          emptyOutDir: false,
          rollupOptions: {
            input: {
              "main-window": path.resolve(here, "main-window.html"),
              "settings-window": path.resolve(here, "settings-window.html"),
              "trainer-window": path.resolve(here, "trainer-window.html"),
            },
          },
        },
}));
