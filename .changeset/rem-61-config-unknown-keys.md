---
'@volund/shared': minor
'@volund/config': minor
---

Config unknown-key policy (spec §8.3 / appendix C, r13-I4): full TOML `ConfigSchema` (strict zod objects + dynamic `provider.<name>` / `models.aliases.<alias>` catchalls), `configKeyRegistry` with per-key `projectOverride` annotations aligned to appendix C.2, and `projectOverrideFor`/`isProjectOverrideForbidden` helpers. `@volund/config` gains `validateConfig`/`loadTomlFile` (unknown key → warn + ignore with key + file; known-key type error → `config_invalid` with file + key + expected type) and switches §8.3.1 project filtering to the registry (router.allow_cross_provider_tool_use now project-overridable per C.2). CI-enforced via `scripts/verify-config-docs.mjs` (`pnpm verify:config-docs`) against the appendix C.2 table.
