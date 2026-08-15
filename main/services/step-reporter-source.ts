// The StepReporter as a raw JS string, so playwright-runner.ts can write it
// next to the specs at runtime (the scripts dir lives in userData, far from the
// app's compiled backend). This is plain JavaScript (no TypeScript type imports)
// because Playwright loads it as a .mjs module via its own Babel transform, which
// does not understand `import type`. Kept in sync with step-reporter.ts by hand
// — `check:step-progress` fails if the two disagree about which categories are
// reported.

import { STEP_MARKER } from "./step-marker.js";

export const stepReporterSource = `// Per-step progress reporter for Test Recorder. Emits parseable JSON lines on
// stdout that the backend strips out and forwards to the renderer as
// runner:step events, so the Steps tab can highlight each step as it runs.
//
// Both categories a generated spec's lines produce are reported: "pw:api" for
// page/locator calls and "expect" for assertions. Skipping the latter is what
// left a failing assertion — the commonest way a test fails — reported by
// nothing at all. Fixture and hook steps are still skipped: they are
// Playwright's own setup, not lines anybody recorded.
const STEP_MARKER = ${JSON.stringify(STEP_MARKER)};

function emit(payload) {
  process.stdout.write(STEP_MARKER + JSON.stringify(payload) + "\\n");
}

// A step that maps to a line of the spec, and is therefore highlightable. An
// action a fixture has wrapped is located in the FIXTURE, not the spec, so it
// is dropped here and announced from inside that wrapper instead.
function reportable(test, step) {
  if (step.category !== "pw:api" && step.category !== "expect") return false;
  if (step.location && step.location.file && test && test.location && test.location.file && step.location.file !== test.location.file) return false;
  return step.location && typeof step.location.line === "number";
}

class StepReporter {
  onStepBegin(test, _result, step) {
    if (!reportable(test, step)) return;
    emit({ event: "begin", line: step.location.line, title: step.title });
  }

  onStepEnd(test, _result, step) {
    if (!reportable(test, step)) return;
    emit({
      event: "end",
      line: step.location.line,
      title: step.title,
      ok: !step.error,
      duration: step.duration,
    });
  }
}

export default StepReporter;
`;
