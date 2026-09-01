// A record of every locator Auto-Heal has changed, and how to undo it.
//
// Why this exists: `tryHeal` auto-applied its top candidate whenever the re-run
// succeeded, and left no trace. That is more dangerous than it sounds — a
// mis-heal usually SUCCEEDS. Clicking the wrong button rarely throws; it just
// does something else, and the step is marked passed. So the failure mode was a
// test that quietly stopped testing what it was written to test, with nothing
// in the UI to notice it by.
//
// The journal turns that into a reviewable event: what changed, when, on which
// step, proposed by which run, and — because the original locator is stored —
// one click to put it back. Storage follows annotation-store.ts: a flat JSON
// index under userData, separate from the test record because a heal is
// history, and tests.json is current state.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { app, logger } from "@shell/backend";

import {
  normalizeHealPageUrl,
  normalizeHealRect,
  normalizeLocator,
  type HealCandidate,
  type HealEvidenceRect,
  type Locator,
} from "../recorder/types.js";

/** What happened to a proposed heal. "pending" means it has been applied to the
 *  running test but not yet confirmed by the user (or, under "suggest" mode,
 *  proposed and not applied at all — `applied` distinguishes the two). */
export type HealStatus = "pending" | "accepted" | "reverted";

export interface HealEntry {
  id: string;
  testId: string;
  stepId: string;
  /** 0-based index at the time of the heal, for display only — steps move. */
  stepIndex: number;
  /** human-readable step label at heal time, so the entry stays legible after
   *  the step is edited or deleted */
  stepLabel: string;
  /** where the heal came from: the trainer's replay, or a real Playwright run */
  source: "trainer" | "run";
  /** the RunRecord id, when source === "run" */
  runId?: string;
  /** what the step's locator was before the heal — the undo */
  originalLocator?: Locator;
  /** the locator that was proposed (and applied, if `applied`) */
  appliedLocator: Locator;
  /** the ranked alternatives, so the review UI can offer a different pick */
  candidates: HealCandidate[];
  /** whether the step's stored locator was actually changed. False under
   *  "suggest" mode: the run used the candidate in-memory to get past the step,
   *  but the test on disk is untouched. */
  applied: boolean;
  /** the page URL when the heal fired (sensitive query values elided), when
   *  the source could read one. Recorded so a heal can be grouped by the page
   *  it actually happened on rather than by the test's start URL, which
   *  mid-test navigation makes a lie. Absent on entries predating 2026-09-01.
   *  Always written through `normalizeHealPageUrl` — the value originates on
   *  an untrusted page. */
  pageUrl?: string;
  /** the healed element's viewport-normalized (0-1) box at heal time, clipped
   *  to the viewport — where an evidence screenshot's highlight is drawn.
   *  Run-source heals only, best-effort, through `normalizeHealRect`. */
  rect?: HealEvidenceRect;
  /** true when this heal happened on ANOTHER machine and was carried back by
   *  `good-looks ingest` — a CI runner's heal, promoted into this journal by
   *  the machine that owns it. Absent on heals that happened here. It is what
   *  lets a surface say where a heal came from rather than inferring it from a
   *  runId whose run may or may not have been ingested too. */
  ingested?: true;
  status: HealStatus;
  at: number;
}

/** Cap the journal so a test that heals on every run can't grow without bound.
 *  Generous: the point is a backstop, not a retention policy. */
const MAX_ENTRIES_PER_TEST = 200;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "heal-journal.json");
}

/**
 * One stored entry, REBUILT from named keys — never trusted as it lies on
 * disk.
 *
 * This file used to be read with a bare `as HealEntry[]`, which was
 * defensible while the app was its only writer. It stopped being defensible
 * when `good-looks ingest` began carrying heals back from CI runners
 * (`shared/heal-ingest.mjs`): an entry's `appliedLocator` is one accepted
 * click away from being generated source Playwright executes in Node, so the
 * journal is now on the capture boundary's path and gets the capture
 * boundary's rule. Guarding only the writer is not enough on its own —
 * entries written before any guard are already on disk, and a user can edit
 * this file by hand.
 *
 * An entry that cannot be narrowed is DROPPED rather than repaired, the
 * overlay-rule-store rule: a half-repaired heal is one nobody ever reviewed,
 * and the alternative — keeping it with a locator this build cannot read —
 * is an undo button that writes something unknown into a test.
 */
