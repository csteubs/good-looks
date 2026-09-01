// Entry point for the browser preview.
//
// Order is the whole point of this file existing separately: the bridge has to
// be on `window` BEFORE the app's own entry module is evaluated, because
// components call `api.*` while mounting. A static import would be hoisted
// above the install call and the first render would race it — so the real
// entry is pulled in with a dynamic import, after.
//
// The production entry (renderer/main/index.tsx) is untouched by any of this.
// Nothing here is reachable from it, and only `preview.html` includes this
// module at all.

import { installPreviewBridge } from "./preview-bridge";

installPreviewBridge();

// Say what this is, on screen, permanently.
//
// A fake backend that looks like a real one is a trap: someone reviews a
// preview, sees a test "run", and reports a bug against behaviour that was
// never wired up. The banner is not decoration — it is the difference between
// a useful preview and a misleading one.
function mountPreviewBanner(): void {
  const banner = document.createElement("div");
  banner.setAttribute("data-preview-banner", "");
  banner.textContent =
    "UI PREVIEW — fixture data, no backend. Recording and test runs do nothing here.";
  Object.assign(banner.style, {
    position: "fixed",
    insetInlineStart: "0",
    insetInlineEnd: "0",
    insetBlockEnd: "0",
    zIndex: "2147483647",
    padding: "6px 12px",
    font: "500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    letterSpacing: "0.04em",
    textAlign: "center",
    color: "#000",
    background: "#f5c518",
    // The app owns the pointer everywhere else; a strip that eats clicks at
    // the bottom of the window would break whatever sits under it.
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(banner);
}

/** Open one view directly, from the query string.
 *
 *  The app's router uses `createMemoryHistory()` — correct for the packaged
 *  app, which loads over file:// where a browser history would put filesystem
 *  paths in the URL. The consequence here is that the address bar can never
 *  select a view: `/stats` loads the app at its initial route, and
 *  `pushState` does nothing the router can see.
 *
 *  That matters, because "open this one screen and look at it" is the whole
 *  job. So the preview asks the router directly instead of fighting it:
 *
 *      /?view=stats            /?view=visual      /?view=batch
 *      /?view=a11y             /?view=heals       /?view=insights
 *      /?view=branches         /?view=settings    /?view=settings&pane=cost
 *      /?test=t-checkout
 *
 *  `branches` is reachable here even though the branch switcher cannot work in
 *  a browser: what it shows is the view's UNAVAILABLE state, which is a real
 *  screen someone has to be able to look at. The sidebar row stays hidden, so
 *  this is the only way to reach it.
 *
 *  Unknown values are ignored rather than throwing — landing on home with a
 *  typo'd parameter is a better failure than a blank page. */
async function openRequestedView(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const testId = params.get("test");
  const pane = params.get("pane");
  if (!view && !testId) return;

  const { router } = await import("../main/router");
  // `?view=settings&pane=cost` — one settings section directly. Settings used
  // to be mounted here INSTEAD of the app, because it was a separate window
  // that `window:openSettings` could not open in a browser tab; it is a route
  // now, so it needs nothing this file does not already do for Stats.
  if (view === "settings" && pane) {
    await router.navigate({ to: "/settings/$pane", params: { pane } });
    return;
  }
  await router.navigate(
    testId
      ? { to: "/test/$id", params: { id: testId } }
      : {
          to: `/${view}` as
            | "/stats"
            | "/visual"
            | "/a11y"
            | "/batch"
            | "/heals"
            | "/insights"
            | "/branches"
            | "/settings",
        },
  );
}

/** The primitive specimen — `/?view=specimen`.
 *
 *  Mounted INSTEAD OF the app, not alongside it. A3 lands fifteen presentational
 *  components that no screen consumes yet, so there is nowhere in the running
 *  app to look at one; booting the whole recorder around them would just put
 *  chrome in the way of the thing being reviewed.
 *
 *  Dynamic import, like everything else here, so the specimen and the theme it
 *  pulls in cost nothing on a normal preview load. */
async function mountSpecimen(): Promise<void> {
  const [React, ReactDOM, { Specimen }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./specimen"),
  ]);
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  ReactDOM.createRoot(root).render(React.createElement(Specimen));
}

/** The docked trainer panel — `/?view=trainer-panel`.
 *
 *  Mounted INSTEAD OF the app, for exactly the reason Settings is: the panel is
 *  its own BrowserWindow, opened by the backend when a recording session starts
 *  (`openTrainerPanel`), so nothing in a browser tab can reach it. Until this
 *  existed, a change to the panel could only be looked at by packaging the app
 *  and recording a real test — which is how it ended up the last surface in the
 *  app still wearing the component library's stock classes.
 *
 *  The providers are copied from `renderer/trainer/index.tsx` rather than
 *  imported: that module is an ENTRY POINT and would run its own `createRoot`
 *  against `#root` and mount a second copy over this one.
 *
 *  The bridge reports a live session for this view (see `recorderPreview`), so
 *  the step list, the insert cursor and the tool row are all real. What is not
 *  real is anything native: the assert and Add-step menus go through
 *  `Menu.popup`, and the dock control invokes `trainerPanel:dock`. */
async function mountTrainerPanel(): Promise<void> {
  const [React, ReactDOM, rq, ui, { RecorderProvider }, { TrainerPanelView }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("@tanstack/react-query"),
    import("@ui"),
    import("../main/recorder-store"),
    import("../trainer/trainer-panel-view"),
    import("../styles.css"),
  ]);
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  // The panel is 360px wide against a real browser. Constraining the preview to
  // that is the whole point — a tool row that wraps at 360 and not at 1400 is
  // precisely the thing this view is opened to check.
  document.body.style.background = "var(--gl-ink)";
  Object.assign(root.style, { width: "360px", height: "100%", borderInlineEnd: "1px solid #222" });
  const client = new rq.QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  ReactDOM.createRoot(root).render(
    React.createElement(
      rq.QueryClientProvider,
      { client },
      React.createElement(
        ui.TooltipProvider,
        null,
        React.createElement(RecorderProvider, null, React.createElement(TrainerPanelView)),
      ),
    ),
  );
}

