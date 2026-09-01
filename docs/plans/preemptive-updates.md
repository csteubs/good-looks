# Preemptive updates: propagating locator fixes across tests that share a site

Written 2026-09-01, against `main` at `d9b0c4d`.

Goal: when a site change breaks a locator, the suite should need the fix
**once**. Today every test that touches the shared page fails — or heals —
alone: a heal is journalled per test, an accepted fix stays in the test it was
accepted on, and the person who fixed one login button fixes it five more
times under five different test names. The feature mines the evidence the app
already keeps (heal journal, pass/fail history, element fingerprints, run
artifacts) to **propose the same fix for every sibling test on the same
origin, before those tests fail** — automatically, out of the way, and always
rejectable.

The idea is already named and deferred in this repo:
[script-ide-view.md](script-ide-view.md) line 151 plans a "used in 7 tests"
index that "decides whether a heal should propagate" and tiers it *later*, and
`heal-journal-store.ts:86-88` justifies `listAll()` with "a locator that keeps
needing to be healed is often the same element in several tests". This plan
builds that, as its own reviewable pipeline rather than a side effect.

---

## 0. Constraints taken as given

Decided with the maintainer before writing (AskUserQuestion, 2026-09-01), so
later readers don't relitigate them:

| Decision | Chosen |
|---|---|
| Apply policy | **Suggest + protect runs.** Proposals queue for review; every run is protected immediately by seeding the known-good locator into its Auto-Heal map. Stored tests change on accept — or automatically only for users already on `autoHealApply: "apply"`, high-confidence only, journalled and revertable |
| Review home | **The Heals view.** Counts/badges on Home, Stats' Auto-Heal category and per-test tabs; a link from the Routines outcome panel. No new rail entry |
| Donors | **Confirmed heals + manual locator fixes.** Exact selector identity (`healKeyFor`) on the same origin. No fuzzy matching in v1 |
| Engine | **Deterministic only.** No LLM, no new egress. Screenshots are shown to the user as evidence, never sent anywhere |

---

## 1. What was measured, not assumed

### 1.1 A single heal already has a full review lifecycle — for one test

- `HealEntry` (`main/services/heal-journal-store.ts:29-54`) stores
  `originalLocator` (the undo), `appliedLocator`, ranked `candidates`,
  `applied` (did disk change) and `status: "pending" | "accepted" | "reverted"`.
  Cap 200/test (`:58`); pruning drops **settled entries first, never pending** —
  "the entry is the undo record, not just a log line" (`:120-131`).
- `heals:accept` (`main/handlers/index.ts:1053-1068`) is the canonical write
  shape: find step by `stepId`, replace `locator`, bump `updatedAt`,
  `if (!rec.scriptEdited) regenerateScript`, `save`, mark accepted. It accepts
  an operator-chosen alternative locator ("Use this"). `heals:revert`
  (`:1071-1087`) restores `originalLocator` only when `applied`.
- The unattended write is gated twice: `persist = mode === "apply" && runPassed`
  (`main/services/playwright-runner.ts:863`), with the rationale spelled out at
  `:794-802` — **a mis-heal usually succeeds at the step**, so step success is
  exactly the wrong signal; only the run's overall outcome or the user counts.
- One setting governs both engines: `autoHealApply` (`main/recorder/types.ts:2967-2975`),
  default `"suggest"`.

### 1.2 The cross-test identity already exists

- `healKeyFor` (`shared/heal-key.mjs:183-195`) is the canonical spelling of a
  locator's identity — context chain included, `nth` deliberately absent
  (`:178-181`) — already shared by the generator, the fixture and both heal-map
  writers. Two steps in two tests targeting the same element produce the same
  key. Nothing computes it **across** tests today.
- The UI-side precedent is `findLocatorUsages`
  (`renderer/lib/find-usages.ts:24-36`): every step in the library pointing at
  an element, keyed on the generator's spelling (`locatorExpr`). Right idea,
  wrong key for this feature — `locatorExpr` is `nth`- and frame-sensitive, so
  an indexed step would not match the unindexed sibling a heal was recorded
  against. Propagation joins on `healKeyFor`, the same key the heal itself used.
