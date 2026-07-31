// Persistence for recorded tests. Metadata lives in a single JSON file under
// userData; generated Playwright specs live alongside in a scripts/ folder.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import type { TestRecord } from "../recorder/types.js";

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
    const all = readAll();
    const idx = all.findIndex((t) => t.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    writeAll(all);
    logger.info("recorder", "Saved test record", { id: record.id, steps: record.steps.length });
  },

  writeScript(id: string, source: string): string {
    ensureDirs();
    const p = scriptPathFor(id);
    fs.writeFileSync(p, source, "utf-8");
    return p;
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
