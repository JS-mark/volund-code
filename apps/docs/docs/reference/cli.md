# CLI reference

`volund` is the canonical command. The legacy `volund` executable remains an alias during the Phase A compatibility window; examples below use the new name.

## Directory trust

```sh
volund trust list [--json]
volund trust revoke <path>
volund trust revoke --all
volund chat --cwd <path> --trust-workspace "prompt"
```

`--trust-workspace` is the scriptable opt-in for non-interactive runs. It persists an exact canonical-path rule; it never grants a parent or subtree scope.

## Adaptive runtime tuning (L2)

`volund evolution show [--namespace context] [--since <date>]` displays the sanitized, append-only local tuning audit. `volund evolution rollback [--namespace context] [--to <timestamp>]` restores context parameters to the preceding or selected point. New sessions use built-in context defaults unless `~/.volund/config.toml` contains the exact boolean `[evolution] enabled = true`; missing or false remains off, while malformed, unreadable, or wrong-type configuration stops Runner startup before tuning is read. This compatibility switch only applies existing context tuning values—it does not start automatic observation or validation. `show` and `rollback` remain available while tuning is off.

| Command                       | Purpose                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `volund` / `volund chat`      | Start an interactive or one-shot coding session.                                              |
| `volund login <provider>`     | Verify, then securely store a provider credential.                                            |
| `volund logout <provider>`    | Remove a stored provider credential.                                                          |
| `volund config <action>`      | Inspect and edit configuration (`list`/`get`/`set`/`unset`/`path`/`edit`).                    |
| `volund history <action>`     | Inspect and manage saved sessions (`list`/`show`/`search`/`export`/`import`/`clear`).         |
| `volund resume <session-id>`  | Resume at the last durable turn boundary.                                                     |
| `volund restore <session-id>` | Restore files changed during a session.                                                       |
| `volund doctor [--strict]`    | Check configuration, credentials, native packages, and sandbox readiness.                     |
| `volund memory <action>`      | Manage durable memories, pinned context, and the local search index.                          |
| `volund plugin <action>`      | Inspect or remove contained local plugins; legacy install/enable are temporarily unavailable. |
| `volund skill <action>`       | Install, list, show, enable/disable, uninstall prompt skills.                                 |
| `volund mcp <action>`         | Add, list, test, enable/disable, remove, and inspect MCP servers.                             |
| `volund hook list`            | List built-in hooks.                                                                          |
| `volund version`              | Print the version.                                                                            |
| `volund help`                 | Show command help.                                                                            |

Common modes include `--no-tui`, `--json`, and `--no-color`. Non-interactive runs do not load project configuration unless `--trust-project-config` is supplied. Dangerous sandbox bypass flags are audited and require explicit confirmation.

Run `volund help <command>` or `volund <command> --help` for command-specific actions and options.

For automation, see the [versioned NDJSON and management JSON contract](./json-output.md). Chat `--json` is an event stream and disables the TUI; management commands return one JSON document.

## Configuration

```sh
volund config list [--json]
volund config get <key>
volund config set <key> <value> [--project]
volund config unset <key> [--project]
volund config path [--project]
volund config edit [--project]
```

`list` prints the merged user + project file configuration; project keys forbidden by the data-flow gate (Appendix C.2 `projectOverride: forbidden`, plus any `*.baseUrl`/`*.endpoint`/`*_api_key`) are filtered out with a warning. `set` writes the user config by default and `--project` targets `<cwd>/.volund/config.toml`; unknown keys and wrong-typed values are rejected against the config schema. Values parse as JSON literals first (`40` → number, `true` → boolean), otherwise as strings. `edit` opens `$EDITOR` (or `$VISUAL`, then `vi`) on the file and validates it on save; it requires an interactive terminal.

## Session history

```sh
volund history list [--limit N] [--since <date>] [--project] [--json]
volund history show <session-id> [--json]
volund history search <query> [--limit N]
volund history export <session-id> [-o file] [--json]
volund history import <file>
volund history clear (--all | --older-than <date>) [--yes]
```

These commands manage saved session archives (`~/.volund/sessions/*.jsonl`) and never touch the interactive input-line history. `search` is a local keyword match over message text; it performs no embedding or network request. `export` prints markdown by default and a versioned JSON document with `--json`; `import` restores such a JSON export and refuses to overwrite an existing session. `clear` deletes session files and, like `memory delete`, requires interactive confirmation or `--yes` outside a TTY.

Use `volund restore <session-id> --dry-run` to preview a rollback. Every `Write`, `Edit`, and `MultiEdit` operation records a session-scoped backup first. Restore refuses to overwrite files changed after Volund's edit. Backups are retained for seven days by default and bounded to 500 MB.

Resume marks an unfinished turn as aborted and starts from a new turn; it never re-runs an incomplete provider or tool call.

Inside interactive chat, `/resume` opens the same saved-session picker. Cancelling or a failed resume leaves the current session and input history unchanged.

## Memory

```sh
volund memory list [--scope workspace|project|both] [--tag <tag>] [--source user|agent|evolution|import] [--pinned] [--limit <n>] [--cursor <cursor>]
volund memory get <id> [--scope workspace|project|both]
volund memory add [content] [--id <id>] [--scope workspace|project] [--tag <tag>] [--source user|import] [--pinned]
volund memory update <id> [content] [--tag <tag>] [--pinned] [--expected-updated-at <time>]
volund memory delete <id> [--yes]
volund memory pin <id>
volund memory unpin <id>
volund memory export [--scope workspace|project|both] > memory.json
volund memory import memory.json [--scope workspace|project] [--strategy skip|overwrite|rename] [--dry-run]
```

