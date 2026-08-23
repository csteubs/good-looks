// The Settings sidebar: pane list, search, and per-pane modified counts.
//
// Search is the highest-value part of the redesign. At ~30 settings the actual
// daily problem is "where is the headless toggle", and no amount of grouping
// answers that as directly as typing "headless" — which is why it filters BOTH
// the pane list here and the rows inside the selected pane, rather than just
// jumping to a pane and leaving the user to scan it again.
//
// The accessory on each row does double duty by design: a search shows the
// number of MATCHES in that pane; with no search it shows how many of that
// pane's settings differ from their default. Both answer "is what I'm looking
// for in here", which is the only question a settings sidebar is asked.
//
// DRAWN AS THE RAIL SINCE B4. The redesign's line is "the rail becomes the
// settings nav while in settings — same surface, two jobs" (REDESIGN §B4).
// Settings is its own WINDOW here, so there is no library list to hide and no
// single element to repurpose; what the sentence actually asks for is that a
// user who opens Settings recognises the strip down the left as the same
// object. So this is `Rail`/`RailGroup`/`RailRow`, the same components the main
// window's library is built from, and the search field goes in the rail's
// pinned `search` slot rather than into the scroller.
//
// TWO BEHAVIOUR CHANGES COME WITH THAT, both improvements and both worth
// knowing about:
//   • Rows activate on CLICK. `SidebarListItem` fired on `mouseDown` (the
//     AppKit idiom, and a documented trap in this repo — `fireEvent.click` does
//     nothing to it and the assertion reports "0 calls").
//   • Selection is announced via `RailRow`'s own `aria-current`, so the
//     explicit `aria-current="page"` this file used to pass by hand is gone.
//     `RailRow` says `"true"` rather than `"page"`: these rows switch panes
//     inside one window, and the rail says the same thing about the library.

import { Input } from "@ui";
import {
  Bandage,
  BarChart3,
  BookOpen,
  Bell,
  Code2,
  Coins,
  EyeOff,
  FlaskConical,
  HardDrive,
  Network,
  Plug,
  Palette,
  Settings2,
  Sparkles,
  Tags,
  Video,
  Wrench,
  SearchCheck,
} from "lucide-react";
import { Fragment } from "react";
import type { ComponentType } from "react";

import { Rail, RailGroup, RailRow } from "../theme";
import type { PaneDef, PaneId } from "../lib/settings-schema";
import { modifiedKeys, paneSegments } from "../lib/settings-schema";
import type { RecorderSettings } from "../lib/recorder-types";

const PANE_ICONS: Record<PaneId, ComponentType<{ className?: string }>> = {
  appearance: Palette,
  editor: Code2,
  inspections: SearchCheck,
  recording: Video,
  "test-defaults": Settings2,
  "auto-heal": Bandage,
  storage: HardDrive,
  stats: BarChart3,
  "failure-reasons": Tags,
  "overlay-rules": EyeOff,
  cost: Coins,
  ai: Sparkles,
  alerts: Bell,
  integrations: Plug,
  proxy: Network,
  documentation: BookOpen,
  diagnostics: Wrench,
  experiments: FlaskConical,
};

export interface SettingsNavProps {
  selected: PaneId;
  onSelect: (pane: PaneId) => void;
  search: string;
  onSearchChange: (value: string) => void;
  /** Matches per pane while a search is running; `null` when none is. */
  matchCounts: Record<string, number> | null;
  settings: Partial<RecorderSettings>;
  /** Suppresses modified counts until the load has settled, so panes don't
   *  flash a count on open. */
  loaded: boolean;
}

export function SettingsNav({
  selected,
  onSelect,
  search,
  onSearchChange,
  matchCounts,
  settings,
  loaded,
}: SettingsNavProps) {
  const searching = matchCounts !== null;

  const accessoryFor = (pane: PaneId) => {
    if (searching) {
      const count = matchCounts[pane];
      return count ? String(count) : undefined;
    }
    if (!loaded) return undefined;
    const count = modifiedKeys(settings, pane).length;
    // A count, not a sentence: "3 changed" invites the question "which three",
    // which the pane itself answers. The chip is only a pointer.
    //
    // NEUTRAL SINCE B4, and that is the palette rule rather than taste. It was
    // `Badge color="blue"`, and blue is not in this design's palette at all —
    // colour means OUTCOME here (pass / running / flaky / fail), so a coloured
    // count beside a pane name would be claiming something about a result. See
    // `--gl-sel-bg` in tokens.css for the same reasoning applied to selection.
    return count > 0 ? (
      <span className="gl-chip" aria-label={`${count} changed from default`}>
        {count}
      </span>
    ) : undefined;
  };

  const renderItem = (pane: PaneDef) => {
    // While searching, a pane with no match is dropped entirely — leaving it
    // greyed would keep the list the same length and hide the fact that search
    // narrowed anything.
    if (searching && !matchCounts[pane.id]) return null;
    const Icon = PANE_ICONS[pane.id];
    return (
      <RailRow
        key={pane.id}
        icon={<Icon className="size-4" />}
        title={pane.title}
        accessory={accessoryFor(pane.id)}
        selected={selected === pane.id}
        onClick={() => onSelect(pane.id)}
      />
    );
  };

  return (
    <Rail
      title="Settings"
      search={
        <Input
          className="gl-input w-full"
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      }
    >
      {paneSegments().map((segment, index) => {
        const rows = segment.panes.map(renderItem).filter(Boolean);
        if (rows.length === 0) return null;
        // An ungrouped segment renders as bare rows, with no header. Keyed by
        // index because two of them share the group value `null`.
        return segment.group === null ? (
          <Fragment key={`ungrouped-${index}`}>{rows}</Fragment>
        ) : (
          <RailGroup key={segment.group} label={segment.group}>
            {rows}
          </RailGroup>
        );
      })}
    </Rail>
  );
}
