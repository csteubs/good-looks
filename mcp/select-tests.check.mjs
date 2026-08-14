// Standalone regression check for the MCP server's run_batch test selection.
//
// run_batch can be driven by an agent with no eyes on the app, so its selection
// semantics need to be predictable and safe:
//   - explicit ids run in the ORDER GIVEN (a batch is a sequence);
//   - a requested id that doesn't exist is REPORTED, not silently dropped —
//     otherwise "run these 5" quietly runs 4 and still reports success;
//   - tag selection matches case-insensitively (tags are stored as typed);
//   - hidden tests are excluded from tag/all selections but honored when named
//     explicitly, since hiding is a sidebar concern, not a "never run" flag.
//
// Pure module, no filesystem — run with:
//   npm run check:mcp-select

import process from "node:process";
import console from "node:console";

import { selectTests, summarizeResults, UNGROUPED, UNTAGGED } from "./select-tests.mjs";

let failures = 0;

function assert(condition, label) {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const tests = [
  { id: "a", name: "A", tags: ["smoke", "checkout"], group: "Storefront" },
  { id: "b", name: "B", tags: ["Smoke"], group: "Storefront" },
  { id: "c", name: "C" },
  { id: "d", name: "D", tags: [], hidden: true },
  { id: "e", name: "E", tags: ["nightly"], hidden: true, group: "Storefront" },
  // Two casings ARE two folders in the app, so they must be here too.
  { id: "f", name: "F", group: "storefront" },
  { id: "g", name: "G", group: "  Admin  " },
];

const ids = (r) => r.tests.map((t) => t.id).join(",");

// ── Default: every visible test ──────────────────────────────────────
assert(ids(selectTests(tests)) === "a,b,c,f,g", "no selector → every VISIBLE test");
assert(ids(selectTests(tests, {})) === "a,b,c,f,g", "empty selector behaves the same");
assert(selectTests([], {}).tests.length === 0, "an empty library selects nothing");
assert(ids(selectTests(undefined, {})) === "", "a non-array library is handled");

// ── Explicit ids ─────────────────────────────────────────────────────
assert(ids(selectTests(tests, { testIds: ["b", "a"] })) === "b,a", "ids run in the order given");
assert(
  selectTests(tests, { testIds: ["a", "ghost", "b"] }).missing.join(",") === "ghost",
  "a missing id is reported",
);
assert(
  ids(selectTests(tests, { testIds: ["a", "ghost", "b"] })) === "a,b",
  "the rest of the batch still runs when one id is missing",
);
assert(
  ids(selectTests(tests, { testIds: ["e"] })) === "e",
  "a hidden test IS run when named explicitly by id",
);
assert(
  selectTests(tests, { testIds: [] }).tests.length === 5,
  "an empty testIds array falls back to the default selection",
);

// ── Tag selection ────────────────────────────────────────────────────
assert(ids(selectTests(tests, { tag: "smoke" })) === "a,b", "tag matches across casings");
assert(ids(selectTests(tests, { tag: "SMOKE" })) === "a,b", "the query's casing doesn't matter");
assert(ids(selectTests(tests, { tag: "checkout" })) === "a", "a single-test tag selects one");
assert(selectTests(tests, { tag: "nope" }).tests.length === 0, "an unused tag selects nothing");
assert(
  selectTests(tests, { tag: "nightly" }).tests.length === 0,
  "a tag on a HIDDEN test selects nothing (hidden is excluded from tag runs)",
);
assert(ids(selectTests(tests, { tag: UNTAGGED })) === "c,f,g", "the untagged sentinel selects untagged visible tests");

// Explicit ids win over a tag — the caller was specific.
assert(
  ids(selectTests(tests, { testIds: ["a"], tag: "nightly" })) === "a",
  "explicit ids take precedence over a tag",
);

// ── Group selection (REDESIGN §7.2, the run_group tool) ──────────────
//
// A folder is where a test LIVES — one per test — where a tag is a label it
// can carry several of. Every case below is one where an agent with no eyes on
// the app would run a different set of tests than the folder it named.
assert(ids(selectTests(tests, { group: "Storefront" })) === "a,b", "a group selects its members");
assert(
  selectTests(tests, { group: "Storefront" }).tests.every((t) => t.id !== "e"),
  "a HIDDEN member is excluded, the same as it is from a tag run",
);
assert(
  ids(selectTests(tests, { group: "storefront" })) === "f",
  "matching is CASE-SENSITIVE — two casings are two folders in the rail, and folding them would run a folder the caller can see is a different one",
);
assert(
  ids(selectTests(tests, { group: "  Storefront  " })) === "a,b",
  "the QUERY is trimmed, so a pasted name with whitespace still finds its folder",
);
assert(
  ids(selectTests(tests, { group: "Admin" })) === "g",
  "a stored name is trimmed too — tests.json is a file a human can edit",
);
assert(selectTests(tests, { group: "Nope" }).tests.length === 0, "an unknown folder selects nothing");
assert(
  ids(selectTests(tests, { group: UNGROUPED })) === "c",
  "the ungrouped sentinel selects exactly the visible tests in NO folder",
);
assert(
  ids(selectTests(tests, { group: "Storefront", tag: "nightly" })) === "a,b",
  "a group takes precedence over a tag — a folder is the more deliberate of the two",
);
assert(
  ids(selectTests(tests, { testIds: ["c"], group: "Storefront" })) === "c",
  "explicit ids still win over a group",
);
assert(
  ids(selectTests(tests, { group: "" })) === "a,b,c,f,g",
  "an empty group falls back to the default selection rather than selecting the ungrouped",
);

// ── summarizeResults ─────────────────────────────────────────────────
const s1 = summarizeResults(
  [{ status: "passed" }, { status: "failed" }, { status: "skipped" }],
  1234,
);
assert(s1.total === 3 && s1.passed === 1 && s1.failed === 1 && s1.skipped === 1, "counts each status");
assert(s1.ok === false, "a batch with a failure is not ok");
assert(s1.durationMs === 1234, "duration is carried through");
assert(summarizeResults([{ status: "passed" }], 1).ok === true, "an all-passing batch is ok");
assert(
  summarizeResults([{ status: "skipped" }], 1).ok === false,
  "an all-skipped batch is NOT ok (matches the app)",
);
assert(summarizeResults([], 0).ok === false, "an empty batch is not ok");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll mcp-select checks passed");
