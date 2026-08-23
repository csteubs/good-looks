export type InstallableBrowser = "chromium" | "firefox" | "webkit";
/** The directory names the CLI unpacks an engine into (two for chromium: the
 *  browser and the headless shell), or null when `browsers.json` cannot be
 *  read or does not name the engine. */
export function expectedBrowserDirs(browsersJson: string, browser: InstallableBrowser): string[] | null;
/** Whether every expected directory is present; with no expectation, the old
 *  engine-prefix rule. */
export function browserInstalledIn(entries: string[], browser: InstallableBrowser, expected: string[] | null): boolean;
