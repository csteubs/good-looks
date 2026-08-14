// The library rail's folders — REDESIGN §7.2.
//
// Every case here is one where the rail would draw a perfectly well-formed list
// that is not the library: a test in two places, a count that disagrees with
// the rows under it, a folder that outlives its last member, or one that eats a
// test because its name was whitespace. None of them throws.

import { describe, it, expect } from "vitest";

import { groupNames, libraryRows, toggleCollapsed } from "./library-groups";
import type { RunVerdict } from "./run-verdict";

function t(id: string, group?: string) {
  return group === undefined ? { id } : { id, group };
}

describe("libraryRows", () => {
  it("puts folders first, alphabetically, then the loose tests in order", () => {
    const rows = libraryRows([
      t("a", "Storefront"),
      t("b"),
      t("c", "Admin"),
      t("d"),
      t("e", "Storefront"),
    ]);
    expect(
      rows.map((r) => (r.kind === "group" ? `g:${r.name}` : r.test.id)),
    ).toEqual(["g:Admin", "g:Storefront", "b", "d"]);
  });

  it("keeps each folder's members in the order the library gave them", () => {
    // The rail is newest-first, and a folder that re-sorted its own contents
    // would be a second ordering nobody asked for.
    const rows = libraryRows([t("a", "S"), t("b"), t("c", "S")]);
    const group = rows[0];
    expect(group.kind === "group" && group.tests.map((x) => x.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("puts a test in exactly one place", () => {
    // The whole reason `group` is a string and `tags` is a list. A test drawn
    // under two folders makes every count on screen wrong.
    const rows = libraryRows([t("a", "S"), t("b", "S"), t("c")]);
    const drawn = rows.flatMap((r) =>
      r.kind === "group" ? r.tests.map((x) => x.id) : [r.test.id],
    );
    expect(drawn).toEqual(["a", "b", "c"]);
    expect(new Set(drawn).size).toBe(drawn.length);
  });

  it("treats a whitespace-only group as ungrouped rather than drawing a nameless folder", () => {
    // A record written before this field existed, or edited by hand, is the
    // same untrusted input every other read treats it as. Drawing the folder
    // would hide the test behind a header with no visible title.
    const rows = libraryRows([t("a", "   "), t("b", "")]);
    expect(rows.every((r) => r.kind === "test")).toBe(true);
    expect(rows.map((r) => r.kind === "test" && r.test.id)).toEqual(["a", "b"]);
  });

  it("trims a group name so two spellings of one folder are one folder", () => {
    const rows = libraryRows([t("a", "Storefront"), t("b", " Storefront ")]);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(1);
    const group = rows[0];
    expect(group.kind === "group" && group.tests.map((x) => x.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("has no folder that no test carries — a group IS its members", () => {
    // There is no groups store, so an emptied folder cannot linger: nothing
    // holds a reference to it. This pins that the derivation is the only
    // source, which is what makes deleting a group "move everyone out".
    const rows = libraryRows([t("a")]);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(0);
  });

  it("marks a folder collapsed by NAME, and still reports its members", () => {
    // The row carries its members either way: what to draw is the rail's
    // decision, and a caller that has to ask this file twice can get the two
    // answers out of step.
    const rows = libraryRows([t("a", "S"), t("b", "T")], ["S"]);
    const [s, tt] = rows;
    expect(s.kind === "group" && s.collapsed).toBe(true);
    expect(s.kind === "group" && s.tests).toHaveLength(1);
    expect(tt.kind === "group" && tt.collapsed).toBe(false);
  });

  it("ignores a collapsed name no test carries", () => {
    const rows = libraryRows([t("a", "S")], ["Gone", "S"]);
    expect(rows.filter((r) => r.kind === "group")).toHaveLength(1);
  });

  it("aggregates its members' verdicts into one dot", () => {
    const verdicts = new Map<string, RunVerdict>([
      ["a", "passed"],
      ["b", "failed"],
    ]);
    const rows = libraryRows([t("a", "S"), t("b", "S")], [], verdicts);
    const group = rows[0];
    expect(group.kind === "group" && group.tone?.label).toBe(
      "1 of 2 tests passed",
    );
  });

  it("carries no dot for a folder whose tests have never run", () => {
    // A grey dot would claim a result. No dot is the honest reading, and it is
    // the same one a test row with no runs gets.
    const rows = libraryRows([t("a", "S")], []);
    const group = rows[0];
    expect(group.kind === "group" && group.tone).toBeNull();
  });

  it("sorts two case-different folders next to each other", () => {
    // They ARE two folders — see `normalizeGroup` — so the least this can do is
    // not put them in opposite halves of the list.
    const rows = libraryRows([
      t("a", "checkout"),
      t("b", "Admin"),
      t("c", "Checkout"),
    ]);
    expect(
      rows
        .filter((r) => r.kind === "group")
        .map((r) => (r.kind === "group" ? r.name : "")),
    ).toEqual(["Admin", "checkout", "Checkout"]);
  });
});

describe("groupNames", () => {
  it("lists every folder once, alphabetically", () => {
    expect(
      groupNames([
        t("a", "Storefront"),
        t("b", "Admin"),
        t("c", "Storefront"),
        t("d"),
      ]),
    ).toEqual(["Admin", "Storefront"]);
  });

  it("omits a whitespace-only name, which is not a folder", () => {
    expect(groupNames([t("a", "  "), t("b")])).toEqual([]);
  });
});

describe("toggleCollapsed", () => {
  it("collapses one and leaves the rest", () => {
    expect(toggleCollapsed(["A"], "B")).toEqual(["A", "B"]);
  });

  it("EXPANDS one that is collapsed — the half that matters", () => {
    // A folder you cannot reopen is a folder that ate your tests.
    expect(toggleCollapsed(["A", "B"], "A")).toEqual(["B"]);
  });

  it("returns a new list rather than mutating the stored one", () => {
    const before = ["A"];
    expect(toggleCollapsed(before, "B")).not.toBe(before);
    expect(before).toEqual(["A"]);
  });
});
