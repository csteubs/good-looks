// Persistence for CUSTOM failure reasons — the user-defined half of the
// vocabulary in shared/failure-reasons.mjs. Kept as its own flat JSON index,
// same pattern as annotation-store.ts, because these are primary data: a
// reason id is stored on run records, and the definition here is what makes
// that id mean something on every surface that displays it.
//
// Two rules carried over from the feature this adapts (mabl's failure
// reasons), both because they protect history:
//
//   • RENAME, NEVER REWRITE. Runs store the reason's ID; changing `name` here
//     updates every historical run's label at display time, with no touch of
//     run-history.json.
//   • DISABLE, OR DELETE TO A TOMBSTONE. Disabling hides a reason from the
//     picker and stops new assignments (manual and automatic alike), while
//     every run already labelled with it keeps resolving. Deleting does the
//     same and also takes it off the Settings list — but the RECORD stays
//     here, marked `deleted`, because erasing it would strand every run it
//     labels with a bare uuid where its name was. Adding a reason under a
//     deleted one's name RESTORES that record rather than minting a second
//     id: names are unique across the whole file for the same reason they are
//     unique across disabled reasons, or the Stats breakdown would show two
//     rows with one name.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { app, logger } from "@shell/backend";

import {
  DEFAULT_FAILURE_REASONS,
  MAX_ACTIVE_CUSTOM_REASONS,
  MAX_REASON_DESCRIPTION,
  MAX_REASON_NAME,
} from "../../shared/failure-reasons.mjs";

export interface CustomFailureReason {
  id: string;
  name: string;
  description: string;
  /** Hidden from the picker and refused for new assignments; existing
   *  assignments keep resolving. Absent means enabled. */
  disabled?: boolean;
  /** Deleted from Settings: off the management list as well as the picker,
   *  and kept only so runs already labelled with it keep resolving. Always
   *  written together with `disabled: true`, so a reader that only knows
   *  `disabled` already treats it as unassignable. Absent means live. */
  deleted?: boolean;
  createdAt: number;
  updatedAt: number;
}

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "failure-reasons.json");
}

