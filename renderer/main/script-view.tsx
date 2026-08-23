// The Script tab's editor, as the rest of the renderer sees it.
//
// A thin, synchronously importable face over `script-editor-cm.tsx`, which
// is loaded with `import()` the first time a Script tab renders — CodeMirror
// is the renderer's largest dependency and the trainer, settings and URL
// strip windows never show a script. Until 2026-08-22 this file held a
// regex tokenizer and a transparent <textarea> over a highlighted <pre>; the
// two layers drifted whenever a line wrapped or the file scrolled (DECISIONS
// 2026-08-22), and nothing in that design could host a gutter, a diagnostic
// or a fold. Both views — read and edit — are now the same CodeMirror host
// with `readOnly` toggled, so run status and parse coverage show whether or
// not the user is editing.

import * as React from "react";

import type { ScriptCheckError, SourceRange } from "../lib/recorder-types";
import type { RunLineStatus, ScriptEditorHandle } from "./script-editor-cm";

export type { RunLineStatus, ScriptEditorHandle } from "./script-editor-cm";

const ScriptEditorCm = React.lazy(() => import("./script-editor-cm"));

export interface ScriptEditorProps {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  /** Problems the last pre-save check reported. A problem with a `line`
   *  becomes a diagnostic on that line; the rest are the host's to show. */
  errors?: ScriptCheckError[];
  /** Statements the parser cannot map, for the coverage gutter. */
  skippedRanges?: SourceRange[] | null;
  /** Run status by 1-based line. */
  runStatus?: Record<number, RunLineStatus>;
  onCaretLine?: (line: number) => void;
  ariaLabel?: string;
  /** The editor's handle, for a host that moves the caret (click a problem,
   *  land on its line). */
  handleRef?: React.Ref<ScriptEditorHandle>;
  /** Settings → Editor. Defaults match the store's. */
  lineWrap?: boolean;
  lineNumbers?: boolean;
  tabSize?: number;
}

const NO_ERRORS: ScriptCheckError[] = [];
const NO_STATUS: Record<number, RunLineStatus> = {};

export function ScriptEditor({
  value,
  onChange,
  readOnly = false,
  errors = NO_ERRORS,
  skippedRanges = null,
  runStatus = NO_STATUS,
  onCaretLine,
  ariaLabel = "Test script",
  handleRef,
  lineWrap = false,
  lineNumbers = true,
  tabSize = 2,
}: ScriptEditorProps): React.ReactElement {
  return (
    <React.Suspense fallback={<div className="gl-script-ide-loading">Loading the editor…</div>}>
      <ScriptEditorCm
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        errors={errors}
        skippedRanges={skippedRanges}
        runStatus={runStatus}
        onCaretLine={onCaretLine}
        ariaLabel={ariaLabel}
        handleRef={handleRef}
        lineWrap={lineWrap}
        lineNumbers={lineNumbers}
        tabSize={tabSize}
      />
    </React.Suspense>
  );
}

/** Character offset of the START of a 1-based line in `value`, clamped. Kept
 *  for callers that address a script by line without an editor mounted. */
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
