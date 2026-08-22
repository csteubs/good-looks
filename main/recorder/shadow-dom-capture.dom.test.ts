/* Runs in the "dom" Vitest project (jsdom) but lives under main/, which the
   shared lint config treats as Node-only — hence the explicit globals. */
/* global document, Element, Event */

// Can the recorder see inside a web component?
//
// ── The bug ────────────────────────────────────────────────────────────────
// Two independent holes, both silent, both hit by the same page.
//
// 1. RETARGETING. The capture listeners are attached to `window` and
//    `document`. An event that crosses a shadow boundary is retargeted on the
//    way out, so by the time it reaches a document-level listener `e.target`
//    is the shadow HOST — never the button that was clicked. Every click
//    inside a web component was therefore recorded as a click on the
//    component's container. The step replays, passes, and does nothing.
//
// 2. THE ORACLE. `matchesFor` graded locators with `document.querySelectorAll`,
//    which does not pierce shadow roots. Playwright's selector engines do. So
//    a locator the run resolves perfectly well was graded here as matching
//    NOTHING — the same trainer/run disagreement as the test-id attribute bug,
//    pointing the other way.
//
// Found against ritual.com, whose DataGrail consent modal is
// `<aside class="dg-consent-banner">` with an open shadow root holding Accept
// All / Manage Cookies / Close. Measured there: `button.dg-button.accept_all`
// resolved to 0 elements through `document.querySelectorAll` and to 1 through
// real Playwright. That page is not unusual — it carries 28 custom elements,
// and its cart drawer and product forms are shadow hosts too.
//
// ── Why it is tested by RUNNING the script ─────────────────────────────────
// The defect is a disagreement between what the recorder believes about the
// page and what the page contains, so a test that mocks the page tests
// nothing. This evaluates the real injected script against a real (jsdom) DOM,
// the same way locator-uniqueness.dom.test.ts does. jsdom models both halves
// faithfully: it retargets `e.target` to the host, and its
// `document.querySelectorAll` stops at the shadow boundary exactly as a
// browser's does.
//
// VERIFIED TO FAIL against the previous implementation: reverting `evTarget`
// to `e.target` fails every "records the element inside", and reverting
// `scanAll` to the bare `document.querySelectorAll` fails every "the oracle
// counts".

import { beforeEach, describe, expect, it } from "vitest";

import {
  ATTR_PICKED,
  ATTR_REFINE,
  buildCaptureScript,
  DOM_HELPERS,
  MAX_SHADOW_ROOTS,
  UNIQUENESS_HELPERS,
  WORLD_STATE_KEY,
} from "./capture-script.js";
import {
  normalizePickedElement,
  normalizeRawStep,
  normalizeRawSteps,
  normalizeStep,
} from "./types.js";
import type { Locator, PickedElement, RawStep } from "./types.js";

interface CaptureState {
  queue: { i: number; s: unknown }[];
}
function state(): CaptureState {
  return (window as unknown as Record<string, CaptureState>)[WORLD_STATE_KEY];
}

/** Install the capture script into the current jsdom document. Same idiom and
 *  same reason as locator-uniqueness.dom.test.ts: the script is an IIFE guarded
 *  by its own state object, so the guard is cleared or every test after the
 *  first installs nothing. */
function install(html: string): void {
  delete (window as unknown as Record<string, unknown>)[WORLD_STATE_KEY];
  document.body.innerHTML = html;
  eval(buildCaptureScript("test-nonce"));
}

/** Attach an open shadow root to `#host` and fill it. Returns the root so a
 *  test can reach the elements `document` cannot. */
function attachOpen(html: string, hostId = "host"): ShadowRoot {
  const host = document.getElementById(hostId);
  expect(host, "the fixture host element").not.toBeNull();
  const root = (host as HTMLElement).attachShadow({ mode: "open" });
  root.innerHTML = html;
  return root;
}

/** Drive a real refine-mode pick and read back the PickedElement through
 *  `normalizePickedElement` — the boundary every real pick crosses, so a
 *  field the script emits and the normalizer drops fails here rather than
 *  in the app. Same helper as element-context.dom.test.ts. */
function pick(el: Element | null): PickedElement {
  expect(el, "the fixture element to pick").not.toBeNull();
  document.documentElement.setAttribute(ATTR_REFINE, "1");
  try {
    (el as HTMLElement).click();
    const raw = document.documentElement.getAttribute(ATTR_PICKED) || "";
    expect(raw, "refine mode wrote a picked element").not.toBe("");
    const picked = normalizePickedElement(JSON.parse(raw));
    expect(picked, "the picked element survives normalization").not.toBeNull();
    return picked as PickedElement;
  } finally {
    document.documentElement.removeAttribute(ATTR_REFINE);
    document.documentElement.removeAttribute(ATTR_PICKED);
  }
}