- `ElementFingerprint` (`main/recorder/types.ts:665-687`) is the corroboration
  data: `candidates` ("EVERY locator strategy that applied at record time…
  a candidate matching any of these is strong evidence" — the field's own
  docstring), curated `attributes`, `text`, `neighborText`, and a
  viewport-normalized `rect`. A heal preserves it on purpose — "a heal points
  the SAME intended element at a new locator"
  (`main/services/recorder-service.ts:3621-3631`).
- Origin primitives exist but are authoring-time only:
  `originOf` / `isOnOrigin` (`main/services/origin-variable.ts:60-76`), and the
  per-host precedent is already accepted practice — overlay rules are armed by
  host from the test's start URL (`mcp/run-tests.mjs:639-651`).

### 1.3 What is missing, honestly

- **No URL is captured at heal time. Anywhere.** The fixture's healed event
  (`shared/heal-fixture-source.mjs:454-464`) carries step identity, locators
  and candidates — no URL, origin, or rect. The nearest join is
  `HealEntry.runId → RunRecord.url`, which is the test's **start** URL;
  mid-test navigation is invisible. (`page` is in scope at the write site, so
  capturing `page.url()` is cheap.)
- **No cross-test surface exists.** The only cross-test reads are
  `healJournalStore.listAll()`, the Heals view, and MCP `list_heals`'
  `chronicSteps` counter. All read-only.
- **MCP/CLI heals never reach the journal** — writeback is off by construction
  (`mcp/run-tests.mjs:630-636`, `:699-704`): the container's `tests.json` dies
  with it. So the donor corpus is app + trainer runs; CI runs *consume*
  protection (§2.5) but do not yet contribute evidence (§4).
- **Three run fields are silently dropped.** `playwright-runner.ts:2001`
  passes `hasTrace` and `:2011` spreads `retryFields` (`attempt`,
  `passedOnRetry`) into `runHistoryStore.append` — but the parameter type
  (`main/services/run-history-store.ts:380-435`) declares none of them and the
  record literal (`:450-521`) names every persisted field explicitly, so app
  runs never store them. Spreads defeat excess-property checking, so it
  compiles clean. Consequences: the Open Trace button gates on a field that is
  never true, and `flakeSignal` (`shared/run-attempts.mjs:108-110`) — which
  this feature's confidence scoring reads — never sees a retried pass from an
  app run. Fixed in PR 1 because the engine consumes exactly this signal.

### 1.4 The precedents this design copies deliberately

- **A separate store, not the heal journal.**
  `main/services/script-change-store.ts:14-21`: five consumers key
  `heal-journal.json` on `stepId`/`runId` — `metrics-store.ts` (the `healed`
  column), `shared/rollup.mjs`, `flake-source.ts`, and `mcp/server.mjs` twice,
  the last being plain `.mjs` outside type-check where "a missed filter would
  be silent forever". A propagation entry in that file would be counted as a
  healed step by every one of them. Same argument, same answer: own file,
  merged in the renderer.
- **The review-queue state.** `ScriptChangeEntry.reviewed`
  (`script-change-store.ts:54-57`) — "`false` is the case the review queue
  exists for" — and the Heals view's amber **Applied** chip ("the stored test
  has ALREADY changed and nobody has looked at it",
  `renderer/main/heals-view.tsx:59-86`) are exactly the vocabulary for
  auto-applied propagations.
- **The third-kind seam is already cut.** `JournalEntry`
  (`heals-view.tsx:41-48`) is discriminated on `kind` "so every branch in this
  file is a compile error the day a third kind lands, instead of a row that
  silently renders as the wrong thing".
- **Refresh rules.** `RUN_DERIVED_KEYS`
  (`renderer/lib/run-derived-cache.ts:44-71`) with the admission rule at
  `:26-31`; `check:derived-cache` enforces both halves.
- **The signal-masking doctrine.** ROUTINES.md:285-296 refused a retry policy
  because "a retry stacked on Auto-Heal makes a flaky test look stable — which
  is precisely the signal the Stability panel exists to give". The
  generalisable rule: a mechanism that makes a broken thing look fixed must
  not sit upstream of the signal that would have reported it. §2.5 is designed
  against exactly that.

---

## 2. Design

### 2.1 Vocabulary and lifecycle

- A **donor** is one confirmed locator fix: `fromLocator → toLocator` on a
  step of one test, with its evidence.
- A **proposal** is that fix mapped onto one step of one *other* test on the
  same origin: the stored `fromLocator` (undo + staleness check), the
  `toLocator`, the donors behind it, a confidence, and reason codes.
