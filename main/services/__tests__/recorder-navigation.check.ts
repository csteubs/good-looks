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
// shell.openExternal hands a URL to the OS by definition. There is no use for
// it on any path the trainer can reach, and its absence is far easier to keep
// than its correctness.
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
  // A CALL, not the word: "openExternal" also names the permission we deny, and
  // matching the bare identifier would flag the very code doing the denying.
  const CALLS_OPEN_EXTERNAL = /(?:shell|Shell)\s*\.\s*openExternal\s*\(|(?<![."'`\w])openExternal\s*\(/;
  const offenders = walk(mainDir).filter((file) => {
    if (file.endsWith("recorder-navigation.check.ts")) return false;
    return CALLS_OPEN_EXTERNAL.test(readFileSync(file, "utf8"));
  });
  assert(
    offenders.length === 0,
    `no main-process file CALLS openExternal (found: ${offenders.map((f) => f.replace(mainDir, "main")).join(", ") || "none"})`,
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
