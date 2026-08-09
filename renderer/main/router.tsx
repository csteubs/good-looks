import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { BatchView } from "./batch-view";
import { BranchesView } from "./branches-view";
import { HomeView } from "./home-view";
import { RootView } from "./root-view";
import { HealsView } from "./heals-view";
import { StatsView } from "./stats-view";
import { TestDetailView } from "./test-detail-view";
import { VisualView } from "./visual-view";
import { QueryClient } from "@tanstack/react-query";
import { ErrorBoundaryView } from "@ui";

const rootRoute = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootView,
  errorComponent: ErrorBoundaryView,
  notFoundComponent: () => {
    return (
      // Same removed overlay as in root-view.tsx, for the same reason: the main
      // window has a native title bar, and a full-width `fixed` drag strip here
      // only steals clicks from whatever sits under the top 52px.
      <div className="flex flex-col items-center justify-center h-screen">
        <p className="text-secondary">Route not found</p>
      </div>
    );
  },
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeView,
  staticData: {
    title: "Home",
  },
});

const testRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/test/$id",
  component: TestDetailView,
  staticData: {
    title: "Test",
  },
});

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats",
  component: StatsView,
  staticData: {
    title: "Stats",
  },
});

const visualRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/visual",
  component: VisualView,
  staticData: {
    title: "Visual",
  },
});

const batchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/batch",
  component: BatchView,
  staticData: {
    title: "Batch",
  },
});

const healsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/heals",
  component: HealsView,
  staticData: {
    title: "Heals",
  },
});

/** The branch switcher. Registered unconditionally — the route is cheap and the
 *  view explains itself when the feature is unavailable — while the SIDEBAR
 *  entry is what's conditional, so there is no dead end to navigate into. */
const branchesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/branches",
  component: BranchesView,
  staticData: {
    title: "Branches",
  },
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  testRoute,
  statsRoute,
  visualRoute,
  batchRoute,
  healsRoute,
  branchesRoute,
]);

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  history: createMemoryHistory(),
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  context: {
    queryClient,
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    title?: string;
    component?: any;
  }
}

export { router, queryClient };
