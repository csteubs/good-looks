// The per-step progress marker: one spelling of the line, and the parser that
// takes it back out of a run's stdout.
//
// THREE places write this line and one reads it, which is why the prefix is a
// module rather than a literal in each: the Playwright reporter
// (step-reporter-source.ts), the capture fixture's action wrapper
// (capture-fixture-source.ts), and `splitStepMarkers` below. A fourth writer
// spelling it differently would not fail loudly — it would print the raw
// marker into the user's Output panel and report no progress at all.
//
// Pure: no fs, no IPC, no shell import. The runner owns the stream; this owns
// what a line of it MEANS.

/** Prefix identifying a progress line on a run's stdout. */
export const STEP_MARKER = "__GLAZE_STEP__:";

/** One step transition, as the runner uses it. `title` is deliberately not
 *  carried: nothing consumes it, and it is the only field that can contain
 *  page-derived text. */
// The two shapes this module speaks are declared in step-marker.d.mts:
//   StepMarker  { event: "begin" | "end"; line: number; ok: boolean }
//   StdoutSplit { visible: string; markers: StepMarker[]; rest: string }
// `line` is 1-based and maps to a step index in the runner; `ok` is false only
// on a reported failure, and a `begin` is always true. `rest` is the trailing
// partial line, handed back in as `buffered` next time.

/**
 * Validate one marker payload.
 *
 * Strict about both fields, because this is not a trusted channel end to end:
 * the marker travels on the same stdout as Playwright's own output, which
 * quotes page-controlled text (a locator's inner text, an assertion's received
 * value). A page cannot execute anything through this, but a page that echoed a
 * well-formed marker could otherwise move the highlight, so a payload that
 * isn't exactly a step transition is dropped rather than coerced.
 */
function parseStepMarker(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { event, line, ok } = raw;
  if (event !== "begin" && event !== "end") return null;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  // Absent means "fine" — a `begin` never carries one.
  return { event, line, ok: ok === undefined ? true : ok === true };
}

/**
 * Split one stdout chunk into visible output and step transitions.
 *
 * Two things make this less trivial than a `startsWith` over the lines:
 *
 *  • A marker can straddle chunk boundaries, so the trailing partial line is
 *    handed back as `rest` and passed in again with the next chunk.
 *  • A marker does not always START its line. Playwright's `line` reporter
 *    writes its cursor-control prefix — ESC[1A ESC[2K, written here in that
 *    notation rather than as the bytes themselves — with no trailing newline,
 *    and a marker written from the WORKER process — which is where the
 *    capture fixture runs — lands directly after it. Anchoring on the start of
 *    the line drops those, and then prints them to the user instead.
 *
 * Markers are stripped whether or not the caller can map them. A run with no
 * line map would otherwise show raw `__GLAZE_STEP__:` lines in its output.
 */
export function splitStepMarkers(buffered, chunk) {
  const lines = (buffered + chunk).split("\n");
  // Last element is the partial trailing line (no trailing newline) — hold it.
  const rest = lines.pop() ?? "";
  let visible = "";
  const markers = [];
  for (const line of lines) {
    const at = line.indexOf(STEP_MARKER);
    if (at === -1) {
      visible += line + "\n";
      continue;
    }
    // Whatever preceded the marker on this line is ordinary output that was
    // interrupted mid-line, so it is re-emitted WITHOUT a newline — it never
    // had one, and adding one puts a blank line in the middle of the log.
    if (at > 0) visible += line.slice(0, at);
    const marker = parseStepMarker(line.slice(at + STEP_MARKER.length));
    if (marker) markers.push(marker);
  }
  return { visible, markers, rest };
}
