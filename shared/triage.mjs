// Site problem or runner problem.
//
// Pure (see the admission rule in run-pacing.mjs): it takes a bundle of records
// somebody else has already read and returns a verdict. That is what lets the
// app query them through metrics-store and the MCP query the same database
// directly, without either one growing its own copy of the reasoning.
//
// WHY THIS EXISTS. Every signal below was already on disk before this file
// existed, in five files that do not join: network status per step, console
// page errors, the heal journal, the cross-browser and cross-dataset outcomes,
// and the visual diff. Answering "is it them or is it me?" meant opening all
// five by hand for one run, which is why it was never actually answered. The
// metrics DB did the joining in Phase 2 — runEvidence() and siblingRuns() were
// written for this caller specifically. This is the reasoning on top.
//
// FOUR RULES, each written against a failure:
//
//   1. EVIDENCE FIRST, VERDICT SECOND. `evidence` is the product; `verdict` is
//      a one-word summary of it. During a real outage a confident wrong verdict
//      costs far more than an honest "unknown", because it sends someone to the
//      wrong team with a citation. Every entry says which signal fired, which
//      way it points and what the underlying number was, so the verdict can be
//      disagreed with on its own evidence.
//   2. `unknown` IS FIRST-CLASS. A run with no capture artifacts has almost no
//      signal. It must say so rather than reason from pass/fail alone — which
//      is a coin toss dressed up as a diagnosis.
//   3. NEVER FATAL. Nothing here changes a run's status, and no caller may gate
//      on it. Same rule accessibility follows, pinned there by a source-level
//      assertion in a11y-diff.test.ts and pinned here by check:triage. A
//      classifier that can fail a run is a classifier that gets switched off.
//   4. WHAT WE COULD NOT SEE IS PART OF THE ANSWER. `limits` is not a
//      footnote. The capture fixture caps console and network per RUN, not per
//      step, so on a busy site whole steps keep no requests at all — and "no
//      failing request on that step" then reads as evidence the site was
//      healthy when it means the evidence was discarded. Anything drawn from an
//      ABSENCE is suppressed when the counts say the absence isn't real.

/** Weights, not booleans: "the page's own JS threw on the failing step" and
 *  "the screenshot differs" are both site-ward and are not the same claim.
 *  Scale is deliberately coarse — 3 strong, 2 moderate, 1 weak. Anything finer
 *  implies a precision the underlying data does not have. */
const STRONG = 3;
const MODERATE = 2;
const WEAK = 1;

/** Evidence needed before the lead side is stated at full strength. Four is one
 *  strong signal plus corroboration, or two moderates: below that the verdict
 *  is reported at reduced confidence rather than withheld, because a single 5xx
 *  on the failing step IS worth saying out loud — just not at 0.9. */
const SATURATION = 4;

/** Share of total weight the lead side needs before it is named. Below this,
 *  both sides have enough to matter and the honest answer is "mixed" — which
 *  in practice is the most common real shape: a stale locator on a page that
 *  also started erroring. */
const LEAD_SHARE = 0.7;

/** Never 1.0. The classifier reasons from a cache of a lossy capture; certainty
 *  is not available to it and claiming it invites the verdict to be read
 *  instead of the evidence. */
const MAX_CONFIDENCE = 0.95;

/** What each entry in `limits` costs, and the floor it cannot drive confidence
 *  below. Per-entry rather than a flat "were there any": a run that captured
 *  nothing AND has no siblings AND dropped its console is three separate blind
 *  spots, and a binary penalty prices it the same as one — which reads as "we
 *  looked and found little" when it means "we could barely look". The floor
 *  exists because the limits are about what is MISSING: a 5xx observed on the
 *  failing step is still a 5xx, however much else went unrecorded. */
const LIMIT_COST = 0.15;
const LIMIT_FLOOR = 0.4;

/** Within this fraction of the test's own timeout, the step did not fail on
 *  what the page did — it ran out of budget. */
