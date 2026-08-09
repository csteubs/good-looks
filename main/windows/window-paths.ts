import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// Use unique names to avoid conflicts with esbuild's CommonJS shims
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = path.dirname(currentFilePath);

// Backend is bundled to build/main/index.js; HTML entries are at build/.
// So one level up from build/main/ is the build root.
const BUILD_ROOT = path.resolve(currentDirPath, "..");

/**
 * Absolute path to the build directory that contains HTML entry points.
 */
export function getBuildRoot(): string {
  return BUILD_ROOT;
}

/**
 * Resolve the on-disk HTML file for a given window.
 */
export function resolveWindowHtml(htmlFileName: string): string {
  return path.join(BUILD_ROOT, htmlFileName);
}

/**
 * Return a file:// URL for a locally built HTML file.
 */
export function getWindowFileUrl(htmlFileName: string): string {
  return pathToFileURL(resolveWindowHtml(htmlFileName)).toString();
}

/**
 * Absolute path to the built preload bundle (esbuild, CJS — see
 * scripts/build-main.mjs). Electron injects it via webPreferences.preload,
 * which must be a real file even in dev, so `npm run dev` builds it first.
 */
export function getPreloadPath(): string {
  return path.join(BUILD_ROOT, "assets", "preload.js");
}

/**
 * Resolve the correct URL for a window, preferring the dev server when one is
 * running. scripts/dev.mjs passes its Vite server origin in GOOD_LOOKS_DEV_URL;
 * a packaged or plain `electron .` launch has no env var and is served over the
 * app:// scheme.
 *
 * NOT file:// — Vite emits module scripts, and a module script loaded from
 * file:// has a null origin and is blocked by CORS, which presents as a blank
 * window with a clean log. See shell/app-protocol.ts.
 */
export async function getWindowUrl(htmlFileName: string): Promise<string> {
  const devUrl = process.env.GOOD_LOOKS_DEV_URL;
  if (devUrl) {
    return `${devUrl.replace(/\/$/, "")}/${htmlFileName}`;
  }
  return `app://bundle/${htmlFileName}`;
}
