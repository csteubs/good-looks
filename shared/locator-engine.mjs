// THE LOCATOR ENGINE — the DOM walk every locator question in this app is answered by.
//
// Four bodies of JavaScript, held as SOURCE TEXT because none of them runs in the
// process that owns them: each is interpolated into a script that some other
// runtime evaluates — an Electron isolated world, a Playwright worker's init
// script, a page evaluate. That is also why they are ES5-flavoured and close over
// nothing.
//
// ── What they answer ──────────────────────────────────────────────────────
//   • DOM_HELPERS         — what an element IS: its role, its accessible name,
//                           its text, its escaped selector, the shadow roots
//                           around it. Everything else is built on this.
//   • CONTEXT_HELPERS     — `ctxFilter`: narrow a match set by the user's pinned
//                           element context ("the Edit button in the Billing card").
//   • UNIQUENESS_HELPERS  — `matchesFor`: the elements a recorded locator would
//                           actually resolve to, under Playwright's strict mode
//                           and its default string semantics.
//   • the scan caps       — how much of a page each of the above may walk.
//
// ── Why they are HERE and not in main/recorder/ ───────────────────────────
// They were in `main/recorder/capture-script.ts` until 2026-08-25, which made
// them reachable only from the compiled app. Two features waited on that and
// neither could say so in code:
//
//   • Standing overlay rules did not run on an MCP or CLI run, because
//     `dismiss-fixture-source.ts` embeds these strings and could not be imported
//     by a plain-.mjs server. A banner the app clicks away stayed on the page,
//     so a step behind it failed in CI and passed in the app.
//   • Run-time Auto-Heal was worse: it was switched ON for those runs and
//     healed nothing, because the heal MAP holds a probe script per step built
//     from these same strings, and nothing could build one. See R49 in
//     docs/plans/test-runner-improvements.md — the run reported a capability it
//     did not have.
//
// So the extraction is not tidying. It is the thing both of those were blocked
// on, and the reason `shared/` exists at all: a rule two runtimes both need,
// spelled once. Pure by the same rule as every other module here — strings and
// numbers, no fs, no IPC, no process, no DOM of its own.
//
// ── What did NOT come with them ───────────────────────────────────────────
// `PICKED_HELPERS` and `CSS_PROPS_HELPER` stayed behind. They describe a PICKED
// element for the refine dialog, and `CSS_PROPS_HELPER` interpolates
// `CSS_ASSERT_PROPS` from `main/recorder/types.ts` — a model the app owns and no
// unattended run has a use for. Moving them would drag that model across the
// boundary to serve a caller that does not exist.

import { testIdOverride } from "./testid-attr.mjs";

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
 * What a caller that is NOT on the click path sets `GL_SCAN_LIMIT` to.
 *
 * The replayer and the heal probe include these helpers but are user-initiated
 * — a preview somebody asked for and is waiting on, not a click being recorded
 * — so the reason for the cap does not apply to them. Inheriting it was a real
 * regression the moment the replayer started sharing this engine: on a page
 * with more elements than the cap, a locator's target was never scanned, and
 * the trainer reported "element not found" for an element a real run resolves
 * without difficulty. That is the exact failure direction this whole change
 * exists to remove, reintroduced by sharing code with a caller that had a
 * different constraint.
 *
 * A large number rather than `Infinity`: it is interpolated into a script, and
 * it reads as a bound rather than as a promise to walk an unbounded document.
 */
export const UNCAPPED_SCAN = 1_000_000;

/**
 * How many OPEN shadow roots a scan will descend into before giving up.
 *
 * Separate from `MAX_UNIQUENESS_SCAN` because it bounds a different thing: that
 * one caps elements looked at, this one caps the roots looked *inside*. A
 * component-heavy page reaches a hundred roots without being large — ritual.com
 * is 2755 elements and 101 roots — so a shared cap would either starve the
 * element budget or leave the root walk unbounded.
 *
 * Above this many roots the answer is the same as above the element cap:
 * "assume ambiguous", which costs an `.nth()` rather than a stall on the click
 * path. The walk itself measured 0.18ms on that page, so the cap is a backstop
 * against a pathological document, not a budget the normal case spends.
 */
