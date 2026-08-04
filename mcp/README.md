# Good Looks MCP server

Exposes Good Looks!'s recorded Playwright tests and run history to any MCP
client (Claude Code, Codex, Claude Desktop, etc). It's standalone — it reads
and writes the same data files the app itself uses
(`userData/recorder/tests.json`, `run-history.json`, generated specs), so it
works whether the app is open or closed.

## Setup

### Claude Code

```bash
claude mcp add --scope user good-looks -- node "$HOME/Library/Application Support/app.glaze.macos.main/apps/test-recorder-local-2ovdvu33/.glaze-sources/mcp/server.mjs"
```

`--scope user` makes it available in every project, not just this one. Use
`--scope local` (the default) to only register it for the project you run the
command in.

Verify it's registered:

```bash
claude mcp list
```

Remove it later with:

```bash
claude mcp remove good-looks
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.good-looks]
command = "node"
args = ["/Users/<you>/Library/Application Support/app.glaze.macos.main/apps/test-recorder-local-2ovdvu33/.glaze-sources/mcp/server.mjs"]
```

### Claude Desktop / other MCP clients

Add to the client's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "good-looks": {
      "command": "node",
      "args": [
        "/Users/<you>/Library/Application Support/app.glaze.macos.main/apps/test-recorder-local-2ovdvu33/.glaze-sources/mcp/server.mjs"
      ]
    }
  }
}
```

This project itself already has it registered in `.mcp.json` at the project
root, so the Glaze agent can use these tools in this workspace too.

## Tools

### `list_tests`

List every recorded test: id, name, target URL, step count, speed, and
timestamps. Newest-updated first, capped at 200. No arguments.

```
list_tests
```

### `get_test`

Return one test's full step list and its generated Playwright spec source.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | yes |

```
get_test testId="3f2a1c9e-..."
```

### `list_runs`

List past test runs (pass/fail, duration, timestamps), newest first.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | no — filter to one test |
| `limit` | number (1–200) | no — defaults to 50 |

```
list_runs
list_runs testId="3f2a1c9e-..." limit=10
```

### `get_run_log`

Return the raw console output for one past run, by run id (see `list_runs`).
Truncated to the last 20,000 characters; the full log stays on disk at the
run's `logFile` path.

| Arg | Type | Required |
|---|---|---|
| `runId` | string | yes |

```
get_run_log runId="a7c4e0b1-..."
```

### `run_test`

Run a recorded test locally with the bundled Playwright and report pass/fail.
The result is also written to the app's own run history, so it shows up in
the Stats view too.

| Arg | Type | Required |
|---|---|---|
| `testId` | string | yes |

```
run_test testId="3f2a1c9e-..."
```

Requires Chromium to already be installed under the app's data directory. If
it isn't yet, open the test once in the app and run it from the UI — that
installs the browser on first run — then retry from MCP. Runs are capped at 5
minutes and get force-killed past that.

## Example prompts

- "List my recorded tests."
- "Show me the steps and generated script for the checkout flow test."
- "What were the last 5 runs of the login test, and did any fail?"
- "Get the full log for that failed run and tell me what broke."
- "Run the signup test and tell me if it passes."

## Notes

- Read-only tools (`list_tests`, `get_test`, `list_runs`, `get_run_log`) never
  modify app data. `run_test` executes Playwright and appends a run record.
- Data directory resolution (`mcp/glaze-data.mjs`) is machine-independent — it
  derives the path from `package.json`'s `id` field, so the server keeps
  working if the project moves machines.
