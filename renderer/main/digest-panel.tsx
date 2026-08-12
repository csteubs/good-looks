// The weekly read, at the top of Stats. REDESIGN §6.5.
//
// WHY THIS IS AT THE TOP AND EVERYTHING ELSE IS BELOW IT. The six panels under
// this one are tables and breakdowns — cost, suite cost, step health, flake,
// divergence, capture overhead. Each answers a question you already knew you
// had. This answers the one you arrive with, in the two seconds before you know
// which panel you want, and a summary underneath the detail it summarises is a
// summary nobody reads.
//
// It renders NOTHING when there is no history at all. A digest of an app that
// has never run anything is a paragraph explaining that it is empty, printed
// above six panels that also say so.
//
// The sentences are decided in `renderer/lib/weekly-digest.ts` and tested there.
// This is the markup.

import * as React from "react";
import { Text } from "@ui";

import { weeklyDigest } from "../lib/weekly-digest";
import type { RunRecord } from "../lib/recorder-types";

export function DigestPanel({ runs }: { runs: readonly RunRecord[] }): React.ReactElement | null {
  // Read once per mount rather than per render. The week boundary only matters
  // to the day, and a clock read in the render body makes the component's
  // output depend on when React happened to re-run it.
  const [now] = React.useState(() => Date.now());
  const digest = React.useMemo(() => weeklyDigest(runs, now), [runs, now]);

  if (runs.length === 0) return null;

  return (
    <section className="gl-digest" aria-label="This week">
      <span className="gl-digest-label">This week</span>
      <div className="gl-digest-lines">
        {digest.lines.map((line, i) => (
          <Text
            key={line}
            variant="small"
            // The FIRST line is the headline and carries the reading; the rest
            // qualify it. Rendering them all at one weight makes the reader
            // find the subject themselves, every time.
            color={i === 0 ? "primary" : "secondary"}
            className="gl-digest-line"
          >
            {line}
          </Text>
        ))}
      </div>
    </section>
  );
}
