// Tests for accessibility new-vs-accepted diffing.
//
// This decides which violations a user is shown, and both failure directions
// are expensive in the same way visual diffing's are. Flag everything and the
// first run on a real site buries the user in pre-existing problems, so they
// stop looking. Flag too little and the regression the feature exists to catch
// slips through an over-broad acceptance.
//
// The keying is the crux: a violation is identified by rule id AND node, so
// accepting one low-contrast label cannot accept every future contrast failure
// on the page.

import { describe, expect, it } from "vitest";

import {
  acceptKeysFor,
  diffViolations,
  hasNewViolations,
  keysOf,
  violationKey,
  worstNewImpact,
  type A11yViolation,
} from "./a11y-diff.js";

function v(partial: Partial<A11yViolation> & Pick<A11yViolation, "id">): A11yViolation {
  return {
    impact: "serious",
    help: "Elements must have sufficient colour contrast",
    nodes: [],
    ...partial,
  };
}

describe("violation identity", () => {
  it("keys on the rule AND the node", () => {
    expect(violationKey("color-contrast", ".btn")).toBe("color-contrast|.btn");
  });

  it("produces one key per offending node", () => {
    expect(keysOf(v({ id: "color-contrast", nodes: [".a", ".b"] }))).toEqual([
      "color-contrast|.a",
      "color-contrast|.b",
    ]);
  });

  it("still produces a key for a violation with no nodes", () => {
    // A page-level rule (document-title, html-has-lang) reports no node. It
    // must still be acceptable, or it would be permanently unacceptable and
    // flag on every run forever.
    expect(keysOf(v({ id: "document-title", nodes: [] }))).toEqual(["document-title|"]);
  });
});

describe("diffViolations", () => {
  it("returns null when there is nothing to report", () => {
    // A clean step carries no payload at all, rather than an empty one every
    // consumer would have to know to treat as absent.
    expect(diffViolations([], [])).toBeNull();
    expect(diffViolations(undefined, [])).toBeNull();
  });

  it("flags everything when no baseline exists", () => {
    const result = diffViolations([v({ id: "color-contrast", nodes: [".a", ".b"] })], undefined);
    expect(result?.newKeys).toEqual(["color-contrast|.a", "color-contrast|.b"]);
    expect(result?.acceptedCount).toBe(0);
  });

  it("does not flag an accepted violation", () => {
    const result = diffViolations(
      [v({ id: "color-contrast", nodes: [".a"] })],
      ["color-contrast|.a"],
    );
    expect(result?.newKeys).toEqual([]);
    expect(result?.acceptedCount).toBe(1);
    expect(hasNewViolations(result ?? undefined)).toBe(false);
  });

  it("flags a NEW node of an already-accepted rule", () => {
    // The whole reason for keying on the node. Accepting the contrast failure
    // on `.a` must not silently accept a brand-new one on `.b`.
    const result = diffViolations(
      [v({ id: "color-contrast", nodes: [".a", ".b"] })],
      ["color-contrast|.a"],
    );
    expect(result?.newKeys).toEqual(["color-contrast|.b"]);
    expect(result?.acceptedCount).toBe(1);
  });

  it("still reports accepted violations as context", () => {
    // They're shown greyed out, not hidden: "this step has 6 issues, 6
    // accepted" is useful; pretending the step is clean is not.
    const result = diffViolations(
      [v({ id: "color-contrast", nodes: [".a"] })],
      ["color-contrast|.a"],
    );
    expect(result?.violations).toHaveLength(1);
  });

  it("does not repeat a key that appears twice", () => {
    const result = diffViolations(
      [v({ id: "label", nodes: ["#x"] }), v({ id: "label", nodes: ["#x"] })],
      [],
    );
    expect(result?.newKeys).toEqual(["label|#x"]);
  });
});

describe("acceptKeysFor", () => {
  it("accepts everything reported, not just the new ones", () => {
    // "Accept" means "this is the state I'm signing off". Pinning only the new
    // keys would drop previously-accepted ones the next time the baseline was
    // rewritten, quietly un-accepting them.
    const keys = acceptKeysFor([
      v({ id: "color-contrast", nodes: [".a", ".b"] }),
      v({ id: "document-title", nodes: [] }),
    ]);
    expect(keys).toEqual(["color-contrast|.a", "color-contrast|.b", "document-title|"]);
  });

  it("handles nothing gracefully", () => {
    expect(acceptKeysFor(undefined)).toEqual([]);
  });
});

describe("worstNewImpact", () => {
  it("ranks by severity, not by count", () => {
    // One critical outranks any number of minor ones — a badge that counted
    // would say the opposite and send the user to the wrong problem first.
    const result = diffViolations(
      [
        v({ id: "a", impact: "minor", nodes: [".1", ".2", ".3"] }),
        v({ id: "b", impact: "critical", nodes: [".4"] }),
      ],
      [],
    );
    expect(worstNewImpact(result ?? undefined)).toBe("critical");
  });

  it("ignores the impact of violations that are already accepted", () => {
    // The badge describes what needs attention. Colouring it by an accepted
    // critical issue would keep the step looking urgent forever.
    const result = diffViolations(
      [
        v({ id: "a", impact: "critical", nodes: [".1"] }),
        v({ id: "b", impact: "minor", nodes: [".2"] }),
      ],
      ["a|.1"],
    );
    expect(worstNewImpact(result ?? undefined)).toBe("minor");
  });

  it("is null when nothing is new", () => {
    const result = diffViolations([v({ id: "a", nodes: [".1"] })], ["a|.1"]);
    expect(worstNewImpact(result ?? undefined)).toBeNull();
  });
});

describe("accessibility never gates a run", () => {
  // The promise made in Settings and in the UI copy is that a11y is reported,
  // never fatal — a third-party widget must not be able to turn a green suite
  // red overnight. That promise lives in code the unit tests above can't reach:
  // it's the absence of any link between a11y and runStatus in the runner.
  //
  // A source-level assertion, like check:ai-debug-scroll and check:scroll-layout
  // already use for layout contracts jsdom can't observe. It's crude, and it is
  // still the only thing standing between this guarantee and a one-line change.
  it("the runner derives run status only from the exit code", async () => {
    const fs = await import("fs");
    const url = await import("url");
    const path = await import("path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, "playwright-runner.ts"), "utf-8");

    const assignments = src.match(/runStatus\s*=\s*[^;]+;/g) ?? [];
    expect(assignments, "runStatus is assigned somewhere unexpected").toHaveLength(1);
    expect(assignments[0]).toBe('runStatus = exitCode === 0 ? "passed" : "failed";');

    // And nothing a11y-shaped may be near the exit code or the status.
    const gating = src.match(/(exitCode|runStatus)[^\n]*a11y|a11y[^\n]*(exitCode|runStatus)/gi);
    expect(gating, `accessibility appears to influence run status: ${gating?.join(", ")}`).toBeNull();
  });
});
