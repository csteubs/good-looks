---
name: issue-audit
description: Re-triage every open bug and TODO in this repo's GitHub issues against the code as it stands today. Use when asked to audit, triage, re-check or groom the issues/backlog, when asked whether a filed bug is still valid, or on a schedule (daily/weekly). Produces docs/issue-audit/AUDIT-<date>.md plus a fix plan per actionable item. Never closes, labels or comments on an issue.
---

# Issue audit

Re-check every open `bug` and `enhancement` issue against the current code, and
write down what is still true.

The value is entirely in **disproving stale claims**. This repo ships fast and
issues go stale quickly — the first run of this audit found seven of seventeen
open issues already fixed, and two more half-built with titles that made them
look untouched. A verdict of "still valid" that was reached by reading the issue
rather than the code is worth nothing.

## Rules

1. **Never mutate GitHub.** No `gh issue close`, `comment`, `edit`, `label`,
   `reopen`. Recommend; a human applies. This is what makes the audit safe to
   run unattended on a schedule.
2. **Never edit application code.** The only files this writes are under
   `docs/issue-audit/`.
3. **Cite a file and line for every verdict**, or say plainly that you could not
   check it and why. "Looks fixed" is not a verdict.
4. **Prefer disproof.** Spend effort trying to show a bug is *fixed* and a
   feature is *already built*. Those are the findings that shrink the backlog.
5. **Uncheckable is a real verdict.** Anything about real windows, native menus,
   packaging or a live site cannot be settled from the preview or from jsdom.
   Say so, and name the manual step (`npm run dev`) or the e2e spec that would.
6. **Never call something fixed on code you read but did not drive.** The first
   run of this audit marked "the record window persists after recording" as
   likely fixed, having read the native window teardown and found it correct.
   That code *was* correct; the thing that persisted was a modal in a different
   window. Reading the wrong component proves nothing, and a citation makes a
   guess look like a finding. If the claim is about something on screen and you
   did not put it on screen, the verdict is **unverified** — not fixed.

## Steps

### 1. Read the ground

Read `CLAUDE.md` first — it names the traps that make a wrong verdict likely
(jsdom has no layout engine; a class that does not exist emits nothing; Radix
`Select` options never enter the DOM; `TabsTrigger`/`SidebarListItem` need
`mouseDown`). Then skim `docs/ARCHITECTURE.md` for where things live and
`docs/DECISIONS.md` for why.

Read the previous `docs/issue-audit/AUDIT-*.md` if one exists. Issues it already
settled need only a re-check that the fix is still in place, not a fresh
investigation. Note which issues are new since then.

### 2. Enumerate

```bash
gh issue list --limit 100 --state open --json number,title,labels,createdAt,author
```

Then pull bodies and comments in one pass:

```bash
for n in <numbers>; do gh issue view $n --json number,title,body,labels,createdAt,comments; done
```

Read the comments. On the first run, one issue had already been closed out by
the reporter in a comment and nobody had acted on it.

Screenshots attached to an issue cannot be fetched. Treat the body text as the
claim and go find the code.

### 3. Correlate with what has shipped

`git log --oneline -40` and the `##` headings in `docs/DECISIONS.md`. Match
commit subjects against issue titles — this is the fastest route to "already
fixed", and this repo's commit subjects describe behaviour, so they match issue
language well. A PR number in a commit subject is worth opening.

### 4. Verify each claim

Work bug by bug. For each, find the module that owns the behaviour and read it.

**Drive the app for anything visual.** `npm run dev:web` (port 5199) is the only
runnable surface an agent has, and it settles layout questions no test in this
repo can:

| Route | Shows |
| --- | --- |
| `?test=<id>` | A test's detail view. `?test=t-login` reaches the **failed** run + console path; `?test=t-checkout` passes |
| `?view=stats` \| `visual` \| `batch` \| `heals` | Those views |
| `?view=settings` | The real Settings window — otherwise unreachable outside a packaged build |
| `?view=specimen` | Every redesign primitive in every state |
| `?view=recorder` \| `recorder-editing` | A live recording session |

Runs finish in the preview, so a run's *side effects* are observable — which is
how to test "does X reset when a run finishes" claims.

