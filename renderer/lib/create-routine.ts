// Making a new Routine. docs/ROUTINES.md, REDESIGN §7.1.
//
// ONE DEFINITION, because there are now two places that offer it — the Batch
// view's picker and the rail's `+` — and "make a new job" spelled twice is how
// one of them starts producing Routines the other cannot open: a different id
// scheme, a different starting name, a different set of defaults.
//
// EMPTY, not "a copy of what is on screen". The tick boxes are how a test joins
// a job, and pre-filling would make the first thing a new Routine does be
// something the user has to undo.

import { api } from "./api";
import type { RecorderSettings, Routine } from "./recorder-types";

/** The base name. Numbered from 2 upward when taken, so the first one is just
 *  "New routine" rather than "New routine 1" — a suffix on the only one of
 *  something reads as though there is another. */
const BASE_NAME = "New routine";

export function nextRoutineName(existing: readonly Routine[]): string {
  const taken = new Set(existing.map((r) => r.name));
  let name = BASE_NAME;
  for (let n = 2; taken.has(name); n++) name = `${BASE_NAME} ${n}`;
  return name;
}

/**
 * Create and store one. Returns what the STORE kept, so the caller opens the
 * job that exists rather than the payload it sent.
 *
 * `now` and `suffix` are passed in rather than read, the same rule the rest of
 * this codebase follows for clocks: an id built from a hidden `Date.now()` is
 * one no test can pin, and every call site here already has a natural moment.
 */
export async function createRoutine(
  existing: readonly Routine[],
  settings: Partial<RecorderSettings> | undefined,
  now: number,
  suffix: string,
): Promise<Routine | null> {
  return api.routines.save({
    id: `routine-${now}-${suffix}`,
    name: nextRoutineName(existing),
    createdAt: now,
    updatedAt: now,
    steps: [],
    defaults: {
      // A first Routine's defaults would have come from the globals, so a
      // second one's do too — otherwise a user who set "4 at once" everywhere
      // gets one-at-a-time back every time they make a job.
      captureArtifacts: settings?.defaultCaptureArtifacts ?? false,
      concurrency: settings?.defaultBatchConcurrency ?? 1,
    },
  });
}

/** A suffix that keeps two Routines made in the same millisecond apart. Split
 *  out so a caller can pass a fixed one and get a predictable id. */
export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
