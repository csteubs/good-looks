// The stdout half of per-step progress: what counts as a marker, and what the
// user sees once they are taken out.
//
// The two cases that are not obvious are the two that broke: a marker can be
// split across chunk boundaries, and a marker written by the WORKER process
// (which is where the capture fixture runs) arrives directly after the `line`
// reporter's cursor-control prefix rather than at the start of its line.
// Anchoring on the start of the line drops those AND prints them to the user.

import { describe, expect, it } from "vitest";

import { splitStepMarkers, STEP_MARKER } from "../../shared/step-marker.mjs";

const marker = (payload: Record<string, unknown>): string =>
  STEP_MARKER + JSON.stringify(payload) + "\n";

describe("splitStepMarkers", () => {
  it("passes ordinary output through untouched", () => {
    const { visible, markers, rest } = splitStepMarkers("", "Running 1 test\nDone\n");
    expect(visible).toBe("Running 1 test\nDone\n");
    expect(markers).toEqual([]);
    expect(rest).toBe("");
  });

  it("takes a marker out of the visible output and reports it", () => {
    const chunk = "before\n" + marker({ event: "begin", line: 5, title: "click" }) + "after\n";
    const { visible, markers } = splitStepMarkers("", chunk);
    expect(visible).toBe("before\nafter\n");
    expect(markers).toEqual([{ event: "begin", line: 5, ok: true }]);
  });

  it("reads a marker that does not start its line", () => {
    // Playwright's `line` reporter writes this prefix with no trailing newline,
    // so a marker from the worker lands on the same line. This is exactly the
    // case a `startsWith` check misses — and missing it is silent twice over:
    // no progress, and a raw marker printed into the Output panel.
    const chunk = "[1A[2K" + marker({ event: "end", line: 9, ok: false });
    const { visible, markers } = splitStepMarkers("", chunk);
    expect(markers).toEqual([{ event: "end", line: 9, ok: false }]);
    expect(visible).toBe("[1A[2K");
    // No newline invented for a line that never had one.
    expect(visible.endsWith("\n")).toBe(false);
  });

  it("holds a marker split across two chunks and reads it once completed", () => {
    const whole = marker({ event: "end", line: 4, ok: true });
    const cut = whole.length - 6;
    const first = splitStepMarkers("", whole.slice(0, cut));
    expect(first.markers).toEqual([]);
    expect(first.visible).toBe("");
    const second = splitStepMarkers(first.rest, whole.slice(cut));
    expect(second.markers).toEqual([{ event: "end", line: 4, ok: true }]);
    expect(second.visible).toBe("");
  });

  it("defaults a marker with no `ok` to passing, and honours an explicit false", () => {
    const { markers } = splitStepMarkers(
      "",
      marker({ event: "begin", line: 1 }) + marker({ event: "end", line: 1, ok: false }),
    );
    expect(markers).toEqual([
      { event: "begin", line: 1, ok: true },
      { event: "end", line: 1, ok: false },
    ]);
  });

  it("strips a malformed marker without reporting it", () => {
    // Stripped either way: half a marker in the Output panel reads as a crash.
    const { visible, markers } = splitStepMarkers("", STEP_MARKER + "{not json\n" + "real output\n");
    expect(markers).toEqual([]);
    expect(visible).toBe("real output\n");
  });

  it("rejects a payload that is not a step transition", () => {
    // The marker channel carries Playwright's own output too, which quotes
    // page-controlled text. A page cannot execute anything through this, but a
    // well-formed forgery could move the highlight, so anything that is not
    // exactly {event, line} is dropped rather than coerced.
    const chunk =
      marker({ event: "started", line: 3 }) +
      marker({ event: "begin", line: "3" }) +
      marker({ event: "begin", line: 2.5 }) +
      marker({ event: "begin", line: 0 }) +
      marker({ event: "begin" }) +
      marker({ line: 3 });
    const { visible, markers } = splitStepMarkers("", chunk);
    expect(markers).toEqual([]);
    expect(visible).toBe("");
  });

  it("reports several markers in one chunk, in order", () => {
    const chunk =
      marker({ event: "begin", line: 4 }) +
      marker({ event: "end", line: 4, ok: true }) +
      marker({ event: "begin", line: 5 });
    const { markers } = splitStepMarkers("", chunk);
    expect(markers.map((m) => `${m.line}:${m.event}`)).toEqual(["4:begin", "4:end", "5:begin"]);
  });
});
