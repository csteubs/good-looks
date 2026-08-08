// Standalone regression check for the "Crawl" test speed.
//
// THE BUGS THIS EXISTS FOR. Crawl fails silently in three different ways, and
// none of them produces an error message:
//
//   1. It settles nothing. The step delay still applies, so the run is visibly
//      slower and looks like it worked. The only symptom is the flake it was
//      supposed to remove still happening — which reads as "crawl doesn't help"
//      rather than "crawl isn't running".
//   2. It fails the test it was meant to stabilise. Every wait here is against
//      a live page that may navigate, close, or never go idle. An unhandled
//      rejection from an abandoned wait fails the run, and the failure points
//      at the user's test rather than at this fixture.
//   3. It times out. Crawl multiplies run time; against the 60s default
//      timeout, choosing the resilient speed makes tests fail. That one is
//      worse than doing nothing at all.
//
// WHY THE FIXTURE IS EXECUTED FOR REAL. `settle()` is a source string this app
// writes to disk for Playwright to load, so nothing type-checks it and nothing
// imports it. It is loaded here from a data: URL and driven against fake page
// objects, because the properties that matter — "never throws", "never leaks a
// rejection", "bounded" — are behaviour, and a source-text assertion would pass
// against a fixture that does none of them.
//
// Run with: npm run check:crawl-speed

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CRAWL_MIN_TEST_TIMEOUT_MS,
  resolveTestTimeoutMs,
  SLOW_MO_MS,
} from "../run-pacing.js";
import {
  SETTLE_FIXTURE_FILE,
  SETTLE_IDLE_TIMEOUT_MS,
  SETTLE_LOAD_TIMEOUT_MS,
  SETTLE_PAINT_TIMEOUT_MS,
  settleFixtureSource,
} from "../settle-fixture-source.js";
import { captureFixtureSource } from "../capture-fixture-source.js";
import { LOCATOR_ACTIONS, PAGE_ACTIONS } from "../page-actions.js";
import { MAX_TEST_TIMEOUT_MS } from "../recorder-settings-store.js";
import { isTestSpeed, TEST_SPEEDS, TEST_SPEED_LABELS } from "../../recorder/types.js";
import {
  TEST_SPEEDS as RENDERER_TEST_SPEEDS,
  TEST_SPEED_LABELS as RENDERER_TEST_SPEED_LABELS,
} from "../../../renderer/lib/recorder-types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ── 1. The speed itself ───────────────────────────────────────────────

assert(TEST_SPEEDS.includes("crawl"), "TEST_SPEEDS: includes crawl");
assert(TEST_SPEEDS[0] === "crawl", "TEST_SPEEDS: crawl is the slowest stop (index 0)");
assert(
  TEST_SPEEDS.every((s) => typeof TEST_SPEED_LABELS[s] === "string" && TEST_SPEED_LABELS[s] !== ""),
  "TEST_SPEED_LABELS: every speed has a label",
);
assert(
  Object.keys(TEST_SPEED_LABELS).length === TEST_SPEEDS.length,
  "TEST_SPEED_LABELS: no label for a speed that isn't in the list",
);
assert(
  TEST_SPEEDS.every((s) => isTestSpeed(s)),
  "isTestSpeed: accepts every declared speed",
);
assert(
  !isTestSpeed("turbo") && !isTestSpeed(undefined) && !isTestSpeed(3),
  "isTestSpeed: rejects anything else",
);

// The renderer keeps its own copy of the speed union, under a "Keep shapes in
// sync" comment. A comment is not a check, and the two halves failing to agree
// is silent both ways: a speed only main knows about is one the UI can never
// offer, and a speed only the renderer knows about is one `tests:setSpeed`
// rejects — from a picker that happily shows it.
assert(
  RENDERER_TEST_SPEEDS.join(",") === TEST_SPEEDS.join(","),
  "renderer mirror: the same speeds, in the same order, as main",
);
assert(
  TEST_SPEEDS.every((s) => RENDERER_TEST_SPEED_LABELS[s] === TEST_SPEED_LABELS[s]),
  "renderer mirror: the same label for every speed",
);

