// The overlay-dismissal fixture, as a raw JS string written next to the specs
// at runtime (the settle-fixture-source.ts idiom).
//
// What it does
// ------------
// Installs the shared overlay watcher into EVERY document of the run through
// `context.addInitScript`, so a rule is enforced on the first page and on every
// page a later navigation produces.
//
// Why addInitScript and not an action wrapper
// -------------------------------------------
// The other fixtures here patch actions, which means they run at step
// boundaries. That is the wrong shape for this: the overlays it exists for do
// not wait for a step. Measured on ritual.com, the Klaviyo modal appears about
// eight seconds into a visit — after any top-of-test dismissal has already run
// and between whatever two steps happen to straddle it. A watcher installed
// into the document catches it when it arrives; a wrapper catches it on the
// next action, which is exactly when the click it would have blocked happens.
//
// `addInitScript` also runs BEFORE the page's own scripts, which the trainer's
// `dom-ready` injection cannot. So the run is the half that can suppress a
// banner before it paints, and it does.
//
// Why the resolver is interpolated rather than written here
// ---------------------------------------------------------
// The script handed to `addInitScript` carries the app's OWN locator engine —
// `DOM_HELPERS` + `UNIQUENESS_HELPERS` from capture-script.ts, the same
// `matchesFor` the capture script grades uniqueness with and the trainer's
// watcher resolves with. That is the whole point: a rule taught in the trainer
// and a rule enforced in a run resolve through one implementation, including
// its shadow-root piercing, so they cannot drift into agreeing "for now". A
// second resolver is the failure `e2e/assert-parity.spec.ts` exists to prevent,
// one level down.
//
// The scan cap is raised to UNCAPPED_SCAN for the same reason the replayer and
// the heal probe raise it: MAX_UNIQUENESS_SCAN exists because capture runs on
// the click path, and nothing here is on it.
//
// It must NEVER fail a test
// -------------------------
// Pacing, not assertion — the settle fixture's rule, for the same reason. A
// rule that failed a run would turn a cosmetic annoyance into a broken suite,
// and the user who wrote the rule was trying to do the opposite. Every path is
// individually swallowed; a rule that resolves to nothing is simply a rule that
// did not fire.
//
// Diagnostics go to STDERR, never stdout: stdout carries the StepReporter's
// `__GLAZE_STEP__:` markers, and text interleaved into that stream breaks step
// highlighting for the whole run.
//
// Plain JavaScript (no TypeScript) because Playwright loads it through its own
// Babel transform.

import {
  DOM_HELPERS,
  MAX_UNIQUENESS_SCAN,
  UNCAPPED_SCAN,
  UNIQUENESS_HELPERS,
} from "../recorder/capture-script.js";
import { overlayVisibleSource, watcherSource } from "../../shared/overlay-rules.mjs";
// The pure half — see shared/dismiss-fixture-names.mjs for why it is split.
// Re-exported so this module stays the one import site for its callers.
import {
  DISMISS_COUNT_ENV,
  DISMISS_ENV_PREFIX,
  DISMISS_FIXTURE_FILE,
  dismissEnvNames,
} from "../../shared/dismiss-fixture-names.mjs";

export { DISMISS_COUNT_ENV, DISMISS_ENV_PREFIX, DISMISS_FIXTURE_FILE, dismissEnvNames };

/** The locator engine, with the click-path cap lifted. */
const resolverSource = `
${DOM_HELPERS}
${UNIQUENESS_HELPERS.replace(String(MAX_UNIQUENESS_SCAN), String(UNCAPPED_SCAN))}
${overlayVisibleSource()}
${watcherSource()}
`;

