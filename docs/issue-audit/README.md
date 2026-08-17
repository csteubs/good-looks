# Issue audit

Regenerated triage of every open `bug` and `enhancement` issue in the repo.

**This directory is generated, not hand-maintained.** It is rewritten by the
`issue-audit` skill (`.claude/skills/issue-audit/SKILL.md`), which re-reads the
open issues, re-checks each claim against the code as it stands today, and
rewrites `AUDIT-<date>.md` plus one `fix-<n>.md` per actionable item.

Unlike [../plans/](../plans/), which is a historical record of intent, the
newest `AUDIT-*.md` here is meant to be current. Anything older is a snapshot —
read the newest one.

## Layout

| File | What it is |
| --- | --- |
| `AUDIT-<date>.md` | The whole triage: one verdict per issue, with the evidence for it |
| `fix-<n>.md` | A ready-to-execute fix plan for issue `<n>` — root cause, the edit, the test, the gate |

A `fix-<n>.md` is written to be handed to an agent on its own: it names the file
and line, states the root cause, and says which test would have caught it. It
assumes nothing from the audit that produced it.

## What it does not do

The audit never closes, labels or comments on an issue by itself, and never
edits application code. It reports; a human decides. Recommendations that would
change an issue's state are listed under "Recommended issue actions" in the
audit, ready to be applied or ignored.
