// Routines that run themselves. docs/ROUTINES.md capability 2.
//
// ── THE GUARANTEE, AND WHY IT IS THE WEAK ONE ───────────────────────────────
//
// This app is not always running, so an in-process timer cannot promise an
// unattended nightly run. ROUTINES.md weighs the three options and picks the
// honest one: **catch up on launch, plus a timer while the app is open** — and
// says the weaker guarantee must be STATED in the UI rather than implied,
// because promising unattended runs and delivering them only when the app
// happens to be open is worse than not offering the feature. `SCHEDULE_CAVEAT`
// is that sentence, and it lives in `shared/routine-schedule.mjs` so the
// editor, the launch prompt and the docs cannot spell it three ways.
//
// `launchd` is the real answer for unattended runs and is explicitly v2: it
// means writing a plist into the user's LaunchAgents, keeping it in sync with
// every edit, and removing it on delete and on uninstall — a whole lifecycle
// that leaves state behind when it goes wrong.
//
// ── TWO HALVES THAT MUST NOT OVERLAP ────────────────────────────────────────
//
// The TIMER fires occurrences that arrive while the app is open. The CATCH-UP
// reports occurrences missed while it was closed, and only reports them — the
// renderer offers, the user decides. The split is enforced by `firesNow`'s
// session bound, not by bookkeeping here: without it the catch-up offers a
// missed run, the user declines, and sixty seconds later the timer runs it.
//
// ── WHAT A SCHEDULED RUN MUST NOT DO ────────────────────────────────────────
//
// Never open a headed browser (`forceHeadless`, applied in `routineRunPlan`),
// and never start a second occurrence of a Routine that is still going. The
// batch runner already refuses to start a second batch and answers
// `alreadyRunning`; this records the skip rather than swallowing it, because a
// schedule that quietly did nothing is indistinguishable from one that is
// broken.

import { logger } from "@shell/backend";

import { batchRunner } from "./batch-runner.js";
import { routineStore } from "./routine-store.js";
import { testStore } from "./test-store.js";
import { clampBatchConcurrency } from "../recorder/types.js";
import { routineBlockedReason, routineRunPlan } from "../../shared/routine-plan.mjs";
import { firesNow, missedRoutines } from "../../shared/routine-schedule.mjs";

import type { Routine } from "../recorder/types.js";

/**
 * How often the timer looks. A minute, because the finest thing a schedule can
 * express is a minute — checking faster would only find the same answer sooner,
 * and checking slower would make an "09:30" job run at 09:34 and look wrong to
 * the person who set it.
 */
export const TICK_MS = 60_000;

/** Set once `start()` runs. Everything the timer decides is relative to it —
 *  see the header's two-halves note. */
let sessionStartedAt: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Injected so the tick can be driven without a clock or a browser. The real
 *  implementations talk to the store, the library and the batch runner. */
export interface SchedulerDeps {
  listRoutines: () => Routine[];
  knownTestIds: () => string[];
  saveRoutine: (routine: Routine) => void;
  startBatch: typeof batchRunner.start;
  now: () => number;
}

const realDeps: SchedulerDeps = {
  listRoutines: () => routineStore.list(),
  knownTestIds: () => testStore.list().map((t) => t.id),
  saveRoutine: (routine) => {
    routineStore.save(routine);
  },
  startBatch: (params) => batchRunner.start(params),
  now: () => Date.now(),
};

export interface FireResult {
  routineId: string;
  /** What happened, in the vocabulary the log and any future UI both use. */
  outcome: "started" | "alreadyRunning" | "blocked";
  reason?: string;
}

/**
 * Run one Routine as the SCHEDULE would.
 *
 * Exported because the launch catch-up runs the same way a timer fire does —
 * two paths to "the schedule ran this" would be two chances to forget
 * `forceHeadless`.
 *
 * `lastScheduledRunAt` IS STAMPED FOR EVERY OUTCOME, not just a start. A
 * Routine that could not run because the previous occurrence was still going
 * has still had its occurrence: leaving the stamp alone would make the next
 * tick, sixty seconds later, try again — and again — until the batch finished,
 * turning one skipped run into a retry loop nobody asked for.
 */
