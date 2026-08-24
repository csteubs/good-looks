// The settings nav, wired to the router.
//
// `settings-nav.tsx` is presentational — rows and a field. This is the part
// that knows what a route is, and it is deliberately the ONLY part: the rail
// belongs to `library-sidebar.tsx`, which renders on every screen and must not
// grow a second opinion about what a pane is.
//
// Two exports because the rail has two slots for them. `Rail` pins the search
// field above its scrolling body (see `rail.tsx`), so the field and the list
// cannot be one component without putting the field back inside the scroller it
// filters.

import { useNavigate, useParams } from "@tanstack/react-router";

import { useSettingsControllerOptional } from "./settings-controller";
import { useSettingsSearch } from "./settings-scope";
import { SettingsNav, SettingsSearchField } from "./settings-nav";
import { paneById } from "../lib/settings-schema";
import type { PaneId } from "../lib/settings-schema";

/** The pane on screen, or undefined on the board. Checked against the registry
 *  rather than believed, exactly as the view checks it: a param is a string out
 *  of history, and a rail row drawn as current for a pane that does not exist
 *  would be the sidebar disagreeing with the screen. */
function usePane(): PaneId | undefined {
  const { pane } = useParams({ strict: false }) as { pane?: string };
  if (pane === undefined) return undefined;
  return paneById(decodeURIComponent(pane))?.id;
}

export function SettingsRailSearch() {
  const navigate = useNavigate();
  const { query, setQuery } = useSettingsSearch();
  const pane = usePane();

  return (
    <SettingsSearchField
      value={query}
      onChange={(value) => {
        // A search that empties the pane you are standing on moves you to one
        // with hits — otherwise the rail advertises matches while the content
        // shows nothing, which reads as broken search rather than as a narrowed
        // list. `replace` because the move is a consequence of typing, not a
        // place the user went: Back must still return to wherever they entered
        // Settings from, not walk back through a query letter by letter.
        const move = setQuery(value, pane);
        if (move) navigate({ to: "/settings/$pane", params: { pane: move }, replace: true });
      }}
    />
  );
}

export function SettingsRailRows() {
  const navigate = useNavigate();
  // Non-throwing, and for the same frame the screens guard against: the rail
  // decides to render these rows from its OWN reading of the pathname, and
  // `RootShell` mounts the scope from its own. They agree in the end and can
  // disagree for a commit. See `useSettingsControllerOptional`.
  const controller = useSettingsControllerOptional();
  const { matchCounts } = useSettingsSearch();
  const pane = usePane();

  if (!controller) return null;
  const { settings, loaded } = controller;

  return (
    <SettingsNav
      selected={pane}
      onSelect={(next) => navigate({ to: "/settings/$pane", params: { pane: next } })}
      matchCounts={matchCounts}
      settings={settings}
      loaded={loaded}
    />
  );
}
