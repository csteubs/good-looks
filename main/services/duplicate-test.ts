// Duplicating a test: an exact copy of what a test IS, with none of what it
// has DONE.
//
// That split is the whole feature. A `TestRecord` mixes the two — `steps`,
// `variables` and `runBrowser` describe the test, while `a11yBaseline` records
// violations somebody accepted on a past run — and everything else a test
// accumulates (run history, screenshots, pinned visual baselines, step notes,
// the Auto-Heal journal, AI debug sessions) lives in its own store keyed by
// test id. A fresh id therefore starts empty in all of those without anything
// being deleted; only the fields ON the record have to be chosen between.
//
// So the record is REBUILT from an allowlist rather than spread. Spreading and
// overwriting the handful of fields that must change is the same shape as the
// step-ingest bug (see CLAUDE.md): it carries every field added later, so the
// next `TestRecord` field that happens to be run state would silently ride into
// every copy, and nothing would fail. `check:duplicate-test` closes the loop by
// refusing to pass while any field of `TestRecord` is absent from both lists.

import * as fs from "fs";
import * as path from "path";

import { randomUUID } from "crypto";

import { logger } from "@shell/backend";

import { importedSandboxDir, isInside } from "./import-service.js";
import { getScriptsDir, testStore } from "./test-store.js";
import type { TestRecord } from "../recorder/types.js";

/** Fields a copy inherits: everything that describes what the test does. */
export const DUPLICATED_FIELDS = [
  "url",
  "steps",
  "scriptEdited",
  "speed",
  "sourceDir",
  "sourceRoot",
  // Without it the copy's relative navigations resolve against nothing, so a
  // duplicate of a working imported test fails on its first `goto` while the
  // original passes.
  "baseUrl",
  "stepsDiverged",
  "stepsDivergedReason",
  // Rides along with the divergence it acknowledges. Dropping it would warn the
  // user again about the exact state they just signed off on, on a copy they
  // made deliberately.
  "stepsDivergedDismissed",
  "visualThreshold",
  "visualMasks",
  "visualElementSteps",
  "a11yChecks",
  "recordLogs",
  "captureArtifacts",
  "runHeadless",
  "runBrowser",
  "testTimeoutMs",
  "tags",
  // The folder the original sits in. A copy that landed at the top level would
  // be somewhere the user was not looking — the whole visible result of
  // duplicating is a new row, and putting it in a different part of the rail
  // reads as nothing having happened.
  "group",
  "variables",
  "datasets",
  "isFlow",
  "flowParams",
] as const satisfies readonly (keyof TestRecord)[];

/**
 * Fields a copy does NOT inherit, and why each one is here rather than above.
 *
 * `id`, `name`, `createdAt`, `updatedAt`, `scriptPath` — assigned fresh; a copy
 * that shared any of them would not be a separate test.
 *
 * `hidden` — the duplicate is made from the sidebar and is navigated to
 * immediately. Inheriting it would produce a new test the user cannot see, from
 * an action whose entire visible result is supposed to be that test.
 *
 * `a11yBaseline` — accessibility violations accepted against past runs of the
 * ORIGINAL. Carrying them would make the copy report a clean page it has never
 * been run against, which is the one thing the a11y feature must never do.
 */
export const DROPPED_FIELDS = [
  "id",
  "name",
  "createdAt",
  "updatedAt",
  "scriptPath",
  "hidden",
  "a11yBaseline",
] as const satisfies readonly (keyof TestRecord)[];

/** A trailing ` [n]` copy marker. Anchored, so "Sprint [2] checkout" keeps its
 *  bracketed number and only a real suffix is stripped. */
const COPY_SUFFIX_RE = /\s*\[\d+\]\s*$/;

/** Depth/size caps for the imported-sandbox copy. Generous enough for any real
 *  imported project, bounded enough that a pathological tree can't hang the
 *  main process while the user waits on a menu click. */
const MAX_SANDBOX_DEPTH = 12;
const MAX_SANDBOX_FILES = 500;
const MAX_SANDBOX_BYTES = 20 * 1024 * 1024;

/** The name with its copy marker removed, so "Login" and "Login [2]" share a
 *  base and duplicating a copy doesn't produce "Login [2] [2]". */
export function baseNameOf(name: string): string {
  return name.replace(COPY_SUFFIX_RE, "").trim();
}