const TIMEOUT_PROXIMITY = 0.9;

/** A step healing this often is not an incident, it is locator decay. */
const CHRONIC_HEALS = 3;

/**
 * How many past runs of the same test the cross-run signals reason over.
 *
 * The classifier itself takes no view on the window — `siblings` is whatever
 * the caller passes — but the app and the MCP must pick the SAME one, or the
 * same run triaged from the two surfaces gives two answers and neither is
 * wrong. Wide enough that a test run across three engines has all three in the
 * window; narrow enough that it does not reach back into a different version of
 * the site.
 */
export const TRIAGE_COHORT = 30;

/** Failures whose text is "we waited and it never showed up". These carry no
 *  information about WHY on their own, which is exactly why the clean-network,
 *  clean-console version of them is evidence about the test rather than the
 *  site. Matched against the NORMALIZED signature, so durations are already
 *  `<ms>` and there is no point matching digits. */
const WAIT_FAILURE = /timeout|timed out|waiting for|not visible|to be visible|exceeded/i;

/** An AMBIGUOUS locator — one that matched several elements.
 *
 *  Checked BEFORE `WAIT_FAILURE`, because a strict-mode violation's text also
 *  contains "Timeout … exceeded" and "waiting for locator", so it matched the
 *  wait shape and came out as `clean-wait` — whose advice is "re-pick the
 *  failing step's element". That is the one fix guaranteed not to work: the
 *  picker hands back the same non-unique locator. Two spellings, because the
 *  app's own trainer reports this in its own words rather than Playwright's. */
const AMBIGUOUS_FAILURE = /strict mode violation|resolved to \d+ elements|matched \d+ elements/i;

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Group runs by a key, dropping the ones that don't declare it. Returns a Map
 *  of key → { runs, failed }. Used for all three cross-run signals, which are
 *  the same question asked of `browser`, `dataset_id` and capture. */
function outcomesBy(runs, key) {
  const groups = new Map();
  for (const r of runs) {
    const k = key(r);
    if (k === null || k === undefined || k === "") continue;
    const g = groups.get(k) ?? { runs: 0, failed: 0 };
    g.runs += 1;
    if (r.status === "failed") g.failed += 1;
    groups.set(k, g);
  }
  return groups;
}

/**
 * Which of a grouped set failed everywhere versus in exactly one place.
 *
 * Both cross-run signals in §4.1 are this shape, and they must be mutually
 * exclusive or a run could be cited as evidence for both sides at once. They
 * are: `all` requires that no group passes cleanly, `only` requires that one
 * does. Both require at least two groups — "fails on every engine" drawn from a
 * single engine is not a finding, and that was the easiest possible bug to
 * write here.
 */
function spread(groups) {
  if (groups.size < 2) return { kind: "insufficient", groups };
  const failing = [];
  const clean = [];
  for (const [k, g] of groups) {
    if (g.failed > 0) failing.push(k);
    else clean.push(k);
  }
  if (failing.length === 0) return { kind: "none-failed", failing, clean, groups };
  if (clean.length === 0) return { kind: "all", failing, clean, groups };
  if (failing.length === 1) return { kind: "only", failing, clean, groups };
  return { kind: "some", failing, clean, groups };
}

/**
 * Classify one failed run.
 *
 * `run` and `steps` come from metrics-query's runEvidence(); `siblings` from
 * siblingRuns() — the caller chooses that window, because "the last 50 runs"
 * and "the last 50 runs of this branch" are different questions and neither
 * belongs to a pure function. `stepHistory` is the stepHealth() row for the
 * failing step, or null: chronic locator decay is the one signal that needs
 * history the run itself cannot contain.
 */
