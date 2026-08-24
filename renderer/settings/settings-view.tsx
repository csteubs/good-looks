// Settings — two routed screens in the main window.
//
// It was ~30 rows in six UNLABELLED FieldSets down one 1,359-line scroll in a
// 560×480 window, then eighteen panes with search in a window of its own, and
// now those same eighteen panes as views the app navigates to like any other:
//
//   /settings          the board — every section, with what is in it
//   /settings/$pane    one section's rows
//   /settings/$pane/$topic   the Documentation pane, on a topic
//
// See docs/plans/settings-view.md for why it stopped being a `BrowserWindow`,
// and docs/DECISIONS.md for why this shape and not tabs or a longer scroll.
//
// This file is only the two shells. Every control lives in `panes/`, every
// piece of state in `settings-controller.tsx`, the search in
// `settings-scope.tsx`, and the pane/search/default metadata in
// `renderer/lib/settings-schema.ts`.
//
// THREE THINGS THE WINDOW OWNED THAT THE ROUTER OWNS NOW.
//
//   • THE SELECTED PANE. It was `useState`, seeded once from the URL fragment
//     the main process wrote (`settings-window.html#cost`). It is a route
//     param, so it is in the trail, in back and forward, and reachable from the
//     rail — and `$pane` is a string out of history, so it is checked against
//     `paneById` and anything else gets an explained empty state rather than a
//     silent fall back to Appearance.
//   • THE TITLE. The pane's name was drawn into a `Toolbar` inside the content.
//     The top strip's breadcrumb is where this app says which screen you are
//     on, and two answers to one question on one screen is how a heading starts
//     reading as a mistake. The subtitle stays: it says what the section is
//     for, which the crumb does not.
//   • ESCAPE. It closed the window. A view has no close, and the main window's
//     command palette, AI debug panel and every dialog already own Escape —
//     adding a global handler here would be competing for a key to do something
//     Back already does.

import { useNavigate, useParams } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { Button, EmptyState, ScrollArea } from "@ui";

import { Panel } from "../theme";
import type { PaneDef, PaneId } from "../lib/settings-schema";
import {
  modifiedKeys,
  paneById,
  paneSegments,
  resetPatch,
} from "../lib/settings-schema";
import { useSettingsController, useSettingsControllerOptional } from "./settings-controller";
import { useSettingsSearch } from "./settings-scope";
import { PANE_ICONS } from "./settings-nav";
import { RowFilterProvider } from "./setting-row";
import { DiagnosticsPane } from "./panes/diagnostics-pane";
import { DocumentationPane } from "./panes/documentation-pane";
import { AiPane } from "./panes/ai-pane";
import { ExperimentsPane } from "./panes/experiments-pane";
import { AlertsPane } from "./panes/alerts-pane";
import { IntegrationsPane } from "./panes/integrations-pane";
import { ProxyPane } from "./panes/proxy-pane";
import { AppearancePane } from "./panes/appearance-pane";
import { EditorPane } from "./panes/editor-pane";
import { InspectionsPane } from "./panes/inspections-pane";
import { AutoHealPane } from "./panes/auto-heal-pane";
import { RecordingPane } from "./panes/recording-pane";
import { StatsPane } from "./panes/stats-pane";
import { FailureReasonsPane } from "./panes/failure-reasons-pane";
import { OverlayRulesPane } from "./panes/overlay-rules-pane";
import { StoragePane } from "./panes/storage-pane";
import { CostPane } from "./panes/cost-pane";
import { TestDefaultsPane } from "./panes/test-defaults-pane";

/** The Documentation pane, with the address wired to it.
 *
 *  ONE PANE HAS A LEVEL BELOW IT. The Help menu deep-links a topic, and a topic
 *  the reader picks has to be in the trail like anything else they navigate to
 *  — otherwise the crumb keeps naming the topic the menu opened while they read
 *  a different one. The pane itself stays router-free (see its props); this is
 *  the only place that knows `/settings/documentation/$topic` exists.
 *
 *  The slug is passed through unchecked because the PANE checks it: an unknown
 *  one falls to the first topic, which is the right answer for a document
 *  someone linked to a renamed section of. The crumb refuses it separately, so
 *  the trail does not name a section that is not open. */
function RoutedDocumentationPane() {
  const navigate = useNavigate();
  const { topic } = useParams({ strict: false }) as { topic?: string };
  return (
    <DocumentationPane
      topic={topic === undefined ? undefined : decodeURIComponent(topic)}
      onSelectTopic={(slug) =>
        navigate({ to: "/settings/$pane/$topic", params: { pane: "documentation", topic: slug } })
      }
    />
  );
}

const PANE_COMPONENTS: Record<PaneId, ComponentType> = {
  appearance: AppearancePane,
  editor: EditorPane,
  inspections: InspectionsPane,
  recording: RecordingPane,
  "test-defaults": TestDefaultsPane,
  "auto-heal": AutoHealPane,
  storage: StoragePane,
  stats: StatsPane,
  "failure-reasons": FailureReasonsPane,
  "overlay-rules": OverlayRulesPane,
  cost: CostPane,
  ai: AiPane,
  alerts: AlertsPane,
  integrations: IntegrationsPane,
  proxy: ProxyPane,
  documentation: RoutedDocumentationPane,
  diagnostics: DiagnosticsPane,
  experiments: ExperimentsPane,
};

/** What a search that matched nothing says. Shared by both screens so they
 *  cannot describe the same dead end two different ways. */
