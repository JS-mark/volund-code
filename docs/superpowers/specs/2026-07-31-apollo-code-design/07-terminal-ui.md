> ↩ [返回索引 (README)](./README.md) · ← [上一章: §6d 测试基建 (6.13)](./06d-testkit.md) · [下一章: §8 会话与配置存储](./08-session-config.md) →

---

## §7 终端 UI (Ink)

本节定义 `packages/ui` 与 `apps/cli` 的边界。UI 是 core 事件的消费者。

### 7.1 设计目标

| 目标                | 具体含义                                                             |
|---------------------|----------------------------------------------------------------------|
| **只订阅不主导**    | UI 订阅 core 事件，只调 Runner 公开 API，不直接改状态                 |
| **流式友好**        | stream.delta 高频到达，UI 自 throttle 到 30fps                       |
| **响应式渲染**      | Ink（React for CLI）+ 局部 state 缓存 provider chunk                  |
| **可访问性**        | 支持无颜色终端 / 屏幕阅读器（结构化输出模式）                          |
| **可测试**          | UI 组件独立于 Runner 可 snapshot 测试                                 |

### 7.2 Ink 组件树

```
<App>
├─ <TopBar>                        # session id / cost / model / cwd / 后台 shell 计数徽标（r13-G2）
├─ <ScrollableTranscript>           # 消息列表
│   ├─ <MessageBlock role="user">
│   ├─ <MessageBlock role="assistant">
│   │   ├─ <TextPart>              # 逐字符流入
│   │   ├─ <ThinkingPart collapsed>
│   │   ├─ <ToolUsePart>
│   │   │   ├─ <ToolInvocationLine>
│   │   │   ├─ <PermissionPrompt>  # 弹窗态
│   │   │   └─ <ToolResultLine>
│   │   └─ ...
│   └─ ...
├─ <StatusLine>                    # "streaming..." / "waiting tool..." / "compacting..."
└─ <InputBox>                       # 用户输入，支持多行 + 附件粘贴 + slash 命令
```

**订阅**（UI 层）：
- `stream.delta` → 追加 chunk 到当前 assistant message 的局部 state
- `stream.completed` → 提交到显示层
- `tool.permission_asked` → 弹 `<PermissionPrompt>`
- `router.switched` → toast "已切换到 GPT-4o"
- `context.compacted` → 提示 "已压缩 N 条消息"

**主动调用 Runner**：
- 用户回车 → `runner.sendUserMessage(text, attachments)`
- Ctrl+C → `runner.interrupt()`
- Slash 命令 → dispatch 到对应 handler

### 7.3 流式背压策略

**问题**：`stream.delta` 每 token 一次，可达 100+ Hz；直接每次 setState 会炸 React。

**决策（v1）**：**UI 侧自 throttle**。

```
// packages/ui/src/hooks/useStreamBuffer.ts
- 每次 stream.delta 到达时把 chunk 推入 ref buffer
- 通过 requestAnimationFrame 或 setInterval(33ms) 触发一次 flush 到 useState
- Ink 走 React 渲染树，30fps 足够顺滑
```

**上游不做背压**：
- Core 不感知 UI 渲染速度
- Provider stream 全速消费（不阻塞 provider）
- Core 只做一件事：把 chunk emit 到 event bus，就完了
- 好处：Runner / core 逻辑纯净；坏处：极端场景 UI 抓不到每个 delta（可接受，因为只是显示）

**替代方案（备用，v2 再评估）**：
- Reactive Streams 加背压 → 复杂度高，收益小
- Provider 侧 throttle → provider 无法感知 UI

### 7.3a 信号处理（Ctrl+C / Ctrl+Z / SIGTSTP）

- **Ctrl+C（SIGINT）**：`runner.interrupt()` → `turnAbort.abort()` → 当前 turn 中止（§2.4 B3）；session 存活，用户可继续输入。
- **Ctrl+Z（SIGTSTP）/ 挂起**：**v1 不特殊处理**，按 OS 默认 SIGTSTP 行为（Unix 挂起进程）。已知限制（REVIEW-r6 P2-1）：挂起期间 native handle 不主动释放、provider stream 连接可能被对端超时关闭、stdin 状态恢复不确定。**建议用户避免在 turn 进行中 Ctrl+Z**；若需暂停用 Ctrl+C 中止 turn 后再挂起。完整 SIGTSTP 句柄（释放 handle / 暂停 stream / 恢复）推 v2。
- **SIGTERM / SIGHUP**：graceful shutdown → `session.ended` → flush storage → 退出。

