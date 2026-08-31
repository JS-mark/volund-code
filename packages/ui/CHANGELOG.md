# @volund/ui

## 0.1.1

### Patch Changes

- 3697fb7: Blink the input box cursor like a terminal: the `▌` caret now toggles every 500 ms while the box is focused, stays visible at the end of typed input (previously it vanished once text was entered), resets to visible on every keystroke, and pauses while the input is disabled so streaming frames are not redrawn for blink alone.
- 001768a: Surface provider errors in the TUI status line: `error.raised` now renders `code: context.message` (e.g. `runner_error: Anthropic request failed (401)`) instead of the bare code, and a subsequent `turn.aborted` with `reason: 'error'` no longer overwrites that specific status with a generic 'turn aborted'.
- Updated dependencies [5344f22]
- Updated dependencies [ad0e7b5]
- Updated dependencies [7ad5a34]
- Updated dependencies [7d1147e]
- Updated dependencies [4ac2411]
- Updated dependencies [4b83a10]
- Updated dependencies [9e969d3]
- Updated dependencies [a0eecf1]
  - @volund/shared@0.2.0
  - @volund/core@0.2.0

## 0.1.0

### Minor Changes

- 0fdd2db: Add the Chat `/memory` browser, search, paging, details, guarded editing, deletion, and pin controls while sharing Memory fact, recall, ACL, pre-write, cursor, and optimistic concurrency behavior with the CLI.
- 51a8d26: Add the responsive volund Code startup status screen and stable bordered command input band.
- 3a6b644: Add a secret-safe read-only status view model, runtime aggregation adapter, and JSON-safe section formatter for the upcoming `/status` panel.
- 340adfc: Add the L1 CLI and UI product shell with strict diagnostics, guarded workspace paths, sandbox disclosure, dangerous-mode warnings, and replaceable integration ports.
- 8edb498: Add the redacted `/status` three-tab Ink panel, safe preference editing, and JSON/text status fallbacks.
- 5c195aa: Add the L1 unified model/file picker, serialized permission and diff presentation models, interrupted transcript recovery, and CLI session resume wiring.
- 1dafc88: Add versioned theme tokens and permission-gated declarative plugin status-bar contributions with lifecycle cleanup and headless isolation.
- 22375da: Add the interactive `/resume` command with shared session discovery, filtering, and atomic session switching.
- e9b0aea: Add a dynamic slash-command registry and connect plugin `commands.register` contributions to the interactive CLI with lifecycle-aware disposal.
- 823ad19: Add an interactive session picker for `volund resume`, including fuzzy search, resilient session discovery, and structured non-TTY errors.
- cf93b8c: Add local sandbox violation telemetry aggregation, a security panel, and CLI doctor/export/clear controls with defense-in-depth redaction.
- 99c77bf: Add summary context compaction with safe sliding fallback, context policy contribution contracts, and transparent CLI/TUI context controls.
- 6c2bed5: Add a canonical directory trust gate, persistent exact/tree scopes, interactive keyboard prompt, non-interactive opt-in, and trust management commands.

### Patch Changes

- 7472330: Replace the welcome mark with the selected V14 concentric AC logo.
- b90729e: Complete the resume session picker with ranked fuzzy search, semantic timestamps, and boundary-safe paged keyboard navigation.
- 41fbb46: Style resume search as a focused input band and provide a descriptive placeholder.
- 0ec7999: Keep the command input band open at both horizontal ends.
- 84c87cb: Render the interactive command input as a responsive, fully bordered command band.
- Updated dependencies [7a96f71]
- Updated dependencies [b34e712]
- Updated dependencies [976eb21]
- Updated dependencies [e562b07]
- Updated dependencies [99c77bf]
- Updated dependencies [344f874]
- Updated dependencies [568cb92]
- Updated dependencies [4067e1e]
- Updated dependencies [d8d712d]
- Updated dependencies [d631d20]
- Updated dependencies [d348244]
- Updated dependencies [01ffdbd]
  - @volund/core@0.1.0