- A **seed** is a pending proposal's `toLocator` handed to a run's heal map so
  the run can use it the moment the old locator actually fails.

Lifecycle: donor event → proposals computed → (always) seeds protect runs →
(suggest) user accepts/dismisses, or (apply-mode, high confidence) auto-applied
as reviewable → settled. Statuses:
`pending | accepted | dismissed | reverted | superseded | stale`.

### 2.2 Donors

| Source | Evidence gate | Strength |
|---|---|---|
| Run heal, journal `source: "run"` | the run **passed** (join `runId → RunRecord.status`), or the entry was later `accepted` | accepted > passed |
| Trainer heal, `source: "trainer"` | happened live under the user's eyes | medium |
| User accepts any heal (`heals:accept`), incl. "Use this" alternates | explicit human decision | strongest |
| **Manual locator fix** | `tests:updateSteps` / `recorder:updateStep` change a step's locator (same `stepId`, different `locatorKey`) | strongest |

The manual-edit hook lives in the two handlers, not in the propagation apply
path — so propagation's own writes can never become donors (no feedback loop).
The Script-tab re-parse path is **not** a donor source: `spec-parser` mints
fresh step ids on every parse, so a per-step before/after diff does not exist
there (§4).

### 2.3 Targets and matching

For a donor on test A, candidate targets are steps in every other test where:

- `healKeyFor(step.locator) === healKeyFor(donor.fromLocator)` — the heal
  engine's own identity, `nth`-insensitive so indexed siblings match;
- `originOf(target.url ?? target.baseUrl) === originOf(donorTest.url)` — and
  once PR 1 lands, the donor side prefers the heal's real `pageUrl` origin
  over the start-URL approximation;
- the step is enabled, the locator is unframed (`locator.frame` — the heal
  key ignores frames, and applying an unframed fix inside a frame targets the
  wrong document), and the test is not `sourceDir` (imported — the same
  exclusion the heal gate applies), not `scriptEdited`, and not
  `stepsDiverged` (its steps are not the spec that runs).

`step.toLocator` (a drag's destination, the model's only second locator) is
excluded in v1: heal evidence only ever concerns `locator`, so no donor can
exist for it (§4).

### 2.4 Confidence — deterministic, reason-coded

Every proposal carries machine-readable reason codes; the renderer maps codes
to fixed copy (the `insights-view.tsx` rule: fixed verbs, the engine
contributes only facts). Contributions:

- **Donor strength** (§2.2), and **agreement** — N independent donors mapping
  the same key to the same `toLocator` on this origin. Donors that *disagree*
  on `toLocator` for one key+origin produce **no proposal at all**: a
  conflicted fix is not a fix.
- **Fingerprint corroboration**, donor step vs target step: the strong form is
  `healKeyFor(toLocator)` appearing among the target's own
  `fingerprint.candidates` keys — the target's recorder saw this exact
  identity on this element at record time. The weak form is
  attributes/text/`neighborText`/`rect` similarity (both rects are already
  viewport-normalized 0-1).
- **Target already failing**: latest `RunRecord` failed, or a retained
  `heal-failures.json` names this key (`outcome: "exhausted" | "no-candidates"`)
  — raises priority and adds the "already failing on this element" reason.
  `flakeSignal` is read through `shared/run-attempts.mjs` so a
  passed-on-retry run counts as the warning it is (which is why PR 1 fixes
  the dropped fields).
- **Recency**: donors older than the propagation window (default 30 days)
  don't create new proposals.

Two thresholds, both exported constants: `PROPOSE_MIN` gates writing a pending
entry at all; `AUTO_APPLY_MIN` additionally requires the strong fingerprint
corroboration **or** ≥2 agreeing donors. Exact weights are an implementation
detail with unit rows per contribution; the shape (codes + two thresholds) is
the contract.

### 2.5 Seeding — protect runs without touching tests

`buildHealMap(steps, { describeStep, seedsByKey })`
(`shared/heal-map.mjs:46-67`) gains an optional third input: for each key, up
to 3 seed locators from that test's **pending** proposals. The map entry
carries `seeds: Locator[]`; the heal fixture
(`shared/heal-fixture-source.mjs:411-482`) tries seeds **first** on a resolve
failure — after `recordMatches` (evidence before healing, the existing rule),
before spending a probe — and a working seed records a normal
`outcome: "healed"` event flagged `seeded: true`, then falls through to the
probe path unchanged if no seed works.

