/** A tab the run's browser opened, reported on the same stdout channel by
 *  the tabs fixture. Not a step: it carries no line, and the runner files it
 *  under whichever step is running. */
export interface TabMarker {
  event: "tab";
  /** How many tabs were open at that moment, the new one included. */
  count: number;
  attempt: number;
}

/** One step transition, as reported on stdout by the reporter. */
export interface StepMarker {
  event: "begin" | "end";
  /** 1-based line in the spec that ran — mapped to a step index by the runner. */
  line: number;
  /** False only on a reported failure. A `begin` is always true. */
  ok: boolean;
  /** Which of Playwright's attempts at this test the transition belongs to.
   *  0 unless `retries` is on, and 0 for a marker from a writer that predates
   *  the field — the runner keys per-step outcomes by this, so an attempt that
   *  failed and one that then passed no longer overwrite each other (R24a). */
  attempt: number;
}

export interface StdoutSplit {
  /** The chunk with every marker removed — what the user should see. */
  visible: string;
  markers: StepMarker[];
  /** Tabs the browser opened, in order. Beside the transitions rather than
   *  among them: every reader of `markers` indexes a step by `line`. */
  tabs: TabMarker[];
  /** Trailing partial line, to be passed back in as `buffered` next time. */
  rest: string;
}

export declare const STEP_MARKER: string;

/** Split a stdout chunk into visible text and step markers. NOT a trusted
 *  channel end to end: markers travel on the same stdout as Playwright's own
 *  output, which quotes page-controlled text, so a payload that is not exactly
 *  a step transition is dropped rather than coerced. */
export declare function splitStepMarkers(buffered: string, chunk: string): StdoutSplit;
