import { EmptyState, Toolbar, ToolbarContent, ToolbarTitle } from "@glaze/core/components";

export function HomeView() {
  return (
    <div className="relative flex h-full flex-col">
      <Toolbar>
        <ToolbarContent>
          <ToolbarTitle> </ToolbarTitle>
        </ToolbarContent>
      </Toolbar>
      <EmptyState
        title="Record a Playwright test"
        description="Click the + in the sidebar, enter a website, and interact with it. Every click, input, and navigation becomes a test step — then generate and run a Playwright script."
      />
    </div>
  );
}
