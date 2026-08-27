# volund-code

## 0.1.0

### Minor Changes

- 322c399: Add atomic MultiEdit transactions, session-scoped file backups, conflict-safe restore and durable resume recovery.
- ef83e9a: Add the versioned memory runtime, crash-safe local repository, scope policy, and production composition-root wiring.
- 0fdd2db: Add the Chat `/memory` browser, search, paging, details, guarded editing, deletion, and pin controls while sharing Memory fact, recall, ACL, pre-write, cursor, and optimistic concurrency behavior with the CLI.
- 51a8d26: Add the responsive volund Code startup status screen and stable bordered command input band.
- bca787c: Add permission-gated Memory plugin capabilities, attachment reference lifecycles, and local-only versioned import/export with dry-run conflict reports and crash rollback.
- 3a6b644: Add a secret-safe read-only status view model, runtime aggregation adapter, and JSON-safe section formatter for the upcoming `/status` panel.
- 340adfc: Add the L1 CLI and UI product shell with strict diagnostics, guarded workspace paths, sandbox disclosure, dangerous-mode warnings, and replaceable integration ports.
- 3059a39: Add deterministic, fail-closed Homebrew, winget, and apt/portable channel manifest dry-runs for all standalone targets.
- 110ceb6: Add local scoped memory recall, crash-recoverable keyword indexing, read-only diagnostics, and atomic reindex CLI workflows.
- 8edb498: Add the redacted `/status` three-tab Ink panel, safe preference editing, and JSON/text status fallbacks.
- 5c195aa: Add the L1 unified model/file picker, serialized permission and diff presentation models, interrupted transcript recovery, and CLI session resume wiring.
- 1e38fa8: Connect enabled plugin Memory lifecycle hooks to the production composition root with scope-gated
  payloads, fail-closed vetoes and timeouts, recursion protection, metadata-only auditing, and
  post-commit lifecycle events shared by CLI, TUI, model, import, and Plugin write paths.
- 22375da: Add the interactive `/resume` command with shared session discovery, filtering, and atomic session switching.
- e9b0aea: Add a dynamic slash-command registry and connect plugin `commands.register` contributions to the interactive CLI with lifecycle-aware disposal.
- 6ce20ca: Activate approved enabled plugins in the native sandbox host, bridge registered tool callbacks into live CLI sessions, dispose them across disable and uninstall, and add a secret-free real sandbox lifecycle E2E.
- c6e155d: Replace the disconnected CLI shell with production L1 wiring for Runner, Anthropic, permissions, native sandbox workers, session JSONL resume, telemetry, auth, config health, and strict doctor checks.
- 823ad19: Add an interactive session picker for `volund resume`, including fuzzy search, resilient session discovery, and structured non-TTY errors.
- 5a4987c: Ship the Rolldown single-file CLI and the twelve L1 native release assets,
  with three-OS TypeScript, four-target native, escape, doctor, digest, and
  universal2 CI evidence. Linux arm64 QEMU evidence remains partial verification
  and is never presented as real-hardware validation.
- cf93b8c: Add local sandbox violation telemetry aggregation, a security panel, and CLI doctor/export/clear controls with defense-in-depth redaction.
- e562b07: Add the versioned NDJSON contract for machine-readable chat output while preserving single-document JSON for management commands.
- 4bb00af: Add the standalone binary assembly contract and verified bundled native resolver.
- 99c77bf: Add summary context compaction with safe sliding fallback, context policy contribution contracts, and transparent CLI/TUI context controls.
- b365939: Add bounded MCP stdio and HTTP/SSE transports, lifecycle handling, tool registration, cancellation, reconnect, and untrusted response wrapping.
- 6c2bed5: Add a canonical directory trust gate, persistent exact/tree scopes, interactive keyboard prompt, non-interactive opt-in, and trust management commands.
- d8d712d: Add the L2 context EvolutionEngine, sanitized append-only tuning audit storage, tuning memory persistence, and evolution show/rollback CLI.
- b69a471: Add paginated concurrency-safe Memory CRUD, mandatory pre-write validation, and production Memory model tools.
- d631d20: Add the built-in Task tool and an isolated three-level subagent runtime with injected RunnerFactory, bounded budgets and concurrency, cancellation cascading, tagged event bubbling, and untrusted result handling.
- d348244: Add progressive skill disclosure, PromptComposer runtime wiring, durable image attachment handles, provider vision validation, and text-only capability fallback.
- cadb8ec: Add local plugin lifecycle commands, publish the plugin APIs in TypeDoc, and include an auditable community plugin template and dog-food runbook.
- 80edf03: Add the stable Memory CLI and bounded, untrusted pinned-memory PromptComposer provider.

### Patch Changes