`global` is accepted as an alias for `workspace`. Use `--body-stdin` instead of an inline body when piping content. Repeated tags can be comma-separated. Listings use stable `pinned desc, updatedAt desc, id asc` cursor pagination and `--json` returns one schema-versioned document without ANSI. Memory exit codes are `0` success, `2` validation or required confirmation, `3` not found, and `13` scope/authorization denial.

Deletion requires an interactive confirmation. Non-TTY, `--json`, and `--no-tui` calls must pass `--yes`, so automation cannot delete by accident. Output is sanitized before rendering.

Pinned memory is injected before every provider request with a fixed line/token budget. Session memory wins over project memory, which wins over workspace memory; duplicate content is kept only at the narrowest scope, then sorted deterministically. Every body is escaped inside `<untrusted source="memory:pinned">`; it is advisory data and cannot override current user or system instructions. Pinning invalidates the prompt cache immediately, while unpinning or deleting removes the body from the next composition.

### Interactive `/memory` panel

Inside an active TTY chat, `/memory` opens the project-scoped browser backed by the same `MemoryService` and `MemoryRecallService` as the commands above. It supports cursor paging, debounced local search, details, content/tag editing, delete confirmation, and pin/unpin. Use arrows, Page Up/Down, Home/End, Enter, `/`, `E`, `P`, `D`, and Esc; `Ctrl+S` saves an edit. Delete defaults to Cancel, and a dirty edit requires an explicit discard.

The panel disables Chat input while open and restores it after Esc; panel keystrokes never enter Chat history. Failed or stale writes retain the current record and draft. Search results are read back through the fact service before details or mutations. `--json`, `--no-tui`, or a non-TTY stdin/stdout never opens Ink or waits for panel input. Narrow terminals keep text markers such as `>`, `[P]`, `Error:`, and `Modified`, so `--no-color` does not remove meaning.

## Local memory search and recovery

```sh
volund memory search <query> [--scope workspace|project|session] [--limit 10] [--tag tag] [--json]
volund memory doctor [--strict] [--json]
volund memory reindex [--check] [--force] [--batch-size 250] [--json]
```

Search is local keyword matching only and performs no embedding or network request. Index hits are always read back through the scoped fact service, so stale, deleted, ghost, and unauthorized entries are not returned. `memory doctor` is read-only. `memory reindex --check` reports whether rebuilding is required, while a normal rebuild uses a cross-process lock and atomically publishes a new generation only after every batch succeeds. `--force` rebuilds a healthy generation and may clear a stale lock, but never steals a lock owned by a live process.

Memory archives use the versioned `volund.memory.export.v1` JSON schema. Export reads each requested
scope through the Memory ACL and includes attachment references only—never attachment bytes. Import
defaults to `skip`, reports every conflict, supports a no-write `--dry-run`, journals changes before
applying them, and rolls back partial or interrupted work. Imported records always receive
`source: import`; original provenance is retained as untrusted `importedFrom` metadata and cannot
grant authority. This flow is local-only and performs no upload, sharing, remote sync, or embedding.

## Local telemetry

`volund telemetry show` summarizes locally stored Tier and sandbox escape decisions. A missing sample is reported as unknown, never as passing. `volund telemetry export <path>` exports a freshly redacted JSONL copy, and `volund telemetry clear` clears the active local file. `volund doctor` reports sink writability and damaged JSONL lines.

Telemetry stays local by default. Volund does not enable an OpenTelemetry exporter unless one is explicitly configured; telemetry never changes sandbox permissions or Tier selection.

## Role routing

Role routing is configured in the trusted global `~/.volund/config.toml`. A role selects an explicit provider/model candidate chain; failures, cooldowns, retry limits, time/cost budgets, and sticky tool-use turns remain governed by `FallbackRouter`.

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

Legacy v1 plugin installation, enablement, and activation are temporarily unavailable in production. They fail with `plugin_legacy_activation_unavailable` until Catalog v2, the verified capability ABI, and an explicit security reopen review are complete. Startup interprets every parseable stale `enabled:true` record as effectively disabled without rewriting `plugins.json`; CAT-01/02 owns the later concurrency-safe migration. No new, resumed, noninteractive, or child session loads a legacy plugin. `plugin list [--json]`, `plugin doctor <name>`, `plugin disable <name>`, and `plugin uninstall <name>` remain available for safe inspection and cleanup. List text labels retained records `disabled (legacy runtime unavailable)`; list JSON preserves each stored record and adds `availability` plus `reasonCode`. `plugin doctor` and the general `doctor` command disclose the containment state and reopen condition without loading plugin code. A malformed legacy state file yields the same stable typed fail-closed diagnostic but does not block unrelated sessions or Memory operations. In `--json` mode, plugin failures write exactly an `error` event followed by `final` to stdout and keep stderr empty. Capability tests call the data-only bridge contracts directly; there is no published test authority or executable legacy host path.

Interactive Chat has a separate local-plugin v2 lifecycle through `/plugins`. Market installation only downloads, verifies, and records the plugin; it never activates code. Run `/plugins inspect <name>`, review the complete permissions and permission hash, then `/plugins approve <name> <permission-hash>` and `/plugins enable <name>`. A version or permission-hash change revokes approval and disables the plugin. `/plugins disable <name>` stops it without uninstalling it. This state is stored atomically in `~/.volund/plugin-state.v2.json`; it never reads or rewrites legacy `~/.volund/plugins/plugins.json`.

HTTPS market indexes may currently be browsed, but remote installation fails closed with `plugin_registry_signature_required` until publisher signatures, revocation, and a trusted-key root are wired end to end. Loopback HTTP sources are executable only for local development and tests. HTTPS plus file digests proves transport integrity, not publisher identity.
