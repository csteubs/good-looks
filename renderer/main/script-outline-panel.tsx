// The Script tab's outline: the parsed steps as a filterable list that jumps
// the caret, and — for the step under the caret — where else in the library
// its locator is used. One panel, two lists, because both answer "where is
// this" about the script the user is reading.

import * as React from "react";

import { findLocatorUsages, type LocatorUsage } from "../lib/find-usages";
import { describeStep } from "../lib/describe-step";
import type { Locator, SourceRange, Step, TestRecord } from "../lib/recorder-types";
import { Btn } from "../theme";

export interface ScriptOutlinePanelProps {
  /** The parsed steps and their statements, aligned. */
  steps: readonly Step[];
  stepRanges: readonly SourceRange[];
  script: string;
  /** The step under the caret, when the caret is on one. */
  caretIndex: number | null;
  /** The library, for Find Usages. */
  tests: readonly TestRecord[];
  currentTestId: string;
  onJumpToLine: (line: number) => void;
  onOpenTest: (testId: string) => void;
  onClose: () => void;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < Math.min(offset, text.length); i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function ScriptOutlinePanel(props: ScriptOutlinePanelProps): React.ReactElement {
  const { steps, stepRanges, script, caretIndex, tests, currentTestId, onJumpToLine, onOpenTest, onClose } = props;
  const [filter, setFilter] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => inputRef.current?.focus(), []);

  const rows = React.useMemo(
    () =>
      steps
        .map((step, index) => ({ index, step, label: describeStep(step), line: stepRanges[index] ? lineOf(script, stepRanges[index].from) : null }))
        .filter((r) => !filter.trim() || r.label.toLowerCase().includes(filter.trim().toLowerCase())),
    [steps, stepRanges, script, filter],
  );

  const caretLocator: Locator | null = caretIndex !== null ? (steps[caretIndex]?.locator ?? null) : null;
  const usages: LocatorUsage[] = React.useMemo(
    () => (caretLocator ? findLocatorUsages(tests, caretLocator).filter((u) => !(u.testId === currentTestId && u.stepIndex === caretIndex)) : []),
    [caretLocator, tests, currentTestId, caretIndex],
  );

  return (
    <section
      className="gl-script-outline"
      role="region"
      aria-label="Script outline"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="gl-script-outline-head">
        <input
          ref={inputRef}
          className="gl-script-outline-filter"
          aria-label="Filter steps"
          placeholder="Go to step…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows[0]?.line) {
              e.preventDefault();
              onJumpToLine(rows[0].line);
              onClose();
            }
          }}
        />
        <span className="gl-script-outline-count">
          {steps.length === 0 ? "no steps" : `${rows.length} of ${steps.length} steps`}
        </span>
        <Btn onClick={onClose} aria-label="Close">
          Close
        </Btn>
      </div>
      <ol className="gl-script-outline-list" aria-label="Steps">
        {rows.map((r) => (
          <li key={r.index}>
            <button
              type="button"
              className="gl-script-outline-row"
              aria-current={r.index === caretIndex ? "true" : undefined}
              disabled={r.line === null}
              onClick={() => {
                if (r.line !== null) onJumpToLine(r.line);
              }}
            >
              <span className="gl-script-outline-num">{r.index + 1}</span>
              <span>{r.label}</span>
              {r.line !== null ? <span className="gl-script-outline-line">L{r.line}</span> : null}
            </button>
          </li>
        ))}
      </ol>
      {caretLocator ? (
        <div className="gl-script-outline-usages" data-gl="usages">
          <div className="gl-script-outline-head">
            <span className="gl-script-outline-count">
              {usages.length === 0
                ? "This locator is used nowhere else in the library."
                : usages.length === 1
                  ? "This locator is used in 1 other step:"
                  : `This locator is used in ${usages.length} other steps:`}
            </span>
          </div>
          {usages.length > 0 ? (
            <ul className="gl-script-outline-list" aria-label="Usages">
              {usages.map((u) => (
                <li key={`${u.testId}:${u.stepIndex}`}>
                  <button type="button" className="gl-script-outline-row" onClick={() => onOpenTest(u.testId)}>
                    <span className="gl-script-outline-num">{u.stepIndex + 1}</span>
                    <span>
                      {u.testId === currentTestId ? "this test" : u.testName} · {u.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
