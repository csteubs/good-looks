// Persistence for recorded tests. Metadata lives in a single JSON file under
// userData; generated Playwright specs live alongside in a scripts/ folder.

import * as fs from "fs";
import * as path from "path";

import { clearSessionState } from "./session-state-store.js";

import { app, logger } from "@shell/backend";

import { generateSpec } from "./script-generator.js";
import { collectVarRefs } from "../recorder/types.js";
import type { Step, TestRecord } from "../recorder/types.js";

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function scriptsDir(): string {
  return path.join(dataDir(), "scripts");
}

function indexFile(): string {
  return path.join(dataDir(), "tests.json");
}

function ensureDirs(): void {
  fs.mkdirSync(scriptsDir(), { recursive: true });
}

export function getScriptsDir(): string {
  ensureDirs();
  return scriptsDir();
}

export function scriptPathFor(id: string): string {
  return path.join(scriptsDir(), id + ".spec.ts");
}

/** Whether a stored path still lives under the scripts dir. Guards the writes
 *  and deletes that take their path from a record rather than deriving it. */
function isInsideScripts(p: string): boolean {
  const root = path.resolve(scriptsDir());
  const resolved = path.resolve(p);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function readAll(): TestRecord[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TestRecord[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: TestRecord[]): void {
  ensureDirs();
  fs.writeFileSync(indexFile(), JSON.stringify(records, null, 2), "utf-8");
}

export const testStore = {
  /** Where a test's generated spec lives. Exposed so callers assembling a
   *  record can fill in scriptPath before the file itself is written. */
  scriptPathFor,

  list(): TestRecord[] {
    // Hidden tests are kept on disk but removed from the sidebar view.
    return readAll()
      .filter((t) => !t.hidden)
      .sort((a, b) => b.createdAt - a.createdAt);
  },

  get(id: string): TestRecord | null {
    return readAll().find((t) => t.id === id) ?? null;
  },

  /** Every test's name, HIDDEN ONES INCLUDED — for deciding what a new name may
   *  collide with. `list()` is the wrong input for that: it filters hidden
   *  tests out, so a name already taken by one would be handed out as free, and
   *  the duplicate only shows up the day that test is restored. Same reasoning
   *  as `removeTag` reading through `readAll()`. */
  allNames(): string[] {
    return readAll().map((t) => t.name);
  },

  save(record: TestRecord): void {
    // Derive each step's variable references on write, at the ONE choke point
    // every record passes through. Computing this at the call sites instead
    // would mean the trainer, the step editor, the LLM-apply path and the
    // importer each had to remember — and the one that forgot would show a
    // variable as unused, inviting the user to delete something still in use.
    record.steps = record.steps.map((step) => {
      const refs = collectVarRefs(step);
      if (refs.length === 0) {
        if (!step.varRefs) return step;
        const { varRefs: _dropped, ...rest } = step;
        return rest as Step;
      }
      return { ...step, varRefs: refs };
    });
    const all = readAll();
    const idx = all.findIndex((t) => t.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    writeAll(all);
    logger.info("recorder", "Saved test record", { id: record.id, steps: record.steps.length });
    // A flow's steps and defaults are BAKED into every caller's spec at
    // generation time, so a save that changed this record has silently
    // invalidated the spec of every test that inlines it. Regenerating them
    // here — at the one choke point every record write passes through — is
    // what makes "edit the flow, every caller changes" true on disk rather
    // than only at the next unrelated regeneration.
    this.regenerateCallers(record.id);
  },

  /** Every record whose steps call `flowId` directly. Reads through
   *  `readAll()` for the reason `removeTag` does: a hidden caller still has a
   *  spec on disk, and a stale one comes back the day it is unhidden. */
  callersOf(flowId: string): TestRecord[] {
    return readAll().filter(
      (t) =>
        t.id !== flowId &&
        t.steps.some((s) => s.type === "runFlow" && s.flowId === flowId),
    );
  },

  /**
   * Rewrite the spec of every test that inlines `flowId`, transitively — a
   * caller can itself be a flow, so its own callers are stale too. Spec FILES
   * only: the records themselves didn't change (their steps still say "run
   * this flow"), so no record write and no `updatedAt` bump.
   *
   * Skips hand-edited and imported specs, which are their own source of truth,
   * and refuses cycles the same way the generator does.
   */
  regenerateCallers(flowId: string, seen: Set<string> = new Set()): void {
    if (seen.has(flowId)) return;
    seen.add(flowId);
    for (const caller of this.callersOf(flowId)) {
      if (!caller.scriptEdited && !caller.sourceDir) {
        try {
          this.regenerateScript(caller);
        } catch (err) {
          logger.warn("recorder", "Could not regenerate a flow caller's spec", {
            flowId,
            callerId: caller.id,
            err: String(err),
          });
        }
      }
      this.regenerateCallers(caller.id, seen);
    }
  },

  /** Write a test's script, returning where it landed.
   *
   *  An imported test's spec lives inside its own sandbox directory rather than
   *  flat in the scripts dir, so "this test's script" is wherever the record
   *  already says it is. Writing to the default path instead would move the
   *  spec away from the sibling modules it imports, and editing an imported
   *  test would break it — with the record still pointing at the old file.
   *
   *  Only an existing path INSIDE the scripts dir is honoured. A record whose
   *  scriptPath somehow points elsewhere gets the default rather than a write
   *  wherever it happens to name. */
  writeScript(id: string, source: string): string {
    ensureDirs();
    const existing = this.get(id)?.scriptPath;
    const p =
      existing && isInsideScripts(existing) ? existing : scriptPathFor(id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, source, "utf-8");
    return p;
  },

  /**
   * Regenerate a record's spec from its steps and write it, returning the path.
   *
   * The single place regeneration happens. Every call site needs the same three
   * inputs — steps, variables, and a flow resolver — and one that forgets the
   * variables silently emits a spec with no `const V` header, so every `V.x`
   * reference in it becomes a ReferenceError at run time. Callers must still
   * check `scriptEdited` themselves: a hand-edited script is the source of
   * truth and regenerating it would discard the user's edit.
   */
  regenerateScript(record: TestRecord): string {
    const source = generateSpec(
      {
        name: record.name,
        url: record.url,
        steps: record.steps,
        variables: record.variables,
      },
      { resolveFlow: (flowId) => this.get(flowId) },
    );
    return this.writeScript(record.id, source);
  },

  readScript(id: string): string {
    const rec = this.get(id);
    if (!rec) throw new Error("Test not found: " + id);
    return fs.readFileSync(rec.scriptPath, "utf-8");
  },

  remove(id: string): void {
    const all = readAll();
    const rec = all.find((t) => t.id === id);
    if (rec) {
      try { fs.rmSync(rec.scriptPath, { force: true }); } catch { /* ignore */ }
      // An imported test owns a whole directory — its spec plus every sibling
      // module copied in with it. Removing only the spec would leave those
      // behind for good, since nothing else knows they were ever its.
      //
      // Derived from the id and re-checked against the scripts dir rather than
      // taken from the record: this is a recursive delete, and the one input it
      // must not trust is a stored path.
      const sandbox = path.join(scriptsDir(), "imported", id);
      if (isInsideScripts(sandbox)) {
        try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      // Staged upload fixtures are the test's too — same reasoning, same
      // containment check. (Inline rather than calling upload-store, which
      // imports this module for the scripts dir — a cycle waiting to bite.)
      const uploads = path.join(scriptsDir(), "uploads", id);
      if (isInsideScripts(uploads)) {
        try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      // A saved login session is the test's too. The store bounds the path
      // itself (hostile ids are flattened and re-checked there).
      try { clearSessionState(id); } catch { /* ignore */ }
    }
    writeAll(all.filter((t) => t.id !== id));
  },

  /** Strip a tag from every record that carries it, in ONE write. Returns how
   *  many records changed.
   *
   *  Case-insensitive, matching how tags are grouped everywhere else: the UI
   *  shows `smoke` and `Smoke` as a single chip, so deleting that chip has to
   *  take both — otherwise it reappears the moment the query refetches, with a
   *  count nobody can explain.
   *
   *  Reads through `readAll()` rather than `list()` on purpose: `list()` hides
   *  hidden tests, and a tag left on one would be invisible right up until the
   *  test was unhidden, at which point a supposedly deleted tag comes back.
   *
   *  One `writeAll` rather than N `save()` calls, so the deletion can't land on
   *  half the library. */
  removeTag(tag: string): number {
    const key = tag.trim().toLowerCase();
    if (!key) return 0;
    const all = readAll();
    const now = Date.now();
    let changed = 0;
    for (const rec of all) {
      const before = rec.tags ?? [];
      const kept = before.filter((t) => t.toLowerCase() !== key);
      if (kept.length === before.length) continue;
      rec.tags = kept;
      rec.updatedAt = now;
      changed++;
    }
    if (changed > 0) writeAll(all);
    logger.info("recorder", "Deleted tag", { tag, changed });
    return changed;
  },

  /** Rename a group across every record that carries it, in ONE write. Returns
   *  how many records changed. Passing `""` as `to` ungroups them all, which is
   *  how "delete this group" is expressed — there is no group record to delete.
   *
   *  CASE-SENSITIVE, unlike `removeTag`, and that is the same distinction the
   *  field itself draws: a tag is MATCHED, so `Smoke` and `smoke` have to be
   *  one chip or deleting it leaves a copy behind; a group is only ever
   *  DISPLAYED, so two spellings are two folders and renaming one must not
   *  silently swallow the other.
   *
   *  Reads through `readAll()` rather than `list()` for the reason `removeTag`
   *  does: a hidden test carrying the old name would keep it invisibly and
   *  bring a supposedly renamed group back the day it is unhidden.
   *
   *  One `writeAll` rather than N `save()` calls, so a rename cannot land on
   *  half the library and leave the rail showing both names. */
  renameGroup(from: string, to: string): number {
    const before = from.trim();
    if (!before) return 0;
    const after = to.trim();
    const all = readAll();
    const now = Date.now();
    let changed = 0;
    for (const rec of all) {
      if ((rec.group ?? "") !== before) continue;
      // Deleted rather than set to "", so a record that leaves a group carries
      // no key at all — the same shape a test that was never grouped has, which
      // is what keeps "ungrouped" one condition instead of two.
      if (after) rec.group = after;
      else delete rec.group;
      rec.updatedAt = now;
      changed++;
    }
    if (changed > 0) writeAll(all);
    logger.info("recorder", "Renamed test group", { from: before, to: after, changed });
    return changed;
  },

  /** Toggle a test's visibility in the sidebar without touching its files. */
  setHidden(id: string, hidden: boolean): void {
    const all = readAll();
    const idx = all.findIndex((t) => t.id === id);
    if (idx < 0) return;
    all[idx].hidden = hidden;
    all[idx].updatedAt = Date.now();
    writeAll(all);
    logger.info("recorder", "Set test hidden", { id, hidden });
  },
};
