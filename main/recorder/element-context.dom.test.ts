/* Runs in the "dom" Vitest project (jsdom) but lives under main/, which the
   shared lint config treats as Node-only — hence the explicit globals. */
/* global document, Element */

// Element context: the disambiguation the USER pins, and the prices the picker
// quotes for it.
//
// ── What this covers ───────────────────────────────────────────────────────
// Two halves, and they fail in different directions:
//
//   • `ctxFilter` — does a pinned context narrow the match set to what
//     Playwright would narrow it to? This is the half that decides whether a
//     step points at the right element, and it is folded into `matchesFor` so
//     that the capture script, the replayer and the heal probe all inherit it.
//     A bug here is silent: the wrong element is found and acted on, the step
//     passes, and the test quietly stops testing what it was written to test.
//
//   • `buildPicked` — are the offered signals the ones that actually
//     disambiguate, and are their counts true? A wrong count is worse than no
//     count: the whole point of pricing each row is that the user stops
//     guessing, and a confident wrong number is trusted exactly as much as a
//     confident right one.
//
// ── Why it is tested by RUNNING the script ─────────────────────────────────
// Same reason as locator-uniqueness.dom.test.ts: the subject is a disagreement
// between what the recorder believes about a page and what the page contains,
// so a test that mocks the page tests nothing. These evaluate the real injected
// strings against a real DOM.

import { beforeEach, describe, expect, it } from "vitest";

import {
  ATTR_PICKED,
  ATTR_REFINE,
  buildCaptureScript,
  PICKED_HELPERS,
  WORLD_STATE_KEY,
} from "./capture-script.js";
import { DOM_HELPERS, UNIQUENESS_HELPERS } from "../../shared/locator-engine.mjs";
import { normalizePickedElement } from "./types.js";
import type { ContextSignal, Locator, LocatorContext, PickedElement } from "./types.js";

/** The page-side resolver, as the page runs it. */
function resolver(): { matchesFor: (loc: Locator) => Element[] } {
  return eval(
    `(function () { ${DOM_HELPERS} ${UNIQUENESS_HELPERS} ${PICKED_HELPERS} return { matchesFor: matchesFor }; })()`,
  );
}

function matches(loc: Locator & { ctx?: LocatorContext }): Element[] {
  return resolver().matchesFor(loc);
}

/** Drive a real refine-mode pick and read back the PickedElement.
 *
 *  Through `normalizePickedElement`, deliberately — that is the boundary every
 *  real pick crosses, so a field the capture script emits and the normalizer
 *  drops would pass a test that read the attribute directly and then be absent
 *  in the app. This is the same trap `nth` fell into in locator-uniqueness. */
function pick(el: Element | null): PickedElement {
  expect(el, "the fixture element to pick").not.toBeNull();
  document.documentElement.setAttribute(ATTR_REFINE, "1");
  (el as HTMLElement).click();
  const raw = document.documentElement.getAttribute(ATTR_PICKED) || "";
  expect(raw, "refine mode wrote a picked element").not.toBe("");
  const picked = normalizePickedElement(JSON.parse(raw));
  expect(picked, "the picked element survives normalization").not.toBeNull();
  return picked as PickedElement;
}

function install(html: string): void {
  delete (window as unknown as Record<string, unknown>)[WORLD_STATE_KEY];
  document.documentElement.removeAttribute(ATTR_REFINE);
  document.documentElement.setAttribute(ATTR_PICKED, "");
  document.body.innerHTML = html;
  eval(buildCaptureScript("test-nonce"));
}

/** The signal a user would tick for a given container/attribute, or undefined. */
function signal(p: PickedElement, kind: string, value: string): ContextSignal | undefined {
  return p.contextSignals.find((s) => s.kind === kind && s.value === value);
}

// Two Billing/Shipping cards, each with an identical "Edit" button. The exact
// shape the feature exists for: nothing about either button tells them apart,
// and everything that does is one level up.
const TWO_CARDS = `
  <section data-testid="billing-card">
    <h3>Billing</h3>
    <button class="btn edit" data-qa="edit-billing">Edit</button>
  </section>
  <section data-testid="shipping-card">
    <h3>Shipping</h3>
    <button class="btn edit" data-qa="edit-shipping">Edit</button>
  </section>
`;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute(ATTR_REFINE);
  document.documentElement.removeAttribute(ATTR_PICKED);
});

