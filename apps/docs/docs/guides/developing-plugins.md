# Developing plugins

Plugins are first-class extensions: a directory with a `manifest.json` and a single-file entry that exports `activate(volund)`. Plugin code always runs inside the `volund-sandbox` subprocess — the host process never imports it — and every capability is reached through a permission-guarded bridge (`volund.tools`, `volund.commands`, …), so a plugin can only do what its manifest declares.

## Anatomy

```
my-plugin/
├── manifest.json
└── index.mjs        # or index.ts (TypeScript, see below)
```

```json
{
  "name": "volund-plugin-word-count",
  "version": "0.1.0",
  "type": "module",
  "main": "index.mjs",
  "engines": { "volund": "^0.1.0" },
  "permissions": { "volund": ["tools.register", "log.write"] }
}
```

| Field                | Rules                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`               | Must start with `volund-plugin-`. Tool/prompt/command IDs are namespaced under it.                                   |
| `main`               | Single-file ESM entry. `.mjs`/`.js` for zero-dependency JS; `.ts` is loaded via Node's type stripping (Node ≥ 22.6). |
| `engines.volund`     | SemVer range checked at load time.                                                                                   |
| `permissions.volund` | Deny-by-default capability list. Anything not declared fails with a permission error.                                |

Keep the entry **single-file and dependency-free**: the sandbox has no `node_modules`, and network/filesystem access during loading is not a thing. Use `import type` for types — type-only imports are erased and cost nothing at runtime.

## Quick start (dev channel)

```sh
# Auto-discovered, auto-approved and enabled:
ln -s "$PWD/my-plugin" ~/.volund/plugins-dev/volund-plugin-word-count
# Or point at extra directories (comma-separated):
VOLUND_DEV_PLUGINS="$PWD/my-plugin" volund
```

Minimal plugin — a tool the model can call:

```js
export async function activate(volund) {
  await volund.tools.register({
    name: 'word-count', // → plugin:volund-plugin-word-count:word-count
    description: 'Count words, characters and lines of the given text',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    handler: async (input) => ({
      words: String(input?.text ?? '')
        .split(/\s+/)
        .filter(Boolean).length,
    }),
  })
  await volund.log.info('word-count activated')
}
```

Tool names are written **bare** — the host converges them into the `plugin:<manifest.name>:` namespace, so a plugin can never shadow built-in or MCP tools. The first model invocation goes through the normal permission confirmation; after allowing it once, it stays approved for the session. Tool output is wrapped as untrusted content before it reaches the model.

## Contribution surfaces

| Registration                                 | Effect                                           | Permission          |
| -------------------------------------------- | ------------------------------------------------ | ------------------- |
| `volund.tools.register(spec)`                | Model-callable tool                              | `tools.register`    |
| `volund.hooks.on(event, handler)`            | Lifecycle hook (15 events)                       | `hooks.on`          |
| `volund.prompt.contribute(fragment)`         | Static fragment into every session system prompt | `prompt.contribute` |
| `volund.session.on(event, handler)`          | `sessionStart` / `sessionEnd` events             | `session.read`      |
| `volund.commands.register(spec)`             | Slash command                                    | `commands.register` |
| `volund.ui.status.registerTab/Section(spec)` | `/status` panel tabs and sections                | `ui.status`         |

**Tools** — see the quick start above. `inputSchema` may be omitted (defaults to an empty object schema).

**Hooks** — `preToolUse` and `postToolUse` run through the tool executor: returning `{ veto: true, reason }` blocks the call before permission checking (the reason shows up as `blocked by hook`), returning `{ value }` rewrites the tool input or result. Anything else — including a thrown error — is fail-open. Hook errors never break the tool call chain.

```js
await volund.hooks.on('preToolUse', (payload) => {
  if (payload?.tool === 'Bash' && payload?.input?.command.includes('rm -rf /'))
    return { veto: true, reason: 'catastrophic command blocked' }
})
```

Other events (`prePrompt`, `postPrompt`, `pluginEnabled`, `memory.*`, …) are declared surfaces; `sessionStart`/`sessionEnd` are the ones broadcast today.

**Prompt fragments** — `{ id, content, priority? }`. The `id` is auto-namespaced with `plugin:<name>:`; default priority is 600 (skills are 800, built-ins 1000). Static text only, evaluated once per session.

**Session events** — `volund.session.on('sessionStart' | 'sessionEnd', handler)` receives `{ schemaVersion, sessionId }`. It is an alias of the hooks channel for session lifecycle.

**Slash commands** — `{ name, order?, description, handler }`. Return a string to append a system message to the transcript, or a pure-data view: `{ kind: 'list', title, entries }` renders a searchable list panel, `{ kind: 'tabs', title, tabs }` a tabbed panel (this is what the built-in `/plugins` command returns). `order` sorts commands in `/help` and the command palette.

**Status tabs** — `registerTab({ id, label, render })` adds a live tab to the `/status` panel; `render` is a bridge callback invoked when the panel opens, so data stays fresh. See `examples/plugins/plugin-status-demo/` in the repo for the full contract.

## TypeScript authoring

TypeScript can be the entry directly: set `"main": "index.ts"` and the host loads it with Node's `--experimental-strip-types` (Node ≥ 22.6). Only the statically-erasable subset is supported — interfaces, type annotations and generics are fine; **enums, namespaces and parameter properties are not** — compile to JS yourself if you need them.

Type the bridge with the SDK, using a type-only import (zero runtime dependency):

```ts
import type { VolundBridge } from '@volund/plugin-sdk'

export async function activate(volund: VolundBridge): Promise<void> {
  await volund.tools.register({
    name: 'word-count',
    description: 'Count words',
    handler: async (input) => ({ words: 3 }),
  })
}
```

`definePlugin` / `defineTool` from `@volund/plugin-sdk` are identity helpers with full types; importing them as values works too, but then the plugin directory must resolve `node_modules` (only viable outside the sandbox for compiled plugins). Prefer `import type`.

## Distribution and lifecycle

| Channel | Source                                                   | Lifecycle                                                     |
| ------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Builtin | Shipped with the artifact (`apps/cli/plugins/`)          | Always trusted, cannot be uninstalled                         |
| Dev     | `~/.volund/plugins-dev/` + `VOLUND_DEV_PLUGINS`          | Auto-approved and enabled; managed by removing the directory  |
| Market  | `~/.volund/plugins/`, installed from a configured market | Install → inspect → approve → enable; hot-uninstall supported |

Configure a market in `~/.volund/config.toml`:

```toml
[plugins]
market = "https://your-registry.example/volund-plugins/index.json"
```

Every market file is digest-verified on download and re-verified on each activation; installs land inactive and need an explicit approve (with the exact permission hash) plus enable:

```sh
volund plugin install <name>
volund plugin inspect <name>            # shows the permission hash
volund plugin approve <name> <hash>
volund plugin enable <name>
```

The same lifecycle is available in the REPL via `/plugins` (browse builtin / dev / market, install, inspect, approve, enable, disable, uninstall). First-party tool domains are visible and toggleable there too.

## Examples and reference

- `examples/plugins/volund-plugin-demo/` — every contribution surface in one plugin (protected by tests)
- `examples/plugins/volund-plugin-ts-demo/` — TypeScript entry
- `examples/plugins/plugin-status-demo/` — `/status` panel tabs
- `apps/cli/plugins/` — built-in plugins (`/env`, `/plugins`), TS sources
- [Plugin host capability matrix](/docs/reference/plugin-host-capabilities) — which bridge methods are live today
- [Themes and plugin UI](/docs/reference/themes-and-plugin-ui)
