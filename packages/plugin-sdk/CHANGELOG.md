# @volund/plugin-sdk

## 0.1.0

### Minor Changes

- bca787c: Add permission-gated Memory plugin capabilities, attachment reference lifecycles, and local-only versioned import/export with dry-run conflict reports and crash rollback.
- 3f92c86: Add the plugin manifest, installation lifecycle, type-only authoring SDK, RPC guards, and the native sandbox plugin-host launch boundary.
- 2d72f45: Add local-only plugin registry trust metadata fixtures with pinned-source,
  signature, revocation, and bundle digest fail-closed verification.
- 1e38fa8: Connect enabled plugin Memory lifecycle hooks to the production composition root with scope-gated
  payloads, fail-closed vetoes and timeouts, recursion protection, metadata-only auditing, and
  post-commit lifecycle events shared by CLI, TUI, model, import, and Plugin write paths.
- 1dafc88: Add versioned theme tokens and permission-gated declarative plugin status-bar contributions with lifecycle cleanup and headless isolation.
- 3780728: Add the provider plugin registry, header-template authentication boundary, dedicated buffered streaming transport contract, and explicit plugin provider routing.
- eeca5e1: Add a fail-closed provider signing fixture contract with explicit approval, minimal temporary environment injection, cleanup, and log redaction helpers.
- f4e0e08: Add the complete permission-gated volund JSBridge API, ordered veto hooks, isolated hook KV, resource quotas, cancellation, redacted logging, and lifecycle cleanup.

### Patch Changes

- cadb8ec: Add local plugin lifecycle commands, publish the plugin APIs in TypeDoc, and include an auditable community plugin template and dog-food runbook.
- Updated dependencies [e6f71f1]
- Updated dependencies [976eb21]
- Updated dependencies [3780728]
- Updated dependencies [c16ea41]
- Updated dependencies [99c77bf]
- Updated dependencies [344f874]
- Updated dependencies [568cb92]
- Updated dependencies [3816925]
- Updated dependencies [01ffdbd]
  - @volund/provider-kit@0.1.0
