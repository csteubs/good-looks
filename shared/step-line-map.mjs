// WHICH STEP A SPEC LINE IS — the fallback mapping, and the one definition.
//
// A run reports progress by LINE NUMBER: the Playwright reporter emits
// `{ event, line, ok }` and carries no title, deliberately, because the title is
// the only field that could contain page-derived text. So a line number is all
// the runner gets, and turning it into a step index is what makes "the run
// failed HERE" sayable at all.
//
// The app has a better source for a spec it generated — it knows which line it
// wrote each step onto. This is the FALLBACK, for a spec that was hand-edited or
// imported, and it works by counting `await` lines inside the test body.
//
// ── Why it is here ───────────────────────────────────────────────────────
// Because the unattended runner needs it too. Until 2026-08-26 the MCP and CLI
// path wrote `step-reporter.mjs` beside every spec and never passed
// `--reporter`, so no marker was ever emitted and no run could say which step
// failed — the run record carried no label and no index, and a JUnit report
// built from it would have said `exit 1` and nothing else. Loading the reporter
// is half the fix; being able to read a line number back into a step is the
// other half, and it could not live in a module only the app can import.
//
// Pure: text in, a Map out. No fs — the app's `buildStepLineMap` keeps the read
// on its own side and hands the source in, which is the same split every other
// module here uses.

/** The scan itself, on text, so it can be tested without a file. A `test.step("…", async () => {` header is NOT a step — it is the
 *  wrapper the generator puts around one — and its `});` is not the end of
 *  the body: depth is counted, and the body ends at the `});` that closes
 *  the `test(` callback itself. Before 2026-08-22 the first wrapper header
 *  counted as step 0 and its closer ended the scan, so an edited spec in the
 *  new shape mapped one step and then nothing. */
export function buildStepLineMapFromSource(src) {
  const lines = src.split("\n");
  const map = new Map();
  let stepIndex = 0;
  let inBody = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The test body starts after the `test("...", async ({ page }) => {` line.
    if (!inBody) {
      if (/^\s*test\s*\(/.test(line) && line.includes("async")) inBody = true;
      continue;
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    // Body ends at the `});` that brings the depth back below the callback.
    if (/^\s*}\s*\)/.test(line) && depth + opens - closes < 0) break;
    if (/^\s*await\s+test\.step\s*\(/.test(line)) {
      depth += opens - closes;
      continue;
    }
    // Each step is a single indented line starting with `await `.
    if (/^\s+await /.test(line)) {
      map.set(i + 1, stepIndex); // location.line is 1-based
      stepIndex++;
    }
    depth += opens - closes;
  }
  return map.size > 0 ? map : null;
}
