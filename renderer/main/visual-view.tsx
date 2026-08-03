import { EmptyState, Toolbar, ToolbarContent, ToolbarTitle } from "@glaze/core/components";

// Placeholder for the visual-testing layer (screenshot capture, diffing,
// replay timeline, annotations) described in the roadmap. Phase 0 ships only
// the nav entry + this empty state; real content lands in later phases.
export function VisualView() {
  return (
    <div className="relative flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle>Visual</ToolbarTitle>
        </ToolbarContent>
      </Toolbar>
      <EmptyState
        title="Visual testing is coming soon"
        description="Turn on “Capture screenshots” when you run a test to start recording artifacts. Replay, visual diffing, and timeline annotations will appear here in an upcoming release."
      />
    </div>
  );
}
