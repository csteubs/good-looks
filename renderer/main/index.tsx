import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router, queryClient } from "./router";
import "../styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider, Toaster } from "@ui";
import { initLogging } from "../lib/logging";

initLogging();

// The main window is deliberately untitled — no `document.title` here. A page
// title becomes the window's title bar, and the app's name is already in the
// menu bar and the Dock. main/index.ts refuses page titles for the same
// reason; both ends are pinned by `check:app-identity`.

// Get the root element
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Create React root and render
const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  </React.StrictMode>,
);

// Hot Module Replacement (HMR) support
if (import.meta.hot) {
  import.meta.hot.accept();
}
