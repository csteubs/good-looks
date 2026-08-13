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
  MAX_ROUTINE_NAME,
  MAX_ROUTINE_STEPS,
  MAX_ROUTINES,
  RUN_BROWSERS,
} from "../recorder/types.js";
import { FAILURE_POLICIES, routineFromBatchSettings } from "../../shared/routine-migration.mjs";
import { normalizeSchedule } from "../../shared/routine-schedule.mjs";

import type { FailurePolicy, Routine, RoutineStep, RunBrowser } from "../recorder/types.js";

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
function normalizeStep(raw: unknown): RoutineStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const step = raw as Record<string, unknown>;
  if (step.kind !== "test") return null;
  if (typeof step.testId !== "string" || step.testId === "") return null;
  const wanted = Array.isArray(step.browsers) ? (step.browsers as unknown[]) : [];
  const browsers: RunBrowser[] = RUN_BROWSERS.filter((b) => wanted.includes(b));
  if (browsers.length === 0) return null;
  const out: RoutineStep = {
    kind: "test",
    testId: step.testId,
    browsers,
    headless: step.headless === true,
    onFailure: normalizeFailurePolicy(step.onFailure),
  };
  if (step.testDeleted === true) out.testDeleted = true;
  return out;
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
  const seen = new Set<string>();
  const rawSteps = Array.isArray(r.steps) ? r.steps : [];
  for (const rawStep of rawSteps) {
    if (steps.length >= MAX_ROUTINE_STEPS) break;
    const step = normalizeStep(rawStep);
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
    const next = file.routines.map((r) => ({
      ...r,
      steps: r.steps.map((s) => {
        if (s.testId !== testId || s.testDeleted) return s;
        marked++;
        return { ...s, testDeleted: true };
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
      steps: stored ? stored.steps.length : 0,
    });
    return { migrated: stored !== null, routine: stored };
  },

  /** Test seam: the file this store reads and writes. */
  __file(): string {
    return indexFile();
  },
};
