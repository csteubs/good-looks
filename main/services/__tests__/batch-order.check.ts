// Standalone regression check for the Batch view's user-defined run order.
//
// The order is persisted as test ids, so it drifts from the library constantly
// (tests added, deleted, hidden). Two invariants the UI depends on:
//   • every test appears exactly once regardless of the stored order — a test
//     that fell out of the list would be unrunnable AND invisible;
//   • a drag inside a TAG-FILTERED view still moves the test correctly in the
//     global order, since the visible rows are only a subsequence of it.
//
// The move itself carries the classic reorder off-by-one: after splicing the
// dragged item out, every index below it shifts up by one, so dragging DOWNWARD
// lands one short unless the target is recomputed post-removal.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:batch-order

import {
  applyOrder,
  moveToTarget,
  orderIdsOf,
  orderIsStale,
} from "../../../renderer/lib/batch-order.js";
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

function t(id: string): TestRecord {
  return {
    id,
    name: `Test ${id}`,
    url: "https://example.com",
    createdAt: 1,
    updatedAt: 1,
    steps: [],
    scriptPath: `/tmp/${id}.spec.ts`,
  } as TestRecord;
}

const ids = (list: TestRecord[]) => list.map((x) => x.id).join(",");
const lib = [t("a"), t("b"), t("c"), t("d")];

// ── applyOrder ───────────────────────────────────────────────────────
assert(ids(applyOrder(lib, [])) === "a,b,c,d", "no stored order → library order");
assert(ids(applyOrder(lib, ["d", "c", "b", "a"])) === "d,c,b,a", "a full stored order is honored");
assert(
  ids(applyOrder(lib, ["c"])) === "c,a,b,d",
  "a partial order puts listed tests first, the rest in library order",
);
// New tests must land at the END, not wherever their id sorts — otherwise
// adding a test silently reshuffles a curated suite.
assert(
  ids(applyOrder([...lib, t("e")], ["d", "c", "b", "a"])) === "d,c,b,a,e",
  "a newly added test lands at the end",
);
// Deleted tests leave no gap and no ghost.
assert(
  ids(applyOrder([t("a"), t("c")], ["d", "c", "b", "a"])) === "c,a",
  "ids for deleted tests are ignored",
);
assert(
  ids(applyOrder(lib, ["b", "b", "a"])) === "b,a,c,d",
  "a duplicated id in a corrupt stored order is not duplicated in the result",
);
assert(applyOrder([], ["a", "b"]).length === 0, "an empty library yields nothing");
// The invariant that matters most: nothing is ever lost.
for (const order of [[], ["c"], ["d", "a"], ["zzz"], ["b", "b"]]) {
  const out = applyOrder(lib, order);
  assert(
    out.length === lib.length && new Set(out.map((x) => x.id)).size === lib.length,
    `every test appears exactly once (order=${JSON.stringify(order)})`,
  );
}

// ── moveToTarget ─────────────────────────────────────────────────────
const base = ["a", "b", "c", "d"];
assert(moveToTarget(base, "a", "a").join(",") === "a,b,c,d", "dropping onto itself is a no-op");
assert(moveToTarget(base, "d", "b").join(",") === "a,d,b,c", "dragging UP lands on the target");
// The off-by-one: after removing "a", "c" sits at index 1; inserting there
// would land BEFORE it. Dragging down must land ON the target.
assert(moveToTarget(base, "a", "c").join(",") === "b,c,a,d", "dragging DOWN lands on the target");
assert(moveToTarget(base, "a", "d").join(",") === "b,c,d,a", "dragging to the end works");
assert(moveToTarget(base, "d", "a").join(",") === "d,a,b,c", "dragging to the start works");
assert(
  moveToTarget(base, "x", "a").join(",") === "a,b,c,d",
  "an unknown drag id leaves the order untouched",
);
assert(
  moveToTarget(base, "a", "x").join(",") === "a,b,c,d",
  "an unknown target leaves the order untouched",
);
// Length is preserved no matter what.
for (const [from, to] of [["a", "d"], ["d", "a"], ["b", "c"], ["c", "b"]]) {
  assert(moveToTarget(base, from, to).length === base.length, `move ${from}→${to} preserves length`);
}

// ── Filtered drags (the reason this takes ids, not indices) ──────────
// Visible rows are a subsequence of the global order. Dropping "d" onto "b"
// must move it next to "b" globally, even though the rows between them are
// hidden by the tag filter.
{
  const global = ["a", "b", "c", "d", "e"];
  const afterDrag = moveToTarget(global, "d", "b");
  assert(afterDrag.join(",") === "a,d,b,c,e", "a filtered drag moves correctly in the global order");
  // And the hidden entries keep their relative order.
  assert(
    afterDrag.filter((x) => x === "a" || x === "c" || x === "e").join(",") === "a,c,e",
    "hidden tests keep their relative order after a filtered drag",
  );
}

// ── orderIdsOf / orderIsStale ────────────────────────────────────────
assert(orderIdsOf(lib).join(",") === "a,b,c,d", "orderIdsOf lists ids in order");
assert(!orderIsStale(["a", "b", "c", "d"], lib), "a matching order is not stale");
assert(orderIsStale(["a", "b", "c"], lib), "a missing test makes the order stale");
assert(orderIsStale(["a", "b", "c", "d", "e"], lib), "an extra id makes the order stale");
assert(orderIsStale(["a", "b", "c", "zzz"], lib), "a deleted id makes the order stale");
assert(!orderIsStale(["d", "c", "b", "a"], lib), "a reordered-but-complete order is NOT stale");
assert(orderIsStale([], lib), "an empty order against a non-empty library is stale");
assert(!orderIsStale([], []), "empty and empty is not stale");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll batch-order checks passed");
