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

/** One toast as the user would read it. */
export interface ToastText {
  /** "success" | "error" | "info" | … — the design system's own type. */
  type: string;
  title: string;
  description?: string;
}

/**
 * The recorded toasts as type + text.
 *
 * `toastCalls` alone is not enough for anything raised through
 * `@glaze/core/components`' `toast`. That helper does NOT call sonner's
 * `success`/`error`; it calls `toast.custom(render)` with a render function
 * closing over the type and title — so every SDK toast lands here as
 * `{kind: "custom", message: <function>}` and asserting on the message finds a
 * closure, not the sentence on screen. Calling the render function is the only
 * route back to what was shown, and doing it in one place keeps every test from
 * reaching into the SDK's element shape for itself.
 *
 * Toasts raised by calling sonner directly still work: they carry their message
 * as-is and are reported under their own kind.
 */
export function toastTexts(): ToastText[] {
  return toastCalls.map((call) => {
    if (typeof call.message !== "function") {
      return { type: call.kind, title: String(call.message ?? "") };
    }
    const rendered = (call.message as (id: string) => unknown)("test-toast");
    const props = (rendered as { props?: Record<string, unknown> } | null)?.props;
    if (!props) return { type: call.kind, title: "" };
    return {
      type: String(props.type ?? call.kind),
      title: String(props.title ?? ""),
      description: props.description === undefined ? undefined : String(props.description),
    };
  });
}

export function Toaster(): React.ReactElement | null {
  return null;
}
