// Run-time Auto-Heal, as a raw JS string written next to the specs (like
// capture-fixture-source.ts and step-reporter-source.ts).
//
// Until now healing only ran in the TRAINER. That is the wrong place for it to
// live alone: the trainer is where you are already looking at the step that
// broke. A real run is where a stale locator actually costs you something — a
// suite goes red overnight, and the information about what the element used to
// look like is sitting unused on the step.
//
// How a failing locator is identified
// -----------------------------------
// The fixture needs to know WHICH step failed, and it only ever sees Playwright
// locator objects. Counting actions and indexing into the step list would work
// until the first `if` block skipped one, silently shifting every later lookup.
// So the page's locator factories are patched to tag each locator they return
// with the app's own canonical key ("testid|submit", "role|button|Log in"), and
// the heal map is keyed by that. No ordering assumptions, and it behaves the
// same whether or not screenshot capture is on.
//
// Two steps sharing an identical locator share a heal-map entry. They also
// share an element, so the fingerprint is the same one — the collision is
// harmless.
//
// The probe itself is NOT reimplemented here: the runner pre-builds one probe
// script per step with `buildHealProbeScript`, the same function the trainer
// uses, and this fixture just evaluates it. One ranking implementation, two
// callers.
//
// Plain JavaScript (no TypeScript) because Playwright loads it through its own
// Babel transform.

export const HEAL_FIXTURE_FILE = "glaze-heal.mjs";

export const healFixtureSource = `import * as fs from "fs";
import * as path from "path";

const HEAL_DIR = process.env.GLAZE_HEAL_DIR || "";
const MAP_FILE = process.env.GLAZE_HEAL_MAP || "";

let healMap = {};
try {
  if (MAP_FILE) healMap = JSON.parse(fs.readFileSync(MAP_FILE, "utf-8"));
} catch (err) {
  process.stderr.write("[glaze-heal] could not read the heal map: " + String(err) + "\\n");
}

// Heals performed this run, flushed to disk for the runner to journal.
const events = [];

// Locator factories to patch, and how to build the app's canonical key from
// their arguments. Kept in one table so a factory can't be patched without a
// key, or given a key shape the runner doesn't produce.
const FACTORIES = {
  getByTestId: (args) => "testid|" + String(args[0]),
  getByLabel: (args) => "label|" + String(args[0]),
  getByPlaceholder: (args) => "placeholder|" + String(args[0]),
  getByText: (args) => "text|" + String(args[0]),
  getByRole: (args) => {
    const name = args[1] && args[1].name != null ? String(args[1].name) : "";
    return "role|" + String(args[0]) + "|" + name;
  },
  locator: (args) => "css|" + String(args[0]),
};

// Actions worth healing: the ones that resolve an element before acting. A
// failure in any of them may be "the element moved" rather than "the app broke".
const HEALABLE = [
  "click", "dblclick", "fill", "press", "type", "check", "uncheck", "setChecked",
  "selectOption", "tap", "hover", "focus", "clear", "waitFor",
];

/** Rebuild a Playwright locator from the app's Locator model. */
function fromModel(page, loc) {
  if (!loc) return null;
  if (loc.k === "testid") return page.getByTestId(loc.v);
  if (loc.k === "label") return page.getByLabel(loc.v);
  if (loc.k === "placeholder") return page.getByPlaceholder(loc.v);
  if (loc.k === "text") return page.getByText(loc.v);
  if (loc.k === "xpath") return page.locator("xpath=" + loc.v);
  if (loc.k === "role") {
    return loc.name ? page.getByRole(loc.role, { name: loc.name }) : page.getByRole(loc.role);
  }
  return page.locator(loc.v);
}

/** A locator timeout, as opposed to the app genuinely misbehaving.
 *
 *  Deliberately its own predicate rather than a reuse of the trainer's
 *  isLocatorFailure: that one matches the REPLAYER's wording ("Element not
 *  found"), and this one matches Playwright's, which is a different string set
 *  entirely. Sharing one would have quietly stopped matching on one side. */
function isResolveFailure(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  return (
    m.indexOf("timeout") >= 0 ||
    m.indexOf("waiting for locator") >= 0 ||
    m.indexOf("element is not attached") >= 0 ||
    m.indexOf("strict mode violation") >= 0 ||
    m.indexOf("no element") >= 0
  );
}

function flush() {
  if (!HEAL_DIR || events.length === 0) return;
  try {
    fs.mkdirSync(HEAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(HEAL_DIR, "heals.json"), JSON.stringify(events, null, 2));
  } catch (err) {
    process.stderr.write("[glaze-heal] could not write heals.json: " + String(err) + "\\n");
  }
}

/** Patch the page's locator factories to tag what they return, and the Locator
 *  prototype's actions to heal on a resolve failure. */
export function installHealing(page) {
  // Tag locators with the app's canonical key as they're created.
  Object.keys(FACTORIES).forEach(function (name) {
    const orig = page[name];
    if (typeof orig !== "function") return;
    page[name] = function (...args) {
      const loc = orig.apply(this, args);
      try {
        loc.__glazeKey = FACTORIES[name](args);
      } catch (e) { /* tagging is best-effort */ }
      return loc;
    };
  });

  let proto;
  try {
    proto = Object.getPrototypeOf(page.locator("body"));
  } catch (err) {
    process.stderr.write("[glaze-heal] could not patch the locator prototype: " + String(err) + "\\n");
    return;
  }

  HEALABLE.forEach(function (method) {
    const orig = proto[method];
    if (typeof orig !== "function") return;
    proto[method] = async function (...args) {
      try {
        return await orig.apply(this, args);
      } catch (err) {
        const entry = this.__glazeKey ? healMap[this.__glazeKey] : null;
        // Nothing recorded for this locator, or a failure healing can't
        // address: rethrow untouched so the run fails exactly as it would have.
        if (!entry || !entry.probe || !isResolveFailure(err)) throw err;

        let candidates = [];
        try {
          candidates = await page.evaluate(entry.probe);
        } catch (probeErr) {
          process.stderr.write("[glaze-heal] probe failed: " + String(probeErr) + "\\n");
          throw err;
        }
        if (!candidates || candidates.length === 0) throw err;

        // Try candidates best-first. A candidate that also fails is not a heal;
        // moving on is what stops one bad suggestion from failing the run.
        for (let i = 0; i < candidates.length && i < 3; i++) {
          const cand = candidates[i];
          try {
            const healed = fromModel(page, cand.locator);
            if (!healed) continue;
            const result = await orig.apply(healed, args);
            events.push({
              stepId: entry.stepId,
              stepIndex: entry.stepIndex,
              stepLabel: entry.stepLabel,
              method: method,
              originalLocator: entry.locator,
              appliedLocator: cand.locator,
              candidates: candidates.slice(0, 8),
              at: Date.now(),
            });
            flush();
            process.stderr.write(
              "[glaze-heal] healed " + (entry.stepLabel || entry.stepId) + " → " +
              JSON.stringify(cand.locator) + "\\n"
            );
            return result;
          } catch (retryErr) {
            // Try the next candidate.
          }
        }
        throw err;
      }
    };
  });
}
`;
