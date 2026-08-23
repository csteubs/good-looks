// Type intelligence against a real EditorView and a fake service: the
// service's answers become lint marks, a quick-fix applies its edits, and
// the completion source asks only when it should.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diagnosticCount, forceLinting, linter } from "@codemirror/lint";
import { CompletionContext } from "@codemirror/autocomplete";

import { tsIntelligence, tsDiagnosticsField, tsCompletionSource, toDiagnostics, setTsDiagnostics, type TsIntelligence } from "./ts-intelligence";
import type { Inspection, TsDiagnostic } from "../lib/ts-types";

function fakeIntel(over: Partial<TsIntelligence> = {}): TsIntelligence & { updates: string[] } {
  const updates: string[] = [];
  return {
    updates,
    update: async (t) => {
      updates.push(t);
    },
    diagnostics: async () => [],
    inspections: async () => [],
    completions: async () => [],
    hover: async () => null,
    ...over,
  };
}

function mount(doc: string, intel: TsIntelligence | null) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        tsIntelligence(() => intel, { debounceMs: 100 }),
        linter((v) => v.state.field(tsDiagnosticsField), {
          delay: 0,
          needsRefresh: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setTsDiagnostics))),
        }),
      ],
    }),
    parent,
  });
  return { view, destroy: () => (view.destroy(), parent.remove()) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const DOC = "await page.waitForTimeout(1);\nawait page.goto(x);\n";

describe("tsIntelligence", () => {
  it("syncs the document, asks after a pause, and the answers become lint marks", async () => {
    const intel = fakeIntel({
      diagnostics: async () => [{ from: 31, to: 32, message: "Cannot find name 'x'.", severity: "error", code: 2304 } as TsDiagnostic],
      inspections: async () => [{ rule: "no-wait-for-timeout", severity: "warning", from: 6, to: 28, message: "fixed wait" } as Inspection],
    });
    const h = mount(DOC, intel);
    await vi.advanceTimersByTimeAsync(100);
    expect(intel.updates).toEqual([DOC]);
    const marks = h.view.state.field(tsDiagnosticsField);
    expect(marks.map((m) => m.source)).toEqual(["typescript", "inspection:no-wait-for-timeout"]);
    forceLinting(h.view);
    await vi.advanceTimersByTimeAsync(10);
    expect(diagnosticCount(h.view.state)).toBe(2);
    h.destroy();
  });

  it("a quick-fix action applies the inspection's edits as one change", () => {
    const [d] = toDiagnostics(DOC.length, [], [
      { rule: "no-wait-for-timeout", severity: "warning", from: 6, to: 28, message: "m", fix: { title: "Remove the wait", edits: [{ from: 0, to: 30, text: "" }] } },
    ]);
    expect(d.actions?.[0].name).toBe("Remove the wait");
    const h = mount(DOC, null);
    d.actions![0].apply(h.view, d.from, d.to);
    expect(h.view.state.doc.toString()).toBe("await page.goto(x);\n");
    h.destroy();
  });

  it("drops an answer when the document moved on before it arrived", async () => {
    let resolve: (d: TsDiagnostic[]) => void = () => {};
    const intel = fakeIntel({ diagnostics: () => new Promise((r) => (resolve = r)) });
    const h = mount(DOC, intel);
    await vi.advanceTimersByTimeAsync(100);
    h.view.dispatch({ changes: { from: 0, insert: "// " } });
    resolve([{ from: 0, to: 1, message: "late", severity: "error", code: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.view.state.field(tsDiagnosticsField)).toEqual([]);
    h.destroy();
  });

  it("the completion source asks after a dot or inside a word, syncing first, and not otherwise", async () => {
    const intel = fakeIntel({ completions: async () => [{ label: "goto", kind: "method", sortText: "11" }, { label: "click", kind: "method", sortText: "12" }] });
    const source = tsCompletionSource(() => intel);
    const state = EditorState.create({ doc: "await page.go" });
    const afterDot = await source(new CompletionContext(state, "await page.".length, false));
    expect(afterDot?.from).toBe("await page.".length);
    expect(afterDot?.options.map((o) => o.label)).toEqual(["goto", "click"]);
    expect(intel.updates).toEqual(["await page.go"]);
    const inWord = await source(new CompletionContext(state, "await page.go".length, false));
    expect(inWord?.from).toBe("await page.".length);
    const inSpace = await source(new CompletionContext(EditorState.create({ doc: "await " }), 6, false));
    expect(inSpace).toBeNull();
    const explicit = await source(new CompletionContext(EditorState.create({ doc: "await " }), 6, true));
    expect(explicit?.options).toHaveLength(2);
    expect(await tsCompletionSource(() => null)(new CompletionContext(state, 11, true))).toBeNull();
  });
});
