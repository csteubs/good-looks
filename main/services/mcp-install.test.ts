// The command the Documentation pane offers to copy.
//
// Every failure here is silent in the worst way: the pane renders a command
// that looks right, the user pastes it, and the shell — not the app — says
// something confusing. So what is asserted is the two properties a paste
// depends on, not the exact string.

import { describe, it, expect, beforeEach } from "vitest";

import { setPackaged, resetLaunchState } from "./__tests__/shell-backend-stub";
import { mcpServerInfo } from "./mcp-install";

beforeEach(() => {
  resetLaunchState();
});

describe("the register command", () => {
  it("names node from a checkout, where the developer already has it", () => {
    setPackaged(false);
    const { command, exists } = mcpServerInfo();
    // This test runs from the repo, so the server really is there.
    expect(exists).toBe(true);
    expect(command).toContain("claude mcp add --scope user good-looks");
    expect(command).toContain("-- node ");
    expect(command).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("names the app's own binary when packaged, because there may be no node", () => {
    // The whole point of shipping the server: someone who installed the .app
    // rather than cloning has no reason to have Node. `process.execPath` under
    // Electron is the app binary.
    setPackaged(true);
    const { command } = mcpServerInfo();
    expect(command).toContain("-e ELECTRON_RUN_AS_NODE=1");
    expect(command).toContain(process.execPath);
    expect(command).not.toContain("-- node ");
  });

  it("never double-quotes a path, because this app's name ends in `!`", () => {
    // THE BUG THIS RULES OUT. "Good Looks!.app" inside double quotes is a
    // history expansion in interactive zsh and bash — the pasted command dies
    // with `event not found` before it runs anything. It only became reachable
    // when the path started pointing inside the bundle; from a checkout there
    // is no `!` in it, which is why the old double-quoted form looked fine.
    for (const packaged of [true, false]) {
      setPackaged(packaged);
      const { command } = mcpServerInfo();
      expect(command).not.toContain('"');
      expect(command).toContain("'");
    }
  });

  it("reports a path either way, so the pane can name it even when absent", () => {
    const { path } = mcpServerInfo();
    expect(path).toMatch(/mcp[/\\]server\.mjs$/);
  });
});
