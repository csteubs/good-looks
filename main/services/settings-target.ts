// Which settings screen a menu item asks for.
//
// The application menu is built in the main process (`main/index.ts`): ⌘, opens
// Settings, and six Help items open the Documentation pane on a named topic.
// Both have to reach a screen that now lives in the RENDERER's router, so what
// crosses the boundary is a target — `{ pane, topic }` — pushed over
// `settings:open`.
//
// WHY IT IS VALIDATED AT ALL, given every string here is a literal in our own
// menu template. Because the value on the far end selects a ROUTE: it becomes
// a path segment in `navigate({ to: "/settings/$pane", params })`. This
// function is the syntactic half of the same two-part guard `deep-link.mjs`
// documents — a segment that cannot traverse, cannot be empty, and cannot
// smuggle a second one in — and `paneById` in the renderer is the semantic
// half, which is the one that knows whether "cost" is a pane at all. They are
// two questions, not one rule spelled twice, which is why they are not shared.
//
// It replaced `paneFragment`, which built a URL fragment (`#documentation/setup`)
// for a `loadURL` when Settings was its own BrowserWindow. The validation is
// the same and its test came with it; only the shape of the answer changed,
// because a route param is not a fragment. See docs/plans/settings-view.md §4.

/** One segment: a pane id, or the topic slug under it. Bounded, lowercase,
 *  no separators — so it cannot be a path and cannot be a query. */
const SEGMENT = /^[a-z][a-z0-9-]{0,47}$/;

export interface SettingsTarget {
  /** The pane the screen should open on. */
  pane: string;
  /** The topic within it, for the Documentation pane. */
  topic?: string;
}

/**
 * Read a menu item's `"<pane>"` or `"<pane>/<topic>"` into a target.
 *
 * Returns null for anything that is not one, and the caller then opens Settings
 * where it always opens — the board. A MALFORMED TOPIC DROPS THE TOPIC ONLY,
 * rather than the whole target: the two segments are checked as two segments,
 * so `documentation/../../etc` still lands on Documentation instead of
 * discarding a perfectly good pane id along with the bad topic.
 */
export function settingsTarget(raw: unknown): SettingsTarget | null {
  if (typeof raw !== "string") return null;
  const [pane, topic, ...rest] = raw.split("/");
  if (rest.length > 0) return null;
  if (!SEGMENT.test(pane)) return null;
  if (topic === undefined) return { pane };
  return SEGMENT.test(topic) ? { pane, topic } : { pane };
}
