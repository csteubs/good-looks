// Standalone regression check for the test-group store.
//
// Drives the REAL store against a throwaway userData dir (`@glaze/core/backend`
// aliased to glaze-backend-stub.ts, whose app.getPath reads GLAZE_TEST_USERDATA).
// What matters here and is easy to break:
//   - groups survive a reload — a group is the only record of a suite, and
//     losing one is losing the user's own organisation of their tests;
//   - a corrupt or absent file reads as NO groups rather than throwing, because
//     this store is read while the sidebar renders;
//   - update() patches only the fields it was given, so renaming a group can't
//     silently empty it;
//   - a patch that would make a group unusable is refused, not applied;
//   - remove() is idempotent.
//
// Membership RESOLUTION is not tested here — it is pure and lives in
// shared/group-select.test.mjs. This file is only about what reaches disk.
//
// No test runner exists in this project (see package.json) — plain assertions +
// a non-zero exit code on failure stand in for one. Run with:
//   npm run check:groups

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Point the stub's app.getPath at a throwaway dir BEFORE importing the store.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "glaze-groups-"));
process.env.GLAZE_TEST_USERDATA = userData;

const { groupStore } = await import("../group-store.js");

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

function groupsFile(): string {
  return path.join(userData, "recorder", "groups.json");
}

// ── An empty store ─────────────────────────────────────────────────────
assert(groupStore.list().length === 0, "a store with no file lists no groups");
assert(groupStore.get("nope") === null, "getting an unknown group answers null");

// ── Create ─────────────────────────────────────────────────────────────
const smoke = groupStore.create({ name: "Smoke", testIds: ["t1", "t2"], tags: ["fast"] });
assert(smoke !== null, "a group is created");
assert(smoke?.name === "Smoke", "the name is kept");
assert(JSON.stringify(smoke?.testIds) === JSON.stringify(["t1", "t2"]), "explicit ids are kept");
assert(JSON.stringify(smoke?.tags) === JSON.stringify(["fast"]), "tags are kept");
assert(typeof smoke?.id === "string" && smoke.id.length > 0, "the group gets an id");

const nightly = groupStore.create({ name: "Nightly" });
assert(nightly !== null, "a group with no members is still created");
assert(
  JSON.stringify(nightly?.testIds) === JSON.stringify([]) && nightly?.tags === undefined,
  "an empty group stores empty membership rather than inventing any",
);

assert(groupStore.create({ name: "   " }) === null, "a blank name is refused");

// ── Reload ─────────────────────────────────────────────────────────────
{
  // The whole point of the store: a group is the user's own organisation of
  // their tests, and it has to be there tomorrow.
  const reloaded = groupStore.list();
  assert(reloaded.length === 2, "both groups survive a reload");
  assert(
    reloaded.map((g) => g.name).join(",") === "Nightly,Smoke",
    "groups list alphabetically, so the sidebar order is stable",
  );
}

// ── Update ─────────────────────────────────────────────────────────────
{
  const renamed = groupStore.update(smoke!.id, { name: "Smoke suite" });
  assert(renamed?.name === "Smoke suite", "a group can be renamed");
  // The failure this pins: a patch that spread `{name}` over the record would
  // drop testIds and tags, silently emptying a suite on a rename.
  assert(
    JSON.stringify(renamed?.testIds) === JSON.stringify(["t1", "t2"]),
    "renaming leaves the explicit membership alone",
  );
  assert(
    JSON.stringify(renamed?.tags) === JSON.stringify(["fast"]),
    "renaming leaves the tag rule alone",
  );

  const remembered = groupStore.update(smoke!.id, { testIds: ["t3"] });
  assert(
    JSON.stringify(remembered?.testIds) === JSON.stringify(["t3"]),
    "membership can be replaced on its own",
  );
  assert(remembered?.name === "Smoke suite", "replacing membership leaves the name alone");

  const cleared = groupStore.update(smoke!.id, { tags: [] });
  assert(cleared?.tags === undefined, "a tag rule can be cleared outright");

  assert(
    groupStore.update(smoke!.id, { name: "  " }) === null,
    "a patch that would leave the group unnamed is refused",
  );
  assert(
    groupStore.get(smoke!.id)?.name === "Smoke suite",
    "and the refused patch changed nothing on disk",
  );
  assert(groupStore.update("gone", { name: "x" }) === null, "updating a missing group answers null");
}

