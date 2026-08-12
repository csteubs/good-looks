// The recorder capture script.
//
// Injected into the target page via webContents.executeJavaScript on every
// dom-ready. In Glaze, executeJavaScript runs each call in a fresh, ephemeral
// content world, so JS globals set in one call are invisible to the next.
// Everything that must survive between calls therefore lives on shared DOM
// attributes of <html>, which persist for the document's lifetime and are
// readable from any content world:
//   - data-pw-installed : "1" once listeners are attached (dedupe guard)
//   - data-pw-queue     : JSON array of captured steps, drained by the backend
//   - data-pw-paused    : "1" while recording is paused
//   - data-pw-assert    : "visible" | "text" | "" while in assertion mode
// The event listeners installed here live in the world of the injecting call,
// which WebKit keeps alive because the document retains the listeners.

import { CSS_ASSERT_PROPS } from "./types.js";

// Marker/attribute names, shared with the backend.
export const ATTR_INSTALLED = "data-pw-installed";
export const ATTR_QUEUE = "data-pw-queue";
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

  function roleOf(el) {
    var explicit = el.getAttribute ? el.getAttribute("role") : null;
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "button" || ty === "submit" || ty === "reset") return "button";
      if (ty === "range") return "slider";
      return "textbox";
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

// Plain string (not type-checked against the Node backend lib). No backticks or
// ${...} inside.
export const CAPTURE_SCRIPT = `
(function () {
  var root = document.documentElement;
  if (!root) return;
  if (root.getAttribute("${ATTR_INSTALLED}") === "1") return;
  root.setAttribute("${ATTR_INSTALLED}", "1");
  if (root.getAttribute("${ATTR_QUEUE}") == null) root.setAttribute("${ATTR_QUEUE}", "[]");

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

  function push(step) {
    var e = document.documentElement;
    var q;
    try { q = JSON.parse(e.getAttribute("${ATTR_QUEUE}") || "[]"); } catch (err) { q = []; }
    q.push(step);
    e.setAttribute("${ATTR_QUEUE}", JSON.stringify(q));
  }

  ${DOM_HELPERS}
  ${UNIQUENESS_HELPERS}

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

  function onClick(e) {
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

  document.addEventListener("click", onClick, true);
  document.addEventListener("change", onChange, true);
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("mouseout", onOut, true);
})();
`;

// Reads and clears the queued steps. Runs in its own ephemeral world; the DOM
// attribute is shared, so it drains whatever the listeners have pushed.
export const DRAIN_SCRIPT = `
(function () {
  var e = document.documentElement;
  if (!e) return "[]";
  var q = e.getAttribute("${ATTR_QUEUE}") || "[]";
  e.setAttribute("${ATTR_QUEUE}", "[]");
  return q;
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
