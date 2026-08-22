// Builds an injected JS snippet that previews a single recorded step in the live
// recorder window: it resolves the step's locator against the current DOM and
// performs the action (or evaluates the assertion), returning
// { ok, error?, logs: DebugLogLine[] }.
//
// This is a best-effort, synthetic-event PREVIEW — not Playwright's actionability
// engine — so results can differ from a real `runner:run`. It reuses the shared
// DOM_HELPERS (roleOf/accName/txt/cssEscape…) so locator semantics stay aligned
// with the capture script. The `logs` array carries verbose, ordered
// diagnostics for the trainer's step debug panel.

import { DOM_HELPERS, UNCAPPED_SCAN, UNIQUENESS_HELPERS } from "../recorder/capture-script.js";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./script-generator.js";
import {
  ASSERT_SEMANTICS,
  matchSource,
  urlPathSource,
  visibilitySource,
  WAIT_SEMANTICS,
} from "../../shared/step-semantics.mjs";
import type { DebugLogLine, Step } from "../recorder/types.js";

/** Ceiling on how long a conditional wait blocks the PREVIEW, whatever the
 *  step's own timeout says. The fixed-duration wait has had the same 5s cap
 *  since it was written: the trainer's UI is waiting on this, and a step that
 *  legitimately waits 60s in a real run would read as a hung app here. */
const PREVIEW_WAIT_CAP_MS = 5000;
/** How often the preview re-checks the predicate. */
const PREVIEW_WAIT_POLL_MS = 100;

export interface ReplayResult {
  ok: boolean;
  error?: string;
  /** For an `if` step: whether the condition held (block body should run). */
  met?: boolean;
  /** For a `state: "hover"` step: where in the viewport (CSS client pixels) the
   *  real cursor must be moved to. The page reports the geometry because only
   *  the page can resolve the locator; the move itself is native, because
   *  `:hover` follows the OS pointer and no synthetic event can fake it. */
  point?: { x: number; y: number };
  logs: DebugLogLine[];
}

