// The Script IDE's look, as CodeMirror extensions.
//
// Two halves. `editorTheme` is `EditorView.theme` — the chrome: gutters,
// active line, selection, the lint panel — and `codeHighlight` is a
// `HighlightStyle` — the syntax colours. Both read `--gl-*` tokens
// (tokens.css) as `var()` strings; CodeMirror's style-mod passes them through
// verbatim, which is what lets `check:script-ide-layout` prove every name
// here resolves, the job `check:theme-tokens` does for a stylesheet.
//
// Why a theme extension and not `renderer/theme/editor.css`: CodeMirror
// injects its base rules at runtime, scoped by a generated class and placed
// after the app's stylesheet, so a plain `.cm-gutters { … }` in a file of ours
// ties on specificity and loses on order. A theme extension gets the
// generated class too and wins.
//
// No literal sizes. The font, size and line height come from the host's
// tokens so the gutter and the content — two separate DOM columns — are sized
// from one pair of values, and so the Settings → Editor rows (Phase 1) can
// change them in one place.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "transparent",
      color: "var(--gl-tx-1)",
      fontFamily: "var(--gl-mono)",
      fontSize: "var(--gl-code-size)",
    },
    // The one scrolling element. A second scroll container around the editor
    // breaks CodeMirror's viewport virtualisation, and jsdom renders either
    // layout identically — hence the source-level guard.
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: "var(--gl-mono)",
      lineHeight: "var(--gl-code-line)",
    },
    ".cm-content": {
      padding: "8px 0",
      caretColor: "var(--gl-tx-1)",
    },
    ".cm-line": {
      padding: "0 16px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "var(--gl-tx-1)",
    },
    // Selection is neutral white at low alpha — never a status hue, the same
    // rule as every selected row in the app (`check:selection-neutral`).
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--gl-sel-ring)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--gl-code-active)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--gl-tx-3)",
      border: "none",
      fontFamily: "var(--gl-mono)",
      fontSize: "var(--gl-code-size)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--gl-code-active)",
      color: "var(--gl-tx-2)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 4px 0 12px",
      minWidth: "3.5ch",
    },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "var(--gl-sel-bg)",
      outline: "1px solid var(--gl-line)",
    },
    ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": {
      outline: "1px solid var(--gl-red)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "var(--gl-sel-bg)",
    },
    // Diagnostics: the lint gutter's marks and the underline. Red IS the
    // outcome here — a line that will not load.
    ".cm-lintRange-error": {
      backgroundImage: "none",
      textDecoration: "underline wavy var(--gl-red)",
      textUnderlineOffset: "3px",
    },
    ".cm-lintRange-warning": {
      backgroundImage: "none",
      textDecoration: "underline wavy var(--gl-amber)",
      textUnderlineOffset: "3px",
    },
    ".cm-lint-marker-error": {
      content: "none",
    },
    ".cm-gutter-lint .cm-gutterElement": {
      padding: "0 2px",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--gl-panel)",
      color: "var(--gl-tx-1)",
      border: "1px solid var(--gl-line)",
      borderRadius: "0",
      fontFamily: "var(--gl-mono)",
      fontSize: "var(--gl-code-size)",
    },
    ".cm-tooltip-lint": {
      maxWidth: "60ch",
    },
    ".cm-diagnostic": {
      borderLeftColor: "var(--gl-line)",
      padding: "3px 8px",
    },
    ".cm-diagnostic-error": {
      borderLeftColor: "var(--gl-red)",
    },
    ".cm-diagnostic-warning": {
      borderLeftColor: "var(--gl-amber)",
    },
    ".cm-panels": {
      backgroundColor: "var(--gl-panel)",
      color: "var(--gl-tx-1)",
      borderColor: "var(--gl-line)",
      fontFamily: "var(--gl-sans)",
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: "1px solid var(--gl-line)",
    },
    ".cm-panel.cm-search": {
      padding: "6px 12px",
    },
    ".cm-panel.cm-search input, .cm-panel.cm-search button": {
      fontFamily: "var(--gl-mono)",
      fontSize: "var(--gl-code-size)",
      color: "var(--gl-tx-1)",
      backgroundColor: "var(--gl-ink)",
      border: "1px solid var(--gl-line)",
      borderRadius: "0",
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--gl-sel-ring)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      outline: "1px solid var(--gl-tx-2)",
    },
    ".cm-placeholder": {
      color: "var(--gl-tx-3)",
    },
  },
  { dark: true },
);

/** Syntax colours. Method and property names stay in the text colour on
 *  purpose: in a spec, `page.getByRole("button", …).click()` is the reading
 *  line, and a palette that coloured every call would turn each step into a
 *  row of highlights with nothing left to stand out. */
export const codeHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.moduleKeyword, t.definitionKeyword], color: "var(--gl-code-kw)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--gl-code-str)" },
    { tag: [t.number, t.integer, t.float], color: "var(--gl-code-num)" },
    { tag: [t.bool, t.null, t.atom, t.self], color: "var(--gl-code-lit)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--gl-code-cmt)", fontStyle: "italic" },
    { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.operator], color: "var(--gl-code-punct)" },
    { tag: [t.propertyName, t.function(t.variableName), t.function(t.propertyName), t.variableName, t.definition(t.variableName)], color: "var(--gl-tx-1)" },
    { tag: [t.typeName, t.className], color: "var(--gl-code-kw)" },
    { tag: t.invalid, color: "var(--gl-red)" },
  ]),
);