/**
 * The name a duplicate of `sourceName` should take: `<base> [n]`, where n is
 * the lowest free number from 2 up. The original counts as #1, so the first
 * copy is `[2]`.
 *
 * Case-insensitive, matching how tags are grouped: `Login [2]` and `login [2]`
 * read as the same test in a sidebar sorted by date, so handing out both makes
 * two rows nobody can tell apart.
 *
 * `existingNames` must include HIDDEN tests. `testStore.list()` filters them
 * out, and a name taken by a hidden test would be handed out anyway — producing
 * a collision that is invisible until the day the hidden test comes back.
 */
export function nextDuplicateName(
  sourceName: string,
  existingNames: readonly string[],
): string {
  // A name that is nothing BUT a copy marker ("[2]") leaves an empty base, and
  // so does a blank name. Fall back rather than emitting a bare " [2]".
  const base = baseNameOf(sourceName) || sourceName.trim() || "Test";
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  // Terminates: `taken` is finite, so some n is free.
  let n = 2;
  while (taken.has(`${base} [${n}]`.toLowerCase())) n++;
  return `${base} [${n}]`;
}

/** Deep copy, so the two records never share an array or a nested object.
 *  Records are re-read from JSON on nearly every access, which makes aliasing
 *  survive only inside one call — but "only sometimes shared" is a worse
 *  property to reason about than "never". */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Build the new record's inherited half from the allowlist. Absent fields stay
 *  absent rather than becoming explicit `undefined`, so a duplicate serializes
 *  to the same shape as any other record.
 *
 *  Exported so the allowlist and the cloning can be asserted on their own. Both
 *  are invisible through `duplicateTest`: records are re-read from JSON on
 *  every access, so aliasing survives only inside one call and a test written
 *  at that level passes whether the clone happens or not. */
export function inheritedFields(src: TestRecord): Partial<TestRecord> {
  const out: Record<string, unknown> = {};
  const source = src as unknown as Record<string, unknown>;
  for (const key of DUPLICATED_FIELDS) {
    const value = source[key];
    if (value === undefined) continue;
    out[key] = clone(value);
  }
  return out as Partial<TestRecord>;
}

/**
 * Copy an imported test's sandbox directory to the new test's.
 *
 * An imported test owns `scripts/imported/<id>/`, holding its spec and every
 * sibling module the importer copied in, each at its position relative to the
 * original project root. Copying the spec alone would produce a test whose
 * `../helpers/x.ts` resolves to nothing — broken on its first run, with the
 * source checkout long gone.
 *
 * Both roots are DERIVED FROM IDS and then asserted to live inside the scripts
 * dir, which is the same two-boundary rule `copyRelativeImports` follows: one
 * bounds what may be read, the other what may be written. The asserts are kept
 * even though ids are uuids and the paths therefore cannot escape — layout
 * logic drifts, an assert doesn't.
 *
 * Only REGULAR FILES are copied. `readdirSync(withFileTypes)` reports entry
 * types from the directory itself without dereferencing, so a symlink is
 * `isSymbolicLink()` and never `isFile()` — it is skipped rather than followed.
 * The importer already refuses to copy content from outside the project it read
 * (it realpaths every sibling), so a link should not be in there at all; if one
 * ever is, this copy must not be the thing that reads through it.
 *
 * Returns how many files were copied.
 */
