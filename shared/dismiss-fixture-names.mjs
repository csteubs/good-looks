// What the overlay-dismissal fixture is CALLED, and the environment variables
// that carry its rules — the pure half of `main/services/dismiss-fixture-source.ts`.
//
// WHY IT IS SPLIT OFF. The fixture's SOURCE embeds the app's own locator engine
// (`DOM_HELPERS` + `UNIQUENESS_HELPERS` from the recorder's capture-script), so
// it cannot live here — `shared/` is pure by rule, and dragging ~600 lines of
// the recorder's most safety-critical file across the boundary is its own
// change, not a side effect of this one.
//
// These four names have no such dependency, and `capture-fixture-source.mjs`
// needs exactly them: the file to import from, and the variable naming the
// count. Splitting at that line is what lets the capture fixture reach `shared/`
// while the dismissal emission stays where its dependency is.
//
// The source module RE-EXPORTS everything here, so its existing callers
// (`playwright-runner.ts`, `check:overlay-rules`) import from one place still.

export const DISMISS_FIXTURE_FILE = "glaze-dismiss.mjs";

/** How many rules this run was given. Zero means the fixture no-ops. */
export const DISMISS_COUNT_ENV = "GLAZE_DISMISS_COUNT";

/** The prefix every per-rule variable is built from.
 *
 *  ONE definition, because two processes spell these names: the runner WRITES
 *  them (`dismissEnv`) and the generated fixture READS them. A second
 *  hand-written spelling is the drift this repo has paid for more than once —
 *  and here it would be silent in the worst way, because the runner would set
 *  variables the fixture never looks at, every test would stay green, and the
 *  feature would simply never fire. The fixture interpolates this constant
 *  rather than retyping it. */
export const DISMISS_ENV_PREFIX = "GLAZE_DISMISS_";

/** The env names carrying one rule. One variable per field rather than a JSON
 *  blob, for the reason `variableEnv` states about secrets: a blob is a single
 *  string that shows up whole in a crash dump or a process listing. */
export function dismissEnvNames(index) {
  return {
    label: `${DISMISS_ENV_PREFIX}${index}_LABEL`,
    target: `${DISMISS_ENV_PREFIX}${index}_TARGET`,
  };
}

/**
 * The environment one run's armed rules travel in — the whole set, count
 * included, so a caller cannot supply rules without the count that makes the
 * fixture read them.
 *
 * ONE variable per rule per field, never a JSON blob of the lot: a blob is a
 * single string that shows up whole in a crash dump or a process listing. The
 * target is itself JSON because a locator is structured, but that is one rule's
 * locator per variable.
 *
 * Here rather than in each runner because BOTH write it now — the app for a
 * recorded run, the MCP and CLI for an unattended one — and the fixture reads it
 * back by name inside a Playwright worker. Three processes, one spelling; a
 * transcribed copy is a rule that arms in one and not the other, silently,
 * because a rule that never fires looks exactly like a page with no banner.
 */
export function dismissEnv(rules) {
  const list = rules ?? [];
  const out = { [DISMISS_COUNT_ENV]: String(list.length) };
  list.forEach((rule, index) => {
    const names = dismissEnvNames(index);
    out[names.label] = rule.label || rule.host;
    out[names.target] = JSON.stringify(rule.target);
  });
  return out;
}
