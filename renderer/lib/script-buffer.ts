// Which tests have a script draft open and UNSAVED in this window.
//
// The Script IDE's buffer is view state; the AI-debug store, which can apply
// a fix to a test's script unattended ("Apply AI debug fixes automatically"),
// lives above the router and never sees it. This is the one place the two
// meet: the editor marks a test dirty while its draft differs from what it
// loaded, and the auto-apply path asks before it writes. A fix that lands on
// a dirty test is held for review instead — the user's draft is the newer
// fact, and the stale-draft refusal on `tests:updateScript` would otherwise
// be the first they heard of it.
//
// Module state on purpose: one window, one registry, no provider to thread
// through a store that already has a context of its own.

const dirty = new Set<string>();
const listeners = new Set<() => void>();

export function markScriptDirty(testId: string, isDirty: boolean): void {
  const had = dirty.has(testId);
  if (isDirty) dirty.add(testId);
  else dirty.delete(testId);
  if (had !== isDirty) for (const l of listeners) l();
}

export function isScriptDirty(testId: string): boolean {
  return dirty.has(testId);
}

/** Subscribe to changes; returns the unsubscribe. For tests and for any view
 *  that wants to show an "unsaved" mark somewhere other than the editor. */
export function onScriptDirtyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: forget everything. */
export function resetScriptDirty(): void {
  dirty.clear();
}
