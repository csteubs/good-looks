// Post-run evaluation for `aiCheck` steps: pair each check's screenshot
// (written by glazeAiCheck during the run) with its claim, ask the configured
// model, and record a verdict per check.
//
// The rules that keep it honest:
//
// - **The run's own verdict is sealed.** Evaluation happens after exit and
//   never touches runStatus — a model's opinion about a screenshot must not
//   be able to fail a run that Playwright passed, or vice versa. Failed
//   claims are counted on the RunRecord and said in the output panel.
//
// - **Unevaluated is a first-class outcome.** No vision-capable model, a
//   provider that is down, a screenshot the helper could not take — each
//   check records WHY it was not judged, with the provider's own sentence.
//   Silence is the one outcome this pipeline refuses.
//
// - **Pairing is positional and matches the generator exactly.** The
//   generator numbers non-disabled aiCheck steps 1..N in expanded order
//   (`aiCheckIdx`); this module counts the same way over the same list. Two
//   counters over one list is the else/loop balance argument again — the
//   test pins them against each other.

import * as fs from "fs";
import * as path from "path";

import { visionVerdict } from "./llm-service.js";
import type { Step } from "../recorder/types.js";

export interface AiCheckResult {
  /** index into the run's expanded step list */
  stepIndex: number;
  claim: string;
  verdict: "pass" | "fail" | "unevaluated";
  /** the model's sentence, or the reason no judgement happened */
  reason: string;
}

/** After two consecutive provider failures, stop calling — the remaining
 *  checks record the same reason without hammering a dead endpoint. */
const MAX_CONSECUTIVE_PROVIDER_FAILURES = 2;

export async function evaluateAiChecks(params: {
  steps: Step[];
  dir: string;
  emit: (line: string) => void;
}): Promise<AiCheckResult[]> {
  const out: AiCheckResult[] = [];
  let ordinal = 0;
  let consecutiveFailures = 0;
  let providerDown: string | null = null;

  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i];
    if (step.type !== "aiCheck" || step.disabled) continue;
    ordinal += 1;
    const claim = step.text ?? "";
    const shot = path.join(params.dir, `ai-check-${ordinal}.png`);

    if (providerDown) {
      out.push({ stepIndex: i, claim, verdict: "unevaluated", reason: providerDown });
      continue;
    }
    let png: string;
    try {
      png = fs.readFileSync(shot).toString("base64");
    } catch {
      out.push({
        stepIndex: i,
        claim,
        verdict: "unevaluated",
        reason: "No screenshot was captured for this check — see the run output for the helper's error.",
      });
      continue;
    }
    try {
      const verdict = await visionVerdict({ claim, pngBase64: png });
      consecutiveFailures = 0;
      out.push({
        stepIndex: i,
        claim,
        verdict: verdict.pass ? "pass" : "fail",
        reason: verdict.reason,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_PROVIDER_FAILURES) {
        providerDown = reason;
      }
      out.push({ stepIndex: i, claim, verdict: "unevaluated", reason });
    }
  }

  if (out.length > 0) {
    const passed = out.filter((r) => r.verdict === "pass").length;
    const failed = out.filter((r) => r.verdict === "fail").length;
    const unevaluated = out.filter((r) => r.verdict === "unevaluated").length;
    const parts = [`AI checks: ${passed} passed`];
    if (failed > 0) parts.push(`${failed} FAILED`);
    if (unevaluated > 0) parts.push(`${unevaluated} unevaluated`);
    params.emit(parts.join(", ") + "\n");
    for (const r of out) {
      if (r.verdict === "fail") {
        params.emit(`  ✗ ${JSON.stringify(r.claim)} — ${r.reason}\n`);
      } else if (r.verdict === "unevaluated") {
        params.emit(`  – ${JSON.stringify(r.claim)} not evaluated: ${r.reason}\n`);
      }
    }
  }
  return out;
}
