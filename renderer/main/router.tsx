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
import { StatsCategoryView } from "./stats/stats-category-view";
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

/** A category's dashboard, and the leaf below it.
 *
 *  REAL ROUTES RATHER THAN A DRILL STACK INSIDE THE VIEW, and the reason is the
 *  top strip: the app already has one surface that says where you are, and one
 *  history that back and forward operate on. A stack held in `stats-view.tsx`
 *  would build a second of each — the strip would keep saying "Stats" three
 *  levels down, re-entering from the rail would silently reset the trail, and
 *  drilling out to a test would lose it. See docs/plans/stats-categories.md §5.
 *
 *  `$category` and `$facet` are strings out of history and are NOT trusted: the
 *  view checks them against the registry and renders an explained empty state
 *  for anything else. */
const statsCategoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats/$category",
  component: StatsCategoryView,
  staticData: {
    title: "Stats",
  },
});

const statsFacetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stats/$category/$facet",
  component: StatsCategoryView,
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
  // The path stays `/batch` on purpose — see the rename table in
  // docs/ROUTINES.md. Only the word the user reads changes.
  path: "/batch",
  component: BatchView,
  staticData: {
    title: "Routines",
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
  statsCategoryRoute,
  statsFacetRoute,
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
