// Standalone regression check for what an issue SAYS.
//
// Filing an issue is the second thing in this app that sends data off the
// machine, and unlike the webhook it carries SCREENSHOTS. Those cannot be
// redacted — the mitigation for them is consent, in the compose dialog. What
// CAN be guaranteed is the text, and this is where that guarantee lives.
//
// `buildIssueDraft` is pure and is the single place the outgoing body is
// decided, so every assertion below constructs a deliberately hostile input by
// hand and asserts against the returned object. The failure this exists to
// prevent is the quiet one: a field added to the draft later that happens to
// carry page content, in a feature nobody re-reads the security notes for.
//
// FOUR PROPERTIES, each pinned independently:
//
//   1. The raw Playwright log NEVER appears. Only `errorSignature`'s reduction
//      of its first line does — paths, timings, ids and numbers normalised out.
//   2. Console lines appear for a FAILURE only, and only the ones the loader
//      already narrowed to errors. A11y and visual drafts carry none at all.
//   3. Network entries appear for a FAILURE only, and ONLY when the run had its
//      headers filtered. `GLAZE_RECORD_ALL_HEADERS=1` produces exactly the run
//      someone debugging an auth failure would have, and its `network.json`
//      holds real Authorization and Cookie values.
//   4. Header values never appear at all. The type has nowhere to put them,
//      which is the point — this asserts the type has not grown somewhere.
//
// No test runner here (see package.json) — plain assertions + a non-zero exit.
//   npm run check:issue-payload

import {
  buildIssueDraft,
  type BuildInput,
  type DraftContext,
  type FailureDefect,
} from "../issue-tracker/payload.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

/** A marker that must never survive into a draft. Distinctive enough that a
 *  substring search cannot match it by accident. */
const LEAK = "ZZLEAKZZ";

const CONTEXT: DraftContext = {
  testName: "Checkout — happy path",
  testUrl: "https://shop.example.com/cart",
  stepLabel: "click Place order",
  browser: "chromium",
};

const A11Y_SOURCE = {
  kind: "a11y" as const,
  testId: "t1",
  runId: "r1",
  stepId: "s1",
  ruleId: "color-contrast",
};
const FAILURE_SOURCE = { kind: "failure" as const, testId: "t1", runId: "r1", stepId: "s1" };
const VISUAL_SOURCE = { kind: "visual" as const, testId: "t1", runId: "r1", stepId: "s1" };

function failureDefect(over: Partial<FailureDefect> = {}): FailureDefect {
  return {
    kind: "failure",
    rawError: "Error: locator.click: Timeout 30000ms exceeded",
    healOutcome: null,
    healLocator: null,
    console: [],
    network: [],
    headersFiltered: true,
    ...over,
  };
}

function draftText(input: BuildInput): string {
  const draft = buildIssueDraft(input);
  return `${draft.title}\n${draft.body}`;
}

// ── 1. The raw log never appears ─────────────────────────────────────

{
  // A realistic Playwright failure: the error line, then a DOM snippet and an
  // assertion diff. Everything after the first line must be gone.
  const rawLog = [
    "Error: expect(received).toHaveText(expected)",
    `Expected string: "Welcome back"`,
    `Received string: "Signed in as ${LEAK}@example.com"`,
    `  <div class="user-menu">${LEAK}</div>`,
    `  at /Users/someone/checkout.spec.ts:42`,
  ].join("\n");

  const text = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ rawError: rawLog }),
  });

  assert(!text.includes(LEAK), "a failure draft carries no page content from the run log");
  assert(
    !text.includes("Received string") && !text.includes("user-menu"),
    "…and no assertion diff or DOM snippet either — only the first line survives",
  );
  assert(
    text.includes("expect(received)"),
    "…while the failure itself IS reported, so the issue is still worth reading",
  );
  assert(
    !text.includes("checkout.spec.ts") && !text.includes("/Users/"),
    "an absolute path is normalised away rather than naming someone's machine",
  );
}

{
  // The signature normalises what varies run to run, so a recurrence is
  // recognisable as the same failure rather than looking new every time.
  const titleFor = (rawError: string) =>
    buildIssueDraft({ source: FAILURE_SOURCE, context: CONTEXT, defect: failureDefect({ rawError }) })
      .title;

  assert(
    titleFor("Error: Timeout 30000ms exceeded waiting for locator") ===
      titleFor("Error: Timeout 45000ms exceeded waiting for locator"),
    "the same failure at a different timeout produces the same title",
  );
  assert(
    titleFor("Error: no element at /app/run-4f2a/page.ts") ===
      titleFor("Error: no element at /app/run-91bc/page.ts"),
    "…and a path carrying a run id does not make two titles differ",
  );

  // NOT normalised, and worth knowing rather than assuming: `errorSignature`
  // only collapses hex runs of 16+ characters, so a SHORT generated id survives
  // and two occurrences of one failure can still title differently. Widening it
  // is not this feature's call to make — it is a metrics-DB column, and
  // loosening it would merge genuinely different failures in the flake report.
  assert(
    titleFor("Error: no element #a1b2c3d4") !== titleFor("Error: no element #99887766"),
    "a short generated id is NOT normalised — pinned so the limitation is known, not discovered",
  );
}

// ── 2. Console lines: failures only, and only what was narrowed ──────

