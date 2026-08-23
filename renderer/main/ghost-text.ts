// Ghost text: an inline completion shown after the caret, accepted with Tab.
//
// A CodeMirror extension with no opinion about WHERE completions come from:
// the host hands in a source (`prefix`, `suffix`, an abort signal → text) or
// null when the feature is off, and the extension asks it once per pause in
// typing. The shape is deliberately the narrow one:
//
//   - one request in flight, aborted by the next keystroke or caret move;
//   - a response is shown only if the document and caret are where they were
//     when it was asked for (the doc's own identity is the version);
//   - Tab accepts, Escape dismisses, any edit clears — including an edit that
//     happens to type the ghost's first character, which re-asks rather than
//     guessing the completion still fits;
//   - nothing is asked in a read-only editor, with a non-empty selection, or
//     when the source is null.
//
// The host decides the rest: which model, how much of the file to send, how
// to back off from an offline server. See `renderer/lib/ghost-source.ts`.

import { EditorState, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from "@codemirror/view";

export type GhostSource = (prefix: string, suffix: string, signal: AbortSignal) => Promise<string>;

interface Ghost {
  text: string;
  /** Caret position the text belongs after. */
  at: number;
}

const setGhost = StateEffect.define<Ghost | null>();

export const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    // Any change to the document or the caret invalidates what was shown.
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
});

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "gl-ghost";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const ghostDecorations = EditorView.decorations.compute([ghostField], (state) => {
  const ghost = state.field(ghostField);
  if (!ghost) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.at)]);
});

/** Insert the shown completion at the caret. False when nothing is shown, so
 *  the key falls through to the next binding (Tab indents). */
export function acceptGhost(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  view.dispatch({
    changes: { from: ghost.at, insert: ghost.text },
    selection: { anchor: ghost.at + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: "input.complete",
  });
  return true;
}

export function dismissGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

/** The current ghost, for a test or a host that wants to know. */
export function ghostShown(state: EditorState): string | null {
  return state.field(ghostField, false)?.text ?? null;
}

function isTyping(tr: Transaction): boolean {
  return tr.isUserEvent("input") || tr.isUserEvent("delete");
}

export function ghostText(getSource: () => GhostSource | null, { debounceMs = 400 }: { debounceMs?: number } = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      inflight: AbortController | null = null;

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        // An accepted completion is itself a doc change; do not ask again
        // off the back of it, or the model gets an answer to its own answer.
        const accepted = update.transactions.some((tr) => tr.isUserEvent("input.complete"));
        if (update.docChanged || update.selectionSet) this.cancel();
        if (accepted) return;
        if (update.transactions.some(isTyping)) this.schedule();
      }

      cancel(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.inflight) this.inflight.abort();
        this.inflight = null;
      }

      schedule(): void {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.ask();
        }, debounceMs);
      }

      async ask(): Promise<void> {
        const source = getSource();
        const state = this.view.state;
        if (!source || state.readOnly || !state.selection.main.empty) return;
        const head = state.selection.main.head;
        const doc = state.doc;
        const controller = new AbortController();
        this.inflight = controller;
        let text = "";
        try {
          text = await source(doc.sliceString(0, head), doc.sliceString(head), controller.signal);
        } catch {
          text = "";
        }
        if (this.inflight === controller) this.inflight = null;
        if (controller.signal.aborted || !text) return;
        // Still the same document at the same caret? The doc object is
        // immutable, so identity is the cheapest exact version check.
        const now = this.view.state;
        if (now.doc !== doc || now.selection.main.head !== head || !now.selection.main.empty) return;
        this.view.dispatch({ effects: setGhost.of({ text, at: head }) });
      }

      destroy(): void {
        this.cancel();
      }
    },
  );

  return [
    ghostField,
    ghostDecorations,
    plugin,
    // Bound with the highest precedence so Tab reaches acceptGhost before
    // indentWithTab; the command returns false when nothing is shown, and the
    // key falls through to indent as before.
    keymap.of([
      { key: "Tab", run: acceptGhost },
      { key: "Escape", run: dismissGhost },
    ]),
  ];
}
