import * as React from "react";

import type { ScriptCheckError } from "../lib/recorder-types";

/**
 * IDE-style viewer + editor for a Playwright/TS test script.
 *
 * Renders a line-numbered gutter + lightweight syntax highlighting (keywords,
 * strings, comments, numbers, decorators) using only semantic design tokens so
 * it adapts to light/dark. No deps — a small regex tokenizer, good enough for
 * the spec files this app produces.
 *
 * The editor overlays a transparent `<textarea>` on a highlighted `<pre>` so
 * the user edits live, color-coded text with a gutter, just like the read view.
 */

const KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "return",
  "if",
  "else",
  "for",
  "while",
  "of",
  "in",
  "new",
  "class",
  "extends",
  "super",
  "this",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "void",
  "delete",
  "yield",
  "switch",
  "case",
  "break",
  "continue",
  "do",
  "interface",
  "type",
  "enum",
  "as",
  "public",
  "private",
  "readonly",
  "static",
  "get",
  "set",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "this"]);

type Token = { type: "plain" | "kw" | "lit" | "str" | "num" | "comment" | "decorator" | "punct"; value: string };

/**
 * Tokenize a single line. Multiline constructs (block comments, template
 * literals) are tracked across lines via the carried state so each line can be
 * rendered independently (keeps React keys stable + line numbers simple).
 */
function tokenizeLine(
  line: string,
  state: { inBlockComment: boolean; inTemplate: boolean },
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;

  const push = (type: Token["type"], value: string) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type && last.type !== "plain") last.value += value;
    else tokens.push({ type, value });
  };
  const pushPlain = (value: string) => push("plain", value);

  while (i < n) {
    // Continue a block comment from a previous line.
    if (state.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end === -1) {
        push("comment", line.slice(i));
        break;
      }
      push("comment", line.slice(i, end + 2));
      i = end + 2;
      state.inBlockComment = false;
      continue;
    }

    // Continue a template literal from a previous line.
    if (state.inTemplate) {
      const end = findTemplateEnd(line, i);
      if (end === -1) {
        push("str", line.slice(i));
        break;
      }
      push("str", line.slice(i, end + 1));
      i = end + 1;
      state.inTemplate = false;
      continue;
    }

    const rest = line.slice(i);
    const ch = line[i];

    // Line comment
    if (ch === "/" && line[i + 1] === "/") {
      push("comment", rest);
      break;
    }
    // Block comment start
    if (ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push("comment", line.slice(i));
        state.inBlockComment = true;
        break;
      }
      push("comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    // Decorator / @-annotation
    if (ch === "@" && /[@A-Za-z_$]/.test(line[i + 1] ?? "")) {
      const m = rest.match(/^@[A-Za-z_$][\w$.-]*/);
      if (m) {
        push("decorator", m[0]);
        i += m[0].length;
        continue;
      }
    }
    // Strings: ", ', `
    if (ch === '"' || ch === "'" || ch === "`") {
      if (ch === "`") {
        const end = findTemplateEnd(line, i + 1);
        if (end === -1) {
          push("str", line.slice(i));
          state.inTemplate = true;
          break;
        }
        push("str", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
      const end = findStringEnd(line, i + 1, ch);
      if (end === -1) {
        push("str", line.slice(i));
        break;
      }
      push("str", line.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
      const m = rest.match(/^(0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)/);
      if (m) {
        push("num", m[0]);
        i += m[0].length;
        continue;
      }
    }
    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const m = rest.match(/^[A-Za-z_$][\w$]*/);
      if (m) {
        const word = m[0];
        if (KEYWORDS.has(word)) push("kw", word);
        else if (LITERALS.has(word)) push("lit", word);
        else pushPlain(word);
        i += word.length;
        continue;
      }
    }
    // Punctuation cluster
    if (/[{}[\]();,.<>:?=+\-*/%&|^!~]/.test(ch)) {
      const m = rest.match(/^[{}[\]();,.<>:?=+\-*/%&|^!~]+/);
      if (m) {
        push("punct", m[0]);
        i += m[0].length;
        continue;
      }
    }
    pushPlain(ch);
    i += 1;
  }

  return tokens.length ? tokens : [{ type: "plain", value: "" }];
}

function findStringEnd(line: string, start: number, quote: string): number {
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === quote) return i;
    i += 1;
  }
  return -1;
}

