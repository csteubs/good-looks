# Running your suite in GitHub Actions

The `good-looks` action runs a recorded library headlessly on a runner and
reports the result on the CLI's own exit contract. It is the outbound half of
the CI story: the app records, the runner runs, and nothing needs a laptop in
the loop.

## The shortest workflow that works

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

`library` is the only required input. Everything else has the same default the
CLI has.

## What `library` points at

The directory holding `recorder/` — the same thing `GOOD_LOOKS_USERDATA`
overrides locally, and the action sets that variable from it.

**How a library reaches a runner is not this action's business, on purpose.**
Committing it to the repository, restoring it from a cache and downloading it as
an artifact are all reasonable, and they are different decisions for different
teams. An action that guessed would be an action that guessed wrong.

Two things that library must carry:

- **`recorder/tests.json` and `recorder/scripts/`.** Nothing else is read. Run
  history, metrics and artifacts are outputs, not inputs.
- **Nothing else.** In particular, do not commit `recorder/recorder-settings.json`
  if it holds a GitHub token, and do not expect secrets to travel: their values
  are encrypted to the app and unreadable anywhere else. Supply those through the
  environment instead (below).

A library copied from another machine is a supported case and a tested one — the
self-test builds one whose `scriptPath` is another machine's absolute path,
because that is what a copy carries.

## Exit codes

The action fails the step on any non-zero code and publishes the number as the
`exit-code` output, so a caller can tell the failures apart.

| Code | Meaning |
| --- | --- |
| 0 | Every selected test passed |
| 1 | A test failed |
| 2 | The selector matched nothing |
| 3 | The run could not start |

**2 is the one that matters.** A suite of zero is shaped exactly like a clean
pass, so without its own code a renamed tag leaves a pipeline green while
testing nothing.

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

## Secrets

A test that declares secret variables needs their values supplied. Prefer the
environment: a `--secrets-file` is a credential file in a workspace.

```yaml
      - uses: csteubs/good-looks@main
        env:
          GOOD_LOOKS_SECRET_T_LOGIN__PASSWORD: ${{ secrets.TEST_PASSWORD }}
        with:
          library: ./test-library
          id: t-login
```

The variable name carries the **test id** because two tests can each declare
`PASSWORD` and mean different credentials. Run once without it and the CLI names
the variables to set.

A test whose secrets are missing is **skipped**, not failed — one
credential-bearing test should not redden a whole suite — and it appears in the
JUnit report as `<skipped>` with the reason. A suite in which *everything*
skipped exits 3, because a green pipeline that executed nothing is the failure
this is all here to avoid.

Whatever supplies a secret also feeds the redaction, so a value you pass in
cannot come back out in the report.

## Caching the browser

The action installs the engine into the library's own directory, because
Playwright's machine-wide cache is somewhere no run here looks. It is a no-op
when the engine is already there, which makes the directory worth caching:

```yaml
      - uses: actions/cache@v4
        with:
          path: ./test-library/recorder/browsers
          key: gl-browsers-${{ runner.os }}-${{ hashFiles('**/package-lock.json') }}
```

## Inputs

