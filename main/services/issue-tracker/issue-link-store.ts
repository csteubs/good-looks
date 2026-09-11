// Which defects already have issues.
//
// A flat JSON index beside the other stores, and keyed on
// `provider + testId + stepId + kind` — deliberately WITHOUT the run id.
//
// That is the whole design decision. A visual difference or an accessibility
// violation reappears on every run, so a link keyed by run would report "not
// yet filed" every single time and the feature would produce one duplicate
// issue per run. `stepId` is stable across runs — it is what `annotation-store`
// pins notes to and what baselines are pinned under — so a link made today is
// still found tomorrow.
//
// `kind` is part of the key because one step can carry two unrelated defects at
// once: a visual change AND an accessibility violation. Without it, filing one
// would make the other look already-reported.
//
// The a11y `ruleId` is part of the key too, since one step can violate several
// rules and each becomes its own issue.
//
// WHAT THIS DOES NOT DO: track whether the issue is still open. That needs a
// round trip per link and a decision about what to show offline, and showing a
// stale "filed as ENG-42" for something closed weeks ago is worse than showing
// nothing. Recorded as an open question rather than half-built.

import * as fs from "fs";
import * as path from "path";

import { app, logger } from "@shell/backend";

import type { DefectSource, IssueLink, ProviderId } from "../../../renderer/lib/issue-types.js";

export type { IssueLink };

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "issue-links.json");
}

/**
 * The identity of a defect — run-independent, with one deliberate exception.
 *
 * ONE derivation, used by both the writer and the reader. That is not tidiness:
 * this had two, and they disagreed for a step-less failure. The symptom was a
 * link that saved successfully and could never be found again — silent, and
 * indistinguishable from "not filed yet".
 *
 * The exception is a failure that blamed NO step. Nothing identifies it except
 * the run it happened in: two step-less failures of one test can be entirely
 * different faults, and keying them together would comment a new failure onto
 * an unrelated issue. The cost is that "already filed" only shows while looking
 * at that same run — the honest answer, since there is nothing stable to
 * recognise it by. (An error-signature key would do better; noted as future
 * work rather than guessed at here.)
 */
function keyFor(parts: {
  provider: ProviderId;
  testId: string;
  kind: DefectSource["kind"];
  stepId: string | null;
  runId: string;
  ruleId: string;
}): string {
  const step =
    parts.kind === "failure" && !parts.stepId ? `run:${parts.runId}` : (parts.stepId ?? "");
  // Joined on a VISIBLE separator. The previous one was a control character,
  // which looks like a space in every editor and diff — and a key built with
  // one that does not match is a lookup that silently never hits.
  return [parts.provider, parts.testId, parts.kind, step, parts.ruleId].join("::");
}

/** The key for a defect being filed.
 *
 *  The insight-report source has no test/run coordinate; it maps onto the SAME
 *  derivation with the report id in the step slot and the rest empty, so
 *  `keyOf` below reproduces it from a stored link with no second spelling —
 *  which is the whole lesson this file's separator carries. */
export function linkKey(provider: ProviderId, source: DefectSource): string {
  // A Site Health link is keyed on the DOMAIN and the CATEGORY — the host in
  // the step slot, the category in the rule slot, no test and no run — so a
  // score filed from any run of any test that reaches the host finds it.
  if (source.kind === "site-health") {
    return keyFor({
      provider,
      testId: "",
      kind: source.kind,
      stepId: source.host,
      runId: "",
      ruleId: source.category,
    });
  }
  if (source.kind === "insight-report") {
    return keyFor({
      provider,
      testId: "",
      kind: source.kind,
      stepId: source.reportId,
      runId: "",
      ruleId: "",
    });
  }
  return keyFor({
    provider,
    testId: source.testId,
    kind: source.kind,
    stepId: source.stepId,
    runId: source.runId,
    ruleId: source.kind === "a11y" ? source.ruleId : "",
  });
}

