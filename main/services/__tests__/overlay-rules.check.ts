// Standalone regression check: ONE overlay watcher, ONE locator resolver, and
// a fixture that cannot fail a run.
//
// The whole design of this feature rests on the trainer and the run meaning the
// same thing by a rule. The trainer resolves one inside a live Electron page;
// the run resolves one inside a Playwright worker's init script. Those are
// different worlds with different constraints, and the obvious way to build it
// — a resolver on each side — is the failure `e2e/assert-parity.spec.ts` exists
// to prevent, one level down: two implementations that agree on the day they
// are written and diverge silently afterwards. A rule that resolves in the
// trainer and not in the run is a rule the user watched work and then watched
// fail, with nothing to point at.
//
// So the property is structural rather than behavioural, and a unit test cannot
// see it: both sides must reach `installOverlayWatcher` through
// `watcherSource()`, and the run's copy must carry the app's own `matchesFor`
// rather than a hand-rolled `querySelectorAll`. A second copy would pass every
// existing test.
//
// The other half is the fixture's never-fail rule. It is prose in the header
// today and prose does not run, so the shape is asserted here: nothing in the
// generated fixture may throw into a test, and its diagnostics may not touch
// stdout, which carries the step reporter's markers.
//
// Bundled (it imports capture-script.ts, which pulls in shared modules) — see
// the `check:overlay-rules` script. Run with: npm run check:overlay-rules

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DISMISS_COUNT_ENV,
  DISMISS_ENV_PREFIX,
  dismissEnvNames,
  dismissFixtureSource,
} from "../dismiss-fixture-source.js";
import { buildCaptureScript } from "../../recorder/capture-script.js";
import { normalizeOverlayRule } from "../../recorder/types.js";
import {
  armedRulesFor,
  hostMatches,
  OVERLAY_LOCATOR_KINDS,
  watcherSource,
} from "../../../shared/overlay-rules.mjs";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf-8");
}

// ── One watcher, and both hosts reach it ──────────────────────────────

const WATCHER = watcherSource();
assert(
  WATCHER.includes("function installOverlayWatcher"),
  "shared/overlay-rules.mjs defines the watcher",
);

for (const [label, rel] of [
  ["the capture script", "main/recorder/capture-script.ts"],
  ["the dismissal fixture", "main/services/dismiss-fixture-source.ts"],
] as const) {
  const src = read(rel);
  assert(src.includes("watcherSource()"), `${label} embeds the watcher through watcherSource()`);
  assert(
    !src.includes("function installOverlayWatcher"),
    `${label} does not carry its own copy of the watcher`,
  );
}

// The generated artifacts must actually CONTAIN it — importing the builder is
// not the same as interpolating its result, and a dropped `${…}` is invisible.
const captureScript = buildCaptureScript("check-nonce", [], [
  {
    id: "r1",
    host: "example.com",
    label: "Close",
    target: { k: "testid", v: "close-btn" },
    createdAt: 0,
    updatedAt: 0,
  },
]);
assert(
  captureScript.includes("function installOverlayWatcher"),
  "the built capture script contains the watcher",
);
assert(
  captureScript.includes("installOverlayWatcher([") || captureScript.includes("installOverlayWatcher(["),
  "the built capture script actually calls it with its rules",
);
assert(
  captureScript.includes('"close-btn"'),
  "the built capture script carries the rule it was given",
);
assert(
  dismissFixtureSource.includes("function installOverlayWatcher"),
  "the built dismissal fixture contains the watcher",
);

// ── One resolver ──────────────────────────────────────────────────────

for (const [label, src] of [
  ["capture script", captureScript],
  ["dismissal fixture", dismissFixtureSource],
] as const) {
  assert(src.includes("function matchesFor"), `the ${label} carries the app's own matchesFor`);
  assert(
    src.includes("function shadowRootsIn"),
    `the ${label}'s resolver pierces open shadow roots (the banners this exists for are web components)`,
  );
}

// ── The fixture cannot fail a run, and cannot corrupt the step stream ──

assert(
  !/process\.stdout\.write/.test(dismissFixtureSource),
  "the dismissal fixture never writes to stdout (it carries the step reporter's markers)",
);
assert(
  dismissFixtureSource.includes("process.stderr.write"),
  "the dismissal fixture reports on stderr",
);
// Every exported entry point is wrapped. A throw from here lands in the
// capture fixture's `page` fixture, which fails the test before its first line.
for (const fn of ["installOverlayDismissal", "dismissalsSoFar"]) {
  assert(dismissFixtureSource.includes(fn), `the dismissal fixture exports ${fn}`);
}
assert(
  (dismissFixtureSource.match(/catch \(e\)/g) ?? []).length >= 5,
  "every path in the dismissal fixture swallows its own errors",
);

