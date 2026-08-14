// The library rail's folders — REDESIGN §7.2.
//
// A flat list of tests becomes a list of ROWS: folder rows, each with the tests
// under it, then the tests in no folder. Pure, and separate from the rail,
// because every property worth pinning here is silent when wrong — a test in
// two places, a count that does not match what is drawn, a folder that outlives
// its last member — and none of them throws.
//
// THE NAME IS THE IDENTITY. There is no groups store: a group is a string on
// each test (`TestRecord.group`), so this file is the only place that decides
// what the set of groups IS. Three consequences follow, all of them wanted:
// groups sort alphabetically for free and deterministically; a group with no
// members simply does not exist, which is the right rule for a rail folder
// since a row with nothing under it is a row you can only collapse; and there
// is nothing to garbage-collect when the last test leaves one.

import type { RunVerdict, RunVerdictTone } from "./run-verdict";
import { groupVerdictTone } from "./run-verdict";

/** The minimum a row needs from a test. Not `TestRecord`, so this stays
 *  testable from a literal and the node project can run it. */
export interface GroupableTest {
  id: string;
  group?: string;
}

export interface LibraryGroup<T extends GroupableTest> {
  kind: "group";
  /** The folder's name, which is also its identity. */
  name: string;
  /** Its members, in the order the library gave them. */
  tests: T[];
  /** Whether the user has it collapsed. Its members are still listed here —
   *  what to draw is the rail's decision, and a caller that has to ask this
   *  file twice is one that can get the two answers out of step. */
  collapsed: boolean;
  /** One dot for the whole folder, or null when no member has ever run. */
  tone: RunVerdictTone | null;
}

export interface LibraryLoose<T extends GroupableTest> {
  kind: "test";
  test: T;
}

export type LibraryRow<T extends GroupableTest> = LibraryGroup<T> | LibraryLoose<T>;

/**
 * Arrange the library into folder rows followed by loose tests.
 *
 * **Folders first, then the ungrouped tests in the order they arrived.** The
 * rail is newest-first, so this does push a just-recorded test below the
 * folders — the same complaint the Batch view's `applyOrder` answers the other
 * way. It is the right trade here for two reasons: a folder collapses, so the
 * rows above a new test are a handful of one-line headers rather than the
 * library; and a new recording is UNGROUPED, so it is at the top of the only
 * section it could be in. Interleaving folders with loose tests by date would
 * make a folder's position depend on when its members were recorded, which is
 * a rail that reorders itself for reasons nobody can see.
 *
 * `collapsed` is a set of names rather than ids because names ARE the ids here.
 * A name in it that no test carries is inert — see `collapsedTestGroups`.
 */
export function libraryRows<T extends GroupableTest>(
  tests: readonly T[],
  collapsed: readonly string[] = [],
  verdicts: ReadonlyMap<string, RunVerdict> = new Map(),
): LibraryRow<T>[] {
  const hidden = new Set(collapsed);
  const byGroup = new Map<string, T[]>();
  const loose: T[] = [];
  for (const test of tests) {
    // Trimmed here as well as on write. The store normalises what it is given,
    // but a record written before this field existed — or edited by hand — is
    // the same untrusted input every other read treats it as, and a name of
    // spaces would draw a folder with no visible title.
    const name = (test.group ?? "").trim();
    if (name === "") {
      loose.push(test);
      continue;
    }
    const members = byGroup.get(name) ?? [];
    members.push(test);
    byGroup.set(name, members);
  }

  const groups: LibraryRow<T>[] = [...byGroup.entries()]
    // Case-insensitive, so `checkout` and `Checkout` — which ARE two folders,
    // see `normalizeGroup` — at least sit next to each other rather than in
    // two different halves of the list.
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: "base" }))
    .map(([name, members]) => ({
      kind: "group" as const,
      name,
      tests: members,
      collapsed: hidden.has(name),
      // Only members that HAVE a verdict are counted; see `groupVerdictTone`.
      tone: groupVerdictTone(
        members.map((t) => verdicts.get(t.id)).filter((v): v is RunVerdict => v !== undefined),
      ),
    }));

  return [...groups, ...loose.map((test) => ({ kind: "test" as const, test }))];
}

/** Every folder name in the library, alphabetical — what the "move to…" menu
 *  offers. Derived from the tests rather than stored, for the reason the rows
 *  are: there is no group that exists apart from its members. */
export function groupNames(tests: readonly GroupableTest[]): string[] {
  const seen = new Set<string>();
  for (const test of tests) {
    const name = (test.group ?? "").trim();
    if (name !== "") seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Toggle a folder's collapsed state, returning the whole next list.
 *
 *  Returns the full set because that is what the settings write takes — a
 *  partial update could not express expanding one, which is the half that
 *  matters: a folder you cannot reopen is a folder that ate your tests. */
export function toggleCollapsed(collapsed: readonly string[], name: string): string[] {
  return collapsed.includes(name)
    ? collapsed.filter((n) => n !== name)
    : [...collapsed, name];
}
