// Persistence for test groups — named, runnable sets of tests.
//
// A group holds only its own identity and its membership RULES (explicit ids +
// tags); which tests those currently mean is resolved on read by
// shared/group-select.mjs. So nothing here has to be kept in step with the
// library: deleting a test needs no cleanup pass, and there is no state that
// can drift out of agreement with tests.json.
//
// Modelled on batch-history-store: one small JSON file, full rewrite per
// change, corrupt or absent reads as empty. A groups file that fails to parse
// must cost the user their groups, not their app.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@glaze/core/backend";

import { MAX_GROUPS, normalizeGroup, normalizeGroups } from "../recorder/types.js";

import type { TestGroup } from "../recorder/types.js";

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "groups.json");
}

function readAll(): TestGroup[] {
  try {
    return normalizeGroups(JSON.parse(fs.readFileSync(indexFile(), "utf-8")));
  } catch {
    // Absent (first run) and corrupt are the same answer on purpose: there is
    // nothing to recover from a file we can't read, and throwing here would
    // take the sidebar down with it.
    return [];
  }
}

function writeAll(groups: TestGroup[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify(groups, null, 2), "utf-8");
  } catch (err) {
    logger.warn("groups", "Failed to write groups", { err: String(err) });
  }
}

/** Ids are short and stable; a group outlives renames, so it can't be keyed by
 *  name. Same shape as the dataset-row id generator. */
function newGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export const groupStore = {
  list(): TestGroup[] {
    return readAll().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  },

  get(id: string): TestGroup | null {
    return readAll().filter((g) => g.id === id)[0] ?? null;
  },

  /** Create a group. Returns null when the input has no usable name, or when
   *  the cap is already reached — both are refusals the caller should surface,
   *  not silent no-ops. */
  create(input: { name: string; testIds?: string[]; tags?: string[] }): TestGroup | null {
    const all = readAll();
    if (all.length >= MAX_GROUPS) return null;
    const now = Date.now();
    const group = normalizeGroup({
      id: newGroupId(),
      name: input.name,
      testIds: input.testIds ?? [],
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
    });
    if (!group) return null;
    writeAll([...all, group]);
    return group;
  },

  /** Patch a group's name and/or membership. Absent fields are left alone, so a
   *  caller that only renames cannot accidentally clear the membership. */
  update(
    id: string,
    patch: { name?: string; testIds?: string[]; tags?: string[] },
  ): TestGroup | null {
    const all = readAll();
    const existing = all.filter((g) => g.id === id)[0];
    if (!existing) return null;
    const next = normalizeGroup({
      ...existing,
      name: patch.name !== undefined ? patch.name : existing.name,
      testIds: patch.testIds !== undefined ? patch.testIds : existing.testIds,
      tags: patch.tags !== undefined ? patch.tags : (existing.tags ?? []),
      updatedAt: Date.now(),
    });
    // A patch that would leave the group unusable (an empty name) is refused
    // rather than applied — the alternative is a row the user can no longer
    // identify in order to fix it.
    if (!next) return null;
    writeAll(all.map((g) => (g.id === id ? next : g)));
    return next;
  },

  /** Idempotent: removing a group that is already gone is a success, because
   *  the caller's intent ("this group should not exist") holds either way. */
  remove(id: string): { removed: number } {
    const all = readAll();
    const kept = all.filter((g) => g.id !== id);
    if (kept.length === all.length) return { removed: 0 };
    writeAll(kept);
    return { removed: 1 };
  },
};