describe("ctxFilter — what a pinned context narrows to", () => {
  it("a container scopes the match set to its descendants", () => {
    install(TWO_CARDS);
    const bare = { k: "role", role: "button", name: "Edit" } as Locator;
    expect(matches(bare), "both Edit buttons match with no context").toHaveLength(2);

    const scoped = matches({ ...bare, ctx: { within: { k: "testid", v: "billing-card" } } });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].getAttribute("data-qa")).toBe("edit-billing");
  });

  it("a container is not a match for itself", () => {
    // Playwright's `page.getByTestId("x").getByRole(…)` searches INSIDE x. If
    // `contains` were used without the identity check, a container that also
    // satisfied the base locator would match itself and the count would be one
    // too high — which reads as "still ambiguous" and sends the user hunting
    // for a second signal they do not need.
    install(`<div data-testid="outer" role="group"><div role="group">inner</div></div>`);
    const scoped = matches({
      k: "role",
      role: "group",
      ctx: { within: { k: "testid", v: "outer" } },
    } as Locator);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].textContent).toBe("inner");
  });

  it("withinHasText picks the container by its text", () => {
    install(`
      <ul>
        <li role="listitem"><span>Billing</span><button>Edit</button></li>
        <li role="listitem"><span>Shipping</span><button>Edit</button></li>
      </ul>
    `);
    const bare = { k: "role", role: "button", name: "Edit" } as Locator;
    expect(matches(bare)).toHaveLength(2);

    const rows = matches({
      ...bare,
      ctx: { within: { k: "role", role: "listitem" }, withinHasText: "Shipping" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].parentElement?.textContent).toContain("Shipping");
  });

  it("withinHasText matches the way Playwright matches — substring, case-insensitive", () => {
    // `.filter({ hasText })` is not an exact compare. Using one here would
    // UNDER-count, which is the direction that matters: it is the one that
    // declares a context sufficient when it is not.
    install(TWO_CARDS);
    const scoped = matches({
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { within: { k: "role", role: "region" }, withinHasText: "bill" },
    } as Locator);
    // <section> has no implicit region role without an accessible name here, so
    // this is really asserting the container query found nothing rather than
    // that it matched loosely — see the sibling test for the positive case.
    expect(scoped).toHaveLength(0);

    install(`<div role="region"><h3>Billing Address</h3><button>Edit</button></div>`);
    expect(
      matches({
        k: "role",
        role: "button",
        name: "Edit",
        ctx: { within: { k: "role", role: "region" }, withinHasText: "billing" },
      } as Locator),
      "lowercase 'billing' matches 'Billing Address'",
    ).toHaveLength(1);
  });

  it("an `and` predicate intersects rather than unions", () => {
    install(TWO_CARDS);
    const both = matches({
      k: "role",
      role: "button",
      name: "Edit",
      ctx: { and: [{ k: "css", v: '[data-qa="edit-shipping"]' }] },
    } as Locator);
    expect(both).toHaveLength(1);
    expect(both[0].getAttribute("data-qa")).toBe("edit-shipping");
  });

  it("several `and` predicates all have to hold", () => {
    install(`
      <button class="a b" id="one">Go</button>
      <button class="a" id="two">Go</button>
    `);
    const one = matches({
      k: "text",
      v: "Go",
      ctx: { and: [{ k: "css", v: ".a" }, { k: "css", v: ".b" }] },
    } as Locator);
    expect(one).toHaveLength(1);
    expect(one[0].id).toBe("one");
  });

  it("a context that matches nothing yields nothing rather than falling back", () => {
    // The failure direction that matters. Silently ignoring an unsatisfiable
    // context would act on an element the user explicitly excluded — and it
    // would do so by PASSING, which is the mis-heal failure mode the whole
    // hard-filter decision exists to avoid.
    install(TWO_CARDS);
    expect(
      matches({
        k: "role",
        role: "button",
        name: "Edit",
        ctx: { within: { k: "testid", v: "no-such-card" } },
      } as Locator),
    ).toHaveLength(0);
  });
});