/** The last step the capture script queued, through `normalizeRawSteps` —
 *  the boundary every real step crosses. */
function lastStep(): RawStep | undefined {
  const steps = normalizeRawSteps(state().queue.map((e) => e.s));
  return steps[steps.length - 1];
}

/** `matchesFor` from the real UNIQUENESS_HELPERS, evaluated against this
 *  document. This is the oracle the trainer grades locators with, and the one
 *  the heal probe and the step replayer share. */
function matchesFor(loc: Locator): Element[] {
  const fn = eval(
    `(function () { ${DOM_HELPERS} ${UNIQUENESS_HELPERS} return matchesFor; })()`,
  ) as (l: Locator) => Element[];
  return fn(loc);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("clicking inside an open shadow root", () => {
  it("records the element inside, not the shadow host", () => {
    install(`<aside id="host" class="dg-consent-banner"></aside>`);
    const root = attachOpen(`<button class="dg-button accept_all">Accept All</button>`);

    (root.querySelector("button") as HTMLElement).click();

    const step = lastStep();
    expect(step?.type).toBe("click");
    // The whole bug in one assertion: before the fix this was the <aside>.
    expect(step?.locator).toMatchObject({ k: "role", role: "button" });
    expect(step?.locator?.name ?? "").toMatch(/accept all/i);
  });

  it("records the element inside a NESTED shadow root", () => {
    install(`<div id="host"></div>`);
    const outer = attachOpen(`<div id="mid"></div>`);
    const mid = outer.getElementById("mid") as HTMLElement;
    const inner = mid.attachShadow({ mode: "open" });
    inner.innerHTML = `<button data-testid="deep-btn">Deep</button>`;

    (inner.querySelector("button") as HTMLElement).click();

    expect(lastStep()?.locator).toMatchObject({ k: "testid", v: "deep-btn" });
  });

  it("still records a plain light-DOM click unchanged", () => {
    // The fallback path has to stay boring: `composedPath()[0]` and `e.target`
    // are the same element when nothing was crossed.
    install(`<button data-testid="plain">Plain</button>`);
    (document.querySelector("button") as HTMLElement).click();
    expect(lastStep()?.locator).toMatchObject({ k: "testid", v: "plain" });
  });

  it("records typing into a field inside a shadow root", () => {
    // `onChange` reads the target too, and a fill recorded against the host
    // would name an element with no value to set.
    install(`<div id="host"></div>`);
    const root = attachOpen(`<input data-testid="shadow-field" />`);
    const field = root.querySelector("input") as HTMLInputElement;
    field.value = "hello";
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const step = lastStep();
    expect(step?.locator).toMatchObject({ k: "testid", v: "shadow-field" });
    expect(step?.value).toBe("hello");
  });
});

describe("the uniqueness oracle", () => {
  it("counts a match inside an open shadow root", () => {
    document.body.innerHTML = `<aside id="host"></aside>`;
    attachOpen(`<button class="dg-button accept_all">Accept All</button>`);

    // The measurement that started this: 0 through the bare document query,
    // 1 through real Playwright.
    expect(document.querySelectorAll("button.accept_all")).toHaveLength(0);
    expect(matchesFor({ k: "css", v: "button.accept_all" })).toHaveLength(1);
  });

  it("counts across SEVERAL shadow roots, so an ambiguous locator reads as ambiguous", () => {
    // The direction that matters for strict mode: two components each
    // containing a "Save" button is a locator that must not be recorded bare.
    document.body.innerHTML = `<div id="a"></div><div id="b"></div>`;
    attachOpen(`<button data-testid="save">Save</button>`, "a");
    attachOpen(`<button data-testid="save">Save</button>`, "b");

    expect(matchesFor({ k: "testid", v: "save" })).toHaveLength(2);
  });

  it("counts light DOM and shadow DOM together", () => {
    document.body.innerHTML = `<button data-testid="save">Light</button><div id="host"></div>`;
    attachOpen(`<button data-testid="save">Shadow</button>`, "host");

    expect(matchesFor({ k: "testid", v: "save" })).toHaveLength(2);
  });

  it("does NOT descend into a CLOSED shadow root", () => {
    // Parity, not an omission: script cannot reach a closed root and neither
    // can Playwright, so counting it would make the oracle disagree the other
    // way — reporting an element the run can never resolve.
    document.body.innerHTML = `<div id="host"></div>`;
    const closed = (document.getElementById("host") as HTMLElement).attachShadow({
      mode: "closed",
    });
    closed.innerHTML = `<button data-testid="hidden-btn">Nope</button>`;

    expect(matchesFor({ k: "testid", v: "hidden-btn" })).toHaveLength(0);
  });

  it("resolves a role locator inside a shadow root", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    attachOpen(`<button>Manage Cookies</button>`);
    const hits = matchesFor({ k: "role", role: "button", name: "Manage Cookies" });
    expect(hits).toHaveLength(1);
  });

  it("resolves a text locator to the smallest element inside a shadow root", () => {
    // `contains` cannot cross a shadow boundary, and it does not need to: a
    // host's textContent does not include its shadow content, so the host is
    // not a competing match in the first place.
    document.body.innerHTML = `<div id="host"></div>`;
    attachOpen(`<div class="wrap"><span>Accept All</span></div>`);
    const hits = matchesFor({ k: "text", v: "Accept All" });
    expect(hits).toHaveLength(1);
    expect(hits[0].tagName.toLowerCase()).toBe("span");
  });

  it("reads a host's root text for `withinHasText`, as filter({ hasText }) does", () => {
    // Playwright's elementText includes a host's shadow-root text, so a
    // `hasText` filter on the host holds when the text is inside the root.
    // `textContent` on the host is empty, and a filter built on it kept no
    // container — so "within x-card that has text Save" counted 0 here and 2
    // in the run. VERIFIED TO FAIL by dropping the shadowRoot line in pwText.
    install(`<x-card id="host"></x-card><x-card id="host2"></x-card>`);
    const a = attachOpen(`<button>Save</button>`, "host");
    const b = attachOpen(`<button>Save</button>`, "host2");
    const found = matchesFor({
      k: "role",
      role: "button",
      name: "Save",
      ctx: { within: { k: "css", v: "x-card" }, withinHasText: "Save" },
    });
    expect(found).toEqual([a.querySelector("button"), b.querySelector("button")]);
  });

  it("leaves XPath document-only, matching the one engine Playwright does not pierce", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    attachOpen(`<button data-testid="x">X</button>`);
    // No throw, no match — the same answer a real run gives.
    expect(matchesFor({ k: "xpath", v: "//button" })).toHaveLength(0);
  });

  it("stays bounded on a pathologically nested document", () => {
    // The cap is a backstop, not a budget the normal case spends. Build more
    // roots than it allows and assert the scan still returns rather than
    // walking forever.
    document.body.innerHTML = `<div id="host"></div>`;
    let root = attachOpen(`<div id="n0"></div>`);
    for (let i = 1; i <= MAX_SHADOW_ROOTS + 20; i++) {
      const next = root.getElementById(`n${i - 1}`) as HTMLElement;
      if (!next) break;
      root = next.attachShadow({ mode: "open" });
      root.innerHTML = `<div id="n${i}"></div>`;
    }
    expect(() => matchesFor({ k: "css", v: "div" })).not.toThrow();
  });
});

