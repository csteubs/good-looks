// What a URL assertion should be PRE-FILLED with, given the page's live URL.
//
// Lives in `shared/` because both sides need the identical answer and cannot
// share a `.ts`: the backend computes it for the training browser's right-click
// menu and its chrome strip, and the renderer computes it for the assert menus
// in the main window and the trainer panel. Three call sites that disagree
// about what "URL contains" means would be worse than no prefill at all — the
// user would learn not to trust the suggested value.
//
// Pure: no fs, no IPC, no process. `URL` is a language global.

/**
 * The four URL assert kinds want DIFFERENT defaults, because they generate
 * different assertions:
 *
 *   • `urlIs`   → `toHaveURL(/^…$/)`, an exact whole-URL match. Anything less
 *                 than the absolute URL can never pass, so it gets the full
 *                 string including origin.
 *   • `url`     → an unanchored-RegExp contains match.
 *   • `urlEndsWith` → `toHaveURL(/…$/)`.
 *   • `urlPathIs` → the URL's PATH alone, query and fragment ignored. This is
 *                 the robust default: the other three compare the full URL, so
 *                 a `?variant=` or `utm_*` the site appends between the
 *                 recording and the run fails them for a reason that has
 *                 nothing to do with the product. The pathname is the part the
 *                 user actually chose.
 *
 * `url` and `urlEndsWith` get the PATH (plus query and fragment) rather than
 * the whole URL, because the origin is the part that changes between
 * environments. A spec that asserts `https://ritual.com/cart` passes on
 * production and fails on staging for a reason that has nothing to do with the
 * product; `/cart` passes on both. `urlPathIs` gets the pathname only — the
 * whole point of the kind is that the query and fragment are not asserted.
 *
 * @param {string} kind  one of "url" | "urlEndsWith" | "urlIs" | "urlPathIs"
 * @param {string} url   the page's current absolute URL
 * @returns {string} the value to seed the dialog's field with ("" when there is
 *   nothing useful to suggest — the caller then behaves as it did before)
 */
export function urlAssertPrefill(kind, url) {
  if (typeof url !== "string" || url === "") return "";
  if (kind === "urlIs") return url;
  if (kind !== "url" && kind !== "urlEndsWith" && kind !== "urlPathIs") return "";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not parseable — an about:blank, a data: URL, or a load that failed before
    // it had a location. Suggesting a mangled substring is worse than an empty
    // field the user knows to fill in.
    return "";
  }

  // Non-http schemes have no meaningful "path to assert on": about:blank's
  // pathname is "blank", which would generate an assertion that reads like a
  // typo. Only the web schemes the trainer actually records get a suggestion.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";

  // The pathname alone — "/" at a site root included, because `urlPathIs` is
  // an EXACT match and "path is /" is a true statement about the page the user
  // is looking at, unlike the contains-"/" trap the fallback below exists for.
  if (kind === "urlPathIs") return parsed.pathname;

  const path = parsed.pathname + parsed.search + parsed.hash;

  // A site's ROOT is the one case where the path is useless: `toHaveURL("/")`
  // is satisfied by every URL on every host, so it would generate an assertion
  // that passes unconditionally — the most expensive kind of wrong, because it
  // is green. Fall back to the host, which is the narrowest thing still true of
  // the page the user is looking at.
  if (path === "/" || path === "") return parsed.host;

  return path;
}