export function fireRoutine(routine: Routine, deps: SchedulerDeps = realDeps): FireResult {
  const now = deps.now();
  deps.saveRoutine({ ...routine, lastScheduledRunAt: now });

  const plan = routineRunPlan(routine, deps.knownTestIds(), { forceHeadless: true });
  const blocked = routineBlockedReason(plan);
  if (blocked) {
    logger.info("routines", "Scheduled routine had nothing to run", {
      routine: routine.id,
      reason: blocked,
    });
    return { routineId: routine.id, outcome: "blocked", reason: blocked };
  }

  const started = deps.startBatch({
    testIds: plan.testIds,
    routineId: routine.id,
    captureArtifacts: plan.captureArtifacts,
    // Belt as well as braces: every entry is already headless via the plan, and
    // this is the fallback for a test the runner finds no entry for.
    runHeadless: true,
    perTest: plan.perTest,
    concurrency: clampBatchConcurrency(plan.concurrency, new Set(plan.testIds).size),
  });

  if (started.alreadyRunning) {
    logger.info("routines", "Scheduled routine skipped — something is still running", {
      routine: routine.id,
    });
    return { routineId: routine.id, outcome: "alreadyRunning" };
  }
  logger.info("routines", "Scheduled routine started", {
    routine: routine.id,
    tests: plan.testIds.length,
    skipped: plan.skipped.length,
  });
  return { routineId: routine.id, outcome: "started" };
}

/** One pass of the timer. Exported for the tests, which drive it directly
 *  rather than waiting a minute. */
export function tick(startedAt: number, deps: SchedulerDeps = realDeps): FireResult[] {
  const now = deps.now();
  const fired: FireResult[] = [];
  for (const routine of deps.listRoutines()) {
    if (!firesNow(routine, startedAt, now)) continue;
    fired.push(fireRoutine(routine, deps));
  }
  return fired;
}

export const routineScheduler = {
  /**
   * Begin ticking. Called once the app is ready.
   *
   * Records the session start FIRST: everything the timer decides is relative
   * to it, and a tick that ran before it was set would have no way to tell a
   * missed occurrence from a new one.
   */
  start(deps: SchedulerDeps = realDeps): void {
    if (timer) return;
    sessionStartedAt = deps.now();
    timer = setInterval(() => {
      try {
        if (sessionStartedAt !== null) tick(sessionStartedAt, deps);
      } catch (err) {
        // A scheduler that throws in its own interval stops ticking, silently,
        // for the rest of the session — and the symptom is "my nightly job
        // stopped happening" weeks later. Swallow, log, keep the timer.
        logger.warn("routines", "Scheduler tick failed", { err: String(err) });
      }
    }, TICK_MS);
    // Never hold the process open for a tick. Electron's main process outlives
    // this either way, and an unref'd timer is one less thing keeping a quit
    // from completing.
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    sessionStartedAt = null;
  },

  /**
   * Occurrences missed while the app was closed — for the renderer to OFFER.
   *
   * Deliberately does not run anything. A suite that seizes the machine the
   * moment you launch the app, for a run you may not want right now, is how
   * people turn scheduling off.
   */
  /** Run one now, exactly as the timer would — the launch prompt's "yes". */
  fire(routine: Routine, deps: SchedulerDeps = realDeps): FireResult {
    return fireRoutine(routine, deps);
  },

  missed(deps: SchedulerDeps = realDeps): Routine[] {
    return missedRoutines(deps.listRoutines(), deps.now());
  },

  /**
   * The user declined a missed run.
   *
   * Stamps the occurrence as handled, which is what stops the same prompt
   * appearing on every launch forever. It is not a lie: the occurrence IS
   * settled — somebody looked at it and said no.
   */
  dismissMissed(routineId: string, deps: SchedulerDeps = realDeps): { dismissed: boolean } {
    const routine = deps.listRoutines().find((r) => r.id === routineId);
    if (!routine) return { dismissed: false };
    deps.saveRoutine({ ...routine, lastScheduledRunAt: deps.now() });
    return { dismissed: true };
  },

  /** Test seam: the moment the timer treats as "this session began". */
  __sessionStartedAt(): number | null {
    return sessionStartedAt;
  },
};
