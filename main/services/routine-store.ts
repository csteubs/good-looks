// Persistence for Routines — saved, named jobs. docs/ROUTINES.md, capability 1.
//
// WHY A STORE AND NOT MORE SETTINGS KEYS. Today's per-row options live in
// `RecorderSettings.batchTestOptions`, a `Record<testId, BatchRowOptions>`. That
// map can express ONE configuration of each test, so "Smoke runs Login on
// Chromium headless" and "Nightly runs Login on all three engines headed" cannot
// coexist. Every other property of Routines follows from being able to have two.
//
// THE FILE IS AN ENVELOPE, NOT A BARE ARRAY, and that is load-bearing for
// exactly one reason: `migratedFromBatchAt`. The migration from the old Batch
// settings runs once. Recording "it ran" separately from "it produced a
// Routine" is what stops it resurrecting a job the user has since deleted —
// with a bare array, an empty file is indistinguishable from a fresh install and
// the deleted Routine comes back on the next launch. It also has to be recorded
// when the migration produced NOTHING, which is the ordinary case.
//
// EVERY WRITE REBUILDS. A Routine arrives over IPC from the renderer's editor,
// and the capture-boundary rule applies here for the same reason it applies to
// steps: spreading the input and overwriting known keys carries every unknown
// key with it, so the next field wired into the runner silently becomes a hole.
// Nothing here is interpolated into generated source, but a `testId` does reach
// the runner, and `browsers` decides what processes get spawned.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import {
  MAX_ROUTINE_MESSAGE,
  MAX_ROUTINE_NAME,
  MAX_ROUTINE_STEPS,
  MAX_ROUTINES,
  RUN_BROWSERS,
} from "../recorder/types.js";
import { FAILURE_POLICIES, routineFromBatchSettings } from "../../shared/routine-migration.mjs";
import { normalizeSchedule } from "../../shared/routine-schedule.mjs";
import { clampWaitMs } from "../../shared/routine-plan.mjs";

import type {
  FailurePolicy,
  Routine,
  RoutineGroupStep,
  RoutineStep,
  RoutineBranchStep,
  RoutineNotifyStep,
  RoutineTestStep,
  RoutineWaitStep,
  RunBrowser,
} from "../recorder/types.js";

/** A Routine with no name is a row in a list that cannot be pointed at. */
const UNTITLED = "Untitled routine";

interface RoutineFile {
  /** Bumped only if the shape changes in a way a reader has to branch on. */
  version: 1;
  /** When the one-time Batch migration ran. See the header — recorded even when
   *  it produced nothing, which is what stops it running again. */
  migratedFromBatchAt?: number;
  routines: Routine[];
}

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "routines.json");
}

function emptyFile(): RoutineFile {
  return { version: 1, routines: [] };
}

function readFile(): RoutineFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(indexFile(), "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyFile();
    const raw = parsed as Record<string, unknown>;
    const list = Array.isArray(raw.routines) ? raw.routines : [];
    return {
      version: 1,
      migratedFromBatchAt:
        typeof raw.migratedFromBatchAt === "number" && Number.isFinite(raw.migratedFromBatchAt)
          ? raw.migratedFromBatchAt
          : undefined,
      // Normalized ON READ as well as on write. A file hand-edited between
      // launches is the same untrusted input an IPC payload is, and a store
      // that only validates its own writes trusts whatever was there first.
      routines: list
        .map((r) => normalizeRoutine(r))
        .filter((r): r is Routine => r !== null)
        .slice(0, MAX_ROUTINES),
    };
  } catch {
    return emptyFile();
  }
}

function writeFile(file: RoutineFile): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify(file, null, 2), "utf-8");
  } catch (err) {
    // A Routine that fails to save must not take down whatever is running.
    // Losing the edit is recoverable; losing the run is not.
    logger.warn("routines", "Failed to write routines", { err: String(err) });
  }
}

