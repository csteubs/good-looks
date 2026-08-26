// A library resolves its own specs on whatever machine is reading it (R10).
//
// `scriptPath` is stored ABSOLUTE, from the machine that recorded the test. Every
// reader trusted it, so a library copied anywhere else — a CI runner, a restored
// backup, a userData move — resolved every spec to a path outside the reader's
// scripts directory. `path.relative` then handed Playwright
// a `../../../../..`-prefixed path back up to the author's home directory, it
// found no tests, and the run reported that as a test failure rather than as a
// library that did not arrive.
//
// The rule is the one `testStore.writeScript` already applied before WRITING —
// only a path inside this scripts dir is honoured — moved to shared/ and applied
// on read, where all three processes need it.
//
// The hostile cases are not hypothetical framing: a bundle is a folder somebody
// hands you, exactly like an imported project, and its `tests.json` is a file
// they wrote. The derived path is joined onto the local scripts dir and then
// READ AND EXECUTED as a Playwright spec.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  IMPORTED_SEGMENT,
  isInsideScripts,
  isSafeId,
  resolveScriptPath,
  scriptRelSegments,
  scriptsDirFor,
} from "../../shared/script-path.mjs";

/** What an authoring machine stores, and what a runner has. */
const AUTHORED = "/Users/alice/Library/Application Support/Good Looks!/recorder/scripts";
const RUNNER = "/home/runner/.config/good-looks/recorder/scripts";

const recorded = { id: "t-login", scriptPath: join(AUTHORED, "t-login.spec.ts") };
const imported = {
  id: "t-imp",
  sourceDir: "/Users/alice/projects/shop",
  scriptPath: join(AUTHORED, IMPORTED_SEGMENT, "t-imp", "tests", "add-to-cart.spec.ts"),
};

describe("on the machine that recorded the test", () => {
  it("returns the stored path untouched", () => {
    // The path that matters most: every existing run on every existing machine.
    // A change here would be a migration, and there is deliberately none.
    expect(resolveScriptPath(AUTHORED, recorded)).toBe(recorded.scriptPath);
    expect(resolveScriptPath(AUTHORED, imported)).toBe(imported.scriptPath);
  });
});

describe("on a machine the library was copied to", () => {
  it("finds a recorded test's spec", () => {
    expect(resolveScriptPath(RUNNER, recorded)).toBe(join(RUNNER, "t-login.spec.ts"));
  });

  it("keeps an imported test's position inside its own sandbox", () => {
    // Its spec relative-imports its siblings, so the position is the whole
    // point — flattening it to `<id>.spec.ts` would resolve to a file that
    // exists and then fail on its own imports.
    expect(resolveScriptPath(RUNNER, imported)).toBe(
      join(RUNNER, IMPORTED_SEGMENT, "t-imp", "tests", "add-to-cart.spec.ts"),
    );
  });

  it("reads a path a Windows machine wrote", () => {
    const win = { id: "t-win", scriptPath: "C:\\Users\\bob\\AppData\\gl\\scripts\\t-win.spec.ts" };
    expect(resolveScriptPath(RUNNER, win)).toBe(join(RUNNER, "t-win.spec.ts"));
  });

  it("finds a Windows-authored IMPORTED test's position", () => {
    // The case the backslash split is actually for. A flat record resolves the
    // same either way — the fallback happens to be right — so splitting only on
    // `/` passed every other case here and this one is what catches it.
    const win = {
      id: "t-wimp",
      scriptPath: "C:\\Users\\bob\\AppData\\gl\\recorder\\scripts\\imported\\t-wimp\\tests\\a.spec.ts",
    };
    expect(resolveScriptPath(RUNNER, win)).toBe(
      join(RUNNER, IMPORTED_SEGMENT, "t-wimp", "tests", "a.spec.ts"),
    );
  });

  it("resolves a record that never had a path at all", () => {
    expect(resolveScriptPath(RUNNER, { id: "t-bare" })).toBe(join(RUNNER, "t-bare.spec.ts"));
  });

  it("produces a spec argument that stays inside the scripts dir", () => {
    // The actual failing expression, asserted directly: this is what the runner
    // hands Playwright, and `..` in it is the bug.
    for (const rec of [recorded, imported]) {
      const arg = relative(RUNNER, resolveScriptPath(RUNNER, rec)!);
      expect(arg.startsWith("..")).toBe(false);
      expect(arg.split(sep).includes("..")).toBe(false);
    }
  });
});