### 7.4 Permission 弹窗渲染

- `permission.setPromptHandler((req) => Promise<Decision>)` 由 apps/cli 在启动时注入
- ui 内部实现：
  - 接到 request → 塞入内部队列
  - Ink 组件 `<PermissionPromptStack>` 每次显示队列头
  - 用户选择 → resolve 该 request 的 Promise → 弹下一个
- **不同意选项**用键盘导航（arrow keys / y/n/s（session）/f（forever））
- **展示内容**：工具名、要访问的资源（path / command / url）、危险级别、"这次 / 会话 / 项目 / 永久" 四档
- 支持 `--yolo`（等价 `--dangerously-skip-permissions`）跳过所有弹窗

### 7.5 输入框（InputBox）

#### 7.5.1 基础

- 多行输入：Shift+Enter 换行，Enter 提交
- Slash 命令补全：`/` 前缀触发 popup（来源：内置 + 插件贡献 + skills）
- 历史：↑ / ↓ 翻历史输入（存到 `~/.apollo/history`，纯文本，见 §7.7 脱敏规则）

#### 7.5.2 附件（粘贴 / 拖拽）

InputBox 有三条附件入口，最终都归一为 `AttachmentRef`（§2.1.1）：

| 入口                     | 触发条件                                                | 归一化                                                |
|--------------------------|---------------------------------------------------------|-------------------------------------------------------|
| **粘贴文件路径**         | 剪贴板文本能被 `fs.realpath` 解析到 cwd 允许范围内的文件 | `AttachmentRef { kind: 'path', path, mime }`          |
| **拖拽文件**             | 终端 escape sequence（iTerm2 / Warp / WezTerm 支持）    | 同上                                                  |
| **粘贴剪贴板图片二进制** | 终端 image paste escape / OSC 52 / `Cmd+V` 二进制帧     | 主进程落盘 → `AttachmentRef { kind: 'blob', handle }` |

**剪贴板图片二进制流程**（L2 里程碑）：

1. UI 检测到 image paste escape（或系统级 clipboard access via native-bridge），拿到 PNG/JPEG bytes
2. UI 调 `native.attachments.stage(bytes, mime)` → native-bridge 落盘到 `~/.apollo/sessions/<sid>/attachments/<hash>.<ext>`，返回 `handle`
3. UI 在输入行内插入占位 chip：`[image: <hash-8>.png]`（不可编辑的原子 token）
4. 提交时 InputBox 把 chip 展开成 `ContentPart { type: 'image', source: { handle, kind: 'blob' }, mime }`
5. 会话结束 / attachment 被 context 压缩替换时，`native.release(handle)` 释放
6. 权限：`stage()` 首次调用弹一次 `allow-session`（防止误粘敏感截图，弹窗内显示尺寸 / mime，不显示内容）

**不支持的场景**（明确不做）：
- 终端**不支持** image paste escape 时不做 fallback 屏幕截图 —— 用户需先保存文件再拖拽
- 二进制附件**不进** `~/.apollo/history`（脱敏），历史里只留 chip 文本 `[image: <hash-8>.png]`

#### 7.5.3 `@` 前缀：统一 Picker（alias 置顶）

`@` 前缀在 apollo 中承担**两种能力**（引用文件 / 覆盖模型），r9 优化为**统一 picker + alias 置顶**——消除原来"先选模式再补全"的二步开销，对高频的 `@file` 操作恢复 claude-code 肌肉记忆。

**触发流程**（r9 重写）：

1. 用户键入 `@`，InputBox **直接进入统一 picker**（不弹模式选择 popup）。候选列表 = **前缀匹配的 model alias（置顶，⭐ 标 model）** + **文件候选（📄 标 file，跟在后）**：

   ```
   用户输入 @so 后，picker 候选（实时前缀过滤）：
   ┌ @ picker ──────────────────────────┐
   │ ⭐ sonnet          (model)          │ ← alias 顶部，前缀匹配 "so"
   │ ⭐ sonnet-4.5      (model)          │
   │ 📄 src/sonnet-config.ts            │ ← 文件候选跟后
   │ 📄 docs/sonnet-guide.md            │
   │ 📄 tests/sonnet.spec.ts            │
   └────────────────────────────────────┘
   [↑↓ move  Enter select  Tab 切换 type  Esc 退出]
   ```