function clampName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") return UNTITLED;
  return name.slice(0, MAX_ROUTINE_NAME);
}

function normalizeFailurePolicy(raw: unknown): FailurePolicy {
  return (FAILURE_POLICIES as readonly string[]).includes(raw as string)
    ? (raw as FailurePolicy)
    : "continue";
}

/**
 * Rebuild one step. Returns null for anything that is not a runnable step.
 *
 * `browsers` is filtered THROUGH `RUN_BROWSERS`, which validates, dedupes and
 * normalises order in one pass — the same treatment a Batch row gets, and for
 * the same reason: `["webkit","webkit","nope"]` must not run a test twice on one
 * engine. A step whose engines all fail that is DROPPED rather than defaulted,
 * because at this point the caller is an editor and a silent substitution is a
 * job that does not do what its screen says.
 */
function normalizeTestStep(raw: unknown): RoutineTestStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  if (step.kind !== "test") return null;
  if (typeof step.testId !== "string" || step.testId === "") return null;
  const wanted = Array.isArray(step.browsers) ? (step.browsers as unknown[]) : [];
  const browsers: RunBrowser[] = RUN_BROWSERS.filter((b) => wanted.includes(b));
  if (browsers.length === 0) return null;
  const out: RoutineTestStep = {
    kind: "test",
    testId: step.testId,
    browsers,
    headless: step.headless === true,
    onFailure: normalizeFailurePolicy(step.onFailure),
  };
  if (step.testDeleted === true) out.testDeleted = true;
  return out;
}

/**
 * Rebuild a group and the test steps inside it.
 *
 * `seen` is the WHOLE ROUTINE's set of test ids, threaded through rather than
 * per-group, and that is the load-bearing part. The lane invariant is global —
 * the runner keys a live run by `testId` — so one test in two different groups
 * is the same collision as one test twice at the top level, and a group that
 * deduped only against itself would let it back in.
 *
 * A group that ends up EMPTY is dropped. Not for tidiness: an empty group is a
 * container `skipGroup` can point at and nothing can happen inside, so keeping
 * it would put a step in the editor that cannot ever do anything. The editor
 * creates a group and fills it in one gesture for the same reason.
 *
 * A group nested inside a group is not an error, it is DROPPED — v1 is one
 * level deep (see `RoutineGroupStep`), and `normalizeTestStep` returns null for
 * anything whose `kind` is not "test", so this falls out rather than needing a
 * branch.
 */
/**
 * Rebuild a `wait`.
 *
 * `ms` is CLAMPED rather than the step being dropped, and the ceiling is the
 * point: the runner holds the batch open across a wait, so a stored
 * `86_400_000` — a day, from somebody who meant seconds — is a batch that never
 * finishes and says nothing about why. A wait of zero or less is not a pause,
 * so it is dropped: a step that does nothing is one the editor would draw and
 * the run would ignore.
 */
function normalizeWaitStep(raw: unknown): RoutineWaitStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  if (step.kind !== "wait") return null;
  if (typeof step.id !== "string" || step.id === "") return null;
  const ms = clampWaitMs(step.ms);
  if (ms <= 0) return null;
  return { kind: "wait", id: step.id, ms };
}

/**
 * Rebuild a `notify`.
 *
 * THE MESSAGE IS THE SECURITY-RELEVANT FIELD. With `channel: "webhook"` it goes
 * off the machine through `alert-service`, so it is trimmed, capped and stored
 * as PLAIN TEXT — never interpolated, never templated. See `RoutineNotifyStep`
 * for why that is a decision rather than a gap.
 *
 * An unrecognised channel falls back to `desktop`, which is the LOCAL one. That
 * direction matters: defaulting the other way would turn a typo in a
 * hand-edited file into an unintended send.
 */
