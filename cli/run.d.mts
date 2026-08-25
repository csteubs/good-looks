import type { InstallOptions, RunOptions } from "./args.d.mts";
import type { RunRefusal } from "./exit.d.mts";

/** The sentence for a refusal, rendered from the REASON rather than passed
 *  through — which is what lets the MCP word the same four facts for an agent
 *  and this word them for someone reading a CI log. */
export declare function refusalMessage(outcome: RunRefusal): string;

export interface RunCommandIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Run the selection and report it. Returns the exit code rather than calling
 *  `process.exit`, so nothing here can end the process mid-report. */
export declare function runCommand(options: RunOptions, io?: RunCommandIo): Promise<number>;

/** Install one engine into the library's own browsers directory (R11), and
 *  verify afterwards that this app's own detection sees it — `playwright
 *  install` can exit 0 having unpacked a revision the runner will not launch. */
export declare function installCommand(
  options: InstallOptions,
  io?: RunCommandIo,
): Promise<number>;
