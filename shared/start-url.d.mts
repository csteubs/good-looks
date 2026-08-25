/** True when the input already names a scheme this app can open (`http://` or
 *  `https://`, case-insensitively). */
export declare function hasScheme(input: string): boolean;

/** The address a typed site resolves to: the input as typed when it already
 *  names a scheme, `https://` + input when it does not. For a RECORDING'S START
 *  URL only — a `goto` step's URL may legitimately be `baseUrl`-relative and is
 *  never normalized. */
export declare function normalizeStartUrl(input: string): string;
