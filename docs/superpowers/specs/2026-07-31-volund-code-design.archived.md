# volund Code — 设计文档 (Design Spec)

> **状态**：🚧 In Progress（brainstorming 阶段，随分节推进滚动补全）
> **日期**：2026-07-31
> **作者**：Mark + Claude
> **相关**：[AGENT.md](../../../AGENT.md) · [CLAUDE.md](../../../CLAUDE.md)

## 摘要 (TL;DR)

volund Code 是 claude-code 的开源平行实现：**多模型后端的终端 AI 编码 CLI**。

| 维度          | 决策                                                                    |
|---------------|-------------------------------------------------------------------------|
| 定位          | claude-code 开源平行实现，不绑定厂商                                     |
| Provider 策略 | 多 Provider 插件化 + 中间路由层（fallback / role-based）                  |
| MVP 范围      | L4：对话 + 工具 + 权限 + MCP + 子 Agent + Skill/Plugin/Hooks（分阶段落地） |
| 终端 UI       | Ink（React for CLI）                                                      |
| 安全          | 权限弹窗 + Rust 沙箱（macOS sandbox-exec / Linux landlock）               |
| Rust 面积     | 沙箱 + 搜索/AST（ripgrep + tree-sitter），其他 TS                          |
| 存储          | 纯文件（JSONL 会话 + toml 配置）                                          |
| 分发          | npm 包 + 平台化 optionalDependencies + 单文件二进制并行                 |
| 构建          | rolldown + Vite 8 + Cargo                                               |
| 遥测          | **默认本地文件**，OTel 网络上报显式 opt-in                               |

## §1 仓库布局 (v3, review 修正版)

采用 pnpm + turborepo monorepo，TypeScript 与 Rust 双 workspace。

### 1.1 目录结构

```
volund-code/
├─ apps/
│  ├─ cli/                        # 唯一可执行入口 → bin: volund
│  └─ docs/                       # VitePress 8 文档站
│
├─ packages/                      # 所有可发布 TS 包
│  │
│  ├─ ── 内核 (kernel) ──
│  ├─ core/                       # Runner / EventBus / SessionState / HookRegistry
│  │                              # 仅依赖 provider-kit + tool-kit + shared
│  │
│  ├─ ── 契约层 (kits, 只含接口，零实现依赖) ──
│  ├─ provider-kit/               # Message/ContentPart/ProviderClient/Capabilities/
│  │                              # ContextPolicy/Attachment/Usage 等（仅依赖 shared）
│  ├─ tool-kit/                   # Tool/ToolRegistry/ToolResult（仅依赖 permission + shared）
│  │
│  ├─ ── 路由层 (v1.1 只做 SingleProviderRouter，接口先立) ──
│  ├─ router/                     # RouterPolicy 实现集合（Single/Fallback/Role/...）
│  │
│  ├─ ── Provider 实现 ──
│  ├─ provider-anthropic/         # Anthropic Messages
│  ├─ provider-openai/            # OpenAI Chat Completions
│  ├─ provider-gemini/            # Gemini
│  ├─ provider-ollama/            # 本地模型
│  │
│  ├─ ── 工具实现 ──
│  ├─ tools/                      # 内置工具（Read/Write/Edit/Bash/Grep/Glob/Todo/Task…）
│  │
│  ├─ ── 横切能力 ──
│  ├─ auth/                       # OS keychain + 加密文件 + env 三级 fallback
│  ├─ http-kit/                   # undici + proxy + retry + tracing
│  ├─ permission/                 # 权限决策 + setPromptHandler 端口
│  ├─ context/                    # ContextPolicy 策略集合（sliding / summary / semantic）
│  ├─ native-bridge/              # Rust 能力唯一入口 + 平台包解析 + JS fallback
│  ├─ storage/                    # JSONL 会话 + toml 配置（订阅 core 事件）
│  ├─ telemetry/                  # 日志/metrics/cost tracking（默认本地，OTel opt-in）
│  ├─ hooks/                      # user hooks 加载器 + 官方内置 hook
│  │
│  ├─ ── 扩展装载器 ──
│  ├─ mcp-client/                 # MCP 客户端（stdio/http/sse），加载后注册到 tool-kit
│  ├─ skills-runtime/             # Skill 装载器 + progressive disclosure
│  ├─ plugin-runtime/             # Plugin 装载器（volund-sandbox --run-plugin 子进程 + JSON-RPC bridge + manifest 权限）
│  ├─ plugin-sdk/                 # 【发布 npm】插件作者用的类型 + define helpers（零运行时依赖）
│  ├─ memory-runtime/             # 长期记忆存储 + 召回索引 + memory bridge server（v2+）
│  ├─ subagent/                   # 子 Agent runtime（接受 RunnerFactory 注入）
│  │
│  ├─ ── UI ──
│  ├─ ui/                         # Ink 组件库（订阅 core 事件 + 提供 permission prompt）
│  │
│  └─ ── 基础 ──
│     └─ shared/                  # 类型/常量/logger/VolundError/config schema (zod)
│
├─ crates/                        # Rust workspace
│  ├─ volund-sandbox/             # 独立二进制：syscall 隔离执行器
│  ├─ volund-search/              # napi-rs addon：ripgrep + tree-sitter
│  ├─ volund-fs/                  # napi-rs addon：大文件 diff / tokenize
│  └─ xtask/                      # Rust 侧构建/发布脚本
│
├─ platforms/                     # 各平台 prebuild 二进制的独立发布包（见 §1.6）
│  ├─ native-sandbox-darwin-arm64/
│  ├─ native-sandbox-darwin-x64/
│  ├─ native-sandbox-linux-x64-gnu/
│  ├─ native-sandbox-linux-arm64-gnu/
│  ├─ native-sandbox-win32-x64/
│  ├─ native-sandbox-win32-arm64/
│  ├─ native-search-darwin-arm64/     ← napi addon .node
│  ├─ native-search-darwin-x64/
│  ├─ native-search-linux-x64-gnu/
│  ├─ native-search-linux-arm64-gnu/
│  ├─ native-search-win32-x64/
│  ├─ native-search-win32-arm64/
│  └─ ... (同 native-fs)
│
├─ examples/                      # 示例 Skill / Plugin / MCP server
├─ .github/workflows/             # CI: TS build / Rust matrix / release
├─ AGENT.md
├─ CLAUDE.md
├─ turbo.json
├─ pnpm-workspace.yaml
├─ Cargo.toml
└─ package.json
```

### 1.2 依赖方向（v3 修正后）

```
                          apps/cli
                              │  组装
       ┌───────────────┬──────┴──────┬──────────────┐
       ▼               ▼             ▼              ▼
     core          router      provider-*        tools
       │             │             │               │
       │             │             │               ▼
       │             │             ▼           tool-kit ─→ permission
       │             ▼         provider-kit        │
       │         provider-kit      │               │
       │             │             │               ▼
       └─────────────┴─────────────┴──→ shared ←──┘

  订阅 core 事件（core 完全不感知）：
    ui / storage / telemetry / hooks

  通过 tool-kit 注入工具（core 完全不感知）：
    mcp-client / plugin-runtime / memory-runtime(via volund.memory bridge) / subagent(via Task tool)

  运行时端口注入（无 import 依赖）：
    permission.setPromptHandler(uiPrompt)   ← apps/cli 组装时注入
    subagent.configure(runnerFactory)        ← apps/cli 组装时注入

  横切能力：
    auth (被 provider-* 主动调用)
    http-kit (被 provider-* 主动调用)
    context (提供 ContextPolicy 实现，被 apps/cli 选一个注入 Runner)
    native-bridge (被 tools / auth / plugin-runtime 主动调用)
```

**依赖表格**（CI 强制）：

| 包                 | 允许依赖                                            |
|--------------------|-----------------------------------------------------|
| **apps/cli**       | packages/* 任意                                     |
| **apps/docs**      | 无（build 时 typedoc 读源码，非 npm 依赖）             |
| **core**           | provider-kit / tool-kit / shared                    |
| **router**         | provider-kit / shared                               |
| **provider-kit**   | **shared 仅**                                       |
| **provider-\***    | provider-kit / http-kit / auth / shared             |
| **tool-kit**       | permission / shared                                 |
| **tools**          | tool-kit / native-bridge / subagent / shared        |
| **subagent**       | core（`Runner` 类）/ provider-kit / tool-kit / shared |
| **mcp-client**     | tool-kit / shared                                   |
| **plugin-runtime** | core（type-only）/ tool-kit / permission / hooks / native-bridge / shared |
| **plugin-sdk**     | shared（type-only）                                   |
| **skills-runtime** | core（type-only）/ shared                             |
| **memory-runtime** | core（type-only）/ permission / hooks / native-bridge / shared |
| **hooks**          | core（type-only） / shared                            |
| **storage**        | core（type-only）/ shared                             |
| **telemetry**      | core（type-only）/ shared                             |
| **ui**             | core（type-only）/ permission（type-only）/ shared      |
| **context**        | provider-kit / shared                               |
| **auth**           | native-bridge / shared                              |
| **http-kit**       | shared                                              |
| **permission**     | shared                                              |
| **native-bridge**  | shared + 运行时 dynamic require platform packages   |
| **shared**         | 无                                                  |

**说明**：

- 表格里标注 "type-only" 的依赖必须用 `import type { ... }`，编译时消除，运行时不引入。CI ESLint 强制。
- `ui → permission` 是 type-only：ui 需要知道 `PermissionRequest` 类型来渲染弹窗；ui 通过 `permission.setPromptHandler(...)` 注册回调，反向不 import。
- `auth → native-bridge` 是**运行时可选**依赖（不是 type-only）：仅 L4 加密凭据文件的 AES-256-GCM 操作走 Rust（`volund-fs` 的 `encrypt/decrypt` 导出）。L1-L3 只用 Node `crypto`，`native-bridge` 缺失时 auth 自动 fallback。CI 允许该依赖，但 `auth` 内所有 native-bridge 调用必须包 try/catch fallback。

### 1.3 关键约束

- **`apps/cli` 是唯一 bin**，`packages/*` 禁止声明 `bin` 字段
- **`apps/docs` 用 VitePress 8**，`"private": true`，**不发布到 npm**，只做 GitHub Pages / Vercel 部署
- **Provider 每家一个包**，用户按需装
- **`native-bridge` 是 Rust 唯一入口**，通过 optionalDependencies 平台包分发（见 §1.6）
- **`crates/` 独立 Cargo workspace**

### 1.4 契约定义的唯一归属

| 抽象                                                    | 定义位置                                    |
|---------------------------------------------------------|---------------------------------------------|
| Message / ContentPart / Attachment / Usage              | provider-kit                                |
| ProviderClient / ProviderCapabilities                   | provider-kit                                |
| **ContextPolicy**                                       | provider-kit（**改自 v2**，随 Message 概念走） |
| RouterPolicy / RouterDecision                           | router（接口内置）                            |
| Tool / ToolRegistry / ToolResult / ToolResultMeta       | tool-kit                                    |
| Runner / SessionState / EventBus / HookRegistry         | core                                        |
| **PromptComposer / PromptFragment**                     | **core**（v3.1 新增，见 §6.5）                  |
| **VolundBridge / Plugin / ToolSpec 等 SDK 类型**         | **plugin-sdk**（发布 npm，作者依赖）            |
| PermissionSpec / PermissionRequest / PermissionDecision | permission                                  |
| VolundError / Logger / Config schema (zod)              | shared                                      |

### 1.5 关键运行时端口（依赖注入）

避免循环依赖的注入点，由 `apps/cli` 在启动时装配：

```
1. permission.setPromptHandler(uiPermissionDialog)
   └ ui 提供实现，permission 消费，不产生反向依赖

2. subagent.configure({ runnerFactory, defaultBudget, ... })
   └ apps/cli 组装 runnerFactory 后注入 subagent

3. core.Runner(new RouterAdapter(router), toolRegistry, contextPolicy, hookRegistry)
   └ 所有能力通过构造函数注入 Runner

4. telemetry.setSink(localFileSink | otelSink)
   └ 默认 localFileSink，用户显式配置才用 otelSink（见 §4.13）
```

### 1.6 Rust 原生分发模型（业界标准 pattern）

参考 esbuild / biome / swc 做法：

**每个 Rust 产物 × 每个 target = 一个独立 npm 包**

```
platforms/
  native-sandbox-<os>-<arch>/    → 打包 volund-sandbox 可执行二进制
  native-search-<os>-<arch>/     → 打包 volund-search.node napi 产物
  native-fs-<os>-<arch>/         → 打包 volund-fs.node napi 产物
```

**共 3 × 6 = 18 个平台包**（可通过 CI matrix 自动化）。

`packages/native-bridge/package.json`：

```json
{
  "optionalDependencies": {
    "@volund-code/native-sandbox-darwin-arm64": "workspace:*",
    "@volund-code/native-sandbox-darwin-x64": "workspace:*",
    "@volund-code/native-sandbox-linux-x64-gnu": "workspace:*",
    ...(共 18 项)
  }
}
```

**运行时解析**：`native-bridge` 通过 `process.platform + process.arch` 拼出目标包名，`require.resolve` 找到实际文件路径。找不到就回落到纯 JS fallback（`volund-search` fallback = fast-glob + JS 正则；`volund-sandbox` fallback = 拒绝 + 提示 --dangerous-no-sandbox）。

**Target 支持矩阵**：

- darwin-arm64 / darwin-x64
- linux-x64-gnu / linux-arm64-gnu（含 musl 可加）
- win32-x64 / win32-arm64

### 1.7 Skill vs Plugin 边界（不变，扩充版本兼容）

|          | Skill                                          | Plugin                                          |
|----------|------------------------------------------------|-------------------------------------------------|
| 本质     | Prompt + 资源                                  | 代码（tools / commands / hooks）                  |
| 存放     | `~/.volund/skills/<name>/SKILL.md`             | `~/.volund/plugins/<name>/`                     |
| 装载     | 冷启动扫 metadata，按需读全文                   | 显式 install + manifest 声明能力                |
| 隔离     | 不执行代码                                     | permission + manifest + 静态检查                |
| 版本     | `SKILL.md` frontmatter `volundVersion: ^1.0.0` | `manifest.json` `engines.volund: ^1.0.0`        |
| 首次装载 | 无提示（无风险）                                 | **弹权限确认**（"该插件声明需要 fs.write / net"） |
| 运行时   | `skills-runtime`                               | `plugin-runtime`                                |

---

## §2 核心数据模型与 Agent Loop

本节定义 `packages/core` 的对外契约与内部主循环。是全项目最关键的一节，其他所有能力都建立在此之上。

### 2.1 消息模型 (provider-kit)

**核心原则**：内部 Message 是 provider **无关**的中性表示，从 day 1 就是多模态友好的 `ContentPart[]`。

```
Message = {
  id: MessageId              // UUIDv7（有序，便于事件重放）
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ContentPart[]
  createdAt: timestamp
  turnId: TurnId
  meta?: {
    provider?: string        // 生成方（telemetry 用）
    model?: string
    usage?: Usage
    stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_seq' | 'error'
  }
}

ContentPart =
  | { type: 'text', text: string }
  | { type: 'thinking', text: string, signature?: string }           // Claude/o1/R1 推理内容
  | { type: 'image', source: AttachmentRef, mime: string }
  | { type: 'file',  source: AttachmentRef, mime: string, filename: string }
  | { type: 'tool_use', id: string, name: string, input: JsonValue }
  | { type: 'tool_result', toolUseId: string, content: ContentPart[], isError?: boolean }

AttachmentRef =
  | { kind: 'inline', bytes: Uint8Array }        // 仅允许 < 64 KB
  | { kind: 'path',   absPath: string }          // 磁盘引用，懒读
  | { kind: 'handle', handle: NativeHandle }     // native-bridge 提供，见 §2.1.1

Usage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  costUSD?: number
}
```

#### 2.1.1 附件 handle 生命周期

`AttachmentRef.handle` 由 `native-bridge` 分配，生命周期绑定到 SessionState：

- 附件添加到消息时，由 `native-bridge` 增加引用计数。
- 消息被 context 压缩替换（不再进 prompt）时，Runner 显式调 `native.release(handle)`。
- Session 关闭时统一释放。
- 未释放的 handle 在 Runner 退出时打日志并强制释放，防止 native 内存泄漏。

### 2.2 会话状态 (core)

```
SessionState = {                             // Immutable，每次事件产生新版本
  id: SessionId
  cwd: string
  createdAt: timestamp
  version: number                            // 递增，用于乐观并发

  messages: ReadonlyArray<Message>
  turns: ReadonlyArray<Turn>
  activeTurn: TurnId | null

  cumulativeUsage: Usage & { costUSD: number }

  routerState: RouterPolicyState             // Router 内部维护
  contextBudget: {
    maxTokens: number
    currentTokens: number
    lastCompactedAt?: MessageId
  }

  toolRegistrySnapshot: SnapshotId           // 装载后冻结
  permissionCache: ReadonlyMap<string, PermissionDecision>  // "allow-session"

  pendingInterrupt: boolean
}

Turn = {
  id: TurnId
  startMessageId: MessageId
  endMessageId?: MessageId
  status: 'streaming' | 'awaiting_tool' | 'awaiting_user' | 'done' | 'aborted' | 'error'
  parentTurnId?: TurnId                      // subagent 场景
  parentDepth: number                        // W11: 0=顶层，1=subagent 第一层，...；对齐 hook ctx.depth（W13）
  agentType?: string                          // 'main' / 'task-agent' / user-defined
  stickyProvider?: ProviderName              // B4: turn 内锁定的 provider；tool_use 产生后 set
}
```

**关键决策**：

- **结构化共享**：immutable 不能每次全量拷贝（O(n²)），使用 `immer` 或等价库，改动只重建 root path。
- SessionState 只能通过 Runner 的公开 API 修改（`sendUserMessage` / `interrupt` 等），UI 不能直接改。
- `permissionCache` 支持 "allow-session"：本会话内同一权限项不再弹窗。

### 2.3 事件总线 (core)

事件是**类型化的 discriminated union**，只增不改，为 session replay 铺路。每个事件带 `id` / `type` / `version` / `sessionId` / `turnId?` / `payload` / `at`。

**★ W9：`event.id` 采用 UUIDv7**（时间前缀 + 单调，可排序 + 全局唯一）。由 core emit 侧生成，subscriber 侧 **必须** 在 process-local 内存 seen-set 里做去重（LRU 上限 10k）：
- 场景：subscriber 崩溃后 replay 重发部分事件时可能重复；EventBus 内如果未来引入 async fan-out 也可能重发。
- 语义：subscriber 收到 `event.id` 已在 seen-set 中的事件 → 静默丢弃，不重复副作用。
- storage 侧特殊：session JSONL 写入以 `event.id` 为 idempotency key，写入前查 tail 若已存在则跳过（`stream.completed` / `message.appended` 幂等 write）。
- 幂等要求：所有 subscriber 副作用（storage 落盘 / telemetry 计数 / hooks trigger）**必须** 通过 seen-set 保护，无 subscriber 例外。

| 事件                    | 触发时机                                  | 主要订阅者                                    |
|-------------------------|-------------------------------------------|-----------------------------------------------|
| `session.started`       | Runner 启动                               | ui / storage / telemetry / hooks              |
| `session.ended`         | Runner 关闭                               | all                                           |
| `turn.started`          | 新 turn 开始                              | ui / storage / telemetry / hooks              |
| `turn.completed`        | turn 正常结束                             | ui / storage / telemetry / hooks              |
| `turn.aborted`          | Ctrl+C / error                            | ui / storage / telemetry                      |
| `message.appended`      | 新消息落盘                                | ui / storage / telemetry                      |
| `stream.started`        | provider 开始流式                         | ui                                            |
| `stream.delta`          | 增量 token / thinking / tool_use fragment | ui（throttled）                                 |
| `stream.completed`      | provider 流结束                           | ui / telemetry                                |
| `tool.requested`        | assistant 输出 tool_use                   | ui / hooks(PreToolUse)                        |
| `tool.permission_asked` | 需要权限确认                              | ui（弹窗）                                      |
| `tool.started`          | 权限通过，开始执行                         | ui / telemetry                                |
| `tool.completed`        | 工具完成（含错误）                          | ui / storage / telemetry / hooks(PostToolUse) |
| `context.compacted`     | 上下文压缩发生                            | ui / telemetry                                |
| `router.switched`       | Router 切换 provider                      | ui / telemetry                                |
| `error.raised`          | 任何异常                                  | ui / telemetry / hooks                        |

**订阅原则**：

- Core **只发不订**（唯一 emitter）。
- 所有 subscriber 幂等（可重放）。
- **Stream backpressure**：`stream.delta` 频率高，UI 侧 throttle 到 30fps（**结论：ui 是消费者、自 throttle；上游流不做背压，避免复杂化**）。
- 大 payload（附件二进制）**不进事件**，只传引用。
- Node 单线程保证事件天然有序。

### 2.4 Runner 主循环（伪代码）

```
async runner.run(userInput):
  turnId = newTurn()
  turnAbort = new AbortController()              // B3: turn 级 abort，interrupt 时统一广播
  loopCount = 0                                   // B2: tool_use 迭代计数
  stickyProvider = null                           // B4: turn 内 provider 粘性
  emit turn.started

  appendMessage({role: 'user', content: normalize(userInput)})
  emit message.appended

  loop:                                          # 单 turn 内可能多轮 provider 调用
    // B2: turn 内 tool_use 循环上限（默认 25，config: runner.maxToolLoopsPerTurn）
    if loopCount >= state.config.maxToolLoopsPerTurn:
      emit error.raised { code: 'tool_loop_exhausted', turnId, loopCount }
      appendMessage(systemNote("Aborted: exceeded maxToolLoopsPerTurn"))
      break
    loopCount += 1

    hint = hooks.trigger('prePrompt', ctx)       # 可能塞入 @model 提示等

    if contextPolicy.shouldCompact(state):
      await compact()                            # emit context.compacted
    contextMessages = contextPolicy.buildPrompt(state.messages, capabilities)

    // B1: 组合 system prompt（PromptComposer）
    // - compose 输入：state（含 cwd/model/激活的 skills/AGENT.md 集合）+ capabilities
    // - compose 输出：单一 string，按 §6.5 fragment 优先级拼接
    // - 每轮都 compose：允许 skill activate/deactivate 生效；实现上做 memoize（fragment 集合未变则复用）
    systemPrompt = promptComposer.compose(state, capabilities)

    hooks.trigger('preProviderCall', ctx)

    // B4: turn 内 provider sticky：一旦产生 tool_use，后续 loop 强制同 provider
    provider = stickyProvider ?? router.pick(state, hint)
    stream = provider.stream({
      system: systemPrompt,                       // B1: provider 侧 system 字段（provider-kit 契约）
      messages: contextMessages,
      tools: toolRegistry.forProvider(provider),
      signal: turnAbort.signal                    // B3: provider stream 也接 abortSignal
    })
    emit stream.started

    assistantMsg = { role: 'assistant', content: [] }
    for chunk in stream:
      if state.pendingInterrupt:
        turnAbort.abort()                         // B3: 广播到 provider stream + tool.invoke
        stream.abort(); emit turn.aborted; return
      assistantMsg = mergeChunk(assistantMsg, chunk)
      emit stream.delta                          # UI throttled
    emit stream.completed

    appendMessage(assistantMsg); emit message.appended
    hooks.trigger('postProviderCall', ctx)

    toolUses = assistantMsg.content.filter(isToolUse)
    if toolUses.empty:
      break

    // B4: 第一个 tool_use 出现时锁定 provider
    stickyProvider = stickyProvider ?? provider

    toolResults = await parallelInvoke(toolUses, turnAbort.signal)  // § 2.5
    for tr in toolResults:
      appendMessage({role: 'tool', content: [tr]})
      emit message.appended
    # continue loop：模型基于 tool_result 生成下一轮

  hooks.trigger('stop', ctx)                     # 可拦截强制继续
  emit turn.completed


// interrupt 入口（供 UI 层 Ctrl+C 调用）
runner.interrupt():
  state.pendingInterrupt = true
  turnAbort.abort()                              // B3: 立即广播到当前 turn 的所有异步（stream / tool.invoke）
```

**说明**：

- `hint` 是 hook 或用户显式指令（比如 `@gpt-4 帮我...`）产生的 router 提示，可能为 undefined。
- **B1**：system prompt 由 `PromptComposer.compose(state, capabilities)` 生成，作为 provider-kit `ProviderRequest.system` 字段传给 provider（Anthropic 有独立 `system` 参数；OpenAI/Gemini 会被 adapter 转成 `messages[0]={role:'system'}`）。多个 fragment 之间以 `\n\n---\n\n` 分隔，来源以 HTML 注释形式嵌入（§6.5.5）。
- **B2**：`maxToolLoopsPerTurn` 默认 25，可在 `config.toml` 覆盖；触顶后 emit `error.raised{code:'tool_loop_exhausted'}`，写入一条 system role 消息告知模型"已达上限"，然后 break（避免死循环烧钱）。
- **B3**：`turnAbort: AbortController` 在 turn 开始时创建，传播链为 `runner.interrupt() → turnAbort.abort() → provider stream + tool.invoke(abortSignal) → sandbox 子进程 SIGTERM`；tool 实现**必须**响应 abortSignal（否则超时兜底 60s 生效）。
- **B4**：`stickyProvider` 语义 — 一旦本 turn 产生了 tool_use，后续所有 loop 迭代**必须**用同一 provider（tool_use_id 是 provider-specific 格式，切换会导致 tool_result 无法匹配）；fallback 只能发生在**首轮或纯文本轮**；违反语义 emit `error.raised{code:'provider_sticky_violation'}`。
- `router.pick` 只在 `stickyProvider == null` 时才调用；后续轮直接复用。

### 2.5 并行 Tool 调用

```
async parallelInvoke(toolUses, turnAbortSignal):
  concurrency = provider.capabilities.parallelToolCalls ? Infinity : 1
  return runConcurrent(toolUses, concurrency, async (tu) => {

    // B5: 每个 tool_use 各自独立跑 preToolUse pipeline
    //     N 个 tool_use 之间 pipeline 并行；同一 tool_use 内多个 handler 串行 pipeline（§6.11.1）
    //     hook 作者约定：handler 必须无副作用/幂等；跨 tool 共享状态由作者自行加锁
    tu = await hooks.triggerPipeline('preToolUse', tu, {
      toolUseId: tu.id,
      turnId,
      depth: ctx.depth,                          // 见 W13：subagent 内为 1+
    })
    if hook returned { veto: true, reason }:
      emit tool.completed { blocked: true, by: 'hook' }
      return { toolUseId: tu.id, isError: true, content: `blocked by hook: ${reason}` }

    tool = toolRegistry.get(tu.name)
    permReq = tool.permissionSpec(tu.input)
    decision = await permission.request(permReq) // 通过 promptHandler
    emit tool.permission_asked → tool.started_or_denied

    if decision === 'deny':
      return { toolUseId, isError: true, content: 'permission denied by user' }

    emit tool.started
    // B3: tool 级 abortSignal 来自 turnAbortSignal，interrupt 时统一 abort
    toolAbort = AbortSignal.any([turnAbortSignal, AbortSignal.timeout(tool.timeoutMs ?? 60_000)])
    try:
      result = await tool.invoke(tu.input, {
        abortSignal: toolAbort,
        session, native,
      })
    catch e:
      if e.name === 'AbortError':
        result = { isError: true, content: 'aborted by user or timeout' }
      else:
        result = errorToContent(e)
    emit tool.completed

    result = await hooks.triggerPipeline('postToolUse', tu, result, {
      toolUseId: tu.id, turnId, depth: ctx.depth,
    })
    return result
  })
```

**关键决策**：

- 默认并行执行 tool_use（除非 provider 说不支持并行）。
- **B5 并行语义**（明确）：
  - N 个 tool_use → N 条独立的 `preToolUse` pipeline 并行执行；
  - 同一 tool_use 内多个 handler → **串行 pipeline**（§6.11.1），前者返回作为后者 input；
  - hook handler 之间**不保证互斥**：作者不得依赖跨 tool 的共享可变状态，若必需请自行加锁；
  - veto 只影响**当前 tool_use**，不打断其它并行 tool。
- Permission 内部**串行弹窗**：多个并行 tool 同时请求权限时，permission 内部维护队列一次显示一个（避免刷屏）。
- 单 tool 失败**不影响其他** tool（各自返回 error content）。
- **B3 abort 传播**：`turnAbortSignal` 与 `AbortSignal.timeout(tool.timeoutMs)` 用 `AbortSignal.any([...])` 合并；任一触发即中止该 tool；tool 实现必须响应 `abortSignal`（sandbox binary 收到 SIGTERM；纯 JS tool 检查 signal）。
- Task tool 就是耗时长的普通 tool，不特殊路径。

### 2.6 Hook 拦截点

| Hook               | 类型 | 触发点                    | 能做什么                 |
|--------------------|------|---------------------------|--------------------------|
| `sessionStart`     | 观察 | Runner 启动后             | 注入初始 system prompt   |
| `sessionEnd`       | 观察 | Runner 关闭               | 清理                     |
| `prePrompt`        | 拦截 | 用户输入后，构造 prompt 前 | 改写用户消息 / 返回 hint |
| `preProviderCall`  | 拦截 | 调 provider 前            | 修改 messages / tools    |
| `postProviderCall` | 观察 | provider 返回后           | 记录 usage               |
| `preToolUse`       | 拦截 | tool_use 执行前           | 改 input / 拒绝          |
| `postToolUse`      | 拦截 | tool 执行后               | 改 result                |
| `preCompact`       | 观察 | 压缩前                    | 备份                     |
| `postCompact`      | 观察 | 压缩后                    | 记录压缩量               |
| `stop`             | 拦截 | turn 结束时               | 可强制继续               |

**执行语义**：

- 同一 hook 点多个 handler **串行执行**，前者输出作为后者输入。
- 拦截型 hook 必须同步或短异步返回，超时 **5 秒** 视为失败并跳过。
- Hook 抛异常默认**不阻断主流程**（记录到 telemetry），可配置 fail-hard。

### 2.7 Subagent 生命周期

由 `Task` tool 触发，通过 `subagent.dispatch(parentCtx, prompt, opts)`。

```
subagent.dispatch:
  1. TaskTool 收到 { prompt, agentType, budget }
  2. subagent 用注入的 RunnerFactory 造新 Runner：
     - 独立 SessionState（不共享 messages 和 permissionCache）
     - 复用父的：toolRegistry / router / hookRegistry / native
     - agentType 决定 system prompt
  3. 事件转发：subagent EventBus 事件加 { parentTurnId } tag 冒泡到父 EventBus
  4. 完成后 Task tool 从最后一条 assistant message 提取 text 作为 tool_result
```

**关键决策**：

- 嵌套硬上限**默认 3 层**（可配置），防止 agent 递归失控。
- Subagent **不能** import 父 messages / permissionCache（隔离）。
- Subagent 事件走同一 EventBus 加 tag，UI 折叠渲染 ("🤖 Subagent 正在执行...")。
- Budget（token / cost / time）用完强制 abort。
- **★ W8：Subagent 内 permission 决策收窄**。父上下文里的 `allow-project` / `allow-forever` 白名单**不下传**到 subagent 的 `permissionCache`；subagent 请求权限时用户可选项**只有** `allow-once` / `allow-session`（session 指该 subagent 生命期，不含父）/ `deny`。同时若父 turn 的当前 tool_use 已经 hit 到白名单直接放行，subagent 内**重新弹窗**（不复用父决策）。原因：subagent 的 prompt 来自模型生成，攻击面比用户直接输入大；若继承 forever 白名单等于把"过去用户点过一次"当成"未来 LLM 决定的任意命令"的免检通行证。
- **★ W13：Hook ctx 加子 agent 标记**。所有 hook `trigger(event, ctx)` 的 `ctx` 里必须带 `depth: number`（0=顶层 Runner，1=第一层 subagent，...）与 `isSubagent: boolean`（`depth > 0`）。plugin/project hook 可用这两个字段选择性禁用（例如"敏感命令扫描 hook 在 subagent 内更严格"）。字段由 `subagent.dispatch` 在造 Runner 时注入 `RunnerContext.depth = parentCtx.depth + 1`。

### 2.8 异常谱

| 异常源                            | 表现                      | Runner 处理                                        |
|-----------------------------------|---------------------------|----------------------------------------------------|
| Provider network error            | stream 中断               | Router fallback；否则记 error message，允许重试      |
| Provider 4xx                      | 立即抛                    | 不 fallback，提示用户重新 login                     |
| Provider 429                      | 立即抛                    | Router 切 provider 或指数退避                      |
| Tool 抛异常                       | reject                    | 转成 `tool_result.isError=true`，模型自处理         |
| Tool 超时                         | AbortSignal               | 同上                                               |
| Permission 拒绝                   | `deny`                    | 转成 `tool_result` "user denied"                   |
| Ctrl+C                            | pendingInterrupt=true     | stream abort，turn.aborted，session 存活             |
| Context 超限                      | contextPolicy 强制压缩    | preCompact → 压缩 → postCompact；失败报错           |
| Hook 异常                         | 记录跳过（默认）            | 可配置 fail-hard                                   |
| **Rust addon 崩溃**               | native-bridge catch       | 降级到 JS fallback + `error.raised`                |
| **Sandbox binary 缺失**           | native-bridge 探测阶段    | 副作用工具拒绝执行，除非 `--dangerous-no-sandbox`   |
| **磁盘满（storage 写 JSONL 失败）** | storage 订阅端异常        | 降级到 in-memory 模式，UI 提示，session 存活         |
| **OS keychain 锁定 / 无访问权限** | auth.getCredential reject | 降级到加密文件或 env，最终失败则中断 provider 调用  |
| 未知异常                          | catch-all                 | emit error.raised，turn.status='error'，session 存活 |

**统一语义**：Runner 尽最大努力**不让整个 session 崩**，除非 SessionState 本身损坏或磁盘完全失能。

## §3 Provider 抽象层 & Router 策略

本节定义 `packages/provider-kit`（契约）、`packages/provider-*`（实现）、`packages/router`（路由策略）之间的边界。

### 3.1 设计目标

| 目标                    | 具体含义                                                                     |
|-------------------------|------------------------------------------------------------------------------|
| **中性优先**            | 内部 `Message` / `ContentPart` provider 无关；跨 provider 切换无需改业务代码。 |
| **能力可探测**          | `ProviderCapabilities` 让 Runner / Router 知道 provider 能做什么、不能做什么。 |
| **原生特性可用**        | 允许 provider 特殊字段通过 **RawMeta 逃生舱** 传递，不污染中性模型。          |
| **流式一等**            | Stream 是主 API，非流式退化为收集流。                                          |
| **可路由**              | Router 层夹在 Runner 与 provider 之间，负责选择 / 降级 / 切换。                |
| **可组合能力检测**      | Runner 询问 capabilities 决定行为（并行 tool / 是否发 thinking / 视觉压缩等）。 |
| **Auth / http 强路由**  | 所有 provider 走 `auth` + `http-kit`，不允许自建 fetch。                       |

### 3.2 ProviderClient 契约（provider-kit）

```ts
export interface ProviderClient {
  readonly name: string                             // 'anthropic' / 'openai' / 'gemini' / 'ollama'
  readonly capabilities: ProviderCapabilities

  /** 主 API：流式请求 */
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>

  /** 可选：非流式便捷方法（默认由 base class 用 stream 收集实现） */
  complete?(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>

  /** 可选：token 计数（用于 context 预算），未实现时降级到 tiktoken 近似 */
  countTokens?(messages: Message[], tools?: ToolSchema[]): Promise<number>

  /** 可选：列出该 provider 支持的模型（动态目录，UI 展示用） */
  listModels?(): Promise<ModelDescriptor[]>

  /** 关闭连接、释放资源 */
  dispose(): Promise<void>
}
```

```ts
export interface ProviderRequest {
  model: string                                     // 具体模型 id
  messages: ReadonlyArray<Message>                  // 中性 Message[]
  system?: string                                   // 由 PromptComposer 提供，见 §6.5
  tools?: ToolSchema[]                              // 由 tool-kit 序列化
  toolChoice?: 'auto' | 'none' | 'required' | { name: string }
  maxTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  responseFormat?: 'text' | 'json'                  // 简单 JSON 模式；结构化输出用 tool
  reasoning?: {                                     // 显式思考开关
    enabled: boolean
    budgetTokens?: number                           // Anthropic thinking / OpenAI reasoning_effort 换算
  }
  cache?: {                                         // 由 provider 适配转成 provider-specific 缓存指令
    strategy: 'ephemeral' | 'persistent' | 'off'
    ttlSeconds?: number
  }
  rawMeta?: RawMeta                                 // 逃生舱，见 §3.4
}
```

```ts
export type ProviderChunk =
  | { kind: 'message.start',   messageId: string }
  | { kind: 'text.delta',      text: string }
  | { kind: 'thinking.delta',  text: string, signature?: string }
  | { kind: 'tool_use.start',  id: string, name: string }
  | { kind: 'tool_use.delta',  id: string, argsFragment: string }        // JSON 片段流
  | { kind: 'tool_use.end',    id: string }
  | { kind: 'usage',           usage: Usage }                            // 中间或结束时到达
  | { kind: 'message.stop',    stopReason: StopReason }
  | { kind: 'error',           error: ProviderError }

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error'
```

**关键约定**：
- **`stream` 是主 API**。所有 provider 实现都必须提供 stream；`complete` 只是包装糖。
- **tool_use 参数流式拼接**：`tool_use.delta.argsFragment` 是 JSON 字符串增量，`tool_use.end` 时由 Runner 一次性 `JSON.parse`（失败则包成 tool_result error）。
- **`usage` 可多次到达**（有的 provider 中间报 cache_read，结束报 output）。累计规则：以 `message.stop` 前的最后一次为准，中间的用于 UI 实时显示。
- **`AbortSignal` 必须传递**：Runner 通过它实现 Ctrl+C 立即中断。
- **`error` chunk 不重复 throw**：底层实现要么发 `error` chunk 要么 throw，二选一。

### 3.3 ProviderCapabilities

```ts
export interface ProviderCapabilities {
  //-------- 上下文与费用 --------
  maxContextTokens: number                          // 输入上限（不含 output）
  maxOutputTokens: number
  pricing?: { inputPerM: number; outputPerM: number; cacheReadPerM?: number; cacheWritePerM?: number }

