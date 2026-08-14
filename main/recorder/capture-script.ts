// The recorder capture script.
//
// Injected into the target page via `executeJavaScriptInIsolatedWorld` on every
// dom-ready. Two things about that world decide the whole design of this file:
//
//  • It is THE SAME world on every call, for the life of the document (world id
//    1999 — see `pageExecutor`). So the capture script, the drain script and
//    the replayer share a global scope, and capture state can live in it. The
//    Glaze SDK this app was ported from ran each call in a fresh ephemeral
//    world, which is why that state used to live on DOM attributes; the comment
//    describing that is gone because the constraint is.
//  • The page cannot see into it. A global set here is invisible to the site's
//    own scripts, and it is destroyed when the document is — which is exactly
//    the lifetime a per-page capture sequence wants.
//
// So `window.__glCapture` holds the queue, the sequence, this document's id and
// the install marker, and the page can neither read nor corrupt any of it.
// (Verified rather than assumed: a page CAN strip every attribute off <html>,
// which is what an attribute-based install marker used to promise and could not
// deliver.) The mode flags stay on <html> — see ATTR_PAUSED below — because
// they are written by the backend and only ever gate behaviour.
//
// ── Never lose the click that navigates ────────────────────────────────────
// A step is captured in three layers, because a click that changes route used
// to be lost at every one of them:
//
//  1. LISTENERS ON window, capture phase, ahead of the ones on document.
//     A page that stops propagation in its own capture-phase handler — which
//     is exactly what a client-side router does to intercept link clicks —
//     used to make our document-level listener never fire at all. Window is
//     the first target in the capture phase, so nothing on the page can get
//     in front of it. Both sets stay installed and `freshEvent` keeps one
//     dispatch from recording two steps.
//  2. A POINTERDOWN FALLBACK. Some widgets navigate on mousedown, so the
//     click event is never dispatched and there is nothing to listen for.
//     pagehide flushes the pending pointerdown as the click it was about to
//     become — and only for something actually activatable, so a redirect that
//     happens to land mid-drag records nothing.
//  3. IMMEDIATE EGRESS. `push` emits the step out of the document (see
//     capture-channel.ts) inside the same dispatch, before returning. The
//     queue is written too, but it is now the BACKUP: it lives in the document
//     the click is destroying, and reading it is a race the recorder was
//     losing.

import { CAPTURE_MESSAGE_PREFIX } from "./capture-channel.js";
import { CSS_ASSERT_PROPS } from "./types.js";

/**
 * Where capture state lives, in the recorder's isolated world.
 *
 * `{ doc, seq, queue }` — the document's id, the number of steps captured in
 * it, and the ones the drain has not collected yet. Its PRESENCE is also the
 * install guard, which is what makes re-injection safe: the object and the
 * listeners are created together, in the same world, for the same document, so
 * there is no state in which one exists without the other. An attribute could
 * not promise that (the page can remove it), and re-injecting over live
 * listeners would double every step from then on.
 */
export const WORLD_STATE_KEY = "__glCapture";
export const ATTR_PAUSED = "data-pw-paused";
export const ATTR_ASSERT = "data-pw-assert";
export const ATTR_ASSERT_SOFT = "data-pw-assert-soft";
// "1" while the "Refine Selector" element picker is active.
export const ATTR_REFINE = "data-pw-refine";
// JSON of the picked element (candidates + css + attributes), drained by backend.
export const ATTR_PICKED = "data-pw-picked";

// Pure DOM helper functions shared verbatim by the capture script (which builds
// a locator FROM an element) and the step replayer (which finds an element FROM
// a locator). Kept as one string so the two injected scripts can't drift. No
// backticks or ${...} inside except the escaped whitespace regex.
/**
 * `cssPropsOf(el)` — the element's computed values for the properties the CSS
 * assertion picker offers, keyed by their KEBAB-case names.
 *
 * One string interpolated into both injected scripts (the capture script and
 * `PICK_AT_POINT_SCRIPT`), and the property list itself comes from
 * `CSS_ASSERT_PROPS` rather than being retyped here. Both copies were
 * hand-maintained before, and the drift they invited was silent in the worst
 * way: the picker still lists a property, and simply shows no value for it.
 *
 * `getPropertyValue` and NOT `cs[name]`: the bracket form needs camelCase and
 * answers `undefined` for a kebab name, while `getPropertyValue` takes the
 * kebab name Playwright's `toHaveCSS` also takes. Reading the value with a
 * different spelling than the assertion compares it with is precisely how a
 * prefilled value could fail the moment it was used.
 *
 * WHAT THESE VALUES INCLUDE. They are read at the instant the user picks the
 * element — with their real cursor over it, because that is what picking is —
 * so any `:hover` styling is already applied. That is what makes a hover
 * assertion prefill correctly, and it is why the dialog says so rather than
 * presenting them as resting styles.
 */
export const CSS_PROPS_HELPER = `
  function cssPropsOf(el) {
    var out = {};
    try {
      var cs = window.getComputedStyle(el);
      var keys = ${JSON.stringify(CSS_ASSERT_PROPS)};
      for (var i = 0; i < keys.length; i++) {
        var v = cs.getPropertyValue(keys[i]);
        if (v) out[keys[i]] = String(v).trim();
      }
    } catch (e) {}
    return out;
  }
`;

