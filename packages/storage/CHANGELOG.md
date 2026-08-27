# @volund/storage

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
