// A Playwright reporter that emits per-step progress as parseable JSON lines on
// stdout. The backend (playwright-runner.ts) strips these `__GLAZE_STEP__:` lines
// out of the visible run output and pushes them to the renderer as `runner:step`
// events, so the Steps tab can highlight each step as the test runs.
//
// We only care about `pw:api` steps (Playwright API calls like page.goto, .click,
// .fill, expect(...).toBeVisible, etc.) — those map 1:1 to the lines in the
// generated spec. Fixture/hook/expect-category steps are skipped to avoid noise.
// The step's `location.line` (1-based) is emitted so the backend can map it back
// to a step index via the spec file.

import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

function emit(payload: Record<string, unknown>): void {
  process.stdout.write("__GLAZE_STEP__:" + JSON.stringify(payload) + "\n");
}

export default class StepReporter implements Reporter {
  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "pw:api") return;
    // Only steps located in the spec file itself map to a highlightable step.
    // (Screenshot calls injected by the capture fixture live in another file and
    // could otherwise collide on line number.)
    if (step.location?.file && test.location?.file && step.location.file !== test.location.file) return;
    const line = step.location?.line;
    if (typeof line !== "number") return;
    emit({ event: "begin", line, title: step.title });
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    if (step.category !== "pw:api") return;
    if (step.location?.file && test.location?.file && step.location.file !== test.location.file) return;
    const line = step.location?.line;
    if (typeof line !== "number") return;
    emit({
      event: "end",
      line,
      title: step.title,
      ok: !step.error,
      duration: step.duration,
    });
  }
}
