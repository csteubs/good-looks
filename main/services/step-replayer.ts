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

import { DOM_HELPERS } from "../recorder/capture-script.js";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./script-generator.js";
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
  logs: DebugLogLine[];
}

export function buildReplayScript(step: Step): string {
  // NOTE: no backticks inside the JS body below; the only ${...} are the
  // deliberate interpolations (DOM_HELPERS, the step JSON, and the three wait
  // constants). `\\s` produces a literal \s in the emitted script.
  return `(function () {
  ${DOM_HELPERS}

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
    if (step.assert === "url" || step.assert === "urlEndsWith" || step.assert === "urlIs" || step.assert === "title") log("info", "Expect " + step.assert + " contains: " + (step.value || ""));
    else if (step.assert === "count") log("info", "Expect count = " + step.count);
    else if (step.assert === "value" || step.assert === "attribute") log("info", "Expect " + step.assert + " = " + (step.value || ""));
    else if (step.assert === "text" || step.assert === "exactText") log("info", "Expect text: " + (step.text || ""));
    else log("info", "Expect " + step.assert);
  }

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
      if (k === "css") {
        var list = Array.prototype.slice.call(document.querySelectorAll(v));
        log(list.length ? "info" : "warn", "css querySelectorAll(\\"" + v + "\\") → " + list.length + " match(es)");
        return list;
      }
      if (k === "xpath") {
        var out = [];
        var r = document.evaluate(v, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        for (var i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
        log(out.length ? "info" : "warn", "xpath \\"" + v + "\\" → " + out.length + " match(es)");
        return out;
      }
      if (k === "testid") {
        var tid = Array.prototype.slice.call(document.querySelectorAll("*")).filter(function (el) {
          var t = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test");
          return t === v;
        });
        log(tid.length ? "info" : "warn", "data-testid=\\"" + v + "\\" → " + tid.length + " match(es)");
        return tid;
      }
      if (k === "placeholder") {
        var ph = Array.prototype.slice.call(document.querySelectorAll("input,textarea")).filter(function (el) {
          return (el.getAttribute("placeholder") || "") === v;
        });
        log(ph.length ? "info" : "warn", "placeholder=\\"" + v + "\\" → " + ph.length + " match(es)");
        return ph;
      }
      if (k === "label") {
        var lb = Array.prototype.slice.call(document.querySelectorAll("input,textarea,select")).filter(function (el) {
          return labelFor(el) === v;
        });
        log(lb.length ? "info" : "warn", "label=\\"" + v + "\\" → " + lb.length + " match(es)");
        return lb;
      }
      if (k === "role") {
        var role = loc.role || "";
        var name = loc.name;
        var rb = Array.prototype.slice.call(document.querySelectorAll("*")).filter(function (el) {
          if (roleOf(el) !== role) return false;
          if (name == null || name === "") return true;
          return ci(accName(el)).indexOf(ci(name)) >= 0;
        });
        log(rb.length ? "info" : "warn", "role=" + role + (name ? " name~\\"" + name + "\\"" : "") + " → " + rb.length + " match(es)");
        return rb;
      }
      if (k === "text") {
        var all = Array.prototype.slice.call(document.querySelectorAll("body *"));
        var matches = all.filter(function (el) { return ci(txt(el)).indexOf(ci(v)) >= 0; });
        matches.sort(function (a, b) { return txt(a).length - txt(b).length; });
        log(matches.length ? "info" : "warn", "text~\\"" + v + "\\" → " + matches.length + " match(es)");
        return matches;
      }
    } catch (e) { log("error", "resolve " + k + " threw: " + String(e)); }
    return [];
  }

  function resolve(loc) { var a = resolveAll(loc); return a.length ? a[0] : null; }

  function runAssert() {
    var a = step.assert;
    if (a === "url" || a === "urlEndsWith" || a === "urlIs") {
      var cur = ci(location.href);
      var exp = ci(step.value || "");
      var ok;
      if (a === "urlEndsWith") ok = cur.slice(-exp.length) === exp;
      else if (a === "urlIs") ok = cur === exp;
      else ok = cur.indexOf(exp) >= 0;
      log(ok ? "info" : "error", "page URL = \\"" + location.href + "\\"; expected " + (a === "urlEndsWith" ? "to end with" : a === "urlIs" ? "to be" : "to contain") + " \\"" + (step.value || "") + "\\"");
      return { ok: ok, error: ok ? undefined : "URL is " + location.href };
    }
    if (a === "title") {
      var titleOk = ci(document.title).indexOf(ci(step.value || "")) >= 0;
      log(titleOk ? "info" : "error", "page title = \\"" + document.title + "\\"; expected to contain \\"" + (step.value || "") + "\\"");
      return { ok: titleOk, error: titleOk ? undefined : "Title is " + document.title };
    }
    if (a === "count") {
      var n = resolveAll(step.locator).length;
      var want = step.count || 0;
      var cOk = n === want;
      log(cOk ? "info" : "error", "count = " + n + "; expected " + want);
      return { ok: cOk, error: cOk ? undefined : "Found " + n + ", expected " + want };
    }
    var el = resolve(step.locator);
    if (a === "hidden") {
      var hidOk = !el || !visible(el);
      log(hidOk ? "info" : "error", "hidden: " + (el ? "element is " + (visible(el) ? "visible" : "not visible") : "no element"));
      return { ok: hidOk };
    }
    if (!el) { log("error", "Element not found for assert " + a); return { ok: false, error: "Element not found" }; }
    switch (a) {
      case "visible": {
        var vOk = visible(el);
        log(vOk ? "info" : "error", "visible: " + (vOk ? "yes" : "no (zero-size, hidden, or opacity 0)"));
        return { ok: vOk };
      }
      case "text": {
        var got = txt(el).slice(0, 80);
        var tOk = ci(txt(el)).indexOf(ci(step.text || "")) >= 0;
        log(tOk ? "info" : "error", "text contains \\"" + (step.text || "") + "\\": " + (tOk ? "yes" : "no — got \\"" + got + "\\""));
        return { ok: tOk, error: tOk ? undefined : "Text is " + got };
      }
      case "exactText": {
        var egot = txt(el).slice(0, 80);
        var eOk = norm(txt(el)) === norm(step.text || "");
        log(eOk ? "info" : "error", "exact text \\"" + (step.text || "") + "\\": " + (eOk ? "yes" : "no — got \\"" + egot + "\\""));
        return { ok: eOk, error: eOk ? undefined : "Text is " + egot };
      }
      case "enabled": { var enOk = !el.disabled; log(enOk ? "info" : "error", "enabled: " + (enOk ? "yes" : "no")); return { ok: enOk }; }
      case "disabled": { var dOk = !!el.disabled; log(dOk ? "info" : "error", "disabled: " + (dOk ? "yes" : "no")); return { ok: dOk }; }
      case "checked": { var chOk = !!el.checked; log(chOk ? "info" : "error", "checked: " + (chOk ? "yes" : "no")); return { ok: chOk }; }
      case "unchecked": { var uOk = !el.checked; log(uOk ? "info" : "error", "unchecked: " + (uOk ? "yes" : "no")); return { ok: uOk }; }
      case "value": {
        var valOk = (el.value || "") === (step.value || "");
        log(valOk ? "info" : "error", "value = \\"" + (el.value || "") + "\\"; expected \\"" + (step.value || "") + "\\"");
        return { ok: valOk, error: valOk ? undefined : "Value is " + (el.value || "") };
      }
      case "attribute": {
        var av = el.getAttribute(step.attr || "") || "";
        var aOk = av === (step.value || "");
        log(aOk ? "info" : "error", "attr[" + (step.attr || "") + "] = \\"" + av + "\\"; expected \\"" + (step.value || "") + "\\"");
        return { ok: aOk, error: aOk ? undefined : "Attribute is " + av };
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
      return { met: ci(location.href).indexOf(ci(step.value || "")) >= 0, detail: "URL is \\"" + location.href + "\\"" };
    }
    if (w === "titleContains") {
      return { met: ci(document.title).indexOf(ci(step.value || "")) >= 0, detail: "title is \\"" + document.title + "\\"" };
    }
    if (w === "exists") {
      var n0 = resolveAll(step.locator).length;
      return { met: n0 > 0, detail: n0 + " match(es)" };
    }
    if (w === "count") {
      var n = resolveAll(step.locator).length;
      return { met: n === (step.count || 0), detail: "count is " + n + ", expected " + (step.count || 0) };
    }
    var el = resolve(step.locator);
    if (w === "hidden") {
      return { met: !el || !visible(el), detail: el ? "element is visible" : "no element" };
    }
    if (!el) return { met: false, detail: "element not found" };
    switch (w) {
      case "enabled": return { met: !el.disabled, detail: el.disabled ? "element is disabled" : "element is enabled" };
      case "disabled": return { met: !!el.disabled, detail: el.disabled ? "element is disabled" : "element is enabled" };
      case "checked": return { met: !!el.checked, detail: el.checked ? "checked" : "not checked" };
      case "unchecked": return { met: !el.checked, detail: el.checked ? "checked" : "not checked" };
      case "text": return { met: ci(txt(el)).indexOf(ci(step.text || "")) >= 0, detail: "text is \\"" + txt(el).slice(0, 80) + "\\"" };
      case "value": return { met: (el.value || "") === (step.value || ""), detail: "value is \\"" + (el.value || "") + "\\"" };
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
    return new Promise(function (res) {
      var timer = setInterval(function () {
        var r = evalWaitUntil();
        var waited = Date.now() - started;
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
      var uMet = ci(location.href).indexOf(ci(step.value || "")) >= 0;
      log("info", "condition: URL \\"" + location.href + "\\" contains \\"" + (step.value || "") + "\\" → " + uMet);
      return uMet;
    }
    if (c === "titleContains") {
      var tiMet = ci(document.title).indexOf(ci(step.value || "")) >= 0;
      log("info", "condition: title \\"" + document.title + "\\" contains \\"" + (step.value || "") + "\\" → " + tiMet);
      return tiMet;
    }
    if (c === "exists") {
      var n = resolveAll(step.locator).length;
      log("info", "condition: exists → " + n + " match(es) → " + (n > 0));
      return n > 0;
    }
    var el = resolve(step.locator);
    var met;
    switch (c) {
      case "hidden": met = !el || !visible(el); break;
      case "enabled": met = !!el && !el.disabled; break;
      case "disabled": met = !!el && !!el.disabled; break;
      case "checked": met = !!el && !!el.checked; break;
      case "unchecked": met = !!el && !el.checked; break;
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
    if (t === "if") {
      var met = evalCondition();
      log("info", met ? "block WILL run" : "block will be SKIPPED");
      return { ok: true, met: met };
    }
    if (t === "endif") { log("info", "end of conditional block"); return { ok: true }; }
    if (t === "goto") { log("info", "goto runs at test start; skipped in preview"); return { ok: true, error: "goto runs at test start; skipped in preview" }; }
    if (t === "viewport") { log("info", "viewport is applied at run time; not previewable"); return { ok: true, error: "viewport is applied at run time; not previewable" }; }
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
      var cEl = resolve(step.locator);
      if (!cEl) { log("error", "Element not found — cannot capture"); return { ok: false, error: "Element not found" }; }
      var got = "";
      if (from === "value") got = cEl.value == null ? "" : String(cEl.value);
      else if (from === "attribute") got = cEl.getAttribute ? (cEl.getAttribute(step.captureAttr || "") || "") : "";
      else got = (cEl.textContent || "").trim();
      log("info", "captured " + (step.captureVar || "?") + " = \\"" + got + "\\"");
      return { ok: true, captured: got };
    }

    var el = resolve(step.locator);
    if (!el) { log("error", "Element not found — cannot " + t); return { ok: false, error: "Element not found" }; }
    log("info", "Resolved to <" + (el.tagName || "").toLowerCase() + ">" + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : ""));
    try {
      if (t === "click") { try { el.scrollIntoView({ block: "center" }); } catch (e) {} el.click(); log("info", "clicked"); return { ok: true }; }
      if (t === "fill") {
        el.focus();
        try { el.value = step.value || ""; } catch (e) {}
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        log("info", "filled value=\\"" + (step.value || "") + "\\"");
        return { ok: true };
      }
      if (t === "select") {
        try { el.value = step.value || ""; } catch (e) {}
        el.dispatchEvent(new Event("change", { bubbles: true }));
        log("info", "selected value=\\"" + (step.value || "") + "\\"");
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
