// The trainer's verdict, checked against what a real run would say.
//
// Sibling of `step-replayer.dom.test.ts`, which covers that the replayer WORKS.
// This one covers that it does not LIE — every case here is a divergence the
// audit found, where the trainer reported one thing and the generated spec did
// another. They are grouped by the failure they produced rather than by the
// code path they touch, because the code paths were all fine in isolation; it
// was the disagreement that shipped bugs.
//
// The tests that matter most are the ones where the trainer used to say OK.
// A trainer that is wrong in the pessimistic direction wastes an afternoon; one
// that is wrong in the optimistic direction ships a test suite nobody can trust
// and takes the product's whole value proposition with it.

/* global document, Element, DOMRect */

import { beforeEach, describe, expect, it } from "vitest";

import { buildReplayScript } from "./step-replayer.js";
import type { Step, StepType } from "../recorder/types.js";

interface ReplayResult {
  ok: boolean;
  error?: string;
  met?: boolean;
  logs: { i: number; t: number; level: string; m: string }[];
}

function step(partial: Partial<Step> & { type: StepType }): Step {
  return { id: "s1", timestamp: 0, ...partial } as Step;
}

function run(s: Step): ReplayResult {
  return eval(buildReplayScript(s)) as ReplayResult;
}

/** Every log line joined, for asserting on the reason rather than just the
 *  verdict — a step that fails for the wrong reason sends the user to fix the
 *  wrong thing, which is barely better than not failing at all. */
function why(r: ReplayResult): string {
  return r.logs.map((l) => l.m).join(" | ") + " | " + (r.error ?? "");
}

beforeEach(() => {
  document.body.innerHTML = "";
  // jsdom has no layout engine — see the note in step-replayer.dom.test.ts.
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

describe("strict mode: the failure the trainer could not show", () => {
  it("refuses an ambiguous locator instead of silently taking the first match", () => {
    // Playwright throws `strict mode violation: … resolved to 2 elements`. The
    // replayer took `a[0]`, so the single most common real-world failure was
    // structurally invisible in the trainer — discoverable only on a run,
    // against a page the user was no longer looking at.
    document.body.innerHTML = '<button>Save</button><button>Save</button>';
    const r = run(step({ type: "click", locator: { k: "text", v: "Save" } }));
    expect(r.ok).toBe(false);
    expect(why(r)).toMatch(/strict mode/i);
    expect(why(r)).toMatch(/2 elements/);
  });

  it("says how to fix it, because 'not found' and 'found too many' need opposite fixes", () => {
    document.body.innerHTML = '<button>Save</button><button>Save</button>';
    const r = run(step({ type: "click", locator: { k: "text", v: "Save" } }));
    expect(why(r)).toMatch(/refine|index/i);
    // Must NOT report the opposite diagnosis.
    expect(r.error ?? "").not.toMatch(/not found/i);
  });

  it("an ambiguous locator fails an ASSERTION too, before the predicate runs", () => {
    document.body.innerHTML = '<p>Total</p><p>Total</p>';
    const r = run(step({ type: "assert", assert: "visible", locator: { k: "text", v: "Total" } }));
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/strict mode/i);
  });

  it("does not poll a conditional wait to its timeout on an ambiguous locator", () => {
    // Waiting cannot make a strict-mode violation untrue, and reporting it as a
    // timeout reads as "the page was slow" — sending the user to fix a
    // performance problem they do not have.
    document.body.innerHTML = '<span>Ready</span><span>Ready</span>';
    const r = run(step({ type: "wait", waitUntil: "visible", locator: { k: "text", v: "Ready" }, timeoutMs: 30000 }));
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/strict mode/i);
    expect(r.error ?? "").not.toMatch(/timed out/i);
  });

  it("an explicit .nth() is NOT a violation — it is the fix for one", () => {
    document.body.innerHTML = '<button>Save</button><button id="second">Save</button>';
    const r = run(step({ type: "click", locator: { k: "text", v: "Save", nth: 1 } }));
    expect(r.ok).toBe(true);
  });
});

