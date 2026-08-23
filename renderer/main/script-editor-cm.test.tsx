// The CodeMirror host: what it shows for the state it is handed.
//
// jsdom has no layout, so nothing here can see a pixel; what it can see is
// the DOM CodeMirror builds from state — gutter marks, diagnostics, the
// document, the selection — and the extension state behind it. Each test
// drives the view the way a user's keystrokes would (a transaction), never
// the React prop alone, so a prop that stopped reaching the view would fail
// here rather than pass by never being exercised.

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { diagnosticCount, forceLinting } from "@codemirror/lint";

import ScriptEditorCm, { EditorView, linesOf, type ScriptEditorHandle } from "./script-editor-cm";
import { ScriptEditor } from "./script-view";
import { EditorState } from "@codemirror/state";

const CODE = [
  'import { test, expect } from "@playwright/test";',
  "",
  'test("a", async ({ page }) => {',
  '  await page.goto("https://example.com");',
  "  await page.mouse.move(1, 2);",
  '  await page.getByTestId("go").click();',
  "});",
  "",
].join("\n");

/** Settings → Editor at their defaults. */
const PREFS = { lineWrap: false, lineNumbers: true, tabSize: 2 } as const;

function view(): EditorView {
  const content = document.querySelector(".cm-content") as HTMLElement;
  const v = EditorView.findFromDOM(content);
  if (!v) throw new Error("no EditorView mounted");
  return v;
}

function setDoc(v: EditorView, text: string): void {
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
}

describe("<ScriptEditorCm />", () => {
  it("mounts the document into an accessible, labelled editor", () => {
    render(
      <ScriptEditorCm
        value={CODE}
        onChange={() => {}}
        readOnly={false}
        errors={[]}
        skippedRanges={null}
        runStatus={{}}
        ariaLabel="Script of Checkout"
        {...PREFS}
      />,
    );
    const content = screen.getByRole("textbox", { name: "Script of Checkout" });
    expect(content.getAttribute("aria-multiline")).toBe("true");
    expect(view().state.doc.toString()).toBe(CODE);
    expect(document.querySelectorAll(".cm-lineNumbers .cm-gutterElement").length).toBeGreaterThan(0);
  });

  it("reports edits, and takes an external value as a replacement without a remount", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ScriptEditorCm value={CODE} onChange={onChange} readOnly={false} errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} />,
    );
    const v = view();
    act(() => v.dispatch({ changes: { from: 0, insert: "// c\n" } }));
    expect(onChange).toHaveBeenLastCalledWith("// c\n" + CODE);
    rerender(
      <ScriptEditorCm value="// v2" onChange={onChange} readOnly={false} errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} />,
    );
    expect(view()).toBe(v);
    expect(v.state.doc.toString()).toBe("// v2");
  });

  it("refuses edits while read-only, and takes them again when it is not", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ScriptEditorCm value={CODE} onChange={onChange} readOnly errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} />,
    );
    const v = view();
    expect(v.state.readOnly).toBe(true);
    expect(v.contentDOM.getAttribute("contenteditable")).toBe("false");
    rerender(
      <ScriptEditorCm value={CODE} onChange={onChange} readOnly={false} errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} />,
    );
    expect(v.state.readOnly).toBe(false);
    expect(v.contentDOM.getAttribute("contenteditable")).toBe("true");
  });

  it("marks unmapped statements in the coverage gutter, on their lines only", () => {
    const skipped = [{ from: CODE.indexOf("await page.mouse"), to: CODE.indexOf("move(1, 2);") + "move(1, 2);".length }];
    render(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={skipped} runStatus={{}} ariaLabel="s" {...PREFS} />,
    );
    const marks = Array.from(document.querySelectorAll('.gl-ide-cov[data-coverage="skipped"]:not([data-spacer])'));
    expect(marks).toHaveLength(1);
    // The gutter element sits in the row for line 5.
    const row = marks[0].closest(".cm-gutterElement") as HTMLElement;
    expect(row).not.toBeNull();
    expect(linesOf(view().state.doc, skipped, "skipped")).toEqual({ 5: "skipped" });
  });

  it("paints run status on the lines it is given", () => {
    const { rerender } = render(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={null} runStatus={{ 4: "passed", 6: "failed" }} ariaLabel="s" {...PREFS} />,
    );
    const statuses = () =>
      Array.from(document.querySelectorAll(".gl-ide-run:not([data-spacer])")).map((el) => (el as HTMLElement).dataset.status);
    expect(statuses().sort()).toEqual(["failed", "passed"]);
    rerender(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={null} runStatus={{ 4: "running" }} ariaLabel="s" {...PREFS} />,
    );
    expect(statuses()).toEqual(["running"]);
  });

  it("turns the CLI's problems into diagnostics on their lines, and a syntax error into one of its own", async () => {
    const { rerender } = render(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly={false} errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} />,
    );
    const v = view();
    act(() => forceLinting(v));
    await waitFor(() => expect(diagnosticCount(v.state)).toBe(0));

    rerender(
      <ScriptEditorCm
        value={CODE}
        onChange={() => {}}
        readOnly={false}
        errors={[{ message: 'SyntaxError: Unexpected token, expected "," (4:39)', line: 4, column: 39 }, { message: "no line" }]}
        skippedRanges={null}
        runStatus={{}}
        ariaLabel="s" {...PREFS}
      />,
    );
    await waitFor(() => expect(diagnosticCount(v.state)).toBe(1));
    expect(document.querySelector(".cm-lintRange-error")).not.toBeNull();

    // A missing bracket: the Lezer tree carries an error node before any CLI
    // has been asked — the live "cannot load yet" mark.
    act(() => setDoc(v, CODE.replace('goto("https://example.com")', 'goto("https://example.com"')));
    act(() => forceLinting(v));
    await waitFor(() => expect(diagnosticCount(v.state)).toBeGreaterThanOrEqual(1));
  });

  it("hands the host a handle that moves the caret to a line and reports the caret's line", () => {
    const ref = React.createRef<ScriptEditorHandle>();
    const onCaretLine = vi.fn();
    render(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly={false} errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} onCaretLine={onCaretLine} handleRef={ref} />,
    );
    act(() => ref.current!.focusLine(6));
    const v = view();
    expect(v.state.selection.main.head).toBe(v.state.doc.line(6).from);
    expect(onCaretLine).toHaveBeenLastCalledWith(6);
    // Clamped, never thrown, for a line past the end.
    act(() => ref.current!.focusLine(999));
    expect(v.state.selection.main.head).toBe(v.state.doc.line(v.state.doc.lines).from);
  });
});

