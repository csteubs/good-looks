# Settings as a view

**Status: implemented, 2026-08-24.** Settings stops being a second
`BrowserWindow` and becomes two routed screens in the main window, addressed and
navigated like every other view.

---

## 1. Why

Settings has been its own `BrowserWindow` since before the redesign, and every
consequence of that has been paid for somewhere else in the tree:

- **It is the only screen with no address.** `/stats`, `/visual`, `/a11y`,
  `/batch`, `/heals`, `/insights` and `/branches` are routes; Settings was an
  IPC call. So it has no breadcrumb, no back and forward, no rail selection, no
  ⌘K entry, and no way for the browser preview to reach it without mounting a
  second application root (`renderer/dev/preview-boot.ts`'s `mountSettings`).
- **Deep-linking it needed a URL fragment.** `window:openSettings("cost")` is
  validated in the main process, concatenated into a `loadURL`, read back out of
  `window.location.hash` by a lazy initialiser, and re-validated in the
  renderer — four moving parts to say "open the Cost pane", where a route says
  it in one.
- **Nothing in that window received a backend push.** It is not registered as an
  aux window, so `sendToMain` never reached it. `settings:changed` exists
  precisely because the two windows could not see each other's writes, and
  `applyTypeface` is called by hand in `appearance-pane.tsx` for the same
  reason.
- **REDESIGN §B4 asked for this and could not have it.** Its own words: *"the
  rail becomes the settings nav while in settings (the panes *are* the
  navigation), and the library list hides. Same surface, two jobs"* — shipped
  with the caveat *"Settings is its own `BrowserWindow` here, so there is no
  library list to hide and no single element to repurpose."* This change is what
  discharges that caveat.

## 2. Shape

Two routes, mirroring `/stats` → `/stats/$category` → `/stats/$category/$facet`,
which is the drill this app already has and the one `app-strip.tsx` was written
around:

| Route | Screen | Breadcrumb |
|---|---|---|
| `/settings` | **Settings** — the category board | Home / Settings |
| `/settings/$pane` | **Settings Category** — one pane's rows | Home / Settings / Appearance |
| `/settings/$pane/$topic` | the Documentation pane, on a topic | Home / Settings / Documentation / Set up the MCP server |

`$pane` and `$topic` are strings out of history and are **not trusted**: the view
checks them against `paneById` and the doc registry and renders an explained
empty state for anything else. That is the rule `stats-category-view.tsx`
already follows and the reason it is written down there.

### Why a board and not a redirect to the first pane

`/settings` could have redirected to `/settings/appearance` — that is what the
window did, and it is one line. It was rejected for two reasons. An address that
renders no screen of its own is a hole in the trail: the "Settings" crumb above
a pane would point at the pane you are already standing on. And the board is the
only surface that can carry each section's `subtitle` — the one-line description
of what is inside it, which the 190px rail has never had room for. The rail is a
list of names; the board is the answer to "what is in Settings". They are the
same relationship the Stats rail row and the Stats category board have.

The board is built from data that already exists — `PANES`, `paneSegments()`
and `modifiedKeys()` — so it introduces no state and no new concept.

## 3. The rail

While the route is under `/settings`, the rail lists the panes instead of the
library, exactly the way it lists routines under `/batch`:

- title `Settings`, no `+` action,
- the search field in the rail's pinned `search` slot (where `SettingsNav`
  already put it),
- one row per pane, grouped by `paneSegments()`, with the match count while
  searching and the modified count when not,
- the Views nav and the AI connection footer stay where they are, because they
  are how you leave.

**One rule, one spelling.** Whether a path is a settings path is decided by
`isSettingsPath` in `renderer/lib/settings-route.ts` and nowhere else. Two
components ask — `RootShell`, which mounts the controller, and `LibrarySidebar`,
which swaps its body — and a rail that swapped on a path the provider did not
mount for would throw out of `useSettingsController`.

### Where the state lives

`SettingsScope` (`renderer/settings/settings-scope.tsx`) wraps the whole
`SplitView` in `RootShell` while a settings route is open, because the rail and
the content are **siblings** and both need the same two things:

- the controller (`settings`, `loaded`, `save`, and every connection handler),
  whose loads used to fire when the window opened and now fire when the route is
  entered;
- the search query, which filters the rail's rows *and* the rows inside the
  pane. A route search param was considered and rejected: it would put a history
  entry behind every keystroke, or need `replace: true` on each one, to make an
  ephemeral filter addressable.

Mounted conditionally, so the app pays nothing for it on any other screen — the
LLM probe, the artifact usage read and the run totals are the same six loads the
window used to run on open.

## 4. The window goes away

| Was | Is |
|---|---|
| `main/windows/settings-window.ts` | deleted |
| `settings-window.html` + its `vite.config.ts` entry | deleted |
| `window:openSettings` / `window:closeSettings` IPC | deleted |
| `paneFragment()` (fragment builder) | `settingsTarget()` in `main/services/settings-target.ts`, returning `{ pane, topic }` |
| App menu ⌘, and the six Help items | focus the main window, then `sendToMain("settings:open", target)` |
| `getSettingsWindow()` in the zoom fan-out | gone — there is one fewer window to scale |
| Escape closes the window | gone — a view has no close; back does |

`settings:open` is a push like `deepLink:open` and is treated like one:
**syntactically** validated in the main process before it is sent (it is about
to select a route), and **semantically** re-checked in `RootView` against
`paneById` before it navigates. The two checks answer different questions — "is
this a legal segment" and "is this a pane that exists" — which is why they are
not one shared rule. `check:push-consumers` is what keeps the channel from
becoming a send with nobody listening.

## 5. Callers

Every "open Settings" in the renderer becomes a navigation:

| Caller | Was | Is |
|---|---|---|
| top strip gear | `window:openSettings` | **removed** — Settings is a rail row now |
| `library-sidebar.tsx` AI footer | `window:openSettings` | `/settings/ai` |
| `cost-panel.tsx` "Edit in Settings" | `window:openSettings("cost")` | `/settings/cost` |
| `insights-view.tsx` × 2 | `window:openSettings("integrations"/"alerts")` | `/settings/integrations`, `/settings/alerts` |
| command palette | — | a `Settings` view entry |
| browser preview | `mountSettings()`, a second app root | `?view=settings`, `?pane=<id>` |

## 6. What this does not change

The panes, the rows, the schema, the controller's IPC and the search index are
untouched. `renderer/lib/settings-schema.ts` is still the one place that says
which pane owns a setting and what words find it, and every file under
`renderer/settings/panes/` is byte-identical apart from the Documentation pane,
which reads its topic from a route param instead of `window.location.hash`.
