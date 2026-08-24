// The settings nav: the pane list and the search field, drawn INTO THE APP'S
// OWN RAIL.
//
// Search is the highest-value part of the settings redesign. At ~30 settings
// the actual daily problem is "where is the headless toggle", and no amount of
// grouping answers that as directly as typing "headless" — which is why it
// filters BOTH the pane list here and the rows inside the selected pane, rather
// than just jumping to a pane and leaving the user to scan it again.
//
// The accessory on each row does double duty by design: a search shows the
// number of MATCHES in that pane; with no search it shows how many of that
// pane's settings differ from their default. Both answer "is what I'm looking
// for in here", which is the only question a settings sidebar is asked.
//
// REDESIGN §B4 ASKED FOR THIS AND SHIPPED HALF OF IT. Its line was "the rail
// becomes the settings nav while in settings (the panes *are* the navigation),
// and the library list hides. Same surface, two jobs" — and the caveat it
// shipped under was that Settings was its own `BrowserWindow`, so there was no
// library list to hide and no single element to repurpose. What B4 could buy
// was recognition, so this file was built from `Rail`/`RailGroup`/`RailRow`,
// the components the main window's library uses.
//
// It is now literally the sentence. These rows render in the main window's own
// rail (`library-sidebar.tsx`), the library list is what they replace, and this
// file no longer draws a `Rail` of its own — the app has exactly one, and
// putting a second inside it would nest two `SplitView` sidebars.
//
// TWO BEHAVIOURS TO KNOW ABOUT, both inherited from `RailRow` and both
// improvements over what preceded them:
//   • Rows activate on CLICK. `SidebarListItem` fired on `mouseDown` (the
//     AppKit idiom, and a documented trap in this repo — `fireEvent.click`
//     does nothing to it and the assertion reports "0 calls").
//   • Selection is announced via `RailRow`'s own `aria-current`, which says
//     `"true"` rather than `"page"`: the rail says the same thing about the
//     library, and consistency inside one surface beats a distinction a screen
//     reader user cannot act on.

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

import { RailGroup, RailRow } from "../theme";
import type { PaneDef, PaneId } from "../lib/settings-schema";
import { modifiedKeys, paneSegments } from "../lib/settings-schema";
import type { RecorderSettings } from "../lib/recorder-types";

export const PANE_ICONS: Record<PaneId, ComponentType<{ className?: string }>> = {
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

export interface SettingsSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
}

/** The search field, for the rail's pinned `search` slot.
 *
 *  PINNED, NOT THE FIRST ROW OF THE LIST — that is the slot's whole purpose
 *  (see `rail.tsx`). A search box that scrolls away with the list it filters is
 *  reachable only while the list is short. */
export function SettingsSearchField({ value, onChange }: SettingsSearchFieldProps) {
  return (
    <Input
      className="gl-input w-full"
      type="search"
      aria-label="Search settings"
      placeholder="Search settings"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export interface SettingsNavProps {
  /** The pane on screen, or undefined on the board — where no row is current,
   *  because the board is not one of them. */
  selected?: PaneId;
  onSelect: (pane: PaneId) => void;
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
    <>
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
    </>
  );
}
