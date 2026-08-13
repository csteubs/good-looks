# Routines — a design spec for Batch v2

**Status: capabilities 1 and 2 are built (2026-08-13).** This started as a design
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
to and from steps). Of the step kinds below, `test`, `group`, `wait` and `notify` are built.
**`onFailure` is honoured as of 2026-08-13**, all three policies: a step can be
set to `stopRoutine` or — inside a group — `skipGroup` from its row in the
editor, and both runners act on it. Only `branch` is still unbuilt.

**The barrier machinery landed with `wait` (2026-08-13)**, and it landed without
a second execution engine: `routineRunPlan` cuts the steps into SEGMENTS at each
barrier and labels every entry with the segment it belongs to, and the runner
drains one segment's lanes with the pool it already had, joins, pauses, and
moves on. Lanes, concurrency, write-through and the summary are untouched, and a
Routine with no `wait` steps is one segment — byte-for-byte the execution every
caller had before. `notify` landed on top of it as a barrier with no pause; `branch` is the last
one left. The MCP
`run_routine` tool named in the rename table below IS built, alongside
`list_routines` and alongside `run_batch` — see `mcp/README.md`. The rail lists
Routines and the UI says "Routines" throughout (the route, the channels, the
on-disk format and `RunRecord.batchId` are untouched, per the rename table
below). Previous batches IS scoped to the open Routine: `BatchState` carries
an optional `routineId`, and a batch without one belongs to the migrated
Routine — see `ORPHAN_BATCH_OWNER`.

**Capability 2 is built.** `Routine.schedule`,
`shared/routine-schedule.mjs`, `main/services/routine-scheduler.ts`, the
schedule chip in the editor and the launch prompt for a missed run. The timer
fires occurrences arriving while the app is open; the catch-up offers ones
missed while it was closed; `SCHEDULE_CAVEAT` is stated wherever a schedule is
set. Note the two departures recorded under *Scheduling* below: the schedule is
an ENUMERATION rather than a cron string, and `lastRunAt` lives on the Routine
as `lastScheduledRunAt`. **Capability 3 has started**: `group` and `wait` are built (2026-08-13) — the
first gives `skipGroup` something to point at, the second is the first step that
is not a run and brought the barrier machinery with it. See *Step kinds* below for what a
group is allowed to be in v1 — one level deep, and with no `parallel` flag.

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

> **As built (2026-08-13), `group` ships WITHOUT `parallel`, and one level
> deep.**
>
> The runner's concurrency is a single global lane limit, so "these four
> together, then the checkout suite one at a time" cannot be expressed by a
> number — it needs the same barrier machinery `wait` does. Shipping the flag
> without it would be a builder that draws two parallel branches and runs them
> sequentially, which is the *lying in a diagram* this document rules out two
> sections down. The flag lands with the barriers or not at all.
>
> Nesting is refused rather than flattened: a group holds test steps and never
> another group. Nothing asked for it, and it multiplies the editor, the
> flattening and the skip semantics.
>
> What a group DOES mean at run time is exactly one thing: `routineRunPlan`
> flattens it in place — a group is structure over the Routine's order, not a
> second ordering of it — and stamps each member's queue entry with the group's
> id. `skipGroup` then skips the rest of that group and nothing else.

> **`wait` as built (2026-08-13).**
>
> A BARRIER, not a sleep on one lane: everything queued before it finishes
> before the clock starts, and nothing after it begins until the clock ends.
> That is the only reading that makes a wait mean anything — "let what the last
> step triggered settle" is a statement about the whole job, and a wait running
> concurrently with the steps around it would be a no-op wearing a label.
>
> `ms` is **bounded at one hour** and clamped rather than refused. The runner
> holds the batch open across a wait, so an unbounded one is a batch that looks
> hung and can only be escaped with Stop — and Stop ENDS a wait, rather than
> taking effect when it elapses, for the same reason. Anything longer than the
> ceiling is what a schedule is for, and the app has one.
>
> A **trailing** wait is dropped by the plan: it gates nothing, and would hold
> the batch open past the end of the job. So is one whose following steps have
> all been deleted — trailing in effect rather than in position. A **leading**
> wait is kept; it delays the start, which is a thing somebody might mean.
>
> `BatchState.waitingUntil` is what stops a pause from looking like a hang:
> mid-barrier there is nothing running and nothing new to report, so a waiting
> batch is otherwise indistinguishable from one that has stopped answering.

