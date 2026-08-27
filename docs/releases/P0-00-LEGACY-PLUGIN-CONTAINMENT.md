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
| startup with a stale `enabled:true` record                 | read-time effective-disabled projection; source file is not rewritten   |                     0 |
| root, resumed, noninteractive, or child runner creation    | no `PluginRuntime` composition or load call                             |                     0 |
| legacy Memory-policy hooks                                 | runtime absent; ordinary Memory writes continue without plugin dispatch |                     0 |

The production composition fence rejects `PluginRuntime`, `loadEnabled`, legacy host test seams, and
activation calls across production CLI sources. `PluginManager` and `PluginRuntime` are permanently
deny-only: the published package contains only its production `index` entrypoint and no authority,
`internal/`, `test-only/`, or test artifact. There is no environment, config, constructor argument,
or condition export that can reopen legacy execution.

## Safe operations retained

`plugin list`, `plugin doctor`, `plugin disable`, and `plugin uninstall` remain available. Both
plugin doctor and general doctor disclose `available:false`, the typed code, and the explicit reopen
condition. List text labels every retained record `disabled (legacy runtime unavailable)`; list JSON
preserves the stored fields and adds structured `availability` plus `reasonCode`. Install never
creates a production record; direct production-manager install is denied. Parseable stale records
are projected disabled without rewriting `plugins.json`; the concurrency-safe Catalog migration is
owned by CAT-01/02. A malformed state file produces the same stable typed fail-closed diagnostic,
cannot reach a host, and does not block sessions or ordinary Memory. Doctor parses only a canonical,
regular manifest through a bounded 1 MiB read and caps permission metadata; it never loads a bundle.
Every plugin `--json` failure emits exactly `error` then `final` on stdout with empty stderr.

## Verification commands

```text
pnpm --filter @volund/plugin-runtime test
pnpm --filter volund-cli test
pnpm typecheck
pnpm verify:error-codes
pnpm check:event-schemas
pnpm verify:config-docs
node --test scripts/verify-plugin-runtime-packlist.test.mjs
pnpm lint
pnpm format:check
git diff --check
```

Package tests exercise data-only capability contracts and `VolundBridge` behavior directly; no test
authority or executable legacy host is shipped. Production integration covers install/enable deny,
read-time effective-disabled projection with no rewrite, malformed-state containment, Memory-policy
dormancy, safe cleanup operations, exact CLI machine/text output, bounded doctor disclosure, and the
actual npm pack dry-run boundary.
