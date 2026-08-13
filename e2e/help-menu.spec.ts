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
//   • Clicking one really opens Settings on the topic it names. The topic
//     travels as a URL FRAGMENT that the main process validates
//     (`paneFragment`), so a tightening of that validator — or a renamed
//     heading — turns a menu item into "opens the top of the manual", which
//     looks deliberate.

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

  const opened = app.waitForEvent("window");

  await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const help = menu?.items.filter((i) => i.role === "help" || i.label === "Help")[0];
    const item = help?.submenu?.items.filter((i) => i.label === "Set up the MCP server")[0];
    item?.click();
  });

  const settings = await opened;
  await settings.waitForLoadState("domcontentloaded");

  // The fragment is what carries the topic. Asserting the URL rather than only
  // the rendered pane keeps the half that exists only here separate from the
  // pane's own reading of it, which `documentation-pane.test.tsx` covers.
  expect(settings.url()).toContain("#documentation/setup");

  // …and then the pane really lands there, which is the claim the user cares
  // about. Scoped to the document's own title: the whole window is on screen
  // here, and its rail group headings and pane heading are `h2` as well.
  await expect(settings.locator("h2.gl-doc-title")).toHaveText("Setup");
});
