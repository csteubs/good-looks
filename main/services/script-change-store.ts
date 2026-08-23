// A record of every whole-script change made to a test, and how to undo it.
//
// Why this exists, and why it is not the heal journal:
//
// Auto-Heal swaps ONE locator on ONE step, and `heal-journal-store.ts` records
// that. Two other things rewrite a test's entire spec and, until this store,
// left no trace at all — AI Debug applying a corrected script (by hand, or on
// its own when "Apply AI debug fixes automatically" is on), and a manual edit
// in the Script tab. Both go through `tests:updateScript`, which overwrites the
// file and re-parses the step list wholesale, so the previous script existed
// nowhere afterwards. The auto-apply setting's own copy names the risk it was
// shipped with: "Your script can change without you reading the change first."
//
// A SEPARATE FILE, deliberately. Five consumers read heal-journal.json and key
// its entries on stepId/runId — metrics-store.ts (the `healed` column),
// shared/rollup.mjs, flake-source.ts, and mcp/server.mjs twice over. A
// script-level entry in that file would be counted by every one of them as a
// healed step, and mcp/server.mjs is plain .mjs reading the raw JSON, outside
// type-check, so a missed filter there would be silent forever. The two lists
// are merged in the renderer instead, where they are both just "things that
// changed this test".

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { app, logger } from "@shell/backend";

/** Where the change came from. `manual` is the Script tab; `ai-debug` is a
 *  corrected spec from the AI debug panel. */
/** Who wrote a change: an AI-debug answer, an inline AI action in the Script
 *  IDE (a Cmd-K rewrite, a round-trip rewrite), or the user by hand. */
export type ScriptChangeOrigin = "ai-debug" | "ai-inline" | "manual";

/** Mirrors `HealStatus`, and for the same reason: "pending" is a change nobody
 *  has looked at, and settling it is the user's decision either way. */
export type ScriptChangeStatus = "pending" | "accepted" | "reverted";

export interface ScriptChangeEntry {
  id: string;
  testId: string;
  origin: ScriptChangeOrigin;
  /** Which model produced the fix, when `origin === "ai-debug"`. Absent on a
   *  session restored from disk before the model was stamped, which is why
   *  every surface must degrade to a bare "AI Debug" rather than print
   *  "undefined". */
  model?: string;
  /** The provider, the affordance and the prompt version behind an AI
   *  origin — see `ScriptChangeJournal`. Optional on every row: entries
   *  written before 2026-08-23 carry none. */
  provider?: string;
  affordance?: ScriptChangeAffordance;
  promptVersion?: string;
  /** Did the user read this change before it landed? `false` is the case the
   *  review queue exists for: the fix was applied automatically while the job
   *  was minimized, so nobody has seen it. */
  reviewed: boolean;
  /** The script as it was — the undo. Empty when `truncated`. */
  before: string;
  /** The script as it was written. Empty when `truncated`. */
  after: string;
  addedLines: number;
  removedLines: number;
  /** The sources were too large to keep, so this entry is a record with no
   *  undo behind it. Every surface must disable Revert on it rather than
   *  offering a button that writes an empty file. */
  truncated?: boolean;
  status: ScriptChangeStatus;
  at: number;
}

/** Cap per test. Lower than the heal journal's 200 because each entry carries
 *  two copies of a file rather than two locators. */
const MAX_ENTRIES_PER_TEST = 50;

/** Refuse to store either side beyond this. A spec is a few KB; this is a
 *  backstop against something pathological landing in the index, not a policy. */
export const MAX_SOURCE_BYTES = 256 * 1024;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "script-changes.json");
}

