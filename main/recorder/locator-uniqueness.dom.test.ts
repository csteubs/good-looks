/* Runs in the "dom" Vitest project (jsdom) but lives under main/, which the
   shared lint config treats as Node-only — hence the explicit globals. */
/* global document, Element */

// Does the recorder record a locator that can actually run?
//
// ── The bug ────────────────────────────────────────────────────────────────
// Playwright runs in STRICT MODE: a locator resolving to two elements does not
// quietly become the first one, it throws and fails the step. The capture
// script chose locators without ever asking the page how many elements the
// choice matched — so an ambiguous locator was recorded as readily as a unique
// one, and only failed later, on a run, against a page the user was no longer
// looking at.
//
// The report that prompted this: a test called "Will Pass Firefox" asserting
// `getByText("Browser")` against firefox.com, which has two elements matching
// that text. Every run failed with
//     strict mode violation: getByText('Browser') resolved to 2 elements
// and the recorded step looked perfectly ordinary in the trainer.
//
// ── Why it is tested by RUNNING the script ─────────────────────────────────
// The whole defect is a disagreement between what the recorder believed about
// the page and what the page contained, so a test that mocks the page tests
// nothing. This evaluates the real injected script against a real DOM, the same
// way auto-heal.dom.test.ts does, and asserts on the locator that comes back.
//
// VERIFIED TO FAIL against the previous implementation: with `locatorFor`
// returning its first guess unchecked, "picks a locator that is unique" and the
// two firefox.com cases all fail — the returned locator is
// `{k:"text", v:"Browser"}` with no `nth`, matching two elements.

import { beforeEach, describe, expect, it } from "vitest";

import { buildCaptureScript, DOM_HELPERS, UNIQUENESS_HELPERS, WORLD_STATE_KEY } from "./capture-script.js";
import { normalizeRawSteps } from "./types.js";
import type { Locator } from "./types.js";
import { generateSpec } from "../services/script-generator.js";
import type { TestRecord } from "./types.js";

/** Capture state as the injected script keeps it, in this file's window. */
interface CaptureState {
  queue: { i: number; s: unknown }[];
}
function state(): CaptureState {
  return (window as unknown as Record<string, CaptureState>)[WORLD_STATE_KEY];
}

/** Install the capture script into the current jsdom document.
 *
 *  The script is an IIFE guarded by the presence of its own state object, and
 *  jsdom keeps one window per test file — so the guard has to be cleared
 *  between tests or every test after the first installs nothing and asserts
 *  against the first test's listeners. Each install replaces the state object,
 *  so `state()` always belongs to the newest copy: the earlier copies' handlers
 *  still run and still push, but into an object nothing reads. That is enough
 *  for the question THIS file asks (which locator was chosen); the one that
 *  needs a genuinely clean window per test is capture-egress.dom.test.ts. */
function install(html: string): void {
  delete (window as unknown as Record<string, unknown>)[WORLD_STATE_KEY];
  document.body.innerHTML = html;
  eval(buildCaptureScript("test-nonce"));
}

/** Click an element and read back the step the capture script queued.
 *
 *  Through `normalizeRawSteps`, deliberately: that is the boundary every real
 *  step crosses, so a field the recorder emits but the normalizer drops would
 *  pass a test that read the queue directly and fail in the app. `nth` was
 *  exactly such a field until `normalizeLocator` learned it. */
function clickAndCapture(el: Element | null): Locator | undefined {
  expect(el, "the fixture element to click").not.toBeNull();
  (el as HTMLElement).click();
  // The queue holds `{i: seq, s: step}` envelopes — the sequence is what lets
  // the two capture channels deliver the same step without recording it twice
  // (see capture-channel.ts).
  const steps = normalizeRawSteps(state().queue.map((e) => e.s));
  expect(steps.length).toBeGreaterThan(0);
  return steps[steps.length - 1].locator;
}

/** How many elements a locator resolves to, judged the way Playwright judges
 *  it: case-insensitive substring, and for text the smallest matching element.
 *  Independent of the capture script's own counter on purpose — a test that
 *  reused it would pass whenever the two were wrong in the same direction. */
