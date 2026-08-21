# JSON output contract

Apollo has two intentionally different machine-output shapes.

- `apollo chat ... --json` and the default prompt entry point use a versioned NDJSON stream. Each stdout line is one complete JSON event. Ink, banners, progress text, and ANSI styling are disabled; diagnostics belong on stderr.
- Management commands such as `doctor`, `context`, `evolution`, `plugin`, `mcp`, and `memory` normally keep a single JSON document followed by a newline. Arrays remain arrays and objects remain objects. Memory documents use `schemaVersion: 1`; failures use `{ schemaVersion, error: { code, message, exitCode } }`. Plugin-command failures are the deliberate exception: stdout contains exactly an `error` event followed by a `final` event in the version-1 NDJSON envelope, and stderr remains empty.

## NDJSON envelope (version 1)

Every event contains `v`, `type`, monotonically increasing `seq`, `sessionId`, optional `turnId`, an ISO-8601 `timestamp`, and `data`. Consumers must reject unsupported major versions and ignore unknown fields and event types within a supported version.

The ordered event vocabulary is `message.start`, `text.delta`, `tool_use`, `tool_result`, `error`, `router.switched`, `usage`, and `final`. `tool_use.data.phase` is `start`, `delta`, or `end`. A turn always terminates with exactly one `final` event after all other events.

`error.data` has stable `code`, `category`, `retryable`, and `exitCode` fields. Additional sanitized context may be present. Secret-bearing keys and common inline credential forms are replaced with `[REDACTED]` before serialization.

## Completion and exit codes

| Final status | Exit code | Meaning                  |
| ------------ | --------: | ------------------------ |
| `completed`  |         0 | Turn completed normally  |
| `error`      |         1 | Runtime/provider failure |
| `cancelled`  |       130 | Interrupted or cancelled |

Argument and usage errors continue to use exit code 2; strict sandbox failures use 3. If startup fails before a session ID exists, error and final events use an empty `sessionId`.

NDJSON is a stdout contract. Human diagnostics go to stderr and never become unframed stdout. `--json` selects non-TUI operation, so scripts do not need to also pass `--no-tui`.
