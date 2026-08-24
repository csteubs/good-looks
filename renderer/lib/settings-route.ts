// Where Settings lives in the router, spelled once.
//
// Settings is two screens — the category board at `/settings` and one pane at
// `/settings/$pane`, with a third level for the Documentation pane's topic —
// and THREE COMPONENTS HAVE TO AGREE ABOUT WHICH IS ON SCREEN from nothing but
// a pathname:
//
//   • `RootShell` mounts `SettingsScope` (the controller and the search box's
//     state) while a settings route is open, and nowhere else.
//   • `LibrarySidebar` swaps the rail's body from the library to the pane list
//     at the same moment. It reads the controller, so a rail that swapped on a
//     path the scope did not mount for would throw out of
//     `useSettingsController` — a blank window and a clean log.
//   • `AppStrip` turns the same pathname into a breadcrumb.
//
// Two of those are in `renderer/main/` and one is in `renderer/settings/`, so
// "starts with /settings" written out three times is three chances to disagree
// about a trailing slash. It is written here instead.
//
// The parse deliberately answers with RAW SEGMENTS and no opinion about whether
// they name anything: a pathname comes out of history, and deciding that
// `/settings/nonsense` is not a pane is the view's job (`paneById`), not this
// file's. See `stats-categories.ts` for the same split.

/** The board. Everything else under Settings hangs off it. */
export const SETTINGS_PATH = "/settings";

/** `/settings`, `/settings/<pane>`, `/settings/<pane>/<topic>` — and nothing
 *  else. Anchored at both ends so `/settingsomething` is not a settings path. */
const SETTINGS_RE = /^\/settings(?:\/([^/]+))?(?:\/([^/]+))?\/?$/;

export interface SettingsLocation {
  /** The pane segment, still percent-encoded as history spells it, or
   *  undefined on the board. */
  pane?: string;
  /** The topic segment below a pane, or undefined. */
  topic?: string;
}

/** The settings screen this pathname names, or null when it names none. */
export function parseSettingsPath(pathname: string): SettingsLocation | null {
  const m = SETTINGS_RE.exec(pathname);
  if (!m) return null;
  return { pane: m[1], topic: m[2] };
}

/** True while any settings screen is open. The one question the rail and the
 *  scope both ask. */
export function isSettingsPath(pathname: string): boolean {
  return SETTINGS_RE.test(pathname);
}