export const dismissFixtureSource = `const COUNT = Number(process.env.${DISMISS_COUNT_ENV} || 0) || 0;

// Interpolated, never retyped — see DISMISS_ENV_PREFIX.
const PREFIX = ${JSON.stringify(DISMISS_ENV_PREFIX)};

// The engine, as one string handed to the page. It is not evaluated here — it
// is evaluated inside every document the run visits.
const ENGINE = ${JSON.stringify(resolverSource)};

function note(msg) {
  try {
    process.stderr.write("[glaze-dismiss] " + msg + "\\n");
  } catch (e) {
    /* stderr is best-effort too */
  }
}

/** The rules this run was given, read out of the environment. A rule whose
 *  target will not parse is DROPPED with a line rather than guessed at: the
 *  target is a locator the app serialized, so a broken one means the two sides
 *  disagree, and acting on half of it would click something nobody chose. */
function rulesFromEnv() {
  const out = [];
  for (let i = 0; i < COUNT; i++) {
    const label = process.env[PREFIX + i + "_LABEL"] || "";
    const raw = process.env[PREFIX + i + "_TARGET"] || "";
    if (!raw) continue;
    try {
      const target = JSON.parse(raw);
      if (target && typeof target === "object" && typeof target.k === "string") {
        out.push({ id: String(i), label, target });
      } else {
        note("rule " + i + " (" + label + ") has no usable target — skipped");
      }
    } catch (e) {
      note("rule " + i + " (" + label + ") could not be read — skipped");
    }
  }
  return out;
}

const RULES = rulesFromEnv();

/** The page-side name the watcher reports through. Prefixed like the rest of
 *  the app's page-world names so it cannot collide with a site's own global. */
const BINDING = "__glReportOverlayDismissal";

/** label → how many times it fired, for the whole run. */
const fired = new Map();

/** A rule with no label still has to be nameable in the run output. */
function describeTarget(target) {
  if (!target) return "rule";
  if (target.k === "role") return target.role + (target.name ? ' "' + target.name + '"' : "");
  return target.v || target.k;
}

/**
 * Install the overlay watcher into every document of this page's context.
 *
 * Returns the rules it armed, so the caller can say so in the run output. A
 * run that quietly clicks things on a page is a run whose failures point
 * nowhere: if a rule ever matches a control it should not have, the only way
 * anyone finds out is that the run said which rules were armed.
 */
export async function installOverlayDismissal(page) {
  if (!RULES.length) return [];
  // A BINDING, not a page global. The count has to outlive the documents it is
  // counted in: the watcher lives in the page and every navigation destroys it,
  // so a tally kept on \`window\` reports whatever the LAST document happened to
  // dismiss — which for a run that navigates is reliably nothing. Playwright
  // re-installs a binding into every new document, so the tally accumulates
  // here, in the worker, where it survives.
  try {
    await page.exposeBinding(BINDING, (_source, id) => {
      const index = Number(id);
      const rule = RULES[index];
      const label = rule ? rule.label || describeTarget(rule.target) : "rule " + id;
      fired.set(label, (fired.get(label) || 0) + 1);
    });
  } catch (e) {
    // A re-used page already has the binding. Not fatal: the watcher below
    // tolerates the call being absent, and the ARMED line is the report that
    // actually matters.
    note("dismissal counter unavailable: " + String(e));
  }
  try {
    await page.context().addInitScript(
      ({ engine, rules, binding }) => {
        try {
          // Indirect eval: the engine is a self-contained script, and this
          // keeps it out of the init script's own closure scope.
          (0, eval)(engine);
          const start = () => {
            try {
              // eslint-disable-next-line no-undef
              installOverlayWatcher(rules, (id) => {
                try {
                  const report = window[binding];
                  if (typeof report === "function") report(id);
                } catch (e) {}
              });
            } catch (e) {}
          };
          if (document.documentElement) start();
          else document.addEventListener("DOMContentLoaded", start, { once: true });
        } catch (e) {}
      },
      { engine: ENGINE, rules: RULES, binding: BINDING },
    );
  } catch (e) {
    note("could not install: " + String(e));
    return [];
  }
  return RULES.map((r) => r.label || describeTarget(r.target));
}

/** Everything this run has dismissed, by rule label, with counts.
 *
 *  Accumulated across navigations — see the note on the binding above. A label
 *  appearing more than once is not a fault: it means the overlay came back,
 *  which is the case this whole feature exists for and is worth being able to
 *  see. */
export function dismissalsSoFar() {
  const out = [];
  for (const [label, count] of fired) {
    out.push(count > 1 ? label + " (x" + count + ")" : label);
  }
  return out;
}
`;