describe("buildPicked — the signals offered, and their prices", () => {
  it("reports the recorder could not tell the two buttons apart", () => {
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    expect(p.ambiguous, "two identical Edit buttons are ambiguous").toBe(true);
    expect(p.contextBaseCount).toBe(2);
  });

  it("offers the enclosing card, and prices it at one", () => {
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    const s = signal(p, "within", "section");
    expect(s, "the enclosing section is offered as a container").toBeDefined();
    expect(s?.ctx.within).toEqual({ k: "testid", v: "billing-card" });
    expect(s?.count, "scoping to the billing card leaves one Edit button").toBe(1);
    expect(s?.resolves, "…which is the whole answer").toBe(true);
  });

  it("offers a data-test container WITH its attribute, so the run can scope by it", () => {
    // Same two-cards shape, but the cards spell their test ids as data-test.
    // The offered container must carry which attribute matched — a bare
    // testid here would generate getByTestId("billing-card") as the chain's
    // container, and the run would find no container at all.
    install(`
      <section data-test="billing-card">
        <h3>Billing</h3>
        <button class="btn edit" data-qa="edit-billing">Edit</button>
      </section>
      <section data-test="shipping-card">
        <h3>Shipping</h3>
        <button class="btn edit" data-qa="edit-shipping">Edit</button>
      </section>
    `);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    const s = signal(p, "within", "section");
    expect(s, "the enclosing section is offered as a container").toBeDefined();
    expect(s?.ctx.within).toEqual({ k: "testid", attr: "data-test", v: "billing-card" });
    expect(s?.count, "scoping to the billing card leaves one Edit button").toBe(1);
  });

  it("offers a landmark by its tag, not only by an explicit role attribute", () => {
    // GL_SCOPE_ROLES always listed navigation and main; roleOf only derived a
    // role from five tags, so a bare <nav> was never offered as a container
    // and the user was left with the section's class names.
    install(`
      <nav><button>Edit</button></nav>
      <main><button>Edit</button></main>
    `);
    const p = pick(document.querySelector("nav button"));
    const s = signal(p, "within", "nav");
    expect(s, "a <nav> with no role attribute is offered as a container").toBeDefined();
    // No name: navigation is not a name-from-content role, so the container
    // must not carry the button's text as its name.
    expect(s?.ctx.within).toEqual({ k: "role", role: "navigation" });
    expect(s?.count, "scoping to the nav leaves one Edit button").toBe(1);
  });

  it("prices a signal that does NOT disambiguate honestly", () => {
    // `class="btn edit"` is on both buttons. Offering it without a count would
    // invite the user to pin a property that narrows nothing — and because
    // context is a hard filter at heal time and a real constraint at run time,
    // that is a pure loss: it cannot help and it can break.
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    const s = signal(p, "class", "edit");
    expect(s, "the shared class is still offered").toBeDefined();
    expect(s?.count, "…priced at two, because it narrows nothing").toBe(2);
    expect(s?.resolves).toBe(false);
  });

  it("sweeps data-* attributes the fixed eight would miss", () => {
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    const s = signal(p, "attr", "edit-billing");
    expect(s, "data-qa is offered even though attrsOf does not collect it").toBeDefined();
    expect(s?.name).toBe("data-qa");
    expect(s?.count).toBe(1);
    expect(s?.resolves).toBe(true);
  });

  it("does not offer class as one opaque all-or-nothing string", () => {
    // `class="btn edit"` as a single exact match breaks the first time a
    // utility class is added. Each class is its own row.
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    const values = p.contextSignals.filter((s) => s.kind === "class").map((s) => s.value);
    expect(values).toContain("btn");
    expect(values).toContain("edit");
    expect(values).not.toContain("btn edit");
  });

  it("counts are relative to the locator the STEP would use, not candidates[0]", () => {
    // These differ exactly when the best-looking candidate is ambiguous — which
    // is the case the picker exists for. Pricing against candidates[0] would
    // misprice every row on precisely the elements that need it.
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    expect(p.contextBase, "a base locator is reported").toBeDefined();
    const bare = { ...(p.contextBase as Locator) };
    delete bare.nth;
    delete bare.ctx;
    expect(matches(bare).length).toBe(p.contextBaseCount);
  });

  it("an unambiguous element is not flagged, and needs no context", () => {
    install(`<button data-testid="only">Save</button><button>Cancel</button>`);
    const p = pick(document.querySelector('[data-testid="only"]'));
    expect(p.ambiguous, "a unique testid is not ambiguous").toBe(false);
    expect(p.contextBaseCount).toBe(1);
  });

  it("carries the element's own text and its nearest heading", () => {
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    expect(p.text).toBe("Edit");
    expect(p.neighborText, "the card's heading names it").toBe("Billing");
  });

  it("every offered signal's quoted count is what the page actually reports", () => {
    // The property that makes the whole list trustworthy, asserted over all of
    // it rather than on hand-picked rows: pinning any signal must leave exactly
    // as many elements as its price claims.
    install(TWO_CARDS);
    const p = pick(document.querySelector('[data-qa="edit-billing"]'));
    expect(p.contextSignals.length).toBeGreaterThan(3);
    for (const s of p.contextSignals) {
      const probe = { ...(p.contextBase as Locator), ctx: s.ctx };
      delete probe.nth;
      expect(matches(probe).length, `${s.kind} ${s.name}=${s.value} is mispriced`).toBe(s.count);
    }
  });
});
