// The CodeMirror host behind the Script tab — the renderer's one lazily
// loaded module. `script-view.tsx` imports this with `import()`, so the
// trainer, settings and URL-strip windows never pay for it, and so a chunk
// this size is a chunk the bundle budget in `check:script-ide-layout` can
// see. NO `.css` import in here: a stylesheet inside the lazy chunk would be
// a second emitted sheet, and `check:renderer-classes` audits exactly one.
//
// What this owns: the EditorView and its extensions. What it does not own:
// any fact about the test. Run status, parse coverage and the CLI's verdict
// arrive as props and are pushed into the view as effects — the editor is a
// renderer of state the detail view holds, the way the step rows are.

import * as React from "react";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, indentOnInput, syntaxTree } from "@codemirror/language";
import { forceLinting, lintGutter, lintKeymap, linter, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  GutterMarker,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";

import type { ScriptCheckError, SourceRange } from "../lib/recorder-types";
import { codeHighlight, editorTheme } from "./script-editor-theme";
import { ghostText, type GhostSource } from "./ghost-text";
import { setTsDiagnostics, tsDiagnosticsField, tsIntelligence, type TsIntelligence } from "./ts-intelligence";

export type RunLineStatus = "running" | "passed" | "failed" | "skipped";
export type CoverageKind = "skipped" | "error";

/** What the host can ask of the editor once it is mounted. */
export interface ScriptEditorHandle {
  /** Put the caret at the start of a 1-based line, scroll it into view, focus. */
  focusLine(line: number): void;
  /** Replace the selection (or insert at the caret) with `text`, and focus. */
  insertAtCaret(text: string): void;
  /** The live view, for tests and for the few callers that need the doc. */
  view(): EditorView | null;
}

/** An inlay drawn at the END of a 1-based line — the live page's match count
 *  after a locator. `tone` is the outcome it reports: one match is what a
 *  step wants, none or several is what a run will fail on. */
export interface LineInlay {
  line: number;
  text: string;
  tone: "ok" | "warn" | "bad" | "muted";
  title?: string;
}

export interface ScriptEditorCmProps {
  value: string;
  onChange: (next: string) => void;
  readOnly: boolean;
  /** Problems the last pre-save check reported, shown as lint diagnostics on
   *  their lines (a problem without a line is the host's to show). */
  errors: ScriptCheckError[];
  /** Where the parser could not map a statement — drawn as the coverage
   *  gutter. `null` while unknown. */
  skippedRanges: SourceRange[] | null;
  /** Run status by 1-based line, for the run gutter. */
  runStatus: Record<number, RunLineStatus>;
  /** Reported with the caret's 1-based line on every selection change. */
  onCaretLine?: (line: number) => void;
  ariaLabel: string;
  handleRef?: React.Ref<ScriptEditorHandle>;
  /** Settings → Editor. Each is a Compartment, reconfigured live. */
  lineWrap: boolean;
  lineNumbers: boolean;
  tabSize: number;
  /** End-of-line inlays (the live page's match counts). */
  inlays?: LineInlay[];
  /** Where ghost text comes from; null or undefined turns it off. Read
   *  through a ref at request time, so a host may swap it without a remount. */
  ghost?: GhostSource | null;
  /** ⌘K inside the editor. Bound here, not on the window, so it wins over
   *  the command palette only while the editor has focus. */
  onAiRequest?: () => void;
  /** The TypeScript service, when it is available; null keeps the editor
   *  on syntax and CLI diagnostics alone. Read through a ref at call time. */
  intelligence?: TsIntelligence | null;
}

// ── Gutters ───────────────────────────────────────────────────────────────
//
// Both gutters read a StateField keyed by line number, replaced wholesale by
// an effect whenever the host's props change. A marker per line rather than
// per range: a gutter is per line, and a range that spans two lines is two
// marks.

const setRunStatus = StateEffect.define<Record<number, RunLineStatus>>();
const runStatusField = StateField.define<Record<number, RunLineStatus>>({
  create: () => ({}),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRunStatus)) return e.value;
    return value;
  },
});

class RunMarker extends GutterMarker {
  constructor(
    readonly status: RunLineStatus,
    // CodeMirror keeps one hidden marker per gutter to size the column; it is
    // in the DOM, so it says so, and anything counting marks can skip it.
    readonly spacer = false,
  ) {
    super();
  }
  eq(other: RunMarker): boolean {
    return other.status === this.status;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "gl-ide-run";
    el.dataset.status = this.status;
    if (this.spacer) el.dataset.spacer = "";
    else el.title = this.status;
    return el;
  }
}

const setCoverage = StateEffect.define<Record<number, CoverageKind>>();
const coverageField = StateField.define<Record<number, CoverageKind>>({
  create: () => ({}),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCoverage)) return e.value;
    return value;
  },
});

