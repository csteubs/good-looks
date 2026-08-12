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

// What the failing locator ACTUALLY matched, flushed separately from the heals.
const matchSets = [];

function flushMatches() {
  if (!HEAL_DIR || matchSets.length === 0) return;
  try {
    fs.mkdirSync(HEAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(HEAL_DIR, "matches.json"), JSON.stringify(matchSets, null, 2));
  } catch (err) {
    process.stderr.write("[glaze-heal] could not write matches.json: " + String(err) + "\\n");
  }
}

/** Elements to describe per failing step. The point of this record is to be
 *  PICKED FROM, and a list longer than this is one nobody reads — the model
 *  least of all. The true count is reported separately, so a cap never reads
 *  as "that was all of them". */
const MAX_MATCHES = 20;

/**
 * Describe every element the failing locator resolved to.
 *
 * This is the exact answer to the one failure the run output cannot explain.
 * Playwright's strict-mode error says a locator "resolved to 10 elements" and
 * nothing whatsoever about what those elements ARE, so the diagnosis stops at
 * "it is ambiguous" — correct, and not actionable by anyone who cannot look at
 * the page. Auto-Heal's candidate ranking is a different question (what
 * RESEMBLES the element we wanted); this is the literal set that matched.
 *
 * Recorded for every resolve failure, not just the ambiguous ones: "matched 0"
 * and "matched 10" are opposite diagnoses and the count is what separates them.
 *
 * evaluateAll() rather than all() + a per-element evaluate: one round trip
 * instead of N, and it does not enforce strictness — which matters, because the
 * locator being described is one that just failed FOR being ambiguous.
 *
 * Best-effort throughout. Every caller rethrows the original error immediately
 * after; nothing here may change what the run does.
 */