Measure rather than eyeball. `mcp__Claude_Browser__javascript_tool` reading
`getBoundingClientRect`, `scrollHeight`/`clientHeight`, `overflow` and computed
styles turns "looks cropped" into a number. A screenshot cannot distinguish
"clipped and unreachable" from "clipped and scrollable", and that distinction is
the whole verdict.

Dismiss the missed-runs dialog that opens on load before interacting.

**Check the component's whole lifetime, not just its teardown.** A view can be
correct and still leave something behind, because in this app *where* a
component is mounted decides how long it lives: `RootShell` swaps only the
outlet while recording, so anything in the `sidebar` slot or wrapping the tree
(`LibrarySidebar`, `CommandPalette`) outlives a session that unmounts `HomeView`.
That is why one bug reproduced from the sidebar and not from Home, and it is the
kind of thing only clicking finds. When a symptom is intermittent, suspect two
mount points before suspecting a race.

**What the preview cannot answer:** a second window, native menus, IPC, the
packaged bundle, real navigation. Route those to `npm run dev` or to the
relevant `e2e/*.spec.ts`, and say so in the verdict. But note the trap: a bug
*about* a window is not necessarily a bug *in* a window. Rule out the renderer
before concluding the preview cannot settle it.

### 5. Assign a verdict

| Verdict | Meaning |
| --- | --- |
| **Fixed** | Reproduced the fix, with a citation. Recommend close |
| **Likely fixed** | Code implements what was asked; unverifiable here. Name the manual check |
| **Valid** | Reproduced or read the defect. Write a fix plan |
| **Half done** | Part shipped. Recommend narrowing the issue, and say which part |
| **Premise stale** | The issue's reasoning refers to something that has changed meaning. Say what it says now |
| **Not reproducible** | Needs information. Say exactly what to ask for |
| **Done** | Feature exists. Recommend close |

For every **feature**, answer all nine — briefly, and only where they apply:

- Still necessary?
- Already built, in whole or in part, possibly under another name?
- Engineering lift, in days?
- Complexity added — and specifically, does it bend an existing interface or
  cross a boundary this repo guards (the capture boundary, the import sandbox,
  the branch-name validator, `main/shell/`, `shared/` purity)?
- Dependencies, and whether any block it?
- Does it unblock or unlock other work?
- Is there a plan in `docs/plans/`, and does it still agree with the code?
- New design needed, or existing components?
- Does the frontend's surface area grow or shrink?

### 6. Write the output

Into `docs/issue-audit/`:

- `AUDIT-<YYYY-MM-DD>.md` — a verdict table first, then one section per issue
  with the evidence, then a **Recommended issue actions** section grouped by
  action (close / narrow / rewrite / relabel / needs-info / ready to work).
- `fix-<n>.md` for each **Valid** item, and for any **Half done** item where the
  remaining work is clear.

A `fix-<n>.md` is written to be handed to a fresh agent with no other context:

```
# Fix plan — #<n>: <one line>

**Status / Verified / Severity**
## What the user sees
## Root cause            ← file:line, quoted
## The fix               ← the actual edit
## The test that would have caught it
                         ← plus: "verify it can fail" — revert the fix, confirm red
## Gate                  ← npm run lint && type-check && test:all && build,
                           plus which preview screen to look at
```

Two things to get right, because they are what makes a plan trustworthy here:

- **Name the blast radius.** A one-line change to a shared component reaches
  every call site. Say how many and which screens to look at.
- **Do not fold findings together.** A second defect noticed on the same screen
  gets its own line saying "file separately", never a bullet inside someone
  else's fix.

Then update `docs/issue-audit/README.md` if the layout changed.

### 7. Report

Lead with the count that shrinks the backlog: *N of M can be closed*. Then the
items needing a decision, then what is ready to work. Link the audit and the fix
plans. Do not restate the table in prose.

## Scheduling

Safe to run unattended — it only reads GitHub and only writes under
`docs/issue-audit/`. Daily is more often than this backlog changes; **weekly**
fits it better, and after a batch of PRs merges is when it pays best.

If a run finds nothing new, say so in one line and leave the previous audit as
the current one rather than writing a near-identical file.