2. **选择规则**：
   - 选中 **alias 候选** → model 模式：行首插入 `@<alias> `（如 `@sonnet `），剥离规则复用 §3.9
   - 选中 **文件候选** → file 模式：插入 chip `[@file:<relative-path>]`，走附件生命周期（见下文 file 模式细节）
   - alias 与文件名同名时（如项目里有 `sonnet.ts` 且 alias 叫 `sonnet`）→ **alias 置顶优先展示**（用户用 Tab 可强制切到 file）

3. **快捷前缀**（跳过统一 picker 的某个分支）：
   - `@!<alias>` → **强制 model 模式**：picker 只显示 alias 候选（不显示文件），选中后插 `@<alias> `
   - `@@<path>` → **强制 file 模式**：picker 只显示文件候选（不显示 alias），选中后插 `[@file:<path>]`
   - 纯 `@` 无后续字符 → 完整统一 picker（alias 全列 + 文件候选按 gitignore 过滤）

**为什么用统一 picker 而非原来的双模式选择器**（r9 优化）：

| 方案 | 问题 |
|---|---|
| 原方案：双模式选择器（@ 弹 file/model 二选一 popup） | 每次 @ 都多一步选模式，惩罚高频的 @file 操作；claude-code 用户肌肉记忆断裂 |
| 靠"路径是否存在"启发 | alias 名可能碰巧和文件名同名 → 用户预期错乱（原方案否决理由仍成立） |
| **统一 picker + alias 置顶（r9 决策）** | @file 零额外步骤（直接进 picker 选文件）；@model 同样顺滑（alias 置顶一眼可见）；alias/文件同名时 alias 优先 + Tab 切换兜底 |

**file 模式细节**（不变）：

- chip `[@file:src/foo.ts]` 提交时展开成 `ContentPart { type: 'file', source: { path, kind: 'path' }, mime, filename }` —— 走同一 attachment 生命周期
- 路径归一化 + `path-guard`：拒绝 `~/.apollo/` / `~/.ssh/` / `/etc/` 等敏感前缀（沿用 §11.6 W6 规则）
- 大文件（> 1MB）自动截断为 head+tail 摘要 + 附上完整二进制附件（由 context policy 决定注入形式）
- 目录：允许 `@file:src/`，展开为该目录 tree（≤ 200 项，超过报错要求收窄）

**model 模式细节**：完全复用 §3.9 现有语义，无变化。

**★ 性能策略（r13-P3）**——monorepo 十万文件级仓库，每次键入 `@` 全量 walk 不可行：

1. **候选源 = `git ls-files` 输出缓存**（非 git 目录 fallback：fast-glob 一次遍历，同样缓存）。
2. **缓存失效**：60s TTL + picker 内 `R` 手动刷新 + 目录 mtime 抖动检测（顶层 mtime 变化才重新 walk）。
3. **fuzzy 评分纯内存**（fzf 风格算法）≤ 10ms/次；**首帧先显示已就绪子集**（alias + 最近打开文件），文件候选后台补全后再刷列表。
- 强制点：ui 单测（10 万文件名 fixture，过滤首帧 < 150ms，对齐 §9.10 预算）。

#### 7.5.4 `#sess_<id>` 前缀：跨会话引用

见 §8.5（新增）"跨会话上下文引用"。InputBox 侧行为：

- 键入 `#sess_` 触发 popup，候选为 `~/.apollo/sessions/*.jsonl` 按 `mtime` 倒序 + 会话标题（`/save` 命过名的显示别名）
- 选中后插入 chip `[#sess:<id-8>@<strategy>]`，`strategy` 默认 `relevant`，Tab 切 `handoff`
- 提交时 Runner 通过 `SessionContextReader.read({ sessionId, query: <当前用户输入的其余文本>, strategy, maxTokens })` 拉取内容，注入为一条 `role: 'user'` 的 `content[0].type='text'`，形如 `<session_context id="..." strategy="relevant">...</session_context>`
- 权限：跨会话读**首次**弹 `allow-once/allow-session/deny`（默认只允许同用户 `~/.apollo/sessions/`，跨机器需 `apollo history import` 走过一次）

### 7.6 无颜色 / 结构化输出模式

- 检测：`NO_COLOR=1` env / `--no-color` flag → 关掉所有 ANSI
- `--json` 模式关闭 Ink，走 stdout 直写；但输出形态按命令类型区分：
  - **chat/session 流式路径**：NDJSON（每行一个事件），用于 CI / MCP-style 集成
  - **普通查询类子命令**（如 `doctor --json` / `plugin list --json` / `mcp list --json`）：单个 JSON payload
  - 两类输出都禁止 ANSI / Ink 控制序列
