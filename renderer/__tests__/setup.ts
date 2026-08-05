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

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
