// Types for frame-ref.mjs.
//
// Hand-written, like the other .d.mts files here: the implementation is plain
// ESM so both the compiled app and the plain-.mjs MCP can import it, and this
// file is what keeps `npm run type-check` a real gate over the TypeScript
// callers (the generator, the parser, and the renderer's locator renderings).

export type FrameRefKind = "name" | "url" | "testid" | "css";

/** How to find ONE iframe element from its parent document. Same vocabulary as
 *  a normal locator rather than a URL or an index — a frame found by name or
 *  testid survives a page that reorders its frames. */
export interface FrameRef {
  k: FrameRefKind;
  v: string;
}

export declare const FRAME_REF_KINDS: readonly FrameRefKind[];

export declare function isFrameRefKind(v: unknown): v is FrameRefKind;

/** The CSS selector one FrameRef resolves to, for `frameLocator(<here>)`. */
export declare function frameSelector(ref: { k?: string; v?: string }): string;

/** The inverse: read one `frameLocator("…")` selector back into a FrameRef, or
 *  null for an empty selector. */
export declare function parseFrameSelector(selector: string): FrameRef | null;
