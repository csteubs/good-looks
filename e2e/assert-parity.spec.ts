// THE AUTHORITY: one fixture set, both engines, identical verdicts required.
//
// Every "passes in the trainer, fails in the run" bug in this app was the same
// shape — the injected replayer and the generated Playwright spec disagreed
// about what a step MEANS — and no test could express it, because the two sides
// shared no fixtures. `main/services/assert-emission.test.ts` closes most of
// that gap in milliseconds by modelling Playwright's matcher rules in Node.
// This file is what makes that model trustworthy: it runs the REAL emitted
// source through REAL Playwright against a REAL page, and asserts the verdict
// equals what the replayer says about the same page.
//
// Deliberately NOT an Electron test. Every other spec here drives the app
// because its subject is a window; this one's subject is matcher semantics, so
// a plain browser page is both sufficient and an order of magnitude faster. The
// fixture is served over HTTP rather than a data: URL because URL assertions
// are half the point and `about:blank` has no meaningful location.
//
// VERIFIED TO FAIL against the previous implementation: with `assert:"url"`
// emitting `toHaveURL(<string>)`, every url row reports the spec failing where
// the trainer passes — which is precisely the bug, stated as a test.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { buildReplayScript } from "../main/services/step-replayer.js";
import { generateSpec } from "../main/services/script-generator.js";
import { resolveStepForReplay } from "../main/recorder/types.js";
import { reEscape, urlPathPattern } from "../shared/step-semantics.mjs";
import { glazeRuntimeSource } from "../main/services/glaze-runtime-source.js";
import type { Step, TestVariable } from "../main/recorder/types.js";

const FIXTURE = `<!doctype html>
<html><head><title>Cart | Acme</title></head>
<body>
  <h1 data-testid="heading">Checkout</h1>
  <p data-testid="ws">  spaced   out  </p>
  <button data-testid="only">Save</button>
  <button data-testid="dupe-a">Duplicate</button>
  <button data-testid="dupe-b">Duplicate label</button>
  <input data-testid="email" placeholder="Email address" value="a@b.test" />
  <input data-testid="search" type="search" aria-label="Find things" />
  <input data-testid="qty" type="number" aria-label="Quantity" />
  <input data-testid="pw" type="password" aria-label="Passphrase" />
  <input data-testid="when" type="date" aria-label="Start date" />
  <input data-testid="upload" type="file" aria-label="Upload a file" />
  <select data-testid="sized" size="4" aria-label="Pick a region"><option>North</option><option>South</option></select>
  <select data-testid="multi" multiple aria-label="Pick tags"><option>red</option></select>
  <select data-testid="country"><option value="uk">UK</option><option value="us">US</option></select>
  <div data-testid="aria-btn" role="button" aria-disabled="true">Disabled widget</div>
  <div data-testid="aria-chk" role="checkbox" aria-checked="true">Agree</div>
  <div data-testid="faded" style="opacity:0">Faded but present</div>
  <div data-testid="thin" style="width:0;height:20px;overflow:hidden">Zero width</div>
  <div data-testid="attr-present" data-state="">has empty attr</div>
  <div data-testid="attr-absent">no attr</div>
  <button data-testid="bump" onclick="this.textContent = String(Number(this.textContent) + 1)">0</button>
  <!-- Lazy-render fixture for scroll steps: the reviews block is NOT in the
       DOM until the page scrolls past 600px — the shape of a virtualized list
       or an IntersectionObserver gate, and the reason assertions against such
       content fail in a run that never scrolls. -->
  <div style="height:2400px"></div>
  <button data-testid="deep">Deep button</button>
  <script>
    addEventListener("scroll", function () {
      if (window.scrollY > 600 && !document.querySelector('[data-testid="lazy-review"]')) {
        var d = document.createElement("div");
        d.setAttribute("data-testid", "lazy-review");
        d.textContent = "Great product";
        document.body.appendChild(d);
      }
    });
  </script>
</body></html>`;

let server: http.Server;
let base: string;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** What the TRAINER says about this step on this page.
 *
 *  `${name}` is resolved BEFORE the script is built, because that is what
 *  `runStep` does — the injected replayer acts on exactly what it is handed.
 *  Skipping that here would compare a resolved run against an unresolved
 *  preview and report a difference this app does not have. */