| Input | Default | |
| --- | --- | --- |
| `library` | *required* | Directory holding `recorder/` |
| `id` | | One test id; newline-separated for several, run in the order given |
| `tag` | | Every visible test carrying this tag |
| `group` | | Every visible test in this library folder |
| `all` | `false` | Every visible test |
| `browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `speed` | | `fast`, `medium`, `slow`, `crawl` — this run only, never written back |
| `parallel` | | How many tests at once |
| `junit` | | Write a JUnit report of this run here |
| `secrets-file` | | JSON of secret values; the environment wins over it |
| `install-deps` | `true` | `--with-deps` when installing the browser |
| `working-directory` | `.` | Where a relative `library` or `junit` resolves from |

**Exactly one selector**, and there is no default: a CLI that runs the whole
library when a flag is misspelt is worse than one that refuses.

## Outputs

| Output | |
| --- | --- |
| `exit-code` | The run's own code, published even when the step fails |
| `junit` | Absolute path of the report, when one was asked for |

## What the report says

`--junit` writes the runs **that invocation** produced, and nothing else. That
scope is a security boundary rather than a convenience: this process can only
redact with the secret values it was given, and a run the app produced took its
secrets from a store no runner can open.

A failing test's message names the step it failed at rather than only the exit
code:

```xml
<failure message="Failed at step 2 of 2 · exit 1" type="failure"/>
```

by index rather than by label, because the phrasing lives app-side and two
spellings of one step is a drift this codebase has paid for before.

## What the run history records about the job

Every run this action performs writes a record into the library it was pointed
at — the same `run-history.json` the app reads. Two fields say where that run
came from, and both matter once results are carried back to a machine that was
not there:

- **`trigger: "cli"`.** Which entry point started it. Not `manual`, which means
  a person in the app, and no longer `mcp`, which is what every CLI run was
  recorded as until this was fixed.
- **`provenance`** — the commit, branch, repository and job URL. Read straight
  out of the environment GitHub Actions already sets, so a workflow needs to
  pass nothing:

  ```
  revision       GITHUB_SHA
  branch         GITHUB_HEAD_REF on a pull request, else GITHUB_REF_NAME
  repositoryUrl  GITHUB_SERVER_URL + GITHUB_REPOSITORY
  jobUrl         …/actions/runs/GITHUB_RUN_ID
  ```

  Two of those repay a second look, because both look wrong at a glance and
  are not. On a **pull request**, `GITHUB_SHA` is the sha of the MERGE commit
  GitHub built for the run, not of your branch's head — so the revision on the
  record will be a commit you cannot find in your branch, and it is the honest
  answer, because the merge commit is what the tests actually ran against.
  `GITHUB_REF_NAME` on that same event is `123/merge`, naming no branch anyone
  can check out, which is why the branch comes from `GITHUB_HEAD_REF` instead.

On another CI, or to correct a value your provider reports uselessly, set any of
these instead — they win per field, so you can override one and leave the rest:

```yaml
env:
  GOOD_LOOKS_REVISION: ${{ env.CI_COMMIT_SHA }}
  GOOD_LOOKS_BRANCH: release/2026-08
  GOOD_LOOKS_REPOSITORY_URL: https://gitlab.example.com/team/app
  GOOD_LOOKS_JOB_URL: https://gitlab.example.com/team/app/-/jobs/99
```

A field the runner cannot vouch for is **left out rather than repaired**. An
over-long value is dropped, not truncated — a cut commit sha is a plausible sha
for a different commit, while an absent one is honestly unknown. The four fields
are judged independently, so a branch name your fork's contributor chose cannot
cost the run its revision. Outside CI, where nothing answers, there is no
`provenance` at all rather than a guess.

## Getting the results back

The runner's library is deleted with the container, so every run it recorded is
gone unless you take it with you. Upload it, then ingest it locally:

```yaml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: good-looks-runs
          path: test-library/recorder/run-history.json
          # add test-library/recorder/logs/ to carry the raw logs too
```

```bash
good-looks ingest ./good-looks-runs      # after unzipping the artifact
```

Runs are matched by id, so ingesting the same directory twice is safe and
ingests nothing the second time. `--dry-run` reports without writing.

Ingested runs count towards Stability, the flake verdict and step health, which
is the point — those surfaces are useless if they only see the runs somebody
started by hand. They are marked `ingestedAt`, so the cost and duration readouts
can leave them out: those numbers only mean something relative to the hardware
that produced them.

Two things do not travel. Playwright **traces** are not carried, so an ingested
run offers no Open Trace. And a run's **log** is only carried if you uploaded
`recorder/logs/` as well; without it the run still lands, since its outcome and
timing are what the flake verdict reads.
