// Every query cache that a finished run invalidates, in one list.
//
// WHY THIS IS ONE LIST AND NOT SIX CALL SITES. A finished run writes six
// different things to disk, and until this module existed each view invalidated
// the ones it happened to care about — from inside its own `runs:changed`
// subscription. A subscription in a ROUTE component only runs while you are
// standing on that route, so the invalidation was really "refresh this if the
// user happens to be looking", and every consumer on another screen kept
// serving whatever it had cached. Three caches were never invalidated by a run
// at all:
//
//   • ["flake"]   — nothing in the app invalidated it, ever. The Stats board's
//                   Stability tile and its drill-down both read it.
//   • ["heals"]   — only the user's own accept/revert did. Auto-Heal journals a
//                   heal DURING a run (playwright-runner.ts, source: "run"), so
//                   the Heals view — the screen whose whole job is to show new
//                   heals — showed nothing until it was remounted.
//   • ["replays"] — invalidated from inside VisualView, so the Stats board's
//                   Visual tile only ever saw it by remounting.
//
// The store comments at the `runs:changed` and `batch:done` subscriptions
// already state the rule in prose ("doing it from a ROUTE component meant it
// only happened if the user was on this screen"). This is that rule as code,
// and `check:derived-cache` is that rule as a gate.
//
// WHAT BELONGS HERE: a cache whose CONTENT is a function of run history or of
// the artifacts a run leaves behind. Nothing else. `["script-changes"]` looks
// like it belongs and does not — a script change is only ever written by an IPC
// handler on a user action, never by the runner, so the mutating view already
// owns its invalidation and adding it here would refetch it on every run for
// nothing.

import type { QueryClient } from "@tanstack/react-query";

/**
 * Every cache a finished run makes stale.
 *
 * Prefixes, not exact keys: `["metrics"]` covers `["metrics","stepHealth"]`,
 * `["metrics","slowness"]` and `["metrics","divergence"]`, and `["heals"]`
 * covers both `["heals","all"]` and the per-test `["heals", id]`. React Query
 * matches a key prefix-first, which is the whole reason these views can share
 * one cache entry across screens.
 */
export const RUN_DERIVED_KEYS: readonly (readonly string[])[] = [
  // The run list itself. Read by Stats, the sidebar's verdict dots, Home's
  // green rate and the detail view's run panel.
  ["runs"],
  // The lifetime run counts behind Stats' KPI cards. A separate key from
  // ["runs"] because it is a separate question — that list is capped, this
  // count is not — and it moves on every finished run, so it goes stale
  // exactly when the list does.
  ["run-totals"],
  // Flake verdicts, recomputed backend-side over the recent run window.
  ["flake"],
  // The heal journal. A run journals into it whenever Auto-Heal substitutes a
  // locator, so this is not only a user-mutation cache.
  ["heals"],
  // Per-run capture artifacts — the Visual view's list and the Stats board's
  // Visual tile.
  ["replays"],
  // Step health, slowness and browser divergence, all read out of the metrics
  // DB that `metricsStore.ingest` writes at run teardown.
  ["metrics"],
  // What screenshot capture cost, summarised backend-side from run history.
  ["captureOverhead"],
  // The suite-wide accessibility rollup behind the Stats a11y dashboard. Read
  // out of the replay files a run writes, so a run changes it — and it is read
  // from a route that is only mounted while you are standing on it, which is
  // the exact shape this module exists to keep out of the views.
  ["a11y-rollup"],
  // Cross-test propagation proposals. The RUNNER writes them at teardown —
  // fresh heals become donors and the sweep runs before `runs:changed` fires —
  // so this cache is a function of run history like everything above. The
  // writers a run does NOT drive (trainer heals, manual edits, accept and
  // dismiss) announce themselves on `propagations:changed`, subscribed in
  // RecorderProvider beside the other non-run channels.
  ["propagations"],
] as const;

/**
 * Mark everything a finished run changed as stale.
 *
 * Call this from a subscription that is mounted for the WHOLE SESSION —
 * `RecorderProvider` — and nowhere else. `check:derived-cache` fails the build
 * if a `runs:changed` handler outside the store invalidates anything, because
 * that is the exact shape of the bug this module exists to close.
 *
 * Also correct to call from a user action that rewrites run history wholesale
 * (Stats' Reset / Delete), which is the one non-event caller.
 */
export function invalidateRunDerived(qc: QueryClient): void {
  for (const queryKey of RUN_DERIVED_KEYS) {
    void qc.invalidateQueries({ queryKey: [...queryKey] });
  }
}
