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

import { app, logger } from "@glaze/core/backend";

import type { HealCandidate, Locator } from "../recorder/types.js";

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

function readAll(): HealEntry[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HealEntry[]) : [];
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
};
