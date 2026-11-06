# Local client installation

`local-figma-mcp` uses local MCP stdio and does not select a language model.
Register the installed command once per client. OAuth credentials stay in the
private local data directory; generated client entries contain no credentials.

```sh
npm run install:global
local-figma-mcp detect --json
local-figma-mcp setup --dry-run
local-figma-mcp setup --client codex,claude-code,copilot --yes --force
```

`setup` without `--yes` only prints a plan. `--client` selects detected clients;
omit it to target all detected compatible clients. Inspect the plan before
applying. `--force` is required for provider CLI updates and removal because the
provider CLI may replace an existing same-named entry.

| Client ID | Configuration mechanism |
| --- | --- |
| `codex` | Official `codex mcp add/remove`; respects `CODEX_HOME` |
| `claude-code` | Official `claude mcp add/remove --scope user`; respects `CLAUDE_CONFIG_DIR` |
| `vscode` | User `Code/User/mcp.json`, `servers.local-figma`, `type: stdio` |
| `copilot` | `$COPILOT_HOME/mcp-config.json` or `~/.copilot/mcp-config.json` |
| `claude-desktop` | Platform application-data `Claude/claude_desktop_config.json` |
| `cursor` | `~/.cursor/mcp.json` |
| `gemini` | `~/.gemini/settings.json` |
| `devin` | Official `devin mcp add/remove -s user` |
| `windsurf-legacy` | `~/.codeium/windsurf/mcp_config.json`; omitted automatically when Devin is detected |

Example manual entry for clients using `mcpServers`:

```json
{
  "mcpServers": {
    "local-figma": { "command": "local-figma-mcp", "args": [] }
  }
}
```

The installer preserves unrelated entries, including `local-android`. It rejects
malformed/duplicate JSON keys, incompatible configuration shapes, symbolic-link
files and conflicting `local-figma` entries unless replacement is explicit.
It creates sibling backups and atomically replaces JSON/JSONC files.
Provider CLIs manage their own file writes; existing provider files are backed
up before invocation.

On Windows, the trusted absolute npm command shim is resolved at installation
and launched via `cmd.exe` with validated arguments. Rerun setup after changing
computers or moving the global Node installation. macOS and Linux entries use
the stable global command rather than the source directory.

To remove this server's registration:

```sh
local-figma-mcp uninstall --client copilot --dry-run
local-figma-mcp uninstall --client copilot --yes
local-figma-mcp uninstall --client codex --yes --force
```

Uninstall retains unrelated MCP registrations and local design snapshots.
The package is private; no npm registry publication is performed. Compatibility
tests exercise configuration handling and MCP protocol behavior; an actual
interactive client must be restarted to discover a newly registered server.
