# @volund/core

## 0.2.0

### Minor Changes

- 4b83a10: Migrate every EventBus emit point to the appendix D payload contract (r13-I8): the emit/forward exits now validate payloads against `EVENT_SCHEMAS[type]` and throw on violation, `stream.delta` carries incremental `{messageId, kind, fragment}` shapes, `tool.requested` is emitted before permission/execution, subagent bubbles keep the original `event.id` with envelope-only `parentTurnId`/`parentDepth` tags, and `replaySessionState` rebuilds `SessionState` from JSONL events (legacy `session.snapshot` rows are consumed read-only as a baseline; no new snapshots are written).
- 9e969d3: Make adaptive runtime tuning default-off and harden its persistence boundary. Configuration now
  requires an explicit own-property boolean opt-in, context tuning uses exported frozen bounds plus
  an atomic cross-field snapshot projection, and non-context persisted apply remains deny-only.
  Configuration parsing also rejects prototype-pollution key segments
  (`__proto__` / `constructor` / `prototype`) fail-closed. Evolution records are written as strict
  version-1 JSONL, legacy records retain explicit compatibility provenance, invalid or future
  records fail closed, and rollback consumes only validated context history. The flat V1 format is
  intentionally not yet crash-atomic or evidence-grade; record identity, sequencing, dual-file
  recovery, and migration diagnostics remain a separate T1b change.
- a0eecf1: Give the adaptive tuning store crash-recoverable, cross-process-coordinated persistence.
  New records are written as flat schema-version-2 lines carrying a store-assigned record id and a
  per-namespace monotonic sequence (strictly increasing; regressions are dropped with a fixed
  diagnostic). Every dual append runs under a best-effort cross-process lock and a
  `.evolution-txn.json` journal (PREPARED → NAMESPACE_DURABLE → BOTH_DURABLE, fsync at each step):
  recovery proves a commit only when both files end with the exact journalled record, aborts torn
  partial writes back to the journalled pre-sizes, and fails closed into a RECOVERY_REQUIRED state
  that refuses appends until manual intervention. `volund doctor` surfaces the tuning journal
  health. Honesty limits: file content is fsynced but new-file creation cannot be made durable
  across power loss without a directory fsync (no portable Node API; Windows deployments must
  disclose), the lock is a local coordination primitive rather than a security boundary, and the
  audit trail is still not promotion evidence for later shadow/apply stages without further review.

### Patch Changes

- Updated dependencies [5344f22]
- Updated dependencies [ad0e7b5]
- Updated dependencies [7ad5a34]
- Updated dependencies [7d1147e]
- Updated dependencies [4ac2411]
- Updated dependencies [9e969d3]
- Updated dependencies [a0eecf1]
  - @volund/shared@0.2.0
  - @volund/provider-kit@0.1.1
  - @volund/tool-kit@0.1.1
  - @volund/router@0.1.1

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
