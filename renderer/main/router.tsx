import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { A11yView } from "./a11y-view";
import { BatchView } from "./batch-view";
import { BranchesView } from "./branches-view";
import { HomeView } from "./home-view";
import { RootView } from "./root-view";
import { HealsView } from "./heals-view";
import { InsightsView } from "./insights-view";
import { StatsView } from "./stats-view";
import { StatsCategoryView } from "./stats/stats-category-view";
import { SettingsPaneView, SettingsView } from "../settings/settings-view";
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

const a11yRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/a11y",
  component: A11yView,
  staticData: {
    title: "Accessibility",
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

const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/insights",
  component: InsightsView,
  staticData: {
    title: "Insights",
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

/** Settings, on the same shape as the Stats drill above and for the same
 *  reasons — see docs/plans/settings-view.md.
 *
 *  `/settings` is the board (every section, with what is in it) and
 *  `/settings/$pane` is one section. The third level exists for ONE PANE: the
 *  Documentation pane reads a topic, which the Help menu deep-links, and it was
 *  the second segment of a URL fragment (`#documentation/setup`) when Settings
 *  was a window. A param is the same fact with an address.
 *
 *  `$pane` and `$topic` are strings out of history and are NOT trusted: the
 *  view checks them against the pane registry and the shipped documents, and
 *  renders an explained empty state for anything else. */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
  staticData: {
    title: "Settings",
  },
});

const settingsPaneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$pane",
  component: SettingsPaneView,
  staticData: {
    title: "Settings",
  },
});

const settingsTopicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$pane/$topic",
  component: SettingsPaneView,
  staticData: {
    title: "Settings",
  },
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  testRoute,
  statsRoute,
  statsCategoryRoute,
  statsFacetRoute,
  visualRoute,
  a11yRoute,
  batchRoute,
  healsRoute,
  insightsRoute,
  branchesRoute,
  settingsRoute,
  settingsPaneRoute,
  settingsTopicRoute,
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
