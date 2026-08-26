// Auto-Heal engine: when a step's locator fails to resolve during replay, this
// probes the live training-window page for alternative target elements using
// all locator strategies (testid/role/label/placeholder/text/css/xpath) plus
// context from past-run debug logs, then returns ranked candidates. The caller
// (recorder-service) re-runs the step with the best candidate; if it succeeds
// the candidate is auto-applied. Every heal is written to the journal, and
// `replayFromCurrent` also streams its candidates to the Console on the
// `recorder:replayLog` step event — see `tryHeal` for which callers do and do
// not, and for the `recorder:healSuggestion` push that was removed because no
// window ever listened on it.
//
// The probe runs as an injected JS string (like buildReplayScript) so it can
// inspect the live DOM in the training window. It reuses the shared DOM_HELPERS
// so locator semantics stay aligned with the capture script + replayer.

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

// `buildHealProbeScript` moved to shared/heal-probe.mjs (R49): the heal MAP
// carries a probe per step, and the MCP/CLI runner has to build one too — a
// runner that cannot build a probe cannot heal, whatever its environment says.
// Re-exported here so this file stays the one import site for the callers that
// already had it.
import { buildHealProbeScript } from "../../shared/heal-probe.mjs";

export { buildHealProbeScript };


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
  // A framed locator resolves through frameLocator at run time, but the heal
  // probe scans the TOP document only — it cannot see inside an iframe, so
  // every candidate it proposed would point at the wrong document. Decline
  // with a stated reason rather than healing against the wrong scope. See
  // docs/IFRAMES.md.
  if (step.locator.frame && step.locator.frame.length > 0) {
    return { ...base, error: "Auto-Heal does not run inside an iframe — the probe scans the top document only." };
  }

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
        // De-duplicate by locator identity (k+v+role+name+exact).
        const seen = new Set<string>();
        const dedup: HealCandidate[] = [];
        for (const c of result) {
          const key = `${c.locator.k}|${c.locator.v ?? ""}|${c.locator.role ?? ""}|${c.locator.name ?? ""}|${c.locator.exact ? "!" : ""}`;
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