function NoMatches({ query }: { query: string }) {
  return (
    // No `media`: native macOS empty states omit it, and this one appears
    // mid-typing — an icon appearing and vanishing as the query narrows is a
    // flicker.
    <EmptyState
      title={`No settings match “${query}”`}
      description="Try a shorter word, or the name of what it affects — “headers”, “slack”, “webkit”."
    />
  );
}

// ── The board — `/settings` ───────────────────────────────────────────

/** One section, as a card.
 *
 *  IT CARRIES THE SUBTITLE, and that is the whole reason the board exists
 *  beside a rail that lists the same eighteen names. `PaneDef.subtitle` is one
 *  line saying what is inside a section — "How long captured screenshots stay
 *  on disk", "What happens when a step's locator stops matching" — and a 190px
 *  rail row has never had room for it. The rail is how you move between
 *  sections once you know them; this is how you find out what they are. */
function SectionCard({
  pane,
  count,
  onOpen,
}: {
  pane: PaneDef;
  /** Matches while searching, else how many of its settings differ from their
   *  default. Undefined when there is nothing to say. */
  count: number | undefined;
  onOpen: () => void;
}) {
  const Icon = PANE_ICONS[pane.id];
  return (
    <button type="button" className="gl-settings-card" onClick={onOpen}>
      <span className="gl-settings-card-icon" aria-hidden="true">
        <Icon className="size-4" />
      </span>
      <span className="gl-settings-card-text">
        <span className="gl-settings-card-title">{pane.title}</span>
        <span className="gl-settings-card-sub">{pane.subtitle}</span>
      </span>
      {count ? <span className="gl-chip">{count}</span> : null}
    </button>
  );
}

export function SettingsView() {
  const navigate = useNavigate();
  // The NON-THROWING read. This screen and `RootShell`'s decision to mount the
  // scope are two subscriptions to one router store, and on the way out of
  // Settings the scope can go a commit before the outlet does — see
  // `useSettingsControllerOptional`. Nothing, rather than a screen drawn from
  // defaults: this one is leaving.
  const controller = useSettingsControllerOptional();
  const { query, matchCounts } = useSettingsSearch();

  const open = (pane: PaneId) => navigate({ to: "/settings/$pane", params: { pane } });

  const searching = matchCounts !== null;
  const noResults = searching && Object.keys(matchCounts).length === 0;

  if (!controller) return null;
  const { settings, loaded } = controller;

  return (
    <div className="gl-settings">
      <ScrollArea className="min-h-0 flex-1">
        {noResults ? (
          <NoMatches query={query.trim()} />
        ) : (
          <div className="gl-settings-board">
            {paneSegments().map((segment, index) => {
              const panes = segment.panes.filter(
                (p) => !searching || Boolean(matchCounts[p.id]),
              );
              if (panes.length === 0) return null;
              return (
                <Panel
                  // An ungrouped segment gets no heading, exactly as it gets no
                  // `RailGroup` label in the rail. Keyed by index because two
                  // of them share the group value `null`.
                  key={segment.group ?? `ungrouped-${index}`}
                  title={segment.group ?? undefined}
                  pad
                >
                  <div className="gl-settings-cards">
                    {panes.map((pane) => (
                      <SectionCard
                        key={pane.id}
                        pane={pane}
                        count={
                          searching
                            ? matchCounts[pane.id]
                            : loaded
                              ? modifiedKeys(settings, pane.id).length
                              : undefined
                        }
                        onOpen={() => open(pane.id)}
                      />
                    ))}
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ── One section — `/settings/$pane` ───────────────────────────────────

/** "N settings differ from the default", with a way back.
 *
 *  Only ever writes keys the pane owns AND that have a known default, so a
 *  reset cannot reach the API key or the webhook URL — both live in
 *  safeStorage, and this screen could not restore one it deleted. */
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

export function SettingsPaneView() {
  const { pane: raw } = useParams({ strict: false }) as { pane?: string };
  // Same non-throwing read as the board, for the same frame — see
  // `useSettingsControllerOptional`.
  const controller = useSettingsControllerOptional();
  const { query, matchedIds, matchCounts } = useSettingsSearch();

  // A ROUTE PARAM IS NOT TRUSTED. It arrives as a string out of history — from
  // a deep link, from the app menu's `settings:open` push, or from a hand-typed
  // preview URL — so it is looked up rather than believed. An unknown one is
  // explained, not silently redirected to Appearance: landing somewhere
  // plausible is how a broken link gets reported as "the app ignored it".
  //
  // Decoded first, because a param arrives percent-encoded.
  const pane = raw === undefined ? undefined : paneById(decodeURIComponent(raw));

  if (!controller) return null;

  if (!pane) {
    return (
      <div className="gl-settings">
        <EmptyState
          title="No such settings section"
          description="Pick one from the list on the left."
        />
      </div>
    );
  }

  const Pane = PANE_COMPONENTS[pane.id];
  const searching = matchCounts !== null;
  // Nothing matched anywhere. The scope leaves the caller where they are in
  // that case (there is nowhere to move to), so this screen is what says so.
  const noResults = searching && Object.keys(matchCounts).length === 0;

  return (
    <div className="gl-settings">
      <ScrollArea className="min-h-0 flex-1">
        {noResults ? (
          <NoMatches query={query.trim()} />
        ) : (
          <div className="gl-settings-pane">
            <p className="text-secondary text-sm">{pane.subtitle}</p>
            <RowFilterProvider matchedIds={matchedIds}>
              <Pane />
            </RowFilterProvider>
            {searching ? null : <ResetFooter pane={pane.id} />}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
