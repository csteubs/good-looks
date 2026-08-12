// The ranking. REDESIGN §6.7.
//
// A palette's only real failure mode is a wrong FIRST row: nobody reads the
// list, they type three letters and press Enter. So this file is mostly about
// what comes first, and about the two ways a hand-rolled scorer usually goes
// wrong — a long loose match outranking a short exact one, and a match on
// hidden keyword text outranking a match on a visible name.

import { describe, expect, it, vi } from "vitest";

import {
  GROUP_ORDER,
  filterCommands,
  groupCommands,
  hasWordPrefix,
  isSubsequence,
  clampSelection,
  moveSelection,
  scoreCommand,
} from "./command-palette";
import type { Command, CommandGroup } from "./command-palette";

function cmd(
  title: string,
  over: Partial<Command> & { group?: CommandGroup } = {},
): Command {
  return {
    id: over.id ?? title,
    title,
    group: over.group ?? "Tests",
    keywords: over.keywords,
    hint: over.hint,
    run: over.run ?? vi.fn(),
  };
}

const first = (query: string, commands: Command[]) =>
  filterCommands(query, commands)[0]?.title;

describe("scoreCommand", () => {
  it("ranks a title prefix above a word prefix above a scattered subsequence", () => {
    const prefix = scoreCommand("che", cmd("Checkout"))!;
    const word = scoreCommand("hap", cmd("Checkout happy path"))!;
    const subseq = scoreCommand("chp", cmd("Checkout happy path"))!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(subseq);
  });

  it("ranks any keyword match below every title match", () => {
    // A test whose URL happens to contain "stats" must never outrank the Stats
    // view. A hostname is context; a name is a name.
    const titleSubseq = scoreCommand("sts", cmd("Stats"))!;
    const keywordPrefix = scoreCommand("sts", cmd("Checkout", { keywords: "sts.example.com" }))!;
    expect(titleSubseq).toBeGreaterThan(keywordPrefix);
  });

  it("prefers the shorter of two equally-good titles", () => {
    expect(scoreCommand("stats", cmd("Stats"))!).toBeGreaterThan(
      scoreCommand("stats", cmd("Stats — flake report"))!,
    );
  });

  it("never lets shortness cross a tier", () => {
    // The classic hand-rolled-scorer bug: the shortest possible loose match
    // against the longest possible exact
    // one. The length term is a tie-break INSIDE a tier and must never add up
    // to a tier of its own.
    const shortSubseq = scoreCommand("ab", cmd("azb"))!;
    const longPrefix = scoreCommand("ab", cmd("abcdefghijklmnopqrstuvwxyz 0123456789"))!;
    expect(longPrefix).toBeGreaterThan(shortSubseq);
  });

  it("is case-insensitive on both sides and ignores surrounding space", () => {
    expect(scoreCommand("  CHE  ", cmd("Checkout"))).toBe(scoreCommand("che", cmd("Checkout")));
  });

  it("returns null when the letters are not there in order", () => {
    expect(scoreCommand("zzz", cmd("Checkout"))).toBeNull();
    expect(scoreCommand("tuokcehc", cmd("Checkout"))).toBeNull();
  });

  it("scores an empty query as a match for everything, flat", () => {
    expect(scoreCommand("", cmd("Checkout"))).toBe(0);
    expect(scoreCommand("   ", cmd("Stats"))).toBe(0);
  });
});

describe("the two matchers", () => {
  it("isSubsequence needs the letters in order, not adjacent", () => {
    expect(isSubsequence("chp", "checkout happy path")).toBe(true);
    expect(isSubsequence("pch", "checkout happy path")).toBe(false);
    expect(isSubsequence("", "anything")).toBe(true);
  });

  it("hasWordPrefix splits on punctuation, not only on spaces", () => {
    // An em dash, a hyphen and a colon all start a new word here. Splitting on
    // spaces alone leaves a punctuated title reachable only from its first word.
    expect(hasWordPrefix("happy", "Checkout — happy path")).toBe(true);
    expect(hasWordPrefix("login", "run:t-login")).toBe(true);
    expect(hasWordPrefix("appy", "Checkout — happy path")).toBe(false);
  });
});

