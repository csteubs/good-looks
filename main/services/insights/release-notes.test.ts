// `unseenNotes` — positional, and deliberately conservative at the edges.
//
// The wrong reading on either edge is loud in the report: a first-ever digest
// that opens with the entire changelog reads as a marketing page, and a
// pruned lastSeen that dumps everything makes an old install's first report
// after an update three screens long.

import { describe, expect, it } from "vitest";

import { RELEASE_NOTES, unseenNotes, type ReleaseNote } from "./release-notes.js";

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

  it("the shipped list carries the running version's own entry", () => {
    // The maintenance rule in the module header, pinned: the seed entry for
    // the current package version must exist, or a fresh install's first
    // report claims the app has no release notes at all.
    expect(RELEASE_NOTES.some((n) => n.version === "1.0.0")).toBe(true);
  });
});