export const MAX_SHADOW_ROOTS = 400;

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
/**
 * `ctxFilter(list, ctx)` — narrow a match set by the user's pinned context.
 *
 * THE ONE IMPLEMENTATION. Included into `UNIQUENESS_HELPERS` below rather than
 * offered as a separate include, so that every existing caller of `matchesFor`
 * — the capture script's `pickLocator`, the replayer, the heal probe — honours
 * context without being changed, and none of them can be the one that forgets.
 * A context the recorder respects and the replayer ignores is the same class of
 * divergence `shared/step-semantics.mjs` exists to end, one level down.
 *
 * Each clause mirrors the Playwright expression the generator emits for it, and
 * that correspondence is the whole contract:
 *
 *   within        page.getByTestId("x").getByRole("button")
 *                 → a STRICT descendant. Playwright searches inside the
 *                   container, so the container is not a match for itself; the
 *                   `!==` is what says so, since `Node.contains` counts self.
 *   withinHasText .filter({ hasText })
 *                 → the CONTAINER's own text, by Playwright's default string
 *                   rule (case-insensitive substring, whitespace normalized) —
 *                   `pwHas`, the same function the count uses everywhere else.
 *   and           .and(page.locator(…))
 *                 → set intersection: the element matches both.
 *
 * Applied BEFORE `nth`, which is what the emitted chain does too — `.nth()` is
 * last and indexes the narrowed set. Getting that backwards would silently
 * change which element an indexed step means.
 */
export const CONTEXT_HELPERS = `
  function ctxFilter(list, ctx) {
    if (!ctx) return list;
    var out = list;
    if (ctx.within) {
      var containers = matchesForBase(ctx.within);
      if (ctx.withinHasText) {
        containers = containers.filter(function (c) {
          return pwHas(c.textContent, ctx.withinHasText);
        });
      }
      out = out.filter(function (el) {
        for (var i = 0; i < containers.length; i++) {
          if (containers[i] !== el && containers[i].contains(el)) return true;
        }
        return false;
      });
    }
    if (ctx.and) {
      for (var j = 0; j < ctx.and.length; j++) {
        var preds = matchesForBase(ctx.and[j]);
        out = out.filter(function (el) { return preds.indexOf(el) >= 0; });
      }
    }
    return out;
  }
`;