async function recordMatches(loc, entry, method) {
  try {
    const found = await loc.evaluateAll(function (els) {
      const LANDMARKS = ["main", "nav", "header", "footer", "aside", "section", "form", "dialog"];
      function label(el) {
        let out = el.tagName.toLowerCase();
        if (el.id) out += "#" + el.id;
        const tid = el.getAttribute("data-testid");
        if (tid) out += "[data-testid=" + tid + "]";
        return out;
      }
      const items = els.slice(0, 20).map(function (el, i) {
        // Ancestors that could SCOPE a locator — a testid, an id, or a
        // landmark. The whole chain would be noise; these are the handles a
        // fix can actually be written against, which is why the payload can
        // suggest .getByTestId(x).getByRole(y) from them.
        const ancestors = [];
        let p = el.parentElement;
        while (p && ancestors.length < 3) {
          if (p.getAttribute("data-testid") || p.id || LANDMARKS.indexOf(p.tagName.toLowerCase()) >= 0) {
            ancestors.push(label(p));
          }
          p = p.parentElement;
        }
        const r = el.getBoundingClientRect();
        const cls =
          typeof el.className === "string" && el.className.trim()
            ? el.className.trim().split(/\\s+/).slice(0, 3)
            : [];
        return {
          index: i,
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          testid: el.getAttribute("data-testid") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          text: (el.textContent || "").trim().slice(0, 120),
          classes: cls,
          ancestors: ancestors,
          // Not offsetParent: an element in a fixed-position container has none
          // and is perfectly visible. A zero-area box is the honest test, and
          // "the one you wanted is the only visible match" is a real answer.
          visible: !!(r.width > 0 && r.height > 0),
          enabled: !el.disabled,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      });
      return { total: els.length, items: items };
    });
    if (!found) return;
    matchSets.push({
      stepId: entry.stepId,
      stepIndex: entry.stepIndex,
      stepLabel: entry.stepLabel,
      method: method,
      originalLocator: entry.locator,
      matchCount: found.total,
      matches: (found.items || []).slice(0, MAX_MATCHES),
      at: Date.now(),
    });
    flushMatches();
  } catch (e) {
    // Describing the page is a diagnostic aid. A failure here must not become
    // a second failure on top of the one already being reported.
  }
}

/**
 * Record an attempt that did NOT heal.
 *
 * Until 2026-08-07 this fixture wrote an event only when a candidate WORKED, so
 * "Auto-Heal tried and could not rescue this step" existed nowhere on disk —
 * and it is the more informative half. A step that healed says the locator went
 * stale; a step that could not be healed says the element is GONE, under every
 * locator the probe could rank. That points at the site rather than at the
 * test, which is the question this whole evidence layer exists to answer.
 *
 * Two outcomes, deliberately distinguished:
 *   • "no-candidates" — the probe found nothing on the page resembling the
 *     element. The strongest form: there was not even anything to try.
 *   • "exhausted"     — candidates were ranked, and acting on every one of them
 *     failed too.
 *
 * Never throws and never alters control flow: every caller rethrows the
 * original error immediately after, exactly as it did before this existed.
 */
function recordFailure(entry, method, outcome, candidates) {
  try {
    events.push({
      outcome: outcome,
      stepId: entry.stepId,
      stepIndex: entry.stepIndex,
      stepLabel: entry.stepLabel,
      method: method,
      originalLocator: entry.locator,
      candidates: (candidates || []).slice(0, 8),
      at: Date.now(),
    });
    flush();
    process.stderr.write(
      "[glaze-heal] could not heal " + (entry.stepLabel || entry.stepId) +
      " (" + outcome + ")\\n"
    );
  } catch (e) {
    // Recording is best-effort. A failure here must not become a second
    // failure on top of the one already being reported.
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

        // Before anything is healed. A successful heal changes the page (it
        // clicks something), and what matched at the moment of failure is the
        // thing being described — recording it afterwards would describe the
        // page the heal left behind.
        await recordMatches(this, entry, method);

        let candidates = [];
        try {
          candidates = await page.evaluate(entry.probe);
        } catch (probeErr) {
          process.stderr.write("[glaze-heal] probe failed: " + String(probeErr) + "\\n");
          throw err;
        }
        // Nothing on the page resembled this element AT ALL. Recorded, because
        // it is the strongest single piece of evidence that the failure is the
        // site's rather than the test's: a stale locator still has something to
        // rank, and this had nothing. Rethrown exactly as before — recording
        // must never change what the run does.
        if (!candidates || candidates.length === 0) {
          recordFailure(entry, method, "no-candidates", []);
          throw err;
        }

        // Try candidates best-first. A candidate that also fails is not a heal;
        // moving on is what stops one bad suggestion from failing the run.
        for (let i = 0; i < candidates.length && i < 3; i++) {
          const cand = candidates[i];
          try {
            const healed = fromModel(page, cand.locator);
            if (!healed) continue;
            const result = await orig.apply(healed, args);
            events.push({
              outcome: "healed",
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
        // Every candidate was tried and every one failed. The element could be
        // ranked but could not be acted on under ANY locator — see
        // recordFailure for why this is worth writing down.
        recordFailure(entry, method, "exhausted", candidates);
        throw err;
      }
    };
  });

  // ── Assertions ──────────────────────────────────────────────────────────
  //
  // THE GAP THIS CLOSES. Everything above patches ACTIONS — click, fill, hover,
  // waitFor. An assertion is none of them: expect(locator).toBeVisible() goes
  // through Playwright's matcher, which reaches the locator by its private
  // _expect. So when an ASSERTION failed, not one line of the machinery above
  // ran, and the consequences went all the way to the user:
  //
  //   recordMatches never fired  →  no matches.json  →  no step-matches.json
  //   →  artifacts:hasStructure false  →  structureAvailable false
  //   →  the "structure" need was never offered in the debug prompt
  //   →  the model asked, in prose, for "the HTML source at the time of
  //      failure", which is the one thing this app cannot hand over — and the
  //      debug session dead-ended on a question that already had an answer.
  //
  // That is how it was reported: a strict-mode violation on
  // getByText("Browser"), with every element the locator matched sitting
  // undescribed because the failing step was an expect() rather than a click.
  //
  // RECORDS ONLY, NEVER HEALS, and that asymmetry is the point. Healing an
  // action means "act on the element we actually meant". Healing an ASSERTION
  // would mean asserting against a different element than the test names, which
  // silently changes what the test checks — a passing run that proves something
  // nobody asked about. So this describes the page and rethrows, exactly as it
  // found it.
  //
  // Both outcomes are covered because they are opposite diagnoses:
  //   • _expect THROWS on a locator that could not be resolved at all — which
  //     is where a strict-mode violation lands.
  //   • _expect RETURNS { timedOut: true } when the locator resolved fine and
  //     the condition never came true, which is the "matched 0 elements" shape.
  // "matched 0" and "matched 10" need different fixes, and the payload builder
  // says so explicitly, so recording only one of them would be worse than
  // recording neither.
  //
  // _expect is Playwright-internal. Everything here is guarded and degrades to
  // the previous behaviour if it is absent or changes shape: a missing method
  // means no assertion structure, which is exactly where this started.
  const origExpect = proto._expect;
  if (typeof origExpect === "function") {
    proto._expect = async function (...args) {
      const entry = this.__glazeKey ? healMap[this.__glazeKey] : null;
      let result;
      try {
        result = await origExpect.apply(this, args);
      } catch (err) {
        if (entry && isResolveFailure(err)) {
          // Before rethrowing, and while the page is still in the state that
          // produced the failure — the same reason the action path records
          // before it heals.
          await recordMatches(this, entry, "expect");
        }
        throw err;
      }
      if (entry && result && result.timedOut) {
        await recordMatches(this, entry, "expect");
      }
      return result;
    };
  }
}
`;
