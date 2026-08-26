// The emitters. REDESIGN §6.5 / §7.3.
//
// LIVES HERE RATHER THAN BESIDE `shared/emitters.mjs`, for the reason
// `branch-paths.test.ts` and `url-assert.test.ts` give: vitest's node project
// includes `main/**/*.test.ts`, so a test under `shared/` matches NEITHER
// project and would pass by never running.
//
// Every one of these produces a file somebody else's tool parses, which is the
// specific reason they need tests: a wrong field is not visible here, it is
// visible in a CI report nobody reads carefully, or in a spreadsheet that opens
// cleanly with the columns shifted by one. The failures pinned below are all of
// that kind — silent, downstream, and impossible to see by looking at the panel.

import { describe, expect, it } from "vitest";

import type { EmitRun } from "../../shared/emitters.mjs";
import {
  EMITTERS,
  emitFileName,
  githubAnnotations,
  junitXml,
  otlpTrace,
  stepMetricsCsv,
  stepMetricsNdjson,
  ticketMarkdown,
} from "../../shared/emitters.mjs";

const NOW = 1_700_000_000_000;

/** Typed against the module's own `EmitRun`, so a fixture that drifts from the
 *  contract is a type error here rather than a wrong column in somebody's CI
 *  report. Without the annotation `status` widens to `string` and the fixture
 *  stops being a description of what the emitters actually take. */
function run(over: Partial<EmitRun> = {}): EmitRun {
  return {
    id: "r1",
    testId: "t1",
    testName: "Checkout",
    url: "https://shop.example.com",
    status: "passed",
    exitCode: 0,
    startedAt: NOW,
    finishedAt: NOW + 12_400,
    durationMs: 12_400,
    logFile: "/runs/r1.log",
    runBrowser: "chromium",
    ...over,
  };
}

/** Stands in for `redactWithSnapshot`. */
const hide = (text: string) => String(text).split("hunter2").join("[redacted]");

