---
'@apollo-code/auth': minor
'@apollo-code/provider-anthropic': minor
'@apollo-code/shared': minor
'apollo-code': minor
---

Config-provided auth (spec §8.4): `AuthManager` gains Layer 4 — user-level `~/.apollo/config.toml` `[auth] <provider>_api_key` (explicit opt-in; project-level forbidden per §8.3.1) resolving after keychain/encrypted-file/env with `layer: 4` telemetry. `[auth] skipAuth = true` (user-level only) skips credential resolution entirely: requests go out without `x-api-key`, health/status report `skipped (auth.skipAuth)`, and the first skip emits `auth.credential.skipped`. `provider-anthropic`'s `CredentialPort` now allows `undefined` (header omitted); the CLI also wires `provider.anthropic.baseUrl` into `AnthropicClient` for gateway/proxy deployments. Registry + appendix C.2 rows added; `pnpm verify:config-docs` stays green.