function readAll(): ScriptChangeEntry[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScriptChangeEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(entries: ScriptChangeEntry[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(entries, null, 2), "utf-8");
}

/** Added/removed line counts, computed once at record time.
 *
 *  Deliberately a plain multiset difference rather than the LCS diff the UI
 *  renders: this runs in the main process on every save, the numbers are a
 *  summary ("+12 −7"), and an exact LCS here would be a second implementation
 *  of `renderer/lib/line-diff.ts` that could disagree with the diff shown when
 *  the row is expanded. Same-content-different-position lines count as
 *  unchanged, which is what a reader of "+12 −7" expects. */
export function countLineChanges(
  before: string,
  after: string,
): { addedLines: number; removedLines: number } {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  let addedLines = 0;
  for (const line of after.split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else addedLines++;
  }
  let removedLines = 0;
  for (const n of counts.values()) removedLines += n;
  return { addedLines, removedLines };
}

/** What a caller says about where a script change came from, before it has been
 *  checked. The renderer sends this over IPC. */
export interface ScriptChangeJournal {
  origin: ScriptChangeOrigin;
  model?: string;
  /** The provider the model ran on, once the origin is an AI. */
  provider?: string;
  /** Which AI affordance wrote it — a debug answer, an inline rewrite, the
   *  round-trip rewrite. Closed vocabulary; see `AFFORDANCES`. */
  affordance?: ScriptChangeAffordance;
  /** The prompt's version tag, so a regression can be traced to a prompt
   *  change rather than only to a model change. */
  promptVersion?: string;
  reviewed: boolean;
}

export const AFFORDANCES = ["debug", "inline-rewrite", "roundtrip-rewrite"] as const;
export type ScriptChangeAffordance = (typeof AFFORDANCES)[number];

/** Longest model name kept. Real ids are well under this; the cap is here so a
 *  label can't become a paragraph in a chip. */
const MAX_MODEL_CHARS = 80;

/**
 * Turn an unchecked `origin` payload into a journal instruction.
 *
 * REBUILT, NOT FILTERED — the same rule as `normalizeRawStep` in
 * main/recorder/types.ts, and for the same reason: spreading the input and
 * overwriting known keys carries every unknown key through, so the next field
 * wired into an entry would silently become a hole again. Nothing here reaches
 * generated code, but `model` IS rendered as a label and stored on disk, so it
 * is coerced to a string, stripped of control characters (a newline in a chip
 * is a broken row; an escape sequence in a log is worse) and capped.
 *
 * An absent or unrecognised payload means "a manual edit the user made and
 * therefore saw", which is what every caller predating this feature was doing.
 */
export function normalizeScriptChangeOrigin(input: unknown): ScriptChangeJournal {
  const raw = (input ?? {}) as Record<string, unknown>;
  const origin: ScriptChangeOrigin =
    raw.by === "ai-debug" ? "ai-debug" : raw.by === "ai-inline" ? "ai-inline" : "manual";
  const ai = origin !== "manual";
  // Every free string an AI origin carries gets the same treatment: control
  // characters stripped (this IS the strip — matching them is the point),
  // trimmed, capped. They are rendered as chip labels and written to disk.
  const short = (v: unknown): string =>
    typeof v === "string"
      ? // eslint-disable-next-line no-control-regex
        v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_MODEL_CHARS)
      : "";
  const model = ai ? short(raw.model) : "";
  const provider = ai ? short(raw.provider) : "";
  const promptVersion = ai ? short(raw.promptVersion) : "";
  const affordance =
    ai && (AFFORDANCES as readonly string[]).includes(String(raw.affordance))
      ? (raw.affordance as ScriptChangeAffordance)
      : undefined;
  return {
    origin,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(affordance ? { affordance } : {}),
    ...(promptVersion ? { promptVersion } : {}),
    // Only an explicit `false` means "nobody looked at this". Anything else —
    // absent, garbage, a string — is treated as reviewed, so a malformed
    // payload cannot silently fill the review queue.
    reviewed: raw.reviewed !== false,
  };
}

export interface RecordScriptChange extends ScriptChangeJournal {
  testId: string;
  before: string;
  after: string;
  /** Overridable for tests; defaults to now. */
  at?: number;
}

