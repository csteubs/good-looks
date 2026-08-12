export declare const DEEP_LINK_SCHEME: string;

export interface DeepLinkTarget {
  testId: string;
  runId: string | null;
  stepId: string | null;
}

/** Parse a `goodlooks://` URL into the view it selects. Null for anything not
 *  understood — there is deliberately no default route. */
export declare function parseDeepLink(url: string | undefined | null): DeepLinkTarget | null;

/** Build the link that goes into an issue. Paired with `parseDeepLink` here so
 *  the two cannot drift into producing links that open nothing. */
export declare function buildDeepLink(target: {
  testId: string;
  runId?: string | null;
  stepId?: string | null;
}): string;
