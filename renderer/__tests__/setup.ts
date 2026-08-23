// jsdom setup for component tests.
//
// Components reach the backend through `window.glazeAPI`, which is injected by
// the preload script in the real app and simply does not exist here. Without a
// stand-in, every component that talks to the backend throws on mount rather
// than failing an assertion, so this installs a default no-op bridge that
// individual tests override with vi.mock or by reassigning entries.
//
// Anything a test does NOT stub returns a rejected-safe empty value rather than
// undefined, so a component awaiting an unstubbed call renders its empty state
// instead of crashing on `undefined.map`.

import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// React Testing Library doesn't auto-clean outside its own globals setup.
afterEach(() => {
  cleanup();
});

/** Minimal stand-in for the preload bridge. */
function makeGlazeApi() {
  return {
    glaze: {
      ipc: {
        // Default: every channel resolves to null. Tests that care stub the
        // specific `api.*` module function instead of poking channels.
        invoke: vi.fn(async () => null),
        on: vi.fn(() => () => {}),
        once: vi.fn(() => () => {}),
        send: vi.fn(),
        disconnect: vi.fn(),
      },
    },
    clipboard: { writeText: vi.fn() },
    shell: { showItemInFolder: vi.fn() },
    Menu: { popup: vi.fn(async () => ({})) },
  };
}

(globalThis as unknown as { glazeAPI: ReturnType<typeof makeGlazeApi> }).glazeAPI = makeGlazeApi();

// jsdom implements neither of these, and Radix-based components use both.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// Used by the SDK's Dialog (and anything with scroll-aware chrome). jsdom
// implements neither observer API, and the failure surfaces as a bare
// "IntersectionObserver is not defined" from inside the design-system bundle,
// which reads like a component bug rather than a missing browser API.
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

// jsdom implements no scrolling. The SDK's ScrollArea calls scrollTo when
// auto-scrolling to the newest output, and several views call scrollIntoView to
// reveal a selected step — both throw "not a function" from inside the bundle,
// which reads like a component bug rather than a missing DOM API.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function (): void {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function (): void {};
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// CodeMirror measures text with DOM Ranges, which jsdom creates but cannot
// measure: `Range.getClientRects` is simply absent, and the first lint or
// selection draw throws `textRange(...).getClientRects is not a function`
// from inside a dispatch — which reads as a diagnostics bug rather than a
// missing API. Empty geometry is the honest answer a layout-less DOM can
// give; the editor's own tests assert on state and on the DOM it builds,
// never on a pixel.
if (typeof Range !== "undefined") {
  const emptyRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
  const emptyRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = emptyRects;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = emptyRect;
}
