export declare const SIGNATURE_COUNT_ENV: string;
export declare const SIGNATURE_FIXTURE_FILE: string;

/** The env names carrying one signature — one variable per field rather than a
 *  JSON blob, which would show up whole in a crash dump or process listing. */
export declare function signatureEnvNames(index: number): {
  host: string;
  input: string;
  value: string;
  agent: string;
};

export declare const signatureFixtureSource: string;