describe("filterCommands", () => {
  const commands = [
    cmd("Record a test", { group: "Actions" }),
    cmd("Checkout — happy path", { keywords: "shop.example.com checkout smoke" }),
    cmd("Login — wrong password", { keywords: "app.example.com auth" }),
    cmd("Stats", { group: "Views" }),
    cmd("Visual", { group: "Views" }),
  ];

  it("keeps the given order when nothing is typed", () => {
    // A palette that opens on a list is a menu, and only the caller knows what
    // belongs at the top of it. Scoring an empty query would sort by title
    // length, which is a ranking by accident.
    expect(filterCommands("", commands).map((c) => c.title)).toEqual(
      commands.map((c) => c.title),
    );
  });

  it("puts the best answer first even when its group is last", () => {
    // Groups are for reading a list you are browsing, not for filtering one
    // you are searching. Stats is in the LAST group and must still win.
    expect(first("stat", commands)).toBe("Stats");
  });

  it("reaches a test by its host, below anything matching by name", () => {
    expect(first("shop", commands)).toBe("Checkout — happy path");
  });

  it("drops what does not match at all", () => {
    expect(filterCommands("qqqq", commands)).toEqual([]);
  });

  it("is stable for commands the query cannot tell apart", () => {
    // Two identical scores must keep their given order, or the list jitters
    // under the cursor as the user types.
    const twins = [cmd("aa", { id: "1" }), cmd("aa", { id: "2" })];
    expect(filterCommands("aa", twins).map((c) => c.id)).toEqual(["1", "2"]);
    expect(filterCommands("a", twins).map((c) => c.id)).toEqual(["1", "2"]);
  });
});

describe("groupCommands", () => {
  it("returns the blocks in GROUP_ORDER and drops the empty ones", () => {
    const out = groupCommands([
      cmd("Stats", { group: "Views" }),
      cmd("Record", { group: "Actions" }),
      cmd("Checkout", { group: "Tests" }),
    ]);
    expect(out.map((g) => g.group)).toEqual(["Actions", "Tests", "Views"]);
  });

  it("puts actions first and views last", () => {
    // The order is a decision: actions are what somebody opened the palette to
    // do, and the rail already lists the views.
    expect(GROUP_ORDER[0]).toBe("Actions");
    expect(GROUP_ORDER[GROUP_ORDER.length - 1]).toBe("Views");
  });
});

describe("moveSelection", () => {
  it("wraps at both ends", () => {
    expect(moveSelection(0, -1, 4)).toBe(3);
    expect(moveSelection(3, 1, 4)).toBe(0);
    expect(moveSelection(1, 1, 4)).toBe(2);
  });

  it("survives an empty list, which every non-matching query produces", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(moveSelection(0, -1, 0)).toBe(0);
  });
});

describe("clampSelection", () => {
  it("pulls a selection back inside a list that shrank under it", () => {
    // The case is a background refetch, not the keyboard: typing resets the
    // selection to the top, so no keystroke can leave it past the end. A test
    // deleted in another window shortens the list with no input at all, and an
    // unclamped index leaves Enter doing nothing — a dead key, not a stale list.
    expect(clampSelection(9, 3)).toBe(2);
    expect(clampSelection(1, 3)).toBe(1);
  });

  it("reports -1 for an empty list rather than 0", () => {
    // 0 would be a valid index into a list with no rows, and the caller would
    // then read `visible[0]` and get `undefined` on every Enter.
    expect(clampSelection(0, 0)).toBe(-1);
    expect(clampSelection(5, 0)).toBe(-1);
  });

  it("never returns a negative index for a list that has rows", () => {
    expect(clampSelection(-3, 4)).toBe(0);
  });
});