// ── The runner WRITES the names the fixture READS ─────────────────────
//
// Silent in the worst way if it drifts: the runner sets variables the fixture
// never looks at, every test stays green, and the feature simply never fires.
// So the round trip is exercised rather than eyeballed — build the env the
// runner would, then run the fixture's own reader against it.

const ruleForEnv = {
  id: "r1",
  host: "ritual.com",
  label: "DataGrail — Close",
  target: { k: "testid" as const, v: "dg-header-close" },
  createdAt: 0,
  updatedAt: 0,
};
const names = dismissEnvNames(0);
const env: Record<string, string> = {
  [DISMISS_COUNT_ENV]: "1",
  [names.label]: ruleForEnv.label,
  [names.target]: JSON.stringify(ruleForEnv.target),
};
assert(
  dismissFixtureSource.includes(`process.env.${DISMISS_COUNT_ENV}`),
  "the fixture reads the count variable the runner writes",
);
assert(
  dismissFixtureSource.includes(JSON.stringify(DISMISS_ENV_PREFIX)),
  "the fixture interpolates the shared env prefix rather than retyping it",
);
assert(
  !/["']GLAZE_DISMISS_["'] *\+/.test(dismissFixtureSource),
  "the fixture has no second hand-written spelling of the prefix",
);
{
  // Run the fixture's reader for real against that env — the only way to know
  // the two halves meet.
  const saved = { ...process.env };
  Object.assign(process.env, env);
  let parsed: { label: string; target: { k: string; v?: string } }[] = [];
  try {
    // Everything up to `const RULES = …` is self-contained: the constants,
    // `note`, and `rulesFromEnv` itself. Slicing at a declaration boundary
    // rather than by pattern keeps this a test of the reader, not of a regex.
    const marker = "const RULES = rulesFromEnv();";
    const cut = dismissFixtureSource.indexOf(marker);
    if (cut < 0) throw new Error("could not find the reader's boundary in the fixture");
    const read = new Function(
      `${dismissFixtureSource.slice(0, cut)}; return rulesFromEnv();`,
    ) as () => typeof parsed;
    parsed = read();
  } catch (e) {
    parsed = [];
    console.error(`   (reader threw: ${String(e)})`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert(parsed.length === 1, "the fixture's reader finds the rule the runner wrote");
  assert(
    parsed[0]?.label === ruleForEnv.label && parsed[0]?.target?.v === "dg-header-close",
    "…and reads back its label and target intact",
  );
}

// ── A rule's target is checked, not trusted ───────────────────────────

const base = {
  id: "r1",
  host: "ritual.com",
  label: "Close",
  createdAt: 1,
  updatedAt: 1,
};
assert(
  !OVERLAY_LOCATOR_KINDS.includes("xpath"),
  "xpath is not an overlay locator kind (it encodes a DOM snapshot, not an element)",
);
assert(
  normalizeOverlayRule({ ...base, target: { k: "xpath", v: "/html/body/aside" } }) === null,
  "the normalizer refuses an xpath target",
);
assert(
  normalizeOverlayRule({ ...base, target: { k: "css", v: "b" }, evil: "x" })?.["evil" as never] ===
    undefined,
  "the normalizer rebuilds rather than filters, so an unknown key never survives",
);

// ── Host matching is on label boundaries ──────────────────────────────
//
// A rule CLICKS THINGS on a page. Leaking one onto an attacker-registered
// lookalike domain is the difference between a convenience and a liability,
// and a bare `endsWith` is exactly how that happens.
assert(hostMatches("ritual.com", "https://www.ritual.com/"), "a rule covers its subdomains");
assert(
  !hostMatches("ritual.com", "https://evil-ritual.com/"),
  "a rule does NOT cover a lookalike domain",
);
assert(
  armedRulesFor(
    [{ id: "a", host: "ritual.com", label: "", target: { k: "css", v: "b" }, disabled: true }],
    "https://ritual.com/",
  ).length === 0,
  "a disabled rule is never armed",
);

// ── The trainer's own click never becomes a step ──────────────────────
//
// The watcher runs in the same isolated world as the capture listeners, so its
// click reaches them exactly like a user's. Without the guard at the single
// egress, teaching a rule appends a click on the banner to the test being
// recorded — a step whose target the rule itself removes before it can run.
assert(
  /function push\(step\) \{[\s\S]{0,600}?if \(gl\.suppress > 0\) return;/.test(captureScript),
  "the capture script drops a step recorded while the watcher's own click is in flight",
);
assert(
  captureScript.includes("suppress: 0"),
  "the capture state carries the suppression counter",
);

if (failures > 0) {
  console.error(`\n${failures} overlay-rule check(s) failed.`);
  process.exit(1);
}
console.log("\nAll overlay-rule checks passed");
