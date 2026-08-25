/** Locator methods a recorded step can call. The capture fixture screenshots
 *  after each of these, and the settle fixture waits after each. */
export declare const LOCATOR_ACTIONS: readonly string[];

/** Page methods that mutate the page, same contract. */
export declare const PAGE_ACTIONS: readonly string[];

/** The list as a JS array literal, for interpolation into an emitted fixture. */
export declare function actionsLiteral(actions: readonly string[]): string;
