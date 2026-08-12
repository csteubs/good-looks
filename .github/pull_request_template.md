## What changed

<!-- One or two sentences. What does this do that the app did not do before? -->

## Why

<!-- The problem being solved. Link an issue if there is one. -->

## Local gate

`.github/workflows/gate.yml` runs `lint`, `type-check`, `test:all` and `build`
on a hosted runner, plus the Playwright end-to-end run, the browser-preview
build and an `electron-builder` package. Every dependency now comes from
`npm install`, so a green gate is real evidence about this change — which it
never was while `@glaze/core` resolved to an SDK install no runner has.

So this box is no longer the only thing standing between the branch and `main`.
It is the fast feedback loop: the same four commands, answering in a minute
instead of waiting on a full pipeline.

```bash
npm run lint && npm run type-check && npm run test:all && npm run build
```

- [ ] `lint`, `type-check`, `test:all` and `build` all pass locally
- [ ] Not run locally — leaving it to `gate.yml`

## Verified in the app

CI builds the app and packages it. It cannot tell you the change looks right, so
this is the one box no runner can tick for you.

```bash
npm run dev        # Vite + the real Electron shell, renderer hot-reloads
npm run dev:web    # the whole renderer in a browser tab, against fixtures
npm run package    # the real bundle, dist/mac-arm64/Good Looks!.app
```

`dev:web` is the fastest way to see a UI change, and the only one an agent can
drive — but it has no backend, so it cannot catch a broken IPC handler, a window
that fails to open, or native menu behaviour. Anything reaching those wants the
real app. And check the main log while you are there: a renderer that throws
during mount shows a blank window and an otherwise *clean* log.

- [ ] Ran it (`npm run dev`, or `npm run package` for the real bundle) and the change behaves as intended
- [ ] Browser preview only (`npm run dev:web`) — this change cannot reach the shell, the backend or native menus
- [ ] Not applicable — no user-visible behaviour changed

## Docs

`docs/ARCHITECTURE.md` and `docs/DECISIONS.md` are hand-maintained. They stay
accurate only if changes carry them.

- [ ] `docs/ARCHITECTURE.md` updated — this adds a service, moves a boundary, or invalidates an entry
- [ ] `docs/DECISIONS.md` entry added — this involved a trade-off, a rejected alternative, or a non-obvious constraint
- [ ] Neither needed — routine change, the commit message carries it

## Tests

- [ ] New or updated tests cover this change
- [ ] I confirmed a new test **fails** without the fix (revert it, watch it go red)
- [ ] Not applicable — explain below

<!-- If this touches the AI debug feature, ai-debug-icons.test.tsx must be
     extended: a wrong status-icon colour is silent and nothing else catches it. -->

## Boundaries touched

Tick anything this change reaches, and say how it stays safe:

- [ ] **Capture boundary** — page input reaching `normalizeRawStep` /
      `normalizeStep` / `normalizePickedElement`, or reaching `script-generator.ts`.
      Page-controlled values become executed Node code; normalizers rebuild
      rather than filter, and generated source uses `num()` / `q()`, never
      direct interpolation.
- [ ] **Import sandbox** — `copyRelativeImports` and friends. Both the
      `projectRoot` read bound and the `destRoot` write bound are still asserted,
      on realpaths, on both sides.
- [ ] **Branch switcher** — anything reaching `shared/branch-paths.mjs`,
      `scripts/switch-branch.mjs` or `branch-switcher.ts`. A branch name comes
      from a PR head ref and becomes both a git argument and a directory that
      gets built and executed: the leading-`-` refusal and the containment throw
      are both still there, there is still only ONE copy of the validator, and
      nothing writes into the user's own checkout.
- [ ] None of these.