- ★ **r13-D1：`--json` 错误输出协议**（CI 消费者依赖稳定形状）：命令以错误告终时，stdout 追加两行收尾结构——

  ```json
  { "type": "error", "code": "<附录 B 错误码>", "category": "<分类>", "message": "<人读摘要>" }
  { "type": "final", "exitCode": <n> }
  ```

  规则：`final` 行**必须**是最后一行（消费者读到即安全退出）；错误码登记于[附录 B](./APPENDIX-B-error-codes.md)；`--json` 模式的任何错误/警告**不得**走 stderr 混排进 stdout NDJSON（stderr 只留 crash 级兜底）。

### 7.7 边界与安全清单

| 规则                                                                        | 强制点                                          |
|-----------------------------------------------------------------------------|-------------------------------------------------|
| UI **禁止**直接改 `SessionState`，只能调 Runner 公开 API                    | code review                                     |
| UI **禁止**直接调 `ProviderClient` / `ToolRegistry`                          | ESLint 依赖规则                                 |
| UI **只**通过 `permission.setPromptHandler` 反向注入回调                     | permission 无 import ui                         |
| stream throttle **必须**在 UI 层，不允许在 core 埋节流                        | code review                                     |
| `--yolo` **必须**打警告日志 + 顶栏红条                                       | apps/cli 强制                                    |
| InputBox 历史**禁止**明文存 API key / token（脱敏）                          | history writer 白名单                            |
| 剪贴板图片**禁止**明文写入 `history`（只留 chip 占位）                       | history writer 白名单                            |
| `@` 触发**必须**走统一 picker（alias 置顶 + 文件候选跟后），**禁止**基于路径存在性启发；alias 与文件同名时 alias 优先 + Tab 切 file | InputBox 单元测试                                |
| `#sess_<id>` 引用**必须**过 `SessionContextReader` 端口 + 权限校验            | core code review + 集成测试                     |
| `SessionContextReader` **禁止**返回其它用户 home 下的 session（跨用户拒绝）   | storage 层 stat uid 校验                        |
| `--json` **必须**按命令形态区分：chat/session = NDJSON；查询类子命令 = 单个 JSON payload；两者均禁止 Ink/ANSI | CLI 分流测试 |
| Ink 退出路径**必须**恢复 terminal 状态并释放 provider/plugin/native 资源      | SIGINT/exit 集成测试                             |

### 7.8 里程碑

- **L1（MVP）**：完整消息渲染 + 流式 + 权限弹窗 + slash 命令 + `@` **统一 picker**（alias 置顶 + model/file 两类候选，r9 优化）
- **L2**：`@` file 分支 + 附件粘贴（路径 / 拖拽）+ 图像 preview（终端支持 sixel/kitty 时）+ 剪贴板图片二进制粘贴 + `/status` 状态面板（§7.10，随 §11.3.14）
- **L3**：`#sess_<id>` 跨会话引用 + `SessionContextReader` + `--json` 结构化输出模式
- **L4**：主题定制 + 插件 UI 扩展点（状态栏 item + `/status` 插件 section，§6.4.1a） + `@skill` / `@memory` 等额外前缀能力

### 7.9 readline → Ink TUI 迁移契约（L1 补充）

当前实现中的裸 `readline` 提示符（`> `）只能作为 `--no-tui` / 非 TTY fallback，不能作为默认交互体验。默认 TTY 交互必须走 Ink，以恢复 claude-code 风格的连续会话、流式输出、权限弹窗、输入历史和 slash 命令体验。

本节是对 `readline` 迁移的补充契约，不降低 §7.8 的 L1 范围；`@` 统一 picker 仍是 L1 必交付项，可作为同一迁移计划中的独立任务验收。

#### 7.9.1 启动分流

