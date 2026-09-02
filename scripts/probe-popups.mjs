#!/usr/bin/env node
/**
 * Probe a real site with the built-in pop-up handlers, and show your work.
 *
 *   node scripts/probe-popups.mjs https://www.ritual.com/
 *   node scripts/probe-popups.mjs https://www.ritual.com/ --headless --wait-ms 40000
 *   node scripts/probe-popups.mjs https://www.ritual.com/ --no-dismiss
 *
 * The presets in shared/popup-presets.mjs are two CSS selectors, measured once
 * against ritual.com and proven since only against markup this repo wrote
 * (main/recorder/__fixtures__/vendor-popups.ts). A vendor ships a new
 * container class, a site configures a different close label, and the
 * selector matches nothing — silently, because a rule that never fires looks
 * exactly like a page with no banner. Inside a run the only evidence is one
 * stderr line; inside the trainer, none at all. A mechanism reachable only
 * from a run is one nobody can debug, and the site the presets were built for
 * cannot be reached from the CI runner or the container this was written in —
 * so the check is done HERE, on a machine that can, and what it prints is what
 * a corrected selector is written from.
 *
 * What it does, in order:
 *  1. launches the repo's own Chromium (the `playwright` package this app
 *     bundles; PLAYWRIGHT_BROWSERS_PATH is honoured as everywhere else) into a
 *     FRESH context — no profile, no cookies, so a consent decision remembered
 *     from a real visit cannot hide the banner;
 *  2. installs the very engine the run's dismissal fixture installs
 *     (shared/dismiss-fixture-source.mjs builds it the same way: the locator
 *     engine with the click-path cap lifted, `overlayVisible`, the watcher)
 *     through `addInitScript`, armed with `presetRules()`, and reports every
 *     dismissal with a timestamp as it happens;
 *  3. also reports the moment a vendor CONTAINER first appears, whether or not
 *     a preset then matched inside it — the gap between "appeared" and
 *     "dismissed" is the whole diagnosis;
 *  4. after the wait, asks the page how many elements each preset's target
 *     resolves to NOW (and how many are visible), then dumps every
 *     `[role="dialog"]`, `[class*="klaviyo"]` and `.dg-consent-banner`
 *     element on the page, open shadow roots included, with the first 600
 *     characters of its markup — and of its shadow root, when it has one,
 *     because a shadow host's outerHTML shows nothing of what is inside.
 *
 * `--no-dismiss` installs the sighting observer only, so the counts in step 4
 * say whether the selectors MATCH a live overlay before the watcher removes it.
 * Headed by default, because watching the modal arrive is half the point;
 * `--headless` for a machine without a display.
 *
 * An unknown flag is a refusal, not a warning — the cli/args.mjs rule. Exit
 * code through `process.exitCode`, never `process.exit`, so a piped stdout is
 * not truncated (bin/good-looks.mjs's lesson).
 */

import process from "node:process";

import {
  DOM_HELPERS,
  MAX_UNIQUENESS_SCAN,
  UNCAPPED_SCAN,
  UNIQUENESS_HELPERS,
} from "../shared/locator-engine.mjs";
import { overlayVisibleSource, watcherSource } from "../shared/overlay-rules.mjs";
import { POPUP_PRESETS, presetRules } from "../shared/popup-presets.mjs";

const USAGE = `usage: node scripts/probe-popups.mjs <url> [--headless] [--wait-ms <ms>] [--no-dismiss]

  <url>            the page to visit, in a fresh browser context
  --headless       run without a window (default: headed, so you can watch)
  --wait-ms <ms>   how long to watch after the page loads (default 25000)
  --no-dismiss     measure only: report sightings and matches, click nothing
  --help           this message

Reports, in order: what was armed, each vendor container's arrival, each
dismissal with a timestamp, how many elements each preset's target resolves
to after the wait, and the markup of every dialog / Klaviyo / DataGrail
element on the page (open shadow roots included).`;