{
  const withConsole = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({
      console: [{ type: "error", text: `Uncaught TypeError near ${LEAK}` }],
    }),
  });
  assert(
    withConsole.includes("Uncaught TypeError"),
    "a failure draft reports the console errors at its step",
  );

  const a11y = draftText({
    source: A11Y_SOURCE,
    context: CONTEXT,
    defect: {
      kind: "a11y",
      ruleId: "color-contrast",
      impact: "serious",
      help: "Elements must meet contrast ratio thresholds",
      targets: [".btn"],
    },
  });
  const visual = draftText({
    source: VISUAL_SOURCE,
    context: CONTEXT,
    defect: { kind: "visual", changedFraction: 0.031, maskedCount: 0, threshold: 0.002 },
  });
  assert(
    !a11y.toLowerCase().includes("console") && !visual.toLowerCase().includes("console"),
    "an a11y or visual draft has no console section at all — there is no failure to diagnose",
  );
}

{
  // A page can log a great deal. The draft is bounded, and says so rather than
  // silently truncating — a reader must know there was more.
  const many = Array.from({ length: 40 }, (_, i) => ({ type: "error", text: `boom ${i}` }));
  const text = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ console: many }),
  });
  assert(!text.includes("boom 39"), "the console list is capped");
  assert(/and \d+ more/.test(text), "…and the draft SAYS it was capped rather than truncating silently");
}

// ── 3. Network entries need headers to have been filtered ────────────

{
  const request = { method: "POST", url: "https://api.example.com/orders", status: 500 };

  const filtered = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ network: [request], headersFiltered: true }),
  });
  assert(
    filtered.includes("api.example.com/orders"),
    "a run with filtered headers reports the failing request",
  );

  const unfiltered = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ network: [request], headersFiltered: false }),
  });
  assert(
    !unfiltered.includes("api.example.com/orders"),
    "a run recorded with ALL headers reports no requests at all",
  );
  assert(
    /withheld/i.test(unfiltered),
    "…and says they were withheld, so a missing section never reads as 'nothing happened'",
  );

  const draft = buildIssueDraft({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ network: [request], headersFiltered: false }),
  });
  assert(
    draft.notices.some((n) => /full request headers/i.test(n)),
    "…and the dialog is given a notice to show before the user sends",
  );
}

// ── 4. Header values have nowhere to live ────────────────────────────

{
  // The guarantee is structural: `FailureRequest` has three fields and none of
  // them is a header bag. This asserts the structure has not grown one — a
  // future field would show up as the marker surviving.
  const hostile = {
    method: "POST",
    url: "https://api.example.com/orders",
    status: 401,
    // Deliberately extra, as a loader change might one day pass through.
    requestHeaders: { authorization: `Bearer ${LEAK}` },
    responseHeaders: { "set-cookie": `session=${LEAK}` },
  } as unknown as FailureDefect["network"][number];

  const text = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ network: [hostile], headersFiltered: true }),
  });
  assert(!text.includes(LEAK), "a header value smuggled onto a request entry never reaches the body");
  assert(
    !/authorization|set-cookie/i.test(text),
    "…and no header NAME is rendered either, so the shape cannot drift into carrying values",
  );
}

// ── Everything remote is bounded ─────────────────────────────────────

{
  // An axe `help` string is remote page content, and a step label can carry a
  // value typed during recording. Neither may dominate an issue.
  const text = draftText({
    source: A11Y_SOURCE,
    context: { ...CONTEXT, stepLabel: "x".repeat(5000) },
    defect: {
      kind: "a11y",
      ruleId: "y".repeat(5000),
      impact: "serious",
      help: "z".repeat(5000),
      targets: Array.from({ length: 50 }, (_, i) => `.sel-${i}`),
    },
  });
  assert(!/x{400}/.test(text), "a runaway step label is bounded");
  assert(!/z{400}/.test(text), "a runaway rule description is bounded");
  assert(!text.includes(".sel-49"), "the element list is capped");
  assert(
    !/\n\s*\n\s*\n\s*\n/.test(text.replace(/\n---\n/g, "")),
    "no field's newlines survive to break the markdown around it",
  );
}

{
  // Markdown injection: a rule id ending a code span could otherwise close it
  // and let the rest render as structure.
  const text = draftText({
    source: A11Y_SOURCE,
    context: CONTEXT,
    defect: {
      kind: "a11y",
      ruleId: "rule`](https://evil.example.com)",
      impact: "serious",
      help: "help",
      targets: [],
    },
  });
  // The escape that matters is the BACKTICK: without it the rest is inert text
  // sitting inside a code span. So the assertion is that no backtick from the
  // input survives adjacent to link syntax, not that the characters are absent.
  assert(!text.includes("`]("), "a backtick in a remote id cannot close its code span and open a link");
}

{
  // The other half of the same hole, and the one that was missed while the
  // neutralisation lived only in `code()`: the error signature is rendered in a
  // FENCED block, and an error message is remote text that can contain ```.
  const text = draftText({
    source: FAILURE_SOURCE,
    context: CONTEXT,
    defect: failureDefect({ rawError: "Error: got ``` then [a](https://evil.example.com) here" }),
  });
  const fences = text.split("```").length - 1;
  assert(fences === 2, "a fence in the error text cannot end the block early — exactly one block remains");
  assert(
    text.includes("evil.example.com"),
    "…and the text is still shown rather than silently dropped — it is evidence, just inert",
  );
}

// ── The draft's shape is fixed ───────────────────────────────────────

{
  const draft = buildIssueDraft({
    source: A11Y_SOURCE,
    context: CONTEXT,
    defect: { kind: "a11y", ruleId: "r", impact: "minor", help: "h", targets: [] },
  });
  assert(
    JSON.stringify(Object.keys(draft).sort()) ===
      JSON.stringify(["attachments", "body", "notices", "source", "title"]),
    "the draft has exactly the five known keys — a new one has to be added here deliberately",
  );
}

if (failures > 0) {
  console.error(`\n${failures} issue-payload check(s) failed.`);
  process.exit(1);
}
console.log("\nAll issue-payload checks passed.");
