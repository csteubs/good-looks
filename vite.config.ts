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
export default defineConfig(({ mode }) => ({
  define: {
    // The Glaze build injected this; the entry points read it to set
    // document.title. An undeclared global is a hard ReferenceError at module
    // scope, which blanks the whole window — so it has to be defined, not just
    // tolerated.
    __APP_DISPLAY_NAME__: JSON.stringify(pkg.productName ?? pkg.name),
  },
  plugins: [
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
  // file:// pages need relative asset URLs; an absolute /assets/… would
  // resolve against the filesystem root and 404 inside the packaged app.
  base: "./",
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
