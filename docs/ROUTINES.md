# Routines — a design spec for Batch v2

**Status: capability 1 is built (2026-08-12).** This started as a design
document, written alongside the per-row Batch work of 2026-08-07 so that work
didn't paint the next version into a corner. Most of it is still design — where
it says "would", it means would.

What now exists: **capability 1, end to end — the entity, the migration, the
editor, and running one.**
`main/services/routine-store.ts` persists Routines to
`userData/recorder/routines.json`; `shared/routine-migration.mjs` synthesises
the "Batch" Routine described under *A Routine is an entity*, once, at startup;
`shared/routine-plan.mjs` turns a Routine into the batch runner's own payload;
`routines:*` IPC exposes list/get/save/delete/run; and the Batch view is the
open Routine's editor (`renderer/lib/routine-rows.ts` translates its checklist
to and from steps). Of the step kinds below only `kind: "test"` is built, and
`onFailure` is stored but not yet honoured — every step behaves as `continue`,
which is what Batch already does, and nothing can set anything else. The MCP
`run_routine` tool named in the rename table below is not built. The rail lists
Routines and the UI says "Routines" throughout (the route, the channels, the
on-disk format and `RunRecord.batchId` are untouched, per the rename table
below). Previous batches IS scoped to the open Routine: `BatchState` carries
an optional `routineId`, and a batch without one belongs to the migrated
Routine — see `ORPHAN_BATCH_OWNER`.

**Capability 2 is most of the way there.** `Routine.schedule`,
`shared/routine-schedule.mjs` and `main/services/routine-scheduler.ts` all
exist: the timer fires occurrences that arrive while the app is open, and
`routines:missed` reports the ones missed while it was closed for the renderer
to offer. **What is missing is the picker** — nothing can set a schedule yet, so
nothing fires in practice, and `SCHEDULE_CAVEAT` has nowhere on screen to
appear. Note the two departures recorded under *Scheduling* below: the schedule
is an ENUMERATION rather than a cron string, and `lastRunAt` lives on the
Routine as `lastScheduledRunAt`. Capability 3 (the flow builder) is untouched.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) for what exists today,
[DECISIONS.md](DECISIONS.md) for why the current Batch is shaped the way it is,
and [REDESIGN.md](REDESIGN.md) §7.1 for where a Routine would live in the
redesigned shell.

---

## What this is for

Batch today answers one question: *run these tests now*. A **Routine** would
answer a different one: *this is a job — here is what it does, here is when it
runs, and here is what happens when part of it fails.*

Three capabilities separate the two, and they are independent enough to ship
separately:

1. **A saved, named configuration.** Batch has exactly one implicit
   configuration — whatever the checklist currently looks like. "Smoke suite,
   Chromium, headless" and "Full regression, all three engines, nightly" cannot
   both exist.
2. **A schedule.** Runs without a person present.
3. **A flow** — ordering, branching, and steps that aren't tests (wait, notify,
   set a variable), in the shape of a Shopify-Flow-style builder.

The honest sequencing is 1 → 2 → 3. Each is useful alone; 3 is useless without
1, and 2 is a trap without 1 (a schedule attached to a mutable global checklist
means the nightly job silently changes when somebody unticks a row).

---

## The thing to get right first: a Routine is an entity

Today's per-row options live in `RecorderSettings.batchTestOptions`, a
`Record<testId, BatchRowOptions>`. That was the correct call for one checklist —
no migration, no new store, an absent entry is a working default — and it is
recorded as a deliberate trade-off in DECISIONS.md.

It does not extend. The map can express *one* configuration of each test, so
"Smoke runs Login on Chromium headless" and "Nightly runs Login on all three
engines headed" cannot coexist. Routines needs its own store:

```ts
interface Routine {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  steps: RoutineStep[];        // see "The flow model"
  schedule?: RoutineSchedule;  // see "Scheduling"
  /** run options that apply unless a step overrides them */
  defaults: { captureArtifacts: boolean; concurrency: number };
}
```

