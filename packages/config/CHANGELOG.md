# @volund/config

## 0.2.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [5344f22]
- Updated dependencies [ad0e7b5]
- Updated dependencies [7ad5a34]
- Updated dependencies [7d1147e]
- Updated dependencies [4ac2411]
- Updated dependencies [9e969d3]
- Updated dependencies [a0eecf1]
  - @volund/shared@0.2.0

## 0.1.0

### Minor Changes

- 976eb21: Add the L1 tool, permission, context, prompt, session, configuration, credential, and local telemetry runtime.

### Patch Changes

- 0cc9b4c: Add the localhost-safe Ollama provider with endpoint-specific remote danger approval, NDJSON streaming, tools, capability probing, and project endpoint filtering.
- Updated dependencies [340adfc]
- Updated dependencies [e6f71f1]
- Updated dependencies [976eb21]
- Updated dependencies [344f874]
- Updated dependencies [02ebe86]
  - @volund/shared@0.1.0
