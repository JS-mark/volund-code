import { productIdentity } from '@volund/shared'

import { memoryUsage } from './memory'

const commandName = productIdentity.commandName

const chatUsage = `Usage: ${commandName} [chat] [prompt...]

Start an interactive session (TTY) or run a single prompt.

Options:
  --cwd <path>                       Override the working directory
  --json                             Stream versioned NDJSON events (requires a prompt)
  --no-tui                           Disable the Ink TUI (line output)
  --no-color                         Disable color
  --trust-workspace                  Trust the current directory non-interactively
  --strict-sandbox                   Require the full sandbox tier
  --dangerous-no-sandbox             Run without a sandbox (typed confirmation required)
  --dangerously-skip-permissions     Skip tool permission prompts (audited)
  --yolo                             Alias for --dangerously-skip-permissions
`

const resumeUsage = `Usage: ${commandName} resume [session-id]

Resume a saved session at the last durable turn boundary.
Without an id, an interactive picker lists recent sessions (TTY only).

Options:
  --json       Emit the session candidates as JSON when an id is required
  --no-tui     Disable the interactive picker
`

const restoreUsage = `Usage: ${commandName} restore <session-id> [--dry-run]

Restore files changed during a session from its session-scoped backups.
Restore refuses to overwrite files changed after ${productIdentity.shortName}'s edit.

Options:
  --dry-run    Preview what would be restored without writing
`

const loginUsage = `Usage: ${commandName} login [provider] [options]

Verify, then securely store a provider credential (default provider: anthropic).

Options:
  --api-key-stdin    Read the credential from stdin (avoids shell history)
  --skip-verify      Store without verification (requires --dangerous)
  --dangerous        Allow dangerous credential operations
`

const logoutUsage = `Usage: ${commandName} logout [provider]

Remove a stored provider credential (default provider: anthropic).
`

const statusUsage = `Usage: ${commandName} status [--json]

Show redacted runtime and configuration status.

Options:
  --json    Emit one JSON document
`

const configUsage = `Usage: ${commandName} config <command> [options]

Commands:
  list                  Print the merged configuration (default)
  get <key>             Print one value, e.g. provider.default
  set <key> <value>     Write a value (JSON literals keep their type)
  unset <key>           Remove a value
  path                  Print the config file location
  edit                  Open the config file in $EDITOR

Options:
  --project    Target <cwd>/.volund/config.toml instead of the user config
               (set/unset respect the project-override data-flow gate)
  --json       Emit one JSON document
`

const historyUsage = `Usage: ${commandName} history <command> [options]

Manage saved sessions (~/.volund/sessions/*.jsonl). Unrelated to the
interactive input-line history.

Commands:
  list                       List saved sessions (default)
  show <session-id>          Print a session's conversation
  search <query>             Local keyword search over session messages
  export <session-id>        Export a session as markdown (stdout) or JSON
  import <file>              Import a JSON session export
  clear --all                Delete all saved sessions (confirmation required)
  clear --older-than <date>  Delete sessions not modified since <date>

Options:
  --limit <n>           Max entries (list, search)
  --since <date>        Only sessions updated after <date> (list)
  --project             Only sessions for the current directory (list)
  -o, --output <file>   Write the export to a file instead of stdout
  --json                Emit one JSON document (for export, selects JSON format)
  --yes                 Confirm clear non-interactively
`

const doctorUsage = `Usage: ${commandName} doctor [--json] [--strict]

Diagnose configuration, credentials, native packages, and sandbox readiness.

Options:
  --json      Emit checks as one JSON document
  --strict    Exit 1 when any check fails
`

const telemetryUsage = `Usage: ${commandName} telemetry <command> [options]

Commands:
  show            Summarize locally stored telemetry (default)
  export <path>   Export a freshly redacted JSONL copy
  clear           Clear the active local telemetry file

Options:
  --json    Emit one JSON document (show)
`

const trustUsage = `Usage: ${commandName} trust <command> [options]

Commands:
  list            List trusted directory rules (default)
  revoke <path>   Revoke one trust rule
  revoke --all    Revoke all trust rules

Options:
  --all     Target every rule (revoke)
  --json    Emit one JSON document
`