**Migration from today:** on first launch after Routines ships, synthesise one
Routine named "Batch" from the existing `batchTestOptions` + `batchOrder`, and
leave both keys in place unread for one release. The Batch view becomes that
Routine's editor. Users who never open Routines see no change; nobody loses a
checklist they spent time on. Delete the settings keys a release later, not in
the same one — a migration that also removes its own source has no way back if
it reads the map wrongly.

---

## The flow model

### Reuse `runFlow`, don't invent a second composition mechanism

`TestRecord` already has `isFlow` and `flowParams`, and `Step` already has
`runFlow` with `flowId` + `flowArgs` (`main/recorder/types.ts`). A flow is an
ordinary test whose steps get **inlined** into another test at generation time.

That is composition *inside one Playwright test*. A Routine is composition
*across* tests: each entry is its own process, its own `RunRecord`, its own row
in Stats. These are different layers and conflating them is the main design risk
here.

The rule to hold: **`runFlow` composes steps; a Routine composes runs.** A
Routine step that "runs a flow" runs the *test* that flow belongs to; it does not
reach inside it. If someone wants shared setup across two tests in a Routine,
`runFlow` is already the answer and Routines should not grow a second one.

### Step kinds

```ts
type RoutineStep =
  | { kind: "test"; testId: string; browsers: RunBrowser[]; headless: boolean;
      datasetIds?: string[]; onFailure: FailurePolicy }
  | { kind: "group"; label: string; steps: RoutineStep[]; parallel: boolean }
  | { kind: "wait"; ms: number }
  | { kind: "notify"; channel: "desktop" | "webhook"; message: string }
  | { kind: "branch"; on: "anyFailed" | "allPassed"; then: RoutineStep[]; else: RoutineStep[] };
```

`group` carries `parallel` rather than having a global concurrency setting,
because the useful shape is "these four smoke tests together, then the checkout
suite one at a time" — a single number can't say that.

### Branching: the decision that has to be made explicitly

Batch has exactly one failure policy, unwritten and unconfigurable: **a failing
test never aborts the batch.** That is right for "run my suite" and wrong for a
routine that seeds data before testing against it.

```ts
type FailurePolicy = "continue" | "stopRoutine" | "skipGroup";
```

`"continue"` must be the default, or migrating the existing Batch changes its
behaviour silently. `"stopRoutine"` is what makes a setup step meaningful.

**Do not add a `retry` policy in v1.** Auto-Heal already retries at the locator
level, and a routine-level retry stacked on top makes a flaky test look stable —
which is precisely the signal the Stability panel exists to give. If retry is
added later it must mark the resulting `RunRecord` so flake analysis can exclude
or count it deliberately.

### The lane invariant survives, and constrains the builder

The batch runner keys a live run by `testId` (`runId === testId`) and serialises
every entry for one test into a single lane. Routines inherits that: **two steps
naming the same test can never execute concurrently**, however the builder is
drawn. A `parallel: true` group containing the same test twice must be rejected
at save time with a message, not silently serialised — a builder that draws two
parallel branches and runs them sequentially is lying in a diagram.

---

## Scheduling

### Where a scheduler can live

This is a local macOS app that is not always running, which rules out an
in-process `setInterval`.

| Option | Fires when the app is closed | Cost |
|---|---|---|
| In-process timer | **No** | Trivial; only useful for "every 30 min while I work" |
| `launchd` agent (`~/Library/LaunchAgents`) | Yes | Writes a plist outside the app's own data; needs uninstall handling |
| Login-item + catch-up on launch | No, but *recovers* | Cheap, honest, no external state |

**Recommendation: catch-up on launch, plus an in-process timer while running.**
A `Routine.schedule` stores `{ cron: string; lastRunAt?: number }`; on launch the
app computes whether an occurrence was missed and offers to run it.

