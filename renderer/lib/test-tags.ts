// Grouping tests by tag, for the Batch view's filter (and anywhere else that
// needs to slice the library).
//
// Pure helpers, deliberately separate from any component so `check:test-tags`
// can exercise them without React. NOTE: these do NOT normalize — the backend
// owns that (`normalizeTags` in main/recorder/types.ts) and every tag reaching
// the renderer has already been through it. Matching is still done
// case-insensitively so a filter survives a tag being re-cased on another test.

import type { TestRecord } from "./recorder-types";

/** Sentinel for "no tag filter applied". */
export const ALL_TAGS = "__all__";

/** Sentinel for "tests that have no tags at all" — worth its own filter, since
 *  untagged tests are otherwise invisible once you start grouping. */
export const UNTAGGED = "__untagged__";

export interface TagCount {
  tag: string;
  count: number;
}

/** Every distinct tag across the given tests, with how many tests carry it.
 *  Deduped case-insensitively (first spelling wins) and sorted by name, so the
 *  filter row is stable as tests come and go. */
export function tagCounts(tests: TestRecord[]): TagCount[] {
  const byKey = new Map<string, TagCount>();
  for (const t of tests) {
    for (const tag of t.tags ?? []) {
      const key = tag.toLowerCase();
      const existing = byKey.get(key);
      if (existing) existing.count++;
      else byKey.set(key, { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }),
  );
}

/** How many tests carry no tags at all. */
export function untaggedCount(tests: TestRecord[]): number {
  return tests.filter((t) => (t.tags ?? []).length === 0).length;
}

export function hasTag(test: TestRecord, tag: string): boolean {
  const key = tag.toLowerCase();
  return (test.tags ?? []).some((t) => t.toLowerCase() === key);
}

/** Apply a tag filter. `ALL_TAGS` passes everything through; `UNTAGGED`
 *  selects only tests with no tags; anything else matches that tag. */
export function filterByTag(tests: TestRecord[], tag: string): TestRecord[] {
  if (tag === ALL_TAGS) return tests;
  if (tag === UNTAGGED) return tests.filter((t) => (t.tags ?? []).length === 0);
  return tests.filter((t) => hasTag(t, tag));
}

/** Split a user-typed tag string ("smoke, checkout") into raw tags. Splitting
 *  only — trimming, deduping, and capping are the backend's job, so the UI
 *  can't drift from what actually gets stored. */
export function parseTagInput(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