| 场景 | 行为 | 强制点 |
|---|---|---|
| `apollo` 无参数，stdin/stdout 是 TTY | 进入 Ink REPL | apps/cli TTY 检测 |
| `apollo chat` 无 prompt，stdin/stdout 是 TTY | 进入同一个 Ink REPL | 与 `apollo` 无参数一致 |
| `apollo <prompt...>` / `apollo chat <prompt...>` | 单轮执行，不进入持续 REPL | 保持脚本友好 |
| chat/session 流式路径 + `--json` | NDJSON machine output，禁止 Ink/ANSI TUI | CI/MCP 集成 |
| 查询类子命令 + `--json` | 单个 JSON payload，禁止 Ink/ANSI TUI | 脚本集成 |
| `--no-tui` | 行输出 fallback，可使用 readline；无 prompt 时只允许 TTY fallback | 调试/低能力终端 |
| 非 TTY 且无 prompt | 报错 `Interactive chat requires a TTY or a prompt` | 禁止挂起等待输入 |

分流优先级固定为：

1. `--json` 永不启动 Ink；chat/session 输出 NDJSON，查询类子命令输出单个 JSON payload。
2. `--no-tui` 永不启动 Ink；有 prompt 走单轮行输出，无 prompt 且 TTY 时可使用 readline fallback。
3. 无 prompt + TTY + 未禁用 TUI 时进入 Ink REPL。
4. 无 prompt + 非 TTY 必须报错，不读取无限 stdin。

#### 7.9.2 包边界

- `apps/cli` 负责命令解析、TTY/flag 分流、session 生命周期、auth/permission/native/plugin/context 端口装配。
- `packages/ui` 负责 Ink 组件、事件订阅、输入框、历史、slash popup、permission prompt queue、stream throttle。
- `packages/core` 只负责 Runner 状态和事件；不得引入 Ink/React，也不得做 UI throttle。
- `packages/ui` 不直接调 ProviderClient、ToolRegistry 或 native bridge；需要能力时通过 `apps/cli` 注入回调。

建议导出接口：

```ts
export interface InteractiveAppOptions {
  sessionId: string
  cwd: string
  events: EventBus
  noColor?: boolean
  sendMessage(text: string): Promise<void>
  interrupt(): void
  exit(): Promise<void>
  slashCommands: SlashCommand[]
  permission?: PermissionPromptController
  history?: InputHistoryStore
}

export interface SlashCommand {
  name: string
  description: string
  run(input: SlashCommandInput): Promise<void>
}

export interface SlashCommandInput {
  sessionId: string
  cwd: string
  args: string[]
  clearTranscript(): void
  writeStatus(message: string, level?: 'info' | 'warning' | 'error'): void
  requestExit(): Promise<void>
}

export interface InputHistoryStore {
  load(): Promise<string[]>
  append(value: string): Promise<void>
}
```

#### 7.9.3 InputBox L1 范围

- Enter 提交；空行不提交。
- Shift+Enter 插入换行，多行内容按原样作为一个 user message 提交；终端无法可靠区分 Shift+Enter 时，必须提供 `Esc Enter` 或 `Alt+Enter` fallback。
- Ctrl+C 在 turn 进行中调用 `runner.interrupt()`；session 保持存活。
- `exit` / `quit` / `/exit` 结束 Ink REPL；退出路径必须 emit `session.ended`、flush session snapshot、dispose provider/plugin/native runtime、恢复 stdin raw mode / cursor / alternate screen，并以当前 session exitCode 退出进程。
- ↑ / ↓ 浏览 `~/.apollo/history` 输入行历史；提交成功后写入历史。
- 历史写入前必须脱敏；禁止保存 API key/token；附件只保存 chip 文本，不保存二进制。
- 历史安全边界：
  - 单条输入最大 8 KiB；超过时不写入 history，但仍可提交给 Runner。
  - history 文件最大 1 MiB 或最多 1000 条，超限时保留最近记录。
  - 写入前必须走 `shared.sanitize()` 或等价规则；命中 `api_key` / `token` / `password` / `secret` / provider key 模式时整条拒写。
  - history append 失败不得阻塞 `sendMessage`，只在 StatusLine 显示非致命 warning。
  - 写入必须使用 append 或原子 rewrite，避免并发会话截断文件。

#### 7.9.4 Slash 命令 L1 范围

L1 必须内置以下 slash command：

| 命令 | 行为 |
|---|---|
| `/help` | 展示内置命令和快捷键 |
| `/exit` | 结束当前 REPL |
| `/clear` | 清空当前 UI transcript 显示，不删除 session JSONL |
| `/context` | 显示当前 context policy/token 摘要 |
| `/compact` | 触发 context compact（若端口可用） |
| `/model` | 显示当前 provider/model；后续扩展为 picker |

