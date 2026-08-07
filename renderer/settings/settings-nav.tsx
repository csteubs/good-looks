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

import {
  Badge,
  Sidebar,
  SidebarList,
  SidebarListGroup,
  SidebarListItem,
} from "@glaze/core/components";
import {
  Bandage,
  Bell,
  HardDrive,
  Palette,
  Settings2,
  Sparkles,
  Video,
  Wrench,
} from "lucide-react";
import { Fragment } from "react";
import type { ComponentType } from "react";

import type { PaneDef, PaneId } from "../lib/settings-schema";
import { modifiedKeys, paneSegments } from "../lib/settings-schema";
import type { RecorderSettings } from "../lib/recorder-types";

const PANE_ICONS: Record<PaneId, ComponentType<{ className?: string }>> = {
  appearance: Palette,
  recording: Video,
  "test-defaults": Settings2,
  "auto-heal": Bandage,
  storage: HardDrive,
  ai: Sparkles,
  alerts: Bell,
  advanced: Wrench,
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
    // A dot, not a number: "3 changed" invites the question "which three",
    // which the pane itself answers. The badge is only a pointer.
    return count > 0 ? (
      <Badge color="blue" size="small" aria-label={`${count} changed from default`}>
        {count}
      </Badge>
    ) : undefined;
  };

  const renderItem = (pane: PaneDef) => {
    // While searching, a pane with no match is dropped entirely — leaving it
    // greyed would keep the list the same length and hide the fact that search
    // narrowed anything.
    if (searching && !matchCounts[pane.id]) return null;
    const Icon = PANE_ICONS[pane.id];
    const isSelected = selected === pane.id;
    return (
      <SidebarListItem
        key={pane.id}
        icon={<Icon className="size-4" />}
        title={pane.title}
        accessory={accessoryFor(pane.id)}
        selected={isSelected}
        // `selected` only styles the row — the SDK puts no selection state on
        // the element, so a screen reader is told nothing about which pane is
        // showing. These rows navigate between views of one window, which is
        // what aria-current="page" is for.
        aria-current={isSelected ? "page" : undefined}
        onClick={() => onSelect(pane.id)}
      />
    );
  };

  return (
    <Sidebar
      searchable
      searchPlaceholder="Search settings"
      searchValue={search}
      onSearchChange={onSearchChange}
    >
      <SidebarList>
        {paneSegments().map((segment, index) => {
          const rows = segment.panes.map(renderItem).filter(Boolean);
          if (rows.length === 0) return null;
          // An ungrouped segment renders as bare rows, with no header. Keyed by
          // index because two of them share the group value `null`.
          return segment.group === null ? (
            <Fragment key={`ungrouped-${index}`}>{rows}</Fragment>
          ) : (
            <SidebarListGroup key={segment.group} title={segment.group}>
              {rows}
            </SidebarListGroup>
          );
        })}
      </SidebarList>
    </Sidebar>
  );
}
