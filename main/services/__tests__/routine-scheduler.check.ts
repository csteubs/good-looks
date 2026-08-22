// Standalone regression check for the Routine scheduler. docs/ROUTINES.md
// capability 2.
//
// Drives the REAL service with injected deps — no clock, no browser, no batch
// runner. The schedule ARITHMETIC is unit-tested in `routine-schedule.test.ts`;
// what is only observable here is what the service DOES with the answer, and
// every one of those is a way a scheduler misbehaves silently:
//
//   - a scheduled run is forced HEADLESS, whatever the step says;
//   - `lastScheduledRunAt` is stamped for EVERY outcome, not just a start —
//     otherwise a skipped occurrence retries every sixty seconds until the
//     batch it collided with finishes;
//   - the timer never claims an occurrence the catch-up is offering;
//   - the catch-up REPORTS and does not run;
//   - declining settles the occurrence, so the prompt does not return forever.
//
// This needs the store's `@shell/backend` (via routine-store), so it is a
// bundled check rather than a vitest file. Run with:
//   npm run check:routine-scheduler

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// The scheduler imports the real store transitively; point the stub's
// app.getPath somewhere throwaway before anything loads.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-scheduler-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { fireRoutine, tick, routineScheduler } = await import("../routine-scheduler.js");
type Routine = Parameters<typeof fireRoutine>[0];
type Deps = NonNullable<Parameters<typeof fireRoutine>[1]>;

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** A local timestamp. Month is 0-based, as `Date` has it. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo, d, h, mi).getTime();
}

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "r-nightly",
    name: "Nightly",
    createdAt: 1,
    updatedAt: 1,
    schedule: { kind: "dailyAt", minute: 9 * 60 + 30 },
    steps: [
      // HEADED on purpose: the point of the first assertion is that a schedule
      // overrides it.
      { kind: "test", testId: "t-a", browsers: ["chromium"], headless: false, onFailure: "continue" },
      { kind: "test", testId: "t-b", browsers: ["webkit"], headless: false, onFailure: "continue" },
    ],
    defaults: { captureArtifacts: true, concurrency: 2 },
    ...over,
  } as Routine;
}

interface Harness {
  deps: Deps;
  saved: Routine[];
  started: Parameters<Deps["startBatch"]>[0][];
}

function harness(opts: {
  routines: Routine[];
  now: number;
  alreadyRunning?: boolean;
}): Harness {
  const saved: Routine[] = [];
  const started: Parameters<Deps["startBatch"]>[0][] = [];
  let live = opts.routines;
  return {
    saved,
    started,
    deps: {
      listRoutines: () => live,
      knownTestIds: () => ["t-a", "t-b"],
      saveRoutine: (r: Routine) => {
        saved.push(r);
        live = live.map((x) => (x.id === r.id ? r : x));
      },
      startBatch: (params) => {
        started.push(params);
        return { batchId: "b-1", alreadyRunning: opts.alreadyRunning === true };
      },
      now: () => opts.now,
    } as Deps,
  };
}

// ── A scheduled run never opens a window ─────────────────────────────
{
  const h = harness({ routines: [routine()], now: at(2026, 7, 12, 9, 31) });
  const result = fireRoutine(routine(), h.deps);
  assert(result.outcome === "started", "a due routine starts");
  assert(h.started.length === 1, "and starts exactly one batch");
  assert(
    h.started[0].perTest?.every((e) => e.headless) === true,
    "EVERY step runs headless, overriding the step's own headed setting",
  );
  assert(
    h.started[0].runHeadless === true,
    "and the batch-wide fallback is headless too, for a test the runner finds no entry for",
  );
  assert(
    h.started[0].routineId === "r-nightly",
    "the batch is stamped with the routine, so its history lands under the right job",
  );
  assert(h.started[0].captureArtifacts === true, "the routine's own defaults come across");
  // WITHOUT THIS the run is written to history looking exactly like a person
  // pressing Run — `routineId` says which job, never whether anyone was there,
  // and a Routine has a manual path (`routines:run`) that stamps the same id.
  assert(
    h.started[0].trigger === "schedule",
    "every run it produces is stamped `schedule`, so an overnight failure is not read as someone debugging",
  );
}