async function replayerVerdict(page: Page, step: Step, vars?: TestVariable[]): Promise<boolean> {
  const resolved = vars && vars.length > 0 ? resolveStepForReplay(step, vars).step : step;
  const result = (await page.evaluate(buildReplayScript(resolved))) as { ok: boolean };
  return result.ok;
}

/**
 * What the RUN says: the generated line, executed by real Playwright.
 *
 * `expect` is rebound to a short-timeout copy inside the evaluated source. A
 * row that is SUPPOSED to fail would otherwise burn the suite's full expect
 * timeout, and there are enough of those to matter — but the generated text
 * itself is untouched, which is the whole point of running it rather than
 * re-deriving what it ought to do.
 */
async function specVerdict(page: Page, step: Step, vars?: TestVariable[]): Promise<boolean> {
  const src = generateSpec({ name: "parity", url: base, steps: [step], variables: vars });
  const line = src.split("\n").find((l) => l.trim().startsWith("await expect"));
  if (!line) throw new Error("no assertion emitted for step: " + JSON.stringify(step));
  const fast = expect.configure({ timeout: 1500 });
  // The three names a variable-bearing pattern reaches for. Both helpers are
  // the SHARED functions the emitted runtime module embeds by `toString()`,
  // so this is the same code and not a second spelling of it. That the
  // EMITTED file parses and exports them is pinned separately, in
  // regex-assert-variables.test.ts.
  const V = Object.fromEntries((vars ?? []).map((v) => [v.name, v.value ?? ""]));
  const run = new Function(
    "page",
    "expect",
    "V",
    "glazeReEscape",
    "glazeUrlPathPattern",
    `return (async () => { ${line.trim()} })();`,
  );
  try {
    await run(page, fast, V, reEscape, urlPathPattern);
    return true;
  } catch {
    return false;
  }
}

interface Row {
  label: string;
  step: Step;
  /** What SHOULD happen on the fixture page. Stated independently of both
   *  engines so a row where they agree and are both wrong still fails. */
  expected: boolean;
  /** Declared variables, for a row whose value interpolates one. */
  vars?: TestVariable[];
}

let n = 0;
const s = (over: Partial<Step>): Step => ({ id: "p" + ++n, type: "assert", ...over }) as Step;