describe("nth: the trainer acted on a different element than the spec", () => {
  it("previews the indexed element, not the first one", () => {
    // `nth` was never read by the replayer. A step recorded as "the 2nd Save"
    // was previewed against the 1st, so a green tick in the trainer was about
    // an element the generated `.nth(1)` does not address.
    document.body.innerHTML = '<button id="a">Save</button><button id="b">Save</button>';
    let clicked = "";
    document.getElementById("a")!.addEventListener("click", () => { clicked = "a"; });
    document.getElementById("b")!.addEventListener("click", () => { clicked = "b"; });
    run(step({ type: "click", locator: { k: "text", v: "Save", nth: 1 } }));
    expect(clicked).toBe("b");
  });

  it("reports an out-of-range index rather than falling back to the first", () => {
    document.body.innerHTML = '<button>Save</button>';
    const r = run(step({ type: "click", locator: { k: "text", v: "Save", nth: 5 } }));
    expect(r.ok).toBe(false);
    expect(why(r)).toMatch(/out of range/i);
  });

  it("previews nth(-1) against the LAST match, same as the emitted .nth(-1)", () => {
    // "Last" is the stable ordinal for a set whose size changes between runs,
    // and the trainer previewing it against anything but the tail would be
    // the same trainer-vs-run divergence the describe above records for
    // positive indexes.
    document.body.innerHTML =
      '<button id="a">Save</button><button id="b">Save</button><button id="c">Save</button>';
    let clicked = "";
    for (const id of ["a", "b", "c"]) {
      document.getElementById(id)!.addEventListener("click", () => {
        clicked = id;
      });
    }
    const r = run(step({ type: "click", locator: { k: "text", v: "Save", nth: -1 } }));
    expect(r.ok).toBe(true);
    expect(clicked).toBe("c");
  });
});

