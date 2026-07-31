// Builds an injected JS snippet that previews a single recorded step in the live
// recorder window: it resolves the step's locator against the current DOM and
// performs the action (or evaluates the assertion), returning { ok, error? }.
//
// This is a best-effort, synthetic-event PREVIEW — not Playwright's actionability
// engine — so results can differ from a real `runner:run`. It reuses the shared
// DOM_HELPERS (roleOf/accName/txt/cssEscape…) so locator semantics stay aligned
// with the capture script.

import { DOM_HELPERS } from "../recorder/capture-script.js";
import type { Step } from "../recorder/types.js";

export function buildReplayScript(step: Step): string {
  // NOTE: no backticks or ${...} inside the JS body below except the two
  // interpolations here. `\\s` produces a literal \s in the emitted script.
  return `(function () {
  ${DOM_HELPERS}

  var step = ${JSON.stringify(step)};

  function ci(s) { return String(s == null ? "" : s).toLowerCase(); }
  function norm(s) { return String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); }

  function visible(el) {
    if (!el) return false;
    try {
      var r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return false;
      var st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") return false;
    } catch (e) {}
    return true;
  }

  function resolveAll(loc) {
    if (!loc) return [];
    var k = loc.k, v = loc.v || "";
    try {
      if (k === "css") return Array.prototype.slice.call(document.querySelectorAll(v));
      if (k === "xpath") {
        var out = [];
        var r = document.evaluate(v, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (var i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
        return out;
      }
      if (k === "testid") {
        return Array.prototype.slice.call(document.querySelectorAll("*")).filter(function (el) {
          var t = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
          return t === v;
        });
      }
      if (k === "placeholder") {
        return Array.prototype.slice.call(document.querySelectorAll("input,textarea")).filter(function (el) {
          return (el.getAttribute("placeholder") || "") === v;
        });
      }
      if (k === "label") {
        return Array.prototype.slice.call(document.querySelectorAll("input,textarea,select")).filter(function (el) {
          return labelFor(el) === v;
        });
      }
      if (k === "role") {
        var role = loc.role || "";
        var name = loc.name;
        return Array.prototype.slice.call(document.querySelectorAll("*")).filter(function (el) {
          if (roleOf(el) !== role) return false;
          if (name == null || name === "") return true;
          return ci(accName(el)).indexOf(ci(name)) >= 0;
        });
      }
      if (k === "text") {
        var all = Array.prototype.slice.call(document.querySelectorAll("body *"));
        var matches = all.filter(function (el) { return ci(txt(el)).indexOf(ci(v)) >= 0; });
        matches.sort(function (a, b) { return txt(a).length - txt(b).length; });
        return matches;
      }
    } catch (e) {}
    return [];
  }

  function resolve(loc) { var a = resolveAll(loc); return a.length ? a[0] : null; }

  function runAssert() {
    var a = step.assert;
    if (a === "url") return { ok: ci(location.href).indexOf(ci(step.value || "")) >= 0, error: "URL is " + location.href };
    if (a === "title") return { ok: ci(document.title).indexOf(ci(step.value || "")) >= 0, error: "Title is " + document.title };
    if (a === "count") {
      var n = resolveAll(step.locator).length;
      var want = step.count || 0;
      return { ok: n === want, error: "Found " + n + ", expected " + want };
    }
    var el = resolve(step.locator);
    if (a === "hidden") return { ok: !el || !visible(el) };
    if (!el) return { ok: false, error: "Element not found" };
    switch (a) {
      case "visible": return { ok: visible(el) };
      case "text": return { ok: ci(txt(el)).indexOf(ci(step.text || "")) >= 0, error: "Text is " + txt(el).slice(0, 80) };
      case "exactText": return { ok: norm(txt(el)) === norm(step.text || ""), error: "Text is " + txt(el).slice(0, 80) };
      case "enabled": return { ok: !el.disabled };
      case "disabled": return { ok: !!el.disabled };
      case "checked": return { ok: !!el.checked };
      case "unchecked": return { ok: !el.checked };
      case "value": return { ok: (el.value || "") === (step.value || ""), error: "Value is " + (el.value || "") };
      case "attribute": return { ok: (el.getAttribute(step.attr || "") || "") === (step.value || ""), error: "Attribute is " + (el.getAttribute(step.attr || "") || "") };
      default: return { ok: visible(el) };
    }
  }

  function run() {
    var t = step.type;
    if (t === "goto") return { ok: true, error: "goto runs at test start; skipped in preview" };
    if (t === "viewport") return { ok: true, error: "viewport is applied at run time; not previewable" };
    if (t === "wait") {
      if (typeof step.waitMs === "number") {
        return new Promise(function (res) {
          setTimeout(function () { res({ ok: true }); }, Math.min(step.waitMs, 5000));
        });
      }
      return resolve(step.locator) ? { ok: true } : { ok: false, error: "Element not found for wait" };
    }
    if (t === "assert") return runAssert();

    var el = resolve(step.locator);
    if (!el) return { ok: false, error: "Element not found" };
    try {
      if (t === "click") { try { el.scrollIntoView({ block: "center" }); } catch (e) {} el.click(); return { ok: true }; }
      if (t === "fill") {
        el.focus();
        try { el.value = step.value || ""; } catch (e) {}
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (t === "select") {
        try { el.value = step.value || ""; } catch (e) {}
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (t === "check") { if (!el.checked) el.click(); return { ok: true }; }
      if (t === "uncheck") { if (el.checked) el.click(); return { ok: true }; }
      if (t === "press") {
        var key = step.value || "Enter";
        el.focus();
        el.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: key, bubbles: true }));
        return { ok: true };
      }
    } catch (e) { return { ok: false, error: String(e) }; }
    return { ok: false, error: "Unsupported step: " + t };
  }

  try { return run(); } catch (e) { return { ok: false, error: String(e) }; }
})()`;
}