export function triageRun({ run, steps = [], siblings = [], stepHistory = null } = {}) {
  const evidence = [];
  const limits = [];

  if (!run) {
    return verdictFrom(evidence, limits, null, ["No run was found to classify."]);
  }

  // A passed run has nothing to triage. Answering anything else here is how a
  // classifier ends up explaining failures that did not happen.
  if (run.status !== "failed") {
    return verdictFrom(evidence, limits, null, [
      `This run ${run.status === "passed" ? "passed" : `is ${run.status}`} — there is no failure to attribute.`,
    ]);
  }

  const failing =
    steps.find((s) => run.failed_step_id && s.step_id === run.failed_step_id) ??
    steps.find((s) => s.status === "failed") ??
    null;

  const add = (signal, direction, weight, detail) =>
    evidence.push({ signal, direction, weight, detail });

  // ---- What the capture could not tell us -------------------------------
  //
  // Established BEFORE any evidence is read, because it decides which of the
  // step-level signals below are allowed to argue from an absence.

  if (!run.has_artifacts) {
    limits.push(
      "This run captured no artifacts, so there is no per-step network, console or visual evidence — only the run's own outcome.",
    );
  }
  const networkTrustworthy = run.has_artifacts && !num(run.network_dropped);
  const consoleTrustworthy = run.has_artifacts && !num(run.console_dropped);
  if (run.has_artifacts && num(run.network_dropped)) {
    limits.push(
      `${run.network_dropped} network entries were discarded by the per-run cap, so "no failing request" cannot be concluded from this run.`,
    );
  }
  if (run.has_artifacts && num(run.console_dropped)) {
    limits.push(
      `${run.console_dropped} console entries were discarded by the per-run cap, so a quiet console is not evidence here.`,
    );
  }
  if (run.has_artifacts && !failing) {
    limits.push(
      "The run failed but no individual step is marked failed, so step-level evidence could not be located.",
    );
  }

  // ---- Step-level evidence ----------------------------------------------

  if (failing) {
    const worst = num(failing.net_worst_status);
    const worstApi = num(failing.net_worst_api_status);

    if (worst !== null && worst >= 500) {
      add("server-error", "site", STRONG, `The failing step saw a ${worst} response.`);
    } else if (worstApi !== null && worstApi >= 400) {
      // Only when there is no 5xx, so one broken request is not counted twice.
      // A 4xx on a NAVIGATION is deliberately not evidence: a 404 page is a
      // legitimate thing to have a test for.
      add(
        "api-error",
        "site",
        STRONG,
        `A non-navigational request on the failing step returned ${worstApi}.`,
      );
    }

    if (num(failing.console_page_errors)) {
      add(
        "page-error",
        "site",
        STRONG,
        `The page's own JavaScript threw ${failing.console_page_errors} time(s) on the failing step.`,
      );
    }

    if (failing.heal_failed) {
      add(
        "heal-exhausted",
        "site",
        STRONG,
        failing.heal_failed === "no-candidates"
          ? "Auto-Heal found no candidate locator for this element at all."
          : "Auto-Heal tried every candidate locator and none matched.",
      );
    } else if (num(failing.healed)) {
      // Mutually exclusive with the above by construction: the element cannot
      // both be gone under every locator and have been found under a new one.
      add(
        "heal-succeeded",
        "runner",
        STRONG,
        "Auto-Heal found the element under a different locator, so it existed — the stored locator was stale.",
      );
    }

    if (failing.diff_state === "changed") {
      add(
        "visual-changed",
        "site",
        WEAK,
        "The same step also rendered differently from its baseline.",
      );
    }

    const ms = num(failing.ms);
    const budget = num(run.test_timeout_ms);
    if (ms !== null && budget !== null && budget > 0 && ms >= budget * TIMEOUT_PROXIMITY) {
      add(
        "timeout-budget",
        "runner",
        STRONG,
        `The failing step ran ${ms}ms against a ${budget}ms test timeout — it hit the budget, not a page error.`,
      );
    }

    // The one signal that is an argument from ABSENCE, and therefore the one
    // gated on the dropped counts. "We waited for something that never came,
    // while the network and console stayed clean" is the classic wrong-locator
    // shape — but only if we can believe the clean part.
    const sig = run.error_signature ?? "";
    // Ambiguity first: it is a WAIT-shaped error with an opposite fix, so
    // letting it fall through to `clean-wait` produces confident wrong advice.
    if (AMBIGUOUS_FAILURE.test(sig)) {
      add(
        "ambiguous-locator",
        "runner",
        MODERATE,
        "The step's locator matched several elements, so Playwright refused it rather than picking one — the page is fine and the locator is too broad.",
      );
    }
    const looksLikeWait = !AMBIGUOUS_FAILURE.test(sig) && WAIT_FAILURE.test(sig);
    const netClean = (worst === null || worst < 400) && (worstApi === null || worstApi < 400);
    const consoleClean = !num(failing.console_page_errors);
    if (looksLikeWait && netClean && consoleClean && networkTrustworthy && consoleTrustworthy) {
      add(
        "clean-wait",
        "runner",
        MODERATE,
        "The step timed out waiting, while every request on it succeeded and the page threw nothing — the page was healthy while we looked for the wrong thing.",
      );
    } else if (looksLikeWait && netClean && consoleClean) {
      limits.push(
        "The failure looks like a wait that timed out, but the capture is too lossy to confirm the page was healthy while it waited.",
      );
    }
  }

  if (stepHistory && num(stepHistory.heals) >= CHRONIC_HEALS) {
    add(
      "chronic-healing",
      "runner",
      MODERATE,
      `This step has been healed ${stepHistory.heals} times across ${stepHistory.runs} runs — the locator decays faster than the page changes.`,
    );
  }

  // ---- Cross-run evidence ------------------------------------------------
  //
  // `siblings` plus this run. Including this run matters: with a window of one
  // sibling, leaving it out makes every spread "insufficient".

  const cohort = [run, ...siblings];

  const engines = spread(outcomesBy(cohort, (r) => r.browser));
  if (engines.kind === "all") {
    add(
      "all-engines",
      "site",
      engines.failing.length >= 3 ? STRONG : MODERATE,
      `Fails on every engine tried (${engines.failing.join(", ")}) — not an engine quirk.`,
    );
  } else if (engines.kind === "only" && engines.failing[0] === run.browser) {
    add(
      "single-engine",
      "runner",
      STRONG,
      `Fails on ${run.browser} only; ${engines.clean.join(", ")} pass — engine-specific selector or timing.`,
    );
  }

  const datasets = spread(outcomesBy(cohort, (r) => r.dataset_id));
  if (datasets.kind === "all") {
    add(
      "all-datasets",
      "site",
      MODERATE,
      `Fails on every dataset row tried (${datasets.failing.length}) — not the data.`,
    );
  } else if (datasets.kind === "only" && datasets.failing[0] === run.dataset_id) {
    add(
      "single-dataset",
      "runner",
      MODERATE,
      `Fails only on dataset row "${run.dataset_name ?? run.dataset_id}" while the others pass — the data, not the site.`,
    );
  }

  const capture = spread(outcomesBy(cohort, (r) => (num(r.capture_ms) ? "captured" : "plain")));
  if (capture.kind === "only" && capture.failing[0] === "captured" && num(run.capture_ms)) {
    add(
      "capture-only",
      "runner",
      MODERATE,
      "Fails only on runs with capture enabled; uncaptured runs pass — instrumentation overhead crossed a ceiling.",
    );
  }

  if (siblings.length === 0) {
    limits.push(
      "No other runs of this test were available, so nothing could be concluded from engines, datasets or capture.",
    );
  }

  return verdictFrom(evidence, limits, failing, []);
}

