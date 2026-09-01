// Types for heal-ingest.mjs.
//
// Hand-written like every shared/ module, so `npm run type-check` stays a real
// gate over the TypeScript callers (`check:heal-ingest` compiles against these).

export declare const HEAL_INGEST_MAX_TEXT: number;

/** What the envelope, not the event, supplies. */
export interface HealIngestContext {
  testId: string;
  runId: string;
}

/** A journal entry minus its `id`, which the ingesting machine mints. Shaped
 *  to satisfy `healJournalStore.record`'s parameter. */
export interface IngestedHeal {
  testId: string;
  stepId: string;
  stepIndex: number;
  stepLabel: string;
  source: "run";
  runId: string;
  originalLocator: object;
  appliedLocator: object;
  candidates: never[];
  applied: false;
  status: "pending";
  at: number;
  pageUrl?: string;
  rect?: { x: number; y: number; w: number; h: number };
  ingested: true;
}

/** A locator rebuilt value by value: a plain JSON record within bounds, or
 *  null. Whether the strategy is one this build knows is `normalizeLocator`'s
 *  question, asked on read. */
export declare function normalizeIngestedLocator(input: unknown): object | null;

/** One foreign heal event as a journal entry, or null when it cannot be
 *  trusted to mean anything. */
export declare function normalizeIngestedHeal(
  event: unknown,
  context: HealIngestContext,
): IngestedHeal | null;

/** `runId::stepId` — one heal per step per run, which is what makes ingest
 *  idempotent without collapsing a step that heals on every run. */
export declare function healIngestKey(entry: { runId: string; stepId: string }): string;

/** What to journal out of one run's heal evidence, counting the unreadable
 *  and the already-present apart. */
export declare function planHealIngest(
  existingKeys: Iterable<string>,
  incoming: unknown[],
  context: HealIngestContext,
): { fresh: IngestedHeal[]; duplicate: number; unusable: number };
