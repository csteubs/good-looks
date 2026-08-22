// The one sentence both processes agree means "your draft is built on a
// script that is no longer the one on disk". The handler throws it; the
// renderer matches it to offer Reload / Overwrite instead of a generic error.
// Shared rather than spelled twice because the renderer's match is what
// stands between the user and a silent overwrite: if the two drift, a stale
// save reads as an unexplained failure and the Overwrite path is gone.
export const SCRIPT_CHANGED_ON_DISK =
  "The script changed on disk since you opened it. Reload to see the new version, or overwrite it with your draft.";

/** Whether an error raised by tests:updateScript is the stale-draft refusal. */
export function isScriptChangedOnDisk(err) {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.includes(SCRIPT_CHANGED_ON_DISK);
}
