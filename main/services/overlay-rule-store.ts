// Persistence for standing overlay dismissal rules — the "on this host, click
// this away whenever it appears" records the trainer teaches and the runner
// enforces.
//
// A flat JSON index in userData, same shape as failure-reason-store.ts and
// annotation-store.ts. Primary data, not derived: nothing can rebuild a rule
// from run artifacts, because a rule records a judgement the user made about a
// site rather than something that happened during a run.
//
// Two rules carried from failure-reason-store, both for the same reason there:
//
//   • DISABLE, NEVER DELETE from enforcement. Disabling stops a rule firing
//     while keeping the definition, so a run record that names it still
//     resolves to a label. Deleting is a separate, explicit act.
//   • ONE WRITER, WHOLE FILE. The list is small and read on every session
//     start; a partial write is how two rules end up with one id.
//
// Rules are keyed by HOST, not by test. See the note on `OverlayRule` — a
// consent modal is a property of the site, and a per-test copy is a copy that
// drifts. The consequence worth knowing is that rules are machine-local: they
// live in userData and do not travel with a test, which is why the runner
// announces which rules were armed for a run rather than applying them
// silently.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { app, logger } from "@shell/backend";

import { hostOf, MAX_RULES_PER_HOST } from "../../shared/overlay-rules.mjs";
import { normalizeOverlayRule, type Locator, type OverlayRule } from "../recorder/types.js";

function storePath(): string {
  return path.join(app.getPath("userData"), "recorder", "overlay-rules.json");
}

/** Every rule on disk, normalized. A record that fails normalization is
 *  DROPPED rather than repaired: the file is only ever written by this module,
 *  so a malformed entry means it was edited by hand or truncated by a crash,
 *  and a half-understood rule that fires on a page is worse than no rule. */
export function listRules(): OverlayRule[] {
  try {
    const raw = fs.readFileSync(storePath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: OverlayRule[] = [];
    for (const entry of parsed) {
      const rule = normalizeOverlayRule(entry);
      if (rule) out.push(rule);
    }
    return out;
  } catch (e) {
    // ENOENT is the ordinary "no rules yet" case and is not worth a log line.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn("overlay-rules", `could not read rules: ${String(e)}`);
    }
    return [];
  }
}

function writeAll(rules: readonly OverlayRule[]): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** Add a rule for a host, from a URL and a picked locator.
 *
 *  Returns null when the host is unusable or the target does not normalize —
 *  the caller reports that rather than storing a rule that can never fire.
 *  The per-host cap is enforced HERE, not only in the watcher: a store that
 *  accepts what enforcement will silently ignore is a store that lies. */
export function createRule(input: {
  url: string;
  label: string;
  target: Locator;
}): OverlayRule | null {
  const host = hostOf(input.url);
  if (!host) return null;
  const now = Date.now();
  const rule = normalizeOverlayRule({
    id: randomUUID(),
    host,
    label: input.label,
    target: input.target,
    createdAt: now,
    updatedAt: now,
  });
  if (!rule) return null;
  const all = listRules();
  if (all.filter((r) => r.host === host).length >= MAX_RULES_PER_HOST) return null;
  all.push(rule);
  writeAll(all);
  return rule;
}

/** Rename or enable/disable a rule. The TARGET is deliberately not editable
 *  here: a locator comes from the picker, where it was priced against a real
 *  page, and letting it be retyped is how a rule acquires a selector nobody
 *  ever saw match. Re-teach instead. */
export function updateRule(
  id: string,
  patch: { label?: string; disabled?: boolean },
): OverlayRule | null {
  const all = listRules();
  const index = all.findIndex((r) => r.id === id);
  if (index < 0) return null;
  const merged = normalizeOverlayRule({
    ...all[index],
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    disabled: patch.disabled === true,
    updatedAt: Date.now(),
  });
  if (!merged) return null;
  all[index] = merged;
  writeAll(all);
  return merged;
}

/** Remove a rule outright. Unlike a failure reason, a rule leaves nothing
 *  behind that needs it to resolve — a run record names the rules it fired by
 *  label, captured at the time, so deleting one cannot strand history. */
export function removeRule(id: string): boolean {
  const all = listRules();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}
