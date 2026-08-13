// The main window's top strip, wired to the router.  docs/REDESIGN.md §4 (A4).
//
// `TopStrip` is presentational and lives in the theme layer; this is the part
// that knows what a route is. Two things happen here and nothing else does:
// the location becomes a breadcrumb, and the rail's handle gets its behaviour.
//
// THE BREADCRUMB NAMES WHAT IS ON SCREEN, NOT WHAT THE URL SAYS. Those differ
// in exactly one place and it is the one that matters: while a recording is
// running, `RootShell` swaps the whole outlet for `RecordingView` without
// navigating, so the route still reads `/test/x` — or `/stats` — under a screen
// that is showing neither. A breadcrumb derived purely from the router would
// confidently name the wrong screen, which is worse than naming none.
//
// THE HOME CRUMB IS ALSO THE ONLY WAY BACK TO HOME, and that is not an
// accident of design. The rail lists tests and views; it has never had a Home
// row, so before this strip the home screen was reachable only by removing the
// selected test from the sidebar. The trail's root is a real navigation, not
// decoration.

import * as React from "react";
import { useNavigate, useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, PanelLeft, Settings } from "lucide-react";
import { useSplitView } from "@ui";

import { ChromeButton, TopStrip, type Crumb } from "../theme";
import { JobTicker } from "./job-ticker";
import { api } from "../lib/api";
import { categoryMeta, facetLabel } from "../lib/stats-categories";
import { useCommandPalette } from "./command-palette";

/** Route path → what that screen is called. The router's own `staticData.title`
 *  is the same string, but reading it here would mean matching on the route
 *  tree's shape from a component that has no other reason to know it. */
const VIEW_LABEL: Record<string, string> = {
  "/stats": "Stats",
  "/visual": "Visual",
  // The WORD changes, the route does not. ROUTINES.md's rename table: the UI
  // is where "Routine" is worth having; `batch:*` channels, batch-history.json
  // and `RunRecord.batchId` stay, because renaming them costs a migration and
  // an MCP break to buy a word.
  "/batch": "Routines",
  "/heals": "Heals",
  "/branches": "Branches",
};

function openSettingsWindow(): void {
  (window as unknown as { glazeAPI: { glaze: { ipc: { invoke: (c: string) => Promise<void> } } } })
    .glazeAPI.glaze.ipc.invoke("window:openSettings")
    .catch(() => {});
}

/** The rail handle.
 *
 *  Deliberately NOT `SplitView.SidebarToggle`: that renders an SDK `Button`,
 *  which is rounded by `cva` default and has no "no radius" variant to ask for
 *  — the exact reason the redesign is a rewrite of the chrome rather than a
 *  restyle (REDESIGN §1). The behaviour it owns is all in the context, so this
 *  reads it directly and draws the redesign's own control. */
function RailHandle(): React.ReactElement {
  const { sidebarCollapsed, toggleSidebar } = useSplitView();
  return (
    <ChromeButton
      // The label states what pressing it DOES, and so it changes with the
      // state. "Toggle sidebar" is what the old one said, and it is the one
      // thing a screen-reader user cannot work out for themselves.
      label={sidebarCollapsed ? "Show library" : "Hide library"}
      aria-pressed={!sidebarCollapsed}
      onClick={toggleSidebar}
    >
      <PanelLeft aria-hidden="true" />
    </ChromeButton>
  );
}

/**
 * Back and forward, over the router's own history.
 *
 * THE APP HAD NEITHER UNTIL THE STATS DRILL NEEDED THEM, and the reason is
 * worth writing down because it is not obvious: the router runs on
 * `createMemoryHistory()`, so there is no browser history behind it and the
 * window's own navigation gestures move nothing. Every screen was one level
 * deep, the rail selected among them, and "back" never meant anything — so it
 * genuinely was not missing. A drill-down is the first thing in the app with
 * somewhere to go back TO.
 *
 * BACK IS NOT THE BREADCRUMB. The trail goes UP — to the parent of what is on
 * screen — and back returns to where you came FROM. They coincide while you are
 * descending and stop coinciding the moment you leave: drill to a stability
 * verdict, open the failing test, and "up" is Home while "back" is the verdict
 * you were reading. That case is exactly why the plan chose real routes.
 *
 * FORWARD IS OFFERED BECAUSE IT CAN BE ANSWERED HONESTLY. `canGoBack()` is part
 * of the history API and there is no `canGoForward()`, which nearly made this a
 * back-only control — a permanently enabled forward button that sometimes does
 * nothing is the "affordance that answers with silence" `top-strip.tsx` argues
 * against. But memory history stamps `__TSR_index` into each entry's state, so
 * "is there anything ahead of me" is `index < length - 1` and the button can be
 * disabled truthfully.
 */