/** Turn weighted evidence into a verdict, a confidence and a next step. Split
 *  out so every early return above lands in the same shape — a classifier with
 *  two ways of describing "I have nothing" grows a caller that handles one. */
function verdictFrom(evidence, limits, failingStep, reasons) {
  const weigh = (dir) =>
    evidence.filter((e) => e.direction === dir).reduce((sum, e) => sum + e.weight, 0);
  const site = weigh("site");
  const runner = weigh("runner");
  const total = site + runner;

  let verdict = "unknown";
  let confidence = 0;

  if (total > 0) {
    const lead = Math.max(site, runner);
    const share = lead / total;
    // Under-evidenced verdicts are reported at reduced confidence rather than
    // suppressed: one 5xx on the failing step is worth saying, just not loudly.
    const saturation = Math.min(1, (verdictIsMixed(share) ? total : lead) / SATURATION);
    // Anything we could not see makes every verdict less trustworthy, whichever
    // way it points — the missing evidence had no reason to favour one side.
    const penalty = Math.max(LIMIT_FLOOR, 1 - LIMIT_COST * limits.length);

    if (verdictIsMixed(share)) {
      verdict = "mixed";
      confidence = saturation * penalty;
    } else {
      verdict = site > runner ? "site" : "runner";
      confidence = share * saturation * penalty;
    }
    confidence = Math.min(MAX_CONFIDENCE, Math.round(confidence * 100) / 100);
  }

  return {
    verdict,
    confidence,
    // Strongest first, so a truncated read still gets the load-bearing part.
    evidence: evidence
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map(({ signal, direction, detail }) => ({ signal, direction, detail })),
    limits: reasons.concat(limits),
    failingStepId: failingStep ? failingStep.step_id : null,
    suggestedNext: suggest(verdict, evidence, limits, reasons),
  };
}

