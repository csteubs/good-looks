export declare const USER_CSS_ENV: string;
export declare const USER_INIT_ENV: string;
export declare const USER_PAGE_FIXTURE_FILE: string;

/** The environment a run needs for the user's stylesheet/init script, or an
 *  empty object when neither is configured. */
export declare function userPageEnv(settings: {
  userStylesheet?: string;
  userInitScript?: string;
}): Record<string, string>;

export declare const userPageFixtureSource: string;
