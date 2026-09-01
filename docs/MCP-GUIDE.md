# Using Good Looks! from an AI assistant (MCP)

A guide to the Good Looks MCP server: what it is, how to switch it on, what you
can ask for, and — the question this guide exists to answer — where Linear,
GitHub and Slack fit, because none of them are part of it.

`mcp/README.md` is the full per-tool reference. This is the shorter version,
organised by what you are trying to do.

**This file is also part of the app's manual.** Settings → Documentation renders
it, and the Help menu opens it at a section, so it is written to be read on
screen.

---

## 1. What it is

The MCP server hands your **test library and run history** to an AI assistant —
Claude Code, Claude Desktop, Codex, or any other MCP client. Once it is
registered, you stop clicking and start asking:

> "Run all my smoke tests and tell me which ones failed."

> "That checkout run failed — was it the site or our test?"

Three things follow from how it is built.

- **It is local.** It runs on your Mac, reads the same files the app reads
  (`tests.json`, `run-history.json`, the generated specs and run artifacts), and
  talks to nothing on the internet.
- **It works whether or not the app is open.** The app is not a server; the MCP
  reads the same folder. Two things do need the app running: screenshots of the
  app's own windows, and Routine *schedules*.
- **It is read-mostly.** It can list, read, diagnose and *run* tests. It cannot
  edit a test, accept a visual baseline, change a setting or delete anything.
  Those stay in the app on purpose, so two processes can never disagree about
  what they mean.

**There is no MCP screen in the app.** Nothing in Settings switches it on, and
the only setting that changes its behaviour at all is *Diagnostics → Debug
screenshots* (see §6). You set it up in your assistant's config, once.

If what you actually want is tests running on a build server rather than through
an assistant, that is the command line instead — see the CI topics beside this
one.

---

## 2. Setup

### Where the server is

The app carries the MCP server inside it, so there is nothing to clone or build.
Settings → Documentation shows the exact path on **your** machine, with a Copy
button for the command below. Use it — it answers from disk rather than from
this page.

For an app installed in `/Applications`, the two paths are:

```
/Applications/Good Looks!.app/Contents/MacOS/Good Looks!
/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs
```

The first is the app's own binary, and it runs the server for you. That is why
the commands below set `ELECTRON_RUN_AS_NODE=1` and never mention `node`: you do
not need Node installed.

Quote these paths with **single** quotes. The app's name ends in an exclamation
mark, and inside double quotes a shell reads that as history expansion and
refuses the command.

### Claude Code

```bash
claude mcp add --scope user good-looks -e ELECTRON_RUN_AS_NODE=1 -- '/Applications/Good Looks!.app/Contents/MacOS/Good Looks!' '/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs'
```

`--scope user` makes it available in every project; drop it to register the
server for only the project you run the command in. Check it took:

```bash
claude mcp list
```

### Claude Desktop and other MCP clients

