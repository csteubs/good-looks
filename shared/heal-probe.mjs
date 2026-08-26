// THE HEAL PROBE — what the page is asked when a step's locator stops resolving.
//
// One injected script: it walks the DOM with the shared locator engine, builds
// candidate locators for every element that could plausibly be the one the step
// meant, scores them against the step's original locator and against what that
// locator resolved to in past runs, and returns the best few.
//
// ── Why it is here and not in main/services/ ──────────────────────────────
// Because the map that carries it has to be BUILT by whoever starts a run, and
// two processes do. The heal fixture does nothing for a locator it has no map
// entry for — `if (!entry || !entry.probe …) throw err` is the first line of
// every patched action — so a runner that cannot build a probe cannot heal,
// however loudly its environment says healing is on. That was R49: the MCP and
// CLI path set `GLAZE_HEAL=1`, installed the fixture, and healed nothing on
// every unattended run, because this function was compiled TypeScript.
//
// It came here the moment it could: it interpolates the locator engine and
// `JSON.stringify(step)` and nothing else, so once R51 put the engine in
// shared/ there was no reason left for it to be app-only.
//
// ── Why ONE probe builder and not two ─────────────────────────────────────
// Candidate RANKING is where every Auto-Heal bug so far has lived. A second
// implementation would not fail; it would rank differently, and the symptom of
// ranking differently is a run that clicks a plausible wrong element and
// passes. The trainer, an app run and an unattended run all evaluate this exact
// string.
//
// Pure: strings in, a string out. No fs, no IPC, no process, no DOM of its own.

import {
  DOM_HELPERS,
  UNCAPPED_SCAN,
  UNIQUENESS_HELPERS,
} from "./locator-engine.mjs";

/** Build the injected probe script. It walks the DOM, generates candidate
 *  locators for each interactive element, scores them against the step's
 *  original locator + past-run hints, and returns the top-K ranked candidates.
 *
 *  `pastHints` is a compact summary of what the locator resolved to in past
 *  runs (extracted from DebugEntry logs) — used to boost candidates that match
 *  a previously-successful target. */