// The MCP server keeps a THIRD copy of the delay table (it spawns Playwright
// itself, without importing this codebase). Read as text rather than imported:
// importing server.mjs starts an MCP server on stdio.
//
// This one is the nastiest of the three to lose. A speed missing from that
// table reads as `undefined`, and the server's `?? 0` turns it into a
// full-speed run of a test the user deliberately slowed down — reported as a
// normal pass or fail, with nothing anywhere saying the pacing was ignored.
// The prompt builder keeps a fourth copy, for the line that tells the model how
// the run was paced. A stale one here is quieter than the MCP case but is still
// the app confidently stating a wrong number to something reasoning from it.
//
// Both are read as TEXT rather than imported: importing server.mjs starts an
// MCP server on stdio. Anchored on cwd, not on import.meta.url — this check is
// bundled into node_modules/.cache before it runs, so a source-relative path
// would resolve from the cache directory. `npm run` always starts at the root.
function delayTableIn(relPath: string): Map<string, number> {
  const src = readFileSync(resolve(process.cwd(), relPath), "utf8");
  const table = /SLOW_MO_MS[^=]*= \{([^}]*)\}/.exec(src)?.[1] ?? "";
  const delays = new Map<string, number>();
  for (const m of table.matchAll(/(\w+)\s*:\s*(\d+)/g)) delays.set(m[1], Number(m[2]));
  return delays;
}

for (const [label, relPath] of [
  ["mcp", "mcp/server.mjs"],
  ["llm-prompts", "renderer/lib/llm-prompts.ts"],
] as const) {
  const delays = delayTableIn(relPath);
  assert(delays.size > 0, `${label} mirror: found the SLOW_MO_MS table in ${relPath}`);
  for (const speed of TEST_SPEEDS) {
    assert(
      delays.get(speed) === SLOW_MO_MS[speed],
      `${label} mirror: "${speed}" is ${SLOW_MO_MS[speed]}ms there too`,
    );
  }
}

// Pinned as an ORDER, not as numbers: the point is that each named speed is
// slower than the next one up. Asserting 2500 would just restate the constant.
assert(
  TEST_SPEEDS.every((s) => typeof SLOW_MO_MS[s] === "number"),
  "SLOW_MO_MS: has a delay for every speed (a missing one is NaN ms, not an error)",
);
assert(
  SLOW_MO_MS.crawl > SLOW_MO_MS.slow &&
    SLOW_MO_MS.slow > SLOW_MO_MS.medium &&
    SLOW_MO_MS.medium > SLOW_MO_MS.fast,
  "SLOW_MO_MS: strictly decreasing from crawl to fast",
);

// ── 2. The timeout floor ──────────────────────────────────────────────

{
  const nonCrawl = resolveTestTimeoutMs(undefined, undefined, "slow");
  assert(
    nonCrawl.timeoutMs === 60_000 && !nonCrawl.raised,
    "resolveTestTimeoutMs: a non-crawl run is unaffected by the floor",
  );

  const explicitShort = resolveTestTimeoutMs(30_000, undefined, "fast");
  assert(
    explicitShort.timeoutMs === 30_000 && !explicitShort.raised,
    "resolveTestTimeoutMs: a per-test timeout wins over the default",
  );

  // The whole reason the floor exists: without it this run gets 30s to do
  // something that takes minutes, and crawl makes the test fail.
  const crawlShort = resolveTestTimeoutMs(30_000, undefined, "crawl");
  assert(
    crawlShort.timeoutMs === CRAWL_MIN_TEST_TIMEOUT_MS && crawlShort.raised,
    "resolveTestTimeoutMs: crawl raises a timeout below the floor, and reports it",
  );

  const crawlDefault = resolveTestTimeoutMs(undefined, undefined, "crawl");
  assert(
    crawlDefault.timeoutMs === CRAWL_MIN_TEST_TIMEOUT_MS && crawlDefault.raised,
    "resolveTestTimeoutMs: crawl raises the 60s default too",
  );

  // A floor, not an override — a user who asked for longer keeps it.
  const crawlLong = resolveTestTimeoutMs(20 * 60 * 1000, undefined, "crawl");
  assert(
    crawlLong.timeoutMs === 20 * 60 * 1000 && !crawlLong.raised,
    "resolveTestTimeoutMs: crawl leaves a timeout above the floor alone",
  );

  assert(
    resolveTestTimeoutMs(undefined, undefined, "crawl").timeoutMs <= MAX_TEST_TIMEOUT_MS,
    "resolveTestTimeoutMs: the crawl floor never exceeds the app-wide maximum",
  );
}