Add this to the client's MCP config. For Claude Desktop that is
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "good-looks": {
      "command": "/Applications/Good Looks!.app/Contents/MacOS/Good Looks!",
      "args": ["/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### Codex CLI

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.good-looks]
command = "/Applications/Good Looks!.app/Contents/MacOS/Good Looks!"
args = ["/Applications/Good Looks!.app/Contents/Resources/app/mcp/server.mjs"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

### From a checkout

Working in the repository instead? Point at the tree and use `node`:

```bash
claude mcp add --scope user good-looks -- node '/path/to/good-looks/mcp/server.mjs'
```

Nothing else is needed — no port, no login, no token. If your client lists
`good-looks` with its tools, you are done.

---

## 3. What you can ask for

You do not call tools by name; you describe what you want and the assistant
picks. Grouped by the job you are actually doing.

### Looking at the library

| Ask | Tools behind it |
| --- | --- |
| "List my recorded tests." | `list_tests` |
| "Which of my tests are reusable flows?" | `list_tests` with its `isFlow` filter |
| "Show me the steps and the generated script for the checkout test." | `get_test` |
| "What parameters does the Sign in flow take?" | `get_test` — a flow reports `flowParams`, and its variables carry the defaults |
| "What Routines do I have saved, and how many runs does the nightly one spawn?" | `list_routines` |

### Running things

| Ask | Tools behind it |
| --- | --- |
| "Run the signup test on WebKit." | `run_test` |
| "Run everything tagged smoke, four at a time." | `run_batch` |
| "Run every test in my Checkout folder." | `run_group` |
| "Sweep the checkout test over every dataset row and tell me which rows fail." | `run_batch` with datasets |
| "Run the Nightly regression routine." | `run_routine` |

Runs started here are **always headless** — nothing appears on screen — and they
are written to the app's own history, so they show up in Stats, and batches show
up in the Batch view, exactly as if you had started them from the app.

### Working out why something failed

| Ask | Tools behind it |
| --- | --- |
| "Get the log for that failed run and tell me what broke." | `get_run_log` |
| "Was that the site's fault or ours?" | `triage_run` |
| "The locator matched ten elements — what were they?" | `get_step_matches` |
| "Did the server error, or did we look for the wrong thing?" | `get_run_logs` |
| "Compare the last two runs of the checkout test." | `compare_runs` |

`triage_run` is the one worth knowing by name. It reads the evidence already on
disk and says whether a failure was the **site** or the **test**, and it reports
what it *could not* see alongside what it could. Ask for the evidence, not just
the verdict. It also suggests the failure-reason label the evidence argues for,
and `list_runs` shows the label each failed run already carries — but assigning
or changing one is done in the app's run panel, not from here.

### Health of the suite over time

| Ask | Tools behind it |
| --- | --- |
| "Which tests are flaky, as opposed to just broken?" | `get_flake_report` |
| "Which locators has Auto-Heal been rewriting over and over?" | `list_heals` |
| "Did a site change break several tests at once?" | `list_propagations` |
| "Which steps are getting slower while still passing?" | `get_step_health`, `get_suite_cost` |
| "Which steps fail on one browser only?" | `get_browser_matrix` |
| "How much of my suite's runtime is screenshots and a11y checks?" | `get_suite_cost` |
| "Which steps changed visually in the last run, and by how much?" | `get_visual_report` |
| "What accessibility problems are *new* since the baseline?" | `get_a11y_report` |
| "Show me the last 20 batches." | `list_batches`, `list_runs` |

### Screenshots of the app itself

| Ask | Tools behind it |
| --- | --- |
| "Screenshot the app and tell me if the Variables tab looks right." | `capture_app` |
| "I just pressed the capture shortcut — grab it." | `get_screenshot` |

These picture **Good Looks!'s own windows**, not the sites under test. See §6.

---

## 4. What it can and cannot do

Worth reading once, because each of these is invisible until it bites.

### A run from here does the same work as a run in the app

Screenshot capture, accessibility checks, console and network recording,
run-time Auto-Heal, crawl page-settling and standing overlay rules all work in
an MCP run. Each one follows the setting the test already carries, exactly as
the app reads it. You do not get a lesser run for asking an assistant to start
it.

Every run reports what it did and did not do in a `fixtures` field. Read that
before drawing a conclusion from a failure — it is where the exceptions below
are named for the specific run in front of you.

**An imported spec is the exception.** A test imported from someone else's
Playwright project gets none of this, because instrumenting it would mean
rewriting their code rather than ours. The app applies the same rule.

### A run from here is marked as such

Its record says an MCP client started it, and Stats draws a small marker on the
row. Runs also record when they were started by the app, by the Routine
scheduler, or by the command line, so "who ran this" is always answerable.

Runs recorded before this existed carry no marker. Absent means unknown, never
"somebody ran it by hand".

### Three values cannot leave the app

Each is encrypted through the OS keychain, and only the app can decrypt them.

- **Secret variables.** `run_test` refuses a test that declares one and says so.
  `run_batch` and `run_routine` skip it with a note rather than failing the whole
  suite. Everything else about those tests — steps, script, past runs, logs —
  stays readable. Run them from the app.
- **A Shopify crawler signature.** The server can see which domains have one
  registered, so a run against one of those says it went unsigned. That note
  matters more than it looks: an unsigned run against a store with crawler
  protection does not fail somewhere obvious, it gets throttled or blocked and
  fails further down as a timeout or a missing element. That reads like
  flakiness. A failure here can be a pass from the app.
- **A proxy password.** A proxy set in Settings → Proxy does apply to runs
  started here, so both take the same network path — but without its password, a
  proxy that requires a login refuses the run at the tunnel. That is deliberate:
  going direct instead could succeed, and a run that quietly took a network path
  your settings forbid is worse than one that stops.

### Console and network logs are withheld if any test declares a secret

The rule is library-wide, not per test. The app redacts secrets when it reads
those files; this server cannot, and any run's log can contain any test's
secret.

### Nothing here edits anything

No tool changes a test, accepts a baseline, edits a Routine (not even its
schedule), changes a setting or prunes anything.

### Routines have two limits worth knowing

**A schedule only fires while the app is open.** The MCP can run a routine on
demand, but it cannot schedule one, and running it here does not satisfy that
day's schedule.

**A routine can pause mid-run, so `run_routine` can take much longer than the
tests in it.** A `wait` step is a barrier: everything before it finishes, the run
holds for up to an hour, then the rest starts. `list_routines` does not report
the pauses, so a call that seems to hang may simply be sitting in one.

### Reports need a captured run

Visual, a11y, console and network reports read artifacts that only a captured
run produces, and the app prunes old run directories according to your retention
setting. "No artifacts" is an ordinary answer, and the tools tell it apart from
"nothing changed".

---

## 5. Linear, GitHub and Slack

**The MCP server does not connect to any of them.** There is no tool that files
an issue, opens a pull request or posts a message, and the server contacts no
network host at all. If you have been looking for the MCP's Linear settings,
that is why you could not find them.

Good Looks! *does* talk to those three services — from the app, through its own
integrations, configured in **Settings → Integrations** (⌘, then *Integrations*).
Here is each one, and how it relates to the MCP.

### Linear or GitHub — filing a failure as an issue

**Where:** Settings → Integrations. The **Issue tracker** row at the top of the
pane is where you choose between *Linear* and *GitHub*. Everything below it then
speaks that tracker's language — Linear has teams and projects, GitHub has
repositories and milestones.

Paste the key for whichever you picked: a Linear API key (`lin_api_…`) or a
GitHub token with Issues write access (`ghp_…` or `github_pat_…`). The pane
reports "saved" and "works" as two separate claims, so a revoked key stops
reading as connected. You can also set a default destination, which prefills the
compose dialog.

Each tracker keeps its own key, its own default destination and its own record
of what has already been filed. Switching is reversible, and switching back
finds everything where you left it.

**The GitHub token here is not the one in the branch switcher row further
down**, even if it is the same string. They are separate on purpose:
disconnecting the issue tracker clears its key, and sharing one would silently
stop pull requests listing in the branch switcher.

**How you use it:** on a failed run, click the **Send to issue tracker** button —
the paper-plane icon in the run output header. A compose dialog opens with a
title and body already assembled from the failure: the failing step, the error
line, and screenshots or diffs as attachments you can drop before sending. The
same button appears on visual diffs and on individual accessibility violations
in a test's Accessibility tab, so each violation can become its own assignable
issue. The Accessibility view's Triage board can also send one issue per *rule*,
listing every place it fires across the suite.

If that same defect already has an issue, the dialog offers to **comment the
recurrence** on it instead of filing a duplicate.

The raw run log never leaves the app — only the reduced failure line does.

**One difference between the two trackers, and the dialog says so before you
send.** GitHub's API has no image upload, so screenshots and diffs cannot travel
with a GitHub issue. When GitHub is selected the attachment strip says the
screenshots will **not** be attached, and the issue body names them so nobody
reads it as complete. Linear uploads them normally. If the pictures are the
point — as they usually are for a visual difference — that is worth knowing
before you choose.

**With MCP:** the assistant can diagnose (`triage_run`, `get_run_logs`) but it
cannot file. Filing is a click you make.

### Slack (and Discord) — alerts on failure

**Where:** Settings → Integrations → *Send alerts to a webhook*, plus the
*Webhook URL* row below it. Paste a Slack or Discord incoming-webhook URL
(`https://hooks.slack.com/services/…`), save it, then flip the switch. The switch
asks for confirmation when you turn it **on** — this is the only thing in the app
that sends data off your Mac automatically.

**What fires it:** a run fails, a step changes visually past its threshold, or a
batch finishes with failures.

**What it sends:** a summary only — test name, status, the failing step's label,
counts, duration, browser. Run logs are never included, because they routinely
contain page content and values typed during recording. Use the *Send a test
alert* button to see exactly what lands in your channel before trusting it.

The URL itself is stored as a secret, encrypted and never shown back. The pane
tells you the host it posts to, not the token.

**With MCP:** the alert is fired by the **app**, on the app's own runs. Runs you
start from MCP do not post to your webhook.

### GitHub — not a test integration

**Where:** Settings → Integrations → *GitHub token*. Optional.

**What it is for:** listing pull requests in the **branch switcher**, so you can
check out and build another branch of this app. That is its entire job. A token
buys you private repos and the authenticated rate limit; without one, public
repos still work at GitHub's unauthenticated limit.

It does **not** post test results to a pull request, open issues, or run anything
in CI. Nothing about your test library is sent to GitHub.

### Chaining Good Looks with your other MCP connectors

This is the workflow most people are actually after. Your assistant can hold
several MCP servers at once — Good Looks alongside Linear's, GitHub's or Slack's
own connectors — and the interesting work happens when it combines them:

> "Run the smoke batch. For anything that fails, triage it, then open a Linear
> issue in the QA team with the verdict and the failing step."

> "Compare the last two runs of the checkout test and post a summary to
> #qa-alerts."

> "Which tests are flaky? Open a GitHub issue listing them."

The division of labour is worth keeping in your head: **Good Looks supplies the
facts; the other connector does the writing.** The write side runs under that
connector's own credentials and permissions, not this app's. An issue filed that
way is filed by your assistant, and it will not appear in Good Looks' own
"already has an issue" list the way one filed from the compose dialog does.

So for defects you want the app to track, prefer the in-app **Send to issue
tracker** button. For ad-hoc reporting and cross-tool summaries, chaining is the
better tool.

---

## 6. Screenshots of the app

Two tools, for when you are asking an assistant about the app's own UI.

- **`get_screenshot`** returns the most recent debug screenshot, including ones
  you took yourself with the in-app shortcut (**⌘⌥⇧S** by default; Settings →
  Diagnostics shows your actual combination). This works with no setting enabled.
  Press the shortcut, then say "grab that screenshot". The reply says how old the
  capture is — a stale screenshot presented as current is how you end up
  debugging a UI state that stopped existing ten minutes ago.
- **`capture_app`** lets the assistant ask for a *fresh* shot of every open
  window without you pressing anything. This needs the app running with
  **Settings → Diagnostics → Debug screenshots** turned on. It is off by default
  because it keeps a small directory watcher running, and a debugging aid has no
  business running for people who are not debugging.

Captures are downscaled, and only the newest ten are kept.

---

## 7. Troubleshooting

| Symptom | What it means |
| --- | --- |
| The client lists no `good-looks` tools | Registration did not take. Re-run the setup command and check the path to `server.mjs` exists |
| "Requires the chosen browser to be installed" | Open that test in the app once and run it there on that browser — the first run installs it — then retry from MCP |
| A test "was skipped: declares a secret variable" | Expected. Run it from the app. See §4 |
| Console/network logs come back withheld | Some test in your library declares a secret, so the rule applies library-wide. See §4 |
| A report says "no artifacts" | That run was not captured, or retention has pruned its directory. Re-run with capture on |
| `triage_run` or the step-health tools say the metrics database is missing | The app builds it. Open Good Looks! once |
| A test fails from MCP but passes in the app | Read the run's `fixtures` field. The usual causes are a missing crawler signature or an unauthenticated proxy, both of which fail further down as a timeout |
| `capture_app` fails | The app is not running, or *Debug screenshots* is off. Use the shortcut plus `get_screenshot` instead |

---

## See also

- [`mcp/README.md`](../mcp/README.md) — the full per-tool reference: every
  argument, every field, and the reasoning behind each tool's shape.
- [`docs/ROUTINES.md`](ROUTINES.md) — what a Routine is, which `list_routines`
  and `run_routine` operate on.
