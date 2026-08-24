// The script editor's keymap presets, as DATA.
//
// A preset is a table of (command, key) pairs — code in the repo, so a preset
// is reviewed, tested and documented like any other change, and Settings →
// Editor can list exactly what each key does. Two chords are never bound:
// ⌘K, which is the app's command palette everywhere including inside a field,
// and ⌘I, which is the editor's inline AI (bound in the host so it can reach
// the host's callback).
//
// WHY THE TABLE IS NOT IN `editor-keymaps.ts` WITH THE BINDINGS. The Settings
// Editor pane lists every binding — a label and a key cap per row — and it used
// to get that list from the module that also maps each command to CodeMirror's
// handler. That module imports `@codemirror/commands`, `/language`, `/search`
// and `/view` at module scope, so a pane rendering a static table pulled the
// whole editor in behind it.
//
// It cost nothing while Settings was its own BrowserWindow and its own entry
// chunk. The moment Settings became a route in the main window
// (docs/plans/settings-view.md), that import was in the main window's entry
// graph — and `check:script-ide-layout` went red, because CodeMirror is loaded
// ON DEMAND (`script-view.tsx` reaches it through `React.lazy`) precisely so
// that opening the app does not pay for an editor nobody has opened.
//
// So the split is not tidiness: the labels and the key strings are the half a
// settings table needs, and the handlers are the half only the editor needs.
// `editor-keymaps.ts` re-exports everything here, so a caller that wants both
// still has one import.

export type EditorKeymap = "default" | "jetbrains" | "vscode";
export const EDITOR_KEYMAPS: EditorKeymap[] = ["default", "jetbrains", "vscode"];
export const EDITOR_KEYMAP_LABELS: Record<EditorKeymap, string> = {
  default: "Default",
  jetbrains: "JetBrains",
  vscode: "VS Code",
};

export interface KeyRow {
  /** Which command this row is. The key `editor-keymaps.ts` looks the
   *  CodeMirror handler up by — the one thing this module deliberately does not
   *  know. */
  command: EditorCommand;
  /** What the key does, in the words the overlay shows. */
  label: string;
  /** CodeMirror key name ("Mod-/", "Shift-Alt-ArrowDown"). */
  key: string;
}

/** The commands every preset binds somewhere, and what each is CALLED.
 *
 *  The label and the handler used to sit in one object literal. They are split
 *  because the settings Editor pane wants only the labels — see the header. */
export const COMMAND_LABELS = {
  comment: "Toggle line comment",
  moveUp: "Move line up",
  moveDown: "Move line down",
  copyUp: "Copy line up",
  copyDown: "Duplicate line",
  deleteLine: "Delete line",
  selectLine: "Select line",
  nextOccurrence: "Add next occurrence to selection",
  gotoLine: "Go to line",
  find: "Find",
  fold: "Fold step",
  unfold: "Unfold step",
  foldAll: "Fold all steps",
  unfoldAll: "Unfold all steps",
  indent: "Indent",
  outdent: "Outdent",
  bracket: "Go to matching bracket",
  expand: "Expand selection",
} as const;

export type EditorCommand = keyof typeof COMMAND_LABELS;

const PRESETS: Record<EditorKeymap, Partial<Record<EditorCommand, string>>> = {
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
  return (Object.keys(COMMAND_LABELS) as EditorCommand[])
    .filter((c) => table[c])
    .map((c) => ({ command: c, label: COMMAND_LABELS[c], key: table[c]! }));
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