describe("picking an element at a point", () => {
  // The right-click "pick element here" path and the drag-release target both
  // ask the document what is under the cursor. `document.elementFromPoint`
  // stops at the shadow host, so both would pick the component instead of the
  // control — the same wrong answer as the retargeted click, reached a
  // different way.
  //
  // jsdom implements neither `document.elementFromPoint` nor the ShadowRoot
  // one, so both are stubbed to model the single thing that matters: each root
  // answers for its own tree. The descent, the loop guard and the bound are the
  // real code.
  function deepElementFromPoint(x: number, y: number): Element | null {
    const fn = eval(`(function () { ${DOM_HELPERS} return deepElementFromPoint; })()`) as (
      x: number,
      y: number,
    ) => Element | null;
    return fn(x, y);
  }
  function answerWith(node: Document | ShadowRoot, el: Element | null): void {
    (node as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => el;
  }

  it("descends into an open shadow root instead of stopping at the host", () => {
    document.body.innerHTML = `<aside id="host"></aside>`;
    const root = attachOpen(`<button class="accept_all">Accept All</button>`);
    const host = document.getElementById("host") as HTMLElement;
    const btn = root.querySelector("button") as Element;
    answerWith(document, host);
    answerWith(root, btn);

    expect(deepElementFromPoint(10, 10)).toBe(btn);
  });

  it("descends through NESTED roots", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const outer = attachOpen(`<div id="mid"></div>`);
    const host = document.getElementById("host") as HTMLElement;
    const midHost = outer.getElementById("mid") as HTMLElement;
    const inner = midHost.attachShadow({ mode: "open" });
    inner.innerHTML = `<button>Deep</button>`;
    const btn = inner.querySelector("button") as Element;
    answerWith(document, host);
    answerWith(outer, midHost);
    answerWith(inner, btn);

    expect(deepElementFromPoint(10, 10)).toBe(btn);
  });

  it("stops rather than spinning when a root answers with its own host", () => {
    // A root whose host fills the point answers with that host. Without the
    // `next !== node` guard this is an infinite loop on the gesture path.
    document.body.innerHTML = `<div id="host"></div>`;
    const root = attachOpen(`<span>x</span>`);
    const host = document.getElementById("host") as HTMLElement;
    answerWith(document, host);
    answerWith(root, host);

    expect(deepElementFromPoint(10, 10)).toBe(host);
  });

  it("returns the light-DOM answer unchanged when nothing has a shadow root", () => {
    document.body.innerHTML = `<button id="plain">Plain</button>`;
    const btn = document.getElementById("plain") as Element;
    answerWith(document, btn);

    expect(deepElementFromPoint(10, 10)).toBe(btn);
  });
});