function countMatches(loc: Locator): number {
  const norm = (s: string | null | undefined) =>
    String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const has = (hay: string | null | undefined, needle: string) =>
    norm(hay).includes(norm(needle));

  // `getByTestId` resolves data-testid alone (nothing in this repo configures
  // Playwright's testIdAttribute); any other recorded attribute is spelled out
  // by the generator as an attribute selector. Counting all three here would
  // encode the very oracle bug this judge exists to catch.
  if (loc.k === "testid") {
    return document.querySelectorAll(`[${loc.attr ?? "data-testid"}="${loc.v}"]`).length;
  }
  if (loc.k === "css") return document.querySelectorAll(loc.v ?? "").length;
  if (loc.k === "placeholder") {
    return [...document.querySelectorAll("[placeholder]")].filter((el) =>
      has(el.getAttribute("placeholder"), loc.v ?? ""),
    ).length;
  }
  if (loc.k === "text") {
    const hits = [...document.querySelectorAll("*")].filter((el) => has(el.textContent, loc.v ?? ""));
    return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o))).length;
  }
  if (loc.k === "xpath") return 1; // positional by construction
  // role: judged by a SEPARATE reading of Playwright's table — a switch on the
  // tag, and the name-from-content rule as a list of its own — so a mistake in
  // the script's table cannot be mirrored here. Only the tags the rows below
  // use; the browser's own answer for the whole table is e2e/assert-parity.
  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        return el.hasAttribute("href") ? "link" : "";
      case "button":
        return "button";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "img":
        return el.getAttribute("alt") === "" ? "presentation" : "img";
      case "li":
        return "listitem";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "p":
        return "paragraph";
      case "ul":
      case "ol":
        return "list";
      case "input": {
        const ty = (el as HTMLInputElement).type;
        if (ty === "search") return "searchbox";
        if (ty === "checkbox" || ty === "radio") return ty;
        if (ty === "submit" || ty === "button") return "button";
        return "textbox";
      }
      case "select":
        return "combobox";
      case "textarea":
        return "textbox";
      default:
        return "";
    }
  };
  // Playwright's allowsNameFromContent — the roles whose name is their text.
  const NAMED_BY_CONTENT = new Set(["button", "heading", "link", "option", "cell", "row", "checkbox", "radio", "tab", "menuitem"]);
  return [...document.querySelectorAll("*")].filter((el) => {
    const role = el.getAttribute("role") ?? implicitRole(el);
    if (role !== loc.role) return false;
    if (!loc.name) return true;
    const name =
      el.getAttribute("aria-label") ??
      (el.tagName === "IMG" ? el.getAttribute("alt") : NAMED_BY_CONTENT.has(role) ? el.textContent : "");
    return has(name, loc.name);
  }).length;
}

/** The page-side resolver as the replayer and the heal probe run it, for the
 *  rows that ask which element a role resolves to rather than what a click
 *  records. Same strings the capture script is built from. */
function resolve(loc: Locator): Element[] {
  const fn = eval(
    `(function () { ${DOM_HELPERS} ${UNIQUENESS_HELPERS} return matchesFor; })()`,
  ) as (l: Locator) => Element[];
  return fn(loc);
}

/** The one property that matters: whatever locator was recorded, Playwright
 *  must be able to run it. Either it matches exactly one element, or it carries
 *  the index that narrows it to one. */