/** The action-bar mockup lab — `/?view=bar-lab`.
 *
 *  Mounted INSTEAD OF the app, same argument as the specimen: the lab shows
 *  three CANDIDATE bars that exist nowhere in the running app, side by side at
 *  main-pane width and at the docked panel's 360px, so a direction can be
 *  picked before any production view changes. No store and no bridge — every
 *  control flips local state, and the banner says so. */
async function mountBarLab(): Promise<void> {
  const [React, ReactDOM, { BarLab }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./bar-mockups"),
    import("../styles.css"),
  ]);
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  document.body.style.background = "var(--gl-ink)";
  ReactDOM.createRoot(root).render(React.createElement(BarLab));
}

/** The training browser's URL strip — `/?view=chrome`.
 *
 *  Same argument again, one level further out: this renders into a
 *  WebContentsView docked above the untrusted page INSIDE the recorder window,
 *  so it is not even a window someone could open. It takes one string and a
 *  boolean, which is why this mounts `UrlBar` directly with fixture values
 *  rather than the strip's own IPC-subscribing wrapper — there is no navigation
 *  to subscribe to here.
 *
 *  Boxed to `--gl-strip-h` because the strip's height is set by the recorder
 *  service, not by its own content, and a bar that only looks right at its
 *  natural height is a bar that will be wrong in the app. */
async function mountRecorderChrome(): Promise<void> {
  const [React, ReactDOM, ui, { UrlBar }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("@ui"),
    import("../recorder-chrome/url-bar"),
    import("../styles.css"),
  ]);
  const root = document.getElementById("root");
  if (!root) throw new Error("Root element not found");
  document.body.style.background = "var(--gl-ink)";
  Object.assign(root.style, { height: "var(--gl-strip-h)" });
  ReactDOM.createRoot(root).render(
    React.createElement(
      ui.TooltipProvider,
      null,
      React.createElement(UrlBar, {
        url: "https://www.firefox.com/en-US/browsers/",
        loading: false,
      }),
    ),
  );
}

async function boot(): Promise<void> {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "specimen") {
    await mountSpecimen();
    mountPreviewBanner();
    return;
  }
  if (view === "trainer-panel") {
    await mountTrainerPanel();
    mountPreviewBanner();
    return;
  }
  if (view === "chrome") {
    await mountRecorderChrome();
    mountPreviewBanner();
    return;
  }
  if (view === "bar-lab") {
    await mountBarLab();
    mountPreviewBanner();
    return;
  }
  await import("../main/index");
  mountPreviewBanner();
  await openRequestedView();
}

void boot();
