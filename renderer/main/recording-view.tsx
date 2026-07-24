import {
  Button,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Status,
  Text,
  Toolbar,
  ToolbarActions,
  ToolbarContent,
  ToolbarTitle,
} from "@glaze/core/components";
import { Eye, Pause, Play, Type, X } from "lucide-react";

import type { AssertKind } from "../lib/recorder-types";
import { useRecorder } from "./recorder-store";
import { StepRow } from "./step-row";

export function RecordingView() {
  const { state, liveSteps, pause, resume, stop, setAssert, deleteStep } = useRecorder();

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Recording</ToolbarTitle>
        </ToolbarContent>
        <ToolbarActions>
          <Button variant="destructive" onClick={stop}>
            Stop &amp; generate
          </Button>
        </ToolbarActions>
      </Toolbar>

      <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
        <Status variant={state.paused ? "warning" : "error"}>
          {state.paused ? "Paused" : "Recording"}
        </Status>
        <Text variant="small" color="secondary" truncate className="min-w-0">
          {state.url}
        </Text>
        <div className="ml-auto shrink-0">
          {state.paused ? (
            <Button size="small" onClick={resume}>
              <Play className="size-4" /> Resume
            </Button>
          ) : (
            <Button size="small" onClick={pause}>
              <Pause className="size-4" /> Pause
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-separator px-4 py-2">
        <Text variant="small" color="secondary" className="shrink-0">
          Add assertion:
        </Text>
        <SegmentedControl
          type="single"
          size="small"
          value={state.assertMode ?? ""}
          onValueChange={(v) => setAssert(v === state.assertMode ? null : (v as AssertKind))}
        >
          <SegmentedControlItem value="visible">
            <Eye className="size-4" /> Visible
          </SegmentedControlItem>
          <SegmentedControlItem value="text">
            <Type className="size-4" /> Has text
          </SegmentedControlItem>
        </SegmentedControl>
        {state.assertMode ? (
          <>
            <Text variant="small" color="blue" className="shrink-0">
              Click an element in the browser…
            </Text>
            <Button
              iconOnly
              variant="transparent"
              size="small"
              onClick={() => setAssert(null)}
              aria-label="Cancel assertion"
            >
              <X className="size-4" />
            </Button>
          </>
        ) : null}
      </div>

      <ScrollArea
        className="min-h-0 flex-1"
        autoScrollToBottom
        autoScrollDeps={[liveSteps.length]}
      >
        <div className="flex flex-col gap-1 p-3">
          {liveSteps.length === 0 ? (
            <Text variant="small" color="secondary">
              Interact with the site — steps appear here as you go.
            </Text>
          ) : (
            liveSteps.map((s, i) => (
              <StepRow key={s.id} index={i} step={s} onDelete={() => deleteStep(s.id)} />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
