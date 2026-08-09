## What changed

<!-- One or two sentences. What does this do that the app did not do before? -->

## Why

<!-- The problem being solved. Link an issue if there is one. -->

## Local gate

CI cannot run these — `@glaze/core` lives outside the repo, in the Glaze.app SDK
install. Run them locally and tick the box:

```bash
npm run lint && npm run type-check && npm run test:all && npm run build
```

- [ ] `lint`, `type-check`, `test:all` and `build` all pass

## Verified in the app

The Glaze app is the only thing that can build the native shell and show the UI,
so this cannot be delegated to a test or a CI run.

- [ ] Rebuilt and launched from the Glaze app, and the change behaves as intended
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