  //-------- 工具能力 --------
  toolUse: 'none' | 'sequential' | 'parallel'       // Runner 用来决定并行度
  toolResultSchema: 'anthropic' | 'openai' | 'gemini' | 'json-string'

  //-------- 内容形态 --------
  vision: false | { formats: string[]; maxSizeMB: number }
  files: false | { formats: string[]; maxSizeMB: number }
  audio?: false | { formats: string[] }
  thinking: false | { budgetTokens: boolean }        // 支持思考 + 是否支持 budget 控制

  //-------- 流式 --------
  streaming: boolean                                 // 理论上都得是 true
  streamingReasoning: boolean                        // 是否支持思考流

  //-------- 缓存 --------
  cache: 'none' | 'ephemeral' | 'persistent'

  //-------- 结构化输出 --------
  jsonMode: boolean
  structuredOutput: boolean                          // schema-constrained

  //-------- 特殊 --------
  systemPromptLocation: 'system-field' | 'first-user-message'  // Gemini 是后者
  toolChoiceRequired: boolean                        // OpenAI 才有 'required'
  interleavedThinking: boolean                       // 允许思考与工具交错
}
```

**用途**：
- Runner 检查 `toolUse` 决定并行度（§2.5）
- context 层根据 `maxContextTokens` 计算是否要压缩
- ui 根据 `vision` 决定用户能否粘图
- Router 根据 `pricing` 做 cost-aware 选择（v2）
- provider 适配器根据 `systemPromptLocation` 决定往哪塞 system prompt

### 3.4 RawMeta 逃生舱（重要）

**问题**：provider 独有字段（Anthropic `cache_control` breakpoint、OpenAI `logprobs`、Gemini `safetySettings`）如果强塞进中性 `Message`，会污染类型；如果不支持，用户只能改包。

**方案**：在 `ProviderRequest` 上加一个 `rawMeta` 字段，**按 provider 命名 key**，各家适配器只读自己的 key：

```ts
export interface RawMeta {
  anthropic?: {
    cacheControl?: { type: 'ephemeral' }[]           // 每条 message 一个位点
    metadata?: { user_id?: string }
    computerUse?: { displayWidth: number; displayHeight: number }
  }
  openai?: {
    logprobs?: boolean
    seed?: number
    reasoningEffort?: 'low' | 'medium' | 'high'
    modalities?: ('text' | 'audio')[]
  }
  gemini?: {
    safetySettings?: Array<{ category: string; threshold: string }>
    candidateCount?: number
  }
  ollama?: {
    keepAlive?: string
    numCtx?: number
  }
}
```

**规则**：
- 中性 `Message` **绝对不含** provider 特殊字段
- 只有需要 provider 特殊行为的调用者（少数）会填 `rawMeta`
- Provider 适配器**只读自己命名空间的 key**，未知 key 忽略（跨 provider 切换时静默降级）
- `rawMeta` 由**调用点显式传**（比如某个 skill/plugin 想让 anthropic 打 cache breakpoint），Runner 不主动填

**"cache" 字段 vs "rawMeta.anthropic.cacheControl"**：`request.cache` 是**通用抽象**（策略 + TTL），provider 适配器翻译成各家实现；`rawMeta.anthropic.cacheControl` 是**逐消息精细控制**，只在需要人工插缓存 breakpoint 时用。二者可共存，rawMeta 优先级更高。

### 3.5 Provider 适配差异表

四家主要 provider 的适配点，实现时按此表逐项映射：

| 维度                       | Anthropic Messages           | OpenAI Chat Completions      | Gemini generateContent        | Ollama                        |
|----------------------------|------------------------------|------------------------------|-------------------------------|-------------------------------|
| 端点                       | `POST /v1/messages`          | `POST /v1/chat/completions`  | `POST /v1/models/*:streamGenerateContent` | `POST /api/chat`             |
| System prompt              | 顶层 `system` 字段           | `messages[0].role='system'`  | **无 system 字段**，塞第一条 user | `messages[0].role='system'`  |
| Tool 定义位置              | `tools` 顶层                 | `tools` 顶层                 | `tools[].functionDeclarations[]` | 视版本，v0.3+ 支持            |
| Tool 结果表达              | user message + `tool_result` | tool role + `tool_call_id`   | function role + `functionResponse` | tool role                    |
| 图像                       | `content[].type='image'`     | `content[].type='image_url'` | `parts[].inlineData`          | `images[]` base64             |
| 思考                       | `thinking` content type      | `reasoning` field (o1/o3)    | 无原生 field                  | 无                            |
| 缓存                       | `cache_control` breakpoint   | 自动（无控制）                | context caching (需 explicit) | 无                            |
| 并行工具                   | ✅                          | ✅                          | ⚠️ 部分模型                    | ⚠️ 视模型                     |
| Stream 帧格式              | SSE `event: content_block_delta` | SSE `data: {...}` 累加 delta | SSE JSON lines                | NDJSON                       |
| 错误码                     | `400 invalid_request_error`  | `429 rate_limit`             | `429 RESOURCE_EXHAUSTED`      | `500` (通常)                  |
| Token 计数                 | `/v1/messages/count_tokens`  | tiktoken 近似                | `countTokens` 端点            | 无                            |

**每个 provider-\* 包必须实现**：
1. Message ↔ provider format 双向转换器（含图像/工具/思考的差异处理）
2. Stream 帧 → `ProviderChunk` 归一化
3. 错误码 → `ProviderError`（含 `retryable: boolean` / `category`）
4. capabilities 描述（静态或按模型动态）
5. Auth 挂载（读 `packages/auth` 拿 credential）
6. `http-kit` 客户端配置（timeout / proxy / retry base）

### 3.6 ProviderError 分类

```ts
export interface ProviderError extends Error {
  provider: string
  model?: string
  status?: number
  category: ProviderErrorCategory
  retryable: boolean
  retryAfterMs?: number                             // 429 时优先用
  cause?: unknown
}

export type ProviderErrorCategory =
  | 'network'           // 连接失败 / 超时 / DNS
  | 'auth'              // 401 / 403 → 提示重新 login
  | 'rate_limit'        // 429
  | 'quota'             // 余额不足
  | 'invalid_request'   // 400 → 大概率是我们的 bug
  | 'content_filter'    // 被 safety 拦
  | 'model_not_found'   // 404
  | 'server'            // 5xx
  | 'context_length'    // context 超限 → 触发 context 压缩重试
  | 'unknown'
```

**每类的 Router / Runner 反应**（详见 §3.9）：

| 类别             | Router 行为                          | Runner 行为                            |
|------------------|--------------------------------------|----------------------------------------|
| `network`        | 指数退避后同 provider 重试；3 次失败 fallback | 中转失败 → 用户可见的 retry 提示     |
| `auth`           | ❌ 不 fallback（换 provider 也没 key） | 立即报错，提示 `volund login`           |
| `rate_limit`     | 首选 fallback，无 fallback 时按 retryAfter 退避 | 显示等待时间                    |
| `quota`          | fallback                             | 无 fallback 时报错                      |
| `invalid_request`| ❌ 不 fallback（同样会 400）           | 报错到 telemetry，用户可见错误           |
| `content_filter` | fallback（不同 provider 尺度不同）    | 用户可见提示                             |
| `model_not_found`| fallback                             | 提示模型不可用                           |
| `server`         | 指数退避 + fallback                  | 同 network                              |
| `context_length` | ❌ 不 fallback（换 provider 也超）     | Runner 触发**紧急压缩** + 重试一次      |
| `unknown`        | 保守：一次退避 + fallback             | 报错                                    |

### 3.7 Router 契约（packages/router）

```ts
export interface RouterPolicy {
  readonly name: string

  /** 每 turn / 每次 provider 调用前询问 */
  pick(ctx: RouterContext, hint?: RouterHint): Promise<RouterDecision>

  /** provider 报错后询问是否 fallback */
  onError(err: ProviderError, ctx: RouterContext): Promise<RouterDecision | 'give-up'>

  /** 生命周期 */
  init?(config: RouterConfig): Promise<void>
  dispose?(): Promise<void>
}

export interface RouterContext {
  session: SessionSnapshot                          // 只读，含 cumulativeUsage / lastProvider 等
  turnId: TurnId
  attemptCount: number                              // 当前 turn 内已尝试次数（用于退避）
  budget?: { costUSDMax?: number; timeMsMax?: number }
}

export interface RouterHint {
  explicitModel?: string                            // 用户输入 `@gpt-4 ...` 时提取
  role?: 'planner' | 'coder' | 'reviewer' | 'chat'  // hooks/plugins 可以塞角色暗示
  costPreference?: 'cheap' | 'balanced' | 'quality'
}

export interface RouterDecision {
  provider: ProviderClient                          // 已实例化
  model: string
  reason: string                                    // 用于 telemetry / UI 展示
  metadata?: Record<string, unknown>
}
```

**关键决策**：
- Router **每次** provider 调用前都被询问，可以在同一 turn 内动态切换 —— **但受 sticky 约束**（见下）。
- Router **不感知具体 provider 实现**，只操作 `ProviderClient` 实例。
- Router 状态（哪个 provider 冷却中、剩余重试等）由 `RouterPolicy` 实例内部维护，不放 `SessionState`。
- Runner 只调 `router.pick(ctx, hint)`；错误处理调 `router.onError(err, ctx)`；不直接实例化 provider。
- `apps/cli` 启动时按用户配置 new 出一个 `RouterPolicy`，注入 Runner。

#### 3.7.1 ★ Turn 内 Provider Sticky（B4）

**问题**：tool_use_id 是 provider-specific 格式（Anthropic 用 `toolu_01...`，OpenAI 用 `call_...`）。一个 turn 内若产生了 tool_use 后 fallback 切 provider，新 provider 无法识别原 tool_use_id → tool_result 匹配失败 → 500 或错答。

**规则**：

1. **首轮 / 纯文本轮可自由切换**：turn 内**尚未产生任何 `tool_use`** 的 provider call，Router 可任意切换（fallback / role-route / etc.）。
2. **一旦产生 tool_use → 锁定 provider**：Runner 侧记录 `stickyProvider = <当前 provider>`（见 §2.4），本 turn 剩余 loop 迭代直接复用 `stickyProvider`，**不再调 `router.pick`**。
3. **锁定期内出错走 `onError` 但只能同 provider 重试**：
   - `router.onError` 返回的 `RouterDecision` 若 `provider !== stickyProvider` → Runner 拒绝该 decision，emit `error.raised { code: 'provider_sticky_violation' }` 并将 `tool_loop_exhausted` 语义处理（结束 turn，让用户重发）；
   - `onError` 也可返回 `'give-up'` → Runner 直接结束 turn。
4. **turn 边界解锁**：`turn.completed` 或 `turn.aborted` 后 `stickyProvider` 清空，下一 turn 从 `pick` 重新决策。
5. **配置逃生舱**：`[router] allow_cross_provider_tool_use = false`（默认）；显式设为 `true` 时 Runner 会在切换 provider 前调 `provider.translateToolUseId(oldId, newProvider)` 尝试转换（provider-kit 契约扩展，v2 才实现）。

**为什么这么严**：设计追求"可预测的失败"。宁可让用户看到"provider 冷却中，请等 30s 再试"，也不要一次 fallback 静默产生错答。

**Router 实现者义务**：`FallbackRouter` / `RoleRouter` 等在 `pick` / `onError` 时须查 `ctx.session.turn.stickyProvider`；若已锁定，直接返回锁定 provider（无视 hint / cost 偏好）。Runner 会兜底校验，但 Router 应主动尊重语义以获得更好 telemetry。

### 3.8 Router 策略实现

#### 3.8.1 SingleProviderRouter（MVP 必备）

```ts
class SingleProviderRouter implements RouterPolicy {
  constructor(private client: ProviderClient, private defaultModel: string) {}

  async pick(_ctx, hint) {
    return {
      provider: this.client,
      model: hint?.explicitModel ?? this.defaultModel,
      reason: 'single-provider'
    }
  }

  async onError(err, ctx) {
    if (!err.retryable) return 'give-up'
    if (ctx.attemptCount < 3 && err.category !== 'context_length') {
      await sleep(backoff(ctx.attemptCount, err.retryAfterMs))
      return { provider: this.client, model: this.defaultModel, reason: 'retry' }
    }
    return 'give-up'
  }
}
```

**用途**：MVP 唯一实现。用户配置 `provider: 'anthropic'` + `model: 'claude-sonnet-4-5'` 即用此策略。

#### 3.8.2 FallbackRouter（v1.1）

按优先级列表串行尝试；当前 provider 报可 fallback 错误时切下一个。冷却期内不重试失败的 provider。

```
config:
  chain:
    - { provider: 'anthropic', model: 'claude-sonnet-4-5', priority: 100 }
    - { provider: 'openai',    model: 'gpt-4o',            priority: 80 }
    - { provider: 'ollama',    model: 'qwen2.5-coder:32b', priority: 10 }
  cooldownSeconds: 60