/**
 * How many elements the uniqueness scan will look at before giving up.
 *
 * The scan runs on the click path, so it is on the critical path of every
 * recorded interaction. A page is walked at most once per candidate and the
 * per-element work is a string compare against `textContent` — deliberately not
 * `innerText`, which forces layout and would turn one click into a reflow of the
 * whole document. Above this many elements the answer is "assume ambiguous",
 * which costs an `.nth()` on a step rather than a stall the user feels.
 */
export const MAX_UNIQUENESS_SCAN = 6000;

/**
 * `matchesFor(loc, root)` — the elements a recorded locator would resolve to.
 *
 * ── Why this has to exist ──────────────────────────────────────────────────
 * Playwright runs in STRICT MODE. A locator matching two elements is not "the
 * first of two", it is an error that fails the step. The recorder chose
 * locators on the untested assumption that a name, a label or a run of text
 * identified exactly one element, and never once asked the page whether that was
 * true — so every ambiguous locator was recorded happily and failed at replay,
 * on a page the user could no longer see. `getByText("Browser")` on firefox.com
 * is the one that prompted this: two elements, and a test named "Will Pass".
 *
 * ── What "the same as Playwright" means here ───────────────────────────────
 * These mirror Playwright's DEFAULT string semantics, which are not the
 * obvious ones and where the count is decided:
 *   • getByText / getByLabel / getByPlaceholder / getByRole({name}) match a
 *     CASE-INSENSITIVE SUBSTRING with whitespace normalized. Comparing exact
 *     strings would under-count — "Browser" would look unique on a page whose
 *     other match reads "Browsers" — and under-counting is the failure that
 *     matters, because it is the one that ships a locator we have declared safe.
 *   • the text engine returns the SMALLEST element containing the text, i.e. a
 *     match whose descendants do not also match. Without that rule every
 *     ancestor up to <body> counts and nothing is ever unique.
 * `roleOf` and `accName` are reused rather than reimplemented, so the count is
 * computed with the same functions that produced the locator. That is not
 * perfect fidelity to Playwright's ARIA computation and does not need to be:
 * it is self-consistent, which is what makes "this one is unique" mean
 * something.
 *
 * Returns [] on anything unexpected — a caller that cannot count treats the
 * locator as ambiguous, which is the safe direction.
 */
export const UNIQUENESS_HELPERS = `
  function pwNorm(s) {
    return String(s == null ? "" : s).replace(/\\s+/g, " ").trim().toLowerCase();
  }

  /** Playwright's default string match: case-insensitive substring, whitespace
   *  normalized on both sides. */
  function pwHas(haystack, needle) {
    var n = pwNorm(needle);
    if (!n) return false;
    return pwNorm(haystack).indexOf(n) >= 0;
  }

  function scanAll(selector) {
    try {
      var list = document.querySelectorAll(selector);
      return Array.prototype.slice.call(list, 0, ${MAX_UNIQUENESS_SCAN});
    } catch (e) {
      return [];
    }
  }

  function matchesFor(loc) {
    if (!loc) return [];
    try {
      if (loc.k === "testid") {
        return scanAll(
          '[data-testid="' + cssEscape(loc.v) + '"],' +
          '[data-test-id="' + cssEscape(loc.v) + '"],' +
          '[data-test="' + cssEscape(loc.v) + '"]'
        );
      }
      if (loc.k === "css") return scanAll(loc.v);
      if (loc.k === "xpath") {
        var out = [];
        var r = document.evaluate(loc.v, document, null, 5 /* UNORDERED_NODE_ITERATOR */, null);
        var node = r.iterateNext();
        while (node && out.length < ${MAX_UNIQUENESS_SCAN}) { out.push(node); node = r.iterateNext(); }
        return out;
      }
      if (loc.k === "placeholder") {
        return scanAll("[placeholder]").filter(function (el) {
          return pwHas(el.getAttribute("placeholder"), loc.v);
        });
      }
      if (loc.k === "label") {
        // Every element that can carry an accessible label, rather than every
        // element: a label locator is only ever generated for a form control.
        return scanAll("input,textarea,select,button,[aria-label],[aria-labelledby]").filter(
          function (el) { return pwHas(labelFor(el), loc.v); }
        );
      }
      if (loc.k === "role") {
        // Explicit roles plus the tags roleOf() derives one from — the same set,
        // so nothing roleOf can name is missed and the whole document is not
        // walked for a role query.
        var cands = scanAll("[role],a[href],button,input,select,textarea");
        return cands.filter(function (el) {
          if (roleOf(el) !== loc.role) return false;
          if (!loc.name) return true;
          return pwHas(accName(el), loc.name);
        });
      }
      if (loc.k === "text") {
        // textContent, not innerText: this runs on the click path and innerText
        // forces layout per element. See MAX_UNIQUENESS_SCAN.
        var hits = scanAll("*").filter(function (el) {
          return pwHas(el.textContent, loc.v);
        });
        // "Smallest element containing the text" — drop any match that contains
        // another match. Without this every ancestor counts and html/body match
        // everything.
        return hits.filter(function (el) {
          for (var i = 0; i < hits.length; i++) {
            if (hits[i] !== el && el.contains(hits[i])) return false;
          }
          return true;
        });
      }
    } catch (e) {}
    return [];
  }

  /**
   * Choose the first candidate that identifies EXACTLY this element, or index
   * into the best one that at least contains it.
   *
   * The order of preference is the caller's — this only ever narrows it. A
   * candidate that matches one element which is not the target is rejected
   * outright: that is a locator pointing at the wrong thing, which is worse than
   * an ambiguous one, because it fails silently by passing.
   */
  function pickLocator(candidates, el) {
    var fallback = null;
    for (var i = 0; i < candidates.length; i++) {
      var loc = candidates[i];
      var found = matchesFor(loc);
      if (found.length === 1 && found[0] === el) return loc;
      if (fallback === null && found.length > 1) {
        var ix = found.indexOf(el);
        // Only worth remembering if the target is actually in there AND the
        // index is reachable — an .nth() past the cap would be a guess.
        if (ix >= 0 && ix < ${MAX_UNIQUENESS_SCAN}) {
          fallback = { k: loc.k, v: loc.v, role: loc.role, name: loc.name, nth: ix };
        }
      }
    }
    // Nothing was unique. The indexed best candidate beats the last resort,
    // because a readable locator with an index still says what was meant.
    if (fallback) return fallback;
    // Every candidate list this is called with ends in an xpath, which is
    // positional and therefore unique by construction. Returning the last
    // candidate rather than null is what guarantees a step is always recorded.
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }
`;