function readAll(): IssueLink[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile(), "utf-8"));
    return Array.isArray(parsed) ? (parsed as IssueLink[]) : [];
  } catch {
    return [];
  }
}

function writeAll(records: IssueLink[]): void {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(indexFile(), JSON.stringify(records, null, 2), "utf-8");
  } catch (err) {
    logger.warn("issues", "Failed to write the issue-link index", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The key for a link already on disk. Goes through the SAME derivation as
 *  `linkKey` — which is the point, and is why the link records its run.
 *
 *  This function previously built the key itself, with a separator that LOOKED
 *  identical to the other one and was not. Nothing rendered the difference:
 *  every save succeeded, every lookup missed, and the feature reported "not
 *  filed yet" for defects it had just filed. */
function keyOf(link: IssueLink): string {
  return keyFor({
    provider: link.provider,
    testId: link.testId,
    kind: link.kind,
    stepId: link.stepId || null,
    runId: link.runId,
    ruleId: link.ruleId,
  });
}

export const issueLinkStore = {
  /** The link for one defect, or null. */
  find(provider: ProviderId, source: DefectSource): IssueLink | null {
    const want = linkKey(provider, source);
    return readAll().find((l) => keyOf(l) === want) ?? null;
  },

  /** Every link for a test, so a view can badge a whole list in one read
   *  rather than one call per row. */
  forTest(testId: string): IssueLink[] {
    return readAll().filter((l) => l.testId === testId);
  },

  /** Every a11y link, across tests and rules, in one read. The Accessibility
   *  view's rule board badges "filed as ENG-42" on every row from this — one
   *  call, not one per rule — and files a rule ONCE, anchored at a
   *  representative occurrence, so any occurrence finds the link again. */
  allA11y(): IssueLink[] {
    return readAll().filter((l) => l.kind === "a11y");
  },

  /** Every Site Health link, in one read — the Site Health view badges its
   *  detail head from this, whichever run is on screen. */
  allSiteHealth(): IssueLink[] {
    return readAll().filter((l) => l.kind === "site-health");
  },

  /** Record a filed issue. Replaces any existing link for the same defect —
   *  filing again after the first issue was deleted in the tracker should leave
   *  one link, not two. */
  save(
    provider: ProviderId,
    source: DefectSource,
    issue: { id: string; identifier: string; url: string },
  ): IssueLink {
    const want = linkKey(provider, source);
    const report = source.kind === "insight-report";
    const site = source.kind === "site-health";
    const link: IssueLink = {
      provider,
      // The report and site-health sources store the same slots `linkKey`
      // mapped them onto — empty test/run, the report id or the host where a
      // step id goes — so `keyOf` rebuilds the identical key through the one
      // derivation.
      testId: report || site ? "" : source.testId,
      stepId: report ? source.reportId : site ? source.host : (source.stepId ?? ""),
      // Recorded so the read side can rebuild the same key. Only load-bearing
      // for a step-less failure, but stored always — a field present only
      // sometimes is one every reader has to remember to guard.
      runId: report || site ? "" : source.runId,
      kind: source.kind,
      ruleId: source.kind === "a11y" ? source.ruleId : site ? source.category : "",
      issueId: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      createdAt: Date.now(),
    };
    writeAll([...readAll().filter((l) => keyOf(l) !== want), link]);
    logger.info("issues", "Recorded an issue link", { identifier: issue.identifier });
    return link;
  },

  /** Stamp a recurrence comment. */
  touch(provider: ProviderId, source: DefectSource): void {
    const want = linkKey(provider, source);
    writeAll(
      readAll().map((l) => (keyOf(l) === want ? { ...l, lastCommentedAt: Date.now() } : l)),
    );
  },

  /** Forget a test's links. Called when the test is deleted — the issues live
   *  on in the tracker, which is correct: they are someone else's work item
   *  now, and deleting a local test should not reach into a shared workspace. */
  removeTest(testId: string): void {
    const remaining = readAll().filter((l) => l.testId !== testId);
    writeAll(remaining);
  },
};
