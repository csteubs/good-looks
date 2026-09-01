# Running tests without the app

Recorded tests do not need the app to run them. A command line ships inside
Good Looks!, and a GitHub Action wraps it, so the same tests you recorded on
your Mac can run on a build server and report a pass or a fail.

This guide covers the command line, the Action, and how to get the results back
into the app afterwards.

**This file is also part of the app's manual.** Settings → Documentation renders
it, so it is written to be read on screen.

---

## 1. Why run tests outside the app

The app is where you record a test, watch it run and read the result. That is
the wrong shape for a build server, which needs something that runs on its own,
prints a result and sets an exit code.

The command line is that. It reads the same test library the app reads, runs the
tests headlessly, and exits with a number your pipeline can act on.

Three things are worth knowing before you start.

- **It runs the same tests, the same way.** Screenshots, accessibility checks,
  console and network recording, Auto-Heal and standing overlay rules all work
  here, and each one follows the setting the test already carries. A run on a
  build server is not a lesser run.
- **It cannot read your secrets.** Secret variables, the Shopify crawler
  signature and a proxy password are encrypted to the app on your Mac. Nothing
  outside the app can decrypt them, so you supply secrets another way — see §6.
- **Its results stay on the machine that ran them.** A build server throws its
  disk away when the job ends. §8 covers carrying those runs back.

---

## 2. The command line

### Where it is

The app carries the command line inside it, so there is nothing to install. For
an app in `/Applications`, it is here:

```
/Applications/Good Looks!.app/Contents/Resources/app/bin/good-looks.mjs
```

The app's own binary runs it, which means you do not need Node installed:

```bash
ELECTRON_RUN_AS_NODE=1 '/Applications/Good Looks!.app/Contents/MacOS/Good Looks!' '/Applications/Good Looks!.app/Contents/Resources/app/bin/good-looks.mjs' run --all
```

Use **single** quotes. The app's name ends in an exclamation mark, and inside
double quotes a shell reads that as history expansion and refuses the command.

Working from a checkout of the project instead? Use Node directly:

```bash
node bin/good-looks.mjs run --all
```

### Which library it reads

The command line reads the same folder the app stores your tests in. To see
which one, ask it:

```bash
good-looks data-dir
```

That is its own command because "which library am I about to run?" is the first
question of nearly every build-server failure that turns out to be a
misconfigured runner.

Set `GOOD_LOOKS_USERDATA` to point it somewhere else — which is how a build
server points it at a library checked out beside the code.

### Getting a browser

Playwright's usual install puts browsers in a machine-wide cache, and runs here
do not look there. Install into the library's own browsers directory instead:

```bash
good-looks install chromium --with-deps
```

`--with-deps` also installs the system libraries the browser needs. That matters
on a Linux build image and means nothing on a Mac. The command does nothing if
the browser is already there, so it is safe to run every time.

---

## 3. Getting your tests onto the runner

The command line reads a library — the folder holding `recorder/`. On your own
machine that folder is the app's own store, and it holds far more than a run
needs: every run's history and log, every screenshot, the metrics database, your
saved login sessions, an LLM API key, an alerts webhook URL and the encrypted
store your secret values live in.

So do not copy it. `export` writes a bundle instead:

```bash
good-looks export --out ./test-library
```

That directory carries **`recorder/tests.json` and `recorder/scripts/`, and
nothing else**. It is exactly what the Action's `library` input wants, and it is
small enough and readable enough to commit.

Four things worth knowing about what comes out:

| | |
| --- | --- |
| Paths | No path from your machine travels. A test's spec is recorded at its position inside the bundle, so it resolves on whatever runner it lands on |
| Secrets | Values never travel — they are encrypted to the app and cannot be read anywhere else. Tests that declare one are still exported, and the command names them and the variables they want |
| Browsers | Not copied. They are hundreds of megabytes and platform-specific; run `good-looks install chromium` on the runner |
| Imported tests | An imported spec's whole folder comes with it, so its relative imports still resolve. A symlink is skipped rather than followed, and the command says so |

`--dry-run` reports what would be written without writing it. `--json` prints
the same summary for a script to read. Writing into a directory that already has
files in it needs `--force`.

The bundle is **one-way**. The app exports it; the app never reads one back. To
get a CI job's *results* into the app, see §8.

---

## 4. Choosing what to run

You must say what to run. There is no default, on purpose: a command that ran
your whole library because a flag was misspelt is worse than one that refuses.

| Selector | What it runs |
| --- | --- |
| `--id <id>` | One test. Repeat the flag for several, and they run in that order |
| `--tag <tag>` | Every visible test carrying that tag |
| `--group <folder>` | Every visible test in that library folder |
| `--all` | Every visible test |

Pick exactly one. The rest of the options are optional:

