# CLI reference

## Directory trust

```sh
apollo trust list [--json]
apollo trust revoke <path>
apollo trust revoke --all
apollo chat --cwd <path> --trust-workspace "prompt"
```

`--trust-workspace` is the scriptable opt-in for non-interactive runs. It persists an exact canonical-path rule; it never grants a parent or subtree scope.

## Context evolution (L2)

`apollo evolution show [--namespace context] [--since <date>]` displays the sanitized, append-only local tuning audit. `apollo evolution rollback [--namespace context] [--to <timestamp>]` restores context parameters to the preceding or selected point. Setting `[evolution] enabled = false` in `~/.apollo/config.toml` makes new sessions use built-in context defaults.

| Command                        | Purpose                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `apollo` / `apollo chat`       | Start an interactive or one-shot coding session.                                              |
| `apollo login <provider>`      | Verify, then securely store a provider credential.                                            |
| `apollo logout <provider>`     | Remove a stored provider credential.                                                          |
| `apollo config`                | Inspect configuration.                                                                        |
| `apollo history list` / `show` | Inspect local session history.                                                                |
| `apollo resume <session-id>`   | Resume at the last durable turn boundary.                                                     |
| `apollo restore <session-id>`  | Restore files changed during a session.                                                       |
| `apollo doctor [--strict]`     | Check configuration, credentials, native packages, and sandbox readiness.                     |
| `apollo memory <action>`       | Manage durable memories, pinned context, and the local search index.                          |
| `apollo plugin <action>`       | Inspect or remove contained local plugins; legacy install/enable are temporarily unavailable. |
| `apollo hook list`             | List built-in hooks.                                                                          |
| `apollo version`               | Print the version.                                                                            |
| `apollo help`                  | Show command help.                                                                            |

Common modes include `--no-tui`, `--json`, and `--no-color`. Non-interactive runs do not load project configuration unless `--trust-project-config` is supplied. Dangerous sandbox bypass flags are audited and require explicit confirmation.

For automation, see the [versioned NDJSON and management JSON contract](./json-output.md). Chat `--json` is an event stream and disables the TUI; management commands return one JSON document.

Use `apollo restore <session-id> --dry-run` to preview a rollback. Every `Write`, `Edit`, and `MultiEdit` operation records a session-scoped backup first. Restore refuses to overwrite files changed after Apollo's edit. Backups are retained for seven days by default and bounded to 500 MB.

Resume marks an unfinished turn as aborted and starts from a new turn; it never re-runs an incomplete provider or tool call.

Inside interactive chat, `/resume` opens the same saved-session picker. Cancelling or a failed resume leaves the current session and input history unchanged.

## Memory

```sh
apollo memory list [--scope workspace|project|both] [--tag <tag>] [--source user|agent|evolution|import] [--pinned] [--limit <n>] [--cursor <cursor>]
apollo memory get <id> [--scope workspace|project|both]
apollo memory add [content] [--id <id>] [--scope workspace|project] [--tag <tag>] [--source user|import] [--pinned]
apollo memory update <id> [content] [--tag <tag>] [--pinned] [--expected-updated-at <time>]
apollo memory delete <id> [--yes]
apollo memory pin <id>
apollo memory unpin <id>
apollo memory export [--scope workspace|project|both] > memory.json
apollo memory import memory.json [--scope workspace|project] [--strategy skip|overwrite|rename] [--dry-run]
```

`global` is accepted as an alias for `workspace`. Use `--body-stdin` instead of an inline body when piping content. Repeated tags can be comma-separated. Listings use stable `pinned desc, updatedAt desc, id asc` cursor pagination and `--json` returns one schema-versioned document without ANSI. Memory exit codes are `0` success, `2` validation or required confirmation, `3` not found, and `13` scope/authorization denial.

Deletion requires an interactive confirmation. Non-TTY, `--json`, and `--no-tui` calls must pass `--yes`, so automation cannot delete by accident. Output is sanitized before rendering.

Pinned memory is injected before every provider request with a fixed line/token budget. Session memory wins over project memory, which wins over workspace memory; duplicate content is kept only at the narrowest scope, then sorted deterministically. Every body is escaped inside `<untrusted source="memory:pinned">`; it is advisory data and cannot override current user or system instructions. Pinning invalidates the prompt cache immediately, while unpinning or deleting removes the body from the next composition.

### Interactive `/memory` panel

