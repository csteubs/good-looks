// The preload's contextBridge surface, declared as a global so renderer code
// can read `window.glazeAPI` without casting at every call site.
//
// The name is historical (it predates the Electron port) and is kept because
// every view, the injected page-world helpers and the test stubs address it.

import type { GlazeAPI } from "./preload";

declare global {
  interface Window {
    /** Always present at runtime — the preload runs before any renderer code.
     *  Declared non-optional so views can call through it directly, as they
     *  did against the SDK's global. Component tests install a stub in
     *  renderer/__tests__/setup.ts. */
    glazeAPI: GlazeAPI;
  }
}

export {};