// ── 3. Wiring: the fixture is reachable and installed in the right order ──

assert(
  captureFixtureSource.includes(`from "./${SETTLE_FIXTURE_FILE}"`),
  "capture fixture: imports the settle fixture (its only route into a run)",
);
assert(
  /const SETTLE_ON = process\.env\.GLAZE_SETTLE === "1"/.test(captureFixtureSource),
  "capture fixture: gates settling on GLAZE_SETTLE",
);
assert(
  /\|\| SETTLE_ON\) \? base\.extend/.test(captureFixtureSource),
  "capture fixture: a crawl-only run still gets the extended test (not bare `base`)",
);

{
  // Install ORDER is the contract: each patch wraps the previous one, so
  // settling must be installed BEFORE capture's patchOnce or every screenshot
  // is taken of a page that is still loading.
  // The CALL sites, not the definitions — `function patchOnce(page)` appears
  // earlier in the file than either call and would make this pass vacuously.
  const installAt = captureFixtureSource.indexOf("installSettle(page);");
  const patchAt = captureFixtureSource.indexOf("patchOnce(page);");
  assert(installAt > 0 && patchAt > 0, "capture fixture: installs settling and patches capture");
  assert(
    installAt < patchAt,
    "capture fixture: settling is installed BEFORE capture patches (action → settle → screenshot)",
  );
}

// ── 4. Drift: both fixtures patch the same actions ────────────────────
//
// The failure this pins is silent by construction. Add an action to capture
// only, and that step still runs and still screenshots — it just never settles,
// so crawl quietly stops covering it.

for (const action of [...PAGE_ACTIONS, ...LOCATOR_ACTIONS]) {
  assert(
    settleFixtureSource.includes(`"${action}"`),
    `settle fixture: patches "${action}"`,
  );
  assert(
    captureFixtureSource.includes(`"${action}"`),
    `capture fixture: patches "${action}"`,
  );
}

// ── 5. The fixture, executed ──────────────────────────────────────────

interface FakePage {
  waitForLoadState: (state: string, opts?: { timeout?: number }) => Promise<void>;
  evaluate: (fn: unknown) => Promise<unknown>;
  isClosed?: () => boolean;
  locator?: (sel: string) => unknown;
}

type SettleModule = {
  settle: (page: unknown) => Promise<void>;
  installSettle: (page: unknown) => void;
  onSettled: (fn: (page: unknown) => unknown) => void;
};

async function loadSettleModule(): Promise<SettleModule> {
  // GLAZE_SETTLE is read at module load, so it has to be set before the import.
  process.env.GLAZE_SETTLE = "1";
  const url = "data:text/javascript;base64," + Buffer.from(settleFixtureSource).toString("base64");
  return (await import(url)) as SettleModule;
}

