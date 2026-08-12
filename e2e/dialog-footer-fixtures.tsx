// Server-renders the REAL dialog action row for `dialog-footer.spec.ts`, and
// prints it as JSON on stdout.
//
// Why this is a separate process rather than an import. Playwright compiles the
// TSX it loads with its OWN JSX runtime — component-testing elements tagged
// `__pw_type` — so `renderToStaticMarkup(<DialogActions/>)` inside a spec dies
// with "Objects are not valid as a React child". Running it under `tsx`, which
// uses the project's `jsx: react-jsx`, is what keeps the fixture the real
// component instead of markup hand-copied into a spec (which would pass while
// the real footer overflowed — the exact failure this whole test is about).
//
// Not a `*.spec.ts`, so Playwright's default testMatch never collects it.
//
// Run it directly to see what the spec measures:
//   npx tsx e2e/dialog-footer-fixtures.tsx

import { renderToStaticMarkup } from "react-dom/server";

import { DialogActions, dialogPanelClass } from "../renderer/ui/overlays";

const noop = () => {};

const fixtures = {
  /** The panel the footer sits in, so the spec never hand-copies its geometry. */
  panelClass: dialogPanelClass,

  /** The worst case that shipped, with Cancel put back — the "or any other
   *  button" case. The footer is allowed to grow a button; it just has to spend
   *  a second row on it rather than the page behind it. */
  withCancel: renderToStaticMarkup(
    <DialogActions
      onConfirm={noop}
      confirmLabel="Save & Exit"
      confirmVariant="accent"
      destructiveAction={{ label: "Discard Edits", onClick: noop }}
      secondaryAction={{ label: "Cancel", onClick: noop }}
    />,
  ),

  /** What the trainer's exit dialog actually renders now. */
  shipped: renderToStaticMarkup(
    <DialogActions
      onConfirm={noop}
      confirmLabel="Save & Exit"
      confirmVariant="accent"
      destructiveAction={{ label: "Discard Edits", onClick: noop }}
    />,
  ),
};

process.stdout.write(JSON.stringify(fixtures));
