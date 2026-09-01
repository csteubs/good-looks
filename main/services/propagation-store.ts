// Cross-test propagation proposals, and how to undo the applied ones.
//
// A proposal is the engine saying "the fix confirmed over there applies to
// this step here". Its lifecycle is the heal journal's, with three more ways
// to settle: pending → accepted (the fix was written) / dismissed (the user
// said no) / reverted (applied, then taken back) / superseded (the engine
// replaced it with a different fix) / stale (the target moved under it).
//
// A SEPARATE FILE, for the reason script-change-store.ts is: five consumers
// read heal-journal.json and key its entries on stepId/runId — metrics-store
// (the `healed` column), shared/rollup.mjs, flake-source.ts, and
// mcp/server.mjs twice, the last being plain .mjs outside type-check. A
// propagation entry in that file would be counted by every one of them as a
// healed step. `check:propagation` pins, at the source level, that none of
// the five ever reads this file.
//
// Normalized on the way OUT as well as in: the file sits in userData where a
// user (or another process) can hand-edit it, and — the sharper reason — the
// locators inside are page-authored once removed (heal candidates), and the
// MCP/CLI runner reads this file to seed heal maps. An entry that fails
// normalization is DROPPED, not repaired (the overlay-rule-store rule): a
// half-repaired proposal is one nobody ever reviewed.

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { app, logger } from "@shell/backend";

import {
  PROPAGATION_STATUSES,
  REASON_CODES,
  type ProposalDonorRef,
} from "../../shared/propagation.mjs";
import {
  normalizeHealPageUrl,
  normalizeLocator,
  type Locator,
} from "../recorder/types.js";

export type PropagationStatus =
  | "pending"
  | "accepted"
  | "dismissed"
  | "reverted"
  | "superseded"
  | "stale";

// The vocabulary lives in shared/propagation.mjs — the MCP filters by the same
// list, and a second spelling here would be a status the app writes and the
// MCP reports nothing for. Cast because the shared module is plain .mjs and
// declares it as strings; this file owns the union type.
const STATUSES = PROPAGATION_STATUSES as readonly PropagationStatus[];

const DONOR_KINDS = ["heal-accepted", "heal-run-passed", "heal-trainer", "manual-edit"] as const;

export interface PropagationEntry {
  id: string;
  /** the TARGET test and step this proposal would change */
  testId: string;
  stepId: string;
  /** human label of the target step at proposal time — stays legible after
   *  the step is edited or deleted */
  stepLabel: string;
  /** the origin the donors and this target share */
  origin: string;
  /** the page the newest donor heal actually fired on, when recorded */
  donorPageUrl?: string;
  /** the target step's own locator at proposal time — the undo AND the
   *  staleness check (same heal key as the donor's, possibly a different
   *  spelling: an nth, a context — a revert must restore it byte-for-byte) */
  fromLocator: Locator;
  /** the proposed locator */
  toLocator: Locator;
  /** where the evidence came from — enough to render "healed in ‹test›" and
   *  join back to the journal, nothing more */
  donors: ProposalDonorRef[];
  confidence: number;
  /** codes from shared/propagation.mjs REASON_CODES; the renderer owns copy */
  reasons: string[];
  /** whether the engine judged this eligible for automatic application (the
   *  service still re-checks the mode and the live guards at apply time) */
  autoApplyEligible: boolean;
  /** whether the stored test was actually changed by this proposal */
  applied: boolean;
  status: PropagationStatus;
  at: number;
  /** when the entry settled (any status but pending) */
  decidedAt?: number;
}

/** Cap per test. The script-change number, not the heal journal's 200: each
 *  entry carries two locators and a donor list, and fifty un-reviewed
 *  proposals against one test is already a queue nobody is reading. */
const MAX_ENTRIES_PER_TEST = 50;

const MAX_LABEL = 300;

function dataDir(): string {
  return path.join(app.getPath("userData"), "recorder");
}

function indexFile(): string {
  return path.join(dataDir(), "propagations.json");
}

function normalizeDonor(input: unknown): ProposalDonorRef | null {
  if (!input || typeof input !== "object") return null;
  const d = input as Record<string, unknown>;
  if (!DONOR_KINDS.includes(d.kind as (typeof DONOR_KINDS)[number])) return null;
  if (typeof d.testId !== "string" || typeof d.stepId !== "string") return null;
  if (typeof d.at !== "number" || !Number.isFinite(d.at)) return null;
  return {
    kind: d.kind as (typeof DONOR_KINDS)[number],
    testId: d.testId,
    stepId: d.stepId,
    ...(typeof d.healEntryId === "string" ? { healEntryId: d.healEntryId } : {}),
    ...(typeof d.runId === "string" ? { runId: d.runId } : {}),
    at: d.at,
  };
}

/** REBUILT from named keys, never spread — and null on anything doubtful.
 *  The one boundary every entry crosses, in both directions. */
