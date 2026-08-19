// "How was this week?" — the weekly read. REDESIGN §6.5.
//
// The RULE lives in `shared/period-digest.mjs` now, generalized over the
// window length: the AI Insights report asks the same question over a day, a
// week or a month from the MAIN process, and two spellings of "how was the
// period" is how the Stats panel and the report end up disagreeing about the
// same seven days. This wrapper fixes the period to a week and keeps the
// renderer's import surface (`weeklyDigest`, `WEEK_MS`, the types) unchanged.
//
// The design record for the digest itself — a quiet week is not a good week,
// the comparison is what makes it weekly, offenders per test — is on the
// shared module's functions and in DECISIONS 2026-08-12.

import type { RunDayCount, RunRecord } from "./recorder-types";
import { periodDigest, WEEK_MS } from "../../shared/period-digest.mjs";
import type { DigestTest, PeriodDigest } from "../../shared/period-digest.mjs";

export { WEEK_MS };
export type { DigestTest };
export type WeeklyDigest = PeriodDigest;

export function weeklyDigest(
  runs: readonly RunRecord[],
  now: number,
  prunedDays: readonly RunDayCount[] = [],
): WeeklyDigest {
  return periodDigest(runs, now, { periodMs: WEEK_MS, periodLabel: "week", prunedDays });
}
