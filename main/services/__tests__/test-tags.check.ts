// Standalone regression check for test tags.
//
// Two halves, deliberately split across the IPC boundary:
//   - `normalizeTags` (main/recorder/types.ts) is the SINGLE source of truth for
//     canonical form. It sits directly behind an IPC handler, so it must accept
//     hostile input (non-arrays, non-strings, absurd lengths) without throwing
//     or persisting junk.
//   - the renderer's grouping helpers (renderer/lib/test-tags.ts) must match
//     case-insensitively, so a filter survives a tag being re-cased elsewhere.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:test-tags

import {
  MAX_TAGS_PER_TEST,
  MAX_TAG_LENGTH,
  normalizeTags,
} from "../../recorder/types.js";
import {
  ALL_TAGS,
  UNTAGGED,
  filterByTag,
  hasTag,
  parseTagInput,
  tagCounts,
  untaggedCount,
} from "../../../renderer/lib/test-tags.js";
import type { TestRecord } from "../../../renderer/lib/recorder-types.js";

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function test(id: string, tags?: string[]): TestRecord {
  return {
    id,
    name: `Test ${id}`,
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: `/tmp/${id}.spec.ts`,
    ...(tags ? { tags } : {}),
  } as TestRecord;
}

// ── normalizeTags: hostile input ─────────────────────────────────────
assert(normalizeTags(undefined).length === 0, "undefined → empty");
assert(normalizeTags(null).length === 0, "null → empty");
assert(normalizeTags("smoke").length === 0, "a bare string (not an array) → empty");
assert(normalizeTags(42).length === 0, "a number → empty");
assert(normalizeTags({}).length === 0, "an object → empty");
assert(
  normalizeTags(["ok", 5, null, undefined, {}, "fine"]).join(",") === "fine,ok",
  "non-string entries are dropped, valid ones kept",
);

// ── normalizeTags: canonical form ────────────────────────────────────
assert(normalizeTags(["  smoke  "]).join(",") === "smoke", "trims whitespace");
assert(normalizeTags(["", "   ", "smoke"]).join(",") === "smoke", "drops empty tags");
assert(
  normalizeTags(["check   out"]).join(",") === "check out",
  "collapses inner whitespace",
);
assert(
  normalizeTags(["Smoke", "smoke", "SMOKE"]).join(",") === "Smoke",
  "dedupes case-insensitively, first spelling wins",
);
assert(
  normalizeTags(["zeta", "alpha", "Mid"]).join(",") === "alpha,Mid,zeta",
  `sorts case-insensitively (got ${normalizeTags(["zeta", "alpha", "Mid"]).join(",")})`,
);

// Caps — these guard tests.json against a paste accident.
const long = "x".repeat(MAX_TAG_LENGTH + 50);
assert(
  normalizeTags([long])[0].length === MAX_TAG_LENGTH,
  `truncates an over-long tag to ${MAX_TAG_LENGTH}`,
);
const many = Array.from({ length: MAX_TAGS_PER_TEST + 15 }, (_, i) => `tag${i}`);
assert(
  normalizeTags(many).length === MAX_TAGS_PER_TEST,
  `caps tag count at ${MAX_TAGS_PER_TEST} (got ${normalizeTags(many).length})`,
);

// Idempotence: re-normalizing stored tags must be a no-op, or repeated saves
// would churn the record.
const once = normalizeTags(["  Beta ", "alpha", "ALPHA"]);
assert(
  normalizeTags(once).join(",") === once.join(","),
  "normalizeTags is idempotent",
);

// ── parseTagInput ────────────────────────────────────────────────────
assert(
  parseTagInput("smoke, checkout").join("|") === "smoke|checkout",
  "splits a comma-separated list",
);
assert(parseTagInput("  ").length === 0, "blank input → no tags");
assert(parseTagInput("a,,b").join("|") === "a|b", "skips empty segments");
assert(
  parseTagInput("Smoke, smoke").join("|") === "Smoke|smoke",
  "does NOT dedupe — normalization is the backend's job, not the input parser's",
);

// ── Grouping helpers ─────────────────────────────────────────────────
const tests: TestRecord[] = [
  test("a", ["smoke", "checkout"]),
  test("b", ["Smoke"]),
  test("c"),
  test("d", []),
];

const counts = tagCounts(tests);
assert(counts.length === 2, `counts distinct tags (got ${counts.length})`);
assert(
  counts.map((c) => c.tag).join(",") === "checkout,smoke",
  `tag list is name-sorted (got ${counts.map((c) => c.tag).join(",")})`,
);
assert(
  counts.find((c) => c.tag.toLowerCase() === "smoke")?.count === 2,
  "counts 'smoke' and 'Smoke' as one tag across two tests",
);
assert(untaggedCount(tests) === 2, "counts both missing-tags and empty-tags as untagged");

assert(hasTag(tests[0], "SMOKE"), "hasTag matches case-insensitively");
assert(!hasTag(tests[2], "smoke"), "hasTag is false for an untagged test");

assert(filterByTag(tests, ALL_TAGS).length === 4, "ALL_TAGS passes everything through");
assert(
  filterByTag(tests, "smoke").map((t) => t.id).join(",") === "a,b",
  "filtering by tag matches across casings",
);
assert(
  filterByTag(tests, UNTAGGED).map((t) => t.id).join(",") === "c,d",
  "UNTAGGED selects tests with no tags",
);
assert(filterByTag(tests, "nope").length === 0, "an unused tag matches nothing");
assert(filterByTag([], ALL_TAGS).length === 0, "an empty library is handled");
assert(tagCounts([]).length === 0, "tagCounts of an empty library is empty");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll test-tags checks passed");