export function buildReplayScript(step: Step): string {
  // NOTE: no backticks inside the JS body below; the only ${...} are the
  // deliberate interpolations (DOM_HELPERS, the step JSON, and the three wait
  // constants). `\\s` produces a literal \s in the emitted script.
  return `(function () {
  ${DOM_HELPERS}
  ${UNIQUENESS_HELPERS}
  ${matchSource()}
  ${urlPathSource()}
  ${visibilitySource()}

  // The uniqueness scan's element cap exists because CAPTURE runs it on the
  // click path. A preview does not: the user asked for it and is watching it,
  // and this call already runs under an 8s budget. Left at the capture cap, a
  // page with more elements than it would hide a locator's target from the
  // trainer while a real run resolved it perfectly well.
  GL_SCAN_LIMIT = ${UNCAPPED_SCAN};

  // The SAME tables the generator reads, shipped in as data. A predicate the
  // trainer evaluates one way and the spec evaluates another is the entire
  // failure this file was rewritten to end — see shared/step-semantics.mjs.
  var ASSERT_SEMANTICS = ${JSON.stringify(ASSERT_SEMANTICS)};
  var WAIT_SEMANTICS = ${JSON.stringify(WAIT_SEMANTICS)};

  var step = ${JSON.stringify(step)};
  var logs = [];
  var li = 0;
  function log(level, m) { logs.push({ i: li++, t: Date.now(), level: level, m: String(m == null ? "" : m) }); }
  function locDesc(loc) {
    if (!loc) return "(no locator)";
    var k = loc.k || "?", v = loc.v || "";
    if (k === "role") return "role=" + (loc.role || "") + (loc.name ? " name~" + loc.name : "");
    return k + (v ? "=" + v : "");
  }

  log("info", "Replay step: " + step.type + (step.type === "assert" ? " (" + step.assert + ")" : ""));
  if (step.locator) log("info", "Locator: " + locDesc(step.locator));
  if (step.type === "fill" || step.type === "select") log("info", "Value: " + (step.value || ""));
  if (step.type === "assert") {
    // The VERB comes from the shared table rather than from the word
    // "contains" — this line said "contains" for every URL and title kind
    // including the two EXACT ones, which is the same lie the predicates
    // themselves used to tell, printed into the log the user reads to decide
    // whether the step is right.
    var sem = ASSERT_SEMANTICS[step.assert];
    if (sem) {
      var verb = sem.match === "exact" ? "to be exactly" : sem.match === "endsWith" ? "to end with" : "to contain";
      log("info", "Expect " + step.assert + " " + verb + ": " + (step.text || step.value || ""));
    } else if (step.assert === "count") {
      log("info", "Expect count = " + step.count);
    } else {
      log("info", "Expect " + step.assert);
    }
  }

  function ci(s) { return String(s == null ? "" : s).toLowerCase(); }
  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); }

  /** Compare against the step's expectation using the SHARED rule for its kind.
   *  A kind with no declared semantics (visible, count, css…) never reaches
   *  here — those compare something other than a string. */
  function matchKind(table, kind, actual, expected) {
    var s = table[kind];
    if (!s) return false;
    return matchesValue(actual, expected, s);
  }

  /** Playwright's visibility rule, from the shared module.
   *
   *  Was: \`width <= 0 && height <= 0\` (so a 0×10 element counted as VISIBLE
   *  here and hidden in the run) plus an \`opacity === "0"\` test Playwright
   *  does not perform at all (so a faded element counted as hidden here and
   *  visible in the run). Two mismatches, in opposite directions, on the most
   *  common assertion in the product. */
  function visible(el) {
    if (!el) return false;
    try {
      return isVisibleByRect(el.getBoundingClientRect(), getComputedStyle(el));
    } catch (e) {}
    return true;
  }

  /** Playwright treats \`aria-disabled\`/\`aria-checked\` as authoritative for
   *  elements that are not native form controls, and the replayer read only the
   *  DOM properties — which are \`undefined\` on a div-with-a-role, so every
   *  custom widget answered "enabled" and "unchecked" regardless of its state. */
  function isDisabled(el) {
    if (el.disabled === true) return true;
    var a = el.getAttribute ? el.getAttribute("aria-disabled") : null;
    return a === "true";
  }
  function isChecked(el) {
    if (typeof el.checked === "boolean" && el.tagName === "INPUT") return el.checked;
    var a = el.getAttribute ? el.getAttribute("aria-checked") : null;
    if (a === "true") return true;
    if (a === "false") return false;
    return !!el.checked;
  }

  /** Every element this locator matches, using the SAME engine the capture
   *  script uses to decide whether a locator is unique (\`matchesFor\`).
   *
   *  This file used to carry its own resolver, and it disagreed with that one —
   *  and therefore with Playwright — in four ways at once: \`getByLabel\` and
   *  \`getByPlaceholder\` were EXACT here and substring there; \`getByText\` had
   *  no containment filter and was sorted by text length rather than document
   *  order, so it previewed a different element AND reported a wildly higher
   *  \`count\`; and \`getByTestId\`/\`getByRole\` walked every node in the
   *  document. Sharing the engine is what makes "the trainer agrees with the
   *  run" a property rather than a coincidence that has to be re-established
   *  every time either side is touched. */
  function resolveAll(loc) {
    if (!loc) return [];
    try {
      var found = matchesFor(loc);
      log(found.length ? "info" : "warn", locDesc(loc) + " → " + found.length + " match(es)");
      return found;
    } catch (e) {
      log("error", "resolve " + (loc.k || "?") + " threw: " + String(e));
      return [];
    }
  }

  /**
   * The ONE element a step acts on — or a refusal, on the same terms as the run.
   *
   * Two behaviours this did not have, both of which let the trainer act on
   * something the spec never would:
   *
   *  • \`nth\` was ignored ENTIRELY. A step recorded as "the 4th Save button"
   *    was previewed against the 1st, so the trainer's green tick was about a
   *    different element than the one the generated \`.nth(3)\` addresses.
   *  • An ambiguous locator silently took the first match. Playwright runs in
   *    STRICT MODE and refuses a locator matching two elements — it does not
   *    degrade to the first, it throws. So the single most common real failure
   *    ("resolved to 2 elements") was the one the trainer was structurally
   *    incapable of showing, and it could only be discovered on a run, against
   *    a page the user was no longer looking at.
   *
   * Returns \`{ el }\`, \`{ strict: n }\` for the violation, or \`{ el: null }\`.
   */
  function resolveOne(loc) {
    var all = resolveAll(loc);
    if (loc && typeof loc.nth === "number") {
      // -1 is "the last match", same as the emitted .nth(-1) — resolved off
      // the end so the trainer's preview and the run agree about which
      // element an ordinal step means.
      var picked = (loc.nth === -1 ? all[all.length - 1] : all[loc.nth]) || null;
      log(picked ? "info" : "warn", ".nth(" + loc.nth + ") of " + all.length + " match(es)" + (picked ? "" : " — index out of range"));
      return { el: picked };
    }
    if (all.length > 1) {
      log("error", "strict mode violation: " + locDesc(loc) + " resolved to " + all.length + " elements — a real run refuses this rather than taking the first. Refine the selector, or give it an index.");
      return { el: null, strict: all.length };
    }
    return { el: all.length ? all[0] : null };
  }

  /** The strict-mode refusal as a step error, or null when there was none. */
  function strictError(r) {
    return r.strict ? "Locator matched " + r.strict + " elements (strict mode violation)" : null;
  }

  /**
   * Playwright's "receives events" actionability check, as far as a page can
   * perform it: is the element at the click point actually this element?
   *
   * The trainer's click was a bare \`el.click()\`, which dispatches on the
   * element no matter what is drawn on top of it. A real run does not: it waits
   * for the element to receive pointer events and fails with "element
   * intercepts pointer events" when something covers it. Cookie banners, sticky
   * headers, toasts and modals are the everyday version of this, and a human
   * recording a test dismisses them by reflex without ever noticing they were
   * in the way — so the step passes in the trainer and fails at 3am.
   *
   * Reports WHAT is covering the element, because "the click failed" and "a
   * cookie banner is over the button" send you to completely different places.
   *
   * Returns null when it cannot tell. \`elementFromPoint\` is unimplemented in
   * jsdom and the point may legitimately be outside the viewport, and a check
   * that cannot see must not invent a failure.
   */
  /** Name the covering element the way a person would recognise it on screen.
   *  A bare tag name is not enough to find a full-page overlay in a strange
   *  site's markup; its id, class or visible text usually is. */
  function describeOccluder(el) {
    var tag = (el.tagName || "?").toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = el.className && typeof el.className === "string"
      ? "." + el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(".")
      : "";
    var label = txt(el).slice(0, 40);
    return tag + id + cls + (label ? " — \\"" + label + "\\"" : "");
  }

  function occludedBy(el) {
    try {
      if (typeof document.elementFromPoint !== "function") return null;
      var r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return null;
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
      var hit = document.elementFromPoint(cx, cy);
      if (!hit) return null;
      // A descendant receiving the click is the normal case — a <span> inside a
      // <button> — and the event still reaches the element. Only something
      // OUTSIDE the subtree is an interception.
      if (hit === el || el.contains(hit)) return null;
      // Nor is the element's own SHADOW HOST an interception, though
      // \`contains\` says it is: \`elementFromPoint\` stops at the host, so an
      // element inside an open shadow root is always "covered" by the
      // component it lives in. Reported literally, that turns every control in
      // a web component into a false occlusion — and on the pages where this
      // check earns its keep, the consent modal IS a shadow host, so the
      // warning would name the banner as covering its own Accept button.
      var host = el;
      for (var up = 0; up < 20 && host; up++) {
        var root = host.getRootNode ? host.getRootNode() : null;
        host = root && root.host ? root.host : null;
        if (!host) break;
        if (hit === host || host === el) return null;
      }
      return hit;
    } catch (e) {
      return null;
    }
  }

  function resolve(loc) { return resolveOne(loc).el; }

  function runAssert() {
    var a = step.assert;
    // Page-level kinds. Every one of these goes through the shared table, so
    // "URL contains" means here exactly what it means in the generated spec.
    // It did not: this read a case-insensitive SUBSTRING while the spec
    // asserted exact whole-URL equality against a pre-filled PATH, so the step
    // was green here and impossible to pass there.
    // Page-level kinds with an EMPTY expected value: the generator refuses to
    // emit these (an empty "contains" matches every page), so the preview must
    // refuse them too. matchesValue would answer true for an empty substring —
    // a green step standing in for a line that will never exist in the spec.
    if ((a === "url" || a === "urlEndsWith" || a === "urlIs" || a === "urlPathIs" || a === "title" || a === "titleContains") && !(step.value || "")) {
      log("error", "no expected value set on this assertion — nothing will be generated for it");
      return { ok: false, error: "No expected value set" };
    }
    if (a === "url" || a === "urlEndsWith" || a === "urlIs") {
      var ok = matchKind(ASSERT_SEMANTICS, a, location.href, step.value || "");
      log(ok ? "info" : "error", "page URL = \\"" + location.href + "\\"; expected " + (a === "urlEndsWith" ? "to end with" : a === "urlIs" ? "to be" : "to contain") + " \\"" + (step.value || "") + "\\"");
      return { ok: ok, error: ok ? undefined : "URL is " + location.href };
    }
    if (a === "urlPathIs") {
      // The SAME pattern the generated spec embeds in toHaveURL, applied to
      // the same string — the empty-value case is already refused above.
      var pathOk = new RegExp(urlPathPattern(step.value || ""), "i").test(location.href);
      log(pathOk ? "info" : "error", "page URL = \\"" + location.href + "\\"; expected its path to be \\"" + (step.value || "") + "\\" (query and #fragment ignored)");
      return { ok: pathOk, error: pathOk ? undefined : "URL is " + location.href };
    }
    // \`title\` is EXACT ("Page title is") and \`titleContains\` is the substring
    // kind. This used to read both as a case-insensitive substring, so "Cart"
    // passed against a page titled "Cart | Acme" and then failed every run.
    if (a === "title" || a === "titleContains") {
      var titleOk = matchKind(ASSERT_SEMANTICS, a, document.title, step.value || "");
      log(titleOk ? "info" : "error", "page title = \\"" + document.title + "\\"; expected " + (a === "title" ? "to be" : "to contain") + " \\"" + (step.value || "") + "\\"");
      return { ok: titleOk, error: titleOk ? undefined : "Title is " + document.title };
    }
    if (a === "count") {
      // No strict-mode check here on purpose: \`toHaveCount\` is the one matcher
      // whose whole job is to count many matches.
      var n = resolveAll(step.locator).length;
      var want = step.count || 0;
      var cOk = n === want;
      log(cOk ? "info" : "error", "count = " + n + "; expected " + want);
      return { ok: cOk, error: cOk ? undefined : "Found " + n + ", expected " + want };
    }
    var res = resolveOne(step.locator);
    var el = res.el;
    var strict = strictError(res);
    // An ambiguous locator fails the run whatever the assertion was, so it is
    // reported before the predicate rather than as "element not found" — those
    // need opposite fixes, and saying the wrong one costs the user the session.
    if (strict) return { ok: false, error: strict };
    if (a === "hidden") {
      var hidOk = !el || !visible(el);
      log(hidOk ? "info" : "error", "hidden: " + (el ? "element is " + (visible(el) ? "visible" : "not visible") : "no element"));
      return { ok: hidOk };
    }
    if (!el) { log("error", "Element not found for assert " + a); return { ok: false, error: "Element not found" }; }
    switch (a) {
      case "visible": {
        var vOk = visible(el);
        log(vOk ? "info" : "error", "visible: " + (vOk ? "yes" : "no (empty box, visibility:hidden, or display:none)"));
        return { ok: vOk };
      }
      case "text": {
        var got = txt(el).slice(0, 80);
        var tOk = matchKind(ASSERT_SEMANTICS, "text", txt(el), step.text || "");
        log(tOk ? "info" : "error", "text contains \\"" + (step.text || "") + "\\": " + (tOk ? "yes" : "no — got \\"" + got + "\\""));
        return { ok: tOk, error: tOk ? undefined : "Text is " + got };
      }
      case "exactText": {
        var egot = txt(el).slice(0, 80);
        var eOk = matchKind(ASSERT_SEMANTICS, "exactText", txt(el), step.text || "");
        log(eOk ? "info" : "error", "exact text \\"" + (step.text || "") + "\\": " + (eOk ? "yes" : "no — got \\"" + egot + "\\""));
        return { ok: eOk, error: eOk ? undefined : "Text is " + egot };
      }
      case "enabled": { var enOk = !isDisabled(el); log(enOk ? "info" : "error", "enabled: " + (enOk ? "yes" : "no")); return { ok: enOk }; }
      case "disabled": { var dOk = isDisabled(el); log(dOk ? "info" : "error", "disabled: " + (dOk ? "yes" : "no")); return { ok: dOk }; }
      case "checked": { var chOk = isChecked(el); log(chOk ? "info" : "error", "checked: " + (chOk ? "yes" : "no")); return { ok: chOk }; }
      case "unchecked": { var uOk = !isChecked(el); log(uOk ? "info" : "error", "unchecked: " + (uOk ? "yes" : "no")); return { ok: uOk }; }
      case "value": {
        var valOk = matchKind(ASSERT_SEMANTICS, "value", el.value || "", step.value || "");
        log(valOk ? "info" : "error", "value = \\"" + (el.value || "") + "\\"; expected \\"" + (step.value || "") + "\\"");
        return { ok: valOk, error: valOk ? undefined : "Value is " + (el.value || "") };
      }
      case "attribute": {
        var rawAttr = el.getAttribute(step.attr || "");
        // A MISSING attribute is not an attribute equal to "". Coercing the two
        // together made \`toHaveAttribute(name, "")\` pass here and fail in the
        // run, which is the whole class of bug this pass exists to remove.
        if (rawAttr === null) {
          log("error", "attr[" + (step.attr || "") + "] is not present on the element");
          return { ok: false, error: "Attribute " + (step.attr || "") + " is not present" };
        }
        var aOk = matchKind(ASSERT_SEMANTICS, "attribute", rawAttr, step.value || "");
        log(aOk ? "info" : "error", "attr[" + (step.attr || "") + "] = \\"" + rawAttr + "\\"; expected \\"" + (step.value || "") + "\\"");
        return { ok: aOk, error: aOk ? undefined : "Attribute is " + rawAttr };
      }
      case "css": {
        var prop = step.cssProp || "";
        if (!prop) { log("error", "no CSS property set on this assertion"); return { ok: false, error: "No CSS property set" }; }
        var cv = "";
        try { cv = String(getComputedStyle(el).getPropertyValue(prop) || "").trim(); } catch (e) { log("error", "getComputedStyle threw: " + String(e)); }
        var cExp = String(step.value == null ? "" : step.value);
        var contains = step.cssMatch === "contains";
        var cssOk = contains ? ci(cv).indexOf(ci(cExp)) >= 0 : cv === cExp;
        // An empty computed value almost always means the property NAME is
        // wrong rather than the style being absent — getPropertyValue answers
        // "" for an unknown or camelCase name instead of throwing. Saying so
        // here is the difference between a two-minute fix and a baffling
        // "expected rgb(0, 82, 204), got nothing".
        if (cv === "") log("warn", "computed " + prop + " is empty — check the property name is valid and kebab-case (background-color, not backgroundColor)");
        log(cssOk ? "info" : "error", prop + " = \\"" + cv + "\\"; expected " + (contains ? "to contain " : "") + "\\"" + cExp + "\\"");
        return { ok: cssOk, error: cssOk ? undefined : prop + " is " + (cv === "" ? "(empty)" : cv) };
      }
      default: return { ok: visible(el) };
    }
  }

  /** Evaluate a wait's predicate ONCE. Same predicates as evalCondition plus
   *  the three an \`if\` block has no counterpart for (text/value/count), and it
   *  reports WHY rather than logging — the poller below would otherwise write a
   *  line per attempt and bury the result. */
  function evalWaitUntil() {
    var w = step.waitUntil || "visible";
    if (w === "urlContains") {
      return { met: matchKind(WAIT_SEMANTICS, w, location.href, step.value || ""), detail: "URL is \\"" + location.href + "\\"" };
    }
    if (w === "titleContains") {
      return { met: matchKind(WAIT_SEMANTICS, w, document.title, step.value || ""), detail: "title is \\"" + document.title + "\\"" };
    }
    if (w === "exists") {
      var n0 = resolveAll(step.locator).length;
      return { met: n0 > 0, detail: n0 + " match(es)" };
    }
    if (w === "count") {
      var n = resolveAll(step.locator).length;
      return { met: n === (step.count || 0), detail: "count is " + n + ", expected " + (step.count || 0) };
    }
    var wres = resolveOne(step.locator);
    var el = wres.el;
    // A wait can never come true through an ambiguous locator — the run would
    // refuse it on the first attempt — so it is reported rather than polled to
    // the timeout with a misleading "element not found".
    if (wres.strict) return { met: false, detail: strictError(wres), fatal: true };
    if (w === "hidden") {
      return { met: !el || !visible(el), detail: el ? "element is visible" : "no element" };
    }
    if (!el) return { met: false, detail: "element not found" };
    switch (w) {
      case "enabled": return { met: !isDisabled(el), detail: isDisabled(el) ? "element is disabled" : "element is enabled" };
      case "disabled": return { met: isDisabled(el), detail: isDisabled(el) ? "element is disabled" : "element is enabled" };
      case "checked": return { met: isChecked(el), detail: isChecked(el) ? "checked" : "not checked" };
      case "unchecked": return { met: !isChecked(el), detail: isChecked(el) ? "checked" : "not checked" };
      case "text": return { met: matchKind(WAIT_SEMANTICS, "text", txt(el), step.text || ""), detail: "text is \\"" + txt(el).slice(0, 80) + "\\"" };
      case "value": return { met: matchKind(WAIT_SEMANTICS, "value", el.value || "", step.value || ""), detail: "value is \\"" + (el.value || "") + "\\"" };
      case "visible":
      default: return { met: visible(el), detail: visible(el) ? "element is visible" : "element is not visible" };
    }
  }

  /** Poll the predicate until it holds or the budget runs out.
   *
   *  Capped at PREVIEW_WAIT_CAP_MS regardless of the step's own timeout, for
   *  the same reason the fixed-duration wait is capped: this runs inside the
   *  trainer, and a step configured to wait five minutes would look like the
   *  app had frozen. A real run honours the full timeout — the preview says so
   *  in its log when it gives up early. */
  function runWaitUntil() {
    var budget = Math.min(step.timeoutMs == null ? ${DEFAULT_WAIT_TIMEOUT_MS} : step.timeoutMs, ${PREVIEW_WAIT_CAP_MS});
    var capped = (step.timeoutMs == null ? ${DEFAULT_WAIT_TIMEOUT_MS} : step.timeoutMs) > ${PREVIEW_WAIT_CAP_MS};
    var started = Date.now();
    log("info", "waiting until " + (step.waitUntil || "visible") + " (up to " + budget + "ms" + (capped ? ", capped for preview" : "") + ")");
    var first = evalWaitUntil();
    if (first.met) {
      log("info", "condition already met (" + first.detail + ")");
      return { ok: true };
    }
    // A strict-mode violation cannot become untrue by waiting, and polling it
    // to the cap would report a timeout — which reads as "the page was slow"
    // and sends the user to fix the wrong thing.
    if (first.fatal) {
      log("error", first.detail);
      return { ok: false, error: first.detail };
    }
    return new Promise(function (res) {
      var timer = setInterval(function () {
        var r = evalWaitUntil();
        var waited = Date.now() - started;
        if (r.fatal) {
          clearInterval(timer);
          log("error", r.detail);
          res({ ok: false, error: r.detail });
          return;
        }
        if (r.met) {
          clearInterval(timer);
          log("info", "condition met after " + waited + "ms (" + r.detail + ")");
          res({ ok: true });
          return;
        }
        if (waited >= budget) {
          clearInterval(timer);
          var msg = "Timed out after " + waited + "ms waiting until " + (step.waitUntil || "visible") + " — " + r.detail;
          log("error", msg + (capped ? " (preview cap; a real run would wait longer)" : ""));
          res({ ok: false, error: msg });
        }
      }, ${PREVIEW_WAIT_POLL_MS});
    });
  }

  function evalCondition() {
    var c = step.cond || "visible";
    if (c === "urlContains") {
      var uMet = matchKind(WAIT_SEMANTICS, c, location.href, step.value || "");
      log("info", "condition: URL \\"" + location.href + "\\" contains \\"" + (step.value || "") + "\\" → " + uMet);
      return uMet;
    }
    if (c === "titleContains") {
      var tiMet = matchKind(WAIT_SEMANTICS, c, document.title, step.value || "");
      log("info", "condition: title \\"" + document.title + "\\" contains \\"" + (step.value || "") + "\\" → " + tiMet);
      return tiMet;
    }
    if (c === "exists") {
      var n = resolveAll(step.locator).length;
      log("info", "condition: exists → " + n + " match(es) → " + (n > 0));
      return n > 0;
    }
    var cres = resolveOne(step.locator);
    var el = cres.el;
    // A branch taken on an ambiguous locator is a branch the run never takes —
    // it throws instead. Reported here rather than silently resolving false,
    // because a conditional that quietly skips its body looks like the page
    // simply not being in that state.
    if (cres.strict) {
      log("error", "condition: " + strictError(cres) + " — the run would fail here rather than choose a branch");
      return false;
    }
    var met;
    switch (c) {
      case "hidden": met = !el || !visible(el); break;
      case "enabled": met = !!el && !isDisabled(el); break;
      case "disabled": met = !!el && isDisabled(el); break;
      case "checked": met = !!el && isChecked(el); break;
      case "unchecked": met = !!el && !isChecked(el); break;
      case "visible":
      default: met = !!el && visible(el); break;
    }
    log("info", "condition: " + c + " → " + met + (el ? "" : " (element not found)"));
    return met;
  }

  function run() {
    var t = step.type;
    if (step.disabled) {
      log("info", "Step " + (step.index_ ?? "") + " skipped — disabled");
      return { ok: true, error: "Skipped — disabled" };
    }
    // A step whose element is inside an iframe cannot be previewed here: this
    // script runs in the TOP document, matchesFor scans only it, and resolving
    // a framed locator against the top document would act on the wrong element
    // (or none) while reporting a verdict. Refuse OUT LOUD — the run resolves
    // it through frameLocator, which the trainer's injected world has no
    // equivalent for. NO BACKTICKS in this comment: it lives inside the
    // buildReplayScript template literal. See docs/IFRAMES.md.
    if (
      (step.locator && step.locator.frame && step.locator.frame.length) ||
      (step.toLocator && step.toLocator.frame && step.toLocator.frame.length)
    ) {
      var msg = "This step is inside an iframe — the trainer cannot preview it (the run resolves it through frameLocator). Use Run test to check it.";
      log("warn", msg);
      return { ok: false, error: msg };
    }
    if (t === "if") {
      var met = evalCondition();
      log("info", met ? "block WILL run" : "block will be SKIPPED");
      return { ok: true, met: met };
    }
    if (t === "endif") { log("info", "end of conditional block"); return { ok: true }; }
    if (t === "else") { log("info", "else branch — runs when the condition above did not hold"); return { ok: true }; }
    // The preview walks the list ONCE, so a loop's body runs a single time
    // here. Said out loud rather than silently: a user watching the preview
    // add one item while the run adds five would otherwise read the run as
    // broken.
    if (t === "loop") {
      log("info", "repeat ×" + (step.loopCount || 1) + " — the preview runs the body once; the real run repeats it");
      return { ok: true };
    }
    if (t === "endLoop") { log("info", "end of repeat block"); return { ok: true }; }
    if (t === "group" || t === "endGroup") { log("info", "group marker - organization only, nothing runs"); return { ok: true }; }
    // Same honesty rule as download/a11y: the divider's whole meaning is what
    // happens AFTER a failure, and the trainer replays a step at a time with
    // no failed run to recover from. A green row here must not read as "the
    // teardown was proved to run".
    if (t === "teardown") { log("info", "teardown divider - on a RUN everything below still runs after a failure; the preview just replays in order"); return { ok: true }; }
    // The preview cannot receive a download event — transfers are cancelled
    // during recording on purpose. Said out loud so a green row here is never
    // read as "the download was verified"; the RUN is what verifies it.
    if (t === "upload") {
      log("info", "file uploads run on RUNS - the preview does not touch the input");
      return { ok: true };
    }
    if (t === "api") {
      log("info", "API request steps run on RUNS - the preview does not send requests");
      return { ok: true };
    }
    if (t === "aiCheck") {
      log("info", "AI checks are evaluated after RUNS by your configured model - the preview does not judge");
      return { ok: true };
    }
    if (t === "dialog") {
      log("info", "dialog handling arms on RUNS - in the trainer, answer the dialog yourself");
      return { ok: true };
    }
    if (t === "download") {
      log("info", "download expectations are verified on runs — the training browser cancels transfers");
      return { ok: true };
    }
    // Same honesty rule as download: the preview does not carry axe, so a
    // green row must never read as "accessibility was checked".
    if (t === "a11y") {
      log("info", "accessibility gates run on RUNS — the preview does not check");
      return { ok: true };
    }
    if (t === "goto") { log("info", "goto runs at test start; skipped in preview"); return { ok: true, error: "goto runs at test start; skipped in preview" }; }
    // Unreachable in the trainer: runStep dispatches viewport steps to
    // resize-service, which resizes the native window (a page cannot resize the
    // window it is loaded in). Kept as a truthful fallback rather than deleted,
    // so a future caller that bypasses that dispatch gets a clear reason
    // instead of "Element not found" from the resolver below.
    if (t === "viewport") { log("info", "a resize is applied to the window, not from the page"); return { ok: true, error: "a resize is applied to the window, not from the page" }; }
    if (t === "scroll") {
      // Element mode mirrors the emitted scrollIntoViewIfNeeded, strict-mode
      // included — a multi-match locator fails the run's scroll, so it must
      // fail here too rather than scrolling to whichever matched first.
      if (step.locator) {
        var scRes = resolveOne(step.locator);
        var scStrict = strictError(scRes);
        if (scStrict) return { ok: false, error: scStrict };
        if (!scRes.el) { log("error", "Element not found — cannot scroll to it"); return { ok: false, error: "Element not found" }; }
        try { scRes.el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
        log("info", "scrolled the element into view");
        return { ok: true };
      }
      // Position mode: one jump rather than the run's incremental walk. The
      // preview page is live and already lazily-loaded as far as the user
      // scrolled it, so the jump lands where the run's walk would.
      var scX = typeof step.scrollX === "number" ? step.scrollX : 0;
      var scY = typeof step.scrollY === "number" ? step.scrollY : 0;
      try { window.scrollTo(scX, scY); } catch (e) {}
      log("info", "scrolled to (" + scX + ", " + scY + ") — page is at (" + Math.round(window.scrollX || 0) + ", " + Math.round(window.scrollY || 0) + ")");
      return { ok: true };
    }
    if (t === "state") {
      var es = step.elementState || "hover";
      // press/release carry no locator: page.mouse.down acts wherever the
      // cursor already is. The button event itself is sent natively by
      // input-service — a page cannot press its own mouse button any more than
      // it can resize its own window.
      if (es === "press" || es === "release") { log("info", es + " is dispatched to the window, not from the page"); return { ok: true }; }
      var sEl = resolve(step.locator);
      if (!sEl) { log("error", "Element not found for state " + es); return { ok: false, error: "Element not found" }; }
      if (es === "focus") {
        try { sEl.focus(); } catch (e) { log("error", "focus threw: " + String(e)); return { ok: false, error: "focus failed" }; }
        var focused = document.activeElement === sEl;
        log(focused ? "info" : "warn", focused ? "element focused" : "focus() ran but the element did not take focus (is it focusable?)");
        return { ok: true };
      }
      // hover: report WHERE, and let the backend move the real cursor there.
      // A synthetic mouseover would fire the page's JS handlers but would not
      // apply :hover CSS at all — the browser drives that off the actual
      // pointer position — so dispatching one here would make a hover preview
      // that looks like it worked and proves nothing.
      try { sEl.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      var sr = sEl.getBoundingClientRect();
      if (!(sr.width > 0 || sr.height > 0)) { log("error", "element has no size to hover"); return { ok: false, error: "Element has no size" }; }
      var pt = { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 };
      log("info", "hover target at (" + Math.round(pt.x) + ", " + Math.round(pt.y) + ")");
      return { ok: true, point: pt };
    }
    if (t === "wait") {
      if (step.waitUntil) return runWaitUntil();
      if (typeof step.waitMs === "number") {
        log("info", "waiting " + step.waitMs + "ms (capped at 5000)");
        return new Promise(function (res) {
          setTimeout(function () { log("info", "wait complete"); res({ ok: true }); }, Math.min(step.waitMs, 5000));
        });
      }
      var wEl = resolve(step.locator);
      if (wEl) { log("info", "wait-for-element resolved"); return { ok: true }; }
      log("error", "Element not found for wait");
      return { ok: false, error: "Element not found for wait" };
    }
    if (t === "assert") return runAssert();
    // A flow's steps are inlined into the generated spec, so there is nothing
    // to run for the call itself — same shape as goto/viewport.
    if (t === "runFlow") { log("info", "flow steps run inline at test time; not previewable"); return { ok: true, error: "flow steps run inline at test time; not previewable" }; }
    if (t === "capture") {
      var from = step.captureFrom || "text";
      if (from === "url") { log("info", "captured URL"); return { ok: true, captured: location.href }; }
      if (from === "title") { log("info", "captured title"); return { ok: true, captured: document.title }; }
      // Count deliberately bypasses the unique resolve below: counting an
      // ambiguous or absent locator is the whole point, and 0 is an answer.
      if (from === "count") {
        var cAll = resolveAll(step.locator);
        log("info", "captured " + (step.captureVar || "?") + " = " + cAll.length + " match(es)");
        return { ok: true, captured: String(cAll.length) };
      }
      var cEl = resolve(step.locator);
      if (!cEl) { log("error", "Element not found — cannot capture"); return { ok: false, error: "Element not found" }; }
      var got = "";
      if (from === "value") got = cEl.value == null ? "" : String(cEl.value);
      else if (from === "attribute") got = cEl.getAttribute ? (cEl.getAttribute(step.captureAttr || "") || "") : "";
      else got = (cEl.textContent || "").trim();
      log("info", "captured " + (step.captureVar || "?") + " = \\"" + got + "\\"");
      return { ok: true, captured: got };
    }

    var ares = resolveOne(step.locator);
    var el = ares.el;
    var aStrict = strictError(ares);
    if (aStrict) return { ok: false, error: aStrict };
    if (!el) { log("error", "Element not found — cannot " + t); return { ok: false, error: "Element not found" }; }
    log("info", "Resolved to <" + (el.tagName || "").toLowerCase() + ">" + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : ""));
    try {
      if (t === "click") {
        try { el.scrollIntoView({ block: "center" }); } catch (e) {}
        // Checked AFTER scrolling into view, because that is the order a real
        // run does it in — an element below the fold is not occluded, it is
        // just not scrolled to yet.
        var over = occludedBy(el);
        if (over) {
          var what = describeOccluder(over);
          // A force click skips this check on RUNS ({ force: true }), so the
          // preview must skip it too — failing here while the run passes is the
          // pessimistic lie, and this step opted out of the check on purpose.
          if (step.force === true) {
            log("info", "another element (" + what + ") is on top — ignored, this click has Ignore Actionability (force)");
          } else {
            log("error", "another element (" + what + ") is on top of this one — a real run fails here with \\"element intercepts pointer events\\"");
            return { ok: false, error: "Element is covered by " + what };
          }
        }
        el.click();
        log("info", "clicked");
        return { ok: true };
      }
      if (t === "fill") {
        var fillValue = step.value || "";
        // Per-character mode has to be previewed per character, or the preview
        // is green for a reason the run will not reproduce: the WHOLE point of
        // the mode is that the page sees a keydown/keypress/input/keyup for
        // every character, and a page with real keyboard handling behaves
        // differently under one bulk assignment. The trainer agreeing with the
        // run about what a step MEANS is the property this app keeps having to
        // re-establish; a shortcut here would break it in a new place.
        //
        // It does NOT clear the field first, exactly like the emitted
        // pressSequentially. See TypeMode in main/recorder/types.ts.
        if (step.typeMode === "sequential") {
          el.focus();
          for (var ci = 0; ci < fillValue.length; ci++) {
            var ch = fillValue.charAt(ci);
            el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
            try { el.value = (el.value == null ? "" : el.value) + ch; } catch (e) {}
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
          }
          el.dispatchEvent(new Event("change", { bubbles: true }));
          log("info", "typed " + fillValue.length + " character(s) one by one (appended — this mode does not clear the field)");
          return { ok: true };
        }
        el.focus();
        try { el.value = fillValue; } catch (e) {}
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        log("info", "filled value=\\"" + fillValue + "\\"");
        return { ok: true };
      }
      if (t === "select") {
        // Playwright's \`selectOption\` THROWS when no option matches. Assigning
        // to \`.value\` does not: it silently sets selectedIndex to -1 and the
        // step reported success, so a select whose options had been renamed
        // previewed green and failed every run. Checked explicitly, because the
        // assignment cannot be made to fail.
        var want = step.value || "";
        var opts = el.options ? Array.prototype.slice.call(el.options) : [];
        var hit = null;
        for (var oi = 0; oi < opts.length; oi++) {
          if (opts[oi].value === want || txt(opts[oi]) === want) { hit = opts[oi]; break; }
        }
        if (!hit) {
          var names = opts.map(function (o) { return o.value; }).slice(0, 8).join(", ");
          log("error", "no option matches \\"" + want + "\\" — the element offers: " + (names || "(none)"));
          return { ok: false, error: "No option matching \\"" + want + "\\"" };
        }
        try { el.value = hit.value; } catch (e) {}
        el.dispatchEvent(new Event("change", { bubbles: true }));
        log("info", "selected value=\\"" + hit.value + "\\"");
        return { ok: true };
      }
      if (t === "dblclick") {
        try { el.scrollIntoView({ block: "center" }); } catch (e) {}
        // Both events, in the order a browser sends them. A page that listens
        // for click twice and a page that listens for dblclick are both
        // real, and a preview that fired only one of them would be green for a
        // page the run treats differently.
        el.click();
        el.click();
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
        log("info", "double-clicked");
        return { ok: true };
      }
      if (t === "rightclick") {
        try { el.scrollIntoView({ block: "center" }); } catch (e) {}
        // contextmenu is what a right-click DOES to a page; the button-2
        // mousedown/mouseup around it are what a page watching for the raw
        // buttons sees. Playwright sends all three, so the preview does too.
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 2 }));
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
        log("info", "right-clicked");
        return { ok: true };
      }
      if (t === "drag") {
        // BOTH ends are resolved, strict-mode included. A drag that resolved
        // only its source would report success for half a step, and the half it
        // skipped is the one that decides where the thing lands.
        var dRes = resolveOne(step.toLocator);
        var dStrict = strictError(dRes);
        if (dStrict) { log("error", "drop target: " + dStrict); return { ok: false, error: dStrict }; }
        if (!dRes.el) { log("error", "Drop target not found"); return { ok: false, error: "Drop target not found" }; }
        var dTo = dRes.el;
        try { el.scrollIntoView({ block: "center" }); } catch (e) {}
        // HTML5 drag events AND pointer events, because applications use one or
        // the other and nothing in the DOM says which. Playwright's dragTo
        // sends the pointer sequence; a page built on the HTML5 API needs the
        // drag events, and sending both is what makes the preview agree with
        // the run on more pages than either alone would.
        var dt = null;
        try { dt = new DataTransfer(); } catch (e) {}
        var opts = function (extra) {
          var o = { bubbles: true, cancelable: true };
          if (dt) o.dataTransfer = dt;
          for (var k in extra) o[k] = extra[k];
          return o;
        };
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        try { el.dispatchEvent(new DragEvent("dragstart", opts({}))); } catch (e) {}
        try { dTo.dispatchEvent(new DragEvent("dragover", opts({}))); } catch (e) {}
        dTo.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
        try { dTo.dispatchEvent(new DragEvent("drop", opts({}))); } catch (e) {}
        dTo.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        try { el.dispatchEvent(new DragEvent("dragend", opts({}))); } catch (e) {}
        log("info", "dragged onto <" + (dTo.tagName || "").toLowerCase() + ">");
        return { ok: true };
      }
      if (t === "check") { if (!el.checked) { el.click(); log("info", "checked"); } else log("info", "already checked"); return { ok: true }; }
      if (t === "uncheck") { if (el.checked) { el.click(); log("info", "unchecked"); } else log("info", "already unchecked"); return { ok: true }; }
      if (t === "press") {
        var key = step.value || "Enter";
        el.focus();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true }));
        log("info", "pressed key \\"" + key + "\\"");
        return { ok: true };
      }
    } catch (e) { log("error", t + " threw: " + String(e)); return { ok: false, error: String(e) }; }
    log("error", "Unsupported step type: " + t);
    return { ok: false, error: "Unsupported step: " + t };
  }

  try {
    var r = run();
    // Attach logs whether run() returns a value or a promise.
    if (r && typeof r.then === "function") {
      return r.then(function (rr) { rr.logs = logs; return rr; });
    }
    r.logs = logs;
    return r;
  } catch (e) {
    log("error", "run() threw: " + String(e));
    return { ok: false, error: String(e), logs: logs };
  }
})()`;
}