Wiring, both map writers:
- App: `playwright-runner.ts` reads the propagation store in-process at the
  existing map-build site.
- MCP/CLI: `mcp/run-tests.mjs:707` passes seeds read from `propagations.json`
  (read-only, the same posture as everything else in that process; writeback
  stays off by construction). The `check:ci-fixtures` anchor literal
  `fs.writeFileSync(env.GLAZE_HEAL_MAP, JSON.stringify(buildHealMap(` is a
  prefix and survives a second argument; the check gains a row asserting the
  seeds actually ride the map when the store has them.

Why this satisfies ROUTINES.md's doctrine rather than violating it: a seed
never fires until the old locator **actually fails on a run**, and when it
fires it goes through the existing heal event → journal → metrics pipeline —
so the Stability panel, the heals count and the run log all still report that
the page changed. Breakage is converted into *recorded* heals, never hidden.
And because seeded heals are ordinary journal entries, the existing outcome
gate (`persist = mode === "apply" && runPassed`) governs whether they write
back, unchanged.

### 2.6 The store

`main/services/propagation-store.ts` → `userData/recorder/propagations.json`.

```
{ id, testId, stepId, stepLabel,            // target
  origin, donorPageUrl?,                    // grouping + evidence
  fromLocator, toLocator,                   // undo/staleness + the fix
  donors: [{ testId, stepId, kind, healEntryId?, runId?, at }],
  confidence, reasons: string[],            // codes, not copy
  applied: boolean,                         // did tests.json change
  status, at, decidedAt? }
```

Rules, each copied from the store that learned it:
- Own file, never `heal-journal.json` (§1.4, the five-consumers argument).
- One live pending entry per `(testId, stepId, fromKey)`; new agreeing
  evidence updates confidence in place, a new `toLocator` **supersedes** the
  old entry rather than editing it (an edited proposal is one the user never
  saw — the `stepsDivergedDismissed` lesson).
- Cap 50/test (the script-change number), pruning settled-first, never pending
  (`heal-journal-store.ts:120-131` — pending is the undo record for applied
  entries and the review queue for the rest).
- Normalized on read AND write; every locator through `normalizeLocator`
  (they originate page-side, in heal candidates).
- Deleted on test delete, beside the two journals
  (`main/handlers/index.ts:449-450`); entries whose *donor* test is deleted
  keep their snapshot fields (`stepLabel`, donor `at`) and render "(deleted
  test)" the way the Heals view already does.

### 2.7 The service and the apply path

`main/services/propagation-service.ts` is event-driven — no timer. Triggers:
after `collectRunHeals` journals a run's heals (inside the runner's teardown
posture: best-effort, never throwing into it), after a trainer heal is
journalled, after `heals:accept`, after a manual-edit donor (§2.2), and one
idempotent catch-up sweep at launch (recompute from journal + store; the
dedupe rule makes it safe). The sweep also settles housekeeping: entries whose
target step or test no longer exists, or whose target locator no longer equals
`fromLocator`, become `stale`.

One apply function, shared by `propagation:accept` (IPC) and auto-apply, and
it is `heals:accept` (`index.ts:1053-1067`) with more refusals:

- entry is pending; test and step exist;
- `locatorKey(current) === locatorKey(entry.fromLocator)` — else mark `stale`,
  write nothing (the step moved under the proposal);
- `!scriptEdited`, `!sourceDir`, and not the live recording session — the
  `refuseIfRecording` rule (`index.ts:1208-1220`): the trainer regenerates on
  finalize and would silently discard the write;
- `normalizeLocator(toLocator)` non-null; fingerprint preserved
  (`recorder-service.ts:3621-3631` — same intended element, new locator);
- then: mutate step, `updatedAt`, `if (!scriptEdited) regenerateScript`,
  `save`, status `accepted`, `applied: true`.

Auto-apply runs only when `autoHealApply === "apply"` (the user's existing,
opted-into answer to "may machines write my tests"), confidence ≥
`AUTO_APPLY_MIN`, **and the step is not an assertion** — the heal fixture
refuses to heal assertions because that silently changes what the test
checks; an unreviewed stored rewrite of an assertion's locator is the same
hazard, so assertion steps are propose-only. Auto-applied entries land
`applied: true, status: "pending"` — the amber **Applied** state, one click
from revert, exactly the existing vocabulary.