- c05ab16: Add the L1 user documentation site and release acceptance records for Anthropic dog-food and human sign-off.
- c6e1d99: Replace artifact-based milestone checkmarks with an evidence-gated R0–R6 roadmap and frozen capability traceability baseline.
- 7c57d3f: Keep the CLI open in interactive chat after selecting and restoring a saved session.
- af49eb6: Add an auditable L1 final-verification runbook covering candidate freeze,
  four-target evidence, real Anthropic dog-food, human sign-off, and publication
  boundaries.
- 7d36404: Connect masked Anthropic login, encrypted credential storage, logout, strict doctor auth status,
  and a clearly labeled mock-only L1 pre-flight record.
- 02ebe86: Reject common provider credentials, authorization values, JWTs, and credential URIs across every Memory write surface before persistence.
- 5a1dc6c: Document the independent L1 readiness audit, target-specific sandbox evidence,
  and release blockers without claiming publication.
- f5d0ae2: Add Oxlint and Oxfmt checks, validate workspace TypeScript output directories, keep source imports extensionless, and add runtime JavaScript extensions to emitted ESM during builds.
- 040416f: Add a no-secret process-level R1 gate for the built JSON and no-TUI CLI roots.
- 5ad88e9: Add TypeDoc-backed API documentation, Renovate policy, Changesets release automation, and an evidence-accurate L2 release checklist.
- Updated dependencies [322c399]
- Updated dependencies [7cbaab5]
- Updated dependencies [ef83e9a]
- Updated dependencies [7472330]
- Updated dependencies [0fdd2db]
- Updated dependencies [51a8d26]
- Updated dependencies [bca787c]
- Updated dependencies [3f92c86]
- Updated dependencies [b2851d5]
- Updated dependencies [d90cf18]
- Updated dependencies [b90729e]
- Updated dependencies [3a6b644]
- Updated dependencies [340adfc]
- Updated dependencies [d048c24]
- Updated dependencies [5e3e011]
- Updated dependencies [110ceb6]
- Updated dependencies [3d5fb0e]
- Updated dependencies [8edb498]
- Updated dependencies [5c195aa]
- Updated dependencies [2d72f45]
- Updated dependencies [7a96f71]
- Updated dependencies [1e38fa8]
- Updated dependencies [e6f71f1]
- Updated dependencies [b34e712]
- Updated dependencies [1dafc88]
- Updated dependencies [22375da]
- Updated dependencies [e9b0aea]
- Updated dependencies [6ce20ca]
- Updated dependencies [823ad19]
- Updated dependencies [976eb21]
- Updated dependencies [911e807]
- Updated dependencies [5a4987c]
- Updated dependencies [cf93b8c]
- Updated dependencies [54d0d7a]
- Updated dependencies [ec4d987]
- Updated dependencies [e562b07]
- Updated dependencies [41fbb46]
- Updated dependencies [0ec7999]
- Updated dependencies [3780728]
- Updated dependencies [c16ea41]
- Updated dependencies [7d36404]
- Updated dependencies [4bb00af]
- Updated dependencies [99c77bf]
- Updated dependencies [344f874]
- Updated dependencies [4b4f0ac]
- Updated dependencies [568cb92]
- Updated dependencies [c22ea6d]
- Updated dependencies [3750319]
- Updated dependencies [5a9f08f]
- Updated dependencies [4067e1e]
- Updated dependencies [6c2bed5]
- Updated dependencies [0cc9b4c]
- Updated dependencies [8521920]
- Updated dependencies [e43cf9d]
- Updated dependencies [02ebe86]
- Updated dependencies [eeca5e1]
- Updated dependencies [4bdee12]
- Updated dependencies [d8d712d]
- Updated dependencies [e87079f]
- Updated dependencies [b69a471]
- Updated dependencies [d631d20]
- Updated dependencies [d348244]
- Updated dependencies [cadb8ec]
- Updated dependencies [3816925]
- Updated dependencies [5cc5254]
- Updated dependencies [4842243]
- Updated dependencies [01ffdbd]
- Updated dependencies [ad4613e]
- Updated dependencies [84c87cb]
- Updated dependencies [f4e0e08]
- Updated dependencies [80edf03]
  - @volund/tools@0.1.0
  - @volund/storage@0.1.0
  - @volund/native-bridge@0.1.0
  - @volund/ui@0.1.0
  - @volund/plugin-sdk@0.1.0
  - @volund/plugin-runtime@0.1.0
  - @volund/router@0.1.0
  - @volund/shared@0.1.0
  - @volund/core@0.1.0
  - @volund/provider-kit@0.1.0
  - @volund/auth@0.1.0
  - @volund/config@0.1.0
  - @volund/context@0.1.0
  - @volund/permission@0.1.0
  - @volund/telemetry@0.1.0
  - @volund/tool-kit@0.1.0
  - @volund/provider-anthropic@0.1.0
  - @volund/subagent@0.1.0
  - @volund/skills-runtime@0.1.0
