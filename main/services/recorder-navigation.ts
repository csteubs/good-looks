// What the training browser is allowed to do with a navigation.
//
// THE STAKES. Glaze routes cross-origin main-frame navigations to the SYSTEM
// BROWSER by default. That default is catastrophic here: a replay that escapes
// the training window drives the user's real browser — their logged-in,
// personal, non-incognito browser — through the steps of a test. It has
// happened: a replay left the trainer and ran in a different browser that
// happened to be open.
//
// So this module inverts the burden of proof. The old handler was a series of
// early `return`s, and every one of them was an ESCAPE: returning means "no
// objection", and no objection means the system browser. Any condition nobody
// thought of — a redirect, a missing field, an unfamiliar scheme — silently
// resolved to the most dangerous outcome available.
//
// Here, nothing escapes unless it is positively proven safe. The only two
// proofs accepted are "this navigation cannot leave the page" (same-document)
// and "we issued it ourselves". Everything else is contained or blocked, and
// an unrecognized shape is contained rather than trusted.
//
// Pure so every branch can be exercised, including the malformed events a real
// SDK is not supposed to emit.

export type NavigationAction =
  /** Safe to let proceed untouched — it cannot leave the training window. */
  | { action: "allow"; reason: string }
  /** Cancel and re-issue inside the training window via loadURL. */
  | { action: "load-in-window"; url: string; reason: string }
  /** Cancel outright. Nothing is loaded and nothing leaves the app. */
  | { action: "block"; reason: string };

/** The subset of WebContentsNavigationEvent this decision reads. Deliberately
 *  optional: the point is to behave safely when a field is missing, which a
 *  type declaration cannot promise at runtime. */
export interface NavigationDetails {
  url?: unknown;
  isMainFrame?: unknown;
  isSameDocument?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Decide what to do with a navigation in the training window.
 *
 * @param details  the SDK's navigation event
 * @param selfLoad the URL we most recently issued ourselves via loadURL, if any
 */
export function decideNavigation(
  details: NavigationDetails | null | undefined,
  selfLoad: string | null,
): NavigationAction {
  // A malformed event tells us nothing, and "nothing" must not mean "proceed".
  if (!details || typeof details !== "object") {
    return { action: "block", reason: "malformed navigation event" };
  }

  const url = asString(details.url);
  if (!url) return { action: "block", reason: "navigation with no URL" };

  // Same-document (SPA push/replace/hash) cannot leave the window by
  // definition, so it is the one case that is provably safe to ignore.
  if (details.isSameDocument === true) {
    return { action: "allow", reason: "same-document navigation" };
  }

  // Our own programmatic load, re-entering as an event. Containing it again
  // would loop forever.
  if (selfLoad !== null && url === selfLoad) {
    return { action: "allow", reason: "self-issued load" };
  }

  // A genuine sub-frame navigation stays in its frame; re-issuing it in the
  // main window would replace the whole page with an iframe's URL.
  //
  // Note the strict === false. An ABSENT isMainFrame is treated as a main-frame
  // navigation and contained, because between "an iframe loads in the wrong
  // place" and "the user's real browser is driven through a test", only one of
  // those is recoverable.
  if (details.isMainFrame === false) {
    return { action: "allow", reason: "sub-frame navigation" };
  }

  if (/^https?:\/\//i.test(url)) {
    return { action: "load-in-window", url, reason: "cross-window http(s) navigation" };
  }

  // Everything else — mailto:, tel:, custom app schemes, file:, data: — hands
  // off to the OS if allowed to proceed, which can launch another application
  // mid-replay. There is nothing a training window needs from any of them.
  return { action: "block", reason: `non-http scheme (${schemeOf(url)})` };
}

function schemeOf(url: string): string {
  const at = url.indexOf(":");
  return at > 0 ? url.slice(0, at).toLowerCase() : "unknown";
}

/** Navigation events that can escape to the system browser, and must therefore
 *  all be intercepted. `will-redirect` is the one that actually bit us: it is
 *  fired instead of `will-navigate` when a server 302s a navigation elsewhere,
 *  so a click that began same-origin escaped the moment the site redirected
 *  cross-origin — routine on a Shopify checkout. */
export const GUARDED_NAVIGATION_EVENTS = [
  "will-navigate",
  "will-redirect",
  "will-frame-navigate",
] as const;

/**
 * Whether a containment we just performed repeats one already in flight.
 *
 * The three guarded events overlap — a single navigation can raise more than
 * one — and each containment issues a loadURL. Without this, one click could
 * fire several loads of the same URL and the window would thrash.
 */
export function isDuplicateContainment(
  last: { url: string; at: number } | null,
  url: string,
  now: number,
  windowMs = 500,
): boolean {
  return last !== null && last.url === url && now - last.at < windowMs;
}


// ── Capability-level containment ─────────────────────────────────────
// Intercepting navigation events assumes the escape travels through an event
// we thought to listen for. That assumption has already been wrong once, and an
// event-by-event defence is only ever as complete as the last incident.
//
// Handing a URL to the OS is a PERMISSION in this SDK ("openExternal"), so
// denying it refuses the capability itself — whatever asks, by whatever path.
// This is the stronger of the two guards; the event handlers remain as a
// second layer rather than the only one.

/** Permissions the training window must never be granted. */
export const DENIED_RECORDER_PERMISSIONS = ["openExternal"] as const;

/**
 * Whether the training window may be granted a permission.
 *
 * Everything except the denied set is allowed: a training browser legitimately
 * needs media, geolocation and the rest to reproduce what a user's session
 * looked like, and blanket-denying would break recordings for no safety gain.
 * The one capability that can reach OUT of the app is the one refused.
 */
export function permissionAllowed(permission: string): boolean {
  return !(DENIED_RECORDER_PERMISSIONS as readonly string[]).includes(permission);
}
