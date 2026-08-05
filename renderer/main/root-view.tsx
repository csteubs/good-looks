import { Outlet } from "@tanstack/react-router";
import * as React from "react";
import { SplitView } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";

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

  React.useEffect(() => {
    return () => {
      window.glazeAPI?.glaze?.ipc?.disconnect();
    };
  }, []);

  return (
    <div className="relative h-full [&:not(:has([data-toolbar]))_.drag-region]:z-50">
      <div className="drag-region fixed left-0 right-0 top-0 h-13" />
      <RecorderProvider>
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
