// The script editor's two-layer contract.
//
// `ScriptEditor` draws a transparent <textarea> over a highlighted <pre>. The
// user only sees the highlight; the caret, selection and typing belong to the
// textarea. The two agree only if they break lines in the same places and
// scroll together, and both of those were once left to chance:
//
//  - the textarea soft-wrapped (a <textarea>'s default) while the pre was
//    `white-space: pre`, so the first line wider than the pane pushed every
//    row below it down by one in one layer only;
//  - only the gutter was scroll-synced, by writing `scrollTop` to an element
//    that does not scroll, and the pre drifted on its own.
//
// jsdom has no layout engine, so nothing here can observe a wrapped line or a
// scrolled pixel. What it CAN pin is the structure that decides both: the
// `wrap` attribute and `white-space` on the textarea, the shared metrics, and
// that a scroll event on the textarea is forwarded to the pre and the gutter.
// The visual half is what `?test=<id>` → Script → Edit script in `dev:web`
// shows, and the fix was confirmed there.

import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ScriptEditor, lineStartOffset } from "./script-view";

const LONG = 'console.log("' + "x".repeat(400) + '");';
const CODE = [
  'import { test } from "@playwright/test";',
  LONG,
  'test("a", async ({ page }) => {',
  "});",
].join("\n");

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}
function highlight(): HTMLPreElement {
  return document.querySelector('[data-gl="script-highlight"]') as HTMLPreElement;
}
function gutter(): HTMLElement {
  return document.querySelector('[data-gl="script-gutter"]') as HTMLElement;
}

describe("<ScriptEditor />", () => {
  it("never soft-wraps: the textarea breaks lines only where the highlight layer does", () => {
    render(<ScriptEditor value={CODE} onChange={() => {}} />);
    const ta = textarea();
    // Both halves are needed. `wrap="off"` is what the browser honours on a
    // textarea; `white-space: pre` is what keeps the two layers' text the same
    // width, and the pre already has it.
    expect(ta.getAttribute("wrap")).toBe("off");
    expect(ta.style.whiteSpace).toBe("pre");
    expect(highlight().style.whiteSpace).toBe("pre");
  });

  it("gives both layers identical metrics, padding and tab size", () => {
    render(<ScriptEditor value={CODE} onChange={() => {}} />);
    const a = textarea().style;
    const b = highlight().style;
    for (const prop of ["fontFamily", "fontSize", "lineHeight", "padding", "tabSize", "margin"] as const) {
      expect(a[prop], prop).toBe(b[prop]);
      expect(a[prop], `${prop} is set`).not.toBe("");
    }
    // A border on one layer only would offset its text by the border width.
    expect(a.border).toBe(b.border);
  });

  it("scrolls the highlight layer and the gutter with the textarea", () => {
    render(<ScriptEditor value={CODE} onChange={() => {}} />);
    const ta = textarea();
    const pre = highlight();
    // jsdom keeps no scroll geometry, so give the textarea a position and
    // watch what the handler writes to the pre, rather than trusting either
    // element's own `scrollTop`.
    Object.defineProperty(ta, "scrollTop", { configurable: true, get: () => 120 });
    Object.defineProperty(ta, "scrollLeft", { configurable: true, get: () => 40 });
    const written: Record<string, number> = {};
    for (const prop of ["scrollTop", "scrollLeft"]) {
      Object.defineProperty(pre, prop, {
        configurable: true,
        get: () => written[prop] ?? 0,
        set: (v: number) => {
          written[prop] = v;
        },
      });
    }

    fireEvent.scroll(ta);

    expect(written).toEqual({ scrollTop: 120, scrollLeft: 40 });
    expect(gutter().style.transform).toBe("translateY(-120px)");
    // And the pre must not scroll on its own — one scrolling element, or the
    // two drift apart again the moment the user wheels over the pre.
    expect(pre.className).toContain("overflow-hidden");
    expect(pre.className).not.toContain("overflow-auto");
  });

  it("marks a reported line in the gutter and tints it in the highlight layer", () => {
    render(
      <ScriptEditor
        value={CODE}
        onChange={() => {}}
        errors={[
          { message: 'SyntaxError: Unexpected token, expected "," (3:9)', line: 3, column: 9 },
          { message: "Error: thrown at module scope" },
        ]}
      />,
    );
    const marked = gutter().querySelector('[data-error-line="3"]') as HTMLElement;
    expect(marked).not.toBeNull();
    expect(marked.className).toContain("gl-script-gutter-err");
    expect(marked.title).toBe('SyntaxError: Unexpected token, expected "," (3:9)');
    expect(gutter().querySelectorAll("[data-error-line]")).toHaveLength(1);

    const rows = highlight().children;
    expect(rows[2].className).toContain("gl-script-line-err");
    expect(rows[1].className).not.toContain("gl-script-line-err");
  });

  it("hands the textarea to the host and reports edits", () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    const onChange = vi.fn();
    render(<ScriptEditor value={CODE} onChange={onChange} textareaRef={ref} />);
    expect(ref.current).toBe(textarea());
    fireEvent.change(textarea(), { target: { value: "// edited" } });
    expect(onChange).toHaveBeenCalledWith("// edited");
  });
});

describe("lineStartOffset", () => {
  const text = "ab\ncd\n\nef";
  it("is 0 for the first line and for anything before it", () => {
    expect(lineStartOffset(text, 1)).toBe(0);
    expect(lineStartOffset(text, 0)).toBe(0);
  });
  it("lands just after the previous newline", () => {
    expect(lineStartOffset(text, 2)).toBe(3);
    expect(lineStartOffset(text, 3)).toBe(6);
    expect(lineStartOffset(text, 4)).toBe(7);
  });
  it("clamps a line past the end to the end of the text", () => {
    expect(lineStartOffset(text, 9)).toBe(text.length);
  });
});