function readAll(): CustomFailureReason[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomFailureReason[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: CustomFailureReason[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(records, null, 2), "utf-8");
}

/** The validated name, or a thrown explanation. Names must be unique across
 *  the WHOLE vocabulary — built-ins included, and disabled customs included,
 *  since re-enabling one must not surface a collision the picker then shows
 *  twice. Uniqueness is case-insensitive because the picker reader is.
 *  `others` holds the LIVE records to check against; a deleted record's name
 *  is each caller's decision (create restores it, rename refuses it). */
function validName(input: unknown, others: CustomFailureReason[]): string {
  if (typeof input !== "string") throw new Error("A reason needs a name.");
  const name = input.trim();
  if (!name) throw new Error("A reason needs a name.");
  if (name.length > MAX_REASON_NAME) {
    throw new Error(`Reason names are limited to ${MAX_REASON_NAME} characters.`);
  }
  const lower = name.toLowerCase();
  if (DEFAULT_FAILURE_REASONS.some((r) => r.name.toLowerCase() === lower)) {
    throw new Error(`"${name}" is already a built-in reason.`);
  }
  if (others.some((r) => r.name.toLowerCase() === lower)) {
    throw new Error(`A reason named "${name}" already exists.`);
  }
  return name;
}

function validDescription(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") throw new Error("The description must be text.");
  const description = input.trim();
  if (description.length > MAX_REASON_DESCRIPTION) {
    throw new Error(`Descriptions are limited to ${MAX_REASON_DESCRIPTION} characters.`);
  }
  return description;
}

function activeCount(all: CustomFailureReason[]): number {
  return all.filter((r) => !r.disabled && !r.deleted).length;
}

/** The deleted record holding `name` (case-insensitively), if any. At most
 *  one can exist: create restores it and rename refuses it. */
function deletedNamed(all: CustomFailureReason[], name: string): CustomFailureReason | undefined {
  const lower = name.toLowerCase();
  return all.find((r) => r.deleted && r.name.toLowerCase() === lower);
}

function live(all: CustomFailureReason[]): CustomFailureReason[] {
  return all.filter((r) => !r.deleted);
}

export const failureReasonStore = {
  /** Every custom reason, disabled AND deleted ones included — display
   *  resolution needs them all; the picker and the Settings list filter.
   *  Creation order, which is also the picker's order. */
  list(): CustomFailureReason[] {
    return readAll();
  },

  /** Create an enabled custom reason. Throws with a user-readable message on
   *  invalid input — the handler is the trust boundary and forwards these.
   *
   *  A name matching a DELETED reason restores that record — same id, the
   *  name and description as typed now — so the runs it already labels and
   *  the runs labelled from here on share one reason. */
  create(name: unknown, description?: unknown): CustomFailureReason {
    const all = readAll();
    if (activeCount(all) >= MAX_ACTIVE_CUSTOM_REASONS) {
      throw new Error(
        `The library is limited to ${MAX_ACTIVE_CUSTOM_REASONS} active custom reasons. Disable one first.`,
      );
    }
    const validated = validName(name, live(all));
    const validatedDescription = validDescription(description);
    const now = Date.now();
    const buried = deletedNamed(all, validated);
    if (buried) {
      buried.name = validated;
      buried.description = validatedDescription;
      delete buried.deleted;
      delete buried.disabled;
      buried.updatedAt = now;
      writeAll(all);
      logger.info("failure-reasons", "Restored deleted custom failure reason", { id: buried.id });
      return buried;
    }
    const rec: CustomFailureReason = {
      id: randomUUID(),
      name: validated,
      description: validatedDescription,
      createdAt: now,
      updatedAt: now,
    };
    all.push(rec);
    writeAll(all);
    logger.info("failure-reasons", "Created custom failure reason", { id: rec.id });
    return rec;
  },

  /** Rename, re-describe, or disable/enable one custom reason. Built-in ids
   *  are simply unknown here, which is what makes them immutable. */
  update(
    id: string,
    patch: { name?: unknown; description?: unknown; disabled?: unknown },
  ): CustomFailureReason {
    const all = readAll();
    const rec = all.find((r) => r.id === id);
    if (!rec) throw new Error("No such custom reason: " + id);
    // A deleted record is history's, not the editor's: re-enabling it here
    // would leave a reason that is live and absent from Settings at once.
    // Adding its name again (create) is the way back.
    if (rec.deleted) throw new Error(`"${rec.name}" was deleted. Add it again to restore it.`);
    if (patch.name !== undefined) {
      const name = validName(
        patch.name,
        live(all).filter((r) => r.id !== id),
      );
      if (deletedNamed(all, name)) {
        throw new Error(
          `A deleted reason named "${name}" still labels past runs. Add "${name}" as a new reason to restore it, or choose another name.`,
        );
      }
      rec.name = name;
    }
    if (patch.description !== undefined) rec.description = validDescription(patch.description);
    if (patch.disabled !== undefined) {
      const disabled = patch.disabled === true;
      if (!disabled && rec.disabled && activeCount(all) >= MAX_ACTIVE_CUSTOM_REASONS) {
        throw new Error(
          `The library is limited to ${MAX_ACTIVE_CUSTOM_REASONS} active custom reasons. Disable one first.`,
        );
      }
      if (disabled) rec.disabled = true;
      else delete rec.disabled;
    }
    rec.updatedAt = Date.now();
    writeAll(all);
    logger.info("failure-reasons", "Updated custom failure reason", { id });
    return rec;
  },

  /** Delete one custom reason — to a tombstone, never out of the file (see
   *  the header). Built-in ids are unknown here, so they cannot be deleted.
   *  Deleting an already-deleted reason is a no-op, not an error: a second
   *  click on a stale list should not toast a failure for an outcome that
   *  already holds. */
  remove(id: string): CustomFailureReason {
    const all = readAll();
    const rec = all.find((r) => r.id === id);
    if (!rec) throw new Error("No such custom reason: " + id);
    if (rec.deleted) return rec;
    rec.deleted = true;
    rec.disabled = true;
    rec.updatedAt = Date.now();
    writeAll(all);
    logger.info("failure-reasons", "Deleted custom failure reason", { id });
    return rec;
  },
};
