# @volund/shared

## 0.2.0

### Minor Changes

- 5344f22: Config-provided auth (spec §8.4): `AuthManager` gains Layer 4 — user-level `~/.volund/config.toml` `[auth] <provider>_api_key` (explicit opt-in; project-level forbidden per §8.3.1) resolving after keychain/encrypted-file/env with `layer: 4` telemetry. `[auth] skipAuth = true` (user-level only) skips credential resolution entirely: requests go out without `x-api-key`, health/status report `skipped (auth.skipAuth)`, and the first skip emits `auth.credential.skipped`. `provider-anthropic`'s `CredentialPort` now allows `undefined` (header omitted); the CLI also wires `provider.anthropic.baseUrl` into `AnthropicClient` for gateway/proxy deployments. Registry + appendix C.2 rows added; `pnpm verify:config-docs` stays green.
- ad0e7b5: Centralize every cross-module error code in an `ErrorCodes` registry (`error-codes.ts`) covering
  `error.raised` contract codes from appendix B.2, plugin, memory, provider/router, CLI `--json`,
  transport `volund_*`, and testkit domains, with `ErrorCode` typing, appendix/normalized subsets,
  and a `pnpm verify:error-codes` drift check wired into the turbo `test` task so unregistered or
  zombie codes fail CI.
- 7d1147e: Add per-event payload zod schemas for the 19 EventBus events (spec appendix D): `EVENT_SCHEMAS` registry, shared envelope schema with UUIDv7 ids, and `eventEnvelopeFor(type)` replay validation. CI-enforced via `scripts/verify-event-schemas.mjs` against the §2.3 event table.
- 4ac2411: Config unknown-key policy (spec §8.3 / appendix C, r13-I4): full TOML `ConfigSchema` (strict zod objects + dynamic `provider.<name>` / `models.aliases.<alias>` catchalls), `configKeyRegistry` with per-key `projectOverride` annotations aligned to appendix C.2, and `projectOverrideFor`/`isProjectOverrideForbidden` helpers. `@volund/config` gains `validateConfig`/`loadTomlFile` (unknown key → warn + ignore with key + file; known-key type error → `config_invalid` with file + key + expected type) and switches §8.3.1 project filtering to the registry (router.allow_cross_provider_tool_use now project-overridable per C.2). CI-enforced via `scripts/verify-config-docs.mjs` (`pnpm verify:config-docs`) against the appendix C.2 table.
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

- 7ad5a34: Temporarily contain legacy plugin install and activation until Catalog v2 and the verified capability ABI can reopen them safely. Production manager/runtime paths are deny-only, stale approvals are projected disabled without a state rewrite, plugin machine errors follow the two-event NDJSON contract, and the published package excludes all test authority and legacy host seams.

## 0.1.0

### Minor Changes

- 340adfc: Add the L1 CLI and UI product shell with strict diagnostics, guarded workspace paths, sandbox disclosure, dangerous-mode warnings, and replaceable integration ports.
- e6f71f1: Add the versioned extension transport protocol, resource and cancellation contracts, and the canonical normalized error taxonomy with redacted serialization.
- 976eb21: Add the L1 tool, permission, context, prompt, session, configuration, credential, and local telemetry runtime.
- 344f874: Establish the L1 monorepo foundation, neutral provider and tool contracts, immutable session state, and the typed 17-event core bus.

### Patch Changes

- 02ebe86: Reject common provider credentials, authorization values, JWTs, and credential URIs across every Memory write surface before persistence.
