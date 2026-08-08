// Types for group-select.mjs. See run-pacing.d.mts for why these are hand-written.

/** The membership half of a `TestGroup` — all `resolveGroupTests` reads. Kept
 *  structural rather than importing TestGroup so the MCP side, which has no
 *  TestRecord type, can call this with its own shape. */
export interface GroupMembership {
  testIds?: string[];
  tags?: string[];
}

/** The test half. Anything with an id and tags resolves. */
export interface TaggedTest {
  id: string;
  tags?: string[];
}

/** The tests a group currently contains, deduped, in the order `tests` came in. */
export function resolveGroupTests<T extends TaggedTest>(
  group: GroupMembership | null | undefined,
  tests: T[],
): T[];

/** How many tests a group currently resolves to. */
export function countGroupTests(
  group: GroupMembership | null | undefined,
  tests: TaggedTest[],
): number;
