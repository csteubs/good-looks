// Type intelligence in the script editor: diagnostics and inspections as
// lint marks (with quick-fix actions), completions, and hover — all from the
// TypeScript service in the main process, behind a `TsIntelligence` the host
// hands in (null when the service is unavailable or the editor is closed).
//
// The document the service holds is brought up to date BEFORE any question
// is asked of it (`update` is idempotent on unchanged text), so a completion
// never describes a document the user has already typed past. Diagnostics
// are asked for 300 ms after the last edit and dropped if the document moved
// on meanwhile; the next pause asks again.

import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type ViewUpdate } from "@codemirror/view";

import type { Inspection, TsCompletion, TsDiagnostic, TsHover } from "../lib/ts-types";

export interface TsIntelligence {
  update(text: string): Promise<void>;
  diagnostics(): Promise<TsDiagnostic[]>;
  inspections(): Promise<Inspection[]>;
  completions(offset: number): Promise<TsCompletion[]>;
  hover(offset: number): Promise<TsHover | null>;
}

export const setTsDiagnostics = StateEffect.define<Diagnostic[]>();

/** The service's diagnostics and inspections, already as CodeMirror
 *  diagnostics. The editor's one linter reads this alongside the syntax and
 *  CLI sources. */
export const tsDiagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTsDiagnostics)) return e.value;
    // Positions are stale the moment the doc changes; the plugin re-asks.
    if (tr.docChanged) return value.map((d) => ({ ...d, from: tr.changes.mapPos(d.from), to: tr.changes.mapPos(d.to, 1) })).filter((d) => d.to >= d.from);
    return value;
  },
});

const SEVERITY: Record<TsDiagnostic["severity"] | Inspection["severity"], Diagnostic["severity"]> = {
  error: "error",
  warning: "warning",
  info: "info",
  hint: "hint",
};

/** Map the service's answers onto CodeMirror diagnostics. A fix becomes an
 *  action that applies its edits as one transaction. Exported for tests. */
export function toDiagnostics(docLength: number, diagnostics: TsDiagnostic[], inspections: Inspection[]): Diagnostic[] {
  const clamp = (n: number) => Math.max(0, Math.min(docLength, n));
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const from = clamp(d.from);
    const to = Math.max(from, clamp(d.to));
    out.push({ from, to, severity: SEVERITY[d.severity], message: d.message, source: "typescript" });
  }
  for (const i of inspections) {
    const from = clamp(i.from);
    const to = Math.max(from, clamp(i.to));
    const fix = i.fix;
    out.push({
      from,
      to,
      severity: SEVERITY[i.severity],
      message: i.message,
      source: `inspection:${i.rule}`,
      ...(fix
        ? {
            actions: [
              {
                name: fix.title,
                apply(view: EditorView) {
                  view.dispatch({
                    changes: fix.edits.map((e) => ({ from: clamp(e.from), to: clamp(e.to), insert: e.text })),
                    userEvent: "input.fix",
                  });
                },
              },
            ],
          }
        : {}),
    });
  }
  return out;
}

/** The completion source: the document is synced, then asked. Exported for
 *  tests, which build a CompletionContext by hand. */
export function tsCompletionSource(get: () => TsIntelligence | null) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const intel = get();
    if (!intel) return null;
    const word = ctx.matchBefore(/[\w$]*/);
    const before = ctx.state.doc.sliceString(Math.max(0, ctx.pos - 1), ctx.pos);
    // Unprompted, only after a member dot or inside a word: a popup on every
    // keystroke in a string literal is noise.
    if (!ctx.explicit && before !== "." && !(word && word.from < word.to)) return null;
    await intel.update(ctx.state.doc.toString());
    if (ctx.aborted) return null;
    const items = await intel.completions(ctx.pos);
    if (ctx.aborted || items.length === 0) return null;
    return {
      from: word && word.from < word.to ? word.from : ctx.pos,
      options: items.map((c) => ({
        label: c.label,
        type: KIND[c.kind] ?? "variable",
        ...(c.detail ? { detail: c.detail } : {}),
        boost: c.sortText.startsWith("1") ? 1 : 0,
      })),
      validFor: /^[\w$]*$/,
    };
  };
}

const KIND: Record<string, string> = {
  method: "method",
  property: "property",
  function: "function",
  keyword: "keyword",
  class: "class",
  interface: "interface",
  var: "variable",
  let: "variable",
  const: "constant",
  parameter: "variable",
  module: "namespace",
  type: "type",
  enum: "enum",
  "local var": "variable",
};

export function tsIntelligence(get: () => TsIntelligence | null, { debounceMs = 300 }: { debounceMs?: number } = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged) this.schedule();
      }
      schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.ask();
        }, debounceMs);
      }
      async ask(): Promise<void> {
        const intel = get();
        if (!intel) return;
        const doc = this.view.state.doc;
        try {
          await intel.update(doc.toString());
          const [diagnostics, inspections] = await Promise.all([intel.diagnostics(), intel.inspections()]);
          if (this.view.state.doc !== doc) return;
          this.view.dispatch({ effects: setTsDiagnostics.of(toDiagnostics(doc.length, diagnostics, inspections)) });
        } catch {
          /* the service said nothing; the last answer stands until the next edit */
        }
      }
      destroy(): void {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

  const hover = hoverTooltip(async (view, pos) => {
    const intel = get();
    if (!intel) return null;
    await intel.update(view.state.doc.toString());
    const h = await intel.hover(pos);
    if (!h) return null;
    return {
      pos: h.from,
      end: h.to,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-gl-hover";
        const sig = document.createElement("pre");
        sig.textContent = h.text;
        dom.appendChild(sig);
        if (h.documentation) {
          const doc = document.createElement("p");
          doc.textContent = h.documentation;
          dom.appendChild(doc);
        }
        return { dom };
      },
    };
  });

  // Completion is composed by the host (`autocompletion` with this source
  // and the snippets), so there is one popup with both in it.
  return [tsDiagnosticsField, plugin, hover, intelligenceTheme];
}

/** CodeMirror's own popups, in the app's tokens. Lives here rather than in
 *  editor.css because a stylesheet rule loses to the runtime-injected base
 *  (check:script-ide-layout). */
const intelligenceTheme = EditorView.theme(
  {
    ".cm-tooltip": {
      background: "var(--gl-panel)",
      border: "1px solid var(--gl-line)",
      borderRadius: "2px",
      color: "var(--gl-tx-1)",
      fontFamily: "var(--gl-mono)",
      fontSize: "12px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "2px 8px" },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "var(--gl-sel-bg)",
      color: "var(--gl-tx-1)",
    },
    ".cm-completionIcon": { opacity: "0.6" },
    ".cm-gl-hover": { maxWidth: "60ch", padding: "6px 8px" },
    ".cm-gl-hover pre": { margin: "0", whiteSpace: "pre-wrap", fontFamily: "var(--gl-mono)" },
    ".cm-gl-hover p": { margin: "6px 0 0", color: "var(--gl-tx-2)", fontFamily: "var(--gl-sans)", whiteSpace: "pre-wrap" },
    ".cm-diagnosticAction": {
      background: "transparent",
      border: "1px solid var(--gl-line-2)",
      borderRadius: "2px",
      color: "var(--gl-tx-1)",
      padding: "1px 6px",
      marginLeft: "8px",
      cursor: "pointer",
    },
  },
  { dark: true },
);
