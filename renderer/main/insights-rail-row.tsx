// The Insights entry in the rail's Views group, with its unread dot.
//
// Always visible, unlike the Branches row beside it: Branches is a tool for
// whoever builds the app, while this is a product surface — hiding it until
// the feature is enabled would make Settings → Alerts the only place the
// feature can be discovered. The view explains itself when reports are off.
//
// The dot rides `RailRow`'s `accessory` slot (rail.tsx names exactly this
// use) and reads the same ["insight-reports"] cache the view reads, which is
// invalidated by the `insights:changed` subscription in RecorderProvider —
// mounted for the whole session, so the dot updates from ANY route the moment
// a scheduled report lands. That placement is the point of the dot: the
// report generates while the user is somewhere else.

import { useQuery } from "@tanstack/react-query";
import { Newspaper } from "lucide-react";

import { RailRow } from "../theme";
import { api } from "../lib/api";

export function InsightsRailRow({
  selected,
  onOpen,
}: {
  selected: boolean;
  onOpen: () => void;
}) {
  const summaries = useQuery({
    queryKey: ["insight-reports"],
    queryFn: () => api.insights.list(),
  });
  const unread = (summaries.data ?? []).filter((s) => !s.read).length;
  return (
    <RailRow
      icon={<Newspaper aria-hidden="true" />}
      title="Insights"
      subtitle="Scheduled AI reports"
      selected={selected}
      onClick={onOpen}
      hint={unread > 0 ? `${unread} unread report${unread === 1 ? "" : "s"}` : undefined}
      accessory={
        unread > 0 ? (
          // Cyan, never phos: an unread report is waiting on you, not a pass.
          <span className="gl-insights-unread gl-insights-unread-rail" aria-label="Unread reports" />
        ) : undefined
      }
    />
  );
}
