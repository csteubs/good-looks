// The home screen.  docs/REDESIGN.md §B1.
//
// What this screen is for has not changed: it is what you see with nothing
// selected, and its job is to get you to a first test. What changed is that it
// now also answers "how is the suite doing?" without a click, which is the one
// question someone opening a QA tool already has.
//
// THE THREE READOUTS ARE NOT DECORATION, and the rules they follow are the
// reason they can be trusted:
//
//   • They read the SAME query keys the rest of the app does — `["tests"]`,
//     `["runs"]`, `["heals", "all"]` — so they cost nothing extra and can never
//     disagree with the screen you navigate to. A home screen with its own
//     count of anything is a home screen that is eventually wrong.
//   • A number nothing supports renders as "—", never as 0. "0% green" with no
//     runs in the window is a claim about a week that did not happen, and it is
//     the one reading here that would send someone looking for a bug.
//   • EACH ONE IS THE DOOR TO THE VIEW THAT EXPLAINS IT. A count on a home
//     screen is a question ("16 to review — which?"), and the answer is a view
//     the app already has; leaving it un-navigable makes the reader go find the
//     rail entry that means the same thing. `STAT_DESTINATIONS` is the whole
//     mapping, in one place, because it is expected to move as the readouts do.
//
// The wordmark's `echo` treatment lives in screens.css and needs `data-text` —
// see the note there for why the ghosts are pseudo-elements and why they are
// drawn in ink rather than in red and cyan.

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { Btn, WORDMARK } from "../theme";
import { api } from "../lib/api";
import { BlackHoleLoader } from "./black-hole-loader";
import { NewRecordingDialog } from "./new-recording-dialog";
import { GenerateTestDialog } from "./generate-test-dialog";
import { useDisabledEnhancements } from "../lib/use-disabled-enhancements";

/** The window the pass rate is measured over. Seven days because that is what
 *  the label says, and the two must be changed together. */
const GREEN_WINDOW_DAYS = 7;

/** Pass rate over the last week, or null when nothing ran in it.
 *
 *  Exported for its test: the empty case is the whole risk here, and it is
 *  invisible from the screen — 0% and "nothing ran" look like the same fact
 *  until you go looking for the failure that never happened. */
export function greenRate(
  runs: { status: string; startedAt: number; kind?: string }[],
  now: number,
): number | null {
  const since = now - GREEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // Baseline updates are excluded, exactly as they are in Stats: accepting a
  // new screenshot is not a run and has no verdict to average in.
  const recent = runs.filter((r) => r.startedAt >= since && r.kind !== "baseline-update");
  if (recent.length === 0) return null;
  const passed = recent.filter((r) => r.status === "passed").length;
  return Math.round((passed / recent.length) * 100);
}

/** Where a readout takes you, and what the destination is called out loud.
 *
 *  The pairing is the whole point of this table: a number on the home screen is
 *  a question, and the view that answers it is the one it navigates to. `to` is
 *  a literal route path the router already registers — a typo is a type error
 *  rather than a dead click, which is why this is a `const` and not `string`.
 *
 *  This mapping is expected to move as the home screen's readouts change. It is
 *  in one place so that when it does, the tests that pin it fail in one place
 *  too. */
const STAT_DESTINATIONS = {
  // Tests → Batch, not the library: the rail already lists every test one click
  // away, so "22 tests" is only interesting as something to DO — and running
  // them together is the one action the count itself suggests.
  tests: { to: "/batch", view: "Batch" },
  green: { to: "/stats", view: "Stats" },
  heals: { to: "/heals", view: "Heals" },
} as const;

type StatKey = keyof typeof STAT_DESTINATIONS;

/** One readout, and the navigation it carries.
 *
 *  A REAL `<button>`, not a div with an `onClick`. Everything that makes this
 *  usable without a mouse — tab order, Enter and Space, the "button" a screen
 *  reader announces, the focus ring — comes free from the element and from
 *  nothing else; a clickable div reproduces none of it and looks identical.
 *
 *  The accessible name says the destination, because the visible text cannot.
 *  "22 Tests" read aloud is a fact, not a control, and a button whose name is a
 *  fact gives no reason to press it. */
