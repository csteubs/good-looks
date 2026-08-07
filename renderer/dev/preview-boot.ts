// Entry point for the browser preview.
//
// Order is the whole point of this file existing separately: the bridge has to
// be on `window` BEFORE the app's own entry module is evaluated, because
// components call `api.*` while mounting. A static import would be hoisted
// above the install call and the first render would race it — so the real
// entry is pulled in with a dynamic import, after.
//
// The production entry (renderer/main/index.tsx) is untouched by any of this.
// Nothing here is reachable from it, and only the `preview` build includes
// this module at all.

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
  banner.textContent = "UI PREVIEW — fixture data, no backend. Recording and test runs do nothing here.";
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

async function boot(): Promise<void> {
  await import("../main/index");
  mountPreviewBanner();
}

void boot();
