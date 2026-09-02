// `unseenNotes` — positional, and deliberately conservative at the edges.
//
// The wrong reading on either edge is loud in the report: a first-ever digest
// that opens with the entire changelog reads as a marketing page, and a
// pruned lastSeen that dumps everything makes an old install's first report
// after an update three screens long.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RELEASE_NOTES, unseenNotes, type ReleaseNote } from "./release-notes.js";

/** The version the app reports — read from disk rather than retyped, so the
 *  assertion below is about the file that actually gets bumped. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const NOTES: ReleaseNote[] = [
  { version: "1.2.0", date: "2026-09-01", highlights: ["c"] },
  { version: "1.1.0", date: "2026-08-25", highlights: ["b"] },
  { version: "1.0.0", date: "2026-08-18", highlights: ["a"] },
];

describe("unseenNotes", () => {
  it("returns everything newer than the last seen version", () => {
    expect(unseenNotes("1.0.0", "1.2.0", NOTES).map((n) => n.version)).toEqual([
      "1.2.0",
      "1.1.0",
    ]);
  });

  it("same version means nothing new", () => {
    expect(unseenNotes("1.2.0", "1.2.0", NOTES)).toEqual([]);
  });

  it("first report ever gets only the current version's entry, not history", () => {
    expect(unseenNotes(null, "1.1.0", NOTES).map((n) => n.version)).toEqual(["1.1.0"]);
  });

  it("an unknown lastSeen falls back to the current entry, never everything", () => {
    expect(unseenNotes("0.9.0", "1.2.0", NOTES).map((n) => n.version)).toEqual(["1.2.0"]);
  });

  it("a current version with no entry yields nothing rather than guessing", () => {
    expect(unseenNotes(null, "9.9.9", NOTES)).toEqual([]);
  });

  it("the shipped list carries the running version's own entry, first", () => {
    // The maintenance rule in the module header, pinned: `package.json` was
    // bumped, so the entry for THAT version must exist — or a fresh install's
    // first report claims the app has no release notes at all — and it must be
    // at the top, because position is what "since" means. Read from
    // package.json rather than retyped here, so the bump and the entry cannot
    // be checked against a third spelling of the version.
    expect(RELEASE_NOTES[0].version).toBe(PACKAGE_VERSION);
    expect(RELEASE_NOTES[0].highlights.length).toBeGreaterThan(0);
  });

  it("every entry names a distinct version", () => {
    // Matching is by string identity and list position. Two entries with one
    // version would make `findIndex` stop at the first and hide the second.
    const versions = RELEASE_NOTES.map((n) => n.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