export const DOM_HELPERS = `
  function cssEscape(s) {
    try { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s); }
    catch (e) { return String(s); }
  }

  function txt(el) {
    if (!el) return "";
    var s = el.innerText || el.textContent || "";
    return s.replace(/\\s+/g, " ").trim();
  }

  function isUniqueId(id) {
    try { return !!id && document.querySelectorAll("#" + cssEscape(id)).length === 1; }
    catch (e) { return false; }
  }

  function labelFor(el) {
    try {
      if (el.id) {
        var l = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (l) return txt(l);
      }
      var p = el.closest ? el.closest("label") : null;
      if (p) return txt(p);
    } catch (e) {}
    var al = el.getAttribute ? el.getAttribute("aria-label") : null;
    return al ? al.trim() : "";
  }

  function accName(el) {
    var al = el.getAttribute ? el.getAttribute("aria-label") : null;
    if (al) return al.trim();
    var lb = el.getAttribute ? el.getAttribute("aria-labelledby") : null;
    if (lb) {
      var r = document.getElementById(lb);
      if (r) return txt(r);
    }
    var t = txt(el);
    if (t && t.length <= 80) return t;
    var title = el.getAttribute ? el.getAttribute("title") : null;
    return title ? title.trim() : "";
  }

  /** The element's ARIA role, as Playwright's \`getByRole\` computes it.
   *
   *  Every deviation here is a locator that RECORDS cleanly, verifies as
   *  unique against this same function, previews green in the trainer — and
   *  then matches nothing in the run, because Playwright consults the real role
   *  mapping. The whole path is self-consistent and wrong together, which is
   *  why it survived: \`matchesFor\` validates uniqueness with this function, so
   *  the recorder was grading its own homework.
   *
   *  The input types below were all collapsed to "textbox". They are reached
   *  whenever a control has no label and no placeholder, which is exactly the
   *  case where a role locator is the last legible option before xpath. */
  function roleOf(el) {
    var explicit = el.getAttribute ? el.getAttribute("role") : null;
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    // A multi-select is a listbox, not a combobox — different role, and the
    // generated getByRole("combobox") matched nothing.
    if (tag === "select") return el.multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "button" || ty === "submit" || ty === "reset") return "button";
      if (ty === "range") return "slider";
      if (ty === "search") return "searchbox";
      if (ty === "number") return "spinbutton";
      if (ty === "email" || ty === "tel" || ty === "url" || ty === "text") return "textbox";
      // password, date, datetime-local, month, week, time, color, file and
      // hidden have NO implicit ARIA role. Returning "" is what stops a role
      // locator from being offered for them at all, which is correct: there is
      // no role for \`getByRole\` to find, so the recorder must fall through to
      // the next candidate rather than write one that cannot match.
      return "";
    }
    return "";
  }

  function cssPath(el) {
    if (el.id && isUniqueId(el.id)) return "#" + cssEscape(el.id);
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var sel = node.tagName.toLowerCase();
      if (node.id && isUniqueId(node.id)) {
        parts.unshift("#" + cssEscape(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = parent;
      depth++;
    }
    return parts.join(" > ");
  }
`;

/**
 * The injected capture script, for one recording session.
 *
 * `nonce` authenticates the steps this script emits over the console channel.
 * It is generated by the backend per session and closed over here, inside an
 * ISOLATED WORLD — the page cannot read it, so it cannot forge a step through
 * that channel. Everything it emits is still rebuilt by `normalizeRawStep`;
 * see the capture-boundary note in CLAUDE.md.
 *
 * Plain string (not type-checked against the Node backend lib). No backticks or
 * ${…} inside except the interpolations spelled out here.
 */
