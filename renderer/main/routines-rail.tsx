// The rail, when the Routines screen is open. REDESIGN §7.1.
//
// §7.1 gives the rail a third job: it lists the library, it lists Settings'
// panes, and here it lists saved Routines. That is the pattern the redesign
// already establishes — one surface, context-dependent content — so it costs no
// new chrome.
//
// IT REPLACES THE LIBRARY RATHER THAN SITTING ABOVE IT. Two lists in one rail
// makes the rail a screen of its own, and the thing being navigated on this
// screen is jobs, not tests. Nothing is lost by the swap: the checklist's own
// rows still open a test, which is the only reason the library was reachable
// from here in the first place.
//
// The row's subtitle is a COUNT, not a name list. "3 tests" is the fact you
// need to tell two jobs apart at a glance; three truncated test names in a
// 240px rail is a list you cannot read pretending to be a summary.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { toast } from "@ui";

import { RailEmpty, RailRow } from "../theme";
import { api } from "../lib/api";
import { createRoutine, randomSuffix } from "../lib/create-routine";
import { useRecorder } from "./recorder-store";
import type { Routine } from "../lib/recorder-types";

/** What the rail's `+` does while Routines is open. Exported so the sidebar can
 *  wire its header button to the same action the empty state offers. */
export function useCreateRoutine(): () => void {
  const qc = useQueryClient();
  const { setOpenRoutineId } = useRecorder();

  // FETCHED AT CLICK TIME, not subscribed to. This hook is called by the rail,
  // which renders on EVERY screen, while the button it feeds exists on one — so
  // standing `useQuery` subscriptions here would keep two queries alive on six
  // screens that never use them. Reading at the moment of the click is also the
  // more correct answer for the name: it is unique against the list as it is
  // now, not as it was when the rail last rendered.
  return React.useCallback(() => {
    void (async () => {
      try {
        const [routines, settings] = await Promise.all([
          qc.fetchQuery({ queryKey: ["routines"], queryFn: api.routines.list }),
          qc.fetchQuery({
            queryKey: ["recorder-settings"],
            queryFn: () => api.recorder.getSettings(),
          }),
        ]);
        const created = await createRoutine(routines, settings, Date.now(), randomSuffix());
        await qc.invalidateQueries({ queryKey: ["routines"] });
        // Opened immediately. A new job that does not become the one on screen
        // is a row that appeared in a list for no visible reason.
        if (created) setOpenRoutineId(created.id);
      } catch {
        toast.error("Could not create a routine.");
      }
    })();
  }, [qc, setOpenRoutineId]);
}

export function RoutinesRail(): React.ReactElement {
  const { openRoutineId, setOpenRoutineId } = useRecorder();
  const { data: routines = [] } = useQuery({ queryKey: ["routines"], queryFn: api.routines.list });

  if (routines.length === 0) {
    return <RailEmpty>No routines yet. Click + to make one.</RailEmpty>;
  }

  // The same order the picker uses, which is the store's: oldest first. A rail
  // and a picker listing one set of jobs in two orders is two lists.
  return (
    <>
      {routines.map((r: Routine) => (
        <RailRow
          key={r.id}
          icon={<ListChecks aria-hidden="true" />}
          title={r.name}
          subtitle={r.steps.length === 1 ? "1 test" : `${r.steps.length} tests`}
          // FALLS BACK TO THE FIRST when nothing has been chosen this session,
          // because that is what the view opens — a rail showing no selection
          // beside a screen that is plainly editing something reads as the two
          // disagreeing about what you are looking at.
          selected={(openRoutineId ?? routines[0].id) === r.id}
          onClick={() => setOpenRoutineId(r.id)}
        />
      ))}
    </>
  );
}
