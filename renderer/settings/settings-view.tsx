// The Settings window.
//
// Was ~30 rows in six UNLABELLED FieldSets down one 1,359-line scroll, in a
// 560×480 window — about eight screens, with the only heading in the whole
// window faked as a label-only row. Now a sidebar of eight panes with search.
// See docs/DECISIONS.md for why this shape and not tabs or a longer scroll.
//
// This file is only the shell: navigation, search wiring, and the reset footer.
// Every control lives in `panes/`, every piece of state in
// `settings-controller.tsx`, and the pane/search/default metadata in
// `renderer/lib/settings-schema.ts`.

import { useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  Button,
  EmptyState,
  ScrollArea,
  SplitView,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
} from "@ui";
import type { PaneId } from "../lib/settings-schema";
import {
  DEFAULT_PANE_ID,
  matchCountByPane,
  modifiedKeys,
  paneById,
  resetPatch,
  searchSettings,
} from "../lib/settings-schema";
import { SettingsProvider, useSettingsController } from "./settings-controller";
import { SettingsNav } from "./settings-nav";
import { RowFilterProvider } from "./setting-row";
import { DiagnosticsPane } from "./panes/diagnostics-pane";
import { DocumentationPane } from "./panes/documentation-pane";
import { AiPane } from "./panes/ai-pane";
import { ExperimentsPane } from "./panes/experiments-pane";
import { AlertsPane } from "./panes/alerts-pane";
import { IntegrationsPane } from "./panes/integrations-pane";
import { AppearancePane } from "./panes/appearance-pane";
import { AutoHealPane } from "./panes/auto-heal-pane";
import { RecordingPane } from "./panes/recording-pane";
import { StoragePane } from "./panes/storage-pane";
import { CostPane } from "./panes/cost-pane";
import { TestDefaultsPane } from "./panes/test-defaults-pane";

const PANE_COMPONENTS: Record<PaneId, ComponentType> = {
  appearance: AppearancePane,
  recording: RecordingPane,
  "test-defaults": TestDefaultsPane,
  "auto-heal": AutoHealPane,
  storage: StoragePane,
  cost: CostPane,
  ai: AiPane,
  alerts: AlertsPane,
  integrations: IntegrationsPane,
  documentation: DocumentationPane,
  diagnostics: DiagnosticsPane,
  experiments: ExperimentsPane,
};

/** Close on Escape, unless an interactive element is focused or a popover is
 *  open. Unchanged from before the split — a text field's own Escape (clearing
 *  it) and a Select's (closing it) must win over closing the window. */
function useCloseOnEscape() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;

      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }

      if (document.querySelector("[data-radix-popper-content-wrapper]")) {
        return;
      }

      event.preventDefault();
      window.glazeAPI.glaze.ipc.invoke("window:closeSettings");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

/** "N settings differ from the default", with a way back.
 *
 *  Only ever writes keys the pane owns AND that have a known default, so a
 *  reset cannot reach the API key or the webhook URL — both live in
 *  safeStorage, and this window could not restore one it deleted. */
function ResetFooter({ pane }: { pane: PaneId }) {
  const { settings, loaded, save } = useSettingsController();
  const changed = modifiedKeys(settings, pane);
  if (!loaded || changed.length === 0) return null;

  return (
    <div className="text-secondary flex items-center gap-2 px-1 pt-1 text-sm">
      <span className="bg-blue-9 size-1.5 rounded-full" aria-hidden="true" />
      <span>
        {changed.length} setting{changed.length === 1 ? "" : "s"} differ
        {changed.length === 1 ? "s" : ""} from the default
      </span>
      <Button
        variant="transparent"
        size="small"
        className="ml-auto"
        onClick={() => void save(resetPatch(pane))}
      >
        Reset section
      </Button>
    </div>
  );
}

function SettingsShell() {
  const { settings, loaded } = useSettingsController();
  // The pane this window opened ON. A caller that has a reason to send someone
  // here — Stats → Cost's "Edit in Settings" — passes it as a URL fragment
  // (`settings-window.html#cost`), which the main process validates before it
  // ever reaches a URL. Read ONCE, in a lazy initialiser: after mount this is
  // ordinary state, so clicking another pane is not fighting the address.
  //
  // `paneById` is what makes an unknown fragment harmless — it returns
  // undefined and the window opens where it always did.
  //
  // Only the FIRST segment names a pane. `#documentation/setup` carries a topic
  // for the Documentation pane, which reads the rest itself — this must not
  // hand the whole string to `paneById` and land on Appearance because a topic
  // was appended.
  const [selected, setSelected] = useState<PaneId>(
    () => paneById(window.location.hash.slice(1).split("/")[0])?.id ?? DEFAULT_PANE_ID,
  );
  const [search, setSearch] = useState("");

  useCloseOnEscape();

  const query = search.trim();
  const searching = query.length > 0;
  const matchedIds = useMemo(() => (searching ? searchSettings(query) : null), [searching, query]);
  const matchCounts = useMemo(
    () => (matchedIds ? matchCountByPane(matchedIds) : null),
    [matchedIds],
  );

  // A search that leaves the selected pane with nothing in it moves to the
  // first pane that does have a hit. Staying put would show an empty pane
  // beside a sidebar advertising matches elsewhere, which reads as broken
  // search rather than as a narrowed list.
  const effective: PaneId =
    matchCounts && !matchCounts[selected]
      ? ((Object.keys(matchCounts)[0] as PaneId | undefined) ?? selected)
      : selected;

  const pane = paneById(effective) ?? paneById(DEFAULT_PANE_ID)!;
  const Pane = PANE_COMPONENTS[pane.id];
  const noResults = Boolean(matchCounts) && Object.keys(matchCounts ?? {}).length === 0;

  return (
    <SplitView
      sidebar={
        <SettingsNav
          selected={pane.id}
          onSelect={setSelected}
          search={search}
          onSearchChange={setSearch}
          matchCounts={matchCounts}
          settings={settings}
          loaded={loaded}
        />
      }
      sidebarSize={{ default: 190, min: 170, max: 260 }}
      storageKey="settings"
    >
      <ScrollArea
        toolbar={
          <Toolbar>
            <ToolbarContent>
              <ToolbarTitle>{noResults ? "Settings" : pane.title}</ToolbarTitle>
            </ToolbarContent>
          </Toolbar>
        }
      >
        {noResults ? (
          // No `media`: the SDK's own guidance is that native macOS empty
          // states omit it, and this one appears mid-typing — an icon
          // appearing and vanishing as the query narrows is a flicker.
          <EmptyState
            title={`No settings match “${query}”`}
            description="Try a shorter word, or the name of what it affects — “headers”, “slack”, “webkit”."
          />
        ) : (
          <div className="mb-8 flex flex-col gap-6 px-4">
            <p className="text-secondary text-sm">{pane.subtitle}</p>
            <RowFilterProvider matchedIds={matchedIds}>
              <Pane />
            </RowFilterProvider>
            {searching ? null : <ResetFooter pane={pane.id} />}
          </div>
        )}
      </ScrollArea>
    </SplitView>
  );
}

export function SettingsView() {
  return (
    <SettingsProvider>
      <SettingsShell />
    </SettingsProvider>
  );
}