| Option | What it does |
| --- | --- |
| `--browser <name>` | `chromium`, `firefox` or `webkit`. Defaults to chromium |
| `--speed <name>` | `fast`, `medium`, `slow` or `crawl`, for this run only. Never written back to the test |
| `--parallel <n>` | Run n tests at once |
| `--retries <n>` | Re-run a failed test up to n times, 0 to 3. Defaults to 0 |
| `--all-datasets` | Run each test once per dataset row it declares |
| `--secrets-file <f>` | A JSON file of secret values. See §6 |
| `--junit <path>` | Also write a JUnit XML report of this run |
| `--dry-run` | Print what would run, and stop |
| `--json` | Print the result as JSON instead of a summary |

`--dry-run` does the real selection and the real queue expansion, so what it
prints is the actual plan rather than a description of one. It is the fastest
way to check a tag still matches what you think it does.

`--retries` is worth understanding before you reach for it. A test that fails
and then passes on a retry is recorded as **passed** — your pipeline goes green —
**and** counted as a failure by the app's flake analysis. Both are true at once,
deliberately: absorbing an intermittent failure on the runner should not also
hide it from the app, or you would have bought a green pipeline by losing the
only evidence that something is flaky.

A worked example — every test tagged `smoke`, two at a time, in Firefox, with a
report your pipeline can publish:

```bash
good-looks run --tag smoke --browser firefox --parallel 2 --junit results.xml
```

---

## 5. What the exit code means

Your pipeline reads one number. There are four, and the difference between them
is the difference between reading a log and not needing to.

| Code | Meaning |
| --- | --- |
| 0 | Every selected test passed |
| 1 | A test failed |
| 2 | The selector matched nothing |
| 3 | The run could not start |

**Code 2 is the one worth wiring up.** A run of zero tests looks exactly like a
clean pass: no failures, nothing red, pipeline green. Rename a tag from `smoke`
to `Smoke` and without its own exit code you would test nothing, forever, and
never be told. So it gets its own number.

**Code 3 means nothing ran and the cause is your setup**, not your tests — a
browser that is not installed, a library that is not there, an option that is
not usable. In most runners that is indistinguishable from a failing assertion,
which is why so much time gets spent reading logs to find out which happened.

---

## 6. Secrets and other values CI cannot read

A test that uses secret variables needs their values supplied, because the ones
you typed into the app are encrypted to the app and cannot be read anywhere
else.

The best way is an environment variable, one per test per secret:

```
GOOD_LOOKS_SECRET_<TEST ID>__<NAME>
```

The test id is upper-cased with anything that is not a letter or a digit turned
into an underscore. So the secret `password` on test `t-login` is
`GOOD_LOOKS_SECRET_T_LOGIN__PASSWORD`.

The name carries the test id because two tests can each have a secret called
`password` and mean completely different credentials. Handing one test's staging
password to another test's production login is a failure with no error message
at all — the run succeeds, against the wrong account.

Run once without setting anything and the command names the exact variables it
wants. You do not have to work them out.

`--secrets-file` takes a JSON object instead, keyed `"<test id>.<name>"` or just
`"<name>"`. An environment variable always wins over it. Prefer the environment:
a secrets file is a credential sitting in a workspace.

**A test whose secrets are missing is skipped, not failed.** One
credential-bearing test should not turn a whole suite red. It appears in the
JUnit report as skipped, with the reason. If *everything* skipped, the run exits
3 — a green pipeline that executed nothing is the outcome all of this exists to
prevent.

Whatever supplies a secret also feeds redaction, so a value you pass in cannot
come back out in the report or the logs.

**Two other values cannot travel either.** A Shopify crawler signature and a
proxy password are encrypted to the app the same way. A run that needed one says
so in its output rather than quietly going without.

---

## 7. GitHub Actions

The Action is the command line with a YAML wrapper. The shortest workflow that
works:

```yaml
name: Tests
on: [push, pull_request]

jobs:
  good-looks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: csteubs/good-looks@main
        with:
          library: ./test-library
          all: "true"
          junit: results.xml

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: junit
          path: results.xml
```

`library` is the only required input. Every other input has the same default the
command line has.

### What `library` points at

The folder holding `recorder/`. Two things it must carry:

- **`recorder/tests.json` and `recorder/scripts/`.** Nothing else is read. Run
  history, metrics and artifacts are things a run produces, not things it needs.
- **Nothing else.** Your app's own library folder holds a great deal more than
  that — see §3, and use `good-looks export` to produce one rather than
  copying it by hand.

How the library reaches the runner is deliberately not the Action's business.
Committing it, restoring it from a cache and downloading it as an artifact are
all reasonable, and they are different decisions for different teams.

A library copied from another machine works. The app stores each test's script
path as an absolute path from the machine that recorded it, and every process
that reads one re-resolves it against the library it is actually looking at.

### Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `library` | *required* | The directory holding `recorder/` |
| `id` | | One test id. Newline-separated for several, run in that order |
| `tag` | | Every visible test carrying this tag |
| `group` | | Every visible test in this library folder |
| `all` | `false` | Every visible test |
| `browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `speed` | | `fast`, `medium`, `slow` or `crawl`, for this run only |
| `parallel` | | How many tests to run at once |
| `retries` | `0` | Re-run a failed test up to this many times, 0 to 3 |
| `junit` | | Write a JUnit report here |
| `secrets-file` | | JSON of secret values. The environment wins over it |
| `install-deps` | `true` | Also install the browser's system libraries |
| `working-directory` | `.` | Where a relative `library` or `junit` resolves from |

Exactly one selector, same rule as the command line.

### Outputs, and acting on the exit code

The step fails on any non-zero code, and publishes the number as `exit-code` so
you can tell the failures apart:

```yaml
      - uses: csteubs/good-looks@main
        id: tests
        continue-on-error: true
        with:
          library: ./test-library
          tag: smoke

      - if: steps.tests.outputs.exit-code == '2'
        run: echo "::error::Nothing matched 'smoke' — has the tag been renamed?"
```

### Caching the browser

The Action installs the browser into the library's own directory, and does
nothing when it is already there. That makes the directory worth caching:

```yaml
      - uses: actions/cache@v4
        with:
          path: ./test-library/recorder/browsers
          key: gl-browsers-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
```

---

## 8. Bringing CI runs back into the app

A build server throws its disk away when the job ends, and the run history goes
with it. A suite running forty times a week can leave no trace in the app at
all — so Stability, the flake verdict and step health only ever see the handful
of runs you did by hand.

`ingest` fixes that. Upload the library directory as an artifact from the job,
download it, and point the command at it:

```bash
good-looks ingest ./downloaded-artifact
```

It accepts either the library directory or its `recorder/` directory. Add
`--dry-run` to see what it would take without writing anything, or `--json` for
a machine-readable summary.

Runs are matched by id, so ingesting the same directory twice is safe — the
second time takes nothing.

Ingested runs carry where they came from: the commit, the branch, the repository
and the job. That is read from the build environment while the job is running,
because it cannot be worked out afterwards.

Runs are also tagged with what started them. A run from the command line records
`cli`, whether it happened on a build server or in your own terminal.

An ingested run carries its retry marking too. CI is where `--retries` gets
used, so a run that recovered in a container is exactly the run this command
brings back — and without the marking it would arrive in the app looking like a
clean pass.

### Auto-Heal events come back with the runs

If Auto-Heal got a step past a stale locator on the build server, that heal is
carried in too. It arrives in the Heals view awaiting review, exactly as a heal
from a run you started yourself does, with the locator it replaced kept as the
undo.

This matters more than it sounds. A heal is the app noticing that the site
moved, and CI is where most runs happen — so without this the runs that meet a
site most often were the ones teaching the app least about it. Their heals also
feed the fixes the app proposes for **other tests** on the same site, which is
the feature that saves you fixing eight tests by hand after one release.

Two things they never do. An ingested heal is never marked as applied: nothing
on your machine changed, so there is no rewrite to undo — only a suggestion to
read. And they dedupe per run and step, so ingesting the same artifact twice
adds nothing, while the same step healing on Monday and again on Tuesday shows
up as the two events it was.

---

## 9. When a CI run goes wrong

| Symptom | What it means |
| --- | --- |
| Exit code 2 and no tests ran | The selector matched nothing. Check the tag or folder name, and try `--dry-run` |
| Exit code 3 | Nothing ran, and the cause is the setup. Usually a missing browser — run `good-looks install <browser>` first |
| "Requires the chosen browser to be installed" | Same thing. Install it into the library's own browsers directory, not with `npx playwright install` |
| A test was skipped for a secret variable | Expected. Set the environment variable the output names. See §6 |
| Everything skipped, exit code 3 | No secrets reached the run at all. Check the variables are set on the right step |
| The run cannot find the library | Check `good-looks data-dir`, and set `GOOD_LOOKS_USERDATA` if it is pointing at the wrong place |
| A test fails here but passes in the app | Check the run's own notes on what it could not do. A missing crawler signature or an unauthenticated proxy both fail further down as a timeout, which reads like flakiness |
| A test that passed is called flaky | It passed on a retry. That is the rule rather than a fault — see §4 |
| Runs never appear in Stats | They are still on the build server. See §8 |

---

## Where to read more

- [`docs/GITHUB-ACTION.md`](GITHUB-ACTION.md) — the Action's full reference.
- The MCP guide, in the topics beside this one — running tests from an AI
  assistant, which reads the same library.