function rows(origin: string): Row[] {
  return [
    // ---- URL: the assertion that had never passed a run -------------------
    { label: "url contains a path fragment", step: s({ assert: "url", value: "/" }), expected: true },
    { label: "url contains the host", step: s({ assert: "url", value: "127.0.0.1" }), expected: true },
    { label: "url contains something absent", step: s({ assert: "url", value: "/checkout/9" }), expected: false },
    { label: "url contains, ignoring case", step: s({ assert: "url", value: "127.0.0.1" }), expected: true },
    // A dot un-escaped would match any character and pass against a host it
    // should not; escaped, this is a true statement about the fixture.
    { label: "url contains a dotted host", step: s({ assert: "url", value: "127.0.0.1" }), expected: true },
    { label: "urlIs the whole absolute URL", step: s({ assert: "urlIs", value: origin + "/" }), expected: true },
    { label: "urlIs rejects a prefix", step: s({ assert: "urlIs", value: origin }), expected: false },
    { label: "urlEndsWith the trailing slash", step: s({ assert: "urlEndsWith", value: "/" }), expected: true },
    { label: "urlEndsWith rejects a non-suffix", step: s({ assert: "urlEndsWith", value: "127.0.0.1" }), expected: false },
    { label: "urlPathIs the site root", step: s({ assert: "urlPathIs", value: "/" }), expected: true },
    { label: "urlPathIs rejects a path the page is not at", step: s({ assert: "urlPathIs", value: "/checkout" }), expected: false },

    // ---- a ${var} inside a regex-backed pattern ---------------------------
    //
    // These are the rows this file was missing, and their absence is what let
    // the two engines disagree in production. Every kind here embeds its value
    // in a RegExp, and the generator used to regex-escape the REFERENCE — so
    // the run compared against the literal text "${slug}" and could never
    // pass, while the trainer, which resolves variables before it replays,
    // showed the same step green. A user watching the preview had no way to
    // see it.
    //
    // The false rows matter as much as the true ones: an interpolated value
    // that reached the pattern UNescaped would turn a dotted value into a
    // wildcard, and "matches something it should not" is the failure a green
    // assertion hides best.
    {
      label: "url contains an interpolated path",
      step: s({ assert: "url", value: "/${slug}" }),
      vars: [{ name: "slug", kind: "plain", value: "/" }] as TestVariable[],
      expected: true,
    },
    {
      label: "url contains an interpolated fragment that is absent",
      step: s({ assert: "url", value: "/${slug}" }),
      vars: [{ name: "slug", kind: "plain", value: "checkout/9" }] as TestVariable[],
      expected: false,
    },
    {
      label: "an interpolated dot is escaped, not a wildcard",
      step: s({ assert: "url", value: "${host}" }),
      vars: [{ name: "host", kind: "plain", value: "127.0.0.1" }] as TestVariable[],
      expected: true,
    },
    {
      label: "…and the same value cannot match a host it only resembles",
      step: s({ assert: "url", value: "${host}" }),
      vars: [{ name: "host", kind: "plain", value: "127X0.0.1" }] as TestVariable[],
      expected: false,
    },
    {
      label: "urlPathIs an interpolated path",
      step: s({ assert: "urlPathIs", value: "${path}" }),
      vars: [{ name: "path", kind: "plain", value: "/" }] as TestVariable[],
      expected: true,
    },
    {
      label: "urlPathIs rejects an interpolated path the page is not at",
      step: s({ assert: "urlPathIs", value: "${path}" }),
      vars: [{ name: "path", kind: "plain", value: "/checkout" }] as TestVariable[],
      expected: false,
    },
    {
      label: "titleContains an interpolated word",
      step: s({ assert: "titleContains", value: "${word}" }),
      vars: [{ name: "word", kind: "plain", value: "Cart" }] as TestVariable[],
      expected: true,
    },
    {
      label: "titleContains rejects an interpolated word that is absent",
      step: s({ assert: "titleContains", value: "${word}" }),
      vars: [{ name: "word", kind: "plain", value: "Checkout" }] as TestVariable[],
      expected: false,
    },
    // A reference to a name the test does not declare stays literal, in BOTH
    // engines — the same rule `valueExpr` follows, so a price of ${9.99} or a
    // pasted shell snippet is never turned into a lookup.
    {
      label: "an undeclared reference stays literal text",
      step: s({ assert: "url", value: "${nope}" }),
      expected: false,
    },

    // ---- title: exact vs contains ----------------------------------------
    { label: "title is the whole title", step: s({ assert: "title", value: "Cart | Acme" }), expected: true },
    { label: "title rejects a substring", step: s({ assert: "title", value: "Cart" }), expected: false },
    { label: "titleContains accepts a substring", step: s({ assert: "titleContains", value: "Cart" }), expected: true },
    { label: "titleContains is case-sensitive", step: s({ assert: "titleContains", value: "cart" }), expected: false },

    // ---- text --------------------------------------------------------------
    { label: "text contains", step: s({ assert: "text", text: "Check", locator: { k: "testid", v: "heading" } }), expected: true },
    { label: "text is case-sensitive", step: s({ assert: "text", text: "check", locator: { k: "testid", v: "heading" } }), expected: false },
    { label: "exactText normalizes whitespace", step: s({ assert: "exactText", text: "spaced out", locator: { k: "testid", v: "ws" } }), expected: true },

    // ---- visibility: two mismatches, in opposite directions ---------------
    { label: "opacity:0 is VISIBLE to Playwright", step: s({ assert: "visible", locator: { k: "testid", v: "faded" } }), expected: true },
    { label: "zero WIDTH is hidden", step: s({ assert: "visible", locator: { k: "testid", v: "thin" } }), expected: false },

    // ---- aria state on custom widgets -------------------------------------
    { label: "aria-disabled is disabled", step: s({ assert: "disabled", locator: { k: "testid", v: "aria-btn" } }), expected: true },
    { label: "aria-checked is checked", step: s({ assert: "checked", locator: { k: "testid", v: "aria-chk" } }), expected: true },

    // ---- attribute: missing is not empty ----------------------------------
    { label: "an attribute present and empty", step: s({ assert: "attribute", attr: "data-state", value: "", locator: { k: "testid", v: "attr-present" } }), expected: true },
    { label: "a MISSING attribute is not empty", step: s({ assert: "attribute", attr: "data-state", value: "", locator: { k: "testid", v: "attr-absent" } }), expected: false },

    // ---- value -------------------------------------------------------------
    { label: "value matches", step: s({ assert: "value", value: "a@b.test", locator: { k: "testid", v: "email" } }), expected: true },

    // ---- locator semantics -------------------------------------------------
    { label: "getByPlaceholder is a substring match", step: s({ assert: "visible", locator: { k: "placeholder", v: "Email" } }), expected: true },
    { label: "a role locator finds a searchbox", step: s({ assert: "visible", locator: { k: "role", role: "searchbox", name: "Find things" } }), expected: true },
    { label: "a role locator finds a spinbutton", step: s({ assert: "visible", locator: { k: "role", role: "spinbutton", name: "Quantity" } }), expected: true },
    // The roles the recorder used to get wrong, judged by a real browser rather
    // than by anyone's reading of the ARIA spec. `password` and `date` are
    // TEXTBOX to Playwright even though the spec gives them no role, `file` is
    // a BUTTON, and a `size > 1` select is a listbox without `multiple`.
    // Getting any of these wrong records a locator that verifies as unique
    // against the recorder's own mapping and then matches nothing in the run.
    { label: "a password input is a textbox to Playwright", step: s({ assert: "visible", locator: { k: "role", role: "textbox", name: "Passphrase" } }), expected: true },
    { label: "a date input is a textbox to Playwright", step: s({ assert: "visible", locator: { k: "role", role: "textbox", name: "Start date" } }), expected: true },
    { label: "a file input is a button", step: s({ assert: "visible", locator: { k: "role", role: "button", name: "Upload a file" } }), expected: true },
    { label: "a size>1 select is a listbox", step: s({ assert: "visible", locator: { k: "role", role: "listbox", name: "Pick a region" } }), expected: true },
    { label: "a multiple select is a listbox", step: s({ assert: "visible", locator: { k: "role", role: "listbox", name: "Pick tags" } }), expected: true },
    { label: "a size>1 select is NOT a combobox", step: s({ assert: "visible", locator: { k: "role", role: "combobox", name: "Pick a region" } }), expected: false },
    { label: "count with a unique testid", step: s({ assert: "count", count: 1, locator: { k: "testid", v: "only" } }), expected: true },
  ];
}