export function buildHealProbeScript(step, pastHints) {
  // NOTE: no backticks or ${...} inside the JS body except the two
  // interpolations here. `\\s` produces a literal \s in the emitted script.
  const hintsJson = JSON.stringify(pastHints);
  return `(function () {
  ${DOM_HELPERS}
  ${UNIQUENESS_HELPERS}

  // Not on the click path either — this runs after a step has already failed.
  // See UNCAPPED_SCAN.
  GL_SCAN_LIMIT = ${UNCAPPED_SCAN};

  var step = ${JSON.stringify(step)};
  var hints = ${hintsJson};
  var MAX_CANDIDATES = 8;
  // What the target looked like when the step was recorded. Absent on steps
  // recorded before fingerprinting, which is why every use below is guarded and
  // the locator-only path still works on its own.
  var fp = step.fingerprint || null;

  // What the USER said about which element they meant. Absent on almost every
  // step, and load-bearing where it is present — see the hard filter in
  // \`collectElements\` and the inheritance in \`withCtx\`.
  var stepCtx = (step.locator && step.locator.ctx) || null;

  function ci(s) { return String(s == null ? "" : s).toLowerCase(); }

  /** Put the step's context onto a candidate locator.
   *
   *  A heal REPLACES the locator, so without this the replacement would drop
   *  the user's disambiguation — healing a step that said "the Edit button in
   *  the Billing card" into one that says "an Edit button". That is the
   *  mis-heal this feature exists to prevent, performed by the feature itself.
   *
   *  Rebuilt field-by-field rather than spread, to match how every other
   *  locator on this path is assembled. */
  function withCtx(loc) {
    if (!stepCtx) return loc;
    var out = { k: loc.k };
    if (loc.v != null) out.v = loc.v;
    if (loc.attr != null) out.attr = loc.attr;
    if (loc.role != null) out.role = loc.role;
    if (loc.name != null) out.name = loc.name;
    if (loc.exact === true) out.exact = true;
    out.ctx = stepCtx;
    return out;
  }

  // Reuse the capture script's candidate-locator generator so a healed locator
  // is expressed in the same strategies the recorder understands.
  function candidatesFor(el) {
    var out = [];
    // testIdLocatorOf (DOM_HELPERS) records WHICH attribute it found, so an
    // applied heal resolves the same element the probe ranked.
    var tid = testIdLocatorOf(el);
    if (tid) out.push(tid);
    var role = roleOf(el);
    var nm = accName(el);
    if (role && nm) out.push({ k: "role", role: role, name: nm });
    var lab = labelFor(el);
    if (lab) out.push({ k: "label", v: lab });
    var ph = el.getAttribute ? el.getAttribute("placeholder") : null;
    if (ph) out.push({ k: "placeholder", v: ph });
    var t = txt(el);
    if (t && t.length <= 40) out.push({ k: "text", v: t });
    // The whole text, exactly — case-sensitive and whole-string — for the
    // page where the substring above also matches a neighbour ("Mountain"
    // beside "mountains"). After the substring, so a unique substring still
    // records as it always did; before any generated path.
    var te = pwExact(el);
    if (te && te.length <= 40) out.push({ k: "text", v: te, exact: true });
    if (role && !nm && bareRoleOk(role)) out.push({ k: "role", role: role });
    out.push({ k: "css", v: cssPath(el) });
    return out;
  }

  function describeEl(el) {
    var tag = (el.tagName || "").toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = el.className && typeof el.className === "string"
      ? "." + el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join(".")
      : "";
    return tag + id + cls;
  }

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

  // Collect interactive elements to consider as heal targets. We scan a broad
  // set (anything with a role, testid, label, placeholder, or common interactive
  // tag) so we don't miss the intended target, then score + rank them.
  function collectElements() {
    var sel = "button, a[href], input, select, textarea, [role], [data-testid], [data-test-id], [data-test], [aria-label], [tabindex]";
    var list = Array.prototype.slice.call(document.querySelectorAll(sel));
    // Keep only visible elements (a hidden target can't be the intended one
    // for an action step).
    //
    // NOTE: no key-based de-duplication here. A comma-separated selector list
    // already yields a unique, document-ordered set, so dedup was unnecessary —
    // and keying it on tagName|id|className actively discarded real elements:
    // any two plain <button>s (or <a href>s) with no id and no class collapse
    // to the same key, so every one after the first was dropped and could never
    // be proposed as a heal candidate.
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el) continue;
      if (!visible(el)) continue;
      out.push(el);
    }
    // Drop elements outside the user's pinned container.
    //
    // NOT the mechanism that makes context a hard filter — \`withCtx\` is, by
    // putting the context on every candidate so \`identifiesOnly\` resolves it
    // scoped, at which point an outside element's candidates match nothing and
    // are rejected anyway. Removing this line breaks no test, and that was
    // checked rather than assumed.
    //
    // It stays for cost. Everything downstream is per-element and expensive:
    // \`candidatesFor\`, \`scoreElementIdentity\`, \`scoreGeometry\`, and then an
    // \`identifiesOnly\` per candidate — each of which scans the document, at
    // UNCAPPED_SCAN. Excluding an element here removes all of it; excluding it
    // downstream pays for it first and discards the answer. On the pages this
    // feature is for — a long list of near-identical rows, where the user
    // pinned one — that is most of the probe's work.
    return ctxFilter(out, stepCtx);
  }

  // Score a candidate locator against the step's original locator + hints.
  // Higher = better. Exact kind+value match is best (the original locator may
  // have been slightly off, e.g. a stale testid); same kind partial-value match
  // is next; same role/text is a fuzzy signal.
  // THE CEILING OF THIS SCORING SCHEME, and why the scores are divided by it.
  //
  // A candidate's score is a SUM of independent contributions, so it runs well
  // past 1: the best possible is 1.25 from the locator (1.0 for a same-kind
  // exact value, plus 0.25 for a past-run hint) or the same 1.25 from the
  // fingerprint — they are max'd, not added — then 1.0 of element identity
  // (0.15 tag + 0.35 attributes + 0.3 own text + 0.2 neighbouring label) and
  // 0.2 of geometry.
  //
  // Nothing downstream expected that. normalizeStepStructures drops a score
  // outside 0-1 to zero — deliberately, and it must keep doing so, because this
  // number is computed IN THE PAGE and a hostile one clamped to 1 would sort
  // itself to the top of a list the model reads as ranked (see the capture
  // boundary in CLAUDE.md). The result was that the STRONGEST candidates, the
  // only ones that could exceed 1, were the ones reported as "score 0.00", and
  // the AI-debug prompt printed its list looking ranked worst-first.
  //
  // So the source emits a real 0-1 score instead. Dividing by the ceiling is
  // order-preserving — every candidate is scaled by the same constant — so the
  // ranking the sort produces is untouched and only the printed number changes.
  var MAX_LOCATOR_SCORE = 1.25;
  var MAX_IDENTITY_SCORE = 1.0;
  var MAX_GEOMETRY_SCORE = 0.2;
  var MAX_SCORE = MAX_LOCATOR_SCORE + MAX_IDENTITY_SCORE + MAX_GEOMETRY_SCORE;

  function scoreLocator(cand, orig) {
    var s = 0;
    if (!orig) return 0.3;
    if (cand.k === orig.k) {
      if (cand.v != null && orig.v != null && cand.v === orig.v) s += 1.0;
      else if (cand.v != null && orig.v != null && (ci(cand.v).indexOf(ci(orig.v)) >= 0 || ci(orig.v).indexOf(ci(cand.v)) >= 0)) s += 0.7;
      // Both operands must actually BE something. Comparing two absent fields
      // (undefined === undefined) is trivially true, which awarded the
      // second-best score of 0.8 to every same-kind candidate on the page
      // regardless of its value — e.g. every testid on the page tied at 0.8,
      // outranking a real text match at 0.4 and putting an arbitrary element
      // at the top of the heal menu.
      else if (cand.role != null && orig.role != null && cand.role === orig.role &&
               cand.name != null && orig.name != null && cand.name === orig.name) s += 0.8;
      else if (cand.role != null && orig.role != null && cand.role === orig.role) s += 0.5;
      else s += 0.3;
    } else {
      // Cross-kind: weaker signal, but a text/role match is still meaningful.
      // Checked BOTH ways, like the same-kind branch above. One-directional
      // matching missed the commonest heal case by far: a renamed testid whose
      // visible label is unchanged, e.g. orig testid "submit-button" vs
      // candidate text "Submit" — the original is longer, so asking only
      // "does the candidate contain the original?" scored the correct element
      // at zero and ranked an unrelated one first.
      if (orig.v && cand.v && (ci(cand.v).indexOf(ci(orig.v)) >= 0 || ci(orig.v).indexOf(ci(cand.v)) >= 0)) s += 0.4;
      else if (orig.role && cand.role === orig.role) s += 0.3;
      else if (orig.name && cand.name && ci(cand.name).indexOf(ci(orig.name)) >= 0) s += 0.3;
    }
    // Boost if this candidate's description appears in past-run hints (the
    // locator previously resolved to something like this).
    var desc = describeEl({ tagName: "", id: "", className: "", getAttribute: function() { return null; } });
    for (var h = 0; h < hints.length; h++) {
      if (hints[h] && cand.v && ci(hints[h]).indexOf(ci(cand.v)) >= 0) { s += 0.25; break; }
      if (hints[h] && cand.name && ci(hints[h]).indexOf(ci(cand.name)) >= 0) { s += 0.25; break; }
    }
    return s;
  }

  function sameLocator(a, b) {
    // \`attr\` too: {testid, v} and {testid, attr: "data-test", v} resolve
    // DIFFERENT elements, so treating them as one would silently drop the
    // second element's best candidate.
    // \`exact\` too: the substring and exact forms of one text are two
    // locators resolving two sets.
    return !!a && !!b && a.k === b.k && a.v === b.v && a.attr === b.attr &&
      a.role === b.role && a.name === b.name && a.exact === b.exact;
  }

  // \`resolveAllFor\` used to live here: a fourth near-copy of \`matchesFor\`,
  // written against the same Playwright semantics and sharing no code with it.
  // It is gone, and \`matchesFor\` from UNIQUENESS_HELPERS — already injected
  // above — answers the question instead.
  //
  // Collapsing it was not tidiness. Element context has to be honoured by
  // whatever decides "does this locator identify one element", and with two
  // implementations that is two places to teach and one to forget; the one that
  // forgot would disagree with the recorder about which element a step means,
  // and the disagreement would only ever surface on a run. The comments the old
  // copy carried — pwHas rather than \`===\` because exact comparison UNDER-counts
  // and under-counting is what ships a locator we have declared safe, and the
  // smallest-element rule for text — are the same comments \`matchesFor\` carries,
  // because they were learned twice.

  /** A heal candidate has to identify ONE element.
   *
   *  Found by a test: two buttons both reading "Save" each generate the
   *  candidate {k:"text", v:"Save"}. Ranking correctly picked the right
   *  ELEMENT, but the locator it proposed matched both — so applying it would
   *  raise a Playwright strict-mode violation, or in the trainer's replayer
   *  (which takes the first match) silently act on the wrong button. An
   *  ambiguous candidate is not a heal, so it is not offered.
   *
   *  Judged WITH the step's context, because the candidates carry it (see
   *  \`withCtx\`). That is what lets a locator which is hopelessly ambiguous on
   *  the page — \`getByRole("button", { name: "Edit" })\` on a page of cards —
   *  qualify as a heal when the user has said which card. Before context, the
   *  only way to heal such a step was an index or a generated css path. */
  function identifiesOnly(loc, el) {
    var hits = matchesFor(loc);
    return hits.length === 1 && hits[0] === el;
  }

  // Best score of this candidate against ANY locator strategy the element had
  // at record time — the whole point of the fingerprint.
  //
  // The case this fixes: a testid renamed between runs on an element whose
  // visible label never changed. The step's locator is the stale testid, so
  // locator-only scoring has nothing to match; the fingerprint still remembers
  // that this element was also reachable by role+name and by its text, and one
  // of those matches exactly.
  function scoreAgainstFingerprint(cand) {
    if (!fp || !fp.candidates) return 0;
    var best = 0;
    for (var i = 0; i < fp.candidates.length; i++) {
      var s = scoreLocator(cand, fp.candidates[i]);
      if (s > best) best = s;
    }
    return best;
  }

  // How much of the recorded element's non-locator identity this element still
  // shares: its tag, its curated attributes, its own text, and the nearby
  // heading/label that named it. Weak signals individually, but together they
  // separate the intended element from an unrelated one that happens to score
  // the same on a single locator strategy.
  function scoreElementIdentity(el) {
    if (!fp) return 0;
    var s = 0;
    if (fp.tag && (el.tagName || "").toLowerCase() === fp.tag) s += 0.15;
    if (fp.attributes) {
      var keys = Object.keys(fp.attributes);
      var hits = 0;
      var checked = 0;
      for (var i = 0; i < keys.length; i++) {
        // "class" churns constantly in CSS-in-JS and utility-class codebases —
        // matching on it would score a redesigned page's every element alike.
        if (keys[i] === "class") continue;
        checked++;
        var got = el.getAttribute ? el.getAttribute(keys[i]) : null;
        if (got && ci(got) === ci(fp.attributes[keys[i]])) hits++;
      }
      if (checked > 0) s += 0.35 * (hits / checked);
    }
    if (fp.text) {
      var t = txt(el);
      if (t && ci(t) === ci(fp.text)) s += 0.3;
      else if (t && (ci(t).indexOf(ci(fp.text)) >= 0 || ci(fp.text).indexOf(ci(t)) >= 0)) s += 0.15;
    }
    if (fp.neighborText) {
      var nb = "";
      try {
        var node = el;
        for (var up = 0; up < 3 && node && !nb; up++) {
          var sib = node.previousElementSibling;
          for (var n = 0; n < 4 && sib; n++) {
            var tag = (sib.tagName || "").toLowerCase();
            if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" ||
                tag === "h5" || tag === "h6" || tag === "label" || tag === "legend") {
              nb = txt(sib); break;
            }
            sib = sib.previousElementSibling;
          }
          node = node.parentElement;
        }
      } catch (e) {}
      if (nb && ci(nb) === ci(fp.neighborText)) s += 0.2;
    }
    return s;
  }

  // Geometry: an element that sits where the recorded one sat is more likely to
  // BE it. Deliberately small and tolerant — a responsive layout legitimately
  // moves things, so this breaks ties rather than deciding.
  function scoreGeometry(el) {
    if (!fp || !fp.rect) return 0;
    try {
      var r = el.getBoundingClientRect();
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      if (!vw || !vh) return 0;
      var dx = Math.abs(r.left / vw - fp.rect.x);
      var dy = Math.abs(r.top / vh - fp.rect.y);
      var dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.05) return 0.2;
      if (dist < 0.15) return 0.1;
    } catch (e) {}
    return 0;
  }

  var orig = step.locator;
  var elements = collectElements();
  var all = [];
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var cands = candidatesFor(el);
    var desc = describeEl(el);
    // Per-ELEMENT signals, computed once rather than per candidate locator: the
    // identity of the element doesn't change depending on which of its locators
    // we happen to be scoring.
    var identity = scoreElementIdentity(el) + scoreGeometry(el);
    // The exact text twin is proposed only where the substring form did NOT
    // identify the element: when the substring is unique the exact form adds
    // nothing but a second row (and, under MAX_CANDIDATES, costs another
    // element its place); when the substring is ambiguous the exact form is
    // the heal that works. Candidates list the substring first.
    var substringIdentifies = false;
    for (var j = 0; j < cands.length; j++) {
      if (cands[j].k === "text" && cands[j].exact === true && substringIdentifies) continue;
      // The step's context rides on every candidate from here on: it is what
      // \`identifiesOnly\` judges uniqueness against, and it is what the applied
      // heal will carry. Scoring still compares the BARE locator, because the
      // context is the same on all of them and says nothing about which
      // candidate resembles the recorded element.
      var c = withCtx(cands[j]);
      // Skip the exact original locator (it already failed).
      if (sameLocator(c, orig)) continue;
      // Skip anything that doesn't pin down this exact element.
      if (!identifiesOnly(c, el)) continue;
      if (c.k === "text" && c.exact !== true) substringIdentifies = true;
      var score = scoreLocator(c, orig);
      var fpScore = scoreAgainstFingerprint(c);
      if (fpScore > score) score = fpScore;
      score += identity;
      var matchedPast = false;
      for (var h = 0; h < hints.length; h++) {
        if (hints[h] && ((c.v && ci(hints[h]).indexOf(ci(c.v)) >= 0) || (c.name && ci(hints[h]).indexOf(ci(c.name)) >= 0))) {
          matchedPast = true; break;
        }
      }
      // Normalised here, at the source — see MAX_SCORE. Clamped as well as
      // divided, because the ceiling is an argument about the weights above and
      // a weight raised without raising it would otherwise ship a score of 1.03
      // that the boundary silently turns back into a zero.
      var norm = score / MAX_SCORE;
      if (norm > 1) norm = 1;
      if (norm < 0) norm = 0;
      all.push({ locator: c, description: desc, score: norm, matchedPastRun: matchedPast });
    }
  }
  // Sort best-first; cap to MAX_CANDIDATES.
  all.sort(function (a, b) { return b.score - a.score; });
  return all.slice(0, MAX_CANDIDATES);
})()`;
}