function expectRunnable(loc: Locator | undefined): void {
  expect(loc, "a locator was recorded").toBeDefined();
  const n = countMatches(loc as Locator);
  if (typeof (loc as Locator).nth === "number") {
    expect(n, "an indexed locator still has to reach its index").toBeGreaterThan(
      (loc as Locator).nth as number,
    );
  } else {
    expect(n, `${JSON.stringify(loc)} is a strict-mode violation`).toBe(1);
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the locator the recorder chooses", () => {
  it("keeps the obvious answer when the obvious answer is unique", () => {
    // The whole preference order still applies — this is not "always use an
    // xpath". A page with one Sign in button records getByRole, as it always
    // did, with no index attached.
    install(`
      <nav><a href="/about">About</a></nav>
      <main><button>Sign in</button></main>
    `);
    const loc = clickAndCapture(document.querySelector("button"));
    expect(loc).toEqual({ k: "role", role: "button", name: "Sign in" });
    expectRunnable(loc);
  });

  it("prefers a test id over everything, and does not index a unique one", () => {
    install(`<button data-testid="submit">Go</button><span>Go</span>`);
    const loc = clickAndCapture(document.querySelector("button"));
    expect(loc).toEqual({ k: "testid", v: "submit" });
  });

  describe("the firefox.com case — two elements, same text", () => {
    // The exact shape of the reported failure: two spans, identical text, no
    // role, no test id. `getByText("Browser")` resolves to both.
    const FIREFOX = `
      <div data-testid="navigation-menu-items">
        <div data-testid="navigation-link-browser"><span class="fl-menu-heading">Browser</span></div>
      </div>
      <footer><span class="fl-menu-heading">Browser</span></footer>
    `;

    it("does not record the bare text locator that failed every run", () => {
      install(FIREFOX);
      const loc = clickAndCapture(document.querySelector("[data-testid] span"));
      // The regression itself. Before the fix this was exactly what came back.
      expect(loc).not.toEqual({ k: "text", v: "Browser" });
    });

    it("records something Playwright can actually run", () => {
      install(FIREFOX);
      expectRunnable(clickAndCapture(document.querySelector("[data-testid] span")));
    });

    it("distinguishes the second match from the first", () => {
      install(FIREFOX);
      const first = clickAndCapture(document.querySelector("[data-testid] span"));
      state().queue.length = 0;
      const second = clickAndCapture(document.querySelector("footer span"));
      // Two different elements must not record the same locator — that is the
      // silent half of this bug, where the test passes against the wrong thing.
      expect(second).not.toEqual(first);
      expectRunnable(second);
    });
  });

  it("indexes when nothing on the page can tell two elements apart", () => {
    // Identical siblings with no id, no testid and no distinguishing text.
    // cssPath uses :nth-of-type, so it is usually the rescue here; the contract
    // under test is only that the result RUNS.
    install(`<ul><li><span>Item</span></li><li><span>Item</span></li></ul>`);
    const loc = clickAndCapture(document.querySelectorAll("li span")[1]);
    expectRunnable(loc);
  });

  it("counts a substring the way Playwright does, not an exact string", () => {
    // "Browser" is a substring of "Browsers", so getByText("Browser") matches
    // both. An exact-string counter would call this unique and ship the
    // strict-mode violation — this is the case that pins the semantics.
    install(`<div><span>Browser</span></div><div><span>Browsers</span></div>`);
    const loc = clickAndCapture(document.querySelector("span"));
    expect(loc).not.toEqual({ k: "text", v: "Browser" });
    expectRunnable(loc);
  });

  it("rejects a candidate that uniquely matches the WRONG element", () => {
    // A wrapper whose text comes entirely from its child. The text candidate
    // built from the wrapper is "Details", and it resolves to exactly ONE
    // element — the child, because the text engine returns the smallest match.
    // A count alone would call that unique and record it, producing a step that
    // acts on a different element than the one clicked. That failure mode is
    // worse than ambiguity: it does not throw, it silently passes against the
    // wrong thing. Hence `found[0] === el` and not just `found.length === 1`.
    install(`<div id="wrap"><span>Details</span></div>`);
    const loc = clickAndCapture(document.querySelector("#wrap"));
    expect(loc).not.toEqual({ k: "text", v: "Details" });
    expectRunnable(loc);
  });
});

