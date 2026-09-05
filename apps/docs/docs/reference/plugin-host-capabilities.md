# Plugin host capability matrix

> **Compatibility ABI:** `VolundBridge` and `VOLUND_BRIDGE_CAPABILITIES` are frozen v1 public
> identifiers. Volund CLI is the current product name. These identifiers remain unchanged until a
> versioned plugin ABI migration can preserve existing integrations.

> **Production containment:** this is the quarantined v1 compatibility/test matrix, not a current
> production availability claim. Legacy install, enable, activation, and Memory-policy hosting fail
> closed with `plugin_legacy_activation_unavailable` until Catalog v2 + the verified ABI pass an
> explicit security reopen review. Tests exercise data-only contracts and `VolundBridge` directly;
> no executable legacy host or test authority is published.

The executable source of truth is `VOLUND_BRIDGE_CAPABILITIES` in
`packages/plugin-runtime/src/index.ts`. CI verifies that it contains every leaf method from
`VolundBridge`, that every row has a test entry point, and that unsupported methods explain why.

| Namespace           | Methods                                                         | Status      | Test entry                                                                                                     |
| ------------------- | --------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| tools               | `register`, `unregister`                                        | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| hooks               | `on`, `off`, `kv.get`, `kv.set`, `kv.delete`, `kv.clear`        | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| commands            | `register`                                                      | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| prompt              | `contribute`, `revoke`                                          | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| session             | `getMessages`, `getUsage`, `on`                                 | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| fs                  | `readFile`, `writeFile`, `exists`, `glob`, `stat`               | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| process             | `exec`                                                          | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| http                | `fetch`                                                         | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| ui                  | `confirm`, `prompt`, `pick`, `notify`                           | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| storage             | `get`, `set`, `delete`                                          | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| memory              | `get`, `list`, `search`, `create`, `update`, `delete`, `export` | supported   | `index.test.ts#VolundBridge capability matrix`; production writes use Memory ACL/preWrite and local audit      |
| config              | `get`                                                           | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| log                 | `debug`, `info`, `warn`, `error`                                | supported   | `index.test.ts#VolundBridge capability matrix`                                                                 |
| low-level transport | `call`                                                          | unsupported | Direct in-process dispatch is deliberately rejected by `index.test.ts#VolundBridge capability matrix`          |
| provider/router     | `provider.register`                                             | unsupported | Declared by the provider-plugin design, but not exposed by `VolundBridge` yet; policy tests cover the boundary |
| provider auth       | `auth.getAuthHeaders`, `auth.getSigningEnvKeys`                 | unsupported | Declared by the provider-plugin design, but not exposed by `VolundBridge` yet; policy tests cover the boundary |

## Local v2 pipeline (current production — 2026-09 kernel)

The matrix above describes the quarantined legacy `BridgeRuntime`. The **current**
production pipeline is the local sandbox loader (`activateLocalPlugin` →
`volund-sandbox --run-plugin` + fd3 bridge → kernel contribution registry), where these
bridge methods are live today:

| Live method                                     | Effect                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands.register`                             | slash command into the session command registry                                                                                                                                                  |
| `ui.status.registerTab` / `registerSection`     | /status data tabs and sections                                                                                                                                                                   |
| `tools.register` / `tools.unregister`           | model-callable tools (auto-namespaced `plugin:<name>:`) into the kernel `tools` service; permissionSpec `{custom:{pluginTool}}` rides the unified permission chain; output is untrusted-wrapped  |
| `hooks.on`                                      | lifecycle subscriptions; `preToolUse`/`postToolUse` run through the ToolExecutor dispatch hook (first HookResult wins, fail-open), `sessionStart`/`sessionEnd` are broadcast from session events |
| `session.on`                                    | alias of `hooks.on` for session lifecycle events                                                                                                                                                 |
| `prompt.contribute` / `prompt.revoke`           | static fragments into the per-session composer (`plugin:<name>:` id namespace, priority default 600)                                                                                             |
| `plugins.list` extension                        | `domains` group: first-party tool domains (visible + toggleable in /plugins and `volund plugins builtin`)                                                                                        |
| `env.getEffective`, `session.getUsage`, `log.*` | host data/diagnostics as before                                                                                                                                                                  |

Still denied in the local pipeline: `fs.*`, `exec`, `http.fetch`, `storage.*`, `memory.*`,
`session.getMessages`, `session.on`-style push for non-session events, `call`, and
`provider.register` / `auth.*` (declared surfaces; awaiting the provider-plugin host).
See §19.0 of the design spec for the shipped/pending map and the TCB boundary
(sandbox and session store are never plugin-replaceable).

A complete tested example lives at `examples/plugins/volund-plugin-demo/` (JS) and
`examples/plugins/volund-plugin-ts-demo/` (TypeScript entry).

The current CI gate verifies containment instead of claiming a host lifecycle E2E: production
composition has zero legacy load/start references, deny-only manager/runtime tests remain green, and
an actual `pnpm pack --dry-run --json` proves that no tests, internal authority, or test-only files are
published. ABI-R1 must introduce a new verified execution E2E before any production reopen.

Memory access is separately declared in `manifest.permissions.memory` and in the Volund RPC
allowlist. Read scopes are explicit (`workspace`, `project`, and/or `session`); search and export
require both their capability flag and read access to the requested scope. Writes require
`write: true` plus read access to the target scope, are re-scoped by the host to the current local
workspace/project/session, and cannot supply trusted provenance.
The host records metadata-only audit events. Memory export contains attachment references, never
attachment bytes, and no Memory bridge method uploads, shares, or performs network access.

## Quarantined legacy Memory hook contract

The following is the retained v1 compatibility contract. P0-00 removed its production composition:
no process-wide Memory-policy runtime starts, stale approvals are interpreted as disabled, and ordinary Memory
writes do not dispatch third-party hooks. Catalog/ABI migration must re-verify or retire each rule
before any production reopen.

- `memory.preWrite` runs for every create, update, delete, pin, unpin, and attachment-state mutation.
  The built-in validation and secret detector run first; policy runs before fact, index, or import
  journal mutation. Import preflight uses `phase: "validation"`; the committing call uses
  `phase: "commit"`.
- Only hooks whose declared Memory read scopes contain the exact event scope are invoked. Candidate
  content is available only on `memory.preWrite` after the secret guard accepts it.
  `memory.postWrite` and `memory.deleted` are metadata-only.
- Hook priority is a safe integer from -100 through 100. Hooks run by descending priority and then
  registration order. The first veto short-circuits the chain. Its sanitized,
  240-character-bounded reason is returned as `memory_hook_veto`.
- A pre-write exception, activation failure, or 10-second hook timeout fails closed as
  `memory_hook_failed`. A hook attempting a nested Memory write fails immediately; recursive policy
  evaluation is never entered.
- `memory.postWrite` runs after facts and the search index commit. `memory.deleted` follows it only
  for the first successful transition to a record tombstone. Observer failures are audited but
  cannot turn an already durable write into a reported failure.
- Direct bridge and policy unit tests verify retained data contracts without starting a host.
  Production does not create `memory/hook-audit.jsonl` while containment is active.
