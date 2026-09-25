// The failure-reason vocabulary: what a failed run can be LABELLED with, and
// the rule for suggesting a label from triage evidence.
//
// Pure (see the admission rule in run-pacing.mjs). Shared because three
// consumers need the same vocabulary and none of them can import the others:
// the app assigns reasons (automatically at run end, manually from the run
// panel), the Stats board groups by them, and the MCP server resolves them for
// display. A reason id is what gets STORED on a run record; the name is
// resolved at display time, which is what lets a rename update every
// historical run without touching run-history.json.
//
// AUTOMATIC ASSIGNMENT IS DETERMINISTIC, NOT AN LLM. The one model for this
// feature elsewhere (mabl's failure reasons) categorizes with an agent that
// reads each failed run — an unattended AI call per failure. This app has
// exactly one unattended LLM egress (the insights report) and its whole design
// is that the payload cannot contain a log or a script; a failure categorizer
// needs precisely that evidence, so an LLM version of this is off the table by
// the app's own rules. What the app does have is `shared/triage.mjs`: a
// deterministic classifier whose evidence signals already name the failure
// modes the default reasons describe. `suggestFailureReason` is the mapping
// from its strongest signal to a reason id — local, explainable, and free.
// Custom reasons are therefore MANUAL-ONLY: a deterministic mapper cannot
// read a prose definition, and inventing matches for it would be guessing.

/**
 * The built-in reasons. Fixed ids, so they can be stored on run records and
 * mapped from triage signals; not renamable or deletable, so the mapping can
 * never dangle.
 *
 * Adapted from mabl's default set, minus the two that cannot happen here:
 * "Accessibility issue" (accessibility findings are reported, never fatal —
 * a run cannot fail an a11y check, see a11y-diff.ts) and "Performance issue"
 * (there are no performance tests; "Timing issue" is the budget-exhaustion
 * case this app actually has).
 */
export const DEFAULT_FAILURE_REASONS = [
  {
    id: "regression",
    name: "Site regression",
    description:
      "The site under test broke — an element disappeared, the page's own code threw, or an endpoint started failing.",
  },
  {
    id: "environment",
    name: "Environment issue",
    description:
      "Something about the environment the run executed in — an engine-specific failure, or instrumentation overhead.",
  },
  {
    id: "network",
    name: "Network issue",
    description: "The runner could not reach the site at all.",
  },
  {
    id: "test-implementation",
    name: "Test implementation issue",
    description:
      "The test itself is wrong — a stale or ambiguous locator, or steps recorded in the wrong order.",
  },
  {
    id: "timing",
    name: "Timing issue",
    description: "The page was slower than the test's budget — a timeout, not an error.",
  },
  {
    id: "not-actionable",
    name: "Target not actionable",
    description:
      "The element was there but could not be acted on — covered, hidden, disabled, or still moving. If the overlay is by design, the click step's kebab offers Ignore Actionability (force).",
  },
  {
    id: "other",
    name: "Other issue",
    description: "Anything the reasons above don't cover.",
  },
];

/** Field limits for CUSTOM reasons, enforced by the store and repeated in the
 *  Settings editor. Here rather than in the store so the two cannot drift. */
export const MAX_REASON_NAME = 100;
export const MAX_REASON_DESCRIPTION = 200;
export const MAX_ACTIVE_CUSTOM_REASONS = 50;

/**
 * The definition a stored reason id refers to, or null.
 *
 * Built-ins win over custom entries with a colliding id (the store never mints
 * one, but this file cannot know that). A DISABLED or DELETED custom reason
 * still resolves: both hide a reason from the picker and stop new
 * assignments, and the runs already labelled with it must keep their name —
 * which is why the store deletes to a tombstone rather than erasing.
 */
export function resolveFailureReason(id, custom = []) {
  if (!id) return null;
  const builtin = DEFAULT_FAILURE_REASONS.find((r) => r.id === id);
  if (builtin) return builtin;
  const own = custom.find((r) => r && r.id === id);
  return own ? { id: own.id, name: own.name, description: own.description ?? "" } : null;
}

/**
 * Connect-level failures — the run never got an answer from the site.
 *
 * Checked against the run's first error line BEFORE any triage signal, because
 * a failed connection prevents every other kind of evidence from existing:
 * triage on such a run sees no artifacts and answers "unknown", which is
 * correct about site-vs-runner and useless as a label. Deliberately
 * connect-level only (refused, DNS, unreachable, socket timeout, TLS) — a 4xx
 * or 5xx got an answer, and those are the site's problem, not the network's.
 */
const NETWORK_FAILURE =
  /net::ERR_(CONNECTION|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK|TUNNEL|PROXY|TIMED_OUT|EMPTY_RESPONSE|SSL|CERT)|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/;

/** Playwright's actionability wording — the element was found and still could
 *  not be acted on. Deliberately NOT "element is not visible" alone: that
 *  phrase also appears in plain resolve failures, and mislabelling a vanished
 *  element as "not actionable" would send the user to the force toggle when
 *  the element is simply gone. */
const ACTIONABILITY_FAILURE =
  /intercepts pointer events|element is outside of the viewport|element is not stable|element is not enabled|waiting for element to be visible, enabled and stable/;

/**
 * Which built-in reason each triage signal argues for.
 *
 * Keyed off the SIGNAL rather than the verdict for the same reason
 * `suggest()` in triage.mjs is: "site" is not a label a person would write,
 * and the strongest signal usually names one. Signals absent from this table
 * (none today) suggest nothing rather than "other" — an "Other issue" label
 * assigned by a rule reads as a categorization when it means "no idea".
 */
const SIGNAL_REASON = {
  "server-error": "regression",
  "api-error": "regression",
  "page-error": "regression",
  "heal-exhausted": "regression",
  "all-engines": "regression",
  "all-datasets": "regression",
  "visual-changed": "regression",
  "heal-succeeded": "test-implementation",
  "ambiguous-locator": "test-implementation",
  "clean-wait": "test-implementation",
  "chronic-healing": "test-implementation",
  "single-dataset": "test-implementation",
  "timeout-budget": "timing",
  "single-engine": "environment",
  "capture-only": "environment",
};

/**
 * Suggest a built-in reason for one failed run, or nothing.
 *
 * `triage` is a triageRun() result (its `evidence` is already sorted
 * strongest-first) or null when metrics were unavailable; `errorLine` is the
 * run's first error line (firstErrorLine over the ANSI-stripped log on the
 * app's side, the stored error signature on the MCP's — the network patterns
 * survive signature normalization, which strips digits and paths, not words).
 *
 * Returns `{ reasonId, signal }` — the signal is stored with an automatic
 * assignment so the label carries its own evidence — or null when nothing
 * points anywhere. Null is deliberate and load-bearing: an uncategorized
 * failure invites a human answer, while a guessed one looks answered.
 */
export function suggestFailureReason(triage, errorLine = "") {
  if (NETWORK_FAILURE.test(errorLine)) {
    return { reasonId: "network", signal: "network-error" };
  }
  if (ACTIONABILITY_FAILURE.test(errorLine)) {
    return { reasonId: "not-actionable", signal: "actionability-error" };
  }
  const strongest = triage && Array.isArray(triage.evidence) ? triage.evidence[0] : null;
  if (!strongest) return null;
  const reasonId = SIGNAL_REASON[strongest.signal];
  return reasonId ? { reasonId, signal: strongest.signal } : null;
}