### 2.8 Surfaces

- **Heals view** (`renderer/main/heals-view.tsx`): the third `JournalEntry`
  kind, `{ kind: "proposal" }`, merged into the same time-ordered journal.
  Chips reuse the existing mapping: cyan **Proposed** (pending, unapplied),
  amber **Applied** (auto-applied, unreviewed), phos **Accepted**, toneless
  **Dismissed** / **Reverted** / **Stale**. The detail pane shows was/now via
  `formatLocator`, the origin and donor page URL, each donor ("healed in
  ‹test›, run passed", "you fixed this in ‹test›"), reason copy from codes,
  and — when artifacts survive retention — the donor's step screenshot from
  its healed run beside the target's most recent one (`replay.json`
  `stepId → actionIndex` join). Actions: **Apply** (`go` tone) / **Dismiss**
  (`ghost`), and "Apply all N pending on ‹origin›" behind an `AlertDialog`
  that names the tests it will touch.
- **Per-test**: the Heals tab's "Needs review" section and the tab badge count
  include pending proposals (`test-detail-view.tsx` already fetches counts at
  the view level so the badge shows without opening the tab).
- **Home**: `toReview` includes pending proposals — the door stays `/heals`.
- **Stats**: the Auto-Heal category gains a "proposed updates" facet — counts
  only; accept/revert stay in the Heals view (`stats-category-view.tsx`'s own
  analytics/operations line).
- **Routines**: one line in the outcome panel when a routine's runs produced
  proposals — "N suggested updates for other tests — Review ›" → `/heals`.
  The routine editor grows no review UI.
- **Refresh**: `["propagations"]` joins `RUN_DERIVED_KEYS` (its content is a
  function of run history — the runner writes proposals at run teardown), and
  a `propagations:changed` push covers the non-run writers (trainer donor,
  manual-edit donor, accept/dismiss), subscribed in `RecorderProvider` beside
  `insights:changed`. `check:derived-cache` (key must be read by a real
  `queryKey`) and `check:push-consumers` (every push has a consumer) both
  apply and both get their rows.
- **Settings → Auto-Heal**: one new row nested under `autoHealEnabled`:
  `propagateFixes`, default **on** — safe because the default posture writes
  nothing to disk. `summary` says what it does; `details` explains donors and
  seeding; `risk` states the one consequence: with Auto-Heal set to "apply",
  high-confidence updates are written without pre-review (journalled,
  revertable). Off = fully off: no proposals computed, no seeds emitted.
  Three-place registration (`settings-schema.ts` + pane + `SETTING_INDEX`);
  the `autoHealApply` row's copy gains a sentence saying propagation obeys it.

### 2.9 What stays honest (security, egress, signal)

- **Every locator on this path is page-authored once removed** (heal
  candidates came from the probe). `normalizeLocator` at store write, at
  apply, and at seed emission; generation still goes through `q()`/`num()`;
  the REBUILD-not-filter rule everywhere a record crosses IPC.
- **The donor `pageUrl` is untrusted text**: http(s) only, ≤2048 chars,
  rejected whole rather than truncated (`shared/run-provenance.mjs`'s rule — a
  cut URL is a plausible URL for somewhere else), and query values scrubbed by
  the same sensitive-params rule the network log applies.
- **No new egress.** Deterministic engine, local stores, no model calls. The
  screenshots in the evidence pane render locally, exactly as the Visual view
  renders them.
- **Nothing new leaves in a bundle.** `propagations.json` is not added to
  `shared/export-bundle.mjs`'s FILES allowlist (default-closed does the work);
  no `TestRecord` field changes, so `check:export-egress` is untouched.
- **Metrics stay clean.** Propagations are primary data in their own store —
  never `metrics.db`, which drops and replays. The heal journal's five
  consumers never see them, so `healed` counts, flake analysis and
  `list_heals` keep meaning what they mean today; seeded heals arrive there
  as the ordinary heals they are.

---

## 3. The plan — four PRs, in this order

Ordered so each lands independently; 1 and 2 do not touch each other's files.

### PR 1 — Evidence foundations

The two smallest changes, and both are prerequisites for honest confidence
scoring.

