# The Variables tab

Written 2026-09-01, alongside the redesign that landed the same day. Unlike the
other documents in this folder this one is only half historical: the first
section records what shipped, and the rest is **deferred work that was scoped
and deliberately not built**, kept here because each piece was designed against
a constraint that will still be true when somebody picks it up.

For what the code does now, read
[../ARCHITECTURE.md](../ARCHITECTURE.md); for why it landed this way, the
entry dated 2026-09-01 in [../DECISIONS.md](../DECISIONS.md).

## What landed

Three `Panel`s, each with its control in its own header.

- **Variables** — one hairline group per kind (Values, Secrets, Captured,
  Generated), each stating its own storage rule and offering exactly one value
  affordance. The kind is named on the header's Add menu; changing it, and
  removing a variable, live in the row's `⋯` menu. Only kinds in use draw a
  group.
- **Reuse & identity** — Reusable flow, Login session and HTTP basic auth as
  three partitioned subgroups. None of them is a variable, but basic auth's
  password *is* a Secret variable by construction, so the three stayed here
  rather than moving to a tab of their own.
- **Datasets** — a table: one column per non-secret variable, one row per
  dataset row.

Colour is reserved for two tiers of notice, `blocking` and `action`. The
plaintext explanation kept its words and its unconditional render but became
body copy.

## Deferred: secret expiry

**The constraint.** `tests:secretStatus` answers `{ name, hasValue }` and
nothing more. There is no expiry, no last-used timestamp, and no way to tell a
live API token from one revoked three weeks ago. The redesign's rule is that an
interruption has to name something the user can do; a warning built on data the
app does not have would have been the standing callout again in a new colour.

**The shape it would take.**

1. `test-secrets-store` grows an `expiresAt` beside each encrypted value. It is
   metadata, not the secret, so it can be read back over IPC — which is the
   whole point, since `hasValue` is the only thing that crosses today.
2. `SecretStatus` gains `expiresAt?: number`, and `tests:setSecret` takes it
   alongside the value. One field, set where the value is set: a second
   handler for "just the expiry" would let the two disagree.
3. The Secrets group's row shows it as a chip, and the row raises an `action`
   flag once it is past — the same tier as "no value stored", because it has
   the same consequence: the next run authenticates with something that will
   not work.
4. A rotation reminder is **not** part of this. It needs a notification surface
   this tab does not own, and the Alerts pane already has one; wiring it here
   would put a scheduler behind a text field.

**The open question** is who sets it. Typing an expiry by hand is a date nobody
maintains, and a stale `expiresAt` is worse than none — it flags a working
secret and trains the eye past the flag. Reading it from the credential (a JWT's
`exp`, an OAuth token response) is accurate and covers only the kinds of secret
that carry one, which is a narrower but honest feature. Prefer the narrow one:
parse `exp` when the stored value is a JWT, show nothing otherwise.

## Deferred: attributing a failure to a variable

**The constraint.** Nothing connects a failing run to the variable that caused
it. The failure-reason path (`main/services/` + the Failure reasons pane)
classifies a run; it does not know a step read `${apiToken}`, and the step
reporter does not carry variable references into the run record.

**The shape it would take.** `varRefs` is already on every step and already
counted by this tab. A run record that carried the failing step's `varRefs`
would let the Variables tab say "the last run failed on a step that reads
`${apiToken}`" — which is the trigger the redesign was asked for. That is a
change to what a run record stores, not to this view, and it is the reason this
was split off: the tab can render it the day the data exists, and inventing a
heuristic here (matching an auth-shaped error message against secret names)
would be a guess wearing an interruption's colour.

## Deferred: a name heuristic for a mis-declared secret

A variable named `password`, `token`, `secret` or `key` holding a plaintext
Value is very likely a mistake. An inline "make this a Secret" action on that
row would cost one click where the redesign now costs three.

Not built because it is a list of English words maintained in the renderer, it
is silent for `pw`, `pat`, `apiKey2` and every non-English name, and a false
positive puts a nag on a legitimately plaintext variable — at which point the
tab has a standing notice that asks for something the user does not want to do,
which is the failure this redesign exists to undo. Worth revisiting only with a
way to dismiss it per variable, which is a stored field and therefore a
boundary change.

## Deferred: a per-variable view of its dataset values

A variable's rows live in the Datasets table, one section down from the
variable itself. Gathering them — "here is `email`, and here is what it is on
every row" — was the strongest argument for the inspector layout that lost to
the grouped one. It is additive: a row's `⋯` menu could open a panel showing
that variable's column, without changing anything that landed.