Inside an active TTY chat, `/memory` opens the project-scoped browser backed by the same `MemoryService` and `MemoryRecallService` as the commands above. It supports cursor paging, debounced local search, details, content/tag editing, delete confirmation, and pin/unpin. Use arrows, Page Up/Down, Home/End, Enter, `/`, `E`, `P`, `D`, and Esc; `Ctrl+S` saves an edit. Delete defaults to Cancel, and a dirty edit requires an explicit discard.

The panel disables Chat input while open and restores it after Esc; panel keystrokes never enter Chat history. Failed or stale writes retain the current record and draft. Search results are read back through the fact service before details or mutations. `--json`, `--no-tui`, or a non-TTY stdin/stdout never opens Ink or waits for panel input. Narrow terminals keep text markers such as `>`, `[P]`, `Error:`, and `Modified`, so `--no-color` does not remove meaning.

## Local memory search and recovery

```sh
apollo memory search <query> [--scope workspace|project|session] [--limit 10] [--tag tag] [--json]
apollo memory doctor [--strict] [--json]
apollo memory reindex [--check] [--force] [--batch-size 250] [--json]
```

Search is local keyword matching only and performs no embedding or network request. Index hits are always read back through the scoped fact service, so stale, deleted, ghost, and unauthorized entries are not returned. `memory doctor` is read-only. `memory reindex --check` reports whether rebuilding is required, while a normal rebuild uses a cross-process lock and atomically publishes a new generation only after every batch succeeds. `--force` rebuilds a healthy generation and may clear a stale lock, but never steals a lock owned by a live process.

Memory archives use the versioned `apollo.memory.export.v1` JSON schema. Export reads each requested
scope through the Memory ACL and includes attachment references only—never attachment bytes. Import
defaults to `skip`, reports every conflict, supports a no-write `--dry-run`, journals changes before
applying them, and rolls back partial or interrupted work. Imported records always receive
`source: import`; original provenance is retained as untrusted `importedFrom` metadata and cannot
grant authority. This flow is local-only and performs no upload, sharing, remote sync, or embedding.

## Local telemetry

`apollo telemetry show` summarizes locally stored Tier and sandbox escape decisions. A missing sample is reported as unknown, never as passing. `apollo telemetry export <path>` exports a freshly redacted JSONL copy, and `apollo telemetry clear` clears the active local file. `apollo doctor` reports sink writability and damaged JSONL lines.

Telemetry stays local by default. Apollo does not enable an OpenTelemetry exporter unless one is explicitly configured; telemetry never changes sandbox permissions or Tier selection.

## Role routing

Role routing is configured in the trusted global `~/.apollo/config.toml`. A role selects an explicit provider/model candidate chain; failures, cooldowns, retry limits, time/cost budgets, and sticky tool-use turns remain governed by `FallbackRouter`.

```toml
[router]
type = "role"

[router.default]
provider = "anthropic"
model = "claude-sonnet-4-5"

[router.roles.planner]
provider = "openai"
model = "gpt-4o-mini"
priority = 100

[router.roles.coder]
provider = "anthropic"
model = "claude-sonnet-4-5"
priority = 100

[router.roles.reviewer]
provider = "anthropic"
model = "claude-opus-4"
priority = 100
```

`planner`, `coder`, and `reviewer` hints may come from explicit input/hook metadata or built-in subagent types. An explicit `provider/model` hint wins for that turn. Once a provider emits the first tool-use chunk, it remains sticky until the turn ends; a retry may not cross providers.

Provider plugins never enter a role or fallback candidate pool merely by registering. Name one in a role/fallback entry to opt in, or select it explicitly for one turn. Plugin providers cannot be the default provider in v1.

## Plugins

Legacy v1 plugin installation, enablement, and activation are temporarily unavailable in production. They fail with `plugin_legacy_activation_unavailable` until Catalog v2, the verified capability ABI, and an explicit security reopen review are complete. Startup atomically migrates stale `enabled:true` records to disabled; no new or resumed session loads them. `plugin list [--json]`, `plugin doctor <name>`, `plugin disable <name>`, and `plugin uninstall <name>` remain available for safe inspection and cleanup. List text labels retained records `disabled (legacy runtime unavailable)`; list JSON preserves each stored record and adds `availability` plus `reasonCode`. `plugin doctor` and the general `doctor` command disclose the containment state and reopen condition. A malformed legacy state file yields the same stable typed fail-closed diagnostic. The legacy host capability matrix remains executable only through the package-private test harness; it is not a production availability claim.