```

- Cool-down 期内跳过；空闲时优先级最高的候选被选中。
- 一 turn 内切换会 `emit router.switched` 事件（UI 展示"已切换到 GPT-4o"）。
- 上下文差异（比如 Claude → GPT-4 后思考消息处理不同）由 provider 适配器负责归一。

#### 3.8.3 RoleRouter（v1.2）

根据 `hint.role` 分派到不同模型（比如 planner 用便宜模型，coder 用强模型）：

```
config:
  roles:
    planner:  { provider: 'openai',    model: 'gpt-4o-mini' }
    coder:    { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    reviewer: { provider: 'anthropic', model: 'claude-opus-4' }
    default:  { provider: 'anthropic', model: 'claude-sonnet-4-5' }
```

`hint.role` 来源：
- 用户输入前缀（`@planner ...`）
- Hook 注入（用户配置 hook 根据 prompt 分类角色）
- 内置：subagent dispatch 时传入其 agentType

#### 3.8.4 CostAwareRouter（v2）

根据 session `cumulativeUsage.costUSD` 与 budget 动态选择：预算未到用强模型，接近上限降级到便宜模型。规则化配置，不做黑箱。

#### 3.8.5 未来（out of scope for MVP）

- SemanticRouter（用小模型分类 prompt）—— 复杂度高、不确定收益，push 到 v2
- Blend / Ensemble —— 多模型投票，实验性

### 3.9 显式路由：`@model` 前缀

用户可在输入首行加 `@<alias> ...` 显式指定模型：

```
@sonnet 帮我重构这段代码
@gpt-4o-mini 简单问一下
```

> **UI 侧触发**：`@` 是**能力选择器**入口，在 InputBox 里键入 `@` 会先弹 file / model 二选一 popup（见 §7.5.3）。选中 model 分支后进入 alias 补全；用户也可以用 `@!<alias>` 直接跳过选择器。选择器落到 model 分支后，剥离规则与本节一致。

**流程**：
1. `apps/cli` 输入解析器识别 `@<alias>` 前缀，剥离后传给 Runner
2. Runner 把 `explicitModel: <alias>` 放进 `RouterHint`
3. Router 优先使用 `explicitModel`（各策略实现自决是否尊重）
4. `SingleProviderRouter` 直接用；`FallbackRouter` / `RoleRouter` 视作 override，忽略角色/优先级
5. 未识别的 alias → 报错列出可用 alias（用户配置里维护 `models.aliases`）

**Alias 配置**（`~/.volund/config.toml`）：

```toml
[models.aliases]
sonnet       = { provider = "anthropic", model = "claude-sonnet-4-5" }
opus         = { provider = "anthropic", model = "claude-opus-4" }
"gpt-4o"     = { provider = "openai",    model = "gpt-4o" }
"gpt-4o-mini"= { provider = "openai",    model = "gpt-4o-mini" }
"qwen"       = { provider = "ollama",    model = "qwen2.5-coder:32b" }
```

Alias 是**用户面**的短名字，避免记忆 provider 全称。

### 3.10 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| `Runner` 禁止 import 任何具体 `provider-*` 包                                     | ESLint 依赖规则                                 |
| `Runner` 只持有 `RouterPolicy` 引用，不直接持有 `ProviderClient`                   | `Runner` 构造函数签名                            |
| `provider-*` 内**禁止** `import { fetch } from 'undici'`，必须走 `http-kit`         | ESLint no-restricted-imports                    |
| `provider-*` 内**禁止**直接读 `process.env.XXX_API_KEY`，必须走 `auth`              | ESLint no-restricted-imports                    |
| `provider-*` 内**禁止**拼接 system prompt（该字段由 Runner 从 PromptComposer 拿）    | code review                                     |
| 中性 `Message` **禁止**含 provider 独有字段；provider 独有走 `rawMeta.<provider>`    | 类型约束                                        |
| provider 适配器**只读**自己命名空间的 `rawMeta` key，未知 key 忽略                   | 单元测试                                        |
| `ProviderChunk.error` 与 throw **二选一**，不双发                                    | 单元测试                                        |
| `AbortSignal` 传递到底层 http 请求                                                 | 单元测试（发大请求 abort 检查连接断开）           |
| `ProviderCapabilities.maxContextTokens` 是**静态**声明，与实际 API 一致              | provider 包发布前手动核对                        |
| Router 错误时**必须**决定 `retry` / `fallback` / `give-up`，不能默默吞异常          | Runner 层强制                                    |
| Router 切换时**必须** emit `router.switched` 事件                                   | 单元测试                                        |

### 3.11 里程碑

- **L1（MVP）**：`provider-anthropic` + `SingleProviderRouter`；`provider-kit` 完整契约；capability 静态描述
- **L2**：`provider-openai` + 相同 Router；跨 provider 一致性测试
- **L3**：`FallbackRouter`；错误分类完整；冷却机制
- **L4**：`provider-gemini` + `provider-ollama`；`RoleRouter`；`@model` alias 解析

## §4 工具体系与权限

本节定义 `packages/tool-kit`（契约）、`packages/tools`（内置工具）、`packages/permission`（决策层）的边界。

### 4.1 设计目标

| 目标                    | 具体含义                                                                     |
|-------------------------|------------------------------------------------------------------------------|
| **工具是一等公民**      | 所有能改变世界的操作走 Tool，包括内置、MCP、插件贡献的。                       |
| **权限声明式**          | Tool 静态声明 `PermissionSpec`；用户配置 allowlist；运行时决策 + 弹窗。         |
| **沙箱兜底**            | 副作用系工具（Bash / Write / Edit）必须过 Rust sandbox 或 explicit override。   |
| **可扩展**              | 内置 / MCP / 插件三种来源都注册到同一 `ToolRegistry`。                          |
| **可撤销 / 可审计**     | 破坏性操作应可回溯（backup / dry-run）。                                        |
| **失败隔离**            | 单 tool 出错不炸 session（转 `tool_result.isError=true`）。                     |

### 4.2 Tool 契约（tool-kit）

```ts
export interface Tool<Input = unknown> {
  readonly name: string                             // 唯一，全局 registry key
  readonly description: string                      // 传给模型
  readonly inputSchema: JSONSchema                  // JSON Schema，序列化给 provider
  readonly outputHint?: string                      // 补充告诉模型输出形态

  /** 声明此工具在给定 input 下需要什么权限 */
  permissionSpec(input: Input): PermissionSpec

  /** 是否只读（不产生副作用）。用于 UI 提示 + 自动批准策略 */
  readonly readonly?: boolean

  /** 执行超时，默认 60s */
  readonly timeoutMs?: number

  /** 并行安全性：Runner 决定并行度时参考 */
  readonly parallelSafe?: boolean                   // 默认 true

  /** 主执行 */
  invoke(input: Input, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolContext {
  readonly abortSignal: AbortSignal
  readonly session: SessionSnapshot                 // 只读，含 cwd / turnId
  readonly native: NativeBridge                     // 走沙箱的入口
  readonly logger: Logger                           // 写 telemetry
  readonly ui: ToolUiPort                           // 请求用户输入（少用；主要靠 permission）
}

export interface ToolResult {
  content: ContentPart[]                            // 复用 §2 的中性表示
  isError?: boolean
  meta?: ToolResultMeta
}

export interface ToolResultMeta {
  durationMs: number
  bytesRead?: number
  bytesWritten?: number
  filesTouched?: string[]                           // storage 侧可用于审计
  costImpact?: 'safe' | 'moderate' | 'high'         // UI 展示
}
```

**关键约定**：
- Tool **不感知** provider（结果是中性 `ContentPart[]`）
- Tool **不直接** 调 permission，Runner 层统一调
- Tool **必须** 尊重 `abortSignal`（长任务定期检查）
- Tool 抛异常 = 违规。所有错误应转 `{ isError: true, content: [{ type: 'text', text: '...' }] }`

### 4.3 内置工具清单（packages/tools）

| 名字        | 类型     | 描述                        | readonly | 沙箱 | 依赖 native            |
|-------------|----------|-----------------------------|----------|------|------------------------|
| `Read`      | 文件读   | 读取指定文件片段            | ✅       | 只读白名单 | volund-fs (可选)       |
| `Write`     | 文件写   | 创建/覆写文件                | ❌       | ✅   | volund-fs (diff 显示)  |
| `Edit`      | 文件改   | 精确字符串替换               | ❌       | ✅   | volund-fs              |
| `MultiEdit` | 文件改   | 批量 Edit（原子）            | ❌       | ✅   | volund-fs              |
| `Bash`      | 命令执行 | shell 命令                   | ❌       | **必须** | volund-sandbox    |
| `Grep`      | 搜索     | ripgrep（Rust addon）        | ✅       | 只读 | volund-search          |
| `Glob`      | 搜索     | 文件通配                    | ✅       | 只读 | fast-glob (JS fallback) |
| `Todo`      | 状态     | Todo 列表（session-scoped） | ✅       | 无   | -                      |
| `Task`      | 分派     | 启动 subagent               | ❌       | 无（子 agent 各自管）| subagent 包             |
| `WebFetch`  | 网络     | 抓 URL（可选，v2）           | ✅       | 允许 net | http-kit               |
| `WebSearch` | 网络     | 搜索引擎（v2）               | ✅       | 允许 net | 各家 API              |

**MVP L1** 只上：`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `Todo`。

**Task / WebFetch / WebSearch** 分 L2-L4 逐步加。

### 4.4 权限模型（packages/permission）

```ts
export interface PermissionSpec {
  fs?: {
    read?: string[]                                 // 具体路径或 glob
    write?: string[]
  }
  bash?: {
    command: string                                 // 完整命令，permission 侧展示 + 匹配
  }
  net?: {
    url: string
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  }
  env?: {
    read?: string[]                                 // 环境变量名
  }
  custom?: Record<string, unknown>                  // 插件扩展点（少用）
}

export interface PermissionRequest {
  toolName: string
  spec: PermissionSpec
  input: unknown                                    // 原始 input，用于弹窗展示
  session: SessionSnapshot
  attempt: number                                   // 首次 / 二次（用户已改过决策）
}

export type PermissionDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-session' }                       // 加入 SessionState.permissionCache
  | { kind: 'allow-project' }                       // 写入 <cwd>/.volund/permissions.toml
  | { kind: 'allow-forever' }                       // 写入 ~/.volund/permissions.toml
  | { kind: 'deny' }                                // 单次拒绝
  | { kind: 'deny-forever' }                        // 全局黑名单
```

**决策链**（从上到下，任一命中即返回）：

```
permission.request(req):
  1. 项目黑名单？→ deny
  2. 全局黑名单？→ deny
  3. SessionState.permissionCache 命中？→ allow
  4. 项目 permissions.toml 命中？→ allow
  5. 全局 permissions.toml 命中？→ allow
  6. 内置 auto-allow 规则（如 Read 到 cwd 内、Bash 白名单命令）？→ allow
  7. --dangerously-skip-permissions 标志？→ allow（写日志）
  8. 无匹配 → 弹窗询问用户 → 结果按 decision 写入相应存储
```

**auto-allow 内置规则**（保守，用户可关）：
- `Read` 目标在 `cwd` 内 → allow-session
- `Grep` / `Glob` 在 `cwd` 内 → allow-session
- `Bash` 命令匹配 `^(ls|pwd|git status|git diff|git log|node --version|...)` 只读子集 → allow-once
- 其它一律弹窗

**弹窗触发**：`permission` 内部持有 `PromptHandler`（由 `apps/cli` 注入 ui 实现，见 §1.5）。permission 内部**串行队列**弹窗，一次只显示一个（防刷屏，见 §2.5）。

### 4.5 PermissionSpec ↔ 沙箱执行

**核心决策**：**permission 是策略层，sandbox 是执行层**。permission 允许了不代表就直接执行，仍要过 sandbox（如果工具声明了 sandbox 需求）。

流程：

```
Tool.invoke:
  1. Tool 内部拿到 input，构造 native call
  2. native.exec({ command, permissions: { fs: {...}, bash: {...} } })
     ↑ 这里的 permissions 是从 PermissionSpec 翻译过来的沙箱 profile
  3. native-bridge 转发到 volund-sandbox binary：
     - macOS: sandbox-exec + 动态生成 sbpl profile
     - Linux: landlock + seccomp
     - Windows: AppContainer（v2；MVP 提示 --dangerous-no-sandbox）
  4. sandbox 生成 profile 限制 syscall，即使 tool 有 bug 也无法逃逸
```

**双层安全**：
- **Permission** 防止 tool 拿到不该有的 spec（用户视角）
- **Sandbox** 防止 tool 实现绕过 spec（技术视角）

某些工具（`Todo` / 纯 JS `Glob`）没有 sandbox 需求，permission 通过后直接执行。

### 4.6 危险操作的额外保护

针对**破坏性**操作，permission 之外还有额外保护：

| 操作类型               | 额外保护                                                                     |
|------------------------|------------------------------------------------------------------------------|
| `Write` 覆盖已有文件   | 提示 "will overwrite N bytes"，diff 预览                                     |
| `Edit` 大规模变更      | > 100 行改动时提示 review                                                    |
| `Bash` `rm -rf` 类     | 硬编码 pattern 黑名单，直接拒绝（可用 `--dangerously-...` 覆盖）              |
| `Bash` `sudo`          | 直接拒绝 + 提示"不支持 sudo，请手动执行"                                     |
| `Bash` 修改 shell RC   | 匹配 `~/.zshrc` `~/.bashrc` 等 → 强制弹窗                                    |
| 网络类 (`WebFetch`)    | 首次访问某域名 → 弹窗（allow-session by domain）                              |
| 跨 cwd 的 fs 操作      | 超出 `cwd` 边界 → 弹窗，即使 permission cache 有                              |

### 4.7 Tool 注册与来源

```ts
export interface ToolRegistry {
  register(tool: Tool, source: ToolSource): Disposable
  unregister(name: string): void
  get(name: string): Tool | undefined
  forProvider(client: ProviderClient): ToolSchema[]  // 序列化成 provider 格式
}

export type ToolSource =
  | { kind: 'builtin' }
  | { kind: 'mcp',    server: string }
  | { kind: 'plugin', plugin: string }
```

**来源与名字冲突**：
- 内置工具占用固定名字（`Read` / `Write` / `Edit` / ...）
- MCP / 插件工具**必须**加前缀：MCP 用 `mcp:<server>:<tool>`；插件用 `plugin:<name>:<tool>`
- Registry 检测重名 → 拒绝注册 + 记 `error.raised`

**注册时机**：
- 内置：`apps/cli` 启动时注册
- MCP：`mcp-client` 连接后按 `list_tools` 结果注册
- 插件：`plugin-runtime` 加载插件调 `activate` 时通过 bridge 注册

**卸载**：所有注册返回 `Disposable`，MCP 断连 / 插件禁用时批量 dispose。

### 4.8 Tool 输入验证

- Registry 保存 `inputSchema` (JSON Schema)
- Runner 拿到 `tool_use` 后，先 **schema 验证 input**：
  - 通过 → 调 `permissionSpec(input)` → 走权限流程
  - 失败 → 立即返回 `{ isError: true, content: [{ type: 'text', text: 'Invalid input: <ajv error>' }] }`，不进 permission，不进 tool
- 这样模型看到错误后能自纠

### 4.9 Tool 结果规范化

- **文本超长截断**：超过 `TOOL_RESULT_MAX_TOKENS`（默认 25k tokens）→ 中段截断 + `[... truncated N tokens ...]` 标记
- **二进制内容**：转成 `{ type: 'file', source: AttachmentRef, mime, filename }`，进入 attachment 生命周期（§2.1.1）
- **错误消息**：不暴露内部路径 / 敏感 env；`VolundError.toContentText()` 统一脱敏
- **诊断信息**：`meta` 里塞 `durationMs` / `bytesRead` 等，UI 侧展示，模型看不到

### 4.10 特殊工具：Task（subagent）

`Task` 工具是启动 subagent 的入口，见 §2.7 生命周期。

**特殊点**：
- 权限：`Task` 本身几乎不需 permission（不直接触碰系统），但**子 agent 的 tool 调用各自过 permission**
- 结果：从子 session 的最后一条 assistant message 提取 text 组成 tool_result
- 失败：子 agent 崩溃 = `tool_result.isError=true`，父 session 不受影响
- 嵌套上限：默认 3 层（§2.7）；`Task` 内部检查 `ctx.session.turn.parentDepth` 拒绝超深

### 4.11 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| Tool 抛异常 = bug（应 catch 内部转 `isError`）                                     | Runner 兜底 + 单元测试                          |
| Tool **禁止** import 具体 provider 包 / router / core Runner                       | ESLint 依赖规则                                 |
| Tool **禁止**绕过 `permissionSpec` 声明的资源边界（比如声明 read 却 write）         | code review                                     |
| Tool **禁止**直接调 native binary，必须走 `native-bridge`                           | ESLint no-restricted-imports                    |
| 破坏性 tool（Write / Edit / Bash）**必须**声明 sandbox 需求                        | tool 单元测试                                   |
| Permission 决策链**必须**按 §4.4 顺序，禁止跳过                                     | permission 单元测试                             |
| `permissionCache` 只在 session 内有效，进程重启失效                                 | SessionState 不持久化 permissionCache            |
| `permissions.toml` 修改**必须**通过 permission API，不允许工具直接写                | ESLint 白名单                                   |
| `--dangerously-skip-permissions` **必须**打警告日志 + UI 顶栏红条                  | apps/cli 强制                                   |
| MCP / 插件工具**必须**加前缀（`mcp:` / `plugin:`）                                 | Registry.register 校验                          |
| Tool `outputHint` **禁止**塞 secret / API key                                     | code review                                     |
| Tool 内的日志**必须**走 `ctx.logger`，不允许 `console.log`                          | ESLint no-console                               |

### 4.12 里程碑

- **L1（MVP）**：`Read` / `Write` / `Edit` / `Bash`（sandbox 必须） / `Grep` / `Glob` / `Todo`；permission 决策链完整；auto-allow 保守规则；弹窗串行
- **L2**：`MultiEdit`；danger patterns 黑名单；permission `allow-project` / `allow-forever` 存储
- **L3**：`Task` + subagent；MCP 工具注入；插件工具注入
- **L4**：`WebFetch` / `WebSearch`；网络 permission 按 domain；跨 cwd 强制弹窗

## §5 Rust 侧车（沙箱 + 搜索 + FS）

本节定义 `crates/*` 与 `packages/native-bridge` 的边界。

### 5.1 设计目标

| 目标                | 具体含义                                                             |
|---------------------|----------------------------------------------------------------------|
| **性能敏感走 Rust** | 搜索（ripgrep）、AST（tree-sitter）、大文件 diff、tokenize            |
| **安全敏感走 Rust** | Shell 命令沙箱执行（syscall 隔离）                                    |
| **单点接入**        | JS 侧只有 `packages/native-bridge` 一个包能调 Rust；其它包禁 direct  |
| **JS 有 fallback**  | 找不到 native binary 时，只读能力降级到 JS 实现；副作用能力拒绝并提示  |
| **可独立发布**      | 每个平台每个产物一个 npm 包，通过 `optionalDependencies` 挂载          |

### 5.2 Rust 产物清单

| 名称                | 类型              | 主要能力                                                    | 落盘位置                          |
|---------------------|-------------------|-------------------------------------------------------------|-----------------------------------|
| `volund-sandbox`    | 独立可执行二进制  | 执行 shell 命令 + syscall 隔离；**沙箱内执行插件 Node 子进程**  | `platforms/native-sandbox-*/bin/` |
| `volund-search`     | napi-rs .node     | ripgrep 绑定 + tree-sitter 语法查询                          | `platforms/native-search-*/`      |
| `volund-fs`         | napi-rs .node     | 大文件 diff / tokenize（tiktoken-rs 或 gpt-tokenizer）        | `platforms/native-fs-*/`          |

**为什么 `volund-sandbox` 是独立二进制而非 napi addon**：
- 沙箱需要 fork/exec 新进程 + 挂载 syscall 过滤，Node 主进程内做会污染
- 独立二进制让 sandbox 有自己的进程生命周期，崩溃不影响 volund 主进程
- 便于用户手动审查（`file volund-sandbox` + 校验签名）
- **同一套框架同时服务 Bash 与 Plugin**：v3 修正后，插件也在 volund-sandbox 子进程内跑（见 §5.3 `--run-plugin` 模式与 §6.4.3），避免"Bash 有 Rust 沙箱、插件没沙箱"的自相矛盾

### 5.3 volund-sandbox 设计

**两种运行模式**，共用同一套 sandbox profile 生成 + 应用逻辑：

#### 5.3.1 `exec` 模式（Bash 命令，默认）

```
职责：接收 JSON 配置 → 生成平台原生沙箱 profile → 执行子命令 → 返回结果

CLI：volund-sandbox exec  （或省略子命令，兼容默认）

输入（stdin JSON）：
  {
    "command": "git status",
    "cwd": "/path/to/project",
    "timeout_ms": 60000,
    "permissions": {
      "fs": { "read": ["/path/to/project/**"], "write": ["/path/to/project/**"] },
      "net": false,
      "env": { "read": ["HOME", "PATH", "LANG"] }
    },
    "env": { "CUSTOM_VAR": "value" }
  }

输出（stdout JSON）：
  {
    "stdout": "...",
    "stderr": "...",
    "exit_code": 0,
    "duration_ms": 123,
    "sandbox_violations": []                          // 如果有 syscall 被拦
  }
```

#### 5.3.2 `--run-plugin` 模式（插件宿主，v3 新增）

```
职责：在沙箱内 execve 一个 Node 进程加载指定插件 index.js，
      通过预先打开的 fd 3 与父 volund 进程做 JSON-RPC bridge

CLI：volund-sandbox --run-plugin \
       --entry <pluginDir>/index.js \
       --data-dir <perPluginDataDir> \
       --sandbox-profile <profile-json>     # 可 @file: 传路径
       --bridge-fd 3                        # 由父进程 posix_spawn 时保留

内部流程：
  1. 解析 profile-json（同 exec 模式，含 fs/net/env 三段）
  2. 保留 fd 3（bridge socket 或 pipe）不关闭
  3. 应用平台 sandbox（sandbox-exec / landlock+seccomp）
  4. execve 系统 node 二进制，argv = [node, <volund-runtime>/plugin-host.mjs, <entry>, <dataDir>]
  5. 子进程内 plugin-host.mjs 从 fd 3 读写 JSON-RPC NDJSON
  6. 进程退出 → volund-sandbox 自身退出，退出码透传

profile 差异 vs exec 模式：
  - fs.read: pluginDir 只读 + Node 内置模块路径 + tzdata 等
  - fs.write: dataDir 独占（每插件一个）
  - net: 按 manifest.permissions.net 白名单开
  - env: 强制 clear_env + 只保留最小集（PATH, HOME, LANG, NODE_OPTIONS 白名单化）
  - syscall 额外拒绝：ptrace / mmap w+x（阻止 JIT 逃逸）
```

#### 5.3.3 平台实现（两模式共用）

| 平台      | 机制                                | 依赖                       |
|-----------|-------------------------------------|----------------------------|
| macOS     | `sandbox-exec` + 动态生成 sbpl      | 系统自带                    |
| Linux     | `landlock` (LSM) + `seccomp` (BPF)  | Kernel >= 5.13             |
| Windows   | AppContainer (v2；MVP 不支持)        | Win10+                      |

**降级策略**：
- Kernel 不支持 landlock → 提示用户升级；`--dangerously-no-sandbox` 覆盖
- Windows MVP 无沙箱 → Bash 与插件默认拒绝执行，`--dangerously-no-sandbox` 覆盖
- 沙箱 binary 缺失 → 同上（副作用工具 + 插件系统拒绝）

**profile 生成规则**（`crates/volund-sandbox/src/profile.rs` 单一权威）：
- `fs.read` 只读白名单 → landlock read-only path binding
- `fs.write` 读写白名单 → landlock read-write
- `net: false` → seccomp 拦 `socket` / `connect`；`net: { hosts: [...] }` → 允许并加应用层再校验
- `env.read` → clear_env + 只保留白名单
- **插件模式额外**：拒绝 `ptrace` / `process_vm_readv` / 可写可执行内存映射

**关键决策**：
- Rust 侧**不解析** shell（用户命令原样传给 `/bin/sh -c`），沙箱做 syscall 层隔离
- Rust 侧**不解析** JS（`--run-plugin` 只负责起 Node + 应用 profile + 保留 fd）
- 超时通过 `SIGKILL` + `wait` 保证不留孤儿进程（两模式一致）
- 大量 stdout → 环形 buffer + 尾部保留（防 tool_result 撑爆；插件模式 stdout/stderr 也走同样限流并转 telemetry）
- **profile 生成对 Bash 与 Plugin 是同一份代码**：唯一区别是"从哪个数据结构映射到 profile"（`PermissionSpec` vs `manifest.permissions`），映射函数在 `native-bridge` 侧完成，Rust 只见最终 profile-json

### 5.4 volund-search 设计

**napi-rs addon**，导出：

```ts
// packages/native-bridge/src/search.ts（Rust 生成的 TS 定义）
export function search(opts: SearchOpts): AsyncIterable<SearchMatch>
export function astQuery(opts: AstQueryOpts): AsyncIterable<AstMatch>

interface SearchOpts {
  pattern: string
  path: string                                        // 起点
  glob?: string                                        // 过滤
  caseInsensitive?: boolean
  maxMatches?: number
  ignore?: string[]                                    // gitignore-like
}

interface SearchMatch {
  path: string
  lineNumber: number
  line: string
  span?: { start: number; end: number }               // 字节偏移
}
```

- 基于 `grep` crate（ripgrep 底层）+ `ignore` crate
- 支持 tree-sitter 语法查询（`astQuery`），比如"找所有导出的 async function"
- 返回是**流式**的（napi-rs `AsyncIterable`），避免大项目一次性拉完

**JS Fallback**（找不到 native）：
- `search` → `fast-glob` + `readline` + JS RegExp（慢 10-100x，但可用）
- `astQuery` → 直接返回错误（tree-sitter JS 太重不做 fallback）

### 5.5 volund-fs 设计

**napi-rs addon**，导出：

```ts
export function computeDiff(before: string, after: string, opts?: DiffOpts): string  // unified diff
export function countTokens(text: string, model: string): number                       // tiktoken-rs
export function readLarge(path: string, opts: ReadLargeOpts): Promise<string>          // mmap + 编码检测
```

- Diff 用 `similar` crate（Rust patience diff，比 JS 快 10x+）
- Token 计数用 `tiktoken-rs`（BPE 缓存 in-memory，比重复 JS 实现快）
- 大文件读取用 mmap + `encoding_rs`（避免整文件读 UTF-8 再截）

**JS Fallback**：
- `computeDiff` → `diff` npm package（慢但可用）
- `countTokens` → `gpt-tokenizer` npm package（准确度低一点）
- `readLarge` → `fs.createReadStream` + iconv-lite

### 5.6 native-bridge 结构（packages/native-bridge）

```
packages/native-bridge/
├─ src/
│  ├─ index.ts                # 对外统一入口 export NativeBridge
│  ├─ resolver.ts             # 平台包名解析 + require.resolve
│  ├─ sandbox.ts              # 封装 volund-sandbox 子进程调用
│  ├─ search.ts               # 封装 volund-search addon
│  ├─ fs.ts                   # 封装 volund-fs addon
│  ├─ fallback/
│  │  ├─ search-js.ts         # fast-glob + regexp
│  │  └─ fs-js.ts             # diff + tokenizer JS 实现
│  └─ types.ts                # NativeBridge 接口 + AttachmentRef handle
└─ package.json               # 声明 18 个 platform 包为 optionalDependencies
```

**统一接口**：

```ts
export interface NativeBridge {
  readonly available: {
    sandbox: boolean
    search: boolean
    fs: boolean
  }

  //-------- sandbox --------
  exec(opts: ExecOpts, signal: AbortSignal): Promise<ExecResult>

  //-------- search --------
  search(opts: SearchOpts, signal: AbortSignal): AsyncIterable<SearchMatch>
  astQuery(opts: AstQueryOpts, signal: AbortSignal): AsyncIterable<AstMatch>

  //-------- fs --------
  computeDiff(before: string, after: string, opts?: DiffOpts): Promise<string>
  countTokens(text: string, model: string): Promise<number>
  readLarge(path: string, opts?: ReadLargeOpts): Promise<string>

  //-------- attachment handle --------
  allocHandle(bytes: Uint8Array): NativeHandle       // 传给 provider 用
  releaseHandle(handle: NativeHandle): void
}
```

**解析逻辑**（`resolver.ts`）：

```
resolveNative(kind):
  triple = `${process.platform}-${process.arch}${libcSuffix()}`
  pkg = `@volund-code/native-${kind}-${triple}`
  try:
    return require.resolve(pkg)                     # 平台包已安装
  catch:
    return null                                     # 触发 fallback
```

**available 探测在启动时执行一次**，结果传给 tool-kit / permission，用于：
- `Bash` 检查 sandbox 是否可用 → 不可用则拒绝或走 --dangerous 覆盖
- `Grep` 检查 search 是否可用 → 不可用则用 JS fallback

### 5.7 与 §1.6 的平台包对接

- `crates/xtask` 负责跨平台交叉编译，输出到 `platforms/*/`
- 每个 platform 包 `package.json` 声明 `os` / `cpu` / `libc`，pnpm install 时按当前机器过滤
- `native-bridge` 的 `optionalDependencies` 挂载所有 18 个平台包
- pnpm 在不匹配的平台上跳过（不报错，装不上就是 undefined）
- CI matrix：darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 / win32-x64 / win32-arm64 各跑一遍，产物集中 upload

### 5.8 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| JS 侧**只有** `packages/native-bridge` 可以 `require` platform 包                   | ESLint no-restricted-imports                    |
| `native-bridge` **不感知具体工具**，只暴露原语（exec / runPlugin / search / diff / ...）        | code review                                      |
| Sandbox binary **必须**是独立进程，不 dlopen 进 Node                                | crates/volund-sandbox 是 bin，不是 lib          |
| `--dangerously-no-sandbox` **必须**打日志 + UI 红条 + telemetry `security.event`     | apps/cli 强制                                    |
| Rust 崩溃（napi throw）**必须**降级到 JS fallback，不能挂 session                   | try/catch + `error.raised`                      |
| Native handle **必须**在 Session 结束时全部释放                                     | native-bridge 维护 handle 集合，dispose 时清空  |
| Sandbox profile **禁止**放宽已在 PermissionSpec 声明的权限                          | crates/volund-sandbox 单元测试                  |
| Rust crate **禁止**发布到 npm（只发平台产物包）                                     | pnpm workspace 配置                              |
| `volund-search` 结果**必须**尊重 `.gitignore` / `.volundignore`                     | search crate 单元测试                            |
| 插件宿主 **必须**通过 `volund-sandbox --run-plugin` 启动，不允许 plugin-runtime 内直接 `child_process.spawn(node)` | ESLint + code review                             |
| 插件 profile **必须**由 `native-bridge` 从 `manifest.permissions` 生成，plugin-runtime 不得越级 | plugin-runtime 单元测试                          |
| 插件子进程崩溃 / OOM **必须**触发 `error.raised` 且不影响主 session                  | plugin-runtime 集成测试                          |
| 插件 RPC method **必须**在 `manifest.permissions.volund` 白名单内，未声明直接拒绝    | plugin-runtime bridge 单元测试                    |

### 5.9 里程碑

- **L1（MVP）**：`volund-sandbox exec` macOS + Linux；`volund-search` 基础版；`native-bridge` 解析 + JS fallback；Windows 无沙箱提示 `--dangerously`
- **L2**：`volund-fs`（diff + token 计数）；6 target 全 CI matrix；`volund-sandbox --run-plugin` 模式落地（macOS + Linux），支持 §6.4.3 的 JSON-RPC bridge；plugin-runtime v1 集成
- **L3**：AST 查询（tree-sitter）；沙箱违规日志（`sandbox_violations`）；插件资源守护（`setrlimit` + 强制 kill）
- **L4**：Windows AppContainer 沙箱（Bash + 插件同时启用）；volund-search 支持自定义 codec / 二进制识别

## §6 Skill / Plugin / MCP / Hooks

本节先落地**插件系统**（用户 2026-07-31 追问点），其它三块（Skill/MCP/Hooks 深化）等 §3-§5 后再补。

### 6.1 设计目标

| 目标                       | 具体含义                                                                     |
|----------------------------|------------------------------------------------------------------------------|
| **JS 优先**                | 插件运行时只接受 JS（ESM）。作者可用 TS，自行编译。零工具链门槛。              |
| **能力可声明、可审计**     | manifest.json 静态描述插件能力与权限；用户加载时看得见。                       |
| **JSBridge 受控入口**      | 插件只能通过 `volund` 全局对象访问 volund 能力，不允许 `require('fs')` 之类逃逸。 |
| **系统提示词可扩展**       | 插件可贡献 prompt 片段；与 Skill / user PROMPT.md / project AGENT.md 走同一 composer。 |
| **热插拔**                 | 插件可在 session 内 enable / disable，无需重启 volund。                        |
| **版本可控**               | `engines.volund` semver 校验，防止老插件跑在新 volund 上炸。                    |
| **无中央基础设施**         | MVP 阶段用 npm 分发（命名约定 `volund-plugin-*`），不建 registry。               |

**非目标**：
- 插件间通信（v1 不做，需要通信请用同一插件）
- 插件写 volund 核心逻辑（Provider / Router / Runner 不给改）
- 插件直接调用 provider（防绕过 router / cost tracking）
- 插件访问其它插件的 storage / manifest

### 6.2 插件形态与目录约定

MVP **单文件 ESM bundle**（类似 VSCode `.vsix`）：

```
~/.volund/plugins/volund-plugin-git-helper/
├─ manifest.json           # 必需
├─ index.js                # 必需，ESM，含所有依赖
├─ README.md               # 可选
├─ icon.svg                # 可选，UI 展示
├─ assets/                 # 可选静态资源（prompt 片段等）
└─ data/                   # 运行时数据（volund 自动建，插件通过 volund.storage 读写）
```

**安装路径**：
- 全局：`~/.volund/plugins/<pkg>/`
- 项目：`<cwd>/.volund/plugins/<pkg>/`（仅当前项目启用）
- 优先级：项目覆盖全局

**安装命令**（`apps/cli`）：
- `volund plugin install volund-plugin-<name>` → 内部 `pnpm add` 到全局 plugin 目录
- `volund plugin install github:user/repo` → 从 release tarball 拉取（v2）
- `volund plugin install ./local-dir` → 软链接到本地路径（开发模式）

### 6.3 manifest.json 规范

```jsonc
{
  "$schema": "https://volund-code.dev/schemas/plugin-manifest-v1.json",
  "name": "volund-plugin-git-helper",           // 命名约定 volund-plugin-*
  "version": "1.2.0",                            // semver
  "description": "Git-aware tools & prompts",
  "author": "Mark <mark@example.com>",
  "license": "MIT",
  "homepage": "...",

  "engines": { "volund": "^1.0.0" },             // ★ 必需，semver 校验

  "main": "index.js",                            // 相对路径
  "type": "module",                              // 只支持 ESM

  // 声明式清单：UI 展示 + 静态可审计
  "contributes": {
    "tools":            ["git-status", "git-diff"],
    "commands":         ["/gitlog", "/gitblame"],
    "hooks":            ["preToolUse", "prePrompt"],
    "promptFragments":  ["git-context", "git-conventions"],
    "skills":           []                       // 插件也能捆绑 Skill
  },

  // 权限白名单：加载时用户确认，运行时 bridge 强制
  "permissions": {
    "fs":    { "read": ["**/*.git/**"], "write": [] },
    "bash":  { "allowlist": ["git *"] },
    "net":   false,                              // 或 { "allowlist": ["api.github.com"] }
    "volund": [                                  // 允许调用哪些 bridge API
      "tools.register",
      "hooks.on",
      "commands.register",
      "prompt.contribute",
      "session.read",
      "ui.confirm"
    ]
  },

  // 可选配置 schema（zod-ish）
  "config": {
    "gitCommand": { "type": "string", "default": "git" }
  }
}
```

**加载前校验**：
1. Schema 校验 manifest.json
2. `engines.volund` semver 匹配
3. 静态扫 `index.js` 黑名单（`eval` / `Function` / `require('child_process')` 之类）
4. UI 展示 `contributes` + `permissions` → 用户确认
5. 之后写入 `~/.volund/plugins.enabled.toml` 记住"已批准 + 版本 + 权限 hash"
6. **升级后权限扩大** → 再次弹窗（类似 Android 应用权限变更）

### 6.4 JSBridge：volund 全局对象

插件 `index.js` **唯一入口**是 `activate(volund)`。`volund` 就是 JSBridge。

**是否合理**：**非常合理，正确 pattern**。VSCode / Figma / Sketch / 浏览器扩展全用这个思路。它把安全边界、能力发现、类型系统集中在一处，是插件系统里最可靠的 API 组织方式。

#### 6.4.1 完整 API 表面（v1）

```ts
export interface VolundBridge {
  //-------- 元信息 --------
  readonly apiVersion: '1.0'
  readonly plugin: { name: string; version: string; dataDir: string }

  //-------- 工具注册 --------
  tools: {
    register(spec: ToolSpec): Disposable
    unregister(name: string): void
  }

  //-------- Hook 订阅 --------
  hooks: {
    on(event: HookEvent, handler: HookHandler): Disposable
    off(event: HookEvent, handler: HookHandler): void
  }

  //-------- Slash 命令 --------
  commands: {
    register(spec: CommandSpec): Disposable
  }

  //-------- ★ 系统提示词贡献 --------
  prompt: {
    contribute(fragment: PromptFragment): Disposable
    revoke(id: string): void
  }

  //-------- 会话（只读 + 事件） --------
  session: {
    id: string
    cwd: string
    getMessages(range?: { limit?: number }): ReadonlyArray<Message>
    getUsage(): Usage
    on(event: SessionEvent, handler: (payload: any) => void): Disposable
  }

  //-------- 文件 IO（permission-gated + native-bridge） --------
  fs: {
    readFile(path: string, encoding?: 'utf-8' | 'binary'): Promise<string | Uint8Array>
    writeFile(path: string, data: string | Uint8Array): Promise<void>
    exists(path: string): Promise<boolean>
    glob(pattern: string, opts?: GlobOpts): Promise<string[]>
    stat(path: string): Promise<FileStat>
  }

  //-------- 命令执行（sandbox-gated） --------
  exec(command: string, opts?: ExecOpts): Promise<{ stdout: string; stderr: string; code: number }>

  //-------- 网络（http-kit + permission-gated） --------
  http: {
    fetch(url: string, init?: FetchInit): Promise<Response>
  }

  //-------- 与用户交互 --------
  ui: {
    confirm(message: string): Promise<boolean>
    prompt(question: string, opts?: { default?: string; secret?: boolean }): Promise<string | null>
    pick<T>(options: T[], opts?: { label: (t: T) => string }): Promise<T | null>
    notify(message: string, level?: 'info' | 'warn' | 'error'): void
  }

  //-------- 插件私有存储 --------
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }

  //-------- 配置读取（manifest.config 声明的项） --------
  config: {
    get<T = unknown>(key: string): T
  }

  //-------- 日志（写入 telemetry） --------
  log: {
    debug(msg: string, meta?: object): void
    info(msg: string, meta?: object): void
    warn(msg: string, meta?: object): void
    error(msg: string, err?: unknown, meta?: object): void
  }
}
```

**明确不暴露**（v1 non-goals）：
- `volund.native` / `volund.rust` — 插件不能碰 Rust 原生
- `volund.core` / `volund.runner` — 插件不能改内核
- `volund.provider` — 插件不能直接调 provider
- `volund.plugins` — 插件不能操作其它插件

**Disposable 契约**：所有 `register/on` 返回 `Disposable`，`deactivate` 时必须调 `dispose()`，`plugin-runtime` 会兜底 dispose 所有插件持有的注册。

#### 6.4.2 完整插件示例

```js
// index.js — 纯 ESM，无 import 其它 Node API
export default {
  name: 'git-helper',
  version: '1.2.0',

  async activate(volund) {
    // 1. 注册工具
    volund.tools.register({
      name: 'git-status',
      description: 'Show git status of current repo',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      permission: { bash: { command: 'git status --porcelain' } },
      async handler(_input, ctx) {
        const { stdout } = await volund.exec('git status --porcelain')
        return { content: [{ type: 'text', text: stdout || '(clean)' }] }
      }
    })

    // 2. 注册 hook：阻止危险 rm
    volund.hooks.on('preToolUse', async (event) => {
      if (event.tool === 'Bash' && /\brm\s+-rf\b/.test(event.input.command)) {
        return { veto: true, reason: 'blocked by git-helper: rm -rf detected' }
      }
    })

    // 3. ★ 贡献系统提示词
    volund.prompt.contribute({
      id: 'git-context',
      priority: 50,
      when: async () => volund.fs.exists('.git'),
      text: async () => {
        const { stdout: branch } = await volund.exec('git rev-parse --abbrev-ref HEAD')
        return `You are in a git repository. Current branch: ${branch.trim()}.
When making changes, prefer atomic commits and clear commit messages.`
      }
    })

    // 4. Slash 命令
    volund.commands.register({
      name: '/gitlog',
      description: 'Show recent commits',
      async handler(_args, ctx) {
        const { stdout } = await volund.exec('git log --oneline -20')
        ctx.output.text(stdout)
      }
    })

    volund.log.info('git-helper activated')
  },

  async deactivate() {
    // Disposable 会被兜底释放；这里做插件自己的清理
  }
}
```

#### 6.4.3 沙箱：Rust 子进程 + JSON-RPC Bridge

**心智**：插件是第三方 JS 代码，与 Bash 命令**同属"用户信任但需要真实隔离"的类别**。§5 的 `volund-sandbox` 已为 Bash 建立 Rust 沙箱基础设施；插件复用同一套框架，避免"最需要沙箱的地方反而没沙箱"的自相矛盾。

**架构总览**：

```
volund 主进程 (Node)                        volund-sandbox 子进程 (Rust bin)
                                            └─ execve Node w/ sandbox profile
┌──────────────────────┐  JSON-RPC (fd 3)   ┌──────────────────────┐
│ plugin-runtime       │◄──────────────────►│ plugin-host.mjs      │
│  ├─ 生命周期管理     │                    │  ├─ 建立 RPC 连接    │
│  ├─ RPC 服务端       │                    │  ├─ 构造 volund 代理  │
│  ├─ permission/quota │                    │  ├─ import(index.js) │
│  ├─ zod 参数校验      │                    │  └─ 调 activate      │
│  └─ 每插件一进程     │                    └──────────────────────┘
└──────────────────────┘                    sandbox profile：
        │                                    - fs: 只读 pluginDir + rw dataDir
        ▼                                    - net: 依 manifest 白名单
   permission / native-bridge / core         - no execve / no ptrace / no mmap-w+x
```

**为什么每插件一子进程**（而不是所有插件共享一个 host 进程）：
- 隔离最强：一个插件失控/崩溃/OOM 只影响自己
- profile 精细化：每插件的 sandbox permissions 独立生成
- 资源守护实现直接：可以对进程用 `setrlimit`（cpu / mem / fd）+ 强制 `kill`

**代价**：每插件 ~30-50MB Node RSS。可接受（正常用户 < 10 个插件），且相比"vm 不是真沙箱"的安全叙事漏洞，这是值得付出的代价。

**加载流程**：

```
plugin-runtime.load(pluginDir):
  1. 读 manifest.json → schema + engines + 权限校验
  2. UI 展示 contributes + permissions → 用户确认（首次或权限变更时）
  3. 从 manifest.permissions 生成 sandbox profile（复用 §5.3 规则）
  4. 通过 native-bridge 启动子进程：
       volund-sandbox --run-plugin \
         --entry <pluginDir>/index.js \
         --data-dir <dataDir> \
         --sandbox-profile <profile-json> \
         --bridge-fd 3
     volund-sandbox 内部：应用 landlock/sandbox-exec profile 后 execve node
  5. 子进程内 plugin-host.mjs 通过 fd 3 建立 NDJSON JSON-RPC 通道
  6. plugin-host 动态 import(index.js) → default export
  7. plugin-host 构造 volund 代理对象（每方法调用转成 RPC request）
  8. 调 activate(volund)，超时 10s；失败/超时 → 主进程 SIGKILL + 卸载
  9. 主进程收到 RPC 请求 → manifest.permissions.volund 白名单校验 →
     zod 参数校验 → permission/quota → 转发到 core/tool-kit/hooks
```

**RPC 协议**：JSON-RPC 2.0 over NDJSON (fd 3, 双向)

- request（child → parent）：`{"jsonrpc":"2.0","id":1,"method":"volund.tools.register","params":{...}}`
- response（parent → child）：`{"jsonrpc":"2.0","id":1,"result":{...}}` 或 `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}`
- notification（parent → child）：`{"jsonrpc":"2.0","method":"session.turn.started","params":{...}}` —— 用于事件推送（`volund.session.on` / `volund.plugin.on`）
- 无需背压：插件 RPC 不是热路径（每 turn 几次到几十次调用）；事件通知在主进程侧按插件订阅列表过滤，不感兴趣的事件不推

**附件传递**（handle-token 模式）：
- 主进程持有 `AttachmentRef.handle`（native pointer 绝对不出主进程）
- 传给插件的 Message 里 handle 被 strip 成不透明 token（`att_${uuid}`）
- 插件调 `volund.fs.readAttachment(token)` → 主进程解 token → permission 校验 → 通过 RPC response 回传 bytes
- 大附件（> 8MB）走分片：`volund.fs.readAttachment(token, { chunk: 64_000 })` 返回 AsyncIterable

**bridge 服务端**（主进程 `plugin-runtime`）实现要点：
- 每个 RPC 方法是一个 async handler，签名 `(pluginId, params) => result`
- 白名单：`manifest.permissions.volund` 未声明的 method → 直接 `-32601` Method not found
- 参数：全部走 zod schema（`packages/plugin-sdk` 里定义的类型对应的 schema）
- 敏感操作（fs.write / exec / http）二次转发到 `permission` → `volund-sandbox exec` 或 `http-kit`
- 记 telemetry：`plugin:<name>:<method>` + duration + result kind + error class

**bridge 客户端**（子进程 `plugin-host.mjs`）实现要点：
- 提供 `volund` proxy，接口面与 §6.4.1 `VolundBridge` 一致
- 每方法：生成 request id → 写 NDJSON 到 fd 3 → 用 Map<id, resolver> 等待响应
- notification 分发到已注册的 `on(event, handler)` 监听器
- 无 `require` / `process` / `global` / `Buffer` / `fetch` 顶层暴露 —— 靠 **Rust sandbox 的 syscall 过滤**（主防线）+ **Node ESM 起步**（次防线）+ **plugin-host 用 IIFE 包一层 delete globals**（辅助），任一都不是安全底线
- 崩溃 → volund-sandbox 感知子进程退出 → 通知主进程 → 主进程 emit `error.raised` + 触发 disable 策略（见 §6.11.2）

**Node runtime 的选择**：
- 复用系统 Node（volund 本身运行的那个 Node，一定可用）
- volund-sandbox 在 sandbox profile 内 execve `process.execPath`
- profile 需允许：读 Node 二进制 + 读 Node 内置模块路径 + 读 pluginDir + 读写 dataDir + 读 IPC fd

**用户插件的 index.js 形态**：
- 单文件 ESM，作者用 `tsdown` / `esbuild` pre-bundle（不含 npm 依赖拉取）
- 允许纯计算的 npm 依赖（bundle 到 index.js 里）
- 禁止运行时 `import('some-npm-pkg')` —— 子进程内没有 node_modules 可读
- SDK 层 `@volund-code/plugin-sdk` 只是**编译期类型辅助 + `definePlugin/defineTool` 身份函数**，运行时零依赖

**"静态 AST 检查"降级说明**：从 v1 起，AST 扫描（拒绝 `eval` / `new Function` 等）**不再是安全底线**，降级为**"作者友好检查"**（拦低级错误 + typo）。真正的隔离靠：
1. **Rust sandbox 进程 + syscall 过滤** —— 主防线
2. **JSON-RPC bridge 白名单** —— 能力面
3. **manifest.permissions 用户显式批准** —— 用户面

**决策对照**：

| 维度 | Rust sandbox 子进程（选） | node:vm | worker_threads |
|---|---|---|---|
| 隔离强度 | ✅ 进程 + syscall + 与 Bash 同框架 | ❌ 同 heap，仅能力控制 | ⚠️ 同进程 v8 isolate |
| 崩溃影响 | ✅ 主进程无感 | ❌ 主进程崩 | ⚠️ 内存共享有波及 |
| CPU/mem 限制 | ✅ setrlimit + kill | ❌ 无 | ⚠️ resourceLimits 粗粒度 |
| 附件传递 | handle token（一次 RPC） | 直接传引用 | postMessage 序列化 |
| bridge 延迟 | ~1-5ms/call | ~1µs | ~ms |
| Rust 一致性 | ✅ 与 §5 沙箱统一 | ❌ 割裂 | ❌ 割裂 |
| 实现复杂度 | 中（复用 volund-sandbox） | 低 | 中 |

**延迟评估**：插件 hook / bridge 调用不在热路径（`stream.delta` 不跨 RPC，只有插件订阅的高层事件才推 notification）。一个 turn 的 bridge 调用通常 <20 次，5ms/次 完全接受。真正的热路径（provider 流式增量分发）仍在主进程内。

**Windows 支持策略**：与 §5.3 一致 —— L1-L4 Windows 无原生沙箱，插件系统**默认拒绝加载**；用户可 `--dangerously-no-sandbox` 覆盖，此时插件在 sandbox 子进程内跑但 profile 空（相当于普通 child_process 隔离，仍比 vm 强）。Windows AppContainer 沙箱与插件集成一起归 v2。

### 6.5 ★ 系统提示词的组合模型（PromptComposer）

**问题**：系统提示词有很多来源，怎么组合？

**决策**：`packages/core` 提供 `PromptComposer` 接口，各来源作为 **contributor** 注册。Runner 每次构造 prompt 前询问 composer。

```ts
// packages/core/src/prompt-composer.ts
export interface PromptFragment {
  id: string                                    // 唯一
  source: string                                // 'builtin' / 'skill:<name>' / 'plugin:<name>' / 'user' / 'project'
  priority: number                              // 数值越高越靠前
  when?: (ctx: PromptCtx) => boolean | Promise<boolean>  // 谓词
  text: string | ((ctx: PromptCtx) => string | Promise<string>)  // 惰性求值
}

export interface PromptComposer {
  register(fragment: PromptFragment): Disposable
  compose(ctx: PromptCtx): Promise<string>      // 最终 system prompt
  invalidate(id?: string): void                 // 主动失效缓存
}
```

**合成规则**：
1. 收集所有已注册 fragment
2. 对每个 fragment 求 `when(ctx)`，过滤掉 false 的
3. 按 `priority` 降序排序（同优先级按 `id` 稳定排序）
4. 依次求 `text(ctx)`，拼接成最终文本，中间用 `\n\n---\n\n` 分隔并加 `<!-- source: xxx -->` 注释便于调试
5. 结果缓存到 `SessionState.systemPromptSnapshot`；有 register/dispose/invalidate 时失效

**内置来源与默认优先级**：

| 来源                     | Priority | 说明                                    |
|--------------------------|----------|-----------------------------------------|
| `builtin`                | 1000     | volund 内置引导（角色、工具描述、约束）    |
| `skill:<active-skill>`   | 800      | 当前会话激活的 Skill                     |
| `project`                | 600      | `<cwd>/AGENT.md`（自动发现）              |
| `user`                   | 400      | `~/.volund/PROMPT.md`                    |
| `plugin:<name>`          | 50       | 插件贡献                                 |

**contributor 注册路径**：
- 内置：`core` 启动时自注册
- Skill：`skills-runtime` 激活 skill 时调 `composer.register(...)`
- AGENT.md / PROMPT.md：`storage` 启动时读文件后注册
- Plugin：`plugin-runtime` 将 `volund.prompt.contribute` 转发到 composer

**这套设计的价值**：所有 prompt 来源统一，不用为每种来源写一套逻辑；插件贡献 prompt 天然接入。

#### 6.5.1 内置 system prompt 具体 draft

`packages/core` 内置的 builtin fragment（priority=1000），MVP draft：

```md
You are volund Code, an interactive terminal AI coding agent. You help the user
with software engineering tasks in the current working directory.

## Environment
- CWD: {{cwd}}
- Platform: {{platform}} ({{arch}})
- Shell: {{shell}}
- Model: {{model}} via {{provider}}

## Guiding principles
- Prefer using the provided tools (Read, Write, Edit, Bash, Grep, Glob) over
  guessing. Verify assumptions by reading files.
- When editing, keep changes minimal and match surrounding code style.
- Ask before destructive operations that aren't covered by the user's stated goal.
- Cite file paths as `path:line` — they're clickable in most terminals.
- Report failures honestly: if a step didn't work, say so with the output.

## Tool usage
- Multiple independent tool calls can run in parallel — batch them in one turn.
- Long tasks: use the Todo tool to track progress.
- Complex subtasks: consider dispatching a subagent via the Task tool.

## Safety
- Never emit secrets. If a file contains what looks like a secret, don't echo it.
- If a command could delete data, confirm scope before running.
```

**变量**：`{{cwd}}` / `{{model}}` 等由 `PromptComposer` 在 compose 时用 `ctx` 填充。

**关于工具描述**：**不塞进 system prompt**。工具通过 provider `tools` 字段传递（Anthropic/OpenAI/Gemini 都有原生 tool 定义），模型自己会读。system prompt 只做元指导（"你可以用 tool"），具体工具名/参数走 tools 字段。

**关于 provider 差异**：这段是通用文本；Gemini 因为无 system field，`provider-gemini` 适配器把它包装成第一条 user message（见 §3.2 `systemPromptLocation`）。

#### 6.5.2 Skill 数据模型

**目录结构**：

```
~/.volund/skills/git-workflow/
├─ SKILL.md              # 必需：frontmatter + 主体
├─ examples/             # 可选：例子片段
│  ├─ good-commit.md
│  └─ bad-commit.md
├─ references/           # 可选：更详细的参考
│  └─ conventional-commits.md
└─ assets/               # 可选：图片等
```

**SKILL.md frontmatter schema**：

```yaml
---
name: git-workflow                          # 必需，全局唯一
description: >                              # 必需，一句话（<200 字符）
  Guides volund to write conventional commits, use atomic changes, and
  document breaking changes clearly.
volundVersion: ^1.0.0                       # 必需 semver
version: 1.0.0                              # 该 skill 版本
author: Mark
license: MIT
tags: [git, commit-messages, workflow]

activation:                                 # 何时激活
  auto:                                     # 自动激活条件
    - path_exists: .git                     # cwd 有 .git 时激活
    - secret: mentions_git              # 用户消息提到 git 时激活
  manual: true                              # 允许用户 /skill activate git-workflow

resources:                                  # 声明会用到的额外资源
  - examples/good-commit.md
  - references/conventional-commits.md
---

# Git Workflow Skill (SKILL.md 主体)

Prefer Conventional Commits: `<type>(<scope>): <subject>`

...(more instructions)...
```

**Frontmatter zod schema** 放在 `packages/shared/skill-schema.ts`。

#### 6.5.3 Skill Progressive Disclosure 机制

**问题**：直接把所有 skill 的全文塞进 system prompt → 上下文爆炸。

**方案**（分三阶段读）：

1. **冷启动扫描**（volund 启动时）：`skills-runtime` 遍历 `~/.volund/skills/*/SKILL.md` **只读 frontmatter**（yaml_front_matter 库前置停止），收集 `name` + `description` + `activation`。
2. **候选提示**（compose 时）：由 `skills-runtime` 向 PromptComposer 注册一个**索引 fragment**（priority=850），格式：
   ```
   Available skills (activate via /skill activate <name>):
   - git-workflow: Guides volund to write conventional commits...
   - react-testing: Best practices for React Testing Library...
   ```
   模型看到 index 后，若判断有用 → 输出特殊 tool 调用 `Skill.activate({ name: 'git-workflow' })`。
3. **激活加载**：Runner 收到 `Skill.activate` → `skills-runtime.activate(name)` 读全文 SKILL.md（含 resources 引用的文件） → 注册为 fragment（priority=800，见 §6.5 表） → PromptComposer invalidate → 下一轮 compose 时全文进入 prompt。

**自动激活**（frontmatter `activation.auto`）：`skills-runtime` 启动扫描时评估条件，命中 → 直接跳到步骤 3 无需模型请求。

**去激活**：`/skill deactivate <name>` 或超过 N 个 turn 未被引用后自动去激活（LRU）。

#### 6.5.4 AGENT.md 语义规则

**问题**：项目里 AGENT.md 谁读？多个层级怎么办？

**规则**（尽量沿用 claude-code / cursor 生态惯例）：
1. volund 启动时（cwd 已知），`storage` 从 cwd 向上遍历，每级找 `AGENT.md`（不跨用户 home 边界；最多向上 8 级即停）
2. 找到的所有 `AGENT.md` **按路径深度**排序（越靠近 cwd 优先级越高）
3. 每个 AGENT.md 作为一个 fragment 注册到 PromptComposer（source=`project:<relpath>`）
4. **priority 递减公式**（确定性、可测试）：
   - `cwd/AGENT.md` → priority = **600**
   - `cwd/../AGENT.md` → priority = **590**（每上一级 `-10`）
   - `cwd/../../AGENT.md` → priority = **580**……
   - **下限 priority = 500**（8 级封顶后仍高于 user PROMPT.md 的 400）
   - 同一目录理论上不会有两个 AGENT.md；若发生（如软链），按绝对路径字典序 tie-break
5. volund 也读 `<cwd>/CLAUDE.md`（若存在），作为 fallback 兼容 claude-code 生态：
   - 两个都在时 `AGENT.md` 优先（占用 priority=600 槽位）
   - 单独存在 `CLAUDE.md` → 复用同一 priority 规则，source=`project:CLAUDE.md`
   - **不同时注册两份**避免语义重复
6. 子目录里的 AGENT.md **不自动读**（只有 cwd 及以上）；若模型需要，用 `Read` 工具主动读

**替代变量**（AGENT.md 支持简单模板变量）：
- `{{cwd}}` / `{{platform}}` / `{{today}}` 等
- **不支持**动态执行（不是 shell 模板）

#### 6.5.5 PromptComposer 输出示例

一次 compose 输出（拼接后示意）：

```
<!-- source: builtin, priority: 1000 -->
You are volund Code, an interactive terminal AI coding agent...

---

<!-- source: skill:git-workflow, priority: 800 -->
# Git Workflow Skill
Prefer Conventional Commits...

---

<!-- source: project:/Users/mark/proj/AGENT.md, priority: 600 -->
# Project conventions
Use React 19 with the new hooks...

---

<!-- source: user:~/.volund/PROMPT.md, priority: 400 -->
I prefer verbose explanations. Always show me the plan first.

---

<!-- source: plugin:git-helper, priority: 50 -->
You are in a git repository. Current branch: main.
```

`<!-- source: ... -->` 注释放在文本里对模型无害（大部分 tokenizer 会作为普通 token），但对**用户 debug** 极有价值（`volund debug prompt` 可 dump 这段）。

#### 6.5.6 `@include` 机制

**问题**：多个 md（AGENT.md / PROMPT.md / SKILL.md / memory）经常有共享片段（团队共享的编码规范、领域词表），复制粘贴容易漂移。

**决策**：volund 内部**提示词加载管线**支持 `@include <path>` 语法。**只在提示词加载管线生效**，`Read` 工具读 md 时**不展开**（保留原文，避免污染搜索 / diff / edit 语义）。

**语法**（严格）：
- 一整行以 `@include ` 开头（行首无缩进），后面是路径，无引号；行尾允许 `# comment`
- 例：`@include ./shared/coding-style.md`
- 例：`@include ~/.volund/shared/team.md   # 团队共享片段`
- 不匹配的 `@include`（如缩进、多参数、在代码块内）**不展开**，原样保留
- **代码块内 `@include` 不展开**（三重反引号或缩进代码块内的 include 视为字面量）

**路径规则**：
- 相对路径 → 相对当前文件所在目录
- `~/` 前缀 → 相对用户 home（跨平台 canonicalize）
- 绝对路径 → 允许，但**规范化后**必须落在 workspace（`<cwd>/**`）或 `~/.volund/**` 之一
- **禁止** `file://` / `http(s)://` URL（v1 non-goal，避免网络依赖 + 供应链风险）
- **禁止** 通过 `../` 越出双白名单（canonicalize 后校验，同时挡 symlink 逃逸）

**递归与安全**：
- 递归深度上限 **8**（可通过 `config.toml [prompt] max_include_depth` 调整，上限 32）
- 循环检测：维护 canonical-path seen-set，回到自己或先辈 → 拒绝并留占位
- 每次展开必须过 `permission.fs.read` 校验（复用主权限模型，不新开旁路）
- 展开次数上限：单次 compose 内总展开数 ≤ 64（防扇出爆炸）

**Frontmatter 处理**：被 include 的文件如带 yaml frontmatter（`---`包围），**剥离**只保留正文；顶层文件（SKILL.md / memory）的 frontmatter 由各自 loader 解析后再进入 include 展开。

**展开输出**（带调试标记）：

```
<!-- include: ./shared/coding-style.md depth=1 -->
（被 include 的正文，剥离 frontmatter）
<!-- /include ./shared/coding-style.md -->
```

**错误处理**（**留占位不 abort**，让用户/模型看到并修）：

| 情况 | 行为 |
|---|---|
| 文件不存在 | `<!-- include: <path> — NOT FOUND -->` + `error.raised` warning |
| 越界（不在白名单） | `<!-- include: <path> — OUT OF SCOPE -->` + `security.event` |
| 循环 | `<!-- include: <path> — CYCLIC (seen at depth N) -->` + warning |
| 深度超限 | `<!-- include: <path> — MAX DEPTH -->` + warning |
| permission 拒绝 | `<!-- include: <path> — DENIED -->` + warning |
| 非 `.md` 后缀 | 直接拒绝，输出 `<!-- include: <path> — NOT A MARKDOWN FILE -->`（v1 只吃 md，其它类型 v2 再议） |

**实现归属**：`packages/core` 内新增 `PromptLoader`（不新增包）：
- `loadMarkdown(path, ctx): Promise<{ text, frontmatter, includes }>` — 读文件 + 剥 frontmatter + 递归展开 + 记录展开来源
- 被 `storage`（读 AGENT.md / PROMPT.md）、`skills-runtime`（读 SKILL.md）、`memory-runtime`（读 memory/*.md，见 §6.12）、`PromptComposer` 主动调用
- 不感知具体来源；只关心 md 文本处理 + 安全边界

**边界与安全清单**：

| 规则 | 强制点 |
|---|---|
| `@include` **只在** volund 内部提示词管线展开，`Read`/`Grep`/`Edit` 工具**不展开** | `PromptLoader` 与 `Read` 工具是不同代码路径；单元测试守 |
| 展开路径 **必须**落在 workspace 或 `~/.volund` 双白名单内 | `PromptLoader.canonicalizeAndCheck()` 单元测试 |
| 递归深度 / 展开次数 / 循环 **必须**限流 | `PromptLoader` 单元测试 |
| 每次展开 **必须**过 `permission.fs.read`（复用主权限） | 集成测试 |
| 被 include 的**非 md 文件**（`.txt` / `.yaml` / `.json` 等）**必须**拒绝 | 单元测试 |
| 展开输出 **必须**带 `<!-- include: ... -->` / `<!-- /include ... -->` 标记 | 单元测试 |
| 出错**必须**留占位注释而非 abort compose | 集成测试 |

**事件（telemetry）**：`prompt.include.expanded` / `prompt.include.failed`（含 reason enum）。

### 6.6 SDK：`@volund-code/plugin-sdk`

新增包 `packages/plugin-sdk`，MVP 版本内容：

```
packages/plugin-sdk/
├─ src/
│  ├─ index.ts               # export types + define helpers
│  ├─ types.ts               # VolundBridge / ToolSpec / HookEvent / PromptFragment ...
│  └─ define.ts              # definePlugin / defineTool / defineHook / defineCommand
├─ package.json              # 运行时零依赖，只发类型
└─ README.md
```

**API**（仅类型 + 少量辅助）：

```ts
export function definePlugin<C = {}>(p: Plugin<C>): Plugin<C> { return p }
export function defineTool(t: ToolSpec): ToolSpec { return t }
export function defineHook<E extends HookEvent>(e: E, h: HookHandler<E>): [E, HookHandler<E>] { return [e, h] }
```

**作者用法**：

```ts
// 作者 TS 项目
import { definePlugin, defineTool } from '@volund-code/plugin-sdk'

export default definePlugin({
  name: 'git-helper',
  version: '1.2.0',
  async activate(volund) {
    volund.tools.register(defineTool({
      name: 'git-status',
      // ... 全类型补全
    }))
  }
})
```

作者用 esbuild / tsdown 编译成单文件 `index.js`，发布到 npm。

**注意**：`plugin-sdk` 只依赖 `shared`（type-only），运行时零副作用。发到 npm 给外部作者用。

### 6.7 与 §1 布局的差量

需要更新 §1：

1. **新增包**：`packages/plugin-sdk`（type-only，可发布 npm，作者依赖）
2. **`packages/plugin-runtime` 责任扩充**（v3 修正后）：
   - 加载 manifest + engines 校验
   - AST 作者友好检查（依赖 esbuild parser；**不是安全底线**）
   - **通过 `native-bridge.runPlugin()` 起 `volund-sandbox --run-plugin` 子进程**，不再是 `node:vm`
   - JSON-RPC 服务端：dispatch table + 白名单 + zod 校验 + 敏感操作转发
   - 权限确认 UI 触发（通过 `permission.setPromptHandler` 复用）
   - 子进程生命周期管理（activate 超时、崩溃隔离、资源守护 kill）
   - Disposable 兜底
3. **`packages/native-bridge` 责任扩充**（v3 修正后）：
   - 新增 `runPlugin(opts) → PluginProcHandle` 原语：spawn `volund-sandbox --run-plugin`，保留 fd 3 作为 bridge socket
   - `PluginProcHandle` 提供 `send(msg) / onMessage(cb) / kill() / onExit(cb)`
   - **不感知**具体 RPC method（那是 plugin-runtime 的事）
4. **`packages/core` 责任扩充**：
   - 新增 `PromptComposer` 接口 + 内置实现
   - 新增 `PromptLoader`（md 读入 + frontmatter 剥离 + `@include` 递归展开 + workspace/`~/.volund` 双白名单，见 §6.5.6）
   - `SessionState.systemPromptSnapshot` 字段（cache）
5. **依赖表增补**：
   - `plugin-sdk → shared[type-only]`
   - `plugin-runtime → core[type-only] + tool-kit + permission + hooks + native-bridge + shared`（**v3 新增 `native-bridge` 依赖**）
   - **v4 新增** `memory-runtime → core[type-only] + permission + hooks + native-bridge + shared`
6. **skills-runtime / storage / memory-runtime 责任扩充**：均需向 PromptComposer 注册 contributor（skills 800 / project 600 / user 400 / memory:pinned 700 / memory-guide 950）；三者读入 md 均走 `core.PromptLoader`
7. **新增运行时资源**：
   - `packages/plugin-runtime/runtime/plugin-host.mjs`（与 plugin-runtime 一起发布，`volund-sandbox --run-plugin` execve Node 时加载它作为宿主脚本）
   - `packages/core/prompts/memory-guide.md`（内置 memory-guide 提示词，见 §6.12.3）
8. **v4 新增包**：`packages/memory-runtime` —— memory 存储 / 召回 / bridge server / CLI 后端（详见 §6.12.9）

### 6.8 边界与安全清单

| 规则                                                          | 强制点                                    |
|---------------------------------------------------------------|-------------------------------------------|
| 插件文件系统访问 **必须**限定在 `pluginDir` 只读 + `dataDir` 读写   | `volund-sandbox` profile（landlock/sbpl）  |
| 插件 **不允许** 任意 `net` / `exec` / `ptrace`                  | `volund-sandbox` seccomp / sbpl           |
| 插件 **不允许** 运行时 `import('some-npm-pkg')`（子进程内无 node_modules 可读） | sandbox profile + plugin-host 起步无 loader hook |
| 插件所有 fs/exec/net 请求走 `volund.*` bridge → permission     | plugin-runtime RPC dispatch               |
| 插件 RPC method 未在 `manifest.permissions.volund` 白名单 → 拒绝 | plugin-runtime bridge 单元测试             |
| 插件权限运行时扩容 → 拒绝（不能自升级权限）                     | manifest 加载时冻结                        |
| 升级后权限扩大 → 用户重新确认                                  | `plugins.enabled.toml` 存权限 hash        |
| 插件 activate 超时 10s → 失败、SIGKILL 子进程                  | `plugin-runtime` withTimeout + `kill()`   |
| 插件子进程崩溃 → 隔离到该插件（不影响主进程和其它插件）           | `volund-sandbox` 独立进程 + `error.raised` 事件 |
| 插件被禁用 / 卸载 → SIGTERM 子进程 + 释放所有 Disposable        | `plugin-runtime` 持有 disposable + procHandle 列表 |
| 插件不能持有 `SessionState` 引用（可能拿到旧版本）              | `volund.session` 只返 immutable 快照（走 RPC 序列化天然做到） |
| 插件间不能互相通信 / 读取                                      | 每个插件独立子进程，独立 dataDir，独立 profile |
| 插件 stdout / stderr 环形 buffer + 尾部保留，转 telemetry       | volund-sandbox 侧限流；plugin-runtime 记录 |

### 6.9 与其它扩展机制的关系

| 机制    | 语言   | 维护方   | 权限 | 主要用例                            |
|---------|--------|----------|------|-------------------------------------|
| Skill   | Prompt | 人工     | 无   | 教 volund "怎么做 X"（知识/流程）    |
| Plugin  | JS     | 作者     | 强   | 加 tools / hooks / commands / prompt |
| MCP     | 任意   | 外部服务 | 中   | 已有 MCP server 生态复用             |
| Hooks   | Shell  | 用户     | user 系统权限 | 用户自定义 hook 脚本                 |
| **Memory** | md   | **模型主导 + 用户可编辑** | 显式 read/write | 跨会话长期记忆（偏好 / 常识 / 教训） |
| AGENT.md | md    | 人工     | 无（只读注入） | 项目规则手册（团队共享） |

**决策**：六者共存，各司其职。
- 新扩展**优先 Plugin**（DX 最好，类型安全）
- **Skill vs AGENT.md**：Skill 是可复用知识包（可 v 化 / 可分享）；AGENT.md 是当前项目规则手册
- **Memory vs Skill**：Skill 手工写就；Memory 模型积累（用户随时可编辑修正）
- **MCP** 是外部生态桥；**Hook** 是简单 shell 联动

### 6.10 里程碑

**依赖**：插件系统 L1 依赖 §5.9 的 L2（`volund-sandbox --run-plugin` 落地）。因此 §6.10 的时序整体后移一个里程碑。

- **L1（依赖 §5.9-L2）**：manifest + 单文件加载 + `volund-sandbox --run-plugin` 子进程 + JSON-RPC bridge + `tools.register` / `hooks.on` / `prompt.contribute` / `commands.register` / `volund.log`；无 http / no exec（先只让插件贡献 prompt 和纯计算工具，收窄 sandbox profile 到最小面）
- **L2**：`volund.fs`（读白名单） / `volund.exec`（走 permission → 内层 `volund-sandbox exec`，插件不直接开 shell）/ `volund.http`（按 manifest.permissions.net 白名单）
- **L3**：升级检测（权限变化再确认）+ 热插拔 enable/disable + 资源守护（`setrlimit` + bridge 调用次数/延迟限制）
- **L4**：`volund plugin dev` 开发模式（`--dev` 分支 profile 放宽 + hot reload watcher）+ registry search（延后 v2）+ Windows AppContainer 插件宿主

### 6.11 v2 补漏（自 review 发现）

#### 6.11.1 多插件 hook 执行顺序

**问题**：两个插件都 hook 了 `preToolUse`，谁先跑？前者修改 input 后者能否看到？

**规则**：
- `HookSpec` 加 `priority: number`（默认 0），高优先级先执行
- 同优先级按 **注册顺序**（先注册先跑）
- 内置 hook 用 priority=1000（永远先跑，做基础校验），插件默认 0，用户 hook 用 -1000（永远最后）
- **串行 pipeline**：前者返回值传给后者作为下一步 input
- **短路语义**：某个 handler 返回 `{ veto: true, reason }` → 立即中止链，后续 handler 不执行，veto 上报模型/UI

`volund.hooks.on(event, handler, opts?)` 签名扩展：

```ts
volund.hooks.on('preToolUse', handler, { priority: 10 })
```

#### 6.11.2 插件资源守护

**问题**：失控/恶意插件死循环、内存膨胀、fork 炸弹会怎样？

**v3 修正后**：插件跑在 `volund-sandbox --run-plugin` 独立子进程内，主进程 100% 不受影响。资源守护变成"什么时候杀这个子进程"的问题，而非"能不能杀"。

**多层守护**：

| 层 | 措施 | 触发 |
|---|---|---|
| L1 | `activate` 超时 10s | `SIGKILL` 子进程，标记插件卸载 |
| L2 | **每次 bridge 调用超时 5s**（默认，可 override） | 转 `bridge timeout` 错，插件子进程继续存活但该调用失败 |
| L3 | **单 turn 内 bridge 调用次数上限**（默认 500） | 超限记警告，超 2× 强制 `SIGKILL` + 禁用当前插件 |
| L4 | **进程级 `setrlimit`**（volund-sandbox 在 execve 前设置） | CPU 时间 / RSS / 文件句柄 超限 → 内核 kill，父感知 exit code |
| L5 | **无响应心跳**：volund 每 30s 发 `ping` RPC，60s 无响应 → 判定挂起 → `SIGKILL` | 记 `error.raised` |
| L6 | 用户主动 `volund plugin ban <name>` | 加入 `~/.volund/plugins.banned.toml`，永久拉黑 |
| L7 | 3 次连续 `activate` 失败 → 自动 disable | 需要 `volund plugin enable <name>` 显式恢复 |

**现在可以做的**（vs 旧 vm 方案）：
- ✅ CPU 时间上限（`setrlimit(RLIMIT_CPU)` + 内核 kill）
- ✅ 内存上限（`setrlimit(RLIMIT_AS)` / `RLIMIT_RSS`）
- ✅ fork 炸弹防御（`RLIMIT_NPROC`）
- ✅ 文件句柄上限（`RLIMIT_NOFILE`）
- ✅ 崩溃隔离（Node segfault / OOM 不影响主 volund）

**仍不做的**：
- 网络流量整形（应用层记 telemetry，不做速率限制）
- 磁盘配额（依赖平台文件系统，v2+）

**接受的风险**：装恶意插件本就是信任行为；volund 通过 Rust sandbox + 白名单 bridge + manifest + 资源上限做到"意外失控完全隔离、恶意攻击者提高攻击成本"。这与 §6.4.3 的心智一致。

#### 6.11.3 插件诊断

新增 CLI 命令 `volund plugin doctor <name>`，输出：

```
Plugin: volund-plugin-git-helper@1.2.0
Status:              ✅ enabled
Load time:           123 ms
Manifest:            ✅ valid, engines.volund=^1.0.0 (current 1.0.3, ✓)
Permissions hash:    a1b2c3... (matches user grant a1b2c3, ✓)
Sandbox subprocess:  ✅ pid 42351, rss 38 MB, cpu 0.4%
Sandbox profile:     fs.read=[pluginDir] fs.write=[dataDir] net=none env=[HOME,PATH,LANG]
Registered:          2 tools, 1 hook, 1 prompt fragment, 1 command
Recent errors:       (last 5, if any)
  2026-07-31 12:34:56  bridge timeout: volund.exec > 5s
Bridge call stats:   this session: 42 calls
                     avg latency: 3.2 ms
                     failure rate: 0%
```

对应实现：`plugin-runtime` 内部维护 per-plugin 的健康度指标；`doctor` 从中读取输出。

#### 6.11.4 插件生命周期事件

补充 `volund.session.on` 可订阅的 session 事件（供插件跟踪 session 生命）：

| 事件 | 触发 | 说明 |
|---|---|---|
| `session.start` | Runner 启动 | 插件可初始化 session-scoped 状态 |
| `session.end` | Runner 关闭 | 清理 session-scoped 状态（Disposable 兜底也会） |
| `turn.start` | 每个 turn 开始 | 已有 |
| `turn.completed` | turn 正常结束 | 已有 |
| `turn.aborted` | turn 被中断 | 已有 |
| `context.compacted` | 上下文压缩发生 | 插件可保存"压缩前的内容"到 storage |

同时补 `volund.plugin.on`（插件自己的生命周期）：
- `deactivate.before` — 用户禁用/卸载前
- `permissions.changed` — 用户在 UI 里改了权限（罕见但需要）

#### 6.11.5 插件升级迁移

**问题**：老 volund 装了 plugin@1.0，用户升到 volund@2.0，plugin `engines.volund: ^1.0.0` 匹配失败 → 加载被拒 → 用户懵。

**策略**：
1. 升级 volund 时，`volund` 启动阶段扫描已装插件，对每个 mismatch 的插件：
   - 查询 npm registry（用 `plugin-registry` v2 或 npm search）看是否有兼容新 volund 的更高版本
   - 若有 → 提示 `volund plugin upgrade <name>`
   - 若无 → 保留在 disabled 状态，session 内红条提示"以下插件需作者更新才能兼容新版本 volund"
2. `volund plugin upgrade <name>` = `pnpm add <name>@latest` 到 plugin 目录 + 重跑权限确认
3. `volund plugin upgrade --all` 批量

不做**自动降级 volund** 或**兼容 shim**，避免生态碎片化。

### 6.12 ★ Memory 系统（长期记忆）

**问题**：Skill / AGENT.md 是**手工维护**的知识源；模型在会话中学到的东西（用户偏好、代码风格线索、"上次踩过的坑"）如果只活在 session 里，下一次开新会话就丢了。需要一个**由模型主导 + 用户可编辑 + 插件可扩展**的长期记忆层。

**心智**：
- **不是** session 存档（那是 §8.2 的 sessions/*.jsonl）
- **不是** Skill（Skill 是手工知识；memory 是**积累性**的），也不是 AGENT.md（那是项目规则手工维护）
- **是** 一组结构化 md 文件，模型通过工具主动召回，pinned 项自动进 system prompt

#### 6.12.1 存储布局与作用域

| 层 | 路径（默认，可配） | 语义 |
|---|---|---|
| **全局** | `~/.volund/memory/*.md` | 跨项目通用的长期偏好、常识 |
| **项目** | `<cwd>/.volund/memory/*.md` | 当前项目专属；随仓库走（用户自行决定是否 `.gitignore`） |

**配置覆写**（`config.toml`）：

```toml
[memory]
paths.global = "~/.volund/memory"              # 可改成团队共享盘
paths.project = ".volund/memory"               # 相对 cwd
max_body_lines = 200                            # 单文件正文行数上限（不含 frontmatter）
max_files_per_scope = 500                       # 每层文件数上限（防失控）
recall_topk = 8                                 # volund.memory.recall 默认返回条数
recall_snippet_lines = 20                       # 每条 memory 快照行数
pinned_auto_inject = true                       # pinned 项自动进 system prompt
pinned_inject_max_lines = 400                   # pinned 总行数上限（超出按 pinned_at 降序截断）
```

#### 6.12.2 Memory 文件格式

```markdown
---
id: mem_01H8...                         # ULID，系统生成，不可改
scope: project                          # 'global' | 'project'
title: "React 项目偏好 hooks 顺序"
tags: [react, code-style, hooks]
pinned: false                           # true 时自动注入 system prompt
created: 2026-07-31T12:34:56Z
updated: 2026-07-31T12:34:56Z
source: model                           # 'model' | 'user' | 'plugin:<name>'
model: anthropic:claude-4               # 写入时的模型（追溯）
version: 1                              # schema 版本
---
# React 项目偏好 hooks 顺序

本项目 hooks 顺序惯例：
1. useState / useReducer
2. useContext
3. useEffect / useLayoutEffect
4. 自定义 hooks

## 例外
- ErrorBoundary 用 class 组件
- ...
```

**约束**：
- 文件名 = `YYYY-MM-DD-<slug>-<mem_id_短12>.md`；slug 从 title 生成（转小写、`[a-z0-9-]`）
- Frontmatter 是 yaml，schema 强校验；缺 `id` / `scope` / `title` → 拒绝加载
- 正文默认 ≤ **200 行**（可配，见 §6.12.4）
- `@include` 在 memory 正文内**允许**（见 §6.5.6，走同一份 loader + 双白名单）
- 附件（图片 / 大文本）**禁止**直接嵌入 md；如需引用，走 `attachment: mem_01H8.../foo.png` 独立文件路径（v2 落地）

#### 6.12.3 Memory 系统提示词（内置 fragment）

**PromptComposer 新增内置 contributor**：`builtin:memory-guide`，priority **950**（紧跟 builtin 1000 之后，Skill 之前）。

**内置文本**（`packages/core/prompts/memory-guide.md`，最终以英文为准，随附中文对照供 review）：

```
## Memory system usage guide

You have access to a long-term memory system across sessions.
Storage: ~/.volund/memory (global) and <cwd>/.volund/memory (project).

### When to store
- User states a durable preference or convention ("我们项目一律用 X")
- You solved a non-trivial problem and its solution will likely recur
- User corrects your default assumption ("this project uses PNPM not npm")
- Domain vocabulary specific to the codebase / team

### When NOT to store
- One-off facts already visible in the codebase (they'll be re-read anyway)
- Anything the user can regenerate cheaply
- Secrets, credentials, personal PII
- Ephemeral context (current turn's temp state)

### What to store
- Concise, canonical form. Not chat transcripts.
- Structured: title + tags + body ≤ 200 lines.
- If body exceeds 200 lines: split into topic-scoped smaller memories.

### How to store
- Use `volund.memory.write({ scope, title, tags, body, pinned? })`.
- scope='project' for repo-specific; scope='global' for cross-project.
- pinned=true ONLY for essentials that must always be in context (max ~5 items).
- Prefer updating an existing memory (`volund.memory.update(id, patch)`) over creating a near-duplicate; use `volund.memory.recall(query)` first to check.

### How to recall
- `volund.memory.recall(query, { scope?, tags?, topk? })` at the start of a task or when a topic surfaces.
- Read full memory with `volund.memory.read(id)` only when snippet is insufficient.

### Boundaries
- User can edit / delete memory anytime; treat memories as advisory, not authoritative.
- If a memory contradicts current instructions, follow current instructions and offer to update the memory.
```

**用户 / 插件覆盖**：
- 用户覆盖：`~/.volund/memory-guide.md`（存在则**替换**内置版；priority 保持 950）
- 项目覆盖：`<cwd>/.volund/memory-guide.md`（叠加在用户版之上，同 priority slot 冲突时项目胜出）
- **插件贡献**：`volund.memory.contributePrompt(fragment)` — priority 固定 `plugin:<name>:memory` = 60（在 plugin 常规 50 之上，但仍低于 project/user）；插件可**追加**建议但**不能**覆盖内置

#### 6.12.4 200 行限制（软 → 硬 → 可覆盖）

**分层策略**：
1. **软提示（模型侧）**：memory system prompt 里教模型上限（§6.12.3）
2. **硬校验（writer 工具侧）**：`volund.memory.write` 提交时统计 body 行数，超限 → 返回 `MemoryLimitExceededError` 给模型，含明确 remediation：`{ current: 234, limit: 200, suggestion: 'split by heading or reduce examples' }`；模型收到后自行分段重试
3. **Hook 干预**：`memoryPreWrite` hook 可以：
   - 返回 `{ veto: true, reason }` 阻止写入
   - 返回 `{ split: [{ title, body }, ...] }` 自动切成多条
   - 返回 `{ modifiedBody, modifiedLimit }` 修改内容 / 临时放宽上限
4. **配置覆盖**：`config.toml [memory] max_body_lines = 500`（全局）；hook 可动态覆盖（如按 tag 差异化）
5. **超硬上限**：任何配置都不能超过 **2000 行**（防单文件塞爆 context）

**"需要模型支持"体现**：writer 工具的错误 message 明确告诉模型如何分段；模型不听（不断重试超长）→ 三次后 writer 工具**自动**按 markdown heading 切段并写入多条（保底），emit `memory.auto_split` telemetry。

#### 6.12.5 Bridge API（`volund.memory`）

```ts
interface MemoryBridge {
  // 召回：按 query 做 BM25 / 关键字匹配（走 native-bridge 的 volund-search）
  recall(query: string, opts?: {
    scope?: 'global' | 'project' | 'both'    // 默认 both
    tags?: string[]                            // AND 语义
    topk?: number                              // 默认 config.recall_topk
    snippetLines?: number                      // 默认 config.recall_snippet_lines
  }): Promise<MemoryRef[]>                     // { id, scope, title, tags, snippet, updated }

  // 读全文
  read(id: string): Promise<MemoryDoc>

  // 写入（超限自动 error，见 §6.12.4）
  write(spec: {
    scope: 'global' | 'project'
    title: string
    body: string                                // md 正文
    tags?: string[]
    pinned?: boolean
  }): Promise<MemoryRef>

  // 部分更新（frontmatter + body 独立 patch）
  update(id: string, patch: Partial<{
    title: string
    body: string
    tags: string[]
    pinned: boolean
  }>): Promise<MemoryRef>

  delete(id: string): Promise<void>

  list(opts?: {
    scope?: 'global' | 'project' | 'both'
    tag?: string
    pinned?: boolean
  }): Promise<MemoryRef[]>

  // 贡献 memory-guide 追加片段（插件用）
  contributePrompt(fragment: PromptFragment): Disposable
}
```

**权限**（`manifest.permissions.memory`）：

```json
{
  "memory": {
    "read": ["project"],                      // 或 "global" / "both"
    "write": false,                            // 默认 false
    "contributePrompt": true
  }
}
```

未声明 = 默认 `read: 'project'`, `write: false`, `contributePrompt: false`。

#### 6.12.6 Hooks

新增 hook 事件（走同一 §6.11.1 优先级 pipeline）：

| 事件 | 触发点 | payload | 常见用途 |
|---|---|---|---|
| `memory.preRecall` | `recall()` 入口 | `{ query, opts }` | 改写 query / 加 tag filter |
| `memory.postRecall` | recall 结果返回前 | `{ refs, opts }` | 过滤敏感 / 重排 |
| `memory.preWrite` | `write()`/`update()` 校验前 | `{ spec }` | veto / split / modifyBody / 覆盖 limit |
| `memory.postWrite` | 落盘后 | `{ ref }` | 通知外部索引 / 备份 |
| `memory.preRead` | `read(id)` | `{ id }` | 权限二次校验 |
| `memory.deleted` | delete 后 | `{ id }` | 联动清理 |

**内置 hook**：
- `memory.preWrite`（priority 1000）：脱敏扫描（复用 §4.13 sanitize + 追加 regex：形如 API key / URL userinfo / OAuth code 直接 veto）
- `memory.preWrite`（priority 900）：`max_files_per_scope` 校验，超出提示 GC

#### 6.12.7 CLI（`volund memory <sub>`）

```
volund memory list [--scope global|project|both] [--tag T] [--pinned]
volund memory show <id>                     # 输出 md（含 frontmatter）
volund memory add [--scope ...] [--pinned]  # 交互 / --title / --tags / --body-stdin
volund memory edit <id>                     # 打开 $EDITOR，保存时 re-validate frontmatter + limit
volund memory rm <id> [--yes]
volund memory pin <id> / unpin <id>
volund memory search <query> [--scope ...] [--tag ...]
volund memory export [--scope ...] > memory.tar
volund memory import memory.tar             # 冲突：--strategy skip|overwrite|rename
volund memory doctor                        # 校验所有 memory frontmatter / 行数 / 冲突
volund memory reindex                        # 重建搜索索引
```

**返回码**：0=成功；2=校验失败；3=找不到 id；13=权限拒绝。

#### 6.12.8 PromptComposer 集成

新增 priority slot：

| priority | source | 说明 |
|---|---|---|
| 1000 | `builtin` | volund 内置基础 prompt（§6.5.1） |
| **950** | `builtin:memory-guide` | 新增：memory 系统使用指引（§6.12.3） |
| 800 | `skill:<name>` | Skill（§6.5.2） |
| **700** | `memory:pinned` | 新增：所有 pinned=true 的 memory（按 pinned_inject_max_lines 截断） |
| 600 | `project` | AGENT.md |
| 400 | `user` | ~/.volund/PROMPT.md |
| 60 | `plugin:<name>:memory` | 新增：插件对 memory-guide 的追加片段 |
| 50 | `plugin:<name>` | 插件常规 prompt |

`memory:pinned` contributor 由新包 `packages/memory-runtime` 在启动时注册；PromptComposer 在 pinned 变化时收到 `invalidate('memory:pinned')` 事件重新拉取。

#### 6.12.9 依赖与落位（§1 差量）

新增：
- **`packages/memory-runtime`**：memory 存储 / 索引 / bridge server（供 plugin-runtime bridge 转发调用） / CLI 后端
  - 依赖：`core[type-only]` + `permission` + `hooks` + `native-bridge`（`volund-search` 做召回索引） + `shared`
  - 复用 §6.5.6 `PromptLoader`（读 memory md 时展开 `@include`）
- **`packages/core`** 责任扩充：
  - PromptComposer 支持 `memory:pinned` slot 与 invalidate hook
  - `PromptLoader` 服务于 memory-runtime / skills-runtime / storage
- **`packages/plugin-sdk`** 类型扩充：`MemoryBridge` / `MemoryRef` / `MemoryDoc` / hooks `memory.*` 事件类型

`§1.2 依赖表` 增补：
- `memory-runtime → core[type-only] / permission / hooks / native-bridge / shared`
- `plugin-runtime` 通过 volund bridge 转发 `memory.*` RPC 到 `memory-runtime`（不新增 import 依赖，走运行时端口）

#### 6.12.10 边界与安全清单

| 规则 | 强制点 |
|---|---|
| memory 文件 **必须**是 `.md`（其它后缀拒绝加载） | memory-runtime loader |
| frontmatter schema 校验失败 → **拒绝加载**，emit warning，用户可 `volund memory doctor` 修 | 单元测试 |
| 正文行数 > `max_body_lines` → writer **拒绝**并返回 remediation error；三次不听自动 split | 集成测试 |
| memory `read` / `write` **必须**经 permission 校验（scope + 插件权限） | memory-runtime 单元测试 |
| 内置 `memory.preWrite` 脱敏 hook **不可被禁用** | 组装期常量 |
| pinned memory 总注入行数 > `pinned_inject_max_lines` → 按 pinned_at 降序截断，emit `memory.pinned_truncated` | composer 单元测试 |
| memory export **必须**默认剥离 `source: model` 之外的 raw 时间戳可选脱敏（`--redact-timestamps`） | CLI 测试 |
| memory 文件写入 **必须**走 `packages/storage` 的原子写 + fsync（防崩溃残缺） | storage 单元测试 |
| memory 索引 **必须**跟随文件变化更新（watcher + 启动 reindex） | memory-runtime 集成测试 |
| memory 数量 > `max_files_per_scope` → 拒绝新建 + 提示 GC；hook `memory.preWrite` 可覆盖 | 单元测试 |

#### 6.12.11 事件（telemetry，本地 sink）

| 事件 | 说明 |
|---|---|
| `memory.recalled` | `{ query_len, scope, topk, hits, duration_ms }` |
| `memory.written` | `{ scope, source, tags, body_lines, pinned }` |
| `memory.updated` | `{ id, fields_changed[] }` |
| `memory.deleted` | `{ id, scope }` |
| `memory.pinned_toggled` | `{ id, pinned }` |
| `memory.limit_exceeded` | `{ current_lines, limit, retries }` |
| `memory.auto_split` | writer 三次失败后自动切段 |
| `memory.pinned_truncated` | composer 截断了 pinned 输出 |
| `memory.doctor_fixed` | `volund memory doctor` 修复了 N 条 |

Payload 全部经 `shared.sanitize()`；query / body 摘要而非全文入日志。

#### 6.12.12 里程碑

- **L1（MVP）**：无 memory
- **L2**：memory-runtime + 存储 + `write/read/list/delete` + CLI + 内置 memory-guide + pinned 注入 + preWrite 脱敏 hook
- **L3**：`recall` 走 volund-search 索引 + hooks 全谱 + 插件 `volund.memory.*` bridge 暴露 + `volund memory doctor`
- **L4**：memory attachment（图片） + 团队共享盘（`config.paths.global` 指向网络路径）+ export/import + embedding 语义检索（延后 v2，取决于 embedding 提供方）

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
├─ <TopBar>                        # session id / cost / model / cwd
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
- 历史：↑ / ↓ 翻历史输入（存到 `~/.volund/history`，纯文本，见 §7.7 脱敏规则）

#### 7.5.2 附件（粘贴 / 拖拽）

InputBox 有三条附件入口，最终都归一为 `AttachmentRef`（§2.1.1）：

| 入口                     | 触发条件                                                | 归一化                                                |
|--------------------------|---------------------------------------------------------|-------------------------------------------------------|
| **粘贴文件路径**         | 剪贴板文本能被 `fs.realpath` 解析到 cwd 允许范围内的文件 | `AttachmentRef { kind: 'path', path, mime }`          |
| **拖拽文件**             | 终端 escape sequence（iTerm2 / Warp / WezTerm 支持）    | 同上                                                  |
| **粘贴剪贴板图片二进制** | 终端 image paste escape / OSC 52 / `Cmd+V` 二进制帧     | 主进程落盘 → `AttachmentRef { kind: 'blob', handle }` |

**剪贴板图片二进制流程**（L2 里程碑）：

1. UI 检测到 image paste escape（或系统级 clipboard access via native-bridge），拿到 PNG/JPEG bytes
2. UI 调 `native.attachments.stage(bytes, mime)` → native-bridge 落盘到 `~/.volund/sessions/<sid>/attachments/<hash>.<ext>`，返回 `handle`
3. UI 在输入行内插入占位 chip：`[image: <hash-8>.png]`（不可编辑的原子 token）
4. 提交时 InputBox 把 chip 展开成 `ContentPart { type: 'image', source: { handle, kind: 'blob' }, mime }`
5. 会话结束 / attachment 被 context 压缩替换时，`native.release(handle)` 释放
6. 权限：`stage()` 首次调用弹一次 `allow-session`（防止误粘敏感截图，弹窗内显示尺寸 / mime，不显示内容）

**不支持的场景**（明确不做）：
- 终端**不支持** image paste escape 时不做 fallback 屏幕截图 —— 用户需先保存文件再拖拽
- 二进制附件**不进** `~/.volund/history`（脱敏），历史里只留 chip 文本 `[image: <hash-8>.png]`

#### 7.5.3 `@` 前缀：双模式选择器

`@` 前缀在 volund 中承担**两种能力**（引用文件 / 覆盖模型），语义在输入时**由用户主动选择**，避免启发式歧义：

**触发流程**：

1. 用户键入 `@`，InputBox 弹出**能力选择器 popup**（两项，方向键选，Enter 确认）：
   ```
   @ ▸ 引用文件 (file)     — 把文件内容作为 attachment 附加到本 turn
       @ 模型 (model)      — 单次覆盖本 turn 的模型（见 §3.9）
   ```
2. 选中后 popup 切换为对应的**二级补全器**：
   - **file 模式**：popup 变为 fuzzy path picker，候选来源为 cwd（尊重 `.gitignore` + `.volundignore`），选中后在输入行插入 chip `[@file:<relative-path>]`
   - **model 模式**：popup 变为 alias 列表（来自 `config.toml [models.aliases]`），选中后在行首插入 `@<alias> `（若已存在则替换）
3. 用户可用 `@@` 显式跳过选择器直接进 file 模式（对齐 claude-code 肌肉记忆），`@!` 显式进 model 模式（对高频用户提速）

**为什么用选择器而不是启发式（例如"存在即文件"）**：

| 方案                                | 问题                                                            |
|-------------------------------------|-----------------------------------------------------------------|
| 靠"路径是否存在"启发                | alias 名可能碰巧和文件名同名 → 用户预期错乱                     |
| 只保留一个语义（例如放弃 @model）   | claude-code 用户 muscle memory 断裂，`@sonnet` 变成"找 sonnet 文件" |
| **双模式 + 显式选择（当前决策）**   | 首次略慢一步；但语义明确、可追加更多前缀能力（未来 @skill 等）  |

**file 模式细节**：

- chip `[@file:src/foo.ts]` 提交时展开成 `ContentPart { type: 'file', source: { path, kind: 'path' }, mime, filename }` —— 走同一 attachment 生命周期
- 路径归一化 + `path-guard`：拒绝 `~/.volund/` / `~/.ssh/` / `/etc/` 等敏感前缀（沿用 §11.6 W6 规则）
- 大文件（> 1MB）自动截断为 head+tail 摘要 + 附上完整二进制附件（由 context policy 决定注入形式）
- 目录：允许 `@file:src/`，展开为该目录 tree（≤ 200 项，超过报错要求收窄）

**model 模式细节**：完全复用 §3.9 现有语义，无变化。

#### 7.5.4 `#sess_<id>` 前缀：跨会话引用

见 §8.5（新增）"跨会话上下文引用"。InputBox 侧行为：

- 键入 `#sess_` 触发 popup，候选为 `~/.volund/sessions/*.jsonl` 按 `mtime` 倒序 + 会话标题（`/save` 命过名的显示别名）
- 选中后插入 chip `[#sess:<id-8>@<strategy>]`，`strategy` 默认 `relevant`，Tab 切 `handoff`
- 提交时 Runner 通过 `SessionContextReader.read({ sessionId, query: <当前用户输入的其余文本>, strategy, maxTokens })` 拉取内容，注入为一条 `role: 'user'` 的 `content[0].type='text'`，形如 `<session_context id="..." strategy="relevant">...</session_context>`
- 权限：跨会话读**首次**弹 `allow-once/allow-session/deny`（默认只允许同用户 `~/.volund/sessions/`，跨机器需 `volund history import` 走过一次）

### 7.6 无颜色 / 结构化输出模式

- 检测：`NO_COLOR=1` env / `--no-color` flag → 关掉所有 ANSI
- `--json` 模式：所有输出转成 NDJSON（每行一个事件），便于脚本消费
  - 用于 CI / MCP-style 集成
  - 关闭 Ink，走 stdout 直写

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
| `@` 触发**必须**走选择器或显式前缀（`@@` / `@!`），**禁止**基于路径存在性启发 | InputBox 单元测试                                |
| `#sess_<id>` 引用**必须**过 `SessionContextReader` 端口 + 权限校验            | core code review + 集成测试                     |
| `SessionContextReader` **禁止**返回其它用户 home 下的 session（跨用户拒绝）   | storage 层 stat uid 校验                        |

### 7.8 里程碑

- **L1（MVP）**：完整消息渲染 + 流式 + 权限弹窗 + slash 命令 + `@` 选择器（model 分支可用）
- **L2**：`@` file 分支 + 附件粘贴（路径 / 拖拽）+ 图像 preview（终端支持 sixel/kitty 时）+ 剪贴板图片二进制粘贴
- **L3**：`#sess_<id>` 跨会话引用 + `SessionContextReader` + `--json` 结构化输出模式
- **L4**：主题定制 + 插件 UI 扩展点（状态栏 item） + `@skill` / `@memory` 等额外前缀能力

## §8 会话与配置存储

本节定义 `packages/storage` 的职责。

### 8.1 存储模型总览

**决策**：**纯文件**，无数据库依赖。所有数据在 `~/.volund/` 或 `<cwd>/.volund/`。

```
~/.volund/
├─ config.toml                    # 全局配置（provider / router / aliases）
├─ credentials.enc                # 加密的凭据文件（auth 包管理）
├─ permissions.toml               # 全局权限白名单
├─ plugins.enabled.toml           # 已装载插件 + 权限 hash
├─ history                        # 输入历史（脱敏）
├─ PROMPT.md                      # 用户全局 system prompt 片段
├─ plugins/<pkg>/                 # 插件（见 §6.2）
├─ skills/<name>/                 # Skills
├─ memory/                        # v4 新增：全局长期记忆（md）
│  ├─ mem_01H8xxx.md              # 每条一个 md（≤200 行 body，见 §6.12）
│  └─ index.jsonl                 # 可选轻量索引（title/tags/pinned/updated 摘要）
├─ sessions/
│  └─ <session-id>.jsonl          # 每 session 一个 JSONL 文件（append-only）
├─ telemetry/
│  ├─ volund-YYYY-MM-DD.log       # 日志
│  └─ metrics-YYYY-MM-DD.jsonl    # 指标
└─ backups/                       # 破坏性操作前的文件备份（可选）

<cwd>/.volund/
├─ config.toml                    # 项目局部覆盖
├─ permissions.toml               # 项目权限白名单
├─ plugins/                       # 项目局部插件
├─ memory/                        # v4 新增：项目局部长期记忆（md，见 §6.12）
│  ├─ mem_01H9xxx.md
│  └─ index.jsonl
└─ AGENT.md（复用现有约定）        # 项目 system prompt
```

### 8.2 Session 存储：JSONL append-only

每 session 一个 `<session-id>.jsonl`，每行一个 event（复用 §2.3 的 16 种事件）：

```
{"type":"session.started","sessionId":"...","at":"...","payload":{"cwd":"..."}}
{"type":"message.appended","sessionId":"...","at":"...","payload":{"messageId":"...","role":"user","content":[...]}}
{"type":"stream.delta","sessionId":"...","at":"...","payload":{"text":"H"}}
{"type":"stream.delta","sessionId":"...","at":"...","payload":{"text":"i"}}
{"type":"stream.completed","sessionId":"...","at":"...","payload":{"messageId":"..."}}
{"type":"tool.requested","sessionId":"...","at":"...","payload":{"tool":"Bash","input":{...}}}
...
```

**为什么 JSONL append-only**：
- 崩溃安全：每个事件一写就刷盘，进程崩了不丢消息
- 可 replay：读全文重放事件即可重建 SessionState
- 可 diff：git-friendly，便于调试
- 无需索引：session 数量有限，遍历 filename 即可列表

**优化**：
- `stream.delta` **不写盘**（volume 太大），只写 `stream.completed`（含完整 assistant message）
- 附件二进制不写 JSONL，`AttachmentRef` 里存路径引用，实际文件在 `~/.volund/sessions/<sid>/attachments/<hash>.bin`
- 写入通过 `write` 追加 + fsync（可配置 `fsync: async` 用 fsync interval 提升吞吐）

**订阅路径**：`storage` 订阅 core `session.started` / `message.appended` / `stream.completed` / `tool.completed` / `context.compacted` / `session.ended`。

**Replay**（W10）：`storage.loadSession(id)` 顺序读事件**只重建 `SessionState`**（messages / permissionCache / cumulativeUsage / turn 元数据），**不复现流式动画**、**不重放** `stream.delta` / `stream.started`（这些事件因 §8.2 优化本就不落盘）、**不重跑** hook / tool / provider 调用。UI 侧 `resume` 收到的是"已完结"的 assistant messages，直接一次性渲染。

- Replay 过程 emit 一个 `session.resumed` 事件（新事件类型，见 §2.3 需 +1 行）替代 `session.started`，subscriber 可据此区分冷启动 vs 恢复。
- 恢复后 `turn.status` 若非 `done` / `aborted` / `error` → 强制 mark 为 `aborted`（"上次崩在半途"）。
- 恢复后 seen-set 从空开始，因为进程重启；idempotency 由 `event.id` 唯一性保证。
- `volund resume` 不支持"从 turn 中段继续跑"，语义永远是"从上一 turn 边界继续，新 turn 从用户输入开始"。

### 8.3 Config：分层 TOML

**层次**（从低到高，高覆盖低）：

1. 内置默认（硬编码）
2. `~/.volund/config.toml`（用户全局）
3. `<cwd>/.volund/config.toml`（项目）
4. `volund_*` 环境变量
5. CLI flags

**config.toml 示例**：

```toml
[provider]
default = "anthropic"

[provider.anthropic]
model = "claude-sonnet-4-5"

[router]
type = "single"                     # or "fallback" / "role"

[models.aliases]
sonnet = { provider = "anthropic", model = "claude-sonnet-4-5" }
"gpt-4o" = { provider = "openai", model = "gpt-4o" }

[ui]
theme = "auto"
color = true

[telemetry]
sink = "local"                       # 默认本地，OTel 需要显式设 "otel"

[context]
policy = "sliding"
max_tokens = 180000
```

**schema**：用 zod 描述（`packages/shared/config-schema.ts`），启动时校验，友好报错。

### 8.4 Credentials：多层 fallback（auth 包）

- Layer 1：**OS keychain**（macOS Keychain / Windows Credential Manager / Linux libsecret）—— 首选
- Layer 2：**加密文件** `credentials.enc`（用户设 passphrase 派生 key，AES-256-GCM）—— keychain 不可用时
- Layer 3：**env 变量** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / ...—— 最后 fallback

`auth.getCredential(provider)` 按顺序尝试，第一个命中即返回。

**特别注意**：
- credentials **绝对不能**明文进 `config.toml` / `sessions/*.jsonl` / `telemetry/*`
- 日志脱敏（`packages/shared` 的 `sanitize()` 函数）在 sink 前统一过滤

#### 8.4.1 auth 事件谱（本地 telemetry，为后期统计预留）

**心智**：auth 是安全 + 用户体验的双热点，必须为**后期数据分析**（不是自动上报）留下完整轨迹。所有事件写入本地 `~/.volund/telemetry/*.jsonl`，遵循 §4.13：默认不出网，仅 OTel opt-in 时上报。**每一条事件都必须脱敏**（不含 key/token/passphrase 明文）。

`auth` 包必须通过 `packages/telemetry` 的 logger 发出以下事件（`source: 'auth'`）：

| 事件 | 触发点 | 关键字段（脱敏后） | 用途 |
|---|---|---|---|
| `auth.login.started` | `volund login <p>` 进入交互流程 | `provider`, `flow`（`api-key` / `oauth` / `stdin`）, `session_uuid` | 漏斗分析：多少人开始登录 |
| `auth.login.verify_requested` | 调 provider 的 verify 接口前 | `provider`, `endpoint_kind`（如 `list_models`）, `latency_est_ms` | 观察验证接口分布 |
| `auth.login.verify_result` | verify 接口返回后（成功/失败都发） | `provider`, `outcome`（`ok` / `4xx` / `5xx` / `network` / `timeout`）, `http_status`, `duration_ms` | **核心漏斗**：登录失败率、失败原因 |
| `auth.login.stored` | 凭据成功落盘 | `provider`, `sink`（`keychain` / `enc_file` / `env_only`）, `duration_ms` | 存储去向分布 |
| `auth.login.failed` | 任何登录失败 → 拒绝落盘 | `provider`, `stage`（`input` / `verify` / `store`）, `error_class`, `duration_ms` | 错因诊断 |
| `auth.login.cancelled` | 用户 Ctrl+C 中断 | `provider`, `stage` | 放弃率 |
| `auth.logout.completed` | `volund logout` 完成 | `provider`, `sinks_cleared`（数组，非明文） | 流失统计 |
| `auth.credential.resolved` | `getCredential(p)` 命中 | `provider`, `layer`（1/2/3）, `cache_hit`（bool）, `duration_ms` | fallback 使用分布 |
| `auth.credential.miss` | 三层都没命中 | `provider`, `layers_tried`（数组） | 用户"login 前跑命令"的比例 |
| `auth.keychain.error` | OS keychain 报错（锁定/无权/损坏） | `platform`, `error_class`, `fallback_to` | keychain 稳定性 |
| `auth.encfile.unlock_prompted` | 需要用户输入 passphrase 解锁 enc_file | `provider` | UX 摩擦点 |
| `auth.encfile.unlock_result` | passphrase 校验结果 | `outcome`（`ok` / `bad_passphrase`）, `attempts` | 加密文件的可用性 |
| `auth.migration.plaintext_found` | 启动扫描发现老配置里的明文凭据 | `location_kind`（`config` / `mcp.toml`）, `provider` | 从老版本迁移的规模 |
| `auth.migration.plaintext_moved` | 明文凭据被自动迁移到 auth | `location_kind`, `provider`, `sink` | 迁移完成度 |
| `auth.dangerously.skip_verify` | 用户用了 `--skip-verify --dangerous` | `provider` | 安全开关滥用监测 |
| `auth.mcp.keyref_created` | `keyref://` 占位写入 mcp.toml | `mcp_name`, `field` | MCP 凭据安全性 |
| `auth.mcp.plaintext_kept` | 用户拒绝迁移，明文留在 mcp.toml | `mcp_name`, `field` | 需要发红条警告的地方 |

**通用字段**（每条事件强制携带）：
- `ts` (ISO-8601 UTC)
- `volund_version`
- `session_uuid`（同一个 volund 进程内稳定，进程间独立；**不是**用户 ID）
- `platform` (`darwin` / `linux` / `win32`)
- `arch`

**脱敏白名单**（`packages/shared.sanitize()` 强制过滤）：
- key / token / passphrase / OAuth code / refresh_token / cookie / Authorization header → 全部 redact
- URL 的 userinfo (`https://user:pass@host`) → 移除
- 错误 message 里的**任何** ≥16 位连续 base64/hex/JWT 片段 → redact

**事件消费路径**：
- 默认：本地 `~/.volund/telemetry/YYYY-MM-DD.jsonl`
- `volund telemetry export` → 用户可导出（用于反馈 / bug report）
- 用户显式配 `[telemetry.otel]` → 上报到 OTLP endpoint（§4.13 opt-in）
- **禁止**任何形式的自动 phone home（PR review 硬门槛）

### 8.5 跨会话上下文引用（SessionContextReader）

允许当前 turn 在 prompt 中**引用另一个已存 session** 的相关内容，用于跨会话 handoff 或"从上次的排查继续"。UI 侧语法见 §7.5.4 / §11.5。

#### 8.5.1 端口定义

放在 `packages/storage`，由 `apps/cli` 装配注入 core：

```ts
export interface SessionContextReader {
  /**
   * 读另一个 session 的相关内容并压缩到给定 token 预算内
   */
  read(req: SessionContextRequest): Promise<SessionContextResult>
  /**
   * 列出候选（供 InputBox popup 使用）
   */
  list(filter?: SessionListFilter): Promise<SessionListItem[]>
}

export interface SessionContextRequest {
  sessionId: string                                 // 匹配 `sess_*` pattern
  query: string                                     // 当前用户输入（作为 relevance 查询）
  strategy: 'relevant' | 'handoff'                  // relevant=聚焦检索 / handoff=收尾摘要
  maxTokens: number                                 // 默认 4000，硬上限 12000
}

export interface SessionContextResult {
  content: string                                   // 拼给 provider 的正文（含 XML wrapper）
  tokensEstimated: number
  citedEvents: string[]                             // 引用的 event.id 列表（用于 telemetry）
  redacted: boolean                                 // 是否触发过脱敏
}

export interface SessionListItem {
  id: string
  title?: string                                    // `/save <name>` 命过名的显示别名
  cwd: string
  updatedAt: string
  messageCount: number
}
```

#### 8.5.2 两种 strategy 语义

| strategy   | 用法                                     | 内部行为                                                                                                                        |
|------------|------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `relevant` | 聚焦检索（默认）                          | 遍历目标 session `.jsonl` → BM25 打分（按 `query`）→ 选 Top-K message 段落 → 用 XML 包裹注入                                    |
| `handoff`  | "继续上一次的工作"                        | 取目标 session 尾部窗口（默认最后 40 条 event）→ 用 §6.11 的压缩 handler（简化版）生成 handoff summary → 输出完整背景 + 未完事项 |

#### 8.5.3 注入格式

Runner 在 `sendUserMessage` 前把结果拼成一条 `role='user'` 的 message，作为**独立 turn 的第一条**（不与用户主 message 合并，避免干扰模型对指令边界的识别）：

```xml
<session_context id="sess_01HABC..." strategy="relevant" cited="3 events">
[目标会话的摘录 / handoff summary]
</session_context>
```

- **不进** SessionState.messages 长期存储的部分：拼成的 wrapper 参与本 turn 上下文，但 `message.appended` 事件的 `content` 里只存**引用元数据**（`sessionId` + `strategy` + `citedEvents`），不 duplicate 原文。context 压缩时可按需重读，避免 O(n²) 存储放大。
- 引用的 event.id 记入 telemetry，方便 debug"这次回答参考了哪几条历史消息"。

#### 8.5.4 权限模型

- **首次**读某个非当前 session → 权限弹窗，选项 `allow-once` / `allow-session` / `deny`
- `allow-session` 的粒度：**当前 session** 内可再读**任意** session（不逐个弹）—— 因为一旦允许历史访问，逐条弹会话疲劳无收益
- `permissionCache` key：`session-context-read:*`（不带 sessionId 后缀）
- **跨用户拒绝**：`stat` 目标文件 uid ≠ 当前 uid → 直接拒绝并 emit `error.raised`（防止误配 `~` 指向共享目录）
- 跨机器：不做在线拉取，只读 `~/.volund/sessions/`。远程 session 需 `volund history import <file>` 走一次

#### 8.5.5 边界

| 规则                                                                        | 强制点                                    |
|-----------------------------------------------------------------------------|-------------------------------------------|
| `read()` 结果**必须**过 `shared.sanitize()`（credentials / api key 脱敏）    | storage 单元测试                           |
| `maxTokens` **必须** ≤ 12000（防止一次注入撑爆上下文）                        | 端口 assertion                             |
| 未知 sessionId → 明确报错，不 silent fallback                                | storage 单元测试                           |
| 目标 session 版本号不兼容 → 降级到只读 `role='user'` 文本，标注"部分事件跳过" | storage.loadSession 版本兼容层             |
| 引用**禁止**递归（被引用 session 内的 `#sess_` 引用不再展开）                 | reader 单元测试                            |

### 8.6 Backups：破坏性操作前

- `Write` / `Edit` / `MultiEdit` 执行前，如果目标文件存在 → 备份到 `~/.volund/backups/<sha>/<original-path>`
- `volund restore <session-id>` 可回滚该 session 内的所有变更
- Backups 有 GC 策略：默认保留 7 天 + 500MB 上限，超出按 LRU 清理

### 8.7 Telemetry：默认本地

**已在 §4.13 强制**：默认写 `~/.volund/telemetry/*.jsonl`，不出网。

- `volund-YYYY-MM-DD.log` — 结构化日志（level / source / message / meta）
- `metrics-YYYY-MM-DD.jsonl` — 指标（每次 provider call 的 usage/cost/latency）
- `volund telemetry export` — 用户显式导出（用于 bug 报告）

**OTel opt-in**：`[telemetry] sink = "otel"` + endpoint 配置后才走 OTLP 上报。第一次 opt-in 时提示"数据将上报到 X，是否确认"。

### 8.8 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| `storage` **只**订阅 core 事件，**禁止** import core Runner                          | ESLint 依赖规则                                 |
| Session `.jsonl` 写入**必须** append + fsync（默认同步，可配 async）                  | storage 单元测试                                |
| 附件二进制**不进**主 JSONL，存独立文件按 hash 索引                                    | code review                                     |
| Credentials **禁止**明文写任何文件（除加密的 `credentials.enc`）                     | ESLint + 单元测试扫 sink                        |
| `config.toml` schema 校验**必须**在启动时做，失败不启动                              | apps/cli 启动流程                                |
| Backups GC **必须**默认开启（防磁盘打爆）                                            | storage 单元测试                                |
| Telemetry sink 默认 `local`，`otel` 需显式配置                                       | §4.13 已锁                                       |
| Session `resume` **必须**校验版本号，不匹配拒绝                                      | storage.loadSession 单元测试                    |
| `auth` 包每一个登录 / getCredential / migration 分支 **必须**发对应 §8.4.1 事件      | auth 单元测试 + telemetry sink assertion         |
| 任何 auth 事件 payload **必须**过 `shared.sanitize()`，禁止 raw key/token 入日志       | ESLint sink 白名单 + 单元测试                    |
| Memory md **必须**含合法 frontmatter（id/scope/created/updated），缺失禁止写入        | memory-runtime 写入校验                          |
| Memory 文件 body **必须** ≤ `[memory].max_body_lines`（默认 200），超限触发降级链路   | memory-runtime writer + hook `memory.preWrite`  |
| Memory 存储路径 **必须**在配置声明的 `paths.global` / `paths.project` 之下（canonicalize + escape 检测） | memory-runtime path guard                     |
| `volund.memory.*` bridge 调用**必须**过 `manifest.permissions.memory` 白名单 + 权限决策    | plugin-runtime + permission 单元测试            |

### 8.9 里程碑

- **L1（MVP）**：config.toml 分层 + credentials keychain/env + sessions JSONL + telemetry 本地
- **L2**：backups + `volund restore` + `volund resume`
- **L3**：session 索引 + 搜索（`volund history search`）+ `SessionContextReader`（`relevant` + `handoff` 双 strategy）
- **L4**：加密文件 credentials + OTel sink + 跨会话引用的高级 relevance（可选向量索引，若引入需 opt-in，见 §4.13）

## §9 构建 / CI / 分发

本节定义 TypeScript + Rust 双栈的构建链路、CI 矩阵、发布流程。

### 9.1 构建栈

| 层            | 工具                                            |
|---------------|-------------------------------------------------|
| TS 库         | **rolldown**（Vite 8 底层）单文件 ESM 产物         |
| TS 应用       | rolldown（apps/cli 打成单 bin）                  |
| 文档站        | **VitePress 8**（apps/docs，静态站）              |
| Rust addon    | **napi-rs**（volund-search / volund-fs）         |
| Rust bin      | **cargo** + `cross`（volund-sandbox 交叉编译）    |
| Monorepo 编排 | **turborepo**（`turbo run build`）                |
| Package mgr   | **pnpm** workspace + catalog（统一版本）          |
| TypeDoc       | 每个 package 生成 API 文档 → 注入 apps/docs        |

### 9.2 pnpm workspace

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'platforms/*'
  - 'examples/*'

catalog:
  # 统一版本管理（所有 packages 引用 catalog:）
  typescript: ^5.6.0
  react: ^19.0.0
  ink: ^5.0.0
  vitest: ^2.0.0
  vitepress: ^2.0.0
  rolldown: ^1.0.0
  vite: ^8.0.0
  zod: ^3.23.0
  immer: ^10.1.0
  # ...
```

### 9.3 turbo pipeline

`turbo.json`（要点）：

```jsonc
{
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", "*.node"]
    },
    "build:native": {
      "outputs": ["*.node", "target/release/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "docs:build": {
      "dependsOn": ["^build"],
      "outputs": ["apps/docs/.vitepress/dist/**"]
    }
  }
}
```

**依赖顺序**：
- kits（provider-kit / tool-kit）→ core → router / providers / tools → apps
- shared 是根，最先 build
- native-bridge 在 tools / auth 之前 build

### 9.4 CI Matrix

**`.github/workflows/ci.yml`**：

```
jobs:
  ts:
    matrix: [ubuntu-latest, macos-latest, windows-latest]
    steps: pnpm install → pnpm turbo run typecheck test build

  native:
    matrix:
      - { os: macos-latest, target: aarch64-apple-darwin }
      - { os: macos-13,     target: x86_64-apple-darwin }
      - { os: ubuntu-latest,target: x86_64-unknown-linux-gnu }
      - { os: ubuntu-latest,target: aarch64-unknown-linux-gnu, cross: true }
      - { os: windows-latest,target: x86_64-pc-windows-msvc }
      - { os: windows-latest,target: aarch64-pc-windows-msvc, cross: true }
    steps: cargo build --release --target ${{ matrix.target }}
            → 打包到 platforms/native-<kind>-<os>-<arch>/

  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [ts, native]
    steps: changeset publish → npm + GitHub Release
```

### 9.5 发版策略

**工具**：`changesets`（版本号 + changelog）

**流程**：
1. 开发者提 PR 时，若改动需发版 → `pnpm changeset` 生成 `.changeset/*.md`
2. PR 合入 main 后，`changesets` bot 打开 "Version Packages" PR
3. 合入 Version PR → tag 触发 CI `release` job：
   - `changeset publish` 发所有 packages 到 npm（含 18 个平台包）
   - `apps/cli` 单独发 `volund-code` 包（bin）
   - `apps/docs` **不发** npm，`docs:deploy` job 部署到 GitHub Pages / Vercel
4. GitHub Release 附带 changelog + 二进制 archive（可选，方便非 npm 用户）

**版本语义**：
- kits（provider-kit / tool-kit / plugin-sdk） → semver 严格，major 需广而告之
- provider-* / tools → semver
- volund-code（cli）→ semver
- 平台包 → 与 native-bridge 同版本号（`workspace:*`）

**兼容性**：
- `plugin-sdk` major = volund major；volund 支持 sdk 最近 2 个 major（宽松兼容）
- `mcp-client` 兼容 MCP protocol 版本

### 9.6 apps/cli 打包与分发

- rolldown 打成 `dist/volund.js`（单文件 ESM）+ shebang
- package.json `"bin": { "volund": "dist/volund.js" }`
- npm 用户：`npm i -g volund-code` → 全局 `volund` 命令
- Homebrew / apt 通道（v2）：`brew install volund-code`
- **独立二进制**（v2）：`bun build --compile` 或 `pkg` 打进 Node runtime，供不装 Node 的用户

### 9.7 apps/docs 部署

- VitePress 8 静态站
- 内容来源：
  - `apps/docs/content/**/*.md` 手写（快速入门 / 概念 / 使用 / 教程）
  - `packages/*/src/**` 通过 **TypeDoc** 生成 API reference → 输出到 `apps/docs/api/`
  - `docs/superpowers/specs/**` **不入**文档站（内部设计文档）
- CI 流程：
  - PR 时构建 preview（Vercel）
  - main 合入自动部署 GitHub Pages 或 Vercel production
  - **不发 npm**（`"private": true`）

### 9.8 边界与安全清单

| 规则                                                                              | 强制点                                          |
|-----------------------------------------------------------------------------------|-------------------------------------------------|
| `apps/docs` **禁止**发布 npm（`"private": true`）                                  | package.json + release CI 校验                  |
| CI **必须**在所有平台跑通 typecheck / test / build 才允许 release                  | GitHub branch protection                        |
| `changesets` **必须**在改动 kits 时提示 major bump                                  | changeset config                                 |
| Rust binary release **必须**签名（macOS notarize / Windows Authenticode）           | v2 强制；MVP 记录 sha256                        |
| 依赖升级**必须**通过 Renovate PR + CI 通过；禁止手动改 lock                          | GitHub workflow                                  |
| `pnpm-lock.yaml` **必须**在 CI 校验一致（`--frozen-lockfile`）                       | CI ts job                                        |

### 9.9 里程碑

- **L1（MVP）**：pnpm workspace + turbo build + CI (ts+native matrix) + changesets
- **L2**：docs 部署 + TypeDoc 集成 + Renovate
- **L3**：Rust binary 签名 + preview 环境
- **L4**：独立二进制（bun compile / pkg）+ Homebrew tap

## §10 里程碑 L1 → L4

本节是 §3-§9 各节末尾里程碑的**总视图**，每个 L 阶段可作为一个可发布版本。

### L1（MVP —— 可用的对话 + 工具）

**目标**：Anthropic + 7 个内置工具 + 权限弹窗 + 会话持久化。安全可用于自己开发。

- ✅ apps/cli 单 bin + Ink UI（消息流 + 权限弹窗 + slash 命令 + `@` alias）
- ✅ provider-kit + provider-anthropic + SingleProviderRouter
- ✅ core Runner + SessionState（immer）+ 16 事件
- ✅ tool-kit + tools: Read / Write / Edit / Bash / Grep / Glob / Todo
- ✅ permission 决策链完整 + auto-allow 保守规则
- ✅ native-bridge + volund-sandbox（macOS + Linux）+ volund-search 基础
- ✅ auth（keychain + env）+ http-kit
- ✅ storage: config.toml + credentials + JSONL sessions + telemetry 本地
- ✅ 平台包 optionalDependencies 挂载（先 darwin-arm64 / linux-x64）
- ✅ CI: typecheck / test / build 全平台
- ⛔ 无 Skill / Plugin / MCP / subagent（推 L2/L3）
- ⛔ 无 fallback router（推 L3）
- ⛔ Windows 无沙箱 → 提示 `--dangerous-no-sandbox`

**Definition of Done**：能用 `volund` 对着 Anthropic 完成一个真实的编码任务（改文件 + 跑测试 + 提 PR），全程权限弹窗可控。

### L2（多 provider + 上下文管理 + 扩展基础）

**目标**：OpenAI 接入 + 上下文自动压缩 + Skill 机制。

- ✅ provider-openai + 跨 provider 一致性测试
- ✅ context: sliding + summary 策略
- ✅ MultiEdit + Backups 机制
- ✅ storage: `volund resume` + `volund restore`
- ✅ skills-runtime（progressive disclosure）+ PromptComposer 完整
- ✅ apps/docs 首版 + TypeDoc 集成 + 部署 GitHub Pages
- ✅ Renovate + changesets 完整
- ✅ 附件粘贴（图片）+ vision 支持
- ⛔ 无 Plugin / MCP（L3）

**Definition of Done**：跨长会话（100+ turn）不炸，用户能装 Skill 定制行为。

### L3（扩展生态 + 路由智能）

**目标**：MCP / Plugin / Task subagent 全上线；FallbackRouter；错误分类完整。

- ✅ mcp-client（stdio + http/sse）
- ✅ plugin-runtime + plugin-sdk（发 npm）
- ✅ JSBridge 完整 API 表面（volund.tools/hooks/commands/prompt/session/fs/exec/http/ui/storage/config/log）
- ✅ subagent + Task tool（3 层深度）
- ✅ FallbackRouter + 冷却机制
- ✅ volund-fs（diff + token 计数）+ AST 查询
- ✅ Windows CI matrix + platform 6 target 全通
- ✅ 沙箱违规日志
- ⛔ 无 Gemini / Ollama（L4）
- ⛔ 无独立二进制（L4）

**Definition of Done**：社区能开发第一个真实 plugin（走全流程：写 → 打包 → 发 npm → 用户 install → 权限弹窗 → 运行）。

### L4（生态成熟 + 高级路由）

**目标**：Gemini / Ollama / RoleRouter / WebFetch。

- ✅ provider-gemini + provider-ollama
- ✅ RoleRouter（planner/coder/reviewer 分派）
- ✅ WebFetch + WebSearch tools（网络 permission）
- ✅ `--json` 结构化输出模式
- ✅ 独立二进制分发（bun compile / pkg）
- ✅ Homebrew tap
- ✅ 主题 + 插件 UI 扩展点
- ⛔ CostAwareRouter / SemanticRouter → v2
- ⛔ Windows AppContainer 沙箱 → v2
- ⛔ Auto-update → v2
- ⛔ 中央 Plugin Registry → v2

**Definition of Done**：功能完整对齐 claude-code，多 provider 无缝切换，社区 plugin 生态形成。

### 时间预估（粗）

| 阶段 | 预估工作量（单人）  | 备注                          |
|------|---------------------|-------------------------------|
| L1   | 4-6 周              | 大量基础设施                  |
| L2   | 3-4 周              | 已有骨架，加 provider + context |
| L3   | 4-5 周              | 扩展系统复杂                  |
| L4   | 2-3 周              | 主要是额外 provider + polishing |

**总计约 3-5 个月**到功能完整。

> ⚠️ **估算前提**：以上是"熟悉 Ink + napi-rs + provider SDK、能大量复用现成 lib（zod / immer / ripgrep / tree-sitter）"的乐观值。若首次接触 Rust / sandbox-exec / landlock，L1 现实取值应为 8-12 周。设计文档不承诺发布日期，实际以主分支 changeset 为准。

### 每阶段"完成"闸门

每个 L 阶段完成前必须过：

1. ✅ 所有 §4 边界规则未被违反（CI + ESLint 强制）
2. ✅ 全 CI matrix 通过（typecheck / test / build / native）
3. ✅ 该阶段所有 "Definition of Done" 手动验证
4. ✅ AGENT.md / CLAUDE.md 同步更新
5. ✅ 变更走 changeset，发到 npm
6. ✅ apps/docs 该阶段新能力需要把文档更新
7. ✅ 至少一次真实使用（dog-fooding，用 volund 开发 volund）

## §11 CLI 命令树设计

本节定义 `apps/cli` 的顶层命令 / 子命令 / flag 完整清单。

### 11.1 技术选型

- **Parser**：**citty**（unjs 出品，TypeScript-first，嵌套子命令 + 自动 help + 声明式定义）
- **交互**：TTY 检测 → 决定进 Ink（交互）还是走 flag/pipe 模式
- **补全**：citty 内置 shell completion 生成（bash/zsh/fish）
- **输出**：默认人类可读；`--json` 走 NDJSON

### 11.2 顶层命令

```
volund                       # 默认：进交互 REPL（无子命令时）
volund chat [prompt]          # 一次性对话（--no-tui）
volund login [provider]       # 认证
volund logout [provider]
volund config <get|set|list|edit>
volund history <list|show|search|export|import>
volund resume <session-id>    # 继续某会话
volund restore <session-id>   # 回滚该 session 内的文件变更
volund model <list|use|alias>
volund plugin <install|uninstall|list|enable|disable|upgrade|doctor|dev>
volund skill <install|uninstall|list|enable|disable|activate|deactivate>
volund mcp <add|remove|list|test>
volund hook <list|test>
volund memory <list|show|add|edit|rm|search|pin|unpin|export|import>   # v4 新增，详见 §6.12.7
volund doctor                 # 全局诊断（native / auth / permission / 各 provider 连通性）
volund telemetry <status|export|clear>
volund completion <bash|zsh|fish>   # 生成 shell 补全脚本
volund version
volund help [command]

# v2 保留（不进 L1-L4）：
# volund update                # 自升级
```

**顶层命令数**：MVP (L1-L4) 共 18 个顶层入口（默认 REPL / chat / login / logout / config / history / resume / restore / model / plugin / skill / mcp / hook / memory / doctor / telemetry / completion / version + help 元命令）；`update` 留 v2。`memory` 子命令树在 §6.12.7 完整定义，此处仅作交叉索引。

### 11.3 命令详细定义

#### 11.3.1 顶层与 chat

```
volund [prompt...]
  # 无参数进交互 REPL
  # 有 prompt 参数 → 走 chat 单轮：volund "帮我改这个 bug"
  Flags (global):
    --cwd <path>                 # 覆盖 cwd
    --model <name|alias>          # 单次指定
    --provider <name>             # 覆盖 default provider
    --config <path>               # 加载额外 config
    --no-tui                      # 关 Ink，走行输出
    --json                        # NDJSON 输出
    --no-color / -q               # 关色
    -v / --verbose                # 打详细日志到 stderr
    --dangerously-skip-permissions
    --dangerous-no-sandbox
    --yolo                        # = --dangerously-skip-permissions
    -h / --help
    --version
```

#### 11.3.2 login / logout

```
volund login [provider]
  # 无 provider 时列出可登录的 provider 并交互选择
  # 引导流程：显示 OAuth URL 或让用户粘贴 API key
  # ★ 顺序：读取 key → 调 provider 的最小验证请求（如 anthropic /v1/models）
  #    → 只有 2xx 且返回 body schema 合法才写 auth；4xx/5xx 直接报错不落盘
  # 存到 auth（macOS Keychain / Linux libsecret / Windows Credential Manager；缺失时 fallback 加密文件；--api-key-stdin 场景下 env-only 也允许）
  Flags:
    --api-key <key>              # 非交互，从 stdin 或 flag 传入（脚本用）
    --api-key-stdin              # 从 stdin 读，避免 shell history 泄漏
    --oauth                       # 走 OAuth flow（若 provider 支持）
    --skip-verify                 # ⚠️ 跳过验证（离线场景，需 --dangerous 标记）

volund logout [provider]         # 清凭据
volund logout --all
```

#### 11.3.3 config

```
volund config list                              # 打印合并后的完整配置
volund config get <key>                         # e.g. volund config get provider.default
volund config set <key> <value>                 # 写 global config
volund config set --project <key> <value>       # 写 project config
volund config unset <key>
volund config edit [--project]                  # 打开 $EDITOR
volund config path                              # 打印 config 文件位置
```

#### 11.3.4 history

```
volund history list [--limit N] [--since <date>] [--project]
volund history show <session-id>                # 打印 session 完整对话
volund history search <query>                   # 全文搜索历史 (L3)
volund history export <session-id> [-o file]    # 导出 markdown/json
volund history import <file>                    # 导入
volund history clear [--all|--older-than <date>]
```

#### 11.3.5 resume / restore

```
volund resume <session-id>                      # 继续该 session
volund resume                                   # 交互式选最近 10 个
volund restore <session-id>                     # 回滚该 session 期间的文件变更
volund restore <session-id> --dry-run           # 展示将变更什么，不写
```

#### 11.3.6 model

```
volund model list [--provider <name>]           # 列出可用模型
volund model use <name|alias>                   # 设为 default
volund model alias <alias> = <provider>:<model> # 建 alias
volund model unalias <alias>
```

#### 11.3.7 plugin

```
volund plugin install <spec>                    # spec: npm:volund-plugin-x | github:user/repo | ./local-dir
volund plugin uninstall <name>
volund plugin list [--enabled|--disabled|--banned]
volund plugin enable <name>
volund plugin disable <name>
volund plugin upgrade <name|--all>
volund plugin doctor <name>                     # 见 §6.11.3
volund plugin ban <name>                        # 永久拉黑
volund plugin dev <path>                        # 软链接本地目录 + hot reload (L4)
volund plugin init [--template <name>]          # 生成骨架
```

#### 11.3.8 skill

```
volund skill install <spec>                     # 类似 plugin
volund skill uninstall <name>
volund skill list
volund skill activate <name>                    # 会话内激活
volund skill deactivate <name>
volund skill show <name>                        # 打印 SKILL.md
volund skill init [--template <name>]
```

#### 11.3.9 mcp

```
volund mcp add <name> <transport-config>        # transport-config: stdio:cmd | http://... | sse://...
volund mcp remove <name>
volund mcp list
volund mcp test <name>                          # 连通性测试
volund mcp inspect <name>                       # 打印其暴露的 tools/resources
```

**★ Transport credentials 存储规则（W7）**：MCP server 的 auth 材料（HTTP `Authorization` header / bearer token / OAuth refresh / env 注入的 API key / stdio 命令行内的敏感 flag）**禁止**明文进 `~/.volund/mcp.toml` 或 `~/.volund/config.toml`。

- `volund mcp add` 交互流程：CLI 检测到 transport 需要凭据（`--header 'Authorization: ...'` / `--env FOO=bar` / URL 含 userinfo `https://user:pass@...`）时 →
  1. 提示用户："检测到敏感字段 `Authorization`，是否写入 auth（推荐）？[Y/n]"
  2. 用户 Y → 调 `auth.storeCredential({ scope: 'mcp', name, field: 'Authorization', value })` → 写入 OS keychain / 加密文件；配置里只留 `keyref://mcp.<name>.Authorization` 占位
  3. 用户 n → 写入 `mcp.toml` 但打红色警告 + telemetry event `mcp.credential_plaintext`
- MCP client 加载时通过 `auth.resolveKeyref(ref)` 解引用，得到明文注入 header / env / argv
- 明文 URL userinfo（`https://user:pass@host`）**强制**转成 keyref，不给退路
- `volund mcp list` 打印时对 keyref 只显示 `keyref://... (hidden)`
- 老配置里已有明文凭据的：启动阶段扫描 → 一次性迁移到 auth 并改写 config，提示用户

#### 11.3.9b hook

`volund hook` 用于查看 / 排查 hook 注册与命中情况。hook 本身在 §2.6 定义，注册来源可能是 builtin / plugin / project config。

```
volund hook list                                # 打印当前会话所有已注册 hook：
                                                #   NAME               POINT              SOURCE                 PRIORITY
                                                #   audit-write        beforeToolCall     builtin                1000
                                                #   sensitive-scrub    beforeToolResult   plugin:guardian        800
                                                #   git-autoformat     onTurnEnd          project:.volund/hooks  600

volund hook list --point <point-name>           # 按 hook 点过滤（e.g. beforeToolCall）
volund hook list --source <builtin|plugin|project>

volund hook test <name> [--input <json-file>]   # 干跑：读取 input.json 作为 hook ctx，打印 hook 返回值
                                                # 不会写盘/发网/执行 tool；用于插件作者调试
volund hook test <name> --last-turn             # 用最后一轮真实 ctx（从 session JSONL 回放）复现

volund hook show <name>                         # 打印 hook 元数据：定义位置、优先级、匹配规则、最近 10 次触发耗时
```

**边界**：`volund hook` 只读 + 干跑；不提供 `enable/disable`（走 `volund plugin disable` 或改 config），不提供 `add`（hook 只能来自 builtin / manifest 声明 / 项目 config）。

**里程碑**：`hook list` L1（builtin only 也要能列）；`hook test` L3（配合 plugin-runtime）；`hook show` 详细统计 L4。

#### 11.3.10 doctor / telemetry

```
volund doctor                                   # 输出（按里程碑分层，同一二进制内 feature-flag 显示）：
                                                # ── L1 项（必检） ──
                                                #   ✓ node version
                                                #   ✓ volund version
                                                #   ✓ native-bridge available (sandbox: ✓, search: ✓, fs: -)
                                                #   ✓ auth: anthropic (keychain)
                                                #   ✓ config valid
                                                #   ✓ cwd writable
                                                # ── L2+ 项（当对应能力启用时展示） ──
                                                #   ✓ skills: 3 installed / 0 broken           # skills-runtime 装载后
                                                #   ✓ context policy: sliding+summary          # L2 加入
                                                # ── L3+ 项 ──
                                                #   ✓ plugins: 2 enabled / 0 banned            # plugin-runtime 装载后
                                                #   ✗ mcp: server "foo" unreachable            # 有 mcp 配置时
                                                # ── L4+ 项 ──
                                                #   ✓ providers reachable: anthropic, openai, gemini
  Flags:
    --json                                        # 结构化输出，便于 CI 消费
    --strict                                      # 任何 ✗ 都 exit 1
volund telemetry status                         # 显示 sink 配置 + 存储量
volund telemetry export -o report.tgz           # 导出用于 bug 报告
volund telemetry clear [--older-than <date>]
```

#### 11.3.11 completion

```
volund completion bash > /etc/bash_completion.d/volund
volund completion zsh > "${fpath[1]}/_volund"
volund completion fish > ~/.config/fish/completions/volund.fish
```

### 11.4 交互 REPL 内 slash 命令

进入交互模式后，用户可用 `/` 前缀触发命令，等价于 CLI 部分子命令但**作用于当前 session**：

| Slash 命令 | 等价 CLI | 说明 |
|---|---|---|
| `/help` | `volund help` | |
| `/exit` / `/quit` | Ctrl+D | 退出会话 |
| `/clear` | — | 清屏（不清 session） |
| `/reset` | — | 清 session（保留配置） |
| `/compact` | — | 手动触发上下文压缩 |
| `/model <alias>` | `volund model use` | 切当前 session 模型 |
| `/skill activate <name>` | `volund skill activate` | 会话内激活 skill |
| `/plugin list` | `volund plugin list` | |
| `/debug prompt` | — | dump 当前 system prompt（见 §6.5.5） |
| `/debug state` | — | dump SessionState 摘要 |
| `/save <name>` | `volund history export` | 命名当前 session |
| `/undo` | — | 撤销最后一次 tool 执行（若有 backup） |
| 用户自定义 | 插件 `volund.commands.register` | |

### 11.5 输入前缀（非 slash）

| 前缀              | 语义                                                        | 详见       |
|-------------------|-------------------------------------------------------------|------------|
| `@`               | **能力选择器**（file / model 二选一，方向键选后进入二级补全） | §7.5.3     |
| `@@<path>`        | 显式 file 模式（跳过选择器）—— 引用文件为 attachment          | §7.5.3     |
| `@!<alias>` 或 `@<alias>`（选中 model 分支后） | 单次覆盖本 turn 模型                                    | §3.9       |
| `#sess_<id>`      | 跨会话上下文引用（默认 `relevant` 策略，Tab 切 `handoff`）     | §7.5.4 / §8.5 |
| `#<tag> ...`      | 标记 message（用于历史搜索）—— **必须**非 `sess_` 开头            | —          |
| `!<cmd>`          | 直接跑 shell 命令（走 Bash tool 但跳过模型）                     | —          |
| 拖拽 / 粘贴文件路径 | 自动附加为 attachment                                          | §7.5.2     |
| 粘贴剪贴板图片    | 落盘到 attachments，行内插入 chip                              | §7.5.2     |

**歧义规则**：
- `#sess_` 前缀**保留给会话引用**，其它 `#` 前缀（不以 `sess_` 开头）继续作为 message tag
- `@` 单键无后续字符时打开选择器；已有 `@<非空>` 时按当前模式（首次进入时的选择）继续补全，Esc 可退出并清空

### 11.6 边界与安全清单

| 规则 | 强制点 |
|---|---|
| `volund login` **禁止** flag 明文传 key 到 shell history（推荐 `--api-key-stdin`） | CLI 输出警告 |
| `--dangerously-*` / `--yolo` **必须** telemetry 记录一次 event | apps/cli 强制 |
| CLI 命令返回码：0 成功 / 1 用户错误 / 2 系统错误 / 130 Ctrl+C | 统一约定 |
| `volund history export` **必须**脱敏 credentials | export 函数白名单过滤 |
| `volund plugin dev` 必须在 shell 顶栏红条提示"开发模式" | Ink 强制 |
| 交互 slash 命令与 CLI 子命令**名字与语义保持一致** | 单元测试 |
| citty 的自动 help **必须**支持中文（i18n 后续再做） | 先英文，i18n 归 Future |
| `--cwd <path>` **必须** `fs.realpath` 归一化，且拒绝以下路径（W6）：（a）解析到 `/` / `C:\` 等根；（b）解析到 `~` / `$HOME`；（c）解析后 symlink 逃出原参数所在文件系统或指向 `~/.volund/` / `~/.ssh/` / `/etc/` / `/private/` 等敏感前缀；违规 → exit code 1 + 错误消息 | apps/cli 启动阶段 + `packages/shared/path-guard.ts` |

### 11.7 里程碑

- **L1（MVP）**：`chat` / `login` / `logout` / `config` / `history list-show` / `doctor`（L1 项） / `hook list`（builtin only） / `version` / `help` + 交互 REPL 内基础 slash
- **L2**：`history search-export-import` / `resume` / `restore` / `model` / `completion`
- **L3**：`plugin *` / `skill *` / `mcp *` / `hook test` / `telemetry *` / doctor 加 plugin/mcp 段
- **L4**：`plugin dev` / `plugin init` templates / `hook show` 详细统计 / doctor 加 provider 健康
- **v2（不进 L1-L4）**：`volund update`（自升级 + 签名校验，需要发布渠道成熟）

## §12 开源治理

本节定义许可、贡献流程、社区规范、安全响应。

### 12.1 许可协议

- **主许可**：**Apache License 2.0**
- **仓库根**：`LICENSE`（Apache-2.0 全文）
- 每个源文件顶部 **可选** SPDX 头：`// SPDX-License-Identifier: Apache-2.0`（自动化 lint 补上）
- 依赖许可兼容性：CI 用 `license-checker-rseidelsohn` 扫，禁止 GPL/AGPL 库进 runtime

**为什么 Apache-2.0**：
- 含 **专利授权条款**（MIT 无），保护社区免遭专利伏击
- 企业接受度高（VS Code / Kubernetes / TypeScript / Vue / gRPC / Rust 都是）
- 允许闭源 fork（对小项目吸引 contributor 有利）

**Rust crate 与 npm 包 metadata**：
- `Cargo.toml`：`license = "Apache-2.0"`
- `package.json`：`"license": "Apache-2.0"`

### 12.2 贡献者许可（DCO 而非 CLA）

**决策**：用 **Developer Certificate of Origin (DCO) v1.1**，不用 CLA。

- 每 commit 加 `Signed-off-by: Name <email>`（`git commit -s`）
- GitHub 装 **DCO app** 自动 check
- 无需签合同、无需律师审查、贡献者主权保留
- 参考：Linux / Docker / GitLab 都用 DCO

不用 CLA 的理由：CLA 提高贡献门槛、需要基金会/实体运营、对社区体验负面。DCO 对小项目更合适。

### 12.3 SECURITY.md

内容：

```md
# Security Policy

## Supported versions
| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Latest minor gets patches |
| < 1.0   | ❌ Pre-release, upgrade to latest |

## Reporting a vulnerability
**Do not open a public GitHub issue for security bugs.**

Email: security@volund-code.dev (or maintainer email if not set up)
PGP: [public key fingerprint]

We aim to:
- Acknowledge within 48 hours
- Provide a fix or mitigation within 14 days
- Publicly disclose after fix is released (coordinated disclosure)

## Scope
In scope:
- Sandbox escape
- Permission bypass
- Credential exfiltration
- Plugin sandbox breakout
- Supply chain (dependency) issues

Out of scope:
- Vulnerabilities in third-party MCP servers
- Issues requiring physical access
- User misconfiguration (e.g. --dangerous-* flags)
```

### 12.4 CODE_OF_CONDUCT.md

采用 **Contributor Covenant v2.1**（业界标准，直接引用官方文本）。

### 12.5 CONTRIBUTING.md

**权威版本**：仓库根 [`CONTRIBUTING.md`](../../../CONTRIBUTING.md)。若与本节冲突，以仓库文件为准；本节只列**必须覆盖的主题**，避免与文件内容漂移。

必须覆盖的主题清单：

1. Prerequisites（Node 20+ / pnpm 9+ / Rust 1.80+）
2. Setup（clone / install / build / test / dev）
3. Branching model（分层：L1-L2 只有 `main` + topic；L3+ 引入 `next`；见 §10）
4. Making a change 步骤 1-8（含 DCO 签署与 CI 绿灯）
5. Types of contributions（bug / feature / docs / provider / plugin/skill）
6. **RFC 触发条件**（与 §12.5b 一致，见下方"RFC 触发清单"）
7. Coding conventions 指向 AGENT.md §4-§9 + CLAUDE.md §C4
8. Conventional Commits + scope 白名单
9. Tests 分层（unit / integration / e2e / rust）
10. Changesets 提交
11. Apache-2.0 via DCO 声明

#### 12.5b RFC 触发清单（权威）

以下变更**必须**走 RFC + 7 天冷静期：

- 影响任何 `packages/*-kit` 的 public API
- 新增或移除 `packages/*` / `crates/*` / `platforms/*`
- 修改 AGENT.md §4 边界规则
- 修改权限或沙箱模型（§4 / §5）
- 新增 provider 或 transport
- 变更 credentials / telemetry 默认值
- 变更 CLI 顶层命令集或全局 flag（§11）

### 12.6 GitHub 治理仓库文件

`.github/` 目录：

```
.github/
├─ CODEOWNERS                       # 各包责任人 → 自动 review 分派
├─ ISSUE_TEMPLATE/
│  ├─ bug_report.yml                # 结构化：期望 vs 实际 / volund doctor 输出 / 复现步骤
│  ├─ feature_request.yml
│  ├─ rfc.yml                        # RFC 模板：动机 / 详细设计 / 备选 / 风险
│  └─ config.yml                     # 关闭 blank issues
├─ PULL_REQUEST_TEMPLATE.md
├─ FUNDING.yml                       # 赞助渠道（可选）
└─ workflows/
   ├─ ci.yml                         # §9.4
   ├─ release.yml
   ├─ dco.yml                        # DCO check
   ├─ codeql.yml                     # 安全扫描
   └─ docs-deploy.yml                # apps/docs 部署
```

### 12.7 治理决策模型

MVP 阶段：**BDFL 单人主导**（Mark）+ 明确升级路径

未来（社区活跃后）：
- Core team（5 人）+ SIG（Special Interest Groups）：provider / tool / plugin / docs
- 大决策（§4 边界规则、破坏性 API）走 RFC + core team 一致同意
- 商标 / 治理 独立文档 `GOVERNANCE.md`（v2）

### 12.8 里程碑

- **L1（MVP）**：`LICENSE` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `CONTRIBUTING.md` / `.github/ISSUE_TEMPLATE/*` / DCO check
- **L2**：`CODEOWNERS` / RFC 模板 / CodeQL 扫描 / Renovate
- **L3**：正式 SIG 结构 / `GOVERNANCE.md`
- **L4**：Trademark 声明 / 基金会讨论（若达到规模）

## §13 文档站 IA + 官网首页

本节定义 `apps/docs` 的内容架构、首页设计、品牌与部署。

### 13.1 域名与部署

- **主域名**：`volund-code.dev`（`.dev` 域强制 HTTPS + 品牌感）
- **备选**：`volundcode.io` / `volund.dev`（需查商标 + 注册占用）
- **部署**：
  - MVP：GitHub Pages + Cloudflare（免费）
  - L2+：Vercel（PR preview + edge functions）
- **备用文档站**：`main.volund-code.dev` / `next.volund-code.dev` 分别对应 main / next 分支

### 13.2 IA（信息架构）

```
volund-code.dev/
├─ /                              # Landing / 首页（见 §13.3）
├─ /docs/
│  ├─ /getting-started/
│  │  ├─ install                  # macOS/Linux/Windows 安装
│  │  ├─ first-run                # 第一次 volund（跟 §14 呼应）
│  │  ├─ 5min-tutorial            # 5 分钟完成一个真实任务
│  │  └─ next-steps
│  ├─ /concepts/
│  │  ├─ agent-loop               # Runner / Event / Turn
│  │  ├─ providers-and-router     # 多 provider 模型
│  │  ├─ tools-and-permissions    # tool + permission + sandbox
│  │  ├─ skills-vs-plugins        # 何时用哪个
│  │  ├─ system-prompt-model      # PromptComposer
│  │  └─ security-model
│  ├─ /guides/
│  │  ├─ configure-providers      # 各家 provider 登录方法
│  │  ├─ writing-a-skill          # 从零写一个 skill
│  │  ├─ writing-a-plugin         # 用 plugin-sdk 开发
│  │  ├─ integrating-mcp          # 接入 MCP server
│  │  ├─ custom-hooks             # 用户 hook
│  │  ├─ team-agent-md            # 项目级 AGENT.md 最佳实践
│  │  └─ automating-with-json     # --json 模式脚本化
│  ├─ /reference/
│  │  ├─ cli                      # 所有子命令 + flag（§11 生成）
│  │  ├─ config                   # config.toml 全 schema
│  │  ├─ plugin-sdk               # TypeDoc 生成
│  │  ├─ tools                    # 内置工具 API
│  │  ├─ hooks                    # 10 hook 点
│  │  ├─ events                   # 16 事件
│  │  └─ permissions              # PermissionSpec 参考
│  ├─ /cookbook/
│  │  ├─ code-review-workflow     # 用 volund 做 code review
│  │  ├─ writing-tests            # TDD 流程
│  │  ├─ refactoring              # 大规模重构
│  │  ├─ ci-integration           # 在 CI 里跑 volund
│  │  └─ team-workflows
│  └─ /troubleshooting/
│     ├─ sandbox-issues
│     ├─ auth-issues
│     └─ common-errors
├─ /plugins/                      # 官方推荐 / 社区插件目录（v2 registry）
├─ /skills/                       # 官方推荐 skills
├─ /blog/                         # 发版说明 / 深度技术文
├─ /changelog                     # 从 CHANGELOG.md 自动同步
├─ /roadmap                       # 从 spec §10 提炼
├─ /community                     # Discord / GitHub Discussions / Contributing 入口
└─ /brand                         # logo / 素材下载（v2）
```

**放弃的内容**：**内部设计 spec（`docs/superpowers/`）不进入官网**，仅在仓库内可见。

### 13.3 官网首页 wireframe

```
┌───────────────────────────────────────────────────────────────────────┐
│ [volund CODE logo]  Docs  Plugins  Blog  GitHub ⭐ 12.3k     [Install]│  ← Sticky nav
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│         The open, model-agnostic AI coding CLI                        │  ← Hero H1
│         Own your terminal. Choose your model.                         │  ← Sub-h
│                                                                       │
│         ┌─────────────────────────────────────────────┐              │
│         │ $ npm install -g volund-code                │  ← One-liner  │
│         │ $ volund                                     │     copyable │
│         └─────────────────────────────────────────────┘              │
│                                                                       │
│         [Get Started]  [Watch demo (2 min)]                          │  ← Primary CTAs
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│           [ ANIMATED TERMINAL DEMO GIF / ASCIINEMA ]                  │  ← Above the fold
├───────────────────────────────────────────────────────────────────────┤
│                        Why volund Code                                │
│                                                                       │
│   ✱ Multi-provider          ✱ Safe by default        ✱ Extensible    │
│   Not tied to one LLM.       Rust sandbox +           JS plugin SDK   │
│   Route across             explicit permissions.    + MCP + Skills.   │
│   Claude / GPT / Gemini /                                             │
│   Ollama.                                                             │
│                                                                       │
│   ✱ Terminal-native         ✱ Local-first             ✱ Open source  │
│   Ink-powered TUI,           No cloud lock-in.         Apache-2.0.    │
│   works over SSH,            Sessions and configs      Auditable      │
│   integrates with your       in plain files.           end to end.    │
│   shell.                                                              │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                    From 0 to productive in 3 steps                    │
│                                                                       │
│   1. Install         2. Login                 3. Ask                  │
│   npm i -g volund    volund login anthropic   volund "fix this bug"   │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                        See it in action                                │
│                                                                       │
│   [ Short 30-second GIF: volund does a real task ]                    │
│   Caption: "volund refactoring 3 files, running tests, opening PR"    │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│              Built for developers who want control                    │
│                                                                       │
│   Concepts diagram: [ user → volund → router → provider ]             │
│                       [           ↑ sandbox     ]                     │
│                                                                       │
│   • Own your prompts (AGENT.md convention)                            │
│   • Own your data (JSONL sessions, plain-text config)                 │
│   • Own your extensions (JS plugin SDK, MCP support)                  │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                      Trust & Security                                 │
│                                                                       │
│   Every destructive action asks. Sandboxed via Rust.                  │
│   Telemetry is off by default and 100% local.                         │
│   Read our SECURITY.md.                                               │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                     Community & Ecosystem                             │
│                                                                       │
│   [GitHub logo]    [Discord logo]    [Twitter logo]                   │
│   x contributors    y users online    latest updates                  │
│                                                                       │
│   [Explore plugins]  [Read the blog]  [Join Discord]                  │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│  Docs      Community    Company     Legal                             │
│  Get       GitHub       Roadmap     License                           │
│  Started   Discord      Blog        Security                          │
│  API       Discuss      Changelog   Privacy                           │
│                                                                       │
│  © 2026 volund Code contributors. Licensed under Apache-2.0.          │
└───────────────────────────────────────────────────────────────────────┘
```

### 13.4 视觉与品牌

**MVP 起手**（先能用即可，v2 请设计师深化）：

| 元素 | MVP 决策 |
|---|---|
| Logo | 简单字标 `volund` 或几何图形（宇航头盔 / 神庙 / 太阳） |
| 主色 | 深蓝（#0E1729）+ 太阳金（#F4B942）—— 呼应 "volund" |
| 字体 | Inter（正文）+ JetBrains Mono（代码） |
| 语气 | Direct、technical、no-BS；避免 marketing 套话 |
| 深色模式 | 强制支持（开发者友好） |

**Wordmark 备选**（等设计）：
- `volund Code` — 全大写小间距
- `volund` 小写 + 单色

**素材页 `/brand`**（v2）：SVG logo / PNG / 色卡下载 + 使用规范。

### 13.5 内容优先级（L1 首发）

L1 发布时至少要有：

必需：
- [x] Landing 首页
- [x] `/docs/getting-started/install`
- [x] `/docs/getting-started/first-run`
- [x] `/docs/getting-started/5min-tutorial`
- [x] `/docs/concepts/agent-loop`（简版）
- [x] `/docs/concepts/security-model`
- [x] `/docs/reference/cli`（自动生成）
- [x] `/docs/troubleshooting/*`（3-5 篇常见问题）

推迟：
- Cookbook / Guides 全部 → L2
- API reference 完整 → L2（TypeDoc）
- Blog → 首发那天来 1 篇发布公告
- Plugins/Skills 目录 → L3（有内容时）

### 13.6 内容生成自动化

- **CLI reference** 从 `apps/cli` 的 citty 定义 **代码生成 markdown**（`pnpm docs:gen:cli`）
- **配置 schema reference** 从 zod schema 生成（`zod-to-doc`）
- **API reference** 从各 package 的 TypeDoc（`pnpm docs:gen:api`）
- 手写内容与生成内容分开目录：`content/` vs `generated/`，避免误覆盖
- CI 每次发版重跑生成，diff 大时提示 PR

### 13.7 SEO / 分析

- OpenGraph / Twitter Card meta（VitePress 支持）
- Sitemap.xml 自动生成
- **分析**：Plausible.io（隐私友好，无 cookie） / 或不加分析（推荐 MVP 阶段）
- **不加**：Google Analytics（隐私 + 与 volund 隐私价值观矛盾）

### 13.8 边界与安全清单

| 规则 | 强制点 |
|---|---|
| `apps/docs` **禁止**发布 npm | `"private": true` |
| 生成的 CLI/API reference **必须** CI 每次发版更新 | GitHub Action |
| 官网**不加**行为追踪脚本（隐私价值观一致性） | code review |
| 品牌素材 `/brand` 明确 Apache-2.0 与 trademark 分离声明 | v2 时定 |
| `/blog` 每篇文章底部**必须**署名 + license 声明 | 模板强制 |
| 首页 install 一行命令**必须** copy-to-clipboard 且**不带**执行推荐（不用 `curl \| sh` 反 pattern） | code review |

### 13.9 里程碑

- **L1（MVP）**：域名 + Landing + Getting Started 3 篇 + Concepts 2 篇 + CLI reference + Troubleshooting；GitHub Pages 部署
- **L2**：完整 Guides / Cookbook / API reference；Vercel + preview；blog 首篇
- **L3**：Plugins/Skills registry 目录页；社区分区
- **L4**：设计升级（专业设计师）+ `/brand` 素材页 + i18n 中文版

## §14 首次运行 UX / Onboarding

用户 `npm i -g volund-code` 后第一次跑 `volund` 时的完整体验。

### 14.1 目标

- 从零到"发第一条消息"**≤ 60 秒**
- **零阅读文档也能开始**
- 隐私与安全**首屏就说清**（不给"默认上报"的机会）

### 14.2 首次运行流程

```
$ volund

┌────────────────────────────────────────────────────────────┐
│  Welcome to volund Code 👋                                  │
│  An open, model-agnostic AI coding CLI.                     │
│                                                             │
│  This is your first run. Let's set things up (60s).         │
└────────────────────────────────────────────────────────────┘

Step 1 of 3 · Choose a provider
  ▸ Anthropic  (Claude Sonnet 4.5)
    OpenAI     (GPT-4o)
    Gemini     (Gemini 1.5)
    Ollama     (local models — no API key)

  [↑↓ move  Enter select  ? help]

Step 2 of 3 · Log in
  How to authenticate:
  1. Get an API key: https://console.anthropic.com/settings/keys
  2. Paste it below (won't be echoed; stored in your OS keychain)

  API key: ●●●●●●●●●●●●●●●●●●●● [Enter]

  ✓ Verified: model claude-sonnet-4-5 accessible
  ✓ Saved to macOS Keychain             (verify-first, save-second)

Step 3 of 3 · Your first task
  Try one of these, or type your own:
  • "Explain the code in this directory"
  • "Fix the failing test in tests/foo.test.ts"
  • "Add a README section for installation"

  > _
```

**Ollama 分支（选 Ollama 时 Step 2 变形）**：

```
Step 2 of 3 · Connect to Ollama
  Ollama runs locally, no API key needed.

  Endpoint: http://localhost:11434                 [Edit]

  ✓ Ollama reachable (version 0.4.2)
  ✓ Models detected: llama3.1:70b, qwen2.5-coder:32b
    Pick one for default:  ▸ qwen2.5-coder:32b
                             llama3.1:70b
```

- Endpoint 可改成远程 Ollama（`http://<host>:11434`）
- 若 endpoint 不可达 → 提示 `ollama serve` 或改地址；不写任何 credential（Ollama 走 URL only）
- 若 model 列表为空 → 提示 `ollama pull <model>` 后重试

### 14.3 关键设计决策

**Provider 选择顺序**：Anthropic 放第一（品类领导者感）；Ollama 最后（"高级"感）。可用 flag `--provider anthropic` 跳过 step 1。

**API key 输入**：
- 输入时**不回显**（终端 mask）
- 输入后**先验证**（发一个便宜的 test 请求，比如 count_tokens 或 tiny completion）
- 验证失败给具体原因（网络？key 错？quota？）
- 验证通过才写 keychain
- 建议加 `--api-key-stdin`：`echo $KEY | volund login anthropic --api-key-stdin` 让脚本用户跳过 TUI

**存储位置默认**：
- macOS：Keychain
- Linux：libsecret（若装了）→ fallback 加密文件
- Windows：Credential Manager

任一失败 → 让用户选加密文件 or env 模式，**明确告知**"encrypted file at ~/.volund/credentials.enc, unlock with passphrase"。

**隐私首屏声明**（step 1 前一个屏）：

```
Before we start:
  • volund saves session logs LOCALLY to ~/.volund/sessions/
  • volund does NOT send analytics anywhere by default
  • Your prompts and code are only sent to the provider you choose
  • You can review or disable anytime: volund telemetry status

  [Continue]
```

**明确让用户看到"默认本地"**。首次开机是最好的信任建立时机；说清楚以后每一次 telemetry 相关操作都不会显得可疑。

### 14.4 项目首次进入

用户在一个新项目里第一次跑 `volund`：

```
$ cd my-project && volund

┌─────────────────────────────────────────────────────┐
│ First time in this project:                          │
│   /Users/mark/my-project                             │
│                                                      │
│ volund detected:                                     │
│   • Git repo (main branch: main)                     │
│   • package.json (Node project)                      │
│   • No AGENT.md yet                                   │
│                                                      │
│ Would you like to:                                   │
│   ▸ Just proceed                                     │
│     Generate an AGENT.md from your codebase   (L2)   │
│     Configure project-level settings          (L2)   │
└─────────────────────────────────────────────────────┘
```

> L1 阶段第一屏**只保留 `Just proceed`**，另两项灰显 + 标 `(L2)`（未启用），避免误导 MVP 用户；L2 上线后取消灰显。

**AGENT.md 生成（选项 2，L2）**：volund 主动扫代码（README / package.json / 主要文件），生成初版 AGENT.md 供用户 review + save 到 `<cwd>/AGENT.md`。类似 claude-code 的 `/init`。等 skills-runtime 完备后再上线，避免 L1 阶段扫描逻辑没沉淀就先做。

**Project trust（分层）**：

| 阶段 | cwd 内 read/search（Read/Grep/Glob） | cwd 内 write（Write/Edit/MultiEdit） | cwd 内 exec（Bash） | cwd 外一切 |
|---|---|---|---|---|
| **L1 (MVP)** | ✅ 默认 allow-session（§4.4 auto-allow） | ⚠️ 仍走 permission 决策链弹窗 | ⚠️ 仍走 permission 决策链弹窗 + sandbox 兜底 | ❌ 弹窗，默认 deny |
| **v2 project trust** | 未信任 cwd 一律弹窗；信任后同 L1 | 未信任 cwd 一律拒绝；信任后同 L1 | 未信任 cwd 一律拒绝；信任后同 L1 | ❌ 弹窗，默认 deny |

> "MVP 直接信任 cwd" **仅对读/搜索类工具生效**；写/执行类工具**仍走标准 permission 流程**，不因为在 cwd 内就跳过。此规则与 §4.4 一致。

### 14.5 引导中断与恢复

- 用户中途 Ctrl+C → 已保存的 credential 保留，未完成的步骤下次 `volund` 时从中断处继续
- `volund --reconfigure` 强制重跑 onboarding

### 14.6 非交互场景

用户在 CI / 脚本里跑 volund：

```
$ volund chat "review this diff" < diff.txt

volund: WARNING: no provider configured. Non-interactive mode.
        Set VOLUND_PROVIDER=anthropic and VOLUND_ANTHROPIC_API_KEY,
        or run `volund login` first in an interactive shell.
        Exit code: 2
```

- 检测到 stdin/stdout 非 TTY → 不进 onboarding，报明确错误 + 退出码
- 环境变量 + `--api-key-stdin` 覆盖所有交互

### 14.7 边界与安全清单

| 规则 | 强制点 |
|---|---|
| API key 输入**必须**mask（不回显） | login TUI |
| API key 输入**必须**先验证再存 | login 流程 |
| 首屏隐私声明**必须**在写任何配置前展示 | onboarding 顺序 |
| 存储位置降级路径**必须**告知用户 | login 流程 |
| 非交互模式**禁止**弹 TUI（改报错） | TTY 检测 |
| 首次运行**不写**任何自动 telemetry event 到远端（本地仍写） | telemetry sink 默认 |

### 14.8 里程碑

- **L1（MVP）**：完整 3 步 onboarding + 首屏隐私声明 + API key 验证 + 项目首次进入检测（提示但不自动 gen AGENT.md）
- **L2**：`/init` 生成 AGENT.md + project trust 提示
- **L3**：非交互模式完备错误码 + shell integration hints
- **L4**：`volund --reconfigure` + onboarding 分支：Ollama 无 key 快速路径 / API key OAuth flow

## Future / v2

- Auto-update 机制（`volund update`）
- Project trust / cwd 首次信任提示
- Sandbox 不可用降级（Windows 无原生沙箱 fallback）
- 高级模型路由（role-based / cost-aware）

---

## 变更日志

| 日期       | 版本  | 内容                                                                                                                                                                                                                                                                                                                                     |
|------------|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-31 | §1 v1 | 初稿仓库布局                                                                                                                                                                                                                                                                                                                             |
| 2026-07-31 | §1 v2 | 依赖倒置修正；新增 auth/http-kit/context/telemetry；Skill/Plugin 边界                                                                                                                                                                                                                                                                      |
| 2026-07-31 | §1 v3 | provider-kit 去实现依赖；permission promptHandler 端口；ContextPolicy 移入 provider-kit；native-bridge 平台包分发；subagent RunnerFactory 注入；新增 router 包；telemetry 默认本地；plugin/skill 版本兼容                                                                                                                                       |
| 2026-07-31 | §2 v1 | 核心数据模型（Message / ContentPart 多模态 / AttachmentRef + handle 生命周期）；SessionState immutable + immer 结构化共享；EventBus 16 种事件谱；Runner 主循环伪代码；并行 tool 调用（permission 内部串行弹窗）；10 个 hook 拦截点；Subagent 生命周期（3 层深度上限 + 事件冒泡 + 隔离）；异常谱（含 Rust 崩溃 / sandbox 缺失 / 磁盘满 / keychain 锁定） |
| 2026-07-31 | §6 v1 | 插件系统：JS ESM 单文件 bundle；manifest.json 声明式权限；JSBridge（`volund.tools/hooks/commands/prompt/session/fs/exec/http/ui/storage/config/log`）；`node:vm` 能力控制 + AST 静态检查；PromptComposer 统一 system prompt 组合（builtin/skill/project/user/plugin 优先级 1000→50）；新增 `packages/plugin-sdk` 包（type-only，发布 npm）；`plugin-runtime` 新增 `core[type-only]` 依赖；插件间隔离；升级权限扩容再确认；MVP 分 L1-L4 里程碑 |
| 2026-07-31 | §3 v1 | Provider 抽象：`ProviderClient` / `ProviderRequest` / `ProviderChunk` / `ProviderCapabilities`；RawMeta 逃生舱（按 provider 命名空间）；四家 provider 适配差异表（Anthropic/OpenAI/Gemini/Ollama）；`ProviderError` 10 类分类 + Router/Runner 反应表；Router 契约（`RouterPolicy.pick/onError`）+ 4 种策略（Single/Fallback/Role/CostAware）；`@model` 显式路由 + alias 配置；边界与安全清单 |
| 2026-07-31 | §4 v1 | 工具体系：Tool 契约 + JSON Schema 输入验证；`PermissionSpec`（fs/bash/net/env）+ 8 步决策链 + 4 档 Decision（once/session/project/forever）；permission ↔ sandbox 双层安全；破坏性操作额外保护；内置工具清单（Read/Write/Edit/Bash/Grep/Glob/Todo 为 L1；MultiEdit L2；Task/WebFetch/WebSearch L3-L4）；ToolRegistry 名字前缀约定（`mcp:` / `plugin:`）；ToolResult 规范化（截断/脱敏/attachment）；边界与安全清单 |
| 2026-07-31 | §5 v1 | Rust 侧车：三个产物（volund-sandbox 独立 bin / volund-search napi / volund-fs napi）；平台沙箱实现（macOS sandbox-exec / Linux landlock+seccomp / Windows AppContainer 延后）；native-bridge 单点接入 + JS fallback；attachment handle 生命周期；沙箱 profile 从 PermissionSpec 生成；边界与安全清单 |
| 2026-07-31 | §7 v1 | Terminal UI：Ink 组件树；stream 30fps 自 throttle（上游不背压）；permission 弹窗串行队列；InputBox 多行/附件/slash/@alias 补全；无颜色 + `--json` 结构化输出；边界与安全清单 |
| 2026-07-31 | §8 v1 | 存储：纯文件（`~/.volund/` + `<cwd>/.volund/`）；session JSONL append-only（stream.delta 不落盘）+ replay；config.toml 分层（内置<全局<项目<env<flag）；credentials 三层 fallback（keychain / 加密文件 / env）；backups + GC；telemetry 默认本地；边界与安全清单 |
| 2026-07-31 | §9 v1 | 构建/CI/分发：pnpm workspace + catalog；turbo pipeline；CI matrix（ts 3 平台 + native 6 target）；changesets 发版；apps/docs 单独 VitePress 部署不发 npm；TypeDoc → docs API；rolldown 单文件 bin；边界与安全清单 |
| 2026-07-31 | §10 v1 | 里程碑总览：L1（Anthropic + 7 tools + 权限 + 存储，4-6 周）→ L2（OpenAI + context 压缩 + Skill + docs，3-4 周）→ L3（MCP + Plugin + subagent + FallbackRouter + Windows CI，4-5 周）→ L4（Gemini + Ollama + RoleRouter + WebFetch + 独立二进制，2-3 周）；每阶段 7 项完成闸门 |
| 2026-07-31 | §6 v2  | 插件补漏：6.11.1 hook 多插件执行顺序（numeric priority + 串行 pipeline + veto 短路）；6.11.2 资源守护 5 层（activate 10s / bridge call 5s / 500 calls/turn / ban / auto-disable）；6.11.3 `volund plugin doctor` 诊断命令；6.11.4 生命周期事件（session.start/end + permissions.changed）；6.11.5 升级迁移（manifest.migrations + volundVersion 校验） |
| 2026-07-31 | §6.5 v2 | 系统提示词补漏：6.5.1 builtin system prompt 草稿（`{{cwd}}`/`{{model}}` 模板变量 + 安全底线）；6.5.2 Skill 数据模型 + SKILL.md frontmatter yaml schema；6.5.3 三阶段 progressive disclosure（cold scan → index → activate）；6.5.4 AGENT.md 语义规则（从 cwd 向上遍历、不跨 home、CLAUDE.md fallback）；6.5.5 PromptComposer 输出示例（`<!-- source: ... -->` HTML 注释标签） |
| 2026-07-31 | §11 v1 | CLI 命令树设计（citty）：17 个顶层命令（含 `completion` / `hook`，`update` 留 v2）+ 全局 flag 集；交互 REPL 内 slash / `@alias` / `#tag` / `!cmd` 前缀；shell completion 生成；返回码约定；`--dangerously-*` telemetry 强制记录；分 L1-L4 落地 |
| 2026-07-31 | §12 v1 | 开源治理：Apache-2.0 主协议（含专利授权 + SPDX 头）；DCO v1.1 而非 CLA；SECURITY.md 响应流程（48h ack / 14d fix）；Contributor Covenant v2.1 CoC；CONTRIBUTING.md + RFC 流程（7 天冷静期）；`.github/` 治理仓库结构（CODEOWNERS + issue/PR 模板 + CI workflow）；BDFL → SIG 演进路径 |
| 2026-07-31 | §13 v1 | 文档站 IA：域名 `volund-code.dev`；VitePress 8 部署；完整站点信息架构（getting-started/concepts/guides/reference/cookbook/troubleshooting/plugins/skills/blog/changelog/roadmap/community）；官网首页 wireframe（hero + 6 特性 + 3 步上手 + demo GIF + 信任声明 + 社区）；MVP 品牌与视觉基线；CLI/API/config 自动生成；无追踪隐私默认 |
| 2026-07-31 | §14 v1 | Onboarding：60s 三步流程（provider 选 → API key 输入验证 → 首个任务）；API key mask 输入 + 先验证后落盘；首屏隐私声明（本地 telemetry / 无自动上报）；存储降级路径明示；项目首次进入检测 + `/init` 生成 AGENT.md（L2）；非交互模式明确错误码；`--reconfigure` |
| 2026-07-31 | review r1 | Self-review 修正一轮：§10 L1 "5 工具" → "7 工具"；§4 v1 changelog 澄清 MultiEdit L2 / Task 归 L3；§1.2 skills-runtime 补 `core[type-only]` 依赖 + auth→native-bridge 依赖说明为可选运行时；§11.2 顶层命令补 `completion`、`update` 明确归 v2、总数订正为 17；§11.3.9b 新增 `volund hook` 子章节；§11.3.10 doctor 输出按 L1/L2/L3/L4 分层展示 + `--json`/`--strict` flags；§11.3.2 `volund login` 明确 verify-first-save-second + `--skip-verify` 需 `--dangerous`；§11.7 里程碑同步；§14.2 补 Ollama 分支流程；§14.4 mockup 标 `(L2)` + "信任 cwd" 范围限定为 read/search，write/exec 仍走 permission；§6.5.4 AGENT.md priority 递减公式（`600 - 10*level`，下限 500，CLAUDE.md fallback 复用同槽位）；§10 加时间估算前提说明；§12.5 CONTRIBUTING.md 去重改为引用仓库文件 + 独立 12.5b RFC 触发清单；SECURITY.md `Supported versions` 表订正为 0.x pre-release 现实语义；CONTRIBUTING.md 分层 branching model（L1-L2 trunk-based，L3+ 引入 `next`） |
| 2026-07-31 | review r2 | **架构一致性修正**（用户反馈：Rust 沙箱应统一到插件，不该用 `node:vm`）：§6.4.3 重写：`node:vm` 方案作废，改为 `volund-sandbox --run-plugin` 独立子进程 + JSON-RPC 2.0 over NDJSON (fd 3) bridge；每插件一 Node 子进程，profile 从 `manifest.permissions` 生成；附件走 handle-token 模式（native pointer 不出主进程）。§5.2 volund-sandbox 能力表补"沙箱内执行插件 Node 子进程"。§5.3 拆为 `exec` 与 `--run-plugin` 两模式（3 段：5.3.1/5.3.2/5.3.3），共用 profile 生成与平台机制；插件模式额外禁 `ptrace`/`mmap w+x`。§5.8 边界清单新增 4 条（sandbox 唯一入口 / profile 由 native-bridge 生成 / 崩溃隔离 / RPC 白名单）。§5.9 里程碑：`--run-plugin` 归 L2；插件资源守护归 L3；Windows 插件宿主归 L4。§6.7 差量：plugin-runtime 新增 `native-bridge` 依赖 + 新增 `packages/plugin-runtime/runtime/plugin-host.mjs` 宿主脚本；`native-bridge` 新增 `runPlugin(opts) → PluginProcHandle` 原语。§6.8 安全清单重写（sandbox 语义替代 vm 语义 + 新增子进程崩溃隔离/stdout 限流规则）。§6.10 里程碑标注依赖 §5.9-L2。§6.11.2 资源守护由 5 层扩展到 7 层（新增 `setrlimit` + 心跳），且现在真正做到 CPU/RSS/fork 上限。§6.11.3 doctor 输出：VM state → Sandbox subprocess pid/rss/cpu + profile。§1.2 依赖表：`plugin-runtime` 新增 `native-bridge` 依赖。心智：AST 静态检查从"安全底线"降级为"作者友好检查"，真正的隔离靠 Rust sandbox + JSON-RPC 白名单 + manifest 三层。 |
| 2026-07-31 | review r3 | **一等公民规则 + auth 事件谱**：新增 §8.4.1 auth telemetry 事件谱（17 类事件：`auth.login.started` / `verify_requested` / `verify_result` / `stored` / `failed` / `cancelled` / `logout.completed` / `credential.resolved` / `credential.miss` / `keychain.error` / `encfile.unlock_prompted` / `encfile.unlock_result` / `migration.plaintext_found` / `migration.plaintext_moved` / `dangerously.skip_verify` / `mcp.keyref_created` / `mcp.plaintext_kept`），字段全部经 `shared.sanitize()` 脱敏；本地 sink 为默认，OTel opt-in；§8.7 补 2 条边界规则（分支必发事件 + payload 必脱敏）。AGENT.md §1.1 新增"一等公民架构（不可动摇）"两条：Rust 沙箱是安全基座、TS 是开发效率基座；§4.6 补 verify-first-store-second + MCP keyref + auth 事件上报硬约束；§4.7 重写为"Rust 沙箱 = 一等公民"，含适用范围表 + 平台机制 + 降级 + 永远禁止清单；§4.10.1 抽掉 `node:vm` 语义，改为 `volund-sandbox --run-plugin` 子进程 + JSON-RPC bridge 描述；§4.1 依赖图 plugin-runtime 加 native-bridge。CLAUDE.md §C0 新增"一等公民架构"镜像；§C3 plan mode 触发条件新增沙箱边界 / auth 事件谱；§C4 禁止事项去除过时 `vm.Context` 条，改为禁止 `node:vm` / `worker_threads` / 手动 profile / 绕过 verify-first / auth 事件缺失 / payload 未脱敏，共 5 条新增。 |
| 2026-07-31 | review r5 | **CLI 输入体验对齐**（用户反馈：对齐 claude-code 的图片粘贴 / `@` 语义 / 跨会话引用）：§7.5 InputBox 拆为 4 小节，7.5.2 新增剪贴板图片二进制粘贴（native-bridge stage → hash 落盘 → 输入行 chip 占位 → 提交时展开为 ContentPart，历史脱敏为占位）；7.5.3 新增 `@` **双模式选择器**语义（键入 `@` 弹 file / model 二选一 popup，`@@` 显式 file、`@!` 显式 model，明确不做启发式），file 分支落到 attachment 生命周期 + path-guard，目录展开上限 200；7.5.4 新增 `#sess_<id>` 输入语法（popup 候选按 mtime 倒序，chip 展开 strategy Tab 切）。§7.7 边界清单补 4 条（历史脱敏图片 / `@` 禁启发 / `#sess_` 走端口 / 跨用户拒绝）。§7.8 里程碑重排：L1 补 `@` 选择器 model 分支、L2 加 `@` file + 剪贴板图片二进制、L3 加 `#sess_` + `SessionContextReader`。§3.9 补 UI 入口交叉引用（说明 `@` 是选择器入口）。§8 新增 §8.5 "跨会话上下文引用（SessionContextReader）"5 小节（端口定义 / relevant + handoff 两 strategy / XML wrapper 注入 + 只存引用元数据不 duplicate 原文 / 权限模型（首次弹 allow-once/session/deny，`allow-session` 覆盖本 session 内所有跨会话读，跨用户 uid 拒绝，`permissionCache` key `session-context-read:*`）/ 5 条边界（脱敏 / maxTokens ≤ 12000 / 未知 id 明确报错 / 版本降级 / 禁递归展开））；下游子节顺移：原 8.5 Backups → 8.6，8.6 Telemetry → 8.7，8.7 边界 → 8.8，8.8 里程碑 → 8.9，里程碑同步补 SessionContextReader（L3）+ 可选向量索引（L4，opt-in）。§11.5 前缀表重写为 8 项含 `@` / `@@` / `@!` / `#sess_<id>` / `#<tag>` / `!<cmd>` / 拖拽粘贴 / 剪贴板图片，加"歧义规则"（`#sess_` 保留、`@` 无后续字符时开选择器、Esc 退出）。 |
| 2026-07-31 | review r4 | **Memory 系统 + `@include` 机制**（用户反馈：需要跨会话记忆 + md 文档递归引用）：spec 新增 §6.12 Memory 系统（12 小节：配置 / md 文件格式 / memory-guide 内置提示词 / 200 行限制的 4 层降级链 / MemoryBridge API / hook 谱 / `volund memory` CLI 子树 / 召回策略 / 新增 `packages/memory-runtime` 包 / pinned auto-inject / 与 Skill/AGENT.md 的边界 / 里程碑）；spec 新增 §6.5.6 `@include` 机制（语法 / 路径解析 / workspace+`~/.volund` 双白名单 + canonicalize+symlink 逃逸检测 / 递归深度 8（可配 32）/ 单 compose 展开次数 64 上限 / cycle 检测 / frontmatter 剥离 / debug marker / 错误占位不中断 compose / telemetry 事件 `prompt.include.expanded` + `prompt.include.failed` / 实现单点 `packages/core/src/prompt-loader.ts`）；§1.1 package tree 补 `memory-runtime/` + `plugin-runtime` 注释同步为 sandbox 子进程语义；§1.2 依赖表补 `memory-runtime` 行 + ASCII 图 memory-runtime 注入行；§6.7 差量补 `PromptLoader` 责任 + 三 contributor 共用 loader + 内置 `memory-guide.md` 资源 + `packages/memory-runtime` 新包；§6.9 对比表由 4 行扩到 6 行（加 Memory + AGENT.md），列头改"语言/维护方"，决策语说明 Skill vs Memory vs AGENT.md 三者取舍；§11.2 顶层命令 17 → 18（加 `volund memory`），§11.3 交叉索引到 §6.12.7；§8.2 存储布局树补 `~/.volund/memory/*.md` + `<cwd>/.volund/memory/*.md` + `index.jsonl` 摘要索引；§8.7 边界清单补 4 条（frontmatter 校验 / body 200 行 / 路径 canonicalize+escape / `volund.memory.*` 过 manifest.permissions）。AGENT.md §4.1 依赖图补 `memory-runtime`；新增 §4.14 Memory 硬约束（存储位置固定 / frontmatter 必填字段 / 200 行 4 层降级 / 模型主导 / 唯一召回路径 / 权限门 / 4 条禁止）；新增 §4.15 `@include` 硬约束（仅 volund prompt 管线 / 单点实现 / 只 md / 双白名单 / 递归安全 / frontmatter 剥离 / 错误不中断 / debug 可观测 / 3 条禁止）。CLAUDE.md 顶部 §4.14/§4.15 索引 + §C4 禁止事项新增 12 条（memory-runtime 单点 / frontmatter / 200 行 4 层 / 无 raw key / 无另起提示词 / 权限门 / prompt-loader 单点 / 只 md / 仅 prompt 管线 / 双白名单 / 修改 max_body_lines 需同步 guide）；§C7 提示触及 memory / `@include` 需先读 §6.12 / §6.5.6。 |
