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
//   • DISABLE, NEVER DELETE. Disabling hides a reason from the picker and
//     stops new assignments (manual and automatic alike), while every run
//     already labelled with it keeps resolving. A delete would strand those
//     runs with a bare uuid where their label was.

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
 *  twice. Uniqueness is case-insensitive because the picker reader is. */
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
  return all.filter((r) => !r.disabled).length;
}

export const failureReasonStore = {
  /** Every custom reason, disabled ones included — display resolution needs
   *  them all. Creation order, which is also the picker's order. */
  list(): CustomFailureReason[] {
    return readAll();
  },

  /** Create an enabled custom reason. Throws with a user-readable message on
   *  invalid input — the handler is the trust boundary and forwards these. */
  create(name: unknown, description?: unknown): CustomFailureReason {
    const all = readAll();
    if (activeCount(all) >= MAX_ACTIVE_CUSTOM_REASONS) {
      throw new Error(
        `The library is limited to ${MAX_ACTIVE_CUSTOM_REASONS} active custom reasons. Disable one first.`,
      );
    }
    const now = Date.now();
    const rec: CustomFailureReason = {
      id: randomUUID(),
      name: validName(name, all),
      description: validDescription(description),
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
    if (patch.name !== undefined) {
      rec.name = validName(
        patch.name,
        all.filter((r) => r.id !== id),
      );
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
};
