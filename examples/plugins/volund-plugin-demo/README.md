# volund-plugin-demo

示例插件：演示插件一等公民的**全部五种贡献面**。本目录同时是文档和被测试保护的
可运行代码（`apps/cli/src/example-plugins.test.ts` 经真实沙箱链路加载并验证它）。

## 插件的形态

```
volund-plugin-demo/
├── manifest.json   # 名字（volund-plugin-* 前缀）、入口、engines、权限声明
└── index.mjs       # 单文件 ESM；导出 activate(volund)
```

`activate(volund)` 收到的 `volund` 是宿主侧受权限 guard 的桥对象——插件代码
全程跑在 `volund-sandbox --run-plugin` 子进程里，主进程不 `import()` 插件。

## 贡献面速查

| 注册调用 | 效果 | 权限 |
|---|---|---|
| `volund.tools.register({ name, description, inputSchema, handler })` | 模型可调用工具；名字必须 `plugin:<manifest.name>:` 前缀；输出被 `<untrusted>` 包裹 | `tools.register` |
| `volund.hooks.on('preToolUse' \| 'postToolUse' \| …15 种, handler)` | handler 返回 `{veto, reason}` 拦下工具调用、`{value}` 改写入参/结果；错误 fail-open | `hooks.on` |
| `volund.prompt.contribute({ id, content, priority? })` | 静态 fragment 进每会话 system prompt（id 自动加 `plugin:<名>:` 前缀，priority 缺省 600） | `prompt.contribute` |
| `volund.session.on('sessionStart' \| 'sessionEnd', handler)` | 会话生命周期事件（payload `{schemaVersion, sessionId}`） | `session.read` |
| `volund.commands.register({ name, description, handler })` | 斜杠命令；返回字符串进 transcript，返回 `{kind:'list'/…}` 纯数据视图渲染成面板 | `commands.register` |

## 两种作者风格

**零依赖（本示例）**——单文件 `.mjs`，直接在 handler 里写业务，工具名宿主会自动收敛到
`plugin:<manifest.name>:` 命名空间（写裸名 `word-count` 也可以）：

```js
await volund.tools.register({
  name: 'word-count',                      // 宿主 → plugin:volund-plugin-demo:word-count
  description: 'Count words, characters and lines',
  handler: async (input) => ({ words: 0 }),
})
```

**TypeScript + SDK 助手**（与 dsh 的 `defineTool` 同工效）——TS 编译成单文件 ESM 后同链路装载：

```ts
import { definePlugin, defineTool } from '@volund/plugin-sdk'

export default definePlugin({
  activate(volund) {
    volund.tools.register(
      defineTool({
        name: 'word-count',
        description: 'Count words, characters and lines',
        handler: async (input) => ({ words: 0 }),
      }), // inputSchema 可省，缺省 { type: 'object' }
    )
  },
})
```

## 运行

开发插件目录自动发现（自动批准 + 启用）：

```bash
ln -s "$PWD/examples/plugins/volund-plugin-demo" ~/.volund/plugins-dev/
# 或指定额外目录：
VOLUND_DEV_PLUGINS="$PWD/examples/plugins" volund
```

进 REPL 后：

- `/demo` —— 查看本插件贡献了什么；
- 让模型"数一下这段文字有多少词"——它会调用 `word-count` 工具（首次调用会走
  权限确认，允许后本会话内免批）；
- 执行 `echo demo-block-me` —— preToolUse hook 会把它拦下（transcript 显示
  `blocked by hook`）。

禁用/卸载：dev 插件目录归开发者管理，删目录或从 `~/.volund/plugins-dev/` 移除
符号链接即可；会话中途移除时已注册的贡献工具保留到会话结束（调用会响亮报错）。
