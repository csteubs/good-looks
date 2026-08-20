// CSV → dataset rows. The dialect battery covers what real exports contain
// (quotes, embedded delimiters and newlines, CRLF, BOM, Excel's semicolons);
// the mapping tests pin the two honesty rules — columns refused OUT LOUD with
// a reason, and nothing silently truncated.

import { describe, expect, it } from "vitest";

import { datasetsFromCsv, parseCsv } from "./dataset-csv.js";
import { MAX_DATASETS_PER_TEST, type TestVariable } from "../recorder/types.js";

let n = 0;
const newId = () => `id${n++}`;
const vars = (...defs: [string, TestVariable["kind"]][]): TestVariable[] =>
  defs.map(([name, kind]) => ({ name, kind, ...(kind === "secret" ? {} : { value: "" }) }));

describe("parseCsv", () => {
  it("splits plain rows", () => {
    expect(parseCsv("a,b\n1,2\n3,4").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("honours RFC 4180 quoting — embedded delimiters, newlines, and doubled quotes", () => {
    const { rows } = parseCsv('name,note\n"Doe, Jane","said ""hi""\nand left"');
    expect(rows).toEqual([
      ["name", "note"],
      ["Doe, Jane", 'said "hi"\nand left'],
    ]);
  });

  it("accepts CRLF and a trailing newline without a phantom row", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a BOM so the first header cell keeps its name", () => {
    expect(parseCsv("﻿user,pass\nu,p").rows[0]).toEqual(["user", "pass"]);
  });

  it("skips fully blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n,\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("sniffs Excel's semicolons and tabs from the header line", () => {
    expect(parseCsv("a;b\n1;2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    // A quoted cell full of semicolons must not outvote the real commas.
    expect(parseCsv('a,"x;;;;y"\n1,2').rows[0]).toEqual(["a", "x;;;;y"]);
  });
});

describe("datasetsFromCsv", () => {
  it("maps header columns to variables and rows to named datasets", () => {
    const r = datasetsFromCsv("user,city\nalice,Berlin\nbob,Lyon", {
      variables: vars(["user", "plain"]),
      existingCount: 0,
      newId,
    });
    expect(r.ok).toBe(true);
    expect(r.rows.map((d) => d.name)).toEqual(["Row 1", "Row 2"]);
    expect(r.rows[0].values).toEqual({ user: "alice", city: "Berlin" });
    // `city` wasn't declared — the caller is told to create it, so the
    // imported values are live rather than inert.
    expect(r.createdVariables).toEqual(["city"]);
  });

  it("continues Row numbering from the rows already on the record", () => {
    const r = datasetsFromCsv("user\na", { variables: [], existingCount: 3, newId });
    expect(r.rows[0].name).toBe("Row 4");
  });

  it("refuses a secret column out loud", () => {
    const r = datasetsFromCsv("user,password\na,hunter2", {
      variables: vars(["user", "plain"], ["password", "secret"]),
      existingCount: 0,
      newId,
    });
    expect(r.ok).toBe(true);
    expect(r.skippedColumns).toEqual([{ name: "password", reason: "secret variable" }]);
    // The refused column's values never land in a row.
    expect(r.rows[0].values).toEqual({ user: "a" });
    expect(Object.keys(r.rows[0].values)).not.toContain("password");
  });

  it("skips invalid and duplicate headers with their reasons", () => {
    const r = datasetsFromCsv("user,2bad,user,\na,b,c,d", {
      variables: [],
      existingCount: 0,
      newId,
    });
    expect(r.skippedColumns).toEqual([
      { name: "2bad", reason: "invalid name" },
      { name: "user", reason: "duplicate column" },
      { name: "column 4", reason: "invalid name" },
    ]);
    expect(r.rows[0].values).toEqual({ user: "a" });
  });

  it("pads and trims ragged rows, and counts them", () => {
    const r = datasetsFromCsv("a,b\n1\n1,2,3\n1,2", {
      variables: [],
      existingCount: 0,
      newId,
    });
    expect(r.ok).toBe(true);
    expect(r.raggedRows).toBe(2);
    expect(r.rows[0].values).toEqual({ a: "1", b: "" });
    expect(r.rows[1].values).toEqual({ a: "1", b: "2" });
  });

  it("flags truncation at the cap instead of dropping rows silently", () => {
    const lines = ["v"];
    for (let i = 0; i < MAX_DATASETS_PER_TEST + 10; i++) lines.push(String(i));
    const r = datasetsFromCsv(lines.join("\n"), {
      variables: [],
      existingCount: 5,
      newId,
    });
    expect(r.ok).toBe(true);
    expect(r.rows.length).toBe(MAX_DATASETS_PER_TEST - 5);
    expect(r.truncated).toBe(true);
  });

  it("fails with a reason on empty, header-only, and no-usable-column files", () => {
    expect(datasetsFromCsv("", { variables: [], existingCount: 0, newId }).problem).toMatch(
      /empty/i,
    );
    expect(datasetsFromCsv("a,b", { variables: [], existingCount: 0, newId }).problem).toMatch(
      /no data rows/i,
    );
    const bad = datasetsFromCsv("1,2\nx,y", { variables: [], existingCount: 0, newId });
    expect(bad.ok).toBe(false);
    expect(bad.problem).toMatch(/usable variable name/i);
    expect(bad.skippedColumns.length).toBe(2);
  });

  it("fails when the record is already at the cap", () => {
    const r = datasetsFromCsv("a\n1", {
      variables: [],
      existingCount: MAX_DATASETS_PER_TEST,
      newId,
    });
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/cap/i);
  });
});