function HistoryNav(): React.ReactElement {
  const router = useRouter();
  // Subscribing to the location is what re-renders this when history moves;
  // reading `router.history` alone would leave both buttons frozen in whatever
  // state they had at mount.
  const index = useRouterState({
    select: (s) => (s.location.state as { __TSR_index?: number })?.__TSR_index ?? 0,
  });
  const canBack = router.history.canGoBack();
  const canForward = index < router.history.length - 1;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      // Never steal a keystroke from a field. The log search and every inline
      // editor in the app are plain inputs, and `[` is a character.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      if (e.key === "[") {
        e.preventDefault();
        if (router.history.canGoBack()) router.history.back();
      } else if (e.key === "]") {
        e.preventDefault();
        router.history.forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <>
      <ChromeButton
        label="Back"
        disabled={!canBack}
        onClick={() => router.history.back()}
      >
        <ChevronLeft aria-hidden="true" />
      </ChromeButton>
      <ChromeButton
        label="Forward"
        disabled={!canForward}
        onClick={() => router.history.forward()}
      >
        <ChevronRight aria-hidden="true" />
      </ChromeButton>
    </>
  );
}

/** The ⌘K cap. A BUTTON as well as a hint, because the shortcut is
 *  undiscoverable on its own and a key cap nobody can press is a label
 *  pretending to be a control.
 *
 *  Renders nothing when there is no palette above it. That is not defensive
 *  coding — the settings window and the trainer panel draw their own chrome and
 *  have no command list, and a cap there would be exactly the promise the app
 *  cannot keep that this slot was left empty to avoid. */
function CommandKey(): React.ReactElement | null {
  const setOpen = useCommandPalette();
  if (!setOpen) return null;
  return (
    <button
      type="button"
      className="gl-cmd-key"
      onClick={() => setOpen(true)}
      // Spelled out for a screen reader, which reads "⌘" as nothing useful.
      aria-label="Run a command (Command K)"
      title="Run a command  ⌘K"
    >
      ⌘K
    </button>
  );
}

export interface AppStripProps {
  /** True while the trainer has replaced the outlet — see the header. */
  recording?: boolean;
}

export function AppStrip({ recording = false }: AppStripProps): React.ReactElement {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };

  // Shares the ["tests"] cache the rail already loads, so naming the open test
  // costs nothing. `select` narrows it to the one name, so a change to any
  // OTHER test's record does not re-render the strip.
  const testName = useQuery({
    queryKey: ["tests"],
    queryFn: api.tests.list,
    select: (tests) => tests.find((t) => t.id === params.id)?.name,
    enabled: params.id !== undefined,
  }).data;

  const home = React.useMemo<Crumb>(
    () => ({ label: "Home", onClick: () => navigate({ to: "/" }) }),
    [navigate],
  );

  const crumbs = React.useMemo<Crumb[]>(() => {
    if (recording) return [home, { label: "Recording" }];
    if (pathname === "/") return [{ label: "Home" }];
    if (params.id !== undefined) {
      // The name may not have loaded yet, and a crumb that flashes the test's
      // id would be a different sentence than the one it settles on. "Test" is
      // what it is until the name arrives.
      return [home, { label: testName ?? "Test" }];
    }

    // Stats drills. THIS IS WHY THE BOARD IS ROUTED RATHER THAN HELD IN STATE —
    // the trail is the app's existing "where you are" surface, and every level
    // above the current one is a real navigation back to it.
    //
    // The category is looked up in the registry rather than title-cased from
    // the param: a URL can say `/stats/nonsense`, and a breadcrumb that
    // confidently rendered "Nonsense" would be naming a screen that does not
    // exist. An unknown one gets no crumb of its own, and the view below says
    // what happened.
    const stats = /^\/stats\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
    if (stats) {
      const toStats: Crumb = { label: "Stats", onClick: () => navigate({ to: "/stats" }) };
      const meta = categoryMeta(stats[1]);
      if (!meta) return [home, toStats];
      const facet = stats[2];
      if (facet === undefined) return [home, toStats, { label: meta.label }];
      return [
        home,
        toStats,
        {
          label: meta.label,
          onClick: () =>
            navigate({ to: "/stats/$category", params: { category: meta.id } }),
        },
        // Named the way the app names it, not the way the route spells it —
        // "Broke recently", never "changed-since". Decoded first, because a
        // param arrives percent-encoded.
        { label: facetLabel(meta.id, decodeURIComponent(facet)) },
      ];
    }

    const label = VIEW_LABEL[pathname];
    return label === undefined ? [home] : [home, { label }];
  }, [recording, pathname, params.id, testName, home, navigate]);

  return (
    <TopStrip
      crumbs={crumbs}
      leading={
        <>
          <RailHandle />
          <HistoryNav />
        </>
      }
      // Both slots are filled as of §6.8 — the debt `top-strip.tsx` describes
      // is discharged. `JobTicker` renders NOTHING when the app is idle, which
      // keeps the promise the empty slot was making: a strip that says
      // something only when there is something to say.
      command={<CommandKey />}
      ticker={<JobTicker />}
      actions={
        <ChromeButton label="Settings" onClick={openSettingsWindow}>
          <Settings aria-hidden="true" />
        </ChromeButton>
      }
    />
  );
}