function resolvedPage(overrides: Partial<FakePage> = {}): FakePage {
  return {
    waitForLoadState: async () => undefined,
    evaluate: async () => undefined,
    isClosed: () => false,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const mod = await loadSettleModule();

  // 5a. The waits actually asked for, with the bounds actually declared.
  {
    const calls: { state: string; timeout?: number }[] = [];
    await mod.settle(
      resolvedPage({
        waitForLoadState: async (state, opts) => {
          calls.push({ state, timeout: opts?.timeout });
        },
      }),
    );
    assert(
      calls.length === 2 && calls[0].state === "load" && calls[1].state === "networkidle",
      "settle: waits for load, then network idle, in that order",
    );
    assert(
      calls[0].timeout === SETTLE_LOAD_TIMEOUT_MS && calls[1].timeout === SETTLE_IDLE_TIMEOUT_MS,
      "settle: every wait is bounded (an unbounded one hangs until the test timeout)",
    );
  }

  // 5b. A page that never loads must not fail the test. This is the case that
  //     turns "crawl makes tests steadier" into "crawl breaks my suite".
  {
    let threw = false;
    try {
      await mod.settle(
        resolvedPage({
          waitForLoadState: async () => {
            throw new Error("Timeout 15000ms exceeded.");
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert(!threw, "settle: a rejected load/idle wait is swallowed, not rethrown");
  }

  // 5c. A page that closes or navigates mid-settle rejects the paint evaluate
  //     ASYNCHRONOUSLY, after settle has already moved on. Nothing catches that
  //     but the fixture's own terminal handler, and Playwright fails a run on
  //     an unhandled rejection.
  {
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      leaked.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let threw = false;
    try {
      await mod.settle(
        resolvedPage({
          evaluate: () =>
            new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error("Execution context was destroyed")), 5);
            }),
        }),
      );
    } catch {
      threw = true;
    }
    // Give the abandoned rejection a turn to surface if nothing caught it.
    await new Promise((r) => setTimeout(r, 60));
    process.off("unhandledRejection", onUnhandled);
    assert(!threw, "settle: a rejecting paint wait is swallowed");
    assert(
      leaked.length === 0,
      "settle: an abandoned paint wait leaks no unhandled rejection (it would fail the run)",
    );
  }

  // 5d. A closed page is not something to wait on.
  {
    let called = false;
    await mod.settle(
      resolvedPage({
        isClosed: () => true,
        waitForLoadState: async () => {
          called = true;
        },
      }),
    );
    assert(!called, "settle: a closed page short-circuits instead of waiting on it");
  }

  // 5e. The extension seam page indexing will hang off.
  {
    const order: string[] = [];
    mod.onSettled(() => {
      order.push("callback");
    });
    mod.onSettled(() => {
      throw new Error("an indexer blew up");
    });
    let threw = false;
    try {
      await mod.settle(
        resolvedPage({
          waitForLoadState: async () => {
            order.push("wait");
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert(
      order.join(",").startsWith("wait,wait,callback"),
      "onSettled: callbacks run AFTER the waits (the point is a stable DOM)",
    );
    assert(!threw, "onSettled: a throwing callback cannot fail the test");
  }

  // 5f. The patch: control returns to the spec only once the page has settled.
  {
    const order: string[] = [];
    const page = resolvedPage({
      waitForLoadState: async () => {
        order.push("settle");
      },
      locator: () => ({}),
    });
    const target = page as FakePage & { goto: (u: string) => Promise<string> };
    target.goto = async () => {
      order.push("action");
      return "done";
    };
    mod.installSettle(page);
    const result = await target.goto("https://example.test");
    assert(result === "done", "installSettle: the wrapped action still returns its own value");
    assert(
      order[0] === "action" && order.includes("settle"),
      "installSettle: the action runs first, then settling, before control returns",
    );
  }

  // 5g. The paint wait is the one wait this fixture bounds ITSELF — Playwright
  //     enforces the two load-state timeouts, but `page.evaluate` takes no
  //     timeout option at all. A page whose rAF never fires (a background tab,
  //     a paused animation frame) would otherwise hang every single step until
  //     the test timeout killed the run.
  {
    const started = Date.now();
    await mod.settle(
      resolvedPage({
        evaluate: () => new Promise(() => undefined),
      }),
    );
    const elapsed = Date.now() - started;
    // The upper bound is the real assertion: the wait terminates instead of
    // hanging. The lower bound only rules out "resolved immediately", and gets a
    // tolerance because timer resolution can land a few ms under the nominal
    // timeout — it failed once at 1998ms against a 2000ms timeout.
    assert(
      elapsed >= SETTLE_PAINT_TIMEOUT_MS - 50 && elapsed < SETTLE_PAINT_TIMEOUT_MS + 2000,
      `settle: a paint wait that never resolves is bounded (took ${elapsed}ms)`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll crawl-speed checks passed.");
}

void main();
