// What a run executed, digested — and the three ways that answer can be wrong.
//
// Under `main/services/` rather than beside the module: vitest's node project
// takes `main/**`, `mcp/**` and `renderer/lib/**`, so a test file in `shared/`
// matches NEITHER project and is silently never run.
//
// The properties worth guarding are all failures that would be SILENT. A digest
// that moves when the test did not reports an edit nobody made. One that holds
// still when the test changed lets the run panel print "nothing was different"
// over a rewritten test, which is the bug this module was added against. And a
// comparison that ignores the scheme tag reads a step digest against a source
// digest and calls the difference an edit.

import { describe, expect, it } from "vitest";

import {
  canonicalSteps,
  comparableDigests,
  digestSchemeFor,
  digestSource,
  digestSteps,
  isRunDigest,
  SOURCE_SCHEME,
  STEPS_SCHEME,
} from "../../shared/steps-digest.mjs";
import * as runDigest from "../../shared/run-digest.mjs";

/** A step, shaped like the ones the recorder writes. */
function step(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s1",
    type: "click",
    locator: { k: "role", role: "button", name: "Sign in" },
    timestamp: 1_700_000_000_000,
    ...over,
  };
}

describe("digestSteps", () => {
  it("is stable across key order", () => {
    // Two stores hold the same step with its keys in different orders: a record
    // round-tripped through `normalizeStep` is rebuilt key by key, a hand edit
    // is not. Two spellings of one step reading as an edit is the whole reason
    // `canonicalJson` sorts.
    const a = [{ id: "s1", type: "click", value: "x" }];
    const b = [{ value: "x", type: "click", id: "s1" }];
    expect(digestSteps(a)).toBe(digestSteps(b));
  });

  it("sorts nested keys too, not just the step's own", () => {
    const a = [step({ locator: { k: "role", role: "button", name: "Go" } })];
    const b = [step({ locator: { name: "Go", k: "role", role: "button" } })];
    expect(digestSteps(a)).toBe(digestSteps(b));
  });

  it("treats an absent field and an explicit undefined as the same step", () => {
    expect(digestSteps([step()])).toBe(digestSteps([step({ soft: undefined })]));
  });

  it("ignores the element fingerprint", () => {
    // Auto-Heal and propagation rewrite it in place without the test's meaning
    // moving. Counting it would report every healed run as an edit — and a
    // healed run is reported by the `healed` panel, not this one.
    const plain = [step()];
    const healed = [step({ fingerprint: { text: "Sign in", attributes: {}, depth: 3 } })];
    expect(digestSteps(healed)).toBe(digestSteps(plain));
  });

  it("ignores the recording timestamp and the derived varRefs", () => {
    const later = [step({ timestamp: 1_800_000_000_000, varRefs: ["email"] })];
    expect(digestSteps(later)).toBe(digestSteps([step()]));
  });

  it("counts a changed locator", () => {
    const moved = [step({ locator: { k: "role", role: "button", name: "Log in" } })];
    expect(digestSteps(moved)).not.toBe(digestSteps([step()]));
  });

  it("counts a step's id, so a step re-recorded is a step changed", () => {
    expect(digestSteps([step({ id: "s9" })])).not.toBe(digestSteps([step()]));
  });

  it("counts `disabled`, because a disabled step is a step that did not run", () => {
    expect(digestSteps([step({ disabled: true })])).not.toBe(digestSteps([step()]));
  });

  it("counts order", () => {
    const a = [step({ id: "s1" }), step({ id: "s2" })];
    const b = [step({ id: "s2" }), step({ id: "s1" })];
    expect(digestSteps(a)).not.toBe(digestSteps(b));
  });

  it("counts a step added or removed", () => {
    expect(digestSteps([step(), step({ id: "s2" })])).not.toBe(digestSteps([step()]));
  });

  it("answers undefined for anything that is not a step list", () => {
    // Undefined rather than a digest of nothing. Absent means UNKNOWN to every
    // reader; a digest here would make "we were not told" indistinguishable
    // from "it executed an empty test", and the first must never earn the
    // flake reading.
    for (const bad of [null, undefined, "steps", 4, {}]) {
      expect(digestSteps(bad)).toBeUndefined();
    }
  });

  it("digests an empty list, which is a real answer", () => {
    expect(digestSteps([])).toMatch(/^s1:[0-9a-f]{16}$/);
  });

  it("carries the step scheme and sixteen hex characters", () => {
    const d = digestSteps([step()]);
    expect(d?.startsWith(STEPS_SCHEME + ":")).toBe(true);
    expect(d).toMatch(/^s1:[0-9a-f]{16}$/);
  });
});

describe("canonicalSteps", () => {
  it("shows WHY two lists digested alike", () => {
    // The point of exporting it: a failing equality above is unreadable as two
    // hex strings and obvious as two canonical forms.
    expect(canonicalSteps([step()])).toBe(canonicalSteps([step({ timestamp: 1 })]));
    expect(canonicalSteps("not a list")).toBeNull();
  });
});

