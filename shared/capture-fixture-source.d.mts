/** The artifact-capture fixture: an extended `test` whose `page` fixture
 *  screenshots after every page-mutating action, and which carries the console/
 *  network capture, settling, signature, overlay-dismissal and user-page
 *  fixtures behind their own env gates. Plain JavaScript, because Playwright
 *  loads it through its own Babel transform, which does not understand
 *  `import type`. */
export declare const captureFixtureSource: string;
