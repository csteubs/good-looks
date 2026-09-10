import { isSiteHealthCategory } from "../../shared/site-health.mjs";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SplitView } from "@ui";

import { Atmosphere, BootPlate } from "../theme";
import { api } from "../lib/api";
import { isSettingsPath } from "../lib/settings-route";
import { paneById } from "../lib/settings-schema";
import { SettingsScope } from "../settings/settings-scope";
import { AiDebugChip } from "./ai-debug-chip";
import { AppStrip } from "./app-strip";
import { AiDebugHost } from "./ai-debug-panel";
import { AiDebugProvider } from "./ai-debug-store";
import { CommandPalette } from "./command-palette";
import { LibrarySidebar } from "./library-sidebar";
import { LoadFailedDialog } from "./load-failed-dialog";
import { RecorderProvider, useRecorder } from "./recorder-store";
import { RecordingView } from "./recording-view";
import { MissedRunsDialog } from "./missed-runs-dialog";

function RootShell() {
  const { state } = useRecorder();
  // Settings needs its controller and its search query above BOTH the rail and
  // the content, because on that screen the rail lists the panes and the search
  // filters them together with the rows inside one — and the two are the
  // SplitView's `sidebar` and its `children`, so neither can hold what the
  // other reads. Mounted only while a settings route is open, so the fourteen
  // loads it fires cost nothing on any other screen. See settings-scope.tsx.
  //
  // `isSettingsPath` and nothing else decides this, here and in the rail: a
  // rail that swapped to the pane list on a path the scope did not mount for
  // would throw out of `useSettingsController`.
  const onSettings = useRouterState({ select: (s) => isSettingsPath(s.location.pathname) });

  const shell = (
    <SplitView
      // The strip is the `header` slot rather than a sibling, because its rail
      // handle reads the SplitView context — see the note on the prop. It
      // replaces the pinned `SplitView.SidebarToggle` that used to float here:
      // the handle is now in-flow chrome in the strip's leading slot, so no
      // Toolbar has to reserve 44px under a floating button any more, and
      // collapse persistence (storageKey, ⌃⌘S) is untouched.
      header={<AppStrip recording={state.recording} />}
      sidebar={<LibrarySidebar />}
      sidebarSize={{ default: 240, min: 200, max: 320 }}
      storageKey="recorder"
    >
      {state.recording ? <RecordingView /> : <Outlet />}
    </SplitView>
  );

  return onSettings ? <SettingsScope>{shell}</SettingsScope> : shell;
}

/**
 * Re-read persisted settings when something else writes them.
 *
 * WRITTEN FOR TWO WINDOWS AND STILL EARNING ITS KEEP WITH ONE. It existed
 * because react-query's focus refetch is driven by `visibilitychange`, which
 * never fires when focus moves between two BrowserWindows of the same app — a
 * background window's `visibilityState` stays "visible" — so the main window
 * could not see what the settings window had just saved. Settings is a route in
 * this window now, and the channel is still the only thing that keeps the rest
 * of the app current: the settings controller holds its own copy in `useState`
 * and every other view reads `["recorder-settings"]` through react-query, so
 * without this the Cost panel on Stats would go on quoting the CI price you
 * corrected two screens ago. The backend remains the single source; this is
 * what makes both readers ask it again.
 *
 * Its own hook so it can be tested without a router — `RootView` needs one and
 * this does not.
 */
export function useSettingsFreshness(): void {
  const qc = useQueryClient();
  React.useEffect(() => {
    return api.on("settings:changed", () => {
      void qc.invalidateQueries({ queryKey: ["recorder-settings"] });
      // Shopify signatures ride this channel too. They are edited in the same
      // window and read in this one, and the "Signature expired" chip on a test
      // is worse than useless once it is stale — it would keep naming a problem
      // the user has just fixed.
      void qc.invalidateQueries({ queryKey: ["shopify-signatures"] });
    });
  }, [qc]);
}