class CoverageMarker extends GutterMarker {
  constructor(
    readonly kind: CoverageKind,
    readonly spacer = false,
  ) {
    super();
  }
  eq(other: CoverageMarker): boolean {
    return other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "gl-ide-cov";
    el.dataset.coverage = this.kind;
    if (this.spacer) el.dataset.spacer = "";
    el.title =
      this.kind === "skipped"
        ? "The parser can't map this statement to a step — it runs, but the Steps tab won't track it"
        : "This line does not load";
    return el;
  }
}

const runGutter = gutter({
  class: "gl-ide-run-gutter",
  lineMarker(view, line) {
    const status = view.state.field(runStatusField)[view.state.doc.lineAt(line.from).number];
    return status ? new RunMarker(status) : null;
  },
  lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setRunStatus))),
  initialSpacer: () => new RunMarker("passed", true),
});

const coverageGutter = gutter({
  class: "gl-ide-cov-gutter",
  lineMarker(view, line) {
    const kind = view.state.field(coverageField)[view.state.doc.lineAt(line.from).number];
    return kind ? new CoverageMarker(kind) : null;
  },
  lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setCoverage))),
  initialSpacer: () => new CoverageMarker("skipped", true),
});

// ── Inlays ────────────────────────────────────────────────────────────────
//
// A widget decoration at each line's end, replaced wholesale by an effect —
// the same shape as the gutters. `side: 1` puts it after the line's text and
// keeps the caret in front of it.

const setInlays = StateEffect.define<LineInlay[]>();

class InlayWidget extends WidgetType {
  constructor(readonly inlay: LineInlay) {
    super();
  }
  eq(other: InlayWidget): boolean {
    return other.inlay.text === this.inlay.text && other.inlay.tone === this.inlay.tone;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "gl-ide-inlay";
    el.dataset.tone = this.inlay.tone;
    el.textContent = this.inlay.text;
    if (this.inlay.title) el.title = this.inlay.title;
    el.setAttribute("aria-label", this.inlay.title ?? this.inlay.text);
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function inlayDecorations(doc: EditorState["doc"], inlays: LineInlay[]): DecorationSet {
  const marks: { from: number; deco: Decoration }[] = [];
  for (const inlay of inlays) {
    if (inlay.line < 1 || inlay.line > doc.lines) continue;
    const line = doc.line(inlay.line);
    marks.push({ from: line.to, deco: Decoration.widget({ widget: new InlayWidget(inlay), side: 1 }) });
  }
  marks.sort((a, b) => a.from - b.from);
  return Decoration.set(marks.map((m) => m.deco.range(m.from)));
}

const inlayField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInlays)) return inlayDecorations(tr.state.doc, e.value);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Lines a list of ranges covers, as a line → kind map. */
export function linesOf(doc: EditorState["doc"], ranges: SourceRange[], kind: CoverageKind): Record<number, CoverageKind> {
  const out: Record<number, CoverageKind> = {};
  for (const r of ranges) {
    const from = Math.max(0, Math.min(r.from, doc.length));
    const to = Math.max(from, Math.min(r.to, doc.length));
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to > from ? to - 1 : from).number;
    for (let n = first; n <= last; n++) out[n] = kind;
  }
  return out;
}

// ── Diagnostics ───────────────────────────────────────────────────────────
//
// One lint source, two inputs: the Lezer tree's error nodes (instant, every
// keystroke — "this cannot load yet") and the CLI's verdict from the last
// pre-save check (authoritative, by line). `linter` replaces the whole
// diagnostic set on each run, so both have to come from the same source; the
// CLI's live in a StateField, and `needsRefresh` tells the lint plugin that
// the effect replacing them is a reason to run again — `forceLinting` alone
// only runs a lint that is already pending.

const setCliErrors = StateEffect.define<ScriptCheckError[]>();
const cliErrorsField = StateField.define<ScriptCheckError[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setCliErrors)) return e.value;
    return value;
  },
});

function lezerDiagnostics(state: EditorState): Diagnostic[] {
  const out: Diagnostic[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (!node.type.isError) return;
      // A zero-width error node (a missing token) still needs a span to be
      // drawn on; give it the character before it, or after at the start.
      const from = node.from === node.to && node.from > 0 ? node.from - 1 : node.from;
      const to = node.to > from ? node.to : Math.min(state.doc.length, from + 1);
      out.push({ from, to, severity: "error", message: "Syntax error", source: "syntax" });
    },
  });
  return out;
}

function cliDiagnostics(state: EditorState, errors: ScriptCheckError[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const e of errors) {
    if (!e.line || e.line < 1 || e.line > state.doc.lines) continue;
    const line = state.doc.line(e.line);
    const col = e.column && e.column >= 1 ? Math.min(e.column - 1, line.length) : 0;
    const from = line.from + col;
    // Underline from the column to the end of the line: the CLI names a
    // position, not a span, and a one-character mark is easy to miss.
    const to = Math.max(from + 1, line.to);
    out.push({ from, to: Math.min(to, state.doc.length), severity: "error", message: e.message, source: "playwright" });
  }
  return out;
}

