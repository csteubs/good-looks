import { Outlet } from "@tanstack/react-router";
import * as React from "react";
import { SplitView } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";

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
        <RootShell />
      </RecorderProvider>
    </div>
  );
}
