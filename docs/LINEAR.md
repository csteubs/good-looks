# Linear integration — research

**Status:** research only, nothing built, no decision taken. Written 2026-08-08
from the note *"Linear integration — A11y feature: send to Linear"*.

> **Carried onto `main` 2026-08-14, and its Status line is now WRONG.** This
> document was written on `claude/transcribe-notes-plan-work-e36d77`, which
> never merged. **This one shipped**: `main/services/issue-tracker/` carries
> `issue-tracker-service.ts`, `issue-config-store.ts`, `issue-link-store.ts` and
> `defect-loader.ts`, and the run panel has a "Send this failure to the issue
> tracker" action. Read what follows as the reasoning that led there, not as a
> description of the code — for that, `docs/ARCHITECTURE.md`. Kept because the
> rejected alternatives and the data-leaves-the-Mac argument are not recorded
> anywhere else.

Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md),
[DECISIONS.md](DECISIONS.md).

## What this would be

A **"Send to Linear"** action on an accessibility violation, creating an issue
with the rule, its impact, the element it names, and a link back to the run.

Worth saying first: this is the app's **second** thing that would send data off
the machine. The first (the alert webhook) is surrounded by more care than any
other feature here, and the reasons are all in `main/services/alert-service.ts`.
Any Linear work inherits that bar rather than starting fresh.

## The patterns to copy

### Credential storage — solved twice already

Both `main/services/webhook-url-store.ts` and
`main/services/anthropic-key-store.ts` implement the same shape, and a Linear
API token is the same kind of thing:

- Encrypted at rest with `safeStorage.encryptString`, in its own `.bin` under
  `userData/recorder/`.
- Written atomically (temp file + `fs.rename`).
- **Backend-only.** There is deliberately no getter over IPC. The renderer can
  ask `hasKey()` / `status()` and get back "configured or not" — the webhook
  store also returns the host, described in its own code as *"What the renderer
  is allowed to know: configured or not, and to where."*
- A decryption failure surfaces as "no credential", and is not cached.

So: `linear-token-store.ts`, ~85 lines, a near-copy of `anthropic-key-store.ts`.
This part is not the interesting problem.

### What may leave the machine

This is the interesting problem, and `alert-service.ts` already answers it for
its own case (`:6-15`):

> SUMMARY ONLY. Run logs are never sent — they routinely contain page content,
> URLs with tokens, and typed fixture values (passwords, card numbers) captured
> during recording.

It backs that up two ways: `buildAlertPayload` is **pure**, so `check:alerts`
can assert nothing else ever leaks in; and `redactPayload` strips every stored
secret value from the text immediately before the send, deliberately at the
send site *"rather than anywhere a later refactor could route around"*.

An a11y violation is a much better fit for this rule than a run log, because of
what axe actually gives us.

### The payload is already small — by accident, and it helps

`A11yViolation` (`main/services/a11y-diff.ts:12-31`) is only:

```ts
{ id: string; impact: "minor"|"moderate"|"serious"|"critical"; help: string; nodes: string[] }
```

The capture fixture compacts axe's output at source
(`capture-fixture-source.ts:204-237`), keeping the rule id, impact, help text
and joined node targets, capped at 25 violations × 5 nodes. There is **no
`helpUrl`, no `description`, no HTML snippet, no WCAG tags** — they were never
stored.

Two consequences, and they pull in opposite directions:

- **Good for privacy.** The most sensitive thing in the payload is a CSS
  selector. No page text, no attribute values, no user input.
- **Thin for an issue.** A Linear issue reading *"color-contrast — serious —
  Elements must have sufficient color contrast — `#promo > p`"* is actionable
  but bare. Adding `helpUrl` (a deep link to Deque's rule page) would improve it
  a lot and costs nothing privacy-wise — but it means changing the fixture and
  the stored shape, which is a bigger change than the button.

**Recommendation: ship the button against the shape that exists**, and treat
`helpUrl` as a separate follow-up rather than a prerequisite.

## Where it goes

`renderer/main/a11y-panel.tsx` has two existing action sites:

- **Per-run** header row (`:170-207`): "Accept all in this run" and "Reset
  accepted", separated from the title by a `flex-1` spacer.
- **Per-step** (`StepViolations`, `:43-80`): "Accept these issues", shown only
  when that step has unaccepted violations.

There is **no per-violation action anywhere** — `A11yViolationList`
(`a11y-violations.tsx:60-93`) renders static divs. A per-violation "Send to
Linear" would be the first interactive element in that component, and that
component is **shared with the Visual view's step detail**
(`visual-view.tsx:140-165`), so adding a button there changes two surfaces at
once.

**Recommendation: start per-STEP, not per-violation.** One issue per failing
step (listing its violations) is both the smaller change and the better issue —
five separate Linear issues for five contrast failures on one page is noise, and
the person fixing them will fix them together.

## Identity, and the problem nobody notices until month two

The obvious version — button POSTs to Linear, issue appears — is fine on day
one and wrong by week three, because **every subsequent run re-reports the same
violations**. Click twice and there are two issues. Run nightly and there are
thirty.

The app already has the right key for this. `violationKey` in
`a11y-diff.ts:48-50` is `` `${id}|${target}` ``, and its rationale is explicitly
that the rule id alone is too coarse:

> keying on the rule alone would make accepting one low-contrast label accept
> every future contrast failure on the page

So a Linear integration needs a **local map from violation key → Linear issue
id**, persisted like the heal journal, so it can say "already filed as ENG-123"
instead of filing again. That store is the actual work in this feature; the
POST is the easy half.

A cheaper first version that avoids the whole problem: **don't post at all.**
Put "Copy as Linear issue" on the step — formatted markdown, straight to the
clipboard. No token, no store, no duplicates, no network. It answers most of
what the note asks for, and it would tell us whether the real thing is worth
building.

## Open questions

1. **Which team / project?** Linear requires a team id on create. Another
   setting, and a picker that needs the API to populate it.
2. **What does the issue link back to?** There is no URL scheme for "this run,
   this step" today. Without one, the issue can name the test and run id as
   text, which is weak but honest.
3. **Does accepting a violation locally do anything to its issue?** Leaving them
   unlinked means the two drift. Closing the issue automatically is the kind of
   outbound side effect this app has so far avoided.
4. **Status ownership.** If Linear is where a11y issues live, the app's own
   accept/reset baseline becomes a second source of truth about the same facts.
   Worth deciding deliberately rather than discovering.

## Suggested order

1. **"Copy as Linear issue"** on a step — clipboard markdown, no network, no
   credential, no store. Ships in an afternoon and tests the premise.
2. If that gets used: `linear-token-store.ts` + a settings row modelled on the
   webhook one (including its confirm-on-enable), and a **pure**
   `buildLinearIssue()` so a check can pin exactly what leaves the machine.
3. The filed-issue map, keyed by `violationKey`, so re-runs update rather than
   duplicate.
4. Only then, if wanted: per-violation granularity, `helpUrl` in the stored
   shape, and any write-back.
