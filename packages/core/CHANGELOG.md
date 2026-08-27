# @volund/core

## 0.1.0

### Minor Changes

- 7a96f71: Extend guarded local evolution to router, retry, and tool timeout parameters with cumulative-deviation confirmation, durable freezing, and serialized audit persistence.
- b34e712: Add priority fallback routing with retry budgets, per-provider cooldown and half-open probes, sticky-provider enforcement, and cancellation-aware backoff.
- 976eb21: Add the L1 tool, permission, context, prompt, session, configuration, credential, and local telemetry runtime.
- e562b07: Add the versioned NDJSON contract for machine-readable chat output while preserving single-document JSON for management commands.
- 99c77bf: Add summary context compaction with safe sliding fallback, context policy contribution contracts, and transparent CLI/TUI context controls.
- 344f874: Establish the L1 monorepo foundation, neutral provider and tool contracts, immutable session state, and the typed 17-event core bus.
- 4067e1e: Add predictable role-based provider routing composed with fallback safety, turn stickiness, provider-registry opt-in, and built-in subagent role hints.
- d8d712d: Add the L2 context EvolutionEngine, sanitized append-only tuning audit storage, tuning memory persistence, and evolution show/rollback CLI.
- d631d20: Add the built-in Task tool and an isolated three-level subagent runtime with injected RunnerFactory, bounded budgets and concurrency, cancellation cascading, tagged event bubbling, and untrusted result handling.
- d348244: Add progressive skill disclosure, PromptComposer runtime wiring, durable image attachment handles, provider vision validation, and text-only capability fallback.
- 01ffdbd: Add the L1 runner loop, prompt composition, Anthropic streaming adapter, and single-provider routing.

### Patch Changes

- 568cb92: Add fail-closed stream resume capability contracts and prevent partial tool-use replay.
- Updated dependencies [b2851d5]
- Updated dependencies [340adfc]
- Updated dependencies [e6f71f1]
- Updated dependencies [b34e712]
- Updated dependencies [976eb21]
- Updated dependencies [3780728]
- Updated dependencies [c16ea41]
- Updated dependencies [99c77bf]
- Updated dependencies [344f874]
- Updated dependencies [568cb92]
- Updated dependencies [4067e1e]
- Updated dependencies [02ebe86]
- Updated dependencies [3816925]
- Updated dependencies [01ffdbd]
  - @volund/router@0.1.0
  - @volund/shared@0.1.0
  - @volund/provider-kit@0.1.0
  - @volund/tool-kit@0.1.0
