// The tab-following fixture as a raw JS string, written beside the specs and
// imported by the capture fixture (the dismiss-fixture idiom).
//
// ── The problem it answers ──────────────────────────────────────────────────
// The trainer records a LINEAR journey. Every navigation is forced into its
// one window — `keepInWindow` rewrites a `_blank` target to `_self`,
// `setWindowOpenHandler` denies every `window.open` and re-issues the URL in
// place — so a click that a real browser would open in a new tab is recorded
// as a click followed by steps on the document it opened. A run has none of
// that: Playwright honours the target, a second `Page` appears in the context,
// and the spec's one `page` stays on the opener. Every later step acts on the
// wrong document, and the trainer showed the journey green.
//
// ── What it does ────────────────────────────────────────────────────────────
// The run follows the newest tab, the way a person's attention does. The
// `page` handed to the spec is a Proxy delegating to the ACTIVE page — the
// newest open one — and three things make that hold at the moments it matters:
//
//   • Locators are RECIPES, materialized against the active page when they
//     ACT, not when they are built. A generated spec builds each step's
//     locator inline, so this costs nothing in practice; what it buys is the
//     step written just after a popup that closes itself, whose page is gone
//     by the time it runs.
//   • `expect` resolves its receiver at CALL time. Playwright's page matchers
//     bind once (`page.mainFrame().waitForURL(...)`) and never re-resolve, so
//     an `expect(page)` that started against the opener polls the opener for
//     its whole timeout.
//   • The page says when a tab is COMING. A context init script hooks
//     `window.open` and a capture-phase click on a targeted anchor or form and
//     reports through a binding, and the next action or assertion waits for
//     the `page` event before it binds. A `window.open` popup exists before
//     the click resolves; an anchor's does not, reliably — the spike failed
//     the anchor case every time without this.
//
// And one retry: an action or assertion whose bound page CLOSED underneath it
// (`isClosed()`, not the error text — the same close surfaced as "Target page,
// context or browser has been closed" and as "Protocol error: session closed")
// runs once more on the new active page.
//
// ── What it announces ───────────────────────────────────────────────────────
// Every new page writes a `tab` marker to stdout on the step-marker channel
// (`shared/step-marker.mjs`), which the runner turns into the
// "> New Tab Opened (#N)" row in Step details, and a line to stderr for the
// Output tab and the saved log. N is `context.pages().length` at that moment.
//
// ── Why the assertion wrapper announces its own step ────────────────────────
// Playwright takes a step's location from the first frame outside its own
// library. Once `expect` goes through this file, that frame is HERE, and the
// step reporter's file guard drops it — correctly, because a line of this file
// is not a line of the spec. So the wrapper announces the assertion itself
// through the hooks the capture fixture hands it, exactly as the capture
// fixture's action wrapper does for actions (see `wrap` there).
//
// Plain JavaScript because Playwright loads it through its own transform.

import { actionsLiteral, PAGE_ACTIONS } from "./page-actions.mjs";
import { STEP_MARKER } from "./step-marker.mjs";

export const TABS_FIXTURE_FILE = "glaze-tabs.mjs";

/** The switch. "1" follows tabs; anything else leaves Playwright's `page`
 *  alone. Set by both runners for every app-generated spec and never for an
 *  imported one — an imported spec that manages its own popups means `page`
 *  as the opener from then on, and following would break it. */
export const FOLLOW_TABS_ENV = "GLAZE_FOLLOW_TABS";

/** The page-world name the intent signal reports through. Prefixed like every
 *  other page-world name of the app's so it cannot collide with a site's. */
export const TAB_INTENT_BINDING = "__glTabIntent";

/** The stderr lines, spelled once: the Output tab and the run log show them,
 *  and a test asserts on them. */
export const TAB_OPENED_LINE = "New Tab Opened";
export const TAB_CLOSED_LINE = "Tab closed";

