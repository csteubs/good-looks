// Types for branch-paths.mjs. See run-pacing.d.mts for why these are hand-written.

export interface RepoRef {
  owner: string;
  name: string;
}

export declare const MAX_BRANCH_LENGTH: number;
export declare const BRANCH_ARG_PREFIX: string;
export declare const NO_DEV_URL_ARG: string;

/** Why a branch name is unacceptable, or null when it's fine. */
export declare function branchNameProblem(name: string): string | null;
export declare function isValidBranchName(name: string): boolean;
export declare function branchSlug(name: string): string;
export declare function isInside(parent: string, child: string): boolean;
/** Throws when the name is unacceptable or the result escapes `root`. */
export declare function worktreeDirFor(root: string, branch: string): string;
export declare function parseGitHubRemote(url: string): RepoRef | null;
export declare function branchFromArgv(argv: readonly string[]): string | null;
