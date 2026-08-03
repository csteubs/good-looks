// The StepReporter as a raw JS string, so playwright-runner.ts can write it
// next to the specs at runtime (the scripts dir lives in userData, far from the
// app's compiled backend). This is plain JavaScript (no TypeScript type imports)
// because Playwright loads it as a .mjs module via its own Babel transform, which
// does not understand `import type`. Kept in sync with step-reporter.ts by hand.

export const stepReporterSource = `// Per-step progress reporter for Test Recorder. Emits parseable JSON lines on
// stdout that the backend strips out and forwards to the renderer as
// runner:step events, so the Steps tab can highlight each step as it runs.
function emit(payload) {
  process.stdout.write("__GLAZE_STEP__:" + JSON.stringify(payload) + "\\n");
}

class StepReporter {
  onStepBegin(test, _result, step) {
    if (step.category !== "pw:api") return;
    // Only steps located in the spec file itself map to a highlightable step;
    // screenshot calls injected by the capture fixture live elsewhere.
    if (step.location && step.location.file && test && test.location && test.location.file && step.location.file !== test.location.file) return;
    const line = step.location && step.location.line;
    if (typeof line !== "number") return;
    emit({ event: "begin", line, title: step.title });
  }

  onStepEnd(test, _result, step) {
    if (step.category !== "pw:api") return;
    if (step.location && step.location.file && test && test.location && test.location.file && step.location.file !== test.location.file) return;
    const line = step.location && step.location.line;
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

export default StepReporter;
`;