describe("a tests.json somebody else wrote", () => {
  it("refuses an id that is a path", () => {
    for (const id of ["../../etc/passwd", "a/b", "a\\b", "..", ".", "", "a\0b"]) {
      expect(isSafeId(id), `id ${JSON.stringify(id)}`).toBe(false);
      expect(resolveScriptPath(RUNNER, { id })).toBeNull();
    }
  });

  it("drops a `..` segment before it is ever joined", () => {
    // Two defences here, and they are not the same one. `isSafeSegment` refuses
    // the segment; the final containment check refuses the RESULT. Asserting
    // only the result leaves the first redundant and unnoticed — removing it
    // broke nothing until this case existed, which is exactly how a defence
    // rots. `scriptRelSegments` is the one that has to say no.
    //
    // Built as a RAW STRING, not with `join` — `path.join` normalises `..`
    // away, so a hostile path constructed with it arrives already harmless and
    // the case proves nothing. A hostile `tests.json` contains the literal
    // segments, because nothing normalised it on the way in. The first draft of
    // this case used `join` and was vacuous for exactly that reason.
    const evil = {
      id: "t-dots",
      scriptPath: `${AUTHORED}/${IMPORTED_SEGMENT}/t-dots/../../../../../../etc/passwd`,
    };
    expect(scriptRelSegments(evil)).toEqual(["t-dots.spec.ts"]);
  });

  it("does not walk out of the sandbox on a `..` tail", () => {
    // The tail after `imported/<id>/` is attacker-chosen on a copied library.
    // Raw string, for the reason the case above gives.
    const evil = {
      id: "t-evil",
      scriptPath: `${AUTHORED}/${IMPORTED_SEGMENT}/t-evil/../../../etc/passwd`,
    };
    const out = resolveScriptPath(RUNNER, evil)!;
    expect(isInsideScripts(RUNNER, out)).toBe(true);
    // Falls back to the flat default rather than honouring any of it.
    expect(out).toBe(join(RUNNER, "t-evil.spec.ts"));
  });

  it("neutralises an absolute-looking tail rather than honouring it", () => {
    // `//etc/passwd` after the sandbox segment is an attempt to restart the
    // path at the filesystem root. Splitting on runs of either separator drops
    // the empty segment, so what is left is an ordinary — if odd — filename
    // INSIDE that test's own sandbox. Containment is the property worth
    // asserting; the exact resting place is not, and the first draft of this
    // case asserted the flat fallback and was simply wrong about the code.
    const evil = { id: "t-abs", scriptPath: `${AUTHORED}/${IMPORTED_SEGMENT}/t-abs//etc/passwd` };
    const out = resolveScriptPath(RUNNER, evil)!;
    expect(out).toBe(join(RUNNER, IMPORTED_SEGMENT, "t-abs", "etc", "passwd"));
    expect(isInsideScripts(RUNNER, out)).toBe(true);
    expect(isInsideScripts(join(RUNNER, IMPORTED_SEGMENT, "t-abs"), out)).toBe(true);
  });

  it("does not read a neighbouring library as inside this one", () => {
    // `/a/scripts-evil` is not inside `/a/scripts`, and a prefix compare says
    // it is — the same trap `isInside` in import-service.ts documents.
    expect(isInsideScripts("/a/scripts", "/a/scripts-evil/x.spec.ts")).toBe(false);
    expect(isInsideScripts("/a/scripts", "/a/scripts/x.spec.ts")).toBe(true);
  });

  it("does not treat a sandbox segment belonging to another id as this one's", () => {
    const other = { id: "t-mine", scriptPath: join(AUTHORED, IMPORTED_SEGMENT, "t-theirs", "a.spec.ts") };
    expect(scriptRelSegments(other)).toEqual(["t-mine.spec.ts"]);
  });
});

describe("a library relocated on disk, end to end", () => {
  it("resolves every spec in a copied library to a file that is really there", () => {
    // Not a model of the move — an actual one. Write a library, copy it to a
    // second root with a different name, and resolve the ORIGINAL records
    // against the new scripts dir.
    const root = mkdtempSync(join(tmpdir(), "gl-authored-"));
    const authored = scriptsDirFor(join(root, "recorder"));
    mkdirSync(join(authored, IMPORTED_SEGMENT, "t-imp", "tests"), { recursive: true });
    writeFileSync(join(authored, "t-flat.spec.ts"), "// flat\n");
    writeFileSync(join(authored, IMPORTED_SEGMENT, "t-imp", "tests", "a.spec.ts"), "// imported\n");
    const records = [
      { id: "t-flat", scriptPath: join(authored, "t-flat.spec.ts") },
      {
        id: "t-imp",
        scriptPath: join(authored, IMPORTED_SEGMENT, "t-imp", "tests", "a.spec.ts"),
      },
    ];

    const moved = mkdtempSync(join(tmpdir(), "gl-runner-"));
    const runnerScripts = scriptsDirFor(join(moved, "recorder"));
    mkdirSync(join(runnerScripts, IMPORTED_SEGMENT, "t-imp", "tests"), { recursive: true });
    writeFileSync(join(runnerScripts, "t-flat.spec.ts"), "// flat\n");
    writeFileSync(join(runnerScripts, IMPORTED_SEGMENT, "t-imp", "tests", "a.spec.ts"), "// imported\n");

    for (const rec of records) {
      const resolved = resolveScriptPath(runnerScripts, rec)!;
      expect(resolved, `resolving ${rec.id}`).toBeTruthy();
      // The file is really at the resolved path, and the argument the runner
      // would build from it does not escape.
      expect(() => writeFileSync(resolved, "// touched\n")).not.toThrow();
      expect(relative(runnerScripts, resolved).startsWith("..")).toBe(false);
    }
  });
});
