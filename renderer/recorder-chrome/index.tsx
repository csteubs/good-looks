// Entry point for the training browser's chrome strip.
//
// Produces `recorder-chrome.html`, the fourth renderer entry. It renders into a
// WebContentsView pinned to the top of the recorder window, with the untrusted
// page in a second view below it (main/services/recorder-service.ts).
//
// Deliberately NOT `RecorderProvider`. The store subscribes to the whole
// session — steps, console, replay, heals — and this strip needs one string.
// Mounting it here would put a third live copy of the step list in the app for
// no benefit, and every push it ignores is work done inside the window whose
// responsiveness the user is judging the *page* by.

import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@ui";

import { initLogging } from "../lib/logging";
import { startTypeface } from "../lib/typeface";
import { UrlBar } from "./url-bar";
import "../styles.css";

initLogging();
// Each window is its own document, so each one applies the typeface itself.
startTypeface();

/** The one push this window listens for. Sent by the recorder service on every
 *  committed navigation, in-page history change, and load-state transition. */
interface TrainingUrlEvent {
  url: string;
  loading: boolean;
}

function ipc(): {
  on: (channel: string, cb: (event: unknown, payload: unknown) => void) => () => void;
  invoke: <T>(channel: string) => Promise<T>;
} {
  return (
    window as unknown as {
      glazeAPI: {
        glaze: {
          ipc: {
            on: (channel: string, cb: (event: unknown, payload: unknown) => void) => () => void;
            invoke: <T>(channel: string) => Promise<T>;
          };
        };
      };
    }
  ).glazeAPI.glaze.ipc;
}

function ChromeStrip(): React.JSX.Element {
  const [state, setState] = React.useState<TrainingUrlEvent>({ url: "", loading: true });

  React.useEffect(() => {
    // Subscribe BEFORE asking for the current value. The other order has a gap:
    // a navigation that commits between the reply being sent and the listener
    // being attached is lost, and the strip then shows a stale URL until the
    // next navigation happens to repair it.
    const off = ipc().on("recorder:trainingUrl", (_event, payload) => {
      const next = payload as Partial<TrainingUrlEvent> | undefined;
      if (!next || typeof next.url !== "string") return;
      setState({ url: next.url, loading: next.loading === true });
    });
    void ipc()
      .invoke<TrainingUrlEvent>("recorder:getTrainingUrl")
      .then((current) => {
        if (current && typeof current.url === "string") setState(current);
      })
      .catch(() => {
        // The session can tear down while this is in flight. The strip is about
        // to be destroyed with it; showing "Loading…" for that moment is right.
      });
    return off;
  }, []);

  return <UrlBar url={state.url} loading={state.loading} />;
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <TooltipProvider>
      <ChromeStrip />
    </TooltipProvider>
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.accept();
}