describe("which test-id attribute the element carries", () => {
  // The recorder accepted data-testid, data-test-id and data-test as one
  // "testid" kind and the oracle counted matches across all three — but the
  // generated spec said `getByTestId()`, which resolves ONLY data-testid. A
  // step recorded off either other attribute was declared unique, replayed
  // green in the trainer, and matched nothing on every run.

  it("records WHICH attribute matched, so the run resolves what the trainer counted", () => {
    install(`<button data-test="quick-save">Go</button>`);
    const loc = clickAndCapture(document.querySelector("button"));
    expect(loc).toEqual({ k: "testid", attr: "data-test", v: "quick-save" });
    expectRunnable(loc);
  });

  it("records data-test-id the same way", () => {
    install(`<button data-test-id="legacy-save">Go</button>`);
    const loc = clickAndCapture(document.querySelector("button"));
    expect(loc).toEqual({ k: "testid", attr: "data-test-id", v: "legacy-save" });
    expectRunnable(loc);
  });

  it("leaves the attribute off for data-testid, the one getByTestId resolves", () => {
    install(`<button data-testid="submit">Go</button>`);
    expect(clickAndCapture(document.querySelector("button"))).toEqual({ k: "testid", v: "submit" });
  });

  it("does not let another attribute's equal value spoil a unique data-testid", () => {
    // The reverse half of the same disagreement: the three-attribute oracle
    // counted the data-test element as a second match for a locator the run
    // resolves uniquely, so the recorder walked away from a perfectly good
    // testid and recorded something weaker.
    install(`<button data-testid="dup">A</button><i data-test="dup">B</i>`);
    const loc = clickAndCapture(document.querySelector("button"));
    expect(loc).toEqual({ k: "testid", v: "dup" });
  });

  it("prefers data-testid when an element carries more than one", () => {
    install(`<button data-testid="modern" data-test="legacy">Go</button>`);
    expect(clickAndCapture(document.querySelector("button"))).toEqual({
      k: "testid",
      v: "modern",
    });
  });
});

describe("the generated spec", () => {
  function specFor(loc: Locator): string {
    const record = {
      id: "t1",
      name: "T",
      url: "https://example.com",
      createdAt: 0,
      steps: [{ id: "s1", timestamp: 0, type: "assert", assert: "visible", locator: loc }],
    } as unknown as TestRecord;
    return generateSpec(record);
  }

  it("emits .nth() so the step stops being a strict-mode violation", () => {
    expect(specFor({ k: "text", v: "Browser", nth: 1 })).toContain(
      'getByText("Browser").nth(1)',
    );
  });

  it("emits .nth(0) rather than dropping it", () => {
    // 0 is a real index. A falsy check here would put the violation back for
    // precisely the first element of every ambiguous match.
    expect(specFor({ k: "text", v: "Browser", nth: 0 })).toContain(
      'getByText("Browser").nth(0)',
    );
  });

  it("leaves a unique locator exactly as it was", () => {
    const spec = specFor({ k: "text", v: "Browser" });
    expect(spec).toContain('getByText("Browser")');
    expect(spec).not.toContain(".nth(");
  });

  it("spells out a test-id attribute getByTestId would not resolve", () => {
    expect(specFor({ k: "testid", attr: "data-test", v: "quick-save" })).toContain(
      'locator("[data-test=\\"quick-save\\"]")',
    );
    expect(specFor({ k: "testid", attr: "data-test-id", v: "legacy-save" })).toContain(
      'locator("[data-test-id=\\"legacy-save\\"]")',
    );
  });

  it("still emits getByTestId when no attribute is recorded", () => {
    const spec = specFor({ k: "testid", v: "submit" });
    expect(spec).toContain('getByTestId("submit")');
    expect(spec).not.toContain("data-testid");
  });

  it("ignores an attribute outside the allowlist rather than emitting it", () => {
    // Steps recorded before the normalizer learned `attr` are regenerated from
    // disk, so the generator guards the field itself rather than trusting that
    // every stored step has been through `normalizeLocator`.
    const hostile = { k: "testid", v: "x", attr: 'foo="y"],[id' } as unknown as Locator;
    const spec = specFor(hostile);
    expect(spec).toContain('getByTestId("x")');
    expect(spec).not.toContain("foo=");
  });

  it("never interpolates a non-numeric index into the source", () => {
    // The generator quotes every string it emits; numerics are concatenated
    // raw, which is how a `count` field once got arbitrary Node code into a
    // spec. `nth` lands in exactly that position.
    const hostile = { k: "text", v: "x", nth: "0); process.exit(1); (" } as unknown as Locator;
    const spec = specFor(hostile);
    expect(spec).not.toContain("process.exit");
  });
});

// ── The roles Playwright derives from a tag ───────────────────────────────
//
// Until 2026-08-22 `roleOf` knew five tags. An <h1> had no role, so a click
// on it recorded a positional path and an assertion on it a substring of its
// text — and the substring was a strict-mode violation the moment the page
// held another element containing the word. Playwright's own error named the
// locator it would have used: getByRole('heading', { name: 'Mountain' }).
//
// The table is a transcription, and a transcription's failure mode is silent:
// a wrong entry verifies as unique against itself. The fast half is here; the
// browser's own answer for every conditional entry is e2e/assert-parity.

