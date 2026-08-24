// Keymap presets for the script editor, bound to CodeMirror's commands.
//
// The TABLE — which command each preset binds to which key, and what each
// command is called — lives in `renderer/lib/editor-keymap-table.ts` and is
// CodeMirror-free. This file is the other half: the map from a command name to
// the handler that runs it, and the `KeyBinding[]` the editor is configured
// with. See the table's header for why the two are separate files; the short
// version is that Settings → Editor lists every binding and has no business
// loading an editor to do it.
//
// Everything the table exports is re-exported here, so a caller that wants the
// labels AND the bindings still has one import.

import {
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectLine,
  selectParentSyntax,
  toggleComment,
} from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll, unfoldCode } from "@codemirror/language";
import { gotoLine, openSearchPanel, selectNextOccurrence } from "@codemirror/search";
import type { KeyBinding } from "@codemirror/view";

import { COMMAND_LABELS, rowsFor } from "../lib/editor-keymap-table";
import type { EditorCommand, EditorKeymap } from "../lib/editor-keymap-table";

export {
  COMMAND_LABELS,
  EDITOR_KEYMAPS,
  EDITOR_KEYMAP_LABELS,
  prettyKey,
  rowsFor,
} from "../lib/editor-keymap-table";
export type { EditorCommand, EditorKeymap, KeyRow } from "../lib/editor-keymap-table";

/** What each command DOES. Keyed by the same names the table is, and typed
 *  against it — so a command added to one and forgotten in the other is a
 *  compile error rather than a key that silently does nothing. */
const RUN: Record<EditorCommand, KeyBinding["run"]> = {
  comment: toggleComment,
  moveUp: moveLineUp,
  moveDown: moveLineDown,
  copyUp: copyLineUp,
  copyDown: copyLineDown,
  deleteLine,
  selectLine,
  nextOccurrence: selectNextOccurrence,
  gotoLine,
  find: openSearchPanel,
  fold: foldCode,
  unfold: unfoldCode,
  foldAll,
  unfoldAll,
  indent: indentMore,
  outdent: indentLess,
  bracket: cursorMatchingBracket,
  expand: selectParentSyntax,
};

// Read once at module scope so the two halves cannot drift silently: if the
// table grows a command this file has no handler for, `RUN` above stops
// satisfying `Record<EditorCommand, …>` and type-check says so.
void COMMAND_LABELS;

/** The preset as CodeMirror bindings. `Tab` in the JetBrains table is
 *  left to the host (it binds Tab for ghost text and indentation). */
export function keymapFor(preset: EditorKeymap): KeyBinding[] {
  return rowsFor(preset)
    .filter((r) => r.key !== "Tab" && r.key !== "Shift-Tab")
    .map((r) => ({ key: r.key, run: RUN[r.command] }));
}
