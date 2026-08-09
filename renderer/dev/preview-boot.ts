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
 *      /?view=heals            /?test=t-checkout
 *
 *  Unknown values are ignored rather than throwing — landing on home with a
 *  typo'd parameter is a better failure than a blank page. */
async function openRequestedView(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  const testId = params.get("test");
  if (!view && !testId) return;

  const { router } = await import("../main/router");
  await router.navigate(
    testId
      ? { to: "/test/$id", params: { id: testId } }
      : { to: `/${view}` as "/stats" | "/visual" | "/batch" | "/heals" },
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

async function boot(): Promise<void> {
  if (new URLSearchParams(window.location.search).get("view") === "specimen") {
    await mountSpecimen();
    mountPreviewBanner();
    return;
  }
  await import("../main/index");
  mountPreviewBanner();
  await openRequestedView();
}

void boot();
