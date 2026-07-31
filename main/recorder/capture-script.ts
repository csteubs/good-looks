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

// Marker/attribute names, shared with the backend.
export const ATTR_INSTALLED = "data-pw-installed";
export const ATTR_QUEUE = "data-pw-queue";
export const ATTR_PAUSED = "data-pw-paused";
export const ATTR_ASSERT = "data-pw-assert";
export const ATTR_ASSERT_SOFT = "data-pw-assert-soft";

// Pure DOM helper functions shared verbatim by the capture script (which builds
// a locator FROM an element) and the step replayer (which finds an element FROM
// a locator). Kept as one string so the two injected scripts can't drift. No
// backticks or ${...} inside except the escaped whitespace regex.
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

  function push(step) {
    var e = document.documentElement;
    var q;
    try { q = JSON.parse(e.getAttribute("${ATTR_QUEUE}") || "[]"); } catch (err) { q = []; }
    q.push(step);
    e.setAttribute("${ATTR_QUEUE}", JSON.stringify(q));
  }

  ${DOM_HELPERS}

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

  function locatorFor(el) {
    var tid =
      (el.getAttribute && (el.getAttribute("data-testid") ||
        el.getAttribute("data-test-id") ||
        el.getAttribute("data-test"))) || "";
    if (tid) return { k: "testid", v: tid };

    var tag = el.tagName.toLowerCase();
    var role = roleOf(el);

    if (tag === "input" || tag === "textarea" || tag === "select") {
      var lab = labelFor(el);
      if (lab) return { k: "label", v: lab };
      var ph = el.getAttribute("placeholder");
      if (ph) return { k: "placeholder", v: ph };
      var nm = accName(el);
      if (role && nm) return { k: "role", role: role, name: nm };
      return { k: "css", v: cssPath(el) };
    }

    if (role) {
      var name = accName(el);
      if (name) return { k: "role", role: role, name: name };
    }
    var t = txt(el);
    if (t && t.length <= 40) return { k: "text", v: t };
    if (role) return { k: "role", role: role };
    return { k: "css", v: cssPath(el) };
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
    if (!assertMode()) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    clearHi();
    lastHi = el;
    try {
      el.__pwOldOutline = el.style.outline;
      el.style.outline = "2px solid #e5484d";
      el.style.outlineOffset = "1px";
    } catch (er) {}
  }
  function onOut() {
    if (!assertMode()) return;
    clearHi();
  }

  function onClick(e) {
    var target = e.target;
    var el = target && target.nodeType === 1 ? target : (target ? target.parentElement : null);
    if (!el) return;

    // Always keep navigation in-window, regardless of pause/assert state.
    keepInWindow(el);

    var mode = assertMode();
    if (mode) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var payload = { type: "assert", assert: mode, locator: locatorFor(el) };
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

    push({ type: "click", locator: locatorFor(interactiveTarget(el)) });
  }

  function onChange(e) {
    if (isPaused() || assertMode()) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var tag = el.tagName.toLowerCase();
    if (tag === "select") {
      var opt = el.options[el.selectedIndex];
      push({ type: "select", locator: locatorFor(el), value: el.value, label: opt ? txt(opt) : el.value });
      return;
    }
    if (tag === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "checkbox" || ty === "radio") {
        push({ type: el.checked ? "check" : "uncheck", locator: locatorFor(el) });
        return;
      }
      push({ type: "fill", locator: locatorFor(el), value: el.value });
      return;
    }
    if (tag === "textarea") {
      push({ type: "fill", locator: locatorFor(el), value: el.value });
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
      push(step);
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
