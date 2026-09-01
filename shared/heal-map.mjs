// THE HEAL MAP — what a run hands the heal fixture, and the only thing that
// makes run-time Auto-Heal do anything at all.
//
// Canonical locator key → the step it belongs to, plus a pre-built probe. The
// fixture looks a failing locator up by key and takes `throw err` on a miss:
//
//     if (!entry || !entry.probe || !isResolveFailure(err)) throw err;
//
// So the map is not a tuning knob. Absent, healing is off no matter what
// `GLAZE_HEAL` says — which is precisely R49, where the switch was on, the
// fixture installed itself, patched every locator factory, and healed nothing
// on every unattended run because the file it was pointed at did not exist.
//
// ── Why this is in shared/ ────────────────────────────────────────────────
// Two processes start runs. The app builds this from a TestRecord's steps; the
// MCP and CLI build it from the same steps read off disk. One builder, because
// the KEY has to match what the fixture derives from Playwright's factory
// arguments (see heal-key.mjs) and the PROBE has to rank candidates the same way
// the trainer does (see heal-probe.mjs). Two builders would not fail — they
// would disagree, and disagreeing here means a locator that heals in the app and
// misses in CI, or a run that clicks a plausible wrong element and passes.
//
// ── The label, and why it is injected ─────────────────────────────────────
// `stepLabel` is the human phrase in a heal artifact ("could not heal: click
// «Sign in»"). It comes from `describeStep`, which still lives in
// `main/services/script-generator.ts` alongside its own mirror in
// `renderer/lib/describe-step.ts` — a duplication with a parity test over it and
// its own extraction to do. Rather than transcribe a third copy, the label is a
// parameter: the app passes its `describeStep`, an unattended run passes none,
// and the fixture already falls back to the step id (`entry.stepLabel ||
// entry.stepId`). The difference is visible in the artifact rather than silent
// in the ranking, which is the right place for a gap to sit.
//
// Pure: steps in, a plain object out. No fs, no IPC, no process.

import { healKeyFor } from "./heal-key.mjs";
import { buildHealProbeScript } from "./heal-probe.mjs";

/** Seeds a map entry may carry, at most. The fixture tries at most three
 *  probe candidates for the same reason: a longer list only delays the
 *  rethrow. Re-applied here so a hand-edited proposals file cannot hand the
 *  fixture an unbounded list. */
export const MAX_MAP_SEEDS = 3;

/**
 * Build the map for one run's steps.
 *
 * `seedsByKey` (optional) is cross-test propagation's half: known-good
 * locators for a key, from pending proposals, which the fixture tries BEFORE
 * spending a probe when that key actually fails on the live page. A seed
 * that works records an ordinary healed event — the map carries it, it never
 * touches the stored test, and the journal still shows that the page
 * changed.
 *
 * @param {Array<object>} steps
 * @param {{ describeStep?: (step: object) => string, seedsByKey?: Record<string, Array<object>> }} [options]
 * @returns {Record<string, unknown>}
 */
export function buildHealMap(steps, { describeStep, seedsByKey } = {}) {
  const map = {};
  (steps ?? []).forEach((step, index) => {
    if (!step?.locator || step.disabled) return;
    // Framed steps are excluded from the run-time heal fixture: the probe is a
    // top-document query and cannot reach inside an iframe. A key that never
    // gets a probe simply is not healed, which is the honest outcome.
    if (step.locator.frame && step.locator.frame.length > 0) return;
    const key = healKeyFor(step.locator);
    // First step wins on a collision. Two steps with an identical locator act
    // on the same element, so they would share a fingerprint anyway.
    if (map[key]) return;
    const seeds = Array.isArray(seedsByKey?.[key]) ? seedsByKey[key].slice(0, MAX_MAP_SEEDS) : [];
    map[key] = {
      stepId: step.id,
      stepIndex: index,
      stepLabel: describeStep ? describeStep(step) : "",
      locator: step.locator,
      probe: buildHealProbeScript(step, []),
      ...(seeds.length > 0 ? { seeds } : {}),
    };
  });
  return map;
}
