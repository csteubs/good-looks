// Standalone regression check for the composed dialog's CLOSE contract.
//
// The bug (docs/issue-audit/fix-137.md, reproduced 2026-08-17): `DialogActions`'
// confirm button calls `onConfirm()` and nothing else — it never calls
// `onOpenChange(false)`. Every caller was written against an auto-close that
// does not exist in this tree, so confirming "Start recording" or "Import" left
// the modal, and its full-viewport Radix overlay, sitting over the main window
// pointer-blocking everything behind it.
//
// Why it kept looking fixed: whether the stuck dialog is VISIBLE depends on who
// mounted it. `RootShell` swaps only the OUTLET while recording
// (`root-view.tsx`), so the Home-view copy is unmounted by the swap and the bug
// disappears — while the library rail's `+` and the ⌘K palette mount theirs
// OUTSIDE the outlet and keep them for the whole session. The one path most
// people test is the one path that hides it.
//
// Restoring a global auto-close is NOT the fix: `IssueComposeDialog`
// deliberately swallows its own errors and must stay open on a resolved
// confirm. So callers close themselves, and this check is what keeps that
// distributed decision honest — it enumerates the dialogs that start something
// outliving themselves from OUTSIDE the outlet, and asserts each one closes.
//
// Source-level because the property is about WHICH FILES exist and what they
// contain: a unit test can only pin a dialog somebody remembered to write a
// test for, and the failure here is the one nobody remembered. The per-dialog
// behaviour is covered by `new-recording-dialog.test.tsx` and
// `import-git-dialog.test.tsx`; the contract itself by `dialog-actions.test.tsx`;
// the real overlay by `e2e/dialog-lifecycle.spec.ts`.
//
// Run with: npm run check:dialog-close

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    failures++;
    console.error(`FAIL ${label}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");

/** The body of a top-level exported function, by name. Crude on purpose: the
 *  alternative is parsing TSX, and the shapes here are stable. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}(`);
  if (start === -1) return "";
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const overlays = read("../../../renderer/ui/overlays.tsx");

// ── 1. The contract: the composed Dialog does not close itself ────────────
//
// Pinned so it cannot drift unnoticed in EITHER direction. If a future change
// makes the dialog self-close, this check goes red and section 2's per-caller
// requirement has to be revisited in the same commit rather than left as dead
// belt-and-braces that hides which mechanism is actually doing the work.
{
  const actions = bodyOf(overlays, "DialogActions");
  assert(actions !== "", "overlays.tsx: exports DialogActions");

  assert(
    !/DialogPrimitive\.Close/.test(actions),
    "overlays.tsx: DialogActions' confirm is NOT wrapped in DialogPrimitive.Close — if this changes, the per-caller closes below become redundant and IssueComposeDialog's stay-open-on-error behaviour breaks",
  );

  const dialog = bodyOf(overlays, "Dialog");
  assert(dialog !== "", "overlays.tsx: exports the composed Dialog");
  assert(
    !/onOpenChange\?\.\(false\)|onOpenChange\(false\)/.test(dialog),
    "overlays.tsx: the composed Dialog contains no self-close on confirm — callers close themselves (see dialog-actions.test.tsx)",
  );
}

// ── 2. The callers that MUST close themselves ─────────────────────────────
//
// Only dialogs whose confirm starts something that outlives them, and which are
// mounted outside the outlet swap. A dialog that merely edits a field is not
// listed: nothing about it survives a close it forgot to make.
const MUST_CLOSE: { file: string; label: string }[] = [
  {
    file: "../../../renderer/main/new-recording-dialog.tsx",
    label: "new-recording-dialog.tsx (mounted by the library rail's + menu AND the ⌘K palette, both outside the outlet)",
  },
  {
    file: "../../../renderer/main/import-git-dialog.tsx",
    label: "import-git-dialog.tsx (mounted by the library rail's + menu, outside the outlet)",
  },
];

for (const { file, label } of MUST_CLOSE) {
  const source = read(file);
  assert(
    /onOpenChange\(false\)/.test(source),
    `${label}: closes itself once its confirm succeeds — the composed Dialog will not`,
  );
  // The stale claim that started this. A comment asserting a semantic the tree
  // does not have is worse than no comment: it is what stopped the next reader
  // from checking.
  assert(
    !/see Dialog semantics/.test(source),
    `${label}: carries no "see Dialog semantics" claim — those semantics were lost in the SDK port and do not exist here`,
  );
}

// The third case, INSIDE the outlet: the swap hides the omission today, so this
// one is listed separately rather than dropped. Its close is what keeps the
// dialog correct if the swap ever stops unmounting it.
{
  const detail = read("../../../renderer/main/test-detail-view.tsx");
  const closes = detail.match(/setTrainerConfirmOpen\(false\)/g)?.length ?? 0;
  assert(
    closes >= 2,
    `test-detail-view.tsx: the "Edit in Trainer" confirm closes on BOTH paths (Save & continue and Continue without saving) — found ${closes} of 2`,
  );
}

// ── 3. The swap shape that makes section 2's enumeration correct ──────────
//
// The list above is only right while `RootShell` swaps the OUTLET and nothing
// more. If the swap ever grew to replace the sidebar or the whole shell, the
// rail's dialogs would be unmounted too and the reasoning here would be stale.
{
  const root = read("../../../renderer/main/root-view.tsx");
  assert(
    /state\.recording \? <RecordingView \/> : <Outlet \/>/.test(root),
    "root-view.tsx: recording swaps the OUTLET only — the sidebar and its dialogs stay mounted, which is why the rail's dialogs must close themselves",
  );
  assert(
    /sidebar=\{<LibrarySidebar \/>\}/.test(root),
    "root-view.tsx: LibrarySidebar is rendered as the shell's sidebar, outside the swapped outlet",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll dialog-close checks passed");