function verdictIsMixed(share) {
  return share < LEAD_SHARE;
}

/**
 * One concrete thing to do next.
 *
 * Keyed off the strongest signal rather than the verdict, because "site" is not
 * an action and the strongest signal usually is one. This is the field people
 * read first, so it must never be a restatement of the verdict.
 */
function suggest(verdict, evidence, limits, reasons) {
  if (reasons.length > 0) return reasons[0];

  const strongest = evidence.slice().sort((a, b) => b.weight - a.weight)[0];
  switch (strongest?.signal) {
    case "server-error":
    case "api-error":
      return "Open the run's network report for the failing step and take the failing request to whoever owns that endpoint.";
    case "page-error":
      return "Open the run's console report — the page threw before the step could succeed, so the stack trace is the bug report.";
    case "heal-exhausted":
      return "Open the failing step in the trainer and re-pick the element; it is not reachable under any locator the healer knows.";
    case "heal-succeeded":
      return "Review the heal in the Heals list and accept it if the new locator is right — the element moved, the page did not break.";
    case "timeout-budget":
      return "Raise this test's timeout, or split the failing step — it ran out of budget rather than hitting an error.";
    case "single-engine":
      return "Re-run on the other engines to confirm, then look for an engine-specific selector or a race on this one.";
    case "all-engines":
      return "Check the site itself before touching the test — every engine sees this.";
    case "ambiguous-locator":
      return "Narrow the failing step's locator — scope it to an ancestor rather than adding an index, which picks by DOM order. `get_step_matches` lists exactly what it matched.";
    case "clean-wait":
      return "Re-pick the failing step's element; the page was healthy for the whole wait, so the locator is looking for the wrong thing.";
    case "chronic-healing":
      return "Give this step a stable locator — a test id if the page has one. It has been healed repeatedly, so each heal is buying days.";
    case "single-dataset":
      return "Compare the failing dataset row against one that passes; the difference is in the data.";
    case "all-datasets":
      return "Check the site — every dataset row fails, so the input is not what is breaking it.";
    case "capture-only":
      return "Re-run with capture off to confirm, then lower the capture settings or raise the timeout for this test.";
    case "visual-changed":
      return "Compare the failing step's screenshot with its baseline — the page rendered differently as well as failing.";
    default:
      return limits.length > 0
        ? "Re-run this test with capture enabled — there is not enough evidence on disk to attribute this failure."
        : "Open the run's log and artifacts; no signal here points either way on its own.";
  }
}