// Find the closing backtick, ignoring ${...} interpolations (treat as string).
function findTemplateEnd(line: string, start: number): number {
  let i = start;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] === "`") return i;
    if (line[i] === "$" && line[i + 1] === "{") {
      // Skip interpolation — find matching }
      let depth = 1;
      i += 2;
      while (i < line.length && depth > 0) {
        if (line[i] === "{") depth += 1;
        else if (line[i] === "}") depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}

// Use the design system's dedicated syntax-token CSS variables (they adapt to
// light/dark and are purpose-built for code, unlike the status text tokens).
const TOKEN_CLASS: Record<Token["type"], string> = {
  plain: "",
  kw: "text-[var(--color-token-primary)]",
  lit: "text-[var(--color-token-secondary)]",
  str: "text-[var(--color-token-string)]",
  num: "text-[var(--color-token-highlight)]",
  comment: "text-[var(--color-token-tertiary)] italic",
  decorator: "text-[var(--color-token-highlight)]",
  punct: "text-[var(--color-token-tertiary)]",
};

// Slightly larger than the old text-small-mono — uses the design system's
// standard mono text scale (13px / 18px line-height) for a more legible IDE feel.
const LINE_CLS = "text-mono font-mono";
const GUTTER_PAD_X = "0.75rem"; // px-3 — matches the read view's gutter padding
const CODE_PAD_X = "1rem"; // px-4 — matches the read view's code padding
const GUTTER_RIGHT_GAP = "1rem"; // gap between gutter column and code column

function highlightTokens(tokens: Token[]): React.ReactNode {
  return tokens.map((t, j) =>
    t.type === "plain" ? (
      <React.Fragment key={j}>{t.value}</React.Fragment>
    ) : (
      <span key={j} className={TOKEN_CLASS[t.type]}>
        {t.value}
      </span>
    ),
  );
}

export function ScriptView({ code }: { code: string }) {
  const lines = React.useMemo(() => (code ? code.split("\n") : []), [code]);

  // Tokenize all lines once, threading multiline block-comment / template
  // literal state across lines so each rendered line is self-contained.
  const rendered = React.useMemo(() => {
    const state = { inBlockComment: false, inTemplate: false };
    return lines.map((line) => tokenizeLine(line, state));
  }, [lines]);

  const gutterWidth = String(lines.length).length;

  return (
    <div className={`${LINE_CLS} min-h-0 flex-1 overflow-auto`}>
      <div className="min-w-full table">
        {rendered.map((tokens, idx) => (
          <div key={idx} className="table-row group">
            <div
              className="table-cell select-none text-right align-top text-[var(--color-token-tertiary)] group-hover:text-[var(--color-token-secondary)]"
              style={{
                minWidth: `${gutterWidth + 2}ch`,
                paddingLeft: GUTTER_PAD_X,
                paddingRight: GUTTER_RIGHT_GAP,
              }}
              aria-hidden
            >
              {idx + 1}
            </div>
            <code
              className="table-cell whitespace-pre align-top text-primary"
              style={{ paddingLeft: CODE_PAD_X, paddingRight: CODE_PAD_X }}
            >
              {highlightTokens(tokens)}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Character offset of the START of a 1-based line in `value`, clamped to the
 *  text. What a click on a reported problem hands to `setSelectionRange`. */
export function lineStartOffset(value: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < line) {
    const nl = value.indexOf("\n", offset);
    if (nl === -1) return value.length;
    offset = nl + 1;
    current += 1;
  }
  return offset;
}

export interface ScriptEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** Problems the last pre-save check reported. A problem with a `line` marks
   *  that row in the gutter and tints it in the highlight layer; the rest are
   *  the host's to show, since the editor has no row to pin them to. */
  errors?: ScriptCheckError[];
  /** The textarea, for a host that moves the caret (click a problem, land on
   *  its line). */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}

/**
 * Editable IDE-style script editor: a transparent `<textarea>` overlaid on a
 * syntax-highlighted `<pre>` with a shared line-number gutter. The textarea's
 * text is transparent (caret stays visible); the pre behind it supplies the
 * colors.
 *
 * Two layers can only agree line-for-line if they break lines identically and
 * scroll identically, and both were once left to chance:
 *
 *  - The textarea WRAPPED. A `<textarea>` soft-wraps by default and the pre
 *    is `white-space: pre`, so the first line wider than the pane took two
 *    rows in one layer and one in the other, and every row below it was
 *    offset by one — the caret sat on the line above the text it was editing.
 *    `wrap="off"` plus `white-space: pre` makes both layers break only at a
 *    newline.
 *  - Only the gutter was scroll-synced — and by setting `scrollTop` on an
 *    element that does not scroll, which did nothing. The pre scrolled on its
 *    own, so past the first screenful the highlight drifted away from the
 *    caret. The textarea is now the ONE scrolling element; the pre is
 *    `overflow: hidden` and follows it programmatically, and the gutter
 *    follows by transform.
 *
 * Both layers share identical font metrics, padding and tab size so typed text
 * overlays the highlighted text line-for-line. `script-view.test.tsx` pins the
 * structural half; the visual half is what `?test=<id>` in the preview shows.
 */
export function ScriptEditor({ value, onChange, errors, textareaRef }: ScriptEditorProps) {
  const lines = React.useMemo(() => value.split("\n"), [value]);
  const rendered = React.useMemo(() => {
    const state = { inBlockComment: false, inTemplate: false };
    return lines.map((line) => tokenizeLine(line, state));
  }, [lines]);

  // Line → first message reported on it. The gutter shows one mark per line;
  // the host lists every problem.
  const errorByLine = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const e of errors ?? []) {
      if (e.line && !m.has(e.line)) m.set(e.line, e.message);
    }
    return m;
  }, [errors]);

  const gutterWidth = String(lines.length + 1).length;
  const gutterCh = `${gutterWidth + 2}ch`;

  // The textarea scrolls; the highlight layer and the gutter follow it.
  const highlightRef = React.useRef<HTMLPreElement | null>(null);
  const gutterRef = React.useRef<HTMLDivElement | null>(null);
  const onScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const { scrollTop, scrollLeft } = e.currentTarget;
    const pre = highlightRef.current;
    if (pre) {
      pre.scrollTop = scrollTop;
      pre.scrollLeft = scrollLeft;
    }
    const gutter = gutterRef.current;
    if (gutter) gutter.style.transform = `translateY(${-scrollTop}px)`;
  };

  const lineHeight = "var(--text-mono--line-height)";
  const sharedText: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-mono)",
    lineHeight,
    tabSize: 2,
    margin: 0,
    border: 0,
    padding: `0 ${CODE_PAD_X}`,
    whiteSpace: "pre",
    overflowWrap: "normal",
    wordBreak: "normal",
  };

  return (
    <div className={`${LINE_CLS} relative min-h-0 flex-1 overflow-hidden`} data-gl="script-editor">
      <div className="flex h-full min-h-0">
        {/* Gutter column — clipped, moved by transform to follow the textarea. */}
        <div
          className="select-none overflow-hidden text-right align-top text-[var(--color-token-tertiary)]"
          style={{
            minWidth: `calc(${gutterCh} + ${GUTTER_PAD_X} + ${GUTTER_RIGHT_GAP})`,
            paddingLeft: GUTTER_PAD_X,
            paddingRight: GUTTER_RIGHT_GAP,
            lineHeight,
          }}
          aria-hidden
        >
          <div ref={gutterRef} className="min-w-0 will-change-transform" data-gl="script-gutter">
            {lines.map((_, idx) => {
              const message = errorByLine.get(idx + 1);
              return (
                <div
                  key={idx}
                  style={{ height: lineHeight }}
                  className={message ? "gl-script-gutter-err" : undefined}
                  data-error-line={message ? idx + 1 : undefined}
                  title={message}
                >
                  {idx + 1}
                </div>
              );
            })}
            {/* Trailing line so the caret past the last row has a number. */}
            <div style={{ height: lineHeight }}>{lines.length + 1}</div>
          </div>
        </div>

        {/* Code area — relative so the textarea can overlay the pre exactly. */}
        <div className="relative min-w-0 flex-1">
          {/* Highlight layer (pre) — behind the textarea, same metrics, no
              scrollbars of its own: it is scrolled programmatically. */}
          <pre
            ref={highlightRef}
            className="pointer-events-none absolute inset-0 overflow-hidden"
            style={{ ...sharedText, color: "var(--color-text-primary)" }}
            data-gl="script-highlight"
            aria-hidden
          >
            {rendered.map((tokens, idx) => (
              <div
                key={idx}
                style={{ minHeight: lineHeight }}
                className={errorByLine.has(idx + 1) ? "gl-script-line-err" : undefined}
              >
                {highlightTokens(tokens)}
                {"\n"}
              </div>
            ))}
            {/* Trailing empty line for caret at end-of-file. */}
            <div style={{ minHeight: lineHeight }}> </div>
          </pre>

          {/* Editable layer — transparent text, caret-only; aligned over the pre. */}
          <textarea
            ref={textareaRef}
            autoFocus
            spellCheck={false}
            wrap="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onScroll={onScroll}
            className="absolute inset-0 resize-none overflow-auto bg-transparent text-transparent outline-none"
            style={{
              ...sharedText,
              // text-transparent also makes the caret invisible in WebKit, so
              // restore an explicit caret color from the design system.
              caretColor: "var(--color-text-primary, #fff)",
              color: "transparent",
            }}
          />
        </div>
      </div>
    </div>
  );
}