describe("URL and title: the assertions that could not pass", () => {
  it("'URL contains' matches a substring of the live URL", () => {
    const r = run(step({ type: "assert", assert: "url", value: "localhost" }));
    expect(r.ok).toBe(true);
  });

  it("'URL contains' rejects a URL that does not contain the value", () => {
    const r = run(step({ type: "assert", assert: "url", value: "/checkout/step/9" }));
    expect(r.ok).toBe(false);
  });

  it("'Page title is' is EXACT — it no longer passes on a substring", () => {
    // The headline replayer lie: this read a case-insensitive substring while
    // the spec emitted an exact match, so "Cart" was green here against a page
    // titled "Cart | Acme" and red in every run.
    document.title = "Cart | Acme";
    const r = run(step({ type: "assert", assert: "title", value: "Cart" }));
    expect(r.ok).toBe(false);
  });

  it("'Page title contains' is the kind that accepts a substring", () => {
    document.title = "Cart | Acme";
    expect(run(step({ type: "assert", assert: "titleContains", value: "Cart" })).ok).toBe(true);
  });

  it("title matching is case-sensitive", () => {
    document.title = "Cart | Acme";
    expect(run(step({ type: "assert", assert: "titleContains", value: "cart" })).ok).toBe(false);
  });

  it("'URL path is' passes under the query noise that fails the whole-URL kinds", () => {
    // The shape both of this app's real recorded URL assertions died on: the
    // value is a path, the live URL carries a query string. `urlPathIs` is the
    // kind that makes that combination pass; `urlEndsWith` correctly still
    // fails it, because its label promises the literal end of the URL.
    window.history.pushState({}, "", "/cart/?step=2#top");
    try {
      expect(run(step({ type: "assert", assert: "urlPathIs", value: "/cart" })).ok).toBe(true);
      expect(run(step({ type: "assert", assert: "urlPathIs", value: "/checkout" })).ok).toBe(false);
      expect(run(step({ type: "assert", assert: "urlEndsWith", value: "/cart" })).ok).toBe(false);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("a page-level assert with an empty value fails, because nothing will be generated for it", () => {
    // The generator refuses these (an empty "contains" matches every page), so
    // a green preview would stand in for a spec line that will never exist.
    // matchesValue would answer true for an empty substring — three tests in
    // the store carried exactly such steps, visible and asserting nothing.
    for (const assert of ["url", "urlEndsWith", "urlIs", "urlPathIs", "title", "titleContains"] as const) {
      const r = run(step({ type: "assert", assert }));
      expect(r.ok, `${assert} with no value must not pass the preview`).toBe(false);
      expect(why(r)).toMatch(/no expected value/i);
    }
  });
});

describe("text: case sensitivity now matches toContainText", () => {
  it("rejects a case difference, as the generated spec does", () => {
    document.body.innerHTML = '<p data-testid="t">Checkout</p>';
    const r = run(step({ type: "assert", assert: "text", text: "checkout", locator: { k: "testid", v: "t" } }));
    expect(r.ok).toBe(false);
  });

  it("still accepts an exact-case substring", () => {
    document.body.innerHTML = '<p data-testid="t">Proceed to Checkout now</p>';
    expect(run(step({ type: "assert", assert: "text", text: "Checkout", locator: { k: "testid", v: "t" } })).ok).toBe(true);
  });
});

describe("visibility: Playwright's rule, not an approximation of it", () => {
  it("a zero-WIDTH element is hidden (the old rule required both to be zero)", () => {
    document.body.innerHTML = '<div data-testid="z">x</div>';
    Element.prototype.getBoundingClientRect = function (): DOMRect {
      return { width: 0, height: 20, top: 0, left: 0, right: 0, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    const r = run(step({ type: "assert", assert: "visible", locator: { k: "testid", v: "z" } }));
    expect(r.ok).toBe(false);
  });

  it("opacity:0 is VISIBLE — Playwright does not consult opacity", () => {
    // The reverse mismatch, and the one that trains users to ignore red steps:
    // a faded-in element failed here and passed in the run.
    document.body.innerHTML = '<div data-testid="o" style="opacity:0">x</div>';
    const r = run(step({ type: "assert", assert: "visible", locator: { k: "testid", v: "o" } }));
    expect(r.ok).toBe(true);
  });

  it("display:none is still hidden", () => {
    document.body.innerHTML = '<div data-testid="d" style="display:none">x</div>';
    expect(run(step({ type: "assert", assert: "visible", locator: { k: "testid", v: "d" } })).ok).toBe(false);
  });
});

describe("custom widgets: aria state is authoritative", () => {
  it("aria-disabled makes an element disabled", () => {
    // `el.disabled` is `undefined` on a div-with-a-role, so every custom widget
    // answered "enabled" regardless of its actual state.
    document.body.innerHTML = '<div data-testid="b" role="button" aria-disabled="true">Go</div>';
    expect(run(step({ type: "assert", assert: "disabled", locator: { k: "testid", v: "b" } })).ok).toBe(true);
    expect(run(step({ type: "assert", assert: "enabled", locator: { k: "testid", v: "b" } })).ok).toBe(false);
  });

  it("aria-checked makes a role=checkbox checked", () => {
    document.body.innerHTML = '<div data-testid="c" role="checkbox" aria-checked="true"></div>';
    expect(run(step({ type: "assert", assert: "checked", locator: { k: "testid", v: "c" } })).ok).toBe(true);
  });

  it("a native input still reads its own property", () => {
    document.body.innerHTML = '<input data-testid="n" type="checkbox" checked />';
    expect(run(step({ type: "assert", assert: "checked", locator: { k: "testid", v: "n" } })).ok).toBe(true);
  });
});

describe("the silent successes", () => {
  it("selecting an option that does not exist FAILS", () => {
    // `el.value = "gone"` sets selectedIndex to -1 and throws nothing, so the
    // step reported success while selecting nothing. `selectOption` throws.
    document.body.innerHTML = '<select data-testid="s"><option value="a">A</option></select>';
    const r = run(step({ type: "select", value: "gone", locator: { k: "testid", v: "s" } }));
    expect(r.ok).toBe(false);
    expect(why(r)).toMatch(/no option/i);
  });

  it("names the options it does have, so the fix is visible from the log", () => {
    document.body.innerHTML = '<select data-testid="s"><option value="a">A</option><option value="b">B</option></select>';
    expect(why(run(step({ type: "select", value: "gone", locator: { k: "testid", v: "s" } })))).toContain("a, b");
  });

  it("selecting an option that exists still works", () => {
    document.body.innerHTML = '<select data-testid="s"><option value="a">A</option><option value="b">B</option></select>';
    expect(run(step({ type: "select", value: "b", locator: { k: "testid", v: "s" } })).ok).toBe(true);
  });

  it("a MISSING attribute is not an attribute equal to empty string", () => {
    // `toHaveAttribute(name, "")` fails on a missing attribute; the replayer
    // coerced null to "" and passed.
    document.body.innerHTML = '<div data-testid="a">x</div>';
    const r = run(step({ type: "assert", assert: "attribute", attr: "data-state", value: "", locator: { k: "testid", v: "a" } }));
    expect(r.ok).toBe(false);
    expect(why(r)).toMatch(/not present/i);
  });

  it("an attribute that IS present and empty passes", () => {
    document.body.innerHTML = '<div data-testid="a" data-state="">x</div>';
    expect(run(step({ type: "assert", assert: "attribute", attr: "data-state", value: "", locator: { k: "testid", v: "a" } })).ok).toBe(true);
  });
});

describe("locator resolution now uses the capture script's engine", () => {
  it("getByLabel matches a substring, as Playwright does", () => {
    // The replayer required an EXACT label match, so it was stricter than the
    // run — which meant it never surfaced the ambiguity that trips strict mode.
    document.body.innerHTML = '<label for="e">Email address</label><input id="e" data-testid="e" />';
    expect(run(step({ type: "fill", value: "x", locator: { k: "label", v: "Email" } })).ok).toBe(true);
  });

  it("getByText resolves the DEEPEST match, not the shortest string", () => {
    // The old resolver sorted by text length with no containment filter, so a
    // `count` assertion counted every ancestor too.
    document.body.innerHTML = '<div id="outer"><span id="inner">Total</span></div>';
    const r = run(step({ type: "assert", assert: "count", count: 1, locator: { k: "text", v: "Total" } }));
    expect(r.ok).toBe(true);
  });
});

describe("occlusion: the click a real run refuses", () => {
  // jsdom has no hit-testing, so `elementFromPoint` is stubbed to model the one
  // thing that matters: what is drawn on top at the click point. The check
  // itself — subtree containment, viewport bounds, the graceful "cannot tell"
  // path — is the real code.
  function stubTopmost(el: Element | null): void {
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => el;
  }

  it("refuses a click on an element covered by something else", () => {
    // The everyday version: a cookie banner over the button. A human recording
    // dismisses one by reflex and never notices it was in the way, so the step
    // passes in the trainer and fails at 3am with "element intercepts pointer
    // events".
    document.body.innerHTML = '<button data-testid="b">Buy</button><div id="banner" class="cookie-bar">Accept cookies</div>';
    stubTopmost(document.getElementById("banner"));
    const r = run(step({ type: "click", locator: { k: "testid", v: "b" } }));
    expect(r.ok).toBe(false);
    expect(why(r)).toMatch(/intercepts pointer events/i);
  });

  it("names the covering element, not just the failure", () => {
    document.body.innerHTML = '<button data-testid="b">Buy</button><div id="banner" class="cookie-bar">Accept cookies</div>';
    stubTopmost(document.getElementById("banner"));
    const r = run(step({ type: "click", locator: { k: "testid", v: "b" } }));
    expect(r.error ?? "").toContain("#banner");
    expect(r.error ?? "").toContain("Accept cookies");
  });

  it("a descendant receiving the click is NOT occlusion", () => {
    // A <span> inside a <button> is the normal case and the event still
    // reaches the button. Treating it as interception would fail almost every
    // real click.
    document.body.innerHTML = '<button data-testid="b"><span id="inner">Buy</span></button>';
    stubTopmost(document.getElementById("inner"));
    expect(run(step({ type: "click", locator: { k: "testid", v: "b" } })).ok).toBe(true);
  });

  it("cannot-tell degrades to allowing the click, never to inventing a failure", () => {
    document.body.innerHTML = '<button data-testid="b">Buy</button>';
    stubTopmost(null);
    expect(run(step({ type: "click", locator: { k: "testid", v: "b" } })).ok).toBe(true);
  });
});

describe("the scan cap belongs to capture, not to preview", () => {
  it("resolves a locator past the capture-path element cap", () => {
    // MAX_UNIQUENESS_SCAN (6000) exists because CAPTURE runs the uniqueness
    // scan on the click path. The replayer does not — it is a preview the user
    // asked for and is waiting on. Sharing the engine silently imported the cap
    // with it, so on a page bigger than that the trainer reported "element not
    // found" for an element a real run resolves perfectly well: the same
    // trainer-lies-about-the-run failure, reintroduced through code reuse.
    const filler: string[] = [];
    for (let i = 0; i < 6500; i++) filler.push("<i>x</i>");
    document.body.innerHTML = `<div>${filler.join("")}<button id="target">Checkout</button></div>`;
    let clicked = false;
    document.getElementById("target")!.addEventListener("click", () => { clicked = true; });
    const r = run(step({ type: "click", locator: { k: "text", v: "Checkout" } }));
    expect(r.ok, why(r)).toBe(true);
    expect(clicked).toBe(true);
  });

  it("counts every match on a large page, rather than the first 6000", () => {
    const parts: string[] = [];
    for (let i = 0; i < 7000; i++) parts.push("<span>Row</span>");
    document.body.innerHTML = parts.join("");
    const r = run(step({ type: "assert", assert: "count", count: 7000, locator: { k: "css", v: "span" } }));
    expect(r.ok, why(r)).toBe(true);
  });
});

describe("loop halves in the preview", () => {
  it("treats both halves as narrated no-ops — the body previews once", () => {
    // The preview walks the list linearly; repetition is the RUN's behaviour.
    // What matters here is honesty (the log says so) and that neither half
    // fails, which would block replay-from-step across any loop.
    const open = run(step({ type: "loop", loopCount: 4 }));
    expect(open.ok).toBe(true);
    const close = run(step({ type: "endLoop" }));
    expect(close.ok).toBe(true);
  });

  it("treats an else marker the same way", () => {
    // In a live session the recorder JUMPS over whichever half is inactive;
    // the linear preview instead narrates the marker and walks on. A failure
    // here would block replay-from-step across any elsed conditional.
    const r = run(step({ type: "else" }));
    expect(r.ok).toBe(true);
  });
});

describe("a11y gates in the preview", () => {
  it("is a narrated no-op that never claims the check ran", () => {
    // The preview carries no axe. Same honesty rule as download: a green row
    // must not read as "accessibility was checked".
    const r = run(step({ type: "a11y", a11yImpact: "serious" }));
    expect(r.ok).toBe(true);
    expect(why(r)).toMatch(/run/i);
  });
});

describe("upload steps in the preview", () => {
  it("is a narrated no-op — the run performs the upload", () => {
    const r = run(step({ type: "upload", locator: { k: "testid", v: "f" }, value: "uploads/t/a.csv" }));
    expect(r.ok).toBe(true);
    expect(why(r)).toMatch(/run/i);
  });
});

describe("api steps in the preview", () => {
  it("is a narrated no-op — requests are sent on runs only", () => {
    const r = run(step({ type: "api", url: "https://x.test/health" }));
    expect(r.ok).toBe(true);
    expect(why(r)).toMatch(/run/i);
  });
});

describe("ai checks in the preview", () => {
  it("is a narrated no-op — the model judges after runs, never here", () => {
    const r = run(step({ type: "aiCheck", text: "badge shows 3" }));
    expect(r.ok).toBe(true);
    expect(why(r)).toMatch(/run/i);
  });
});

describe("download steps in the preview", () => {
  it("is a narrated no-op that never claims verification", () => {
    // The training browser cancels transfers, so no download event can reach
    // the preview. The log must say verification happens on runs — a green
    // row read as "the download was checked" would be the replayer lying in
    // the optimistic direction, the kind this file exists to prevent.
    const r = run(step({ type: "download", value: "report.csv" }));
    expect(r.ok).toBe(true);
    expect(why(r)).toMatch(/verified on runs/i);
  });
});

describe("force clicks in the preview", () => {
  it("ignores the cover when the step opted out of the check, and says so", () => {
    // The run skips actionability for a force click, so failing here would be
    // the pessimistic lie — this step turned the check off on purpose.
    document.body.innerHTML =
      '<button data-testid="b">Buy</button><div id="banner" class="cookie-bar">Accept</div>';
    (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
      .elementFromPoint = () => document.getElementById("banner");
    const r = run(step({ type: "click", locator: { k: "testid", v: "b" }, force: true }));
    expect(r.ok).toBe(true);
    expect(why(r)).toMatch(/ignored.*force/i);
  });
});

describe("count capture in the preview", () => {
  it("counts without strict-resolving — ambiguous and absent are answers", () => {
    document.body.innerHTML = "<li>a</li><li>b</li><li>c</li>";
    const many = run(
      step({ type: "capture", captureVar: "n", captureFrom: "count", locator: { k: "css", v: "li" } }),
    );
    expect(many.ok).toBe(true);
    expect((many as { captured?: string }).captured).toBe("3");
    const none = run(
      step({ type: "capture", captureVar: "n", captureFrom: "count", locator: { k: "css", v: ".gone" } }),
    );
    expect(none.ok).toBe(true);
    expect((none as { captured?: string }).captured).toBe("0");
  });
});
