// A switch asked for in one place and started in another.
//
// The hover menu is a SHORTCUT INTO the Branches view, not a second copy of it.
// Switching is a git worktree, an install, a build and a relaunch — minutes of
// output that the Branches view already renders (`steps`, `lines`, the
// `branches:progress` push). Starting a switch from the sidebar would mean
// either duplicating that panel into the rail, or running a multi-minute build
// with nowhere to watch it. So the menu records what was chosen, navigates, and
// the view it lands on picks the request up and runs it through the code that
// was already there.
//
// ── Why it is consumed on read ────────────────────────────────────────
// The dangerous failure is not a dropped request — it is a repeated one. A
// value left in place restarts the build every time the view mounts: navigate
// away and back, and the app rebuilds and relaunches for a click made ten
// minutes ago. Reading clears, so a request can be acted on exactly once. That
// also makes the module correct under React's development double-invocation of
// effects, where the second call gets nothing rather than a second build.
//
// A module-scoped value rather than a context or a router search param: a
// context would need a provider wrapping both the rail and the outlet for a
// value that is set once and read once, and a search param would put a branch
// name — untrusted input, see CLAUDE.md — into a URL for no benefit.

/** `undefined` means nothing was asked for. `null` means the pinned row: go
 *  back to the user's own checkout. A string is a branch to build. */
let pending: string | null | undefined;

export function requestBranchSwitch(branch: string | null): void {
  pending = branch;
}

/** The pending request, if any, clearing it. See the header for why. */
export function takeBranchSwitch(): string | null | undefined {
  const value = pending;
  pending = undefined;
  return value;
}

/** Test hygiene: module state outlives a test, and a request left behind by one
 *  test starts a build in the next. */
export function clearBranchSwitch(): void {
  pending = undefined;
}