export const UNIQUENESS_HELPERS = `
  // The shared attribute grammar, embedded as source (the heal fixture's
  // idiom) — a transcribed copy here would be a second spelling of one rule.
  var glazeTestIdOverride = ${testIdOverride.toString()};
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

  /** Playwright's EXACT string match: whole string, case-sensitive,
   *  whitespace still normalized on both sides. */
  function pwIs(haystack, needle) {
    var n = pwTrim(needle);
    if (!n) return false;
    return pwTrim(haystack) === n;
  }
  function pwTrim(s) {
    return String(s == null ? "" : s).replace(/\\s+/g, " ").trim();
  }

  /** The element's text as an exact locator would have to spell it — from
   *  textContent, NOT innerText: getByText reads textContent, and a CSS
   *  text-transform makes an innerText value that never matches. Reads the
   *  same text the substring arm of matchesForBase reads, so the candidate
   *  and the oracle that grades it cannot disagree about what the text IS;
   *  when the text model changes (pwText, DECISIONS 2026-08-22, "the mark
   *  and the text model"), both must move together. */
  function pwExact(el) {
    return pwTrim(el.textContent);
  }

  /** How many elements a scan will look at. Overridable by the including
   *  script — see the note on MAX_UNIQUENESS_SCAN. The cap exists because
   *  CAPTURE runs this on the click path; the replayer and the heal probe do
   *  not, and inheriting it there would make a large page's elements invisible
   *  to a preview that a real run resolves perfectly well. */
  var GL_SCAN_LIMIT = ${MAX_UNIQUENESS_SCAN};
  var GL_SHADOW_LIMIT = ${MAX_SHADOW_ROOTS};

  /** Every OPEN shadow root reachable from \`root\`, outermost first, bounded.
   *
   *  CLOSED roots are deliberately absent: script cannot reach them, and
   *  neither can Playwright, so leaving them out is what keeps the two
   *  agreeing rather than an omission. */
  function shadowRootsIn(root, acc) {
    var all;
    try { all = root.querySelectorAll("*"); } catch (e) { return acc; }
    for (var i = 0; i < all.length; i++) {
      var sr = all[i].shadowRoot;
      if (!sr) continue;
      acc.push(sr);
      if (acc.length >= GL_SHADOW_LIMIT) return acc;
      shadowRootsIn(sr, acc);
      if (acc.length >= GL_SHADOW_LIMIT) return acc;
    }
    return acc;
  }

  /** The elements a CSS selector resolves to, PIERCING open shadow roots.
   *
   *  Playwright's selector engines pierce open shadow roots; \`document
   *  .querySelectorAll\` does not. An oracle built on the bare call therefore
   *  grades a perfectly good locator as matching NOTHING — the exact inversion
   *  of the testid-attribute bug, and the same consequence: the trainer and the
   *  run disagree about a step, so the number on screen is not the number the
   *  spec will see. Measured on ritual.com, whose consent banner is a shadow
   *  host: \`button.dg-button.accept_all\` was 0 here and 1 in real Playwright.
   *
   *  XPath is NOT routed through this and must not be — \`document.evaluate\`
   *  cannot cross a shadow boundary, and Playwright's xpath engine is the one
   *  engine that does not pierce either. Leaving that arm document-only is
   *  what keeps IT in agreement. */
  function scanAll(selector) {
    var out;
    try {
      out = Array.prototype.slice.call(document.querySelectorAll(selector), 0, GL_SCAN_LIMIT);
    } catch (e) {
      // An invalid selector is invalid in every root; a partial scan would
      // report a count rather than the "cannot answer" this really is.
      return [];
    }
    if (out.length >= GL_SCAN_LIMIT) return out;
    var roots = shadowRootsIn(document, []);
    for (var r = 0; r < roots.length; r++) {
      var hits;
      try { hits = roots[r].querySelectorAll(selector); } catch (e) { continue; }
      for (var j = 0; j < hits.length; j++) {
        out.push(hits[j]);
        if (out.length >= GL_SCAN_LIMIT) return out;
      }
    }
    return out;
  }

  /** What a locator resolves to IGNORING its context. Split out because
   *  context resolution is expressed in terms of it — a container and an
   *  \`and\` predicate are themselves locators, and they never carry a context
   *  of their own (see \`normalizeLocator\`), so this is where that recursion
   *  stops. Callers want \`matchesFor\`, below. */
  function matchesForBase(loc) {
    if (!loc) return [];
    try {
      if (loc.k === "testid") {
        // ONLY the recorded attribute — the same one the generated source
        // resolves. This used to scan all three test-id attributes for every
        // testid locator, which is how a step recorded off data-test could be
        // "unique" here while getByTestId found nothing on a run, and how a
        // unique data-testid could be rejected because another attribute held
        // the same value.
        var tidAttr = glazeTestIdOverride(loc.attr) || "data-testid";
        return scanAll("[" + tidAttr + '="' + cssEscape(loc.v) + '"]');
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
        // Explicit roles plus every tag roleOf() can derive THIS role from —
        // the selector comes from the same table roleOf reads, so nothing it
        // can name is missed and the whole document is not walked for one.
        var cands = scanAll(roleScanSelector(loc.role));
        return cands.filter(function (el) {
          if (roleOf(el) !== loc.role) return false;
          if (!loc.name) return true;
          return pwHas(accName(el), loc.name);
        });
      }
      if (loc.k === "text") {
        // textContent, not innerText: this runs on the click path and innerText
        // forces layout per element. See MAX_UNIQUENESS_SCAN.
        // \`exact\` swaps the comparison and nothing else: Playwright applies
        // the same smallest-element rule to getByText(v, { exact: true }).
        var textMatch = loc.exact === true ? pwIs : pwHas;
        var hits = scanAll("*").filter(function (el) {
          return textMatch(el.textContent, loc.v);
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

  ${CONTEXT_HELPERS}

  /** The elements a recorded locator resolves to, context included. */
  function matchesFor(loc) {
    if (!loc) return [];
    return ctxFilter(matchesForBase(loc), loc.ctx);
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
          // \`ctx\` is carried, not rebuilt away. This object is assembled
          // field-by-field, which is precisely how \`nth\` came to be dropped by
          // the normalizer once — an index computed against the CONTEXT-
          // narrowed set, attached to a locator that had lost its context,
          // indexes a different set and points at a different element.
          fallback = { k: loc.k, v: loc.v, attr: loc.attr, role: loc.role, name: loc.name, nth: ix };
          if (loc.exact === true) fallback.exact = true;
          if (loc.ctx) fallback.ctx = loc.ctx;
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

  /** The element's test-id locator, or null. WHICH attribute matched is part
   *  of the locator: \`getByTestId\` resolves only data-testid (nothing in this
   *  app configures Playwright's testIdAttribute), so the other two spellings
   *  must be recorded on the step or the generated spec resolves nothing while
   *  the trainer counts a match. data-testid wins when an element carries more
   *  than one, and carries no \`attr\` — absent means the default, so one
   *  locator never has two spellings. */
  // Probe order: the default first (it needs no attr and getByTestId
  // resolves it), then any configured extras, then the always-on pair. The
  // DEFAULT list is baked here so every script embedding these helpers
  // works alone; buildCaptureScript REASSIGNS it with the user's extras
  // (grammar-gated before interpolation).
  var TID_ATTRS = ["data-testid", "data-test-id", "data-test"];
  function testIdLocatorOf(el) {
    if (!el || !el.getAttribute) return null;
    for (var ti = 0; ti < TID_ATTRS.length; ti++) {
      var v = el.getAttribute(TID_ATTRS[ti]);
      if (v) {
        return TID_ATTRS[ti] === "data-testid"
          ? { k: "testid", v: v }
          : { k: "testid", attr: TID_ATTRS[ti], v: v };
      }
    }
    return null;
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

  // ----- Roles, transcribed from PLAYWRIGHT's mapping -----
  //
  // Not from the ARIA spec, and the difference is not academic: getByRole is
  // what the generated test runs against, so Playwright's table is the ground
  // truth even where it departs from HTML-AAM. Every deviation here is a
  // locator that records cleanly, verifies as unique against this same
  // function, previews green in the trainer — and then matches nothing in the
  // run. The whole path is self-consistent and wrong together, which is why a
  // deviation survives: matchesFor grades uniqueness with this function, so
  // the recorder is grading its own homework. Until 2026-08-22 the table held
  // five tags, and an <h1> had no role at all — so a click on it recorded a
  // positional path and an assertion on it a substring of its text, with
  // getByRole("heading", { name }) never offered.
  //
  // Kept deliberately parallel to kImplicitRoleByTagName (and inputTypeToRole
  // beside it) in playwright-core/lib/generated/injectedScriptSource.js, so a
  // future reader can diff the two. A string is an unconditional role; a
  // function decides at the element. The authority on whether an entry holds
  // is e2e/assert-parity.spec.ts, where a real browser answers.

  /** Landmarks that stop a header/footer inside them from being banner /
   *  contentinfo — Playwright's kAncestorPreventingLandmark, verbatim. */
  var GL_LANDMARK_BLOCKERS =
    "article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), " +
    "[role=article], [role=complementary], [role=main], [role=navigation], [role=region]";

  /** The global aria-* attributes that make an alt="" image an img rather
   *  than presentation — Playwright's kGlobalAriaAttributes, the entries that
   *  apply to an image. */
  var GL_GLOBAL_ARIA = [
    "aria-atomic", "aria-busy", "aria-controls", "aria-current", "aria-describedby",
    "aria-details", "aria-dropeffect", "aria-flowto", "aria-grabbed", "aria-hidden",
    "aria-keyshortcuts", "aria-label", "aria-labelledby", "aria-live", "aria-owns",
    "aria-relevant", "aria-roledescription"
  ];

  function hasExplicitName(el) {
    return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby");
  }
  function hasGlobalAria(el) {
    for (var i = 0; i < GL_GLOBAL_ARIA.length; i++) {
      if (el.hasAttribute(GL_GLOBAL_ARIA[i])) return true;
    }
    return false;
  }
  function hasTabIndex(el) {
    return !isNaN(Number(String(el.getAttribute("tabindex"))));
  }

  /** Nearest ancestor matching sel, stepping out of an open shadow root to
   *  its host the way Playwright's closestCrossShadow does. Starts ABOVE the
   *  element: every caller asks about an ancestor. */
  function closestAbove(el, sel) {
    var node = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    while (node) {
      if (node.nodeType === 1 && node.matches && node.matches(sel)) return node;
      node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
    }
    return null;
  }

  function cellRole(el) {
    var table = closestAbove(el, "table");
    var tr = table ? (table.getAttribute("role") || "") : "";
    return tr === "grid" || tr === "treegrid" ? "gridcell" : "cell";
  }

  function inputRole(el) {
    // The IDL property, not the attribute: el.type normalises an unknown or
    // absent type to "text", which is what Playwright reads.
    var ty = String(el.type || "text").toLowerCase();
    // A text-ish input wired to a <datalist> is a combobox, not a textbox.
    if (ty === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
    if (ty === "email" || ty === "tel" || ty === "text" || ty === "url" || ty === "") {
      var listId = el.getAttribute("list");
      var listEl = listId ? document.getElementById(listId) : null;
      return listEl && listEl.tagName === "DATALIST" ? "combobox" : "textbox";
    }
    // The only input with no role at all. Everything else has one.
    if (ty === "hidden") return "";
    // A file input is a BUTTON to Playwright, which is genuinely surprising
    // and is why it is spelled out rather than left to the table below.
    if (ty === "file") return "button";
    if (ty === "checkbox") return "checkbox";
    if (ty === "radio") return "radio";
    if (ty === "number") return "spinbutton";
    if (ty === "range") return "slider";
    if (ty === "button" || ty === "image" || ty === "reset" || ty === "submit") return "button";
    // password, date, datetime-local, month, week, time, color — Playwright's
    // fallback, and the reason the spec-accurate "no role" answer is wrong here.
    return "textbox";
  }

  var GL_IMPLICIT_ROLES = {
    a: function (e) { return e.hasAttribute("href") ? "link" : ""; },
    area: function (e) { return e.hasAttribute("href") ? "link" : ""; },
    article: "article",
    aside: "complementary",
    blockquote: "blockquote",
    button: "button",
    caption: "caption",
    code: "code",
    datalist: "listbox",
    dd: "definition",
    del: "deletion",
    details: "group",
    dfn: "term",
    dialog: "dialog",
    dt: "term",
    em: "emphasis",
    fieldset: "group",
    figure: "figure",
    footer: function (e) { return closestAbove(e, GL_LANDMARK_BLOCKERS) ? "" : "contentinfo"; },
    form: function (e) { return hasExplicitName(e) ? "form" : ""; },
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    header: function (e) { return closestAbove(e, GL_LANDMARK_BLOCKERS) ? "" : "banner"; },
    hr: "separator",
    html: "document",
    img: function (e) {
      return e.getAttribute("alt") === "" && !e.getAttribute("title") && !hasGlobalAria(e) && !hasTabIndex(e)
        ? "presentation"
        : "img";
    },
    input: inputRole,
    ins: "insertion",
    li: "listitem",
    main: "main",
    mark: "mark",
    math: "math",
    menu: "list",
    meter: "meter",
    nav: "navigation",
    ol: "list",
    optgroup: "group",
    option: "option",
    output: "status",
    p: "paragraph",
    progress: "progressbar",
    section: function (e) { return hasExplicitName(e) ? "region" : ""; },
    // A select is a listbox when it shows more than one row — which is
    // multiple OR size > 1, NOT just multiple. A <select size="4"> is the
    // everyday version and it is a listbox.
    select: function (e) { return e.multiple || e.size > 1 ? "listbox" : "combobox"; },
    strong: "strong",
    sub: "subscript",
    sup: "superscript",
    svg: "img",
    table: "table",
    tbody: "rowgroup",
    td: function (e) { return cellRole(e); },
    textarea: "textbox",
    tfoot: "rowgroup",
    th: function (e) {
      var scope = e.getAttribute("scope");
      if (scope === "col") return "columnheader";
      if (scope === "row") return "rowheader";
      return cellRole(e);
    },
    thead: "rowgroup",
    time: "time",
    tr: "row",
    ul: "list"
  };

  /** The element's ARIA role, as Playwright's getByRole computes it. */
  function roleOf(el) {
    var explicit = el.getAttribute ? el.getAttribute("role") : null;
    if (explicit) return explicit;
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var entry = Object.prototype.hasOwnProperty.call(GL_IMPLICIT_ROLES, tag) ? GL_IMPLICIT_ROLES[tag] : "";
    return typeof entry === "function" ? entry(el) : entry;
  }

  /** The selector a role scan starts from: every tag whose implicit role is
   *  (or can be) the one asked for, plus anything with an explicit role.
   *  Derived from the table rather than written beside it, so a tag cannot be
   *  added to one and missed by the other — and so a scan for "heading" walks
   *  six tags rather than the document. */
  var glRoleSelectors = {};
  function roleScanSelector(role) {
    if (glRoleSelectors[role]) return glRoleSelectors[role];
    var parts = ["[role]"];
    for (var tag in GL_IMPLICIT_ROLES) {
      if (!Object.prototype.hasOwnProperty.call(GL_IMPLICIT_ROLES, tag)) continue;
      var entry = GL_IMPLICIT_ROLES[tag];
      if (entry === role || typeof entry === "function") parts.push(tag);
    }
    glRoleSelectors[role] = parts.join(",");
    return glRoleSelectors[role];
  }

  /** Roles whose accessible name comes from their CONTENT — Playwright's
   *  allowsNameFromContent, the "always" list. Every other role is named only
   *  by aria-label / aria-labelledby (alt for an image, title last). Without
   *  this rule the table above would name a list item by its text, and
   *  getByRole("listitem", { name }) verifies unique here and matches NOTHING
   *  in the run — the deviation the comment on the table warns about. */
  var GL_NAME_FROM_CONTENT = [
    "button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab",
    "tooltip", "treeitem"
  ];

  /** Roles the table derives for ordinary content and structure — paragraphs,
   *  list items, cells, landmarks — which are never offered as a NAMELESS
   *  locator. getByRole("paragraph").nth(7) is the positional path the
   *  recorder falls to today with a better-looking name: an index into DOM
   *  order, breaking the same way. A NAMED one is still offered wherever the
   *  role takes a name (a heading, a cell). */
  var GL_BARE_ROLE_SKIP = [
    "paragraph", "strong", "emphasis", "code", "mark", "insertion", "deletion", "subscript",
    "superscript", "time", "term", "definition", "blockquote", "caption", "figure", "separator",
    "document", "list", "listitem", "rowgroup", "row", "cell", "gridcell", "columnheader",
    "rowheader", "table", "group", "article", "region", "main", "navigation", "banner",
    "contentinfo", "complementary", "form", "math", "meter", "status", "progressbar", "heading",
    "presentation", "none"
  ];
  function bareRoleOk(role) {
    return !!role && GL_BARE_ROLE_SKIP.indexOf(role) < 0;
  }

  function accName(el) {
    var al = el.getAttribute ? el.getAttribute("aria-label") : null;
    if (al) return al.trim();
    var lb = el.getAttribute ? el.getAttribute("aria-labelledby") : null;
    if (lb) {
      var r = document.getElementById(lb);
      if (r) return txt(r);
    }
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    if (tag === "img" || tag === "area" || (tag === "input" && String(el.type).toLowerCase() === "image")) {
      var alt = el.getAttribute("alt");
      if (alt) return alt.trim();
    }
    var role = roleOf(el);
    if (!role || GL_NAME_FROM_CONTENT.indexOf(role) >= 0) {
      var t = txt(el);
      if (t && t.length <= 80) return t;
    }
    var title = el.getAttribute ? el.getAttribute("title") : null;
    return title ? title.trim() : "";
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

  /** The topmost element at a point, DESCENDING into open shadow roots.
   *
   *  \`document.elementFromPoint\` stops at the shadow HOST — it reports the
   *  custom element, never the button inside it. Each root is asked again at
   *  the same coordinates until one stops handing back a new host, which is
   *  how the DOM exposes this; there is no composed variant of the call.
   *
   *  The guard is \`next !== node\`: a root whose own host fills the point
   *  answers with that host and would otherwise spin. Depth is bounded for the
   *  same reason the scans are — this runs on a user gesture. */
  function deepElementFromPoint(x, y) {
    var node = null;
    try { node = document.elementFromPoint(x, y); } catch (e) { return null; }
    for (var depth = 0; depth < 20; depth++) {
      if (!node || !node.shadowRoot) break;
      var next = null;
      try { next = node.shadowRoot.elementFromPoint(x, y); } catch (e) { break; }
      if (!next || next === node) break;
      node = next;
    }
    return node;
  }
`;
