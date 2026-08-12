// The handoff between the hover menu and the Branches view.
//
// Small module, and the property it exists for is the one that costs real time
// when it is wrong: a switch must be acted on EXACTLY ONCE. Left in place, the
// request restarts a multi-minute build and an app relaunch every time the view
// mounts — so navigating away and back would rebuild the app for a click made
// ten minutes ago.
//
// `.tsx` despite containing no JSX, and that is not a style choice: a `.test.ts`
// under `renderer/` outside `lib/` or `dev/` matches NEITHER vitest project and
// is silently never run (CLAUDE.md). It was written as `.test.ts` first.

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearBranchSwitch,
  requestBranchSwitch,
  takeBranchSwitch,
} from "./pending-branch-switch";

beforeEach(() => {
  clearBranchSwitch();
});

describe("pending-branch-switch", () => {
  it("has nothing pending until something asks", () => {
    expect(takeBranchSwitch()).toBeUndefined();
  });

  it("hands back the branch that was asked for", () => {
    requestBranchSwitch("feat/a");
    expect(takeBranchSwitch()).toBe("feat/a");
  });

  it("distinguishes 'go home' from 'nothing pending'", () => {
    // `null` is the pinned row and IS a request; `undefined` is no request.
    // Collapsing them would either drop the way home or start a switch nobody
    // asked for.
    requestBranchSwitch(null);
    const taken = takeBranchSwitch();
    expect(taken).toBeNull();
    expect(taken).not.toBeUndefined();
  });

  it("clears as it reads, so a request runs exactly once", () => {
    // THE POINT OF THE MODULE. A second read is what a remount looks like.
    requestBranchSwitch("feat/a");
    expect(takeBranchSwitch()).toBe("feat/a");
    expect(takeBranchSwitch()).toBeUndefined();
  });

  it("clears a `null` request too", () => {
    // Easy to get wrong with a `pending ?? undefined` style reset, which leaves
    // null looking like a live request forever.
    requestBranchSwitch(null);
    takeBranchSwitch();
    expect(takeBranchSwitch()).toBeUndefined();
  });

  it("keeps only the most recent request", () => {
    requestBranchSwitch("feat/a");
    requestBranchSwitch("feat/b");
    expect(takeBranchSwitch()).toBe("feat/b");
    expect(takeBranchSwitch()).toBeUndefined();
  });
});