> **`notify` as built (2026-08-13).** A barrier with no pause: it fires at a
> join for the same reason a `wait` pauses at one — "tell me when the seeding is
> done" is a claim about the steps above it, and a message racing them would
> report a thing that had not happened. When a row carries both, the message
> goes out BEFORE the pause; announcing a thing and then arriving a minute late
> is worse than saying nothing.
>
> A new one starts on the **desktop** channel, and an unrecognised stored
> channel falls back to it too. That direction is deliberate: defaulting the
> other way would turn a typo in a hand-edited file into an unintended send.
> The editor states which channel does what where the choice is made — "stays on
> this machine" / "leaves this machine" — rather than only in Settings.

### Branching: the decision that has to be made explicitly

Batch has exactly one failure policy, unwritten and unconfigurable: **a failing
test never aborts the batch.** That is right for "run my suite" and wrong for a
routine that seeds data before testing against it.

```ts
type FailurePolicy = "continue" | "stopRoutine" | "skipGroup";
```

`"continue"` must be the default, or migrating the existing Batch changes its
behaviour silently. `"stopRoutine"` is what makes a setup step meaningful.

> **As built (2026-08-13).** `stopRoutine` does exactly what pressing Stop
> does: every run in flight is killed, everything not started is skipped, and
> what finished is kept. Anything gentler would be a second meaning of "stop",
> and with lanes running concurrently there is no "rest of the queue" left to
> merely not start — entries are already open. The FIRST failure owns the stop,
> because two lanes can fail in the same tick and a later one arriving would
> rewrite whose failure stopped the job.
>
> A batch records **why** it stopped (`stoppedBy: "user" | "failure"`) and
> which step did it, and that is not bookkeeping: a scheduled routine's desktop
> notification is often the only thing seen of it, and "Batch stopped" for a
> run nobody touched reads as somebody having intervened.
>
> `skipGroup` is narrower and that is the point of having both: seed-then-test
> is a group, and the seed failing should take the tests that depend on it and
> nothing else. Only PENDING entries are skipped — one already running belongs
> to a lane that started before the failure, and killing it would make
> `skipGroup` the same thing as `stopRoutine` for anyone running more than one
> lane. A `skipGroup` step that is not IN a group continues, and that
> degradation lives at the point of failure rather than in the normaliser: a
> step's policy is a property of the step, and whether it sits in a group is
> not.
>
> The MCP's `run_routine` honours both policies with one honest difference —
> it has no handle on a spawned Playwright CLI, so it stops anything FURTHER
> from starting rather than killing what is already running. See DECISIONS
> 2026-08-13.

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
| MCP `run_batch` tool | **No** (add `run_routine` alongside) — **done 2026-08-13** | Renaming a tool breaks every external client silently — an MCP client gets "unknown tool", not a redirect |
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
3. **Should `notify` steps reuse `alert-service`?** ~~It already knows how to
   post to a webhook and how to refuse to send run logs.~~ **Answered yes
   (2026-08-13).** `channel: "webhook"` goes through `alert-service`, which
   stays the app's single egress; `channel: "desktop"` is local and goes through
   `run-notifier`. Two things fell out of doing it that way, both worth stating:
   the message is **static text and never interpolated**, because a `${...}`
   template would turn the field into a general-purpose pipe from run data to a
   third-party endpoint — the exact thing `check:alerts` exists to prevent — and
   the **MCP does not send at all**, reporting `notificationsNotSent` instead,
   because reproducing the send there would be a second egress path with weaker
   redaction (that process cannot decrypt the secret values `alert-service`
   redacts with).
4. **Does a Routine survive deleting a test it references?** The delete handler
   would need a `routineStore` entry (see the "adding a per-test store" note in
   `tests:delete`). A step pointing at a deleted test should render as a broken
   step the user can remove, not vanish — silently shrinking a saved job is the
   same class of bug as the batch silently running fewer tests than it said.