// ── Remove ─────────────────────────────────────────────────────────────
{
  assert(groupStore.remove(nightly!.id).removed === 1, "a group is removed");
  assert(groupStore.get(nightly!.id) === null, "and is gone afterwards");
  // Idempotent: the caller's intent ("this should not exist") holds either way,
  // so a double-click must not be an error.
  assert(groupStore.remove(nightly!.id).removed === 0, "removing it again reports nothing removed");
  assert(groupStore.list().length === 1, "the other group is untouched");
}

// ── A file we cannot read ──────────────────────────────────────────────
{
  // This store is read while the sidebar renders. Throwing here would take the
  // window down over a file whose contents are, by definition, unrecoverable.
  fs.writeFileSync(groupsFile(), "{ not json at all", "utf-8");
  assert(groupStore.list().length === 0, "a corrupt file reads as no groups, not as a crash");
  assert(groupStore.get("anything") === null, "and get() answers null rather than throwing");

  // A well-formed file holding the wrong shape is the same answer.
  fs.writeFileSync(groupsFile(), '{"groups":[]}', "utf-8");
  assert(groupStore.list().length === 0, "a non-array file reads as no groups");

  // Entries that aren't usable groups are dropped, the rest survive.
  fs.writeFileSync(
    groupsFile(),
    JSON.stringify([
      { id: "ok", name: "Kept", testIds: ["t1"], createdAt: 1, updatedAt: 1 },
      { id: "", name: "No id" },
      { id: "no-name", name: "   " },
      null,
      "nonsense",
    ]),
    "utf-8",
  );
  const survivors = groupStore.list();
  assert(survivors.length === 1 && survivors[0].name === "Kept", "unusable entries are dropped");
}

// ── Writing over a corrupt file recovers ───────────────────────────────
{
  const fresh = groupStore.create({ name: "After the mess" });
  assert(fresh !== null, "a group can still be created after a corrupt read");
  assert(groupStore.list().length === 2, "and it joins what was salvageable");
}

// ── The MCP side means the same thing by "group" ───────────────────────
// Source-level, because importing mcp/server.mjs starts a stdio server (the
// same reason run-plan.mjs was split out of it). Two properties, both silent
// if they break: a group that resolved differently over MCP than in the
// sidebar would quietly run the wrong set of tests for weeks, and an empty
// group that RAN would report "passed" because nothing failed — the most
// misleading possible answer to "did my suite pass?".
{
  const server = fs.readFileSync(
    path.resolve(process.cwd(), "mcp/server.mjs"),
    "utf8",
  );
  assert(
    /import \{ resolveGroupTests \} from "\.\.\/shared\/group-select\.mjs"/.test(server),
    "MCP resolves membership with the shared resolver, not a second implementation",
  );
  assert(
    server.indexOf('"list_groups"') > 0 && server.indexOf('"run_group"') > 0,
    "MCP registers list_groups and run_group",
  );
  const runGroupAt = server.indexOf('"run_group"');
  const body = server.slice(runGroupAt, runGroupAt + 3000);
  assert(
    /selected\.length === 0/.test(body),
    "MCP's run_group refuses a group that currently resolves to no tests",
  );
  assert(
    /resolveGroupTests\(group,/.test(body),
    "MCP's run_group resolves the group against the live library",
  );
  assert(
    /group: \{ id: group\.id, name: group\.name \}/.test(body),
    "MCP stamps the batch with the group, so the run joins that group's history",
  );
}

fs.rmSync(userData, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll group-store checks passed");
