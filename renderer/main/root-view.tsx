import { Outlet, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SplitView } from "@ui";

import { Atmosphere, BootPlate } from "../theme";
import { api } from "../lib/api";
import { AiDebugChip } from "./ai-debug-chip";
import { AppStrip } from "./app-strip";
import { AiDebugHost } from "./ai-debug-panel";
import { AiDebugProvider } from "./ai-debug-store";
import { CommandPalette } from "./command-palette";
import { LibrarySidebar } from "./library-sidebar";
import { LoadFailedDialog } from "./load-failed-dialog";
import { RecorderProvider, useRecorder } from "./recorder-store";
import { RecordingView } from "./recording-view";

function RootShell() {
  const { state } = useRecorder();
  return (
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
    return api.on<{ testId?: unknown; runId?: unknown; stepId?: unknown }>(
      "deepLink:open",
      (target: { testId?: unknown; runId?: unknown; stepId?: unknown }) => {
        const testId = typeof target?.testId === "string" ? target.testId : "";
        if (!testId) return;
        // Always the test route: a run or step in the link narrows what the
        // view shows, and the test is the thing that has an address. Landing
        // somewhere is the whole contract.
        navigate({ to: "/test/$id", params: { id: testId } });
      },
    );
  }, [navigate]);

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
        </AiDebugProvider>
      </RecorderProvider>
    </div>
  );
}