test("every assertion means the same thing to the trainer and to the run", async ({ page }) => {
  await page.goto(base);
  const disagreements: string[] = [];
  const wrong: string[] = [];

  for (const row of rows(base)) {
    const fromSpec = await specVerdict(page, row.step, row.vars);
    const fromTrainer = await replayerVerdict(page, row.step, row.vars);
    if (fromSpec !== fromTrainer) {
      disagreements.push(
        `${row.label}: the run says ${fromSpec}, the trainer says ${fromTrainer}`,
      );
    }
    // Both agreeing is not enough — they can agree and both be wrong, which is
    // what a shared-but-incorrect rule would look like.
    if (fromSpec !== row.expected) {
      wrong.push(`${row.label}: expected ${row.expected}, the run says ${fromSpec}`);
    }
  }

  expect(disagreements, "the trainer and the run disagree about these steps").toEqual([]);
  expect(wrong, "these assertions do not do what the fixture says they should").toEqual([]);
});

test("URL path assertions ignore query noise; whole-URL kinds do not", async ({ page }) => {
  // The failure that made "the URL assertion never passes" true in the field:
  // the value is a path, the kind compares the FULL URL, and the run-time URL
  // carries a `?variant=` or `utm_*` the recording did not. The fixture server
  // answers every path, so this page has all three kinds of noise at once.
  await page.goto(base + "/cart/?step=2#top");
  const rows: Row[] = [
    { label: "urlPathIs the path, under query and fragment noise", step: s({ assert: "urlPathIs", value: "/cart" }), expected: true },
    { label: "urlPathIs tolerates the trailing slash", step: s({ assert: "urlPathIs", value: "/cart/" }), expected: true },
    { label: "urlPathIs is not a prefix match", step: s({ assert: "urlPathIs", value: "/car" }), expected: false },
    { label: "urlPathIs supplies a missing leading slash", step: s({ assert: "urlPathIs", value: "cart" }), expected: true },
    // The exact shape both of this app's real recorded URL assertions had, and
    // the reason neither could ever pass: "ends with the path" is false the
    // moment the URL carries a query string.
    { label: "urlEndsWith a bare path fails under query noise", step: s({ assert: "urlEndsWith", value: "/cart" }), expected: false },
    { label: "url contains still passes", step: s({ assert: "url", value: "/cart" }), expected: true },
  ];
  const disagreements: string[] = [];
  const wrong: string[] = [];
  for (const row of rows) {
    const fromSpec = await specVerdict(page, row.step, row.vars);
    const fromTrainer = await replayerVerdict(page, row.step, row.vars);
    if (fromSpec !== fromTrainer) {
      disagreements.push(`${row.label}: the run says ${fromSpec}, the trainer says ${fromTrainer}`);
    }
    if (fromSpec !== row.expected) {
      wrong.push(`${row.label}: expected ${row.expected}, the run says ${fromSpec}`);
    }
  }
  expect(disagreements, "the trainer and the run disagree about these steps").toEqual([]);
  expect(wrong, "these assertions do not do what the fixture says they should").toEqual([]);
});

