// Dismissing a run's findings banners.
//
// Sibling of visual-baseline-ops / a11y-baseline-ops, and deliberately NOT part
// of either: those two RESOLVE a finding (re-pin the baseline, accept the
// violations) and change what future runs report. This one only says "I've seen
// it" about ONE run, and changes nothing else — which is exactly why the user
// needs both. Accepting a visual change you haven't looked at is destructive;
// having no way to clear the banner means the screen nags forever.
//
// The dismissal lives on the run's replay.json for the same reason the
// acceptances live on disk: a banner that returns the moment you select another
// run has not been dismissed. Pinning it to the run is sound because a finished
// run's findings are frozen — a re-run writes its own replay, with its own
// banners.

import { artifactStore } from "./artifact-store.js";
import type { RunNoticeKind, RunReplay } from "./artifact-store.js";

const KINDS: readonly RunNoticeKind[] = ["visual", "a11y"];

/** Reject anything that isn't one of the two known notices. This crosses IPC,
 *  and an unchecked value would be written into replay.json and read back
 *  forever after. */
export function isRunNoticeKind(value: unknown): value is RunNoticeKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** Mark one of a run's findings banners as dismissed. Returns the patched
 *  replay (or null when the run has no replay), so the caller re-renders from
 *  the same shape every other accept path returns. */
export function dismissRunNotice(
  testId: string,
  runId: string,
  kind: RunNoticeKind,
): RunReplay | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  const already = replay.dismissedNotices ?? [];
  if (already.includes(kind)) return replay;
  replay.dismissedNotices = [...already, kind];
  artifactStore.writeReplay(testId, runId, replay);
  return replay;
}

/** Undo a dismissal, so the banner comes back. */
export function restoreRunNotice(
  testId: string,
  runId: string,
  kind: RunNoticeKind,
): RunReplay | null {
  const replay = artifactStore.readReplay(testId, runId);
  if (!replay) return null;
  const already = replay.dismissedNotices ?? [];
  if (!already.includes(kind)) return replay;
  replay.dismissedNotices = already.filter((k) => k !== kind);
  artifactStore.writeReplay(testId, runId, replay);
  return replay;
}
