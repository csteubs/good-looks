// Hand-written types for dev-app-bundle.mjs.
//
// The module is plain `.mjs` because `npm run dev` runs it directly, with no
// build step — same reason as shared/*.mjs. `check:app-identity` is TypeScript
// and imports it, so this declaration is what keeps `npm run type-check` a real
// gate over that call site.

/** The name macOS shows in the menu bar and the Dock (matches productName). */
export declare const DEV_APP_NAME: string;

export declare function computeStamp(input: {
  electronVersion: string;
  iconSize: number;
  iconMtimeMs: number;
  appName: string;
}): string;

export declare function needsRebuild(input: {
  executableExists: boolean;
  previousStamp: string | null;
  currentStamp: string;
}): boolean;

/**
 * Build (or reuse) the branded dev bundle; returns the path to its executable,
 * or null when one cannot be built — callers must fall back to plain Electron.
 */
export declare function ensureDevAppExecutable(options?: {
  repoRoot?: string;
  force?: boolean;
  log?: (message: string) => void;
}): string | null;