function Stat({
  value,
  label,
  stat,
  onNavigate,
}: {
  value: string;
  label: string;
  stat: StatKey;
  onNavigate: (stat: StatKey) => void;
}) {
  const { view } = STAT_DESTINATIONS[stat];
  return (
    <button
      type="button"
      className="gl-home-stat"
      // `label: value` rather than the visual order, so the readout names
      // itself before it reads a number that means nothing without it.
      aria-label={`${label}: ${value}, opens the ${view} view`}
      onClick={() => onNavigate(stat)}
    >
      <span className="gl-home-stat-value">{value}</span>
      <span className="gl-home-stat-label">{label}</span>
    </button>
  );
}

export function HomeView() {
  const navigate = useNavigate();
  const disabledEnhancements = useDisabledEnhancements();
  const animationEnabled = !disabledEnhancements.has("homeBlackHole");
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [generateOpen, setGenerateOpen] = React.useState(false);

  // All three share the caches the rail and the views already fill, so on any
  // navigation back to home they are already resolved.
  const tests = useQuery({ queryKey: ["tests"], queryFn: api.tests.list }).data;
  const runs = useQuery({ queryKey: ["runs"], queryFn: api.runs.list }).data;
  const heals = useQuery({ queryKey: ["heals", "all"], queryFn: api.heals.listAll }).data;

  // `Date.now()` at render rather than a memo: this is read once per paint and
  // a stale window boundary is a wrong number for no benefit.
  const green = runs === undefined ? null : greenRate(runs, Date.now());
  const toReview = heals?.filter((h) => h.status === "pending").length;

  const goTo = React.useCallback(
    (stat: StatKey) => {
      navigate({ to: STAT_DESTINATIONS[stat].to });
    },
    [navigate],
  );

  return (
    <div className="gl-home">
      <div className="gl-home-plate" aria-hidden="true" />
      <div className="gl-home-col">
        {/* The one flourish this screen kept, still behind its Settings toggle.
            Always the dark ink drawing — the app is dark only (REDESIGN §0), so
            the variant switch has nothing left to follow.
     *
     * 280, down from 440, and the number is load-bearing rather than taste. The
     * column is centred but scrolls when it outgrows the pane, so anything too
     * tall pushes the two BUTTONS below the fold — at a 700px window the old
     * size did exactly that, which puts the screen's whole purpose behind a
     * scroll on an ordinary laptop. It also makes the wordmark the largest
     * thing here, which is what the design asks for. */}
        {animationEnabled ? <BlackHoleLoader size={280} dark /> : null}

        {/* `data-text` feeds the two echo ghosts in screens.css. They are
            pseudo-elements, so the string is in the DOM once and announced
            once. */}
        <h1 className="gl-home-mark gl-echo" data-text={WORDMARK}>
          {WORDMARK}
        </h1>

        <p className="gl-home-copy">
          Record a website the way you would use it — every click, input and navigation becomes a
          test step, then a Playwright script you can run.
        </p>

        {/* Each readout is the door to the view it counts. They stay pressable
            while the value is still "—": a query that has not resolved is not a
            reason to refuse navigation, and a control that appears only once
            data lands is one people learn is not there. */}
        <div className="gl-home-stats">
          <Stat
            stat="tests"
            onNavigate={goTo}
            value={tests === undefined ? "—" : String(tests.length)}
            label="Tests"
          />
          <Stat
            stat="green"
            onNavigate={goTo}
            value={green === null ? "—" : `${green}%`}
            label="Green · 7d"
          />
          <Stat
            stat="heals"
            onNavigate={goTo}
            value={toReview === undefined ? "—" : String(toReview)}
            label="Heals to review"
          />
        </div>

        <div className="gl-home-actions">
          {/* "RECORD A TEST", where the mockup's label reads "Run a test".
              Deliberate, and the reason is that the mockup's is a control this
              screen cannot honour: nothing is selected here, so "run" has no
              object — it would need a test picker the design does not draw, or
              it would do nothing. Recording IS the primary action from an empty
              home, it is what this screen's copy has always told people to do,
              and it is the entry point the whole app is built around. */}
          <Btn tone="go" onClick={() => setRecordOpen(true)}>
            Record a test
          </Btn>
          <Btn tone="ghost" onClick={() => setGenerateOpen(true)}>
            Generate from prompt
          </Btn>
        </div>
      </div>

      {/* The same two dialogs the rail's + menu opens. Mounted again rather
          than lifted to a provider: both are fully controlled and render
          nothing while closed, so a second instance costs one boolean, and
          hoisting them would put two screens' state in a component that is
          neither. */}
      <NewRecordingDialog open={recordOpen} onOpenChange={setRecordOpen} />
      <GenerateTestDialog open={generateOpen} onOpenChange={setGenerateOpen} />
    </div>
  );
}
