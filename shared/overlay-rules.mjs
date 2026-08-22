// Overlay dismissal rules: what one IS, which ones are armed for a URL, and
// the watcher that enforces them inside a page.
//
// ── Why a standing rule and not a step ─────────────────────────────────────
//
// A consent modal does not appear once. It is re-injected by a third-party
// script on EVERY document, so a dismissal placed at one point in a step list
// is correct exactly until the next navigation. Measured against ritual.com's
// DataGrail banner: clicking its close control dismisses it, and it is back on
// the next `page.goto`. A step cannot express "whenever this appears".
//
// This is the same argument settle-fixture-source.ts makes for living outside
// the generated spec — a spec is written once and then lives on disk, so a
// behaviour the user tunes afterwards must not be baked into it — plus one
// more: there is no point in the step list where "every future document" can
// be written down.
//
// ── What was tried and does not work ───────────────────────────────────────
//
// Three plausible alternatives were measured against the real site before this
// one was built, and the first two are the ones anybody would reach for first:
//
//   • REPLAY THE CLICK. Works, then the banner returns on the next navigation.
//   • RECORD THE CONSENT DECISION. `setConsentPreferences` with every category
//     denied left the banner up, before and after navigating.
//   • CARRY THE COOKIES. A fresh context seeded with all 48 cookies from a
//     context that had already dismissed it — the three `datagrail_*` ones
//     included — still showed the banner. So the app's existing `saveSession`
//     / `useSessionFrom` machinery and the `cookie` step CANNOT solve this:
//     the decision is not reconstructible from client cookies.
//
// What does work is re-applying the dismissal on every document, which is what
// the watcher below does.
//
// ── Pure, and why that matters here ────────────────────────────────────────
//
// No fs, no shell import, no IPC (see the admission rule in CLAUDE.md). Both
// the trainer and the run need this vocabulary and neither can import the
// other's module: the trainer injects into a live Electron page, the run's
// fixture is plain `.mjs` loaded by Playwright's own transform.

/** The locator kinds a rule may target.
 *
 *  `xpath` is deliberately absent. An absolute path encodes the DOM as it
 *  stood when the rule was taught, and a third-party CMP's position among its
 *  siblings is exactly what moves between a recording session and a fresh
 *  cache-less run. A rule is meant to outlive a snapshot; a positional address
 *  cannot. The other four all describe the element itself. */
export const OVERLAY_LOCATOR_KINDS = ["css", "testid", "text", "role"];

/** Longest label a rule may carry. Display only — it never reaches a page. */
export const MAX_OVERLAY_LABEL = 120;

/** How many rules one host may arm. A bound rather than a policy: the watcher
 *  walks this list on every mutation batch, and an unbounded list is a way to
 *  make a page slow that nothing else in the app would catch. */
export const MAX_RULES_PER_HOST = 20;

/** How long the watcher keeps re-checking after a document starts, in ms.
 *
 *  A CMP is injected by a third-party script well after `load`, so a watcher
 *  that gave up at `DOMContentLoaded` would miss the thing it exists for. It
 *  stays armed for the life of the document instead; this bounds only the
 *  FALLBACK poll that covers a banner arriving with no DOM mutation the
 *  observer can see (an element revealed by a stylesheet, say). */
export const WATCH_FALLBACK_MS = 15000;

/** How often that fallback poll runs. */
export const WATCH_POLL_MS = 500;

/** The registrable host of a URL, lowercased, or "" when there isn't one.
 *
 *  Deliberately NOT the full origin: a rule taught on `https://ritual.com`
 *  must fire on `http://ritual.com` and on a different port, because a consent
 *  banner is a property of the site, not of the scheme it was first seen on. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
}

/** Does a rule's host cover this URL?
 *
 *  Suffix matching on LABEL boundaries, so a rule for "ritual.com" fires on
 *  "www.ritual.com" and "shop.ritual.com" — a CMP is configured per property,
 *  not per subdomain — while "evil-ritual.com" does not match, which a bare
 *  `endsWith` would wrongly accept. */
export function hostMatches(ruleHost, url) {
  const want = String(ruleHost || "").toLowerCase().replace(/^\.+/, "");
  const got = hostOf(url);
  if (!want || !got) return false;
  if (got === want) return true;
  return got.endsWith("." + want);
}

/** The rules that should be enforced on this URL: enabled, host-matched, and
 *  capped. The cap is applied AFTER filtering so one noisy host cannot starve
 *  another. */
export function armedRulesFor(rules, url) {
  const list = Array.isArray(rules) ? rules : [];
  return list
    .filter((r) => r && !r.disabled && hostMatches(r.host, url))
    .slice(0, MAX_RULES_PER_HOST);
}

/**
 * Is this element worth clicking — i.e. actually on screen?
 *
 * SELF-CONTAINED, ES5, no closure references, for the same reason
 * `matchesValue` in step-semantics.mjs is: `watcherSource()` serializes it with
 * `toString()` into a script that runs beside an untrusted page.
 *
 * A CMP typically renders its banner into the DOM and then reveals it, so
 * "present" and "visible" are different questions and only the second one means
 * the user can see it. Clicking a hidden control is how a watcher fires once at
 * document start, does nothing, and then never fires again because the
 * observer's batch has already passed.
 */
