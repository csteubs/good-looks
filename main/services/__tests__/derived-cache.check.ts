// One owner for every cache a finished run invalidates.
//
// WHY THIS EXISTS. `check:push-consumers` proves somebody listens to each
// backend→renderer push. It cannot ask the two questions that actually decide
// whether the screen updates:
//
//   1. IS THE LISTENER MOUNTED WHEN THE EVENT FIRES? A `runs:changed`
//      subscription inside a ROUTE component satisfies push-consumers while
//      being dead on every other route. That is not hypothetical — it is how
//      the Stats board's Speed and Step-health tiles worked, and the store's own
//      comments record the same bug being fixed twice before (the sidebar's
//      stale verdict dot, and `batch-view`'s invalidation in §6.8).
//   2. DOES A CACHE A RUN WRITES HAVE ANY REFRESH PATH AT ALL? `["flake"]` had
//      none, anywhere in the app. `["heals"]` had none from a run — only from
//      the user's own accept/revert — even though Auto-Heal journals a heal
//      mid-run. Neither is a push problem, so no amount of push-side checking
//      would ever have seen them.
//
// So this check pins the rule that closes both: the six run-derived caches are
// named once in `renderer/lib/run-derived-cache.ts`, and exactly one
// subscription — the one in `RecorderProvider`, which is mounted for the whole
// session — invalidates them.
//
// NO ALLOWLIST, same reasoning as push-consumers. If a view genuinely needs to
// react to a run beyond refreshing a cache, it can subscribe and do that; what
// it may not do is invalidate, because an invalidation that only happens on one
// route is indistinguishable from the bug.
//
// ── How this check could lie, and what stops it ──────────────────────
//
// IT COULD GO BLIND. A scanner that quietly stops matching harvests zero
// subscriptions, and zero subscriptions have zero violations — green because it
// found nothing. Three guards: the harvest is floored, the store's own
// subscription is pinned by name, and the detector is run against a synthetic
// violating fixture and must flag it. That last one is the important one; it is
// this file's version of "verify a test can fail".
//
// Run with: npm run check:derived-cache

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RENDERER = join(REPO, "renderer");
const STORE = join("renderer", "main", "recorder-store.tsx");
const MODULE = join("renderer", "lib", "run-derived-cache.ts");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The source of the handler passed to every `api.on("runs:changed", …)` in one
 * file.
 *
 * Scans for the channel literal and returns the balanced remainder of the call.
 * Parens inside string literals are skipped — a handler that toasts "Done :)"
 * would otherwise close the call early and hide everything after it, which is
 * the failure mode where a check reads working code as clean and broken code as
 * clean too.
 */
export function runsChangedHandlers(src: string): string[] {
  const out: string[] = [];
  const needle = `"runs:changed"`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;
    // Only a subscription, not an emit or a comment mentioning the channel.
    const before = src.slice(Math.max(0, at - 40), at);
    if (!/\bon\s*(<[^>]*>)?\s*\(\s*$/.test(before)) continue;

    let i = from;
    let depth = 1; // already inside the api.on( call
    let quote: string | null = null;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    out.push(src.slice(from, i));
  }
  return out;
}

/** Does this handler body mutate the query cache? */
export function invalidatesCache(handler: string): boolean {
  return /\b(invalidateQueries|refetchQueries|resetQueries|invalidateRunDerived)\b/.test(handler);
}

// ── 1. The detector works (positive control) ──────────────────────────

const FIXTURE = `
  const off = api.on("runs:changed", () => {
    qc.invalidateQueries({ queryKey: ["replays"] });
  });
`;
const FIXTURE_CLEAN = `
  const off = api.on("runs:changed", () => {
    setSeen(true); // reacts, but owns no cache
  });
`;
const fixtureFound = runsChangedHandlers(FIXTURE);
assert(fixtureFound.length === 1, "detector finds a runs:changed subscription");
assert(
  fixtureFound.length === 1 && invalidatesCache(fixtureFound[0]),
  "detector flags an invalidating handler (this check can fail)",
);
assert(
  runsChangedHandlers(FIXTURE_CLEAN).every((h) => !invalidatesCache(h)),
  "detector does not flag a handler that only sets local state",
);

// ── 2. The harvest is not empty ───────────────────────────────────────

const files = walk(RENDERER).filter((f) => !/\.test\.tsx?$/.test(f));
const subscriptions = new Map<string, string[]>();
for (const file of files) {
  const handlers = runsChangedHandlers(readFileSync(file, "utf-8"));
  if (handlers.length > 0) subscriptions.set(relative(REPO, file), handlers);
}

assert(files.length > 100, `scanned the renderer (${files.length} files)`);
assert(subscriptions.size > 0, "found at least one runs:changed subscription");
assert(subscriptions.has(STORE), `the store subscribes to runs:changed (${STORE})`);

// ── 3. Only the store invalidates ─────────────────────────────────────

for (const [file, handlers] of subscriptions) {
  if (file === STORE) continue;
  const offenders = handlers.filter(invalidatesCache);
  assert(
    offenders.length === 0,
    `${file} subscribes to runs:changed without invalidating ` +
      `(a route component's invalidation only runs while that route is mounted)`,
  );
}

const storeHandlers = subscriptions.get(STORE) ?? [];
assert(
  storeHandlers.some((h) => /\binvalidateRunDerived\b/.test(h)),
  "the store's runs:changed handler calls invalidateRunDerived",
);

// ── 4. The list is real, and still covers the three regressions ───────

const moduleSrc = readFileSync(join(REPO, MODULE), "utf-8");
const listed = [...moduleSrc.matchAll(/^\s*\["([a-zA-Z-]+)"\],/gm)].map((m) => m[1]);
assert(listed.length >= 6, `run-derived-cache names its keys (${listed.length} found)`);

// Pinned BY NAME because each one is a bug that shipped: nothing in the app ever
// invalidated ["flake"]; ["heals"] was only invalidated by the user's own
// accept/revert although a run journals heals; ["replays"] was invalidated from
// inside VisualView, so the Stats board's Visual tile never saw a new run.
for (const key of ["runs", "flake", "heals", "replays", "metrics", "captureOverhead"]) {
  assert(listed.includes(key), `["${key}"] is invalidated when a run finishes`);
}

// A key nobody reads is a list that has rotted. Every entry must be a prefix of
// some useQuery key in the renderer, or the invalidation is refetching nothing.
const rendererSrc = files.map((f) => readFileSync(f, "utf-8")).join("\n");
for (const key of listed) {
  assert(
    new RegExp(`queryKey:\\s*\\[\\s*"${key}"`).test(rendererSrc),
    `["${key}"] is actually read by a useQuery somewhere`,
  );
}

// ── 5. Script changes stay OUT ────────────────────────────────────────

// Not a run-derived cache: `scriptChangeStore.record` is reached only from an
// IPC handler on a user action, never from the runner. Adding it here would
// refetch it after every run for nothing. Pinned so the next person to look at
// the Heals view — which reads heals AND script changes side by side — does not
// add it by symmetry.
assert(
  !listed.includes("script-changes"),
  '["script-changes"] stays out of the run-derived list (no run writes one)',
);

console.log(failures === 0 ? "\nderived-cache: OK" : `\nderived-cache: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