const DEFAULT_WAIT_MS = 25_000;

/** The containers worth announcing and dumping: what a Klaviyo form or a
 *  DataGrail banner IS on the page, independent of the close control the
 *  preset targets inside it. When a container appears and no dismissal
 *  follows, the close selector is what needs correcting. */
const CONTAINER_SELECTOR = '[role="dialog"], [class*="klaviyo"], .dg-consent-banner';

/** The engine, built the way shared/dismiss-fixture-source.mjs builds its
 *  resolver — the same strings, so a selector that resolves here resolves in
 *  a run. `resolverSource` there is not exported (it is the fixture's own
 *  private string), which is why this is spelled again rather than imported;
 *  the four parts are the shared modules' exports and cannot drift. */
const ENGINE = `
${DOM_HELPERS}
${UNIQUENESS_HELPERS.replace(String(MAX_UNIQUENESS_SCAN), String(UNCAPPED_SCAN))}
${overlayVisibleSource()}
${watcherSource()}
`;

/**
 * argv → options, or a usage error. A misspelt flag is refused rather than
 * ignored: `--headles` silently opening a window on a CI box is the wrong
 * kind of surprise.
 * @param {string[]} argv
 * @returns {{ url: string; headless: boolean; waitMs: number; dismiss: boolean } | { help: true } | { error: string }}
 */
function parseArgs(argv) {
  let url = null;
  let headless = false;
  let waitMs = DEFAULT_WAIT_MS;
  let dismiss = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--headless") {
      headless = true;
    } else if (a === "--no-dismiss") {
      dismiss = false;
    } else if (a === "--wait-ms") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return { error: `--wait-ms needs a non-negative number, got ${JSON.stringify(raw)}` };
      waitMs = Math.round(n);
    } else if (a.startsWith("--wait-ms=")) {
      const n = Number(a.slice("--wait-ms=".length));
      if (!Number.isFinite(n) || n < 0) return { error: `--wait-ms needs a non-negative number, got ${JSON.stringify(a)}` };
      waitMs = Math.round(n);
    } else if (a.startsWith("-")) {
      return { error: `unknown flag ${a}` };
    } else if (url === null) {
      url = a;
    } else {
      return { error: `unexpected argument ${a}` };
    }
  }
  if (url === null) return { error: "a URL is required" };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `the URL must be http(s), got ${parsed.protocol}` };
    }
  } catch {
    return { error: `not a URL: ${url}` };
  }
  return { url, headless, waitMs, dismiss };
}

/** @param {string} line */
function say(line) {
  process.stdout.write(line + "\n");
}

/**
 * The page side. Runs inside EVERY document of the context, before the page's
 * own scripts: evaluates the engine, arms the watcher (unless measuring only),
 * and watches for a vendor container to appear. Both report through bindings,
 * because a tally kept in the page dies with the document on navigation.
 *
 * Plain JavaScript with no closure references — Playwright serializes it.
 */