输入 `/` 立即弹 popup；支持前缀过滤、↑/↓ 选择、Enter 确认、Esc 关闭。插件贡献 slash command 走同一 registry，但不阻塞 L1 内置命令落地。

实现约束：composition root 持有动态 registry，TUI 通过 `snapshot()` / `subscribe()` 消费插件贡献，并与 builtin 合并而不是替换。命令名统一去掉可选的 `/` 前缀并转为小写；builtin 名称保留，插件冲突注册会失败。插件 deactivate、disable 或 uninstall 时，注册 disposer 会立即从帮助、建议和执行分发中移除对应命令。

端口不可用行为：

- slash popup 仍显示内置命令，避免用户误以为命令不存在。
- `/context`、`/compact`、`/model` 所需端口不可用时，命令必须在 StatusLine 或 transcript 中显示 `not available in this build/session`，不能 throw 到 Ink 根组件导致 TUI 崩溃。
- 插件贡献命令执行失败时按普通 command error 展示，并回到 InputBox。

#### 7.9.5 流式输出

- UI 订阅 `stream.delta`，将 chunk 写入 ref buffer。
- UI 每 33ms flush 一次到 React state，目标约 30fps。
- `stream.completed`、`turn.aborted`、`error.raised` 必须强制 flush 剩余 buffer。
- Runner/provider 不因 UI 渲染节奏被背压；core 只 emit 事件。
- provider 失败、router 失败、tool 失败都必须回到 InputBox，并在 StatusLine 显示错误摘要。
- stream buffer 必须有内存上限；UI render 被阻塞时超过上限需强制 flush 或截断为错误摘要，禁止无限累积。
- `Runner.run()` 必须在 provider/router/tool 异常后 settle 当前 turn（`activeTurn = null`，turn terminal），否则 TUI 无法恢复输入。

#### 7.9.6 L1 验收

自动化：

```bash
pnpm --filter @apollo-code/core test
pnpm --filter @apollo-code/ui test
pnpm --filter apollo-code test
pnpm --filter apollo-code typecheck
pnpm --filter apollo-code build
```

手工：

```bash
node apps/cli/dist/apollo.js chat
```

必须满足：

- TTY 下进入 Ink TUI，而不是裸 `> `。
- 空行不提交；普通消息进入 transcript；provider 失败后回到输入框。
- assistant 输出随 `stream.delta` 增量刷新。
- `/help` 有候选/展示；`/exit` 干净退出。
- ↑/↓ 可浏览历史。
- `--json` 无 Ink/ANSI；`--no-tui` 不启动 Ink。

### 7.10 /status 状态面板（2026-08-23 新增）

`/status` 打开的模态面板（交互模型同 `/context` 面板）：数据契约与 section 清单以 [§11.3.14](./11-cli-commands.md#11314-status2026-08-23-新增) 为准，本节只定义渲染与交互。

**组件与数据流**：

- 组件 `<StatusPanel>` 挂在 `<App>` 顶层（与 PermissionPrompt 同层），打开时独占焦点；数据来自 §11.3.14 的 K0 数据组装层（`buildStatusView(session, router, registry, ...)`），**UI 不直接读** SessionState / Router 内部。
- 面板内容 = core section（§11.3.14 表）+ 插件贡献 section（§6.4.1a `ui.status.registerSection`）。插件 section 的值在渲染前过 control-character guard（剥 ANSI/C0/bidi），单 section 超 20 行截断并标注 `… (truncated)`；插件 section 渲染返回 `null` 或插件 disabled 时整区不渲染。
- 渲染形态：两列 `label: value` 表；token 计数右对齐千分位；`n/a` / `unavailable` 用 dim 色，不用红色（不是错误，是诚实缺数据，§11.3.14 诚实显示规则）。

**交互**：

| 按键 | 行为 |
|---|---|
| `q` / `Esc` | 关闭面板 |
| `r` | 重新取数刷新（无自动轮询，避免长会话里定时读大状态） |
| `j`/`k` / ↑/↓ | 滚动（内容超屏时） |

**边界**：

- 面板**只读**；改配置走 `/model`、`/reflect on|off`、`apollo config` 等各自入口。
- 打开面板期间主 loop 继续运行（反思 job、后台 shell 不暂停）；面板数据是打开/`r` 时刻的快照，不声称实时。
- 面板渲染抛错（含插件 section 抛错）→ 该 section 替换为一行 `section error: <name>`，不 crash TUI（§7.9 边界语义）；core section 抛错同样降级，禁止整个面板白屏。
