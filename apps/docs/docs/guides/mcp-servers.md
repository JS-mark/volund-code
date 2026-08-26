# MCP servers

Apollo is an MCP client (stdio + HTTP, with automatic fallback to legacy SSE). Configuration follows the industry-standard `mcpServers` shape and interoperates with Claude Code, Codex, and Cursor.

## Add

```sh
# stdio (everything after `--` is passed through to the server process)
apollo mcp add context7 -- npx -y @context7/mcp
apollo mcp add my-server -- node ./server.js --flag value
apollo mcp add -e API_KEY=xxx context7 -- npx -y @context7/mcp

# Remote
apollo mcp add -t http remote https://api.example.com/mcp
apollo mcp add -t sse legacy https://old.example.com/sse
apollo mcp add -t http -H 'Authorization: Bearer tok' remote https://api.example.com/mcp

# Project scope (.apollo/mcp.toml, shipped with the repo)
apollo mcp add -s project my-server -- npx -y my-mcp
```

`-e KEY=VALUE` and `-H 'Key: value'` can be repeated. Adding a name that already exists replaces the whole entry (no field merge).

You can also drop an industry-standard `.mcp.json` into the repo root — Apollo imports it read-only at session start (it never writes that file):

```json
{
  "mcpServers": {
    "context7": { "command": "npx", "args": ["-y", "@context7/mcp"] },
    "remote": { "type": "http", "url": "https://api.example.com/mcp" }
  }
}
```

Environment expansion: values support `${VAR}` and `${VAR:-default}` (an unset variable without a default expands to an empty string with a warning). Prefer `keyref://` placeholders for credentials (`Authorization: keyref://mcp.<name>.Authorization`) instead of plaintext on disk.

## Configuration and scopes

Resolved in priority order (same name replaces the whole entry):

1. Project `<cwd>/.apollo/mcp.toml` (TOML `[mcp_servers.<name>]` tables)
2. Project `<cwd>/.mcp.json` (industry JSON, read-only import)
3. User `~/.apollo/mcp.toml`

Untrusted directories are rejected at startup and their project-level servers are never connected.

## Manage

| Action | REPL | CLI |
|---|---|---|
| List / status | `/mcp` panel | `apollo mcp list` (connectivity snapshot after a bounded 4s wait) |
| Detail | Enter in the panel (metadata + tool list) | `apollo mcp inspect <name>` |
| Enable / disable (persistent) | Space in the panel | `apollo mcp enable\|disable <name>` |
| Connectivity test | `r` in the panel (reconnect all) | `apollo mcp test <name>` |
| Remove | — | `apollo mcp remove <name>` |

Enabled state persists in `~/.apollo/config.toml` under `[mcp] disabled`.

## Troubleshooting

- `~/.apollo/mcp.log`: structured JSONL diagnostics (startup / connect / failure / per-line server stderr).
- `apollo doctor`: the `mcp servers` row reports configured / connected / failed counts.
- A server returning 401/403 is marked `needs-auth` in the panel; the OAuth login flow (`apollo mcp login`) is scheduled for SM-07. Until then, configure an `Authorization` header or an API-key env var manually.
