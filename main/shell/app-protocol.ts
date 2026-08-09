// Serves the built renderer over a custom `app://` scheme instead of `file://`.
//
// WHY THIS EXISTS. Vite emits ES module scripts (`<script type="module"
// crossorigin>`). Loaded from `file://`, a module script has an opaque origin
// (`null`) and the browser's CORS rules block it outright — the window opens,
// renders nothing, and the main process logs a clean startup, so the failure
// looks like a blank app rather than a blocked fetch. Registering a real
// scheme gives the renderer a proper secure origin, which also lets the pages'
// CSP say `'self'` and mean something.
//
// The alternative — `webPreferences.webSecurity: false` — would "work" and is
// wrong: this app loads arbitrary untrusted websites in its training windows,
// and turning off web security is not a thing to do in that process.

import * as fs from "fs";
import * as path from "path";

import { app, net, protocol } from "electron";

import { logger } from "./logger.js";
import { getBuildRoot } from "../windows/window-paths.js";

export const APP_SCHEME = "app";
/** Host portion of the URL. Fixed — the scheme serves exactly one directory. */
export const APP_HOST = "bundle";

/** Must be called BEFORE `app.whenReady()`; Electron only reads the privileged
 *  scheme list during startup. `standard` gives the scheme a real origin (so
 *  `'self'` works in CSP), `secure` puts it on par with https for mixed-content
 *  and secure-context APIs, `supportFetchAPI` lets Vite's module graph load. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/**
 * Install the handler. Call after `app.whenReady()`.
 *
 * Containment is the same rule the rest of this codebase applies to paths: the
 * resolved REAL path must sit inside the real build root, or the request is
 * refused. A URL cannot reach outside the bundle by spelling `..`, and a
 * symlink inside the bundle cannot be used to read the rest of the disk.
 */
export function installAppProtocol(): void {
  const rawRoot = getBuildRoot();
  let root: string;
  try {
    root = fs.realpathSync(rawRoot);
  } catch {
    root = path.resolve(rawRoot);
  }

  protocol.handle(APP_SCHEME, async (request) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // Strip the leading slash so `path.join` treats it as relative, then join
    // and re-resolve; `..` is collapsed here, and the check below is what
    // actually enforces containment.
    const candidate = path.resolve(root, "." + (pathname || "/index.html"));
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      logger.warn("shell", "Refused an app:// request outside the bundle", { pathname });
      return new Response("Forbidden", { status: 403 });
    }

    const type = MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream";
    const response = await net.fetch(`file://${real}`);
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": type },
    });
  });

  logger.info("shell", "Registered the app:// protocol", { root });
}

/** URL for one of the renderer's HTML entry points. */
export function appUrl(htmlFileName: string): string {
  return `${APP_SCHEME}://${APP_HOST}/${htmlFileName}`;
}

/** True once Electron is ready and the handler can be installed. */
export function isProtocolReady(): boolean {
  return app.isReady();
}
