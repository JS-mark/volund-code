# Volund CLI API

> **Canonical identity:** Public TypeScript symbols, schema IDs, environment variables, manifest
> keys, command names, package names, and on-disk paths use the `volund` / `VOLUND` spellings.

This reference is generated from the exported TypeScript API. For end-user commands and examples,
use `volund` and the `@volund/cli` npm package.

## Modules

The API is split by package; each entry links to its generated reference (kept in English —
a curated Chinese landing page lives at `/zh/api/README`):

| Module                                                   | Description                                       |
| -------------------------------------------------------- | ------------------------------------------------- |
| [auth](/api/auth/src/README)                             | Credential storage, OAuth (incl. McpOAuthError)   |
| [config](/api/config/src/README)                         | config.toml loading and validation                |
| [context](/api/context/src/README)                       | Session context                                   |
| [core](/api/core/src/README)                             | Kernel core                                       |
| [native-bridge](/api/native-bridge/src/README)           | Native sandbox / search / fs binary bridge        |
| [permission](/api/permission/src/README)                 | Permission decisions and modes                    |
| [plugin-runtime](/api/plugin-runtime/src/README)         | Plugin host, manifest validation, sandbox profile |
| [plugin-sdk](/api/plugin-sdk/src/README)                 | Plugin SDK types (manifest, inventory)            |
| [provider-anthropic](/api/provider-anthropic/src/README) | Anthropic provider                                |
| [provider-kit](/api/provider-kit/src/README)             | Provider shared kit                               |
| [provider-openai](/api/provider-openai/src/README)       | OpenAI-compatible provider                        |
| [router](/api/router/src/README)                         | Model routing                                     |
| [shared](/api/shared/src/README)                         | Error codes, events, shared types                 |
| [skills-runtime](/api/skills-runtime/src/README)         | Skill discovery and install                       |
| [storage](/api/storage/src/README)                       | Storage layer                                     |
| [telemetry](/api/telemetry/src/README)                   | Telemetry sampling                                |
| [tool-kit](/api/tool-kit/src/README)                     | Tool shared kit                                   |
| [tools](/api/tools/src/README)                           | Built-in tools                                    |
| [ui](/api/ui/src/README)                                 | TUI components                                    |