function normalizeNotifyStep(raw: unknown): RoutineNotifyStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  if (step.kind !== "notify") return null;
  if (typeof step.id !== "string" || step.id === "") return null;
  const message = (typeof step.message === "string" ? step.message : "")
    .trim()
    .slice(0, MAX_ROUTINE_MESSAGE);
  // A message with nothing in it is a notification that says nothing — the
  // editor would draw it and the recipient would learn nothing from it.
  if (message === "") return null;
  return {
    kind: "notify",
    id: step.id,
    channel: step.channel === "webhook" ? "webhook" : "desktop",
    message,
  };
}

/**
 * Rebuild a `branch`.
 *
 * `seen` is threaded through, so a test cannot appear on both sides — nor on a
 * side and again outside the branch. The lane invariant is global, and a test
 * queued twice is the same collision here as anywhere else; the difference is
 * that with a branch it would ALSO make the two paths overlap, so the run would
 * skip an entry it had already executed.
 *
 * A branch with NOTHING on either side is dropped: it is a choice between two
 * empty paths, which is not a choice. One empty side is fine and meaningful —
 * "if anything failed, run the teardown, otherwise carry on" is exactly that.
 *
 * v1 is ONE LEVEL DEEP, so `normalizeTestStep` returning null for anything that
 * is not a test is what refuses a nested branch, rather than a branch of its own.
 */
function normalizeBranchStep(raw: unknown, seen: Set<string>): RoutineBranchStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  if (step.kind !== "branch") return null;
  if (typeof step.id !== "string" || step.id === "") return null;

  const side = (rawSide: unknown): RoutineTestStep[] => {
    const out: RoutineTestStep[] = [];
    for (const rawChild of Array.isArray(rawSide) ? rawSide : []) {
      if (seen.size >= MAX_ROUTINE_STEPS) break;
      const child = normalizeTestStep(rawChild);
      if (!child || seen.has(child.testId)) continue;
      seen.add(child.testId);
      out.push(child);
    }
    return out;
  };
  const thenSteps = side(step.then);
  const elseSteps = side(step.else);
  if (thenSteps.length === 0 && elseSteps.length === 0) return null;

  return {
    kind: "branch",
    id: step.id,
    // Defaults to `anyFailed`, which is the conservative reading: a Routine
    // whose condition was garbled runs its "something went wrong" path rather
    // than its "all clear" one.
    on: step.on === "allPassed" ? "allPassed" : "anyFailed",
    then: thenSteps,
    else: elseSteps,
  };
}

function normalizeGroupStep(raw: unknown, seen: Set<string>): RoutineGroupStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  if (step.kind !== "group") return null;
  if (typeof step.id !== "string" || step.id === "") return null;

  const steps: RoutineTestStep[] = [];
  for (const rawChild of Array.isArray(step.steps) ? step.steps : []) {
    if (seen.size >= MAX_ROUTINE_STEPS) break;
    const child = normalizeTestStep(rawChild);
    if (!child || seen.has(child.testId)) continue;
    seen.add(child.testId);
    steps.push(child);
  }
  if (steps.length === 0) return null;
  return { kind: "group", id: step.id, label: clampName(step.label), steps };
}

