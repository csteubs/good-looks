// Persistence for recorded tests. Metadata lives in a single JSON file under
// userData; generated Playwright specs live alongside in a scripts/ folder.

import * as fs from "fs";
import * as path from "path";

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
    }
    writeAll(all.filter((t) => t.id !== id));
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
