// What `list_propagations` reports, as a pure function of the store's file.
//
// SEPARATE FROM server.mjs because server.mjs cannot be imported by a test:
// it resolves a data directory and opens a stdio transport at module scope.
// The interesting half — which entries are picked, which fields cross, and
// what the site-level aggregate says — is all here, where `propagations.test.ts`
// can drive it. `mcp/artifacts.mjs` and `mcp/metrics.mjs` are the same shape.
//
// TWO THINGS THIS IS RESPONSIBLE FOR.
//
// It is an EGRESS BOUNDARY. A propagation entry is app data on its way to
// whatever MCP client is asking — usually a model, over a wire this repo does
// not own. So the entries are REBUILT from named keys rather than spread: the
// next field added to `PropagationEntry` does not ship to an external client
// because nobody looked. (The same rule as shared/export-bundle.mjs, and for
// the same reason.)
//
// And it is READ-ONLY, structurally: this module takes an array and returns a
// value. `mcp/README.md`'s "there is no mutation surface" claim holds for
// propagation the way it holds for everything else — the app decides whether a
// proposal is applied, and a client reading this can only report on it.

/** Sites needing at least this many DISTINCT tests proposed on before the
 *  aggregate calls them out. One proposal is an event; the same fix waiting on
 *  two tests of one site is the finding — that is the shape of "the site
 *  shipped a change", and it is what a list sorted by time hides. (The
 *  `chronicSteps` rule in `list_heals`, asked about origins.) */
export const SITE_CHANGING_MIN_TESTS = 2;

/** Newest first, the order every list in this server uses. */
function byNewest(a, b) {
  return (b?.at ?? 0) - (a?.at ?? 0);
}

/**
 * One entry, rebuilt for the wire.
 *
 * `donors` is reduced to counts and kinds rather than carried whole: a donor
 * ref is a pointer into the heal journal (`healEntryId`, `runId`), and a
 * client that wants those has `list_heals`. What answers "should I trust
 * this?" is how many confirmations there were and what kind they were.
 */
function forWire(entry, nameOf) {
  const donors = Array.isArray(entry.donors) ? entry.donors : [];
  return {
    id: entry.id,
    testId: entry.testId,
    testName: nameOf(entry.testId),
    stepId: entry.stepId,
    stepLabel: entry.stepLabel ?? "",
    origin: entry.origin,
    ...(entry.donorPageUrl ? { donorPageUrl: entry.donorPageUrl } : {}),
    fromLocator: entry.fromLocator,
    toLocator: entry.toLocator,
    donorCount: donors.length,
    donorKinds: [...new Set(donors.map((d) => d?.kind).filter(Boolean))],
    donorTests: [...new Set(donors.map((d) => d?.testId).filter(Boolean))].map((id) => ({
      testId: id,
      testName: nameOf(id),
    })),
    confidence: entry.confidence,
    reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
    autoApplyEligible: entry.autoApplyEligible === true,
    applied: entry.applied === true,
    status: entry.status,
    at: entry.at,
    ...(typeof entry.decidedAt === "number" ? { decidedAt: entry.decidedAt } : {}),
  };
}

/**
 * The `list_propagations` payload.
 *
 * @param {Array<object>} entries raw `recorder/propagations.json`
 * @param {{
 *   testId?: string,
 *   status?: string,
 *   limit?: number,
 *   nameOf?: (testId: string) => string | null,
 * }} [options]
 */
export function propagationDigest(entries, options = {}) {
  const { testId, status, limit = 50, nameOf = () => null } = options;
  const all = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e === "object" && typeof e.id === "string",
  );
  const scoped = all.filter((e) => !testId || e.testId === testId);
  const matching = scoped.filter((e) => !status || e.status === status);

  // The aggregate counts PENDING only, and counts within the current scope. A
  // site whose proposals were all dismissed is not a site that is changing —
  // it is a question already answered, and reporting it as a finding is how a
  // caller learns to skim this field.
  const bySite = new Map();
  for (const entry of scoped) {
    if (entry.status !== "pending") continue;
    if (typeof entry.origin !== "string" || !entry.origin) continue;
    const site = bySite.get(entry.origin) ?? { origin: entry.origin, proposals: 0, tests: new Set() };
    site.proposals += 1;
    site.tests.add(entry.testId);
    bySite.set(entry.origin, site);
  }

  return {
    total: matching.length,
    pending: scoped.filter((e) => e.status === "pending").length,
    sitesChanging: [...bySite.values()]
      .filter((s) => s.tests.size >= SITE_CHANGING_MIN_TESTS)
      .map((s) => ({ origin: s.origin, proposals: s.proposals, tests: s.tests.size }))
      .sort((a, b) => b.proposals - a.proposals || a.origin.localeCompare(b.origin)),
    entries: matching
      .slice()
      .sort(byNewest)
      .slice(0, Math.max(1, limit))
      .map((e) => forWire(e, (id) => nameOf(id) ?? null)),
  };
}
