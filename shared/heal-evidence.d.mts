// Types for heal-evidence.mjs.
//
// Hand-written like every shared/ module. `main/recorder/types.ts` re-exports
// both functions, so these declarations are what keep `npm run type-check` a
// real gate over every TypeScript caller of them.

/** Longest page URL a heal record may carry. Over-long is rejected, never
 *  truncated. */
export declare const MAX_HEAL_PAGE_URL: number;

/** Narrow a heal event's page URL into something a journal may store: http(s)
 *  only, no control characters, capped, and sensitive query VALUES elided by
 *  name. Null on any doubt — the caller drops the field, never the entry. */
export declare function normalizeHealPageUrl(input: unknown): string | null;

/** Narrow a heal event's element box: four finite numbers on the normalized
 *  0-1 viewport scale, rebuilt from named keys, positive width and height.
 *  Null on any doubt — a doubtful rect drops the box rather than drawing a
 *  wrong one. */
export declare function normalizeHealRect(
  input: unknown,
): { x: number; y: number; w: number; h: number } | null;
