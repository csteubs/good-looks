import { Outlet, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SplitView } from "@ui";
import { useTheme } from "@ui";

import { AiDebugChip } from "./ai-debug-chip";
import { AiDebugHost } from "./ai-debug-panel";
import { AiDebugProvider } from "./ai-debug-store";
import { LibrarySidebar } from "./library-sidebar";
import { RecorderProvider, useRecorder } from "./recorder-store";
import { RecordingView } from "./recording-view";

function RootShell() {
  const { state } = useRecorder();
  return (
    <SplitView
      sidebar={<LibrarySidebar />}
      sidebarSize={{ default: 240, min: 200, max: 320 }}
      storageKey="recorder"
    >
      {/* Pinned (the default): the button portals to a fixed anchor on the
          frame's leading edge, so it stays put whether the sidebar is open or
          collapsed. A non-pinned toggle inside Sidebar.actions would disappear
          along with the sidebar, leaving ⌃⌘S as the only way back.
          Collapse state persists via the SplitView storageKey above. */}
      <SplitView.SidebarToggle aria-label="Toggle sidebar" />
      {state.recording ? <RecordingView /> : <Outlet />}
    </SplitView>
  );
}

export function RootView() {
  useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    return () => {
      window.glazeAPI?.glaze?.ipc?.disconnect();
    };
  }, []);

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
    // The `[&:not(:has([data-toolbar]))_.drag-region]:z-50` class that used to
    // be on this wrapper went with it — it existed only to lift that overlay.
    // Drag regions that DO earn their keep stay where they are: `Toolbar`, the
    // `Sidebar` header, and the trainer panel's header (that window is
    // `titleBarStyle: "hiddenInset"` and genuinely has no native strip).
    //
    // Guarded by `check:clickable-chrome`.
    <div className="relative h-full">
      <RecorderProvider onFinished={onFinished}>
        {/* Above the shell, so an AI debug session survives navigation AND the
            trainer replacing the whole outlet. The host renders whichever
            session is expanded; the chip is the way back to a minimized one. */}
        <AiDebugProvider>
          <RootShell />
          <AiDebugHost />
          <AiDebugChip />
        </AiDebugProvider>
      </RecorderProvider>
    </div>
  );
}