export function buildCaptureScript(nonce: string): string {
  return `
(function () {
  var root = document.documentElement;
  if (!root) return;

  // ----- Capture state, in this world, for this document -----
  //
  // Also the install guard: state and listeners are created together here, so
  // "the state object exists" and "the listeners are alive" cannot disagree.
  // The backend re-injects whenever a drain reports no state (see DRAIN_SCRIPT),
  // and that is only safe because of this.
  if (window.${WORLD_STATE_KEY}) return;
  var gl = {
    doc: "d" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    seq: 0,
    queue: [],
  };
  window.${WORLD_STATE_KEY} = gl;

  // ----- Step egress: the channel a navigation cannot take away -----

  var GL_NONCE = ${JSON.stringify(nonce)};
  var GL_PREFIX = ${JSON.stringify(CAPTURE_MESSAGE_PREFIX)};

  // Hand the step to the browser process NOW, inside the click's own dispatch.
  // console.debug is not a diagnostic here, it is the transport: the message is
  // queued to the browser process at the moment of the call, so it survives the
  // document being torn down by the navigation the click just started. It is
  // also the one egress a page's CSP cannot forbid (fetch/sendBeacon can be),
  // and in an isolated world the page cannot replace the console object it
  // reaches. Never allowed to throw — a failed emit must still leave the step
  // in the queue for the poll to find.
  function emit(entry) {
    try {
      console.debug(GL_PREFIX + JSON.stringify({ n: GL_NONCE, d: gl.doc, i: entry.i, s: entry.s }));
    } catch (e) {}
  }

  // Keep navigation inside the recorder window: default any target-less link to
  // the current frame instead of a new window/tab.
  try {
    if (!document.querySelector("base[data-pw-base]")) {
      var pwBase = document.createElement("base");
      pwBase.setAttribute("target", "_self");
      pwBase.setAttribute("data-pw-base", "1");
      (document.head || document.documentElement).appendChild(pwBase);
    }
  } catch (e) {}

  // Rewrite an element's (or its ancestor link/form) target to _self so a click
  // navigates within this window rather than opening another browser window.
  function keepInWindow(el) {
    try {
      var a = el.closest ? el.closest("a[target], area[target]") : null;
      if (a && a.getAttribute("target") && a.getAttribute("target") !== "_self") {
        a.setAttribute("target", "_self");
      }
      var f = el.closest ? el.closest("form[target]") : null;
      if (f && f.getAttribute("target") && f.getAttribute("target") !== "_self") {
        f.setAttribute("target", "_self");
      }
    } catch (er) {}
  }

  function isPaused() { return document.documentElement.getAttribute("${ATTR_PAUSED}") === "1"; }
  function assertMode() {
    var v = document.documentElement.getAttribute("${ATTR_ASSERT}");
    var ok = ["visible","hidden","text","exactText","enabled","disabled","checked","unchecked"];
    return ok.indexOf(v) >= 0 ? v : null;
  }
  function assertSoft() {
    return document.documentElement.getAttribute("${ATTR_ASSERT_SOFT}") === "1";
  }
  function clearAssert() {
    document.documentElement.setAttribute("${ATTR_ASSERT}", "");
    document.documentElement.setAttribute("${ATTR_ASSERT_SOFT}", "0");
  }
  function refineMode() {
    return document.documentElement.getAttribute("${ATTR_REFINE}") === "1";
  }

  // Two channels, one sequence. The seq is what lets the backend admit each
  // step exactly once and in the order it was captured, however the two
  // deliveries interleave — see CaptureLedger.
  function push(step) {
    gl.seq++;
    var entry = { i: gl.seq, s: step };
    emit(entry);
    try { gl.queue.push(entry); } catch (err) {}
  }

  ${DOM_HELPERS}
  ${UNIQUENESS_HELPERS}

  // ----- One dispatch, one step -----
  //
  // The same handler is registered on window and on document, both in the
  // capture phase, so that a page which stops propagation in its own
  // capture-phase listener cannot hide the click from us (a client-side router
  // intercepting a link click is precisely that). When nothing stops it, both
  // registrations fire for one dispatch, and this is what keeps that from
  // recording the click twice.
  //
  // The test is the identity of the Event OBJECT, and nothing weaker. A DOM
  // object has one JS wrapper per world, so two listeners registered from this
  // world see the same object for one dispatch — verified in a real isolated
  // world by e2e/capture-channel.spec.ts, not assumed.
  //
  // The tempting weaker test — same type, same target, same timeStamp — is
  // wrong in the direction that matters: it would silently drop a second real
  // click that happened to share a coarsened timestamp with the first, which is
  // the exact class of bug this whole change exists to remove.
  var seenEvents = typeof WeakSet === "function" ? new WeakSet() : null;
  function freshEvent(e) {
    if (!e) return false;
    if (!seenEvents) return true;
    if (seenEvents.has(e)) return false;
    seenEvents.add(e);
    return true;
  }
  function once(handler) {
    return function (e) {
      if (!freshEvent(e)) return;
      handler(e);
    };
  }

  function interactiveTarget(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = node.tagName.toLowerCase();
      if (
        tag === "a" || tag === "button" || tag === "input" ||
        tag === "select" || tag === "textarea" ||
        (node.getAttribute && node.getAttribute("role")) ||
        (node.getAttribute && node.getAttribute("tabindex") !== null)
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  // The recorded locator's PREFERENCE ORDER, best first.
  //
  // Unchanged from what this function used to return outright — a testid, then
  // a label/placeholder for form controls, then role+name, then text — so a
  // page where the first choice is unique records exactly the locator it always
  // did. What changed is that this is now a list of candidates rather than an
  // answer: pickLocator asks the page which of them actually identifies this
  // element.
  //
  // It ends in cssPath and xpathFor on every path. That is what makes the
  // choice total: an xpath is positional, so there is always a last candidate
  // that cannot be ambiguous, and the recorder never has to record nothing.
  function locatorCandidates(el) {
    var out = [];
    var tid =
      (el.getAttribute && (el.getAttribute("data-testid") ||
        el.getAttribute("data-test-id") ||
        el.getAttribute("data-test"))) || "";
    if (tid) out.push({ k: "testid", v: tid });

    var tag = el.tagName.toLowerCase();
    var role = roleOf(el);
    var nm = accName(el);

    if (tag === "input" || tag === "textarea" || tag === "select") {
      var lab = labelFor(el);
      if (lab) out.push({ k: "label", v: lab });
      var ph = el.getAttribute("placeholder");
      if (ph) out.push({ k: "placeholder", v: ph });
      if (role && nm) out.push({ k: "role", role: role, name: nm });
    } else {
      if (role && nm) out.push({ k: "role", role: role, name: nm });
      var t = txt(el);
      if (t && t.length <= 40) out.push({ k: "text", v: t });
      if (role && !nm) out.push({ k: "role", role: role });
    }

    out.push({ k: "css", v: cssPath(el) });
    out.push({ k: "xpath", v: xpathFor(el) });
    return out;
  }

  function locatorFor(el) {
    var chosen = pickLocator(locatorCandidates(el), el);
    if (!chosen) return { k: "css", v: cssPath(el) };
    // Rebuilt rather than returned as-is, so a step never carries an undefined
    // key that JSON.stringify would drop unpredictably across the queue.
    var loc = { k: chosen.k };
    if (chosen.v != null) loc.v = chosen.v;
    if (chosen.role != null) loc.role = chosen.role;
    if (chosen.name != null) loc.name = chosen.name;
    if (typeof chosen.nth === "number") loc.nth = chosen.nth;
    return loc;
  }

  // ----- Refine Selector: hover bounding box + rich element capture -----

  // Human-readable element tag, e.g. "button#submit.btn-primary".
  function describeEl(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "?";
    var s = tag;
    if (el.id) {
      s += "#" + el.id;
    } else if (el.className && typeof el.className === "string") {
      var cls = el.className.trim().split(/\\s+/).slice(0, 2).filter(Boolean);
      if (cls.length) s += "." + cls.join(".");
    }
    return s;
  }

  // Absolute XPath for an element (id shortcut when unique, else positional).
  function xpathFor(el) {
    if (el.id && isUniqueId(el.id)) return "//*[@id=" + JSON.stringify(el.id) + "]";
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = node.tagName.toLowerCase();
      var ix = 1;
      var sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) ix++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + "[" + ix + "]");
      if (tag === "html") break;
      node = node.parentElement;
    }
    return "/" + parts.join("/");
  }

  // Every locator strategy that applies to this element, best-first.
  function candidatesFor(el) {
    var out = [];
    var tid =
      (el.getAttribute && (el.getAttribute("data-testid") ||
        el.getAttribute("data-test-id") ||
        el.getAttribute("data-test"))) || "";
    if (tid) out.push({ k: "testid", v: tid });
    var role = roleOf(el);
    var nm = accName(el);
    if (role && nm) out.push({ k: "role", role: role, name: nm });
    var lab = labelFor(el);
    if (lab) out.push({ k: "label", v: lab });
    var ph = el.getAttribute ? el.getAttribute("placeholder") : null;
    if (ph) out.push({ k: "placeholder", v: ph });
    var t = txt(el);
    if (t && t.length <= 40) out.push({ k: "text", v: t });
    if (role && !nm) out.push({ k: "role", role: role });
    out.push({ k: "css", v: cssPath(el) });
    out.push({ k: "xpath", v: xpathFor(el) });
    return out;
  }

  // A curated slice of computed styles, for the review dialog's context and to
  // prefill CSS assertions. See CSS_PROPS_HELPER.
  ${CSS_PROPS_HELPER}

  function attrsOf(el) {
    var out = {};
    var names = ["id", "class", "type", "name", "role", "href", "placeholder", "aria-label"];
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute ? el.getAttribute(names[i]) : null;
      if (v) out[names[i]] = v;
    }
    return out;
  }

  function buildPicked(el) {
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      description: describeEl(el),
      candidates: candidatesFor(el),
      css: cssPropsOf(el),
      attributes: attrsOf(el),
    };
  }

  // ----- Element fingerprint: what the target looked like at record time -----
  //
  // Auto-Heal used to reverse-engineer the user's intent from the ONE locator
  // that was chosen, which is why its scoring needed three separate bug fixes:
  // a renamed testid whose visible label was unchanged scored at zero, because
  // nothing recorded that the label had ever been part of the element's
  // identity. This records the whole identity up front so healing compares
  // against what the element WAS, not against a guess.
  //
  // Deliberately excludes cssPropsOf: computed styles are review-dialog
  // context, useless for identifying an element, and by far the biggest part of
  // the payload — this is stored on every step of every test.

  /** Nearby text that labels this element — the nearest preceding heading or
   *  label within a few ancestors. Survives the element's own text changing,
   *  which is exactly the case a text locator can't heal on its own. */
  function neighborTextOf(el) {
    var node = el;
    for (var up = 0; up < 3 && node; up++) {
      var sib = node.previousElementSibling;
      for (var n = 0; n < 4 && sib; n++) {
        var t = (sib.tagName || "").toLowerCase();
        if (t === "h1" || t === "h2" || t === "h3" || t === "h4" || t === "h5" ||
            t === "h6" || t === "label" || t === "legend") {
          var s = txt(sib);
          if (s) return s.slice(0, 60);
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  }

  /** How deep the element sits in the document. A weak signal on its own, but
   *  it separates two otherwise identical candidates — a page usually doesn't
   *  move its Submit button up six levels between runs. */
  function depthOf(el) {
    var d = 0;
    var node = el;
    while (node && node.parentElement) {
      d++;
      node = node.parentElement;
    }
    return d;
  }

  /** Viewport-normalized box, same 0–1 convention as the capture fixture's
   *  elementRect, so the two can be compared without a unit conversion. */
  function rectOf(el) {
    try {
      var r = el.getBoundingClientRect();
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      if (!vw || !vh || (!r.width && !r.height)) return null;
      return { x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh };
    } catch (e) {
      return null;
    }
  }

  function fingerprintFor(el) {
    if (!el || el.nodeType !== 1) return null;
    var t = txt(el);
    var fp = {
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      description: describeEl(el),
      candidates: candidatesFor(el),
      attributes: attrsOf(el),
      depth: depthOf(el),
    };
    if (t) fp.text = t.slice(0, 120);
    var nb = neighborTextOf(el);
    if (nb) fp.neighborText = nb;
    var r = rectOf(el);
    if (r) fp.rect = r;
    return fp;
  }

  /** Attach a fingerprint to a step. Never allowed to throw: a fingerprint is
   *  an optimization for a later heal, and failing to build one must not stop
   *  the step being recorded at all. */
  function withFp(step, el) {
    try {
      var fp = fingerprintFor(el);
      if (fp) step.fingerprint = fp;
    } catch (e) {}
    return step;
  }

  // Floating overlay that tracks the hovered element in refine mode.
  var refineBox = null;
  function ensureBox() {
    if (refineBox && refineBox.isConnected) return refineBox;
    refineBox = document.createElement("div");
    refineBox.setAttribute("data-pw-refine-box", "1");
    refineBox.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;" +
      "border:2px solid #0a84ff;background:rgba(10,132,255,0.12);border-radius:2px;" +
      "box-shadow:0 0 0 1px rgba(255,255,255,0.6);";
    var lbl = document.createElement("div");
    lbl.setAttribute("data-pw-refine-label", "1");
    lbl.style.cssText =
      "position:absolute;top:-20px;left:-2px;font:11px/16px -apple-system,system-ui,sans-serif;" +
      "background:#0a84ff;color:#fff;padding:1px 6px;border-radius:3px;white-space:nowrap;" +
      "max-width:360px;overflow:hidden;text-overflow:ellipsis;";
    refineBox.appendChild(lbl);
    (document.body || document.documentElement).appendChild(refineBox);
    return refineBox;
  }
  function showBox(el) {
    var b = ensureBox();
    var r = el.getBoundingClientRect();
    b.style.left = r.left + "px";
    b.style.top = r.top + "px";
    b.style.width = Math.max(0, r.width) + "px";
    b.style.height = Math.max(0, r.height) + "px";
    b.style.display = "block";
    if (b.firstChild) b.firstChild.textContent = describeEl(el);
  }
  function hideBox() {
    if (refineBox) refineBox.style.display = "none";
  }
  function isOverlay(el) {
    return !!(el && el.getAttribute && el.getAttribute("data-pw-refine-box"));
  }

  // assert-mode hover highlight
  var lastHi = null;
  function clearHi() {
    if (lastHi) {
      try { lastHi.style.outline = lastHi.__pwOldOutline || ""; } catch (e) {}
      lastHi = null;
    }
  }
  function onOver(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1 || isOverlay(el)) return;
    if (refineMode()) { showBox(el); return; }
    if (!assertMode()) return;
    clearHi();
    lastHi = el;
    try {
      el.__pwOldOutline = el.style.outline;
      el.style.outline = "2px solid #e5484d";
      el.style.outlineOffset = "1px";
    } catch (er) {}
  }
  function onOut() {
    if (refineMode()) return; // box tracks via mouseover; keep it visible
    if (!assertMode()) return;
    clearHi();
  }

  // ----- The click that never becomes a click -----
  //
  // A widget that navigates from its own mousedown handler leaves the click
  // event undispatched: there is no event to capture, and the step the user
  // performed is simply absent. So a pointerdown on something activatable is
  // remembered, and if the document starts to go away before a click arrives,
  // it is recorded as the click it was about to be.
  //
  // Only ACTIVATABLE targets, and only within a few seconds: the cost of being
  // wrong here is a step the user did not perform, which is worse than a
  // missing one because it looks deliberate. A link, a button, a submit input
  // or an element carrying an activating role is a navigation waiting to
  // happen; a div is not.
  var pendingDown = null;
  var PENDING_MAX_AGE_MS = 5000;
  // What the rescue below already recorded, so the click event — if it turns
  // up after all — is not recorded a second time. See flushPendingDown.
  var rescued = null;
  var RESCUE_DEDUPE_MS = 2000;

  function activatableTarget(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = node.tagName ? node.tagName.toLowerCase() : "";
      if (tag === "a" && node.hasAttribute && node.hasAttribute("href")) return node;
      if (tag === "button") return node;
      if (tag === "input") {
        var ty = (node.getAttribute("type") || "").toLowerCase();
        if (ty === "submit" || ty === "button" || ty === "image" || ty === "reset") return node;
      }
      var role = node.getAttribute ? (node.getAttribute("role") || "").toLowerCase() : "";
      if (role === "button" || role === "link" || role === "menuitem" || role === "tab" ||
          role === "option") {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function onPointerDown(e) {
    var t = e.target;
    var el = t && t.nodeType === 1 ? t : null;
    if (!el) return;
    keepInWindow(el);
    pendingDown = null;
    if (isPaused() || assertMode() || refineMode()) return;
    var act = activatableTarget(el);
    if (act) pendingDown = { el: act, at: Date.now() };
  }

  // Runs while the document is unloading. The DOM is still intact here, which
  // is what makes building a locator possible at all; the step reaches the
  // backend because push emits it rather than only queueing it.
  //
  // ORDERING, which cost a debugging session. This is deliberately NOT wired to
  // beforeunload. That event fires SYNCHRONOUSLY the moment a navigation
  // starts — which, for a router that navigates from its own click handler,
  // is in the middle of the click dispatch, BEFORE the recorder's own click
  // listener runs. The rescue then recorded the click, the real handler
  // recorded it again, and the trainer showed the same click twice.
  // rescued closes the mirror image of that race: if a pagehide beats the
  // click event, the click that arrives afterwards is the one already recorded.
  function flushPendingDown() {
    var p = pendingDown;
    pendingDown = null;
    if (!p || !p.el) return;
    if (Date.now() - p.at > PENDING_MAX_AGE_MS) return;
    if (isPaused() || assertMode() || refineMode()) return;
    try {
      if (p.el.isConnected === false) return;
      push(withFp({ type: "click", locator: locatorFor(p.el) }, p.el));
      rescued = { el: p.el, at: Date.now() };
    } catch (er) {}
  }

  /** True when this click is the one the rescue above already recorded. */
  function alreadyRescued(el) {
    if (!rescued) return false;
    if (Date.now() - rescued.at > RESCUE_DEDUPE_MS) { rescued = null; return false; }
    var r = rescued.el;
    var same = r === el ||
      (r.contains && r.contains(el)) ||
      (el.contains && el.contains(r));
    if (same) { rescued = null; return true; }
    return false;
  }

  function onClick(e) {
    // The click arrived, so the pointerdown that preceded it needs no rescue.
    // Cleared before any early return below: a click on a text input records no
    // step, and leaving the pointerdown armed would let the next navigation
    // record one for it.
    pendingDown = null;

    var target = e.target;
    var el = target && target.nodeType === 1 ? target : (target ? target.parentElement : null);
    if (!el) return;

    // Always keep navigation in-window, regardless of pause/assert state.
    keepInWindow(el);

    // Refine Selector: capture the element (no page interaction) and hand its
    // locator candidates + CSS back to the app, then leave refine mode.
    if (refineMode()) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      try {
        document.documentElement.setAttribute("${ATTR_PICKED}", JSON.stringify(buildPicked(el)));
      } catch (er) {}
      document.documentElement.setAttribute("${ATTR_REFINE}", "0");
      hideBox();
      try { if (document.body) document.body.style.cursor = ""; } catch (er) {}
      return;
    }

    var mode = assertMode();
    if (mode) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var payload = withFp({ type: "assert", assert: mode, locator: locatorFor(el) }, el);
      if (mode === "text" || mode === "exactText") payload.text = txt(el).slice(0, 120);
      if (assertSoft()) payload.soft = true;
      push(payload);
      clearAssert();
      clearHi();
      try { if (document.body) document.body.style.cursor = ""; } catch (er) {}
      return;
    }

    if (isPaused()) return;

    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "select") return;
    var typ = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    if (tag === "input" && (typ === "checkbox" || typ === "radio")) return;
    var textLike = ["text", "email", "search", "password", "tel", "url", "number", "date"];
    if ((tag === "input" && textLike.indexOf(typ) >= 0) || tag === "textarea") return;

    var clickTarget = interactiveTarget(el);
    if (alreadyRescued(clickTarget)) return;
    push(withFp({ type: "click", locator: locatorFor(clickTarget) }, clickTarget));
  }

  function onChange(e) {
    if (isPaused() || assertMode()) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag === "select") {
      var opt = el.options[el.selectedIndex];
      push(withFp({ type: "select", locator: locatorFor(el), value: el.value, label: opt ? txt(opt) : el.value }, el));
      return;
    }
    if (tag === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") {
        push(withFp({ type: el.checked ? "check" : "uncheck", locator: locatorFor(el) }, el));
        return;
      }
      push(withFp({ type: "fill", locator: locatorFor(el), value: el.value }, el));
      return;
    }
    if (tag === "textarea") {
      push(withFp({ type: "fill", locator: locatorFor(el), value: el.value }, el));
    }
  }

  function onKeydown(e) {
    var kt = e.target;
    if (kt && kt.nodeType === 1) keepInWindow(kt);
    if (isPaused() || assertMode()) return;
    var k = e.key;
    if (k === "Enter" || k === "Escape") {
      var el = e.target;
      var loc = el && el.nodeType === 1 ? locatorFor(el) : null;
      var step = { type: "press", value: k };
      if (loc) step.locator = loc;
      push(loc ? withFp(step, el) : step);
    }
  }

  // Capture phase on both targets, window first. See once/freshEvent.
  var onClickOnce = once(onClick);
  var onChangeOnce = once(onChange);
  var onKeydownOnce = once(onKeydown);
  var onPointerDownOnce = once(onPointerDown);
  window.addEventListener("click", onClickOnce, true);
  window.addEventListener("change", onChangeOnce, true);
  window.addEventListener("keydown", onKeydownOnce, true);
  window.addEventListener("pointerdown", onPointerDownOnce, true);
  document.addEventListener("click", onClickOnce, true);
  document.addEventListener("change", onChangeOnce, true);
  document.addEventListener("keydown", onKeydownOnce, true);
  document.addEventListener("pointerdown", onPointerDownOnce, true);
  // Hover highlighting is cosmetic and only ever reaches the document, so it
  // needs neither the window registration nor the dedupe.
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
  // pagehide ONLY — see the ordering note on flushPendingDown for why
  // beforeunload is the wrong event here even though it sounds like the right
  // one. The handler never calls preventDefault: a recorder that made the site
  // prompt "Leave site?" would be worse than the bug it is fixing.
  window.addEventListener("pagehide", flushPendingDown, true);
})();
`;
}

