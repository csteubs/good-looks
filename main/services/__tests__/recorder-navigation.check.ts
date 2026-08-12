// Source-level guard on the training window's navigation containment.
//
// recorder-navigation.test.ts proves the DECISION is right. This proves the
// decision is actually reachable — that every escape route is wired to it, and
// that the patterns which let a replay out of the training window cannot come
// back. Those are structural facts about the source, invisible to a unit test:
// an event nobody subscribed to raises no failure anywhere, it just quietly
// resolves to Glaze's default, which is the system browser.
//
// This is the failure that prompted it: a replay left the training window and
// drove a different browser that happened to be open, because `will-redirect`
// had no listener. Nothing in the app could have detected that — the damage
// happened in another program.
//
// Run with: npm run check:recorder-navigation

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DENIED_RECORDER_PERMISSIONS, GUARDED_NAVIGATION_EVENTS } from "../recorder-navigation.js";

const here = dirname(fileURLToPath(import.meta.url));
const mainDir = resolve(here, "../..");
const servicePath = resolve(mainDir, "services/recorder-service.ts");
const service = readFileSync(servicePath, "utf8");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── The decision is the only decision ────────────────────────────────
assert(
  /import\s*\{[^}]*decideNavigation[^}]*\}\s*from\s*"\.\/recorder-navigation\.js"/s.test(service),
  "recorder-service imports decideNavigation",
);

assert(
  service.includes("for (const event of GUARDED_NAVIGATION_EVENTS)"),
  "handlers are attached by iterating GUARDED_NAVIGATION_EVENTS, so adding an event wires it",
);

// Every event the module declares dangerous must be covered by that loop. The
// loop makes this automatic — the assertion is here so that replacing it with
// hand-written `wc.on(...)` calls is caught.
for (const event of GUARDED_NAVIGATION_EVENTS) {
  const handWired = new RegExp(`wc\\.on\\(\\s*"${event}"`).test(service);
  assert(
    !handWired || service.includes("for (const event of GUARDED_NAVIGATION_EVENTS)"),
    `"${event}" is guarded (not hand-wired around the shared handler)`,
  );
}

assert(
  GUARDED_NAVIGATION_EVENTS.includes("will-redirect"),
  "will-redirect is guarded — a cross-origin 302 is what escaped originally",
);

// ── The old fail-open shapes must not return ─────────────────────────
// Each of these was an early `return` on the escape path, and "return" here
// means "let Glaze route it to the system browser".
assert(
  !/if\s*\(\s*!details\.isMainFrame[^)]*\)\s*return/.test(service),
  "no early return on !isMainFrame (a missing field disabled the whole guard)",
);
assert(
  !/if\s*\(\s*!\/\^https\?:\/i\.test\([^)]*\)\s*\)\s*return/.test(service),
  "no early return for non-http schemes (they hand off to the OS)",
);

