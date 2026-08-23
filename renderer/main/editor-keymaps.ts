// Keymap presets for the script editor: Default (CodeMirror's own, plus the
// handful of editing commands every editor has), JetBrains, and VS Code.
//
// A preset is a TABLE of (command, key) pairs over CodeMirror's commands —
// code in the repo, so a preset is reviewed, tested and documented like any
// other change, and Settings → Editor can list exactly what each key does.
// Two chords are never bound here: ⌘K, which is the app's command palette
// everywhere including inside a field, and ⌘I, which is the editor's inline
// AI (bound in the host so it can reach the host's callback).

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

export type EditorKeymap = "default" | "jetbrains" | "vscode";
export const EDITOR_KEYMAPS: EditorKeymap[] = ["default", "jetbrains", "vscode"];
export const EDITOR_KEYMAP_LABELS: Record<EditorKeymap, string> = {
  default: "Default",
  jetbrains: "JetBrains",
  vscode: "VS Code",
};

export interface KeyRow {
  /** What the key does, in the words the overlay shows. */
  label: string;
  /** CodeMirror key name ("Mod-/", "Shift-Alt-ArrowDown"). */
  key: string;
  run: KeyBinding["run"];
}

/** The commands every preset binds somewhere. */
const COMMANDS = {
  comment: { label: "Toggle line comment", run: toggleComment },
  moveUp: { label: "Move line up", run: moveLineUp },
  moveDown: { label: "Move line down", run: moveLineDown },
  copyUp: { label: "Copy line up", run: copyLineUp },
  copyDown: { label: "Duplicate line", run: copyLineDown },
  deleteLine: { label: "Delete line", run: deleteLine },
  selectLine: { label: "Select line", run: selectLine },
  nextOccurrence: { label: "Add next occurrence to selection", run: selectNextOccurrence },
  gotoLine: { label: "Go to line", run: gotoLine },
  find: { label: "Find", run: openSearchPanel },
  fold: { label: "Fold step", run: foldCode },
  unfold: { label: "Unfold step", run: unfoldCode },
  foldAll: { label: "Fold all steps", run: foldAll },
  unfoldAll: { label: "Unfold all steps", run: unfoldAll },
  indent: { label: "Indent", run: indentMore },
  outdent: { label: "Outdent", run: indentLess },
  bracket: { label: "Go to matching bracket", run: cursorMatchingBracket },
  expand: { label: "Expand selection", run: selectParentSyntax },
} as const;

type Command = keyof typeof COMMANDS;

const PRESETS: Record<EditorKeymap, Partial<Record<Command, string>>> = {
  default: {
    comment: "Mod-/",
    moveUp: "Alt-ArrowUp",
    moveDown: "Alt-ArrowDown",
    copyUp: "Shift-Alt-ArrowUp",
    copyDown: "Shift-Alt-ArrowDown",
    deleteLine: "Shift-Mod-k",
    selectLine: "Mod-l",
    nextOccurrence: "Mod-d",
    gotoLine: "Ctrl-g",
    find: "Mod-f",
    fold: "Mod-Alt-[",
    unfold: "Mod-Alt-]",
    foldAll: "Ctrl-Alt-[",
    unfoldAll: "Ctrl-Alt-]",
    indent: "Mod-]",
    outdent: "Mod-[",
    bracket: "Shift-Mod-\\",
    expand: "Ctrl-Shift-ArrowUp",
  },
  vscode: {
    comment: "Mod-/",
    moveUp: "Alt-ArrowUp",
    moveDown: "Alt-ArrowDown",
    copyUp: "Shift-Alt-ArrowUp",
    copyDown: "Shift-Alt-ArrowDown",
    deleteLine: "Shift-Mod-k",
    selectLine: "Mod-l",
    nextOccurrence: "Mod-d",
    gotoLine: "Ctrl-g",
    find: "Mod-f",
    fold: "Mod-Alt-[",
    unfold: "Mod-Alt-]",
    foldAll: "Mod-k Mod-0",
    unfoldAll: "Mod-k Mod-j",
    indent: "Mod-]",
    outdent: "Mod-[",
    bracket: "Shift-Mod-\\",
    expand: "Ctrl-Shift-ArrowRight",
  },
  jetbrains: {
    comment: "Mod-/",
    moveUp: "Shift-Alt-ArrowUp",
    moveDown: "Shift-Alt-ArrowDown",
    copyDown: "Mod-d",
    deleteLine: "Mod-Backspace",
    nextOccurrence: "Ctrl-g",
    gotoLine: "Mod-l",
    find: "Mod-f",
    fold: "Mod--",
    unfold: "Mod-=",
    foldAll: "Shift-Mod--",
    unfoldAll: "Shift-Mod-=",
    indent: "Tab",
    outdent: "Shift-Tab",
    bracket: "Shift-Mod-m",
    expand: "Alt-ArrowUp",
  },
};

/** The preset's rows, in table order. */
export function rowsFor(preset: EditorKeymap): KeyRow[] {
  const table = PRESETS[preset] ?? PRESETS.default;
  return (Object.keys(COMMANDS) as Command[])
    .filter((c) => table[c])
    .map((c) => ({ label: COMMANDS[c].label, key: table[c]!, run: COMMANDS[c].run }));
}

/** The preset as CodeMirror bindings. `Tab` in the JetBrains table is
 *  left to the host (it binds Tab for ghost text and indentation). */
export function keymapFor(preset: EditorKeymap): KeyBinding[] {
  return rowsFor(preset)
    .filter((r) => r.key !== "Tab" && r.key !== "Shift-Tab")
    .map((r) => ({ key: r.key, run: r.run }));
}

/** "Mod-/" → "⌘ /" on a Mac, "Ctrl /" elsewhere — for the overlay. */
export function prettyKey(key: string, mac: boolean = typeof navigator !== "undefined" && /Mac/.test(navigator.platform)): string {
  return key
    .split(" ")
    .map((chord) =>
      chord
        .split("-")
        .map((part) => {
          switch (part) {
            case "Mod":
              return mac ? "⌘" : "Ctrl";
            case "Ctrl":
              return mac ? "⌃" : "Ctrl";
            case "Alt":
              return mac ? "⌥" : "Alt";
            case "Shift":
              return mac ? "⇧" : "Shift";
            case "ArrowUp":
              return "↑";
            case "ArrowDown":
              return "↓";
            case "ArrowLeft":
              return "←";
            case "ArrowRight":
              return "→";
            case "Backspace":
              return "⌫";
            case "":
              return "-";
            default:
              return part.length === 1 ? part.toUpperCase() : part;
          }
        })
        .join(mac ? "" : "+"),
    )
    .join(" ");
}