/**
 * The capture script with an unusable nonce.
 *
 * For source-level checks and DOM tests, which care about what the script DOES
 * and not about which session it belongs to. Deliberately not usable as a
 * session's script: an empty nonce is rejected by `parseCaptureMessage`, so
 * nothing built from this constant can smuggle steps into a live recording.
 */
export const CAPTURE_SCRIPT_FOR_INSPECTION = buildCaptureScript("");

// Reads and clears the queued steps. Runs in the SAME isolated world as the
// capture script, so it reads that script's own state rather than anything the
// page can reach.
//
// THE BACKUP CHANNEL, not the primary one — see capture-channel.ts. It answers
// with the document's id (so the backend can tell one page load's sequence from
// the next) and with whether capture is still installed, which is what makes
// injection SELF-HEALING: a document with no capture state (a `document.write`,
// a load whose dom-ready we missed, an injection that failed) reports
// installed:0 and gets the script back on the next poll, instead of recording
// nothing for the rest of the session with nothing on screen to say so.
//
// The queue is cleared only AFTER it has been serialized successfully. Handing
// back "" and keeping the steps beats clearing them into a string that could
// not be built.
export const DRAIN_SCRIPT = `
(function () {
  var gl = window.${WORLD_STATE_KEY};
  if (!gl) return '{"d":"","installed":0,"q":[]}';
  var json;
  try {
    json = JSON.stringify({ d: gl.doc, installed: 1, q: gl.queue });
  } catch (e) {
    return "";
  }
  gl.queue = [];
  return json;
})()
`;