function normalizeConcurrencyField(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

/**
 * Rebuild a whole Routine, or null when there is nothing usable.
 *
 * DUPLICATE TESTS ARE COLLAPSED, not kept. The batch runner keys a live run by
 * `testId` and serialises every entry for one test into a single lane, so two
 * steps naming the same test can never execute concurrently however the editor
 * draws them. Keeping both would mean a saved job that lists four parallel
 * steps and runs three — a diagram that lies. There is nothing a second step
 * for one test can express that its `browsers` array cannot.
 */
function normalizeRoutine(raw: unknown, now?: number): Routine | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id === "") return null;
  const stamp = typeof now === "number" ? now : Date.now();

  const steps: RoutineStep[] = [];
  // ONE SET FOR THE WHOLE ROUTINE, top-level steps and group members alike:
  // the lane invariant is global, so a test in a group and again at the top
  // level is the same collision as the same test listed twice.
  const seen = new Set<string>();
  // Counted over TESTS, not over top-level entries. A group is a container, so
  // capping entries would let one group carry any number of steps past the
  // cap — `seen.size` is the number of runs this Routine can actually queue,
  // which is the thing the cap is about.
  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  for (const rawStep of rawSteps) {
    if (seen.size >= MAX_ROUTINE_STEPS) break;
    const group = normalizeGroupStep(rawStep, seen);
    if (group) {
      steps.push(group);
      continue;
    }
    // Before the test branch, and NOT counted against `seen`: a wait queues no
    // runs, so capping on it would let a Routine of fifty waits crowd out the
    // tests the cap exists to bound. The step cap below is about runs.
    const wait = normalizeWaitStep(rawStep);
    if (wait) {
      steps.push(wait);
      continue;
    }
    // Not counted against `seen` either, and for the same reason: the cap
    // bounds RUNS, and a notify queues none.
    const notify = normalizeNotifyStep(rawStep);
    if (notify) {
      steps.push(notify);
      continue;
    }
    const branch = normalizeBranchStep(rawStep, seen);
    if (branch) {
      steps.push(branch);
      continue;
    }
    const step = normalizeTestStep(rawStep);
    if (!step || seen.has(step.testId)) continue;
    seen.add(step.testId);
    steps.push(step);
  }

  const defaults =
    r.defaults && typeof r.defaults === "object" && !Array.isArray(r.defaults)
      ? (r.defaults as Record<string, unknown>)
      : {};

  const schedule = normalizeSchedule(r.schedule);
  return {
    id: r.id,
    name: clampName(r.name),
    ...(schedule ? { schedule } : {}),
    // Carried through as data the store never invents. It is written by the
    // scheduler when an occurrence fires, and an editor that echoed a stale
    // value back would make the Routine look overdue — or make a missed run
    // look as though it had happened.
    ...(typeof r.lastScheduledRunAt === "number" && Number.isFinite(r.lastScheduledRunAt)
      ? { lastScheduledRunAt: r.lastScheduledRunAt }
      : {}),
    createdAt:
      typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : stamp,
    updatedAt:
      typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : stamp,
    steps,
    defaults: {
      captureArtifacts: defaults.captureArtifacts === true,
      concurrency: normalizeConcurrencyField(defaults.concurrency),
    },
  };
}

