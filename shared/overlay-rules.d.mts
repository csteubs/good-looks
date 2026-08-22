// Types for overlay-rules.mjs. See run-pacing.d.mts for why these are
// hand-written.

/** The locator shape a rule targets. Structurally the app's `Locator`, narrowed
 *  to the kinds a rule may use — kept loose here because `shared/` may not
 *  import from `main/`, and pinned on the app side by `normalizeOverlayRule`. */
export interface OverlayTarget {
  k: string;
  v?: string;
  role?: string;
  name?: string;
  attr?: string;
  nth?: number;
  ctx?: unknown;
}

/** A standing dismissal rule: "on this host, whenever this control is on
 *  screen, click it". Never a step, never a line of generated source. */
export interface OverlayRuleLike {
  id: string;
  host: string;
  label: string;
  target: OverlayTarget;
  /** Hidden from enforcement without losing the definition. */
  disabled?: boolean;
}

export declare const OVERLAY_LOCATOR_KINDS: readonly string[];
export declare const MAX_OVERLAY_LABEL: number;
export declare const MAX_RULES_PER_HOST: number;
export declare const WATCH_FALLBACK_MS: number;
export declare const WATCH_POLL_MS: number;

export declare function hostOf(url: string | null | undefined): string;

export declare function hostMatches(
  ruleHost: string | null | undefined,
  url: string | null | undefined,
): boolean;

export declare function armedRulesFor<T extends OverlayRuleLike>(
  rules: readonly T[] | null | undefined,
  url: string | null | undefined,
): T[];

export declare function overlayVisible(el: unknown): boolean;

/** `overlayVisible` as source, for embedding into an injected script. */
export declare function overlayVisibleSource(): string;

/** The watcher as source. NOT self-contained: the scope it is interpolated
 *  into must already define `matchesFor` and `overlayVisible`. */
export declare function watcherSource(): string;
