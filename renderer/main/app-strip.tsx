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
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PanelLeft, Settings } from "lucide-react";
import { useSplitView } from "@ui";

import { ChromeButton, TopStrip, type Crumb } from "../theme";
import { api } from "../lib/api";

/** Route path → what that screen is called. The router's own `staticData.title`
 *  is the same string, but reading it here would mean matching on the route
 *  tree's shape from a component that has no other reason to know it. */
const VIEW_LABEL: Record<string, string> = {
  "/stats": "Stats",
  "/visual": "Visual",
  "/batch": "Batch",
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
    const label = VIEW_LABEL[pathname];
    return label === undefined ? [home] : [home, { label }];
  }, [recording, pathname, params.id, testName, home]);

  return (
    <TopStrip
      crumbs={crumbs}
      leading={<RailHandle />}
      // `command` (⌘K, REDESIGN §6.7) and `ticker` (§6.8) are left unpassed.
      // See the note in top-strip.tsx: an affordance for a feature that does
      // not exist teaches a shortcut that answers with silence.
      actions={
        <ChromeButton label="Settings" onClick={openSettingsWindow}>
          <Settings aria-hidden="true" />
        </ChromeButton>
      }
    />
  );
}