// ── The component ─────────────────────────────────────────────────────────

export default function ScriptEditorCm({
  value,
  onChange,
  readOnly,
  errors,
  skippedRanges,
  runStatus,
  onCaretLine,
  ariaLabel,
  handleRef,
  lineWrap,
  lineNumbers: showLineNumbers,
  tabSize,
  inlays,
  ghost,
  onAiRequest,
  intelligence,
}: ScriptEditorCmProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const onChangeRef = React.useRef(onChange);
  const onCaretRef = React.useRef(onCaretLine);
  const ghostRef = React.useRef<GhostSource | null>(ghost ?? null);
  ghostRef.current = ghost ?? null;
  const onAiRef = React.useRef(onAiRequest);
  onAiRef.current = onAiRequest;
  const intelRef = React.useRef<TsIntelligence | null>(intelligence ?? null);
  intelRef.current = intelligence ?? null;
  const readOnlyCompartment = React.useRef(new Compartment());
  const wrapCompartment = React.useRef(new Compartment());
  const numbersCompartment = React.useRef(new Compartment());
  const tabCompartment = React.useRef(new Compartment());
  onChangeRef.current = onChange;
  onCaretRef.current = onCaretLine;

  // Create the view once. Everything that changes afterwards is an effect or
  // a compartment reconfiguration below, never a remount — a remount would
  // drop the undo history and the scroll position.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          runGutter,
          numbersCompartment.current.of(showLineNumbers ? lineNumbers() : []),
          lintGutter(),
          coverageGutter,
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          javascript({ typescript: true }),
          codeHighlight,
          editorTheme,
          runStatusField,
          coverageField,
          inlayField,
          cliErrorsField,
          linter(
            (v) => [...lezerDiagnostics(v.state), ...cliDiagnostics(v.state, v.state.field(cliErrorsField)), ...v.state.field(tsDiagnosticsField)],
            {
            delay: 300,
            needsRefresh: (update) =>
              update.transactions.some((tr) => tr.effects.some((e) => e.is(setCliErrors) || e.is(setTsDiagnostics))),
          }),
          readOnlyCompartment.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          wrapCompartment.current.of(lineWrap ? EditorView.lineWrapping : []),
          tabCompartment.current.of(EditorState.tabSize.of(tabSize)),
          EditorView.contentAttributes.of({ "aria-label": ariaLabel, "aria-multiline": "true" }),
          // Before the keymap below: its Tab must win over indentWithTab
          // while a completion is shown, and fall through when none is.
          ghostText(() => ghostRef.current),
          tsIntelligence(() => intelRef.current),
          keymap.of([
            {
              key: "Mod-k",
              run: () => {
                if (!onAiRef.current) return false;
                onAiRef.current();
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...lintKeymap,
            // Tab indents. Escape then Tab leaves the editor — CodeMirror's
            // own escape hatch for a bound Tab.
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.selectionSet || update.docChanged) {
              const line = update.state.doc.lineAt(update.state.selection.main.head).number;
              onCaretRef.current?.(line);
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount-only by design; see the comment above.
  }, []);

  // External value changes (a reload, a revert) replace the document; the
  // editor's own edits already match `value` and are left alone.
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setCliErrors.of(errors) });
    forceLinting(view);
  }, [errors]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        wrapCompartment.current.reconfigure(lineWrap ? EditorView.lineWrapping : []),
        numbersCompartment.current.reconfigure(showLineNumbers ? lineNumbers() : []),
        tabCompartment.current.reconfigure(EditorState.tabSize.of(tabSize)),
      ],
    });
  }, [lineWrap, showLineNumbers, tabSize]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setCoverage.of(skippedRanges ? linesOf(view.state.doc, skippedRanges, "skipped") : {}) });
  }, [skippedRanges]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setRunStatus.of(runStatus) });
  }, [runStatus]);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setInlays.of(inlays ?? []) });
  }, [inlays]);

  React.useImperativeHandle(
    handleRef,
    () => ({
      focusLine(line: number) {
        const view = viewRef.current;
        if (!view) return;
        const n = Math.max(1, Math.min(line, view.state.doc.lines));
        const pos = view.state.doc.line(n).from;
        view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
        view.focus();
      },
      insertAtCaret(text: string) {
        const view = viewRef.current;
        if (!view || view.state.readOnly) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          userEvent: "input.paste",
        });
        view.focus();
      },
      view: () => viewRef.current,
    }),
    [],
  );

  return <div ref={hostRef} className="gl-script-ide" data-gl="script-editor" data-readonly={readOnly ? "" : undefined} />;
}

// Re-exported for tests, which drive the view directly: a contenteditable
// takes no `fireEvent.change`, and the view is the honest way in.
export { EditorView };
