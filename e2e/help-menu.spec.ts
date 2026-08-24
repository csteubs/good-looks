// The Help menu exists, and its items open the manual where they say.
//
// ONLY AN END-TO-END RUN CAN SEE THIS. The application menu is built by
// `Menu.buildFromTemplate` in the main process and rendered by macOS; its items
// never enter any DOM, so jsdom cannot reach them and no unit test can tell a
// menu that was configured from one that was not. A missing Help menu is also
// silent from the app's side — every window still works, and the only symptom
// is a user who never finds the documentation.
//
// Two halves, and the second is the one that would ship broken:
//
//   • The menu is registered, with the items we wrote.
//   • Clicking one really opens Settings on the topic it names. The topic is
//     validated in the main process (`settingsTarget`) and re-checked in the
//     renderer, so a tightening of either — or a renamed heading — turns a menu
//     item into "opens the top of the manual", which looks deliberate.
//
// THE SECOND HALF CHANGED SHAPE WHEN SETTINGS BECAME A VIEW, and it is worth
// knowing which part of it was load-bearing. The topic used to travel as a URL
// FRAGMENT on a `loadURL`, so the test waited for a second window and read its
// address. There is no second window and no address now
// (docs/plans/settings-view.md): the menu pushes `settings:open` at the window
// that already exists and the renderer navigates. What only an end-to-end run
// can still answer is the same question it always answered — whether a menu
// item built before any window existed reaches the screen at all.

import { test, expect } from "./fixtures.js";

// EVERY TEST HERE TAKES `window`, and it is not decoration. The menu is built
// inside `app.whenReady()`, which resolves after `_electron.launch()` does —
// asking a freshly launched app for its menu returns ELECTRON'S DEFAULT one,
// and the assertion then fails naming our items as missing rather than as
// early. Waiting for the first window is waiting for the same chain that
// installs the menu.

test("the Help menu is registered with the documentation items", async ({ app, window }) => {
  await window.waitForLoadState("domcontentloaded");

  const labels = await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const help = menu?.items.filter((i) => i.role === "help" || i.label === "Help")[0];
    return (help?.submenu?.items ?? [])
      .filter((i) => i.type !== "separator")
      .map((i) => i.label);
  });

  expect(labels).toContain("Good Looks! Help");
  expect(labels).toContain("Set up the MCP server");
  expect(labels).toContain("Linear, GitHub and Slack");
  expect(labels).toContain("Troubleshooting");
});

test("a Help item opens Settings on the topic it names", async ({ app, window }) => {
  await window.waitForLoadState("domcontentloaded");

  await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const help = menu?.items.filter((i) => i.role === "help" || i.label === "Help")[0];
    const item = help?.submenu?.items.filter((i) => i.label === "Set up the MCP server")[0];
    item?.click();
  });

  // The claim the user cares about: the pane really lands on that topic.
  // Scoped to the document's own title, because the whole window is on screen
  // here and its rail group headings are `h2` as well.
  await expect(window.locator("h2.gl-doc-title")).toHaveText("Setup");

  // And the trail agrees, which is the half a route buys that a window never
  // could: the topic is a place you can go back from, not a window you close.
  // Case-insensitive: the crumbs are uppercased by CSS, and whether that
  // reaches an assertion depends on whether it reads `textContent` or
  // `innerText`. Matching either is the honest way to say "the trail names it".
  await expect(window.locator('nav[aria-label="Breadcrumb"]')).toContainText(/documentation/i);

  // IN THIS WINDOW. Asserted last so a failure above reports the missing topic
  // rather than the window count, and asserted at all because "the menu item
  // did something" and "the menu item did it here" are different facts — the
  // first would still pass if this quietly went back to opening a window.
  expect(app.windows()).toHaveLength(1);
});