describe("digestSource", () => {
  it("carries the source scheme", () => {
    const d = digestSource("import { test } from '@playwright/test';");
    expect(d?.startsWith(SOURCE_SCHEME + ":")).toBe(true);
    expect(d).toMatch(/^x1:[0-9a-f]{16}$/);
  });

  it("moves on any byte", () => {
    expect(digestSource("await page.click('a');")).not.toBe(
      digestSource("await page.click('b');"),
    );
  });

  it("answers undefined when there was nothing to read", () => {
    // `readSpecSource` in both runners answers null for a spec it could not
    // open, and that has to stay absent rather than become a digest of "null".
    for (const bad of [null, undefined, 4, {}]) expect(digestSource(bad)).toBeUndefined();
  });
});

describe("digestSchemeFor", () => {
  it("digests the steps of an ordinary app-generated test", () => {
    expect(digestSchemeFor({ id: "t1" })).toBe("steps");
  });

  it("digests the FILE when the file is the record", () => {
    // Each of these three means the step list is not what runs. Digesting the
    // steps there would let the panel report "the same steps" about a script
    // somebody rewrote.
    expect(digestSchemeFor({ scriptEdited: true })).toBe("source");
    expect(digestSchemeFor({ sourceDir: "/imported/project" })).toBe("source");
    expect(digestSchemeFor({ stepsDiverged: true })).toBe("source");
  });

  it("digests the steps of a replay whatever the test says", () => {
    // A replay writes its spec FROM the recorded steps immediately before it
    // runs, so those steps are exactly what executed — even for a test whose
    // own script somebody has since hand-edited.
    expect(digestSchemeFor({ scriptEdited: true }, true)).toBe("steps");
  });

  it("falls to the file for a test it cannot read at all", () => {
    // The safe direction: an unreadable record must not be assumed to be the
    // simple case, because the simple case is the one that earns the strong
    // claim.
    expect(digestSchemeFor(null)).toBe("source");
    expect(digestSchemeFor("t1")).toBe("source");
  });
});

describe("isRunDigest", () => {
  it("accepts what this module writes", () => {
    expect(isRunDigest(digestSteps([step()]))).toBe(true);
    expect(isRunDigest(digestSource("x"))).toBe(true);
  });

  it("refuses anything else", () => {
    // It crosses the ingest boundary from another machine, and a mis-shaped
    // value stored here would be compared against a good digest forever.
    for (const bad of [
      "",
      "s1:",
      "s1:zzzzzzzzzzzzzzzz",
      "s1:0123456789abcde", // fifteen
      "s1:0123456789abcdef0", // seventeen
      "S1:0123456789abcdef",
      "0123456789abcdef",
      "../etc/passwd",
      42,
      null,
      undefined,
    ]) {
      expect(isRunDigest(bad)).toBe(false);
    }
  });
});

describe("comparableDigests", () => {
  const steps = digestSteps([step()]);
  const otherSteps = digestSteps([step({ id: "s2" })]);
  const source = digestSource("await page.click('a');");

  it("says same for one test run twice unchanged", () => {
    expect(comparableDigests(steps, digestSteps([step()]))).toBe("same");
  });

  it("says different when the steps moved", () => {
    expect(comparableDigests(steps, otherSteps)).toBe("different");
  });

  it("says unknown across schemes rather than different", () => {
    // A test that became hand-edited between two runs has not been SHOWN to
    // differ, and a future `s2:` must not turn every library's history into a
    // wall of edits on upgrade day.
    expect(comparableDigests(steps, source)).toBe("unknown");
    expect(comparableDigests("s2:0123456789abcdef", "s1:0123456789abcdef")).toBe("unknown");
  });

  it("says unknown when either side is absent or unusable", () => {
    // Every run recorded before the field is this case, and reading it as
    // "same" is precisely the bug the field exists to close.
    expect(comparableDigests(steps, undefined)).toBe("unknown");
    expect(comparableDigests(undefined, steps)).toBe("unknown");
    expect(comparableDigests(undefined, undefined)).toBe("unknown");
    expect(comparableDigests(steps, "nonsense")).toBe("unknown");
  });
});

describe("the reading half (run-digest.mjs)", () => {
  // The renderer imports run-digest.mjs; the runners import steps-digest.mjs.
  // One implementation behind both names, or a digest the app writes could be
  // read by a different rule than the one it was written against.
  it("is the SAME implementation steps-digest.mjs re-exports", () => {
    expect(runDigest.comparableDigests).toBe(comparableDigests);
    expect(runDigest.isRunDigest).toBe(isRunDigest);
    expect(runDigest.STEPS_SCHEME).toBe(STEPS_SCHEME);
    expect(runDigest.SOURCE_SCHEME).toBe(SOURCE_SCHEME);
  });

  it("recognises what the writing half writes", () => {
    const written = digestSteps([step()]);
    expect(runDigest.isRunDigest(written)).toBe(true);
    expect(runDigest.comparableDigests(written, digestSteps([step()]))).toBe("same");
  });
});