test("an ambiguous locator fails in BOTH engines, not just the run", async ({ page }) => {
  await page.goto(base);
  // Playwright's strict mode refuses a locator matching two elements. The
  // trainer used to take the first match, so the single most common real
  // failure was invisible until a run — against a page nobody was looking at.
  // `getByText("Duplicate")` matches "Duplicate" and "Duplicate label",
  // because Playwright's text match is a substring.
  const step = { id: "amb", type: "assert", assert: "visible", locator: { k: "text", v: "Duplicate" } } as Step;
  expect(await specVerdict(page, step), "the run must refuse an ambiguous locator").toBe(false);
  expect(await replayerVerdict(page, step), "the trainer must refuse it too").toBe(false);
});

test("an indexed locator resolves in both engines", async ({ page }) => {
  await page.goto(base);
  const step = { id: "nth", type: "assert", assert: "visible", locator: { k: "text", v: "Duplicate", nth: 1 } } as Step;
  expect(await specVerdict(page, step)).toBe(true);
  expect(await replayerVerdict(page, step)).toBe(true);
});

test("a repeated flow call runs its steps exactly N times, and an assertion inside it still holds", async ({ page }) => {
  // The loop emitter changes what SURROUNDS a step's line — a real `for` with
  // a generated counter — so this is the row that catches the loop compiling
  // to something other than N executions: the flow clicks a self-counting
  // button, the caller repeats it, and a real assertion reads the count back.
  // Executed as the WHOLE generated body (loop braces included), not a single
  // extracted line, because the loop is the subject.
  const flow = {
    id: "f-bump",
    name: "Bump",
    flowParams: [],
    steps: [
      { id: "fb1", type: "click", locator: { k: "testid", v: "bump" }, timestamp: 0 },
    ] as Step[],
  };
  const runBody = async (steps: Step[], vars?: { name: string; kind: "plain"; value: string }[]) => {
    const src = generateSpec(
      { name: "loop", url: base, steps, variables: vars },
      { resolveFlow: (id) => (id === "f-bump" ? flow : null) },
    );
    const open = src.indexOf("=> {");
    const close = src.lastIndexOf("});");
    const body = src.slice(open + 4, close);
    const fast = expect.configure({ timeout: 1500 });
    const run = new Function("page", "expect", `return (async () => { ${body} })();`);
    await run(page, fast);
  };

  await page.goto(base);
  await runBody([
    { id: "c1", type: "runFlow", flowId: "f-bump", repeat: 3, timestamp: 0 },
    { id: "c2", type: "assert", assert: "exactText", text: "3", locator: { k: "testid", v: "bump" }, timestamp: 0 },
  ] as Step[]);

  // The variable-driven form: the count comes off the caller's V at run time.
  await page.goto(base);
  await runBody(
    [
      { id: "c1", type: "runFlow", flowId: "f-bump", repeatVar: "n", timestamp: 0 },
      { id: "c2", type: "assert", assert: "exactText", text: "2", locator: { k: "testid", v: "bump" }, timestamp: 0 },
    ] as Step[],
    [{ name: "n", kind: "plain", value: "2" }],
  );
});