function normalizeEntry(input: unknown): PropagationEntry | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (typeof e.id !== "string" || !e.id) return null;
  if (typeof e.testId !== "string" || typeof e.stepId !== "string") return null;
  if (typeof e.origin !== "string" || !e.origin) return null;
  if (!STATUSES.includes(e.status as PropagationStatus)) return null;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
  const fromLocator = normalizeLocator(e.fromLocator);
  const toLocator = normalizeLocator(e.toLocator);
  if (!fromLocator || !toLocator) return null;
  const donors = Array.isArray(e.donors)
    ? e.donors.map(normalizeDonor).filter((d): d is ProposalDonorRef => d !== null)
    : [];
  const confidence =
    typeof e.confidence === "number" && Number.isFinite(e.confidence)
      ? Math.min(1, Math.max(0, e.confidence))
      : 0;
  const reasons = Array.isArray(e.reasons)
    ? e.reasons.filter((r): r is string => typeof r === "string" && REASON_CODES.includes(r))
    : [];
  const donorPageUrl = normalizeHealPageUrl(e.donorPageUrl);
  return {
    id: e.id,
    testId: e.testId,
    stepId: e.stepId,
    stepLabel: typeof e.stepLabel === "string" ? e.stepLabel.slice(0, MAX_LABEL) : "",
    origin: e.origin,
    ...(donorPageUrl ? { donorPageUrl } : {}),
    fromLocator,
    toLocator,
    donors,
    confidence,
    reasons,
    autoApplyEligible: e.autoApplyEligible === true,
    applied: e.applied === true,
    status: e.status as PropagationStatus,
    at: e.at,
    ...(typeof e.decidedAt === "number" && Number.isFinite(e.decidedAt)
      ? { decidedAt: e.decidedAt }
      : {}),
  };
}

function readAll(): PropagationEntry[] {
  try {
    const raw = fs.readFileSync(indexFile(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeEntry).filter((e): e is PropagationEntry => e !== null);
  } catch {
    return [];
  }
}

function writeAll(entries: PropagationEntry[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const clean = entries.map(normalizeEntry).filter((e): e is PropagationEntry => e !== null);
  fs.writeFileSync(indexFile(), JSON.stringify(clean, null, 2), "utf-8");
}

function pruneForTest(all: PropagationEntry[], testId: string): PropagationEntry[] {
  // Settled entries first, oldest first, never pending: a pending entry is
  // the review queue AND — when `applied` — the only undo record. The
  // heal-journal rule, unchanged.
  const forTest = all.filter((e) => e.testId === testId);
  if (forTest.length <= MAX_ENTRIES_PER_TEST) return all;
  const excess = forTest.length - MAX_ENTRIES_PER_TEST;
  const droppable = forTest
    .filter((e) => e.status !== "pending")
    .sort((a, b) => a.at - b.at)
    .slice(0, excess);
  const dropIds = new Set(droppable.map((e) => e.id));
  return all.filter((e) => !dropIds.has(e.id));
}

export const propagationStore = {
  /** Every proposal across every test, newest first — the Heals view's feed. */
  listAll(): PropagationEntry[] {
    return readAll().sort((a, b) => b.at - a.at);
  },

  list(testId: string): PropagationEntry[] {
    return readAll()
      .filter((e) => e.testId === testId)
      .sort((a, b) => b.at - a.at);
  },

  /** Still awaiting a decision — what badges count and what seeds runs. */
  pending(testId?: string): PropagationEntry[] {
    return readAll()
      .filter((e) => e.status === "pending" && (testId === undefined || e.testId === testId))
      .sort((a, b) => b.at - a.at);
  },

  get(id: string): PropagationEntry | null {
    return readAll().find((e) => e.id === id) ?? null;
  },

  /** Record a fresh proposal. Dedupe is the ENGINE's job (proposalsFor); the
   *  store only persists what it is handed — one writer, whole file. */
  record(
    entry: Omit<PropagationEntry, "id" | "at" | "status" | "applied" | "decidedAt"> &
      Partial<Pick<PropagationEntry, "at">>,
  ): PropagationEntry | null {
    const stored = normalizeEntry({
      ...entry,
      id: randomUUID(),
      at: entry.at ?? Date.now(),
      status: "pending",
      applied: false,
    });
    if (!stored) {
      logger.warn("propagation", "Refused to record a malformed proposal", {
        testId: (entry as { testId?: string }).testId,
      });
      return null;
    }
    const all = readAll();
    all.push(stored);
    writeAll(pruneForTest(all, stored.testId));
    return stored;
  },

  /** Update a pending entry's evidence in place — same fix, better backing.
   *  Anything else about it (the locators, the target) never changes here:
   *  an edited proposal is one the user never saw; that case supersedes. */
  refresh(
    id: string,
    patch: Pick<PropagationEntry, "confidence" | "reasons" | "donors" | "autoApplyEligible">,
  ): PropagationEntry | null {
    const all = readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0 || all[idx].status !== "pending") return null;
    const next = normalizeEntry({ ...all[idx], ...patch });
    if (!next) return null;
    all[idx] = next;
    writeAll(all);
    return next;
  },

  /** Stamp a pending entry as written to the test WITHOUT settling it — the
   *  auto-apply landing state ("Applied, unreviewed"). No `decidedAt`: nobody
   *  has decided anything yet, and the review counts key off `pending`. */
  markApplied(id: string): PropagationEntry | null {
    const all = readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0 || all[idx].status !== "pending") return null;
    const next = normalizeEntry({ ...all[idx], applied: true });
    if (!next) return null;
    all[idx] = next;
    writeAll(all);
    return next;
  },

  /** Settle an entry. `applied` is stamped when the accept/revert actually
   *  changed the test on disk, so revert knows whether there is an undo. */
  setStatus(
    id: string,
    status: Exclude<PropagationStatus, "pending">,
    opts: { applied?: boolean } = {},
  ): PropagationEntry | null {
    const all = readAll();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return null;
    const next = normalizeEntry({
      ...all[idx],
      status,
      decidedAt: Date.now(),
      ...(opts.applied !== undefined ? { applied: opts.applied } : {}),
    });
    if (!next) return null;
    all[idx] = next;
    writeAll(all);
    return next;
  },

  deleteTest(testId: string): void {
    const all = readAll();
    const kept = all.filter((e) => e.testId !== testId);
    if (kept.length !== all.length) writeAll(kept);
  },
};
