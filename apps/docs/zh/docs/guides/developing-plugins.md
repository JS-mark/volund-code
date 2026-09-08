# 开发插件

插件是一等扩展：一个目录 + 一份 `manifest.json` + 一个导出 `activate(volund)` 的单文件入口。插件代码始终跑在 `volund-sandbox` 子进程里——主进程从不 `import()` 它——所有能力都经受权限 guard 的桥（`volund.tools`、`volund.commands`…）访问，插件只能做 manifest 里声明过的事。

## 插件的形态

```
my-plugin/
├── manifest.json
└── index.mjs        # 或 index.ts（TypeScript，见下文）
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

| 字段                 | 规则                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `name`               | 必须以 `volund-plugin-` 开头；工具/prompt/命令 ID 都挂在它下面做命名空间。              |
| `main`               | 单文件 ESM 入口。零依赖 JS 用 `.mjs`/`.js`；`.ts` 走 Node 类型擦除装载（Node ≥ 22.6）。 |
| `engines.volund`     | SemVer 范围，装载时校验。                                                               |
| `permissions.volund` | 能力声明，deny-by-default——没声明的调用一律权限报错。                                   |

入口保持**单文件、零依赖**：沙箱里没有 `node_modules`，装载期也没有网络/文件系统可用。类型一律 `import type`——类型导入会被擦除，运行时零成本。

## 快速开始（dev 通道）

```sh
# 约定目录自动发现，自动批准 + 启用：
ln -s "$PWD/my-plugin" ~/.volund/plugins-dev/volund-plugin-word-count
# 或追加额外目录（逗号分隔）：
VOLUND_DEV_PLUGINS="$PWD/my-plugin" volund
```

最小插件——一个模型可调用的工具：

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

工具名写**裸名**即可——宿主自动收敛到 `plugin:<manifest.name>:` 命名空间，插件不可能抢注内置或 MCP 工具名。模型首次调用走正常权限确认，允许一次后会话内免批。工具输出按不可信内容包裹后才交给模型。

## 贡献面

| 注册调用                                     | 效果                                 | 权限                |
| -------------------------------------------- | ------------------------------------ | ------------------- |
| `volund.tools.register(spec)`                | 模型可调用工具                       | `tools.register`    |
| `volund.hooks.on(event, handler)`            | 生命周期 hook（15 种事件）           | `hooks.on`          |
| `volund.prompt.contribute(fragment)`         | 静态 fragment 进每会话 system prompt | `prompt.contribute` |
| `volund.session.on(event, handler)`          | `sessionStart` / `sessionEnd` 事件   | `session.read`      |
| `volund.commands.register(spec)`             | 斜杠命令                             | `commands.register` |
| `volund.ui.status.registerTab/Section(spec)` | `/status` 面板页签与分区             | `ui.status`         |

**工具**——见上文快速开始。`inputSchema` 可省（缺省空 object schema）。

**Hook**——`preToolUse` / `postToolUse` 接在工具执行器上：返回 `{ veto: true, reason }` 在权限检查之前拦下调用（transcript 显示 `blocked by hook`），返回 `{ value }` 改写工具入参或结果；其余情况——包括抛错——一律 fail-open，hook 异常不会弄断工具调用链。

```js
await volund.hooks.on('preToolUse', (payload) => {
  if (payload?.tool === 'Bash' && payload?.input?.command.includes('rm -rf /'))
    return { veto: true, reason: 'catastrophic command blocked' }
})
```

其余事件（`prePrompt`、`postPrompt`、`pluginEnabled`、`memory.*`…）是已声明面；当前实际广播的是 `sessionStart` / `sessionEnd`。

**Prompt fragment**——`{ id, content, priority? }`。`id` 自动加 `plugin:<名>:` 命名空间；priority 缺省 600（skills 是 800，内置 1000）。仅静态文本，每会话组装一次。

**会话事件**——`volund.session.on('sessionStart' | 'sessionEnd', handler)` 收到 `{ schemaVersion, sessionId }`；它是 hooks 通道对会话生命周期的别名。

**斜杠命令**——`{ name, order?, description, handler }`。返回字符串 → 作为系统消息进 transcript；返回纯数据视图 → `{ kind: 'list', title, entries }` 渲染成可搜索列表面板，`{ kind: 'tabs', title, tabs }` 渲染成多页签面板（内置 `/plugins` 命令就是这样实现的）。`order` 决定 `/help` 与命令面板里的排序。

**状态页签**——`registerTab({ id, label, render })` 往 `/status` 面板加活页签；`render` 是面板打开时经桥回调的函数，数据实时取。完整契约见仓库内 `examples/plugins/plugin-status-demo/`。

## TypeScript 作者

TS 可以直接作入口：manifest 写 `"main": "index.ts"`，宿主以 Node `--experimental-strip-types` 装载（Node ≥ 22.6）。只支持可静态擦除的子集——interface / 类型标注 / 泛型可用；**enum / namespace / 参数属性不支持**，需要时请自行编译成 JS。

用 SDK 给桥标类型，走 type-only 导入（零运行时依赖）：

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

`@volund/plugin-sdk` 的 `definePlugin` / `defineTool` 是带完整类型的恒等助手；值导入也可以，但那样插件目录就得能解析 `node_modules`（只有编译后的插件在沙箱外可行）。推荐 `import type`。

## 分发与生命周期

| 通道 | 来源                                            | 生命周期                                      |
| ---- | ----------------------------------------------- | --------------------------------------------- |
| 内置 | 随产物分发（`apps/cli/plugins/`）               | 与产物同信任级，不可卸载                      |
| Dev  | `~/.volund/plugins-dev/` + `VOLUND_DEV_PLUGINS` | 自动批准并启用；删目录即卸载                  |
| 市场 | `~/.volund/plugins/`，从配置的市场索引安装      | 安装 → inspect → approve → enable；支持热卸载 |

市场在 `~/.volund/config.toml` 里配置：

```toml
[plugins]
market = "https://your-registry.example/volund-plugins/index.json"
```

市场插件的每个文件在下载时做 digest 校验、每次激活时复验；安装后不激活，需要用完整权限哈希显式 approve，再 enable：

```sh
volund plugin install <name>
volund plugin inspect <name>            # 显示权限哈希
volund plugin approve <name> <hash>
volund plugin enable <name>
```

同一套生命周期在 REPL 里经 `/plugins` 使用（浏览 builtin / dev / market，install、inspect、approve、enable、disable、uninstall）；第一方工具域也在面板里可见可切换。

## 示例与参考

- `examples/plugins/volund-plugin-demo/` — 一个插件覆盖全部贡献面（有测试保护）
- `examples/plugins/volund-plugin-ts-demo/` — TS 入口示例
- `examples/plugins/plugin-status-demo/` — `/status` 面板页签
- `apps/cli/plugins/` — 内置插件（`/env`、`/plugins`），TS 源码
- [插件宿主能力矩阵](/zh/docs/reference/plugin-host-capabilities) — 哪些桥方法当前已开通
- [主题与插件 UI](/zh/docs/reference/themes-and-plugin-ui)