**Changes**

- `shared/heal-fixture-source.mjs`: the healed, failure and match-set events
  gain `url` from `page.url()`, best-effort (a page that throws on `url()`
  costs the field, never the event).
- `main/services/playwright-runner.ts`: `HealEvent` gains `url`; the journal
  write passes it through a validator (http(s), ≤2048, reject-not-truncate,
  sensitive-params scrub) into a new `HealEntry.pageUrl?`.
- `main/services/run-history-store.ts`: `append` declares and persists
  `hasTrace`, `attempt`, `passedOnRetry` — the fields
  `playwright-runner.ts:2001,2011` already passes and the store silently
  drops. Spread-conditional in the record literal like every optional field
  there (absent stays absent; `retryFields` already guarantees a no-retry run
  carries neither key).

**Tests**: a run-history-store row proving the three fields persist —
verified to fail against the current store; heal-fixture rows for `url` on
all three event shapes; a journal row for the validator in both directions
(a 3000-char URL and a `javascript:` scheme are dropped whole, the field
only, never the entry).

**Docs**: DECISIONS entry for the dropped-fields bug (the spread-defeats-
excess-property-checking shape is worth recording); ARCHITECTURE unchanged.

**Size**: S.

### PR 2 — The pure core

**Changes**

- `shared/origin.mjs` + `.d.mts`: `originOf` / `isOnOrigin` move from
  `main/services/origin-variable.ts`, which re-imports them — one spelling,
  reachable from plain `.mjs` (the MCP runner needs it for seeds).
- `shared/propagation.mjs` + `.d.mts`: `donorsFromJournal`, `donorFromEdit`,
  `proposalsFor({donors, tests, runsByTest, existing, now})` →
  `{create, supersede, stale}`, `confidenceFor` with reason codes,
  `seedsForTest`, `PROPOSE_MIN`, `AUTO_APPLY_MIN`, the recency window. Pure:
  plain data in, plain data out — no fs, no IPC, no process (the shared/
  admission rule).

