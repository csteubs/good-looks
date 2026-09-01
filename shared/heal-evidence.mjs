// WHAT A HEAL MAY REMEMBER ABOUT THE PAGE IT HAPPENED ON — the page URL and
// the element's box, narrowed.
//
// Both were written for `main/recorder/types.ts` (PR 1 of the preemptive-updates
// plan) and both were pure from the start. They are HERE now because a second
// process needs the identical rules: `good-looks ingest` carries heals back
// from a CI runner, and the URL narrowing is a PRIVACY rule — a token-bearing
// checkout URL must not land in a store that outlives the run, whichever
// machine the heal happened on. A copy in the CLI would be right the day it was
// written and silently divergent afterwards, which is the failure this
// directory exists to prevent.
//
// `main/recorder/types.ts` re-exports both, so every existing caller is
// unchanged and there is still one spelling.

import { ELIDED, SENSITIVE_QUERY_PARAMS } from "./log-capture-source.mjs";

/** True when the string holds a C0 control character or DEL. Written as a
 *  scan rather than a regex literal so the character class cannot be mangled
 *  by whatever edits this file next; the rule is the same one the network log
 *  and every other boundary here applies. */
function hasControlChars(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

/** Longest page URL a heal record may carry. Over-long is REJECTED, never
 *  truncated — the run-provenance rule: a cut URL is a plausible URL for
 *  somewhere else, while absent is honestly unknown. */
export const MAX_HEAL_PAGE_URL = 2048;

/**
 * Narrow a heal event's page URL — page-controlled text the fixture read via
 * `page.url()` — into something a journal may store.
 *
 * http(s) only (a `javascript:` or `data:` address is not a page a heal
 * happened on), no control characters, capped length, and sensitive query
 * VALUES elided by name through the same denylist the network log applies
 * (`SENSITIVE_QUERY_PARAMS`). Null on any doubt; the caller drops the field,
 * never the entry.
 *
 * The control-character test runs BEFORE `new URL()` on purpose: the URL
 * parser strips tabs and newlines rather than refusing them, so a check after
 * it would pass a string that had smuggled them in.
 */
export function normalizeHealPageUrl(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_HEAL_PAGE_URL) {
    return null;
  }
  if (hasControlChars(input)) return null;
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.includes(name.toLowerCase())) {
      url.searchParams.set(name, ELIDED);
    }
  }
  return url.toString();
}

/**
 * Narrow a heal event's element box. Four finite numbers on the normalized
 * 0-1 viewport scale, REBUILT from named keys — width and height must be
 * positive, because a zero-area highlight is a claim with nothing behind it.
 * Anything else is null: a doubtful rect drops the box rather than drawing a
 * wrong one.
 */
export function normalizeHealRect(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const x = fin(input.x);
  const y = fin(input.y);
  const w = fin(input.w);
  const h = fin(input.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  if (w <= 0 || w > 1 || h <= 0 || h > 1) return null;
  return { x, y, w, h };
}
