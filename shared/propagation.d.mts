// Types for propagation.mjs — hand-written, like every shared/ module, so
// `npm run type-check` stays a real gate over the TypeScript callers.
//
// Locators and fingerprints are carried OPAQUELY: this module only ever hands
// a locator to `healKeyFor` and back, so the inputs are declared as the
// structural subsets the computation actually reads (the flake-analysis.d.mts
// pattern) and the app's `Locator` / `ElementFingerprint` satisfy them.

/** The app's Locator model, passed through untouched. */
export type LocatorLike = object;

/** What the similarity check reads off an ElementFingerprint. A real
 *  fingerprint is a superset. */
export interface FingerprintLike {
  candidates?: LocatorLike[];
  attributes?: Record<string, string>;
  text?: string;
  neighborText?: string;
  rect?: { x: number; y: number; w: number; h: number };
}

/** What the engine reads from a step. `Step` is a superset. */
export interface StepLike {
  id: string;
  type?: string;
  disabled?: boolean;
  locator?: LocatorLike & { frame?: unknown[] };
  fingerprint?: FingerprintLike;
}

/** What the engine reads from a test record. `TestRecord` is a superset. */
export interface TestLike {
  id: string;
  url?: string;
  baseUrl?: string;
  sourceDir?: string;
  scriptEdited?: boolean;
  stepsDiverged?: boolean;
  steps?: StepLike[];
}

/** What the engine reads from a heal-journal entry. `HealEntry` is a superset. */
export interface JournalEntryLike {
  id?: string;
  testId: string;
  stepId: string;
  source?: string;
  runId?: string;
  originalLocator?: LocatorLike;
  appliedLocator?: LocatorLike;
  applied?: boolean;
  status?: string;
  pageUrl?: string;
  /** true when the heal was carried back from another machine by
   *  `good-looks ingest`. The engine deliberately does NOT read it: a CI
   *  heal earns donorhood the same way a local one does, through its run's
   *  outcome. Declared so the shape is honest about what reaches here. */
  ingested?: boolean;
  at: number;
}

/** What the donor gate reads from a run record. `RunRecord` is a superset. */
export interface RunOutcomeLike {
  status?: string;
  passedOnRetry?: boolean;
}

export type DonorKind = "heal-accepted" | "heal-run-passed" | "heal-trainer" | "manual-edit";

export interface Donor {
  kind: DonorKind;
  testId: string;
  stepId: string;
  healEntryId?: string;
  runId?: string;
  fromKey: string;
  fromLocator: LocatorLike;
  toKey: string;
  toLocator: LocatorLike;
  pageUrl?: string;
  at: number;
}

/** A donor's identity as carried on a proposal — enough to render "healed in
 *  ‹test›" and to join back to the journal, nothing more. */
export interface ProposalDonorRef {
  kind: DonorKind;
  testId: string;
  stepId: string;
  healEntryId?: string;
  runId?: string;
  at: number;
}

export interface Proposal {
  testId: string;
  stepId: string;
  origin: string;
  donorPageUrl?: string;
  /** The TARGET step's own locator — the undo and the staleness check. */
  fromLocator: LocatorLike;
  toLocator: LocatorLike;
  donors: ProposalDonorRef[];
  confidence: number;
  /** Codes from REASON_CODES; the renderer owns the copy. */
  reasons: string[];
  /** How the target was matched. `exact`: its own locator IS the identity the
   *  donor fixed. `near-miss`: keyed differently but pinned on the same
   *  identifier, corroborated as the same element — suggest-only, never
   *  auto-applied. */
  match: "exact" | "near-miss";
  autoApplyEligible: boolean;
}

/** What dedupe reads from an already-stored proposal entry. */
export interface ExistingProposalLike {
  id: string;
  testId: string;
  stepId: string;
  status: string;
  fromLocator?: LocatorLike;
  toLocator?: LocatorLike;
  confidence?: number;
  reasons?: string[];
  donors?: unknown[];
  /** True once the apply-mode writeback landed the fix in the step; the stale
   *  rule then expects the step to carry `toLocator`, not `fromLocator`. */
  applied?: boolean;
}

export interface ProposalRefresh {
  id: string;
  confidence: number;
  reasons: string[];
  donors: ProposalDonorRef[];
  autoApplyEligible: boolean;
}

export interface ProposalsResult {
  create: Proposal[];
  refresh: ProposalRefresh[];
  supersede: { id: string; next: Proposal }[];
  /** ids of pending entries whose target test/step/locator moved away. */
  stale: string[];
  /** Donor groups that disagreed on the fix — refused, surfaced for logging. */
  conflicts: { origin: string; fromKey: string; toKeys: string[] }[];
}

export declare const PROPAGATION_WINDOW_MS: number;
export declare const PROPOSE_MIN: number;
export declare const AUTO_APPLY_MIN: number;
export declare const MAX_SEEDS_PER_KEY: number;
export declare const PROPOSE_ONLY_TYPES: readonly string[];
export declare const REASON_CODES: readonly string[];
export declare const PROPAGATION_STATUSES: readonly string[];

export declare function donorsFromJournal(input: {
  entries: JournalEntryLike[];
  runsById?: Record<string, RunOutcomeLike>;
  now: number;
}): Donor[];

export declare function donorFromEdit(input: {
  testId: string;
  stepId: string;
  before?: LocatorLike;
  after?: LocatorLike;
  at: number;
}): Donor | null;

export declare function fingerprintsSimilar(
  a: FingerprintLike | undefined,
  b: FingerprintLike | undefined,
): boolean;

/** Whether a target's locator is keyed differently from the donor's old one
 *  but pinned on the same identifier — the near-miss rule. Answers "does this
 *  locator DEPEND on what changed", never "is this the same element", which
 *  the fingerprint answers separately. */
export declare function nearMissLocator(
  donorFromLocator: LocatorLike | undefined,
  targetLocator: LocatorLike | undefined,
): boolean;

export declare function proposalsFor(input: {
  donors: Donor[];
  tests: TestLike[];
  latestRunByTest?: Record<string, RunOutcomeLike>;
  existing?: ExistingProposalLike[];
}): ProposalsResult;

export declare function seedsForTest(input: {
  test: TestLike;
  proposals: ExistingProposalLike[];
}): Record<string, LocatorLike[]>;
