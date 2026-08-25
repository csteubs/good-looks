/** One step transition, as reported on stdout by the reporter. */
export interface StepMarker {
  event: "begin" | "end";
  /** 1-based line in the spec that ran — mapped to a step index by the runner. */
  line: number;
  /** False only on a reported failure. A `begin` is always true. */
  ok: boolean;
}

export interface StdoutSplit {
  /** The chunk with every marker removed — what the user should see. */
  visible: string;
  markers: StepMarker[];
  /** Trailing partial line, to be passed back in as `buffered` next time. */
  rest: string;
}

export declare const STEP_MARKER: string;

/** Split a stdout chunk into visible text and step markers. NOT a trusted
 *  channel end to end: markers travel on the same stdout as Playwright's own
 *  output, which quotes page-controlled text, so a payload that is not exactly
 *  a step transition is dropped rather than coerced. */
export declare function splitStepMarkers(buffered: string, chunk: string): StdoutSplit;