**Tests**: `main/services/propagation.test.ts` (a test under `shared/` matches
neither vitest project — the `cli-exit.test.ts` precedent): one row per
confidence contribution in both directions, the conflict rule, the dedupe and
supersede rules, framed/`toLocator`/`sourceDir`/`scriptEdited`/diverged
exclusions, assertion steps never crossing `AUTO_APPLY_MIN`'s gate, and the
donor gates (a failing run's heal is not a donor; an accepted one is).
Origin-variable's existing tests keep passing against the re-import.

**Docs**: ARCHITECTURE entries for both modules.

**Size**: M. Two pure modules and their rows.

### PR 3 — Store, service, seeding, IPC

**Changes**

- `main/services/propagation-store.ts` (§2.6) and
  `main/services/propagation-service.ts` (§2.7), wired at the four donor
  moments plus the launch sweep.
- The apply/dismiss/revert IPC: `propagation:listAll`, `propagation:list`,
  `propagation:accept`, `propagation:dismiss`, `propagation:revert`, in
  `main/handlers/index.ts`, with test-name joins the way `heals:listAll` does
  them; cascade delete beside the journals (`:449-450`).
- Seeding: the third `buildHealMap` input + `seeds` on the map entry; the
  fixture's seed-first try (§2.5); both writers wired
  (`playwright-runner.ts`, `mcp/run-tests.mjs`).
- Manual-edit donor hooks in `tests:updateSteps` and `recorder:updateStep`.

**Tests**

- New `check:propagation` (bundled, temp `GLAZE_TEST_USERDATA`, the
  `check:heal-journal` shape): suggest mode never touches `tests.json`;
  apply refuses stale/scriptEdited/sourceDir/recording and marks stale
  correctly; revert restores `fromLocator` only when `applied`; pruning never
  drops pending; every stored locator survives
  `generate → parse → generate` as a fixed point (the `check:locator-roundtrip`
  property, for locators this feature writes); and a source-level pass
  asserting none of the heal journal's five consumers reads
  `propagations.json`. Each assertion reverted once to prove it can fail.
- `main/services/heal-fixture.test.ts` rows: a seed that resolves is used
  before the probe and records `seeded: true`; a seed that fails falls
  through to the probe; no seeds = today's behaviour byte-for-byte.
- `check:ci-fixtures`: a row asserting the MCP map writer passes seeds when
  the store holds them (and that the existing anchor literal still matches).

**Docs**: ARCHITECTURE (store, service, the heal-map/fixture change);
DECISIONS (why a separate store, why seeds go through the heal pipeline
rather than around it, why assertions are propose-only).

**Size**: L. The feature's trunk.

### PR 4 — Surfaces

**Changes**: everything in §2.8 — Heals view third kind + detail + bulk
apply, per-test tab/badge counts, Home `toReview`, the Stats Auto-Heal facet,
the Routines outcome line, `["propagations"]` in `RUN_DERIVED_KEYS` +
`propagations:changed` subscribed in `RecorderProvider`, and the Settings row
with its three-place registration.

**Tests**: `heals-view.test.tsx` rows (a proposal renders with the right chip
per status; Apply and Dismiss call the api; the bulk dialog names its tests;
mock the `api` module, not the bridge); `heals-panel` and Home count rows;
`check:derived-cache`, `check:push-consumers`, `check:stats-categories` and
the settings-search label test all pick up their halves; a
`renderer/dev` fixture so `npm run dev:web` shows a populated proposal in the
Heals view (the only way an agent can look at it).

**Docs**: ARCHITECTURE (heals-view entry, settings pane row); DECISIONS
(default-on with suggest semantics; the Routines line rather than a Routines
review UI). `docs/MCP-GUIDE.md` untouched — no MCP surface in v1.

**Size**: M.

### Later, recorded now so nobody re-argues them from scratch

- **MCP `list_propagations`** read tool (trivial once the store exists;
  MCP stays read-only regardless — mcp-and-test-intelligence.md §10).
- **Heal evidence through export/ingest**, so CI runs feed the donor corpus —
  touches the R10/R12 allowlists and gates, a decision of its own.
- **Fuzzy fingerprint matching** (near-miss selectors), suggest-only.
- **`toLocator` and framed targets**, if manual-edit donors for them appear.
- **The opt-in LLM evidence pass** for low-confidence proposals — explicitly
  deferred; it would be the app's second unattended LLM egress and needs an
  insights-egress-shaped check from day one.

---

## 4. Deliberately not doing

- **No LLM, v1.** The join is deterministic and the evidence is already
  structured; a model adds an egress surface, not accuracy, at this stage.
- **No fuzzy matching, v1.** Exact `healKeyFor` identity keeps precision high
  while trust is being earned; the fingerprint is corroboration, not a match
  criterion.
- **No auto-apply of assertion locators**, whatever the confidence (§2.7).
- **No propagation onto framed steps, `toLocator`, imported or script-edited
  tests** (§2.3) — each is either evidence-free or a write the repo already
  refuses elsewhere.
- **No `metrics.db` column.** Proposals are primary data; the DB drops and
  replays. If a rollup is ever wanted, the journal's `seeded` flag is the
  re-derivable source.
- **No new env vars, no new fixture files.** Seeds ride inside the heal map;
  the R49 class of half-wired capability gets no new members.
- **No Routines review UI and no new rail entry** — decided in §0.

---

## 5. Gate per PR

```
npm run lint && npm run type-check && npm run test:all && npm run build
```

plus, for PR 3, one real run in `npm run dev` against a page whose locator
was renamed after a sibling test healed: the run heals through the seed, the
Heals view shows the seeded heal AND the standing proposal, accepting the
proposal rewrites the sibling, and reverting puts it back. For PR 4,
`npm run dev:web` with the new fixture, and the real app for the Settings row
and the Routines line.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Propagating to a same-named element that is a *different* element on another page | same-origin requirement; fingerprint corroboration in confidence; suggest-by-default; seeds only act where the old locator already failed; every write revertable |
| Proposal noise on big suites | conflict rule refuses ambiguity; dedupe + supersede; per-test cap; `PROPOSE_MIN`; recency window |
| Feedback loops (propagation feeding itself) | donor hooks live in the user-facing handlers; the apply path bypasses them by construction; `check:propagation` pins it |
| Masking the "site changed" signal | seeds fire only on real failures and route through the existing heal journal/metrics pipeline (§2.5) |
| Heal-journal consumers miscounting propagations | separate store; source-level assertion in `check:propagation` |
| Donor corpus missing CI heals | named in §1.3; export/ingest extension recorded under Later rather than implied |
