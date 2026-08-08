// What to tell the user before a test is duplicated.
//
// Duplicating is cheap and reversible, so this is NOT a confirmation — it is a
// list of the things that behave differently in a copy than people expect. Two
// kinds of surprise, and both have bitten in other tools:
//
//   • Something came across that the user thinks of as belonging to the
//     original — a stored password, a session cookie recorded during training.
//     The copy now runs against the same credential from a second place.
//   • Something did NOT come across, and its absence looks like data loss
//     rather than a deliberate line: no runs, no screenshots, no accepted
//     accessibility violations, no Auto-Heal history.
//
// A test with none of this active gets no dialog at all. A prompt that always
// appears is a prompt nobody reads, and the whole value here is that its
// appearance means something.
//
// Pure and renderer-side: every input is already on the `TestRecord` the
// sidebar holds, apart from how many secrets have stored values, which the
// caller fetches from `tests:secretStatus` (names only — never values).

import type { TestRecord } from "./recorder-types";

export type DuplicationWarningId =
  | "secrets"
  | "variables"
  | "cookies"
  | "captures"
  | "datasets"
  | "flowCalls"
  | "isFlow"
  | "scriptEdited"
  | "imported";

export interface DuplicationWarning {
  id: DuplicationWarningId;
  /** What is active, as a noun phrase. */
  title: string;
  /** What it means for the copy specifically. */
  detail: string;
}

/** What a duplicate never inherits. Stated in the dialog because the absence of
 *  a test's run history is the kind of thing that reads as a bug when you meet
 *  it later without having been told. */
export const NOT_COPIED: readonly string[] = [
  "Run history and logs",
  "Screenshots, visual baselines and step notes",
  "Accepted accessibility violations",
  "Auto-Heal history",
  "AI debug sessions",
];

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The runner/trainer features active in `test` that a copy handles in a way
 * worth saying out loud. Empty means duplicate without asking.
 *
 * `storedSecrets` is how many of the test's secret variables actually have a
 * value saved, which is a different number from how many are declared — a
 * declared secret with nothing behind it is not a credential being copied.
 */
export function describeDuplicationWarnings(
  test: Pick<TestRecord, "steps" | "variables" | "datasets" | "isFlow" | "scriptEdited" | "sourceDir">,
  storedSecrets = 0,
): DuplicationWarning[] {
  const out: DuplicationWarning[] = [];
  const steps = test.steps ?? [];
  const countOf = (type: string) => steps.filter((s) => s.type === type).length;

  const variables = test.variables ?? [];
  if (variables.length > 0) {
    out.push({
      id: "variables",
      title: `${plural(variables.length, "variable")} in use`,
      detail:
        "Names, kinds and default values are copied, so every ${…} reference in the steps still resolves.",
    });
  }

  // Deliberately separate from the variables line: this one is about a
  // credential existing in a second place on disk, not about a setting.
  if (storedSecrets > 0) {
    out.push({
      id: "secrets",
      title: `${plural(storedSecrets, "stored secret value")}`,
      detail:
        "Copied too, so the new test runs without re-entering them — the same credential is then stored under two tests, and deleting one leaves the other.",
    });
  }

  const cookies = countOf("cookie");
  if (cookies > 0) {
    out.push({
      id: "cookies",
      title: `${plural(cookies, "cookie step")}`,
      detail:
        "Copied with their recorded values. A session token captured while training expires for the copy exactly when it expires for the original.",
    });
  }

  const captures = countOf("capture");
  if (captures > 0) {
    out.push({
      id: "captures",
      title: `${plural(captures, "step")} capturing a value at run time`,
      detail: "The copy captures into its own variables; nothing is shared between the two runs.",
    });
  }

  const datasets = test.datasets ?? [];
  if (datasets.length > 0) {
    out.push({
      id: "datasets",
      title: `${plural(datasets.length, "dataset row")}`,
      detail: "Copied, so the new test sweeps over the same rows.",
    });
  }

  const flowCalls = countOf("runFlow");
  if (flowCalls > 0) {
    out.push({
      id: "flowCalls",
      title: `${plural(flowCalls, "step")} running another test as a flow`,
      detail:
        "The copy calls the same flows — editing one of those flows still changes both tests.",
    });
  }

  if (test.isFlow) {
    out.push({
      id: "isFlow",
      title: "This test is a reusable flow",
      detail:
        "The copy is a second flow that no test calls yet. Tests calling this one keep calling the original.",
    });
  }

  if (test.sourceDir) {
    out.push({
      id: "imported",
      title: "Imported test",
      detail:
        "Its folder of sibling modules is copied alongside the spec so relative imports still resolve. The spec is copied word for word, so its test(…) title still reads as the original's name.",
    });
  } else if (test.scriptEdited) {
    out.push({
      id: "scriptEdited",
      title: "The script was edited by hand",
      detail:
        "It's copied word for word rather than regenerated, so the copy's test(…) title still reads as the original's name.",
    });
  }

  return out;
}