// ── The mark, and the XPath that is withheld ────────────────────────────────
//
// Capturing the right element (above) made these steps CORRECT; nothing yet
// made them LEGIBLE. A step inside a web component looks exactly like any other
// in the list, and it differs in one way a user will eventually hit: it has no
// XPath fallback, because an xpath for it is relative to the shadow root and
// resolves to nothing in any engine. So the capture script marks the step
// (`Step.shadow`), the row shows a chip, and the candidate lists — the refine
// picker's and the heal probe's, which share `candidatesFor` — leave the xpath
// out rather than offering a locator that cannot work.
//
// VERIFIED TO FAIL: dropping the `inShadow` stamp in `withFp` fails every
// "marks" test; restoring the unconditional xpath push in `candidatesFor` fails
// "offers no xpath candidate".

describe("the web-component mark", () => {
  it("marks a click recorded inside an open shadow root", () => {
    install(`<div id="host"></div>`);
    const root = attachOpen(`<button data-testid="inner">Go</button>`);
    (root.querySelector("button") as HTMLElement).click();
    expect(lastStep()?.shadow).toBe(true);
  });

  it("does not mark a light-DOM click", () => {
    install(`<button data-testid="plain">Plain</button>`);
    (document.querySelector("button") as HTMLElement).click();
    expect(lastStep()?.shadow).toBeUndefined();
  });

  it("marks a fill inside a shadow root", () => {
    install(`<div id="host"></div>`);
    const root = attachOpen(`<input data-testid="shadow-field" />`);
    const field = root.querySelector("input") as HTMLInputElement;
    field.value = "hello";
    field.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    expect(lastStep()?.shadow).toBe(true);
  });

  it("is kept by both normalizers, and only as `true`", () => {
    const locator = { k: "testid", v: "x" };
    expect(normalizeRawStep({ type: "click", locator, shadow: true })?.shadow).toBe(true);
    // A page can put anything on the wire; a truthy string is not the mark.
    expect(normalizeRawStep({ type: "click", locator, shadow: "yes" })?.shadow).toBeUndefined();
    expect(
      normalizeStep({ id: "s", timestamp: 0, type: "click", locator, shadow: true })?.shadow,
    ).toBe(true);
  });

  it("rides on a picked element, so a step authored from the pick carries it", () => {
    install(`<div id="host"></div>`);
    const root = attachOpen(`<button data-testid="inner">Go</button>`);
    expect(pick(root.querySelector("button")).shadow).toBe(true);
  });

  it("is absent from a light-DOM pick", () => {
    install(`<button data-testid="plain">Plain</button>`);
    expect(pick(document.querySelector("button")).shadow).toBeUndefined();
  });
});

describe("no XPath inside a shadow tree", () => {
  it("offers no xpath candidate for a picked element inside a shadow root", () => {
    install(`<div id="host"></div>`);
    const root = attachOpen(`<button>Go</button>`);
    const kinds = pick(root.querySelector("button")).candidates.map((c) => c.k);
    expect(kinds).not.toContain("xpath");
    // The css path stays, so the list still ends in something positional.
    expect(kinds).toContain("css");
  });

  it("still offers an xpath for a light-DOM pick", () => {
    install(`<button>Go</button>`);
    expect(pick(document.querySelector("button")).candidates.map((c) => c.k)).toContain("xpath");
  });

  it("records a locator the piercing oracle resolves when nothing inside the root is unique", () => {
    // Two identical components. No candidate is unique, so the recorder falls
    // back to an indexed one — and whatever it records must resolve, through
    // the oracle the run agrees with, to the button that was clicked.
    install(`<div id="host"></div><div id="host2"></div>`);
    attachOpen(`<button>Go</button>`, "host");
    const second = attachOpen(`<button>Go</button>`, "host2");
    (second.querySelector("button") as HTMLElement).click();

    const loc = lastStep()?.locator as Locator;
    expect(loc.k).not.toBe("xpath");
    // `matchesFor` answers the un-indexed set on purpose (nth is applied by
    // whoever consumes it, after context), so index it the way the run does.
    expect(typeof loc.nth, "nothing was unique, so an index was recorded").toBe("number");
    expect(matchesFor(loc)[loc.nth as number]).toBe(second.querySelector("button"));
  });
});
