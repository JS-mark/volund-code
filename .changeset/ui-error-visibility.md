---
'@volund/ui': patch
---

Surface provider errors in the TUI status line: `error.raised` now renders `code: context.message` (e.g. `runner_error: Anthropic request failed (401)`) instead of the bare code, and a subsequent `turn.aborted` with `reason: 'error'` no longer overwrites that specific status with a generic 'turn aborted'.