/**
 * The page-side signal, as source. Runs in every document before the page's
 * own code (a context init script). It changes nothing about what the page
 * does: `window.open` still opens, the anchor still navigates. It only says,
 * synchronously and before the browser acts, that a tab is about to exist.
 *
 * `_self`, `_parent` and `_top` stay in the same tab; anything else (a `_blank`
 * or a named target) may not. A named target that happens to be an existing
 * tab is followed like a new one — the run cannot tell, and following is the
 * right guess for a recorded journey either way.
 */
export const TAB_INTENT_SCRIPT = `(() => {
  const report = () => { try { const f = window[${JSON.stringify(TAB_INTENT_BINDING)}]; if (typeof f === "function") f(); } catch (e) {} };
  try {
    const open = window.open;
    window.open = function () { report(); return open.apply(this, arguments); };
  } catch (e) {}
  const SAME = { _self: 1, _parent: 1, _top: 1 };
  document.addEventListener("click", (e) => {
    try {
      const el = e.target && e.target.closest ? e.target.closest("a[target],area[target],form[target]") : null;
      const t = el && el.getAttribute("target");
      if (t && !SAME[t]) report();
    } catch (err) {}
  }, true);
  document.addEventListener("submit", (e) => {
    try {
      const t = e.target && e.target.getAttribute ? e.target.getAttribute("target") : null;
      if (t && !SAME[t]) report();
    } catch (err) {}
  }, true);
})();`;

/** How long an action or assertion waits for a tab the page said is coming.
 *  Generous, because it is only ever paid when the signal fired and the page
 *  has not arrived — a site that reported intent and then opened nothing. */
export const TAB_ARRIVAL_TIMEOUT_MS = 5000;

/** How long the newest tab is given to reach `domcontentloaded` before the
 *  first step on it runs. A popup begins at about:blank; without this the
 *  first assertion on it reads the blank document. */
export const TAB_LOAD_TIMEOUT_MS = 15000;

/** Locator factories on a Page (and on a Locator, as chained builders). */
export const LOCATOR_FACTORIES = [
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTestId",
  "getByTitle",
  "getByAltText",
  "locator",
  "frameLocator",
];

/** Locator methods that return another locator, so a recipe keeps growing. */
export const LOCATOR_REFINERS = ["filter", "nth", "first", "last", "and", "or", "owner", "contentFrame"];

/** Page methods that act or read asynchronously and must wait for tabs to
 *  settle first. Every entry is a method Playwright resolves as a Promise;
 *  anything not listed is bound to the active page as-is, which is what keeps
 *  `url()`, `context()`, `isClosed()` and `waitForEvent()` synchronous in the
 *  shape the spec expects (a download's arming line relies on the last). */
export const GATED_PAGE_METHODS = [
  ...PAGE_ACTIONS,
  "waitForTimeout",
  "waitForURL",
  "waitForLoadState",
  "waitForSelector",
  "waitForFunction",
  "evaluate",
  "evaluateHandle",
  "screenshot",
  "addStyleTag",
  "addScriptTag",
  "bringToFront",
  "content",
  "title",
  "innerText",
  "textContent",
  "inputValue",
  "getAttribute",
  "isVisible",
  "isHidden",
  "isEnabled",
  "isDisabled",
  "isChecked",
  "isEditable",
  "click",
  "dblclick",
  "fill",
  "press",
  "check",
  "uncheck",
  "hover",
  "focus",
  "selectOption",
  "setInputFiles",
  "tap",
  "type",
  "dispatchEvent",
  "dragAndDrop",
  "emulateMedia",
];

/** Input devices reached as properties. Each is proxied so its methods gate
 *  the same way a page method does — a generated `press` step with no locator
 *  is `page.keyboard.press(...)`. */
export const GATED_PAGE_DEVICES = ["keyboard", "mouse", "touchscreen"];