// ── The stamp is written for every outcome ───────────────────────────
{
  const h = harness({ routines: [routine()], now: at(2026, 7, 12, 9, 31), alreadyRunning: true });
  const result = fireRoutine(routine(), h.deps);
  assert(result.outcome === "alreadyRunning", "a collision is reported, not swallowed");
  assert(
    h.saved.length === 1 && h.saved[0].lastScheduledRunAt === at(2026, 7, 12, 9, 31),
    "and the occurrence is STILL stamped — otherwise the next tick retries in sixty seconds, and the one after that, until the running batch finishes",
  );
}
{
  const h = harness({ routines: [], now: at(2026, 7, 12, 9, 31) });
  const empty = routine({ steps: [] });
  const result = fireRoutine(empty, h.deps);
  assert(result.outcome === "blocked", "a routine with nothing to run is blocked, with a reason");
  assert(typeof result.reason === "string" && result.reason.length > 0, "and the reason is a sentence");
  assert(h.started.length === 0, "nothing is queued");
  assert(
    h.saved.length === 1 && typeof h.saved[0].lastScheduledRunAt === "number",
    "and it is stamped, so an empty routine does not re-fire every minute",
  );
}

// ── The timer and the catch-up never claim the same occurrence ───────
{
  // Opened at 09:00; 09:30 arrives while running. The timer's.
  const opened = at(2026, 7, 12, 9, 0);
  const h = harness({ routines: [routine()], now: at(2026, 7, 12, 9, 31) });
  const fired = tick(opened, h.deps);
  assert(fired.length === 1 && fired[0].outcome === "started", "the timer fires an occurrence that arrives while the app is open");
}
{
  // Missed yesterday, app opened this afternoon. The catch-up's.
  const missed = routine({ lastScheduledRunAt: at(2026, 7, 11, 9, 30) });
  const opened = at(2026, 7, 12, 14, 0);
  const h = harness({ routines: [missed], now: at(2026, 7, 12, 14, 1) });
  assert(
    tick(opened, h.deps).length === 0,
    "the timer does NOT fire an occurrence missed while the app was closed — without this the catch-up offers it, the user declines, and the timer runs it a minute later",
  );
  assert(h.started.length === 0, "so nothing is queued behind the user's back");
  assert(
    routineScheduler.missed(h.deps).map((r) => r.id).join(",") === "r-nightly",
    "and the catch-up is the half that claims it",
  );
}
{
  const h = harness({ routines: [routine()], now: at(2026, 7, 12, 23, 0) });
  assert(
    routineScheduler.missed(h.deps).length === 0,
    "a schedule that has never fired has missed nothing — otherwise every suite runs the moment its schedule is saved",
  );
}

// ── The catch-up reports; it does not run ────────────────────────────
{
  const missed = routine({ lastScheduledRunAt: at(2026, 7, 11, 9, 30) });
  const h = harness({ routines: [missed], now: at(2026, 7, 12, 14, 1) });
  routineScheduler.missed(h.deps);
  assert(
    h.started.length === 0 && h.saved.length === 0,
    "asking what was missed starts nothing and writes nothing — a suite that seizes the machine on launch is how people turn scheduling off",
  );
}

// ── Accepting a missed occurrence is still the SCHEDULE running it ───
//
// The judgement call in `trigger`, pinned so it is a decision rather than an
// accident. The launch prompt asks the user to let a run that was ALREADY DUE
// happen late; it does not make them the person who chose to run it. Recording
// that as `manual` would file a Routine's overnight failures alongside someone
// debugging at their desk — which is the exact confusion the field exists to
// end. It falls out of `fire` going through the same `fireRoutine`, which is
// also what keeps a scheduled run headless.
{
  const missed = routine({ lastScheduledRunAt: at(2026, 7, 11, 9, 30) });
  const h = harness({ routines: [missed], now: at(2026, 7, 12, 14, 1) });
  routineScheduler.fire(missed, h.deps);
  assert(h.started.length === 1, "accepting a missed occurrence starts it");
  assert(
    h.started[0].trigger === "schedule",
    "…and it is stamped `schedule`, not `manual` — the user consented to a late run, they did not schedule it",
  );
}

// ── Declining settles the occurrence ─────────────────────────────────
{
  const missed = routine({ lastScheduledRunAt: at(2026, 7, 11, 9, 30) });
  const h = harness({ routines: [missed], now: at(2026, 7, 12, 14, 1) });
  assert(routineScheduler.dismissMissed("r-nightly", h.deps).dismissed, "a missed run can be declined");
  assert(h.started.length === 0, "declining runs nothing");
  assert(
    routineScheduler.missed(h.deps).length === 0,
    "and the prompt does not come back — the occurrence IS settled, somebody looked at it and said no",
  );
  assert(
    !routineScheduler.dismissMissed("r-gone", h.deps).dismissed,
    "declining a routine that no longer exists reports that rather than throwing",
  );
}

console.log(
  failures === 0 ? "\nAll routine-scheduler checks passed" : `\n${failures} check(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
