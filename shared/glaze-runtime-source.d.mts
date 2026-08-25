export declare const GLAZE_RUNTIME_FILE: string;

/** The helper runtime a generated spec imports. Loaded through Playwright's own
 *  Babel transform, which nothing else in this repo runs — `check:runtime-boot`
 *  exists because syntax it mishandles is legal under Node's loader, and that
 *  gap once hid a runtime that failed to load for every helper-using test. */
export declare const glazeRuntimeSource: string;