test("a select step refuses an option that does not exist, in both engines", async ({ page }) => {
  await page.goto(base);
  // `el.value = "gone"` silently sets selectedIndex to -1 and reported success;
  // `selectOption` does not accept it. An action, so it is checked by running
  // the emitted line rather than an assertion.
  //
  // It does NOT fail fast: with no `actionTimeout` configured, `selectOption`
  // retries until the whole TEST times out, so the emitted line is raced here
  // rather than awaited. That asymmetry is worth stating plainly — the run
  // eventually reports a generic test timeout, while the trainer now says "no
  // option matches" and lists the options the element actually offers, which is
  // the difference between a diagnosis and a stack trace.
  const step = { id: "sel", type: "select", value: "gone", locator: { k: "testid", v: "country" } } as Step;
  const src = generateSpec({ name: "p", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await"))!.trim();
  const run = new Function("page", `return (async () => { ${line} })();`);
  const raced = await Promise.race([
    run(page).then(() => "succeeded").catch(() => "rejected"),
    new Promise<string>((r) => setTimeout(() => r("still-retrying"), 3000)),
  ]);
  expect(raced, "selectOption must never report success for a missing option").not.toBe("succeeded");

  const step2 = { id: "sel2", type: "select", value: "us", locator: { k: "testid", v: "country" } } as Step;
  expect(await replayerVerdict(page, step), "the trainer must refuse the missing option").toBe(false);
  expect(await replayerVerdict(page, step2), "…and still accept one that exists").toBe(true);
});

test("a scroll step materializes lazily-rendered content for the assertion after it, in both engines", async ({ page }) => {
  // The failure this feature exists for: content a page renders only on
  // scroll is not in the DOM until the scroll happens, Playwright assertions
  // do not scroll, and the trainer page — already scrolled by the user's own
  // hand — passed the assert that then failed every run. A recorded scroll
  // step must make both engines see the same page.
  const scrollStep = { id: "sc", type: "scroll", scrollX: 0, scrollY: 800 } as Step;
  const lazyAssert = {
    id: "la",
    type: "assert",
    assert: "visible",
    locator: { k: "testid", v: "lazy-review" },
  } as Step;

  await page.goto(base);

  // Before any scroll, the content is absent to BOTH engines.
  expect(await replayerVerdict(page, lazyAssert), "trainer: absent before scrolling").toBe(false);
  expect(await specVerdict(page, lazyAssert), "run: absent before scrolling").toBe(false);

  // Trainer half: the scroll step reveals it.
  expect(await replayerVerdict(page, scrollStep), "trainer: the scroll step succeeds").toBe(true);
  expect(await replayerVerdict(page, lazyAssert), "trainer: present after its scroll step").toBe(true);

  // Run half, on a fresh unscrolled document: the emitted glazeScrollTo walks
  // the REAL runtime helper (written to disk and imported, not re-derived).
  await page.goto(base);
  const src = generateSpec({ name: "lazy", url: base, steps: [scrollStep, lazyAssert] });
  expect(src).toContain("await glazeScrollTo(page, 0, 800);");
  const runtimePath = path.join(os.tmpdir(), `glaze-runtime-parity-${Date.now()}.mjs`);
  fs.writeFileSync(runtimePath, glazeRuntimeSource);
  try {
    const runtime = (await import(pathToFileURL(runtimePath).href)) as {
      glazeScrollTo: (p: Page, x: number, y: number) => Promise<void>;
    };
    await runtime.glazeScrollTo(page, 0, 800);
    expect(await specVerdict(page, lazyAssert), "run: present after the emitted scroll").toBe(true);
  } finally {
    fs.unlinkSync(runtimePath);
  }
});

test("an element scroll step emits a native call that reaches the element", async ({ page }) => {
  await page.goto(base);
  const step = { id: "el", type: "scroll", locator: { k: "testid", v: "deep" } } as Step;
  const src = generateSpec({ name: "deep", url: base, steps: [step] });
  const line = src.split("\n").find((l) => l.trim().startsWith("await"))!.trim();
  expect(line).toBe('await page.getByTestId("deep").scrollIntoViewIfNeeded();');
  const run = new Function("page", `return (async () => { ${line} })();`);
  await run(page);
  expect(await page.evaluate(() => window.scrollY), "the page actually scrolled").toBeGreaterThan(0);

  // And the trainer agrees the step succeeds.
  expect(await replayerVerdict(page, step)).toBe(true);
});