describe("the roles Playwright derives from a tag", () => {
  it("records a heading by role and name where its text is a substring of other text", () => {
    // The shape that failed against unsplash.com: a heading above two tag
    // links whose text contains the word. getByText("Mountain") resolves to
    // all three; the heading's role identifies it on its own.
    install(`
      <main>
        <h1>Mountain</h1>
        <a href="/s/mountains">mountains</a>
        <a href="/s/mountain-peak">mountain peak</a>
      </main>
    `);
    const loc = clickAndCapture(document.querySelector("h1"));
    expect(loc).toEqual({ k: "role", role: "heading", name: "Mountain" });
    expectRunnable(loc);
  });

  it("records an image by role and alt", () => {
    install(`<img alt="A tiger" src="data:,"><img alt="A lion" src="data:,">`);
    const loc = clickAndCapture(document.querySelector("img"));
    expect(loc).toEqual({ k: "role", role: "img", name: "A tiger" });
    expectRunnable(loc);
  });

  it("does not name a list item by its content, because Playwright does not", () => {
    // listitem is not a name-from-content role: getByRole("listitem", { name:
    // "Beta" }) would verify unique against a table that said otherwise and
    // match nothing in the run. The text locator is the one that runs.
    install(`<ul><li>Alpha</li><li>Beta</li></ul>`);
    const loc = clickAndCapture(document.querySelectorAll("li")[1]);
    expect(loc).toEqual({ k: "text", v: "Beta" });
    expectRunnable(loc);
  });

  it("does not turn an ambiguous paragraph into an indexed role locator", () => {
    // Every <p> has the paragraph role now. A nameless getByRole("paragraph")
    // .nth(1) is the positional path with a better-looking name — an index
    // into DOM order, breaking the same way — so what the recorder wrote
    // before is what it still writes: the unique positional path, which its
    // existing rule prefers over an indexed text locator.
    install(`<p>Same</p><p>Same</p>`);
    const loc = clickAndCapture(document.querySelectorAll("p")[1]);
    expect(loc?.k, "no role locator for a paragraph").not.toBe("role");
    expect(loc).toEqual({ k: "css", v: "html > body > p:nth-of-type(2)" });
    expectRunnable(loc);
  });

  it("a header inside a landmark is not a banner; one outside is", () => {
    install(`
      <header id="top">Site</header>
      <main><header id="inner">Section</header></main>
    `);
    const banners = resolve({ k: "role", role: "banner" });
    expect(banners.map((el) => el.id)).toEqual(["top"]);
  });

  it("a section is a region only with an accessible name, a form a form only with one", () => {
    install(`
      <section id="anon"><p>a</p></section>
      <section id="named" aria-label="Billing"><p>b</p></section>
      <form id="plain"><input></form>
      <form id="labelled" aria-label="Search"><input></form>
    `);
    expect(resolve({ k: "role", role: "region" }).map((el) => el.id)).toEqual(["named"]);
    expect(resolve({ k: "role", role: "form" }).map((el) => el.id)).toEqual(["labelled"]);
  });

  it("an alt=\"\" image is presentation, not img", () => {
    install(`<img id="deco" alt="" src="data:,"><img id="photo" alt="A photo" src="data:,">`);
    expect(resolve({ k: "role", role: "img" }).map((el) => el.id)).toEqual(["photo"]);
  });

  it("table headers and cells take the roles the table's own role gives them", () => {
    install(`
      <table><tr><th id="col" scope="col">Name</th><th id="row" scope="row">R</th><td id="cell">v</td></tr></table>
      <table role="grid"><tr><td id="gridcell">g</td></tr></table>
    `);
    expect(resolve({ k: "role", role: "columnheader" }).map((el) => el.id)).toEqual(["col"]);
    expect(resolve({ k: "role", role: "rowheader" }).map((el) => el.id)).toEqual(["row"]);
    expect(resolve({ k: "role", role: "cell" }).map((el) => el.id)).toEqual(["cell"]);
    expect(resolve({ k: "role", role: "gridcell" }).map((el) => el.id)).toEqual(["gridcell"]);
  });
});