> **As built (2026-08-13), two departures from the sketch above.**
>
> The schedule is an **enumeration** — `everyHours` / `dailyAt` / `weekdaysAt` —
> not a cron string. A cron text field's failure mode is a schedule that never
> fires, and on screen that is indistinguishable from one that is not due yet:
> no error, no red, and the user finds out days later. An enumerated schedule
> cannot reach that state, because every value it holds came from a picker. The
> cost is expressiveness, which is the right thing to give up for a scheduler
> that only runs while the app is open. `everyHours` is anchored to local
> midnight rather than to the last run, so the cadence cannot drift, and its
> step must divide 24.
>
> `lastRunAt` lives on the Routine as **`lastScheduledRunAt`**, not inside the
> schedule, so editing a schedule cannot clobber the record of what it has
> already done. It records only SCHEDULED fires — a manual run does not satisfy
> a schedule, or running a job by hand at 23:00 would silently cancel its 23:30
> occurrence.
>
> See DECISIONS 2026-08-13. That is a
weaker guarantee than `launchd` and it should be *stated in the UI* — "runs when
the app is open" — rather than implied. Promising unattended nightly runs and
delivering them only when the app happens to be running is worse than not
offering the feature.

`launchd` is the real answer for unattended runs, but it means writing a plist
into the user's `LaunchAgents`, keeping it in sync with the Routine, and removing
it on delete/uninstall — a whole lifecycle, and one that leaves state behind if
it goes wrong. It is a v2 concern, gated on people actually wanting overnight
runs.

### What a scheduled run must not do

- **Never open a headed browser on a schedule.** A window stealing focus while
  someone is working is the fastest way to have the feature turned off. Force
  headless for scheduled runs regardless of the step's own setting, and say so
  in the builder.
- **Never run two occurrences of one Routine at once.** If the previous run is
  still going, skip and record that it was skipped.

---

## Migration cost of the rename

The word "Batch" is load-bearing in more places than the UI. Renaming everything
at once is a large, risky, mostly mechanical diff; the recommendation is to
**rename the concept in the UI and leave the wire format alone**.

| Surface | Rename? | Why |
|---|---|---|
| View title, routes, copy | Yes | This is the actual ask |
| `batch:*` IPC channels | **No** | Internal, invisible, and renaming them is pure churn |
| `batch-history.json`, `BatchRecord` | **No** | On-disk format; a rename needs a migration that buys nothing |
| `RunRecord.batchId` | **No** | Same, and it is the join key for every existing run |
| MCP `run_batch` tool | **No** (add `run_routine` alongside) | Renaming a tool breaks every external client silently — an MCP client gets "unknown tool", not a redirect |
| `batchOrder` / `batchTestOptions` | Read once for migration, then drop | See "A Routine is an entity" |

A rename that reaches disk formats and external tool names costs a migration and
an integration break, and buys a word. The word is worth having in the UI; it is
not worth having in `run-history.json`.

---

## Open questions

1. **Does a Routine own its tests' options, or reference the tests' own?** The
   per-row model has each Routine storing engines/headedness per step, which
   means changing a test's default browser doesn't affect existing Routines.
   That is probably right (a saved job should be stable) but it means the
   Batch-view habit of "flip the master headless toggle" no longer reaches
   saved Routines.
2. **What does Stats show for a Routine?** Today each test in a batch writes an
   ordinary `RunRecord` and `batchId` joins them. A Routine with branches and
   waits has a shape that a flat list of runs cannot represent. Either accept
   that (Stats stays run-level, Routines has its own history) or add a
   `RoutineRunRecord`. Accepting it is cheaper and probably correct.
3. **Should `notify` steps reuse `alert-service`?** It already knows how to post
   to a webhook and how to refuse to send run logs. Reusing it keeps one place
   that decides what may leave the machine — worth doing even if the shapes
   don't match perfectly.
4. **Does a Routine survive deleting a test it references?** The delete handler
   would need a `routineStore` entry (see the "adding a per-test store" note in
   `tests:delete`). A step pointing at a deleted test should render as a broken
   step the user can remove, not vanish — silently shrinking a saved job is the
   same class of bug as the batch silently running fewer tests than it said.
