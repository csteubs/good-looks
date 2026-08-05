// Test stand-in for `sonner`, the toast library the Glaze design system bundle
// imports internally.
//
// Aliased in vitest.config.ts rather than installed, for two reasons:
//   • sonner is a dependency of the SDK, not of this app — in the real runtime
//     the SDK resolves it from its own install context, so adding it to this
//     project's package.json would be inventing a dependency the app doesn't
//     have;
//   • a stub makes toasts ASSERTABLE. "did this failure surface to the user?"
//     is a thing tests want to check, and with the real library it's buried in
//     portal DOM.
//
// `toastCalls` records every call so a test can assert on it; clear it in a
// beforeEach when order matters.

import * as React from "react";

export interface ToastCall {
  kind: "success" | "error" | "info" | "warning" | "message" | "loading" | "dismiss" | "custom";
  message: unknown;
}

export const toastCalls: ToastCall[] = [];

/** Reset between tests. */
export function clearToastCalls(): void {
  toastCalls.length = 0;
}

function record(kind: ToastCall["kind"]) {
  return (message?: unknown) => {
    toastCalls.push({ kind, message });
    return `toast-${toastCalls.length}`;
  };
}

const base = record("message") as ((message?: unknown) => string) & Record<string, unknown>;
base.success = record("success");
base.error = record("error");
base.info = record("info");
base.warning = record("warning");
base.loading = record("loading");
base.dismiss = record("dismiss");
base.custom = record("custom");
base.promise = (p: unknown) => p;

export const toast = base;

export function Toaster(): React.ReactElement | null {
  return null;
}
