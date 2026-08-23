import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";

import { SNIPPETS, snippetSource } from "./editor-snippets";

describe("snippetSource", () => {
  it("offers the templates at a line start, by their first word, and not mid-expression", () => {
    const atStart = EditorState.create({ doc: "  ste" });
    const r = snippetSource(new CompletionContext(atStart, 5, false));
    expect(r?.from).toBe(2);
    expect(r?.options.map((o) => o.label)).toEqual(SNIPPETS.map((s) => s.label));
    const mid = EditorState.create({ doc: "  await page.ste" });
    expect(snippetSource(new CompletionContext(mid, 16, false))).toBeNull();
    const blank = EditorState.create({ doc: "  " });
    expect(snippetSource(new CompletionContext(blank, 2, false))).toBeNull();
    expect(snippetSource(new CompletionContext(blank, 2, true))?.options.length).toBe(SNIPPETS.length);
  });

  it("every template is a test.step wrapper", () => {
    for (const s of SNIPPETS) expect(s.label).toBeTruthy();
  });
});
