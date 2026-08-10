// Entry point for the docked trainer panel window.
//
// Convention (SDK build/html-generator): renderer/<name>/index.tsx generates
// <name>-window.html, so this directory produces `trainer-window.html`.
//
// Deliberately NO RouterProvider. The panel is one view of one live session —
// it has nowhere to navigate — and `RecorderProvider` was changed to take an
// `onFinished` callback precisely so it can mount here: a router hook is not
// optional at runtime just because the value would go unused.

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "@ui";
import { initLogging } from "../lib/logging";
import { startTypeface } from "../lib/typeface";

import { RecorderProvider } from "../main/recorder-store";
import { TrainerPanelView } from "./trainer-panel-view";
import "../styles.css";

initLogging();
// Each window is its own document, so each one applies the typeface itself.
startTypeface();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* No `onFinished`: saving the test is the main window's business —
            it navigates to the finished test. This window is closed by the
            backend as the session tears down. */}
        <RecorderProvider>
          <TrainerPanelView />
        </RecorderProvider>
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