// Reads and clears the element picked in refine mode. Returns "" when nothing
// has been picked since the last drain.
export const DRAIN_PICKED_SCRIPT = `
(function () {
  var e = document.documentElement;
  if (!e) return "";
  var p = e.getAttribute("${ATTR_PICKED}") || "";
  if (p) e.setAttribute("${ATTR_PICKED}", "");
  return p;
})()
`;

// Resolve the element under a given (x, y) in CSS client coordinates and return
// its PickedElement (candidates + css + attributes) plus the element's current
// text and value, so the right-click test-tools menu can pre-target assertions
// and waits at that element and prefill text/value asserts. Runs in its own
// ephemeral content world, so it inlines the DOM helpers it needs (kept in sync
// with the capture script's versions). Returns "" when nothing is hit.
export const PICK_AT_POINT_SCRIPT = `
(function (x, y) {
  ${DOM_HELPERS}
  function describeEl(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : "?";
    var s = tag;
    if (el.id) { s += "#" + el.id; }
    else if (el.className && typeof el.className === "string") {
      var cls = el.className.trim().split(/\\s+/).slice(0, 2).filter(Boolean);
      if (cls.length) s += "." + cls.join(".");
    }
    return s;
  }
  function xpathFor(el) {
    if (el.id && isUniqueId(el.id)) return "//*[@id=" + JSON.stringify(el.id) + "]";
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = node.tagName.toLowerCase();
      var ix = 1;
      var sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) ix++; sib = sib.previousElementSibling; }
      parts.unshift(tag + "[" + ix + "]");
      if (tag === "html") break;
      node = node.parentElement;
    }
    return "/" + parts.join("/");
  }
  function candidatesFor(el) {
    var out = [];
    var tid = (el.getAttribute && (el.getAttribute("data-testid") ||
      el.getAttribute("data-test-id") || el.getAttribute("data-test"))) || "";
    if (tid) out.push({ k: "testid", v: tid });
    var role = roleOf(el);
    var nm = accName(el);
    if (role && nm) out.push({ k: "role", role: role, name: nm });
    var lab = labelFor(el);
    if (lab) out.push({ k: "label", v: lab });
    var ph = el.getAttribute ? el.getAttribute("placeholder") : null;
    if (ph) out.push({ k: "placeholder", v: ph });
    var t = txt(el);
    if (t && t.length <= 40) out.push({ k: "text", v: t });
    if (role && !nm) out.push({ k: "role", role: role });
    out.push({ k: "css", v: cssPath(el) });
    out.push({ k: "xpath", v: xpathFor(el) });
    return out;
  }
  ${CSS_PROPS_HELPER}
  function attrsOf(el) {
    var out = {};
    var names = ["id", "class", "type", "name", "role", "href", "placeholder", "aria-label"];
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute ? el.getAttribute(names[i]) : null;
      if (v) out[names[i]] = v;
    }
    return out;
  }
  var el = document.elementFromPoint(x, y);
  if (!el || el.nodeType !== 1) return "";
  // Skip our own overlay elements.
  if (el.getAttribute && el.getAttribute("data-pw-refine-box")) return "";
  var picked = {
    tag: el.tagName ? el.tagName.toLowerCase() : "",
    description: describeEl(el),
    candidates: candidatesFor(el),
    css: cssPropsOf(el),
    attributes: attrsOf(el),
  };
  return JSON.stringify({ picked: picked, text: txt(el).slice(0, 200), value: (el.value != null ? String(el.value).slice(0, 200) : "") });
})
`;
