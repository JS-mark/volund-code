# @volund/storage

## 0.2.0

### Minor Changes

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
- Updated dependencies [4b83a10]
- Updated dependencies [9e969d3]
- Updated dependencies [a0eecf1]
  - @volund/shared@0.2.0
  - @volund/core@0.2.0
  - @volund/permission@0.1.1
  - @volund/provider-kit@0.1.1

## 0.1.0

### Minor Changes

- 322c399: Add atomic MultiEdit transactions, session-scoped file backups, conflict-safe restore and durable resume recovery.
- ef83e9a: Add the versioned memory runtime, crash-safe local repository, scope policy, and production composition-root wiring.
- bca787c: Add permission-gated Memory plugin capabilities, attachment reference lifecycles, and local-only versioned import/export with dry-run conflict reports and crash rollback.
- 110ceb6: Add local scoped memory recall, crash-recoverable keyword indexing, read-only diagnostics, and atomic reindex CLI workflows.
- 7a96f71: Extend guarded local evolution to router, retry, and tool timeout parameters with cumulative-deviation confirmation, durable freezing, and serialized audit persistence.
- 1e38fa8: Connect enabled plugin Memory lifecycle hooks to the production composition root with scope-gated
  payloads, fail-closed vetoes and timeouts, recursion protection, metadata-only auditing, and
  post-commit lifecycle events shared by CLI, TUI, model, import, and Plugin write paths.
- 976eb21: Add the L1 tool, permission, context, prompt, session, configuration, credential, and local telemetry runtime.
- e43cf9d: Add local-only scoped memory persistence, content-addressed attachment references, and fail-closed project, user, and team ACL filtering before semantic ranking.
- d8d712d: Add the L2 context EvolutionEngine, sanitized append-only tuning audit storage, tuning memory persistence, and evolution show/rollback CLI.
- b69a471: Add paginated concurrency-safe Memory CRUD, mandatory pre-write validation, and production Memory model tools.
- d348244: Add progressive skill disclosure, PromptComposer runtime wiring, durable image attachment handles, provider vision validation, and text-only capability fallback.
- 80edf03: Add the stable Memory CLI and bounded, untrusted pinned-memory PromptComposer provider.

### Patch Changes

- 0fdd2db: Add the Chat `/memory` browser, search, paging, details, guarded editing, deletion, and pin controls while sharing Memory fact, recall, ACL, pre-write, cursor, and optimistic concurrency behavior with the CLI.
- 02ebe86: Reject common provider credentials, authorization values, JWTs, and credential URIs across every Memory write surface before persistence.
- Updated dependencies [340adfc]
- Updated dependencies [7a96f71]
- Updated dependencies [e6f71f1]
- Updated dependencies [b34e712]
- Updated dependencies [976eb21]
- Updated dependencies [e562b07]
- Updated dependencies [3780728]
- Updated dependencies [c16ea41]
- Updated dependencies [99c77bf]
- Updated dependencies [344f874]
- Updated dependencies [568cb92]
- Updated dependencies [4067e1e]
- Updated dependencies [8521920]
- Updated dependencies [02ebe86]
- Updated dependencies [d8d712d]
- Updated dependencies [d631d20]
- Updated dependencies [d348244]
- Updated dependencies [3816925]
- Updated dependencies [01ffdbd]
  - @volund/shared@0.1.0
  - @volund/core@0.1.0
  - @volund/provider-kit@0.1.0
  - @volund/permission@0.1.0
