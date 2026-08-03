// Auto-Heal engine: when a step's locator fails to resolve during replay, this
// probes the live training-window page for alternative target elements using
// all locator strategies (testid/role/label/placeholder/text/css/xpath) plus
// context from past-run debug logs, then returns ranked candidates. The caller
// (recorder-service) re-runs the step with the best candidate; if it succeeds
// the candidate is auto-applied. All candidates are also surfaced to the user
// via `recorder:healSuggestion` so they can pick any/all from a menu.
//
// The probe runs as an injected JS string (like buildReplayScript) so it can
// inspect the live DOM in the training window. It reuses the shared DOM_HELPERS
// so locator semantics stay aligned with the capture script + replayer.

import { DOM_HELPERS } from "../recorder/capture-script.js";
import type { DebugEntry, HealCandidate, HealResult, Step } from "../recorder/types.js";

/** Race a page `executeJavaScript` against a timeout so a hanging probe can't
 *  freeze the replay run. Mirrors `execWithTimeout` in recorder-service. */
function execWithTimeout(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  script: string,
  ms: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Heal probe timed out after ${Math.round(ms / 1000)}s.`)),
      ms,
    );
  });
  return Promise.race([wc.executeJavaScript(script), timeout]).finally(() => clearTimeout(timer));
}

/** Build the injected probe script. It walks the DOM, generates candidate
 *  locators for each interactive element, scores them against the step's
 *  original locator + past-run hints, and returns the top-K ranked candidates.
 *
 *  `pastHints` is a compact summary of what the locator resolved to in past
 *  runs (extracted from DebugEntry logs) — used to boost candidates that match
 *  a previously-successful target. */
export function buildHealProbeScript(step: Step, pastHints: string[]): string {
  // NOTE: no backticks or ${...} inside the JS body except the two
  // interpolations here. `\\s` produces a literal \s in the emitted script.
  const hintsJson = JSON.stringify(pastHints);
  return `(function () {
  ${DOM_HELPERS}

  var step = ${JSON.stringify(step)};
  var hints = ${hintsJson};
  var MAX_CANDIDATES = 8;

  function ci(s) { return String(s == null ? "" : s).toLowerCase(); }

  // Reuse the capture script's candidate-locator generator so a healed locator
  // is expressed in the same strategies the recorder understands.
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
    // De-duplicate + keep only visible elements (a hidden target can't be the
    // intended one for an action step).
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (!el || seen.___pw_seen) continue;
      // Use the element itself as the dedup key (querySelectorAll can return
      // the same element for multiple selectors).
      var key = (el.tagName || "") + "|" + (el.id || "") + "|" + (el.className || "");
      if (seen[key]) continue;
      seen[key] = true;
      if (!visible(el)) continue;
      out.push(el);
    }
    return out;
  }

  // Score a candidate locator against the step's original locator + hints.
  // Higher = better. Exact kind+value match is best (the original locator may
  // have been slightly off, e.g. a stale testid); same kind partial-value match
  // is next; same role/text is a fuzzy signal.
  function scoreLocator(cand, orig) {
    var s = 0;
    if (!orig) return 0.3;
    if (cand.k === orig.k) {
      if (cand.v != null && orig.v != null && cand.v === orig.v) s += 1.0;
      else if (cand.v != null && orig.v != null && (ci(cand.v).indexOf(ci(orig.v)) >= 0 || ci(orig.v).indexOf(ci(cand.v)) >= 0)) s += 0.7;
      else if (cand.role === orig.role && cand.name === orig.name) s += 0.8;
      else if (cand.role === orig.role) s += 0.5;
      else s += 0.3;
    } else {
      // Cross-kind: weaker signal, but a text/role match is still meaningful.
      if (orig.v && cand.v && ci(cand.v).indexOf(ci(orig.v)) >= 0) s += 0.4;
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

  var orig = step.locator;
  var elements = collectElements();
  var all = [];
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var cands = candidatesFor(el);
    var desc = describeEl(el);
    for (var j = 0; j < cands.length; j++) {
      var c = cands[j];
      var score = scoreLocator(c, orig);
      // Skip the exact original locator (it already failed).
      if (orig && c.k === orig.k && c.v === orig.v && c.role === orig.role && c.name === orig.name) continue;
      var matchedPast = false;
      for (var h = 0; h < hints.length; h++) {
        if (hints[h] && ((c.v && ci(hints[h]).indexOf(ci(c.v)) >= 0) || (c.name && ci(hints[h]).indexOf(ci(c.name)) >= 0))) {
          matchedPast = true; break;
        }
      }
      all.push({ locator: c, description: desc, score: score, matchedPastRun: matchedPast });
    }
  }
  // Sort best-first; cap to MAX_CANDIDATES.
  all.sort(function (a, b) { return b.score - a.score; });
  return all.slice(0, MAX_CANDIDATES);
})()`;
}

/** Extract compact hints from a step's past-run debug logs — the locator
 *  values/names that previously resolved (from info-level "Resolved to <tag>"
 *  lines) so the probe can boost candidates matching them. */
function extractPastHints(entries: DebugEntry[], stepId: string): string[] {
  const hints: string[] = [];
  for (const e of entries) {
    if (e.stepId !== stepId) continue;
    for (const line of e.logs) {
      if (line.level !== "info") continue;
      // "Resolved to <button#submit…>" lines from the replayer show what the
      // locator actually resolved to in a prior (possibly successful) run.
      const m = line.m.match(/Resolved to <([^>]+)>/);
      if (m && m[1]) hints.push(m[1]);
      // "Locator: k=v" lines record the locator that was tried.
      const lm = line.m.match(/Locator: (\S+)/);
      if (lm && lm[1]) hints.push(lm[1]);
    }
  }
  return hints;
}

/** Run the Auto-Heal engine for a single failed step. Probes the page for
 *  alternative candidates, retrying up to `retries` times with a per-attempt
 *  timeout. Returns the ranked candidates (best-first) plus whether a candidate
 *  was auto-applied. The caller is responsible for re-running the step with
 *  the `appliedLocator` if `ok` is true. */
export async function healStep(
  wc: { executeJavaScript: (script: string) => Promise<unknown> },
  step: Step,
  stepIndex: number,
  pastEntries: DebugEntry[],
  settings: { autoHealRetries: number; autoHealAttemptTimeoutMs: number },
): Promise<HealResult> {
  const base: HealResult = {
    stepId: step.id,
    stepIndex,
    stepLabel: "",
    originalLocator: step.locator,
    candidates: [],
    attempts: 0,
    ok: false,
    autoApplied: false,
  };
  if (!step.locator) return base;

  const hints = extractPastHints(pastEntries, step.id);
  const retries = Math.max(1, Math.min(settings.autoHealRetries, 10));
  const timeoutMs = Math.max(1000, settings.autoHealAttemptTimeoutMs);

  let lastError: string | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = (await execWithTimeout(wc, buildHealProbeScript(step, hints), timeoutMs)) as
        | HealCandidate[]
        | null;
      if (Array.isArray(result) && result.length > 0) {
        // De-duplicate by locator identity (k+v+role+name).
        const seen = new Set<string>();
        const dedup: HealCandidate[] = [];
        for (const c of result) {
          const key = `${c.locator.k}|${c.locator.v ?? ""}|${c.locator.role ?? ""}|${c.locator.name ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push(c);
        }
        return { ...base, candidates: dedup, attempts: attempt + 1 };
      }
    } catch (err) {
      lastError = String(err);
    }
  }
  return { ...base, attempts: retries, error: lastError ?? "No heal candidates found." };
}