export function RootView() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    return () => {
      window.glazeAPI?.glaze?.ipc?.disconnect();
    };
  }, []);

  // ── Deep links ──────────────────────────────────────────────────────
  // Here for the same reason `onFinished` is: routing is a main-window
  // behaviour, and the trainer panel runs without a router.
  //
  // A link SELECTS A VIEW and nothing else. The target arrives already
  // validated by `shared/deep-link.mjs`, and it is re-checked here anyway —
  // the push channel is not a trusted one just because the backend usually
  // writes to it, and this is one `if` against a class of bug that opens a
  // route with an undefined param.
  React.useEffect(() => {
    return api.on<{ kind?: unknown; testId?: unknown; runId?: unknown; stepId?: unknown; host?: unknown; category?: unknown }>(
      "deepLink:open",
      (target: { kind?: unknown; testId?: unknown; runId?: unknown; stepId?: unknown; host?: unknown; category?: unknown }) => {
        // A Site Health link lands on the domain's screen; the category is
        // re-checked against the shared vocabulary because it becomes a
        // route param. The route stays registered whatever the setting.
        if (target?.kind === "site-health") {
          const host = typeof target.host === "string" ? target.host : "";
          if (!host) return;
          const category = isSiteHealthCategory(target.category) ? target.category : "seo";
          navigate({ to: "/site-health/$host/$category", params: { host, category } });
          return;
        }
        const testId = typeof target?.testId === "string" ? target.testId : "";
        if (!testId) return;
        // Always the test route: a run or step in the link narrows what the
        // view shows, and the test is the thing that has an address. Landing
        // somewhere is the whole contract.
        navigate({ to: "/test/$id", params: { id: testId } });
      },
    );
  }, [navigate]);

  // ── The application menu's way in ───────────────────────────────────
  // ⌘, and the six Help items live in the MAIN PROCESS, and what they open is
  // now a route rather than a window — so they push a target and this navigates
  // to it. Same shape as the deep link above, including the re-check: the main
  // process has already refused anything that is not a legal segment
  // (`main/services/settings-target.ts`), and `paneById` is the half that knows
  // whether the segment names a pane that exists. A null target — plain ⌘, —
  // opens the board.
  React.useEffect(() => {
    return api.on<{ pane?: unknown; topic?: unknown } | null>(
      "settings:open",
      (target: { pane?: unknown; topic?: unknown } | null) => {
        const pane = typeof target?.pane === "string" ? paneById(target.pane)?.id : undefined;
        if (!pane) {
          navigate({ to: "/settings" });
          return;
        }
        const topic = typeof target?.topic === "string" ? target.topic : undefined;
        if (topic) navigate({ to: "/settings/$pane/$topic", params: { pane, topic } });
        else navigate({ to: "/settings/$pane", params: { pane } });
      },
    );
  }, [navigate]);

  useSettingsFreshness();

  // Landing on the finished test is a MAIN-WINDOW behaviour, so it lives here
  // rather than in the store: the trainer panel runs the same provider with no
  // router and no test list, and would throw on `useNavigate` if the store
  // still owned this.
  const onFinished = React.useCallback(
    (testId: string) => {
      qc.invalidateQueries({ queryKey: ["tests"] });
      qc.invalidateQueries({ queryKey: ["test", testId] });
      qc.invalidateQueries({ queryKey: ["script", testId] });
      navigate({ to: "/test/$id", params: { id: testId } });
    },
    [navigate, qc],
  );

  // Same reasoning as `onFinished`, and the same router. The dialog this serves
  // used to reach Stats by assigning `window.location.hash = "#/stats"`, which
  // could not work: this router runs on MEMORY history, so a URL fragment
  // selects nothing. It went unnoticed because the dialog never opened.
  const onCheckStats = React.useCallback(() => {
    navigate({ to: "/stats" });
  }, [navigate]);

  return (
    // No window-drag overlay across the top edge. There used to be a
    // `drag-region fixed left-0 right-0 top-0 h-13` div here, from the days when
    // the Glaze host window was frameless and the web content owned the title
    // bar. The main window now keeps Electron's DEFAULT native title bar
    // (`main/index.ts` passes no `frame`/`titleBarStyle`), so the OS strip
    // already drags the window and that div dragged nothing.
    //
    // What it did do was cover the top 52px of the app with a transparent
    // `fixed` element. A positioned box paints above in-flow content whatever
    // the DOM order, so every static control in that strip — in practice the
    // sidebar's own header, which is where the "+" (Add test) button lives —
    // was hit-tested to the overlay instead. The click never reached the
    // button and the pointer never saw it, so the cursor didn't change either:
    // the feature looked disabled rather than obstructed.
    //
    // A companion class on this wrapper went with it — an arbitrary-variant
    // z-index lift, keyed off "no data-toolbar present", whose only job was to
    // raise that overlay. It is deliberately NOT spelled out here: Tailwind v4
    // scans raw file text for class candidates and does not skip comments, so
    // writing the utility in prose regenerates the dead rule into the built CSS
    // for a class no element carries. That is not harmless — it cost real time
    // once, because grepping a built bundle for the rule then reports the fix
    // as missing when it is present. `check:clickable-chrome` asserts against
    // RAW source, comments included, for exactly this reason.
    //
    // Drag regions that DO earn their keep stay where they are: `Toolbar`, the
    // `Sidebar` header, and the trainer panel's header (that window is
    // `titleBarStyle: "hiddenInset"` and genuinely has no native strip).
    //
    // Guarded by `check:clickable-chrome`.
    <div className="relative h-full">
      {/* The three global overlay layers (grain, vignette, and — when enabled —
          scanlines), portalled to document.body. Mounted HERE, at last: A2
          shipped the component with nothing consuming it so the app kept its
          old face until the shell landed (REDESIGN §4). Defaults from §0 —
          `calm`, CRT off — with the reduced-motion floor applied inside. The
          CRT and motion SETTINGS land with the settings reskin (§B4); until
          then the defaults are the design's shipped state, not placeholders. */}
      <Atmosphere />
      {/* The boot sequence (§6.9). AFTER `Atmosphere`, because the plate wears
          the same `echo` treatment as the Home wordmark and that treatment is
          keyed on `data-glitch` — which is an attribute Atmosphere sets. It
          covers the app rather than delaying it: everything below is mounted
          and interactive underneath, and any key or click takes the plate
          away. It plays once per window, so navigation never brings it back. */}
      <BootPlate />
      <RecorderProvider onFinished={onFinished}>
        {/* Above the shell, so an AI debug session survives navigation AND the
            trainer replacing the whole outlet. The host renders whichever
            session is expanded; the chip is the way back to a minimized one. */}
        <AiDebugProvider>
          {/* ⌘K (§6.7). Wraps the shell rather than sitting beside it, because
              the strip's key cap reads its opener from this context — and
              because the palette's own dialogs must outlive a navigation the
              palette itself triggered. */}
          <CommandPalette>
            <RootShell />
          </CommandPalette>
          <AiDebugHost />
          <AiDebugChip />
          {/* Outside RootShell on purpose. A failed load tears the session down
              before it announces itself, so `state.recording` is already false
              and RootShell has swapped RecordingView back out for the Outlet —
              anything hosted in there is unmounted exactly when this needs to
              appear. That is the bug this component exists to fix; putting it
              back inside would silently reintroduce it. */}
          <LoadFailedDialog onCheckStats={onCheckStats} />
          {/* Also outside RootShell, and for a related reason: a missed
              scheduled run has to be offerable whatever screen the user landed
              on, including while a recording session has swapped the outlet
              out. See docs/ROUTINES.md capability 2. */}
          <MissedRunsDialog />
        </AiDebugProvider>
      </RecorderProvider>
    </div>
  );
}
