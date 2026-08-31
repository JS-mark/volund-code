# @volund/auth

## 0.2.0

### Minor Changes

- 5344f22: Config-provided auth (spec §8.4): `AuthManager` gains Layer 4 — user-level `~/.volund/config.toml` `[auth] <provider>_api_key` (explicit opt-in; project-level forbidden per §8.3.1) resolving after keychain/encrypted-file/env with `layer: 4` telemetry. `[auth] skipAuth = true` (user-level only) skips credential resolution entirely: requests go out without `x-api-key`, health/status report `skipped (auth.skipAuth)`, and the first skip emits `auth.credential.skipped`. `provider-anthropic`'s `CredentialPort` now allows `undefined` (header omitted); the CLI also wires `provider.anthropic.baseUrl` into `AnthropicClient` for gateway/proxy deployments. Registry + appendix C.2 rows added; `pnpm verify:config-docs` stays green.

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

- Updated dependencies [340adfc]
- Updated dependencies [e6f71f1]
- Updated dependencies [976eb21]
- Updated dependencies [344f874]
- Updated dependencies [02ebe86]
  - @volund/shared@0.1.0
