// The job ticker in the top strip. REDESIGN §6.8.
//
// The last of `top-strip.tsx`'s two owed slots. It answers "is anything
// happening?" from any screen, which is a question the app could not answer
// away from the screen the work was started on: run state lives in
// `recorder-store` (mounted for the whole session) but batch state lived in
// `batch-view` (a route component), so a batch you started and walked away from
// was invisible from everywhere except the page you had left. §6.8 moved the
// live batch onto the store, which is the answer to REDESIGN §10's open
// question 2: the ticker's data source is the store — not a new provider, and
// not a poll.
//
// IT IS A BUTTON, because every reading it can show has somewhere to go. A
// readout that names a running test and cannot take you to it makes the user do
// the navigating twice: once with their eyes, once with the rail.
//
// The decision of WHAT to say is in `renderer/lib/job-ticker.ts`, pure and
// tested there. This file is the subscription and the markup.

import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { summariseJobs, type TickerReading } from "../lib/job-ticker";
import { useRecorder } from "./recorder-store";

/**
 * How often the reading is recomputed with nothing else happening.
 *
 * THE FAILURE HOLD IS THE ONLY REASON THIS EXISTS. Every other transition
 * arrives as a push and re-renders on its own; a held failure has to go away on
 * a clock, and without a tick it would sit in the strip until the next unrelated
 * render happened to clear it — which on an idle app is never. One second is
 * finer than the eye needs for a twelve-second hold and cheap enough to run
 * while nothing is going on.
 */
const TICK_MS = 1_000;

export function JobTicker(): React.ReactElement | null {
  const { runs, liveBatch } = useRecorder();
  const navigate = useNavigate();
  const [now, setNow] = React.useState(() => Date.now());

  // Shares the ["tests"] cache the rail and the breadcrumb already load, so
  // naming a running test costs nothing. `select` narrows it to a lookup, so a
  // change to an unrelated test's record does not re-render the strip.
  const nameById = useQuery({
    queryKey: ["tests"],
    queryFn: api.tests.list,
    select: (tests) => {
      const map: Record<string, string> = {};
      for (const t of tests) map[t.id] = t.name;
      return map;
    },
  }).data;

  const anythingPending = Object.keys(runs).length > 0 || liveBatch !== null;
  React.useEffect(() => {
    // Nothing has ever run in this session — there is no hold to expire and no
    // reason to tick.
    if (!anythingPending) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [anythingPending]);

  const reading = summariseJobs({
    runs,
    batch: liveBatch,
    nameOf: (id) => nameById?.[id] ?? null,
    now,
  });

  if (reading === null) return null;

  const go = () => {
    if (reading.kind === "batch") {
      void navigate({ to: "/batch" });
      return;
    }
    const testId = reading.kind === "several" ? null : reading.testId;
    if (testId) void navigate({ to: "/test/$id", params: { id: testId } });
    // "Several running" has no single destination and deliberately does not
    // guess one. Batch is where several-at-once normally comes from, and
    // sending someone there when it is not a batch would be a lie about what
    // they are looking at.
  };

  const inert = reading.kind === "several";

  return (
    <button
      type="button"
      className="gl-ticker"
      data-tone={reading.tone}
      data-kind={reading.kind}
      // A control that goes nowhere should not offer to. `several` still
      // renders — the reading is the point — it just is not a link.
      disabled={inert}
      onClick={go}
      title={inert ? reading.label : `${reading.label} — open`}
    >
      <span className="gl-ticker-dot" aria-hidden />
      <span className="gl-ticker-label">{reading.label}</span>
    </button>
  );
}

/** Exported for the tests, which assert the SENTENCE the strip shows rather
 *  than re-deriving it from the store. */
export type { TickerReading };
