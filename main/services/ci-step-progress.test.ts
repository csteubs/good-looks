// What an UNATTENDED run does with the step reporter's markers.
//
// The reporter was in the always-written set from R8 and `runArgs` passed no
// `--reporter`, so on the MCP and CLI path it sat beside every spec and was
// loaded by nothing: no marker was ever emitted, no run could say which step it
// failed on, and the run record carried neither a label nor an index. A JUnit
// report built from one of those runs said `exit 1` and nothing else — which is
// exactly what the emitters were written to replace.
//
// Turning the reporter on is half the change. The other half is taking the
// markers back OUT: `get_run_log` reads a run's output straight into an agent's
// context, and `__GLAZE_STEP__:{"event":"begin",…}` lines there are budget spent
// on nothing. Loading without stripping is strictly worse than leaving it off,
// so neither half ships alone.
//
// `check:ci-fixtures` pins the WIRING — that the reporter is loaded, that stdout
// goes through the splitter, that the visible text is the split's output. What a
// source check cannot pin is the BEHAVIOUR: a splitter call whose result is
// substituted still reads correctly. That is what this covers.

import { describe, expect, it } from "vitest";

import { STEP_MARKER, splitStepMarkers } from "../../shared/step-marker.mjs";
import { buildStepLineMapFromSource } from "../../shared/step-line-map.mjs";

/** The runner's own accumulation, reproduced exactly: chunk in, visible text
 *  appended, `rest` carried to the next chunk, markers collected. */
function drain(chunks: string[]): { visible: string; lastBegin: number | null; failed: number | null } {
  let buffered = "";
  let visible = "";
  let lastBegin: number | null = null;
  let failed: number | null = null;
  for (const chunk of chunks) {
    const split = splitStepMarkers(buffered, chunk);
    buffered = split.rest;
    for (const marker of split.markers) {
      if (marker.event === "begin") lastBegin = marker.line;
      if (!marker.ok) failed = marker.line;
    }
    visible += split.visible;
  }
  if (buffered) visible += splitStepMarkers(buffered, "\n").visible;
  return { visible, lastBegin, failed };
}

const marker = (payload: object): string => `${STEP_MARKER}${JSON.stringify(payload)}\n`;

describe("the markers never reach the run's output", () => {
  it("strips every marker and keeps everything else", () => {
    const { visible } = drain([
      "Running 1 test using 1 worker\n",
      marker({ event: "begin", line: 12, ok: true }),
      "  ok 1 login.spec.ts:3:1 › login\n",
      marker({ event: "end", line: 12, ok: true }),
      "  1 passed (2.1s)\n",
    ]);
    expect(visible).not.toContain(STEP_MARKER);
    expect(visible).toContain("Running 1 test using 1 worker");
    expect(visible).toContain("1 passed (2.1s)");
  });

  it("strips a marker split across two chunks", () => {
    // The case the `rest` buffer exists for. A marker arrives in pieces
    // whenever the pipe happens to break mid-line, and half a marker is neither
    // strippable nor parseable — it would print as junk and report nothing.
    const whole = marker({ event: "begin", line: 7, ok: true });
    const cut = Math.floor(whole.length / 2);
    const { visible, lastBegin } = drain(["before\n", whole.slice(0, cut), whole.slice(cut), "after\n"]);
    expect(visible).toBe("before\nafter\n");
    expect(lastBegin).toBe(7);
  });

  it("does not leave a trailing partial line unflushed", () => {
    // A run whose last line has no newline: the runner flushes `buffered`
    // through the same split rather than appending it raw, so a truncated
    // marker cannot slip out at the very end.
    const { visible } = drain(["done, no newline"]);
    expect(visible).toContain("done, no newline");
    const truncated = drain([STEP_MARKER + '{"event":"begin"']);
    expect(truncated.visible).not.toContain("__GLAZE_STEP__");
  });
});

describe("which step a failed run reports", () => {
  const SPEC = [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("login", async ({ page }) => {',
    '  await page.goto("https://example.com");',
    '  await page.getByLabel("Email").fill("a@b.c");',
    '  await page.getByRole("button", { name: "Sign in" }).click();',
    '  await expect(page.getByText("Welcome")).toBeVisible();',
    "});",
    "",
  ].join("\n");

  it("maps the reported line to a step index", () => {
    const map = buildStepLineMapFromSource(SPEC)!;
    expect(map.get(4)).toBe(0);
    expect(map.get(6)).toBe(2);
    expect(map.get(7)).toBe(3);
  });

  it("reports the step the reporter marked failed", () => {
    const { failed } = drain([
      marker({ event: "begin", line: 4, ok: true }),
      marker({ event: "end", line: 4, ok: true }),
      marker({ event: "begin", line: 6, ok: true }),
      marker({ event: "end", line: 6, ok: false }),
    ]);
    expect(failed).toBe(6);
    expect(buildStepLineMapFromSource(SPEC)!.get(failed!)).toBe(2);
  });

  it("falls back to the last step that BEGAN when nothing is marked failed", () => {
    // A crash, a timeout kill, a worker lost — the run stops with no `end`. The
    // step that started and never finished is the honest answer, and it is why
    // `begin` is tracked separately rather than only reading `ok`.
    const { failed, lastBegin } = drain([
      marker({ event: "begin", line: 4, ok: true }),
      marker({ event: "end", line: 4, ok: true }),
      marker({ event: "begin", line: 7, ok: true }),
      "\n[Timed out after 5 minutes — stopping.]\n",
    ]);
    expect(failed).toBeNull();
    expect(lastBegin).toBe(7);
    expect(buildStepLineMapFromSource(SPEC)!.get(lastBegin!)).toBe(3);
  });

  it("maps nothing for a line the spec does not have", () => {
    // A hand-edited or imported spec whose lines the fallback scan cannot
    // classify. `undefined` is what the runner turns into "no step recorded",
    // which is an honest answer where a guessed index is not.
    expect(buildStepLineMapFromSource(SPEC)!.get(999)).toBeUndefined();
  });
});
