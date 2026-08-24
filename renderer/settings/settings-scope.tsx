// What the rail and the settings screen both need, mounted above both of them.
//
// Settings is two sibling surfaces now: the rail lists the panes (and owns the
// search field), and the routed view renders the pane. They are the SplitView's
// `sidebar` and its `children`, so neither can hold state the other reads —
// which is why this wraps the whole shell in `RootShell` while a settings route
// is open, and nothing at all when one is not.
//
// TWO THINGS LIVE HERE, for two different reasons.
//
//   • THE CONTROLLER. `SettingsProvider` fires the fourteen loads that used to
//     fire when the settings WINDOW opened — the settings themselves, the LLM
//     config and its auto-probe, the connection statuses, artifact usage, run
//     totals. Mounting it here rather than at `RootView` keeps that cost where
//     it was: on entering Settings, not on starting the app. The rail needs it
//     too, for the per-pane "differs from default" counts, which is the reason
//     it cannot live inside the route component.
//
//   • THE SEARCH. One query filters BOTH the rail's pane list and the rows
//     inside the pane, which is the whole design of the settings search (see
//     `settings-nav.tsx`) and is only possible if the two surfaces read one
//     value. Deliberately NOT a route search param: a filter someone types and
//     clears is not a place, and making it addressable means either a history
//     entry per keystroke or `replace: true` on every one of them.
//
// The scope also owns the one behaviour that spans both surfaces: a search that
// empties the pane you are standing on MOVES you to a pane that has matches.
// Without it the rail advertises hits while the content shows nothing, which
// reads as broken search rather than as a narrowed list. It is answered here,
// synchronously, from the query the user just typed — not from an effect that
// notices afterwards, which would flash the empty pane first.

import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { PaneId } from "../lib/settings-schema";
import { matchCountByPane, searchSettings } from "../lib/settings-schema";
import { SettingsProvider } from "./settings-controller";

export interface SettingsSearchValue {
  /** What is in the field, verbatim. */
  query: string;
  /** Row ids the query matched, or null when no search is running. Feeds
   *  `RowFilterProvider`. */
  matchedIds: readonly string[] | null;
  /** Matches per pane, or null when no search is running. Feeds the rail's
   *  accessories and decides which panes are listed at all. */
  matchCounts: Record<string, number> | null;
  /**
   * Set the query, and say where the caller should navigate.
   *
   * Returns the pane to move to when `current` has been searched empty, or null
   * when the caller should stay put. The navigation itself is the caller's —
   * this module has no router.
   */
  setQuery: (value: string, current?: PaneId) => PaneId | null;
}

const Ctx = createContext<SettingsSearchValue | null>(null);

/** The settings search. Returns a null-shaped value outside the scope rather
 *  than throwing: the rail renders on every screen and asks unconditionally,
 *  and only its settings branch uses the answer. */
export function useSettingsSearch(): SettingsSearchValue {
  return useContext(Ctx) ?? EMPTY;
}

const EMPTY: SettingsSearchValue = {
  query: "",
  matchedIds: null,
  matchCounts: null,
  setQuery: () => null,
};

function SettingsSearchProvider({ children }: { children: ReactNode }) {
  const [query, setQueryState] = useState("");

  const { matchedIds, matchCounts } = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return { matchedIds: null, matchCounts: null };
    const ids = searchSettings(trimmed);
    return { matchedIds: ids, matchCounts: matchCountByPane(ids) };
  }, [query]);

  const value = useMemo<SettingsSearchValue>(
    () => ({
      query,
      matchedIds,
      matchCounts,
      setQuery: (next, current) => {
        setQueryState(next);
        const trimmed = next.trim();
        if (!trimmed || current === undefined) return null;
        // Recomputed for the value just typed rather than read off the memo
        // above, which still describes the previous query — this runs during
        // the event that changes it. `searchSettings` is a pure scan of an
        // in-memory index.
        const counts = matchCountByPane(searchSettings(trimmed));
        if (counts[current]) return null;
        const first = Object.keys(counts)[0] as PaneId | undefined;
        // Nothing matched anywhere: stay, and let the screen say so. Moving to
        // "the first pane with hits" when there are none would be a navigation
        // to nowhere.
        return first ?? null;
      },
    }),
    [query, matchedIds, matchCounts],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Everything a settings route needs, above both the rail and the content. */
export function SettingsScope({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <SettingsSearchProvider>{children}</SettingsSearchProvider>
    </SettingsProvider>
  );
}
