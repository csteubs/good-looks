// Ghost text against a real EditorView in jsdom: what is asked, when, and
// what Tab and Escape do with the answer. The source is a stub; nothing here
// talks to a model.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";

import { ghostText, ghostShown, type GhostSource } from "./ghost-text";

type Deferred = { resolve: (t: string) => void; reject: (e: unknown) => void; signal: AbortSignal; prefix: string; suffix: string };

function harness(opts: { doc?: string; source?: GhostSource | null; readOnly?: boolean } = {}) {
  const calls: Deferred[] = [];
  let current: GhostSource | null =
    opts.source === undefined
      ? (prefix, suffix, signal) =>
          new Promise<string>((resolve, reject) => {
            calls.push({ resolve, reject, signal, prefix, suffix });
          })
      : opts.source;
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: opts.doc ?? "const a = 1;\n",
      extensions: [
        ghostText(() => current, { debounceMs: 400 }),
        keymap.of([indentWithTab]),
        EditorState.readOnly.of(opts.readOnly ?? false),
      ],
    }),
    parent,
  });
  const type = (text: string) => {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: text }, selection: { anchor: head + text.length }, userEvent: "input.type" });
  };
  const key = (k: string) => view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  return {
    view,
    calls,
    type,
    key,
    setSource: (s: GhostSource | null) => {
      current = s;
    },
    ghostEl: () => parent.querySelector(".gl-ghost"),
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ghostText", () => {
  it("asks once after a pause, split at the caret, and shows the answer after the caret", async () => {
    const h = harness({ doc: "ab\ncd" });
    h.view.dispatch({ selection: { anchor: 2 } });
    h.type("X");
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(399);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].prefix).toBe("abX");
    expect(h.calls[0].suffix).toBe("\ncd");
    h.calls[0].resolve(" = 1;");
    await vi.advanceTimersByTimeAsync(0);
    expect(ghostShown(h.view.state)).toBe(" = 1;");
    expect(h.ghostEl()?.textContent).toBe(" = 1;");
    // The document itself is untouched until accepted.
    expect(h.view.state.doc.toString()).toBe("abX\ncd");
    h.destroy();
  });

  it("Tab inserts the completion and moves the caret past it; Tab with nothing shown indents", async () => {
    const h = harness({ doc: "ab" });
    h.view.dispatch({ selection: { anchor: 2 } });
    h.type("c");
    await vi.advanceTimersByTimeAsync(400);
    h.calls[0].resolve("def");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.key("Tab")).toBe(false); // handled — default prevented
    expect(h.view.state.doc.toString()).toBe("abcdef");
    expect(h.view.state.selection.main.head).toBe(6);
    expect(ghostShown(h.view.state)).toBeNull();
    // Accepting is not typing: no new request off the back of it.
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(1);
    // With nothing shown, Tab falls through to indentWithTab.
    h.key("Tab");
    expect(h.view.state.doc.toString()).toBe("  abcdef");
    h.destroy();
  });

  it("Escape dismisses without inserting; typing clears and aborts what is in flight", async () => {
    const h = harness({ doc: "ab" });
    h.view.dispatch({ selection: { anchor: 2 } });
    h.type("c");
    await vi.advanceTimersByTimeAsync(400);
    h.calls[0].resolve("def");
    await vi.advanceTimersByTimeAsync(0);
    expect(ghostShown(h.view.state)).toBe("def");
    h.key("Escape");
    expect(ghostShown(h.view.state)).toBeNull();
    expect(h.view.state.doc.toString()).toBe("abc");

    h.type("d");
    await vi.advanceTimersByTimeAsync(400);
    expect(h.calls).toHaveLength(2);
    h.type("e");
    expect(h.calls[1].signal.aborted).toBe(true);
    h.calls[1].resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(ghostShown(h.view.state)).toBeNull();
    h.destroy();
  });

  it("drops an answer when the caret has moved since it was asked for", async () => {
    const h = harness({ doc: "ab\ncd" });
    h.view.dispatch({ selection: { anchor: 2 } });
    h.type("c");
    await vi.advanceTimersByTimeAsync(400);
    h.view.dispatch({ selection: { anchor: 0 } });
    h.calls[0].resolve("zzz");
    await vi.advanceTimersByTimeAsync(0);
    expect(ghostShown(h.view.state)).toBeNull();
    h.destroy();
  });

  it("asks nothing with a null source, in a read-only editor, or with a selection", async () => {
    const off = harness({ source: null });
    off.type("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(ghostShown(off.view.state)).toBeNull();
    off.destroy();

    const ro = harness({ readOnly: true });
    ro.type("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(ro.calls).toHaveLength(0);
    ro.destroy();

    const sel = harness({ doc: "abcd" });
    sel.view.dispatch({ changes: { from: 0, insert: "x" }, selection: { anchor: 1, head: 3 }, userEvent: "input.type" });
    await vi.advanceTimersByTimeAsync(400);
    expect(sel.calls).toHaveLength(0);
    sel.destroy();
  });

  it("a source that rejects shows nothing and does not throw", async () => {
    const h = harness({ source: async () => Promise.reject(new Error("offline")) });
    h.type("x");
    await vi.advanceTimersByTimeAsync(400);
    expect(ghostShown(h.view.state)).toBeNull();
    h.destroy();
  });
});
