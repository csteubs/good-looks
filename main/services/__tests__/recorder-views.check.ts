// The training browser is TWO webContents now, and getting them mixed up is silent.
//
// The recorder window used to load the site itself: `recWindow.webContents` WAS the
// page, and every guard, every injection and every drain hung off it. The URL strip
// split that in two — the page moved into a child WebContentsView, and an app-owned
// view sits above it — and the failure mode of the split is what this check exists
// for. Nothing here throws when it goes wrong:
//
//   • `drain()` and `drainPicked()` swallow their own errors, so a drain pointed at
//     the strip returns nothing and the trainer simply records no steps.
//   • The navigation guards and the denied `openExternal` permission attach happily
//     to a webContents that never navigates anywhere. They protect nothing, and the
//     containment tests still pass because they read the SOURCE.
//   • The incognito partition on the wrong webContents still creates a partition.
//     It just isn't the one the site loads in, so every recording silently starts
//     with the previous session's cookies.
//
// A type error would have been the ideal guard, but both are `WebContents` — they
// are the same type doing different jobs. So the rule is lexical instead: the page
// is reachable only through `pageWc()`, and `recWindow.webContents` may not appear
// in the service at all.
//
// Run: npm run check:recorder-views

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf-8");

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`ok   ${message}`);
  } else {
    console.error(`FAIL ${message}`);
    failures++;
  }
}

const service = read("main/services/recorder-service.ts");

// ── The rule itself ──────────────────────────────────────────────────────
//
// Comments are stripped first. The file explains this rule in prose, and prose
// that quotes the forbidden form must not trip the check that enforces it.
const code = service
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

assert(
  !/recWindow\s*\.\s*webContents/.test(code),
  "recorder-service.ts: never reaches the page as `recWindow.webContents` — the window's own " +
    "webContents renders nothing now, so a call that lands there is a guard protecting nothing " +
    "or a drain returning no steps, and neither throws",
);
assert(
  /function pageWc\(\)/.test(service),
  "recorder-service.ts: defines pageWc(), the one accessor for the training page",
);

// ── Both views are torn down ─────────────────────────────────────────────
//
// A WebContentsView's webContents is NOT owned by the window, so closing the window
// leaves it running. A leaked page view is a live renderer still holding the site,
// its timers and its private partition, for the rest of the app's life.
assert(/function destroyViews\(\)/.test(service), "recorder-service.ts: defines destroyViews()");
const nullingSites = service.split("\n").filter((line) => /^\s*recWindow = null;/.test(line));
assert(
  nullingSites.length > 0,
  "recorder-service.ts: still has paths that clear recWindow (sanity check on this check)",
);
for (const [i] of nullingSites.entries()) void i;
// Every `recWindow = null` must be preceded by a destroyViews() within a few lines —
// those are exactly the teardown paths, and one that forgets leaks the page.
const lines = service.split("\n");
let unguarded = 0;
lines.forEach((line, i) => {
  if (!/^\s*recWindow = null;/.test(line)) return;
  const window = lines.slice(Math.max(0, i - 6), i).join("\n");
  if (!/destroyViews\(\)/.test(window)) unguarded++;
});
assert(
  unguarded === 0,
  "recorder-service.ts: every path that clears recWindow destroys the views first — the page's " +
    "renderer outlives the window otherwise",
);

// ── The page's isolation lives on the page ───────────────────────────────
// Bounded from the creation site FORWARD. `layoutViews();` is also called from
// `pageResizeHost`, which appears earlier in the file — searching for it from the
// top gives a backwards slice, i.e. an empty string that passes every negative
// assertion and fails every positive one.
const pageViewStart = service.indexOf("pageView = new WebContentsView(");
const pageViewBlock = service.slice(
  pageViewStart,
  service.indexOf("layoutViews();", pageViewStart),
);
assert(
  /partition: `recorder-incognito-\$\{randomUUID\(\)\}`/.test(pageViewBlock),
  "the per-session incognito partition is on the PAGE view — on the window it would still create " +
    "a partition, just not the one the site loads in, and every recording would inherit the last " +
    "one's cookies with nothing to show for it",
);
assert(
  !/preload/.test(pageViewBlock.slice(0, pageViewBlock.indexOf("chromeView"))),
  "the page view gets no preload — it holds an arbitrary untrusted site, and the capture script " +
    "reaches it through executeJavaScriptInIsolatedWorld, which needs none",
);

// ── The strip is app chrome, the page is not ─────────────────────────────
assert(
  /chromeView\.webContents\.setZoomFactor\(uiScale\(\)\)/.test(service),
  "the URL strip honours the app's UI scale — it is app chrome",
);
assert(
  !/pageView\.webContents\.setZoomFactor/.test(service),
  "the PAGE is never zoomed with the app — a reading preference must not change the viewport the " +
    "test is recorded against (see ui-scale.ts)",
);

// ── The viewport stays honest ────────────────────────────────────────────
//
// The one correctness hazard of the split: the window's content box holds the strip
// AND the page, so a recorded `viewport` step's number is no longer the window's
// content height. Nothing downstream measures it — the step is written from the
// preset — so a missing offset is invisible until a real run disagrees.
assert(
  /height: viewport \? viewport\.height \+ strip : DEFAULT_WINDOW_HEIGHT/.test(service),
  "the window is created TALLER than the preset by the strip's height, so the PAGE ends up the " +
    "size the recorded viewport step claims",
);
assert(
  /function pageResizeHost\(\)/.test(service) &&
    /win\.setContentSize\(width, height \+ stripHeight\(\), animate\)/.test(service),
  "a replayed `viewport` step resizes through pageResizeHost(), which adds the strip back — " +
    "without it the page is short by the strip on every replay while the step, the spec and the " +
    "run all say otherwise",
);
assert(
  /return \[width, Math\.max\(0, height - stripHeight\(\)\)\]/.test(service),
  "pageResizeHost reads content size back MINUS the strip, or resize-service warns about a " +
    "mismatch it caused itself",
);

// ── The title no longer pretends to be an address bar ────────────────────
assert(
  /wc\.on\("page-title-updated", \(event\) => \{\s*event\.preventDefault\(\);/.test(service),
  "the page cannot rename the training window — Electron's default copies document.title onto " +
    "the window, which is exactly how the old title-bar URL was overwritten on every load",
);

// ── The strip's own wiring ───────────────────────────────────────────────
const html = read("recorder-chrome.html");
assert(
  /renderer\/recorder-chrome\/index\.tsx/.test(html),
  "recorder-chrome.html points at the strip's entry",
);
const viteConfig = read("vite.config.ts");
assert(
  /"recorder-chrome": path\.resolve\(here, "recorder-chrome\.html"\)/.test(viteConfig),
  "recorder-chrome.html is a build entry — without it the strip's bundle is never emitted and " +
    "the view loads a 404 that renders as an empty band above the page",
);

// SPA routes are the case that matters most and the one a naive implementation misses:
// `pushState` fires only `did-navigate-in-page`, so a bar wired to `did-navigate` alone
// shows the entry URL for the whole session on exactly the sites people record against.
for (const event of ["did-navigate", "did-navigate-in-page", "did-redirect-navigation"]) {
  assert(
    new RegExp(`wc\\.on\\("${event}"`).test(service),
    `the URL strip tracks ${event}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll recorder-views checks passed.");