export function copyImportedSandbox(fromId: string, toId: string): number {
  const from = importedSandboxDir(fromId);
  const to = importedSandboxDir(toId);
  const scriptsRoot = getScriptsDir();
  if (!isInside(scriptsRoot, from) || !isInside(scriptsRoot, to)) {
    throw new Error("Refused to copy an imported sandbox outside the scripts directory.");
  }

  let files = 0;
  let bytes = 0;

  function walk(srcDir: string, destDir: string, depth: number): void {
    if (depth > MAX_SANDBOX_DEPTH || files >= MAX_SANDBOX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= MAX_SANDBOX_FILES || bytes > MAX_SANDBOX_BYTES) return;
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (!isInside(to, dest)) {
        logger.warn("duplicate", "Refused a sandbox destination outside the copy", {
          name: entry.name,
        });
        continue;
      }
      if (entry.isDirectory()) {
        walk(src, dest, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        logger.warn("duplicate", "Skipped a non-regular file while copying a sandbox", {
          name: entry.name,
        });
        continue;
      }
      try {
        const content = fs.readFileSync(src);
        bytes += content.byteLength;
        if (bytes > MAX_SANDBOX_BYTES) {
          logger.warn("duplicate", "Sandbox copy byte cap reached; stopping", { name: entry.name });
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        files++;
      } catch (err) {
        logger.warn("duplicate", "Could not copy a sandbox file", {
          name: entry.name,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  walk(from, to, 0);
  return files;
}

/**
 * Create a copy of a test: a new record, a new script file, no history.
 *
 * Secret VALUES are copied separately by the handler — they live in an
 * encrypted store this module has no business opening, and copying them is an
 * async step that must be followed by refreshing the redaction snapshot.
 */
export function duplicateTest(sourceId: string): TestRecord {
  const src = testStore.get(sourceId);
  if (!src) throw new Error("Test not found: " + sourceId);

  const id = randomUUID();
  const now = Date.now();
  const name = nextDuplicateName(src.name, testStore.allNames());

  // Read the original's spec BEFORE writing anything, so a test whose script
  // file has gone missing fails without leaving a half-made record behind.
  let source: string | null = null;
  try {
    source = fs.readFileSync(src.scriptPath, "utf-8");
  } catch (err) {
    // A generated test can be rebuilt from its steps, so a missing file is
    // recoverable. A hand-edited or imported one cannot: its spec IS the test,
    // and a copy regenerated from (lossy) parsed steps would be a different
    // test wearing the same name.
    if (src.scriptEdited || src.sourceDir) {
      throw new Error(
        "Couldn't read this test's script file, so it can't be duplicated: " + src.scriptPath,
      );
    }
    logger.warn("duplicate", "Source script unreadable; regenerating from steps", {
      id: sourceId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const inherited = inheritedFields(src);
  const rec: TestRecord = {
    ...inherited,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    // Floors for the fields TestRecord requires. The allowlist is still the
    // source of truth — these only stop a missing entry from being a type error
    // instead of the check failure it should be.
    url: inherited.url ?? "",
    steps: inherited.steps ?? [],
    scriptPath: "",
  };

  // An imported test's spec lives inside its sandbox, so the whole directory
  // comes across and the copy's spec keeps its position within it. Records
  // imported before the sandbox existed are flat in the scripts dir; there is
  // no directory to copy and their siblings are already beside the new file.
  const oldSandbox = importedSandboxDir(sourceId);
  const sandboxed = Boolean(src.sourceDir) && isInside(oldSandbox, src.scriptPath);
  if (sandboxed) {
    const copied = copyImportedSandbox(sourceId, id);
    const dest = path.join(importedSandboxDir(id), path.relative(oldSandbox, src.scriptPath));
    if (!isInside(importedSandboxDir(id), dest)) {
      throw new Error("Refused to place a duplicated spec outside its sandbox.");
    }
    // The walk copies every regular file, the spec among them — but it stops at
    // the caps, so write the spec explicitly rather than assuming it was
    // reached. A sandbox missing its own spec is not a copy of anything.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source ?? "", "utf-8");
    rec.scriptPath = dest;
    logger.info("duplicate", "Copied an imported test's sandbox", { from: sourceId, id, copied });
  } else {
    rec.scriptPath = testStore.writeScript(id, source ?? "");
  }

  // Save before regenerating: `writeScript` resolves the destination through
  // the STORED record, so a regeneration ahead of the save would write to the
  // default path and leave an imported copy's spec away from its siblings.
  testStore.save(rec);

  // Same rule as `tests:rename`, and for the same reason. A generated spec
  // embeds the test's name in `test("…")`, so regenerating is what makes the
  // copy's script describe the copy. A hand-edited or imported script is the
  // source of truth and is copied verbatim — it keeps the ORIGINAL title
  // inside `test(…)`, which is exactly what renaming such a test already does.
  if (!rec.scriptEdited && !rec.sourceDir) {
    rec.scriptPath = testStore.regenerateScript(rec);
    testStore.save(rec);
  }

  logger.info("duplicate", "Duplicated test", {
    from: sourceId,
    id,
    name,
    steps: rec.steps.length,
  });
  return rec;
}