const pluginUsage = `Usage: ${commandName} plugin <command> [options]

Commands:
  list               List recorded plugins and availability (default)
  install <spec>     Install a plugin
  uninstall <name>   Remove a plugin
  enable <name>      Enable a plugin
  disable <name>     Disable a plugin
  doctor <name>      Show containment state and the reopen condition

Options:
  --json    Emit one JSON document

Note: legacy plugin activation is temporarily unavailable; list, doctor,
disable, and uninstall remain available for inspection and cleanup.
`

const mcpUsage = `Usage: ${commandName} mcp <command> [options]

Commands:
  list                                 List configured servers with status (default)
  add <name> <url>                     Add an http/sse server
  add <name> -- <command> [args...]    Add a stdio server
  remove <name>                        Remove a server
  test <name>                          Run a connectivity test
  inspect <name>                       List the tools a server exposes
  enable <name>                        Enable a server
  disable <name>                       Disable a server

Add options:
  -t, --transport stdio|http|sse       Transport kind
  -s, --scope user|project             Target mcp.toml (default: user)
  -e, --env KEY=VALUE                  Environment variable (repeatable, stdio)
  -H, --header 'Key: value'            HTTP header (repeatable, remote)

Options:
  --scope user|project    Scope for remove/enable/disable when ambiguous
  --json                  Emit one JSON document
`

const skillUsage = `Usage: ${commandName} skill <command> [options]

Commands:
  list               List skills with scope and status (default)
  install <source>   Install from a local dir, git URL, github:owner/repo, or owner/repo
  uninstall <name>   Remove an installed skill
  show <name>        Print the skill's SKILL.md
  enable <name>      Enable a skill
  disable <name>     Disable a skill

Options:
  --scope user|project    Filter or target a scope
  --json                  Emit one JSON document (list, install)
`

const contextUsage = `Usage: ${commandName} context <command> [options]

Commands:
  show                        Show token usage, sources, and policy (default)
  diff                        List messages removed by the last compaction
  keep <id>                   Pin a message or turn against compaction
  unkeep <id>                 Remove the pin
  compact [sliding|summary]   Compact now, optionally with a strategy
  policy get                  Show the active compaction policy
  policy set <name> [K=V...]  Switch policy and set parameters

Options:
  --json    Emit one JSON document (show, policy get)
`

const evolutionUsage = `Usage: ${commandName} evolution <command> [options]

Commands:
  show        Show recent local tuning adjustments (default)
  rollback    Roll parameters back to a previous point

Options:
  --namespace context|router|retry|tool-timeout    Filter one namespace
  --since <date>        Adjustments after this date (show)
  --to <timestamp>      Restore values at this time (rollback)
  --json                Emit one JSON document (show)
`

const hookUsage = `Usage: ${commandName} hook list

List the builtin hooks registered in this build.
`

const versionUsage = `Usage: ${commandName} version

Print the version.
`

const helpUsage = `Usage: ${commandName} help [command]

Show global help, or help for a specific command.
`

/** Per-command help for the implemented command surface (spec §11.3 `volund help [command]`). */
export const commandUsage: Readonly<Record<string, string>> = {
  chat: chatUsage,
  resume: resumeUsage,
  restore: restoreUsage,
  login: loginUsage,
  logout: logoutUsage,
  status: statusUsage,
  config: configUsage,
  history: historyUsage,
  doctor: doctorUsage,
  memory: memoryUsage,
  telemetry: telemetryUsage,
  trust: trustUsage,
  plugin: pluginUsage,
  mcp: mcpUsage,
  skill: skillUsage,
  context: contextUsage,
  evolution: evolutionUsage,
  hook: hookUsage,
  version: versionUsage,
  help: helpUsage,
}

/**
 * Commands whose first positional is an action, so `volund <cmd> help` reads as
 * a help request (today it only errors as an unknown action). Prompt-taking
 * commands (chat) and id/name-taking commands (resume/login/...) are excluded:
 * there a bare `help` token is data, not a help request.
 */
export const actionStyleCommands: ReadonlySet<string> = new Set([
  'memory',
  'telemetry',
  'trust',
  'plugin',
  'mcp',
  'skill',
  'context',
  'evolution',
  'hook',
  'config',
  'history',
])