export function overlayVisible(el) {
  if (!el || el.nodeType !== 1) return false;
  try {
    var rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    var style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (!style) return true;
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (String(style.opacity) === "0") return false;
    return true;
  } catch (e) {
    return false;
  }
}

/** `overlayVisible` as source, for embedding. */
export function overlayVisibleSource() {
  return "var overlayVisible = " + overlayVisible.toString() + ";";
}

/**
 * The watcher, as source.
 *
 * ── The contract with its host ─────────────────────────────────────────────
 *
 * This function is NOT self-contained: it calls `matchesFor(locator)`, which
 * must already be defined in the scope it is interpolated into. That is
 * deliberate and it is the whole point of the design.
 *
 * `matchesFor` is the app's ONE locator resolver — the engine the capture
 * script grades uniqueness with, the heal probe searches with, and the step
 * replayer previews with (`UNIQUENESS_HELPERS` in capture-script.ts). Both
 * callers of this watcher interpolate that same engine ahead of it: the
 * trainer injects it into the recorder's isolated world, and the run's
 * dismissal fixture writes it into the script it hands to `addInitScript`.
 *
 * So the trainer and the run resolve a rule with the SAME code, against the
 * same DOM semantics, including the shadow-root piercing added on 2026-08-22 —
 * which matters more here than anywhere, because the banners this feature
 * exists for are usually web components. Two resolvers agreeing "for now" is
 * the failure mode `e2e/assert-parity.spec.ts` was built to end, and the
 * cheapest way not to have it is not to write a second resolver.
 *
 * ── What it does, and what it refuses to do ────────────────────────────────
 *
 * It clicks. It does not hide, mask or remove: a banner that is merely hidden
 * is still in the accessibility tree and still counted by an `a11y` step, and
 * a run that quietly deletes page content is a run whose screenshots stop
 * describing the site. Clicking is the thing a person would have done.
 *
 * It NEVER throws. This is pacing, not assertion — same rule as the settle
 * fixture. An overlay rule that failed a run would be a rule that turns a
 * cosmetic annoyance into a broken suite.
 *
 * ── Why the clicked-set is not optional ───────────────────────────────────
 *
 * The first draft argued idempotency was structural: a rule targets the
 * control that dismisses the overlay, so one click removes what the rule
 * matches and the next sweep finds nothing. Measured against ritual.com's
 * Klaviyo modal, that is false — its close button is removed roughly 600ms
 * AFTER the click, and the sweep runs on every mutation batch plus a 500ms
 * poll. One dismissal produced SEVEN clicks in that window.
 *
 * Harmless there, but not a property to rely on: a control that toggles rather
 * than closes would be clicked back open, and a second click during teardown
 * is the kind of thing that lands on whatever the page put there next.
 *
 * So each ELEMENT is clicked at most once, tracked by node identity in a
 * WeakSet. Node identity rather than a per-rule flag is what keeps a
 * legitimately re-injected banner working: the new banner is a new node, so it
 * is dismissed again, while the dying node from the last dismissal is not
 * clicked twice. A WeakSet also means a removed node stops being remembered
 * without any bookkeeping of our own.
 *
 * `onDismiss` is called with the rule id after each click so a host can count
 * them — the trainer uses it to suppress the step its own capture listeners
 * would otherwise record, and the run uses it to report what it dismissed.
 */
export function watcherSource() {
  return `
  function installOverlayWatcher(rules, onDismiss) {
    if (!rules || !rules.length) return function () {};
    var stopped = false;
    // Node identity, not a per-rule flag — see the note above. A page without
    // WeakSet gets a marker property instead; neither is reachable as a
    // selector, so a page cannot use it to detect or defeat the watcher.
    var clicked = typeof WeakSet === "function" ? new WeakSet() : null;
    var MARK = "__glOverlayClicked";
    function alreadyClicked(el) {
      if (clicked) return clicked.has(el);
      return el[MARK] === true;
    }
    function markClicked(el) {
      if (clicked) { clicked.add(el); return; }
      try { Object.defineProperty(el, MARK, { value: true, enumerable: false }); } catch (e) {}
    }
    function sweep() {
      if (stopped) return;
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var hits;
        try { hits = matchesFor(rule.target); } catch (e) { continue; }
        if (!hits || !hits.length) continue;
        for (var h = 0; h < hits.length; h++) {
          var el = hits[h];
          if (alreadyClicked(el)) continue;
          if (!overlayVisible(el)) continue;
          markClicked(el);
          try {
            if (typeof onDismiss === "function") onDismiss(rule.id);
            el.click();
          } catch (e) {}
        }
      }
    }
    var observer = null;
    try {
      observer = new MutationObserver(sweep);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    // The fallback poll covers a banner that becomes visible with no mutation
    // the observer can see — revealed by a stylesheet, or by a class on an
    // element that was already in the tree. Bounded, because it is the belt to
    // the observer's braces and not the mechanism.
    var started = Date.now();
    var timer = null;
    try {
      timer = setInterval(function () {
        if (stopped || Date.now() - started > ${WATCH_FALLBACK_MS}) {
          if (timer) clearInterval(timer);
          return;
        }
        sweep();
      }, ${WATCH_POLL_MS});
    } catch (e) {}
    sweep();
    return function () {
      stopped = true;
      try { if (observer) observer.disconnect(); } catch (e) {}
      try { if (timer) clearInterval(timer); } catch (e) {}
    };
  }
`;
}
