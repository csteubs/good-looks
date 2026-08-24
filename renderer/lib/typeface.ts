// The chosen typeface, applied to this document.
//
// Sibling of `use-disabled-enhancements.ts` and deliberately close to the same
// shape: read the setting from the backend, hold no state the backend does not
// have. Two differences, both because of what this setting is.
//
// IT IS NOT A HOOK. The three renderer entry points are plain module scope —
// `createRoot(...).render(...)` — and the typeface has to be right for the
// first paint of the whole document, not for one component's subtree. A hook
// would need a wrapper component in each of the three files to call it from,
// which is three chances to reskin two windows out of three.
//
// IT SUBSCRIBES. A flourish toggle only has to be right the next time something
// renders; the typeface has to change in the window the user is looking at
// while they change it in a different one.
//
// WHAT THIS WRITES is `data-gl-typeface` on the document element, which
// `renderer/theme/tokens.css` selects on to swap `--gl-mono`, `--gl-sans` and
// `--gl-track-label`. The attribute is REMOVED rather than set to "space" for
// the default: `:root` already declares the Space pairing, so the untouched app
// carries no attribute at all and there is no boot instant in which the theme
// is waiting for one.

import { api } from "./api";
import { UI_TYPEFACES } from "./recorder-types";
import type { UiTypeface } from "./recorder-types";

/** Payload of the `settings:appearanceChanged` push. `uiScale` rides along but
 *  is applied in the backend (see `main/services/ui-scale.ts`) — it is on the
 *  channel so the message is the whole of "how the app looks" rather than half
 *  of it, and so a future renderer-side use of it needs no second channel. */
export interface AppearancePush {
  uiScale?: number;
  uiTypeface?: unknown;
}

/** Narrow an unknown to a typeface name, falling back to the default.
 *
 *  The backend validates too, and this is not redundant: what arrives here is
 *  about to be written into the document as an attribute value, and a bad one
 *  fails SILENTLY — an unmatched selector styles nothing, so the app would
 *  render in the default face and the setting would look broken rather than
 *  refused. */
export function asTypeface(v: unknown): UiTypeface {
  return typeof v === "string" && (UI_TYPEFACES as string[]).includes(v)
    ? (v as UiTypeface)
    : "space";
}

/** Write the typeface to the document element.
 *
 *  Exported because the Appearance pane calls it directly on save. That used to
 *  be the only thing that worked: Settings was its own window, was not
 *  registered as an aux window, and so never received the backend push that
 *  updates every other window — leaving the one window the user was looking at
 *  while changing the setting as the one that did not change. Settings is a
 *  route in the main window now and DOES get the push; the direct call stays
 *  because it lands the change in the same frame as the click rather than
 *  after an IPC round trip. */
export function applyTypeface(typeface: UiTypeface): void {
  const root = document.documentElement;
  if (typeface === "space") root.removeAttribute("data-gl-typeface");
  else root.setAttribute("data-gl-typeface", typeface);
}

/**
 * Keep this document in the user's chosen typeface. Call once per window, from
 * its entry point. Returns an unsubscribe for symmetry; the entry points do not
 * use it, because a document that is going away does not care.
 */
export function startTypeface(): () => void {
  let cancelled = false;

  api.recorder
    .getSettings()
    .then((s) => {
      if (!cancelled) applyTypeface(asTypeface(s.uiTypeface));
    })
    .catch(() => {
      // Defaults to Space, which is what `:root` already says — so a failed
      // load leaves the app looking exactly as it does today rather than
      // unstyled.
    });

  const off = api.on<AppearancePush>("settings:appearanceChanged", (payload) => {
    applyTypeface(asTypeface(payload?.uiTypeface));
  });

  return () => {
    cancelled = true;
    off();
  };
}