export const routineStore = {
  /**
   * Every Routine, OLDEST FIRST.
   *
   * Deliberately not "most recently edited", which is the reflex for a list of
   * documents and wrong for a list of jobs: it means the list reorders itself
   * every time you save, and the row you are working on jumps to the top while
   * you are looking at it. A saved job's position is part of how people find it.
   */
  list(): Routine[] {
    return readFile().routines.sort((a, b) => a.createdAt - b.createdAt);
  },

  get(id: string): Routine | null {
    return readFile().routines.find((r) => r.id === id) ?? null;
  },

  /** Insert or replace by id. Returns what was actually stored — normalized —
   *  rather than what was passed, so the editor renders the job that will run
   *  instead of the one it asked for. */
  save(input: unknown, now: number = Date.now()): Routine | null {
    const routine = normalizeRoutine(input, now);
    if (!routine) return null;
    const file = readFile();
    const existing = file.routines.find((r) => r.id === routine.id);
    // `createdAt` belongs to the record, not the payload: an editor that echoes
    // back a stale or absent value would silently re-date the job and reorder
    // the list under the user.
    const next: Routine = {
      ...routine,
      createdAt: existing ? existing.createdAt : routine.createdAt,
      updatedAt: now,
    };
    // The cap is counted over the OTHERS, which is what keeps a full index
    // editable: saving an existing Routine always leaves at most MAX - 1 here,
    // so only a genuinely new one can be refused. Guarding on `!existing` as
    // well would say the same thing twice, and the second copy is the one that
    // rots — a refactor that changes what `others` means would leave a rule
    // that traps the user with jobs they can no longer fix.
    const others = file.routines.filter((r) => r.id !== routine.id);
    if (others.length >= MAX_ROUTINES) return null;
    writeFile({ ...file, routines: [...others, next] });
    return next;
  },

  remove(id: string): { removed: number } {
    const file = readFile();
    const kept = file.routines.filter((r) => r.id !== id);
    if (kept.length !== file.routines.length) writeFile({ ...file, routines: kept });
    return { removed: file.routines.length - kept.length };
  },

  /**
   * Mark a deleted test's steps broken, everywhere.
   *
   * MARKED, NOT REMOVED. ROUTINES open question 4: a step pointing at a deleted
   * test should render as a broken step the user can take out, not vanish —
   * silently shrinking a saved job is the same class of bug as the batch
   * running fewer tests than it said, and the whole point of a saved job is
   * that it stays what you built.
   */
  markTestDeleted(testId: string): { marked: number } {
    const file = readFile();
    let marked = 0;
    const markOne = (s: RoutineTestStep): RoutineTestStep => {
      if (s.testId !== testId || s.testDeleted) return s;
      marked++;
      return { ...s, testDeleted: true };
    };
    const next = file.routines.map((r) => ({
      ...r,
      // REACHES INSIDE GROUPS. A step is a step wherever it sits, and a broken
      // one the editor cannot show is the silent shrink this whole method
      // exists to prevent — the group would simply run one test fewer than it
      // lists, which is the failure with no symptom.
      steps: r.steps.map((s) => {
        if (s.kind === "group") return { ...s, steps: s.steps.map(markOne) };
        // BOTH sides. A broken step on the path that does not run this time is
        // still one the user has to be able to see and take out — and the path
        // it is on may well be the one that runs next time.
        if (s.kind === "branch") {
          return { ...s, then: s.then.map(markOne), else: s.else.map(markOne) };
        }
        // A `wait` names no test, so there is nothing to mark. Falling through
        // to `markOne` would compare `undefined` to the deleted id — harmless
        // today and wrong the moment a future step kind grows a `testId`.
        return s.kind === "test" ? markOne(s) : s;
      }),
    }));
    if (marked > 0) writeFile({ ...file, routines: next });
    return { marked };
  },

  /**
   * The one-time migration from the old Batch settings.
   *
   * IDEMPOTENT BY A RECORDED FLAG, not by "is the list empty". Those differ the
   * moment a user deletes the migrated Routine: with an emptiness test it comes
   * back on the next launch, forever, and no amount of deleting removes it.
   *
   * The settings keys it reads are deliberately LEFT IN PLACE. ROUTINES says to
   * drop them a release later, not in the same one — a migration that also
   * removes its own source has no way back if it read the map wrongly, and this
   * one reads a map whose central field (`selected`) defaults the opposite way
   * to how it looks.
   */
  ensureMigrated(
    settings: unknown,
    knownTestIds: readonly string[] | null,
    now: number = Date.now(),
  ): { migrated: boolean; routine: Routine | null } {
    const file = readFile();
    if (typeof file.migratedFromBatchAt === "number") return { migrated: false, routine: null };

    const routine = routineFromBatchSettings(
      settings as Parameters<typeof routineFromBatchSettings>[0],
      knownTestIds,
      now,
    );
    const stored = routine ? normalizeRoutine(routine, now) : null;
    writeFile({
      ...file,
      migratedFromBatchAt: now,
      routines: stored ? [...file.routines, stored] : file.routines,
    });
    logger.info("routines", "Migrated the Batch checklist", {
      // Tests, not entries: a group is one step holding many, and this line is
      // a log of what the migration produced.
      steps: stored
        ? stored.steps.reduce((n, st) => n + (st.kind === "group" ? st.steps.length : 1), 0)
        : 0,
    });
    return { migrated: stored !== null, routine: stored };
  },

  /** Test seam: the file this store reads and writes. */
  __file(): string {
    return indexFile();
  },
};
