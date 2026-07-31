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
// "1" while the "Refine Selector" element picker is active.
export const ATTR_REFINE = "data-pw-refine";
// JSON of the picked element (candidates + css + attributes), drained by backend.
export const ATTR_PICKED = "data-pw-picked";

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

  // A curated slice of computed styles, for the review dialog's context.
  function cssPropsOf(el) {
    var out = {};
    try {
      var cs = window.getComputedStyle(el);
      var keys = ["display", "position", "color", "backgroundColor", "fontSize",
        "fontWeight", "width", "height", "visibility", "border"];
      for (var i = 0; i < keys.length; i++) {
        var v = cs[keys[i]];
        if (v) out[keys[i]] = String(v);
      }
    } catch (e) {}
    return out;
  }

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
