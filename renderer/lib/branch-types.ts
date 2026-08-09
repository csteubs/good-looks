// What the branch switcher sends over IPC.
//
// Declared ONCE and imported type-only by the main-process side
// (`main/services/branch-switcher.ts`, `branch-repo.ts`, `github-prs.ts`)
// rather than mirrored the way `recorder-types.ts` mirrors the recorder model.
// That mirror predates this and carries real weight — hundreds of fields — but
// a mirror is a promise someone has to keep, and the failure when they don't is
// a view rendering a field the backend stopped sending. Six interfaces are
// small enough to share outright, and `import type` erases at build time, so
// nothing about the module graph changes: no runtime import crosses the
// boundary in either direction.
//
// `renderer/lib` is already the app's home for logic that isn't DOM-bound —
// vitest runs `renderer/lib/**/*.test.ts` in the NODE project for exactly that
// reason — so this is not a backend reaching into UI code.

export interface BranchStatus {
  available: boolean;
  /** Why not, when unavailable. Shown verbatim — it is the whole explanation. */
  reason?: string;
  /** The user's own checkout: where builds are driven from, and where "return
   *  to my checkout" goes. */
  checkout?: string;
  /** The directory this process was launched from. Differs from `checkout`
   *  exactly when a branch build is running. */
  appPath?: string;
  /** `origin` as owner/repo, or null when the remote isn't GitHub — in which
   *  case branches still switch but there are no pull requests to list. */
  repo?: { owner: string; name: string } | null;
  /** The branch this process is running: the switched-to branch, or the
   *  checkout's own HEAD. */
  current?: string;
  /** True when a branch build is running rather than the user's checkout. */
  switched: boolean;
  /** Whether a GitHub token is saved. Never the token itself. */
  hasToken: boolean;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  /** The head ref — the branch a switch would build. Always a name the branch
   *  validator accepted; refs it refuses never reach the renderer. */
  branch: string;
  author: string;
  draft: boolean;
  /** ISO-8601, straight from the API. Formatted in the view. */
  updatedAt: string;
  /** The PR's own page, shown as text so the user can open it themselves. */
  url: string;
  /** From a fork: the head branch is not on `origin`, so there is nothing to
   *  check out. The row explains rather than offering a switch that would fail. */
  fork: boolean;
}

export interface BranchSummary {
  name: string;
  /** Last commit time, epoch ms. */
  updatedAt: number;
  /** Subject line of the branch tip, so a generated branch name is
   *  identifiable without checking it out. */
  subject: string;
}

/** One push on the `branches:progress` channel while a switch runs. */
export interface SwitchProgress {
  kind: "step" | "log" | "done";
  /** Coarse stage: fetch | worktree | deps | build | launch. */
  phase?: string;
  message?: string;
  /** One line of build output. */
  line?: string;
}