// ── window.open and child windows ────────────────────────────────────
{
  const handler = service.slice(
    service.indexOf("setWindowOpenHandler"),
    service.indexOf("did-create-window"),
  );
  assert(handler.length > 0, "setWindowOpenHandler is installed");
  assert(
    /return\s*\{\s*action:\s*"deny"\s*\}/.test(handler),
    "…and denies every window.open, without exception",
  );
  assert(
    !/action:\s*"allow"/.test(handler),
    "…and never allows one, whatever the URL looks like",
  );
}
assert(
  /wc\.on\("did-create-window"/.test(service) && /\.close\(\)/.test(service),
  "a child window created despite the deny is closed as a backstop",
);

// ── The capability itself is denied ──────────────────────────────────
// The event guards are the second layer. This is the first: handing a URL to
// the OS is a permission, and the training window is refused it.
assert(
  service.includes("setPermissionRequestHandler"),
  "the training window installs a permission request handler",
);
assert(
  service.includes("setPermissionCheckHandler"),
  "…and a permission CHECK handler (a check that returns true bypasses the request)",
);
assert(
  /permissionAllowed\(permission\)/.test(service),
  "…both routed through permissionAllowed, so the denied set is defined in one place",
);
assert(
  DENIED_RECORDER_PERMISSIONS.includes("openExternal"),
  "openExternal is in the denied set",
);
assert(
  service.includes("Training window containment armed"),
  "the armed guards are logged at session start, so a future report says which build was running",
);

// ── No other route out of the app ────────────────────────────────────
// shell.openExternal hands a URL to the OS by definition.
//
// This was a blanket ban, on the grounds that nothing needed the capability and
// "its absence is far easier to keep than its correctness". The branch menu's
// pull-request icon needed it, so the ban is now a ONE-FILE ALLOWLIST rather
// than an exception someone can add a second entry to by editing a regex.
//
// What makes the exception safe is not the validator in `external-url.ts` —
// that is pinned separately by `check:open-external`, and it is the second
// layer. It is that THE TRAINING WINDOW HAS NO PRELOAD: `ipcMain.handle`
// registers a channel every renderer can invoke, so the question this check
// exists to answer is whether the untrusted page can reach it, and the answer
// is that it has no `glazeAPI` object to reach it with. That fact was load-
// bearing and unpinned before this handler existed; it is asserted below,
// because a preload added to the training window for some unrelated debugging
// convenience would hand an arbitrary website the whole host surface.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

{
  /** The single audited call site. Adding a second entry here is a decision,
   *  not a fix — every other file in `main/` stays banned. */
  const ALLOWED = ["main/shell/host-handlers.ts"];

  // A CALL, not the word: "openExternal" also names the permission we deny, and
  // matching the bare identifier would flag the very code doing the denying.
  const CALLS_OPEN_EXTERNAL = /(?:shell|Shell)\s*\.\s*openExternal\s*\(|(?<![."'`\w])openExternal\s*\(/;
  const callers = walk(mainDir)
    .filter((file) => !file.endsWith("recorder-navigation.check.ts"))
    .filter((file) => CALLS_OPEN_EXTERNAL.test(readFileSync(file, "utf8")))
    .map((file) => file.replace(mainDir, "main"));

  const offenders = callers.filter((file) => !ALLOWED.includes(file));
  assert(
    offenders.length === 0,
    `only ${ALLOWED.join(", ")} may call openExternal (found: ${offenders.join(", ") || "none"})`,
  );
  // The allowlist entry is not permission to stop calling it: if the handler is
  // deleted or renamed, this check should stop claiming to guard a call site
  // that no longer exists rather than passing vacuously forever.
  assert(
    callers.includes(ALLOWED[0]),
    `${ALLOWED[0]} still holds the one openExternal call this allowlist is for`,
  );
}

// ── Why the one exception is safe: no preload on the PAGE view ───────
// `ipcMain.handle` is process-wide. A channel registered for the app's own
// windows is invokable by ANY renderer holding the preload bridge, so what
// decides whether an arbitrary website can call `shell:openExternal` is the
// `webPreferences` of the view the untrusted page loads into. It sets
// `partition` and nothing else, and that omission is the whole guarantee.
//
// THE TRAINING WINDOW IS TWO VIEWS, and conflating them is how this check goes
// quietly wrong. `pageView` is the site; `chromeView` is the app's own URL strip
// above it, which needs the preload to talk to us and legitimately has one. An
// earlier version of this asserted the file never mentioned `getPreloadPath` at
// all — true when the trainer had no chrome of its own, and false the moment the
// URL bar landed. It also read "the first `webPreferences` block", which passed
// only because `pageView` happens to be constructed first; reorder the two and
// it would have audited the wrong view while still reporting ok.
//
// So both assertions anchor on the VIEW BY NAME.
{
  /** The options block of `<name> = new WebContentsView({ webPreferences: {…} })`.
   *  Non-greedy to the first `}`, which is why the *anchor* has to be the name —
   *  the shape is fragile, the identifier is not. */
  function prefsOf(name: string): string | null {
    const re = new RegExp(
      `${name}\\s*=\\s*new WebContentsView\\(\\{[\\s\\S]*?webPreferences:\\s*\\{([\\s\\S]*?)\\}`,
    );
    return re.exec(service)?.[1] ?? null;
  }

  const pagePrefs = prefsOf("pageView");
  assert(
    pagePrefs !== null,
    "found pageView's webPreferences — if this fails the view was renamed and the checks below are auditing nothing",
  );
  assert(
    pagePrefs !== null && !/\bpreload\s*:/.test(pagePrefs),
    "the untrusted page's view gets NO preload, so a website has no glazeAPI to invoke host channels with",
  );
  assert(
    pagePrefs !== null && !/nodeIntegration\s*:\s*true/.test(pagePrefs),
    "…and no nodeIntegration",
  );
  assert(
    pagePrefs !== null && !/contextIsolation\s*:\s*false/.test(pagePrefs),
    "…and context isolation is not turned off",
  );

  // The URL strip is ours and may have one. Pinning the COUNT is what keeps that
  // exception from becoming a second one nobody notices: a preload added to any
  // other view in this file fails here even if it dodges the block match above.
  const preloadUses = service.match(/\bpreload\s*:/g)?.length ?? 0;
  assert(
    preloadUses === 1,
    `exactly one view in recorder-service has a preload — the app's own URL strip (found ${preloadUses})`,
  );
  const chromePrefs = prefsOf("chromeView");
  assert(
    chromePrefs !== null && /\bpreload\s*:/.test(chromePrefs),
    "…and it is chromeView's, the app's own URL strip, not the page's",
  );
}

// ── Containment is reported, not silent ──────────────────────────────
assert(
  service.includes('sendToMain("recorder:navigationBlocked"'),
  "a blocked navigation is pushed to the renderer, so it is visible to the user",
);
assert(
  /logger\.(warn|error)\(\s*"recorder"/.test(service),
  "…and logged, so it is diagnosable after the fact",
);
assert(
  service.includes("Could not cancel a navigation"),
  "a preventDefault that itself throws is reported rather than swallowed",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll recorder-navigation checks passed");