describe("<ScriptEditorCm /> inlays", () => {
  it("draws each inlay at the end of its line with its tone, and replaces the set on change", () => {
    const ref = React.createRef<ScriptEditorHandle>();
    const { rerender } = render(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} handleRef={ref}
        inlays={[{ line: 4, text: "1 match", tone: "ok" }, { line: 5, text: "no match", tone: "bad", title: "nothing" }]} />,
    );
    const inlays = () => Array.from(document.querySelectorAll(".gl-ide-inlay")).map((el) => [(el as HTMLElement).textContent, (el as HTMLElement).dataset.tone]);
    expect(inlays()).toEqual([["1 match", "ok"], ["no match", "bad"]]);
    // The widget sits after the line's text, inside that line.
    const bad = document.querySelector('.gl-ide-inlay[data-tone="bad"]') as HTMLElement;
    expect(bad.closest(".cm-line")?.textContent).toContain("page.mouse.move");
    rerender(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} handleRef={ref} inlays={[{ line: 4, text: "3 matches", tone: "warn" }]} />,
    );
    expect(inlays()).toEqual([["3 matches", "warn"]]);
  });

  it("inserts at the caret through the handle, replacing a selection, and refuses while read-only", () => {
    const ref = React.createRef<ScriptEditorHandle>();
    const onChange = vi.fn();
    const { rerender } = render(
      <ScriptEditorCm value={"ab\ncd"} onChange={onChange} readOnly errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} handleRef={ref} />,
    );
    act(() => ref.current!.insertAtCaret("X"));
    expect(view().state.doc.toString()).toBe("ab\ncd");
    rerender(
      <ScriptEditorCm value={"ab\ncd"} onChange={onChange} readOnly={false} errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" {...PREFS} handleRef={ref} />,
    );
    const v = view();
    act(() => v.dispatch({ selection: { anchor: 3, head: 5 } }));
    act(() => ref.current!.insertAtCaret("page.getByTestId(\"go\")"));
    expect(v.state.doc.toString()).toBe('ab\npage.getByTestId("go")');
    expect(v.state.selection.main.head).toBe(v.state.doc.length);
    expect(onChange).toHaveBeenLastCalledWith('ab\npage.getByTestId("go")');
  });
});

describe("<ScriptEditorCm /> settings", () => {
  it("reconfigures wrapping, line numbers and tab size live, without a remount", () => {
    const { rerender } = render(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" lineWrap={false} lineNumbers tabSize={2} />,
    );
    const v = view();
    expect(v.state.tabSize).toBe(2);
    expect(v.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
    rerender(
      <ScriptEditorCm value={CODE} onChange={() => {}} readOnly errors={[]} skippedRanges={null} runStatus={{}} ariaLabel="s" lineWrap lineNumbers={false} tabSize={4} />,
    );
    expect(view()).toBe(v);
    expect(v.state.tabSize).toBe(4);
    expect(v.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    expect(document.querySelector(".cm-lineNumbers")).toBeNull();
  });
});

describe("<ScriptEditor /> (the lazy face)", () => {
  it("loads the CodeMirror host and shows the document", async () => {
    render(<ScriptEditor value={CODE} onChange={() => {}} readOnly />);
    const content = await screen.findByRole("textbox", { name: "Test script" });
    expect(content).toBeTruthy();
    expect(view().state.doc.toString()).toBe(CODE);
  });
});

describe("linesOf", () => {
  it("maps a multi-line range to every line it touches and clamps to the document", () => {
    const doc = EditorState.create({ doc: "a\nbb\nccc\n" }).doc;
    expect(linesOf(doc, [{ from: 2, to: 7 }], "skipped")).toEqual({ 2: "skipped", 3: "skipped" });
    expect(linesOf(doc, [{ from: 0, to: 0 }], "error")).toEqual({ 1: "error" });
    expect(linesOf(doc, [{ from: 50, to: 60 }], "skipped")).toEqual({ 4: "skipped" });
  });
});