describe("JUnit XML", () => {
  it("reports duration in SECONDS", () => {
    // The single most commonly mis-emitted field in this format. Milliseconds
    // make every job look a thousand times slower and no consumer complains.
    expect(junitXml([run({ durationMs: 12_400 })])).toContain('time="12.400"');
  });

  it("counts failures on the suite as well as marking them on the case", () => {
    const xml = junitXml([run(), run({ id: "r2", status: "failed", exitCode: 1 })]);
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
    expect(xml.match(/<failure /g)).toHaveLength(1);
  });

  it("escapes every one of the five XML entities, quotes included", () => {
    // A test name is user text and routinely has an apostrophe in it. One
    // unescaped quote truncates the attribute or breaks the parse.
    const xml = junitXml([run({ testName: `A & B <c> "d" 'e'` })]);
    expect(xml).toContain("A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    expect(xml).not.toContain('name="A & B');
  });

  it("drops control bytes XML 1.0 cannot carry at all", () => {
    // ESCAPING DOES NOT HELP HERE — they are illegal escaped or not, and
    // Playwright output carries them. One makes the whole file unparseable,
    // which turns "the report is wrong" into "CI cannot read the report".
    // Built from escapes rather than pasted in: a raw NUL in a source file is
    // one an editor or a formatter can silently drop, which would leave this
    // test passing against a string that never had the problem.
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const xml = junitXml([run({ testName: `before${NUL}${BEL}after` })]);
    expect(xml).toContain("beforeafter");
    expect(xml).not.toContain(NUL);
    expect(xml).not.toContain(BEL);
  });

  it("groups by test ID, not by name", () => {
    // Grouping has to survive a rename, and the name is the one field a user
    // edits freely.
    expect(junitXml([run({ testId: "t-checkout", testName: "Anything" })])).toContain(
      'classname="t-checkout"',
    );
  });

  it("redacts through the injected redactor", () => {
    expect(junitXml([run({ testName: "login hunter2" })], { redact: hide })).toContain(
      "[redacted]",
    );
  });
});

describe("GitHub annotations", () => {
  it("annotates failures ONLY", () => {
    // An annotation per passing test buries the failures under a hundred
    // notices, which is the opposite of what annotations are for.
    const out = githubAnnotations([run(), run({ id: "r2", status: "failed", exitCode: 1 })]);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("::error title=Checkout::");
  });

  it("emits nothing at all when nothing failed", () => {
    expect(githubAnnotations([run(), run({ id: "r2" })])).toBe("");
  });

  it("encodes newlines, because a raw one ENDS the command", () => {
    // Everything after it would print as ordinary log output and the annotation
    // would carry only its first line.
    const out = githubAnnotations([
      run({ status: "failed", testName: "two\nlines", logFile: "a\nb" }),
    ]);
    expect(out).toContain("%0A");
    expect(out.trim().split("\n")).toHaveLength(1);
  });

  it("encodes the percent FIRST, so it cannot re-encode its own escapes", () => {
    const out = githubAnnotations([run({ status: "failed", testName: "100%\ndone" })]);
    expect(out).toContain("100%25%0Adone");
  });
});

describe("ticket markdown", () => {
  it("leads with the count that matters", () => {
    expect(ticketMarkdown([run(), run({ id: "r2", status: "failed" })])).toContain(
      "**1 of 2 failed.**",
    );
  });

  it("says so plainly when nothing failed, with no empty table", () => {
    const out = ticketMarkdown([run(), run({ id: "r2" })]);
    expect(out).toContain("All 2 runs passed.");
    expect(out).not.toContain("| Test |");
  });

  it("escapes a pipe in a test name", () => {
    // An unescaped one adds a column and shifts every cell after it — a table
    // that renders, wrongly.
    expect(ticketMarkdown([run({ status: "failed", testName: "a | b" })])).toContain("a \\| b");
  });
});

describe("what a failure says (R13)", () => {
  // Before this, all three formats said the same two useless things: an exit
  // code, and an ABSOLUTE PATH to a log on the machine that ran the test. On a
  // CI runner that path names a file nobody can open, so the annotation told a
  // reader strictly less than the exit code already had. None of this was
  // asserted, which is why the message could be wrong for as long as it was.

  const failedAtLogin = run({
    status: "failed",
    exitCode: 1,
    failedStepLabel: 'click getByRole("button", { name: "Place order" })',
    failureReason: "Element not found",
  });

  it("JUnit names the failing step in the failure message", () => {
    const xml = junitXml([failedAtLogin]);
    expect(xml).toContain("Failed at:");
    expect(xml).toContain("Place order");
    expect(xml).toContain("Element not found");
  });

  it("…and no longer carries a log path that is dead on any other machine", () => {
    expect(junitXml([failedAtLogin])).not.toContain("/runs/r1.log");
    expect(githubAnnotations([failedAtLogin])).not.toContain("/runs/r1.log");
  });

  it("the GitHub annotation carries the step, which is the only reason to use the format", () => {
    const out = githubAnnotations([failedAtLogin]);
    expect(out).toContain("::error title=Checkout::");
    expect(out).toContain("Failed at:");
    expect(out).toContain("Element not found");
  });

  it("still says something useful when the step is unknown", () => {
    // A run with no replay has no per-step outcome. The message degrades to the
    // exit code rather than to an empty string or the word "undefined".
    const bare = run({ status: "failed", exitCode: 2 });
    const xml = junitXml([bare]);
    expect(xml).toContain("exit 2");
    expect(xml).not.toContain("undefined");
    expect(xml).not.toContain("Failed at:");
  });

  it("REDACTS the step label, which can itself be the credential", () => {
    // `fill()` steps carry their value in the label, so this is not a
    // hypothetical: the label is the likeliest carrier of a secret in the whole
    // record, and it now travels into a file somebody forwards.
    const leaky = run({
      status: "failed",
      exitCode: 1,
      failedStepLabel: 'getByLabel("Password").fill("hunter2")',
    });
    expect(junitXml([leaky], { redact: hide })).not.toContain("hunter2");
    expect(githubAnnotations([leaky], { redact: hide })).not.toContain("hunter2");
    expect(ticketMarkdown([leaky], { redact: hide })).not.toContain("hunter2");
  });

  it("the ticket table gains the step and the reason as their own columns", () => {
    const md = ticketMarkdown([failedAtLogin]);
    expect(md).toContain("| Test | Failed at | Reason | Browser | Duration |");
    expect(md).toContain("Place order");
    expect(md).toContain("Element not found");
  });

  it("escapes a pipe in a step label, which a selector can easily contain", () => {
    // Same failure the test-name escape exists for: an unescaped pipe adds a
    // column and shifts every cell after it — a table that renders, wrongly.
    const piped = run({ status: "failed", failedStepLabel: 'locator("a|b")' });
    expect(ticketMarkdown([piped])).toContain('locator("a\\|b")');
  });
});

describe("step metrics", () => {
  const rows = [
    { runId: "r1", stepId: "s1", label: "goto", ms: 120 },
    { runId: "r1", stepId: "s2", label: 'click "Buy"', ms: 45 },
  ];

  it("writes NDJSON as one object per line, not an array", () => {
    const out = stepMetricsNdjson(rows);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(rows[0]);
  });

  it("emits nothing for no rows, rather than a lone newline", () => {
    expect(stepMetricsNdjson([])).toBe("");
    expect(stepMetricsCsv([])).toBe("");
  });

  it("writes every CSV row against the FIRST row's columns", () => {
    // Rows with differing shapes would otherwise produce a file whose columns
    // mean different things on different lines — which opens cleanly in a
    // spreadsheet and is wrong.
    const out = stepMetricsCsv([
      { a: 1, b: 2 },
      { b: 20, c: 30 },
    ]);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe('"a","b"');
    expect(lines[2]).toBe('"","20"');
  });

  it("quotes every CSV cell and doubles inner quotes", () => {
    // Quoting conditionally means deciding what "needed" means, and getting it
    // wrong on a leading space or a lone CR. Quoting always has no edge cases.
    expect(stepMetricsCsv(rows)).toContain('"click ""Buy"""');
  });

  it("redacts the SERIALIZED line, not a list of fields", () => {
    // A secret can land in any string column, and a field-by-field pass needs a
    // list that goes stale the first time a column is added.
    const secret = [{ runId: "r1", note: "token hunter2 here" }];
    expect(stepMetricsNdjson(secret, { redact: hide })).toContain("[redacted]");
    expect(stepMetricsNdjson(secret, { redact: hide })).not.toContain("hunter2");
  });
});

describe("OTLP trace", () => {
  it("emits nanosecond times as STRINGS", () => {
    // OTLP specifies uint64 nanos. 2026 in nanoseconds is past
    // Number.MAX_SAFE_INTEGER, so computing them as a JS number silently loses
    // the low digits and every span drifts.
    const doc = JSON.parse(otlpTrace([run()]));
    const span = doc.resourceSpans[0].scopeSpans[0].spans[0];
    expect(typeof span.startTimeUnixNano).toBe("string");
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(Number(span.startTimeUnixNano)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("marks a failed run with the ERROR status code", () => {
    const ok = JSON.parse(otlpTrace([run()]));
    const bad = JSON.parse(otlpTrace([run({ status: "failed" })]));
    expect(ok.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(1);
    expect(bad.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
  });

  it("gives ids of the widths OTLP requires", () => {
    const span = JSON.parse(otlpTrace([run()])).resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("derives those ids, so re-emitting the same runs is a diffable file", () => {
    expect(otlpTrace([run()])).toBe(otlpTrace([run()]));
    expect(otlpTrace([run({ id: "other" })])).not.toBe(otlpTrace([run()]));
  });

  it("redacts the URL, which is where a query-string credential would be", () => {
    const out = otlpTrace([run({ url: "https://x.example.com/?token=hunter2" })], { redact: hide });
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("hunter2");
  });
});

describe("the emitter list", () => {
  it("names a risk for exactly the two §7.3 calls out, and the CSV twin", () => {
    // Stated per-emitter rather than once at the top: a general warning about
    // "exports" is not read as being about the row under the cursor.
    const withRisk = EMITTERS.filter((e) => e.risk !== null).map((e) => e.id);
    expect(withRisk).toEqual(["otlp", "ndjson", "csv"]);
  });

  it("gives every emitter a distinct id and a file extension", () => {
    const ids = EMITTERS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of EMITTERS) expect(e.extension).toMatch(/^[a-z]+$/);
  });

  it("names a file after the emitter it came from", () => {
    expect(emitFileName("junit", "2026-08-12")).toBe("good-looks-junit-2026-08-12.xml");
    expect(emitFileName("ndjson", "2026-08-12")).toBe("good-looks-ndjson-2026-08-12.ndjson");
  });
});

describe("junitXml: a skipped run", () => {
  // Reachable only from a run RESULT — every RunRecord is passed-or-failed, and
  // the CLI is the caller that can decline to run a test at all. Before this
  // branch existed, anything not "failed" emitted a bare `<testcase/>`, which
  // every CI reads as a pass: a test skipped for want of a credential arrived
  // in a dashboard green.
  const skipped = {
    id: "r9",
    testId: "t-x",
    testName: "checks out",
    status: "skipped" as const,
    durationMs: 0,
    note: "declares 1 secret variable with no value here: PASSWORD.",
  };

  it("is counted as skipped, not as a pass and not as a failure", () => {
    const xml = junitXml([skipped]);
    expect(xml).toContain('tests="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain("<skipped");
  });

  it("carries its reason, redacted like any other free text", () => {
    const xml = junitXml([{ ...skipped, note: "blocked by hunter2" }], {
      redact: (t: string) => t.split("hunter2").join("[redacted]"),
    });
    expect(xml).not.toContain("hunter2");
    expect(xml).toContain("[redacted]");
  });

  it("emits no message attribute when there is no reason", () => {
    expect(junitXml([{ ...skipped, note: undefined }])).toContain("<skipped/>");
  });
});
