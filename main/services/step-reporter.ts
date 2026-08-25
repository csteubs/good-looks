// A Playwright reporter that emits per-step progress as parseable JSON lines on
// stdout. The backend (playwright-runner.ts) strips these `__GLAZE_STEP__:` lines
// out of the visible run output and pushes them to the renderer as `runner:step`
// events, so the Steps tab can highlight each step as the test runs.
//
// TWO categories map to a line of the generated spec, and it took a real bug to
// establish that:
//
//  • `pw:api` — every page/locator call (goto, click, fill, press, waitFor…).
//  • `expect` — every assertion. These were skipped as "noise" originally, on
//    the assumption that the interesting steps were the API calls. They are the
//    opposite of noise: an assertion is the commonest way a recorded test
//    fails, and dropping it meant the failing step was reported by NOTHING, so
//    the step list highlighted nothing and the replay recorded no failed index.
//
// Fixture and hook steps are still skipped — those are Playwright's own setup,
// not lines anybody recorded.
//
// The step's `location.line` (1-based) is emitted so the backend can map it back
// to a step index via the spec file.
//
// WHAT THIS REPORTER CANNOT SEE: an action the capture/heal/settle fixtures have
// wrapped. Playwright takes a step's location from the first stack frame outside
// its own library, which for a wrapped action is the FIXTURE, so the file guard
// below drops it — correctly, or line 366 of the fixture would be read as line
// 366 of the spec. Those steps announce themselves from inside the wrapper
// instead; see capture-fixture-source.ts. The two never overlap: installing that
// wrapper is exactly what takes the step's location off the spec.

import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

import { STEP_MARKER } from "../../shared/step-marker.mjs";

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(STEP_MARKER + JSON.stringify(payload) + "\n");
}

/** A step that maps to a line of the spec, and is therefore highlightable. */
function reportable(test: TestCase, step: TestStep): boolean {
  if (step.category !== "pw:api" && step.category !== "expect") return false;
  // Only steps located in the spec file itself map to a highlightable step.
  // (Fixture-injected calls live in another file and would otherwise collide on
  // line number.)
  if (step.location?.file && test.location?.file && step.location.file !== test.location.file) {
    return false;
  }
  return typeof step.location?.line === "number";
}

export default class StepReporter implements Reporter {
  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    if (!reportable(test, step)) return;
    emit({ event: "begin", line: step.location!.line, title: step.title });
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (!reportable(test, step)) return;
    emit({
      event: "end",
      line: step.location!.line,
      title: step.title,
      ok: !step.error,
      duration: step.duration,
    });
  }
}