function pageSide({ engine, rules, dismiss, containerSelector, dismissedBinding, seenBinding }) {
  try {
    // Indirect eval, as the fixture does: the engine is a self-contained
    // script and this keeps it out of this function's own scope.
    (0, eval)(engine);
  } catch (e) {
    return;
  }
  const report = (binding, payload) => {
    try {
      const fn = window[binding];
      if (typeof fn === "function") fn(payload);
    } catch (e) {}
  };
  const announced = new Set();
  const lookForContainers = () => {
    let hits;
    try {
      hits = scanAll(containerSelector);
    } catch (e) {
      return;
    }
    for (const el of hits) {
      if (announced.has(el)) continue;
      announced.add(el);
      const cls = typeof el.className === "string" ? el.className : "";
      report(seenBinding, {
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        className: cls.slice(0, 120),
        role: el.getAttribute("role") || "",
        testid: el.getAttribute("data-testid") || "",
        // A shadow HOST (DataGrail's aside) has no box of its own — its
        // banner is positioned inside the shadow tree — so "not visible"
        // on a host says nothing about what the user sees.
        shadowHost: !!el.shadowRoot,
        visible: overlayVisible(el),
      });
    }
  };
  const start = () => {
    try {
      new MutationObserver(lookForContainers).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
    setInterval(lookForContainers, 500);
    lookForContainers();
    if (dismiss) {
      try {
        installOverlayWatcher(rules, (id) => report(dismissedBinding, { id }));
      } catch (e) {}
    }
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

/** After the wait: what each preset's target resolves to on the page NOW. */
function countMatches({ engine, targets }) {
  (0, eval)(engine);
  return targets.map((target) => {
    let hits;
    try {
      hits = matchesFor(target);
    } catch (e) {
      return { total: -1, visible: 0, error: String(e) };
    }
    const visible = hits.filter((el) => overlayVisible(el)).length;
    return { total: hits.length, visible };
  });
}

/** Every element matching the container selector, in the document and in
 *  every OPEN shadow root beneath it, with enough markup to correct a
 *  selector from. A host's outerHTML says nothing about its shadow tree, so
 *  that is dumped beside it. */
function dumpContainers(selector) {
  const out = [];
  const seen = new Set();
  const describe = (el, where) => {
    let rect = { width: 0, height: 0 };
    try {
      rect = el.getBoundingClientRect();
    } catch (e) {}
    return {
      where,
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      className: typeof el.className === "string" ? el.className.slice(0, 200) : "",
      role: el.getAttribute("role") || "",
      testid: el.getAttribute("data-testid") || "",
      size: Math.round(rect.width) + "x" + Math.round(rect.height),
      html: el.outerHTML.slice(0, 600),
      shadow: el.shadowRoot ? el.shadowRoot.innerHTML.slice(0, 600) : null,
    };
  };
  const visit = (root, where, depth) => {
    if (depth > 20) return;
    let matches;
    try {
      matches = root.querySelectorAll(selector);
    } catch (e) {
      return;
    }
    for (const el of matches) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(describe(el, where));
    }
    let all;
    try {
      all = root.querySelectorAll("*");
    } catch (e) {
      return;
    }
    for (const el of all) {
      if (el.shadowRoot) visit(el.shadowRoot, where + " > shadow root of <" + el.tagName.toLowerCase() + ">", depth + 1);
    }
  };
  visit(document, "document", 0);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if ("help" in opts) {
    say(USAGE);
    return 0;
  }
  if ("error" in opts) {
    process.stderr.write(`probe-popups: ${opts.error}\n\n${USAGE}\n`);
    return 2;
  }

  const rules = presetRules();
  const labelOf = new Map(rules.map((r) => [r.id, r.label]));

  // The same library the app bundles and the runner spawns. A dynamic import
  // so a missing install is one line of advice rather than a stack trace.
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    process.stderr.write(`probe-popups: could not load playwright from this repo's node_modules (${err instanceof Error ? err.message : String(err)})\n`);
    process.stderr.write("run `npm install --include=dev` in the repo first\n");
    return 1;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: opts.headless });
  } catch (err) {
    process.stderr.write(`probe-popups: could not launch Chromium: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
    process.stderr.write("run `npx playwright install chromium` and retry\n");
    return 1;
  }

  const startedAt = Date.now();
  const stamp = () => `+${String(Date.now() - startedAt).padStart(6, " ")}ms`;
  const dismissals = [];
  const sightings = [];
  try {
    const context = await browser.newContext();
    await context.exposeBinding("__glProbeDismissed", (_source, payload) => {
      const id = payload && payload.id !== undefined ? String(payload.id) : "?";
      const label = labelOf.get(id) || id;
      dismissals.push({ at: Date.now() - startedAt, id, label });
      say(`${stamp()}  dismissed  ${label}  (${id})`);
    });
    await context.exposeBinding("__glProbeSeen", (_source, el) => {
      sightings.push({ at: Date.now() - startedAt, ...el });
      const bits = [
        `<${el.tag}${el.id ? "#" + el.id : ""}${el.className ? " class=\"" + el.className + "\"" : ""}>`,
        el.role ? `role=${el.role}` : "",
        el.testid ? `data-testid=${el.testid}` : "",
        el.shadowHost ? "shadow host (its own box is not the banner's)" : el.visible ? "visible" : "not visible",
      ].filter(Boolean);
      say(`${stamp()}  appeared   ${bits.join("  ")}`);
    });
    await context.addInitScript(pageSide, {
      engine: ENGINE,
      rules,
      dismiss: opts.dismiss,
      containerSelector: CONTAINER_SELECTOR,
      dismissedBinding: "__glProbeDismissed",
      seenBinding: "__glProbeSeen",
    });

    say(`probe-popups  ${opts.url}`);
    say(`  ${opts.dismiss ? "armed" : "measuring only (--no-dismiss), armed nothing"}: ${rules.map((r) => r.label).join(", ") || "(no presets)"}`);
    for (const r of rules) say(`    ${r.id}  ${r.target.k}: ${r.target.v}`);
    say(`  watching for ${opts.waitMs}ms after load (${opts.headless ? "headless" : "headed"})`);
    say("");

    const page = await context.newPage();
    try {
      await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (err) {
      process.stderr.write(`probe-popups: could not open ${opts.url}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n`);
      return 1;
    }
    say(`${stamp()}  loaded     ${page.url()}`);
    await page.waitForTimeout(opts.waitMs);

    say("");
    say(`after ${opts.waitMs}ms at ${page.url()}  (title: ${JSON.stringify(await page.title())})`);
    say("");

    // ── What each preset resolves to now ─────────────────────────────────
    say("preset targets on the page now:");
    const targets = POPUP_PRESETS.map((p) => p.target);
    const counts = await page.evaluate(countMatches, { engine: ENGINE, targets });
    POPUP_PRESETS.forEach((p, i) => {
      const c = counts[i];
      const detail = c.total < 0 ? `could not resolve: ${c.error}` : `${c.total} element(s), ${c.visible} visible`;
      say(`  ${p.label.padEnd(36)} ${detail}`);
    });
    if (opts.dismiss) {
      say("  (a dismissed control is usually gone by now — 0 here with a dismissal above is the expected shape)");
    }
    say("");

    // ── The timeline ─────────────────────────────────────────────────────
    say(`containers seen: ${sightings.length}`);
    say(`dismissals: ${dismissals.length}`);
    for (const p of POPUP_PRESETS) {
      const n = dismissals.filter((d) => d.label === p.label).length;
      say(`  ${p.label.padEnd(36)} ${n === 0 ? "never fired" : `fired ${n}x`}`);
    }
    say("");

    // ── The markup ───────────────────────────────────────────────────────
    const dump = await page.evaluate(dumpContainers, CONTAINER_SELECTOR);
    say(`elements matching ${CONTAINER_SELECTOR} (open shadow roots included): ${dump.length}`);
    for (const el of dump) {
      say("");
      say(`  <${el.tag}${el.id ? "#" + el.id : ""}>  ${el.where}  ${el.size}${el.role ? "  role=" + el.role : ""}${el.testid ? "  data-testid=" + el.testid : ""}`);
      if (el.className) say(`    class: ${el.className}`);
      say(`    html:  ${el.html.replace(/\s+/g, " ")}`);
      if (el.shadow !== null) say(`    shadow: ${el.shadow.replace(/\s+/g, " ")}`);
    }
    if (dump.length === 0) {
      say("  (none — either no vendor overlay rendered in the window, or it uses markup none of the three selectors describe)");
    }
    return 0;
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`probe-popups: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