export const scriptChangeStore = {
  /** Every change across every test, newest first — the cross-test Heals view. */
  listAll(): ScriptChangeEntry[] {
    return readAll().sort((a, b) => b.at - a.at);
  },

  /** Every change for one test, newest first. */
  list(testId: string): ScriptChangeEntry[] {
    return readAll()
      .filter((e) => e.testId === testId)
      .sort((a, b) => b.at - a.at);
  },

  /** Changes still awaiting a decision — what the Heals tab badges. */
  pending(testId: string): ScriptChangeEntry[] {
    return this.list(testId).filter((e) => e.status === "pending");
  },

  get(id: string): ScriptChangeEntry | null {
    return readAll().find((e) => e.id === id) ?? null;
  },

  /** Record a change. Returns the stored entry, or null when there was nothing
   *  to record.
   *
   *  A no-op is not a change: the Script tab's Save fires whether or not the
   *  text moved, and an entry saying nothing happened is noise in a list whose
   *  whole job is to make real changes stand out.
   *
   *  `reviewed` decides the starting status, which is the split the whole
   *  feature turns on: a change the user watched land is already settled
   *  history, and one that landed while they weren't looking is a review item. */
  record(input: RecordScriptChange): ScriptChangeEntry | null {
    if (input.before === input.after) return null;

    const oversized =
      Buffer.byteLength(input.before, "utf-8") > MAX_SOURCE_BYTES ||
      Buffer.byteLength(input.after, "utf-8") > MAX_SOURCE_BYTES;

    const stored: ScriptChangeEntry = {
      id: randomUUID(),
      testId: input.testId,
      origin: input.origin,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.affordance ? { affordance: input.affordance } : {}),
      ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}),
      reviewed: input.reviewed,
      before: oversized ? "" : input.before,
      after: oversized ? "" : input.after,
      ...countLineChanges(input.before, input.after),
      ...(oversized ? { truncated: true } : {}),
      status: input.reviewed ? "accepted" : "pending",
      at: input.at ?? Date.now(),
    };

    const all = readAll();
    all.push(stored);
    // Prune this test's oldest SETTLED entries first, exactly as the heal
    // journal does: dropping a pending one would remove the user's only way
    // back from a change already made to their test.
    const forTest = all.filter((e) => e.testId === stored.testId);
    if (forTest.length > MAX_ENTRIES_PER_TEST) {
      const excess = forTest.length - MAX_ENTRIES_PER_TEST;
      const droppable = forTest
        .filter((e) => e.status !== "pending")
        .sort((a, b) => a.at - b.at)
        .slice(0, excess);
      const dropIds = new Set(droppable.map((e) => e.id));
      writeAll(all.filter((e) => !dropIds.has(e.id)));
    } else {
      writeAll(all);
    }
    logger.info("script-change", "Recorded a script change", {
      testId: stored.testId,
      origin: stored.origin,
      model: stored.model,
      reviewed: stored.reviewed,
      truncated: stored.truncated === true,
    });
    return stored;
  },

  /** Mark an entry settled. Returns the updated entry, or null if it's gone. */
  setStatus(id: string, status: ScriptChangeStatus): ScriptChangeEntry | null {
    const all = readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], status };
    writeAll(all);
    return all[idx];
  },

  /** Drop every entry for a deleted test. */
  deleteTest(testId: string): void {
    const all = readAll();
    const kept = all.filter((e) => e.testId !== testId);
    if (kept.length !== all.length) writeAll(kept);
  },

  /** Forget settled entries for one test, keeping anything still pending. */
  clearSettled(testId: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((e) => e.testId !== testId || e.status === "pending");
    const removed = all.length - kept.length;
    if (removed > 0) writeAll(kept);
    return { removed };
  },

  /** The cross-test sibling of `clearSettled`, for the Heals view. */
  clearAllSettled(): { removed: number } {
    const all = readAll();
    const kept = all.filter((e) => e.status === "pending");
    const removed = all.length - kept.length;
    if (removed > 0) writeAll(kept);
    return { removed };
  },

  /** Delete one entry outright, pending or not — an explicit delete is the user
   *  saying they don't want the record. The UI is what has to say first that
   *  this is also the last copy of the previous script. */
  remove(id: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((e) => e.id !== id);
    const removed = all.length - kept.length;
    if (removed > 0) writeAll(kept);
    return { removed };
  },
};