function normalizeEntry(input: unknown): HealEntry | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const e = input as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.testId !== "string" || typeof e.stepId !== "string") return null;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
  const appliedLocator = normalizeLocator(e.appliedLocator);
  if (!appliedLocator) return null;
  const source = e.source === "trainer" || e.source === "run" ? e.source : null;
  if (!source) return null;
  const status: HealStatus =
    e.status === "accepted" || e.status === "reverted" ? e.status : "pending";
  const originalLocator = normalizeLocator(e.originalLocator);
  // Candidates are the review UI's "use this one instead" menu, so each one is
  // a locator that can be written into a test: same narrowing, and a candidate
  // that fails it is dropped from the menu rather than taking the entry with
  // it — the entry's own claim does not depend on them.
  const candidates: HealCandidate[] = Array.isArray(e.candidates)
    ? (e.candidates
        .map((c) => {
          if (!c || typeof c !== "object") return null;
          const cand = c as Record<string, unknown>;
          const locator = normalizeLocator(cand.locator);
          if (!locator) return null;
          return {
            locator,
            description: typeof cand.description === "string" ? cand.description : "",
            score: typeof cand.score === "number" && Number.isFinite(cand.score) ? cand.score : 0,
            matchedPastRun: cand.matchedPastRun === true,
          };
        })
        .filter(Boolean) as HealCandidate[])
    : [];
  const pageUrl = normalizeHealPageUrl(e.pageUrl);
  const rect = normalizeHealRect(e.rect);
  return {
    id: e.id,
    testId: e.testId,
    stepId: e.stepId,
    stepIndex:
      typeof e.stepIndex === "number" && Number.isInteger(e.stepIndex) && e.stepIndex >= 0
        ? e.stepIndex
        : 0,
    stepLabel: typeof e.stepLabel === "string" ? e.stepLabel.slice(0, 500) : "",
    source,
    ...(typeof e.runId === "string" ? { runId: e.runId } : {}),
    ...(originalLocator ? { originalLocator } : {}),
    appliedLocator,
    candidates,
    applied: e.applied === true,
    ...(pageUrl ? { pageUrl } : {}),
    ...(rect ? { rect } : {}),
    ...(e.ingested === true ? { ingested: true as const } : {}),
    status,
    at: e.at,
  };
}

function readAll(): HealEntry[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeEntry).filter((e): e is HealEntry => e !== null);
  } catch {
    return [];
  }
}

function writeAll(entries: HealEntry[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(entries, null, 2), "utf-8");
}

export const healJournalStore = {
  /** Every heal across every test, newest first.
   *
   *  Separate from `list` because the Heals VIEW is cross-test: a locator that
   *  keeps needing to be healed is often the same element in several tests, and
   *  a per-test list can't show that. */
  listAll(): HealEntry[] {
    return readAll().sort((a, b) => b.at - a.at);
  },

  /** Every heal for one test, newest first. */
  list(testId: string): HealEntry[] {
    return readAll()
      .filter((e) => e.testId === testId)
      .sort((a, b) => b.at - a.at);
  },

  /** Heals still awaiting a decision, newest first. This is what the review
   *  panel badges — an accepted or reverted heal is settled history. */
  pending(testId: string): HealEntry[] {
    return this.list(testId).filter((e) => e.status === "pending");
  },

  get(id: string): HealEntry | null {
    return readAll().find((e) => e.id === id) ?? null;
  },

  /** Record a heal. Returns the stored entry (with its generated id). */
  record(entry: Omit<HealEntry, "id" | "at" | "status"> & Partial<Pick<HealEntry, "at">>): HealEntry {
    const stored: HealEntry = {
      ...entry,
      id: randomUUID(),
      at: entry.at ?? Date.now(),
      status: "pending",
    };
    const all = readAll();
    all.push(stored);
    // Prune this test's oldest SETTLED entries first. Dropping a pending one
    // would remove the user's only way to revert a change already made to their
    // test — the entry is the undo record, not just a log line.
    const forTest = all.filter((e) => e.testId === stored.testId);
    if (forTest.length > MAX_ENTRIES_PER_TEST) {
      const excess = forTest.length - MAX_ENTRIES_PER_TEST;
      const droppable = forTest
        .filter((e) => e.status !== "pending")
        .sort((a, b) => a.at - b.at)
        .slice(0, excess);
      const dropIds = new Set(droppable.map((e) => e.id));
      writeAll(all.filter((e) => !dropIds.has(e.id)));
    } else {
      writeAll(all);
    }
    logger.info("heal", "Recorded a heal", {
      testId: stored.testId,
      stepId: stored.stepId,
      source: stored.source,
      applied: stored.applied,
    });
    return stored;
  },

  /** Mark an entry settled. Returns the updated entry, or null if it's gone. */
  setStatus(id: string, status: HealStatus): HealEntry | null {
    const all = readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], status };
    writeAll(all);
    return all[idx];
  },

  /** Drop every entry for a deleted test. */
  deleteTest(testId: string): void {
    const all = readAll();
    const kept = all.filter((e) => e.testId !== testId);
    if (kept.length !== all.length) writeAll(kept);
  },

  /** Forget settled entries for a test, keeping anything still pending. */
  clearSettled(testId: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((e) => e.testId !== testId || e.status === "pending");
    const removed = all.length - kept.length;
    if (removed > 0) writeAll(kept);
    return { removed };
  },

  /** Forget settled entries across EVERY test, keeping anything still pending.
   *
   *  The cross-test sibling of `clearSettled`, for the Heals view — which lists
   *  every test's heals, so a per-test clear can't empty what it shows. Pending
   *  entries are kept here for the same reason the prune cap keeps them: a
   *  pending entry is the undo for a change already made to a test. */
  clearAllSettled(): { removed: number } {
    const all = readAll();
    const kept = all.filter((e) => e.status === "pending");
    const removed = all.length - kept.length;
    if (removed > 0) writeAll(kept);
    return { removed };
  },

  /** Delete one entry outright. Returns how many were removed (0 if the id is
   *  unknown), so a double-click reports honestly rather than throwing.
   *
   *  Unlike the prune cap, this WILL drop a pending entry — the cap protects
   *  the user from losing an undo they never saw, but an explicit delete is the
   *  user saying they don't want the record. The UI is what has to make the
   *  consequence plain before asking. */
  remove(id: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((e) => e.id !== id);
    const removed = all.length - kept.length;
    if (removed > 0) writeAll(kept);
    return { removed };
  },
};
