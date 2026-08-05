// When to show the trainer window, and when to call it a failure.
//
// Four independent signals can justify showing it, and they arrive in an order
// that depends on how fast the page loads:
//
//   ready-to-show   the WebView's own signal; absent or late on a cold start
//   dom-ready       the SDK's readiness signal; lags did-finish-load by ~100ms
//   load-finished   did-finish-load / did-fail-load
//   fallback        a creation-relative timer, so a lagging WebView can't leave
//                   the window hidden behind a "Recording" banner
//
// Extracted into its own module because the bug it now guards was entirely
// about ORDER, and order is the one thing that can't be checked by reading the
// function: `load-finished` didn't show the window, so a page that loaded
// faster than the fallback timer reached the failure check with nothing having
// shown it, and a working window was closed as "failed to open". Sites that
// loaded slowly hit the fallback first and looked fine, which is why it
// survived — it needed a FAST page to reproduce.
//
// Pure, with the show side effect injected, so every arrival order can be
// exercised without a window.

/** A signal that the trainer window is worth showing. */
export type ShowSignal = "ready-to-show" | "dom-ready" | "load-finished" | "fallback";

export const SHOW_SIGNALS: ShowSignal[] = [
  "ready-to-show",
  "dom-ready",
  "load-finished",
  "fallback",
];

export interface TrainerWindowGate {
  /** Record a signal. The first one shows the window; later ones are no-ops. */
  signal(which: ShowSignal): void;
  /** Whether the window has been shown. */
  readonly shown: boolean;
  /** Which signal actually did it, for diagnosis. */
  readonly shownBy: ShowSignal | null;
  /**
   * Whether opening genuinely failed, once the load has settled.
   *
   * "Never shown" is only a failure if nothing ever signalled — and since
   * `load-finished` is one of the signals, a completed load can no longer be
   * mistaken for one.
   */
  failed(destroyed: boolean): boolean;
}

/**
 * @param show called at most once, on the first signal
 * @param canShow guards against a window torn down before any signal arrived
 */
export function createTrainerWindowGate(
  show: () => void,
  canShow: () => boolean = () => true,
): TrainerWindowGate {
  let shown = false;
  let shownBy: ShowSignal | null = null;
  return {
    signal(which: ShowSignal): void {
      if (shown) return;
      if (!canShow()) return;
      shown = true;
      shownBy = which;
      show();
    },
    get shown(): boolean {
      return shown;
    },
    get shownBy(): ShowSignal | null {
      return shownBy;
    },
    failed(destroyed: boolean): boolean {
      return !shown || destroyed;
    },
  };
}
