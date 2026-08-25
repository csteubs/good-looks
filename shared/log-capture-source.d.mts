/** What a redacted value is replaced with. */
export declare const ELIDED: string;

/** Request/response headers a run may record. An allowlist rather than a
 *  denylist: a header nobody thought about is not recorded. */
export declare const HEADER_ALLOWLIST: readonly string[];

/** Headers never recorded whatever else says — the signature headers, whose
 *  values are credentials. */
export declare const HEADER_NEVER_RECORD: readonly string[];

/** Query parameters redacted out of a recorded URL. */
export declare const SENSITIVE_QUERY_PARAMS: readonly string[];

export declare const MAX_CONSOLE_HEAD: number;
export declare const MAX_CONSOLE_TAIL: number;
export declare const MAX_NETWORK_HEAD: number;
export declare const MAX_NETWORK_TAIL: number;
export declare const MAX_TEXT_CHARS: number;

/** The console/network capture helpers, for interpolation into the capture
 *  fixture. */
export declare const LOG_CAPTURE_HELPERS: string;
