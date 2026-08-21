# P0-00 Legacy plugin containment evidence

Status: implemented on the commit containing this document; no publish/reopen is authorized.

## Claim

Production legacy v1 plugin install, enable, activation, and Memory-policy hosting are temporarily
unavailable. This containment is independent of Manifest v2 and Catalog schemas. Reopen requires
CAT-01/02, ABI-R1 production verification, and an explicit security review.

Stable typed reason: `plugin_legacy_activation_unavailable`.

## Bypass accounting

| Surface                                                    | Production result                                                       | Executable host count |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------: |
| CLI/API install, including a nonexistent or swapped source | deny before inspect/copy/approval                                       |                     0 |
| CLI/API enable without a verified Catalog receipt          | deny before persisted state mutation                                    |                     0 |
| startup with a stale `enabled:true` record                 | atomic migration to `enabled:false`                                     |                     0 |
| root, resumed, noninteractive, or child runner creation    | no `PluginRuntime` composition or load call                             |                     0 |
| legacy Memory-policy hooks                                 | runtime absent; ordinary Memory writes continue without plugin dispatch |                     0 |

The production composition fence rejects `PluginRuntime`, `loadEnabled`, legacy host test seams, and
activation calls in `apps/cli/src/runtime.ts`. The only executable v1 path is
`packages/plugin-runtime/src/test-only/legacy-harness.ts`; it is absent from package exports and has
no environment or config switch.

## Safe operations retained

`plugin list`, `plugin doctor`, `plugin disable`, and `plugin uninstall` remain available. Both
plugin doctor and general doctor disclose `available:false`, the typed code, and the explicit reopen
condition. List text labels every retained record `disabled (legacy runtime unavailable)`; list JSON
preserves the stored fields and adds structured `availability` plus `reasonCode`. Install never
creates a production record; direct production-manager install is denied; stale records are
persisted disabled. A malformed state file produces the same stable typed fail-closed diagnostic and
cannot reach a host.

## Verification commands

```text
pnpm --filter @apollo-code/plugin-runtime test
pnpm --filter apollo-code test
pnpm typecheck
pnpm verify:error-codes
pnpm check:event-schemas
pnpm verify:config-docs
pnpm lint
pnpm format:check
git diff --check
```

Package tests separately exercise the explicit legacy harness so containment does not hide v1
compatibility regressions. Production integration covers install/enable deny, old-state migration,
idempotent migration without a second rewrite, malformed-state containment, Memory-policy dormancy,
safe cleanup operations, exact CLI machine/text output, and doctor disclosure.