export const tabsFixtureSource = `const ON = process.env.${FOLLOW_TABS_ENV} === "1";
const STEP_MARKER = ${JSON.stringify(STEP_MARKER)};
const BINDING = ${JSON.stringify(TAB_INTENT_BINDING)};
const INTENT_SCRIPT = ${JSON.stringify(TAB_INTENT_SCRIPT)};
const ARRIVAL_TIMEOUT_MS = ${TAB_ARRIVAL_TIMEOUT_MS};
const LOAD_TIMEOUT_MS = ${TAB_LOAD_TIMEOUT_MS};
const FACTORIES = ${actionsLiteral(LOCATOR_FACTORIES)};
const REFINERS = ${actionsLiteral(LOCATOR_REFINERS)};
const GATED = ${actionsLiteral(GATED_PAGE_METHODS)};
const DEVICES = ${actionsLiteral(GATED_PAGE_DEVICES)};
const OPENED = ${JSON.stringify(TAB_OPENED_LINE)};
const CLOSED = ${JSON.stringify(TAB_CLOSED_LINE)};

// The mark every proxy this file hands out carries, so the assertion wrapper
// can tell a receiver it should resolve from one it should leave to Playwright.
const RECIPE = Symbol("glaze.recipe");

function note(msg) {
  try {
    process.stderr.write("[glaze-tabs] " + msg + "\\n");
  } catch (e) {
    /* best effort */
  }
}

// ── Per-test state ───────────────────────────────────────────────────────────
//
// One test at a time owns this (workers=1, one spec per run — the same
// assumption the capture fixture's module-level ctx makes), reset by every
// install. A retry re-enters the page fixture and installs again.
let state = null;

function resetState(page, context, opts) {
  state = {
    context: context,
    stack: [page],
    active: page,
    // How many tabs the page has said are coming that have not arrived, and
    // the wait for the next one. Consumed by the page event.
    intentPending: 0,
    arrival: null,
    // The newest page's load, awaited before the first step on it.
    loadGate: Promise.resolve(),
    perPage: typeof opts.perPage === "function" ? opts.perPage : null,
    attempt: Number(opts.attempt) || 0,
    announce: opts.announce || null,
    // Tabs opened this test, for the run log's closing line.
    opened: 0,
  };
}

/** The page every step resolves against right now. */
export function activePage() {
  return state ? state.active : null;
}

function emitTabMarker(count) {
  try {
    process.stdout.write(STEP_MARKER + JSON.stringify({ event: "tab", count: count, attempt: state ? state.attempt : 0 }) + "\\n");
  } catch (e) {
    /* progress reporting must never fail a run */
  }
}

function onNewPage(p) {
  if (!state) return;
  state.stack.push(p);
  state.active = p;
  state.opened++;
  if (state.intentPending > 0) state.intentPending--;
  const count = state.context.pages().length;
  // Tag before the per-page installs so a manifest entry written by one of
  // them can say which tab it describes.
  try { p.__glTabIndex = state.stack.length - 1; } catch (e) { /* frozen page objects do not exist, but never throw here */ }
  emitTabMarker(count);
  note(OPENED + " (#" + count + ")");
  state.loadGate = p.waitForLoadState("domcontentloaded", { timeout: LOAD_TIMEOUT_MS }).catch(() => {});
  if (state.perPage) {
    try {
      const r = state.perPage(p);
      if (r && typeof r.catch === "function") r.catch((err) => note("per-page install failed: " + String(err)));
    } catch (err) {
      note("per-page install failed: " + String(err));
    }
  }
  p.on("close", () => {
    if (!state) return;
    const i = state.stack.indexOf(p);
    if (i >= 0) state.stack.splice(i, 1);
    if (state.active === p && state.stack.length) {
      state.active = state.stack[state.stack.length - 1];
      note(CLOSED + " (#" + (state.stack.length + 1) + "), continuing on tab #" + state.stack.length);
    }
  });
}

/**
 * Wait for the tabs to settle: a tab the page said is coming, then the newest
 * tab's load. Bounded on both counts, and never throws — a page that signalled
 * intent and opened nothing costs one wait, not the run.
 */
export async function settleTabs() {
  if (!state) return;
  if (state.intentPending > 0) {
    if (!state.arrival) {
      state.arrival = state.context
        .waitForEvent("page", { timeout: ARRIVAL_TIMEOUT_MS })
        .catch(() => null)
        .then(() => { if (state) { state.arrival = null; } });
    }
    await state.arrival;
    // The event fired (or timed out); either way this intent is spent.
    if (state && state.intentPending > 0) state.intentPending = 0;
  }
  if (state) await state.loadGate;
}

/** A page that was bound and is gone, while another is active: the one case
 *  that is retried. Anything else is the test's own failure. */
function movedOn(bound) {
  try {
    return !!state && bound !== state.active && typeof bound.isClosed === "function" && bound.isClosed();
  } catch (e) {
    return false;
  }
}

/** Real Playwright objects for a recipe's arguments: a lazy locator handed to
 *  \`.and()\` or \`filter({ has })\` has to be materialized on the same page. */
function unwrapArgs(args) {
  return args.map((a) => {
    if (a && typeof a === "object" && a[RECIPE]) return materialize(a[RECIPE]);
    if (a && typeof a === "object" && !Array.isArray(a)) {
      let copy = null;
      for (const k of ["has", "hasNot"]) {
        if (a[k] && typeof a[k] === "object" && a[k][RECIPE]) {
          if (!copy) copy = Object.assign({}, a);
          copy[k] = materialize(a[k][RECIPE]);
        }
      }
      return copy || a;
    }
    return a;
  });
}

/** Build the real locator for a recipe against the active page. */
function materialize(recipe) {
  let cur = state ? state.active : null;
  for (const step of recipe) cur = cur[step[0]].apply(cur, unwrapArgs(step[1]));
  return cur;
}

/** A locator that is built when it acts. Refiners extend the recipe; every
 *  other property is an action or a read, run against the active page once
 *  tabs have settled, and retried once if the page it bound went away. */
function lazyLocator(recipe) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === RECIPE) return recipe;
      // Not a thenable: \`await page.locator(...)\` on a real Locator is the
      // locator itself, and a proxy that answered \`then\` would hang an await.
      if (prop === "then") return undefined;
      if (prop === "toString" || prop === Symbol.toPrimitive) return () => String(materialize(recipe));
      if (prop === "page") return () => materialize(recipe).page();
      if (typeof prop !== "string") return undefined;
      if (REFINERS.indexOf(prop) >= 0 || FACTORIES.indexOf(prop) >= 0) {
        return (...args) => lazyLocator(recipe.concat([[prop, args]]));
      }
      return async (...args) => {
        await settleTabs();
        const bound = state ? state.active : null;
        const call = () => {
          const loc = materialize(recipe);
          return loc[prop].apply(loc, args);
        };
        try {
          return await call();
        } catch (err) {
          if (bound && movedOn(bound)) {
            await settleTabs();
            return call();
          }
          throw err;
        }
      };
    },
  });
}

/** \`page.keyboard\` and friends, gated the same way. */
function deviceProxy(name) {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      return async (...args) => {
        await settleTabs();
        const dev = state.active[name];
        return dev[prop].apply(dev, args);
      };
    },
  });
}

/**
 * The \`page\` the spec gets: every read delegates to the active page. Factories
 * return recipes; gated methods settle first and retry once on a page that
 * closed underneath; everything else is bound to the active page as it is.
 */
function followingPage(first) {
  return new Proxy(first, {
    get(_t, prop) {
      if (prop === RECIPE) return [];
      if (typeof prop !== "string") {
        const sv = state.active[prop];
        return typeof sv === "function" ? sv.bind(state.active) : sv;
      }
      if (FACTORIES.indexOf(prop) >= 0) return (...args) => lazyLocator([[prop, args]]);
      if (DEVICES.indexOf(prop) >= 0) return deviceProxy(prop);
      if (GATED.indexOf(prop) >= 0) {
        return async (...args) => {
          await settleTabs();
          const bound = state.active;
          try {
            return await bound[prop].apply(bound, args);
          } catch (err) {
            if (movedOn(bound)) {
              await settleTabs();
              return state.active[prop].apply(state.active, args);
            }
            throw err;
          }
        };
      }
      const v = state.active[prop];
      return typeof v === "function" ? v.bind(state.active) : v;
    },
    set(_t, prop, value) {
      state.active[prop] = value;
      return true;
    },
    has(_t, prop) {
      return prop in state.active;
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(state.active);
    },
  });
}

/** Whether a value is one of this file's proxies — the page or a recipe. */
function isFollowing(v) {
  try {
    return !!v && typeof v === "object" && v[RECIPE] !== undefined;
  } catch (e) {
    return false;
  }
}

/** The real receiver for one of this file's proxies, right now. */
function resolveReceiver(v) {
  const recipe = v[RECIPE];
  return recipe.length ? materialize(recipe) : state.active;
}

/**
 * One assertion chain — \`expect(x)\`, \`expect.soft(x)\`, \`.not\` — resolved
 * at the moment a matcher is called. The chain is rebuilt on the retry so a
 * closed page's locator is built again on the page that replaced it.
 */
function expectation(baseExpect, recv, mods) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === "not") return expectation(baseExpect, recv, Object.assign({}, mods, { not: true }));
      if (typeof prop !== "string") return undefined;
      return async (...args) => {
        const a = state && state.announce ? state.announce.begin(prop) : null;
        const tStart = Date.now();
        const build = () => {
          const real = resolveReceiver(recv);
          let e = mods.soft ? baseExpect.soft(real) : baseExpect(real);
          if (mods.not) e = e.not;
          return e;
        };
        try {
          await settleTabs();
          const bound = state ? state.active : null;
          const call = () => {
            const e = build();
            return e[prop].apply(e, args);
          };
          let result;
          try {
            result = await call();
          } catch (err) {
            if (bound && movedOn(bound)) {
              await settleTabs();
              result = await call();
            } else {
              throw err;
            }
          }
          if (a) state.announce.end(a, true, Date.now() - tStart);
          return result;
        } catch (err) {
          if (a && state && state.announce) state.announce.end(a, false, Date.now() - tStart);
          throw err;
        }
      };
    },
  });
}

/**
 * An \`expect\` that resolves this file's proxies at call time and leaves every
 * other receiver to Playwright untouched. \`expect.soft\` is intercepted for the
 * same reason \`expect\` is — a generated soft assertion goes through it — and
 * everything else on the function (\`poll\`, \`configure\`, \`extend\`) is
 * Playwright's own.
 */
export function followingExpect(baseExpect) {
  return new Proxy(baseExpect, {
    apply(target, thisArg, args) {
      if (ON && state && isFollowing(args[0])) return expectation(target, args[0], {});
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      if (prop === "soft") {
        return (...args) => {
          if (ON && state && isFollowing(args[0])) return expectation(target, args[0], { soft: true });
          return target.soft.apply(target, args);
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * Install following on a test's context and hand back the page the spec
 * should get. \`opts.perPage(p)\` runs for every LATER page the context opens —
 * the caller has already installed on the first one — and \`opts.announce\`
 * carries the capture fixture's step-marker hooks so an assertion announces
 * itself. Never throws: a context that refuses the binding or the init script
 * still follows tabs, it just cannot wait for one the page announced.
 */
export async function installTabFollowing(page, opts) {
  const o = opts || {};
  const context = page.context();
  resetState(page, context, o);
  try { page.__glTabIndex = 0; } catch (e) { /* never throw here */ }
  try {
    await context.exposeBinding(BINDING, () => {
      if (!state) return;
      state.intentPending++;
      if (!state.arrival) {
        state.arrival = context
          .waitForEvent("page", { timeout: ARRIVAL_TIMEOUT_MS })
          .catch(() => null)
          .then(() => { if (state) state.arrival = null; });
      }
    });
    await context.addInitScript(INTENT_SCRIPT);
  } catch (err) {
    note("could not install the intent signal: " + String(err) + " — tabs are followed, but not waited for");
  }
  context.on("page", onNewPage);
  return followingPage(page);
}

/** How many tabs this test opened, for the closing line of the run log. */
export function tabsOpened() {
  return state ? state.opened : 0;
}

export { ON as FOLLOWING_ON };
`;
